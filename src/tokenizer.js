// Tokenizer for syntax highlighting. Returns plain token objects; rendering
// is done by the UI with DOM text nodes, so no HTML is ever built from SQL.

const KEYWORDS = [
    'ORDER\\s+BY', 'GROUP\\s+BY', 'PARTITION\\s+BY', 'INSERT\\s+INTO', 'DELETE\\s+FROM',
    '(?:UNION|INTERSECT|EXCEPT)(?:\\s+ALL)?', 'CURRENT\\s+ROW', 'UNBOUNDED', 'PRECEDING', 'FOLLOWING', 'OVER',
    '(?:INNER|LEFT|RIGHT|FULL|CROSS)\\s+JOIN', 'IS\\s+NOT\\s+NULL', 'IS\\s+NULL',
    'NOT\\s+IN', 'NOT\\s+LIKE', 'NOT\\s+BETWEEN', 'NOT\\s+EXISTS',
    'SELECT', 'DISTINCT', 'TOP', 'FROM', 'WHERE', 'HAVING', 'LIMIT', 'OFFSET', 'FETCH', 'NEXT',
    'ROWS', 'ONLY', 'VALUES', 'UPDATE', 'SET', 'WITH', 'AS', 'ON', 'JOIN', 'AND', 'OR',
    'NOT', 'IN', 'LIKE', 'BETWEEN', 'EXISTS', 'IS', 'NULL', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
    'ASC', 'DESC', 'TRUE', 'FALSE'
];

const TOKEN_RE = new RegExp([
    "(?<string>[Nn]?'(?:[^']|'')*'?)",
    '(?<identifier>"(?:[^"]|"")*"|`[^`]*`|\\[[^\\]]*\\])',
    '(?<comment>--[^\\n]*)',
    `(?<keyword>\\b(?:${KEYWORDS.join('|')})\\b)`,
    '(?<func>\\b[A-Za-z_][A-Za-z0-9_]*(?=\\s*\\())',
    '(?<number>\\b\\d+(?:\\.\\d+)?\\b)',
    '(?<operator><>|!=|>=|<=|=|<|>|\\+|-|\\*|/|%)',
    '(?<punct>[(),.;])'
].join('|'), 'gi');

/**
 * @param {string} sql
 * @returns {{ type: string, text: string }[]}
 */
export function tokenize(sql) {
    const tokens = [];
    let last = 0;
    for (const match of sql.matchAll(TOKEN_RE)) {
        if (match.index > last) tokens.push({ type: 'text', text: sql.slice(last, match.index) });
        const type = Object.keys(match.groups).find(key => match.groups[key] !== undefined);
        tokens.push({ type, text: match[0] });
        last = match.index + match[0].length;
    }
    if (last < sql.length) tokens.push({ type: 'text', text: sql.slice(last) });
    return tokens;
}
