// Round-trip check for SQL import: compares the SQL a person imported with the
// SQL the builder writes for it, token by token. Differences that never change
// a statement are ignored: whitespace and line breaks, comments, the case of
// keywords and bare names, a final semicolon, and the optional words AS,
// INNER, OUTER and ASC. What is left is reported with its line and column in
// the imported text, so the person can see exactly what the builder changes.

import { lex, significant } from './sql-lexer.js';

const OPTIONAL_WORDS = new Set(['AS', 'INNER', 'OUTER', 'ASC']);
// Above this many cells the middle part is reported as one difference
const MAX_DIFF_CELLS = 4_000_000;
const MAX_REPORTED = 20;
const MAX_SNIPPET = 80;

/**
 * @typedef {import('./sql-lexer.js').Token} Token
 * @typedef {{ line: number, col: number, yours: string, builder: string }} Difference
 */

/** @param {string} text @param {{ backslashEscapes?: boolean, hashComments?: boolean }} syntax */
function comparable(text, syntax) {
    const tokens = significant(lex(text, syntax));
    while (tokens.length && tokens[tokens.length - 1].text === ';') tokens.pop();
    return tokens.filter(t => !(t.type === 'word' && OPTIONAL_WORDS.has(t.text.toUpperCase())));
}

/** @param {Token} t */
const keyOf = (t) => (t.type === 'word' ? `w:${t.text.toUpperCase()}` : `${t.type}:${t.text}`);

/** @param {Token[]} tokens */
function snippet(tokens) {
    let out = '';
    tokens.forEach((t, i) => {
        if (i > 0 && t.start > tokens[i - 1].end) out += ' ';
        out += t.text;
    });
    out = out.replace(/\s+/g, ' ');
    return out.length > MAX_SNIPPET ? `${out.slice(0, MAX_SNIPPET - 1)}…` : out;
}

/**
 * Pairs of [yours, builder] token ranges that differ, found with a longest
 * common subsequence over the part between the common start and end.
 * @param {string[]} a @param {string[]} b
 * @returns {[number, number, number, number][]} [a0, a1, b0, b1] ranges
 */
function diffRanges(a, b) {
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
    }
    const n = endA - start;
    const m = endB - start;
    if (n === 0 && m === 0) return [];
    if (n === 0 || m === 0 || n * m > MAX_DIFF_CELLS) return [[start, endA, start, endB]];

    // lcs[i][j]: common length of a[start+i..endA) and b[start+j..endB)
    const width = m + 1;
    const lcs = new Uint16Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            lcs[i * width + j] = a[start + i] === b[start + j]
                ? lcs[(i + 1) * width + j + 1] + 1
                : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
        }
    }
    /** @type {[number, number, number, number][]} */
    const ranges = [];
    let i = 0;
    let j = 0;
    let open = null;
    const flush = () => {
        if (open) ranges.push([start + open[0], start + i, start + open[1], start + j]);
        open = null;
    };
    while (i < n || j < m) {
        if (i < n && j < m && a[start + i] === b[start + j]) {
            flush();
            i++;
            j++;
        } else {
            if (!open) open = [i, j];
            if (j >= m || (i < n && lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) i++;
            else j++;
        }
    }
    flush();
    // Differences a word or two apart read better as one: LIMIT 5, 10 → LIMIT 10 OFFSET 5
    return ranges.reduce((/** @type {[number, number, number, number][]} */ merged, range) => {
        const last = merged[merged.length - 1];
        if (last && range[0] - last[1] <= 2 && range[0] - last[1] === range[2] - last[3]) last.splice(1, 3, range[1], last[2], range[3]);
        else merged.push(range);
        return merged;
    }, []);
}

/**
 * Compares imported SQL with the SQL the builder writes for it.
 * @param {string} yours the SQL as imported
 * @param {string} builder the SQL the builder generates
 * @param {{ backslashEscapes?: boolean, hashComments?: boolean }} [syntax] how to read both (the dialect's syntax)
 * @returns {{ same: boolean, total: number, differences: Difference[] }}
 */
export function compareSql(yours, builder, syntax = {}) {
    const a = comparable(yours, syntax);
    const b = comparable(builder, syntax);
    const ranges = diffRanges(a.map(keyOf), b.map(keyOf));
    const differences = ranges.slice(0, MAX_REPORTED).map(([a0, a1, b0, b1]) => {
        // Where the difference is: its first token, or the token after an addition
        const at = a[a0] || a[a0 - 1] || { line: 1, col: 1 };
        return { line: at.line, col: at.col, yours: snippet(a.slice(a0, a1)), builder: snippet(b.slice(b0, b1)) };
    });
    return { same: ranges.length === 0, total: ranges.length, differences };
}
