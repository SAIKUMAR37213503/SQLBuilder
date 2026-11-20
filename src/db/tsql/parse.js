// Reads a T-SQL script the way SQL Server does before running it: GO lines
// split it into batches, and each batch into statements and the control flow
// around them (DECLARE, SET, IF … ELSE, WHILE, BEGIN … END, TRY … CATCH,
// PRINT, THROW, RAISERROR, transactions). Statements may end with a semicolon
// or simply where the next statement starts, as SQL Server allows.
//
// Positions are character offsets in the whole script, so errors can point at
// the line and column in the editor.

import { tokens } from '../dialect-translate.js';

/**
 * @typedef {{ t: string, v: string, u: string, start: number, end: number }} Sig a token that isn't whitespace or a comment
 * @typedef {{ text: string, start: number, repeat: number }} Batch
 * @typedef {{ type: string, start: number, end: number, [key: string]: any }} Node
 */

export class TsqlSyntaxError extends Error {
    /** @param {string} message @param {number} offset */
    constructor(message, offset) {
        super(message);
        this.offset = offset;
    }
}

const GO_LINE = /^[ \t]*go(?:[ \t]+(\d+))?[ \t]*;?[ \t]*(?:--[^\n]*)?$/i;

/**
 * Splits a script at lines holding only GO (optionally GO n, which runs the
 * batch n times). Lines inside strings, comments and [names] are never GO.
 * @param {string} script
 * @returns {Batch[]}
 */
export function splitBatches(script) {
    const text = String(script ?? '');
    /** @type {Batch[]} */
    const batches = [];
    let batchStart = 0;
    let i = 0;
    let lineStart = 0;
    const endLine = (/** @type {number} */ end) => {
        const line = text.slice(lineStart, end).replace(/\r$/, '');
        const m = GO_LINE.exec(line);
        if (m) {
            batches.push({ text: text.slice(batchStart, lineStart), start: batchStart, repeat: m[1] ? Math.max(1, Number(m[1])) : 1 });
            batchStart = end;
        }
    };
    while (i < text.length) {
        const c = text[i];
        if (c === '\n') {
            endLine(i);
            i++;
            lineStart = i;
        } else if (c === "'" || c === '"' || c === '[') {
            const close = c === '[' ? ']' : c;
            let j = i + 1;
            for (; j < text.length; j++) {
                if (text[j] === close) {
                    if (text[j + 1] === close) j++;
                    else break;
                }
            }
            i = j + 1;
        } else if (c === '-' && text[i + 1] === '-') {
            const j = text.indexOf('\n', i);
            i = j < 0 ? text.length : j;
        } else if (c === '/' && text[i + 1] === '*') {
            const j = text.indexOf('*/', i + 2);
            i = j < 0 ? text.length : j + 2;
        } else i++;
    }
    // The last line may be GO with nothing after it
    const last = text.slice(lineStart).replace(/\r$/, '');
    if (GO_LINE.test(last)) batches.push({ text: text.slice(batchStart, lineStart), start: batchStart, repeat: Number(GO_LINE.exec(last)?.[1] || 1) || 1 });
    else batches.push({ text: text.slice(batchStart), start: batchStart, repeat: 1 });
    return batches.filter(b => b.text.trim() !== '' || batches.length === 1);
}

/** The significant tokens of `text`, with their offsets (plus `base`). */
export function sigTokens(text, base = 0) {
    /** @type {Sig[]} */
    const out = [];
    let at = base;
    for (const tok of tokens(text)) {
        const start = at;
        at += tok.v.length;
        if (tok.t === 'ws' || tok.t === 'nl' || tok.t === 'comment') continue;
        out.push({ t: tok.t, v: tok.v, u: tok.t === 'word' ? tok.v.toUpperCase() : '', start, end: at });
    }
    return out;
}

// Words that start a statement (outside parentheses), unless the statement
// being read continues with them (see continues below)
const STARTS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'WITH', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE',
    'DECLARE', 'SET', 'IF', 'WHILE', 'BEGIN', 'END', 'ELSE', 'PRINT', 'EXEC', 'EXECUTE', 'RETURN', 'BREAK', 'CONTINUE',
    'THROW', 'RAISERROR', 'USE', 'COMMIT', 'ROLLBACK', 'SAVE', 'GOTO', 'WAITFOR']);
// After DROP / CREATE: IF EXISTS / IF NOT EXISTS belongs to the statement
const OBJECT_TYPES = new Set(['TABLE', 'VIEW', 'PROCEDURE', 'PROC', 'FUNCTION', 'INDEX', 'TRIGGER', 'SCHEMA', 'DATABASE',
    'SEQUENCE', 'TYPE', 'COLUMN', 'CONSTRAINT', 'SYNONYM', 'USER', 'ROLE', 'LOGIN', 'STATISTICS', 'DEFAULT', 'RULE', 'ASSEMBLY']);
// WITH followed by these is an option, not a common table expression
const WITH_OPTIONS = new Set(['TIES', 'CHECK', 'NOCHECK', 'ROLLUP', 'CUBE', 'ENCRYPTION', 'SCHEMABINDING', 'RECOMPILE',
    'EXECUTE', 'EXEC', 'VALUES', 'LOG', 'NOWAIT', 'GRANT', 'RESULT', 'SETERROR', 'NATIVE_COMPILATION', 'RETURNS', 'XMLNAMESPACES', 'MARK']);
const SET_OPERATORS = new Set(['UNION', 'ALL', 'EXCEPT', 'INTERSECT']);
const CODE_OBJECTS = new Set(['PROCEDURE', 'PROC', 'FUNCTION', 'TRIGGER']);

/**
 * Parses one batch into a list of nodes.
 * @param {string} text the batch
 * @param {number} base its offset in the script
 * @returns {Node[]}
 */
export function parseBatch(text, base = 0) {
    const sig = sigTokens(text, base);
    let i = 0;
    const at = (/** @type {number} */ k) => sig[k];
    const u = (/** @type {number} */ k) => sig[k]?.u || '';
    const v = (/** @type {number} */ k) => sig[k]?.v || '';
    const offsetOf = (/** @type {number} */ k) => (sig[k] ? sig[k].start : base + text.length);
    const endOf = (/** @type {number} */ k) => (k > 0 && sig[k - 1] ? sig[k - 1].end : base);
    const src = (/** @type {number} */ a, /** @type {number} */ b) => (b > a ? text.slice(sig[a].start - base, sig[b - 1].end - base) : '');
    const fail = (/** @type {string} */ message, /** @type {number} */ k) => {
        throw new TsqlSyntaxError(message, offsetOf(k));
    };
    const skipSemis = () => {
        while (v(i) === ';' && at(i)?.t === 'p') i++;
    };
    const isWord = (/** @type {number} */ k, /** @type {string} */ w) => u(k) === w;

    /**
     * The end (exclusive) of an expression or SQL statement starting at `from`:
     * the next ';' or statement start at the same level.
     * @param {number} from
     * @param {{ expression?: boolean }} [options] an IF / WHILE condition, PRINT text …: any statement word ends it
     */
    function scanEnd(from, { expression = false } = {}) {
        let k = from;
        let depth = 0;
        let caseDepth = 0;
        const head = expression ? '' : u(from);
        // The statement a WITH introduces, once it has started
        let main = head === 'WITH' ? '' : head;
        // Waiting for a query: INSERT's rows, a view's SELECT, the statement after a WITH
        let expectQuery = head === 'WITH' || head === 'INSERT';
        let setSeen = false;
        let viewBody = false;
        if ((head === 'CREATE' || head === 'ALTER') && ['VIEW'].includes(u(from + 1) === 'OR' ? u(from + 3) : u(from + 1))) viewBody = true;
        for (; k < sig.length; k++) {
            const tok = sig[k];
            if (tok.t === 'p') {
                if (tok.v === '(') depth++;
                else if (tok.v === ')') {
                    if (depth === 0) return k;
                    depth--;
                } else if (tok.v === ';' && depth === 0) return k;
                continue;
            }
            if (tok.t !== 'word') continue;
            const w = tok.u;
            if (w === 'CASE') {
                caseDepth++;
                continue;
            }
            if (w === 'END' && caseDepth > 0) {
                caseDepth--;
                continue;
            }
            if (depth > 0 || caseDepth > 0 || k === from) continue;
            // INSERT … VALUES / DEFAULT VALUES has its rows: a SELECT after it is a new statement
            if (main === 'INSERT' && (w === 'VALUES' || (w === 'DEFAULT' && u(k + 1) === 'VALUES'))) expectQuery = false;
            if (!STARTS.has(w)) continue;
            const prev = sig[k - 1];
            const pu = prev?.u || '';
            // a, print / x.Select / = Update: a name, not a statement
            if (prev && (prev.v === ',' || prev.v === '.' || (prev.t === 'p' && prev.v !== ')'))) continue;
            if (expression) return k;
            if (w === 'END' || w === 'ELSE') return k;
            if (SET_OPERATORS.has(pu) && w === 'SELECT') continue;
            if (w === 'SELECT' || w === 'INSERT' || w === 'UPDATE' || w === 'DELETE' || w === 'MERGE') {
                if (viewBody && pu === 'AS' && w === 'SELECT') { viewBody = false; continue; }
                if (head === 'WITH' && !main) {
                    main = w;
                    expectQuery = w === 'INSERT';
                    continue;
                }
                if (expectQuery && main === 'INSERT' && w === 'SELECT') { expectQuery = false; continue; }
                if (main === 'MERGE' && (pu === 'THEN' || pu === 'NOT')) continue;
                if (pu === 'ON' || pu === 'OF' || pu === 'FOR' || pu === 'AFTER') continue;
                return k;
            }
            if (w === 'WITH') {
                const n = sig[k + 1];
                if (!n || n.v === '(' || WITH_OPTIONS.has(n.u)) continue;
                if (pu === 'AS' && viewBody) { viewBody = false; main = ''; expectQuery = true; continue; }
                // WITH name AS ( / WITH name (cols) AS (: a new statement
                return k;
            }
            if (w === 'SET') {
                if ((main === 'UPDATE' && !setSeen) || pu === 'UPDATE' || pu === 'DELETE' || (head === 'ALTER' && !setSeen)) {
                    setSeen = true;
                    continue;
                }
                return k;
            }
            if (w === 'IF') {
                if (OBJECT_TYPES.has(pu)) continue;
                return k;
            }
            if (w === 'ALTER' || w === 'DROP') {
                if (pu === 'OR') continue;
                if (head === 'ALTER' && ['COLUMN', 'CONSTRAINT', 'PERIOD'].includes(u(k + 1))) continue;
                return k;
            }
            if (w === 'EXEC' || w === 'EXECUTE') {
                if (main === 'INSERT' && expectQuery) { expectQuery = false; continue; }
                if (pu === 'WITH' || pu === 'GRANT') continue;
                return k;
            }
            if (w === 'SAVE' && !['TRAN', 'TRANSACTION'].includes(u(k + 1))) continue;
            return k;
        }
        return k;
    }

    /** A plain SQL statement from i to the end of the statement. */
    function sqlStatement() {
        const start = i;
        let end = scanEnd(i);
        // CREATE PROCEDURE / FUNCTION / TRIGGER take the rest of the batch
        const objectWord = u(start + 1) === 'OR' ? u(start + 3) : u(start + 1);
        if ((u(start) === 'CREATE' || u(start) === 'ALTER') && CODE_OBJECTS.has(objectWord)) end = sig.length;
        if (end === start) fail(`Incorrect syntax near '${v(start)}'.`, start);
        i = end;
        return { type: 'sql', start: offsetOf(start), end: endOf(end), text: src(start, end) };
    }

    /** An expression up to the next statement word at the same level. */
    function expression(what) {
        const start = i;
        const end = scanEnd(i, { expression: true });
        if (end === start) fail(`${what} is missing.`, start);
        i = end;
        return { text: src(start, end), start: offsetOf(start) };
    }

    /** Statements up to END (not consumed). */
    function block(endWords) {
        const body = [];
        for (;;) {
            skipSemis();
            if (i >= sig.length) fail(`Incorrect syntax: ${endWords} is missing.`, i);
            if (isWord(i, 'END')) return body;
            body.push(statement());
        }
    }

    /** DECLARE @a INT = 1, @t TABLE (…) */
    function declare() {
        const start = i;
        i++;
        const items = [];
        for (;;) {
            const name = at(i);
            if (!name || name.t !== 'word' || !name.v.startsWith('@') || name.v.startsWith('@@')) fail('DECLARE needs a variable name that starts with @.', i);
            i++;
            if (isWord(i, 'AS')) i++;
            if (isWord(i, 'TABLE')) {
                i++;
                if (v(i) !== '(') fail('DECLARE … TABLE needs its columns in parentheses.', i);
                const close = closeOf(i);
                items.push({ name: name.v, kind: 'table', columns: src(i + 1, close), start: offsetOf(start) });
                i = close + 1;
            } else if (isWord(i, 'CURSOR')) {
                fail('Cursors (DECLARE … CURSOR) aren\'t supported in SQL Lab yet. A WHILE loop over a temp table does the same job.', i);
            } else {
                const typeStart = i;
                if (!at(i) || (at(i).t !== 'word' && at(i).t !== 'ident')) fail(`DECLARE ${name.v} needs a data type, for example INT or NVARCHAR(50).`, i);
                i++;
                if (v(i) === '(') i = closeOf(i) + 1;
                const type = src(typeStart, i);
                let init = null;
                if (v(i) === '=') {
                    i++;
                    const exprStart = i;
                    let depth = 0;
                    let caseDepth = 0;
                    for (; i < sig.length; i++) {
                        const tok = sig[i];
                        if (tok.t === 'p') {
                            if (tok.v === '(') depth++;
                            else if (tok.v === ')') {
                                if (depth === 0) break;
                                depth--;
                            } else if (depth === 0 && (tok.v === ',' || tok.v === ';')) break;
                            continue;
                        }
                        if (tok.u === 'CASE') caseDepth++;
                        else if (tok.u === 'END' && caseDepth > 0) caseDepth--;
                        else if (depth === 0 && caseDepth === 0 && i > exprStart && STARTS.has(tok.u)) {
                            const prev = sig[i - 1];
                            if (!(prev.v === ',' || prev.v === '.' || (prev.t === 'p' && prev.v !== ')'))) break;
                        }
                    }
                    init = { text: src(exprStart, i), start: offsetOf(exprStart) };
                }
                items.push({ name: name.v, kind: 'scalar', type, init });
            }
            if (v(i) === ',') {
                i++;
                continue;
            }
            break;
        }
        return { type: 'declare', items, start: offsetOf(start), end: endOf(i) };
    }

    function closeOf(open) {
        let depth = 0;
        for (let k = open; k < sig.length; k++) {
            if (sig[k].t !== 'p') continue;
            if (sig[k].v === '(') depth++;
            else if (sig[k].v === ')' && --depth === 0) return k;
        }
        fail('A parenthesis isn\'t closed.', open);
        return -1;
    }

    /** SET @x = …, SET @x += …, SET NOCOUNT ON, SET IDENTITY_INSERT t ON … */
    function setStatement() {
        const start = i;
        const target = at(i + 1);
        if (target && target.t === 'word' && target.v.startsWith('@') && !target.v.startsWith('@@')) {
            i += 2;
            const op = v(i);
            const compound = /^[+\-*/%&|^]$/.test(op) && v(i + 1) === '=' ? op : '';
            if (compound) i += 2;
            else if (op === '=') i++;
            else fail(`SET ${target.v} needs = and a value.`, i);
            const value = expression(`The value for ${target.v}`);
            return { type: 'set', name: target.v, op: compound, expr: value, start: offsetOf(start), end: endOf(i) };
        }
        // Session options: read to the end of the line's statement
        i++;
        const optStart = i;
        while (i < sig.length && !(sig[i].t === 'p' && sig[i].v === ';') && !(STARTS.has(u(i)) && i > optStart && !['ON', 'OFF'].includes(u(i)))) {
            if (['ON', 'OFF'].includes(u(i)) || sig[i].t === 'num') {
                i++;
                break;
            }
            i++;
        }
        return { type: 'option', text: src(optStart, i), start: offsetOf(start), end: endOf(i) };
    }

    function statement() {
        skipSemis();
        const start = i;
        const w = u(i);
        if (w === 'DECLARE') return declare();
        if (w === 'SET') return setStatement();
        if (w === 'IF') {
            i++;
            const cond = expression('The IF condition');
            skipSemis();
            if (i >= sig.length) fail('IF needs a statement to run.', i);
            const then = statement();
            let otherwise = null;
            const save = i;
            skipSemis();
            if (isWord(i, 'ELSE')) {
                i++;
                skipSemis();
                otherwise = statement();
            } else i = save;
            return { type: 'if', cond, then, else: otherwise, start: offsetOf(start), end: endOf(i) };
        }
        if (w === 'WHILE') {
            i++;
            const cond = expression('The WHILE condition');
            skipSemis();
            if (i >= sig.length) fail('WHILE needs a statement to repeat.', i);
            const body = statement();
            return { type: 'while', cond, body, start: offsetOf(start), end: endOf(i) };
        }
        if (w === 'BEGIN') {
            const next = u(i + 1);
            if (next === 'TRY') {
                i += 2;
                const body = block('END TRY');
                i++;
                if (!isWord(i, 'TRY')) fail('END TRY is missing.', i);
                i++;
                skipSemis();
                if (!(isWord(i, 'BEGIN') && isWord(i + 1, 'CATCH'))) fail('BEGIN TRY needs a BEGIN CATCH block after END TRY.', i);
                i += 2;
                const handler = block('END CATCH');
                i++;
                if (!isWord(i, 'CATCH')) fail('END CATCH is missing.', i);
                i++;
                return { type: 'try', body, handler, start: offsetOf(start), end: endOf(i) };
            }
            if (next === 'TRAN' || next === 'TRANSACTION' || next === 'DISTRIBUTED') {
                i += next === 'DISTRIBUTED' ? 3 : 2;
                const name = at(i) && (at(i).t === 'word' || at(i).t === 'ident') && !STARTS.has(u(i)) && u(i) !== 'WITH' ? sig[i++].v : '';
                if (isWord(i, 'WITH') && isWord(i + 1, 'MARK')) {
                    i += 2;
                    if (at(i)?.t === 'str') i++;
                }
                return { type: 'tran', action: 'begin', name, start: offsetOf(start), end: endOf(i) };
            }
            i++;
            const body = block('END');
            i++;
            return { type: 'block', body, start: offsetOf(start), end: endOf(i) };
        }
        if (w === 'COMMIT' || w === 'ROLLBACK' || w === 'SAVE') {
            i++;
            if (['TRAN', 'TRANSACTION', 'WORK'].includes(u(i))) i++;
            const name = at(i) && (at(i).t === 'word' || at(i).t === 'ident') && !STARTS.has(u(i)) ? sig[i++].v : '';
            return { type: 'tran', action: w.toLowerCase(), name, start: offsetOf(start), end: endOf(i) };
        }
        if (w === 'PRINT') {
            i++;
            const expr = expression('PRINT needs a value');
            return { type: 'print', expr, start: offsetOf(start), end: endOf(i) };
        }
        if (w === 'BREAK' || w === 'CONTINUE') {
            i++;
            return { type: w.toLowerCase(), start: offsetOf(start), end: endOf(i) };
        }
        if (w === 'RETURN') {
            i++;
            const hasValue = i < sig.length && !(sig[i].t === 'p' && sig[i].v === ';') && !(STARTS.has(u(i)) && sig[i].t === 'word');
            const expr = hasValue ? expression('RETURN value') : null;
            return { type: 'return', expr, start: offsetOf(start), end: endOf(i) };
        }
        if (w === 'THROW') {
            i++;
            if (i >= sig.length || (sig[i].t === 'p' && sig[i].v === ';') || (sig[i].t === 'word' && STARTS.has(u(i)))) return { type: 'throw', args: null, start: offsetOf(start), end: endOf(i) };
            const args = expression('THROW needs an error number, message and state');
            return { type: 'throw', args, start: offsetOf(start), end: endOf(i) };
        }
        if (w === 'RAISERROR') {
            i++;
            if (v(i) !== '(') fail('RAISERROR needs its message, severity and state in parentheses.', i);
            const close = closeOf(i);
            const args = { text: src(i + 1, close), start: offsetOf(i + 1) };
            i = close + 1;
            const options = [];
            if (isWord(i, 'WITH')) {
                i++;
                while (['NOWAIT', 'LOG', 'SETERROR'].includes(u(i))) {
                    options.push(u(i));
                    i++;
                    if (v(i) === ',') i++;
                }
            }
            return { type: 'raiserror', args, options, start: offsetOf(start), end: endOf(i) };
        }
        if (w === 'USE') {
            i++;
            const name = sig[i] ? sig[i++].v : '';
            return { type: 'use', name, start: offsetOf(start), end: endOf(i) };
        }
        if (w === 'GOTO' || w === 'WAITFOR') fail(`${w} isn't supported in SQL Lab.`, i);
        if (w === 'END') fail('END has no matching BEGIN.', i);
        if (w === 'ELSE') fail('ELSE has no matching IF.', i);
        return sqlStatement();
    }

    /** @type {Node[]} */
    const nodes = [];
    for (;;) {
        skipSemis();
        if (i >= sig.length) break;
        nodes.push(statement());
    }
    return nodes;
}
