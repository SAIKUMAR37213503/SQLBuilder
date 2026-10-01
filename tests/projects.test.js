import { describe, expect, test } from 'vitest';
import { createProjectStore, projectStorage, projectCounts, ProjectError, MAIN_PROJECT, PROJECT_LIMIT, PROJECT_KEYS } from '../src/projects.js';
import { createStorage, createMemoryBackend, STORAGE_PREFIX } from '../src/storage.js';
import { createTemplateStore } from '../src/templates.js';
import { createHistory } from '../src/history.js';
import { createSchemaStore } from '../src/schema.js';
import { createWorkspace } from '../src/model.js';
import { createBackup, parseBackupFile, BACKUP_VERSION, BACKUP_VERSION_PROJECTS } from '../src/serialization.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';

const setup = (initial = {}) => {
    const backend = createMemoryBackend(initial);
    const storage = createStorage(backend);
    return { backend, storage, store: createProjectStore(storage) };
};

const keys = (backend, prefix = STORAGE_PREFIX) => {
    const out = [];
    // createMemoryBackend has no key listing: read through getItem for the known keys
    for (const key of ['projects', ...PROJECT_KEYS]) if (backend.getItem(prefix + key) !== null) out.push(key);
    return out;
};

function query(table) {
    const ws = createWorkspace('select');
    ws.select.from.table = table;
    ws.select.columns[0].expr = 'id';
    return ws;
}

describe('project list', () => {
    test('starts with Main only, and stores nothing until something changes', () => {
        const { store, backend } = setup();
        expect(store.list()).toEqual([{ id: MAIN_PROJECT, name: 'Main', createdAt: 0 }]);
        expect(store.active).toBe(MAIN_PROJECT);
        expect(backend.size).toBe(0);
    });

    test('creates, renames, opens and deletes projects, Main first then by name', () => {
        const { store, storage } = setup();
        const b = store.create('  Billing   DB ', { dialect: 'sqlserver' });
        const a = store.create('analytics');
        expect(store.list().map(p => p.name)).toEqual(['Main', 'analytics', 'Billing DB']);
        expect(b.dialect).toBe('sqlserver');
        expect(() => store.create('BILLING db')).toThrow('A project named Billing DB already exists.');
        expect(() => store.create('  ')).toThrow(ProjectError);
        expect(() => store.create('x'.repeat(61))).toThrow(/at most 60/);
        store.rename(a.id, 'Analytics');
        store.setActive(a.id);
        store.setDialect(a.id, 'postgresql');
        store.setDialect(a.id, 'not-a-dialect');
        const again = createProjectStore(storage);
        expect(again.active).toBe(a.id);
        expect(again.get(a.id)).toMatchObject({ name: 'Analytics', dialect: 'postgresql' });
        expect(() => again.remove(MAIN_PROJECT)).toThrow('The Main project can\'t be deleted.');
        again.remove(a.id);
        expect(again.active).toBe(MAIN_PROJECT);
        expect(again.list().map(p => p.name)).toEqual(['Main', 'Billing DB']);
        expect(() => again.setActive(a.id)).toThrow(ProjectError);
    });

    test(`allows up to ${PROJECT_LIMIT} projects`, () => {
        const { store } = setup();
        for (let i = 1; i < PROJECT_LIMIT; i++) store.create(`P${i}`);
        expect(() => store.create('One more')).toThrow(`You can have up to ${PROJECT_LIMIT} projects.`);
    });

    test('reads stored data as untrusted', () => {
        const stored = {
            active: 'gone',
            projects: [
                { id: 'ok-1', name: 'Good', createdAt: 5, dialect: 'mysql' },
                { id: '../etc', name: 'Bad id' },
                { id: 'ok-2', name: '' },
                { id: 'ok-3', name: 'good' },
                { id: 'ok-1', name: 'Duplicate id' },
                { id: 'ok-4', name: 'Odd dialect', dialect: '<b>', createdAt: 'yesterday' },
                null, 'text'
            ]
        };
        const { store } = setup({ [`${STORAGE_PREFIX}projects`]: JSON.stringify(stored) });
        expect(store.list()).toEqual([
            { id: MAIN_PROJECT, name: 'Main', createdAt: 0 },
            { id: 'ok-1', name: 'Good', createdAt: 5, dialect: 'mysql' },
            { id: 'ok-4', name: 'Odd dialect', createdAt: 0 }
        ]);
        expect(store.active).toBe(MAIN_PROJECT);
        for (const raw of ['[1,2]', 'not json', '{"projects":"x"}']) {
            expect(setup({ [`${STORAGE_PREFIX}projects`]: raw }).store.list().map(p => p.id)).toEqual([MAIN_PROJECT]);
        }
        // A stored project named Main that isn't Main doesn't hide the real one
        const named = setup({ [`${STORAGE_PREFIX}projects`]: JSON.stringify({ projects: [{ id: 'x1', name: 'Main' }] }) }).store;
        expect(named.list().map(p => [p.id, p.name])).toEqual([[MAIN_PROJECT, 'Main (1)'], ['x1', 'Main']]);
    });
});

describe('project data', () => {
    test('Main keeps the keys from before projects; other projects get their own', () => {
        const { store, storage, backend } = setup();
        const other = store.create('Other');
        createTemplateStore(projectStorage(storage, MAIN_PROJECT)).create('In main', query('a'));
        const otherTemplates = createTemplateStore(store.storageFor(other.id));
        otherTemplates.create('In other', query('b'));
        createHistory(store.storageFor(other.id)).add({ type: 'select', dialect: 'generic', sql: 'SELECT id FROM b;', workspace: query('b') });
        createSchemaStore(store.storageFor(other.id)).save({ name: 'b', columns: [{ name: 'id' }] });

        expect(JSON.parse(backend.getItem(`${STORAGE_PREFIX}templates`)).map(t => t.name)).toEqual(['In main']);
        expect(keys(backend, `${STORAGE_PREFIX}p.${other.id}.`)).toEqual(['templates', 'history', 'schema']);
        // An older copy of the app reads Main's templates as before
        expect(createTemplateStore(storage).list().map(t => t.name)).toEqual(['In main']);
        expect(projectCounts(store.storageFor(other.id))).toEqual({ templates: 1, history: 1, tables: 1 });
        expect(projectCounts(store.storageFor(MAIN_PROJECT))).toEqual({ templates: 1, history: 0, tables: 0 });

        // Deleting a project deletes its data and nothing else
        store.remove(other.id);
        expect(keys(backend, `${STORAGE_PREFIX}p.${other.id}.`)).toEqual([]);
        expect(createTemplateStore(storage).list()).toHaveLength(1);
    });

    test('clear removes every other project and its data', () => {
        const { store, backend } = setup();
        const a = store.create('A');
        createTemplateStore(store.storageFor(a.id)).create('T', query('x'));
        store.setActive(a.id);
        store.clear();
        expect(store.list().map(p => p.id)).toEqual([MAIN_PROJECT]);
        expect(store.active).toBe(MAIN_PROJECT);
        expect(keys(backend, `${STORAGE_PREFIX}p.${a.id}.`)).toEqual([]);
        expect(backend.getItem(`${STORAGE_PREFIX}projects`)).toBe(null);
    });
});

describe('backups with projects', () => {
    const main = { templates: [], history: [], settings: DEFAULT_SETTINGS, schema: [] };

    test('a backup without other projects stays version 2, readable by older apps', () => {
        const backup = createBackup(main);
        expect(backup.version).toBe(BACKUP_VERSION);
        expect(backup.version).toBe(2);
        expect('projects' in backup).toBe(false);
    });

    test('other projects make it version 3, and they read back', () => {
        const templates = createTemplateStore(createStorage(createMemoryBackend()));
        const t = templates.create('Report', query('a'));
        templates.update(t.id, query('b'));
        const backup = createBackup({
            ...main,
            projects: [{ name: 'Billing', dialect: 'sqlserver', templates: templates.list(), history: [], schema: [{ name: 'inv', columns: [{ name: 'id', type: '', nullable: true }], primaryKey: [], unique: [], foreignKeys: [] }] }]
        });
        expect(backup.version).toBe(BACKUP_VERSION_PROJECTS);
        const parsed = parseBackupFile(JSON.stringify(backup));
        expect(parsed.ok).toBe(true);
        expect(parsed.projects).toHaveLength(1);
        expect(parsed.projects[0]).toMatchObject({ name: 'Billing', dialect: 'sqlserver' });
        expect(parsed.projects[0].templates[0].versions).toHaveLength(1);
        expect(parsed.projects[0].schema.map(s => s.name)).toEqual(['inv']);
        expect(parseBackupFile(JSON.stringify(createBackup(main))).projects).toEqual([]);
    });

    test('projects in a backup are validated', () => {
        const base = JSON.parse(JSON.stringify(createBackup(main)));
        const error = (projects) => {
            const result = parseBackupFile(JSON.stringify({ ...base, version: 3, projects }));
            return result.ok ? null : result.error;
        };
        expect(error('x')).toMatch(/projects must be a list/);
        expect(error([{ name: '' }])).toMatch(/Project 1 has no name/);
        expect(error([{ name: 'A', templates: {} }])).toMatch(/Project “A” is damaged/);
        expect(error([{ name: 'A', templates: [{ name: 'T', workspace: 'nope' }] }])).toMatch(/^Project “A”: Template “T”/);
        expect(error([{ name: 'A' }, { name: 'a' }])).toMatch(/more than one project named “a”/);
        expect(error(Array.from({ length: 21 }, (_, i) => ({ name: `P${i}` })))).toMatch(/too many projects/);
        expect(error([{ name: 'A', dialect: 'oracle' }])).toBe(null);
        const odd = parseBackupFile(JSON.stringify({ ...base, version: 3, projects: [{ name: 'A', dialect: 'oracle' }] }));
        expect(odd.ok && odd.projects[0]).toEqual({ name: 'A', templates: [], history: [], schema: [] });
    });
});
