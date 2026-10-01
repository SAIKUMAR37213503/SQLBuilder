// Draws the tables and joins diagram (diagram.js) and the query flow
// (flow.js) as inline SVG. Text goes in through textContent only. The SVG is
// a picture (aria-hidden); the list under it says the same in words, and its
// buttons open each part.

import { h } from './dom.js';
import { nodeLines, layoutDiagram, layoutGraph, describeEdge, cardinality, LAYOUT } from '../diagram.js';
import { flowLines, describeFlowNode, FLOW_LAYOUT } from '../flow.js';

const SVG = 'http://www.w3.org/2000/svg';

/**
 * @param {string} tag
 * @param {Record<string, string | number>} [attrs]
 * @param {...any} children
 */
function s(tag, attrs = {}, ...children) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    for (const child of children.flat()) {
        if (child === null || child === undefined || child === false) continue;
        el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return el;
}

const shortType = (/** @type {string} */ type) => type.replace(' JOIN', '');
const SHORT_CARDINALITY = { 'one to one': '1 : 1', 'many to one': 'many : 1', 'one to many': '1 : many', 'many to many: rows can repeat': 'many : many' };

/**
 * Draws boxes and links laid out by layoutGraph.
 * @param {any} layout
 * @param {{ id: string, lines: (box: any) => { title: string, subtitle: string, columns: string[] },
 *   boxClass: (box: any) => string, edgeClass: (line: any) => string, edgeLabel: (line: any) => string }} draw
 */
function drawGraph(layout, { id, lines: linesOf, boxClass, edgeClass, edgeLabel }) {
    const L = LAYOUT;
    const lines = layout.lines.map((/** @type {any} */ line) => {
        // Curves across the gaps between rows, straight down through a row it passes
        const points = [[line.x1, line.y1], ...(line.via || []), [line.x2, line.y2]];
        let d = `M ${line.x1} ${line.y1}`;
        for (let i = 1; i < points.length; i++) {
            const [x0, y0] = points[i - 1];
            const [x, y] = points[i];
            const mid = (y0 + y) / 2;
            d += i % 2 === 1 ? ` C ${x0} ${mid}, ${x} ${mid}, ${x} ${y}` : ` L ${x} ${y}`;
        }
        const label = edgeLabel(line);
        const width = label.length * 6.2 + 12;
        return s('g', { class: `diagram-edge ${edgeClass(line)}`.trim() },
            s('path', { d, 'marker-end': `url(#${id})` }),
            s('rect', { class: 'diagram-label-bg', x: line.lx - width / 2, y: line.ly - 9, width, height: 18, rx: 9 }),
            s('text', { class: 'diagram-label', x: line.lx, y: line.ly + 4, 'text-anchor': 'middle' }, label));
    });
    const boxes = layout.boxes.map((/** @type {any} */ box) => {
        const text = linesOf(box);
        return s('g', { class: `diagram-node ${boxClass(box)}`.trim() },
            s('rect', { x: box.x, y: box.y, width: box.w, height: box.h, rx: 6 }),
            s('text', { class: 'diagram-title', x: box.x + L.padding, y: box.y + 17 }, text.title),
            s('text', { class: 'diagram-subtitle', x: box.x + L.padding, y: box.y + 32 }, text.subtitle),
            text.columns.length ? s('line', { class: 'diagram-rule', x1: box.x, y1: box.y + L.header - 2, x2: box.x + box.w, y2: box.y + L.header - 2 }) : null,
            text.columns.map((column, i) => s('text', { class: 'diagram-column', x: box.x + L.padding, y: box.y + L.header + 12 + i * L.row }, column)));
    });
    return s('svg', {
        class: 'diagram-svg', xmlns: SVG, width: layout.width, height: layout.height,
        viewBox: `0 0 ${layout.width} ${layout.height}`, 'aria-hidden': 'true', focusable: 'false'
    },
    s('defs', {}, s('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
        s('path', { class: 'diagram-arrow', d: 'M 0 0 L 10 5 L 0 10 z' }))),
    lines, boxes);
}

/**
 * @param {{ nodes: any[], edges: any[] }} relations
 * @returns {{ svg: any, links: any }}
 */
export function renderDiagram(relations) {
    const { nodes, edges } = relations;
    const svg = drawGraph(layoutDiagram(relations), {
        id: 'diagram-arrow',
        lines: (box) => nodeLines(nodes[box.id]),
        boxClass: (box) => `diagram-${nodes[box.id].kind}${nodes[box.id].table ? ' diagram-known' : ''}`,
        edgeClass: (line) => {
            const edge = edges[line.edge];
            return `${edge.linked ? '' : 'diagram-edge-unlinked'}${edge.fromMany && edge.toMany ? ' diagram-edge-many' : ''}${edge.foreignKey ? ' diagram-edge-fk' : ''}`.trim();
        },
        edgeLabel: (line) => {
            const edge = edges[line.edge];
            return [shortType(edge.type), SHORT_CARDINALITY[cardinality(edge)] || ''].filter(Boolean).join(' · ');
        }
    });
    const links = h('ul', { class: 'diagram-links' }, edges.map(edge => h('li', {},
        h('button', { type: 'button', class: 'diagram-jump', dataset: { action: 'structure-jump', path: edge.target.path } },
            describeEdge(edge, nodes)))));
    return { svg, links };
}

/**
 * The query flow (flow.js): one box per SELECT, sources above what they feed.
 * @param {{ nodes: any[], edges: any[] }} flow
 * @returns {{ svg: any, links: any }}
 */
export function renderFlow(flow) {
    const { nodes, edges } = flow;
    const svg = drawGraph(layoutGraph(flow, flowLines, FLOW_LAYOUT), {
        id: 'flow-arrow',
        lines: (box) => flowLines(nodes[box.id]),
        boxClass: (box) => `flow-${nodes[box.id].kind}`,
        edgeClass: () => '',
        edgeLabel: (line) => edges[line.edge].label
    });
    const links = h('ul', { class: 'diagram-links' }, nodes.map(n => h('li', {},
        h('button', { type: 'button', class: 'diagram-jump', dataset: { action: 'structure-jump', section: n.target.section } },
            describeFlowNode(n, flow)))));
    return { svg, links };
}
