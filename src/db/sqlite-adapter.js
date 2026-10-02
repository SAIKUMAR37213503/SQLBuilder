// The SQLite implementation of the engine contract (engine.js). It runs
// wherever the sqlite3 module runs: in the browser's database worker, and in
// Node for tests. One database is open at a time.
//
// A script runs one statement at a time, each prepared just before it runs,
// so a statement can use a table an earlier one created. Results come back a
// page at a time; nothing is counted or timed that the engine didn't report.

import { DatabaseError, databaseFileName, isDatabaseId, positionAt } from './engine.js';
import { isSqliteFile } from './files.js';

export const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;
const MAX_CURSORS = 4;
// Statements that would start or end the import's own transaction (ROLLBACK TO a savepoint is fine)
const ENDS_TRANSACTION = /^(?:BEGIN|COMMIT|END|START\s+TRANSACTION)\b|^ROLLBACK\b(?!\s+(?:TRANSACTION\s+)?TO\b)/i;

/** What a statement does, from its first keyword. */
export function statementKind(sql) {
    const word = /^\s*(?:(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)\s*)*([a-z]+)/i.exec(String(sql))?.[1]?.toUpperCase() || '';
    if (['SELECT', 'VALUES', 'EXPLAIN', 'PRAGMA'].includes(word)) return 'query';
    if (['INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(word)) return 'modify';
    if (['CREATE', 'DROP', 'ALTER'].includes(word)) return 'schema';
    if (['BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE'].includes(word)) return 'transaction';
    if (word === 'WITH') return 'with';
    return 'other';
}

/** A value as it can be shown: BLOBs become their size. */
const cell = (/** @type {unknown} */ value) => (value instanceof Uint8Array ? { blob: value.length } : value);

const clampPage = (/** @type {unknown} */ size) => Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(Number(size)) || DEFAULT_PAGE_SIZE));

/** Removes the "SQLITE_ERROR: sqlite3 result code 1:" prefix from engine messages. */
export function cleanMessage(message) {
    const raw = String(message ?? '');
    const match = /^(SQLITE_[A-Z_]+):\s*(?:sqlite3 result code \d+:\s*)?/.exec(raw);
    return { message: match ? raw.slice(match[0].length) : raw, code: match ? match[1] : 'ERROR' };
}

/**
 * @param {any} sqlite3 an initialised sqlite3 module
 * @param {import('./files.js').DatabaseFiles} files
 * @param {{ now?: () => number }} [options]
 */
export function createSqliteAdapter(sqlite3, files, { now = () => performance.now() } = {}) {
    const { capi, wasm } = sqlite3;
    /** @type {{ id: string, db: any } | null} */
    let current = null;
    /** @type {Map<number, { stmt: any, columns: string[], pending: unknown[] | null }>} */
    const cursors = new Map();
    let nextCursor = 1;

    function checkId(id) {
        if (!isDatabaseId(id)) throw new DatabaseError('That database id isn\'t valid.', { code: 'BAD_ID' });
        return databaseFileName(id);
    }

    function requireOpen() {
        if (!current) throw new DatabaseError('No database is open.', { code: 'NOT_OPEN' });
        return current;
    }

    function requireNoTransaction() {
        if (capi.sqlite3_get_autocommit(current.db.pointer) === 0) {
            throw new DatabaseError('A transaction is open in this database. Finish it (COMMIT or ROLLBACK) before importing.', { code: 'IN_TRANSACTION' });
        }
    }

    function requireFile(id) {
        const name = checkId(id);
        if (!files.exists(name)) throw new DatabaseError('This database\'s data is missing from this browser.', { code: 'MISSING' });
        return name;
    }

    function dropCursor(id) {
        const cursor = cursors.get(id);
        if (!cursor) return;
        cursors.delete(id);
        try {
            cursor.stmt.finalize();
        } catch {
            // the database was closed underneath it
        }
    }

    function closeCursors() {
        for (const id of [...cursors.keys()]) dropCursor(id);
    }

    function saveCurrent() {
        if (current) files.save(databaseFileName(current.id), current.db);
    }

    function closeCurrent() {
        if (!current) return;
        closeCursors();
        const { db } = current;
        try {
            // An unfinished transaction is rolled back, as when a server connection closes
            if (capi.sqlite3_get_autocommit(db.pointer) === 0) db.exec('ROLLBACK;');
            saveCurrent();
        } finally {
            db.close();
            current = null;
        }
    }

    function openFile(id) {
        const db = files.open(databaseFileName(id));
        try {
            // Foreign keys are enforced, as on the database servers the app writes SQL for
            db.exec('PRAGMA foreign_keys = ON;');
        } catch (error) {
            db.close();
            throw error;
        }
        current = { id, db };
    }

    const readRow = (stmt) => stmt.get([]).map(cell);

    /** Up to `size` rows, plus the row after them when there is one. */
    function readPage(stmt, size, first = null) {
        const rows = first ? [first] : [];
        while (rows.length < size && stmt.step()) rows.push(readRow(stmt));
        const next = rows.length === size && stmt.step() ? readRow(stmt) : null;
        return { rows, next };
    }

    function keepCursor(stmt, columns, pending) {
        while (cursors.size >= MAX_CURSORS) dropCursor(cursors.keys().next().value);
        const id = nextCursor++;
        cursors.set(id, { stmt, columns, pending });
        return id;
    }

    /**
     * Runs one statement and describes its result.
     * @param {string} text
     * @param {number} size
     * @param {boolean} keep keep unread rows for fetchPage (only the script's last statement)
     */
    function runStatement(text, size, keep) {
        const { db } = current;
        const started = now();
        const stmt = db.prepare(text);
        let finalize = true;
        try {
            let kind = statementKind(text);
            if (kind === 'with' || kind === 'other') kind = capi.sqlite3_stmt_readonly(stmt.pointer) ? (stmt.columnCount ? 'query' : 'other') : 'modify';
            const columns = stmt.columnCount ? stmt.getColumnNames([]) : [];
            /** @type {any} */
            const result = { sql: text.trim(), kind, columns, rows: [], more: false, cursor: null, rowsAffected: null };
            if (columns.length) {
                const page = readPage(stmt, size);
                result.rows = page.rows;
                if (page.next) {
                    result.more = true;
                    if (keep && kind === 'query') {
                        result.cursor = keepCursor(stmt, columns, page.next);
                        finalize = false;
                    } else {
                        // A change (RETURNING) or an earlier statement: finish it, show the first page
                        while (stmt.step()) { /* run to completion */ }
                    }
                }
            } else {
                stmt.step();
            }
            if (kind === 'modify') result.rowsAffected = capi.sqlite3_changes(db.pointer);
            result.durationMs = Math.max(0, now() - started);
            return result;
        } finally {
            if (finalize) stmt.finalize();
        }
    }

    /**
     * Finds the statement starting at `offset` by preparing it (without running it).
     * Returns its text and end, an error, `{ skip }` for an empty statement, or null at the end.
     * @param {Uint8Array} bytes
     * @param {number} offset
     */
    function nextStatement(bytes, offset) {
        if (offset >= bytes.length) return null;
        const pDb = current.db.pointer;
        const stack = wasm.scopedAllocPush();
        try {
            const length = bytes.length - offset;
            const ppStmt = wasm.scopedAlloc(2 * wasm.ptr.size + length + 1);
            const pzTail = wasm.ptr.add(ppStmt, wasm.ptr.size);
            const pSql = wasm.ptr.add(pzTail, wasm.ptr.size);
            wasm.heap8u().set(bytes.subarray(offset), Number(pSql));
            wasm.poke8(wasm.ptr.add(pSql, length), 0);
            wasm.pokePtr([ppStmt, pzTail], 0);
            const rc = capi.sqlite3_prepare_v3(pDb, pSql, length, 0, ppStmt, pzTail);
            const pStmt = wasm.peekPtr(ppStmt);
            if (rc !== capi.SQLITE_OK) {
                const at = capi.sqlite3_error_offset(pDb);
                const failure = { message: capi.sqlite3_errmsg(pDb), code: capi.sqlite3_js_rc_str(rc) || 'SQLITE_ERROR', offset: at >= 0 ? offset + at : startOf(bytes, offset) };
                if (pStmt) capi.sqlite3_finalize(pStmt);
                return { error: failure };
            }
            const tail = Number(wasm.peekPtr(pzTail));
            const end = tail ? offset + (tail - Number(pSql)) : bytes.length;
            if (!pStmt) return end > offset && end < bytes.length ? { skip: end } : null;
            const text = capi.sqlite3_sql(pStmt);
            capi.sqlite3_finalize(pStmt);
            return { text, start: offset, end };
        } finally {
            wasm.scopedAllocPop(stack);
        }
    }

    /** Whether another statement follows `offset` (without preparing it, which could fail early). */
    function hasMore(bytes, offset) {
        const rest = new TextDecoder().decode(bytes.subarray(offset));
        return /[^\s;]/.test(rest.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ''));
    }

    /** The first byte at or after `offset` that isn't whitespace, so an error points at the statement. */
    function startOf(bytes, offset) {
        let at = offset;
        while (at < bytes.length && (bytes[at] === 32 || bytes[at] === 9 || bytes[at] === 10 || bytes[at] === 13)) at++;
        return at;
    }

    const adapter = {
        info() {
            return {
                engine: 'SQLite',
                version: sqlite3.version.libVersion,
                persistent: files.persistent,
                open: current ? current.id : null,
                inTransaction: current ? capi.sqlite3_get_autocommit(current.db.pointer) === 0 : false
            };
        },

        async create(id) {
            const name = checkId(id);
            if (files.exists(name)) throw new DatabaseError('A database with this id already exists.', { code: 'EXISTS' });
            closeCurrent();
            await files.reserve(2);
            openFile(id);
            saveCurrent();
            return adapter.info();
        },

        async open(id) {
            if (current && current.id === id) return adapter.info();
            requireFile(id);
            closeCurrent();
            await files.reserve(2);
            openFile(id);
            return adapter.info();
        },

        close() {
            closeCurrent();
            return adapter.info();
        },

        remove(id) {
            const name = checkId(id);
            if (current && current.id === id) closeCurrent();
            if (files.exists(name)) files.remove(name);
            return adapter.info();
        },

        /** Deletes every database file in this browser. */
        removeAll() {
            closeCurrent();
            for (const name of files.names()) if (/^db-[a-z0-9][a-z0-9-]*\.sqlite3$/.test(name)) files.remove(name);
            return adapter.info();
        },

        async duplicate(fromId, toId) {
            if (current && current.id === fromId) saveCurrent();
            const from = requireFile(fromId);
            const to = checkId(toId);
            if (files.exists(to)) throw new DatabaseError('A database with this id already exists.', { code: 'EXISTS' });
            await files.reserve(2);
            files.write(to, files.read(from));
            return adapter.info();
        },

        /** The database file's bytes (a standard .sqlite file). */
        exportFile(id) {
            if (current && current.id === id) saveCurrent();
            return files.read(requireFile(id));
        },

        /** Creates a database from a .sqlite file's bytes. */
        async importFile(id, bytes) {
            const name = checkId(id);
            if (!isSqliteFile(bytes)) throw new DatabaseError('This isn\'t a SQLite database file.', { code: 'NOT_A_DATABASE' });
            if (files.exists(name)) throw new DatabaseError('A database with this id already exists.', { code: 'EXISTS' });
            let data = bytes;
            // A file saved in WAL mode is opened in the standard journal mode
            // (bytes 18 and 19 of the header), which this storage needs
            if (data[18] === 2 || data[19] === 2) {
                data = new Uint8Array(bytes);
                data[18] = 1;
                data[19] = 1;
            }
            await files.reserve(2);
            files.write(name, data);
            // A damaged or encrypted file is refused before it reaches the list
            let check;
            let db = null;
            try {
                db = files.open(name);
                check = db.selectValues('PRAGMA quick_check;');
            } catch (error) {
                check = [cleanMessage(error instanceof Error ? error.message : error).message];
            } finally {
                db?.close();
            }
            if (check.length !== 1 || check[0] !== 'ok') {
                files.remove(name);
                throw new DatabaseError(`This database file can't be used: ${String(check[0] || 'it is damaged')}.`, { code: 'NOT_A_DATABASE' });
            }
            return adapter.info();
        },

        /**
         * Runs an imported script in one transaction: all of it, or (when a
         * statement fails) none of it. Foreign keys are checked at the end, so
         * the script's tables and rows can come in any order.
         * Returns what the engine reported: statements run and rows changed.
         * @param {string} sql
         */
        runScript(sql) {
            const { db } = requireOpen();
            requireNoTransaction();
            closeCursors();
            const bytes = new TextEncoder().encode(String(sql ?? ''));
            const pDb = db.pointer;
            const started = now();
            let statements = 0;
            const changesBefore = capi.sqlite3_total_changes(pDb);
            /** @type {{ message: string, code: string, offset: number, statement: number } | null} */
            let failure = null;
            const pSql = wasm.alloc(bytes.length + 1);
            const ppStmt = wasm.alloc(2 * wasm.ptr.size);
            const pzTail = wasm.ptr.add(ppStmt, wasm.ptr.size);
            db.exec('BEGIN; PRAGMA defer_foreign_keys = ON;');
            try {
                wasm.heap8u().set(bytes, Number(pSql));
                wasm.poke8(wasm.ptr.add(pSql, bytes.length), 0);
                let at = 0;
                while (at < bytes.length) {
                    wasm.pokePtr([ppStmt, pzTail], 0);
                    // The length includes the terminating zero, so SQLite reads the text in place (no copy of the rest of the script)
                    const rc = capi.sqlite3_prepare_v3(pDb, wasm.ptr.add(pSql, at), bytes.length - at + 1, 0, ppStmt, pzTail);
                    const pStmt = wasm.peekPtr(ppStmt);
                    if (rc !== capi.SQLITE_OK) {
                        const offset = capi.sqlite3_error_offset(pDb);
                        failure = { message: capi.sqlite3_errmsg(pDb), code: capi.sqlite3_js_rc_str(rc) || 'SQLITE_ERROR', offset: offset >= 0 ? at + offset : startOf(bytes, at), statement: statements };
                        if (pStmt) capi.sqlite3_finalize(pStmt);
                        break;
                    }
                    const tail = Number(wasm.peekPtr(pzTail));
                    const next = tail ? tail - Number(pSql) : bytes.length;
                    if (pStmt) {
                        try {
                            const text = capi.sqlite3_sql(pStmt) || '';
                            if (ENDS_TRANSACTION.test(text.replace(/^(?:\s|--[^\n]*\n?|\/\*[\s\S]*?\*\/)*/, ''))) {
                                failure = { message: 'An imported script can\'t start or end transactions itself; the import already runs it in one.', code: 'TRANSACTION', offset: startOf(bytes, at), statement: statements };
                                break;
                            }
                            let step;
                            while ((step = capi.sqlite3_step(pStmt)) === capi.SQLITE_ROW) { /* rows of a query aren't shown in an import */ }
                            if (step !== capi.SQLITE_DONE) {
                                failure = { message: capi.sqlite3_errmsg(pDb), code: capi.sqlite3_js_rc_str(step) || 'SQLITE_ERROR', offset: startOf(bytes, at), statement: statements };
                                break;
                            }
                            statements++;
                        } finally {
                            capi.sqlite3_finalize(pStmt);
                        }
                    }
                    if (next <= at) break;
                    at = next;
                }
                if (!failure) {
                    try {
                        db.exec('COMMIT;');
                    } catch (error) {
                        // A foreign key that points nowhere is found here
                        failure = { ...cleanMessage(error instanceof Error ? error.message : error), offset: -1, statement: -1 };
                    }
                }
            } finally {
                if (capi.sqlite3_get_autocommit(pDb) === 0) db.exec('ROLLBACK;');
                wasm.dealloc(ppStmt);
                wasm.dealloc(pSql);
                saveCurrent();
            }
            if (failure) {
                const where = failure.offset >= 0 ? positionAt(bytes, failure.offset) : {};
                throw new DatabaseError(failure.message, { code: failure.code, ...where, ...(failure.statement >= 0 ? { statement: failure.statement } : {}) });
            }
            // Rows inserted, updated or deleted, as SQLite counts them (triggers included)
            return { statements, rowsAffected: capi.sqlite3_total_changes(pDb) - changesBefore, durationMs: Math.max(0, now() - started) };
        },

        /**
         * Inserts rows with one prepared statement, in one transaction: all of
         * them, or (when a row fails) none. `setup` runs first (CREATE TABLE).
         * @param {{ setup?: string[], sql: string, rows: unknown[][] }} work
         */
        insertRows({ setup = [], sql, rows }) {
            const { db } = requireOpen();
            requireNoTransaction();
            closeCursors();
            const started = now();
            let inserted = 0;
            let row = 0;
            db.exec('BEGIN; PRAGMA defer_foreign_keys = ON;');
            try {
                for (const statement of setup) db.exec(statement);
                const stmt = db.prepare(sql);
                try {
                    for (; row < rows.length; row++) {
                        stmt.bind(rows[row]).stepReset();
                        inserted += capi.sqlite3_changes(db.pointer);
                    }
                } finally {
                    stmt.finalize();
                }
                row = -1;
                db.exec('COMMIT;');
            } catch (error) {
                const reason = cleanMessage(error instanceof Error ? error.message : error);
                throw new DatabaseError(reason.message, { code: reason.code, ...(row >= 0 && row < rows.length ? { row: row + 1 } : {}) });
            } finally {
                if (capi.sqlite3_get_autocommit(db.pointer) === 0) db.exec('ROLLBACK;');
                saveCurrent();
            }
            return { rowsInserted: inserted, durationMs: Math.max(0, now() - started) };
        },

        /**
         * Runs a script: every statement in order, stopping at the first error.
         * Statements before the error have run; outside a transaction they stay.
         * @param {string} sql
         * @param {{ pageSize?: number }} [options]
         */
        execute(sql, { pageSize = DEFAULT_PAGE_SIZE } = {}) {
            requireOpen();
            closeCursors();
            const size = clampPage(pageSize);
            const bytes = new TextEncoder().encode(String(sql ?? ''));
            const results = [];
            /** @type {any} */
            let error = null;
            let offset = 0;
            let index = 0;
            try {
                for (;;) {
                    const next = nextStatement(bytes, offset);
                    if (!next) break;
                    if ('skip' in next) {
                        offset = next.skip;
                        continue;
                    }
                    if ('error' in next) {
                        error = { ...next.error, statement: index };
                        break;
                    }
                    try {
                        const result = runStatement(next.text, size, !hasMore(bytes, next.end));
                        results.push({ ...result, statement: index });
                    } catch (e) {
                        const reason = cleanMessage(e instanceof Error ? e.message : e);
                        error = { ...reason, offset: startOf(bytes, next.start), statement: index };
                        break;
                    }
                    offset = next.end;
                    index++;
                }
            } finally {
                saveCurrent();
            }
            if (error) {
                const { line, column } = positionAt(bytes, error.offset);
                error = { message: error.message, code: error.code, statement: error.statement, line, column };
            }
            return { results, error, inTransaction: capi.sqlite3_get_autocommit(current.db.pointer) === 0 };
        },

        /** The next page of a result that had more rows. */
        fetchPage(cursorId, { pageSize = DEFAULT_PAGE_SIZE } = {}) {
            const cursor = cursors.get(cursorId);
            if (!cursor) throw new DatabaseError('These results are no longer available. Run the query again.', { code: 'CURSOR_GONE' });
            const page = readPage(cursor.stmt, clampPage(pageSize), cursor.pending);
            cursor.pending = page.next;
            if (!page.next) dropCursor(cursorId);
            return { columns: cursor.columns, rows: page.rows, more: !!page.next, cursor: page.next ? cursorId : null };
        },

        closeCursor(cursorId) {
            dropCursor(cursorId);
        },

        /** Tables and views of the open database, with columns and keys. */
        schema() {
            const { db } = requireOpen();
            const objects = db.selectObjects(
                "SELECT name, type, sql FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name COLLATE NOCASE");
            return objects.map((/** @type {any} */ object) => {
                const columns = db.selectObjects('SELECT name, type, "notnull" AS required, dflt_value AS defaultValue, pk FROM pragma_table_info(?)', [object.name]);
                const keys = object.type === 'table'
                    ? db.selectObjects('SELECT id, "from" AS fromColumn, "table" AS refTable, "to" AS toColumn FROM pragma_foreign_key_list(?) ORDER BY id, seq', [object.name])
                    : [];
                /** @type {Map<number, { columns: string[], refTable: string, refColumns: string[] }>} */
                const foreignKeys = new Map();
                for (const key of keys) {
                    if (!foreignKeys.has(key.id)) foreignKeys.set(key.id, { columns: [], refTable: key.refTable, refColumns: [] });
                    const fk = foreignKeys.get(key.id);
                    fk.columns.push(key.fromColumn);
                    if (key.toColumn !== null) fk.refColumns.push(key.toColumn);
                }
                return {
                    name: object.name,
                    type: object.type,
                    sql: object.sql || '',
                    columns: columns.map((/** @type {any} */ c) => ({
                        name: c.name,
                        type: c.type || '',
                        notNull: !!c.required,
                        defaultValue: c.defaultValue,
                        primaryKey: c.pk > 0
                    })),
                    primaryKey: columns.filter((/** @type {any} */ c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((/** @type {any} */ c) => c.name),
                    foreignKeys: [...foreignKeys.values()]
                };
            });
        },

        destroy() {
            closeCurrent();
        }
    };
    return adapter;
}
