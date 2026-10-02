// SQL Lab imports: reading the tables of an HTML page, and running one into
// the real SQLite (in-memory files).
import { beforeAll, describe, expect, test } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { createSqliteAdapter } from '../src/db/sqlite-adapter.js';
import { createMemoryFiles } from '../src/db/files.js';
import { decodeEntities, looksLikeHtml, parseHtmlRows, readHtmlTables } from '../src/db/import-html.js';
import { detectFormat, previewImport, runImport } from '../src/db/importer.js';

let sqlite3;
beforeAll(async () => {
    sqlite3 = await sqlite3InitModule();
});

const PAGE = `<!DOCTYPE html>
<html><head><title>Staff <table></title>
<style>td { color: red; } /* <table><tr><td>not data</td></tr></table> */</style>
<script>const t = "<table><tr><td>not data</td></tr></table>";</script>
</head><body>
<h1>Report</h1>
<!-- <table><tr><td>commented out</td></tr></table> -->
<table class="summary"><tr><td>Total</td><td>4</td></tr></table>
<table id="staff">
  <caption>Employees &amp; salaries</caption>
  <thead><tr><th>Employee ID</th><th>Name</th><th>Department</th><th>Salary</th></tr></thead>
  <tbody>
    <tr><td>1</td><td><b>Ada</b>  Lovelace</td><td>Engineering</td><td>120000</td></tr>
    <tr><td>2</td><td>Grace&nbsp;Hopper</td><td>Engineering</td><td>100000.5</td></tr>
    <tr><td>3</td><td>Linus &lt;Jr.&gt;<br>Torvalds</td><td colspan="2">Sales</td></tr>
    <tr><td>4</td><td>Margaret</td><td></td></tr>
  </tbody>
</table>
</body></html>`;

describe('reading HTML tables', () => {
    test('entities are decoded; unknown ones stay as written', () => {
        expect(decodeEntities('a &amp; b &lt;c&gt; &#233; &#xE9; &eacute; &unknown; &#0;')).toBe('a & b <c> é é &eacute; &unknown; &#0;');
    });

    test('every table is found; scripts, styles, comments and the title hold no data', () => {
        const tables = readHtmlTables(PAGE);
        expect(tables.map(t => t.label)).toEqual(['Table 1', 'Employees & salaries']);
        expect(tables[0].rows.map(r => r.cells.map(c => c.text))).toEqual([['Total', '4']]);
        expect(JSON.stringify(tables)).not.toContain('not data');
        expect(JSON.stringify(tables)).not.toContain('commented out');
    });

    test('the header row, cell text, line breaks, spans and short rows', () => {
        const t = parseHtmlRows(PAGE, { table: 1 });
        expect(t.header).toBe(true);
        expect(t.columns).toEqual(['Employee ID', 'Name', 'Department', 'Salary']);
        expect(t.rows).toEqual([
            ['1', 'Ada Lovelace', 'Engineering', '120000'],
            ['2', 'Grace Hopper', 'Engineering', '100000.5'],
            ['3', 'Linus <Jr.>\nTorvalds', 'Sales', null],
            ['4', 'Margaret', null, null]]);
        expect(t.lines).toEqual([13, 14, 15, 16]);
        expect(t.spanned).toBe(1);
        expect(t.padded).toBe(1);
        expect(t.tables).toEqual([{ index: 0, label: 'Table 1 (1 row, 2 columns)' }, { index: 1, label: 'Employees & salaries (4 rows, 4 columns)' }]);
    });

    test('without a header row the columns are numbered; the first table with rows is the default', () => {
        const t = parseHtmlRows('<table></table><table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>');
        expect(t.table).toBe(1);
        expect(t.header).toBe(false);
        expect(t.columns).toEqual(['column1', 'column2']);
        expect(t.rows).toEqual([['a', 'b'], ['c', null]]);
    });

    test('a table inside a cell is a table of its own', () => {
        const tables = readHtmlTables('<table><tr><td>outer <table><tr><td>inner</td></tr></table> after</td><td>2</td></tr></table>');
        expect(tables.map(t => t.rows.map(r => r.cells.map(c => c.text)))).toEqual([[['outer after', '2']], [['inner']]]);
    });

    test('a page without tables, or with empty ones, is refused', () => {
        expect(() => parseHtmlRows('<html><body><p>hi</p></body></html>')).toThrow(/no <table>/);
        expect(() => parseHtmlRows('<table></table>')).toThrow(/have no rows/);
    });

    test('HTML is detected by name or by its start', () => {
        expect(detectFormat({ name: 'report.html' })).toBe('html');
        expect(detectFormat({ name: 'report.HTM' })).toBe('html');
        expect(detectFormat({ text: PAGE })).toBe('html');
        expect(detectFormat({ text: '<table><tr><td>1</td></tr></table>' })).toBe('html');
        expect(looksLikeHtml('<p>no table</p>')).toBe(false);
        expect(detectFormat({ text: 'a,b\n1,2' })).toBe('csv');
    });
});

describe('importing an HTML table', () => {
    test('the preview describes the chosen table and notes spans and short rows', () => {
        const p = previewImport({ format: 'html', text: PAGE, options: { table: 1 } });
        expect(p.rowCount).toBe(4);
        expect(p.table).toBe(1);
        expect(p.tables).toHaveLength(2);
        expect(p.columns.map(c => [c.name, c.type])).toEqual([['Employee ID', 'INTEGER'], ['Name', 'TEXT'], ['Department', 'TEXT'], ['Salary', 'REAL']]);
        expect(p.notes.join(' ')).toContain('1 cell spans several columns');
        expect(p.notes.join(' ')).toContain('1 row has fewer cells than the widest row');
        expect(() => previewImport({ format: 'html', text: '<table><tr><th>a</th></tr></table>' })).toThrow(/only a header row/);
    });

    test('rows go into a new table with bound values', async () => {
        const files = createMemoryFiles(sqlite3);
        const adapter = createSqliteAdapter(sqlite3, files);
        await adapter.create('html-db');
        const result = runImport(adapter, { format: 'html', text: PAGE, options: { table: 1 }, target: { mode: 'new', table: 'Staff', types: ['INTEGER', 'TEXT', 'TEXT', 'REAL'] } });
        expect(result).toMatchObject({ table: 'Staff', created: true, rowsInserted: 4 });
        expect(adapter.execute('SELECT "Employee ID", Name, Department, Salary FROM Staff ORDER BY 1').results.at(-1).rows).toEqual([
            [1, 'Ada Lovelace', 'Engineering', 120000],
            [2, 'Grace Hopper', 'Engineering', 100000.5],
            [3, 'Linus <Jr.>\nTorvalds', 'Sales', null],
            [4, 'Margaret', null, null]]);
    });
});
