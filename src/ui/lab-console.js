// SQL Lab's console: the SQL editor with its notices, Run and Stop, and what
// a run produced (results, messages) plus SQL Lab's history. lab.js places
// these in the view and owns the databases; this module owns running SQL.
//
// A run sends the editor's SQL (or the selected part) to the engine as it
// is. Nothing is rewritten: notices only point out what SQLite is likely to
// reject, before Run.

import { h, debounce, formatTime } from './dom.js';
import { createEditor } from './lab-editor.js';
import { renderGrid, renderMessages, summary, MAX_SHOWN_ROWS } from './lab-results.js';
import { readScript } from '../db/import-sql.js';
import { createLabHistory } from '../db/lab-history.js';
import { getDialect } from '../dialects.js';

const DRAFTS_KEY = 'lab-drafts';
const MAX_DRAFT_CHARS = 200 * 1024;
const MAX_NOTICE_CHARS = 200 * 1024;

/** The ways the editor's SQL can be saved as a file. */
export const SAVE_FORMATS = {
    sql: { extension: 'sql', mimeType: 'application/sql', label: 'SQL file' },
    txt: { extension: 'txt', mimeType: 'text/plain', label: 'text file' }
};

/**
 * A file name for a saved query: what was typed, without characters Windows
 * and Android refuse in names, ending in the format's extension.
 * @param {string} name
 * @param {'sql' | 'txt'} format
 */
export function queryFilename(name, format) {
    const base = String(name ?? '')
        .replace(/\.(sql|txt)$/i, '')
        // eslint-disable-next-line no-control-regex
        .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[. ]+$/, '')
        .slice(0, 100)
        .trim();
    return `${base || 'query'}.${SAVE_FORMATS[format].extension}`;
}

/**
 * @param {{
 *   storage: any,
 *   client: any,
 *   toast: (message: string, kind?: string) => void,
 *   confirm: (options: { title: string, message: string, confirmText: string }) => Promise<boolean>,
 *   askName?: (options: { title: string, label: string, value: string, confirmText: string }) => Promise<string | null>,
 *   saveFile?: (filename: string, text: string, mimeType: string, done: string) => Promise<boolean>,
 *   lab: {
 *     open: () => { id: string, name: string } | null,
 *     exclusive: (work: () => Promise<any>) => Promise<any>,
 *     busy: () => boolean,
 *     afterRun: (run: any) => Promise<void>,
 *     reopen: () => Promise<void>,
 *     showTab: (tab: string) => void,
 *     render: () => void
 *   }
 * }} options
 */
export function createConsole({ storage, client, toast, confirm, askName = null, saveFile = null, lab }) {
    const history = createLabHistory(storage);
    const state = {
        running: false,
        stopping: false,
        /** @type {any} the last run in the open database */
        run: null,
        loadingMore: false,
        inTransaction: false,
        /** @type {{ dialect: string, generic: string } | null} SQL opened from the builder */
        from: null
    };
    let draftFor = '';
    /** SQL from the builder waits for a database to be opened */
    let carry = false;

    // ------------------------------------------------------------ editor

    const notices = h('div', { class: 'lab-sql-notices', id: 'lab-sql-notices', 'aria-live': 'polite' });
    const fromNotice = h('div', { class: 'lab-sql-from', id: 'lab-sql-from' });
    const editor = createEditor({
        label: 'SQL to run',
        describedBy: 'lab-run-hint lab-sql-notices',
        onInput: () => {
            saveDraft();
            checkSoon();
            render();
        },
        onRun: () => run()
    });
    const runBtn = h('button', { type: 'button', class: 'btn btn-primary', id: 'lab-run-btn', 'aria-keyshortcuts': 'Control+Enter Meta+Enter' }, 'Run');
    const stopBtn = h('button', { type: 'button', class: 'btn btn-danger', id: 'lab-stop-btn', hidden: true }, 'Stop');
    const clearBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', id: 'lab-clear-btn' }, 'Clear');
    const saveSqlBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', id: 'lab-save-sql-btn', 'aria-keyshortcuts': 'Control+S Meta+S', title: 'Save the SQL as a .sql file (Ctrl+S)' }, 'Save as .sql');
    const saveTxtBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', id: 'lab-save-txt-btn', title: 'Save the SQL as a .txt text file' }, 'Save as .txt');
    const transaction = h('span', { class: 'library-chip lab-transaction', id: 'lab-transaction', role: 'status', hidden: true }, 'Transaction open');
    const hint = h('p', { class: 'field-hint lab-run-hint', id: 'lab-run-hint' });
    const root = h('section', { class: 'lab-console', id: 'lab-console', 'aria-labelledby': 'lab-console-heading' },
        h('div', { class: 'lab-console-head' },
            h('h4', { class: 'lab-subheading', id: 'lab-console-heading' }, h('label', { for: 'lab-sql' }, 'SQL')),
            h('div', { class: 'lab-console-actions', role: 'group', 'aria-label': 'Editor' },
                saveFile ? saveSqlBtn : null,
                saveFile ? saveTxtBtn : null,
                clearBtn)),
        fromNotice,
        editor.root,
        notices,
        h('div', { class: 'lab-run-bar' }, runBtn, stopBtn, transaction, hint));

    runBtn.addEventListener('click', () => run());
    saveSqlBtn.addEventListener('click', () => save('sql'));
    saveTxtBtn.addEventListener('click', () => save('txt'));
    stopBtn.addEventListener('click', () => stop());
    clearBtn.addEventListener('click', () => {
        editor.value = '';
        state.from = null;
        saveDraft();
        check();
        render();
        editor.focus();
    });
    fromNotice.addEventListener('click', (event) => {
        const button = /** @type {any} */ (event.target).closest('[data-console-action="generic"]');
        if (!button || !state.from) return;
        editor.value = state.from.generic;
        state.from = null;
        saveDraft();
        check();
        render();
        editor.focus();
        toast('The Generic SQL version is in the editor.', 'success');
    });

    // ----------------------------------------------------------- drafts

    function drafts() {
        const stored = storage.get(DRAFTS_KEY, {});
        return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    }

    function saveDraft() {
        if (!draftFor) return;
        const all = drafts();
        const text = editor.value;
        if (text.trim() && text.length <= MAX_DRAFT_CHARS) all[draftFor] = text;
        else delete all[draftFor];
        storage.set(DRAFTS_KEY, all);
    }

    /** Shows a database's SQL (kept per database) when it is opened. */
    function setDatabase(id) {
        const key = id || '';
        if (key === draftFor) return;
        draftFor = key;
        state.run = null;
        state.inTransaction = false;
        if (carry) {
            // SQL brought from the builder goes to the database opened next
            if (key) carry = false;
            saveDraft();
        } else {
            const draft = key ? drafts()[key] : '';
            editor.value = typeof draft === 'string' ? draft : '';
            state.from = null;
        }
        check();
    }

    // ------------------------------------------------------------- save

    let saving = false;

    /**
     * Saves all of the editor's SQL, exactly as typed, as a .sql or .txt file
     * (a download, or the share sheet on Android). Nothing leaves the device
     * any other way.
     * @param {'sql' | 'txt'} format
     */
    async function save(format) {
        if (!saveFile || saving) return;
        const text = editor.value;
        if (!text.trim()) {
            toast('Type some SQL to save first.', 'error');
            editor.focus();
            return;
        }
        const { label } = SAVE_FORMATS[format];
        const database = lab.open();
        const suggested = queryFilename(database ? `${database.name} query` : 'query', format);
        saving = true;
        try {
            const name = askName
                ? await askName({ title: `Save as ${label}`, label: 'File name', value: suggested, confirmText: 'Save' })
                : suggested;
            if (name === null) return;
            const filename = queryFilename(name, format);
            await saveFile(filename, text.endsWith('\n') ? text : `${text}\n`, SAVE_FORMATS[format].mimeType, `Saved ${filename}.`);
        } finally {
            saving = false;
            editor.focus();
        }
    }

    // ---------------------------------------------------------- notices

    /** Flags what SQLite is likely to reject (never changes the SQL). */
    function check() {
        const text = editor.value;
        const items = [];
        if (text.trim() && text.length <= MAX_NOTICE_CHARS) {
            const { statements, problem } = readScript(text);
            if (problem) items.push(problem);
            for (const s of statements) for (const issue of s.issues) items.push(issue);
        }
        notices.replaceChildren(...(items.length ? [
            h('p', { class: 'lab-sql-notice-title' }, items.length === 1 ? 'SQLite may not run this as written:' : `SQLite may not run this as written (${items.length} places):`),
            h('ul', {}, items.slice(0, 6).map(i => h('li', {}, h('button', { type: 'button', class: 'lab-link-btn', dataset: { line: String(i.line), column: String(i.column) } }, `Line ${i.line}, column ${i.column}`), `: ${i.message}`))),
            items.length > 6 ? h('p', {}, `And ${items.length - 6} more.`) : null
        ] : []));
        notices.hidden = items.length === 0;
    }
    const checkSoon = debounce(check, 300);
    notices.addEventListener('click', (event) => {
        const button = /** @type {any} */ (event.target).closest('button[data-line]');
        if (button) editor.goTo(Number(button.dataset.line), Number(button.dataset.column));
    });

    // -------------------------------------------------------------- run

    /** Runs the selected SQL, or all of it. */
    async function run() {
        const database = lab.open();
        if (!database || state.running || lab.busy()) return;
        checkSoon.flush();
        const selected = editor.selection();
        const sql = selected ? selected.text : editor.value;
        if (!sql.trim()) {
            toast('Type some SQL to run first.', 'error');
            editor.focus();
            return;
        }
        state.running = true;
        state.stopping = false;
        render();
        /** @type {any} */
        let result;
        try {
            result = await lab.exclusive(() => client.call('execute', { sql, pageSize: 100 }));
        } catch (error) {
            const e = /** @type {any} */ (error);
            result = e?.code === 'STOPPED' || state.stopping
                ? { results: [], omitted: 0, statements: 0, changes: 0, error: null, inTransaction: false, stopped: true }
                : { results: [], omitted: 0, statements: 0, changes: 0, error: { message: e?.message || String(e), code: e?.code }, inTransaction: false };
        }
        // Positions in a selection count from where the selection starts
        if (selected && result.error && typeof result.error.line === 'number') {
            if (result.error.line === 1) result.error.column += selected.column - 1;
            result.error.line += selected.line - 1;
        }
        if (selected) for (const r of result.results) r.line += selected.line - 1;
        state.run = { ...result, sql, selection: Boolean(selected), databaseId: database.id };
        state.inTransaction = Boolean(result.inTransaction);
        state.running = false;
        history.add({ sql, databaseId: database.id, databaseName: database.name, ok: !result.error && !result.stopped, summary: summary(result) });
        if (result.stopped) await lab.reopen();
        else await lab.afterRun(result);
        const grids = result.results.filter(r => r.columns?.length);
        lab.showTab(grids.length && !result.error ? 'results' : 'messages');
        lab.render();
        if (result.error && typeof result.error.line === 'number') editor.goTo(result.error.line, result.error.column);
    }

    /** Stops a long run: the engine is restarted, as SQLite can't be interrupted from outside. */
    async function stop() {
        if (!state.running || state.stopping) return;
        state.stopping = true;
        render();
        try {
            await client.restart({ waitForFiles: true });
        } catch {
            // run() reports the stop; reopening says if the engine is gone
        }
    }

    /** The next page of the last statement's rows. */
    async function loadMore(index) {
        const r = state.run?.results[index];
        if (!r || !r.cursor || state.loadingMore) return;
        state.loadingMore = true;
        lab.render();
        try {
            const page = await client.call('fetchPage', { cursor: r.cursor, pageSize: Math.min(100, MAX_SHOWN_ROWS - r.rows.length) });
            r.rows = r.rows.concat(page.rows);
            r.more = page.more;
            r.cursor = page.cursor;
            if (r.rows.length >= MAX_SHOWN_ROWS && r.cursor) {
                await client.call('closeCursor', { cursor: r.cursor }).catch(() => {});
                r.cursor = null;
            }
        } catch (error) {
            r.cursor = null;
            toast(/** @type {any} */ (error)?.message || String(error), 'error');
        } finally {
            state.loadingMore = false;
            lab.render();
            // The grid was redrawn: keep the place in it
            const doc = root.ownerDocument;
            const next = doc.querySelector(`[data-lab-action="more"][data-result="${index}"]`)
                || doc.querySelectorAll('.lab-result-scroll')[state.run?.results.filter(x => x.columns?.length).indexOf(r)];
            next?.focus();
        }
    }

    // ----------------------------------------------------------- views

    function resultsView() {
        const runNow = state.run;
        if (!runNow) return [h('p', { class: 'lab-empty-hint' }, 'Run SQL to see its results here.')];
        if (runNow.stopped) return [h('p', { class: 'lab-empty-hint' }, 'The run was stopped, so there are no results.')];
        const grids = runNow.results.filter(r => r.columns?.length);
        if (!grids.length) {
            return [h('p', { class: 'lab-empty-hint' }, runNow.error
                ? 'No results: the engine reported an error (see Messages).'
                : `${summary(runNow)} No statement returned rows; see Messages.`)];
        }
        return [
            runNow.error ? h('p', { class: 'lab-result-error', role: 'alert' }, `The script stopped at an error on line ${runNow.error.line ?? '?'}: ${runNow.error.message}. See Messages.`) : null,
            ...grids.map(r => renderGrid(r, { index: runNow.results.indexOf(r), count: grids.length, loading: state.loadingMore }))
        ].filter(Boolean);
    }

    function messagesView() {
        if (!state.run) return [h('p', { class: 'lab-empty-hint' }, 'Messages from the engine appear here after you run SQL.')];
        return renderMessages(state.run);
    }

    function historyView() {
        const entries = history.list();
        if (!entries.length) return [h('p', { class: 'lab-empty-hint' }, 'SQL you run in SQL Lab is listed here.')];
        return [
            h('div', { class: 'lab-history-head' },
                h('p', { class: 'lab-empty-hint' }, `The last ${entries.length} runs, newest first.`),
                h('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { consoleAction: 'clear-history' } }, 'Clear history')),
            h('ol', { class: 'lab-history' }, entries.map(e => h('li', { class: `lab-history-item${e.ok ? '' : ' is-error'}` },
                h('code', { class: 'lab-history-sql' }, e.sql.length > 300 ? `${e.sql.slice(0, 297)}…` : e.sql),
                h('div', { class: 'lab-history-meta' },
                    h('span', {}, `${e.databaseName} · ${formatTime(e.ranAt)}`),
                    h('span', { class: e.ok ? null : 'lab-history-error' }, e.summary)),
                h('div', { class: 'lab-history-actions' },
                    h('button', { type: 'button', class: 'btn btn-secondary btn-sm', dataset: { consoleAction: 'history-open', id: e.id }, 'aria-label': `Put this SQL in the editor: ${e.sql.slice(0, 60)}` }, 'Put in editor'),
                    h('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { consoleAction: 'history-remove', id: e.id }, 'aria-label': 'Remove from history' }, 'Remove')))))
        ];
    }

    /** Handles clicks inside the results, messages and history views. */
    async function onPanelClick(event) {
        const target = /** @type {any} */ (event.target);
        const more = target.closest('[data-lab-action="more"]');
        if (more) {
            await loadMore(Number(more.dataset.result));
            return;
        }
        const button = target.closest('[data-console-action]');
        if (!button) return;
        const { consoleAction: action, id } = button.dataset;
        if (action === 'history-open') {
            const entry = history.get(id);
            if (!entry) return;
            editor.value = entry.sql;
            state.from = null;
            saveDraft();
            check();
            render();
            editor.focus();
        } else if (action === 'history-remove') {
            history.remove(id);
            lab.render();
        } else if (action === 'clear-history') {
            const ok = await confirm({ title: 'Clear SQL Lab history?', message: 'The SQL you ran in SQL Lab is removed from this list. Your databases aren\'t changed.', confirmText: 'Clear history' });
            if (ok) {
                history.clear();
                lab.render();
            }
        }
    }

    // ----------------------------------------------------------- render

    function render() {
        const database = lab.open();
        const busy = lab.busy() && !state.running;
        const has = editor.value.trim() !== '';
        runBtn.disabled = !database || state.running || busy || !has;
        runBtn.textContent = state.running ? 'Running…' : (editor.selection() ? 'Run selection' : 'Run');
        stopBtn.hidden = !state.running;
        stopBtn.disabled = state.stopping;
        stopBtn.textContent = state.stopping ? 'Stopping…' : 'Stop';
        clearBtn.disabled = !has;
        saveSqlBtn.disabled = !has;
        saveTxtBtn.disabled = !has;
        transaction.hidden = !state.inTransaction;
        hint.textContent = !database && state.stopping
            ? 'Restarting the database engine…'
            : !database
            ? 'Open or create a database to run SQL.'
            : state.running
                ? 'Running. Stop restarts the engine: committed changes are kept, and an unfinished transaction is rolled back.'
                : `Runs in “${database.name}”. Ctrl+Enter runs; select part of the SQL to run only that.${saveFile ? ' Ctrl+S saves it as a .sql file.' : ''}`;
        if (state.from) {
            const label = getDialect(state.from.dialect).label;
            fromNotice.replaceChildren(
                h('p', {}, `This SQL was generated for ${label}. SQL Lab runs it in SQLite as written, and SQLite may not support all of it.`),
                h('button', { type: 'button', class: 'btn btn-secondary btn-sm', dataset: { consoleAction: 'generic' } }, 'Use the Generic SQL version instead'));
        } else {
            fromNotice.replaceChildren();
        }
        fromNotice.hidden = !state.from;
    }
    editor.input.addEventListener('select', render);
    editor.input.addEventListener('keyup', render);
    editor.input.addEventListener('mouseup', render);

    check();
    render();

    return {
        root,
        editor,
        state,
        history,
        run,
        save,
        stop,
        setDatabase,
        resultsView,
        messagesView,
        historyView,
        onPanelClick,
        render,
        /**
         * Puts SQL from the builder in the editor, as it was generated.
         * @param {{ sql: string, dialect: string, generic: string }} from
         */
        openSql({ sql, dialect, generic }) {
            editor.value = sql;
            carry = !draftFor;
            state.from = dialect !== 'generic' && generic && generic !== sql ? { dialect, generic } : null;
            saveDraft();
            check();
            render();
        },
        /** Forgets the open database's run (it was closed or deleted). */
        reset() {
            state.run = null;
            state.inTransaction = false;
            render();
        },
        clearHistory() {
            history.clear();
            storage.remove(DRAFTS_KEY);
        }
    };
}
