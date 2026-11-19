// Scripts without semicolons between statements, and GO batch separators,
// as SQL Server Management Studio writes them.
import { beforeAll, describe, expect, test } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createSqliteAdapter } from '../src/db/sqlite-adapter.js';
import { createMemoryFiles } from '../src/db/files.js';
import { isStatementStartAt, replaceBatchSeparators } from '../src/db/script-split.js';

let sqlite3;
beforeAll(async () => {
    sqlite3 = await sqlite3InitModule();
});

async function open() {
    const adapter = createSqliteAdapter(sqlite3, createMemoryFiles(sqlite3));
    await adapter.create('test');
    adapter.execute(`CREATE TABLE DimAccount (AccountKey INTEGER PRIMARY KEY, Name TEXT);
        INSERT INTO DimAccount VALUES (1, 'Assets'), (2, 'Cash'), (3, 'Sales');`);
    return adapter;
}

describe('replaceBatchSeparators', () => {
    test('turns GO lines into semicolons and keeps the line count', () => {
        const sql = 'SELECT 1\nGO\nSELECT 2\n  go 3  \nSELECT 3\nGO;';
        const out = replaceBatchSeparators(sql);
        expect(out).toBe('SELECT 1\n;\nSELECT 2\n;\nSELECT 3\n;');
        expect(out.split('\n').length).toBe(sql.split('\n').length);
    });

    test('leaves GO inside strings, comments and longer words alone', () => {
        const sql = "SELECT 'a\nGO\nb' AS x\n-- GO\n/*\nGO\n*/\nSELECT 1 AS goal\nGOTO";
        expect(replaceBatchSeparators(sql)).toBe(sql);
    });
});

describe('isStatementStartAt', () => {
    const bytes = (/** @type {string} */ s) => new TextEncoder().encode(s);
    test('a keyword first on a later line', () => {
        const b = bytes('SELECT 1\n  SELECT 2');
        expect(isStatementStartAt(b, 0, 11)).toBe(true);
    });
    test('not mid-line, not on the first line, not a longer word', () => {
        expect(isStatementStartAt(bytes('SELECT 1 SELECT 2'), 0, 9)).toBe(false);
        expect(isStatementStartAt(bytes('SELECT 1\nSELECTED'), 0, 9)).toBe(false);
        expect(isStatementStartAt(bytes('SELECT 1\nFROM t'), 0, 9)).toBe(false);
    });
});

describe('running scripts without semicolons', () => {
    test('each line-starting statement runs on its own, with its own results', async () => {
        const adapter = await open();
        const run = adapter.execute('Select * from DimAccount\nSelect * from DimAccount\nSelect Name from DimAccount where AccountKey = 2');
        expect(run.error).toBeNull();
        expect(run.statements).toBe(3);
        expect(run.results.map(r => r.rows.length)).toEqual([3, 3, 1]);
        expect(run.results[2].rows).toEqual([['Cash']]);
        expect(run.results.map(r => r.line)).toEqual([1, 2, 3]);
    });

    test('multi-line statements split only where the next one starts', async () => {
        const adapter = await open();
        const run = adapter.execute(`SELECT Name
FROM DimAccount
WHERE AccountKey IN (SELECT AccountKey
                     FROM DimAccount
                     WHERE AccountKey > 1)
UPDATE DimAccount SET Name = 'Bank' WHERE AccountKey = 2
SELECT Name FROM DimAccount WHERE AccountKey = 2`);
        expect(run.error).toBeNull();
        expect(run.statements).toBe(3);
        expect(run.results[0].rows).toEqual([['Cash'], ['Sales']]);
        expect(run.results[1].rowsAffected).toBe(1);
        expect(run.results[2].rows).toEqual([['Bank']]);
    });

    test('GO separates batches', async () => {
        const adapter = await open();
        const run = adapter.execute('SELECT COUNT(*) FROM DimAccount\nGO\nSELECT MAX(AccountKey) FROM DimAccount\nGO');
        expect(run.error).toBeNull();
        expect(run.results.map(r => r.rows[0][0])).toEqual([3, 3]);
    });

    test('scripts with semicolons, UNION and CTEs run exactly as before', async () => {
        const adapter = await open();
        const run = adapter.execute(`WITH big AS (SELECT * FROM DimAccount WHERE AccountKey > 1)
SELECT Name FROM big
UNION ALL
SELECT 'x';
SELECT 1;`);
        expect(run.error).toBeNull();
        expect(run.results.map(r => r.rows.length)).toEqual([3, 1]);
    });

    test('a real syntax error is still reported where it is', async () => {
        const adapter = await open();
        const run = adapter.execute('SELECT * FROM DimAccount\nSELECT * FORM DimAccount');
        expect(run.results).toHaveLength(1);
        expect(run.error).toMatchObject({ line: 2, statement: 1 });
        expect(run.error.message).toMatch(/syntax error/);
    });
});
