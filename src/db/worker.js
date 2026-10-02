// The database worker: runs SQLite off the page's main thread, so a long
// query never freezes the app. Databases are stored in the Origin Private
// File System when the browser allows it, otherwise only in memory (and the
// app says so). Messages: { id, op, args } in, { id, ok, value | error } out.
// The first message must be { id, op: 'init', args: { wasmUrl } }.

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createSqliteAdapter } from './sqlite-adapter.js';
import { createMemoryFiles, createOpfsFiles } from './files.js';
import { dispatch, serializeError } from './dispatch.js';

const LOCK_NAME = 'sqlbuilder-databases';
const DIRECTORY = '.sqlbuilder-databases';

/** @type {Promise<{ adapter: any, storage: { persistent: boolean, reason: string | null } }> | null} */
let ready = null;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Takes the databases lock and keeps it for this worker's lifetime (the
 * browser releases it when the worker or its tab goes away). Only one tab
 * can use the database files at a time; false means another tab has them.
 */
function takeLock() {
    const locks = /** @type {any} */ (self.navigator)?.locks;
    if (!locks) return Promise.resolve(true);
    return new Promise((resolve) => {
        locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
            resolve(Boolean(lock));
            return lock ? new Promise(() => {}) : undefined;
        }).catch(() => resolve(false));
    });
}

/**
 * Whether every database file can be opened right now. A worker that was
 * just stopped (Try again, or cancelling a long query) can hold its files
 * for a moment after it ends.
 *
 * This matters beyond a clear message: when SQLite's storage pool fails to
 * start, its clean-up tries to delete the pool's directory. That only fails
 * while another worker holds the files, so the pool must never be started
 * unless all of them are free.
 */
async function filesFree() {
    let root;
    try {
        root = await navigator.storage.getDirectory();
    } catch {
        return true; // no file storage at all: the pool reports that itself
    }
    let directory;
    try {
        directory = await root.getDirectoryHandle(DIRECTORY);
    } catch {
        return true; // nothing stored yet
    }
    const files = [];
    const walk = async (dir) => {
        for await (const handle of /** @type {any} */ (dir).values()) {
            if (handle.kind === 'directory') await walk(handle);
            else files.push(handle);
        }
    };
    try {
        await walk(directory);
        for (const file of files) (await file.createSyncAccessHandle()).close();
        return true;
    } catch {
        return false;
    }
}

async function openStorage(sqlite3) {
    // A tab that was just closed can hold the lock for a moment
    let locked = await takeLock();
    for (let attempt = 1; !locked && attempt <= 5; attempt++) {
        await sleep(100 * attempt);
        locked = await takeLock();
    }
    if (!locked) return { files: createMemoryFiles(sqlite3), reason: 'busy' };
    let free = await filesFree();
    for (let attempt = 1; !free && attempt <= 8; attempt++) {
        await sleep(100 * attempt);
        free = await filesFree();
    }
    if (!free) return { files: createMemoryFiles(sqlite3), reason: 'busy' };
    try {
        const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'sqlbuilder-pool', directory: DIRECTORY, initialCapacity: 6 });
        return { files: createOpfsFiles(pool), reason: null };
    } catch {
        return { files: createMemoryFiles(sqlite3), reason: 'unsupported' };
    }
}

async function start(wasmUrl) {
    // The package's types omit the options the module factory accepts
    const sqlite3 = await /** @type {any} */ (sqlite3InitModule)({
        // The wasm file comes from this app's own origin, never a CDN
        locateFile: () => wasmUrl,
        print: () => {},
        printErr: () => {}
    });
    const { files, reason } = await openStorage(sqlite3);
    return { adapter: createSqliteAdapter(sqlite3, files), storage: { persistent: files.persistent, reason } };
}

self.onmessage = async (event) => {
    const { id, op, args } = event.data || {};
    try {
        let value;
        if (op === 'init') {
            ready ||= start(String(args?.wasmUrl || ''));
            const { adapter, storage } = await ready;
            value = { ...adapter.info(), storageReason: storage.reason };
        } else {
            if (!ready) throw new Error('The database engine was not started.');
            const { adapter } = await ready;
            value = await dispatch(adapter, op, args);
        }
        const transfer = value instanceof Uint8Array ? [value.buffer] : [];
        self.postMessage({ id, ok: true, value }, { transfer });
    } catch (error) {
        self.postMessage({ id, ok: false, error: serializeError(error) });
    }
};
