// Practice exercises: a goal over a small shop and staff schema, the checks
// that say whether the query is built to reach it (practice.js reads them),
// hints, and a model answer. Model answers are SQL in the generic dialect,
// read by the SQL importer, so the builder shows them in any dialect.
//
// Checks are structural: they can't tell whether a query returns the right
// rows, only whether it has the parts the goal needs. They accept the usual
// variations (aliases, COUNT(*) or COUNT(id), NOT EXISTS or LEFT JOIN … IS
// NULL), and the tests run each model answer and several other correct
// answers through them.

import { importSql } from './sql-import.js';
import { readDdl } from './ddl.js';
import { createWorkspace } from './model.js';

/** The practice tables, as CREATE TABLE statements (readable in every dialect). */
export const PRACTICE_SCHEMA_SQL = `CREATE TABLE customers (
    id INT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(255),
    city VARCHAR(100),
    created_at DATE
);
CREATE TABLE products (
    id INT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    category VARCHAR(50),
    price DECIMAL(10, 2)
);
CREATE TABLE orders (
    id INT PRIMARY KEY,
    customer_id INT REFERENCES customers (id),
    status VARCHAR(20),
    placed_at DATE,
    total DECIMAL(10, 2)
);
CREATE TABLE order_items (
    order_id INT REFERENCES orders (id),
    product_id INT REFERENCES products (id),
    quantity INT,
    unit_price DECIMAL(10, 2),
    PRIMARY KEY (order_id, product_id)
);
CREATE TABLE departments (
    id INT PRIMARY KEY,
    name VARCHAR(100) NOT NULL
);
CREATE TABLE employees (
    id INT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    department_id INT REFERENCES departments (id),
    manager_id INT REFERENCES employees (id),
    salary DECIMAL(10, 2),
    hired_at DATE
);`;

/** The practice tables, read once. */
export function practiceTables() {
    return readDdl(PRACTICE_SCHEMA_SQL).tables;
}

// Short forms for the checks
const reads = (table, label = `Reads the ${table} table`) => ({ label, hint: `Choose ${table} in FROM or in a JOIN.`, test: { kind: 'reads', table } });
const shows = (column, label, hint = `Add ${column} to the columns.`) => ({ label, hint, test: { kind: 'select', column } });

/**
 * @typedef {{ label: string, hint: string, test: any }} Check
 * @typedef {{ id: string, level: 'beginner' | 'intermediate' | 'advanced', topic: string, title: string,
 *   goal: string, tables: string[], type: string, checks: Check[], hints: string[], answer: string, explain: string }} Exercise
 */

/** @type {Exercise[]} */
export const EXERCISES = [
    {
        id: 'customers-in-city',
        level: 'beginner',
        topic: 'Filtering and sorting',
        title: 'Customers in one city',
        goal: 'List the name and email of every customer in London, sorted by name.',
        tables: ['customers'],
        type: 'select',
        checks: [
            reads('customers'),
            shows('name', 'Shows the name'),
            shows('email', 'Shows the email'),
            { label: 'Keeps only customers in London', hint: 'Add a WHERE condition: city = London.', test: { kind: 'filter', column: 'city', ops: ['='], values: ['London'] } },
            { label: 'Sorts by name', hint: 'Add name under ORDER BY.', test: { kind: 'orderBy', column: 'name' } }
        ],
        hints: [
            'FROM customers, with name and email as the columns.',
            'The city goes in WHERE: city = London. The builder adds the quotes.',
            'ORDER BY name. A to Z is ASC, the default.'
        ],
        answer: "SELECT name, email FROM customers WHERE city = 'London' ORDER BY name",
        explain: 'WHERE keeps the rows you want before anything else happens, and ORDER BY sorts what is left. Without ORDER BY a database may return rows in any order.'
    },
    {
        id: 'most-expensive',
        level: 'beginner',
        topic: 'Filtering and sorting',
        title: 'The 5 most expensive products',
        goal: 'Show the name and price of the 5 most expensive products, most expensive first.',
        tables: ['products'],
        type: 'select',
        checks: [
            reads('products'),
            shows('name', 'Shows the name'),
            shows('price', 'Shows the price'),
            { label: 'Sorts by price, highest first', hint: 'Add price under ORDER BY and choose DESC.', test: { kind: 'orderBy', column: 'price', direction: 'DESC' } },
            { label: 'Keeps the first 5 rows', hint: 'Set the row limit to 5.', test: { kind: 'limit', value: '5' } }
        ],
        hints: [
            'FROM products, with name and price as the columns.',
            'Sort by price with DESC so the highest comes first.',
            'Then set the row limit to 5. On SQL Server this becomes TOP or OFFSET … FETCH.'
        ],
        answer: 'SELECT name, price FROM products ORDER BY price DESC LIMIT 5',
        explain: 'A row limit keeps the first rows after sorting, so the sort decides which 5 you get. Without ORDER BY, "the first 5" could be any 5.'
    },
    {
        id: 'missing-email',
        level: 'beginner',
        topic: 'Filtering and sorting',
        title: 'Customers with no email',
        goal: 'Find the customers who have no email address. Show their id and name.',
        tables: ['customers'],
        type: 'select',
        checks: [
            reads('customers'),
            shows('id', 'Shows the id'),
            shows('name', 'Shows the name'),
            {
                label: 'Keeps customers whose email is missing',
                hint: 'Missing values are NULL, and NULL never equals anything. Use the IS NULL operator on email.',
                test: { kind: 'filter', column: 'email', ops: ['IS NULL'] }
            }
        ],
        hints: [
            'FROM customers, with id and name as the columns.',
            'email = NULL never matches any row, because NULL isn\'t equal to anything, not even NULL.',
            'Choose the IS NULL operator for email.'
        ],
        answer: 'SELECT id, name FROM customers WHERE email IS NULL',
        explain: 'NULL means "no value". Comparing with = NULL gives unknown, which WHERE treats as false, so IS NULL and IS NOT NULL are the only ways to test for it.'
    },
    {
        id: 'shipped-this-year',
        level: 'beginner',
        topic: 'Filtering and sorting',
        title: 'Shipped or delivered in 2026',
        goal: 'List the orders placed in 2026 whose status is shipped or delivered: id, status and placed_at.',
        tables: ['orders'],
        type: 'select',
        checks: [
            reads('orders'),
            shows('status', 'Shows the status'),
            shows('placed_at', 'Shows when the order was placed'),
            {
                label: 'Keeps the shipped and delivered orders',
                hint: 'Use IN with both values: status IN (shipped, delivered).',
                test: { kind: 'anyOf', of: [
                    { kind: 'filter', column: 'status', ops: ['IN'], values: ['shipped', 'delivered'] },
                    { kind: 'allOf', of: [
                        { kind: 'filter', column: 'status', ops: ['='], values: ['shipped'], anyLogic: true },
                        { kind: 'filter', column: 'status', ops: ['='], values: ['delivered'], anyLogic: true }
                    ] }
                ] }
            },
            {
                label: 'Keeps orders placed in 2026',
                hint: 'Compare placed_at with dates: placed_at >= 2026-01-01 and placed_at < 2027-01-01, or BETWEEN.',
                test: { kind: 'anyOf', of: [
                    { kind: 'filter', column: 'placed_at', ops: ['>='], values: ['2026-01-01'] },
                    { kind: 'filter', column: 'placed_at', ops: ['BETWEEN'], values: ['2026-01-01', '2026-12-31'] }
                ] }
            }
        ],
        hints: [
            'Two conditions joined with AND: one on status, one on placed_at.',
            'status IN (shipped, delivered) is shorter than two conditions joined with OR.',
            'For the year: placed_at >= 2026-01-01 AND placed_at < 2027-01-01. That also works when placed_at has a time of day.'
        ],
        answer: "SELECT id, status, placed_at FROM orders WHERE status IN ('shipped', 'delivered') AND placed_at >= '2026-01-01' AND placed_at < '2027-01-01'",
        explain: 'IN is a short way to write several = conditions joined with OR. A range with >= and < takes in the whole year, even when dates have a time of day; BETWEEN … 2026-12-31 would miss times on the last day.'
    },
    {
        id: 'orders-per-customer',
        level: 'intermediate',
        topic: 'Aggregation',
        title: 'Orders per customer',
        goal: 'For each customer who has ordered, show their name and how many orders they placed.',
        tables: ['customers', 'orders'],
        type: 'select',
        checks: [
            {
                label: 'Joins orders to customers',
                hint: 'Join orders to customers ON orders.customer_id = customers.id.',
                test: { kind: 'join', tables: ['customers', 'orders'] }
            },
            shows('name', 'Shows the customer\'s name'),
            {
                label: 'Counts the orders',
                hint: 'Add a column with COUNT: COUNT(*) or COUNT of the order id.',
                test: { kind: 'select', aggregate: ['COUNT'], column: 'id', allowStar: true }
            },
            {
                label: 'One row per customer',
                hint: 'Add the customer\'s name (or id) under GROUP BY.',
                test: { kind: 'anyOf', of: [{ kind: 'groupBy', column: 'name' }, { kind: 'groupBy', column: 'id', table: 'customers' }, { kind: 'groupBy', column: 'customer_id' }] }
            }
        ],
        hints: [
            'FROM customers, then JOIN orders. The JOIN assistant offers the ON condition when the practice tables are in your schema.',
            'COUNT(*) counts the rows in each group: here, one row per order.',
            'GROUP BY the customer, so the count is per customer rather than one count for everything.'
        ],
        answer: 'SELECT c.name, COUNT(o.id) AS orders FROM customers AS c INNER JOIN orders AS o ON o.customer_id = c.id GROUP BY c.id, c.name',
        explain: 'The join gives one row per order with its customer next to it. GROUP BY folds those rows into one per customer, and COUNT counts the rows folded into each. Grouping by id as well as name keeps two customers with the same name apart.'
    },
    {
        id: 'revenue-per-category',
        level: 'intermediate',
        topic: 'Aggregation',
        title: 'Revenue per category',
        goal: 'Show each product category with its total revenue (quantity × unit price over all order items), highest first.',
        tables: ['order_items', 'products'],
        type: 'select',
        checks: [
            {
                label: 'Joins order items to products',
                hint: 'Join products to order_items ON order_items.product_id = products.id.',
                test: { kind: 'join', tables: ['order_items', 'products'] }
            },
            shows('category', 'Shows the category'),
            {
                label: 'Adds up quantity × unit price',
                hint: 'Add a column SUM(quantity * unit_price), or choose SUM with quantity * unit_price.',
                test: { kind: 'select', aggregate: ['SUM'], column: 'quantity' }
            },
            { label: 'One row per category', hint: 'Add category under GROUP BY.', test: { kind: 'groupBy', column: 'category' } },
            {
                label: 'Highest revenue first',
                hint: 'Sort by the revenue column (its alias works) with DESC.',
                test: { kind: 'orderBy', column: 'quantity', direction: 'DESC' }
            }
        ],
        hints: [
            'The category is in products; quantities and prices are in order_items, so you need both.',
            'SUM(oi.quantity * oi.unit_price) adds up each line\'s value. Give it an alias such as revenue.',
            'GROUP BY category, then ORDER BY revenue DESC.'
        ],
        answer: 'SELECT p.category, SUM(oi.quantity * oi.unit_price) AS revenue FROM order_items AS oi INNER JOIN products AS p ON p.id = oi.product_id GROUP BY p.category ORDER BY revenue DESC',
        explain: 'The multiplication happens on each order line first, then SUM adds the results for each category. ORDER BY can use the alias because it runs after the SELECT list.'
    },
    {
        id: 'frequent-customers',
        level: 'intermediate',
        topic: 'Aggregation',
        title: 'Customers with more than 5 orders',
        goal: 'List the customers who placed more than 5 orders, with their order count.',
        tables: ['customers', 'orders'],
        type: 'select',
        checks: [
            { label: 'Joins orders to customers', hint: 'Join orders to customers ON orders.customer_id = customers.id.', test: { kind: 'join', tables: ['customers', 'orders'] } },
            { label: 'Counts the orders', hint: 'Add a COUNT column.', test: { kind: 'select', aggregate: ['COUNT'], column: 'id', allowStar: true } },
            {
                label: 'One row per customer',
                hint: 'Add the customer under GROUP BY.',
                test: { kind: 'anyOf', of: [{ kind: 'groupBy', column: 'name' }, { kind: 'groupBy', column: 'id', table: 'customers' }, { kind: 'groupBy', column: 'customer_id' }] }
            },
            {
                label: 'Keeps groups with more than 5 orders',
                hint: 'A condition on a count goes in HAVING, not WHERE: COUNT(*) > 5.',
                test: { kind: 'having', aggregate: ['COUNT'], ops: ['>', '>='] }
            }
        ],
        hints: [
            'Start like "Orders per customer": join, COUNT, GROUP BY.',
            'WHERE runs before grouping, so it can\'t see the count yet.',
            'Add a HAVING condition: COUNT(o.id) > 5.'
        ],
        answer: 'SELECT c.name, COUNT(o.id) AS orders FROM customers AS c INNER JOIN orders AS o ON o.customer_id = c.id GROUP BY c.id, c.name HAVING COUNT(o.id) > 5',
        explain: 'WHERE filters rows before they are grouped; HAVING filters the groups after. A count only exists once rows are grouped, so the condition on it belongs in HAVING.'
    },
    {
        id: 'customers-without-orders',
        level: 'intermediate',
        topic: 'Joins',
        title: 'Customers who never ordered',
        goal: 'Find the customers who have never placed an order.',
        tables: ['customers', 'orders'],
        type: 'select',
        checks: [
            reads('customers'),
            {
                label: 'Looks for customers with no matching order',
                hint: 'Use NOT EXISTS with a subquery on orders, or LEFT JOIN orders and keep the rows where the order id IS NULL.',
                test: { kind: 'anyOf', of: [
                    { kind: 'subquery', ops: ['NOT EXISTS'] },
                    { kind: 'subquery', ops: ['NOT IN'], column: 'id' },
                    // LEFT JOIN orders … WHERE the order side IS NULL
                    { kind: 'allOf', of: [
                        { kind: 'join', tables: ['customers', 'orders'], types: ['LEFT JOIN', 'RIGHT JOIN'], keep: 'customers' },
                        { kind: 'anyOf', of: [
                            { kind: 'filter', column: 'id', table: 'orders', ops: ['IS NULL'] },
                            { kind: 'filter', column: 'customer_id', ops: ['IS NULL'] }
                        ] }
                    ] }
                ] }
            }
        ],
        hints: [
            'An INNER JOIN would drop exactly the customers you want: the ones with no order.',
            'One way: WHERE NOT EXISTS (SELECT 1 FROM orders AS o WHERE o.customer_id = c.id).',
            'Another: LEFT JOIN orders, then WHERE o.id IS NULL keeps the customers the join found nothing for.'
        ],
        answer: 'SELECT c.id, c.name FROM customers AS c WHERE NOT EXISTS (SELECT 1 FROM orders AS o WHERE o.customer_id = c.id)',
        explain: 'NOT EXISTS keeps a customer when the subquery finds no order for them. The LEFT JOIN version keeps every customer and fills the order columns with NULL when there is no match, so IS NULL picks those out. Avoid NOT IN on a column that can be NULL: one NULL makes it match nothing.'
    },
    {
        id: 'employees-and-managers',
        level: 'intermediate',
        topic: 'Joins',
        title: 'Employees and their managers',
        goal: 'List every employee\'s name next to their manager\'s name. Keep employees who have no manager.',
        tables: ['employees'],
        type: 'select',
        checks: [
            {
                label: 'Joins employees to itself, keeping every employee',
                hint: 'Join employees a second time with a different alias (m for manager), as a LEFT JOIN ON e.manager_id = m.id.',
                test: { kind: 'join', tables: ['employees', 'employees'], types: ['LEFT JOIN'] }
            },
            {
                label: 'Shows both names',
                hint: 'Add the name from each alias: e.name and m.name. Give them aliases so they can be told apart.',
                test: { kind: 'select', column: 'name', count: 2 }
            }
        ],
        hints: [
            'The manager is also an employee, so the same table is read twice with two aliases.',
            'An INNER JOIN drops the employees with no manager (the top of the chart).',
            'FROM employees AS e LEFT JOIN employees AS m ON e.manager_id = m.id.'
        ],
        answer: 'SELECT e.name AS employee, m.name AS manager FROM employees AS e LEFT JOIN employees AS m ON m.id = e.manager_id',
        explain: 'A self-join reads one table twice, and the aliases tell the two copies apart. LEFT JOIN keeps every employee; for the ones with no manager, m.name is NULL.'
    },
    {
        id: 'above-average-price',
        level: 'advanced',
        topic: 'Subqueries and CTEs',
        title: 'Priced above average',
        goal: 'List the products that cost more than the average price of all products.',
        tables: ['products'],
        type: 'select',
        checks: [
            reads('products'),
            {
                label: 'Compares the price with a subquery',
                hint: 'Add a WHERE condition on price with the operator > and a subquery as its value.',
                test: { kind: 'subquery', ops: ['>', '>='], column: 'price' }
            },
            {
                label: 'The subquery works out the average price',
                hint: 'Inside the subquery: SELECT AVG(price) FROM products.',
                test: { kind: 'select', aggregate: ['AVG'], column: 'price', in: 'sub' }
            }
        ],
        hints: [
            'WHERE price > AVG(price) isn\'t allowed: an aggregate can\'t go in WHERE.',
            'Work out the average in a subquery, which returns a single value.',
            'WHERE price > (SELECT AVG(price) FROM products).'
        ],
        answer: 'SELECT name, price FROM products WHERE price > (SELECT AVG(price) FROM products)',
        explain: 'The subquery runs once and gives one number, the average, which each product\'s price is compared with. Aggregates can\'t go in WHERE directly because WHERE runs before any grouping.'
    },
    {
        id: 'rank-in-department',
        level: 'advanced',
        topic: 'Window functions',
        title: 'Salary rank within each department',
        goal: 'Show each employee\'s name, department_id and salary, with their salary rank inside their department (1 = highest paid).',
        tables: ['employees'],
        type: 'select',
        checks: [
            reads('employees'),
            shows('salary', 'Shows the salary'),
            {
                label: 'Ranks with a window function',
                hint: 'Add a window function column: RANK, DENSE_RANK or ROW_NUMBER.',
                test: { kind: 'window', funcs: ['RANK', 'DENSE_RANK', 'ROW_NUMBER'] }
            },
            {
                label: 'Starts the ranking again for each department',
                hint: 'Add department_id under the window\'s PARTITION BY.',
                test: { kind: 'window', funcs: ['RANK', 'DENSE_RANK', 'ROW_NUMBER'], partitionBy: 'department_id' }
            },
            {
                label: 'Ranks by salary, highest first',
                hint: 'In the window\'s ORDER BY, add salary with DESC.',
                test: { kind: 'window', funcs: ['RANK', 'DENSE_RANK', 'ROW_NUMBER'], orderBy: 'salary', direction: 'DESC' }
            },
            {
                label: 'Keeps one row per employee',
                hint: 'Window functions don\'t need GROUP BY; remove it.',
                test: { kind: 'none', of: [{ kind: 'groupBy', column: 'department_id' }, { kind: 'groupBy', column: 'name' }] }
            }
        ],
        hints: [
            'Add a column and switch it to a window function.',
            'PARTITION BY department_id restarts the numbering for each department.',
            'ORDER BY salary DESC inside the window. RANK gives equal salaries the same rank.'
        ],
        answer: 'SELECT name, department_id, salary, RANK() OVER (PARTITION BY department_id ORDER BY salary DESC) AS salary_rank FROM employees',
        explain: 'A window function works out a value for each row from a group of related rows without folding them together, so every employee stays in the result. PARTITION BY sets the groups and the window\'s ORDER BY sets the ranking order.'
    },
    {
        id: 'big-spenders-cte',
        level: 'advanced',
        topic: 'Subqueries and CTEs',
        title: 'Big spenders, with a CTE',
        goal: 'Use a CTE to total each customer\'s orders, then list the customers whose total is over 1000, with their name and total.',
        tables: ['customers', 'orders'],
        type: 'select',
        checks: [
            { label: 'Defines a CTE the main query reads', hint: 'Add a CTE (for example spend), then use its name in the main query\'s FROM or JOIN.', test: { kind: 'cte', used: true } },
            { label: 'The CTE adds up the order totals', hint: 'In the CTE: SUM(total) from orders.', test: { kind: 'select', aggregate: ['SUM'], column: 'total', in: 'cte' } },
            { label: 'The CTE has one row per customer', hint: 'In the CTE, GROUP BY customer_id.', test: { kind: 'groupBy', column: 'customer_id', in: 'cte' } },
            { label: 'Joins in the customers for their names', hint: 'In the main query, join customers to the CTE ON customers.id = the CTE\'s customer_id.', test: { kind: 'reads', table: 'customers', in: 'main' } },
            {
                label: 'Keeps totals over 1000',
                hint: 'In the main query, WHERE the CTE\'s total column > 1000. (Or HAVING SUM(total) > 1000 inside the CTE.)',
                test: { kind: 'anyOf', of: [
                    { kind: 'filter', column: 'spent', ops: ['>', '>='] },
                    { kind: 'filter', column: 'total', ops: ['>', '>='] },
                    { kind: 'having', aggregate: ['SUM'], ops: ['>', '>='], in: 'cte' }
                ] }
            }
        ],
        hints: [
            'A CTE is a named query written first, which the main query reads like a table.',
            'CTE spend: SELECT customer_id, SUM(total) AS spent FROM orders GROUP BY customer_id.',
            'Main query: FROM spend AS s JOIN customers AS c ON c.id = s.customer_id WHERE s.spent > 1000.'
        ],
        answer: 'WITH spend AS (SELECT customer_id, SUM(total) AS spent FROM orders GROUP BY customer_id) SELECT c.name, s.spent FROM spend AS s INNER JOIN customers AS c ON c.id = s.customer_id WHERE s.spent > 1000',
        explain: 'The CTE does one job, totalling per customer, and gives the result a name. The main query then reads it like a table, so the filter on the total is an ordinary WHERE condition.'
    },
    {
        id: 'reporting-chain',
        level: 'advanced',
        topic: 'Subqueries and CTEs',
        title: 'Everyone under one manager',
        goal: 'List everyone who reports to employee 1, directly or through other managers, at any depth.',
        tables: ['employees'],
        type: 'select',
        checks: [
            { label: 'Uses a recursive CTE', hint: 'Add a CTE and tick Recursive.', test: { kind: 'cte', recursive: true, used: true } },
            {
                label: 'Starts from employee 1\'s direct reports',
                hint: 'The CTE\'s first part: employees WHERE manager_id = 1.',
                test: { kind: 'filter', column: 'manager_id', ops: ['='], values: ['1'], in: 'cte' }
            },
            {
                label: 'Repeats with UNION ALL',
                hint: 'Add a UNION ALL part to the CTE: it runs again on the rows just found.',
                test: { kind: 'setOp', ops: ['UNION ALL', 'UNION'], in: 'cte' }
            },
            {
                label: 'Each round finds the reports of the people just found',
                hint: 'In the UNION ALL part, join employees to the CTE itself ON employees.manager_id = the CTE\'s id.',
                test: { kind: 'reads', table: 'employees', in: 'cte' }
            }
        ],
        hints: [
            'One level of reports is a plain WHERE manager_id = 1. Any depth needs a recursive CTE.',
            'The first part gives the starting rows: the direct reports.',
            'The UNION ALL part reads employees joined to the CTE by name, so each round adds the next level down.'
        ],
        answer: 'WITH RECURSIVE team (id, name) AS (SELECT id, name FROM employees WHERE manager_id = 1 UNION ALL SELECT e.id, e.name FROM employees AS e INNER JOIN team AS t ON e.manager_id = t.id) SELECT id, name FROM team',
        explain: 'A recursive CTE starts with its first part, then runs the part after UNION ALL again and again on the rows the last round added, until a round adds nothing. If the data could loop, add a depth column and a limit on it (see the Org chart example).'
    },
    {
        id: 'raise-prices',
        level: 'beginner',
        topic: 'Changing data',
        title: 'Raise the price of books',
        goal: 'Raise the price of every product in the Books category by 10%.',
        tables: ['products'],
        type: 'update',
        checks: [
            { label: 'Is an UPDATE', hint: 'Switch the query type to UPDATE.', test: { kind: 'type', type: 'update' } },
            { label: 'Changes the products table', hint: 'Set the table to products.', test: { kind: 'target', table: 'products' } },
            { label: 'Sets the price from the old price', hint: 'SET price to the expression price * 1.1 (choose "column or expression").', test: { kind: 'assign', column: 'price', mentions: 'price' } },
            {
                label: 'Changes only the books',
                hint: 'Without WHERE every product would change. Add WHERE category = Books.',
                test: { kind: 'filter', column: 'category', ops: ['='], values: ['Books'] }
            }
        ],
        hints: [
            'UPDATE products, SET price = …, WHERE ….',
            'The new value refers to the old one: price * 1.1, written as an expression rather than a value.',
            'WHERE category = Books keeps the change to books only.'
        ],
        answer: "UPDATE products SET price = price * 1.1 WHERE category = 'Books'",
        explain: 'Each row\'s new price is worked out from its own old price. The WHERE condition is what keeps the other products unchanged; always check it before running an UPDATE.'
    },
    {
        id: 'delete-cancelled',
        level: 'intermediate',
        topic: 'Changing data',
        title: 'Remove old cancelled orders',
        goal: 'Delete the orders with status cancelled that were placed before 2025.',
        tables: ['orders'],
        type: 'delete',
        checks: [
            { label: 'Is a DELETE', hint: 'Switch the query type to DELETE.', test: { kind: 'type', type: 'delete' } },
            { label: 'Deletes from orders', hint: 'Set the table to orders.', test: { kind: 'target', table: 'orders' } },
            { label: 'Only cancelled orders', hint: 'Add WHERE status = cancelled.', test: { kind: 'filter', column: 'status', ops: ['='], values: ['cancelled'] } },
            {
                label: 'Only orders placed before 2025',
                hint: 'Add placed_at < 2025-01-01, joined with AND.',
                test: { kind: 'filter', column: 'placed_at', ops: ['<', '<='] }
            }
        ],
        hints: [
            'DELETE FROM orders WHERE ….',
            'Two conditions, both needed, so join them with AND.',
            'placed_at < 2025-01-01 means "before 2025".'
        ],
        answer: "DELETE FROM orders WHERE status = 'cancelled' AND placed_at < '2025-01-01'",
        explain: 'Both conditions must hold, so AND keeps the delete narrow. With OR it would also remove every order placed before 2025, cancelled or not. Before running a DELETE, run the same WHERE as a SELECT to see the rows it would remove.'
    }
];

/** The model answer as a workspace. */
export function answerWorkspace(exercise) {
    const result = importSql(exercise.answer, { dialect: 'generic' });
    if (!result.ok) throw new Error(`Exercise ${exercise.id}: ${/** @type {any} */ (result).message}`);
    const ws = createWorkspace(result.query.kind);
    ws[result.query.kind] = result.query;
    return ws;
}

/** The workspace an exercise starts from: an empty query of its type. */
export function startWorkspace(exercise) {
    return createWorkspace(exercise.type);
}

export const findExercise = (/** @type {string} */ id) => EXERCISES.find(e => e.id === id);
