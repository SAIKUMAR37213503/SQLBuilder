// SQL Lab's languages: SQL written for SQL Server (T-SQL), PostgreSQL or
// MySQL, translated so SQLite (the engine embedded in SQL Lab) can run it on
// the same databases. The translation is text to text and keeps every line
// break, so a line number in an error is the line in the editor.
//
// Two parts work together:
//   - this module rewrites syntax SQLite reads differently (TOP, ::casts,
//     INTERVAL, SHOW TABLES, OFFSET … FETCH, N'…', schema names, …), and lists
//     each kind of change so the person can see what ran;
//   - dialect-functions.js (registered in the engine) adds the functions
//     those languages have and SQLite doesn't (GETDATE, DATEADD, NOW,
//     DATE_FORMAT, EXTRACT, …), so most calls run without a rewrite.
// What can't be translated (procedures, variables, T-SQL control flow) is
// left as written, and SQLite's error then says where.

import { replaceBatchSeparators } from './script-split.js';

/** @typedef {'sqlite' | 'sqlserver' | 'postgresql' | 'mysql'} LabDialect */

export const LAB_DIALECTS = /** @type {const} */ ([
    { id: 'sqlite', label: 'SQLite', note: 'Runs as written.' },
    { id: 'sqlserver', label: 'SQL Server (T-SQL)', note: 'TOP, GO, N\'…\', [names], dbo., GETDATE, DATEADD, CONVERT, ISNULL, LEN, PRINT and more are translated.' },
    { id: 'postgresql', label: 'PostgreSQL', note: '::casts, ILIKE, SERIAL, public., EXTRACT, DATE_TRUNC, NOW, FETCH FIRST and more are translated.' },
    { id: 'mysql', label: 'MySQL', note: 'SHOW TABLES, DESCRIBE, AUTO_INCREMENT, INTERVAL, NOW, DATE_FORMAT, DATE_ADD and more are translated.' }
]);

export const isLabDialect = (/** @type {unknown} */ id) => LAB_DIALECTS.some(d => d.id === id);

/**
 * @typedef {{ t: 'nl' | 'ws' | 'comment' | 'str' | 'ident' | 'word' | 'num' | 'p', v: string }} Token
 */

/** Splits SQL into tokens; joining every token's text gives the input back. */
export function tokens(sql) {
    const text = String(sql ?? '');
    /** @type {Token[]} */
    const out = [];
    let i = 0;
    const push = (/** @type {Token['t']} */ t, /** @type {number} */ end) => {
        out.push({ t, v: text.slice(i, end) });
        i = end;
    };
    while (i < text.length) {
        const c = text[i];
        if (c === '\n') push('nl', i + 1);
        else if (c === ' ' || c === '\t' || c === '\r' || c === '\f') {
            let j = i + 1;
            while (j < text.length && /[ \t\r\f]/.test(text[j])) j++;
            push('ws', j);
        } else if (c === '-' && text[i + 1] === '-') {
            const j = text.indexOf('\n', i);
            push('comment', j < 0 ? text.length : j);
        } else if (c === '/' && text[i + 1] === '*') {
            const j = text.indexOf('*/', i + 2);
            push('comment', j < 0 ? text.length : j + 2);
        } else if (c === "'" || ((c === 'N' || c === 'n' || c === 'E' || c === 'e') && text[i + 1] === "'")) {
            let j = c === "'" ? i + 1 : i + 2;
            for (; j < text.length; j++) {
                if (text[j] === "'") {
                    if (text[j + 1] === "'") j++;
                    else break;
                }
            }
            push('str', Math.min(text.length, j + 1));
        } else if (c === '"' || c === '`' || c === '[') {
            const close = c === '[' ? ']' : c;
            let j = i + 1;
            for (; j < text.length; j++) {
                if (text[j] === close) {
                    if (close !== ']' && text[j + 1] === close) j++;
                    else break;
                }
            }
            push('ident', Math.min(text.length, j + 1));
        } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] || ''))) {
            const m = /^(?:0x[0-9a-f]+|\d*\.?\d+(?:e[+-]?\d+)?)/i.exec(text.slice(i));
            push('num', i + (m ? m[0].length : 1));
        } else if (/[\p{L}_@$#]/u.test(c)) {
            const m = /^[\p{L}\p{N}_@$#]+/u.exec(text.slice(i));
            push('word', i + (m ? m[0].length : 1));
        } else if ((c === ':' && text[i + 1] === ':') || (c === '|' && text[i + 1] === '|') || (c === '<' && /[=>]/.test(text[i + 1] || '')) || (c === '>' && text[i + 1] === '=') || (c === '!' && text[i + 1] === '=')) {
            push('p', i + 2);
        } else push('p', i + 1);
    }
    return out;
}

const upper = (/** @type {Token | undefined} */ t) => (t && t.t === 'word' ? t.v.toUpperCase() : '');
const isSpace = (/** @type {Token} */ t) => t.t === 'ws' || t.t === 'nl' || t.t === 'comment';

/** Index of the next token that isn't whitespace or a comment, or -1. */
function nextSig(list, from) {
    for (let i = from; i < list.length; i++) if (!isSpace(list[i])) return i;
    return -1;
}
function prevSig(list, from) {
    for (let i = from; i >= 0; i--) if (!isSpace(list[i])) return i;
    return -1;
}
/** Index of the ')' that closes the '(' at `open`, or -1. */
function closing(list, open) {
    let depth = 0;
    for (let i = open; i < list.length; i++) {
        const v = list[i].t === 'p' ? list[i].v : '';
        if (v === '(') depth++;
        else if (v === ')' && --depth === 0) return i;
        else if (v === ';' && depth > 0) return -1;
    }
    return -1;
}
/** Splits the tokens between `open` and its closing paren at top-level commas: [start, end) ranges. */
function argsOf(list, open, close) {
    const ranges = [];
    let depth = 0;
    let start = open + 1;
    for (let i = open + 1; i < close; i++) {
        const v = list[i].t === 'p' ? list[i].v : '';
        if (v === '(') depth++;
        else if (v === ')') depth--;
        else if (v === ',' && depth === 0) {
            ranges.push([start, i]);
            start = i + 1;
        }
    }
    ranges.push([start, close]);
    return ranges;
}
const textOf = (list, start, end) => list.slice(start, end).map(t => t.v).join('');
/** Replaces tokens [start, end) with one token, keeping the line breaks they held. */
function replace(list, start, end, value) {
    const breaks = list.slice(start, end).filter(t => t.t === 'nl').length;
    const lines = (value.match(/\n/g) || []).length;
    const pad = breaks > lines ? '\n'.repeat(breaks - lines) : '';
    list.splice(start, end - start, { t: 'p', v: value + pad });
}
const quote = (/** @type {string} */ s) => `'${s.replace(/'/g, "''")}'`;

const SQLITE_TYPE = (/** @type {string} */ type) => {
    const t = type.toUpperCase().replace(/\s+/g, ' ').replace(/\(.*$/, '').trim();
    if (/^(INT|INTEGER|BIGINT|SMALLINT|TINYINT|MEDIUMINT|INT2|INT4|INT8|SERIAL|BIGSERIAL|SMALLSERIAL|BIT|BOOL|BOOLEAN|SIGNED|UNSIGNED)/.test(t)) return 'INTEGER';
    if (/^(REAL|FLOAT|FLOAT4|FLOAT8|DOUBLE|DOUBLE PRECISION|MONEY|SMALLMONEY)/.test(t)) return 'REAL';
    if (/^(NUMERIC|DECIMAL|DEC|NUMBER)/.test(t)) return 'NUMERIC';
    if (/^(DATE|DATETIME|DATETIME2|SMALLDATETIME|TIMESTAMP|TIMESTAMPTZ|TIME|DATETIMEOFFSET)/.test(t)) return t.startsWith('DATE') && !t.startsWith('DATETIME') ? 'DATE' : t.startsWith('TIME') && !t.startsWith('TIMESTAMP') ? 'TIME' : 'DATETIME';
    if (/^(BINARY|VARBINARY|BLOB|BYTEA|IMAGE)/.test(t)) return 'BLOB';
    return 'TEXT';
};
/** CAST(x AS type) for SQLite, or the date function that keeps a date a date. */
function castFor(expr, type) {
    const target = SQLITE_TYPE(type);
    if (target === 'DATE') return `date(${expr})`;
    if (target === 'DATETIME') return `datetime(${expr})`;
    if (target === 'TIME') return `time(${expr})`;
    return `CAST(${expr} AS ${target})`;
}

const SCHEMA_CONTEXT = new Set(['FROM', 'JOIN', 'INTO', 'UPDATE', 'TABLE', 'EXISTS', 'REFERENCES', 'ON', 'DESCRIBE', 'DESC', 'TRUNCATE']);
const DATE_PART_FUNCS = new Set(['DATEADD', 'DATEDIFF', 'DATEPART', 'DATENAME', 'DATEDIFF_BIG', 'DATETRUNC']);
const SQLITE_SCHEMAS = new Set(['MAIN', 'TEMP']);

/**
 * @param {string} sql
 * @param {LabDialect} dialect
 * @param {{ tableVariables?: Set<string> | Map<string, string> }} [options] SQL Server: names (lower case) of the table variables declared so far (a Map gives their SQLite names)
 * @returns {{ sql: string, changes: { message: string, count: number }[] }}
 */
export function translateForSqlite(sql, dialect, options = {}) {
    const source = String(sql ?? '');
    if (dialect === 'sqlite' || !isLabDialect(dialect)) return { sql: source, changes: [] };
    const list = tokens(dialect === 'sqlserver' ? replaceBatchSeparators(source) : source);
    /** @type {Map<string, number>} */
    const counts = new Map();
    const note = (/** @type {string} */ message) => counts.set(message, (counts.get(message) || 0) + 1);

    if (dialect === 'sqlserver') sqlServer(list, note, options);
    else if (dialect === 'postgresql') postgres(list, note);
    else mysql(list, note);
    common(list, note, dialect);

    return { sql: list.map(t => t.v).join(''), changes: [...counts].map(([message, count]) => ({ message, count })) };
}

/** Rewrites shared by the three languages. */
function common(list, note, dialect) {
    for (let i = 0; i < list.length; i++) {
        const w = upper(list[i]);
        // schema.table → table (SQLite's only schemas are main and temp)
        if ((list[i].t === 'word' || list[i].t === 'ident') && list[i + 1]?.v === '.' && (list[i + 2]?.t === 'word' || list[i + 2]?.t === 'ident')) {
            const name = list[i].v.replace(/^[[`"]|[\]`"]$/g, '').toUpperCase();
            const before = upper(list[prevSig(list, i - 1)]);
            const known = (dialect === 'sqlserver' && name === 'DBO') || (dialect === 'postgresql' && name === 'PUBLIC');
            const threePart = list[i + 3]?.v === '.' && (list[i + 4]?.t === 'word' || list[i + 4]?.t === 'ident');
            // ON sales.T (col) / ON sales.T AFTER INSERT is a table; JOIN … ON c.Id = … is an alias's column
            const after = upper(list[nextSig(list, i + (threePart ? 5 : 3))]) || list[nextSig(list, i + (threePart ? 5 : 3))]?.v;
            const onTable = before !== 'ON' || ['(', 'AFTER', 'FOR', 'INSTEAD', 'WITH'].includes(after || '');
            const tableContext = SCHEMA_CONTEXT.has(before) && onTable;
            if (!SQLITE_SCHEMAS.has(name) && (known || tableContext)) {
                // database.schema.table: drop both
                if (threePart && tableContext) list.splice(i, 4);
                else list.splice(i, 2);
                note('Schema names (dbo., public., sales.) were dropped, since SQLite has no schemas.');
                continue;
            }
        }
        // OFFSET n ROWS FETCH NEXT m ROWS ONLY / FETCH FIRST m ROWS ONLY → LIMIT m OFFSET n
        if (w === 'FETCH') {
            const a = nextSig(list, i + 1);
            if (['NEXT', 'FIRST'].includes(upper(list[a]))) {
                const n = nextSig(list, a + 1);
                const rows = list[n]?.t === 'num' ? nextSig(list, n + 1) : n;
                const only = nextSig(list, rows + 1);
                if (['ROW', 'ROWS'].includes(upper(list[rows])) && upper(list[only]) === 'ONLY') {
                    const count = list[n]?.t === 'num' ? list[n].v : '1';
                    // An OFFSET before it moves after the LIMIT
                    const off = findOffset(list, i);
                    if (off) {
                        replace(list, i, only + 1, `LIMIT ${count} OFFSET ${off.value}`);
                        replace(list, off.start, off.end, '');
                    } else replace(list, i, only + 1, `LIMIT ${count}`);
                    note('OFFSET … FETCH became LIMIT … OFFSET.');
                }
            }
        }
    }
}

/** The OFFSET n ROWS just before a FETCH at `at`: its range and value. */
function findOffset(list, at) {
    const j = prevSig(list, at - 1);
    if (!['ROW', 'ROWS'].includes(upper(list[j]))) return null;
    const value = prevSig(list, j - 1);
    const off = prevSig(list, value - 1);
    if (upper(list[off]) !== 'OFFSET') return null;
    return { start: off, end: j + 1, value: list[value].v };
}

function sqlServer(list, note, options = {}) {
    tsqlNames(list, note, options);
    compoundAssignments(list, note);
    /** Tokens [a, b) translated on their own (the inside of CAST(…), CONVERT(…) …), as text */
    const sub = (/** @type {number} */ a, /** @type {number} */ b) => {
        const inner = tokens(textOf(list, a, b));
        sqlServer(inner, note, options);
        return inner.map(x => x.v).join('');
    };
    /** @type {{ depth: number, limit: string }[]} TOP values waiting for the end of their query */
    const pending = [];
    let depth = 0;
    const flush = (/** @type {number} */ at, /** @type {number} */ level) => {
        while (pending.length && pending[pending.length - 1].depth === level) {
            const p = /** @type {any} */ (pending.pop());
            // Before trailing whitespace, so the LIMIT stays on the statement's last line
            let k = at;
            while (k > 0 && isSpace(list[k - 1])) k--;
            list.splice(k, 0, { t: 'p', v: ` LIMIT ${p.limit}` });
            at = k;
        }
        return at;
    };
    for (let i = 0; i < list.length; i++) {
        const t = list[i];
        const w = upper(t);
        if (t.t === 'p' && t.v === '(') depth++;
        else if (t.t === 'p' && t.v === ')') {
            const before = list.length;
            flush(i, depth);
            i += list.length - before;
            depth--;
        } else if (t.t === 'p' && t.v === ';') {
            const before = list.length;
            flush(i, depth);
            i += list.length - before;
        } else if (t.t === 'nl' && pending.length && depth === pending[pending.length - 1].depth) {
            // A new statement starting on the next line ends this one (no semicolon, as SSMS allows)
            const n = nextSig(list, i + 1);
            if (n > 0 && STATEMENT_WORDS.has(upper(list[n])) && lineStartsAt(list, n)) {
                const before = list.length;
                flush(i, depth);
                i += list.length - before;
            }
        }
        if (t.t === 'str' && /^N'/i.test(t.v)) {
            t.v = t.v.slice(1);
            note("N'text' became 'text'.");
        } else if (w === 'TOP') {
            const prev = upper(list[prevSig(list, i - 1)]);
            if (prev === 'SELECT' || prev === 'DISTINCT' || prev === 'ALL') {
                const n = nextSig(list, i + 1);
                let end;
                let limit;
                if (list[n]?.v === '(') {
                    const c = closing(list, n);
                    if (c < 0) continue;
                    limit = textOf(list, n + 1, c).trim();
                    end = c + 1;
                } else if (list[n]?.t === 'num') {
                    limit = list[n].v;
                    end = n + 1;
                } else continue;
                const percent = upper(list[nextSig(list, end)]) === 'PERCENT';
                if (percent && Number(limit) >= 100) {
                    // TOP 100 PERCENT (often in views) keeps every row
                    replace(list, i, nextSig(list, end) + 1, '');
                    note('TOP 100 PERCENT was dropped: it keeps every row.');
                    continue;
                }
                if (percent) continue; // the T-SQL engine keeps the first n percent itself
                const ties = nextSig(list, end);
                if (upper(list[ties]) === 'WITH' && upper(list[nextSig(list, ties + 1)]) === 'TIES') continue;
                replace(list, i, end, '');
                pending.push({ depth, limit });
                note('TOP n became LIMIT n.');
            }
        } else if (DATE_PART_FUNCS.has(w) && list[nextSig(list, i + 1)]?.v === '(') {
            // DATEADD(day, 1, x): the date part is a word, which SQLite would read as a column
            const open = nextSig(list, i + 1);
            const part = nextSig(list, open + 1);
            if (list[part]?.t === 'word' && list[nextSig(list, part + 1)]?.v === ',') {
                list[part] = { t: 'str', v: quote(list[part].v.toLowerCase()) };
                note('Date parts (day, month, …) in DATEADD, DATEDIFF and DATEPART became text.');
            }
        } else if ((w === 'CONVERT' || w === 'TRY_CONVERT') && list[nextSig(list, i + 1)]?.v === '(') {
            const open = nextSig(list, i + 1);
            const close = closing(list, open);
            if (close < 0) continue;
            const args = argsOf(list, open, close);
            if (args.length < 2) continue;
            const type = textOf(list, args[0][0], args[0][1]).trim();
            const expr = sub(args[1][0], args[1][1]).trim();
            const style = args[2] ? sub(args[2][0], args[2][1]).trim() : '';
            const value = w === 'TRY_CONVERT'
                ? `TSQL_TRY_CAST(${expr}, ${quote(type.toUpperCase())})`
                : style && /^(VAR)?CHAR|^N(VAR)?CHAR/i.test(type) ? `CONVERT_STYLE(${expr}, ${style})` : (tsqlCast(expr, type) ?? castFor(expr, type));
            replace(list, i, close + 1, value);
            note('CONVERT(type, value) became CAST(value AS type); a date style such as 103 still formats the date.');
        } else if (w === 'WITH' && list[nextSig(list, i + 1)]?.v === '(') {
            // Table hints: FROM t WITH (NOLOCK)
            const open = nextSig(list, i + 1);
            const close = closing(list, open);
            const inner = close > 0 ? textOf(list, open + 1, close).trim().toUpperCase() : '';
            if (/^(NOLOCK|READUNCOMMITTED|UPDLOCK|HOLDLOCK|ROWLOCK|PAGLOCK|TABLOCKX?|NOWAIT|READPAST|XLOCK|INDEX\s*\(.*\)|FORCESEEK)(\s*,\s*(NOLOCK|READUNCOMMITTED|UPDLOCK|HOLDLOCK|ROWLOCK|PAGLOCK|TABLOCKX?|NOWAIT|READPAST|XLOCK|INDEX\s*\(.*\)|FORCESEEK))*$/.test(inner)) {
                replace(list, i, close + 1, '');
                note('Table hints such as WITH (NOLOCK) were dropped.');
            }
        } else if (w === 'ISNULL' && list[nextSig(list, i + 1)]?.v === '(') {
            // ISNULL is an operator in SQLite (x ISNULL), so the function is IFNULL there
            t.v = 'IFNULL';
            note('ISNULL(a, b) became IFNULL(a, b).');
        } else if (w === 'PRINT' && lineStartsAt(list, i)) {
            list[i] = { t: 'word', v: 'SELECT' };
            note('PRINT became SELECT, so the text shows as a result.');
        } else if (w === 'CAST' && list[nextSig(list, i + 1)]?.v === '(') {
            const open = nextSig(list, i + 1);
            const close = closing(list, open);
            if (close < 0) continue;
            const as = lastWordAt(list, open + 1, close, 'AS');
            if (as < 0) continue;
            const type = textOf(list, as + 1, close).trim();
            const value = tsqlCast(sub(open + 1, as).trim(), type);
            if (value === null) continue;
            replace(list, i, close + 1, value);
            note('CAST(… AS type) uses the SQLite type that keeps the value (dates stay dates, text is cut to its length).');
        } else if (w === 'TRY_CAST' && list[nextSig(list, i + 1)]?.v === '(') {
            const open = nextSig(list, i + 1);
            const close = closing(list, open);
            const as = close > 0 ? lastWordAt(list, open + 1, close, 'AS') : -1;
            if (as < 0) continue;
            replace(list, i, close + 1, `TSQL_TRY_CAST(${sub(open + 1, as).trim()}, ${quote(textOf(list, as + 1, close).trim().toUpperCase())})`);
            note('TRY_CAST and TRY_CONVERT give NULL when the value can\'t be converted, as in SQL Server.');
        } else if (w === 'STRING_AGG' && list[nextSig(list, i + 1)]?.v === '(') {
            // STRING_AGG(x, ', ') WITHIN GROUP (ORDER BY y) → string_agg(x, ', ' ORDER BY y)
            const open = nextSig(list, i + 1);
            const close = closing(list, open);
            const within = close > 0 ? nextSig(list, close + 1) : -1;
            if (within < 0 || upper(list[within]) !== 'WITHIN') continue;
            const group = nextSig(list, within + 1);
            const gOpen = nextSig(list, group + 1);
            const gClose = list[gOpen]?.v === '(' ? closing(list, gOpen) : -1;
            if (upper(list[group]) !== 'GROUP' || gClose < 0) continue;
            const order = sub(gOpen + 1, gClose).trim();
            replace(list, i, gClose + 1, `string_agg(${sub(open + 1, close).trim()} ${order})`);
            note('STRING_AGG(…) WITHIN GROUP (ORDER BY …) became string_agg(… ORDER BY …).');
        } else if ((w === 'STRING_SPLIT' || w === 'OPENJSON') && list[nextSig(list, i + 1)]?.v === '(') {
            const open = nextSig(list, i + 1);
            const close = closing(list, open);
            if (close < 0) continue;
            const args = argsOf(list, open, close).map(([a, b]) => sub(a, b).trim());
            if (w === 'STRING_SPLIT') {
                replace(list, i, close + 1, args[2] && args[2] !== '0'
                    ? `(SELECT value, key + 1 AS ordinal FROM json_each(TSQL_SPLIT(${args[0]}, ${args[1]})))`
                    : `json_each(TSQL_SPLIT(${args[0]}, ${args[1] ?? "' '"}))`);
                note('STRING_SPLIT(text, separator) became a json_each list with a value column.');
            } else {
                replace(list, i, close + 1, `(SELECT key, value, CASE type WHEN 'null' THEN 0 WHEN 'text' THEN 1 WHEN 'integer' THEN 2 WHEN 'real' THEN 2 WHEN 'true' THEN 3 WHEN 'false' THEN 3 WHEN 'array' THEN 4 ELSE 5 END AS type FROM json_each(${args.join(', ')}))`);
                note('OPENJSON(json) became a json_each list with key, value and type columns.');
            }
            // APPLY over a list function is a join in SQLite
            const p = prevSig(list, i - 1);
            const q = prevSig(list, p - 1);
            if (upper(list[p]) === 'APPLY' && (upper(list[q]) === 'CROSS' || upper(list[q]) === 'OUTER')) {
                replace(list, q, p + 1, upper(list[q]) === 'CROSS' ? 'JOIN' : 'LEFT JOIN');
            }
        } else if (w === 'OPTION' && list[nextSig(list, i + 1)]?.v === '(') {
            const open = nextSig(list, i + 1);
            const close = closing(list, open);
            if (close < 0) continue;
            replace(list, i, close + 1, '');
            note('Query hints OPTION (…) were dropped.');
        } else if (w === 'COLLATE') {
            const n = nextSig(list, i + 1);
            if (n < 0 || (list[n].t !== 'word' && list[n].t !== 'ident')) continue;
            const name = list[n].v.replace(/^[["]|[\]"]$/g, '');
            if (/^(NOCASE|BINARY|RTRIM)$/i.test(name)) continue;
            list[n] = { t: 'word', v: /_CI(_|$)/i.test(name) ? 'NOCASE' : 'BINARY' };
            note('SQL Server collations became NOCASE (case-insensitive) or BINARY.');
        } else if (FUNCTION_NAMES[w] && list[nextSig(list, i + 1)]?.v === '(') {
            const target = FUNCTION_NAMES[w];
            if (w === 'LOG') {
                // LOG(x) is the natural log; LOG(x, base) has the base second
                const open = nextSig(list, i + 1);
                const close = closing(list, open);
                if (close < 0) continue;
                const args = argsOf(list, open, close).map(([a, b]) => sub(a, b).trim());
                replace(list, i, close + 1, args.length > 1 ? `log(${args[1]}, ${args[0]})` : `ln(${args[0]})`);
            } else t.v = target;
        } else if (SESSION_WORDS[w] && list[nextSig(list, i + 1)]?.v !== '(' && list[prevSig(list, i - 1)]?.v !== '.') {
            list[i] = { t: 'str', v: quote(SESSION_WORDS[w]) };
        }
    }
    flush(list.length, 0);
    plusChains(list, note);
}

/** The last word `word` at depth 0 between from and to (exclusive), or -1. */
function lastWordAt(list, from, to, word) {
    let depth = 0;
    let found = -1;
    for (let k = from; k < to; k++) {
        const v = list[k].t === 'p' ? list[k].v : '';
        if (v === '(') depth++;
        else if (v === ')') depth--;
        else if (depth === 0 && upper(list[k]) === word) found = k;
    }
    return found;
}

/**
 * CAST(expr AS type) as SQL Server means it, in SQLite, or null to leave it:
 * dates stay text dates, (N)VARCHAR(n) is cut to n characters, DECIMAL(p, s)
 * is rounded to s places and UNIQUEIDENTIFIER stays text.
 */
export function tsqlCast(expr, type) {
    const t = String(type).trim().toUpperCase().replace(/\s+/g, ' ');
    const m = /^([A-Z_0-9 ]+?)\s*(?:\(\s*([^)]*)\))?$/.exec(t);
    if (!m) return null;
    const name = m[1].trim();
    const args = (m[2] || '').split(',').map(x => x.trim());
    if (['DATE', 'DATETIME', 'DATETIME2', 'SMALLDATETIME', 'DATETIMEOFFSET', 'TIME'].includes(name)) {
        if (name === 'DATE') return `date(${expr})`;
        if (name === 'TIME') return `time(${expr})`;
        return `datetime(${expr})`;
    }
    if (['CHAR', 'VARCHAR', 'NCHAR', 'NVARCHAR'].includes(name)) {
        // VARCHAR without a length is 30 characters in CAST, as in SQL Server
        const n = args[0] === 'MAX' ? 0 : Number(args[0] || 30);
        return n > 0 ? `substr(CAST(${expr} AS TEXT), 1, ${n})` : `CAST(${expr} AS TEXT)`;
    }
    if (['TEXT', 'NTEXT', 'UNIQUEIDENTIFIER', 'SYSNAME', 'XML', 'SQL_VARIANT'].includes(name)) return `CAST(${expr} AS TEXT)`;
    if (['INT', 'BIGINT', 'SMALLINT', 'TINYINT'].includes(name)) return `CAST(${expr} AS INTEGER)`;
    if (name === 'BIT') return `(CASE WHEN (${expr}) IS NULL THEN NULL WHEN CAST(${expr} AS REAL) <> 0 OR upper(CAST(${expr} AS TEXT)) = 'TRUE' THEN 1 ELSE 0 END)`;
    if (['DECIMAL', 'NUMERIC', 'MONEY', 'SMALLMONEY'].includes(name)) {
        const scale = name.endsWith('MONEY') ? 4 : Number(args[1] || 0);
        return `round(CAST(${expr} AS REAL), ${scale})`;
    }
    if (['FLOAT', 'REAL'].includes(name)) return `CAST(${expr} AS REAL)`;
    if (['BINARY', 'VARBINARY', 'IMAGE'].includes(name)) return `CAST(${expr} AS BLOB)`;
    return null;
}

// T-SQL functions SQLite has under another name
const FUNCTION_NAMES = /** @type {Record<string, string>} */ ({
    FORMAT: 'TSQL_FORMAT', LOG: 'ln', ATN2: 'atan2', COUNT_BIG: 'count', JSON_VALUE: 'json_extract', JSON_QUERY: 'json_extract',
    ISJSON: 'json_valid', CEILING: 'ceil', SUBSTRING: 'TSQL_SUBSTRING'
});
// Session values that are words, not functions
const SESSION_WORDS = /** @type {Record<string, string>} */ ({ SYSTEM_USER: 'sa', SESSION_USER: 'dbo', CURRENT_USER: 'dbo' });
// @@ variables SQL Lab knows; each becomes a parameter the engine binds
export const SYSTEM_VARIABLES = new Set(['ROWCOUNT', 'IDENTITY', 'ERROR', 'TRANCOUNT', 'VERSION', 'SERVERNAME', 'SERVICENAME', 'SPID',
    'FETCH_STATUS', 'DATEFIRST', 'LANGUAGE', 'MAX_PRECISION', 'NESTLEVEL', 'LOCK_TIMEOUT', 'TEXTSIZE', 'OPTIONS', 'PROCID', 'DBTS', 'MICROSOFTVERSION']);
// Functions whose value the engine knows (the error being handled, the last identity)
const ENGINE_FUNCTIONS = /** @type {Record<string, string>} */ ({
    SCOPE_IDENTITY: '@__identity', ERROR_MESSAGE: '@__error_message', ERROR_NUMBER: '@__error_number', ERROR_LINE: '@__error_line',
    ERROR_SEVERITY: '@__error_severity', ERROR_STATE: '@__error_state', ERROR_PROCEDURE: '@__error_procedure', XACT_STATE: '@__xact_state',
    DB_NAME: '@__db_name'
});

/**
 * Names only T-SQL has: #temp tables, table variables, system variables (ROWCOUNT …) and the
 * functions the engine answers (SCOPE_IDENTITY(), ERROR_MESSAGE() …).
 */
function tsqlNames(list, note, options) {
    const tableVariables = options.tableVariables || new Set();
    for (let i = 0; i < list.length; i++) {
        const t = list[i];
        if (t.t !== 'word') continue;
        if (t.v.startsWith('#')) {
            list[i] = { t: 'ident', v: `"${t.v.replace(/"/g, '""')}"` };
            // CREATE TABLE #t → CREATE TEMP TABLE "#t"
            const a = prevSig(list, i - 1);
            const b = prevSig(list, a - 1);
            if (upper(list[a]) === 'TABLE' && upper(list[b]) === 'CREATE') list[a] = { t: 'word', v: 'TEMP TABLE' };
            note('Temp tables (#name) became SQLite temporary tables, kept until the database is closed.');
        } else if (t.v.startsWith('@@')) {
            const name = t.v.slice(2).toUpperCase();
            if (SYSTEM_VARIABLES.has(name)) t.v = `@__${name.toLowerCase()}`;
        } else if (t.v.startsWith('@') && tableVariables.has(t.v.toLowerCase())) {
            // A Map gives each table variable's SQLite name (procedures nest their own)
            const mapped = tableVariables instanceof Map ? tableVariables.get(t.v.toLowerCase()) : '';
            list[i] = { t: 'ident', v: mapped || `"${t.v.replace(/"/g, '""')}"` };
        } else if (ENGINE_FUNCTIONS[t.v.toUpperCase()]) {
            const open = nextSig(list, i + 1);
            const close = list[open]?.v === '(' ? nextSig(list, open + 1) : -1;
            if (close > 0 && list[close].v === ')') replace(list, i, close + 1, ENGINE_FUNCTIONS[t.v.toUpperCase()]);
        }
    }
}

/** UPDATE … SET n += 1 → SET n = n + 1 (and -=, *=, /=, %=). */
function compoundAssignments(list, note) {
    for (let i = 0; i < list.length - 1; i++) {
        const t = list[i];
        if (t.t !== 'p' || !/^[+\-*/%]$/.test(t.v) || list[i + 1].v !== '=') continue;
        const target = prevSig(list, i - 1);
        if (target < 0 || (list[target].t !== 'word' && list[target].t !== 'ident')) continue;
        // The whole name: t.col or [col]
        let start = target;
        while (start >= 2 && list[start - 1].v === '.' && (list[start - 2].t === 'word' || list[start - 2].t === 'ident')) start -= 2;
        const name = textOf(list, start, target + 1);
        list.splice(i, 2, { t: 'p', v: '=' }, { t: 'ws', v: ' ' }, { t: 'word', v: name }, { t: 'ws', v: ' ' }, { t: 'p', v: t.v });
        note('n += 1 became n = n + 1.');
    }
}

// Words that end an operand chain (anything else that is a word is a name or a function)
const CHAIN_BREAKS = new Set(['SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'AS', 'ON', 'IS', 'IN', 'LIKE', 'BETWEEN', 'WHEN', 'THEN',
    'ELSE', 'END', 'CASE', 'SET', 'VALUES', 'INTO', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'GROUP', 'BY', 'ORDER',
    'HAVING', 'UNION', 'ALL', 'DISTINCT', 'TOP', 'LIMIT', 'OFFSET', 'ESCAPE', 'ASC', 'DESC', 'EXISTS', 'RETURNING', 'COLLATE', 'OVER',
    'PARTITION', 'ROWS', 'RANGE', 'PRECEDING', 'FOLLOWING', 'UNBOUNDED', 'CURRENT', 'ROW', 'WITH', 'UPDATE', 'DELETE', 'INSERT', 'CREATE',
    'TABLE', 'VIEW', 'DROP', 'ALTER', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'DEFAULT', 'CHECK', 'CONSTRAINT', 'UNIQUE', 'INDEX',
    'IF', 'PRINT', 'DECLARE', 'RETURN', 'EXCEPT', 'INTERSECT', 'USING', 'NATURAL', 'FETCH', 'NEXT', 'ONLY', 'FILTER', 'WITHIN', 'NULLS',
    'FIRST', 'LAST', 'GLOB', 'REGEXP', 'MATCH', 'APPLY', 'PIVOT', 'UNPIVOT', 'OUTPUT', 'MERGE', 'MATCHED', 'TARGET', 'SOURCE', 'WHILE', 'BEGIN']);

/**
 * a + b in T-SQL adds numbers and joins text, depending on the values'
 * types. Each chain of + becomes TSQL_ADD(a, b), which looks at the values
 * when the query runs (numbers add, text joins, a date plus a number adds days).
 */
function plusChains(list, note) {
    /** @type {{ kind: 'operand' | 'op' | 'break', start: number, end: number, v?: string, literal?: boolean, dot?: boolean }[]} */
    const items = [];
    // Groups at this level are operands; their insides are rewritten first (from the end, so indexes stay valid)
    for (let i = 0; i < list.length; i++) {
        const t = list[i];
        if (isSpace(t)) continue;
        if (t.t === 'p' && t.v === '(') {
            const close = closing(list, i);
            if (close < 0) { items.push({ kind: 'break', start: i, end: i + 1 }); continue; }
            const inner = list.slice(i + 1, close);
            plusChains(inner, note);
            list.splice(i + 1, close - i - 1, ...inner);
            const newClose = i + 1 + inner.length;
            // A function call: the name before it is part of the operand
            const last = items[items.length - 1];
            if (last && last.kind === 'operand' && last.end === prevSig(list, i - 1) + 1 && (list[last.end - 1].t === 'word' || list[last.end - 1].t === 'ident') && !CHAIN_BREAKS.has(upper(list[last.end - 1]))) last.end = newClose + 1;
            else items.push({ kind: 'operand', start: i, end: newClose + 1 });
            i = newClose;
            continue;
        }
        if (upper(t) === 'CASE') {
            // CASE … END is one operand
            let depth = 0;
            let end = -1;
            for (let k = i; k < list.length; k++) {
                const u = upper(list[k]);
                if (u === 'CASE') depth++;
                else if (u === 'END' && --depth === 0) { end = k; break; }
            }
            if (end < 0) { items.push({ kind: 'break', start: i, end: i + 1 }); continue; }
            const inner = list.slice(i + 1, end);
            plusChains(inner, note);
            list.splice(i + 1, end - i - 1, ...inner);
            const newEnd = i + 1 + inner.length;
            items.push({ kind: 'operand', start: i, end: newEnd + 1 });
            i = newEnd;
            continue;
        }
        if (t.t === 'p' && (t.v === '+' || t.v === '-' || t.v === '*' || t.v === '/' || t.v === '%')) {
            items.push({ kind: 'op', start: i, end: i + 1, v: t.v });
            continue;
        }
        if (t.t === 'p' && t.v === '.') {
            const last = items[items.length - 1];
            if (last && last.kind === 'operand') { last.end = i + 1; last.dot = true; continue; }
        }
        const isOperand = t.t === 'num' || t.t === 'str' || t.t === 'ident' || (t.t === 'word' && !CHAIN_BREAKS.has(upper(t))) || (t.t === 'p' && t.v.length > 2);
        if (isOperand) {
            const last = items[items.length - 1];
            if (last && last.kind === 'operand' && last.dot) { last.end = i + 1; last.dot = false; continue; }
            items.push({ kind: 'operand', start: i, end: i + 1, literal: t.t === 'num' });
            continue;
        }
        items.push({ kind: 'break', start: i, end: i + 1 });
    }
    // Chains: operand (op operand)*, a unary sign belonging to the operand after it.
    // Terms are split at + and -; inside a term, factors at *, / and %.
    /** @type {{ start: number, end: number, terms: { op: string, factors: { op: string, start: number, end: number, literal: boolean }[] }[] }[]} */
    const chains = [];
    let k = 0;
    while (k < items.length) {
        const signStart = items[k].kind === 'op' && (items[k].v === '-' || items[k].v === '+') && items[k + 1]?.kind === 'operand';
        if (items[k].kind !== 'operand' && !signStart) { k++; continue; }
        /** @type {{ op: string, factors: { op: string, start: number, end: number, literal: boolean }[] }[]} */
        const terms = [{ op: '', factors: [] }];
        let pendingOp = '';
        let factorStart = -1;
        let expectOperand = true;
        let j = k;
        let lastEnd = items[k].end;
        for (; j < items.length; j++) {
            const it = items[j];
            if (expectOperand) {
                if (it.kind === 'op' && (it.v === '-' || it.v === '+')) {
                    if (factorStart < 0) factorStart = it.start;
                    continue; // unary sign
                }
                if (it.kind !== 'operand') break;
                terms[terms.length - 1].factors.push({ op: pendingOp, start: factorStart >= 0 ? factorStart : it.start, end: it.end, literal: !!it.literal });
                factorStart = -1;
                lastEnd = it.end;
                expectOperand = false;
                continue;
            }
            if (it.kind === 'op') {
                if (it.v === '+' || it.v === '-') {
                    terms.push({ op: it.v, factors: [] });
                    pendingOp = '';
                } else pendingOp = it.v;
                expectOperand = true;
                continue;
            }
            break;
        }
        // A chain that ended on an operator isn't complete: leave it as written
        if (expectOperand && terms[terms.length - 1].factors.length === 0) {
            k = Math.max(j, k + 1);
            continue;
        }
        const hasPlus = terms.some(t => t.op === '+');
        const hasDivide = terms.some(t => t.factors.some(f => f.op === '/' || f.op === '%'));
        const allLiteral = terms.every(t => t.factors.every(f => f.literal));
        if ((hasPlus && !allLiteral) || hasDivide) chains.push({ start: terms[0].factors[0].start, end: lastEnd, terms });
        k = Math.max(j, k + 1);
    }
    for (const chain of chains.reverse()) {
        const termText = (/** @type {{ op: string, start: number, end: number }[]} */ factors) => {
            let acc = textOf(list, factors[0].start, factors[0].end);
            for (const f of factors.slice(1)) {
                const v = textOf(list, f.start, f.end);
                // SQLite gives NULL for x / 0; SQL Server stops with an error. SQLite still decides
                // integer or decimal division from the values' types.
                acc = f.op === '*' || (/^\s*\d+(\.\d+)?\s*$/.test(v) && Number(v) !== 0) ? `${acc} ${f.op} ${v}` : `(CASE WHEN (${v}) = 0 THEN TSQL_RAISE('Divide by zero error encountered.') ELSE ${acc} ${f.op} ${v} END)`;
            }
            return acc;
        };
        let acc = termText(chain.terms[0].factors);
        for (const term of chain.terms.slice(1)) {
            const v = termText(term.factors);
            acc = term.op === '+' ? `TSQL_ADD(${acc}, ${v})` : `${acc} - ${v}`;
        }
        replace(list, chain.start, chain.end, acc);
        if (chain.terms.some(t => t.op === '+')) note('a + b adds numbers and joins text, as in SQL Server (TSQL_ADD).');
        if (chain.terms.some(t => t.factors.some(f => f.op === '/' || f.op === '%'))) note('Division by zero is an error, as in SQL Server.');
    }
}

const STATEMENT_WORDS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'WITH', 'CREATE', 'DROP', 'ALTER', 'PRINT', 'TRUNCATE', 'MERGE', 'EXEC', 'EXECUTE', 'DECLARE', 'SET', 'BEGIN', 'COMMIT', 'ROLLBACK']);
/** Whether token `i` is the first thing on its line. */
function lineStartsAt(list, i) {
    for (let k = i - 1; k >= 0; k--) {
        if (list[k].t === 'nl') return true;
        if (list[k].t !== 'ws') return false;
    }
    return true;
}

function postgres(list, note) {
    for (let i = 0; i < list.length; i++) {
        const t = list[i];
        const w = upper(t);
        if (t.t === 'p' && t.v === '::') {
            // value::type → CAST(value AS type); the value is the token (or bracketed group, or call) before
            let start = prevSig(list, i - 1);
            if (start < 0) continue;
            if (list[start].v === ')') {
                let depth = 0;
                let k = start;
                for (; k >= 0; k--) {
                    if (list[k].v === ')') depth++;
                    else if (list[k].v === '(' && --depth === 0) break;
                }
                if (k < 0) continue;
                start = k;
                if (list[k - 1]?.t === 'word') start = k - 1;
            } else if (list[start - 1]?.v === '.' && (list[start - 2]?.t === 'word' || list[start - 2]?.t === 'ident')) start -= 2;
            const typeStart = nextSig(list, i + 1);
            if (list[typeStart]?.t !== 'word') continue;
            let typeEnd = typeStart + 1;
            // double precision, character varying, varchar(10), timestamp with time zone, int[]
            while (typeEnd < list.length) {
                const n = nextSig(list, typeEnd);
                const nw = upper(list[n]);
                if (list[n]?.v === '(' && list[n] && n === typeEnd) {
                    const c = closing(list, n);
                    if (c < 0) break;
                    typeEnd = c + 1;
                } else if (['PRECISION', 'VARYING', 'ZONE'].includes(nw) || (nw === 'WITH' && upper(list[nextSig(list, n + 1)]) === 'TIME') || (nw === 'WITHOUT' && upper(list[nextSig(list, n + 1)]) === 'TIME') || (nw === 'TIME' && ['WITH', 'WITHOUT'].includes(upper(list[prevSig(list, n - 1)])))) {
                    typeEnd = n + 1;
                } else break;
            }
            const expr = textOf(list, start, i).trim();
            const type = textOf(list, typeStart, typeEnd);
            replace(list, start, typeEnd, castFor(expr, type));
            i = start;
            note('value::type casts became CAST(value AS type).');
        } else if (w === 'ILIKE') {
            t.v = 'LIKE';
            note('ILIKE became LIKE (in SQLite LIKE already ignores case for A to Z).');
        } else if ((w === 'SERIAL' || w === 'BIGSERIAL' || w === 'SMALLSERIAL') && isColumnType(list, i)) {
            t.v = 'INTEGER';
            note('SERIAL became INTEGER (an INTEGER PRIMARY KEY numbers new rows by itself).');
        } else if (w === 'EXTRACT' && list[nextSig(list, i + 1)]?.v === '(') {
            // EXTRACT(year FROM d) → EXTRACT('year', d)
            const open = nextSig(list, i + 1);
            const close = closing(list, open);
            const field = nextSig(list, open + 1);
            const from = nextSig(list, field + 1);
            if (close > 0 && list[field]?.t === 'word' && upper(list[from]) === 'FROM') {
                replace(list, open, close + 1, `(${quote(list[field].v.toLowerCase())}, ${textOf(list, from + 1, close).trim()})`);
                note('EXTRACT(field FROM value) runs through a function of the same name.');
            }
        } else if (w === 'INTERVAL' && list[nextSig(list, i + 1)]?.t === 'str') {
            // d + INTERVAL '1 day' → datetime(d, '+1 day') when the left side is a plain value
            const s = nextSig(list, i + 1);
            const op = prevSig(list, i - 1);
            const left = prevSig(list, op - 1);
            if ((list[op]?.v === '+' || list[op]?.v === '-') && left >= 0 && list[left].t !== 'p') {
                const amount = list[s].v.slice(1, -1).trim();
                const sign = list[op].v === '-' ? (amount.startsWith('-') ? amount.slice(1) : `-${amount}`) : (amount.startsWith('-') ? amount : `+${amount}`);
                replace(list, left, s + 1, `datetime(${list[left].v}, ${quote(sign.replace(/s?$/, 's').replace(/ss$/, 's'))})`);
                i = left;
                note("value + INTERVAL '1 day' became datetime(value, '+1 days').");
            }
        }
    }
}

function mysql(list, note) {
    const first = nextSig(list, 0);
    for (let i = 0; i < list.length; i++) {
        const t = list[i];
        const w = upper(t);
        const statementStart = i === first || (lineStartsAt(list, i) && (list[prevSig(list, i - 1)]?.v === ';' || prevSig(list, i - 1) < 0));
        if (w === 'SHOW' && statementStart) {
            const a = nextSig(list, i + 1);
            const aw = upper(list[a]);
            if (aw === 'TABLES') {
                replace(list, i, a + 1, "SELECT name AS Tables FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name");
                note('SHOW TABLES lists the tables from sqlite_schema.');
            } else if ((aw === 'COLUMNS' || aw === 'FIELDS') && upper(list[nextSig(list, a + 1)]) === 'FROM') {
                const name = nextSig(list, nextSig(list, a + 1) + 1);
                if (name > 0) {
                    replace(list, i, name + 1, describe(list[name].v));
                    note('SHOW COLUMNS and DESCRIBE list the columns from pragma_table_info.');
                }
            } else if (aw === 'DATABASES') {
                replace(list, i, a + 1, "SELECT name AS `Database` FROM pragma_database_list");
                note('SHOW DATABASES lists the open database.');
            }
        } else if ((w === 'DESCRIBE' || w === 'DESC') && statementStart) {
            const name = nextSig(list, i + 1);
            if (name > 0 && (list[name].t === 'word' || list[name].t === 'ident')) {
                replace(list, i, name + 1, describe(list[name].v));
                note('SHOW COLUMNS and DESCRIBE list the columns from pragma_table_info.');
            }
        } else if (w === 'AUTO_INCREMENT' || w === 'AUTOINCREMENT') {
            // INT … AUTO_INCREMENT PRIMARY KEY → INTEGER … PRIMARY KEY
            if (w === 'AUTO_INCREMENT') {
                replace(list, i, i + 1, '');
                for (let k = i - 1; k >= 0 && list[k].v !== ',' && list[k].v !== '('; k--) {
                    if (/^(INT|BIGINT|SMALLINT|MEDIUMINT|TINYINT)$/i.test(list[k].v)) {
                        list[k].v = 'INTEGER';
                        break;
                    }
                }
                note('AUTO_INCREMENT was dropped (an INTEGER PRIMARY KEY numbers new rows by itself).');
            }
        } else if (w === 'UNSIGNED' && isColumnType(list, prevSig(list, i - 1))) {
            replace(list, i, i + 1, '');
            note('UNSIGNED was dropped.');
        } else if ((w === 'ENGINE' || w === 'CHARSET' || w === 'COLLATE' || w === 'DEFAULT' && upper(list[nextSig(list, i + 1)]) === 'CHARSET') && list[prevSig(list, i - 1)]?.v === ')' && w !== 'COLLATE') {
            // Table options after CREATE TABLE (…): ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 …
            let end = i;
            while (end < list.length && list[end].v !== ';' && list[end].t !== 'nl') end++;
            replace(list, i, end, '');
            note('Table options (ENGINE, CHARSET, …) were dropped.');
        } else if (['DATE_ADD', 'DATE_SUB', 'ADDDATE', 'SUBDATE'].includes(w) && list[nextSig(list, i + 1)]?.v === '(') {
            // DATE_ADD(d, INTERVAL 1 DAY) → DATE_ADD(d, 1, 'day')
            const open = nextSig(list, i + 1);
            const close = closing(list, open);
            if (close < 0) continue;
            const args = argsOf(list, open, close);
            if (args.length !== 2) continue;
            const iv = nextSig(list, args[1][0]);
            if (upper(list[iv]) !== 'INTERVAL') continue;
            const unit = prevSig(list, args[1][1] - 1);
            const amount = textOf(list, iv + 1, unit).trim();
            replace(list, args[1][0], args[1][1], ` ${amount}, ${quote(list[unit].v.toLowerCase())}`);
            note('INTERVAL n unit in DATE_ADD and DATE_SUB became n, \'unit\'.');
        }
    }
}

const describe = (/** @type {string} */ name) => `SELECT name AS Field, type AS Type, CASE "notnull" WHEN 1 THEN 'NO' ELSE 'YES' END AS "Null", CASE WHEN pk > 0 THEN 'PRI' ELSE '' END AS "Key", dflt_value AS "Default" FROM pragma_table_info(${quote(name.replace(/^[[`"]|[\]`"]$/g, ''))})`;

/** Whether the word at `i` is a column type in a CREATE TABLE (follows a column name). */
function isColumnType(list, i) {
    const p = prevSig(list, i - 1);
    return p >= 0 && (list[p].t === 'word' || list[p].t === 'ident') && !['AS', 'SELECT'].includes(upper(list[p]));
}
