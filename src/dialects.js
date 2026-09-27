// SQL dialect definitions. Each dialect only describes the differences the
// generator actually handles; anything not listed here is emitted the same way
// for every dialect. Add a dialect by adding an entry to DIALECTS.
//
// Capability flags read by validation:
//   subqueryOrderByNeedsLimit  ORDER BY inside a subquery / CTE is rejected
//                              unless TOP or OFFSET is also used
//   limitInInSubquery          LIMIT is allowed inside an IN (subquery)
//   havingAcceptsAlias         HAVING may refer to a SELECT alias
//   upsert                     'on-conflict' (PostgreSQL), 'on-duplicate-key'
//                              (MySQL) or null (not supported here)
//
// parameter(name, position): the placeholder for a query parameter. `name` is
// what the user typed (may be empty), `position` its 1-based order in the
// statement. insertedValue(column): the value a conflicting INSERT row tried
// to write, for the upsert's update part.

const escapeSingleQuotes = (text) => text.replace(/'/g, "''");

const NAMED_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const ALL_SET_OPERATORS = ['UNION', 'UNION ALL', 'INTERSECT', 'INTERSECT ALL', 'EXCEPT', 'EXCEPT ALL'];

// Standard pagination: LIMIT n OFFSET m (PostgreSQL, SQLite, generic)
function limitOffsetPagination({ limit, offset }) {
    const clauses = [];
    if (limit !== '') clauses.push(`LIMIT ${limit}`);
    if (offset !== '') clauses.push(`OFFSET ${offset}`);
    return { clauses };
}

export const DIALECTS = {
    generic: {
        id: 'generic',
        label: 'Generic SQL',
        quoteIdentifier: (name) => `"${name.replace(/"/g, '""')}"`,
        quoteString: (text) => `'${escapeSingleQuotes(text)}'`,
        booleanLiteral: (value) => (value ? 'TRUE' : 'FALSE'),
        supportsFullJoin: true,
        setOperators: ALL_SET_OPERATORS,
        supportsNthValue: true,
        paginate: limitOffsetPagination,
        subqueryOrderByNeedsLimit: false,
        limitInInSubquery: true,
        havingAcceptsAlias: false,
        upsert: null,
        parameter: (name) => (NAMED_RE.test(name) ? `:${name}` : '?'),
        insertedValue: null,
        notes: ['Parameters are written as ? (or :name when named).', 'Upserts need a specific dialect (PostgreSQL or MySQL).']
    },
    postgresql: {
        id: 'postgresql',
        label: 'PostgreSQL',
        quoteIdentifier: (name) => `"${name.replace(/"/g, '""')}"`,
        quoteString: (text) => `'${escapeSingleQuotes(text)}'`,
        booleanLiteral: (value) => (value ? 'TRUE' : 'FALSE'),
        supportsFullJoin: true,
        setOperators: ALL_SET_OPERATORS,
        supportsNthValue: true,
        paginate: limitOffsetPagination,
        subqueryOrderByNeedsLimit: false,
        limitInInSubquery: true,
        havingAcceptsAlias: false,
        upsert: 'on-conflict',
        // $n; a number typed by the user is kept, otherwise numbered by position
        parameter: (name, position) => `$${/^\d+$/.test(name) ? Number(name) : position}`,
        insertedValue: (column) => `EXCLUDED.${column}`,
        notes: ['Parameters are numbered: $1, $2, … in order.', 'Upsert: ON CONFLICT … DO NOTHING / DO UPDATE.']
    },
    mysql: {
        id: 'mysql',
        label: 'MySQL',
        quoteIdentifier: (name) => `\`${name.replace(/`/g, '``')}\``,
        // Backslash is an escape character in MySQL string literals by default
        quoteString: (text) => `'${escapeSingleQuotes(text.replace(/\\/g, '\\\\'))}'`,
        booleanLiteral: (value) => (value ? 'TRUE' : 'FALSE'),
        supportsFullJoin: false,
        setOperators: ALL_SET_OPERATORS,
        // INTERSECT / EXCEPT exist since MySQL 8.0.31
        setOperatorMinVersion: { INTERSECT: '8.0.31', EXCEPT: '8.0.31' },
        supportsNthValue: true,
        paginate({ limit, offset }) {
            if (limit === '' && offset !== '') {
                // MySQL requires LIMIT before OFFSET; this is the documented idiom
                return { clauses: [`LIMIT 18446744073709551615 OFFSET ${offset}`] };
            }
            return limitOffsetPagination({ limit, offset });
        },
        subqueryOrderByNeedsLimit: false,
        limitInInSubquery: false,
        havingAcceptsAlias: true,
        upsert: 'on-duplicate-key',
        parameter: () => '?',
        insertedValue: (column) => `VALUES(${column})`,
        notes: ['FULL JOIN is not supported by MySQL.', 'Window functions need MySQL 8.0+; INTERSECT / EXCEPT need 8.0.31+.', 'Parameters are written as ?.', 'Upsert: ON DUPLICATE KEY UPDATE.']
    },
    sqlserver: {
        id: 'sqlserver',
        label: 'SQL Server',
        quoteIdentifier: (name) => `[${name.replace(/]/g, ']]')}]`,
        quoteString: (text) => `'${escapeSingleQuotes(text)}'`,
        booleanLiteral: (value) => (value ? '1' : '0'),
        supportsFullJoin: true,
        setOperators: ['UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT'],
        supportsNthValue: false,
        // TOP for a simple limit; OFFSET … FETCH (which needs ORDER BY) otherwise
        paginate({ limit, offset, hasOrderBy, hasSetOps }) {
            if (limit === '' && offset === '') return { clauses: [] };
            if (offset === '' && !hasSetOps) return { top: limit, clauses: [] };
            const clauses = [`OFFSET ${offset === '' ? '0' : offset} ROWS`];
            if (limit !== '') clauses.push(`FETCH NEXT ${limit} ROWS ONLY`);
            return { clauses, needsOrderBy: !hasOrderBy };
        },
        subqueryOrderByNeedsLimit: true,
        limitInInSubquery: true,
        havingAcceptsAlias: false,
        upsert: null,
        parameter: (name, position) => (NAMED_RE.test(name) ? `@${name}` : `@p${position}`),
        insertedValue: null,
        notes: ['Booleans are written as 1/0.', 'LIMIT becomes TOP, or OFFSET … FETCH when an offset or set operation is used.', 'No INTERSECT ALL / EXCEPT ALL or NTH_VALUE.', 'Parameters are written as @name (or @p1, @p2, … when unnamed).', 'Upserts (MERGE) are not supported yet.']
    }
};

export const DEFAULT_DIALECT = 'generic';

export function getDialect(id) {
    return DIALECTS[id] || DIALECTS[DEFAULT_DIALECT];
}

export function listDialects() {
    return Object.values(DIALECTS).map(({ id, label }) => ({ id, label }));
}
