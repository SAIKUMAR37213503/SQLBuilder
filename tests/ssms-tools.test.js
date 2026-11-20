// SQL Lab's SSMS-style tools (Phase 4): Script Table as …, Select Top 1000
// Rows, Generate Scripts, Format SQL, the estimated plan, results as text /
// CSV / JSON, sorting, and IntelliSense suggestions.
import { beforeAll, describe, expect, test } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createSqliteAdapter } from '../src/db/sqlite-adapter.js';
import { createMemoryFiles } from '../src/db/files.js';
import {
    quoteName, serverType, literal, scriptSelectTop, scriptSelect, scriptCreate, scriptInsert, scriptUpdate, scriptDelete, scriptDrop,
    scriptModule, dependencyOrder, scriptDatabase, formatSql, planOperator, planTree, planHints,
    resultAsText, resultAsCsv, resultAsTsv, resultAsJson, sortedRows, tableAliases, completions
} from '../src/ui/lab-scripts.js';
import { planStatements } from '../src/ui/lab-console.js';

let sqlite3;
beforeAll(async () => {
    sqlite3 = await sqlite3InitModule();
});

const SHOP = `CREATE TABLE Customers (Id INTEGER PRIMARY KEY AUTOINCREMENT, Name TEXT NOT NULL, City TEXT DEFAULT 'Pune');
    CREATE TABLE Orders (Id INTEGER PRIMARY KEY, CustomerId INTEGER REFERENCES Customers(Id), Total REAL, Note TEXT, Photo BLOB);
    CREATE INDEX ix_orders_customer ON Orders(CustomerId);
    CREATE VIEW BigOrders AS SELECT * FROM Orders WHERE Total > 100;
    INSERT INTO Customers (Name, City) VALUES ('Asha', 'Delhi'), ('O''Brien', NULL), ('Chen', 'Pune');
    INSERT INTO Orders VALUES (1, 1, 50.5, 'first', NULL), (2, 1, 150, NULL, X'CAFE'), (3, 2, 300, 'tab	in', NULL);`;

async function open(name = 'test', sql = SHOP) {
    const adapter = createSqliteAdapter(sqlite3, createMemoryFiles(sqlite3));
    await adapter.create(name);
    if (sql) adapter.execute(sql);
    return adapter;
}
const tsql = (a, sql) => a.execute(sql, { language: 'sqlserver', databaseName: 'Shop' });
const grids = (r) => r.results.filter(x => x.columns?.length).map(x => x.rows);
const object = (a, name) => a.schema().find(o => o.name === name);

describe('Script Table as …', () => {
    test('names and types as SQL Server writes them', () => {
        expect(quoteName('Order Details', 'sqlserver')).toBe('[Order Details]');
        expect(quoteName('a]b', 'sqlserver')).toBe('[a]]b]');
        expect(quoteName('Orders', 'sqlite')).toBe('Orders');
        expect(quoteName('Order', 'sqlite')).toBe('"Order"');
        expect(quoteName('x`y', 'mysql')).toBe('`x``y`');
        expect(serverType('TEXT')).toBe('NVARCHAR(MAX)');
        expect(serverType('INTEGER')).toBe('INT');
        expect(serverType('REAL')).toBe('FLOAT');
        expect(serverType('BLOB')).toBe('VARBINARY(MAX)');
        expect(serverType('varchar ( 50 )')).toBe('VARCHAR(50)');
        expect(serverType('')).toBe('NVARCHAR(MAX)');
        expect(literal(null, 'sqlserver')).toBe('NULL');
        expect(literal("O'Brien", 'sqlserver')).toBe("N'O''Brien'");
        expect(literal("O'Brien", 'sqlite')).toBe("'O''Brien'");
        expect(literal({ hex: 'cafe' }, 'sqlserver')).toBe('0xCAFE');
        expect(literal({ hex: 'cafe' }, 'sqlite')).toBe("X'cafe'");
        expect(literal(1.5, 'sqlserver')).toBe('1.5');
    });

    test('Select Top 1000 Rows lists every column, and runs', async () => {
        const a = await open();
        const sql = scriptSelectTop(object(a, 'Customers'), 'sqlserver');
        expect(sql).toBe('SELECT TOP (1000) [Id]\n      ,[Name]\n      ,[City]\n  FROM [dbo].[Customers]');
        expect(grids(tsql(a, sql))[0]).toHaveLength(3);
        const lite = scriptSelectTop(object(a, 'Customers'), 'sqlite');
        expect(lite).toMatch(/LIMIT 1000;$/);
        expect(grids(a.execute(lite))[0]).toHaveLength(3);
    });

    test('CREATE in T-SQL: SQL Server types, IDENTITY, named keys, and it runs in the T-SQL engine', async () => {
        const a = await open();
        const customers = scriptCreate(object(a, 'Customers'), 'sqlserver');
        expect(customers).toContain('[Id] INT IDENTITY(1,1) NOT NULL');
        expect(customers).toContain('[Name] NVARCHAR(MAX) NOT NULL');
        expect(customers).toContain("[City] NVARCHAR(MAX) NULL DEFAULT ('Pune')");
        expect(customers).toContain('CONSTRAINT [PK_Customers] PRIMARY KEY CLUSTERED ([Id] ASC)');
        const orders = scriptCreate(object(a, 'Orders'), 'sqlserver');
        expect(orders).not.toContain('IDENTITY');
        expect(orders).toContain('CONSTRAINT [FK_Orders_Customers] FOREIGN KEY ([CustomerId]) REFERENCES [dbo].[Customers] ([Id])');
        expect(orders).toContain('[Photo] VARBINARY(MAX) NULL');
        const b = await open('copy', null);
        const r = tsql(b, `${customers}\n${orders}\nINSERT INTO Customers (Name) VALUES (N'Z'); SELECT Id, City FROM Customers;`);
        expect(r.error).toBeNull();
        expect(grids(r)[0]).toEqual([[1, 'Pune']]);
    });

    test('CREATE in SQLite and for a view is the statement the database has', async () => {
        const a = await open();
        expect(scriptCreate(object(a, 'Orders'), 'sqlite')).toMatch(/^CREATE TABLE Orders \(.*\);$/s);
        expect(scriptCreate(object(a, 'BigOrders'), 'sqlserver')).toBe('CREATE VIEW BigOrders AS SELECT * FROM Orders WHERE Total > 100\nGO');
    });

    test('INSERT, UPDATE and DELETE templates leave the identity column out, and SELECT / DROP run', async () => {
        const a = await open();
        const c = object(a, 'Customers');
        expect(scriptInsert(c, 'sqlserver')).toBe('INSERT INTO [dbo].[Customers]\n           ([Name]\n           ,[City])\n     VALUES\n           (<Name, nvarchar(max),>\n           ,<City, nvarchar(max),>)\nGO');
        expect(scriptUpdate(c, 'sqlserver')).toContain('   SET [Name] = <Name, nvarchar(max),>\n      ,[City] = <City, nvarchar(max),>\n WHERE <Search Conditions,,>');
        expect(scriptDelete(c, 'sqlserver')).toBe('DELETE FROM [dbo].[Customers]\n      WHERE <Search Conditions,,>\nGO');
        expect(scriptInsert(object(a, 'Orders'), 'sqlserver')).toContain('([Id]');
        expect(grids(tsql(a, scriptSelect(c, 'sqlserver')))[0]).toHaveLength(3);
        expect(scriptDrop(object(a, 'BigOrders'), 'sqlserver')).toBe('DROP VIEW IF EXISTS [dbo].[BigOrders]\nGO');
        expect(tsql(a, scriptDrop(object(a, 'BigOrders'), 'sqlserver')).error).toBeNull();
        expect(a.schema().some(o => o.name === 'BigOrders')).toBe(false);
    });

    test('procedures, functions and triggers: CREATE, ALTER, EXECUTE, DROP', async () => {
        const a = await open();
        expect(tsql(a, `CREATE PROCEDURE dbo.Orders_For @Customer INT, @Count INT OUTPUT AS SELECT @Count = COUNT(*) FROM Orders WHERE CustomerId = @Customer
GO
CREATE FUNCTION dbo.Twice (@x INT) RETURNS INT AS BEGIN RETURN @x * 2 END
GO
CREATE TRIGGER trg_orders ON Orders AFTER INSERT AS PRINT 'added'`).error).toBeNull();
        const mods = a.modules();
        const proc = mods.find(m => m.name === 'Orders_For');
        expect(scriptModule(proc, 'create')).toBe(`${proc.definition}\nGO`);
        expect(scriptModule(proc, 'alter')).toMatch(/^ALTER PROCEDURE dbo\.Orders_For/);
        const exec = scriptModule(proc, 'execute');
        expect(exec).toContain('DECLARE @Count INT');
        expect(exec).toContain('EXECUTE @RC = [dbo].[Orders_For]');
        expect(exec).toContain('@Count = @Count OUTPUT');
        expect(scriptModule(mods.find(m => m.name === 'Twice'), 'execute')).toBe('SELECT [dbo].[Twice](<@x, int,>)\nGO');
        expect(scriptModule(mods.find(m => m.name === 'trg_orders'), 'drop')).toBe('DROP TRIGGER IF EXISTS [dbo].[trg_orders]\nGO');
        // ALTER runs, and the script of the change runs too
        expect(tsql(a, scriptModule(proc, 'alter')).error).toBeNull();
        expect(tsql(a, 'DECLARE @n INT; EXEC dbo.Orders_For 1, @n OUTPUT; SELECT @n').error).toBeNull();
        expect(tsql(a, scriptModule(mods.find(m => m.name === 'Twice'), 'drop')).error).toBeNull();
    });
});

describe('Generate Scripts', () => {
    test('tables come after the tables their foreign keys point to', async () => {
        const a = await open('fkdb', `CREATE TABLE C (Id INTEGER PRIMARY KEY, BId INT REFERENCES B(Id));
            CREATE TABLE B (Id INTEGER PRIMARY KEY, AId INT REFERENCES A(Id));
            CREATE TABLE A (Id INTEGER PRIMARY KEY, Self INT REFERENCES A(Id));`);
        expect(dependencyOrder(a.schema()).map(t => t.name)).toEqual(['A', 'B', 'C']);
    });

    test('schema and data in T-SQL rebuild the database in the T-SQL engine', async () => {
        const a = await open();
        tsql(a, 'CREATE PROCEDURE dbo.CountOrders AS SELECT COUNT(*) AS n FROM Orders');
        const data = new Map(a.schema().filter(o => o.type === 'table').map(o => [o.name, a.readTable(o.name)]));
        const script = scriptDatabase({ objects: a.schema(), modules: a.modules(), data, language: 'sqlserver', databaseName: 'Shop' });
        expect(script).toContain('-- USE [Shop]');
        expect(script.indexOf('CREATE TABLE [dbo].[Customers]')).toBeLessThan(script.indexOf('CREATE TABLE [dbo].[Orders]'));
        expect(script).toContain('SET IDENTITY_INSERT [dbo].[Customers] ON');
        expect(script).toContain("INSERT [dbo].[Customers] ([Id], [Name], [City]) VALUES (2, N'O''Brien', NULL)");
        expect(script).toContain('0xCAFE');
        expect(script).toContain('CREATE PROCEDURE dbo.CountOrders');
        const b = await open('shopcopy', null);
        const r = tsql(b, script);
        expect(r.error).toBeNull();
        expect(grids(tsql(b, 'SELECT Id, Name, City FROM Customers ORDER BY Id'))[0]).toEqual(grids(tsql(a, 'SELECT Id, Name, City FROM Customers ORDER BY Id'))[0]);
        expect(grids(tsql(b, 'SELECT Id, Total, Note, HEX(Photo) FROM Orders ORDER BY Id'))[0]).toEqual([[1, 50.5, 'first', ''], [2, 150, null, 'CAFE'], [3, 300, 'tab\tin', '']]);
        expect(grids(tsql(b, 'EXEC dbo.CountOrders'))[0]).toEqual([[3]]);
        // IDENTITY carries on after the copied rows
        expect(grids(tsql(b, "INSERT INTO Customers (Name) VALUES (N'New'); SELECT SCOPE_IDENTITY()"))[0]).toEqual([[4]]);
    });

    test('schema only in SQLite runs as plain SQL', async () => {
        const a = await open();
        const script = scriptDatabase({ objects: a.schema(), modules: [], data: null, language: 'sqlite', databaseName: 'Shop' });
        expect(script).not.toContain('GO');
        expect(script).toContain('-- Schema only');
        const b = await open('copy', null);
        expect(b.execute(script).error).toBeNull();
        expect(b.schema().map(o => o.name).sort()).toEqual(['BigOrders', 'Customers', 'Orders']);
    });

    test('readTable reads rows and says when there are more', async () => {
        const a = await open();
        const all = a.readTable('Orders');
        expect(all.columns).toEqual(['Id', 'CustomerId', 'Total', 'Note', 'Photo']);
        expect(all.rows[1][4]).toEqual({ hex: 'cafe' });
        expect(all.more).toBe(false);
        const two = a.readTable('Orders', { limit: 2 });
        expect(two.rows).toHaveLength(2);
        expect(two.more).toBe(true);
        expect(() => a.readTable('Nope')).toThrow(/no table named Nope/);
    });
});

describe('Format SQL', () => {
    const queries = [
        "select c.Name, count(*) as n, sum(o.Total) total from Customers c inner join Orders o on o.CustomerId = c.Id and o.Total > 10 where c.City in ('Delhi', 'Pune') or c.Name like 'A%' group by c.Name having count(*) >= 1 order by n desc, c.Name",
        'select Id, case when Total > 100 then \'big\' else \'small\' end as size, row_number() over (partition by CustomerId order by Total) rn from Orders where Total between 10 and 400',
        'select * from Customers where Id in (select CustomerId from Orders where Total > -1) union all select * from Customers where Id = 3',
        "with t as (select CustomerId, Total from Orders) select CustomerId, max(Total) from t group by CustomerId -- the biggest\n"
    ];

    test('one clause per line, keywords in capitals, lists and conditions one per line', () => {
        expect(formatSql(queries[0])).toBe(`SELECT c.Name,
    COUNT(*) AS n,
    SUM(o.Total) total
FROM Customers c
INNER JOIN Orders o
    ON o.CustomerId = c.Id
    AND o.Total > 10
WHERE c.City IN ('Delhi', 'Pune')
    OR c.Name LIKE 'A%'
GROUP BY c.Name
HAVING COUNT(*) >= 1
ORDER BY n DESC,
    c.Name
`);
        expect(formatSql('select 1 where x between 1 and 5 and y = -2')).toBe('SELECT 1\nWHERE x BETWEEN 1 AND 5\n    AND y = -2\n');
    });

    test('the formatted query returns the same rows', async () => {
        const a = await open();
        for (const q of queries) {
            const before = a.execute(q);
            const after = a.execute(formatSql(q));
            expect(after.error).toBeNull();
            expect(grids(after)).toEqual(grids(before));
        }
    });

    test('T-SQL blocks are indented, strings and comments are kept', async () => {
        const script = "declare @n int = 0\nwhile @n < 2\nbegin\nset @n = @n + 1\nprint N'it''s ' + cast(@n as nvarchar(10)) /* keep */\nend\n\nbegin try\nselect 1/0\nend try\nbegin catch\nprint 'caught'\nend catch";
        const out = formatSql(script);
        expect(out).toBe(`DECLARE @n INT = 0
WHILE @n < 2
BEGIN
    SET @n = @n + 1
    PRINT N'it''s ' + CAST(@n AS NVARCHAR(10)) /* keep */
END

BEGIN TRY
    SELECT 1 / 0
END TRY
BEGIN CATCH
    PRINT 'caught'
END CATCH
`);
        const a = await open();
        const r = tsql(a, out);
        expect(r.error).toBeNull();
        expect(r.results.filter(x => x.kind === 'print').map(x => x.text)).toEqual(["it's 1", "it's 2", 'caught']);
    });

    test('UPDATE, DELETE, INSERT … VALUES, MERGE and CREATE TRIGGER', async () => {
        expect(formatSql("update Orders set Total = Total + 1, Note = 'x' where Id = 1; delete from Orders where Id = 9")).toBe("UPDATE Orders\nSET Total = Total + 1,\n    Note = 'x'\nWHERE Id = 1;\nDELETE FROM Orders\nWHERE Id = 9\n");
        expect(formatSql('insert into T (a, b) values (1, 2), (3, 4)')).toBe('INSERT INTO T (a, b)\nVALUES (1, 2),\n    (3, 4)\n');
        expect(formatSql('merge into T as t using S as s on t.id = s.id when matched then update set t.v = s.v when not matched then insert (id) values (s.id);'))
            .toBe('MERGE INTO T AS t\nUSING S AS s\n    ON t.id = s.id\nWHEN MATCHED THEN UPDATE SET t.v = s.v\nWHEN NOT MATCHED THEN INSERT (id)\nVALUES (s.id);\n');
        const trigger = formatSql('create trigger trg on Orders after insert, update as begin insert into Log (Id) select Id from inserted end');
        expect(trigger).toBe('CREATE TRIGGER trg ON Orders AFTER INSERT, UPDATE AS\nBEGIN\n    INSERT INTO Log (Id)\n    SELECT Id\n    FROM inserted\nEND\n');
        expect(formatSql('drop table if exists #t')).toBe('DROP TABLE IF EXISTS #t\n');
    });

    test('formatting twice changes nothing more', () => {
        for (const q of queries) expect(formatSql(formatSql(q))).toBe(formatSql(q));
    });
});

describe('estimated plan', () => {
    test('SQLite steps get SQL Server operator names', () => {
        expect(planOperator('SCAN Orders')).toBe('Table Scan');
        expect(planOperator('SEARCH Orders USING INTEGER PRIMARY KEY (rowid=?)')).toBe('Clustered Index Seek');
        expect(planOperator('SEARCH o USING INDEX ix_orders_customer (CustomerId=?)')).toBe('Index Seek');
        expect(planOperator('SCAN o USING COVERING INDEX ix_orders_customer')).toBe('Index Scan');
        expect(planOperator('USE TEMP B-TREE FOR ORDER BY')).toBe('Sort');
        expect(planOperator('USE TEMP B-TREE FOR GROUP BY')).toBe('Hash Match (Aggregate)');
        expect(planOperator('SCAN CONSTANT ROW')).toBe('Constant Scan');
        expect(planOperator('CORRELATED SCALAR SUBQUERY 1')).toBe('Compute Scalar (Subquery)');
    });

    test('explain reads the plan without running anything', async () => {
        const a = await open();
        const [scan, seek, index, bad] = a.explain([
            'SELECT * FROM Orders ORDER BY Note',
            'SELECT * FROM Customers WHERE Id = 2',
            'SELECT * FROM Orders WHERE CustomerId = @c',
            'SELECT * FROM Nope'
        ]);
        expect(planTree(scan.steps).map(n => n.operator)).toEqual(['Table Scan', 'Sort']);
        expect(planHints(scan.steps)[0]).toMatch(/^Orders is read in full/);
        expect(planTree(seek.steps)[0].operator).toBe('Clustered Index Seek');
        expect(planTree(index.steps)[0].operator).toBe('Index Seek');
        expect(bad.steps).toBeNull();
        expect(bad.error).toMatch(/no such table: Nope/);
        expect(a.explain(['DELETE FROM Orders'])[0].error).toBeNull();
        expect(grids(a.execute('SELECT COUNT(*) FROM Orders'))[0]).toEqual([[3]]);
    });

    test('children sit under their parent', () => {
        const tree = planTree([{ id: 2, parent: 0, detail: 'SCAN o' }, { id: 5, parent: 2, detail: 'CORRELATED SCALAR SUBQUERY 1' }, { id: 8, parent: 5, detail: 'SCAN c' }]);
        expect(tree).toHaveLength(1);
        expect(tree[0].children[0].children[0].detail).toBe('SCAN c');
    });

    test('the statements with a plan, as SQLite runs them', () => {
        const t = planStatements("DECLARE @c INT = 1\nIF @c > 0\nBEGIN\n  SELECT TOP 5 * FROM Orders WHERE CustomerId = @c\nEND\nCREATE TABLE X (a INT)\nMERGE INTO X USING Orders o ON 1 = 0 WHEN NOT MATCHED THEN INSERT (a) VALUES (o.Id);", 'sqlserver');
        expect(t).toHaveLength(2);
        expect(t[0].written).toBe('SELECT TOP 5 * FROM Orders WHERE CustomerId = @c');
        expect(t[0].sql).toMatch(/LIMIT 5/);
        expect(t[1].sql).toBeNull();
        expect(t[1].note).toMatch(/MERGE/);
        const lite = planStatements('CREATE TABLE y (a); SELECT * FROM y; UPDATE y SET a = 1', 'sqlite');
        expect(lite.map(s => s.sql)).toEqual(['SELECT * FROM y', 'UPDATE y SET a = 1']);
        expect(planStatements('SELECT * FROM t LIMIT 2', 'postgresql')[0].sql).toBe('SELECT * FROM t LIMIT 2');
    });
});

describe('results as text, CSV and JSON', () => {
    const r = { columns: ['Id', 'Name', 'Total'], rows: [[1, 'Asha', 50.5], [2, null, 1500], [3, 'a "q", b\nc', null]] };

    test('Results to Text: padded columns, dashes, then the row count', () => {
        expect(resultAsText({ columns: ['Id', 'Name'], rows: [[1, 'Asha'], [20, null]] })).toBe('Id Name\n-- ----\n 1 Asha\n20 NULL\n\n(2 rows affected)');
        expect(resultAsText({ columns: ['n'], rows: [[5]] })).toMatch(/\(1 row affected\)$/);
    });

    test('CSV quotes what needs quoting, NULL is empty', () => {
        expect(resultAsCsv(r)).toBe('Id,Name,Total\r\n1,Asha,50.5\r\n2,,1500\r\n3,"a ""q"", b\nc",\r\n');
    });

    test('tab-separated for the clipboard, JSON with an object per row', () => {
        expect(resultAsTsv(r)).toBe('Id\tName\tTotal\n1\tAsha\t50.5\n2\tNULL\t1500\n3\ta "q", b c\tNULL');
        expect(JSON.parse(resultAsJson(r))).toEqual([{ Id: 1, Name: 'Asha', Total: 50.5 }, { Id: 2, Name: null, Total: 1500 }, { Id: 3, Name: 'a "q", b\nc', Total: null }]);
        expect(JSON.parse(resultAsJson({ columns: ['b'], rows: [[{ blob: 4 }]] }))).toEqual([{ b: '0x… (4 bytes)' }]);
    });

    test('sorting: NULL first going up, numbers by value, text alphabetically, ties keep their order', () => {
        const rows = [[1, 'b', 10], [2, null, 9], [3, 'B', 100], [4, 'a', null]];
        expect(sortedRows(rows, 2, 'asc').map(x => x[0])).toEqual([4, 2, 1, 3]);
        expect(sortedRows(rows, 2, 'desc').map(x => x[0])).toEqual([3, 1, 2, 4]);
        expect(sortedRows(rows, 1, 'asc').map(x => x[0])).toEqual([2, 4, 1, 3]);
        expect(rows.map(x => x[0])).toEqual([1, 2, 3, 4]);
    });
});

describe('IntelliSense', () => {
    let objects;
    beforeAll(async () => {
        objects = (await open()).schema();
    });
    const labels = (text, caret = text.length, extra = {}) => completions({ text, caret, objects, language: 'sqlserver', ...extra }).items.map(i => i.label);

    test('aliases point at their tables', () => {
        const map = tableAliases('SELECT * FROM [dbo].[Orders] AS o LEFT JOIN Customers c ON c.Id = o.CustomerId WHERE', objects);
        expect(map.get('o')).toBe('Orders');
        expect(map.get('c')).toBe('Customers');
        expect(map.has('where')).toBe(false);
    });

    test('after "alias." the columns of its table', () => {
        const text = 'SELECT o. FROM Orders o';
        expect(labels(text, 'SELECT o.'.length)).toEqual(['CustomerId', 'Id', 'Note', 'Photo', 'Total']);
        expect(labels('SELECT o.To FROM Orders o', 'SELECT o.To'.length)).toEqual(['Total']);
        const found = completions({ text: 'SELECT o.To FROM Orders o', caret: 'SELECT o.To'.length, objects, language: 'sqlserver' });
        expect([found.from, found.to]).toEqual(['SELECT o.'.length, 'SELECT o.To'.length]);
    });

    test('after FROM tables and views first; elsewhere columns before keywords', () => {
        expect(labels('SELECT * FROM ', 14, { force: true }).slice(0, 3)).toEqual(['BigOrders', 'Customers', 'Orders']);
        expect(labels('SELECT * FROM Cu')).toEqual(['Customers']);
        expect(labels('SELECT Na FROM Customers', 'SELECT Na'.length)[0]).toBe('Name');
        expect(labels('SELECT N FROM Customers', 'SELECT N'.length)).toContain('NULLIF');
        expect(labels('SELECT dbo.')).toEqual(['BigOrders', 'Customers', 'Orders']);
    });

    test('variables declared in the script, nothing in strings or comments, nothing for a finished word', () => {
        expect(labels('DECLARE @total INT; SELECT @to')).toEqual(['@total']);
        expect(labels("SELECT 'Cu")).toEqual([]);
        expect(labels('-- Cu')).toEqual([]);
        expect(labels('SELECT')).toEqual([]);
    });

    test('names that need it are quoted', async () => {
        const a = await open('quoted', 'CREATE TABLE "Order Lines" ("Line No" INT)');
        const found = completions({ text: 'SELECT * FROM Ord', caret: 17, objects: a.schema(), language: 'sqlserver' });
        expect(found.items[0].insert).toBe('[Order Lines]');
    });
});
