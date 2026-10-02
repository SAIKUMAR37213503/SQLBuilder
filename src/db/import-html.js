// Reads rows from the tables in an HTML page (<table>, <tr>, <th>, <td>), for
// example a report saved from a web page or exported by another tool. Runs in
// the database worker, where there is no DOM, so it reads the tags itself.
//
// Each table is read on its own; a table inside a cell is a table of its own.
// The column names are the first row when it is all <th> cells (or is in
// <thead>); otherwise the columns are column1, column2, … Cells are plain
// text: tags are dropped, entities decoded, runs of spaces collapsed, and
// <br> kept as a line break. An empty cell is NULL. A cell spanning several
// columns fills the first and leaves the rest NULL; short rows are filled
// with NULL. Styles and scripts are ignored; there is no data in them.

import { DatabaseError } from './engine.js';

// Stands for a <br> until spaces are collapsed (no text holds a NUL)
const BREAK = '\u0000';

const ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
    copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
    euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°', times: '×', divide: '÷',
    middot: '·', bull: '•', sect: '§', para: '¶', plusmn: '±', micro: 'µ',
    frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³', shy: ''
};

/** Decodes character references: &amp; &#233; &#xE9; (unknown names stay as written). */
export function decodeEntities(text) {
    return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, (whole, ref) => {
        if (ref[0] === '#') {
            const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
            return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
        }
        const named = ENTITIES[ref.toLowerCase()];
        return named === undefined ? whole : named;
    });
}

/** Whether text looks like an HTML page or fragment with a table in it. */
export function looksLikeHtml(text) {
    const start = text.replace(/^\ufeff/, '').trimStart().slice(0, 1024);
    return /^<(?:!doctype\s+html|html|head|body|table|meta|title|!--)/i.test(start) && /<table\b/i.test(text);
}

const attribute = (tag, name) => {
    const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
    return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : null;
};

/**
 * Every table in the page, in the order they start.
 * @param {string} text
 * @returns {{ label: string, rows: { cells: { text: string, header: boolean, span: number }[], head: boolean, line: number }[] }[]}
 */
export function readHtmlTables(text) {
    /** @type {any[]} */
    const tables = [];
    /** @type {any[]} open tables, innermost last */
    const open = [];
    let line = 1;
    let lineAt = 0;
    const lineOf = at => {
        for (; lineAt < at; lineAt++) if (text.charCodeAt(lineAt) === 10) line++;
        return line;
    };
    const current = () => open[open.length - 1];
    const addText = s => {
        const t = current();
        if (t && t.cell) t.cell.text += s;
        else if (t && t.inCaption) t.caption += s;
    };
    const closeCell = t => {
        if (t.cell) t.cell = null;
    };
    const closeRow = t => {
        closeCell(t);
        t.row = null;
    };

    const tag = /<!--[\s\S]*?-->|<(script|style|template|textarea|title)\b[^>]*>[\s\S]*?<\/\1\s*>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
    let last = 0;
    let m;
    while ((m = tag.exec(text))) {
        if (m.index > last) addText(text.slice(last, m.index).replaceAll(BREAK, ''));
        last = tag.lastIndex;
        if (!m[3]) continue; // a comment, or a script, style or similar element: no data
        const closing = m[2] === '/';
        const name = m[3].toLowerCase();
        const t = current();
        if (name === 'table') {
            if (closing) {
                if (t) {
                    closeRow(t);
                    open.pop();
                }
            } else {
                const table = { label: '', caption: '', id: attribute(m[0], 'id'), rows: [], row: null, cell: null, inHead: false, inCaption: false };
                tables.push(table);
                open.push(table);
            }
        } else if (!t) {
            continue;
        } else if (name === 'caption') {
            t.inCaption = !closing;
        } else if (name === 'thead') {
            t.inHead = !closing;
        } else if (name === 'tbody' || name === 'tfoot') {
            if (!closing) t.inHead = false;
        } else if (name === 'tr') {
            closeRow(t);
            if (!closing) {
                t.row = { cells: [], head: t.inHead, line: lineOf(m.index) };
                t.rows.push(t.row);
            }
        } else if (name === 'td' || name === 'th') {
            closeCell(t);
            if (!closing) {
                if (!t.row) {
                    t.row = { cells: [], head: t.inHead, line: lineOf(m.index) };
                    t.rows.push(t.row);
                }
                const span = Math.min(Math.max(parseInt(attribute(m[0], 'colspan') || '1', 10) || 1, 1), 1000);
                t.cell = { text: '', header: name === 'th', span };
                t.row.cells.push(t.cell);
            }
        } else if (name === 'br') {
            addText(BREAK);
        } else if (/^(?:p|div|li|h[1-6])$/.test(name)) {
            addText(' ');
        }
    }
    if (last < text.length) addText(text.slice(last).replaceAll(BREAK, ''));

    return tables.map((t, i) => {
        const caption = clean(t.caption);
        return {
            label: caption || (t.id ? `#${t.id}` : `Table ${i + 1}`),
            rows: t.rows
                .filter(r => r.cells.length > 0)
                .map(r => ({ head: r.head, line: r.line, cells: r.cells.map(c => ({ header: c.header, span: c.span, text: clean(c.text) })) }))
        };
    });
}

/** Cell text: entities decoded, spaces collapsed, line breaks from <br> kept. */
function clean(raw) {
    return decodeEntities(raw.replace(/[ \t\r\n\f]+/g, ' '))
        .replace(/\u00a0/g, ' ')
        .split(BREAK)
        .map(s => s.replace(/ {2,}/g, ' ').trim())
        .join('\n')
        .trim();
}

/** A short description of a table, for choosing one: "Sales (12 rows, 4 columns)". */
const describe = (label, rows, columns) => `${label} (${rows.toLocaleString()} ${rows === 1 ? 'row' : 'rows'}, ${columns} ${columns === 1 ? 'column' : 'columns'})`;

/**
 * Columns and rows of one table in an HTML page.
 * @param {string} text
 * @param {{ table?: number }} [options] which table (0-based); the first table with rows when not given
 * @returns {{ columns: string[], rows: (string | null)[][], lines: number[], tables: { index: number, label: string }[], table: number, header: boolean, padded: number, spanned: number }}
 */
export function parseHtmlRows(text, { table } = {}) {
    const all = readHtmlTables(text);
    const usable = all.map((t, index) => ({ t, index })).filter(({ t }) => t.rows.length > 0);
    if (usable.length === 0) {
        throw new DatabaseError(all.length ? 'The tables in this HTML have no rows.' : 'There is no <table> in this HTML, so there are no rows to import.', { code: 'BAD_INPUT' });
    }
    const picked = usable.find(u => u.index === table) || usable[0];
    const rows = picked.t.rows;

    const first = rows[0];
    const header = first.head || first.cells.every(c => c.header);
    const body = header ? rows.slice(1) : rows;
    let spanned = 0;
    const expand = r => r.cells.flatMap(c => {
        if (c.span > 1) spanned++;
        return [c.text === '' ? null : c.text, ...Array(c.span - 1).fill(null)];
    });
    const values = body.map(expand);
    const width = Math.max(header ? first.cells.reduce((n, c) => n + c.span, 0) : 0, ...values.map(v => v.length));
    let padded = 0;
    for (const v of values) {
        if (v.length < width) {
            padded++;
            while (v.length < width) v.push(null);
        }
    }
    const names = header ? expand(first).map(n => n ?? '') : [];
    while (names.length < width) names.push('');
    const columns = names.map((n, i) => n.replace(/\n/g, ' ') || `column${i + 1}`);

    return {
        columns,
        rows: values,
        lines: body.map(r => r.line),
        tables: usable.map(({ t, index }) => ({ index, label: describe(t.label, t.rows.length - (t.rows[0].head || t.rows[0].cells.every(c => c.header) ? 1 : 0), Math.max(...t.rows.map(r => r.cells.reduce((n, c) => n + c.span, 0)))) })),
        table: picked.index,
        header,
        padded,
        spanned
    };
}
