// Built-in starter examples shown in the Examples panel. They are ordinary
// workspaces built with the model factories, so the SQL they show always comes
// from the generator of the selected dialect and can't drift from it.
//
// An example without `dialects` works in every dialect; one with `dialects`
// is listed only for those (loading it elsewhere switches to the first).

import {
    createWorkspace, createColumn, createCaseColumn, createWindowColumn, createCondition, createGroup, createJoin,
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
        id: 'page-results',
        name: 'Page through results',
        description: 'Rows 41–60 in a stable order: LIMIT and OFFSET, or OFFSET … FETCH on SQL Server.',
        build: () => workspace('select', (q) => {
            q.columns = [createColumn('id'), createColumn('name'), createColumn('email')];
            q.from = createTableSource('customers');
            q.orderBy = [{ expr: 'name', direction: 'ASC' }, { expr: 'id', direction: 'ASC' }];
            q.limit = '20';
            q.offset = '40';
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
        id: 'window',
        name: 'Window functions: rank and running total',
        description: 'RANK per department and a running SUM ordered by date.',
        build: () => workspace('select', (q) => {
            const rank = {
                ...createWindowColumn(), func: 'RANK', alias: 'dept_rank',
                partitionBy: [{ expr: 'department' }], orderBy: [{ expr: 'salary', direction: 'DESC' }]
            };
            const running = {
                ...createWindowColumn(), func: 'SUM', args: 'salary', alias: 'running_payroll',
                orderBy: [{ expr: 'hired_on', direction: 'ASC' }], frame: 'running'
            };
            q.columns = [createColumn('name'), createColumn('department'), createColumn('salary'), rank, running];
            q.from = createTableSource('employees');
        })
    },
    {
        id: 'intersect',
        name: 'INTERSECT: customers who are also suppliers',
        description: 'Rows present in both queries.',
        build: () => workspace('select', (q) => {
            q.columns = [createColumn('email')];
            q.from = createTableSource('customers');
            const both = createSetOp('INTERSECT');
            both.query = createSelect({ columns: [createColumn('email')], from: createTableSource('suppliers') });
            q.setOps = [both];
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
        id: 'insert-select',
        name: 'Copy rows with INSERT … SELECT',
        description: 'Archive last year\'s orders into another table.',
        build: () => workspace('insert', (q) => {
            q.table = 'orders_archive';
            q.columns = 'id, customer_id, total, created_at';
            q.source = 'select';
            q.select = createSelect({
                columns: ['id', 'customer_id', 'total', 'created_at'].map(c => createColumn(c)),
                from: createTableSource('orders'),
                where: createGroup('AND', [cond('created_at', '<', '2026-01-01')])
            });
        })
    },
    {
        id: 'upsert',
        name: 'Upsert: insert or update',
        description: 'PostgreSQL ON CONFLICT / MySQL ON DUPLICATE KEY UPDATE.',
        dialects: ['postgresql', 'mysql'],
        build: () => workspace('insert', (q) => {
            q.table = 'customers';
            q.columns = 'email, name, updated_at';
            q.rows = [{ values: "'ada@example.com', 'Ada Lovelace', CURRENT_TIMESTAMP" }];
            q.upsert = {
                mode: 'update',
                conflict: 'email',
                set: [
                    { column: 'name', valueType: 'inserted', value: '' },
                    { column: 'updated_at', valueType: 'inserted', value: '' }
                ]
            };
        })
    },
    {
        id: 'parameters',
        name: 'Parameters for application code',
        description: 'Placeholders written in each dialect\'s style ($1, ?, @name).',
        build: () => workspace('select', (q) => {
            q.columns = ['id', 'email'].map(c => createColumn(c));
            q.from = createTableSource('users');
            q.where = createGroup('AND', [
                cond('status', '=', 'status', { valueType: 'param' }),
                cond('created_at', 'BETWEEN', 'from_date', { valueType: 'param', value2: 'to_date' })
            ]);
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

/** The examples that work in a dialect ('all' lists every example). */
export function examplesFor(dialect) {
    return dialect === 'all' ? EXAMPLES : EXAMPLES.filter(e => !e.dialects || e.dialects.includes(dialect));
}
