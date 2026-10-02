// The SQLite engine adapter, run against the real SQLite (the same build the
// browser uses, in its Node flavour) with in-memory files.
import { beforeAll, describe, expect, test } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createSqliteAdapter, statementKind, cleanMessage } from '../src/db/sqlite-adapter.js';
import { createMemoryFiles, isSqliteFile } from '../src/db/files.js';
import { positionAt, isDatabaseId } from '../src/db/engine.js';

let sqlite3;
beforeAll(async () => {
    sqlite3 = await sqlite3InitModule();
});

const setup = () => {
    const files = createMemoryFiles(sqlite3);
    let clock = 0;
    const adapter = createSqliteAdapter(sqlite3, files, { now: () => (clock += 2) });
    return { files, adapter };
};

const COMPANY = `
CREATE TABLE Departments (DepartmentID INTEGER PRIMARY KEY, Name TEXT NOT NULL);
CREATE TABLE Employees (
    EmployeeID INTEGER PRIMARY KEY,
    Name TEXT NOT NULL,
    Department TEXT,
    DepartmentID INTEGER REFERENCES Departments(DepartmentID),
    Salary NUMERIC
);
INSERT INTO Departments (DepartmentID, Name) VALUES (1, 'Engineering'), (2, 'Sales');
INSERT INTO Employees (Name, Department, DepartmentID, Salary) VALUES
    ('Ada', 'Engineering', 1, 120000),
    ('Grace', 'Engineering', 1, 100000),
    ('Linus', 'Sales', 2, 70000),
    ('Margaret', 'Sales', 2, 90000);
`;

describe('statements', () => {
    test('kinds come from the first keyword, after comments', () => {
        expect(statementKind('select 1')).toBe('query');
        expect(statementKind('-- note\n/* more */ INSERT INTO t VALUES (1)')).toBe('modify');
        expect(statementKind('create table t (a)')).toBe('schema');
        expect(statementKind('BEGIN')).toBe('transaction');
        expect(statementKind('WITH x AS (SELECT 1) SELECT * FROM x')).toBe('with');
        expect(statementKind('VACUUM')).toBe('other');
    });

    test('engine messages lose the result-code prefix', () => {
        expect(cleanMessage('SQLITE_ERROR: sqlite3 result code 1: no such table: x')).toEqual({ message: 'no such table: x', code: 'SQLITE_ERROR' });
        expect(cleanMessage('plain')).toEqual({ message: 'plain', code: 'ERROR' });
    });

    test('positions count lines and characters, not bytes', () => {
        const bytes = new TextEncoder().encode('SELECT 1;\nSELECT \'é\', x');
        expect(positionAt(bytes, bytes.length - 1)).toEqual({ line: 2, column: 13 });
        expect(positionAt(bytes, 0)).toEqual({ line: 1, column: 1 });
    });

    test('database ids are checked before reaching storage', () => {
        expect(isDatabaseId('abc123')).toBe(true);
        expect(isDatabaseId('mg3k2x1a-1abc2def3gh')).toBe(true);
        for (const id of ['', '../x', 'ABC', 'a', 'x'.repeat(41), 7, null]) expect(isDatabaseId(id)).toBe(false);
    });
});

describe('SQLite adapter', () => {
    test('reports the engine and version', () => {
        const { adapter } = setup();
        expect(adapter.info()).toMatchObject({ engine: 'SQLite', version: sqlite3.version.libVersion, persistent: false, open: null });
    });

    test('the success scenario: create, fill, aggregate', async () => {
        const { adapter } = setup();
        await adapter.create('company1');
        expect(adapter.info().open).toBe('company1');
        const setupRun = adapter.execute(COMPANY);
        expect(setupRun.error).toBeNull();
        expect(setupRun.results.map(r => r.kind)).toEqual(['schema', 'schema', 'modify', 'modify']);
        expect(setupRun.results[2].rowsAffected).toBe(2);
        expect(setupRun.results[3].rowsAffected).toBe(4);
        expect(setupRun.results[0].rowsAffected).toBeNull();

        const run = adapter.execute('SELECT Department, AVG(Salary) AS AvgSalary FROM Employees GROUP BY Department ORDER BY AvgSalary DESC;');
        expect(run.error).toBeNull();
        expect(run.results).toHaveLength(1);
        const [result] = run.results;
        expect(result.kind).toBe('query');
        expect(result.columns).toEqual(['Department', 'AvgSalary']);
        expect(result.rows).toEqual([['Engineering', 110000], ['Sales', 80000]]);
        expect(result.more).toBe(false);
        expect(result.rowsAffected).toBeNull();
        expect(result.durationMs).toBe(2);
    });

    test('data survives closing and reopening', async () => {
        const { adapter } = setup();
        await adapter.create('company1');
        adapter.execute(COMPANY);
        adapter.close();
        expect(adapter.info().open).toBeNull();
        await adapter.open('company1');
        expect(adapter.execute('SELECT COUNT(*) FROM Employees').results[0].rows).toEqual([[4]]);
    });

    test('a fresh adapter on the same files sees the data (like a reload)', async () => {
        const { adapter, files } = setup();
        await adapter.create('company1');
        adapter.execute(COMPANY);
        const again = createSqliteAdapter(sqlite3, files);
        await again.open('company1');
        expect(again.execute('SELECT Name FROM Departments ORDER BY 1').results[0].rows).toEqual([['Engineering'], ['Sales']]);
    });

    test('databases are separate', async () => {
        const { adapter } = setup();
        await adapter.create('first1');
        adapter.execute('CREATE TABLE A (x); INSERT INTO A VALUES (1);');
        await adapter.create('second1');
        expect(adapter.schema()).toEqual([]);
        await adapter.open('first1');
        expect(adapter.schema().map(t => t.name)).toEqual(['A']);
    });

    test('create refuses an id that exists; open refuses one that does not', async () => {
        const { adapter } = setup();
        await adapter.create('company1');
        await expect(adapter.create('company1')).rejects.toMatchObject({ code: 'EXISTS' });
        await expect(adapter.open('nothere')).rejects.toMatchObject({ code: 'MISSING' });
        await expect(adapter.create('../evil')).rejects.toMatchObject({ code: 'BAD_ID' });
    });

    test('remove deletes the data; removeAll deletes every database', async () => {
        const { adapter, files } = setup();
        await adapter.create('first1');
        await adapter.create('second1');
        adapter.remove('second1');
        expect(adapter.info().open).toBeNull();
        expect(files.names()).toEqual(['db-first1.sqlite3']);
        files.write('unrelated', new Uint8Array(1));
        adapter.removeAll();
        expect(files.names()).toEqual(['unrelated']);
    });

    test('duplicate copies the data, including unsaved-to-file changes of the open database', async () => {
        const { adapter } = setup();
        await adapter.create('first1');
        adapter.execute('CREATE TABLE A (x); INSERT INTO A VALUES (42);');
        await adapter.duplicate('first1', 'copy1');
        adapter.execute('INSERT INTO A VALUES (43);');
        await adapter.open('copy1');
        expect(adapter.execute('SELECT x FROM A').results[0].rows).toEqual([[42]]);
        await expect(adapter.duplicate('first1', 'copy1')).rejects.toMatchObject({ code: 'EXISTS' });
    });

    test('export gives a standard SQLite file that imports back', async () => {
        const { adapter } = setup();
        await adapter.create('first1');
        adapter.execute('CREATE TABLE A (x TEXT); INSERT INTO A VALUES (\'kept\');');
        const bytes = adapter.exportFile('first1');
        expect(isSqliteFile(bytes)).toBe(true);
        await adapter.importFile('import1', bytes);
        await adapter.open('import1');
        expect(adapter.execute('SELECT x FROM A').results[0].rows).toEqual([['kept']]);
        await expect(adapter.importFile('bad1', new TextEncoder().encode('not a database'.repeat(10)))).rejects.toMatchObject({ code: 'NOT_A_DATABASE' });
    });

    test('a statement can use a table created earlier in the same script', async () => {
        const { adapter } = setup();
        await adapter.create('first1');
        const run = adapter.execute('CREATE TABLE T (a); INSERT INTO T VALUES (1), (2); SELECT SUM(a) AS total FROM T;');
        expect(run.error).toBeNull();
        expect(run.results.at(-1).rows).toEqual([[3]]);
    });

    test('a script stops at the first error, which says where', async () => {
        const { adapter } = setup();
        await adapter.create('first1');
        const run = adapter.execute('CREATE TABLE T (a);\nINSERT INTO T VALUES (1);\nSELECT nope FROM T;\nINSERT INTO T VALUES (2);');
        expect(run.results).toHaveLength(2);
        expect(run.error).toMatchObject({ statement: 2, line: 3, code: 'SQLITE_ERROR' });
        expect(run.error.message).toBe('no such column: nope');
        expect(run.error.column).toBe(8);
        // Statements before the error ran and stay; the one after did not run
        expect(adapter.execute('SELECT COUNT(*) FROM T').results[0].rows).toEqual([[1]]);
    });

    test('syntax errors and missing tables are reported, not thrown', async () => {
        const { adapter } = setup();
        await adapter.create('first1');
        expect(adapter.execute('SELEC 1').error).toMatchObject({ statement: 0, line: 1, column: 1 });
        expect(adapter.execute('  SELECT * FROM Missing').error.message).toBe('no such table: Missing');
    });

    test('runtime errors (constraints) point at their statement', async () => {
        const { adapter } = setup();
        await adapter.create('first1');
        adapter.execute(COMPANY);
        const run = adapter.execute('INSERT INTO Departments VALUES (3, \'Ops\');\n  INSERT INTO Employees (Name, DepartmentID) VALUES (\'Bad\', 99);');
        expect(run.results).toHaveLength(1);
        expect(run.error).toMatchObject({ statement: 1, line: 2, column: 3, code: 'SQLITE_CONSTRAINT_FOREIGNKEY' });
        expect(run.error.message).toMatch(/FOREIGN KEY constraint failed/);
    });

    test('NOT NULL is enforced', async () => {
        const { adapter } = setup();
        await adapter.create('first1');
        adapter.execute(COMPANY);
        expect(adapter.execute('INSERT INTO Employees (Name) VALUES (NULL)').error.message).toMatch(/NOT NULL constraint failed: Employees.Name/);
    });

    test('UPDATE and DELETE report the rows they changed; WITH ... DELETE counts as a change', async () => {
        const { adapter } = setup();
        await adapter.create('first1');
        adapter.execute(COMPANY);
        expect(adapter.execute('UPDATE Employees SET Salary = Salary + 1 WHERE Department = \'Sales\'').results[0].rowsAffected).toBe(2);
        expect(adapter.execute('UPDATE Employees SET Salary = 0 WHERE 1 = 0').results[0].rowsAffected).toBe(0);
        const del = adapter.execute('WITH low AS (SELECT EmployeeID FROM Employees WHERE Salary < 80000) DELETE FROM Employees WHERE EmployeeID IN (SELECT EmployeeID FROM low)');
        expect(del.results[0]).toMatchObject({ kind: 'modify', rowsAffected: 1 });
        const sel = adapter.execute('WITH x AS (SELECT 1 AS a) SELECT a FROM x');
        expect(sel.results[0]).toMatchObject({ kind: 'query', rows: [[1]], rowsAffected: null });
    });

    test('RETURNING rows come back with the count', async () => {
        const { adapter } = setup();
        await adapter.create('first1');
        adapter.execute('CREATE TABLE T (id INTEGER PRIMARY KEY, a)');
        const run = adapter.execute('INSERT INTO T (a) VALUES (\'x\'), (\'y\') RETURNING id', { pageSize: 1 });
        expect(run.results[0]).toMatchObject({ kind: 'modify', rows: [[1]], more: true, cursor: null, rowsAffected: 2 });
    });

    test('large results come a page at a time', async () => {
        const { adapter } = setup();
        await adapter.create('first1');
        const run = adapter.execute('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 250) SELECT i FROM n', { pageSize: 100 });
        const first = run.results[0];
        expect(first.rows).toHaveLength(100);
        expect(first.more).toBe(true);
        const second = adapter.fetchPage(first.cursor, { pageSize: 100 });
        expect(second.rows[0]).toEqual([101]);
        expect(second.more).toBe(true);
        const third = adapter.fetchPage(second.cursor, { pageSize: 100 });
        expect(third.rows).toHaveLength(50);
        expect(third.rows.at(-1)).toEqual([250]);
        expect(third.more).toBe(false);
        expect(() => adapter.fetchPage(first.cursor)).toThrow(/no longer available/);
    });

    test('exactly a page of rows has no next page', async () => {
        const { adapter } = setup();
        await adapter.create('first1');
        const run = adapter.execute('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10) SELECT i FROM n', { pageSize: 10 });
        expect(run.results[0]).toMatchObject({ more: false, cursor: null });
    });

    test('only the last statement keeps a cursor; running again drops it', async () => {
        const { adapter } = setup();
        await adapter.create('first1');
        const many = 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5) SELECT i FROM n';
        const run = adapter.execute(`${many}; ${many};`, { pageSize: 2 });
        expect(run.results[0]).toMatchObject({ more: true, cursor: null });
        expect(run.results[1].cursor).not.toBeNull();
        adapter.execute('SELECT 1');
        expect(() => adapter.fetchPage(run.results[1].cursor)).toThrow(/no longer available/);
    });

    test('transactions: inTransaction is reported; ROLLBACK undoes; closing rolls back', async () => {
        const { adapter } = setup();
        await adapter.create('first1');
        adapter.execute('CREATE TABLE T (a)');
        let run = adapter.execute('BEGIN; INSERT INTO T VALUES (1);');
        expect(run.inTransaction).toBe(true);
        expect(adapter.info().inTransaction).toBe(true);
        run = adapter.execute('ROLLBACK;');
        expect(run.inTransaction).toBe(false);
        expect(adapter.execute('SELECT COUNT(*) FROM T').results[0].rows).toEqual([[0]]);
        adapter.execute('BEGIN; INSERT INTO T VALUES (2);');
        adapter.close();
        await adapter.open('first1');
        expect(adapter.execute('SELECT COUNT(*) FROM T').results[0].rows).toEqual([[0]]);
    });

    test('empty input, comments and lone semicolons run nothing', async () => {
        const { adapter } = setup();
        await adapter.create('first1');
        for (const sql of ['', '   ', '-- just a comment', ';;', '/* x */ ;']) {
            expect(adapter.execute(sql)).toEqual({ results: [], error: null, inTransaction: false });
        }
        const run = adapter.execute('SELECT 1; -- trailing comment');
        expect(run.results).toHaveLength(1);
    });

    test('statements with semicolons inside strings and comments split correctly', async () => {
        const { adapter } = setup();
        await adapter.create('first1');
        const run = adapter.execute('SELECT \'a;b\' AS x; /* ; */ SELECT "c;d" AS "y;z" FROM (SELECT 1 AS "c;d");');
        expect(run.error).toBeNull();
        expect(run.results.map(r => r.rows)).toEqual([[['a;b']], [[1]]]);
        expect(run.results[1].columns).toEqual(['y;z']);
    });

    test('values: NULL, numbers, text and BLOBs (shown by size)', async () => {
        const { adapter } = setup();
        await adapter.create('first1');
        const run = adapter.execute('SELECT NULL, 1, 2.5, \'é\', X\'0102\'');
        expect(run.results[0].rows).toEqual([[null, 1, 2.5, 'é', { blob: 2 }]]);
    });

    test('no database open: execute and schema say so', () => {
        const { adapter } = setup();
        expect(() => adapter.execute('SELECT 1')).toThrow(/No database is open/);
        expect(() => adapter.schema()).toThrow(/No database is open/);
    });

    test('schema lists tables and views with columns and keys', async () => {
        const { adapter } = setup();
        await adapter.create('first1');
        adapter.execute(`${COMPANY}
            CREATE VIEW HighEarners AS SELECT Name FROM Employees WHERE Salary > 95000;
            CREATE TABLE Pairs (a INTEGER, b INTEGER, label TEXT DEFAULT 'x', PRIMARY KEY (b, a));`);
        const schema = adapter.schema();
        expect(schema.map(o => [o.name, o.type])).toEqual([['Departments', 'table'], ['Employees', 'table'], ['HighEarners', 'view'], ['Pairs', 'table']]);
        const employees = schema.find(o => o.name === 'Employees');
        expect(employees.columns.map(c => c.name)).toEqual(['EmployeeID', 'Name', 'Department', 'DepartmentID', 'Salary']);
        expect(employees.columns[1]).toMatchObject({ type: 'TEXT', notNull: true, primaryKey: false });
        expect(employees.primaryKey).toEqual(['EmployeeID']);
        expect(employees.foreignKeys).toEqual([{ columns: ['DepartmentID'], refTable: 'Departments', refColumns: ['DepartmentID'] }]);
        const pairs = schema.find(o => o.name === 'Pairs');
        expect(pairs.primaryKey).toEqual(['b', 'a']);
        expect(pairs.columns[2].defaultValue).toBe("'x'");
        expect(schema.find(o => o.name === 'HighEarners').columns.map(c => c.name)).toEqual(['Name']);
    });

    test('foreign keys are on for every opened database', async () => {
        const { adapter } = setup();
        await adapter.create('first1');
        expect(adapter.execute('PRAGMA foreign_keys').results[0].rows).toEqual([[1]]);
        adapter.close();
        await adapter.open('first1');
        expect(adapter.execute('PRAGMA foreign_keys').results[0].rows).toEqual([[1]]);
    });
});
