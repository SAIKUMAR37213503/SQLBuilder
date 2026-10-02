// @vitest-environment jsdom
// SQL Lab's history, result and message text, and the editor.
import { describe, expect, test } from 'vitest';
import { createStorage, createMemoryBackend } from '../src/storage.js';
import { createLabHistory, LAB_HISTORY_LIMIT } from '../src/db/lab-history.js';
import { describeResult, cellText, formatDuration, summary, renderGrid, renderMessages, MAX_SHOWN_ROWS } from '../src/ui/lab-results.js';
import { createEditor } from '../src/ui/lab-editor.js';

describe('SQL Lab history', () => {
    const make = (options) => {
        let t = 1000;
        const storage = createStorage(createMemoryBackend());
        return { storage, history: createLabHistory(storage, { now: () => t++, ...options }) };
    };

    test('newest first, kept under its own key, survives a new instance', () => {
        const { storage, history } = make();
        history.add({ sql: 'SELECT 1;', databaseId: 'a', databaseName: 'A', ok: true, summary: '1 statement ran.' });
        history.add({ sql: 'SELECT 2;', databaseId: 'a', databaseName: 'A', ok: false, summary: 'error' });
        expect(history.list().map(e => e.sql)).toEqual(['SELECT 2;', 'SELECT 1;']);
        expect(history.list()[0].ok).toBe(false);
        expect(createLabHistory(storage).list()).toHaveLength(2);
        expect(storage.get('history', null)).toBe(null);
    });

    test('the same SQL in the same database moves to the top; in another database it is a new entry', () => {
        const { history } = make();
        history.add({ sql: 'SELECT 1;', databaseId: 'a', databaseName: 'A', ok: true, summary: '' });
        history.add({ sql: 'SELECT 2;', databaseId: 'a', databaseName: 'A', ok: true, summary: '' });
        history.add({ sql: '  SELECT 1;\n', databaseId: 'a', databaseName: 'A', ok: true, summary: '' });
        history.add({ sql: 'SELECT 1;', databaseId: 'b', databaseName: 'B', ok: true, summary: '' });
        expect(history.list().map(e => `${e.databaseId}:${e.sql}`)).toEqual(['b:SELECT 1;', 'a:SELECT 1;', 'a:SELECT 2;']);
    });

    test('limits, empty and oversized SQL, remove, clear, and bad stored data', () => {
        const { storage, history } = make({ limit: 3 });
        for (let i = 0; i < 5; i++) history.add({ sql: `SELECT ${i};`, databaseId: 'a', databaseName: 'A', ok: true, summary: '' });
        expect(history.list().map(e => e.sql)).toEqual(['SELECT 4;', 'SELECT 3;', 'SELECT 2;']);
        expect(history.add({ sql: '   ', databaseId: 'a', databaseName: 'A', ok: true, summary: '' })).toBe(null);
        expect(history.add({ sql: `SELECT '${'x'.repeat(110 * 1024)}';`, databaseId: 'a', databaseName: 'A', ok: true, summary: '' })).toBe(null);
        const id = history.list()[1].id;
        expect(history.get(id).sql).toBe('SELECT 3;');
        history.remove(id);
        expect(history.list().map(e => e.sql)).toEqual(['SELECT 4;', 'SELECT 2;']);
        history.clear();
        expect(history.list()).toEqual([]);
        storage.set('lab-history', [{ nope: true }, 'x', { id: 'k', sql: 'SELECT 9;', ranAt: 5 }]);
        expect(history.list().map(e => e.sql)).toEqual(['SELECT 9;']);
        storage.set('lab-history', { not: 'a list' });
        expect(history.list()).toEqual([]);
        expect(LAB_HISTORY_LIMIT).toBe(50);
    });
});

describe('result text', () => {
    test('says what each statement did, from what the engine reported', () => {
        expect(describeResult({ kind: 'query', columns: ['a'], rows: [[1], [2]], more: false })).toBe('2 rows returned');
        expect(describeResult({ kind: 'query', columns: ['a'], rows: [[1]], more: false })).toBe('1 row returned');
        expect(describeResult({ kind: 'query', columns: ['a'], rows: [], more: false })).toBe('0 rows returned');
        expect(describeResult({ kind: 'query', columns: ['a'], rows: new Array(100).fill([1]), more: true })).toBe('First 100 rows shown; more available');
        expect(describeResult({ kind: 'modify', columns: [], rows: [], rowsAffected: 3 })).toBe('Query completed successfully. 3 rows affected.');
        expect(describeResult({ kind: 'modify', columns: [], rows: [], rowsAffected: null })).toBe('Query completed successfully.');
        expect(describeResult({ kind: 'modify', columns: ['id'], rows: [[7]], rowsAffected: 1, more: false })).toBe('Query completed successfully. 1 row affected. 1 row returned.');
        expect(describeResult({ kind: 'transaction', sql: 'BEGIN;', columns: [], rows: [] })).toContain('Transaction started');
        expect(describeResult({ kind: 'transaction', sql: 'commit', columns: [], rows: [] })).toBe('Transaction committed.');
        expect(describeResult({ kind: 'transaction', sql: 'ROLLBACK', columns: [], rows: [] })).toBe('Transaction rolled back.');
        expect(describeResult({ kind: 'transaction', sql: 'ROLLBACK TO s1', columns: [], rows: [] })).toBe('Rolled back to the savepoint.');
        expect(describeResult({ kind: 'other', sql: 'CREATE TABLE t(a)', columns: [], rows: [] })).toBe('Completed successfully.');
    });

    test('cells, durations and the run summary', () => {
        expect(cellText(null)).toBe('NULL');
        expect(cellText({ blob: 1 })).toBe('BLOB (1 byte)');
        expect(cellText(0)).toBe('0');
        expect(cellText('')).toBe('');
        expect(formatDuration(0.25)).toBe('0.3 ms');
        expect(formatDuration(1234.4)).toBe(`${(1234).toLocaleString()} ms`);
        expect(formatDuration(undefined)).toBe('');
        const r = (d) => ({ kind: 'query', columns: ['a'], rows: [], durationMs: d, line: 1, sql: 'SELECT 1' });
        expect(summary({ results: [r(1), r(2)], omitted: 0, statements: 2, changes: 0, error: null })).toBe('2 statements ran in 3.0 ms.');
        expect(summary({ results: [r(1)], omitted: 0, statements: 1, changes: 4, error: null })).toBe('1 statement ran in 1.0 ms, 4 rows changed.');
        // With statements left out, no total time is claimed
        expect(summary({ results: [r(1)], omitted: 5, statements: 6, changes: 0, error: null })).toBe('6 statements ran.');
        expect(summary({ results: [], omitted: 0, statements: 0, changes: 0, error: { message: 'x' } })).toBe('The SQL didn\'t run: the engine reported an error.');
        expect(summary({ results: [r(1)], omitted: 0, statements: 1, changes: 2, error: { message: 'x' } })).toBe('1 statement ran, 2 rows changed, then an error stopped the script.');
        expect(summary({ results: [], omitted: 0, statements: 0, changes: 0, error: null })).toBe('There was no SQL to run.');
        expect(summary({ stopped: true, results: [] })).toBe('Stopped before it finished.');
    });

    test('a grid offers more rows only while it can page, up to the limit', () => {
        const base = { kind: 'query', columns: ['a', 'b'], durationMs: 2, line: 3, sql: 'SELECT a, b FROM t' };
        let grid = renderGrid({ ...base, rows: [[1, null], [2, { blob: 3 }]], more: true, cursor: 'c1' }, { index: 0, count: 1, loading: false });
        expect(grid.querySelector('.lab-result-title').textContent).toBe('Result (line 3)');
        expect(grid.querySelectorAll('tbody tr')).toHaveLength(2);
        expect(grid.querySelector('.lab-null').textContent).toBe('NULL');
        expect(grid.querySelector('.lab-blob').textContent).toBe('BLOB (3 bytes)');
        expect(grid.querySelector('[data-lab-action="more"]').textContent).toBe('Load 100 more rows');
        grid = renderGrid({ ...base, rows: [[1, 2]], more: true, cursor: 'c1' }, { index: 1, count: 2, loading: true });
        expect(grid.querySelector('.lab-result-title').textContent).toBe('Result 2 of 2 (line 3)');
        expect(grid.querySelector('[data-lab-action="more"]').disabled).toBe(true);
        grid = renderGrid({ ...base, rows: [[1, 2]], more: true, cursor: null }, { index: 0, count: 2, loading: false });
        expect(grid.querySelector('[data-lab-action="more"]')).toBe(null);
        expect(grid.textContent).toContain('Run this statement on its own');
        grid = renderGrid({ ...base, rows: new Array(MAX_SHOWN_ROWS).fill([1, 2]), more: true, cursor: null }, { index: 0, count: 1, loading: false });
        expect(grid.textContent).toContain('Showing the first 1,000 rows');
    });

    test('messages list each statement, what was left out, the error and the transaction', () => {
        const ok = (line, extra) => ({ kind: 'modify', columns: [], rows: [], rowsAffected: 1, durationMs: 1, line, sql: `INSERT INTO t VALUES (${line})`, ...extra });
        const host = document.createElement('div');
        host.append(...renderMessages({ results: [ok(1), ok(9)], omitted: 7, statements: 9, changes: 9, error: { message: 'no such table: x', line: 10, column: 13 }, inTransaction: true }));
        const items = [...host.querySelectorAll('.lab-message')].map(li => li.textContent);
        expect(items[0]).toContain('Line 1');
        expect(items[1]).toBe('7 more statements ran successfully (not listed).');
        expect(items[2]).toContain('Line 9');
        expect(items[3]).toContain('Line 10, column 13');
        expect(items[3]).toContain('no such table: x');
        expect(host.textContent).toContain('A transaction is open. Run COMMIT');
        expect(host.textContent).toContain('ran inside the open transaction');

        const stopped = document.createElement('div');
        stopped.append(...renderMessages({ results: [], omitted: 0, statements: 0, changes: 0, error: null, inTransaction: false, stopped: true }));
        expect(stopped.textContent).toContain('Stopped. The engine was restarted');
    });
});

describe('editor', () => {
    const typeIn = (editor, value) => {
        editor.input.value = value;
        editor.input.dispatchEvent(new Event('input', { bubbles: true }));
    };

    test('highlights its text and keeps it as typed', () => {
        const seen = [];
        const editor = createEditor({ label: 'SQL', onInput: v => seen.push(v) });
        document.body.replaceChildren(editor.root);
        typeIn(editor, 'SELECT 1 -- note\n');
        expect(seen).toEqual(['SELECT 1 -- note\n']);
        expect(editor.root.querySelector('.tok-keyword').textContent).toBe('SELECT');
        expect(editor.root.querySelector('.tok-comment')).not.toBe(null);
        expect(editor.root.querySelector('pre').getAttribute('aria-hidden')).toBe('true');
        expect(editor.input.getAttribute('aria-label')).toBe('SQL');
        expect(editor.value).toBe('SELECT 1 -- note\n');
    });

    test('Ctrl+Enter or Cmd+Enter runs, and goes no further', () => {
        let runs = 0;
        let reachedDocument = 0;
        const editor = createEditor({ label: 'SQL', onRun: () => runs++ });
        document.body.replaceChildren(editor.root);
        const listener = () => reachedDocument++;
        document.addEventListener('keydown', listener);
        editor.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
        editor.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
        editor.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        document.removeEventListener('keydown', listener);
        expect(runs).toBe(2);
        expect(reachedDocument).toBe(1);
    });

    test('the selection says where it starts; goTo selects the word at a line and column', () => {
        const editor = createEditor({ label: 'SQL' });
        document.body.replaceChildren(editor.root);
        editor.value = 'SELECT 1;\n  SELECT nope FROM t;';
        expect(editor.selection()).toBe(null);
        editor.input.setSelectionRange(12, 31);
        expect(editor.selection()).toEqual({ text: 'SELECT nope FROM t;', line: 2, column: 3 });
        editor.goTo(2, 10);
        expect(editor.input.value.slice(editor.input.selectionStart, editor.input.selectionEnd)).toBe('nope');
        expect(document.activeElement).toBe(editor.input);
        // Columns count characters, not UTF-16 units
        editor.value = "SELECT '😀', bad";
        editor.goTo(1, 13);
        expect(editor.input.value.slice(editor.input.selectionStart, editor.input.selectionEnd)).toBe('bad');
    });
});
