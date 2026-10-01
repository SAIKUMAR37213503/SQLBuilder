// Renders the Projects dialog's list. Buttons carry data-action + data-id
// and are handled in app.js.

import { h } from './dom.js';
import { MAIN_PROJECT } from '../projects.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * @param {any} list
 * @param {any[]} projects Main first
 * @param {{ active: string, counts: (id: string) => { templates: number, history: number, tables: number },
 *   dialectLabel: (id?: string) => string }} view
 */
export function renderProjectList(list, projects, { active, counts, dialectLabel }) {
    list.replaceChildren(...projects.map(p => {
        const current = p.id === active;
        const c = counts(p.id);
        const button = (text, action, label, variant = 'ghost') => h('button', {
            type: 'button', class: `btn btn-${variant} btn-sm`, 'aria-label': label, dataset: { action, id: p.id }
        }, text);
        return h('li', { class: `project-item${current ? ' is-current' : ''}` },
            h('div', { class: 'library-meta' },
                h('strong', { class: 'library-name' }, p.name),
                current ? h('span', { class: 'library-chip library-current' }, 'Open') : null,
                p.dialect ? h('span', {}, dialectLabel(p.dialect)) : null),
            h('p', { class: 'project-counts' }, `${plural(c.templates, 'template')} · ${plural(c.history, 'history entry', 'history entries')} · ${plural(c.tables, 'schema table')}`),
            h('div', { class: 'library-actions' },
                current ? null : button('Open', 'project-open', `Open project ${p.name}`, 'secondary'),
                button('Rename', 'project-rename', `Rename project ${p.name}`),
                p.id === MAIN_PROJECT || current ? null : button('Delete', 'project-delete', `Delete project ${p.name}`, 'danger-ghost')));
    }));
}
