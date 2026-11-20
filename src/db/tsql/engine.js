// SQL Lab's T-SQL engine. It runs SQL Server scripts on SQLite storage:
// batches split by GO, variables, IF … ELSE, WHILE, BEGIN … END, TRY … CATCH,
// THROW, RAISERROR, PRINT, nested transactions, #temp tables, table
// variables, SELECT … INTO, TRUNCATE, OUTPUT, TOP … PERCENT / WITH TIES and
// @@ROWCOUNT / SCOPE_IDENTITY(). Control flow runs here; every SQL statement
// is translated (dialect-translate.js) and run by SQLite with the variables
// bound as parameters, so values are never pasted into SQL text.
//
// It follows SQL Server's documented behaviour (learn.microsoft.com T-SQL
// reference). It isn't SQL Server and uses none of its code.

import { tokens, translateForSqlite, tsqlCast } from '../dialect-translate.js';
import { adaptSqlServerScript } from '../import-sqlserver.js';
import { toDate } from '../compat-functions.js';
import { parseBatch, sigTokens, splitBatches, TsqlSyntaxError } from './parse.js';
import { dropModule, findModule, listModules, parseModule, parseParams, renameModule, saveModule, splitName, unquote } from './modules.js';
import { createCatalogView, rewriteCatalogNames, runSystemProcedure, SYSTEM_PROCEDURES } from './catalog.js';
import { rewriteApply, rewritePivot, runMerge } from './rewrites.js';
import { parseTrigger } from './shapes.js';

const MAX_RESULTS = 200;
// A runaway WHILE stops here instead of hanging the tab
const MAX_LOOP_STEPS = 1000000;
// SELECT @v = @v + … is worked out one row at a time up to this many rows
const MAX_ROW_ASSIGNMENTS = 10000;
// Procedures, functions and dynamic SQL nest this deep, as in SQL Server
const MAX_NESTING = 32;
const CATALOG_WORDS = /information_schema|\bsys\s*\]?\s*\.|sysobjects/i;

export const TSQL_VERSION = 'SQL Lab T-SQL engine 1.0 (SQLite storage), compatible with Microsoft SQL Server 2022 syntax';

/** An error raised the way SQL Server raises it: number, severity, state. */
export class TsqlError extends Error {
    /**
     * @param {string} message
     * @param {{ number?: number, severity?: number, state?: number, at?: number }} [info]
     */
    constructor(message, { number = 50000, severity = 16, state = 1, at = -1 } = {}) {
        super(message);
        this.number = number;
        this.severity = severity;
        this.state = state;
        this.at = at;
        /** @type {number | undefined} the script line, when it isn't the statement's first */
        this.line = undefined;
        /** @type {string | undefined} the procedure or function it was raised in */
        this.procedure = undefined;
    }
}

class Break { }
class Continue { }
class Return {
    /** @param {unknown} [value] RETURN's value, in a procedure or function */
    constructor(value = null) {
        this.value = value;
    }
}

const INT_LIMITS = /** @type {Record<string, [number, number]>} */ ({
    TINYINT: [0, 255], SMALLINT: [-32768, 32767], INT: [-2147483648, 2147483647], BIGINT: [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]
});
const pad2 = (/** @type {number} */ n) => String(n).padStart(2, '0');
const dateOnly = (/** @type {Date} */ d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
const dateTime = (/** @type {Date} */ d) => `${dateOnly(d)} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;

/**
 * A value converted to a variable's declared type, as SET / DECLARE do.
 * @param {string} type e.g. INT, NVARCHAR(50), DECIMAL(10, 2)
 * @param {unknown} value
 */
export function convertTo(type, value) {
    if (value === null || value === undefined) return null;
    const t = String(type).toUpperCase().replace(/\s+/g, '');
    const name = t.replace(/\(.*$/, '');
    const args = (/\(([^)]*)\)/.exec(t)?.[1] || '').split(',');
    const text = typeof value === 'string' ? value : String(value);
    if (INT_LIMITS[name]) {
        let n;
        if (typeof value === 'number') n = Math.trunc(value);
        else if (typeof value === 'bigint') n = Number(value);
        else if (/^\s*[+-]?\d+\s*$/.test(text)) n = Number(text);
        else throw new TsqlError(`Conversion failed when converting the varchar value '${text}' to data type ${name.toLowerCase()}.`, { number: 245 });
        const [lo, hi] = INT_LIMITS[name];
        if (n < lo || n > hi) throw new TsqlError(`Arithmetic overflow error converting expression to data type ${name.toLowerCase()}.`, { number: 8115 });
        return n;
    }
    if (['DECIMAL', 'NUMERIC', 'MONEY', 'SMALLMONEY', 'FLOAT', 'REAL'].includes(name)) {
        const n = typeof value === 'number' ? value : Number(text.trim());
        if (text.trim() === '' || Number.isNaN(n)) throw new TsqlError(`Error converting data type varchar to ${name.toLowerCase()}.`, { number: 8114 });
        if (name === 'FLOAT' || name === 'REAL') return n;
        const scale = name.endsWith('MONEY') ? 4 : Number(args[1] || 0);
        return Math.round(n * 10 ** scale) / 10 ** scale;
    }
    if (name === 'BIT') {
        if (typeof value === 'number') return value !== 0 ? 1 : 0;
        if (/^\s*true\s*$/i.test(text)) return 1;
        if (/^\s*false\s*$/i.test(text)) return 0;
        const n = Number(text);
        if (text.trim() === '' || Number.isNaN(n)) throw new TsqlError(`Conversion failed when converting the varchar value '${text}' to data type bit.`, { number: 245 });
        return n !== 0 ? 1 : 0;
    }
    if (['CHAR', 'VARCHAR', 'NCHAR', 'NVARCHAR'].includes(name)) {
        // Declared without a length, (N)VARCHAR holds one character
        const n = args[0] === 'MAX' ? 0 : Number(args[0] || 1);
        const chars = [...text];
        if (n && chars.length > n) return chars.slice(0, n).join('');
        if (n && (name === 'CHAR' || name === 'NCHAR')) return text.padEnd(n, ' ');
        return text;
    }
    if (['DATE', 'DATETIME', 'DATETIME2', 'SMALLDATETIME', 'DATETIMEOFFSET', 'TIME'].includes(name)) {
        const d = toDate(value);
        const parts = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text.trim());
        if (!d || Number.isNaN(d.getTime()) || (parts && (d.getUTCMonth() + 1 !== Number(parts[2]) || d.getUTCDate() !== Number(parts[3])))) {
            throw new TsqlError('Conversion failed when converting date and/or time from character string.', { number: 241 });
        }
        if (name === 'DATE') return dateOnly(d);
        if (name === 'TIME') return dateTime(d).slice(11);
        return dateTime(d);
    }
    if (name === 'UNIQUEIDENTIFIER') {
        if (!/^\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*$/i.test(text)) {
            throw new TsqlError('Conversion failed when converting from a character string to uniqueidentifier.', { number: 8169 });
        }
        return text.trim().toUpperCase();
    }
    if (typeof value === 'bigint') return Number(value);
    return value;
}

/** Text as PRINT shows a value. */
const printText = (/** @type {unknown} */ v) => (v === null || v === undefined ? '' : typeof v === 'object' && v && 'blob' in v ? '0x…' : String(v));

/** The SQL Server error number for a SQLite error message. */
function errorNumber(message) {
    const m = String(message);
    if (/UNIQUE constraint failed/i.test(m)) return 2627;
    if (/NOT NULL constraint failed/i.test(m)) return 515;
    if (/FOREIGN KEY constraint failed|CHECK constraint failed/i.test(m)) return 547;
    if (/no such table/i.test(m)) return 208;
    if (/no such column/i.test(m)) return 207;
    if (/syntax error|incomplete input/i.test(m)) return 102;
    if (/already exists/i.test(m)) return 2714;
    if (/Divide by zero/i.test(m)) return 8134;
    if (/Conversion failed/i.test(m)) return 245;
    return 50000;
}

/**
 * Runs a T-SQL script.
 * @param {{ db: any, capi: any, now: () => number, size: number, runText: Function, session: { tranCount: number, savepoints: string[], identity: number | null }, databaseName: string }} ctx
 * @param {string} script
 */
export function runTsql(ctx, script) {
    const { db, capi, now, size, session } = ctx;
    const changesBefore = capi.sqlite3_total_changes(db.pointer);
    /** @type {any[]} */
    const results = [];
    let omitted = 0;
    let statements = 0;
    /** @type {any} */
    let error = null;
    /** @type {Map<string, number>} */
    const changes = new Map();
    /** @type {string[]} the SQL each statement ran as, in order, each once */
    const ran = [];
    const ranSet = new Set();

    /**
     * The text statements are running from: the script, a procedure's or
     * function's definition, or dynamic SQL. Offsets count from its start.
     * @typedef {{ text: string, lineStarts: number[], procedure: string | null }} Source
     * @returns {Source}
     */
    const makeSource = (/** @type {string} */ text, /** @type {string | null} */ procedure) => {
        const lineStarts = [0];
        for (let k = 0; k < text.length; k++) if (text[k] === '\n') lineStarts.push(k + 1);
        return { text, lineStarts, procedure };
    };
    let source = makeSource(script, null);
    // Line and column of an offset in the current source
    const position = (/** @type {number} */ offset) => {
        const { lineStarts } = source;
        let lo = 0;
        let hi = lineStarts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (lineStarts[mid] <= offset) lo = mid;
            else hi = mid - 1;
        }
        return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
    };

    /** @type {Map<string, { name: string, kind: 'scalar' | 'table', type?: string, value?: unknown, table?: string, keep?: boolean }>} */
    let vars = new Map();
    let rowcount = 0;
    let lastError = 0;
    /** @type {{ number: number, message: string, severity: number, state: number, line: number, procedure: string | null } | null} the error a CATCH block is handling */
    let handling = null;
    let loopSteps = 0;
    // Procedures, functions and dynamic SQL running inside each other
    let depth = 0;
    /** @type {number} object id of the running procedure or function (@@PROCID) */
    let moduleId = 0;
    let inFunction = false;
    /** @type {number | null} the script line of the outermost EXEC, which results inside it report */
    let callLine = null;
    /** @type {any[] | null} INSERT … EXEC collects the result sets here instead of showing them */
    let capture = null;
    /** @type {string[]} #temp tables a procedure created, dropped when it ends */
    let scopeTemps = [];
    /** @type {string[]} SQLite tables to drop when the run ends (function results, busy table variables) */
    const dropLater = [];
    /** @type {any} an error raised inside a function SQLite called, which SQLite only passes on as text */
    let udfError = null;
    /** @type {any} the first node of the batch running now (CREATE PROCEDURE must be it) */
    let batchHead = null;
    /** @type {number} where the statement running now starts (for errors in functions it calls) */
    let currentAt = 0;
    let tvfCount = 0;
    /** @type {Map<string, { name: string, query: { text: string, start: number }, scroll: boolean, rows: any[][] | null, columns: string[], pos: number }>} */
    const cursors = new Map();
    let fetchStatus = -1;
    /** @type {Map<string, { table: string, columns: string[], log: string }>} tables whose changes are logged for their triggers */
    const armed = new Map();
    /** @type {Set<string>} tables whose trigger is running now (a trigger doesn't fire itself again) */
    const triggersOff = new Set();
    /** @type {{ op: string }[]} the triggers running, innermost last */
    const triggerStack = [];
    let triggerFunction = false;
    let cursorRows = 0;
    const createdViews = new Set();
    /** @type {Map<number, { def: import('./modules.js').ModuleDef, nodes: any[] }>} definitions read so far */
    const parsedModules = new Map();
    /** @type {Map<string, import('./modules.js').ModuleRow | null>} */
    let moduleCache = new Map();
    /** @type {import('./modules.js').ModuleRow[] | null} */
    let allModules = null;
    const forgetModules = () => {
        moduleCache = new Map();
        allModules = null;
        parsedModules.clear();
    };
    const modules = () => (allModules ||= listModules(db));
    const lookupModule = (/** @type {string} */ written) => {
        const { schema, name } = splitName(written);
        const key = `${schema}.${name}`.toLowerCase();
        if (!moduleCache.has(key)) moduleCache.set(key, findModule(db, `[${schema}].[${name}]`));
        return moduleCache.get(key) || null;
    };

    const tableVariables = () => new Map([...vars.values()].filter(x => x.kind === 'table').map(x => [x.name.toLowerCase(), /** @type {string} */ (x.table)]));

    /** Runs SQLite SQL, passing on an error a function raised inside it. */
    function runText(text, options) {
        udfError = null;
        const out = ctx.runText(text, options);
        if (out.error && udfError) out.error.cause = udfError;
        udfError = null;
        return out;
    }

    /** Translates one statement (or expression wrapped in SELECT) for SQLite. */
    function translate(text) {
        let t = text;
        if (CATALOG_WORDS.test(t)) {
            const list = tokens(t);
            if (rewriteCatalogNames(list, ensureView)) t = list.map(x => x.v).join('');
        }
        if (triggerStack.length && /\bUPDATE\s*\(/i.test(t)) t = updatedTest(t, triggerStack[triggerStack.length - 1].op);
        t = expandModules(t);
        const out = translateForSqlite(t, 'sqlserver', { tableVariables: tableVariables() });
        for (const c of out.changes) changes.set(c.message, (changes.get(c.message) || 0) + c.count);
        return out.sql;
    }

    function ensureView(key) {
        const exists = db.selectValue('SELECT 1 FROM sqlite_temp_schema WHERE type = \'view\' AND name = ?', [`__cat_${key.replace('.', '_')}`]) !== undefined;
        if (exists && createdViews.has(key)) return;
        createCatalogView(db, key, ctx.databaseName);
        createdViews.add(key);
        changes.set('INFORMATION_SCHEMA and sys. views were answered from SQLite\'s catalog.', 1);
    }

    /** How a statement's SQLite failure becomes a T-SQL error. */
    function sqliteFailure(error, at) {
        if (error.cause instanceof TsqlError) return Object.assign(error.cause, { at: error.cause.at >= 0 ? error.cause.at : at });
        const message = String(error.message).replace(/^Error:\s*/, '');
        return new TsqlError(message, { number: errorNumber(message), severity: 16, at });
    }

    /** SQLite SQL run for its rows, bound from the variables or from `bind`. */
    function sqliteRows(sqlText, at, bind) {
        const out = runText(sqlText, { size: 10000000, keep: false, bind: bind ? (/** @type {any} */ stmt) => { if (bind.length) stmt.bind(bind); } : binder(at) });
        if (out.error) throw sqliteFailure(out.error, at);
        return out.results;
    }

    /** What MERGE, APPLY and PIVOT (rewrites.js) run through. */
    /** @type {import('./rewrites.js').Api} */
    const rewriteApi = {
        translate,
        rows(sqlText, at, bind) {
            const r = sqliteRows(sqlText, at, bind);
            const last = r[r.length - 1];
            return { columns: last?.columns || [], rows: last?.rows || [] };
        },
        run(sqlText, at, bind) {
            const r = sqliteRows(sqlText, at, bind);
            return r.reduce((n, x) => n + (x.kind === 'modify' ? x.rowsAffected || 0 : 0), 0);
        },
        setVar(name, value) {
            vars.set(name.toLowerCase(), { name, kind: 'scalar', type: 'SQL_VARIANT', value });
        },
        deleteVar(name) {
            vars.delete(name.toLowerCase());
        },
        temp: (prefix) => `"__${prefix}_${++tvfCount}"`,
        drop: (table) => dropTemp(table),
        dropAtEnd: (table) => dropLater.push(table),
        fail(message, number, at) {
            throw new TsqlError(message, { number, at });
        },
        get perCall() {
            return modules().some(m => m.kind === 'TF');
        }
    };

    /** PIVOT, UNPIVOT and APPLY written as SQL SQLite can run (running what they need to now). */
    function rewriteShapes(text, at) {
        let out = text;
        if (/PIVOT/i.test(out)) out = rewritePivot(rewriteApi, out, at);
        if (/\bAPPLY\b/i.test(out)) out = rewriteApply(rewriteApi, out, at);
        return out;
    }

    function systemValue(name) {
        switch (name) {
        case '@__rowcount': return rowcount;
        case '@__identity': return session.identity;
        case '@__error': return lastError;
        case '@__trancount': return session.tranCount;
        case '@__version': return TSQL_VERSION;
        case '@__servername': case '@__servicename': return 'SQLLAB';
        case '@__spid': return 51;
        case '@__datefirst': return 7;
        case '@__language': return 'us_english';
        case '@__max_precision': return 38;
        case '@__nestlevel': return depth;
        case '@__lock_timeout': return -1;
        case '@__textsize': return 2147483647;
        case '@__options': return 5496;
        case '@__procid': return moduleId;
        case '@__fetch_status': return fetchStatus;
        case '@__cursor_rows': return cursorRows;
        case '@__dbts': return null;
        case '@__microsoftversion': return 268435456;
        case '@__db_name': return ctx.databaseName;
        case '@__xact_state': return session.tranCount > 0 ? 1 : 0;
        case '@__error_message': return handling ? handling.message : null;
        case '@__error_number': return handling ? handling.number : null;
        case '@__error_severity': return handling ? handling.severity : null;
        case '@__error_state': return handling ? handling.state : null;
        case '@__error_line': return handling ? handling.line : null;
        case '@__error_procedure': return handling ? handling.procedure : null;
        default: return undefined;
        }
    }

    /** Binds every parameter of a prepared statement from the variables. */
    function binder(at) {
        return (/** @type {any} */ stmt) => {
            const count = capi.sqlite3_bind_parameter_count(stmt.pointer);
            for (let k = 1; k <= count; k++) {
                const name = capi.sqlite3_bind_parameter_name(stmt.pointer, k);
                if (!name) throw new TsqlError('Parameters written as ? aren\'t supported here: use a variable such as @name.', { number: 137, at });
                const lower = String(name).toLowerCase();
                const sys = lower.startsWith('@__') ? systemValue(lower) : undefined;
                if (sys !== undefined) {
                    stmt.bind(k, sys);
                    continue;
                }
                const v = vars.get(lower);
                if (!v || v.kind !== 'scalar') throw new TsqlError(`Must declare the scalar variable "${name}".`, { number: 137, at });
                stmt.bind(k, v.value === undefined ? null : v.value);
            }
        };
    }

    function record(text) {
        const sqlText = String(text).trim().replace(/;+$/, '');
        if (!ranSet.has(sqlText)) {
            ranSet.add(sqlText);
            ran.push(sqlText);
        }
    }

    function pushResult(entry) {
        if (capture) {
            if (entry.columns?.length) capture.push(entry);
            return;
        }
        if (inFunction && entry.kind !== 'print') {
            if (entry.columns?.length) throw new TsqlError('Select statements included within a function cannot return data to a client.', { number: 444, at: currentAt });
            return;
        }
        // Inside a procedure, results belong to the line that called it
        if (callLine !== null) entry = { ...entry, line: callLine };
        if (results.length >= MAX_RESULTS) {
            results.pop();
            omitted++;
        }
        results.push(entry);
    }

    /**
     * Runs SQLite SQL (already translated) for the statement at `at`.
     * @param {string} sqlText
     * @param {number} at offset of the statement in the script
     * @param {{ keep?: boolean, show?: boolean, original?: string }} [options]
     */
    function runSql(sqlText, at, { keep = false, show = true, original = '' } = {}) {
        record(sqlText);
        currentAt = at;
        const out = runText(sqlText, { size: capture ? 1000000 : size, keep: keep && !capture && depth === 0, bind: binder(at) });
        const where = position(at);
        if (out.error) {
            if (out.error.cause instanceof TsqlError) throw Object.assign(out.error.cause, { at: out.error.cause.at >= 0 ? out.error.cause.at : at });
            // The error's line within the statement, counted from its start
            const before = sqlText.slice(0, Math.max(0, out.error.at));
            const extraLines = (before.match(/\n/g) || []).length;
            const message = String(out.error.message).replace(/^Error:\s*/, '');
            const e = new TsqlError(message, { number: errorNumber(message), severity: 16, at });
            e.line = where.line + extraLines;
            throw e;
        }
        for (const r of out.results) {
            statements++;
            if (r.kind === 'modify') {
                rowcount = r.rowsAffected ?? 0;
                if (/^\s*INSERT\b/i.test(r.sql) && rowcount > 0) session.identity = Number(capi.sqlite3_last_insert_rowid(db.pointer));
            } else rowcount = r.total ?? r.rows.length;
            lastError = 0;
            if (show) {
                const line = where.line + ((sqlText.slice(0, r.at).match(/\n/g) || []).length);
                pushResult({ ...r, sql: original || r.sql, line, statement: statements - 1 });
            }
        }
        return out.results;
    }

    /** The value of an expression (the first column of SELECT expr). */
    function evaluate(expr) {
        currentAt = expr.start;
        const sqlText = translate(`SELECT ${expr.text}`);
        const out = runText(sqlText, { size: 1, keep: false, bind: binder(expr.start) });
        if (out.error) {
            if (out.error.cause instanceof TsqlError) throw Object.assign(out.error.cause, { at: expr.start });
            const message = String(out.error.message);
            throw new TsqlError(message, { number: errorNumber(message), at: expr.start });
        }
        const r = out.results[out.results.length - 1];
        const value = r && r.rows.length ? r.rows[0][0] : null;
        return value && typeof value === 'object' && 'blob' in value ? null : value;
    }

    function condition(expr) {
        return Number(evaluate({ text: `CASE WHEN ${expr.text} THEN 1 ELSE 0 END`, start: expr.start })) === 1;
    }

    function assign(name, value, at) {
        const v = vars.get(name.toLowerCase());
        if (!v || v.kind !== 'scalar') throw new TsqlError(`Must declare the scalar variable "${name}".`, { number: 137, at });
        try {
            v.value = convertTo(/** @type {string} */ (v.type), value);
        } catch (e) {
            if (e instanceof TsqlError) e.at = at;
            throw e;
        }
    }

    function createTable(name, columns, at, temp) {
        const ddl = prepareCreateTable(`CREATE ${temp ? 'TEMP ' : ''}TABLE ${name} (${columns})`);
        runSql(translate(ddl), at, { show: false });
    }

    // ---- statements

    function exec(node) {
        if (++loopSteps > MAX_LOOP_STEPS) throw new TsqlError(`The script ran more than ${MAX_LOOP_STEPS.toLocaleString()} statements, so it was stopped. Check the WHILE loop's condition.`, { at: node.start });
        switch (node.type) {
        case 'declare':
            for (const item of node.items) {
                const key = item.name.toLowerCase();
                if (vars.has(key)) throw new TsqlError(`The variable name '${item.name}' has already been declared. Variable names must be unique within a query batch.`, { number: 134, at: node.start });
                if (item.kind === 'table') {
                    // A procedure's table variables get their own SQLite names, so a caller's @t is left alone
                    let table = `"${(depth ? `${item.name}:${depth}` : item.name).replace(/"/g, '""')}"`;
                    try {
                        db.exec(`DROP TABLE IF EXISTS temp.${table}`);
                    } catch {
                        // still being read (a function's table, while the query calling it runs)
                        table = `"${`${item.name}:${depth}:${++tvfCount}`.replace(/"/g, '""')}"`;
                    }
                    vars.set(key, { name: item.name, kind: 'table', table });
                    createTable(table, item.columns, node.start, true);
                } else {
                    vars.set(key, { name: item.name, kind: 'scalar', type: item.type, value: null });
                    if (item.init) assign(item.name, evaluate(item.init), item.init.start);
                }
            }
            return;
        case 'set': {
            const v = vars.get(node.name.toLowerCase());
            if (!v || v.kind !== 'scalar') throw new TsqlError(`Must declare the scalar variable "${node.name}".`, { number: 137, at: node.start });
            const text = node.op ? `${node.name} ${node.op} (${node.expr.text})` : node.expr.text;
            assign(node.name, evaluate({ text, start: node.expr.start }), node.expr.start);
            rowcount = 1;
            return;
        }
        case 'option': {
            const words = node.text.trim().split(/\s+/).map((/** @type {string} */ w) => w.toUpperCase());
            if (words[0] === 'ROWCOUNT' && words[1] && words[1] !== '0') throw new TsqlError('SET ROWCOUNT isn\'t supported in SQL Lab: use TOP instead.', { at: node.start });
            // SET NOCOUNT, ANSI_NULLS, QUOTED_IDENTIFIER, IDENTITY_INSERT, XACT_ABORT …: nothing to change here
            return;
        }
        case 'if':
            if (condition(node.cond)) exec(node.then);
            else if (node.else) exec(node.else);
            return;
        case 'while':
            while (condition(node.cond)) {
                try {
                    exec(node.body);
                } catch (signal) {
                    if (signal instanceof Break) break;
                    if (signal instanceof Continue) continue;
                    throw signal;
                }
            }
            return;
        case 'block':
            for (const child of node.body) exec(child);
            return;
        case 'try':
            try {
                for (const child of node.body) exec(child);
            } catch (e) {
                if (e instanceof Break || e instanceof Continue || e instanceof Return) throw e;
                const info = errorInfo(e);
                const outer = handling;
                handling = info;
                lastError = info.number;
                try {
                    for (const child of node.handler) exec(child);
                } finally {
                    handling = outer;
                }
            }
            return;
        case 'break': throw new Break();
        case 'continue': throw new Continue();
        case 'return': throw new Return(node.expr ? evaluate(node.expr) : null);
        case 'print': {
            if (inFunction) throw new TsqlError('Invalid use of a side-effecting operator \'PRINT\' within a function.', { number: 443, at: node.start });
            const value = evaluate(node.expr);
            pushResult({ kind: 'print', sql: `PRINT ${node.expr.text}`, text: printText(value), columns: [], rows: [], line: position(node.start).line, statement: statements, durationMs: 0 });
            rowcount = 0;
            return;
        }
        case 'throw': {
            if (!node.args) {
                if (!handling) throw new TsqlError('THROW without parameters should be in a CATCH block.', { number: 10704, at: node.start });
                throw new TsqlError(handling.message, { number: handling.number, severity: handling.severity, state: handling.state, at: node.start });
            }
            const parts = splitArgs(node.args.text);
            if (parts.length !== 3) throw new TsqlError('THROW needs an error number, a message and a state: THROW 50001, \'Message\', 1.', { number: 102, at: node.start });
            const number = Number(evaluate({ text: parts[0], start: node.args.start }));
            if (number < 50000) throw new TsqlError(`Error number ${number} in the THROW statement is outside the valid range. Specify an error number in the valid range of 50000 to 2147483647.`, { number: 35100, at: node.start });
            const message = printText(evaluate({ text: parts[1], start: node.args.start }));
            const state = Number(evaluate({ text: parts[2], start: node.args.start }));
            throw new TsqlError(message, { number, severity: 16, state, at: node.start });
        }
        case 'raiserror': {
            const parts = splitArgs(node.args.text);
            if (parts.length < 3) throw new TsqlError('RAISERROR needs a message, a severity and a state.', { number: 102, at: node.start });
            const values = parts.map(p => evaluate({ text: p, start: node.args.start }));
            const message = formatMessage(printText(values[0]), values.slice(3));
            const severity = Number(values[1]);
            const state = Number(values[2]);
            if (severity <= 10) {
                pushResult({ kind: 'print', sql: `RAISERROR(${node.args.text})`, text: message, columns: [], rows: [], line: position(node.start).line, statement: statements, durationMs: 0 });
                return;
            }
            throw new TsqlError(message, { number: 50000, severity, state, at: node.start });
        }
        case 'tran':
            transaction(node);
            return;
        case 'use': {
            const name = String(node.name).replace(/^\[|\]$/g, '');
            if (name.toLowerCase() === String(ctx.databaseName).toLowerCase() || name.toLowerCase() === 'master' || name.toLowerCase() === 'tempdb') return;
            throw new TsqlError(`Database '${name}' isn't the one open. Open it from SQL Lab's Databases list to run SQL in it.`, { number: 911, at: node.start });
        }
        case 'sql':
            if (armed.size && /^\s*(INSERT|UPDATE|DELETE|MERGE|WITH)\b/i.test(node.text)) runWithTriggers(node);
            else statement(node);
            // A new or changed table may have triggers, or its log may need new columns
            if (/^\s*(CREATE|ALTER|DROP)\s+(TABLE|VIEW)\b/i.test(node.text) && modules().some(m => m.kind === 'TR')) {
                if (/^\s*DROP\s+TABLE\b/i.test(node.text)) dropOrphanTriggers();
                armTriggers();
            }
            return;
        case 'cursor':
        case 'open':
        case 'fetch':
        case 'close':
        case 'deallocate':
            cursorStatement(node);
            return;
        default:
            throw new TsqlError(`Unknown statement ${node.type}.`, { at: node.start });
        }
    }

    function transaction(node) {
        const started = now();
        const show = (/** @type {string} */ sqlText) => {
            statements++;
            pushResult({ kind: 'transaction', sql: sqlText, columns: [], rows: [], more: false, cursor: null, rowsAffected: null, durationMs: Math.max(0, now() - started), line: position(node.start).line, statement: statements - 1 });
        };
        const open = capi.sqlite3_get_autocommit(db.pointer) === 0;
        if (session.tranCount === 0 && open) session.tranCount = 1;
        if (node.action === 'begin') {
            if (session.tranCount === 0) db.exec('BEGIN');
            session.tranCount++;
            show('BEGIN TRANSACTION');
        } else if (node.action === 'commit') {
            if (session.tranCount === 0) throw new TsqlError('The COMMIT TRANSACTION request has no corresponding BEGIN TRANSACTION.', { number: 3902, at: node.start });
            session.tranCount--;
            if (session.tranCount === 0) {
                db.exec('COMMIT');
                session.savepoints = [];
            }
            show('COMMIT TRANSACTION');
        } else if (node.action === 'rollback') {
            const name = String(node.name || '').replace(/^\[|\]$/g, '');
            if (name && session.savepoints.some(s => s.toLowerCase() === name.toLowerCase())) {
                db.exec(`ROLLBACK TO "${name.replace(/"/g, '""')}"`);
                show(`ROLLBACK TO ${name}`);
                return;
            }
            if (session.tranCount === 0) throw new TsqlError('The ROLLBACK TRANSACTION request has no corresponding BEGIN TRANSACTION.', { number: 3903, at: node.start });
            db.exec('ROLLBACK');
            session.tranCount = 0;
            session.savepoints = [];
            // The rollback can take the trigger logging made inside the transaction with it
            if (armed.size && !triggerStack.length) armTriggers();
            show('ROLLBACK TRANSACTION');
        } else if (node.action === 'save') {
            if (session.tranCount === 0) throw new TsqlError('Cannot use SAVE TRANSACTION within a distributed transaction or outside a transaction.', { number: 628, at: node.start });
            const name = String(node.name || '').replace(/^\[|\]$/g, '');
            if (!name) throw new TsqlError('SAVE TRANSACTION needs a savepoint name.', { number: 102, at: node.start });
            db.exec(`SAVEPOINT "${name.replace(/"/g, '""')}"`);
            session.savepoints.push(name);
            show(`SAVE TRANSACTION ${name}`);
        }
    }

    function errorInfo(e) {
        const at = e && typeof e.at === 'number' && e.at >= 0 ? e.at : 0;
        const procedure = (e && e.procedure) || source.procedure || null;
        if (e instanceof TsqlError) return { number: e.number, message: e.message, severity: e.severity, state: e.state, line: e.line || position(at).line, procedure };
        if (e instanceof TsqlSyntaxError) return { number: 102, message: e.message, severity: 15, state: 1, line: position(e.offset).line, procedure };
        const message = e instanceof Error ? e.message : String(e);
        return { number: errorNumber(message), message, severity: 16, state: 1, line: position(at).line, procedure };
    }

    // ---- SQL statements

    function statement(written) {
        let node = written;
        let sig = sigTokens(node.text);
        const head = sig[0]?.u || '';
        const object = sig[1]?.u === 'OR' ? sig[3]?.u : sig[1]?.u;
        if (head === 'CREATE' || head === 'ALTER') {
            if (object === 'TRIGGER') {
                defineTrigger(node);
                return;
            }
            if (['PROCEDURE', 'PROC', 'FUNCTION'].includes(object || '')) {
                defineModule(node);
                return;
            }
        }
        if (head === 'DROP' && ['PROCEDURE', 'PROC', 'FUNCTION', 'TRIGGER'].includes(sig[1]?.u)) {
            dropModules(node, sig);
            return;
        }
        if (inFunction) checkSideEffects(node, sig);
        if (head === 'EXEC' || head === 'EXECUTE') {
            runExec(node);
            return;
        }
        if (head === 'INSERT') {
            const execAt = findWord(sig, 1, 'EXEC') >= 0 ? findWord(sig, 1, 'EXEC') : findWord(sig, 1, 'EXECUTE');
            if (execAt > 0) {
                insertExec(node, sig, execAt);
                return;
            }
        }
        // A procedure's #temp tables are dropped when it ends
        if (depth > 0 && !inFunction) {
            const temp = tempTableCreated(sig);
            if (temp) scopeTemps.push(temp);
        }
        if (head === 'MERGE') {
            mergeStatement(node);
            return;
        }
        if (['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE'].includes(head) && /\b(APPLY|PIVOT|UNPIVOT)\b/i.test(node.text)) {
            const text = rewriteShapes(node.text, node.start);
            if (text !== node.text) {
                node = { ...node, text, shown: node.text };
                sig = sigTokens(text);
            }
        }
        if (head === 'TRUNCATE' && sig[1]?.u === 'TABLE') {
            const name = node.text.slice(sig[2].start, sig[sig.length - 1].end).replace(/;$/, '').trim();
            const target = translate(`DELETE FROM ${name}`);
            // TRUNCATE doesn't fire DELETE triggers
            const bare = splitName(name).name.toLowerCase();
            triggersOff.add(bare);
            try {
                runSql(target, node.start, { original: node.text.trim() });
            } finally {
                triggersOff.delete(bare);
            }
            // TRUNCATE starts IDENTITY numbering again
            const plain = name.split('.').pop()?.replace(/^\[|\]$/g, '').replace(/^"|"$/g, '') || '';
            try {
                db.exec({ sql: 'DELETE FROM sqlite_sequence WHERE name = ?', bind: [plain] });
            } catch {
                // no AUTOINCREMENT table yet
            }
            return;
        }
        if (head === 'CREATE' && (object === 'TABLE' || object === 'INDEX' || object === 'UNIQUE' || object === 'CLUSTERED' || object === 'NONCLUSTERED')) {
            const text = object === 'TABLE' ? prepareCreateTable(node.text) : adaptSqlServerScript(node.text).text;
            const seed = identitySeed(node.text);
            runSql(translate(text), node.start, { original: (node.shown || node.text).trim() });
            if (seed) setSeed(seed.table, seed.seed);
            return;
        }
        const assignment = selectAssignments(node.text, sig);
        if (assignment) {
            assignFromSelect(assignment, node);
            return;
        }
        const into = selectInto(node.text, sig);
        if (into) {
            const temp = into.target.startsWith('#') || into.target.startsWith('[#');
            const sqlText = translate(`CREATE ${temp ? 'TEMP ' : ''}TABLE ${into.target} AS ${into.query}`);
            runSql(sqlText, node.start, { show: false });
            const count = Number(db.selectValue(`SELECT COUNT(*) FROM ${translate(into.target)}`));
            statements++;
            rowcount = count;
            pushResult({ kind: 'modify', sql: (node.shown || node.text).trim(), columns: [], rows: [], more: false, cursor: null, rowsAffected: count, durationMs: 0, line: position(node.start).line, statement: statements - 1 });
            return;
        }
        const output = outputClause(node.text, sig);
        if (output) {
            const results2 = runSql(translate(output.sql), node.start, { original: (node.shown || node.text).trim(), show: !output.into });
            if (output.into) {
                const rows = results2.flatMap(r => r.rows);
                const target = translate(output.into);
                for (const row of rows) {
                    db.exec({ sql: `INSERT INTO ${target}${output.columns ? ` (${output.columns})` : ''} VALUES (${row.map(() => '?').join(', ')})`, bind: row });
                }
                const r = results2[results2.length - 1];
                pushResult({ ...r, columns: [], rows: [], sql: (node.shown || node.text).trim(), line: position(node.start).line, statement: statements - 1 });
            }
            return;
        }
        const top = topClause(node.text, sig);
        if (top) {
            runTop(top, node);
            return;
        }
        runSql(translate(node.text), node.start, { keep: true, original: (node.shown || node.text).trim() });
    }

    // ---- triggers
    //
    // SQLite runs a row at a time and can't run T-SQL, so each table with
    // triggers gets temp SQLite triggers that log its changed rows. After a
    // statement, the logged rows become the inserted and deleted tables and
    // the T-SQL triggers run, once per statement, as in SQL Server. INSTEAD OF
    // on a table is a BEFORE trigger that logs the row and skips the change.

    const TRIGGER_EVENTS = ['INSERT', 'UPDATE', 'DELETE'];
    const sq = (/** @type {string} */ name) => `"${String(name).replace(/"/g, '""')}"`;
    const triggerInfo = (/** @type {any} */ mod) => /** @type {{ table: string, events: string[], instead: boolean }} */ (/** @type {unknown} */ (mod.params));

    /** Sets up the logging for every table that has triggers (again, after a change). */
    function armTriggers() {
        disarmTriggers();
        const list = modules().filter(m => m.kind === 'TR');
        if (!list.length) return;
        if (!triggerFunction) {
            db.createFunction({ name: 'sqllab_trg_on', arity: 1, deterministic: false, xFunc: (/** @type {any} */ _c, /** @type {unknown} */ t) => (triggersOff.has(String(t).toLowerCase()) ? 0 : 1) });
            triggerFunction = true;
        }
        /** @type {Map<string, { table: string, events: string[], instead: boolean }[]>} */
        const tables = new Map();
        for (const m of list) {
            const info = triggerInfo(m);
            const key = String(info.table).toLowerCase();
            if (!tables.has(key)) tables.set(key, []);
            tables.get(key)?.push(info);
        }
        for (const [key, infos] of tables) {
            const obj = db.selectObject('SELECT name, type FROM main.sqlite_schema WHERE type IN (\'table\', \'view\') AND name = ? COLLATE NOCASE', [key]);
            if (!obj) continue;
            const name = String(obj.name);
            const columns = db.selectValues('SELECT name FROM pragma_table_info(?, \'main\')', [name]).map(String);
            const log = sq(`__trg_${name}`);
            db.exec(`DROP TABLE IF EXISTS temp.${log}`);
            db.exec(`CREATE TEMP TABLE ${log} (__seq INTEGER PRIMARY KEY, __op TEXT, __side TEXT${columns.map(c => `, ${sq(c)}`).join('')})`);
            const into = `INSERT INTO temp.${log} (__op, __side${columns.map(c => `, ${sq(c)}`).join('')})`;
            const row = (/** @type {string} */ op, /** @type {string} */ side, /** @type {string} */ ref) => `${into} VALUES ('${op}', '${side}'${columns.map(c => `, ${ref}.${sq(c)}`).join('')});`;
            for (const event of TRIGGER_EVENTS) {
                const on = infos.filter(i => i.events.includes(event));
                if (!on.length) continue;
                const instead = on.some(i => i.instead);
                const timing = obj.type === 'view' ? 'INSTEAD OF' : instead ? 'BEFORE' : 'AFTER';
                let body = event === 'INSERT' ? row(event, 'i', 'NEW') : event === 'DELETE' ? row(event, 'd', 'OLD') : `${row(event, 'd', 'OLD')} ${row(event, 'i', 'NEW')}`;
                if (instead && obj.type === 'table') body += ' SELECT RAISE(IGNORE);';
                db.exec(`CREATE TEMP TRIGGER ${sq(`__trg_${name}_${event}`)} ${timing} ${event} ON main.${sq(name)} WHEN sqllab_trg_on('${name.replace(/'/g, '\'\'')}') = 1 BEGIN ${body} END`);
            }
            armed.set(key, { table: name, columns, log });
        }
    }

    function disarmTriggers() {
        for (const a of armed.values()) {
            for (const event of TRIGGER_EVENTS) db.exec(`DROP TRIGGER IF EXISTS temp.${sq(`__trg_${a.table}_${event}`)}`);
            db.exec(`DROP TABLE IF EXISTS temp.${a.log}`);
        }
        armed.clear();
    }

    /** A table's triggers go with it, as in SQL Server. */
    function dropOrphanTriggers() {
        for (const m of modules().filter(x => x.kind === 'TR')) {
            const exists = db.selectValue('SELECT 1 FROM main.sqlite_schema WHERE type IN (\'table\', \'view\') AND name = ? COLLATE NOCASE', [triggerInfo(m).table]);
            if (!exists) dropModule(db, m.id);
        }
        forgetModules();
    }

    /** CREATE / ALTER / CREATE OR ALTER TRIGGER name ON table {AFTER | FOR | INSTEAD OF} events AS … */
    function defineTrigger(node) {
        const started = now();
        const sig = sigTokens(node.text);
        if (depth === 0 && batchHead && node !== batchHead) {
            const what = sig[0].u === 'ALTER' ? 'ALTER TRIGGER' : sig[1]?.u === 'OR' ? 'CREATE OR ALTER TRIGGER' : 'CREATE TRIGGER';
            throw new TsqlError(`'${what}' must be the first statement in a query batch. Put GO before it.`, { number: 111, at: node.start });
        }
        const def = parseTrigger(node.text, node.start);
        parseBatch(def.body, node.start + def.bodyStart);
        const obj = db.selectObject('SELECT name, type FROM main.sqlite_schema WHERE type IN (\'table\', \'view\') AND name = ? COLLATE NOCASE', [def.table]);
        if (!obj || (obj.type === 'view' && !def.instead)) throw new TsqlError(`The object '${def.table}' does not exist or is invalid for this operation.`, { number: 8197, at: node.start });
        const existing = lookupModule(`[${def.schema}].[${def.name}]`);
        if (def.action === 'create' && existing) throw new TsqlError(`There is already an object named '${def.name}' in the database.`, { number: 2714, at: node.start });
        if (def.action === 'alter' && !existing) throw new TsqlError(`Invalid object name '${def.name}'.`, { number: 208, at: node.start });
        if (existing && existing.kind !== 'TR') throw new TsqlError(`Cannot perform alter on '${def.name}' because it is an incompatible object type.`, { number: 2010, at: node.start });
        if (def.instead) {
            for (const m of modules()) {
                if (m.kind !== 'TR' || (existing && m.id === existing.id)) continue;
                const info = triggerInfo(m);
                const clash = info.instead && String(info.table).toLowerCase() === String(obj.name).toLowerCase() && info.events.find(e => def.events.includes(e));
                if (clash) throw new TsqlError(`Cannot CREATE trigger '${def.name}' on table '${obj.name}' because an INSTEAD OF ${clash} trigger already exists on this object.`, { number: 2111, at: node.start });
            }
        }
        const info = { table: String(obj.name), events: def.events, instead: def.instead };
        saveModule(db, /** @type {any} */ ({ kind: 'TR', schema: def.schema, name: def.name, params: info, returns: null }), node.text.trim().replace(/;\s*$/, ''), nowText());
        forgetModules();
        armTriggers();
        statements++;
        pushResult({ kind: 'other', sql: node.text.trim(), columns: [], rows: [], more: false, cursor: null, rowsAffected: null, durationMs: Math.max(0, now() - started), line: position(node.start).line, statement: statements - 1, note: `The trigger ${def.schema}.${def.name} was ${existing ? 'altered' : 'created'}.` });
        rowcount = 0;
    }

    /** UPDATE(Column) inside a trigger: whether the statement changed that column. */
    function updatedTest(text, op) {
        return text.replace(/\bUPDATE\s*\(\s*(\[[^\]]+\]|"[^"]+"|[A-Za-z_][\w$#]*)\s*\)/gi, (/** @type {string} */ _m, /** @type {string} */ col) => {
            if (op === 'INSERT') return '(1 = 1)';
            if (op === 'DELETE') return '(1 = 0)';
            // SQL Server tests the SET list; SQL Lab tests whether any row's value changed
            return `EXISTS (SELECT 1 FROM inserted AS __ui JOIN deleted AS __ud ON __ui.rowid = __ud.rowid WHERE __ui.${col} IS NOT __ud.${col})`;
        });
    }

    /** A data change on a table with triggers: the change, then its triggers, all undone if one fails. */
    function runWithTriggers(node) {
        const point = sq(`__trg_sp_${++tvfCount}`);
        const wasAuto = capi.sqlite3_get_autocommit(db.pointer) !== 0;
        const count = session.tranCount;
        db.exec(`SAVEPOINT ${point}`);
        try {
            statement(node);
            fireTriggers(node.start);
        } catch (e) {
            if (capi.sqlite3_get_autocommit(db.pointer) === 0) {
                try {
                    db.exec(`ROLLBACK TO ${point}`);
                    db.exec(`RELEASE ${point}`);
                } catch {
                    // a ROLLBACK in the trigger ended the transaction
                }
            }
            if (wasAuto) session.tranCount = count;
            throw e;
        }
        if (capi.sqlite3_get_autocommit(db.pointer) !== 0) {
            // ROLLBACK TRANSACTION inside the trigger undid the change and everything before it
            session.tranCount = 0;
            session.savepoints = [];
            if (!triggerStack.length) armTriggers();
            throw new TsqlError('The transaction ended in the trigger. The batch has been aborted.', { number: 3609, severity: 16, at: node.start });
        }
        db.exec(`RELEASE ${point}`);
        if (wasAuto) session.tranCount = count;
    }

    /** Runs the triggers of every table whose log has rows, with those rows as inserted and deleted. */
    function fireTriggers(at) {
        for (const a of armed.values()) {
            const key = a.table.toLowerCase();
            if (triggersOff.has(key)) continue;
            const ops = db.selectValues(`SELECT __op FROM temp.${a.log} GROUP BY __op ORDER BY MIN(__seq)`).map(String);
            if (!ops.length) continue;
            const cols = a.columns.map(sq).join(', ');
            const snapshot = (/** @type {string} */ op, /** @type {string} */ side) => {
                const t = sq(`__trgrows_${++tvfCount}`);
                db.exec(`CREATE TEMP TABLE ${t} AS SELECT ${cols} FROM temp.${a.log} WHERE __op = '${op}' AND __side = '${side}' ORDER BY __seq`);
                return t;
            };
            const sets = ops.map(op => ({ op, inserted: snapshot(op, 'i'), deleted: snapshot(op, 'd') }));
            db.exec(`DELETE FROM temp.${a.log}`);
            for (const set of sets) {
                try {
                    const list = modules().filter(m => m.kind === 'TR' && String(triggerInfo(m).table).toLowerCase() === key && triggerInfo(m).events.includes(set.op)).sort((x, y) => x.id - y.id);
                    const instead = list.filter(m => triggerInfo(m).instead);
                    for (const mod of instead.length ? instead : list) runTrigger(mod, key, set, at);
                } finally {
                    dropTemp(set.inserted);
                    dropTemp(set.deleted);
                }
            }
        }
    }

    /** One trigger's statements, with its inserted and deleted tables named so. */
    function runTrigger(mod, table, set, at) {
        let p = parsedModules.get(mod.id);
        if (!p) {
            const def = parseTrigger(mod.definition, 0);
            p = { def: /** @type {any} */ (def), nodes: parseBatch(def.body, def.bodyStart) };
            parsedModules.set(mod.id, p);
        }
        // A trigger inside a trigger: the outer one's inserted and deleted wait under other names
        const level = triggerStack.length;
        if (level) {
            db.exec(`ALTER TABLE temp.inserted RENAME TO ${sq(`inserted:${level}`)}`);
            db.exec(`ALTER TABLE temp.deleted RENAME TO ${sq(`deleted:${level}`)}`);
        }
        // Each trigger gets its own copy: one may change its inserted table before the next runs
        db.exec(`CREATE TEMP TABLE inserted AS SELECT * FROM temp.${set.inserted} ORDER BY rowid`);
        db.exec(`CREATE TEMP TABLE deleted AS SELECT * FROM temp.${set.deleted} ORDER BY rowid`);
        triggerStack.push({ op: set.op });
        triggersOff.add(table);
        const savedRowcount = rowcount;
        try {
            runScope({ nodes: p.nodes, src: moduleSource(mod), scope: new Map(), id: mod.id, at });
        } finally {
            triggersOff.delete(table);
            triggerStack.pop();
            rowcount = savedRowcount;
            dropTemp('inserted');
            dropTemp('deleted');
            if (level && capi.sqlite3_get_autocommit(db.pointer) === 0) {
                db.exec(`ALTER TABLE temp.${sq(`inserted:${level}`)} RENAME TO inserted`);
                db.exec(`ALTER TABLE temp.${sq(`deleted:${level}`)} RENAME TO deleted`);
            }
        }
    }

    /** MERGE … USING … ON … WHEN …: runs in rewrites.js; the rows it changed, or what OUTPUT returned. */
    function mergeStatement(node) {
        const started = now();
        currentAt = node.start;
        record(node.text.trim());
        const r = runMerge(rewriteApi, node.text, node.start);
        statements++;
        rowcount = r.affected;
        lastError = 0;
        if (r.inserted) session.identity = Number(capi.sqlite3_last_insert_rowid(db.pointer));
        const base = { sql: node.text.trim(), more: false, cursor: null, durationMs: Math.max(0, now() - started), line: position(node.start).line, statement: statements - 1 };
        if (r.output && r.into) {
            const target = translate(`SELECT * FROM ${r.into}`).replace(/^\s*SELECT\s+\*\s+FROM\s+/i, '');
            const columns = r.intoColumns ? ` (${r.intoColumns.split(',').map(c => `"${unquote(c.trim()).replace(/"/g, '""')}"`).join(', ')})` : '';
            for (const row of r.output.rows) rewriteApi.run(`INSERT INTO ${target}${columns} VALUES (${row.map(() => '?').join(', ')})`, node.start, row);
        }
        if (r.output && !r.into) pushResult({ ...base, kind: 'query', columns: r.output.columns, rows: r.output.rows.slice(0, 1000), more: r.output.rows.length > 1000, rowsAffected: r.affected });
        else pushResult({ ...base, kind: 'modify', columns: [], rows: [], rowsAffected: r.affected });
    }

    /** DECLARE c CURSOR FOR …, OPEN, FETCH, CLOSE, DEALLOCATE. A cursor reads its rows when it opens (as a STATIC cursor does). */
    function cursorStatement(node) {
        const key = node.name.toLowerCase();
        const cursor = cursors.get(key);
        if (node.type === 'cursor') {
            if (cursor) throw new TsqlError(`A cursor with the name '${node.name}' already exists.`, { number: 16915, at: node.start });
            cursors.set(key, { name: node.name, query: node.query, scroll: node.scroll, rows: null, columns: [], pos: -1 });
            return;
        }
        if (!cursor) throw new TsqlError(`A cursor with the name '${node.name}' does not exist.`, { number: 16916, at: node.start });
        if (node.type === 'deallocate') {
            cursors.delete(key);
            return;
        }
        if (node.type === 'open') {
            if (cursor.rows) throw new TsqlError('The cursor is already open.', { number: 16905, at: node.start });
            currentAt = node.start;
            const text = rewriteShapes(cursor.query.text, cursor.query.start);
            const out = rewriteApi.rows(translate(text), cursor.query.start);
            cursor.rows = out.rows;
            cursor.columns = out.columns;
            cursor.pos = -1;
            cursorRows = out.rows.length;
            return;
        }
        if (!cursor.rows) throw new TsqlError('Cursor is not open.', { number: 16917, at: node.start });
        if (node.type === 'close') {
            cursor.rows = null;
            return;
        }
        // FETCH
        const { rows } = cursor;
        const orientation = node.orientation;
        if (orientation !== 'NEXT' && !cursor.scroll) throw new TsqlError(`fetch: The fetch type ${orientation} cannot be used with forward only cursors.`, { number: 16911, at: node.start });
        const n = node.offset ? Math.trunc(Number(evaluate(node.offset))) : 0;
        let pos = cursor.pos;
        if (orientation === 'NEXT') pos = Math.min(pos + 1, rows.length);
        else if (orientation === 'PRIOR') pos = Math.max(pos - 1, -1);
        else if (orientation === 'FIRST') pos = rows.length ? 0 : -1;
        else if (orientation === 'LAST') pos = rows.length - 1;
        else if (orientation === 'ABSOLUTE') pos = n > 0 ? Math.min(n - 1, rows.length) : n < 0 ? Math.max(rows.length + n, -1) : -1;
        else if (orientation === 'RELATIVE') pos = Math.max(-1, Math.min(pos + n, rows.length));
        cursor.pos = pos;
        const row = pos >= 0 && pos < rows.length ? rows[pos] : null;
        fetchStatus = row ? 0 : -1;
        rowcount = row ? 1 : 0;
        if (node.into.length) {
            if (node.into.length !== cursor.columns.length) throw new TsqlError('Cursorfetch: The number of variables declared in the INTO list must match that of selected columns.', { number: 16924, at: node.start });
            if (row) node.into.forEach((/** @type {string} */ name, /** @type {number} */ k) => assign(name, row[k], node.start));
            return;
        }
        statements++;
        pushResult({ kind: 'query', sql: node.text || `FETCH ${orientation} FROM ${cursor.name}`, columns: cursor.columns, rows: row ? [row] : [], more: false, cursor: null, rowsAffected: null, durationMs: 0, line: position(node.start).line, statement: statements - 1 });
    }

    /** SELECT @a = x, @b = y FROM …: the query, with the assignments. */
    function assignFromSelect(assignment, node) {
        const selfReferencing = assignment.items.some(item => new RegExp(`(^|[^\\w@])${item.name.replace(/[$]/g, '\\$')}(?![\\w@$#])`, 'i').test(item.expr) || item.op);
        const exprs = assignment.items.map(item => (item.op ? `${item.name} ${item.op} (${item.expr})` : item.expr));
        const query = `SELECT ${exprs.join(', ')} ${assignment.rest}`;
        if (!selfReferencing) {
            const out = runText(translate(query), { size: 1000000, keep: false, bind: binder(node.start) });
            if (out.error) {
                if (out.error.cause instanceof TsqlError) throw Object.assign(out.error.cause, { at: node.start });
                throw new TsqlError(String(out.error.message), { number: errorNumber(out.error.message), at: node.start });
            }
            statements++;
            const rows = out.results[out.results.length - 1]?.rows || [];
            // The last row's values are kept; with no rows the variables keep their values
            if (rows.length) assignment.items.forEach((item, k) => assign(item.name, rows[rows.length - 1][k], node.start));
            rowcount = rows.length;
            record(translate(query));
            return;
        }
        // @s = @s + Name: each row sees the value the row before left
        const count = Number(evaluate({ text: `(SELECT COUNT(*) FROM (SELECT 1 AS x ${assignment.rest}))`, start: node.start }));
        if (count > MAX_ROW_ASSIGNMENTS) throw new TsqlError(`SELECT @variable = … over more than ${MAX_ROW_ASSIGNMENTS.toLocaleString()} rows isn't supported in SQL Lab. Use STRING_AGG to join values.`, { at: node.start });
        const rowQuery = translate(`${query} LIMIT 1 OFFSET @__row`);
        for (let k = 0; k < count; k++) {
            vars.set('@__row', { name: '@__row', kind: 'scalar', type: 'INT', value: k });
            const out = runText(rowQuery, { size: 1, keep: false, bind: binder(node.start) });
            if (out.error) throw new TsqlError(String(out.error.message), { number: errorNumber(out.error.message), at: node.start });
            const row = out.results[out.results.length - 1]?.rows?.[0];
            if (row) assignment.items.forEach((item, j) => assign(item.name, row[j], node.start));
        }
        vars.delete('@__row');
        statements++;
        rowcount = count;
        record(rowQuery);
    }

    /** TOP n PERCENT and TOP n WITH TIES: run without TOP, then keep the rows SQL Server would. */
    function runTop(top, node) {
        const n = Number(evaluate({ text: top.value, start: node.start }));
        const base = translate(top.query);
        const started = now();
        const out = runText(base, { size: 1000000, keep: false, bind: binder(node.start) });
        if (out.error) throw new TsqlError(String(out.error.message), { number: errorNumber(out.error.message), at: node.start });
        record(base);
        const r = out.results[out.results.length - 1];
        let rows = r.rows;
        let columns = r.columns;
        if (top.percent) rows = rows.slice(0, Math.ceil((rows.length * Math.max(0, Math.min(100, n))) / 100));
        else {
            const keys = top.keys;
            const take = Math.max(0, Math.trunc(n));
            if (rows.length > take && take > 0) {
                const last = rows[take - 1];
                let end = take;
                while (end < rows.length && keys.every(k => rows[end][k] === last[k])) end++;
                rows = rows.slice(0, end);
            } else rows = rows.slice(0, take);
            if (top.hidden) {
                columns = columns.slice(0, columns.length - top.hidden);
                rows = rows.map((/** @type {any[]} */ row) => row.slice(0, row.length - top.hidden));
            }
        }
        statements++;
        rowcount = rows.length;
        pushResult({ ...r, columns, rows: rows.slice(0, 1000), more: rows.length > 1000, cursor: null, sql: (node.shown || node.text).trim(), durationMs: Math.max(0, now() - started), line: position(node.start).line, statement: statements - 1 });
    }

    function setSeed(table, seed) {
        try {
            const name = String(table).replace(/^\[|\]$/g, '').replace(/^"|"$/g, '').split('.').pop();
            db.exec({ sql: 'DELETE FROM sqlite_sequence WHERE name = ?', bind: [name] });
            db.exec({ sql: 'INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)', bind: [name, seed - 1] });
        } catch {
            // the table doesn't use AUTOINCREMENT
        }
    }

    // ---- procedures, functions and dynamic SQL

    const nowText = () => new Date().toISOString().replace('T', ' ').slice(0, 23);

    /** A definition read once per run: its parsed header and statements. */
    function parsedModule(mod) {
        let p = parsedModules.get(mod.id);
        if (!p) {
            const def = parseModule(mod.definition, 0);
            const nodes = def.kind === 'IF' ? [] : parseBatch(def.body, def.bodyStart);
            p = { def, nodes };
            parsedModules.set(mod.id, p);
        }
        return p;
    }

    /** CREATE / ALTER / CREATE OR ALTER PROCEDURE or FUNCTION. */
    function defineModule(node) {
        const started = now();
        if (depth === 0 && batchHead && node !== batchHead) {
            const sig = sigTokens(node.text);
            const what = `${sig[0].u === 'ALTER' ? 'ALTER' : sig[1]?.u === 'OR' ? 'CREATE OR ALTER' : 'CREATE'} ${['FUNCTION'].includes(sig[sig[1]?.u === 'OR' ? 3 : 1]?.u) ? 'FUNCTION' : 'PROCEDURE'}`;
            throw new TsqlError(`'${what}' must be the first statement in a query batch. Put GO before it.`, { number: 111, at: node.start });
        }
        const def = parseModule(node.text, node.start);
        const label = def.kind === 'P' ? 'procedure' : 'function';
        if (def.kind !== 'IF') {
            // Read the statements now, so mistakes show at CREATE, as in SQL Server
            const nodes = parseBatch(def.body, node.start + def.bodyStart);
            if (def.kind !== 'P') {
                const block = nodes.length === 1 && nodes[0].type === 'block' ? nodes[0] : null;
                const last = block ? block.body[block.body.length - 1] : null;
                if (!block || !last || last.type !== 'return' || (def.kind === 'FN') !== !!last.expr) {
                    throw new TsqlError(def.kind === 'FN'
                        ? 'The last statement included within a function must be a return statement: RETURN followed by the value.'
                        : 'The last statement of a table-valued function must be RETURN, with no value.', { number: 455, at: node.start });
                }
                // Functions can't change data or print, as in SQL Server
                const visit = (/** @type {any[]} */ list) => {
                    for (const n of list) {
                        if (n.type === 'sql') checkSideEffects(n, sigTokens(n.text));
                        else if (n.type === 'print') throw new TsqlError('Invalid use of a side-effecting operator \'PRINT\' within a function.', { number: 443, at: n.start });
                        else if (n.type === 'tran') throw new TsqlError(`Invalid use of a side-effecting operator '${n.action.toUpperCase()} TRANSACTION' within a function.`, { number: 443, at: n.start });
                        for (const child of [n.then, n.else].filter(Boolean)) visit([child]);
                        for (const key of ['body', 'handler']) if (Array.isArray(n[key])) visit(n[key]);
                        if (n.body && !Array.isArray(n.body)) visit([n.body]);
                    }
                };
                visit(nodes);
            }
        }
        const existing = lookupModule(`[${def.schema}].[${def.name}]`);
        const clash = db.selectValue('SELECT type FROM sqlite_schema WHERE type IN (\'table\', \'view\', \'trigger\') AND name = ? COLLATE NOCASE', [def.name]);
        if (def.action === 'create' && (existing || (clash && def.schema.toLowerCase() === 'dbo'))) {
            throw new TsqlError(`There is already an object named '${def.name}' in the database.`, { number: 2714, at: node.start });
        }
        if (def.action === 'alter' && !existing) throw new TsqlError(`Invalid object name '${def.name}'.`, { number: 208, at: node.start });
        if (existing && (existing.kind === 'P') !== (def.kind === 'P')) {
            throw new TsqlError(`Cannot perform alter on '${def.name}' because it is an incompatible object type.`, { number: 2010, at: node.start });
        }
        const row = saveModule(db, def, node.text.trim().replace(/;\s*$/, ''), nowText());
        forgetModules();
        if (row.kind === 'FN') registerFunction(row);
        statements++;
        const verb = existing ? 'altered' : 'created';
        pushResult({ kind: 'other', sql: node.text.trim(), columns: [], rows: [], more: false, cursor: null, rowsAffected: null, durationMs: Math.max(0, now() - started), line: position(node.start).line, statement: statements - 1, note: `The ${label} ${def.schema}.${def.name} was ${verb}.` });
        rowcount = 0;
    }

    /** DROP PROCEDURE / FUNCTION [IF EXISTS] a, b */
    function dropModules(node, sig) {
        const what = sig[1].u === 'FUNCTION' ? 'function' : sig[1].u === 'TRIGGER' ? 'trigger' : 'procedure';
        const fits = (/** @type {string} */ kind) => (what === 'procedure' ? kind === 'P' : what === 'trigger' ? kind === 'TR' : ['FN', 'IF', 'TF'].includes(kind));
        let k = 2;
        const ifExists = sig[2]?.u === 'IF' && sig[3]?.u === 'EXISTS';
        if (ifExists) k = 4;
        if (!sig[k]) throw new TsqlError(`DROP ${what.toUpperCase()} needs a name.`, { number: 102, at: node.start });
        const names = splitArgs(node.text.slice(sig[k].start).replace(/;\s*$/, ''));
        for (const written of names) {
            const mod = lookupModule(written);
            if (!mod || !fits(mod.kind)) {
                if (ifExists) continue;
                throw new TsqlError(`Cannot drop the ${what} '${splitName(written).name}', because it does not exist or you do not have permission.`, { number: 3701, at: node.start });
            }
            dropModule(db, mod.id);
            forgetModules();
        }
        if (what === 'trigger') armTriggers();
        statements++;
        pushResult({ kind: 'other', sql: node.text.trim(), columns: [], rows: [], more: false, cursor: null, rowsAffected: null, durationMs: 0, line: position(node.start).line, statement: statements - 1 });
    }

    /** Functions can change only their own table variables, as in SQL Server. */
    function checkSideEffects(node, sig) {
        const head = sig[0]?.u || '';
        if (!['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'CREATE', 'DROP', 'ALTER', 'EXEC', 'EXECUTE'].includes(head)) return;
        let k = 1;
        if (head === 'INSERT' && sig[k]?.u === 'INTO') k++;
        if (head === 'DELETE' && sig[k]?.u === 'FROM') k++;
        if (['INSERT', 'UPDATE', 'DELETE'].includes(head) && sig[k]?.v.startsWith('@')) return;
        throw new TsqlError(`Invalid use of a side-effecting operator '${head}' within a function.`, { number: 443, at: node.start });
    }

    /** CREATE TABLE #t / SELECT … INTO #t: the #t, or ''. */
    function tempTableCreated(sig) {
        if (sig[0]?.u === 'CREATE' && sig[1]?.u === 'TABLE' && /^\[?#/.test(sig[2]?.v || '')) return unquote(sig[2].v);
        if (sig[0]?.u === 'SELECT' || sig[0]?.u === 'WITH') {
            const into = findWord(sig, 0, 'INTO');
            if (into > 0 && /^\[?#/.test(sig[into + 1]?.v || '')) return unquote(sig[into + 1].v);
        }
        return '';
    }

    /**
     * EXEC's parts: EXEC [@rc =] name args, EXEC (@sql) or EXEC ('…' + @x).
     * @returns {{ dynamic: { text: string, start: number } | null, ret: string | null, name: string, nameVar: string | null, args: any[] }}
     */
    function parseExec(text, base) {
        const sig = sigTokens(text, base);
        const local = (/** @type {number} */ k) => (sig[k] ? sig[k].start - base : text.length);
        let k = 1;
        if (sig[k]?.v === '(') {
            let level = 0;
            let close = k;
            for (; close < sig.length; close++) {
                if (sig[close].t !== 'p') continue;
                if (sig[close].v === '(') level++;
                else if (sig[close].v === ')' && --level === 0) break;
            }
            if (close >= sig.length || close === k + 1) throw new TsqlError('EXEC ( … ) needs the SQL to run, as text.', { number: 102, at: base });
            return { dynamic: { text: text.slice(local(k + 1), local(close)), start: sig[k + 1].start }, ret: null, name: '', nameVar: null, args: [] };
        }
        let ret = null;
        if (sig[k]?.v.startsWith('@') && sig[k + 1]?.v === '=') {
            ret = sig[k].v;
            k += 2;
        }
        let name = '';
        let nameVar = null;
        if (sig[k]?.v.startsWith('@')) {
            nameVar = sig[k].v;
            k++;
        } else {
            const from = k;
            while (k < sig.length && (sig[k].t === 'word' || sig[k].t === 'ident' || (sig[k].t === 'p' && sig[k].v === '.'))) {
                // Arguments start after the name: the next word without a dot before it
                if (k > from && sig[k].t !== 'p' && sig[k - 1].v !== '.') break;
                k++;
            }
            if (k === from) throw new TsqlError('EXEC needs the name of a procedure.', { number: 102, at: base });
            name = text.slice(local(from), sig[k - 1].end - base);
        }
        // Arguments, split at top-level commas
        const args = [];
        let level = 0;
        let from = k;
        const finish = (/** @type {number} */ end) => {
            let a = from;
            let b = end;
            if (a >= b) return;
            const arg = { name: /** @type {string | null} */ (null), text: '', start: 0, output: false, isDefault: false, bare: false };
            if (sig[a].v.startsWith('@') && sig[a + 1]?.v === '=' && b > a + 2) {
                arg.name = sig[a].v;
                a += 2;
            }
            if (b - 1 > a && ['OUTPUT', 'OUT'].includes(sig[b - 1].u)) {
                arg.output = true;
                b--;
            }
            arg.text = text.slice(local(a), sig[b - 1].end - base);
            arg.start = sig[a].start;
            if (b === a + 1 && sig[a].u === 'DEFAULT') arg.isDefault = true;
            // EXEC sp_help Customers: a bare name is passed as text
            else if (b === a + 1 && ((sig[a].t === 'word' && !sig[a].v.startsWith('@') && sig[a].u !== 'NULL') || sig[a].t === 'ident')) arg.bare = true;
            args.push(arg);
        };
        for (; k < sig.length; k++) {
            const t = sig[k];
            if (t.t === 'p' && t.v === '(') level++;
            else if (t.t === 'p' && t.v === ')') level--;
            else if (level === 0 && t.t === 'p' && (t.v === ',' || t.v === ';')) {
                finish(k);
                from = k + 1;
                if (t.v === ';') break;
            } else if (level === 0 && t.u === 'WITH' && ['RECOMPILE', 'RESULT'].includes(sig[k + 1]?.u || '')) break;
        }
        finish(k);
        return { dynamic: null, ret, name, nameVar, args };
    }

    /** An EXEC argument's value, in the caller's scope. */
    function argValue(arg) {
        if (arg.bare) return unquote(arg.text);
        return evaluate({ text: arg.text, start: arg.start });
    }

    /**
     * Matches EXEC's arguments to a procedure's parameters, giving each its value.
     * @returns {{ scope: Map<string, any>, outputs: { param: string, target: string }[] }}
     */
    function bindArgs(label, params, args, at, { functionCall = false } = {}) {
        const scope = new Map();
        const outputs = [];
        /** @type {Map<string, any>} */
        const named = new Map();
        const positional = [];
        for (const arg of args) {
            if (arg.name) named.set(arg.name.toLowerCase(), arg);
            else {
                if (named.size) throw new TsqlError(`Must pass parameter number ${positional.length + named.size + 1} and subsequent parameters as '@name = value'. After the form '@name = value' has been used, all subsequent parameters must be passed in the form '@name = value'.`, { number: 119, at });
                positional.push(arg);
            }
        }
        if (positional.length > params.length) throw new TsqlError(`Procedure or function ${label} has too many arguments specified.`, { number: 8144, at });
        for (const key of named.keys()) {
            if (!params.some((/** @type {any} */ p) => p.name.toLowerCase() === key)) throw new TsqlError(`${named.get(key).name} is not a parameter for procedure ${label}.`, { number: 8145, at });
        }
        params.forEach((/** @type {any} */ p, /** @type {number} */ k) => {
            const key = p.name.toLowerCase();
            const arg = named.get(key) || positional[k];
            let value;
            if (arg && !arg.isDefault) value = argValue(arg);
            else if (p.default !== null) value = evaluate({ text: p.default, start: at });
            else if (functionCall) throw new TsqlError(`An insufficient number of arguments were supplied for the procedure or function ${label}.`, { number: 313, at });
            else throw new TsqlError(`Procedure or function '${label}' expects parameter '${p.name}', which was not supplied.`, { number: 201, at });
            let converted;
            try {
                converted = convertTo(p.type, value);
            } catch (e) {
                if (e instanceof TsqlError) e.at = at;
                throw e;
            }
            scope.set(key, { name: p.name, kind: 'scalar', type: p.type, value: converted });
            if (arg && arg.output) {
                if (!p.output) throw new TsqlError(`The formal parameter "${p.name}" was not declared as an OUTPUT parameter, but the actual parameter passed in requested output.`, { number: 8162, at });
                if (!arg.text.startsWith('@')) throw new TsqlError(`OUTPUT needs a variable to receive ${p.name}, such as @result OUTPUT.`, { number: 179, at });
                outputs.push({ param: key, target: arg.text });
            }
        });
        return { scope, outputs };
    }

    /**
     * Runs statements in a scope of their own (a procedure, a function or
     * dynamic SQL), then puts the caller's scope back.
     * @param {{ nodes: any[], src: Source, scope: Map<string, any>, id?: number, fn?: boolean, at: number }} options
     * @returns {{ returned: unknown, scope: Map<string, any> }}
     */
    function runScope({ nodes, src, scope, id = moduleId, fn = false, at }) {
        if (depth >= MAX_NESTING) throw new TsqlError(`Maximum stored procedure, function, trigger, or view nesting level exceeded (limit ${MAX_NESTING}).`, { number: 217, at });
        const saved = { vars, source, moduleId, inFunction, scopeTemps, callLine, batchHead };
        if (callLine === null) callLine = position(at).line;
        vars = scope;
        source = src;
        moduleId = id;
        inFunction = fn;
        scopeTemps = [];
        batchHead = nodes[0] || null;
        depth++;
        let returned = null;
        try {
            for (const n of nodes) exec(n);
        } catch (e) {
            if (e instanceof Return) returned = e.value;
            else {
                let err = e;
                if (e instanceof Break || e instanceof Continue) err = new TsqlError('BREAK and CONTINUE can only be used inside a WHILE loop.', { number: 135, at });
                else if (!(e instanceof TsqlError)) {
                    const info = errorInfo(e);
                    err = new TsqlError(info.message, { number: info.number, severity: info.severity, state: info.state, at });
                    err.line = info.line;
                }
                if (!err.procedure && src.procedure) {
                    err.procedure = src.procedure;
                    if (!err.line) err.line = position(err.at >= 0 ? err.at : 0).line;
                } else if (!err.procedure) err.line = undefined;
                err.at = at;
                throw err;
            }
        } finally {
            depth--;
            for (const v of vars.values()) {
                if (v.kind === 'table' && !v.keep) dropTemp(v.table);
            }
            for (const t of scopeTemps) dropTemp(`"${t.replace(/"/g, '""')}"`);
            ({ vars, source, moduleId, inFunction, scopeTemps, callLine, batchHead } = saved);
        }
        return { returned, scope };
    }

    function dropTemp(table) {
        try {
            db.exec(`DROP TABLE IF EXISTS temp.${table}`);
        } catch {
            dropLater.push(table);
        }
    }

    function moduleSource(mod) {
        return makeSource(mod.definition, mod.name);
    }

    /** EXEC [@rc =] procedure …, EXEC (@sql), EXEC sp_executesql …, EXEC sp_help … */
    function runExec(node) {
        const call = parseExec(node.text, node.start);
        if (call.dynamic) {
            const text = printText(evaluate(call.dynamic));
            runDynamic(text, new Map(), node.start);
            return;
        }
        const written = call.nameVar ? printText(evaluate({ text: call.nameVar, start: node.start })) : call.name;
        const { name } = splitName(written);
        const lower = name.toLowerCase();
        if (lower === 'sp_executesql') {
            executeSql(call, node.start);
            return;
        }
        const mod = lookupModule(written);
        if (!mod && SYSTEM_PROCEDURES[lower]) {
            runSystem(lower, call, node);
            return;
        }
        if (!mod) throw new TsqlError(`Could not find stored procedure '${written}'.`, { number: 2812, at: node.start });
        if (mod.kind === 'IF' || mod.kind === 'TF') throw new TsqlError(`The request for procedure '${mod.name}' failed because '${mod.name}' is a table valued function object.`, { number: 2809, at: node.start });
        if (mod.kind === 'TR') throw new TsqlError(`The request for procedure '${mod.name}' failed because '${mod.name}' is a trigger object.`, { number: 2809, at: node.start });
        if (mod.kind === 'FN') {
            const { def } = parsedModule(mod);
            const { scope } = bindArgs(`${mod.schema}.${mod.name}`, def.params, call.args, node.start, { functionCall: true });
            const value = invokeScalar(mod, [...scope.values()].map(v => v.value), node.start);
            if (call.ret) assign(call.ret, value, node.start);
            return;
        }
        const { def, nodes } = parsedModule(mod);
        const { scope, outputs } = bindArgs(mod.name, def.params, call.args, node.start);
        const run = runScope({ nodes, src: moduleSource(mod), scope, id: mod.id, at: node.start });
        for (const o of outputs) assign(o.target, run.scope.get(o.param).value, node.start);
        if (call.ret) assign(call.ret, run.returned === null || run.returned === undefined ? 0 : run.returned, node.start);
    }

    /** Dynamic SQL: its own batch, which sees #temp tables but not the caller's variables. */
    function runDynamic(text, scope, at) {
        let nodes;
        try {
            nodes = parseBatch(text, 0);
        } catch (e) {
            if (e instanceof TsqlSyntaxError) throw new TsqlError(e.message, { number: 102, severity: 15, at });
            throw e;
        }
        return runScope({ nodes, src: makeSource(text, null), scope, at });
    }

    /** EXEC sp_executesql @stmt, N'@a INT, @b INT OUTPUT', @a = 1, @b = @x OUTPUT */
    function executeSql(call, at) {
        const args = [...call.args];
        const take = (/** @type {string} */ key, /** @type {number} */ index) => {
            const k = args.findIndex(a => a.name && a.name.toLowerCase() === key);
            if (k >= 0) return args.splice(k, 1)[0];
            const positional = args.filter(a => !a.name);
            if (positional.length && index === 0) return args.splice(args.indexOf(positional[0]), 1)[0];
            return null;
        };
        const stmt = take('@stmt', 0);
        if (!stmt) throw new TsqlError('Procedure expects parameter \'@statement\' of type \'ntext/nchar/nvarchar\'.', { number: 214, at });
        const text = printText(argValue(stmt));
        const defArg = take('@params', 0);
        const definition = defArg ? printText(argValue(defArg)) : '';
        let params = [];
        try {
            params = definition.trim() ? parseParams(definition) : [];
        } catch (e) {
            throw new TsqlError(e instanceof Error ? e.message : String(e), { number: 102, at });
        }
        const { scope, outputs } = bindArgs('sp_executesql', params, args, at);
        const run = runDynamic(text, scope, at);
        for (const o of outputs) assign(o.target, run.scope.get(o.param).value, at);
    }

    /** sp_help, sp_helptext, sp_columns … (catalog.js) */
    function runSystem(lower, call, node) {
        const names = SYSTEM_PROCEDURES[lower];
        /** @type {Record<string, unknown>} */
        const args = {};
        let k = 0;
        for (const arg of call.args) {
            const key = arg.name ? arg.name.toLowerCase() : names[k++];
            if (!key || !names.includes(key)) throw new TsqlError(arg.name ? `${arg.name} is not a parameter for procedure ${lower}.` : `Procedure or function ${lower} has too many arguments specified.`, { number: arg.name ? 8145 : 8144, at: node.start });
            args[key] = arg.isDefault ? null : argValue(arg);
        }
        const started = now();
        const line = position(node.start).line;
        try {
            runSystemProcedure({
                db,
                dbName: ctx.databaseName,
                grid: (columns, rows, title) => {
                    statements++;
                    rowcount = rows.length;
                    pushResult({ kind: 'query', sql: `${node.text.trim()} -- ${title}`, columns, rows: rows.slice(0, 1000), more: rows.length > 1000, cursor: null, rowsAffected: null, durationMs: Math.max(0, now() - started), line, statement: statements - 1 });
                },
                print: text => pushResult({ kind: 'print', sql: node.text.trim(), text, columns: [], rows: [], line, statement: statements, durationMs: 0 }),
                modules,
                findModule: lookupModule,
                renameModule: (id, newName) => {
                    renameModule(db, id, newName);
                    forgetModules();
                },
                fail: (message, number) => {
                    throw new TsqlError(message, { number, at: node.start });
                }
            }, lower, args);
        } catch (e) {
            if (e instanceof TsqlError) throw e;
            const message = String(e instanceof Error ? e.message : e).replace(/^.*?Error:\s*/, '');
            throw new TsqlError(message, { number: errorNumber(message), at: node.start });
        }
    }

    /** INSERT INTO t [(cols)] EXEC …: the procedure's rows go into t. */
    function insertExec(node, sig, execAt) {
        const head = node.text.slice(0, sig[execAt].start).trim();
        const execNode = { ...node, text: node.text.slice(sig[execAt].start), start: node.start + sig[execAt].start };
        const outer = capture;
        capture = [];
        let sets;
        try {
            runExec(execNode);
            sets = capture;
        } finally {
            capture = outer;
        }
        const rows = sets.flatMap((/** @type {any} */ r) => r.rows);
        const width = sets[0]?.columns.length || 0;
        let count = 0;
        if (rows.length) {
            const target = translate(`${head} VALUES (${new Array(width).fill('NULL').join(', ')})`).replace(/VALUES\s*\([^)]*\)\s*;?\s*$/i, '');
            for (const row of rows) {
                const out = runText(`${target} VALUES (${row.map((/** @type {any} */ _v, /** @type {number} */ k) => `@__v${k}`).join(', ')})`, { size: 1, keep: false, bind: (/** @type {any} */ stmt) => {
                    row.forEach((/** @type {any} */ v, /** @type {number} */ k) => stmt.bind(`@__v${k}`, v && typeof v === 'object' && 'blob' in v ? null : v));
                } });
                if (out.error) {
                    const message = String(out.error.message).replace(/^Error:\s*/, '');
                    throw new TsqlError(message, { number: errorNumber(message), at: node.start });
                }
                count++;
            }
        }
        statements++;
        rowcount = count;
        pushResult({ kind: 'modify', sql: node.text.trim(), columns: [], rows: [], more: false, cursor: null, rowsAffected: count, durationMs: 0, line: position(node.start).line, statement: statements - 1 });
    }

    /** Makes a scalar function callable from SQL as sqllab_fn_<id>. */
    function registerFunction(mod) {
        db.createFunction({ name: `sqllab_fn_${mod.id}`, arity: -1, deterministic: false,
            xFunc: (/** @type {any} */ _c, /** @type {any[]} */ ...args) => {
                try {
                    const current = (allModules || modules()).find(m => m.id === mod.id);
                    if (!current) throw new TsqlError(`Cannot find either column "${mod.schema}" or the user-defined function or aggregate "${mod.schema}.${mod.name}", or the name is ambiguous.`, { number: 4121, at: currentAt });
                    const value = invokeScalar(current, args.map(a => (typeof a === 'bigint' ? Number(a) : a)), currentAt);
                    return value === undefined ? null : value;
                } catch (e) {
                    udfError = e;
                    throw e;
                }
            } });
    }

    /** Runs a scalar function with argument values; returns its value. */
    function invokeScalar(mod, values, at) {
        const { def, nodes } = parsedModule(mod);
        const label = `${mod.schema}.${mod.name}`;
        if (values.length < def.params.length) throw new TsqlError(`An insufficient number of arguments were supplied for the procedure or function ${label}.`, { number: 313, at });
        if (values.length > def.params.length) throw new TsqlError(`Procedure or function ${label} has too many arguments specified.`, { number: 8144, at });
        const scope = new Map();
        def.params.forEach((p, k) => scope.set(p.name.toLowerCase(), { name: p.name, kind: 'scalar', type: p.type, value: convertTo(p.type, values[k]) }));
        const savedAt = currentAt;
        try {
            const { returned } = runScope({ nodes, src: moduleSource(mod), scope, id: mod.id, fn: true, at });
            return convertTo(/** @type {string} */ (def.returns), returned);
        } finally {
            currentAt = savedAt;
        }
    }

    /**
     * Calls to user functions in a statement: dbo.f(x) becomes sqllab_fn_<id>(x);
     * an inline table-valued function becomes its SELECT; a multi-statement one
     * runs now and becomes the table it returned.
     */
    function expandModules(text) {
        const list = modules();
        const isFunction = (/** @type {{ kind: string }} */ m) => m.kind === 'FN' || m.kind === 'IF' || m.kind === 'TF';
        if (!list.some(isFunction)) return text;
        const names = new Set(list.filter(isFunction).map(m => m.name.toLowerCase()));
        let out = text;
        for (let round = 0; round < MAX_NESTING; round++) {
            const toks = tokens(out);
            let changed = false;
            const sigAt = (/** @type {number} */ k) => {
                let j = k;
                while (j < toks.length && (toks[j].t === 'ws' || toks[j].t === 'nl' || toks[j].t === 'comment')) j++;
                return j;
            };
            for (let i = 0; i < toks.length; i++) {
                const t = toks[i];
                if (t.t !== 'word' && t.t !== 'ident') continue;
                if (!names.has(unquote(t.v).toLowerCase())) continue;
                const open = sigAt(i + 1);
                if (toks[open]?.v !== '(') continue;
                // The whole name: [db.][schema.]name
                let start = i;
                for (;;) {
                    let p = start - 1;
                    while (p >= 0 && (toks[p].t === 'ws' || toks[p].t === 'nl')) p--;
                    if (p >= 1 && toks[p].v === '.') {
                        let q = p - 1;
                        while (q >= 0 && (toks[q].t === 'ws' || toks[q].t === 'nl')) q--;
                        if (q >= 0 && (toks[q].t === 'word' || toks[q].t === 'ident')) {
                            start = q;
                            continue;
                        }
                    }
                    break;
                }
                const written = toks.slice(start, i + 1).map(x => x.v).join('').replace(/\s+/g, '');
                const mod = lookupModule(written);
                if (!mod || !isFunction(mod)) continue;
                let close = open;
                let level = 0;
                for (; close < toks.length; close++) {
                    if (toks[close].t !== 'p') continue;
                    if (toks[close].v === '(') level++;
                    else if (toks[close].v === ')' && --level === 0) break;
                }
                if (close >= toks.length) continue;
                const argText = toks.slice(open + 1, close).map(x => x.v).join('');
                let replacement;
                if (mod.kind === 'FN') replacement = `sqllab_fn_${mod.id}(${argText})`;
                else replacement = tableFunction(mod, splitArgs(argText), toks, close, sigAt);
                toks.splice(start, close - start + 1, { t: 'word', v: replacement });
                changed = true;
                break;
            }
            out = toks.map(x => x.v).join('');
            if (!changed) break;
        }
        return out;
    }

    const ALIAS_STOPS = new Set(['WHERE', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER', 'ON', 'GROUP', 'ORDER', 'HAVING', 'UNION',
        'EXCEPT', 'INTERSECT', 'OPTION', 'FOR', 'WITH', 'NATURAL', 'APPLY', 'PIVOT', 'UNPIVOT', 'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'SET', 'WINDOW']);

    /** A table-valued function call as SQL: its SELECT, or the table a multi-statement one filled. */
    function tableFunction(mod, args, toks, close, sigAt) {
        const { def, nodes } = parsedModule(mod);
        const label = `${mod.schema}.${mod.name}`;
        if (args.length < def.params.length) throw new TsqlError(`An insufficient number of arguments were supplied for the procedure or function ${label}.`, { number: 313, at: currentAt });
        if (args.length > def.params.length) throw new TsqlError(`Procedure or function ${label} has too many arguments specified.`, { number: 8144, at: currentAt });
        const next = toks[sigAt(close + 1)];
        const hasAlias = next && (next.t === 'ident' || (next.t === 'word' && !next.v.startsWith('@') && (next.v.toUpperCase() === 'AS' || !ALIAS_STOPS.has(next.v.toUpperCase()))));
        const alias = hasAlias ? '' : ` AS "${mod.name.replace(/"/g, '""')}"`;
        if (mod.kind === 'IF') {
            // Each parameter becomes the argument written for it
            const byName = new Map(def.params.map((p, k) => [p.name.toLowerCase(), args[k].trim().toUpperCase() === 'DEFAULT' ? (p.default ?? 'NULL') : args[k]]));
            const body = tokens(/** @type {string} */ (def.query)).map(x => (x.t === 'word' && byName.has(x.v.toLowerCase()) ? { ...x, v: `(${byName.get(x.v.toLowerCase())})` } : x)).map(x => x.v).join('');
            return `(${body})${alias}`;
        }
        // Multi-statement: run it with the argument values, keep the table it filled
        const values = args.map((a, k) => {
            if (a.trim().toUpperCase() === 'DEFAULT') return def.params[k].default === null ? null : evaluate({ text: /** @type {string} */ (def.params[k].default), start: currentAt });
            try {
                return evaluate({ text: a, start: currentAt });
            } catch (e) {
                if (e instanceof TsqlError && e.number === 207) throw new TsqlError(`SQL Lab runs a multi-statement table-valued function (${label}) once per statement, so its arguments must be values or variables, not columns.`, { number: 4104, at: currentAt });
                throw e;
            }
        });
        const scope = new Map();
        def.params.forEach((p, k) => scope.set(p.name.toLowerCase(), { name: p.name, kind: 'scalar', type: p.type, value: convertTo(p.type, values[k]) }));
        const table = `"__tvf_${++tvfCount}"`;
        const returnTable = /** @type {{ name: string, columns: string }} */ (def.table);
        createTable(table, returnTable.columns, currentAt, true);
        dropLater.push(table);
        scope.set(returnTable.name.toLowerCase(), { name: returnTable.name, kind: 'table', table, keep: true });
        const savedAt = currentAt;
        try {
            runScope({ nodes, src: moduleSource(mod), scope, id: mod.id, fn: true, at: currentAt });
        } finally {
            currentAt = savedAt;
        }
        return `temp.${table}${alias}`;
    }

    // ---- run the batches

    /** @type {{ text: string, start: number, repeat: number }[]} */
    let batches;
    try {
        batches = splitBatches(script);
    } catch (e) {
        batches = [];
        error = toError(e);
    }
    // Functions are SQLite functions that call back into this run
    try {
        for (const m of modules()) if (m.kind === 'FN') registerFunction(m);
        armTriggers();
    } catch (e) {
        if (!error) error = toError(e);
        batches = [];
    }
    outer: for (const batch of batches) {
        let nodes;
        try {
            nodes = parseBatch(batch.text, batch.start);
        } catch (e) {
            error = toError(e);
            break;
        }
        batchHead = nodes[0] || null;
        for (let rep = 0; rep < batch.repeat; rep++) {
            vars = new Map();
            try {
                for (const node of nodes) exec(node);
            } catch (e) {
                if (!(e instanceof Return)) {
                    if (e instanceof Break || e instanceof Continue) error = toError(new TsqlError('BREAK and CONTINUE can only be used inside a WHILE loop.', { number: 135 }));
                    else error = toError(e);
                }
            } finally {
                // Table variables last only for their batch
                for (const v of vars.values()) {
                    if (v.kind === 'table') {
                        try {
                            db.exec(`DROP TABLE IF EXISTS temp.${v.table}`);
                        } catch {
                            // already gone
                        }
                    }
                }
            }
            if (error) break outer;
        }
    }

    function toError(e) {
        const info = errorInfo(e);
        const at = e instanceof TsqlSyntaxError ? e.offset : e && typeof e.at === 'number' && e.at >= 0 ? e.at : 0;
        const where = position(at);
        // An error inside a procedure points the editor at the EXEC; its own line is in the code, as SSMS shows it
        const inside = e && e.procedure;
        const line = !inside && e && e.line ? e.line : where.line;
        return {
            message: info.message,
            code: `Msg ${info.number}, Level ${info.severity}, State ${info.state}${inside ? `, Procedure ${e.procedure}, Line ${e.line}` : ''}`,
            statement: statements,
            line,
            column: line === where.line ? where.column : 1,
            ...(inside ? { procedure: e.procedure, procedureLine: e.line } : {})
        };
    }

    try {
        disarmTriggers();
    } catch {
        // the database is busy; the logging goes when it closes
    }
    for (const table of dropLater) {
        try {
            db.exec(`DROP TABLE IF EXISTS temp.${table}`);
        } catch {
            // still in use: it goes when the database closes
        }
    }

    const inTransaction = capi.sqlite3_get_autocommit(db.pointer) === 0;
    if (!inTransaction) {
        session.tranCount = 0;
        session.savepoints = [];
    }
    return {
        results,
        omitted,
        statements,
        changes: capi.sqlite3_total_changes(db.pointer) - changesBefore,
        error,
        inTransaction,
        translation: { changes: [...changes].map(([message, count]) => ({ message, count })), sql: ran.join(';\n') + (ran.length ? ';' : '') }
    };
}

/** Arguments separated by top-level commas. */
function splitArgs(text) {
    const out = [];
    let depth = 0;
    let quote = '';
    let start = 0;
    for (let k = 0; k < text.length; k++) {
        const c = text[k];
        if (quote) {
            if (c === quote) {
                if (text[k + 1] === quote) k++;
                else quote = '';
            }
        } else if (c === "'" || c === '"' || c === '[') quote = c === '[' ? ']' : c;
        else if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === ',' && depth === 0) {
            out.push(text.slice(start, k).trim());
            start = k + 1;
        }
    }
    const last = text.slice(start).trim();
    if (last || out.length) out.push(last);
    return out;
}

/** RAISERROR's message with %s, %d, %i and %u filled in. */
function formatMessage(message, args) {
    let k = 0;
    return message.replace(/%[-+ 0#]*\d*(?:\.\d+)?([sdiuxXo%])/g, (m, c) => {
        if (c === '%') return '%';
        const v = args[k++];
        if (v === undefined) return '(null)';
        if (c === 'd' || c === 'i' || c === 'u') return String(Math.trunc(Number(v)));
        if (c === 'x') return Math.trunc(Number(v)).toString(16);
        if (c === 'X') return Math.trunc(Number(v)).toString(16).toUpperCase();
        if (c === 'o') return Math.trunc(Number(v)).toString(8);
        return v === null ? '(null)' : String(v);
    });
}

// ---- statement shapes the engine runs itself

/** Index of the first depth-0 word `word` at or after `from`, or -1. */
function findWord(sig, from, word, to = sig.length) {
    let depth = 0;
    for (let k = from; k < to; k++) {
        const t = sig[k];
        if (t.t === 'p' && t.v === '(') depth++;
        else if (t.t === 'p' && t.v === ')') depth--;
        else if (depth === 0 && t.u === word) return k;
    }
    return -1;
}

/** Where the select list of the SELECT at `select` starts (after DISTINCT and TOP n). */
function selectListStart(sig, select) {
    let k = select + 1;
    if (sig[k]?.u === 'DISTINCT' || sig[k]?.u === 'ALL') k++;
    if (sig[k]?.u === 'TOP') {
        k++;
        if (sig[k]?.v === '(') {
            let depth = 0;
            for (; k < sig.length; k++) {
                if (sig[k].v === '(') depth++;
                else if (sig[k].v === ')' && --depth === 0) break;
            }
            k++;
        } else k++;
        if (sig[k]?.u === 'PERCENT') k++;
        if (sig[k]?.u === 'WITH' && sig[k + 1]?.u === 'TIES') k += 2;
    }
    return k;
}

/** The end (exclusive) of the select list: the first depth-0 FROM / INTO / WHERE … or the end. */
function selectListEnd(sig, from) {
    let depth = 0;
    let caseDepth = 0;
    for (let k = from; k < sig.length; k++) {
        const t = sig[k];
        if (t.t === 'p' && t.v === '(') depth++;
        else if (t.t === 'p' && t.v === ')') depth--;
        else if (t.u === 'CASE') caseDepth++;
        else if (t.u === 'END' && caseDepth > 0) caseDepth--;
        else if (depth === 0 && caseDepth === 0 && ['FROM', 'INTO', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'UNION', 'EXCEPT', 'INTERSECT', 'OPTION', 'FOR'].includes(t.u)) return k;
        else if (depth === 0 && t.t === 'p' && t.v === ';') return k;
    }
    return sig.length;
}

/** Splits sig[from, to) at depth-0 commas: [start, end) pairs. */
function items(sig, from, to) {
    const out = [];
    let depth = 0;
    let start = from;
    for (let k = from; k < to; k++) {
        if (sig[k].t !== 'p') continue;
        if (sig[k].v === '(') depth++;
        else if (sig[k].v === ')') depth--;
        else if (sig[k].v === ',' && depth === 0) {
            out.push([start, k]);
            start = k + 1;
        }
    }
    if (to > start) out.push([start, to]);
    return out;
}

const slice = (text, sig, a, b) => (b > a ? text.slice(sig[a].start, sig[b - 1].end) : '');

/** SELECT @a = expr, @b += expr FROM …  → the assignments and the rest of the query. */
function selectAssignments(text, sig) {
    if (sig[0]?.u !== 'SELECT') return null;
    const start = selectListStart(sig, 0);
    const end = selectListEnd(sig, start);
    const parts = items(sig, start, end);
    if (!parts.length) return null;
    const out = [];
    for (const [a, b] of parts) {
        const name = sig[a];
        if (!name || name.t !== 'word' || !name.v.startsWith('@') || name.v.startsWith('@@')) return null;
        let k = a + 1;
        let op = '';
        if (sig[k]?.t === 'p' && /^[+\-*/%&|^]$/.test(sig[k].v) && sig[k + 1]?.v === '=') {
            op = sig[k].v;
            k += 2;
        } else if (sig[k]?.v === '=') k++;
        else return null;
        out.push({ name: name.v, op, expr: slice(text, sig, k, b) });
    }
    const top = slice(text, sig, 1, start);
    return { items: out, rest: `${text.slice(sig[end - 1]?.end ?? text.length).trim()}`.replace(/;\s*$/, ''), top };
}

/** SELECT … INTO target FROM …: the target and the query without INTO. */
function selectInto(text, sig) {
    let first = 0;
    if (sig[0]?.u === 'WITH') {
        // After the CTEs: the main SELECT
        first = -1;
        let depth = 0;
        for (let k = 1; k < sig.length; k++) {
            if (sig[k].v === '(') depth++;
            else if (sig[k].v === ')') depth--;
            else if (depth === 0 && sig[k].u === 'SELECT') { first = k; break; }
        }
        if (first < 0) return null;
    } else if (sig[0]?.u !== 'SELECT') return null;
    const start = selectListStart(sig, first);
    const end = selectListEnd(sig, start);
    if (sig[end]?.u !== 'INTO') return null;
    const target = sig[end + 1];
    if (!target) return null;
    let after = end + 2;
    while (sig[after]?.v === '.' && sig[after + 1]) after += 2;
    const targetText = slice(text, sig, end + 1, after);
    const query = (text.slice(0, sig[end].start) + text.slice(sig[after - 1].end)).trim().replace(/;\s*$/, '');
    return { target: targetText, query };
}

/** INSERT / UPDATE / DELETE … OUTPUT inserted.x … → the statement with RETURNING, and OUTPUT INTO's target. */
function outputClause(text, sig) {
    const head = sig[0]?.u;
    if (!['INSERT', 'UPDATE', 'DELETE'].includes(head || '')) return null;
    const at = findWord(sig, 1, 'OUTPUT');
    if (at < 0) return null;
    // The OUTPUT list runs to INTO, or the next clause
    const stops = head === 'INSERT' ? ['VALUES', 'SELECT', 'DEFAULT', 'EXEC', 'EXECUTE'] : ['FROM', 'WHERE', 'OPTION'];
    let end = at + 1;
    let depth = 0;
    for (; end < sig.length; end++) {
        const t = sig[end];
        if (t.v === '(') depth++;
        else if (t.v === ')') depth--;
        else if (depth === 0 && (t.u === 'INTO' || stops.includes(t.u))) break;
    }
    const list = slice(text, sig, at + 1, end).replace(/\b(?:inserted|deleted)\s*\.\s*/gi, '');
    let into = null;
    let columns = null;
    let clauseEnd = end;
    if (sig[end]?.u === 'INTO') {
        let k = end + 2;
        while (sig[k]?.v === '.' && sig[k + 1]) k += 2;
        into = slice(text, sig, end + 1, k);
        if (sig[k]?.v === '(') {
            let d = 0;
            let close = k;
            for (; close < sig.length; close++) {
                if (sig[close].v === '(') d++;
                else if (sig[close].v === ')' && --d === 0) break;
            }
            columns = slice(text, sig, k + 1, close);
            k = close + 1;
        }
        clauseEnd = k;
    }
    const body = (text.slice(0, sig[at].start) + text.slice(sig[clauseEnd - 1].end)).trim().replace(/;\s*$/, '');
    return { sql: `${body} RETURNING ${list}`, into, columns };
}

/** SELECT TOP n PERCENT / TOP n WITH TIES at the top level: the query without TOP, and how to cut it. */
function topClause(text, sig) {
    if (sig[0]?.u !== 'SELECT') return null;
    let k = 1;
    if (sig[k]?.u === 'DISTINCT' || sig[k]?.u === 'ALL') k++;
    if (sig[k]?.u !== 'TOP') return null;
    const topAt = k;
    k++;
    let value;
    if (sig[k]?.v === '(') {
        let d = 0;
        let close = k;
        for (; close < sig.length; close++) {
            if (sig[close].v === '(') d++;
            else if (sig[close].v === ')' && --d === 0) break;
        }
        value = slice(text, sig, k + 1, close);
        k = close + 1;
    } else {
        value = sig[k]?.v || '';
        k++;
    }
    const percent = sig[k]?.u === 'PERCENT';
    if (percent) k++;
    const ties = sig[k]?.u === 'WITH' && sig[k + 1]?.u === 'TIES';
    if (ties) k += 2;
    if (!percent && !ties) return null;
    // TOP 100 PERCENT (in a view, for example) is everything
    let query = text.slice(0, sig[topAt].start) + text.slice(sig[k - 1].end);
    query = query.trim().replace(/;\s*$/, '');
    if (!ties) return { value, percent: true, query };
    // WITH TIES: rows tie on the ORDER BY values, so they are read too
    const qsig = sigTokens(query);
    const listStart = selectListStart(qsig, 0);
    const listEnd = selectListEnd(qsig, listStart);
    const order = findWord(qsig, listEnd, 'ORDER');
    if (order < 0 || qsig[order + 1]?.u !== 'BY') throw new TsqlError('The TOP N WITH TIES clause is not allowed without a corresponding ORDER BY clause.', { number: 1062 });
    const orderEnd = (() => {
        const stop = findWord(qsig, order + 2, 'OPTION');
        return stop < 0 ? qsig.length : stop;
    })();
    const columns = items(qsig, listStart, listEnd).map(([a, b]) => {
        const last = qsig[b - 1];
        const alias = qsig[b - 2]?.u === 'AS' || (b - a >= 2 && (last.t === 'word' || last.t === 'ident') && qsig[b - 2].t !== 'p') ? last.v : last.v;
        return alias.replace(/^\[|\]$/g, '').replace(/^"|"$/g, '').toLowerCase();
    });
    const keys = [];
    const extra = [];
    for (const [a, b] of items(qsig, order + 2, orderEnd)) {
        let e = b;
        if (['ASC', 'DESC'].includes(qsig[e - 1]?.u)) e--;
        const exprText = slice(query, qsig, a, e);
        const bare = exprText.split('.').pop()?.replace(/^\[|\]$/g, '').replace(/^"|"$/g, '').toLowerCase() || '';
        if (/^\d+$/.test(exprText.trim())) keys.push(Number(exprText) - 1);
        else if (columns.includes(bare)) keys.push(columns.indexOf(bare));
        else {
            keys.push(columns.length + extra.length);
            extra.push(exprText);
        }
    }
    if (extra.length) {
        const insertAt = qsig[listEnd - 1].end;
        query = `${query.slice(0, insertAt)}, ${extra.map((x, n) => `${x} AS __tsql_key${n}`).join(', ')}${query.slice(insertAt)}`;
    }
    return { value, percent: false, query, keys, hidden: extra.length };
}

/** IDENTITY(seed, increment) in a CREATE TABLE: the table and seed, when the seed isn't 1. */
function identitySeed(text) {
    const m = /\bIDENTITY\s*\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/i.exec(text);
    const table = /\bCREATE\s+TABLE\s+([^\s(]+)/i.exec(text)?.[1];
    if (!m || !table || Number(m[1]) === 1) return null;
    return { table, seed: Number(m[1]) };
}

/**
 * A SQL Server CREATE TABLE made ready for SQLite: an IDENTITY column becomes
 * the INTEGER PRIMARY KEY (AUTOINCREMENT, so numbers aren't reused), DEFAULT
 * GETDATE() gets the parentheses SQLite needs, and storage options go.
 */
export function prepareCreateTable(text) {
    const sig = sigTokens(text);
    const open = sig.findIndex(t => t.v === '(');
    if (open < 0) return adaptSqlServerScript(text).text;
    let close = open;
    let depth = 0;
    for (; close < sig.length; close++) {
        if (sig[close].v === '(') depth++;
        else if (sig[close].v === ')' && --depth === 0) break;
    }
    const defs = items(sig, open + 1, close).map(([a, b]) => ({ a, b, text: slice(text, sig, a, b), unique: false, drop: false }));
    const identity = defs.find(d => /\bIDENTITY\b/i.test(d.text) && !/^\s*(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK)\b/i.test(d.text));
    const pkConstraint = defs.find(d => /^\s*(CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\b/i.test(d.text));
    const out = defs.map(d => {
        let t = d.text;
        // DEFAULT GETDATE() → DEFAULT (GETDATE())
        t = t.replace(/\bDEFAULT\s+((?!\()[A-Za-z_][\w]*\s*\([^()]*\))/gi, 'DEFAULT ($1)');
        if (d === identity) {
            const name = /^\s*(\[[^\]]+\]|"[^"]+"|\S+)/.exec(t)?.[1] || '';
            const pkCols = pkConstraint ? (/\(([^)]*)\)/.exec(pkConstraint.text)?.[1] || '').split(',').map(c => c.trim().replace(/^\[|\]$/g, '').replace(/\s+(ASC|DESC)$/i, '').toLowerCase()) : [];
            const bare = name.replace(/^\[|\]$/g, '').replace(/^"|"$/g, '').toLowerCase();
            const rest = t.slice(t.indexOf(name) + name.length)
                .replace(/\bIDENTITY\s*(\(\s*-?\d+\s*,\s*-?\d+\s*\))?/i, '')
                .replace(/\b(BIG|SMALL|TINY)?INT(EGER)?\b/i, '')
                .replace(/\bPRIMARY\s+KEY(\s+(NON)?CLUSTERED)?/i, '')
                .replace(/\bNOT\s+NULL\b/i, '')
                .replace(/\bNULL\b/i, '')
                .replace(/\bNOT\s+FOR\s+REPLICATION\b/i, '')
                .replace(/\b(NON)?CLUSTERED\b/i, '')
                .trim();
            if (pkConstraint && !(pkCols.length === 1 && pkCols[0] === bare)) pkConstraint.unique = true;
            if (pkConstraint && pkCols.length === 1 && pkCols[0] === bare) pkConstraint.drop = true;
            return `${name} INTEGER PRIMARY KEY AUTOINCREMENT${rest ? ` ${rest}` : ''}`;
        }
        return t;
    });
    const finalDefs = out.map((t, k) => {
        const d = defs[k];
        if (d === pkConstraint && d.drop) return null;
        if (d === pkConstraint && d.unique) return t.replace(/\bPRIMARY\s+KEY\b/i, 'UNIQUE');
        return t;
    }).filter(x => x !== null);
    const rebuilt = `${text.slice(0, sig[open].end)}${finalDefs.join(', ')}${text.slice(sig[close].start)}`;
    return adaptSqlServerScript(rebuilt).text.replace(/\bINTEGER\s+INTEGER\b/gi, 'INTEGER');
}

export { tsqlCast };
