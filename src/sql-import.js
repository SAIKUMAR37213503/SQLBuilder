// SQL import: reads a SELECT statement into the query model, so SQL written
// elsewhere can be edited in the builder. It is a small recursive-descent
// reader over the lexer's tokens that understands what the builder can hold;
// anything else is refused with its line and column, never guessed at.
//
// Expressions (columns, the sides of a condition, GROUP BY and ORDER BY
// items) are kept word for word, the way a person would type them into the
// builder's fields. Comments are left out. Nothing here runs SQL or sends it
// anywhere: the text is only read.

import { lex, significant, isWord } from './sql-lexer.js';
import {
    createSelect, createColumn, createCaseColumn, createWindowColumn, createCondition, createRawCondition, createGroup,
    createJoin, createTableSource, createSubquerySource, createCte, createSetOp, createOrderItem, createGroupByItem,
    WINDOW_FUNCTIONS
} from './model.js';
import { getDialect, DEFAULT_DIALECT, listDialects } from './dialects.js';
import { formatLiteral, generateQuery } from './generator.js';
import { splitTopLevel } from './sql-utils.js';
import { MAX_NESTING_DEPTH } from './validation.js';
import { compareSql } from './roundtrip.js';

/** @typedef {import('./sql-lexer.js').Token} Token */

export const MAX_SQL_IMPORT_CHARS = 1024 * 1024;
// Parentheses around conditions, e.g. ((a = 1 OR b = 2) AND c = 3)
const MAX_CONDITION_DEPTH = 64;

const COMPARISONS = new Set(['=', '<>', '!=', '<', '<=', '>', '>=']);
const AGGREGATE_FUNCTIONS = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'];

// Words that end a table or column and so can't be taken as its alias
const NOT_AN_ALIAS = new Set([
    'ON', 'USING', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'OFFSET', 'FETCH', 'UNION', 'INTERSECT', 'EXCEPT', 'MINUS',
    'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL', 'OUTER', 'APPLY', 'STRAIGHT_JOIN', 'WINDOW', 'QUALIFY',
    'FOR', 'OPTION', 'WITH', 'TABLESAMPLE', 'LATERAL', 'USE', 'FORCE', 'IGNORE', 'PARTITION', 'INTO', 'FROM', 'SELECT',
    'AS', 'AND', 'OR', 'NOT', 'IS', 'IN', 'LIKE', 'BETWEEN', 'NULL', 'TRUE', 'FALSE', 'CASE', 'WHEN', 'THEN', 'ELSE',
    'END', 'ASC', 'DESC', 'BY', 'ALL', 'DISTINCT', 'RETURNING', 'VALUES', 'SET',
    // Time units and other words that end an expression (INTERVAL 1 DAY, AT TIME ZONE …)
    'DAY', 'DAYS', 'HOUR', 'HOURS', 'MINUTE', 'MINUTES', 'SECOND', 'SECONDS', 'MONTH', 'MONTHS', 'YEAR', 'YEARS',
    'WEEK', 'WEEKS', 'QUARTER', 'MICROSECOND', 'ZONE', 'TIME', 'TIMESTAMP', 'DATE', 'INTERVAL', 'PRECEDING',
    'FOLLOWING', 'ROW', 'ROWS', 'ONLY', 'FIRST', 'LAST', 'NEXT', 'NULLS'
]);
// Words after which the next word is still part of the expression (a DIV b, x COLLATE nocase)
const JOINING_WORDS = new Set([
    'DIV', 'MOD', 'AND', 'OR', 'NOT', 'IS', 'IN', 'LIKE', 'COLLATE', 'INTERVAL', 'AT', 'ZONE', 'TIME', 'BETWEEN',
    'THEN', 'ELSE', 'WHEN', 'CASE', 'DISTINCT', 'ALL', 'SELECT', 'BY', 'ESCAPE', 'OVER', 'AS', 'TIMESTAMP', 'DATE', 'CAST'
]);
// Condition words the builder has no operator for: such conditions are kept as custom SQL
const OTHER_PREDICATES = new Set(['ILIKE', 'SIMILAR', 'REGEXP', 'RLIKE', 'GLOB', 'MATCH', 'OVERLAPS', 'ESCAPE']);

/** A part of the SQL the builder can't hold, with where it is. */
class Refusal extends Error {
    /** @param {string} message @param {Token | undefined} token */
    constructor(message, token) {
        super(message);
        this.line = token ? token.line : 0;
        this.col = token ? token.col : 0;
    }
}

/**
 * @typedef {{ ok: true, query: any, notes: string[] }} ImportSuccess
 * @typedef {{ ok: false, message: string, line: number, col: number }} ImportFailure
 */

/**
 * Reads one SELECT statement into a query model.
 * @param {string} text
 * @param {{ dialect?: string }} [options] the dialect the SQL is written for
 * @returns {ImportSuccess | ImportFailure}
 */
export function importSql(text, { dialect = DEFAULT_DIALECT } = {}) {
    try {
        return { ok: true, ...read(String(text ?? ''), getDialect(dialect)) };
    } catch (error) {
        if (!(error instanceof Refusal)) throw error;
        return { ok: false, message: error.message, line: error.line, col: error.col };
    }
}

/**
 * Imports SQL and checks it: the query, the SQL the builder writes for it, and
 * how that compares with the imported text.
 * @param {string} text
 * @param {{ dialect?: string, quoteIdentifiers?: boolean, pretty?: boolean }} [options]
 */
export function previewSqlImport(text, { dialect = DEFAULT_DIALECT, quoteIdentifiers = false, pretty = true } = {}) {
    const result = importSql(text, { dialect });
    if (!result.ok) return result;
    const plain = generateQuery(result.query, { dialect, pretty });
    // The check compares names as typed; quoting them is a setting, not a change
    const check = compareSql(text, plain, getDialect(dialect).syntax);
    const sql = quoteIdentifiers ? generateQuery(result.query, { dialect, pretty, quoteIdentifiers }) : plain;
    return { ...result, sql, check };
}

/**
 * Guesses the dialect SQL was written for from syntax only one dialect uses.
 * @param {string} text
 * @returns {{ dialect: string, reason: string } | null} null when nothing points to one dialect
 */
export function guessDialect(text) {
    const tokens = significant(lex(String(text ?? '').slice(0, MAX_SQL_IMPORT_CHARS)));
    /** @type {Record<string, string[]>} */
    const signs = {};
    const sign = (/** @type {string} */ dialect, /** @type {string} */ why) => {
        const list = (signs[dialect] ||= []);
        if (!list.includes(why)) list.push(why);
    };
    tokens.forEach((t, i) => {
        const prev = tokens[i - 1];
        if (t.type === 'quoted' && t.text[0] === '`') sign('mysql', 'backquoted names');
        else if (t.type === 'quoted' && t.text[0] === '[' && !(prev && prev.end === t.start && (prev.type === 'word' || prev.type === 'quoted' || prev.text === ')'))) sign('sqlserver', 'names in [brackets]');
        else if (t.type === 'param' && t.text[0] === '$') sign('postgresql', '$1 parameters');
        else if (t.type === 'param' && t.text[0] === ':') sign('generic', ':name parameters');
        else if (t.type === 'op' && t.text === '::') sign('postgresql', ':: casts');
        else if (t.type === 'string' && t.text[0] === '$') sign('postgresql', '$$ strings');
        else if (t.type === 'word' && /^@[A-Za-z_]/.test(t.text)) sign('sqlserver', '@parameters');
        else if (isWord(t, 'TOP') && isWord(prev, 'SELECT', 'DISTINCT')) sign('sqlserver', 'TOP');
        else if (isWord(t, 'ILIKE')) sign('postgresql', 'ILIKE');
        else if (isWord(t, 'FETCH') && isWord(prev, 'ROWS', 'ROW')) sign('sqlserver', 'OFFSET … FETCH');
        else if (isWord(t, 'LIMIT') && tokens[i + 2] && tokens[i + 2].text === ',') sign('mysql', 'LIMIT offset, count');
    });
    const ranked = Object.entries(signs).sort((a, b) => b[1].length - a[1].length);
    if (!ranked.length || (ranked[1] && ranked[1][1].length === ranked[0][1].length)) return null;
    if (!listDialects().some(d => d.id === ranked[0][0])) return null;
    return { dialect: ranked[0][0], reason: ranked[0][1].join(', ') };
}

// ---------------------------------------------------------------------------

/** @param {string} text @param {any} dialect */
function read(text, dialect) {
    if (text.length > MAX_SQL_IMPORT_CHARS) {
        throw new Refusal(`The SQL is too long to import (limit ${MAX_SQL_IMPORT_CHARS / 1024 / 1024} MB).`, undefined);
    }
    const all = lex(text, dialect.syntax);
    const open = all.find(t => t.unterminated);
    if (open) {
        const what = open.type === 'comment' ? 'This /* comment' : open.type === 'quoted' ? `This quoted name (${open.text[0]})` : 'This quote';
        throw new Refusal(`${what} is never closed.`, open);
    }
    const tokens = significant(all);
    let end = tokens.length;
    while (end > 0 && tokens[end - 1].text === ';') end--;
    if (end === 0) throw new Refusal('Paste a SELECT statement to import.', undefined);
    const semicolon = tokens.slice(0, end).findIndex(t => t.type === 'punct' && t.text === ';');
    if (semicolon !== -1) {
        throw new Refusal('This is more than one statement; import one statement at a time.', tokens[semicolon + 1]);
    }

    const notes = [];
    if (all.some(t => t.type === 'comment')) notes.push('Comments are left out: the builder has no place for them.');

    const first = tokens[0];
    if (isWord(first, 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'REPLACE', 'UPSERT')) {
        throw new Refusal(`Importing ${first.text.toUpperCase()} statements isn't supported yet; for now only SELECT queries can be imported.`, first);
    }
    if (first.type === 'punct' && first.text === '(') {
        throw new Refusal('Remove the parentheses around the whole query and import it again.', first);
    }
    if (!isWord(first, 'SELECT', 'WITH')) {
        throw new Refusal(`Only SELECT queries can be imported; this starts with “${first.text}”.`, first);
    }
    const reader = new Reader(tokens.slice(0, end), dialect);
    return { query: reader.query(0, end, 0), notes };
}

class Reader {
    /** @param {Token[]} tokens @param {any} dialect */
    constructor(tokens, dialect) {
        this.t = tokens;
        this.dialect = dialect;
        // SQL Server parameters are words: @name
        this.atParameters = dialect.parameter('x', 1).startsWith('@');
        this.match = matchParentheses(tokens);
    }

    // ------------------------------------------------------------- helpers

    /** Tokens [a, b) as text, with one space wherever the SQL had any. */
    text(a, b) {
        let out = '';
        for (let i = a; i < b; i++) {
            if (i > a && this.t[i].start > this.t[i - 1].end) out += ' ';
            out += this.t[i].text;
        }
        return out;
    }

    /** @param {number} i @param {...string} words */
    word(i, ...words) {
        return isWord(this.t[i], ...words);
    }

    punct(i, ch) {
        const t = this.t[i];
        return Boolean(t && t.type === 'punct' && t.text === ch);
    }

    /** A bare or quoted name that isn't a keyword. */
    isName(i) {
        const t = this.t[i];
        if (!t) return false;
        if (t.type === 'quoted') return true;
        return t.type === 'word' && !NOT_AN_ALIAS.has(t.text.toUpperCase());
    }

    /** The token at i, or the last one when the statement ends before it. */
    at(i) {
        return this.t[Math.min(i, this.t.length - 1)];
    }

    /** @returns {never} */
    fail(message, i) {
        throw new Refusal(message, this.at(i));
    }

    /** @returns {never} */
    unexpected(i, expected = '') {
        const t = this.t[i];
        if (!t) this.fail(`The query ends too early.${expected ? ` ${expected}` : ''}`, i);
        const upper = t.text.toUpperCase();
        const unsupported = {
            RETURNING: 'RETURNING isn\'t supported in the builder.',
            FOR: `${this.text(i, Math.min(i + 2, this.t.length))} isn't supported in the builder.`,
            OPTION: 'Query hints (OPTION …) aren\'t supported in the builder.',
            WINDOW: 'Named windows (WINDOW … AS) aren\'t supported yet; write the window in OVER (…).',
            QUALIFY: 'QUALIFY isn\'t supported in the builder.',
            INTO: 'SELECT … INTO isn\'t supported in the builder.',
            MINUS: 'MINUS isn\'t supported; use EXCEPT.'
        };
        if (t.type === 'word' && unsupported[upper]) this.fail(unsupported[upper], i);
        this.fail(expected || `The builder can't read “${t.text}” here.`, i);
    }

    eat(c, ch) {
        if (!this.punct(c.i, ch) || c.i >= c.end) return false;
        c.i++;
        return true;
    }

    /**
     * Moves past one expression: stops at a top-level comma or `stop`, and at
     * the end of the range. Parentheses are skipped whole; CASE … END is kept
     * together.
     * @param {number} i @param {number} end @param {(i: number) => boolean} stop
     */
    scan(i, end, stop) {
        let cases = 0;
        while (i < end) {
            const t = this.t[i];
            if (t.type === 'punct' && t.text === '(') {
                i = this.match[i] + 1;
                continue;
            }
            if (cases === 0 && ((t.type === 'punct' && t.text === ',') || stop(i))) break;
            if (isWord(t, 'CASE')) cases++;
            else if (isWord(t, 'END') && cases > 0) cases--;
            i++;
        }
        return i;
    }

    /** @param {{ i: number, end: number }} c @param {(i: number) => boolean} stop @returns {[number, number]} */
    span(c, stop) {
        const start = c.i;
        c.i = this.scan(c.i, c.end, stop);
        return [start, c.i];
    }

    /** Comma-separated parts of [a, b) at the top level. */
    commas(a, b) {
        /** @type {[number, number][]} */
        const parts = [];
        if (a >= b) return parts;
        let i = a;
        for (;;) {
            const next = this.scan(i, b, () => false);
            parts.push([i, next]);
            if (next >= b) return parts;
            i = next + 1;
        }
    }

    /** A token that starts the next clause of a SELECT. */
    clauseStart(i) {
        return this.word(i, 'WHERE', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT', 'QUALIFY', 'OPTION', 'RETURNING')
            || (this.word(i, 'GROUP', 'ORDER') && this.word(i + 1, 'BY'))
            || (this.word(i, 'FETCH') && this.word(i + 1, 'FIRST', 'NEXT'))
            || (this.word(i, 'FOR') && this.word(i + 1, 'UPDATE', 'SHARE', 'XML', 'JSON', 'BROWSE', 'NO', 'KEY'))
            || (this.word(i, 'WINDOW') && this.isName(i + 1) && this.word(i + 2, 'AS'))
            || (this.word(i, 'WITH') && this.word(i + 1, 'ROLLUP', 'CUBE'))
            || this.joinStart(i);
    }

    joinStart(i) {
        if (this.word(i, 'JOIN', 'NATURAL', 'STRAIGHT_JOIN')) return true;
        if (this.word(i, 'INNER')) return this.word(i + 1, 'JOIN');
        if (this.word(i, 'LEFT', 'RIGHT', 'FULL')) return this.word(i + 1, 'JOIN') || (this.word(i + 1, 'OUTER') && this.word(i + 2, 'JOIN'));
        if (this.word(i, 'CROSS')) return this.word(i + 1, 'JOIN', 'APPLY');
        if (this.word(i, 'OUTER')) return this.word(i + 1, 'APPLY');
        return false;
    }

    /** A SELECT (or WITH) wrapped in the parentheses that open at i. */
    isSubquery(i) {
        return this.punct(i, '(') && this.word(i + 1, 'SELECT', 'WITH');
    }

    // ------------------------------------------------------------- queries

    /** A whole query in [a, b): WITH, SELECTs joined by UNION etc., ORDER BY and paging. */
    query(a, b, depth) {
        const c = { i: a, end: b };
        const ctes = [];
        if (this.word(c.i, 'WITH')) {
            if (depth > 0) this.fail('WITH can only be used on the main query in the builder; move this CTE to the top.', c.i);
            c.i++;
            if (this.word(c.i, 'RECURSIVE')) this.fail('Recursive CTEs (WITH RECURSIVE) aren\'t supported yet.', c.i);
            do {
                if (!this.isName(c.i) || c.i >= b) this.unexpected(c.i, 'Expected a name for the WITH query here.');
                const cte = createCte();
                cte.name = this.text(c.i, c.i + 1);
                c.i++;
                if (this.punct(c.i, '(')) this.fail('Column names after a WITH query\'s name aren\'t supported yet; name the columns inside its SELECT.', c.i);
                if (!this.word(c.i, 'AS')) this.unexpected(c.i, 'Expected AS after the WITH query\'s name.');
                c.i++;
                if (this.word(c.i, 'MATERIALIZED', 'NOT')) this.fail('MATERIALIZED isn\'t supported in the builder.', c.i);
                if (!this.isSubquery(c.i)) this.unexpected(c.i, 'Expected a SELECT in parentheses here.');
                const close = this.match[c.i];
                cte.query = this.query(c.i + 1, close, depth + 1);
                c.i = close + 1;
                ctes.push(cte);
            } while (this.eat(c, ','));
        }
        const q = this.core(c, depth, false);
        q.ctes = ctes;
        const hadTop = q.limit !== '';
        while (c.i < b && this.word(c.i, 'UNION', 'INTERSECT', 'EXCEPT')) {
            let op = this.t[c.i].text.toUpperCase();
            c.i++;
            if (this.word(c.i, 'ALL')) {
                op += ' ALL';
                c.i++;
            } else if (this.word(c.i, 'DISTINCT')) {
                c.i++;
            }
            if (this.punct(c.i, '(')) this.fail(`A SELECT in parentheses after ${op} isn't supported yet; remove the parentheses.`, c.i);
            const setOp = createSetOp(op);
            setOp.query = this.core(c, depth + 1, true);
            q.setOps.push(setOp);
        }
        if (this.word(c.i, 'ORDER') && this.word(c.i + 1, 'BY') && c.i < b) {
            c.i += 2;
            q.orderBy = this.orderList(c, (i) => this.clauseStart(i));
        }
        this.paging(c, q, hadTop);
        if (c.i < b) this.unexpected(c.i);
        return q;
    }

    /** One SELECT … FROM … WHERE … GROUP BY … HAVING … */
    core(c, depth, branch) {
        if (depth > MAX_NESTING_DEPTH) this.fail(`Queries can be nested at most ${MAX_NESTING_DEPTH} levels deep in the builder.`, c.i);
        if (!this.word(c.i, 'SELECT') || c.i >= c.end) this.unexpected(c.i, 'Expected SELECT here.');
        c.i++;
        const q = /** @type {any} */ (createSelect());
        if (this.word(c.i, 'DISTINCT')) {
            if (this.word(c.i + 1, 'ON')) this.fail('DISTINCT ON isn\'t supported yet.', c.i);
            q.distinct = true;
            c.i++;
        } else if (this.word(c.i, 'ALL')) {
            c.i++;
        }
        if (this.word(c.i, 'TOP')) {
            if (branch) this.fail('TOP in one part of a UNION / INTERSECT / EXCEPT isn\'t supported; limit the whole query instead.', c.i);
            c.i++;
            let n = c.i;
            if (this.punct(c.i, '(')) {
                if (this.match[c.i] !== c.i + 2) this.fail('TOP needs a whole number here.', c.i + 1);
                n = c.i + 1;
                c.i += 3;
            } else {
                c.i++;
            }
            q.limit = this.wholeNumber(n, 'TOP');
            if (this.word(c.i, 'PERCENT') || (this.word(c.i, 'WITH') && this.word(c.i + 1, 'TIES'))) {
                this.fail('TOP … PERCENT and WITH TIES aren\'t supported in the builder.', c.i);
            }
        }

        q.columns = [];
        do {
            const [x, y] = this.span(c, (i) => this.word(i, 'FROM', 'INTO') || this.clauseStart(i));
            if (x === y) this.unexpected(x, 'Expected a column here.');
            q.columns.push(this.column(x, y));
        } while (this.eat(c, ','));
        if (!this.word(c.i, 'FROM') || c.i >= c.end) {
            if (this.word(c.i, 'INTO')) this.unexpected(c.i);
            this.fail('The builder needs a FROM table; a SELECT without FROM can\'t be imported.', c.i < c.end ? c.i : c.i - 1);
        }
        c.i++;
        q.from = this.source(c, depth);
        if (this.punct(c.i, ',')) this.fail('Tables separated by commas aren\'t supported; write them as JOIN … ON (or CROSS JOIN).', c.i);
        while (c.i < c.end && this.joinStart(c.i)) q.joins.push(this.join(c, depth));
        if (this.word(c.i, 'WHERE') && c.i < c.end) {
            c.i++;
            q.where = this.condition(c, depth, 'WHERE');
        }
        if (this.word(c.i, 'GROUP') && c.i < c.end) {
            c.i += 2;
            q.groupBy = this.expressionList(c).map(e => createGroupByItem(e));
            if (this.word(c.i, 'WITH')) this.fail(`WITH ${this.at(c.i + 1).text.toUpperCase()} isn't supported in the builder.`, c.i);
        }
        if (this.word(c.i, 'HAVING') && c.i < c.end) {
            c.i++;
            q.having = this.condition(c, depth, 'HAVING');
        }
        return q;
    }

    wholeNumber(i, what) {
        const t = this.t[i];
        if (!t || t.type !== 'number' || !/^\d+$/.test(t.text)) {
            this.fail(t && (t.type === 'param' || /^@/.test(t.text))
                ? `${what} needs a whole number in the builder; parameters aren't supported there yet.`
                : `${what} needs a whole number here.`, i);
        }
        return t.text;
    }

    /** LIMIT / OFFSET / FETCH after ORDER BY. */
    paging(c, q, hadTop) {
        let limit = null;
        let offset = null;
        const start = c.i;
        const fetch = () => {
            // FETCH FIRST|NEXT [n] ROW|ROWS ONLY
            c.i += 2;
            limit = this.word(c.i, 'ROW', 'ROWS') ? '1' : this.wholeNumber(c.i++, 'FETCH');
            if (!this.word(c.i, 'ROW', 'ROWS')) this.unexpected(c.i, 'Expected ROWS ONLY here.');
            c.i++;
            if (this.word(c.i, 'WITH') && this.word(c.i + 1, 'TIES')) this.fail('WITH TIES isn\'t supported in the builder.', c.i);
            if (!this.word(c.i, 'ONLY')) this.unexpected(c.i, 'Expected ONLY here.');
            c.i++;
        };
        if (this.word(c.i, 'LIMIT') && c.i < c.end) {
            c.i++;
            if (this.word(c.i, 'ALL')) this.fail('LIMIT ALL isn\'t supported; leave the limit out.', c.i);
            const first = this.wholeNumber(c.i++, 'LIMIT');
            if (this.eat(c, ',')) {
                offset = first;
                limit = this.wholeNumber(c.i++, 'LIMIT');
            } else {
                limit = first;
                if (this.word(c.i, 'OFFSET')) {
                    c.i++;
                    offset = this.wholeNumber(c.i++, 'OFFSET');
                }
            }
        } else if (this.word(c.i, 'OFFSET') && c.i < c.end) {
            c.i++;
            offset = this.wholeNumber(c.i++, 'OFFSET');
            if (this.word(c.i, 'ROW', 'ROWS')) c.i++;
            if (this.word(c.i, 'FETCH') && this.word(c.i + 1, 'FIRST', 'NEXT')) fetch();
            else if (this.word(c.i, 'LIMIT')) {
                c.i++;
                limit = this.wholeNumber(c.i++, 'LIMIT');
            }
        } else if (this.word(c.i, 'FETCH') && this.word(c.i + 1, 'FIRST', 'NEXT') && c.i < c.end) {
            fetch();
        }
        if (limit === null && offset === null) return;
        if (hadTop) this.fail('TOP together with OFFSET or LIMIT isn\'t supported.', start);
        const hasSetOps = q.setOps.length > 0;
        // MySQL has no OFFSET without LIMIT and writes a huge LIMIT instead
        if (limit !== null && offset !== null
            && this.dialect.paginate({ limit: '', offset, hasOrderBy: true, hasSetOps }).clauses.join(' ') === `LIMIT ${limit} OFFSET ${offset}`) {
            limit = null;
        }
        q.limit = limit ?? '';
        q.offset = offset ?? '';
        // SQL Server's OFFSET … FETCH needs ORDER BY; the builder adds ORDER BY (SELECT NULL) itself
        if (q.orderBy.length === 1 && q.orderBy[0].direction === 'ASC' && /^\(\s*SELECT\s+NULL\s*\)$/i.test(q.orderBy[0].expr)
            && this.dialect.paginate({ limit: q.limit, offset: q.offset, hasOrderBy: false, hasSetOps }).needsOrderBy) {
            q.orderBy = [];
        }
    }

    // ------------------------------------------------------------- FROM and JOIN

    source(c, depth) {
        if (this.punct(c.i, '(')) {
            if (!this.isSubquery(c.i)) this.fail('Only a SELECT can go in parentheses in FROM or JOIN.', c.i);
            const close = this.match[c.i];
            const source = createSubquerySource();
            source.query = this.query(c.i + 1, close, depth + 1);
            c.i = close + 1;
            source.alias = this.alias(c);
            if (this.punct(c.i, '(')) this.fail('Column names after a subquery\'s alias aren\'t supported yet.', c.i);
            return source;
        }
        if (this.word(c.i, 'LATERAL', 'VALUES', 'UNNEST', 'ONLY')) this.fail(`${this.t[c.i].text.toUpperCase()} isn't supported in FROM or JOIN.`, c.i);
        if (!this.isName(c.i) || c.i >= c.end) this.unexpected(c.i, 'Expected a table name here.');
        const start = c.i;
        c.i++;
        let parts = 1;
        while (this.punct(c.i, '.') && this.isName(c.i + 1) && parts < 4) {
            c.i += 2;
            parts++;
        }
        const table = this.text(start, c.i);
        if (this.punct(c.i, '(')) this.fail('Table functions aren\'t supported in FROM or JOIN yet.', c.i);
        const alias = this.alias(c);
        if (this.punct(c.i, '(')) this.fail('Column names after a table\'s alias aren\'t supported.', c.i);
        if (this.word(c.i, 'WITH') && this.punct(c.i + 1, '(')) this.fail('Table hints (WITH (…)) aren\'t supported in the builder.', c.i);
        if (this.word(c.i, 'USE', 'FORCE', 'IGNORE') && this.word(c.i + 1, 'INDEX', 'KEY')) this.fail('Index hints aren\'t supported in the builder.', c.i);
        if (this.word(c.i, 'TABLESAMPLE')) this.fail('TABLESAMPLE isn\'t supported in the builder.', c.i);
        return createTableSource(table, alias);
    }

    /** [AS] alias after a table or subquery; '' when there is none. */
    alias(c) {
        if (c.i >= c.end) return '';
        if (this.word(c.i, 'AS')) {
            if (!this.isName(c.i + 1) || c.i + 1 >= c.end) this.unexpected(c.i + 1, 'Expected a name after AS.');
            c.i += 2;
            return this.text(c.i - 1, c.i);
        }
        if (this.isName(c.i)) {
            c.i++;
            return this.text(c.i - 1, c.i);
        }
        return '';
    }

    join(c, depth) {
        const i = c.i;
        if (this.word(i, 'NATURAL')) this.fail('NATURAL JOIN isn\'t supported; write JOIN … ON.', i);
        if (this.word(i, 'STRAIGHT_JOIN')) this.fail('STRAIGHT_JOIN isn\'t supported; write JOIN … ON.', i);
        if (this.word(i + 1, 'APPLY')) this.fail(`${this.text(i, i + 2).toUpperCase()} isn't supported yet.`, i);
        let type;
        if (this.word(i, 'JOIN')) {
            type = 'INNER JOIN';
            c.i += 1;
        } else if (this.word(i, 'INNER', 'CROSS')) {
            type = `${this.t[i].text.toUpperCase()} JOIN`;
            c.i += 2;
        } else {
            type = `${this.t[i].text.toUpperCase()} JOIN`;
            c.i += this.word(i + 1, 'OUTER') ? 3 : 2;
        }
        if (this.word(c.i, 'LATERAL')) this.fail('LATERAL joins aren\'t supported yet.', c.i);
        const join = /** @type {any} */ (createJoin(type));
        join.source = this.source(c, depth);
        if (type === 'CROSS JOIN') {
            if (this.word(c.i, 'ON')) this.fail('A CROSS JOIN has no ON condition.', c.i);
            return join;
        }
        if (this.word(c.i, 'USING')) this.fail('JOIN … USING (…) isn\'t supported yet; write it as ON a.column = b.column.', c.i);
        if (!this.word(c.i, 'ON') || c.i >= c.end) this.unexpected(c.i, `Expected ON and a join condition after the ${type} table.`);
        c.i++;
        join.on = this.condition(c, depth, 'ON');
        return join;
    }

    // ------------------------------------------------------------- columns and lists

    column(a, b) {
        let alias = '';
        let end = b;
        const last = this.t[b - 1];
        if (b - a >= 3 && this.word(b - 2, 'AS') && (last.type === 'word' || last.type === 'quoted' || last.type === 'string')) {
            alias = last.text;
            end = b - 2;
        } else if (b - a >= 2 && this.impliedAlias(b - 1)) {
            alias = last.text;
            end = b - 1;
        }
        const col = this.aggregateColumn(a, end) || this.windowColumn(a, end) || this.caseColumn(a, end) || createColumn(this.text(a, end));
        col.alias = alias;
        return col;
    }

    /** A name right after an expression, without AS: SELECT total t */
    impliedAlias(i) {
        const t = this.t[i];
        const prev = this.t[i - 1];
        if (t.type === 'word' && (NOT_AN_ALIAS.has(t.text.toUpperCase()) || t.text.startsWith('@'))) return false;
        if (t.type !== 'word' && t.type !== 'quoted') return false;
        if (prev.type === 'word') return !JOINING_WORDS.has(prev.text.toUpperCase()) && !NOT_AN_ALIAS.has(prev.text.toUpperCase());
        return prev.type === 'quoted' || prev.type === 'number' || prev.type === 'string' || prev.type === 'param'
            || (prev.type === 'punct' && prev.text === ')') || (prev.type === 'op' && prev.text === '*');
    }

    /** COUNT(*), COUNT(DISTINCT x), SUM(x), … as the builder's aggregate columns. */
    aggregateColumn(a, b) {
        if (!this.word(a, ...AGGREGATE_FUNCTIONS) || !this.punct(a + 1, '(') || this.match[a + 1] !== b - 1) return null;
        const fn = this.t[a].text.toUpperCase();
        let x = a + 2;
        const y = b - 1;
        let aggregate = fn;
        if (this.word(x, 'DISTINCT')) {
            if (fn !== 'COUNT') return null;
            aggregate = 'COUNT DISTINCT';
            x++;
        }
        if (x >= y || this.word(x, 'ALL', 'DISTINCT') || this.commas(x, y).length !== 1) return null;
        const expr = this.text(x, y);
        if (expr === '*' && aggregate !== 'COUNT') return null;
        return createColumn(expr, { aggregate });
    }

    /** FUNC(args) OVER (PARTITION BY … ORDER BY … frame), when the builder can write it the same way. */
    windowColumn(a, b) {
        const name = this.t[a].type === 'word' ? this.t[a].text.toUpperCase() : '';
        const spec = Object.hasOwn(WINDOW_FUNCTIONS, name) ? WINDOW_FUNCTIONS[name] : null;
        if (!spec || !this.punct(a + 1, '(')) return null;
        const close = this.match[a + 1];
        if (!this.word(close + 1, 'OVER') || !this.punct(close + 2, '(') || this.match[close + 2] !== b - 1) return null;
        const col = createWindowColumn();
        col.func = name;
        const args = this.commas(a + 2, close);
        if (spec.args === 'none') {
            if (args.length) return null;
        } else {
            if (!args.length || this.word(a + 2, 'DISTINCT', 'ALL')) return null;
            const text = args.map(([x, y]) => this.text(x, y));
            if (text.some(t => t === '')) return null;
            col.args = name === 'COUNT' && text.length === 1 && text[0] === '*' ? '' : text.join(', ');
        }
        const end = b - 1;
        const over = { i: close + 3, end };
        const windowStop = (/** @type {number} */ i) => this.word(i, 'ROWS', 'RANGE', 'GROUPS') || (this.word(i, 'ORDER') && this.word(i + 1, 'BY'));
        try {
            if (this.word(over.i, 'PARTITION') && this.word(over.i + 1, 'BY')) {
                over.i += 2;
                col.partitionBy = this.expressionList(over, windowStop).map(expr => ({ expr }));
            }
            if (this.word(over.i, 'ORDER') && this.word(over.i + 1, 'BY')) {
                over.i += 2;
                col.orderBy = this.orderList(over, windowStop);
            }
        } catch (error) {
            if (error instanceof Refusal) return null;
            throw error;
        }
        const frame = this.t.slice(over.i, end).map(t => t.text.toUpperCase()).join(' ');
        const moving = /^ROWS BETWEEN (\d+) PRECEDING AND CURRENT ROW$/.exec(frame);
        if (frame === '') col.frame = '';
        else if (frame === 'ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW') col.frame = 'running';
        else if (frame === 'ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING') col.frame = 'whole';
        else if (moving) {
            col.frame = 'moving';
            col.frameSize = moving[1];
        } else return null;
        return col;
    }

    /** CASE WHEN … THEN … [ELSE …] END */
    caseColumn(a, b) {
        if (!this.word(a, 'CASE') || !this.word(a + 1, 'WHEN') || !this.word(b - 1, 'END') || b - a < 5) return null;
        const end = b - 1;
        const col = createCaseColumn();
        col.cases = [];
        let i = a + 1;
        while (this.word(i, 'WHEN') && i < end) {
            const then = this.scan(i + 1, end, (k) => this.word(k, 'THEN'));
            if (!this.word(then, 'THEN') || then >= end || then === i + 1) return null;
            const next = this.scan(then + 1, end, (k) => this.word(k, 'WHEN', 'ELSE'));
            if (next === then + 1) return null;
            col.cases.push({ when: this.text(i + 1, then), then: this.text(then + 1, next) });
            i = next;
        }
        if (this.word(i, 'ELSE') && i < end) {
            const next = this.scan(i + 1, end, () => false);
            if (next === i + 1) return null;
            col.elseValue = this.text(i + 1, next);
            i = next;
        }
        return i === end && col.cases.length ? col : null;
    }

    /** a, b, c up to the next clause */
    expressionList(c, stop = (/** @type {number} */ i) => this.clauseStart(i)) {
        const items = [];
        do {
            const [x, y] = this.span(c, stop);
            if (x === y) this.unexpected(x, 'Expected a column or expression here.');
            items.push(this.text(x, y));
        } while (this.eat(c, ','));
        return items;
    }

    /** a DESC, b … */
    orderList(c, stop) {
        const items = [];
        do {
            const [x, end] = this.span(c, stop);
            let y = end;
            if (x === y) this.unexpected(x, 'Expected a column or expression to sort by here.');
            if (y - x >= 2 && this.word(y - 2, 'NULLS') && this.word(y - 1, 'FIRST', 'LAST')) {
                this.fail('NULLS FIRST / NULLS LAST isn\'t supported yet.', y - 2);
            }
            let direction = 'ASC';
            if (y - x >= 2 && this.word(y - 1, 'ASC', 'DESC')) {
                direction = this.t[y - 1].text.toUpperCase();
                y--;
            }
            const item = createOrderItem(this.text(x, y));
            item.direction = direction;
            items.push(item);
        } while (this.eat(c, ','));
        return items;
    }

    // ------------------------------------------------------------- conditions

    /** The condition after WHERE, HAVING or ON, as a group. */
    condition(c, depth, keyword) {
        const [x, y] = this.span(c, (i) => this.clauseStart(i));
        if (x === y) this.unexpected(x, `Expected a condition after ${keyword}.`);
        return this.bool(x, y, depth, 0);
    }

    /** a AND b OR c … in [a, b): OR binds last, so it is the outer group. */
    bool(a, b, depth, level) {
        if (level > MAX_CONDITION_DEPTH) this.fail('The conditions are nested too deeply to import.', a);
        const ors = this.split(a, b, 'OR');
        if (ors.length > 1) {
            return createGroup('OR', ors.map(([x, y]) => {
                const ands = this.split(x, y, 'AND');
                return ands.length > 1 ? createGroup('AND', ands.map(([p, q]) => this.item(p, q, depth, level))) : this.item(x, y, depth, level);
            }));
        }
        return createGroup('AND', this.split(a, b, 'AND').map(([x, y]) => this.item(x, y, depth, level)));
    }

    /** Splits [a, b) at top-level AND or OR; the AND of BETWEEN … AND … stays. */
    split(a, b, word) {
        /** @type {[number, number][]} */
        const parts = [];
        let start = a;
        let cases = 0;
        let between = false;
        for (let i = a; i < b; i++) {
            if (this.punct(i, '(')) {
                i = this.match[i];
                continue;
            }
            if (this.word(i, 'CASE')) cases++;
            else if (this.word(i, 'END') && cases > 0) cases--;
            if (cases > 0) continue;
            if (this.word(i, 'BETWEEN')) between = true;
            else if (this.word(i, 'AND') && between) between = false;
            else if (this.word(i, word)) {
                if (i === start || i === b - 1) this.fail(`Expected a condition ${i === start ? 'before' : 'after'} ${word}.`, i);
                parts.push([start, i]);
                start = i + 1;
            }
        }
        parts.push([start, b]);
        return parts;
    }

    /** One condition, a group in parentheses, or NOT (…). */
    item(a, b, depth, level) {
        if (this.word(a, 'NOT') && !this.word(a + 1, 'EXISTS')) {
            if (this.punct(a + 1, '(') && this.match[a + 1] === b - 1 && !this.isSubquery(a + 1)) {
                const group = this.bool(a + 2, b - 1, depth, level + 1);
                group.negate = true;
                return group;
            }
            return createRawCondition(this.text(a, b));
        }
        if (this.punct(a, '(') && this.match[a] === b - 1 && !this.isSubquery(a)) {
            if (b - a === 2) this.fail('Expected a condition inside these parentheses.', a);
            return this.bool(a + 1, b - 1, depth, level + 1);
        }
        return this.predicate(a, b, depth);
    }

    /** left op right, IS [NOT] NULL, [NOT] IN, [NOT] LIKE, [NOT] BETWEEN, [NOT] EXISTS */
    predicate(a, b, depth) {
        const raw = () => createRawCondition(this.text(a, b));
        if (this.word(a, 'EXISTS') || (this.word(a, 'NOT') && this.word(a + 1, 'EXISTS'))) {
            const not = this.word(a, 'NOT');
            const open = not ? a + 2 : a + 1;
            if (!this.isSubquery(open) || this.match[open] !== b - 1) return raw();
            return createCondition({ op: not ? 'NOT EXISTS' : 'EXISTS', valueType: 'subquery', subquery: this.query(open + 1, b - 1, depth + 1) });
        }
        const found = this.operator(a, b);
        if (!found || found.at === a || found.other) return raw();
        const left = this.text(a, found.at);
        const r = found.at + found.length;
        if (r >= b) this.fail(`Expected a value after ${found.op}.`, r - 1);
        const condition = (/** @type {any} */ fields) => createCondition({ left, op: found.op, ...fields });

        if (found.op === 'IS') {
            const rest = this.t.slice(r, b).map(t => t.text.toUpperCase()).join(' ');
            if (rest === 'NULL') return condition({ op: 'IS NULL' });
            if (rest === 'NOT NULL') return condition({ op: 'IS NOT NULL' });
            return raw();
        }
        if (found.op.endsWith('BETWEEN')) {
            const and = this.scan(r, b, (k) => this.word(k, 'AND'));
            if (!this.word(and, 'AND') || and === r || and >= b - 1 || this.operator(and + 1, b)) return raw();
            const low = this.operand(r, and);
            const high = this.operand(and + 1, b);
            if (low.valueType === high.valueType && low.valueType !== 'column') return condition({ valueType: low.valueType, value: low.value, value2: high.value });
            return condition({ valueType: 'column', value: this.text(r, and), value2: this.text(and + 1, b) });
        }
        if (found.op.endsWith('IN')) {
            if (!this.punct(r, '(') || this.match[r] !== b - 1) return raw();
            if (this.isSubquery(r)) return condition({ valueType: 'subquery', subquery: this.query(r + 1, b - 1, depth + 1) });
            const list = this.list(r, b);
            return list ? condition(list) : raw();
        }
        if (this.operator(r, b) || this.word(r, 'ANY', 'ALL', 'SOME')) return raw();
        if (found.op.endsWith('LIKE')) {
            if (this.isSubquery(r) && this.match[r] === b - 1) return raw();
            return condition(this.operand(r, b));
        }
        if (this.isSubquery(r) && this.match[r] === b - 1) {
            return condition({ valueType: 'subquery', subquery: this.query(r + 1, b - 1, depth + 1) });
        }
        return condition(this.operand(r, b));
    }

    /**
     * The first comparison at the top level of [a, b).
     * @returns {{ op: string, at: number, length: number, other?: boolean } | null}
     */
    operator(a, b) {
        let cases = 0;
        for (let i = a; i < b; i++) {
            const t = this.t[i];
            if (t.type === 'punct' && t.text === '(') {
                i = this.match[i];
                continue;
            }
            if (isWord(t, 'CASE')) cases++;
            else if (isWord(t, 'END') && cases > 0) cases--;
            if (cases > 0) continue;
            if (t.type === 'op' && COMPARISONS.has(t.text)) return { op: t.text, at: i, length: 1 };
            if (t.type === 'op' && /^[~!@&<>|]/.test(t.text) && !['||', '->', '->>', '!<', '!>'].includes(t.text)) return { op: t.text, at: i, length: 1, other: true };
            if (isWord(t, 'IS', 'LIKE', 'IN', 'BETWEEN')) return { op: t.text.toUpperCase(), at: i, length: 1 };
            if (isWord(t, 'NOT') && this.word(i + 1, 'LIKE', 'IN', 'BETWEEN')) return { op: `NOT ${this.t[i + 1].text.toUpperCase()}`, at: i, length: 2 };
            if (t.type === 'word' && OTHER_PREDICATES.has(t.text.toUpperCase())) return { op: t.text, at: i, length: 1, other: true };
        }
        return null;
    }

    /** The right-hand side of a condition: a parameter, a literal value, or an expression. */
    operand(a, b) {
        if (b - a === 1) {
            const t = this.t[a];
            if (t.type === 'param') return { valueType: 'param', value: t.text.slice(1) };
            if (this.atParameters && t.type === 'word' && /^@[A-Za-z_]/.test(t.text)) return { valueType: 'param', value: t.text.slice(1) };
        }
        const text = this.text(a, b);
        const value = this.literal(a, b, text);
        return value === null ? { valueType: 'column', value: text } : { valueType: 'value', value };
    }

    /**
     * What to type into a value field so the builder writes this literal
     * exactly as it is: 'John' becomes John, 42 stays 42, '042' keeps its
     * quotes. null when the builder would write it differently.
     */
    literal(a, b, text) {
        const t = this.t[a];
        const single = b - a === 1;
        const signed = b - a === 2 && t.type === 'op' && (t.text === '-' || t.text === '+') && this.t[a + 1].type === 'number' && this.t[a + 1].start === t.end;
        if (!single && !signed) return null;
        if (single && !['string', 'number', 'word'].includes(t.type)) return null;
        const candidates = single && t.type === 'string' && t.value !== undefined ? [t.value, text] : [text];
        for (const candidate of candidates) {
            if (candidate === '' || candidate.trim() !== candidate) continue;
            const written = formatLiteral(candidate, this.dialect.id);
            if (written === text || (t.type === 'word' && written.toUpperCase() === text.toUpperCase())) return candidate;
        }
        return null;
    }

    /** An IN list: literal values when each is written back the same, otherwise the list as typed. */
    list(open, b) {
        const items = this.commas(open + 1, b - 1);
        if (!items.length || items.some(([x, y]) => x === y)) return null;
        const texts = items.map(([x, y]) => this.text(x, y));
        const values = items.map(([x, y], k) => this.literal(x, y, texts[k]));
        if (values.every(v => v !== null)) {
            // A value the list would split (a comma, quotes or brackets in it) keeps its quotes
            const typed = values.map((v, k) => (/[,()'"`[\]]/.test(/** @type {string} */ (v)) ? texts[k] : v));
            const value = typed.join(', ');
            const written = splitTopLevel(value).map(v => formatLiteral(v, this.dialect.id));
            if (written.length === texts.length && written.every((w, k) => w === texts[k] || (/^[A-Za-z]+$/.test(texts[k]) && w.toUpperCase() === texts[k].toUpperCase()))) {
                return { valueType: 'value', value };
            }
        }
        return { valueType: 'column', value: this.text(open, b) };
    }
}

/**
 * For each parenthesis, the index of its partner. Unbalanced ones are refused.
 * @param {Token[]} tokens
 */
function matchParentheses(tokens) {
    const match = new Int32Array(tokens.length).fill(-1);
    const stack = [];
    tokens.forEach((t, i) => {
        if (t.type !== 'punct') return;
        if (t.text === '(') stack.push(i);
        else if (t.text === ')') {
            const open = stack.pop();
            if (open === undefined) throw new Refusal('This ")" has no matching "(".', t);
            match[open] = i;
            match[i] = open;
        }
    });
    if (stack.length) throw new Refusal('This "(" is never closed.', tokens[stack[stack.length - 1]]);
    return match;
}
