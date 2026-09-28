// Suggestions for builder fields: table names in table fields, and column
// names (plus a few functions) in column and expression fields. They come
// from the local schema and from the query itself (CTEs, subquery aliases),
// and follow SQL scope rules: a subquery in WHERE sees the outer query's
// tables, a derived table or a CTE does not.
//
// Only reads the model; nothing here changes it or the generated SQL.

import { splitPath } from './model.js';
import { findTable } from './schema.js';
import { isBareIdentifier, isColumnReference } from './sql-utils.js';
import { RESERVED_WORDS } from './validation.js';

export const MAX_SUGGESTIONS = 50;
// CTEs and subqueries that refer to each other are followed this deep
const MAX_DEPTH = 6;

// A few everyday functions per dialect. Aggregates and window functions also
// have their own pickers, but people type them in expressions too.
const COMMON_FUNCTIONS = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'NULLIF', 'UPPER', 'LOWER', 'TRIM', 'ROUND', 'ABS', 'CAST', 'SUBSTRING'];
const DIALECT_FUNCTIONS = {
    generic: ['LENGTH', 'CURRENT_DATE', 'CURRENT_TIMESTAMP'],
    sqlserver: ['LEN', 'ISNULL', 'CONCAT', 'GETDATE', 'DATEADD', 'DATEDIFF', 'FORMAT', 'STRING_AGG'],
    postgresql: ['LENGTH', 'CONCAT', 'NOW', 'CURRENT_DATE', 'DATE_TRUNC', 'EXTRACT', 'TO_CHAR', 'STRING_AGG'],
    mysql: ['LENGTH', 'CONCAT', 'IFNULL', 'NOW', 'CURRENT_DATE', 'DATE_FORMAT', 'DATEDIFF', 'GROUP_CONCAT']
};
// Written without parentheses
const NO_PARENS = new Set(['CURRENT_DATE', 'CURRENT_TIMESTAMP']);

/**
 * @typedef {{ label: string, insert: string, detail: string, kind: 'table' | 'column' | 'alias' | 'function' }} Suggestion
 * @typedef {{ ref: string, detail: string, columns: { name: string, detail: string }[] }} Source
 * @typedef {{ kind: 'table', ctes: string[] }
 *   | { kind: 'column', local: Source[], outer: Source[], outputs: string[], functions: boolean }} Context
 */

const key = (/** @type {string} */ name) => name.toLowerCase();

/** A name part without its quotes: "a b" / [a b] / `a b` → a b */
export function unquote(part) {
    const text = String(part).trim();
    if (text.length >= 2) {
        const [first, last] = [text[0], text[text.length - 1]];
        if ((first === '"' && last === '"') || (first === '`' && last === '`')) return text.slice(1, -1).replaceAll(first + first, first);
        if (first === '[' && last === ']') return text.slice(1, -1).replaceAll(']]', ']');
    }
    return text;
}

/** How a name is written into a field: quoted only when it has to be. */
export function writeName(name, dialect) {
    return String(name).split('.').map(part => (isBareIdentifier(part) && !RESERVED_WORDS.has(part.toUpperCase())
        ? part
        : dialect.quoteIdentifier(part))).join('.');
}

/**
 * A schema table by name. "employees" also finds "public.employees" (and the
 * other way round) when only one table has that name.
 * @param {any[]} tables
 * @param {string} name
 */
export function lookupTable(tables, name) {
    const exact = findTable(tables, name);
    if (exact) return exact;
    const last = key(name.split('.').pop() || '');
    const matches = tables.filter(t => key(t.name.split('.').pop()) === last);
    return matches.length === 1 ? matches[0] : undefined;
}

// ---------------------------------------------------------------------------
// Which kind of field a path is, and what is in scope there
// ---------------------------------------------------------------------------

/**
 * @param {any} workspace
 * @param {string} path the field's data-path
 * @param {{ tables: any[] }} env
 * @returns {Context | null}
 */
export function fieldContext(workspace, path, { tables }) {
    const keys = splitPath(path);
    const field = keys[keys.length - 1];
    /** @type {any[]} */
    const nodes = [workspace];
    for (const k of keys.slice(0, -1)) {
        const next = nodes[nodes.length - 1]?.[k];
        if (next == null || typeof next !== 'object') return null;
        nodes.push(next);
    }
    const owner = nodes[nodes.length - 1];

    // The queries on the way to the field, innermost last; `correlated` marks a
    // subquery in a condition, which also sees the query around it.
    /** @type {{ query: any, correlated: boolean, keys: string[] }[]} */
    const chain = [];
    nodes.forEach((node, i) => {
        if (i > 0 && node && ['select', 'insert', 'update', 'delete'].includes(node.kind)) {
            chain.push({ query: node, correlated: keys[i - 1] === 'subquery', keys: keys.slice(0, i) });
        }
    });
    if (!chain.length) return null;
    const ctes = visibleCtes(chain, keys);
    const env = { tables, ctes, depth: 0 };

    if (field === 'table') {
        if (owner.kind === 'table') return { kind: 'table', ctes: ctes.map(c => c.name) };
        if (['insert', 'update', 'delete'].includes(owner.kind)) return { kind: 'table', ctes: [] };
        return null;
    }

    // INSERT column list, and the upsert's conflict columns and SET columns:
    // the target table's own columns, never qualified
    const insert = chain.find(c => c.query.kind === 'insert');
    if (insert && ((owner.kind === 'insert' && field === 'columns') || (owner === insert.query.upsert && field === 'conflict')
        || (keys.includes('upsert') && field === 'column'))) {
        return targetContext(insert.query.table, env, false);
    }
    const inner = chain[chain.length - 1].query;
    if ((inner.kind === 'update' || inner.kind === 'insert') && field === 'column' && 'valueType' in owner) {
        return targetContext(inner.table, env, false);
    }

    const expression = isExpressionField(owner, field);
    if (!expression) return null;

    // Assignment values in UPDATE and the upsert, and UPDATE/DELETE conditions
    if (inner.kind !== 'select') {
        return inner.kind === 'insert' ? targetContext(inner.table, env, true) : withOuter(chain, env);
    }
    const context = withOuter(chain, env);
    // ORDER BY can also use the output names of the SELECT
    const orderBy = keys.length >= 3 && keys[keys.length - 3] === 'orderBy' && nodes[nodes.length - 2] === inner.orderBy;
    if (orderBy && context) context.outputs = inner.columns.map(c => String(c.alias || '').trim()).filter(Boolean);
    return context;
}

// Fields that hold a column or an expression
function isExpressionField(owner, field) {
    if (owner.kind === 'condition') {
        if (field === 'left') return true;
        return (field === 'value' || field === 'value2') && owner.valueType === 'column';
    }
    if (owner.kind === 'raw') return field === 'sql';
    if (owner.kind === 'column') return field === 'expr';
    if (owner.kind === 'window') return field === 'args';
    if ('when' in owner && 'then' in owner) return field === 'when' || field === 'then';
    if (owner.kind === 'case') return field === 'elseValue';
    if ('valueType' in owner && 'column' in owner) return field === 'value' && owner.valueType === 'column';
    // GROUP BY, ORDER BY, PARTITION BY and window ORDER BY items: { expr }
    return field === 'expr' && !('kind' in owner);
}

// The CTEs a field can refer to: all of the main query's, except inside CTE i,
// which sees only the ones before it
function visibleCtes(chain, keys) {
    const top = chain[0].query;
    if (top.kind !== 'select' || !Array.isArray(top.ctes)) return [];
    const at = keys.indexOf('ctes', chain[0].keys.length);
    const limit = at === chain[0].keys.length ? Number(keys[at + 1]) : top.ctes.length;
    return top.ctes.slice(0, limit).filter((/** @type {any} */ c) => String(c.name || '').trim());
}

/** @returns {Context} */
function targetContext(table, env, functions) {
    const source = tableSource(String(table || '').trim(), '', env);
    return { kind: 'column', local: source ? [source] : [], outer: [], outputs: [], functions };
}

// The tables of the innermost query, and of the queries around it while each
// step is a correlated subquery
/** @returns {Context & { kind: 'column' }} */
function withOuter(chain, env) {
    /** @type {Source[][]} */
    const levels = [];
    for (let i = chain.length - 1; i >= 0; i--) {
        levels.push(querySources(chain[i].query, env));
        if (!chain[i].correlated) break;
    }
    const [local = [], ...outer] = levels;
    return { kind: 'column', local, outer: outer.flat(), outputs: [], functions: true };
}

function querySources(query, env) {
    if (query.kind === 'update' || query.kind === 'delete') {
        const source = tableSource(String(query.table || '').trim(), '', env);
        return source ? [source] : [];
    }
    if (query.kind !== 'select') return [];
    return [query.from, ...query.joins.map((/** @type {any} */ j) => j.source)]
        .map(source => resolveSource(source, env))
        .filter(Boolean);
}

/** @returns {Source | null} */
function resolveSource(source, env) {
    if (!source) return null;
    if (source.kind === 'subquery') {
        const ref = String(source.alias || '').trim();
        if (!ref || env.depth >= MAX_DEPTH) return null;
        return { ref, detail: 'subquery', columns: outputColumns(source.query, { ...env, depth: env.depth + 1 }) };
    }
    return tableSource(String(source.table || '').trim(), String(source.alias || '').trim(), env);
}

function tableSource(name, alias, env) {
    if (!name) return null;
    const ref = alias || name;
    const cte = !name.includes('.') && env.ctes.find((/** @type {any} */ c) => key(unquote(c.name)) === key(unquote(name)));
    if (cte) {
        if (env.depth >= MAX_DEPTH) return { ref, detail: 'CTE', columns: [] };
        // A CTE sees only the CTEs before it
        const before = env.ctes.slice(0, env.ctes.indexOf(cte));
        return { ref, detail: 'CTE', columns: outputColumns(cte.query, { ...env, ctes: before, depth: env.depth + 1 }) };
    }
    const table = lookupTable(env.tables, name.split('.').map(unquote).join('.'));
    return {
        ref,
        detail: table ? table.name : 'table',
        columns: table ? table.columns.map((/** @type {any} */ c) => ({ name: c.name, detail: c.type })) : []
    };
}

/** The column names a SELECT produces, as far as they can be known. */
function outputColumns(select, env) {
    if (!select || select.kind !== 'select') return [];
    /** @type {{ name: string, detail: string }[]} */
    const out = [];
    let sources = null;
    const getSources = () => (sources ||= querySources(select, env));
    for (const column of select.columns) {
        const alias = String(column.alias || '').trim();
        if (alias) {
            out.push({ name: unquote(alias), detail: '' });
            continue;
        }
        if (column.kind !== 'column' || column.aggregate) continue;
        const expr = String(column.expr || '').trim();
        if (expr === '*') {
            getSources().forEach(s => out.push(...s.columns));
        } else if (expr.endsWith('.*')) {
            const ref = key(unquote(expr.slice(0, -2)));
            const source = getSources().find(s => key(unquote(s.ref)) === ref);
            if (source) out.push(...source.columns);
        } else if (isColumnReference(expr)) {
            out.push({ name: unquote(expr.split('.').pop() || ''), detail: '' });
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// The suggestions for what is being typed
// ---------------------------------------------------------------------------

const WORD_CHAR = /[\p{L}\p{N}_$.]/u;

/**
 * The name being typed at the caret: from the start of the word to the caret,
 * plus the rest of the word after it (which a suggestion replaces).
 * @param {string} text
 * @param {number} caret
 */
export function wordAt(text, caret) {
    let from = caret;
    while (from > 0 && WORD_CHAR.test(text[from - 1])) from--;
    let to = caret;
    while (to < text.length && WORD_CHAR.test(text[to]) && text[to] !== '.') to++;
    return { from, to, word: text.slice(from, caret) };
}

function matchRank(name, partial) {
    if (!partial) return 0;
    const lower = key(name);
    if (lower.startsWith(partial)) return 1;
    if (lower.includes(partial)) return 2;
    return -1;
}

/**
 * @param {Context} context
 * @param {string} text the field's text
 * @param {number} caret
 * @param {{ tables: any[], dialect: any }} env
 * @returns {{ from: number, to: number, items: Suggestion[] }}
 */
export function suggest(context, text, caret, { tables, dialect }) {
    const { from, to, word } = wordAt(text, caret);
    /** @type {{ item: Suggestion, rank: number, order: number }[]} */
    const found = [];
    const add = (/** @type {Suggestion} */ item, /** @type {string} */ matchOn, /** @type {string} */ partial) => {
        const rank = matchRank(matchOn, partial);
        // Functions only by their start: "a" shouldn't offer CAST
        if (item.kind === 'function' && rank !== 1) return;
        if (rank >= 0) found.push({ item, rank, order: found.length });
    };

    if (context.kind === 'table') {
        const partial = key(word);
        for (const name of context.ctes) add({ label: unquote(name), insert: name, detail: 'CTE', kind: 'table' }, unquote(name), partial);
        for (const t of tables) add({ label: t.name, insert: writeName(t.name, dialect), detail: plural(t.columns.length, 'column'), kind: 'table' }, t.name, partial);
    } else {
        const dot = word.lastIndexOf('.');
        if (dot >= 0) {
            // "e.sal": the columns of the table or alias e
            const qualifier = word.slice(0, dot);
            const partial = key(word.slice(dot + 1));
            const source = [...context.local, ...context.outer].find(s => key(unquote(s.ref)) === key(unquote(qualifier)));
            if (source) {
                for (const c of source.columns) add({ label: c.name, insert: `${qualifier}.${writeName(c.name, dialect)}`, detail: c.detail, kind: 'column' }, c.name, partial);
            }
        } else {
            const partial = key(word);
            const qualify = context.local.length > 1;
            for (const name of context.outputs) add({ label: name, insert: writeName(name, dialect), detail: 'output column', kind: 'alias' }, name, partial);
            for (const s of context.local) {
                for (const c of s.columns) {
                    const insert = qualify ? `${s.ref}.${writeName(c.name, dialect)}` : writeName(c.name, dialect);
                    add({ label: qualify ? `${unquote(s.ref)}.${c.name}` : c.name, insert, detail: c.detail, kind: 'column' }, c.name, partial);
                }
            }
            for (const s of context.outer) {
                for (const c of s.columns) {
                    add({ label: `${unquote(s.ref)}.${c.name}`, insert: `${s.ref}.${writeName(c.name, dialect)}`, detail: 'outer query', kind: 'column' }, c.name, partial);
                }
            }
            // Table names and aliases, to go on with "alias."
            if (qualify || context.outer.length) {
                for (const s of [...context.local, ...context.outer]) {
                    if (s.columns.length) add({ label: `${unquote(s.ref)}.`, insert: `${s.ref}.`, detail: s.detail === unquote(s.ref) ? 'table' : s.detail, kind: 'alias' }, unquote(s.ref), partial);
                }
            }
            if (context.functions && partial) {
                for (const name of [...COMMON_FUNCTIONS, ...(DIALECT_FUNCTIONS[dialect.id] || [])]) {
                    add({ label: NO_PARENS.has(name) ? name : `${name}()`, insert: NO_PARENS.has(name) ? name : `${name}(`, detail: 'function', kind: 'function' }, name, partial);
                }
            }
        }
    }

    const seen = new Set();
    const items = found
        .sort((a, b) => a.rank - b.rank || a.order - b.order)
        .map(f => f.item)
        .filter(item => !seen.has(item.insert) && seen.add(item.insert))
        .slice(0, MAX_SUGGESTIONS);
    // Nothing to offer when the only suggestion is exactly what is typed
    if (items.length === 1 && key(items[0].insert) === key(text.slice(from, to))) return { from, to, items: [] };
    return { from, to, items };
}

function plural(n, noun) {
    return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
