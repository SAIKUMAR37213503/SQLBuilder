// SQL lexer: splits SQL text into tokens with their positions. Used to read
// SQL the user pastes (CREATE TABLE statements for the schema). It never
// throws: text it can't make sense of becomes an 'other' token, and a string,
// quoted name or comment that is never closed is marked `unterminated`.
//
// Token types
//   ws        whitespace
//   comment   -- line, /* block */ (and # line comments with hashComments)
//   string    'text', N'text', E'text', X'hex', $$text$$ / $tag$text$tag$;
//             `value` is the text without quotes, escapes resolved
//   quoted    a quoted name: "name", `name`, [name]; `value` is the name
//   word      a keyword or bare name (letters, digits, _, $; T-SQL @x and #x)
//   number    12, 1.5, .5, 1e3
//   param     ?, $1, :name
//   op        operators: = <> != < <= > >= + - * / % || :: -> ->> and any
//             other single character
//   punct     ( ) , ; .
//
// Options
//   backslashEscapes  \' and \\ inside strings (MySQL)
//   hashComments      # starts a line comment (MySQL)

/**
 * @typedef {{ type: string, text: string, value?: string, start: number, end: number,
 *   line: number, col: number, unterminated?: boolean }} Token
 */

const WORD_START = /[\p{L}_@#]/u;
const WORD_CHAR = /[\p{L}\p{N}_$@#]/u;
const DIGIT = /[0-9]/;
const MULTI_OPS = ['->>', '<>', '!=', '>=', '<=', '||', '::', '->', '=>', '!<', '!>'];

/**
 * @param {string} text
 * @param {{ backslashEscapes?: boolean, hashComments?: boolean }} [options]
 * @returns {Token[]}
 */
export function lex(text, { backslashEscapes = false, hashComments = false } = {}) {
    /** @type {Token[]} */
    const tokens = [];
    let i = 0;
    let line = 1;
    let lineStart = 0;

    function push(type, start, extra = {}) {
        const token = { type, text: text.slice(start, i), start, end: i, line, col: start - lineStart + 1, ...extra };
        // Advance the line counter past newlines inside the token
        for (let k = start; k < i; k++) {
            if (text[k] === '\n') {
                line++;
                lineStart = k + 1;
            }
        }
        tokens.push(token);
    }

    // Reads up to the closing quote; a doubled quote is an escaped quote
    function quotedUntil(close, escapes) {
        let value = '';
        while (i < text.length) {
            const ch = text[i];
            if (escapes && ch === '\\' && i + 1 < text.length) {
                value += text[i + 1];
                i += 2;
                continue;
            }
            if (ch === close) {
                if (text[i + 1] === close) {
                    value += close;
                    i += 2;
                    continue;
                }
                i++;
                return { value, closed: true };
            }
            value += ch;
            i++;
        }
        return { value, closed: false };
    }

    while (i < text.length) {
        const start = i;
        const ch = text[i];
        const next = text[i + 1];

        if (/\s/.test(ch)) {
            while (i < text.length && /\s/.test(text[i])) i++;
            push('ws', start);
        } else if ((ch === '-' && next === '-') || (hashComments && ch === '#')) {
            while (i < text.length && text[i] !== '\n') i++;
            push('comment', start);
        } else if (ch === '/' && next === '*') {
            const close = text.indexOf('*/', i + 2);
            i = close === -1 ? text.length : close + 2;
            push('comment', start, close === -1 ? { unterminated: true } : {});
        } else if (ch === "'" || (/[NnEeXxBb]/.test(ch) && next === "'" && !WORD_CHAR.test(text[i - 1] || ''))) {
            const prefix = ch === "'" ? '' : ch.toUpperCase();
            i += prefix ? 2 : 1;
            const { value, closed } = quotedUntil("'", backslashEscapes || prefix === 'E');
            push('string', start, closed ? { value } : { value, unterminated: true });
        } else if (ch === '$' && /[A-Za-z_$]/.test(next || '') && dollarTag(text, i)) {
            const tag = dollarTag(text, i);
            const close = text.indexOf(tag, i + tag.length);
            const value = text.slice(i + tag.length, close === -1 ? text.length : close);
            i = close === -1 ? text.length : close + tag.length;
            push('string', start, close === -1 ? { value, unterminated: true } : { value });
        } else if (ch === '"' || ch === '`') {
            i++;
            const { value, closed } = quotedUntil(ch, false);
            push('quoted', start, closed ? { value } : { value, unterminated: true });
        } else if (ch === '[') {
            i++;
            const { value, closed } = quotedUntil(']', false);
            push('quoted', start, closed ? { value } : { value, unterminated: true });
        } else if (DIGIT.test(ch) || (ch === '.' && DIGIT.test(next || ''))) {
            while (i < text.length && DIGIT.test(text[i])) i++;
            if (text[i] === '.' && DIGIT.test(text[i + 1] || '')) {
                i++;
                while (i < text.length && DIGIT.test(text[i])) i++;
            } else if (text[i] === '.' && !WORD_START.test(text[i + 1] || '')) {
                i++; // "1." is a number; "t1.col" never reaches here
            }
            if (/[eE]/.test(text[i] || '') && /[0-9+-]/.test(text[i + 1] || '')) {
                i += 2;
                while (i < text.length && DIGIT.test(text[i])) i++;
            }
            push('number', start);
        } else if (ch === '?' || (ch === '$' && DIGIT.test(next || '')) || (ch === ':' && /[A-Za-z_]/.test(next || '') && text[i - 1] !== ':')) {
            i++;
            while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) i++;
            push('param', start);
        } else if (WORD_START.test(ch) && !(hashComments && ch === '#')) {
            i++;
            while (i < text.length && WORD_CHAR.test(text[i])) i++;
            push('word', start);
        } else if ('(),;.'.includes(ch)) {
            i++;
            push('punct', start);
        } else {
            const op = MULTI_OPS.find(o => text.startsWith(o, i));
            i += op ? op.length : Math.max(1, String.fromCodePoint(text.codePointAt(i) || 0).length);
            push('op', start);
        }
    }
    return tokens;
}

// "$tag$" or "$$" at position i, or '' when this "$" doesn't open a dollar-quoted string
function dollarTag(text, i) {
    const match = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 66));
    return match ? match[0] : '';
}

/**
 * The tokens that carry meaning: no whitespace or comments.
 * @param {Token[]} tokens
 */
export function significant(tokens) {
    return tokens.filter(t => t.type !== 'ws' && t.type !== 'comment');
}

/**
 * True when the token is the given keyword (case-insensitive; words only).
 * @param {Token | undefined} token
 * @param {...string} words
 */
export function isWord(token, ...words) {
    return Boolean(token && token.type === 'word' && words.includes(token.text.toUpperCase()));
}

/**
 * A name: a bare word, or the name inside quotes.
 * @param {Token | undefined} token
 * @returns {string | null}
 */
export function nameOf(token) {
    if (!token) return null;
    if (token.type === 'word') return token.text;
    if (token.type === 'quoted' && !token.unterminated) return token.value ?? null;
    return null;
}
