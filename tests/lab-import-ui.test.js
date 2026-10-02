// @vitest-environment jsdom
// SQL Lab's Import dialog in the real page (index.html + app controller),
// with the real SQLite engine running in-page instead of in a worker.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { startApp } from '../src/app.js';
import { createStorage, createMemoryBackend, STORAGE_PREFIX } from '../src/storage.js';
import { createSqliteAdapter } from '../src/db/sqlite-adapter.js';
import { createMemoryFiles } from '../src/db/files.js';
import { createDirectClient } from '../src/db/client.js';

const html = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8');
const bodyHtml = html.replace(/^[\s\S]*?<html[^>]*>/i, '').replace(/<\/html>\s*$/i, '');

let sqlite3;
let app;
let backend;
let files;
let client;

beforeAll(async () => {
    sqlite3 = await sqlite3InitModule();
});

afterEach(() => {
    app?.destroy();
    app = null;
});

/**
 * Starts the app. `persistent` makes the in-memory files report themselves as
 * stored (as OPFS does), so the page behaves as in a supporting browser.
 */
function boot({ storageBackend = createMemoryBackend(), keepFiles = false, persistent = true, schema = null, engine = null } = {}) {
    app?.destroy();
    document.documentElement.innerHTML = bodyHtml;
    backend = storageBackend;
    if (schema) backend.setItem(`${STORAGE_PREFIX}schema`, JSON.stringify(schema));
    if (!keepFiles || !files) files = createMemoryFiles(sqlite3);
    const stored = { ...files, persistent };
    client = engine || createDirectClient(() => createSqliteAdapter(sqlite3, stored));
    app = startApp({ doc: document, storage: createStorage(backend), dbClient: client });
    return app;
}

const $ = (selector) => /** @type {any} */ (document.querySelector(selector));
const $$ = (selector) => /** @type {any[]} */ (Array.from(document.querySelectorAll(selector)));
const text = (selector) => $(selector)?.textContent.replace(/\s+/g, ' ').trim();
/** Lets the engine's promises and the re-renders finish. */
const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
};

async function openLab() {
    $('#view-lab-btn').click();
    await settle();
}

async function answerPrompt(value) {
    await settle();
    const dialog = $('#prompt-dialog');
    expect(dialog.hasAttribute('open')).toBe(true);
    $('#prompt-input').value = value;
    dialog.querySelector('[value="confirm"]').click();
    await settle();
}

async function newDatabase(name) {
    $('#lab-new-btn').click();
    await answerPrompt(name);
}

const listedDatabases = () => $$('#lab-db-list .lab-db-name').map(e => e.textContent);

const EMPLOYEES = `EmployeeID,Name,Department,Salary,HireDate
1,Ada,Engineering,120000,2019-03-04
2,Grace,Engineering,100000,2020-11-30
3,Linus,Sales,70000,2021-01-15
4,Margaret,Sales,90000,
`;

const dialog = () => $('#lab-import-dialog');
const isOpen = () => dialog().hasAttribute('open');

async function openImport() {
    $('#lab-import-btn').click();
    await settle();
    expect(isOpen()).toBe(true);
}

async function paste(value) {
    const area = $('#lab-import-text');
    area.value = value;
    area.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 350));
    await settle();
}

async function choose(file) {
    const input = $('#lab-import-file');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    await settle();
}

const tableNames = async () => (await client.call('schema')).map(o => o.name);
const query = async (sql) => {
    const run = await client.call('execute', { sql });
    if (run.error) throw new Error(run.error.message);
    return run.results.at(-1).rows;
};

describe('importing CSV', () => {
    test('preview, then Import creates the table in a new database; the success query runs', async () => {
        boot();
        await openLab();
        await openImport();
        expect($('#lab-import-db').value).toBe('');
        expect($('#lab-import-new-name').value).toBe('Company DB');
        expect($('#lab-import-run').disabled).toBe(true);
        expect(text('#lab-import-preview')).toContain('Choose a file or paste text');

        await paste(EMPLOYEES);
        expect($('#lab-import-format').value).toBe('csv');
        expect(text('#lab-import-preview')).toContain('4 rows and 5 columns. Separated by comma (detected); the first row has the column names.');
        const types = $$('#lab-import-preview select[data-column]').map(s => s.value);
        expect(types).toEqual(['INTEGER', 'TEXT', 'TEXT', 'INTEGER', 'DATE']);
        expect($$('.lab-import-sample tbody tr').length).toBe(4);
        expect($$('.lab-import-sample tbody tr')[3].lastElementChild.textContent).toBe('NULL');
        expect(text('#lab-import-notes')).toContain('Empty cells become NULL.');
        expect(text('#lab-import-run')).toBe('Import 4 rows');
        // Nothing has been created yet
        expect(files.names()).toEqual([]);

        // Salary as REAL; name the table
        const salary = $$('#lab-import-preview select[data-column]')[3];
        salary.value = 'REAL';
        salary.dispatchEvent(new Event('change', { bubbles: true }));
        const table = $('#lab-import-table');
        table.value = 'Employees';
        table.dispatchEvent(new Event('input', { bubbles: true }));
        await settle();
        const sql = $$('#lab-import-preview .lab-create-sql .line').map(l => l.textContent.replace(/\n$/, '')).join('\n');
        expect(sql).toContain('    Salary REAL,');
        expect(sql).toContain('INSERT INTO Employees (EmployeeID, Name, Department, Salary, HireDate) VALUES (?, ?, ?, ?, ?);');

        $('#lab-import-run').click();
        await settle();
        expect(isOpen()).toBe(false);
        expect(listedDatabases()).toEqual(['Company DB']);
        expect(text('#toast')).toBe('Imported 4 rows into Employees in “Company DB”.');
        expect(text('#lab-structure-title')).toBe('Employees');
        expect(text('.lab-structure-rows')).toBe('Rows: 4');
        expect(await query('SELECT Department, AVG(Salary) AS AvgSalary FROM Employees GROUP BY Department ORDER BY AvgSalary DESC;'))
            .toEqual([['Engineering', 110000], ['Sales', 80000]]);
    });

    test('rows go into an existing table, matched by column name', async () => {
        boot();
        await openLab();
        await newDatabase('Company DB');
        await query('CREATE TABLE People (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
        await openImport();
        expect($('#lab-import-db').value).not.toBe('');
        await paste('NAME;ID\nAda;1\nGrace;2\n');
        expect(text('#lab-import-preview')).toContain('Separated by semicolon (detected)');
        dialog().querySelector('input[value="append"]').click();
        await settle();
        expect($('#lab-import-append-table').value).toBe('People');
        expect(text('#lab-import-preview')).toContain('Goes into name (TEXT)');
        $('#lab-import-run').click();
        await settle();
        expect(isOpen()).toBe(false);
        expect(await query('SELECT id, name FROM People ORDER BY id')).toEqual([[1, 'Ada'], [2, 'Grace']]);
    });

    test('a column the table doesn\'t have, or a taken table name, stops Import before anything runs', async () => {
        boot();
        await openLab();
        await newDatabase('Company DB');
        await query('CREATE TABLE People (id INTEGER PRIMARY KEY)');
        await openImport();
        await paste('id,age\n1,30\n');
        const table = $('#lab-import-table');
        table.value = 'people';
        table.dispatchEvent(new Event('input', { bubbles: true }));
        await settle();
        expect($('#lab-import-run').disabled).toBe(true);
        dialog().querySelector('input[value="append"]').click();
        await settle();
        expect(text('#lab-import-preview')).toContain('People has no column with this name');
        expect($('#lab-import-run').disabled).toBe(true);
    });

    test('malformed CSV is refused with the row and line', async () => {
        boot();
        await openLab();
        await openImport();
        await paste('a,b\n1,2\n3\n');
        expect(text('#lab-import-preview')).toContain('This can\'t be imported: Row 2 (line 3) has 1 value, but the header has 2.');
        expect($('#lab-import-run').disabled).toBe(true);
    });

    test('a failing row keeps nothing and says why in the dialog', async () => {
        boot();
        await openLab();
        await newDatabase('Company DB');
        await query('CREATE TABLE People (id INTEGER PRIMARY KEY, name TEXT)');
        await openImport();
        await paste('id,name\n1,Ada\n1,Grace\n');
        dialog().querySelector('input[value="append"]').click();
        await settle();
        $('#lab-import-run').click();
        await settle();
        expect(isOpen()).toBe(true);
        expect(text('#lab-import-error')).toBe('Nothing was imported: Row 2 (line 3): UNIQUE constraint failed: People.id');
        expect(await query('SELECT COUNT(*) FROM People')).toEqual([[0]]);
    });
});

describe('importing JSON and SQL', () => {
    test('JSON: nested values are kept as JSON text and said so', async () => {
        boot();
        await openLab();
        await newDatabase('Shop');
        $$('.lab-main-actions button').find(b => b.textContent === 'Import…').click();
        await settle();
        expect(isOpen()).toBe(true);
        await paste('[{"sku": "007", "tags": ["a", "b"], "inStock": true}, {"sku": "010", "inStock": false}]');
        expect($('#lab-import-format').value).toBe('json');
        expect($$('#lab-import-preview select[data-column]').map(s => s.value)).toEqual(['TEXT', 'TEXT', 'BOOLEAN']);
        expect(text('#lab-import-notes')).toContain('1 value is a nested object or list; it is stored as JSON text.');
        $('#lab-import-table').value = 'Products';
        $('#lab-import-table').dispatchEvent(new Event('input', { bubbles: true }));
        $('#lab-import-run').click();
        await settle();
        expect(await query('SELECT sku, tags, inStock FROM Products')).toEqual([['007', '["a","b"]', 1], ['010', null, 0]]);
    });

    test('SQL: statements are listed and flagged; nothing runs until Run', async () => {
        boot();
        await openLab();
        await newDatabase('Company DB');
        await openImport();
        await paste(`BEGIN TRANSACTION;
CREATE TABLE Departments (id INTEGER PRIMARY KEY, name TEXT);
INSERT INTO Departments VALUES (1, 'Engineering'), (2, 'Sales');
SELECT TOP 1 * FROM Departments;
COMMIT;`);
        expect($('#lab-import-format').value).toBe('sql');
        expect($('#lab-import-table-options').hidden).toBe(true);
        const items = $$('.lab-import-statements > li').map(li => li.querySelector('.lab-import-statement').textContent);
        expect(items).toEqual(['BEGIN TRANSACTION', 'CREATE TABLE Departments', 'INSERT INTO Departments', 'SELECT', 'COMMIT']);
        expect(text('#lab-import-preview')).toContain('3 statements to run, 2 left out (see below), 2 rows of values.');
        expect(text('#lab-import-preview')).toContain('Line 4, column 8: SQLite has no TOP.');
        expect(text('#lab-import-notes')).toContain('BEGIN and COMMIT statements are left out');
        expect(text('#lab-import-run')).toBe('Run 3 statements');
        expect(await tableNames()).toEqual([]);

        // It fails at TOP: nothing is kept, the dialog says where
        $('#lab-import-run').click();
        await settle();
        expect(isOpen()).toBe(true);
        expect(text('#lab-import-error')).toMatch(/^Nothing was imported: near "1": syntax error \(line 4, column \d+\)$/);
        expect(await tableNames()).toEqual([]);

        await paste("CREATE TABLE Departments (id INTEGER PRIMARY KEY, name TEXT);\nINSERT INTO Departments VALUES (1, 'Engineering'), (2, 'Sales');");
        $('#lab-import-run').click();
        await settle();
        expect(isOpen()).toBe(false);
        expect(text('#toast')).toBe('Ran 2 statements in “Company DB”; 2 rows changed.');
        expect(text('.lab-objects')).toContain('Departments');
    });

    test('a failed import into a new database doesn\'t leave that database behind', async () => {
        boot();
        await openLab();
        await newDatabase('Company DB');
        await openImport();
        const db = $('#lab-import-db');
        db.value = '';
        db.dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        expect($('#lab-import-new-field').hidden).toBe(false);
        $('#lab-import-new-name').value = 'Scratch';
        await paste('CREATE TABLE a (x);\nINSERT INTO nowhere VALUES (1);');
        $('#lab-import-run').click();
        await settle();
        expect(text('#lab-import-error')).toBe('Nothing was imported: no such table: nowhere (line 2, column 1)');
        expect(listedDatabases()).toEqual(['Company DB']);
        expect(files.names().length).toBe(1);
    });
});

describe('importing a SQLite database file', () => {
    test('a .sqlite file becomes a new database, checked first', async () => {
        boot();
        await openLab();
        await newDatabase('Source');
        await query("CREATE TABLE t (x TEXT); INSERT INTO t VALUES ('kept');");
        const id = app.lab.databases.list()[0].id;
        const bytes = await client.call('exportFile', { id });
        await openImport();
        await choose(new File([bytes], 'shop.sqlite'));
        expect($('#lab-import-format').value).toBe('sqlite');
        expect($('#lab-import-db-field').hidden).toBe(true);
        expect($('#lab-import-new-name').value).toBe('shop');
        expect(text('#lab-import-file-name')).toMatch(/^shop\.sqlite \(\d+ KB\)$/);
        expect(text('#lab-import-run')).toBe('Add database');
        $('#lab-import-run').click();
        await settle();
        expect(text('#lab-import-error')).toBe('');
        expect(isOpen()).toBe(false);
        expect(listedDatabases()).toEqual(['shop', 'Source']);
        expect(text('#toast')).toBe('Added database “shop” with 1 table.');
        expect(await query('SELECT x FROM t')).toEqual([['kept']]);
    });

    test('a file that isn\'t a database is refused', async () => {
        boot();
        await openLab();
        await openImport();
        await choose(new File(['not a database at all'.repeat(10)], 'fake.sqlite'));
        expect(text('#lab-import-preview')).toContain('fake.sqlite isn\'t a SQLite database file.');
        expect($('#lab-import-run').disabled).toBe(true);
    });

    test('a CSV file is read and named after its file', async () => {
        boot();
        await openLab();
        await openImport();
        await choose(new File([EMPLOYEES], 'staff.csv', { type: 'text/csv' }));
        expect($('#lab-import-paste-field').hidden).toBe(true);
        expect($('#lab-import-table').value).toBe('staff');
        expect(text('#lab-import-preview')).toContain('4 rows and 5 columns.');
        $('#lab-import-clear').click();
        await settle();
        expect($('#lab-import-paste-field').hidden).toBe(false);
    });
});
