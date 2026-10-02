// Where database files live. The engine adapter only sees this interface:
//   open(name)          an open oo1 DB on that file (created when missing)
//   save(name, db)      make the latest changes durable (OPFS writes are
//                       already on disk; the memory store keeps a copy)
//   exists(name), remove(name), names()
//   read(name)          the file's bytes (a .sqlite file)
//   write(name, bytes)  replace or create a file from bytes
//   reserve(count)      make room for more files (OPFS pool slots)
//   persistent          false when nothing survives a reload

/**
 * @typedef {{
 *   persistent: boolean,
 *   open: (name: string) => any,
 *   save: (name: string, db: any) => void,
 *   exists: (name: string) => boolean,
 *   remove: (name: string) => void,
 *   read: (name: string) => Uint8Array,
 *   write: (name: string, bytes: Uint8Array) => void,
 *   names: () => string[],
 *   reserve: (count: number) => Promise<void>
 * }} DatabaseFiles
 */

/** The first 16 bytes of every SQLite database file. */
export const SQLITE_HEADER = 'SQLite format 3\u0000';

/** @param {Uint8Array} bytes */
export function isSqliteFile(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 100) return false;
    for (let i = 0; i < SQLITE_HEADER.length; i++) if (bytes[i] !== SQLITE_HEADER.charCodeAt(i)) return false;
    return true;
}

/**
 * Opens bytes as an in-memory database.
 * @param {any} sqlite3
 * @param {Uint8Array | null} bytes
 */
export function deserialize(sqlite3, bytes) {
    const db = new sqlite3.oo1.DB(':memory:', 'c');
    if (bytes && bytes.length) {
        const { capi, wasm } = sqlite3;
        const pointer = wasm.allocFromTypedArray(bytes);
        const rc = capi.sqlite3_deserialize(db.pointer, 'main', pointer, bytes.length, bytes.length,
            capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE);
        db.checkRc(rc);
    }
    return db;
}

/**
 * Files kept in memory: used when the browser can't store files (and in
 * tests, where `save` lets a reopen prove the data was kept).
 * @param {any} sqlite3
 * @returns {DatabaseFiles}
 */
export function createMemoryFiles(sqlite3) {
    /** @type {Map<string, Uint8Array>} */
    const stored = new Map();
    return {
        persistent: false,
        open(name) {
            const db = deserialize(sqlite3, stored.get(name) || null);
            if (!stored.has(name)) stored.set(name, new Uint8Array(0));
            return db;
        },
        save(name, db) {
            stored.set(name, sqlite3.capi.sqlite3_js_db_export(db));
        },
        exists: (name) => stored.has(name),
        remove(name) {
            stored.delete(name);
        },
        read: (name) => (stored.get(name)?.length ? stored.get(name) : sqlite3.capi.sqlite3_js_db_export(deserialize(sqlite3, null))),
        write(name, bytes) {
            stored.set(name, new Uint8Array(bytes));
        },
        names: () => [...stored.keys()],
        async reserve() {}
    };
}

/**
 * Files in the Origin Private File System, through SQLite's "opfs-sahpool"
 * VFS (works without cross-origin isolation). Only usable in a worker.
 * @param {any} pool what installOpfsSAHPoolVfs() resolves to
 * @returns {DatabaseFiles}
 */
export function createOpfsFiles(pool) {
    const path = (/** @type {string} */ name) => `/${name}`;
    return {
        persistent: true,
        open: (name) => new pool.OpfsSAHPoolDb(path(name)),
        save() {},
        exists: (name) => pool.getFileNames().includes(path(name)),
        remove(name) {
            pool.unlink(path(name));
            // Journal files go with it
            for (const file of pool.getFileNames()) if (file.startsWith(`${path(name)}-`)) pool.unlink(file);
        },
        read: (name) => pool.exportFile(path(name)),
        write(name, bytes) {
            pool.importDb(path(name), bytes);
        },
        names: () => pool.getFileNames().map((/** @type {string} */ f) => f.replace(/^\//, '')),
        /** Each open database can need a file for itself and one for its journal. */
        async reserve(count) {
            const free = pool.getCapacity() - pool.getFileCount();
            if (free < count) await pool.addCapacity(count - free + 2);
        }
    };
}
