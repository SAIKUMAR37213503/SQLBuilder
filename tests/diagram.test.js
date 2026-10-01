import { describe, expect, test } from 'vitest';
import { describeRelations, describeEdge, layoutDiagram, nodeLines, clip, cardinality, LAYOUT } from '../src/diagram.js';
import { readDdl } from '../src/ddl.js';
import { readTables } from '../src/schema.js';
import { importSql } from '../src/sql-import.js';
import { EXAMPLES } from '../src/examples.js';
import { createWorkspace } from '../src/model.js';
import { generateSQL } from '../src/generator.js';

const SCHEMA = readTables(readDdl(`
CREATE TABLE customers (id INT PRIMARY KEY, name TEXT, region_id INT REFERENCES regions(id));
CREATE TABLE orders (id INT PRIMARY KEY, customer_id INT REFERENCES customers, placed_at DATE);
CREATE TABLE order_items (order_id INT REFERENCES orders(id), product_id INT REFERENCES products(id), qty INT, PRIMARY KEY (order_id, product_id));
CREATE TABLE products (id INT PRIMARY KEY, name TEXT, category_name TEXT);
CREATE TABLE regions (id INT PRIMARY KEY, name TEXT);
CREATE TABLE promotions (id INT PRIMARY KEY, category_name TEXT);
`).tables);

const select = (sql) => {
    const result = importSql(sql);
    if (!result.ok) throw new Error(result.message);
    return result.query;
};
const lines = (sql, tables = SCHEMA) => {
    const r = describeRelations(select(sql), { tables });
    return r.edges.map(e => describeEdge(e, r.nodes));
};

describe('which tables and links are drawn', () => {
    test('a chain of foreign keys, with which side can repeat', () => {
        expect(lines(`SELECT c.name FROM customers AS c
            INNER JOIN orders AS o ON o.customer_id = c.id
            INNER JOIN order_items AS oi ON oi.order_id = o.id
            LEFT JOIN products AS p ON p.id = oi.product_id`)).toEqual([
            'customers c to orders o: INNER JOIN on c.id = o.customer_id · one to many · a foreign key in your schema',
            'orders o to order_items oi: INNER JOIN on o.id = oi.order_id · one to many · a foreign key in your schema',
            'order_items oi to products p: LEFT JOIN on oi.product_id = p.id · many to one · a foreign key in your schema'
        ]);
    });

    test('neither side a key: many to many, and no foreign key', () => {
        const [line] = lines('SELECT p.name FROM products AS p LEFT JOIN promotions AS pr ON p.category_name = pr.category_name');
        expect(line).toBe('products p to promotions pr: LEFT JOIN on p.category_name = pr.category_name · many to many: rows can repeat');
    });

    test('without a schema: the links, but nothing about keys', () => {
        const r = describeRelations(select('SELECT 1 FROM customers AS c JOIN orders AS o ON o.customer_id = c.id'));
        expect(r.edges[0]).toMatchObject({ linked: true, fromMany: null, toMany: null, foreignKey: false });
        expect(describeEdge(r.edges[0], r.nodes)).toBe('customers c to orders o: INNER JOIN on c.id = o.customer_id');
        expect(r.nodes.map(n => n.columns)).toEqual([[{ name: 'id', key: '' }], [{ name: 'customer_id', key: '' }]]);
    });

    test('a join linked to two earlier tables gets a link from each', () => {
        const r = describeRelations(select(`SELECT 1 FROM customers AS c JOIN orders AS o ON o.customer_id = c.id
            JOIN regions AS r ON r.id = c.region_id AND r.id = o.id`), { tables: SCHEMA });
        expect(r.edges.filter(e => e.to === 2).map(e => [r.nodes[e.from].ref, e.pairs])).toEqual([
            ['c', [{ from: 'region_id', to: 'id' }]],
            ['o', [{ from: 'id', to: 'id' }]]
        ]);
    });

    test('several columns form one link; other conditions are counted', () => {
        const r = describeRelations(select(`SELECT 1 FROM orders AS o JOIN order_items AS oi
            ON oi.order_id = o.id AND oi.product_id = o.customer_id AND oi.qty > 1`), { tables: SCHEMA });
        expect(r.edges).toHaveLength(1);
        expect(r.edges[0].pairs).toHaveLength(2);
        expect(describeEdge(r.edges[0], r.nodes)).toContain('plus 1 other condition');
    });

    test('unqualified names are placed only when the schema says which table', () => {
        const known = describeRelations(select('SELECT 1 FROM customers JOIN regions ON region_id = regions.id'), { tables: SCHEMA });
        expect(known.edges[0].pairs).toEqual([{ from: 'region_id', to: 'id' }]);
        const ambiguous = describeRelations(select('SELECT 1 FROM customers JOIN regions ON name = regions.id'), { tables: SCHEMA });
        expect(ambiguous.edges[0].linked).toBe(false);
        const unknown = describeRelations(select('SELECT 1 FROM customers JOIN regions ON region_id = regions.id'));
        expect(unknown.edges[0].linked).toBe(false);
    });

    test('CROSS JOIN, an OR in ON and a one-sided ON are drawn as unlinked', () => {
        expect(lines('SELECT 1 FROM customers AS c CROSS JOIN regions AS r')).toEqual([
            'regions r: CROSS JOIN, every row paired with every row of the tables before it'
        ]);
        expect(lines('SELECT 1 FROM customers AS c JOIN regions AS r ON r.id = c.region_id OR r.id = 0')).toEqual([
            'regions r: INNER JOIN, but ON names no column of an earlier table'
        ]);
        expect(lines('SELECT 1 FROM customers AS c JOIN regions AS r ON r.id = 1')[0]).toContain('ON names no column of an earlier table');
        const r = describeRelations(select('SELECT 1 FROM customers AS c CROSS JOIN regions AS r'));
        expect(r.edges[0]).toMatchObject({ from: 0, to: 1, linked: false });
    });

    test('CTEs and derived tables are their own kinds', () => {
        const r = describeRelations(select(`WITH recent AS (SELECT customer_id FROM orders)
            SELECT 1 FROM recent AS rc JOIN (SELECT id FROM customers) AS c ON c.id = rc.customer_id`), { tables: SCHEMA });
        expect(r.nodes.map(n => [n.kind, n.name, n.ref, n.table])).toEqual([['cte', 'recent', 'rc', null], ['subquery', 'subquery', 'c', null]]);
        expect(nodeLines(r.nodes[0])).toEqual({ title: 'recent', subtitle: 'rc · CTE', columns: ['customer_id'] });
        expect(nodeLines(r.nodes[1])).toEqual({ title: 'c', subtitle: 'derived table', columns: ['id'] });
    });

    test('a schema table with an alias, and one without', () => {
        const r = describeRelations(select('SELECT 1 FROM customers JOIN regions AS r ON r.id = customers.region_id'), { tables: SCHEMA });
        expect(nodeLines(r.nodes[0])).toEqual({ title: 'customers', subtitle: 'in your schema', columns: ['region_id  FK'] });
        expect(nodeLines(r.nodes[1])).toEqual({ title: 'regions', subtitle: 'r · in your schema', columns: ['id  PK'] });
    });

    test('jump targets: FROM opens its section; a link opens its join', () => {
        const r = describeRelations(select('SELECT 1 FROM customers AS c JOIN orders AS o ON o.customer_id = c.id JOIN regions AS r ON r.id = c.region_id'));
        expect(r.nodes.map(n => n.target)).toEqual([{ section: 'select:from' }, { path: 'select.joins.0.type' }, { path: 'select.joins.1.type' }]);
        expect(r.edges.map(e => e.target.path)).toEqual(['select.joins.0.type', 'select.joins.1.type']);
    });

    test('anything that isn\'t a SELECT has nothing to draw', () => {
        expect(describeRelations(createWorkspace('update').update)).toEqual({ nodes: [], edges: [] });
        expect(describeRelations(null)).toEqual({ nodes: [], edges: [] });
    });

    test('drawing never changes the query or its SQL', () => {
        for (const example of EXAMPLES) {
            const ws = example.build();
            const before = JSON.stringify(ws);
            const sql = generateSQL(ws, { dialect: 'generic' });
            if (ws.type === 'select') layoutDiagram(describeRelations(ws.select, { tables: SCHEMA }));
            expect(JSON.stringify(ws), example.id).toBe(before);
            expect(generateSQL(ws, { dialect: 'generic' }), example.id).toBe(sql);
        }
    });
});

describe('cardinality words', () => {
    test.each([
        [false, false, 'one to one'], [true, false, 'many to one'], [false, true, 'one to many'], [true, true, 'many to many: rows can repeat'], [null, null, '']
    ])('from many %s, to many %s', (fromMany, toMany, text) => {
        expect(cardinality({ fromMany, toMany })).toBe(text);
    });
});

describe('layout', () => {
    const big = () => describeRelations(select(`SELECT 1 FROM customers AS c
        INNER JOIN orders AS o ON o.customer_id = c.id
        INNER JOIN order_items AS oi ON oi.order_id = o.id
        LEFT JOIN products AS p ON p.id = oi.product_id
        LEFT JOIN regions AS r ON r.id = c.region_id
        LEFT JOIN promotions AS pr ON pr.category_name = p.category_name
        CROSS JOIN (SELECT 1 AS one FROM regions) AS x`), { tables: SCHEMA });

    test('a table sits one row below the lowest table it links to', () => {
        const { boxes } = layoutDiagram(big());
        const rows = [...new Set(boxes.map(b => b.y))].sort((a, b) => a - b);
        const row = (id) => rows.indexOf(boxes[id].y);
        expect([0, 1, 2, 3, 4, 5, 6].map(row)).toEqual([0, 1, 2, 3, 1, 4, 1]);
    });

    test('boxes stay inside the drawing and never overlap', () => {
        const { width, height, boxes } = layoutDiagram(big());
        for (const b of boxes) {
            expect(b.x).toBeGreaterThanOrEqual(LAYOUT.margin);
            expect(b.y).toBeGreaterThanOrEqual(LAYOUT.margin);
            expect(b.x + b.w).toBeLessThanOrEqual(width - LAYOUT.margin + 1);
            expect(b.y + b.h).toBeLessThanOrEqual(height - LAYOUT.margin);
            expect(b.w).toBeGreaterThanOrEqual(LAYOUT.minWidth);
            expect(b.w).toBeLessThanOrEqual(LAYOUT.maxWidth);
        }
        for (const a of boxes) {
            for (const b of boxes) {
                if (a === b) continue;
                const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
                expect(apart, `${a.id} and ${b.id}`).toBe(true);
            }
        }
    });

    test('links go from the bottom of one box to the top of the next, labels inside the drawing', () => {
        const relations = big();
        const { width, boxes, lines: drawn } = layoutDiagram(relations);
        drawn.forEach((line, i) => {
            const edge = relations.edges[i];
            expect(line.y1).toBe(boxes[edge.from].y + boxes[edge.from].h);
            expect(line.y2).toBe(boxes[edge.to].y);
            expect(line.x2).toBeGreaterThan(boxes[edge.to].x);
            expect(line.x2).toBeLessThan(boxes[edge.to].x + boxes[edge.to].w);
            expect(line.lx - LAYOUT.labelHalf).toBeGreaterThanOrEqual(0);
            expect(line.lx + LAYOUT.labelHalf).toBeLessThanOrEqual(width);
        });
        // Labels of links leaving one table for boxes side by side don't overlap
        const fromCustomers = drawn.filter((_, i) => relations.edges[i].from === 0).map(l => l.lx).sort((a, b) => a - b);
        for (let i = 1; i < fromCustomers.length; i++) expect(fromCustomers[i] - fromCustomers[i - 1]).toBeGreaterThanOrEqual(2 * LAYOUT.labelHalf);
    });

    test('the same query always gives the same picture', () => {
        expect(layoutDiagram(big())).toEqual(layoutDiagram(big()));
    });

    test('long names are shortened, so boxes keep their width', () => {
        expect(clip('a'.repeat(40))).toBe(`${'a'.repeat(29)}…`);
        expect(clip('short')).toBe('short');
        const long = describeRelations(select(`SELECT 1 FROM ${'t'.repeat(60)} AS a JOIN u AS b ON b.id = a.${'c'.repeat(50)}`));
        const { boxes } = layoutDiagram(long);
        expect(boxes.every(b => b.w <= LAYOUT.maxWidth)).toBe(true);
        expect(nodeLines(long.nodes[0]).title).toHaveLength(LAYOUT.maxChars);
    });
});
