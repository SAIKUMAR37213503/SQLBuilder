// Reads a SQL script before it is imported into a SQL Lab database: splits it
// into statements, names each one (CREATE TABLE Employees, INSERT INTO
// Employees, 120 rows of values…) and flags what SQLite can't run, with the
// line and column. Nothing here runs SQL.
//
// The import runs the whole script in one transaction of its own, so the
// script's own BEGIN / COMMIT statements are left out, and SQL Server's GO
// lines (a batch separator, not SQL) end a statement. Both are listed in the
// preview; nothing else is changed.

import { lex, significant, isWord, nameOf } from '../sql-lexer.js';
import { statementKind } from './sqlite-adapter.js';

/**
 * @typedef {{ message: string, line: number, column: number }} Issue
 * @typedef {{
 *   start: number, end: number, line: number, column: number,
 *   label: string, kind: string, object: string | null, ifNotExists: boolean,
 *   rows: number | null, skip: 'transaction' | 'separator' | null, issues: Issue[]
 * }} ScriptStatement
 */

// Statements SQLite doesn't have, by their first word
const NOT_SQLITE = {
    SET: 'SET isn\'t a SQLite statement (SQLite has no session settings).',
    USE: 'USE isn\'t a SQLite statement: a SQL Lab database is chosen in the list, not in SQL.',
    DECLARE: 'DECLARE (variables) is SQL Server and isn\'t in SQLite.',
    PRINT: 'PRINT is SQL Server and isn\'t in SQLite.',
    EXEC: 'EXEC (stored procedures) is SQL Server and isn\'t in SQLite.',
    EXECUTE: 'EXECUTE (stored procedures) isn\'t in SQLite.',
    IF: 'IF … BEGIN … END blocks are SQL Server and aren\'t in SQLite.',
    LOCK: 'LOCK TABLES is MySQL and isn\'t in SQLite.',
    UNLOCK: 'UNLOCK TABLES is MySQL and isn\'t in SQLite.',
    COPY: 'COPY is PostgreSQL and isn\'t in SQLite.',
    GRANT: 'GRANT isn\'t in SQLite (it has no users).',
    REVOKE: 'REVOKE isn\'t in SQLite (it has no users).',
    DELIMITER: 'DELIMITER is a MySQL client command, not SQL.',
    TRUNCATE: 'SQLite has no TRUNCATE. Use DELETE FROM the table instead.',
    MERGE: 'MERGE isn\'t in SQLite. Use INSERT … ON CONFLICT DO UPDATE instead.',
    CALL: 'CALL (stored procedures) isn\'t in SQLite.',
    SHOW: 'SHOW is MySQL and isn\'t in SQLite.',
    DESCRIBE: 'DESCRIBE is MySQL and isn\'t in SQLite.'
};

// Functions of the other dialects that SQLite doesn't have, and what it uses instead
const NOT_SQLITE_FUNCTIONS = {
    GETDATE: 'Use CURRENT_TIMESTAMP or datetime(\'now\').',
    SYSDATETIME: 'Use CURRENT_TIMESTAMP or datetime(\'now\').',
    NOW: 'Use CURRENT_TIMESTAMP or datetime(\'now\').',
    CURDATE: 'Use CURRENT_DATE or date(\'now\').',
    DATEADD: 'Use date(value, \'+1 day\') or datetime(value, \'+1 hour\').',
    DATE_ADD: 'Use date(value, \'+1 day\').',
    DATEDIFF: 'Use julianday(end) - julianday(start) for days.',
    DATEPART: 'Use strftime(), for example strftime(\'%Y\', value).',
    YEAR: 'Use strftime(\'%Y\', value).',
    MONTH: 'Use strftime(\'%m\', value).',
    TO_CHAR: 'Use strftime() or printf().',
    LEN: 'Use length().',
    ISNULL: 'Use IFNULL() or COALESCE().',
    NVL: 'Use IFNULL() or COALESCE().',
    CHARINDEX: 'Use instr(text, part).',
    GETUTCDATE: 'Use datetime(\'now\'), which is UTC.'
};

const WORD_START = /[\p{L}_@#]/u;
const WORD_CHAR = /[\p{L}\p{N}_$@#]/u;
// ASCII without a regular expression: a script can be millions of characters
const isWordStart = (/** @type {number} */ c, /** @type {string} */ ch) =>
    (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 64 || c === 35 || (c > 127 && WORD_START.test(ch));
const isWordChar = (/** @type {number} */ c, /** @type {string} */ ch) =>
    isWordStart(c, ch) || (c >= 48 && c <= 57) || c === 36 || (c > 127 && WORD_CHAR.test(ch));

/**
 * Splits a script into statements (where SQLite would) and notes what each
 * contains. Returns a problem when a quote or comment is never closed.
 * @param {string} text
 */
export function scanScript(text) {
    /** @type {any[]} */
    const out = [];
    /** @type {Issue | null} */
    let problem = null;
    let i = 0;
    let line = 1;
    let lineStart = 0;
    const n = text.length;
    /** @type {any} */
    let stmt = null;

    const column = (/** @type {number} */ at) => at - lineStart + 1;
    /** Moves to `to`, counting the lines passed. */
    function advance(to) {
        for (let k = i; k < to; k++) {
            if (text.charCodeAt(k) === 10) {
                line++;
                lineStart = k + 1;
            }
        }
        i = to;
    }
    function begin(at) {
        if (!stmt) {
            stmt = { start: at, line, column: column(at), words: [], depth: 0, trigger: false, block: 0, values: false, tuples: 0, issues: [], prev: '', prev2: '', prevAt: null, prev2At: null, lastPunct: '' };
        }
        return stmt;
    }
    function finish(end) {
        if (stmt) out.push({ ...stmt, end });
        stmt = null;
    }
    const flag = (/** @type {string} */ message, /** @type {number} */ at, /** @type {number} */ atLine = line, /** @type {number} */ atCol = column(at)) => {
        if (stmt && stmt.issues.length < 20 && !stmt.issues.some((/** @type {Issue} */ x) => x.message === message)) {
            stmt.issues.push({ message, line: atLine, column: atCol });
        }
    };
    const unclosed = (/** @type {string} */ what, /** @type {number} */ atLine, /** @type {number} */ atCol) => {
        problem = { message: `${what} opened on line ${atLine}, column ${atCol} is never closed, so the rest of the script can't be read.`, line: atLine, column: atCol };
    };

    while (i < n && !problem) {
        const ch = text[i];
        const next = text[i + 1];
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || ch === '\u00a0' || ch === '\ufeff') {
            advance(i + 1);
        } else if (ch === '-' && next === '-') {
            const close = text.indexOf('\n', i);
            advance(close === -1 ? n : close);
        } else if (ch === '/' && next === '*') {
            const close = text.indexOf('*/', i + 2);
            if (close === -1) unclosed('A /* comment', line, column(i));
            else advance(close + 2);
        } else if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
            const s = begin(i);
            const closeChar = ch === '[' ? ']' : ch;
            const startLine = line;
            const startCol = column(i);
            let k = i + 1;
            for (;;) {
                const close = text.indexOf(closeChar, k);
                if (close === -1) {
                    k = -1;
                    break;
                }
                if (closeChar !== ']' && text[close + 1] === closeChar) {
                    k = close + 2;
                    continue;
                }
                k = close + 1;
                break;
            }
            if (k === -1) {
                unclosed(ch === "'" ? 'A quote (\')' : `A quoted name (${ch})`, startLine, startCol);
            } else {
                advance(k);
            }
            s.prev2 = s.prev;
            s.prev = ch === "'" ? "'" : 'NAME';
            s.lastPunct = '';
        } else if (ch === '$' && /[A-Za-z_$]/.test(next || '')) {
            const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 66))?.[0];
            begin(i);
            if (tag) {
                flag('Dollar-quoted text ($$…$$) is PostgreSQL; SQLite can\'t read it.', i);
                const close = text.indexOf(tag, i + tag.length);
                if (close === -1) unclosed('Dollar-quoted text', line, column(i));
                else advance(close + tag.length);
            } else {
                advance(i + 1);
            }
        } else if (ch === ';') {
            if (stmt && stmt.trigger && stmt.block > 0) {
                advance(i + 1);
            } else {
                finish(i);
                advance(i + 1);
            }
        } else if (isWordStart(text.charCodeAt(i), ch)) {
            let k = i + 1;
            while (k < n && isWordChar(text.charCodeAt(k), text[k])) k++;
            const word = text.slice(i, k).toUpperCase();
            // GO alone on its line (SQL Server's batch separator)
            if (word === 'GO' && /^[ \t]*$/.test(text.slice(lineStart, i)) && /^[ \t]*(?:\d+[ \t]*)?(?:--[^\n]*)?(?:\r?\n|$)/.test(text.slice(k, k + 200))) {
                const end = /^[ \t]*(?:\d+)?/.exec(text.slice(k))?.[0].length || 0;
                finish(i);
                out.push({ start: i, end: k + end, line, column: column(i), separator: true, words: ['GO'], issues: [] });
                advance(k + end);
                continue;
            }
            const s = begin(i);
            if (s.words.length < 6) s.words.push(word);
            if (s.words.length <= 4 && s.words[0] === 'CREATE' && word === 'TRIGGER') s.trigger = true;
            if (s.trigger) {
                if (word === 'BEGIN' || word === 'CASE') s.block++;
                else if (word === 'END' && s.block > 0) s.block--;
            }
            const insert = s.words[0] === 'INSERT' || s.words[0] === 'REPLACE';
            if (insert && s.depth === 0) {
                if (word === 'VALUES') s.values = true;
                else if (word === 'ON' || word === 'RETURNING' || word === 'WHERE' || word === 'SELECT') s.values = false;
            }
            if (word === 'TOP' && (s.prev === 'SELECT' || (s.prev === 'DISTINCT' && s.prev2 === 'SELECT'))) flag('SQLite has no TOP. Use LIMIT at the end of the query instead.', i);
            else if (word === 'AUTO_INCREMENT') flag('AUTO_INCREMENT is MySQL. In SQLite, an INTEGER PRIMARY KEY column numbers rows by itself.', i);
            else if (word === 'IDENTITY' && s.words[0] === 'CREATE') flag('IDENTITY is SQL Server. SQLite reads it as part of the type and won\'t number rows; use INTEGER PRIMARY KEY.', i);
            else if (word === 'KEY' && s.prev === 'DUPLICATE' && s.prev2 === 'ON') flag('ON DUPLICATE KEY UPDATE is MySQL. SQLite uses ON CONFLICT … DO UPDATE.', s.prev2At.at, s.prev2At.line, s.prev2At.column);
            else if (word === 'ENGINE' && s.words[0] === 'CREATE' && s.depth === 0) flag('Table options such as ENGINE= are MySQL; SQLite can\'t read them.', i);
            else if (word === 'MAX' && s.lastPunct === '(' && ['VARCHAR', 'NVARCHAR', 'VARBINARY'].includes(s.prev)) flag('(MAX) sizes are SQL Server; SQLite can\'t read them. Leave the size out.', i);
            else if (word === 'FETCH' && (s.prev === 'ROWS' || s.prev === 'ROW')) flag('OFFSET … FETCH isn\'t in SQLite. Use LIMIT … OFFSET instead.', i);
            else if (Object.hasOwn(NOT_SQLITE_FUNCTIONS, word) && s.prev !== '.' && /^\s*\(/.test(text.slice(k, k + 20)) && s.lastPunct !== '.') {
                flag(`SQLite has no ${word}() function. ${NOT_SQLITE_FUNCTIONS[word]}`, i);
            } else if (word === 'ILIKE') flag('ILIKE is PostgreSQL. SQLite\'s LIKE already ignores the case of ASCII letters.', i);
            s.prev2 = s.prev;
            s.prev2At = s.prevAt;
            s.prev = word;
            s.prevAt = { at: i, line, column: column(i) };
            s.lastPunct = '';
            advance(k);
        } else {
            const s = begin(i);
            const code = text.charCodeAt(i);
            if (code >= 48 && code <= 57) {
                // A number: digits, a decimal point, an exponent
                let k = i + 1;
                while (k < n && /[0-9.eE]/.test(text[k])) k++;
                s.lastPunct = '';
                advance(k);
                continue;
            }
            if (ch === '(') {
                if (s.values && s.depth === 0) s.tuples++;
                s.depth++;
            } else if (ch === ')') {
                s.depth = Math.max(0, s.depth - 1);
            } else if (ch === ':' && next === ':') {
                flag('The :: cast is PostgreSQL. Use CAST(value AS type) instead.', i);
                advance(i + 2);
                s.lastPunct = '::';
                continue;
            }
            s.lastPunct = ch;
            advance(i + 1);
        }
    }
    if (!problem) finish(n);
    return { statements: out, problem };
}

/** Reads a name (with an optional schema prefix) at tokens[i]. */
function readName(tokens, i) {
    const parts = [];
    let k = i;
    for (;;) {
        const name = nameOf(tokens[k]);
        if (name === null) break;
        parts.push(name);
        if (tokens[k + 1]?.text === '.' && nameOf(tokens[k + 2]) !== null) k += 2;
        else break;
    }
    return parts;
}

const TRANSACTION_START = /^(?:BEGIN(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?(?:\s+(?:TRANSACTION|TRAN|WORK))?|START\s+TRANSACTION)$/i;
const TRANSACTION_END = /^(?:COMMIT|END|ROLLBACK)(?:\s+(?:TRANSACTION|TRAN|WORK))?$/i;

/**
 * Names a statement from its first words, and flags names SQLite can't use.
 * @param {string} head the statement's first few hundred characters
 * @param {{ line: number, column: number }} at where the statement starts
 */
function describe(head, at) {
    const tokens = significant(lex(head));
    const words = tokens.filter(t => t.type === 'word');
    const first = tokens[0]?.type === 'word' ? tokens[0].text.toUpperCase() : '';
    const plain = tokens.map(t => t.text).join(' ').replace(/\s+/g, ' ').trim();
    /** @type {{ label: string, object: string | null, ifNotExists: boolean, skip: 'transaction' | null, issues: Issue[] }} */
    const result = { label: first || plain.slice(0, 40), object: null, ifNotExists: false, skip: null, issues: [] };
    const issue = (message, token) => result.issues.push({ message, line: at.line + (token ? token.line - 1 : 0), column: token ? (token.line === 1 ? at.column + token.col - 1 : token.col) : at.column });

    if (tokens.length <= 6 && (TRANSACTION_START.test(plain) || TRANSACTION_END.test(plain))) {
        result.label = plain.toUpperCase();
        result.skip = 'transaction';
        return result;
    }
    if (Object.hasOwn(NOT_SQLITE, first)) issue(NOT_SQLITE[first], tokens[0]);

    let k = 1;
    let verb = first;
    let what = '';
    if (first === 'CREATE') {
        while (isWord(tokens[k], 'TEMP', 'TEMPORARY', 'UNIQUE', 'VIRTUAL', 'OR', 'REPLACE')) k++;
        what = tokens[k]?.type === 'word' ? tokens[k].text.toUpperCase() : '';
        k++;
        if (isWord(tokens[k], 'IF') && isWord(tokens[k + 1], 'NOT') && isWord(tokens[k + 2], 'EXISTS')) {
            result.ifNotExists = true;
            k += 3;
        }
    } else if (first === 'DROP' || first === 'ALTER') {
        what = tokens[k]?.type === 'word' ? tokens[k].text.toUpperCase() : '';
        k++;
        if (isWord(tokens[k], 'IF') && isWord(tokens[k + 1], 'EXISTS')) k += 2;
    } else if (first === 'INSERT' || first === 'REPLACE') {
        if (isWord(tokens[k], 'OR')) k += 2;
        if (isWord(tokens[k], 'INTO')) k++;
        verb = first;
        what = 'INTO';
    } else if (first === 'UPDATE') {
        if (isWord(tokens[k], 'OR')) k += 2;
    } else if (first === 'DELETE') {
        if (isWord(tokens[k], 'FROM')) k++;
        what = 'FROM';
    } else if (first === 'PRAGMA') {
        const parts = readName(tokens, k);
        result.label = parts.length ? `PRAGMA ${parts.join('.')}` : 'PRAGMA';
        return result;
    } else {
        result.label = first === 'WITH' ? `WITH … ${words.some(w => isWord(w, 'INSERT', 'UPDATE', 'DELETE', 'REPLACE')) ? '(changes rows)' : '(query)'}` : (first || plain.slice(0, 40));
        return result;
    }
    const parts = readName(tokens, k);
    const name = parts.join('.');
    result.object = parts.length ? parts[parts.length - 1] : null;
    result.label = [verb, what, name].filter(Boolean).join(' ');
    // SQLite's only schemas are "main" and "temp" (and attached databases)
    if (parts.length > 1 && !['main', 'temp'].includes(parts[0].toLowerCase())) {
        issue(`SQLite has no schemas, so ${name} can't be used. Remove the "${parts.slice(0, -1).join('.')}." prefix.`, tokens[k]);
    }
    return result;
}

/**
 * Reads a script for the import preview.
 * @param {string} text
 * @returns {{ statements: ScriptStatement[], problem: Issue | null, notes: string[] }}
 */
export function readScript(text) {
    const { statements: scanned, problem } = scanScript(text);
    /** @type {ScriptStatement[]} */
    const statements = scanned.map(s => {
        if (s.separator) {
            return { start: s.start, end: s.end, line: s.line, column: s.column, label: 'GO', kind: 'other', object: null, ifNotExists: false, rows: null, skip: 'separator', issues: [] };
        }
        const head = text.slice(s.start, Math.min(s.end, s.start + 300));
        const d = describe(head, s);
        const kind = d.skip ? 'transaction' : statementKind(head);
        const insert = s.words[0] === 'INSERT' || s.words[0] === 'REPLACE';
        return {
            start: s.start, end: s.end, line: s.line, column: s.column,
            label: d.label, kind, object: d.object, ifNotExists: d.ifNotExists,
            rows: insert && s.tuples > 0 ? s.tuples : null,
            skip: d.skip,
            issues: d.skip ? [] : [...d.issues, ...s.issues].sort((a, b) => a.line - b.line || a.column - b.column)
        };
    });
    const notes = [];
    if (statements.some(s => s.skip === 'transaction')) notes.push('The script\'s own BEGIN and COMMIT statements are left out: the import runs everything in one transaction of its own, so if any statement fails, nothing is kept.');
    if (statements.some(s => s.skip === 'separator')) notes.push('GO lines (SQL Server\'s batch separator, not SQL) are read as the end of a statement and aren\'t run.');
    if (text.includes('`') && /\\'/.test(text)) notes.push('This looks like a MySQL file that writes quotes inside text as \\\'. SQLite reads that differently (it expects \'\'), so statements with it will fail.');
    return { statements, problem, notes };
}

/**
 * The script as it will run: left-out statements and GO lines become blanks
 * (the same length, so line and column numbers in errors still match the file).
 * @param {string} text
 * @param {ScriptStatement[]} statements
 */
export function runnableScript(text, statements) {
    let out = '';
    let at = 0;
    for (const s of statements) {
        if (!s.skip) continue;
        out += text.slice(at, s.start);
        const blank = text.slice(s.start, s.end).replace(/[^\n\r]/g, ' ');
        // A GO ends the statement before it, as a semicolon does
        out += s.skip === 'separator' ? `;${blank.slice(1)}` : blank;
        at = s.end;
        // The left-out statement's own semicolon
        if (s.skip === 'transaction' && text[at] === ';') {
            out += ' ';
            at++;
        }
    }
    return out + text.slice(at);
}

/**
 * Consecutive statements with the same label, for a short preview list.
 * @param {ScriptStatement[]} statements
 * @param {number} [limit] at most this many groups
 */
export function groupStatements(statements, limit = 200) {
    const groups = createGroups(limit);
    for (const s of statements) groups.add(s);
    return groups.result();
}

/**
 * Groups statements as they are read (a large script is read in parts).
 * @param {number} [limit] at most this many groups are kept
 */
export function createGroups(limit = 200) {
    /** @type {{ label: string, kind: string, count: number, rows: number | null, line: number, column: number, skip: string | null, issues: Issue[] }[]} */
    const groups = [];
    /** @type {any} */
    let last = null;
    let total = 0;
    return {
        /** @param {ScriptStatement} s */
        add(s) {
            if (last && last.label === s.label && last.skip === s.skip && (s.issues.length === 0) === (last.issues.length === 0)) {
                last.count++;
                last.rows = last.rows === null || s.rows === null ? null : last.rows + s.rows;
                for (const issue of s.issues) if (last.issues.length < 5) last.issues.push(issue);
            } else {
                last = { label: s.label, kind: s.kind, count: 1, rows: s.rows, line: s.line, column: s.column, skip: s.skip, issues: s.issues.slice(0, 5) };
                total++;
                // Groups past the limit are only counted
                if (groups.length < limit) groups.push(last);
            }
        },
        result: () => ({ groups, more: Math.max(0, total - limit) })
    };
}
