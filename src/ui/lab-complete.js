// IntelliSense for SQL Lab's editor: a list of tables, columns, keywords,
// functions and variables under the caret, as SSMS shows while you type.
// It opens after a "." or a letter (and with Ctrl+Space); Up / Down move,
// Enter or Tab puts the suggestion in (one undo step), Escape closes it.
// The textarea keeps focus the whole time, so typing never stops.

import { h } from './dom.js';
import { completions } from './lab-scripts.js';

let ids = 0;

/**
 * @param {{ input: HTMLTextAreaElement, root: HTMLElement, sources: () => { objects: any[], modules: any[], language: string } | null, insert: (from: number, to: number, text: string) => void }} options
 */
export function attachCompletion({ input, root, sources, insert }) {
    const listId = `lab-complete-${++ids}`;
    const list = h('ul', { class: 'lab-complete', id: listId, role: 'listbox', 'aria-label': 'Suggestions', hidden: true });
    const status = h('span', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite' });
    root.append(list, status);
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', listId);

    /** @type {{ from: number, to: number, items: any[], at: number } | null} */
    let open = null;
    let enabled = true;

    function close() {
        if (!open) return;
        open = null;
        list.hidden = true;
        list.replaceChildren();
        input.removeAttribute('aria-activedescendant');
    }

    /** Where the caret is, in the editor's box (a hidden copy of the text measures it). */
    function caretPoint(index) {
        const style = getComputedStyle(input);
        const mirror = h('div', { class: 'lab-complete-mirror', 'aria-hidden': 'true' });
        for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize', 'paddingTop', 'paddingLeft', 'borderTopWidth', 'borderLeftWidth', 'boxSizing']) {
            /** @type {any} */ (mirror.style)[p] = /** @type {any} */ (style)[p];
        }
        mirror.style.whiteSpace = 'pre';
        mirror.style.position = 'absolute';
        mirror.style.visibility = 'hidden';
        mirror.style.left = '0';
        mirror.style.top = '0';
        mirror.textContent = input.value.slice(0, index);
        const mark = h('span', {}, '​');
        mirror.append(mark);
        root.append(mirror);
        const point = { left: mark.offsetLeft - input.scrollLeft + input.offsetLeft, top: mark.offsetTop - input.scrollTop + input.offsetTop + mark.offsetHeight };
        mirror.remove();
        return point;
    }

    function show(force = false) {
        const from = sources();
        if (!from || (!enabled && !force)) return close();
        const caret = input.selectionStart ?? 0;
        if (input.selectionEnd !== caret) return close();
        const found = completions({ text: input.value, caret, objects: from.objects || [], modules: from.modules || [], language: from.language, force });
        if (!found.items.length) {
            close();
            if (force) status.textContent = 'No suggestions.';
            return;
        }
        const keep = open && open.from === found.from ? open.items[open.at]?.label : null;
        const at = Math.max(0, keep ? found.items.findIndex(i => i.label === keep) : 0);
        open = { from: found.from, to: found.to, items: found.items, at };
        list.replaceChildren(...found.items.map((item, k) => h('li', {
            id: `${listId}-${k}`, role: 'option', class: `lab-complete-item lab-complete-${item.kind}`, 'aria-selected': k === at ? 'true' : 'false', dataset: { index: String(k) }
        }, h('span', { class: 'lab-complete-kind', 'aria-hidden': 'true' }, KIND_MARK[item.kind] || '·'),
        h('span', { class: 'lab-complete-label' }, item.label),
        h('span', { class: 'lab-complete-detail' }, item.detail))));
        list.hidden = false;
        const point = caretPoint(found.from);
        const width = Math.min(360, root.clientWidth - 8);
        list.style.left = `${Math.max(4, Math.min(point.left, root.clientWidth - width - 4))}px`;
        list.style.top = `${point.top + 2}px`;
        select(at);
        status.textContent = `${found.items.length} ${found.items.length === 1 ? 'suggestion' : 'suggestions'}. Up and Down to choose, Enter or Tab to insert.`;
    }

    function select(at) {
        if (!open) return;
        open.at = (at + open.items.length) % open.items.length;
        for (const li of list.children) li.setAttribute('aria-selected', String(Number(/** @type {any} */ (li).dataset.index) === open.at));
        const li = list.children[open.at];
        input.setAttribute('aria-activedescendant', li.id);
        li.scrollIntoView?.({ block: 'nearest' });
    }

    function accept(at = open?.at ?? 0) {
        if (!open) return;
        const item = open.items[at];
        const { from, to } = open;
        close();
        insert(from, to, item.insert);
    }

    input.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
        if ((event.ctrlKey || event.metaKey) && (event.key === ' ' || event.code === 'Space')) {
            event.preventDefault();
            show(true);
            return;
        }
        if (!open) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'PageDown' || event.key === 'PageUp') {
            const step = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8 }[event.key];
            select(event.key.startsWith('Page') ? Math.max(0, Math.min(open.items.length - 1, open.at + step)) : open.at + step);
        } else if ((event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.shiftKey) || event.key === 'Tab') {
            accept();
        } else if (event.key === 'Escape') {
            close();
        } else {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
    });
    input.addEventListener('input', (/** @type {any} */ event) => {
        const typed = event.data;
        if (event.inputType === 'insertText' && typeof typed === 'string' && /^[.\p{L}_@#]$/u.test(typed)) show();
        else if (open && (event.inputType === 'deleteContentBackward' || (event.inputType === 'insertText' && /^[\p{L}\p{N}_$]$/u.test(typed || '')))) show();
        else close();
    });
    input.addEventListener('blur', () => setTimeout(() => {
        if (root.ownerDocument.activeElement !== input) close();
    }, 150));
    input.addEventListener('scroll', close);
    input.addEventListener('mousedown', close);
    list.addEventListener('mousedown', (event) => event.preventDefault()); // the editor keeps focus
    list.addEventListener('click', (event) => {
        const li = /** @type {any} */ (event.target).closest('[data-index]');
        if (li) accept(Number(li.dataset.index));
    });

    return {
        close,
        show,
        get open() {
            return Boolean(open);
        },
        /** Turns suggestions while typing on or off (Ctrl+Space still works). */
        set enabled(value) {
            enabled = Boolean(value);
            if (!enabled) close();
        }
    };
}

const KIND_MARK = { table: 'T', view: 'V', column: 'C', keyword: 'K', function: 'ƒ', procedure: 'P', variable: '@' };
