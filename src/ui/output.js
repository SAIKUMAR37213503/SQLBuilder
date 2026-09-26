// Renders SQL into the output panel: one element per line (line numbers are
// CSS counters, so they are never part of copied text) with highlighted
// tokens built as text nodes.

import { h } from './dom.js';
import { tokenize } from '../tokenizer.js';

/** Splits highlighted tokens into lines of tokens. */
export function tokenLines(sql) {
    const lines = [[]];
    for (const token of tokenize(sql)) {
        const pieces = token.text.split('\n');
        pieces.forEach((piece, i) => {
            if (i > 0) lines.push([]);
            if (piece !== '') lines[lines.length - 1].push({ type: token.type, text: piece });
        });
    }
    return lines;
}

export function renderSqlCode(code, sql) {
    const lines = tokenLines(sql).map(tokens => h('span', { class: 'line' },
        tokens.map(t => (t.type === 'text' ? t.text : h('span', { class: `tok tok-${t.type}` }, t.text))),
        '\n'
    ));
    code.replaceChildren(...lines);
}

export function selectContents(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
}
