// Practice: checks a query against an exercise's goal by how it is built.
// Checks don't run SQL: a check looks at the query model (which tables
// are read, how they are joined, what is filtered, grouped and sorted), never
// at results. Checks accept the usual ways of writing the same thing: table
// aliases, quoted names, table-qualified columns, COUNT(*) or COUNT(id),
// ORDER BY an alias or a column number, and conditions at any depth.
//
// Exercises (exercises.js) describe their checks as plain data; this module
// is the only code that reads them.

import { forEachSelect, OPERATORS } from './model.js';
import { lex, significant } from './sql-lexer.js';
import { splitTopLevel, stripStrings } from './sql-utils.js';

const blank = (value) => String(value ?? '').trim() === '';
const lower = (/** @type {string} */ text) => String(text).toLowerCase();

/** A name part as compared: no quotes, lower case. */
function bare(token) {
    return lower(token.type === 'quoted' ? token.value : token.text);
}

/**
 * The names in an expression: c.name → ['c', 'name']. Function names are
 * left out, so COUNT(id) gives [['id']].
 * @param {string} text
 * @returns {string[][]}
 */
export function namesIn(text) {
    const tokens = significant(lex(String(text ?? '')));
    const chains = [];
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type !== 'word' && t.type !== 'quoted') continue;
        const chain = [bare(t)];
        while (tokens[i + 1]?.text === '.' && (tokens[i + 2]?.type === 'word' || tokens[i + 2]?.type === 'quoted')) {
            chain.push(bare(tokens[i + 2]));
            i += 2;
        }
        if (chain.length === 1 && t.type === 'word' && tokens[i + 1]?.text === '(') continue;
        chains.push(chain);
    }
    return chains;
}

/** The name a table source is read as: dbo.Orders → orders. */
const tableName = (/** @type {any} */ source) => (source.kind === 'table' && !blank(source.table)
    ? (namesIn(source.table)[0] || []).slice(-1)[0] || '' : '');

/** Table sources of a SELECT: FROM, then each join. */
const sourcesOf = (/** @type {any} */ q) => [q.from, ...q.joins.map((/** @type {any} */ j) => j.source)];

/**
 * Whether an expression refers to a column. `table` narrows it to a column
 * of that table: written bare, as table.column, or through an alias of it.
 * @param {string} text
 * @param {string} column
 * @param {{ table?: string, q?: any }} [where]
 */
export function mentions(text, column, { table, q } = {}) {
    const want = lower(column);
    return namesIn(text).some(chain => {
        if (chain[chain.length - 1] !== want) return false;
        if (!table || chain.length === 1) return true;
        const qualifier = chain[chain.length - 2];
        if (qualifier === lower(table)) return true;
        return Boolean(q) && sourcesOf(q).some(s => !blank(s.alias) && lower(String(s.alias).trim()) === qualifier && tableName(s) === lower(table));
    });
}

const AGGREGATE_CALL = /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(\s*(?:DISTINCT\s+)?([^()]*)\)/gi;

/**
 * The aggregates a select column computes: { fn, arg }.
 * @param {any} col
 */
export function aggregatesOf(col) {
    if (!col || col.kind !== 'column') return [];
    const found = [];
    if (col.aggregate) found.push({ fn: col.aggregate.split(' ')[0], arg: String(col.expr ?? '').trim() || '*' });
    for (const m of stripStrings(String(col.expr ?? '')).matchAll(AGGREGATE_CALL)) found.push({ fn: m[1].toUpperCase(), arg: m[2].trim() || '*' });
    return found;
}

/** Aggregates written in a piece of SQL text (HAVING conditions). */
function aggregatesIn(text) {
    return [...stripStrings(String(text ?? '')).matchAll(AGGREGATE_CALL)].map(m => ({ fn: m[1].toUpperCase(), arg: m[2].trim() || '*' }));
}

/** A literal as compared: no quotes or DATE prefix, lower case, numbers as numbers. */
export function valueKey(raw) {
    let text = String(raw ?? '').trim().replace(/^(date|timestamp)\s+(?=')/i, '');
    if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) text = text.slice(1, -1).replaceAll("''", "'");
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) return String(Number(text));
    return lower(text);
}

/** The values a condition compares with. */
function conditionValues(item) {
    const spec = OPERATORS[item.op];
    if (!spec) return [];
    if (spec.operands === 'list') return splitTopLevel(String(item.value ?? '')).filter(v => !blank(v)).map(valueKey);
    if (spec.operands === 2) return [valueKey(item.value), valueKey(item.value2)];
    if (spec.operands === 1) return [valueKey(item.value)];
    return [];
}

/**
 * The conditions in a group that every row must meet: the ones reached
 * through AND only, so "a = 1 OR b = 2" requires neither, and NOT (…)
 * requires nothing inside it. anyLogic: every condition, at any depth.
 */
function conditionsIn(group, anyLogic = false) {
    const binding = anyLogic || (!group.negate && (group.logic !== 'OR' || group.items.length === 1));
    if (!binding) return [];
    return group.items.flatMap((/** @type {any} */ item) => (item.kind === 'group' ? conditionsIn(item, anyLogic) : item.kind === 'condition' ? [item] : []));
}

// ------------------------------------------------------------------- scopes

/**
 * The SELECTs a check looks in.
 * main: the main query (default); any: every SELECT; sub: every SELECT but
 * the main one; cte: the SELECTs inside CTEs.
 */
function blocksOf(query, scope = 'main') {
    if (!query || query.kind !== 'select') return [];
    if (scope === 'main') return [query];
    /** @type {any[]} */
    const out = [];
    forEachSelect(query, (q, path) => {
        if (scope === 'any' || (scope === 'sub' && path !== '') || (scope === 'cte' && path.startsWith('ctes.'))) out.push(q);
    });
    return out;
}

/** The WHERE groups a check looks in: a SELECT's clause, or an UPDATE's or DELETE's WHERE. */
function groupsOf(query, clause, scope) {
    if (query && (query.kind === 'update' || query.kind === 'delete')) return clause === 'where' ? [{ group: query.where, q: null }] : [];
    return blocksOf(query, scope).flatMap(q => (clause === 'on'
        ? q.joins.map((/** @type {any} */ j) => ({ group: j.on, q }))
        : [{ group: q[clause], q }]));
}

// ------------------------------------------------------------------- checks

const anyOf = (list, value) => !list || list.includes(value);

/**
 * Each test reads one kind of check. They never throw on an unfinished
 * query: a missing part just doesn't pass.
 * @type {Record<string, (spec: any, query: any, workspace: any) => boolean>}
 */
const TESTS = {
    type: (spec, _query, ws) => ws.type === spec.type,

    // The table an INSERT, UPDATE or DELETE changes
    target: (spec, query) => query.kind !== 'select' && !blank(query.table)
        && tableName({ kind: 'table', table: query.table }) === lower(spec.table),

    reads: (spec, query) => blocksOf(query, spec.in || 'any')
        .some(q => sourcesOf(q).some(s => tableName(s) === lower(spec.table))),

    // A join between two tables (the same one twice for a self-join), with
    // an ON condition. keep: the table whose rows all stay (LEFT/RIGHT JOIN).
    join: (spec, query) => blocksOf(query, spec.in || 'any').some(q => q.joins.some((/** @type {any} */ join, i) => {
        const [a, b] = spec.tables.map(lower);
        const joined = tableName(join.source);
        const earlier = sourcesOf(q).slice(0, i + 1).map(tableName);
        const links = (joined === b && earlier.includes(a)) || (joined === a && earlier.includes(b));
        if (!links || !anyOf(spec.types, join.type)) return false;
        if (join.type !== 'CROSS JOIN' && conditionsIn(join.on, true).length === 0 && !join.on.items.some((/** @type {any} */ it) => it.kind === 'raw' && !blank(it.sql))) return false;
        if (!spec.keep) return true;
        const keep = lower(spec.keep);
        return join.type === 'FULL JOIN' || (join.type === 'LEFT JOIN' && joined !== keep) || (join.type === 'RIGHT JOIN' && joined === keep);
    })),

    // A select-list column. aggregate: one of these functions over it (or
    // over anything, without a column). count: how many such columns.
    select: (spec, query) => blocksOf(query, spec.in).some(q => {
        const matches = q.columns.filter((/** @type {any} */ col) => {
            if (spec.aggregate) {
                // allowStar: COUNT(*) counts the same rows as COUNT(column)
                return aggregatesOf(col).some(a => spec.aggregate.includes(a.fn)
                    && (!spec.column || mentions(a.arg, spec.column, { table: spec.table, q }) || (a.arg === '*' && spec.allowStar)));
            }
            if (col.kind === 'column') return aggregatesOf(col).length === 0 && mentions(col.expr, spec.column, { table: spec.table, q });
            if (col.kind === 'case') return col.cases.some((/** @type {any} */ c) => mentions(c.when, spec.column) || mentions(c.then, spec.column));
            return false;
        });
        return matches.length >= (spec.count || 1);
    }),

    // A condition on a column that every row must meet. clause: where
    // (default), having or on; anyLogic: also one joined with OR.
    filter: (spec, query) => groupsOf(query, spec.clause || 'where', spec.in).some(({ group, q }) => conditionsIn(group, spec.anyLogic).some(c => {
        if (!anyOf(spec.ops, c.op) || c.valueType === 'subquery') return false;
        if (!mentions(c.left, spec.column, { table: spec.table, q })) return false;
        if (!spec.values) return true;
        // A typed literal (DATE '2026-01-01') is read as an expression
        if (c.valueType !== 'value' && c.valueType !== 'column') return false;
        const have = conditionValues(c);
        const want = spec.values.map(valueKey);
        return have.length === want.length && want.every((/** @type {string} */ v) => have.includes(v));
    })),

    // A HAVING condition on an aggregate, written out or by its alias
    having: (spec, query) => blocksOf(query, spec.in).some(q => conditionsIn(q.having).some(c => {
        if (!anyOf(spec.ops, c.op)) return false;
        const direct = aggregatesIn(c.left).some(a => spec.aggregate.includes(a.fn));
        const byAlias = q.columns.some((/** @type {any} */ col) => !blank(col.alias)
            && namesIn(c.left).some(chain => chain.length === 1 && chain[0] === lower(String(col.alias).trim()))
            && aggregatesOf(col).some(a => spec.aggregate.includes(a.fn)));
        if (!direct && !byAlias) return false;
        return !spec.values || (c.valueType === 'value' && spec.values.map(valueKey).every((/** @type {string} */ v) => conditionValues(c).includes(v)));
    })),

    groupBy: (spec, query) => blocksOf(query, spec.in).some(q => q.groupBy.some((/** @type {any} */ g) => mentions(g.expr, spec.column, { table: spec.table, q }))),

    // ORDER BY the column itself, an alias of a column using it, or its number
    orderBy: (spec, query) => blocksOf(query, spec.in).some(q => q.orderBy.some((/** @type {any} */ item) => {
        if (spec.direction && item.direction !== spec.direction) return false;
        const text = String(item.expr ?? '').trim();
        const uses = (/** @type {any} */ col) => col.kind === 'column' && (mentions(col.expr, spec.column) || aggregatesOf(col).some(a => mentions(a.arg, spec.column)));
        if (mentions(text, spec.column, { table: spec.table, q })) return true;
        if (/^\d+$/.test(text)) {
            const col = q.columns[Number(text) - 1];
            return Boolean(col) && uses(col);
        }
        return q.columns.some((/** @type {any} */ col) => !blank(col.alias) && lower(String(col.alias).trim()) === lower(text.replace(/^["`[]|["`\]]$/g, '')) && uses(col));
    })),

    limit: (spec, query) => blocksOf(query, spec.in).some(q => !blank(q.limit) && valueKey(q.limit) === valueKey(spec.value)),

    distinct: (spec, query) => blocksOf(query, spec.in).some(q => q.distinct),

    // A window function; partitionBy / orderBy: a column it uses there
    window: (spec, query) => blocksOf(query, spec.in || 'any').some(q => q.columns.some((/** @type {any} */ col) => col.kind === 'window'
        && anyOf(spec.funcs, col.func)
        && (!spec.partitionBy || col.partitionBy.some((/** @type {any} */ p) => mentions(p.expr, spec.partitionBy)))
        && (!spec.orderBy || col.orderBy.some((/** @type {any} */ o) => mentions(o.expr, spec.orderBy) && (!spec.direction || o.direction === spec.direction))))),

    // A subquery in a condition (IN, EXISTS, a comparison)
    subquery: (spec, query) => groupsOf(query, spec.clause || 'where', spec.in).some(({ group, q }) => conditionsIn(group).some(c => c.valueType === 'subquery' && c.subquery
        && anyOf(spec.ops, c.op) && (!spec.column || mentions(c.left, spec.column, { table: spec.table, q })))),

    // A named CTE (recursive: true for WITH RECURSIVE), and with used: true,
    // one the main query reads
    cte: (spec, query) => query.kind === 'select' && query.ctes.some((/** @type {any} */ cte) => {
        if (blank(cte.name) || (spec.recursive && !cte.recursive)) return false;
        if (!spec.used) return true;
        const name = (namesIn(cte.name)[0] || [''])[0];
        return sourcesOf(query).some(s => tableName(s) === name);
    }),

    setOp: (spec, query) => blocksOf(query, spec.in || 'any').some(q => q.setOps.some((/** @type {any} */ s) => anyOf(spec.ops, s.op))),

    // An UPDATE's SET column
    assign: (spec, query) => query.kind === 'update' && query.set.some((/** @type {any} */ a) => mentions(a.column, spec.column)
        && (!spec.mentions || (a.valueType === 'column' && mentions(a.value, spec.mentions)))),

    // Passes when any of its checks passes: two ways to reach the same goal
    anyOf: (spec, query, ws) => spec.of.some((/** @type {any} */ inner) => runTest(inner, query, ws)),

    // Passes when all of its checks pass: one way that needs several parts
    allOf: (spec, query, ws) => spec.of.every((/** @type {any} */ inner) => runTest(inner, query, ws)),

    // None of these passes: a check that a part was left out
    none: (spec, query, ws) => !spec.of.some((/** @type {any} */ inner) => runTest(inner, query, ws))
};

/** Every kind of check, for validating exercise data. */
export const CHECK_KINDS = Object.freeze(Object.keys(TESTS));

function runTest(spec, query, ws) {
    const test = TESTS[spec.kind];
    if (!test) throw new Error(`Unknown practice check: ${spec.kind}`);
    try {
        return Boolean(test(spec, query, ws));
    } catch {
        return false;
    }
}

/**
 * Checks a workspace against an exercise.
 * @param {{ checks: { label: string, hint: string, test: any }[] }} exercise
 * @param {any} workspace
 * @param {{ errors?: number }} [options] how many errors the validator found
 * @returns {{ passed: boolean, results: { label: string, hint: string, ok: boolean }[] }}
 */
export function checkExercise(exercise, workspace, { errors = 0 } = {}) {
    const query = workspace[workspace.type];
    const results = exercise.checks.map(c => ({ label: c.label, hint: c.hint, ok: runTest(c.test, query, workspace) }));
    results.push({
        label: 'The query has no errors',
        hint: errors === 1 ? 'Fix the error listed under Checks first.' : `Fix the ${errors} errors listed under Checks first.`,
        ok: errors === 0
    });
    return { passed: results.every(r => r.ok), results };
}

// ------------------------------------------------------------------ progress

const PRACTICE_KEY = 'practice';

/**
 * Which exercises are done and which one is open, kept in this browser.
 * Stored data is read as untrusted: only known exercise ids and plain
 * timestamps are kept.
 * @param {any} storage
 * @param {string[]} knownIds
 */
export function createPracticeStore(storage, knownIds) {
    const known = new Set(knownIds);
    /** @type {Record<string, number>} */
    let done = {};
    /** @type {string | null} */
    let active = null;

    const stored = storage.get(PRACTICE_KEY, null);
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
        if (stored.done && typeof stored.done === 'object' && !Array.isArray(stored.done)) {
            for (const [id, time] of Object.entries(stored.done)) {
                if (known.has(id) && Number.isFinite(time) && time > 0) done[id] = /** @type {number} */ (time);
            }
        }
        if (typeof stored.active === 'string' && known.has(stored.active)) active = stored.active;
    }

    const persist = () => {
        if (Object.keys(done).length || active) storage.set(PRACTICE_KEY, { done, active });
        else storage.remove(PRACTICE_KEY);
    };

    return {
        get active() { return active; },
        /** @param {string | null} id */
        setActive(id) {
            active = id && known.has(id) ? id : null;
            persist();
        },
        isDone: (/** @type {string} */ id) => Object.hasOwn(done, id),
        get doneCount() { return Object.keys(done).length; },
        /** @param {string} id @param {number} [time] */
        markDone(id, time = Date.now()) {
            if (!known.has(id) || Object.hasOwn(done, id)) return;
            done = { ...done, [id]: time };
            persist();
        },
        clear() {
            done = {};
            active = null;
            persist();
        }
    };
}
