// Imports a file of up to 1 GB (see import-stream.js): the file is read a
// few MB at a time, in the database worker, and never held whole in memory.
// A file small enough to read at once goes through previewImport() and
// runImport() as pasted text does, so both give the same results; a larger
// one is read in parts here, with the same checks, messages and results.
//
// Running a large import is still one transaction: every part runs inside
// it, and when anything fails it is rolled back, so nothing is kept.

import { DatabaseError } from './engine.js';
import {
    previewImport, runImport, prepareTarget, tableNotes, display,
    TABULAR, NOT_TABULAR, PREVIEW_ROWS, MAX_COLUMNS, MAX_IMPORT_BYTES
} from './importer.js';
import { parseCsv, detectDelimiter, delimiterName } from './import-csv.js';
import { parseJson, createKeyList, jsonRow } from './import-json.js';
import { createHtmlTableReader } from './import-html.js';
import { readScript, runnableScript, createGroups } from './import-sql.js';
import { createSqlServerAdapter, looksLikeSqlServer } from './import-sqlserver.js';
import { createColumnStats, uniqueNames, bindValue, insertSql } from './import-types.js';
import {
    isBlob, textChunks, headOf, createProgress, csvParts, lineParts, sqlParts,
    adaptedChunks, jsonListItems, MAX_FILE_BYTES
} from './import-stream.js';

/** Rows inserted at a time while a large file is imported. */
const BATCH_ROWS = 5000;

/**
 * @typedef {{
 *   onProgress?: (progress: { done: number, total: number }) => void,
 *   chunkBytes?: number,
 *   partChars?: number,
 *   wholeBytes?: number
 * }} FileContext
 * wholeBytes: files up to this size are read at once (tests set 0 to read
 * every file in parts).
 */

/**
 * The text of a source small enough to read at once, or null.
 * @param {string | Blob} source
 * @param {FileContext} ctx
 */
async function wholeText(source, ctx) {
    if (!isBlob(source) && typeof source !== 'string') throw new DatabaseError('There is nothing to import.', { code: 'BAD_INPUT' });
    const size = typeof source === 'string' ? source.length : source.size;
    if (size > MAX_FILE_BYTES) throw new DatabaseError(`This file is too large to import (the limit is ${MAX_FILE_BYTES / 1024 / 1024 / 1024} GB).`, { code: 'TOO_LARGE' });
    if (size > (ctx.wholeBytes ?? MAX_IMPORT_BYTES)) return null;
    let text = '';
    for await (const chunk of textChunks(source, { chunkBytes: Math.max(size, 1) })) text += chunk;
    return text;
}

/**
 * What importing a file would do (see previewImport). Changes nothing.
 * @param {{ format: 'sql' | 'csv' | 'json' | 'html', source: string | Blob, options?: { delimiter?: string, header?: boolean, table?: number }, adapt?: boolean }} args
 * @param {FileContext} [ctx]
 */
export async function previewImportFile({ format, source, options = {}, adapt = false }, ctx = {}) {
    const text = await wholeText(source, ctx);
    if (text !== null) {
        ctx.onProgress?.({ done: 1, total: 1 });
        return previewImport({ format, text, options, adapt });
    }
    if (format === 'sql') return previewScript(source, adapt, ctx);
    if (!TABULAR.includes(format)) throw new DatabaseError(NOT_TABULAR, { code: 'BAD_INPUT' });
    if (format === 'csv') return previewCsv(source, options, ctx);
    if (format === 'json') return previewJson(source, ctx);
    return previewHtml(source, options, ctx);
}

/**
 * Imports a file into the open database, in one transaction (see runImport).
 * @param {any} adapter
 * @param {{
 *   format: 'sql' | 'csv' | 'json' | 'html', source: string | Blob,
 *   options?: { delimiter?: string, header?: boolean, table?: number },
 *   target?: { mode: 'new' | 'append', table: string, types?: string[] },
 *   adapt?: boolean
 * }} args
 * @param {FileContext} [ctx]
 */
export async function runImportFile(adapter, { format, source, options = {}, target, adapt = false }, ctx = {}) {
    const text = await wholeText(source, ctx);
    if (text !== null) {
        ctx.onProgress?.({ done: 1, total: 1 });
        return runImport(adapter, { format, text, options, target, adapt });
    }
    if (format !== 'sql' && !TABULAR.includes(format)) throw new DatabaseError(NOT_TABULAR, { code: 'BAD_INPUT' });
    if (format === 'sql') return runScriptFile(adapter, source, adapt, ctx);
    if (format === 'csv') return runCsv(adapter, source, options, target, ctx);
    if (format === 'json') return runJson(adapter, source, target, ctx);
    return runHtml(adapter, source, options, target, ctx);
}

// --------------------------------------------------------------- SQL

/**
 * A script's parts, adapted for SQLite when asked and it looks like SQL Server's.
 * @param {string | Blob} source
 * @param {boolean} adapt
 * @param {FileContext} ctx
 * @param {ReturnType<typeof createProgress>} progress
 */
async function scriptParts(source, adapt, ctx, progress) {
    const head = await headOf(source);
    const sqlServer = looksLikeSqlServer(head);
    const adapter = adapt && sqlServer ? createSqlServerAdapter() : null;
    let chunks = textChunks(source, { chunkBytes: ctx.chunkBytes, progress });
    if (adapter) chunks = adaptedChunks(chunks, adapter);
    return { sqlServer, adapter, parts: sqlParts(chunks, { partChars: ctx.partChars }) };
}

/**
 * A position in a part as a position in the whole file.
 * @param {{ line: number, column: number }} at
 * @param {{ line: number, column: number }} part
 */
const inFile = (at, part) => ({ line: at.line + part.line - 1, column: at.line === 1 ? at.column + part.column : at.column });

/** The statements of one part, with their positions in the file. */
function readPart(part) {
    const { statements, problem, notes } = readScript(part.text);
    for (const s of statements) {
        Object.assign(s, inFile(s, part));
        s.issues = s.issues.map(issue => ({ ...issue, ...inFile(issue, part) }));
    }
    if (problem) {
        const at = inFile(problem, part);
        // The message names the line in the part; it names the line in the file instead
        const message = problem.message.replace(/opened on line \d+, column \d+/, `opened on line ${at.line}, column ${at.column}`);
        throw new DatabaseError(message, { code: 'BAD_INPUT', ...at });
    }
    return { statements, notes };
}

const noteRank = (note) => (note.startsWith('The script\'s own BEGIN') ? 0 : note.startsWith('GO lines') ? 1 : 2);

async function previewScript(source, adapt, ctx) {
    const progress = createProgress(ctx.onProgress, source);
    const { sqlServer, adapter, parts } = await scriptParts(source, adapt, ctx, progress);
    const groups = createGroups();
    const notes = new Set();
    const creates = [];
    let count = 0;
    let skipped = 0;
    let issues = 0;
    let rows = 0;
    let rowsKnown = true;
    for await (const part of parts) {
        const read = readPart(part);
        for (const note of read.notes) notes.add(note);
        for (const s of read.statements) {
            groups.add(s);
            if (s.skip) {
                skipped++;
                continue;
            }
            count++;
            issues += s.issues.length;
            if (s.kind === 'modify' && s.rows === null) rowsKnown = false;
            rows += s.rows || 0;
            if (/^CREATE (?:TABLE|VIEW)\b/.test(s.label) && s.object) creates.push({ name: s.object, ifNotExists: s.ifNotExists, line: s.line });
        }
    }
    if (count === 0) throw new DatabaseError('There are no SQL statements to run.', { code: 'BAD_INPUT' });
    progress.finish();
    const { groups: list, more } = groups.result();
    return {
        format: 'sql',
        statements: count,
        skipped,
        rows: rowsKnown ? rows : null,
        issues,
        groups: list,
        more,
        creates,
        // In the order readScript gives them for a whole script
        notes: [...notes].sort((x, y) => noteRank(x) - noteRank(y)),
        sqlServer,
        changes: adapter ? adapter.changes() : null
    };
}

async function runScriptFile(adapter, source, adapt, ctx) {
    const progress = createProgress(ctx.onProgress, source);
    const { parts } = await scriptParts(source, adapt, ctx, progress);
    adapter.beginImport();
    let statements = 0;
    let any = false;
    try {
        for await (const part of parts) {
            const read = readPart(part);
            if (!read.statements.some(s => !s.skip)) continue;
            any = true;
            try {
                // start and end are still offsets in the part's own text, which runs on its own
                statements += adapter.importScript(runnableScript(part.text, read.statements)).statements;
            } catch (error) {
                const e = /** @type {any} */ (error);
                const where = typeof e?.line === 'number' ? inFile({ line: e.line, column: e.column ?? 1 }, part) : {};
                throw new DatabaseError(e.message, { code: e.code, ...where, ...(typeof e?.statement === 'number' ? { statement: e.statement + statements } : {}) });
            }
        }
        if (!any) throw new DatabaseError('There are no SQL statements to run.', { code: 'BAD_INPUT' });
    } catch (error) {
        adapter.endImport(false);
        throw error;
    }
    const result = adapter.endImport(true);
    progress.finish();
    return { format: 'sql', statements, ...result };
}

// --------------------------------------------------------------- CSV

/**
 * The rows of a CSV file, a part at a time, checked as readTable checks them.
 * @param {string | Blob} source
 * @param {{ delimiter?: string, header?: boolean }} options
 * @param {FileContext} ctx
 * @param {ReturnType<typeof createProgress>} progress
 * @param {(info: { columns: string[], delimiter: string, header: boolean }) => void} onColumns
 */
async function* csvRows(source, { delimiter = 'auto', header = true }, ctx, progress, onColumns) {
    let used = null;
    let width = -1;
    let names = null;
    // Rows read so far, the header included
    let read = 0;
    let body = 0;
    for await (const part of csvParts(textChunks(source, { chunkBytes: ctx.chunkBytes, progress }), { partChars: ctx.partChars })) {
        used ||= !delimiter || delimiter === 'auto' ? detectDelimiter(part.text) : delimiter;
        const { rows, lines } = parseCsv(part.text, { delimiter: used, firstLine: part.line, firstRow: read + 1 });
        read += rows.length;
        let from = 0;
        if (!names && rows.length) {
            names = header ? rows[0].map(v => v ?? '') : rows[0].map((_, i) => `column${i + 1}`);
            width = names.length;
            if (width > MAX_COLUMNS) throw new DatabaseError(`There are ${width} columns; SQLite allows up to ${MAX_COLUMNS}.`, { code: 'BAD_INPUT' });
            onColumns({ columns: uniqueNames(names), delimiter: used, header });
            if (header) from = 1;
        }
        const out = [];
        const outLines = [];
        for (let i = from; i < rows.length; i++) {
            body++;
            const row = rows[i];
            if (row.length !== width) {
                throw new DatabaseError(`Row ${body} (line ${lines[i]}) has ${row.length} ${row.length === 1 ? 'value' : 'values'}, but ${header ? 'the header has' : 'the first row has'} ${width}. Check the delimiter (${delimiterName(used)} is used), or put values containing it in double quotes.`, { code: 'BAD_INPUT', row: body, line: lines[i] });
            }
            out.push(row);
            outLines.push(lines[i]);
        }
        if (out.length) yield { rows: out, lines: outLines, first: body - out.length + 1 };
    }
    if (!names) throw new DatabaseError('There are no rows to import.', { code: 'BAD_INPUT' });
    if (body === 0) throw new DatabaseError(header ? 'There is only a header row, so there are no rows to import.' : 'There are no rows to import.', { code: 'BAD_INPUT' });
}

async function previewCsv(source, options, ctx) {
    const progress = createProgress(ctx.onProgress, source);
    /** @type {any} */
    let info = null;
    /** @type {ReturnType<typeof createColumnStats> | null} */
    let stats = null;
    const sample = [];
    let count = 0;
    for await (const batch of csvRows(source, options, ctx, progress, (i) => {
        info = i;
        stats = createColumnStats(i.columns.length);
    })) {
        stats.add(batch.rows);
        for (const row of batch.rows) if (sample.length < PREVIEW_ROWS) sample.push(row.map(display));
        count += batch.rows.length;
    }
    progress.finish();
    const described = stats.result();
    return {
        format: 'csv',
        delimiter: info.delimiter,
        header: info.header,
        tables: null,
        table: null,
        rowCount: count,
        columns: info.columns.map((name, i) => ({ name, type: described[i].type, nonEmpty: described[i].nonEmpty, fits: described[i].fits })),
        sample,
        notes: tableNotes('csv', { from: null, nested: 0, html: null, described })
    };
}

/**
 * Inserts batches of rows inside one import transaction.
 * @param {any} adapter
 * @param {{ setup: string[], sql: string }} work
 * @param {(rowNumber: number, lineNumber: number | undefined) => string} name how a row is named in a message
 */
function createInserter(adapter, work, name) {
    let setup = work.setup;
    let inserted = 0;
    return {
        /**
         * @param {unknown[][]} rows
         * @param {number} first the first row's number
         * @param {(number | null)[] | null} lines
         */
        insert(rows, first, lines) {
            for (let at = 0; at < rows.length; at += BATCH_ROWS) {
                const slice = rows.slice(at, at + BATCH_ROWS).map(row => row.map(bindValue));
                try {
                    inserted += adapter.importRows({ setup, sql: work.sql, rows: slice, firstRow: first + at }).rowsInserted;
                } catch (error) {
                    const e = /** @type {any} */ (error);
                    if (typeof e?.row === 'number') {
                        const line = lines ? lines[e.row - first] ?? undefined : undefined;
                        throw new DatabaseError(`${name(e.row, line)}: ${e.message}`, { code: e.code, row: e.row, line });
                    }
                    throw error;
                }
                setup = [];
            }
        },
        get inserted() {
            return inserted;
        }
    };
}

/** Runs an import's inserts in one transaction; returns what runImport returns. */
async function inTransaction(adapter, format, tableName, target, work) {
    adapter.beginImport();
    let inserted;
    try {
        inserted = await work();
    } catch (error) {
        adapter.endImport(false);
        throw error;
    }
    const { durationMs } = adapter.endImport(true);
    return { format, table: tableName, created: target?.mode !== 'append', rowsInserted: inserted, durationMs };
}

const rowName = (row, line) => `Row ${row}${line ? ` (line ${line})` : ''}`;

async function runCsv(adapter, source, options, target, ctx) {
    const progress = createProgress(ctx.onProgress, source);
    /** @type {any} */
    let prepared = null;
    let inserter = null;
    const rows = csvRows(source, options, ctx, progress, ({ columns }) => {
        prepared = prepareTarget(adapter, columns, target);
    });
    // The first part names the columns; the table is checked before the transaction starts
    const next = await rows.next();
    if (next.done || !next.value) throw new DatabaseError('There are no rows to import.', { code: 'BAD_INPUT' });
    const first = next.value;
    const result = await inTransaction(adapter, 'csv', prepared.tableName, target, async () => {
        inserter = createInserter(adapter, { setup: prepared.setup, sql: insertSql(prepared.tableName, prepared.columns) }, rowName);
        inserter.insert(first.rows, first.first, first.lines);
        for await (const batch of rows) inserter.insert(batch.rows, batch.first, batch.lines);
        return inserter.inserted;
    });
    progress.finish();
    return result;
}

// -------------------------------------------------------------- JSON

/**
 * The items of a large JSON file: a list, a list held by an object's only
 * property, or JSON Lines. Each is { value, number, line } (line for JSON Lines).
 * @param {string | Blob} source
 * @param {FileContext} ctx
 * @param {ReturnType<typeof createProgress>} progress
 * @param {{ from: string | null, lines: boolean }} shape
 */
async function* jsonItems(source, ctx, progress, shape) {
    const head = (await headOf(source, 1024 * 1024)).replace(/^\ufeff/, '');
    const start = head.trimStart();
    if (start[0] !== '[' && start[0] !== '{') {
        throw new DatabaseError('JSON for a table must be a list of objects, like [{"id": 1, "name": "Ada"}], or one object per line.', { code: 'BAD_INPUT', line: 1, column: 1 });
    }
    const chunks = textChunks(source, { chunkBytes: ctx.chunkBytes, progress });
    let number = 0;
    // One object on the first line, and more after it: JSON Lines
    const firstLine = start.indexOf('\n') >= 0 ? start.slice(0, start.indexOf('\n')).trim() : null;
    let jsonLines = false;
    if (start[0] === '{' && firstLine) {
        try {
            const value = JSON.parse(firstLine);
            jsonLines = value !== null && typeof value === 'object' && !Array.isArray(value);
        } catch {
            jsonLines = false;
        }
    }
    shape.lines = jsonLines;
    if (jsonLines) {
        for await (const part of lineParts(chunks, { partChars: ctx.partChars })) {
            const lines = part.text.split('\n');
            for (let i = 0; i < lines.length; i++) {
                const text = lines[i].replace(/\r$/, '').replace(/^\ufeff/, '').trim();
                if (!text) continue;
                const line = part.line + i;
                yield { value: parseJson(text, line - 1), number: ++number, line };
            }
        }
    } else {
        for await (const item of jsonListItems(chunks, shape)) {
            yield { value: parseJson(item.text, item.line - 1), number: ++number, line: null };
        }
    }
    if (number === 0) throw new DatabaseError('The JSON list is empty, so there are no rows to import.', { code: 'BAD_INPUT' });
}

async function previewJson(source, ctx) {
    const progress = createProgress(ctx.onProgress, source);
    const shape = { from: null, lines: false };
    const keys = createKeyList();
    const stats = createColumnStats(0);
    const sample = [];
    let nested = 0;
    let count = 0;
    for await (const item of jsonItems(source, ctx, progress, shape)) {
        keys.add(item.value, item.number, item.line);
        const row = jsonRow(item.value, keys.list);
        nested += row.nested;
        stats.grow(keys.list.length);
        stats.add([row.values]);
        if (sample.length < PREVIEW_ROWS) sample.push(row.values);
        count++;
    }
    progress.finish();
    const columns = uniqueNames(keys.list);
    const described = stats.result();
    return {
        format: 'json',
        delimiter: null,
        header: null,
        tables: null,
        table: null,
        rowCount: count,
        columns: columns.map((name, i) => ({ name, type: described[i].type, nonEmpty: described[i].nonEmpty, fits: described[i].fits })),
        // Keys found after a row was read are missing from it: NULL
        sample: sample.map(values => columns.map((_, i) => display(values[i]))),
        notes: tableNotes('json', { from: shape.from, nested, html: null, described })
    };
}

async function runJson(adapter, source, target, ctx) {
    const progress = createProgress(ctx.onProgress, source, 2);
    // First reading: the columns (every key of every item)
    const keys = createKeyList();
    for await (const item of jsonItems(source, ctx, progress, { from: null, lines: false })) keys.add(item.value, item.number, item.line);
    const prepared = prepareTarget(adapter, uniqueNames(keys.list), target);
    progress.pass(1);
    // Second reading: the rows
    const shape = { from: null, lines: false };
    const result = await inTransaction(adapter, 'json', prepared.tableName, target, async () => {
        const inserter = createInserter(adapter, { setup: prepared.setup, sql: insertSql(prepared.tableName, prepared.columns) },
            (row, line) => (shape.lines ? rowName(row, line) : `Item ${row}`));
        let rows = [];
        let lines = [];
        let first = 1;
        for await (const item of jsonItems(source, ctx, progress, shape)) {
            rows.push(jsonRow(item.value, keys.list).values);
            lines.push(item.line);
            if (rows.length >= BATCH_ROWS) {
                inserter.insert(rows, first, lines);
                first += rows.length;
                rows = [];
                lines = [];
            }
        }
        if (rows.length) inserter.insert(rows, first, lines);
        return inserter.inserted;
    });
    progress.finish();
    return result;
}

// -------------------------------------------------------------- HTML

const cellsWidth = (row) => row.cells.reduce((n, c) => n + c.span, 0);
const isHeader = (row) => row.head || row.cells.every(c => c.header);
const expand = (row) => row.cells.flatMap(c => [c.text === '' ? null : c.text, ...Array(c.span - 1).fill(null)]);

/**
 * Reads every table of a page in parts; `onRow` gets each row of the table
 * numbered `only` (all tables when null). Returns what parseHtmlRows learns
 * about each table: its rows, widths, header and spanned cells.
 */
async function readHtml(source, ctx, progress, only, onRow) {
    /** @type {any[]} */
    const meta = [];
    const reader = createHtmlTableReader((table, row) => {
        const m = (meta[table] ||= { rows: 0, first: null, widths: new Map(), max: 0, spanned: 0 });
        const width = cellsWidth(row);
        if (m.rows === 0) m.first = { header: isHeader(row), width, row };
        m.rows++;
        m.widths.set(width, (m.widths.get(width) || 0) + 1);
        m.max = Math.max(m.max, width);
        for (const c of row.cells) if (c.span > 1) m.spanned++;
        if (only === null || only === table) onRow?.(table, row, m);
    });
    for await (const chunk of textChunks(source, { chunkBytes: ctx.chunkBytes, progress })) reader.push(chunk);
    const tables = reader.end();
    return tables.map((t, index) => ({ index, label: t.label, ...(meta[index] || { rows: 0, first: null, widths: new Map(), max: 0, spanned: 0 }) }));
}

/** Which table to read, and its shape, as parseHtmlRows and readTable decide them. */
function chooseTable(tables, wanted) {
    const usable = tables.filter(t => t.rows > 0);
    if (usable.length === 0) {
        throw new DatabaseError(tables.length ? 'The tables in this HTML have no rows.' : 'There is no <table> in this HTML, so there are no rows to import.', { code: 'BAD_INPUT' });
    }
    const t = usable.find(u => u.index === wanted) || usable[0];
    const header = t.first.header;
    // Body rows narrower than the table are filled with NULL
    let width = header ? t.first.width : 0;
    const bodyWidths = new Map(t.widths);
    if (header) bodyWidths.set(t.first.width, bodyWidths.get(t.first.width) - 1);
    for (const [w, n] of bodyWidths) if (n > 0) width = Math.max(width, w);
    let padded = 0;
    for (const [w, n] of bodyWidths) if (w < width) padded += n;
    const names = header ? expand(t.first.row).map(n => n ?? '') : [];
    while (names.length < width) names.push('');
    const columns = names.map((n, i) => n.replace(/\n/g, ' ') || `column${i + 1}`);
    if (columns.length > MAX_COLUMNS) throw new DatabaseError(`There are ${columns.length} columns; SQLite allows up to ${MAX_COLUMNS}.`, { code: 'BAD_INPUT' });
    if (t.rows - (header ? 1 : 0) === 0) throw new DatabaseError('This table has only a header row, so there are no rows to import.', { code: 'BAD_INPUT' });
    const describe = (u) => {
        const rows = u.rows - (u.first.header ? 1 : 0);
        return `${u.label} (${rows.toLocaleString()} ${rows === 1 ? 'row' : 'rows'}, ${u.max} ${u.max === 1 ? 'column' : 'columns'})`;
    };
    return {
        index: t.index,
        header,
        width,
        padded,
        spanned: t.spanned,
        columns: uniqueNames(columns),
        tables: usable.map(u => ({ index: u.index, label: describe(u) }))
    };
}

/** The body rows of the chosen table, as values filled to its width. */
function bodyRow(row, m, chosen) {
    if (chosen.header && m.rows === 1) return null;
    const values = expand(row);
    while (values.length < chosen.width) values.push(null);
    return values;
}

/**
 * @param {string | Blob} source
 * @param {{ table?: number }} options
 * @param {FileContext} ctx
 */
async function previewHtml(source, { table }, ctx) {
    const progress = createProgress(ctx.onProgress, source, 2);
    const chosen = chooseTable(await readHtml(source, ctx, progress, null, null), table);
    progress.pass(1);
    const stats = createColumnStats(chosen.width);
    const sample = [];
    let count = 0;
    await readHtml(source, ctx, progress, chosen.index, (_t, row, m) => {
        const values = bodyRow(row, m, chosen);
        if (!values) return;
        stats.add([values]);
        if (sample.length < PREVIEW_ROWS) sample.push(values.map(display));
        count++;
    });
    progress.finish();
    const described = stats.result();
    return {
        format: 'html',
        delimiter: null,
        header: chosen.header,
        tables: chosen.tables,
        table: chosen.index,
        rowCount: count,
        columns: chosen.columns.map((name, i) => ({ name, type: described[i].type, nonEmpty: described[i].nonEmpty, fits: described[i].fits })),
        sample,
        notes: tableNotes('html', { from: null, nested: 0, html: { spanned: chosen.spanned, padded: chosen.padded }, described })
    };
}

/**
 * @param {any} adapter
 * @param {string | Blob} source
 * @param {{ table?: number }} options
 * @param {any} target
 * @param {FileContext} ctx
 */
async function runHtml(adapter, source, { table }, target, ctx) {
    const progress = createProgress(ctx.onProgress, source, 2);
    const chosen = chooseTable(await readHtml(source, ctx, progress, null, null), table);
    const prepared = prepareTarget(adapter, chosen.columns, target);
    progress.pass(1);
    const result = await inTransaction(adapter, 'html', prepared.tableName, target, async () => {
        const inserter = createInserter(adapter, { setup: prepared.setup, sql: insertSql(prepared.tableName, prepared.columns) }, rowName);
        let rows = [];
        let lines = [];
        let first = 1;
        const flush = () => {
            inserter.insert(rows, first, lines);
            first += rows.length;
            rows = [];
            lines = [];
        };
        await readHtml(source, ctx, progress, chosen.index, (_t, row, m) => {
            const values = bodyRow(row, m, chosen);
            if (!values) return;
            rows.push(values);
            lines.push(row.line);
            if (rows.length >= BATCH_ROWS) flush();
        });
        if (rows.length) flush();
        return inserter.inserted;
    });
    progress.finish();
    return result;
}
