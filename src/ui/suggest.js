// The suggestion list under builder fields. It follows the ARIA combobox
// pattern with manual selection: focus stays in the field, the list opens
// while typing a name (or with ↓ / Alt+↓), ↑/↓ move through it, Enter or a
// tap puts the suggestion into the field, and Esc or Tab closes it. Nothing is
// chosen unless the person picks it, so typing and Enter work as before.
//
// The list is one element outside the editor, so showing it never re-renders
// the builder.

import { h } from './dom.js';

const LIST_ID = 'field-suggestions';

/**
 * @typedef {import('../suggest.js').Suggestion} Suggestion
 * @param {{
 *   root: any,
 *   doc: Document,
 *   signal: AbortSignal,
 *   enabled: (input: any) => boolean,
 *   compute: (input: any) => { from: number, to: number, items: Suggestion[] } | null
 * }} options
 */
export function createSuggester({ root, doc, signal, enabled, compute }) {
    const list = h('ul', { id: LIST_ID, class: 'suggest-list', role: 'listbox', 'aria-label': 'Suggestions', hidden: true });
    const status = h('p', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite' });
    // Inside the page's main landmark, but outside the builder, which re-renders
    (root.closest('main') || doc.body).append(list, status);

    /** @type {any} */
    let input = null;
    /** @type {{ from: number, to: number, items: Suggestion[] } | null} */
    let result = null;
    let active = -1;
    // Set while a chosen suggestion is written into the field
    let inserting = false;

    function annotate(field) {
        field.setAttribute('role', 'combobox');
        field.setAttribute('aria-autocomplete', 'list');
        field.setAttribute('aria-expanded', 'false');
        field.setAttribute('aria-controls', LIST_ID);
    }

    function setActive(index) {
        active = index;
        Array.from(list.children).forEach((/** @type {any} */ option, i) => option.setAttribute('aria-selected', String(i === active)));
        const option = list.children[active];
        if (option && input) {
            input.setAttribute('aria-activedescendant', option.id);
            if (typeof option.scrollIntoView === 'function') option.scrollIntoView({ block: 'nearest' });
        } else if (input) {
            input.removeAttribute('aria-activedescendant');
        }
    }

    function place() {
        if (!input || list.hidden) return;
        const rect = input.getBoundingClientRect();
        const view = doc.defaultView;
        const height = view ? view.innerHeight : 0;
        const width = view ? view.innerWidth : 0;
        const below = height - rect.bottom;
        const above = rect.top > below && below < 180;
        list.style.minWidth = `${Math.min(rect.width, width - 16)}px`;
        // Under the field, moved left only as far as needed to stay on screen
        list.style.left = `${Math.max(8, Math.min(rect.left, width - 8 - list.offsetWidth))}px`;
        list.style.top = above ? '' : `${rect.bottom + 2}px`;
        list.style.bottom = above ? `${height - rect.top + 2}px` : '';
        list.style.maxHeight = `${Math.max(120, Math.min(320, (above ? rect.top : below) - 12))}px`;
    }

    function close() {
        if (input) {
            input.setAttribute('aria-expanded', 'false');
            input.removeAttribute('aria-activedescendant');
        }
        result = null;
        active = -1;
        list.hidden = true;
        list.replaceChildren();
        status.textContent = '';
    }

    /** Shows the suggestions for what is typed in `field`; `force` opens even with nothing typed. */
    function open(field, force = false) {
        if (!field.isConnected || !enabled(field)) {
            close();
            return;
        }
        if (input !== field) {
            close();
            input = field;
            annotate(field);
        }
        const next = compute(field);
        const typed = next && next.from < field.selectionStart;
        if (!next || !next.items.length || (!typed && !force)) {
            close();
            return;
        }
        result = next;
        list.replaceChildren(...next.items.map((item, i) => h('li', {
            id: `${LIST_ID}-${i}`,
            role: 'option',
            class: 'suggest-option',
            'aria-selected': 'false',
            dataset: { index: i, kind: item.kind }
        },
        h('span', { class: 'suggest-label' }, item.label),
        item.detail ? h('span', { class: 'suggest-detail' }, item.detail) : null)));
        list.hidden = false;
        field.setAttribute('aria-expanded', 'true');
        setActive(-1);
        place();
        status.textContent = `${next.items.length} suggestion${next.items.length === 1 ? '' : 's'}. Use the arrow keys to choose one.`;
    }

    function choose(index) {
        const field = input;
        const item = result && result.items[index];
        if (!field || !item || !result) return;
        const { from, to } = result;
        field.value = field.value.slice(0, from) + item.insert + field.value.slice(to);
        const caret = from + item.insert.length;
        field.setSelectionRange(caret, caret);
        close();
        // The builder's own listener updates the model, as when typing
        inserting = true;
        try {
            field.dispatchEvent(new Event('input', { bubbles: true }));
        } finally {
            inserting = false;
        }
        // After "alias." go straight on to its columns
        if (item.insert.endsWith('.')) open(field);
    }

    root.addEventListener('focusin', (/** @type {any} */ event) => {
        if (event.target.dataset?.bind === 'text' && enabled(event.target)) annotate(event.target);
    }, { signal });

    root.addEventListener('input', (/** @type {any} */ event) => {
        if (event.target.dataset?.bind !== 'text' || inserting) return;
        open(event.target);
    }, { signal });

    root.addEventListener('focusout', (/** @type {any} */ event) => {
        if (event.target === input) close();
    }, { signal });

    root.addEventListener('keydown', (/** @type {KeyboardEvent & { target: any }} */ event) => {
        const field = event.target;
        if (field.dataset?.bind !== 'text') return;
        const isOpen = field === input && !list.hidden && result;
        if (!isOpen) {
            if (event.key === 'ArrowDown' && !event.ctrlKey && !event.metaKey && enabled(field)) {
                open(field, true);
                if (!list.hidden) {
                    event.preventDefault();
                    if (!event.altKey) setActive(0);
                }
            }
            return;
        }
        const count = result ? result.items.length : 0;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (event.altKey && event.key === 'ArrowUp') {
                close();
                return;
            }
            const step = event.key === 'ArrowDown' ? 1 : -1;
            setActive(active < 0 ? (step > 0 ? 0 : count - 1) : (active + step + count) % count);
        } else if (event.key === 'Enter' && active >= 0) {
            event.preventDefault();
            event.stopPropagation();
            choose(active);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
        } else if (event.key === 'Tab' || event.key === 'Enter') {
            close();
        }
    }, { signal });

    // Keep focus in the field when an option is pressed
    const keepFocus = (/** @type {Event} */ event) => event.preventDefault();
    list.addEventListener('pointerdown', keepFocus, { signal });
    list.addEventListener('mousedown', keepFocus, { signal });
    list.addEventListener('click', (/** @type {any} */ event) => {
        const option = event.target.closest('[role="option"]');
        if (option) choose(Number(option.dataset.index));
    }, { signal });

    const view = doc.defaultView;
    if (view) {
        view.addEventListener('resize', place, { signal });
        view.addEventListener('scroll', place, { signal, capture: true, passive: true });
    }
    signal.addEventListener('abort', () => {
        list.remove();
        status.remove();
    });

    return {
        close,
        get open() { return !list.hidden; },
        list
    };
}
