// SQL Lab's T-SQL engine, Phase 2: stored procedures, functions, dynamic SQL,
// the INFORMATION_SCHEMA and sys. views and the system procedures.
import { beforeAll, describe, expect, test } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createSqliteAdapter } from '../src/db/sqlite-adapter.js';
import { createMemoryFiles } from '../src/db/files.js';
import { parseModule, parseParams } from '../src/db/tsql/modules.js';
import { fkName, pkName, typeInfo } from '../src/db/tsql/catalog.js';
import { translateForSqlite } from '../src/db/dialect-translate.js';

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

const run = (adapter, sql) => adapter.execute(sql, { language: 'sqlserver', databaseName: 'Shop' });
const grids = (r) => r.results.filter(x => x.columns.length).map(x => x.rows);
const prints = (r) => r.results.filter(x => x.kind === 'print').map(x => x.text);
function ok(adapter, sql) {
    const r = run(adapter, sql);
    expect(r.error).toBeNull();
    return r;
}

const GET_EMP = `CREATE PROCEDURE dbo.usp_GetEmp @Dept NVARCHAR(10), @Min INT = 0, @Count INT OUTPUT
AS
BEGIN
    SET NOCOUNT ON;
    SELECT Name, Salary FROM Emp WHERE Dept = @Dept AND Salary >= @Min ORDER BY Name;
    SELECT @Count = COUNT(*) FROM Emp WHERE Dept = @Dept;
    RETURN 7;
END`;

describe('reading definitions', () => {
    test('parameters: types, defaults, OUTPUT', () => {
        expect(parseParams("@a INT = 5, @b NVARCHAR(20) OUTPUT, @c DECIMAL(10, 2) = -1.5, @d VARCHAR(5) = 'x,y'")).toEqual([
            { name: '@a', type: 'INT', default: '5', output: false, readonly: false },
            { name: '@b', type: 'NVARCHAR(20)', default: null, output: true, readonly: false },
            { name: '@c', type: 'DECIMAL(10, 2)', default: '-1.5', output: false, readonly: false },
            { name: '@d', type: 'VARCHAR(5)', default: "'x,y'", output: false, readonly: false }
        ]);
    });

    test('procedures, scalar, inline and multi-statement functions', () => {
        const p = parseModule(GET_EMP);
        expect([p.kind, p.schema, p.name, p.params.length, p.action]).toEqual(['P', 'dbo', 'usp_GetEmp', 3, 'create']);
        expect(p.body.trim().startsWith('BEGIN')).toBe(true);
        const f = parseModule('CREATE OR ALTER FUNCTION [sales].[fn_Tax] (@x MONEY) RETURNS MONEY WITH SCHEMABINDING AS BEGIN RETURN @x * 0.2 END');
        expect([f.kind, f.schema, f.name, f.returns, f.action]).toEqual(['FN', 'sales', 'fn_Tax', 'MONEY', 'create or alter']);
        const i = parseModule('CREATE FUNCTION f(@d INT) RETURNS TABLE AS RETURN (SELECT * FROM t WHERE d = @d)');
        expect([i.kind, i.query]).toEqual(['IF', 'SELECT * FROM t WHERE d = @d']);
        const m = parseModule('ALTER FUNCTION f() RETURNS @r TABLE (n INT) AS BEGIN INSERT @r VALUES (1) RETURN END');
        expect([m.kind, m.table, m.action]).toEqual(['TF', { name: '@r', columns: 'n INT' }, 'alter']);
    });
});

describe('stored procedures', () => {
    test('EXEC with named and positional arguments, defaults, OUTPUT and the return code', async () => {
        const a = await open();
        ok(a, GET_EMP);
        const r = ok(a, `DECLARE @c INT, @rc INT;
EXEC @rc = dbo.usp_GetEmp @Dept = 'A', @Count = @c OUTPUT;
PRINT CONCAT('count=', @c, ' rc=', @rc);
EXEC usp_GetEmp 'B', 150, @c OUT
SELECT @c AS c`);
        expect(grids(r)).toEqual([[['Asha', 100], ['Chen', 200]], [['Ben', 200]], [[1]]]);
        expect(prints(r)).toEqual(['count=2 rc=7']);
        // Results inside the procedure belong to the EXEC's line
        expect(r.results[0].line).toBe(2);
    });

    test('procedures stay in the database between runs', async () => {
        const a = await open();
        ok(a, 'CREATE PROC p AS SELECT 42 AS answer');
        expect(grids(ok(a, 'EXEC p'))).toEqual([[[42]]]);
        expect(a.modules()).toEqual([{ name: 'p', schema: 'dbo', kind: 'P', params: [], returns: null }]);
        // The catalog table is hidden from the explorer
        expect(a.schema().map(o => o.name)).toEqual(['Emp']);
    });

    test('argument mistakes give SQL Server\'s errors', async () => {
        const a = await open();
        ok(a, GET_EMP);
        expect(run(a, 'EXEC usp_GetEmp').error.code).toBe('Msg 201, Level 16, State 1');
        expect(run(a, 'EXEC usp_GetEmp \'A\', 1, 2, 3').error.code).toMatch(/^Msg 8144/);
        expect(run(a, 'EXEC usp_GetEmp @Dept = \'A\', @Nope = 1').error.message).toBe('@Nope is not a parameter for procedure usp_GetEmp.');
        expect(run(a, 'EXEC usp_GetEmp @Dept = \'A\', 1').error.code).toMatch(/^Msg 119/);
        expect(run(a, 'EXEC nothere').error.message).toBe('Could not find stored procedure \'nothere\'.');
    });

    test('an error inside a procedure names it and its line; TRY … CATCH sees ERROR_PROCEDURE()', async () => {
        const a = await open();
        ok(a, 'CREATE PROC p_err AS\nBEGIN\n  PRINT \'before\'\n  SELECT 1/0\nEND');
        const r = run(a, 'PRINT 1\nEXEC p_err');
        expect(r.error.code).toBe('Msg 8134, Level 16, State 1, Procedure p_err, Line 4');
        expect(r.error.line).toBe(2);
        const caught = ok(a, 'BEGIN TRY EXEC p_err END TRY BEGIN CATCH SELECT ERROR_NUMBER(), ERROR_PROCEDURE(), ERROR_LINE() END CATCH');
        expect(grids(caught)).toEqual([[[8134, 'p_err', 4]]]);
    });

    test('CREATE, ALTER, CREATE OR ALTER and DROP follow SQL Server\'s rules', async () => {
        const a = await open();
        ok(a, 'CREATE PROC p AS SELECT 1 AS v');
        expect(run(a, 'CREATE PROC p AS SELECT 2').error.code).toMatch(/^Msg 2714/);
        expect(run(a, 'CREATE PROC Emp AS SELECT 2').error.code).toMatch(/^Msg 2714/);
        expect(run(a, 'ALTER PROC q AS SELECT 2').error.code).toMatch(/^Msg 208/);
        expect(run(a, 'SELECT 1\nCREATE PROC r AS SELECT 2').error.code).toMatch(/^Msg 111/);
        expect(grids(ok(a, 'ALTER PROCEDURE p AS SELECT 2 AS v\nGO\nEXEC p'))).toEqual([[[2]]]);
        expect(grids(ok(a, 'CREATE OR ALTER PROC p @x INT = 5 AS SELECT @x * 2\nGO\nEXEC p\nEXEC p 21'))).toEqual([[[10]], [[42]]]);
        expect(run(a, 'DROP PROCEDURE nothere').error.code).toMatch(/^Msg 3701/);
        ok(a, 'DROP PROCEDURE IF EXISTS p, nothere');
        expect(run(a, 'EXEC p').error.code).toMatch(/^Msg 2812/);
    });

    test('the drop-and-create pattern with OBJECT_ID', async () => {
        const a = await open();
        const script = "IF OBJECT_ID('dbo.p', 'P') IS NOT NULL DROP PROCEDURE dbo.p;\nGO\nCREATE PROCEDURE dbo.p AS SELECT 'v1' AS v;\nGO\nEXEC dbo.p";
        expect(grids(ok(a, script))).toEqual([[['v1']]]);
        expect(grids(ok(a, script))).toEqual([[['v1']]]);
    });

    test('#temp tables a procedure creates are dropped when it ends; @@NESTLEVEL and the nesting limit', async () => {
        const a = await open();
        ok(a, 'CREATE PROC p_tmp AS BEGIN CREATE TABLE #x (v INT); INSERT INTO #x VALUES (1); SELECT COUNT(*) FROM #x END');
        expect(grids(ok(a, 'EXEC p_tmp\nEXEC p_tmp'))).toEqual([[[1]], [[1]]]);
        ok(a, 'CREATE PROC p_rec @n INT AS BEGIN IF @n > 0 BEGIN DECLARE @m INT = @n - 1; EXEC p_rec @m END ELSE SELECT @@NESTLEVEL END');
        expect(grids(ok(a, 'EXEC p_rec 3'))).toEqual([[[4]]]);
        expect(run(a, 'EXEC p_rec 40').error.code).toMatch(/^Msg 217/);
    });

    test('a procedure\'s table variables don\'t touch the caller\'s', async () => {
        const a = await open();
        ok(a, 'CREATE PROC p AS BEGIN DECLARE @t TABLE (v INT); INSERT INTO @t VALUES (9); SELECT v FROM @t END');
        const r = ok(a, 'DECLARE @t TABLE (v INT); INSERT INTO @t VALUES (1); EXEC p; SELECT v FROM @t');
        expect(grids(r)).toEqual([[[9]], [[1]]]);
    });

    test('INSERT … EXEC puts a procedure\'s rows into a table', async () => {
        const a = await open();
        ok(a, GET_EMP);
        const r = ok(a, 'CREATE TABLE #r (Name NVARCHAR(20), Salary INT)\nDECLARE @c INT\nINSERT INTO #r EXEC usp_GetEmp \'A\', 0, @c OUTPUT\nSELECT * FROM #r');
        expect(grids(r)).toEqual([[['Asha', 100], ['Chen', 200]]]);
        expect(r.results.find(x => x.kind === 'modify' && x.sql.startsWith('INSERT')).rowsAffected).toBe(2);
    });
});

describe('dynamic SQL', () => {
    test('EXEC (…) and sp_executesql with parameters and OUTPUT', async () => {
        const a = await open();
        const r = ok(a, `DECLARE @t NVARCHAR(50) = 'Emp';
EXEC('SELECT COUNT(*) AS n FROM ' + @t);
DECLARE @sql NVARCHAR(MAX) = N'SELECT @n = COUNT(*) FROM Emp WHERE Dept = @d', @out INT;
EXEC sp_executesql @sql, N'@d NVARCHAR(10), @n INT OUTPUT', @d = 'A', @n = @out OUTPUT;
SELECT @out AS out`);
        expect(grids(r)).toEqual([[[3]], [[2]]]);
    });

    test('dynamic SQL has its own variables', async () => {
        const a = await open();
        const r = run(a, "DECLARE @x INT = 1; EXEC('SELECT @x')");
        expect(r.error.message).toBe('Must declare the scalar variable "@x".');
    });
});

describe('functions', () => {
    test('scalar functions in queries and expressions', async () => {
        const a = await open();
        ok(a, 'CREATE FUNCTION dbo.fn_Tax(@amount DECIMAL(10,2), @rate DECIMAL(5,2) = 0.1)\nRETURNS DECIMAL(10,2)\nAS\nBEGIN\n  DECLARE @t DECIMAL(10,2) = @amount * @rate;\n  RETURN @t;\nEND');
        const r = ok(a, 'SELECT Name, dbo.fn_Tax(Salary, 0.2) AS Tax FROM Emp ORDER BY Id\nDECLARE @x DECIMAL(10,2) = dbo.fn_Tax(50, 0.5)\nPRINT @x\nIF dbo.fn_Tax(10, 1) = 10 PRINT \'yes\'');
        expect(grids(r)).toEqual([[['Asha', 20], ['Ben', 40], ['Chen', 40]]]);
        expect(prints(r)).toEqual(['25', 'yes']);
        expect(run(a, 'SELECT dbo.fn_Tax(1, 2, 3)').error.code).toMatch(/^Msg 8144/);
    });

    test('an error inside a function stops the query with the function\'s name', async () => {
        const a = await open();
        ok(a, "CREATE FUNCTION dbo.fn_Check(@v INT) RETURNS INT AS BEGIN IF @v > 150 THROW 50001, 'too big', 1; RETURN @v; END");
        const r = run(a, 'SELECT dbo.fn_Check(Salary) FROM Emp');
        expect(r.error.message).toBe('too big');
        expect(r.error.code).toBe('Msg 50001, Level 16, State 1, Procedure fn_Check, Line 1');
    });

    test('functions can\'t change data, and must end with RETURN', async () => {
        const a = await open();
        expect(run(a, "CREATE FUNCTION dbo.f() RETURNS INT AS BEGIN INSERT INTO Emp (Name) VALUES ('x'); RETURN 1; END").error.code).toMatch(/^Msg 443/);
        expect(run(a, "CREATE FUNCTION dbo.f() RETURNS INT AS BEGIN PRINT 'x'; RETURN 1; END").error.code).toMatch(/^Msg 443/);
        expect(run(a, 'CREATE FUNCTION dbo.f() RETURNS INT AS BEGIN DECLARE @a INT = 1 END').error.code).toMatch(/^Msg 455/);
    });

    test('inline and multi-statement table-valued functions', async () => {
        const a = await open();
        ok(a, 'CREATE FUNCTION dbo.fn_ByDept(@d NVARCHAR(10)) RETURNS TABLE AS RETURN (SELECT Id, Name FROM Emp WHERE Dept = @d)');
        ok(a, 'CREATE FUNCTION dbo.fn_Nums(@n INT) RETURNS @r TABLE (n INT) AS BEGIN DECLARE @i INT = 1; WHILE @i <= @n BEGIN INSERT INTO @r VALUES (@i); SET @i += 1; END RETURN END');
        const r = ok(a, "SELECT * FROM dbo.fn_ByDept('A') ORDER BY Id\nSELECT f.Name FROM dbo.fn_ByDept('B') AS f\nDECLARE @k INT = 3\nSELECT n FROM dbo.fn_Nums(@k) ORDER BY n DESC");
        expect(grids(r)).toEqual([[[1, 'Asha'], [3, 'Chen']], [['Ben']], [[3], [2], [1]]]);
        expect(run(a, 'EXEC dbo.fn_Nums 2').error.code).toMatch(/^Msg 2809/);
    });
});

describe('the catalog', () => {
    test('INFORMATION_SCHEMA views', async () => {
        const a = await open();
        ok(a, 'CREATE TABLE Orders (OrderId INT IDENTITY(1,1) CONSTRAINT PK_Orders PRIMARY KEY, EmpId INT NOT NULL CONSTRAINT FK_Orders_Emp REFERENCES Emp(Id), Total DECIMAL(10,2), Code NVARCHAR(8))');
        ok(a, GET_EMP);
        const r = ok(a, `SELECT TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_NAME
SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, IS_NULLABLE FROM Shop.INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'Orders' ORDER BY ORDINAL_POSITION
SELECT CONSTRAINT_NAME, CONSTRAINT_TYPE FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE TABLE_NAME = 'Orders' ORDER BY 1
SELECT ROUTINE_NAME, ROUTINE_TYPE FROM INFORMATION_SCHEMA.ROUTINES`);
        expect(grids(r)).toEqual([
            [['Emp', 'BASE TABLE'], ['Orders', 'BASE TABLE']],
            [['OrderId', 'int', null, 10, 0, 'NO'], ['EmpId', 'int', null, 10, 0, 'NO'], ['Total', 'decimal', null, 10, 2, 'YES'], ['Code', 'nvarchar', 8, null, null, 'YES']],
            [['FK_Orders_Emp', 'FOREIGN KEY'], ['PK_Orders', 'PRIMARY KEY']],
            [['usp_GetEmp', 'PROCEDURE']]
        ]);
    });

    test('sys. views join the way SQL Server\'s do', async () => {
        const a = await open();
        ok(a, 'CREATE TABLE Orders (OrderId INT IDENTITY(1,1) PRIMARY KEY, EmpId INT REFERENCES Emp(Id))\nGO\nCREATE INDEX IX_Orders_Emp ON Orders (EmpId)\nGO\nCREATE PROC p AS SELECT 1');
        const r = ok(a, `SELECT t.name, c.name, ty.name, c.is_identity FROM sys.tables t JOIN sys.columns c ON c.object_id = t.object_id JOIN sys.types ty ON ty.user_type_id = c.user_type_id WHERE t.name = 'Orders' ORDER BY c.column_id
SELECT name, type, type_desc FROM sys.objects WHERE type IN ('U', 'P') ORDER BY name
SELECT OBJECT_NAME(fk.parent_object_id), OBJECT_NAME(fk.referenced_object_id) FROM sys.foreign_keys fk
SELECT name FROM sys.indexes WHERE object_id = OBJECT_ID('dbo.Orders') AND name = 'IX_Orders_Emp'
SELECT COUNT(*) FROM sys.procedures WHERE name = 'p'
SELECT name FROM sys.schemas WHERE schema_id = 1`);
        expect(grids(r)).toEqual([
            [['Orders', 'OrderId', 'int', 1], ['Orders', 'EmpId', 'int', 0]],
            [['Emp', 'U', 'USER_TABLE'], ['Orders', 'U', 'USER_TABLE'], ['p', 'P', 'SQL_STORED_PROCEDURE']],
            [['Orders', 'Emp']],
            [['IX_Orders_Emp']],
            [[1]],
            [['dbo']]
        ]);
    });

    test('object functions: OBJECT_ID, OBJECT_NAME, OBJECTPROPERTY, OBJECT_DEFINITION, COL_LENGTH', async () => {
        const a = await open();
        ok(a, 'CREATE FUNCTION dbo.f(@a INT) RETURNS INT AS BEGIN RETURN @a END');
        const r = ok(a, "SELECT OBJECT_NAME(OBJECT_ID('Emp')), OBJECTPROPERTY(OBJECT_ID('dbo.f'), 'IsScalarFunction'), OBJECT_ID('dbo.f', 'P'), COL_LENGTH('Emp', 'Id'), COL_LENGTH('Emp', 'Nope'), LEFT(OBJECT_DEFINITION(OBJECT_ID('dbo.f')), 15)");
        expect(grids(r)).toEqual([[['Emp', 1, null, 4, null, 'CREATE FUNCTION']]]);
    });

    test('sp_help, sp_helptext, sp_columns, sp_tables', async () => {
        const a = await open();
        ok(a, 'CREATE PROC dbo.p @x INT AS\nSELECT @x');
        const help = ok(a, 'EXEC sp_help\nEXEC sp_help Emp\nEXEC sp_help \'dbo.p\'');
        const [all, emp, cols] = grids(help);
        expect(all).toEqual([['Emp', 'dbo', 'user table'], ['p', 'dbo', 'stored procedure']]);
        expect(emp).toEqual([['Emp', 'dbo', 'user table', null]]);
        expect(cols.map(c => [c[0], c[1], c[6]])).toEqual([['Id', 'int', 'no'], ['Name', 'nvarchar', 'yes'], ['Salary', 'float', 'yes'], ['Dept', 'nvarchar', 'yes']]);
        expect(grids(help).at(-1)).toEqual([['@x', 'int', 4, 10, 0, 1, null]]);
        expect(grids(ok(a, "EXEC sp_helptext 'dbo.p'"))).toEqual([[['CREATE PROC dbo.p @x INT AS\r\n'], ['SELECT @x\r\n']]]);
        expect(grids(ok(a, 'EXEC sp_columns @table_name = Emp'))[0].map(c => c[3])).toEqual(['Id', 'Name', 'Salary', 'Dept']);
        expect(grids(ok(a, 'EXEC sp_tables'))).toEqual([[['Shop', 'dbo', 'Emp', 'TABLE', null]]]);
        expect(run(a, 'EXEC sp_help nothere').error.code).toMatch(/^Msg 15009/);
        expect(run(a, 'EXEC sp_helptext Emp').error.code).toMatch(/^Msg 15197/);
    });

    test('sp_rename renames tables, columns and procedures', async () => {
        const a = await open();
        ok(a, 'CREATE PROC p AS SELECT 1');
        const r = ok(a, "CREATE TABLE T1 (a INT)\nEXEC sp_rename 'T1', 'T2'\nEXEC sp_rename 'T2.a', 'b', 'COLUMN'\nEXEC sp_rename 'p', 'q'\nSELECT name FROM sys.columns WHERE object_id = OBJECT_ID('T2')\nEXEC q");
        expect(grids(r)).toEqual([[['b']], [[1]]]);
        expect(prints(r)[0]).toBe('Caution: Changing any part of an object name could break scripts and stored procedures.');
    });

    test('type and constraint names as SQL Server shows them', () => {
        expect(typeInfo('NVARCHAR(50)')).toMatchObject({ name: 'nvarchar', maxLength: 100, charLength: 50, display: 'nvarchar(50)' });
        expect(typeInfo('VARCHAR(MAX)')).toMatchObject({ maxLength: -1, display: 'varchar(max)' });
        expect(typeInfo('DECIMAL(10,2)')).toMatchObject({ precision: 10, scale: 2, maxLength: 9 });
        expect(typeInfo('TEXT')).toMatchObject({ name: 'nvarchar', maxLength: -1 });
        expect(pkName('CREATE TABLE t (id INT, CONSTRAINT [PK_t_id] PRIMARY KEY (id))', 't')).toBe('PK_t_id');
        expect(pkName('CREATE TABLE t (id INT PRIMARY KEY)', 't')).toBe('PK_t');
        const sql = 'CREATE TABLE o (a INT CONSTRAINT FK_one REFERENCES x(id), b INT REFERENCES y(id), CONSTRAINT FK_three FOREIGN KEY (c) REFERENCES z(id))';
        // SQLite numbers keys last-declared first
        expect([fkName(sql, 'o', 'z', 0, 3), fkName(sql, 'o', 'y', 1, 3), fkName(sql, 'o', 'x', 2, 3)]).toEqual(['FK_three', 'FK_o_y_2', 'FK_one']);
    });
});

describe('translation', () => {
    test('JOIN … ON keeps a table alias (only CREATE INDEX … ON drops a schema)', () => {
        expect(translateForSqlite('SELECT 1 FROM a t JOIN b c ON c.id = t.id', 'sqlserver').sql).toBe('SELECT 1 FROM a t JOIN b c ON c.id = t.id');
        expect(translateForSqlite('SELECT 1 FROM a JOIN b ON dbo.a.id = b.id', 'sqlserver').sql).toBe('SELECT 1 FROM a JOIN b ON a.id = b.id');
        expect(translateForSqlite('CREATE INDEX i ON sales.T (x)', 'sqlserver').sql).toBe('CREATE INDEX i ON T (x)');
        expect(translateForSqlite('SELECT * FROM Shop.dbo.a', 'sqlserver').sql).toBe('SELECT * FROM a');
    });
});
