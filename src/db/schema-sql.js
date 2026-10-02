// CREATE TABLE statements for the SQL Lab's SQLite engine, written from the
// Schema tab's tables. SQLite reads most type names, but not all: what it
// can't read is adapted, and every adaptation is listed (as notes) next to
// the SQL that will run, so nothing changes silently.

import { isBareIdentifier } from '../sql-utils.js';

// SQLite's keywords (https://sqlite.org/lang_keywords.html): names spelled
// like one of these are quoted
const SQLITE_KEYWORDS = new Set(`ABORT ACTION ADD AFTER ALL ALTER ALWAYS ANALYZE AND AS ASC ATTACH AUTOINCREMENT
BEFORE BEGIN BETWEEN BY CASCADE CASE CAST CHECK COLLATE COLUMN COMMIT CONFLICT CONSTRAINT CREATE CROSS
CURRENT CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP DATABASE DEFAULT DEFERRABLE DEFERRED DELETE DESC
DETACH DISTINCT DO DROP EACH ELSE END ESCAPE EXCEPT EXCLUDE EXCLUSIVE EXISTS EXPLAIN FAIL FILTER FIRST
FOLLOWING FOR FOREIGN FROM FULL GENERATED GLOB GROUP GROUPS HAVING IF IGNORE IMMEDIATE IN INDEX INDEXED
INITIALLY INNER INSERT INSTEAD INTERSECT INTO IS ISNULL JOIN KEY LAST LEFT LIKE LIMIT MATCH MATERIALIZED
NATURAL NO NOT NOTHING NOTNULL NULL NULLS OF OFFSET ON OR ORDER OTHERS OUTER OVER PARTITION PLAN PRAGMA
PRECEDING PRIMARY QUERY RAISE RANGE RECURSIVE REFERENCES REGEXP REINDEX RELEASE RENAME REPLACE RESTRICT
RETURNING RIGHT ROLLBACK ROW ROWS SAVEPOINT SELECT SET TABLE TEMP TEMPORARY THEN TIES TO TRANSACTION
TRIGGER UNBOUNDED UNION UNIQUE UPDATE USING VACUUM VALUES VIEW VIRTUAL WHEN WHERE WINDOW WITH WITHOUT`.split(/\s+/));

/** A name as SQLite needs it: quoted when it isn't a plain word or is a keyword. */
export function sqliteName(name) {
    const text = String(name);
    return isBareIdentifier(text) && !SQLITE_KEYWORDS.has(text.toUpperCase()) ? text : `"${text.replace(/"/g, '""')}"`;
}

/** SQLite has no schemas: "dbo.Employees" is created as "Employees". */
export function sqliteTableName(name) {
    const parts = String(name).split('.');
    return parts[parts.length - 1];
}

// A type SQLite reads: words, optionally followed by (n) or (n, m)
const TYPE = /^[A-Za-z_][A-Za-z0-9_]*(?: [A-Za-z_][A-Za-z0-9_]*)*(?: ?\(\s*[+-]?\d+(?:\.\d+)?\s*(?:,\s*[+-]?\d+(?:\.\d+)?\s*)?\))?$/;
// Words that end a type in SQLite (a constraint starts there)
const CONSTRAINT_WORDS = new Set(['CONSTRAINT', 'PRIMARY', 'NOT', 'NULL', 'UNIQUE', 'CHECK', 'DEFAULT', 'COLLATE', 'REFERENCES', 'GENERATED', 'AS', 'ALWAYS']);

/**
 * The type a column gets in SQLite; `type` itself when SQLite reads it.
 * @param {string} type
 */
export function sqliteType(type) {
    const text = String(type ?? '').trim();
    if (!text) return '';
    const words = text.split(' ');
    const cut = words.findIndex(w => CONSTRAINT_WORDS.has(w.replace(/\(.*$/, '').toUpperCase()));
    const kept = (cut === -1 ? words : words.slice(0, cut)).join(' ');
    if (kept && TYPE.test(kept)) return kept;
    // NVARCHAR(MAX), ENUM('a', 'b'), TEXT[]: the leading words only
    return /^[A-Za-z_][A-Za-z0-9_]*(?: [A-Za-z_][A-Za-z0-9_]*)*/.exec(kept)?.[0] ?? '';
}

/**
 * The SQL that creates `tables` in a SQLite database, and notes on what was adapted.
 * @param {any[]} tables tables from the Schema tab (see schema.js)
 * @returns {{ sql: string, statements: string[], notes: string[] }}
 */
export function sqliteCreateTables(tables) {
    const notes = [];
    const statements = tables.map((table) => {
        const name = sqliteTableName(table.name);
        if (name !== table.name) notes.push(`SQLite has no schemas, so ${table.name} is created as ${name}.`);
        const pkKey = table.primaryKey.length === 1 ? table.primaryKey[0].toLowerCase() : null;
        const list = (/** @type {string[]} */ names) => names.map(sqliteName).join(', ');
        const lines = table.columns.map((/** @type {any} */ c) => {
            const type = sqliteType(c.type);
            if (type !== c.type.trim()) {
                notes.push(type
                    ? `${name}.${c.name}: SQLite can't read the type ${c.type}, so it is written as ${type}.`
                    : `${name}.${c.name}: SQLite can't read the type ${c.type}, so the column has no type.`);
            }
            const single = pkKey !== null && c.name.toLowerCase() === pkKey;
            return [sqliteName(c.name), type, single ? 'PRIMARY KEY' : c.nullable ? '' : 'NOT NULL'].filter(Boolean).join(' ');
        });
        if (table.primaryKey.length > 1) lines.push(`PRIMARY KEY (${list(table.primaryKey)})`);
        for (const u of table.unique) lines.push(`UNIQUE (${list(u)})`);
        for (const fk of table.foreignKeys) {
            const ref = sqliteTableName(fk.refTable);
            lines.push(`FOREIGN KEY (${list(fk.columns)}) REFERENCES ${sqliteName(ref)}${fk.refColumns.length ? ` (${list(fk.refColumns)})` : ''}`);
        }
        return `CREATE TABLE ${sqliteName(name)} (\n${lines.map(l => `    ${l}`).join(',\n')}\n);`;
    });
    return { sql: statements.join('\n\n'), statements, notes: [...new Set(notes)] };
}
