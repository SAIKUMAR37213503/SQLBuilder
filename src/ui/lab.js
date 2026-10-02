// The SQL Lab view: the databases kept in this browser (create, open,
// rename, duplicate, delete), what each contains (tables, views and their
// columns), creating the Schema tab's tables in a database, and importing
// SQL, CSV, JSON or SQLite files (lab-import.js).
//
// The engine runs in a worker (see db/client.js) and starts the first time
// the SQL Lab is shown, so the builder never pays for it.

import { h, formatTime } from './dom.js';
import { renderSqlCode } from './output.js';
import { formDialog, confirmDialog, promptDialog } from './dialogs.js';
import { createDatabaseList, DatabaseListError } from '../db/databases.js';
import { sqliteCreateTables, sqliteName, sqliteTableName } from '../db/schema-sql.js';
import { createStorage, createMemoryBackend } from '../storage.js';
import { createImportDialog } from './lab-import.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** An engine error as a sentence, with where it happened when known. */
export function describeError(error) {
    const e = /** @type {any} */ (error);
    const message = e?.message || String(e);
    return typeof e?.line === 'number' ? `${message} (line ${e.line}, column ${e.column})` : message;
}

/**
 * @param {{
 *   doc: Document,
 *   storage: any,
 *   client: any,
 *   dialogs: { prompt: any, confirm: any, tables: any, import?: any },
 *   toast: (message: string, kind?: string) => void,
 *   schemaTables: () => any[],
 *   isNative?: boolean,
 *   onShow?: () => void
 * }} options
 */
export function createLab({ doc, storage, client, dialogs, toast, schemaTables, isNative = false, onShow = () => {} }) {
    const $ = (id) => /** @type {any} */ (doc.getElementById(id));
    const el = {
        view: $('lab'),
        heading: $('lab-heading'),
        engine: $('lab-engine'),
        notice: $('lab-notice'),
        newBtn: $('lab-new-btn'),
        importBtn: $('lab-import-btn'),
        list: $('lab-db-list'),
        objects: $('lab-objects'),
        main: $('lab-main')
    };
    const where = isNative ? 'on this device' : 'in this browser';

    let databases = createDatabaseList(storage);
    const state = {
        /** @type {string | null} */
        open: null,
        /** @type {any[] | null} tables and views of the open database */
        objects: null,
        /** @type {string | null} */
        selected: null,
        /** @type {{ rows: number | null, error: string | null } | null} */
        selectedCount: null,
        busy: false,
        started: false
    };

    // ------------------------------------------------------------ engine

    const engineState = () => client.state;
    const usable = () => {
        const s = engineState();
        return s.status === 'ready' && s.info && s.info.storageReason !== 'busy';
    };

    let memoryList = false;

    /** Starts the engine (once); never throws. */
    async function start() {
        try {
            if (engineState().status !== 'ready') await client.start();
            const info = engineState().info;
            if (info && !info.persistent && info.storageReason === 'unsupported' && !memoryList) {
                // Nothing survives a reload: keep this visit's databases apart from the saved list
                databases = createDatabaseList(createStorage(createMemoryBackend()));
                memoryList = true;
            }
            return true;
        } catch {
            return false;
        } finally {
            render();
        }
    }

    /** Try again: a new engine, with the saved list. */
    async function retry() {
        state.open = null;
        state.objects = null;
        state.selected = null;
        databases = createDatabaseList(storage);
        memoryList = false;
        try {
            await client.restart();
        } catch {
            // start() below reports it
        }
        await start();
        if (usable() && databases.lastOpen) await task(() => openDatabase(databases.lastOpen, { quiet: true }));
    }

    /** Runs one database action at a time (errors are the caller's to show). */
    async function exclusive(work) {
        if (state.busy) throw new Error('Another database action is still running.');
        state.busy = true;
        el.view.setAttribute('aria-busy', 'true');
        render();
        try {
            return await work();
        } finally {
            state.busy = false;
            el.view.removeAttribute('aria-busy');
            render();
        }
    }

    /** Runs one database action at a time; errors become a message. */
    async function task(work) {
        if (state.busy) return undefined;
        try {
            return await exclusive(work);
        } catch (error) {
            toast(error instanceof DatabaseListError ? error.message : describeError(error), 'error');
            return undefined;
        }
    }

    async function loadObjects() {
        state.objects = await client.call('schema');
        if (state.selected && !state.objects.some(o => o.name === state.selected)) state.selected = null;
        await countSelected();
    }

    async function countSelected() {
        state.selectedCount = null;
        if (!state.selected) return;
        try {
            const run = await client.call('execute', { sql: `SELECT COUNT(*) FROM ${sqliteName(state.selected)}`, pageSize: 1 });
            state.selectedCount = run.error ? { rows: null, error: run.error.message } : { rows: Number(run.results[0].rows[0][0]), error: null };
        } catch (error) {
            state.selectedCount = { rows: null, error: describeError(error) };
        }
    }

    async function openDatabase(id, { quiet = false } = {}) {
        const entry = databases.get(id);
        if (!entry) return;
        try {
            await client.call('open', { id });
        } catch (error) {
            if (/** @type {any} */ (error)?.code === 'MISSING') {
                if (quiet) {
                    databases.setLastOpen(null);
                    return;
                }
                const remove = await confirmDialog(dialogs.confirm, {
                    title: `${entry.name} can't be opened`,
                    message: `Its data isn't ${where} any more, for example because site data was cleared. Remove it from the list?`,
                    confirmText: 'Remove from list'
                });
                if (remove) databases.remove(id);
                return;
            }
            throw error;
        }
        state.open = id;
        state.selected = null;
        databases.setLastOpen(id);
        await loadObjects();
    }

    // ----------------------------------------------------------- actions

    const askName = (title, value, confirmText) => promptDialog(dialogs.prompt, { title, label: 'Database name', value, confirmText });

    function newDatabase() {
        return task(async () => {
            if (!(await start()) || !usable()) return;
            const name = await askName('New database', freeName('Company DB'), 'Create');
            if (name === null) return;
            const prepared = databases.prepare(name);
            await client.call('create', { id: prepared.id });
            databases.add(prepared);
            await openDatabase(prepared.id);
            toast(`Created database “${prepared.name}”.`, 'success');
        });
    }

    function renameDatabase(id) {
        return task(async () => {
            const entry = databases.get(id);
            if (!entry) return;
            const name = await askName(`Rename ${entry.name}`, entry.name, 'Rename');
            if (name === null || name.trim() === entry.name) return;
            const renamed = databases.rename(id, name);
            toast(`Renamed to “${renamed.name}”.`, 'success');
        });
    }

    function duplicateDatabase(id) {
        return task(async () => {
            const entry = databases.get(id);
            if (!entry) return;
            const prepared = databases.prepare(databases.copyName(entry.name));
            await client.call('duplicate', { from: id, to: prepared.id });
            databases.add(prepared);
            toast(`Copied “${entry.name}” to “${prepared.name}”.`, 'success');
        });
    }

    function deleteDatabase(id) {
        return task(async () => {
            const entry = databases.get(id);
            if (!entry) return;
            const ok = await confirmDialog(dialogs.confirm, {
                title: `Delete ${entry.name}?`,
                message: `Its tables and data are deleted from ${where}. This can't be undone.`,
                confirmText: 'Delete database'
            });
            if (!ok) return;
            await client.call('remove', { id });
            databases.remove(id);
            if (state.open === id) {
                state.open = null;
                state.objects = null;
                state.selected = null;
            }
            toast(`Deleted database “${entry.name}”.`, 'success');
        });
    }

    function closeDatabase() {
        return task(async () => {
            await client.call('close');
            state.open = null;
            state.objects = null;
            state.selected = null;
            databases.setLastOpen(null);
        });
    }

    function selectObject(name) {
        return task(async () => {
            state.selected = name;
            await countSelected();
        }).then(() => {
            doc.getElementById('lab-main-heading')?.focus();
        });
    }

    function freeName(base) {
        if (!databases.list().some(d => d.name.toLowerCase() === base.toLowerCase())) return base;
        for (let n = 2; ; n++) {
            const name = `${base} ${n}`;
            if (!databases.list().some(d => d.name.toLowerCase() === name.toLowerCase())) return name;
        }
    }

    /** Whether the engine can take an action now; says why not. */
    async function ready() {
        if (!(await start()) || !usable()) {
            toast(engineState().info?.storageReason === 'busy'
                ? 'SQL Lab is open in another tab or window. Close it there, then try again.'
                : 'The database engine isn\'t available in this browser.', 'error');
            return false;
        }
        return true;
    }

    // ------------------------------------------------------------ import

    const importer = dialogs.import ? createImportDialog({
        dialog: dialogs.import,
        client,
        toast,
        lab: {
            databases: () => databases,
            state,
            ready,
            openDatabase,
            loadObjects,
            exclusive,
            freeName,
            async select(name) {
                state.selected = name;
                await countSelected();
            },
            render: () => render(),
            where
        }
    }) : null;

    async function importData() {
        if (!importer) return;
        const imported = await importer.open();
        if (imported) {
            show();
            doc.getElementById(state.selected ? 'lab-structure-title' : 'lab-main-heading')?.focus();
        }
    }

    // ------------------------------------------- Schema tables -> database

    /** The Create tables dialog: choose a database and tables, see the SQL, confirm. */
    async function createTablesFromSchema() {
        const tables = schemaTables();
        if (tables.length === 0) {
            toast('The schema has no tables yet. Add or import tables in the Schema tab first.');
            return;
        }
        if (state.busy || !(await ready())) return;
        const dialog = dialogs.tables;
        const $d = (id) => /** @type {any} */ (dialog.querySelector(`#${id}`));
        const select = $d('lab-tables-db');
        const newField = $d('lab-tables-new-field');
        const newName = $d('lab-tables-new-name');
        const list = $d('lab-tables-list');
        const notes = $d('lab-tables-notes');
        const code = $d('lab-tables-code');
        const error = $d('lab-tables-error');
        const submit = $d('lab-tables-create');
        /** @type {Set<string>} lower-cased names of tables the chosen database already has */
        let existing = new Set();
        let loading = 0;

        select.replaceChildren(
            ...databases.list().map(d => h('option', { value: d.id }, d.name)),
            h('option', { value: '' }, 'New database…'));
        select.value = state.open && databases.get(state.open) ? state.open : (databases.lastOpen || '');
        newName.value = freeName('Company DB');
        error.textContent = '';

        list.replaceChildren(...tables.map((t, i) => h('li', {},
            h('label', { class: 'check' },
                h('input', { type: 'checkbox', value: String(i), checked: true }),
                h('span', { class: 'lab-check-name' }, t.name),
                h('span', { class: 'lab-check-state' })))));
        const boxes = () => /** @type {any[]} */ ([...list.querySelectorAll('input[type="checkbox"]')]);

        function chosen() {
            return boxes().filter(b => b.checked && !b.disabled).map(b => tables[Number(b.value)]);
        }

        function update() {
            newField.hidden = select.value !== '';
            for (const box of boxes()) {
                const there = existing.has(sqliteTableName(tables[Number(box.value)].name).toLowerCase());
                box.disabled = there;
                if (there) box.checked = false;
                box.closest('label').querySelector('.lab-check-state').textContent = there ? 'already in this database, skipped' : '';
            }
            const picked = chosen();
            const ddl = sqliteCreateTables(picked);
            renderSqlCode(code, picked.length ? ddl.sql : '-- No tables selected');
            notes.replaceChildren(...ddl.notes.map(n => h('li', {}, n)));
            notes.hidden = ddl.notes.length === 0;
            submit.disabled = picked.length === 0 || loading > 0;
            submit.textContent = picked.length ? `Create ${plural(picked.length, 'table')}` : 'Create tables';
        }

        async function loadExisting() {
            existing = new Set();
            const id = select.value;
            if (!id) return update();
            loading++;
            update();
            try {
                await openDatabase(id, { quiet: true });
                existing = new Set((state.objects || []).map(o => o.name.toLowerCase()));
            } catch (e) {
                error.textContent = describeError(e);
            } finally {
                loading--;
                update();
                render();
            }
        }

        const onChange = (event) => {
            error.textContent = '';
            if (event.target === select) loadExisting();
            else update();
        };
        const onClick = (event) => {
            const all = event.target.closest('#lab-tables-all');
            const none = event.target.closest('#lab-tables-none');
            if (!all && !none) return;
            for (const box of boxes()) if (!box.disabled) box.checked = Boolean(all);
            update();
        };
        dialog.addEventListener('change', onChange);
        dialog.addEventListener('click', onClick);
        let target = null;
        try {
            update();
            loadExisting();
            const ok = await formDialog(dialog, {
                onOpen: () => select.focus(),
                validate: () => {
                    if (loading > 0 || chosen().length === 0) return false;
                    try {
                        target = select.value ? { id: select.value } : { prepared: databases.prepare(newName.value) };
                        return true;
                    } catch (e) {
                        error.textContent = e.message;
                        newName.focus();
                        return false;
                    }
                }
            });
            if (!ok) return;
            const picked = chosen();
            await task(() => runCreate(target, picked));
        } finally {
            dialog.removeEventListener('change', onChange);
            dialog.removeEventListener('click', onClick);
        }
    }

    async function runCreate(target, picked) {
        let id = target.id;
        let created = false;
        if (target.prepared) {
            await client.call('create', { id: target.prepared.id });
            databases.add(target.prepared);
            id = target.prepared.id;
            created = true;
        }
        await openDatabase(id);
        const { sql } = sqliteCreateTables(picked);
        const run = await client.call('execute', { sql: `BEGIN;\n${sql}\nCOMMIT;` });
        if (run.error) {
            if (run.inTransaction) await client.call('execute', { sql: 'ROLLBACK;' });
            if (created) {
                await client.call('remove', { id });
                databases.remove(id);
                state.open = null;
                state.objects = null;
            } else {
                await loadObjects();
            }
            // Line numbers count from the first CREATE, as shown in the preview
            const line = typeof run.error.line === 'number' ? run.error.line - 1 : null;
            toast(`No tables were created: ${run.error.message}${line ? ` (line ${line} of the SQL)` : ''}`, 'error');
            return;
        }
        databases.touch(id);
        await loadObjects();
        show();
        toast(`Created ${plural(picked.length, 'table')} in “${databases.get(id)?.name}”.`, 'success');
    }

    // ------------------------------------------------------------ render

    function renderEngine() {
        const s = engineState();
        const info = s.info;
        if (s.status === 'ready' && info) {
            el.engine.textContent = `Execution engine: ${info.engine} ${info.version}, embedded and running ${where}.`;
        } else if (s.status === 'failed') {
            el.engine.textContent = 'Execution engine: SQLite, embedded (not running).';
        } else {
            el.engine.textContent = 'Execution engine: SQLite, embedded (starting…).';
        }

        const notice = [];
        if (s.status === 'failed') {
            notice.push(h('p', {}, h('strong', {}, 'The database engine couldn\'t start. '), s.error || ''),
                h('button', { type: 'button', class: 'btn btn-secondary btn-sm', dataset: { labAction: 'retry' } }, 'Try again'));
        } else if (s.status === 'ready' && info?.storageReason === 'busy') {
            notice.push(h('p', {}, h('strong', {}, 'SQL Lab is open in another tab or window. '),
                'Its databases can be used in one place at a time. Close SQL Lab there (or close that tab), then select Try again.'),
            h('button', { type: 'button', class: 'btn btn-secondary btn-sm', dataset: { labAction: 'retry' } }, 'Try again'));
        } else if (s.status === 'ready' && info && !info.persistent) {
            notice.push(h('p', {}, h('strong', {}, 'Not saved: '),
                `this browser can't store databases, so the ones you create here are lost when you close or reload the page.`));
        }
        el.notice.replaceChildren(...notice);
        el.notice.hidden = notice.length === 0;
        el.notice.className = `lab-notice${s.status === 'failed' || info?.storageReason === 'busy' ? ' lab-notice-error' : ' lab-notice-warning'}`;
    }

    function renderList() {
        const ready = usable();
        el.newBtn.disabled = !ready || state.busy;
        if (el.importBtn) {
            el.importBtn.disabled = !ready || state.busy;
            el.importBtn.hidden = !importer;
        }
        const items = databases.list();
        if (!ready) {
            el.list.replaceChildren();
            return;
        }
        if (items.length === 0) {
            el.list.replaceChildren(h('li', { class: 'lab-empty-hint' }, 'No databases yet.'));
            return;
        }
        el.list.replaceChildren(...items.map(d => {
            const current = d.id === state.open;
            return h('li', { class: `lab-db${current ? ' is-open' : ''}` },
                h('button', {
                    type: 'button', class: 'lab-db-btn', dataset: { labAction: 'open', id: d.id },
                    'aria-current': current ? 'true' : null, disabled: state.busy
                },
                h('span', { class: 'lab-db-name' }, d.name),
                h('span', { class: 'lab-db-meta' }, current ? 'Open' : (d.updatedAt ? `Changed ${formatTime(d.updatedAt)}` : ''))));
        }));
    }

    function renderObjects() {
        if (!usable() || !state.open || !state.objects) {
            el.objects.replaceChildren();
            return;
        }
        const group = (type, title) => {
            const items = state.objects.filter(o => o.type === type);
            if (items.length === 0) return null;
            return h('div', { class: 'lab-object-group' },
                h('h4', { class: 'lab-subheading' }, `${title} (${items.length})`),
                h('ul', { class: 'lab-object-list' }, items.map(o => h('li', {},
                    h('button', {
                        type: 'button', class: 'lab-object-btn', dataset: { labAction: 'select', name: o.name },
                        'aria-current': o.name === state.selected ? 'true' : null, disabled: state.busy
                    }, h('span', { class: 'lab-object-name' }, o.name), h('span', { class: 'lab-object-meta' }, plural(o.columns.length, 'column')))))));
        };
        const tables = group('table', 'Tables');
        const views = group('view', 'Views');
        el.objects.replaceChildren(...(tables || views ? [tables, views].filter(Boolean) : [h('p', { class: 'lab-empty-hint' }, 'No tables yet.')]));
    }

    function actionButton(text, action, label, variant = 'ghost', extra = {}) {
        return h('button', { type: 'button', class: `btn btn-${variant} btn-sm`, 'aria-label': label, dataset: { labAction: action, ...extra }, disabled: state.busy }, text);
    }

    function renderMain() {
        const s = engineState();
        if (!usable()) {
            el.main.replaceChildren(h('h3', { id: 'lab-main-heading', class: 'visually-hidden', tabindex: '-1' }, 'Database'),
                h('p', { class: 'lab-empty-hint' }, s.status === 'starting' || s.status === 'idle' ? 'Starting the database engine…' : 'Databases aren\'t available right now.'));
            return;
        }
        const entry = state.open ? databases.get(state.open) : null;
        const hasSchema = schemaTables().length > 0;
        if (!entry) {
            const none = databases.size === 0;
            el.main.replaceChildren(h('div', { class: 'empty-state lab-empty' },
                h('h3', { class: 'empty-title', id: 'lab-main-heading', tabindex: '-1' }, none ? 'No databases yet' : 'No database open'),
                h('p', {}, none
                    ? `Create a database, or import a SQL, CSV, JSON or SQLite file, to keep tables and data ${where}.`
                    : 'Open a database from the list, or create a new one.'),
                h('div', { class: 'empty-actions' },
                    h('button', { type: 'button', class: 'btn btn-primary btn-sm', dataset: { labAction: 'new' }, disabled: state.busy }, 'New database…'),
                    importer ? h('button', { type: 'button', class: 'btn btn-secondary btn-sm', dataset: { labAction: 'import' }, disabled: state.busy }, 'Import a file…') : null,
                    hasSchema ? h('button', { type: 'button', class: 'btn btn-secondary btn-sm', dataset: { labAction: 'from-schema' }, disabled: state.busy }, 'Create your schema\'s tables…') : null)));
            return;
        }
        const header = h('div', { class: 'lab-main-head' },
            h('h3', { id: 'lab-main-heading', class: 'lab-db-title', tabindex: '-1' }, entry.name),
            h('div', { class: 'lab-main-actions' },
                importer ? actionButton('Import…', 'import', `Import SQL, CSV or JSON into ${entry.name}`, 'secondary') : null,
                hasSchema ? actionButton('Add schema tables…', 'from-schema', `Create tables from your schema in ${entry.name}`, 'secondary') : null,
                actionButton('Rename…', 'rename', `Rename ${entry.name}`, 'ghost', { id: entry.id }),
                actionButton('Duplicate', 'duplicate', `Duplicate ${entry.name}`, 'ghost', { id: entry.id }),
                actionButton('Close', 'close', `Close ${entry.name}`),
                actionButton('Delete…', 'delete', `Delete ${entry.name}`, 'danger-ghost', { id: entry.id })));
        const object = state.selected ? state.objects?.find(o => o.name === state.selected) : null;
        if (!object) {
            const count = state.objects?.length || 0;
            el.main.replaceChildren(header, count
                ? h('p', { class: 'lab-empty-hint' }, `${plural(state.objects.filter(o => o.type === 'table').length, 'table')}${state.objects.some(o => o.type === 'view') ? ` and ${plural(state.objects.filter(o => o.type === 'view').length, 'view')}` : ''}. Select one to see its columns.`)
                : h('div', { class: 'empty-state' },
                    h('p', { class: 'empty-title' }, 'This database is empty'),
                    h('p', {}, hasSchema
                        ? 'Import a SQL script, CSV or JSON file, or create the tables from your schema.'
                        : 'Import a SQL script, CSV or JSON file, or add tables in the Schema tab and create them here.'),
                    h('div', { class: 'empty-actions' },
                        importer ? h('button', { type: 'button', class: 'btn btn-primary btn-sm', dataset: { labAction: 'import' }, disabled: state.busy }, 'Import data…') : null,
                        hasSchema ? h('button', { type: 'button', class: `btn ${importer ? 'btn-secondary' : 'btn-primary'} btn-sm`, dataset: { labAction: 'from-schema' }, disabled: state.busy }, 'Create your schema\'s tables…') : null)));
            return;
        }
        el.main.replaceChildren(header, renderStructure(object));
    }

    function renderStructure(object) {
        const count = state.selectedCount;
        const rows = count === null ? 'Counting rows…' : count.error ? `Rows: unknown (${count.error})` : `Rows: ${count.rows.toLocaleString()}`;
        const fkFor = (column) => object.foreignKeys.find(fk => fk.columns.includes(column));
        return h('section', { class: 'lab-structure', 'aria-labelledby': 'lab-structure-title' },
            h('div', { class: 'lab-structure-head' },
                h('h4', { id: 'lab-structure-title', class: 'lab-structure-title' }, object.name),
                h('span', { class: 'library-chip' }, object.type === 'view' ? 'View' : 'Table'),
                h('span', { class: 'lab-structure-rows' }, rows)),
            h('div', { class: 'lab-table-scroll', tabindex: '0', role: 'region', 'aria-label': `Columns of ${object.name}` },
                h('table', { class: 'lab-columns' },
                    h('thead', {}, h('tr', {}, ['Column', 'Type', 'Required', 'Default', 'Key'].map(t => h('th', { scope: 'col' }, t)))),
                    h('tbody', {}, object.columns.map(c => {
                        const fk = fkFor(c.name);
                        const key = [c.primaryKey ? 'Primary key' : '', fk ? `→ ${fk.refTable}${fk.refColumns.length ? ` (${fk.refColumns.join(', ')})` : ''}` : ''].filter(Boolean).join(', ');
                        return h('tr', {},
                            h('th', { scope: 'row' }, c.name),
                            h('td', {}, c.type || h('span', { class: 'muted' }, 'none')),
                            h('td', {}, c.notNull || c.primaryKey ? 'Yes' : 'No'),
                            h('td', {}, c.defaultValue === null || c.defaultValue === undefined ? '' : String(c.defaultValue)),
                            h('td', {}, key));
                    })))),
            object.sql ? h('details', { class: 'lab-create-sql' },
                h('summary', {}, object.type === 'view' ? 'CREATE VIEW statement' : 'CREATE TABLE statement'),
                (() => {
                    const code = h('code', {});
                    renderSqlCode(code, `${object.sql};`);
                    return h('pre', { class: 'sql-output', tabindex: '0', 'aria-label': `How ${object.name} was created` }, code);
                })()) : null);
    }

    function render() {
        renderEngine();
        renderList();
        renderObjects();
        renderMain();
    }

    // ------------------------------------------------------------ wiring

    el.view.addEventListener('click', (event) => {
        const button = /** @type {any} */ (event.target).closest('[data-lab-action]');
        if (!button || button.disabled) return;
        const { labAction: action, id, name } = button.dataset;
        if (action === 'open') {
            if (id === state.open) return;
            task(() => openDatabase(id)).then(() => doc.getElementById('lab-main-heading')?.focus());
        } else if (action === 'new') newDatabase();
        else if (action === 'rename') renameDatabase(id);
        else if (action === 'duplicate') duplicateDatabase(id);
        else if (action === 'delete') deleteDatabase(id);
        else if (action === 'close') closeDatabase();
        else if (action === 'select') selectObject(name);
        else if (action === 'from-schema') createTablesFromSchema();
        else if (action === 'import') importData();
        else if (action === 'retry') retry();
    });
    el.newBtn.addEventListener('click', newDatabase);
    el.importBtn?.addEventListener('click', importData);

    function show() {
        const first = !state.started;
        state.started = true;
        onShow();
        render();
        if (first) {
            start().then(async () => {
                if (usable() && databases.lastOpen && !state.open) await task(() => openDatabase(databases.lastOpen, { quiet: true }));
            });
        }
    }

    return {
        show,
        render,
        createTablesFromSchema,
        importData,
        get databases() { return databases; },
        get state() { return { ...state }; },

        /** Deletes every database (Delete all saved data). Returns false when some couldn't be deleted. */
        async clearAll() {
            const any = databases.size > 0 || engineState().status === 'ready';
            state.open = null;
            state.objects = null;
            state.selected = null;
            if (!any) {
                databases.clear();
                return true;
            }
            let ok = true;
            try {
                await start();
                if (usable()) await client.call('removeAll');
                else ok = false;
            } catch {
                ok = false;
            }
            databases.clear();
            render();
            return ok;
        }
    };
}
