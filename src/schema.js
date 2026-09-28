// Local schema: the tables, columns and keys the user describes or imports,
// kept in localStorage next to templates and history. It is never read by
// the SQL generator, so it can't change generated SQL. Nothing here talks to
// a database.
//
// A table
//   { name, columns: [{ name, type, nullable }], primaryKey: [column names],
//     unique: [[column names]], foreignKeys: [{ columns, refTable, refColumns }] }
//   name        as written, e.g. "employees" or "sales.orders" (no quotes)
//   type        as written, e.g. "VARCHAR(100)"; '' when unknown
//   nullable    false only when the column is NOT NULL or part of the key
//   refColumns  [] means "the primary key of refTable"
// Names are matched without regard to case.

import { isBareIdentifier } from './sql-utils.js';
import { RESERVED_WORDS } from './validation.js';

export const SCHEMA_TABLE_LIMIT = 500;
export const SCHEMA_COLUMN_LIMIT = 500;
export const SCHEMA_NAME_MAX = 128;
export const SCHEMA_TYPE_MAX = 64;
// localStorage holds about 5 MB in total, shared with templates and history
export const SCHEMA_MAX_BYTES = 1536 * 1024;

const SCHEMA_KEY = 'schema';

export class SchemaError extends Error {}

const key = (name) => name.toLowerCase();

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * A table or column name, cleaned; throws a SchemaError when it isn't usable.
 * @param {any} value
 * @param {string} what e.g. 'Table 3' or 'employees, column 2'
 */
function cleanName(value, what) {
    if (typeof value !== 'string' || !value.trim()) throw new SchemaError(`${what} has no name.`);
    const name = value.trim();
    if (name.length > SCHEMA_NAME_MAX) throw new SchemaError(`${what}: the name is longer than ${SCHEMA_NAME_MAX} characters.`);
    if (CONTROL_RE.test(name)) throw new SchemaError(`${what}: the name contains control characters.`);
    return name;
}

function cleanType(value) {
    if (typeof value !== 'string') return '';
    const type = value.trim().replace(/\s+/g, ' ');
    return type.length > SCHEMA_TYPE_MAX ? `${type.slice(0, SCHEMA_TYPE_MAX - 1)}…` : type;
}

/**
 * Checks and cleans one table from untrusted input (a file, a backup or
 * storage). Key columns must exist in the table; duplicates are rejected.
 * @param {any} input
 * @param {number} index position, for messages
 */
export function readTable(input, index = 0) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SchemaError(`Table ${index + 1} is not an object.`);
    const name = cleanName(input.name, `Table ${index + 1}`);
    if (!Array.isArray(input.columns)) throw new SchemaError(`${name}: columns must be a list.`);
    if (input.columns.length > SCHEMA_COLUMN_LIMIT) throw new SchemaError(`${name} has more than ${SCHEMA_COLUMN_LIMIT} columns.`);

    const seen = new Map();
    const columns = input.columns.map((/** @type {any} */ c, /** @type {number} */ i) => {
        const source = typeof c === 'string' ? { name: c } : c;
        if (!source || typeof source !== 'object') throw new SchemaError(`${name}, column ${i + 1} is not an object.`);
        const columnName = cleanName(source.name, `${name}, column ${i + 1}`);
        if (seen.has(key(columnName))) throw new SchemaError(`${name} has two columns named ${columnName}.`);
        seen.set(key(columnName), columnName);
        return { name: columnName, type: cleanType(source.type), nullable: source.nullable !== false };
    });

    // A list of existing column names, spelled as the columns are
    const columnList = (/** @type {any} */ list, /** @type {string} */ what) => {
        if (!Array.isArray(list) || list.length === 0) throw new SchemaError(`${name}: ${what} needs at least one column.`);
        return list.map(c => {
            const found = typeof c === 'string' ? seen.get(key(c.trim())) : undefined;
            if (!found) throw new SchemaError(`${name}: ${what} refers to ${typeof c === 'string' ? c : 'a column'}, which isn't in the table.`);
            return found;
        });
    };

    const primaryKey = input.primaryKey === undefined || (Array.isArray(input.primaryKey) && input.primaryKey.length === 0)
        ? [] : columnList(input.primaryKey, 'the primary key');
    const pk = new Set(primaryKey.map(key));
    for (const column of columns) if (pk.has(key(column.name))) column.nullable = false;

    if (input.unique !== undefined && !Array.isArray(input.unique)) throw new SchemaError(`${name}: unique keys must be a list.`);
    const unique = (input.unique || []).map((/** @type {any} */ u) => columnList(u, 'a unique key'));

    if (input.foreignKeys !== undefined && !Array.isArray(input.foreignKeys)) throw new SchemaError(`${name}: foreign keys must be a list.`);
    const foreignKeys = (input.foreignKeys || []).map((/** @type {any} */ fk, /** @type {number} */ i) => {
        if (!fk || typeof fk !== 'object') throw new SchemaError(`${name}, foreign key ${i + 1} is not an object.`);
        const cols = columnList(fk.columns, `foreign key ${i + 1}`);
        const refTable = cleanName(fk.refTable, `${name}, foreign key ${i + 1} (referenced table)`);
        const refColumns = fk.refColumns === undefined ? [] : Array.isArray(fk.refColumns)
            ? fk.refColumns.map((/** @type {any} */ c, /** @type {number} */ j) => cleanName(c, `${name}, foreign key ${i + 1}, referenced column ${j + 1}`))
            : null;
        if (refColumns === null) throw new SchemaError(`${name}, foreign key ${i + 1}: referenced columns must be a list.`);
        if (refColumns.length && refColumns.length !== cols.length) {
            throw new SchemaError(`${name}, foreign key ${i + 1}: ${cols.length} ${cols.length === 1 ? 'column refers' : 'columns refer'} to ${refColumns.length}.`);
        }
        return { columns: cols, refTable, refColumns };
    });

    return { name, columns, primaryKey, unique: dedupeKeys(unique, primaryKey), foreignKeys };
}

// Drops unique keys that repeat the primary key or each other
function dedupeKeys(unique, primaryKey) {
    const seen = new Set([JSON.stringify(primaryKey.map(key).sort())]);
    return unique.filter(u => {
        const id = JSON.stringify(u.map(key).sort());
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
    });
}

/**
 * Checks and cleans a list of tables; table names must be unique.
 * @param {any} list
 */
export function readTables(list) {
    if (!Array.isArray(list)) throw new SchemaError('The schema must contain a list of tables.');
    if (list.length > SCHEMA_TABLE_LIMIT) throw new SchemaError(`A schema can have at most ${SCHEMA_TABLE_LIMIT} tables.`);
    const tables = list.map(readTable);
    const names = new Set();
    for (const table of tables) {
        if (names.has(key(table.name))) throw new SchemaError(`There are two tables named ${table.name}.`);
        names.add(key(table.name));
    }
    return tables;
}

/**
 * A table with a given name (case-insensitive), or null.
 * @param {any[]} tables
 * @param {string} name
 */
export function findTable(tables, name) {
    const wanted = key(String(name ?? '').trim());
    return tables.find(t => key(t.name) === wanted) || null;
}

/** Fills in foreign keys written without referenced columns, from the referenced table's primary key. */
export function resolveForeignKeys(tables, lookup = tables) {
    for (const table of tables) {
        for (const fk of table.foreignKeys) {
            if (fk.refColumns.length) continue;
            const target = findTable(lookup, fk.refTable) || findTable(tables, fk.refTable);
            if (target && target.primaryKey.length === fk.columns.length) fk.refColumns = target.primaryKey.slice();
        }
    }
    return tables;
}

// ---------------------------------------------------------------------------
// CREATE TABLE text for a table (shown when editing; exported as .sql)
// ---------------------------------------------------------------------------

function quoteName(name) {
    return isBareIdentifier(name) && !RESERVED_WORDS.has(name.toUpperCase()) ? name : `"${name.replace(/"/g, '""')}"`;
}

// "sales.orders" -> sales.orders; a part that needs quotes gets them
function quoteTableName(name) {
    return name.split('.').map(quoteName).join('.');
}

const list = (names) => names.map(quoteName).join(', ');

/**
 * @param {any} table
 * @returns {string}
 */
export function tableToDdl(table) {
    const lines = table.columns.map((/** @type {any} */ c) => {
        const single = table.primaryKey.length === 1 && key(table.primaryKey[0]) === key(c.name);
        return [quoteName(c.name), c.type, single ? 'PRIMARY KEY' : !c.nullable ? 'NOT NULL' : ''].filter(Boolean).join(' ');
    });
    if (table.primaryKey.length > 1) lines.push(`PRIMARY KEY (${list(table.primaryKey)})`);
    for (const u of table.unique) lines.push(`UNIQUE (${list(u)})`);
    for (const fk of table.foreignKeys) {
        lines.push(`FOREIGN KEY (${list(fk.columns)}) REFERENCES ${quoteTableName(fk.refTable)}${fk.refColumns.length ? ` (${list(fk.refColumns)})` : ''}`);
    }
    return `CREATE TABLE ${quoteTableName(table.name)} (\n${lines.map(l => `    ${l}`).join(',\n')}\n);`;
}

/** @param {any[]} tables */
export function schemaToDdl(tables) {
    return tables.map(tableToDdl).join('\n\n');
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

export function createSchemaStore(storage) {
    let tables = load();

    function load() {
        const stored = storage.get(SCHEMA_KEY, null);
        if (!stored || !Array.isArray(stored.tables)) return [];
        // Keep every table that is still valid on its own
        const kept = [];
        for (const t of stored.tables) {
            try {
                const table = readTable(t, kept.length);
                if (!findTable(kept, table.name) && kept.length < SCHEMA_TABLE_LIMIT) kept.push(table);
            } catch {
                // skip a damaged table
            }
        }
        return kept;
    }

    function persist(next) {
        const value = { tables: next };
        if (JSON.stringify(value).length > SCHEMA_MAX_BYTES) {
            throw new SchemaError(`The schema is too large to keep in this browser (limit ${Math.round(SCHEMA_MAX_BYTES / 1024)} KB).`);
        }
        const ok = next.length ? storage.set(SCHEMA_KEY, value) : (storage.remove(SCHEMA_KEY), true);
        if (!ok) {
            throw new SchemaError(storage.available
                ? 'Browser storage is full; delete some templates or history first.'
                : 'Browser storage is unavailable, so the schema can\'t be saved.');
        }
        tables = next;
    }

    return {
        /** All tables, sorted by name. */
        list: () => tables.slice().sort(byName),

        get: (/** @type {string} */ name) => findTable(tables, name),

        get size() { return tables.length; },

        /**
         * Adds a table, or replaces the one called `previousName` (for a rename).
         * @param {any} input
         * @param {{ previousName?: string | null }} [options]
         */
        save(input, { previousName = null } = {}) {
            const table = readTable(input);
            const others = previousName ? tables.filter(t => key(t.name) !== key(previousName)) : tables;
            if (findTable(others, table.name)) throw new SchemaError(`A table named ${findTable(others, table.name).name} already exists.`);
            if (!previousName && tables.length >= SCHEMA_TABLE_LIMIT) throw new SchemaError(`A schema can have at most ${SCHEMA_TABLE_LIMIT} tables.`);
            resolveForeignKeys([table], others);
            persist([...others, table]);
            return table;
        },

        remove(/** @type {string} */ name) {
            persist(tables.filter(t => key(t.name) !== key(name)));
        },

        clear() {
            persist([]);
        },

        /**
         * Adds imported or restored tables, all or nothing.
         * @param {any[]} incoming
         * @param {{ replace?: boolean, onConflict?: 'replace' | 'keep' }} [options]
         *   replace: drop the current schema first; onConflict: what to do with
         *   a table whose name is already taken
         * @returns {{ added: number, replaced: number, kept: number }}
         */
        apply(incoming, { replace = false, onConflict = 'replace' } = {}) {
            const clean = readTables(incoming);
            let next = replace ? [] : tables.slice();
            let added = 0;
            let replaced = 0;
            let kept = 0;
            for (const table of clean) {
                const existing = findTable(next, table.name);
                if (!existing) {
                    next.push(table);
                    added++;
                } else if (onConflict === 'replace') {
                    next = next.map(t => (t === existing ? table : t));
                    replaced++;
                } else {
                    kept++;
                }
            }
            if (next.length > SCHEMA_TABLE_LIMIT) throw new SchemaError(`A schema can have at most ${SCHEMA_TABLE_LIMIT} tables; this would make ${next.length}.`);
            // Copies, so a failed save leaves the current tables untouched
            next = resolveForeignKeys(structuredClone(next));
            persist(next);
            return { added, replaced, kept };
        }
    };
}
