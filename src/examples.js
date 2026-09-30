// Built-in starter examples shown in the Examples panel. They are ordinary
// workspaces built with the model factories, so the SQL they show always comes
// from the generator of the selected dialect and can't drift from it.
//
// An example without `dialects` works in every dialect; one with `dialects`
// is listed only for those (loading it elsewhere switches to the first).
//
// Each example has a level and a topic, used by the Examples panel filter.

import {
    createWorkspace, createColumn, createCaseColumn, createWindowColumn, createCondition, createGroup, createJoin,
    createTableSource, createSubquerySource, createCte, createSetOp, createSelect, createGroupByItem
} from './model.js';

const cond = (left, op, value = '', extra = {}) => createCondition({ left, op, value, ...extra });
const colCond = (left, right) => cond(left, '=', right, { valueType: 'column' });

function workspace(type, fill) {
    const ws = createWorkspace(type);
    fill(ws[type]);
    return ws;
}

export const EXAMPLE_LEVELS = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };
export const EXAMPLE_TOPICS = [
    'Filtering and sorting', 'Joins', 'Aggregation', 'Calculated columns',
    'Subqueries and CTEs', 'Window functions', 'Combining results', 'Changing data'
];

export const EXAMPLES = [
    {
        id: 'filter-sort',
        level: 'beginner',
        topic: 'Filtering and sorting',
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
        level: 'beginner',
        topic: 'Filtering and sorting',
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
        level: 'intermediate',
        topic: 'Aggregation',
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
        id: 'duplicates',
        level: 'intermediate',
        topic: 'Aggregation',
        name: 'Find duplicate values',
        description: 'Emails that appear more than once: GROUP BY with HAVING COUNT(*) > 1.',
        build: () => workspace('select', (q) => {
            q.columns = [createColumn('email'), createColumn('*', { aggregate: 'COUNT', alias: 'copies' })];
            q.from = createTableSource('customers');
            q.groupBy = [createGroupByItem('email')];
            q.having = createGroup('AND', [cond('COUNT(*)', '>', '1')]);
            q.orderBy = [{ expr: 'copies', direction: 'DESC' }];
        })
    },
    {
        id: 'conditional-aggregation',
        level: 'intermediate',
        topic: 'Aggregation',
        name: 'Conditional totals',
        description: 'SUM and COUNT over CASE: several totals per customer from one query.',
        build: () => workspace('select', (q) => {
            q.columns = [
                createColumn('customer_id'),
                createColumn("CASE WHEN status = 'paid' THEN total ELSE 0 END", { aggregate: 'SUM', alias: 'paid_total' }),
                createColumn("CASE WHEN status = 'refunded' THEN 1 END", { aggregate: 'COUNT', alias: 'refunds' })
            ];
            q.from = createTableSource('orders');
            q.groupBy = [createGroupByItem('customer_id')];
        })
    },
    {
        id: 'self-join',
        level: 'intermediate',
        topic: 'Joins',
        name: 'Employees and their managers',
        description: 'Join a table to itself using two aliases.',
        build: () => workspace('select', (q) => {
            q.columns = [createColumn('e.name', { alias: 'employee' }), createColumn('m.name', { alias: 'manager' })];
            q.from = createTableSource('employees', 'e');
            const join = createJoin('LEFT JOIN');
            join.source = createTableSource('employees', 'm');
            join.on = createGroup('AND', [colCond('e.manager_id', 'm.id')]);
            q.joins = [join];
            q.orderBy = [{ expr: 'manager', direction: 'ASC' }, { expr: 'employee', direction: 'ASC' }];
        })
    },
    {
        id: 'not-exists',
        level: 'intermediate',
        topic: 'Subqueries and CTEs',
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
        id: 'anti-join',
        level: 'intermediate',
        topic: 'Joins',
        name: 'Products never ordered',
        description: 'LEFT JOIN, then keep the rows that found no match (IS NULL).',
        build: () => workspace('select', (q) => {
            q.columns = [createColumn('p.id'), createColumn('p.name')];
            q.from = createTableSource('products', 'p');
            const join = createJoin('LEFT JOIN');
            join.source = createTableSource('order_items', 'oi');
            join.on = createGroup('AND', [colCond('oi.product_id', 'p.id')]);
            q.joins = [join];
            q.where = createGroup('AND', [cond('oi.product_id', 'IS NULL')]);
        })
    },
    {
        id: 'nested-conditions',
        level: 'beginner',
        topic: 'Filtering and sorting',
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
        id: 'date-range',
        level: 'beginner',
        topic: 'Filtering and sorting',
        name: 'Rows in a date range',
        description: 'January 2026: >= the first day and < the next month, so the whole last day is included.',
        build: () => workspace('select', (q) => {
            q.columns = ['id', 'customer_id', 'total', 'created_at'].map(c => createColumn(c));
            q.from = createTableSource('orders');
            q.where = createGroup('AND', [cond('created_at', '>=', '2026-01-01'), cond('created_at', '<', '2026-02-01')]);
            q.orderBy = [{ expr: 'created_at', direction: 'ASC' }];
        })
    },
    {
        id: 'cte',
        level: 'intermediate',
        topic: 'Subqueries and CTEs',
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
        level: 'beginner',
        topic: 'Calculated columns',
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
        level: 'beginner',
        topic: 'Combining results',
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
        level: 'advanced',
        topic: 'Window functions',
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
        id: 'top-n-per-group',
        level: 'advanced',
        topic: 'Window functions',
        name: 'Top 3 per department',
        description: 'ROW_NUMBER in a CTE, then keep the rows numbered 1 to 3.',
        build: () => workspace('select', (q) => {
            const cte = createCte();
            cte.name = 'ranked';
            const rowNumber = {
                ...createWindowColumn(), func: 'ROW_NUMBER', alias: 'rn',
                partitionBy: [{ expr: 'department' }], orderBy: [{ expr: 'salary', direction: 'DESC' }]
            };
            cte.query = createSelect({
                columns: [createColumn('name'), createColumn('department'), createColumn('salary'), rowNumber],
                from: createTableSource('employees')
            });
            q.ctes = [cte];
            q.columns = [createColumn('name'), createColumn('department'), createColumn('salary')];
            q.from = createTableSource('ranked');
            q.where = createGroup('AND', [cond('rn', '<=', '3')]);
            q.orderBy = [{ expr: 'department', direction: 'ASC' }, { expr: 'salary', direction: 'DESC' }];
        })
    },
    {
        id: 'latest-per-group',
        level: 'intermediate',
        topic: 'Window functions',
        name: 'Latest row per group',
        description: 'Each customer\'s most recent order: ROW_NUMBER newest first in a CTE, then keep row 1. The id breaks ties between orders placed at the same time.',
        build: () => workspace('select', (q) => {
            const cte = createCte();
            cte.name = 'numbered';
            const rowNumber = {
                ...createWindowColumn(), func: 'ROW_NUMBER', alias: 'rn',
                partitionBy: [{ expr: 'customer_id' }],
                orderBy: [{ expr: 'ordered_at', direction: 'DESC' }, { expr: 'id', direction: 'DESC' }]
            };
            cte.query = createSelect({
                columns: [createColumn('id'), createColumn('customer_id'), createColumn('ordered_at'), createColumn('total'), rowNumber],
                from: createTableSource('orders')
            });
            q.ctes = [cte];
            q.columns = ['id', 'customer_id', 'ordered_at', 'total'].map(c => createColumn(c));
            q.from = createTableSource('numbered');
            q.where = createGroup('AND', [cond('rn', '=', '1')]);
        })
    },
    {
        id: 'moving-average',
        level: 'advanced',
        topic: 'Window functions',
        name: '7-day moving average',
        description: 'Daily totals in a CTE, then AVG over the current row and the 6 before it. That is 7 days only when every day has a row.',
        build: () => workspace('select', (q) => {
            const cte = createCte();
            cte.name = 'daily';
            cte.query = createSelect({
                columns: [createColumn('sale_date'), createColumn('amount', { aggregate: 'SUM', alias: 'total' })],
                from: createTableSource('sales'),
                groupBy: [createGroupByItem('sale_date')]
            });
            const moving = {
                ...createWindowColumn(), func: 'AVG', args: 'total', alias: 'avg_7_days',
                orderBy: [{ expr: 'sale_date', direction: 'ASC' }], frame: 'moving', frameSize: '6'
            };
            q.ctes = [cte];
            q.columns = [createColumn('sale_date'), createColumn('total'), moving];
            q.from = createTableSource('daily');
            q.orderBy = [{ expr: 'sale_date', direction: 'ASC' }];
        })
    },
    {
        id: 'gaps-and-islands',
        level: 'advanced',
        topic: 'Window functions',
        name: 'Runs of consecutive numbers (gaps and islands)',
        description: 'Number minus ROW_NUMBER is the same for every number in an unbroken run, so grouping by it gives each run. Gaps are what lies between runs. Assumes each number appears once.',
        build: () => workspace('select', (q) => {
            const cte = createCte();
            cte.name = 'numbered';
            const rowNumber = {
                ...createWindowColumn(), func: 'ROW_NUMBER', alias: 'rn',
                orderBy: [{ expr: 'invoice_no', direction: 'ASC' }]
            };
            cte.query = createSelect({
                columns: [createColumn('invoice_no'), rowNumber],
                from: createTableSource('invoices')
            });
            q.ctes = [cte];
            q.columns = [
                createColumn('invoice_no', { aggregate: 'MIN', alias: 'run_start' }),
                createColumn('invoice_no', { aggregate: 'MAX', alias: 'run_end' }),
                createColumn('*', { aggregate: 'COUNT', alias: 'invoices' })
            ];
            q.from = createTableSource('numbered');
            q.groupBy = [createGroupByItem('invoice_no - rn')];
            q.orderBy = [{ expr: 'run_start', direction: 'ASC' }];
        })
    },
    {
        id: 'intersect',
        level: 'intermediate',
        topic: 'Combining results',
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
        level: 'beginner',
        topic: 'Changing data',
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
        level: 'intermediate',
        topic: 'Changing data',
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
        level: 'advanced',
        topic: 'Changing data',
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
        level: 'intermediate',
        topic: 'Filtering and sorting',
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
        level: 'beginner',
        topic: 'Changing data',
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
        id: 'delete-duplicates',
        level: 'advanced',
        topic: 'Changing data',
        name: 'Delete duplicates, keep one',
        description: 'Keeps the lowest id for each email and deletes the other copies; rows with no email are left alone. The inner query sits in a derived table because MySQL can\'t read the table it deletes from directly. Run the SELECT part first to check what is kept.',
        build: () => workspace('delete', (q) => {
            q.table = 'contacts';
            const keepers = createSubquerySource();
            keepers.alias = 'keepers';
            keepers.query = createSelect({
                columns: [createColumn('id', { aggregate: 'MIN', alias: 'keep_id' })],
                from: createTableSource('contacts'),
                where: createGroup('AND', [cond('email', 'IS NOT NULL')]),
                groupBy: [createGroupByItem('email')]
            });
            q.where = createGroup('AND', [
                cond('email', 'IS NOT NULL'),
                cond('id', 'NOT IN', '', {
                    valueType: 'subquery',
                    subquery: createSelect({ columns: [createColumn('keep_id')], from: keepers })
                })
            ]);
        })
    },
    {
        id: 'delete-old',
        level: 'beginner',
        topic: 'Changing data',
        name: 'Delete old log rows',
        description: 'DELETE with a date condition.',
        build: () => workspace('delete', (q) => {
            q.table = 'audit_log';
            q.where = createGroup('AND', [cond('created_at', '<', "'2025-01-01'")]);
        })
    }
];

/**
 * The examples that work in a dialect ('all' lists every example), optionally
 * only those on one topic.
 * @param {string} dialect
 * @param {string} [topic] a topic from EXAMPLE_TOPICS, or 'all'
 */
export function examplesFor(dialect, topic = 'all') {
    return EXAMPLES.filter(e => (dialect === 'all' || !e.dialects || e.dialects.includes(dialect))
        && (topic === 'all' || e.topic === topic));
}

// The short query the Settings dialog writes to preview the SQL format
// options. Not listed with the examples.
export function formatSample() {
    return workspace('select', (q) => {
        q.columns = [
            createColumn('department'),
            createColumn('region'),
            createColumn('*', { aggregate: 'COUNT', alias: 'staff' })
        ];
        q.from = createTableSource('employees');
        q.where = createGroup('AND', [
            cond('status', '=', 'active'),
            createGroup('OR', [cond('salary', '>', '50000'), cond('role', '=', 'lead')])
        ]);
        q.groupBy = [createGroupByItem('department'), createGroupByItem('region')];
        q.orderBy = [{ expr: 'staff', direction: 'DESC' }, { expr: 'department', direction: 'ASC' }];
    });
}
