// What the Compare dialects dialog shows. Plain text in DOM nodes only.

import { h } from './dom.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const LEVELS = { error: 'Error', warning: 'Warning', suggestion: 'Suggestion', info: 'Tip' };

/** @param {{ yours: string, builder: string }} d */
function describe(d) {
    if (!d.yours) return `“${d.builder}” is added.`;
    if (!d.builder) return `“${d.yours}” is left out.`;
    return `“${d.yours}” becomes “${d.builder}”.`;
}

/** One dialect's SQL, scrollable with the keyboard */
const pane = (title, sql) => h('section', { class: 'compare-pane' },
    h('h3', { class: 'compare-pane-title' }, title),
    h('pre', { class: 'code-block', tabindex: '0', 'aria-label': `SQL for ${title}` }, sql));

/**
 * @param {any} output the result element
 * @param {ReturnType<typeof import('../dialect-compare.js').compareDialects>} result
 */
export function renderDialectComparison(output, result) {
    const { from, to, check, notes, added } = result;
    if (from.blocked) {
        output.replaceChildren(h('p', { class: 'field-error' },
            `Resolve the errors under Checks first. The comparison uses the SQL the builder writes for ${from.label}.`));
        return;
    }
    const parts = [];
    if (check.same) {
        parts.push(h('p', { class: 'compare-same' }, `${to.label} writes this query the same way as ${from.label}.`));
    } else {
        parts.push(h('p', {}, `${to.label} writes ${plural(check.total, 'part')} differently. Line numbers are in the ${from.label} SQL:`));
        parts.push(h('ul', { class: 'compare-differences' },
            check.differences.map((/** @type {any} */ d) => h('li', {}, `Line ${d.line}: ${describe(d)}`)),
            check.total > check.differences.length ? h('li', {}, `and ${check.total - check.differences.length} more`) : null));
    }
    for (const note of notes) parts.push(h('p', { class: 'field-hint' }, note));
    if (added.length) {
        parts.push(h('p', {}, to.blocked ? `${to.label} can't run this query as it is. Its checks add:` : `In ${to.label}, Checks would also show:`));
        parts.push(h('ul', { class: 'compare-checks' }, added.map(i => h('li', { class: `compare-check compare-${i.level}` },
            h('span', { class: 'compare-level' }, `${LEVELS[i.level]}: `), i.message))));
    }
    parts.push(h('div', { class: 'compare-panes' },
        pane(`${from.label} (current)`, from.sql),
        pane(to.label, to.blocked ? `-- ${to.label} can't run this query yet; see the checks above.\n${to.sql}` : to.sql)));
    output.replaceChildren(...parts);
}
