// Adapting SQL Server scripts (SSMS Generate Scripts) for SQLite on import:
// what changes, that every change is listed, and that the result runs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createSqliteAdapter } from '../src/db/sqlite-adapter.js';
import { createMemoryFiles } from '../src/db/files.js';
import { adaptSqlServerScript, looksLikeSqlServer } from '../src/db/import-sqlserver.js';
import { previewImport, runImport } from '../src/db/importer.js';

const SSMS = readFileSync(join(import.meta.dirname, 'fixtures', 'ssms-adventureworksdw.sql'), 'utf8');

let sqlite3;
beforeAll(async () => {
    sqlite3 = await sqlite3InitModule();
});

const setup = async () => {
    const adapter = createSqliteAdapter(sqlite3, createMemoryFiles(sqlite3));
    await adapter.create('test-db-1');
    const rows = (sql) => adapter.execute(sql).results.at(-1).rows;
    return { adapter, rows };
};

describe('recognising a SQL Server script', () => {
    test('GO lines, [dbo]., SET ANSI_NULLS, ON [PRIMARY] or IDENTITY(1,1)', () => {
        expect(looksLikeSqlServer(SSMS)).toBe(true);
        expect(looksLikeSqlServer('CREATE TABLE t (a);\nGO\n')).toBe(true);
        expect(looksLikeSqlServer('SELECT * FROM [dbo].[t];')).toBe(true);
        expect(looksLikeSqlServer('CREATE TABLE t (id int IDENTITY(1,1));')).toBe(true);
        expect(looksLikeSqlServer('CREATE TABLE t (a INTEGER);\nINSERT INTO t VALUES (1);')).toBe(false);
        expect(looksLikeSqlServer('-- going home\nSELECT 1 AS go;')).toBe(false);
    });
});

describe('the SSMS AdventureWorksDW script', () => {
    test('keeps every line where it was, so errors point at the original file', () => {
        const { text } = adaptSqlServerScript(SSMS);
        expect(text.split('\n')).toHaveLength(SSMS.split('\n').length);
        const lines = text.split('\n');
        const original = SSMS.split('\n');
        const at = original.findIndex(l => l.startsWith('CREATE TABLE [dbo].[DimCurrency]'));
        expect(lines[at]).toBe('CREATE TABLE [DimCurrency](');
        const insert = original.findIndex(l => l.startsWith('INSERT [dbo].[FactInternetSales]'));
        expect(lines[insert]).toMatch(/^INSERT INTO \[FactInternetSales\] .* VALUES \('SO43697', 1, 11000, 3, 3578\.2700, '2010-12-29T00:00:00\.000' \);$/);
    });

    test('lists each kind of change with how often and where it first happens', () => {
        const { changes } = adaptSqlServerScript(SSMS);
        const find = (start) => changes.find(c => c.message.startsWith(start));
        expect(find('Schema names are removed')).toMatchObject({ count: 12 });
        expect(find('N\'…\' text')).toMatchObject({ count: 23 });
        expect(find('INSERT without INTO')).toMatchObject({ count: 8, line: 92 });
        expect(find('CAST(… AS datetime)')).toMatchObject({ count: 7 });
        expect(find('IDENTITY is removed')).toMatchObject({ count: 2 });
        expect(find('Views aren\'t created')).toMatchObject({ count: 1, line: 83 });
        expect(find('Procedures, functions and triggers')).toMatchObject({ count: 1 });
        expect(find('Foreign keys added with ALTER TABLE')).toMatchObject({ count: 1 });
        expect(find('Defaults added with ALTER TABLE')).toMatchObject({ count: 1 });
        expect(find('Check constraints added with ALTER TABLE')).toMatchObject({ count: 1 });
        expect(find('SET IDENTITY_INSERT')).toMatchObject({ count: 4 });
        expect(find('SET options')).toBeTruthy();
        expect(find('USE is left out')).toMatchObject({ count: 3 });
        expect(find('CREATE DATABASE is left out')).toBeTruthy();
        expect(find('ALTER DATABASE is left out')).toMatchObject({ count: 2 });
        expect(find('EXEC statements')).toBeTruthy();
        expect(find('Binary values')).toBeTruthy();
        expect(find('INCLUDE (…)')).toBeTruthy();
        expect(find('COLLATE')).toBeTruthy();
        expect(find('(MAX) sizes')).toMatchObject({ count: 2 });
        expect(changes.map(c => c.line)).toEqual([...changes.map(c => c.line)].sort((a, b) => a - b));
    });

    test('previews and runs in SQLite: tables, rows, dates as text, binary, the index', async () => {
        const preview = previewImport({ format: 'sql', text: SSMS, adapt: true });
        expect(preview.sqlServer).toBe(true);
        expect(preview.issues).toBe(0);
        expect(preview.changes.length).toBeGreaterThan(15);
        expect(preview.creates.map(c => c.name)).toEqual(['DimCurrency', 'DimCustomer', 'FactInternetSales']);
        expect(preview.rows).toBe(8);

        const { adapter, rows } = await setup();
        const result = runImport(adapter, { format: 'sql', text: SSMS, adapt: true });
        expect(result.rowsAffected).toBe(8);
        expect(rows('SELECT CurrencyKey, CurrencyName FROM DimCurrency ORDER BY 1')).toEqual([[1, 'Afghani'], [2, 'Algerian Dinar'], [3, 'US Dollar']]);
        expect(rows('SELECT FirstName, BirthDate, typeof(BirthDate), DateFirstPurchase, YearlyIncome, length(Photo) FROM DimCustomer ORDER BY CustomerKey'))
            .toEqual([['Jon', '1971-10-06', 'text', '2011-01-19T00:00:00.000', 90000, 4], ['Eugene', '1976-05-10', 'text', '2011-01-15T00:00:00.000', 60000, null]]);
        // Text with a GO line, a semicolon and doubled quotes is kept as it was
        expect(rows('SELECT Notes FROM DimCustomer WHERE CustomerKey = 11000')).toEqual([['Line one\nLine two with a GO\nGO\nand O\'Brien\'s ; semicolon']]);
        expect(rows('SELECT c.CurrencyName, round(SUM(f.SalesAmount), 2) FROM FactInternetSales f JOIN DimCurrency c ON c.CurrencyKey = f.CurrencyKey GROUP BY 1')).toEqual([['US Dollar', 7677.36]]);
        expect(rows("SELECT name FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")).toEqual([['IX_DimCustomer_LastName']]);
        // IDENTITY + PRIMARY KEY: new rows are numbered by SQLite
        adapter.execute("INSERT INTO DimCurrency (CurrencyAlternateKey, CurrencyName) VALUES ('EUR', 'Euro')");
        expect(rows("SELECT CurrencyKey FROM DimCurrency WHERE CurrencyName = 'Euro'")).toEqual([[4]]);
        expect(rows("SELECT count(*) FROM sqlite_schema WHERE type = 'view'")).toEqual([[0]]);
    });

    test('without adapting, the same script is marked as likely to fail and runs nothing', async () => {
        const preview = previewImport({ format: 'sql', text: SSMS, adapt: false });
        expect(preview.changes).toBe(null);
        expect(preview.issues).toBeGreaterThan(0);
        const { adapter, rows } = await setup();
        expect(() => runImport(adapter, { format: 'sql', text: SSMS })).toThrow();
        expect(rows("SELECT count(*) FROM sqlite_schema")).toEqual([[0]]);
    });
});

describe('details', () => {
    const adapt = (sql) => adaptSqlServerScript(sql).text;

    test('a script that isn\'t SQL Server\'s is never adapted, even when asked', async () => {
        const text = 'CREATE TABLE t (a INTEGER);\nALTER TABLE t ADD COLUMN b TEXT;\nINSERT INTO t VALUES (1, \'x\');';
        expect(previewImport({ format: 'sql', text, adapt: true }).changes).toBe(null);
        const { adapter, rows } = await setup();
        runImport(adapter, { format: 'sql', text, adapt: true });
        expect(rows('SELECT a, b FROM t')).toEqual([[1, 'x']]);
    });

    test('statements split at line starts, not inside brackets or text; UPDATE … SET stays one statement', () => {
        expect(adapt('INSERT [t] ([a]) VALUES (1)\nINSERT [t] ([a]) VALUES (2)\nGO\n')).toBe('INSERT INTO [t] ([a]) VALUES (1);\nINSERT INTO [t] ([a]) VALUES (2);\nGO\n');
        expect(adapt("UPDATE [dbo].[t]\nSET [a] = N'x'\nWHERE [b] = 1\nGO\n")).toBe("UPDATE [t]\nSET [a] = 'x'\nWHERE [b] = 1;\nGO\n");
        expect(adapt("INSERT [t] ([a]) VALUES (N'one\nINSERT two')\nGO")).toBe("INSERT INTO [t] ([a]) VALUES ('one\nINSERT two');\nGO");
    });

    test('inline foreign keys keep ON DELETE / ON UPDATE; other schemas are dropped from table names', () => {
        const out = adapt('CREATE TABLE [Sales].[Order](\n\t[Id] [int] IDENTITY(1,1) NOT NULL PRIMARY KEY,\n\t[CustomerId] [int] REFERENCES [Sales].[Customer]([Id]) ON DELETE CASCADE ON UPDATE NO ACTION\n) ON [PRIMARY]\nGO\n');
        expect(out).toBe('CREATE TABLE [Order](\n\t[Id] INTEGER  NOT NULL PRIMARY KEY,\n\t[CustomerId] int REFERENCES [Customer]([Id]) ON DELETE CASCADE ON UPDATE NO ACTION\n); \nGO\n');
    });

    test('two schemas with the same table name are pointed out', () => {
        const { changes } = adaptSqlServerScript('CREATE TABLE [Sales].[Address] ([a] int)\nGO\nCREATE TABLE [Person].[Address] ([a] int)\nGO\n');
        expect(changes.some(c => /Sales\.Address, Person\.Address/.test(c.message))).toBe(true);
    });

    test('numeric casts are kept; odd-length binary is padded', () => {
        expect(adapt('INSERT [t] VALUES (CAST(12.50 AS Decimal(18, 2)), 0xABC)\nGO')).toBe("INSERT INTO [t] VALUES (CAST(12.50 AS Decimal(18, 2)), X'0ABC');\nGO");
    });
});
