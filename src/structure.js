// Query structure: the parts of the current query in the order a database
// logically processes them, each with a short plain-language explanation.
// Built from the query model only; it describes structure, never cost or
// performance, and never looks at a database.
//
// describeStructure(workspace, dialect) → { steps, notes }
//   steps  [{ key, clause, detail, explanation, target }] in processing order;
//          target is { section } (a builder section key) or { path } (a field)
//   notes  extra facts that aren't a step, e.g. how many subqueries there are

import { countConditions, forEachSelect, WINDOW_FUNCTIONS } from './model.js';

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const has = (text) => String(text ?? '').trim() !== '';

function sourceName(source) {
    if (source.kind === 'subquery') return source.alias ? `a subquery named ${source.alias}` : 'a subquery';
    return has(source.table) ? source.table : 'a table (not set yet)';
}

function limitDetail(q, dialect) {
    const parts = [];
    if (has(q.limit)) parts.push(`${dialect.ui.limitLabel} ${q.limit}`);
    if (has(q.offset)) parts.push(`skip ${q.offset}`);
    return parts.join(', ');
}

function selectSteps(q, path, dialect) {
    const at = (name) => ({ section: `${path}:${name}` });
    const steps = [];

    if (q.ctes.length) {
        const names = q.ctes.map(c => c.name.trim()).filter(Boolean);
        const recursive = q.ctes.filter(c => c.recursive).map(c => c.name.trim()).filter(Boolean);
        steps.push({
            key: 'with', clause: q.ctes.some(c => c.recursive) ? dialect.recursive.keyword : 'WITH',
            detail: `${plural(q.ctes.length, 'named query', 'named queries')}${names.length ? `: ${names.join(', ')}` : ''}${recursive.length ? ` (recursive: ${recursive.join(', ')})` : ''}`,
            explanation: q.ctes.some(c => c.recursive)
                ? 'Defines named queries first, so the rest of the query can use them like tables. A recursive one starts with the rows of its first SELECT, then runs its UNION part again on the rows it just added, until no new rows come back.'
                : 'Defines named queries first, so the rest of the query can use them like tables.',
            target: at('ctes')
        });
    }

    steps.push({
        key: 'from', clause: 'FROM',
        detail: sourceName(q.from),
        explanation: 'Picks where the rows come from.',
        target: at('from')
    });

    if (q.joins.length) {
        const kinds = [...new Set(q.joins.map(j => j.type.replace(' JOIN', '')))];
        steps.push({
            key: 'join', clause: 'JOIN',
            detail: `${plural(q.joins.length, 'join')} (${kinds.join(', ')}): ${q.joins.map(j => sourceName(j.source)).join(', ')}`,
            explanation: q.joins.every(j => j.type === 'CROSS JOIN')
                ? 'Pairs every row with every row of the other table.'
                : 'Adds rows from other tables that match the ON conditions.',
            target: at('joins')
        });
    }

    const where = countConditions(q.where);
    if (where) {
        steps.push({
            key: 'where', clause: 'WHERE',
            detail: plural(where, 'condition'),
            explanation: 'Keeps only the rows that match, before any grouping.',
            target: at('where')
        });
    }

    const aggregates = q.columns.filter(c => c.kind === 'column' && c.aggregate).length;
    if (q.groupBy.length) {
        steps.push({
            key: 'group', clause: 'GROUP BY',
            detail: plural(q.groupBy.length, 'column'),
            explanation: 'Puts rows with the same values into one group; aggregates like COUNT or SUM are worked out per group.',
            target: at('grouping')
        });
    } else if (aggregates) {
        steps.push({
            key: 'group', clause: 'Aggregate',
            detail: 'no GROUP BY, so all rows form one group',
            explanation: 'Aggregates like COUNT or SUM without GROUP BY return a single summary row.',
            target: at('grouping')
        });
    }

    const having = countConditions(q.having);
    if (having) {
        steps.push({
            key: 'having', clause: 'HAVING',
            detail: plural(having, 'condition'),
            explanation: 'Keeps only the groups that match, after the aggregates are worked out.',
            target: at('grouping')
        });
    }

    const windows = q.columns.filter(c => c.kind === 'window');
    const cases = q.columns.filter(c => c.kind === 'case').length;
    const detail = [plural(q.columns.length, 'column')];
    if (aggregates) detail.push(plural(aggregates, 'aggregate'));
    if (cases) detail.push(`${cases} CASE`);
    if (windows.length) detail.push(plural(windows.length, 'window function'));
    if (q.distinct) detail.push('DISTINCT');
    steps.push({
        key: 'select', clause: q.distinct ? 'SELECT DISTINCT' : 'SELECT',
        detail: detail.join(', '),
        explanation: [
            'Works out the output columns.',
            windows.length ? `Window functions (${[...new Set(windows.map(w => w.func))].filter(f => WINDOW_FUNCTIONS[f]).join(', ')}) are calculated over the remaining rows without merging them.` : '',
            q.distinct ? 'DISTINCT then removes duplicate rows.' : ''
        ].filter(Boolean).join(' '),
        target: at('columns')
    });

    if (q.setOps.length) {
        const ops = [...new Set(q.setOps.map(s => s.op))];
        steps.push({
            key: 'setops', clause: ops.join(' / '),
            detail: `with ${plural(q.setOps.length, 'more query', 'more queries')}`,
            explanation: 'Combines the results of the queries into one result; each must return the same number of columns.',
            target: at('setops')
        });
    }

    if (q.orderBy.length) {
        steps.push({
            key: 'order', clause: 'ORDER BY',
            detail: q.orderBy.map(o => `${o.expr || '?'} ${o.direction}`).join(', '),
            explanation: 'Sorts the final result.',
            target: at('sorting')
        });
    }

    const limit = limitDetail(q, dialect);
    if (limit) {
        steps.push({
            key: 'limit', clause: has(q.limit) ? dialect.ui.limitLabel : 'OFFSET',
            detail: limit,
            explanation: has(q.limit) ? 'Returns only the first rows of the sorted result.' : 'Skips the first rows of the sorted result.',
            target: at('sorting')
        });
    }
    return steps;
}

function whereStep(q, path, verb) {
    const n = countConditions(q.where);
    return n
        ? { key: 'where', clause: 'WHERE', detail: plural(n, 'condition'), explanation: `Picks the rows to ${verb}.`, target: { path: `${path}.where` } }
        : { key: 'where', clause: 'No WHERE', detail: 'every row', explanation: `Without WHERE, the statement will ${verb} every row in the table.`, target: { path: `${path}.where` } };
}

/**
 * @param {any} workspace
 * @param {any} dialect a dialect from getDialect()
 */
export function describeStructure(workspace, dialect) {
    const type = workspace.type;
    const q = workspace[type];
    const notes = [];

    if (type === 'select') {
        let selects = 0;
        forEachSelect(q, () => { selects++; });
        const nested = selects - 1 - q.ctes.length - q.setOps.length;
        if (nested > 0) notes.push(`Also contains ${plural(nested, 'subquery', 'subqueries')}, each worked out the same way.`);
        return { steps: selectSteps(q, 'select', dialect), notes };
    }

    if (type === 'insert') {
        const columns = q.columns.split(',').map(c => c.trim()).filter(Boolean).length;
        const steps = [];
        if (q.source === 'select') {
            steps.push({ key: 'source', clause: 'SELECT', detail: 'rows from a query', explanation: 'Runs the query; each result row becomes a new row.', target: { path: 'insert.source' } });
        } else {
            const rows = q.rows.filter(r => has(r.values)).length;
            steps.push({ key: 'source', clause: 'VALUES', detail: plural(rows, 'row'), explanation: 'The rows you typed, one new row each.', target: { path: 'insert.source' } });
        }
        steps.push({
            key: 'insert', clause: 'INSERT INTO',
            detail: `${has(q.table) ? q.table : 'a table (not set yet)'}${columns ? `, ${plural(columns, 'column')}` : ''}`,
            explanation: 'Adds the rows to the table.',
            target: { path: 'insert.table' }
        });
        if (q.upsert.mode && dialect.supports.upsert) {
            steps.push({
                key: 'upsert', clause: dialect.supports.upsert === 'on-conflict' ? 'ON CONFLICT' : 'ON DUPLICATE KEY',
                detail: q.upsert.mode === 'nothing' ? 'skip the row' : `update ${plural(q.upsert.set.length, 'column')}`,
                explanation: 'When a row clashes with an existing unique key, this decides what happens instead of an error.',
                target: { path: 'insert.upsert' }
            });
        }
        return { steps, notes };
    }

    if (type === 'update') {
        return {
            steps: [
                { key: 'table', clause: 'UPDATE', detail: has(q.table) ? q.table : 'a table (not set yet)', explanation: 'The table whose rows change.', target: { path: 'update.table' } },
                whereStep(q, 'update', 'change'),
                { key: 'set', clause: 'SET', detail: plural(q.set.length, 'column'), explanation: 'The new values written into each matching row.', target: { path: 'update.set' } }
            ],
            notes
        };
    }

    return {
        steps: [
            { key: 'table', clause: 'DELETE FROM', detail: has(q.table) ? q.table : 'a table (not set yet)', explanation: 'The table rows are removed from.', target: { path: 'delete.table' } },
            whereStep(q, 'delete', 'delete')
        ],
        notes
    };
}
