// Draws the tables and joins diagram (see diagram.js) as inline SVG. Text goes
// in through textContent only. The SVG is a picture (aria-hidden); the list of
// links under it says the same in words and its buttons open each part.

import { h } from './dom.js';
import { nodeLines, layoutDiagram, describeEdge, cardinality, LAYOUT } from '../diagram.js';

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
 * @param {{ nodes: any[], edges: any[] }} relations
 * @returns {{ svg: any, links: any }}
 */
export function renderDiagram(relations) {
    const { nodes, edges } = relations;
    const layout = layoutDiagram(relations);
    const L = LAYOUT;

    const lines = layout.lines.map(line => {
        const edge = edges[line.edge];
        const mid = (line.y1 + line.y2) / 2;
        const d = `M ${line.x1} ${line.y1} C ${line.x1} ${mid}, ${line.x2} ${mid}, ${line.x2} ${line.y2}`;
        const many = edge.fromMany && edge.toMany;
        const label = [shortType(edge.type), SHORT_CARDINALITY[cardinality(edge)] || ''].filter(Boolean).join(' · ');
        const width = label.length * 6.2 + 12;
        return s('g', { class: `diagram-edge${edge.linked ? '' : ' diagram-edge-unlinked'}${many ? ' diagram-edge-many' : ''}${edge.foreignKey ? ' diagram-edge-fk' : ''}` },
            s('path', { d, 'marker-end': 'url(#diagram-arrow)' }),
            s('rect', { class: 'diagram-label-bg', x: line.lx - width / 2, y: line.ly - 9, width, height: 18, rx: 9 }),
            s('text', { class: 'diagram-label', x: line.lx, y: line.ly + 4, 'text-anchor': 'middle' }, label));
    });

    const boxes = layout.boxes.map(box => {
        const n = nodes[box.id];
        const text = nodeLines(n);
        return s('g', { class: `diagram-node diagram-${n.kind}${n.table ? ' diagram-known' : ''}` },
            s('rect', { x: box.x, y: box.y, width: box.w, height: box.h, rx: 6 }),
            s('text', { class: 'diagram-title', x: box.x + L.padding, y: box.y + 17 }, text.title),
            s('text', { class: 'diagram-subtitle', x: box.x + L.padding, y: box.y + 32 }, text.subtitle),
            text.columns.length ? s('line', { class: 'diagram-rule', x1: box.x, y1: box.y + L.header - 2, x2: box.x + box.w, y2: box.y + L.header - 2 }) : null,
            text.columns.map((column, i) => s('text', { class: 'diagram-column', x: box.x + L.padding, y: box.y + L.header + 12 + i * L.row }, column)));
    });

    const svg = s('svg', {
        class: 'diagram-svg', xmlns: SVG, width: layout.width, height: layout.height,
        viewBox: `0 0 ${layout.width} ${layout.height}`, 'aria-hidden': 'true', focusable: 'false'
    },
    s('defs', {}, s('marker', { id: 'diagram-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
        s('path', { class: 'diagram-arrow', d: 'M 0 0 L 10 5 L 0 10 z' }))),
    lines, boxes);

    const links = h('ul', { class: 'diagram-links' }, edges.map(edge => h('li', {},
        h('button', { type: 'button', class: 'diagram-jump', dataset: { action: 'structure-jump', path: edge.target.path } },
            describeEdge(edge, nodes)))));
    return { svg, links };
}
