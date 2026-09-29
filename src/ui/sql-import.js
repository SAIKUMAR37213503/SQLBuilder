// What the Import SQL dialog shows about the SQL being imported: whether it
// can be imported, where it can't, and what the builder writes differently.
// Everything here is plain text in DOM nodes; the imported SQL is never
// treated as HTML.

import { h } from './dom.js';

/** “a SELECT”, “an INSERT” */
const article = (/** @type {string} */ kind) => `${/^[aeiou]/i.test(kind) ? 'an' : 'a'} ${kind.toUpperCase()}`;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** @param {{ line: number, col: number }} at */
const where = (at) => (at.line ? `Line ${at.line}, column ${at.col}: ` : '');

/** @param {{ yours: string, builder: string }} d */
function describe(d) {
    if (!d.yours) return `the builder adds “${d.builder}”.`;
    if (!d.builder) return `“${d.yours}” is left out.`;
    return `“${d.yours}” becomes “${d.builder}”.`;
}

/**
 * @param {any} output the result element
 * @param {any} result previewSqlImport()'s result, or null when nothing is entered
 */
export function renderSqlImportPreview(output, result) {
    if (!result) {
        output.replaceChildren(h('p', { class: 'field-hint' }, 'Paste a statement or choose a .sql file to see how it imports. Nothing changes until you choose Import.'));
        return;
    }
    if (!result.ok) {
        output.replaceChildren(h('p', { class: 'field-error' }, `Can't import. ${where(result)}${result.message}`));
        return;
    }
    const { check } = result;
    const parts = [];
    if (check.same) {
        parts.push(h('p', { class: 'sql-import-ok' }, `Ready to import as ${article(result.query.kind)} query: the builder writes the same SQL.`));
    } else {
        parts.push(h('p', {}, `Ready to import as ${article(result.query.kind)} query, but the builder writes ${plural(check.total, 'part')} differently. Check ${check.total === 1 ? 'it means' : 'they mean'} what you want:`));
        parts.push(h('ul', { class: 'sql-import-differences' },
            check.differences.map((/** @type {any} */ d) => h('li', {}, `Line ${d.line}: ${describe(d)}`)),
            check.total > check.differences.length ? h('li', {}, `and ${check.total - check.differences.length} more`) : null));
    }
    for (const note of result.notes) parts.push(h('p', { class: 'field-hint' }, note));
    parts.push(h('details', { class: 'sql-import-sql' },
        h('summary', {}, 'SQL the builder will write'),
        // Focusable, so the SQL can be scrolled with the keyboard
        h('pre', { class: 'code-block', tabindex: '0', 'aria-label': 'SQL the builder will write' }, result.sql)));
    output.replaceChildren(...parts);
}
