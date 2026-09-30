// Where a CTE's own name is used inside a query, for the recursive CTE checks
// in validation.js and for SQL import. Names are compared without quotes and
// case; a schema-qualified name (hr.reports) is a table, never the CTE.

import { lex, significant } from './sql-lexer.js';

const bare = (text) => String(text ?? '').trim().replace(/^["`[]|["`\]]$/g, '').toLowerCase();

/** Whether a piece of typed SQL mentions the name as a word of its own. */
function mentions(text, name) {
    return significant(lex(String(text ?? ''))).some((t, i, tokens) =>
        (t.type === 'word' || t.type === 'quoted')
        && bare(t.type === 'quoted' ? t.value : t.text) === name
        && tokens[i - 1]?.text !== '.' && tokens[i + 1]?.text !== '.');
}

/**
 * The places a SELECT refers to a CTE by name.
 * @param {any} select
 * @param {string} cteName
 * @param {{ setOps?: boolean }} [options] setOps: also look in UNION parts
 * @returns {{ direct: number, nested: number }} direct: as a FROM or JOIN
 *   table of this SELECT; nested: anywhere else (subqueries, typed SQL)
 */
export function cteReferences(select, cteName, { setOps = true } = {}) {
    const name = bare(cteName);
    const found = { direct: 0, nested: 0 };
    if (!name) return found;

    const inSelect = (q, nested) => {
        for (const source of [q.from, ...q.joins.map((/** @type {any} */ j) => j.source)]) {
            if (source.kind === 'subquery') inSelect(source.query, true);
            else if (bare(source.table) === name) found[nested ? 'nested' : 'direct']++;
        }
        for (const join of q.joins) inGroup(join.on);
        inGroup(q.where);
        inGroup(q.having);
        for (const col of q.columns) {
            const texts = col.kind === 'case'
                ? [...col.cases.flatMap((/** @type {any} */ c) => [c.when, c.then]), col.elseValue]
                : col.kind === 'window' ? [col.args] : [col.expr];
            if (texts.some(text => mentions(text, name))) found.nested++;
        }
        for (const cte of q.ctes) inSelect(cte.query, true);
        if (setOps || nested) for (const s of q.setOps) inSelect(s.query, nested);
    };
    const inGroup = (/** @type {any} */ group) => {
        for (const item of group.items) {
            if (item.kind === 'group') inGroup(item);
            else if (item.kind === 'raw') { if (mentions(item.sql, name)) found.nested++; }
            else if (item.valueType === 'subquery' && item.subquery) inSelect(item.subquery, true);
            else if ([item.left, ...(item.valueType === 'column' ? [item.value, item.value2] : [])].some(text => mentions(text, name))) found.nested++;
        }
    };
    inSelect(select, false);
    return found;
}

/** Whether a CTE's query refers to the CTE anywhere, UNION parts included. */
export function refersToItself(cte) {
    const { direct, nested } = cteReferences(cte.query, cte.name);
    return direct + nested > 0;
}
