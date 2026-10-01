// JOIN assistant and schema checks. Uses the local schema to:
//   - offer the ON condition for a join from foreign keys, in either direction;
//   - point out joins that don't use the schema's link, that have no known
//     link, or that can repeat rows (neither side is a key);
//   - note table and column names that aren't in the schema.
// These are hints (info) and warnings only: nothing here blocks generation or
// changes the model, and without a schema there are none.

import { splitPath, getAt, joinPath, forEachSelect, createGroup, createCondition } from './model.js';
import { fieldContext, lookupTable, unquote, writeName } from './suggest.js';
import { isColumnReference, isQualifiedName, splitTopLevel } from './sql-utils.js';

const key = (/** @type {string} */ name) => String(name).toLowerCase();
const blank = (value) => String(value ?? '').trim() === '';

// Words that look like names but are values
const VALUE_WORDS = new Set(['NULL', 'TRUE', 'FALSE', 'DEFAULT', 'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'CURRENT_USER', 'LOCALTIME', 'LOCALTIMESTAMP']);

/**
 * @typedef {{ ref: string, table: any | null }} JoinSource  table: the schema table, or null when unknown
 * @typedef {{ label: string, pairs: { left: string, right: string }[] }} JoinCandidate
 */

// The CTE names of the statement's main query
function cteNames(workspace, path) {
    const top = getAt(workspace, splitPath(path)[0]);
    return new Set((top && Array.isArray(top.ctes) ? top.ctes : []).map((/** @type {any} */ c) => key(unquote(String(c.name || '').trim()))).filter(Boolean));
}

/** @returns {JoinSource | null} */
function resolveSource(source, ctes, tables) {
    if (!source || source.kind !== 'table') return null;
    const name = String(source.table || '').trim();
    if (!name || !isQualifiedName(name)) return null;
    const ref = String(source.alias || '').trim() || name;
    if (!name.includes('.') && ctes.has(key(unquote(name)))) return { ref, table: null };
    return { ref, table: lookupTable(tables, name.split('.').map(unquote).join('.')) || null };
}

/** True when nothing has been entered in the group */
export function isEmptyGroup(group) {
    return group.items.every((/** @type {any} */ item) => {
        if (item.kind === 'group') return isEmptyGroup(item);
        if (item.kind === 'raw') return blank(item.sql);
        return blank(item.left) && blank(item.value) && blank(item.value2) && !item.subquery;
    });
}

/**
 * The join at `path` (".../joins/i"), its known sources, and the ON
 * conditions the schema's foreign keys suggest.
 * @param {any} workspace
 * @param {string} path
 * @param {any[]} tables
 * @param {any} dialect
 */
export function analyzeJoin(workspace, path, tables, dialect) {
    const keys = splitPath(path);
    const index = Number(keys[keys.length - 1]);
    const select = getAt(workspace, keys.slice(0, -2).join('.'));
    const join = select && select.joins ? select.joins[index] : null;
    if (!join || join.type === 'CROSS JOIN') return null;
    const ctes = cteNames(workspace, path);
    const target = resolveSource(join.source, ctes, tables);
    const earlier = [select.from, ...select.joins.slice(0, index).map((/** @type {any} */ j) => j.source)]
        .map(s => resolveSource(s, ctes, tables))
        .filter((s) => s && s.table);
    if (!target || !target.table || !earlier.length) return { join, target, earlier: /** @type {JoinSource[]} */ (earlier), candidates: [] };

    const column = (/** @type {JoinSource} */ s, /** @type {string} */ name) => `${s.ref}.${writeName(name, dialect)}`;
    /** @type {JoinCandidate[]} */
    const candidates = [];
    const seen = new Set();
    const addCandidate = (/** @type {JoinSource} */ from, /** @type {string[]} */ fromColumns, /** @type {JoinSource} */ to, /** @type {string[]} */ toColumns) => {
        if (!toColumns.length || toColumns.length !== fromColumns.length) return;
        const pairs = fromColumns.map((c, k) => (from === target
            ? { left: column(to, toColumns[k]), right: column(from, c) }
            : { left: column(from, c), right: column(to, toColumns[k]) }));
        const label = pairs.map(p => `${p.left} = ${p.right}`).join(' AND ');
        if (seen.has(key(label))) return;
        seen.add(key(label));
        candidates.push({ label, pairs });
    };
    for (const s of earlier) {
        // An earlier table pointing at the new one first (a lookup, which
        // can't repeat rows), then the new table pointing back
        for (const fk of s.table.foreignKeys) {
            if (lookupTable(tables, fk.refTable) === target.table) addCandidate(s, fk.columns, target, fk.refColumns);
        }
        for (const fk of target.table.foreignKeys) {
            if (lookupTable(tables, fk.refTable) === s.table) addCandidate(target, fk.columns, s, fk.refColumns);
        }
    }
    return { join, target, earlier: /** @type {JoinSource[]} */ (earlier), candidates };
}

/**
 * Sets a join's ON to the suggested condition.
 * @param {any} join
 * @param {JoinCandidate} candidate
 */
export function applyJoinCandidate(join, candidate) {
    join.on = createGroup('AND', candidate.pairs.map(p => createCondition({ left: p.left, op: '=', valueType: 'column', value: p.right })));
}

// ---------------------------------------------------------------------------
// Schema checks
// ---------------------------------------------------------------------------

/**
 * Hints about names that aren't in the schema, and about joins.
 * @param {any} workspace
 * @param {any[]} tables
 * @param {any} dialect
 * @returns {{ level: 'info' | 'warning', category: 'schema', message: string, path: string }[]}
 */
export function checkSchema(workspace, tables, dialect) {
    if (!tables.length) return [];
    /** @type {{ level: 'info' | 'warning', category: 'schema', message: string, path: string }[]} */
    const issues = [];
    const add = (/** @type {'info' | 'warning'} */ level, /** @type {string} */ message, /** @type {string} */ path) => {
        if (!issues.some(i => i.path === path && i.message === message)) issues.push({ level, category: 'schema', message, path });
    };
    const root = workspace[workspace.type];
    if (!root) return issues;
    // Parts of an INSERT that aren't used stay unchecked
    const visible = root.kind === 'insert'
        ? { ...root, select: root.source === 'select' ? root.select : null, rows: root.source === 'select' ? [] : root.rows, upsert: root.upsert && root.upsert.mode ? root.upsert : null }
        : root;
    walkStrings(visible, workspace.type, (value, path) => checkField(workspace, path, value, tables, add));

    const hasForeignKeys = tables.some(t => t.foreignKeys.length);
    const selects = root.kind === 'select' ? [[root, workspace.type]] : root.kind === 'insert' && root.source === 'select' ? [[root.select, joinPath(workspace.type, 'select')]] : [];
    for (const [top, topPath] of selects) {
        forEachSelect(top, (q, sub) => {
            q.joins.forEach((/** @type {any} */ _, i) => checkJoin(workspace, joinPath(topPath, sub, 'joins', i), tables, dialect, hasForeignKeys, add));
        });
    }
    return issues;
}

// Every string in the query, with its path
function walkStrings(node, path, visit) {
    if (typeof node === 'string') {
        visit(node, path);
    } else if (Array.isArray(node)) {
        node.forEach((item, i) => walkStrings(item, `${path}.${i}`, visit));
    } else if (node && typeof node === 'object') {
        for (const [k, value] of Object.entries(node)) walkStrings(value, `${path}.${k}`, visit);
    }
}

function checkField(workspace, path, value, tables, add) {
    const text = String(value).trim();
    if (!text) return;
    const context = fieldContext(workspace, path, { tables });
    if (!context) return;
    if (context.kind === 'table') {
        if (!isQualifiedName(text)) return;
        if (!text.includes('.') && context.ctes.some(c => key(unquote(c)) === key(unquote(text)))) return;
        if (!lookupTable(tables, text.split('.').map(unquote).join('.'))) add('info', `“${text}” isn't in your schema.`, path);
        return;
    }
    const field = splitPath(path).pop();
    const list = field === 'columns' || field === 'conflict';
    const refs = list ? splitTopLevel(text).map(t => t.trim()).filter(Boolean) : [text];
    const sources = [...context.local, ...context.outer];
    for (const ref of refs) {
        if (!isColumnReference(ref) || ref.endsWith('*') || VALUE_WORDS.has(ref.toUpperCase())) continue;
        const parts = ref.split('.');
        const name = unquote(parts[parts.length - 1]);
        if (parts.length > 1) {
            const qualifier = unquote(parts.slice(0, -1).join('.'));
            const source = sources.find(s => key(unquote(s.ref)) === key(qualifier));
            if (source && source.table && !source.table.columns.some((/** @type {any} */ c) => key(c.name) === key(name))) {
                add('info', `“${ref}”: ${source.table.name} has no column ${name} in your schema.`, path);
            }
        } else if (sources.length && sources.every(s => s.table)
            && !sources.some(s => s.table.columns.some((/** @type {any} */ c) => key(c.name) === key(name)))
            && !context.outputs.some(o => key(unquote(o)) === key(name))
            && !sources.some(s => key(unquote(s.ref)) === key(name))) {
            const names = [...new Set(sources.map(s => s.table.name))];
            add('info', `“${ref}” isn't a column of ${names.length > 3 ? 'the tables in this query' : names.join(' or ')} in your schema.`, path);
        }
    }
}

/** Does `columns` include all of a primary or unique key of `table`? */
export function coversKey(table, columns) {
    const have = new Set(columns.map(key));
    return [table.primaryKey, ...table.unique].some((/** @type {string[]} */ k) => k.length > 0 && k.every(c => have.has(key(c))));
}

// col = col conditions at the top of an AND group, resolved to their tables
function equalityPairs(group, sources) {
    if (group.logic !== 'AND' || group.negate) return [];
    const resolve = (/** @type {string} */ text) => {
        const ref = String(text || '').trim();
        if (!isColumnReference(ref) || ref.endsWith('*')) return null;
        const parts = ref.split('.');
        const name = unquote(parts[parts.length - 1]);
        const matches = parts.length > 1
            ? sources.filter(s => key(unquote(s.ref)) === key(unquote(parts.slice(0, -1).join('.'))))
            : sources.filter(s => s.table.columns.some((/** @type {any} */ c) => key(c.name) === key(name)));
        return matches.length === 1 ? { source: matches[0], column: name } : null;
    };
    const pairs = [];
    for (const item of group.items) {
        if (item.kind !== 'condition' || item.op !== '=' || item.valueType !== 'column') continue;
        const a = resolve(item.left);
        const b = resolve(item.value);
        if (a && b && a.source !== b.source) pairs.push([a, b]);
    }
    return pairs;
}

function checkJoin(workspace, path, tables, dialect, hasForeignKeys, add) {
    const found = analyzeJoin(workspace, path, tables, dialect);
    if (!found || !found.target || !found.target.table || !found.earlier.length || isEmptyGroup(found.join.on)) return;
    const { target, earlier, candidates } = found;
    const onPath = joinPath(path, 'on');
    const pairs = equalityPairs(found.join.on, [...earlier, target]);
    const normal = (/** @type {string} */ text) => key(text.replace(/\s+/g, ''));
    const used = new Set(pairs.map(([a, b]) => [`${a.source.ref}.${a.column}`, `${b.source.ref}.${b.column}`].map(normal).sort().join('=')));

    if (candidates.length) {
        const matches = candidates.some(c => c.pairs.every(p => used.has([unquoteRef(p.left), unquoteRef(p.right)].map(normal).sort().join('='))));
        if (!matches) {
            add('info', `Your schema links ${target.table.name} by ${candidates[0].label}${candidates.length > 1 ? ` (or ${candidates.length - 1} other way${candidates.length > 2 ? 's' : ''})` : ''}; this ON condition uses other columns.`, onPath);
        }
    } else if (hasForeignKeys) {
        add('info', `No foreign key in your schema links ${target.table.name} to the tables before it; check that the ON condition is what you mean.`, onPath);
    }

    // Neither side a key: each row can match several rows on both sides
    for (const other of earlier) {
        const between = pairs
            .map(([a, b]) => (a.source === target && b.source === other ? [a, b] : b.source === target && a.source === other ? [b, a] : null))
            .filter(Boolean);
        if (!between.length) continue;
        if (!coversKey(target.table, between.map(([t]) => t.column)) && !coversKey(other.table, between.map(([, o]) => o.column))) {
            const described = between.map(([t, o]) => `${o.source.ref}.${o.column} = ${t.source.ref}.${t.column}`).join(' AND ');
            add('warning', `${described} isn't a key on either side, so a row can match several rows and results can repeat. Check the join, or use DISTINCT or GROUP BY if that's intended.`, onPath);
        }
    }
}

// "e.[unit price]" → "e.unit price"
function unquoteRef(ref) {
    const parts = ref.split('.');
    return [...parts.slice(0, -1), unquote(parts[parts.length - 1])].join('.');
}
