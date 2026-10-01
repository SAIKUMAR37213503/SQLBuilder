import { describe, expect, test } from 'vitest';
import { EXAMPLES, examplesFor } from '../src/examples.js';
import { generateSQL } from '../src/generator.js';
import { validateWorkspace } from '../src/validation.js';
import { importSql } from '../src/sql-import.js';
import { describeStructure } from '../src/structure.js';
import { levelNotes } from '../src/explain.js';
import { getDialect } from '../src/dialects.js';
import { fieldContext } from '../src/suggest.js';
import { cteReferences, refersToItself } from '../src/recursion.js';
import {
    MODEL_VERSION, createWorkspace, createCte, createSelect, createSetOp, createJoin, createTableSource, createColumn,
    workspaceVersion, withModelVersion, usesRecursiveCte
} from '../src/model.js';
import {
    normalizeWorkspace, parseQueryFile, createQueryExport, createTemplatesExport, parseTemplatesFile, createBackup, parseBackupFile
} from '../src/serialization.js';
import { createStorage, createMemoryBackend } from '../src/storage.js';
import { createHistory } from '../src/history.js';
import { createTemplateStore } from '../src/templates.js';

const DIALECTS = ['generic', 'sqlserver', 'postgresql', 'mysql'];
const orgChart = () => EXAMPLES.find(e => e.id === 'org-chart').build();
const flat = (ws, dialect = 'generic', options = {}) => generateSQL(ws, { dialect, pretty: false, ...options });
const messages = (ws, dialect, levels = ['error', 'warning', 'info']) =>
    validateWorkspace(ws, { dialect }).filter(i => levels.includes(i.level)).map(i => `${i.level}: ${i.message}`);
const cteOf = (ws) => ws.select.ctes[0];
const recursivePart = (ws) => cteOf(ws).query.setOps[0].query;

const ORG_CHART_BODY = 'reports (id, name, manager_id, depth) AS (SELECT id, name, manager_id, 0 FROM employees WHERE manager_id IS NULL '
    + 'UNION ALL SELECT e.id, e.name, e.manager_id, r.depth + 1 FROM employees AS e INNER JOIN reports AS r ON e.manager_id = r.id WHERE r.depth < 10) '
    + 'SELECT id, name, depth FROM reports ORDER BY depth, name;';

// The org chart SQL was also run against sample data in SQLite (a cycle in
// the data included) while it was written: the depth condition stops it.
describe('writing recursive CTEs', () => {
    test('WITH RECURSIVE, and plain WITH on SQL Server', () => {
        const ws = orgChart();
        expect(flat(ws, 'generic')).toBe(`WITH RECURSIVE ${ORG_CHART_BODY}`);
        expect(flat(ws, 'postgresql')).toBe(`WITH RECURSIVE ${ORG_CHART_BODY}`);
        expect(flat(ws, 'mysql')).toBe(`WITH RECURSIVE ${ORG_CHART_BODY}`);
        expect(flat(ws, 'sqlserver')).toBe(`WITH ${ORG_CHART_BODY}`);
    });

    test('one recursive CTE makes the whole list WITH RECURSIVE', () => {
        const ws = orgChart();
        const plain = { ...createCte(), name: 'managers', query: { ...createSelect(), from: createTableSource('employees'), columns: [createColumn('id')] } };
        ws.select.ctes.unshift(plain);
        expect(flat(ws)).toMatch(/^WITH RECURSIVE managers AS \(SELECT id FROM employees\), reports \(id, name, manager_id, depth\) AS \(/);
    });

    test('the pretty layout, keyword case, quoting and leading commas', () => {
        const ws = orgChart();
        expect(generateSQL(ws, { dialect: 'postgresql' }).split('\n').slice(0, 3)).toEqual([
            'WITH RECURSIVE reports (id, name, manager_id, depth) AS (',
            '    SELECT',
            '        id,'
        ]);
        expect(flat(ws, 'postgresql', { keywordCase: 'lower' })).toMatch(/^with recursive reports \(id, name, manager_id, depth\) as \(select /);
        expect(flat(ws, 'mysql', { quoteIdentifiers: true })).toMatch(/^WITH RECURSIVE `reports` \(`id`, `name`, `manager_id`, `depth`\) AS \(/);
        expect(flat(ws, 'sqlserver', { quoteIdentifiers: true })).toMatch(/^WITH \[reports\] \(\[id\], \[name\], \[manager_id\], \[depth\]\) AS \(/);
        const leading = generateSQL(ws, { dialect: 'generic', commaPosition: 'leading' });
        expect(leading.split('\n')[0]).toBe('WITH RECURSIVE reports (id, name, manager_id, depth) AS (');
    });

    test('a column list without recursion, and nothing new when neither is used', () => {
        const ws = orgChart();
        cteOf(ws).recursive = false;
        expect(flat(ws)).toBe(`WITH ${ORG_CHART_BODY}`);
        cteOf(ws).columns = '  ';
        expect(flat(ws)).toMatch(/^WITH reports AS \(SELECT /);
    });

    test('the example is listed in every dialect as an advanced CTE example', () => {
        for (const dialect of DIALECTS) expect(examplesFor(dialect).map(e => e.id), dialect).toContain('org-chart');
        const example = EXAMPLES.find(e => e.id === 'org-chart');
        expect(example).toMatchObject({ level: 'advanced', topic: 'Subqueries and CTEs' });
    });

    test.each(DIALECTS)('%s: the example has no errors, warnings or tips', (dialect) => {
        expect(messages(orgChart(), dialect)).toEqual([]);
    });
});

describe('checks on recursive CTEs', () => {
    const variant = (change) => {
        const ws = orgChart();
        change(ws);
        return ws;
    };
    const has = (ws, dialect, level, text) => {
        const found = validateWorkspace(ws, { dialect }).filter(i => i.level === level && i.message.includes(text));
        expect(found.length, `${dialect} ${level}: ${text}`).toBeGreaterThan(0);
        return found[0];
    };
    const lacks = (ws, dialect, text) => {
        expect(validateWorkspace(ws, { dialect }).filter(i => i.message.includes(text)).map(i => i.message), dialect).toEqual([]);
    };

    test('without a UNION part it is an error in every dialect', () => {
        const ws = variant(w => { recursivePart(w); cteOf(w).query.setOps = []; });
        for (const dialect of DIALECTS) {
            expect(has(ws, dialect, 'error', 'UNION').path).toBe('select.ctes.0.recursive');
        }
    });

    test('a first part that uses the CTE is an error', () => {
        const ws = variant(w => { cteOf(w).query.from = createTableSource('reports'); });
        for (const dialect of DIALECTS) has(ws, dialect, 'error', 'first');
    });

    test('UNION instead of UNION ALL: refused only by SQL Server', () => {
        const ws = variant(w => { cteOf(w).query.setOps[0].op = 'UNION'; });
        has(ws, 'sqlserver', 'error', 'UNION ALL');
        for (const dialect of ['generic', 'postgresql', 'mysql']) lacks(ws, dialect, 'UNION ALL');
    });

    test('INTERSECT or EXCEPT joining the recursive part is an error', () => {
        const ws = variant(w => { cteOf(w).query.setOps[0].op = 'EXCEPT'; });
        for (const dialect of DIALECTS) has(ws, dialect, 'error', 'UNION');
    });

    test('a recursive part that never uses the CTE is a warning', () => {
        const ws = variant(w => { recursivePart(w).joins[0].source = createTableSource('managers', 'r'); });
        for (const dialect of DIALECTS) has(ws, dialect, 'warning', 'reports');
    });

    test('using the CTE twice, or inside a subquery, is an error', () => {
        const twice = variant(w => {
            const again = createJoin('INNER JOIN');
            again.source = createTableSource('reports', 'r2');
            recursivePart(w).joins.push(again);
        });
        for (const dialect of DIALECTS) has(twice, dialect, 'error', 'once');
        const nested = variant(w => {
            recursivePart(w).joins[0].source = { kind: 'subquery', alias: 'r', query: { ...createSelect(), from: createTableSource('reports'), columns: [createColumn('*')] } };
        });
        for (const dialect of DIALECTS) has(nested, dialect, 'error', 'once');
    });

    test('a second recursive part: refused only by PostgreSQL', () => {
        const ws = variant(w => {
            const extra = createSetOp('UNION ALL');
            extra.query = structuredClone(recursivePart(w));
            cteOf(w).query.setOps.push(extra);
        });
        has(ws, 'postgresql', 'error', 'one');
        for (const dialect of ['generic', 'sqlserver', 'mysql']) {
            expect(validateWorkspace(ws, { dialect }).filter(i => i.level === 'error').map(i => i.message), dialect).toEqual([]);
        }
    });

    test('what each dialect refuses in the recursive part', () => {
        const grouped = variant(w => { recursivePart(w).groupBy = [{ expr: 'e.id' }, { expr: 'e.name' }, { expr: 'e.manager_id' }, { expr: 'r.depth' }]; });
        for (const dialect of ['sqlserver', 'mysql']) has(grouped, dialect, 'error', 'GROUP BY');
        for (const dialect of ['generic', 'postgresql']) lacks(grouped, dialect, 'recursive part');

        const distinct = variant(w => { recursivePart(w).distinct = true; });
        for (const dialect of ['sqlserver', 'mysql']) has(distinct, dialect, 'error', 'DISTINCT');
        for (const dialect of ['generic', 'postgresql']) lacks(distinct, dialect, 'DISTINCT');

        const outer = variant(w => { recursivePart(w).joins[0].type = 'LEFT JOIN'; });
        has(outer, 'sqlserver', 'error', 'LEFT, RIGHT or FULL');
        for (const dialect of ['generic', 'postgresql', 'mysql']) lacks(outer, dialect, 'LEFT, RIGHT or FULL');

        const counted = variant(w => { recursivePart(w).columns[3] = createColumn('r.depth', { aggregate: 'MAX' }); });
        for (const dialect of DIALECTS) has(counted, dialect, 'error', 'aggregate');
    });

    test('no condition in the recursive part: a warning naming the dialect\'s limit', () => {
        const ws = variant(w => { recursivePart(w).where.items = []; });
        for (const dialect of DIALECTS) {
            const issue = has(ws, dialect, 'warning', 'limits how deep');
            expect(issue.message).toContain(getDialect(dialect).recursive.depthLimit);
            expect(issue.path).toBe('select.ctes.0.query.setOps.0.query.where');
        }
    });

    test('ORDER BY or a row limit on the recursive CTE', () => {
        const sorted = variant(w => { cteOf(w).query.orderBy = [{ expr: 'depth', direction: 'ASC' }]; });
        has(sorted, 'generic', 'warning', 'ORDER BY');
        for (const dialect of ['sqlserver', 'postgresql', 'mysql']) has(sorted, dialect, 'error', 'ORDER BY');
        const limited = variant(w => { cteOf(w).query.limit = '100'; });
        has(limited, 'generic', 'warning', 'LIMIT');
        has(limited, 'postgresql', 'error', 'LIMIT');
        has(limited, 'sqlserver', 'error', 'TOP');
        lacks(limited, 'mysql', 'recursive CTE');
    });

    test('a column list must match the query and be plain names', () => {
        const short = variant(w => { cteOf(w).columns = 'id, name, manager_id'; });
        for (const dialect of DIALECTS) expect(has(short, dialect, 'error', '3').path).toBe('select.ctes.0.columns');
        const bad = variant(w => { cteOf(w).columns = 'id, name, manager id, depth'; });
        for (const dialect of DIALECTS) has(bad, dialect, 'error', 'manager id');
    });

    test('text that grows each level: a tip on MySQL and SQL Server', () => {
        const ws = variant(w => {
            cteOf(w).columns = 'id, name, manager_id, depth, path';
            cteOf(w).query.columns.push(createColumn('name'));
            recursivePart(w).columns.push(createColumn("CONCAT(r.path, ' > ', e.name)"));
        });
        has(ws, 'mysql', 'info', 'CHAR(1000)');
        has(ws, 'sqlserver', 'info', 'NVARCHAR');
        for (const dialect of ['generic', 'postgresql']) lacks(ws, dialect, 'CAST');
    });

    test('a CTE that uses its own name without Recursive', () => {
        const ws = variant(w => { cteOf(w).recursive = false; });
        has(ws, 'sqlserver', 'error', 'Recursive');
        for (const dialect of ['generic', 'postgresql', 'mysql']) has(ws, dialect, 'info', 'Recursive');
    });
});

describe('where a CTE refers to itself', () => {
    test('direct uses are FROM and JOIN tables; everything else is nested', () => {
        const ws = orgChart();
        expect(cteReferences(cteOf(ws).query, 'reports')).toEqual({ direct: 1, nested: 0 });
        expect(cteReferences(cteOf(ws).query, 'REPORTS', { setOps: false })).toEqual({ direct: 0, nested: 0 });
        expect(cteReferences(cteOf(ws).query, '"reports"')).toEqual({ direct: 1, nested: 0 });
        recursivePart(ws).where.items[0].left = '(SELECT MAX(depth) FROM reports)';
        expect(cteReferences(cteOf(ws).query, 'reports')).toEqual({ direct: 1, nested: 1 });
        expect(refersToItself(cteOf(ws))).toBe(true);
    });

    test('a qualified name is a table, not the CTE', () => {
        const ws = orgChart();
        recursivePart(ws).joins[0].source = createTableSource('hr.reports', 'r');
        recursivePart(ws).columns[0] = createColumn('hr.reports.id');
        expect(cteReferences(cteOf(ws).query, 'reports')).toEqual({ direct: 0, nested: 0 });
    });
});

describe('importing recursive CTEs', () => {
    // As a workspace, like the Import SQL dialog loads it
    const read = (text, dialect = 'generic') => {
        const result = importSql(text, { dialect });
        if (!result.ok) throw new Error(result.message);
        return { ...createWorkspace('select'), select: result.query };
    };

    test.each(DIALECTS)('%s: the example comes back exactly', (dialect) => {
        const sql = generateSQL(orgChart(), { dialect });
        const back = read(sql, dialect);
        expect(cteOf(back)).toMatchObject({ name: 'reports', recursive: true, columns: 'id, name, manager_id, depth' });
        expect(generateSQL(back, { dialect })).toBe(sql);
    });

    test('SQL Server\'s plain WITH is recursive when the CTE uses its own name', () => {
        const sql = 'WITH t AS (SELECT id FROM nodes WHERE parent IS NULL UNION ALL SELECT n.id FROM nodes AS n JOIN t ON n.parent = t.id) SELECT id FROM t';
        expect(cteOf(read(sql, 'sqlserver')).recursive).toBe(true);
    });

    test('elsewhere, plain WITH means the table with the same name', () => {
        const sql = 'WITH employees AS (SELECT id FROM employees WHERE active = 1) SELECT id FROM employees';
        for (const dialect of ['generic', 'postgresql', 'mysql']) {
            const back = read(sql, dialect);
            expect(cteOf(back).recursive, dialect).toBe(false);
            expect(flat(back, dialect)).toBe(`${sql};`);
        }
    });

    test('RECURSIVE marks only the CTEs that use their own name', () => {
        const back = read('WITH RECURSIVE a AS (SELECT id FROM t), b (n) AS (SELECT 1 FROM a UNION ALL SELECT n + 1 FROM b WHERE n < 5) SELECT n FROM b');
        expect(back.select.ctes.map(c => [c.name, c.recursive, c.columns])).toEqual([['a', false, ''], ['b', true, 'n']]);
    });

    test('quoted column names are kept as written', () => {
        const back = read('WITH RECURSIVE "r" ("Id", "Depth") AS (SELECT id, 0 FROM t UNION ALL SELECT id, "Depth" + 1 FROM "r" WHERE "Depth" < 3) SELECT "Id" FROM "r"', 'postgresql');
        expect(cteOf(back)).toMatchObject({ recursive: true, columns: '"Id", "Depth"' });
    });
});

describe('explaining recursive CTEs', () => {
    test('the WITH step names the recursive CTE in each dialect\'s words', () => {
        for (const dialect of DIALECTS) {
            const step = describeStructure(orgChart(), getDialect(dialect)).steps[0];
            expect(step.clause).toBe(dialect === 'sqlserver' ? 'WITH' : 'WITH RECURSIVE');
            expect(step.detail).toBe('1 named query: reports (recursive: reports)');
            expect(step.explanation).toContain('runs its UNION part again');
        }
    });

    test('Developer adds the depth limit; Advanced adds the column types', () => {
        for (const dialect of DIALECTS) {
            const d = getDialect(dialect);
            expect(levelNotes(orgChart(), d, 'beginner')).toEqual({});
            expect(levelNotes(orgChart(), d, 'developer').with).toContain(d.recursive.depthLimit);
            const advanced = levelNotes(orgChart(), d, 'advanced').with;
            if (d.recursive.growingText) expect(advanced).toContain(d.recursive.growingText);
        }
        const plain = orgChart();
        cteOf(plain).recursive = false;
        expect(levelNotes(plain, getDialect('generic'), 'advanced').with.join(' ')).not.toContain('recursive');
    });
});

describe('suggestions inside a recursive CTE', () => {
    test('the recursive CTE sees itself, with its listed column names', () => {
        const ws = orgChart();
        const inside = fieldContext(ws, 'select.ctes.0.query.setOps.0.query.joins.0.source.table', { tables: [] });
        expect(inside.ctes).toEqual(['reports']);
        const column = fieldContext(ws, 'select.ctes.0.query.setOps.0.query.columns.3.expr', { tables: [] });
        expect(column.local.find(s => s.ref === 'r').columns.map(c => c.name)).toEqual(['id', 'name', 'manager_id', 'depth']);
        cteOf(ws).recursive = false;
        expect(fieldContext(ws, 'select.ctes.0.query.setOps.0.query.joins.0.source.table', { tables: [] }).ctes).toEqual([]);
    });
});

describe('model version', () => {
    const memoryStorage = () => createStorage(createMemoryBackend());

    test('version 2 only when a CTE is recursive', () => {
        expect(MODEL_VERSION).toBe(2);
        expect(createCte()).toMatchObject({ recursive: false, columns: '' });
        expect(createWorkspace('select').version).toBe(1);
        expect(workspaceVersion(orgChart())).toBe(2);
        expect(usesRecursiveCte(orgChart())).toBe(true);
        for (const example of EXAMPLES.filter(e => e.id !== 'org-chart')) {
            expect(workspaceVersion(example.build()), example.id).toBe(1);
            expect(withModelVersion(example.build()).version, example.id).toBe(1);
        }
        const nested = createWorkspace('select');
        nested.select.where.items.push({ kind: 'condition', valueType: 'subquery', subquery: { ...createSelect(), ctes: [{ ...createCte(), recursive: true }] } });
        expect(workspaceVersion(nested)).toBe(2);
    });

    test('a version 1 file with CTEs loads with the new fields off', () => {
        const v1 = {
            version: 1, type: 'select',
            select: { ...createSelect(), from: createTableSource('r'), columns: [createColumn('id')], ctes: [{ name: 'r', query: { ...createSelect(), from: createTableSource('t'), columns: [createColumn('id')] } }] }
        };
        const ws = normalizeWorkspace(v1);
        expect(cteOf(ws)).toMatchObject({ name: 'r', recursive: false, columns: '' });
        expect(flat(ws)).toBe('WITH r AS (SELECT id FROM t) SELECT id FROM r;');
    });

    test('exports are version 1 unless recursion is used, and load back', () => {
        const plain = EXAMPLES.find(e => e.id === 'cte').build();
        expect(createQueryExport(plain)).toMatchObject({ version: 1, query: { version: 1 } });
        const file = createQueryExport(orgChart());
        expect(file).toMatchObject({ version: 2, query: { version: 2 } });
        const back = parseQueryFile(JSON.stringify(file));
        expect(back.ok).toBe(true);
        expect(flat(back.workspace)).toBe(flat(orgChart()));
    });

    test('a file from a newer version is refused, not loaded broken', () => {
        const file = createQueryExport(orgChart());
        file.version = 3;
        file.query.version = 3;
        expect(parseQueryFile(JSON.stringify(file))).toEqual({ ok: false, error: 'This file was made by a newer version of the app.' });
        expect(() => normalizeWorkspace({ ...orgChart(), version: 3 })).toThrow('newer version');
    });

    test('history, templates and backups store the version each query needs', () => {
        const storage = memoryStorage();
        const history = createHistory(storage);
        history.add({ type: 'select', dialect: 'generic', sql: 'x', workspace: orgChart() });
        history.add({ type: 'select', dialect: 'generic', sql: 'y', workspace: createWorkspace('select') });
        expect(storage.get('history').map(e => e.workspace.version)).toEqual([1, 2]);
        expect(createHistory(storage).list().length).toBe(2);

        const templates = createTemplateStore(storage);
        templates.create('Org', orgChart());
        templates.create('Plain', createWorkspace('select'));
        expect(storage.get('templates').map(t => [t.name, t.workspace.version])).toEqual([['Org', 2], ['Plain', 1]]);
        const reloaded = createTemplateStore(storage).list();
        expect(cteOf(reloaded[0].workspace).recursive).toBe(true);

        const exported = createTemplatesExport(reloaded);
        expect(exported.version).toBe(2);
        expect(parseTemplatesFile(JSON.stringify(exported)).ok).toBe(true);
        expect(createTemplatesExport([reloaded[1]]).version).toBe(1);

        const backup = createBackup({ templates: reloaded, history: createHistory(storage).list(), settings: {} });
        expect(backup.modelVersion).toBe(2);
        const parsed = parseBackupFile(JSON.stringify(backup));
        expect(parsed.ok).toBe(true);
        expect(parsed.templates.map(t => cteOf(t.workspace)?.recursive ?? null)).toEqual([true, null]);
    });
});
