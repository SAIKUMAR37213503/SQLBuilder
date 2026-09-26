// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';

const html = readFileSync(join(import.meta.dirname, 'index.html'), 'utf8');

const $ = (selector) => document.querySelector(selector);
const outputText = () => $('#sql-output code').textContent;

function type(selector, value) {
    const input = typeof selector === 'string' ? $(selector) : selector;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

const click = (selector) => $(selector).click();
const generate = () => $('#query-form').requestSubmit();

async function loadApp() {
    document.documentElement.innerHTML = html.replace(/^<!DOCTYPE html>\s*<html[^>]*>/i, '').replace(/<\/html>\s*$/i, '');
    vi.resetModules();
    await import('./script.js');
}

beforeEach(loadApp);

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('SELECT form', () => {
    test('generates highlighted SQL with correct text', () => {
        type('#select-table', 'users');
        type('#select-columns', 'name');
        type('#select-where', "name = 'John'");
        generate();
        expect(outputText()).toBe("SELECT name\nFROM users\nWHERE name = 'John';");
        expect($('#sql-output .token.string').textContent).toBe("'John'");
    });

    test('flags missing required fields and focuses the first one', () => {
        generate();
        expect($('#select-table').classList.contains('error')).toBe(true);
        expect($('#select-table').getAttribute('aria-invalid')).toBe('true');
        expect(document.activeElement).toBe($('#select-table'));
        expect(outputText()).toMatch(/^Select a query type/);
    });

    test('rejects a non-positive LIMIT', () => {
        type('#select-table', 't');
        type('#select-columns', 'a');
        type('#select-limit', '0');
        generate();
        expect($('#select-limit').classList.contains('error')).toBe(true);
    });
});

describe('dynamic rows', () => {
    beforeEach(() => {
        type('#select-table', 'users');
        type('#select-columns', 'name');
    });

    test('empty JOIN inputs block generation and clear once typed in', () => {
        click('#add-join-btn');
        generate();
        const joinTable = $('.join-table');
        expect(joinTable.classList.contains('error')).toBe(true);
        type(joinTable, 'orders');
        expect(joinTable.classList.contains('error')).toBe(false);
    });

    test('JOIN, GROUP BY and HAVING rows produce SQL', () => {
        click('#add-join-btn');
        type('.join-table', 'orders');
        type('.join-left', 'users.id');
        type('.join-right', 'orders.user_id');
        click('#add-groupby-btn');
        type('.groupby-col', 'name');
        click('#add-having-btn');
        type('.having-col', 'COUNT(*)');
        $('.having-op').value = '>';
        type('.having-val', '1');
        generate();
        expect(outputText()).toBe('SELECT name\nFROM users\nINNER JOIN orders\nON users.id = orders.user_id\nGROUP BY name\nHAVING COUNT(*) > 1;');
    });

    test('Remove button deletes its row', () => {
        click('#add-join-btn');
        click('#add-join-btn');
        document.querySelector('.remove-join-btn').click();
        expect(document.querySelectorAll('#join-container .join-row')).toHaveLength(1);
    });
});

describe('UNION', () => {
    test('panel is hidden until enabled', () => {
        expect($('#union-fields').classList.contains('hidden')).toBe(true);
        $('#enable-union').click();
        expect($('#union-fields').classList.contains('hidden')).toBe(false);
    });

    test('second query fields are only required when UNION is enabled', () => {
        type('#select-table', 'a');
        type('#select-columns', 'x');
        generate();
        expect(outputText()).toBe('SELECT x\nFROM a;');

        $('#enable-union').click();
        generate();
        expect($('#select-table-2').classList.contains('error')).toBe(true);
        expect($('#select-table-2 + .error-message').textContent).toBe('This field is required');
    });

    test('column count mismatch is reported', () => {
        $('#enable-union').click();
        type('#select-table', 'a');
        type('#select-columns', 'x, y');
        type('#select-table-2', 'b');
        type('#select-columns-2', 'x');
        generate();
        expect($('#select-columns-2 + .error-message').textContent).toMatch(/same number of columns/);
    });

    test('ORDER BY and LIMIT apply to the combined result', () => {
        $('#enable-union').click();
        type('#select-table', 'a');
        type('#select-columns', 'x');
        type('#select-order', 'x');
        type('#select-limit', '5');
        type('#select-table-2', 'b');
        type('#select-columns-2', 'x');
        generate();
        expect(outputText()).toBe('SELECT x\nFROM a\nUNION\nSELECT x\nFROM b\nORDER BY x\nLIMIT 5;');
    });
});

describe('Clear Form', () => {
    test('resets fields, rows, UNION panel and output', () => {
        type('#select-table', 't');
        type('#select-columns', 'a');
        click('#add-join-btn');
        click('#add-groupby-btn');
        click('#add-having-btn');
        $('#enable-union').click();
        click('#clear-btn');

        expect($('#select-table').value).toBe('');
        expect(document.querySelectorAll('.join-row')).toHaveLength(0);
        expect($('#union-fields').classList.contains('hidden')).toBe(true);
        expect(outputText()).toMatch(/^Select a query type/);
    });
});

describe('query types', () => {
    test('switching type shows only that section and resets output', () => {
        type('#select-table', 't');
        type('#select-columns', 'a');
        generate();
        const deleteRadio = $('input[value="delete"]');
        deleteRadio.checked = true;
        deleteRadio.dispatchEvent(new Event('change', { bubbles: true }));

        expect($('#delete-fields').classList.contains('hidden')).toBe(false);
        expect($('#select-fields').classList.contains('hidden')).toBe(true);
        expect(outputText()).toMatch(/^Select a query type/);

        type('#delete-table', 'users');
        type('#delete-where', 'id = 1');
        generate();
        expect(outputText()).toBe('DELETE\nFROM users\nWHERE id = 1;');
    });
});

describe('copy', () => {
    test('asks for a query when nothing has been generated', async () => {
        click('#copy-btn');
        expect($('#output-message').textContent).toBe('Generate a query first!');
    });

    test('copies the plain SQL text via the Clipboard API', async () => {
        const writeText = vi.fn().mockResolvedValue();
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        type('#select-table', 't');
        type('#select-columns', 'a');
        generate();
        click('#copy-btn');
        await vi.waitFor(() => expect($('#copy-btn span').textContent).toBe('Copied!'));
        expect(writeText).toHaveBeenCalledWith('SELECT a\nFROM t;');
    });

    test('reports failure when both clipboard methods fail', async () => {
        Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
        document.execCommand = vi.fn().mockReturnValue(false);
        type('#select-table', 't');
        type('#select-columns', 'a');
        generate();
        click('#copy-btn');
        await vi.waitFor(() => expect($('#output-message').textContent).toMatch(/Copy failed/));
        expect($('#copy-btn span').textContent).toBe('Copy');
        expect(document.querySelector('textarea')).toBeNull();
    });
});

describe('theme', () => {
    test('app still initialises when storage access throws', async () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
        await loadApp();
        expect(document.documentElement.getAttribute('data-theme')).toBe('light');
        click('#theme-toggle');
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    test('restores a saved theme', async () => {
        localStorage.setItem('theme', 'dark');
        await loadApp();
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
        localStorage.clear();
    });
});
