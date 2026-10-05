// @vitest-environment jsdom
// Running SQL in SQL Lab in the real page (index.html + app controller),
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
import { createWebPlatform } from '../src/platform/web.js';

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
function boot({ storageBackend = createMemoryBackend(), keepFiles = false, persistent = true, schema = null, engine = null, platform = undefined } = {}) {
    app?.destroy();
    document.documentElement.innerHTML = bodyHtml;
    backend = storageBackend;
    if (schema) backend.setItem(`${STORAGE_PREFIX}schema`, JSON.stringify(schema));
    if (!keepFiles || !files) files = createMemoryFiles(sqlite3);
    const stored = { ...files, persistent };
    client = engine || createDirectClient(() => createSqliteAdapter(sqlite3, stored));
    app = startApp({ doc: document, storage: createStorage(backend), dbClient: client, platform });
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



const query = async (sql) => {
    const run = await client.call('execute', { sql });
    if (run.error) throw new Error(run.error.message);
    return run.results.at(-1).rows;
};

async function typeSql(value) {
    const area = $('#lab-sql');
    area.value = value;
    area.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 350));
    await settle();
}

async function run() {
    $('#lab-run-btn').click();
    await settle();
}

const tab = () => $('.lab-tab[aria-selected="true"]')?.dataset.tab;
const gridRows = (i = 0) => [...$$('.lab-result')[i].querySelectorAll('tbody tr')].map(tr => [...tr.children].map(td => td.textContent));

const SETUP = `CREATE TABLE Employees (EmployeeID INTEGER PRIMARY KEY, Name TEXT, Department TEXT, Salary REAL);
INSERT INTO Employees VALUES (1, 'Ada', 'Engineering', 120000), (2, 'Grace', 'Engineering', 100000),
  (3, 'Linus', 'Sales', 70000), (4, 'Margaret', 'Sales', 90000), (5, 'Ken', 'Support', 60000);`;
const SUCCESS = 'SELECT Department, AVG(Salary) AS AvgSalary FROM Employees GROUP BY Department ORDER BY AvgSalary DESC;';

describe('running SQL', () => {
    test('the success path: create Company DB, create Employees, run the average-salary query', async () => {
        boot();
        await openLab();
        expect($('#lab-console').hidden).toBe(true); // nothing to run in yet
        await newDatabase('Company DB');
        expect($('#lab-console').hidden).toBe(false);
        expect(tab()).toBe('table');
        expect(text('#lab-run-hint')).toContain('Runs in “Company DB”');
        expect($('#lab-run-btn').disabled).toBe(true); // empty editor

        await typeSql(SETUP);
        await run();
        expect(tab()).toBe('messages');
        expect(text('.lab-message-summary')).toMatch(/^2 statements ran in [\d.,]+ ms, 5 rows changed\.$/);
        expect(text('.lab-messages')).toContain('Query completed successfully. 5 rows affected.');
        // The explorer shows the new table
        expect($$('#lab-objects .lab-object-name').map(e => e.textContent)).toEqual(['Employees']);

        await typeSql(SUCCESS);
        await run();
        expect(tab()).toBe('results');
        expect($$('.lab-result thead th').map(th => th.textContent)).toEqual(['Department', 'AvgSalary']);
        expect(gridRows()).toEqual([['Engineering', '110000'], ['Sales', '80000'], ['Support', '60000']]);
        expect(text('.lab-result-status')).toBe('3 rows returned');
        expect(text('.lab-result-time')).toMatch(/ms$/);

        // History has both runs, newest first, and can put SQL back in the editor
        $('#lab-tab-history').click();
        await settle();
        expect($$('.lab-history-sql').map(e => e.textContent)).toEqual([SUCCESS, SETUP]);
        await typeSql('');
        $('[data-console-action="history-open"]').click();
        await settle();
        expect($('#lab-sql').value).toBe(SUCCESS);
        // Each database keeps its SQL across a reload
        const keep = backend;
        boot({ storageBackend: keep, keepFiles: true });
        await openLab();
        await settle();
        expect($('#lab-sql').value).toBe(SUCCESS);
        await run();
        expect(gridRows()).toHaveLength(3);
    });

    test('errors say where; earlier statements are kept; a selection runs alone', async () => {
        boot();
        await openLab();
        await newDatabase('Errors');
        await typeSql('CREATE TABLE t (a INTEGER);\nINSERT INTO t VALUES (1);\nSELECT nope FROM t;\nINSERT INTO t VALUES (2);');
        await run();
        expect(tab()).toBe('messages');
        expect(text('.lab-message-error')).toContain('Line 3, column 8');
        expect(text('.lab-message-error')).toContain('no such column: nope');
        expect(text('#lab-panel')).toContain('The 2 statements before the error ran');
        const area = $('#lab-sql');
        // The editor selects where the error is
        expect(area.value.slice(area.selectionStart, area.selectionEnd)).toBe('nope');
        expect(await query('SELECT COUNT(*) FROM t')).toEqual([[1]]);

        // Run only a selected statement; its error positions count from the full text
        const start = area.value.indexOf('SELECT nope');
        area.setSelectionRange(start, start + 'SELECT nope FROM t;'.length);
        area.dispatchEvent(new Event('select'));
        expect(text('#lab-run-btn')).toBe('Run selection');
        await run();
        expect(text('.lab-message-error')).toContain('Line 3, column 8');
        expect(await query('SELECT COUNT(*) FROM t')).toEqual([[1]]);
        area.setSelectionRange(0, 0);
        area.dispatchEvent(new Event('select'));

        // History marks the failed run
        $('#lab-tab-history').click();
        await settle();
        expect($$('.lab-history-item.is-error').length).toBe(2);
    });

    test('Load more pages through a large result up to 1,000 rows; the table row count keeps the cursor', async () => {
        boot();
        await openLab();
        await newDatabase('Big');
        await typeSql('CREATE TABLE n (i INTEGER);\nWITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 1500) INSERT INTO n SELECT i FROM c;');
        await run();
        await typeSql('SELECT i FROM n ORDER BY i;');
        await run();
        expect(text('.lab-result-status')).toBe('First 100 rows shown; more available');
        // Selecting the table counts its rows without closing the result's cursor
        $('#lab-objects [data-lab-action="select"]').click();
        await settle();
        expect(text('.lab-structure-rows')).toBe('Rows: 1,500');
        $('#lab-tab-results').click();
        await settle();
        $('[data-lab-action="more"]').click();
        await settle();
        expect(gridRows()).toHaveLength(200);
        expect(gridRows()[199]).toEqual(['200']);
        for (let i = 0; i < 12 && $('[data-lab-action="more"]'); i++) {
            $('[data-lab-action="more"]').click();
            await settle();
        }
        expect(gridRows()).toHaveLength(1000);
        expect(text('#lab-panel')).toContain('Showing the first 1,000 rows');
    });

    test('transactions: the chip shows while one is open; ROLLBACK undoes', async () => {
        boot();
        await openLab();
        await newDatabase('Tx');
        await typeSql('CREATE TABLE t (a);');
        await run();
        await typeSql('BEGIN;\nINSERT INTO t VALUES (1);');
        await run();
        expect($('#lab-transaction').hidden).toBe(false);
        expect(text('#lab-panel')).toContain('A transaction is open');
        await typeSql('ROLLBACK;');
        await run();
        expect($('#lab-transaction').hidden).toBe(true);
        expect(await query('SELECT COUNT(*) FROM t')).toEqual([[0]]);
    });

    test('notices point out what SQLite may reject, without changing the SQL', async () => {
        boot();
        await openLab();
        await newDatabase('Notices');
        const sql = 'SELECT TOP 5 GETDATE() FROM t;';
        await typeSql(sql);
        expect($('#lab-sql-notices').hidden).toBe(false);
        expect(text('#lab-sql-notices')).toContain('SQLite has no GETDATE() function');
        expect($('#lab-sql').value).toBe(sql);
        await typeSql('SELECT 1;');
        expect($('#lab-sql-notices').hidden).toBe(true);
    });

    test('Ctrl+Enter runs in SQL Lab and generates in the builder', async () => {
        boot();
        await openLab();
        await newDatabase('Keys');
        await typeSql('SELECT 42 AS answer;');
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
        await settle();
        expect(gridRows()).toEqual([['42']]);
        $('#lab-sql').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
        await settle();
        $('#lab-tab-history').click();
        await settle();
        expect($$('.lab-history-item').length).toBe(1);
    });
});

describe('saving SQL as a file', () => {
    /** A browser platform that records saved files instead of downloading them. */
    function recordingPlatform() {
        const saved = [];
        const platform = createWebPlatform(document);
        platform.saveFile = async (file) => {
            saved.push(file);
            return { status: 'saved' };
        };
        return { platform, saved };
    }

    test('Save as .sql and Save as .txt save the editor\'s SQL, exactly as typed, under the chosen name', async () => {
        const { platform, saved } = recordingPlatform();
        boot({ platform });
        await openLab();
        await newDatabase('Adventure Works');
        expect($('#lab-save-sql-btn').disabled).toBe(true);
        expect($('#lab-save-txt-btn').disabled).toBe(true);

        await typeSql('Select * from DimAccount');
        expect($('#lab-save-sql-btn').disabled).toBe(false);
        $('#lab-save-sql-btn').click();
        await settle();
        expect($('#prompt-input').value).toBe('Adventure Works query.sql');
        await answerPrompt('Accounts');
        expect(saved).toEqual([{ filename: 'Accounts.sql', text: 'Select * from DimAccount\n', mimeType: 'application/sql' }]);
        expect(text('#toast')).toBe('Saved Accounts.sql.');

        // The whole editor is saved, even when part of it is selected
        await typeSql('SELECT 1;\nSELECT 2;\n');
        $('#lab-sql').setSelectionRange(0, 9);
        $('#lab-save-txt-btn').click();
        await settle();
        expect($('#prompt-input').value).toBe('Adventure Works query.txt');
        await answerPrompt('notes: q1/q2.sql');
        expect(saved[1]).toEqual({ filename: 'notes q1 q2.txt', text: 'SELECT 1;\nSELECT 2;\n', mimeType: 'text/plain' });

        // Cancelling saves nothing
        $('#lab-save-sql-btn').click();
        await settle();
        $('#prompt-dialog').querySelector('[value="cancel"]').click();
        await settle();
        expect(saved).toHaveLength(2);
    });

    test('Ctrl+S saves a .sql file in SQL Lab and still saves the query in the builder', async () => {
        const { platform, saved } = recordingPlatform();
        boot({ platform });
        await openLab();
        await newDatabase('Keys');
        await typeSql('SELECT 42 AS answer;');
        $('#lab-sql').dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
        await answerPrompt('Keys query.sql');
        expect(saved).toEqual([{ filename: 'Keys query.sql', text: 'SELECT 42 AS answer;\n', mimeType: 'application/sql' }]);

        // Nothing to save says so
        await typeSql('   ');
        $('#lab-save-sql-btn').disabled = false;
        $('#lab-save-sql-btn').click();
        await settle();
        expect($('#prompt-dialog').hasAttribute('open')).toBe(false);
        expect(text('#toast')).toBe('Type some SQL to save first.');

        // In the builder, Ctrl+S is the builder's Save query, not a file
        $('#view-builder-btn').click();
        await settle();
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
        await settle();
        expect(saved).toHaveLength(1);
    });
});

describe('Open in SQL Lab', () => {
    const fill = async (path, value) => {
        const input = $(`[data-path="${path}"]:is(input, select)`);
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 200));
        await settle();
    };
    const pickDialect = async (id) => {
        $('#dialect-select').value = id;
        $('#dialect-select').dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
    };

    test('Query Builder → Generate SQL → Open in SQL Lab → Run → results', async () => {
        boot();
        await openLab();
        await newDatabase('Company DB');
        await typeSql(SETUP);
        await run();
        $('#view-builder-btn').click();
        await settle();

        await fill('select.from.table', 'Employees');
        await fill('select.columns.0.expr', 'Name');
        $('#generate-btn').click();
        await settle();
        $('#open-in-lab-btn').click();
        await settle();
        expect($('#lab').hidden).toBe(false);
        expect($('#lab-sql').value).toBe('SELECT Name\nFROM Employees;');
        expect($('#lab-sql-from').hidden).toBe(true); // Generic SQL: no dialect note
        expect(document.activeElement).toBe($('#lab-sql'));
        await run();
        expect(gridRows().map(r => r[0])).toEqual(['Ada', 'Grace', 'Linus', 'Margaret', 'Ken']);
    });

    test('SQL for another dialect is opened as generated, with the Generic version offered', async () => {
        boot();
        await openLab();
        await newDatabase('Company DB');
        await typeSql(SETUP);
        await run();
        $('#view-builder-btn').click();
        await settle();
        await pickDialect('sqlserver');
        await fill('select.from.table', 'Employees');
        await fill('select.columns.0.expr', 'Name');
        await fill('select.limit', '2');
        $('#open-in-lab-btn').click();
        await settle();
        const opened = $('#lab-sql').value;
        expect(opened).toContain('TOP');
        expect(text('#lab-sql-from')).toContain('generated for Microsoft SQL Server');
        expect(text('#lab-sql-notices')).toContain('TOP');
        await run();
        expect(tab()).toBe('messages');
        expect(text('.lab-message-error')).toMatch(/syntax error|no such column/);

        $('[data-console-action="generic"]').click();
        await settle();
        expect($('#lab-sql').value).toContain('LIMIT 2');
        expect($('#lab-sql-from').hidden).toBe(true);
        await run();
        expect(gridRows()).toEqual([['Ada'], ['Grace']]);
    });

    test('with no database open, the SQL waits in the editor for the next one', async () => {
        boot();
        await fill('select.from.table', 'Employees');
        await fill('select.columns.0.expr', 'Name');
        $('#open-in-lab-btn').click();
        await settle();
        expect($('#lab-console').hidden).toBe(false);
        expect($('#lab-run-btn').disabled).toBe(true);
        expect(text('#lab-run-hint')).toBe('Open or create a database to run SQL.');
        await newDatabase('Company DB');
        expect($('#lab-sql').value).toContain('FROM Employees');
        expect(Object.values(JSON.parse(backend.getItem(`${STORAGE_PREFIX}lab-drafts`)))).toEqual([$('#lab-sql').value]);
    });

    test('nothing to open says so', async () => {
        boot();
        $('#open-in-lab-btn').click();
        await settle();
        expect($('#lab').hidden).toBe(true);
        expect(text('#toast')).toContain('Nothing to open yet');
    });
});

describe('clearing data', () => {
    test('Delete all saved data also clears SQL Lab history and SQL drafts', async () => {
        boot();
        await openLab();
        await newDatabase('Gone');
        await typeSql('SELECT 1;');
        await run();
        expect(backend.getItem(`${STORAGE_PREFIX}lab-history`)).not.toBe(null);
        expect(backend.getItem(`${STORAGE_PREFIX}lab-drafts`)).not.toBe(null);
        $('#settings-btn').click();
        $('#clear-data-btn').click();
        await settle();
        $('#confirm-dialog [value="confirm"]').click();
        await settle();
        expect(backend.getItem(`${STORAGE_PREFIX}lab-history`)).toBe(null);
        expect(backend.getItem(`${STORAGE_PREFIX}lab-drafts`)).toBe(null);
        expect($('#lab-sql').value).toBe('');
    });
});
