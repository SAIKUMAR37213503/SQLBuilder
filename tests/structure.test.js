import { describe, expect, test } from 'vitest';
import { describeStructure } from '../src/structure.js';
import { EXAMPLES } from '../src/examples.js';
import { getDialect } from '../src/dialects.js';
import { createWorkspace, createSubquerySource } from '../src/model.js';

const example = (id) => EXAMPLES.find(e => e.id === id).build();
const clauses = (ws, dialect = 'generic') => describeStructure(ws, getDialect(dialect)).steps.map(s => s.clause);

describe('query structure', () => {
    test('SELECT steps follow the logical processing order, not the written order', () => {
        const { steps } = describeStructure(example('join-aggregate'), getDialect('generic'));
        expect(steps.map(s => s.clause)).toEqual(['FROM', 'JOIN', 'GROUP BY', 'HAVING', 'SELECT', 'ORDER BY']);
        expect(steps.map(s => s.detail)).toEqual([
            'customers',
            '1 join (LEFT): orders',
            '1 column',
            '1 condition',
            '3 columns, 2 aggregates',
            'revenue DESC'
        ]);
        expect(steps.map(s => s.target)).toEqual([
            { section: 'select:from' }, { section: 'select:joins' }, { section: 'select:grouping' },
            { section: 'select:grouping' }, { section: 'select:columns' }, { section: 'select:sorting' }
        ]);
        for (const step of steps) expect(step.explanation).toMatch(/\.$/);
    });

    test('CTEs, set operations, window functions and the row limit are described', () => {
        expect(clauses(example('cte'))[0]).toBe('WITH');
        expect(clauses(example('union'))).toContain('UNION');
        const window = describeStructure(example('window'), getDialect('generic')).steps.find(s => s.key === 'select');
        expect(window.detail).toBe('5 columns, 2 window functions');
        expect(window.explanation).toContain('Window functions (RANK, SUM)');
    });

    test('the row-limit step uses the dialect wording', () => {
        const ws = example('page-results');
        const limit = (dialect) => describeStructure(ws, getDialect(dialect)).steps.at(-1);
        expect(limit('generic')).toMatchObject({ clause: 'LIMIT', detail: 'LIMIT 20, skip 40' });
        expect(limit('sqlserver')).toMatchObject({ clause: 'TOP', detail: 'TOP 20, skip 40' });
    });

    test('aggregates without GROUP BY, DISTINCT and subqueries are explained', () => {
        const ws = createWorkspace();
        ws.select.distinct = true;
        ws.select.columns[0] = { kind: 'column', expr: 'id', aggregate: 'COUNT', alias: '' };
        ws.select.from = createSubquerySource();
        const { steps, notes } = describeStructure(ws, getDialect('generic'));
        expect(steps.map(s => s.clause)).toEqual(['FROM', 'Aggregate', 'SELECT DISTINCT']);
        expect(steps[0].detail).toBe('a subquery');
        expect(steps[2].explanation).toContain('DISTINCT then removes duplicate rows.');
        expect(notes).toEqual(['Also contains 1 subquery, each worked out the same way.']);
    });

    test('INSERT, UPDATE and DELETE are described, including a missing WHERE', () => {
        expect(clauses(example('insert-select'))).toEqual(['SELECT', 'INSERT INTO']);
        expect(clauses(example('upsert'), 'postgresql')).toEqual(['VALUES', 'INSERT INTO', 'ON CONFLICT']);
        expect(clauses(example('upsert'), 'mysql')).toEqual(['VALUES', 'INSERT INTO', 'ON DUPLICATE KEY']);
        // A dialect without upserts doesn't pretend there is a step for it
        expect(clauses(example('upsert'), 'sqlserver')).toEqual(['VALUES', 'INSERT INTO']);

        expect(clauses(example('update-safe'))).toEqual(['UPDATE', 'WHERE', 'SET']);
        const del = createWorkspace('delete');
        del.delete.table = 'audit_log';
        const { steps } = describeStructure(del, getDialect('generic'));
        expect(steps[1]).toMatchObject({ clause: 'No WHERE', detail: 'every row', target: { path: 'delete.where' } });
        expect(steps[1].explanation).toBe('Without WHERE, the statement will delete every row in the table.');
    });

    test('it never talks about speed or cost', () => {
        const text = EXAMPLES.flatMap(e => ['generic', 'sqlserver', 'postgresql', 'mysql'].flatMap(d => {
            const { steps, notes } = describeStructure(e.build(), getDialect(d));
            return [...steps.flatMap(s => [s.detail, s.explanation]), ...notes];
        })).join(' ');
        expect(text).not.toMatch(/fast|slow|performance|cost|index|efficient/i);
    });
});
