// SQL Lab imports of large files (up to 1 GB), read a few MB at a time. The
// tests read small files in tiny parts (a few characters at a time), and
// check that every result, row and message is the one the whole-text import
// gives for the same text.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createSqliteAdapter } from '../src/db/sqlite-adapter.js';
import { createMemoryFiles } from '../src/db/files.js';
import { previewImport, runImport } from '../src/db/importer.js';
import { previewImportFile, runImportFile } from '../src/db/import-file.js';
import { textChunks, sqlParts, csvParts, jsonListItems, MAX_FILE_BYTES } from '../src/db/import-stream.js';
import { dispatch } from '../src/db/dispatch.js';

let sqlite3;
beforeAll(async () => {
    sqlite3 = await sqlite3InitModule();
});

const setup = async (id = 'stream-db-1') => {
    const files = createMemoryFiles(sqlite3);
    const adapter = createSqliteAdapter(sqlite3, files);
    await adapter.create(id);
    const rows = (sql) => adapter.execute(sql).results.at(-1).rows;
    return { files, adapter, rows };
};

// Every file is read in parts, in pieces of a few characters
const TINY = { wholeBytes: 0, chunkBytes: 7, partChars: 40 };
const SMALL = { wholeBytes: 0, chunkBytes: 64, partChars: 200 };

const utf8 = (text) => new Blob([text]);
function utf16(text) {
    const bytes = new Uint8Array(2 + text.length * 2);
    bytes[0] = 0xff;
    bytes[1] = 0xfe;
    for (let i = 0; i < text.length; i++) {
        bytes[2 + i * 2] = text.charCodeAt(i) & 0xff;
        bytes[3 + i * 2] = text.charCodeAt(i) >> 8;
    }
    return new Blob([bytes]);
}

/** What an error says, for comparing. */
async function failure(promise) {
    try {
        await promise;
    } catch (error) {
        const e = /** @type {any} */ (error);
        return { message: e.message, code: e.code, line: e.line, column: e.column, row: e.row, statement: e.statement };
    }
    throw new Error('expected the import to fail');
}

const failureOf = (work) => failure(Promise.resolve().then(work));

/** Runs the same import whole and in parts, into two databases, and compares them. */
async function sameRun(args, source, ctx = TINY, query = null) {
    const whole = await setup('whole-1');
    const parts = await setup('parts-1');
    const a = runImport(whole.adapter, args);
    const b = await runImportFile(parts.adapter, { ...args, text: undefined, source }, ctx);
    delete a.durationMs;
    delete b.durationMs;
    expect(b).toEqual(a);
    const sql = query || `SELECT * FROM "${a.table}"`;
    expect(parts.rows(sql)).toEqual(whole.rows(sql));
    return { whole, parts, result: b };
}

describe('reading in parts', () => {
    test('text is decoded across chunk edges (UTF-8 and UTF-16), without the byte order mark', async () => {
        const text = 'naïve café — 日本語 😀\nsecond line';
        let out = '';
        for await (const chunk of textChunks(new Blob(['﻿', text]), { chunkBytes: 3 })) out += chunk;
        expect(out).toBe(text);
        out = '';
        for await (const chunk of textChunks(utf16(text), { chunkBytes: 3 })) out += chunk;
        expect(out).toBe(text);
    });

    test('a SQL script is cut where statements end, never inside a quote, comment or trigger', async () => {
        const script = `CREATE TABLE t (a TEXT); -- a comment; with a semicolon
INSERT INTO t VALUES ('x;y'), ('two
lines;'); /* also ; here */ INSERT INTO t VALUES ('z');
CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE t SET a = a; END;
INSERT INTO t VALUES ('last')`;
        const parts = [];
        for await (const part of sqlParts(textChunks(script, { chunkBytes: 5 }), { partChars: 10 })) parts.push(part);
        expect(parts.length).toBeGreaterThan(3);
        expect(parts.map(p => p.text).join('')).toBe(script);
        expect(parts.some(p => /BEGIN UPDATE t SET a = a; END;$/.test(p.text))).toBe(true);
        expect(parts.every(p => !/'x;$|'two\n?$/.test(p.text))).toBe(true);
        // Each part's start, as a line and column in the file
        for (const p of parts) {
            const before = script.slice(0, script.indexOf(p.text));
            expect(p.line).toBe(before.split('\n').length);
            expect(p.column).toBe(before.length - before.lastIndexOf('\n') - 1);
        }
    });

    test('CSV is cut at the end of a row, not at a line break inside quotes', async () => {
        const csv = 'a,b\n1,"x\ny"\n2,"z\r\nw"\n3,q\n';
        const parts = [];
        for await (const part of csvParts(textChunks(csv, { chunkBytes: 2 }), { partChars: 4 })) parts.push(part);
        expect(parts.map(p => p.text)).toEqual(['a,b\n', '1,"x\ny"\n', '2,"z\r\nw"\n', '3,q\n']);
        expect(parts.map(p => p.line)).toEqual([1, 2, 4, 6]);
    });

    test('JSON list items are found one at a time, with where each starts', async () => {
        const shape = { from: null };
        const items = [];
        for await (const item of jsonListItems(textChunks('{"rows": [\n {"a": "],}"},\n {"b": [1, {"c": 2}]}\n]}', { chunkBytes: 3 }), shape)) items.push(item);
        expect(shape.from).toBe('rows');
        expect(items).toEqual([{ text: '{"a": "],}"}', line: 2, column: 2 }, { text: '{"b": [1, {"c": 2}]}', line: 3, column: 2 }]);
        await expect((async () => {
            for await (const item of jsonListItems(textChunks('[{"a": 1},]'), { from: null })) void item;
        })()).rejects.toThrow(/comma before \]/);
        await expect((async () => {
            for await (const item of jsonListItems(textChunks('{"a": [], "b": []}'), { from: null })) void item;
        })()).rejects.toThrow(/more than one property/);
    });

    test('a file over 1 GB is refused before anything is read', async () => {
        const huge = { size: MAX_FILE_BYTES + 1, slice: () => { throw new Error('read'); } };
        await expect(previewImportFile({ format: 'csv', source: huge })).rejects.toMatchObject({ code: 'TOO_LARGE', message: expect.stringMatching(/limit is 1 GB/) });
    });
});

const SCRIPT = `-- Staff, made by hand
CREATE TABLE dept (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE emp (id INTEGER PRIMARY KEY, name TEXT, dept INTEGER REFERENCES dept(id), note TEXT);
BEGIN TRANSACTION;
INSERT INTO emp VALUES (1, 'Ada', 10, 'semi;colon'), (2, 'Grace', 20, 'two
lines');
INSERT INTO dept VALUES (10, 'Engineering'); INSERT INTO dept VALUES (20, 'Sales');
UPDATE emp SET note = upper(note) WHERE id = 1;
CREATE VIEW staff AS SELECT emp.name, dept.name AS dept FROM emp JOIN dept ON dept.id = emp.dept;
SELECT * FROM staff;
COMMIT;
`;

describe('SQL scripts in parts', () => {
    test('the preview is the one the whole script gives', async () => {
        const whole = previewImport({ format: 'sql', text: SCRIPT });
        expect(await previewImportFile({ format: 'sql', source: utf8(SCRIPT) }, TINY)).toEqual(whole);
        expect(await previewImportFile({ format: 'sql', source: utf16(SCRIPT) }, SMALL)).toEqual(whole);
    });

    test('runs every part in one transaction, with the same result', async () => {
        const { parts } = await sameRun({ format: 'sql', text: SCRIPT }, utf8(SCRIPT), TINY, 'SELECT * FROM staff ORDER BY name');
        expect(parts.rows('SELECT note FROM emp ORDER BY id')).toEqual([['SEMI;COLON'], ['two\nlines']]);
    });

    test('a failing statement in a later part names its line and column in the file, and nothing is kept', async () => {
        const script = `${SCRIPT.replace('COMMIT;\n', '')}INSERT INTO dept VALUES (30, 'Ops'); INSERT INTO nowhere VALUES (1);\n`;
        const whole = await setup('whole-2');
        const expected = await failureOf(() => runImport(whole.adapter, { format: 'sql', text: script }));
        expect(expected).toMatchObject({ line: 11, column: 38 });
        const { adapter, rows } = await setup('parts-2');
        expect(await failure(runImportFile(adapter, { format: 'sql', source: utf8(script) }, TINY))).toEqual(expected);
        expect(rows("SELECT name FROM sqlite_schema")).toEqual([]);
    });

    test('a quote never closed is reported on its line in the file', async () => {
        const script = `${SCRIPT}\nINSERT INTO dept VALUES (40, 'never closed);\n`;
        const expected = await failureOf(() => previewImport({ format: 'sql', text: script }));
        expect(await failure(previewImportFile({ format: 'sql', source: utf8(script) }, TINY))).toEqual(expected);
        const { adapter } = await setup('parts-3');
        expect(await failure(runImportFile(adapter, { format: 'sql', source: utf8(script) }, TINY))).toEqual(expected);
    });

    test('an SSMS script is adapted as it is read: the same changes, statements and rows', async () => {
        const ssms = readFileSync(join(import.meta.dirname, 'fixtures', 'ssms-adventureworksdw.sql'), 'utf8');
        const whole = previewImport({ format: 'sql', text: ssms, adapt: true });
        expect(whole.changes.length).toBeGreaterThan(3);
        expect(await previewImportFile({ format: 'sql', source: utf16(ssms), adapt: true }, SMALL)).toEqual(whole);
        const a = await setup('whole-4');
        const b = await setup('parts-4');
        const ra = runImport(a.adapter, { format: 'sql', text: ssms, adapt: true });
        const rb = await runImportFile(b.adapter, { format: 'sql', source: utf16(ssms), adapt: true }, SMALL);
        delete ra.durationMs;
        delete rb.durationMs;
        expect(rb).toEqual(ra);
        const names = a.rows("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").map(r => r[0]);
        expect(names.length).toBeGreaterThan(1);
        expect(b.rows("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").map(r => r[0])).toEqual(names);
        for (const name of names) expect(b.rows(`SELECT * FROM "${name}"`)).toEqual(a.rows(`SELECT * FROM "${name}"`));
    });
});

const CSV = `EmployeeID;Name;Department;Salary;HireDate
1;Ada;Engineering;120000;2019-03-04
2;Grace;Engineering;100000.50;2020-11-30
3;"Linus; Jr.";Sales;70000;2021-01-15

4;"Margaret
Hamilton";Sales;90000;
${Array.from({ length: 80 }, (_, i) => `${i + 5};Person ${i + 5};Ops;${50000 + i};2022-01-${String((i % 28) + 1).padStart(2, '0')}`).join('\r\n')}
`;

describe('CSV in parts', () => {
    test('the preview is the one the whole file gives (UTF-8 and UTF-16, detected delimiter, no header)', async () => {
        for (const options of [{}, { header: false }, { delimiter: ';' }]) {
            const whole = previewImport({ format: 'csv', text: CSV, options });
            expect(await previewImportFile({ format: 'csv', source: utf8(CSV), options }, TINY)).toEqual(whole);
            expect(await previewImportFile({ format: 'csv', source: utf16(CSV), options }, SMALL)).toEqual(whole);
        }
    });

    test('imports the same rows into a new table', async () => {
        const target = { mode: 'new', table: 'staff', types: ['INTEGER', 'TEXT', 'TEXT', 'REAL', 'DATE'] };
        const { result } = await sameRun({ format: 'csv', text: CSV, target }, utf8(CSV), TINY);
        expect(result.rowsInserted).toBe(84);
    });

    test('a short row in a later part is refused as the whole file refuses it', async () => {
        const bad = `${CSV}85;Short;Ops\n`;
        const expected = await failureOf(() => previewImport({ format: 'csv', text: bad }));
        expect(expected.message).toMatch(/^Row 85 \(line 88\) has 3 values/);
        expect(await failure(previewImportFile({ format: 'csv', source: utf8(bad) }, TINY))).toEqual(expected);
    });

    test('a row that fails in a later part rolls back every part: nothing is kept', async () => {
        const make = async (id) => {
            const s = await setup(id);
            s.adapter.execute('CREATE TABLE staff (EmployeeID INTEGER PRIMARY KEY, Name TEXT NOT NULL, Department TEXT, Salary REAL, HireDate TEXT)');
            return s;
        };
        const bad = `${CSV}86;;Ops;1;2020-01-01\n`;
        const args = { format: 'csv', options: {}, target: { mode: 'append', table: 'staff' } };
        const whole = await make('whole-5');
        const expected = await failureOf(() => runImport(whole.adapter, { ...args, text: bad }));
        expect(expected.message).toMatch(/^Row 85 \(line 88\): NOT NULL constraint failed/);
        const parts = await make('parts-5');
        expect(await failure(runImportFile(parts.adapter, { ...args, source: utf8(bad) }, TINY))).toEqual(expected);
        expect(parts.rows('SELECT count(*) FROM staff')).toEqual([[0]]);
    });
});

const LIST = [
    { id: 1, name: 'Ada', tags: ['math', 'code'], active: true },
    { id: 2, name: 'Grace', manager: { id: 1 } },
    { id: 3, name: 'Linus, "Jr."', active: false, extra: null },
    ...Array.from({ length: 60 }, (_, i) => ({ id: i + 4, name: `Person ${i + 4}`, joined: '2024-02-01' }))
];

describe('JSON in parts', () => {
    const shapes = {
        list: JSON.stringify(LIST, null, 2),
        wrapper: JSON.stringify({ employees: LIST }, null, 1),
        lines: `${LIST.map(item => JSON.stringify(item)).join('\n')}\n\n`
    };

    test.each(Object.keys(shapes))('a %s gives the preview and rows the whole file gives', async (shape) => {
        const text = shapes[shape];
        expect(await previewImportFile({ format: 'json', source: utf8(text) }, TINY)).toEqual(previewImport({ format: 'json', text }));
        const preview = previewImport({ format: 'json', text });
        const target = { mode: 'new', table: 'people', types: preview.columns.map(c => c.type) };
        const { result } = await sameRun({ format: 'json', text, target }, utf8(text), SMALL);
        expect(result.rowsInserted).toBe(LIST.length);
    });

    test('an item that isn\'t an object is refused with its number (and line, in JSON Lines)', async () => {
        for (const text of [JSON.stringify([...LIST, 5]), `${shapes.lines}"text"\n`]) {
            const expected = await failureOf(() => previewImport({ format: 'json', text }));
            expect(expected.message).toMatch(/^Item 64.* is (number|text), not an object/);
            expect(await failure(previewImportFile({ format: 'json', source: utf8(text) }, TINY))).toEqual(expected);
        }
    });

    test('a row that fails names the item, and nothing is kept', async () => {
        const make = async (id) => {
            const s = await setup(id);
            s.adapter.execute('CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT CHECK (name <> \'Person 40\'), tags, active, manager, extra, joined)');
            return s;
        };
        const args = { format: 'json', target: { mode: 'append', table: 'people' } };
        for (const text of [shapes.list, shapes.lines]) {
            const whole = await make('whole-6');
            const expected = await failureOf(() => runImport(whole.adapter, { ...args, text }));
            expect(expected.message).toMatch(/^(Item 40|Row 40 \(line 40\)): CHECK constraint failed/);
            const parts = await make('parts-6');
            expect(await failure(runImportFile(parts.adapter, { ...args, source: utf8(text) }, TINY))).toEqual(expected);
            expect(parts.rows('SELECT count(*) FROM people')).toEqual([[0]]);
        }
    });
});

const PAGE = `<!DOCTYPE html>
<html><head><title>Staff <table></title>
<style>td { color: red; } /* <table><tr><td>not data</td></tr></table> */</style>
<script>const t = "<table><tr><td>not data</td></tr></table>";</script>
</head><body>
<!-- <table><tr><td>commented out</td></tr></table> -->
<table class="summary"><tr><td>Total</td><td>4</td></tr></table>
<table id="staff">
  <caption>Employees &amp; salaries</caption>
  <thead><tr><th>Employee ID</th><th>Name</th><th>Department</th><th>Salary</th></tr></thead>
  <tbody>
    <tr><td>1</td><td><b>Ada</b>  Lovelace</td><td>Engineering</td><td>120000</td></tr>
    <tr><td>2</td><td>Grace&nbsp;Hopper</td><td>Engineering<table><tr><td>inner</td></tr></table></td><td>100000.5</td></tr>
    <tr><td>3</td><td>Linus &lt;Jr.&gt;<br>Torvalds</td><td colspan="2">Sales</td></tr>
    <tr><td>4</td><td>Margaret</td><td></td></tr>
${Array.from({ length: 40 }, (_, i) => `    <tr><td>${i + 5}</td><td>Person ${i + 5}</td><td>Ops</td><td>${1000 + i}</td></tr>`).join('\n')}
  </tbody>
</table>
<table><tr><th>Only</th><th>Header</th></tr></table>
</body></html>`;

describe('HTML in parts', () => {
    test('the preview of each table is the one the whole page gives', async () => {
        for (const options of [{}, { table: 0 }, { table: 1 }, { table: 2 }]) {
            const whole = previewImport({ format: 'html', text: PAGE, options });
            expect(await previewImportFile({ format: 'html', source: utf8(PAGE), options }, TINY)).toEqual(whole);
        }
        expect(await failure(previewImportFile({ format: 'html', source: utf8(PAGE), options: { table: 3 } }, TINY)))
            .toEqual(await failureOf(() => previewImport({ format: 'html', text: PAGE, options: { table: 3 } })));
    });

    test('imports the same rows', async () => {
        const preview = previewImport({ format: 'html', text: PAGE, options: { table: 1 } });
        const target = { mode: 'new', table: 'staff', types: preview.columns.map(c => c.type) };
        const { result } = await sameRun({ format: 'html', text: PAGE, options: { table: 1 }, target }, utf8(PAGE), TINY);
        expect(result.rowsInserted).toBe(44);
    });
});

describe('progress and plumbing', () => {
    test('progress goes up to the whole file, counting both readings of a two-pass import', async () => {
        const seen = [];
        const { adapter } = await setup('progress-1');
        const preview = previewImport({ format: 'json', text: JSON.stringify(LIST) });
        await runImportFile(adapter, { format: 'json', source: utf8(JSON.stringify(LIST)), target: { mode: 'new', table: 'p', types: preview.columns.map(c => c.type) } }, { ...TINY, onProgress: (p) => seen.push(p) });
        expect(seen.length).toBeGreaterThan(1);
        expect(seen.at(-1).done).toBe(seen.at(-1).total);
        expect(seen.at(-1).total).toBe(new Blob([JSON.stringify(LIST)]).size * 2);
        for (let i = 1; i < seen.length; i++) expect(seen[i].done).toBeGreaterThanOrEqual(seen[i - 1].done);
    });

    test('a small file is read at once, as pasted text is', async () => {
        const seen = [];
        expect(await previewImportFile({ format: 'csv', source: utf8(CSV) }, { onProgress: (p) => seen.push(p) })).toEqual(previewImport({ format: 'csv', text: CSV }));
        expect(seen).toEqual([{ done: 1, total: 1 }]);
    });

    test('dispatch reads a file when it is given as `source`', async () => {
        const { adapter, rows } = await setup('dispatch-1');
        const seen = [];
        const preview = await dispatch(adapter, 'previewImport', { format: 'csv', source: utf8(CSV) }, { onProgress: (p) => seen.push(p) });
        expect(preview.rowCount).toBe(84);
        expect(seen.length).toBeGreaterThan(0);
        await dispatch(adapter, 'runImport', { format: 'csv', source: utf8(CSV), target: { mode: 'new', table: 'staff', types: preview.columns.map(c => c.type) } });
        expect(rows('SELECT count(*) FROM staff')).toEqual([[84]]);
    });

    test('a SQLite database file is added from the file itself, copied a few MB at a time', async () => {
        const source = await setup('source-1');
        source.adapter.execute("CREATE TABLE t (x); INSERT INTO t VALUES (1), (2); PRAGMA journal_mode = WAL;");
        const bytes = source.adapter.exportFile('source-1');
        const wal = new Uint8Array(bytes);
        wal[18] = 2;
        wal[19] = 2;
        const { adapter } = await setup('target-1');
        await adapter.importFile('copy-1', new Blob([wal]));
        await adapter.open('copy-1');
        expect(adapter.execute('SELECT x FROM t ORDER BY x').results[0].rows).toEqual([[1], [2]]);
        await expect(adapter.importFile('bad-2', new Blob(['not a database'.repeat(10)]))).rejects.toMatchObject({ code: 'NOT_A_DATABASE' });
        await expect(adapter.importFile('big-1', { size: MAX_FILE_BYTES + 1, slice: () => new Blob([]) })).rejects.toMatchObject({ code: 'TOO_LARGE' });
    });
});
