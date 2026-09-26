// @vitest-environment jsdom
// End-to-end UI tests: index.html + the real app controller in jsdom.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { startApp } from '../src/app.js';
import { createStorage, createMemoryBackend, STORAGE_PREFIX } from '../src/storage.js';

const html = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8');
const bodyHtml = html.replace(/^[\s\S]*?<html[^>]*>/i, '').replace(/<\/html>\s*$/i, '');

let app;
let backend;

function boot(storageBackend = createMemoryBackend()) {
    if (app) app.destroy();
    document.documentElement.innerHTML = bodyHtml;
    document.documentElement.removeAttribute('data-theme');
    backend = storageBackend;
    app = startApp({ doc: document, storage: createStorage(backend) });
    return app;
}

const $ = (selector) => /** @type {any} */ (document.querySelector(selector));
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const field = (path) => $(`[data-path="${path}"]:is(input, select)`);

function type(path, value) {
    const input = field(path);
    if (!input) throw new Error(`No field for ${path}`);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

function choose(path, value) {
    const input = field(path);
    if (!input) throw new Error(`No field for ${path}`);
    if (input.type === 'checkbox') input.checked = value;
    else input.value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
}

function add(listPath, arg) {
    const btn = $(`[data-action="add-item"][data-path="${listPath}"][data-arg="${arg}"]`);
    if (!btn) throw new Error(`No add button for ${listPath} (${arg})`);
    btn.click();
}

function press(key, options = {}, target = document) {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options }));
}

const settle = () => vi.advanceTimersByTimeAsync(1000);
const sql = () => $$('#sql-code .line').map(line => line.textContent.replace(/\n$/, '')).join('\n');
const issues = () => $$('#issues-list .issue-message').map(n => n.textContent);
const toast = () => $('#toast').textContent;

async function fillSimpleSelect(table = 'users', column = 'name') {
    type('select.from.table', table);
    type('select.columns.0.expr', column);
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

async function chooseFile(content, name = 'file.json') {
    const input = $('#file-input');
    Object.defineProperty(input, 'files', { value: [new File([content], name, { type: 'application/json' })], configurable: true });
    input.dispatchEvent(new Event('change'));
    await settle();
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    boot();
});

afterEach(() => {
    app.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('start-up', () => {
    test('shows the empty state with example shortcuts and no checks', () => {
        expect($('#output-state').textContent).toContain('Your SQL will appear here');
        expect($('#sql-output').hidden).toBe(true);
        expect($('.issues').hidden).toBe(true);
        expect($$('#output-state [data-action="example-load"]')).toHaveLength(3);
    });

    test('an example from the empty state loads and renders SQL', async () => {
        $('#output-state [data-action="example-load"]').click();
        await settle();
        expect(sql()).toBe('SELECT\n    Name,\n    Salary\nFROM Employees\nWHERE Salary > 50000\nORDER BY Salary DESC\nLIMIT 10;');
        expect(toast()).toContain('Loaded example');
    });

    test('works when browser storage is blocked', () => {
        const fail = () => { throw new Error('blocked'); };
        boot({ getItem: fail, setItem: fail, removeItem: fail });
        expect($('#storage-note').textContent).toContain('unavailable');
        expect(field('select.from.table')).toBeTruthy();
    });
});

describe('SELECT builder', () => {
    test('live preview while typing', async () => {
        await fillSimpleSelect();
        expect(sql()).toBe('SELECT name\nFROM users;');
        type('select.columns.0.alias', 'full_name');
        await settle();
        expect(sql()).toBe('SELECT name AS full_name\nFROM users;');
    });

    test('columns: add, aggregate, DISTINCT, reorder, remove, CASE', async () => {
        await fillSimpleSelect('staff', 'dept');
        add('select.columns', 'column');
        type('select.columns.1.expr', 'salary');
        choose('select.columns.1.aggregate', 'AVG');
        choose('select.distinct', true);
        await settle();
        expect(sql()).toBe('SELECT DISTINCT\n    dept,\n    AVG(salary)\nFROM staff;');

        $('[data-action="move-up"][data-path="select.columns.1"]').click();
        await settle();
        expect(sql()).toContain('AVG(salary),\n    dept');

        $('[data-action="remove-item"][data-path="select.columns.0"]').click();
        choose('select.distinct', false);
        add('select.columns', 'case');
        type('select.columns.1.cases.0.when', 'dept = 1');
        type('select.columns.1.cases.0.then', "'One'");
        type('select.columns.1.alias', 'label');
        await settle();
        expect(sql()).toBe("SELECT\n    dept,\n    CASE\n        WHEN dept = 1 THEN 'One'\n    END AS label\nFROM staff;");
    });

    test('WHERE with BETWEEN, IN, IS NULL and a nested OR group', async () => {
        await fillSimpleSelect();
        add('select.where.items', 'condition');
        type('select.where.items.0.left', 'age');
        choose('select.where.items.0.op', 'BETWEEN');
        type('select.where.items.0.value', '18');
        type('select.where.items.0.value2', '65');
        add('select.where.items', 'group');
        type('select.where.items.1.items.0.left', 'city');
        choose('select.where.items.1.items.0.op', 'IN');
        type('select.where.items.1.items.0.value', "Paris, O'Hare");
        add('select.where.items.1.items', 'condition');
        type('select.where.items.1.items.1.left', 'city');
        choose('select.where.items.1.items.1.op', 'IS NULL');
        await settle();
        expect(sql()).toBe(
            "SELECT name\nFROM users\nWHERE age BETWEEN 18 AND 65\n    AND (city IN ('Paris', 'O''Hare') OR city IS NULL);"
        );
    });

    test('changing group logic updates the AND/OR labels between rows', async () => {
        await fillSimpleSelect();
        add('select.where.items', 'condition');
        add('select.where.items', 'condition');
        expect($$('#builder .logic-label').map(l => l.textContent)).toEqual(['AND']);
        choose('select.where.logic', 'OR');
        expect($$('#builder .logic-label').map(l => l.textContent)).toEqual(['OR']);
    });

    test('JOIN with ON conditions defaulting to column comparison', async () => {
        await fillSimpleSelect('users');
        type('select.from.alias', 'u');
        add('select.joins', 'join');
        choose('select.joins.0.type', 'LEFT JOIN');
        type('select.joins.0.source.table', 'orders');
        type('select.joins.0.source.alias', 'o');
        type('select.joins.0.on.items.0.left', 'o.user_id');
        type('select.joins.0.on.items.0.value', 'u.id');
        await settle();
        expect(sql()).toBe('SELECT name\nFROM users AS u\nLEFT JOIN orders AS o\n    ON o.user_id = u.id;');
    });

    test('GROUP BY, HAVING, ORDER BY, LIMIT, OFFSET', async () => {
        await fillSimpleSelect('staff', 'dept');
        add('select.columns', 'column');
        choose('select.columns.1.aggregate', 'COUNT');
        add('select.groupBy', 'groupBy');
        type('select.groupBy.0.expr', 'dept');
        add('select.having.items', 'condition');
        type('select.having.items.0.left', 'COUNT(*)');
        choose('select.having.items.0.op', '>');
        type('select.having.items.0.value', '3');
        add('select.orderBy', 'orderBy');
        type('select.orderBy.0.expr', 'dept');
        choose('select.orderBy.0.direction', 'DESC');
        type('select.limit', '5');
        type('select.offset', '10');
        await settle();
        expect(sql()).toBe('SELECT\n    dept,\n    COUNT(*)\nFROM staff\nGROUP BY dept\nHAVING COUNT(*) > 3\nORDER BY dept DESC\nLIMIT 5\nOFFSET 10;');
    });

    test('IN subquery and EXISTS build nested editors', async () => {
        await fillSimpleSelect();
        add('select.where.items', 'condition');
        type('select.where.items.0.left', 'id');
        choose('select.where.items.0.op', 'IN');
        choose('select.where.items.0.valueType', 'subquery');
        type('select.where.items.0.subquery.from.table', 'orders');
        type('select.where.items.0.subquery.columns.0.expr', 'user_id');
        add('select.where.items', 'condition');
        choose('select.where.items.1.op', 'NOT EXISTS');
        type('select.where.items.1.subquery.from.table', 'bans');
        await settle();
        expect(sql()).toBe(
            'SELECT name\nFROM users\nWHERE id IN (\n    SELECT user_id\n    FROM orders\n)\n    AND NOT EXISTS (\n        SELECT 1\n        FROM bans\n    );'
        );
    });

    test('derived table in FROM and a CTE', async () => {
        type('select.columns.0.expr', 't.id');
        choose('select.from.kind', 'subquery');
        type('select.from.alias', 't');
        type('select.from.query.from.table', 'recent');
        type('select.from.query.columns.0.expr', 'id');
        add('select.ctes', 'cte');
        type('select.ctes.0.name', 'recent');
        type('select.ctes.0.query.from.table', 'orders');
        type('select.ctes.0.query.columns.0.expr', 'id');
        await settle();
        expect(sql()).toBe(
            'WITH recent AS (\n    SELECT id\n    FROM orders\n)\nSELECT t.id\nFROM (\n    SELECT id\n    FROM recent\n) AS t;'
        );
    });

    test('UNION with a column mismatch shows an error instead of SQL', async () => {
        await fillSimpleSelect('a', 'x');
        add('select.setOps', 'setOp');
        type('select.setOps.0.query.from.table', 'b');
        type('select.setOps.0.query.columns.0.expr', 'x');
        await settle();
        expect(sql()).toBe('SELECT x\nFROM a\nUNION\nSELECT x\nFROM b;');

        add('select.setOps.0.query.columns', 'column');
        type('select.setOps.0.query.columns.1.expr', 'y');
        await settle();
        expect($('#sql-output').hidden).toBe(true);
        expect(issues().join()).toContain('Queries combined with UNION must select the same number of columns');
    });

    test('custom SQL condition', async () => {
        await fillSimpleSelect();
        add('select.where.items', 'raw');
        type('select.where.items.0.sql', "email LIKE '%@example.com'");
        await settle();
        expect(sql()).toBe("SELECT name\nFROM users\nWHERE email LIKE '%@example.com';");
    });
});

describe('INSERT / UPDATE / DELETE', () => {
    function selectType(type) {
        const radio = $(`input[name="query-type"][value="${type}"]`);
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
    }

    test('INSERT with several rows and a count mismatch', async () => {
        selectType('insert');
        type('insert.table', 'staff');
        type('insert.columns', 'name, salary');
        type('insert.rows.0.values', "'Ada', 100");
        add('insert.rows', 'row');
        type('insert.rows.1.values', "'Bob'");
        await settle();
        expect(issues()).toContain('Row 2 has 1 value but 2 columns are listed.');
        type('insert.rows.1.values', "'Bob', 90");
        await settle();
        expect(sql()).toBe("INSERT INTO staff (name, salary)\nVALUES\n    ('Ada', 100),\n    ('Bob', 90);");
    });

    test('UPDATE without WHERE warns but still produces SQL', async () => {
        selectType('update');
        type('update.table', 'accounts');
        type('update.set.0.column', 'balance');
        type('update.set.0.value', '0');
        await settle();
        expect(sql()).toBe('UPDATE accounts\nSET balance = 0;');
        expect($('.callout-warning').textContent).toContain('this UPDATE will change every row');
        expect(issues()).toContain('Warning: This UPDATE query has no WHERE clause and will modify every row in “accounts”.');
    });

    test('DELETE without WHERE warns; adding WHERE clears it', async () => {
        selectType('delete');
        type('delete.table', 'logs');
        await settle();
        expect(issues()).toEqual(['Warning: This DELETE query has no WHERE clause and may affect all rows.']);
        expect($('.issue-safety')).toBeTruthy();
        add('delete.where.items', 'condition');
        type('delete.where.items.0.left', 'id');
        type('delete.where.items.0.value', '7');
        await settle();
        expect(issues()).toEqual([]);
        expect(sql()).toBe('DELETE FROM logs\nWHERE id = 7;');
    });

    test('switching type keeps each query', async () => {
        await fillSimpleSelect();
        selectType('delete');
        type('delete.table', 'logs');
        selectType('select');
        await settle();
        expect(field('select.from.table').value).toBe('users');
    });
});

describe('validation feedback', () => {
    test('Generate with errors marks fields, focuses the first and explains', async () => {
        type('select.columns.0.expr', 'name');
        await settle();
        expect(field('select.from.table').getAttribute('aria-invalid')).toBeNull();

        $('#generate-btn').click();
        await settle();
        const table = field('select.from.table');
        expect(table.getAttribute('aria-invalid')).toBe('true');
        expect(document.activeElement).toBe(table);
        const describedBy = table.getAttribute('aria-describedby');
        expect(document.getElementById(describedBy).textContent).toContain('Enter the table to select from.');
        expect(toast()).toBe('Fix 1 issue before generating.');
        expect(app.history.list()).toHaveLength(0);
    });

    test('a field is marked after the user leaves it', async () => {
        type('select.columns.0.expr', 'name');
        field('select.from.table').dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        await settle();
        expect(field('select.from.table').classList.contains('is-invalid')).toBe(true);
    });

    test('"Go to field" focuses the field', async () => {
        type('select.from.table', 'users');
        await settle();
        $('[data-goto="select.columns.0.expr"]').click();
        expect(document.activeElement).toBe(field('select.columns.0.expr'));
    });
});

describe('security', () => {
    test('user input is rendered as text, never as HTML', async () => {
        await fillSimpleSelect('users', '<img src=x onerror="window.pwned=1">');
        type('select.from.table', 't');
        add('select.where.items', 'condition');
        type('select.where.items.0.left', 'a');
        type('select.where.items.0.value', '<script>window.pwned=1</script>');
        await settle();
        expect(document.querySelector('#sql-code img, #sql-code script, #issues-list img')).toBeNull();
        expect(sql()).toContain("'<script>window.pwned=1</script>'");
        expect(window.pwned).toBeUndefined();
    });
});

describe('generate, copy, download', () => {
    test('Generate adds to history; Ctrl+Enter and Ctrl+Shift+C shortcuts', async () => {
        const writeText = vi.fn().mockResolvedValue();
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        await fillSimpleSelect();
        press('Enter', { ctrlKey: true });
        await settle();
        expect(app.history.list()).toHaveLength(1);
        expect($$('#history-list .library-item')).toHaveLength(1);
        expect(toast()).toBe('SQL generated and saved to history.');

        press('C', { ctrlKey: true, shiftKey: true });
        await settle();
        expect(writeText).toHaveBeenCalledWith('SELECT name\nFROM users;');
    });

    test('copy with nothing to copy explains why', async () => {
        $('#copy-btn').click();
        await settle();
        expect(toast()).toContain('Nothing to copy yet');
    });

    test('download creates a .sql file', async () => {
        const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        let downloaded = '';
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () { downloaded = this.download; });
        await fillSimpleSelect();
        $('#download-btn').click();
        await settle();
        expect(downloaded).toBe('select-query.sql');
        expect(await createObjectURL.mock.calls[0][0].text()).toBe('SELECT name\nFROM users;\n');
    });

    test('one-line output mode', async () => {
        await fillSimpleSelect();
        $('[data-output-mode="compact"]').click();
        await settle();
        expect(sql()).toBe('SELECT name FROM users;');
        expect($('[data-output-mode="compact"]').getAttribute('aria-pressed')).toBe('true');
    });
});

describe('undo / redo', () => {
    test('buttons and keyboard shortcuts', async () => {
        await fillSimpleSelect();
        add('select.columns', 'column');
        await settle();
        expect($$('[data-path^="select.columns."][data-path$=".expr"]')).toHaveLength(2);

        $('#undo-btn').click();
        await settle();
        expect($$('[data-path^="select.columns."][data-path$=".expr"]')).toHaveLength(1);

        press('Z', { ctrlKey: true, shiftKey: true });
        await settle();
        expect($$('[data-path^="select.columns."][data-path$=".expr"]')).toHaveLength(2);

        press('z', { ctrlKey: true });
        await settle();
        expect($$('[data-path^="select.columns."][data-path$=".expr"]')).toHaveLength(1);
    });

    test('Ctrl+Z inside a text field is left to the browser', async () => {
        await fillSimpleSelect();
        add('select.columns', 'column');
        await settle();
        const input = field('select.columns.1.expr');
        press('z', { ctrlKey: true }, input);
        await settle();
        expect(field('select.columns.1.expr')).toBeTruthy();
    });

    test('Clear and Reset all are undoable', async () => {
        await fillSimpleSelect();
        $('#clear-btn').click();
        await settle();
        expect(field('select.from.table').value).toBe('');
        $('#undo-btn').click();
        await settle();
        expect(field('select.from.table').value).toBe('users');
        $('#reset-btn').click();
        await settle();
        expect(field('select.from.table').value).toBe('');
    });
});

describe('history panel', () => {
    async function generateQuery(table) {
        type('select.from.table', table);
        type('select.columns.0.expr', 'id');
        await settle();
        $('#generate-btn').click();
        await settle();
    }

    test('search, restore, delete and clear', async () => {
        await generateQuery('orders');
        await generateQuery('users');
        expect($$('#history-list .library-item')).toHaveLength(2);

        const search = $('#history-search');
        search.value = 'orders';
        search.dispatchEvent(new Event('input'));
        await settle();
        expect($$('#history-list .library-item')).toHaveLength(1);

        $('#history-list [data-action="history-restore"]').click();
        await settle();
        expect(field('select.from.table').value).toBe('orders');

        $('#history-list [data-action="history-delete"]').click();
        await settle();
        expect(app.history.list()).toHaveLength(1);

        search.value = '';
        search.dispatchEvent(new Event('input'));
        $('#history-clear-btn').click();
        await answerConfirm(true);
        expect(app.history.list()).toHaveLength(0);
        expect($('#history-list').textContent).toContain('Generated queries appear here');
    });

    test('history can be turned off', async () => {
        $('#settings-btn').click();
        const box = $('[data-setting="saveHistory"]');
        box.checked = false;
        box.dispatchEvent(new Event('change', { bubbles: true }));
        await generateQuery('orders');
        expect(app.history.list()).toHaveLength(0);
        expect($('#history-list').textContent).toContain('turned off');
    });

    test('history persists across reloads', async () => {
        await generateQuery('orders');
        boot(backend);
        expect(app.history.list()[0].sql).toBe('SELECT id\nFROM orders;');
    });
});

describe('templates', () => {
    test('save, rename, duplicate, load, delete', async () => {
        await fillSimpleSelect('customers');
        $('#template-save-btn').click();
        await answerPrompt('My customers');
        expect($('#tab-templates').getAttribute('aria-selected')).toBe('true');
        expect($('#template-list').textContent).toContain('My customers');

        $('#template-list [data-action="template-rename"]').click();
        await answerPrompt('Customers');
        expect($('#template-list').textContent).toContain('Customers');

        $('#template-list [data-action="template-duplicate"]').click();
        await settle();
        expect(app.templates.list().map(t => t.name)).toEqual(['Customers', 'Customers copy']);

        $('#reset-btn').click();
        $('#template-list [data-action="template-load"]').click();
        await settle();
        expect(field('select.from.table').value).toBe('customers');

        $('#template-list [data-action="template-delete"]').click();
        await answerConfirm(true);
        expect(app.templates.list()).toHaveLength(1);
    });

    test('cancelling the name prompt saves nothing', async () => {
        await fillSimpleSelect();
        $('#template-save-btn').click();
        await settle();
        $('#prompt-dialog [value="cancel"]').click();
        await settle();
        expect(app.templates.list()).toHaveLength(0);
    });

    test('export and import templates; malformed files are rejected', async () => {
        await fillSimpleSelect('customers');
        $('#template-save-btn').click();
        await answerPrompt('Customers');

        let exported = null;
        vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => { exported = blob; return 'blob:x'; });
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        $('#template-export-btn').click();
        const text = await exported.text();
        expect(JSON.parse(text).kind).toBe('templates');

        $('#template-import-btn').click();
        await chooseFile(text);
        expect(app.templates.list().map(t => t.name)).toEqual(['Customers', 'Customers (2)']);

        $('#template-import-btn').click();
        await chooseFile('{ nope');
        expect(toast()).toBe("Import failed: The file isn't valid JSON.");
        expect(app.templates.list()).toHaveLength(2);
    });
});

describe('query import / export', () => {
    test('export then import restores the query and dialect', async () => {
        await fillSimpleSelect('orders');
        let exported = null;
        vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => { exported = blob; return 'blob:x'; });
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        $('[data-command="export-query"]').click();
        const text = await exported.text();

        $('#reset-btn').click();
        $('[data-command="import-query"]').click();
        await chooseFile(text);
        expect(field('select.from.table').value).toBe('orders');
        expect(toast()).toContain('Query imported');
    });

    test('malformed imports leave the workspace untouched', async () => {
        await fillSimpleSelect('keep');
        for (const bad of ['not json', '{"type":"drop"}', '{"type":"select","select":{"columns":"x"}}']) {
            $('[data-command="import-query"]').click();
            await chooseFile(bad);
            expect(toast()).toMatch(/^Import failed:/);
        }
        expect(field('select.from.table').value).toBe('keep');
    });
});

describe('settings, theme, persistence', () => {
    test('dialect and identifier quoting change the output', async () => {
        await fillSimpleSelect();
        type('select.limit', '10');
        await settle();
        $('#settings-btn').click();
        const dialect = $('[data-setting="dialect"]');
        dialect.value = 'sqlserver';
        dialect.dispatchEvent(new Event('change', { bubbles: true }));
        const quote = $('[data-setting="quoteIdentifiers"]');
        quote.checked = true;
        quote.dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        expect(sql()).toBe('SELECT TOP 10 [name]\nFROM [users];');
        expect($('#dialect-badge').textContent).toBe('SQL Server');
    });

    test('with live preview off, SQL appears only after Generate and goes stale', async () => {
        $('#settings-btn').click();
        const live = $('[data-setting="livePreview"]');
        live.checked = false;
        live.dispatchEvent(new Event('change', { bubbles: true }));
        await fillSimpleSelect();
        expect($('#sql-output').hidden).toBe(true);
        $('#generate-btn').click();
        await settle();
        expect(sql()).toBe('SELECT name\nFROM users;');
        type('select.from.table', 'people');
        await settle();
        expect($('#output-state').textContent).toContain('changed since you last pressed Generate');
    });

    test('theme button cycles system → light → dark and persists', async () => {
        expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
        $('#theme-btn').click();
        expect(document.documentElement.getAttribute('data-theme')).toBe('light');
        $('#theme-btn').click();
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
        expect($('#theme-btn').textContent).toBe('Theme: Dark');
        boot(backend);
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
        $('#theme-btn').click();
        expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    });

    test('legacy theme preference is migrated', () => {
        boot(createMemoryBackend({ theme: 'dark' }));
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    test('unsaved work is restored after a reload, unless disabled', async () => {
        await fillSimpleSelect('draft_table');
        await settle();
        boot(backend);
        expect(field('select.from.table').value).toBe('draft_table');

        $('#settings-btn').click();
        const restore = $('[data-setting="restoreSession"]');
        restore.checked = false;
        restore.dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        expect(backend.getItem(`${STORAGE_PREFIX}draft`)).toBeNull();
        boot(backend);
        expect(field('select.from.table').value).toBe('');
    });

    test('delete all saved data', async () => {
        await fillSimpleSelect();
        $('#generate-btn').click();
        $('#template-save-btn').click();
        await answerPrompt('T');
        $('#settings-btn').click();
        $('#clear-data-btn').click();
        await answerConfirm(true);
        expect(app.history.list()).toHaveLength(0);
        expect(app.templates.list()).toHaveLength(0);
    });
});

describe('keyboard and accessibility', () => {
    test('every builder control has an accessible name', async () => {
        // Load a large example so most control types are present
        $$('#example-list [data-action="example-load"]').find(b => b.textContent === 'Load example').click();
        add('select.joins', 'join');
        add('select.ctes', 'cte');
        add('select.setOps', 'setOp');
        add('select.where.items', 'group');
        add('select.where.items', 'raw');
        add('select.columns', 'case');
        add('select.columns', 'window');
        const windowPath = `select.columns.${app.state.workspace.select.columns.length - 1}`;
        choose(`${windowPath}.func`, 'SUM');
        add(`${windowPath}.partitionBy`, 'groupBy');
        add(`${windowPath}.orderBy`, 'orderBy');
        choose(`${windowPath}.frame`, 'moving');
        await settle();
        expect(field(`${windowPath}.frameSize`)).toBeTruthy();
        const unnamed = $$('#builder input, #builder select, #builder button').filter(control => {
            if (control.getAttribute('aria-label')) return false;
            if (control.id && document.querySelector(`label[for="${control.id}"]`)) return false;
            if (control.closest('label')) return false;
            return control.tagName !== 'BUTTON' || control.textContent.trim() === '';
        });
        expect(unnamed.map(c => c.outerHTML)).toEqual([]);
    });

    test('? opens the shortcuts dialog; not while typing', async () => {
        press('?', {}, field('select.from.table'));
        expect($('#shortcuts-dialog').hasAttribute('open')).toBe(false);
        press('?');
        expect($('#shortcuts-dialog').hasAttribute('open')).toBe(true);
        expect($$('#shortcut-rows tr').length).toBeGreaterThan(4);
    });

    test('Escape closes the File menu', () => {
        const menu = $('#file-menu');
        menu.open = true;
        press('Escape');
        expect(menu.open).toBe(false);
    });

    test('library tabs support arrow keys', () => {
        press('ArrowRight', {}, $('#tab-history'));
        expect($('#tab-templates').getAttribute('aria-selected')).toBe('true');
        expect($('#panel-templates').hidden).toBe(false);
        expect($('#panel-history').hidden).toBe(true);
        press('End', {}, $('#tab-templates'));
        expect($('#tab-examples').getAttribute('aria-selected')).toBe('true');
        press('ArrowRight', {}, $('#tab-examples'));
        expect($('#tab-history').getAttribute('aria-selected')).toBe('true');
    });

    test('adding an item moves focus into it; removing returns focus to the add button', async () => {
        await fillSimpleSelect();
        add('select.where.items', 'condition');
        expect(document.activeElement).toBe(field('select.where.items.0.left'));
        $('[data-action="remove-item"][data-path="select.where.items.0"]').click();
        expect(document.activeElement.dataset.action).toBe('add-item');
    });
});

describe('INTERSECT / EXCEPT and window functions in the UI', () => {
    test('choosing INTERSECT and EXCEPT', async () => {
        await fillSimpleSelect('customers', 'email');
        add('select.setOps', 'setOp');
        choose('select.setOps.0.op', 'INTERSECT');
        type('select.setOps.0.query.from.table', 'suppliers');
        type('select.setOps.0.query.columns.0.expr', 'email');
        await settle();
        expect(sql()).toBe('SELECT email\nFROM customers\nINTERSECT\nSELECT email\nFROM suppliers;');
        choose('select.setOps.0.op', 'EXCEPT ALL');
        await settle();
        expect(sql()).toContain('\nEXCEPT ALL\n');
        expect($$('[data-path="select.setOps.0.op"] option').map(o => o.value)).toEqual(['UNION', 'UNION ALL', 'INTERSECT', 'INTERSECT ALL', 'EXCEPT', 'EXCEPT ALL']);
    });

    test('building a window function column', async () => {
        await fillSimpleSelect('sales', 'region');
        add('select.columns', 'window');
        const w = 'select.columns.1';
        expect(field(`${w}.args`)).toBeNull(); // ROW_NUMBER takes no arguments
        choose(`${w}.func`, 'AVG');
        type(`${w}.args`, 'amount');
        type(`${w}.alias`, 'moving_avg');
        add(`${w}.partitionBy`, 'groupBy');
        type(`${w}.partitionBy.0.expr`, 'region');
        add(`${w}.orderBy`, 'orderBy');
        type(`${w}.orderBy.0.expr`, 'day');
        choose(`${w}.frame`, 'moving');
        type(`${w}.frameSize`, '6');
        await settle();
        expect(sql()).toBe('SELECT\n    region,\n    AVG(amount) OVER (PARTITION BY region ORDER BY day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS moving_avg\nFROM sales;');
    });

    test('ranking functions hide the frame selector and flag missing ORDER BY', async () => {
        await fillSimpleSelect();
        add('select.columns', 'window');
        await settle();
        expect(field('select.columns.1.frame')).toBeNull();
        expect(issues().join()).toContain('ROW_NUMBER needs ORDER BY inside OVER');
    });

    test('switching a window column back to a plain column keeps the alias', async () => {
        await fillSimpleSelect();
        add('select.columns', 'window');
        type('select.columns.1.alias', 'keep_me');
        choose('select.columns.1.kind', 'column');
        expect(field('select.columns.1.alias').value).toBe('keep_me');
        expect(field('select.columns.1.expr')).toBeTruthy();
    });

    test('the window example loads and generates', async () => {
        $$('#example-list .library-item').find(li => li.textContent.includes('Window functions')).querySelector('button').click();
        await settle();
        expect(sql()).toContain('RANK() OVER (PARTITION BY department ORDER BY salary DESC) AS dept_rank');
        expect(sql()).toContain('SUM(salary) OVER (ORDER BY hired_on ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_payroll');
    });
});
