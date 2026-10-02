// Application controller: owns the state, wires DOM events to model changes
// and re-renders. Rendering lives in ./ui/*, SQL logic in the core modules.

import {
    createWorkspace, createEmptyFor, createColumn, createCaseColumn, createWindowColumn, createCondition, createRawCondition,
    createGroup, createJoin, createTableSource, createSubquerySource, createCte, createSetOp, createOrderItem,
    createGroupByItem, createAssignment, createSelect, OPERATORS, getAt, setAt, parentPath, splitPath,
    isPristine, describeComplexity, withModelVersion
} from './model.js';
import { generateSQL } from './generator.js';
import { describeStructure } from './structure.js';
import { describeInsights } from './analysis.js';
import { levelNotes, summarizeWorkspace } from './explain.js';
import { compareDialects } from './dialect-compare.js';
import { validateWorkspace, hasErrors, summarize } from './validation.js';
import { listDialects, getDialect } from './dialects.js';
import { createStorage } from './storage.js';
import { splitTopLevel } from './sql-utils.js';
import { loadSettings, saveSettings, DEFAULT_SETTINGS, formatOptions, FORMAT_SETTINGS } from './settings.js';
import { createHistory } from './history.js';
import { createTemplateStore, TemplateError } from './templates.js';
import { createSchemaStore, SchemaError, tableToDdl, schemaToDdl } from './schema.js';
import { readDdl } from './ddl.js';
import { UndoStack } from './undo.js';
import {
    normalizeWorkspace, parseQueryFile, parseTemplatesFile, createQueryExport, createTemplatesExport, MAX_IMPORT_BYTES,
    createBackup, parseBackupFile, MAX_BACKUP_BYTES, createSchemaExport, readSchemaInput, MAX_SCHEMA_IMPORT_BYTES
} from './serialization.js';
import { EXAMPLES, EXAMPLE_TOPICS, EXAMPLE_LEVELS, examplesFor, formatSample } from './examples.js';
import { h, byPath, debounce, cssEscape, formatTime } from './ui/dom.js';
import { renderEditor } from './ui/builder.js';
import { createHelpPopover } from './ui/help-popover.js';
import { sectionHelp } from './section-help.js';
import { renderSqlCode, selectContents } from './ui/output.js';
import { renderDialectComparison } from './ui/compare.js';
import { renderHistoryList, renderTemplateList, renderExampleList, renderSchemaList, renderSchemaImportPreview } from './ui/library.js';
import { promptDialog, templateDialog, confirmDialog, showDialog, closeDialog, enhanceDialog, formDialog } from './ui/dialogs.js';
import { applyTheme, nextTheme, effectiveTheme, THEME_LABELS } from './ui/theme.js';
import { bindShortcuts, SHORTCUTS, modLabel } from './ui/shortcuts.js';
import { openPalette } from './ui/palette.js';
import { createSuggester } from './ui/suggest.js';
import { fieldContext, suggest } from './suggest.js';
import { analyzeJoin, applyJoinCandidate, isEmptyGroup, checkSchema } from './joins.js';
import { describeRelations } from './diagram.js';
import { renderDiagram, renderFlow } from './ui/diagram.js';
import { describeFlow, hasFlow } from './flow.js';
import { EXERCISES, findExercise, answerWorkspace, startWorkspace, practiceTables } from './exercises.js';
import { checkExercise, createPracticeStore } from './practice.js';
import { renderExerciseList, renderPracticePanel } from './ui/practice.js';
import { diffLines } from './versions.js';
import { renderVersionList, renderVersionCompare } from './ui/versions.js';
import { createProjectStore, projectCounts, ProjectError, MAIN_PROJECT } from './projects.js';
import { renderProjectList } from './ui/projects.js';
import { previewSqlImport, guessDialect } from './sql-import.js';
import { renderSqlImportPreview } from './ui/sql-import.js';
import { createWebPlatform } from './platform/web.js';

const DRAFT_KEY = 'draft';
// The saved template the current query was loaded from (restored with the draft)
const SOURCE_KEY = 'draft-source';
// Files the Schema panel can import
const SCHEMA_FILE_TYPES = '.sql,.ddl,.txt,.json,text/plain,application/sql,application/json';
// Files Import SQL can open
const SQL_FILE_TYPES = '.sql,.txt,text/plain,application/sql';

const NEW_TABLE_DDL = `CREATE TABLE table_name (
    id INT PRIMARY KEY,
    name VARCHAR(100)
);`;

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
    assignment: () => createAssignment(),
    upsertAssignment: () => ({ ...createAssignment(), valueType: 'inserted' })
};

/**
 * @param {{ doc?: Document, storage?: ReturnType<typeof createStorage>, platform?: import('./platform/types.js').Platform }} [options]
 *   platform: browser behaviour by default; the Android/iOS app passes the Capacitor adapter
 */
export function startApp({ doc = document, storage = createStorage(), platform = createWebPlatform(doc) } = {}) {
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
        share: $('share-btn'),
        download: $('download-btn'),
        selectAll: $('select-all-btn'),
        modeButtons: $$('[data-output-mode]'),
        wrap: $('wrap-btn'),
        dialectSelect: $('dialect-select'),
        templateFilter: $('template-filter'),
        templateSearch: $('template-search'),
        templateSort: $('template-sort'),
        exampleFilter: $('example-filter'),
        exampleTopic: $('example-topic'),
        complexity: $('complexity'),
        structure: $('structure'),
        queryName: $('query-name'),
        save: $('save-btn'),
        structureSteps: $('structure-steps'),
        structureInsights: $('structure-insights'),
        structureSentence: $('structure-sentence'),
        explainButtons: $$('[data-explain-level]'),
        structureNotes: $('structure-notes'),
        flow: $('flow'),
        flowScroll: $('flow-scroll'),
        flowLinks: $('flow-links'),
        diagram: $('diagram'),
        diagramScroll: $('diagram-scroll'),
        diagramLinks: $('diagram-links'),
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
        practice: $('practice'),
        practiceStatus: $('practice-status'),
        practiceLevel: $('practice-level'),
        practiceReset: $('practice-reset-btn'),
        practiceProgress: $('practice-progress'),
        practiceList: $('practice-list'),
        schemaList: $('schema-list'),
        schemaSearch: $('schema-search'),
        schemaSummary: $('schema-summary'),
        schemaAdd: $('schema-add-btn'),
        schemaImport: $('schema-import-btn'),
        schemaExport: $('schema-export-btn'),
        schemaClear: $('schema-clear-btn'),
        schemaTableDialog: $('schema-table-dialog'),
        schemaImportDialog: $('schema-import-dialog'),
        sqlImportDialog: $('sql-import-dialog'),
        compareDialog: $('compare-dialog'),
        versionsDialog: $('versions-dialog'),
        projectsDialog: $('projects-dialog'),
        moveDialog: $('move-dialog'),
        projectsBtn: $('projects-btn'),
        projectCurrent: $('project-current'),
        compare: $('compare-btn'),
        libraryPanel: /** @type {any} */ (doc.querySelector('.library-panel')),
        fileInput: $('file-input'),
        toast: $('toast'),
        storageNote: $('storage-note'),
        settingsDialog: $('settings-dialog'),
        promptDialog: $('prompt-dialog'),
        templateDialog: $('template-dialog'),
        confirmDialog: $('confirm-dialog'),
        shortcutsDialog: $('shortcuts-dialog'),
        paletteDialog: $('palette-dialog'),
        backupDialog: $('backup-dialog'),
        clearData: $('clear-data-btn'),
        viewSql: $('view-sql-btn'),
        statusBadge: $('status-badge')
    };

    // Listeners on document/window are tied to this signal so destroy() removes them
    const lifetime = new AbortController();
    const { signal } = lifetime;

    // Templates, history, the schema and the draft belong to the open
    // project; settings and practice progress are shared
    const projects = createProjectStore(storage);
    let projectData = projects.storageFor(projects.active);
    let history = createHistory(projectData);
    let templates = createTemplateStore(projectData);
    let schema = createSchemaStore(projectData);
    const practice = createPracticeStore(storage, EXERCISES.map(e => e.id));
    const undoStack = new UndoStack();

    const state = {
        settings: withProjectDialect(loadSettings(storage)),
        workspace: restoreDraft(),
        issues: /** @type {any[]} */ ([]),
        sql: '',                         // SQL currently shown (preview or generated)
        generated: /** @type {null | { snapshot: string, sql: string }} */ (null),
        attempted: false,                // Generate was pressed: show all field errors
        touched: new Set(),              // field paths the user has left
        openSections: new Map(),
        sourceId: /** @type {string | null} */ (null),   // template being edited
        libraryTab: 'history',
        templateFilter: 'all',           // dialect id or 'all'
        templateSearch: '',
        templateSort: 'name',            // 'name' or 'recent'
        exampleFilter: /** @type {string | null} */ (null), // null: follow the selected dialect
        compareWith: /** @type {string | null} */ (null), // the dialect last compared with
        exampleTopic: 'all',
        schemaSearch: '',
        practiceLevel: 'all',
        // The open exercise: hints shown, the last check (kept up to date once
        // checked), whether the model answer is shown or was loaded
        practiceView: newPracticeView()
    };
    // Set while the schema import dialog is open: fills it with a chosen file's text
    /** @type {null | ((text: string) => void)} */
    let fillSchemaImport = null;
    // Set while the Import SQL dialog is open: fills it with a chosen file's text
    /** @type {((text: string) => void) | null} */
    let fillSqlImport = null;
    /** @type {null | ReturnType<typeof createSuggester>} */
    let suggester = null;
    if (state.settings.restoreSession) {
        const sourceId = projectData.get(SOURCE_KEY);
        if (typeof sourceId === 'string' && templates.get(sourceId)) state.sourceId = sourceId;
    }
    undoStack.reset(state.workspace);

    /** Settings with the open project's dialect, when it has one. */
    function withProjectDialect(settings) {
        const dialect = projects.get(projects.active)?.dialect;
        return dialect && dialect !== settings.dialect ? { ...settings, dialect } : settings;
    }

    function restoreDraft() {
        const settings = loadSettings(storage);
        if (!settings.restoreSession) return createWorkspace();
        const draft = projectData.get(DRAFT_KEY);
        if (!draft) return createWorkspace();
        try {
            return normalizeWorkspace(draft);
        } catch {
            return createWorkspace();
        }
    }

    const validationOptions = () => ({
        dialect: state.settings.dialect,
        quoteIdentifiers: state.settings.quoteIdentifiers
    });

    const generationOptions = (pretty = state.settings.outputMode === 'formatted') => ({
        ...formatOptions(state.settings),
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
        isOpen: (key, fallback) => (state.openSections.has(key) ? state.openSections.get(key) : fallback),
        dialect: () => getDialect(state.settings.dialect)
    };

    // Section help: one popover for every info button in the builder
    const helpPopover = createHelpPopover({
        doc,
        root: el.builder,
        content: (key) => sectionHelp(key, state.settings.dialect),
        dialectLabel: () => getDialect(state.settings.dialect).shortLabel,
        signal
    });

    function renderBuilder(focus = null) {
        const active = /** @type {any} */ (doc.activeElement);
        const previous = active && el.builder.contains(active)
            ? { path: active.dataset.path, action: active.dataset.action }
            : null;

        if (suggester) suggester.close();
        el.builder.replaceChildren(renderEditor(state.workspace, ui));
        helpPopover.sync();
        renderJoinHints();

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

    // The validator's checks, plus hints from the schema (never errors)
    function currentIssues() {
        return [
            ...validateWorkspace(state.workspace, validationOptions()),
            ...checkSchema(state.workspace, schema.list(), getDialect(state.settings.dialect))
        ];
    }

    function refresh() {
        state.issues = currentIssues();
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
        renderJoinHints();
        renderStructure();
        renderQueryName();
        if (practice.active) {
            if (state.practiceView.result) state.practiceView.result = practiceResult();
            renderPractice();
        }
        el.undo.disabled = !undoStack.canUndo;
        el.redo.disabled = !undoStack.canRedo;
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
            renderStatusBadge(0, 0);
            return;
        }
        const { errors, warnings, suggestions, infos } = summarize(state.issues);
        const parts = [];
        if (errors) parts.push(`${errors} ${errors === 1 ? 'error' : 'errors'}`);
        if (warnings) parts.push(`${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`);
        if (suggestions) parts.push(`${suggestions} ${suggestions === 1 ? 'suggestion' : 'suggestions'}`);
        if (infos) parts.push(`${infos} ${infos === 1 ? 'tip' : 'tips'}`);
        el.issuesSummary.textContent = parts.length ? `— ${parts.join(', ')}` : '— all good';
        renderStatusBadge(errors, warnings);

        const labels = { error: 'Error', warning: 'Warning', suggestion: 'Suggestion', info: 'Tip' };
        const rank = { error: 0, warning: 1, suggestion: 2, info: 3 };
        // Errors first, then warnings, suggestions and tips; ids keep the validation index
        // because fields point at them with aria-describedby
        const ordered = state.issues.map((issue, i) => [issue, i]).sort((a, b) => rank[a[0].level] - rank[b[0].level] || a[1] - b[1]);
        el.issuesList.replaceChildren(...ordered.map(([issue, i]) => h('li', {
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

    // Error / warning count on the small-screen "View SQL" button
    function renderStatusBadge(errors, warnings) {
        const badge = el.statusBadge;
        if (!badge) return;
        const count = errors || warnings;
        badge.hidden = count === 0;
        badge.textContent = String(count);
        badge.dataset.level = errors ? 'error' : 'warning';
        const label = errors ? `${errors} ${errors === 1 ? 'error' : 'errors'}` : `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`;
        el.viewSql.setAttribute('aria-label', count ? `View SQL and checks (${label})` : 'View SQL and checks');
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

    /** The "Query structure" panel: counts in its summary, steps when opened. */
    function renderStructure() {
        el.structure.hidden = pristine();
        if (el.structure.hidden) return;
        const parts = [];
        if (state.workspace.type === 'select') {
            const { subqueries, joins, conditions } = describeComplexity(state.workspace.select);
            const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
            if (joins) parts.push(plural(joins, 'join'));
            if (subqueries) parts.push(subqueries === 1 ? '1 subquery' : `${subqueries} subqueries`);
            if (conditions) parts.push(plural(conditions, 'condition'));
        }
        el.complexity.textContent = parts.length ? `· ${parts.join(' · ')}` : '';
        renderInsights();

        const dialect = getDialect(state.settings.dialect);
        const { steps, notes } = describeStructure(state.workspace, dialect);
        const more = levelNotes(state.workspace, dialect, state.settings.explainLevel);
        el.structureSentence.textContent = summarizeWorkspace(state.workspace, dialect);
        el.explainButtons.forEach(btn => btn.setAttribute('aria-pressed', String(btn.dataset.explainLevel === state.settings.explainLevel)));
        el.structureSteps.replaceChildren(...steps.map((step, i) =>
            h('li', { class: 'structure-step' },
                h('button', {
                    type: 'button',
                    class: 'structure-jump',
                    dataset: { action: 'structure-jump', section: step.target.section || null, path: step.target.path || null }
                },
                h('span', { class: 'structure-index', 'aria-hidden': 'true' }, String(i + 1)),
                h('span', { class: 'structure-clause' }, step.clause),
                h('span', { class: 'structure-detail' }, step.detail)),
                h('p', { class: 'structure-explain' }, step.explanation),
                ...(more[step.key] || []).map(text => h('p', { class: 'structure-more' }, text)))));
        el.structureNotes.textContent = notes.join(' ');
        renderFlowPanel();
        renderDiagramPanel();
    }

    /** The query flow: shown when the SELECT has more than one part, drawn while open. */
    function renderFlowPanel() {
        const select = state.workspace.type === 'select' ? state.workspace.select : null;
        el.flow.hidden = !hasFlow(select);
        if (el.flow.hidden || !el.flow.open) return;
        const { svg, links } = renderFlow(describeFlow(select));
        const first = el.flowScroll.childElementCount === 0;
        el.flowScroll.replaceChildren(svg);
        el.flowLinks.replaceChildren(links);
        if (first) el.flowScroll.scrollLeft = Math.max(0, (el.flowScroll.scrollWidth - el.flowScroll.clientWidth) / 2);
    }

    /** The tables and joins diagram: shown when the main SELECT has a join, drawn while open. */
    function renderDiagramPanel() {
        const select = state.workspace.type === 'select' ? state.workspace.select : null;
        el.diagram.hidden = !select || select.joins.length === 0;
        if (el.diagram.hidden || !el.diagram.open) return;
        const { svg, links } = renderDiagram(describeRelations(select, { tables: schema.list() }));
        const first = el.diagramScroll.childElementCount === 0;
        el.diagramScroll.replaceChildren(svg);
        el.diagramLinks.replaceChildren(links);
        // On a narrow screen the drawing scrolls sideways; start at its middle,
        // where the FROM table is
        if (first) el.diagramScroll.scrollLeft = Math.max(0, (el.diagramScroll.scrollWidth - el.diagramScroll.clientWidth) / 2);
    }

    /** The insights row: how many parts a SELECT has, and a rough band. */
    function renderInsights() {
        const list = el.structureInsights;
        list.hidden = state.workspace.type !== 'select';
        if (list.hidden) return;
        const i = describeInsights(state.workspace.select);
        const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
        const items = [`Overall: ${i.band}`];
        if (i.ctes) items.push(count(i.ctes, 'CTE'));
        if (i.joins) items.push(count(i.joins, 'join'));
        if (i.subqueries) items.push(count(i.subqueries, 'subquery', 'subqueries'));
        if (i.setOps) items.push(count(i.setOps, 'combined query', 'combined queries'));
        if (i.aggregates) items.push(count(i.aggregates, 'aggregate'));
        if (i.windows) items.push(count(i.windows, 'window function'));
        if (i.filters) items.push(count(i.filters, 'filter'));
        if (i.depth) items.push(`nesting depth ${i.depth}`);
        list.replaceChildren(...items.map((text, n) => h('li', { class: n === 0 ? `insight insight-band band-${i.band}` : 'insight' }, text)));
    }

    /** Opens a builder section (or finds a field) and moves focus to it. */
    function jumpTo({ section, path }) {
        const details = section ? el.builder.querySelector(`details[data-section="${cssEscape(section)}"]`) : null;
        if (!details) {
            if (path) goToField(path);
            return;
        }
        // A part inside a closed CTE or subquery opens the sections around it too
        for (let node = details; node && el.builder.contains(node); node = node.parentElement?.closest('details')) {
            node.open = true;
            if (node.dataset.section) state.openSections.set(node.dataset.section, true);
        }
        const summary = details.querySelector('summary');
        summary.focus();
        if (typeof summary.scrollIntoView === 'function') summary.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }

    const saveDraft = debounce(() => {
        if (state.settings.restoreSession) {
            projectData.set(DRAFT_KEY, withModelVersion(state.workspace));
            if (state.sourceId) projectData.set(SOURCE_KEY, state.sourceId);
            else projectData.remove(SOURCE_KEY);
        } else {
            projectData.remove(DRAFT_KEY);
            projectData.remove(SOURCE_KEY);
        }
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

    /**
     * Replaces the whole query. `sourceId` is the template it came from, if
     * any: Save then updates that template instead of creating a new one.
     */
    function replaceWorkspace(workspace, message, sourceId = null) {
        commitSoon.flush();
        state.workspace = workspace;
        state.sourceId = sourceId;
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
        if (c.valueType === 'param' && spec.operands !== 1 && spec.operands !== 2) c.valueType = 'value';
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
                if (path.endsWith('upsert.mode') && value === 'update') {
                    const upsert = getAt(state.workspace, parentPath(path));
                    if (upsert.set.length === 0) upsert.set.push(ITEM_FACTORIES.upsertAssignment());
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
        } else if (action === 'use-join-on') {
            const found = analyzeJoin(state.workspace, path, schema.list(), getDialect(state.settings.dialect));
            const candidate = found && found.candidates[Number(arg)];
            if (!candidate) return;
            mutate(() => applyJoinCandidate(found.join, candidate), { within: `${path}.on` });
            toast(`Joined on ${candidate.label}.`);
        } else if (action === 'fill-upsert') {
            mutate(() => fillUpsert(path), { path, action: 'fill-upsert' });
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

    // Under each join's ON: the conditions the schema's foreign keys suggest,
    // shown while ON is still empty. Updated in place, never re-rendering the editor.
    function renderJoinHints() {
        const tables = schema.list();
        const dialect = getDialect(state.settings.dialect);
        el.builder.querySelectorAll('[data-join-hint]').forEach((/** @type {any} */ box) => {
            const path = box.dataset.joinHint;
            const found = tables.length ? analyzeJoin(state.workspace, path, tables, dialect) : null;
            const show = Boolean(found && found.target && found.target.table && found.earlier.length && isEmptyGroup(found.join.on));
            const signature = show ? `${found.target.table.name}|${found.candidates.map(c => c.label).join('|')}` : '';
            if (box.dataset.signature === signature) return;
            box.dataset.signature = signature;
            box.hidden = !show;
            if (!show) {
                box.replaceChildren();
                return;
            }
            const name = found.target.table.name;
            box.replaceChildren(found.candidates.length
                ? h('p', { class: 'join-hint-text' }, `Your schema links ${name} to the tables before it:`)
                : h('p', { class: 'join-hint-text' }, `No foreign key in your schema links ${name} to the tables before it; write the ON condition below.`),
            ...found.candidates.slice(0, 4).map((candidate, i) => h('button', {
                type: 'button',
                class: 'btn btn-secondary btn-sm join-hint-use',
                dataset: { action: 'use-join-on', path, arg: i },
                'aria-label': `Use ON ${candidate.label}`
            }, h('span', { 'aria-hidden': 'true' }, 'Use '), h('code', {}, candidate.label))));
        });
    }

    // Upsert: update every inserted column (except the conflict key) with the
    // value the row tried to insert. Existing assignments for other columns stay.
    function fillUpsert(upsertPath) {
        const insert = getAt(state.workspace, parentPath(upsertPath));
        const upsert = insert.upsert;
        const key = (text) => String(text).trim().toLowerCase();
        const conflict = new Set(splitTopLevel(upsert.conflict).filter(Boolean).map(key));
        const kept = upsert.set.filter(a => key(a.column) !== '');
        const present = new Set(kept.map(a => key(a.column)));
        const added = splitTopLevel(insert.columns).filter(Boolean)
            .filter(c => !conflict.has(key(c)) && !present.has(key(c)))
            .map(column => ({ column, valueType: 'inserted', value: '' }));
        upsert.set = [...kept, ...added];
        if (added.length === 0 && kept.length === 0) {
            toast('List the INSERT columns first, then fill the update from them.');
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
        state.issues = currentIssues();
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

    const copyText = (text) => platform.copyText(text);

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

    /**
     * Saves a file through the platform (browser download, or the Android share
     * sheet) and reports the outcome. `done` is the success message.
     */
    async function downloadFile(filename, text, mimeType, done) {
        const result = await platform.saveFile({ filename, text, mimeType });
        if (result.status === 'saved' || result.status === 'shared') {
            toast(result.status === 'shared' ? `Exported ${filename}.` : done, 'success');
            return true;
        }
        if (result.status === 'cancelled') {
            toast('Export cancelled.');
        } else {
            toast(`Export failed${result.message ? `: ${result.message}` : '.'}`, 'error');
        }
        return false;
    }

    async function downloadSql() {
        commitSoon.flush();
        scheduleRefresh.flush();
        if (!state.sql) {
            toast('Nothing to download yet — create a valid query first.', 'error');
            return;
        }
        await downloadFile(`${state.workspace.type}-query.sql`, `${state.sql}\n`, 'application/sql', 'SQL file downloaded.');
    }

    async function shareSql() {
        commitSoon.flush();
        scheduleRefresh.flush();
        if (!state.sql) {
            toast('Nothing to share yet — create a valid query first.', 'error');
            return;
        }
        const result = await platform.shareText({ title: 'SQL query', text: state.sql });
        if (result.status === 'failed') toast(`Sharing failed${result.message ? `: ${result.message}` : '.'}`, 'error');
        else if (result.status === 'cancelled') toast('Sharing cancelled.');
    }

    async function exportQuery() {
        commitSoon.flush();
        const payload = createQueryExport(state.workspace, { dialect: state.settings.dialect });
        await downloadFile(`${state.workspace.type}-query.json`, JSON.stringify(payload, null, 2), 'application/json', 'Query exported as JSON.');
    }

    function chooseFile(mode) {
        el.fileInput.dataset.mode = mode;
        el.fileInput.accept = mode === 'schema' ? SCHEMA_FILE_TYPES : mode === 'sql' ? SQL_FILE_TYPES : '.json,application/json';
        el.fileInput.value = '';
        el.fileInput.click();
    }

    async function onFileChosen() {
        const file = el.fileInput.files && el.fileInput.files[0];
        if (!file) return;
        const mode = el.fileInput.dataset.mode;
        const limit = mode === 'backup' ? MAX_BACKUP_BYTES : mode === 'schema' ? MAX_SCHEMA_IMPORT_BYTES : MAX_IMPORT_BYTES;
        if (file.size > limit) {
            toast(`That file is too large to import (limit ${limit / 1024 / 1024} MB).`, 'error');
            return;
        }
        let text;
        try {
            text = await file.text();
        } catch {
            toast('The file could not be read.', 'error');
            return;
        }
        if (mode === 'schema') {
            if (fillSchemaImport) fillSchemaImport(text);
        } else if (mode === 'sql') {
            if (fillSqlImport) fillSqlImport(text);
        } else if (mode === 'templates') importTemplates(text);
        else if (mode === 'backup') await restoreBackup(text);
        else importQuery(text);
    }

    function importQuery(text) {
        const result = parseQueryFile(text);
        if ('error' in result) {
            toast(`Import failed: ${result.error}`, 'error');
            return;
        }
        const switched = switchDialect(result.dialect);
        replaceWorkspace(result.workspace, `Query imported${switched}. Undo restores your previous query.`);
    }

    // Import SQL: reads a SELECT, INSERT, UPDATE or DELETE into the builder.
    // The dialog shows what will be imported, and where it can't be; Import
    // replaces the query of that type, which Undo brings back.
    async function importSql() {
        const dialog = el.sqlImportDialog;
        const input = dialog.querySelector('#sql-import-text');
        const select = dialog.querySelector('#sql-import-dialect');
        const guessNote = dialog.querySelector('#sql-import-guess');
        const output = dialog.querySelector('#sql-import-result');
        select.replaceChildren(...listDialects().map(d => h('option', { value: d.id }, d.label)));
        select.value = state.settings.dialect;
        guessNote.textContent = '';
        input.value = '';
        // Once the person picks a dialect, it is no longer guessed
        let picked = false;
        /** @type {any} */
        let result = null;
        const preview = () => {
            const text = input.value;
            if (!picked) {
                const guess = text.trim() ? guessDialect(text) : null;
                select.value = guess ? guess.dialect : state.settings.dialect;
                guessNote.textContent = guess && guess.dialect !== state.settings.dialect
                    ? `This looks like ${getDialect(guess.dialect).label} (${guess.reason}).` : '';
            }
            try {
                result = text.trim() ? previewSqlImport(text, { dialect: select.value, quoteIdentifiers: state.settings.quoteIdentifiers, format: formatOptions(state.settings) }) : null;
            } catch {
                result = { ok: false, message: 'This SQL couldn\'t be read.', line: 0, col: 0 };
            }
            renderSqlImportPreview(output, result);
        };
        const onInput = debounce(preview, 250);
        const onDialect = () => {
            picked = true;
            guessNote.textContent = '';
            preview();
        };
        const fill = (/** @type {string} */ text) => {
            input.value = text;
            onInput.cancel();
            preview();
            input.focus();
        };
        const onFile = () => chooseFile('sql');
        // A .sql file dropped on the dialog is read like a chosen one
        const onDragOver = (/** @type {any} */ event) => {
            if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
        };
        const onDrop = async (/** @type {any} */ event) => {
            const file = event.dataTransfer?.files?.[0];
            if (!file) return;
            event.preventDefault();
            if (file.size > MAX_IMPORT_BYTES) {
                toast(`That file is too large to import (limit ${MAX_IMPORT_BYTES / 1024 / 1024} MB).`, 'error');
                return;
            }
            try {
                fill(await file.text());
            } catch {
                toast('The file could not be read.', 'error');
            }
        };
        const fileButton = dialog.querySelector('#sql-import-file-btn');
        preview();
        input.addEventListener('input', onInput);
        select.addEventListener('change', onDialect);
        fileButton.addEventListener('click', onFile);
        dialog.addEventListener('dragover', onDragOver);
        dialog.addEventListener('drop', onDrop);
        fillSqlImport = fill;
        let ok;
        try {
            ok = await formDialog(dialog, {
                onOpen: () => input.focus(),
                validate: () => {
                    onInput.flush();
                    if (result && result.ok) return true;
                    if (!result) renderSqlImportPreview(output, { ok: false, message: 'Paste a statement or choose a file first.', line: 0, col: 0 });
                    input.focus();
                    return false;
                }
            });
        } finally {
            onInput.cancel();
            input.removeEventListener('input', onInput);
            select.removeEventListener('change', onDialect);
            fileButton.removeEventListener('click', onFile);
            dialog.removeEventListener('dragover', onDragOver);
            dialog.removeEventListener('drop', onDrop);
            fillSqlImport = null;
        }
        if (!ok || !result || !result.ok) return;
        commitSoon.flush();
        const workspace = JSON.parse(JSON.stringify(state.workspace));
        const type = result.query.kind;
        workspace.type = type;
        workspace[type] = result.query;
        const switched = switchDialect(select.value);
        replaceWorkspace(workspace, `${type.toUpperCase()} query imported${switched}. Undo brings back your previous query.`);
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

    // ----------------------------------------------------------------- backup

    const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

    async function exportBackup() {
        commitSoon.flush();
        saveDraft.flush();
        // Main at the top level, as before projects; the others listed after it
        const main = storesFor(MAIN_PROJECT);
        const others = projects.list().filter(p => p.id !== MAIN_PROJECT).map(p => {
            const stores = storesFor(p.id);
            return { name: p.name, dialect: p.dialect, templates: stores.templates.list(), history: stores.history.list(), schema: stores.schema.list() };
        });
        const backup = createBackup({ templates: main.templates.list(), history: main.history.list(), settings: state.settings, schema: main.schema.list(), projects: others });
        const all = [backup, ...(backup.projects || [])];
        const total = (/** @type {(b: any) => number} */ of) => all.reduce((n, b) => n + of(b), 0);
        const tables = total(b => b.schema.tables.length);
        const date = new Date().toISOString().slice(0, 10);
        await downloadFile(`sql-builder-backup-${date}.json`, JSON.stringify(backup, null, 2), 'application/json',
            `Backed up ${count(total(b => b.templates.length), 'template')}, ${count(total(b => b.history.length), 'history entry', 'history entries')}${tables ? `, ${count(tables, 'schema table')}` : ''}${others.length ? ` in ${count(others.length + 1, 'project')}` : ''} and your settings.`);
    }

    /** Asks how to restore. Resolves 'merge', 'replace' or null. */
    async function askRestoreMode(backup) {
        const dialog = el.backupDialog;
        const when = Date.parse(backup.exportedAt);
        const extra = backup.projects.length
            ? ` for the Main project, and ${count(backup.projects.length, 'other project')} (${backup.projects.map((/** @type {any} */ p) => p.name).join(', ')})`
            : '';
        dialog.querySelector('#backup-summary').textContent = `This backup${Number.isNaN(when) ? '' : ` from ${formatTime(when)}`} has ${count(backup.templates.length, 'template')}, ${count(backup.history.length, 'history entry', 'history entries')}${backup.schema && backup.schema.length ? `, ${count(backup.schema.length, 'schema table')}` : ''}${extra} and settings. Nothing changes until you choose Restore.`;
        const merge = dialog.querySelector('input[value="merge"]');
        merge.checked = true;
        const result = await showDialog(dialog, () => merge.focus());
        if (result !== 'confirm') return null;
        return dialog.querySelector('input[name="backup-mode"]:checked').value === 'replace' ? 'replace' : 'merge';
    }

    async function restoreBackup(text) {
        const backup = parseBackupFile(text);
        if ('error' in backup) {
            toast(`Restore failed: ${backup.error}`, 'error');
            return;
        }
        const mode = await askRestoreMode(backup);
        if (!mode) return;
        const replace = mode === 'replace';
        commitSoon.flush();
        saveDraft.flush();
        // The backup's top level is the Main project (as in backups from before projects)
        const activeBefore = projects.active;
        const main = storesFor(MAIN_PROJECT);
        const otherProjects = projects.list().filter(p => p.id !== MAIN_PROJECT);
        if (replace) {
            const mainName = projects.get(MAIN_PROJECT)?.name ?? 'Main';
            const ok = await confirmDialog(el.confirmDialog, {
                title: 'Replace your saved data?',
                message: `${otherProjects.length ? `In ${mainName}, your` : 'Your'} ${count(main.templates.list().length, 'template')}${backup.schema && main.schema.size ? `, ${count(main.history.list().length, 'history entry', 'history entries')} and ${count(main.schema.size, 'schema table')}` : ` and ${count(main.history.list().length, 'history entry', 'history entries')}`} will be deleted and replaced by the backup's${otherProjects.length ? `, your ${count(otherProjects.length, 'other project')} (${otherProjects.map(p => p.name).join(', ')}) will be deleted` : ''}, and your settings will change to the backup's. This cannot be undone.`,
                confirmText: 'Replace'
            });
            if (!ok) return;
        }
        let added;
        let tables = null;
        try {
            // The schema first: if it doesn't fit, nothing has changed yet
            if (backup.schema) tables = main.schema.apply(backup.schema, { replace, onConflict: 'keep' });
            added = main.templates.restore(backup.templates, { replace });
        } catch (error) {
            toast(error instanceof TemplateError || error instanceof SchemaError ? `Restore failed: ${error.message}` : 'The backup could not be restored.', 'error');
            renderSchema();
            return;
        }
        if (replace) updateSettings(backup.settings);
        const parts = [`${count(added.added, 'template')} added${added.skipped ? ` (${added.skipped} already here)` : ''}`];
        // History stays off when the person turned it off
        if (state.settings.saveHistory) {
            const restored = main.history.restore(backup.history, { replace });
            parts.push(`${count(restored.added, 'history entry', 'history entries')} added${restored.skipped ? ` (${restored.skipped} already here)` : ''}${restored.dropped ? `, keeping the newest ${main.history.list().length}` : ''}`);
        } else {
            // Replace promised to remove the current history, even when the backup's is not restored
            if (replace) main.history.clear();
            if (backup.history.length) parts.push('history not restored because saving history is turned off');
        }
        if (tables && backup.schema.length) parts.push(`${count(tables.added, 'schema table')} added${tables.kept ? ` (${tables.kept} already here)` : ''}`);
        else if (replace && !tables && main.schema.size) parts.push('your schema was kept because this backup was made before schemas existed');
        parts.push(...restoreProjects(backup.projects, { replace, otherProjects }));
        // Replace deleted the open project: Main is open now
        if (projects.active !== activeBefore) loadProject();
        if (state.sourceId && !templates.get(state.sourceId)) {
            state.sourceId = null;
            saveDraft();
        }
        renderTemplates();
        renderHistory();
        renderSchema();
        renderQueryName();
        renderProjectBar();
        toast(`Backup restored: ${parts.join(', ')}. ${replace ? 'Settings restored from the backup.' : 'Your settings were kept.'}`, 'success');
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
        // Typing since the last undo is a new change: record it (which clears
        // the redo list) instead of silently replacing it with the redo state
        commitSoon.flush();
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

    // Pinned first, then by name or most recently updated; filtered by dialect and search text
    function renderTemplates() {
        const all = templates.list();
        const filter = state.templateFilter;
        const query = state.templateSearch.trim();
        const needle = query.toLowerCase();
        // Templates saved without a dialect (older versions) are shown for every dialect
        const shown = all
            .filter(t => filter === 'all' || !t.dialect || t.dialect === filter)
            .filter(t => !needle || [t.name, t.description, t.category, t.dialect && getDialect(t.dialect).label, t.workspace.type]
                .some(text => text && text.toLowerCase().includes(needle)))
            .sort((a, b) => (Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)))
                || (state.templateSort === 'recent' ? b.updatedAt - a.updatedAt : a.name.localeCompare(b.name)));
        renderTemplateList(el.templateList, shown, {
            total: all.length,
            filterLabel: filter === 'all' ? '' : getDialect(filter).label,
            query,
            currentId: state.sourceId,
            canMove: projects.size > 1
        });
        el.templateExport.disabled = all.length === 0;
    }

    // Examples that work in the chosen dialect, with SQL previewed in that dialect
    function renderExamples() {
        const filter = state.exampleFilter ?? state.settings.dialect;
        el.exampleFilter.value = filter;
        const shown = examplesFor(filter, state.exampleTopic);
        const dialect = filter === 'all' ? state.settings.dialect : filter;
        renderExampleList(el.exampleList, shown, (workspace) => {
            try {
                return generateSQL(workspace, { dialect, quoteIdentifiers: false, pretty: false, keywordCase: state.settings.keywordCase });
            } catch {
                return '';
            }
        });
    }

    // ---------------------------------------------------------------- practice

    function newPracticeView() {
        return { hints: 0, result: /** @type {null | ReturnType<typeof checkExercise>} */ (null), answer: false, answerLoaded: false };
    }

    function renderPracticeList() {
        const shown = EXERCISES.filter(e => state.practiceLevel === 'all' || e.level === state.practiceLevel);
        renderExerciseList(el.practiceList, shown, { isDone: practice.isDone, active: practice.active });
        const done = practice.doneCount;
        el.practiceProgress.textContent = `${done} of ${EXERCISES.length} exercises done.`;
        el.practiceReset.disabled = done === 0;
    }

    /** The open exercise checked against the current query. */
    function practiceResult() {
        const ex = findExercise(/** @type {string} */ (practice.active));
        return checkExercise(ex, state.workspace, { errors: state.issues.filter(i => i.level === 'error').length });
    }

    function renderPractice() {
        const ex = practice.active ? findExercise(practice.active) : null;
        el.practice.hidden = !ex;
        if (!ex) {
            el.practice.replaceChildren();
            return;
        }
        // Re-rendering replaces the buttons: keep focus on the same one
        const active = /** @type {any} */ (doc.activeElement);
        const focused = el.practice.contains(active) ? active?.dataset?.action : null;
        const all = practiceTables();
        const view = state.practiceView;
        let answerSql = null;
        if (view.answer) {
            try {
                answerSql = generateSQL(answerWorkspace(ex), generationOptions());
            } catch {
                answerSql = ex.answer;
            }
        }
        const index = EXERCISES.indexOf(ex);
        renderPracticePanel(el.practice, ex, {
            tables: ex.tables.map(name => all.find(t => t.name === name)).filter(Boolean),
            missing: all.filter(t => !schema.get(t.name)).length,
            hints: view.hints,
            result: view.result,
            answerSql,
            answerLoaded: view.answerLoaded,
            next: EXERCISES.slice(index + 1).find(e => !practice.isDone(e.id)) || null
        });
        if (focused) {
            const again = el.practice.querySelector(`[data-action="${cssEscape(focused)}"]`);
            (again || el.practice.querySelector('[data-action="practice-check"]'))?.focus();
        }
    }

    function startExercise(id) {
        const ex = findExercise(id);
        if (!ex) return;
        const hadWork = !pristine();
        practice.setActive(ex.id);
        state.practiceView = newPracticeView();
        replaceWorkspace(startWorkspace(ex), `Started “${ex.title}”.${hadWork ? ' Undo brings back your previous query.' : ''}`);
        renderPracticeList();
        showPractice();
    }

    function showPractice() {
        renderPractice();
        el.practice.scrollIntoView?.({ block: 'start' });
        doc.getElementById('practice-title')?.focus({ preventScroll: true });
    }

    function stopPractice() {
        practice.setActive(null);
        state.practiceView = newPracticeView();
        renderPractice();
        renderPracticeList();
        el.builder.focus();
    }

    async function onPracticeClick(event) {
        const button = event.target.closest('button[data-action]');
        if (!button || !el.practice.contains(button)) return;
        const ex = practice.active ? findExercise(practice.active) : null;
        const view = state.practiceView;
        switch (button.dataset.action) {
            case 'practice-check': {
                if (!ex) return;
                commitSoon.flush();
                scheduleRefresh.flush();
                view.result = practiceResult();
                // A pass after loading the model answer doesn't count as done
                if (view.result.passed && !view.answerLoaded) {
                    practice.markDone(ex.id);
                    renderPracticeList();
                }
                renderPractice();
                // Safari doesn't focus a clicked button, so say where focus goes
                el.practice.querySelector('[data-action="practice-check"]')?.focus();
                const { results, passed } = view.result;
                el.practiceStatus.textContent = passed
                    ? `All checks pass.${view.answerLoaded ? '' : ' Exercise done.'}`
                    : `${results.filter(r => r.ok).length} of ${results.length} checks pass.`;
                break;
            }
            case 'practice-hint':
                if (!ex || view.hints >= ex.hints.length) return;
                view.hints++;
                renderPractice();
                el.practiceStatus.textContent = `Hint ${view.hints}: ${ex.hints[view.hints - 1]}`;
                (el.practice.querySelector('[data-action="practice-hint"]') || el.practice.querySelector('[data-action="practice-check"]'))?.focus();
                break;
            case 'practice-answer':
                view.answer = true;
                renderPractice();
                el.practice.querySelector('.practice-answer-sql')?.focus();
                break;
            case 'practice-load-answer':
                if (!ex) return;
                view.answerLoaded = true;
                replaceWorkspace(answerWorkspace(ex), 'Loaded the model answer. Undo brings back your query.');
                el.practice.querySelector('[data-action="practice-check"]')?.focus();
                break;
            case 'practice-schema': {
                try {
                    const { added, kept } = schema.apply(practiceTables(), { onConflict: 'keep' });
                    renderSchema();
                    renderPractice();
                    toast(`Added ${added} practice table${added === 1 ? '' : 's'} to your schema${kept ? `; ${kept} with the same name ${kept === 1 ? 'was' : 'were'} left as ${kept === 1 ? 'it was' : 'they were'}` : ''}.`, 'success');
                    el.practice.querySelector('[data-action="practice-check"]')?.focus();
                } catch (error) {
                    toast(error instanceof SchemaError ? error.message : 'Something went wrong.', 'error');
                }
                break;
            }
            case 'practice-start':
                startExercise(button.dataset.id);
                break;
            case 'practice-stop':
                stopPractice();
                break;
            default:
        }
    }

    function dialectOptions(withAll) {
        return [...(withAll ? [h('option', { value: 'all' }, 'All dialects')] : []), ...listDialects().map(d => h('option', { value: d.id }, d.label))];
    }

    // After the user picks a dialect: say what changed, including parts of the
    // query the new dialect can't express (they stay in the query, see Checks)
    function announceDialect() {
        const dialect = getDialect(state.settings.dialect);
        const blocked = state.issues.filter(i => i.category === 'dialect' && i.level === 'error').length;
        toast(blocked === 0
            ? `Dialect: ${dialect.label}.`
            : `Dialect: ${dialect.label}. ${blocked === 1 ? '1 part' : `${blocked} parts`} of this query ${blocked === 1 ? 'isn\'t' : 'aren\'t'} supported there; see Checks.`,
        blocked === 0 ? 'info' : 'error');
    }

    /**
     * Switches to the dialect a saved query was made for. Returns a note for
     * the toast (" (dialect: MySQL)") or '' when nothing changed.
     */
    /** Compare dialects: the current query written for another dialect, and what changes. */
    async function compareWithDialect() {
        commitSoon.flush();
        const dialog = el.compareDialog;
        const select = dialog.querySelector('#compare-dialect');
        const output = dialog.querySelector('#compare-result');
        const switchButton = dialog.querySelector('#compare-switch');
        const current = state.settings.dialect;
        const others = listDialects().filter(d => d.id !== current);
        select.replaceChildren(...others.map(d => h('option', { value: d.id }, d.label)));
        if (others.some(d => d.id === state.compareWith)) select.value = state.compareWith;
        dialog.querySelector('#compare-intro').textContent =
            `Your query as ${getDialect(current).label} writes it, next to another dialect. Nothing changes unless you switch.`;
        const render = () => {
            state.compareWith = select.value;
            renderDialectComparison(output, compareDialects(state.workspace, current, select.value, { quoteIdentifiers: state.settings.quoteIdentifiers, format: formatOptions(state.settings) }));
            switchButton.textContent = `Switch to ${getDialect(select.value).label}`;
        };
        render();
        select.addEventListener('change', render);
        let ok;
        try {
            ok = await formDialog(dialog, { onOpen: () => select.focus(), validate: () => true });
        } finally {
            select.removeEventListener('change', render);
        }
        if (!ok) return;
        updateSettings({ dialect: select.value });
        announceDialect();
    }

    // ---------------------------------------------------------------- projects

    /** The stores of a project: the open ones, or new ones on its storage. */
    function storesFor(id) {
        if (id === projects.active) return { history, templates, schema };
        const data = projects.storageFor(id);
        return { history: createHistory(data), templates: createTemplateStore(data), schema: createSchemaStore(data) };
    }

    function renderProjectBar() {
        el.projectCurrent.textContent = projects.get(projects.active)?.name ?? 'Main';
    }

    /** Loads the open project's stores and query into the app. */
    function loadProject() {
        projectData = projects.storageFor(projects.active);
        history = createHistory(projectData);
        templates = createTemplateStore(projectData);
        schema = createSchemaStore(projectData);
        state.workspace = restoreDraft();
        state.sourceId = null;
        if (state.settings.restoreSession) {
            const sourceId = projectData.get(SOURCE_KEY);
            if (typeof sourceId === 'string' && templates.get(sourceId)) state.sourceId = sourceId;
        }
        state.attempted = false;
        state.touched.clear();
        state.generated = null;
        // Undo doesn't reach into another project
        undoStack.reset(state.workspace);
        const dialect = projects.get(projects.active)?.dialect;
        if (dialect && dialect !== state.settings.dialect) updateSettings({ dialect });
        syncTypeTabs();
        renderBuilder();
        renderHistory();
        renderTemplates();
        renderSchema();
        renderProjectBar();
        scheduleRefresh.flush();
    }

    /** Opens another project; the current query stays in the one it was built in. */
    function openProject(id, message) {
        commitSoon.flush();
        saveDraft.flush();
        projects.setActive(id);
        loadProject();
        toast(message, 'success');
    }

    /**
     * Restores a backup's other projects. Merge adds to a project with the
     * same name, or creates it; replace deletes the other projects first.
     * Each project is restored on its own, so one that doesn't fit doesn't
     * stop the rest. Returns lines for the summary.
     */
    function restoreProjects(list, { replace, otherProjects }) {
        const parts = [];
        if (replace) {
            for (const p of otherProjects) {
                if (p.id === projects.active) projects.setActive(MAIN_PROJECT);
                projects.remove(p.id);
            }
        }
        let done = 0;
        const failed = [];
        for (const item of list) {
            try {
                const same = projects.list().find(p => p.id !== MAIN_PROJECT && p.name.toLowerCase() === item.name.toLowerCase());
                const target = same || projects.create(freeProjectName(item.name), { dialect: item.dialect });
                const stores = storesFor(target.id);
                if (item.schema.length) stores.schema.apply(item.schema, { onConflict: 'keep' });
                stores.templates.restore(item.templates);
                if (state.settings.saveHistory) stores.history.restore(item.history);
                done++;
            } catch (error) {
                failed.push(`${item.name} (${error instanceof Error && (error instanceof TemplateError || error instanceof SchemaError || error instanceof ProjectError) ? error.message : 'could not be restored'})`);
            }
        }
        if (done) parts.push(`${count(done, 'other project')} restored`);
        if (failed.length) parts.push(`not restored: ${failed.join('; ')}`);
        return parts;
    }

    /** "Report", or "Report (2)" when a project already has that name. */
    function freeProjectName(name) {
        if (!projects.named(name)) return name;
        for (let n = 2; ; n++) {
            const candidate = `${name.slice(0, 54)} (${n})`;
            if (!projects.named(candidate)) return candidate;
        }
    }

    async function openProjects() {
        const dialog = el.projectsDialog;
        const list = dialog.querySelector('#projects-list');
        const form = dialog.querySelector('#projects-form');
        const input = dialog.querySelector('#project-new-name');
        const error = dialog.querySelector('#project-error');
        const render = (focusAction = null, focusId = null) => {
            renderProjectList(list, projects.list(), {
                active: projects.active,
                counts: (id) => (id === projects.active
                    ? { templates: templates.list().length, history: history.list().length, tables: schema.size }
                    : projectCounts(projects.storageFor(id))),
                dialectLabel: (d) => getDialect(d).label
            });
            if (focusAction) {
                (list.querySelector(`[data-action="${focusAction}"][data-id="${cssEscape(focusId)}"]`)
                    || list.querySelector(`[data-id="${cssEscape(focusId)}"]`) || list.querySelector('button'))?.focus();
            }
        };
        const onClick = async (event) => {
            const btn = event.target.closest('button[data-action]');
            if (!btn || !list.contains(btn)) return;
            const project = projects.get(btn.dataset.id);
            if (!project) return;
            try {
                switch (btn.dataset.action) {
                    case 'project-open':
                        closeDialog(dialog, 'confirm');
                        openProject(project.id, `Opened project “${project.name}”.`);
                        break;
                    case 'project-rename': {
                        const name = await promptDialog(el.promptDialog, { title: 'Rename project', label: 'Project name', value: project.name, confirmText: 'Rename' });
                        if (name === null) return;
                        const renamed = projects.rename(project.id, name);
                        renderProjectBar();
                        render('project-rename', project.id);
                        toast(`Renamed to “${renamed.name}”.`);
                        break;
                    }
                    case 'project-delete': {
                        const c = projectCounts(projects.storageFor(project.id));
                        const ok = await confirmDialog(el.confirmDialog, {
                            title: 'Delete project?',
                            message: `“${project.name}” and its ${count(c.templates, 'template')}, ${count(c.history, 'history entry', 'history entries')} and ${count(c.tables, 'schema table')} will be deleted from this browser. Other projects don't change. This cannot be undone.`,
                            confirmText: 'Delete project'
                        });
                        if (!ok) return;
                        projects.remove(project.id);
                        renderTemplates();
                        render();
                        list.querySelector('button')?.focus();
                        toast(`Deleted project “${project.name}”.`);
                        break;
                    }
                    default:
                }
            } catch (e) {
                toast(e instanceof ProjectError ? e.message : 'Something went wrong.', 'error');
            }
        };
        const onSubmit = (event) => {
            // Create and open; enhanceDialog's handler would just close the dialog
            event.preventDefault();
            event.stopPropagation();
            try {
                const project = projects.create(input.value, { dialect: state.settings.dialect });
                closeDialog(dialog, 'confirm');
                openProject(project.id, `Created project “${project.name}”. Its templates, history and schema start empty.`);
                renderTemplates();
            } catch (e) {
                if (!(e instanceof ProjectError)) throw e;
                error.textContent = e.message;
                input.setAttribute('aria-invalid', 'true');
                input.focus();
            }
        };
        input.value = '';
        error.textContent = '';
        input.removeAttribute('aria-invalid');
        render();
        list.addEventListener('click', onClick);
        form.addEventListener('submit', onSubmit);
        try {
            await showDialog(dialog, () => list.querySelector('button')?.focus());
        } finally {
            list.removeEventListener('click', onClick);
            form.removeEventListener('submit', onSubmit);
        }
    }

    /** Moves a template, with its earlier versions, to another project. */
    async function moveTemplate(id) {
        const template = templates.get(id);
        const others = projects.list().filter(p => p.id !== projects.active);
        if (!template || !others.length) return;
        const dialog = el.moveDialog;
        const select = dialog.querySelector('#move-project');
        select.replaceChildren(...others.map(p => h('option', { value: p.id }, p.name)));
        dialog.querySelector('#move-message').textContent = `“${template.name}” moves with its earlier versions. Its history entries stay in this project.`;
        const ok = await formDialog(dialog, { onOpen: () => select.focus(), validate: () => true });
        if (!ok) return;
        const target = projects.get(select.value);
        if (!target) return;
        try {
            // Dates, pins and versions are kept; an identical template there counts as moved
            const result = storesFor(target.id).templates.restore([template]);
            templates.remove(id);
            if (state.sourceId === id) {
                state.sourceId = null;
                saveDraft();
                renderQueryName();
            }
            renderTemplates();
            el.templateSearch.focus();
            toast(`Moved “${template.name}” to ${target.name}.${result.skipped ? ' An identical template was already there.' : ''}`, 'success');
        } catch (e) {
            toast(e instanceof TemplateError ? e.message : 'The template could not be moved.', 'error');
        }
    }

    /** A template's earlier versions: compare each with the current query, restore or delete it. */
    async function openVersions(id) {
        const dialog = el.versionsDialog;
        const list = dialog.querySelector('#versions-list');
        const output = dialog.querySelector('#versions-compare');
        /** @type {number | null} */
        let selected = null;
        // Both sides written with the same settings, formatted, so a
        // difference is a change to the query
        const sqlOf = (workspace) => {
            try {
                return generateSQL(workspace, generationOptions(true));
            } catch {
                return '';
            }
        };
        const render = (focusAction = null, focusIndex = null) => {
            const template = templates.get(id);
            if (!template || !template.versions?.length) {
                closeDialog(dialog, 'cancel');
                return;
            }
            if (selected !== null && selected >= template.versions.length) selected = null;
            const current = sqlOf(template.workspace);
            const diffs = template.versions.map((/** @type {any} */ v) => diffLines(sqlOf(v.workspace), current));
            dialog.querySelector('#versions-title').textContent = `Versions of “${template.name}”`;
            renderVersionList(list, template, { dialectLabel: (d) => (d ? getDialect(d).label : 'Any dialect'), diffs, selected });
            renderVersionCompare(output, selected === null ? null : template.versions[selected], selected === null ? null : diffs[selected]);
            if (focusAction) {
                const index = Math.min(focusIndex ?? 0, template.versions.length - 1);
                (list.querySelector(`[data-action="${focusAction}"][data-index="${index}"]`) || list.querySelector('button'))?.focus();
            }
        };
        const onClick = async (event) => {
            const btn = event.target.closest('button[data-action]');
            if (!btn || !list.contains(btn)) return;
            const index = Number(btn.dataset.index);
            const template = templates.get(id);
            const version = template?.versions?.[index];
            if (!version) return;
            try {
                switch (btn.dataset.action) {
                    case 'version-compare':
                        selected = selected === index ? null : index;
                        render('version-compare', index);
                        break;
                    case 'version-restore': {
                        const restored = templates.restoreVersion(id, index);
                        closeDialog(dialog, 'confirm');
                        const switched = switchDialect(restored.dialect);
                        replaceWorkspace(structuredClone(restored.workspace),
                            `Restored the version of “${restored.name}” from ${formatTime(version.savedAt)}${switched}. The query it replaced is kept as a version.`, restored.id);
                        renderTemplates();
                        break;
                    }
                    case 'version-delete': {
                        const ok = await confirmDialog(el.confirmDialog, {
                            title: 'Delete this version?',
                            message: `The version of “${template.name}” saved ${formatTime(version.savedAt)} will be deleted. The current query doesn't change.`,
                            confirmText: 'Delete version'
                        });
                        if (!ok) return;
                        templates.deleteVersion(id, index);
                        if (selected === index) selected = null;
                        else if (selected !== null && selected > index) selected--;
                        renderTemplates();
                        render('version-delete', index);
                        toast('Version deleted.');
                        break;
                    }
                    default:
                }
            } catch (error) {
                toast(error instanceof TemplateError ? error.message : 'Something went wrong.', 'error');
            }
        };
        if (!templates.get(id)?.versions?.length) return;
        render();
        list.addEventListener('click', onClick);
        let result;
        try {
            result = await showDialog(dialog, () => list.querySelector('button')?.focus());
        } finally {
            list.removeEventListener('click', onClick);
            renderVersionCompare(output, null, null);
        }
        // The list was redrawn while the dialog was open: back to this template's buttons
        if (result !== 'confirm' && !el.templateList.contains(doc.activeElement)) {
            const item = (action) => el.templateList.querySelector(`[data-action="${action}"][data-id="${cssEscape(id)}"]`);
            (item('template-versions') || item('template-load'))?.focus();
        }
    }

    function switchDialect(dialect) {
        if (!dialect || dialect === state.settings.dialect || !listDialects().some(d => d.id === dialect)) return '';
        updateSettings({ dialect });
        return ` (dialect switched to ${getDialect(dialect).label})`;
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
                    const switched = switchDialect(entry.dialect);
                    replaceWorkspace(structuredClone(entry.workspace), `Query restored from history${switched}.`);
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
                    if (!template) return;
                    const switched = switchDialect(template.dialect);
                    replaceWorkspace(structuredClone(template.workspace), `Loaded “${template.name}”${switched}. Undo restores your previous query.`, template.id);
                    renderTemplates();
                    break;
                }
                case 'template-move':
                    await moveTemplate(id);
                    break;
                case 'template-versions':
                    await openVersions(id);
                    break;
                case 'template-rename': {
                    const template = templates.get(id);
                    if (!template) return;
                    const name = await promptDialog(el.promptDialog, { title: 'Rename template', label: 'Template name', value: template.name, confirmText: 'Rename' });
                    if (name === null) return;
                    const renamed = templates.rename(id, name);
                    renderTemplates();
                    renderQueryName();
                    toast(`Renamed to “${renamed.name}”.`, 'success');
                    break;
                }
                case 'template-pin':
                case 'template-unpin': {
                    const pinned = templates.setPinned(id, action === 'template-pin');
                    renderTemplates();
                    // Keep focus on the same template's pin button after the list is rebuilt
                    el.templateList.querySelector(`[data-id="${cssEscape(id)}"][data-action^="template-${pinned.pinned ? 'unpin' : 'pin'}"]`)?.focus();
                    toast(pinned.pinned ? `Pinned “${pinned.name}” to the top.` : `Unpinned “${pinned.name}”.`);
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
                    if (state.sourceId === id) state.sourceId = null;
                    renderTemplates();
                    renderQueryName();
                    el.templateSave.focus();
                    toast('Template deleted.');
                    break;
                }
                case 'schema-edit':
                    await editSchemaTable(id);
                    break;
                case 'schema-delete': {
                    const table = schema.get(id);
                    if (!table) return;
                    const ok = await confirmDialog(el.confirmDialog, { title: 'Delete table?', message: `${table.name} will be removed from your schema. Your queries and templates don't change.`, confirmText: 'Delete' });
                    if (!ok) return;
                    schema.remove(table.name);
                    renderSchema();
                    el.schemaAdd.focus();
                    toast(`Removed ${table.name} from the schema.`);
                    break;
                }
                case 'practice-start':
                    startExercise(id);
                    break;
                case 'practice-show':
                    showPractice();
                    break;
                case 'example-load': {
                    const example = EXAMPLES.find(e => e.id === id);
                    if (!example) return;
                    // Dialect-specific examples (upserts) switch to a dialect they work in
                    const switched = example.dialects && !example.dialects.includes(state.settings.dialect)
                        ? switchDialect(example.dialects[0]) : '';
                    replaceWorkspace(example.build(), `Loaded example “${example.name}”${switched}.`);
                    break;
                }
                default:
            }
        } catch (error) {
            toast(error instanceof TemplateError || error instanceof SchemaError ? error.message : 'Something went wrong.', 'error');
        }
    }

    // ------------------------------------------------------------------ schema

    function renderSchema() {
        const all = schema.list();
        if (suggester) suggester.close();
        // Schema tips and join hints follow the schema; they never change the SQL
        state.issues = currentIssues();
        renderIssues();
        markFields();
        renderJoinHints();
        const query = state.schemaSearch.trim();
        const needle = query.toLowerCase();
        const shown = needle
            ? all.filter(t => t.name.toLowerCase().includes(needle) || t.columns.some((/** @type {any} */ c) => c.name.toLowerCase().includes(needle)))
            : all;
        renderSchemaList(el.schemaList, shown, { total: all.length, query });
        const columns = all.reduce((n, t) => n + t.columns.length, 0);
        const links = all.reduce((n, t) => n + t.foreignKeys.length, 0);
        el.schemaSummary.textContent = all.length
            ? `${count(all.length, 'table')}, ${count(columns, 'column')}, ${count(links, 'link')} between tables.`
            : '';
        el.schemaExport.disabled = all.length === 0;
        el.schemaClear.disabled = all.length === 0;
    }

    // Why a table definition can't be saved, or '' when it can
    function tableDefinitionProblem(result) {
        if (result.problems.length) {
            const [first] = result.problems;
            return first.line ? `Line ${first.line}: ${first.message}` : first.message;
        }
        if (result.skipped.length) {
            return `Only a CREATE TABLE statement can go here; remove ${result.skipped.map((/** @type {any} */ s) => s.label).join(', ')}.`;
        }
        if (result.tables.length === 0) return 'Write a CREATE TABLE statement.';
        if (result.tables.length > 1) return 'Only one table can be edited here. To add several at once, use Import.';
        return '';
    }

    /** Adds a table, or edits the one called `name`. */
    async function editSchemaTable(name = null) {
        const existing = name ? schema.get(name) : null;
        if (name && !existing) return;
        const dialog = el.schemaTableDialog;
        const input = dialog.querySelector('#schema-table-sql');
        const error = dialog.querySelector('#schema-table-error');
        dialog.querySelector('.dialog-title').textContent = existing ? `Edit ${existing.name}` : 'Add table';
        input.value = existing ? tableToDdl(existing) : NEW_TABLE_DDL;
        error.textContent = '';
        /** @type {any} */
        let saved = null;
        const ok = await formDialog(dialog, {
            onOpen: () => {
                input.focus();
                if (!existing) input.setSelectionRange(13, 23); // "table_name"
            },
            validate: () => {
                const result = readDdl(input.value);
                const problem = tableDefinitionProblem(result);
                try {
                    if (problem) throw new SchemaError(problem);
                    saved = schema.save(result.tables[0], { previousName: existing ? existing.name : null });
                    return true;
                } catch (e) {
                    if (!(e instanceof SchemaError)) throw e;
                    error.textContent = e.message;
                    input.focus();
                    return false;
                }
            }
        });
        if (!ok || !saved) return;
        renderSchema();
        selectTab('schema');
        toast(existing ? `Saved ${saved.name}.` : `Added ${saved.name} to the schema.`, 'success');
    }

    async function importSchema() {
        const dialog = el.schemaImportDialog;
        const input = dialog.querySelector('#schema-import-text');
        const output = dialog.querySelector('#schema-import-result');
        dialog.querySelector('input[value="merge"]').checked = true;
        input.value = '';
        /** @type {any} */
        let result = null;
        const preview = () => {
            result = input.value.trim() ? readSchemaInput(input.value) : null;
            renderSchemaImportPreview(output, result, schema.list());
        };
        const onInput = debounce(preview, 250);
        preview();
        input.addEventListener('input', onInput);
        const fileButton = dialog.querySelector('#schema-import-file-btn');
        const onFile = () => chooseFile('schema');
        fileButton.addEventListener('click', onFile);
        fillSchemaImport = (text) => {
            input.value = text;
            preview();
            input.focus();
        };
        let ok;
        try {
            ok = await formDialog(dialog, {
                onOpen: () => input.focus(),
                validate: () => {
                    onInput.flush();
                    if (result && result.ok && result.tables.length) return true;
                    if (!result) renderSchemaImportPreview(output, { ok: false, error: 'Paste CREATE TABLE statements or choose a file first.' }, []);
                    input.focus();
                    return false;
                }
            });
        } finally {
            onInput.cancel();
            input.removeEventListener('input', onInput);
            fileButton.removeEventListener('click', onFile);
            fillSchemaImport = null;
        }
        if (!ok) return;
        const replace = dialog.querySelector('input[name="schema-import-mode"]:checked').value === 'replace';
        if (replace && schema.size) {
            const sure = await confirmDialog(el.confirmDialog, {
                title: 'Replace your schema?',
                message: `Your ${count(schema.size, 'table')} will be deleted and replaced by the ${count(result.tables.length, 'imported table')}. Your queries and templates don't change.`,
                confirmText: 'Replace'
            });
            if (!sure) return;
        }
        try {
            const done = schema.apply(result.tables, { replace });
            renderSchema();
            selectTab('schema');
            toast(`Schema imported: ${count(done.added, 'table')} added${done.replaced ? `, ${done.replaced} replaced` : ''}.`, 'success');
        } catch (error) {
            toast(error instanceof SchemaError ? `Import failed: ${error.message}` : 'The schema could not be imported.', 'error');
        }
    }

    async function exportSchema(format = 'json') {
        const tables = schema.list();
        if (!tables.length) {
            toast('The schema is empty; add or import tables first.', 'error');
            return;
        }
        if (format === 'sql') {
            await downloadFile('schema.sql', `${schemaToDdl(tables)}\n`, 'application/sql', `Exported ${count(tables.length, 'table')} as CREATE TABLE statements.`);
        } else {
            await downloadFile('sql-builder-schema.json', JSON.stringify(createSchemaExport(tables), null, 2), 'application/json', `Exported ${count(tables.length, 'table')}.`);
        }
    }

    async function clearSchema() {
        if (!schema.size) return;
        const ok = await confirmDialog(el.confirmDialog, {
            title: 'Clear the schema?',
            message: `All ${count(schema.size, 'table')} will be removed from this browser. Your queries and templates don't change. This cannot be undone.`,
            confirmText: 'Clear schema'
        });
        if (!ok) return;
        schema.clear();
        renderSchema();
        el.schemaAdd.focus();
        toast('Schema cleared.');
    }

    async function saveTemplate() {
        commitSoon.flush();
        const suggestion = state.workspace.type === 'select' && state.workspace.select.from.kind === 'table' && state.workspace.select.from.table
            ? `${state.workspace.select.from.table} query`
            : `${state.workspace.type.toUpperCase()} query`;
        const details = await templateDialog(el.templateDialog, {
            name: suggestion,
            categories: templates.categories(),
            note: `Saved for ${getDialect(state.settings.dialect).label}; loading it switches back to that dialect.`
        });
        if (details === null) return;
        try {
            const template = templates.create(details.name, state.workspace, { ...details, dialect: state.settings.dialect });
            state.sourceId = template.id;
            renderTemplates();
            renderQueryName();
            saveDraft();
            selectTab('templates');
            toast(`Saved template “${template.name}”.`, 'success');
        } catch (error) {
            toast(error instanceof TemplateError ? error.message : 'The template could not be saved.', 'error');
        }
    }

    /** Save (Ctrl/⌘+S): updates the template being edited, or saves a new one. */
    async function saveQuery() {
        commitSoon.flush();
        const current = state.sourceId ? templates.get(state.sourceId) : null;
        if (!current) {
            await saveTemplate();
            return;
        }
        try {
            const changed = JSON.stringify(current.workspace) !== JSON.stringify(state.workspace);
            const saved = templates.update(current.id, state.workspace, { dialect: state.settings.dialect });
            renderTemplates();
            renderQueryName();
            toast(changed && !saved.keptVersion
                ? `Saved “${saved.name}”. There wasn't room in browser storage to keep the previous version.`
                : `Saved “${saved.name}”.`, 'success');
        } catch (error) {
            toast(error instanceof TemplateError ? error.message : 'The query could not be saved.', 'error');
        }
    }

    /** "Unsaved query", or the template being edited and whether it has changed. */
    function renderQueryName() {
        const current = state.sourceId ? templates.get(state.sourceId) : null;
        if (!current) {
            el.queryName.replaceChildren(h('span', { class: 'query-name-text muted' }, 'Unsaved query'));
            el.save.textContent = 'Save…';
            return;
        }
        const changed = JSON.stringify(current.workspace) !== JSON.stringify(state.workspace)
            || (current.dialect || state.settings.dialect) !== state.settings.dialect;
        el.queryName.replaceChildren(
            h('span', { class: 'query-name-text' }, current.name),
            h('span', { class: `query-name-state${changed ? ' changed' : ''}` }, changed ? 'unsaved changes' : 'saved'));
        el.save.textContent = 'Save';
    }

    async function exportTemplates() {
        const list = templates.list();
        if (list.length === 0) return;
        await downloadFile('sql-templates.json', JSON.stringify(createTemplatesExport(list), null, 2), 'application/json',
            `Exported ${list.length} ${list.length === 1 ? 'template' : 'templates'}.`);
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
        if (patch.restoreSession === false) projectData.remove(DRAFT_KEY);
        if (patch.outputMode !== undefined || patch.wrapOutput !== undefined) renderModeButtons();
        if (patch.dialect !== undefined && patch.dialect !== before.dialect) {
            try {
                projects.setDialect(projects.active, state.settings.dialect);
            } catch {
                // the project just doesn't remember it
            }
            renderDialectNotes();
            el.dialectSelect.value = state.settings.dialect;
            state.exampleFilter = null;
            renderBuilder();
            renderExamples();
        }
        const formatChanged = FORMAT_SETTINGS.some(key => patch[key] !== undefined && patch[key] !== before[key]);
        if (formatChanged) renderFormatPreview();
        if (patch.keywordCase !== undefined && patch.keywordCase !== before.keywordCase && patch.dialect === undefined) renderExamples();
        if (state.generated && (patch.dialect !== undefined || patch.quoteIdentifiers !== undefined || patch.outputMode !== undefined || formatChanged)) {
            // Keep a manually generated query in sync with output preferences
            if (!hasErrors(validateWorkspace(state.workspace, validationOptions()))) {
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
        platform.setAppearance(effectiveTheme(theme));
    }

    // Android back button: close the top-most overlay. Returns false when there
    // is nothing to close, so the platform can apply its default behaviour.
    function handleBack() {
        if (suggester && suggester.open) {
            suggester.close();
            return true;
        }
        const dialogs = [el.confirmDialog, el.versionsDialog, el.projectsDialog, el.moveDialog, el.backupDialog, el.promptDialog, el.templateDialog, el.schemaTableDialog, el.schemaImportDialog, el.sqlImportDialog, el.compareDialog, el.paletteDialog, el.shortcutsDialog, el.settingsDialog];
        const open = dialogs.find(dialog => dialog.open || dialog.hasAttribute('open'));
        if (open) {
            closeDialog(open, 'cancel');
            return true;
        }
        if (el.fileMenu.open) {
            el.fileMenu.open = false;
            return true;
        }
        return false;
    }

    function renderModeButtons() {
        el.modeButtons.forEach(btn => btn.setAttribute('aria-pressed', String(btn.dataset.outputMode === state.settings.outputMode)));
        // Wrapping is display only: copy, download and history use the SQL text
        el.wrap.setAttribute('aria-pressed', String(state.settings.wrapOutput));
        el.output.classList.toggle('wrap', state.settings.wrapOutput);
    }

    function renderDialectNotes() {
        const notes = getDialect(state.settings.dialect).notes;
        doc.getElementById('dialect-notes').textContent = notes.join(' ');
    }

    function syncSettingsForm() {
        for (const input of el.settingsDialog.querySelectorAll('[data-setting]')) {
            const key = input.dataset.setting;
            if (input.type === 'checkbox') input.checked = state.settings[key];
            else if (input.type === 'radio') input.checked = input.value === state.settings[key];
            else input.value = state.settings[key];
        }
        renderDialectNotes();
        renderFormatPreview();
    }

    // A short sample query in the chosen dialect, written with the format settings
    function renderFormatPreview() {
        const preview = doc.getElementById('format-preview');
        if (!preview) return;
        let sql = '';
        try {
            sql = generateSQL(formatSample(), { ...formatOptions(state.settings), dialect: state.settings.dialect, pretty: true });
        } catch {
            // the sample is valid in every dialect; nothing to show otherwise
        }
        preview.textContent = sql;
    }

    function openSettings(focusId) {
        const dialog = el.settingsDialog;
        const dialectSelect = dialog.querySelector('[data-setting="dialect"]');
        if (dialectSelect.options.length === 0) {
            dialectSelect.append(...listDialects().map(d => h('option', { value: d.id }, d.label)));
        }
        syncSettingsForm();
        showDialog(dialog, () => (focusId ? doc.getElementById(focusId) : dialectSelect).focus());
    }

    function onSettingChange(event) {
        const input = event.target;
        const key = input.dataset.setting;
        if (!key) return;
        if (input.type === 'radio' && !input.checked) return;
        updateSettings({ [key]: input.type === 'checkbox' ? input.checked : input.value });
        if (key === 'dialect') announceDialect();
    }

    async function clearAllData() {
        const ok = await confirmDialog(el.confirmDialog, {
            title: 'Delete all saved data?',
            message: 'This removes your projects, history, templates, schema, practice progress and settings from this browser and clears the builder. It cannot be undone.',
            confirmText: 'Delete everything'
        });
        if (!ok) return;
        // Settings first: a dialect change is remembered by the open project,
        // and clearing the projects afterwards forgets that too
        updateSettings({ ...DEFAULT_SETTINGS });
        storage.remove('settings');
        // Every project but Main goes, with its data; then Main is emptied
        projects.clear();
        projectData = projects.storageFor(MAIN_PROJECT);
        history = createHistory(projectData);
        templates = createTemplateStore(projectData);
        schema = createSchemaStore(projectData);
        history.clear();
        for (const t of templates.list()) templates.remove(t.id);
        try {
            schema.clear();
        } catch {
            // removing never fails; storage.remove ignores errors
        }
        practice.clear();
        state.practiceView = newPracticeView();
        replaceWorkspace(createWorkspace());
        undoStack.reset(state.workspace);
        commitSoon.cancel();
        saveDraft.cancel();
        projectData.remove(DRAFT_KEY);
        projectData.remove(SOURCE_KEY);
        syncSettingsForm();
        renderHistory();
        renderTemplates();
        renderSchema();
        renderPracticeList();
        renderPractice();
        renderProjectBar();
        toast('All saved data was deleted from this browser.', 'success');
    }

    // ------------------------------------------------------- command palette

    function openLibraryTab(name) {
        selectTab(name, true);
        doc.getElementById(`tab-${name}`).scrollIntoView({ block: 'nearest' });
    }

    /** The commands that make sense right now, reusing the buttons' own handlers. */
    function paletteCommands() {
        const { type } = state.workspace;
        const { settings } = state;
        return [
            { id: 'generate', group: 'SQL', label: 'Generate SQL', keys: ['Mod', 'Enter'], keywords: 'run build', run: generate },
            { id: 'copy', group: 'SQL', label: 'Copy SQL', keys: ['Mod', 'Shift', 'C'], keywords: 'clipboard', run: copySql },
            { id: 'download', group: 'SQL', label: 'Download SQL (.sql)', keywords: 'file save', run: downloadSql },
            { id: 'save', group: 'Query', label: state.sourceId ? 'Save query' : 'Save query as a template…', keys: ['Mod', 'S'], keywords: 'template', run: saveQuery },
            state.sourceId && { id: 'save-new', group: 'Templates', label: 'Save as a new template…', keywords: 'copy', run: saveTemplate },
            undoStack.canUndo && { id: 'undo', group: 'Edit', label: 'Undo', keys: ['Mod', 'Z'], run: undo },
            undoStack.canRedo && { id: 'redo', group: 'Edit', label: 'Redo', keys: ['Mod', 'Shift', 'Z'], run: redo },
            ...['select', 'insert', 'update', 'delete'].filter(t => t !== type).map(t => ({
                id: `type-${t}`, group: 'Query', label: `Switch to ${t.toUpperCase()}`, keywords: 'query type statement', run: () => {
                    setType(t);
                    syncTypeTabs();
                }
            })),
            ...listDialects().filter(d => d.id !== settings.dialect).map(d => ({
                id: `dialect-${d.id}`, group: 'Dialect', label: `Use ${d.label}`, keywords: 'dialect database', run: () => {
                    updateSettings({ dialect: d.id });
                    announceDialect();
                }
            })),
            {
                id: 'output-mode', group: 'Output', keywords: 'format compact one line',
                label: settings.outputMode === 'formatted' ? 'Show SQL on one line' : 'Show formatted SQL',
                run: () => updateSettings({ outputMode: settings.outputMode === 'formatted' ? 'compact' : 'formatted' })
            },
            {
                id: 'wrap', group: 'Output', label: settings.wrapOutput ? 'Stop wrapping long lines' : 'Wrap long lines',
                run: () => updateSettings({ wrapOutput: !settings.wrapOutput })
            },
            {
                id: 'keyword-case', group: 'Output', keywords: 'format uppercase lowercase keywords style',
                label: settings.keywordCase === 'upper' ? 'Write keywords in lowercase' : 'Write keywords in UPPERCASE',
                run: () => updateSettings({ keywordCase: settings.keywordCase === 'upper' ? 'lower' : 'upper' })
            },
            {
                id: 'format-settings', group: 'Output', label: 'SQL format settings…', keywords: 'indent commas leading trailing expand layout style',
                run: () => openSettings('setting-keyword-case')
            },
            {
                id: 'theme', group: 'View', label: `Switch theme to ${THEME_LABELS[nextTheme(settings.theme)]}`, keywords: 'dark light appearance',
                run: () => updateSettings({ theme: nextTheme(settings.theme) })
            },
            { id: 'open-history', group: 'Library', label: 'Open history', run: () => openLibraryTab('history') },
            { id: 'open-templates', group: 'Library', label: 'Open templates', run: () => openLibraryTab('templates') },
            { id: 'open-examples', group: 'Library', label: 'Open examples', run: () => openLibraryTab('examples') },
            { id: 'projects', group: 'Projects', label: 'Projects…', keywords: 'workspace switch new create rename delete database folder', run: openProjects },
            ...projects.list().filter(p => p.id !== projects.active).map(p => ({
                id: `project-${p.id}`, group: 'Projects', label: `Open project: ${p.name}`, keywords: 'workspace switch',
                run: () => openProject(p.id, `Opened project “${p.name}”.`)
            })),
            { id: 'open-practice', group: 'Library', label: 'Open practice exercises', keywords: 'learn exercises lessons training quiz', run: () => openLibraryTab('practice') },
            { id: 'open-schema', group: 'Schema', label: 'Open schema', keywords: 'tables columns', run: () => openLibraryTab('schema') },
            { id: 'schema-add', group: 'Schema', label: 'Add a table to the schema…', keywords: 'create table columns', run: () => editSchemaTable() },
            { id: 'schema-import', group: 'Schema', label: 'Import schema…', keywords: 'create table ddl sql json tables', run: importSchema },
            schema.size > 0 && { id: 'schema-export', group: 'Schema', label: 'Export schema (.json)', keywords: 'tables', run: () => exportSchema('json') },
            schema.size > 0 && { id: 'schema-export-sql', group: 'Schema', label: 'Export schema as CREATE TABLE (.sql)', keywords: 'ddl tables', run: () => exportSchema('sql') },
            { id: 'export-query', group: 'File', label: 'Export query (.json)', run: exportQuery },
            { id: 'import-query', group: 'File', label: 'Import query (.json)…', run: () => chooseFile('query') },
            { id: 'compare-dialects', group: 'Output', label: 'Compare dialects…', keywords: 'convert sql server postgresql mysql generic differences', run: compareWithDialect },
            { id: 'import-sql', group: 'File', label: 'Import SQL (.sql)…', keywords: 'open paste select insert update delete file', run: importSql },
            { id: 'export-backup', group: 'File', label: 'Back up everything (.json)', keywords: 'backup export templates history settings', run: exportBackup },
            { id: 'import-backup', group: 'File', label: 'Restore from backup…', keywords: 'backup import templates history settings', run: () => chooseFile('backup') },
            templates.list().length > 0 && { id: 'export-templates', group: 'Templates', label: 'Export all templates', run: exportTemplates },
            { id: 'import-templates', group: 'Templates', label: 'Import templates…', run: () => chooseFile('templates') },
            { id: 'shortcuts', group: 'Help', label: 'Show keyboard shortcuts', keys: ['?'], run: () => showDialog(el.shortcutsDialog) },
            { id: 'settings', group: 'Settings', label: 'Open settings', keywords: 'preferences options', run: () => openSettings() },
            { id: 'clear', group: 'Query', label: `Clear the ${type.toUpperCase()} query`, run: clearCurrent },
            { id: 'reset', group: 'Query', label: 'Reset all', keywords: 'new start over', run: resetAll }
        ].filter(Boolean);
    }

    async function showPalette() {
        // One dialog at a time: the palette doesn't open over another one
        if (doc.querySelector('dialog[open]')) return;
        // Opened from the File menu: focus returns to the menu's button
        if (el.fileMenu.contains(doc.activeElement)) el.fileMenu.querySelector('summary').focus();
        el.fileMenu.open = false;
        commitSoon.flush();
        const command = await openPalette(el.paletteDialog, paletteCommands(), (key) => (key === 'Mod' ? modLabel() : key));
        if (command) command.run();
    }

    function renderShortcuts() {
        const rows = doc.getElementById('shortcut-rows');
        rows.replaceChildren(...SHORTCUTS.map(s => h('tr', {},
            h('td', {}, s.keys.map((k, i) => [i > 0 ? ' + ' : '', h('kbd', {}, k === 'Mod' ? modLabel() : k)])),
            h('td', {}, s.description))));
    }

    // ------------------------------------------------------------------ wiring

    el.builder.addEventListener('input', onBuilderInput);
    // Suggestions from the schema; without a schema the fields work as before
    suggester = createSuggester({
        root: el.builder,
        doc,
        signal,
        enabled: (input) => schema.size > 0 && fieldContext(state.workspace, input.dataset.path, { tables: schema.list() }) !== null,
        compute: (input) => {
            const tables = schema.list();
            const context = fieldContext(state.workspace, input.dataset.path, { tables });
            if (!context) return null;
            return suggest(context, input.value, input.selectionStart ?? input.value.length, { tables, dialect: getDialect(state.settings.dialect) });
        }
    });
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
    el.save.addEventListener('click', saveQuery);
    el.share.hidden = !platform.canShare;
    el.share.addEventListener('click', shareSql);
    el.download.addEventListener('click', downloadSql);
    el.compare.addEventListener('click', compareWithDialect);
    el.selectAll.addEventListener('click', () => {
        if (el.output.hidden) return;
        el.output.focus();
        selectContents(el.code);
    });
    el.modeButtons.forEach(btn => btn.addEventListener('click', () => updateSettings({ outputMode: btn.dataset.outputMode })));
    el.explainButtons.forEach(btn => btn.addEventListener('click', () => updateSettings({ explainLevel: btn.dataset.explainLevel })));
    el.wrap.addEventListener('click', () => updateSettings({ wrapOutput: !state.settings.wrapOutput }));

    el.issuesList.addEventListener('click', (event) => {
        const btn = event.target.closest('button[data-goto]');
        if (btn) goToField(btn.dataset.goto);
    });
    el.outputState.addEventListener('click', onLibraryClick);
    el.structureSteps.addEventListener('click', (event) => {
        const btn = event.target.closest('button[data-action="structure-jump"]');
        if (btn) jumpTo({ section: btn.dataset.section, path: btn.dataset.path });
    });
    el.diagramLinks.addEventListener('click', (event) => {
        const btn = event.target.closest('button[data-action="structure-jump"]');
        if (btn) goToField(btn.dataset.path);
    });
    el.diagram.addEventListener('toggle', () => renderDiagramPanel());
    el.flowLinks.addEventListener('click', (event) => {
        const btn = event.target.closest('button[data-action="structure-jump"]');
        if (btn) jumpTo({ section: btn.dataset.section, path: btn.dataset.path });
    });
    el.flow.addEventListener('toggle', () => renderFlowPanel());

    doc.addEventListener('click', (event) => {
        const cmd = /** @type {any} */ (event.target).closest('[data-command]');
        if (!cmd) return;
        el.fileMenu.open = false;
        const commands = {
            'export-query': exportQuery,
            'import-query': () => chooseFile('query'),
            'import-sql': importSql,
            'download-sql': downloadSql,
            'export-backup': exportBackup,
            'import-backup': () => chooseFile('backup'),
            palette: showPalette,
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
    el.settingsBtn.addEventListener('click', () => openSettings());
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
    el.practice.addEventListener('click', onPracticeClick);
    el.projectsBtn.addEventListener('click', openProjects);
    el.practiceLevel.addEventListener('change', () => {
        state.practiceLevel = el.practiceLevel.value;
        renderPracticeList();
    });
    el.practiceReset.addEventListener('click', async () => {
        const ok = await confirmDialog(el.confirmDialog, { title: 'Clear practice progress?', message: `The ${practice.doneCount} exercises marked done will be marked not done. Your queries don't change.`, confirmText: 'Clear progress' });
        if (!ok) return;
        const open = practice.active;
        practice.clear();
        practice.setActive(open);
        renderPracticeList();
        el.practiceLevel.focus();
        toast('Practice progress cleared.');
    });
    el.dialectSelect.addEventListener('change', () => {
        updateSettings({ dialect: el.dialectSelect.value });
        announceDialect();
    });
    el.templateSearch.addEventListener('input', () => {
        state.templateSearch = el.templateSearch.value;
        renderTemplates();
    });
    el.templateSort.addEventListener('change', () => {
        state.templateSort = el.templateSort.value === 'recent' ? 'recent' : 'name';
        renderTemplates();
    });
    el.templateFilter.addEventListener('change', () => {
        state.templateFilter = el.templateFilter.value;
        renderTemplates();
    });
    el.exampleFilter.addEventListener('change', () => {
        state.exampleFilter = el.exampleFilter.value;
        renderExamples();
    });
    el.exampleTopic.addEventListener('change', () => {
        state.exampleTopic = EXAMPLE_TOPICS.includes(el.exampleTopic.value) ? el.exampleTopic.value : 'all';
        renderExamples();
    });
    el.templateSave.addEventListener('click', saveTemplate);
    el.templateImport.addEventListener('click', () => chooseFile('templates'));
    el.templateExport.addEventListener('click', exportTemplates);
    el.fileInput.addEventListener('change', onFileChosen);
    el.schemaAdd.addEventListener('click', () => editSchemaTable());
    el.schemaImport.addEventListener('click', importSchema);
    el.schemaExport.addEventListener('click', () => exportSchema('json'));
    el.schemaClear.addEventListener('click', clearSchema);
    el.schemaSearch.addEventListener('input', debounce(() => {
        state.schemaSearch = el.schemaSearch.value;
        renderSchema();
    }, 150));

    [el.settingsDialog, el.promptDialog, el.templateDialog, el.confirmDialog, el.shortcutsDialog, el.paletteDialog, el.backupDialog,
        el.schemaTableDialog, el.schemaImportDialog, el.sqlImportDialog, el.compareDialog, el.versionsDialog, el.projectsDialog, el.moveDialog].forEach(enhanceDialog);

    bindShortcuts(doc, signal, {
        generate,
        copy: copySql,
        // Not over another dialog: saving can open the template dialog
        save: () => { if (!doc.querySelector('dialog[open]')) saveQuery(); },
        palette: showPalette,
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
    const where = platform.isNative ? 'on this device' : 'in this browser';
    el.storageNote.textContent = storage.available
        ? `history, templates, schema and settings are stored only ${where}`
        : 'browser storage is unavailable, so history and templates won\'t be kept';
    el.dialectSelect.replaceChildren(...dialectOptions(false));
    el.dialectSelect.value = state.settings.dialect;
    el.templateFilter.replaceChildren(...dialectOptions(true));
    el.exampleFilter.replaceChildren(...dialectOptions(true));
    el.exampleTopic.replaceChildren(h('option', { value: 'all' }, 'All topics'), ...EXAMPLE_TOPICS.map(t => h('option', { value: t }, t)));
    el.practiceLevel.replaceChildren(h('option', { value: 'all' }, 'All levels'), ...Object.entries(EXAMPLE_LEVELS).map(([value, label]) => h('option', { value }, label)));
    syncTypeTabs();
    renderBuilder();
    renderHistory();
    renderTemplates();
    renderExamples();
    renderSchema();
    renderPracticeList();
    renderProjectBar();
    selectTab('history');
    refresh();
    platform.onBack(handleBack);

    return {
        destroy: () => lifetime.abort(),
        get state() { return state; },
        get history() { return history; },
        get templates() { return templates; },
        get schema() { return schema; },
        projects,
        generate,
        undo,
        redo,
        handleBack
    };
}
