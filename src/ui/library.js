// Renders the History / Templates / Examples lists. Buttons carry
// data-action + data-id and are handled by a delegated listener in app.js.

import { h, formatTime } from './dom.js';
import { getDialect } from '../dialects.js';
import { EXAMPLE_LEVELS } from '../examples.js';

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

/**
 * @param {any} list
 * @param {any[]} templates the templates to show (already filtered and sorted)
 * @param {{ total?: number, filterLabel?: string, query?: string, currentId?: string | null }} [options]
 *   total saved, the dialect filter's label ('' = all), the search text, and
 *   the template being edited
 */
export function renderTemplateList(list, templates, { total = templates.length, filterLabel = '', query = '', currentId = null } = {}) {
    if (templates.length === 0) {
        let message = 'No saved templates yet. Build a query, then choose “Save current query”.';
        if (total > 0 && query) message = `No templates match “${query}”${filterLabel ? ` for ${filterLabel}` : ''}.`;
        else if (total > 0 && filterLabel) message = `No templates for ${filterLabel}. Choose “All dialects” to see all ${total}.`;
        list.replaceChildren(h('li', { class: 'empty-state' }, message));
        return;
    }
    list.replaceChildren(...templates.map(t => h('li', { class: `library-item${t.pinned ? ' pinned' : ''}` },
        h('div', { class: 'library-meta' },
            h('span', { class: `type-badge type-${t.workspace.type}` }, t.workspace.type.toUpperCase()),
            h('strong', { class: 'library-name' }, t.name),
            t.pinned ? h('span', { class: 'library-chip library-pin' }, 'Pinned') : null,
            t.id === currentId ? h('span', { class: 'library-chip library-current' }, 'Editing') : null,
            h('span', {}, t.dialect ? getDialect(t.dialect).label : 'Any dialect'),
            t.category ? h('span', { class: 'library-chip' }, t.category) : null
        ),
        t.description ? h('p', { class: 'library-detail' }, t.description) : null,
        h('p', { class: 'library-detail' }, `Updated ${formatTime(t.updatedAt)}`),
        h('div', { class: 'library-actions' },
            action('Load', 'template-load', t.id, { label: `Load template ${t.name}`, variant: 'secondary' }),
            t.pinned
                ? action('Unpin', 'template-unpin', t.id, { label: `Unpin template ${t.name}` })
                : action('Pin', 'template-pin', t.id, { label: `Pin template ${t.name} to the top` }),
            action('Rename', 'template-rename', t.id, { label: `Rename template ${t.name}` }),
            action('Duplicate', 'template-duplicate', t.id, { label: `Duplicate template ${t.name}` }),
            t.versions?.length ? action(`Versions (${t.versions.length})`, 'template-versions', t.id, { label: `Earlier versions of template ${t.name} (${t.versions.length})` }) : null,
            action('Delete', 'template-delete', t.id, { label: `Delete template ${t.name}`, variant: 'danger-ghost' })
        )
    )));
}

/**
 * @param {any} list
 * @param {any[]} examples the examples to show (already filtered by dialect and topic)
 * @param {(workspace: any) => string} preview generated SQL for a workspace in the shown dialect
 */
export function renderExampleList(list, examples, preview) {
    if (examples.length === 0) {
        list.replaceChildren(h('li', { class: 'empty-state' }, 'No examples on this topic for this dialect. Choose “All topics” to see the rest.'));
        return;
    }
    list.replaceChildren(...examples.map(example => {
        const workspace = example.build();
        const type = workspace.type;
        const sql = preview(workspace);
        return h('li', { class: 'library-item' },
            h('div', { class: 'library-meta' },
                h('span', { class: `type-badge type-${type}` }, type.toUpperCase()),
                h('strong', { class: 'library-name' }, example.name),
                h('span', { class: `library-chip level-${example.level}` }, EXAMPLE_LEVELS[example.level]),
                h('span', {}, example.topic)
            ),
            h('p', { class: 'library-detail' }, example.description),
            // One-line SQL, clamped to a few lines by CSS
            sql ? h('pre', { class: 'library-snippet example-sql' }, sql) : null,
            h('div', { class: 'library-actions' },
                action('Load example', 'example-load', example.id, { label: `Load example: ${example.name}`, variant: 'secondary' }))
        );
    }));
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// One column's line in a table's column list: name, type and key markers
function columnItem(table, column) {
    const lower = column.name.toLowerCase();
    const inPk = table.primaryKey.some(c => c.toLowerCase() === lower);
    const fks = table.foreignKeys.filter(fk => fk.columns.some(c => c.toLowerCase() === lower));
    return h('li', { class: 'schema-column' },
        h('span', { class: 'schema-column-name' }, column.name),
        column.type ? h('span', { class: 'schema-column-type' }, column.type) : null,
        inPk ? h('span', { class: 'library-chip schema-key' }, 'Primary key') : null,
        ...fks.map(fk => {
            const i = fk.columns.findIndex(c => c.toLowerCase() === lower);
            return h('span', { class: 'library-chip' }, `→ ${fk.refTable}${fk.refColumns[i] ? `.${fk.refColumns[i]}` : ''}`);
        }),
        !column.nullable && !inPk ? h('span', { class: 'schema-column-note' }, 'not null') : null
    );
}

/**
 * @param {any} list
 * @param {any[]} tables the tables to show (already filtered)
 * @param {{ total?: number, query?: string }} [options] how many tables there are, and the search text
 */
export function renderSchemaList(list, tables, { total = tables.length, query = '' } = {}) {
    if (tables.length === 0) {
        list.replaceChildren(h('li', { class: 'empty-state' }, total > 0 && query
            ? `No tables or columns match “${query}”.`
            : 'No tables yet. Add a table, or import CREATE TABLE statements or a schema file. The schema stays in this browser.'));
        return;
    }
    list.replaceChildren(...tables.map(t => {
        const columns = h('ul', { class: 'schema-columns' });
        const details = h('details', { class: 'schema-details' },
            h('summary', {}, `${plural(t.columns.length, 'column')}`),
            columns);
        // Column lists are built when opened, so a large schema stays quick to show
        details.addEventListener('toggle', () => {
            if (details.open && !columns.hasChildNodes()) columns.replaceChildren(...t.columns.map(c => columnItem(t, c)));
        });
        const links = new Set(t.foreignKeys.map(fk => fk.refTable.toLowerCase())).size;
        return h('li', { class: 'library-item' },
            h('div', { class: 'library-meta' },
                h('strong', { class: 'library-name' }, t.name),
                t.primaryKey.length ? h('span', { class: 'library-chip schema-key' }, `Key: ${t.primaryKey.join(', ')}`) : null,
                links ? h('span', {}, `links to ${plural(links, 'table')}`) : null
            ),
            details,
            h('div', { class: 'library-actions' },
                action('Edit', 'schema-edit', t.name, { label: `Edit table ${t.name}`, variant: 'secondary' }),
                action('Delete', 'schema-delete', t.name, { label: `Delete table ${t.name} from the schema`, variant: 'danger-ghost' })
            )
        );
    }));
}

const MAX_PROBLEMS_SHOWN = 5;

/**
 * What an import would do: the tables found, the statements skipped and the
 * parts that couldn't be read.
 * @param {any} output
 * @param {any} result readSchemaInput()'s result, or null before anything is entered
 * @param {any[]} current the tables already in the schema
 */
export function renderSchemaImportPreview(output, result, current) {
    if (!result) {
        output.replaceChildren(h('p', { class: 'field-hint' }, 'Paste text or choose a file to see what will be imported. Nothing is saved until you choose Import.'));
        return;
    }
    if (!result.ok) {
        output.replaceChildren(h('p', { class: 'field-error' }, `Can't import: ${result.error}`));
        return;
    }
    const names = result.tables.map((/** @type {any} */ t) => t.name);
    const taken = new Set(current.map(t => t.name.toLowerCase()));
    const replacing = names.filter((/** @type {string} */ n) => taken.has(n.toLowerCase())).length;
    const shownNames = names.slice(0, 8).join(', ') + (names.length > 8 ? `, and ${names.length - 8} more` : '');
    const parts = [
        result.tables.length
            ? h('p', { class: 'schema-import-found' }, `Found ${plural(result.tables.length, 'table')}: ${shownNames}.${replacing ? ` ${plural(replacing, 'table')} with the same name ${replacing === 1 ? 'is' : 'are'} already in your schema.` : ''}`)
            : h('p', { class: 'field-error' }, 'No tables could be read.')
    ];
    if (result.skipped.length) {
        const total = result.skipped.reduce((/** @type {number} */ n, /** @type {any} */ s) => n + s.count, 0);
        parts.push(h('p', { class: 'field-hint' },
            `Skipped ${plural(total, 'other statement')}: ${result.skipped.map((/** @type {any} */ s) => (s.count > 1 ? `${s.label} (${s.count})` : s.label)).join(', ')}.`));
    }
    if (result.problems.length) {
        parts.push(h('p', { class: 'field-error' }, `${plural(result.problems.length, 'part')} couldn't be read${result.tables.length ? ' and will be left out' : ''}:`));
        parts.push(h('ul', { class: 'schema-import-problems' },
            result.problems.slice(0, MAX_PROBLEMS_SHOWN).map((/** @type {any} */ p) => h('li', {}, p.line ? `Line ${p.line}: ${p.message}` : p.message)),
            result.problems.length > MAX_PROBLEMS_SHOWN ? h('li', {}, `and ${result.problems.length - MAX_PROBLEMS_SHOWN} more`) : null));
    }
    output.replaceChildren(...parts);
}
