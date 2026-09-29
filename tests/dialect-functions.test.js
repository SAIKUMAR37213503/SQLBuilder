import { describe, expect, test } from 'vitest';
import { DIALECT_SYNTAX, findDialectSyntax, dialectSyntaxIssues } from '../src/dialect-functions.js';
import { lex, significant } from '../src/sql-lexer.js';
import { getDialect } from '../src/dialects.js';
import { validateQuery, validateWorkspace } from '../src/validation.js';
import { createSelect, createColumn, createTableSource, createCondition, createRawCondition, createGroup, createInsert, createUpdate } from '../src/model.js';
import { EXAMPLES } from '../src/examples.js';

const ALL = ['generic', 'sqlserver', 'postgresql', 'mysql'];

const tokens = (text, dialect = 'generic') => significant(lex(text, getDialect(dialect).syntax));
const found = (text, dialect) => findDialectSyntax(tokens(text, dialect)).map(f => f.entry.name);
const issues = (text, dialect) => dialectSyntaxIssues(tokens(text, dialect), getDialect(dialect));

/** A sample use of each entry, as it would be typed */
function sample(entry) {
    if (entry.kind === 'call') return `${entry.name.toLowerCase()}(a, b)`;
    if (entry.kind === 'word') return `a ${entry.name} b`;
    if (entry.kind === 'operator') return `a ${entry.name} b`;
    return entry.name === '[' ? '[order].id' : '`order`.id';
}

describe('the syntax table', () => {
    test('entries are well formed', () => {
        const names = new Set();
        for (const entry of DIALECT_SYNTAX) {
            expect(['call', 'word', 'operator', 'quote'], entry.name).toContain(entry.kind);
            expect(names.has(entry.name), entry.name).toBe(false);
            names.add(entry.name);
            for (const id of [...entry.in, ...Object.keys(entry.differs ?? {}), ...Object.keys(entry.since ?? {})]) expect(ALL, entry.name).toContain(id);
            for (const id of Object.keys(entry.use ?? {})) expect([...ALL, '*'], entry.name).toContain(id);
            // A replacement is never suggested for a dialect where the entry works
            for (const id of entry.in) expect(entry.use?.[id], `${entry.name} in ${id}`).toBeUndefined();
            if (entry.in.length === 0) expect(entry.origin, entry.name).toBeTruthy();
        }
    });

    // Every entry, in every dialect: silent where it works, flagged elsewhere
    test.each(ALL)('each entry is checked in %s', (dialect) => {
        for (const entry of DIALECT_SYNTAX) {
            const text = sample(entry);
            expect(found(text, dialect), text).toEqual([entry.name]);
            const result = issues(text, dialect);
            const differs = entry.differs?.[dialect];
            if (differs && (differs.args === undefined || differs.args === 2)) {
                expect(result, text).toEqual([{ level: differs.level || 'warning', message: expect.stringContaining(differs.note) }]);
            } else if (entry.in.includes(dialect) || differs) {
                // Only a version note, where one applies
                expect(result.every(i => i.level === 'info' && /needs .* or later/.test(i.message)), text).toBe(true);
                expect(result.length, text).toBe(entry.since?.[dialect] ? 1 : 0);
            } else {
                expect(result, text).toEqual([{ level: dialect === 'generic' ? 'info' : 'warning', message: expect.any(String) }]);
                const use = entry.use?.[dialect] ?? entry.use?.['*'];
                if (use) expect(result[0].message, text).toContain(use);
            }
        }
    });
});

describe('messages', () => {
    test('name the dialect, where the syntax comes from and the replacement', () => {
        expect(issues('GETDATE()', 'postgresql')).toEqual([{ level: 'warning', message: 'GETDATE() isn\'t available in PostgreSQL; it\'s SQL Server syntax. Use CURRENT_TIMESTAMP instead.' }]);
        expect(issues('NOW()', 'sqlserver')).toEqual([{ level: 'warning', message: 'NOW() isn\'t available in SQL Server; it\'s PostgreSQL and MySQL syntax. Use CURRENT_TIMESTAMP instead.' }]);
        expect(issues('NVL(a, 0)', 'generic')).toEqual([{ level: 'info', message: 'NVL() is Oracle syntax, not standard SQL. COALESCE(value, fallback) works in more databases.' }]);
        expect(issues('x::int', 'mysql')[0].message).toBe(':: (cast) isn\'t available in MySQL; it\'s PostgreSQL syntax. Use CAST(value AS type) instead.');
        expect(issues('[order].id', 'mysql')[0].message).toBe('[name] quoting isn\'t available in MySQL; it\'s SQL Server syntax. Use `name` instead.');
        expect(issues('EXTRACT(YEAR FROM d)', 'sqlserver')[0].message).toBe('EXTRACT() isn\'t available in SQL Server; it\'s standard SQL syntax. Use DATEPART(year, date) instead.');
    });

    test('same name, different meaning, told apart by the arguments', () => {
        expect(issues('ISNULL(a)', 'mysql')).toEqual([]);
        expect(issues('ISNULL(a, 0)', 'mysql')).toEqual([{ level: 'warning', message: 'In MySQL, ISNULL(x) takes one value and returns 1 or 0. Use COALESCE(value, fallback) instead.' }]);
        expect(issues('DATEDIFF(a, b)', 'mysql')).toEqual([]);
        expect(issues('DATEDIFF(day, a, b)', 'mysql')[0].message).toMatch(/^MySQL's DATEDIFF takes two dates/);
        expect(issues('DATEDIFF(day, a, b)', 'sqlserver')).toEqual([]);
        expect(issues('DATEDIFF(a, b)', 'sqlserver')[0].message).toBe('SQL Server\'s DATEDIFF needs the unit first. Write DATEDIFF(day, start_date, end_date).');
        expect(issues("a || 'x'", 'mysql')).toEqual([{ level: 'info', message: 'In MySQL, || means OR unless the PIPES_AS_CONCAT mode is on. Write OR for “or”, or CONCAT(a, b) to join text.' }]);
    });

    test('version notes', () => {
        expect(issues("STRING_AGG(name, ', ')", 'sqlserver')).toEqual([{ level: 'info', message: 'STRING_AGG() needs SQL Server 2017 or later.' }]);
        expect(issues("a || 'x'", 'sqlserver')).toEqual([{ level: 'info', message: '|| (join text) needs SQL Server 2025 or later. CONCAT(a, b) works in every version.' }]);
        expect(issues('gen_random_uuid()', 'postgresql')).toEqual([{ level: 'info', message: 'GEN_RANDOM_UUID() needs PostgreSQL 13 or later.' }]);
    });
});

describe('false-positive guards', () => {
    test.each(ALL)('strings, comments, quoted names and qualified names are never matched in %s', (dialect) => {
        expect(found("'GETDATE()' || ''", dialect).filter(n => n !== '||')).toEqual([]);
        expect(found('a -- NOW()\n', dialect)).toEqual([]);
        expect(found('a /* IFNULL(x, 1) */', dialect)).toEqual([]);
        expect(found('"NOW"', dialect)).toEqual([]);
        expect(found('dbo.NOW()', dialect)).toEqual([]);
        expect(found('now_utc + len', dialect)).toEqual([]);
        expect(found('getdate', dialect)).toEqual([]);
        expect(found('tags[1]', dialect)).toEqual([]);
        expect(found('geography::Point(1, 2, 4326)', dialect)).toEqual([]);
    });

    test('each entry is reported once per piece of text, in order of use', () => {
        expect(found('NOW() - NOW() + IFNULL(a, GETDATE())', 'generic')).toEqual(['NOW', 'IFNULL', 'GETDATE']);
    });

    test('function names are matched in any case', () => {
        expect(found('isnull(a, b) + IsNull(c, d)', 'postgresql')).toEqual(['ISNULL']);
    });
});

describe('in the validator', () => {
    const select = (overrides) => createSelect({ columns: [createColumn('id')], from: createTableSource('orders'), ...overrides });

    test.each(ALL)('typed SQL in columns, conditions, custom SQL, INSERT values and SET values is checked in %s', (dialect) => {
        const where = createGroup('AND', [
            createCondition({ left: 'created_at', op: '<', valueType: 'column', value: 'GETDATE()' }),
            createRawCondition('name ILIKE \'a%\'')
        ]);
        const q = select({ columns: [createColumn('IFNULL(total, 0)', { alias: 'total' })], where });
        const paths = validateQuery(q, { dialect }).filter(i => i.category === 'dialect').map(i => i.path);
        const expected = {
            generic: ['columns.0.expr', 'where.items.0.value', 'where.items.1.sql'],
            sqlserver: ['columns.0.expr', 'where.items.1.sql'],
            postgresql: ['columns.0.expr', 'where.items.0.value'],
            mysql: ['where.items.0.value', 'where.items.1.sql']
        }[dialect];
        expect(paths).toEqual(expected);

        const insert = { ...createInsert(), table: 'log', columns: 'at', rows: [{ values: 'NOW()' }] };
        expect(validateQuery(insert, { dialect }).some(i => i.message.startsWith('NOW()'))).toBe(dialect === 'generic' || dialect === 'sqlserver');
        const update = { ...createUpdate(), table: 'log', set: [{ column: 'at', valueType: 'column', value: 'GETDATE()' }], where: createGroup('AND', [createCondition({ left: 'id', value: '1' })]) };
        expect(validateQuery(update, { dialect }).some(i => i.message.startsWith('GETDATE()'))).toBe(dialect !== 'sqlserver');
    });

    test('literal values are text, not SQL, so they are not checked', () => {
        const q = select({ where: createGroup('AND', [createCondition({ left: 'note', value: 'NOW()' })]) });
        expect(validateQuery(q, { dialect: 'sqlserver' }).filter(i => i.category === 'dialect')).toEqual([]);
    });

    test('never blocks generation', () => {
        for (const dialect of ALL) {
            const q = select({ columns: [createColumn('GETDATE()', { alias: 'a' }), createColumn('NOW()', { alias: 'b' }), createColumn('x::int', { alias: 'c' })] });
            expect(validateQuery(q, { dialect }).some(i => i.level === 'error'), dialect).toBe(false);
        }
    });

    test('no example gains a dialect message', () => {
        for (const example of EXAMPLES) {
            for (const dialect of example.dialects ?? ALL) {
                const messages = validateWorkspace(example.build(), { dialect }).map(i => i.message);
                expect(messages.filter(m => /syntax, not standard SQL|isn't available in/.test(m)), `${example.id}/${dialect}`).toEqual([]);
            }
        }
    });
});
