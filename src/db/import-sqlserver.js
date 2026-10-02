// Adapts a SQL Server script (as SSMS's Generate Scripts writes it, "Schema
// and data") so SQLite can run it. Used only when the person importing asks
// for it, and every kind of change is listed in the import preview, with how
// often and where it first happens: nothing is rewritten silently.
//
// What changes:
// - statements end with ";" (SSMS separates them with line breaks and GO);
// - dbo. and other schema names are dropped (SQLite has no schemas);
// - N'text' becomes 'text', 0x1F2E becomes X'1F2E';
// - CAST(… AS datetime) and the other date types keep just the value, since
//   SQLite stores dates as text and casting would turn them into numbers;
// - IDENTITY is dropped (an int becomes INTEGER, which numbers new rows when
//   it is the primary key), as are CLUSTERED, (MAX), ON [PRIMARY],
//   WITH (PAD_INDEX = …), INCLUDE (…), COLLATE and other storage options;
// - statements SQLite has no equivalent for are left out: SET options, USE,
//   EXEC, IF blocks, views, procedures, functions, triggers, and ALTER TABLE
//   (SQLite can't add constraints to an existing table, so foreign keys,
//   defaults and checks added that way aren't created).
//
// Line breaks are kept exactly, so a line number in an error or in the
// preview is the line in the original file.

const KEEP_FIRST = new Set(['CREATE', 'INSERT', 'UPDATE', 'DELETE', 'SELECT', 'BEGIN', 'COMMIT', 'ROLLBACK', 'WITH', 'DROP', 'VALUES', 'REPLACE']);
// Words that start a new statement when they begin a line (outside brackets)
const STARTS = new Set(['INSERT', 'CREATE', 'ALTER', 'SET', 'DROP', 'EXEC', 'EXECUTE', 'USE', 'PRINT', 'DECLARE', 'IF', 'UPDATE', 'DELETE', 'TRUNCATE', 'GRANT', 'DENY', 'REVOKE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'RAISERROR', 'THROW']);
// CREATE … that is a whole batch of T-SQL code, up to the next GO
const CODE_OBJECTS = new Set(['VIEW', 'PROC', 'PROCEDURE', 'FUNCTION', 'TRIGGER']);
const INDEX_OPTIONS = new Set(['PAD_INDEX', 'STATISTICS_NORECOMPUTE', 'SORT_IN_TEMPDB', 'IGNORE_DUP_KEY', 'DROP_EXISTING', 'ONLINE', 'ALLOW_ROW_LOCKS', 'ALLOW_PAGE_LOCKS', 'OPTIMIZE_FOR_SEQUENTIAL_KEY', 'FILLFACTOR', 'DATA_COMPRESSION', 'XML_COMPRESSION', 'MAXDOP', 'RESUMABLE', 'STATISTICS_INCREMENTAL', 'MEMORY_OPTIMIZED', 'DURABILITY', 'SYSTEM_VERSIONING', 'LEDGER']);
const DATE_TYPES = new Set(['DATE', 'DATETIME', 'DATETIME2', 'SMALLDATETIME', 'TIME', 'DATETIMEOFFSET']);
const INT_TYPES = new Set(['INT', 'BIGINT', 'SMALLINT', 'TINYINT']);
const TYPE_NAMES = new Set(['INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'BIT', 'DECIMAL', 'NUMERIC', 'MONEY', 'SMALLMONEY', 'FLOAT', 'REAL',
    'DATE', 'DATETIME', 'DATETIME2', 'SMALLDATETIME', 'TIME', 'DATETIMEOFFSET', 'CHAR', 'VARCHAR', 'NCHAR', 'NVARCHAR', 'TEXT', 'NTEXT',
    'BINARY', 'VARBINARY', 'IMAGE', 'UNIQUEIDENTIFIER', 'XML', 'SQL_VARIANT', 'HIERARCHYID', 'GEOGRAPHY', 'GEOMETRY', 'TIMESTAMP', 'ROWVERSION', 'SYSNAME']);
const DROPPED_WORDS = new Set(['CLUSTERED', 'NONCLUSTERED', 'ROWGUIDCOL', 'SPARSE', 'PERSISTED']);
// After these words, a two-part name is a table: Sales.Customer → Customer
const TABLE_BEFORE = new Set(['TABLE', 'INTO', 'INSERT', 'REFERENCES', 'UPDATE', 'FROM', 'JOIN']);

/**
 * @typedef {{ t: 'nl' | 'ws' | 'comment' | 'str' | 'nstr' | 'ident' | 'word' | 'num' | 'hex' | 'p', v: string, line: number, u?: string }} Token
 * @typedef {{ message: string, count: number, line: number }} Change
 */

/** Whether a script looks like SQL Server's (worth offering to adapt). */
export function looksLikeSqlServer(text) {
    const head = String(text).slice(0, 256 * 1024);
    return /^[ \t]*GO[ \t]*$/im.test(head)
        || /\[dbo\]\s*\.\s*\[/i.test(head)
        || /^\s*SET\s+(?:ANSI_NULLS|QUOTED_IDENTIFIER|IDENTITY_INSERT|NOCOUNT)\b/im.test(head)
        || /\bON\s+\[PRIMARY\]/i.test(head)
        || /\bIDENTITY\s*\(\s*\d+\s*,\s*\d+\s*\)/i.test(head);
}

const GO_LINE = /[ \t]*GO(?:[ \t]+\d+)?[ \t]*(?:--[^\n]*)?(?=\r?\n|$)/iy;

/**
 * @param {string} text a SQL Server script
 * @returns {{ text: string, changes: Change[] }}
 */
export function adaptSqlServerScript(text) {
    const adapter = createSqlServerAdapter();
    const { text: out } = adapter.push(String(text), true);
    return { text: out, changes: adapter.changes() };
}

/**
 * Adapts a script that arrives in parts (a large file is read a few MB at a
 * time). Each push adapts the complete statements at the start of the text
 * and says how much of it was used; the rest is pushed again with the next
 * part. The last push (final) adapts everything. Line numbers continue
 * across pushes.
 */
export function createSqlServerAdapter() {
    /** @type {Map<string, Change>} */
    const changes = new Map();
    const note = (/** @type {string} */ message, /** @type {number} */ line, count = 1) => {
        const c = changes.get(message);
        if (c) c.count += count;
        else changes.set(message, { message, count, line });
    };
    /** Table names seen per lower-cased name, to warn when two schemas share one */
    const tables = new Map();
    // Where the next push starts
    let nextLine = 1;
    let nextAtLineStart = true;

    /**
     * @param {string} src
     * @param {boolean} final no more text follows
     * @returns {{ text: string, consumed: number }} the adapted statements, and how many characters of src they were
     */
    function push(src, final) {
        const n = src.length;
        /** @type {string[]} */
        const out = [];
        /** @type {Token[]} */
        let stmt = [];
        let depth = 0;
        let line = nextLine;
        let atLineStart = nextAtLineStart;
        /** Until GO: a batch of T-SQL code (a view, procedure, IF block…) */
        let wholeBatch = false;
        /** The statement's first four words (upper-cased), and whether it has any SQL yet */
        let words = [];
        let started = false;
        // The end of the last statement adapted, where the next push starts
        let done = { at: 0, line, atLineStart, parts: 0 };
        const flush = () => {
            if (stmt.length) out.push(adaptStatement(stmt, note, tables));
            stmt = [];
            depth = 0;
            wholeBatch = false;
            words = [];
            started = false;
        };
        const mark = (/** @type {number} */ at) => {
            done = { at, line, atLineStart, parts: out.length };
        };

        let i = 0;
        while (i < n) {
            if (atLineStart) {
                GO_LINE.lastIndex = i;
                const go = GO_LINE.exec(src);
                // A GO at the very end may be the start of a longer word
                if (go && (final || i + go[0].length < n)) {
                    flush();
                    out.push(go[0]);
                    i += go[0].length;
                    atLineStart = false;
                    mark(i);
                    continue;
                }
            }
            const c = src.charCodeAt(i);
            const ch = src[i];
            let j = i + 1;
            /** @type {Token['t']} */
            let t = 'p';
            if (c === 10) {
                stmt.push({ t: 'nl', v: '\n', line });
                line++;
                i++;
                atLineStart = true;
                continue;
            }
            if (c === 32 || c === 9 || c === 13) {
                while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\r')) j++;
                t = 'ws';
            } else if (ch === '-' && src[i + 1] === '-') {
                j = src.indexOf('\n', i);
                if (j < 0) j = n;
                t = 'comment';
            } else if (ch === '/' && src[i + 1] === '*') {
                j = src.indexOf('*/', i + 2);
                j = j < 0 ? n : j + 2;
                t = 'comment';
            } else if (ch === "'" || ((ch === 'N' || ch === 'n') && src[i + 1] === "'")) {
                t = ch === "'" ? 'str' : 'nstr';
                j = ch === "'" ? i + 1 : i + 2;
                for (;;) {
                    const k = src.indexOf("'", j);
                    if (k < 0) {
                        j = n;
                        break;
                    }
                    if (src[k + 1] === "'") j = k + 2;
                    else {
                        j = k + 1;
                        break;
                    }
                }
            } else if (ch === '[') {
                for (;;) {
                    const k = src.indexOf(']', j);
                    if (k < 0) {
                        j = n;
                        break;
                    }
                    if (src[k + 1] === ']') j = k + 2;
                    else {
                        j = k + 1;
                        break;
                    }
                }
                t = 'ident';
            } else if (ch === '"') {
                const k = src.indexOf('"', j);
                j = k < 0 ? n : k + 1;
                t = 'ident';
            } else if (ch === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
                j = i + 2;
                while (j < n && /[0-9a-fA-F]/.test(src[j])) j++;
                t = 'hex';
            } else if (c >= 48 && c <= 57) {
                while (j < n && /[0-9.eE]/.test(src[j])) j++;
                t = 'num';
            } else if (/[\p{L}_@#]/u.test(ch)) {
                while (j < n && /[\p{L}\p{N}_@#$]/u.test(src[j])) j++;
                t = 'word';
            }
            // A token that reaches the end of the text may go on in the next part
            if (!final && j >= n) break;
            const v = src.slice(i, j);
            // Count lines inside multi-line tokens (comments, strings)
            const startLine = line;
            for (let k = v.indexOf('\n'); k >= 0; k = v.indexOf('\n', k + 1)) line++;
            const token = /** @type {Token} */ ({ t, v, line: startLine });
            if (t === 'word') token.u = v.toUpperCase();

            if (t === 'word' && !wholeBatch && depth === 0 && started && atLineStart) {
                // UPDATE t <newline> SET …: SET belongs to the UPDATE
                const ownSet = token.u === 'SET' && words[0] === 'UPDATE';
                if (STARTS.has(/** @type {string} */ (token.u)) && !ownSet) {
                    // This word starts the next statement
                    const lineHere = line;
                    line = startLine;
                    flush();
                    mark(i);
                    line = lineHere;
                }
            }
            if (t !== 'ws' && t !== 'comment') atLineStart = false;
            if (t === 'p' && ch === ';' && depth === 0 && !wholeBatch) {
                stmt.push(token);
                flush();
                i = j;
                mark(i);
                continue;
            }
            if (t === 'p' && ch === '(') depth++;
            if (t === 'p' && ch === ')') depth = Math.max(0, depth - 1);
            stmt.push(token);
            if (t !== 'ws' && t !== 'comment') started = true;
            if (t === 'word' && words.length < 4) {
                words.push(/** @type {string} */ (token.u));
                if (words[0] === 'IF') wholeBatch = true;
                if (words[0] === 'CREATE') {
                    const kind = words[1] === 'OR' ? words[3] : words[1];
                    if (kind && CODE_OBJECTS.has(kind)) wholeBatch = true;
                }
            }
            i = j;
        }
        if (final) {
            flush();
            mark(n);
        }
        nextLine = done.line;
        nextAtLineStart = done.atLineStart;
        return { text: out.slice(0, done.parts).join(''), consumed: done.at };
    }

    return {
        push,
        /** Every kind of change made so far, by the line it first happens on. */
        changes() {
            const all = new Map(changes);
            for (const [lower, names] of tables) {
                if (names.size > 1) {
                    const message = `Tables in different schemas have the same name (${[...names].join(', ')}), so they become one name, ${lower}, in SQLite; the second CREATE TABLE will fail.`;
                    all.set(message, { message, count: 1, line: 1 });
                }
            }
            return [...all.values()].sort((a, b) => a.line - b.line);
        }
    };
}

/** Keeps only the line breaks: the statement is left out. */
const blank = (/** @type {Token[]} */ tokens) => tokens.map(x => (x.t === 'nl' ? '\n' : x.v.replace(/[^\n]/g, ''))).join('');

const unbracket = (/** @type {string} */ v) => (v[0] === '[' ? v.slice(1, -1).replace(/]]/g, ']') : v[0] === '"' ? v.slice(1, -1) : v);
const nameUpper = (/** @type {Token | undefined} */ x) => (x && (x.t === 'word' || x.t === 'ident') ? unbracket(x.v).toUpperCase() : '');

/**
 * @param {Token[]} tokens one statement
 * @param {(message: string, line: number, count?: number) => void} note
 * @param {Map<string, Set<string>>} tables
 */
function adaptStatement(tokens, note, tables) {
    const sig = tokens.filter(x => x.t !== 'nl' && x.t !== 'ws' && x.t !== 'comment');
    if (sig.length === 0) return tokens.map(x => x.v).join('');
    const w0 = sig[0].u || '';
    const w1 = sig[1]?.u || '';
    const line = sig[0].line;

    // Left out
    let reason = null;
    if (w0 === 'SET') reason = w1 === 'IDENTITY_INSERT' ? 'SET IDENTITY_INSERT is left out: SQLite accepts values for an INTEGER PRIMARY KEY column without it.' : 'SET options (SET ANSI_NULLS, SET QUOTED_IDENTIFIER…) are left out: SQLite has no session settings.';
    else if (w0 === 'USE') reason = 'USE is left out: the database is the one chosen in SQL Lab.';
    else if (w0 === 'EXEC' || w0 === 'EXECUTE') reason = 'EXEC statements (stored procedures, extended properties) are left out: SQLite has no stored procedures.';
    else if (w0 === 'IF') reason = 'IF blocks are left out: SQLite has no T-SQL control flow.';
    else if (w0 === 'PRINT' || w0 === 'DECLARE' || w0 === 'RAISERROR' || w0 === 'THROW') reason = 'T-SQL statements (PRINT, DECLARE…) are left out.';
    else if (w0 === 'GRANT' || w0 === 'DENY' || w0 === 'REVOKE') reason = 'Permissions (GRANT, DENY) are left out: SQLite has no users.';
    else if (w0 === 'ALTER' && w1 === 'TABLE') {
        const words = new Set(sig.map(x => x.u).filter(Boolean));
        reason = words.has('FOREIGN')
            ? 'Foreign keys added with ALTER TABLE aren\'t created: SQLite can\'t add constraints to an existing table.'
            : words.has('DEFAULT')
                ? 'Defaults added with ALTER TABLE … ADD DEFAULT aren\'t created: SQLite can\'t add them to an existing table.'
                : words.has('CHECK') && !words.has('ADD')
                    ? 'ALTER TABLE … CHECK CONSTRAINT is left out (it enables a constraint that isn\'t created).'
                    : words.has('CHECK')
                        ? 'Check constraints added with ALTER TABLE aren\'t created: SQLite can\'t add constraints to an existing table.'
                        : 'Other ALTER TABLE statements are left out: SQLite\'s ALTER TABLE only renames and adds columns.';
    } else if (w0 === 'ALTER') reason = `ALTER ${w1} is left out: it has no SQLite equivalent.`;
    else if (w0 === 'CREATE') {
        const kind = w1 === 'OR' ? (sig[3]?.u || '') : w1;
        if (CODE_OBJECTS.has(kind)) reason = kind === 'VIEW'
            ? 'Views aren\'t created: their queries are written in T-SQL and would need rewriting for SQLite.'
            : 'Procedures, functions and triggers aren\'t created: they are T-SQL code SQLite can\'t run.';
        else if (['DATABASE', 'SCHEMA', 'USER', 'LOGIN', 'ROLE', 'TYPE', 'SYNONYM', 'SEQUENCE', 'STATISTICS', 'FULLTEXT', 'XML', 'PARTITION', 'ASSEMBLY'].includes(kind)) {
            reason = `CREATE ${kind} is left out: it has no SQLite equivalent.`;
        }
    } else if (w0 === 'DROP' && (w1 === 'DATABASE' || w1 === 'SCHEMA' || w1 === 'USER' || w1 === 'PROCEDURE' || w1 === 'PROC' || w1 === 'FUNCTION')) {
        reason = `DROP ${w1} is left out: it has no SQLite equivalent.`;
    } else if (!KEEP_FIRST.has(w0)) {
        reason = `${sig[0].v} statements are left out: SQLite doesn't have them.`;
    }
    if (reason) {
        note(reason, line);
        return blank(tokens);
    }

    const isCreateTable = w0 === 'CREATE' && w1 === 'TABLE';
    const isIndex = w0 === 'CREATE' && sig.slice(1, 4).some(x => x.u === 'INDEX');
    /** @type {(Token | null)[]} */
    const t = tokens.slice();
    // Next and previous significant token indexes
    const nextSig = (/** @type {number} */ k) => {
        for (let m = k + 1; m < t.length; m++) {
            const x = t[m];
            if (x && x.t !== 'nl' && x.t !== 'ws' && x.t !== 'comment') return m;
        }
        return -1;
    };
    const prevSig = (/** @type {number} */ k) => {
        for (let m = k - 1; m >= 0; m--) {
            const x = t[m];
            if (x && x.t !== 'nl' && x.t !== 'ws' && x.t !== 'comment') return m;
        }
        return -1;
    };
    /** The index of the ")" matching the "(" at k. */
    const closing = (/** @type {number} */ k) => {
        let d = 0;
        for (let m = k; m < t.length; m++) {
            const x = t[m];
            if (!x || x.t !== 'p') continue;
            if (x.v === '(') d++;
            else if (x.v === ')' && --d === 0) return m;
        }
        return -1;
    };
    /** Removes tokens from a to b (inclusive), keeping their line breaks. */
    const drop = (/** @type {number} */ a, /** @type {number} */ b) => {
        for (let m = a; m <= b; m++) {
            const x = t[m];
            if (!x) continue;
            const breaks = x.v.replace(/[^\n]/g, '');
            t[m] = breaks ? { t: 'nl', v: breaks, line: x.line } : null;
        }
    };
    const put = (/** @type {number} */ k, /** @type {string} */ v) => {
        const x = t[k];
        if (x) t[k] = { ...x, v };
    };

    for (let k = 0; k < t.length; k++) {
        const x = t[k];
        if (!x) continue;
        const u = x.u;
        if (x.t === 'nstr') {
            put(k, x.v.slice(1));
            note('N\'…\' text has its N removed: SQLite text is always Unicode.', x.line);
            continue;
        }
        if (x.t === 'hex') {
            const hexDigits = x.v.slice(2);
            put(k, `X'${hexDigits.length % 2 ? `0${hexDigits}` : hexDigits}'`);
            note('Binary values 0x… are written X\'…\', SQLite\'s form.', x.line);
            continue;
        }
        // Schema names: dbo.Employees, [Sales].[Customer] → the table name
        if ((x.t === 'word' || x.t === 'ident') && t[k + 1]?.v === '.' && (t[k + 2]?.t === 'word' || t[k + 2]?.t === 'ident') && t[k + 3]?.v !== '.') {
            const before = t[prevSig(k)];
            const schema = unbracket(x.v);
            if (schema.toLowerCase() === 'dbo' || (before && (TABLE_BEFORE.has(before.u || '') || (isIndex && before.u === 'ON')))) {
                const table = unbracket(/** @type {Token} */ (t[k + 2]).v);
                if (isCreateTable && before?.u === 'TABLE') {
                    const lower = table.toLowerCase();
                    if (!tables.has(lower)) tables.set(lower, new Set());
                    /** @type {Set<string>} */ (tables.get(lower)).add(`${schema}.${table}`);
                }
                drop(k, k + 1);
                note('Schema names are removed (dbo.Employees becomes Employees): SQLite has no schemas.', x.line);
                k += 2;
                continue;
            }
        }
        if (!u) continue;
        // INSERT [table] → INSERT INTO [table]
        if (u === 'INSERT' && k === tokens.indexOf(sig[0])) {
            const m = nextSig(k);
            if (m >= 0 && t[m]?.u !== 'INTO') {
                put(k, `${x.v} INTO`);
                note('INSERT without INTO gets INTO, which SQLite requires.', x.line);
            }
            continue;
        }
        if (DROPPED_WORDS.has(u)) {
            drop(k, k);
            note('Storage options (CLUSTERED, NONCLUSTERED, ROWGUIDCOL, SPARSE, PERSISTED) are removed.', x.line);
            continue;
        }
        if (u === 'NOT' && t[nextSig(k)]?.u === 'FOR') {
            const f = nextSig(k);
            const r = nextSig(f);
            if (t[r]?.u === 'REPLICATION') {
                drop(k, r);
                note('NOT FOR REPLICATION is removed.', x.line);
                continue;
            }
        }
        if (u === 'COLLATE') {
            const m = nextSig(k);
            drop(k, m);
            note('COLLATE with SQL Server collations is removed (SQLite doesn\'t have them).', x.line);
            continue;
        }
        if (u === 'IDENTITY') {
            let end = k;
            const m = nextSig(k);
            if (t[m]?.v === '(') end = closing(m);
            const p = prevSig(k);
            if (p >= 0 && INT_TYPES.has(nameUpper(t[p] || undefined))) put(p, 'INTEGER');
            drop(k, end < 0 ? k : end);
            note('IDENTITY is removed and the column made INTEGER: as the primary key, an INTEGER column numbers new rows by itself in SQLite.', x.line);
            continue;
        }
        if (u === 'ON' || u === 'TEXTIMAGE_ON' || u === 'FILESTREAM_ON') {
            const m = nextSig(k);
            const after = t[nextSig(m)];
            const target = t[m];
            const ends = !after || after.v === ')' || after.v === ',' || after.v === ';' || ['TEXTIMAGE_ON', 'FILESTREAM_ON', 'WITH'].includes(after.u || '');
            if (target && (target.t === 'ident' || target.t === 'word') && (u !== 'ON' || ((isCreateTable || isIndex) && ends && target.v.toUpperCase() !== 'DELETE' && target.v.toUpperCase() !== 'UPDATE'))) {
                drop(k, m);
                note('Filegroups (ON [PRIMARY], TEXTIMAGE_ON …) are removed.', x.line);
                continue;
            }
        }
        if (u === 'WITH' && (isCreateTable || isIndex)) {
            const m = nextSig(k);
            if (t[m]?.v === '(' && INDEX_OPTIONS.has(t[nextSig(m)]?.u || '')) {
                drop(k, closing(m));
                note('Index and table options WITH (PAD_INDEX = OFF, …) are removed.', x.line);
                continue;
            }
        }
        if (u === 'INCLUDE' && isIndex) {
            const m = nextSig(k);
            if (t[m]?.v === '(') {
                drop(k, closing(m));
                note('INCLUDE (…) columns of indexes are removed: SQLite indexes don\'t have them.', x.line);
                continue;
            }
        }
        // ( MAX ) after a type
        if (u === 'MAX' && t[prevSig(k)]?.v === '(' && t[nextSig(k)]?.v === ')' && isCreateTable) {
            drop(prevSig(k), nextSig(k));
            note('(MAX) sizes are removed: SQLite text and blobs have no declared size.', x.line);
            continue;
        }
        // CAST(value AS datetime) → value
        if (u === 'CAST' && t[nextSig(k)]?.v === '(') {
            const open = nextSig(k);
            const close = closing(open);
            if (close > 0) {
                // The AS at this level
                let as = -1;
                let d = 0;
                for (let m = open + 1; m < close; m++) {
                    const y = t[m];
                    if (!y) continue;
                    if (y.v === '(') d++;
                    else if (y.v === ')') d--;
                    else if (d === 0 && y.u === 'AS') as = m;
                }
                const type = as > 0 ? nameUpper(t[nextSig(as)] || undefined) : '';
                if (DATE_TYPES.has(type)) {
                    drop(k, open);
                    drop(as, close);
                    note('CAST(… AS datetime) and other date casts keep just the value: SQLite stores dates as text, and casting would turn them into numbers.', x.line);
                    continue;
                }
            }
        }
    }
    // Bracketed type names in CREATE TABLE: [nvarchar](50) → nvarchar(50)
    if (isCreateTable) {
        for (let k = 0; k < t.length; k++) {
            const x = t[k];
            if (x && x.t === 'ident' && x.v[0] === '[' && TYPE_NAMES.has(unbracket(x.v).toUpperCase())) {
                const p = t[prevSig(k)];
                if (p && (p.t === 'ident' || p.t === 'word') && p.u !== 'CONSTRAINT') put(k, unbracket(x.v));
            }
        }
    }
    let result = t.filter(Boolean).map(x => /** @type {Token} */ (x).v).join('');
    // End the statement with ";" (before any trailing line breaks and comments)
    if (sig[sig.length - 1].v !== ';') {
        const m = /(\s*(?:--[^\n]*\s*)*)$/.exec(result);
        const tail = m ? m[1] : '';
        result = `${result.slice(0, result.length - tail.length)};${tail}`;
    }
    return result;
}
