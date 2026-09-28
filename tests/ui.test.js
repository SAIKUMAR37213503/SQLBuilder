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
function pickDialect(id) {
    const picker = $('#dialect-select');
    picker.value = id;
    picker.dispatchEvent(new Event('change', { bubbles: true }));
}
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

async function answerTemplate(name, { description = '', category = '' } = {}) {
    await settle();
    const dialog = $('#template-dialog');
    expect(dialog.hasAttribute('open')).toBe(true);
    $('#template-name').value = name;
    $('#template-description').value = description;
    $('#template-category').value = category;
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

    test('INSERT … SELECT builds the query with the SELECT editor', async () => {
        selectType('insert');
        type('insert.table', 'archive');
        type('insert.columns', 'id');
        choose('insert.source', 'select');
        await settle();
        expect(field('insert.rows.0.values')).toBeNull();
        type('insert.select.from.table', 'orders');
        type('insert.select.columns.0.expr', 'id');
        await settle();
        expect(sql()).toBe('INSERT INTO archive (id)\nSELECT id\nFROM orders;');
    });

    test('upsert: choosing Update adds a row, and the fill button uses the inserted columns', async () => {
        app.state.settings.dialect = 'postgresql';
        selectType('insert');
        type('insert.table', 'customers');
        type('insert.columns', 'email, name, city');
        type('insert.rows.0.values', "'a@x.io', 'Ada', 'Oslo'");
        choose('insert.upsert.mode', 'update');
        await settle();
        expect(field('insert.upsert.set.0.column')).toBeTruthy();
        type('insert.upsert.conflict', 'email');
        $('[data-action="fill-upsert"]').click();
        await settle();
        expect(app.state.workspace.insert.upsert.set.map(a => a.column)).toEqual(['name', 'city']);
        expect(sql()).toBe(
            "INSERT INTO customers (email, name, city)\nVALUES ('a@x.io', 'Ada', 'Oslo')\nON CONFLICT (email) DO UPDATE\nSET\n    name = EXCLUDED.name,\n    city = EXCLUDED.city;"
        );
        expect(document.activeElement.dataset.action).toBe('fill-upsert');
    });

    test('a condition can use a parameter; list operators fall back to a value', async () => {
        await fillSimpleSelect();
        add('select.where.items', 'condition');
        type('select.where.items.0.left', 'id');
        choose('select.where.items.0.valueType', 'param');
        await settle();
        expect(sql()).toBe('SELECT name\nFROM users\nWHERE id = ?;');
        expect(field('select.where.items.0.value').placeholder).toContain('parameter name');
        choose('select.where.items.0.op', 'IN');
        await settle();
        expect(app.state.workspace.select.where.items[0].valueType).toBe('value');
        expect($$('[data-path="select.where.items.0.valueType"] option').map(o => o.value)).not.toContain('param');
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

    test('typing after Undo is kept when Redo is pressed right away', async () => {
        await fillSimpleSelect();
        add('select.columns', 'column');
        await settle();
        $('#undo-btn').click();
        await settle();
        type('select.from.table', 'accounts');
        $('#redo-btn').click();
        await settle();
        expect(field('select.from.table').value).toBe('accounts');
        expect($$('[data-path^="select.columns."][data-path$=".expr"]')).toHaveLength(1);
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
        await answerTemplate('My customers');
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

    test('a template remembers its dialect', async () => {
        await fillSimpleSelect('customers');
        app.state.settings.dialect = 'postgresql';
        $('#template-save-btn').click();
        await answerTemplate('Pg customers');
        expect(app.templates.list()[0].dialect).toBe('postgresql');
        expect($('#template-list').textContent).toContain('PostgreSQL');

        app.state.settings.dialect = 'generic';
        $('#template-list [data-action="template-load"]').click();
        await settle();
        expect(app.state.settings.dialect).toBe('postgresql');
        expect(toast()).toContain('dialect switched to PostgreSQL');
    });

    test('cancelling the name prompt saves nothing', async () => {
        await fillSimpleSelect();
        $('#template-save-btn').click();
        await settle();
        $('#template-dialog [value="cancel"]').click();
        await settle();
        expect(app.templates.list()).toHaveLength(0);
    });

    test('export and import templates; malformed files are rejected', async () => {
        await fillSimpleSelect('customers');
        $('#template-save-btn').click();
        await answerTemplate('Customers');

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

    test('importing a query saved for another dialect switches to it and says so', async () => {
        pickDialect('mysql');
        await fillSimpleSelect('orders');
        let exported = null;
        vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => { exported = blob; return 'blob:x'; });
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        $('[data-command="export-query"]').click();
        const text = await exported.text();

        pickDialect('generic');
        $('[data-command="import-query"]').click();
        await chooseFile(text);
        expect($('#dialect-select').value).toBe('mysql');
        expect(toast()).toBe('Query imported (dialect switched to MySQL). Undo restores your previous query.');
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
        expect($('#dialect-select').value).toBe('sqlserver');
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
        await answerTemplate('T');
        $('#settings-btn').click();
        $('#clear-data-btn').click();
        await answerConfirm(true);
        expect(app.history.list()).toHaveLength(0);
        expect(app.templates.list()).toHaveLength(0);
    });

    test('delete all saved data also clears the builder and resets settings', async () => {
        await fillSimpleSelect('secret_table');
        $('#settings-btn').click();
        choose('select.distinct', true);
        const dialect = $('[data-setting="dialect"]');
        dialect.value = 'mysql';
        dialect.dispatchEvent(new Event('change', { bubbles: true }));
        $('#clear-data-btn').click();
        await answerConfirm(true);
        await settle();
        expect(field('select.from.table').value).toBe('');
        expect($('[data-setting="dialect"]').value).toBe('generic');
        expect(app.state.settings.dialect).toBe('generic');
        expect(backend.getItem(`${STORAGE_PREFIX}draft`)).toBeNull();
        expect(backend.getItem(`${STORAGE_PREFIX}settings`)).toBeNull();
    });
});

describe('output wrapping', () => {
    test('Wrap is display only, remembered, and copying still gives the plain SQL', async () => {
        await fillSimpleSelect();
        const copied = [];
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { copied.push(t); } }, configurable: true });
        $('#wrap-btn').click();
        await settle();
        expect($('#sql-output').classList.contains('wrap')).toBe(true);
        expect($('#wrap-btn').getAttribute('aria-pressed')).toBe('true');
        $('#copy-btn').click();
        await settle();
        expect(copied).toEqual(['SELECT name\nFROM users;']);
        boot(backend);
        expect($('#sql-output').classList.contains('wrap')).toBe(true);
    });
});

describe('checks panel', () => {
    test('errors are listed before warnings and tips, and the bar shows the count', async () => {
        const upd = $('input[name="query-type"][value="update"]');
        upd.checked = true;
        upd.dispatchEvent(new Event('change', { bubbles: true }));
        type('update.table', 't');
        await settle();
        // no WHERE (warning) and an empty SET column (error)
        const levels = $$('#issues-list .issue-level').map(n => n.textContent);
        expect(levels[0]).toBe('Error');
        expect(levels.indexOf('Warning')).toBeGreaterThan(levels.lastIndexOf('Error'));
        expect($('#status-badge').hidden).toBe(false);
        expect($('#status-badge').dataset.level).toBe('error');
        expect($('#view-sql-btn').getAttribute('aria-label')).toMatch(/\d errors?\)/);

        type('update.set.0.column', 'a');
        type('update.set.0.value', '1');
        await settle();
        expect($('#status-badge').dataset.level).toBe('warning');
    });

    test('field descriptions still point at the right message after sorting', async () => {
        type('select.columns.0.expr', 'x');
        $('#generate-btn').click();
        await settle();
        const input = field('select.from.table');
        const id = input.getAttribute('aria-describedby').split(' ').pop();
        expect(document.getElementById(id).textContent).toContain('table to select from');
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

    test('INSERT … SELECT and upsert controls have accessible names', async () => {
        pickDialect('postgresql');
        const radio = $('input[name="query-type"][value="insert"]');
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
        choose('insert.source', 'select');
        choose('insert.upsert.mode', 'update');
        add('insert.upsert.set', 'upsertAssignment');
        choose('insert.upsert.set.1.valueType', 'param');
        await settle();
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

describe('saving the current query', () => {
    const name = () => $('#query-name').textContent;
    const saveKey = () => press('s', { ctrlKey: true });

    test('Save names a new query once, then Ctrl+S updates it in place', async () => {
        await fillSimpleSelect('orders');
        expect(name()).toBe('Unsaved query');
        expect($('#save-btn').textContent).toBe('Save…');
        $('#save-btn').click();
        await answerTemplate('Monthly revenue');
        expect(name()).toBe('Monthly revenuesaved');
        expect($('#save-btn').textContent).toBe('Save');

        type('select.from.table', 'invoices');
        await settle();
        expect($('.query-name-state').textContent).toBe('unsaved changes');
        const event = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true });
        document.dispatchEvent(event);
        await settle();
        expect(event.defaultPrevented).toBe(true);
        expect(toast()).toBe('Saved “Monthly revenue”.');
        expect($('.query-name-state').textContent).toBe('saved');
        expect($$('#template-list .library-item')).toHaveLength(1);
        const stored = JSON.parse(backend.getItem(`${STORAGE_PREFIX}templates`));
        expect(stored[0].workspace.select.from.table).toBe('invoices');
    });

    test('a changed dialect counts as an unsaved change', async () => {
        await fillSimpleSelect('orders');
        saveKey();
        await answerTemplate('Orders');
        pickDialect('mysql');
        await settle();
        expect($('.query-name-state').textContent).toBe('unsaved changes');
        saveKey();
        await settle();
        expect(JSON.parse(backend.getItem(`${STORAGE_PREFIX}templates`))[0].dialect).toBe('mysql');
    });

    test('loading a template edits it; examples, history and imports start an unsaved query', async () => {
        await fillSimpleSelect('orders');
        saveKey();
        await answerTemplate('Orders');
        $('[data-action="example-load"][data-id="join-aggregate"]').click();
        await settle();
        expect(name()).toBe('Unsaved query');
        $('#template-list [data-action="template-load"]').click();
        await settle();
        expect(name()).toBe('Orderssaved');
        $('#reset-btn').click();
        await settle();
        expect(name()).toBe('Unsaved query');
    });

    test('the template being edited is remembered across a reload, and forgotten when deleted', async () => {
        await fillSimpleSelect('orders');
        saveKey();
        await answerTemplate('Orders');
        await settle();
        boot(backend);
        await settle();
        expect(name()).toBe('Orderssaved');
        $('#template-list [data-action="template-delete"]').click();
        await answerConfirm();
        expect(name()).toBe('Unsaved query');
        saveKey();
        await settle();
        expect($('#template-dialog').hasAttribute('open')).toBe(true);
    });

    test('the shortcut is listed', () => {
        expect($('#shortcut-rows').textContent).toContain('Save the query');
    });
});

describe('command palette', () => {
    const palette = () => $('#palette-dialog');
    const options = () => $$('#palette-list [role="option"] .palette-label').map(n => n.textContent);
    const search = (text) => {
        $('#palette-input').value = text;
        $('#palette-input').dispatchEvent(new Event('input', { bubbles: true }));
    };
    const active = () => $(`#${$('#palette-input').getAttribute('aria-activedescendant')} .palette-label`).textContent;

    test('Ctrl/⌘+K opens it with focus in the search field and every command listed', async () => {
        press('k', { ctrlKey: true });
        await settle();
        expect(palette().hasAttribute('open')).toBe(true);
        expect(document.activeElement).toBe($('#palette-input'));
        expect(options()).toContain('Generate SQL');
        expect(options()).toContain('Use PostgreSQL');
        // Only commands that make sense now: nothing to undo, SELECT is current
        expect(options()).not.toContain('Undo');
        expect(options()).not.toContain('Switch to SELECT');
        expect(active()).toBe('Generate SQL');
        expect($('#palette-list [aria-selected="true"]')).not.toBeNull();
    });

    test('typing filters, arrows move the active option and Enter runs it', async () => {
        await fillSimpleSelect();
        press('k', { metaKey: true });
        await settle();
        search('switch to');
        expect(options()).toEqual(['Switch to INSERT', 'Switch to UPDATE', 'Switch to DELETE', expect.stringMatching(/^Switch theme to /)]);
        press('ArrowDown', {}, $('#palette-input'));
        expect(active()).toBe('Switch to UPDATE');
        press('ArrowUp', {}, $('#palette-input'));
        press('ArrowUp', {}, $('#palette-input'));
        expect(active()).toBe(options().at(-1));
        press('ArrowDown', {}, $('#palette-input'));
        press('Enter', {}, $('#palette-input'));
        await settle();
        expect(palette().hasAttribute('open')).toBe(false);
        expect($('input[name="query-type"][value="insert"]').checked).toBe(true);
        expect(field('insert.table')).not.toBeNull();
    });

    test('no matches shows a message; Escape closes without running anything', async () => {
        press('k', { ctrlKey: true });
        await settle();
        search('zzzz');
        expect($('#palette-list').hidden).toBe(true);
        expect($('.palette-empty').hidden).toBe(false);
        expect($('#palette-input').getAttribute('aria-expanded')).toBe('false');
        press('Enter', {}, $('#palette-input'));
        press('Escape', {}, palette());
        await settle();
        expect(palette().hasAttribute('open')).toBe(false);
    });

    test('commands reuse the app actions: dialect, output mode and clicking an option', async () => {
        press('k', { ctrlKey: true });
        await settle();
        search('mysql');
        press('Enter', {}, $('#palette-input'));
        await settle();
        expect($('#dialect-select').value).toBe('mysql');

        $('[data-command="palette"]').click();
        await settle();
        expect(palette().hasAttribute('open')).toBe(true);
        search('one line');
        $('#palette-list [role="option"]').click();
        await settle();
        expect($('[data-output-mode="compact"]').getAttribute('aria-pressed')).toBe('true');
    });

    test('it does not open over another dialog', async () => {
        $('#settings-btn').click();
        await settle();
        press('k', { ctrlKey: true });
        await settle();
        expect(palette().hasAttribute('open')).toBe(false);
    });
});

describe('template library', () => {
    const names = () => $$('#template-list .library-name').map(n => n.textContent);
    async function saveAs(table, name, category = '') {
        type('select.from.table', table);
        type('select.columns.0.expr', 'id');
        await settle();
        $('#template-save-btn').click();
        await answerTemplate(name, { category });
    }
    const search = (text) => {
        $('#template-search').value = text;
        $('#template-search').dispatchEvent(new Event('input', { bubbles: true }));
    };
    const sortBy = (value) => {
        $('#template-sort').value = value;
        $('#template-sort').dispatchEvent(new Event('change', { bubbles: true }));
    };

    test('search matches name, category and description; sort by name or recent', async () => {
        await saveAs('b', 'Beta report', 'Finance');
        await vi.advanceTimersByTimeAsync(60_000);
        await saveAs('a', 'Alpha list');
        expect(names()).toEqual(['Alpha list', 'Beta report']);
        sortBy('recent');
        expect(names()).toEqual(['Alpha list', 'Beta report']);
        search('finance');
        expect(names()).toEqual(['Beta report']);
        search('nothing like this');
        expect($('#template-list').textContent).toBe('No templates match “nothing like this”.');
        search('');
        expect(names()).toHaveLength(2);
    });

    test('Pin moves a template to the top and keeps focus on it', async () => {
        await saveAs('a', 'Alpha');
        await saveAs('b', 'Beta');
        expect(names()).toEqual(['Alpha', 'Beta']);
        $('[aria-label="Pin template Beta to the top"]').click();
        await settle();
        expect(names()).toEqual(['Beta', 'Alpha']);
        expect($('#template-list .library-item').textContent).toContain('Pinned');
        expect(document.activeElement).toBe($('[aria-label="Unpin template Beta"]'));
        expect(JSON.parse(backend.getItem(`${STORAGE_PREFIX}templates`)).find(t => t.name === 'Beta').pinned).toBe(true);
        $('[aria-label="Unpin template Beta"]').click();
        await settle();
        expect(names()).toEqual(['Alpha', 'Beta']);
    });

    test('the template being edited is marked', async () => {
        await saveAs('a', 'Alpha');
        expect($('#template-list .library-current').textContent).toBe('Editing');
        $('#reset-btn').click();
        await settle();
        $('[data-action="template-load"]').click();
        await settle();
        expect($('#template-list .library-current')).not.toBeNull();
    });
});

describe('query structure panel', () => {
    const loadExample = async (id) => {
        $(`#example-list [data-action="example-load"][data-id="${id}"]`).click();
        await settle();
    };
    const steps = () => $$('#structure-steps .structure-clause').map(n => n.textContent);

    test('is hidden for an empty query and lists the steps in processing order', async () => {
        expect($('#structure').hidden).toBe(true);
        await loadExample('join-aggregate');
        expect($('#structure').hidden).toBe(false);
        expect($('#complexity').textContent).toBe('· 1 join · 1 condition');
        expect(steps()).toEqual(['FROM', 'JOIN', 'GROUP BY', 'HAVING', 'SELECT', 'ORDER BY']);
        expect($$('#structure-steps .structure-jump').every(b => b.type === 'button')).toBe(true);
    });

    test('follows the dialect and query type', async () => {
        await loadExample('page-results');
        expect(steps().at(-1)).toBe('LIMIT');
        pickDialect('sqlserver');
        await settle();
        expect(steps().at(-1)).toBe('TOP');
        $('input[name="query-type"][value="delete"]').click();
        type('delete.table', 'audit_log');
        await settle();
        expect(steps()).toEqual(['DELETE FROM', 'No WHERE']);
    });

    test('a step opens its builder section and moves focus there', async () => {
        await loadExample('join-aggregate');
        const grouping = $('details[data-section="select:grouping"]');
        grouping.open = false;
        $$('#structure-steps .structure-jump').find(b => b.textContent.includes('HAVING')).click();
        expect(grouping.open).toBe(true);
        expect(document.activeElement).toBe(grouping.querySelector('summary'));
        // The open state survives the next re-render of the builder
        add('select.orderBy', 'orderBy');
        await settle();
        expect($('details[data-section="select:grouping"]').open).toBe(true);
    });

    test('a DML step moves focus to its field', async () => {
        $('input[name="query-type"][value="delete"]').click();
        type('delete.table', 'audit_log');
        await settle();
        $$('#structure-steps .structure-jump').find(b => b.textContent.includes('No WHERE')).click();
        expect($('[data-path="delete.where"]').contains(document.activeElement)).toBe(true);
    });
});

describe('dialects in the UI', () => {
    const optionText = (path, value) => field(path).querySelector(`option[value="${value}"]`).textContent;

    test('the picker next to the SQL heading changes the SQL and settings, and keeps the query', async () => {
        await fillSimpleSelect();
        type('select.limit', '5');
        await settle();
        const before = JSON.stringify(app.state.workspace);
        expect($('#output-panel #dialect-select')).not.toBeNull();
        expect($('.builder-panel #dialect-select')).toBeNull();
        expect($('#dialect-select').value).toBe('generic');
        expect($$('#dialect-select option').map(o => o.textContent)).toEqual(['Generic SQL', 'Microsoft SQL Server', 'PostgreSQL', 'MySQL']);

        pickDialect('sqlserver');
        await settle();
        expect(sql()).toBe('SELECT TOP 5 name\nFROM users;');
        expect(app.state.settings.dialect).toBe('sqlserver');
        expect(JSON.parse(backend.getItem(`${STORAGE_PREFIX}settings`)).dialect).toBe('sqlserver');
        expect(JSON.stringify(app.state.workspace)).toBe(before);
        expect(toast()).toBe('Dialect: Microsoft SQL Server.');

        // The Settings select stays in sync
        $('#settings-btn').click();
        expect($('[data-setting="dialect"]').value).toBe('sqlserver');
    });

    test('switching to a dialect that can\'t express part of the query keeps it and says so', async () => {
        await fillSimpleSelect();
        add('select.joins', 'join');
        choose('select.joins.0.type', 'FULL JOIN');
        type('select.joins.0.source.table', 'teams');
        type('select.joins.0.on.items.0.left', 'users.team_id');
        type('select.joins.0.on.items.0.value', 'teams.id');
        await settle();
        pickDialect('mysql');
        await settle();
        expect(app.state.workspace.select.joins[0].type).toBe('FULL JOIN');
        expect(toast()).toBe('Dialect: MySQL. 1 part of this query isn\'t supported there; see Checks.');
        expect(issues().join()).toContain('MySQL doesn\'t support FULL JOIN');
        expect($('#sql-output').hidden).toBe(true);
        pickDialect('postgresql');
        await settle();
        expect(sql()).toContain('FULL JOIN teams');
    });

    test('options a dialect can\'t use stay available, labelled', async () => {
        await fillSimpleSelect();
        add('select.joins', 'join');
        add('select.setOps', 'setOp');
        expect(optionText('select.joins.0.type', 'FULL JOIN')).toBe('FULL JOIN');
        pickDialect('mysql');
        expect(optionText('select.joins.0.type', 'FULL JOIN')).toBe('FULL JOIN (not in MySQL)');
        pickDialect('sqlserver');
        expect(optionText('select.setOps.0.op', 'INTERSECT ALL')).toBe('INTERSECT ALL — rows in both, keep duplicates (not in SQL Server)');
        expect(optionText('select.setOps.0.op', 'INTERSECT')).toBe('INTERSECT — rows in both queries');
        add('select.columns', 'window');
        expect(optionText('select.columns.1.func', 'NTH_VALUE')).toBe('NTH_VALUE() (not in SQL Server)');
    });

    test('the row-limit field is called TOP on SQL Server', () => {
        pickDialect('sqlserver');
        expect($(`label[for="${field('select.limit').id}"]`).textContent).toBe('TOP');
        expect($('[data-section="select:sorting"] summary').textContent).toContain('ORDER BY, TOP & OFFSET');
        pickDialect('postgresql');
        expect($(`label[for="${field('select.limit').id}"]`).textContent).toBe('LIMIT');
    });

    test('upsert controls appear only where the dialect supports them, unless already used', async () => {
        const radio = $('input[name="query-type"][value="insert"]');
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
        expect(field('insert.upsert.mode')).toBeNull();
        expect($('.dialect-note').textContent).toBe('Conflict handling (upsert) is available for PostgreSQL and MySQL, not Generic SQL.');
        pickDialect('postgresql');
        choose('insert.upsert.mode', 'nothing');
        pickDialect('sqlserver');
        // Kept visible so the user can see and change what Checks reports
        expect(field('insert.upsert.mode').value).toBe('nothing');
        pickDialect('mysql');
        expect(optionText('insert.upsert.mode', 'nothing')).toBe('Skip the row (DO NOTHING) (not in MySQL)');
    });

    test('examples follow the dialect and preview its SQL', () => {
        const names = () => $$('#example-list .library-name').map(n => n.textContent);
        const preview = (name) => $$('#example-list .library-item').find(li => li.textContent.includes(name)).querySelector('.library-snippet').textContent;
        expect($('#example-filter').value).toBe('generic');
        expect(names()).not.toContain('Upsert: insert or update');
        expect(preview('Filter, sort and limit')).toBe('SELECT Name, Salary FROM Employees WHERE Salary > 50000 ORDER BY Salary DESC LIMIT 10;');
        pickDialect('sqlserver');
        expect($('#example-filter').value).toBe('sqlserver');
        expect(preview('Filter, sort and limit')).toBe('SELECT TOP 10 Name, Salary FROM Employees WHERE Salary > 50000 ORDER BY Salary DESC;');
        pickDialect('postgresql');
        expect(names()).toContain('Upsert: insert or update');
        const filter = $('#example-filter');
        filter.value = 'all';
        filter.dispatchEvent(new Event('change', { bubbles: true }));
        expect(names()).toHaveLength(16);
    });

    test('templates keep a description and category, and can be filtered by dialect', async () => {
        await fillSimpleSelect();
        $('#template-save-btn').click();
        await answerTemplate('Users', { description: 'All user names', category: 'Reports' });
        pickDialect('mysql');
        $('#template-save-btn').click();
        await settle();
        expect($('#template-dialect-note').textContent).toBe('Saved for MySQL; loading it switches back to that dialect.');
        expect($$('#template-categories option').map(o => o.value)).toEqual(['Reports']);
        $('#template-name').value = 'Users MySQL';
        $('#template-dialog [value="confirm"]').click();
        await settle();

        const first = app.templates.list().find(t => t.name === 'Users');
        expect(first).toMatchObject({ dialect: 'generic', description: 'All user names', category: 'Reports' });
        const item = $$('#template-list .library-item').find(li => li.textContent.includes('All user names'));
        expect(item.textContent).toContain('Reports');
        expect(item.textContent).toContain('Generic SQL');

        const filter = $('#template-filter');
        filter.value = 'mysql';
        filter.dispatchEvent(new Event('change', { bubbles: true }));
        expect($$('#template-list .library-name').map(n => n.textContent)).toEqual(['Users MySQL']);
        filter.value = 'postgresql';
        filter.dispatchEvent(new Event('change', { bubbles: true }));
        expect($('#template-list').textContent).toBe('No templates for PostgreSQL. Choose “All dialects” to see all 2.');
    });

    test('the dialect picker has an accessible name and description', () => {
        const picker = $('#dialect-select');
        expect(picker.closest('label').textContent).toContain('Dialect');
        expect($(`#${picker.getAttribute('aria-describedby')}`).textContent).toContain('Your query is kept');
    });
});
