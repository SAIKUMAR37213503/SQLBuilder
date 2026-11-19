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
 * @returns {{ sql: string, changes: { message: string, count: number }[] }}
 */
export function translateForSqlite(sql, dialect) {
    const source = String(sql ?? '');
    if (dialect === 'sqlite' || !isLabDialect(dialect)) return { sql: source, changes: [] };
    const list = tokens(dialect === 'sqlserver' ? replaceBatchSeparators(source) : source);
    /** @type {Map<string, number>} */
    const counts = new Map();
    const note = (/** @type {string} */ message) => counts.set(message, (counts.get(message) || 0) + 1);

    if (dialect === 'sqlserver') sqlServer(list, note);
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
            if (!SQLITE_SCHEMAS.has(name) && (known || (SCHEMA_CONTEXT.has(before) && !threePart))) {
                // database.schema.table: drop both
                if (threePart && SCHEMA_CONTEXT.has(before)) list.splice(i, 4);
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

function sqlServer(list, note) {
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
                if (percent) continue; // left for SQLite to report
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
            const expr = textOf(list, args[1][0], args[1][1]).trim();
            const style = args[2] ? textOf(list, args[2][0], args[2][1]).trim() : '';
            const value = style && /^(VAR)?CHAR|^N(VAR)?CHAR/i.test(type) ? `CONVERT_STYLE(${expr}, ${style})` : castFor(expr, type);
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
        } else if (t.t === 'p' && t.v === '+') {
            // 'a' + b: string concatenation is || in SQLite
            const a = list[prevSig(list, i - 1)];
            const b = list[nextSig(list, i + 1)];
            if (a?.t === 'str' || b?.t === 'str') {
                t.v = '||';
                note("+ between text became || ('a' + 'b').");
            }
        }
    }
    flush(list.length, 0);
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
