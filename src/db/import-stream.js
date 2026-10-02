// Reads an import file a few MB at a time, so files up to 1 GB can be
// imported: a JavaScript string can't hold that much text at once, and the
// device's memory couldn't either. The text is cut into parts that end where
// a statement, a row or a JSON item ends, and each part is read (and later
// run) on its own; line numbers carry on from part to part, so messages name
// the line in the file.

import { DatabaseError } from './engine.js';
import { scanScript } from './import-sql.js';

/** The largest file that can be imported. */
export const MAX_FILE_BYTES = 1024 * 1024 * 1024;
/** How much of a file is read at a time. */
export const CHUNK_BYTES = 4 * 1024 * 1024;
/** Parts are cut once they are about this long (in characters). */
export const PART_CHARS = 4 * 1024 * 1024;
/** One statement, row or JSON item can't be longer than this. */
export const MAX_PIECE_CHARS = 256 * 1024 * 1024;

/** Whether a value is a file (or any Blob) rather than text. */
export const isBlob = (/** @type {any} */ value) => Boolean(value) && typeof value === 'object' && typeof value.slice === 'function' && typeof value.size === 'number';

/**
 * The text encoding a file's byte order mark names. SQL Server Management
 * Studio saves scripts as UTF-16 ("Unicode text") by default.
 * @param {Uint8Array} head the first bytes of the file
 * @returns {'utf-8' | 'utf-16le' | 'utf-16be'}
 */
export function textEncoding(head) {
    if (head[0] === 0xff && head[1] === 0xfe) return 'utf-16le';
    if (head[0] === 0xfe && head[1] === 0xff) return 'utf-16be';
    return 'utf-8';
}

const sizeOf = (/** @type {string | Blob} */ source) => (typeof source === 'string' ? source.length : source.size);

/**
 * Reports how much of an import has been read, at most every 100 ms.
 * An import that reads its file twice (JSON and HTML: once to find the
 * columns, once to insert) counts both readings.
 * @param {((progress: { done: number, total: number }) => void) | undefined} onProgress
 * @param {string | Blob} source
 * @param {number} [passes]
 */
export function createProgress(onProgress, source, passes = 1) {
    const size = sizeOf(source);
    const total = Math.max(1, size * passes);
    let done = 0;
    let last = 0;
    const report = (force = false) => {
        const now = Date.now();
        if (!onProgress || (!force && now - last < 100)) return;
        last = now;
        onProgress({ done: Math.min(done, total), total });
    };
    return {
        /** @param {number} amount bytes (or characters) read */
        read(amount) {
            done += amount;
            report();
        },
        /** The start of the next reading of the file. */
        pass(index) {
            done = size * index;
            report(true);
        },
        finish() {
            done = total;
            report(true);
        }
    };
}

/**
 * The text of a file or a string, a few MB at a time. A file is decoded by
 * its byte order mark (UTF-8 without one), and the mark is dropped.
 * @param {string | Blob} source
 * @param {{ chunkBytes?: number, progress?: ReturnType<typeof createProgress> }} [options]
 */
export async function* textChunks(source, { chunkBytes = CHUNK_BYTES, progress } = {}) {
    if (typeof source === 'string') {
        for (let at = 0; at < source.length; at += chunkBytes) {
            const part = source.slice(at, at + chunkBytes);
            progress?.read(part.length);
            yield part;
        }
        return;
    }
    if (source.size > MAX_FILE_BYTES) {
        throw new DatabaseError(`This file is too large to import (the limit is ${MAX_FILE_BYTES / 1024 / 1024 / 1024} GB).`, { code: 'TOO_LARGE' });
    }
    /** @type {TextDecoder | null} */
    let decoder = null;
    for (let at = 0; at < source.size; at += chunkBytes) {
        const bytes = new Uint8Array(await source.slice(at, Math.min(source.size, at + chunkBytes)).arrayBuffer());
        decoder ||= new TextDecoder(textEncoding(bytes));
        progress?.read(bytes.length);
        const text = decoder.decode(bytes, { stream: true });
        if (text) yield text;
    }
    const rest = decoder ? decoder.decode() : '';
    if (rest) yield rest;
}

/** The first characters of a source, for choosing how to read it. */
export async function headOf(source, chars = 256 * 1024) {
    let head = '';
    for await (const chunk of textChunks(source, { chunkBytes: Math.max(chars, 4096) })) {
        head += chunk;
        if (head.length >= chars) break;
    }
    return head.slice(0, chars);
}

/** Line breaks in text, counted as SQL and JSON count them (\n). */
export function newlines(text) {
    let count = 0;
    for (let k = text.indexOf('\n'); k >= 0; k = text.indexOf('\n', k + 1)) count++;
    return count;
}

/** Line breaks in text, counted as CSV counts them (\n, \r\n or \r). */
export function csvLineBreaks(text) {
    let count = 0;
    for (let k = 0; k < text.length; k++) {
        const c = text.charCodeAt(k);
        if (c === 10 || (c === 13 && text.charCodeAt(k + 1) !== 10)) count++;
    }
    return count;
}

const tooLong = (what) => new DatabaseError(`${what} is longer than ${MAX_PIECE_CHARS / 1024 / 1024} MB, so it can't be imported.`, { code: 'TOO_LARGE' });

/**
 * Cuts text that arrives in parts where `finder` says a piece may end.
 * finder.scan(text, from) reads text from `from` on (keeping its state from
 * earlier calls) and returns the last place found where a part may be cut,
 * or -1.
 * @param {AsyncIterable<string>} chunks
 * @param {{ scan: (text: string, from: number) => number }} finder
 * @param {{ partChars?: number, what: string }} options
 */
async function* cutAt(chunks, finder, { partChars = PART_CHARS, what }) {
    let buffer = '';
    let cut = -1;
    for await (const chunk of chunks) {
        const from = buffer.length;
        buffer += chunk;
        const found = finder.scan(buffer, from);
        if (found > 0) cut = found;
        if (buffer.length >= partChars && cut > 0) {
            yield buffer.slice(0, cut);
            buffer = buffer.slice(cut);
            cut = -1;
        } else if (buffer.length > MAX_PIECE_CHARS) {
            throw tooLong(what);
        }
    }
    if (buffer) yield buffer;
}

/**
 * CSV in parts that end at the end of a row (a line break outside quotes).
 * @param {AsyncIterable<string>} chunks
 * @param {{ partChars?: number }} [options]
 * @returns {AsyncGenerator<{ text: string, line: number }>}
 */
export async function* csvParts(chunks, { partChars } = {}) {
    let quoted = false;
    const finder = {
        scan(text, from) {
            let last = -1;
            for (let k = from; k < text.length; k++) {
                const c = text.charCodeAt(k);
                if (c === 34) quoted = !quoted;
                else if (c === 10 && !quoted) last = k + 1;
            }
            return last;
        }
    };
    let line = 1;
    for await (const text of cutAt(chunks, finder, { partChars, what: 'A row (or a quoted value in it)' })) {
        yield { text, line };
        line += csvLineBreaks(text);
    }
}

/**
 * Text in parts that end at the end of a line (JSON Lines).
 * @param {AsyncIterable<string>} chunks
 * @param {{ partChars?: number }} [options]
 * @returns {AsyncGenerator<{ text: string, line: number }>}
 */
export async function* lineParts(chunks, { partChars } = {}) {
    const finder = { scan: (text) => text.lastIndexOf('\n') + 1 || -1 };
    let line = 1;
    for await (const text of cutAt(chunks, finder, { partChars, what: 'A line' })) {
        yield { text, line };
        line += newlines(text);
    }
}

/**
 * A SQL script in parts that end where a statement ends (after its ; or a
 * GO line), as the import's own reading of the script finds them.
 * @param {AsyncIterable<string>} chunks
 * @param {{ partChars?: number }} [options]
 * `column` is where the part starts in its line (0 at the start of a line).
 * @returns {AsyncGenerator<{ text: string, line: number, column: number }>}
 */
export async function* sqlParts(chunks, { partChars = PART_CHARS } = {}) {
    let buffer = '';
    let line = 1;
    let column = 0;
    // Don't read the buffer again until it has grown by another part
    let nextTry = partChars;
    for await (const chunk of chunks) {
        buffer += chunk;
        if (buffer.length < nextTry) continue;
        const cut = statementsEnd(buffer);
        if (cut > 0) {
            const text = buffer.slice(0, cut);
            yield { text, line, column };
            line += newlines(text);
            const end = text.lastIndexOf('\n');
            column = end >= 0 ? text.length - end - 1 : column + text.length;
            buffer = buffer.slice(cut);
            nextTry = partChars;
        } else {
            if (buffer.length > MAX_PIECE_CHARS) throw tooLong('A statement');
            nextTry = buffer.length + partChars;
        }
    }
    if (buffer) yield { text: buffer, line, column };
}

/**
 * Where the complete statements at the start of text end: the last one may
 * go on in the next part, so it is left out. 0 when there is none.
 * @param {string} text
 */
function statementsEnd(text) {
    const { statements, problem } = scanScript(text);
    // A quote or comment not closed yet: every statement before it is complete
    const complete = problem ? statements : statements.slice(0, -1);
    const last = complete[complete.length - 1];
    if (!last) return 0;
    if (last.separator) return last.end;
    return text[last.end] === ';' ? last.end + 1 : last.end;
}

/**
 * A SQL Server script adapted for SQLite as it is read (see
 * import-sqlserver.js); each piece ends where a statement ends.
 * @param {AsyncIterable<string>} chunks
 * @param {{ push: (text: string, final: boolean) => { text: string, consumed: number } }} adapter
 */
export async function* adaptedChunks(chunks, adapter) {
    let buffer = '';
    for await (const chunk of chunks) {
        buffer += chunk;
        const { text, consumed } = adapter.push(buffer, false);
        if (text) yield text;
        buffer = buffer.slice(consumed);
        if (buffer.length > MAX_PIECE_CHARS) throw tooLong('A statement');
    }
    const { text } = adapter.push(buffer, true);
    if (text) yield text;
}

/**
 * The items of a JSON list, one at a time, as text: a list ([{…}, {…}]) or a
 * list held by an object's only property ({"employees": [{…}, …]}).
 * `shape.from` is set to that property's name, and `shape.count` to the
 * number of items at the end.
 * @param {AsyncIterable<string>} chunks
 * @param {{ from: string | null, count?: number }} shape
 * @returns {AsyncGenerator<{ text: string, line: number, column: number }>}
 */
export async function* jsonListItems(chunks, shape) {
    // Where the reader is: before the list, in it, after it
    let stage = 'start';
    let depth = 0;
    let inString = false;
    let escaped = false;
    let line = 1;
    let column = 0;
    let item = '';
    let itemLine = 0;
    let itemColumn = 0;
    let items = 0;
    let afterComma = false;
    let key = '';
    let wrapped = false;
    const fail = (reason) => {
        throw new DatabaseError(`This JSON can't be read: ${reason} (line ${line}, column ${column}).`, { code: 'BAD_INPUT', line, column });
    };
    const what = (ch) => `there is ${JSON.stringify(ch)}`;
    const space = (c) => c === 32 || c === 9 || c === 13 || c === 10 || c === 0xfeff;

    for await (const chunk of chunks) {
        /** @type {{ text: string, line: number, column: number }[]} */
        const ready = [];
        // Where the item being read starts in this chunk
        let start = item ? 0 : -1;
        for (let k = 0; k < chunk.length; k++) {
            const c = chunk.charCodeAt(k);
            if (c === 10) {
                line++;
                column = 0;
            } else {
                column++;
            }
            if (stage === 'item') {
                if (inString) {
                    if (escaped) escaped = false;
                    else if (c === 92) escaped = true;
                    else if (c === 34) inString = false;
                    continue;
                }
                if (depth === 0 && (c === 44 || c === 93)) {
                    // , or ]: the end of an item
                    if (start >= 0) item += chunk.slice(start, k);
                    start = -1;
                    item = item.trimEnd();
                    if (item) {
                        ready.push({ text: item, line: itemLine, column: itemColumn });
                        items++;
                    } else if (c === 44 || afterComma) {
                        fail(c === 44 ? 'there is nothing before this comma' : 'there is a comma before ]');
                    }
                    item = '';
                    afterComma = c === 44;
                    if (c === 93) stage = wrapped ? 'close' : 'end';
                    continue;
                }
                if (depth === 0 && start < 0) {
                    if (space(c)) continue;
                    if (c === 125) fail(`a comma or ] is expected, but ${what(chunk[k])}`);
                    start = k;
                    itemLine = line;
                    itemColumn = column;
                }
                if (c === 34) inString = true;
                else if (c === 123 || c === 91) depth++;
                else if (c === 125 || c === 93) depth--;
                continue;
            }
            if (space(c)) continue;
            const ch = chunk[k];
            if (stage === 'start') {
                if (ch === '[') stage = 'item';
                else if (ch === '{') {
                    stage = 'key';
                    wrapped = true;
                } else fail(`JSON for a table must be a list of objects, but ${what(ch)}`);
            } else if (stage === 'key') {
                // {"name": [ … ] }: the property's name, read character by character
                if (key === '' && ch !== '"') fail(`a property name in double quotes is expected, but ${what(ch)}`);
                key += ch;
                if (key.length > 1 && ch === '"' && !/(?:^|[^\\])(?:\\\\)*\\"$/.test(key)) {
                    shape.from = JSON.parse(key);
                    stage = 'colon';
                }
                if (key.length > 1000) fail('the property name is too long');
            } else if (stage === 'colon') {
                if (ch !== ':') fail(`a colon is expected after the property name, but ${what(ch)}`);
                stage = 'list';
            } else if (stage === 'list') {
                if (ch !== '[') throw new DatabaseError('JSON for a table must be a list of objects. A large file can also be a list held by an object\'s only property ({"rows": [ … ]}), or JSON Lines (one object per line).', { code: 'BAD_INPUT', line, column });
                stage = 'item';
            } else if (stage === 'close') {
                if (ch === ',') throw new DatabaseError('This JSON object has more than one property. A large file must be a list of objects, a list held by an object\'s only property, or JSON Lines (one object per line).', { code: 'BAD_INPUT', line, column });
                if (ch !== '}') fail(`} is expected, but ${what(ch)}`);
                stage = 'end';
            } else {
                fail(`the JSON should end here, but ${what(ch)}`);
            }
        }
        if (start >= 0) item += chunk.slice(start);
        if (item.length > MAX_PIECE_CHARS) throw tooLong('A JSON item');
        for (const x of ready) yield x;
    }
    if (stage !== 'end') fail(stage === 'start' ? 'there is no JSON' : 'the text ends before the list does');
    shape.count = items;
}
