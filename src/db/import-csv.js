// Reads CSV (RFC 4180): fields separated by a delimiter, fields in double
// quotes may contain the delimiter, line breaks and "" for a quote. Lines
// may end in \n, \r\n or \r. Blank lines are skipped.
//
// An unquoted empty field is read as null (it becomes NULL); a quoted empty
// field ("") is read as empty text. Malformed input is refused with the row
// and line where the problem is, never guessed at.

import { DatabaseError } from './engine.js';

export const DELIMITERS = [
    { value: ',', label: 'Comma (,)' },
    { value: ';', label: 'Semicolon (;)' },
    { value: '\t', label: 'Tab' },
    { value: '|', label: 'Pipe (|)' }
];

const DELIMITER_NAMES = { ',': 'comma', ';': 'semicolon', '\t': 'tab', '|': 'pipe' };

/** @param {string} delimiter */
export const delimiterName = (delimiter) => DELIMITER_NAMES[delimiter] || delimiter;

/**
 * The delimiter the first lines use most consistently (comma when unsure).
 * Only characters outside quotes are counted.
 * @param {string} text
 */
export function detectDelimiter(text) {
    const lines = [];
    let current = { ',': 0, ';': 0, '\t': 0, '|': 0 };
    let quoted = false;
    for (let i = 0; i < text.length && lines.length < 20; i++) {
        const ch = text[i];
        if (ch === '"') quoted = !quoted;
        else if (!quoted && (ch === '\n' || ch === '\r')) {
            if (Object.values(current).some(Boolean)) lines.push(current);
            current = { ',': 0, ';': 0, '\t': 0, '|': 0 };
        } else if (!quoted && ch in current) current[ch]++;
    }
    if (lines.length < 20 && Object.values(current).some(Boolean)) lines.push(current);
    let best = ',';
    let bestScore = 0;
    for (const { value } of DELIMITERS) {
        const counts = lines.map(l => l[value]);
        if (!counts.length || counts[0] === 0) continue;
        // Lines that agree with the first line, weighted by how many fields that gives
        const agree = counts.filter(c => c === counts[0]).length;
        const score = agree * 1000 + counts[0];
        if (score > bestScore) {
            best = value;
            bestScore = score;
        }
    }
    return best;
}

/**
 * @param {string} text
 * @param {{ delimiter?: string, firstLine?: number, firstRow?: number }} [options]
 *   firstLine, firstRow: the line and row the text starts on, when it is a part of a larger file
 * @returns {{ rows: (string | null)[][], lines: number[] }} each row's fields, and the line each row starts on
 */
export function parseCsv(text, { delimiter = ',', firstLine = 1, firstRow = 1 } = {}) {
    if (delimiter.length !== 1 || delimiter === '"' || delimiter === '\n' || delimiter === '\r') {
        throw new DatabaseError('Choose a delimiter of one character.', { code: 'BAD_INPUT' });
    }
    const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    /** @type {(string | null)[][]} */
    const rows = [];
    const lines = [];
    let line = firstLine;
    let i = 0;
    const n = input.length;
    const rowNumber = () => rows.length + firstRow;

    while (i < n) {
        // A blank line is skipped
        if (input[i] === '\n' || input[i] === '\r') {
            i += input[i] === '\r' && input[i + 1] === '\n' ? 2 : 1;
            line++;
            continue;
        }
        const rowLine = line;
        /** @type {(string | null)[]} */
        const row = [];
        for (;;) {
            if (input[i] === '"') {
                const openLine = line;
                let value = '';
                let start = ++i;
                for (;;) {
                    const close = input.indexOf('"', i);
                    if (close === -1) {
                        throw new DatabaseError(`Row ${rowNumber()}: a quote opened on line ${openLine} is never closed.`, { code: 'BAD_INPUT', line: openLine, row: rowNumber() });
                    }
                    value += input.slice(start, close);
                    if (input[close + 1] === '"') {
                        value += '"';
                        i = start = close + 2;
                        continue;
                    }
                    i = close + 1;
                    break;
                }
                for (let k = 0; k < value.length; k++) {
                    if (value[k] === '\n' || (value[k] === '\r' && value[k + 1] !== '\n')) line++;
                }
                row.push(value);
                if (i < n && input[i] !== delimiter && input[i] !== '\n' && input[i] !== '\r') {
                    throw new DatabaseError(`Row ${rowNumber()} (line ${line}): there is text after a closing quote. Put the whole field in quotes, with "" for a quote inside it.`, { code: 'BAD_INPUT', line, row: rowNumber() });
                }
            } else {
                let end = i;
                while (end < n && input[end] !== delimiter && input[end] !== '\n' && input[end] !== '\r') end++;
                row.push(end === i ? null : input.slice(i, end));
                i = end;
            }
            if (i < n && input[i] === delimiter) {
                i++;
                continue;
            }
            break;
        }
        rows.push(row);
        lines.push(rowLine);
        if (i < n) {
            i += input[i] === '\r' && input[i + 1] === '\n' ? 2 : 1;
            line++;
        }
    }
    return { rows, lines };
}
