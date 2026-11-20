// SQL Lab's T-SQL engine: SQL Server scripts run on SQLite storage.
import { beforeAll, describe, expect, test } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createSqliteAdapter } from '../src/db/sqlite-adapter.js';
import { createMemoryFiles } from '../src/db/files.js';
import { parseBatch, splitBatches, TsqlSyntaxError } from '../src/db/tsql/parse.js';
import { convertTo, prepareCreateTable, TsqlError } from '../src/db/tsql/engine.js';
import { translateForSqlite } from '../src/db/dialect-translate.js';
import { tsqlProblem } from '../src/ui/lab-console.js';

let sqlite3;
beforeAll(async () => {
    sqlite3 = await sqlite3InitModule();
});

async function open() {
    const adapter = createSqliteAdapter(sqlite3, createMemoryFiles(sqlite3));
    await adapter.create('test');
    adapter.execute(`CREATE TABLE Emp (Id INTEGER PRIMARY KEY, Name TEXT, Salary REAL, Dept TEXT);
        INSERT INTO Emp VALUES (1, 'Asha', 100, 'A'), (2, 'Ben', 200, 'B'), (3, 'Chen', 200, 'A');`);
    return adapter;
}

/** Runs T-SQL; returns the run. */
async function tsql(sql, adapter) {
    const a = adapter || await open();
    return a.execute(sql, { language: 'sqlserver', databaseName: 'Shop' });
}
/** The rows of each result grid. */
const grids = (run) => run.results.filter(r => r.columns.length).map(r => r.rows);
/** PRINT and low-severity RAISERROR lines. */
const prints = (run) => run.results.filter(r => r.kind === 'print').map(r => r.text);
/** Runs and expects no error. */
async function ok(sql, adapter) {
    const run = await tsql(sql, adapter);
    expect(run.error).toBeNull();
    return run;
}

describe('reading T-SQL', () => {
    test('GO lines split batches; GO n repeats one', () => {
        const batches = splitBatches("SELECT 1\nGO\nPRINT 'x'\ngo 3\n-- GO in a comment\nSELECT 'GO\nGO'\n");
        expect(batches.map(b => b.repeat)).toEqual([1, 3, 1]);
        expect(batches[2].text).toContain("'GO\nGO'");
    });

    test('statements end where the next one starts, as SQL Server allows', () => {
        const nodes = parseBatch([
            'DECLARE @n INT = 2, @s NVARCHAR(10)',
            'INSERT INTO t (a)',
            'SELECT a FROM u UNION ALL',
            'SELECT 2',
            'INSERT INTO t VALUES (1)',
            'SELECT CASE WHEN a = 1 THEN 1 ELSE 2 END FROM t',
            'WITH c AS (SELECT 1 AS x) INSERT INTO t SELECT x FROM c',
            'UPDATE t SET a = 1 WHERE b = 2',
            'SET @n = 3',
            'DROP TABLE IF EXISTS #t'
        ].join('\n'));
        expect(nodes.map(n => n.type)).toEqual(['declare', 'sql', 'sql', 'sql', 'sql', 'sql', 'set', 'sql']);
        expect(nodes[1].text).toBe('INSERT INTO t (a)\nSELECT a FROM u UNION ALL\nSELECT 2');
        expect(nodes[2].text).toBe('INSERT INTO t VALUES (1)');
    });

    test('control flow nests', () => {
        const [w, t] = parseBatch("WHILE @i < 3 BEGIN SET @i += 1 IF @i = 2 CONTINUE END\nBEGIN TRY SELECT 1 END TRY BEGIN CATCH PRINT 'no' END CATCH");
        expect(w.type).toBe('while');
        expect(w.body.body.map(n => n.type)).toEqual(['set', 'if']);
        expect(t.type).toBe('try');
        expect(t.handler[0].type).toBe('print');
    });

    test('what the engine can\'t read is reported with its line', () => {
        expect(() => parseBatch('BEGIN\nSELECT 1')).toThrow(TsqlSyntaxError);
        expect(tsqlProblem("SELECT 1\nIF 1 = 1\nBEGIN\n  PRINT 'a'")).toMatchObject({ line: 4, message: expect.stringMatching(/END is missing/) });
        expect(tsqlProblem("DECLARE @a INT = 1\nPRINT @a")).toBeNull();
    });
});

describe('variables', () => {
    test('DECLARE, SET and compound assignment', async () => {
        const run = await ok('DECLARE @n INT = 2, @s NVARCHAR(20) = N\'x\'\nSET @n += 5\nSET @s = @s + \'-\' + CAST(@n AS NVARCHAR(10))\nSELECT @n AS n, @s AS s');
        expect(grids(run)).toEqual([[[7, 'x-7']]]);
    });

    test('variables filter queries as bound values, never pasted into SQL', async () => {
        const run = await ok("DECLARE @name NVARCHAR(50) = 'Ben''s'\nSELECT COUNT(*) FROM Emp WHERE Name = @name\nDECLARE @d NVARCHAR(10) = 'A'\nSELECT Name FROM Emp WHERE Dept = @d ORDER BY Name");
        expect(grids(run)).toEqual([[[0]], [['Asha'], ['Chen']]]);
        expect(run.translation.sql).toContain('Name = @name');
    });

    test('values take their declared type', () => {
        expect(convertTo('INT', 3.9)).toBe(3);
        expect(convertTo('VARCHAR', 'abc')).toBe('a');
        expect(convertTo('NVARCHAR(3)', 'abcdef')).toBe('abc');
        expect(convertTo('CHAR(4)', 'ab')).toBe('ab  ');
        expect(convertTo('DECIMAL(10, 2)', '3.14159')).toBe(3.14);
        expect(convertTo('BIT', 'true')).toBe(1);
        expect(convertTo('DATE', '2024-02-10 13:00:00')).toBe('2024-02-10');
        expect(() => convertTo('INT', 'abc')).toThrow(TsqlError);
        expect(() => convertTo('TINYINT', 300)).toThrow(/Arithmetic overflow/);
        expect(() => convertTo('DATE', '2024-02-30')).toThrow(/Conversion failed/);
    });

    test('an undeclared variable is an error, as in SQL Server', async () => {
        const run = await tsql('SELECT 1\nSELECT @missing');
        expect(run.error).toMatchObject({ message: 'Must declare the scalar variable "@missing".', line: 2 });
        expect(run.error.code).toMatch(/^Msg 137/);
    });

    test('SELECT @v = … keeps the last row; @v = @v + … works row by row', async () => {
        const run = await ok("DECLARE @max FLOAT, @who NVARCHAR(20)\nSELECT @max = Salary, @who = Name FROM Emp ORDER BY Id\nDECLARE @all NVARCHAR(100) = ''\nSELECT @all = @all + Name + ';' FROM Emp ORDER BY Name\nSELECT @max, @who, @all");
        expect(grids(run)).toEqual([[[200, 'Chen', 'Asha;Ben;Chen;']]]);
    });

    test('variables last for their batch', async () => {
        const run = await tsql('DECLARE @a INT = 1\nGO\nSELECT @a');
        expect(run.error.message).toMatch(/Must declare the scalar variable "@a"/);
        expect(run.error.line).toBe(3);
    });

    test('@@ROWCOUNT, SCOPE_IDENTITY() and @@VERSION', async () => {
        const run = await ok("CREATE TABLE T2 (Id INT IDENTITY(1,1) PRIMARY KEY, Name NVARCHAR(50))\nINSERT INTO T2 (Name) VALUES (N'a'), (N'b')\nSELECT @@ROWCOUNT AS rc, SCOPE_IDENTITY() AS id, @@IDENTITY AS id2\nSELECT DB_NAME(), @@VERSION LIKE '%SQL Lab%'");
        expect(grids(run)).toEqual([[[2, 2, 2]], [['Shop', 1]]]);
    });
});

describe('control flow', () => {
    test('IF … ELSE with EXISTS and BEGIN … END', async () => {
        const run = await ok("IF EXISTS (SELECT 1 FROM Emp WHERE Dept = 'B') PRINT 'has B' ELSE PRINT 'no B'\nIF (SELECT COUNT(*) FROM Emp) > 5\nBEGIN\n  PRINT 'many'\nEND\nELSE\nBEGIN\n  PRINT 'few'\n  PRINT 'really'\nEND");
        expect(prints(run)).toEqual(['has B', 'few', 'really']);
    });

    test('WHILE with BREAK and CONTINUE', async () => {
        const run = await ok("DECLARE @i INT = 0, @s NVARCHAR(50) = ''\nWHILE @i < 10\nBEGIN\n  SET @i = @i + 1\n  IF @i % 2 = 0 CONTINUE\n  IF @i > 7 BREAK\n  SET @s = @s + CAST(@i AS NVARCHAR(5))\nEND\nSELECT @i, @s");
        expect(grids(run)).toEqual([[[9, '1357']]]);
    });

    test('a loop can insert rows', async () => {
        const run = await ok('CREATE TABLE #n (n INT)\nDECLARE @i INT = 1\nWHILE @i <= 5 BEGIN INSERT INTO #n VALUES (@i) SET @i += 1 END\nSELECT SUM(n) FROM #n');
        expect(grids(run)).toEqual([[[15]]]);
    });

    test('GO n repeats a batch', async () => {
        const run = await ok("CREATE TABLE #g (x INT)\nGO\nINSERT INTO #g VALUES (1)\nGO 4\nSELECT COUNT(*) FROM #g");
        expect(grids(run)).toEqual([[[4]]]);
    });

    test('RETURN ends the batch; the next batch still runs', async () => {
        const run = await ok("PRINT 'a'\nRETURN\nPRINT 'b'\nGO\nPRINT 'c'");
        expect(prints(run)).toEqual(['a', 'c']);
    });
});

describe('errors', () => {
    test('TRY … CATCH catches a constraint error and says what happened', async () => {
        const run = await ok("BEGIN TRY\n  INSERT INTO Emp (Id, Name) VALUES (1, 'dup')\n  PRINT 'not here'\nEND TRY\nBEGIN CATCH\n  SELECT ERROR_NUMBER() AS n, ERROR_LINE() AS line, ERROR_MESSAGE() LIKE '%UNIQUE%' AS msg\nEND CATCH\nSELECT ERROR_MESSAGE()");
        expect(grids(run)).toEqual([[[2627, 2, 1]], [[null]]]);
        expect(prints(run)).toEqual([]);
    });

    test('division by zero is an error (SQLite would give NULL)', async () => {
        const run = await ok('BEGIN TRY SELECT 1/0 END TRY BEGIN CATCH SELECT ERROR_MESSAGE(), ERROR_NUMBER() END CATCH');
        expect(grids(run)).toEqual([[['Divide by zero error encountered.', 8134]]]);
        expect(grids(await ok('SELECT 7 / 2, 7 / 2.0, 7 % 3'))).toEqual([[[3, 3.5, 1]]]);
    });

    test('THROW and RAISERROR', async () => {
        const thrown = await tsql("PRINT 'before'\nTHROW 50001, 'Stock is too low.', 1");
        expect(thrown.error).toMatchObject({ message: 'Stock is too low.', line: 2, code: 'Msg 50001, Level 16, State 1' });
        expect(prints(thrown)).toEqual(['before']);
        const info = await ok("RAISERROR('%s has %d rows', 0, 1, 'Emp', 3) WITH NOWAIT");
        expect(prints(info)).toEqual(['Emp has 3 rows']);
        const rethrown = await tsql("BEGIN TRY THROW 50002, 'inner', 1 END TRY BEGIN CATCH PRINT 'caught'; THROW END CATCH");
        expect(rethrown.error.message).toBe('inner');
        expect(prints(rethrown)).toEqual(['caught']);
    });

    test('a script stops at the first error, with the line in the editor', async () => {
        const run = await tsql("SELECT 1\n\nSELECT * FROM Nope\nSELECT 2");
        expect(run.error).toMatchObject({ line: 3 });
        expect(run.error.message).toMatch(/no such table: Nope/);
        expect(grids(run)).toEqual([[[1]]]);
    });

    test('text that isn\'t a number can\'t be added to one', async () => {
        const run = await tsql("SELECT Name + 1 FROM Emp");
        expect(run.error.message).toBe("Conversion failed when converting the varchar value 'Asha' to data type int.");
    });
});

describe('tables', () => {
    test('#temp tables last until the database is closed', async () => {
        const a = await open();
        await ok("CREATE TABLE #cart (Item NVARCHAR(20), Qty INT)\nINSERT INTO #cart VALUES ('pen', 2)", a);
        expect(grids(await ok('SELECT * FROM #cart', a))).toEqual([[['pen', 2]]]);
        expect(grids(await ok("IF OBJECT_ID('tempdb..#cart') IS NOT NULL DROP TABLE #cart\nSELECT OBJECT_ID('tempdb..#cart')", a))).toEqual([[[null]]]);
        // Not in the database's own list of tables
        expect(a.schema().map(t => t.name)).toEqual(['Emp']);
    });

    test('table variables are dropped at the end of their batch', async () => {
        const a = await open();
        const run = await ok("DECLARE @t TABLE (Id INT PRIMARY KEY, Name NVARCHAR(20))\nINSERT INTO @t SELECT Id, Name FROM Emp WHERE Dept = 'A'\nSELECT Name FROM @t ORDER BY Id", a);
        expect(grids(run)).toEqual([[['Asha'], ['Chen']]]);
        expect((await tsql('SELECT * FROM @t', a)).error).not.toBeNull();
    });

    test('SELECT … INTO makes a table (a #temp one too)', async () => {
        const run = await ok("SELECT Id, Name INTO #a FROM Emp WHERE Dept = 'A'\nSELECT * INTO Archive FROM Emp\nSELECT (SELECT COUNT(*) FROM #a), (SELECT COUNT(*) FROM Archive)");
        expect(run.results[0]).toMatchObject({ kind: 'modify', rowsAffected: 2 });
        expect(grids(run)).toEqual([[[2, 3]]]);
    });

    test('IDENTITY numbers rows from its seed; TRUNCATE starts again', async () => {
        const a = await open();
        await ok("CREATE TABLE Orders (OrderId INT IDENTITY(100, 1) NOT NULL, Item NVARCHAR(20), CONSTRAINT PK_Orders PRIMARY KEY CLUSTERED (OrderId))\nINSERT INTO Orders (Item) VALUES ('a'), ('b')", a);
        expect(grids(await ok('SELECT OrderId FROM Orders ORDER BY 1', a))).toEqual([[[100], [101]]]);
        await ok("TRUNCATE TABLE Orders\nINSERT INTO Orders (Item) VALUES ('c')", a);
        expect(grids(await ok('SELECT OrderId, Item FROM Orders', a))).toEqual([[[1, 'c']]]);
    });

    test('an IDENTITY column without a key becomes the key', () => {
        expect(prepareCreateTable('CREATE TABLE T (Id INT IDENTITY(1,1), Name NVARCHAR(MAX) NOT NULL, Created DATETIME DEFAULT GETDATE())'))
            .toBe('CREATE TABLE T (Id INTEGER PRIMARY KEY AUTOINCREMENT, Name NVARCHAR NOT NULL, Created DATETIME DEFAULT (GETDATE()));');
    });

    test('OUTPUT returns the changed rows; OUTPUT INTO keeps them', async () => {
        const run = await ok("INSERT INTO Emp (Id, Name, Salary) OUTPUT INSERTED.Id, inserted.Name VALUES (9, 'Zed', 1)\nDECLARE @log TABLE (Id INT)\nDELETE FROM Emp OUTPUT DELETED.Id INTO @log WHERE Salary < 150\nSELECT Id FROM @log ORDER BY Id");
        expect(grids(run)).toEqual([[[9, 'Zed']], [[1], [9]]]);
    });
});

describe('transactions', () => {
    test('nested BEGIN TRAN counts; ROLLBACK undoes everything', async () => {
        const a = await open();
        const run = await ok("BEGIN TRAN\nBEGIN TRANSACTION\nUPDATE Emp SET Salary = 0\nSELECT @@TRANCOUNT\nCOMMIT\nSELECT @@TRANCOUNT\nROLLBACK TRAN\nSELECT @@TRANCOUNT, SUM(Salary) FROM Emp", a);
        expect(grids(run)).toEqual([[[2]], [[1]], [[0, 500]]]);
        expect(run.inTransaction).toBe(false);
    });

    test('SAVE TRAN and ROLLBACK to it', async () => {
        const run = await ok("BEGIN TRAN\nDELETE FROM Emp WHERE Id = 1\nSAVE TRAN half\nDELETE FROM Emp WHERE Id = 2\nROLLBACK TRAN half\nCOMMIT\nSELECT COUNT(*) FROM Emp");
        expect(grids(run)).toEqual([[[2]]]);
    });

    test('COMMIT without BEGIN is an error', async () => {
        expect((await tsql('COMMIT')).error.message).toBe('The COMMIT TRANSACTION request has no corresponding BEGIN TRANSACTION.');
    });

    test('a transaction stays open across runs until COMMIT', async () => {
        const a = await open();
        expect((await ok('BEGIN TRAN\nUPDATE Emp SET Salary = 1', a)).inTransaction).toBe(true);
        expect(grids(await ok('SELECT @@TRANCOUNT', a))).toEqual([[[1]]]);
        expect((await ok('ROLLBACK', a)).inTransaction).toBe(false);
    });
});

describe('queries', () => {
    test('+ joins text columns and adds numbers', async () => {
        const run = await ok("SELECT Name + ' (' + Dept + ')', Id + Salary, '2024-01-31' + 1 FROM Emp WHERE Id = 1");
        expect(grids(run)).toEqual([[['Asha (A)', 101, '2024-02-01']]]);
    });

    test('TOP n PERCENT and TOP n WITH TIES', async () => {
        const run = await ok('SELECT TOP 50 PERCENT Name FROM Emp ORDER BY Id\nSELECT TOP (1) WITH TIES Name FROM Emp ORDER BY Salary DESC\nDECLARE @n INT = 2\nSELECT TOP (@n) Name FROM Emp ORDER BY Id');
        expect(grids(run)).toEqual([[['Asha'], ['Ben']], [['Ben'], ['Chen']], [['Asha'], ['Ben']]]);
    });

    test('functions: CHOOSE, IIF, TRY_CAST, TRY_CONVERT, FORMAT, STRING_AGG, STRING_SPLIT, CAST', async () => {
        const run = await ok([
            "SELECT CHOOSE(2, 'a', 'b'), IIF(1 > 2, 'y', 'n'), TRY_CAST('x' AS INT), TRY_CONVERT(INT, '12'), FORMAT(1234.5, 'N2'), FORMAT(CAST('2024-02-10' AS DATE), 'dd/MM/yyyy')",
            "SELECT STRING_AGG(Name, ', ') WITHIN GROUP (ORDER BY Name DESC) FROM Emp",
            "SELECT e.Name, s.value FROM Emp e CROSS APPLY STRING_SPLIT('x,y', ',') s WHERE e.Id = 1",
            "SELECT CAST('abcdef' AS VARCHAR(3)), CAST('2024-01-02' AS DATE), CAST(NEWID() AS UNIQUEIDENTIFIER) LIKE '%-%', CAST(3.14159 AS DECIMAL(5, 2))"
        ].join('\n'));
        expect(grids(run)).toEqual([
            [['b', 'n', null, 12, '1,234.50', '10/02/2024']],
            [['Chen, Ben, Asha']],
            [['Asha', 'x'], ['Asha', 'y']],
            [['abc', '2024-01-02', 1, 3.14]]
        ]);
    });

    test('STDEV, VAR and a case-insensitive COLLATE', async () => {
        const run = await ok("SELECT ROUND(STDEV(Salary), 4), VARP(Salary) FROM Emp\nSELECT COUNT(*) FROM Emp WHERE Name = 'asha' COLLATE SQL_Latin1_General_CP1_CI_AS");
        expect(grids(run)).toEqual([[[57.735, 2222.222222222222]], [[1]]]);
    });

    test('a view with TOP 100 PERCENT, created and used across GO', async () => {
        const run = await ok('CREATE VIEW vRich AS SELECT TOP 100 PERCENT Name FROM dbo.Emp WHERE Salary > 150 ORDER BY Name\nGO\nSELECT * FROM vRich');
        expect(grids(run)).toEqual([[['Ben'], ['Chen']]]);
    });

    test('Messages shows PRINT output; the translation lists what changed', async () => {
        const run = await ok("PRINT 'Total: ' + CAST((SELECT COUNT(*) FROM Emp) AS NVARCHAR(10))\nSELECT TOP 1 Name FROM [dbo].[Emp] WITH (NOLOCK)");
        expect(prints(run)).toEqual(['Total: 3']);
        expect(run.translation.changes.map(c => c.message)).toEqual(expect.arrayContaining(['TOP n became LIMIT n.']));
    });

    test('not yet supported statements say so', async () => {
        expect((await tsql('MERGE INTO Emp AS t USING Emp AS s ON t.Id = s.Id WHEN MATCHED THEN UPDATE SET Name = s.Name;')).error.message).toMatch(/isn't supported in SQL Lab yet/);
        expect((await tsql('CREATE TRIGGER tr ON Emp AFTER INSERT AS SELECT 1')).error.message).toMatch(/isn't supported in SQL Lab yet/);
        expect((await tsql("DECLARE c CURSOR FOR SELECT 1")).error).not.toBeNull();
    });
});

describe('translation outside the engine', () => {
    test('+ chains become TSQL_ADD; division is guarded', () => {
        expect(translateForSqlite("SELECT a + b * c - d + 'x', 1 + 2, x / y FROM t", 'sqlserver').sql)
            .toBe("SELECT TSQL_ADD(TSQL_ADD(a, b * c) - d, 'x'), 1 + 2, (CASE WHEN (y) = 0 THEN TSQL_RAISE('Divide by zero error encountered.') ELSE x / y END) FROM t");
    });

    test('#temp names, system variables and table variables', () => {
        expect(translateForSqlite('CREATE TABLE #t (a INT)\nSELECT @@ROWCOUNT, * FROM @tv', 'sqlserver', { tableVariables: new Set(['@tv']) }).sql)
            .toBe('CREATE TEMP TABLE "#t" (a INT)\nSELECT @__rowcount, * FROM "@tv"');
    });
});
