import { describe, expect, test } from 'vitest';
import {
    splitTopLevel, findSyntaxProblem, countColumns, containsAggregateCall, normalizeExpr,
    isIdentifier, isQualifiedName, isColumnReference, findBareWord
} from '../src/sql-utils.js';
import { tokenize } from '../src/tokenizer.js';

describe('splitTopLevel', () => {
    test('ignores separators inside parentheses and quotes', () => {
        expect(splitTopLevel("a, CONCAT(b, c), 'x,y', \"q,r\"")).toEqual(['a', 'CONCAT(b, c)', "'x,y'", '"q,r"']);
    });

    test('handles doubled quotes inside strings', () => {
        expect(splitTopLevel("'it''s, fine', 2")).toEqual(["'it''s, fine'", '2']);
    });
});

describe('findSyntaxProblem', () => {
    test.each([
        ['a + (b * c)', null],
        ["name = 'x;y'", null],
        ['(a', 'has an opening "(" without a matching ")"'],
        ['a)', 'has a closing ")" without a matching "("'],
        ["'abc", "has a text value that is missing its closing ' quote"],
        ['"abc', 'has an identifier that is missing its closing " quote'],
        ['1; DROP TABLE x', 'contains ";" — statements can\'t be chained here'],
        ['a -- comment', 'contains "--", which would comment out the rest of the line']
    ])('%s', (input, expected) => {
        expect(findSyntaxProblem(input)).toBe(expected);
    });
});

describe('identifiers', () => {
    test('identifier rules', () => {
        expect(isIdentifier('employees')).toBe(true);
        expect(isIdentifier('_x$1')).toBe(true);
        expect(isIdentifier('"Mixed Case"')).toBe(true);
        expect(isIdentifier('[Order Details]')).toBe(true);
        expect(isIdentifier('`back tick`')).toBe(true);
        expect(isIdentifier('café')).toBe(true);
        expect(isIdentifier('1abc')).toBe(false);
        expect(isIdentifier('a b')).toBe(false);
        expect(isIdentifier("x'; DROP")).toBe(false);
    });

    test('qualified names and column references', () => {
        expect(isQualifiedName('db.schema.table')).toBe(true);
        expect(isQualifiedName('a.b.c.d')).toBe(false);
        expect(isColumnReference('t.*')).toBe(true);
        expect(isColumnReference('SUM(x)')).toBe(false);
    });
});

describe('column helpers', () => {
    test('countColumns', () => {
        expect(countColumns('a, b')).toBe(2);
        expect(countColumns("CONCAT(first, ' ', last), COALESCE(a, b, c)")).toBe(2);
        expect(countColumns('*')).toBe(-1);
        expect(countColumns('a, t.*')).toBe(-1);
        expect(countColumns('')).toBe(0);
    });

    test('containsAggregateCall ignores string contents', () => {
        expect(containsAggregateCall('count ( * )')).toBe(true);
        expect(containsAggregateCall("'SUM(x)'")).toBe(false);
        expect(containsAggregateCall('summary')).toBe(false);
    });

    test('normalizeExpr ignores case/whitespace outside strings', () => {
        expect(normalizeExpr('Upper( Name )')).toBe(normalizeExpr('upper(name)'));
        expect(normalizeExpr("a = 'X Y'")).not.toBe(normalizeExpr("a = 'x y'"));
    });
});

describe('tokenize', () => {
    const types = (sql) => tokenize(sql).filter(t => t.type !== 'text').map(t => `${t.type}:${t.text}`);

    test('classifies tokens', () => {
        expect(types("SELECT COUNT(*) FROM t WHERE a >= 10 AND b = 'x'")).toEqual([
            'keyword:SELECT', 'func:COUNT', 'punct:(', 'operator:*', 'punct:)', 'keyword:FROM',
            'keyword:WHERE', 'operator:>=', 'number:10', 'keyword:AND', 'operator:=', "string:'x'"
        ]);
    });

    test('multi-word keywords and quoted identifiers', () => {
        expect(types('LEFT JOIN "select" ON x IS NOT NULL')).toEqual([
            'keyword:LEFT JOIN', 'identifier:"select"', 'keyword:ON', 'keyword:IS NOT NULL'
        ]);
    });

    test('keywords inside strings are not highlighted', () => {
        expect(types("'SELECT FROM'")).toEqual(["string:'SELECT FROM'"]);
    });

    test('round-trips the input exactly', () => {
        const sql = "SELECT a,\n    b -- note\nFROM [t] WHERE x = 'it''s' AND y <> 2;";
        expect(tokenize(sql).map(t => t.text).join('')).toBe(sql);
    });
});

describe('tokenize: window functions and set operators', () => {
    test('keywords', () => {
        const kinds = tokenize('RANK() OVER (PARTITION BY d ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) INTERSECT ALL EXCEPT')
            .filter(t => t.type === 'keyword').map(t => t.text);
        expect(kinds).toEqual(['OVER', 'PARTITION BY', 'ROWS', 'BETWEEN', 'PRECEDING', 'AND', 'CURRENT ROW', 'INTERSECT ALL', 'EXCEPT']);
    });
});

describe('hasTopLevelLogic / hasLeadingZero', () => {
    test('finds AND / OR only outside quotes and parentheses', async () => {
        const { hasTopLevelLogic } = await import('../src/sql-utils.js');
        expect(hasTopLevelLogic('a = 1 OR b = 2')).toBe(true);
        expect(hasTopLevelLogic('a = 1 and b = 2')).toBe(true);
        expect(hasTopLevelLogic('(a = 1 OR b = 2)')).toBe(false);
        expect(hasTopLevelLogic("x = 'A OR B'")).toBe(false);
        expect(hasTopLevelLogic('"order" = 1')).toBe(false);
        expect(hasTopLevelLogic('[and] = 1')).toBe(false);
        expect(hasTopLevelLogic('orders.id = brand_id')).toBe(false);
        expect(hasTopLevelLogic('x BETWEEN 1 AND 5')).toBe(true);
    });

    test('leading zeros', async () => {
        const { hasLeadingZero } = await import('../src/sql-utils.js');
        expect(['01', '007', '-01', '00.5'].map(hasLeadingZero)).toEqual([true, true, true, true]);
        expect(['0', '0.5', '10', 'abc', '0x1'].map(hasLeadingZero)).toEqual([false, false, false, false, false]);
    });
});

describe('tokenize: new syntax', () => {
    test('parameters, upsert keywords and INSERT INTO table (…)', async () => {
        const { tokenize } = await import('../src/tokenizer.js');
        const types = (sql) => tokenize(sql).filter(t => t.type !== 'text').map(t => `${t.type}:${t.text}`);
        expect(types('a = $1 AND b = ? AND c = @p AND d = :n AND e::int = 1')).toEqual([
            'operator:=', 'param:$1', 'keyword:AND', 'operator:=', 'param:?', 'keyword:AND', 'operator:=', 'param:@p',
            'keyword:AND', 'operator:=', 'param::n', 'keyword:AND', 'operator:=', 'number:1'
        ]);
        expect(types('ON CONFLICT (id) DO NOTHING')).toEqual(['keyword:ON CONFLICT', 'punct:(', 'punct:)', 'keyword:DO NOTHING']);
        expect(types('INSERT INTO t (a) VALUES (LOWER(x))')).toEqual([
            'keyword:INSERT INTO', 'punct:(', 'punct:)', 'keyword:VALUES', 'punct:(', 'func:LOWER', 'punct:(', 'punct:)', 'punct:)'
        ]);
    });
});

describe('findBareWord', () => {
    test('finds words outside quotes and quoted identifiers, in any case', () => {
        expect(findBareWord('is_active = false', ['TRUE', 'FALSE'])).toBe('false');
        expect(findBareWord('COALESCE(flag, TRUE)', ['TRUE', 'FALSE'])).toBe('TRUE');
        expect(findBareWord("status = 'true' AND [false] = 1 AND \"true\" = `false`", ['TRUE', 'FALSE'])).toBe('');
        expect(findBareWord('untrue_flag = 1', ['TRUE'])).toBe('');
    });
});
