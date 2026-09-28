// Dialect matrix: the same query model generated and validated for every
// dialect. Expected SQL is written out in full (golden SQL) so any change in
// dialect behavior shows up as a diff here.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { validateQuery, validateWorkspace, hasErrors } from '../src/validation.js';
import { DIALECTS, getDialect, listDialects } from '../src/dialects.js';
import { examplesFor } from '../src/examples.js';
import { generateQuery, generateSQL } from '../src/generator.js';
import {
    createSelect, createColumn, createCaseColumn, createWindowColumn, createCondition, createRawCondition, createGroup,
    createJoin, createTableSource, createSubquerySource, createCte, createSetOp, createOrderItem, createGroupByItem,
    createInsert, createUpdate, createDelete
} from '../src/model.js';

const ALL = ['generic', 'sqlserver', 'postgresql', 'mysql'];

function select({ table = 'employees', alias = '', columns = ['name', 'salary'], ...rest } = {}) {
    return createSelect({
        columns: columns.map(c => (typeof c === 'string' ? createColumn(c) : c)),
        from: createTableSource(table, alias),
        ...rest
    });
}
const where = (...items) => createGroup('AND', items);
const cond = (left, op, value = '', extra = {}) => createCondition({ left, op, value, ...extra });
const desc = (expr) => ({ ...createOrderItem(expr), direction: 'DESC' });
const union = (op, query = select()) => ({ ...createSetOp(op), query });

const compact = (q, dialect, extra = {}) => generateQuery(q, { dialect, pretty: false, ...extra });
const pretty = (q, dialect, extra = {}) => generateQuery(q, { dialect, pretty: true, ...extra });

/** Dialect issues (category "dialect") as "level: message start" for readable diffs. */
function dialectIssues(q, dialect, extra = {}) {
    return validateQuery(q, { dialect, ...extra }).filter(i => i.category === 'dialect').map(i => i.level);
}

/**
 * Expects `sql` for every dialect, or a per-dialect object. Dialects not
 * listed in an object must produce the `default` entry.
 */
function expectSql(q, expected, extra = {}) {
    for (const dialect of ALL) {
        const want = typeof expected === 'string' ? expected : (expected[dialect] ?? expected.default);
        expect(compact(q, dialect, extra), dialect).toBe(want);
    }
}

describe('dialect definitions', () => {
    test('the four dialects are listed with user-facing labels', () => {
        expect(listDialects().map(d => d.label)).toEqual(['Generic SQL', 'Microsoft SQL Server', 'PostgreSQL', 'MySQL']);
        expect(getDialect('nope').id).toBe('generic');
        expect(getDialect('constructor').id).toBe('generic');
    });

    test.each(ALL)('%s declares every capability explicitly', (id) => {
        const d = DIALECTS[id];
        for (const fn of ['quoteIdentifier', 'quoteString', 'booleanLiteral', 'paginate', 'parameter']) {
            expect(typeof d[fn], fn).toBe('function');
        }
        expect(Object.keys(d.supports).sort()).toEqual([
            'booleanKeywords', 'cte', 'fullJoin', 'havingAlias', 'limitInInSubquery', 'limitOffset', 'nthValue', 'offsetFetch',
            'output', 'recursiveCte', 'returning', 'setOperators', 'top', 'upsert', 'windowFunctions'
        ]);
        expect(Object.keys(d.restrictions).sort()).toEqual([
            'frameNeedsOrderBy', 'rankingNeedsOrderBy', 'subqueryOrderByNeedsLimit', 'valueFunctionsNeedOrderBy'
        ]);
        expect(['kept', 'numbered', 'ignored']).toContain(d.parameters.names);
        expect(Object.isFrozen(d) && Object.isFrozen(d.supports)).toBe(true);
    });

    test('features that are not built yet are off everywhere', () => {
        for (const id of ALL) {
            expect(DIALECTS[id].supports).toMatchObject({ recursiveCte: false, returning: false, output: false });
        }
    });

    test('pagination capability flags match what paginate() writes', () => {
        for (const id of ALL) {
            const d = DIALECTS[id];
            const simple = d.paginate({ limit: '5', offset: '', hasOrderBy: true, hasSetOps: false });
            const paged = d.paginate({ limit: '5', offset: '10', hasOrderBy: true, hasSetOps: false });
            expect(Boolean(simple.top), id).toBe(d.supports.top);
            expect(paged.clauses.join(' ').includes('LIMIT'), id).toBe(d.supports.limitOffset);
            expect(paged.clauses.join(' ').includes('FETCH NEXT'), id).toBe(d.supports.offsetFetch);
        }
    });

    test('generator and validation never branch on a dialect id', () => {
        for (const file of ['generator.js', 'validation.js', 'ui/builder.js', 'app.js']) {
            const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
            expect(source, file).not.toMatch(/dialect\.id\s*[!=]==/);
            expect(source, file).not.toMatch(/===?\s*'(sqlserver|mysql|postgresql)'/);
        }
    });
});

describe('golden SQL: SELECT features', () => {
    test('DISTINCT, aliases, aggregates, GROUP BY, HAVING, ORDER BY', () => {
        const q = select({
            columns: [createColumn('dept', { alias: 'department' }), createColumn('', { aggregate: 'COUNT', alias: 'staff' }), createColumn('salary', { aggregate: 'AVG' })],
            distinct: true,
            groupBy: [createGroupByItem('dept')],
            having: where(cond('COUNT(*)', '>', '5')),
            orderBy: [desc('COUNT(*)')]
        });
        expectSql(q, 'SELECT DISTINCT dept AS department, COUNT(*) AS staff, AVG(salary) FROM employees GROUP BY dept HAVING COUNT(*) > 5 ORDER BY COUNT(*) DESC;');
        for (const d of ALL) expect(validateQuery(q, { dialect: d }), d).toEqual([]);
    });

    test('CASE column', () => {
        const caseCol = { ...createCaseColumn(), cases: [{ when: 'salary > 100000', then: "'high'" }], elseValue: "'normal'", alias: 'band' };
        expectSql(select({ columns: ['name', caseCol] }),
            "SELECT name, CASE WHEN salary > 100000 THEN 'high' ELSE 'normal' END AS band FROM employees;");
    });

    test('multiple joins: INNER, LEFT, CROSS', () => {
        const inner = { ...createJoin('INNER JOIN'), source: createTableSource('departments', 'd'), on: where(cond('e.dept_id', '=', 'd.id', { valueType: 'column' })) };
        const left = { ...createJoin('LEFT JOIN'), source: createTableSource('managers', 'm'), on: where(cond('m.id', '=', 'e.manager_id', { valueType: 'column' })) };
        const cross = { ...createJoin('CROSS JOIN'), source: createTableSource('calendar') };
        expectSql(select({ alias: 'e', columns: ['e.name', 'd.name'], joins: [inner, left, cross] }),
            'SELECT e.name, d.name FROM employees AS e INNER JOIN departments AS d ON e.dept_id = d.id LEFT JOIN managers AS m ON m.id = e.manager_id CROSS JOIN calendar;');
    });

    test('FULL JOIN is generated where supported and blocked on MySQL', () => {
        const full = { ...createJoin('FULL JOIN'), source: createTableSource('b'), on: where(cond('a.id', '=', 'b.id', { valueType: 'column' })) };
        const q = select({ table: 'a', columns: ['*'], joins: [full] });
        expectSql(q, 'SELECT * FROM a FULL JOIN b ON a.id = b.id;');
        expect(dialectIssues(q, 'generic')).toEqual([]);
        expect(dialectIssues(q, 'sqlserver')).toEqual([]);
        expect(dialectIssues(q, 'postgresql')).toEqual([]);
        expect(dialectIssues(q, 'mysql')).toEqual(['error']);
        expect(hasErrors(validateQuery(q, { dialect: 'mysql' }))).toBe(true);
    });

    test('WHERE: AND, OR, NOT, IN, NOT IN, BETWEEN, IS NULL, LIKE, EXISTS', () => {
        const orGroup = { ...createGroup('OR', [cond('dept', 'IN', 'Sales, HR'), cond('dept', 'NOT IN', 'Temp')]), negate: true };
        const exists = cond('', 'EXISTS', '', { valueType: 'subquery', subquery: select({ table: 'reviews', columns: ['1'], where: where(cond('reviews.emp_id', '=', 'employees.id', { valueType: 'column' })) }) });
        const q = select({
            where: where(
                cond('salary', 'BETWEEN', '1000', { value2: '5000' }),
                orGroup,
                cond('manager_id', 'IS NULL'),
                cond('name', 'LIKE', 'A%'),
                exists
            )
        });
        expectSql(q, "SELECT name, salary FROM employees WHERE salary BETWEEN 1000 AND 5000 AND NOT (dept IN ('Sales', 'HR') OR dept NOT IN ('Temp')) AND manager_id IS NULL AND name LIKE 'A%' AND EXISTS (SELECT 1 FROM reviews WHERE reviews.emp_id = employees.id);");
    });

    test('literals: text, numbers, NULL and booleans', () => {
        const q = select({
            columns: ['*'],
            where: where(cond('name', '=', "O'Brien"), cond('price', 'IN', '100, 12.50, null'), cond('active', '=', 'true'), cond('deleted', '=', 'FALSE'))
        });
        expectSql(q, {
            default: "SELECT * FROM employees WHERE name = 'O''Brien' AND price IN (100, 12.50, NULL) AND active = TRUE AND deleted = FALSE;",
            sqlserver: "SELECT * FROM employees WHERE name = 'O''Brien' AND price IN (100, 12.50, NULL) AND active = 1 AND deleted = 0;"
        });
    });

    test('backslashes are escaped only for MySQL', () => {
        const q = select({ columns: ['*'], where: where(cond('path', '=', 'C:\\temp')) });
        expectSql(q, {
            default: "SELECT * FROM employees WHERE path = 'C:\\temp';",
            mysql: "SELECT * FROM employees WHERE path = 'C:\\\\temp';"
        });
    });

    test('identifier quoting: parts of schema.table.column, never * or expressions', () => {
        const q = select({
            table: 'hr.employees',
            alias: 'e',
            columns: ['e.*', 'hr.employees.name', createColumn('salary * 12', { alias: 'yearly' }), createColumn('', { aggregate: 'COUNT' })],
            groupBy: [createGroupByItem('e.id'), createGroupByItem('hr.employees.name'), createGroupByItem('salary * 12')]
        });
        expectSql(q, {
            default: 'SELECT "e".*, "hr"."employees"."name", salary * 12 AS "yearly", COUNT(*) FROM "hr"."employees" AS "e" GROUP BY "e"."id", "hr"."employees"."name", salary * 12;',
            sqlserver: 'SELECT [e].*, [hr].[employees].[name], salary * 12 AS [yearly], COUNT(*) FROM [hr].[employees] AS [e] GROUP BY [e].[id], [hr].[employees].[name], salary * 12;',
            mysql: 'SELECT `e`.*, `hr`.`employees`.`name`, salary * 12 AS `yearly`, COUNT(*) FROM `hr`.`employees` AS `e` GROUP BY `e`.`id`, `hr`.`employees`.`name`, salary * 12;'
        }, { quoteIdentifiers: true });
        expectSql(select({ columns: ['*'] }), {
            default: 'SELECT * FROM "employees";',
            sqlserver: 'SELECT * FROM [employees];',
            mysql: 'SELECT * FROM `employees`;'
        }, { quoteIdentifiers: true });
    });

    test('CTEs, several and referenced', () => {
        const high = { ...createCte(), name: 'high_paid', query: select({ where: where(cond('salary', '>', '100000')) }) };
        const counted = { ...createCte(), name: 'counted', query: select({ table: 'high_paid', columns: [createColumn('', { aggregate: 'COUNT', alias: 'n' })] }) };
        expectSql(select({ table: 'counted', columns: ['n'], ctes: [high, counted] }),
            'WITH high_paid AS (SELECT name, salary FROM employees WHERE salary > 100000), counted AS (SELECT COUNT(*) AS n FROM high_paid) SELECT n FROM counted;');
    });

    test('a derived table with a row limit uses each dialect\'s pagination', () => {
        const inner = select({ orderBy: [desc('salary')], limit: '5' });
        const q = createSelect({ columns: [createColumn('*')], from: { ...createSubquerySource(), query: inner, alias: 't' } });
        expectSql(q, {
            default: 'SELECT * FROM (SELECT name, salary FROM employees ORDER BY salary DESC LIMIT 5) AS t;',
            sqlserver: 'SELECT * FROM (SELECT TOP 5 name, salary FROM employees ORDER BY salary DESC) AS t;'
        });
        for (const d of ALL) expect(hasErrors(validateQuery(q, { dialect: d })), d).toBe(false);
    });
});

describe('golden SQL: pagination', () => {
    const cases = [
        ['LIMIT only, ORDER BY', { orderBy: [desc('salary')], limit: '10' }, {
            default: 'SELECT name, salary FROM employees ORDER BY salary DESC LIMIT 10;',
            sqlserver: 'SELECT TOP 10 name, salary FROM employees ORDER BY salary DESC;'
        }],
        ['LIMIT only, no ORDER BY', { limit: '10' }, {
            default: 'SELECT name, salary FROM employees LIMIT 10;',
            sqlserver: 'SELECT TOP 10 name, salary FROM employees;'
        }],
        ['OFFSET only, ORDER BY', { orderBy: [desc('salary')], offset: '20' }, {
            default: 'SELECT name, salary FROM employees ORDER BY salary DESC OFFSET 20;',
            sqlserver: 'SELECT name, salary FROM employees ORDER BY salary DESC OFFSET 20 ROWS;',
            mysql: 'SELECT name, salary FROM employees ORDER BY salary DESC LIMIT 18446744073709551615 OFFSET 20;'
        }],
        ['OFFSET only, no ORDER BY', { offset: '20' }, {
            default: 'SELECT name, salary FROM employees OFFSET 20;',
            sqlserver: 'SELECT name, salary FROM employees ORDER BY (SELECT NULL) OFFSET 20 ROWS;',
            mysql: 'SELECT name, salary FROM employees LIMIT 18446744073709551615 OFFSET 20;'
        }],
        ['LIMIT + OFFSET, ORDER BY', { orderBy: [desc('salary')], limit: '10', offset: '20' }, {
            default: 'SELECT name, salary FROM employees ORDER BY salary DESC LIMIT 10 OFFSET 20;',
            sqlserver: 'SELECT name, salary FROM employees ORDER BY salary DESC OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY;'
        }],
        ['LIMIT + OFFSET, no ORDER BY', { limit: '10', offset: '20' }, {
            default: 'SELECT name, salary FROM employees LIMIT 10 OFFSET 20;',
            sqlserver: 'SELECT name, salary FROM employees ORDER BY (SELECT NULL) OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY;'
        }],
        ['DISTINCT + LIMIT', { distinct: true, orderBy: [desc('salary')], limit: '3' }, {
            default: 'SELECT DISTINCT name, salary FROM employees ORDER BY salary DESC LIMIT 3;',
            sqlserver: 'SELECT DISTINCT TOP 3 name, salary FROM employees ORDER BY salary DESC;'
        }],
        ['UNION + LIMIT', { setOps: [union('UNION')], limit: '5' }, {
            default: 'SELECT name, salary FROM employees UNION SELECT name, salary FROM employees LIMIT 5;',
            sqlserver: 'SELECT name, salary FROM employees UNION SELECT name, salary FROM employees ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY;'
        }],
        ['UNION ALL + ORDER BY + LIMIT + OFFSET', { setOps: [union('UNION ALL')], orderBy: [desc('salary')], limit: '5', offset: '10' }, {
            default: 'SELECT name, salary FROM employees UNION ALL SELECT name, salary FROM employees ORDER BY salary DESC LIMIT 5 OFFSET 10;',
            sqlserver: 'SELECT name, salary FROM employees UNION ALL SELECT name, salary FROM employees ORDER BY salary DESC OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY;'
        }]
    ];

    test.each(cases)('%s', (_name, overrides, expected) => {
        const q = select(overrides);
        expectSql(q, expected);
        // No dialect ever borrows another dialect's pagination keywords
        expect(compact(q, 'sqlserver')).not.toMatch(/\bLIMIT\b/);
        for (const d of ['generic', 'postgresql', 'mysql']) expect(compact(q, d)).not.toMatch(/\bTOP\b|\bFETCH\b|\bROWS\b/);
        for (const d of ALL) expect(hasErrors(validateQuery(q, { dialect: d })), d).toBe(false);
    });

    test('formatted output puts TOP on the SELECT line and OFFSET / FETCH on their own lines', () => {
        expect(pretty(select({ orderBy: [desc('salary')], limit: '10' }), 'sqlserver'))
            .toBe('SELECT TOP 10\n    name,\n    salary\nFROM employees\nORDER BY salary DESC;');
        expect(pretty(select({ orderBy: [desc('salary')], limit: '10', offset: '20' }), 'sqlserver'))
            .toBe('SELECT\n    name,\n    salary\nFROM employees\nORDER BY salary DESC\nOFFSET 20 ROWS\nFETCH NEXT 10 ROWS ONLY;');
        expect(pretty(select({ orderBy: [desc('salary')], limit: '10', offset: '20' }), 'postgresql'))
            .toBe('SELECT\n    name,\n    salary\nFROM employees\nORDER BY salary DESC\nLIMIT 10\nOFFSET 20;');
    });

    test('the missing-ORDER-BY tip names the syntax each dialect writes', () => {
        const tip = (overrides, d) => validateQuery(select(overrides), { dialect: d }).find(i => i.path === 'orderBy').message;
        expect(tip({ limit: '10' }, 'generic')).toBe('Without ORDER BY, which rows LIMIT returns is not guaranteed.');
        expect(tip({ limit: '10' }, 'sqlserver')).toBe('Without ORDER BY, which rows TOP returns is not guaranteed.');
        expect(tip({ offset: '10' }, 'mysql')).toBe('Without ORDER BY, which rows OFFSET skips is not guaranteed.');
        expect(tip({ limit: '1', offset: '10' }, 'postgresql')).toBe('Without ORDER BY, which rows LIMIT/OFFSET return is not guaranteed.');
        expect(tip({ limit: '1', offset: '10' }, 'sqlserver')).toMatch(/^SQL Server needs ORDER BY for OFFSET\/FETCH, so ORDER BY \(SELECT NULL\) was added/);
    });
});

describe('golden SQL: set operations', () => {
    test.each(['UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT'])('%s is written the same everywhere', (op) => {
        const q = select({ setOps: [union(op, select({ table: 'contractors' }))] });
        expectSql(q, `SELECT name, salary FROM employees ${op} SELECT name, salary FROM contractors;`);
        for (const d of ALL) expect(hasErrors(validateQuery(q, { dialect: d })), d).toBe(false);
    });

    test.each(['INTERSECT ALL', 'EXCEPT ALL'])('%s: blocked with an explanation on SQL Server, never downgraded', (op) => {
        const q = select({ setOps: [union(op, select({ table: 'contractors' }))] });
        expect(compact(q, 'sqlserver')).toContain(op);
        const issues = validateQuery(q, { dialect: 'sqlserver' });
        expect(issues.find(i => i.level === 'error')).toMatchObject({ category: 'dialect', message: `SQL Server doesn't support ${op}.`, path: 'setOps.0.op' });
        expect(dialectIssues(q, 'generic')).toEqual([]);
        expect(dialectIssues(q, 'postgresql')).toEqual([]);
        expect(dialectIssues(q, 'mysql')).toEqual(['info']); // needs 8.0.31
    });
});

describe('golden SQL: window functions', () => {
    const win = (overrides) => ({ ...createWindowColumn(), alias: 'w', ...overrides });
    const byDept = [{ expr: 'dept' }];
    const bySalary = [desc('salary')];

    test('ranking, offset and running aggregates are written the same everywhere', () => {
        const q = select({
            columns: ['name',
                win({ func: 'ROW_NUMBER', partitionBy: byDept, orderBy: bySalary, alias: 'rn' }),
                win({ func: 'LAG', args: 'salary, 1, 0', orderBy: bySalary, alias: 'prev' }),
                win({ func: 'SUM', args: 'salary', orderBy: [createOrderItem('hired_on')], frame: 'running', alias: 'running_total' })]
        });
        expectSql(q, 'SELECT name, ROW_NUMBER() OVER (PARTITION BY dept ORDER BY salary DESC) AS rn, LAG(salary, 1, 0) OVER (ORDER BY salary DESC) AS prev, SUM(salary) OVER (ORDER BY hired_on ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_total FROM employees;');
        for (const d of ALL) expect(validateQuery(q, { dialect: d }), d).toEqual([]);
    });

    const matrix = [
        // [function setup, generic, sqlserver, postgresql, mysql] — level of the first ordering/dialect issue
        ['ROW_NUMBER without ORDER BY', { func: 'ROW_NUMBER' }, 'warning', 'error', 'warning', 'warning'],
        ['NTILE without ORDER BY', { func: 'NTILE', args: '4' }, 'warning', 'error', 'warning', 'warning'],
        ['FIRST_VALUE without ORDER BY', { func: 'FIRST_VALUE', args: 'salary' }, null, 'error', null, null],
        ['LAST_VALUE without ORDER BY', { func: 'LAST_VALUE', args: 'salary' }, null, 'error', null, null],
        ['NTH_VALUE', { func: 'NTH_VALUE', args: 'salary, 2', orderBy: [createOrderItem('salary')], frame: 'whole' }, null, 'error', null, null],
        ['frame without ORDER BY', { func: 'SUM', args: 'salary', frame: 'running' }, 'warning', 'error', 'warning', 'warning']
    ];

    test.each(matrix)('%s', (_name, setup, ...levels) => {
        const q = select({ columns: ['name', win(setup)] });
        ALL.forEach((d, i) => {
            const issue = validateQuery(q, { dialect: d }).find(x => x.path.startsWith('columns.1') && x.level !== 'info');
            expect(issue?.level ?? null, d).toBe(levels[i]);
            if (issue?.level === 'error') expect(issue.category, d).toBe('dialect');
        });
    });

    test('SQL Server explains which window functions need ORDER BY', () => {
        const q = select({ columns: ['name', win({ func: 'FIRST_VALUE', args: 'salary' })] });
        expect(validateQuery(q, { dialect: 'sqlserver' }).find(i => i.level === 'error')).toMatchObject({
            path: 'columns.1.orderBy',
            message: 'SQL Server requires ORDER BY inside OVER (…) for FIRST_VALUE. Add the column that decides which row is first or last.'
        });
    });
});

describe('golden SQL: INSERT, UPDATE, DELETE', () => {
    test('single and multi-row INSERT', () => {
        const q = { ...createInsert(), table: 'employees', columns: 'name, salary', rows: [{ values: "'Ada', 5000" }, { values: "'Linus', 4000" }] };
        expectSql(q, "INSERT INTO employees (name, salary) VALUES ('Ada', 5000), ('Linus', 4000);");
        expectSql(q, {
            default: `INSERT INTO "employees" ("name", "salary") VALUES ('Ada', 5000), ('Linus', 4000);`,
            sqlserver: "INSERT INTO [employees] ([name], [salary]) VALUES ('Ada', 5000), ('Linus', 4000);",
            mysql: "INSERT INTO `employees` (`name`, `salary`) VALUES ('Ada', 5000), ('Linus', 4000);"
        }, { quoteIdentifiers: true });
    });

    test('UPDATE converts boolean values; DELETE keeps its WHERE', () => {
        const update = { ...createUpdate(), table: 'employees', set: [{ column: 'active', valueType: 'value', value: 'false' }, { column: 'note', valueType: 'value', value: 'left' }], where: where(cond('id', '=', '7')) };
        expectSql(update, {
            default: "UPDATE employees SET active = FALSE, note = 'left' WHERE id = 7;",
            sqlserver: "UPDATE employees SET active = 0, note = 'left' WHERE id = 7;"
        });
        const del = { ...createDelete(), table: 'employees', where: where(cond('active', '=', 'false')) };
        expectSql(del, {
            default: 'DELETE FROM employees WHERE active = FALSE;',
            sqlserver: 'DELETE FROM employees WHERE active = 0;'
        });
    });
});

describe('dialect validation of hand-written SQL', () => {
    test('TRUE / FALSE typed as SQL: a warning on SQL Server only, text never rewritten', () => {
        const q = { ...createInsert(), table: 't', columns: 'a, b', rows: [{ values: 'TRUE, 1' }] };
        expect(compact(q, 'sqlserver')).toBe('INSERT INTO t (a, b) VALUES (TRUE, 1);');
        expect(validateQuery(q, { dialect: 'sqlserver' })).toEqual([{
            level: 'warning', category: 'dialect', path: 'rows.0.values',
            message: 'SQL Server has no TRUE keyword; booleans are written 1/0. Write 1 instead.'
        }]);
        for (const d of ['generic', 'postgresql', 'mysql']) expect(validateQuery(q, { dialect: d }), d).toEqual([]);
    });

    test('quoted text and quoted names containing true/false are not flagged', () => {
        const raw = createRawCondition("status = 'false' AND [true] = 1");
        const q = select({ where: where(raw) });
        expect(dialectIssues(q, 'sqlserver')).toEqual([]);
        const flagged = select({ where: where(createRawCondition('is_active = false')) });
        expect(dialectIssues(flagged, 'sqlserver')).toEqual(['warning']);
    });
});

describe('dialect validation matrix', () => {
    const inSubquery = (limit) => select({ where: where(cond('id', 'IN', '', { valueType: 'subquery', subquery: select({ table: 'd', columns: ['id'], limit }) })) });
    const cteWithOrder = select({ table: 'x', columns: ['*'], ctes: [{ ...createCte(), name: 'x', query: select({ orderBy: [desc('salary')] }) }] });
    const havingAlias = select({
        columns: ['dept', createColumn('', { aggregate: 'COUNT', alias: 'n' })],
        groupBy: [createGroupByItem('dept')],
        having: where(cond('n', '>', '5'))
    });

    const rows = [
        // [feature, query, generic, sqlserver, postgresql, mysql] — dialect issue levels
        ['LIMIT inside IN (subquery)', inSubquery('3'), [], [], [], ['error']],
        ['ORDER BY inside a CTE without a limit', cteWithOrder, [], ['error'], [], []],
        ['SELECT alias in HAVING', havingAlias, ['warning'], ['warning'], ['warning'], []]
    ];

    test.each(rows)('%s', (_name, q, ...levels) => {
        ALL.forEach((d, i) => expect(dialectIssues(q, d), d).toEqual(levels[i]));
    });

    test('dialect errors block generation; the SQL is never silently rewritten', () => {
        const q = inSubquery('3');
        expect(hasErrors(validateQuery(q, { dialect: 'mysql' }))).toBe(true);
        expect(compact(q, 'mysql')).toContain('LIMIT 3');
    });
});

describe('examples per dialect', () => {
    // What each dialect's example list must demonstrate, checked on the SQL
    // the generator writes for that dialect
    const required = {
        generic: [/^SELECT/m, /\bJOIN\b/, /\bGROUP BY\b/],
        sqlserver: [/\bTOP \d+/, /\bOFFSET \d+ ROWS\s+FETCH NEXT \d+ ROWS ONLY/, /\bOVER \(/],
        postgresql: [/\bLIMIT \d+/, /\bOFFSET \d+/, /^WITH /m, /\bOVER \(/],
        mysql: [/\bLIMIT \d+/, /\bJOIN\b/, /\bGROUP BY\b/, /\bOVER \(/]
    };

    test.each(ALL)('%s: every listed example is valid there, and together they cover its key syntax', (dialect) => {
        const sqls = examplesFor(dialect).map(example => {
            const ws = example.build();
            expect(hasErrors(validateWorkspace(ws, { dialect })), example.id).toBe(false);
            return generateSQL(ws, { dialect });
        });
        for (const pattern of required[dialect]) {
            expect(sqls.some(sql => pattern.test(sql)), String(pattern)).toBe(true);
        }
        expect(sqls.join('\n')).not.toMatch(dialect === 'sqlserver' ? /\bLIMIT\b/ : /\bTOP \d|FETCH NEXT/);
    });

    test('dialect-specific examples are listed only where they work', () => {
        expect(examplesFor('generic').map(e => e.id)).not.toContain('upsert');
        expect(examplesFor('sqlserver').map(e => e.id)).not.toContain('upsert');
        expect(examplesFor('postgresql').map(e => e.id)).toContain('upsert');
        expect(examplesFor('all').length).toBeGreaterThan(examplesFor('generic').length);
    });
});
