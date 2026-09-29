import { describe, expect, test } from 'vitest';
import { importSql, previewSqlImport, guessDialect, MAX_SQL_IMPORT_CHARS } from '../src/sql-import.js';
import { compareSql } from '../src/roundtrip.js';
import { EXAMPLES } from '../src/examples.js';
import { generateQuery } from '../src/generator.js';
import { validateWorkspace } from '../src/validation.js';
import { normalizeWorkspace } from '../src/serialization.js';
import { createWorkspace } from '../src/model.js';

const DIALECTS = ['generic', 'sqlserver', 'postgresql', 'mysql'];

/** Imports, or fails the test with the reason */
function read(sql, dialect = 'generic') {
    const result = importSql(sql, { dialect });
    if (!result.ok) throw new Error(`${result.line}:${result.col} ${result.message}`);
    return result.query;
}
const compact = (sql, dialect = 'generic') => generateQuery(read(sql, dialect), { dialect, pretty: false });
const refusal = (sql, dialect = 'generic') => {
    const result = importSql(sql, { dialect });
    if (result.ok) throw new Error(`Imported: ${sql}`);
    return `${result.line}:${result.col} ${result.message}`;
};

describe('round trip: every example, in every dialect', () => {
    const selects = EXAMPLES.filter(e => e.build().type === 'select');

    test.each(DIALECTS)('%s: the builder writes each example back exactly', (dialect) => {
        expect(selects.length).toBeGreaterThan(10);
        for (const example of selects) {
            for (const pretty of [true, false]) {
                for (const quoteIdentifiers of [false, true]) {
                    const options = { dialect, pretty, quoteIdentifiers };
                    const sql = generateQuery(example.build().select, options);
                    const preview = previewSqlImport(sql, { dialect, pretty });
                    if (!preview.ok) throw new Error(`${example.id}: ${preview.message}`);
                    expect(preview.check, `${example.id} ${JSON.stringify(options)}`).toEqual({ same: true, total: 0, differences: [] });
                    // Names are kept as typed, quotes included, so no setting changes them again
                    expect(generateQuery(preview.query, options), example.id).toBe(sql);
                }
            }
        }
    });

    test('examples come back as the same builder parts (CASE, window, joins, CTEs)', () => {
        for (const example of selects) {
            const original = example.build().select;
            const imported = read(generateQuery(original, { dialect: 'generic' }));
            // true / TRUE is the one thing the builder writes differently than it is typed
            expect(JSON.stringify(imported).replace(/"TRUE"/g, '"true"'), example.id).toBe(JSON.stringify(original));
        }
    });

    test('imported queries are valid workspaces with no builder errors', () => {
        for (const example of selects) {
            for (const dialect of DIALECTS) {
                const ws = createWorkspace();
                ws.select = read(generateQuery(example.build().select, { dialect }), dialect);
                expect(normalizeWorkspace(JSON.parse(JSON.stringify(ws)))).toEqual(ws);
                const before = validateWorkspace(example.build(), { dialect }).filter(i => i.level === 'error');
                expect(validateWorkspace(ws, { dialect }).filter(i => i.level === 'error'), `${example.id} ${dialect}`).toEqual(before);
            }
        }
    });

    test.each(DIALECTS)('%s: INSERT, UPDATE and DELETE examples come back exactly, as the same query type', (dialect) => {
        const others = EXAMPLES.filter(e => e.build().type !== 'select');
        expect(others.map(e => e.build().type).sort()).toEqual(['delete', 'insert', 'insert', 'insert', 'update']);
        for (const example of others) {
            const ws = example.build();
            for (const pretty of [true, false]) {
                for (const quoteIdentifiers of [false, true]) {
                    const options = { dialect, pretty, quoteIdentifiers };
                    const sql = generateQuery(ws[ws.type], options);
                    const preview = previewSqlImport(sql, { dialect, pretty });
                    if (!preview.ok) throw new Error(`${example.id}: ${preview.message}`);
                    expect(preview.query.kind).toBe(ws.type);
                    expect(preview.check.same, example.id).toBe(true);
                    expect(generateQuery(preview.query, options), example.id).toBe(sql);
                    const imported = createWorkspace(ws.type);
                    imported[ws.type] = preview.query;
                    expect(normalizeWorkspace(JSON.parse(JSON.stringify(imported)))).toEqual(imported);
                    const errors = (w) => validateWorkspace(w, { dialect }).filter(i => i.level === 'error').map(i => i.message);
                    // No errors; an upsert the dialect can't write isn't in the SQL, so it isn't imported either
                    expect(errors(imported), `${example.id} ${dialect}`).toEqual([]);
                }
            }
        }
    });
});

describe('INSERT, UPDATE and DELETE', () => {
    test('INSERT … VALUES with several rows; names like date are columns', () => {
        const q = read("INSERT INTO sales.orders (id, date, \"Note\") VALUES (1, '2024-01-01', NULL), (2, CURRENT_DATE, 'x, y')");
        expect(q).toMatchObject({
            kind: 'insert', table: 'sales.orders', columns: 'id, date, "Note"', source: 'values',
            rows: [{ values: "1, '2024-01-01', NULL" }, { values: "2, CURRENT_DATE, 'x, y'" }]
        });
        expect(read('INSERT INTO t VALUES (1)').columns).toBe('');
    });

    test('INSERT … SELECT keeps the whole SELECT, joins and all', () => {
        const q = read('INSERT INTO archive (id) SELECT o.id FROM orders o JOIN old x ON x.id = o.id WHERE o.done = 1 ORDER BY o.id LIMIT 10');
        expect(q.source).toBe('select');
        expect(q.select).toMatchObject({ limit: '10', joins: [{ type: 'INNER JOIN' }], orderBy: [{ expr: 'o.id' }] });
    });

    test('upserts in PostgreSQL and MySQL, with the inserted value recognised', () => {
        const pg = read('INSERT INTO t (id, n) VALUES (1, 2) ON CONFLICT (id) DO UPDATE SET n = EXCLUDED.n, seen = seen + 1, at = $3', 'postgresql');
        expect(pg.upsert).toEqual({
            mode: 'update', conflict: 'id', set: [
                { column: 'n', valueType: 'inserted', value: '' },
                { column: 'seen', valueType: 'column', value: 'seen + 1' },
                { column: 'at', valueType: 'param', value: '3' }
            ]
        });
        expect(read('INSERT INTO t (id) VALUES (1) ON CONFLICT DO NOTHING', 'postgresql').upsert).toEqual({ mode: 'nothing', conflict: '', set: [] });
        const my = read('INSERT INTO t (id, n) VALUES (1, 2) ON DUPLICATE KEY UPDATE n = values(n), m = \'x\'', 'mysql');
        expect(my.upsert.set).toEqual([{ column: 'n', valueType: 'inserted', value: '' }, { column: 'm', valueType: 'value', value: 'x' }]);
    });

    test('UPDATE with SET values of every kind, and WHERE', () => {
        const q = read("UPDATE dbo.staff SET name = 'Ann', boss = NULL, pay = pay * 1.1, code = '007', year = @y WHERE id = @id AND (a = 1 OR b = 2)", 'sqlserver');
        expect(q.table).toBe('dbo.staff');
        expect(q.set.map(a => [a.column, a.valueType, a.value])).toEqual([
            ['name', 'value', 'Ann'], ['boss', 'value', 'NULL'], ['pay', 'column', 'pay * 1.1'], ['code', 'value', '007'], ['year', 'param', 'y']
        ]);
        expect(q.where.items.map(i => i.kind)).toEqual(['condition', 'group']);
        expect(read('UPDATE t SET a = 1').where.items).toEqual([]);
    });

    test('DELETE with and without WHERE, subqueries included', () => {
        expect(read('DELETE FROM t').where.items).toEqual([]);
        const q = read('DELETE FROM t WHERE id IN (SELECT id FROM old WHERE old.x = t.x)');
        expect(q.where.items[0]).toMatchObject({ op: 'IN', valueType: 'subquery' });
    });

    test('the dialect guess notices upsert syntax', () => {
        expect(guessDialect('INSERT INTO t (a) VALUES (1) ON CONFLICT DO NOTHING')).toEqual({ dialect: 'postgresql', reason: 'ON CONFLICT' });
        expect(guessDialect('INSERT INTO t (a) VALUES (1) ON DUPLICATE KEY UPDATE a = 1')).toEqual({ dialect: 'mysql', reason: 'ON DUPLICATE KEY' });
    });
});

describe('what is read into the builder', () => {
    test('columns: aggregates, aliases with and without AS, expressions kept word for word', () => {
        const q = read('select distinct e.name n, count(*) as "Total", count(distinct d.id), sum(e.salary * 1.1) raise, upper(e.email) || \'!\' from employees e');
        expect(q.distinct).toBe(true);
        expect(q.columns).toEqual([
            { kind: 'column', expr: 'e.name', aggregate: '', alias: 'n' },
            { kind: 'column', expr: '*', aggregate: 'COUNT', alias: '"Total"' },
            { kind: 'column', expr: 'd.id', aggregate: 'COUNT DISTINCT', alias: '' },
            { kind: 'column', expr: 'e.salary * 1.1', aggregate: 'SUM', alias: 'raise' },
            { kind: 'column', expr: "upper(e.email) || '!'", aggregate: '', alias: '' }
        ]);
        expect(q.from).toEqual({ kind: 'table', table: 'employees', alias: 'e' });
    });

    test('words that end an expression are not taken as aliases', () => {
        expect(read("SELECT a DIV b, x COLLATE nocase, INTERVAL '1' DAY, CASE WHEN a THEN 1 END FROM t").columns.map(c => c.alias)).toEqual(['', '', '', '']);
        expect(read('SELECT a.b FROM t').columns[0]).toEqual({ kind: 'column', expr: 'a.b', aggregate: '', alias: '' });
    });

    test('joins of every type, with ON conditions as builder conditions', () => {
        const q = read(`SELECT * FROM a
            JOIN b ON a.id = b.a_id
            LEFT OUTER JOIN c AS cc ON cc.b_id = b.id AND cc.kind = 'x'
            RIGHT JOIN d ON d.id = a.d_id
            FULL JOIN e ON e.id = a.e_id
            CROSS JOIN f`);
        expect(q.joins.map(j => `${j.type} ${j.source.table} ${j.source.alias}`)).toEqual([
            'INNER JOIN b ', 'LEFT JOIN c cc', 'RIGHT JOIN d ', 'FULL JOIN e ', 'CROSS JOIN f '
        ]);
        expect(q.joins[1].on.items).toEqual([
            { kind: 'condition', left: 'cc.b_id', op: '=', valueType: 'column', value: 'b.id', value2: '', subquery: null },
            { kind: 'condition', left: 'cc.kind', op: '=', valueType: 'value', value: 'x', value2: '', subquery: null }
        ]);
    });

    test('WHERE: AND / OR groups, NOT (…), and every operator', () => {
        const q = read(`SELECT a FROM t WHERE (x = 1 OR y <> 'b') AND NOT (z IS NULL)
            AND w IS NOT NULL AND n LIKE 'a%' AND m NOT LIKE '%z' AND k IN (1, 2) AND j NOT IN ('p', 'q')
            AND v BETWEEN 1 AND 10 AND u NOT BETWEEN a.lo AND a.hi AND EXISTS (SELECT 1 FROM s) AND NOT EXISTS (SELECT 1 FROM r)`);
        const [first, second, ...rest] = q.where.items;
        expect(first.logic).toBe('OR');
        expect(first.items.map(i => `${i.left} ${i.op} ${i.value}`)).toEqual(['x = 1', 'y <> b']);
        expect(second).toMatchObject({ kind: 'group', negate: true, items: [{ left: 'z', op: 'IS NULL' }] });
        expect(rest.map(i => [i.left, i.op, i.valueType, i.value, i.value2])).toEqual([
            ['w', 'IS NOT NULL', 'value', '', ''],
            ['n', 'LIKE', 'value', 'a%', ''],
            ['m', 'NOT LIKE', 'value', '%z', ''],
            ['k', 'IN', 'value', '1, 2', ''],
            ['j', 'NOT IN', 'value', 'p, q', ''],
            ['v', 'BETWEEN', 'value', '1', '10'],
            ['u', 'NOT BETWEEN', 'column', 'a.lo', 'a.hi'],
            ['', 'EXISTS', 'subquery', '', ''],
            ['', 'NOT EXISTS', 'subquery', '', '']
        ]);
    });

    test('mixed AND / OR keeps its meaning: AND binds first', () => {
        expect(compact('SELECT a FROM t WHERE a = 1 AND b = 2 OR c = 3')).toBe('SELECT a FROM t WHERE (a = 1 AND b = 2) OR c = 3;');
        expect(compact('SELECT a FROM t WHERE a = 1 OR b = 2 AND c = 3')).toBe('SELECT a FROM t WHERE a = 1 OR (b = 2 AND c = 3);');
    });

    test('values are typed the way the builder writes them back', () => {
        const values = (sql, dialect) => read(`SELECT a FROM t WHERE ${sql}`, dialect).where.items.map(i => [i.valueType, i.value]);
        expect(values("a = 'John' AND b = '042' AND c = '' AND d = -5 AND e = 'it''s' AND f = N'x' AND g = NULL AND h = b.c AND i = '  pad'")).toEqual([
            ['value', 'John'], ['value', '042'], ['value', "''"], ['value', '-5'], ['value', "it's"], ['value', "N'x'"],
            ['value', 'NULL'], ['column', 'b.c'], ['value', "'  pad'"]
        ]);
        // SQL Server writes booleans as 1/0, so TRUE stays as typed
        expect(values('a = TRUE', 'sqlserver')).toEqual([['column', 'TRUE']]);
        expect(values('a = true', 'postgresql')).toEqual([['value', 'true']]);
        // MySQL strings use backslash escapes; the builder would write 'it''s', so \' is kept as typed
        expect(values("a = 'it\\'s' AND b = 'a\\\\b'", 'mysql')).toEqual([['column', "'it\\'s'"], ['value', 'a\\b']]);
        expect(compact("SELECT a FROM t WHERE a = 'it\\'s'", 'mysql')).toBe("SELECT a FROM t WHERE a = 'it\\'s';");
    });

    test('IN lists: a value the list would split keeps its quotes; anything else is kept as typed', () => {
        const q = read("SELECT a FROM t WHERE a IN ('x,y', 'O''Brien', 3, NULL) AND b IN (c.d, 1) AND e IN (?)");
        expect(q.where.items.map(i => [i.valueType, i.value])).toEqual([
            ['value', "'x,y', 'O''Brien', 3, NULL"],
            ['column', '(c.d, 1)'],
            ['column', '(?)']
        ]);
    });

    test('parameters in each dialect\'s style', () => {
        const params = (sql, dialect) => read(`SELECT a FROM t WHERE ${sql}`, dialect).where.items.map(i => [i.valueType, i.value, i.value2]);
        expect(params('a = ? AND b = :name', 'generic')).toEqual([['param', '', ''], ['param', 'name', '']]);
        expect(params('a = $2 AND b BETWEEN $3 AND $4', 'postgresql')).toEqual([['param', '2', ''], ['param', '3', '4']]);
        expect(params('a = @id AND b = @@ROWCOUNT', 'sqlserver')).toEqual([['param', 'id', ''], ['column', '@@ROWCOUNT', '']]);
        expect(params('a = @id', 'generic')).toEqual([['column', '@id', '']]);
        expect(params('a = ?', 'mysql')).toEqual([['param', '', '']]);
    });

    test('conditions the builder has no operator for are kept as custom SQL', () => {
        const q = read("SELECT a FROM t WHERE a ILIKE 'x' AND b = ANY (SELECT c FROM u) AND c LIKE 'a!%' ESCAPE '!' AND is_active AND NOT a = 1 AND x @> y AND a <=> b AND a = b = c", 'postgresql');
        expect(q.where.items.map(i => i.kind === 'raw' ? i.sql : i.kind)).toEqual([
            "a ILIKE 'x'", 'b = ANY (SELECT c FROM u)', "c LIKE 'a!%' ESCAPE '!'", 'is_active', 'NOT a = 1', 'x @> y', 'a <=> b', 'a = b = c'
        ]);
    });

    test('subqueries: in FROM, JOIN, IN, EXISTS and comparisons; correlated names are kept', () => {
        const q = read(`SELECT t.a FROM (SELECT a FROM x) AS t
            JOIN (SELECT b FROM y) z ON z.b = t.a
            WHERE t.a IN (SELECT a FROM w) AND t.a > (SELECT AVG(a) FROM v WHERE v.k = t.a)`);
        expect(q.from.kind).toBe('subquery');
        expect(q.from.alias).toBe('t');
        expect(q.joins[0].source.kind).toBe('subquery');
        expect(q.where.items.map(i => `${i.op} ${i.valueType}`)).toEqual(['IN subquery', '> subquery']);
        expect(q.where.items[1].subquery.where.items[0]).toMatchObject({ left: 'v.k', valueType: 'column', value: 't.a' });
    });

    test('WITH, set operations, ORDER BY and paging', () => {
        const q = read('WITH a AS (SELECT x FROM t), b AS (SELECT x FROM a) SELECT x FROM a UNION ALL SELECT x FROM b INTERSECT SELECT x FROM c EXCEPT DISTINCT SELECT x FROM d ORDER BY 1 DESC, x LIMIT 5 OFFSET 10');
        expect(q.ctes.map(c => c.name)).toEqual(['a', 'b']);
        expect(q.setOps.map(s => s.op)).toEqual(['UNION ALL', 'INTERSECT', 'EXCEPT']);
        expect(q.orderBy).toEqual([{ expr: '1', direction: 'DESC' }, { expr: 'x', direction: 'ASC' }]);
        expect([q.limit, q.offset]).toEqual(['5', '10']);
    });

    test('paging in each dialect\'s syntax', () => {
        const paging = (sql, dialect) => {
            const q = read(sql, dialect);
            return [q.limit, q.offset, q.orderBy.length];
        };
        expect(paging('SELECT a FROM t LIMIT 10, 20', 'mysql')).toEqual(['20', '10', 0]);
        expect(paging('SELECT a FROM t LIMIT 18446744073709551615 OFFSET 5', 'mysql')).toEqual(['', '5', 0]);
        expect(paging('SELECT a FROM t LIMIT 18446744073709551615 OFFSET 5', 'generic')).toEqual(['18446744073709551615', '5', 0]);
        expect(paging('SELECT TOP (10) a FROM t ORDER BY a', 'sqlserver')).toEqual(['10', '', 1]);
        expect(paging('SELECT a FROM t ORDER BY (SELECT NULL) OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY', 'sqlserver')).toEqual(['10', '5', 0]);
        expect(paging('SELECT a FROM t ORDER BY (SELECT NULL) OFFSET 5 ROWS', 'generic')).toEqual(['', '5', 1]);
        expect(paging('SELECT a FROM t OFFSET 3 LIMIT 4', 'postgresql')).toEqual(['4', '3', 0]);
        expect(paging('SELECT a FROM t FETCH FIRST ROW ONLY', 'postgresql')).toEqual(['1', '', 0]);
    });

    test('structured CASE and window columns, or the expression as typed when the builder can\'t write it', () => {
        const [c, w, moving, count, other] = read(`SELECT
            CASE WHEN a > 1 THEN CASE WHEN b THEN 'x' END ELSE 'z' END AS s,
            RANK() OVER (PARTITION BY d, e ORDER BY f DESC) r,
            AVG(x) OVER (ORDER BY y ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS m,
            COUNT(*) OVER () AS c,
            SUM(x) OVER (ORDER BY y RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS o
            FROM t`).columns;
        expect(c).toEqual({ kind: 'case', cases: [{ when: 'a > 1', then: "CASE WHEN b THEN 'x' END" }], elseValue: "'z'", alias: 's' });
        expect(w).toMatchObject({ kind: 'window', func: 'RANK', args: '', partitionBy: [{ expr: 'd' }, { expr: 'e' }], orderBy: [{ expr: 'f', direction: 'DESC' }], alias: 'r' });
        expect(moving).toMatchObject({ kind: 'window', func: 'AVG', args: 'x', frame: 'moving', frameSize: '6' });
        expect(count).toMatchObject({ kind: 'window', func: 'COUNT', args: '' });
        expect(other).toEqual({ kind: 'column', expr: 'SUM(x) OVER (ORDER BY y RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)', aggregate: '', alias: 'o' });
        expect(read("SELECT CASE a WHEN 1 THEN 'one' END FROM t").columns[0].kind).toBe('column');
    });

    test('quoted and qualified names are kept as typed', () => {
        expect(read('SELECT [Order Id] FROM [dbo].[Orders] AS [o]', 'sqlserver').from).toEqual({ kind: 'table', table: '[dbo].[Orders]', alias: '[o]' });
        expect(read('SELECT "a" FROM db.schema."T" t').from.table).toBe('db.schema."T"');
    });

    test('comments and a final semicolon are left out', () => {
        const result = importSql('/* report */\nSELECT a -- the id\nFROM t;;\n');
        expect(result.ok && result.notes).toEqual(['Comments are left out: the builder has no place for them.']);
        expect(importSql('SELECT a FROM t;').ok && importSql('SELECT a FROM t;').notes).toEqual([]);
    });
});

describe('what can\'t be imported is refused with its line and column', () => {
    test.each([
        ['', '0:0 Paste a SELECT statement to import.'],
        ['  ;  ', '0:0 Paste a SELECT statement to import.'],
        ['SELECT a FROM t;\nSELECT b FROM u', '2:1 This is more than one statement; import one statement at a time.'],
        ['CREATE TABLE t (a int)', '1:1 Only SELECT, INSERT, UPDATE and DELETE statements can be imported; this starts with “CREATE”.'],
        ['MERGE INTO t USING u ON 1 = 1', "1:1 MERGE statements aren't supported in the builder."],
        ['INSERT t VALUES (1)', '1:8 Expected INTO after INSERT.'],
        ['INSERT IGNORE INTO t VALUES (1)', "1:8 INSERT IGNORE isn't supported in the builder."],
        ['INSERT INTO t DEFAULT VALUES', "1:15 DEFAULT VALUES isn't supported in the builder."],
        ['INSERT INTO t SET a = 1', "1:15 INSERT … SET isn't supported; write INSERT INTO t (columns) VALUES (…)."],
        ['INSERT INTO t (a, 1) VALUES (1, 2)', '1:15 The column list should be column names separated by commas.'],
        ['INSERT INTO t (a) VALUES (1, )', '1:26 Expected values separated by commas in this row.'],
        ['INSERT INTO t (a) VALUES 1', '1:26 Expected a row of values in parentheses here.'],
        ['INSERT INTO t (a) (SELECT a FROM u)', '1:19 Remove the parentheses around the SELECT.'],
        ['INSERT INTO t (a) VALUES (1) RETURNING id', "1:30 RETURNING isn't supported in the builder."],
        ['INSERT INTO t (a) VALUES (1) ON CONFLICT DO NOTHING', "1:30 Generic SQL has no ON CONFLICT; pick PostgreSQL if this SQL is for PostgreSQL."],
        ['INSERT INTO t (a) VALUES (1) ON DUPLICATE KEY UPDATE a = 2', "1:30 Generic SQL has no ON DUPLICATE KEY UPDATE; pick MySQL if this SQL is for MySQL."],
        ['UPDATE t x SET a = 1', "1:10 An alias for the UPDATE table isn't supported; use the table's name in the conditions."],
        ['UPDATE t SET a = 1 FROM u WHERE u.id = t.id', "1:20 UPDATE … FROM isn't supported in the builder."],
        ['UPDATE t SET (a, b) = (1, 2)', "1:14 Setting several columns from one list isn't supported; write one column = value each."],
        ['UPDATE t SET a + 1 = 2', '1:14 Expected column = value here.'],
        ['UPDATE t SET a =', '1:16 Expected a value after =.'],
        ['UPDATE t, u SET a = 1', "1:9 Updating several tables at once isn't supported in the builder."],
        ['UPDATE t SET a = 1 WHERE b = 2 ORDER BY c LIMIT 1', "1:32 ORDER BY isn't supported here in the builder."],
        ['UPDATE TOP (5) t SET a = 1', "1:8 UPDATE TOP isn't supported in the builder."],
        ['UPDATE t SET a = 1 OUTPUT inserted.a WHERE id = 1', "1:20 OUTPUT isn't supported in the builder yet."],
        ['DELETE t FROM t JOIN u ON u.id = t.id', '1:8 Expected FROM after DELETE; the builder writes DELETE FROM table.'],
        ['DELETE FROM t USING u WHERE u.id = t.id', "1:15 Deleting with other tables (USING or JOIN) isn't supported; use WHERE … IN (SELECT …) instead."],
        ['DELETE FROM t AS x WHERE x.a = 1', "1:15 An alias for the DELETE table isn't supported; use the table's name in the conditions."],
        ['WITH x AS (SELECT 1 FROM t) DELETE FROM t', "1:29 A WITH before DELETE isn't supported in the builder."],
        ['(SELECT a FROM t)', '1:1 Remove the parentheses around the whole query and import it again.'],
        ['SELECT a FROM t WHERE (a = 1', '1:23 This "(" is never closed.'],
        ['SELECT a) FROM t', '1:9 This ")" has no matching "(".'],
        ["SELECT a FROM t WHERE a = 'x", '1:27 This quote is never closed.'],
        ['SELECT a /* note FROM t', '1:10 This /* comment is never closed.'],
        ['SELECT 1', "1:8 The builder needs a FROM table; a SELECT without FROM can't be imported."],
        ['SELECT a, FROM t', '1:11 Expected a column here.'],
        ['SELECT a FROM t, u', "1:16 Tables separated by commas aren't supported; write them as JOIN … ON (or CROSS JOIN)."],
        ['SELECT a FROM t WHERE', '1:17 The query ends too early. Expected a condition after WHERE.'],
        ['SELECT a FROM t WHERE a = 1 AND', '1:29 Expected a condition after AND.'],
        ['SELECT a FROM t WHERE a =', '1:25 Expected a value after =.'],
        ['SELECT DISTINCT ON (a) a FROM t', "1:8 DISTINCT ON isn't supported yet."],
        ['SELECT a FROM t JOIN u USING (id)', "1:24 JOIN … USING (…) isn't supported yet; write it as ON a.column = b.column."],
        ['SELECT a FROM t JOIN u', '1:22 The query ends too early. Expected ON and a join condition after the INNER JOIN table.'],
        ['SELECT a FROM t NATURAL JOIN u', "1:17 NATURAL JOIN isn't supported; write JOIN … ON."],
        ['SELECT a FROM t CROSS APPLY f(t.a)', "1:17 CROSS APPLY isn't supported yet."],
        ['WITH RECURSIVE r AS (SELECT 1) SELECT * FROM r', "1:6 Recursive CTEs (WITH RECURSIVE) aren't supported yet."],
        ['WITH r (a) AS (SELECT 1 FROM t) SELECT * FROM r', "1:8 Column names after a WITH query's name aren't supported yet; name the columns inside its SELECT."],
        ['SELECT a FROM t ORDER BY a NULLS LAST', "1:28 NULLS FIRST / NULLS LAST isn't supported yet."],
        ['SELECT a FROM t LIMIT ?', "1:23 LIMIT needs a whole number in the builder; parameters aren't supported there yet."],
        ['SELECT a FROM t LIMIT ALL', "1:23 LIMIT ALL isn't supported; leave the limit out."],
        ['SELECT TOP 5 PERCENT a FROM t', "1:14 TOP … PERCENT and WITH TIES aren't supported in the builder."],
        ['SELECT a FROM t UNION (SELECT b FROM u)', "1:23 A SELECT in parentheses after UNION isn't supported yet; remove the parentheses."],
        ['SELECT a FROM t RETURNING a', "1:17 RETURNING isn't supported in the builder."],
        ['SELECT a FROM t FOR UPDATE', "1:17 FOR UPDATE isn't supported in the builder."],
        ['SELECT a INTO b FROM t', "1:10 SELECT … INTO isn't supported in the builder."],
        ['SELECT a FROM generate_series(1, 3)', "1:30 Table functions aren't supported in FROM or JOIN yet."],
        ['SELECT a FROM t WITH (NOLOCK)', "1:17 Table hints (WITH (…)) aren't supported in the builder."],
        ['SELECT a FROM t GROUP BY a WITH ROLLUP', "1:28 WITH ROLLUP isn't supported in the builder."],
        ['SELECT a FROM (VALUES (1)) v', '1:15 Only a SELECT can go in parentheses in FROM or JOIN.'],
        ['SELECT a FROM t WHERE a = 1 WINDOW w AS (ORDER BY a)', "1:29 Named windows (WINDOW … AS) aren't supported yet; write the window in OVER (…)."],
        ['SELECT a FROM t WHERE ()', '1:23 Expected a condition inside these parentheses.'],
        ['SELECT a FROM (WITH x AS (SELECT a FROM t) SELECT a FROM x) s', '1:16 WITH can only be used on the main query in the builder; move this CTE to the top.'],
        ['SELECT a FROM t WHERE a IN (WITH x AS (SELECT a FROM t) SELECT a FROM x)', '1:29 WITH can only be used on the main query in the builder; move this CTE to the top.'],
        ['SELECT a FROM t oops extra', '1:22 The builder can\'t read “extra” here.']
    ])('%s', (sql, expected) => {
        expect(refusal(sql)).toBe(expected);
    });

    test('nesting deeper than the builder allows', () => {
        const nested = (n) => (n === 0 ? 'SELECT a FROM t' : `SELECT a FROM (${nested(n - 1)}) AS s${n}`);
        expect(importSql(nested(4)).ok).toBe(true);
        expect(refusal(nested(5))).toBe('1:76 Queries can be nested at most 4 levels deep in the builder.');
    });

    test('too long', () => {
        const result = importSql(`SELECT a FROM t WHERE a = '${'x'.repeat(MAX_SQL_IMPORT_CHARS)}'`);
        expect(result).toEqual({ ok: false, message: 'The SQL is too long to import (limit 1 MB).', line: 0, col: 0 });
    });
});

describe('hostile and random input', () => {
    test('deep parentheses are refused, not a crash', () => {
        const deep = `SELECT a FROM t WHERE ${'('.repeat(5000)}a = 1${')'.repeat(5000)}`;
        expect(refusal(deep)).toBe('1:88 The conditions are nested too deeply to import.');
        expect(importSql(`SELECT ${'('.repeat(20000)}1${')'.repeat(20000)} FROM t`).ok).toBe(true);
    });

    test('markup and control characters stay text in the model', () => {
        const q = read("SELECT '<script>alert(1)</script>' AS \"<b>\" FROM t WHERE a = '\u0000‮'");
        expect(q.columns[0]).toEqual({ kind: 'column', expr: "'<script>alert(1)</script>'", aggregate: '', alias: '"<b>"' });
        expect(q.where.items[0].value).toBe('\u0000‮');
    });

    test('random token soup never throws, and whatever imports is a valid workspace', () => {
        const words = ['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'JOIN', 'LEFT', 'ON', 'AS', 'IN', 'IS', 'NULL', 'BETWEEN',
            'CASE', 'WHEN', 'THEN', 'END', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'ALL', 'WITH', 'EXISTS',
            'TOP', 'DISTINCT', 'OVER', 'PARTITION', 'ROWS', 'COUNT', 'SUM', 'a', 't', 'x.y', '"q"', '[b]', '`c`', '1', '2.5',
            "'s'", '?', '$1', ':n', '@p', '(', ')', ',', ';', '=', '<>', '*', '+', '-', '--c\n', '/*x*/', '.', '::'];
        let seed = 42;
        const random = (n) => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed % n;
        };
        let imported = 0;
        for (let run = 0; run < 3000; run++) {
            const parts = ['SELECT'];
            const length = 1 + random(30);
            for (let i = 0; i < length; i++) parts.push(words[random(words.length)]);
            if (random(2)) parts.splice(2, 0, 'FROM', 't');
            const sql = parts.join(random(3) ? ' ' : '\n');
            for (const dialect of DIALECTS) {
                const result = previewSqlImport(sql, { dialect });
                if (!result.ok) {
                    expect(typeof result.message).toBe('string');
                    continue;
                }
                imported++;
                const ws = createWorkspace();
                ws.select = result.query;
                expect(normalizeWorkspace(JSON.parse(JSON.stringify(ws)))).toEqual(ws);
                expect(() => validateWorkspace(ws, { dialect })).not.toThrow();
            }
        }
        expect(imported).toBeGreaterThan(20);
    });

    test('examples with tokens dropped, repeated or swapped never throw, and never import a changed query as unchanged', () => {
        let seed = 7;
        const random = (n) => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed % n;
        };
        const workspaces = EXAMPLES.map(e => e.build());
        let imported = 0;
        for (let run = 0; run < 2000; run++) {
            const dialect = DIALECTS[random(DIALECTS.length)];
            const example = workspaces[random(workspaces.length)];
            const original = generateQuery(example[example.type], { dialect, pretty: false });
            const words = original.split(' ');
            const at = random(words.length);
            const kind = random(3);
            if (kind === 0) words.splice(at, 1);
            else if (kind === 1) words.splice(at, 0, words[at]);
            else words.splice(at, 2, words[at + 1] ?? '', words[at]);
            const sql = words.join(' ');
            const result = previewSqlImport(sql, { dialect, pretty: false });
            if (!result.ok) continue;
            imported++;
            const ws = createWorkspace(result.query.kind);
            ws[result.query.kind] = result.query;
            expect(normalizeWorkspace(JSON.parse(JSON.stringify(ws)))).toEqual(ws);
            // "Imported exactly" means the builder's SQL reads the same as the text
            if (result.check.same) expect(compareSql(sql, result.sql, {}).same).toBe(true);
        }
        expect(imported).toBeGreaterThan(300);
    });
});

describe('guessing the dialect', () => {
    test.each([
        ['SELECT `a` FROM t', { dialect: 'mysql', reason: 'backquoted names' }],
        ['SELECT a FROM t LIMIT 5, 10', { dialect: 'mysql', reason: 'LIMIT offset, count' }],
        ['select top 5 * from [x]', { dialect: 'sqlserver', reason: 'TOP, names in [brackets]' }],
        ['SELECT a FROM t WHERE b = @id', { dialect: 'sqlserver', reason: '@parameters' }],
        ['SELECT a::int FROM t WHERE b = $1', { dialect: 'postgresql', reason: ':: casts, $1 parameters' }],
        ['SELECT a FROM t WHERE b = :id', { dialect: 'generic', reason: ':name parameters' }],
        ['SELECT arr[1] FROM t', null],
        ['SELECT a FROM t', null],
        ['SELECT `a` FROM [t]', null]
    ])('%s', (sql, expected) => {
        expect(guessDialect(sql)).toEqual(expected);
    });
});

describe('round-trip comparison', () => {
    test('ignores layout, comments, keyword case and optional words', () => {
        expect(compareSql('select a as x\nfrom t inner join u on 1 = 1 -- c\norder by a asc;', 'SELECT a x FROM t JOIN u ON 1 = 1 ORDER BY a').same).toBe(true);
    });

    test('names quoted differently, or with a different case inside quotes, are differences', () => {
        expect(compareSql('SELECT "A" FROM t', 'SELECT "a" FROM t').same).toBe(false);
        expect(compareSql('SELECT "a" FROM t', 'SELECT a FROM t').same).toBe(false);
    });

    test('reports where each difference is in your SQL', () => {
        expect(compareSql('SELECT a\nFROM t\nLIMIT 5, 10', 'SELECT a FROM t LIMIT 10 OFFSET 5')).toEqual({
            same: false,
            total: 1,
            differences: [{ line: 3, col: 7, yours: '5, 10', builder: '10 OFFSET 5' }]
        });
        expect(compareSql('SELECT ALL a FROM t', 'SELECT a FROM t').differences).toEqual([{ line: 1, col: 8, yours: 'ALL', builder: '' }]);
        expect(compareSql('SELECT a FROM t', 'SELECT a FROM t WHERE b = 1').differences).toEqual([{ line: 1, col: 15, yours: '', builder: 'WHERE b = 1' }]);
    });

    test('long statements still compare', () => {
        const list = (n) => Array.from({ length: n }, (_, i) => `c${i}`).join(', ');
        const result = compareSql(`SELECT ${list(3000)} FROM t`, `SELECT ${list(2999)}, x FROM t`);
        expect(result.same).toBe(false);
        expect(result.differences[0].builder).toBe('x');
    });
});
