// What SQL Lab shows after a run: result grids (a page of rows at a time)
// and messages. Every count and time comes from the engine: rows are counted
// only once all of them have been read, and "rows affected" and durations
// are what SQLite reported and the worker measured.

import { h } from './dom.js';

export const MAX_SHOWN_ROWS = 1000;

const plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString()} ${n === 1 ? one : many}`;

/** A measured duration. */
export function formatDuration(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value)) return '';
    return value < 10 ? `${value.toFixed(1)} ms` : `${Math.round(value).toLocaleString()} ms`;
}

const firstWord = (sql) => /^\s*([a-z]+)/i.exec(String(sql))?.[1]?.toUpperCase() || '';

/**
 * One line saying what a statement did.
 * @param {any} r a statement result
 */
export function describeResult(r) {
    const rows = r.rows?.length || 0;
    const returned = r.more ? `First ${plural(rows, 'row')} shown; more available` : `${plural(rows, 'row')} returned`;
    if (r.kind === 'query') return returned;
    if (r.kind === 'modify') {
        const affected = typeof r.rowsAffected === 'number' ? `Query completed successfully. ${plural(r.rowsAffected, 'row')} affected.` : 'Query completed successfully.';
        return r.columns?.length ? `${affected} ${returned}.` : affected;
    }
    if (r.kind === 'transaction') {
        const word = firstWord(r.sql);
        if (word === 'BEGIN') return 'Transaction started. Its changes are kept only when you run COMMIT.';
        if (word === 'COMMIT' || word === 'END') return 'Transaction committed.';
        if (word === 'ROLLBACK') return /\bTO\b/i.test(r.sql) ? 'Rolled back to the savepoint.' : 'Transaction rolled back.';
        return 'Completed successfully.';
    }
    if (r.columns?.length) return returned;
    return 'Completed successfully.';
}

/** A cell's text: NULL, a BLOB's size, or the value. */
export function cellText(value) {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'object' && typeof value.blob === 'number') return `BLOB (${plural(value.blob, 'byte')})`;
    return String(value);
}

function cell(value) {
    if (value === null || value === undefined) return h('td', { class: 'lab-null' }, 'NULL');
    if (typeof value === 'object') return h('td', { class: 'lab-blob' }, cellText(value));
    return h('td', { class: typeof value === 'number' || typeof value === 'bigint' ? 'is-number' : null }, String(value));
}

const snippet = (sql) => {
    const one = String(sql).replace(/\s+/g, ' ').trim();
    return one.length > 90 ? `${one.slice(0, 87)}…` : one;
};

/**
 * A result grid with its heading and, when there are more rows, Load more.
 * @param {any} r
 * @param {{ index: number, count: number, loading: boolean }} context
 */
export function renderGrid(r, { index, count, loading }) {
    const title = count > 1 ? `Result ${index + 1} of ${count} (line ${r.line})` : `Result (line ${r.line})`;
    const capped = r.rows.length >= MAX_SHOWN_ROWS;
    const status = describeResult(r);
    return h('section', { class: 'lab-result', 'aria-label': title },
        h('div', { class: 'lab-result-head' },
            h('h4', { class: 'lab-result-title' }, title),
            h('span', { class: 'lab-result-status', role: 'status' }, status),
            h('span', { class: 'lab-result-time' }, formatDuration(r.durationMs))),
        h('div', { class: 'lab-table-scroll lab-result-scroll', tabindex: '0', role: 'region', 'aria-label': `${title}: ${status}` },
            h('table', { class: 'lab-columns lab-data' },
                h('thead', {}, h('tr', {}, r.columns.map(c => h('th', { scope: 'col' }, c)))),
                h('tbody', {}, r.rows.map(row => h('tr', {}, row.map(cell)))))),
        r.more && r.cursor && !capped
            ? h('button', { type: 'button', class: 'btn btn-secondary btn-sm', dataset: { labAction: 'more', result: String(index) }, disabled: loading }, loading ? 'Loading…' : 'Load 100 more rows')
            : null,
        r.more && capped
            ? h('p', { class: 'lab-empty-hint' }, `Showing the first ${plural(MAX_SHOWN_ROWS, 'row')}. Add WHERE or LIMIT … OFFSET to see others.`)
            : null,
        r.more && !r.cursor && !capped
            ? h('p', { class: 'lab-empty-hint' }, 'Only the last statement\'s results can show more rows. Run this statement on its own to page through them.')
            : null);
}

/**
 * The Messages list for a run.
 * @param {any} run { results, omitted, statements, changes, error, inTransaction, stopped }
 */
export function renderMessages(run) {
    const items = run.results.map((r) => h('li', { class: 'lab-message' },
        h('span', { class: 'lab-message-where' }, `Line ${r.line}`),
        h('span', { class: 'lab-message-text' }, describeResult(r)),
        h('span', { class: 'lab-message-time' }, formatDuration(r.durationMs)),
        h('code', { class: 'lab-message-sql' }, snippet(r.sql))));
    if (run.omitted) {
        const at = Math.max(0, items.length - 1);
        items.splice(at, 0, h('li', { class: 'lab-message lab-message-more' }, `${plural(run.omitted, 'more statement')} ran successfully (not listed).`));
    }
    if (run.error) {
        const where = typeof run.error.line === 'number' ? `Line ${run.error.line}, column ${run.error.column}` : 'Error';
        items.push(h('li', { class: 'lab-message lab-message-error' },
            h('span', { class: 'lab-message-where' }, where),
            h('span', { class: 'lab-message-text' }, run.error.message),
            run.error.code && run.error.code !== 'ERROR' ? h('span', { class: 'lab-message-time' }, run.error.code) : null));
    }
    const notes = [];
    if (run.stopped) notes.push('Stopped. The engine was restarted: changes already committed are kept, and an unfinished transaction was rolled back.');
    else if (run.error && run.statements > 0 && !run.inTransaction) notes.push(`The ${plural(run.statements, 'statement')} before the error ran, and ${run.statements === 1 ? 'its changes are' : 'their changes are'} kept. Statements after it didn't run.`);
    else if (run.error && run.statements > 0) notes.push('The statements before the error ran inside the open transaction. Statements after it didn\'t run.');
    if (run.inTransaction) notes.push('A transaction is open. Run COMMIT to keep its changes, or ROLLBACK to undo them. Closing the database rolls it back.');
    return [
        h('p', { class: 'lab-message-summary', role: 'status' }, summary(run)),
        items.length ? h('ol', { class: 'lab-messages' }, items) : null,
        ...notes.map(n => h('p', { class: 'lab-message-note' }, n))
    ].filter(Boolean);
}

/** One sentence for the whole run. */
export function summary(run) {
    if (run.stopped) return 'Stopped before it finished.';
    const total = run.results.reduce((sum, r) => sum + (Number(r.durationMs) || 0), 0);
    const ran = `${plural(run.statements, 'statement')} ran`;
    const time = run.results.length && !run.omitted ? ` in ${formatDuration(total)}` : '';
    const changed = run.changes ? `, ${plural(run.changes, 'row')} changed` : '';
    if (run.error) return run.statements ? `${ran}${changed}, then an error stopped the script.` : 'The SQL didn\'t run: the engine reported an error.';
    if (!run.statements) return 'There was no SQL to run.';
    return `${ran}${time}${changed}.`;
}
