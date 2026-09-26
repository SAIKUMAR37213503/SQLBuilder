import { describe, expect, test } from 'vitest';
import { generateQuery, generateSQL, formatLiteral } from '../src/generator.js';
import {
    createSelect, createColumn, createCaseColumn, createCondition, createRawCondition, createGroup,
    createJoin, createTableSource, createSubquerySource, createCte, createSetOp, createOrderItem,
    createGroupByItem, createInsert, createUpdate, createDelete, createWorkspace
} from '../src/model.js';

// Compact builder for SELECT test fixtures
function select({ table = 'Employees', alias = '', columns = ['*'], ...rest } = {}) {
    return createSelect({
        columns: columns.map(c => (typeof c === 'string' ? createColumn(c) : c)),
        from: createTableSource(table, alias),
        ...rest
    });
}

const where = (...items) => createGroup('AND', items);
const cond = (left, op, value = '', extra = {}) => createCondition({ left, op, value, ...extra });

describe('SELECT', () => {
    test('matches the documented format', () => {
        const q = select({
            columns: ['Name', 'Salary'],
            where: where(cond('Salary', '>', '50000')),
            orderBy: [{ expr: 'Salary', direction: 'DESC' }],
            limit: '10'
        });
        expect(generateQuery(q)).toBe(
            'SELECT\n    Name,\n    Salary\nFROM Employees\nWHERE Salary > 50000\nORDER BY Salary DESC\nLIMIT 10;'
        );
    });

    test('single column stays on the SELECT line', () => {
        expect(generateQuery(select())).toBe('SELECT *\nFROM Employees;');
    });

    test('DISTINCT, column and table aliases', () => {
        const q = select({
            alias: 'e',
            distinct: true,
            columns: [createColumn('e.dept', { alias: 'department' }), createColumn('e.city')]
        });
        expect(generateQuery(q)).toBe('SELECT DISTINCT\n    e.dept AS department,\n    e.city\nFROM Employees AS e;');
    });

    test('aggregates, COUNT(*) default and COUNT DISTINCT', () => {
        const q = select({
            columns: [
                createColumn('', { aggregate: 'COUNT', alias: 'total' }),
                createColumn('dept', { aggregate: 'COUNT DISTINCT' }),
                createColumn('salary', { aggregate: 'AVG', alias: 'avg_salary' })
            ]
        });
        expect(generateQuery(q)).toBe(
            'SELECT\n    COUNT(*) AS total,\n    COUNT(DISTINCT dept),\n    AVG(salary) AS avg_salary\nFROM Employees;'
        );
    });

    test('calculated expressions are kept verbatim', () => {
        const q = select({ columns: [createColumn('salary * 1.1', { alias: 'raised' })] });
        expect(generateQuery(q)).toBe('SELECT salary * 1.1 AS raised\nFROM Employees;');
    });

    test('CASE expression', () => {
        const c = createCaseColumn();
        c.cases = [{ when: 'salary > 100000', then: "'High'" }, { when: 'salary > 50000', then: "'Mid'" }];
        c.elseValue = "'Low'";
        c.alias = 'band';
        const q = select({ columns: ['name', c] });
        expect(generateQuery(q)).toBe(
            "SELECT\n    name,\n    CASE\n        WHEN salary > 100000 THEN 'High'\n        WHEN salary > 50000 THEN 'Mid'\n        ELSE 'Low'\n    END AS band\nFROM Employees;"
        );
    });

    test('LIMIT with OFFSET, and OFFSET alone', () => {
        expect(generateQuery(select({ limit: '10', offset: '20' }))).toBe('SELECT *\nFROM Employees\nLIMIT 10\nOFFSET 20;');
        expect(generateQuery(select({ offset: '5' }))).toBe('SELECT *\nFROM Employees\nOFFSET 5;');
    });

    test('ORDER BY with multiple items and ASC omitted', () => {
        const q = select({ orderBy: [createOrderItem('dept'), { expr: 'salary', direction: 'DESC' }] });
        expect(generateQuery(q)).toBe('SELECT *\nFROM Employees\nORDER BY dept, salary DESC;');
    });

    test('GROUP BY and HAVING', () => {
        const q = select({
            columns: ['dept', createColumn('', { aggregate: 'COUNT' })],
            groupBy: [createGroupByItem('dept')],
            having: where(cond('COUNT(*)', '>', '5', { valueType: 'value' }))
        });
        expect(generateQuery(q)).toBe('SELECT\n    dept,\n    COUNT(*)\nFROM Employees\nGROUP BY dept\nHAVING COUNT(*) > 5;');
    });
});

describe('JOIN', () => {
    function join(type, table, alias, left, right) {
        const j = createJoin(type);
        j.source = createTableSource(table, alias);
        j.on = where(cond(left, '=', right, { valueType: 'column' }));
        return j;
    }

    test('single join', () => {
        const q = select({ table: 'users', alias: 'u', columns: ['u.name', 'o.total'], joins: [join('INNER JOIN', 'orders', 'o', 'u.id', 'o.user_id')] });
        expect(generateQuery(q)).toBe(
            'SELECT\n    u.name,\n    o.total\nFROM users AS u\nINNER JOIN orders AS o\n    ON u.id = o.user_id;'
        );
    });

    test('multiple joins, multi-condition ON and CROSS JOIN without ON', () => {
        const j1 = join('LEFT JOIN', 'orders', 'o', 'u.id', 'o.user_id');
        j1.on.items.push(cond('o.status', '=', 'paid'));
        const j2 = join('CROSS JOIN', 'regions', 'r', '', '');
        const q = select({ table: 'users', alias: 'u', joins: [j1, j2] });
        expect(generateQuery(q)).toBe(
            "SELECT *\nFROM users AS u\nLEFT JOIN orders AS o\n    ON u.id = o.user_id\n    AND o.status = 'paid'\nCROSS JOIN regions AS r;"
        );
    });
});

describe('WHERE conditions', () => {
    const gen = (...items) => generateQuery(select({ where: where(...items) })).split('\n').slice(2).join('\n');

    test('literal handling: numbers, text, quotes, booleans, NULL', () => {
        expect(gen(cond('name', '=', 'John'))).toBe("WHERE name = 'John';");
        expect(gen(cond('name', '=', "O'Brien"))).toBe("WHERE name = 'O''Brien';");
        expect(gen(cond('name', '=', "'already quoted'"))).toBe("WHERE name = 'already quoted';");
        expect(gen(cond('age', '>=', '18'))).toBe('WHERE age >= 18;');
        expect(gen(cond('active', '=', 'true'))).toBe('WHERE active = TRUE;');
        expect(gen(cond('x', '=', 'null'))).toBe('WHERE x = NULL;');
    });

    test('column comparison is not quoted', () => {
        expect(gen(cond('a.x', '=', 'b.y', { valueType: 'column' }))).toBe('WHERE a.x = b.y;');
    });

    test('IN, NOT IN, BETWEEN, LIKE, IS NULL', () => {
        expect(gen(cond('dept', 'IN', "Sales, IT, 'R&D, Labs'"))).toBe("WHERE dept IN ('Sales', 'IT', 'R&D, Labs');");
        expect(gen(cond('id', 'NOT IN', '1, 2, 3'))).toBe('WHERE id NOT IN (1, 2, 3);');
        expect(gen(cond('age', 'BETWEEN', '18', { value2: '65' }))).toBe('WHERE age BETWEEN 18 AND 65;');
        expect(gen(cond('name', 'NOT LIKE', 'J%'))).toBe("WHERE name NOT LIKE 'J%';");
        expect(gen(cond('manager_id', 'IS NULL'))).toBe('WHERE manager_id IS NULL;');
        expect(gen(cond('email', 'IS NOT NULL'))).toBe('WHERE email IS NOT NULL;');
    });

    test('AND / OR with nested groups and NOT', () => {
        const inner = createGroup('OR', [cond('dept', '=', 'IT'), cond('dept', '=', 'Ops')]);
        const negated = createGroup('AND', [cond('status', '=', 'retired')]);
        negated.negate = true;
        expect(gen(cond('salary', '>', '1000'), inner, negated)).toBe(
            "WHERE salary > 1000\n    AND (dept = 'IT' OR dept = 'Ops')\n    AND NOT (status = 'retired');"
        );
    });

    test('top-level OR', () => {
        const q = select({ where: createGroup('OR', [cond('a', '=', '1'), cond('b', '=', '2')]) });
        expect(generateQuery(q)).toBe('SELECT *\nFROM Employees\nWHERE a = 1\n    OR b = 2;');
    });

    test('custom SQL condition is inserted as written', () => {
        expect(gen(createRawCondition("LOWER(name) = 'x'"))).toBe("WHERE LOWER(name) = 'x';");
    });

    test('empty nested groups are skipped', () => {
        expect(gen(cond('a', '=', '1'), createGroup('OR', []))).toBe('WHERE a = 1;');
    });
});

describe('subqueries and CTEs', () => {
    test('IN subquery', () => {
        const sub = select({ table: 'orders', columns: ['user_id'], where: where(cond('total', '>', '100')) });
        const q = select({ table: 'users', where: where(cond('id', 'IN', '', { valueType: 'subquery', subquery: sub })) });
        expect(generateQuery(q)).toBe(
            'SELECT *\nFROM users\nWHERE id IN (\n    SELECT user_id\n    FROM orders\n    WHERE total > 100\n);'
        );
    });

    test('NOT EXISTS as a second condition is indented', () => {
        const sub = select({ table: 'orders', alias: 'o', columns: ['1'], where: where(cond('o.user_id', '=', 'u.id', { valueType: 'column' })) });
        const q = select({
            table: 'users', alias: 'u',
            where: where(cond('u.active', '=', 'true'), cond('', 'NOT EXISTS', '', { valueType: 'subquery', subquery: sub }))
        });
        expect(generateQuery(q)).toBe(
            'SELECT *\nFROM users AS u\nWHERE u.active = TRUE\n    AND NOT EXISTS (\n        SELECT 1\n        FROM orders AS o\n        WHERE o.user_id = u.id\n    );'
        );
    });

    test('derived table in FROM', () => {
        const source = createSubquerySource();
        source.query = select({ table: 'orders', columns: ['user_id', createColumn('total', { aggregate: 'SUM', alias: 'spent' })], groupBy: [createGroupByItem('user_id')] });
        source.alias = 't';
        const q = select({ columns: ['t.user_id'], where: where(cond('t.spent', '>', '500')) });
        q.from = source;
        expect(generateQuery(q)).toBe(
            'SELECT t.user_id\nFROM (\n    SELECT\n        user_id,\n        SUM(total) AS spent\n    FROM orders\n    GROUP BY user_id\n) AS t\nWHERE t.spent > 500;'
        );
    });

    test('WITH clause with two CTEs', () => {
        const a = createCte();
        a.name = 'recent';
        a.query = select({ table: 'orders', where: where(cond('year', '=', '2026')) });
        const b = createCte();
        b.name = 'big';
        b.query = select({ table: 'recent', where: where(cond('total', '>', '1000')) });
        const q = select({ table: 'big', ctes: [a, b] });
        expect(generateQuery(q)).toBe(
            'WITH recent AS (\n    SELECT *\n    FROM orders\n    WHERE year = 2026\n),\nbig AS (\n    SELECT *\n    FROM recent\n    WHERE total > 1000\n)\nSELECT *\nFROM big;'
        );
    });

    test('nested group containing a subquery is laid out on multiple lines', () => {
        const sub = select({ table: 'vip', columns: ['id'] });
        const group = createGroup('OR', [cond('id', '=', '1'), cond('id', 'IN', '', { valueType: 'subquery', subquery: sub })]);
        const q = select({ where: where(cond('a', '=', '1'), group) });
        expect(generateQuery(q)).toBe(
            'SELECT *\nFROM Employees\nWHERE a = 1\n    AND (\n        id = 1\n        OR id IN (\n            SELECT id\n            FROM vip\n        )\n    );'
        );
    });
});

describe('UNION', () => {
    test('UNION / UNION ALL with ORDER BY and LIMIT applied to the combined result', () => {
        const u1 = createSetOp('UNION');
        u1.query = select({ table: 'suppliers', columns: ['name'] });
        const u2 = createSetOp('UNION ALL');
        u2.query = select({ table: 'partners', columns: ['name'] });
        const q = select({ table: 'customers', columns: ['name'], setOps: [u1, u2], orderBy: [createOrderItem('name')], limit: '10' });
        expect(generateQuery(q)).toBe(
            'SELECT name\nFROM customers\nUNION\nSELECT name\nFROM suppliers\nUNION ALL\nSELECT name\nFROM partners\nORDER BY name\nLIMIT 10;'
        );
    });

    test('ORDER BY / LIMIT inside a UNION branch are ignored', () => {
        const u = createSetOp('UNION');
        u.query = select({ table: 'b', columns: ['x'], orderBy: [createOrderItem('x')], limit: '3' });
        const q = select({ table: 'a', columns: ['x'], setOps: [u] });
        expect(generateQuery(q)).toBe('SELECT x\nFROM a\nUNION\nSELECT x\nFROM b;');
    });
});

describe('INSERT / UPDATE / DELETE', () => {
    test('INSERT single and multiple rows', () => {
        const q = createInsert();
        q.table = 'Employees';
        q.columns = 'Name, Salary';
        q.rows = [{ values: "'John', 50000" }];
        expect(generateQuery(q)).toBe("INSERT INTO Employees (Name, Salary)\nVALUES ('John', 50000);");
        q.rows.push({ values: "('Jane', 60000)" });
        expect(generateQuery(q)).toBe("INSERT INTO Employees (Name, Salary)\nVALUES\n    ('John', 50000),\n    ('Jane', 60000);");
    });

    test('INSERT without a column list', () => {
        const q = createInsert();
        q.table = 't';
        q.rows = [{ values: '1, 2' }];
        expect(generateQuery(q)).toBe('INSERT INTO t\nVALUES (1, 2);');
    });

    test('UPDATE with several assignments and WHERE', () => {
        const q = createUpdate();
        q.table = 'Employees';
        q.set = [
            { column: 'Salary', valueType: 'value', value: '60000' },
            { column: 'Department', valueType: 'value', value: 'IT' },
            { column: 'updated_at', valueType: 'column', value: 'CURRENT_TIMESTAMP' }
        ];
        q.where = where(cond('EmployeeID', '=', '1'));
        expect(generateQuery(q)).toBe(
            "UPDATE Employees\nSET\n    Salary = 60000,\n    Department = 'IT',\n    updated_at = CURRENT_TIMESTAMP\nWHERE EmployeeID = 1;"
        );
    });

    test('UPDATE single assignment, no WHERE', () => {
        const q = createUpdate();
        q.table = 't';
        q.set = [{ column: 'a', valueType: 'value', value: '1' }];
        expect(generateQuery(q)).toBe('UPDATE t\nSET a = 1;');
    });

    test('DELETE', () => {
        const q = createDelete();
        q.table = 'Employees';
        q.where = where(cond('EmployeeID', '=', '1'));
        expect(generateQuery(q)).toBe('DELETE FROM Employees\nWHERE EmployeeID = 1;');
    });
});

describe('dialects', () => {
    const q = () => select({ columns: ['name'], where: where(cond('active', '=', 'true'), cond('note', '=', 'C:\\path')), limit: '10' });

    test('PostgreSQL', () => {
        expect(generateQuery(q(), { dialect: 'postgresql' })).toBe(
            "SELECT name\nFROM Employees\nWHERE active = TRUE\n    AND note = 'C:\\path'\nLIMIT 10;"
        );
    });

    test('MySQL escapes backslashes and quotes with backticks', () => {
        expect(generateQuery(q(), { dialect: 'mysql', quoteIdentifiers: true })).toBe(
            "SELECT `name`\nFROM `Employees`\nWHERE `active` = TRUE\n    AND `note` = 'C:\\\\path'\nLIMIT 10;"
        );
    });

    test('MySQL OFFSET without LIMIT', () => {
        expect(generateQuery(select({ offset: '5' }), { dialect: 'mysql' })).toBe('SELECT *\nFROM Employees\nLIMIT 18446744073709551615 OFFSET 5;');
    });

    test('SQL Server uses TOP, 1/0 booleans and [brackets]', () => {
        expect(generateQuery(q(), { dialect: 'sqlserver', quoteIdentifiers: true })).toBe(
            "SELECT TOP 10 [name]\nFROM [Employees]\nWHERE [active] = 1\n    AND [note] = 'C:\\path';"
        );
    });

    test('SQL Server OFFSET/FETCH adds ORDER BY when missing', () => {
        expect(generateQuery(select({ limit: '10', offset: '20' }), { dialect: 'sqlserver' })).toBe(
            'SELECT *\nFROM Employees\nORDER BY (SELECT NULL)\nOFFSET 20 ROWS\nFETCH NEXT 10 ROWS ONLY;'
        );
        expect(generateQuery(select({ limit: '10', orderBy: [createOrderItem('id')], offset: '0' }), { dialect: 'sqlserver' })).toBe(
            'SELECT *\nFROM Employees\nORDER BY id\nOFFSET 0 ROWS\nFETCH NEXT 10 ROWS ONLY;'
        );
    });

    test('identifier quoting leaves expressions, * and pre-quoted names alone', () => {
        const query = select({ table: 'sales.orders', alias: 'o', columns: ['o.*', 'SUM(o.total)', '"Mixed Case"'] });
        expect(generateQuery(query, { quoteIdentifiers: true })).toBe(
            'SELECT\n    "o".*,\n    SUM(o.total),\n    "Mixed Case"\nFROM "sales"."orders" AS "o";'
        );
    });

    test('unknown dialect falls back to generic', () => {
        expect(generateQuery(select(), { dialect: 'nope' })).toBe('SELECT *\nFROM Employees;');
    });
});

describe('output modes', () => {
    test('compact output is a single line without spaces inside parentheses', () => {
        const sub = select({ table: 'orders', columns: ['user_id'] });
        const q = select({ table: 'users', columns: ['id', 'name'], where: where(cond('id', 'IN', '', { valueType: 'subquery', subquery: sub })) });
        expect(generateQuery(q, { pretty: false })).toBe('SELECT id, name FROM users WHERE id IN (SELECT user_id FROM orders);');
    });

    test('compact mode never alters string literal contents', () => {
        const q = select({ where: where(cond('note', '=', '( spaced )')) });
        expect(generateQuery(q, { pretty: false })).toBe("SELECT * FROM Employees WHERE note = '( spaced )';");
    });

    test('generateSQL uses the workspace active type and is deterministic', () => {
        const ws = createWorkspace('delete');
        ws.delete.table = 'logs';
        expect(generateSQL(ws)).toBe('DELETE FROM logs;');
        expect(generateSQL(ws)).toBe(generateSQL(structuredClone(ws)));
    });
});

describe('formatLiteral', () => {
    test.each([
        ['42', '42'], ['-3.5', '-3.5'], ['1e3', '1e3'], ['abc', "'abc'"], ["it's", "'it''s'"],
        ['NULL', 'NULL'], ['FALSE', 'FALSE'], ["'x'", "'x'"], ['', "''"], ['12abc', "'12abc'"]
    ])('%s -> %s', (input, expected) => {
        expect(formatLiteral(input)).toBe(expected);
    });

    test('dialect booleans', () => {
        expect(formatLiteral('true', 'sqlserver')).toBe('1');
    });
});
