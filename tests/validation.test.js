import { describe, expect, test } from 'vitest';
import { validateQuery, validateWorkspace, hasErrors, summarize, outputColumnCount } from '../src/validation.js';
import {
    createSelect, createColumn, createCaseColumn, createWindowColumn, createCondition, createRawCondition, createGroup, createJoin,
    createTableSource, createSubquerySource, createCte, createSetOp, createGroupByItem, createOrderItem,
    createInsert, createUpdate, createDelete, createWorkspace
} from '../src/model.js';

function select(overrides = {}) {
    return createSelect({ columns: [createColumn('*')], from: createTableSource('t'), ...overrides });
}
const cond = (left, op, value = '', extra = {}) => createCondition({ left, op, value, ...extra });
const where = (...items) => createGroup('AND', items);
const messages = (issues, level) => issues.filter(i => !level || i.level === level).map(i => i.message);
const find = (issues, text) => issues.find(i => i.message.includes(text));

describe('SELECT basics', () => {
    test('a complete query has no issues', () => {
        expect(validateQuery(select())).toEqual([]);
    });

    test('missing table and column are errors with field paths', () => {
        const issues = validateQuery(createSelect(), {}, 'select');
        expect(issues).toEqual(expect.arrayContaining([
            expect.objectContaining({ level: 'error', path: 'select.from.table', message: 'Enter the table to select from.' }),
            expect.objectContaining({ level: 'error', path: 'select.columns.0.expr', message: 'Enter a column or expression.' })
        ]));
    });

    test('invalid table names and aliases', () => {
        const q = select({ from: createTableSource("users; DROP TABLE x", 'my alias') });
        const issues = validateQuery(q);
        expect(find(issues, "isn't a valid table name")).toBeTruthy();
        expect(find(issues, 'Alias “my alias”')).toBeTruthy();
    });

    test('quoted and schema-qualified table names are accepted', () => {
        expect(validateQuery(select({ from: createTableSource('"Order Details"') }))).toEqual([]);
        expect(validateQuery(select({ from: createTableSource('sales.orders', 'o') }))).toEqual([]);
    });

    test('syntax problems in expressions', () => {
        const q = select({ columns: [createColumn("CONCAT(a, 'x'"), createColumn("name = 'oops")] });
        const issues = validateQuery(q);
        expect(issues.filter(i => i.category === 'syntax')).toHaveLength(2);
    });

    test('duplicate output column names warn', () => {
        const q = select({ columns: [createColumn('a.name'), createColumn('b.name')] });
        expect(find(validateQuery(q), 'Two columns are named')).toMatchObject({ level: 'warning' });
    });

    test('SUM(*) is invalid, COUNT with empty expression is COUNT(*)', () => {
        expect(find(validateQuery(select({ columns: [createColumn('*', { aggregate: 'SUM' })] })), 'SUM(*)')).toBeTruthy();
        expect(validateQuery(select({ columns: [createColumn('', { aggregate: 'COUNT' })] }))).toEqual([]);
    });

    test('CASE requires WHEN/THEN and hints about an alias', () => {
        const c = createCaseColumn();
        const issues = validateQuery(select({ columns: [c] }));
        expect(messages(issues, 'error')).toEqual(['Enter a WHEN condition.', 'Enter a THEN result.']);
        expect(messages(issues, 'info')[0]).toMatch(/alias/);
    });

    test('LIMIT and OFFSET must be whole numbers', () => {
        const issues = validateQuery(select({ limit: '0', offset: '-1', orderBy: [createOrderItem('id')] }));
        expect(messages(issues, 'error')).toEqual(['LIMIT must be at least 1.', 'OFFSET must be a whole number (0 or more).']);
        expect(messages(validateQuery(select({ limit: '1.5', orderBy: [createOrderItem('id')] })), 'error')).toEqual(['LIMIT must be a whole number.']);
    });

    test('LIMIT without ORDER BY is a hint, not an error', () => {
        const issues = validateQuery(select({ limit: '10' }));
        expect(hasErrors(issues)).toBe(false);
        expect(messages(issues, 'info')[0]).toMatch(/not guaranteed/);
    });

    test('SQL Server OFFSET without ORDER BY explains the added ORDER BY', () => {
        const issues = validateQuery(select({ limit: '10', offset: '5' }), { dialect: 'sqlserver' });
        expect(messages(issues, 'info')[0]).toMatch(/ORDER BY \(SELECT NULL\)/);
    });
});

describe('conditions', () => {
    test('empty condition values', () => {
        const issues = validateQuery(select({ where: where(cond('', '='), cond('age', 'BETWEEN', '1')) }));
        expect(messages(issues, 'error')).toEqual([
            'Enter a column or expression.',
            "Enter a value. (Use '' to compare with empty text.)",
            "Enter the upper bound. (Use '' to compare with empty text.)"
        ]);
    });

    test('IS NULL needs no value; = NULL warns', () => {
        expect(validateQuery(select({ where: where(cond('x', 'IS NULL')) }))).toEqual([]);
        expect(find(validateQuery(select({ where: where(cond('x', '=', 'null')) })), 'use IS NULL')).toMatchObject({ level: 'warning' });
    });

    test('LIKE without wildcard hints', () => {
        expect(find(validateQuery(select({ where: where(cond('name', 'LIKE', 'Bob')) })), 'without % or _')).toMatchObject({ level: 'info' });
    });

    test('IN needs at least one value', () => {
        expect(find(validateQuery(select({ where: where(cond('id', 'IN', ' , ')) })), 'one or more values')).toBeTruthy();
    });

    test('text values with quote characters are fine', () => {
        expect(validateQuery(select({ where: where(cond('name', '=', `O'Brien "Jr"; --x`)) }))).toEqual([]);
    });

    test('column comparisons are syntax-checked', () => {
        expect(find(validateQuery(select({ where: where(cond('a', '=', 'b; DROP', { valueType: 'column' })) })), 'statements can\'t be chained')).toBeTruthy();
    });

    test('custom SQL condition is checked for balance', () => {
        expect(find(validateQuery(select({ where: where(createRawCondition('(a = 1')) })), 'without a matching ")"')).toBeTruthy();
    });

    test('empty nested group warns, nested conditions are validated', () => {
        const issues = validateQuery(select({ where: where(cond('a', '=', '1'), createGroup('OR', []), createGroup('OR', [cond('', '=', '1')])) }), {}, 'select');
        expect(find(issues, 'empty condition group')).toMatchObject({ level: 'warning', path: 'select.where.items.1' });
        expect(find(issues, 'Enter a column')).toMatchObject({ path: 'select.where.items.2.items.0.left' });
    });

    test('EXISTS requires a subquery', () => {
        expect(find(validateQuery(select({ where: where(cond('', 'EXISTS')) })), 'needs a subquery')).toBeTruthy();
    });
});

describe('joins', () => {
    const join = (type, table, alias, on = true) => {
        const j = createJoin(type);
        j.source = createTableSource(table, alias);
        j.on = on ? where(cond('a.id', '=', 'b.id', { valueType: 'column' })) : createGroup();
        return j;
    };

    test('join without ON is an error, CROSS JOIN is fine', () => {
        expect(find(validateQuery(select({ joins: [join('INNER JOIN', 'b', '', false)] })), 'Add a condition saying how')).toBeTruthy();
        expect(validateQuery(select({ joins: [join('CROSS JOIN', 'b', '', false)] }))).toEqual([]);
    });

    test('duplicate aliases error, joining the same table twice without alias warns', () => {
        expect(find(validateQuery(select({ from: createTableSource('a', 'x'), joins: [join('INNER JOIN', 'b', 'x')] })), 'alias “x” is used twice')).toMatchObject({ level: 'error' });
        expect(find(validateQuery(select({ joins: [join('INNER JOIN', 't', '')] })), 'joined more than once')).toMatchObject({ level: 'warning' });
    });

    test('FULL JOIN is rejected for MySQL only', () => {
        const q = select({ joins: [join('FULL JOIN', 'b', '')] });
        expect(hasErrors(validateQuery(q, { dialect: 'postgresql' }))).toBe(false);
        expect(find(validateQuery(q, { dialect: 'mysql' }), "doesn't support FULL JOIN")).toBeTruthy();
    });
});

describe('GROUP BY / HAVING', () => {
    test('selected column missing from GROUP BY warns', () => {
        const q = select({ columns: [createColumn('dept'), createColumn('city'), createColumn('', { aggregate: 'COUNT' })], groupBy: [createGroupByItem('dept')] });
        const issues = validateQuery(q);
        expect(messages(issues, 'warning')).toEqual(['“city” is selected but isn\'t in GROUP BY or inside an aggregate.']);
    });

    test('aggregates mixed with plain columns and no GROUP BY warns', () => {
        const q = select({ columns: [createColumn('dept'), createColumn('SUM(salary)')] });
        expect(messages(validateQuery(q), 'warning')).toEqual(['“dept” is mixed with aggregates; add it to GROUP BY.']);
    });

    test('GROUP BY matches case/whitespace-insensitively', () => {
        const q = select({ columns: [createColumn('UPPER( dept )'), createColumn('', { aggregate: 'COUNT' })], groupBy: [createGroupByItem('upper(dept)')] });
        expect(validateQuery(q)).toEqual([]);
    });

    test('HAVING without GROUP BY or aggregate suggests WHERE', () => {
        expect(find(validateQuery(select({ having: where(cond('a', '=', '1')) })), 'Did you mean WHERE')).toBeTruthy();
    });
});

describe('subqueries, CTEs, UNION', () => {
    test('errors inside subqueries are scoped and pathed', () => {
        const sub = createSelect();
        const q = select({ where: where(cond('id', 'IN', '', { valueType: 'subquery', subquery: sub })) });
        const issue = find(validateQuery(q, {}, 'select'), 'Subquery in WHERE: Enter the table');
        expect(issue.path).toBe('select.where.items.0.subquery.from.table');
    });

    test('IN subquery must return one column', () => {
        const sub = select({ columns: [createColumn('a'), createColumn('b')] });
        expect(find(validateQuery(select({ where: where(cond('id', 'IN', '', { valueType: 'subquery', subquery: sub })) })), 'exactly one column')).toBeTruthy();
    });

    test('derived table needs an alias', () => {
        const from = createSubquerySource();
        from.query = select();
        expect(find(validateQuery(select({ from })), 'needs an alias')).toBeTruthy();
    });

    test('CTE names are required, valid and unique; nested WITH is rejected', () => {
        const a = createCte(); a.name = 'x'; a.query = select();
        const b = createCte(); b.name = 'X'; b.query = select();
        const c = createCte(); c.query = select();
        const issues = validateQuery(select({ ctes: [a, b, c] }));
        expect(messages(issues, 'error')).toEqual(['Two CTEs are named “X”.', 'Name CTE 3.']);

        const from = createSubquerySource();
        from.alias = 's';
        from.query = select({ ctes: [a] });
        expect(find(validateQuery(select({ from })), 'only be used on the main query')).toBeTruthy();
    });

    test('mismatched UNION column counts', () => {
        const u = createSetOp('UNION');
        u.query = select({ columns: [createColumn('a')] });
        const q = select({ columns: [createColumn('a'), createColumn('b')], setOps: [u] });
        expect(find(validateQuery(q), 'must select the same number of columns')).toBeTruthy();
        u.query.columns = [createColumn('*')];
        expect(hasErrors(validateQuery(q))).toBe(false);
    });

    test('ORDER BY inside a UNION branch warns', () => {
        const u = createSetOp('UNION');
        u.query = select({ orderBy: [createOrderItem('x')] });
        expect(find(validateQuery(select({ setOps: [u] })), 'inside a UNION / INTERSECT / EXCEPT part are ignored')).toBeTruthy();
    });

    test('nesting depth is limited', () => {
        let q = select();
        for (let i = 0; i < 6; i++) {
            q = select({ where: where(cond('id', 'IN', '', { valueType: 'subquery', subquery: q })) });
        }
        expect(find(validateQuery(q), 'nested at most')).toBeTruthy();
    });

    test('outputColumnCount', () => {
        expect(outputColumnCount(select({ columns: [createColumn('a'), createColumn('t.*')] }))).toBe(-1);
        expect(outputColumnCount(select({ columns: [createColumn('', { aggregate: 'COUNT' })] }))).toBe(1);
    });
});

describe('INSERT', () => {
    const insert = (columns, ...rows) => ({ ...createInsert(), table: 't', columns, rows: rows.map(values => ({ values })) });

    test('valid multi-row insert', () => {
        expect(validateQuery(insert('a, b', "1, 'x'", "(2, 'y')"))).toEqual([]);
    });

    test('value / column count mismatch', () => {
        expect(messages(validateQuery(insert('a, b', '1, 2, 3')), 'error')).toEqual(['VALUES has 3 values but 2 columns are listed.']);
        expect(messages(validateQuery(insert('a', '1', '1, 2')), 'error')).toEqual(['Row 2 has 2 values but 1 column is listed.']);
    });

    test('rows without a column list must agree with each other', () => {
        expect(messages(validateQuery(insert('', '1, 2', '3')), 'error')).toEqual(['Row 2 has 1 values but row 1 has 2.']);
    });

    test('duplicate and invalid columns, empty values', () => {
        expect(messages(validateQuery(insert('a, A, b c', '1, 2, 3')), 'error')).toEqual([
            'Column “A” is listed twice.', '“b c” isn\'t a valid column name.'
        ]);
        expect(messages(validateQuery(insert('a, b', '1,,')), 'error')).toEqual(['VALUES has an empty value between commas.']);
        expect(messages(validateQuery(insert('a', '')), 'error')).toEqual(['Enter the values to insert.']);
    });

    test('unquoted text warns; SQL keywords do not', () => {
        const issues = validateQuery(insert('name, created', 'John, CURRENT_TIMESTAMP'));
        expect(messages(issues, 'warning')).toEqual(["VALUES: John will be read as a column name. If it's text, write 'John'."]);
    });
});

describe('UPDATE / DELETE safety', () => {
    test('UPDATE without WHERE warns but does not block', () => {
        const q = { ...createUpdate(), table: 'accounts', set: [{ column: 'balance', valueType: 'value', value: '0' }] };
        const issues = validateQuery(q);
        expect(hasErrors(issues)).toBe(false);
        expect(issues).toEqual([expect.objectContaining({
            level: 'warning', category: 'safety',
            message: 'Warning: This UPDATE query has no WHERE clause and will modify every row in “accounts”.'
        })]);
    });

    test('DELETE without WHERE uses the documented warning', () => {
        const issues = validateQuery({ ...createDelete(), table: 'logs' });
        expect(issues).toEqual([expect.objectContaining({
            level: 'warning', category: 'safety', message: 'Warning: This DELETE query has no WHERE clause and may affect all rows.'
        })]);
    });

    test('an empty WHERE group still counts as no WHERE', () => {
        const q = { ...createDelete(), table: 'logs', where: createGroup('AND', [createGroup('OR', [])]) };
        expect(find(validateQuery(q), 'no WHERE clause')).toBeTruthy();
    });

    test('DELETE with WHERE has no warning', () => {
        expect(validateQuery({ ...createDelete(), table: 'logs', where: where(cond('id', '=', '1')) })).toEqual([]);
    });

    test('UPDATE SET requirements', () => {
        const q = { ...createUpdate(), table: 't', set: [{ column: '', valueType: 'value', value: '' }, { column: 'a', valueType: 'value', value: '1' }, { column: 'A', valueType: 'column', value: 'b +' }], where: where(cond('id', '=', '1')) };
        expect(messages(validateQuery(q), 'error')).toEqual([
            'Enter the column to change.', "Enter the new value. (Use '' for empty text or NULL.)", 'Column “A” is set twice.'
        ]);
        expect(messages(validateQuery({ ...q, set: [] }), 'error')).toEqual(['Add at least one column to SET.']);
    });
});

describe('workspace helpers', () => {
    test('validateWorkspace validates the active type with rooted paths', () => {
        const ws = createWorkspace('delete');
        expect(validateWorkspace(ws)[0].path).toBe('delete.table');
    });

    test('summarize counts levels', () => {
        expect(summarize([{ level: 'error' }, { level: 'warning' }, { level: 'warning' }, { level: 'info' }])).toEqual({ errors: 1, warnings: 2, infos: 1 });
    });
});

describe('INTERSECT / EXCEPT validation', () => {
    const combined = (...ops) => select({
        columns: [createColumn('id')],
        setOps: ops.map(op => ({ ...createSetOp(op), query: select({ columns: [createColumn('id')] }) }))
    });

    test('supported everywhere except ALL variants on SQL Server', () => {
        expect(hasErrors(validateQuery(combined('INTERSECT ALL', 'EXCEPT ALL'), { dialect: 'postgresql' }))).toBe(false);
        expect(messages(validateQuery(combined('INTERSECT ALL'), { dialect: 'sqlserver' }), 'error')).toEqual(["SQL Server doesn't support INTERSECT ALL."]);
        expect(hasErrors(validateQuery(combined('INTERSECT', 'EXCEPT'), { dialect: 'sqlserver' }))).toBe(false);
    });

    test('MySQL version tip', () => {
        expect(messages(validateQuery(combined('EXCEPT'), { dialect: 'mysql' }), 'info')).toEqual(['EXCEPT needs MySQL 8.0.31 or later.']);
    });

    test('precedence tip only when INTERSECT is mixed with other operators', () => {
        expect(find(validateQuery(combined('UNION', 'INTERSECT')), 'INTERSECT is evaluated before')).toMatchObject({ level: 'info' });
        expect(find(validateQuery(combined('INTERSECT', 'INTERSECT ALL')), 'INTERSECT is evaluated before')).toBeUndefined();
    });

    test('column count mismatch names the operator', () => {
        const q = combined('EXCEPT');
        q.setOps[0].query.columns.push(createColumn('name'));
        expect(find(validateQuery(q), 'Queries combined with EXCEPT must select the same number of columns')).toBeTruthy();
    });
});

describe('window function validation', () => {
    const order = [{ expr: 'day', direction: 'ASC' }];
    const win = (overrides) => ({ ...createWindowColumn(), alias: 'w', ...overrides });
    const check = (col, dialect) => validateQuery(select({ columns: [col] }), { dialect });

    test('a complete window column has no issues', () => {
        expect(check(win({ func: 'ROW_NUMBER', orderBy: order }))).toEqual([]);
        expect(check(win({ func: 'SUM', args: 'amount', orderBy: order, frame: 'moving', frameSize: '3' }))).toEqual([]);
    });

    test.each([
        [{ func: 'RANK', args: 'x', orderBy: order }, 'RANK() takes no arguments; leave the argument empty.'],
        [{ func: 'NTILE', args: '0', orderBy: order }, 'NTILE needs the number of groups, e.g. 4.'],
        [{ func: 'LAG', args: '', orderBy: order }, 'LAG needs a column, optionally followed by an offset and a default, e.g. salary, 1, 0.'],
        [{ func: 'LEAD', args: 'price, x', orderBy: order }, 'The LEAD offset (second argument) must be a whole number.'],
        [{ func: 'FIRST_VALUE', args: 'a, b' }, 'FIRST_VALUE needs one column or expression.'],
        [{ func: 'NTH_VALUE', args: 'a' }, 'NTH_VALUE needs a column and a position, e.g. salary, 2.'],
        [{ func: 'SUM', args: '*' }, "SUM(*) isn't valid; choose a column."],
        [{ func: 'AVG', args: '' }, 'AVG needs one column or expression.'],
        [{ func: 'ROW_NUMBER', orderBy: order, frame: 'running' }, 'ROW_NUMBER doesn\'t take a window frame; choose "Default".'],
        [{ func: 'SUM', args: 'a', orderBy: order, frame: 'moving', frameSize: '0' }, 'Enter how many preceding rows the moving window covers (1 or more).'],
        [{ func: 'SUM', args: 'SUM(a' }, '“SUM(a” has an opening "(" without a matching ")".']
    ])('%o', (overrides, message) => {
        expect(messages(check(win(overrides)), 'error')).toEqual([message]);
    });

    test('ranking without ORDER BY: warning generally, error on SQL Server', () => {
        const col = win({ func: 'ROW_NUMBER' });
        expect(find(check(col), 'needs ORDER BY inside OVER')).toMatchObject({ level: 'warning' });
        expect(find(check(col, 'sqlserver'), 'needs ORDER BY inside OVER')).toMatchObject({ level: 'error' });
    });

    test('frame without ORDER BY', () => {
        expect(find(check(win({ func: 'SUM', args: 'a', frame: 'running' })), 'window frame needs ORDER BY')).toMatchObject({ level: 'warning' });
    });

    test('NTH_VALUE is rejected on SQL Server; LAST_VALUE frame tip; alias tip', () => {
        expect(find(check(win({ func: 'NTH_VALUE', args: 'a, 2' }), 'sqlserver'), "doesn't support NTH_VALUE")).toBeTruthy();
        expect(find(check(win({ func: 'LAST_VALUE', args: 'a', orderBy: order })), 'Whole partition')).toMatchObject({ level: 'info' });
        expect(find(check(win({ func: 'ROW_NUMBER', orderBy: order, alias: '' })), 'alias')).toMatchObject({ level: 'info' });
    });

    test('filtering a window result in WHERE or HAVING is an error', () => {
        const q = select({
            columns: [createColumn('name'), win({ func: 'ROW_NUMBER', orderBy: order, alias: 'rn' })],
            where: where(cond('RN', '<=', '3'), createRawCondition('RANK() OVER (ORDER BY x) = 1'))
        });
        const errors = validateQuery(q, {}, 'select').filter(i => i.level === 'error');
        expect(errors.map(e => e.path)).toEqual(['select.where.items.0.left', 'select.where.items.1.sql']);
        expect(errors[0].message).toContain('“RN” is a window function result and can\'t be used in WHERE');
        expect(errors[1].message).toContain('Window functions can\'t be used in WHERE');
    });

    test('window columns are ignored by the GROUP BY consistency check', () => {
        const q = select({
            columns: [createColumn('dept'), createColumn('', { aggregate: 'COUNT' }), win({ func: 'RANK', orderBy: [{ expr: 'COUNT(*)', direction: 'DESC' }] })],
            groupBy: [createGroupByItem('dept')]
        });
        expect(validateQuery(q)).toEqual([]);
    });
});

describe('dialect and correctness checks', () => {
    const derived = (inner) => {
        const q = select();
        q.from = createSubquerySource();
        q.from.alias = 'x';
        Object.assign(q.from.query, { columns: [createColumn('id')], from: createTableSource('t') }, inner);
        return q;
    };

    test('SQL Server rejects ORDER BY in a subquery without LIMIT / OFFSET', () => {
        const q = derived({ orderBy: [createOrderItem('id')] });
        const issue = find(validateQuery(q, { dialect: 'sqlserver' }), "doesn't allow ORDER BY inside a subquery");
        expect(issue.level).toBe('error');
        expect(issue.path).toBe('from.query.orderBy');
        expect(find(validateQuery(derived({ orderBy: [createOrderItem('id')], limit: '5' }), { dialect: 'sqlserver' }), 'ORDER BY inside')).toBeUndefined();
        expect(find(validateQuery(q, { dialect: 'postgresql' }), 'ORDER BY inside a subquery').level).toBe('info');
    });

    test('SQL Server rejects ORDER BY inside a CTE', () => {
        const q = select({ ctes: [createCte()] });
        Object.assign(q.ctes[0], { name: 'c' });
        Object.assign(q.ctes[0].query, { columns: [createColumn('id')], from: createTableSource('t'), orderBy: [createOrderItem('id')] });
        expect(hasErrors(validateQuery(q, { dialect: 'sqlserver' }))).toBe(true);
        expect(hasErrors(validateQuery(q, { dialect: 'generic' }))).toBe(false);
    });

    test('MySQL rejects LIMIT inside IN (subquery)', () => {
        const sub = createSelect({ columns: [createColumn('id')], from: createTableSource('b'), limit: '5' });
        const q = select({ where: where(cond('id', 'IN', '', { valueType: 'subquery', subquery: sub })) });
        const issue = find(validateQuery(q, { dialect: 'mysql' }), 'LIMIT inside an IN');
        expect(issue.level).toBe('error');
        expect(find(validateQuery(q, { dialect: 'postgresql' }), 'LIMIT inside')).toBeUndefined();
        const scalar = select({ where: where(cond('id', '=', '', { valueType: 'subquery', subquery: sub })) });
        expect(find(validateQuery(scalar, { dialect: 'mysql' }), 'LIMIT inside')).toBeUndefined();
    });

    test('HAVING on a SELECT alias warns except on MySQL', () => {
        const q = select({
            columns: [createColumn('dept'), createColumn('salary', { aggregate: 'SUM', alias: 'total' })],
            groupBy: [createGroupByItem('dept')],
            having: where(cond('total', '>', '100'))
        });
        const issue = find(validateQuery(q, { dialect: 'postgresql' }), 'is a SELECT alias');
        expect(issue.level).toBe('warning');
        expect(issue.message).toContain('SUM(salary)');
        expect(issue.path).toBe('having.items.0.left');
        expect(find(validateQuery(q, { dialect: 'mysql' }), 'SELECT alias')).toBeUndefined();
        q.having = where(cond('SUM(salary)', '>', '100'));
        expect(find(validateQuery(q, { dialect: 'postgresql' }), 'SELECT alias')).toBeUndefined();
    });

    test('reserved words as names warn unless identifiers are quoted', () => {
        const q = select({ columns: [createColumn('o.id', { alias: 'order' })], from: createTableSource('orders', 'o') });
        const issue = find(validateQuery(q), 'reserved SQL word');
        expect(issue.level).toBe('warning');
        expect(issue.path).toBe('columns.0.alias');
        expect(find(validateQuery(q, { quoteIdentifiers: true }), 'reserved')).toBeUndefined();
        expect(find(validateQuery(select({ from: createTableSource('group') })), 'reserved SQL word').path).toBe('from.table');
        expect(find(validateQuery(select({ columns: [createColumn('t.select')] })), 'reserved SQL word')).toBeTruthy();
        expect(find(validateQuery(select({ columns: [createColumn('COUNT(order_id)')] })), 'reserved')).toBeUndefined();
    });

    test('INSERT warns about leading-zero numbers', () => {
        const q = createInsert();
        Object.assign(q, { table: 't', columns: 'zip, n', rows: [{ values: '01234, 0' }] });
        const issues = validateQuery(q);
        expect(find(issues, "write '01234'").level).toBe('warning');
        expect(issues.filter(i => i.message.includes('stored as the number'))).toHaveLength(1);
    });
});

describe('INSERT … SELECT, upserts and parameters', () => {
    const baseInsert = (extra = {}) => {
        const q = createInsert();
        Object.assign(q, { table: 'customers', columns: 'email, name', rows: [{ values: "'a@x.io', 'Ada'" }] }, extra);
        return q;
    };

    test('INSERT … SELECT column count must match the listed columns', () => {
        const q = baseInsert({ source: 'select' });
        q.select = select({ columns: [createColumn('a')] });
        const issue = find(validateQuery(q), 'SELECT returns 1 column but 2 columns are listed');
        expect(issue.level).toBe('error');
        expect(issue.path).toBe('select.columns');
        q.select.columns.push(createColumn('b'));
        expect(hasErrors(validateQuery(q))).toBe(false);
    });

    test('INSERT … SELECT validates the query, forbids CTEs and allows ORDER BY on SQL Server', () => {
        const q = baseInsert({ source: 'select' });
        q.select = select({ columns: [createColumn('a'), createColumn('b')], orderBy: [createOrderItem('a')] });
        expect(hasErrors(validateQuery(q, { dialect: 'sqlserver' }))).toBe(false);
        q.select.ctes = [createCte()];
        expect(find(validateQuery(q), 'WITH (CTEs) can only be used on the main query')).toBeTruthy();
        q.select.ctes = [];
        q.select.from.table = '';
        expect(find(validateQuery(q), 'table to select from').path).toBe('select.from.table');
    });

    test('VALUES rows are not checked when the rows come from a query', () => {
        const q = baseInsert({ source: 'select', rows: [{ values: '' }] });
        q.select = select({ columns: [createColumn('a'), createColumn('b')] });
        expect(hasErrors(validateQuery(q))).toBe(false);
    });

    test('upsert support per dialect', () => {
        const q = baseInsert({ upsert: { mode: 'nothing', conflict: '', set: [] } });
        expect(find(validateQuery(q, { dialect: 'generic' }), "isn't available for Generic SQL").level).toBe('error');
        expect(find(validateQuery(q, { dialect: 'sqlserver' }), "isn't available for SQL Server")).toBeTruthy();
        expect(hasErrors(validateQuery(q, { dialect: 'postgresql' }))).toBe(false);
        expect(find(validateQuery(q, { dialect: 'mysql' }), 'MySQL has no “do nothing”').level).toBe('error');
    });

    test('PostgreSQL DO UPDATE needs conflict columns and assignments', () => {
        const q = baseInsert({ upsert: { mode: 'update', conflict: '', set: [] } });
        const issues = validateQuery(q, { dialect: 'postgresql' });
        expect(find(issues, 'needs the conflict columns').path).toBe('upsert.conflict');
        expect(find(issues, 'Add at least one column to update').path).toBe('upsert.set');
        q.upsert.conflict = 'email';
        q.upsert.set = [{ column: 'name', valueType: 'inserted', value: '' }];
        expect(hasErrors(validateQuery(q, { dialect: 'postgresql' }))).toBe(false);
    });

    test('upsert assignments: invalid, duplicate and not-inserted columns', () => {
        const q = baseInsert({
            upsert: {
                mode: 'update', conflict: 'email',
                set: [
                    { column: 'name', valueType: 'inserted', value: '' },
                    { column: 'name', valueType: 'value', value: 'x' },
                    { column: 'visits', valueType: 'inserted', value: '' },
                    { column: 'a b', valueType: 'value', value: '1' }
                ]
            }
        });
        const issues = validateQuery(q, { dialect: 'postgresql' });
        expect(find(issues, 'is updated twice')).toBeTruthy();
        expect(find(issues, "isn't one of the inserted columns").level).toBe('warning');
        expect(find(issues, "“a b” isn't a valid column name")).toBeTruthy();
    });

    test('MySQL notes the ignored conflict columns and VALUES() deprecation', () => {
        const q = baseInsert({ upsert: { mode: 'update', conflict: 'email', set: [{ column: 'name', valueType: 'inserted', value: '' }] } });
        const issues = validateQuery(q, { dialect: 'mysql' });
        expect(hasErrors(issues)).toBe(false);
        expect(find(issues, "aren't part of the SQL").level).toBe('info');
        expect(find(issues, 'deprecated from 8.0.20').level).toBe('info');
    });

    test('parameter names', () => {
        const q = select({ where: where(cond('a', '=', 'bad name', { valueType: 'param' })) });
        expect(find(validateQuery(q), 'can only contain letters').level).toBe('error');
        const numbered = select({ where: where(cond('a', '=', '2', { valueType: 'param' })) });
        expect(hasErrors(validateQuery(numbered, { dialect: 'postgresql' }))).toBe(false);
        expect(find(validateQuery(numbered, { dialect: 'sqlserver' }), 'must start with a letter')).toBeTruthy();
        const named = select({ where: where(cond('a', '=', 'x', { valueType: 'param' }), cond('b', '=', 'y', { valueType: 'param' })) });
        const tips = validateQuery(named, { dialect: 'mysql' }).filter(i => i.message.includes('parameter names'));
        expect(tips).toHaveLength(1);
        expect(validateQuery(named, { dialect: 'sqlserver' })).toEqual([]);
    });

    test('parameters are not offered for list operators', () => {
        const q = select({ where: where(cond('a', 'IN', '', { valueType: 'param' })) });
        expect(find(validateQuery(q), "can't take a parameter")).toBeTruthy();
    });

    test('UPDATE SET with a parameter', () => {
        const q = createUpdate();
        Object.assign(q, { table: 't', set: [{ column: 'x', valueType: 'param', value: '' }], where: where(cond('id', '=', '1')) });
        expect(validateQuery(q)).toEqual([]);
    });
});
