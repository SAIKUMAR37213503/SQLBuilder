// Imports into the open SQL Lab database: a SQL script, CSV or JSON. Runs in
// the database worker, so a large file never freezes the page.
//
// Every import is two steps. previewImport() reads the text and describes
// what would happen (statements, columns and their types, the first rows);
// it never changes anything. runImport() reads the same text again and runs
// it in one transaction, so a failure leaves the database as it was.
// Rows are inserted with a prepared statement and bound values, never by
// writing values into SQL text.

import { DatabaseError } from './engine.js';
import { parseCsv, detectDelimiter, delimiterName } from './import-csv.js';
import { parseJsonRows } from './import-json.js';
import { parseHtmlRows, looksLikeHtml } from './import-html.js';
import { readScript, runnableScript, groupStatements } from './import-sql.js';
import { adaptSqlServerScript, looksLikeSqlServer } from './import-sqlserver.js';
import { COLUMN_TYPES, describeColumns, uniqueNames, bindValue, createTableSql, insertSql } from './import-types.js';
import { MAX_FILE_BYTES, textEncoding } from './import-stream.js';

export { textEncoding };

/** Pasted text longer than this isn't imported (a file is read in parts, up to MAX_FILE_BYTES). */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
export const PREVIEW_ROWS = 50;
export const MAX_COLUMNS = 2000;
export const MAX_TABLE_NAME = 128;

const FIRST_SQL_WORD = /^(?:SELECT|INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|WITH|BEGIN|COMMIT|PRAGMA|VALUES|SET|USE|DECLARE|START|EXPLAIN|ANALYZE|VACUUM|REINDEX|TRUNCATE|GRANT|LOCK)\b/i;

/**
 * Which kind of import a file or pasted text is.
 * @param {{ name?: string, text?: string, bytes?: Uint8Array }} source
 * @returns {'sql' | 'csv' | 'json' | 'html' | 'sqlite'}
 */
export function detectFormat({ name = '', text = '', bytes }) {
    if (bytes && bytes.length >= 16 && new TextDecoder().decode(bytes.subarray(0, 15)) === 'SQLite format 3') return 'sqlite';
    // employees.csv.bak is read as employees.csv
    const ext = /\.([a-z0-9]+)$/i.exec(String(name).replace(/\.bak$/i, ''))?.[1]?.toLowerCase() || '';
    if (['sqlite', 'sqlite3', 'db', 'db3'].includes(ext)) return 'sqlite';
    if (ext === 'sql') return 'sql';
    if (['json', 'jsonl', 'ndjson'].includes(ext)) return 'json';
    if (['csv', 'tsv', 'tab'].includes(ext)) return 'csv';
    if (['html', 'htm', 'xhtml'].includes(ext)) return 'html';
    if (looksLikeHtml(text)) return 'html';
    const start = text.replace(/^\ufeff/, '').replace(/^(?:\s+|--[^\n]*\n?|\/\*[\s\S]*?\*\/)*/, '');
    if (start[0] === '[' || start[0] === '{') return 'json';
    if (/^(?:--|\/\*)/.test(text.trim()) || FIRST_SQL_WORD.test(start)) return 'sql';
    return 'csv';
}

/**
 * Why a file's first bytes can't be imported, or null when they can be read
 * (text, or a SQLite database). A file named .bak can hold anything: a copy
 * of a SQLite database or a SQL script imports as usual, but a SQL Server or
 * PostgreSQL backup needs that server to restore it.
 * @param {Uint8Array} head the first few KB of the file
 * @param {string} name
 * @returns {string | null}
 */
export function unreadableFile(head, name) {
    const start = new TextDecoder('latin1').decode(head.subarray(0, 16));
    if (start.startsWith('SQLite format 3')) return null;
    if (start.startsWith('TAPE') || start.startsWith('MSSQLBAK')) {
        return `${name} is a SQL Server backup. SQL Lab can't restore SQL Server backups, as only SQL Server can read them. In SQL Server Management Studio, right-click the database and choose Tasks, then Generate Scripts…; under Advanced, set "Types of data to script" to "Schema and data", save the script as a .sql file and import that. SQL Lab adapts it for SQLite and lists every change first.`;
    }
    if (start.startsWith('PGDMP')) {
        return `${name} is a PostgreSQL backup in pg_dump's custom format, which only PostgreSQL can read. Turn it into a SQL script with pg_restore -f backup.sql "${name}" (or make one with pg_dump --format=plain) and import the .sql file.`;
    }
    // Text never contains NUL bytes; UTF-16 text is the exception, with a byte order mark
    const utf16 = (head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff);
    if (!utf16 && head.includes(0)) {
        return `${name} isn't a file SQL Lab can import. Import a SQL script, a CSV or JSON file, or a SQLite database file.`;
    }
    return null;
}

/**
 * The text of a file, decoded by its byte order mark (UTF-8 without one).
 * The mark itself is dropped.
 * @param {Uint8Array} bytes
 */
export function decodeText(bytes) {
    return new TextDecoder(textEncoding(bytes)).decode(bytes);
}

/** The largest file that can be imported (it is read a few MB at a time). */
export function maxFileBytes() {
    return MAX_FILE_BYTES;
}

/** A table name from a file name: employees.csv → employees (employees.csv.bak too). */
export function tableNameFor(fileName) {
    const stem = String(fileName || '').replace(/\.bak$/i, '').replace(/\.[^.]*$/, '').trim();
    return stem.slice(0, MAX_TABLE_NAME) || 'imported_data';
}

function checkSize(text) {
    if (typeof text !== 'string') throw new DatabaseError('There is nothing to import.', { code: 'BAD_INPUT' });
    if (text.length > MAX_IMPORT_BYTES) throw new DatabaseError(`This is too large to import (the limit is ${MAX_IMPORT_BYTES / 1024 / 1024} MB).`, { code: 'TOO_LARGE' });
}

export const TABULAR = ['csv', 'json', 'html'];
export const NOT_TABULAR = 'Choose SQL, CSV, JSON or HTML.';

/**
 * CSV, JSON or an HTML table as columns and rows.
 * @param {'csv' | 'json' | 'html'} format
 * @param {string} text
 * @param {{ delimiter?: string, header?: boolean, table?: number }} options
 */
function readTable(format, text, { delimiter = 'auto', header = true, table } = {}) {
    if (format === 'html') {
        const html = parseHtmlRows(text, { table });
        if (html.columns.length > MAX_COLUMNS) throw new DatabaseError(`There are ${html.columns.length} columns; SQLite allows up to ${MAX_COLUMNS}.`, { code: 'BAD_INPUT' });
        if (html.rows.length === 0) throw new DatabaseError('This table has only a header row, so there are no rows to import.', { code: 'BAD_INPUT' });
        return { columns: uniqueNames(html.columns), rows: html.rows, lines: html.lines, nested: 0, from: null, delimiter: null, header: html.header, html };
    }
    if (format === 'json') {
        const json = parseJsonRows(text);
        return { columns: json.columns, rows: json.rows, lines: json.lines, nested: json.nested, from: json.from, delimiter: null, header: null, html: null };
    }
    const used = !delimiter || delimiter === 'auto' ? detectDelimiter(text) : delimiter;
    const { rows: all, lines: allLines } = parseCsv(text, { delimiter: used });
    if (all.length === 0) throw new DatabaseError('There are no rows to import.', { code: 'BAD_INPUT' });
    const names = header ? all[0].map(v => v ?? '') : all[0].map((_, i) => `column${i + 1}`);
    const rows = header ? all.slice(1) : all;
    const lines = header ? allLines.slice(1) : allLines;
    const width = names.length;
    if (width > MAX_COLUMNS) throw new DatabaseError(`There are ${width} columns; SQLite allows up to ${MAX_COLUMNS}.`, { code: 'BAD_INPUT' });
    rows.forEach((row, i) => {
        if (row.length !== width) {
            throw new DatabaseError(`Row ${i + 1} (line ${lines[i]}) has ${row.length} ${row.length === 1 ? 'value' : 'values'}, but ${header ? 'the header has' : 'the first row has'} ${width}. Check the delimiter (${delimiterName(used)} is used), or put values containing it in double quotes.`, { code: 'BAD_INPUT', row: i + 1, line: lines[i] });
        }
    });
    if (rows.length === 0) throw new DatabaseError(header ? 'There is only a header row, so there are no rows to import.' : 'There are no rows to import.', { code: 'BAD_INPUT' });
    return { columns: uniqueNames(names), rows, lines, nested: 0, from: null, delimiter: used, header, html: null };
}

export const display = (/** @type {unknown} */ value) => (typeof value === 'boolean' ? String(value) : value ?? null);

/**
 * What a preview says about how a table's values are read.
 * @param {'csv' | 'json' | 'html'} format
 * @param {{ from: string | null, nested: number, html: { spanned: number, padded: number } | null, described: { type: string }[] }} table
 */
export function tableNotes(format, { from, nested, html, described }) {
    const notes = [];
    if (from) notes.push(`The rows are read from the "${from}" list.`);
    if (nested) notes.push(`${nested.toLocaleString()} ${nested === 1 ? 'value is a nested object or list; it is' : 'values are nested objects or lists; they are'} stored as JSON text.`);
    if (html) {
        if (html.spanned) notes.push(`${html.spanned.toLocaleString()} ${html.spanned === 1 ? 'cell spans' : 'cells span'} several columns: the value goes in the first, and the others are NULL.`);
        if (html.padded) notes.push(`${html.padded.toLocaleString()} ${html.padded === 1 ? 'row has' : 'rows have'} fewer cells than the widest row; the missing cells are NULL.`);
        notes.push('Cells are read as plain text: tags and styles are dropped. Empty cells become NULL.');
    } else if (format === 'csv') notes.push('Empty cells become NULL. A quoted empty value ("") becomes empty text.');
    else notes.push('Missing keys and null become NULL. true and false are stored as 1 and 0 (SQLite has no boolean type).');
    if (described.some(c => c.type === 'DATE' || c.type === 'DATETIME')) notes.push('SQLite has no date type: dates are stored as text, like 2024-01-31, which sorts and compares correctly.');
    return notes;
}

/**
 * What an import would do. Changes nothing.
 * `adapt` (SQL only): adapt a SQL Server script for SQLite first (import-sqlserver.js).
 * @param {{ format: 'sql' | 'csv' | 'json' | 'html', text: string, options?: { delimiter?: string, header?: boolean, table?: number }, adapt?: boolean }} args
 */
export function previewImport({ format, text, options = {}, adapt = false }) {
    checkSize(text);
    if (format === 'sql') {
        const sqlServer = looksLikeSqlServer(text);
        // Only a script that looks like SQL Server's is adapted
        const adapted = adapt && sqlServer ? adaptSqlServerScript(text) : null;
        if (adapted) text = adapted.text;
        const { statements, problem, notes } = readScript(text);
        if (problem) throw new DatabaseError(problem.message, { code: 'BAD_INPUT', line: problem.line, column: problem.column });
        const run = statements.filter(s => !s.skip);
        if (run.length === 0) throw new DatabaseError('There are no SQL statements to run.', { code: 'BAD_INPUT' });
        const { groups, more } = groupStatements(statements);
        const issues = run.reduce((count, s) => count + s.issues.length, 0);
        const rows = run.every(s => s.kind !== 'modify' || s.rows !== null) ? run.reduce((sum, s) => sum + (s.rows || 0), 0) : null;
        return {
            format,
            statements: run.length,
            skipped: statements.length - run.length,
            rows,
            issues,
            groups,
            more,
            creates: run.filter(s => /^CREATE (?:TABLE|VIEW)\b/.test(s.label) && s.object).map(s => ({ name: s.object, ifNotExists: s.ifNotExists, line: s.line })),
            notes,
            sqlServer,
            changes: adapted ? adapted.changes : null
        };
    }
    if (!TABULAR.includes(format)) throw new DatabaseError(NOT_TABULAR, { code: 'BAD_INPUT' });
    const table = readTable(format, text, options);
    const described = describeColumns(table.rows, table.columns.length);
    const notes = tableNotes(format, { from: table.from, nested: table.nested, html: table.html, described });
    return {
        format,
        delimiter: table.delimiter,
        header: table.header,
        tables: table.html ? table.html.tables : null,
        table: table.html ? table.html.table : null,
        rowCount: table.rows.length,
        columns: table.columns.map((name, i) => ({ name, type: described[i].type, nonEmpty: described[i].nonEmpty, fits: described[i].fits })),
        sample: table.rows.slice(0, PREVIEW_ROWS).map(row => row.map(display)),
        notes
    };
}

/**
 * Checks where imported rows go: a new table (its CREATE TABLE is returned
 * as `setup`) or an existing one, whose columns the file's must match.
 * @param {any} adapter
 * @param {string[]} names the file's column names
 * @param {{ mode: 'new' | 'append', table: string, types?: string[] } | undefined} target
 */
export function prepareTarget(adapter, names, target) {
    const name = String(target?.table ?? '').trim();
    if (!name) throw new DatabaseError('Enter a table name.', { code: 'BAD_INPUT' });
    if (name.length > MAX_TABLE_NAME) throw new DatabaseError(`Table names can be up to ${MAX_TABLE_NAME} characters.`, { code: 'BAD_INPUT' });
    if (/^sqlite_/i.test(name)) throw new DatabaseError('Names starting with "sqlite_" are reserved by SQLite.', { code: 'BAD_INPUT' });
    const existing = adapter.schema().find((/** @type {any} */ o) => o.name.toLowerCase() === name.toLowerCase());

    /** @type {string[]} */
    let setup = [];
    let tableName = name;
    let columns = names;
    if (target?.mode === 'append') {
        if (!existing || existing.type !== 'table') throw new DatabaseError(`There is no table named ${name} in this database.`, { code: 'BAD_INPUT' });
        tableName = existing.name;
        const byName = new Map(existing.columns.map((/** @type {any} */ c) => [c.name.toLowerCase(), c.name]));
        const missing = columns.filter(c => !byName.has(c.toLowerCase()));
        if (missing.length) throw new DatabaseError(`${existing.name} has no ${missing.length === 1 ? 'column' : 'columns'} named ${missing.join(', ')}. Rename ${missing.length === 1 ? 'it' : 'them'} in the file to match, or import into a new table.`, { code: 'BAD_INPUT' });
        columns = columns.map(c => byName.get(c.toLowerCase()));
    } else {
        if (existing) throw new DatabaseError(`This database already has a ${existing.type} named ${existing.name}. Choose another name, or add the rows to that table.`, { code: 'EXISTS' });
        const types = target?.types || [];
        const chosen = columns.map((_, i) => (COLUMN_TYPES.includes(types[i]) ? types[i] : null));
        if (chosen.some(t => t === null)) throw new DatabaseError('Choose a type for every column.', { code: 'BAD_INPUT' });
        setup = [createTableSql(name, columns.map((c, i) => ({ name: c, type: /** @type {string} */ (chosen[i]) })))];
    }
    return { setup, tableName, columns };
}

/**
 * Runs an import in the open database, in one transaction.
 * @param {any} adapter
 * @param {{
 *   format: 'sql' | 'csv' | 'json' | 'html', text: string,
 *   options?: { delimiter?: string, header?: boolean, table?: number },
 *   target?: { mode: 'new' | 'append', table: string, types?: string[] },
 *   adapt?: boolean
 * }} args
 */
export function runImport(adapter, { format, text, options = {}, target, adapt = false }) {
    checkSize(text);
    if (format === 'sql') {
        if (adapt && looksLikeSqlServer(text)) text = adaptSqlServerScript(text).text;
        const { statements, problem } = readScript(text);
        if (problem) throw new DatabaseError(problem.message, { code: 'BAD_INPUT', line: problem.line, column: problem.column });
        if (!statements.some(s => !s.skip)) throw new DatabaseError('There are no SQL statements to run.', { code: 'BAD_INPUT' });
        return { format, ...adapter.runScript(runnableScript(text, statements)) };
    }
    if (!TABULAR.includes(format)) throw new DatabaseError(NOT_TABULAR, { code: 'BAD_INPUT' });
    const table = readTable(format, text, options);
    const { setup, tableName, columns } = prepareTarget(adapter, table.columns, target);
    const rows = table.rows.map(row => row.map(bindValue));
    try {
        const result = adapter.insertRows({ setup, sql: insertSql(tableName, columns), rows });
        return { format, table: tableName, created: target?.mode !== 'append', ...result };
    } catch (error) {
        const e = /** @type {any} */ (error);
        if (typeof e?.row === 'number') {
            const line = table.lines ? table.lines[e.row - 1] : undefined;
            const item = format === 'json' && !table.lines ? `Item ${e.row}` : `Row ${e.row}${line ? ` (line ${line})` : ''}`;
            throw new DatabaseError(`${item}: ${e.message}`, { code: e.code, row: e.row, line });
        }
        throw error;
    }
}
