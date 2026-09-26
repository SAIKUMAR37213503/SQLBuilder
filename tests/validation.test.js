import { describe, expect, test } from 'vitest';
import { validateQuery, validateWorkspace, hasErrors, summarize, outputColumnCount } from '../src/validation.js';
import {
    createSelect, createColumn, createCaseColumn, createCondition, createRawCondition, createGroup, createJoin,
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
        expect(find(validateQuery(select({ setOps: [u] })), 'inside a UNION part are ignored')).toBeTruthy();
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
