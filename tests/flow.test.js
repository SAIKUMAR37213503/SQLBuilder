import { describe, expect, test } from 'vitest';
import { describeFlow, describeFlowNode, flowLines, hasFlow, FLOW_LAYOUT } from '../src/flow.js';
import { layoutGraph, LAYOUT } from '../src/diagram.js';
import { importSql } from '../src/sql-import.js';
import { EXAMPLES } from '../src/examples.js';
import { createWorkspace } from '../src/model.js';
import { generateSQL } from '../src/generator.js';

const select = (sql) => {
    const result = importSql(sql);
    if (!result.ok) throw new Error(result.message);
    return result.query;
};
const sentences = (sql) => {
    const flow = describeFlow(select(sql));
    return flow.nodes.map(n => describeFlowNode(n, flow));
};

const BIG = `WITH paid AS (SELECT customer_id, SUM(amount) AS total FROM payments WHERE status = 'paid' GROUP BY customer_id),
vip AS (SELECT customer_id FROM paid WHERE total > 1000)
SELECT c.name, p.total, recent.last_order
FROM customers AS c
INNER JOIN paid AS p ON p.customer_id = c.id
LEFT JOIN (SELECT customer_id, MAX(placed_at) AS last_order FROM orders GROUP BY customer_id) AS recent ON recent.customer_id = c.id
WHERE c.id IN (SELECT customer_id FROM vip) AND NOT EXISTS (SELECT 1 FROM refunds AS r WHERE r.customer_id = c.id)
UNION ALL
SELECT s.name, 0, NULL FROM suppliers AS s
ORDER BY 1`;

describe('what feeds what', () => {
    test('CTEs, a derived table, condition subqueries and a UNION part', () => {
        expect(sentences(BIG)).toEqual([
            'Main query: reads customers, uses paid, JOIN: 2 tables, WHERE: 2 conditions, ORDER BY',
            'paid (CTE): reads payments, WHERE: 1 condition, GROUP BY: 1 column, 1 aggregate; feeds the main query, vip',
            'vip (CTE): uses paid, WHERE: 1 condition; feeds the subquery in WHERE (c.id IN)',
            'recent (derived table in JOIN): reads orders, GROUP BY: 1 column, 1 aggregate; feeds the main query',
            'Subquery in WHERE (c.id IN): uses vip; feeds the main query',
            'Subquery in WHERE (NOT EXISTS): reads refunds, WHERE: 1 condition; feeds the main query',
            'UNION ALL part 1 (combined into the main query): reads suppliers; feeds the main query'
        ]);
        const flow = describeFlow(select(BIG));
        expect(flow.edges.map(e => [flow.nodes[e.from].title, flow.nodes[e.to].title, e.label])).toEqual([
            ['recent', 'Main query', 'LEFT JOIN'],
            ['Subquery in WHERE', 'Main query', 'IN'],
            ['Subquery in WHERE', 'Main query', 'NOT EXISTS'],
            ['UNION ALL part 1', 'Main query', 'UNION ALL'],
            ['paid', 'Main query', 'CTE'],
            ['paid', 'vip', 'CTE'],
            ['vip', 'Subquery in WHERE', 'CTE']
        ]);
    });

    test('a recursive CTE repeats on its own rows instead of linking to itself', () => {
        const flow = describeFlow(EXAMPLES.find(e => e.id === 'org-chart').build().select);
        expect(flow.nodes.map(n => describeFlowNode(n, flow))).toEqual([
            'Main query: uses reports, ORDER BY',
            'reports (CTE · recursive): reads employees, WHERE: 1 condition; feeds the main query',
            'UNION ALL part 1 (combined into reports): reads employees, repeats on new reports rows, JOIN: 1 table, WHERE: 1 condition; feeds reports'
        ]);
        expect(flow.edges.every(e => e.from !== e.to)).toBe(true);
    });

    test('a CTE reading a table of its own name, and a CTE nothing uses', () => {
        expect(sentences('WITH employees AS (SELECT id FROM employees), spare AS (SELECT 1 AS one FROM t) SELECT id FROM employees')).toEqual([
            'Main query: uses employees',
            'employees (CTE): reads table employees; feeds the main query',
            'spare (CTE): reads t; not used by any other part'
        ]);
    });

    test('subqueries in HAVING and in a join\'s ON say where they are', () => {
        const flow = describeFlow(select(`SELECT d.id, COUNT(*) FROM departments AS d
            JOIN employees AS e ON e.department_id = d.id AND e.grade IN (SELECT grade FROM grades)
            GROUP BY d.id HAVING COUNT(*) > (SELECT AVG(size) FROM team_sizes)`));
        expect(flow.nodes.map(n => [n.title, n.subtitle])).toEqual([
            ['Main query', ''],
            ['Subquery in JOIN ON', 'e.grade IN'],
            ['Subquery in HAVING', 'COUNT(*) >']
        ]);
        expect(describeFlowNode(flow.nodes[0], flow)).toBe('Main query: reads departments, employees, JOIN: 1 table, GROUP BY: 1 column, 1 aggregate, HAVING: 1 condition');
    });

    test('steps: aggregates without GROUP BY, windows, DISTINCT and limits', () => {
        const flow = describeFlow(select(`SELECT DISTINCT a FROM (SELECT COUNT(*) AS a FROM t) AS s
            WHERE a IN (SELECT ROW_NUMBER() OVER (ORDER BY x) FROM u ORDER BY 1 LIMIT 5) ORDER BY a LIMIT 10 OFFSET 2`));
        expect(flow.nodes.map(n => n.steps)).toEqual([
            ['WHERE: 1 condition', 'DISTINCT', 'ORDER BY', 'row limit'],
            ['1 aggregate: one row'],
            ['1 window function', 'ORDER BY', 'row limit']
        ]);
    });

    test('jump targets open each part\'s FROM section', () => {
        const flow = describeFlow(select(BIG));
        expect(flow.nodes.map(n => n.target.section)).toEqual([
            'select:from', 'select.ctes.0.query:from', 'select.ctes.1.query:from', 'select.joins.1.source.query:from',
            'select.where.items.0.subquery:from', 'select.where.items.1.subquery:from', 'select.setOps.0.query:from'
        ]);
    });

    test('shown only when a SELECT has more than one part', () => {
        expect(hasFlow(select('SELECT a FROM t JOIN u ON u.id = t.id'))).toBe(false);
        expect(hasFlow(select(BIG))).toBe(true);
        expect(hasFlow(createWorkspace('update').update)).toBe(false);
        expect(hasFlow(null)).toBe(false);
        expect(describeFlow(null)).toEqual({ nodes: [], edges: [] });
    });

    test('drawing never changes the query or its SQL', () => {
        for (const example of EXAMPLES) {
            const ws = example.build();
            const before = JSON.stringify(ws);
            const sql = generateSQL(ws, { dialect: 'generic' });
            if (ws.type === 'select') layoutGraph(describeFlow(ws.select), flowLines, FLOW_LAYOUT);
            expect(JSON.stringify(ws), example.id).toBe(before);
            expect(generateSQL(ws, { dialect: 'generic' }), example.id).toBe(sql);
        }
    });
});

describe('flow layout', () => {
    const big = () => describeFlow(select(BIG));

    test('every part sits above the part it feeds; the main query is at the bottom', () => {
        const flow = big();
        const { boxes } = layoutGraph(flow, flowLines, FLOW_LAYOUT);
        for (const e of flow.edges) expect(boxes[e.from].y + boxes[e.from].h, `${e.from} → ${e.to}`).toBeLessThan(boxes[e.to].y);
        expect(Math.max(...boxes.map(b => b.y))).toBe(boxes[0].y);
    });

    test('a link that skips rows passes between boxes, never behind one', () => {
        const flow = big();
        const { boxes, lines } = layoutGraph(flow, flowLines, FLOW_LAYOUT);
        const long = lines.filter(l => l.via.length);
        expect(long).toHaveLength(1);
        expect(flow.nodes[flow.edges[long[0].edge].from].title).toBe('paid');
        for (const line of long) {
            for (const [x, y] of line.via) {
                for (const b of boxes) {
                    const inside = x > b.x - LAYOUT.gapX / 2 && x < b.x + b.w + LAYOUT.gapX / 2 && y > b.y && y < b.y + b.h;
                    expect(inside, `passes behind box ${b.id}`).toBe(false);
                }
            }
        }
    });

    test('boxes never overlap, and labels sit below where each link leaves', () => {
        const flow = big();
        const { boxes, lines } = layoutGraph(flow, flowLines, FLOW_LAYOUT);
        for (const a of boxes) {
            for (const b of boxes) {
                if (a === b) continue;
                expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${a.id} and ${b.id}`).toBe(true);
            }
        }
        lines.forEach(line => expect(line.ly).toBe(line.y1 + 18));
        // Two links out of one box leave it apart
        const fromPaid = lines.filter(l => flow.edges[l.edge].from === 1).map(l => l.x1);
        expect(new Set(fromPaid).size).toBe(2);
    });

    test('the same query always gives the same picture', () => {
        expect(layoutGraph(big(), flowLines, FLOW_LAYOUT)).toEqual(layoutGraph(big(), flowLines, FLOW_LAYOUT));
    });
});
