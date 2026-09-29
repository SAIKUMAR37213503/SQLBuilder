// Dialect-specific functions, operators and name quoting in SQL the user typed
// (expressions, custom conditions, values). The builder writes its own SQL for
// each dialect, but typed text is passed through as it is, so GETDATE() stays
// GETDATE() after switching to PostgreSQL. These entries let Checks say so.
//
// Typed text is flagged, never rewritten: a replacement can differ in subtle
// ways (time zones, NULL handling, byte vs character counts), so the person
// decides. Words inside strings, comments and quoted names are never matched,
// because the text is read with the SQL lexer.
//
// Entry fields
//   name     function or keyword (upper case), operator text, or quote character
//   kind     'call'     a function call: NAME(…), not schema.NAME(…)
//            'word'     a keyword anywhere (ILIKE)
//            'operator' an operator token (||, ::)
//            'quote'    a quoted name starting with this character (` or [)
//   in       dialects where it works as written; 'generic' means standard SQL
//   origin   who it comes from, when that isn't one of the dialects (Oracle)
//   use      the replacement to suggest, per dialect id, '*' for the others
//   differs  dialects where it exists with another meaning: { note, advice, args?, level? }
//            args: only when called with that many arguments
//   since    dialects where it needs a later version: { dialect: { version, advice? } }
//   label    how messages name it, when not NAME() or the operator itself

export const DIALECT_SYNTAX = [
    // Dates and times
    { name: 'GETDATE', kind: 'call', in: ['sqlserver'], use: { '*': 'CURRENT_TIMESTAMP' } },
    { name: 'SYSDATETIME', kind: 'call', in: ['sqlserver'], use: { '*': 'CURRENT_TIMESTAMP' } },
    { name: 'NOW', kind: 'call', in: ['postgresql', 'mysql'], use: { '*': 'CURRENT_TIMESTAMP' } },
    { name: 'CURDATE', kind: 'call', in: ['mysql'], use: { sqlserver: 'CAST(GETDATE() AS date)', '*': 'CURRENT_DATE' } },
    { name: 'DATEADD', kind: 'call', in: ['sqlserver'], use: { postgresql: "date + INTERVAL '1 day'", mysql: 'DATE_ADD(date, INTERVAL 1 DAY)', '*': "date + INTERVAL '1' DAY" } },
    { name: 'DATE_ADD', kind: 'call', in: ['mysql'], use: { sqlserver: 'DATEADD(day, 1, date)', postgresql: "date + INTERVAL '1 day'", '*': "date + INTERVAL '1' DAY" } },
    {
        name: 'DATEDIFF', kind: 'call', in: ['sqlserver', 'mysql'],
        use: { postgresql: 'end_date - start_date (the number of days between two dates)' },
        differs: {
            mysql: { args: 3, note: 'MySQL\'s DATEDIFF takes two dates and returns the days between them, with no unit argument', advice: 'Write DATEDIFF(end_date, start_date), or TIMESTAMPDIFF(unit, start, end) for other units.' },
            sqlserver: { args: 2, note: 'SQL Server\'s DATEDIFF needs the unit first', advice: 'Write DATEDIFF(day, start_date, end_date).' }
        }
    },
    { name: 'DATEPART', kind: 'call', in: ['sqlserver'], use: { '*': 'EXTRACT(YEAR FROM date)' } },
    { name: 'EXTRACT', kind: 'call', in: ['generic', 'postgresql', 'mysql'], use: { sqlserver: 'DATEPART(year, date)' } },
    { name: 'DATE_FORMAT', kind: 'call', in: ['mysql'], use: { postgresql: "TO_CHAR(date, 'YYYY-MM-DD')", sqlserver: "FORMAT(date, 'yyyy-MM-dd')" } },
    { name: 'TO_CHAR', kind: 'call', in: ['postgresql'], use: { mysql: "DATE_FORMAT(date, '%Y-%m-%d')", sqlserver: "FORMAT(date, 'yyyy-MM-dd')" } },

    // NULL handling and conditions
    {
        name: 'ISNULL', kind: 'call', in: ['sqlserver'], use: { '*': 'COALESCE(value, fallback)' },
        differs: { mysql: { args: 2, note: 'In MySQL, ISNULL(x) takes one value and returns 1 or 0', advice: 'Use COALESCE(value, fallback) instead.' } }
    },
    // MySQL's one-argument ISNULL(x) is fine there
    { name: 'IFNULL', kind: 'call', in: ['mysql'], use: { '*': 'COALESCE(value, fallback)' } },
    { name: 'NVL', kind: 'call', in: [], origin: 'Oracle', use: { '*': 'COALESCE(value, fallback)' } },
    { name: 'IIF', kind: 'call', in: ['sqlserver'], use: { '*': 'CASE WHEN condition THEN a ELSE b END' } },
    { name: 'IF', kind: 'call', in: ['mysql'], use: { '*': 'CASE WHEN condition THEN a ELSE b END' } },
    { name: 'ILIKE', kind: 'word', in: ['postgresql'], use: { '*': 'LOWER(column) LIKE LOWER(pattern)' } },

    // Text
    { name: 'LEN', kind: 'call', in: ['sqlserver'], use: { '*': 'CHAR_LENGTH(text)' } },
    { name: 'LENGTH', kind: 'call', in: ['postgresql', 'mysql'], use: { sqlserver: 'LEN(text)', '*': 'CHAR_LENGTH(text)' } },
    { name: 'DATALENGTH', kind: 'call', in: ['sqlserver'], use: { mysql: 'LENGTH(text)', '*': 'OCTET_LENGTH(text)' } },
    { name: 'CHARINDEX', kind: 'call', in: ['sqlserver'], use: { '*': 'POSITION(needle IN text)' } },
    { name: 'SUBSTR', kind: 'call', in: ['postgresql', 'mysql'], use: { sqlserver: 'SUBSTRING(text, start, length)', '*': 'SUBSTRING(text FROM start FOR length)' } },
    { name: 'GROUP_CONCAT', kind: 'call', in: ['mysql'], use: { postgresql: "STRING_AGG(text, ', ')", sqlserver: "STRING_AGG(text, ', ')", '*': "LISTAGG(text, ', ')" } },
    { name: 'STRING_AGG', kind: 'call', in: ['postgresql', 'sqlserver'], since: { sqlserver: { version: '2017' } }, use: { mysql: "GROUP_CONCAT(text SEPARATOR ', ')", '*': "LISTAGG(text, ', ')" } },
    {
        name: '||', kind: 'operator', in: ['generic', 'postgresql', 'sqlserver'], since: { sqlserver: { version: '2025', advice: 'CONCAT(a, b) works in every version.' } }, label: '|| (join text)', use: { '*': 'CONCAT(a, b)' },
        differs: { mysql: { level: 'info', note: 'In MySQL, || means OR unless the PIPES_AS_CONCAT mode is on', advice: 'Write OR for “or”, or CONCAT(a, b) to join text.' } }
    },

    // Numbers and identifiers
    { name: 'CEIL', kind: 'call', in: ['generic', 'postgresql', 'mysql'], use: { sqlserver: 'CEILING(x)' } },
    { name: 'RAND', kind: 'call', in: ['mysql', 'sqlserver'], use: { postgresql: 'RANDOM()' } },
    { name: 'RANDOM', kind: 'call', in: ['postgresql'], use: { mysql: 'RAND()', sqlserver: 'RAND()' } },
    { name: 'NEWID', kind: 'call', in: ['sqlserver'], use: { postgresql: 'gen_random_uuid()', mysql: 'UUID()' } },
    { name: 'UUID', kind: 'call', in: ['mysql'], use: { postgresql: 'gen_random_uuid()', sqlserver: 'NEWID()' } },
    { name: 'GEN_RANDOM_UUID', kind: 'call', in: ['postgresql'], since: { postgresql: { version: '13' } }, use: { mysql: 'UUID()', sqlserver: 'NEWID()' } },

    // Casts and quoted names
    { name: '::', kind: 'operator', label: ':: (cast)', in: ['postgresql'], use: { '*': 'CAST(value AS type)' } },
    { name: '`', kind: 'quote', in: ['mysql'], use: { sqlserver: '[name]', '*': '"name"' } },
    { name: '[', kind: 'quote', in: ['sqlserver'], use: { mysql: '`name`', '*': '"name"' } }
];

const BY_CALL = new Map(DIALECT_SYNTAX.filter(e => e.kind === 'call').map(e => [e.name, e]));
const BY_WORD = new Map(DIALECT_SYNTAX.filter(e => e.kind === 'word').map(e => [e.name, e]));
const BY_OPERATOR = new Map(DIALECT_SYNTAX.filter(e => e.kind === 'operator').map(e => [e.name, e]));
const BY_QUOTE = new Map(DIALECT_SYNTAX.filter(e => e.kind === 'quote').map(e => [e.name, e]));

// SQL Server's type methods (geography::Point) use :: too
const SQLSERVER_TYPES = new Set(['GEOGRAPHY', 'GEOMETRY', 'HIERARCHYID']);

const NAMES = { generic: 'Generic SQL', sqlserver: 'SQL Server', postgresql: 'PostgreSQL', mysql: 'MySQL' };

/** Number of arguments of the call whose "(" is at tokens[open]. */
function argumentCount(tokens, open) {
    let depth = 0;
    let commas = 0;
    for (let i = open; i < tokens.length; i++) {
        const t = tokens[i].text;
        if (t === '(') depth++;
        else if (t === ')' && --depth === 0) return tokens[i - 1] === tokens[open] ? 0 : commas + 1;
        else if (t === ',' && depth === 1) commas++;
    }
    return commas + 1; // unclosed; reported by the syntax check
}

/**
 * The dialect-specific syntax used in a piece of SQL text, each entry once,
 * in order of first use.
 * @param {Token[]} tokens significant tokens from the SQL lexer
 * @returns {{ entry: any, args: number }[]}
 */
export function findDialectSyntax(tokens) {
    const found = new Map();
    const note = (entry, args = -1) => {
        if (!found.has(entry.name)) found.set(entry.name, { entry, args });
    };
    tokens.forEach((t, i) => {
        const prev = tokens[i - 1];
        if (t.type === 'word') {
            const upper = t.text.toUpperCase();
            if (tokens[i + 1]?.text === '(' && prev?.text !== '.' && BY_CALL.has(upper)) note(BY_CALL.get(upper), argumentCount(tokens, i + 1));
            else if (BY_WORD.has(upper)) note(BY_WORD.get(upper));
        } else if (t.type === 'op' && BY_OPERATOR.has(t.text)) {
            if (t.text === '::' && prev && SQLSERVER_TYPES.has(prev.text.toUpperCase())) return;
            note(BY_OPERATOR.get(t.text));
        } else if (t.type === 'quoted' && BY_QUOTE.has(t.text[0])) {
            // tags[1] is an array subscript in PostgreSQL, not a quoted name
            const subscript = t.text[0] === '[' && prev && (prev.type === 'word' || prev.type === 'quoted' || prev.text === ')' || prev.text === ']');
            if (!subscript) note(BY_QUOTE.get(t.text[0]));
        }
    });
    return [...found.values()];
}

/** How an entry is named in a message: GETDATE(), ILIKE, ||, `name` quoting */
function labelOf(entry) {
    if (entry.label) return entry.label;
    if (entry.kind === 'call') return `${entry.name}()`;
    if (entry.kind === 'quote') return entry.name === '[' ? '[name] quoting' : '`name` quoting';
    return entry.name;
}

/** "SQL Server", "PostgreSQL and MySQL", "standard SQL", "Oracle" */
function originOf(entry) {
    if (entry.origin) return entry.origin;
    if (entry.in.includes('generic')) return 'standard SQL';
    const names = entry.in.map(id => NAMES[id]);
    return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
}

/**
 * Checks for dialect-specific syntax in typed SQL text.
 * @param {Token[]} tokens significant tokens of the text
 * @param {{ id: string, shortLabel: string }} dialect
 * @returns {{ level: 'warning' | 'info', message: string }[]}
 */
export function dialectSyntaxIssues(tokens, dialect) {
    const issues = [];
    for (const { entry, args } of findDialectSyntax(tokens)) {
        const label = labelOf(entry);
        const use = entry.use?.[dialect.id] ?? entry.use?.['*'];
        const differs = entry.differs?.[dialect.id];
        if (differs && (differs.args === undefined || differs.args === args)) {
            issues.push({ level: differs.level || 'warning', message: `${differs.note}. ${differs.advice}` });
        } else if (entry.in.includes(dialect.id)) {
            const since = entry.since?.[dialect.id];
            if (since) issues.push({ level: 'info', message: `${label} needs ${dialect.shortLabel} ${since.version} or later.${since.advice ? ` ${since.advice}` : ''}` });
        } else if (differs) {
            // Exists in this dialect, used here the way it means there
        } else if (dialect.id === 'generic') {
            issues.push({ level: 'info', message: `${label} is ${originOf(entry)} syntax, not standard SQL.${use ? ` ${use} works in more databases.` : ''}` });
        } else {
            issues.push({ level: 'warning', message: `${label} isn't available in ${dialect.shortLabel}; it's ${originOf(entry)} syntax.${use ? ` Use ${use} instead.` : ''}` });
        }
    }
    return issues;
}

/** @typedef {import('./sql-lexer.js').Token} Token */
