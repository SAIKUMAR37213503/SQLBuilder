// Reading the T-SQL statement shapes SQLite has no direct form for: MERGE,
// CROSS / OUTER APPLY, PIVOT / UNPIVOT and CREATE TRIGGER. The engine
// (engine.js) runs what these describe; this file only finds the parts.
//
// It follows SQL Server's documented syntax (learn.microsoft.com T-SQL
// reference). It isn't SQL Server and uses none of its code.

import { sigTokens, TsqlSyntaxError } from './parse.js';
import { splitName, unquote } from './modules.js';

/** @typedef {import('./parse.js').Sig} Sig */

/** Index of the token closing the parenthesis at `open`, or -1. */
export function closeParen(sig, open) {
    let depth = 0;
    for (let k = open; k < sig.length; k++) {
        if (sig[k].t !== 'p') continue;
        if (sig[k].v === '(') depth++;
        else if (sig[k].v === ')' && --depth === 0) return k;
    }
    return -1;
}

/** Splits tokens [from, to) at depth-0 commas into [start, end) ranges. */
export function commaRanges(sig, from, to) {
    const out = [];
    let depth = 0;
    let start = from;
    for (let k = from; k < to; k++) {
        const t = sig[k];
        if (t.t !== 'p') continue;
        if (t.v === '(') depth++;
        else if (t.v === ')') depth--;
        else if (t.v === ',' && depth === 0) {
            out.push([start, k]);
            start = k + 1;
        }
    }
    if (to > start) out.push([start, to]);
    return out;
}

/** A dotted name starting at k: [db.][schema.]name; returns its end (exclusive). */
export function nameEnd(sig, k) {
    let j = k;
    if (!sig[j] || (sig[j].t !== 'word' && sig[j].t !== 'ident')) return k;
    j++;
    while (sig[j]?.v === '.' && (sig[j + 1]?.t === 'word' || sig[j + 1]?.t === 'ident' || sig[j + 1]?.v === '.')) {
        j++;
        if (sig[j].v === '.') continue;
        j++;
    }
    return j;
}

const CLAUSE_WORDS = new Set(['WHERE', 'GROUP', 'ORDER', 'HAVING', 'UNION', 'EXCEPT', 'INTERSECT', 'OPTION', 'FOR', 'WINDOW', 'JOIN', 'INNER', 'LEFT',
    'RIGHT', 'FULL', 'CROSS', 'OUTER', 'ON', 'USING', 'WHEN', 'OUTPUT', 'SET', 'PIVOT', 'UNPIVOT', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'APPLY',
    'WITH', 'INTO', 'FROM', 'VALUES', 'AS', 'THEN', 'AND', 'OR', 'NOT', 'NATURAL', 'LIMIT', 'OFFSET', 'FETCH', 'GO', 'TABLESAMPLE']);

/** An alias at k ([AS] name), if there is one: { alias, end }. */
export function aliasAt(sig, k) {
    let j = k;
    if (sig[j]?.u === 'AS') j++;
    const t = sig[j];
    if (t && (t.t === 'ident' || (t.t === 'word' && !t.v.startsWith('@') && !CLAUSE_WORDS.has(t.u)))) return { alias: unquote(t.v), end: j + 1 };
    return { alias: '', end: k };
}

const text = (src, sig, a, b) => (b > a ? src.slice(sig[a].start, sig[b - 1].end) : '');

// ---- MERGE

/**
 * @typedef {{ match: 'matched' | 'target' | 'source', cond: string, action: 'update' | 'delete' | 'insert',
 *   sets: { column: string, expr: string }[], columns: string[], values: string[] | null }} MergeClause
 * @typedef {{ target: string, targetAlias: string, source: { kind: 'table' | 'query' | 'values', text: string, columns: string[] },
 *   sourceAlias: string, on: string, clauses: MergeClause[], output: { list: string, into: string, intoColumns: string } | null }} Merge
 */

/**
 * Reads a MERGE statement.
 * @param {string} src
 * @param {number} [base] its offset in the script, for errors
 * @returns {Merge}
 */
export function parseMerge(src, base = 0) {
    const sig = sigTokens(src);
    const fail = (/** @type {string} */ message, /** @type {number} */ k) => {
        throw new TsqlSyntaxError(message, base + (sig[k]?.start ?? src.length));
    };
    let k = 1;
    if (sig[k]?.u === 'TOP') fail('MERGE TOP (n) isn\'t supported in SQL Lab.', k);
    if (sig[k]?.u === 'INTO') k++;
    const targetStart = k;
    k = nameEnd(sig, k);
    if (k === targetStart) fail('MERGE needs a target table.', k);
    const target = text(src, sig, targetStart, k);
    if (sig[k]?.u === 'WITH' && sig[k + 1]?.v === '(') k = closeParen(sig, k + 1) + 1;
    let a = aliasAt(sig, k);
    const targetAlias = a.alias || splitName(target).name;
    k = a.end;
    if (sig[k]?.u !== 'USING') fail('MERGE needs USING and the source of the rows.', k);
    k++;
    /** @type {Merge['source']} */
    let source;
    if (sig[k]?.v === '(') {
        const close = closeParen(sig, k);
        if (close < 0) fail('A parenthesis isn\'t closed.', k);
        const inner = text(src, sig, k + 1, close);
        source = { kind: sig[k + 1]?.u === 'VALUES' ? 'values' : 'query', text: inner, columns: [] };
        k = close + 1;
    } else {
        const start = k;
        k = nameEnd(sig, k);
        if (k === start) fail('MERGE … USING needs a table or a query in parentheses.', k);
        source = { kind: 'table', text: text(src, sig, start, k), columns: [] };
    }
    a = aliasAt(sig, k);
    const sourceAlias = a.alias || (source.kind === 'table' ? splitName(source.text).name : '');
    if (!sourceAlias) fail('The source of MERGE needs an alias: USING (…) AS s.', k);
    k = a.end;
    if (sig[k]?.v === '(') {
        const close = closeParen(sig, k);
        source.columns = commaRanges(sig, k + 1, close).map(([x, y]) => unquote(text(src, sig, x, y)));
        k = close + 1;
    }
    if (source.kind === 'values' && !source.columns.length) fail('VALUES as a MERGE source needs column names: AS s (Id, Name).', k);
    if (sig[k]?.u !== 'ON') fail('MERGE needs ON and the condition that matches rows.', k);
    k++;
    const onStart = k;
    while (k < sig.length && !(sig[k].u === 'WHEN' && depthAt(sig, onStart, k) === 0)) k++;
    const on = text(src, sig, onStart, k);
    if (!on.trim()) fail('MERGE … ON needs a condition.', k);
    /** @type {MergeClause[]} */
    const clauses = [];
    let output = null;
    while (k < sig.length) {
        const t = sig[k];
        if (t.v === ';' && t.t === 'p') {
            k++;
            continue;
        }
        if (t.u === 'OUTPUT') {
            const start = k + 1;
            let end = start;
            while (end < sig.length && !((sig[end].u === 'INTO' || sig[end].u === 'OPTION' || sig[end].v === ';') && depthAt(sig, start, end) === 0)) end++;
            output = { list: text(src, sig, start, end), into: '', intoColumns: '' };
            k = end;
            if (sig[k]?.u === 'INTO') {
                const s2 = k + 1;
                k = nameEnd(sig, s2);
                if (k === s2 && sig[s2]?.t === 'word') k = s2 + 1;
                output.into = text(src, sig, s2, k);
                if (sig[k]?.v === '(') {
                    const close = closeParen(sig, k);
                    output.intoColumns = text(src, sig, k + 1, close);
                    k = close + 1;
                }
            }
            continue;
        }
        if (t.u === 'OPTION' && sig[k + 1]?.v === '(') {
            k = closeParen(sig, k + 1) + 1;
            continue;
        }
        if (t.u !== 'WHEN') fail(`Incorrect syntax near '${t.v}' in MERGE.`, k);
        k++;
        /** @type {MergeClause['match']} */
        let match = 'matched';
        if (sig[k]?.u === 'NOT') {
            k++;
            match = 'target';
        }
        if (sig[k]?.u !== 'MATCHED') fail('WHEN needs MATCHED or NOT MATCHED.', k);
        k++;
        if (sig[k]?.u === 'BY') {
            if (match !== 'target') fail('BY TARGET / BY SOURCE goes after NOT MATCHED.', k);
            if (sig[k + 1]?.u === 'SOURCE') match = 'source';
            else if (sig[k + 1]?.u !== 'TARGET') fail('NOT MATCHED BY needs TARGET or SOURCE.', k + 1);
            k += 2;
        }
        let cond = '';
        if (sig[k]?.u === 'AND') {
            const start = k + 1;
            k = start;
            let cases = 0;
            while (k < sig.length) {
                if (sig[k].u === 'CASE') cases++;
                else if (sig[k].u === 'END' && cases > 0) cases--;
                else if (sig[k].u === 'THEN' && cases === 0 && depthAt(sig, start, k) === 0) break;
                k++;
            }
            cond = text(src, sig, start, k);
        }
        if (sig[k]?.u !== 'THEN') fail('WHEN … needs THEN and an action.', k);
        k++;
        const verb = sig[k]?.u;
        /** @type {MergeClause} */
        const clause = { match, cond, action: 'delete', sets: [], columns: [], values: null };
        if (verb === 'DELETE') {
            if (match === 'target') fail('WHEN NOT MATCHED [BY TARGET] can only INSERT.', k);
            k++;
        } else if (verb === 'UPDATE') {
            if (match === 'target') fail('WHEN NOT MATCHED [BY TARGET] can only INSERT.', k);
            clause.action = 'update';
            k++;
            if (sig[k]?.u !== 'SET') fail('UPDATE in MERGE needs SET.', k);
            k++;
            const start = k;
            while (k < sig.length && !((['WHEN', 'OUTPUT', 'OPTION'].includes(sig[k].u) || (sig[k].t === 'p' && sig[k].v === ';')) && depthAt(sig, start, k) === 0)) k++;
            clause.sets = commaRanges(sig, start, k).map(([x, y]) => {
                let eq = x;
                while (eq < y && !(sig[eq].t === 'p' && sig[eq].v === '=')) eq++;
                if (eq >= y) fail('Each SET item needs = and a value.', x);
                // t.Name = … : the column is Name
                const columnText = text(src, sig, x, eq);
                return { column: unquote(columnText.split('.').pop() || ''), expr: text(src, sig, eq + 1, y) };
            });
        } else if (verb === 'INSERT') {
            if (match !== 'target') fail('Only WHEN NOT MATCHED [BY TARGET] can INSERT.', k);
            clause.action = 'insert';
            k++;
            if (sig[k]?.v === '(') {
                const close = closeParen(sig, k);
                clause.columns = commaRanges(sig, k + 1, close).map(([x, y]) => unquote(text(src, sig, x, y)));
                k = close + 1;
            }
            if (sig[k]?.u === 'DEFAULT' && sig[k + 1]?.u === 'VALUES') {
                k += 2;
            } else {
                if (sig[k]?.u !== 'VALUES' || sig[k + 1]?.v !== '(') fail('INSERT in MERGE needs VALUES ( … ).', k);
                const close = closeParen(sig, k + 1);
                clause.values = commaRanges(sig, k + 2, close).map(([x, y]) => text(src, sig, x, y));
                if (clause.columns.length && clause.columns.length !== clause.values.length) fail('There are more columns in the INSERT statement than values specified in the VALUES clause.', k);
                k = close + 1;
            }
        } else fail('WHEN … THEN needs UPDATE, DELETE or INSERT.', k);
        clauses.push(clause);
    }
    if (!clauses.length) fail('MERGE needs at least one WHEN clause.', sig.length - 1);
    return { target, targetAlias, source, sourceAlias, on, clauses, output };
}

/** Parenthesis depth at token k, counting from `from`. */
function depthAt(sig, from, k) {
    let depth = 0;
    for (let j = from; j < k; j++) {
        if (sig[j].t !== 'p') continue;
        if (sig[j].v === '(') depth++;
        else if (sig[j].v === ')') depth--;
    }
    return depth;
}

// ---- APPLY

/**
 * The first CROSS / OUTER APPLY at the statement's own level whose right side
 * SQLite can't join directly (a subquery, or a function other than
 * STRING_SPLIT / OPENJSON, which the translator turns into a join).
 * @param {string} src
 * @returns {{ kind: 'CROSS' | 'OUTER', from: number, applyStart: number, applyEnd: number, inner: string, isCall: boolean, alias: string,
 *   leftText: string, leftAliases: string[], selectStart: number, selectEnd: number } | null}
 *   offsets in src
 */
export function findApply(src) {
    const sig = sigTokens(src);
    let depth = 0;
    // The FROM of each depth, most recent first
    /** @type {Map<number, number>} */
    const fromAt = new Map();
    /** @type {Map<number, number>} */
    const selectAt = new Map();
    for (let k = 0; k < sig.length; k++) {
        const t = sig[k];
        if (t.t === 'p' && t.v === '(') {
            depth++;
            continue;
        }
        if (t.t === 'p' && t.v === ')') {
            fromAt.delete(depth);
            selectAt.delete(depth);
            depth--;
            continue;
        }
        if (t.u === 'SELECT') {
            selectAt.set(depth, k);
            fromAt.delete(depth);
        }
        if (t.u === 'FROM' && !fromAt.has(depth)) fromAt.set(depth, k);
        if (t.u !== 'APPLY' || !['CROSS', 'OUTER'].includes(sig[k - 1]?.u)) continue;
        const from = fromAt.get(depth);
        const select = selectAt.get(depth);
        if (from === undefined || select === undefined) continue;
        let j = k + 1;
        let inner;
        let isCall = false;
        if (sig[j]?.v === '(') {
            const close = closeParen(sig, j);
            if (close < 0) return null;
            inner = text(src, sig, j + 1, close);
            j = close + 1;
        } else {
            const end = nameEnd(sig, j);
            if (end === j || sig[end]?.v !== '(') continue;
            const last = sig[end - 1].u;
            if (last === 'STRING_SPLIT' || last === 'OPENJSON') continue;
            const close = closeParen(sig, end);
            if (close < 0) return null;
            inner = `SELECT * FROM ${text(src, sig, j, close + 1)}`;
            isCall = true;
            j = close + 1;
        }
        const a = aliasAt(sig, j);
        if (!a.alias) throw new TsqlSyntaxError('CROSS APPLY / OUTER APPLY needs an alias for its rows: CROSS APPLY (…) AS x.', sig[j]?.start ?? src.length);
        j = a.end;
        // A column list after the alias: (…) AS x (a, b) isn't supported
        const leftText = src.slice(sig[from].end, sig[k - 1].start);
        // Where the select list is: after SELECT [ALL | DISTINCT] [TOP (n) [PERCENT] [WITH TIES]]
        let s = select + 1;
        if (['ALL', 'DISTINCT'].includes(sig[s]?.u)) s++;
        if (sig[s]?.u === 'TOP') {
            s++;
            s = sig[s]?.v === '(' ? closeParen(sig, s) + 1 : s + 1;
            if (sig[s]?.u === 'PERCENT') s++;
            if (sig[s]?.u === 'WITH' && sig[s + 1]?.u === 'TIES') s += 2;
        }
        return {
            kind: /** @type {'CROSS' | 'OUTER'} */ (sig[k - 1].u),
            from: sig[from].start,
            applyStart: sig[k - 1].start,
            applyEnd: sig[j - 1].end,
            inner: /** @type {string} */ (inner),
            isCall,
            alias: a.alias,
            leftText,
            leftAliases: sourceAliases(leftText),
            selectStart: sig[s].start,
            selectEnd: sig[from].start
        };
    }
    return null;
}

/** The aliases (or table names) of the sources in a FROM list: "Orders o JOIN Customers AS c ON …" → [o, c]. */
export function sourceAliases(fromText) {
    const sig = sigTokens(fromText);
    const out = [];
    let expect = true;
    let depth = 0;
    for (let k = 0; k < sig.length; k++) {
        const t = sig[k];
        if (t.t === 'p' && t.v === '(') {
            if (depth === 0 && expect) {
                const close = closeParen(sig, k);
                if (close < 0) break;
                const a = aliasAt(sig, close + 1);
                if (a.alias) out.push(a.alias);
                k = (a.alias ? a.end : close + 1) - 1;
                expect = false;
                continue;
            }
            depth++;
            continue;
        }
        if (t.t === 'p' && t.v === ')') {
            depth--;
            continue;
        }
        if (depth > 0) continue;
        if (t.v === ',' || t.u === 'JOIN' || t.u === 'APPLY') {
            expect = true;
            continue;
        }
        if (expect && (t.t === 'word' || t.t === 'ident') && !CLAUSE_WORDS.has(t.u)) {
            const end = nameEnd(sig, k);
            let after = end;
            if (sig[after]?.v === '(') after = closeParen(sig, after) + 1;
            const a = aliasAt(sig, after);
            out.push(a.alias || unquote(sig[end - 1].v));
            k = (a.alias ? a.end : after) - 1;
            expect = false;
        }
    }
    return out;
}

// ---- PIVOT / UNPIVOT

/**
 * The first PIVOT or UNPIVOT: its source (a table name or a derived table),
 * the clause, and the alias after it.
 * @param {string} src
 * @returns {{ kind: 'PIVOT' | 'UNPIVOT', start: number, end: number, source: string, sourceAlias: string, alias: string,
 *   agg?: string, aggArg?: string, value?: string, pivotColumn: string, values: string[] } | null}
 */
export function findPivot(src) {
    const sig = sigTokens(src);
    for (let k = 1; k < sig.length; k++) {
        const t = sig[k];
        if ((t.u !== 'PIVOT' && t.u !== 'UNPIVOT') || sig[k + 1]?.v !== '(') continue;
        // The source just before: name [AS alias] or ( … ) [AS] alias
        let j = k - 1;
        let srcStart;
        let srcEnd;
        let sourceAlias = '';
        if (sig[j].t === 'word' || sig[j].t === 'ident') {
            const last = j;
            // An alias of the source, or the source's name
            let p = j;
            if (sig[p - 1]?.u === 'AS') p -= 2;
            else if (sig[p - 1] && (sig[p - 1].t === 'word' || sig[p - 1].t === 'ident' || sig[p - 1].v === ')') && !['FROM', 'JOIN'].includes(sig[p - 1].u) && sig[p - 1].v !== '.') p -= 1;
            if (p !== last) sourceAlias = unquote(sig[last].v);
            j = p;
        }
        if (sig[j]?.v === ')') {
            let depth = 0;
            let open = j;
            for (; open >= 0; open--) {
                if (sig[open].t !== 'p') continue;
                if (sig[open].v === ')') depth++;
                else if (sig[open].v === '(' && --depth === 0) break;
            }
            srcStart = open;
            srcEnd = j + 1;
        } else {
            srcEnd = j + 1;
            srcStart = j;
            while (srcStart >= 2 && sig[srcStart - 1].v === '.') srcStart -= 2;
        }
        const close = closeParen(sig, k + 1);
        if (close < 0) return null;
        const a = aliasAt(sig, close + 1);
        if (!a.alias) throw new TsqlSyntaxError(`${t.u} needs an alias after its parentheses: ${t.u} ( … ) AS p.`, sig[close + 1]?.start ?? src.length);
        const source = sig[srcStart].v === '(' ? text(src, sig, srcStart, srcEnd) : text(src, sig, srcStart, srcEnd);
        // Inside: AGG(arg) FOR col IN (…)   or   value FOR col IN (…)
        let f = k + 2;
        while (f < close && !(sig[f].u === 'FOR' && depthAt(sig, k + 2, f) === 0)) f++;
        if (f >= close || sig[f + 2]?.u !== 'IN' || sig[f + 3]?.v !== '(') throw new TsqlSyntaxError(`${t.u} needs … FOR column IN ( … ).`, sig[k].start);
        const pivotColumn = unquote(sig[f + 1].v);
        const listClose = closeParen(sig, f + 3);
        const values = commaRanges(sig, f + 4, listClose).map(([x, y]) => unquote(text(src, sig, x, y)));
        const head = { kind: /** @type {'PIVOT' | 'UNPIVOT'} */ (t.u), start: sig[srcStart].start, end: sig[a.end - 1].end, source, sourceAlias, alias: a.alias, pivotColumn, values };
        if (t.u === 'UNPIVOT') return { ...head, value: unquote(text(src, sig, k + 2, f)) };
        const aggOpen = k + 3;
        if (sig[aggOpen]?.v !== '(') throw new TsqlSyntaxError('PIVOT needs an aggregate such as SUM(Amount) before FOR.', sig[k + 2].start);
        const aggClose = closeParen(sig, aggOpen);
        return { ...head, agg: sig[k + 2].v, aggArg: text(src, sig, aggOpen + 1, aggClose) };
    }
    return null;
}

// ---- triggers

/**
 * CREATE [OR ALTER] TRIGGER name ON table {FOR | AFTER | INSTEAD OF} {INSERT, UPDATE, DELETE} AS …
 * @param {string} src
 * @param {number} [base]
 */
export function parseTrigger(src, base = 0) {
    const sig = sigTokens(src);
    const fail = (/** @type {string} */ message, /** @type {number} */ k) => {
        throw new TsqlSyntaxError(message, base + (sig[k]?.start ?? src.length));
    };
    let k = 1;
    let action = sig[0].u === 'ALTER' ? 'alter' : 'create';
    if (sig[1]?.u === 'OR' && sig[2]?.u === 'ALTER') {
        action = 'create or alter';
        k = 3;
    }
    k++;
    const nameStart = k;
    k = nameEnd(sig, k);
    if (k === nameStart) fail('The trigger needs a name.', k);
    const { schema, name } = splitName(text(src, sig, nameStart, k));
    if (sig[k]?.u !== 'ON') fail('CREATE TRIGGER needs ON and a table: CREATE TRIGGER name ON dbo.Orders AFTER INSERT AS …', k);
    k++;
    if (sig[k]?.u === 'DATABASE' || sig[k]?.u === 'ALL') fail('Database and server triggers (ON DATABASE) aren\'t supported in SQL Lab.', k);
    const tableStart = k;
    k = nameEnd(sig, k);
    const table = splitName(text(src, sig, tableStart, k)).name;
    if (sig[k]?.u === 'WITH') {
        k++;
        while (sig[k] && sig[k].u !== 'FOR' && sig[k].u !== 'AFTER' && sig[k].u !== 'INSTEAD') k++;
    }
    let instead = false;
    if (sig[k]?.u === 'INSTEAD' && sig[k + 1]?.u === 'OF') {
        instead = true;
        k += 2;
    } else if (sig[k]?.u === 'FOR' || sig[k]?.u === 'AFTER') k++;
    else fail('The trigger needs FOR, AFTER or INSTEAD OF and the events.', k);
    const events = [];
    while (['INSERT', 'UPDATE', 'DELETE'].includes(sig[k]?.u)) {
        events.push(sig[k].u);
        k++;
        if (sig[k]?.v === ',') k++;
    }
    if (!events.length) fail('The trigger needs INSERT, UPDATE or DELETE.', k);
    if (sig[k]?.u === 'NOT' && sig[k + 1]?.u === 'FOR') k += 3;
    if (sig[k]?.u !== 'AS') fail('Incorrect syntax: AS is missing before the trigger\'s statements.', k);
    k++;
    const bodyStart = sig[k] ? sig[k].start : src.length;
    return { action, schema, name, table, instead, events, body: src.slice(bodyStart), bodyStart };
}
