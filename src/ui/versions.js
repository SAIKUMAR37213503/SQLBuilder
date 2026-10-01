// Renders the template Versions dialog: the current query and each earlier
// version, and the line-by-line changes from a chosen version to the current
// one. Buttons carry data-action + data-index and are handled in app.js.

import { h, formatTime } from './dom.js';
import { describeDiff } from '../versions.js';

/**
 * @param {any} list
 * @param {any} template
 * @param {{ dialectLabel: (id?: string) => string, diffs: (import('../versions.js').DiffLine[] | null)[], selected: number | null }} view
 *   diffs: each version against the current query, in the versions' order
 */
export function renderVersionList(list, template, { dialectLabel, diffs, selected }) {
    const versions = template.versions || [];
    list.replaceChildren(
        h('li', { class: 'version-item version-current' },
            h('div', { class: 'library-meta' },
                h('strong', {}, 'Current'),
                h('time', { datetime: new Date(template.updatedAt).toISOString() }, formatTime(template.updatedAt)),
                h('span', {}, dialectLabel(template.dialect)))),
        ...versions.map((/** @type {any} */ v, i) => {
            const when = formatTime(v.savedAt);
            return h('li', { class: `version-item${selected === i ? ' is-selected' : ''}` },
                h('div', { class: 'library-meta' },
                    h('time', { datetime: new Date(v.savedAt).toISOString() }, when),
                    h('span', {}, dialectLabel(v.dialect)),
                    h('span', { class: 'version-change' }, describeDiff(diffs[i]))),
                h('div', { class: 'library-actions' },
                    h('button', {
                        type: 'button', class: 'btn btn-secondary btn-sm', 'aria-pressed': String(selected === i),
                        'aria-label': `Compare the version from ${when} with the current query`, dataset: { action: 'version-compare', index: i }
                    }, 'Compare'),
                    h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-label': `Restore the version from ${when}`, dataset: { action: 'version-restore', index: i } }, 'Restore'),
                    h('button', { type: 'button', class: 'btn btn-danger-ghost btn-sm', 'aria-label': `Delete the version from ${when}`, dataset: { action: 'version-delete', index: i } }, 'Delete')));
        }));
}

const MARKS = { same: ['  ', ''], added: ['+ ', 'Added: '], removed: ['− ', 'Removed: '] };

/**
 * The changes from one version to the current query.
 * @param {any} output
 * @param {any} version null to clear
 * @param {import('../versions.js').DiffLine[] | null} diff
 */
export function renderVersionCompare(output, version, diff) {
    if (!version) {
        output.replaceChildren();
        return;
    }
    const heading = h('p', { class: 'version-compare-title' }, `From the version saved ${formatTime(version.savedAt)} to the current query: ${describeDiff(diff).toLowerCase()}.`);
    if (!diff) {
        output.replaceChildren(heading);
        return;
    }
    output.replaceChildren(heading,
        h('pre', { class: 'version-diff', tabindex: '0', 'aria-label': 'Changes, line by line' },
            diff.map(line => h('span', { class: `diff-line diff-${line.type}` },
                h('span', { class: 'diff-mark', 'aria-hidden': 'true' }, MARKS[line.type][0]),
                MARKS[line.type][1] ? h('span', { class: 'visually-hidden' }, MARKS[line.type][1]) : null,
                `${line.text}\n`))));
}
