// Analysis rules: valid SQL that is probably not what was meant, or that can
// be written more clearly, plus an at-a-glance summary of a query's shape.
// Everything is worked out from the query model; nothing looks at a database
// or claims anything about speed. The validator reports the findings with its
// own scopes and paths.
//
// The rules are deliberately conservative: when a condition can't be read
// with certainty (hand-written SQL, parameters, unqualified names), the rule
// says nothing rather than guess.

import { forEachSelect, countConditions, OPERATORS } from './model.js';
import { normalizeExpr, isNumberLiteral, hasLeadingZero, isQuotedString, containsAggregateCall, isIdentifier } from './sql-utils.js';
import { lex, significant } from './sql-lexer.js';

// Subqueries nested this deep get a suggestion to use CTEs
export const DEEP_NESTING = 3;

const blank = (value) => String(value ?? '').trim() === '';

// ------------------------------------------------------------ conditions

/** The SQL a literal value becomes, for comparing two values. */
function valueKey(raw) {
    const text = String(raw ?? '').trim();
    if (isQuotedString(text)) return text;
    if (isNumberLiteral(text) && !hasLeadingZero(text)) return `n:${Number(text)}`;
    if (/^(null|true|false)$/i.test(text)) return text.toUpperCase();
    return `'${text.replace(/'/g, "''")}'`;
}

/**
 * What a condition compares, for spotting repeats; null when two identical
 * looking conditions could still differ (parameters are bound separately).
 */
function conditionKey(item) {
    if (item.kind === 'raw') return blank(item.sql) ? null : `raw:${normalizeExpr(String(item.sql))}`;
    if (item.kind !== 'condition' || item.valueType === 'param') return null;
    // Unfinished conditions are reported as errors already
    const spec = OPERATORS[item.op];
    if (!spec || (!spec.noLeft && blank(item.left))) return null;
    if (item.valueType === 'subquery' ? !item.subquery : spec.operands !== 0 && blank(item.value)) return null;
    const rhs = item.valueType === 'subquery' ? JSON.stringify(item.subquery)
        : item.valueType === 'column' ? `${normalizeExpr(String(item.value))}|${normalizeExpr(String(item.value2))}`
            : `${valueKey(item.value)}|${valueKey(item.value2)}`;
    return `${normalizeExpr(String(item.left))}|${item.op}|${item.valueType}|${rhs}`;
}

/**
 * Conditions that repeat an earlier one in the same group.
 * @returns {{ index: number, first: number }[]}
 */
export function duplicateConditions(group) {
    const seen = new Map();
    const found = [];
    group.items.forEach((item, index) => {
        const key = conditionKey(item);
        if (key === null) return;
        if (seen.has(key)) found.push({ index, first: seen.get(key) });
        else seen.set(key, index);
    });
    return found;
}

/** A number the database compares as a number, or null. */
function numberOf(raw) {
    const text = String(raw ?? '').trim();
    return isNumberLiteral(text) && !hasLeadingZero(text) ? Number(text) : null;
}

/**
 * A text value that can't be read as a date or number under any collation or
 * conversion: letters, spaces, _ and -. Case and trailing spaces are ignored
 * because many databases compare text that way.
 */
function wordOf(raw) {
    let text = String(raw ?? '').trim();
    if (isQuotedString(text)) text = text.slice(1, -1).replace(/''/g, "'");
    else if (/^(null|true|false)$/i.test(text) || isNumberLiteral(text)) return null;
    return /^[A-Za-z][A-Za-z _-]*$/.test(text) ? text.replace(/ +$/, '').toLowerCase() : null;
}

/**
 * The values a condition allows, when it can be read with certainty:
 * a numeric interval, or one word.
 */
function constraintOf(item) {
    if (item.kind !== 'condition' || item.valueType !== 'value' || blank(item.left)) return null;
    const n = numberOf(item.value);
    const text = String(item.value).trim();
    switch (item.op) {
        case '=':
            if (n !== null) return { lo: n, loIn: true, hi: n, hiIn: true, text: `= ${text}` };
            return wordOf(item.value) === null ? null : { word: wordOf(item.value), text: `= ${text}` };
        case '>': return n === null ? null : { lo: n, loIn: false, hi: Infinity, hiIn: false, text: `> ${text}` };
        case '>=': return n === null ? null : { lo: n, loIn: true, hi: Infinity, hiIn: false, text: `>= ${text}` };
        case '<': return n === null ? null : { lo: -Infinity, loIn: false, hi: n, hiIn: false, text: `< ${text}` };
        case '<=': return n === null ? null : { lo: -Infinity, loIn: false, hi: n, hiIn: true, text: `<= ${text}` };
        case 'BETWEEN': {
            const n2 = numberOf(item.value2);
            if (n === null || n2 === null) return null;
            return { lo: n, loIn: true, hi: n2, hiIn: true, text: `between ${text} and ${String(item.value2).trim()}` };
        }
        default: return null;
    }
}

function conflicts(a, b) {
    if ('word' in a || 'word' in b) return 'word' in a && 'word' in b && a.word !== b.word;
    // The overlap of the two ranges, and whether each end is included
    const lo = Math.max(a.lo, b.lo);
    const hi = Math.min(a.hi, b.hi);
    if (lo > hi) return true;
    if (lo < hi) return false;
    const loIn = (a.lo < lo || a.loIn) && (b.lo < lo || b.loIn);
    const hiIn = (a.hi > hi || a.hiIn) && (b.hi > hi || b.hiIn);
    return !(loIn && hiIn);
}

/**
 * Pairs of conditions in one AND group that can never both be true, such as
 * price > 50 AND price < 10. Checking pairs is enough: a set of ranges on one
 * line has no common value only when two of them don't overlap.
 * @returns {{ index: number, first: number, column: string, text: string, firstText: string }[]}
 */
export function contradictions(group) {
    if (group.logic !== 'AND' || group.negate) return [];
    /** @type {Map<string, { index: number, c: any }[]>} */
    const byColumn = new Map();
    const found = [];
    group.items.forEach((item, index) => {
        const c = constraintOf(item);
        if (!c) return;
        const key = normalizeExpr(String(item.left));
        const earlier = byColumn.get(key) || [];
        const clash = earlier.find(e => conflicts(e.c, c));
        if (clash) found.push({ index, first: clash.index, column: String(item.left).trim(), text: c.text, firstText: clash.c.text });
        earlier.push({ index, c });
        byColumn.set(key, earlier);
    });
    return found;
}

/** BETWEEN 50 AND 10: never true, because the lower bound must come first. */
export function isReversedBetween(item) {
    if (item.kind !== 'condition' || item.valueType !== 'value' || item.op !== 'BETWEEN') return false;
    const lo = numberOf(item.value);
    const hi = numberOf(item.value2);
    return lo !== null && hi !== null && lo > hi;
}

// ------------------------------------------------------------ joins

// Words that can appear bare in an ON condition without naming a column
const CONDITION_WORDS = new Set(['AND', 'OR', 'NOT', 'NULL', 'IS', 'TRUE', 'FALSE', 'IN', 'LIKE', 'BETWEEN']);

const bareName = (text) => String(text ?? '').trim().replace(/^["`[]|["`\]]$/g, '').toLowerCase();

/**
 * The tables an ON condition refers to by qualified name (o.customer_id →
 * "o"), or null when it can't be told with certainty: hand-written SQL,
 * subqueries, parameters, or a bare name that could belong to any table.
 * @returns {Set<string> | null}
 */
export function referencedTables(group) {
    const tables = new Set();
    const read = (text) => {
        const tokens = significant(lex(String(text ?? '')));
        for (let i = 0; i < tokens.length; i++) {
            const t = tokens[i];
            if (t.type !== 'word' && t.type !== 'quoted') continue;
            // A name chain: a.b or schema.table.column
            const chain = [t];
            while (tokens[i + 1]?.text === '.' && tokens[i + 2] && (tokens[i + 2].type === 'word' || tokens[i + 2].type === 'quoted')) {
                chain.push(tokens[i + 2]);
                i += 2;
            }
            if (chain.length > 1) {
                tables.add(bareName(chain[chain.length - 2].type === 'quoted' ? chain[chain.length - 2].value : chain[chain.length - 2].text));
            } else if (t.type === 'word') {
                const next = tokens[i + 1];
                const isCall = next?.text === '(';
                const isTypedLiteral = next?.type === 'string';
                if (!isCall && !isTypedLiteral && !CONDITION_WORDS.has(t.text.toUpperCase())) return false;
            } else {
                return false; // a quoted bare name
            }
        }
        return true;
    };
    const walk = (g) => g.items.every(item => {
        if (item.kind === 'group') return walk(item);
        if (item.kind !== 'condition' || item.valueType === 'subquery' || item.valueType === 'param') return false;
        if (!read(item.left)) return false;
        return item.valueType !== 'column' || (read(item.value) && read(item.value2));
    });
    return walk(group) ? tables : null;
}

/** Names a FROM or JOIN source can be referred to by. */
export function sourceNames(source) {
    if (!blank(source.alias)) return [bareName(source.alias)];
    if (source.kind !== 'table' || blank(source.table)) return [];
    const parts = String(source.table).trim().split('.').map(bareName);
    return [...new Set([parts.join('.'), parts[parts.length - 1]])];
}

/**
 * Whether a join's ON condition links it to the tables before it.
 * @returns {'unlinked-earlier' | 'unlinked-joined' | null} which side the
 *   condition never mentions, or null when it links both or can't be told
 */
export function joinLink(join, earlierNames) {
    if (join.type === 'CROSS JOIN' || countConditions(join.on) === 0) return null;
    const own = new Set(sourceNames(join.source));
    const earlier = new Set(earlierNames);
    if (own.size === 0) return null;
    const tables = referencedTables(join.on);
    if (!tables || tables.size === 0) return null;
    // A name that is neither side (a typo, or an outer query): can't tell
    if ([...tables].some(t => !own.has(t) && !earlier.has(t))) return null;
    const mentionsOwn = [...tables].some(t => own.has(t));
    const mentionsEarlier = [...tables].some(t => earlier.has(t) && !own.has(t));
    if (mentionsOwn && !mentionsEarlier) return 'unlinked-earlier';
    if (mentionsEarlier && !mentionsOwn) return 'unlinked-joined';
    return null;
}

// ------------------------------------------------------------ aliases

/** Every piece of text in a query, except its aliases, for finding references. */
export function statementTexts(query) {
    const texts = [];
    const walk = (value, key) => {
        if (typeof value === 'string') {
            if (key !== 'alias' && key !== 'kind' && value.includes('.')) texts.push(value);
        } else if (Array.isArray(value)) {
            value.forEach(v => walk(v, ''));
        } else if (value && typeof value === 'object') {
            for (const [k, v] of Object.entries(value)) walk(v, k);
        }
    };
    walk(query, '');
    return texts;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether any text qualifies a column with this name: c.id, "c".id, [c].id */
export function isReferenced(name, texts) {
    const n = escapeRegExp(name);
    const re = new RegExp(`(?<![\\w$.])(?:${n}|"${n}"|\`${n}\`|\\[${n}\\])\\s*\\.`, 'i');
    return texts.some(text => re.test(text));
}

/** A table alias that nothing in the statement refers to. */
export function isUnusedAlias(source, texts) {
    if (source.kind !== 'table' || blank(source.alias) || !isIdentifier(String(source.alias).trim())) return false;
    return !isReferenced(String(source.alias).trim(), texts);
}

// ------------------------------------------------------------ select list

const isWildcard = (col) => col.kind === 'column' && !col.aggregate && /(^|\.)\*$/.test(String(col.expr).trim());

/** Index of a plain SELECT * (or t.*) column, or -1. */
export function wildcardColumn(q) {
    return q.columns.findIndex(isWildcard);
}

/**
 * DISTINCT that can't change the result: every GROUP BY key is selected, so
 * each group is already one distinct row.
 */
export function isRedundantDistinct(q) {
    if (!q.distinct || q.groupBy.length === 0 || q.columns.some(isWildcard)) return false;
    const selected = new Set();
    for (const col of q.columns) {
        if (col.kind !== 'column' || col.aggregate || containsAggregateCall(col.expr)) continue;
        selected.add(normalizeExpr(String(col.expr).trim()));
        if (!blank(col.alias)) selected.add(normalizeExpr(String(col.alias).trim()));
    }
    const keys = q.groupBy.map(g => normalizeExpr(String(g.expr).trim())).filter(Boolean);
    return keys.length > 0 && keys.every(k => selected.has(k));
}

// ------------------------------------------------------------ insights

/** How deeply subqueries and CTEs are nested (UNION parts don't count). */
export function nestingDepth(select) {
    let deepest = 0;
    const visit = (q, depth) => {
        deepest = Math.max(deepest, depth);
        q.ctes.forEach(cte => visit(cte.query, depth + 1));
        if (q.from.kind === 'subquery') visit(q.from.query, depth + 1);
        q.joins.forEach(join => {
            if (join.source.kind === 'subquery') visit(join.source.query, depth + 1);
            groupSubqueries(join.on, sub => visit(sub, depth + 1));
        });
        groupSubqueries(q.where, sub => visit(sub, depth + 1));
        groupSubqueries(q.having, sub => visit(sub, depth + 1));
        q.setOps.forEach(s => visit(s.query, depth));
    };
    visit(select, 0);
    return deepest;
}

function groupSubqueries(group, visit) {
    group.items.forEach(item => {
        if (item.kind === 'group') groupSubqueries(item, visit);
        else if (item.kind === 'condition' && item.valueType === 'subquery' && item.subquery) visit(item.subquery);
    });
}

const isAggregateColumn = (col) => (col.kind === 'column' && (Boolean(col.aggregate) || containsAggregateCall(col.expr)))
    || (col.kind === 'case' && col.cases.some(c => containsAggregateCall(c.when) || containsAggregateCall(c.then)));

export const BANDS = ['simple', 'moderate', 'involved'];

/**
 * How many parts a SELECT has, and a rough band. The band is about how much
 * there is to read and check, not about how fast the query runs.
 */
export function describeInsights(select) {
    let selects = 0;
    let joins = 0;
    let setOps = 0;
    let aggregates = 0;
    let windows = 0;
    let filters = 0;
    let groups = 0;
    forEachSelect(select, (q) => {
        selects++;
        joins += q.joins.length;
        setOps += q.setOps.length;
        aggregates += q.columns.filter(isAggregateColumn).length;
        windows += q.columns.filter(c => c.kind === 'window').length;
        filters += countConditions(q.where) + countConditions(q.having);
        if (q.groupBy.length) groups++;
    });
    const ctes = select.ctes.length;
    const subqueries = selects - 1 - ctes - setOps;
    const depth = nestingDepth(select);
    const score = joins + ctes + setOps + 2 * subqueries + (aggregates || groups ? 1 : 0) + (windows ? 1 : 0) + Math.floor(filters / 3);
    const band = depth >= DEEP_NESTING || score >= 6 ? 'involved' : depth >= 2 || score >= 2 ? 'moderate' : 'simple';
    return { ctes, joins, subqueries, setOps, aggregates, windows, filters, depth, band };
}
