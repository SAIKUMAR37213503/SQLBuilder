// Explanations beyond the Beginner level of the Query structure panel, and a
// one-sentence summary of what the query does. Everything is worked out from
// the query model and the dialect; nothing looks at a database.
//
// Levels
//   beginner   what each step does (structure.js; unchanged)
//   developer  adds how joins, NULLs, grouping, DISTINCT and limits behave
//   advanced   adds window frames, set-operation precedence and the
//              dialect's own rules (NULL ordering, pagination)
//
// levelNotes(workspace, dialect, level) → { [stepKey]: string[] }
// summarizeWorkspace(workspace, dialect) → string

import { WINDOW_FUNCTIONS, countConditions } from './model.js';
import { formatLiteral } from './generator.js';
import { splitTopLevel, isColumnReference } from './sql-utils.js';
import { EXPLAIN_LEVELS } from './settings.js';

export { EXPLAIN_LEVELS };
export const EXPLAIN_LEVEL_LABELS = { beginner: 'Beginner', developer: 'Developer', advanced: 'Advanced' };

const has = (text) => String(text ?? '').trim() !== '';
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** Every condition in a group and its sub-groups. */
function conditionsOf(group) {
    return group.items.flatMap(item => (item.kind === 'group' ? conditionsOf(item) : [item]));
}

const JOIN_NOTES = {
    'INNER JOIN': 'INNER JOIN keeps only rows that have a match on both sides.',
    'LEFT JOIN': 'LEFT JOIN keeps every row of the tables before it; where nothing matches, the joined table\'s columns are NULL.',
    'RIGHT JOIN': 'RIGHT JOIN keeps every row of the joined table; where nothing matches, the earlier tables\' columns are NULL.',
    'FULL JOIN': 'FULL JOIN keeps the unmatched rows of both sides, with NULLs on the side that has no match.',
    'CROSS JOIN': 'CROSS JOIN pairs every row with every row, so the row counts multiply.'
};

const NULL_NOTE = 'A comparison with NULL is neither true nor false, so rows with NULL in a compared column are left out; IS NULL finds them.';
const TRANSACTION_NOTE = 'Running it inside a transaction (BEGIN … COMMIT) lets you check how many rows it affected and ROLLBACK if that looks wrong.';

/**
 * A WHERE condition on a LEFT-joined table's column removes the rows that had
 * no match, unless it is IS NULL: the join then behaves like an INNER JOIN.
 */
function leftJoinFilteredInWhere(q) {
    const leftNames = q.joins
        .filter(j => j.type === 'LEFT JOIN')
        .map(j => String(j.source.alias || (j.source.kind === 'table' ? String(j.source.table).split('.').pop() : '')).trim().toLowerCase())
        .filter(Boolean);
    if (leftNames.length === 0) return '';
    const hit = conditionsOf(q.where).find(c => c.kind === 'condition' && c.op !== 'IS NULL'
        && leftNames.includes(String(c.left).trim().split('.').slice(-2, -1)[0]?.toLowerCase() ?? ''));
    if (!hit) return '';
    const name = String(hit.left).trim().split('.').slice(-2, -1)[0];
    return `The WHERE condition on ${String(hit.left).trim()} removes the rows where ${name} had no match, so this LEFT JOIN returns the same rows as an INNER JOIN. To keep the unmatched rows, move the condition into ON.`;
}

function windowNotes(q) {
    const notes = [];
    for (const col of q.columns.filter(c => c.kind === 'window')) {
        const spec = WINDOW_FUNCTIONS[col.func];
        if (!spec || !spec.frame) continue;
        const name = has(col.alias) ? col.alias : col.func;
        const ordered = col.orderBy.length > 0;
        if (col.frame === 'running') notes.push(`${name} uses the rows from the start of its partition to the current row (a running value).`);
        else if (col.frame === 'whole') notes.push(`${name} uses every row of its partition.`);
        else if (col.frame === 'moving') notes.push(`${name} uses the current row and the ${plural(Number(col.frameSize) || 0, 'row')} before it.`);
        else if (ordered) notes.push(`${name} has ORDER BY and no frame, so it uses the default frame: RANGE from the start of the partition to the current row. Rows with equal sort values share one result; choose the running frame (ROWS) to count them one by one.`);
        else notes.push(`${name} has no ORDER BY inside OVER, so it uses every row of its partition.`);
    }
    return notes;
}

/**
 * The extra sentences for each step at a level, keyed by step key.
 * @param {any} workspace
 * @param {any} dialect a dialect from getDialect()
 * @param {string} level one of EXPLAIN_LEVELS
 * @returns {Record<string, string[]>}
 */
export function levelNotes(workspace, dialect, level) {
    const developer = level === 'developer' || level === 'advanced';
    const advanced = level === 'advanced';
    /** @type {Record<string, string[]>} */
    const notes = {};
    const add = (key, ...texts) => {
        const kept = texts.filter(Boolean);
        if (kept.length) notes[key] = [...(notes[key] || []), ...kept];
    };
    if (!developer) return notes;
    const type = workspace.type;
    const q = workspace[type];

    if (type === 'select') {
        add('with', 'Each named query exists only while this statement runs; it is not stored.');
        if (advanced) add('with', 'The database may copy a named query into the main query or work it out once; the result is the same either way.');
        if (q.from.kind === 'subquery') add('from', 'The subquery is worked out first and then read like a table.');

        const types = [...new Set(q.joins.map(j => j.type))];
        add('join', ...types.map(t => JOIN_NOTES[t]));
        if (types.some(t => t !== 'CROSS JOIN')) add('join', 'A row that matches several rows of the joined table appears once for each match.');
        add('join', leftJoinFilteredInWhere(q));
        if (advanced) add('join', 'The database may join the tables in a different order than written; the result is the same.');

        const where = conditionsOf(q.where);
        add('where', NULL_NOTE, 'WHERE can\'t use aggregates such as COUNT or SUM; those filters go in HAVING.');
        if (where.some(c => c.kind === 'condition' && c.op === 'NOT IN' && c.valueType === 'subquery')) {
            add('where', 'NOT IN (subquery) returns no rows at all when the subquery returns a NULL; NOT EXISTS doesn\'t have this problem.');
        }
        if (advanced && q.where.items.length > 1) add('where', 'AND is evaluated before OR. The builder writes parentheses around each group, so the SQL means exactly what the groups show.');

        add('group', q.groupBy.length
            ? 'Every selected column has to be in GROUP BY or inside an aggregate. Rows with NULL in a grouped column form one group together.'
            : 'Without GROUP BY, the aggregates return one row even when no rows match: COUNT is then 0, and SUM or AVG are NULL.');
        add('having', 'Conditions that don\'t use an aggregate can go in WHERE instead, which removes rows before they are grouped.');

        const aggregates = q.columns.some(c => c.kind === 'column' && c.aggregate);
        add('select',
            aggregates ? 'COUNT(*) counts rows; COUNT(column) and the other aggregates skip NULLs.' : '',
            q.columns.some(c => c.kind === 'case' && !has(c.elseValue)) ? 'A CASE without ELSE gives NULL for rows that match no WHEN.' : '',
            q.distinct ? 'DISTINCT compares whole result rows, so the database has to sort or hash the whole result. If the duplicates come from a join, changing the join is often the better fix.' : '');
        if (advanced) {
            add('select', ...windowNotes(q));
            if (q.columns.some(c => c.kind === 'window')) add('select', 'Window functions run after WHERE, GROUP BY and HAVING, so they can\'t be filtered there; put this query in a CTE and filter the outer query.');
        }

        if (q.setOps.length) {
            if (q.setOps.some(s => s.op === 'UNION')) add('setops', 'UNION removes duplicate rows; UNION ALL keeps them and does less work.');
            add('setops', 'The result\'s column names come from the first query.');
            if (advanced) add('setops', 'INTERSECT is evaluated before UNION and EXCEPT. ORDER BY and the row limit apply to the combined result.');
        }

        add('order', 'Rows with equal sort values can come back in any order; a unique column (such as id) as the last sort key makes the order stable.');
        if (advanced) add('order', dialect.explain.nullsOrder);

        add('limit', q.orderBy.length ? 'The limit is applied after sorting, so it keeps the first rows of the sorted result.' : 'Without ORDER BY, which rows come back isn\'t guaranteed.');
        if (advanced) add('limit', dialect.explain.pagination);
        return notes;
    }

    if (type === 'insert') {
        add('source', q.source === 'select'
            ? 'The query\'s columns fill the listed columns by position, not by name.'
            : 'Columns that aren\'t listed get their default value, or NULL.');
        add('insert', 'If any row breaks a constraint (a unique key, NOT NULL or a foreign key), the statement fails and no rows are added.');
        if (advanced && q.upsert.mode && dialect.supports.upsert === 'on-conflict') {
            add('upsert', 'ON CONFLICT needs a unique index or constraint on the conflict columns. EXCLUDED is the row that was about to be inserted.');
        } else if (advanced && q.upsert.mode && dialect.supports.upsert === 'on-duplicate-key') {
            add('upsert', 'ON DUPLICATE KEY UPDATE reacts to any unique key, including the primary key. VALUES(column) is the value that was about to be inserted.');
        }
        return notes;
    }

    // UPDATE and DELETE
    if (countConditions(q.where)) add('where', NULL_NOTE);
    add('table', TRANSACTION_NOTE);
    if (advanced && type === 'delete' && !countConditions(q.where)) add('where', 'To empty a whole table, TRUNCATE (not built here) is usually quicker, but it can\'t be filtered and may not be undoable in every database.');
    return notes;
}

// ------------------------------------------------------------ summary

const MAX_LISTED = 4;
const MAX_CONDITION_TEXT = 160;

const OP_WORDS = {
    '=': 'is', '!=': 'is not', '<>': 'is not', '<': 'is less than', '<=': 'is at most', '>': 'is greater than', '>=': 'is at least',
    'LIKE': 'matches', 'NOT LIKE': 'doesn\'t match', 'IN': 'is one of', 'NOT IN': 'is not one of',
    'BETWEEN': 'is between', 'NOT BETWEEN': 'is not between', 'IS NULL': 'is NULL', 'IS NOT NULL': 'is not NULL'
};

function listOf(items) {
    if (items.length <= 1) return items.join('');
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function valueText(raw, valueType, dialect) {
    if (valueType === 'param') return has(raw) ? `the parameter ${String(raw).trim()}` : 'a parameter';
    if (valueType === 'column') return String(raw).trim();
    return formatLiteral(raw, dialect.id);
}

function conditionText(c, dialect) {
    if (c.kind === 'raw') return String(c.sql).trim();
    if (c.op === 'EXISTS') return 'a subquery finds a matching row';
    if (c.op === 'NOT EXISTS') return 'a subquery finds no matching row';
    const left = String(c.left).trim();
    const words = OP_WORDS[c.op] || c.op;
    if (c.op === 'IS NULL' || c.op === 'IS NOT NULL') return `${left} ${words}`;
    if (c.valueType === 'subquery') return `${left} ${c.op === 'IN' || c.op === 'NOT IN' ? `is${c.op === 'NOT IN' ? ' not' : ''} in` : words} the result of a subquery`;
    if (c.op === 'BETWEEN' || c.op === 'NOT BETWEEN') return `${left} ${words} ${valueText(c.value, c.valueType, dialect)} and ${valueText(c.value2, c.valueType, dialect)}`;
    if (c.op === 'IN' || c.op === 'NOT IN') {
        const values = c.valueType === 'value' ? splitTopLevel(String(c.value)).filter(Boolean).map(v => formatLiteral(v, dialect.id)) : [String(c.value).trim()];
        return `${left} ${words} ${values.join(', ')}`;
    }
    return `${left} ${words} ${valueText(c.value, c.valueType, dialect)}`;
}

function groupText(group, dialect, nested = false) {
    const parts = group.items.map(item => (item.kind === 'group' ? groupText(item, dialect, true) : conditionText(item, dialect))).filter(Boolean);
    let text = parts.join(group.logic === 'OR' ? ' or ' : ' and ');
    if (parts.length > 1 && (nested || group.negate)) text = `(${text})`;
    return group.negate ? `not ${text}` : text;
}

/** The conditions in words, or a count when there are too many to read in one sentence. */
function conditionsText(group, dialect) {
    const n = countConditions(group);
    if (n === 0) return '';
    const text = groupText(group, dialect);
    return n > 3 || text.length > MAX_CONDITION_TEXT ? `${plural(n, 'condition')} hold` : text;
}

function aggregateText(col) {
    const e = String(col.expr).trim();
    switch (col.aggregate) {
        case 'COUNT': return e === '' || e === '*' ? 'the number of rows' : `the count of ${e}`;
        case 'COUNT DISTINCT': return `the number of distinct ${e}`;
        case 'SUM': return `the total ${e}`;
        case 'AVG': return `the average ${e}`;
        case 'MIN': return `the lowest ${e}`;
        case 'MAX': return `the highest ${e}`;
        default: return e;
    }
}

function columnText(col) {
    if (col.kind === 'window') return has(col.alias) ? col.alias.trim() : `a ${col.func} value`;
    if (col.kind === 'case') return has(col.alias) ? col.alias.trim() : 'a CASE value';
    const e = String(col.expr).trim();
    // An aggregate of a long expression reads better by its alias
    if (col.aggregate) return has(col.alias) && e !== '' && e !== '*' && !isColumnReference(e) ? col.alias.trim() : aggregateText(col);
    if (e === '*') return 'every column';
    if (e.endsWith('.*')) return `every column of ${e.slice(0, -2)}`;
    return has(col.alias) ? col.alias.trim() : e;
}

function sourceText(source) {
    if (source.kind === 'subquery') return has(source.alias) ? `a subquery (${source.alias.trim()})` : 'a subquery';
    return has(source.table) ? source.table.trim() : 'a table (not set yet)';
}

function selectSummary(q, dialect) {
    const columns = q.columns.map(columnText);
    const shown = columns.length > MAX_LISTED ? [...columns.slice(0, MAX_LISTED - 1), plural(columns.length - MAX_LISTED + 1, 'more column')] : columns;
    let text = `Returns ${q.distinct ? 'the distinct rows of ' : ''}${listOf(shown)} from ${sourceText(q.from)}`;
    if (q.joins.length) text += `, joined with ${listOf(q.joins.map(j => sourceText(j.source)))}`;
    const where = conditionsText(q.where, dialect);
    if (where) text += `, where ${where}`;
    if (q.groupBy.length) text += `, one row per ${listOf(q.groupBy.map(g => String(g.expr).trim()))}`;
    else if (q.columns.some(c => c.kind === 'column' && c.aggregate)) text += ', as one summary row';
    const having = conditionsText(q.having, dialect);
    if (having) text += `, keeping the groups where ${having}`;
    if (q.setOps.length) text += `, combined with ${plural(q.setOps.length, 'more query', 'more queries')} (${[...new Set(q.setOps.map(s => s.op))].join(', ')})`;
    if (q.orderBy.length) text += `, sorted by ${q.orderBy.map(o => `${String(o.expr).trim()}${o.direction === 'DESC' ? ' descending' : ''}`).join(' then ')}`;
    const limit = Number(String(q.limit).trim());
    const offset = Number(String(q.offset).trim());
    if (has(q.limit) && has(q.offset)) text += `, rows ${offset + 1} to ${offset + limit}`;
    else if (has(q.limit)) text += `, first ${plural(limit, 'row')} only`;
    else if (has(q.offset)) text += `, skipping the first ${plural(offset, 'row')}`;
    return `${text}.`;
}

/**
 * What the query does, in one sentence.
 * @param {any} workspace
 * @param {any} dialect a dialect from getDialect()
 */
export function summarizeWorkspace(workspace, dialect) {
    const type = workspace.type;
    const q = workspace[type];
    const table = has(q.table) ? q.table.trim() : 'a table (not set yet)';
    if (type === 'select') return selectSummary(q, dialect);

    if (type === 'insert') {
        const columns = splitTopLevel(String(q.columns)).filter(Boolean);
        const rows = q.rows.filter(r => has(r.values)).length;
        let text = q.source === 'select'
            ? `Adds the rows a query returns to ${table}`
            : `Adds ${plural(rows, 'row')} to ${table}`;
        if (columns.length) text += `, filling ${listOf(columns.length > MAX_LISTED ? [...columns.slice(0, MAX_LISTED - 1), plural(columns.length - MAX_LISTED + 1, 'more column')] : columns)}`;
        if (q.upsert.mode && dialect.supports.upsert) {
            text += q.upsert.mode === 'nothing'
                ? '; a row that clashes with an existing unique key is skipped'
                : `; when a row clashes with an existing unique key, that row's ${listOf(q.upsert.set.map(a => String(a.column).trim()).filter(Boolean))} are updated instead`;
        }
        return `${text}.`;
    }

    const where = conditionsText(q.where, dialect);
    if (type === 'update') {
        const sets = q.set.filter(a => has(a.column)).map(a => `${a.column.trim()} to ${valueText(a.value, a.valueType, dialect)}`);
        const shown = sets.length > 3 ? [...sets.slice(0, 2), plural(sets.length - 2, 'more column')] : sets;
        return `Sets ${sets.length ? listOf(shown) : 'columns (not set yet)'} in ${table}, ${where ? `for the rows where ${where}` : 'for every row'}.`;
    }
    return where ? `Deletes the rows of ${table} where ${where}.` : `Deletes every row of ${table}.`;
}
