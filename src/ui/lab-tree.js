// The SQL Lab explorer's tree, laid out like SQL Server Management Studio's
// Object Explorer: Databases → a database → Tables / Views → a table →
// Columns / Keys. Folders open and close with their arrow (or the Right and
// Left arrow keys); the names keep their own actions (open a database, show
// a table). Which folders are open is kept in a set of keys.

import { h } from './dom.js';

const SVG = 'http://www.w3.org/2000/svg';

// 16×16 outline icons, coloured by CSS (see .lab-icon-* in style.css)
const ICONS = {
    database: 'M8 2c3 0 5 .9 5 2v8c0 1.1-2 2-5 2s-5-.9-5-2V4c0-1.1 2-2 5-2zM3 4c0 1.1 2 2 5 2s5-.9 5-2M3 8c0 1.1 2 2 5 2s5-.9 5-2',
    folder: 'M2 4.5C2 3.7 2.7 3 3.5 3H6l1.5 1.5h5c.8 0 1.5.7 1.5 1.5v5.5c0 .8-.7 1.5-1.5 1.5h-9C2.7 13 2 12.3 2 11.5z',
    table: 'M2.5 3h11v10h-11zM2.5 6.5h11M2.5 9.75h11M6.5 6.5V13',
    view: 'M2.5 3h11v10h-11zM2.5 6.5h11M5 9.5c1.6-1.6 4.4-1.6 6 0-1.6 1.6-4.4 1.6-6 0z',
    column: 'M4 2.5h8v11H4zM4 6h8M4 9.5h8',
    key: 'M6 10a3 3 0 1 1 2.6-1.5L13.5 13.5M11 11l1.5-1.5M12.5 12.5 14 11',
    link: 'M6.5 9.5l3-3M5.2 7.8 3.9 9.1a2.1 2.1 0 0 0 3 3l1.3-1.3M10.8 8.2l1.3-1.3a2.1 2.1 0 0 0-3-3L7.8 5.2'
};

/** A small outline icon. */
export function icon(name) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', `lab-icon lab-icon-${name}`);
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', ICONS[name]);
    svg.append(path);
    return svg;
}

/**
 * The arrow that opens or closes a node. Without children it is a spacer, so
 * names line up.
 * @param {string | null} key the node's key, or null when it has no children
 * @param {boolean} open
 * @param {string} label what it opens, for screen readers ("Columns of Employees")
 * @param {{ disabled?: boolean }} [options]
 */
export function twisty(key, open, label, { disabled = false } = {}) {
    if (key === null) return h('span', { class: 'lab-twisty is-leaf', 'aria-hidden': 'true' });
    return h('button', {
        type: 'button', class: 'lab-twisty', 'aria-expanded': open ? 'true' : 'false', 'aria-label': label,
        dataset: { labToggle: key }, disabled
    });
}

/**
 * A folder node: "Tables (30)", with its children when open.
 * @param {{ key: string, title: string, count: number, open: boolean, children: () => any[], label: string, className?: string }} folder
 */
export function folderNode({ key, title, count, open, children, label, className = '' }) {
    return h('li', { class: `lab-node lab-folder ${className}`.trim() },
        h('div', { class: 'lab-row' },
            twisty(count > 0 ? key : null, open, label),
            h('span', { class: 'lab-folder-label', dataset: { labToggleBy: count > 0 ? key : null } }, icon('folder'), h('span', {}, `${title} (${count})`))),
        open && count > 0 ? h('ul', { class: 'lab-children' }, children()) : null);
}

/** The text after a column's name, as SSMS writes it: (PK, FK, INTEGER, not null). */
export function columnDetail(column, isForeignKey) {
    const parts = [];
    if (column.primaryKey) parts.push('PK');
    if (isForeignKey) parts.push('FK');
    parts.push(column.type || 'no type');
    parts.push(column.notNull || column.primaryKey ? 'not null' : 'null');
    return `(${parts.join(', ')})`;
}

/**
 * The children of a table or view: its columns, and a table's keys.
 * @param {any} object from the engine's schema()
 * @param {(key: string, fallback: boolean) => boolean} isOpen
 */
export function objectChildren(object, isOpen) {
    const base = `${object.type}:${object.name}`;
    const fkColumns = new Set((object.foreignKeys || []).flatMap(fk => fk.columns));
    const columns = folderNode({
        key: `${base}:columns`,
        title: 'Columns',
        count: object.columns.length,
        open: isOpen(`${base}:columns`, true),
        label: `Columns of ${object.name}`,
        children: () => object.columns.map(c => h('li', { class: 'lab-node lab-leaf' },
            h('div', { class: 'lab-row' },
                twisty(null, false, ''),
                h('span', { class: 'lab-leaf-label' },
                    icon(c.primaryKey ? 'key' : fkColumns.has(c.name) ? 'link' : 'column'),
                    h('span', { class: 'lab-column-name' }, c.name),
                    h('span', { class: 'lab-column-detail' }, columnDetail(c, fkColumns.has(c.name)))))))
    });
    if (object.type !== 'table') return [columns];
    const keys = [
        ...(object.primaryKey?.length ? [{ icon: 'key', name: `PK_${object.name}`, detail: `(${object.primaryKey.join(', ')})` }] : []),
        ...(object.foreignKeys || []).map(fk => ({
            icon: 'link',
            name: `FK_${object.name}_${fk.refTable}`,
            detail: `(${fk.columns.join(', ')}) → ${fk.refTable}${fk.refColumns.length ? ` (${fk.refColumns.join(', ')})` : ''}`
        }))
    ];
    const keyFolder = folderNode({
        key: `${base}:keys`,
        title: 'Keys',
        count: keys.length,
        open: isOpen(`${base}:keys`, false),
        label: `Keys of ${object.name}`,
        children: () => keys.map(k => h('li', { class: 'lab-node lab-leaf' },
            h('div', { class: 'lab-row' },
                twisty(null, false, ''),
                h('span', { class: 'lab-leaf-label' }, icon(k.icon), h('span', { class: 'lab-column-name' }, k.name), h('span', { class: 'lab-column-detail' }, k.detail)))))
    });
    return [columns, keyFolder];
}
