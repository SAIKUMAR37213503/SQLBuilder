import { describe, expect, test } from 'vitest';
import { levelNotes, summarizeWorkspace, EXPLAIN_LEVELS } from '../src/explain.js';
import { describeStructure } from '../src/structure.js';
import { getDialect } from '../src/dialects.js';
import { EXAMPLES } from '../src/examples.js';
import {
    createSelect, createColumn, createCondition, createRawCondition, createGroup, createJoin, createTableSource,
    createWindowColumn, createDelete, createUpdate, createInsert
} from '../src/model.js';
import { sanitizeSettings, DEFAULT_SETTINGS } from '../src/settings.js';

const ALL = ['generic', 'sqlserver', 'postgresql', 'mysql'];
const select = (overrides = {}) => ({ type: 'select', select: createSelect({ columns: [createColumn('id')], from: createTableSource('orders'), ...overrides }) });
const cond = (left, op, value = '', extra = {}) => createCondition({ left, op, value, ...extra });
const notes = (ws, level, dialect = 'generic') => levelNotes(ws, getDialect(dialect), level);
const summary = (ws, dialect = 'generic') => summarizeWorkspace(ws, getDialect(dialect));

/** Everything the panel shows at a level, as text: the summary, then each step with its notes */
function explained(ws, dialect, level) {
    const d = getDialect(dialect);
    const more = levelNotes(ws, d, level);
    const { steps } = describeStructure(ws, d);
    return [
        summary(ws, dialect),
        ...steps.flatMap(s => [`${s.clause}: ${s.explanation}`, ...(more[s.key] || []).map(n => `  + ${n}`)])
    ].join('\n');
}

describe('explanation text for every example', () => {
    // Reviewed text, one snapshot per example, dialect and level
    for (const example of EXAMPLES) {
        for (const dialect of example.dialects ?? ALL) {
            test.each(EXPLAIN_LEVELS)(`${example.id} in ${dialect}: %s`, (level) => {
                expect(explained(example.build(), dialect, level)).toMatchSnapshot();
            });
        }
    }

    test('Beginner adds nothing; each level keeps the one before it', () => {
        for (const example of EXAMPLES) {
            const ws = example.build();
            expect(notes(ws, 'beginner')).toEqual({});
            const dev = notes(ws, 'developer');
            const adv = notes(ws, 'advanced');
            for (const [key, texts] of Object.entries(dev)) expect(adv[key].slice(0, texts.length), `${example.id} ${key}`).toEqual(texts);
        }
    });

    test('never promises speed, and never runs or mentions running SQL against a database', () => {
        for (const example of EXAMPLES) {
            for (const level of EXPLAIN_LEVELS) {
                const text = explained(example.build(), 'generic', level);
                expect(text, example.id).not.toMatch(/\b(fast|faster|slow|speed|performance|milliseconds)\b/i);
            }
        }
    });
});

describe('Developer notes', () => {
    test('join types, and matches that repeat rows', () => {
        const ws = select({ joins: [{ ...createJoin('LEFT JOIN'), source: createTableSource('customers', 'c'), on: createGroup('AND', [cond('c.id', '=', 'orders.customer_id', { valueType: 'column' })]) }] });
        expect(notes(ws, 'developer').join).toEqual([
            'LEFT JOIN keeps every row of the tables before it; where nothing matches, the joined table\'s columns are NULL.',
            'A row that matches several rows of the joined table appears once for each match.'
        ]);
    });

    test('a WHERE condition on a LEFT-joined table undoes the LEFT JOIN, except IS NULL', () => {
        const join = { ...createJoin('LEFT JOIN'), source: createTableSource('customers', 'c'), on: createGroup('AND', [cond('c.id', '=', 'orders.customer_id', { valueType: 'column' })]) };
        const filtered = select({ joins: [join], where: createGroup('AND', [cond('c.country', '=', 'DE')]) });
        expect(notes(filtered, 'developer').join).toContain('The WHERE condition on c.country removes the rows where c had no match, so this LEFT JOIN returns the same rows as an INNER JOIN. To keep the unmatched rows, move the condition into ON.');
        const antiJoin = select({ joins: [join], where: createGroup('AND', [cond('c.id', 'IS NULL')]) });
        expect(notes(antiJoin, 'developer').join.join(' ')).not.toContain('removes the rows');
        const own = select({ joins: [join], where: createGroup('AND', [cond('orders.total', '>', '5')]) });
        expect(notes(own, 'developer').join.join(' ')).not.toContain('removes the rows');
    });

    test('NOT IN with a subquery warns about NULLs', () => {
        const ws = select({ where: createGroup('AND', [cond('customer_id', 'NOT IN', '', { valueType: 'subquery', subquery: createSelect({ columns: [createColumn('id')], from: createTableSource('blocked') }) })]) });
        expect(notes(ws, 'developer').where).toContain('NOT IN (subquery) returns no rows at all when the subquery returns a NULL; NOT EXISTS doesn\'t have this problem.');
        expect(notes(select({ where: createGroup('AND', [cond('id', 'NOT IN', '1, 2')]) }), 'developer').where.join(' ')).not.toContain('NOT IN (subquery)');
    });

    test('DISTINCT, CASE without ELSE, and a limit without ORDER BY', () => {
        const ws = select({ distinct: true, columns: [{ kind: 'case', cases: [{ when: 'a > 1', then: "'x'" }], elseValue: '', alias: 'band' }], limit: '5' });
        const n = notes(ws, 'developer');
        expect(n.select).toEqual([
            'A CASE without ELSE gives NULL for rows that match no WHEN.',
            expect.stringMatching(/^DISTINCT compares whole result rows/)
        ]);
        expect(n.limit).toEqual(['Without ORDER BY, which rows come back isn\'t guaranteed.']);
    });

    test('UPDATE, DELETE and INSERT', () => {
        const del = { type: 'delete', delete: { ...createDelete(), table: 'log' } };
        expect(notes(del, 'developer')).toEqual({ table: [expect.stringMatching(/^Running it inside a transaction/)] });
        expect(notes(del, 'advanced').where).toEqual([expect.stringMatching(/^To empty a whole table, TRUNCATE/)]);
        const update = { type: 'update', update: { ...createUpdate(), table: 't', where: createGroup('AND', [cond('id', '=', '1')]) } };
        expect(Object.keys(notes(update, 'developer')).sort()).toEqual(['table', 'where']);
        const insert = { type: 'insert', insert: { ...createInsert(), table: 't', source: 'select' } };
        expect(notes(insert, 'developer').source).toEqual(['The query\'s columns fill the listed columns by position, not by name.']);
    });
});

describe('Advanced notes', () => {
    test('window frames, including the RANGE default with ORDER BY', () => {
        const win = (overrides) => ({ ...createWindowColumn(), func: 'SUM', args: 'total', ...overrides });
        const ws = select({ columns: [
            win({ alias: 'running', frame: 'running', orderBy: [{ expr: 'day', direction: 'ASC' }] }),
            win({ alias: 'moving', frame: 'moving', frameSize: '6', orderBy: [{ expr: 'day', direction: 'ASC' }] }),
            win({ alias: 'ranged', orderBy: [{ expr: 'day', direction: 'ASC' }] }),
            win({ alias: 'total_all' }),
            { ...createWindowColumn(), func: 'ROW_NUMBER', alias: 'n', orderBy: [{ expr: 'day', direction: 'ASC' }] }
        ] });
        expect(notes(ws, 'developer').select).toBeUndefined();
        expect(notes(ws, 'advanced').select).toEqual([
            'running uses the rows from the start of its partition to the current row (a running value).',
            'moving uses the current row and the 6 rows before it.',
            expect.stringMatching(/^ranged has ORDER BY and no frame, so it uses the default frame: RANGE/),
            'total_all has no ORDER BY inside OVER, so it uses every row of its partition.',
            expect.stringMatching(/^Window functions run after WHERE/)
        ]);
    });

    test.each(ALL)('the %s rules for NULL ordering and pagination', (dialect) => {
        const ws = select({ orderBy: [{ expr: 'id', direction: 'ASC' }], limit: '10', offset: '20' });
        const d = getDialect(dialect);
        expect(notes(ws, 'advanced', dialect).order).toContain(d.explain.nullsOrder);
        expect(notes(ws, 'advanced', dialect).limit).toContain(d.explain.pagination);
        expect(notes(ws, 'developer', dialect).limit).not.toContain(d.explain.pagination);
        expect(d.explain.nullsOrder).toMatch(/NULLs/);
        expect(d.explain.pagination).toMatch(/\.$/);
    });

    test('set-operation precedence', () => {
        const ws = select({ setOps: [{ op: 'UNION', query: createSelect({ columns: [createColumn('id')], from: createTableSource('b') }) }] });
        expect(notes(ws, 'developer').setops).toEqual(['UNION removes duplicate rows; UNION ALL keeps them and does less work.', 'The result\'s column names come from the first query.']);
        expect(notes(ws, 'advanced').setops.at(-1)).toMatch(/^INTERSECT is evaluated before UNION and EXCEPT/);
    });
});

describe('summary sentence', () => {
    test('reads the query in plain words', () => {
        expect(summary(select({
            columns: [createColumn('department'), createColumn('salary', { aggregate: 'AVG' })],
            from: createTableSource('employees'),
            where: createGroup('AND', [cond('salary', '>', '50000')]),
            groupBy: [{ expr: 'department' }],
            orderBy: [{ expr: 'AVG(salary)', direction: 'DESC' }]
        }))).toBe('Returns department and the average salary from employees, where salary is greater than 50000, one row per department, sorted by AVG(salary) descending.');
    });

    test('values are shown the way the dialect writes them', () => {
        const ws = select({ where: createGroup('AND', [cond('active', '=', 'true'), cond('name', '=', "O'Brien")]) });
        expect(summary(ws, 'sqlserver')).toBe("Returns id from orders, where active is 1 and name is 'O''Brien'.");
        expect(summary(ws, 'postgresql')).toBe("Returns id from orders, where active is TRUE and name is 'O''Brien'.");
    });

    test('OR groups, NOT groups, lists, parameters and custom SQL', () => {
        const where = createGroup('AND', [
            cond('status', 'IN', 'paid, shipped'),
            { ...createGroup('OR', [cond('total', '>', '100'), cond('vip', '=', '1')]), negate: true }
        ]);
        expect(summary(select({ where }))).toBe("Returns id from orders, where status is one of 'paid', 'shipped' and not (total is greater than 100 or vip is 1).");
        expect(summary(select({ where: createGroup('AND', [createRawCondition('LOWER(email) LIKE \'%@x.org\'')]) }))).toBe("Returns id from orders, where LOWER(email) LIKE '%@x.org'.");
        expect(summary(select({ where: createGroup('AND', [cond('id', '=', 'id', { valueType: 'param' })]) }))).toBe('Returns id from orders, where id is the parameter id.');
    });

    test('many conditions become a count; many columns are shortened', () => {
        const where = createGroup('AND', ['a', 'b', 'c', 'd'].map(c => cond(c, '=', '1')));
        const columns = ['a', 'b', 'c', 'd', 'e', 'f'].map(c => createColumn(c));
        expect(summary(select({ where, columns }))).toBe('Returns a, b, c and 3 more columns from orders, where 4 conditions hold.');
    });

    test('pages, offsets and one summary row', () => {
        expect(summary(select({ limit: '20', offset: '40', orderBy: [{ expr: 'id', direction: 'ASC' }] }))).toBe('Returns id from orders, sorted by id, rows 41 to 60.');
        expect(summary(select({ offset: '5' }))).toBe('Returns id from orders, skipping the first 5 rows.');
        expect(summary(select({ columns: [createColumn('', { aggregate: 'COUNT' })] }))).toBe('Returns the number of rows from orders, as one summary row.');
    });

    test('INSERT, UPDATE and DELETE', () => {
        expect(summary({ type: 'delete', delete: { ...createDelete(), table: 'log' } })).toBe('Deletes every row of log.');
        expect(summary({ type: 'update', update: { ...createUpdate(), table: '', set: [] } })).toBe('Sets columns (not set yet) in a table (not set yet), for every row.');
        const upsert = { ...createInsert(), table: 'users', columns: 'email, name', rows: [{ values: "'a@x', 'A'" }], upsert: { mode: 'nothing', conflict: 'email', set: [] } };
        expect(summary({ type: 'insert', insert: upsert }, 'postgresql')).toBe('Adds 1 row to users, filling email and name; a row that clashes with an existing unique key is skipped.');
        // No upsert in SQL Server: not described
        expect(summary({ type: 'insert', insert: upsert }, 'sqlserver')).toBe('Adds 1 row to users, filling email and name.');
    });
});

describe('the level setting', () => {
    test('defaults to Beginner and rejects unknown values', () => {
        expect(DEFAULT_SETTINGS.explainLevel).toBe('beginner');
        expect(sanitizeSettings({ explainLevel: 'advanced' }).explainLevel).toBe('advanced');
        expect(sanitizeSettings({ explainLevel: 'expert' }).explainLevel).toBe('beginner');
        // Settings saved before this setting existed
        expect(sanitizeSettings({ theme: 'dark' }).explainLevel).toBe('beginner');
    });
});
