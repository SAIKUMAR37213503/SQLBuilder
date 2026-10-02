// SQL Lab's editor: a plain textarea (so typing, undo, selection, IME and
// screen readers work as in any text field) over a highlighted copy of its
// text, drawn with the app's SQL tokenizer.

import { h } from './dom.js';
import { tokenize } from '../tokenizer.js';

/**
 * @param {{ label: string, describedBy?: string, onInput?: (value: string) => void, onRun?: () => void }} options
 */
export function createEditor({ label, describedBy = '', onInput = () => {}, onRun = () => {} }) {
    const code = h('code', {});
    const highlight = h('pre', { class: 'lab-editor-highlight', 'aria-hidden': 'true' }, code);
    const input = h('textarea', {
        class: 'lab-editor-input',
        id: 'lab-sql',
        rows: '10',
        spellcheck: 'false',
        autocapitalize: 'off',
        autocomplete: 'off',
        autocorrect: 'off',
        wrap: 'off',
        'aria-label': label,
        'aria-describedby': describedBy || null,
        'aria-keyshortcuts': 'Control+Enter Meta+Enter'
    });
    const root = h('div', { class: 'lab-editor' }, highlight, input);

    function paint() {
        const parts = tokenize(input.value).map(t => (t.type === 'text' ? t.text : h('span', { class: `tok tok-${t.type}` }, t.text)));
        // A final newline needs a character after it to take up a line
        code.replaceChildren(...parts, '\n');
        sync();
    }

    function sync() {
        highlight.scrollTop = input.scrollTop;
        highlight.scrollLeft = input.scrollLeft;
    }

    input.addEventListener('input', () => {
        paint();
        onInput(input.value);
    });
    input.addEventListener('scroll', sync);
    input.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation(); // not the builder's Generate
            onRun();
        }
    });

    /** The character index of a 1-based line and column (columns count characters, not UTF-16 units). */
    function indexOf(line, column) {
        const lines = input.value.split('\n');
        let index = 0;
        for (let i = 0; i < Math.min(line - 1, lines.length - 1); i++) index += lines[i].length + 1;
        const text = lines[Math.min(line - 1, lines.length - 1)] || '';
        const chars = [...text].slice(0, Math.max(0, column - 1)).join('');
        return index + chars.length;
    }

    return {
        root,
        input,
        get value() {
            return input.value;
        },
        set value(text) {
            input.value = String(text ?? '');
            paint();
        },
        /** The selected text, with where it starts, or null when nothing is selected. */
        selection() {
            const { selectionStart: start, selectionEnd: end } = input;
            if (start === end || typeof start !== 'number') return null;
            const before = input.value.slice(0, start).split('\n');
            return { text: input.value.slice(start, end), line: before.length, column: [...before[before.length - 1]].length + 1 };
        },
        /** Puts the cursor at a line and column (where an error is) and selects the word there. */
        goTo(line, column) {
            const at = indexOf(line, column);
            const word = /^[\p{L}\p{N}_$]+/u.exec(input.value.slice(at))?.[0].length || 1;
            input.focus();
            input.setSelectionRange(at, Math.min(input.value.length, at + word));
        },
        focus: () => input.focus(),
        set disabled(value) {
            input.readOnly = Boolean(value);
        },
        paint
    };
}
