// The operations a client may ask of the engine, and how errors travel back.
// Shared by the database worker and the in-page client used in tests, so
// both behave the same way.

import { DatabaseError } from './engine.js';
import { previewImport, runImport } from './importer.js';

const OPERATIONS = {
    info: (a) => a.info(),
    create: (a, { id }) => a.create(id),
    open: (a, { id }) => a.open(id),
    close: (a) => a.close(),
    remove: (a, { id }) => a.remove(id),
    removeAll: (a) => a.removeAll(),
    duplicate: (a, { from, to }) => a.duplicate(from, to),
    exportFile: (a, { id }) => a.exportFile(id),
    importFile: (a, { id, bytes }) => a.importFile(id, bytes),
    execute: (a, { sql, pageSize }) => a.execute(sql, { pageSize }),
    fetchPage: (a, { cursor, pageSize }) => a.fetchPage(cursor, { pageSize }),
    closeCursor: (a, { cursor }) => a.closeCursor(cursor),
    schema: (a) => a.schema(),
    countRows: (a, { name }) => a.countRows(name),
    // Reading an import changes nothing; running it is one transaction
    previewImport: (_a, args) => previewImport(args),
    runImport: (a, args) => runImport(a, args)
};

export const OPERATION_NAMES = Object.freeze(Object.keys(OPERATIONS));

/**
 * Runs one operation on an adapter.
 * @param {any} adapter
 * @param {string} op
 * @param {Record<string, any>} [args]
 */
export async function dispatch(adapter, op, args = {}) {
    if (!Object.hasOwn(OPERATIONS, op)) throw new DatabaseError(`Unknown database operation: ${op}`, { code: 'BAD_OPERATION' });
    return OPERATIONS[op](adapter, args && typeof args === 'object' ? args : {});
}

/** An error as plain data that can be posted between threads. */
export function serializeError(error) {
    const e = /** @type {any} */ (error);
    const out = { message: e instanceof Error ? e.message : String(e), code: e?.code || 'ERROR' };
    for (const key of ['line', 'column', 'statement', 'row']) if (typeof e?.[key] === 'number') out[key] = e[key];
    return out;
}

/** @param {any} data */
export const deserializeError = (data) => new DatabaseError(String(data?.message || 'The database engine failed.'), data || {});
