// Short explanations of each builder section, shown by the info button next
// to its header. Plain text only (rendered with textContent). Dialect notes
// appear only where the dialects really differ, labelled with the dialect.

import { getDialect } from './dialects.js';

/**
 * @typedef {{ label: string, text: string }} HelpPart
 * @typedef {{
 *   title: string | ((dialect: any) => string),
 *   tagline: string,
 *   definition?: string,
 *   parts?: HelpPart[] | ((dialect: any) => HelpPart[]),
 *   operation: string,
 *   example?: string | ((dialect: any) => string),
 *   notes?: Record<string, string>
 * }} SectionHelpEntry
 */

/** @type {Record<string, SectionHelpEntry>} */
export const SECTION_HELP = Object.freeze({
    with: {
        title: 'WITH',
        tagline: 'Name a query to reuse',
        definition: 'Names a query, called a common table expression (CTE), that the main query can read like a table.',
        operation: 'SQL makes each named query available to the statement that follows it, and only to that statement. A recursive CTE repeats its second part on the rows the previous step produced, until no new rows appear.',
        example: 'WITH big_orders AS (SELECT * FROM orders WHERE total > 1000) SELECT customer_id FROM big_orders',
        notes: { sqlserver: 'A recursive CTE is written with plain WITH; the other databases write WITH RECURSIVE.' }
    },
    columns: {
        title: 'Columns',
        tagline: 'What each result row contains',
        definition: 'The values the query returns: columns, calculations, aggregates such as COUNT, or window functions.',
        operation: 'SQL works these out for every row left after FROM, WHERE, GROUP BY and HAVING, and returns them in this order. AS renames a result column; DISTINCT removes duplicate result rows.',
        example: 'SELECT name, salary * 12 AS yearly_salary'
    },
    from: {
        title: 'FROM',
        tagline: 'Where the rows come from',
        definition: 'The table, view or subquery the query reads.',
        operation: 'SQL reads the rows from this source first; joins, WHERE, grouping and the columns all work on them. An alias gives the source a short name to use in the rest of the query.',
        example: 'FROM employees AS e'
    },
    joins: {
        title: 'Joins',
        tagline: 'Combine rows from other tables',
        definition: 'Adds the columns of another table by pairing its rows with the rows you already have.',
        operation: 'SQL pairs rows where the ON condition is true. INNER keeps matched pairs only. LEFT also keeps unmatched rows from the left, with NULLs for the other table; RIGHT does the same for the right, FULL for both. CROSS pairs every row with every row.',
        example: 'LEFT JOIN orders AS o ON o.customer_id = c.id',
        notes: { mysql: 'No FULL JOIN; a LEFT JOIN and a RIGHT JOIN combined with UNION gives the same rows.' }
    },
    where: {
        title: 'WHERE',
        tagline: 'Filter rows',
        definition: 'Filters rows based on a condition.',
        operation: 'SQL evaluates the condition for each row and keeps only the rows where it is true; false or NULL results are dropped. It runs before grouping.',
        example: 'WHERE Salary > 50000'
    },
    grouping: {
        title: 'GROUP BY & HAVING',
        tagline: 'Summarize groups of rows',
        parts: [
            { label: 'GROUP BY', text: 'Creates groups of rows with the same values, so aggregates like COUNT or SUM give one result per group.' },
            { label: 'HAVING', text: 'Filters those groups after aggregation. WHERE filters rows before grouping.' }
        ],
        operation: 'SQL filters rows with WHERE, forms the groups, computes the aggregates, then keeps the groups that pass HAVING. Each result row is one group.',
        example: 'GROUP BY department HAVING COUNT(*) > 5',
        notes: { mysql: 'HAVING can also use a column alias from SELECT; the other databases need the expression itself.' }
    },
    sorting: {
        title: (d) => `ORDER BY, ${d.ui.limitLabel} & OFFSET`,
        tagline: 'Sort, limit and skip rows',
        parts: (d) => [
            { label: 'ORDER BY', text: 'Sorts the result rows, ascending (ASC, the default) or descending (DESC).' },
            { label: d.ui.limitLabel, text: 'Returns at most this many rows.' },
            { label: 'OFFSET', text: 'Skips this many rows first, for paging through results.' }
        ],
        operation: 'SQL sorts the rows last, then skips the offset and returns up to the limit. Without ORDER BY the order isn\'t guaranteed, so the rows you get can change.',
        example: (d) => (d.id === 'sqlserver'
            ? 'ORDER BY salary DESC OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY'
            : 'ORDER BY salary DESC LIMIT 10 OFFSET 20'),
        notes: {
            sqlserver: 'A limit alone is written SELECT TOP n. With an offset it becomes OFFSET … FETCH, which needs ORDER BY.',
            mysql: 'OFFSET needs a LIMIT, so an offset alone is written with a very large LIMIT.'
        }
    },
    setops: {
        title: 'UNION / INTERSECT / EXCEPT',
        tagline: 'Combine result sets',
        parts: [
            { label: 'UNION', text: 'Rows from either query, without duplicates. UNION ALL keeps duplicates.' },
            { label: 'INTERSECT', text: 'Only rows that both queries return.' },
            { label: 'EXCEPT', text: 'Rows from the first query that the second doesn\'t return.' }
        ],
        operation: 'SQL runs each SELECT, then combines their result rows. Each must return the same number of columns, with compatible types; the column names come from the first.',
        example: 'SELECT city FROM customers UNION SELECT city FROM suppliers',
        notes: {
            sqlserver: 'No INTERSECT ALL or EXCEPT ALL.',
            mysql: 'INTERSECT and EXCEPT need MySQL 8.0.31 or later.'
        }
    },
    insert: {
        title: 'INSERT',
        tagline: 'Add new rows',
        definition: 'Adds new rows to a table.',
        operation: 'SQL writes one row for each set of VALUES, or for each row the SELECT returns. Columns you leave out get their default value, usually NULL.',
        example: 'INSERT INTO employees (name, salary) VALUES (\'Ana\', 52000)',
        notes: {
            postgresql: 'ON CONFLICT skips or updates a row that would break a unique key (an upsert).',
            mysql: 'ON DUPLICATE KEY UPDATE updates the existing row when a unique key would be broken (an upsert).',
            sqlserver: 'Upserts use MERGE, which the builder doesn\'t write yet.'
        }
    },
    update: {
        title: 'UPDATE',
        tagline: 'Change existing rows',
        definition: 'Changes values in rows that are already in a table.',
        operation: 'SQL finds the rows that match WHERE and sets each SET column to its new value. Without WHERE, every row in the table changes.',
        example: 'UPDATE employees SET salary = salary * 1.05 WHERE department = \'Sales\''
    },
    delete: {
        title: 'DELETE',
        tagline: 'Remove rows',
        definition: 'Removes rows from a table.',
        operation: 'SQL finds the rows that match WHERE and deletes them. Without WHERE, every row is deleted; the table itself stays.',
        example: 'DELETE FROM orders WHERE status = \'cancelled\''
    }
});

/**
 * One section's help, resolved for a dialect, or null for an unknown key.
 * @param {string} key
 * @param {string} [dialectId]
 * @returns {{ key: string, title: string, tagline: string, definition: string | null, parts: HelpPart[],
 *   operation: string, example: string | null, note: string | null } | null}
 */
export function sectionHelp(key, dialectId) {
    if (!Object.hasOwn(SECTION_HELP, key)) return null;
    const entry = SECTION_HELP[key];
    const d = getDialect(dialectId);
    const resolve = (/** @type {any} */ value) => (typeof value === 'function' ? value(d) : value);
    return {
        key,
        title: resolve(entry.title),
        tagline: entry.tagline,
        definition: entry.definition ?? null,
        parts: resolve(entry.parts) ?? [],
        operation: entry.operation,
        example: resolve(entry.example) ?? null,
        note: entry.notes && Object.hasOwn(entry.notes, d.id) ? entry.notes[d.id] : null
    };
}
