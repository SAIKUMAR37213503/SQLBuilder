// SQL Server's catalog for SQL Lab's T-SQL engine: the INFORMATION_SCHEMA
// and sys. views (sys.tables, sys.columns, sys.objects …) and the system
// procedures people reach for (sp_help, sp_helptext, sp_columns, sp_tables,
// sp_rename …), answered from SQLite's own catalog (sqlite_schema and the
// table_info / index_list / foreign_key_list pragmas) plus the procedures
// and functions in __sqllab_modules.
//
// The views are SQLite TEMP views, made when a statement first names one,
// so nothing is written to the database. Column names and codes follow
// SQL Server's documentation (learn.microsoft.com); none of its code is used.

import { hasModulesTable, KIND_NAMES, MODULE_ID_BASE, MODULES_TABLE, splitName, unquote } from './modules.js';

// ---- data types

/** SQL Server's system types: name, type id, max_length, precision, scale */
const TYPES = /** @type {[string, number, number, number, number][]} */ ([
    ['image', 34, 16, 0, 0], ['text', 35, 16, 0, 0], ['uniqueidentifier', 36, 16, 0, 0], ['date', 40, 3, 10, 0],
    ['time', 41, 5, 16, 7], ['datetime2', 42, 8, 27, 7], ['datetimeoffset', 43, 10, 34, 7], ['tinyint', 48, 1, 3, 0],
    ['smallint', 52, 2, 5, 0], ['int', 56, 4, 10, 0], ['smalldatetime', 58, 4, 16, 0], ['real', 59, 4, 24, 0],
    ['money', 60, 8, 19, 4], ['datetime', 61, 8, 23, 3], ['float', 62, 8, 53, 0], ['sql_variant', 98, 8016, 0, 0],
    ['ntext', 99, 16, 0, 0], ['bit', 104, 1, 1, 0], ['decimal', 106, 17, 38, 38], ['numeric', 108, 17, 38, 38],
    ['smallmoney', 122, 4, 10, 4], ['bigint', 127, 8, 19, 0], ['varbinary', 165, 8000, 0, 0], ['varchar', 167, 8000, 0, 0],
    ['binary', 173, 8000, 0, 0], ['char', 175, 8000, 0, 0], ['timestamp', 189, 8, 0, 0], ['nvarchar', 231, 8000, 0, 0],
    ['nchar', 239, 8000, 0, 0], ['xml', 241, -1, 0, 0], ['sysname', 231, 256, 0, 0]
]);
const TYPE_BY_NAME = new Map(TYPES.map(t => [t[0], t]));
// SQLite's own type words, as SQL Server would name them
const SQLITE_TYPES = /** @type {Record<string, string>} */ ({
    INTEGER: 'int', TEXT: 'nvarchar', REAL: 'float', BLOB: 'varbinary', BOOLEAN: 'bit', DOUBLE: 'float', 'DOUBLE PRECISION': 'float',
    CHARACTER: 'char', 'CHARACTER VARYING': 'varchar', CLOB: 'nvarchar', STRING: 'nvarchar', DATETIMEOFFSET: 'datetimeoffset'
});

/**
 * A declared column type as SQL Server describes it.
 * @param {unknown} declared e.g. NVARCHAR(50), DECIMAL(10,2), INTEGER, TEXT
 */
export function typeInfo(declared) {
    const text = String(declared ?? '').trim();
    const m = /^([A-Za-z_][\w ]*?)\s*(?:\(\s*([^)]*)\))?\s*$/.exec(text);
    const word = (m ? m[1] : text).trim().toUpperCase();
    const args = m && m[2] !== undefined ? m[2].split(',').map(s => s.trim().toUpperCase()) : [];
    let name = SQLITE_TYPES[word] || word.toLowerCase();
    if (!text) name = 'sql_variant';
    const known = TYPE_BY_NAME.get(name);
    if (!known) return { name, typeId: 0, maxLength: -1, precision: 0, scale: 0, charLength: null, display: text.toLowerCase() };
    const typeId = known[1];
    let [, , maxLength, precision, scale] = known;
    /** @type {number | null} */
    let charLength = null;
    const sized = ['char', 'varchar', 'nchar', 'nvarchar', 'binary', 'varbinary'].includes(name);
    if (sized) {
        // TEXT and BLOB columns hold any length, like (MAX)
        const n = args[0] === 'MAX' || (!args.length && (word === 'TEXT' || word === 'BLOB' || word === 'CLOB' || word === 'STRING')) ? -1 : Number(args[0] || 1);
        charLength = n;
        maxLength = n === -1 ? -1 : name.startsWith('n') ? n * 2 : n;
    } else if (name === 'decimal' || name === 'numeric') {
        precision = Number(args[0] || 18);
        scale = Number(args[1] || 0);
        maxLength = precision <= 9 ? 5 : precision <= 19 ? 9 : precision <= 28 ? 13 : 17;
    } else if ((name === 'datetime2' || name === 'time' || name === 'datetimeoffset') && args.length) {
        scale = Number(args[0]);
    } else if (name === 'float' && args.length) {
        precision = Number(args[0]) <= 24 ? 24 : 53;
        maxLength = precision === 24 ? 4 : 8;
    }
    if (name === 'text' || name === 'ntext') charLength = 2147483647;
    const display = sized ? `${name}(${charLength === -1 ? 'max' : charLength})` : name === 'decimal' || name === 'numeric' ? `${name}(${precision},${scale})` : name;
    return { name, typeId, maxLength, precision, scale, charLength, display };
}

/** TYPE_NAME(id): the name of a system type id. */
export function typeName(id) {
    const t = TYPES.find(x => x[1] === Number(id));
    return t ? t[0] : null;
}

/** sqllab_type(declared, part) for the views. */
export function typePart(declared, part) {
    const info = typeInfo(declared);
    switch (String(part)) {
    case 'name': return info.name;
    case 'type_id': return info.typeId;
    case 'max_length': return info.maxLength;
    case 'precision': return info.precision;
    case 'scale': return info.scale;
    case 'char_length': return info.charLength;
    case 'display': return info.display;
    default: return null;
    }
}

/** The name a PRIMARY KEY constraint was given (CONSTRAINT PK_x PRIMARY KEY), or PK_table. */
export function pkName(sql, table) {
    const m = /\bCONSTRAINT\s+(\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$#@]+)\s+PRIMARY\s+KEY/i.exec(String(sql ?? ''));
    return m ? unquote(m[1].replace(/^`|`$/g, '"')) : `PK_${table}`;
}

/**
 * A FOREIGN KEY's name. SQLite numbers keys last-declared first (id 0), so
 * key `id` of `count` is the (count - id)th one written.
 */
export function fkName(sql, table, refTable, id, count) {
    const found = [];
    const re = /\bCONSTRAINT\s+(\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$#@]+)\s+FOREIGN\s+KEY|\bFOREIGN\s+KEY|\bREFERENCES\b/gi;
    // Every FOREIGN KEY or column REFERENCES, in order, with its CONSTRAINT name when it has one
    let m;
    const text = String(sql ?? '');
    while ((m = re.exec(text))) {
        if (/^CONSTRAINT/i.test(m[0])) found.push(unquote(m[1].replace(/^`|`$/g, '"')));
        else if (/^FOREIGN/i.test(m[0])) found.push('');
        else {
            // REFERENCES after FOREIGN KEY (…) belongs to that key
            const before = text.slice(Math.max(0, m.index - 400), m.index);
            if (!/FOREIGN\s+KEY\s*\([^)]*\)\s*$/i.test(before)) {
                const named = /\bCONSTRAINT\s+(\[[^\]]+\]|"[^"]+"|[\w$#@]+)\s*$/i.exec(before);
                found.push(named ? unquote(named[1]) : '');
            }
        }
    }
    const index = Number(count) - 1 - Number(id);
    const name = found.length === Number(count) ? found[index] : '';
    return name || `FK_${table}_${refTable}${Number(count) > 1 ? `_${index + 1}` : ''}`;
}

// ---- views

const USER_TABLES = "name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_\\_sqllab\\_%' ESCAPE '\\'";
const USER_S = USER_TABLES.replace(/name/g, 's.name');
const q = (/** @type {string} */ s) => `'${String(s).replace(/'/g, "''")}'`;

/** The procedures and functions, or an empty set with the same columns. */
function modulesSource(hasModules) {
    return hasModules
        ? `(SELECT rowid + ${MODULE_ID_BASE} AS id, schema_name, name, kind, definition, params, returns, created, modified FROM main.${MODULES_TABLE})`
        : '(SELECT NULL AS id, NULL AS schema_name, NULL AS name, NULL AS kind, NULL AS definition, \'[]\' AS params, NULL AS returns, NULL AS created, NULL AS modified WHERE 0)';
}

const kindDesc = (/** @type {string} */ col) => `CASE ${col} ${Object.entries(KIND_NAMES).map(([k, v]) => `WHEN '${k}' THEN '${v}'`).join(' ')} END`;

/** SQL for each catalog view: key → SELECT. */
function viewSql(key, dbName, hasModules) {
    const db = q(dbName);
    const mods = modulesSource(hasModules);
    const tables = `main.sqlite_schema s WHERE s.type = 'table' AND ${USER_S}`;
    const tablesAndViews = `main.sqlite_schema s WHERE s.type IN ('table', 'view') AND ${USER_S}`;
    const columnsFrom = `main.sqlite_schema s, pragma_table_info(s.name, 'main') p WHERE s.type IN ('table', 'view') AND ${USER_S}`;
    const identity = "(p.pk = 1 AND upper(p.type) = 'INTEGER' AND s.sql LIKE '%AUTOINCREMENT%')";
    const fkCount = '(SELECT COUNT(*) FROM pragma_foreign_key_list(s.name, \'main\') x WHERE x.seq = 0)';
    const objects = `SELECT s.name AS name, s.rowid AS object_id, NULL AS principal_id, 1 AS schema_id,
            CASE s.type WHEN 'trigger' THEN COALESCE((SELECT t.rowid FROM main.sqlite_schema t WHERE t.type = 'table' AND t.name = s.tbl_name), 0) ELSE 0 END AS parent_object_id,
            CASE s.type WHEN 'table' THEN 'U' WHEN 'view' THEN 'V' ELSE 'TR' END AS type,
            CASE s.type WHEN 'table' THEN 'USER_TABLE' WHEN 'view' THEN 'VIEW' ELSE 'SQL_TRIGGER' END AS type_desc,
            NULL AS create_date, NULL AS modify_date, 0 AS is_ms_shipped, 0 AS is_published, 0 AS is_schema_published
        FROM main.sqlite_schema s WHERE s.type IN ('table', 'view', 'trigger') AND ${USER_S}
        UNION ALL
        SELECT m.name, m.id, NULL, CASE m.schema_name WHEN 'dbo' THEN 1 ELSE 5 END, CASE m.kind WHEN 'TR' THEN COALESCE((SELECT t.rowid FROM main.sqlite_schema t WHERE t.type IN ('table', 'view') AND t.name = json_extract(m.params, '$.table') COLLATE NOCASE), 0) ELSE 0 END, m.kind, ${kindDesc('m.kind')}, m.created, m.modified, 0, 0, 0 FROM ${mods} m`;
    switch (key) {
    // ---- INFORMATION_SCHEMA
    case 'information_schema.tables':
        return `SELECT ${db} AS TABLE_CATALOG, 'dbo' AS TABLE_SCHEMA, s.name AS TABLE_NAME, CASE s.type WHEN 'table' THEN 'BASE TABLE' ELSE 'VIEW' END AS TABLE_TYPE FROM ${tablesAndViews}`;
    case 'information_schema.columns':
        return `SELECT ${db} AS TABLE_CATALOG, 'dbo' AS TABLE_SCHEMA, s.name AS TABLE_NAME, p.name AS COLUMN_NAME, p.cid + 1 AS ORDINAL_POSITION,
            p.dflt_value AS COLUMN_DEFAULT, CASE WHEN p."notnull" OR p.pk > 0 THEN 'NO' ELSE 'YES' END AS IS_NULLABLE,
            sqllab_type(p.type, 'name') AS DATA_TYPE, sqllab_type(p.type, 'char_length') AS CHARACTER_MAXIMUM_LENGTH,
            CASE WHEN sqllab_type(p.type, 'char_length') IS NULL THEN NULL WHEN sqllab_type(p.type, 'name') LIKE 'n%' THEN sqllab_type(p.type, 'max_length') ELSE sqllab_type(p.type, 'char_length') END AS CHARACTER_OCTET_LENGTH,
            CASE WHEN sqllab_type(p.type, 'name') IN ('tinyint', 'smallint', 'int', 'bigint', 'decimal', 'numeric', 'float', 'real', 'money', 'smallmoney', 'bit') THEN sqllab_type(p.type, 'precision') END AS NUMERIC_PRECISION,
            CASE WHEN sqllab_type(p.type, 'name') IN ('tinyint', 'smallint', 'int', 'bigint', 'decimal', 'numeric', 'money', 'smallmoney', 'bit') THEN sqllab_type(p.type, 'scale') END AS NUMERIC_SCALE,
            CASE WHEN sqllab_type(p.type, 'name') IN ('datetime', 'datetime2', 'smalldatetime', 'time', 'datetimeoffset', 'date') THEN sqllab_type(p.type, 'scale') END AS DATETIME_PRECISION,
            CASE WHEN sqllab_type(p.type, 'char_length') IS NOT NULL THEN 'SQL_Latin1_General_CP1_CI_AS' END AS COLLATION_NAME
            FROM ${columnsFrom}`;
    case 'information_schema.views':
        return `SELECT ${db} AS TABLE_CATALOG, 'dbo' AS TABLE_SCHEMA, s.name AS TABLE_NAME, s.sql AS VIEW_DEFINITION, 'NONE' AS CHECK_OPTION, 'NO' AS IS_UPDATABLE FROM main.sqlite_schema s WHERE s.type = 'view' AND ${USER_S}`;
    case 'information_schema.routines':
        return `SELECT ${db} AS SPECIFIC_CATALOG, m.schema_name AS SPECIFIC_SCHEMA, m.name AS SPECIFIC_NAME, ${db} AS ROUTINE_CATALOG, m.schema_name AS ROUTINE_SCHEMA, m.name AS ROUTINE_NAME,
            CASE m.kind WHEN 'P' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS ROUTINE_TYPE, CASE m.kind WHEN 'P' THEN NULL WHEN 'FN' THEN sqllab_type(m.returns, 'name') ELSE 'TABLE' END AS DATA_TYPE,
            'SQL' AS ROUTINE_BODY, m.definition AS ROUTINE_DEFINITION, CASE m.kind WHEN 'FN' THEN 'YES' ELSE 'NO' END AS IS_DETERMINISTIC, m.created AS CREATED, m.modified AS LAST_ALTERED FROM ${mods} m WHERE m.kind != 'TR'`;
    case 'information_schema.parameters':
        return `SELECT ${db} AS SPECIFIC_CATALOG, m.schema_name AS SPECIFIC_SCHEMA, m.name AS SPECIFIC_NAME, j.key + 1 AS ORDINAL_POSITION,
            CASE WHEN json_extract(j.value, '$.output') THEN 'INOUT' ELSE 'IN' END AS PARAMETER_MODE, 'NO' AS IS_RESULT, json_extract(j.value, '$.name') AS PARAMETER_NAME,
            sqllab_type(json_extract(j.value, '$.type'), 'name') AS DATA_TYPE, sqllab_type(json_extract(j.value, '$.type'), 'char_length') AS CHARACTER_MAXIMUM_LENGTH
            FROM ${mods} m, json_each(m.params) j WHERE m.kind != 'TR'`;
    case 'information_schema.schemata':
        return `SELECT ${db} AS CATALOG_NAME, column1 AS SCHEMA_NAME, column1 AS SCHEMA_OWNER FROM (VALUES ('dbo'), ('guest'), ('INFORMATION_SCHEMA'), ('sys'))`;
    case 'information_schema.table_constraints':
        return `SELECT ${db} AS CONSTRAINT_CATALOG, 'dbo' AS CONSTRAINT_SCHEMA, sqllab_pk_name(s.sql, s.name) AS CONSTRAINT_NAME, ${db} AS TABLE_CATALOG, 'dbo' AS TABLE_SCHEMA, s.name AS TABLE_NAME, 'PRIMARY KEY' AS CONSTRAINT_TYPE, 'NO' AS IS_DEFERRABLE, 'NO' AS INITIALLY_DEFERRED
            FROM ${tables} AND EXISTS (SELECT 1 FROM pragma_table_info(s.name, 'main') p WHERE p.pk > 0)
            UNION ALL SELECT ${db}, 'dbo', 'UQ_' || s.name || '_' || il.seq, ${db}, 'dbo', s.name, 'UNIQUE', 'NO', 'NO' FROM main.sqlite_schema s, pragma_index_list(s.name, 'main') il WHERE s.type = 'table' AND il.origin = 'u' AND ${USER_S}
            UNION ALL SELECT ${db}, 'dbo', sqllab_fk_name(s.sql, s.name, f."table", f.id, ${fkCount}), ${db}, 'dbo', s.name, 'FOREIGN KEY', 'NO', 'NO' FROM main.sqlite_schema s, pragma_foreign_key_list(s.name, 'main') f WHERE s.type = 'table' AND f.seq = 0 AND ${USER_S}`;
    case 'information_schema.key_column_usage':
        return `SELECT ${db} AS CONSTRAINT_CATALOG, 'dbo' AS CONSTRAINT_SCHEMA, sqllab_pk_name(s.sql, s.name) AS CONSTRAINT_NAME, ${db} AS TABLE_CATALOG, 'dbo' AS TABLE_SCHEMA, s.name AS TABLE_NAME, p.name AS COLUMN_NAME, p.pk AS ORDINAL_POSITION
            FROM ${columnsFrom} AND s.type = 'table' AND p.pk > 0
            UNION ALL SELECT ${db}, 'dbo', 'UQ_' || s.name || '_' || il.seq, ${db}, 'dbo', s.name, ii.name, ii.seqno + 1 FROM main.sqlite_schema s, pragma_index_list(s.name, 'main') il, pragma_index_info(il.name, 'main') ii WHERE s.type = 'table' AND il.origin = 'u' AND ${USER_S}
            UNION ALL SELECT ${db}, 'dbo', sqllab_fk_name(s.sql, s.name, f."table", f.id, ${fkCount}), ${db}, 'dbo', s.name, f."from", f.seq + 1 FROM main.sqlite_schema s, pragma_foreign_key_list(s.name, 'main') f WHERE s.type = 'table' AND ${USER_S}`;
    case 'information_schema.referential_constraints':
        return `SELECT ${db} AS CONSTRAINT_CATALOG, 'dbo' AS CONSTRAINT_SCHEMA, sqllab_fk_name(s.sql, s.name, f."table", f.id, ${fkCount}) AS CONSTRAINT_NAME,
            ${db} AS UNIQUE_CONSTRAINT_CATALOG, 'dbo' AS UNIQUE_CONSTRAINT_SCHEMA, (SELECT sqllab_pk_name(r.sql, r.name) FROM main.sqlite_schema r WHERE r.type = 'table' AND r.name = f."table" COLLATE NOCASE) AS UNIQUE_CONSTRAINT_NAME,
            'SIMPLE' AS MATCH_OPTION, CASE upper(f.on_update) WHEN 'NO ACTION' THEN 'NO ACTION' ELSE upper(f.on_update) END AS UPDATE_RULE, upper(f.on_delete) AS DELETE_RULE
            FROM main.sqlite_schema s, pragma_foreign_key_list(s.name, 'main') f WHERE s.type = 'table' AND f.seq = 0 AND ${USER_S}`;
    // ---- sys
    case 'sys.objects':
    case 'sys.all_objects':
        return objects;
    case 'sys.sysobjects':
        return `SELECT name, object_id AS id, type AS xtype, 1 AS uid, parent_object_id AS parent_obj, create_date AS crdate, type, 0 AS category FROM (${objects})`;
    case 'sys.tables':
        return `SELECT s.name AS name, s.rowid AS object_id, NULL AS principal_id, 1 AS schema_id, 0 AS parent_object_id, 'U' AS type, 'USER_TABLE' AS type_desc,
            NULL AS create_date, NULL AS modify_date, 0 AS is_ms_shipped, (SELECT COUNT(*) FROM pragma_table_info(s.name, 'main')) AS max_column_id_used,
            1 AS uses_ansi_nulls, 0 AS temporal_type, 'NON_TEMPORAL_TABLE' AS temporal_type_desc, 0 AS is_memory_optimized, 0 AS is_external
            FROM ${tables}`;
    case 'sys.views':
        return `SELECT s.name AS name, s.rowid AS object_id, NULL AS principal_id, 1 AS schema_id, 0 AS parent_object_id, 'V' AS type, 'VIEW' AS type_desc, NULL AS create_date, NULL AS modify_date, 0 AS is_ms_shipped
            FROM main.sqlite_schema s WHERE s.type = 'view' AND ${USER_S}`;
    case 'sys.procedures':
        return `SELECT m.name AS name, m.id AS object_id, NULL AS principal_id, 1 AS schema_id, 0 AS parent_object_id, 'P' AS type, 'SQL_STORED_PROCEDURE' AS type_desc, m.created AS create_date, m.modified AS modify_date, 0 AS is_ms_shipped FROM ${mods} m WHERE m.kind = 'P'`;
    case 'sys.triggers':
        return `SELECT s.name AS name, s.rowid AS object_id, 1 AS parent_class, 'OBJECT_OR_COLUMN' AS parent_class_desc, COALESCE((SELECT t.rowid FROM main.sqlite_schema t WHERE t.type = 'table' AND t.name = s.tbl_name), 0) AS parent_id,
            'TR' AS type, 'SQL_TRIGGER' AS type_desc, NULL AS create_date, NULL AS modify_date, 0 AS is_ms_shipped, 0 AS is_disabled, CASE WHEN s.sql LIKE '%INSTEAD OF%' THEN 1 ELSE 0 END AS is_instead_of_trigger
            FROM main.sqlite_schema s WHERE s.type = 'trigger'
            UNION ALL SELECT m.name, m.id, 1, 'OBJECT_OR_COLUMN', COALESCE((SELECT t.rowid FROM main.sqlite_schema t WHERE t.type IN ('table', 'view') AND t.name = json_extract(m.params, '$.table') COLLATE NOCASE), 0), 'TR', 'SQL_TRIGGER', m.created, m.modified, 0, 0, COALESCE(json_extract(m.params, '$.instead'), 0)
            FROM ${mods} m WHERE m.kind = 'TR'`;
    case 'sys.columns':
    case 'sys.all_columns':
        return `SELECT s.rowid AS object_id, p.name AS name, p.cid + 1 AS column_id, sqllab_type(p.type, 'type_id') AS system_type_id, sqllab_type(p.type, 'type_id') AS user_type_id,
            sqllab_type(p.type, 'max_length') AS max_length, sqllab_type(p.type, 'precision') AS precision, sqllab_type(p.type, 'scale') AS scale,
            CASE WHEN sqllab_type(p.type, 'char_length') IS NOT NULL THEN 'SQL_Latin1_General_CP1_CI_AS' END AS collation_name,
            CASE WHEN p."notnull" OR p.pk > 0 THEN 0 ELSE 1 END AS is_nullable, 0 AS is_ansi_padded, 0 AS is_rowguidcol,
            CASE WHEN ${identity} THEN 1 ELSE 0 END AS is_identity, 0 AS is_computed, 0 AS default_object_id
            FROM ${columnsFrom}`;
    case 'sys.identity_columns':
        return `SELECT s.rowid AS object_id, p.name AS name, p.cid + 1 AS column_id, 56 AS system_type_id, 1 AS seed_value, 1 AS increment_value,
            (SELECT seq FROM main.sqlite_sequence q WHERE q.name = s.name) AS last_value FROM ${columnsFrom} AND ${identity}`;
    case 'sys.types':
        return `SELECT column1 AS name, column2 AS system_type_id, column2 AS user_type_id, 4 AS schema_id, column3 AS max_length, column4 AS precision, column5 AS scale, 1 AS is_nullable, 0 AS is_user_defined
            FROM (VALUES ${TYPES.filter(t => t[0] !== 'sysname').map(t => `(${q(t[0])}, ${t[1]}, ${t[2]}, ${t[3]}, ${t[4]})`).join(', ')})`;
    case 'sys.schemas':
        return 'SELECT column1 AS name, column2 AS schema_id, 1 AS principal_id FROM (VALUES (\'dbo\', 1), (\'guest\', 2), (\'INFORMATION_SCHEMA\', 3), (\'sys\', 4))';
    case 'sys.databases':
        return `SELECT column1 AS name, column2 AS database_id, NULL AS source_database_id, NULL AS create_date, 160 AS compatibility_level, 'SQL_Latin1_General_CP1_CI_AS' AS collation_name,
            'MULTI_USER' AS user_access_desc, 0 AS is_read_only, 'ONLINE' AS state_desc, 'SIMPLE' AS recovery_model_desc
            FROM (VALUES ('master', 1), ('tempdb', 2), ('model', 3), ('msdb', 4), (${db}, 5))`;
    case 'sys.indexes':
        return `SELECT s.rid AS object_id, CASE WHEN rowidPk THEN sqllab_pk_name(s.sql, s.name) END AS name, CASE WHEN rowidPk THEN 1 ELSE 0 END AS index_id,
                CASE WHEN rowidPk THEN 1 ELSE 0 END AS type, CASE WHEN rowidPk THEN 'CLUSTERED' ELSE 'HEAP' END AS type_desc, rowidPk AS is_unique, rowidPk AS is_primary_key, 0 AS is_unique_constraint, 0 AS is_disabled
            FROM (SELECT s.rowid AS rid, s.name, s.sql, EXISTS (SELECT 1 FROM pragma_table_info(s.name, 'main') p WHERE p.pk = 1 AND upper(p.type) = 'INTEGER') AND (SELECT COUNT(*) FROM pragma_table_info(s.name, 'main') p WHERE p.pk > 0) = 1 AS rowidPk FROM ${tables}) s
            UNION ALL
            SELECT s.rowid, CASE il.origin WHEN 'pk' THEN sqllab_pk_name(s.sql, s.name) WHEN 'u' THEN 'UQ_' || s.name || '_' || il.seq ELSE il.name END, il.seq + 2,
                2, 'NONCLUSTERED', il."unique", il.origin = 'pk', il.origin = 'u', 0
            FROM main.sqlite_schema s, pragma_index_list(s.name, 'main') il WHERE s.type = 'table' AND ${USER_S}`;
    case 'sys.foreign_keys':
        return `SELECT sqllab_fk_name(s.sql, s.name, f."table", f.id, ${fkCount}) AS name, 3000000 + s.rowid * 100 + f.id AS object_id, NULL AS principal_id, 1 AS schema_id,
            s.rowid AS parent_object_id, 'F' AS type, 'FOREIGN_KEY_CONSTRAINT' AS type_desc,
            (SELECT r.rowid FROM main.sqlite_schema r WHERE r.type = 'table' AND r.name = f."table" COLLATE NOCASE) AS referenced_object_id, 0 AS is_disabled, 0 AS is_not_trusted,
            CASE upper(f.on_delete) WHEN 'CASCADE' THEN 1 WHEN 'SET NULL' THEN 2 WHEN 'SET DEFAULT' THEN 3 ELSE 0 END AS delete_referential_action,
            replace(upper(f.on_delete), ' ', '_') AS delete_referential_action_desc,
            CASE upper(f.on_update) WHEN 'CASCADE' THEN 1 WHEN 'SET NULL' THEN 2 WHEN 'SET DEFAULT' THEN 3 ELSE 0 END AS update_referential_action,
            replace(upper(f.on_update), ' ', '_') AS update_referential_action_desc
            FROM main.sqlite_schema s, pragma_foreign_key_list(s.name, 'main') f WHERE s.type = 'table' AND f.seq = 0 AND ${USER_S}`;
    case 'sys.foreign_key_columns':
        return `SELECT 3000000 + s.rowid * 100 + f.id AS constraint_object_id, f.seq + 1 AS constraint_column_id, s.rowid AS parent_object_id,
            (SELECT p.cid + 1 FROM pragma_table_info(s.name, 'main') p WHERE p.name = f."from" COLLATE NOCASE) AS parent_column_id,
            r.rowid AS referenced_object_id,
            COALESCE((SELECT p.cid + 1 FROM pragma_table_info(r.name, 'main') p WHERE p.name = f."to" COLLATE NOCASE), (SELECT p.cid + 1 FROM pragma_table_info(r.name, 'main') p WHERE p.pk = f.seq + 1)) AS referenced_column_id
            FROM main.sqlite_schema s, pragma_foreign_key_list(s.name, 'main') f JOIN main.sqlite_schema r ON r.type = 'table' AND r.name = f."table" COLLATE NOCASE
            WHERE s.type = 'table' AND ${USER_S}`;
    case 'sys.sql_modules':
        return `SELECT m.id AS object_id, m.definition AS definition, 1 AS uses_ansi_nulls, 1 AS uses_quoted_identifier, 0 AS is_schema_bound FROM ${mods} m
            UNION ALL SELECT s.rowid, s.sql, 1, 1, 0 FROM main.sqlite_schema s WHERE s.type IN ('view', 'trigger') AND ${USER_S}`;
    case 'sys.parameters':
        return `SELECT m.id AS object_id, json_extract(j.value, '$.name') AS name, j.key + 1 AS parameter_id,
            sqllab_type(json_extract(j.value, '$.type'), 'type_id') AS system_type_id, sqllab_type(json_extract(j.value, '$.type'), 'type_id') AS user_type_id,
            sqllab_type(json_extract(j.value, '$.type'), 'max_length') AS max_length, sqllab_type(json_extract(j.value, '$.type'), 'precision') AS precision,
            sqllab_type(json_extract(j.value, '$.type'), 'scale') AS scale, json_extract(j.value, '$.output') AS is_output,
            json_extract(j.value, '$.default') IS NOT NULL AS has_default_value, json_extract(j.value, '$.readonly') AS is_readonly
            FROM ${mods} m, json_each(m.params) j WHERE m.kind != 'TR'`;
    default:
        return null;
    }
}

const VIEW_NAMES = new Set([
    'information_schema.tables', 'information_schema.columns', 'information_schema.views', 'information_schema.routines',
    'information_schema.parameters', 'information_schema.schemata', 'information_schema.table_constraints',
    'information_schema.key_column_usage', 'information_schema.referential_constraints',
    'sys.objects', 'sys.all_objects', 'sys.sysobjects', 'sys.tables', 'sys.views', 'sys.procedures', 'sys.triggers', 'sys.columns',
    'sys.all_columns', 'sys.identity_columns', 'sys.types', 'sys.schemas', 'sys.databases', 'sys.indexes', 'sys.foreign_keys',
    'sys.foreign_key_columns', 'sys.sql_modules', 'sys.parameters'
]);

/** The SQLite name of a catalog view. */
const physical = (/** @type {string} */ key) => `__cat_${key.replace('.', '_')}`;

/**
 * Rewrites names of catalog views (INFORMATION_SCHEMA.TABLES, sys.columns,
 * Shop.sys.objects, sysobjects …) to SQLite TEMP views, creating them.
 * @param {Array<{ t: string, v: string }>} list the statement's tokens (changed in place)
 * @param {(key: string) => void} ensure creates the view for a key
 * @returns {boolean} whether any name was rewritten
 */
export function rewriteCatalogNames(list, ensure) {
    let changed = false;
    const sigAt = (/** @type {number} */ k) => {
        let j = k;
        while (j < list.length && (list[j].t === 'ws' || list[j].t === 'nl' || list[j].t === 'comment')) j++;
        return j;
    };
    const plain = (/** @type {{ t: string, v: string } | undefined} */ tok) => (tok && (tok.t === 'word' || tok.t === 'ident') ? unquote(tok.v).toLowerCase() : '');
    for (let i = 0; i < list.length; i++) {
        const word = plain(list[i]);
        if (!word) continue;
        // Not the middle of a longer name (a.sys.x is handled from a)
        let p = i - 1;
        while (p >= 0 && (list[p].t === 'ws' || list[p].t === 'nl')) p--;
        if (p >= 0 && list[p].v === '.') continue;
        // Up to four parts: [db.][schema.]name, db..name
        const parts = [word];
        const ends = [i];
        let k = i;
        for (;;) {
            const dot = sigAt(k + 1);
            if (list[dot]?.v !== '.') break;
            const next = sigAt(dot + 1);
            if (list[next]?.v === '.') {
                // db..name: the schema left out
                parts.push('');
                ends.push(dot);
                const after = sigAt(next + 1);
                if (!plain(list[after])) break;
                parts.push(plain(list[after]));
                ends.push(after);
                k = after;
                continue;
            }
            if (!plain(list[next])) break;
            parts.push(plain(list[next]));
            ends.push(next);
            k = next;
        }
        let key = '';
        let end = -1;
        for (let n = parts.length; n >= 1 && !key; n--) {
            const tail = parts.slice(0, n);
            const last = tail[tail.length - 1];
            const schema = tail.length >= 2 ? tail[tail.length - 2] : '';
            if ((schema === 'information_schema' || schema === 'sys') && VIEW_NAMES.has(`${schema}.${last}`)) key = `${schema}.${last}`;
            else if (last === 'sysobjects' && (schema === '' || schema === 'dbo' || schema === 'sys')) key = 'sys.sysobjects';
            if (key) end = ends[n - 1];
        }
        if (!key) continue;
        // A function call such as sys.fn_x(…) isn't a view
        if (list[sigAt(end + 1)]?.v === '(') continue;
        ensure(key);
        list.splice(i, end - i + 1, { t: 'word', v: physical(key) });
        changed = true;
    }
    return changed;
}

/**
 * Makes (or remakes) the TEMP view for a catalog key.
 * @param {any} db
 * @param {string} key
 * @param {string} dbName
 */
export function createCatalogView(db, key, dbName) {
    const sql = viewSql(key, dbName, hasModulesTable(db));
    if (!sql) return;
    const name = physical(key);
    db.exec(`DROP VIEW IF EXISTS temp.${name}`);
    db.exec(`CREATE TEMP VIEW ${name} AS ${sql}`);
}

/** Registers the helper functions the views use. */
export function registerCatalogFunctions(db) {
    db.createFunction({ name: 'sqllab_type', arity: 2, deterministic: true, xFunc: (/** @type {any} */ _c, /** @type {any} */ t, /** @type {any} */ part) => typePart(t, part) });
    db.createFunction({ name: 'sqllab_pk_name', arity: 2, deterministic: true, xFunc: (/** @type {any} */ _c, /** @type {any} */ sql, /** @type {any} */ table) => pkName(sql, table) });
    db.createFunction({ name: 'sqllab_fk_name', arity: 5, deterministic: true,
        xFunc: (/** @type {any} */ _c, /** @type {any} */ sql, /** @type {any} */ table, /** @type {any} */ ref, /** @type {any} */ id, /** @type {any} */ count) => fkName(sql, table, ref, Number(id), Number(count)) });
}

// ---- system procedures

/**
 * @typedef {{
 *   db: any, dbName: string,
 *   grid: (columns: string[], rows: unknown[][], title: string) => void,
 *   print: (text: string) => void,
 *   modules: () => import('./modules.js').ModuleRow[],
 *   findModule: (name: string) => import('./modules.js').ModuleRow | null,
 *   renameModule: (id: number, name: string) => void,
 *   fail: (message: string, number: number) => never
 * }} SysContext
 */

/** The system procedures and the names of their parameters, in order. */
export const SYSTEM_PROCEDURES = /** @type {Record<string, string[]>} */ ({
    sp_help: ['@objname'],
    sp_helptext: ['@objname', '@columnname'],
    sp_columns: ['@table_name', '@table_owner', '@table_qualifier', '@column_name'],
    sp_tables: ['@table_name', '@table_owner', '@table_qualifier', '@table_type'],
    sp_rename: ['@objname', '@newname', '@objtype'],
    sp_helpindex: ['@objname'],
    sp_helpconstraint: ['@objname'],
    sp_stored_procedures: ['@sp_name', '@sp_owner', '@sp_qualifier'],
    sp_databases: [],
    sp_helpdb: ['@dbname'],
    sp_spaceused: ['@objname'],
    sp_who: ['@loginame'],
    sp_who2: ['@loginame'],
    sp_pkeys: ['@table_name', '@table_owner', '@table_qualifier'],
    sp_fkeys: ['@pktable_name', '@pktable_owner', '@pktable_qualifier', '@fktable_name']
});

const like = (/** @type {unknown} */ pattern) => {
    if (pattern === null || pattern === undefined) return () => true;
    const re = new RegExp(`^${String(pattern).replace(/[.*+?^${}()|\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.').replace(/\[([^\]]+)\]/g, '[$1]')}$`, 'i');
    return (/** @type {string} */ s) => re.test(s);
};

/** A user table or view by its written name. */
function findObject(db, written) {
    const { name } = splitName(String(written));
    return db.selectObject(`SELECT rowid AS id, name, type, sql, tbl_name FROM main.sqlite_schema WHERE type IN ('table', 'view', 'trigger', 'index') AND name = ? COLLATE NOCASE AND ${USER_TABLES}`, [name]) || null;
}

function columnsOf(db, table) {
    return db.selectObjects('SELECT cid, name, type, "notnull" AS nn, dflt_value AS dflt, pk FROM pragma_table_info(?, \'main\')', [table]);
}

function indexesOf(db, table, sql) {
    const out = [];
    const cols = columnsOf(db, table);
    const pk = cols.filter((/** @type {any} */ c) => c.pk > 0).sort((/** @type {any} */ a, /** @type {any} */ b) => a.pk - b.pk);
    const rowidPk = pk.length === 1 && String(pk[0].type).toUpperCase() === 'INTEGER';
    if (rowidPk) out.push({ name: pkName(sql, table), description: 'clustered, unique, primary key located on PRIMARY', keys: pk[0].name, kind: 'pk' });
    for (const il of db.selectObjects('SELECT seq, name, "unique" AS uniq, origin FROM pragma_index_list(?, \'main\')', [table])) {
        const keys = db.selectObjects('SELECT name, seqno FROM pragma_index_info(?, \'main\') ORDER BY seqno', [il.name]).map((/** @type {any} */ c) => c.name).join(', ');
        const name = il.origin === 'pk' ? pkName(sql, table) : il.origin === 'u' ? `UQ_${table}_${il.seq}` : il.name;
        const description = `nonclustered${il.uniq ? ', unique' : ''}${il.origin === 'pk' ? ', primary key' : il.origin === 'u' ? ', unique key' : ''} located on PRIMARY`;
        out.push({ name, description, keys, kind: il.origin });
    }
    return out;
}

function foreignKeysOf(db, table, sql) {
    const rows = db.selectObjects('SELECT id, seq, "table" AS ref, "from" AS col, "to" AS refcol, on_update, on_delete FROM pragma_foreign_key_list(?, \'main\') ORDER BY id, seq', [table]);
    const count = new Set(rows.map((/** @type {any} */ r) => r.id)).size;
    /** @type {Map<number, any>} */
    const keys = new Map();
    for (const r of rows) {
        if (!keys.has(r.id)) keys.set(r.id, { name: fkName(sql, table, r.ref, r.id, count), ref: r.ref, columns: [], refColumns: [], onDelete: r.on_delete, onUpdate: r.on_update });
        keys.get(r.id).columns.push(r.col);
        keys.get(r.id).refColumns.push(r.refcol);
    }
    return [...keys.values()].reverse();
}

const nullable = (/** @type {any} */ c) => (c.nn || c.pk > 0 ? 'no' : 'yes');
const isIdentity = (/** @type {any} */ c, /** @type {string} */ sql) => c.pk === 1 && String(c.type).toUpperCase() === 'INTEGER' && /AUTOINCREMENT/i.test(sql || '');

/**
 * Runs a system procedure.
 * @param {SysContext} ctx
 * @param {string} name lower case, e.g. sp_help
 * @param {Record<string, unknown>} args by parameter name (lower case)
 */
export function runSystemProcedure(ctx, name, args) {
    const { db, dbName, grid, print, fail } = ctx;
    const arg = (/** @type {string} */ key) => {
        const v = args[key];
        return v === undefined || v === null ? null : String(v);
    };
    switch (name) {
    case 'sp_help': {
        const target = arg('@objname');
        if (!target) {
            const rows = db.selectObjects(`SELECT name, type FROM main.sqlite_schema WHERE type IN ('table', 'view', 'trigger') AND ${USER_TABLES} ORDER BY name COLLATE NOCASE`)
                .map((/** @type {any} */ o) => [o.name, 'dbo', o.type === 'table' ? 'user table' : o.type === 'view' ? 'view' : 'trigger']);
            for (const m of ctx.modules()) rows.push([m.name, m.schema, m.kind === 'P' ? 'stored procedure' : m.kind === 'TR' ? 'trigger' : 'function']);
            rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
            grid(['Name', 'Owner', 'Object_type'], rows, 'sp_help');
            return;
        }
        const mod = ctx.findModule(target);
        if (mod) {
            grid(['Name', 'Owner', 'Type', 'Created_datetime'], [[mod.name, mod.schema, mod.kind === 'P' ? 'stored procedure' : mod.kind === 'TR' ? 'trigger' : mod.kind === 'FN' ? 'scalar function' : mod.kind === 'IF' ? 'inline function' : 'table function', mod.created]], 'sp_help');
            if (mod.params.length) {
                grid(['Parameter_name', 'Type', 'Length', 'Prec', 'Scale', 'Param_order', 'Collation'], mod.params.map((p, k) => {
                    const t = typeInfo(p.type);
                    return [p.name, t.name, t.maxLength, t.precision, t.scale, k + 1, t.charLength !== null ? 'SQL_Latin1_General_CP1_CI_AS' : null];
                }), 'sp_help parameters');
            }
            return;
        }
        const obj = findObject(db, target);
        if (!obj || (obj.type !== 'table' && obj.type !== 'view')) fail(`The object '${target}' does not exist in database '${dbName}' or is invalid for this operation.`, 15009);
        grid(['Name', 'Owner', 'Type', 'Created_datetime'], [[obj.name, 'dbo', obj.type === 'table' ? 'user table' : 'view', null]], 'sp_help');
        const cols = columnsOf(db, obj.name);
        grid(['Column_name', 'Type', 'Computed', 'Length', 'Prec', 'Scale', 'Nullable', 'TrimTrailingBlanks', 'FixedLenNullInSource', 'Collation'], cols.map((/** @type {any} */ c) => {
            const t = typeInfo(c.type);
            const numeric = ['tinyint', 'smallint', 'int', 'bigint', 'decimal', 'numeric', 'float', 'real', 'money', 'smallmoney', 'bit'].includes(t.name);
            return [c.name, t.name, 'no', t.maxLength, numeric ? String(t.precision) : '', numeric ? String(t.scale) : '', nullable(c), t.charLength !== null ? 'no' : '(n/a)', t.charLength !== null ? 'no' : '(n/a)', t.charLength !== null ? 'SQL_Latin1_General_CP1_CI_AS' : null];
        }), 'sp_help columns');
        if (obj.type === 'view') return;
        const identity = cols.find((/** @type {any} */ c) => isIdentity(c, obj.sql));
        grid(['Identity', 'Seed', 'Increment', 'Not For Replication'], [identity ? [identity.name, 1, 1, 0] : ['No identity column defined.', null, null, null]], 'sp_help identity');
        grid(['RowGuidCol'], [['No rowguidcol column defined.']], 'sp_help rowguidcol');
        grid(['Data_located_on_filegroup'], [['PRIMARY']], 'sp_help filegroup');
        const indexes = indexesOf(db, obj.name, obj.sql);
        if (indexes.length) grid(['index_name', 'index_description', 'index_keys'], indexes.map(ix => [ix.name, ix.description, ix.keys]), 'sp_help indexes');
        else print(`The object '${obj.name}' does not have any indexes, or you do not have permissions.`);
        const constraints = constraintRows(db, obj);
        if (constraints.length) grid(['constraint_type', 'constraint_name', 'delete_action', 'update_action', 'status_enabled', 'status_for_replication', 'constraint_keys'], constraints, 'sp_help constraints');
        else print(`No constraints are defined on object '${obj.name}', or you do not have permissions.`);
        const referencedBy = [];
        for (const t of db.selectObjects(`SELECT name, sql FROM main.sqlite_schema WHERE type = 'table' AND ${USER_TABLES}`)) {
            for (const fk of foreignKeysOf(db, t.name, t.sql)) if (String(fk.ref).toLowerCase() === obj.name.toLowerCase()) referencedBy.push([`${dbName}.dbo.${t.name}: ${fk.name}`]);
        }
        if (referencedBy.length) grid(['Table is referenced by foreign key'], referencedBy, 'sp_help references');
        return;
    }
    case 'sp_helpconstraint': {
        const target = arg('@objname');
        const obj = target ? findObject(db, target) : null;
        if (!obj || obj.type !== 'table') fail(`The object '${target}' does not exist in database '${dbName}' or is invalid for this operation.`, 15009);
        grid(['Object Name'], [[obj.name]], 'sp_helpconstraint');
        const rows = constraintRows(db, obj);
        if (rows.length) grid(['constraint_type', 'constraint_name', 'delete_action', 'update_action', 'status_enabled', 'status_for_replication', 'constraint_keys'], rows, 'sp_helpconstraint');
        else print(`No constraints are defined on object '${obj.name}', or you do not have permissions.`);
        return;
    }
    case 'sp_helptext': {
        const target = arg('@objname');
        if (!target) fail('Procedure or function \'sp_helptext\' expects parameter \'@objname\', which was not supplied.', 201);
        const mod = ctx.findModule(target);
        const obj = mod ? null : findObject(db, target);
        if (!mod && !obj) fail(`The object '${target}' does not exist in database '${dbName}' or is invalid for this operation.`, 15009);
        const text = mod ? mod.definition : obj.type === 'view' || obj.type === 'trigger' ? obj.sql : null;
        if (!text) fail(`There is no text for object '${target}'.`, 15197);
        grid(['Text'], String(text).split('\n').map(line => [`${line.replace(/\r$/, '')}\r\n`]), 'sp_helptext');
        return;
    }
    case 'sp_columns': {
        const table = arg('@table_name');
        if (!table) fail('Procedure or function \'sp_columns\' expects parameter \'@table_name\', which was not supplied.', 201);
        const match = like(table);
        const colMatch = like(arg('@column_name'));
        const rows = [];
        for (const o of db.selectObjects(`SELECT name FROM main.sqlite_schema WHERE type IN ('table', 'view') AND ${USER_TABLES} ORDER BY name COLLATE NOCASE`)) {
            if (!match(o.name)) continue;
            for (const c of columnsOf(db, o.name)) {
                if (!colMatch(c.name)) continue;
                const t = typeInfo(c.type);
                const length = t.charLength !== null ? (t.charLength === -1 ? 2147483647 : t.charLength) : t.precision;
                rows.push([dbName, 'dbo', o.name, c.name, t.typeId, t.name, length, t.maxLength, t.charLength !== null ? null : t.scale, t.charLength !== null ? null : 10,
                    c.nn || c.pk > 0 ? 0 : 1, null, c.dflt, c.cid + 1, nullable(c).toUpperCase()]);
            }
        }
        grid(['TABLE_QUALIFIER', 'TABLE_OWNER', 'TABLE_NAME', 'COLUMN_NAME', 'DATA_TYPE', 'TYPE_NAME', 'PRECISION', 'LENGTH', 'SCALE', 'RADIX', 'NULLABLE', 'REMARKS', 'COLUMN_DEF', 'ORDINAL_POSITION', 'IS_NULLABLE'], rows, 'sp_columns');
        return;
    }
    case 'sp_tables': {
        const match = like(arg('@table_name'));
        const types = arg('@table_type');
        const rows = db.selectObjects(`SELECT name, type FROM main.sqlite_schema WHERE type IN ('table', 'view') AND ${USER_TABLES} ORDER BY name COLLATE NOCASE`)
            .filter((/** @type {any} */ o) => match(o.name))
            .map((/** @type {any} */ o) => [dbName, 'dbo', o.name, o.type === 'table' ? 'TABLE' : 'VIEW', null])
            .filter((/** @type {any[]} */ r) => !types || types.toUpperCase().includes(`'${r[3]}'`));
        grid(['TABLE_QUALIFIER', 'TABLE_OWNER', 'TABLE_NAME', 'TABLE_TYPE', 'REMARKS'], rows, 'sp_tables');
        return;
    }
    case 'sp_helpindex': {
        const target = arg('@objname');
        const obj = target ? findObject(db, target) : null;
        if (!obj || obj.type !== 'table') fail(`The object '${target}' does not exist in database '${dbName}' or is invalid for this operation.`, 15009);
        const indexes = indexesOf(db, obj.name, obj.sql);
        if (!indexes.length) {
            print(`The object '${obj.name}' does not have any indexes, or you do not have permissions.`);
            return;
        }
        grid(['index_name', 'index_description', 'index_keys'], indexes.map(ix => [ix.name, ix.description, ix.keys]), 'sp_helpindex');
        return;
    }
    case 'sp_pkeys': {
        const target = arg('@table_name');
        const obj = target ? findObject(db, target) : null;
        if (!obj || obj.type !== 'table') {
            grid(['TABLE_QUALIFIER', 'TABLE_OWNER', 'TABLE_NAME', 'COLUMN_NAME', 'KEY_SEQ', 'PK_NAME'], [], 'sp_pkeys');
            return;
        }
        const rows = columnsOf(db, obj.name).filter((/** @type {any} */ c) => c.pk > 0).sort((/** @type {any} */ a, /** @type {any} */ b) => a.pk - b.pk)
            .map((/** @type {any} */ c) => [dbName, 'dbo', obj.name, c.name, c.pk, pkName(obj.sql, obj.name)]);
        grid(['TABLE_QUALIFIER', 'TABLE_OWNER', 'TABLE_NAME', 'COLUMN_NAME', 'KEY_SEQ', 'PK_NAME'], rows, 'sp_pkeys');
        return;
    }
    case 'sp_fkeys': {
        const pkTable = arg('@pktable_name');
        const fkTable = arg('@fktable_name');
        const rows = [];
        for (const t of db.selectObjects(`SELECT name, sql FROM main.sqlite_schema WHERE type = 'table' AND ${USER_TABLES}`)) {
            if (fkTable && t.name.toLowerCase() !== splitName(fkTable).name.toLowerCase()) continue;
            for (const fk of foreignKeysOf(db, t.name, t.sql)) {
                if (pkTable && String(fk.ref).toLowerCase() !== splitName(pkTable).name.toLowerCase()) continue;
                const ref = findObject(db, fk.ref);
                fk.columns.forEach((/** @type {string} */ col, /** @type {number} */ k) => {
                    rows.push([dbName, 'dbo', fk.ref, fk.refColumns[k] ?? columnsOf(db, fk.ref).find((/** @type {any} */ c) => c.pk === k + 1)?.name ?? null,
                        dbName, 'dbo', t.name, col, k + 1, ruleCode(fk.onUpdate), ruleCode(fk.onDelete), fk.name, ref ? pkName(ref.sql, ref.name) : null, 7]);
                });
            }
        }
        grid(['PKTABLE_QUALIFIER', 'PKTABLE_OWNER', 'PKTABLE_NAME', 'PKCOLUMN_NAME', 'FKTABLE_QUALIFIER', 'FKTABLE_OWNER', 'FKTABLE_NAME', 'FKCOLUMN_NAME', 'KEY_SEQ', 'UPDATE_RULE', 'DELETE_RULE', 'FK_NAME', 'PK_NAME', 'DEFERRABILITY'], rows, 'sp_fkeys');
        return;
    }
    case 'sp_stored_procedures': {
        const match = like(arg('@sp_name'));
        const rows = ctx.modules().filter(m => m.kind === 'P' && match(m.name)).map(m => [dbName, m.schema, `${m.name};1`, -1, -1, -1, null, 2]);
        grid(['PROCEDURE_QUALIFIER', 'PROCEDURE_OWNER', 'PROCEDURE_NAME', 'NUM_INPUT_PARAMS', 'NUM_OUTPUT_PARAMS', 'NUM_RESULT_SETS', 'REMARKS', 'PROCEDURE_TYPE'], rows, 'sp_stored_procedures');
        return;
    }
    case 'sp_databases':
        grid(['DATABASE_NAME', 'DATABASE_SIZE', 'REMARKS'], [[dbName, Math.round(databaseBytes(db) / 1024), null]], 'sp_databases');
        return;
    case 'sp_helpdb': {
        const size = `${(databaseBytes(db) / 1048576).toFixed(2)} MB`;
        grid(['name', 'db_size', 'owner', 'dbid', 'created', 'status', 'compatibility_level'], [[dbName, size, 'sa', 5, null, 'Status=ONLINE, Recovery=SIMPLE', 160]], 'sp_helpdb');
        return;
    }
    case 'sp_spaceused': {
        const target = arg('@objname');
        if (!target) {
            const bytes = databaseBytes(db);
            const free = Number(db.selectValue('PRAGMA freelist_count')) * Number(db.selectValue('PRAGMA page_size'));
            grid(['database_name', 'database_size', 'unallocated space'], [[dbName, `${(bytes / 1048576).toFixed(2)} MB`, `${(free / 1048576).toFixed(2)} MB`]], 'sp_spaceused');
            return;
        }
        const obj = findObject(db, target);
        if (!obj || obj.type !== 'table') fail(`The object '${target}' does not exist in database '${dbName}' or is invalid for this operation.`, 15009);
        const rows = Number(db.selectValue(`SELECT COUNT(*) FROM main."${obj.name.replace(/"/g, '""')}"`));
        let data = null;
        let index = null;
        try {
            const pageSize = Number(db.selectValue('PRAGMA page_size'));
            data = Number(db.selectValue('SELECT COUNT(*) FROM dbstat(\'main\') WHERE name = ?', [obj.name])) * pageSize;
            index = Number(db.selectValue('SELECT COUNT(*) FROM dbstat(\'main\') WHERE name IN (SELECT name FROM pragma_index_list(?, \'main\'))', [obj.name])) * pageSize;
        } catch {
            // dbstat isn't in every SQLite build
        }
        const kb = (/** @type {number | null} */ n) => (n === null ? null : `${Math.round(n / 1024)} KB`);
        grid(['name', 'rows', 'reserved', 'data', 'index_size', 'unused'], [[obj.name, String(rows), kb(data === null ? null : data + (index || 0)), kb(data), kb(index), '0 KB']], 'sp_spaceused');
        return;
    }
    case 'sp_who':
    case 'sp_who2':
        grid(['spid', 'ecid', 'status', 'loginame', 'hostname', 'blk', 'dbname', 'cmd', 'request_id'], [[51, 0, 'runnable', 'sa', 'SQLLAB', '0', dbName, 'SELECT', 0]], name);
        return;
    case 'sp_rename':
        rename(ctx, arg('@objname'), arg('@newname'), arg('@objtype'));
        return;
    default:
        fail(`Could not find stored procedure '${name}'.`, 2812);
    }
}

const ruleCode = (/** @type {string} */ action) => ({ CASCADE: 0, 'NO ACTION': 1, RESTRICT: 1, 'SET NULL': 2, 'SET DEFAULT': 3 })[String(action).toUpperCase()] ?? 1;

function databaseBytes(db) {
    return Number(db.selectValue('PRAGMA page_count')) * Number(db.selectValue('PRAGMA page_size'));
}

function constraintRows(db, obj) {
    const rows = [];
    for (const ix of indexesOf(db, obj.name, obj.sql)) {
        if (ix.kind === 'pk') rows.push([`PRIMARY KEY (${ix.description.startsWith('clustered') ? 'clustered' : 'non-clustered'})`, ix.name, '(n/a)', '(n/a)', '(n/a)', '(n/a)', ix.keys]);
        else if (ix.kind === 'u') rows.push(['UNIQUE (non-clustered)', ix.name, '(n/a)', '(n/a)', '(n/a)', '(n/a)', ix.keys]);
    }
    for (const fk of foreignKeysOf(db, obj.name, obj.sql)) {
        const action = (/** @type {string} */ a) => (String(a).toUpperCase() === 'CASCADE' ? 'Cascade' : String(a).toUpperCase() === 'SET NULL' ? 'Set_Null' : String(a).toUpperCase() === 'SET DEFAULT' ? 'Set_Default' : 'No Action');
        rows.push(['FOREIGN KEY', fk.name, action(fk.onDelete), action(fk.onUpdate), 'Enabled', 'Is_For_Replication', fk.columns.join(', ')]);
        rows.push([' ', ' ', ' ', ' ', ' ', ' ', `REFERENCES ${obj.name === fk.ref ? obj.name : fk.ref} (${fk.refColumns.filter(Boolean).join(', ')})`]);
    }
    const sql = String(obj.sql || '');
    const checks = [...sql.matchAll(/\bCONSTRAINT\s+(\[[^\]]+\]|"[^"]+"|[\w$#@]+)\s+CHECK\s*\(/gi)];
    for (const m of checks) rows.push(['CHECK on table', unquote(m[1]), '(n/a)', '(n/a)', 'Enabled', 'Is_For_Replication', '']);
    return rows;
}

const ident = (/** @type {string} */ s) => `"${String(s).replace(/"/g, '""')}"`;

function rename(ctx, objname, newname, objtype) {
    const { db, print, fail } = ctx;
    if (!objname || !newname) fail('Procedure or function \'sp_rename\' expects parameters \'@objname\' and \'@newname\'.', 201);
    const type = String(objtype || '').toUpperCase();
    const target = unquote(String(newname));
    if (type === 'COLUMN') {
        const parts = String(objname).split('.');
        if (parts.length < 2) fail('Either the parameter @objname is ambiguous or the claimed @objtype (COLUMN) is wrong.', 15248);
        const column = unquote(parts.pop() || '');
        const table = findObject(db, parts.join('.'));
        if (!table || table.type !== 'table' || !columnsOf(db, table.name).some((/** @type {any} */ c) => c.name.toLowerCase() === column.toLowerCase())) {
            fail('Either the parameter @objname is ambiguous or the claimed @objtype (COLUMN) is wrong.', 15248);
        }
        db.exec(`ALTER TABLE ${ident(table.name)} RENAME COLUMN ${ident(column)} TO ${ident(target)}`);
    } else if (type === 'INDEX') {
        const parts = String(objname).split('.');
        const name = unquote(parts.pop() || '');
        const index = db.selectObject('SELECT name, sql FROM main.sqlite_schema WHERE type = \'index\' AND name = ? COLLATE NOCASE', [name]);
        if (!index || !index.sql) fail('Either the parameter @objname is ambiguous or the claimed @objtype (INDEX) is wrong.', 15248);
        const sql = String(index.sql).replace(/^(\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?)(\[[^\]]+\]|"(?:[^"]|"")+"|`[^`]+`|[\w$#@]+)/i, `$1${ident(target)}`);
        db.exec(`DROP INDEX ${ident(index.name)}`);
        db.exec(sql);
    } else if (type === '' || type === 'OBJECT') {
        const mod = ctx.findModule(String(objname));
        if (mod) ctx.renameModule(mod.id, target);
        else {
            const obj = findObject(db, String(objname));
            if (!obj) fail(`Either the parameter @objname is ambiguous or the claimed @objtype (${type || 'OBJECT'}) is wrong.`, 15248);
            if (obj.type !== 'table') fail('sp_rename renames tables, columns, indexes, procedures and functions in SQL Lab. Drop the view and create it again with the new name.', 15225);
            db.exec(`ALTER TABLE ${ident(obj.name)} RENAME TO ${ident(target)}`);
        }
    } else fail(`Either the parameter @objname is ambiguous or the claimed @objtype (${type}) is wrong.`, 15248);
    print('Caution: Changing any part of an object name could break scripts and stored procedures.');
}
