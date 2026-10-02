// SQL Lab imports: reading CSV, JSON and SQL scripts for the preview, and
// running them against the real SQLite (in-memory files) in one transaction.
import { beforeAll, describe, expect, test } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createSqliteAdapter } from '../src/db/sqlite-adapter.js';
import { createMemoryFiles } from '../src/db/files.js';
import { parseCsv, detectDelimiter } from '../src/db/import-csv.js';
import { parseJsonRows } from '../src/db/import-json.js';
import { fitsType, describeColumns, uniqueNames, createTableSql, insertSql } from '../src/db/import-types.js';
import { readScript, runnableScript, groupStatements } from '../src/db/import-sql.js';
import { detectFormat, previewImport, runImport, tableNameFor, unreadableFile, decodeText, textEncoding, maxFileBytes, MAX_IMPORT_BYTES } from '../src/db/importer.js';
import { dispatch } from '../src/db/dispatch.js';

let sqlite3;
beforeAll(async () => {
    sqlite3 = await sqlite3InitModule();
});

const setup = async () => {
    const files = createMemoryFiles(sqlite3);
    const adapter = createSqliteAdapter(sqlite3, files);
    await adapter.create('test-db-1');
    const rows = (sql) => adapter.execute(sql).results.at(-1).rows;
    return { files, adapter, rows };
};

const EMPLOYEES_CSV = `EmployeeID,Name,Department,Salary,HireDate
1,Ada,Engineering,120000,2019-03-04
2,Grace,Engineering,100000.50,2020-11-30
3,"Linus, Jr.",Sales,70000,2021-01-15
4,Margaret,Sales,90000,
`;

describe('CSV', () => {
    test('reads quoted fields, doubled quotes, line breaks in quotes and CRLF', () => {
        const { rows, lines } = parseCsv('a,b\r\n"x, y","say ""hi"""\r\n"two\nlines",z\r\n');
        expect(rows).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['two\nlines', 'z']]);
        expect(lines).toEqual([1, 2, 3]);
    });

    test('an unquoted empty field is null, a quoted one is empty text; blank lines are skipped', () => {
        expect(parseCsv('a,b,c\n\n,"",x\n').rows).toEqual([['a', 'b', 'c'], [null, '', 'x']]);
        expect(parseCsv('a,b,\n').rows).toEqual([['a', 'b', null]]);
    });

    test('a byte-order mark is ignored', () => {
        expect(parseCsv('﻿id,name\n1,Ada').rows[0]).toEqual(['id', 'name']);
    });

    test('an unclosed quote is refused with its row and line', () => {
        expect(() => parseCsv('a,b\n1,2\n3,"oops\n4,5\n')).toThrow(/Row 3: a quote opened on line 3 is never closed/);
    });

    test('text after a closing quote is refused', () => {
        expect(() => parseCsv('a\n"x"y\n')).toThrow(/Row 2 \(line 2\): there is text after a closing quote/);
    });

    test('the delimiter is detected from the first lines, outside quotes', () => {
        expect(detectDelimiter('a;b;c\n1;2;3\n')).toBe(';');
        expect(detectDelimiter('a\tb\n1\t2\n')).toBe('\t');
        expect(detectDelimiter('a|b\n"x,y,z"|2\n')).toBe('|');
        expect(detectDelimiter('name,note\nAda,"a;b;c;d"\n')).toBe(',');
        expect(detectDelimiter('just one column\n')).toBe(',');
    });
});

describe('JSON', () => {
    test('an array of objects: columns are every key in first-seen order', () => {
        const r = parseJsonRows('[{"id": 1, "name": "Ada"}, {"name": "Grace", "active": true, "tags": ["a"], "extra": null}]');
        expect(r.columns).toEqual(['id', 'name', 'active', 'tags', 'extra']);
        expect(r.rows).toEqual([[1, 'Ada', null, null, null], [null, 'Grace', true, '["a"]', null]]);
        expect(r.nested).toBe(1);
    });

    test('JSON Lines and an object holding one list are read too', () => {
        const lines = parseJsonRows('{"a": 1}\n\n{"a": 2}\n');
        expect(lines.rows).toEqual([[1], [2]]);
        expect(lines.lines).toEqual([1, 3]);
        const wrapped = parseJsonRows('{"employees": [{"a": 1}]}');
        expect(wrapped.from).toBe('employees');
        expect(wrapped.rows).toEqual([[1]]);
    });

    test('keys that differ only in case become separate columns', () => {
        expect(parseJsonRows('[{"Name": 1, "name": 2}]').columns).toEqual(['Name', 'name_2']);
    });

    test('whole numbers too large for JavaScript keep their digits', () => {
        const r = parseJsonRows('[{"big": 9223372036854775807, "small": 5}]');
        expect(r.rows[0]).toEqual(['9223372036854775807', 5]);
    });

    test('malformed JSON and items that aren\'t objects are refused, saying where', () => {
        expect(() => parseJsonRows('[{"a": 1},\n {"a": }]')).toThrow('This JSON can\'t be read: a value is expected, but there is "}" (line 2, column 8).');
        expect(() => parseJsonRows('[{"a": "x}]')).toThrow(/text in double quotes is never closed \(line 1, column 8\)/);
        expect(() => parseJsonRows("[{'a': 1}]")).toThrow(/a property name in double quotes is expected/);
        expect(() => parseJsonRows('[{"a": 1},]')).toThrow(/a value is expected, but there is "]" \(line 1, column 11\)/);
        expect(() => parseJsonRows('[{"a": 1}, 5]')).toThrow(/Item 2 is number, not an object/);
        expect(() => parseJsonRows('{"a": 1}\n{"a": oops}')).toThrow(/line 2/);
        expect(() => parseJsonRows('[]')).toThrow(/empty/);
        expect(() => parseJsonRows('id,name')).toThrow(/list of objects/);
    });
});

describe('column types', () => {
    test('values fit the types they look like', () => {
        expect(fitsType('42', 'INTEGER')).toBe(true);
        expect(fitsType('007', 'INTEGER')).toBe(false); // a code: kept as text
        expect(fitsType('9223372036854775808', 'INTEGER')).toBe(false);
        expect(fitsType('1.5e3', 'REAL')).toBe(true);
        expect(fitsType(' 42', 'INTEGER')).toBe(false);
        expect(fitsType('2024-02-29', 'DATE')).toBe(true);
        expect(fitsType('2023-02-29', 'DATE')).toBe(false);
        expect(fitsType('2024-01-31T09:30:00Z', 'DATETIME')).toBe(true);
        expect(fitsType('2024-01-31', 'DATETIME')).toBe(true);
        expect(fitsType(true, 'BOOLEAN')).toBe(true);
        expect(fitsType('true', 'BOOLEAN')).toBe(false);
        expect(fitsType(3, 'INTEGER')).toBe(true);
        expect(fitsType(3.5, 'INTEGER')).toBe(false);
    });

    test('each column gets the narrowest type all its values fit', () => {
        const cols = describeColumns([['1', '1.5', 'x', '2024-01-01', null, true], ['2', '2', 'y', '2024-01-02 10:00', null, false]], 6);
        expect(cols.map(c => c.type)).toEqual(['INTEGER', 'REAL', 'TEXT', 'DATETIME', 'TEXT', 'BOOLEAN']);
        expect(cols[1].fits).toMatchObject({ INTEGER: 1, REAL: 2, TEXT: 2 });
        expect(cols[4].nonEmpty).toBe(0);
    });

    test('names are made unique (ignoring case) and blanks are named', () => {
        expect(uniqueNames(['id', 'ID', '', 'id'])).toEqual(['id', 'ID_2', 'column3', 'id_3']);
    });

    test('the SQL quotes names and binds every value', () => {
        expect(createTableSql('Order Items', [{ name: 'order', type: 'INTEGER' }, { name: 'Name', type: 'TEXT' }]))
            .toBe('CREATE TABLE "Order Items" (\n    "order" INTEGER,\n    Name TEXT\n);');
        expect(insertSql('t', ['a', 'select'])).toBe('INSERT INTO t (a, "select") VALUES (?, ?);');
    });
});

describe('reading a SQL script', () => {
    test('statements are named, with rows of values counted and positions given', () => {
        const { statements, problem } = readScript(`-- Company
CREATE TABLE IF NOT EXISTS Employees (id INTEGER PRIMARY KEY, name TEXT);
INSERT INTO Employees (id, name) VALUES (1, 'Ada; Lovelace'), (2, 'Grace')
    ON CONFLICT (id) DO NOTHING;
UPDATE Employees SET name = 'x' WHERE id = 1;
SELECT * FROM Employees;`);
        expect(problem).toBeNull();
        expect(statements.map(s => s.label)).toEqual(['CREATE TABLE Employees', 'INSERT INTO Employees', 'UPDATE Employees', 'SELECT']);
        expect(statements[0]).toMatchObject({ line: 2, column: 1, ifNotExists: true, object: 'Employees', kind: 'schema' });
        expect(statements[1]).toMatchObject({ rows: 2, kind: 'modify', line: 3 });
        expect(statements[2].rows).toBeNull();
    });

    test('a trigger\'s body (with CASE … END) stays one statement', () => {
        const { statements } = readScript(`CREATE TRIGGER t AFTER INSERT ON a BEGIN
  UPDATE b SET n = CASE WHEN n > 0 THEN n + 1 ELSE 1 END;
  INSERT INTO log VALUES (1);
END;
SELECT 1;`);
        expect(statements.map(s => s.label)).toEqual(['CREATE TRIGGER t', 'SELECT']);
    });

    test('BEGIN / COMMIT are left out and GO ends a statement, keeping line numbers', () => {
        const text = 'BEGIN TRANSACTION;\nCREATE TABLE a (x INT)\nGO\nINSERT INTO a VALUES (1);\nCOMMIT;\n';
        const { statements, notes } = readScript(text);
        expect(statements.map(s => [s.label, s.skip])).toEqual([
            ['BEGIN TRANSACTION', 'transaction'], ['CREATE TABLE a', null], ['GO', 'separator'], ['INSERT INTO a', null], ['COMMIT', 'transaction']]);
        expect(notes.join(' ')).toMatch(/BEGIN and COMMIT statements are left out/);
        expect(notes.join(' ')).toMatch(/GO lines/);
        const runnable = runnableScript(text, statements);
        expect(runnable.length).toBe(text.length);
        expect(runnable.split('\n').map(l => l.trim())).toEqual(['', 'CREATE TABLE a (x INT)', ';', 'INSERT INTO a VALUES (1);', '', '']);
    });

    test('what SQLite can\'t run is flagged with line and column', () => {
        const { statements } = readScript(`SELECT TOP 5 * FROM t;
CREATE TABLE dbo.People (id INT IDENTITY(1,1), name NVARCHAR(MAX)) ;
CREATE TABLE m (id INT AUTO_INCREMENT) ENGINE=InnoDB;
INSERT INTO m VALUES (1) ON DUPLICATE KEY UPDATE id = 1;
SET NOCOUNT ON;
SELECT x::int FROM t WHERE y ILIKE 'a' OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY;
TRUNCATE TABLE m;`);
        const messages = statements.map(s => s.issues.map(i => `${i.line}:${i.column} ${i.message.split(/[.:;]/)[0]}`));
        expect(messages[0]).toEqual(['1:8 SQLite has no TOP']);
        expect(messages[1]).toEqual(['2:14 SQLite has no schemas, so dbo', '2:33 IDENTITY is SQL Server', '2:62 (MAX) sizes are SQL Server']);
        expect(messages[2].map(m => m.split(' ')[1])).toEqual(['AUTO_INCREMENT', 'Table']);
        expect(messages[3]).toEqual(['4:26 ON DUPLICATE KEY UPDATE is MySQL']);
        expect(messages[4][0]).toMatch(/^5:1 SET isn't a SQLite statement/);
        expect(statements[5].issues.map(i => i.message.split(' ').slice(0, 2).join(' '))).toEqual(['The ::', 'ILIKE is', 'OFFSET …']);
        expect(messages[6][0]).toMatch(/^7:1 SQLite has no TRUNCATE/);
    });

    test('functions SQLite doesn\'t have are flagged when called, not as names', () => {
        const { statements } = readScript('SELECT GETDATE(), LEN (name), t.year, year FROM t WHERE YEAR(d) = 2024;');
        expect(statements[0].issues.map(i => `${i.column} ${i.message}`)).toEqual([
            '8 SQLite has no GETDATE() function. Use CURRENT_TIMESTAMP or datetime(\'now\').',
            '19 SQLite has no LEN() function. Use length().',
            '57 SQLite has no YEAR() function. Use strftime(\'%Y\', value).']);
    });

    test('an unclosed quote or comment stops the preview, saying where', () => {
        expect(readScript("SELECT 1;\nINSERT INTO t VALUES ('oops);").problem).toMatchObject({ line: 2, column: 23 });
        expect(readScript('SELECT 1; /* never closed').problem.message).toMatch(/A \/\* comment opened on line 1, column 11/);
    });

    test('consecutive statements with the same label are grouped', () => {
        const { statements } = readScript('CREATE TABLE a (x);\nINSERT INTO a VALUES (1);\nINSERT INTO a VALUES (2),(3);\nINSERT INTO b SELECT 1;');
        const { groups } = groupStatements(statements);
        expect(groups.map(g => [g.label, g.count, g.rows])).toEqual([['CREATE TABLE a', 1, null], ['INSERT INTO a', 2, 3], ['INSERT INTO b', 1, null]]);
        expect(groupStatements(statements, 2)).toMatchObject({ more: 1 });
    });
});

describe('format and names', () => {
    test('the format comes from the extension, the file\'s header or the text', () => {
        expect(detectFormat({ name: 'a.CSV' })).toBe('csv');
        expect(detectFormat({ name: 'dump.sql' })).toBe('sql');
        expect(detectFormat({ name: 'x.ndjson' })).toBe('json');
        expect(detectFormat({ name: 'x.bin', bytes: new TextEncoder().encode('SQLite format 3\0' + ' '.repeat(100)) })).toBe('sqlite');
        expect(detectFormat({ text: '  [{"a":1}]' })).toBe('json');
        expect(detectFormat({ text: '-- seed\ninsert into t values (1);' })).toBe('sql');
        expect(detectFormat({ text: 'id,name\n1,Ada' })).toBe('csv');
    });

    test('a table is named after its file', () => {
        expect(tableNameFor('Employees.csv')).toBe('Employees');
        expect(tableNameFor('')).toBe('imported_data');
        expect(tableNameFor('Employees.bak')).toBe('Employees');
        expect(tableNameFor('Employees.csv.bak')).toBe('Employees');
    });

    test('a .bak file is read by what it holds', () => {
        const bytes = (s) => new Uint8Array([...s].map(c => c.charCodeAt(0)));
        expect(detectFormat({ name: 'staff.csv.bak' })).toBe('csv');
        expect(detectFormat({ name: 'shop.db.bak' })).toBe('sqlite');
        expect(detectFormat({ name: 'seed.bak', text: 'CREATE TABLE t (a);' })).toBe('sql');
        expect(detectFormat({ name: 'rows.bak', text: 'id,name\n1,Ada' })).toBe('csv');
        expect(detectFormat({ name: 'shop.bak', bytes: bytes('SQLite format 3\0' + ' '.repeat(100)) })).toBe('sqlite');

        expect(unreadableFile(bytes('SQLite format 3\0\0\0'), 'shop.bak')).toBe(null);
        expect(unreadableFile(bytes('CREATE TABLE t (a);'), 'seed.bak')).toBe(null);
        expect(unreadableFile(new Uint8Array([0xff, 0xfe, 0x43, 0x00]), 'utf16.sql')).toBe(null);
        expect(unreadableFile(bytes('TAPE\0\0\0\0\x01\0'), 'Company.bak')).toMatch(/^Company\.bak is a SQL Server backup\. SQL Lab can't restore SQL Server backups.*Generate Scripts/);
        expect(unreadableFile(bytes('MSSQLBAK\0\0'), 'Company.bak')).toMatch(/is a SQL Server backup/);
        expect(unreadableFile(bytes('PGDMP\x01\x0e\0'), 'shop.bak')).toMatch(/PostgreSQL backup.*pg_restore -f backup\.sql "shop\.bak"/);
        expect(unreadableFile(bytes('PK\x03\x04\0\0'), 'archive.bak')).toBe('archive.bak isn\'t a file SQL Lab can import. Import a SQL script, a CSV or JSON file, or a SQLite database file.');
    });

    test('files are decoded by their byte order mark: SSMS saves scripts as UTF-16', () => {
        const script = "INSERT [dbo].[T] ([Name]) VALUES (N'Café ✓ 東京')\r\nGO\r\n";
        const le = new Uint8Array([0xff, 0xfe, ...new Uint8Array(new Uint16Array([...script].flatMap(c => { const u = c.codePointAt(0); return u > 0xffff ? [] : [u]; })).buffer)]);
        const be = new Uint8Array(le.length);
        be[0] = 0xfe; be[1] = 0xff;
        for (let i = 2; i < le.length; i += 2) { be[i] = le[i + 1]; be[i + 1] = le[i]; }
        const utf8 = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(script)]);

        expect(textEncoding(le)).toBe('utf-16le');
        expect(textEncoding(be)).toBe('utf-16be');
        expect(textEncoding(utf8)).toBe('utf-8');
        expect(decodeText(le)).toBe(script);
        expect(decodeText(be)).toBe(script);
        expect(decodeText(utf8)).toBe(script);
        expect(decodeText(new TextEncoder().encode(script))).toBe(script);

        // A file is read in parts, so UTF-8 and UTF-16 files can both be up to 1 GB
        expect(maxFileBytes()).toBe(1024 * 1024 * 1024);
    });
});

describe('preview', () => {
    test('CSV: columns with suggested types, the real row count and the first rows', () => {
        const p = previewImport({ format: 'csv', text: EMPLOYEES_CSV });
        expect(p.delimiter).toBe(',');
        expect(p.rowCount).toBe(4);
        expect(p.columns.map(c => `${c.name} ${c.type}`)).toEqual(['EmployeeID INTEGER', 'Name TEXT', 'Department TEXT', 'Salary REAL', 'HireDate DATE']);
        expect(p.sample[2]).toEqual(['3', 'Linus, Jr.', 'Sales', '70000', '2021-01-15']);
        expect(p.sample[3][4]).toBeNull();
        expect(p.notes.join(' ')).toMatch(/dates are stored as text/);
    });

    test('CSV without a header row names the columns', () => {
        const p = previewImport({ format: 'csv', text: '1;Ada\n2;Grace\n', options: { header: false, delimiter: 'auto' } });
        expect(p.columns.map(c => c.name)).toEqual(['column1', 'column2']);
        expect(p.rowCount).toBe(2);
        expect(p.delimiter).toBe(';');
    });

    test('rows with a different number of values are refused', () => {
        expect(() => previewImport({ format: 'csv', text: 'a,b\n1,2\n3\n' })).toThrow(/Row 2 \(line 3\) has 1 value, but the header has 2/);
        expect(() => previewImport({ format: 'csv', text: 'a,b\n' })).toThrow(/only a header row/);
    });

    test('SQL: statements, rows of values and issues are counted; nothing runs', () => {
        const p = previewImport({ format: 'sql', text: 'BEGIN;\nCREATE TABLE a (x);\nINSERT INTO a VALUES (1), (2);\nSELECT TOP 1 * FROM a;\nCOMMIT;' });
        expect(p).toMatchObject({ statements: 3, skipped: 2, rows: 2, issues: 1, more: 0 });
        expect(p.creates).toEqual([{ name: 'a', ifNotExists: false, line: 2 }]);
        expect(() => previewImport({ format: 'sql', text: '-- only a comment' })).toThrow(/no SQL statements/);
    });

    test('too much text is refused', () => {
        expect(() => previewImport({ format: 'csv', text: 'x'.repeat(MAX_IMPORT_BYTES + 1) })).toThrow(/too large/);
    });
});

describe('running an import', () => {
    test('CSV into a new table: types as chosen, values bound, real counts', async () => {
        const { adapter, rows } = await setup();
        const result = runImport(adapter, {
            format: 'csv', text: EMPLOYEES_CSV,
            target: { mode: 'new', table: 'Employees', types: ['INTEGER', 'TEXT', 'TEXT', 'REAL', 'DATE'] }
        });
        expect(result).toMatchObject({ table: 'Employees', created: true, rowsInserted: 4 });
        expect(typeof result.durationMs).toBe('number');
        expect(rows('SELECT Name, typeof(EmployeeID), typeof(Salary), HireDate FROM Employees ORDER BY EmployeeID')).toEqual([
            ['Ada', 'integer', 'real', '2019-03-04'],
            ['Grace', 'integer', 'real', '2020-11-30'],
            ['Linus, Jr.', 'integer', 'real', '2021-01-15'],
            ['Margaret', 'integer', 'real', null]]);
        // The success criterion's query works on imported data
        expect(rows('SELECT Department, AVG(Salary) AS AvgSalary FROM Employees GROUP BY Department ORDER BY AvgSalary DESC;'))
            .toEqual([['Engineering', 110000.25], ['Sales', 80000]]);
    });

    test('a value that could be SQL is stored as text, never run', async () => {
        const { adapter, rows } = await setup();
        runImport(adapter, { format: 'csv', text: 'note\n"x\'); DROP TABLE t; --"\n', target: { mode: 'new', table: 't', types: ['TEXT'] } });
        expect(rows('SELECT note FROM t')).toEqual([["x'); DROP TABLE t; --"]]);
    });

    test('leading zeros stay in a TEXT column; booleans become 1 and 0', async () => {
        const { adapter, rows } = await setup();
        runImport(adapter, { format: 'json', text: '[{"code": "007", "ok": true}, {"code": "010", "ok": false}]', target: { mode: 'new', table: 'codes', types: ['TEXT', 'BOOLEAN'] } });
        expect(rows('SELECT code, ok FROM codes')).toEqual([['007', 1], ['010', 0]]);
    });

    test('appending maps columns by name, in any order and case', async () => {
        const { adapter, rows } = await setup();
        adapter.execute('CREATE TABLE People (id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT DEFAULT \'n/a\')');
        const result = runImport(adapter, { format: 'csv', text: 'NAME,ID\nAda,1\nGrace,2\n', target: { mode: 'append', table: 'people' } });
        expect(result).toMatchObject({ table: 'People', created: false, rowsInserted: 2 });
        expect(rows('SELECT id, name, city FROM People ORDER BY id')).toEqual([[1, 'Ada', 'n/a'], [2, 'Grace', 'n/a']]);
        expect(() => runImport(adapter, { format: 'csv', text: 'name,age\nX,1\n', target: { mode: 'append', table: 'People' } }))
            .toThrow(/People has no column named age/);
    });

    test('a failing row rolls everything back and names the row and line', async () => {
        const { adapter, rows } = await setup();
        adapter.execute('CREATE TABLE People (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
        expect(() => runImport(adapter, { format: 'csv', text: 'id,name\n1,Ada\n\n2,\n', target: { mode: 'append', table: 'People' } }))
            .toThrow(/^Row 2 \(line 4\): NOT NULL constraint failed: People\.name/);
        expect(rows('SELECT COUNT(*) FROM People')).toEqual([[0]]);
        // A new table is not left behind either
        expect(() => runImport(adapter, { format: 'json', text: '[{"id": 1}, {"id": 1}]', target: { mode: 'new', table: 'Dup', types: ['TEXT'] } })).not.toThrow();
        adapter.execute('CREATE TABLE Strict (id INTEGER PRIMARY KEY)');
        expect(() => runImport(adapter, { format: 'json', text: '[{"id": 1}, {"id": 1}]', target: { mode: 'append', table: 'Strict' } }))
            .toThrow(/^Item 2: UNIQUE constraint failed/);
        expect(adapter.info().inTransaction).toBe(false);
    });

    test('a new table needs a free name and a type for every column', async () => {
        const { adapter } = await setup();
        adapter.execute('CREATE TABLE Employees (id INTEGER)');
        const csv = { format: 'csv', text: 'id\n1\n' };
        expect(() => runImport(adapter, { ...csv, target: { mode: 'new', table: 'employees', types: ['INTEGER'] } })).toThrow(/already has a table named Employees/);
        expect(() => runImport(adapter, { ...csv, target: { mode: 'new', table: 'x', types: ['WHATEVER'] } })).toThrow(/type for every column/);
        expect(() => runImport(adapter, { ...csv, target: { mode: 'new', table: 'sqlite_x', types: ['INTEGER'] } })).toThrow(/reserved/);
        expect(() => runImport(adapter, { ...csv, target: { mode: 'new', table: '  ', types: ['INTEGER'] } })).toThrow(/Enter a table name/);
    });

    test('a SQL script runs in one transaction, with foreign keys checked at the end', async () => {
        const { adapter, rows } = await setup();
        const result = runImport(adapter, {
            format: 'sql', text: `BEGIN TRANSACTION;
CREATE TABLE Employees (id INTEGER PRIMARY KEY, name TEXT, dept INTEGER REFERENCES Departments(id));
CREATE TABLE Departments (id INTEGER PRIMARY KEY, name TEXT);
INSERT INTO Employees VALUES (1, 'Ada', 10);
INSERT INTO Departments VALUES (10, 'Engineering'), (20, 'Sales');
SELECT * FROM Employees;
COMMIT;`
        });
        expect(result).toMatchObject({ format: 'sql', statements: 5, rowsAffected: 3 });
        expect(rows('SELECT e.name, d.name FROM Employees e JOIN Departments d ON d.id = e.dept')).toEqual([['Ada', 'Engineering']]);
    });

    test('a failing statement keeps nothing and points at the line in the file', async () => {
        const { adapter, rows } = await setup();
        const text = 'BEGIN;\nCREATE TABLE a (x);\nINSERT INTO a VALUES (1);\nINSERT INTO missing VALUES (2);\nCOMMIT;';
        let error;
        try {
            runImport(adapter, { format: 'sql', text });
        } catch (e) {
            error = e;
        }
        expect(error).toMatchObject({ message: 'no such table: missing', line: 4, column: 1, statement: 2 });
        expect(rows("SELECT COUNT(*) FROM sqlite_schema WHERE name = 'a'")).toEqual([[0]]);
        expect(adapter.info().inTransaction).toBe(false);
    });

    test('a foreign key pointing nowhere fails at the end and keeps nothing', async () => {
        const { adapter, rows } = await setup();
        expect(() => runImport(adapter, { format: 'sql', text: 'CREATE TABLE p (id INTEGER PRIMARY KEY);\nCREATE TABLE c (p INTEGER REFERENCES p(id));\nINSERT INTO c VALUES (5);' }))
            .toThrow(/FOREIGN KEY constraint failed/);
        expect(rows("SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table'")).toEqual([[0]]);
    });

    test('a script can\'t end the import\'s transaction (a COMMIT the reader missed is refused)', async () => {
        const { adapter, rows } = await setup();
        expect(() => adapter.runScript('CREATE TABLE a (x);\nCOMMIT;\nINSERT INTO nowhere VALUES (1);')).toThrow(/can't start or end transactions/);
        expect(rows("SELECT COUNT(*) FROM sqlite_schema WHERE name = 'a'")).toEqual([[0]]);
        // A savepoint inside the script is fine
        expect(adapter.runScript('SAVEPOINT s; CREATE TABLE b (x); ROLLBACK TO s; RELEASE s; CREATE TABLE c (x);')).toMatchObject({ statements: 5 });
        expect(rows("SELECT name FROM sqlite_schema ORDER BY name")).toEqual([['c']]);
    });

    test('nothing is imported while a transaction is open', async () => {
        const { adapter } = await setup();
        adapter.execute('BEGIN;');
        expect(() => adapter.runScript('CREATE TABLE a (x);')).toThrow(/transaction is open/);
        expect(() => adapter.insertRows({ sql: 'SELECT 1', rows: [] })).toThrow(/transaction is open/);
        adapter.execute('ROLLBACK;');
    });

    test('the import operations go through the dispatcher', async () => {
        const { adapter } = await setup();
        const preview = await dispatch(adapter, 'previewImport', { format: 'json', text: '[{"a": 1}]' });
        expect(preview.columns[0]).toMatchObject({ name: 'a', type: 'INTEGER' });
        const run = await dispatch(adapter, 'runImport', { format: 'json', text: '[{"a": 1}]', target: { mode: 'new', table: 'j', types: ['INTEGER'] } });
        expect(run.rowsInserted).toBe(1);
    });
});

describe('database files', () => {
    test('a damaged file is refused and not kept', async () => {
        const { adapter, files } = await setup();
        const good = adapter.exportFile('test-db-1');
        const broken = new Uint8Array(good.length);
        broken.set(good.subarray(0, 100));
        broken.fill(0xff, 100); // the schema page is garbage
        await expect(adapter.importFile('broken-1', broken)).rejects.toThrow(/can't be used/);
        expect(files.exists('db-broken-1.sqlite3')).toBe(false);
    });

    test('a file saved in WAL mode is imported in the standard journal mode', async () => {
        const { adapter } = await setup();
        adapter.execute('CREATE TABLE t (x); INSERT INTO t VALUES (1);');
        const bytes = new Uint8Array(adapter.exportFile('test-db-1'));
        bytes[18] = 2;
        bytes[19] = 2;
        await adapter.importFile('wal-copy', bytes);
        await adapter.open('wal-copy');
        expect(adapter.execute('SELECT x FROM t').results[0].rows).toEqual([[1]]);
        expect(bytes[18]).toBe(2); // the caller's bytes aren't changed
    });
});
