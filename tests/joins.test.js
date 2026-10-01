import { describe, expect, test } from 'vitest';
import { analyzeJoin, applyJoinCandidate, checkSchema, isEmptyGroup } from '../src/joins.js';
import { readDdl } from '../src/ddl.js';
import { getDialect } from '../src/dialects.js';
import { generateSQL } from '../src/generator.js';
import { validateWorkspace } from '../src/validation.js';
import {
    createWorkspace, createJoin, createCondition, createCte, createColumn, createSelect, createAssignment, createOrderItem, createGroup
} from '../src/model.js';

const { tables } = readDdl(`
    CREATE TABLE departments (id int PRIMARY KEY, name text, head_id int);
    CREATE TABLE employees (id int PRIMARY KEY, name text, email text UNIQUE, department_id int REFERENCES departments, manager_id int REFERENCES employees);
    CREATE TABLE projects (id int PRIMARY KEY, name text, department_id int REFERENCES departments, lead_id int REFERENCES employees);
    CREATE TABLE tags (label text, note text);
    CREATE TABLE order_lines (order_id int, line int, PRIMARY KEY (order_id, line));
    CREATE TABLE shipments (id int PRIMARY KEY, order_id int, line int, FOREIGN KEY (order_id, line) REFERENCES order_lines);
    ALTER TABLE departments ADD FOREIGN KEY (head_id) REFERENCES employees (id);
`);
const generic = getDialect('generic');

/** employees e JOIN <table> <alias> */
function withJoin(table, alias, type = 'INNER JOIN') {
    const ws = createWorkspace();
    ws.select.from.table = 'employees';
    ws.select.from.alias = 'e';
    ws.select.columns = [createColumn('e.name')];
    const join = createJoin(type);
    join.source.table = table;
    join.source.alias = alias;
    ws.select.joins.push(join);
    return ws;
}
const labels = (ws, path = 'select.joins.0') => analyzeJoin(ws, path, tables, generic).candidates.map(c => c.label);
const messages = (ws) => checkSchema(ws, tables, generic).map(i => `${i.level} ${i.path}: ${i.message}`);
function on(ws, left, right, i = 0) {
    ws.select.joins[i].on = createGroup('AND', [createCondition({ left, op: '=', valueType: 'column', value: right })]);
}

describe('ON suggestions from foreign keys', () => {
    test('both directions, with the aliases as typed', () => {
        // employees → departments, and departments.head_id → employees
        expect(labels(withJoin('departments', 'd'))).toEqual(['e.department_id = d.id', 'e.id = d.head_id']);
        // Without an alias the table name qualifies the columns
        expect(labels(withJoin('projects', ''))).toEqual(['e.id = projects.lead_id']);
    });

    test('a self-join offers both ways round', () => {
        expect(labels(withJoin('employees', 'm'))).toEqual(['e.manager_id = m.id', 'e.id = m.manager_id']);
    });

    test('composite keys become one suggestion with AND; quoted names stay quoted', () => {
        const ws = createWorkspace();
        ws.select.from.table = 'order_lines';
        ws.select.joins.push(createJoin());
        ws.select.joins[0].source.table = 'shipments';
        ws.select.joins[0].source.alias = 's';
        expect(labels(ws)).toEqual(['order_lines.order_id = s.order_id AND order_lines.line = s.line']);
        const quoted = readDdl('CREATE TABLE "a b" ("my id" int PRIMARY KEY); CREATE TABLE c (ref int REFERENCES "a b");').tables;
        const ws2 = createWorkspace();
        ws2.select.from.table = 'c';
        ws2.select.joins.push(createJoin());
        ws2.select.joins[0].source.table = '"a b"';
        ws2.select.joins[0].source.alias = 'x';
        expect(analyzeJoin(ws2, 'select.joins.0', quoted, getDialect('sqlserver')).candidates.map(c => c.label)).toEqual(['c.ref = x.[my id]']);
    });

    test('a later join can link to any table before it, but not to later ones', () => {
        const ws = withJoin('departments', 'd');
        ws.select.joins.push(createJoin());
        ws.select.joins[1].source.table = 'projects';
        ws.select.joins[1].source.alias = 'p';
        expect(labels(ws, 'select.joins.1')).toEqual(['e.id = p.lead_id', 'd.id = p.department_id']);
    });

    test('unknown tables, CTEs, subqueries and CROSS JOIN get none', () => {
        expect(labels(withJoin('nosuch', 'n'))).toEqual([]);
        expect(analyzeJoin(withJoin('departments', 'd', 'CROSS JOIN'), 'select.joins.0', tables, generic)).toBeNull();
        const ws = withJoin('departments', 'd');
        ws.select.ctes.push(Object.assign(createCte(), { name: 'departments' }));
        expect(labels(ws)).toEqual([]);
        expect(labels(withJoin('tags', 't'))).toEqual([]);
    });

    test('applying a suggestion fills ON, and the SQL is what it says', () => {
        const ws = withJoin('departments', 'd');
        expect(isEmptyGroup(ws.select.joins[0].on)).toBe(true);
        const [first] = analyzeJoin(ws, 'select.joins.0', tables, generic).candidates;
        applyJoinCandidate(ws.select.joins[0], first);
        expect(isEmptyGroup(ws.select.joins[0].on)).toBe(false);
        expect(validateWorkspace(ws)).toEqual([]);
        expect(generateSQL(ws, { pretty: false })).toBe('SELECT e.name FROM employees AS e INNER JOIN departments AS d ON e.department_id = d.id;');
        expect(messages(ws)).toEqual([]);
    });
});

describe('join checks', () => {
    test('an ON that ignores the schema\'s link gets a tip', () => {
        const ws = withJoin('departments', 'd');
        on(ws, 'e.name', 'd.name');
        expect(messages(ws)).toEqual([
            'info select.joins.0.on: Your schema links departments by e.department_id = d.id (or 1 other way); this ON condition uses other columns.',
            "warning select.joins.0.on: e.name = d.name isn't a key on either side, so a row can match several rows and results can repeat. Check the join, or use DISTINCT or GROUP BY if that's intended."
        ]);
        // Either way round matches the suggestion
        on(ws, 'd.id', 'E.DEPARTMENT_ID');
        expect(messages(ws)).toEqual([]);
        on(ws, 'd.head_id', 'e.id');
        expect(messages(ws)).toEqual([]);
    });

    test('no foreign key between the tables: a tip; keys on one side: no repeat warning', () => {
        const ws = withJoin('tags', 't');
        on(ws, 'e.name', 't.label');
        expect(messages(ws)).toEqual([
            'info select.joins.0.on: No foreign key in your schema links tags to the tables before it; check that the ON condition is what you mean.',
            "warning select.joins.0.on: e.name = t.label isn't a key on either side, so a row can match several rows and results can repeat. Check the join, or use DISTINCT or GROUP BY if that's intended."
        ]);
        on(ws, 'e.email', 't.label');
        expect(messages(ws)).toEqual([
            'info select.joins.0.on: No foreign key in your schema links tags to the tables before it; check that the ON condition is what you mean.'
        ]);
        // Unqualified names are found in the one table that has them
        on(ws, 'email', 'label');
        expect(messages(ws)).toHaveLength(1);
    });

    test('a composite key counts only when all of it is used', () => {
        const ws = createWorkspace();
        ws.select.from.table = 'order_lines';
        ws.select.joins.push(createJoin());
        ws.select.joins[0].source.table = 'shipments';
        ws.select.joins[0].source.alias = 's';
        on(ws, 'order_lines.order_id', 's.order_id');
        expect(messages(ws).some(m => m.startsWith('warning'))).toBe(true);
        ws.select.joins[0].on.items.push(createCondition({ left: 'order_lines.line', op: '=', valueType: 'column', value: 's.line' }));
        expect(messages(ws)).toEqual([]);
    });

    test('an empty ON is left to the hint and the existing error', () => {
        expect(messages(withJoin('departments', 'd'))).toEqual([]);
    });
});

describe('unknown tables and columns', () => {
    test('are tips, never errors, and only with a schema', () => {
        const ws = withJoin('departmnts', 'd');
        ws.select.columns = [createColumn('e.salry'), createColumn('e.name'), createColumn('COUNT(*)'), createColumn('e.*')];
        on(ws, 'e.department_id', 'd.id');
        expect(messages(ws)).toEqual([
            'info select.columns.0.expr: “e.salry”: employees has no column salry in your schema.',
            "info select.joins.0.source.table: “departmnts” isn't in your schema."
        ]);
        expect(checkSchema(ws, [], generic)).toEqual([]);
        expect(checkSchema(ws, tables, generic).every(i => i.level !== 'error')).toBe(true);
    });

    test('unqualified names are checked only when every table in scope is known', () => {
        const ws = createWorkspace();
        ws.select.from.table = 'employees';
        ws.select.columns = [createColumn('nme'), createColumn('name', { alias: 'who' }), createColumn('NULL'), createColumn('upper(name)')];
        ws.select.orderBy.push(createOrderItem('who'), createOrderItem('whom'));
        ws.select.where.items.push(createCondition({ left: 'employees', op: 'IS NOT NULL' }));
        expect(messages(ws)).toEqual([
            "info select.columns.0.expr: “nme” isn't a column of employees in your schema.",
            "info select.orderBy.1.expr: “whom” isn't a column of employees in your schema."
        ]);
        ws.select.joins.push(createJoin());
        ws.select.joins[0].source.table = 'unknown_table';
        on(ws, 'employees.id', 'unknown_table.id');
        expect(messages(ws)).toEqual(["info select.joins.0.source.table: “unknown_table” isn't in your schema."]);
    });

    test('CTEs, derived tables and correlated subqueries', () => {
        const ws = createWorkspace();
        ws.select.ctes.push(Object.assign(createCte(), { name: 'staff' }));
        ws.select.ctes[0].query.from.table = 'employees';
        ws.select.ctes[0].query.columns = [createColumn('nam')];
        ws.select.from.table = 'staff';
        ws.select.columns = [createColumn('anything')];
        const sub = createSelect();
        sub.from.table = 'projects';
        sub.where.items.push(createCondition({ left: 'projects.lead_id', op: '=', valueType: 'column', value: 'staff.id' }));
        ws.select.where.items.push(createCondition({ op: 'EXISTS', valueType: 'subquery', subquery: sub }));
        expect(messages(ws)).toEqual([
            "info select.ctes.0.query.columns.0.expr: “nam” isn't a column of employees in your schema."
        ]);
    });

    test('INSERT, UPDATE and DELETE check their target table; unused INSERT parts are skipped', () => {
        const ws = createWorkspace('insert');
        ws.insert.table = 'employees';
        ws.insert.columns = 'name, emial';
        ws.insert.select.from.table = 'hidden_while_values';
        expect(messages(ws)).toEqual(["info insert.columns: “emial” isn't a column of employees in your schema."]);
        ws.insert.upsert.mode = 'update';
        ws.insert.upsert.conflict = 'id';
        ws.insert.upsert.set.push(createAssignment());
        ws.insert.upsert.set[0].column = 'nme';
        expect(messages(ws)).toContain("info insert.upsert.set.0.column: “nme” isn't a column of employees in your schema.");

        ws.type = 'update';
        ws.update.table = 'projects';
        ws.update.set[0].column = 'budget';
        expect(messages(ws)).toEqual(["info update.set.0.column: “budget” isn't a column of projects in your schema."]);
        ws.type = 'delete';
        ws.delete.table = 'archive';
        expect(messages(ws)).toEqual(["info delete.table: “archive” isn't in your schema."]);
    });

    test('the checks never change generated SQL', () => {
        const ws = withJoin('departments', 'd');
        on(ws, 'e.name', 'd.name');
        const before = generateSQL(ws);
        checkSchema(ws, tables, generic);
        expect(generateSQL(ws)).toBe(before);
    });
});
