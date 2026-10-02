// @vitest-environment jsdom
// The SQL Lab view in the real page (index.html + app controller), with the
// real SQLite engine running in-page instead of in a worker.
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

const SCHEMA = {
    tables: [
        { name: 'Departments', columns: [{ name: 'DepartmentID', type: 'INT' }, { name: 'Name', type: 'NVARCHAR(MAX)', nullable: false }], primaryKey: ['DepartmentID'] },
        {
            name: 'Employees',
            columns: [{ name: 'EmployeeID', type: 'INT' }, { name: 'Name', type: 'VARCHAR(100)', nullable: false }, { name: 'Department', type: 'VARCHAR(50)' }, { name: 'DepartmentID', type: 'INT' }, { name: 'Salary', type: 'DECIMAL(10,2)' }],
            primaryKey: ['EmployeeID'],
            foreignKeys: [{ columns: ['DepartmentID'], refTable: 'Departments', refColumns: ['DepartmentID'] }]
        }
    ]
};

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

async function answerConfirm(confirm = true) {
    await settle();
    const dialog = $('#confirm-dialog');
    expect(dialog.hasAttribute('open')).toBe(true);
    dialog.querySelector(`[value="${confirm ? 'confirm' : 'cancel'}"]`).click();
    await settle();
}

async function newDatabase(name) {
    $('#lab-new-btn').click();
    await answerPrompt(name);
}

const listedDatabases = () => $$('#lab-db-list .lab-db-name').map(e => e.textContent);
const storedList = () => JSON.parse(backend.getItem(`${STORAGE_PREFIX}databases`) || 'null');

describe('SQL Lab view', () => {
    test('the header switches between the builder and the SQL Lab', async () => {
        boot();
        expect($('#lab').hidden).toBe(true);
        expect($('#view-builder-btn').getAttribute('aria-pressed')).toBe('true');
        await openLab();
        expect($('#lab').hidden).toBe(false);
        expect($('#workspace').hidden).toBe(true);
        expect($('#view-lab-btn').getAttribute('aria-pressed')).toBe('true');
        expect($('#undo-btn').hidden).toBe(true);
        expect(document.body.classList.contains('view-lab')).toBe(true);
        expect($('.skip-link').getAttribute('href')).toBe('#lab-heading');
        expect(document.activeElement).toBe($('#lab-heading'));
        $('#view-builder-btn').click();
        expect($('#lab').hidden).toBe(true);
        expect($('#workspace').hidden).toBe(false);
        expect($('#undo-btn').hidden).toBe(false);
        expect(document.body.classList.contains('view-lab')).toBe(false);
    });

    test('names the execution engine and its real version; storage is not warned about', async () => {
        boot();
        await openLab();
        expect(text('#lab-engine')).toBe(`Execution engine: SQLite ${sqlite3.version.libVersion}, embedded and running in this browser.`);
        expect($('#lab-notice').hidden).toBe(true);
        expect(text('.lab-note')).toContain('not identical to SQL Server, PostgreSQL or MySQL');
    });

    test('when the browser can\'t store databases, the page says they are not saved', async () => {
        boot({ persistent: false });
        await openLab();
        expect($('#lab-notice').hidden).toBe(false);
        expect(text('#lab-notice')).toContain('Not saved');
    });

    test('the engine starts only when the SQL Lab is first shown', async () => {
        boot();
        await settle();
        expect(client.state.status).toBe('idle');
        await openLab();
        expect(client.state.status).toBe('ready');
    });

    test('Android back button returns from the SQL Lab to the builder', async () => {
        boot();
        await openLab();
        expect(app.handleBack()).toBe(true);
        expect($('#lab').hidden).toBe(true);
        expect(app.handleBack()).toBe(false);
    });
});

describe('databases', () => {
    test('create a database: it is listed, opened and remembered app-wide', async () => {
        boot();
        await openLab();
        expect(text('#lab-main')).toContain('No databases yet');
        await newDatabase('Company DB');
        expect(listedDatabases()).toEqual(['Company DB']);
        expect($('#lab-db-list [aria-current="true"]').textContent).toContain('Company DB');
        expect(text('#lab-main-heading')).toBe('Company DB');
        expect(text('#lab-main')).toContain('This database is empty');
        const stored = storedList();
        expect(stored.databases.map(d => d.name)).toEqual(['Company DB']);
        expect(stored.lastOpen).toBe(stored.databases[0].id);
        expect(files.names()).toEqual([`db-${stored.databases[0].id}.sqlite3`]);
        expect(text('#toast')).toBe('Created database “Company DB”.');
    });

    test('names must be unique', async () => {
        boot();
        await openLab();
        await newDatabase('Company DB');
        await newDatabase('company db');
        expect(text('#toast')).toBe('A database named Company DB already exists.');
        expect(listedDatabases()).toEqual(['Company DB']);
    });

    test('rename, duplicate and delete (with confirmation)', async () => {
        boot();
        await openLab();
        await newDatabase('Company DB');
        $('[data-lab-action="rename"]').click();
        await answerPrompt('Shop');
        expect(listedDatabases()).toEqual(['Shop']);
        $('[data-lab-action="duplicate"]').click();
        await settle();
        expect(listedDatabases()).toEqual(['Shop', 'Shop (copy)']);
        expect(files.names()).toHaveLength(2);
        $('[data-lab-action="delete"]').click();
        await settle();
        expect(text('#confirm-dialog')).toContain('Delete Shop?');
        await answerConfirm(false);
        expect(listedDatabases()).toEqual(['Shop', 'Shop (copy)']);
        $('[data-lab-action="delete"]').click();
        await answerConfirm(true);
        expect(listedDatabases()).toEqual(['Shop (copy)']);
        expect(files.names()).toHaveLength(1);
        expect(text('#lab-main')).toContain('No database open');
    });

    test('open another database from the list; close it', async () => {
        boot();
        await openLab();
        await newDatabase('First');
        await newDatabase('Second');
        expect(text('#lab-main-heading')).toBe('Second');
        $$('#lab-db-list .lab-db-btn')[0].click();
        await settle();
        expect(text('#lab-main-heading')).toBe('First');
        expect(document.activeElement).toBe($('#lab-main-heading'));
        $('[data-lab-action="close"]').click();
        await settle();
        expect(text('#lab-main')).toContain('No database open');
        expect(storedList().lastOpen).toBeNull();
    });

    test('after a reload, the last database opens again with its tables', async () => {
        const storageBackend = createMemoryBackend();
        boot({ storageBackend, schema: SCHEMA });
        await openLab();
        $('[data-lab-action="from-schema"]').click();
        await settle();
        $('#lab-tables-create').click();
        await settle();
        boot({ storageBackend, keepFiles: true });
        await openLab();
        expect(text('#lab-main-heading')).toBe('Company DB');
        expect($$('.lab-object-name').map(e => e.textContent)).toEqual(['Departments', 'Employees']);
    });

    test('a listed database whose data is gone can be removed from the list', async () => {
        const storageBackend = createMemoryBackend();
        storageBackend.setItem(`${STORAGE_PREFIX}databases`, JSON.stringify({ lastOpen: null, databases: [{ id: 'gone1', name: 'Old', createdAt: 1, updatedAt: 1 }] }));
        boot({ storageBackend });
        await openLab();
        $('#lab-db-list .lab-db-btn').click();
        await settle();
        expect(text('#confirm-dialog')).toContain('Old can\'t be opened');
        await answerConfirm(true);
        expect(listedDatabases()).toEqual([]);
    });

    test('Delete all saved data deletes every database', async () => {
        boot();
        await openLab();
        await newDatabase('Company DB');
        await newDatabase('Other');
        $('#settings-btn').click();
        $('#clear-data-btn').click();
        await settle();
        expect(text('#confirm-dialog')).toContain('SQL Lab databases');
        await answerConfirm(true);
        expect(files.names()).toEqual([]);
        expect(backend.getItem(`${STORAGE_PREFIX}databases`)).toBeNull();
        expect(listedDatabases()).toEqual([]);
        expect(text('#toast')).toBe('All saved data was deleted from this browser.');
    });

    test('Delete all saved data does not start the engine when there are no databases', async () => {
        boot();
        $('#settings-btn').click();
        $('#clear-data-btn').click();
        await answerConfirm(true);
        expect(client.state.status).toBe('idle');
    });
});

describe('engine problems', () => {
    test('SQL Lab open in another tab: explained, with Try again; nothing can be created', async () => {
        const engine = createDirectClient(() => createSqliteAdapter(sqlite3, createMemoryFiles(sqlite3)), { storageReason: 'busy' });
        boot({ engine });
        await openLab();
        expect(text('#lab-notice')).toContain('SQL Lab is open in another tab or window');
        expect($('#lab-notice [data-lab-action="retry"]')).not.toBeNull();
        expect($('#lab-new-btn').disabled).toBe(true);
        expect(text('#lab-main')).toContain('aren\'t available');
    });

    test('Try again after the other tab closes: the saved databases come back', async () => {
        const storageBackend = createMemoryBackend();
        boot({ storageBackend });
        await openLab();
        await newDatabase('Company DB');
        const shared = files;
        let busy = true;
        const make = () => createDirectClient(() => createSqliteAdapter(sqlite3, { ...shared, persistent: true }), { storageReason: busy ? 'busy' : null });
        let inner = make();
        const engine = {
            get state() { return inner.state; },
            start: () => inner.start(),
            call: (op, args) => inner.call(op, args),
            restart: () => {
                inner = make();
                return inner.start();
            }
        };
        boot({ storageBackend, keepFiles: true, engine });
        await openLab();
        expect(text('#lab-notice')).toContain('open in another tab');
        expect(listedDatabases()).toEqual([]);
        busy = false;
        $('#lab-notice [data-lab-action="retry"]').click();
        await settle();
        expect($('#lab-notice').hidden).toBe(true);
        expect(listedDatabases()).toEqual(['Company DB']);
        expect(text('#lab-main-heading')).toBe('Company DB');
    });

    test('an engine that can\'t start is reported, with Try again', async () => {
        const engine = {
            state: { status: 'failed', info: null, error: 'WebAssembly is disabled' },
            start: () => Promise.reject(new Error('WebAssembly is disabled')),
            restart: () => Promise.reject(new Error('WebAssembly is disabled')),
            call: () => Promise.reject(new Error('unavailable'))
        };
        boot({ engine });
        await openLab();
        expect(text('#lab-notice')).toContain('The database engine couldn\'t start. WebAssembly is disabled');
        expect(text('#lab-engine')).toContain('not running');
        $('#lab-notice [data-lab-action="retry"]').click();
        await settle();
        expect(text('#lab-notice')).toContain('couldn\'t start');
    });
});

describe('creating schema tables in a database', () => {
    test('the schema button is disabled without tables', () => {
        boot();
        expect($('#schema-db-btn').disabled).toBe(true);
        boot({ schema: SCHEMA });
        expect($('#schema-db-btn').disabled).toBe(false);
    });

    test('preview, adaptations and confirm create the tables in a new database', async () => {
        boot({ schema: SCHEMA });
        $('#schema-db-btn').click();
        await settle();
        const dialog = $('#lab-tables-dialog');
        expect(dialog.hasAttribute('open')).toBe(true);
        // Nothing has run yet
        expect(files.names()).toEqual([]);
        expect($('#lab-tables-db').value).toBe('');
        expect($('#lab-tables-new-field').hidden).toBe(false);
        expect($('#lab-tables-new-name').value).toBe('Company DB');
        expect($$('#lab-tables-list input').map(b => b.checked)).toEqual([true, true]);
        const preview = $$('#lab-tables-code .line').map(l => l.textContent.replace(/\n$/, '')).join('\n');
        expect(preview).toContain('CREATE TABLE Departments (\n    DepartmentID INT PRIMARY KEY,\n    Name NVARCHAR NOT NULL\n);');
        expect(preview).toContain('FOREIGN KEY (DepartmentID) REFERENCES Departments (DepartmentID)');
        expect(text('#lab-tables-notes')).toBe('Departments.Name: SQLite can\'t read the type NVARCHAR(MAX), so it is written as NVARCHAR.');
        expect(text('#lab-tables-create')).toBe('Create 2 tables');

        $('#lab-tables-create').click();
        await settle();
        expect(dialog.hasAttribute('open')).toBe(false);
        expect($('#lab').hidden).toBe(false);
        expect(listedDatabases()).toEqual(['Company DB']);
        expect(text('#toast')).toBe('Created 2 tables in “Company DB”.');
        expect(text('.lab-objects')).toContain('Tables (2)');

        // Structure of a table, with the real row count
        $$('.lab-object-btn').find(b => b.textContent.includes('Employees')).click();
        await settle();
        expect(text('#lab-structure-title')).toBe('Employees');
        expect(text('.lab-structure-rows')).toBe('Rows: 0');
        const rows = $$('.lab-columns tbody tr').map(r => Array.from(r.children).map(c => c.textContent));
        expect(rows[0]).toEqual(['EmployeeID', 'INT', 'Yes', '', 'Primary key']);
        expect(rows[3]).toEqual(['DepartmentID', 'INT', 'No', '', '→ Departments (DepartmentID)']);

        await client.call('execute', { sql: "INSERT INTO Departments VALUES (1, 'Engineering'); INSERT INTO Employees (Name, Department, DepartmentID, Salary) VALUES ('Ada', 'Engineering', 1, 120000), ('Grace', 'Engineering', 1, 100000);" });
        $$('.lab-object-btn').find(b => b.textContent.includes('Departments')).click();
        await settle();
        $$('.lab-object-btn').find(b => b.textContent.includes('Employees')).click();
        await settle();
        expect(text('.lab-structure-rows')).toBe('Rows: 2');
    });

    test('tables the database already has are skipped', async () => {
        boot({ schema: SCHEMA });
        await openLab();
        $('[data-lab-action="from-schema"]').click();
        await settle();
        $('#lab-tables-create').click();
        await settle();
        $('[data-lab-action="from-schema"]').click();
        await settle();
        expect($('#lab-tables-db').value).not.toBe('');
        expect($$('#lab-tables-list input').map(b => b.disabled)).toEqual([true, true]);
        expect(text('#lab-tables-list')).toContain('already in this database, skipped');
        expect($('#lab-tables-create').disabled).toBe(true);
        $('#lab-tables-dialog [value="cancel"]').click();
        await settle();
    });

    test('only the chosen tables are created; none chosen means nothing to create', async () => {
        boot({ schema: SCHEMA });
        $('#schema-db-btn').click();
        await settle();
        $('#lab-tables-none').click();
        expect($('#lab-tables-create').disabled).toBe(true);
        expect(text('#lab-tables-code')).toBe('-- No tables selected');
        const [departments] = $$('#lab-tables-list input');
        departments.checked = true;
        departments.dispatchEvent(new Event('change', { bubbles: true }));
        expect(text('#lab-tables-create')).toBe('Create 1 table');
        $('#lab-tables-create').click();
        await settle();
        expect($$('.lab-object-name').map(e => e.textContent)).toEqual(['Departments']);
    });

    test('a failure creates nothing (one transaction) and removes the new database', async () => {
        boot({ schema: { tables: [{ name: 'Good', columns: ['a'] }, { name: 'Bad', columns: ['b'] }] } });
        // Make the second CREATE collide with the first, so SQLite refuses it midway
        $('#schema-db-btn').click();
        await settle();
        const realCall = client.call.bind(client);
        client.call = async (op, args) => (op === 'execute' && args.sql.startsWith('BEGIN')
            ? realCall(op, { ...args, sql: args.sql.replace('CREATE TABLE Bad', 'CREATE TABLE Good') })
            : realCall(op, args));
        $('#lab-tables-create').click();
        await settle();
        expect(text('#toast')).toMatch(/^No tables were created: table Good already exists/);
        expect(listedDatabases()).toEqual([]);
        expect(files.names()).toEqual([]);
    });

    test('a new database name is checked before anything runs', async () => {
        boot({ schema: SCHEMA });
        await openLab();
        await newDatabase('Company DB');
        $('#schema-db-btn').click();
        await settle();
        $('#lab-tables-db').value = '';
        $('#lab-tables-db').dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        $('#lab-tables-new-name').value = 'company db';
        $('#lab-tables-create').click();
        await settle();
        expect($('#lab-tables-dialog').hasAttribute('open')).toBe(true);
        expect(text('#lab-tables-error')).toBe('A database named Company DB already exists.');
        $('#lab-tables-dialog [value="cancel"]').click();
        await settle();
        expect(listedDatabases()).toEqual(['Company DB']);
    });

    test('the command palette offers the SQL Lab', async () => {
        boot({ schema: SCHEMA });
        $('#file-menu summary').click();
        document.querySelector('[data-command="palette"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await settle();
        const labels = $$('#palette-list [role="option"]').map(o => o.textContent);
        expect(labels.some(l => l.includes('Open SQL Lab'))).toBe(true);
        expect(labels.some(l => l.includes('Create schema tables in SQL Lab…'))).toBe(true);
    });
});
