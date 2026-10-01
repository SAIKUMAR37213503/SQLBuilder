import { describe, expect, test } from 'vitest';
import { fieldContext, suggest, wordAt, writeName, lookupTable, unquote, MAX_SUGGESTIONS } from '../src/suggest.js';
import { readDdl } from '../src/ddl.js';
import { getDialect } from '../src/dialects.js';
import {
    createWorkspace, createJoin, createCondition, createCte, createSubquerySource, createColumn, createOrderItem,
    createGroupByItem, createAssignment, createSelect, createRawCondition, createCaseColumn, createWindowColumn
} from '../src/model.js';

const { tables } = readDdl(`
    CREATE TABLE departments (id int PRIMARY KEY, name varchar(100), budget numeric(12,2));
    CREATE TABLE employees (id int PRIMARY KEY, name text, department_id int REFERENCES departments, salary numeric, hired date);
    CREATE TABLE "order" ("select" int, "unit price" money);
    CREATE TABLE sales.orders (id int, total numeric);
`);
const generic = getDialect('generic');

/** Suggestion labels for `text` typed in the field at `path` (caret at the end unless given) */
function labels(workspace, path, text, { caret = text.length, dialect = generic } = {}) {
    const context = fieldContext(workspace, path, { tables });
    if (!context) return null;
    return suggest(context, text, caret, { tables, dialect }).items.map(i => i.label);
}
function inserts(workspace, path, text, { dialect = generic } = {}) {
    const context = fieldContext(workspace, path, { tables });
    return suggest(context, text, text.length, { tables, dialect }).items.map(i => i.insert);
}

function employeesJoinDepartments() {
    const ws = createWorkspace();
    ws.select.from.table = 'employees';
    ws.select.from.alias = 'e';
    const join = createJoin();
    join.source.table = 'departments';
    join.source.alias = 'd';
    ws.select.joins.push(join);
    return ws;
}

describe('helpers', () => {
    test('wordAt finds the name at the caret, including a qualifier', () => {
        expect(wordAt('COALESCE(e.sa', 13)).toEqual({ from: 9, to: 13, word: 'e.sa' });
        expect(wordAt('e.salary + 1', 4)).toEqual({ from: 0, to: 8, word: 'e.sa' });
        expect(wordAt('a, ', 3)).toEqual({ from: 3, to: 3, word: '' });
        expect(wordAt('données', 7).word).toBe('données');
    });

    test('names are quoted only when they have to be, in the dialect\'s style', () => {
        expect(writeName('employees', generic)).toBe('employees');
        expect(writeName('unit price', generic)).toBe('"unit price"');
        expect(writeName('order', getDialect('sqlserver'))).toBe('[order]');
        expect(writeName('sales.order', getDialect('mysql'))).toBe('sales.`order`');
        expect(unquote('[a]]b]')).toBe('a]b');
        expect(unquote('"a""b"')).toBe('a"b');
    });

    test('lookupTable matches with or without the schema name when that is unambiguous', () => {
        expect(lookupTable(tables, 'ORDERS').name).toBe('sales.orders');
        expect(lookupTable(tables, 'hr.employees').name).toBe('employees');
        expect(lookupTable([...tables, { name: 'hr.orders', columns: [] }], 'orders')).toBeUndefined();
    });
});

describe('which fields get suggestions', () => {
    test('table fields get tables; CTE names only where a FROM or JOIN can use them', () => {
        const ws = createWorkspace();
        ws.select.ctes.push(Object.assign(createCte(), { name: 'recent' }));
        expect(labels(ws, 'select.from.table', '')).toEqual(['recent', 'departments', 'employees', 'order', 'sales.orders']);
        expect(labels(ws, 'select.from.table', 'or')).toEqual(['order', 'sales.orders']);
        expect(labels(ws, 'select.from.table', 'emp')).toEqual(['employees']);
        expect(labels(ws, 'update.table', 're')).toEqual([]);
        expect(labels(ws, 'insert.table', 'dep')).toEqual(['departments']);
        // A CTE can't read itself or the ones after it
        expect(labels(ws, 'select.ctes.0.query.from.table', 're')).toEqual([]);
        expect(inserts(ws, 'select.from.table', 'ord')).toEqual(['"order"', 'sales.orders']);
    });

    test('fields that name something new get none', () => {
        const ws = employeesJoinDepartments();
        ws.select.ctes.push(createCte());
        for (const path of ['select.from.alias', 'select.columns.0.alias', 'select.limit', 'select.ctes.0.name', 'insert.rows.0.values']) {
            expect(fieldContext(ws, path, { tables })).toBeNull();
        }
        ws.select.where.items.push(createCondition());
        // A plain value is data, not a column
        expect(fieldContext(ws, 'select.where.items.0.value', { tables })).toBeNull();
        ws.select.where.items[0].valueType = 'column';
        expect(fieldContext(ws, 'select.where.items.0.value', { tables })).not.toBeNull();
    });
});

describe('column suggestions', () => {
    test('one table: its columns, unqualified, best matches first', () => {
        const ws = createWorkspace();
        ws.select.from.table = 'employees';
        expect(labels(ws, 'select.columns.0.expr', 'na')).toEqual(['name']);
        // Names starting with the text first, then names containing it; functions only by their start
        expect(labels(ws, 'select.columns.0.expr', 'a')).toEqual(['AVG()', 'ABS()', 'name', 'department_id', 'salary']);
        expect(labels(ws, 'select.columns.0.expr', 's')).toEqual(['salary', 'SUM()', 'SUBSTRING()']);
        expect(labels(ws, 'select.columns.0.expr', 'nosuch')).toEqual([]);
    });

    test('several tables: qualified with the alias; "alias." lists that table\'s columns', () => {
        const ws = employeesJoinDepartments();
        expect(labels(ws, 'select.columns.0.expr', 'name')).toEqual(['e.name', 'd.name']);
        expect(inserts(ws, 'select.columns.0.expr', 'bud')).toEqual(['d.budget']);
        expect(labels(ws, 'select.columns.0.expr', 'e')).toContain('e.');
        expect(labels(ws, 'select.columns.0.expr', 'd.')).toEqual(['id', 'name', 'budget']);
        expect(inserts(ws, 'select.columns.0.expr', 'D.na')).toEqual(['D.name']);
        expect(labels(ws, 'select.columns.0.expr', 'x.')).toEqual([]);
    });

    test('every expression field of a SELECT uses the same tables', () => {
        const ws = employeesJoinDepartments();
        const q = ws.select;
        q.joins[0].on.items[0].left = '';
        q.where.items.push(createCondition({ valueType: 'column' }), createRawCondition());
        q.having.items.push(createCondition());
        q.groupBy.push(createGroupByItem());
        q.orderBy.push(createOrderItem());
        q.columns.push(createCaseColumn(), createWindowColumn());
        q.columns[2].func = 'SUM';
        q.columns[2].partitionBy.push({ expr: '' });
        q.columns[2].orderBy.push(createOrderItem());
        for (const path of [
            'select.joins.0.on.items.0.left', 'select.joins.0.on.items.0.value', 'select.where.items.0.left', 'select.where.items.0.value',
            'select.where.items.1.sql', 'select.having.items.0.left', 'select.groupBy.0.expr', 'select.orderBy.0.expr',
            'select.columns.1.cases.0.when', 'select.columns.1.cases.0.then', 'select.columns.1.elseValue', 'select.columns.2.args',
            'select.columns.2.partitionBy.0.expr', 'select.columns.2.orderBy.0.expr'
        ]) {
            expect(labels(ws, path, 'sal'), path).toEqual(['e.salary']);
        }
    });

    test('ORDER BY also offers the output names', () => {
        const ws = createWorkspace();
        ws.select.from.table = 'employees';
        ws.select.columns = [createColumn('salary * 12', { alias: 'yearly' })];
        ws.select.orderBy.push(createOrderItem());
        expect(labels(ws, 'select.orderBy.0.expr', 'ye')).toEqual(['yearly']);
        ws.select.groupBy.push(createGroupByItem());
        expect(labels(ws, 'select.groupBy.0.expr', 'ye')).toEqual([]);
    });

    test('a subquery in WHERE also sees the outer tables; a derived table does not', () => {
        const ws = createWorkspace();
        ws.select.from.table = 'departments';
        const sub = createSelect();
        sub.from.table = 'employees';
        ws.select.where.items.push(createCondition({ op: 'EXISTS', valueType: 'subquery', subquery: sub }));
        sub.where.items.push(createCondition());
        expect(labels(ws, 'select.where.items.0.subquery.where.items.0.left', 'bud')).toEqual(['departments.budget']);
        expect(labels(ws, 'select.where.items.0.subquery.where.items.0.left', 'depa')).toEqual(['department_id', 'departments.']);

        const derived = createWorkspace();
        derived.select.from = createSubquerySource();
        derived.select.from.query.from.table = 'employees';
        derived.select.joins.push(createJoin());
        derived.select.joins[0].source.table = 'departments';
        expect(labels(derived, 'select.from.query.columns.0.expr', 'bud')).toEqual([]);
    });

    test('columns of a derived table and a CTE come from what they select', () => {
        const ws = createWorkspace();
        ws.select.ctes.push(Object.assign(createCte(), { name: 'pay' }));
        const cte = ws.select.ctes[0].query;
        cte.from.table = 'employees';
        cte.columns = [createColumn('department_id'), createColumn('salary', { aggregate: 'SUM', alias: 'total' }), createColumn('COUNT(*)')];
        ws.select.from.table = 'pay';
        // COUNT(*) has no name, so it isn't offered
        expect(labels(ws, 'select.columns.0.expr', '')).toEqual(['department_id', 'total']);
        expect(labels(ws, 'select.columns.0.expr', 't')).toEqual(['total', 'TRIM()', 'department_id']);

        const star = createWorkspace();
        star.select.from = createSubquerySource();
        star.select.from.alias = 'x';
        star.select.from.query.from.table = 'departments';
        star.select.from.query.columns = [createColumn('*')];
        expect(labels(star, 'select.columns.0.expr', 'x.')).toEqual(['id', 'name', 'budget']);
    });

    test('CTEs that refer to each other in a loop end without hanging', () => {
        const ws = createWorkspace();
        ws.select.ctes.push(Object.assign(createCte(), { name: 'a' }), Object.assign(createCte(), { name: 'b' }));
        ws.select.ctes[0].query.from.table = 'b';
        ws.select.ctes[0].query.columns = [createColumn('*')];
        ws.select.ctes[1].query.from.table = 'a';
        ws.select.ctes[1].query.columns = [createColumn('*')];
        ws.select.from.table = 'b';
        expect(labels(ws, 'select.columns.0.expr', 'x')).toEqual([]);
    });

    test('INSERT, UPDATE and upserts use the target table, unqualified', () => {
        const ws = createWorkspace('insert');
        ws.insert.table = 'employees';
        expect(labels(ws, 'insert.columns', 'name, sal')).toEqual(['salary']);
        expect(fieldContext(ws, 'insert.columns', { tables }).functions).toBe(false);
        ws.insert.upsert.mode = 'update';
        ws.insert.upsert.set.push(createAssignment());
        expect(labels(ws, 'insert.upsert.conflict', 'i')).toEqual(['id', 'department_id', 'hired']);
        expect(labels(ws, 'insert.upsert.set.0.column', 'hi')).toEqual(['hired']);
        ws.insert.select.from.table = 'departments';
        expect(labels(ws, 'insert.select.columns.0.expr', 'bud')).toEqual(['budget']);

        ws.update.table = 'departments';
        ws.update.set[0].valueType = 'column';
        ws.update.where.items.push(createCondition());
        expect(labels(ws, 'update.set.0.column', 'bu')).toEqual(['budget']);
        expect(labels(ws, 'update.set.0.value', 'bu')).toEqual(['budget']);
        expect(labels(ws, 'update.where.items.0.left', 'n')).toEqual(['name', 'NULLIF()']);
        ws.delete.table = 'order';
        ws.delete.where.items.push(createCondition());
        expect(inserts(ws, 'delete.where.items.0.left', 'uni', { dialect: getDialect('sqlserver') })).toEqual(['[unit price]']);
    });

    test('dialect functions follow the selected dialect', () => {
        const ws = createWorkspace();
        ws.select.from.table = 'employees';
        expect(labels(ws, 'select.columns.0.expr', 'len', { dialect: getDialect('sqlserver') })).toEqual(['LEN()']);
        expect(labels(ws, 'select.columns.0.expr', 'len', { dialect: getDialect('postgresql') })).toEqual(['LENGTH()']);
        expect(labels(ws, 'select.columns.0.expr', 'ifn', { dialect: getDialect('mysql') })).toEqual(['IFNULL()']);
        expect(inserts(ws, 'select.columns.0.expr', 'coal')).toEqual(['COALESCE(']);
    });

    test('an unknown table gives no columns, and exactly what is typed isn\'t offered again', () => {
        const ws = createWorkspace();
        ws.select.from.table = 'nosuch';
        expect(labels(ws, 'select.columns.0.expr', 'nu')).toEqual(['NULLIF()']);
        ws.select.from.table = 'employees';
        expect(labels(ws, 'select.columns.0.expr', 'hired')).toEqual([]);
    });

    test('long lists are capped', () => {
        const many = [{ name: 'wide', columns: Array.from({ length: 300 }, (_, i) => ({ name: `c${i}`, type: '', nullable: true })), primaryKey: [], unique: [], foreignKeys: [] }];
        const ws = createWorkspace();
        ws.select.from.table = 'wide';
        const context = fieldContext(ws, 'select.columns.0.expr', { tables: many });
        expect(suggest(context, 'c', 1, { tables: many, dialect: generic }).items).toHaveLength(MAX_SUGGESTIONS);
    });
});
