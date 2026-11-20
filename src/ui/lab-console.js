// SQL Lab's console: the SQL editor with its notices, Run and Stop, and what
// a run produced (results, messages) plus SQL Lab's history. lab.js places
// these in the view and owns the databases; this module owns running SQL.
//
// A run sends the editor's SQL (or the selected part) to the engine. With
// the language set to SQLite it goes as it is; with SQL Server, PostgreSQL or
// MySQL it is first translated for SQLite (dialect-translate.js), and
// Messages lists every kind of change with the SQL that ran. Notices point
// out what SQLite is likely to reject, before Run.

import { h, debounce, formatTime } from './dom.js';
import { createEditor } from './lab-editor.js';
import { renderGrid, renderMessages, summary, MAX_SHOWN_ROWS } from './lab-results.js';
import { readScript } from '../db/import-sql.js';
import { createLabHistory } from '../db/lab-history.js';
import { getDialect } from '../dialects.js';
import { LAB_DIALECTS, isLabDialect, translateForSqlite } from '../db/dialect-translate.js';
import { COMPAT_FUNCTION_NAMES } from '../db/compat-functions.js';
import { parseBatch, splitBatches, TsqlSyntaxError } from '../db/tsql/parse.js';
import { formatSql, planTree, planHints, resultAsText, resultAsCsv, resultAsJson, resultAsTsv, sortedRows } from './lab-scripts.js';
import { attachCompletion } from './lab-complete.js';

/**
 * The statements of a script that have a query plan (SELECT, INSERT,
 * UPDATE, DELETE, WITH), as SQLite runs them, each with the SQL as written.
 * @param {string} text
 * @param {string} language
 * @returns {{ written: string, sql: string | null, note: string | null }[]}
 */
export function planStatements(text, language) {
    const planned = /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH|REPLACE|VALUES|MERGE)\b/i;
    /** @type {{ written: string, sql: string | null, note: string | null }[]} */
    const out = [];
    if (language === 'sqlserver') {
        /** @type {string[]} */
        const found = [];
        const walk = (/** @type {any} */ node) => {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node)) {
                node.forEach(walk);
                return;
            }
            if (node.type === 'sql' && typeof node.text === 'string') found.push(node.text);
            else if (node.type === 'cursor' && node.query) found.push(node.query.text);
            for (const key of ['then', 'else', 'body', 'handler']) walk(node[key]);
        };
        for (const batch of splitBatches(text)) {
            try {
                walk(parseBatch(batch.text, batch.start));
            } catch {
                // The editor's notice says what can't be read
            }
        }
        for (const written of found) {
            const clean = written.trim();
            if (!planned.test(clean)) continue;
            if (/\b(MERGE|APPLY|PIVOT|UNPIVOT)\b/i.test(clean) || /^\s*MERGE\b/i.test(clean)) {
                out.push({ written: clean, sql: null, note: 'SQL Lab runs MERGE, APPLY and PIVOT in several steps of its own, so there is no single plan to show.' });
                continue;
            }
            if (/\bINTO\s+#|#\w|@\w+\s+TABLE\b/i.test(clean) || /\bFROM\s+@/i.test(clean)) {
                out.push({ written: clean, sql: translateForSqlite(clean, 'sqlserver').sql, note: 'Temporary tables and table variables exist only while a script runs, so their plan may not be available here.' });
                continue;
            }
            out.push({ written: clean, sql: translateForSqlite(clean, 'sqlserver').sql, note: null });
        }
        return out;
    }
    const sql = language === 'sqlite' ? text : translateForSqlite(text, /** @type {any} */ (language)).sql;
    for (const st of readScript(sql).statements) {
        if (st.skip) continue;
        const piece = sql.slice(st.start, st.end).trim().replace(/;\s*$/, '');
        if (planned.test(piece)) out.push({ written: piece, sql: piece, note: null });
    }
    return out;
}

/** The first thing the T-SQL engine can't read in a script (line, column, message), or null. */
export function tsqlProblem(text) {
    try {
        for (const batch of splitBatches(text)) parseBatch(batch.text, batch.start);
        return null;
    } catch (e) {
        if (!(e instanceof TsqlSyntaxError)) return null;
        const before = text.slice(0, e.offset);
        const line = (before.match(/\n/g) || []).length + 1;
        return { line, column: e.offset - (before.lastIndexOf('\n') + 1) + 1, message: e.message };
    }
}

const DRAFTS_KEY = 'lab-drafts';
const LANGUAGE_KEY = 'lab-language';
const TEXT_MODE_KEY = 'lab-results-text';
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
 *   copyText?: (text: string) => Promise<boolean>,
 *   lab: {
 *     objects?: () => { objects: any[], modules: any[] } | null,
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
export function createConsole({ storage, client, toast, confirm, askName = null, saveFile = null, copyText = null, lab }) {
    const history = createLabHistory(storage);
    const state = {
        running: false,
        stopping: false,
        /** @type {any} the last run in the open database */
        run: null,
        loadingMore: false,
        inTransaction: false,
        /** @type {{ dialect: string, generic: string } | null} SQL opened from the builder */
        from: null,
        /** @type {import('../db/dialect-translate.js').LabDialect} the language the editor's SQL is written in */
        language: /** @type {any} */ (isLabDialect(storage.get(LANGUAGE_KEY, 'sqlite')) ? storage.get(LANGUAGE_KEY, 'sqlite') : 'sqlite'),
        /** Results to Text (as SSMS's Ctrl+T) instead of grids */
        textMode: storage.get(TEXT_MODE_KEY, false) === true,
        /** @type {Map<number, { column: number, direction: 'asc' | 'desc' }>} how each result grid is sorted (by its index) */
        sorts: new Map(),
        /** @type {{ items: { written: string, sql: string | null, note: string | null, steps: any[] | null, error: string | null }[], language: string } | null} the last plan shown */
        plan: null,
        planning: false
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
    const formatBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', id: 'lab-format-btn', 'aria-keyshortcuts': 'Control+Shift+F', title: 'Lay the SQL out one clause per line, keywords in capitals (Ctrl+Shift+F). Formats the selection, or all of it.' }, 'Format');
    const planBtn = h('button', { type: 'button', class: 'btn btn-secondary', id: 'lab-plan-btn', 'aria-keyshortcuts': 'Control+L', title: 'Show how the engine would run the query, without running it (Ctrl+L)' }, 'Show plan');
    const textBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', id: 'lab-text-btn', 'aria-pressed': 'false', title: 'Show results as plain text instead of grids' }, 'Results to text');
    const saveSqlBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', id: 'lab-save-sql-btn', 'aria-keyshortcuts': 'Control+S Meta+S', title: 'Save the SQL as a .sql file (Ctrl+S)' }, 'Save as .sql');
    const saveTxtBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', id: 'lab-save-txt-btn', title: 'Save the SQL as a .txt text file' }, 'Save as .txt');
    const transaction = h('span', { class: 'library-chip lab-transaction', id: 'lab-transaction', role: 'status', hidden: true }, 'Transaction open');
    const hint = h('p', { class: 'field-hint lab-run-hint', id: 'lab-run-hint' });
    const languageSelect = h('select', { class: 'select select-sm lab-language-select', id: 'lab-language', 'aria-describedby': 'lab-language-note' },
        LAB_DIALECTS.map(d => h('option', { value: d.id }, d.label)));
    languageSelect.value = state.language;
    const languageNote = h('span', { class: 'visually-hidden', id: 'lab-language-note' });
    const language = h('label', { class: 'lab-language' }, h('span', { class: 'lab-language-label' }, 'Language'), languageSelect, languageNote);
    const root = h('section', { class: 'lab-console', id: 'lab-console', 'aria-labelledby': 'lab-console-heading' },
        h('div', { class: 'lab-console-head' },
            h('div', { class: 'lab-console-title' },
                h('h4', { class: 'lab-subheading', id: 'lab-console-heading' }, h('label', { for: 'lab-sql' }, 'SQL')),
                language),
            h('div', { class: 'lab-console-actions', role: 'group', 'aria-label': 'Editor' },
                formatBtn,
                saveFile ? saveSqlBtn : null,
                saveFile ? saveTxtBtn : null,
                clearBtn)),
        fromNotice,
        editor.root,
        notices,
        h('div', { class: 'lab-run-bar' }, runBtn, stopBtn, planBtn, textBtn, transaction, hint));

    // IntelliSense: the open database's tables, columns and modules
    const complete = attachCompletion({
        input: editor.input,
        root: editor.root,
        sources: () => {
            const known = lab.objects?.();
            return known ? { objects: known.objects || [], modules: known.modules || [], language: state.language } : null;
        },
        insert: (from, to, text) => editor.replaceRange(from, to, text)
    });
    editor.input.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
        const mod = event.ctrlKey || event.metaKey;
        if (mod && event.shiftKey && (event.key === 'F' || event.key === 'f')) {
            event.preventDefault();
            format();
        } else if (mod && !event.shiftKey && (event.key === 'l' || event.key === 'L')) {
            event.preventDefault();
            showPlan();
        }
    });
    formatBtn.addEventListener('click', () => format());
    planBtn.addEventListener('click', () => showPlan());
    textBtn.addEventListener('click', () => {
        state.textMode = !state.textMode;
        storage.set(TEXT_MODE_KEY, state.textMode);
        lab.render();
    });

    runBtn.addEventListener('click', () => run());
    languageSelect.addEventListener('change', () => setLanguage(languageSelect.value));

    /** Sets the language the SQL is written in (kept for next time). */
    function setLanguage(id) {
        if (!isLabDialect(id)) return;
        state.language = /** @type {any} */ (id);
        languageSelect.value = id;
        storage.set(LANGUAGE_KEY, id);
        check();
        render();
    }
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
        state.plan = null;
        state.sorts.clear();
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

    // ----------------------------------------------------------- format

    /** Formats the selection, or all of the SQL, as one undo step. */
    function format() {
        const text = editor.value;
        if (!text.trim()) {
            toast('Type some SQL to format first.', 'error');
            editor.focus();
            return;
        }
        complete.close();
        const { selectionStart: start, selectionEnd: end } = editor.input;
        const part = start !== end;
        const from = part ? start : 0;
        const to = part ? end : text.length;
        const formatted = formatSql(text.slice(from, to));
        const result = part ? formatted.replace(/\n$/, '') : formatted;
        if (result === text.slice(from, to)) {
            toast('The SQL is already formatted.');
            editor.focus();
            return;
        }
        editor.replaceRange(from, to, result, { select: part });
        toast(part ? 'The selection is formatted. Ctrl+Z undoes it.' : 'The SQL is formatted. Ctrl+Z undoes it.', 'success');
    }

    // ------------------------------------------------------------- plan

    /**
     * The estimated plan (as SSMS's Ctrl+L): how SQLite would run each query
     * of the selection, or of all the SQL. Nothing runs.
     */
    async function showPlan() {
        const database = lab.open();
        if (!database || state.running || state.planning || lab.busy()) return;
        const selected = editor.selection();
        const text = selected ? selected.text : editor.value;
        if (!text.trim()) {
            toast('Type a query to see its plan first.', 'error');
            editor.focus();
            return;
        }
        const statements = planStatements(text, state.language);
        state.planning = true;
        render();
        try {
            const asked = statements.filter(s => s.sql);
            const answers = asked.length ? await lab.exclusive(() => client.call('explain', { statements: asked.map(s => s.sql) })) : [];
            let k = 0;
            state.plan = {
                language: state.language,
                items: statements.map(s => {
                    if (!s.sql) return { ...s, steps: null, error: null };
                    const a = answers[k++] || {};
                    return { ...s, steps: a.steps || null, error: a.error || null };
                })
            };
        } catch (error) {
            state.plan = { language: state.language, items: [{ written: text, sql: null, note: null, steps: null, error: /** @type {any} */ (error)?.message || String(error) }] };
        } finally {
            state.planning = false;
        }
        lab.showTab('plan');
        lab.render();
    }

    function planView() {
        const plan = state.plan;
        if (!plan) return [h('p', { class: 'lab-empty-hint' }, 'Select Show plan (Ctrl+L) to see how the engine would run a query, without running it.')];
        if (!plan.items.length) return [h('p', { class: 'lab-empty-hint' }, 'There\'s no query here with a plan: plans are for SELECT, INSERT, UPDATE and DELETE.')];
        const node = (/** @type {any} */ n) => h('li', { class: 'lab-plan-node', role: 'treeitem', 'aria-expanded': n.children.length ? 'true' : null },
            h('span', { class: 'lab-plan-op' }, n.operator),
            h('span', { class: 'lab-plan-detail' }, n.detail),
            n.children.length ? h('ul', { class: 'lab-plan-children', role: 'group' }, n.children.map(node)) : null);
        return [
            h('p', { class: 'lab-message-note' }, 'Estimated plan: how SQLite would run each query, read top to bottom, with SQL Server\'s names for the operators. Nothing ran.'),
            ...plan.items.map((item, k) => {
                const head = /^\s*([A-Za-z]+)/.exec(item.written)?.[1]?.toUpperCase() || 'QUERY';
                const hints = item.steps ? planHints(item.steps) : [];
                return h('section', { class: 'lab-plan', 'aria-label': `Plan ${k + 1}` },
                    h('h4', { class: 'lab-result-title' }, `Query ${k + 1} of ${plan.items.length}`),
                    h('code', { class: 'lab-message-sql lab-plan-sql' }, item.written.length > 200 ? `${item.written.slice(0, 197)}…` : item.written),
                    item.note ? h('p', { class: 'lab-empty-hint' }, item.note) : null,
                    item.error ? h('p', { class: 'lab-result-error' }, `No plan: ${item.error}`) : null,
                    item.steps ? h('ul', { class: 'lab-plan-tree', role: 'tree', 'aria-label': `Plan of query ${k + 1}` },
                        h('li', { class: 'lab-plan-node', role: 'treeitem', 'aria-expanded': 'true' },
                            h('span', { class: 'lab-plan-op lab-plan-root' }, head),
                            h('ul', { class: 'lab-plan-children', role: 'group' }, planTree(item.steps).map(node)))) : null,
                    hints.length ? h('ul', { class: 'lab-plan-hints', 'aria-label': 'Suggestions' }, hints.map(x => h('li', {}, x))) : null);
            })
        ];
    }

    // ------------------------------------------------- results tools

    /** A result's rows in the order shown (sorted by a header click, or as returned). */
    function shownRows(index) {
        const r = state.run?.results[index];
        if (!r) return [];
        const sort = state.sorts.get(index);
        return sort ? sortedRows(r.rows, sort.column, sort.direction) : r.rows;
    }

    async function resultTool(action, index) {
        const r = state.run?.results[index];
        if (!r) return;
        const shown = { columns: r.columns, rows: shownRows(index) };
        const partial = r.more ? ` (the ${shown.rows.length.toLocaleString()} rows loaded so far)` : '';
        if (action === 'copy') {
            const ok = copyText ? await copyText(resultAsTsv(shown)) : false;
            toast(ok ? `Copied with column names${partial}. It pastes into a spreadsheet.` : 'Couldn\'t copy to the clipboard.', ok ? 'success' : 'error');
            return;
        }
        if (!saveFile) return;
        const database = lab.open();
        const base = queryFilename(database ? `${database.name} result ${index + 1}` : `result ${index + 1}`, 'txt').replace(/\.txt$/, '');
        if (action === 'csv') await saveFile(`${base}.csv`, resultAsCsv(shown), 'text/csv', `Saved ${base}.csv${partial}.`);
        else if (action === 'json') await saveFile(`${base}.json`, resultAsJson(shown), 'application/json', `Saved ${base}.json${partial}.`);
        else if (action === 'text') await saveFile(`${base}.txt`, `${resultAsText(shown)}\n`, 'text/plain', `Saved ${base}.txt${partial}.`);
    }

    /** Sorts a grid by a column: ascending, then descending, then as returned. */
    function sortBy(index, column) {
        const now = state.sorts.get(index);
        if (!now || now.column !== column) state.sorts.set(index, { column, direction: 'asc' });
        else if (now.direction === 'asc') state.sorts.set(index, { column, direction: 'desc' });
        else state.sorts.delete(index);
        lab.render();
        root.ownerDocument.querySelector(`[data-console-action="sort"][data-result="${index}"][data-column="${column}"]`)?.focus();
    }

    // ---------------------------------------------------------- notices

    /** Flags what SQLite is likely to reject (never changes the SQL). */
    function check() {
        const text = editor.value;
        const items = [];
        if (text.trim() && text.length <= MAX_NOTICE_CHARS && state.language === 'sqlserver') {
            // The T-SQL engine reads the script itself: report what it can't read
            const problem = tsqlProblem(text);
            if (problem) items.push(problem);
        } else if (text.trim() && text.length <= MAX_NOTICE_CHARS) {
            const { statements, problem } = readScript(translateForSqlite(text, state.language).sql);
            if (problem) items.push(problem);
            for (const s of statements) {
                for (const issue of s.issues) {
                    // SQL Lab adds these functions to every database, so they do run
                    const fn = /^SQLite has no ([A-Z_]+)\(\) function/.exec(issue.message)?.[1];
                    if (!fn || !COMPAT_FUNCTION_NAMES.has(fn)) items.push(issue);
                }
            }
        }
        notices.replaceChildren(...(items.length ? [
            h('p', { class: 'lab-sql-notice-title' }, `${state.language === 'sqlite' ? 'SQLite may not run this as written' : state.language === 'sqlserver' ? 'SQL Lab can\'t read this T-SQL' : 'SQLite may not run this, even translated'}${items.length === 1 ? ':' : ` (${items.length} places):`}`),
            h('ul', {}, items.slice(0, 6).map(i => h('li', {}, h('button', { type: 'button', class: 'lab-link-btn', dataset: { line: String(i.line), column: String(i.column) } }, `Line ${i.line}, column ${i.column}`), `: ${i.message}`))),
            items.length > 6 ? h('p', {}, `And ${items.length - 6} more.`) : null
        ].filter(Boolean) : []));
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
        // SQL Server scripts run in the T-SQL engine (variables, IF, WHILE, TRY … CATCH …), which translates as it goes
        const engine = state.language === 'sqlserver';
        const translation = engine ? null : translateForSqlite(sql, state.language);
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
            result = await lab.exclusive(() => client.call('execute', engine
                ? { sql, pageSize: 100, language: 'sqlserver', databaseName: database.name }
                : { sql: /** @type {any} */ (translation).sql, pageSize: 100 }));
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
        state.run = { ...result, sql, selection: Boolean(selected), databaseId: database.id,
            translation: state.language === 'sqlite' ? null
                : engine ? (result.translation ? { language: state.language, changes: result.translation.changes, sql: result.translation.sql } : null)
                    : { language: state.language, changes: /** @type {any} */ (translation).changes, sql: /** @type {any} */ (translation).sql } };
        state.inTransaction = Boolean(result.inTransaction);
        state.running = false;
        state.sorts.clear();
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
            ...grids.map((r, k) => {
                const index = runNow.results.indexOf(r);
                return renderGrid(r, {
                    index, number: k + 1, count: grids.length, loading: state.loadingMore,
                    sort: state.sorts.get(index) || null,
                    rows: shownRows(index),
                    text: state.textMode ? resultAsText({ columns: r.columns, rows: shownRows(index) }) : null,
                    tools: { copy: Boolean(copyText), save: Boolean(saveFile) }
                });
            })
        ].filter(Boolean);
    }

    function messagesView() {
        if (!state.run) return [h('p', { class: 'lab-empty-hint' }, 'Messages from the engine appear here after you run SQL.')];
        return [...renderMessages(state.run), ...translationView(state.run.translation)];
    }

    /** What the translation changed, and the SQL that ran. */
    function translationView(translation) {
        if (!translation) return [];
        const label = LAB_DIALECTS.find(d => d.id === translation.language)?.label || translation.language;
        return [h('section', { class: 'lab-translation', 'aria-label': 'Translation' },
            h('p', { class: 'lab-translation-title' }, translation.changes.length
                ? `Written in ${label}, translated for SQLite:`
                : `Written in ${label}: nothing needed translating for SQLite.`),
            translation.changes.length ? h('ul', { class: 'lab-translation-list' },
                translation.changes.map(c => h('li', {}, c.count > 1 ? `${c.message} (${c.count} times)` : c.message))) : null,
            h('details', { class: 'lab-translation-sql' },
                h('summary', {}, 'SQL that ran'),
                h('pre', { translate: 'no' }, translation.sql)))];
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
        if (action === 'sort') {
            sortBy(Number(button.dataset.result), Number(button.dataset.column));
        } else if (['copy', 'csv', 'json', 'text'].includes(action) && button.dataset.result !== undefined) {
            await resultTool(action, Number(button.dataset.result));
        } else if (action === 'history-open') {
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
        formatBtn.disabled = !has || state.running;
        planBtn.disabled = !database || state.running || state.planning || busy || !has;
        planBtn.textContent = state.planning ? 'Reading plan…' : 'Show plan';
        textBtn.setAttribute('aria-pressed', String(state.textMode));
        saveTxtBtn.disabled = !has;
        transaction.hidden = !state.inTransaction;
        hint.textContent = !database && state.stopping
            ? 'Restarting the database engine…'
            : !database
            ? 'Open or create a database to run SQL.'
            : state.running
                ? 'Running. Stop restarts the engine: committed changes are kept, and an unfinished transaction is rolled back.'
                : `Runs in “${database.name}”${state.language === 'sqlite' ? '' : `, translated from ${LAB_DIALECTS.find(d => d.id === state.language)?.label} for SQLite`}. Ctrl+Enter runs; select part of the SQL to run only that. Ctrl+Space suggests names, Ctrl+L shows the plan.${saveFile ? ' Ctrl+S saves it as a .sql file.' : ''}`;
        languageNote.textContent = LAB_DIALECTS.find(d => d.id === state.language)?.note || '';
        languageSelect.disabled = state.running;
        if (state.from) {
            const label = getDialect(state.from.dialect).label;
            fromNotice.replaceChildren(
                h('p', {}, state.language === state.from.dialect
                    ? `This SQL was generated for ${label}. Language is set to ${label}, so SQL Lab translates it for SQLite when it runs.`
                    : `This SQL was generated for ${label}. SQL Lab runs it in SQLite as written, and SQLite may not support all of it.`),
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
        planView,
        format,
        showPlan,
        complete,
        /**
         * Puts a script in the editor (Script Table as …, Select Top 1000 Rows),
         * replacing what is there as one undo step, and runs it with `run`.
         * @param {string} sql
         * @param {{ run?: boolean, language?: string }} [options]
         */
        async putScript(sql, { run: andRun = false, language: lang } = {}) {
            if (lang && lang !== state.language) setLanguage(lang);
            state.from = null;
            editor.replaceRange(0, editor.value.length, sql);
            editor.input.setSelectionRange(0, 0);
            editor.input.scrollTop = 0;
            render();
            if (andRun) await run();
            else editor.focus();
        },
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
            // SQL written for SQL Server, PostgreSQL or MySQL is translated when it runs
            if (isLabDialect(dialect)) setLanguage(dialect);
            saveDraft();
            check();
            render();
        },
        /** Forgets the open database's run (it was closed or deleted). */
        reset() {
            state.run = null;
            state.plan = null;
            state.sorts.clear();
            state.inTransaction = false;
            render();
        },
        setLanguage,
        clearHistory() {
            history.clear();
            storage.remove(DRAFTS_KEY);
        }
    };
}
