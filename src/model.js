// Query model: plain JSON-serialisable objects describing a query.
// Everything else (generation, validation, history, templates, import/export,
// undo) operates on this structure, never on SQL strings.

// The newest query model version this app reads. Version 2 added recursive
// CTEs (a CTE's `recursive` flag and `columns` list). A workspace is saved as
// version 2 only when it uses a recursive CTE, so everything else stays
// readable by earlier versions of the app, which refuse newer versions
// instead of loading them without the recursion.
export const MODEL_VERSION = 2;
const BASE_MODEL_VERSION = 1;

export const QUERY_TYPES = ['select', 'insert', 'update', 'delete'];

export const JOIN_TYPES = ['INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN'];

// Set operators combine SELECTs. Dialect support is checked in validation.
export const SET_OPERATORS = ['UNION', 'UNION ALL', 'INTERSECT', 'INTERSECT ALL', 'EXCEPT', 'EXCEPT ALL'];

export const AGGREGATES = ['', 'COUNT', 'COUNT DISTINCT', 'SUM', 'AVG', 'MIN', 'MAX'];

export const SORT_DIRECTIONS = ['ASC', 'DESC'];

// Window functions, grouped by the arguments they take:
//   none    – RANK()            ntile  – NTILE(n)
//   offset  – LAG(expr[, offset[, default]])
//   value   – FIRST_VALUE(expr) nth    – NTH_VALUE(expr, n)
//   aggregate – SUM(expr) etc.; COUNT with no argument is COUNT(*)
// ordered: needs ORDER BY in OVER to be meaningful (required by SQL Server)
// frame:   accepts a ROWS frame
export const WINDOW_FUNCTIONS = {
    'ROW_NUMBER': { args: 'none', ordered: true, frame: false },
    'RANK': { args: 'none', ordered: true, frame: false },
    'DENSE_RANK': { args: 'none', ordered: true, frame: false },
    'PERCENT_RANK': { args: 'none', ordered: true, frame: false },
    'CUME_DIST': { args: 'none', ordered: true, frame: false },
    'NTILE': { args: 'ntile', ordered: true, frame: false },
    'LAG': { args: 'offset', ordered: true, frame: false },
    'LEAD': { args: 'offset', ordered: true, frame: false },
    'FIRST_VALUE': { valueFunction: true, args: 'value', ordered: false, frame: true },
    'LAST_VALUE': { valueFunction: true, args: 'value', ordered: false, frame: true },
    'NTH_VALUE': { valueFunction: true, args: 'nth', ordered: false, frame: true },
    'SUM': { args: 'aggregate', ordered: false, frame: true },
    'AVG': { args: 'aggregate', ordered: false, frame: true },
    'MIN': { args: 'aggregate', ordered: false, frame: true },
    'MAX': { args: 'aggregate', ordered: false, frame: true },
    'COUNT': { args: 'aggregate', ordered: false, frame: true }
};

// Window frame presets (ROWS frames)
//   running – from the partition start to the current row (running totals)
//   whole   – the entire partition
//   moving  – N preceding rows plus the current row (moving averages)
export const WINDOW_FRAMES = ['', 'running', 'whole', 'moving'];

export const LOGIC_OPERATORS = ['AND', 'OR'];

// operands: how many right-hand values the operator takes
//   0 = none (IS NULL), 1 = one value, 2 = BETWEEN pair, 'list' = IN list
// noLeft: operator has no left-hand operand (EXISTS)
// subquery: whether a subquery may be used as the right-hand side
export const OPERATORS = {
    '=': { operands: 1, subquery: true },
    '!=': { operands: 1, subquery: true },
    '<>': { operands: 1, subquery: true },
    '<': { operands: 1, subquery: true },
    '<=': { operands: 1, subquery: true },
    '>': { operands: 1, subquery: true },
    '>=': { operands: 1, subquery: true },
    'LIKE': { operands: 1 },
    'NOT LIKE': { operands: 1 },
    'IN': { operands: 'list', subquery: true },
    'NOT IN': { operands: 'list', subquery: true },
    'BETWEEN': { operands: 2 },
    'NOT BETWEEN': { operands: 2 },
    'IS NULL': { operands: 0 },
    'IS NOT NULL': { operands: 0 },
    'EXISTS': { operands: 0, noLeft: true, subquery: true, subqueryOnly: true },
    'NOT EXISTS': { operands: 0, noLeft: true, subquery: true, subqueryOnly: true }
};

// How the right-hand side of a condition is interpreted:
//   value    – a literal; quoted/escaped for the dialect (John -> 'John')
//   column   – raw SQL: a column or expression, inserted as typed
//   subquery – a nested SELECT
//   param    – a parameter placeholder written in the dialect's style
//              (?, $1, @name); the value holds an optional name / number
export const VALUE_TYPES = ['value', 'column', 'subquery', 'param'];

// Value types of a SET assignment (UPDATE, and the upsert's update part).
// inserted – the value this row tried to insert (EXCLUDED.col / VALUES(col))
export const ASSIGNMENT_VALUE_TYPES = ['value', 'column', 'param'];
export const UPSERT_VALUE_TYPES = ['value', 'column', 'param', 'inserted'];

// INSERT: where the rows come from
export const INSERT_SOURCES = ['values', 'select'];

// INSERT: what to do when a row conflicts with a unique key ('' = nothing special)
//   nothing – skip the row (PostgreSQL ON CONFLICT DO NOTHING)
//   update  – update the existing row (ON CONFLICT DO UPDATE / ON DUPLICATE KEY UPDATE)
export const UPSERT_MODES = ['', 'nothing', 'update'];

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export function createGroup(logic = 'AND', items = []) {
    return { kind: 'group', logic, negate: false, items };
}

export function createCondition(overrides = {}) {
    return {
        kind: 'condition',
        left: '',
        op: '=',
        valueType: 'value',
        value: '',
        value2: '',
        subquery: null,
        ...overrides
    };
}

export function createRawCondition(sql = '') {
    return { kind: 'raw', sql };
}

export function createColumn(expr = '', overrides = {}) {
    return { kind: 'column', expr, aggregate: '', alias: '', ...overrides };
}

export function createCaseColumn() {
    return { kind: 'case', cases: [{ when: '', then: '' }], elseValue: '', alias: '' };
}

export function createWindowColumn() {
    return {
        kind: 'window',
        func: 'ROW_NUMBER',
        args: '',
        partitionBy: [],
        orderBy: [],
        frame: '',
        frameSize: '',
        alias: ''
    };
}

export function createTableSource(table = '', alias = '') {
    return { kind: 'table', table, alias };
}

export function createSubquerySource() {
    return { kind: 'subquery', query: createSelect(), alias: '' };
}

export function createJoin(type = 'INNER JOIN') {
    return {
        type,
        source: createTableSource(),
        on: createGroup('AND', [createCondition({ valueType: 'column' })])
    };
}

export function createSelect(overrides = {}) {
    return {
        kind: 'select',
        ctes: [],
        distinct: false,
        columns: [createColumn()],
        from: createTableSource(),
        joins: [],
        where: createGroup(),
        groupBy: [],
        having: createGroup(),
        orderBy: [],
        limit: '',
        offset: '',
        setOps: [],
        ...overrides
    };
}

// recursive: the query refers to itself (WITH RECURSIVE); its first part gives
// the starting rows and the parts after UNION [ALL] run on the rows just added.
// columns: an optional column list, written as name (a, b) AS (…).
export function createCte() {
    return { name: '', recursive: false, columns: '', query: createSelect() };
}

export function createSetOp(op = 'UNION') {
    return { op, query: createSelect() };
}

export function createOrderItem(expr = '') {
    return { expr, direction: 'ASC' };
}

export function createGroupByItem(expr = '') {
    return { expr };
}

export function createInsert() {
    return {
        kind: 'insert',
        table: '',
        columns: '',
        source: 'values',
        rows: [{ values: '' }],
        select: createSelect(),
        upsert: createUpsert()
    };
}

export function createUpsert() {
    return { mode: '', conflict: '', set: [] };
}

export function createUpdate() {
    return {
        kind: 'update',
        table: '',
        set: [createAssignment()],
        where: createGroup()
    };
}

export function createAssignment() {
    return { column: '', valueType: 'value', value: '' };
}

export function createDelete() {
    return { kind: 'delete', table: '', where: createGroup() };
}

// The workspace keeps one query per type so switching tabs never loses work.
export function createWorkspace(type = 'select') {
    return {
        version: BASE_MODEL_VERSION,
        type,
        select: createSelect(),
        insert: createInsert(),
        update: createUpdate(),
        delete: createDelete()
    };
}

export function createEmptyFor(type) {
    switch (type) {
        case 'select': return createSelect();
        case 'insert': return createInsert();
        case 'update': return createUpdate();
        case 'delete': return createDelete();
        default: throw new Error(`Unknown query type: ${type}`);
    }
}

// ---------------------------------------------------------------------------
// Path helpers. A path is a dot-separated string such as
// "select.where.items.0.left"; numeric segments index arrays.
// ---------------------------------------------------------------------------

export function splitPath(path) {
    return path === '' ? [] : path.split('.');
}

export function getAt(root, path) {
    let node = root;
    for (const key of splitPath(path)) {
        if (node == null) return undefined;
        node = node[key];
    }
    return node;
}

export function setAt(root, path, value) {
    const keys = splitPath(path);
    const last = keys.pop();
    const parent = keys.length ? getAt(root, keys.join('.')) : root;
    if (parent == null || last === undefined) {
        throw new Error(`Invalid path: ${path}`);
    }
    parent[last] = value;
}

export function parentPath(path) {
    const keys = splitPath(path);
    keys.pop();
    return keys.join('.');
}

export function joinPath(...parts) {
    return parts.filter(p => p !== '' && p !== undefined && p !== null).join('.');
}

// ---------------------------------------------------------------------------
// Queries over the model
// ---------------------------------------------------------------------------

export function isPristine(workspace) {
    const empty = createWorkspace(workspace.type);
    return JSON.stringify(workspace[workspace.type]) === JSON.stringify(empty[workspace.type]);
}

// Walks every SELECT in a query tree (CTEs, set operations, subqueries).
export function forEachSelect(select, visit, path = '') {
    visit(select, path);
    select.ctes.forEach((cte, i) => forEachSelect(cte.query, visit, joinPath(path, 'ctes', i, 'query')));
    if (select.from.kind === 'subquery') forEachSelect(select.from.query, visit, joinPath(path, 'from', 'query'));
    select.joins.forEach((join, i) => {
        if (join.source.kind === 'subquery') forEachSelect(join.source.query, visit, joinPath(path, 'joins', i, 'source', 'query'));
        forEachGroupSubquery(join.on, visit, joinPath(path, 'joins', i, 'on'));
    });
    forEachGroupSubquery(select.where, visit, joinPath(path, 'where'));
    forEachGroupSubquery(select.having, visit, joinPath(path, 'having'));
    select.setOps.forEach((setOp, i) => forEachSelect(setOp.query, visit, joinPath(path, 'setOps', i, 'query')));
}

function forEachGroupSubquery(group, visit, path) {
    group.items.forEach((item, i) => {
        const itemPath = joinPath(path, 'items', i);
        if (item.kind === 'group') forEachGroupSubquery(item, visit, itemPath);
        else if (item.kind === 'condition' && item.valueType === 'subquery' && item.subquery) {
            forEachSelect(item.subquery, visit, joinPath(itemPath, 'subquery'));
        }
    });
}

export function countConditions(group) {
    return group.items.reduce((n, item) => n + (item.kind === 'group' ? countConditions(item) : 1), 0);
}

// Summary used for the "query complexity" hint.
export function describeComplexity(select) {
    let selects = 0;
    let joins = 0;
    let conditions = 0;
    forEachSelect(select, (q) => {
        selects++;
        joins += q.joins.length;
        conditions += countConditions(q.where) + countConditions(q.having);
    });
    return { subqueries: selects - 1, joins, conditions };
}

/** Whether any CTE in the workspace (at any depth) is recursive. */
export function usesRecursiveCte(node) {
    if (Array.isArray(node)) return node.some(usesRecursiveCte);
    if (node === null || typeof node !== 'object') return false;
    if (Array.isArray(node.ctes) && node.ctes.some((/** @type {any} */ c) => c && c.recursive === true)) return true;
    return Object.values(node).some(usesRecursiveCte);
}

/** The model version a workspace is saved as: 2 only when it needs it. */
export function workspaceVersion(workspace) {
    return usesRecursiveCte(workspace) ? MODEL_VERSION : BASE_MODEL_VERSION;
}

/** A copy of the workspace stamped with the version it is saved as. */
export function withModelVersion(workspace) {
    return { ...workspace, version: workspaceVersion(workspace) };
}
