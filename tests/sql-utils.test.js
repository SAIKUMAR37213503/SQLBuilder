import { describe, expect, test } from 'vitest';
import {
    splitTopLevel, findSyntaxProblem, countColumns, containsAggregateCall, normalizeExpr,
    isIdentifier, isQualifiedName, isColumnReference
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
