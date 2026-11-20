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

import { translateForSqlite, tsqlCast } from '../dialect-translate.js';
import { adaptSqlServerScript } from '../import-sqlserver.js';
import { toDate } from '../compat-functions.js';
import { parseBatch, sigTokens, splitBatches, TsqlSyntaxError } from './parse.js';

const MAX_RESULTS = 200;
// A runaway WHILE stops here instead of hanging the tab
const MAX_LOOP_STEPS = 1000000;
// SELECT @v = @v + … is worked out one row at a time up to this many rows
const MAX_ROW_ASSIGNMENTS = 10000;

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
    }
}

class Break { }
class Continue { }
class Return { }

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
    const { db, capi, now, size, runText, session } = ctx;
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

    // Line and column of an offset in the script
    const lineStarts = [0];
    for (let k = 0; k < script.length; k++) if (script[k] === '\n') lineStarts.push(k + 1);
    const position = (/** @type {number} */ offset) => {
        let lo = 0;
        let hi = lineStarts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (lineStarts[mid] <= offset) lo = mid;
            else hi = mid - 1;
        }
        return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
    };

    /** @type {Map<string, { name: string, kind: 'scalar' | 'table', type?: string, value?: unknown, table?: string }>} */
    let vars = new Map();
    let rowcount = 0;
    let lastError = 0;
    /** @type {{ number: number, message: string, severity: number, state: number, line: number } | null} the error a CATCH block is handling */
    let handling = null;
    let loopSteps = 0;

    const tableVariables = () => new Set([...vars.values()].filter(x => x.kind === 'table').map(x => x.name.toLowerCase()));

    /** Translates one statement (or expression wrapped in SELECT) for SQLite. */
    function translate(text) {
        const out = translateForSqlite(text, 'sqlserver', { tableVariables: tableVariables() });
        for (const c of out.changes) changes.set(c.message, (changes.get(c.message) || 0) + c.count);
        return out.sql;
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
        case '@__nestlevel': return 0;
        case '@__lock_timeout': return -1;
        case '@__textsize': return 2147483647;
        case '@__options': return 5496;
        case '@__procid': return 0;
        case '@__fetch_status': return -1;
        case '@__dbts': return null;
        case '@__microsoftversion': return 268435456;
        case '@__db_name': return ctx.databaseName;
        case '@__xact_state': return session.tranCount > 0 ? 1 : 0;
        case '@__error_message': return handling ? handling.message : null;
        case '@__error_number': return handling ? handling.number : null;
        case '@__error_severity': return handling ? handling.severity : null;
        case '@__error_state': return handling ? handling.state : null;
        case '@__error_line': return handling ? handling.line : null;
        case '@__error_procedure': return null;
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
        const out = runText(sqlText, { size, keep, bind: binder(at) });
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
                    const table = `"${item.name.replace(/"/g, '""')}"`;
                    db.exec(`DROP TABLE IF EXISTS temp.${table}`);
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
        case 'return': throw new Return();
        case 'print': {
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
            statement(node);
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
        if (e instanceof TsqlError) return { number: e.number, message: e.message, severity: e.severity, state: e.state, line: e.line || position(at).line };
        if (e instanceof TsqlSyntaxError) return { number: 102, message: e.message, severity: 15, state: 1, line: position(e.offset).line };
        const message = e instanceof Error ? e.message : String(e);
        return { number: errorNumber(message), message, severity: 16, state: 1, line: position(at).line };
    }

    // ---- SQL statements

    function statement(node) {
        const sig = sigTokens(node.text);
        const head = sig[0]?.u || '';
        const object = sig[1]?.u === 'OR' ? sig[3]?.u : sig[1]?.u;
        if ((head === 'CREATE' || head === 'ALTER') && ['PROCEDURE', 'PROC', 'FUNCTION', 'TRIGGER'].includes(object || '')) {
            throw new TsqlError(`CREATE ${object} isn't supported in SQL Lab yet.`, { number: 102, at: node.start });
        }
        if (head === 'EXEC' || head === 'EXECUTE') throw new TsqlError('EXEC (stored procedures) isn\'t supported in SQL Lab yet.', { number: 2812, at: node.start });
        if (head === 'MERGE') throw new TsqlError('MERGE isn\'t supported in SQL Lab yet: use UPDATE, then INSERT … WHERE NOT EXISTS.', { number: 102, at: node.start });
        if (head === 'TRUNCATE' && sig[1]?.u === 'TABLE') {
            const name = node.text.slice(sig[2].start, sig[sig.length - 1].end).replace(/;$/, '').trim();
            const target = translate(`DELETE FROM ${name}`);
            runSql(target, node.start, { original: node.text.trim() });
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
            runSql(translate(text), node.start, { original: node.text.trim() });
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
            pushResult({ kind: 'modify', sql: node.text.trim(), columns: [], rows: [], more: false, cursor: null, rowsAffected: count, durationMs: 0, line: position(node.start).line, statement: statements - 1 });
            return;
        }
        const output = outputClause(node.text, sig);
        if (output) {
            const results2 = runSql(translate(output.sql), node.start, { original: node.text.trim(), show: !output.into });
            if (output.into) {
                const rows = results2.flatMap(r => r.rows);
                const target = translate(output.into);
                for (const row of rows) {
                    db.exec({ sql: `INSERT INTO ${target}${output.columns ? ` (${output.columns})` : ''} VALUES (${row.map(() => '?').join(', ')})`, bind: row });
                }
                const r = results2[results2.length - 1];
                pushResult({ ...r, columns: [], rows: [], sql: node.text.trim(), line: position(node.start).line, statement: statements - 1 });
            }
            return;
        }
        const top = topClause(node.text, sig);
        if (top) {
            runTop(top, node);
            return;
        }
        runSql(translate(node.text), node.start, { keep: true, original: node.text.trim() });
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
        pushResult({ ...r, columns, rows: rows.slice(0, 1000), more: rows.length > 1000, cursor: null, sql: node.text.trim(), durationMs: Math.max(0, now() - started), line: position(node.start).line, statement: statements - 1 });
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

    // ---- run the batches

    /** @type {{ text: string, start: number, repeat: number }[]} */
    let batches;
    try {
        batches = splitBatches(script);
    } catch (e) {
        batches = [];
        error = toError(e);
    }
    outer: for (const batch of batches) {
        let nodes;
        try {
            nodes = parseBatch(batch.text, batch.start);
        } catch (e) {
            error = toError(e);
            break;
        }
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
        const line = e && e.line ? e.line : where.line;
        return {
            message: info.message,
            code: `Msg ${info.number}, Level ${info.severity}, State ${info.state}`,
            statement: statements,
            line,
            column: line === where.line ? where.column : 1
        };
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
