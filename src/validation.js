// Validation of the query model.
//
// Issues are { level, category, message, path }:
//   level:    'error'   – the SQL would be broken; generation is blocked
//             'warning' – valid SQL that is probably not what you want
//             'info'    – a hint
//   category: 'builder' – missing / inconsistent builder input
//             'syntax'  – lightweight checks on typed SQL fragments
//                         (quotes, parentheses, ";") — not a full parser
//             'safety'  – destructive statements (UPDATE / DELETE)
//   path:     model path of the field the issue refers to
//
// Only errors block generation; warnings never stop the user.

import { OPERATORS, JOIN_TYPES, SET_OPERATORS, AGGREGATES, LOGIC_OPERATORS, joinPath } from './model.js';
import { getDialect } from './dialects.js';
import {
    findSyntaxProblem, isQualifiedName, isIdentifier, isColumnReference, splitTopLevel,
    containsAggregateCall, normalizeExpr, isNumberLiteral, isQuotedString, isBareIdentifier
} from './sql-utils.js';

export const MAX_NESTING_DEPTH = 4;

const SQL_VALUE_KEYWORDS = new Set([
    'NULL', 'DEFAULT', 'TRUE', 'FALSE', 'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP',
    'LOCALTIME', 'LOCALTIMESTAMP', 'CURRENT_USER'
]);

/**
 * @param {any} workspace
 * @param {{ dialect?: string }} [options]
 */
export function validateWorkspace(workspace, options = {}) {
    return validateQuery(workspace[workspace.type], options, workspace.type);
}

/**
 * @param {any} query
 * @param {{ dialect?: string }} [options]
 * @param {string} [basePath]
 */
export function validateQuery(query, options = {}, basePath = '') {
    const v = new Validator(getDialect(options.dialect));
    switch (query.kind) {
        case 'select': v.select(query, basePath, { scope: '', depth: 0, branch: false, top: true }); break;
        case 'insert': v.insert(query, basePath); break;
        case 'update': v.update(query, basePath); break;
        case 'delete': v.delete(query, basePath); break;
        default: v.add('error', 'builder', `Unknown query type "${query.kind}".`, basePath);
    }
    return v.issues;
}

export function hasErrors(issues) {
    return issues.some(issue => issue.level === 'error');
}

export function summarize(issues) {
    const count = (level) => issues.filter(i => i.level === level).length;
    return { errors: count('error'), warnings: count('warning'), infos: count('info') };
}

const blank = (value) => String(value ?? '').trim() === '';
const quote = (text) => `“${String(text).trim()}”`;

class Validator {
    constructor(dialect) {
        this.dialect = dialect;
        this.issues = [];
    }

    add(level, category, message, path, scope = '') {
        this.issues.push({ level, category, message: scope ? `${scope}: ${message}` : message, path });
    }

    // Free-form SQL fragment: required check + balance check
    fragment(text, path, scope, { required = true, label = 'a value' } = {}) {
        if (blank(text)) {
            if (required) this.add('error', 'builder', `Enter ${label}.`, path, scope);
            return false;
        }
        const problem = findSyntaxProblem(String(text));
        if (problem) {
            this.add('error', 'syntax', `${quote(text)} ${problem}.`, path, scope);
            return false;
        }
        return true;
    }

    tableName(name, path, scope, label = 'a table name') {
        if (blank(name)) {
            this.add('error', 'builder', `Enter ${label}.`, path, scope);
        } else if (!isQualifiedName(name.trim())) {
            this.add('error', 'builder',
                `${quote(name)} isn't a valid table name. Use letters, numbers and _ (optionally schema.table), or wrap the name in quotes.`,
                path, scope);
        }
    }

    alias(name, path, scope) {
        if (!blank(name) && !isIdentifier(name.trim())) {
            this.add('error', 'builder',
                `Alias ${quote(name)} can only contain letters, numbers and _ and can't start with a number (or wrap it in quotes).`,
                path, scope);
        }
    }

    // ------------------------------------------------------------------ SELECT

    select(q, path, ctx) {
        const { scope } = ctx;
        if (ctx.depth > MAX_NESTING_DEPTH) {
            this.add('error', 'builder', `Queries can be nested at most ${MAX_NESTING_DEPTH} levels deep.`, path, scope);
            return;
        }

        this.ctes(q, path, ctx);
        this.columns(q, path, scope);
        this.sources(q, path, ctx);
        this.group(q.where, joinPath(path, 'where'), scope, ctx, 'WHERE');

        q.groupBy.forEach((g, i) => this.fragment(g.expr, joinPath(path, 'groupBy', i, 'expr'), scope, { label: 'a column to group by' }));
        this.group(q.having, joinPath(path, 'having'), scope, ctx, 'HAVING');
        this.grouping(q, path, scope);

        if (ctx.branch) {
            if (q.orderBy.length || !blank(q.limit) || !blank(q.offset)) {
                this.add('warning', 'builder', 'ORDER BY, LIMIT and OFFSET inside a UNION part are ignored; set them on the main query.', joinPath(path, 'orderBy'), scope);
            }
        } else {
            q.orderBy.forEach((o, i) => {
                this.fragment(o.expr, joinPath(path, 'orderBy', i, 'expr'), scope, { label: 'a column to sort by' });
                if (o.direction !== 'ASC' && o.direction !== 'DESC') {
                    this.add('error', 'builder', 'Sort direction must be ASC or DESC.', joinPath(path, 'orderBy', i, 'direction'), scope);
                }
            });
            this.pagination(q, path, scope);
        }

        this.setOps(q, path, ctx);
    }

    ctes(q, path, ctx) {
        if (q.ctes.length === 0) return;
        if (!ctx.top) {
            this.add('error', 'builder', 'WITH (CTEs) can only be used on the main query.', joinPath(path, 'ctes'), ctx.scope);
            return;
        }
        const seen = new Set();
        q.ctes.forEach((cte, i) => {
            const cPath = joinPath(path, 'ctes', i);
            const name = String(cte.name).trim();
            if (!name) {
                this.add('error', 'builder', `Name CTE ${i + 1}.`, joinPath(cPath, 'name'));
            } else if (!isIdentifier(name)) {
                this.add('error', 'builder', `CTE name ${quote(name)} can only contain letters, numbers and _.`, joinPath(cPath, 'name'));
            } else if (seen.has(name.toLowerCase())) {
                this.add('error', 'builder', `Two CTEs are named ${quote(name)}.`, joinPath(cPath, 'name'));
            }
            seen.add(name.toLowerCase());
            this.select(cte.query, joinPath(cPath, 'query'), {
                scope: `CTE ${name ? quote(name) : i + 1}`, depth: ctx.depth + 1, branch: false, top: false
            });
        });
    }

    columns(q, path, scope) {
        if (q.columns.length === 0) {
            this.add('error', 'builder', 'Add at least one column.', joinPath(path, 'columns'), scope);
            return;
        }
        const outputNames = new Map();
        q.columns.forEach((col, i) => {
            const cPath = joinPath(path, 'columns', i);
            if (col.kind === 'case') {
                if (col.cases.length === 0) this.add('error', 'builder', 'A CASE column needs at least one WHEN.', joinPath(cPath, 'cases'), scope);
                col.cases.forEach((c, j) => {
                    this.fragment(c.when, joinPath(cPath, 'cases', j, 'when'), scope, { label: 'a WHEN condition' });
                    this.fragment(c.then, joinPath(cPath, 'cases', j, 'then'), scope, { label: 'a THEN result' });
                });
                this.fragment(col.elseValue, joinPath(cPath, 'elseValue'), scope, { required: false });
                if (blank(col.alias)) this.add('info', 'builder', 'Give the CASE column an alias so the result has a readable name.', joinPath(cPath, 'alias'), scope);
            } else {
                if (!AGGREGATES.includes(col.aggregate)) this.add('error', 'builder', `Unknown aggregate ${quote(col.aggregate)}.`, joinPath(cPath, 'aggregate'), scope);
                const countStar = col.aggregate === 'COUNT' && blank(col.expr);
                if (!countStar) this.fragment(col.expr, joinPath(cPath, 'expr'), scope, { label: 'a column or expression' });
                if (col.aggregate && col.aggregate !== 'COUNT' && String(col.expr).trim() === '*') {
                    this.add('error', 'builder', `${col.aggregate}(*) isn't valid; choose a column.`, joinPath(cPath, 'expr'), scope);
                }
            }
            this.alias(col.alias, joinPath(cPath, 'alias'), scope);

            const outName = !blank(col.alias) ? String(col.alias).trim() : col.kind === 'column' && !col.aggregate ? String(col.expr).trim() : '';
            if (outName && outName !== '*') {
                const key = normalizeExpr(outName.split('.').pop());
                if (outputNames.has(key)) {
                    this.add('warning', 'builder', `Two columns are named ${quote(outName)}; add an alias to tell them apart.`, joinPath(cPath, col.alias ? 'alias' : 'expr'), scope);
                }
                outputNames.set(key, i);
            }
        });
    }

    source(source, path, scope, ctx, role) {
        if (source.kind === 'subquery') {
            if (blank(source.alias)) {
                this.add('error', 'builder', `A subquery used as a ${role} needs an alias.`, joinPath(path, 'alias'), scope);
            }
            this.alias(source.alias, joinPath(path, 'alias'), scope);
            this.select(source.query, joinPath(path, 'query'), {
                scope: `${role === 'join' ? 'Joined subquery' : 'Subquery in FROM'}${blank(source.alias) ? '' : ` ${quote(source.alias)}`}`,
                depth: ctx.depth + 1, branch: false, top: false
            });
            return;
        }
        this.tableName(source.table, joinPath(path, 'table'), scope, role === 'join' ? 'the table to join' : 'the table to select from');
        this.alias(source.alias, joinPath(path, 'alias'), scope);
    }

    sources(q, path, ctx) {
        const { scope } = ctx;
        this.source(q.from, joinPath(path, 'from'), scope, ctx, 'table');

        const names = new Map();
        const register = (source, sPath) => {
            const name = String(source.alias || (source.kind === 'table' ? source.table : '')).trim().toLowerCase();
            if (!name) return;
            if (names.has(name)) {
                const hasAlias = !blank(source.alias);
                this.add(hasAlias ? 'error' : 'warning', 'builder',
                    hasAlias
                        ? `The alias ${quote(source.alias)} is used twice.`
                        : `${quote(source.table)} is joined more than once; give each one an alias.`,
                    joinPath(sPath, hasAlias ? 'alias' : 'table'), scope);
            }
            names.set(name, true);
        };
        register(q.from, joinPath(path, 'from'));

        q.joins.forEach((join, i) => {
            const jPath = joinPath(path, 'joins', i);
            if (!JOIN_TYPES.includes(join.type)) {
                this.add('error', 'builder', `Unknown join type ${quote(join.type)}.`, joinPath(jPath, 'type'), scope);
            } else if (join.type === 'FULL JOIN' && !this.dialect.supportsFullJoin) {
                this.add('error', 'builder', `${this.dialect.label} doesn't support FULL JOIN. Use a LEFT JOIN combined with a RIGHT JOIN via UNION instead.`, joinPath(jPath, 'type'), scope);
            }
            this.source(join.source, joinPath(jPath, 'source'), scope, ctx, 'join');
            register(join.source, joinPath(jPath, 'source'));

            const conditions = countActive(join.on);
            if (join.type === 'CROSS JOIN') {
                if (conditions > 0) this.add('info', 'builder', 'CROSS JOIN has no ON clause; its conditions are ignored.', joinPath(jPath, 'on'), scope);
            } else if (conditions === 0) {
                this.add('error', 'builder', `Add a condition saying how ${quote(join.source.table || join.source.alias || 'the joined table')} matches the other tables.`, joinPath(jPath, 'on'), scope);
            } else {
                this.group(join.on, joinPath(jPath, 'on'), scope, ctx, 'ON');
            }
        });
    }

    group(group, path, scope, ctx, clause) {
        if (!LOGIC_OPERATORS.includes(group.logic)) {
            this.add('error', 'builder', `Unknown logic operator ${quote(group.logic)}.`, joinPath(path, 'logic'), scope);
        }
        group.items.forEach((item, i) => {
            const iPath = joinPath(path, 'items', i);
            if (item.kind === 'group') {
                if (countActive(item) === 0) {
                    this.add('warning', 'builder', `An empty condition group in ${clause} is ignored.`, iPath, scope);
                } else {
                    this.group(item, iPath, scope, ctx, clause);
                }
            } else if (item.kind === 'raw') {
                this.fragment(item.sql, joinPath(iPath, 'sql'), scope, { label: 'the custom SQL condition' });
            } else {
                this.condition(item, iPath, scope, ctx, clause);
            }
        });
    }

    condition(c, path, scope, ctx, clause) {
        const spec = OPERATORS[c.op];
        if (!spec) {
            this.add('error', 'builder', `Unknown operator ${quote(c.op)}.`, joinPath(path, 'op'), scope);
            return;
        }
        if (!spec.noLeft) this.fragment(c.left, joinPath(path, 'left'), scope, { label: 'a column or expression' });

        if (c.valueType === 'subquery') {
            if (!spec.subquery) {
                this.add('error', 'builder', `${c.op} can't compare with a subquery.`, joinPath(path, 'valueType'), scope);
                return;
            }
            if (!c.subquery) {
                this.add('error', 'builder', 'The subquery is empty.', joinPath(path, 'subquery'), scope);
                return;
            }
            this.select(c.subquery, joinPath(path, 'subquery'), {
                scope: `Subquery in ${clause}`, depth: ctx.depth + 1, branch: false, top: false
            });
            if (!spec.subqueryOnly && outputColumnCount(c.subquery) > 1) {
                this.add('error', 'builder', `A subquery used with ${c.op} must return exactly one column.`, joinPath(path, 'subquery', 'columns'), scope);
            }
            return;
        }
        if (spec.subqueryOnly) {
            this.add('error', 'builder', `${c.op} needs a subquery; set the value type to "Subquery".`, joinPath(path, 'valueType'), scope);
            return;
        }

        const isColumn = c.valueType === 'column';
        const checkValue = (value, key, label) => {
            if (isColumn) this.fragment(value, joinPath(path, key), scope, { label });
            else if (blank(value)) this.add('error', 'builder', `Enter ${label}. (Use '' to compare with empty text.)`, joinPath(path, key), scope);
        };

        if (spec.operands === 1) {
            checkValue(c.value, 'value', 'a value');
            if (!isColumn && /^null$/i.test(String(c.value).trim()) && ['=', '!=', '<>'].includes(c.op)) {
                this.add('warning', 'builder', `${c.op} NULL never matches any row; use ${c.op === '=' ? 'IS NULL' : 'IS NOT NULL'} instead.`, joinPath(path, 'op'), scope);
            }
            if ((c.op === 'LIKE' || c.op === 'NOT LIKE') && !isColumn && !blank(c.value) && !/[%_]/.test(c.value)) {
                this.add('info', 'builder', `${c.op} without % or _ only matches the exact text; add % for "contains" / "starts with".`, joinPath(path, 'value'), scope);
            }
        } else if (spec.operands === 2) {
            checkValue(c.value, 'value', 'the lower bound');
            checkValue(c.value2, 'value2', 'the upper bound');
        } else if (spec.operands === 'list') {
            if (isColumn) this.fragment(c.value, joinPath(path, 'value'), scope, { label: 'a list of values' });
            else if (splitTopLevel(String(c.value)).filter(v => v !== '').length === 0) {
                this.add('error', 'builder', `Enter one or more values for ${c.op}, separated by commas.`, joinPath(path, 'value'), scope);
            }
        }
    }

    grouping(q, path, scope) {
        const isAggregated = (col) => col.kind === 'column'
            ? Boolean(col.aggregate) || containsAggregateCall(col.expr)
            : col.cases.some(c => containsAggregateCall(c.when) || containsAggregateCall(c.then));
        const aggregated = q.columns.some(isAggregated);
        const groupKeys = new Set(q.groupBy.map(g => normalizeExpr(String(g.expr))).filter(Boolean));

        if (groupKeys.size > 0 || aggregated) {
            q.columns.forEach((col, i) => {
                if (col.kind !== 'column' || isAggregated(col)) return;
                const e = String(col.expr).trim();
                if (!e || isNumberLiteral(e) || isQuotedString(e)) return;
                if (e === '*' || e.endsWith('.*')) {
                    if (groupKeys.size > 0) this.add('warning', 'builder', 'SELECT * with GROUP BY usually fails; list the grouped columns instead.', joinPath(path, 'columns', i, 'expr'), scope);
                    return;
                }
                const matches = groupKeys.has(normalizeExpr(e)) || (!blank(col.alias) && groupKeys.has(normalizeExpr(col.alias)));
                if (!matches) {
                    this.add('warning', 'builder', groupKeys.size > 0
                        ? `${quote(e)} is selected but isn't in GROUP BY or inside an aggregate.`
                        : `${quote(e)} is mixed with aggregates; add it to GROUP BY.`,
                    joinPath(path, 'columns', i, 'expr'), scope);
                }
            });
        }

        if (countActive(q.having) > 0 && groupKeys.size === 0 && !aggregated) {
            this.add('warning', 'builder', 'HAVING filters groups, but there is no GROUP BY or aggregate. Did you mean WHERE?', joinPath(path, 'having'), scope);
        }
    }

    pagination(q, path, scope) {
        const limit = String(q.limit).trim();
        const offset = String(q.offset).trim();
        if (limit !== '' && !/^\d+$/.test(limit)) {
            this.add('error', 'builder', 'LIMIT must be a whole number.', joinPath(path, 'limit'), scope);
        } else if (limit !== '' && Number(limit) < 1) {
            this.add('error', 'builder', 'LIMIT must be at least 1.', joinPath(path, 'limit'), scope);
        }
        if (offset !== '' && !/^\d+$/.test(offset)) {
            this.add('error', 'builder', 'OFFSET must be a whole number (0 or more).', joinPath(path, 'offset'), scope);
        }
        if ((limit !== '' || offset !== '') && q.orderBy.length === 0) {
            const usesFetch = this.dialect.id === 'sqlserver' && (offset !== '' || q.setOps.length > 0);
            this.add('info', 'builder', usesFetch
                ? 'SQL Server needs ORDER BY for OFFSET/FETCH, so ORDER BY (SELECT NULL) was added. Add a real sort for predictable pages.'
                : 'Without ORDER BY, which rows LIMIT/OFFSET return is not guaranteed.',
            joinPath(path, 'orderBy'), scope);
        }
    }

    setOps(q, path, ctx) {
        if (q.setOps.length === 0) return;
        const mainCount = outputColumnCount(q);
        q.setOps.forEach((setOp, i) => {
            const sPath = joinPath(path, 'setOps', i);
            if (!SET_OPERATORS.includes(setOp.op)) {
                this.add('error', 'builder', `Unknown set operator ${quote(setOp.op)}.`, joinPath(sPath, 'op'), ctx.scope);
            }
            const label = `${setOp.op} query ${i + 1}`;
            this.select(setOp.query, joinPath(sPath, 'query'), {
                scope: ctx.scope ? `${ctx.scope} › ${label}` : label, depth: ctx.depth + 1, branch: true, top: false
            });
            const count = outputColumnCount(setOp.query);
            if (mainCount > 0 && count > 0 && count !== mainCount) {
                this.add('error', 'builder',
                    `${label} returns ${count} column${count === 1 ? '' : 's'} but the first query returns ${mainCount}. UNION queries must select the same number of columns.`,
                    joinPath(sPath, 'query', 'columns'), ctx.scope);
            }
        });
    }

    // ------------------------------------------------------------ INSERT etc.

    insert(q, path) {
        this.tableName(q.table, joinPath(path, 'table'), '', 'the table to insert into');

        const columns = splitTopLevel(String(q.columns)).filter(c => c !== '');
        const seen = new Set();
        columns.forEach(col => {
            if (!isColumnReference(col) || col.endsWith('*')) {
                this.add('error', 'builder', `${quote(col)} isn't a valid column name.`, joinPath(path, 'columns'));
            } else if (seen.has(col.toLowerCase())) {
                this.add('error', 'builder', `Column ${quote(col)} is listed twice.`, joinPath(path, 'columns'));
            }
            seen.add(col.toLowerCase());
        });
        if (columns.length === 0) {
            this.add('info', 'builder', 'Listing the columns makes the INSERT safer if the table changes later.', joinPath(path, 'columns'));
        }

        if (q.rows.length === 0) {
            this.add('error', 'builder', 'Add at least one row of values.', joinPath(path, 'rows'));
        }
        let firstCount = null;
        q.rows.forEach((row, i) => {
            const rPath = joinPath(path, 'rows', i, 'values');
            const label = q.rows.length > 1 ? `Row ${i + 1}` : 'VALUES';
            if (!this.fragment(row.values, rPath, '', { label: q.rows.length > 1 ? `the values for row ${i + 1}` : 'the values to insert' })) return;
            const values = unwrapParens(String(row.values).trim());
            const parts = splitTopLevel(values);
            if (parts.some(p => p === '')) {
                this.add('error', 'syntax', `${label} has an empty value between commas.`, rPath);
                return;
            }
            if (columns.length > 0 && parts.length !== columns.length) {
                this.add('error', 'builder', `${label} has ${parts.length} value${parts.length === 1 ? '' : 's'} but ${columns.length} column${columns.length === 1 ? ' is' : 's are'} listed.`, rPath);
            } else if (columns.length === 0 && firstCount !== null && parts.length !== firstCount) {
                this.add('error', 'builder', `${label} has ${parts.length} values but row 1 has ${firstCount}.`, rPath);
            }
            if (firstCount === null) firstCount = parts.length;
            parts.forEach(part => {
                if (isBareIdentifier(part) && !SQL_VALUE_KEYWORDS.has(part.toUpperCase())) {
                    this.add('warning', 'builder', `${label}: ${part} will be read as a column name. If it's text, write '${part}'.`, rPath);
                }
            });
        });
    }

    update(q, path) {
        this.tableName(q.table, joinPath(path, 'table'), '', 'the table to update');
        if (q.set.length === 0) {
            this.add('error', 'builder', 'Add at least one column to SET.', joinPath(path, 'set'));
        }
        const seen = new Set();
        q.set.forEach((a, i) => {
            const aPath = joinPath(path, 'set', i);
            const col = String(a.column).trim();
            if (!col) {
                this.add('error', 'builder', 'Enter the column to change.', joinPath(aPath, 'column'));
            } else if (!isColumnReference(col) || col.endsWith('*')) {
                this.add('error', 'builder', `${quote(col)} isn't a valid column name.`, joinPath(aPath, 'column'));
            } else if (seen.has(col.toLowerCase())) {
                this.add('error', 'builder', `Column ${quote(col)} is set twice.`, joinPath(aPath, 'column'));
            }
            seen.add(col.toLowerCase());
            if (a.valueType === 'column') this.fragment(a.value, joinPath(aPath, 'value'), '', { label: 'the new value' });
            else if (blank(a.value)) this.add('error', 'builder', "Enter the new value. (Use '' for empty text or NULL.)", joinPath(aPath, 'value'));
        });
        this.group(q.where, joinPath(path, 'where'), '', { depth: 0 }, 'WHERE');
        if (countActive(q.where) === 0) {
            const table = blank(q.table) ? 'the table' : quote(q.table);
            this.add('warning', 'safety', `Warning: This UPDATE query has no WHERE clause and will modify every row in ${table}.`, joinPath(path, 'where'));
        }
    }

    delete(q, path) {
        this.tableName(q.table, joinPath(path, 'table'), '', 'the table to delete from');
        this.group(q.where, joinPath(path, 'where'), '', { depth: 0 }, 'WHERE');
        if (countActive(q.where) === 0) {
            this.add('warning', 'safety', 'Warning: This DELETE query has no WHERE clause and may affect all rows.', joinPath(path, 'where'));
        }
    }
}

function countActive(group) {
    return group.items.reduce((n, item) => n + (item.kind === 'group' ? countActive(item) : 1), 0);
}

function unwrapParens(text) {
    if (text.startsWith('(') && text.endsWith(')') && splitTopLevel(text).length === 1) {
        return text.slice(1, -1).trim();
    }
    return text;
}

// Number of output columns, or -1 when unknowable (a wildcard is selected).
export function outputColumnCount(select) {
    if (select.columns.some(c => c.kind === 'column' && !c.aggregate && /(^|\.)\*$/.test(String(c.expr).trim()))) return -1;
    return select.columns.length;
}
