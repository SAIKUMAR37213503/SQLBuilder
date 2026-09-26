// Renders the History / Templates / Examples lists. Buttons carry
// data-action + data-id and are handled by a delegated listener in app.js.

import { h, formatTime } from './dom.js';
import { getDialect } from '../dialects.js';

/**
 * @param {string} text
 * @param {string} name
 * @param {string} id
 * @param {{ label?: string, variant?: string }} [options]
 */
function action(text, name, id, { label, variant = 'ghost' } = {}) {
    return h('button', { type: 'button', class: `btn btn-${variant} btn-sm`, 'aria-label': label, dataset: { action: name, id } }, text);
}

function snippet(sql, lines = 3) {
    const all = sql.split('\n');
    const shown = all.slice(0, lines).join('\n');
    return all.length > lines ? `${shown}\n…` : shown;
}

export function renderHistoryList(list, entries, { enabled, filtered }) {
    if (entries.length === 0) {
        list.replaceChildren(h('li', { class: 'empty-state' },
            !enabled
                ? 'History is turned off in Settings.'
                : filtered ? 'No queries match your search.' : 'Generated queries appear here. Press Generate SQL (Ctrl/⌘ + Enter) to add one.'));
        return;
    }
    list.replaceChildren(...entries.map(entry => {
        const title = `${entry.type.toUpperCase()} query from ${formatTime(entry.timestamp)}`;
        return h('li', { class: 'library-item' },
            h('div', { class: 'library-meta' },
                h('span', { class: `type-badge type-${entry.type}` }, entry.type.toUpperCase()),
                h('span', {}, getDialect(entry.dialect).label),
                h('time', { datetime: new Date(entry.timestamp).toISOString() }, formatTime(entry.timestamp))
            ),
            h('pre', { class: 'library-snippet' }, snippet(entry.sql)),
            h('div', { class: 'library-actions' },
                action('Restore', 'history-restore', entry.id, { label: `Restore ${title}`, variant: 'secondary' }),
                action('Copy', 'history-copy', entry.id, { label: `Copy SQL of ${title}` }),
                action('Delete', 'history-delete', entry.id, { label: `Delete ${title} from history`, variant: 'danger-ghost' })
            )
        );
    }));
}

export function renderTemplateList(list, templates) {
    if (templates.length === 0) {
        list.replaceChildren(h('li', { class: 'empty-state' }, 'No saved templates yet. Build a query, then choose “Save current query”.'));
        return;
    }
    list.replaceChildren(...templates.map(t => h('li', { class: 'library-item' },
        h('div', { class: 'library-meta' },
            h('span', { class: `type-badge type-${t.workspace.type}` }, t.workspace.type.toUpperCase()),
            h('strong', { class: 'library-name' }, t.name)
        ),
        h('p', { class: 'library-detail' }, `Updated ${formatTime(t.updatedAt)}`),
        h('div', { class: 'library-actions' },
            action('Load', 'template-load', t.id, { label: `Load template ${t.name}`, variant: 'secondary' }),
            action('Rename', 'template-rename', t.id, { label: `Rename template ${t.name}` }),
            action('Duplicate', 'template-duplicate', t.id, { label: `Duplicate template ${t.name}` }),
            action('Delete', 'template-delete', t.id, { label: `Delete template ${t.name}`, variant: 'danger-ghost' })
        )
    )));
}

export function renderExampleList(list, examples) {
    list.replaceChildren(...examples.map(example => {
        const type = example.build().type;
        return h('li', { class: 'library-item' },
            h('div', { class: 'library-meta' },
                h('span', { class: `type-badge type-${type}` }, type.toUpperCase()),
                h('strong', { class: 'library-name' }, example.name)
            ),
            h('p', { class: 'library-detail' }, example.description),
            h('div', { class: 'library-actions' },
                action('Load example', 'example-load', example.id, { label: `Load example: ${example.name}`, variant: 'secondary' }))
        );
    }));
}
