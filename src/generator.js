// SQL generator: turns a query model into SQL text.
//
// Queries are rendered into "lines" – [indent, text] pairs – which are then
// either pretty-printed (4-space indentation, one clause per line) or joined
// into a single compact line. No regex post-processing of SQL text is used,
// so user-entered values can never be re-formatted by accident.

import { OPERATORS, WINDOW_FUNCTIONS } from './model.js';
import { getDialect, DEFAULT_DIALECT } from './dialects.js';
import { splitTopLevel, isNumberLiteral, isQuotedString, hasLeadingZero, hasTopLevelLogic } from './sql-utils.js';

const INDENT = '    ';

const BARE_CHAIN_RE = /^[\p{L}_][\p{L}\p{N}_$]*(?:\.(?:[\p{L}_][\p{L}\p{N}_$]*|\*))*$/u;

/**
 * @typedef {{ dialect?: string, pretty?: boolean, quoteIdentifiers?: boolean }} GenerateOptions
 */

/**
 * Generates SQL for the active query of a workspace.
 * @param {any} workspace
 * @param {GenerateOptions} [options]
 */
export function generateSQL(workspace, options = {}) {
    return generateQuery(workspace[workspace.type], options);
}

/**
 * Generates SQL for a single query node (select / insert / update / delete).
 * @param {any} query
 * @param {GenerateOptions} [options]
 */
export function generateQuery(query, options = {}) {
    const ctx = {
        dialect: getDialect(options.dialect || DEFAULT_DIALECT),
        quote: Boolean(options.quoteIdentifiers),
        params: 0 // parameter placeholders emitted so far (for $1, @p1 numbering)
    };
    const lines = renderStatement(query, ctx);
    if (lines.length === 0) return '';
    lines[lines.length - 1] = [lines[lines.length - 1][0], lines[lines.length - 1][1] + ';'];
    return options.pretty === false ? joinCompact(lines) : joinPretty(lines);
}

function renderStatement(query, ctx) {
    switch (query.kind) {
        case 'select': return renderSelect(query, ctx);
        case 'insert': return renderInsert(query, ctx);
        case 'update': return renderUpdate(query, ctx);
        case 'delete': return renderDelete(query, ctx);
        default: throw new Error(`Unknown query kind: ${query.kind}`);
    }
}

// ---------------------------------------------------------------------------
// Line helpers
// ---------------------------------------------------------------------------

function joinPretty(lines) {
    return lines.map(([indent, text]) => INDENT.repeat(indent) + text).join('\n');
}

// Joins lines with single spaces, without a space after "(" or before ")".
function joinCompact(lines) {
    let out = '';
    for (const [, text] of lines) {
        if (out === '' || out.endsWith('(') || text.startsWith(')')) out += text;
        else out += ' ' + text;
    }
    return out;
}

function indented(lines, by = 1) {
    return lines.map(([indent, text]) => [indent + by, text]);
}

// Appends lines of a nested block to a first line, e.g. "x IN (" + body + ")"
function wrapBlock(opening, bodyLines, closing = ')') {
    return [[0, opening], ...indented(bodyLines), [0, closing]];
}

// Prefixes the first line of a block of lines.
function prefixFirst(prefix, lines) {
    if (lines.length === 0) return [[0, prefix.trimEnd()]];
    const [[indent, text], ...rest] = lines;
    return [[indent, prefix + text], ...rest];
}

// ---------------------------------------------------------------------------
// Identifiers, expressions and literals
// ---------------------------------------------------------------------------

function quoteName(name, ctx) {
    if (!ctx.quote || !BARE_CHAIN_RE.test(name)) return name;
    return name.split('.').map(part => (part === '*' ? part : ctx.dialect.quoteIdentifier(part))).join('.');
}

// A free-form SQL expression; only plain identifiers are quoted.
function expr(text, ctx) {
    return quoteName(String(text).trim(), ctx);
}

function alias(name, ctx) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return '';
    return ` AS ${quoteName(trimmed, ctx)}`;
}

/**
 * Formats a user-entered value as a SQL literal:
 *   numbers stay numbers (except ones with a leading zero, like a zip code
 *   01234, which are text), true/false become the dialect's booleans,
 *   null becomes NULL, text already in single quotes (or N'…') is kept as
 *   typed, anything else is quoted and escaped as a string.
 */
export function formatLiteral(raw, dialectId = DEFAULT_DIALECT) {
    return literal(raw, { dialect: getDialect(dialectId), quote: false });
}

function literal(raw, ctx) {
    const text = String(raw).trim();
    if (text === '') return "''";
    if (isNumberLiteral(text) && !hasLeadingZero(text)) return text;
    if (/^null$/i.test(text)) return 'NULL';
    if (/^(true|false)$/i.test(text)) return ctx.dialect.booleanLiteral(text.toLowerCase() === 'true');
    if (isQuotedString(text)) return text;
    return ctx.dialect.quoteString(text);
}

function rhs(value, valueType, ctx, column = '') {
    if (valueType === 'column') return expr(value, ctx);
    if (valueType === 'param') return parameter(value, ctx);
    if (valueType === 'inserted') return ctx.dialect.insertedValue ? ctx.dialect.insertedValue(expr(column, ctx)) : expr(column, ctx);
    return literal(value, ctx);
}

// Placeholders are numbered in the order they appear in the SQL text, which
// is the order lines are rendered in.
function parameter(name, ctx) {
    ctx.params++;
    return ctx.dialect.parameter(String(name ?? '').trim(), ctx.params);
}

// ---------------------------------------------------------------------------
// SELECT
// ---------------------------------------------------------------------------

// `branch` renders one side of a UNION: no CTEs, ORDER BY, LIMIT or set ops.
function renderSelect(q, ctx, { branch = false } = {}) {
    const lines = [];

    if (!branch && q.ctes.length > 0) {
        q.ctes.forEach((cte, i) => {
            const opening = `${i === 0 ? 'WITH ' : ''}${quoteName(cte.name.trim(), ctx)} AS (`;
            const closing = i < q.ctes.length - 1 ? '),' : ')';
            lines.push(...wrapBlock(opening, renderSelect(cte.query, ctx), closing));
        });
    }

    const hasSetOps = !branch && q.setOps.length > 0;
    const hasOrderBy = !branch && q.orderBy.length > 0;
    const pagination = branch
        ? { clauses: [] }
        : ctx.dialect.paginate({ limit: String(q.limit).trim(), offset: String(q.offset).trim(), hasOrderBy, hasSetOps });

    let head = 'SELECT';
    if (q.distinct) head += ' DISTINCT';
    if (pagination.top) head += ` TOP ${pagination.top}`;

    const columns = q.columns.map(col => renderColumn(col, ctx));
    if (columns.length === 1 && columns[0].length === 1) {
        lines.push([0, `${head} ${columns[0][0][1]}`]);
    } else {
        lines.push([0, head]);
        columns.forEach((colLines, i) => {
            const withComma = i < columns.length - 1
                ? [...colLines.slice(0, -1), [colLines[colLines.length - 1][0], colLines[colLines.length - 1][1] + ',']]
                : colLines;
            lines.push(...indented(withComma));
        });
    }

    lines.push(...prefixFirst('FROM ', renderSource(q.from, ctx)));

    for (const join of q.joins) {
        lines.push(...prefixFirst(`${join.type} `, renderSource(join.source, ctx)));
        if (join.type !== 'CROSS JOIN') {
            // AND / OR lines align with ON rather than nesting under it
            lines.push(...indented(renderClause('ON', join.on, ctx, 0)));
        }
    }

    lines.push(...renderClause('WHERE', q.where, ctx));

    const groupBy = q.groupBy.map(g => expr(g.expr, ctx)).filter(Boolean);
    if (groupBy.length > 0) lines.push([0, `GROUP BY ${groupBy.join(', ')}`]);

    lines.push(...renderClause('HAVING', q.having, ctx));

    if (hasSetOps) {
        for (const setOp of q.setOps) {
            lines.push([0, setOp.op]);
            lines.push(...renderSelect(setOp.query, ctx, { branch: true }));
        }
    }

    if (!branch) {
        const orderBy = renderOrderList(q.orderBy, ctx);
        if (orderBy) {
            lines.push([0, `ORDER BY ${orderBy}`]);
        } else if (pagination.needsOrderBy) {
            // SQL Server's OFFSET … FETCH requires an ORDER BY
            lines.push([0, 'ORDER BY (SELECT NULL)']);
        }
        for (const clause of pagination.clauses) lines.push([0, clause]);
    }

    return lines;
}

const FRAME_CLAUSES = {
    running: 'ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW',
    whole: 'ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING'
};

function renderOrderList(items, ctx) {
    return items
        .filter(o => String(o.expr).trim() !== '')
        .map(o => expr(o.expr, ctx) + (o.direction === 'DESC' ? ' DESC' : ''))
        .join(', ');
}

// FUNC(args) OVER (PARTITION BY … ORDER BY … frame)
function renderWindow(col, ctx) {
    const spec = WINDOW_FUNCTIONS[col.func];
    let args = '';
    if (spec && spec.args !== 'none') {
        args = splitTopLevel(String(col.args)).filter(Boolean).map(a => expr(a, ctx)).join(', ');
        if (args === '' && col.func === 'COUNT') args = '*';
    }
    const over = [];
    const partition = col.partitionBy.map(p => expr(p.expr, ctx)).filter(Boolean);
    if (partition.length) over.push(`PARTITION BY ${partition.join(', ')}`);
    const order = renderOrderList(col.orderBy, ctx);
    if (order) over.push(`ORDER BY ${order}`);
    if (col.frame === 'moving') over.push(`ROWS BETWEEN ${String(col.frameSize).trim()} PRECEDING AND CURRENT ROW`);
    else if (FRAME_CLAUSES[col.frame]) over.push(FRAME_CLAUSES[col.frame]);
    return `${col.func}(${args}) OVER (${over.join(' ')})`;
}

function renderColumn(col, ctx) {
    if (col.kind === 'window') {
        return [[0, renderWindow(col, ctx) + alias(col.alias, ctx)]];
    }
    if (col.kind === 'case') {
        const body = col.cases.map(c => [0, `WHEN ${String(c.when).trim()} THEN ${String(c.then).trim()}`]);
        if (String(col.elseValue).trim() !== '') body.push([0, `ELSE ${String(col.elseValue).trim()}`]);
        return [[0, 'CASE'], ...indented(body), [0, `END${alias(col.alias, ctx)}`]];
    }
    const e = expr(col.expr, ctx);
    let text;
    if (col.aggregate === 'COUNT DISTINCT') text = `COUNT(DISTINCT ${e})`;
    else if (col.aggregate) text = `${col.aggregate}(${e === '' && col.aggregate === 'COUNT' ? '*' : e})`;
    else text = e;
    return [[0, text + alias(col.alias, ctx)]];
}

function renderSource(source, ctx) {
    if (source.kind === 'subquery') {
        return wrapBlock('(', renderSelect(source.query, ctx), `)${alias(source.alias, ctx)}`);
    }
    return [[0, quoteName(source.table.trim(), ctx) + alias(source.alias, ctx)]];
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

function renderClause(keyword, group, ctx, continuationIndent = 1) {
    const items = activeItems(group);
    if (items.length === 0) return [];
    if (group.negate) {
        return prefixFirst(`${keyword} `, renderPredicate({ ...group, negate: true }, ctx));
    }
    return renderItemList(items, group.logic, ctx, `${keyword} `, continuationIndent);
}

// First item gets `firstPrefix`; following items start with AND / OR,
// indented by `continuationIndent` levels.
function renderItemList(items, logic, ctx, firstPrefix = '', continuationIndent = 0) {
    const lines = [];
    const siblings = items.length > 1;
    items.forEach((item, i) => {
        const predicate = renderPredicate(item, ctx, siblings);
        if (i === 0) {
            lines.push(...prefixFirst(firstPrefix, predicate));
        } else {
            lines.push(...indented(prefixFirst(`${logic} `, predicate), continuationIndent));
        }
    });
    return lines;
}

function activeItems(group) {
    return group.items.filter(item => item.kind !== 'group' || activeItems(item).length > 0);
}

function containsSubquery(item) {
    if (item.kind === 'group') return item.items.some(containsSubquery);
    return item.kind === 'condition' && item.valueType === 'subquery';
}

// `siblings`: other conditions share the group, so custom SQL containing a
// top-level AND / OR is wrapped in parentheses to keep its meaning
// (a = 1 AND (b = 2 OR c = 3), not a = 1 AND b = 2 OR c = 3).
function renderPredicate(item, ctx, siblings = false) {
    if (item.kind === 'raw') {
        const sql = String(item.sql).trim();
        const lines = sql.split('\n').map(line => [0, line.trim()]);
        if (!siblings || !hasTopLevelLogic(sql)) return lines;
        if (lines.length === 1) return [[0, `(${lines[0][1]})`]];
        return wrapBlock('(', lines);
    }
    if (item.kind === 'group') {
        const items = activeItems(item);
        const not = item.negate ? 'NOT ' : '';
        if (!items.some(containsSubquery)) {
            const inline = items.map(i => joinCompact(renderPredicate(i, ctx, items.length > 1))).join(` ${item.logic} `);
            return [[0, `${not}(${inline})`]];
        }
        return wrapBlock(`${not}(`, renderItemList(items, item.logic, ctx));
    }
    return renderCondition(item, ctx);
}

function renderCondition(c, ctx) {
    const spec = OPERATORS[c.op] || OPERATORS['='];
    const left = spec.noLeft ? '' : `${expr(c.left, ctx)} `;

    if (c.valueType === 'subquery' && spec.subquery && c.subquery) {
        return wrapBlock(`${left}${c.op} (`, renderSelect(c.subquery, ctx));
    }
    if (spec.operands === 0) return [[0, `${left}${c.op}`.trim()]];
    if (spec.operands === 2) {
        return [[0, `${left}${c.op} ${rhs(c.value, c.valueType, ctx)} AND ${rhs(c.value2, c.valueType, ctx)}`]];
    }
    if (spec.operands === 'list') {
        return [[0, `${left}${c.op} ${renderList(c.value, c.valueType, ctx)}`]];
    }
    return [[0, `${left}${c.op} ${rhs(c.value, c.valueType, ctx)}`]];
}

function renderList(value, valueType, ctx) {
    const text = String(value).trim();
    if (valueType === 'column') {
        return text.startsWith('(') && text.endsWith(')') ? text : `(${text})`;
    }
    const items = splitTopLevel(text).filter(v => v !== '').map(v => literal(v, ctx));
    return `(${items.join(', ')})`;
}

// ---------------------------------------------------------------------------
// INSERT / UPDATE / DELETE
// ---------------------------------------------------------------------------

function renderInsert(q, ctx) {
    const columns = splitTopLevel(q.columns).filter(Boolean).map(c => expr(c, ctx));
    const target = quoteName(q.table.trim(), ctx) + (columns.length ? ` (${columns.join(', ')})` : '');
    if (q.source === 'select') {
        return [[0, `INSERT INTO ${target}`], ...renderSelect(q.select, ctx), ...renderUpsert(q.upsert, ctx)];
    }
    const rows = q.rows.map(row => {
        const values = String(row.values).trim();
        return values.startsWith('(') && values.endsWith(')') && splitTopLevel(values).length === 1
            ? values
            : `(${splitTopLevel(values).join(', ')})`;
    });
    const lines = [[0, `INSERT INTO ${target}`]];
    if (rows.length === 1) {
        lines.push([0, `VALUES ${rows[0]}`]);
    } else {
        lines.push([0, 'VALUES']);
        rows.forEach((row, i) => lines.push([1, row + (i < rows.length - 1 ? ',' : '')]));
    }
    lines.push(...renderUpsert(q.upsert, ctx));
    return lines;
}

// SET list: "SET a = 1" on one line, or one assignment per indented line
function renderAssignments(opening, assignments) {
    if (assignments.length === 1) return [[0, `${opening} ${assignments[0]}`]];
    return [[0, opening], ...assignments.map((a, i) => [1, a + (i < assignments.length - 1 ? ',' : '')])];
}

// ON CONFLICT … (PostgreSQL) / ON DUPLICATE KEY UPDATE … (MySQL)
function renderUpsert(upsert, ctx) {
    if (!upsert || !upsert.mode || !ctx.dialect.upsert) return [];
    const assignments = upsert.set.map(a => `${expr(a.column, ctx)} = ${rhs(a.value, a.valueType, ctx, a.column)}`);
    if (ctx.dialect.upsert === 'on-duplicate-key') {
        return renderAssignments('ON DUPLICATE KEY UPDATE', assignments);
    }
    const target = splitTopLevel(String(upsert.conflict)).filter(Boolean).map(c => expr(c, ctx));
    const head = `ON CONFLICT${target.length ? ` (${target.join(', ')})` : ''}`;
    if (upsert.mode === 'nothing') return [[0, `${head} DO NOTHING`]];
    return [[0, `${head} DO UPDATE`], ...renderAssignments('SET', assignments)];
}

function renderUpdate(q, ctx) {
    const assignments = q.set.map(a => `${expr(a.column, ctx)} = ${rhs(a.value, a.valueType, ctx)}`);
    const lines = [[0, `UPDATE ${quoteName(q.table.trim(), ctx)}`], ...renderAssignments('SET', assignments)];
    lines.push(...renderClause('WHERE', q.where, ctx));
    return lines;
}

function renderDelete(q, ctx) {
    return [
        [0, `DELETE FROM ${quoteName(q.table.trim(), ctx)}`],
        ...renderClause('WHERE', q.where, ctx)
    ];
}
