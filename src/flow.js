// Query flow: how the parts of a SELECT feed each other. Each SELECT in the
// query (CTEs, derived tables, subqueries in conditions, UNION parts and the
// main query) is a box listing the tables it reads and where it filters,
// groups, aggregates and sorts; a link shows which part feeds which. Built
// from the model only. Drawn with the tables and joins diagram's layout
// (diagram.js), ranked so every part sits above the part it feeds and the
// main query is at the bottom.

import { forEachSelect, countConditions, joinPath } from './model.js';
import { isAggregateColumn } from './analysis.js';
import { unquote } from './suggest.js';
import { clip } from './diagram.js';

const key = (/** @type {string} */ name) => String(name).toLowerCase();
const blank = (value) => String(value ?? '').trim() === '';
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * @typedef {{ id: number, path: string, kind: 'main' | 'cte' | 'derived' | 'condition' | 'setop',
 *   title: string, subtitle: string, reads: string[], steps: string[], uses: string[],
 *   target: { section: string } }} FlowNode
 *   reads: tables it reads directly; steps: what it does, in processing order
 * @typedef {{ from: number, to: number, label: string }} FlowEdge  from feeds to
 */

/**
 * @param {any} select the main query
 * @returns {{ nodes: FlowNode[], edges: FlowEdge[] }}
 */
export function describeFlow(select) {
    if (!select || select.kind !== 'select') return { nodes: [], edges: [] };
    /** @type {FlowNode[]} */
    const nodes = [];
    /** @type {Map<string, number>} */
    const byPath = new Map();
    forEachSelect(select, (q, sub) => {
        const id = nodes.length;
        byPath.set(sub, id);
        nodes.push(describeBlock(q, sub, select, id));
    });
    const node = (/** @type {string} */ path) => nodes[/** @type {number} */ (byPath.get(path))];
    const blockOf = (/** @type {string} */ path) => {
        const q = path ? getSelect(select, path) : select;
        return q;
    };

    /** @type {FlowEdge[]} */
    const edges = [];
    const ctes = select.ctes.map((/** @type {any} */ cte, i) => ({ cte, path: joinPath('ctes', i, 'query') }))
        .filter(c => !blank(c.cte.name));

    for (const n of nodes) {
        const q = blockOf(n.path);
        // Parts nested directly in this one feed it
        if (q.from.kind === 'subquery') edges.push({ from: node(joinPath(n.path, 'from', 'query')).id, to: n.id, label: 'FROM' });
        q.joins.forEach((/** @type {any} */ join, i) => {
            if (join.source.kind === 'subquery') edges.push({ from: node(joinPath(n.path, 'joins', i, 'source', 'query')).id, to: n.id, label: join.type });
        });
        for (const [group, clause] of [...q.joins.map((/** @type {any} */ j, i) => [j.on, joinPath('joins', i, 'on')]), [q.where, 'where'], [q.having, 'having']]) {
            conditionSubqueries(group, joinPath(n.path, clause), (item, itemPath) => {
                edges.push({ from: node(joinPath(itemPath, 'subquery')).id, to: n.id, label: item.op });
            });
        }
        q.setOps.forEach((/** @type {any} */ s, i) => edges.push({ from: node(joinPath(n.path, 'setOps', i, 'query')).id, to: n.id, label: s.op }));

        // CTEs feed the parts that read them in FROM or JOIN. Inside a
        // recursive CTE, reading itself is a step, not a link.
        for (const { cte, path } of ctes) {
            const name = key(unquote(cte.name.trim()));
            const sources = [q.from, ...q.joins.map((/** @type {any} */ j) => j.source)];
            const reads = sources.filter(s => s.kind === 'table' && !String(s.table).includes('.') && key(unquote(String(s.table).trim())) === name);
            if (!reads.length) continue;
            if (n.path === path || n.path.startsWith(`${path}.`)) {
                n.steps.unshift(cte.recursive ? `repeats on new ${cte.name.trim()} rows` : `reads table ${cte.name.trim()}`);
                continue;
            }
            n.uses.push(cte.name.trim());
            const cteNode = node(path);
            if (!edges.some(e => e.from === cteNode.id && e.to === n.id)) edges.push({ from: cteNode.id, to: n.id, label: 'CTE' });
        }
        // CTEs are boxes of their own, not tables read
        n.reads = n.reads.filter(name => !ctes.some(c => key(unquote(c.cte.name.trim())) === key(unquote(name))));
    }
    // A UNION part says what it is combined into
    for (const e of edges) {
        const part = nodes[e.from];
        if (part.kind === 'setop') part.subtitle = `combined into ${nodes[e.to].kind === 'main' ? 'the main query' : nodes[e.to].title}`;
    }
    return { nodes, edges };
}

function getSelect(root, path) {
    return path.split('.').reduce((node, k) => node?.[k], root);
}

function conditionSubqueries(group, path, visit) {
    group.items.forEach((/** @type {any} */ item, i) => {
        const itemPath = joinPath(path, 'items', i);
        if (item.kind === 'group') conditionSubqueries(item, itemPath, visit);
        else if (item.kind === 'condition' && item.valueType === 'subquery' && item.subquery) visit(item, itemPath);
    });
}

const WHERE_LABEL = { where: 'WHERE', having: 'HAVING', on: 'JOIN ON' };

/** @returns {FlowNode} */
function describeBlock(q, sub, root, id) {
    const keys = sub ? sub.split('.') : [];
    let kind = /** @type {FlowNode['kind']} */ ('main');
    let title = 'Main query';
    let subtitle = '';
    if (sub) {
        if (keys[0] === 'ctes' && keys.length === 3) {
            const cte = root.ctes[Number(keys[1])];
            kind = 'cte';
            title = blank(cte.name) ? 'CTE (no name yet)' : cte.name.trim();
            subtitle = cte.recursive ? 'CTE · recursive' : 'CTE';
        } else if (keys[keys.length - 3] === 'setOps') {
            const parent = getSelect(root, keys.slice(0, -3).join('.')) || root;
            const index = Number(keys[keys.length - 2]);
            kind = 'setop';
            title = `${parent.setOps[index].op} part ${index + 1}`;
        } else if (keys[keys.length - 1] === 'subquery') {
            const item = getSelect(root, keys.slice(0, -1).join('.'));
            // The clause nearest the subquery: WHERE, HAVING or a join's ON
            const clause = /** @type {'where' | 'having' | 'on'} */ (['where', 'having', 'on'].reduce((best, k) => (keys.lastIndexOf(k) > keys.lastIndexOf(best) ? k : best)));
            kind = 'condition';
            title = `Subquery in ${WHERE_LABEL[clause]}`;
            subtitle = blank(item.left) ? item.op : `${clip(String(item.left).trim(), 16)} ${item.op}`;
        } else {
            const source = getSelect(root, keys.slice(0, -1).join('.'));
            kind = 'derived';
            title = blank(source.alias) ? 'Derived table' : String(source.alias).trim();
            subtitle = keys.includes('joins') && keys[keys.length - 2] === 'source' ? 'derived table in JOIN' : 'derived table in FROM';
        }
    }
    const reads = [q.from, ...q.joins.map((/** @type {any} */ j) => j.source)]
        .filter(s => s.kind === 'table' && !blank(s.table)).map(s => String(s.table).trim());
    const target = { section: `${sub ? `select.${sub}` : 'select'}:from` };
    return { id, path: sub, kind, title, subtitle, reads: [...new Set(reads)], steps: blockSteps(q), uses: [], target };
}

// What a SELECT does, in the order a database works through it
function blockSteps(q) {
    const steps = [];
    if (q.joins.length) steps.push(`JOIN: ${plural(q.joins.length, 'table')}`);
    const where = countConditions(q.where);
    if (where) steps.push(`WHERE: ${plural(where, 'condition')}`);
    const aggregates = q.columns.filter(isAggregateColumn).length;
    if (q.groupBy.length) steps.push(`GROUP BY: ${plural(q.groupBy.length, 'column')}`);
    if (aggregates) steps.push(q.groupBy.length ? plural(aggregates, 'aggregate') : `${plural(aggregates, 'aggregate')}: one row`);
    const having = countConditions(q.having);
    if (having) steps.push(`HAVING: ${plural(having, 'condition')}`);
    const windows = q.columns.filter((/** @type {any} */ c) => c.kind === 'window').length;
    if (windows) steps.push(plural(windows, 'window function'));
    if (q.distinct) steps.push('DISTINCT');
    if (q.orderBy.length) steps.push('ORDER BY');
    if (!blank(q.limit) || !blank(q.offset)) steps.push(blank(q.limit) ? 'skips rows (OFFSET)' : 'row limit');
    return steps;
}

/** How the flow is laid out (see layoutGraph). */
export const FLOW_LAYOUT = Object.freeze({ rank: 'sink', labels: 'source' });

/** The lines inside a flow box. */
export function flowLines(n) {
    const reads = n.reads.length ? [`reads ${n.reads.join(', ')}`] : [];
    return {
        title: clip(n.title),
        subtitle: clip(n.subtitle || (n.kind === 'main' ? 'the result' : '')),
        columns: [...reads, ...n.steps].map(text => clip(text))
    };
}

/** One sentence per part, for the list under the drawing and screen readers. */
export function describeFlowNode(n, flow) {
    const feeds = flow.edges.filter(e => e.from === n.id).map(e => flow.nodes[e.to]);
    const parts = [];
    if (n.reads.length) parts.push(`reads ${n.reads.join(', ')}`);
    if (n.uses.length) parts.push(`uses ${n.uses.join(', ')}`);
    parts.push(...n.steps);
    const name = n.kind === 'main' ? 'Main query' : n.subtitle ? `${n.title} (${n.subtitle})` : n.title;
    const label = (/** @type {FlowNode} */ f) => (f.kind === 'main' ? 'the main query' : f.kind === 'condition' ? `the ${f.title.replace('Subquery', 'subquery')} (${f.subtitle})` : f.title);
    const into = feeds.length ? `; feeds ${feeds.map(label).join(', ')}`
        : n.kind === 'cte' ? '; not used by any other part' : '';
    return `${name}: ${parts.length ? parts.join(', ') : 'no tables yet'}${into}`;
}

/** Whether the flow is worth drawing: more than the main query alone. */
export function hasFlow(select) {
    if (!select || select.kind !== 'select') return false;
    let count = 0;
    forEachSelect(select, () => { count++; });
    return count > 1;
}
