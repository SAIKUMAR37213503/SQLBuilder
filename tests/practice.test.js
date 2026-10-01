import { describe, expect, test } from 'vitest';
import { EXERCISES, PRACTICE_SCHEMA_SQL, practiceTables, answerWorkspace, startWorkspace, findExercise } from '../src/exercises.js';
import { checkExercise, createPracticeStore, namesIn, mentions, aggregatesOf, valueKey, CHECK_KINDS } from '../src/practice.js';
import { EXAMPLE_LEVELS, EXAMPLE_TOPICS } from '../src/examples.js';
import { importSql } from '../src/sql-import.js';
import { createWorkspace } from '../src/model.js';
import { validateWorkspace } from '../src/validation.js';
import { generateSQL } from '../src/generator.js';
import { createStorage, createMemoryBackend } from '../src/storage.js';
import { readDdl } from '../src/ddl.js';

const DIALECTS = ['generic', 'sqlserver', 'postgres', 'mysql'];

const errorsIn = (ws, dialect = 'generic') => validateWorkspace(ws, { dialect }).filter(i => i.level === 'error').length;

function workspaceOf(sql, dialect = 'generic') {
    const result = importSql(sql, { dialect });
    if (!result.ok) throw new Error(`${result.message}: ${sql}`);
    const ws = createWorkspace(result.query.kind);
    ws[result.query.kind] = result.query;
    return ws;
}

/** The checks a query fails, by label. */
function failing(id, sql, dialect = 'generic') {
    const ws = workspaceOf(sql, dialect);
    return checkExercise(findExercise(id), ws, { errors: errorsIn(ws, dialect) }).results.filter(r => !r.ok).map(r => r.label);
}

describe('exercises', () => {
    test('are well formed', () => {
        const ids = EXERCISES.map(e => e.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(EXERCISES.length).toBeGreaterThanOrEqual(15);
        const tableNames = practiceTables().map(t => t.name);
        const kinds = (test) => [test.kind, ...(test.of || []).flatMap(kinds)];
        for (const ex of EXERCISES) {
            expect(Object.keys(EXAMPLE_LEVELS), ex.id).toContain(ex.level);
            expect(EXAMPLE_TOPICS, ex.id).toContain(ex.topic);
            expect(ex.tables.every(t => tableNames.includes(t)), ex.id).toBe(true);
            expect(ex.hints.length, ex.id).toBeGreaterThanOrEqual(2);
            expect(ex.checks.length, ex.id).toBeGreaterThanOrEqual(2);
            expect(new Set(ex.checks.map(c => c.label)).size, ex.id).toBe(ex.checks.length);
            for (const check of ex.checks) {
                expect(check.label && check.hint, ex.id).toBeTruthy();
                for (const kind of kinds(check.test)) expect(CHECK_KINDS, `${ex.id}: ${kind}`).toContain(kind);
            }
            expect(ex.goal && ex.explain, ex.id).toBeTruthy();
        }
        // Every level and the main topics are covered
        expect(new Set(EXERCISES.map(e => e.level))).toEqual(new Set(Object.keys(EXAMPLE_LEVELS)));
        expect(new Set(EXERCISES.map(e => e.type))).toEqual(new Set(['select', 'update', 'delete']));
    });

    test('the practice schema reads cleanly, with its keys and links', () => {
        const result = readDdl(PRACTICE_SCHEMA_SQL);
        expect(result.problems).toEqual([]);
        expect(result.tables.map(t => t.name)).toEqual(['customers', 'products', 'orders', 'order_items', 'departments', 'employees']);
        expect(result.tables.find(t => t.name === 'employees').foreignKeys.map(fk => fk.refTable)).toEqual(['departments', 'employees']);
        expect(result.tables.find(t => t.name === 'order_items').primaryKey).toEqual(['order_id', 'product_id']);
    });

    test.each(DIALECTS)('%s: every model answer passes all of its checks, with no errors', (dialect) => {
        for (const ex of EXERCISES) {
            const ws = answerWorkspace(ex);
            const result = checkExercise(ex, ws, { errors: errorsIn(ws, dialect) });
            expect(result.results.filter(r => !r.ok).map(r => r.label), `${ex.id} in ${dialect}`).toEqual([]);
            expect(generateSQL(ws, { dialect })).toMatch(/;$/);
        }
    });

    test('model answers read only the practice tables (and their own CTEs)', () => {
        const names = new Set(practiceTables().map(t => t.name));
        for (const ex of EXERCISES) {
            const ws = answerWorkspace(ex);
            const q = ws[ws.type];
            const read = q.kind === 'select'
                ? JSON.stringify(q).match(/"kind":"table","table":"([^"]+)"/g).map(m => m.split('"')[7])
                : [q.table];
            const ctes = q.kind === 'select' ? q.ctes.map(c => c.name) : [];
            for (const name of read) expect(names.has(name) || ctes.includes(name), `${ex.id}: ${name}`).toBe(true);
            for (const name of ex.tables) expect(read, ex.id).toContain(name);
        }
    });

    test('an empty query passes none of the goal\'s parts', () => {
        for (const ex of EXERCISES) {
            const ws = startWorkspace(ex);
            expect(ws.type, ex.id).toBe(ex.type);
            const result = checkExercise(ex, ws, { errors: errorsIn(ws) });
            expect(result.passed, ex.id).toBe(false);
            // Only "it is an UPDATE" and "it leaves X out" can hold before anything is built
            const passing = ex.checks.filter(c => result.results.find(r => r.label === c.label).ok);
            expect(passing.every(c => ['type', 'none'].includes(c.test.kind)), `${ex.id}: ${passing.map(c => c.label)}`).toBe(true);
        }
    });

    test('the "no errors" check counts the validator\'s errors', () => {
        const ex = findExercise('missing-email');
        const ws = answerWorkspace(ex);
        expect(checkExercise(ex, ws, { errors: 0 }).passed).toBe(true);
        const one = checkExercise(ex, ws, { errors: 1 });
        expect(one.passed).toBe(false);
        expect(one.results.at(-1)).toEqual({ label: 'The query has no errors', hint: 'Fix the error listed under Checks first.', ok: false });
        expect(checkExercise(ex, ws, { errors: 3 }).results.at(-1).hint).toBe('Fix the 3 errors listed under Checks first.');
    });
});

describe('other correct answers pass', () => {
    test.each([
        ['customers-in-city', 'SELECT c."email", C.Name FROM Customers AS c WHERE c.city = \'London\' ORDER BY 2'],
        ['customers-in-city', "SELECT name, email FROM customers WHERE 1 = 1 AND (city = 'London') ORDER BY name ASC"],
        ['most-expensive', 'SELECT TOP 5 name, price FROM products ORDER BY price DESC', 'sqlserver'],
        ['most-expensive', 'SELECT name, price FROM products ORDER BY price DESC OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY', 'sqlserver'],
        ['shipped-this-year', "SELECT id, status, placed_at FROM orders WHERE (status = 'shipped' OR status = 'delivered') AND placed_at BETWEEN '2026-01-01' AND '2026-12-31'"],
        ['shipped-this-year', "SELECT * , status, placed_at FROM orders WHERE placed_at >= DATE '2026-01-01' AND status IN ('delivered', 'shipped')", 'postgres'],
        ['orders-per-customer', 'SELECT customers.name, COUNT(*) AS n FROM orders JOIN customers ON customers.id = orders.customer_id GROUP BY customers.name'],
        ['orders-per-customer', 'SELECT c.name, COUNT(o.id) FROM customers c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.id, c.name'],
        ['revenue-per-category', 'SELECT p.category, SUM(oi.quantity * oi.unit_price) FROM products p JOIN order_items oi ON oi.product_id = p.id GROUP BY p.category ORDER BY SUM(oi.quantity * oi.unit_price) DESC'],
        ['revenue-per-category', 'SELECT p.category, SUM(oi.unit_price * oi.quantity) AS revenue FROM order_items oi JOIN products p ON p.id = oi.product_id GROUP BY p.category ORDER BY 2 DESC'],
        ['frequent-customers', 'SELECT c.name, COUNT(*) AS orders FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.name HAVING orders > 5', 'mysql'],
        ['frequent-customers', 'SELECT o.customer_id, COUNT(*) FROM orders o JOIN customers c ON c.id = o.customer_id GROUP BY o.customer_id HAVING COUNT(*) >= 6'],
        ['customers-without-orders', 'SELECT c.name FROM customers c LEFT JOIN orders o ON o.customer_id = c.id WHERE o.id IS NULL'],
        ['customers-without-orders', 'SELECT c.name FROM orders o RIGHT JOIN customers c ON o.customer_id = c.id WHERE o.customer_id IS NULL'],
        ['customers-without-orders', 'SELECT name FROM customers WHERE id NOT IN (SELECT customer_id FROM orders WHERE customer_id IS NOT NULL)'],
        ['employees-and-managers', 'SELECT worker.name, boss.name AS boss FROM employees worker LEFT OUTER JOIN employees boss ON worker.manager_id = boss.id'],
        ['above-average-price', 'SELECT * FROM products AS p WHERE p.price >= (SELECT AVG(p2.price) FROM products AS p2)'],
        ['rank-in-department', 'SELECT name, department_id, salary, DENSE_RANK() OVER (PARTITION BY department_id ORDER BY salary DESC) FROM employees'],
        ['big-spenders-cte', 'WITH totals AS (SELECT customer_id, SUM(total) AS total FROM orders GROUP BY customer_id HAVING SUM(total) > 1000) SELECT c.name, t.total FROM customers c JOIN totals t ON t.customer_id = c.id'],
        ['reporting-chain', 'WITH RECURSIVE chain AS (SELECT id, name, manager_id FROM employees WHERE manager_id = 1 UNION ALL SELECT e.id, e.name, e.manager_id FROM chain c JOIN employees e ON e.manager_id = c.id) SELECT * FROM chain'],
        ['raise-prices', "UPDATE products SET price = price * 1.10 WHERE category = 'Books'"],
        ['delete-cancelled', "DELETE FROM orders WHERE placed_at < '2025-01-01' AND status = 'cancelled'"]
    ])('%s: %s', (id, sql, dialect = 'generic') => {
        expect(failing(id, sql, dialect)).toEqual([]);
    });
});

describe('wrong answers fail the right check', () => {
    test.each([
        ['most-expensive', 'SELECT name, price FROM products ORDER BY price LIMIT 5', ['Sorts by price, highest first']],
        ['most-expensive', 'SELECT name, price FROM products ORDER BY price DESC LIMIT 10', ['Keeps the first 5 rows']],
        ['missing-email', 'SELECT id, name FROM customers WHERE email = NULL', ['Keeps customers whose email is missing']],
        ['customers-in-city', "SELECT name, email FROM customers WHERE city = 'London' OR id > 0 ORDER BY name", ['Keeps only customers in London']],
        ['customers-in-city', "SELECT name, email FROM customers WHERE NOT (city = 'London') ORDER BY name", ['Keeps only customers in London']],
        ['shipped-this-year', "SELECT id, status, placed_at FROM orders WHERE status = 'shipped' AND placed_at >= '2026-01-01'", ['Keeps the shipped and delivered orders']],
        ['orders-per-customer', 'SELECT c.name, COUNT(o.id) FROM customers c JOIN orders o ON o.customer_id = c.id', ['One row per customer']],
        ['frequent-customers', 'SELECT c.name, COUNT(*) FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.name', ['Keeps groups with more than 5 orders']],
        // An INNER JOIN can't find customers with no order
        ['customers-without-orders', 'SELECT c.name FROM customers c JOIN orders o ON o.customer_id = c.id WHERE o.id IS NULL', ['Looks for customers with no matching order']],
        // The customer's own id is never NULL
        ['customers-without-orders', 'SELECT c.name FROM customers c LEFT JOIN orders o ON o.customer_id = c.id WHERE c.id IS NULL', ['Looks for customers with no matching order']],
        ['employees-and-managers', 'SELECT e.name, m.name FROM employees e JOIN employees m ON e.manager_id = m.id', ['Joins employees to itself, keeping every employee']],
        ['rank-in-department', 'SELECT department_id, MAX(salary), RANK() OVER (PARTITION BY department_id ORDER BY MAX(salary) DESC) FROM employees GROUP BY department_id', ['Shows the salary', 'Keeps one row per employee']],
        ['rank-in-department', 'SELECT name, salary, RANK() OVER (ORDER BY salary DESC) FROM employees', ['Starts the ranking again for each department']],
        ['big-spenders-cte', "SELECT c.name, SUM(o.total) FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.name HAVING SUM(o.total) > 1000", ['Defines a CTE the main query reads', 'The CTE adds up the order totals', 'The CTE has one row per customer', 'Keeps totals over 1000']],
        ['reporting-chain', 'SELECT id, name FROM employees WHERE manager_id = 1', ['Uses a recursive CTE', 'Starts from employee 1\'s direct reports', 'Repeats with UNION ALL', 'Each round finds the reports of the people just found']],
        ['raise-prices', 'UPDATE products SET price = 10', ['Sets the price from the old price', 'Changes only the books']],
        // OR would also delete every older order
        ['delete-cancelled', "DELETE FROM orders WHERE status = 'cancelled' OR placed_at < '2025-01-01'", ['Only cancelled orders', 'Only orders placed before 2025']],
        ['delete-cancelled', "SELECT * FROM orders WHERE status = 'cancelled' AND placed_at < '2025-01-01'", ['Is a DELETE', 'Deletes from orders']]
    ])('%s: %s', (id, sql, expected) => {
        expect(failing(id, sql)).toEqual(expected);
    });
});

describe('reading queries', () => {
    test('names, with quotes, qualifiers and function calls left out', () => {
        expect(namesIn('COUNT(o.id) + "Total Sum" - [x].[y z] * `t`.col')).toEqual([['o', 'id'], ['total sum'], ['x', 'y z'], ['t', 'col']]);
        expect(namesIn("name = 'id'")).toEqual([['name']]);
    });

    test('a column through an alias of its table', () => {
        const q = importSql('SELECT 1 FROM orders AS o JOIN customers c ON c.id = o.customer_id').query;
        expect(mentions('o.id', 'id', { table: 'orders', q })).toBe(true);
        expect(mentions('c.id', 'id', { table: 'orders', q })).toBe(false);
        expect(mentions('id', 'id', { table: 'orders', q })).toBe(true);
        expect(mentions('orders.id', 'id', { table: 'orders' })).toBe(true);
        expect(mentions('ids', 'id')).toBe(false);
    });

    test('aggregates, from the aggregate menu or written out', () => {
        expect(aggregatesOf({ kind: 'column', expr: 'o.id', aggregate: 'COUNT DISTINCT' })).toEqual([{ fn: 'COUNT', arg: 'o.id' }]);
        expect(aggregatesOf({ kind: 'column', expr: 'sum(a * b) / count(*)', aggregate: '' })).toEqual([{ fn: 'SUM', arg: 'a * b' }, { fn: 'COUNT', arg: '*' }]);
        expect(aggregatesOf({ kind: 'column', expr: "'COUNT(x)'", aggregate: '' })).toEqual([]);
        expect(aggregatesOf({ kind: 'window', func: 'SUM' })).toEqual([]);
    });

    test('values compare without quotes, case or number formatting', () => {
        expect(valueKey("'London'")).toBe('london');
        expect(valueKey(' 5.0 ')).toBe('5');
        expect(valueKey("DATE '2026-01-01'")).toBe('2026-01-01');
        expect(valueKey("'O''Hare'")).toBe("o'hare");
    });

    test('an unknown check kind is a programming error', () => {
        expect(() => checkExercise({ checks: [{ label: 'x', hint: 'y', test: { kind: 'nope' } }] }, createWorkspace())).toThrow(/Unknown practice check/);
    });
});

describe('progress', () => {
    const ids = EXERCISES.map(e => e.id);

    test('keeps done exercises and the open one', () => {
        const backend = createMemoryBackend();
        const store = createPracticeStore(createStorage(backend), ids);
        expect(store.doneCount).toBe(0);
        store.setActive('missing-email');
        store.markDone('missing-email', 1000);
        store.markDone('missing-email', 2000);
        store.markDone('not-an-exercise');
        const again = createPracticeStore(createStorage(backend), ids);
        expect(again.active).toBe('missing-email');
        expect(again.isDone('missing-email')).toBe(true);
        expect(again.doneCount).toBe(1);
        again.clear();
        expect(createPracticeStore(createStorage(backend), ids).doneCount).toBe(0);
        expect(backend.getItem('sqlb:v1:practice')).toBe(null);
    });

    test('reads stored data as untrusted', () => {
        for (const stored of [
            '{"done":{"missing-email":"soon","__proto__":1,"unknown":5,"most-expensive":-1},"active":"<img>"}',
            '{"done":[1,2],"active":7}',
            '[1]',
            'not json'
        ]) {
            const store = createPracticeStore(createStorage(createMemoryBackend({ 'sqlb:v1:practice': stored })), ids);
            expect(store.doneCount, stored).toBe(0);
            expect(store.active, stored).toBe(null);
        }
        const ok = createPracticeStore(createStorage(createMemoryBackend({ 'sqlb:v1:practice': '{"done":{"missing-email":5,"gone":5},"active":"gone"}' })), ids);
        expect(ok.doneCount).toBe(1);
        expect(ok.active).toBe(null);
    });
});
