import { describe, expect, test } from 'vitest';
import { generateSQL, generateQuery } from '../src/generator.js';
import { EXAMPLES, formatSample } from '../src/examples.js';
import { compareSql } from '../src/roundtrip.js';
import { importSql, previewSqlImport } from '../src/sql-import.js';
import { compareDialects } from '../src/dialect-compare.js';
import { getDialect } from '../src/dialects.js';
import {
    createWorkspace, createColumn, createCondition, createGroup, createTableSource, createCte, createSelect,
    createGroupByItem, createRawCondition
} from '../src/model.js';
import {
    sanitizeSettings, formatOptions, DEFAULT_SETTINGS, FORMAT_SETTINGS,
    KEYWORD_CASES, INDENT_STYLES, COMMA_POSITIONS
} from '../src/settings.js';

const DIALECTS = ['generic', 'sqlserver', 'postgresql', 'mysql'];
const DEFAULT_FORMAT = { keywordCase: 'upper', indentStyle: '4', commaPosition: 'trailing', expandLists: false };

// Every combination of the format options
const FORMATS = KEYWORD_CASES.flatMap(keywordCase => INDENT_STYLES.flatMap(indentStyle =>
    COMMA_POSITIONS.flatMap(commaPosition => [false, true].map(expandLists =>
        ({ keywordCase, indentStyle, commaPosition, expandLists })))));

// Every example in every dialect it is listed for
const CASES = EXAMPLES.flatMap(example => (example.dialects || DIALECTS).map(dialect => ({ example, dialect })));

const sql = (workspace, options = {}) => generateSQL(workspace, { dialect: 'postgresql', ...options });

function select(fill) {
    const ws = createWorkspace('select');
    fill(ws.select);
    return ws;
}

describe('default format', () => {
    test('there are 24 combinations and the settings default to what earlier versions wrote', () => {
        expect(FORMATS).toHaveLength(24);
        expect(formatOptions(DEFAULT_SETTINGS)).toEqual(DEFAULT_FORMAT);
        expect(FORMAT_SETTINGS).toEqual(['keywordCase', 'indentStyle', 'commaPosition', 'expandLists']);
    });

    test('the default options write exactly what no options write, for every example', () => {
        for (const { example, dialect } of CASES) {
            for (const quoteIdentifiers of [false, true]) {
                for (const pretty of [true, false]) {
                    const options = { dialect, quoteIdentifiers, pretty };
                    expect(generateSQL(example.build(), { ...options, ...DEFAULT_FORMAT }), example.id)
                        .toBe(generateSQL(example.build(), options));
                }
            }
        }
    });

    test('unknown option values fall back to the defaults', () => {
        const ws = EXAMPLES.find(e => e.id === 'cte').build();
        expect(sql(ws, { keywordCase: 'shout', indentStyle: '3', commaPosition: 'middle', expandLists: 'yes' })).toBe(sql(ws));
    });
});

describe('every format keeps the SQL the same', () => {
    test('each combination writes the same tokens as the default for every example (ignoring keyword case and layout)', () => {
        for (const { example, dialect } of CASES) {
            const syntax = getDialect(dialect).syntax;
            const plain = generateSQL(example.build(), { dialect });
            for (const format of FORMATS) {
                const formatted = generateSQL(example.build(), { dialect, ...format });
                expect(compareSql(plain, formatted, syntax), `${example.id} ${dialect} ${JSON.stringify(format)}`)
                    .toEqual({ same: true, total: 0, differences: [] });
            }
        }
    });

    test('one-line SQL ignores the layout options; only keyword case changes it', () => {
        for (const { example, dialect } of CASES) {
            for (const format of FORMATS) {
                const oneLine = generateSQL(example.build(), { dialect, pretty: false, ...format });
                const expected = generateSQL(example.build(), { dialect, pretty: false, keywordCase: format.keywordCase });
                expect(oneLine, example.id).toBe(expected);
            }
        }
    });

    test('lowercase keywords are the default SQL with only letter case changed', () => {
        for (const { example, dialect } of CASES) {
            const upper = generateSQL(example.build(), { dialect });
            const lower = generateSQL(example.build(), { dialect, keywordCase: 'lower' });
            expect(lower.toUpperCase(), example.id).toBe(upper.toUpperCase());
            expect(lower.length).toBe(upper.length);
        }
    });

    test('formatted SQL imports back into the same query, in every dialect and statement type', () => {
        for (const { example, dialect } of CASES) {
            const ws = example.build();
            const expected = generateSQL(ws, { dialect });
            for (const format of FORMATS) {
                const text = generateSQL(ws, { dialect, ...format });
                const result = importSql(text, { dialect });
                if (!result.ok) throw new Error(`${example.id} ${dialect} ${JSON.stringify(format)}: ${result.message}`);
                expect(generateQuery(result.query, { dialect }), `${example.id} ${dialect} ${JSON.stringify(format)}`).toBe(expected);
            }
        }
    });
});

describe('keyword case', () => {
    test('lowercases the words the builder writes', () => {
        const ws = select(q => {
            q.distinct = true;
            q.columns = [createColumn('department'), createColumn('salary', { aggregate: 'AVG', alias: 'avg_pay' })];
            q.from = createTableSource('employees', 'e');
            q.where = createGroup('AND', [
                createCondition({ left: 'manager_id', op: 'IS NULL' }),
                createCondition({ left: 'active', op: '=', value: 'true' })
            ]);
            q.groupBy = [createGroupByItem('department')];
            q.orderBy = [{ expr: 'avg_pay', direction: 'DESC' }];
            q.limit = '5';
        });
        expect(sql(ws, { keywordCase: 'lower' })).toBe([
            'select distinct',
            '    department,',
            '    avg(salary) as avg_pay',
            'from employees as e',
            'where manager_id is null',
            '    and active = true',
            'group by department',
            'order by avg_pay desc',
            'limit 5;'
        ].join('\n'));
    });

    test('never changes text typed into a field: names, expressions, values, custom SQL or parameters', () => {
        const ws = select(q => {
            q.columns = [createColumn('UPPER(Name)', { alias: 'Shout' }), createColumn('CURRENT_DATE')];
            q.from = createTableSource('Orders', 'O');
            q.where = createGroup('AND', [
                createCondition({ left: 'Status', op: '=', value: 'OPEN' }),
                createRawCondition('Region IN (SELECT Code FROM Regions WHERE Active = TRUE)'),
                createCondition({ left: 'Owner', op: '=', value: 'UserId', valueType: 'param' })
            ]);
        });
        const lower = sql(ws, { keywordCase: 'lower', dialect: 'sqlserver' });
        expect(lower).toContain('UPPER(Name) as Shout');
        expect(lower).toContain('CURRENT_DATE');
        expect(lower).toContain('from Orders as O');
        expect(lower).toContain("where Status = 'OPEN'");
        expect(lower).toContain('and Region IN (SELECT Code FROM Regions WHERE Active = TRUE)');
        expect(lower).toContain('and Owner = @UserId');
    });

    test('covers dialect words: TOP, OFFSET … FETCH, ORDER BY (SELECT NULL), booleans and upserts', () => {
        const top = select(q => {
            q.columns = [createColumn('id')];
            q.from = createTableSource('t');
            q.limit = '10';
        });
        expect(sql(top, { dialect: 'sqlserver', keywordCase: 'lower', pretty: false })).toBe('select top 10 id from t;');

        const paged = select(q => {
            q.columns = [createColumn('id')];
            q.from = createTableSource('t');
            q.limit = '10';
            q.offset = '20';
        });
        expect(sql(paged, { dialect: 'sqlserver', keywordCase: 'lower', pretty: false }))
            .toBe('select id from t order by (select null) offset 20 rows fetch next 10 rows only;');
        expect(sql(paged, { dialect: 'mysql', keywordCase: 'lower', pretty: false })).toBe('select id from t limit 10 offset 20;');

        const upsert = EXAMPLES.find(e => e.id === 'upsert').build();
        const pg = sql(upsert, { dialect: 'postgresql', keywordCase: 'lower' });
        expect(pg).toContain('on conflict (email) do update');
        expect(pg).toContain('name = excluded.name');
        const my = sql(upsert, { dialect: 'mysql', keywordCase: 'lower' });
        expect(my).toContain('on duplicate key update');
        expect(my).toContain('name = values(name)');
    });

    test('keeps quoted names as they are', () => {
        const upsert = EXAMPLES.find(e => e.id === 'upsert').build();
        const pg = sql(upsert, { dialect: 'postgresql', keywordCase: 'lower', quoteIdentifiers: true });
        expect(pg).toContain('"name" = excluded."name"');
    });

    test('window functions, frames, CASE and set operations', () => {
        const window = sql(EXAMPLES.find(e => e.id === 'window').build(), { keywordCase: 'lower' });
        expect(window).toContain('rank() over (partition by department order by salary desc) as dept_rank');
        expect(window).toContain('rows between unbounded preceding and current row');
        const caseSql = sql(EXAMPLES.find(e => e.id === 'case').build(), { keywordCase: 'lower' });
        expect(caseSql).toMatch(/^ {4}case$/m);
        expect(caseSql).toMatch(/^ {8}when .+ then .+$/m);
        expect(caseSql).toMatch(/^ {4}end as /m);
        expect(sql(EXAMPLES.find(e => e.id === 'union').build(), { keywordCase: 'lower' })).toMatch(/^union all$|^union$/m);
    });
});

describe('indent', () => {
    const ws = () => EXAMPLES.find(e => e.id === 'cte').build();
    const lines = (text) => text.split('\n').map(line => /^(\s*)(.*)$/.exec(line).slice(1));

    test('2 spaces and tabs use the same levels as 4 spaces', () => {
        const four = lines(sql(ws()));
        const two = lines(sql(ws(), { indentStyle: '2' }));
        const tab = lines(sql(ws(), { indentStyle: 'tab' }));
        expect(four.some(([indent]) => indent.length === 8)).toBe(true);
        four.forEach(([indent, text], i) => {
            expect(two[i]).toEqual([' '.repeat(indent.length / 2), text]);
            expect(tab[i]).toEqual(['\t'.repeat(indent.length / 4), text]);
        });
    });

    test('indent only applies to formatted SQL', () => {
        expect(sql(ws(), { indentStyle: 'tab', pretty: false })).not.toContain('\t');
    });
});

describe('comma position', () => {
    test('leading commas start every list item but the first', () => {
        expect(sql(formatSample(), { commaPosition: 'leading' })).toBe([
            'SELECT',
            '    department',
            '    , region',
            '    , COUNT(*) AS staff',
            'FROM employees',
            "WHERE status = 'active'",
            "    AND (salary > 50000 OR role = 'lead')",
            'GROUP BY department, region',
            'ORDER BY staff DESC, department;'
        ].join('\n'));
    });

    test('apply to CTEs, VALUES rows, SET lists and multi-line columns', () => {
        const ctes = select(q => {
            const first = createSelect();
            first.columns = [createColumn('id')];
            first.from = createTableSource('a');
            const second = createSelect();
            second.columns = [createColumn('id')];
            second.from = createTableSource('b');
            q.ctes = [{ ...createCte(), name: 'x', query: first }, { ...createCte(), name: 'y', query: second }];
            q.columns = [createColumn('*')];
            q.from = createTableSource('x');
        });
        expect(sql(ctes, { commaPosition: 'leading' })).toBe([
            'WITH x AS (',
            '    SELECT id',
            '    FROM a',
            ')',
            ', y AS (',
            '    SELECT id',
            '    FROM b',
            ')',
            'SELECT *',
            'FROM x;'
        ].join('\n'));

        const rows = sql(EXAMPLES.find(e => e.id === 'insert-rows').build(), { commaPosition: 'leading' });
        expect(rows).toMatch(/^VALUES\n {4}\(.+\)\n {4}, \(.+\);$/m);

        const update = sql(EXAMPLES.find(e => e.id === 'update-safe').build(), { commaPosition: 'leading' });
        const set = update.split('\n').filter(line => /^ {4}, /.test(line));
        expect(update.split('\n').some(line => line.endsWith(',')), update).toBe(false);
        expect(set.length).toBeGreaterThan(0);

        const caseSql = sql(EXAMPLES.find(e => e.id === 'case').build(), { commaPosition: 'leading' });
        expect(caseSql).toMatch(/^ {4}, CASE$/m);
    });

    test('no line of any example ends with a list comma when commas lead', () => {
        for (const { example, dialect } of CASES) {
            const text = generateSQL(example.build(), { dialect, commaPosition: 'leading', expandLists: true });
            for (const line of text.split('\n')) expect(line.endsWith(','), `${example.id}: ${line}`).toBe(false);
        }
    });
});

describe('one item per line', () => {
    test('splits GROUP BY, ORDER BY and nested groups', () => {
        expect(sql(formatSample(), { expandLists: true })).toBe([
            'SELECT',
            '    department,',
            '    region,',
            '    COUNT(*) AS staff',
            'FROM employees',
            "WHERE status = 'active'",
            '    AND (',
            '        salary > 50000',
            "        OR role = 'lead'",
            '    )',
            'GROUP BY',
            '    department,',
            '    region',
            'ORDER BY',
            '    staff DESC,',
            '    department;'
        ].join('\n'));
    });

    test('with every other option', () => {
        expect(sql(formatSample(), { keywordCase: 'lower', indentStyle: '2', commaPosition: 'leading', expandLists: true })).toBe([
            'select',
            '  department',
            '  , region',
            '  , count(*) as staff',
            'from employees',
            "where status = 'active'",
            '  and (',
            '    salary > 50000',
            "    or role = 'lead'",
            '  )',
            'group by',
            '  department',
            '  , region',
            'order by',
            '  staff desc',
            '  , department;'
        ].join('\n'));
    });

    test('keeps a single GROUP BY or ORDER BY item on the keyword line', () => {
        const ws = select(q => {
            q.columns = [createColumn('a')];
            q.from = createTableSource('t');
            q.groupBy = [createGroupByItem('a')];
            q.orderBy = [{ expr: 'a', direction: 'ASC' }];
        });
        expect(sql(ws, { expandLists: true })).toBe(sql(ws));
    });

    test('splits INSERT column lists', () => {
        expect(sql(EXAMPLES.find(e => e.id === 'insert-rows').build(), { expandLists: true })).toMatch(/^INSERT INTO employees \(\n {4}name,\n {4}department,\n {4}salary\n\)\nVALUES/);
    });

    test('negated groups and groups in ON clauses', () => {
        const ws = select(q => {
            q.columns = [createColumn('id')];
            q.from = createTableSource('t');
            q.where = createGroup('AND', [
                createCondition({ left: 'a', op: '=', value: '1' }),
                { ...createGroup('OR', [createCondition({ left: 'b', op: '=', value: '2' }), createCondition({ left: 'c', op: '=', value: '3' })]), negate: true }
            ]);
        });
        expect(sql(ws, { expandLists: true })).toBe([
            'SELECT id',
            'FROM t',
            'WHERE a = 1',
            '    AND NOT (',
            '        b = 2',
            '        OR c = 3',
            '    );'
        ].join('\n'));
    });
});

describe('settings', () => {
    test('format settings are validated like the others', () => {
        expect(sanitizeSettings({})).toMatchObject(DEFAULT_FORMAT);
        expect(sanitizeSettings({ keywordCase: 'lower', indentStyle: 'tab', commaPosition: 'leading', expandLists: true }))
            .toMatchObject({ keywordCase: 'lower', indentStyle: 'tab', commaPosition: 'leading', expandLists: true });
        expect(sanitizeSettings({ keywordCase: 'LOWER', indentStyle: 2, commaPosition: '<b>', expandLists: 'true' }))
            .toMatchObject(DEFAULT_FORMAT);
    });

    test('formatOptions picks only the format settings', () => {
        const settings = sanitizeSettings({ keywordCase: 'lower', dialect: 'mysql' });
        expect(formatOptions(settings)).toEqual({ ...DEFAULT_FORMAT, keywordCase: 'lower' });
    });
});

describe('import preview and dialect comparison use the format', () => {
    const text = 'SELECT department, COUNT(*) AS staff FROM employees GROUP BY department, region';

    test('the import preview writes the SQL in the chosen format and still reports an exact import', () => {
        const preview = previewSqlImport(text, { dialect: 'generic', format: { keywordCase: 'lower', commaPosition: 'leading' } });
        if (!preview.ok) throw new Error(preview.message);
        expect(preview.sql).toBe('select\n    department\n    , count(*) as staff\nfrom employees\ngroup by department, region;');
        expect(preview.check.same).toBe(true);
    });

    test('the comparison writes both dialects in the chosen format and finds the same differences', () => {
        const ws = EXAMPLES.find(e => e.id === 'page-results').build();
        const plain = compareDialects(ws, 'postgresql', 'sqlserver');
        const lower = compareDialects(ws, 'postgresql', 'sqlserver', { format: { keywordCase: 'lower', expandLists: true } });
        expect(lower.from.sql).toContain('order by\n    name,\n    id');
        expect(lower.to.sql).toContain('fetch next 20 rows only');
        expect(lower.check.total).toBe(plain.check.total);
    });
});
