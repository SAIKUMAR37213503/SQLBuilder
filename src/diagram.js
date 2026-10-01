// Tables and joins diagram: the main SELECT's FROM and JOIN sources as boxes,
// and the links its ON conditions make between them. Built from the query
// model, plus the local schema when there is one (keys, foreign keys, and
// whether a row can match one or many rows). No DOM here: describeRelations
// says what to draw and layoutDiagram where; ui/diagram.js draws it.
//
// Nothing is guessed: a column whose table can't be told from its name is
// left out, and a join whose ON names no earlier table is drawn as unlinked.

import { lookupTable, unquote } from './suggest.js';
import { coversKey } from './joins.js';
import { isColumnReference, isQualifiedName } from './sql-utils.js';

const key = (/** @type {string} */ name) => String(name).toLowerCase();
const blank = (value) => String(value ?? '').trim() === '';

/**
 * @typedef {{ name: string, key: string }} DiagramColumn  key: 'PK', 'FK', 'PK, FK' or ''
 * @typedef {{ id: number, kind: 'table' | 'cte' | 'subquery', name: string, alias: string, ref: string,
 *   table: any | null, columns: DiagramColumn[], target: { section?: string, path?: string } }} DiagramNode
 * @typedef {{ from: string, to: string }} DiagramPair  column names on each side, as written
 * @typedef {{ join: number, type: string, from: number, to: number, linked: boolean, pairs: DiagramPair[],
 *   other: number, fromMany: boolean | null, toMany: boolean | null, foreignKey: boolean,
 *   target: { path: string } }} DiagramEdge
 *   fromMany / toMany: whether one row on the other side can match several rows on this side;
 *   null when the schema can't tell
 */

/**
 * @param {any} select the main query
 * @param {{ tables?: any[] }} [env]
 * @returns {{ nodes: DiagramNode[], edges: DiagramEdge[] }}
 */
export function describeRelations(select, { tables = [] } = {}) {
    if (!select || select.kind !== 'select') return { nodes: [], edges: [] };
    const cteNames = new Set(select.ctes.map((/** @type {any} */ c) => key(unquote(String(c.name || '').trim()))).filter(Boolean));
    const sources = [select.from, ...select.joins.map((/** @type {any} */ j) => j.source)];
    /** @type {DiagramNode[]} */
    const nodes = sources.map((source, id) => node(source, id, cteNames, tables));
    /** @type {DiagramEdge[]} */
    const edges = [];
    select.joins.forEach((/** @type {any} */ join, i) => {
        const target = nodes[i + 1];
        const earlier = nodes.slice(0, i + 1);
        const found = join.type === 'CROSS JOIN' ? { links: new Map(), other: 0 } : linksOf(join.on, target, earlier);
        const path = `select.joins.${i}.type`;
        if (!found.links.size) {
            edges.push({ join: i, type: join.type, from: 0, to: target.id, linked: false, pairs: [], other: found.other, fromMany: null, toMany: null, foreignKey: false, target: { path } });
            return;
        }
        for (const [fromId, pairs] of found.links) {
            const from = nodes[fromId];
            for (const p of pairs) {
                addColumn(from, p.from);
                addColumn(target, p.to);
            }
            const fromColumns = pairs.map(p => p.from);
            const toColumns = pairs.map(p => p.to);
            const known = Boolean(from.table && target.table);
            edges.push({
                join: i, type: join.type, from: fromId, to: target.id, linked: true, pairs, other: found.other,
                fromMany: known ? !coversKey(from.table, fromColumns) : null,
                toMany: known ? !coversKey(target.table, toColumns) : null,
                foreignKey: known && (foreignKeyBetween(from.table, fromColumns, target.table, toColumns, tables)
                    || foreignKeyBetween(target.table, toColumns, from.table, fromColumns, tables)),
                target: { path }
            });
        }
    });
    for (const n of nodes) n.columns = n.columns.map(c => ({ ...c, key: columnKey(n.table, c.name) }));
    return { nodes, edges };
}

/** @returns {DiagramNode} */
function node(source, id, cteNames, tables) {
    const target = id === 0 ? { section: 'select:from' } : { path: `select.joins.${id - 1}.type` };
    const alias = String(source?.alias || '').trim();
    if (!source || source.kind === 'subquery') {
        return { id, kind: 'subquery', name: 'subquery', alias, ref: alias, table: null, columns: [], target };
    }
    const name = String(source.table || '').trim();
    const cte = Boolean(name) && !name.includes('.') && cteNames.has(key(unquote(name)));
    const table = !cte && name && isQualifiedName(name) ? lookupTable(tables, name.split('.').map(unquote).join('.')) || null : null;
    return { id, kind: cte ? 'cte' : 'table', name: name || 'table not set', alias, ref: alias || name, table, columns: [], target };
}

function addColumn(n, name) {
    if (!n.columns.some(c => key(unquote(c.name)) === key(unquote(name)))) n.columns.push({ name, key: '' });
}

// The node a column reference belongs to: by its qualifier, or by the schema
// when it is unqualified and only one of the tables has that column
function owner(text, candidates) {
    const ref = String(text || '').trim();
    if (!isColumnReference(ref) || ref.endsWith('*')) return null;
    const parts = ref.split('.');
    const column = parts[parts.length - 1];
    if (parts.length > 1) {
        const qualifier = key(unquote(parts.slice(0, -1).join('.')));
        const matches = candidates.filter((/** @type {DiagramNode} */ n) => n.ref && key(unquote(n.ref)) === qualifier);
        return matches.length === 1 ? { node: matches[0], column } : null;
    }
    const matches = candidates.filter((/** @type {DiagramNode} */ n) => n.table && n.table.columns.some((/** @type {any} */ c) => key(c.name) === key(unquote(column))));
    return matches.length === 1 ? { node: matches[0], column } : null;
}

// The column = column conditions at the top of the ON's AND group that link
// the joined table to an earlier one, grouped by that earlier table
function linksOf(on, target, earlier) {
    /** @type {Map<number, DiagramPair[]>} */
    const links = new Map();
    let other = 0;
    if (on.logic !== 'AND' || on.negate) {
        return { links, other: on.items.length };
    }
    for (const item of on.items) {
        if (item.kind === 'condition' && blank(item.left) && blank(item.value)) continue;
        const a = item.kind === 'condition' && item.op === '=' && item.valueType === 'column' ? owner(item.left, [...earlier, target]) : null;
        const b = a ? owner(item.value, [...earlier, target]) : null;
        if (a && b && (a.node === target) !== (b.node === target)) {
            const [mine, theirs] = a.node === target ? [a, b] : [b, a];
            const list = links.get(theirs.node.id) || [];
            list.push({ from: theirs.column, to: mine.column });
            links.set(theirs.node.id, list);
        } else {
            other++;
        }
    }
    return { links, other };
}

function columnKey(table, name) {
    if (!table) return '';
    const column = key(unquote(name));
    const marks = [];
    if (table.primaryKey.some((/** @type {string} */ c) => key(c) === column)) marks.push('PK');
    if (table.foreignKeys.some((/** @type {any} */ fk) => fk.columns.some((/** @type {string} */ c) => key(c) === column))) marks.push('FK');
    return marks.join(', ');
}

// Does a foreign key of `table` on `columns` point at `refTable`'s `refColumns`?
function foreignKeyBetween(table, columns, refTable, refColumns, tables) {
    const want = (/** @type {string[]} */ list) => list.map(c => key(unquote(c))).sort().join(',');
    return table.foreignKeys.some((/** @type {any} */ fk) => lookupTable(tables, fk.refTable) === refTable
        && want(fk.columns) === want(columns)
        && want(fk.refColumns.length ? fk.refColumns : refTable.primaryKey) === want(refColumns));
}

/** One line per link, for the list under the diagram and screen readers. */
export function describeEdge(edge, nodes) {
    const from = nodes[edge.from];
    const to = nodes[edge.to];
    const label = (/** @type {DiagramNode} */ n) => (n.alias && n.alias !== n.name ? `${n.name} ${n.alias}` : n.name);
    if (!edge.linked) {
        return edge.type === 'CROSS JOIN'
            ? `${label(to)}: CROSS JOIN, every row paired with every row of the tables before it`
            : `${label(to)}: ${edge.type}, but ON names no column of an earlier table`;
    }
    const on = edge.pairs.map(p => `${from.ref}.${p.from} = ${to.ref}.${p.to}`).join(' AND ');
    const parts = [`${label(from)} to ${label(to)}: ${edge.type} on ${on}`];
    if (edge.other) parts.push(`plus ${edge.other} other condition${edge.other === 1 ? '' : 's'}`);
    if (edge.toMany !== null && edge.fromMany !== null) parts.push(cardinality(edge));
    if (edge.foreignKey) parts.push('a foreign key in your schema');
    return parts.join(' · ');
}

/** "each row matches at most one" and so on, from the schema's keys. */
export function cardinality(edge) {
    if (edge.toMany === null || edge.fromMany === null) return '';
    if (!edge.toMany && !edge.fromMany) return 'one to one';
    if (!edge.toMany) return 'many to one';
    if (!edge.fromMany) return 'one to many';
    return 'many to many: rows can repeat';
}

// ---------------------------------------------------------------------------
// Layout: top to bottom. A table sits one row below the lowest table its ON
// links to, so chains go down and lookups from one table sit side by side.
// Text is measured as monospace characters, so the layout needs no DOM.
// ---------------------------------------------------------------------------

export const LAYOUT = Object.freeze({
    charWidth: 7.2, labelHalf: 56, minWidth: 120, maxWidth: 240, header: 40, row: 18, padding: 8, gapX: 28, gapY: 64, margin: 12, maxChars: 30
});

/** Shortens text to `max` characters with an ellipsis. */
export function clip(text, max = LAYOUT.maxChars) {
    const value = String(text);
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** The lines inside a box: its title, a subtitle and its columns. */
export function nodeLines(n) {
    const kind = n.kind === 'cte' ? 'CTE' : n.kind === 'subquery' ? 'derived table' : n.table ? 'in your schema' : 'table';
    return {
        title: clip(n.kind === 'subquery' ? (n.alias || 'subquery') : n.name),
        subtitle: clip(n.kind === 'subquery' ? kind : [n.alias && n.alias !== n.name ? n.alias : '', kind].filter(Boolean).join(' · ')),
        columns: n.columns.map(c => clip(c.key ? `${c.name}  ${c.key}` : c.name))
    };
}

/**
 * @param {{ nodes: DiagramNode[], edges: DiagramEdge[] }} relations
 * @returns {{ width: number, height: number, boxes: { id: number, x: number, y: number, w: number, h: number }[],
 *   lines: { edge: number, x1: number, y1: number, x2: number, y2: number, lx: number, ly: number }[] }}
 */
export function layoutDiagram({ nodes, edges }) {
    const L = LAYOUT;
    const layer = nodes.map(() => 0);
    for (const n of nodes.slice(1)) {
        const parents = edges.filter(e => e.to === n.id).map(e => e.from);
        layer[n.id] = 1 + Math.max(0, ...parents.map(p => layer[p]));
    }
    const size = nodes.map(n => {
        const lines = nodeLines(n);
        const longest = Math.max(...[lines.title, lines.subtitle, ...lines.columns].map(t => t.length));
        return {
            w: Math.round(Math.min(L.maxWidth, Math.max(L.minWidth, longest * L.charWidth + 2 * L.padding))),
            h: L.header + lines.columns.length * L.row + (lines.columns.length ? L.padding : 0)
        };
    });
    const layers = [...new Set(layer)].sort((a, b) => a - b).map(k => nodes.filter(n => layer[n.id] === k).map(n => n.id));
    const rowWidth = (/** @type {number[]} */ ids) => ids.reduce((sum, id) => sum + size[id].w, 0) + (ids.length - 1) * L.gapX;
    const width = Math.max(...layers.map(rowWidth)) + 2 * L.margin;
    /** @type {{ id: number, x: number, y: number, w: number, h: number }[]} */
    const boxes = [];
    let y = L.margin;
    for (const ids of layers) {
        let x = (width - rowWidth(ids)) / 2;
        for (const id of ids) {
            boxes[id] = { id, x: Math.round(x), y, w: size[id].w, h: size[id].h };
            x += size[id].w + L.gapX;
        }
        y += Math.max(...ids.map(id => size[id].h)) + L.gapY;
    }
    const height = y - L.gapY + L.margin;

    // Several links into one box enter its top side spread apart. Each label
    // sits just above where its link enters, so labels of links from one
    // table to boxes side by side don't overlap; labels into one box step up.
    const lines = edges.map((e, i) => {
        const a = boxes[e.from];
        const b = boxes[e.to];
        const into = edges.filter(o => o.to === e.to);
        const slot = (into.indexOf(e) + 1) / (into.length + 1);
        const x1 = a.x + a.w / 2;
        const y1 = a.y + a.h;
        const x2 = Math.round(b.x + b.w * slot);
        const y2 = b.y;
        const lx = Math.round(Math.min(Math.max(x2, L.labelHalf), width - L.labelHalf));
        return { edge: i, x1, y1, x2, y2, lx, ly: Math.round(y2 - 20 - into.indexOf(e) * 20) };
    });
    return { width: Math.round(width), height: Math.round(height), boxes, lines };
}
