import { describe, expect, test } from 'vitest';
import { validateQuery, validateWorkspace } from '../src/validation.js';
import {
    describeInsights, nestingDepth, duplicateConditions, contradictions, referencedTables, joinLink, statementTexts, isUnusedAlias
} from '../src/analysis.js';
import {
    createSelect, createColumn, createCondition, createRawCondition, createGroup, createJoin, createTableSource,
    createSubquerySource, createCte, createSetOp, createGroupByItem, createUpdate, createDelete, createInsert, createWindowColumn
} from '../src/model.js';
import { EXAMPLES } from '../src/examples.js';

const ALL = ['generic', 'sqlserver', 'postgresql', 'mysql'];

function select({ table = 'orders', alias = '', columns = ['id', 'total'], ...rest } = {}) {
    return createSelect({
        columns: columns.map(c => (typeof c === 'string' ? createColumn(c) : c)),
        from: createTableSource(table, alias),
        ...rest
    });
}
const cond = (left, op, value = '', extra = {}) => createCondition({ left, op, value, ...extra });
const col = (left, op, value) => cond(left, op, value, { valueType: 'column' });
const and = (...items) => createGroup('AND', items);
const or = (...items) => createGroup('OR', items);
const join = (table, alias, on, type = 'INNER JOIN') => ({ ...createJoin(type), source: createTableSource(table, alias), on });
const subquery = (q) => cond('', 'EXISTS', '', { valueType: 'subquery', subquery: q });

/** The analysis findings for a query in one dialect, as "level: message" */
const findings = (q, dialect) => validateQuery(q, { dialect }).filter(i => i.category === 'analysis');
const texts = (q, dialect) => findings(q, dialect).map(i => `${i.level}: ${i.message}`);

// Each rule: queries that must get the finding and look-alikes that must not,
// checked in every dialect
describe.each(ALL)('analysis rules in %s', (dialect) => {
    test('plain SELECT * on the main query', () => {
        const star = findings(select({ columns: ['*'] }), dialect);
        expect(star).toEqual([expect.objectContaining({ level: 'suggestion', path: 'columns.0.expr', message: expect.stringMatching(/^SELECT \* returns every column.*may reduce the amount of data returned\.$/) })]);
        expect(findings(select({ alias: 'o', columns: ['o.*'], joins: [join('customers', 'c', and(col('c.id', '=', 'o.customer_id')))] }), dialect)).toHaveLength(1);

        // Named columns; * inside EXISTS; * from a CTE or FROM subquery, whose columns the query lists
        expect(findings(select(), dialect)).toEqual([]);
        expect(findings(select({ where: and(subquery(select({ table: 'items', columns: ['*'] }))) }), dialect)).toEqual([]);
        const cte = { ...createCte(), name: 'recent', query: select() };
        expect(findings(select({ table: 'recent', columns: ['*'], ctes: [cte] }), dialect)).toEqual([]);
        expect(findings(createSelect({ columns: [createColumn('*')], from: { ...createSubquerySource(), alias: 's', query: select() } }), dialect)).toEqual([]);
        // COUNT(*) is not SELECT *
        expect(findings(select({ columns: [createColumn('', { aggregate: 'COUNT' })] }), dialect)).toEqual([]);
    });

    test('DISTINCT together with GROUP BY', () => {
        const grouped = { distinct: true, groupBy: [createGroupByItem('customer_id')], columns: ['customer_id', createColumn('total', { aggregate: 'SUM' })] };
        expect(texts(select(grouped), dialect)).toEqual([expect.stringMatching(/^suggestion: Every grouped column is selected, so GROUP BY already returns distinct rows/)]);
        // Grouped by an alias
        expect(findings(select({ ...grouped, columns: [createColumn('customer_id', { alias: 'c' })], groupBy: [createGroupByItem('c')] }), dialect)).toHaveLength(1);

        // Without DISTINCT, or when not every key is selected (DISTINCT then changes the result)
        expect(findings(select({ ...grouped, distinct: false }), dialect)).toEqual([]);
        expect(findings(select({ ...grouped, columns: [createColumn('total', { aggregate: 'SUM' })] }), dialect)).toEqual([]);
        expect(findings(select({ ...grouped, groupBy: [createGroupByItem('customer_id'), createGroupByItem('status')] }), dialect)).toEqual([]);
        expect(findings(select({ distinct: true }), dialect)).toEqual([]);
    });

    test('duplicate conditions in one group', () => {
        const q = select({ where: and(cond('status', '=', 'paid'), cond('total', '>', '10'), cond(' STATUS ', '=', "'paid'")) });
        expect(findings(q, dialect)).toEqual([expect.objectContaining({
            level: 'suggestion', path: 'where.items.2', message: 'This WHERE condition repeats condition 1 of the same group, so one of them can be removed.'
        })]);
        expect(findings(select({ where: and(createRawCondition('a = 1'), createRawCondition('A  =  1')) }), dialect)).toHaveLength(1);
        expect(findings(select({ having: and(cond('COUNT(*)', '>', '1'), cond('count(*)', '>', '1')), groupBy: [createGroupByItem('id')], columns: ['id'] }), dialect))
            .toEqual([expect.objectContaining({ message: expect.stringContaining('This HAVING condition repeats condition 1') })]);

        // Different values, different operators, parameters (bound separately), separate groups, unfinished rows
        expect(findings(select({ where: and(cond('status', '=', 'paid'), cond('status', '!=', 'paid')) }), dialect)).toEqual([]);
        expect(findings(select({ where: and(cond('a', '=', 'x'), cond('a', '=', 'X')) }), dialect).filter(i => i.message.includes('repeats'))).toEqual([]);
        expect(findings(select({ where: and(cond('id', '=', '', { valueType: 'param' }), cond('id', '=', '', { valueType: 'param' })) }), dialect)
            .filter(i => i.message.includes('repeats'))).toEqual([]);
        expect(findings(select({ where: and(cond('a', '=', '1'), or(cond('a', '=', '1'), cond('b', '=', '2'))) }), dialect)).toEqual([]);
        expect(findings(select({ where: and(cond('', '='), cond('', '=')) }), dialect)).toEqual([]);
    });

    test('contradictory equality and range conditions', () => {
        const range = select({ where: and(cond('price', '>', '50'), cond('price', '<', '10')) });
        expect(findings(range, dialect)).toEqual([expect.objectContaining({
            level: 'warning', path: 'where.items.1.value',
            message: '“price” can\'t be > 50 and < 10 at the same time, so these WHERE conditions never match a row. Check the values, or combine them with OR.'
        })]);
        expect(texts(select({ where: and(cond('status', '=', 'paid'), cond('status', '=', "'refunded'")) }), dialect)).toHaveLength(1);
        expect(texts(select({ where: and(cond('qty', '=', '1'), cond('qty', '=', '2')) }), dialect)).toHaveLength(1);
        expect(texts(select({ where: and(cond('qty', '>=', '5'), cond('qty', 'BETWEEN', '1', { value2: '4' })) }), dialect)).toHaveLength(1);
        expect(texts(select({ where: and(cond('qty', '>', '5'), cond('qty', '<=', '5')) }), dialect)).toHaveLength(1);

        // Ranges that overlap or touch, OR groups, NOT groups, different columns
        expect(findings(select({ where: and(cond('price', '>=', '10'), cond('price', '<=', '10')) }), dialect)).toEqual([]);
        expect(findings(select({ where: and(cond('price', '>', '10'), cond('price', '<', '50')) }), dialect)).toEqual([]);
        expect(findings(select({ where: or(cond('price', '>', '50'), cond('price', '<', '10')) }), dialect)).toEqual([]);
        expect(findings(select({ where: and({ ...and(cond('price', '>', '50'), cond('price', '<', '10')), negate: true }) }), dialect)).toEqual([]);
        expect(findings(select({ where: and(cond('price', '>', '50'), cond('cost', '<', '10')) }), dialect)).toEqual([]);
        // Values some databases compare equal: case, trailing spaces, dates written two ways, leading zeros, columns, parameters
        expect(findings(select({ where: and(cond('status', '=', 'Paid'), cond('status', '=', 'paid ')) }), dialect)).toEqual([]);
        expect(findings(select({ where: and(cond('day', '=', '2026-01-01'), cond('day', '=', '2026-1-1')) }), dialect)).toEqual([]);
        expect(findings(select({ where: and(cond('code', '=', '007'), cond('code', '=', '7')) }), dialect)).toEqual([]);
        expect(findings(select({ where: and(col('a', '=', 'b'), col('a', '=', 'c')) }), dialect)).toEqual([]);
        expect(findings(select({ where: and(cond('a', '=', 'x', { valueType: 'param' }), cond('a', '=', 'y', { valueType: 'param' })) }), dialect)).toEqual([]);
    });

    test('BETWEEN with the values the wrong way round', () => {
        expect(findings(select({ where: or(cond('price', 'BETWEEN', '50', { value2: '10' })) }), dialect)).toEqual([expect.objectContaining({
            level: 'warning', message: 'BETWEEN 50 AND 10 never matches: the smaller value has to come first. Swap the two values.'
        })]);
        expect(findings(select({ where: and(cond('price', 'BETWEEN', '10', { value2: '50' })) }), dialect)).toEqual([]);
        expect(findings(select({ where: and(cond('day', 'BETWEEN', '2026-02-01', { value2: '2026-01-01' })) }), dialect)).toEqual([]);
    });

    test('unused table aliases', () => {
        const unused = select({ alias: 'o', columns: ['id', 'total'] });
        expect(findings(unused, dialect)).toEqual([expect.objectContaining({
            level: 'suggestion', path: 'from.alias',
            message: 'The alias “o” for “orders” isn\'t used. Write o.column to show which table each column comes from, or remove the alias.'
        })]);
        const byTable = select({ alias: 'o', columns: ['orders.id'] });
        expect(texts(byTable, dialect)).toEqual([expect.stringContaining('The alias “o” isn\'t used, but “orders.” is. Once a table has an alias, most databases only accept o.column')]);

        // Used in columns, in a correlated subquery, quoted, in ORDER BY; no alias at all
        expect(findings(select({ alias: 'o', columns: ['o.id'] }), dialect)).toEqual([]);
        const outer = select({ table: 'customers', alias: 'c', columns: ['name'], where: and(subquery(select({ alias: 'o', columns: ['o.id'], where: and(col('o.customer_id', '=', 'c.id')) }))) });
        expect(findings(outer, dialect)).toEqual([]);
        expect(findings(select({ alias: 'o', columns: ['"o".id'] }), dialect)).toEqual([]);
        expect(findings(select({ alias: 'o', orderBy: [{ expr: 'o.created_at', direction: 'DESC' }] }), dialect)).toEqual([]);
        expect(findings(select(), dialect)).toEqual([]);
    });

    test('a join that doesn\'t link to the tables before it', () => {
        const own = select({ alias: 'o', columns: ['o.id', 'c.name'], joins: [join('customers', 'c', and(cond('c.active', '=', '1')))] });
        expect(findings(own, dialect)).toEqual([expect.objectContaining({ level: 'warning', path: 'joins.0.on' })]);
        expect(findings(own, dialect)[0].message).toMatch(/^The ON condition only mentions “c”, not the tables before it.*may return far more rows than expected and increase the amount of data processed/);
        const earlierOnly = select({ alias: 'o', columns: ['o.id', 'c.name'], joins: [join('customers', 'c', and(cond('o.status', '=', 'paid')))] });
        expect(texts(earlierOnly, dialect)).toEqual([expect.stringMatching(/^warning: The ON condition doesn't mention “c”, the table being joined/)]);
        // Without aliases, by table name
        const named = select({ columns: ['orders.id'], joins: [join('customers', '', and(col('customers.id', '=', 'customers.parent_id')))] });
        expect(findings(named, dialect)).toHaveLength(1);

        // Linked joins, a second join linked to the first, bare names, custom SQL, CROSS JOIN, unknown names
        expect(findings(select({ alias: 'o', columns: ['o.id', 'c.name'], joins: [join('customers', 'c', and(col('c.id', '=', 'o.customer_id'), cond('c.active', '=', '1')))] }), dialect)).toEqual([]);
        const chain = select({ alias: 'o', columns: ['o.id', 'r.name'], joins: [join('customers', 'c', and(col('c.id', '=', 'o.customer_id'))), join('regions', 'r', and(col('r.id', '=', 'c.region_id')))] });
        expect(findings(chain, dialect)).toEqual([]);
        expect(findings(select({ alias: 'o', columns: ['o.id', 'c.name'], joins: [join('customers', 'c', and(col('c.id', '=', 'customer_id')))] }), dialect)).toEqual([]);
        expect(findings(select({ alias: 'o', columns: ['o.id', 'c.name'], joins: [join('customers', 'c', and(createRawCondition('c.active = 1')))] }), dialect)).toEqual([]);
        expect(findings(select({ alias: 'o', columns: ['o.id', 'c.name'], joins: [join('customers', 'c', and(), 'CROSS JOIN')] }), dialect)).toEqual([]);
        expect(findings(select({ alias: 'o', columns: ['o.id', 'c.name'], joins: [join('customers', 'c', and(col('c.id', '=', 'x.customer_id')))] }), dialect)).toEqual([]);
    });

    test('deep nesting', () => {
        let q = select({ columns: ['id'] });
        for (let i = 0; i < 3; i++) q = select({ columns: ['id'], where: and(cond('id', 'IN', '', { valueType: 'subquery', subquery: q })) });
        expect(findings(q, dialect)).toEqual([expect.objectContaining({
            level: 'suggestion', message: 'Subqueries are nested 3 levels deep. Moving inner ones into named queries (WITH) can make the query easier to read and check.'
        })]);
        // Two levels, and UNION parts (which aren't nesting)
        const two = select({ columns: ['id'], where: and(cond('id', 'IN', '', { valueType: 'subquery', subquery: select({ columns: ['id'], where: and(cond('id', 'IN', '', { valueType: 'subquery', subquery: select({ columns: ['id'] }) })) }) })) });
        expect(findings(two, dialect)).toEqual([]);
        const unions = select({ columns: ['id'], setOps: [1, 2, 3].map(() => ({ ...createSetOp('UNION'), query: select({ columns: ['id'] }) })) });
        expect(findings(unions, dialect)).toEqual([]);
    });

    test('UPDATE and DELETE conditions are checked too', () => {
        const update = { ...createUpdate(), table: 'orders', set: [{ column: 'status', valueType: 'value', value: 'void' }], where: and(cond('id', '>', '9'), cond('id', '<', '3')) };
        expect(findings(update, dialect)).toEqual([expect.objectContaining({ level: 'warning', path: 'where.items.1.value' })]);
        const del = { ...createDelete(), table: 'orders', where: and(cond('id', '=', '1'), cond('id', '=', '1')) };
        expect(findings(del, dialect)).toEqual([expect.objectContaining({ level: 'suggestion', path: 'where.items.1' })]);
        expect(findings({ ...createDelete(), table: 'orders', where: and(cond('id', '=', '1')) }, dialect)).toEqual([]);
    });
});

describe('analysis helpers', () => {
    test('duplicateConditions and contradictions point at both conditions', () => {
        expect(duplicateConditions(and(cond('a', '=', '1'), cond('b', '=', '1'), cond('a', '=', '1')))).toEqual([{ index: 2, first: 0 }]);
        expect(contradictions(and(cond('a', '<', '5'), cond('b', '=', '1'), cond('a', '=', '8')))).toEqual([
            { index: 2, first: 0, column: 'a', text: '= 8', firstText: '< 5' }
        ]);
        // Numbers compare as numbers
        expect(contradictions(and(cond('a', '=', '1.0'), cond('a', '=', '1')))).toEqual([]);
        expect(contradictions(and(cond('a', '=', '1e3'), cond('a', '<', '1000')))).toHaveLength(1);
    });

    test('referencedTables reads qualified names and gives up on anything uncertain', () => {
        expect([...referencedTables(and(col('o.customer_id', '=', 'c.id'), cond('c.active', '=', '1')))].sort()).toEqual(['c', 'o']);
        expect([...referencedTables(and(col('sales.orders.id', '=', '"C".id')))].sort()).toEqual(['c', 'orders']);
        expect([...referencedTables(and(col('LOWER(o.email)', '=', 'LOWER(c.email)')))].sort()).toEqual(['c', 'o']);
        expect(referencedTables(and(col('id', '=', 'c.id')))).toBeNull();
        expect(referencedTables(and(createRawCondition('o.id = c.id')))).toBeNull();
        expect(referencedTables(and(cond('o.id', '=', '', { valueType: 'param' })))).toBeNull();
    });

    test('joinLink', () => {
        expect(joinLink(join('c', '', and(col('c.id', '=', 'o.cid'))), ['o'])).toBeNull();
        expect(joinLink(join('c', '', and(cond('c.x', '=', '1'))), ['o'])).toBe('unlinked-earlier');
        expect(joinLink(join('c', '', and(cond('o.x', '=', '1'))), ['o'])).toBe('unlinked-joined');
        expect(joinLink(join('s.c', '', and(cond('c.x', '=', '1'))), ['o'])).toBe('unlinked-earlier');
    });

    test('alias references ignore the alias fields themselves', () => {
        const q = select({ alias: 'o', columns: [createColumn('total', { alias: 'o' })] });
        expect(statementTexts(q)).toEqual([]);
        expect(isUnusedAlias(q.from, statementTexts(q))).toBe(true);
        expect(isUnusedAlias(createTableSource('orders', 'o'), ['[o].id'])).toBe(false);
        expect(isUnusedAlias(createTableSource('orders', 'o'), ['foo.id'])).toBe(true);
        expect(isUnusedAlias(createTableSource('orders', 'o'), ['x.o.id'])).toBe(true);
    });
});

describe('insights', () => {
    test('counts the parts of a query and never mentions speed', () => {
        const cte = { ...createCte(), name: 'big', query: select({ columns: ['customer_id'], where: and(cond('total', '>', '100')) }) };
        const window = { ...createWindowColumn(), func: 'ROW_NUMBER', orderBy: [{ expr: 'id', direction: 'ASC' }], alias: 'n' };
        const q = select({
            alias: 'o', ctes: [cte],
            columns: ['o.customer_id', createColumn('o.total', { aggregate: 'SUM' }), window],
            joins: [join('customers', 'c', and(col('c.id', '=', 'o.customer_id')))],
            where: and(cond('o.status', '=', 'paid'), subquery(select({ table: 'big', columns: ['customer_id'] }))),
            groupBy: [createGroupByItem('o.customer_id')],
            setOps: [{ ...createSetOp('UNION'), query: select({ columns: ['id', 'total', 'n'] }) }]
        });
        expect(describeInsights(q)).toEqual({ ctes: 1, joins: 1, subqueries: 1, setOps: 1, aggregates: 1, windows: 1, filters: 3, depth: 1, band: 'involved' });
        expect(JSON.stringify(describeInsights(q))).not.toMatch(/fast|slow|speed|perform/i);
    });

    test('bands', () => {
        expect(describeInsights(select()).band).toBe('simple');
        expect(describeInsights(select({ alias: 'o', joins: [join('customers', 'c', and(col('c.id', '=', 'o.cid')))], groupBy: [createGroupByItem('c.id')], columns: [createColumn('', { aggregate: 'COUNT' })] })).band).toBe('moderate');
        let deep = select();
        for (let i = 0; i < 3; i++) deep = select({ where: and(cond('id', 'IN', '', { valueType: 'subquery', subquery: deep })) });
        expect(nestingDepth(deep)).toBe(3);
        expect(describeInsights(deep).band).toBe('involved');
    });

    test('every example has a band', () => {
        for (const example of EXAMPLES) {
            const ws = example.build();
            if (ws.type === 'select') expect(['simple', 'moderate', 'involved']).toContain(describeInsights(ws.select).band);
        }
    });
});

describe('examples', () => {
    // The only analysis finding among the examples is the deliberate SELECT *
    test('no example gains an unexpected analysis finding', () => {
        const found = [];
        for (const example of EXAMPLES) {
            for (const dialect of example.dialects ?? ALL) {
                for (const issue of validateWorkspace(example.build(), { dialect })) {
                    if (issue.category === 'analysis') found.push(`${example.id}/${dialect}: ${issue.level} ${issue.path}`);
                }
            }
        }
        expect(found.sort()).toEqual(ALL.map(d => `nested-conditions/${d}: suggestion select.columns.0.expr`).sort());
    });

    test('an INSERT … SELECT is analysed like any other query', () => {
        const insert = { ...createInsert(), table: 'archive', source: 'select', select: select({ alias: 'o', columns: ['id'] }) };
        expect(findings(insert, 'generic')).toEqual([expect.objectContaining({ level: 'suggestion', path: 'select.from.alias' })]);
    });
});
