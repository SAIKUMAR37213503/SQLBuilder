// SQL dialect definitions: the only place that knows how the supported
// databases differ. The query model, generator and validator are shared; they
// ask the selected dialect how to write something (functions below) and what
// it allows (the `supports` / `restrictions` capability flags), and never test
// a dialect's id. Anything not described here is written the same way for
// every dialect.
//
// Adding a dialect: add an entry built with defineDialect(), then add its
// column to the golden SQL and validation matrices in tests/.
//
// Writing SQL
//   quoteIdentifier(name)    one identifier part, quoted
//   quoteString(text)        a text literal
//   booleanLiteral(value)    how a true/false value is written
//   paginate({ limit, offset, hasOrderBy, hasSetOps })
//                            → { top?, clauses, needsOrderBy? }: a TOP n for the
//                              SELECT line, clauses after ORDER BY, and whether
//                              ORDER BY (SELECT NULL) has to be added
//   parameter(name, position) placeholder for a query parameter; `name` is what
//                              the user typed (may be empty), `position` its
//                              1-based order in the statement
//   insertedValue(column)    the value a conflicting INSERT row tried to write
//                            (upsert update part), or null
//
// supports                   what the dialect can express
//   booleanKeywords          TRUE / FALSE are valid in hand-written SQL
//   fullJoin                 FULL [OUTER] JOIN
//   setOperators             the UNION / INTERSECT / EXCEPT variants allowed
//   cte, recursiveCte        WITH, WITH RECURSIVE (recursive: not built yet)
//   windowFunctions, nthValue
//   top, limitOffset, offsetFetch
//                            the pagination syntax paginate() writes
//   limitInInSubquery        LIMIT inside an IN (subquery)
//   havingAlias              HAVING may refer to a SELECT alias
//   upsert                   'on-conflict', 'on-duplicate-key' or null
//   returning, output        RETURNING / OUTPUT clauses (not built yet)
//
// restrictions               what the dialect insists on
//   subqueryOrderByNeedsLimit      ORDER BY in a subquery / CTE needs TOP or OFFSET
//   rankingNeedsOrderBy            ranking / LAG / LEAD / NTILE without ORDER BY
//                                  inside OVER is an error (otherwise a warning)
//   valueFunctionsNeedOrderBy      FIRST_VALUE / LAST_VALUE need ORDER BY in OVER
//   frameNeedsOrderBy              a ROWS frame without ORDER BY is an error
//                                  (otherwise a warning)
//
// parameters.names           what happens to a parameter's name:
//   'kept'     written into the SQL (:name, @name); must not be a number
//   'numbered' a number picks the position ($2); other names are dropped
//   'ignored'  placeholders are anonymous (?); names are dropped
// parameters.ignoredNote     the tip shown once when names are dropped
//
// minVersions                features that need a later release, shown as tips
//
// ui                         wording for dialect-specific builder fields
//   limitLabel, limitHint    the row-limit field (LIMIT, or TOP on SQL Server)

const escapeSingleQuotes = (text) => text.replace(/'/g, "''");

const NAMED_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const ALL_SET_OPERATORS = ['UNION', 'UNION ALL', 'INTERSECT', 'INTERSECT ALL', 'EXCEPT', 'EXCEPT ALL'];

const DEFAULT_SUPPORTS = {
    booleanKeywords: true,
    fullJoin: true,
    setOperators: ALL_SET_OPERATORS,
    cte: true,
    recursiveCte: false,
    windowFunctions: true,
    nthValue: true,
    top: false,
    limitOffset: true,
    offsetFetch: false,
    limitInInSubquery: true,
    havingAlias: false,
    upsert: null,
    returning: false,
    output: false
};

const DEFAULT_RESTRICTIONS = {
    subqueryOrderByNeedsLimit: false,
    rankingNeedsOrderBy: false,
    valueFunctionsNeedOrderBy: false,
    frameNeedsOrderBy: false
};

// Standard pagination: LIMIT n OFFSET m (PostgreSQL, SQLite, generic)
function limitOffsetPagination({ limit, offset }) {
    const clauses = [];
    if (limit !== '') clauses.push(`LIMIT ${limit}`);
    if (offset !== '') clauses.push(`OFFSET ${offset}`);
    return { clauses };
}

function defineDialect(spec) {
    return Object.freeze({
        ...spec,
        shortLabel: spec.shortLabel || spec.label,
        supports: Object.freeze({ ...DEFAULT_SUPPORTS, ...spec.supports }),
        restrictions: Object.freeze({ ...DEFAULT_RESTRICTIONS, ...spec.restrictions }),
        parameters: Object.freeze({ names: 'kept', ignoredNote: '', ...spec.parameters }),
        minVersions: Object.freeze({ ...spec.minVersions }),
        ui: Object.freeze({ limitLabel: 'LIMIT', limitHint: '', ...spec.ui }),
        notes: Object.freeze([...(spec.notes || [])])
    });
}

export const DIALECTS = {
    generic: defineDialect({
        id: 'generic',
        label: 'Generic SQL',
        quoteIdentifier: (name) => `"${name.replace(/"/g, '""')}"`,
        quoteString: (text) => `'${escapeSingleQuotes(text)}'`,
        booleanLiteral: (value) => (value ? 'TRUE' : 'FALSE'),
        paginate: limitOffsetPagination,
        parameter: (name) => (NAMED_RE.test(name) ? `:${name}` : '?'),
        insertedValue: null,
        notes: ['Parameters are written as ? (or :name when named).', 'Upserts need a specific dialect (PostgreSQL or MySQL).']
    }),
    sqlserver: defineDialect({
        id: 'sqlserver',
        label: 'Microsoft SQL Server',
        shortLabel: 'SQL Server',
        quoteIdentifier: (name) => `[${name.replace(/]/g, ']]')}]`,
        quoteString: (text) => `'${escapeSingleQuotes(text)}'`,
        booleanLiteral: (value) => (value ? '1' : '0'),
        // TOP for a simple limit; OFFSET … FETCH (which needs ORDER BY) otherwise
        paginate({ limit, offset, hasOrderBy, hasSetOps }) {
            if (limit === '' && offset === '') return { clauses: [] };
            if (offset === '' && !hasSetOps) return { top: limit, clauses: [] };
            const clauses = [`OFFSET ${offset === '' ? '0' : offset} ROWS`];
            if (limit !== '') clauses.push(`FETCH NEXT ${limit} ROWS ONLY`);
            return { clauses, needsOrderBy: !hasOrderBy };
        },
        parameter: (name, position) => (NAMED_RE.test(name) ? `@${name}` : `@p${position}`),
        insertedValue: null,
        supports: {
            booleanKeywords: false,
            setOperators: ['UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT'],
            nthValue: false,
            top: true,
            limitOffset: false,
            offsetFetch: true
        },
        ui: {
            limitLabel: 'TOP',
            limitHint: 'Written as TOP n, or as OFFSET … FETCH NEXT n ROWS ONLY when there is an OFFSET or a UNION.'
        },
        restrictions: {
            subqueryOrderByNeedsLimit: true,
            rankingNeedsOrderBy: true,
            valueFunctionsNeedOrderBy: true,
            frameNeedsOrderBy: true
        },
        notes: ['Booleans are written as 1/0.', 'LIMIT becomes TOP, or OFFSET … FETCH when an offset or set operation is used.', 'No INTERSECT ALL / EXCEPT ALL or NTH_VALUE.', 'Parameters are written as @name (or @p1, @p2, … when unnamed).', 'Upserts (MERGE) are not supported yet.']
    }),
    postgresql: defineDialect({
        id: 'postgresql',
        label: 'PostgreSQL',
        quoteIdentifier: (name) => `"${name.replace(/"/g, '""')}"`,
        quoteString: (text) => `'${escapeSingleQuotes(text)}'`,
        booleanLiteral: (value) => (value ? 'TRUE' : 'FALSE'),
        paginate: limitOffsetPagination,
        // $n; a number typed by the user is kept, otherwise numbered by position
        parameter: (name, position) => `$${/^\d+$/.test(name) ? Number(name) : position}`,
        insertedValue: (column) => `EXCLUDED.${column}`,
        supports: { upsert: 'on-conflict' },
        parameters: {
            names: 'numbered',
            ignoredNote: 'PostgreSQL parameters are numbered ($1, $2, … in order), so parameter names aren\'t part of the SQL. Enter a number instead of a name to choose the position.'
        },
        notes: ['Parameters are numbered: $1, $2, … in order.', 'Upsert: ON CONFLICT … DO NOTHING / DO UPDATE.']
    }),
    mysql: defineDialect({
        id: 'mysql',
        label: 'MySQL',
        quoteIdentifier: (name) => `\`${name.replace(/`/g, '``')}\``,
        // Backslash is an escape character in MySQL string literals by default
        quoteString: (text) => `'${escapeSingleQuotes(text.replace(/\\/g, '\\\\'))}'`,
        booleanLiteral: (value) => (value ? 'TRUE' : 'FALSE'),
        paginate({ limit, offset }) {
            if (limit === '' && offset !== '') {
                // MySQL requires LIMIT before OFFSET; this is the documented idiom
                return { clauses: [`LIMIT 18446744073709551615 OFFSET ${offset}`] };
            }
            return limitOffsetPagination({ limit, offset });
        },
        parameter: () => '?',
        insertedValue: (column) => `VALUES(${column})`,
        supports: { fullJoin: false, limitInInSubquery: false, havingAlias: true, upsert: 'on-duplicate-key' },
        parameters: {
            names: 'ignored',
            ignoredNote: 'MySQL parameters are written as ?, so parameter names aren\'t part of the SQL. Bind the values in the order the ? appear.'
        },
        // INTERSECT / EXCEPT exist since MySQL 8.0.31
        minVersions: { INTERSECT: '8.0.31', EXCEPT: '8.0.31' },
        notes: ['FULL JOIN is not supported by MySQL.', 'Window functions need MySQL 8.0+; INTERSECT / EXCEPT need 8.0.31+.', 'Parameters are written as ?.', 'Upsert: ON DUPLICATE KEY UPDATE.']
    })
};

export const DEFAULT_DIALECT = 'generic';

export function getDialect(id) {
    return (typeof id === 'string' && Object.hasOwn(DIALECTS, id) ? DIALECTS[id] : null) || DIALECTS[DEFAULT_DIALECT];
}

export function listDialects() {
    return Object.values(DIALECTS).map(({ id, label }) => ({ id, label }));
}
