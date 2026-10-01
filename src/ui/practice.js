// Renders the Practice tab's exercise list and the open exercise above the
// builder. Buttons carry data-action (+ data-id) and are handled in app.js.
// All text goes in through h(), which sets textContent.

import { h } from './dom.js';
import { EXAMPLE_LEVELS } from '../examples.js';

/**
 * @param {string} text
 * @param {string} name
 * @param {{ id?: string, label?: string, variant?: string }} [options]
 */
function action(text, name, { id, label, variant = 'ghost' } = {}) {
    return h('button', { type: 'button', class: `btn btn-${variant} btn-sm`, 'aria-label': label, dataset: { action: name, id } }, text);
}

/**
 * @param {any} list
 * @param {any[]} exercises the exercises to show (already filtered)
 * @param {{ isDone: (id: string) => boolean, active: string | null }} progress
 */
export function renderExerciseList(list, exercises, { isDone, active }) {
    if (exercises.length === 0) {
        list.replaceChildren(h('li', { class: 'empty-state' }, 'No exercises at this level. Choose “All levels” to see the rest.'));
        return;
    }
    list.replaceChildren(...exercises.map(ex => {
        const done = isDone(ex.id);
        const open = ex.id === active;
        return h('li', { class: 'library-item' },
            h('div', { class: 'library-meta' },
                h('span', { class: `type-badge type-${ex.type}` }, ex.type.toUpperCase()),
                h('strong', { class: 'library-name' }, ex.title),
                h('span', { class: `library-chip level-${ex.level}` }, EXAMPLE_LEVELS[ex.level]),
                h('span', {}, ex.topic),
                done ? h('span', { class: 'library-chip practice-done' }, '✓ Done') : null,
                open ? h('span', { class: 'library-chip library-current' }, 'Open') : null
            ),
            h('p', { class: 'library-detail' }, ex.goal),
            h('div', { class: 'library-actions' },
                open
                    ? action('Go to exercise', 'practice-show', { id: ex.id, label: `Go to the open exercise: ${ex.title}`, variant: 'secondary' })
                    : action(done ? 'Try again' : 'Start', 'practice-start', { id: ex.id, label: `${done ? 'Try again' : 'Start'}: ${ex.title}`, variant: 'secondary' }))
        );
    }));
}

/**
 * The open exercise.
 * @param {any} panel the #practice section
 * @param {any} ex the exercise
 * @param {{ tables: any[], missing: number, hints: number, result: null | { passed: boolean, results: any[] },
 *   answerSql: string | null, answerLoaded?: boolean, next: any }} view
 *   tables: the exercise's tables from the practice schema; missing: how many
 *   practice tables aren't in the user's schema; hints: how many are shown;
 *   result: the last check; answerSql: the model answer when shown;
 *   answerLoaded: the model answer was loaded, so a pass doesn't count
 */
export function renderPracticePanel(panel, ex, { tables, missing, hints, result, answerSql, answerLoaded = false, next }) {
    const passedCount = result ? result.results.filter(r => r.ok).length : 0;
    panel.replaceChildren(
        h('div', { class: 'practice-head' },
            h('div', {},
                h('p', { class: 'practice-kicker' }, `Practice · ${EXAMPLE_LEVELS[ex.level]} · ${ex.topic}`),
                h('h3', { class: 'practice-title', id: 'practice-title', tabindex: '-1' }, ex.title)),
            action('Close', 'practice-stop', { label: 'Close the exercise' })),
        h('p', { class: 'practice-goal' }, ex.goal),
        h('div', { class: 'practice-tables' },
            h('p', { class: 'practice-tables-label' }, tables.length === 1 ? 'Table:' : 'Tables:'),
            h('ul', {}, tables.map(t => h('li', {},
                h('code', {}, t.name), ` (${t.columns.map((/** @type {any} */ c) => c.name).join(', ')})`))),
            missing ? action('Add the practice tables to my schema', 'practice-schema', { label: 'Add the practice tables to my schema, for field suggestions and the JOIN assistant' }) : null),
        h('div', { class: 'practice-actions' },
            action('Check my query', 'practice-check', { variant: 'primary' }),
            hints < ex.hints.length
                ? action(hints === 0 ? 'Show a hint' : `Next hint (${hints + 1} of ${ex.hints.length})`, 'practice-hint')
                : null,
            answerSql === null ? action('Show the model answer', 'practice-answer') : null),
        hints ? h('ol', { class: 'practice-hints', 'aria-label': 'Hints' }, ex.hints.slice(0, hints).map((/** @type {string} */ hint) => h('li', {}, hint))) : null,
        result ? h('div', { class: `practice-result${result.passed ? ' practice-passed' : ''}` },
            h('p', { class: 'practice-summary' }, result.passed
                ? (answerLoaded ? 'All checks pass with the model answer. Build it yourself next time to mark the exercise done.' : 'All checks pass. Well done!')
                : `${passedCount} of ${result.results.length} checks pass.`),
            h('ul', { class: 'practice-checks' }, result.results.map(r => h('li', { class: r.ok ? 'is-ok' : 'is-missing' },
                h('span', { class: 'practice-mark', 'aria-hidden': 'true' }, r.ok ? '✓' : '✗'),
                h('span', { class: 'visually-hidden' }, r.ok ? 'Passes: ' : 'Not yet: '),
                h('span', {}, r.label),
                r.ok ? null : h('span', { class: 'practice-check-hint' }, r.hint)))),
            result.passed ? h('p', { class: 'practice-explain' }, ex.explain) : null,
            result.passed && next ? action(`Next: ${next.title}`, 'practice-start', { id: next.id, variant: 'secondary' }) : null) : null,
        answerSql !== null ? h('div', { class: 'practice-answer' },
            h('p', { class: 'practice-tables-label' }, 'One way to write it:'),
            h('pre', { class: 'library-snippet practice-answer-sql', tabindex: '0', 'aria-label': 'Model answer SQL' }, answerSql),
            h('div', { class: 'library-actions' },
                action('Load it into the builder', 'practice-load-answer', { label: 'Load the model answer into the builder (Undo brings back your query)' }))) : null,
        h('p', { class: 'practice-note' }, 'Checks look at how the query is built, not at its results: this app never runs SQL. A different query can be right too.')
    );
}
