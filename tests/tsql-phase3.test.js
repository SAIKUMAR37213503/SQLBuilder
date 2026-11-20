// SQL Lab's T-SQL engine, Phase 3: MERGE, CROSS / OUTER APPLY, PIVOT /
// UNPIVOT, triggers and cursors.
import { beforeAll, describe, expect, test } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createSqliteAdapter } from '../src/db/sqlite-adapter.js';
import { createMemoryFiles } from '../src/db/files.js';
import { parseBatch } from '../src/db/tsql/parse.js';
import { findApply, findPivot, parseMerge, parseTrigger } from '../src/db/tsql/shapes.js';
import { translateForSqlite } from '../src/db/dialect-translate.js';

let sqlite3;
beforeAll(async () => {
    sqlite3 = await sqlite3InitModule();
});

async function open() {
    const adapter = createSqliteAdapter(sqlite3, createMemoryFiles(sqlite3));
    await adapter.create('test');
    adapter.execute(`CREATE TABLE Emp (Id INTEGER PRIMARY KEY, Name TEXT, Salary REAL, Dept TEXT);
        INSERT INTO Emp VALUES (1, 'Asha', 100, 'A'), (2, 'Ben', 200, 'B'), (3, 'Chen', 200, 'A');
        CREATE TABLE Orders (Id INTEGER PRIMARY KEY AUTOINCREMENT, EmpId INT, Total INT);
        INSERT INTO Orders (EmpId, Total) VALUES (1, 50), (1, 70), (2, 10), (1, 30);
        CREATE TABLE Stock (Id INT PRIMARY KEY, Qty INT, Note TEXT);
        INSERT INTO Stock VALUES (1, 10, 'a'), (2, 20, 'b'), (4, 40, 'd');
        CREATE TABLE Sales (Region TEXT, Yr INT, Amount INT);
        INSERT INTO Sales VALUES ('N', 2023, 5), ('N', 2024, 7), ('S', 2023, 3), ('S', 2023, 4);`);
    return adapter;
}

const run = (adapter, sql) => adapter.execute(sql, { language: 'sqlserver', databaseName: 'Shop' });
const grids = (r) => r.results.filter(x => x.columns.length).map(x => x.rows);
const prints = (r) => r.results.filter(x => x.kind === 'print').map(x => x.text);
function ok(adapter, sql) {
    const r = run(adapter, sql);
    expect(r.error).toBeNull();
    return r;
}
const rows = (adapter, sql) => grids(ok(adapter, sql)).pop();

describe('reading the statements', () => {
    test('MERGE: target, source, ON, clauses and OUTPUT', () => {
        const m = parseMerge(`MERGE INTO dbo.Stock WITH (HOLDLOCK) AS t USING (VALUES (1, 5)) AS s (Id, Qty) ON t.Id = s.Id
            WHEN MATCHED AND s.Qty = 0 THEN DELETE
            WHEN MATCHED THEN UPDATE SET t.Qty = t.Qty + s.Qty, Note = N'x'
            WHEN NOT MATCHED BY TARGET THEN INSERT (Id, Qty) VALUES (s.Id, s.Qty)
            WHEN NOT MATCHED BY SOURCE THEN DELETE
            OUTPUT $action, inserted.Id INTO @log (Act, Id);`);
        expect(m.target).toBe('dbo.Stock');
        expect(m.targetAlias).toBe('t');
        expect(m.source).toEqual({ kind: 'values', text: 'VALUES (1, 5)', columns: ['Id', 'Qty'] });
        expect(m.on).toBe('t.Id = s.Id');
        expect(m.clauses.map(c => [c.match, c.action, c.cond])).toEqual([
            ['matched', 'delete', 's.Qty = 0'], ['matched', 'update', ''], ['target', 'insert', ''], ['source', 'delete', '']
        ]);
        expect(m.clauses[1].sets).toEqual([{ column: 'Qty', expr: 't.Qty + s.Qty' }, { column: 'Note', expr: "N'x'" }]);
        expect(m.clauses[2]).toMatchObject({ columns: ['Id', 'Qty'], values: ['s.Id', 's.Qty'] });
        expect(m.output).toEqual({ list: '$action, inserted.Id', into: '@log', intoColumns: 'Act, Id' });
    });

    test('MERGE mistakes are reported', () => {
        expect(() => parseMerge('MERGE t USING s ON t.a = s.a')).toThrow(/at least one WHEN/);
        expect(() => parseMerge('MERGE t USING s ON t.a = s.a WHEN NOT MATCHED THEN DELETE')).toThrow(/can only INSERT/);
        expect(() => parseMerge('MERGE t USING (VALUES (1)) AS s ON 1 = 1 WHEN MATCHED THEN DELETE')).toThrow(/column names/);
    });

    test('APPLY, PIVOT and triggers are found', () => {
        const a = findApply('SELECT * FROM Emp e JOIN Dept d ON d.Id = e.DeptId CROSS APPLY (SELECT TOP 1 x FROM t WHERE t.e = e.Id) AS o');
        expect(a).toMatchObject({ kind: 'CROSS', alias: 'o', leftAliases: ['e', 'd'], isCall: false });
        expect(findApply("SELECT * FROM Emp CROSS APPLY STRING_SPLIT('a,b', ',') s")).toBeNull();
        expect(findApply('SELECT * FROM Emp e OUTER APPLY dbo.f(e.Id) AS x')).toMatchObject({ kind: 'OUTER', isCall: true, inner: 'SELECT * FROM dbo.f(e.Id)' });
        const p = findPivot('SELECT * FROM (SELECT a, b, c FROM t) AS s PIVOT (SUM(c) FOR b IN ([x], [y z])) AS p');
        expect(p).toMatchObject({ kind: 'PIVOT', agg: 'SUM', aggArg: 'c', pivotColumn: 'b', values: ['x', 'y z'], alias: 'p', sourceAlias: 's' });
        const u = findPivot('SELECT * FROM Q UNPIVOT (Val FOR Quarter IN (Q1, Q2)) u');
        expect(u).toMatchObject({ kind: 'UNPIVOT', value: 'Val', pivotColumn: 'Quarter', values: ['Q1', 'Q2'], source: 'Q' });
        const t = parseTrigger('CREATE OR ALTER TRIGGER dbo.trg ON dbo.Orders AFTER INSERT, DELETE AS SELECT 1');
        expect(t).toMatchObject({ action: 'create or alter', schema: 'dbo', name: 'trg', table: 'Orders', instead: false, events: ['INSERT', 'DELETE'], body: 'SELECT 1' });
        expect(parseTrigger('CREATE TRIGGER x ON v INSTEAD OF UPDATE AS PRINT 1').instead).toBe(true);
        expect(() => parseTrigger('CREATE TRIGGER x ON DATABASE FOR CREATE_TABLE AS PRINT 1')).toThrow(/ON DATABASE/);
    });

    test('cursor statements are told apart from columns named Open and Close', () => {
        const nodes = parseBatch(`DECLARE c SCROLL CURSOR FOR SELECT Open, Close FROM Prices ORDER BY Open FOR READ ONLY
            OPEN c
            FETCH ABSOLUTE -2 FROM c INTO @o, @x
            FETCH c
            CLOSE c DEALLOCATE c
            SELECT * FROM t ORDER BY a OFFSET 1 ROWS FETCH NEXT 2 ROWS ONLY`);
        expect(nodes.map(n => n.type)).toEqual(['cursor', 'open', 'fetch', 'fetch', 'close', 'deallocate', 'sql']);
        expect(nodes[0]).toMatchObject({ name: 'c', scroll: true, query: { text: 'SELECT Open, Close FROM Prices ORDER BY Open' } });
        expect(nodes[2]).toMatchObject({ orientation: 'ABSOLUTE', offset: { text: '-2' }, into: ['@o', '@x'] });
        expect(nodes[3]).toMatchObject({ orientation: 'NEXT', into: [] });
    });

    test('IF UPDATE(column) is a condition; a table named Log stays a table', () => {
        expect(parseBatch('IF UPDATE(Qty) AND NOT UPDATE(Name) PRINT 1').map(n => [n.type, n.cond?.text])).toEqual([['if', 'UPDATE(Qty) AND NOT UPDATE(Name)']]);
        expect(translateForSqlite('INSERT INTO Log (Id, Old) SELECT LOG(8, 2), 1', 'sqlserver').sql).toBe('INSERT INTO Log (Id, Old) SELECT log(2, 8), 1');
    });
});

describe('MERGE', () => {
    test('updates, deletes and inserts in one statement, with OUTPUT $action', async () => {
        const db = await open();
        const r = ok(db, `MERGE INTO Stock AS t USING (VALUES (1, 5), (2, 0), (3, 2)) AS s (Id, Qty) ON t.Id = s.Id
            WHEN MATCHED AND s.Qty = 0 THEN DELETE
            WHEN MATCHED THEN UPDATE SET t.Qty = t.Qty + s.Qty
            WHEN NOT MATCHED BY TARGET THEN INSERT (Id, Qty, Note) VALUES (s.Id, s.Qty, N'new')
            WHEN NOT MATCHED BY SOURCE THEN UPDATE SET Note = N'stale'
            OUTPUT $action, inserted.*, deleted.Qty AS OldQty;
            SELECT @@ROWCOUNT;
            SELECT * FROM Stock ORDER BY Id;`);
        const [output, count, after] = r.results.filter(x => x.columns.length);
        expect(output.columns).toEqual(['$action', 'Id', 'Qty', 'Note', 'OldQty']);
        expect(output.rows).toEqual([['DELETE', null, null, null, 20], ['UPDATE', 1, 15, 'a', 10], ['UPDATE', 4, 40, 'stale', 40], ['INSERT', 3, 2, 'new', null]]);
        expect(count.rows).toEqual([[4]]);
        expect(after.rows).toEqual([[1, 15, 'a'], [3, 2, 'new'], [4, 40, 'stale']]);
    });

    test('a table source, INSERT without a column list, and OUTPUT INTO a table variable', async () => {
        const db = await open();
        const r = ok(db, `CREATE TABLE #src (Id INT, Qty INT); INSERT INTO #src VALUES (4, 1), (9, 9);
            DECLARE @log TABLE (Act NVARCHAR(10), Id INT);
            MERGE Stock USING #src ON Stock.Id = #src.Id
                WHEN MATCHED THEN UPDATE SET Qty = #src.Qty
                WHEN NOT MATCHED THEN INSERT VALUES (#src.Id, #src.Qty, NULL)
                OUTPUT $action, inserted.Id INTO @log (Act, Id);
            SELECT * FROM @log ORDER BY Id; SELECT Id, Qty FROM Stock ORDER BY Id;`);
        expect(grids(r)).toEqual([[['UPDATE', 4], ['INSERT', 9]], [[1, 10], [2, 20], [4, 1], [9, 9]]]);
    });

    test('a target row matched twice is refused and nothing changes', async () => {
        const db = await open();
        const r = run(db, 'MERGE Stock AS t USING (SELECT 1 AS Id UNION ALL SELECT 1) AS s ON t.Id = s.Id WHEN MATCHED THEN DELETE;');
        expect(r.error.code).toMatch(/^Msg 8672/);
        expect(rows(db, 'SELECT COUNT(*) FROM Stock')).toEqual([[3]]);
    });

    test('a failing insert undoes the whole MERGE', async () => {
        const db = await open();
        const r = run(db, `MERGE Stock AS t USING (VALUES (1, 1), (2, 2), (2, 3)) AS s (Id, Qty) ON t.Id = s.Id AND s.Qty = 1
            WHEN MATCHED THEN UPDATE SET Qty = 99 WHEN NOT MATCHED THEN INSERT (Id, Qty) VALUES (s.Id, s.Qty);`);
        expect(r.error.code).toMatch(/^Msg 2627/);
        expect(rows(db, 'SELECT Id, Qty FROM Stock ORDER BY Id')).toEqual([[1, 10], [2, 20], [4, 40]]);
    });

    test('an unknown column is named', async () => {
        const db = await open();
        expect(run(db, 'MERGE Stock t USING Emp s ON t.Id = s.Id WHEN MATCHED THEN UPDATE SET Nope = 1;').error.message).toBe("Invalid column name 'Nope'.");
    });
});

describe('APPLY', () => {
    test('CROSS APPLY runs the right side for each left row', async () => {
        const db = await open();
        expect(rows(db, 'SELECT e.Name, o.Total FROM Emp e CROSS APPLY (SELECT TOP 2 Total FROM Orders WHERE EmpId = e.Id ORDER BY Total DESC) AS o ORDER BY e.Name, o.Total'))
            .toEqual([['Asha', 50], ['Asha', 70], ['Ben', 10]]);
    });

    test('OUTER APPLY keeps left rows without matches; * leaves out the join keys', async () => {
        const db = await open();
        const r = ok(db, 'SELECT * FROM Emp AS e OUTER APPLY (SELECT COUNT(*) AS n, SUM(Total) AS s FROM Orders o WHERE o.EmpId = e.Id) x ORDER BY e.Id');
        const grid = r.results.find(x => x.columns.length);
        expect(grid.columns).toEqual(['Id', 'Name', 'Salary', 'Dept', 'n', 's']);
        expect(grid.rows).toEqual([[1, 'Asha', 100, 'A', 3, 150], [2, 'Ben', 200, 'B', 1, 10], [3, 'Chen', 200, 'A', 0, null]]);
    });

    test('APPLY over table-valued functions, twice in one query, and run again in a second run', async () => {
        const db = await open();
        ok(db, `CREATE FUNCTION dbo.OrdersOf (@emp INT) RETURNS TABLE AS RETURN (SELECT Total FROM Orders WHERE EmpId = @emp)
            GO
            CREATE FUNCTION dbo.Big (@emp INT) RETURNS @t TABLE (Total INT) AS BEGIN INSERT INTO @t SELECT MAX(Total) FROM Orders WHERE EmpId = @emp; RETURN; END`);
        const sql = 'SELECT e.Name, o.Total, b.Total AS Biggest FROM Emp e CROSS APPLY dbo.OrdersOf(e.Id) o OUTER APPLY dbo.Big(e.Id) AS b ORDER BY 1, 2';
        const expected = [['Asha', 30, 70], ['Asha', 50, 70], ['Asha', 70, 70], ['Ben', 10, 10]];
        expect(rows(db, sql)).toEqual(expected);
        expect(rows(db, sql)).toEqual(expected);
    });

    test('APPLY that doesn\'t use the left side is a plain join', async () => {
        const db = await open();
        expect(rows(db, 'SELECT e.Id, m.Top1 FROM Emp e CROSS APPLY (SELECT MAX(Total) AS Top1 FROM Orders) m WHERE e.Id < 3 ORDER BY e.Id')).toEqual([[1, 70], [2, 70]]);
    });
});

describe('PIVOT and UNPIVOT', () => {
    test('PIVOT over a derived table and over a table', async () => {
        const db = await open();
        const r = ok(db, 'SELECT * FROM (SELECT Region, Yr, Amount FROM Sales) AS s PIVOT (SUM(Amount) FOR Yr IN ([2023], [2024])) AS p ORDER BY Region');
        const grid = r.results.find(x => x.columns.length);
        expect(grid.columns).toEqual(['Region', '2023', '2024']);
        expect(grid.rows).toEqual([['N', 5, 7], ['S', 7, null]]);
        expect(rows(db, 'SELECT Region, [2023] AS y FROM Sales PIVOT (COUNT(Amount) FOR Yr IN ([2023])) p ORDER BY Region')).toEqual([['N', 1], ['S', 2]]);
    });

    test('UNPIVOT turns columns into rows and leaves out NULLs', async () => {
        const db = await open();
        expect(rows(db, `CREATE TABLE Q (Name NVARCHAR(5), Q1 INT, Q2 INT); INSERT INTO Q VALUES ('a', 1, NULL), ('b', 3, 4);
            SELECT Name, Quarter, Val FROM Q UNPIVOT (Val FOR Quarter IN (Q1, Q2)) AS u ORDER BY Name, Quarter`))
            .toEqual([['a', 'Q1', 1], ['b', 'Q1', 3], ['b', 'Q2', 4]]);
    });

    test('a PIVOT column that isn\'t there is named', async () => {
        const db = await open();
        expect(run(db, 'SELECT * FROM Sales PIVOT (SUM(Amount) FOR Year IN ([2023])) p').error.message).toBe("Invalid column name 'Year'.");
    });
});

describe('triggers', () => {
    const AUDIT = `CREATE TABLE Audit (Op NVARCHAR(10), Id INT, OldQty INT, NewQty INT)
        GO
        CREATE TRIGGER trg_Stock ON dbo.Stock AFTER INSERT, UPDATE, DELETE AS
        BEGIN
            SET NOCOUNT ON;
            INSERT INTO Audit (Op, Id, OldQty, NewQty)
            SELECT CASE WHEN d.Id IS NULL THEN 'INS' WHEN i.Id IS NULL THEN 'DEL' ELSE 'UPD' END, COALESCE(i.Id, d.Id), d.Qty, i.Qty
            FROM inserted i FULL JOIN deleted d ON i.Id = d.Id;
            IF UPDATE(Note) PRINT 'note changed';
        END`;

    test('AFTER triggers see inserted and deleted, once per statement', async () => {
        const db = await open();
        const created = ok(db, AUDIT);
        expect(created.results.at(-1).note).toBe('The trigger dbo.trg_Stock was created.');
        const r = ok(db, `INSERT INTO Stock VALUES (5, 50, 'e'), (6, 60, 'f');
            UPDATE Stock SET Qty = Qty + 1 WHERE Id <= 2;
            UPDATE Stock SET Note = 'z' WHERE Id = 5;
            DELETE FROM Stock WHERE Id = 6;
            SELECT @@ROWCOUNT;
            SELECT * FROM Audit;`);
        expect(prints(r)).toEqual(['note changed', 'note changed']);
        const [count, audit] = grids(r);
        expect(count).toEqual([[1]]);
        expect(audit).toEqual([['INS', 5, null, 50], ['INS', 6, null, 60], ['UPD', 1, 10, 11], ['UPD', 2, 20, 21], ['UPD', 5, 50, 50], ['DEL', 6, 60, null]]);
    });

    test('triggers fire for MERGE but not TRUNCATE, and are listed in sys.triggers', async () => {
        const db = await open();
        ok(db, AUDIT);
        ok(db, "MERGE Stock AS t USING (VALUES (1, 7), (9, 9)) AS s (Id, Qty) ON t.Id = s.Id WHEN MATCHED THEN UPDATE SET Qty = s.Qty WHEN NOT MATCHED THEN INSERT (Id, Qty, Note) VALUES (s.Id, s.Qty, 'm');");
        expect(rows(db, 'SELECT Op, Id, OldQty, NewQty FROM Audit ORDER BY Op')).toEqual([['INS', 9, null, 9], ['UPD', 1, 10, 7]]);
        expect(rows(db, 'DELETE FROM Audit; TRUNCATE TABLE Stock; SELECT COUNT(*) FROM Audit')).toEqual([[0]]);
        expect(rows(db, "SELECT name, type, is_instead_of_trigger, OBJECT_NAME(parent_id) FROM sys.triggers; SELECT OBJECT_ID('trg_Stock', 'TR') - OBJECT_ID('trg_Stock')")).toEqual([[0]]);
        expect(grids(ok(db, 'SELECT name, type, is_instead_of_trigger, OBJECT_NAME(parent_id) FROM sys.triggers'))[0]).toEqual([['trg_Stock', 'TR', 0, 'Stock']]);
        expect(db.modules().map(m => [m.name, m.kind])).toEqual([['trg_Stock', 'TR']]);
    });

    test('an error or ROLLBACK in a trigger undoes the statement', async () => {
        const db = await open();
        ok(db, `CREATE TRIGGER trg_NoNeg ON Stock AFTER UPDATE AS
            IF EXISTS (SELECT 1 FROM inserted WHERE Qty < 0) BEGIN ROLLBACK TRANSACTION; RETURN; END`);
        const r = run(db, 'UPDATE Stock SET Qty = -1 WHERE Id = 1;\nSELECT 1');
        expect(r.error.code).toBe('Msg 3609, Level 16, State 1');
        expect(r.error.message).toBe('The transaction ended in the trigger. The batch has been aborted.');
        ok(db, "CREATE OR ALTER TRIGGER trg_NoNeg ON Stock AFTER UPDATE AS IF EXISTS (SELECT 1 FROM inserted WHERE Qty < 0) THROW 50001, 'No negative stock', 1;");
        const r2 = run(db, 'UPDATE Stock SET Qty = -1 WHERE Id = 2');
        expect(r2.error.code).toBe('Msg 50001, Level 16, State 1, Procedure trg_NoNeg, Line 1');
        expect(rows(db, 'SELECT Qty FROM Stock ORDER BY Id')).toEqual([[10], [20], [40]]);
    });

    test('INSTEAD OF on a table and on a view', async () => {
        const db = await open();
        ok(db, `CREATE TRIGGER trg_Up ON Stock INSTEAD OF INSERT AS INSERT INTO Stock (Id, Qty, Note) SELECT Id, Qty * 2, UPPER(Note) FROM inserted
            GO
            CREATE VIEW vStock AS SELECT Id, Qty FROM Stock
            GO
            CREATE TRIGGER trg_vDel ON vStock INSTEAD OF DELETE AS UPDATE Stock SET Qty = 0 WHERE Id IN (SELECT Id FROM deleted)`);
        expect(rows(db, "INSERT INTO Stock VALUES (7, 3, 'abc'); DELETE FROM vStock WHERE Id = 1; SELECT * FROM Stock WHERE Id IN (1, 7) ORDER BY Id"))
            .toEqual([[1, 0, 'a'], [7, 6, 'ABC']]);
        expect(run(db, 'CREATE TRIGGER trg_Up2 ON Stock INSTEAD OF INSERT AS PRINT 1').error.code).toMatch(/^Msg 2111/);
        expect(run(db, 'CREATE TRIGGER trg_v ON vStock AFTER INSERT AS PRINT 1').error.code).toMatch(/^Msg 8197/);
    });

    test('DROP TRIGGER, and a dropped table takes its triggers', async () => {
        const db = await open();
        ok(db, AUDIT);
        expect(run(db, 'DROP TRIGGER nope').error.code).toMatch(/^Msg 3701/);
        ok(db, 'DROP TRIGGER IF EXISTS nope; DROP TRIGGER trg_Stock; UPDATE Stock SET Qty = 1');
        expect(rows(db, 'SELECT COUNT(*) FROM Audit')).toEqual([[0]]);
        ok(db, 'CREATE TRIGGER t2 ON Audit AFTER INSERT AS PRINT 1');
        ok(db, 'DROP TABLE Audit');
        expect(db.modules()).toEqual([]);
        expect(run(db, 'CREATE TRIGGER t3 ON NoSuch AFTER INSERT AS PRINT 1').error.code).toMatch(/^Msg 8197/);
    });

    test('a trigger in another table\'s trigger, each with its own inserted', async () => {
        const db = await open();
        ok(db, `CREATE TABLE L1 (Id INT); CREATE TABLE L2 (Id INT, Src NVARCHAR(10))
            GO
            CREATE TRIGGER t_stock ON Stock AFTER INSERT AS BEGIN INSERT INTO L1 SELECT Id * 10 FROM inserted; INSERT INTO L2 SELECT Id, 'stock' FROM inserted; END
            GO
            CREATE TRIGGER t_l1 ON L1 AFTER INSERT AS INSERT INTO L2 SELECT Id, 'l1' FROM inserted`);
        expect(rows(db, 'INSERT INTO Stock VALUES (8, 1, NULL); SELECT * FROM L2 ORDER BY Src')).toEqual([[80, 'l1'], [8, 'stock']]);
    });
});

describe('cursors', () => {
    test('FETCH NEXT … INTO in a WHILE @@FETCH_STATUS = 0 loop', async () => {
        const db = await open();
        const r = ok(db, `DECLARE @n NVARCHAR(20), @s REAL;
            DECLARE c CURSOR LOCAL FAST_FORWARD FOR SELECT Name, Salary FROM Emp ORDER BY Id;
            OPEN c;
            FETCH NEXT FROM c INTO @n, @s;
            WHILE @@FETCH_STATUS = 0
            BEGIN
                PRINT @n + ' ' + CAST(@s AS NVARCHAR(10));
                FETCH NEXT FROM c INTO @n, @s;
            END
            CLOSE c;
            DEALLOCATE c;
            SELECT @@FETCH_STATUS;`);
        expect(prints(r)).toEqual(['Asha 100', 'Ben 200', 'Chen 200']);
        expect(grids(r)).toEqual([[[-1]]]);
    });

    test('SCROLL cursors move both ways; FETCH without INTO returns the row', async () => {
        const db = await open();
        const r = ok(db, 'DECLARE c SCROLL CURSOR FOR SELECT Id FROM Emp ORDER BY Id; OPEN c; SELECT @@CURSOR_ROWS; FETCH LAST FROM c; FETCH ABSOLUTE 1 FROM c; FETCH RELATIVE 1 FROM c; FETCH PRIOR FROM c; FETCH PRIOR FROM c; SELECT @@FETCH_STATUS; CLOSE c; DEALLOCATE c;');
        expect(grids(r)).toEqual([[[3]], [[3]], [[1]], [[2]], [[1]], [], [[-1]]]);
    });

    test('cursor mistakes give SQL Server\'s errors', async () => {
        const db = await open();
        expect(run(db, 'DECLARE c CURSOR FOR SELECT Id FROM Emp; FETCH NEXT FROM c;').error.code).toMatch(/^Msg 16917/);
        expect(run(db, 'DECLARE c CURSOR FOR SELECT Id FROM Emp; OPEN c; FETCH FIRST FROM c;').error.code).toMatch(/^Msg 16911/);
        expect(run(db, 'DECLARE c CURSOR FOR SELECT Id FROM Emp; DECLARE c CURSOR FOR SELECT 1;').error.code).toMatch(/^Msg 16915/);
        expect(run(db, 'OPEN nope').error.code).toMatch(/^Msg 16916/);
        expect(run(db, 'DECLARE @a INT; DECLARE c CURSOR FOR SELECT Id, Name FROM Emp; OPEN c; FETCH NEXT FROM c INTO @a;').error.code).toMatch(/^Msg 16924/);
        expect(run(db, 'DECLARE c CURSOR FOR SELECT Id FROM Emp; OPEN c; OPEN c;').error.code).toMatch(/^Msg 16905/);
    });
});
