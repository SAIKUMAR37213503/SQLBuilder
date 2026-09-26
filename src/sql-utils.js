// Small, dependency-free helpers for working with fragments of SQL text.
// This is deliberately NOT a SQL parser: it only understands quotes and
// parentheses well enough to split lists and spot obvious mistakes.

// One identifier part: bare (letters, digits, _, $) or quoted "x", `x`, [x]
const IDENT_PART = String.raw`(?:[\p{L}_][\p{L}\p{N}_$]*|"(?:[^"]|"")+"|\x60[^\x60]+\x60|\[[^\]]+\])`;

const IDENTIFIER_RE = new RegExp(`^${IDENT_PART}$`, 'u');
// schema.table or db.schema.table
const QUALIFIED_NAME_RE = new RegExp(`^${IDENT_PART}(?:\\.${IDENT_PART}){0,2}$`, 'u');
// A column reference: table.column, column, table.*, *
const COLUMN_REF_RE = new RegExp(`^(?:${IDENT_PART}\\.){0,2}(?:${IDENT_PART}|\\*)$`, 'u');
const BARE_IDENT_RE = /^[\p{L}_][\p{L}\p{N}_$]*$/u;

export function isIdentifier(text) {
    return IDENTIFIER_RE.test(text);
}

export function isQualifiedName(text) {
    return QUALIFIED_NAME_RE.test(text);
}

export function isColumnReference(text) {
    return COLUMN_REF_RE.test(text);
}

export function isBareIdentifier(text) {
    return BARE_IDENT_RE.test(text);
}

// Splits on a separator character that is not inside quotes or parentheses.
//   splitTopLevel("a, CONCAT(b, c), 'x,y'") -> ["a", "CONCAT(b, c)", "'x,y'"]
export function splitTopLevel(text, separator = ',') {
    const parts = [];
    let depth = 0;
    let quote = null;
    let current = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            current += ch;
            if (ch === quote) {
                // doubled quote ('' or "") is an escaped quote, not the end
                if (text[i + 1] === quote) {
                    current += text[++i];
                } else {
                    quote = null;
                }
            }
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
            quote = ch;
        } else if (ch === '(') {
            depth++;
        } else if (ch === ')') {
            depth = Math.max(0, depth - 1);
        } else if (ch === separator && depth === 0) {
            parts.push(current.trim());
            current = '';
            continue;
        }
        current += ch;
    }
    parts.push(current.trim());
    return parts;
}

// Returns null when quotes and parentheses are balanced, otherwise a
// human-readable description of the problem.
export function findSyntaxProblem(text) {
    let depth = 0;
    let quote = null;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === quote) {
                if (text[i + 1] === quote) i++;
                else quote = null;
            }
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') quote = ch;
        else if (ch === '(') depth++;
        else if (ch === ')') {
            depth--;
            if (depth < 0) return 'has a closing ")" without a matching "("';
        } else if (ch === ';') {
            return 'contains ";" — statements can\'t be chained here';
        } else if (ch === '-' && text[i + 1] === '-') {
            return 'contains "--", which would comment out the rest of the line';
        }
    }
    if (quote === "'") return 'has a text value that is missing its closing \' quote';
    if (quote) return `has an identifier that is missing its closing ${quote} quote`;
    if (depth > 0) return 'has an opening "(" without a matching ")"';
    return null;
}

const AGGREGATE_CALL_RE = /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i;

export function containsAggregateCall(expr) {
    return AGGREGATE_CALL_RE.test(stripStrings(expr));
}

// Replaces the contents of string literals so keyword checks ignore them.
export function stripStrings(text) {
    return text.replace(/'(?:[^']|'')*'/g, "''");
}

// Normalises an expression for equality comparison (case/whitespace-insensitive
// outside string literals).
export function normalizeExpr(expr) {
    let out = '';
    let last = 0;
    for (const m of expr.matchAll(/'(?:[^']|'')*'/g)) {
        out += expr.slice(last, m.index).toLowerCase().replace(/\s+/g, '');
        out += m[0];
        last = m.index + m[0].length;
    }
    return out + expr.slice(last).toLowerCase().replace(/\s+/g, '');
}

// Counts top-level output columns of a raw column list. Returns -1 when a
// wildcard makes the number unknowable.
export function countColumns(columnString) {
    if (!columnString || !columnString.trim()) return 0;
    const cols = splitTopLevel(columnString).filter(c => c.length > 0);
    if (cols.some(c => c === '*' || c.endsWith('.*'))) return -1;
    return cols.length;
}

const NUMBER_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const QUOTED_STRING_RE = /^'(?:[^']|'')*'$/;

export function isNumberLiteral(text) {
    return NUMBER_RE.test(text);
}

export function isQuotedString(text) {
    return QUOTED_STRING_RE.test(text);
}
