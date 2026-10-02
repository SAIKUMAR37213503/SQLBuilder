// Column types for imported CSV and JSON data: which type each column's
// values fit, the type suggested for it, and the CREATE TABLE / INSERT SQL.
// Values are stored as they were read; SQLite applies the column's type
// itself (its "type affinity"), so "42" in an INTEGER column becomes 42 and
// "007" in a TEXT column stays "007".

import { sqliteName } from './schema-sql.js';

/** The types offered for a new table's columns. SQLite has no date type: dates are stored as text. */
export const COLUMN_TYPES = ['INTEGER', 'REAL', 'TEXT', 'DATE', 'DATETIME', 'BOOLEAN'];

export const TYPE_LABELS = {
    INTEGER: 'whole numbers',
    REAL: 'numbers',
    TEXT: 'text',
    DATE: 'dates (2024-01-31)',
    DATETIME: 'dates with times (2024-01-31 09:30)',
    BOOLEAN: 'true or false'
};

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
// No leading zeros (007 stays text, as a code would) and no spaces
const INTEGER_TEXT = /^[+-]?(?:0|[1-9]\d*)$/;
const REAL_TEXT = /^[+-]?(?:(?:0|[1-9]\d*)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_TEXT = /^(\d{4})-(\d{2})-(\d{2})[T ]([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)?$/;

function validDate(year, month, day) {
    const m = Number(month);
    const d = Number(day);
    if (m < 1 || m > 12 || d < 1) return false;
    const days = new Date(Date.UTC(Number(year), m, 0)).getUTCDate();
    return d <= days;
}

const isEmpty = (/** @type {unknown} */ value) => value === null || value === undefined;

/**
 * Whether a value (as read from the file) is a value of `type`.
 * @param {unknown} value
 * @param {string} type
 */
export function fitsType(value, type) {
    if (isEmpty(value)) return true;
    if (type === 'TEXT') return true;
    if (typeof value === 'boolean') return type === 'BOOLEAN';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return false;
        return type === 'REAL' || (type === 'INTEGER' && Number.isInteger(value));
    }
    if (typeof value !== 'string') return false;
    switch (type) {
        case 'INTEGER':
            if (!INTEGER_TEXT.test(value)) return false;
            return BigInt(value) >= INT64_MIN && BigInt(value) <= INT64_MAX;
        case 'REAL':
            return REAL_TEXT.test(value) && Number.isFinite(Number(value));
        case 'DATE': {
            const m = DATE_TEXT.exec(value);
            return Boolean(m && validDate(m[1], m[2], m[3]));
        }
        case 'DATETIME': {
            const m = DATETIME_TEXT.exec(value) || DATE_TEXT.exec(value);
            return Boolean(m && validDate(m[1], m[2], m[3]));
        }
        default:
            return false;
    }
}

/**
 * For each column: how many values it has and how many fit each type, and
 * the narrowest type they all fit (TEXT when there are none).
 * @param {unknown[][]} rows
 * @param {number} count number of columns
 */
export function describeColumns(rows, count) {
    const columns = Array.from({ length: count }, () => ({
        nonEmpty: 0,
        fits: /** @type {Record<string, number>} */ (Object.fromEntries(COLUMN_TYPES.map(t => [t, 0])))
    }));
    for (const row of rows) {
        for (let c = 0; c < count; c++) {
            const value = row[c];
            if (isEmpty(value)) continue;
            const column = columns[c];
            column.nonEmpty++;
            for (const type of COLUMN_TYPES) if (fitsType(value, type)) column.fits[type]++;
        }
    }
    return columns.map(column => {
        const all = (/** @type {string} */ t) => column.nonEmpty > 0 && column.fits[t] === column.nonEmpty;
        const type = ['BOOLEAN', 'INTEGER', 'REAL', 'DATE', 'DATETIME'].find(all) || 'TEXT';
        return { ...column, type };
    });
}

/**
 * Column names that SQLite accepts together: blanks get a name and repeats
 * (SQLite ignores case) get a number.
 * @param {string[]} names
 */
export function uniqueNames(names) {
    const used = new Set();
    return names.map((raw, i) => {
        const base = String(raw ?? '').trim() || `column${i + 1}`;
        let name = base;
        for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}_${n}`;
        used.add(name.toLowerCase());
        return name;
    });
}

/** A value as it is bound to the INSERT: booleans become 1 and 0 (SQLite has no boolean). */
export function bindValue(/** @type {unknown} */ value) {
    if (isEmpty(value)) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
}

/**
 * @param {string} table
 * @param {{ name: string, type: string }[]} columns
 */
export function createTableSql(table, columns) {
    return `CREATE TABLE ${sqliteName(table)} (\n${columns.map(c => `    ${sqliteName(c.name)} ${c.type}`).join(',\n')}\n);`;
}

/**
 * The INSERT run once per row, with a ? for each value (never values in the SQL text).
 * @param {string} table
 * @param {string[]} columns
 */
export function insertSql(table, columns) {
    return `INSERT INTO ${sqliteName(table)} (${columns.map(sqliteName).join(', ')}) VALUES (${columns.map(() => '?').join(', ')});`;
}
