import { describe, expect, test } from 'vitest';
import { createStorage, createMemoryBackend, STORAGE_PREFIX } from '../src/storage.js';
import { loadSettings, saveSettings, sanitizeSettings, DEFAULT_SETTINGS } from '../src/settings.js';
import { createHistory, HISTORY_LIMIT } from '../src/history.js';
import { createTemplateStore, TemplateError } from '../src/templates.js';
import { UndoStack } from '../src/undo.js';
import {
    normalizeWorkspace, parseQueryFile, createQueryExport, parseTemplatesFile, createTemplatesExport, ImportError, APP_ID,
    createBackup, parseBackupFile, BACKUP_FORMAT, BACKUP_VERSION
} from '../src/serialization.js';
import { EXAMPLES, EXAMPLE_LEVELS, EXAMPLE_TOPICS, examplesFor } from '../src/examples.js';
import { createWorkspace, createCondition, createGroup } from '../src/model.js';
import { generateSQL } from '../src/generator.js';
import { validateWorkspace, hasErrors } from '../src/validation.js';

const memoryStorage = (initial) => createStorage(createMemoryBackend(initial));

function throwingBackend() {
    const fail = () => { throw new Error('blocked'); };
    return { getItem: fail, setItem: fail, removeItem: fail };
}

describe('storage', () => {
    test('round-trips JSON under a prefix', () => {
        const backend = createMemoryBackend();
        const storage = createStorage(backend);
        expect(storage.set('x', { a: 1 })).toBe(true);
        expect(backend.getItem(`${STORAGE_PREFIX}x`)).toBe('{"a":1}');
        expect(storage.get('x')).toEqual({ a: 1 });
    });

    test('never throws when storage is blocked or corrupt', () => {
        const blocked = createStorage(throwingBackend());
        expect(blocked.get('x', 'fallback')).toBe('fallback');
        expect(blocked.set('x', 1)).toBe(false);
        expect(() => blocked.remove('x')).not.toThrow();

        const corrupt = memoryStorage({ [`${STORAGE_PREFIX}x`]: '{not json' });
        expect(corrupt.get('x', 'fallback')).toBe('fallback');

        const none = createStorage(null);
        expect(none.available).toBe(false);
        expect(none.get('x', 1)).toBe(1);
    });
});

describe('settings', () => {
    test('defaults and sanitisation of untrusted values', () => {
        expect(loadSettings(memoryStorage())).toEqual(DEFAULT_SETTINGS);
        expect(sanitizeSettings({ dialect: 'oracle', theme: 'neon', livePreview: 'yes', saveHistory: false })).toEqual({
            ...DEFAULT_SETTINGS, saveHistory: false
        });
    });

    test('persists and reloads', () => {
        const storage = memoryStorage();
        saveSettings(storage, { ...DEFAULT_SETTINGS, theme: 'dark', dialect: 'mysql' });
        expect(loadSettings(storage)).toMatchObject({ theme: 'dark', dialect: 'mysql' });
    });

    test('migrates the legacy "theme" key', () => {
        expect(loadSettings(memoryStorage({ theme: 'dark' })).theme).toBe('dark');
    });
});

describe('history', () => {
    const ws = (table) => {
        const w = createWorkspace('delete');
        w.delete.table = table;
        return w;
    };
    const entry = (table) => ({ type: 'delete', dialect: 'generic', sql: `DELETE FROM ${table};`, workspace: ws(table) });

    test('adds newest first, persists and reloads', () => {
        const storage = memoryStorage();
        let clock = 0;
        const history = createHistory(storage, { now: () => ++clock });
        history.add(entry('a'));
        history.add(entry('b'));
        expect(history.list().map(e => e.sql)).toEqual(['DELETE FROM b;', 'DELETE FROM a;']);
        expect(createHistory(storage).list()).toHaveLength(2);
    });

    test('stores a snapshot, not a live reference', () => {
        const history = createHistory(memoryStorage());
        const w = ws('a');
        history.add({ ...entry('a'), workspace: w });
        w.delete.table = 'changed';
        expect(history.list()[0].workspace.delete.table).toBe('a');
    });

    test('consecutive duplicates update the timestamp instead of adding', () => {
        let clock = 0;
        const history = createHistory(memoryStorage(), { now: () => ++clock });
        history.add(entry('a'));
        history.add(entry('a'));
        expect(history.list()).toHaveLength(1);
        expect(history.list()[0].timestamp).toBe(2);
    });

    test('is capped', () => {
        const history = createHistory(memoryStorage());
        for (let i = 0; i < HISTORY_LIMIT + 10; i++) history.add(entry(`t${i}`));
        expect(history.list()).toHaveLength(HISTORY_LIMIT);
        expect(history.list()[0].sql).toBe(`DELETE FROM t${HISTORY_LIMIT + 9};`);
    });

    test('search, remove, clear', () => {
        const storage = memoryStorage();
        const history = createHistory(storage);
        history.add(entry('orders'));
        history.add(entry('users'));
        expect(history.search('ORDERS').map(e => e.sql)).toEqual(['DELETE FROM orders;']);
        history.remove(history.search('users')[0].id);
        expect(history.list()).toHaveLength(1);
        history.clear();
        expect(history.list()).toEqual([]);
        expect(createHistory(storage).list()).toEqual([]);
    });

    test('ignores malformed stored entries', () => {
        const storage = memoryStorage({
            [`${STORAGE_PREFIX}history`]: JSON.stringify([{ id: 'x', sql: 'ok', workspace: { type: 'nope' } }, 'junk', { id: 'y', sql: 'ok', type: 'delete', workspace: ws('t') }])
        });
        expect(createHistory(storage).list().map(e => e.id)).toEqual(['y']);
    });

    test('shrinks when storage quota is exceeded', () => {
        const backend = createMemoryBackend();
        const original = backend.setItem;
        backend.setItem = (key, value) => {
            if (value.length > 2000) throw new Error('QuotaExceededError');
            original(key, value);
        };
        const history = createHistory(createStorage(backend));
        for (let i = 0; i < 20; i++) history.add(entry(`table_${i}`));
        expect(history.list().length).toBeLessThan(20);
        expect(history.list()[0].sql).toBe('DELETE FROM table_19;');
    });
});

describe('templates', () => {
    const w = createWorkspace();

    test('create, rename, duplicate, delete, reload', () => {
        const storage = memoryStorage();
        const store = createTemplateStore(storage);
        const a = store.create('  Monthly   report ', w);
        expect(a.name).toBe('Monthly report');
        const b = store.duplicate(a.id);
        expect(b.name).toBe('Monthly report copy');
        expect(store.rename(b.id, 'Weekly').name).toBe('Weekly');
        expect(createTemplateStore(storage).list().map(t => t.name)).toEqual(['Monthly report', 'Weekly']);
        store.remove(a.id);
        expect(store.list().map(t => t.name)).toEqual(['Weekly']);
    });

    test('names are required, bounded and made unique', () => {
        const store = createTemplateStore(memoryStorage());
        expect(() => store.create('  ', w)).toThrow(TemplateError);
        expect(() => store.create('x'.repeat(81), w)).toThrow(/at most 80/);
        store.create('Report', w);
        expect(store.create('report', w).name).toBe('report (2)');
        expect(store.create('Report', w).name).toBe('Report (3)');
    });

    test('rename of a missing template fails without changes', () => {
        const store = createTemplateStore(memoryStorage());
        expect(() => store.rename('missing', 'x')).toThrow('no longer exists');
    });

    test('storage failures roll back and explain', () => {
        const store = createTemplateStore(createStorage(throwingBackend()));
        expect(() => store.create('x', w)).toThrow(TemplateError);
        expect(store.list()).toEqual([]);
    });

    test('importMany', () => {
        const store = createTemplateStore(memoryStorage());
        store.create('A', w);
        const added = store.importMany([{ name: 'A', workspace: w }, { name: 'B', workspace: w }]);
        expect(added.map(t => t.name)).toEqual(['A (2)', 'B']);
    });
});

describe('template dialects', () => {
    const w = createWorkspace();

    test('the dialect is stored, duplicated, reloaded and exported; unknown ones are dropped', () => {
        const storage = memoryStorage();
        const store = createTemplateStore(storage);
        const a = store.create('Pg', w, { dialect: 'postgresql' });
        expect(a.dialect).toBe('postgresql');
        expect(store.duplicate(a.id).dialect).toBe('postgresql');
        expect(store.create('Bad', w, { dialect: 'oracle' }).dialect).toBeUndefined();
        const reloaded = createTemplateStore(storage).list();
        expect(reloaded.find(t => t.name === 'Pg').dialect).toBe('postgresql');
        const exported = createTemplatesExport(reloaded);
        expect(exported.templates.find(t => t.name === 'Pg').dialect).toBe('postgresql');
        const parsed = parseTemplatesFile(JSON.stringify(exported));
        expect(parsed.ok && parsed.templates.find(t => t.name === 'Pg').dialect).toBe('postgresql');
    });

    test('update replaces the query and dialect but keeps name, description and category', () => {
        const storage = memoryStorage();
        let clock = 1;
        const store = createTemplateStore(storage, { now: () => clock });
        const a = store.create('Report', w, { dialect: 'postgresql', description: 'Monthly', category: 'Finance' });
        const changed = createWorkspace('delete');
        clock = 5;
        const updated = store.update(a.id, changed, { dialect: 'mysql' });
        expect(updated).toMatchObject({ id: a.id, name: 'Report', description: 'Monthly', category: 'Finance', dialect: 'mysql', createdAt: 1, updatedAt: 5 });
        expect(updated.workspace).toEqual(changed);
        expect(updated.workspace).not.toBe(changed);
        expect(createTemplateStore(storage).get(a.id).workspace.type).toBe('delete');
        expect(() => store.update('missing', w)).toThrow('no longer exists');
    });

    test('pinning is stored, exported and imported; copies are not pinned', () => {
        const storage = memoryStorage();
        const store = createTemplateStore(storage);
        const a = store.create('A', w);
        expect(a.pinned).toBeUndefined();
        expect(store.setPinned(a.id, true).pinned).toBe(true);
        expect(createTemplateStore(storage).get(a.id).pinned).toBe(true);
        expect(store.duplicate(a.id).pinned).toBeUndefined();
        // Saving over and renaming keep the pin
        expect(store.update(a.id, w, { dialect: 'mysql' }).pinned).toBe(true);
        expect(store.rename(a.id, 'A2').pinned).toBe(true);
        store.rename(a.id, 'A');
        const parsed = parseTemplatesFile(JSON.stringify(createTemplatesExport(store.list())));
        expect(parsed.ok && parsed.templates.map(t => Boolean(t.pinned))).toEqual([true, false]);
        expect(store.importMany(parsed.ok ? parsed.templates : [])[0].pinned).toBe(true);
        expect('pinned' in store.setPinned(a.id, false)).toBe(false);
        // Only a real true counts
        storage.set('templates', [{ id: 'x', name: 'X', pinned: 'yes', workspace: w }]);
        expect(createTemplateStore(storage).get('x').pinned).toBeUndefined();
    });

    test('templates saved by earlier versions (no dialect) still load', () => {
        const storage = memoryStorage();
        storage.set('templates', [{ id: 'x', name: 'Old', createdAt: 1, updatedAt: 1, workspace: w }]);
        const [old] = createTemplateStore(storage).list();
        expect(old.name).toBe('Old');
        expect(old.dialect).toBeUndefined();
        expect(old.description).toBeUndefined();
        expect(old.category).toBeUndefined();
    });

    test('description and category are cleaned, kept, duplicated, exported and imported', () => {
        const storage = memoryStorage();
        const store = createTemplateStore(storage);
        const t = store.create('Report', w, { dialect: 'mysql', description: '  Monthly\n  totals  ', category: ` ${'x'.repeat(60)} ` });
        expect(t).toMatchObject({ description: 'Monthly totals', category: 'x'.repeat(40) });
        expect(store.create('Plain', w, { description: '   ', category: '' })).not.toHaveProperty('description');
        expect(store.duplicate(t.id)).toMatchObject({ description: 'Monthly totals', dialect: 'mysql' });
        expect(store.categories()).toEqual(['x'.repeat(40)]);
        const reloaded = createTemplateStore(storage).list();
        const parsed = parseTemplatesFile(JSON.stringify(createTemplatesExport(reloaded)));
        expect(parsed.ok).toBe(true);
        const imported = createTemplateStore(memoryStorage()).importMany(parsed.ok ? parsed.templates : []);
        expect(imported.find(x => x.name === 'Report')).toMatchObject({ dialect: 'mysql', description: 'Monthly totals', category: 'x'.repeat(40) });
        expect(imported.find(x => x.name === 'Plain')).not.toHaveProperty('category');
    });
});

describe('undo stack', () => {
    test('undo / redo / branch', () => {
        const stack = new UndoStack();
        stack.reset({ v: 0 });
        stack.push({ v: 1 });
        stack.push({ v: 2 });
        expect(stack.push({ v: 2 })).toBe(false);
        expect(stack.undo()).toEqual({ v: 1 });
        expect(stack.undo()).toEqual({ v: 0 });
        expect(stack.undo()).toBeNull();
        expect(stack.redo()).toEqual({ v: 1 });
        stack.push({ v: 9 });
        expect(stack.canRedo).toBe(false);
        expect(stack.undo()).toEqual({ v: 1 });
    });

    test('is bounded', () => {
        const stack = new UndoStack(3);
        stack.reset(0);
        for (let i = 1; i <= 10; i++) stack.push(i);
        let steps = 0;
        while (stack.undo() !== null) steps++;
        expect(steps).toBe(3);
    });
});

describe('import / export', () => {
    test('query export round-trips', () => {
        const ws = EXAMPLES.find(e => e.id === 'not-exists').build();
        const text = JSON.stringify(createQueryExport(ws, { dialect: 'postgresql' }));
        const result = parseQueryFile(text);
        expect(result).toMatchObject({ ok: true, dialect: 'postgresql' });
        expect(result.workspace).toEqual(ws);
    });

    test('accepts a bare workspace or a single query node', () => {
        expect(parseQueryFile(JSON.stringify(createWorkspace('update'))).workspace.type).toBe('update');
        const node = parseQueryFile(JSON.stringify({ kind: 'delete', table: 'x' }));
        expect(node.workspace.type).toBe('delete');
        expect(node.workspace.delete.table).toBe('x');
    });

    test.each([
        ['not json', "isn't valid JSON"],
        ['[]', 'must be a JSON object'],
        ['{"type":"drop"}', 'unsupported value'],
        ['{"type":"select","select":{"columns":"a"}}', 'must be a list'],
        ['{"type":"select","select":{"columns":[{"expr":5,"alias":{}}]}}', 'must be text'],
        ['{"type":"select","select":{"where":{"items":[{"kind":"evil"}]}}}', 'kind must be'],
        ['{"type":"select","select":{"joins":[{"type":"NATURAL JOIN","source":{}}]}}', 'unsupported value'],
        ['{"version":99}', 'newer version'],
        ['{"kind":"templates","templates":[]}', 'templates file']
    ])('rejects %s', (text, message) => {
        const result = parseQueryFile(text);
        expect(result.ok).toBe(false);
        expect(result.error).toContain(message);
    });

    test('rejects huge files and deeply nested queries', () => {
        expect(parseQueryFile(' '.repeat(1024 * 1024 + 1)).error).toMatch(/too large/);
        let q = { kind: 'select' };
        for (let i = 0; i < 12; i++) q = { kind: 'select', from: { kind: 'subquery', query: q, alias: 's' } };
        expect(parseQueryFile(JSON.stringify(q)).error).toMatch(/too deeply/);
    });

    test('drops unknown keys and prototype-pollution attempts', () => {
        const ws = normalizeWorkspace(JSON.parse('{"type":"delete","delete":{"table":"t","__proto__":{"polluted":true},"extra":1}}'));
        expect(ws.delete).toEqual({ kind: 'delete', table: 't', where: createGroup() });
        expect({}.polluted).toBeUndefined();
    });

    test('numbers in text fields are accepted as text', () => {
        const ws = normalizeWorkspace({ type: 'select', select: { limit: 10 } });
        expect(ws.select.limit).toBe('10');
    });

    test('ImportError is exported for callers', () => {
        expect(() => normalizeWorkspace(null)).toThrow(ImportError);
    });

    test('templates export round-trips; malformed templates are rejected', () => {
        const store = createTemplateStore(memoryStorage());
        store.create('Example', EXAMPLES[0].build());
        const text = JSON.stringify(createTemplatesExport(store.list()));
        const parsed = parseTemplatesFile(text);
        expect(parsed.ok).toBe(true);
        expect(parsed.templates[0].name).toBe('Example');

        expect(parseTemplatesFile('{"kind":"query"}').error).toMatch(/isn't a templates file/);
        expect(parseTemplatesFile(JSON.stringify({ app: APP_ID, kind: 'templates', templates: [{ name: '', workspace: {} }] })).error).toMatch(/has no name/);
        expect(parseTemplatesFile(JSON.stringify({ kind: 'templates', templates: [{ name: 'Bad', workspace: { type: 'x' } }] })).error).toMatch(/Template “Bad”/);
    });
});

describe('full backup', () => {
    const w = (table) => {
        const ws = createWorkspace();
        ws.select.from.table = table;
        ws.select.columns[0].expr = 'id';
        return ws;
    };
    function seeded() {
        const storage = memoryStorage();
        let clock = 1000;
        const templates = createTemplateStore(storage, { now: () => clock++ });
        const history = createHistory(storage, { now: () => clock++ });
        const a = templates.create('Orders', w('orders'), { dialect: 'mysql', category: 'Sales' });
        templates.setPinned(a.id, true);
        history.add({ type: 'select', dialect: 'generic', sql: 'SELECT id\nFROM orders;', workspace: w('orders') });
        history.add({ type: 'select', dialect: 'mysql', sql: 'SELECT id\nFROM users;', workspace: w('users') });
        return { storage, templates, history };
    }
    const backupOf = ({ templates, history }, settings = DEFAULT_SETTINGS) => JSON.stringify(createBackup({ templates: templates.list(), history: history.list(), settings }));

    test('a backup round-trips templates (with pins and dates), history and settings', () => {
        const source = seeded();
        const text = backupOf(source, { ...DEFAULT_SETTINGS, dialect: 'postgresql', theme: 'dark' });
        const data = JSON.parse(text);
        expect(data).toMatchObject({ app: APP_ID, kind: 'backup', format: BACKUP_FORMAT, version: BACKUP_VERSION });
        const parsed = parseBackupFile(text);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.settings).toMatchObject({ dialect: 'postgresql', theme: 'dark' });
        expect(parsed.templates[0]).toMatchObject({ name: 'Orders', dialect: 'mysql', category: 'Sales', pinned: true, createdAt: 1000 });
        expect(parsed.history.map(e => e.sql)).toEqual(['SELECT id\nFROM users;', 'SELECT id\nFROM orders;']);

        const target = { storage: memoryStorage() };
        const templates = createTemplateStore(target.storage);
        const history = createHistory(target.storage);
        expect(templates.restore(parsed.templates)).toEqual({ added: 1, skipped: 0 });
        expect(history.restore(parsed.history)).toEqual({ added: 2, skipped: 0, dropped: 0 });
        expect(createTemplateStore(target.storage).list()[0]).toMatchObject({ name: 'Orders', pinned: true, createdAt: 1000, updatedAt: source.templates.list()[0].updatedAt });
        expect(createHistory(target.storage).list().map(e => e.dialect)).toEqual(['mysql', 'generic']);
    });

    test('merge skips exact copies; a changed template with the same name is added with a new name', () => {
        const store = seeded();
        const parsed = parseBackupFile(backupOf(store));
        if (!parsed.ok) throw new Error(parsed.error);
        expect(store.templates.restore(parsed.templates)).toEqual({ added: 0, skipped: 1 });
        expect(store.history.restore(parsed.history)).toEqual({ added: 0, skipped: 2, dropped: 0 });
        parsed.templates[0].workspace.select.from.table = 'orders_2024';
        expect(store.templates.restore(parsed.templates)).toEqual({ added: 1, skipped: 0 });
        expect(store.templates.list().map(t => t.name)).toEqual(['Orders', 'Orders (2)']);
    });

    test('replace swaps templates and history; history keeps the newest entries up to the limit', () => {
        const store = seeded();
        store.templates.create('Local only', w('local'));
        const other = seeded();
        const parsed = parseBackupFile(backupOf(other));
        if (!parsed.ok) throw new Error(parsed.error);
        expect(store.templates.restore(parsed.templates, { replace: true })).toEqual({ added: 1, skipped: 0 });
        expect(store.templates.list().map(t => t.name)).toEqual(['Orders']);

        const many = Array.from({ length: HISTORY_LIMIT }, (_, i) => ({ timestamp: 5000 + i, type: 'select', dialect: 'generic', sql: `SELECT ${i};`, workspace: w('t') }));
        const result = store.history.restore(many);
        expect(result).toEqual({ added: HISTORY_LIMIT, skipped: 0, dropped: 2 });
        expect(store.history.list()[0].sql).toBe(`SELECT ${HISTORY_LIMIT - 1};`);
        expect(store.history.restore([], { replace: true })).toEqual({ added: 0, skipped: 0, dropped: 0 });
        expect(store.history.list()).toEqual([]);
    });

    test('restoring over the template limit changes nothing', () => {
        const store = seeded();
        const items = Array.from({ length: 200 }, (_, i) => ({ name: `T${i}`, workspace: w(`t${i}`) }));
        expect(() => store.templates.restore(items)).toThrow(/limit of 200/);
        expect(store.templates.list().map(t => t.name)).toEqual(['Orders']);
        expect(store.templates.restore(items, { replace: true }).added).toBe(200);
    });

    test('files are validated field by field and never trusted', () => {
        const error = (value) => {
            const result = parseBackupFile(typeof value === 'string' ? value : JSON.stringify(value));
            return result.ok ? null : result.error;
        };
        const base = { app: APP_ID, kind: 'backup', format: BACKUP_FORMAT, version: 1 };
        expect(error('nope')).toBe("The file isn't valid JSON.");
        expect(error({ kind: 'templates', templates: [] })).toMatch(/templates file/);
        expect(error({ ...base, format: 'other' })).toMatch(/isn't a backup file/);
        expect(error({ ...base, version: 2 })).toMatch(/newer version/);
        expect(error({ ...base, templates: {} })).toMatch(/must be lists/);
        expect(error({ ...base, history: [{ sql: '', workspace: w('x') }] })).toMatch(/no SQL/);
        expect(error({ ...base, history: [{ sql: 'SELECT 1', workspace: { type: 'drop' } }] })).toMatch(/^history\[0\]/);
        expect(error({ ...base, templates: [{ name: 'x', workspace: { type: 'select', select: { columns: 'x' } } }] })).toMatch(/Template “x”/);
        // A backup with only settings is fine; unknown settings, dialects and dates are cleaned
        const parsed = parseBackupFile(JSON.stringify({ ...base, settings: { theme: 'neon', dialect: 'oracle', livePreview: false }, history: [{ sql: 'SELECT 1', dialect: 'oracle', timestamp: 'soon', workspace: w('x') }] }));
        expect(parsed.ok && parsed.settings).toEqual({ ...DEFAULT_SETTINGS, livePreview: false });
        expect(parsed.ok && parsed.history[0]).toMatchObject({ dialect: 'generic', timestamp: 0, type: 'select' });
        expect(parsed.ok && parsed.templates).toEqual([]);
        // The other importers point at the right place
        const backupText = JSON.stringify(base);
        expect(parseQueryFile(backupText)).toEqual({ ok: false, error: 'This is a full backup. Use File, Restore from backup.' });
        expect(parseTemplatesFile(backupText)).toEqual({ ok: false, error: 'This is a full backup. Use File, Restore from backup.' });
    });
});

describe('examples', () => {
    test.each(EXAMPLES.map(e => [e.name, e]))('%s generates valid SQL for every dialect it supports', (_name, example) => {
        const ws = example.build();
        for (const dialect of example.dialects ?? ['generic', 'postgresql', 'mysql', 'sqlserver']) {
            const issues = validateWorkspace(ws, { dialect });
            expect(hasErrors(issues), JSON.stringify(issues)).toBe(false);
            expect(generateSQL(ws, { dialect })).toMatch(/;$/);
        }
    });

    test('every example has a level and a topic, and every topic has examples', () => {
        for (const example of EXAMPLES) {
            expect(Object.keys(EXAMPLE_LEVELS), example.id).toContain(example.level);
            expect(EXAMPLE_TOPICS, example.id).toContain(example.topic);
        }
        for (const topic of EXAMPLE_TOPICS) expect(examplesFor('all', topic).length, topic).toBeGreaterThan(0);
        expect(new Set(EXAMPLES.map(e => e.id)).size).toBe(EXAMPLES.length);
        expect(examplesFor('generic', 'Changing data').map(e => e.id)).not.toContain('upsert');
    });

    test('the documented example output', () => {
        expect(generateSQL(EXAMPLES[0].build())).toBe(
            'SELECT\n    Name,\n    Salary\nFROM Employees\nWHERE Salary > 50000\nORDER BY Salary DESC\nLIMIT 10;'
        );
    });

    test('example builders return fresh objects', () => {
        const a = EXAMPLES[0].build();
        a.select.where.items.push(createCondition());
        expect(EXAMPLES[0].build().select.where.items).toHaveLength(1);
    });
});

describe('storage when full', () => {
    test('existing data stays readable when writes fail', () => {
        const backend = createMemoryBackend({ [`${STORAGE_PREFIX}x`]: '"kept"' });
        backend.setItem = () => { throw new Error('QuotaExceededError'); };
        const storage = createStorage(backend);
        expect(storage.available).toBe(true);
        expect(storage.get('x')).toBe('kept');
        expect(storage.set('y', 1)).toBe(false);
    });
});

describe('import of window functions and set operators', () => {
    test('round-trips and rejects unknown values', () => {
        const ws = EXAMPLES.find(e => e.id === 'window').build();
        expect(parseQueryFile(JSON.stringify(ws)).workspace).toEqual(ws);
        expect(parseQueryFile(JSON.stringify(EXAMPLES.find(e => e.id === 'intersect').build())).ok).toBe(true);

        const bad = (patch) => {
            const copy = structuredClone(ws);
            Object.assign(copy.select.columns[3], patch);
            return parseQueryFile(JSON.stringify(copy));
        };
        expect(bad({ func: 'DROP_TABLE' }).error).toMatch(/func has an unsupported value/);
        expect(bad({ frame: 'RANGE 1 PRECEDING' }).error).toMatch(/frame has an unsupported value/);
        expect(bad({ partitionBy: 'dept' }).error).toMatch(/must be a list/);
        expect(parseQueryFile('{"type":"select","select":{"setOps":[{"op":"MINUS","query":{}}]}}').error).toMatch(/unsupported value/);
    });
});

describe('import of INSERT … SELECT, upserts and parameters', () => {
    test('INSERT saved by an earlier version gets the new defaults', () => {
        const ws = normalizeWorkspace({ kind: 'insert', table: 't', columns: 'a', rows: [{ values: '1' }] });
        expect(ws.insert.source).toBe('values');
        expect(ws.insert.upsert).toEqual({ mode: '', conflict: '', set: [] });
        expect(ws.insert.select.kind).toBe('select');
    });

    test('new fields round-trip and bad values are rejected', () => {
        const ws = createWorkspace('insert');
        Object.assign(ws.insert, { table: 't', source: 'select', upsert: { mode: 'update', conflict: 'id', set: [{ column: 'a', valueType: 'inserted', value: '' }] } });
        ws.update.set = [{ column: 'x', valueType: 'param', value: 'p' }];
        ws.select.where = createGroup('AND', [createCondition({ left: 'a', valueType: 'param', value: 'n' })]);
        expect(normalizeWorkspace(JSON.parse(JSON.stringify(ws)))).toEqual(ws);
        expect(() => normalizeWorkspace({ kind: 'insert', source: 'sql' })).toThrow(ImportError);
        expect(() => normalizeWorkspace({ kind: 'insert', upsert: { mode: 'replace' } })).toThrow(ImportError);
        expect(() => normalizeWorkspace({ kind: 'update', set: [{ column: 'a', valueType: 'inserted' }] })).toThrow(ImportError);
    });
});
