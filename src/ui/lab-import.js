// The SQL Lab's Import dialog: a SQL script, CSV or JSON into a database, or
// a SQLite database file as a new database. The file is read in the page,
// then the database worker previews it (statements, columns, the first rows)
// without changing anything. Only Import runs it, as one transaction; when it
// fails, the dialog stays open with the reason and nothing is kept.

import { h, debounce } from './dom.js';
import { showDialog, closeDialog } from './dialogs.js';
import { renderSqlCode } from './output.js';
import { detectFormat, tableNameFor, MAX_IMPORT_BYTES } from '../db/importer.js';
import { COLUMN_TYPES, TYPE_LABELS, createTableSql, insertSql } from '../db/import-types.js';
import { delimiterName } from '../db/import-csv.js';
import { isSqliteFile } from '../db/files.js';

const plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString()} ${n === 1 ? one : many}`;

function sizeText(bytes) {
    if (bytes < 1024) return `${bytes} bytes`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** An error as a sentence, with where it happened when the message doesn't say. */
function errorText(error) {
    const e = /** @type {any} */ (error);
    const message = e?.message || String(e);
    return typeof e?.line === 'number' && !/\bline \d/.test(message) ? `${message} (line ${e.line}${typeof e.column === 'number' ? `, column ${e.column}` : ''})` : message;
}

/**
 * @param {{
 *   dialog: any,
 *   client: any,
 *   lab: {
 *     databases: () => any,
 *     state: any,
 *     ready: () => Promise<boolean>,
 *     openDatabase: (id: string, options?: { quiet?: boolean }) => Promise<void>,
 *     loadObjects: () => Promise<void>,
 *     exclusive: (work: () => Promise<any>) => Promise<any>,
 *     freeName: (base: string) => string,
 *     select: (name: string | null) => Promise<void>,
 *     render: () => void,
 *     where: string
 *   },
 *   toast: (message: string, kind?: string) => void
 * }} options
 */
export function createImportDialog({ dialog, client, lab, toast }) {
    const $ = (id) => /** @type {any} */ (dialog.querySelector(`#${id}`));
    const el = {
        fileBtn: $('lab-import-file-btn'),
        fileName: $('lab-import-file-name'),
        clear: $('lab-import-clear'),
        file: $('lab-import-file'),
        pasteField: $('lab-import-paste-field'),
        text: $('lab-import-text'),
        format: $('lab-import-format'),
        formatHint: $('lab-import-format-hint'),
        dbField: $('lab-import-db-field'),
        db: $('lab-import-db'),
        newField: $('lab-import-new-field'),
        newName: $('lab-import-new-name'),
        csvOptions: $('lab-import-csv-options'),
        delimiter: $('lab-import-delimiter'),
        header: $('lab-import-header'),
        tableOptions: $('lab-import-table-options'),
        table: $('lab-import-table'),
        append: $('lab-import-append'),
        appendTable: $('lab-import-append-table'),
        preview: $('lab-import-preview'),
        notes: $('lab-import-notes'),
        error: $('lab-import-error'),
        run: $('lab-import-run')
    };
    const fileEmptyText = el.fileName.textContent;

    /** @type {{ name: string, size: number, text: string | null, bytes: Uint8Array | null } | null} */
    let file = null;
    /** @type {any} the worker's preview, or null */
    let preview = null;
    /** @type {string | null} why the preview failed */
    let previewError = null;
    let loading = 0;
    let running = false;
    let sequence = 0;
    /** @type {string[]} chosen types of a new table's columns */
    let types = [];
    /** @type {string[]} the column names those types are for */
    let typesFor = [];
    let formatPicked = false;
    let tableEdited = false;

    const mode = () => (dialog.querySelector('input[name="lab-import-mode"]:checked')?.value === 'append' ? 'append' : 'new');
    const format = () => el.format.value;
    const tabular = () => format() === 'csv' || format() === 'json';
    const sourceText = () => (file ? file.text : el.text.value);
    const objects = () => (el.db.value && lab.state.open === el.db.value ? lab.state.objects || [] : []);
    const tables = () => objects().filter(o => o.type === 'table');

    function freeTableName(base) {
        const taken = new Set(objects().map(o => o.name.toLowerCase()));
        if (!taken.has(base.toLowerCase())) return base;
        for (let n = 2; ; n++) if (!taken.has(`${base}_${n}`.toLowerCase())) return `${base}_${n}`;
    }

    // ----------------------------------------------------------- source

    async function readFile(chosen) {
        el.error.textContent = '';
        if (chosen.size > MAX_IMPORT_BYTES) {
            el.error.textContent = `${chosen.name} is ${sizeText(chosen.size)}; files up to ${MAX_IMPORT_BYTES / 1024 / 1024} MB can be imported.`;
            return;
        }
        try {
            const head = new Uint8Array(await chosen.slice(0, 100).arrayBuffer());
            const database = isSqliteFile(head) || detectFormat({ name: chosen.name }) === 'sqlite';
            const bytes = database ? new Uint8Array(await chosen.arrayBuffer()) : null;
            file = { name: chosen.name, size: chosen.size, text: database ? null : await chosen.text(), bytes };
        } catch {
            el.error.textContent = `${chosen.name} couldn't be read.`;
            return;
        }
        formatPicked = false;
        tableEdited = false;
        el.format.value = detectFormat({ name: file.name, text: file.text || '', bytes: file.bytes || undefined });
        if (el.format.value === 'sqlite' && el.db.value) el.db.value = '';
        if (el.format.value === 'sqlite') el.newName.value = lab.freeName(tableNameFor(file.name));
        el.table.value = freeTableName(tableNameFor(file.name));
        update();
        refresh();
    }

    function clearFile() {
        file = null;
        el.file.value = '';
        formatPicked = false;
        update();
        refresh();
        el.fileBtn.focus();
    }

    // ---------------------------------------------------------- preview

    async function refresh() {
        const id = ++sequence;
        preview = null;
        previewError = null;
        const text = sourceText();
        if (format() === 'sqlite') {
            render();
            return;
        }
        if (!text || !text.trim()) {
            render();
            return;
        }
        loading++;
        render();
        try {
            const options = { delimiter: el.delimiter.value, header: el.header.checked };
            const result = await client.call('previewImport', { format: format(), text, options });
            if (id !== sequence) return;
            preview = result;
            if (tabular()) {
                const names = result.columns.map(c => c.name);
                // Keep types already chosen for the same columns
                types = names.map((name, i) => (typesFor[i] === name && types[i] ? types[i] : result.columns[i].type));
                typesFor = names;
            }
        } catch (error) {
            if (id !== sequence) return;
            previewError = errorText(error);
        } finally {
            loading--;
            if (id === sequence) render();
        }
    }
    const refreshSoon = debounce(refresh, 300);

    // ----------------------------------------------------------- checks

    /** Why Import can't run yet, or null. */
    function blocker() {
        if (loading > 0) return 'Reading…';
        if (format() === 'sqlite') {
            if (!file || !file.bytes) return 'Choose a SQLite database file.';
            if (!isSqliteFile(file.bytes)) return `${file.name} isn't a SQLite database file.`;
            return null;
        }
        if (!sourceText()?.trim()) return file ? `${file.name} is empty.` : 'Choose a file or paste text first.';
        if (previewError) return previewError;
        if (!preview || preview.format !== format()) return 'Reading…';
        if (tabular()) {
            if (mode() === 'append') {
                const table = tables().find(t => t.name === el.appendTable.value);
                if (!table) return 'Choose the table to add the rows to.';
                const missing = unmatched(table);
                if (missing.length) return `${table.name} has no ${missing.length === 1 ? 'column' : 'columns'} named ${missing.join(', ')}.`;
            } else {
                const name = el.table.value.trim();
                if (!name) return 'Enter a name for the new table.';
                if (/^sqlite_/i.test(name)) return 'Table names starting with "sqlite_" are reserved by SQLite.';
                const taken = objects().find(o => o.name.toLowerCase() === name.toLowerCase());
                if (taken) return `This database already has a ${taken.type} named ${taken.name}. Choose another name, or add the rows to it.`;
            }
        }
        return null;
    }

    function unmatched(table) {
        const names = new Set(table.columns.map(c => c.name.toLowerCase()));
        return (preview?.columns || []).map(c => c.name).filter(n => !names.has(n.toLowerCase()));
    }

    // ----------------------------------------------------------- render

    function update() {
        const sqlite = format() === 'sqlite';
        el.fileName.textContent = file ? `${file.name} (${sizeText(file.size)})` : fileEmptyText;
        el.clear.hidden = !file;
        el.pasteField.hidden = Boolean(file);
        for (const option of el.format.options) {
            option.disabled = option.value === 'sqlite' ? !(file && file.bytes) : Boolean(file && file.bytes);
        }
        el.dbField.hidden = sqlite;
        el.newField.hidden = !sqlite && el.db.value !== '';
        el.csvOptions.hidden = format() !== 'csv';
        el.tableOptions.hidden = !tabular();
        const appendable = tables();
        el.append.disabled = appendable.length === 0;
        if (el.append.disabled && el.append.checked) dialog.querySelector('input[name="lab-import-mode"][value="new"]').checked = true;
        const chosenAppend = el.appendTable.value;
        el.appendTable.replaceChildren(...appendable.map(t => h('option', { value: t.name }, t.name)));
        if (appendable.some(t => t.name === chosenAppend)) el.appendTable.value = chosenAppend;
        el.appendTable.disabled = mode() !== 'append';
        el.table.disabled = mode() !== 'new';
        el.formatHint.textContent = file
            ? (formatPicked ? '' : `Detected from the file.`)
            : '';
    }

    function render() {
        update();
        const reason = blocker();
        el.run.disabled = running || reason !== null;
        el.run.textContent = runLabel();
        renderPreview();
        renderNotes();
    }

    function runLabel() {
        if (running) return 'Importing…';
        if (format() === 'sqlite') return 'Add database';
        if (!preview || preview.format !== format()) return 'Import';
        if (format() === 'sql') return `Run ${plural(preview.statements, 'statement')}`;
        return `Import ${plural(preview.rowCount, 'row')}`;
    }

    function renderPreview() {
        const parts = [];
        if (loading > 0) parts.push(h('p', { class: 'lab-import-status' }, 'Reading…'));
        else if (format() === 'sqlite') {
            if (file && file.bytes) {
                parts.push(isSqliteFile(file.bytes)
                    ? h('p', { class: 'lab-import-status' }, `${file.name}: a SQLite database file, ${sizeText(file.size)}. It is added as a new database (a copy), and your other databases aren't changed. It's checked for damage before it's added.`)
                    : h('p', { class: 'lab-import-status lab-import-problem' }, `${file.name} isn't a SQLite database file.`));
            } else {
                parts.push(h('p', { class: 'lab-import-status' }, 'Choose a SQLite database file (.sqlite, .sqlite3 or .db).'));
            }
        } else if (previewError) {
            parts.push(h('p', { class: 'lab-import-status lab-import-problem' }, h('strong', {}, 'This can\'t be imported: '), previewError));
        } else if (preview && preview.format === format()) {
            parts.push(...(format() === 'sql' ? sqlPreview(preview) : tablePreview(preview)));
        } else if (!sourceText()?.trim()) {
            parts.push(h('p', { class: 'lab-import-status' }, 'Choose a file or paste text, and you\'ll see what will be imported here.'));
        }
        el.preview.replaceChildren(...parts);
    }

    function sqlPreview(p) {
        const existing = new Set(objects().map(o => o.name.toLowerCase()));
        const conflicts = p.creates.filter(c => !c.ifNotExists && existing.has(c.name.toLowerCase()));
        const summary = [
            `${plural(p.statements, 'statement')} to run`,
            p.skipped ? `${p.skipped.toLocaleString()} left out (see below)` : null,
            p.rows ? `${plural(p.rows, 'row')} of values` : null
        ].filter(Boolean).join(', ');
        const list = h('ol', { class: 'lab-import-statements' }, p.groups.map(g => h('li', { class: g.skip ? 'is-skipped' : (g.issues.length ? 'has-issues' : '') },
            h('span', { class: 'lab-import-statement' }, g.label),
            h('span', { class: 'lab-import-meta' }, [
                g.count > 1 ? `${g.count.toLocaleString()} statements` : null,
                g.rows ? plural(g.rows, 'row') + ' of values' : null,
                `line ${g.line.toLocaleString()}`,
                g.skip ? 'left out' : null
            ].filter(Boolean).join(' · ')),
            g.issues.length ? h('ul', { class: 'lab-import-issues' }, g.issues.map(i => h('li', {}, `Line ${i.line}, column ${i.column}: ${i.message}`))) : null)));
        return [
            h('p', { class: 'lab-import-status' }, `${summary}.`),
            p.issues ? h('p', { class: 'lab-import-status lab-import-warning' }, `${plural(p.issues, 'part')} of this script ${p.issues === 1 ? 'is' : 'are'} likely to fail in SQLite (marked below). If a statement fails, nothing is kept and you'll see which one.`) : null,
            conflicts.length ? h('p', { class: 'lab-import-status lab-import-warning' }, `This database already has ${conflicts.map(c => c.name).join(', ')}, so ${conflicts.length === 1 ? 'its CREATE statement' : 'their CREATE statements'} will fail. Import into a new database, or remove ${conflicts.length === 1 ? 'that table' : 'those tables'} first.`) : null,
            h('div', { class: 'lab-import-scroll', tabindex: '0', role: 'region', 'aria-label': 'Statements in the script' }, list),
            p.more ? h('p', { class: 'lab-import-status' }, `And ${plural(p.more, 'more group')} of statements.`) : null
        ].filter(Boolean);
    }

    function tablePreview(p) {
        const append = mode() === 'append' ? tables().find(t => t.name === el.appendTable.value) : null;
        const how = p.format === 'csv'
            ? `Separated by ${delimiterName(p.delimiter)}${el.delimiter.value === 'auto' ? ' (detected)' : ''}; ${p.header ? 'the first row has the column names' : 'no header row'}.`
            : 'Read from JSON.';
        const head = h('p', { class: 'lab-import-status' }, `${plural(p.rowCount, 'row')} and ${plural(p.columns.length, 'column')}. ${how}`);
        const columnRows = p.columns.map((c, i) => {
            if (append) {
                const target = append.columns.find(t => t.name.toLowerCase() === c.name.toLowerCase());
                return h('tr', {},
                    h('th', { scope: 'row' }, c.name),
                    h('td', { colspan: '2' }, target
                        ? `Goes into ${target.name}${target.type ? ` (${target.type})` : ''}`
                        : h('span', { class: 'lab-import-problem' }, `${append.name} has no column with this name`)));
            }
            const type = types[i] || c.type;
            const off = c.nonEmpty - (c.fits[type] ?? c.nonEmpty);
            const select = h('select', { class: 'select select-sm', 'aria-label': `Type of ${c.name}`, dataset: { column: String(i) } },
                COLUMN_TYPES.filter(t => t !== 'BOOLEAN' || c.fits.BOOLEAN > 0 || type === 'BOOLEAN').map(t => h('option', { value: t, selected: t === type }, t)));
            const note = c.nonEmpty === 0
                ? 'No values (all empty)'
                : off > 0
                    ? `${plural(off, 'value')} of ${c.nonEmpty.toLocaleString()} ${off === 1 ? "doesn't" : "don't"} look like ${TYPE_LABELS[type]}. SQLite stores them anyway, as text or numbers.`
                    : (type === c.type ? 'Suggested from the values' : '');
            return h('tr', {}, h('th', { scope: 'row' }, c.name), h('td', {}, select), h('td', { class: off > 0 ? 'lab-import-warning' : 'muted' }, note));
        });
        const missingInFile = append ? append.columns.filter(t => !p.columns.some(c => c.name.toLowerCase() === t.name.toLowerCase())) : [];
        const columns = h('div', { class: 'lab-table-scroll', tabindex: '0', role: 'region', 'aria-label': 'Columns' },
            h('table', { class: 'lab-columns' },
                h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Column'), h('th', { scope: 'col' }, append ? 'In the table' : 'Type'), append ? null : h('th', { scope: 'col' }, 'Values'))),
                h('tbody', {}, columnRows)));
        const shown = p.sample.length;
        const sample = h('div', { class: 'lab-table-scroll lab-import-sample', tabindex: '0', role: 'region', 'aria-label': `First ${shown} rows` },
            h('table', { class: 'lab-columns lab-data' },
                h('thead', {}, h('tr', {}, p.columns.map(c => h('th', { scope: 'col' }, c.name)))),
                h('tbody', {}, p.sample.map(row => h('tr', {}, row.map(v => (v === null ? h('td', { class: 'lab-null' }, 'NULL') : h('td', {}, String(v)))))))));
        const sql = append ? null : (() => {
            const code = h('code', {});
            const name = el.table.value.trim() || 'new_table';
            renderSqlCode(code, `${createTableSql(name, p.columns.map((c, i) => ({ name: c.name, type: types[i] || c.type })))}\n${insertSql(name, p.columns.map(c => c.name))}`);
            return h('details', { class: 'lab-create-sql' },
                h('summary', {}, 'SQL that will run'),
                h('p', { class: 'field-hint' }, `The INSERT runs once for each of the ${plural(p.rowCount, 'row')}, with the row's values bound to the ? marks (values are never written into SQL).`),
                h('pre', { class: 'sql-output lab-sql-preview', tabindex: '0', 'aria-label': 'SQL that will run' }, code));
        })();
        return [
            head,
            columns,
            missingInFile.length ? h('p', { class: 'lab-import-status' }, `Not in the file, so left to their default (or NULL): ${missingInFile.map(t => t.name).join(', ')}.`) : null,
            h('p', { class: 'lab-import-status' }, shown < p.rowCount ? `The first ${shown} of ${plural(p.rowCount, 'row')}:` : `All ${plural(shown, 'row')}:`),
            sample,
            sql
        ].filter(Boolean);
    }

    function renderNotes() {
        const notes = [];
        if (preview && preview.format === format()) notes.push(...preview.notes);
        if (format() === 'sql' && preview) notes.push('Results of SELECT statements in the script aren\'t shown in an import.');
        el.notes.replaceChildren(...notes.map(n => h('li', {}, n)));
        el.notes.hidden = notes.length === 0;
    }

    // -------------------------------------------------------------- run

    async function changeDatabase() {
        const id = el.db.value;
        if (id) {
            loading++;
            render();
            try {
                await lab.openDatabase(id, { quiet: true });
            } catch (error) {
                el.error.textContent = errorText(error);
            } finally {
                loading--;
                lab.render();
            }
        }
        if (!tableEdited && tabular()) el.table.value = freeTableName(file ? tableNameFor(file.name) : el.table.value || 'imported_data');
        render();
    }

    async function run() {
        if (running || blocker()) return false;
        el.error.textContent = '';
        let prepared = null;
        try {
            prepared = format() === 'sqlite' || !el.db.value ? lab.databases().prepare(el.newName.value) : null;
        } catch (error) {
            el.error.textContent = error.message;
            el.newName.focus();
            return false;
        }
        running = true;
        render();
        try {
            await lab.exclusive(() => (format() === 'sqlite' ? addDatabase(prepared) : importInto(prepared)));
            return true;
        } catch (error) {
            el.error.textContent = `Nothing was imported: ${errorText(error)}`;
            return false;
        } finally {
            running = false;
            render();
        }
    }

    async function addDatabase(prepared) {
        await client.call('importFile', { id: prepared.id, bytes: file.bytes });
        lab.databases().add(prepared);
        await lab.openDatabase(prepared.id);
        lab.databases().touch(prepared.id);
        const count = (lab.state.objects || []).filter(o => o.type === 'table').length;
        toast(`Added database “${prepared.name}” with ${plural(count, 'table')}.`, 'success');
    }

    async function importInto(prepared) {
        const databases = lab.databases();
        let id = el.db.value;
        if (prepared) {
            await client.call('create', { id: prepared.id });
            databases.add(prepared);
            id = prepared.id;
        }
        const target = mode() === 'append'
            ? { mode: 'append', table: el.appendTable.value }
            : { mode: 'new', table: el.table.value.trim(), types: preview.columns?.map((c, i) => types[i] || c.type) };
        let result;
        try {
            await lab.openDatabase(id);
            result = await client.call('runImport', { format: format(), text: sourceText(), options: { delimiter: el.delimiter.value, header: el.header.checked }, target });
        } catch (error) {
            if (prepared) {
                // The database made for this import goes too
                await client.call('remove', { id }).catch(() => {});
                databases.remove(id);
                lab.state.open = null;
                lab.state.objects = null;
            } else {
                await lab.loadObjects().catch(() => {});
            }
            throw error;
        }
        databases.touch(id);
        await lab.loadObjects();
        const name = databases.get(id)?.name;
        if (result.format === 'sql') {
            await lab.select(null);
            toast(`Ran ${plural(result.statements, 'statement')} in “${name}”${result.rowsAffected ? `; ${plural(result.rowsAffected, 'row')} changed` : ''}.`, 'success');
        } else {
            await lab.select(result.table);
            toast(`Imported ${plural(result.rowsInserted, 'row')} into ${result.table} in “${name}”.`, 'success');
        }
    }

    // ----------------------------------------------------------- wiring

    const listeners = [
        [el.fileBtn, 'click', () => el.file.click()],
        [el.file, 'change', () => {
            const chosen = el.file.files && el.file.files[0];
            if (chosen) readFile(chosen);
        }],
        [el.clear, 'click', clearFile],
        [el.text, 'input', () => {
            if (!formatPicked) el.format.value = detectFormat({ text: el.text.value });
            if (!tableEdited) el.table.value = freeTableName('imported_data');
            update();
            refreshSoon();
        }],
        [el.format, 'change', () => {
            formatPicked = true;
            refresh();
        }],
        [el.db, 'change', () => {
            el.error.textContent = '';
            changeDatabase();
        }],
        [el.delimiter, 'change', refresh],
        [el.header, 'change', refresh],
        [el.table, 'input', () => {
            tableEdited = true;
            render();
        }],
        [el.appendTable, 'change', render],
        [el.newName, 'input', () => {
            el.error.textContent = '';
        }],
        [el.preview, 'change', (event) => {
            const select = event.target.closest('select[data-column]');
            if (!select) return;
            types[Number(select.dataset.column)] = select.value;
            render();
        }],
        [dialog, 'change', (event) => {
            if (event.target.name === 'lab-import-mode') render();
        }],
        [dialog, 'dragover', (event) => {
            if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
        }],
        [dialog, 'drop', (event) => {
            const dropped = event.dataTransfer?.files?.[0];
            if (!dropped) return;
            event.preventDefault();
            readFile(dropped);
        }]
    ];

    /** Opens the dialog. Resolves when it closes; true when something was imported. */
    async function open() {
        if (!(await lab.ready())) return false;
        const databases = lab.databases();
        file = null;
        preview = null;
        previewError = null;
        types = [];
        typesFor = [];
        formatPicked = false;
        tableEdited = false;
        el.file.value = '';
        el.text.value = '';
        el.error.textContent = '';
        el.format.value = 'csv';
        el.delimiter.value = 'auto';
        el.header.checked = true;
        dialog.querySelector('input[name="lab-import-mode"][value="new"]').checked = true;
        el.db.replaceChildren(
            ...databases.list().map(d => h('option', { value: d.id }, d.name)),
            h('option', { value: '' }, 'New database…'));
        el.db.value = lab.state.open && databases.get(lab.state.open) ? lab.state.open : '';
        el.newName.value = lab.freeName('Company DB');
        if (el.db.value) {
            // The tables as they are now, for "add to a table" and name checks
            try {
                await lab.loadObjects();
            } catch {
                // the import itself reports a database that can't be read
            }
        }
        el.table.value = freeTableName('imported_data');
        render();

        let imported = false;
        const onSubmit = (event) => {
            event.preventDefault();
            event.stopPropagation(); // enhanceDialog's handler would close the dialog
            run().then((ok) => {
                if (ok) {
                    imported = true;
                    closeDialog(dialog, 'confirm');
                }
            });
        };
        const form = dialog.querySelector('form');
        form.addEventListener('submit', onSubmit);
        for (const [target, type, handler] of listeners) target.addEventListener(type, handler);
        try {
            await showDialog(dialog, () => el.fileBtn.focus());
        } finally {
            form.removeEventListener('submit', onSubmit);
            for (const [target, type, handler] of listeners) target.removeEventListener(type, handler);
            refreshSoon.cancel();
            sequence++;
            file = null;
            el.text.value = '';
        }
        return imported;
    }

    return { open, get busy() { return running; } };
}

