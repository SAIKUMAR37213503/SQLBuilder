// SQL Lab's SSMS-style scripting: Select Top 1000 Rows, Script Table as …,
// Generate Scripts, Format SQL, the query plan's operators, and a result as
// text, CSV or JSON. Plain functions of the explorer's objects, so they are
// tested without a browser.
//
// The shapes follow what SQL Server Management Studio produces, written
// from its documented behaviour; SQL Lab's own wording and layout.

import { tokens } from '../db/dialect-translate.js';

/** @typedef {{ name: string, type: string, notNull: boolean, defaultValue: unknown, primaryKey: boolean }} Column */
/** @typedef {{ name: string, type: 'table' | 'view', sql: string, columns: Column[], primaryKey: string[], foreignKeys: { columns: string[], refTable: string, refColumns: string[] }[] }} DbObject */
/** @typedef {{ name: string, schema: string, kind: string, params: any, returns: string | null, definition?: string }} DbModule */

const isServer = (/** @type {string} */ language) => language === 'sqlserver';

/** A name quoted for the editor's language: [Name], "Name" or `Name`. */
export function quoteName(name, language) {
    const n = String(name);
    if (isServer(language)) return `[${n.replace(/]/g, ']]')}]`;
    if (language === 'mysql') return `\`${n.replace(/`/g, '``')}\``;
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !RESERVED.has(n.toUpperCase()) ? n : `"${n.replace(/"/g, '""')}"`;
}
const RESERVED = new Set(['SELECT', 'FROM', 'WHERE', 'ORDER', 'GROUP', 'TABLE', 'INDEX', 'KEY', 'USER', 'VALUES', 'SET', 'TO', 'BY', 'AS', 'ON', 'IN', 'IS', 'NOT', 'NULL', 'AND', 'OR', 'CASE', 'WHEN', 'END', 'DEFAULT', 'CHECK', 'PRIMARY', 'FOREIGN', 'REFERENCES', 'UNIQUE', 'LIMIT', 'OFFSET', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'UNION', 'ALL', 'DISTINCT', 'HAVING', 'EXISTS', 'BETWEEN', 'LIKE', 'INTO', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'VIEW', 'TRIGGER', 'ORDER']);

/** The object's name with its schema, as SSMS writes it: [dbo].[Orders]. */
export const objectName = (/** @type {string} */ name, /** @type {string} */ language) => (isServer(language) ? `[dbo].${quoteName(name, language)}` : quoteName(name, language));

/** A SQLite declared type as SQL Server writes it. */
export function serverType(declared) {
    const t = String(declared || '').trim();
    if (!t) return 'NVARCHAR(MAX)';
    const upper = t.toUpperCase();
    if (upper === 'TEXT' || upper === 'CLOB') return 'NVARCHAR(MAX)';
    if (upper === 'INTEGER') return 'INT';
    if (upper === 'REAL' || upper === 'DOUBLE' || upper === 'DOUBLE PRECISION') return 'FLOAT';
    if (upper === 'BLOB') return 'VARBINARY(MAX)';
    if (upper === 'BOOLEAN' || upper === 'BOOL') return 'BIT';
    if (upper === 'NUMERIC') return 'DECIMAL(18, 2)';
    if (upper === 'TIMESTAMP') return 'DATETIME2';
    return upper.replace(/\s*\(\s*/g, '(').replace(/\s*,\s*/g, ', ').replace(/\s*\)/g, ')');
}

const isIdentity = (/** @type {DbObject} */ o, /** @type {Column} */ c) => c.primaryKey && /^INTEGER$/i.test(c.type) && o.primaryKey.length === 1 && /AUTOINCREMENT/i.test(o.sql || '');

/** SELECT TOP (1000) … FROM [dbo].[T], as Select Top 1000 Rows writes it (LIMIT outside SQL Server). */
export function scriptSelectTop(object, language, count = 1000) {
    const cols = object.columns.map(c => quoteName(c.name, language));
    if (isServer(language)) {
        return `SELECT TOP (${count}) ${cols.length ? cols.map((c, k) => (k ? `      ,${c}` : c)).join('\n') : '*'}\n  FROM ${objectName(object.name, language)}`;
    }
    return `SELECT ${cols.length ? cols.join(',\n       ') : '*'}\n  FROM ${quoteName(object.name, language)}\n LIMIT ${count};`;
}

/** SELECT every column (Script Table as → SELECT To). */
export function scriptSelect(object, language) {
    const cols = object.columns.map(c => quoteName(c.name, language));
    return `SELECT ${cols.map((c, k) => (k ? `      ,${c}` : c)).join('\n')}\n  FROM ${objectName(object.name, language)}${isServer(language) ? '\nGO' : ';'}`;
}

/** A value as a literal: NULL, a number, N'text', 0x… */
export function literal(value, language) {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'object' && value && 'hex' in value) return isServer(language) ? `0x${/** @type {any} */ (value).hex.toUpperCase()}` : `X'${/** @type {any} */ (value).hex}'`;
    return `${isServer(language) ? 'N' : ''}'${String(value).replace(/'/g, '\'\'')}'`;
}

/** A placeholder for a value, as SSMS's templates write it: <Name, nvarchar(50),> */
const placeholder = (/** @type {Column} */ c, /** @type {string} */ language) => `<${c.name}, ${(isServer(language) ? serverType(c.type) : c.type || 'any').toLowerCase()},>`;

/** INSERT INTO … VALUES (<placeholders>) (Script Table as → INSERT To). */
export function scriptInsert(object, language) {
    const cols = object.columns.filter(c => !isIdentity(object, c));
    return `INSERT INTO ${objectName(object.name, language)}\n           (${cols.map(c => quoteName(c.name, language)).join('\n           ,')})\n     VALUES\n           (${cols.map(c => placeholder(c, language)).join('\n           ,')})${isServer(language) ? '\nGO' : ';'}`;
}

/** UPDATE … SET col = <placeholder> WHERE <Search Conditions,,> (Script Table as → UPDATE To). */
export function scriptUpdate(object, language) {
    const cols = object.columns.filter(c => !isIdentity(object, c));
    return `UPDATE ${objectName(object.name, language)}\n   SET ${cols.map(c => `${quoteName(c.name, language)} = ${placeholder(c, language)}`).join('\n      ,')}\n WHERE <Search Conditions,,>${isServer(language) ? '\nGO' : ';'}`;
}

/** DELETE FROM … WHERE <Search Conditions,,> (Script Table as → DELETE To). */
export function scriptDelete(object, language) {
    return `DELETE FROM ${objectName(object.name, language)}\n      WHERE <Search Conditions,,>${isServer(language) ? '\nGO' : ';'}`;
}

/** DROP TABLE / VIEW IF EXISTS (Script Table as → DROP To). */
export function scriptDrop(object, language) {
    return `DROP ${object.type === 'view' ? 'VIEW' : 'TABLE'} IF EXISTS ${objectName(object.name, language)}${isServer(language) ? '\nGO' : ';'}`;
}

/**
 * CREATE TABLE (or the view's CREATE VIEW) (Script Table as → CREATE To).
 * In SQL Server's language: SQL Server types, IDENTITY, named PRIMARY KEY
 * and FOREIGN KEY constraints; elsewhere SQLite's own statement.
 */
export function scriptCreate(object, language) {
    if (!isServer(language) || object.type === 'view') {
        const sql = String(object.sql || '').trim().replace(/;+$/, '');
        return isServer(language) ? `${sql}\nGO` : `${sql};`;
    }
    const lines = object.columns.map(c => {
        let line = `\t${quoteName(c.name, language)} ${serverType(c.type)}`;
        if (isIdentity(object, c)) line += ' IDENTITY(1,1)';
        line += c.notNull || c.primaryKey ? ' NOT NULL' : ' NULL';
        if (c.defaultValue !== null && c.defaultValue !== undefined && c.defaultValue !== '') line += ` DEFAULT (${String(c.defaultValue).replace(/^\((.*)\)$/, '$1')})`;
        return line;
    });
    if (object.primaryKey.length) {
        lines.push(` CONSTRAINT ${quoteName(`PK_${object.name}`, language)} PRIMARY KEY CLUSTERED (${object.primaryKey.map(c => `${quoteName(c, language)} ASC`).join(', ')})`);
    }
    for (const fk of object.foreignKeys) {
        lines.push(` CONSTRAINT ${quoteName(`FK_${object.name}_${fk.refTable}`, language)} FOREIGN KEY (${fk.columns.map(c => quoteName(c, language)).join(', ')}) REFERENCES ${objectName(fk.refTable, language)}${fk.refColumns.length ? ` (${fk.refColumns.map(c => quoteName(c, language)).join(', ')})` : ''}`);
    }
    return `CREATE TABLE ${objectName(object.name, language)}(\n${lines.join(',\n')}\n)\nGO`;
}

/** A procedure's, function's or trigger's CREATE, ALTER, DROP or EXECUTE script. */
export function scriptModule(mod, action) {
    const name = `[${mod.schema}].[${mod.name}]`;
    const kindWord = mod.kind === 'P' ? 'PROCEDURE' : mod.kind === 'TR' ? 'TRIGGER' : 'FUNCTION';
    if (action === 'drop') return `DROP ${kindWord} IF EXISTS ${name}\nGO`;
    if (action === 'execute') {
        const params = Array.isArray(mod.params) ? mod.params : [];
        if (mod.kind === 'P') {
            const declares = params.filter((/** @type {any} */ p) => p.output).map((/** @type {any} */ p) => `DECLARE ${p.name} ${p.type}\n`).join('');
            const args = params.map((/** @type {any} */ p) => `${p.name} = ${p.output ? `${p.name} OUTPUT` : `<${p.name}, ${String(p.type).toLowerCase()},>`}`);
            return `${declares}DECLARE @RC INT\nEXECUTE @RC = ${name}${args.length ? ` \n   ${args.join('\n  ,')}` : ''}\nGO`;
        }
        const args = params.map((/** @type {any} */ p) => `<${p.name}, ${String(p.type).toLowerCase()},>`).join(', ');
        return mod.kind === 'FN' ? `SELECT ${name}(${args})\nGO` : `SELECT * FROM ${name}(${args})\nGO`;
    }
    const definition = String(mod.definition || '').trim();
    if (action === 'alter') return `${definition.replace(/^\s*CREATE\s+(OR\s+ALTER\s+)?/i, 'ALTER ')}\nGO`;
    return `${definition}\nGO`;
}

/** Tables in an order where each comes after the tables its foreign keys point to. */
export function dependencyOrder(objects) {
    const tables = objects.filter(o => o.type === 'table');
    const byName = new Map(tables.map(t => [t.name.toLowerCase(), t]));
    /** @type {DbObject[]} */
    const out = [];
    const state = new Map();
    const visit = (/** @type {DbObject} */ t) => {
        const key = t.name.toLowerCase();
        if (state.get(key)) return;
        state.set(key, 1);
        for (const fk of t.foreignKeys) {
            const ref = byName.get(fk.refTable.toLowerCase());
            if (ref && ref !== t) visit(ref);
        }
        out.push(t);
    };
    for (const t of tables) visit(t);
    return out;
}

/**
 * Generate Scripts: the whole database as one script, tables (in foreign key
 * order), views, then procedures, functions and triggers, and with `data`,
 * an INSERT for each row.
 * @param {{ objects: DbObject[], modules?: DbModule[], data?: Map<string, { columns: string[], rows: unknown[][], more?: boolean }> | null, language: string, databaseName: string, when?: string }} options
 */
export function scriptDatabase({ objects, modules = [], data = null, language, databaseName, when = '' }) {
    const server = isServer(language);
    const go = server ? '\nGO' : '';
    const parts = [`-- Script of database ${databaseName}${when ? `, generated ${when}` : ''} by SQL Lab`, `-- ${data ? 'Schema and data' : 'Schema only'}`];
    // SQL Lab runs a script in the database that is open, so the copy can be run in another one
    if (server) parts.push(`-- USE ${quoteName(databaseName, language)}\n-- (Left as a comment: run this script in the database that should get these objects.)`);
    const tables = dependencyOrder(objects);
    for (const t of tables) {
        parts.push(`-- Table ${t.name}`);
        parts.push(scriptCreate(t, language));
    }
    for (const v of objects.filter(o => o.type === 'view')) {
        parts.push(`-- View ${v.name}`);
        parts.push(scriptCreate(v, language));
    }
    if (server) {
        const order = ['FN', 'IF', 'TF', 'P', 'TR'];
        for (const m of [...modules].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))) {
            parts.push(`-- ${m.kind === 'P' ? 'Procedure' : m.kind === 'TR' ? 'Trigger' : 'Function'} ${m.schema}.${m.name}`);
            parts.push(scriptModule(m, 'create'));
        }
    }
    if (data) {
        for (const t of tables) {
            const rows = data.get(t.name);
            if (!rows || !rows.rows.length) continue;
            const identity = t.columns.some(c => isIdentity(t, c));
            const name = objectName(t.name, language);
            const cols = rows.columns.map(c => quoteName(c, language)).join(', ');
            parts.push(`-- Data of ${t.name}: ${rows.rows.length} ${rows.rows.length === 1 ? 'row' : 'rows'}${rows.more ? ' (the first ones only)' : ''}`);
            const lines = [];
            if (server && identity) lines.push(`SET IDENTITY_INSERT ${name} ON`);
            for (const row of rows.rows) lines.push(`INSERT ${server ? '' : 'INTO '}${name} (${cols}) VALUES (${row.map(v => literal(v, language)).join(', ')})${server ? '' : ';'}`);
            if (server && identity) lines.push(`SET IDENTITY_INSERT ${name} OFF`);
            parts.push(`${lines.join('\n')}${go}`);
        }
    }
    return `${parts.join('\n')}\n`;
}

// ---- Format SQL

const CLAUSES = new Set(['SELECT', 'FROM', 'WHERE', 'HAVING', 'VALUES', 'OPTION', 'OUTPUT', 'RETURNING', 'WINDOW', 'LIMIT', 'OFFSET']);
const STATEMENTS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'DECLARE', 'SET', 'PRINT', 'EXEC', 'EXECUTE',
    'IF', 'ELSE', 'WHILE', 'RETURN', 'BREAK', 'CONTINUE', 'THROW', 'RAISERROR', 'USE', 'GO', 'COMMIT', 'ROLLBACK', 'SAVE', 'GRANT', 'OPEN', 'FETCH', 'CLOSE', 'DEALLOCATE', 'WITH', 'BEGIN', 'END']);
const JOIN_WORDS = new Set(['JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER', 'NATURAL']);
const OBJECT_WORDS = new Set(['TABLE', 'VIEW', 'PROCEDURE', 'PROC', 'FUNCTION', 'TRIGGER', 'INDEX', 'DATABASE', 'SCHEMA', 'TYPE', 'SEQUENCE', 'COLUMN', 'CONSTRAINT']);
const FUNCTION_WORDS = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'CAST', 'CONVERT', 'TRY_CAST', 'TRY_CONVERT', 'COALESCE', 'ISNULL', 'NULLIF', 'GETDATE', 'IIF', 'LEN',
    'UPPER', 'LOWER', 'TRIM', 'LTRIM', 'RTRIM', 'SUBSTRING', 'REPLACE', 'CONCAT', 'DATEADD', 'DATEDIFF', 'DATEPART', 'ROUND', 'ABS', 'ROW_NUMBER', 'RANK', 'DENSE_RANK',
    'NTILE', 'LAG', 'LEAD', 'FORMAT', 'STRING_AGG', 'OBJECT_ID', 'NEWID', 'SCOPE_IDENTITY', 'CHARINDEX', 'LEFT', 'RIGHT']);
const TYPE_WORDS = new Set(['INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'NVARCHAR', 'VARCHAR', 'NCHAR', 'CHAR', 'DECIMAL', 'NUMERIC', 'FLOAT', 'BIT', 'DATE', 'DATETIME',
    'DATETIME2', 'TIME', 'MONEY', 'UNIQUEIDENTIFIER', 'VARBINARY', 'INTEGER', 'REAL', 'BLOB', 'TEXT', 'MAX']);
const KEYWORDS = new Set([...CLAUSES, ...STATEMENTS, ...JOIN_WORDS, ...OBJECT_WORDS, ...FUNCTION_WORDS, ...TYPE_WORDS, 'GROUP', 'ORDER', 'BY', 'AS', 'ON', 'AND', 'OR',
    'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'BETWEEN', 'EXISTS', 'CASE', 'WHEN', 'USING', 'TARGET', 'SOURCE', 'THEN', 'DISTINCT', 'TOP', 'PERCENT', 'TIES', 'ALL', 'UNION', 'EXCEPT', 'INTERSECT',
    'ASC', 'DESC', 'INTO', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'DEFAULT', 'UNIQUE', 'CHECK', 'IDENTITY', 'APPLY', 'PIVOT', 'UNPIVOT', 'OVER', 'PARTITION',
    'ROWS', 'ROW', 'RANGE', 'NEXT', 'ONLY', 'MATCHED', 'TRY', 'CATCH', 'TRAN', 'TRANSACTION', 'CURSOR', 'FOR', 'RETURNS', 'NOLOCK', 'WITHIN', 'OUTPUT', 'NOCOUNT',
    'AFTER', 'INSTEAD', 'OF', 'CASCADE', 'NO', 'ACTION', 'CLUSTERED', 'NONCLUSTERED', 'EXISTS', 'READONLY', 'ANY', 'SOME']);
const UNARY_AFTER = new Set(['(', ',', '=', '<', '>', '<=', '>=', '<>', '!=', '+', '-', '*', '/', '%']);

/**
 * Lays SQL out as SSMS users write it: one clause per line, keywords in
 * capitals, select lists and AND / OR conditions one per line, subqueries
 * and BEGIN … END blocks indented. Strings, quoted names and comments stay
 * as written, and a blank line between statements stays.
 * @param {string} text
 */
export function formatSql(text) {
    const list = tokens(String(text));
    const unit = '    ';
    /** @type {string[]} */
    const lines = [];
    let line = '';
    let block = 0;
    /** @type {{ query: boolean, indent: number, clause: string, cases: number, between: boolean, head: string }[]} the statement, then each open parenthesis */
    const frames = [{ query: true, indent: 0, clause: '', cases: 0, between: false, head: '' }];
    /** @type {{ t: string, v: string } | null} */
    let prev = null;
    let blank = false;
    const top = () => frames[frames.length - 1];
    const newline = (extra = 0) => {
        if (line.trim()) lines.push(line.replace(/\s+$/, ''));
        line = unit.repeat(Math.max(0, block + top().indent + extra));
    };
    const write = (/** @type {string} */ v, space = true) => {
        if (space && line.trim() && !/\s$/.test(line)) line += ' ';
        line += v;
    };
    const after = (/** @type {number} */ k) => {
        let j = k + 1;
        while (j < list.length && (list[j].t === 'ws' || list[j].t === 'nl')) j++;
        return { at: j, u: list[j] && list[j].t === 'word' ? list[j].v.toUpperCase() : list[j] ? list[j].v : '' };
    };
    for (let k = 0; k < list.length; k++) {
        const t = list[k];
        if (t.t === 'ws') continue;
        if (t.t === 'nl') {
            if (list[k + 1]?.t === 'nl' || (list[k + 1]?.t === 'ws' && list[k + 2]?.t === 'nl')) blank = true;
            continue;
        }
        const frame = top();
        const u = t.t === 'word' ? t.v.toUpperCase() : '';
        const v = u && KEYWORDS.has(u) ? u : t.v;
        const p = prev ? (prev.t === 'word' ? prev.v.toUpperCase() : prev.v) : '';
        const next = after(k).u;
        const level = frame.query && frame.cases === 0;
        const dotted = p === '.';
        if (blank && frames.length === 1 && lines.length) {
            newline();
            lines.push('');
        }
        blank = false;
        prev = t;
        if (t.t === 'comment') {
            write(t.v);
            if (t.v.startsWith('--')) newline(level && frame.clause ? 1 : 0);
            continue;
        }
        if (t.t === 'p') {
            if (t.v === '(') {
                const query = next === 'SELECT' || next === 'WITH';
                const call = (prevWasName(p, list, k) && !KEYWORDS.has(p)) || FUNCTION_WORDS.has(p) || TYPE_WORDS.has(p) || p === 'IDENTITY';
                write('(', !call && p !== '(' && p !== '.');
                frames.push({ query, indent: frame.indent + (query ? 1 : 0), clause: '', cases: 0, between: false, head: '' });
                if (query) newline();
            } else if (t.v === ')') {
                if (frames.length > 1) frames.pop();
                if (frame.query && frames.length && frame.indent > top().indent) newline();
                write(')', false);
            } else if (t.v === ',') {
                write(',', false);
                if (level && ['SELECT', 'GROUP', 'ORDER', 'SET', 'OUTPUT', 'RETURNING', 'VALUES', 'DECLARE'].includes(frame.clause)) newline(1);
            } else if (t.v === ';') {
                write(';', false);
                frame.clause = '';
                frame.head = '';
                newline();
            } else if (t.v === '.' || t.v === '::') {
                write(t.v, false);
            } else if ((t.v === '-' || t.v === '+') && (!p || UNARY_AFTER.has(p))) {
                write(t.v);
                prev = { t: 'p', v: '(' };
            } else {
                write(t.v, p !== '(');
            }
            continue;
        }
        const tight = p === '(' || p === '.' || p === '::' || (p === '-' || p === '+') && prev && prev.v === '(';
        if (!u || dotted || !level) {
            if (u === 'CASE') frame.cases++;
            else if (u === 'END' && frame.cases > 0) frame.cases--;
            if (u === 'BETWEEN') frame.between = true;
            else if (u === 'AND' && frame.between) frame.between = false;
            write(v, !tight);
            continue;
        }
        // A word at the statement's level
        if (u === 'CASE') {
            frame.cases++;
            write(v, !tight);
            continue;
        }
        if (u === 'BEGIN' && !['TRAN', 'TRANSACTION', 'DISTRIBUTED'].includes(next)) {
            newline();
            write(v);
            if (next === 'TRY' || next === 'CATCH') {
                write(next);
                k = after(k).at;
            }
            block++;
            frame.clause = '';
            newline();
            continue;
        }
        if (u === 'END' && block > 0) {
            block--;
            newline();
            write(v);
            if (next === 'TRY' || next === 'CATCH') {
                write(next);
                k = after(k).at;
            }
            frame.clause = '';
            newline();
            continue;
        }
        if (u === 'BETWEEN') frame.between = true;
        const join = JOIN_WORDS.has(u) && !JOIN_WORDS.has(p) && (u !== 'CROSS' || next === 'JOIN' || next === 'APPLY') && (u !== 'OUTER' || next === 'APPLY')
            && !((u === 'LEFT' || u === 'RIGHT') && next === '(');
        const clause = (CLAUSES.has(u) && !(u === 'FROM' && p === 'DELETE') && !(u === 'VALUES' && p === 'DEFAULT') && !(u === 'OUTPUT' && (p === 'OUTPUT' || /^@/.test(String(list[k - 2]?.v)))))
            || ((u === 'GROUP' || u === 'ORDER') && next === 'BY' && p !== 'WITHIN')
            || (u === 'SET' && frame.clause === 'UPDATE')
            || (frame.head === 'MERGE' && (u === 'USING' || (u === 'WHEN' && frame.cases === 0)));
        const statement = STATEMENTS.has(u) && !clause && !(frame.head === 'MERGE' && p === 'THEN')
            && !(['INSERT', 'UPDATE', 'DELETE'].includes(u) && ['THEN', 'AFTER', 'FOR', 'OF', 'ON', ',', 'INSTEAD'].includes(p))
            && !(u === 'WITH' && (next === '(' || ['TIES', 'NOLOCK', 'CHECK', 'ENCRYPTION', 'SCHEMABINDING', 'RECOMPILE', 'NOCHECK', 'VALUES', 'EXECUTE'].includes(next)))
            && !(u === 'IF' && next === 'EXISTS' && OBJECT_WORDS.has(p))
            && !(u === 'ALTER' && p === 'OR')
            && !(u === 'FETCH' && (p === 'ROWS' || p === 'ROW'))
            && !(['SET', 'DROP'].includes(u) && ['ON', 'ALTER', 'DELETE', 'UPDATE', 'NO'].includes(p))
            && !(u === 'DROP' && frame.clause === 'ALTER')
            && !(u === 'EXEC' || u === 'EXECUTE' ? p === 'AS' || p === 'WITH' : false)
            && !(['OPEN', 'CLOSE', 'END', 'BEGIN'].includes(u));
        if (join || clause || statement || ['UNION', 'EXCEPT', 'INTERSECT'].includes(u)) {
            newline();
            write(v);
            if (['UNION', 'EXCEPT', 'INTERSECT'].includes(u)) {
                if (next === 'ALL') {
                    write('ALL');
                    k = after(k).at;
                }
                frame.clause = '';
                newline();
            } else {
                frame.clause = join || u === 'USING' ? 'JOIN' : u;
                if (statement) frame.head = u;
            }
            frame.between = false;
            continue;
        }
        if ((u === 'AND' || u === 'OR') && ['WHERE', 'HAVING', 'JOIN', 'ON'].includes(frame.clause) && !frame.between) {
            newline(1);
            write(v);
            continue;
        }
        if (u === 'AND' && frame.between) frame.between = false;
        if (u === 'ON' && frame.clause === 'JOIN') {
            newline(1);
            write(v);
            frame.clause = 'ON';
            continue;
        }
        write(v, !tight);
    }
    if (line.trim()) lines.push(line.replace(/\s+$/, ''));
    return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/** Whether the token before position k is a name (so a "(" after it is a call). */
function prevWasName(p, list, k) {
    let j = k - 1;
    while (j >= 0 && list[j].t === 'ws') j--;
    return j === k - 1 && (list[j].t === 'word' || list[j].t === 'ident') && list[j].v.toUpperCase() === p.toUpperCase();
}

// ---- query plan

/** SQL Server's name for the operator a step of SQLite's plan is. */
export function planOperator(detail) {
    const d = String(detail);
    if (/^SCAN CONSTANT ROW/i.test(d)) return 'Constant Scan';
    if (/^SCAN \S+ USING COVERING INDEX/i.test(d)) return 'Index Scan';
    if (/^SCAN \S+ USING INDEX/i.test(d)) return 'Index Scan';
    if (/^SCAN/i.test(d)) return 'Table Scan';
    if (/^SEARCH \S+ USING INTEGER PRIMARY KEY/i.test(d)) return 'Clustered Index Seek';
    if (/^SEARCH \S+ USING (COVERING |AUTOMATIC (PARTIAL )?COVERING )?INDEX/i.test(d)) return /AUTOMATIC/i.test(d) ? 'Index Spool (Eager)' : 'Index Seek';
    if (/^SEARCH/i.test(d)) return 'Index Seek';
    if (/^USE TEMP B-TREE FOR (ORDER BY|RIGHT PART OF ORDER BY|LAST TERM OF ORDER BY)/i.test(d)) return 'Sort';
    if (/^USE TEMP B-TREE FOR GROUP BY/i.test(d)) return 'Hash Match (Aggregate)';
    if (/^USE TEMP B-TREE FOR DISTINCT/i.test(d)) return 'Distinct Sort';
    if (/^USE TEMP B-TREE/i.test(d)) return 'Sort';
    if (/SCALAR SUBQUERY/i.test(d)) return 'Compute Scalar (Subquery)';
    if (/LIST SUBQUERY/i.test(d)) return 'Nested Loops (Semi Join)';
    if (/^CO-ROUTINE/i.test(d)) return 'Derived Table';
    if (/^MATERIALIZE/i.test(d)) return 'Table Spool';
    if (/^(COMPOUND QUERY|LEFT-MOST SUBQUERY|UNION ALL|UNION USING|EXCEPT USING|INTERSECT USING)/i.test(d)) return 'Concatenation';
    if (/^MULTI-INDEX OR/i.test(d)) return 'Index Union';
    if (/^INDEX \d+/i.test(d)) return 'Index';
    if (/^BLOOM FILTER/i.test(d)) return 'Bitmap';
    if (/^RIGHT-JOIN/i.test(d)) return 'Right Outer Join';
    return 'Step';
}

/**
 * The steps of EXPLAIN QUERY PLAN as a tree.
 * @param {{ id: number, parent: number, detail: string }[]} steps
 * @returns {{ operator: string, detail: string, children: any[] }[]}
 */
export function planTree(steps) {
    const nodes = new Map();
    /** @type {any[]} */
    const roots = [];
    for (const s of steps) nodes.set(s.id, { operator: planOperator(s.detail), detail: s.detail, children: [] });
    for (const s of steps) {
        const parent = nodes.get(s.parent);
        if (parent && s.parent !== s.id) parent.children.push(nodes.get(s.id));
        else roots.push(nodes.get(s.id));
    }
    return roots;
}

/** Tips from a plan, as SSMS's missing-index hints: a full scan of a table filtered in the query. */
export function planHints(steps) {
    const hints = [];
    for (const s of steps) {
        const m = /^SCAN (\S+)$/i.exec(String(s.detail).trim());
        if (m) hints.push(`${m[1]} is read in full (Table Scan). If the query filters or joins it on a column, an index on that column can turn the scan into an Index Seek.`);
    }
    return [...new Set(hints)];
}

// ---- results as text, CSV, JSON

const plain = (/** @type {unknown} */ v) => (v === null || v === undefined ? 'NULL' : typeof v === 'object' && v && 'blob' in v ? `0x… (${/** @type {any} */ (v).blob} bytes)` : String(v));

/** A result as SSMS's Results to Text shows it: padded columns, a dashed line, then "(n rows affected)". */
export function resultAsText(r) {
    const cap = 256;
    const cols = r.columns.map((/** @type {string} */ c, /** @type {number} */ k) => {
        const width = Math.min(cap, Math.max(String(c).length, ...r.rows.map((/** @type {unknown[]} */ row) => plain(row[k]).length)));
        const numeric = r.rows.length > 0 && r.rows.every((/** @type {unknown[]} */ row) => row[k] === null || typeof row[k] === 'number');
        return { width, numeric };
    });
    const fit = (/** @type {string} */ s, /** @type {number} */ k) => {
        const text = s.length > cols[k].width ? s.slice(0, cols[k].width) : s;
        return cols[k].numeric ? text.padStart(cols[k].width) : text.padEnd(cols[k].width);
    };
    const out = [
        r.columns.map((/** @type {string} */ c, /** @type {number} */ k) => fit(String(c), k)).join(' '),
        cols.map((/** @type {{ width: number }} */ c) => '-'.repeat(c.width)).join(' '),
        ...r.rows.map((/** @type {unknown[]} */ row) => row.map((v, k) => fit(plain(v), k)).join(' ').replace(/\s+$/, '')),
        '',
        `(${r.rows.length} ${r.rows.length === 1 ? 'row' : 'rows'} affected)`
    ];
    return out.map(l => l.replace(/\s+$/, '')).join('\n');
}

const csvCell = (/** @type {unknown} */ v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? plain(v) : String(v);
    return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV with a header row (RFC 4180); NULL is an empty field. */
export function resultAsCsv(r) {
    return `${[r.columns, ...r.rows].map((/** @type {unknown[]} */ row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** Tab-separated text with a header row, for the clipboard (pastes into a spreadsheet). */
export function resultAsTsv(r, { header = true } = {}) {
    const cell = (/** @type {unknown} */ v) => (v === null || v === undefined ? 'NULL' : plain(v).replace(/[\t\r\n]+/g, ' '));
    return (header ? [r.columns, ...r.rows] : r.rows).map((/** @type {unknown[]} */ row) => row.map(cell).join('\t')).join('\n');
}

/** A JSON array with an object per row (the same column twice keeps the first). */
export function resultAsJson(r) {
    const rows = r.rows.map((/** @type {unknown[]} */ row) => {
        /** @type {Record<string, unknown>} */
        const o = {};
        r.columns.forEach((/** @type {string} */ c, /** @type {number} */ k) => {
            if (!(c in o)) o[c] = row[k] !== null && typeof row[k] === 'object' ? plain(row[k]) : row[k];
        });
        return o;
    });
    return `${JSON.stringify(rows, null, 2)}\n`;
}

/** Rows sorted by a column (NULL first when ascending, as in SQL Server), numbers by value, text alphabetically. */
export function sortedRows(rows, column, direction) {
    const sign = direction === 'desc' ? -1 : 1;
    const text = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return rows.map((row, k) => ({ row, k })).sort((a, b) => {
        const x = a.row[column];
        const y = b.row[column];
        let c;
        if (x === null || x === undefined) c = y === null || y === undefined ? 0 : -1;
        else if (y === null || y === undefined) c = 1;
        else if (typeof x === 'number' && typeof y === 'number') c = x - y;
        else c = text.compare(plain(x), plain(y));
        return c * sign || a.k - b.k;
    }).map(x => x.row);
}

// ---- IntelliSense

const NAME_START = /[A-Za-z_@#À-￿]/;
const NAME_CHARS = /[A-Za-z0-9_@#$À-￿]*$/;
const TABLE_CONTEXT = new Set(['FROM', 'JOIN', 'INTO', 'UPDATE', 'TABLE', 'APPLY', 'MERGE', 'USING', 'EXEC', 'EXECUTE', 'TRUNCATE']);
const unquote = (/** @type {string} */ n) => n.replace(/^\[(.*)\]$/, '$1').replace(/^"(.*)"$/, '$1').replace(/^`(.*)`$/, '$1');

/**
 * The tables a statement names, with their aliases: FROM Orders o, JOIN [dbo].[Customers] AS c, UPDATE t …
 * @param {string} text
 * @returns {Map<string, string>} lower-cased alias or table name → table name as written in the database
 */
export function tableAliases(text, objects) {
    const known = new Map(objects.map(o => [o.name.toLowerCase(), o.name]));
    const out = new Map();
    const name = String.raw`(?:\[[^\]]+\]|"[^"]+"|\`[^\`]+\`|[A-Za-z_#@][\w#@$]*)`;
    const re = new RegExp(String.raw`\b(?:FROM|JOIN|UPDATE|INTO|APPLY|USING|MERGE(?:\s+INTO)?)\s+((?:${name}\s*\.\s*){0,2}${name})(?:\s+(?:AS\s+)?(${name}))?`, 'gi');
    const notAlias = /^(WHERE|ON|JOIN|INNER|LEFT|RIGHT|FULL|CROSS|OUTER|GROUP|ORDER|SET|VALUES|SELECT|WITH|AS|UNION|HAVING|OUTPUT|USING|WHEN|LIMIT|OPTION|PIVOT|UNPIVOT|EXCEPT|INTERSECT|DEFAULT)$/i;
    let m;
    while ((m = re.exec(text))) {
        const table = unquote(m[1].split('.').pop().trim());
        const real = known.get(table.toLowerCase());
        if (!real) continue;
        out.set(table.toLowerCase(), real);
        if (m[2] && !notAlias.test(m[2])) out.set(unquote(m[2]).toLowerCase(), real);
    }
    return out;
}

/**
 * What IntelliSense offers at the caret: after "alias." that table's columns;
 * after FROM, JOIN, INTO … tables and views first; otherwise the columns of
 * the tables the SQL names, then keywords, functions, variables and tables.
 * @param {{ text: string, caret: number, objects: DbObject[], modules?: DbModule[], language: string, force?: boolean }} options
 * @returns {{ from: number, to: number, prefix: string, items: { label: string, insert: string, kind: string, detail: string }[] }}
 */
export function completions({ text, caret, objects, modules = [], language, force = false }) {
    const before = text.slice(0, caret);
    const word = NAME_CHARS.exec(before)?.[0] || '';
    const from = caret - word.length;
    const after = /^[A-Za-z0-9_$]*/.exec(text.slice(caret))?.[0] || '';
    const to = caret + after.length;
    const prefix = word.toLowerCase();
    const empty = { from, to, prefix: word, items: [] };
    // Not inside a string or a comment
    const last = tokens(before).filter(t => t.t !== 'ws').pop();
    if (last && (last.t === 'comment' && (last.v.startsWith('--') || !last.v.endsWith('*/')) || (last.t === 'str' && before.endsWith(last.v) && !/'$/.test(last.v.slice(1))))) return empty;
    if (last && last.t === 'str' && !/'$/.test(last.v)) return empty;
    if (!force && word && !NAME_START.test(word[0])) return empty;
    const statementStart = Math.max(before.lastIndexOf(';'), /\bGO\b(?![\s\S]*\bGO\b)/i.exec(before)?.index ?? -1);
    const statement = text.slice(statementStart + 1);
    const aliases = tableAliases(statement, objects);
    const byName = new Map(objects.map(o => [o.name.toLowerCase(), o]));
    /** @type {{ label: string, insert: string, kind: string, detail: string, rank: number }[]} */
    const items = [];
    const quote = (/** @type {string} */ n) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !KEYWORDS.has(n.toUpperCase()) ? n : quoteName(n, language));
    const dot = /((?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[A-Za-z_#@][\w#@$]*))\s*\.\s*$/.exec(before.slice(0, from));
    if (dot) {
        const qualifier = unquote(dot[1]).toLowerCase();
        if (qualifier === 'dbo' || qualifier === 'main') {
            for (const o of objects) items.push({ label: o.name, insert: quote(o.name), kind: o.type, detail: o.type === 'view' ? 'View' : 'Table', rank: 0 });
            for (const mod of modules) items.push({ label: mod.name, insert: quote(mod.name), kind: mod.kind === 'P' ? 'procedure' : 'function', detail: mod.kind === 'P' ? 'Stored procedure' : mod.kind === 'TR' ? 'Trigger' : 'Function', rank: 1 });
        } else {
            const table = byName.get((aliases.get(qualifier) || qualifier).toLowerCase());
            if (!table) return empty;
            for (const c of table.columns) items.push({ label: c.name, insert: quote(c.name), kind: 'column', detail: `${c.type || 'no type'}${c.primaryKey ? ', PK' : ''} · ${table.name}`, rank: 0 });
        }
    } else {
        const prevWord = /([A-Za-z]+)\s*$/.exec(before.slice(0, from))?.[1]?.toUpperCase() || '';
        const tablesFirst = TABLE_CONTEXT.has(prevWord);
        if (prevWord === 'EXEC' || prevWord === 'EXECUTE') {
            for (const mod of modules.filter(x => x.kind === 'P')) items.push({ label: mod.name, insert: quote(mod.name), kind: 'procedure', detail: 'Stored procedure', rank: 0 });
        }
        for (const o of objects) items.push({ label: o.name, insert: quote(o.name), kind: o.type, detail: o.type === 'view' ? 'View' : 'Table', rank: tablesFirst ? 0 : 3 });
        if (!tablesFirst) {
            const seen = new Set();
            for (const t of new Set(aliases.values())) {
                for (const c of byName.get(t.toLowerCase())?.columns || []) {
                    if (seen.has(c.name.toLowerCase())) continue;
                    seen.add(c.name.toLowerCase());
                    items.push({ label: c.name, insert: quote(c.name), kind: 'column', detail: `${c.type || 'no type'} · ${t}`, rank: 0 });
                }
            }
            for (const v of new Set(`${text.slice(0, from)} ${text.slice(to)}`.match(/@@?[A-Za-z_][\w$#@]*/g) || [])) items.push({ label: v, insert: v, kind: 'variable', detail: 'Variable', rank: 1 });
            for (const mod of modules.filter(x => x.kind !== 'TR')) items.push({ label: mod.name, insert: quote(mod.name), kind: mod.kind === 'P' ? 'procedure' : 'function', detail: mod.kind === 'P' ? 'Stored procedure' : 'Function', rank: 2 });
            for (const f of FUNCTION_WORDS) items.push({ label: f, insert: f, kind: 'function', detail: 'Function', rank: 4 });
            for (const k of KEYWORDS) if (!FUNCTION_WORDS.has(k)) items.push({ label: k, insert: k, kind: 'keyword', detail: 'Keyword', rank: 5 });
        } else {
            for (const k of ['SELECT', 'WITH']) items.push({ label: k, insert: k, kind: 'keyword', detail: 'Keyword', rank: 5 });
        }
    }
    const seen = new Set();
    const picked = items
        .filter(i => !prefix || i.label.toLowerCase().startsWith(prefix))
        .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
        .filter(i => {
            const key = `${i.kind}:${i.label.toLowerCase()}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, 60)
        .map(({ rank: _rank, ...i }) => i);
    // Nothing to offer when the only match is the word already typed
    if (!force && picked.length === 1 && picked[0].label.toLowerCase() === (word + after).toLowerCase()) return empty;
    return { from, to, prefix: word, items: picked };
}
