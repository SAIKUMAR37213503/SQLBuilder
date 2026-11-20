// Functions SQL Server, PostgreSQL and MySQL have and SQLite doesn't, added
// to every database SQL Lab opens, so queries written for those languages run
// (with dialect-translate.js, which rewrites the syntax around them).
//
// Dates: SQLite keeps dates as text ('2024-05-31' or '2024-05-31 13:45:00'),
// so these functions read that text and write it back in the same form: a
// date stays a date, a date and time keeps its time. All times are UTC, as
// in SQLite's own date functions.

import { registerCatalogFunctions, typeInfo, typeName as systemTypeName } from './tsql/catalog.js';
import { hasModulesTable, MODULE_ID_BASE, MODULES_TABLE } from './tsql/modules.js';

const pad = (/** @type {number} */ n, w = 2) => String(Math.trunc(Math.abs(n))).padStart(w, '0');

/** A date from SQLite text, a Julian day or Unix seconds; null for NULL or text that isn't a date. */
export function toDate(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' || typeof value === 'bigint') {
        const n = Number(value);
        // Julian day numbers (what julianday() returns) are about 2.4 million
        return new Date(n > 1e6 && n < 1e7 ? (n - 2440587.5) * 86400000 : n * 1000);
    }
    const m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,7}))?)?)?\s*(?:Z|[+-]00:?00)?\s*$/i.exec(String(value));
    if (m) {
        const ms = m[7] ? Math.round(Number(`0.${m[7]}`) * 1000) : 0;
        return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0), ms));
    }
    const t = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(String(value));
    if (t) return new Date(Date.UTC(1900, 0, 1, Number(t[1]), Number(t[2]), Number(t[3] || 0)));
    const parsed = Date.parse(String(value));
    return Number.isNaN(parsed) ? null : new Date(parsed);
}

const hasTime = (/** @type {unknown} */ value) => typeof value !== 'string' || /\d:\d/.test(value);
const dateText = (/** @type {Date} */ d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const dateTimeText = (/** @type {Date} */ d) => `${dateText(d)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
/** The date written back like the input was: with its time only when it had one. */
const like = (/** @type {unknown} */ input, /** @type {Date} */ d) => (hasTime(input) ? dateTimeText(d) : dateText(d));

/** A date part as one of: year quarter month week day hour minute second millisecond dayofyear weekday. */
export function datePart(part) {
    const p = String(part ?? '').toLowerCase().replace(/^'|'$/g, '').trim();
    const map = {
        year: 'year', yy: 'year', yyyy: 'year', years: 'year', y: 'year',
        quarter: 'quarter', qq: 'quarter', q: 'quarter', quarters: 'quarter',
        month: 'month', mm: 'month', m: 'month', months: 'month', mon: 'month', mons: 'month',
        week: 'week', wk: 'week', ww: 'week', weeks: 'week', isowk: 'week', isoww: 'week', iso_week: 'week',
        day: 'day', dd: 'day', d: 'day', days: 'day',
        dayofyear: 'dayofyear', dy: 'dayofyear', doy: 'dayofyear',
        weekday: 'weekday', dw: 'weekday', dow: 'weekday', w: 'weekday', isodow: 'weekday',
        hour: 'hour', hh: 'hour', hours: 'hour',
        minute: 'minute', mi: 'minute', n: 'minute', minutes: 'minute',
        second: 'second', ss: 'second', s: 'second', seconds: 'second',
        millisecond: 'millisecond', ms: 'millisecond', milliseconds: 'millisecond',
        microsecond: 'microsecond', mcs: 'microsecond', microseconds: 'microsecond'
    };
    return /** @type {any} */ (map)[p] || null;
}

/** The date plus `n` of a part (months clamp to the month's last day, as SQL Server does). */
export function addTo(date, part, n) {
    const d = new Date(date.getTime());
    const k = Math.trunc(Number(n));
    switch (part) {
        case 'year': return addMonths(d, 12 * k);
        case 'quarter': return addMonths(d, 3 * k);
        case 'month': return addMonths(d, k);
        case 'week': d.setUTCDate(d.getUTCDate() + 7 * k); return d;
        case 'day': case 'dayofyear': case 'weekday': d.setUTCDate(d.getUTCDate() + k); return d;
        case 'hour': return new Date(d.getTime() + k * 3600000);
        case 'minute': return new Date(d.getTime() + k * 60000);
        case 'second': return new Date(d.getTime() + k * 1000);
        case 'millisecond': return new Date(d.getTime() + k);
        default: return null;
    }
}
function addMonths(d, k) {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + k);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return d;
}

/** SQL Server's DATEDIFF: the number of part boundaries crossed from a to b. */
export function diff(part, a, b) {
    const y = b.getUTCFullYear() - a.getUTCFullYear();
    const startOfDay = (/** @type {Date} */ d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    switch (part) {
        case 'year': return y;
        case 'quarter': return y * 4 + Math.floor(b.getUTCMonth() / 3) - Math.floor(a.getUTCMonth() / 3);
        case 'month': return y * 12 + b.getUTCMonth() - a.getUTCMonth();
        case 'week': {
            // Weeks start on Sunday
            const sunday = (/** @type {Date} */ d) => startOfDay(d) - d.getUTCDay() * 86400000;
            return Math.round((sunday(b) - sunday(a)) / 604800000);
        }
        case 'day': case 'dayofyear': case 'weekday': return Math.round((startOfDay(b) - startOfDay(a)) / 86400000);
        case 'hour': return Math.floor(b.getTime() / 3600000) - Math.floor(a.getTime() / 3600000);
        case 'minute': return Math.floor(b.getTime() / 60000) - Math.floor(a.getTime() / 60000);
        case 'second': return Math.floor(b.getTime() / 1000) - Math.floor(a.getTime() / 1000);
        case 'millisecond': return b.getTime() - a.getTime();
        default: return null;
    }
}

/** One part of a date as a number (weekday: Sunday is 1, as in SQL Server). */
export function partOf(part, d) {
    switch (part) {
        case 'year': return d.getUTCFullYear();
        case 'quarter': return Math.floor(d.getUTCMonth() / 3) + 1;
        case 'month': return d.getUTCMonth() + 1;
        case 'week': {
            const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
            const firstDay = new Date(jan1).getUTCDay();
            return Math.floor((Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - jan1) / 86400000) + firstDay) / 7) + 1;
        }
        case 'day': return d.getUTCDate();
        case 'dayofyear': return Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1;
        case 'weekday': return d.getUTCDay() + 1;
        case 'hour': return d.getUTCHours();
        case 'minute': return d.getUTCMinutes();
        case 'second': return d.getUTCSeconds();
        case 'millisecond': return d.getUTCMilliseconds();
        default: return null;
    }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** MySQL's DATE_FORMAT(d, '%Y-%m-%d'). */
export function mysqlFormat(d, format) {
    return String(format).replace(/%([a-zA-Z%])/g, (_, c) => {
        switch (c) {
            case 'Y': return String(d.getUTCFullYear());
            case 'y': return pad(d.getUTCFullYear() % 100);
            case 'm': return pad(d.getUTCMonth() + 1);
            case 'c': return String(d.getUTCMonth() + 1);
            case 'M': return MONTHS[d.getUTCMonth()];
            case 'b': return MONTHS[d.getUTCMonth()].slice(0, 3);
            case 'd': return pad(d.getUTCDate());
            case 'e': return String(d.getUTCDate());
            case 'H': return pad(d.getUTCHours());
            case 'k': return String(d.getUTCHours());
            case 'h': case 'I': return pad(((d.getUTCHours() + 11) % 12) + 1);
            case 'l': return String(((d.getUTCHours() + 11) % 12) + 1);
            case 'i': return pad(d.getUTCMinutes());
            case 's': case 'S': return pad(d.getUTCSeconds());
            case 'f': return pad(d.getUTCMilliseconds() * 1000, 6);
            case 'p': return d.getUTCHours() < 12 ? 'AM' : 'PM';
            case 'W': return DAYS[d.getUTCDay()];
            case 'a': return DAYS[d.getUTCDay()].slice(0, 3);
            case 'w': return String(d.getUTCDay());
            case 'j': return pad(partOf('dayofyear', d), 3);
            case 'T': return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
            case 'r': return `${pad(((d.getUTCHours() + 11) % 12) + 1)}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCHours() < 12 ? 'AM' : 'PM'}`;
            case '%': return '%';
            default: return c;
        }
    });
}

/** PostgreSQL's to_char(d, 'YYYY-MM-DD HH24:MI:SS') for the common patterns. */
export function pgFormat(d, format) {
    return String(format).replace(/YYYY|YY|MONTH|Month|MON|Mon|MM|DD|DAY|Day|DY|Dy|HH24|HH12|HH|MI|SS|MS|AM|PM|Q|D/g, (k) => {
        switch (k) {
            case 'YYYY': return String(d.getUTCFullYear());
            case 'YY': return pad(d.getUTCFullYear() % 100);
            case 'MONTH': return MONTHS[d.getUTCMonth()].toUpperCase().padEnd(9);
            case 'Month': return MONTHS[d.getUTCMonth()].padEnd(9);
            case 'MON': return MONTHS[d.getUTCMonth()].slice(0, 3).toUpperCase();
            case 'Mon': return MONTHS[d.getUTCMonth()].slice(0, 3);
            case 'MM': return pad(d.getUTCMonth() + 1);
            case 'DD': return pad(d.getUTCDate());
            case 'DAY': return DAYS[d.getUTCDay()].toUpperCase().padEnd(9);
            case 'Day': return DAYS[d.getUTCDay()].padEnd(9);
            case 'DY': return DAYS[d.getUTCDay()].slice(0, 3).toUpperCase();
            case 'Dy': return DAYS[d.getUTCDay()].slice(0, 3);
            case 'HH24': return pad(d.getUTCHours());
            case 'HH12': case 'HH': return pad(((d.getUTCHours() + 11) % 12) + 1);
            case 'MI': return pad(d.getUTCMinutes());
            case 'SS': return pad(d.getUTCSeconds());
            case 'MS': return pad(d.getUTCMilliseconds(), 3);
            case 'AM': case 'PM': return d.getUTCHours() < 12 ? 'AM' : 'PM';
            case 'Q': return String(partOf('quarter', d));
            case 'D': return String(d.getUTCDay() + 1);
            default: return k;
        }
    });
}

/** SQL Server CONVERT(varchar, date, style) for the common styles. */
export function convertStyle(value, style) {
    const d = toDate(value);
    if (!d) return value;
    const y = d.getUTCFullYear();
    const mm = pad(d.getUTCMonth() + 1);
    const dd = pad(d.getUTCDate());
    const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    switch (Number(style)) {
        case 1: return `${mm}/${dd}/${pad(y % 100)}`;
        case 101: return `${mm}/${dd}/${y}`;
        case 3: return `${dd}/${mm}/${pad(y % 100)}`;
        case 103: return `${dd}/${mm}/${y}`;
        case 4: return `${dd}.${mm}.${pad(y % 100)}`;
        case 104: return `${dd}.${mm}.${y}`;
        case 105: return `${dd}-${mm}-${y}`;
        case 106: return `${dd} ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${y}`;
        case 107: return `${MONTHS[d.getUTCMonth()].slice(0, 3)} ${dd}, ${y}`;
        case 108: return time;
        case 110: return `${mm}-${dd}-${y}`;
        case 111: return `${y}/${mm}/${dd}`;
        case 112: return `${y}${mm}${dd}`;
        case 23: return `${y}-${mm}-${dd}`;
        case 20: case 120: return `${y}-${mm}-${dd} ${time}`;
        case 21: case 121: return `${y}-${mm}-${dd} ${time}.${pad(d.getUTCMilliseconds(), 3)}`;
        case 126: case 127: return `${y}-${mm}-${dd}T${time}`;
        default: return like(value, d);
    }
}

const now = () => new Date();
const uuid = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.floor(Math.random() * 16);
    return (c === 'x' ? r : (r % 4) + 8).toString(16);
}));
const str = (/** @type {unknown} */ v) => (v === null || v === undefined ? null : String(v));
const chars = (/** @type {string} */ s) => [...s];

const DATETIME_TEXT = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/;
const isNumericText = (/** @type {string} */ s) => s.trim() !== '' && !Number.isNaN(Number(s));
const typeName = (/** @type {unknown} */ v) => (typeof v === 'string' ? 'varchar' : Number.isInteger(v) ? 'int' : 'numeric');

/**
 * a + b as SQL Server works it out: numbers add; text joins text; a date
 * and a number add days; text and a number add when the text is a number,
 * and otherwise fail as SQL Server does.
 */
export function tsqlAdd(a, b) {
    if (a === null || b === null || a === undefined || b === undefined) return null;
    if (a instanceof Uint8Array || b instanceof Uint8Array) {
        const x = a instanceof Uint8Array ? a : new TextEncoder().encode(String(a));
        const y = b instanceof Uint8Array ? b : new TextEncoder().encode(String(b));
        const out = new Uint8Array(x.length + y.length);
        out.set(x);
        out.set(y, x.length);
        return out;
    }
    const as = typeof a === 'string';
    const bs = typeof b === 'string';
    if (as && bs) return a + b;
    if (!as && !bs) return Number(a) + Number(b);
    const text = /** @type {string} */ (as ? a : b);
    const num = Number(as ? b : a);
    if (DATETIME_TEXT.test(text.trim())) {
        const d = toDate(text);
        if (d) {
            const out = new Date(d.getTime() + num * 86400000);
            return text.trim().length <= 10 && Number.isInteger(num) ? dateText(out) : dateTimeText(out);
        }
    }
    if (isNumericText(text)) return Number(text) + num;
    throw new Error(`Conversion failed when converting the varchar value '${text}' to data type ${typeName(as ? b : a)}.`);
}

/** TRY_CAST(value AS type): the converted value, or NULL when it can't be converted. */
export function tryCast(value, type) {
    if (value === null || value === undefined) return null;
    const t = String(type).toUpperCase().replace(/\s+/g, '');
    const name = t.replace(/\(.*$/, '');
    const arg = /\(([^)]*)\)/.exec(t)?.[1] || '';
    const text = String(value).trim();
    if (['INT', 'BIGINT', 'SMALLINT', 'TINYINT'].includes(name)) {
        if (typeof value === 'number') return Math.trunc(value);
        if (!/^[+-]?\d+$/.test(text)) return null;
        const n = Number(text);
        const limits = { INT: 2147483647, SMALLINT: 32767, TINYINT: 255, BIGINT: Number.MAX_SAFE_INTEGER };
        if (Math.abs(n) > limits[name] || (name === 'TINYINT' && n < 0)) return null;
        return n;
    }
    if (['DECIMAL', 'NUMERIC', 'FLOAT', 'REAL', 'MONEY', 'SMALLMONEY'].includes(name)) {
        if (typeof value === 'number') return value;
        if (!isNumericText(text)) return null;
        const n = Number(text);
        const scale = name === 'DECIMAL' || name === 'NUMERIC' ? Number(arg.split(',')[1] || 0) : null;
        return scale === null ? n : Math.round(n * 10 ** scale) / 10 ** scale;
    }
    if (name === 'BIT') {
        if (/^(1|true)$/i.test(text)) return 1;
        if (/^(0|false)$/i.test(text)) return 0;
        return isNumericText(text) ? (Number(text) !== 0 ? 1 : 0) : null;
    }
    if (['DATE', 'DATETIME', 'DATETIME2', 'SMALLDATETIME', 'DATETIMEOFFSET'].includes(name)) {
        const d = toDate(value);
        if (!d || Number.isNaN(d.getTime())) return null;
        // 2024-13-01 or 2024-02-30 isn't a date (Date would roll it over)
        const parts = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
        if (parts && (d.getUTCMonth() + 1 !== Number(parts[2]) || d.getUTCDate() !== Number(parts[3]))) return null;
        return name === 'DATE' ? dateText(d) : dateTimeText(d);
    }
    if (name === 'TIME') {
        const d = toDate(value);
        return d && !Number.isNaN(d.getTime()) ? dateTimeText(d).slice(11) : null;
    }
    if (name === 'UNIQUEIDENTIFIER') return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text) ? text.toUpperCase() : null;
    if (/CHAR$|^TEXT$|^NTEXT$|^SYSNAME$/.test(name)) {
        const n = arg === 'MAX' || arg === '' ? (arg === '' ? 30 : 0) : Number(arg);
        const s = typeof value === 'string' ? value : String(value);
        return n > 0 && chars(s).length > n ? null : s;
    }
    return value;
}

/** A LIKE pattern (%, _, [abc], [^a-z]) as a regular expression. */
function likeToRegExp(pattern) {
    let out = '';
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '%') out += '[\\s\\S]*';
        else if (c === '_') out += '[\\s\\S]';
        else if (c === '[') {
            const j = pattern.indexOf(']', i + 1);
            if (j < 0) { out += '\\['; continue; }
            const body = pattern.slice(i + 1, j).replace(/\\/g, '\\\\');
            out += `[${body.startsWith('^') ? '^' + body.slice(1) : body}]`;
            i = j;
        } else out += c.replace(/[.*+?^${}()|\\/\]]/g, '\\$&');
    }
    // PATINDEX patterns are anchored by their % signs
    const anchoredStart = !pattern.startsWith('%');
    const anchoredEnd = !pattern.endsWith('%');
    return new RegExp(`${anchoredStart ? '^' : ''}${out.replace(/^\[\\s\\S\]\*/, '').replace(/\[\\s\\S\]\*$/, '')}${anchoredEnd ? '$' : ''}`, 'i');
}

/** A custom .NET number format such as 0.00, #,##0, 000 or #,##0.0 (null when f isn't one). */
function numberPattern(n, f) {
    if (!/^[#0,]*(\.[#0]+)?$/.test(f) || !/[#0]/.test(f)) return null;
    const [whole, frac = ''] = f.split('.');
    const minFrac = (frac.match(/0/g) || []).length;
    const maxFrac = frac.length;
    const minInt = (whole.match(/0/g) || []).length;
    const text = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: minFrac, maximumFractionDigits: maxFrac, minimumIntegerDigits: Math.max(1, minInt), useGrouping: whole.includes(',') });
    const out = minInt === 0 && text.startsWith('0') && Math.abs(n) < 1 ? text.slice(1) : text;
    return (n < 0 ? '-' : '') + out;
}

/** FORMAT(value, format) with .NET format strings: N2, C, P, 0.00, #,##0, yyyy-MM-dd … */
function formatValue(v, f) {
    if (v === null) return null;
    const d = typeof v === 'string' ? toDate(v) : null;
    if (d && typeof f === 'string' && /[yMdHhms]/.test(f)) {
        return f.replace(/yyyy|yy|MMMM|MMM|MM|M|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|tt/g, (k) => ({
            yyyy: String(d.getUTCFullYear()), yy: pad(d.getUTCFullYear() % 100), MMMM: MONTHS[d.getUTCMonth()], MMM: MONTHS[d.getUTCMonth()].slice(0, 3),
            MM: pad(d.getUTCMonth() + 1), M: String(d.getUTCMonth() + 1), dddd: DAYS[d.getUTCDay()], ddd: DAYS[d.getUTCDay()].slice(0, 3),
            dd: pad(d.getUTCDate()), d: String(d.getUTCDate()), HH: pad(d.getUTCHours()), H: String(d.getUTCHours()),
            hh: pad(((d.getUTCHours() + 11) % 12) + 1), h: String(((d.getUTCHours() + 11) % 12) + 1), mm: pad(d.getUTCMinutes()), m: String(d.getUTCMinutes()),
            ss: pad(d.getUTCSeconds()), s: String(d.getUTCSeconds()), tt: d.getUTCHours() < 12 ? 'AM' : 'PM'
        })[k] ?? k);
    }
    const n = Number(v);
    if (Number.isNaN(n)) return String(v);
    if (typeof f === 'string' && /^0+$/.test(f)) return numberPattern(n, f);
    if (typeof f === 'number' || /^\d+$/.test(String(f))) return n.toLocaleString('en-US', { minimumFractionDigits: Number(f), maximumFractionDigits: Number(f) });
    const custom = numberPattern(n, String(f));
    if (custom !== null) return custom;
    if (/^[Dd](\d*)$/.test(String(f))) return (n < 0 ? '-' : '') + String(Math.trunc(Math.abs(n))).padStart(Number(String(f).slice(1) || 0), '0');
    if (/^[Xx](\d*)$/.test(String(f))) { const h = Math.trunc(n).toString(16).padStart(Number(String(f).slice(1) || 0), '0'); return String(f)[0] === 'X' ? h.toUpperCase() : h; }
    if (/^[Ff](\d*)$/.test(String(f))) return n.toFixed(Number(String(f).slice(1) || 2));
    if (/^[Nn](\d*)$/.test(String(f))) { const k = Number(String(f).slice(1) || 2); return n.toLocaleString('en-US', { minimumFractionDigits: k, maximumFractionDigits: k }); }
    if (/^[Cc](\d*)$/.test(String(f))) { const k = Number(String(f).slice(1) || 2); return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: k, maximumFractionDigits: k }); }
    if (/^[Pp](\d*)$/.test(String(f))) { const k = Number(String(f).slice(1) || 2); return (n * 100).toLocaleString('en-US', { minimumFractionDigits: k, maximumFractionDigits: k }) + '%'; }
    return String(v);
}

/**
 * The functions, each `[name, arity, fn, deterministic]`: arity -1 takes any
 * number of arguments. Names are matched without regard to case.
 * @type {[string, number, (...args: any[]) => any, boolean][]}
 */
export const COMPAT_FUNCTIONS = [
    // Current date and time (UTC)
    ['getdate', 0, () => dateTimeText(now()), false],
    ['getutcdate', 0, () => dateTimeText(now()), false],
    ['sysdatetime', 0, () => dateTimeText(now()), false],
    ['sysutcdatetime', 0, () => dateTimeText(now()), false],
    ['now', 0, () => dateTimeText(now()), false],
    ['curdate', 0, () => dateText(now()), false],
    ['curtime', 0, () => dateTimeText(now()).slice(11), false],
    ['sysdate', 0, () => dateTimeText(now()), false],
    ['utc_timestamp', 0, () => dateTimeText(now()), false],
    ['localtimestamp', 0, () => dateTimeText(now()), false],
    // Date arithmetic and parts
    ['dateadd', 3, (part, n, d) => {
        const date = toDate(d);
        const p = datePart(part);
        if (!date || !p || n === null) return null;
        const r = addTo(date, p, n);
        return r ? like(d, r) : null;
    }, true],
    ['datediff', 3, (part, a, b) => {
        const p = datePart(part);
        const x = toDate(a);
        const y = toDate(b);
        return p && x && y ? diff(p, x, y) : null;
    }, true],
    ['datediff_big', 3, (part, a, b) => {
        const p = datePart(part);
        const x = toDate(a);
        const y = toDate(b);
        return p && x && y ? diff(p, x, y) : null;
    }, true],
    // MySQL DATEDIFF(a, b): days from b to a
    ['datediff', 2, (a, b) => {
        const x = toDate(a);
        const y = toDate(b);
        return x && y ? diff('day', y, x) : null;
    }, true],
    ['datepart', 2, (part, d) => {
        const p = datePart(part);
        const date = toDate(d);
        return p && date ? partOf(p, date) : null;
    }, true],
    ['datename', 2, (part, d) => {
        const p = datePart(part);
        const date = toDate(d);
        if (!p || !date) return null;
        if (p === 'month') return MONTHS[date.getUTCMonth()];
        if (p === 'weekday') return DAYS[date.getUTCDay()];
        return String(partOf(p, date));
    }, true],
    ['datetrunc', 2, (part, d) => truncate(part, d), true],
    ['date_trunc', 2, (part, d) => truncate(part, d), true],
    ['extract', 2, (part, d) => {
        const p = String(part).toLowerCase() === 'dow' ? 'dow' : datePart(part);
        const date = toDate(d);
        if (!p || !date) return null;
        if (p === 'dow') return date.getUTCDay();
        if (String(part).toLowerCase() === 'epoch') return date.getTime() / 1000;
        return partOf(p, date);
    }, true],
    ['date_part', 2, (part, d) => {
        const p = datePart(part);
        const date = toDate(d);
        return p && date ? partOf(p, date) : null;
    }, true],
    ['year', 1, (d) => toDate(d)?.getUTCFullYear() ?? null, true],
    ['month', 1, (d) => { const x = toDate(d); return x ? x.getUTCMonth() + 1 : null; }, true],
    ['day', 1, (d) => toDate(d)?.getUTCDate() ?? null, true],
    ['dayofmonth', 1, (d) => toDate(d)?.getUTCDate() ?? null, true],
    ['hour', 1, (d) => toDate(d)?.getUTCHours() ?? null, true],
    ['minute', 1, (d) => toDate(d)?.getUTCMinutes() ?? null, true],
    ['second', 1, (d) => toDate(d)?.getUTCSeconds() ?? null, true],
    ['quarter', 1, (d) => { const x = toDate(d); return x ? partOf('quarter', x) : null; }, true],
    ['dayofweek', 1, (d) => { const x = toDate(d); return x ? x.getUTCDay() + 1 : null; }, true],
    ['dayofyear', 1, (d) => { const x = toDate(d); return x ? partOf('dayofyear', x) : null; }, true],
    ['weekday', 1, (d) => { const x = toDate(d); return x ? (x.getUTCDay() + 6) % 7 : null; }, true],
    ['monthname', 1, (d) => { const x = toDate(d); return x ? MONTHS[x.getUTCMonth()] : null; }, true],
    ['dayname', 1, (d) => { const x = toDate(d); return x ? DAYS[x.getUTCDay()] : null; }, true],
    ['eomonth', 1, (d) => { const x = toDate(d); return x ? dateText(new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0))) : null; }, true],
    ['eomonth', 2, (d, n) => { const x = toDate(d); return x ? dateText(new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1 + Number(n || 0), 0))) : null; }, true],
    ['last_day', 1, (d) => { const x = toDate(d); return x ? dateText(new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0))) : null; }, true],
    ['datefromparts', 3, (y, m, d) => (y === null || m === null || d === null ? null : dateText(new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))))), true],
    ['make_date', 3, (y, m, d) => (y === null || m === null || d === null ? null : dateText(new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))))), true],
    ['date_add', 3, (d, n, unit) => shift(d, n, unit, 1), true],
    ['adddate', 3, (d, n, unit) => shift(d, n, unit, 1), true],
    ['date_sub', 3, (d, n, unit) => shift(d, n, unit, -1), true],
    ['subdate', 3, (d, n, unit) => shift(d, n, unit, -1), true],
    ['adddate', 2, (d, n) => shift(d, n, 'day', 1), true],
    ['subdate', 2, (d, n) => shift(d, n, 'day', -1), true],
    ['date_format', 2, (d, f) => { const x = toDate(d); return x && f !== null ? mysqlFormat(x, f) : null; }, true],
    ['to_char', 2, (d, f) => { const x = toDate(d); return x && f !== null ? pgFormat(x, f) : null; }, true],
    ['convert_style', 2, (v, style) => convertStyle(v, style), true],
    ['to_date', 2, (d) => { const x = toDate(d); return x ? dateText(x) : null; }, true],
    ['str_to_date', 2, (d) => { const x = toDate(d); return x ? like(d, x) : null; }, true],
    ['age', 2, (a, b) => {
        const x = toDate(a);
        const y = toDate(b);
        if (!x || !y) return null;
        let months = diff('month', y, x);
        if (x.getUTCDate() < y.getUTCDate()) months--;
        const years = Math.trunc(months / 12);
        return `${years} years ${months - years * 12} mons`;
    }, true],
    // Text
    ['len', 1, (s) => (s === null ? null : chars(String(s).replace(/ +$/, '')).length), true],
    ['datalength', 1, (s) => (s === null ? null : s instanceof Uint8Array ? s.length : new TextEncoder().encode(String(s)).length), true],
    ['char_length', 1, (s) => (s === null ? null : chars(String(s)).length), true],
    ['character_length', 1, (s) => (s === null ? null : chars(String(s)).length), true],
    ['charindex', 2, (find, s) => (find === null || s === null ? null : String(s).toLowerCase().indexOf(String(find).toLowerCase()) + 1), true],
    ['charindex', 3, (find, s, start) => (find === null || s === null ? null : String(s).toLowerCase().indexOf(String(find).toLowerCase(), Math.max(0, Number(start) - 1)) + 1), true],
    ['locate', 2, (find, s) => (find === null || s === null ? null : String(s).toLowerCase().indexOf(String(find).toLowerCase()) + 1), true],
    ['locate', 3, (find, s, start) => (find === null || s === null ? null : String(s).toLowerCase().indexOf(String(find).toLowerCase(), Math.max(0, Number(start) - 1)) + 1), true],
    ['position', 2, (find, s) => (find === null || s === null ? null : String(s).indexOf(String(find)) + 1), true],
    ['strpos', 2, (s, find) => (find === null || s === null ? null : String(s).indexOf(String(find)) + 1), true],
    ['left', 2, (s, n) => (s === null || n === null ? null : chars(String(s)).slice(0, Math.max(0, Number(n))).join('')), true],
    ['right', 2, (s, n) => (s === null || n === null ? null : (Number(n) <= 0 ? '' : chars(String(s)).slice(-Number(n)).join(''))), true],
    ['space', 1, (n) => (n === null ? null : ' '.repeat(Math.max(0, Number(n)))), true],
    ['replicate', 2, (s, n) => (s === null || n === null ? null : String(s).repeat(Math.max(0, Number(n)))), true],
    ['repeat', 2, (s, n) => (s === null || n === null ? null : String(s).repeat(Math.max(0, Number(n)))), true],
    ['reverse', 1, (s) => (s === null ? null : chars(String(s)).reverse().join('')), true],
    ['stuff', 4, (s, start, len, add) => {
        if (s === null || start === null || len === null) return null;
        const c = chars(String(s));
        const at = Number(start) - 1;
        if (at < 0 || at >= c.length) return null;
        c.splice(at, Math.max(0, Number(len)), ...(add === null ? [] : chars(String(add))));
        return c.join('');
    }, true],
    ['lpad', 3, (s, n, fill) => (s === null || n === null ? null : padText(String(s), Number(n), fill === null ? ' ' : String(fill), true)), true],
    ['rpad', 3, (s, n, fill) => (s === null || n === null ? null : padText(String(s), Number(n), fill === null ? ' ' : String(fill), false)), true],
    ['lpad', 2, (s, n) => (s === null || n === null ? null : padText(String(s), Number(n), ' ', true)), true],
    ['rpad', 2, (s, n) => (s === null || n === null ? null : padText(String(s), Number(n), ' ', false)), true],
    ['lcase', 1, (s) => str(s)?.toLowerCase() ?? null, true],
    ['ucase', 1, (s) => str(s)?.toUpperCase() ?? null, true],
    ['initcap', 1, (s) => str(s)?.toLowerCase().replace(/(^|[^\p{L}\p{N}])(\p{L})/gu, (_, a, b) => a + b.toUpperCase()) ?? null, true],
    ['split_part', 3, (s, sep, n) => (s === null || sep === null || n === null ? null : (String(s).split(String(sep))[Number(n) - 1] ?? '')), true],
    ['quotename', 1, (s) => (s === null ? null : `[${String(s).replace(/]/g, ']]')}]`), true],
    ['str', 1, (n) => (n === null ? null : String(Math.round(Number(n))).padStart(10)), true],
    ['format', 2, formatValue, true],
    ['tsql_format', 2, formatValue, true],
    ['tsql_format', 3, (v, f) => formatValue(v, f), true],
    // T-SQL
    ['tsql_add', 2, tsqlAdd, true],
    ['tsql_try_cast', 2, tryCast, true],
    ['tsql_raise', 1, (message) => { throw new Error(String(message)); }, false],
    ['tsql_split', 2, (s, sep) => (s === null ? null : JSON.stringify(String(s).split(sep === null || sep === '' ? ' ' : String(sep)))), true],
    ['tsql_substring', 3, (s, start, length) => {
        if (s === null || start === null || length === null) return null;
        if (Number(length) < 0) throw new Error('Invalid length parameter passed to the substring function.');
        const text = chars(String(s));
        const from = Number(start) - 1;
        const to = from + Number(length);
        return text.slice(Math.max(0, from), Math.max(0, to)).join('');
    }, true],
    ['choose', -1, (i, ...v) => (i === null ? null : (v[Math.trunc(Number(i)) - 1] ?? null)), true],
    ['patindex', 2, (p, s) => {
        if (p === null || s === null) return null;
        const re = likeToRegExp(String(p));
        const m = re.exec(String(s));
        return m ? chars(String(s).slice(0, m.index)).length + 1 : 0;
    }, true],
    ['ascii', 1, (s) => (s === null || String(s) === '' ? null : String(s).charCodeAt(0)), true],
    ['nchar', 1, (n) => (n === null ? null : String.fromCodePoint(Number(n))), true],
    ['translate', 3, (s, from, to) => {
        if (s === null || from === null || to === null) return null;
        const a = chars(String(from));
        const b = chars(String(to));
        if (a.length !== b.length) throw new Error('The second and third arguments of the TRANSLATE built-in function must contain an equal number of characters.');
        return chars(String(s)).map(c => { const k = a.indexOf(c); return k < 0 ? c : b[k]; }).join('');
    }, true],
    ['suser_sname', 0, () => 'sa', true],
    ['suser_name', 0, () => 'sa', true],
    ['original_login', 0, () => 'sa', true],
    ['user_name', 0, () => 'dbo', true],
    ['host_name', 0, () => 'browser', true],
    ['app_name', 0, () => 'SQL Lab', true],
    ['schema_name', 0, () => 'dbo', true],
    ['isjson', 1, (s) => { try { JSON.parse(String(s)); return 1; } catch { return 0; } }, true],
    ['sign', 1, (n) => (n === null ? null : Math.sign(Number(n))), true],
    // Values
    ['isnull', 2, (a, b) => (a === null ? b : a), true],
    ['nvl', 2, (a, b) => (a === null ? b : a), true],
    ['isnumeric', 1, (v) => (v !== null && String(v).trim() !== '' && !Number.isNaN(Number(v)) ? 1 : 0), true],
    ['isdate', 1, (v) => (toDate(v) ? 1 : 0), true],
    ['newid', 0, () => uuid().toUpperCase(), false],
    ['uuid', 0, () => uuid(), false],
    ['gen_random_uuid', 0, () => uuid(), false],
    ['rand', 0, () => Math.random(), false],
    ['random_float', 0, () => Math.random(), false],
    ['square', 1, (n) => (n === null ? null : Number(n) * Number(n)), true],
    ['truncate', 2, (n, d) => (n === null ? null : Math.trunc(Number(n) * 10 ** Number(d || 0)) / 10 ** Number(d || 0)), true],
    ['div', 2, (a, b) => (a === null || b === null || Number(b) === 0 ? null : Math.trunc(Number(a) / Number(b))), true],
    ['greatest', -1, (...v) => (v.some(x => x === null) ? null : v.reduce((a, b) => (b > a ? b : a))), true],
    ['least', -1, (...v) => (v.some(x => x === null) ? null : v.reduce((a, b) => (b < a ? b : a))), true]
];

/** Names (upper case) of the functions added. ISNULL is left out: SQLite reads ISNULL as an operator, so ISNULL(…) only runs translated. */
export const COMPAT_FUNCTION_NAMES = new Set(COMPAT_FUNCTIONS.map(f => f[0].toUpperCase()).filter(n => n !== 'ISNULL'));

function truncate(part, d) {
    const p = datePart(part);
    const x = toDate(d);
    if (!p || !x) return null;
    const Y = x.getUTCFullYear();
    const M = x.getUTCMonth();
    const D = x.getUTCDate();
    let r;
    switch (p) {
        case 'year': r = new Date(Date.UTC(Y, 0, 1)); break;
        case 'quarter': r = new Date(Date.UTC(Y, M - (M % 3), 1)); break;
        case 'month': r = new Date(Date.UTC(Y, M, 1)); break;
        case 'week': r = new Date(Date.UTC(Y, M, D - ((x.getUTCDay() + 6) % 7))); break; // Monday, as PostgreSQL
        case 'day': r = new Date(Date.UTC(Y, M, D)); break;
        case 'hour': r = new Date(Date.UTC(Y, M, D, x.getUTCHours())); break;
        case 'minute': r = new Date(Date.UTC(Y, M, D, x.getUTCHours(), x.getUTCMinutes())); break;
        default: r = x;
    }
    return dateTimeText(r);
}

function shift(d, n, unit, sign) {
    const x = toDate(d);
    const p = datePart(unit);
    if (!x || !p || n === null) return null;
    const r = addTo(x, p, sign * Number(n));
    if (!r) return null;
    return ['hour', 'minute', 'second', 'millisecond'].includes(p) ? dateTimeText(r) : like(d, r);
}

function padText(s, n, fill, left) {
    const c = chars(s);
    if (n <= c.length) return c.slice(0, Math.max(0, n)).join('');
    if (!fill) return s;
    const extra = fill.repeat(Math.ceil((n - c.length) / fill.length)).slice(0, n - c.length);
    return left ? extra + s : s + extra;
}

/**
 * Adds the functions to an open database (sqlite3 oo1 DB). A function SQLite
 * already has (or one a database defines) is never replaced.
 * @param {any} db
 */
// Aggregates SQLite lacks: [name, finish(values)]
const AGGREGATES = /** @type {[string, (v: number[]) => number | null][]} */ ([
    ['stdev', (v) => (v.length < 2 ? null : Math.sqrt(variance(v, 1)))],
    ['stdevp', (v) => (v.length < 1 ? null : Math.sqrt(variance(v, 0)))],
    ['var', (v) => (v.length < 2 ? null : variance(v, 1))],
    ['varp', (v) => (v.length < 1 ? null : variance(v, 0))]
]);
function variance(values, ddof) {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - ddof);
}

/** OBJECT_ID('dbo.Customers'), OBJECT_ID('tempdb..#t'), with an optional type ('U' table, 'V' view, 'P' procedure, 'FN' function …). */
function objectId(db, name, type) {
    if (name === null || name === undefined) return null;
    const raw = String(name).trim();
    const temp = /^tempdb\./i.test(raw) || /(^|\.)\[?#/.test(raw);
    const parts = raw.split('.').map(p => p.trim().replace(/^\[|\]$/g, '').replace(/^"|"$/g, ''));
    const last = parts[parts.length - 1] || '';
    const schemaName = parts.length > 1 && parts[parts.length - 2] ? parts[parts.length - 2] : 'dbo';
    const schema = temp ? 'sqlite_temp_schema' : 'sqlite_schema';
    const types = type === null || type === undefined ? null : String(type).trim().toUpperCase();
    const kind = types === 'U' ? "('table')" : types === 'V' ? "('view')" : types === 'TR' ? "('trigger')" : types === null ? "('table', 'view', 'trigger')" : null;
    if (kind && (temp || schemaName.toLowerCase() === 'dbo')) {
        const id = db.selectValue(`SELECT rowid FROM ${schema} WHERE type IN ${kind} AND name = ? COLLATE NOCASE`, [last]);
        if (id !== undefined) return Number(id) + (temp ? 1000000 : 0);
    }
    // Procedures and functions (tsql/modules.js)
    if (temp || (types !== null && !['P', 'FN', 'IF', 'TF'].includes(types)) || !hasModulesTable(db)) return null;
    const id = db.selectValue(`SELECT rowid FROM ${MODULES_TABLE} WHERE name = ? AND schema_name = ? COLLATE NOCASE${types ? ' AND kind = ?' : ''}`, types ? [last, schemaName, types] : [last, schemaName]);
    return id === undefined ? null : Number(id) + MODULE_ID_BASE;
}

/** The object an id names: { name, schema, type, definition } or null. */
function objectById(db, id) {
    if (id === null || id === undefined || Number.isNaN(Number(id))) return null;
    const n = Number(id);
    if (n >= MODULE_ID_BASE) {
        if (!hasModulesTable(db)) return null;
        const row = db.selectObject(`SELECT name, schema_name AS schema, kind AS type, definition FROM ${MODULES_TABLE} WHERE rowid = ?`, [n - MODULE_ID_BASE]);
        return row || null;
    }
    const temp = n >= 1000000;
    const row = db.selectObject(`SELECT name, type, sql FROM ${temp ? 'sqlite_temp_schema' : 'sqlite_schema'} WHERE rowid = ? AND type IN ('table', 'view', 'trigger')`, [temp ? n - 1000000 : n]);
    if (!row) return null;
    return { name: row.name, schema: 'dbo', type: row.type === 'table' ? 'U' : row.type === 'view' ? 'V' : 'TR', definition: row.type === 'table' ? null : row.sql };
}

/** OBJECTPROPERTY(id, 'IsUserTable') and the other common properties. */
function objectProperty(db, id, property) {
    const obj = objectById(db, id);
    if (!obj) return null;
    const p = String(property ?? '').toLowerCase();
    const is = (/** @type {boolean} */ b) => (b ? 1 : 0);
    switch (p) {
    case 'isusertable': case 'istable': return is(obj.type === 'U');
    case 'isview': return is(obj.type === 'V');
    case 'isprocedure': return is(obj.type === 'P');
    case 'istrigger': return is(obj.type === 'TR');
    case 'isscalarfunction': return is(obj.type === 'FN');
    case 'isinlinefunction': return is(obj.type === 'IF');
    case 'istablefunction': return is(obj.type === 'IF' || obj.type === 'TF');
    case 'ismsshipped': case 'isencrypted': case 'isschemabound': return 0;
    case 'ownerid': case 'schemaid': return 1;
    default: return null;
    }
}

/** COL_LENGTH('table', 'column'): bytes, -1 for (MAX), NULL when there's no such column. */
function colLength(db, table, column) {
    if (table === null || column === null || table === undefined || column === undefined) return null;
    const name = String(table).split('.').pop()?.trim().replace(/^\[|\]$/g, '').replace(/^"|"$/g, '') || '';
    const temp = /(^|\.)\[?#/.test(String(table));
    const col = db.selectObject(`SELECT type FROM pragma_table_info(?, '${temp ? 'temp' : 'main'}') WHERE name = ? COLLATE NOCASE`, [name, String(column)]);
    return col ? typeInfo(col.type).maxLength : null;
}

/**
 * @param {any} db an open sqlite3 oo1 database
 * @param {any} [capi] sqlite3.capi, for the aggregates (STDEV, VAR …)
 */
export function registerCompatFunctions(db, capi) {
    const existing = new Set();
    try {
        for (const row of db.exec({ sql: 'SELECT name, narg FROM pragma_function_list', returnValue: 'resultRows' })) existing.add(`${String(row[0]).toLowerCase()}/${row[1]}`);
    } catch {
        // pragma_function_list may be left out of a build: then add them all
    }
    for (const [name, finish] of AGGREGATES) {
        if (!capi || existing.has(`${name}/1`)) continue;
        /** @type {Map<unknown, number[]>} */
        const state = new Map();
        db.createFunction({ name, arity: 1, deterministic: true,
            // Each group's values are kept under its aggregate context, which is the same for every row of the group
            xStep: (/** @type {any} */ ctx, /** @type {any} */ value) => {
                const key = Number(capi.sqlite3_aggregate_context(ctx, 8));
                if (!state.has(key)) state.set(key, []);
                if (value !== null && value !== undefined && !Number.isNaN(Number(value))) state.get(key)?.push(Number(value));
            },
            xFinal: (/** @type {any} */ ctx) => {
                const key = Number(capi.sqlite3_aggregate_context(ctx, 0));
                const values = state.get(key) || [];
                state.delete(key);
                return finish(values);
            } });
    }
    for (const arity of [1, 2]) {
        db.createFunction({ name: 'object_id', arity, deterministic: false,
            xFunc: (/** @type {any} */ _ctx, /** @type {any} */ name, /** @type {any} */ type = null) => objectId(db, name, type) });
        db.createFunction({ name: 'object_name', arity, deterministic: false, xFunc: (/** @type {any} */ _ctx, /** @type {any} */ id) => objectById(db, id)?.name ?? null });
    }
    const withDb = /** @type {[string, number, (...args: any[]) => unknown][]} */ ([
        ['object_definition', 1, (id) => objectById(db, id)?.definition ?? null],
        ['object_schema_name', 1, (id) => objectById(db, id)?.schema ?? null],
        ['object_schema_name', 2, (id) => objectById(db, id)?.schema ?? null],
        ['objectproperty', 2, (id, property) => objectProperty(db, id, property)],
        ['col_length', 2, (table, column) => colLength(db, table, column)],
        ['schema_id', 0, () => 1],
        ['schema_id', 1, (name) => ({ dbo: 1, guest: 2, information_schema: 3, sys: 4 })[String(name ?? '').toLowerCase()] ?? null],
        ['db_id', 0, () => 5],
        ['db_id', 1, (name) => (name === null || name === undefined ? null : ({ master: 1, tempdb: 2, model: 3, msdb: 4 })[String(name).toLowerCase()] ?? 5)],
        ['type_name', 1, (id) => systemTypeName(id)],
        ['type_id', 1, (name) => typeInfo(name).typeId || null]
    ]);
    for (const [name, arity, fn] of withDb) {
        db.createFunction({ name, arity, deterministic: false, xFunc: (/** @type {any} */ _ctx, /** @type {any[]} */ ...args) => {
            const out = fn(...args.map(a => (typeof a === 'bigint' ? Number(a) : a)));
            return out === undefined ? null : out;
        } });
    }
    registerCatalogFunctions(db);
    for (const [name, arity, fn, deterministic] of COMPAT_FUNCTIONS) {
        if (existing.has(`${name}/${arity}`) || existing.has(`${name}/-1`)) continue;
        db.createFunction({ name, arity, deterministic, xFunc: (/** @type {any} */ _ctx, /** @type {any[]} */ ...args) => {
            const out = fn(...args.map(a => (typeof a === 'bigint' ? Number(a) : a)));
            return out === undefined ? null : out;
        } });
    }
}
