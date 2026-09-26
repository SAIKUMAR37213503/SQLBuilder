// Application controller: owns the state, wires DOM events to model changes
// and re-renders. Rendering lives in ./ui/*, SQL logic in the core modules.

import {
    createWorkspace, createEmptyFor, createColumn, createCaseColumn, createWindowColumn, createCondition, createRawCondition,
    createGroup, createJoin, createTableSource, createSubquerySource, createCte, createSetOp, createOrderItem,
    createGroupByItem, createAssignment, createSelect, OPERATORS, getAt, setAt, parentPath, splitPath,
    isPristine, describeComplexity
} from './model.js';
import { generateSQL } from './generator.js';
import { validateWorkspace, hasErrors, summarize } from './validation.js';
import { listDialects, getDialect } from './dialects.js';
import { createStorage } from './storage.js';
import { loadSettings, saveSettings } from './settings.js';
import { createHistory } from './history.js';
import { createTemplateStore, TemplateError } from './templates.js';
import { UndoStack } from './undo.js';
import {
    normalizeWorkspace, parseQueryFile, parseTemplatesFile, createQueryExport, createTemplatesExport, MAX_IMPORT_BYTES
} from './serialization.js';
import { EXAMPLES } from './examples.js';
import { h, byPath, debounce, cssEscape } from './ui/dom.js';
import { renderEditor } from './ui/builder.js';
import { renderSqlCode, selectContents } from './ui/output.js';
import { renderHistoryList, renderTemplateList, renderExampleList } from './ui/library.js';
import { promptDialog, confirmDialog, showDialog, enhanceDialog } from './ui/dialogs.js';
import { applyTheme, nextTheme, effectiveTheme, THEME_LABELS } from './ui/theme.js';
import { bindShortcuts, SHORTCUTS, modLabel } from './ui/shortcuts.js';

const DRAFT_KEY = 'draft';

// New items for "add-item" buttons (data-arg)
const ITEM_FACTORIES = {
    column: () => createColumn(),
    case: () => createCaseColumn(),
    window: () => createWindowColumn(),
    caseWhen: () => ({ when: '', then: '' }),
    join: () => createJoin(),
    condition: () => createCondition(),
    columnCondition: () => createCondition({ valueType: 'column' }),
    group: () => createGroup('OR', [createCondition()]),
    columnGroup: () => createGroup('OR', [createCondition({ valueType: 'column' })]),
    raw: () => createRawCondition(),
    groupBy: () => createGroupByItem(),
    orderBy: () => createOrderItem(),
    cte: () => createCte(),
    setOp: () => createSetOp(),
    row: () => ({ values: '' }),
    assignment: () => createAssignment()
};

/**
 * @param {{ doc?: Document, storage?: ReturnType<typeof createStorage> }} [options]
 */
export function startApp({ doc = document, storage = createStorage() } = {}) {
    const $ = (id) => /** @type {any} */ (doc.getElementById(id));
    const $$ = (selector) => /** @type {NodeListOf<any>} */ (doc.querySelectorAll(selector));
    const el = {
        builder: $('builder'),
        typeRadios: $$('input[name="query-type"]'),
        generate: $('generate-btn'),
        clear: $('clear-btn'),
        reset: $('reset-btn'),
        undo: $('undo-btn'),
        redo: $('redo-btn'),
        fileMenu: $('file-menu'),
        themeBtn: $('theme-btn'),
        shortcutsBtn: $('shortcuts-btn'),
        settingsBtn: $('settings-btn'),
        outputState: $('output-state'),
        output: $('sql-output'),
        code: $('sql-code'),
        copy: $('copy-btn'),
        download: $('download-btn'),
        selectAll: $('select-all-btn'),
        modeButtons: $$('[data-output-mode]'),
        dialectBadge: $('dialect-badge'),
        complexity: $('complexity'),
        issuesSummary: $('issues-summary'),
        issuesList: $('issues-list'),
        issues: /** @type {any} */ (doc.querySelector('.issues')),
        tabs: $$('[role="tab"]'),
        historySearch: $('history-search'),
        historyClear: $('history-clear-btn'),
        historyList: $('history-list'),
        templateList: $('template-list'),
        templateSave: $('template-save-btn'),
        templateImport: $('template-import-btn'),
        templateExport: $('template-export-btn'),
        exampleList: $('example-list'),
        libraryPanel: /** @type {any} */ (doc.querySelector('.library-panel')),
        fileInput: $('file-input'),
        toast: $('toast'),
        storageNote: $('storage-note'),
        settingsDialog: $('settings-dialog'),
        promptDialog: $('prompt-dialog'),
        confirmDialog: $('confirm-dialog'),
        shortcutsDialog: $('shortcuts-dialog'),
        clearData: $('clear-data-btn')
    };

    // Listeners on document/window are tied to this signal so destroy() removes them
    const lifetime = new AbortController();
    const { signal } = lifetime;

    const history = createHistory(storage);
    const templates = createTemplateStore(storage);
    const undoStack = new UndoStack();

    const state = {
        settings: loadSettings(storage),
        workspace: restoreDraft(),
        issues: /** @type {any[]} */ ([]),
        sql: '',                         // SQL currently shown (preview or generated)
        generated: /** @type {null | { snapshot: string, sql: string }} */ (null),
        attempted: false,                // Generate was pressed: show all field errors
        touched: new Set(),              // field paths the user has left
        openSections: new Map(),
        libraryTab: 'history'
    };
    undoStack.reset(state.workspace);

    function restoreDraft() {
        const settings = loadSettings(storage);
        if (!settings.restoreSession) return createWorkspace();
        const draft = storage.get(DRAFT_KEY);
        if (!draft) return createWorkspace();
        try {
            return normalizeWorkspace(draft);
        } catch {
            return createWorkspace();
        }
    }

    const generationOptions = (pretty = state.settings.outputMode === 'formatted') => ({
        dialect: state.settings.dialect,
        quoteIdentifiers: state.settings.quoteIdentifiers,
        pretty
    });

    // ------------------------------------------------------------------ toast

    let toastTimer;
    function toast(message, kind = 'info') {
        clearTimeout(toastTimer);
        el.toast.textContent = message;
        el.toast.dataset.kind = kind;
        el.toast.classList.add('visible');
        toastTimer = setTimeout(() => el.toast.classList.remove('visible'), 4000);
    }

    // --------------------------------------------------------------- rendering

    const ui = {
        isOpen: (key, fallback) => (state.openSections.has(key) ? state.openSections.get(key) : fallback)
    };

    function renderBuilder(focus = null) {
        const active = /** @type {any} */ (doc.activeElement);
        const previous = active && el.builder.contains(active)
            ? { path: active.dataset.path, action: active.dataset.action }
            : null;

        el.builder.replaceChildren(renderEditor(state.workspace, ui));

        const target = focus || previous;
        if (target) focusTarget(target);
    }

    /** @param {{ path?: string, action?: string, within?: string }} target */
    function focusTarget({ path, action, within }) {
        /** @type {any} */
        let node = null;
        if (within) {
            const container = byPath(el.builder, within);
            node = container && container.querySelector('input, select, textarea, button');
        }
        if (!node && path !== undefined) {
            const selector = action
                ? `[data-action="${cssEscape(action)}"][data-path="${cssEscape(path)}"]`
                : `[data-path="${cssEscape(path)}"]:is(input, select, textarea)`;
            node = el.builder.querySelector(selector);
        }
        if (node) node.focus();
    }

    function syncTypeTabs() {
        el.typeRadios.forEach(radio => { radio.checked = radio.value === state.workspace.type; });
    }

    const pristine = () => isPristine(state.workspace);

    function refresh() {
        state.issues = validateWorkspace(state.workspace, { dialect: state.settings.dialect });
        const valid = !hasErrors(state.issues);
        const live = state.settings.livePreview;

        if (valid && live && !pristine()) {
            state.sql = generateSQL(state.workspace, generationOptions());
        } else if (!live && state.generated) {
            state.sql = state.generated.sql;
        } else {
            state.sql = '';
        }

        renderOutput(valid);
        renderIssues();
        markFields();
        renderComplexity();
        el.undo.disabled = !undoStack.canUndo;
        el.redo.disabled = !undoStack.canRedo;
        el.dialectBadge.textContent = getDialect(state.settings.dialect).label;
        saveDraft();
    }

    const scheduleRefresh = debounce(refresh, 120);

    function renderOutput(valid) {
        const stale = !state.settings.livePreview && state.generated && state.generated.snapshot !== JSON.stringify(state.workspace);
        el.output.hidden = state.sql === '';
        el.outputState.replaceChildren();

        if (state.sql !== '') {
            renderSqlCode(el.code, state.sql);
            if (stale) el.outputState.append(h('p', { class: 'output-note' }, 'The query changed since you last pressed Generate SQL.'));
            return;
        }
        el.code.replaceChildren();

        if (pristine()) {
            el.outputState.append(h('div', { class: 'empty-state' },
                h('p', { class: 'empty-title' }, 'Your SQL will appear here'),
                h('p', {}, state.workspace.type === 'select'
                    ? 'Enter a table and a column to start, or load an example:'
                    : 'Fill in the table and fields on the left, or load an example:'),
                h('div', { class: 'empty-actions' }, EXAMPLES.slice(0, 3).map(example =>
                    h('button', { type: 'button', class: 'btn btn-secondary btn-sm', dataset: { action: 'example-load', id: example.id } }, example.name)))
            ));
        } else if (!valid) {
            const { errors } = summarize(state.issues);
            el.outputState.append(h('p', { class: 'output-note' },
                `Resolve ${errors} ${errors === 1 ? 'issue' : 'issues'} under Checks to see the SQL.`));
        } else {
            el.outputState.append(h('p', { class: 'output-note' }, `Press Generate SQL (${modLabel()} + Enter) to create the SQL.`));
        }
    }

    function renderIssues() {
        el.issues.hidden = pristine();
        if (pristine()) {
            el.issuesSummary.textContent = '';
            el.issuesList.replaceChildren();
            return;
        }
        const { errors, warnings, infos } = summarize(state.issues);
        const parts = [];
        if (errors) parts.push(`${errors} ${errors === 1 ? 'error' : 'errors'}`);
        if (warnings) parts.push(`${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`);
        if (infos) parts.push(`${infos} ${infos === 1 ? 'tip' : 'tips'}`);
        el.issuesSummary.textContent = parts.length ? `— ${parts.join(', ')}` : '— all good';

        const labels = { error: 'Error', warning: 'Warning', info: 'Tip' };
        el.issuesList.replaceChildren(...state.issues.map((issue, i) => h('li', {
            class: `issue issue-${issue.level}${issue.category === 'safety' ? ' issue-safety' : ''}`,
            id: `issue-${i}`
        },
        h('span', { class: 'issue-level' }, labels[issue.level]),
        h('span', { class: 'issue-message' }, issue.message),
        byPath(el.builder, issue.path)
            ? h('button', { type: 'button', class: 'btn btn-link btn-sm', dataset: { goto: issue.path }, 'aria-label': `Go to field: ${issue.message}` }, 'Go to field')
            : null
        )));
    }

    function shouldMark(path) {
        if (state.attempted) return true;
        for (const touched of state.touched) {
            if (touched === path || touched.startsWith(`${path}.`)) return true;
        }
        return false;
    }

    function markFields() {
        for (const node of el.builder.querySelectorAll('.is-invalid, .has-error')) {
            node.classList.remove('is-invalid', 'has-error');
            if (node.dataset.bind) {
                node.removeAttribute('aria-invalid');
                const base = node.dataset.baseDescribedby;
                if (base) node.setAttribute('aria-describedby', base);
                else node.removeAttribute('aria-describedby');
            }
        }
        state.issues.forEach((issue, i) => {
            if (issue.level !== 'error' || !shouldMark(issue.path)) return;
            const node = byPath(el.builder, issue.path);
            if (!node) return;
            if (node.dataset.bind) {
                node.classList.add('is-invalid');
                node.setAttribute('aria-invalid', 'true');
                if (node.dataset.baseDescribedby === undefined) node.dataset.baseDescribedby = node.getAttribute('aria-describedby') || '';
                node.setAttribute('aria-describedby', `${node.dataset.baseDescribedby} issue-${i}`.trim());
            } else {
                node.classList.add('has-error');
            }
        });
    }

    function renderComplexity() {
        if (state.workspace.type !== 'select' || pristine()) {
            el.complexity.textContent = '';
            return;
        }
        const { subqueries, joins, conditions } = describeComplexity(state.workspace.select);
        const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
        const parts = [];
        if (joins) parts.push(plural(joins, 'join'));
        if (subqueries) parts.push(subqueries === 1 ? '1 subquery' : `${subqueries} subqueries`);
        if (conditions) parts.push(plural(conditions, 'condition'));
        el.complexity.textContent = parts.length ? `Query size: ${parts.join(' · ')}` : '';
    }

    const saveDraft = debounce(() => {
        if (state.settings.restoreSession) storage.set(DRAFT_KEY, state.workspace);
        else storage.remove(DRAFT_KEY);
    }, 400);

    // ------------------------------------------------------------ model edits

    const commitSoon = debounce(() => {
        undoStack.push(state.workspace);
        el.undo.disabled = !undoStack.canUndo;
        el.redo.disabled = !undoStack.canRedo;
    }, 500);

    /** Structural change: record undo, re-render the editor, refresh. */
    function mutate(change, focus = null) {
        commitSoon.flush();
        change();
        undoStack.push(state.workspace);
        renderBuilder(focus);
        scheduleRefresh.flush();
    }

    function replaceWorkspace(workspace, message) {
        commitSoon.flush();
        state.workspace = workspace;
        state.attempted = false;
        state.touched.clear();
        undoStack.push(state.workspace);
        syncTypeTabs();
        renderBuilder();
        scheduleRefresh.flush();
        if (message) toast(message, 'success');
    }

    function normalizeCondition(c) {
        const spec = OPERATORS[c.op];
        if (!spec) return;
        if (spec.subqueryOnly) c.valueType = 'subquery';
        if (c.valueType === 'subquery' && !spec.subquery) c.valueType = 'value';
        if (c.valueType === 'subquery' && !c.subquery) {
            c.subquery = createSelect({ columns: [createColumn(spec.subqueryOnly ? '1' : '')] });
        }
    }

    function switchKind(objectPath, kind) {
        const current = getAt(state.workspace, objectPath);
        let next;
        if (kind === 'case') next = { ...createCaseColumn(), alias: current.alias };
        else if (kind === 'window') next = { ...createWindowColumn(), alias: current.alias };
        else if (kind === 'column') next = createColumn('', { alias: current.alias });
        else if (kind === 'subquery') next = { ...createSubquerySource(), alias: current.alias };
        else if (kind === 'table') next = createTableSource('', current.alias);
        else return;
        setAt(state.workspace, objectPath, next);
    }

    function onBuilderInput(event) {
        const target = event.target;
        if (target.dataset.bind !== 'text') return;
        setAt(state.workspace, target.dataset.path, target.value);
        scheduleRefresh();
        commitSoon();
    }

    function onBuilderChange(event) {
        const target = event.target;
        const { path, bind } = target.dataset;
        if (!path || bind === 'text') return;
        const value = bind === 'check' ? target.checked : target.value;

        const apply = () => {
            if (path.endsWith('.kind')) {
                switchKind(parentPath(path), value);
            } else {
                setAt(state.workspace, path, value);
                if (path.endsWith('.op') || path.endsWith('.valueType')) {
                    const owner = getAt(state.workspace, parentPath(path));
                    if (owner && owner.kind === 'condition') normalizeCondition(owner);
                }
            }
        };

        if (target.dataset.rerender !== undefined) {
            mutate(apply, { path });
        } else {
            commitSoon.flush();
            apply();
            undoStack.push(state.workspace);
            scheduleRefresh.flush();
        }
    }

    function onBuilderClick(event) {
        const btn = event.target.closest('button[data-action]');
        if (!btn || !el.builder.contains(btn)) return;
        const { action, path, arg } = btn.dataset;

        if (action === 'add-item') {
            const factoryKey = arg === 'group' && /\.on(\.|$)/.test(path) ? 'columnGroup' : arg;
            const factory = ITEM_FACTORIES[factoryKey];
            if (!factory) return;
            let newPath = '';
            mutate(() => {
                const list = getAt(state.workspace, path);
                list.push(factory());
                newPath = `${path}.${list.length - 1}`;
            });
            focusTarget({ within: newPath });
        } else if (action === 'remove-item') {
            const listPath = parentPath(path);
            const index = Number(splitPath(path).pop());
            mutate(() => { getAt(state.workspace, listPath).splice(index, 1); },
                { action: 'add-item', path: listPath });
        } else if (action === 'move-up' || action === 'move-down') {
            const listPath = parentPath(path);
            const index = Number(splitPath(path).pop());
            const to = action === 'move-up' ? index - 1 : index + 1;
            const list = getAt(state.workspace, listPath);
            if (to < 0 || to >= list.length) return;
            mutate(() => { [list[index], list[to]] = [list[to], list[index]]; },
                { action, path: `${listPath}.${to}` });
        }
    }

    function onBuilderFocusOut(event) {
        const path = event.target.dataset?.path;
        if (path && event.target.dataset.bind) {
            state.touched.add(path);
            markFields();
        }
    }

    // ---------------------------------------------------------------- actions

    function generate() {
        commitSoon.flush();
        scheduleRefresh.cancel();
        state.issues = validateWorkspace(state.workspace, { dialect: state.settings.dialect });
        if (hasErrors(state.issues)) {
            state.attempted = true;
            refresh();
            const first = state.issues.find(i => i.level === 'error');
            if (first) goToField(first.path);
            const { errors } = summarize(state.issues);
            toast(`Fix ${errors} ${errors === 1 ? 'issue' : 'issues'} before generating.`, 'error');
            return;
        }
        const sql = generateSQL(state.workspace, generationOptions());
        state.generated = { snapshot: JSON.stringify(state.workspace), sql };
        let saved = false;
        if (state.settings.saveHistory) {
            const formatted = generateSQL(state.workspace, generationOptions(true));
            saved = Boolean(history.add({ type: state.workspace.type, dialect: state.settings.dialect, sql: formatted, workspace: state.workspace }));
            renderHistory();
        }
        refresh();
        const warnings = state.issues.filter(i => i.level === 'warning').length;
        toast(`SQL generated${saved ? ' and saved to history' : ''}.${warnings ? ` Review ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}.` : ''}`,
            warnings ? 'warning' : 'success');
    }

    function goToField(path) {
        let node = byPath(el.builder, path);
        if (!node) return;
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
            if (parent.tagName === 'DETAILS' && !parent.open) {
                parent.open = true;
                if (parent.dataset.section) state.openSections.set(parent.dataset.section, true);
            }
        }
        if (!node.dataset.bind) node = node.querySelector('input, select, button') || node;
        node.focus();
        if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            const area = h('textarea', { class: 'visually-hidden', readonly: true });
            area.value = text;
            doc.body.appendChild(area);
            area.select();
            try {
                return doc.execCommand('copy');
            } catch {
                return false;
            } finally {
                area.remove();
            }
        }
    }

    async function copySql() {
        commitSoon.flush();
        scheduleRefresh.flush();
        if (!state.sql) {
            toast(hasErrors(state.issues) ? 'Nothing to copy yet — resolve the checks first.' : 'Nothing to copy yet — generate a query first.', 'error');
            return;
        }
        if (await copyText(state.sql)) {
            el.copy.textContent = 'Copied!';
            el.copy.classList.add('copied');
            setTimeout(() => { el.copy.textContent = 'Copy'; el.copy.classList.remove('copied'); }, 2000);
            toast('SQL copied to the clipboard.', 'success');
        } else {
            toast('Copy failed — use Select all, then copy with your keyboard.', 'error');
        }
    }

    function downloadFile(filename, text, type) {
        const blob = new Blob([text], { type });
        const url = URL.createObjectURL(blob);
        const a = h('a', { href: url, download: filename, class: 'visually-hidden' });
        doc.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    function downloadSql() {
        commitSoon.flush();
        scheduleRefresh.flush();
        if (!state.sql) {
            toast('Nothing to download yet — create a valid query first.', 'error');
            return;
        }
        downloadFile(`${state.workspace.type}-query.sql`, `${state.sql}\n`, 'application/sql');
        toast('SQL file downloaded.', 'success');
    }

    function exportQuery() {
        commitSoon.flush();
        const payload = createQueryExport(state.workspace, { dialect: state.settings.dialect });
        downloadFile(`${state.workspace.type}-query.json`, JSON.stringify(payload, null, 2), 'application/json');
        toast('Query exported as JSON.', 'success');
    }

    function chooseFile(mode) {
        el.fileInput.dataset.mode = mode;
        el.fileInput.value = '';
        el.fileInput.click();
    }

    async function onFileChosen() {
        const file = el.fileInput.files && el.fileInput.files[0];
        if (!file) return;
        if (file.size > MAX_IMPORT_BYTES) {
            toast('That file is too large to import (limit 1 MB).', 'error');
            return;
        }
        let text;
        try {
            text = await file.text();
        } catch {
            toast('The file could not be read.', 'error');
            return;
        }
        if (el.fileInput.dataset.mode === 'templates') importTemplates(text);
        else importQuery(text);
    }

    function importQuery(text) {
        const result = parseQueryFile(text);
        if ('error' in result) {
            toast(`Import failed: ${result.error}`, 'error');
            return;
        }
        if (result.dialect && listDialects().some(d => d.id === result.dialect)) {
            updateSettings({ dialect: result.dialect });
        }
        replaceWorkspace(result.workspace, 'Query imported. Undo restores your previous query.');
    }

    function importTemplates(text) {
        const result = parseTemplatesFile(text);
        if ('error' in result) {
            toast(`Import failed: ${result.error}`, 'error');
            return;
        }
        try {
            const added = templates.importMany(result.templates);
            renderTemplates();
            toast(`Imported ${added.length} ${added.length === 1 ? 'template' : 'templates'}.`, 'success');
        } catch (error) {
            toast(error instanceof TemplateError ? error.message : 'Templates could not be imported.', 'error');
        }
    }

    function clearCurrent() {
        const type = state.workspace.type;
        mutate(() => { state.workspace[type] = createEmptyFor(type); });
        state.attempted = false;
        state.touched.clear();
        scheduleRefresh.flush();
        toast(`${type.toUpperCase()} cleared. Undo brings it back.`);
    }

    function resetAll() {
        replaceWorkspace(createWorkspace(), 'Workspace reset. Undo brings it back.');
    }

    function undo() {
        commitSoon.flush();
        const previous = undoStack.undo();
        if (!previous) return;
        state.workspace = previous;
        syncTypeTabs();
        renderBuilder();
        scheduleRefresh.flush();
        toast('Undone.');
    }

    function redo() {
        const next = undoStack.redo();
        if (!next) return;
        state.workspace = next;
        syncTypeTabs();
        renderBuilder();
        scheduleRefresh.flush();
        toast('Redone.');
    }

    function setType(type) {
        commitSoon.flush();
        state.workspace.type = type;
        state.attempted = false;
        undoStack.push(state.workspace);
        renderBuilder();
        scheduleRefresh.flush();
    }

    // ---------------------------------------------------------------- library

    function selectTab(name, focus = false) {
        state.libraryTab = name;
        el.tabs.forEach(tab => {
            const selected = tab.id === `tab-${name}`;
            tab.setAttribute('aria-selected', String(selected));
            tab.tabIndex = selected ? 0 : -1;
            doc.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
            if (selected && focus) tab.focus();
        });
    }

    function onTabKeydown(event) {
        const names = Array.from(el.tabs, tab => tab.id.replace('tab-', ''));
        const index = names.indexOf(state.libraryTab);
        const moves = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: names.length - 1 };
        if (!(event.key in moves)) return;
        event.preventDefault();
        selectTab(names[(moves[event.key] + names.length) % names.length], true);
    }

    function renderHistory() {
        const search = el.historySearch.value;
        const entries = history.search(search);
        renderHistoryList(el.historyList, entries, { enabled: state.settings.saveHistory || history.list().length > 0, filtered: search.trim() !== '' });
        el.historyClear.disabled = history.list().length === 0;
    }

    function renderTemplates() {
        renderTemplateList(el.templateList, templates.list());
        el.templateExport.disabled = templates.list().length === 0;
    }

    async function onLibraryClick(event) {
        const btn = event.target.closest('button[data-action]');
        if (!btn) return;
        const { action, id } = btn.dataset;
        try {
            switch (action) {
                case 'history-restore': {
                    const entry = history.get(id);
                    if (!entry) return;
                    if (entry.dialect !== state.settings.dialect) updateSettings({ dialect: entry.dialect });
                    replaceWorkspace(structuredClone(entry.workspace), 'Query restored from history.');
                    break;
                }
                case 'history-copy': {
                    const entry = history.get(id);
                    if (entry && await copyText(entry.sql)) toast('SQL copied to the clipboard.', 'success');
                    break;
                }
                case 'history-delete':
                    history.remove(id);
                    renderHistory();
                    el.historySearch.focus();
                    toast('Removed from history.');
                    break;
                case 'template-load': {
                    const template = templates.get(id);
                    if (template) replaceWorkspace(structuredClone(template.workspace), `Loaded “${template.name}”. Undo restores your previous query.`);
                    break;
                }
                case 'template-rename': {
                    const template = templates.get(id);
                    if (!template) return;
                    const name = await promptDialog(el.promptDialog, { title: 'Rename template', label: 'Template name', value: template.name, confirmText: 'Rename' });
                    if (name === null) return;
                    const renamed = templates.rename(id, name);
                    renderTemplates();
                    toast(`Renamed to “${renamed.name}”.`, 'success');
                    break;
                }
                case 'template-duplicate': {
                    const copy = templates.duplicate(id);
                    renderTemplates();
                    toast(`Created “${copy.name}”.`, 'success');
                    break;
                }
                case 'template-delete': {
                    const template = templates.get(id);
                    if (!template) return;
                    const ok = await confirmDialog(el.confirmDialog, { title: 'Delete template?', message: `“${template.name}” will be deleted from this browser.`, confirmText: 'Delete' });
                    if (!ok) return;
                    templates.remove(id);
                    renderTemplates();
                    el.templateSave.focus();
                    toast('Template deleted.');
                    break;
                }
                case 'example-load': {
                    const example = EXAMPLES.find(e => e.id === id);
                    if (example) replaceWorkspace(example.build(), `Loaded example “${example.name}”.`);
                    break;
                }
                default:
            }
        } catch (error) {
            toast(error instanceof TemplateError ? error.message : 'Something went wrong.', 'error');
        }
    }

    async function saveTemplate() {
        commitSoon.flush();
        const suggestion = state.workspace.type === 'select' && state.workspace.select.from.kind === 'table' && state.workspace.select.from.table
            ? `${state.workspace.select.from.table} query`
            : `${state.workspace.type.toUpperCase()} query`;
        const name = await promptDialog(el.promptDialog, { title: 'Save as template', label: 'Template name', value: suggestion });
        if (name === null) return;
        try {
            const template = templates.create(name, state.workspace);
            renderTemplates();
            selectTab('templates');
            toast(`Saved template “${template.name}”.`, 'success');
        } catch (error) {
            toast(error instanceof TemplateError ? error.message : 'The template could not be saved.', 'error');
        }
    }

    function exportTemplates() {
        const list = templates.list();
        if (list.length === 0) return;
        downloadFile('sql-templates.json', JSON.stringify(createTemplatesExport(list), null, 2), 'application/json');
        toast(`Exported ${list.length} ${list.length === 1 ? 'template' : 'templates'}.`, 'success');
    }

    // --------------------------------------------------------------- settings

    function updateSettings(patch) {
        const before = state.settings;
        state.settings = { ...state.settings, ...patch };
        saveSettings(storage, state.settings);
        if (patch.theme !== undefined) {
            applyTheme(state.settings.theme);
            renderThemeButton();
        }
        if (patch.saveHistory !== undefined) renderHistory();
        if (patch.restoreSession === false) storage.remove(DRAFT_KEY);
        if (patch.outputMode !== undefined) renderModeButtons();
        if (patch.dialect !== undefined && patch.dialect !== before.dialect) renderDialectNotes();
        if (state.generated && (patch.dialect !== undefined || patch.quoteIdentifiers !== undefined || patch.outputMode !== undefined)) {
            // Keep a manually generated query in sync with output preferences
            if (!hasErrors(validateWorkspace(state.workspace, { dialect: state.settings.dialect }))) {
                state.generated = { snapshot: state.generated.snapshot, sql: generateSQL(JSON.parse(state.generated.snapshot), generationOptions()) };
            }
        }
        scheduleRefresh.flush();
    }

    function renderThemeButton() {
        const theme = state.settings.theme;
        const label = theme === 'system' ? `System (${effectiveTheme(theme)})` : THEME_LABELS[theme];
        el.themeBtn.textContent = `Theme: ${label}`;
        el.themeBtn.setAttribute('aria-label', `Theme: ${label}. Activate to switch to ${THEME_LABELS[nextTheme(theme)]}.`);
    }

    function renderModeButtons() {
        el.modeButtons.forEach(btn => btn.setAttribute('aria-pressed', String(btn.dataset.outputMode === state.settings.outputMode)));
    }

    function renderDialectNotes() {
        const notes = getDialect(state.settings.dialect).notes;
        doc.getElementById('dialect-notes').textContent = notes.join(' ');
    }

    function openSettings() {
        const dialog = el.settingsDialog;
        const dialectSelect = dialog.querySelector('[data-setting="dialect"]');
        if (dialectSelect.options.length === 0) {
            dialectSelect.append(...listDialects().map(d => h('option', { value: d.id }, d.label)));
        }
        for (const input of dialog.querySelectorAll('[data-setting]')) {
            const key = input.dataset.setting;
            if (input.type === 'checkbox') input.checked = state.settings[key];
            else if (input.type === 'radio') input.checked = input.value === state.settings[key];
            else input.value = state.settings[key];
        }
        renderDialectNotes();
        showDialog(dialog, () => dialectSelect.focus());
    }

    function onSettingChange(event) {
        const input = event.target;
        const key = input.dataset.setting;
        if (!key) return;
        if (input.type === 'radio' && !input.checked) return;
        updateSettings({ [key]: input.type === 'checkbox' ? input.checked : input.value });
    }

    async function clearAllData() {
        const ok = await confirmDialog(el.confirmDialog, {
            title: 'Delete all saved data?',
            message: 'This removes your history, templates, saved settings and unsaved work from this browser. It cannot be undone.',
            confirmText: 'Delete everything'
        });
        if (!ok) return;
        history.clear();
        for (const t of templates.list()) templates.remove(t.id);
        storage.remove(DRAFT_KEY);
        storage.remove('settings');
        renderHistory();
        renderTemplates();
        toast('All saved data was deleted from this browser.', 'success');
    }

    function renderShortcuts() {
        const rows = doc.getElementById('shortcut-rows');
        rows.replaceChildren(...SHORTCUTS.map(s => h('tr', {},
            h('td', {}, s.keys.map((k, i) => [i > 0 ? ' + ' : '', h('kbd', {}, k === 'Mod' ? modLabel() : k)])),
            h('td', {}, s.description))));
    }

    // ------------------------------------------------------------------ wiring

    el.builder.addEventListener('input', onBuilderInput);
    el.builder.addEventListener('change', onBuilderChange);
    el.builder.addEventListener('click', onBuilderClick);
    el.builder.addEventListener('focusout', onBuilderFocusOut);
    el.builder.addEventListener('submit', (event) => event.preventDefault());
    el.builder.addEventListener('toggle', (event) => {
        const key = event.target.dataset && event.target.dataset.section;
        if (key) state.openSections.set(key, event.target.open);
    }, true);

    el.typeRadios.forEach(radio => radio.addEventListener('change', () => { if (radio.checked) setType(radio.value); }));
    el.generate.addEventListener('click', generate);
    el.clear.addEventListener('click', clearCurrent);
    el.reset.addEventListener('click', resetAll);
    el.undo.addEventListener('click', undo);
    el.redo.addEventListener('click', redo);
    el.copy.addEventListener('click', copySql);
    el.download.addEventListener('click', downloadSql);
    el.selectAll.addEventListener('click', () => {
        if (el.output.hidden) return;
        el.output.focus();
        selectContents(el.code);
    });
    el.modeButtons.forEach(btn => btn.addEventListener('click', () => updateSettings({ outputMode: btn.dataset.outputMode })));

    el.issuesList.addEventListener('click', (event) => {
        const btn = event.target.closest('button[data-goto]');
        if (btn) goToField(btn.dataset.goto);
    });
    el.outputState.addEventListener('click', onLibraryClick);

    doc.addEventListener('click', (event) => {
        const cmd = /** @type {any} */ (event.target).closest('[data-command]');
        if (!cmd) return;
        el.fileMenu.open = false;
        const commands = {
            'export-query': exportQuery,
            'import-query': () => chooseFile('query'),
            'download-sql': downloadSql,
            generate,
            copy: copySql
        };
        const run = commands[cmd.dataset.command];
        if (run) run();
    }, { signal });
    doc.addEventListener('click', (event) => {
        if (el.fileMenu.open && !el.fileMenu.contains(event.target)) el.fileMenu.open = false;
    }, { signal });

    el.themeBtn.addEventListener('click', () => updateSettings({ theme: nextTheme(state.settings.theme) }));
    el.shortcutsBtn.addEventListener('click', () => showDialog(el.shortcutsDialog));
    el.settingsBtn.addEventListener('click', openSettings);
    el.settingsDialog.addEventListener('change', onSettingChange);
    el.clearData.addEventListener('click', clearAllData);

    el.tabs.forEach(tab => {
        tab.addEventListener('click', () => selectTab(tab.id.replace('tab-', '')));
        tab.addEventListener('keydown', onTabKeydown);
    });
    el.historySearch.addEventListener('input', debounce(renderHistory, 150));
    el.historyClear.addEventListener('click', async () => {
        const ok = await confirmDialog(el.confirmDialog, { title: 'Clear history?', message: `All ${history.list().length} saved queries will be removed from this browser.`, confirmText: 'Clear history' });
        if (!ok) return;
        history.clear();
        renderHistory();
        toast('History cleared.');
    });
    el.libraryPanel.addEventListener('click', onLibraryClick);
    el.templateSave.addEventListener('click', saveTemplate);
    el.templateImport.addEventListener('click', () => chooseFile('templates'));
    el.templateExport.addEventListener('click', exportTemplates);
    el.fileInput.addEventListener('change', onFileChosen);

    [el.settingsDialog, el.promptDialog, el.confirmDialog, el.shortcutsDialog].forEach(enhanceDialog);

    bindShortcuts(doc, signal, {
        generate,
        copy: copySql,
        undo,
        redo,
        help: () => showDialog(el.shortcutsDialog),
        escape: () => {
            if (el.fileMenu.open) {
                el.fileMenu.open = false;
                el.fileMenu.querySelector('summary').focus();
            }
        }
    });

    try {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderThemeButton, { signal });
    } catch {
        // matchMedia unavailable
    }

    // --------------------------------------------------------------- startup

    applyTheme(state.settings.theme);
    renderThemeButton();
    renderModeButtons();
    renderShortcuts();
    el.storageNote.textContent = storage.available
        ? 'history, templates and settings are stored only in this browser'
        : 'browser storage is unavailable, so history and templates won\'t be kept';
    syncTypeTabs();
    renderBuilder();
    renderHistory();
    renderTemplates();
    renderExampleList(el.exampleList, EXAMPLES);
    selectTab('history');
    refresh();

    return {
        destroy: () => lifetime.abort(),
        get state() { return state; },
        history,
        templates,
        generate,
        undo,
        redo
    };
}
