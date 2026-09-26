// Built-in starter examples shown in the Templates panel. They are ordinary
// workspaces built with the model factories, so they also exercise the model.

import {
    createWorkspace, createColumn, createCaseColumn, createCondition, createGroup, createJoin,
    createTableSource, createCte, createSetOp, createSelect, createGroupByItem
} from './model.js';

const cond = (left, op, value = '', extra = {}) => createCondition({ left, op, value, ...extra });
const colCond = (left, right) => cond(left, '=', right, { valueType: 'column' });

function workspace(type, fill) {
    const ws = createWorkspace(type);
    fill(ws[type]);
    return ws;
}

export const EXAMPLES = [
    {
        id: 'filter-sort',
        name: 'Filter, sort and limit',
        description: 'Top 10 salaries above 50,000.',
        build: () => workspace('select', (q) => {
            q.columns = [createColumn('Name'), createColumn('Salary')];
            q.from = createTableSource('Employees');
            q.where = createGroup('AND', [cond('Salary', '>', '50000')]);
            q.orderBy = [{ expr: 'Salary', direction: 'DESC' }];
            q.limit = '10';
        })
    },
    {
        id: 'join-aggregate',
        name: 'Join with totals per customer',
        description: 'LEFT JOIN, COUNT/SUM, GROUP BY and HAVING.',
        build: () => workspace('select', (q) => {
            q.columns = [
                createColumn('c.name', { alias: 'customer' }),
                createColumn('o.id', { aggregate: 'COUNT', alias: 'orders' }),
                createColumn('o.total', { aggregate: 'SUM', alias: 'revenue' })
            ];
            q.from = createTableSource('customers', 'c');
            const join = createJoin('LEFT JOIN');
            join.source = createTableSource('orders', 'o');
            join.on = createGroup('AND', [colCond('o.customer_id', 'c.id')]);
            q.joins = [join];
            q.groupBy = [createGroupByItem('c.name')];
            q.having = createGroup('AND', [cond('COUNT(o.id)', '>=', '5')]);
            q.orderBy = [{ expr: 'revenue', direction: 'DESC' }];
        })
    },
    {
        id: 'not-exists',
        name: 'Customers without orders',
        description: 'NOT EXISTS with a correlated subquery.',
        build: () => workspace('select', (q) => {
            q.columns = [createColumn('c.id'), createColumn('c.name')];
            q.from = createTableSource('customers', 'c');
            const sub = createSelect({
                columns: [createColumn('1')],
                from: createTableSource('orders', 'o'),
                where: createGroup('AND', [colCond('o.customer_id', 'c.id')])
            });
            q.where = createGroup('AND', [cond('', 'NOT EXISTS', '', { valueType: 'subquery', subquery: sub })]);
        })
    },
    {
        id: 'nested-conditions',
        name: 'Nested AND / OR conditions',
        description: 'IN list, BETWEEN and an OR group.',
        build: () => workspace('select', (q) => {
            q.columns = [createColumn('*')];
            q.from = createTableSource('products');
            q.where = createGroup('AND', [
                cond('category', 'IN', 'Books, Music'),
                cond('price', 'BETWEEN', '10', { value2: '50' }),
                createGroup('OR', [cond('stock', '>', '0'), cond('backorder', '=', 'true')])
            ]);
        })
    },
    {
        id: 'cte',
        name: 'CTE: departments above average',
        description: 'WITH clause reused by the main query.',
        build: () => workspace('select', (q) => {
            const cte = createCte();
            cte.name = 'dept_pay';
            cte.query = createSelect({
                columns: [createColumn('department'), createColumn('salary', { aggregate: 'AVG', alias: 'avg_salary' })],
                from: createTableSource('employees'),
                groupBy: [createGroupByItem('department')]
            });
            q.ctes = [cte];
            q.columns = [createColumn('department'), createColumn('avg_salary')];
            q.from = createTableSource('dept_pay');
            q.where = createGroup('AND', [cond('avg_salary', '>', '60000')]);
            q.orderBy = [{ expr: 'avg_salary', direction: 'DESC' }];
        })
    },
    {
        id: 'case',
        name: 'CASE: salary bands',
        description: 'Computed column with CASE WHEN.',
        build: () => workspace('select', (q) => {
            const band = createCaseColumn();
            band.cases = [{ when: 'salary >= 100000', then: "'High'" }, { when: 'salary >= 50000', then: "'Medium'" }];
            band.elseValue = "'Low'";
            band.alias = 'band';
            q.columns = [createColumn('name'), createColumn('salary'), band];
            q.from = createTableSource('employees');
        })
    },
    {
        id: 'union',
        name: 'UNION of contacts',
        description: 'Combine two tables, then sort the result.',
        build: () => workspace('select', (q) => {
            q.columns = [createColumn('name'), createColumn('email')];
            q.from = createTableSource('customers');
            const union = createSetOp('UNION');
            union.query = createSelect({ columns: [createColumn('name'), createColumn('email')], from: createTableSource('suppliers') });
            q.setOps = [union];
            q.orderBy = [{ expr: 'name', direction: 'ASC' }];
        })
    },
    {
        id: 'insert-rows',
        name: 'Insert several rows',
        description: 'Multi-row INSERT.',
        build: () => workspace('insert', (q) => {
            q.table = 'employees';
            q.columns = 'name, department, salary';
            q.rows = [{ values: "'Ada', 'Engineering', 95000" }, { values: "'Grace', 'Research', 105000" }];
        })
    },
    {
        id: 'update-safe',
        name: 'Update with a WHERE',
        description: 'Change one row safely.',
        build: () => workspace('update', (q) => {
            q.table = 'employees';
            q.set = [
                { column: 'salary', valueType: 'value', value: '99000' },
                { column: 'updated_at', valueType: 'column', value: 'CURRENT_TIMESTAMP' }
            ];
            q.where = createGroup('AND', [cond('id', '=', '42')]);
        })
    },
    {
        id: 'delete-old',
        name: 'Delete old log rows',
        description: 'DELETE with a date condition.',
        build: () => workspace('delete', (q) => {
            q.table = 'audit_log';
            q.where = createGroup('AND', [cond('created_at', '<', "'2025-01-01'")]);
        })
    }
];
