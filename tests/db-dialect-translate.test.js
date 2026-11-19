// SQL Lab's languages: SQL Server, PostgreSQL and MySQL translated for
// SQLite, run against the real SQLite with the compatibility functions.
import { beforeAll, describe, expect, test } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createSqliteAdapter } from '../src/db/sqlite-adapter.js';
import { createMemoryFiles } from '../src/db/files.js';
import { translateForSqlite, tokens } from '../src/db/dialect-translate.js';
import { addTo, diff, toDate, mysqlFormat, convertStyle } from '../src/db/compat-functions.js';

let sqlite3;
beforeAll(async () => {
    sqlite3 = await sqlite3InitModule();
});

async function open() {
    const adapter = createSqliteAdapter(sqlite3, createMemoryFiles(sqlite3));
    await adapter.create('test');
    adapter.execute(`CREATE TABLE DimAccount (AccountKey INTEGER PRIMARY KEY, Name TEXT, Created TEXT);
        INSERT INTO DimAccount VALUES (1, 'Assets', '2024-01-31'), (2, 'Cash', '2024-03-15 10:20:00'), (3, 'Sales', '2023-12-01');`);
    return adapter;
}
/** Translates and runs; returns the rows of each result with rows. */
async function rows(sql, dialect) {
    const adapter = await open();
    const t = translateForSqlite(sql, dialect);
    const run = adapter.execute(t.sql);
    expect(run.error).toBeNull();
    return run.results.filter(r => r.columns.length).map(r => r.rows);
}

describe('translateForSqlite', () => {
    test('tokens join back to the input', () => {
        const sql = "SELECT [a b], `c`, \"d\", N'x''y', 0x1F, 1.5e3 -- note\n/* c */ FROM t::int";
        expect(tokens(sql).map(t => t.v).join('')).toBe(sql);
    });

    test('SQLite runs as written', () => {
        expect(translateForSqlite('SELECT TOP 1', 'sqlite')).toEqual({ sql: 'SELECT TOP 1', changes: [] });
    });

    test('line breaks are kept, so error lines match the editor', () => {
        for (const [dialect, sql] of [
            ['sqlserver', 'SELECT TOP (5)\n  Name\nFROM dbo.DimAccount\nGO\nSELECT CONVERT(\n  int,\n  1)'],
            ['postgresql', "SELECT (a\n + 1)::\nint FROM public.t"],
            ['mysql', 'CREATE TABLE m (\n id INT AUTO_INCREMENT PRIMARY KEY\n) ENGINE=InnoDB;\nSHOW\nTABLES']
        ]) {
            const out = translateForSqlite(sql, /** @type {any} */ (dialect)).sql;
            expect(out.split('\n').length).toBe(sql.split('\n').length);
        }
    });

    test('lists what changed', () => {
        const { changes } = translateForSqlite('SELECT TOP 2 * FROM dbo.A\nSELECT TOP 3 * FROM dbo.B', 'sqlserver');
        expect(changes).toContainEqual({ message: 'TOP n became LIMIT n.', count: 2 });
    });
});

describe('SQL Server', () => {
    test('TOP, functions, CONVERT, N strings, + on text, hints, schemas and GO', async () => {
        const [first, second] = await rows(`SELECT TOP 2 Name, DATEADD(month, 1, Created) AS NextMonth, DATEDIFF(day, Created, '2024-12-31') AS Days,
    LEN(Name) AS L, ISNULL(NULL, 'x') AS I, CONVERT(varchar(10), Created, 103) AS UK, N'#' + Name AS Tag
FROM dbo.DimAccount WITH (NOLOCK)
ORDER BY AccountKey
GO
SELECT YEAR(Created), DATENAME(month, Created) FROM [dbo].[DimAccount] WHERE AccountKey = 3`, 'sqlserver');
        expect(first).toEqual([
            ['Assets', '2024-02-29', 335, 6, 'x', '31/01/2024', '#Assets'],
            ['Cash', '2024-04-15 10:20:00', 291, 4, 'x', '15/03/2024', '#Cash']
        ]);
        expect(second).toEqual([[2023, 'December']]);
    });

    test('TOP in a subquery limits the subquery', async () => {
        const [r] = await rows('SELECT COUNT(*) FROM (SELECT TOP 2 * FROM DimAccount ORDER BY AccountKey) AS x', 'sqlserver');
        expect(r).toEqual([[2]]);
    });

    test('OFFSET … FETCH and PRINT', async () => {
        const [page, printed] = await rows("SELECT Name FROM DimAccount ORDER BY AccountKey OFFSET 1 ROWS FETCH NEXT 1 ROWS ONLY\nPRINT 'done'", 'sqlserver');
        expect(page).toEqual([['Cash']]);
        expect(printed).toEqual([['done']]);
    });
});

describe('PostgreSQL', () => {
    test('casts, ILIKE, EXTRACT, date_trunc, to_char, INTERVAL, string_agg', async () => {
        const [a, b, c] = await rows(`SELECT Created::date, (AccountKey * 2)::int, EXTRACT(year FROM Created), date_trunc('month', Created), to_char(Created, 'YYYY/MM/DD')
FROM public.DimAccount WHERE Name ILIKE 'c%';
SELECT Created + INTERVAL '7 days' FROM DimAccount WHERE AccountKey = 1;
SELECT string_agg(Name, ', ') FROM DimAccount;`, 'postgresql');
        expect(a).toEqual([['2024-03-15', 4, 2024, '2024-03-01 00:00:00', '2024/03/15']]);
        expect(b).toEqual([['2024-02-07 00:00:00']]);
        expect(c).toEqual([['Assets, Cash, Sales']]);
    });

    test('SERIAL keys number new rows', async () => {
        const [r] = await rows("CREATE TABLE p (id SERIAL PRIMARY KEY, n text);\nINSERT INTO p (n) VALUES ('a'), ('b') RETURNING id;", 'postgresql');
        expect(r).toEqual([[1], [2]]);
    });
});

describe('MySQL', () => {
    test('SHOW TABLES, DESCRIBE, DATE_FORMAT, DATE_ADD, LIMIT a, b, AUTO_INCREMENT and table options', async () => {
        const [tables, columns, formatted, created] = await rows(`SHOW TABLES;
DESCRIBE DimAccount;
SELECT Name, DATE_FORMAT(Created, '%d %b %Y'), DATE_ADD(Created, INTERVAL 10 DAY), CONCAT(Name, '-', AccountKey) FROM \`DimAccount\` ORDER BY AccountKey LIMIT 1, 2;
CREATE TABLE m (id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, n VARCHAR(20)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT INTO m (n) VALUES ('x');
SELECT * FROM m;`, 'mysql');
        expect(tables).toEqual([['DimAccount']]);
        expect(columns.map(c => c[0])).toEqual(['AccountKey', 'Name', 'Created']);
        expect(columns[0][3]).toBe('PRI');
        expect(formatted).toEqual([['Cash', '15 Mar 2024', '2024-03-25 10:20:00', 'Cash-2'], ['Sales', '01 Dec 2023', '2023-12-11', 'Sales-3']]);
        expect(created).toEqual([[1, 'x']]);
    });
});

describe('compatibility functions', () => {
    test('dates in, dates out', () => {
        expect(toDate('2024-02-29 23:59:59')?.toISOString()).toBe('2024-02-29T23:59:59.000Z');
        expect(toDate('not a date')).toBeNull();
        expect(addTo(/** @type {Date} */ (toDate('2024-03-31')), 'month', -1)?.toISOString().slice(0, 10)).toBe('2024-02-29');
        expect(diff('year', /** @type {Date} */ (toDate('2023-12-31')), /** @type {Date} */ (toDate('2024-01-01')))).toBe(1);
        expect(diff('month', /** @type {Date} */ (toDate('2024-01-31')), /** @type {Date} */ (toDate('2024-02-01')))).toBe(1);
        expect(mysqlFormat(/** @type {Date} */ (toDate('2024-07-04 15:05:09')), '%W %e %M %Y %h:%i %p')).toBe('Thursday 4 July 2024 03:05 PM');
        expect(convertStyle('2024-07-04', 112)).toBe('20240704');
    });

    test('NULL in, NULL out; SQLite\'s own functions are left alone', async () => {
        const adapter = await open();
        const run = adapter.execute("SELECT LEN(NULL), DATEADD('day', 1, NULL), replace('aXa', 'X', '-'), GETDATE() IS NOT NULL, NEWID() IS NOT NULL");
        expect(run.error).toBeNull();
        expect(run.results[0].rows).toEqual([[null, null, 'a-a', 1, 1]]);
    });
});
