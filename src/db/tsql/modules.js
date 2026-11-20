// Stored procedures and user-defined functions for SQL Lab's T-SQL engine:
// reading CREATE / ALTER PROCEDURE and FUNCTION, and keeping their
// definitions in the database (the __sqllab_modules table), so they last
// with it, as SQL Server keeps them in sys.sql_modules.
//
// It follows SQL Server's documented syntax (learn.microsoft.com T-SQL
// reference). It isn't SQL Server and uses none of its code.

import { sigTokens, TsqlSyntaxError } from './parse.js';

export const MODULES_TABLE = '__sqllab_modules';
/** Object ids of procedures and functions start here (tables and views use their SQLite rowid) */
export const MODULE_ID_BASE = 2000000;

/**
 * @typedef {{ name: string, type: string, default: string | null, output: boolean, readonly: boolean }} Param
 * @typedef {{
 *   action: 'create' | 'alter' | 'create or alter',
 *   kind: 'P' | 'FN' | 'IF' | 'TF',
 *   schema: string, name: string,
 *   params: Param[],
 *   returns: string | null,
 *   table: { name: string, columns: string } | null,
 *   body: string, bodyStart: number,
 *   query: string | null, queryStart: number
 * }} ModuleDef
 * @typedef {{ id: number, schema: string, name: string, kind: string, definition: string, params: Param[], returns: string | null, created: string, modified: string }} ModuleRow
 */

export const KIND_NAMES = /** @type {Record<string, string>} */ ({
    P: 'SQL_STORED_PROCEDURE', FN: 'SQL_SCALAR_FUNCTION', IF: 'SQL_INLINE_TABLE_VALUED_FUNCTION', TF: 'SQL_TABLE_VALUED_FUNCTION', TR: 'SQL_TRIGGER'
});

/** A name without its [brackets] or "quotes". */
export const unquote = (/** @type {string} */ s) => {
    const t = String(s ?? '').trim();
    if (t.startsWith('[') && t.endsWith(']')) return t.slice(1, -1).replace(/\]\]/g, ']');
    if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/""/g, '"');
    return t;
};

/**
 * Splits a written name such as [dbo].[usp_Get], Shop.dbo.f or #t into its parts.
 * @param {string} text
 * @returns {{ schema: string, name: string }}
 */
export function splitName(text) {
    const parts = [];
    let current = '';
    let quote = '';
    for (const c of String(text).trim()) {
        if (quote) {
            current += c;
            if (c === quote) quote = '';
        } else if (c === '[') {
            quote = ']';
            current += c;
        } else if (c === '"') {
            quote = '"';
            current += c;
        } else if (c === '.') {
            parts.push(current);
            current = '';
        } else current += c;
    }
    parts.push(current);
    const name = unquote(parts[parts.length - 1]);
    const schema = parts.length > 1 ? unquote(parts[parts.length - 2]) : '';
    return { schema: schema || 'dbo', name };
}

/**
 * Reads a parameter list: @a INT = 5, @b NVARCHAR(20) OUTPUT, @t dbo.T READONLY
 * @param {string} text
 * @param {number} [base] the list's offset in the script, for errors
 * @returns {Param[]}
 */
export function parseParams(text, base = 0) {
    const sig = sigTokens(text, base);
    /** @type {Param[]} */
    const params = [];
    let k = 0;
    while (k < sig.length) {
        const tok = sig[k];
        if (!(tok.t === 'word' && tok.v.startsWith('@'))) throw new TsqlSyntaxError(`Incorrect syntax near '${tok.v}': a parameter name such as @Id was expected.`, tok.start);
        const name = tok.v;
        k++;
        if (sig[k]?.u === 'AS') k++;
        // The type runs to =, OUTPUT, READONLY or the next comma
        const typeStart = k;
        let depth = 0;
        while (k < sig.length) {
            const t = sig[k];
            if (t.t === 'p' && t.v === '(') depth++;
            else if (t.t === 'p' && t.v === ')') depth--;
            else if (depth === 0 && ((t.t === 'p' && (t.v === ',' || t.v === '=')) || ['OUTPUT', 'OUT', 'READONLY', 'VARYING', 'NULL'].includes(t.u))) break;
            k++;
        }
        if (k === typeStart) throw new TsqlSyntaxError(`Parameter ${name} needs a data type.`, sig[k]?.start ?? base + text.length);
        const type = text.slice(sig[typeStart].start - base, sig[k - 1].end - base).replace(/\s+/g, ' ').trim();
        /** @type {Param} */
        const param = { name, type, default: null, output: false, readonly: false };
        while (k < sig.length && !(sig[k].t === 'p' && sig[k].v === ',')) {
            const t = sig[k];
            if (t.u === 'VARYING' || t.u === 'NULL') k++;
            else if (t.u === 'OUTPUT' || t.u === 'OUT') {
                param.output = true;
                k++;
            } else if (t.u === 'READONLY') {
                param.readonly = true;
                k++;
            } else if (t.t === 'p' && t.v === '=') {
                k++;
                const valueStart = k;
                depth = 0;
                while (k < sig.length) {
                    const s = sig[k];
                    if (s.t === 'p' && s.v === '(') depth++;
                    else if (s.t === 'p' && s.v === ')') depth--;
                    else if (depth === 0 && ((s.t === 'p' && s.v === ',') || ['OUTPUT', 'OUT', 'READONLY'].includes(s.u))) break;
                    k++;
                }
                if (k === valueStart) throw new TsqlSyntaxError(`Parameter ${name} needs a default value after =.`, sig[k]?.start ?? base + text.length);
                param.default = text.slice(sig[valueStart].start - base, sig[k - 1].end - base).trim();
            } else throw new TsqlSyntaxError(`Incorrect syntax near '${t.v}'.`, t.start);
        }
        if (params.some(p => p.name.toLowerCase() === name.toLowerCase())) {
            throw new TsqlSyntaxError(`The variable name '${name}' has already been declared. Variable names must be unique within a query batch or stored procedure.`, tok.start);
        }
        params.push(param);
        k++;
    }
    return params;
}

/**
 * Reads CREATE / ALTER / CREATE OR ALTER PROCEDURE or FUNCTION.
 * @param {string} text the whole statement (the rest of its batch)
 * @param {number} [base] its offset in the script, for errors
 * @returns {ModuleDef}
 */
export function parseModule(text, base = 0) {
    const sig = sigTokens(text, base);
    const fail = (/** @type {string} */ message, /** @type {number} */ k) => {
        throw new TsqlSyntaxError(message, sig[k]?.start ?? base + text.length);
    };
    const local = (/** @type {number} */ k) => (sig[k] ? sig[k].start - base : text.length);
    let k = 0;
    /** @type {ModuleDef['action']} */
    let action = sig[0].u === 'ALTER' ? 'alter' : 'create';
    k = 1;
    if (sig[1]?.u === 'OR' && sig[2]?.u === 'ALTER') {
        action = 'create or alter';
        k = 3;
    }
    const objectWord = sig[k]?.u;
    const isProc = objectWord === 'PROC' || objectWord === 'PROCEDURE';
    k++;
    // The name: [schema.]name
    const nameStart = k;
    while (k < sig.length && (sig[k].t === 'word' || sig[k].t === 'ident') && !sig[k].v.startsWith('@')) {
        k++;
        if (sig[k]?.t === 'p' && sig[k].v === '.') k++;
        else break;
    }
    if (k === nameStart) fail(`The ${isProc ? 'procedure' : 'function'} needs a name.`, k);
    const { schema, name } = splitName(text.slice(local(nameStart), sig[k - 1].end - base));
    if (isProc && sig[k]?.t === 'p' && sig[k].v === ';' && /^\d+$/.test(sig[k + 1]?.v || '')) fail('Numbered procedures (name;1) aren\'t supported.', k);

    /** Index of the token closing the parenthesis at `open`. */
    const closeOf = (/** @type {number} */ open) => {
        let depth = 0;
        for (let j = open; j < sig.length; j++) {
            if (sig[j].t !== 'p') continue;
            if (sig[j].v === '(') depth++;
            else if (sig[j].v === ')' && --depth === 0) return j;
        }
        return fail('A closing parenthesis is missing.', open);
    };

    /** @type {Param[]} */
    let params = [];
    if (isProc) {
        // Parameters, in parentheses or not, up to AS / WITH / FOR REPLICATION
        if (sig[k]?.v === '(') {
            const close = closeOf(k);
            const inner = text.slice(local(k + 1), local(close));
            params = inner.trim() ? parseParams(inner, base + local(k + 1)) : [];
            k = close + 1;
        } else {
            const from = k;
            while (k < sig.length && !(sig[k].t === 'word' && ['AS', 'WITH', 'FOR'].includes(sig[k].u))) k++;
            if (k > from) params = parseParams(text.slice(local(from), sig[k - 1].end - base), base + local(from));
        }
        k = skipOptions(sig, k);
        if (sig[k]?.u !== 'AS') fail('Incorrect syntax: AS is missing before the procedure\'s statements.', k);
        k++;
        const bodyStart = local(k);
        const body = text.slice(bodyStart);
        if (!body.trim()) fail('The procedure has no statements after AS.', k);
        return { action, kind: 'P', schema, name, params, returns: null, table: null, body, bodyStart, query: null, queryStart: 0 };
    }

    // FUNCTION name (params) RETURNS …
    if (sig[k]?.v !== '(') fail('A function\'s parameters go in parentheses after its name, even when it has none: dbo.f().', k);
    const close = closeOf(k);
    const inner = text.slice(local(k + 1), local(close));
    params = inner.trim() ? parseParams(inner, base + local(k + 1)) : [];
    for (const p of params) if (p.output) fail('Function parameters can\'t be OUTPUT.', k);
    k = close + 1;
    if (sig[k]?.u !== 'RETURNS') fail('Incorrect syntax: RETURNS is missing after the function\'s parameters.', k);
    k++;
    /** @type {string | null} */
    let returns = null;
    /** @type {ModuleDef['table']} */
    let table = null;
    let kind = /** @type {ModuleDef['kind']} */ ('FN');
    if (sig[k]?.u === 'TABLE') {
        kind = 'IF';
        k++;
    } else if (sig[k]?.v.startsWith('@') && sig[k + 1]?.u === 'TABLE') {
        kind = 'TF';
        const tableName = sig[k].v;
        k += 2;
        if (sig[k]?.v !== '(') fail('The returned table needs its columns in parentheses.', k);
        const end = closeOf(k);
        table = { name: tableName, columns: text.slice(local(k + 1), local(end)).trim() };
        k = end + 1;
    } else {
        const typeStart = k;
        let depth = 0;
        while (k < sig.length) {
            const t = sig[k];
            if (t.t === 'p' && t.v === '(') depth++;
            else if (t.t === 'p' && t.v === ')') depth--;
            else if (depth === 0 && t.t === 'word' && ['AS', 'WITH', 'BEGIN'].includes(t.u)) break;
            k++;
        }
        if (k === typeStart) fail('RETURNS needs a data type.', k);
        returns = text.slice(local(typeStart), sig[k - 1].end - base).replace(/\s+/g, ' ').trim();
    }
    k = skipOptions(sig, k);
    if (sig[k]?.u === 'AS') k++;
    const bodyStart = local(k);
    const body = text.slice(bodyStart);
    if (kind === 'IF') {
        // RETURNS TABLE AS RETURN (SELECT …) or RETURN SELECT …
        if (sig[k]?.u !== 'RETURN') fail('An inline table-valued function is RETURN followed by one SELECT.', k);
        k++;
        let queryFrom = k;
        let queryEnd = sig.length;
        while (queryEnd > queryFrom && sig[queryEnd - 1].t === 'p' && sig[queryEnd - 1].v === ';') queryEnd--;
        if (sig[k]?.v === '(' && closeOf(k) === queryEnd - 1) {
            queryFrom = k + 1;
            queryEnd--;
        }
        if (queryEnd <= queryFrom) fail('RETURN needs a SELECT.', k);
        const query = text.slice(local(queryFrom), sig[queryEnd - 1].end - base);
        return { action, kind, schema, name, params, returns: null, table: null, body, bodyStart, query, queryStart: local(queryFrom) };
    }
    if (sig[k]?.u !== 'BEGIN') fail('The function\'s statements go between BEGIN and END.', k);
    return { action, kind, schema, name, params, returns, table, body, bodyStart, query: null, queryStart: 0 };
}

/** Skips WITH ENCRYPTION, SCHEMABINDING, RECOMPILE, EXECUTE AS …, RETURNS NULL ON NULL INPUT … and FOR REPLICATION. */
function skipOptions(sig, k) {
    if (sig[k]?.u === 'WITH') {
        k++;
        for (;;) {
            const w = sig[k]?.u;
            if (w === 'EXECUTE' || w === 'EXEC') {
                k += 2;
                if (sig[k - 1]?.u === 'AS') k++;
            } else if (w === 'RETURNS' || w === 'CALLED') {
                while (k < sig.length && sig[k].u !== 'INPUT') k++;
                k++;
            } else if (w === 'INLINE') k += 3;
            else if (w) k++;
            if (sig[k]?.v === ',') k++;
            else break;
        }
    }
    if (sig[k]?.u === 'FOR' && sig[k + 1]?.u === 'REPLICATION') k += 2;
    return k;
}

// ---- the catalog table

const MODULE_COLUMNS = 'rowid AS id, schema_name AS schema, name, kind, definition, params, returns, created, modified';

/** Whether the database has the catalog table yet. */
export function hasModulesTable(db) {
    return db.selectValue('SELECT 1 FROM sqlite_schema WHERE type = \'table\' AND name = ?', [MODULES_TABLE]) !== undefined;
}

export function ensureModulesTable(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${MODULES_TABLE} (
        schema_name TEXT NOT NULL DEFAULT 'dbo',
        name TEXT NOT NULL COLLATE NOCASE,
        kind TEXT NOT NULL,
        definition TEXT NOT NULL,
        params TEXT NOT NULL DEFAULT '[]',
        returns TEXT,
        created TEXT NOT NULL,
        modified TEXT NOT NULL,
        UNIQUE (schema_name COLLATE NOCASE, name)
    )`);
}

/** @returns {ModuleRow} */
function toRow(r) {
    return { id: MODULE_ID_BASE + Number(r.id), schema: r.schema, name: r.name, kind: r.kind, definition: r.definition, params: JSON.parse(r.params || '[]'), returns: r.returns ?? null, created: r.created, modified: r.modified };
}

/** Every procedure and function in the database. */
export function listModules(db) {
    if (!hasModulesTable(db)) return [];
    return db.selectObjects(`SELECT ${MODULE_COLUMNS} FROM ${MODULES_TABLE} ORDER BY name COLLATE NOCASE`).map(toRow);
}

/**
 * A procedure or function by its written name (schema optional), or null.
 * @param {any} db
 * @param {string} written
 */
export function findModule(db, written) {
    if (!hasModulesTable(db)) return null;
    const { schema, name } = splitName(written);
    const row = db.selectObject(`SELECT ${MODULE_COLUMNS} FROM ${MODULES_TABLE} WHERE name = ? AND schema_name = ? COLLATE NOCASE`, [name, schema]);
    return row ? toRow(row) : null;
}

/**
 * Saves a definition (creating or replacing the row).
 * @param {any} db
 * @param {{ kind: string, schema: string, name: string, params: unknown, returns: string | null }} def a procedure or function (ModuleDef), or a trigger (params: its table and events)
 * @param {string} definition the CREATE text as written
 * @param {string} now
 * @returns {ModuleRow}
 */
export function saveModule(db, def, definition, now) {
    ensureModulesTable(db);
    const existing = findModule(db, `[${def.schema}].[${def.name}]`);
    const params = JSON.stringify(def.params);
    const returns = def.kind === 'FN' ? def.returns : def.kind === 'P' || def.kind === 'TR' ? null : 'TABLE';
    if (existing) {
        db.exec({ sql: `UPDATE ${MODULES_TABLE} SET kind = ?, definition = ?, params = ?, returns = ?, modified = ? WHERE rowid = ?`, bind: [def.kind, definition, params, returns, now, existing.id - MODULE_ID_BASE] });
    } else {
        db.exec({ sql: `INSERT INTO ${MODULES_TABLE} (schema_name, name, kind, definition, params, returns, created, modified) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, bind: [def.schema, def.name, def.kind, definition, params, returns, now, now] });
    }
    return /** @type {ModuleRow} */ (findModule(db, `[${def.schema}].[${def.name}]`));
}

export function dropModule(db, id) {
    db.exec({ sql: `DELETE FROM ${MODULES_TABLE} WHERE rowid = ?`, bind: [id - MODULE_ID_BASE] });
}

export function renameModule(db, id, name) {
    db.exec({ sql: `UPDATE ${MODULES_TABLE} SET name = ?, modified = datetime('now') WHERE rowid = ?`, bind: [name, id - MODULE_ID_BASE] });
}
