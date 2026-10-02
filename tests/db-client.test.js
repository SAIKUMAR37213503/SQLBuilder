// The database list, the operation dispatcher, and both engine clients.
import { beforeAll, describe, expect, test, vi } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createSqliteAdapter } from '../src/db/sqlite-adapter.js';
import { createMemoryFiles } from '../src/db/files.js';
import { dispatch, OPERATION_NAMES, serializeError, deserializeError } from '../src/db/dispatch.js';
import { createDirectClient, createWorkerClient } from '../src/db/client.js';
import { createDatabaseList, DatabaseListError, DATABASE_LIMIT, DATABASE_NAME_MAX, cleanDatabaseName } from '../src/db/databases.js';
import { DatabaseError } from '../src/db/engine.js';
import { createStorage, createMemoryBackend, STORAGE_PREFIX } from '../src/storage.js';

let sqlite3;
beforeAll(async () => {
    sqlite3 = await sqlite3InitModule();
});

describe('database list', () => {
    const setup = (initial = {}) => {
        const backend = createMemoryBackend(initial);
        let time = 1000;
        return { backend, list: createDatabaseList(createStorage(backend), { now: () => (time += 1000) }) };
    };

    test('add, rename, touch, remove; kept in one app-wide key', () => {
        const { backend, list } = setup();
        expect(list.list()).toEqual([]);
        const prepared = list.prepare('  Company   DB ');
        expect(prepared.name).toBe('Company DB');
        expect(list.size).toBe(0);
        const entry = list.add(prepared);
        expect(entry).toMatchObject({ name: 'Company DB', createdAt: 2000, updatedAt: 2000 });
        list.touch(entry.id);
        expect(list.get(entry.id).updatedAt).toBe(3000);
        list.rename(entry.id, 'Shop');
        expect(list.list().map(e => e.name)).toEqual(['Shop']);
        expect(JSON.parse(backend.getItem(`${STORAGE_PREFIX}databases`)).databases).toHaveLength(1);
        list.setLastOpen(entry.id);
        expect(list.lastOpen).toBe(entry.id);
        list.remove(entry.id);
        expect(list.lastOpen).toBeNull();
        expect(backend.getItem(`${STORAGE_PREFIX}databases`)).toBeNull();
    });

    test('names are unique ignoring case, required and limited', () => {
        const { list } = setup();
        list.add(list.prepare('Company DB'));
        expect(() => list.prepare('company db')).toThrow(/already exists/);
        expect(() => list.prepare('   ')).toThrow(DatabaseListError);
        expect(() => cleanDatabaseName('x'.repeat(DATABASE_NAME_MAX + 1))).toThrow(/at most/);
    });

    test('there is a limit on how many databases', () => {
        const { list } = setup();
        for (let i = 0; i < DATABASE_LIMIT; i++) list.add(list.prepare(`DB ${i}`));
        expect(() => list.prepare('One more')).toThrow(/up to 50/);
    });

    test('copy names count up and stay within the limit', () => {
        const { list } = setup();
        list.add(list.prepare('Company DB'));
        expect(list.copyName('Company DB')).toBe('Company DB (copy)');
        list.add(list.prepare('Company DB (copy)'));
        expect(list.copyName('Company DB')).toBe('Company DB (copy 2)');
        expect(list.copyName('x'.repeat(60))).toHaveLength(60);
    });

    test('stored data is read as untrusted', () => {
        const value = {
            lastOpen: 'gone-id',
            databases: [
                { id: 'good1', name: 'Good', createdAt: 5, updatedAt: 9 },
                { id: '../bad', name: 'Bad id' },
                { id: 'dup1', name: 'good' },
                { id: 'good1', name: 'Same id' },
                { id: 'noname1', name: '' },
                null, 'text',
                { id: 'times1', name: 'Times', createdAt: 'yesterday', updatedAt: -1 }
            ]
        };
        const { list } = setup({ [`${STORAGE_PREFIX}databases`]: JSON.stringify(value) });
        expect(list.list()).toEqual([
            { id: 'good1', name: 'Good', createdAt: 5, updatedAt: 9 },
            { id: 'times1', name: 'Times', createdAt: 0, updatedAt: 0 }
        ]);
        expect(list.lastOpen).toBeNull();
    });

    test('clear empties the list', () => {
        const { backend, list } = setup();
        list.add(list.prepare('A'));
        list.clear();
        expect(list.size).toBe(0);
        expect(backend.getItem(`${STORAGE_PREFIX}databases`)).toBeNull();
    });

    test('a full storage is reported', () => {
        const storage = { available: true, get: () => null, set: () => false, remove() {} };
        const list = createDatabaseList(storage);
        expect(() => list.add(list.prepare('A'))).toThrow(/storage is full/);
    });
});

describe('dispatch', () => {
    test('only known operations run', async () => {
        const adapter = createSqliteAdapter(sqlite3, createMemoryFiles(sqlite3));
        await expect(dispatch(adapter, 'constructor')).rejects.toMatchObject({ code: 'BAD_OPERATION' });
        await expect(dispatch(adapter, 'destroy')).rejects.toMatchObject({ code: 'BAD_OPERATION' });
        expect(OPERATION_NAMES).toContain('execute');
        expect((await dispatch(adapter, 'info')).engine).toBe('SQLite');
    });

    test('errors travel as plain data and come back as DatabaseErrors', () => {
        const data = serializeError(new DatabaseError('no such table: x', { code: 'SQLITE_ERROR', line: 2, column: 5, statement: 1 }));
        expect(data).toEqual({ message: 'no such table: x', code: 'SQLITE_ERROR', line: 2, column: 5, statement: 1 });
        expect(structuredClone(data)).toEqual(data);
        const back = deserializeError(data);
        expect(back).toBeInstanceOf(DatabaseError);
        expect(back).toMatchObject({ message: 'no such table: x', code: 'SQLITE_ERROR', line: 2 });
        expect(serializeError('text')).toEqual({ message: 'text', code: 'ERROR' });
    });
});

describe('direct client', () => {
    test('runs operations and returns copies', async () => {
        const changes = [];
        const client = createDirectClient(() => createSqliteAdapter(sqlite3, createMemoryFiles(sqlite3)), { onChange: s => changes.push(s.status) });
        const info = await client.start();
        expect(info).toMatchObject({ engine: 'SQLite', persistent: false, storageReason: null });
        await client.call('create', { id: 'company1' });
        const run = await client.call('execute', { sql: 'SELECT 1 AS one' });
        expect(run.results[0].rows).toEqual([[1]]);
        expect(changes).toEqual(['starting', 'ready']);
        await expect(client.call('open', { id: 'missing1' })).rejects.toBeInstanceOf(DatabaseError);
    });
});

/** A stand-in Worker that answers with the real engine, asynchronously. */
function fakeWorkerFactory({ failInit = false } = {}) {
    const created = [];
    const factory = () => {
        const adapter = createSqliteAdapter(sqlite3, createMemoryFiles(sqlite3));
        const worker = {
            onmessage: null,
            onerror: null,
            terminated: false,
            messages: [],
            postMessage(message) {
                worker.messages.push(message);
                const { id, op, args } = message;
                setTimeout(async () => {
                    if (worker.terminated) return;
                    try {
                        if (op === 'init') {
                            if (failInit) throw new Error('CompileError: WebAssembly.instantiate(): Refused to compile');
                            worker.onmessage({ data: { id, ok: true, value: { ...adapter.info(), storageReason: null } } });
                        } else if (op === 'hang') {
                            // never answers
                        } else {
                            worker.onmessage({ data: { id, ok: true, value: structuredClone(await dispatch(adapter, op, args)) } });
                        }
                    } catch (error) {
                        worker.onmessage({ data: { id, ok: false, error: serializeError(error) } });
                    }
                }, 0);
            },
            terminate() {
                worker.terminated = true;
            }
        };
        created.push(worker);
        return worker;
    };
    return { factory, created };
}

describe('worker client', () => {
    test('starts the worker on first use, with the wasm URL, and runs operations', async () => {
        const { factory, created } = fakeWorkerFactory();
        const client = createWorkerClient({ createWorker: factory, wasmUrl: 'dist/sqlite3.wasm?v=abc' });
        expect(created).toHaveLength(0);
        expect(client.state.status).toBe('idle');
        await client.call('create', { id: 'company1' });
        expect(created).toHaveLength(1);
        expect(created[0].messages[0]).toMatchObject({ op: 'init', args: { wasmUrl: 'dist/sqlite3.wasm?v=abc' } });
        expect(client.state).toMatchObject({ status: 'ready', info: { engine: 'SQLite' } });
        const run = await client.call('execute', { sql: 'SELECT 2 AS two' });
        expect(run.results[0].rows).toEqual([[2]]);
        const error = await client.call('execute', { sql: 'SELECT * FROM nope' }).then(r => r.error);
        expect(error.message).toBe('no such table: nope');
        expect(created).toHaveLength(1);
    });

    test('engine errors are rejected as DatabaseErrors', async () => {
        const { factory } = fakeWorkerFactory();
        const client = createWorkerClient({ createWorker: factory, wasmUrl: 'x' });
        await expect(client.call('open', { id: 'missing1' })).rejects.toMatchObject({ name: 'DatabaseError', code: 'MISSING' });
    });

    test('restart stops a running operation and starts a new worker', async () => {
        const { factory, created } = fakeWorkerFactory();
        const client = createWorkerClient({ createWorker: factory, wasmUrl: 'x' });
        await client.start();
        const hanging = client.call('hang');
        await new Promise(r => setTimeout(r, 5));
        const restarted = client.restart();
        await expect(hanging).rejects.toMatchObject({ code: 'STOPPED' });
        await restarted;
        expect(created[0].terminated).toBe(true);
        expect(created).toHaveLength(2);
        expect(client.state.status).toBe('ready');
        expect(created[0].messages[0].args.waitMs).toBe(0);
        expect(created[1].messages[0].args.waitMs).toBe(0);
    });

    test('a restart after stopping a query waits for the old worker to let go of the files', async () => {
        const { factory, created } = fakeWorkerFactory();
        const client = createWorkerClient({ createWorker: factory, wasmUrl: 'x' });
        await client.start();
        const hanging = client.call('hang');
        await new Promise(r => setTimeout(r, 5));
        const restarted = client.restart({ waitForFiles: true });
        await expect(hanging).rejects.toMatchObject({ code: 'STOPPED' });
        await restarted;
        expect(created[1].messages[0]).toMatchObject({ op: 'init', args: { waitMs: 10000 } });
        await client.restart();
        expect(created[2].messages[0].args.waitMs).toBe(0);
    });

    test('a failed start is reported and stays failed until restart', async () => {
        const { factory, created } = fakeWorkerFactory({ failInit: true });
        const changes = vi.fn();
        const client = createWorkerClient({ createWorker: factory, wasmUrl: 'x', onChange: changes });
        await expect(client.call('info')).rejects.toThrow(/Refused to compile/);
        expect(client.state).toMatchObject({ status: 'failed', error: expect.stringMatching(/Refused to compile/) });
        await expect(client.call('info')).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
        expect(created).toHaveLength(1);
        expect(created[0].terminated).toBe(true);
    });

    test('a worker that can\'t be created is reported', async () => {
        const client = createWorkerClient({ createWorker: () => { throw new Error('Workers are blocked'); }, wasmUrl: 'x' });
        await expect(client.call('info')).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
        expect(client.state).toMatchObject({ status: 'failed', error: 'Workers are blocked' });
    });

    test('a worker crash fails what was waiting', async () => {
        const { factory, created } = fakeWorkerFactory();
        const client = createWorkerClient({ createWorker: factory, wasmUrl: 'x' });
        await client.start();
        const hanging = client.call('hang');
        await new Promise(r => setTimeout(r, 5));
        created[0].onerror({ message: 'out of memory', preventDefault() {} });
        await expect(hanging).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
        expect(client.state).toMatchObject({ status: 'failed', error: 'out of memory' });
    });
});
