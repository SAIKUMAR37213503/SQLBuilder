// Import / export of queries and templates as JSON.
//
// Imported files are untrusted. They are parsed with JSON.parse (never
// evaluated) and every value is rebuilt field-by-field into a fresh model:
// wrong types, unknown enum values, oversized strings/lists and excessive
// nesting are rejected; unknown keys are dropped.

import {
    MODEL_VERSION, QUERY_TYPES, JOIN_TYPES, SET_OPERATORS, AGGREGATES, SORT_DIRECTIONS,
    LOGIC_OPERATORS, OPERATORS, VALUE_TYPES, WINDOW_FUNCTIONS, WINDOW_FRAMES, createWorkspace
} from './model.js';
import { MAX_NESTING_DEPTH } from './validation.js';

export const APP_ID = 'sql-query-builder-pro-lite';
export const MAX_IMPORT_BYTES = 1024 * 1024;
const MAX_STRING = 10000;
const MAX_LIST = 200;
const MAX_DEPTH = MAX_NESTING_DEPTH + 1;

export class ImportError extends Error {}

// ---------------------------------------------------------------------------
// Primitive readers
// ---------------------------------------------------------------------------

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(obj, key, where, fallback = '') {
    const value = obj[key];
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value !== 'string') throw new ImportError(`${where}.${key} must be text.`);
    if (value.length > MAX_STRING) throw new ImportError(`${where}.${key} is too long.`);
    return value;
}

function bool(obj, key, where) {
    const value = obj[key];
    if (value === undefined) return false;
    if (typeof value !== 'boolean') throw new ImportError(`${where}.${key} must be true or false.`);
    return value;
}

function oneOf(obj, key, allowed, where, fallback) {
    const value = obj[key] === undefined ? fallback : obj[key];
    if (!allowed.includes(value)) throw new ImportError(`${where}.${key} has an unsupported value.`);
    return value;
}

function list(obj, key, where, mapItem, { min = 0 } = {}) {
    const value = obj[key];
    if (value === undefined && min === 0) return [];
    if (!Array.isArray(value)) throw new ImportError(`${where}.${key} must be a list.`);
    if (value.length > MAX_LIST) throw new ImportError(`${where}.${key} has too many items.`);
    if (value.length < min) throw new ImportError(`${where}.${key} needs at least ${min} item(s).`);
    return value.map((item, i) => {
        if (!isObject(item)) throw new ImportError(`${where}.${key}[${i}] must be an object.`);
        return mapItem(item, `${where}.${key}[${i}]`);
    });
}

function obj(parent, key, where) {
    const value = parent[key];
    if (!isObject(value)) throw new ImportError(`${where}.${key} must be an object.`);
    return value;
}

// ---------------------------------------------------------------------------
// Model readers
// ---------------------------------------------------------------------------

function readGroup(data, where, depth) {
    if (depth > MAX_DEPTH * 4) throw new ImportError(`${where} is nested too deeply.`);
    return {
        kind: 'group',
        logic: oneOf(data, 'logic', LOGIC_OPERATORS, where, 'AND'),
        negate: bool(data, 'negate', where),
        items: list(data, 'items', where, (item, w) => readPredicate(item, w, depth))
    };
}

function readPredicate(data, where, depth) {
    switch (data.kind) {
        case 'group':
            return readGroup(data, where, depth + 1);
        case 'raw':
            return { kind: 'raw', sql: str(data, 'sql', where) };
        case 'condition': {
            const valueType = oneOf(data, 'valueType', VALUE_TYPES, where, 'value');
            const hasSubquery = valueType === 'subquery' && data.subquery != null;
            return {
                kind: 'condition',
                left: str(data, 'left', where),
                op: oneOf(data, 'op', Object.keys(OPERATORS), where, '='),
                valueType,
                value: str(data, 'value', where),
                value2: str(data, 'value2', where),
                subquery: hasSubquery ? readSelect(obj(data, 'subquery', where), `${where}.subquery`, depth + 1) : null
            };
        }
        default:
            throw new ImportError(`${where}.kind must be "condition", "group" or "raw".`);
    }
}

function readOrderItem(o, w) {
    return { expr: str(o, 'expr', w), direction: oneOf(o, 'direction', SORT_DIRECTIONS, w, 'ASC') };
}

function readColumn(data, where) {
    if (data.kind === 'window') {
        return {
            kind: 'window',
            func: oneOf(data, 'func', Object.keys(WINDOW_FUNCTIONS), where, 'ROW_NUMBER'),
            args: str(data, 'args', where),
            partitionBy: list(data, 'partitionBy', where, (p, w) => ({ expr: str(p, 'expr', w) })),
            orderBy: list(data, 'orderBy', where, readOrderItem),
            frame: oneOf(data, 'frame', WINDOW_FRAMES, where, ''),
            frameSize: str(data, 'frameSize', where),
            alias: str(data, 'alias', where)
        };
    }
    if (data.kind === 'case') {
        return {
            kind: 'case',
            cases: list(data, 'cases', where, (c, w) => ({ when: str(c, 'when', w), then: str(c, 'then', w) })),
            elseValue: str(data, 'elseValue', where),
            alias: str(data, 'alias', where)
        };
    }
    if (data.kind !== undefined && data.kind !== 'column') throw new ImportError(`${where}.kind must be "column", "case" or "window".`);
    return {
        kind: 'column',
        expr: str(data, 'expr', where),
        aggregate: oneOf(data, 'aggregate', AGGREGATES, where, ''),
        alias: str(data, 'alias', where)
    };
}

function readSource(data, where, depth) {
    if (data.kind === 'subquery') {
        return {
            kind: 'subquery',
            query: readSelect(obj(data, 'query', where), `${where}.query`, depth + 1),
            alias: str(data, 'alias', where)
        };
    }
    if (data.kind !== undefined && data.kind !== 'table') throw new ImportError(`${where}.kind must be "table" or "subquery".`);
    return { kind: 'table', table: str(data, 'table', where), alias: str(data, 'alias', where) };
}

function readSelect(data, where, depth = 0) {
    if (depth > MAX_DEPTH) throw new ImportError(`${where} nests queries too deeply.`);
    if (data.kind !== undefined && data.kind !== 'select') throw new ImportError(`${where}.kind must be "select".`);
    const emptyGroup = { kind: 'group', logic: 'AND', negate: false, items: [] };
    return {
        kind: 'select',
        ctes: list(data, 'ctes', where, (c, w) => ({
            name: str(c, 'name', w),
            query: readSelect(obj(c, 'query', w), `${w}.query`, depth + 1)
        })),
        distinct: bool(data, 'distinct', where),
        columns: list(data, 'columns', where, readColumn),
        from: data.from === undefined ? { kind: 'table', table: '', alias: '' } : readSource(obj(data, 'from', where), `${where}.from`, depth),
        joins: list(data, 'joins', where, (j, w) => ({
            type: oneOf(j, 'type', JOIN_TYPES, w, 'INNER JOIN'),
            source: readSource(obj(j, 'source', w), `${w}.source`, depth),
            on: j.on === undefined ? structuredClone(emptyGroup) : readGroup(obj(j, 'on', w), `${w}.on`, depth)
        })),
        where: data.where === undefined ? structuredClone(emptyGroup) : readGroup(obj(data, 'where', where), `${where}.where`, depth),
        groupBy: list(data, 'groupBy', where, (g, w) => ({ expr: str(g, 'expr', w) })),
        having: data.having === undefined ? structuredClone(emptyGroup) : readGroup(obj(data, 'having', where), `${where}.having`, depth),
        orderBy: list(data, 'orderBy', where, readOrderItem),
        limit: str(data, 'limit', where),
        offset: str(data, 'offset', where),
        setOps: list(data, 'setOps', where, (s, w) => ({
            op: oneOf(s, 'op', SET_OPERATORS, w, 'UNION'),
            query: readSelect(obj(s, 'query', w), `${w}.query`, depth + 1)
        }))
    };
}

function readInsert(data, where) {
    return {
        kind: 'insert',
        table: str(data, 'table', where),
        columns: str(data, 'columns', where),
        rows: list(data, 'rows', where, (r, w) => ({ values: str(r, 'values', w) }))
    };
}

function readUpdate(data, where) {
    return {
        kind: 'update',
        table: str(data, 'table', where),
        set: list(data, 'set', where, (a, w) => ({
            column: str(a, 'column', w),
            valueType: oneOf(a, 'valueType', ['value', 'column'], w, 'value'),
            value: str(a, 'value', w)
        })),
        where: data.where === undefined ? { kind: 'group', logic: 'AND', negate: false, items: [] } : readGroup(obj(data, 'where', where), `${where}.where`, 0)
    };
}

function readDelete(data, where) {
    return {
        kind: 'delete',
        table: str(data, 'table', where),
        where: data.where === undefined ? { kind: 'group', logic: 'AND', negate: false, items: [] } : readGroup(obj(data, 'where', where), `${where}.where`, 0)
    };
}

const READERS = { select: readSelect, insert: readInsert, update: readUpdate, delete: readDelete };

/**
 * Rebuilds a workspace from untrusted data. Accepts a full workspace or a
 * single query node ({ kind: 'select', … }). Throws ImportError.
 */
export function normalizeWorkspace(data) {
    if (!isObject(data)) throw new ImportError('The query must be a JSON object.');

    if (typeof data.kind === 'string' && READERS[data.kind]) {
        const workspace = createWorkspace(data.kind);
        workspace[data.kind] = READERS[data.kind](data, 'query', 0);
        return workspace;
    }

    if (typeof data.version === 'number' && data.version > MODEL_VERSION) {
        throw new ImportError('This file was made by a newer version of the app.');
    }
    const type = oneOf(data, 'type', QUERY_TYPES, 'query', 'select');
    const workspace = createWorkspace(type);
    for (const t of QUERY_TYPES) {
        if (data[t] !== undefined) {
            workspace[t] = READERS[t](obj(data, t, 'query'), `query.${t}`, 0);
        }
    }
    return workspace;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

function parseJson(text) {
    if (typeof text !== 'string') throw new ImportError('The file could not be read as text.');
    if (text.length > MAX_IMPORT_BYTES) throw new ImportError('The file is too large (limit 1 MB).');
    try {
        return JSON.parse(text);
    } catch {
        throw new ImportError("The file isn't valid JSON.");
    }
}

export function createQueryExport(workspace, meta = {}) {
    return { app: APP_ID, kind: 'query', version: MODEL_VERSION, exportedAt: new Date().toISOString(), ...meta, query: workspace };
}

/** @returns {{ ok: true, workspace: any, dialect?: string } | { ok: false, error: string }} */
export function parseQueryFile(text) {
    try {
        const data = parseJson(text);
        if (isObject(data) && data.kind === 'templates') {
            throw new ImportError('This is a templates file. Import it from the Templates panel.');
        }
        const payload = isObject(data) && data.app === APP_ID && data.kind === 'query' ? data.query : data;
        const dialect = isObject(data) && typeof data.dialect === 'string' ? data.dialect : undefined;
        return { ok: true, workspace: normalizeWorkspace(payload), ...(dialect ? { dialect } : {}) };
    } catch (error) {
        return { ok: false, error: describeError(error) };
    }
}

export function createTemplatesExport(templates) {
    return {
        app: APP_ID,
        kind: 'templates',
        version: MODEL_VERSION,
        exportedAt: new Date().toISOString(),
        templates: templates.map(({ name, dialect, workspace, createdAt, updatedAt }) => ({ name, ...(dialect ? { dialect } : {}), workspace, createdAt, updatedAt }))
    };
}

/** @returns {{ ok: true, templates: { name: string, dialect?: string, workspace: any }[] } | { ok: false, error: string }} */
export function parseTemplatesFile(text) {
    try {
        const data = parseJson(text);
        if (!isObject(data) || data.kind !== 'templates' || !Array.isArray(data.templates)) {
            throw new ImportError("This isn't a templates file exported from SQL Query Builder.");
        }
        if (data.templates.length > MAX_LIST) throw new ImportError('The file contains too many templates.');
        const templates = data.templates.map((t, i) => {
            if (!isObject(t)) throw new ImportError(`Template ${i + 1} is not an object.`);
            const name = str(t, 'name', `templates[${i}]`).trim().slice(0, 80);
            if (!name) throw new ImportError(`Template ${i + 1} has no name.`);
            // Unknown dialects are dropped by the template store
            const dialect = typeof t.dialect === 'string' ? t.dialect : undefined;
            try {
                return { name, ...(dialect ? { dialect } : {}), workspace: normalizeWorkspace(t.workspace) };
            } catch (error) {
                throw new ImportError(`Template “${name}”: ${describeError(error)}`);
            }
        });
        return { ok: true, templates };
    } catch (error) {
        return { ok: false, error: describeError(error) };
    }
}

function describeError(error) {
    return error instanceof ImportError ? error.message : 'The file could not be imported.';
}
