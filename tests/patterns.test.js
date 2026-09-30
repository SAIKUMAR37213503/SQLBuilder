import { describe, expect, test } from 'vitest';
import { EXAMPLES, examplesFor } from '../src/examples.js';
import { generateSQL } from '../src/generator.js';
import { validateWorkspace } from '../src/validation.js';

const DIALECTS = ['generic', 'sqlserver', 'postgresql', 'mysql'];
const PATTERNS = ['latest-per-group', 'moving-average', 'gaps-and-islands', 'delete-duplicates'];
const build = (id) => EXAMPLES.find(e => e.id === id).build();

// The SQL of these patterns was also run against sample data in SQLite while
// they were written; the text is pinned here so a later change can't alter it.
describe('pattern library', () => {
    test('the patterns are listed in every dialect, under their topics', () => {
        for (const dialect of DIALECTS) {
            const ids = examplesFor(dialect).map(e => e.id);
            for (const id of PATTERNS) expect(ids, dialect).toContain(id);
        }
        expect(examplesFor('generic', 'Window functions').map(e => e.id))
            .toEqual(expect.arrayContaining(['latest-per-group', 'moving-average', 'gaps-and-islands']));
        expect(examplesFor('generic', 'Changing data').map(e => e.id)).toContain('delete-duplicates');
    });

    test.each(DIALECTS)('%s: no errors or warnings', (dialect) => {
        for (const id of PATTERNS) {
            const issues = validateWorkspace(build(id), { dialect }).filter(i => i.level === 'error' || i.level === 'warning');
            expect(issues.map(i => i.message), id).toEqual([]);
        }
    });

    test('latest row per group: newest first, id breaks ties, keep row 1', () => {
        expect(generateSQL(build('latest-per-group'), { dialect: 'generic', pretty: false })).toBe(
            'WITH numbered AS (SELECT id, customer_id, ordered_at, total, '
            + 'ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY ordered_at DESC, id DESC) AS rn FROM orders) '
            + 'SELECT id, customer_id, ordered_at, total FROM numbered WHERE rn = 1;');
    });

    test('moving average: daily totals, then the current row and the 6 before it', () => {
        expect(generateSQL(build('moving-average'), { dialect: 'generic', pretty: false })).toBe(
            'WITH daily AS (SELECT sale_date, SUM(amount) AS total FROM sales GROUP BY sale_date) '
            + 'SELECT sale_date, total, AVG(total) OVER (ORDER BY sale_date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS avg_7_days '
            + 'FROM daily ORDER BY sale_date;');
    });

    test('gaps and islands: group by number minus ROW_NUMBER', () => {
        expect(generateSQL(build('gaps-and-islands'), { dialect: 'generic', pretty: false })).toBe(
            'WITH numbered AS (SELECT invoice_no, ROW_NUMBER() OVER (ORDER BY invoice_no) AS rn FROM invoices) '
            + 'SELECT MIN(invoice_no) AS run_start, MAX(invoice_no) AS run_end, COUNT(*) AS invoices '
            + 'FROM numbered GROUP BY invoice_no - rn ORDER BY run_start;');
    });

    test('delete duplicates: keeps the lowest id per email, leaves rows without an email, and works in MySQL', () => {
        const expected = 'DELETE FROM contacts WHERE email IS NOT NULL AND id NOT IN ('
            + 'SELECT keep_id FROM (SELECT MIN(id) AS keep_id FROM contacts WHERE email IS NOT NULL GROUP BY email) AS keepers);';
        for (const dialect of DIALECTS) {
            // The same SQL everywhere: the derived table is what lets MySQL read the table it deletes from
            expect(generateSQL(build('delete-duplicates'), { dialect, pretty: false }), dialect).toBe(expected);
        }
    });
});
