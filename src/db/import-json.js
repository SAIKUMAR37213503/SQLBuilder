// Reads rows from JSON: an array of objects ([{...}, {...}]), one object per
// line (JSON Lines), or an object with one property holding such an array
// ({"employees": [...]}). The columns are every key that appears, in the
// order they first appear. Nested objects and lists are kept as JSON text.

import { DatabaseError } from './engine.js';
import { uniqueNames } from './import-types.js';

const isRecord = (/** @type {unknown} */ value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Whole numbers too large for a JavaScript number keep their exact digits
// (SQLite reads them into a 64-bit integer column exactly)
function reviver(_key, value, context) {
    if (typeof value === 'number' && !Number.isSafeInteger(value) && /^-?\d+$/.test(context?.source || '')) return context.source;
    return value;
}

/** The line and column of a character offset. */
function positionOf(text, offset) {
    const before = text.slice(0, offset).split('\n');
    return { line: before.length, column: before[before.length - 1].length + 1 };
}

/**
 * Where JSON stops being valid, and why: browsers' own messages don't
 * always say. Only called after JSON.parse has failed.
 * @param {string} text
 * @returns {{ offset: number, reason: string }}
 */
export function findJsonError(text) {
    let i = 0;
    const fail = (reason, at = i) => {
        throw Object.assign(new Error(reason), { offset: at });
    };
    const space = () => {
        while (i < text.length && ' \t\n\r'.includes(text[i])) i++;
    };
    const what = () => (i >= text.length ? 'the text ends' : `there is ${JSON.stringify(text[i])}`);
    function value() {
        space();
        const ch = text[i];
        if (ch === '{') {
            i++;
            space();
            if (text[i] === '}') return void i++;
            for (;;) {
                space();
                if (text[i] !== '"') fail(`a property name in double quotes is expected, but ${what()}`);
                string();
                space();
                if (text[i] !== ':') fail(`a colon is expected after the property name, but ${what()}`);
                i++;
                value();
                space();
                if (text[i] === ',') {
                    i++;
                    continue;
                }
                if (text[i] === '}') return void i++;
                fail(`a comma or } is expected, but ${what()}`);
            }
        }
        if (ch === '[') {
            i++;
            space();
            if (text[i] === ']') return void i++;
            for (;;) {
                value();
                space();
                if (text[i] === ',') {
                    i++;
                    continue;
                }
                if (text[i] === ']') return void i++;
                fail(`a comma or ] is expected, but ${what()}`);
            }
        }
        if (ch === '"') return string();
        const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 400));
        if (literal) {
            i += literal[0].length;
            return undefined;
        }
        return fail(`a value is expected, but ${what()}`);
    }
    function string() {
        const start = i++;
        while (i < text.length) {
            const ch = text[i];
            if (ch === '"') return void i++;
            if (ch === '\\') {
                if (!/^(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/.test(text.slice(i + 1, i + 6))) fail('this escape (\\) isn\'t valid JSON');
                i += text[i + 1] === 'u' ? 6 : 2;
                continue;
            }
            if (ch < ' ') fail(ch === '\n' ? 'a line break inside text must be written as \\n' : 'a control character inside text isn\'t allowed');
            i++;
        }
        fail('text in double quotes is never closed', start);
    }
    try {
        value();
        space();
        if (i < text.length) fail(`the JSON should end here, but ${what()}`);
    } catch (error) {
        const e = /** @type {any} */ (error);
        return { offset: e.offset ?? i, reason: e.message };
    }
    return { offset: 0, reason: 'it isn\'t valid JSON' };
}

/** JSON.parse with errors that say where. */
function parse(text, lineOffset = 0) {
    try {
        return JSON.parse(text, reviver);
    } catch {
        const { offset, reason } = findJsonError(text);
        const where = positionOf(text, offset);
        const line = where.line + lineOffset;
        throw new DatabaseError(`This JSON can't be read: ${reason} (line ${line}, column ${where.column}).`, { code: 'BAD_INPUT', line, column: where.column });
    }
}

/**
 * @param {string} text
 * @returns {{ columns: string[], rows: unknown[][], nested: number, from: string | null, lines: number[] | null }}
 *   `from` names the property the rows were read from; `lines` gives each row's line for JSON Lines
 */
export function parseJsonRows(text) {
    const input = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trim();
    if (!input) throw new DatabaseError('There is no JSON to import.', { code: 'BAD_INPUT' });
    /** @type {unknown[]} */
    let items;
    let from = null;
    let lines = null;
    if (input[0] === '[') {
        const value = parse(input);
        items = /** @type {unknown[]} */ (value);
    } else if (input[0] === '{') {
        const all = input.split(/\r?\n/);
        const filled = all.map((l, i) => ({ text: l.trim(), line: i + 1 })).filter(l => l.text);
        let whole;
        try {
            whole = JSON.parse(input, reviver);
        } catch {
            whole = undefined;
        }
        if (whole !== undefined && isRecord(whole)) {
            const arrays = Object.entries(whole).filter(([, v]) => Array.isArray(v));
            if (arrays.length === 1 && Object.keys(whole).length === 1) {
                [from, items] = /** @type {[string, unknown[]]} */ (arrays[0]);
            } else {
                items = [whole];
            }
        } else {
            // JSON Lines: one object per line
            items = filled.map(l => parse(l.text, l.line - 1));
            lines = filled.map(l => l.line);
        }
    } else {
        throw new DatabaseError('JSON for a table must be a list of objects, like [{"id": 1, "name": "Ada"}], or one object per line.', { code: 'BAD_INPUT', line: 1, column: 1 });
    }
    if (!Array.isArray(items)) throw new DatabaseError('JSON for a table must be a list of objects.', { code: 'BAD_INPUT' });
    if (items.length === 0) throw new DatabaseError('The JSON list is empty, so there are no rows to import.', { code: 'BAD_INPUT' });

    /** @type {Map<string, number>} */
    const index = new Map();
    const keys = [];
    items.forEach((item, i) => {
        if (!isRecord(item)) {
            const what = Array.isArray(item) ? 'a list' : item === null ? 'null' : `${typeof item === 'string' ? 'text' : typeof item}`;
            throw new DatabaseError(`Item ${i + 1}${lines ? ` (line ${lines[i]})` : ''} is ${what}, not an object, so it can't be a row.`, { code: 'BAD_INPUT', row: i + 1, line: lines ? lines[i] : undefined });
        }
        for (const key of Object.keys(/** @type {object} */ (item))) {
            if (!index.has(key)) {
                index.set(key, keys.length);
                keys.push(key);
            }
        }
    });
    let nested = 0;
    const rows = items.map(item => keys.map(key => {
        const value = /** @type {Record<string, unknown>} */ (item)[key];
        if (value === undefined || value === null) return null;
        if (typeof value === 'object') {
            nested++;
            return JSON.stringify(value);
        }
        return value;
    }));
    return { columns: uniqueNames(keys), rows, nested, from, lines };
}
