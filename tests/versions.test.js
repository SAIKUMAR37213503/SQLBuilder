import { describe, expect, test } from 'vitest';
import { diffLines, describeDiff, MAX_DIFF_LINES } from '../src/versions.js';
import { createTemplateStore, TemplateError, TEMPLATE_VERSION_LIMIT, TEMPLATE_VERSIONS_TOTAL } from '../src/templates.js';
import { createStorage, createMemoryBackend, STORAGE_PREFIX } from '../src/storage.js';
import { createWorkspace } from '../src/model.js';
import { createBackup, parseBackupFile, createTemplatesExport, parseTemplatesFile, readVersions } from '../src/serialization.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';

/** A SELECT reading one table. */
function query(table) {
    const ws = createWorkspace('select');
    ws.select.from.table = table;
    ws.select.columns[0].expr = 'id';
    return ws;
}

function clockedStore(backend = createMemoryBackend()) {
    let time = 1000;
    const store = createTemplateStore(createStorage(backend), { now: () => (time += 1000) });
    return { store, backend };
}

describe('line diff', () => {
    test('marks added and removed lines in order, keeping the rest', () => {
        expect(diffLines('SELECT a\nFROM t\nWHERE x = 1', 'SELECT a\nFROM u\nWHERE x = 1\nORDER BY a')).toEqual([
            { type: 'same', text: 'SELECT a' },
            { type: 'removed', text: 'FROM t' },
            { type: 'added', text: 'FROM u' },
            { type: 'same', text: 'WHERE x = 1' },
            { type: 'added', text: 'ORDER BY a' }
        ]);
        expect(diffLines('', 'a')).toEqual([{ type: 'added', text: 'a' }]);
        expect(diffLines('a\nb', '')).toEqual([{ type: 'removed', text: 'a' }, { type: 'removed', text: 'b' }]);
        expect(diffLines('a\nb\nc', 'a\nb\nc').every(d => d.type === 'same')).toBe(true);
    });

    test('finds the shortest change in the middle of repeated lines', () => {
        const diff = diffLines('x\na\nb\na\nb\ny', 'x\na\nb\nc\na\nb\ny');
        expect(diff.filter(d => d.type !== 'same')).toEqual([{ type: 'added', text: 'c' }]);
        // The two sides can always be rebuilt from the diff
        const before = 'p\nq\nr\ns\nq\nt';
        const after = 'q\nr\nz\ns\nt\nq';
        const d = diffLines(before, after);
        expect(d.filter(l => l.type !== 'added').map(l => l.text).join('\n')).toBe(before);
        expect(d.filter(l => l.type !== 'removed').map(l => l.text).join('\n')).toBe(after);
    });

    test('says how much changed, and gives up on very long SQL', () => {
        expect(describeDiff(diffLines('a', 'a'))).toBe('Same SQL');
        expect(describeDiff(diffLines('a', 'a\nb'))).toBe('1 line added');
        expect(describeDiff(diffLines('a\nb\nc', 'a'))).toBe('2 lines removed');
        expect(describeDiff(diffLines('a\nb', 'c\nd\ne'))).toBe('3 lines added, 2 removed');
        const long = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `line ${i}`).join('\n');
        expect(diffLines(long, 'x')).toBe(null);
        expect(describeDiff(null)).toBe('Too long to compare line by line');
    });
});

describe('template versions', () => {
    test('each Save keeps the query it replaces, newest first', () => {
        const { store, backend } = clockedStore();
        const t = store.create('Report', query('a'), { dialect: 'postgresql' });
        expect(t.versions).toBeUndefined();
        const first = store.update(t.id, query('b'), { dialect: 'mysql' });
        expect(first.keptVersion).toBe(true);
        store.update(t.id, query('c'), { dialect: 'mysql' });
        const saved = store.get(t.id);
        expect(saved.workspace.select.from.table).toBe('c');
        expect(saved.versions.map(v => [v.workspace.select.from.table, v.dialect])).toEqual([['b', 'mysql'], ['a', 'postgresql']]);
        // A version is dated when it was saved, not when it was replaced
        expect(saved.versions[1].savedAt).toBe(t.updatedAt);
        expect(saved.versions[0].savedAt).toBe(first.updatedAt);
        // Kept across a reload
        expect(createTemplateStore(createStorage(backend)).get(t.id).versions).toHaveLength(2);
    });

    test('saving the same query again adds no version', () => {
        const { store } = clockedStore();
        const t = store.create('Report', query('a'));
        const saved = store.update(t.id, query('a'), { dialect: 'mysql' });
        expect(saved.keptVersion).toBe(false);
        expect(store.get(t.id).versions).toBeUndefined();
        expect(store.get(t.id).dialect).toBe('mysql');
    });

    test(`keeps at most ${TEMPLATE_VERSION_LIMIT} per template and ${TEMPLATE_VERSIONS_TOTAL} in all, dropping the oldest`, () => {
        const { store } = clockedStore();
        const t = store.create('Report', query('t0'));
        for (let i = 1; i <= 14; i++) store.update(t.id, query(`t${i}`));
        expect(store.get(t.id).versions.map(v => v.workspace.select.from.table)).toEqual(['t13', 't12', 't11', 't10', 't9', 't8', 't7', 't6', 't5', 't4']);

        const many = clockedStore().store;
        const ids = Array.from({ length: 31 }, (_, n) => many.create(`T${n}`, query(`q${n}_0`)).id);
        for (let round = 1; round <= TEMPLATE_VERSION_LIMIT; round++) {
            for (const [n, id] of ids.entries()) many.update(id, query(`q${n}_${round}`));
        }
        const all = many.list().flatMap(x => x.versions || []);
        expect(all).toHaveLength(TEMPLATE_VERSIONS_TOTAL);
        // The 10 oldest (round 0 of the first 10 templates) went first
        expect(many.list().filter(x => x.versions.length < TEMPLATE_VERSION_LIMIT).map(x => x.name).sort()).toEqual(['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9']);
    });

    test('restoring a version keeps the replaced query as a version', () => {
        const { store } = clockedStore();
        const t = store.create('Report', query('a'), { dialect: 'postgresql' });
        store.update(t.id, query('b'));
        store.update(t.id, query('c'), { dialect: 'sqlserver' });
        const restored = store.restoreVersion(t.id, 1);
        expect(restored.workspace.select.from.table).toBe('a');
        expect(restored.dialect).toBe('postgresql');
        expect(restored.versions.map(v => v.workspace.select.from.table)).toEqual(['c', 'b']);
        // Restoring is itself undone the same way
        expect(store.restoreVersion(t.id, 0).workspace.select.from.table).toBe('c');
        expect(store.get(t.id).versions.map(v => v.workspace.select.from.table)).toEqual(['a', 'b']);
        // A version saved without a dialect restores without one
        const plain = store.create('Plain', query('x'));
        store.update(plain.id, query('y'), { dialect: 'mysql' });
        expect(store.restoreVersion(plain.id, 0).dialect).toBeUndefined();
        expect(() => store.restoreVersion(t.id, 9)).toThrow(TemplateError);
    });

    test('a version can be deleted', () => {
        const { store } = clockedStore();
        const t = store.create('Report', query('a'));
        store.update(t.id, query('b'));
        store.update(t.id, query('c'));
        store.deleteVersion(t.id, 0);
        expect(store.get(t.id).versions.map(v => v.workspace.select.from.table)).toEqual(['a']);
        store.deleteVersion(t.id, 0);
        expect(store.get(t.id).versions).toBeUndefined();
        expect(() => store.deleteVersion(t.id, 0)).toThrow(TemplateError);
    });

    test('a full browser storage still saves, without the previous version', () => {
        const backend = createMemoryBackend();
        const { store } = clockedStore(backend);
        const t = store.create('Report', query('a'));
        store.update(t.id, query('b'));
        // Refuse anything bigger than what is stored now plus a little
        const limit = backend.getItem(`${STORAGE_PREFIX}templates`).length + 50;
        const setItem = backend.setItem;
        backend.setItem = (key, value) => {
            if (value.length > limit) throw new Error('QuotaExceededError');
            setItem(key, value);
        };
        const saved = store.update(t.id, query('cc'));
        expect(saved.keptVersion).toBe(false);
        expect(store.get(t.id).workspace.select.from.table).toBe('cc');
        expect(store.get(t.id).versions.map(v => v.workspace.select.from.table)).toEqual(['a']);
    });

    test('duplicates and templates files leave versions out', () => {
        const { store } = clockedStore();
        const t = store.create('Report', query('a'));
        store.update(t.id, query('b'));
        expect(store.duplicate(t.id).versions).toBeUndefined();
        const file = createTemplatesExport(store.list());
        expect(JSON.stringify(file)).not.toContain('versions');
        const parsed = parseTemplatesFile(JSON.stringify({ ...file, templates: [{ ...file.templates[0], versions: [{ savedAt: 5, workspace: query('z') }] }] }));
        expect(parsed.ok && parsed.templates[0].versions).toBeUndefined();
    });

    test('a full backup keeps versions, and restoring brings them back', () => {
        const { store } = clockedStore();
        const t = store.create('Report', query('a'), { dialect: 'mysql' });
        store.update(t.id, query('b'));
        const text = JSON.stringify(createBackup({ templates: store.list(), history: [], settings: DEFAULT_SETTINGS }));
        const parsed = parseBackupFile(text);
        expect(parsed.ok).toBe(true);
        expect(parsed.templates[0].versions).toEqual([{ savedAt: t.updatedAt, dialect: 'mysql', workspace: query('a') }]);
        const other = clockedStore().store;
        other.restore(parsed.templates);
        expect(other.list()[0].versions.map(v => v.workspace.select.from.table)).toEqual(['a']);
    });
});

describe('stored and imported versions are untrusted', () => {
    test('damaged versions are left out, the template is kept', () => {
        const good = { savedAt: 2000, dialect: 'postgresql', workspace: query('good') };
        expect(readVersions([
            good,
            { savedAt: 3000, workspace: { type: 'select', select: 'not a query' } },
            { savedAt: 'yesterday', workspace: query('x') },
            { savedAt: -5, workspace: query('x') },
            { savedAt: 4000, workspace: { ...query('newer'), version: 99 } },
            { savedAt: 1000, dialect: 'oracle', workspace: query('old') },
            null, 7, 'text'
        ])).toEqual([good, { savedAt: 1000, workspace: query('old') }]);
        expect(readVersions('nope')).toEqual([]);
        expect(readVersions(Array.from({ length: 30 }, (_, i) => ({ savedAt: i + 1, workspace: query(`v${i}`) }))).map(v => v.savedAt))
            .toEqual([30, 29, 28, 27, 26, 25, 24, 23, 22, 21]);

        const backend = createMemoryBackend({
            [`${STORAGE_PREFIX}templates`]: JSON.stringify([{ id: 'x', name: 'Kept', createdAt: 1, updatedAt: 2, workspace: query('a'), versions: [{ savedAt: 1, workspace: '<script>' }, { savedAt: 1, workspace: query('b') }] }])
        });
        const loaded = createTemplateStore(createStorage(backend)).get('x');
        expect(loaded.name).toBe('Kept');
        expect(loaded.versions.map(v => v.workspace.select.from.table)).toEqual(['b']);
    });

    test('a backup with a damaged version still restores the template', () => {
        const file = JSON.parse(JSON.stringify(createBackup({ templates: [], history: [], settings: DEFAULT_SETTINGS })));
        file.templates = [{ name: 'R', workspace: query('a'), versions: [{ savedAt: 9, workspace: 42 }, { savedAt: 8, workspace: query('b') }] }];
        const parsed = parseBackupFile(JSON.stringify(file));
        expect(parsed.ok).toBe(true);
        expect(parsed.templates[0].versions).toEqual([{ savedAt: 8, workspace: query('b') }]);
    });
});
