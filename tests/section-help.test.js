import { describe, expect, test } from 'vitest';
import { SECTION_HELP, sectionHelp } from '../src/section-help.js';
import { placePopover } from '../src/ui/help-popover.js';
import { DIALECTS, getDialect } from '../src/dialects.js';
import { importSql } from '../src/sql-import.js';
import { generateQuery } from '../src/generator.js';

const DIALECT_IDS = Object.keys(DIALECTS);
const SECTIONS = ['with', 'columns', 'from', 'joins', 'where', 'grouping', 'sorting', 'setops', 'insert', 'update', 'delete'];

// Clause examples are checked inside a whole statement
const STATEMENT = {
    columns: (e) => `${e} FROM employees`,
    from: (e) => `SELECT * ${e}`,
    joins: (e) => `SELECT * FROM customers AS c ${e}`,
    where: (e) => `SELECT * FROM employees ${e}`,
    grouping: (e) => `SELECT department, COUNT(*) FROM employees ${e}`,
    sorting: (e) => `SELECT name FROM employees ${e}`
};

describe('section help content', () => {
    test('every section has help in every dialect', () => {
        expect(Object.keys(SECTION_HELP).sort()).toEqual([...SECTIONS].sort());
        for (const key of SECTIONS) {
            for (const dialect of DIALECT_IDS) {
                const help = sectionHelp(key, dialect);
                expect(help.title).toBeTruthy();
                expect(help.tagline).toBeTruthy();
                expect(help.operation).toBeTruthy();
                expect(Boolean(help.definition) || help.parts.length > 0).toBe(true);
                expect(help.example).toBeTruthy();
            }
        }
        expect(sectionHelp('nope', 'generic')).toBe(null);
        expect(sectionHelp('toString', 'generic')).toBe(null);
        // An unknown dialect falls back to generic SQL
        expect(sectionHelp('sorting', 'oracle')).toEqual(sectionHelp('sorting', 'generic'));
    });

    test('stays short enough to scan', () => {
        for (const key of SECTIONS) {
            for (const dialect of DIALECT_IDS) {
                const help = sectionHelp(key, dialect);
                const texts = [help.definition, help.operation, help.note, ...help.parts.map(p => p.text)].filter(Boolean);
                for (const text of texts) expect(text.length, `${key}: ${text}`).toBeLessThanOrEqual(260);
                expect(help.tagline.length).toBeLessThanOrEqual(40);
                expect(help.example.length).toBeLessThanOrEqual(110);
            }
        }
    });

    test('notes are only for real dialects', () => {
        for (const entry of Object.values(SECTION_HELP)) {
            for (const id of Object.keys(entry.notes || {})) expect(DIALECT_IDS).toContain(id);
            // Generic SQL has nothing to correct
            expect(entry.notes?.generic).toBeUndefined();
        }
    });

    test('GROUP BY & HAVING explains the difference; the other combined sections explain each part', () => {
        expect(sectionHelp('grouping').parts.map(p => p.label)).toEqual(['GROUP BY', 'HAVING']);
        expect(sectionHelp('grouping').parts[1].text).toMatch(/after aggregation/);
        expect(sectionHelp('setops').parts.map(p => p.label)).toEqual(['UNION', 'INTERSECT', 'EXCEPT']);
        expect(sectionHelp('sorting', 'generic').parts.map(p => p.label)).toEqual(['ORDER BY', 'LIMIT', 'OFFSET']);
        expect(sectionHelp('sorting', 'sqlserver').parts.map(p => p.label)).toEqual(['ORDER BY', 'TOP', 'OFFSET']);
        expect(sectionHelp('where')).toMatchObject({ title: 'WHERE', tagline: 'Filter rows', definition: 'Filters rows based on a condition.', example: 'WHERE Salary > 50000' });
    });

    test('titles follow the section headers, which follow the dialect', () => {
        for (const dialect of DIALECT_IDS) {
            expect(sectionHelp('sorting', dialect).title).toBe(`ORDER BY, ${getDialect(dialect).ui.limitLabel} & OFFSET`);
        }
    });

    test('dialect notes match what each dialect supports', () => {
        for (const dialect of DIALECT_IDS) {
            const d = getDialect(dialect);
            const note = (key) => sectionHelp(key, dialect).note;
            expect(Boolean(note('joins')), `${dialect} joins`).toBe(!d.supports.fullJoin);
            expect(Boolean(note('grouping')), `${dialect} grouping`).toBe(d.supports.havingAlias);
            expect(Boolean(note('with')), `${dialect} with`).toBe(d.recursive.keyword === 'WITH');
            const allVariants = ['INTERSECT ALL', 'EXCEPT ALL'].every(op => d.supports.setOperators.includes(op));
            const versioned = 'INTERSECT' in d.minVersions;
            expect(Boolean(note('setops')), `${dialect} setops`).toBe(!allVariants || versioned);
            if (versioned) expect(note('setops')).toContain(d.minVersions.INTERSECT);
            expect(Boolean(note('insert')), `${dialect} insert`).toBe(dialect !== 'generic');
            if (d.supports.upsert === 'on-conflict') expect(note('insert')).toContain('ON CONFLICT');
            if (d.supports.upsert === 'on-duplicate-key') expect(note('insert')).toContain('ON DUPLICATE KEY UPDATE');
        }
    });

    test('every example is SQL the builder reads and writes back the same way, in every dialect', () => {
        for (const key of SECTIONS) {
            for (const dialect of DIALECT_IDS) {
                const { example } = sectionHelp(key, dialect);
                const sql = STATEMENT[key] ? STATEMENT[key](example) : example;
                const result = importSql(sql, { dialect });
                expect(result.ok, `${key} in ${dialect}: ${result.ok ? '' : result.message}`).toBe(true);
                const written = generateQuery(/** @type {any} */ (result).query, { dialect, pretty: false });
                expect(written, `${key} in ${dialect}`).toContain(example);
            }
        }
    });
});

describe('popover placement', () => {
    const viewport = { width: 1000, height: 800 };
    const size = { width: 300, height: 200 };
    const anchor = (left, top, width = 28, height = 28) => ({ left, top, width, bottom: top + height });

    test('below the button, centred on it', () => {
        expect(placePopover(anchor(486, 100), size, viewport)).toEqual({ left: 350, top: 134, maxHeight: null, side: 'below' });
    });

    test('above when there is no room below', () => {
        expect(placePopover(anchor(486, 700), size, viewport)).toEqual({ left: 350, top: 494, maxHeight: null, side: 'above' });
    });

    test('kept inside the left and right edges', () => {
        expect(placePopover(anchor(2, 100), size, viewport).left).toBe(8);
        expect(placePopover(anchor(980, 100), size, viewport).left).toBe(1000 - 8 - 300);
        // A phone narrower than the popover: it fills the width between the margins
        expect(placePopover(anchor(150, 100), { width: 352, height: 200 }, { width: 320, height: 640 }).left).toBe(8);
    });

    test('scrolls inside when it fits neither above nor below', () => {
        const place = placePopover(anchor(100, 300), { width: 300, height: 700 }, { width: 400, height: 640 });
        expect(place).toMatchObject({ side: 'below', top: 334 });
        expect(place.maxHeight).toBe(640 - 8 - 334);
        const high = placePopover(anchor(100, 500), { width: 300, height: 700 }, { width: 400, height: 640 });
        expect(high).toMatchObject({ side: 'above', top: 8, maxHeight: 500 - 6 - 8 });
    });
});
