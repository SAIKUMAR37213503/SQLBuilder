// SQL dialect definitions. Each dialect only describes the differences the
// generator actually handles; anything not listed here is emitted the same way
// for every dialect. Add a dialect by adding an entry to DIALECTS.

const escapeSingleQuotes = (text) => text.replace(/'/g, "''");

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
        paginate: limitOffsetPagination,
        notes: []
    },
    postgresql: {
        id: 'postgresql',
        label: 'PostgreSQL',
        quoteIdentifier: (name) => `"${name.replace(/"/g, '""')}"`,
        quoteString: (text) => `'${escapeSingleQuotes(text)}'`,
        booleanLiteral: (value) => (value ? 'TRUE' : 'FALSE'),
        supportsFullJoin: true,
        paginate: limitOffsetPagination,
        notes: []
    },
    mysql: {
        id: 'mysql',
        label: 'MySQL',
        quoteIdentifier: (name) => `\`${name.replace(/`/g, '``')}\``,
        // Backslash is an escape character in MySQL string literals by default
        quoteString: (text) => `'${escapeSingleQuotes(text.replace(/\\/g, '\\\\'))}'`,
        booleanLiteral: (value) => (value ? 'TRUE' : 'FALSE'),
        supportsFullJoin: false,
        paginate({ limit, offset }) {
            if (limit === '' && offset !== '') {
                // MySQL requires LIMIT before OFFSET; this is the documented idiom
                return { clauses: [`LIMIT 18446744073709551615 OFFSET ${offset}`] };
            }
            return limitOffsetPagination({ limit, offset });
        },
        notes: ['FULL JOIN is not supported by MySQL.']
    },
    sqlserver: {
        id: 'sqlserver',
        label: 'SQL Server',
        quoteIdentifier: (name) => `[${name.replace(/]/g, ']]')}]`,
        quoteString: (text) => `'${escapeSingleQuotes(text)}'`,
        booleanLiteral: (value) => (value ? '1' : '0'),
        supportsFullJoin: true,
        // TOP for a simple limit; OFFSET … FETCH (which needs ORDER BY) otherwise
        paginate({ limit, offset, hasOrderBy, hasSetOps }) {
            if (limit === '' && offset === '') return { clauses: [] };
            if (offset === '' && !hasSetOps) return { top: limit, clauses: [] };
            const clauses = [`OFFSET ${offset === '' ? '0' : offset} ROWS`];
            if (limit !== '') clauses.push(`FETCH NEXT ${limit} ROWS ONLY`);
            return { clauses, needsOrderBy: !hasOrderBy };
        },
        notes: ['Booleans are written as 1/0.', 'LIMIT becomes TOP, or OFFSET … FETCH when an offset or UNION is used.']
    }
};

export const DEFAULT_DIALECT = 'generic';

export function getDialect(id) {
    return DIALECTS[id] || DIALECTS[DEFAULT_DIALECT];
}

export function listDialects() {
    return Object.values(DIALECTS).map(({ id, label }) => ({ id, label }));
}
