// Reads tables from CREATE TABLE and ALTER TABLE … ADD statements, as written
// by hand or by pg_dump, mysqldump and SQL Server Management Studio. It reads
// names, column types, NOT NULL, primary keys, unique keys and foreign keys;
// everything else (defaults, checks, indexes, table options) is ignored.
// Other statements are skipped and counted, never guessed at.
//
// readDdl(text) → { tables, skipped, problems }
//   tables    tables in the order they were defined, checked by readTable()
//   skipped   [{ label, count }] statements that aren't table definitions
//   problems  [{ message, line, col }] parts that couldn't be read

import { lex, significant, isWord, nameOf } from './sql-lexer.js';
import { readTable, resolveForeignKeys, findTable, SchemaError } from './schema.js';

/** @typedef {import('./sql-lexer.js').Token} Token */

class ReadError extends Error {
    /** @param {string} message @param {Token | undefined} token */
    constructor(message, token) {
        super(message);
        this.token = token;
    }
}

// Words that end a column's type and start its constraints or options
const TYPE_STOP = new Set([
    'NOT', 'NULL', 'PRIMARY', 'UNIQUE', 'REFERENCES', 'DEFAULT', 'CONSTRAINT', 'CHECK', 'IDENTITY',
    'AUTO_INCREMENT', 'AUTOINCREMENT', 'GENERATED', 'COLLATE', 'COMMENT', 'ON', 'CHARSET', 'AS',
    'SPARSE', 'ROWGUIDCOL', 'FILESTREAM', 'MASKED', 'ENCRYPTED', 'INVISIBLE', 'VISIBLE', 'STORAGE',
    'COLUMN_FORMAT', 'SRID', 'KEY', 'COMPRESSION', 'ENGINE_ATTRIBUTE'
]);

// Statement kinds named by their object, for the "skipped" summary
const OBJECT_WORDS = new Set([
    'TABLE', 'INDEX', 'VIEW', 'FUNCTION', 'PROCEDURE', 'PROC', 'TRIGGER', 'SEQUENCE', 'SCHEMA', 'TYPE',
    'EXTENSION', 'DATABASE', 'USER', 'ROLE', 'DOMAIN', 'POLICY', 'SYNONYM', 'LOGIN', 'EVENT', 'RULE'
]);

/**
 * @param {string} text
 */
export function readDdl(text) {
    // Backticks mean MySQL, where \' escapes a quote and # starts a comment
    const mysql = text.includes('`');
    const all = lex(text, { backslashEscapes: mysql, hashComments: mysql });
    /** @type {{ message: string, line: number, col: number }[]} */
    const problems = [];
    const problem = (/** @type {string} */ message, /** @type {Token | undefined} */ token) => {
        problems.push({ message, line: token ? token.line : 0, col: token ? token.col : 0 });
    };

    const open = all.find(t => t.unterminated);
    if (open) {
        const what = open.type === 'comment' ? 'A /* comment' : open.type === 'quoted' ? `A quoted name (${open.text[0]})` : 'A quote';
        problem(`${what} is never closed, so the text after it can't be read.`, open);
    }

    /** @type {any[]} */
    const tables = [];
    /** @type {Map<string, number>} */
    const skipped = new Map();
    const skip = (/** @type {string} */ label) => skipped.set(label, (skipped.get(label) || 0) + 1);

    for (const statement of splitStatements(significant(all))) {
        let rest = statement;
        while (rest.length) {
            try {
                rest = readStatement(rest, tables, skip, problem);
            } catch (error) {
                if (!(error instanceof ReadError)) throw error;
                problem(error.message, error.token);
                rest = [];
            }
        }
    }

    // Check each table on its own; one bad table doesn't stop the others
    const checked = [];
    for (const table of tables) {
        try {
            checked.push(readTable(table, checked.length));
        } catch (error) {
            if (!(error instanceof SchemaError)) throw error;
            problem(error.message, table.token);
        }
    }
    resolveForeignKeys(checked);
    return {
        tables: checked,
        skipped: Array.from(skipped, ([label, count]) => ({ label, count })),
        problems: problems.sort((a, b) => a.line - b.line || a.col - b.col)
    };
}

// Statements end at ";" or at a line holding only GO (SQL Server scripts)
function splitStatements(tokens) {
    const statements = [];
    let current = [];
    tokens.forEach((token, i) => {
        const isGo = isWord(token, 'GO')
            && (i === 0 || tokens[i - 1].line < token.line)
            && (i === tokens.length - 1 || tokens[i + 1].line > token.line);
        if ((token.type === 'punct' && token.text === ';') || isGo) {
            if (current.length) statements.push(current);
            current = [];
        } else {
            current.push(token);
        }
    });
    if (current.length) statements.push(current);
    return statements;
}

function label(tokens) {
    const words = [];
    for (const token of tokens.slice(0, 5)) {
        if (token.type !== 'word') break;
        words.push(token.text.toUpperCase());
        if (OBJECT_WORDS.has(words[words.length - 1])) return words.join(' ');
    }
    if (words[0] === 'INSERT' || words[0] === 'DELETE') return `${words[0]}${words[1] ? ` ${words[1]}` : ''}`;
    return words[0] || tokens[0].text;
}

/**
 * Reads one statement from the start of `tokens` and returns what is left
 * (another statement that followed without a ";", as SSMS scripts do).
 */
function readStatement(tokens, tables, skip, problem) {
    const c = cursor(tokens);
    if (isWord(c.peek(), 'CREATE')) {
        const start = c.p;
        c.next();
        c.accept('OR');
        c.accept('REPLACE');
        c.accept('GLOBAL', 'LOCAL');
        c.accept('TEMPORARY', 'TEMP', 'UNLOGGED');
        if (c.accept('TABLE')) return readCreateTable(c, tables, skip, problem);
        c.p = start;
    } else if (isWord(c.peek(), 'ALTER') && isWord(c.peek(1), 'TABLE')) {
        c.p += 2;
        return readAlterTable(c, tables, skip, problem);
    }
    skip(label(tokens));
    return nextStatement(tokens, 1);
}

// Where a following CREATE or ALTER starts, at the top level
function nextStatement(tokens, from) {
    let depth = 0;
    for (let i = from; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type === 'punct' && t.text === '(') depth++;
        else if (t.type === 'punct' && t.text === ')') depth = Math.max(0, depth - 1);
        else if (depth === 0 && isWord(t, 'CREATE', 'ALTER') && !isWord(tokens[i - 1], 'ON', 'FOR', 'AFTER', 'BEFORE', 'INSTEAD')) {
            return tokens.slice(i);
        }
    }
    return [];
}

function cursor(tokens) {
    return {
        tokens,
        p: 0,
        peek(k = 0) { return tokens[this.p + k]; },
        next() { return tokens[this.p++]; },
        /** @param {...string} words */
        accept(...words) {
            if (isWord(tokens[this.p], ...words)) {
                this.p++;
                return true;
            }
            return false;
        },
        atPunct(ch) {
            const t = tokens[this.p];
            return Boolean(t && t.type === 'punct' && t.text === ch);
        },
        /** A possibly qualified name: a.b.c */
        name(what) {
            const first = tokens[this.p];
            const parts = [nameOf(first)];
            if (parts[0] === null) throw new ReadError(`Expected ${what} here.`, first);
            this.p++;
            while (this.atPunct('.') && nameOf(tokens[this.p + 1]) !== null) {
                parts.push(nameOf(tokens[this.p + 1]));
                this.p += 2;
            }
            return { name: parts.join('.'), token: first };
        },
        /** The elements of a (…) list, split at top-level commas; the cursor moves past ")". */
        group() {
            const open = tokens[this.p];
            if (!this.atPunct('(')) throw new ReadError('Expected "(" here.', open);
            this.p++;
            const items = [[]];
            let depth = 0;
            while (this.p < tokens.length) {
                const t = tokens[this.p++];
                if (t.type === 'punct' && t.text === '(') depth++;
                if (t.type === 'punct' && t.text === ')') {
                    if (depth === 0) return items.filter(item => item.length);
                    depth--;
                }
                if (depth === 0 && t.type === 'punct' && t.text === ',') items.push([]);
                else items[items.length - 1].push(t);
            }
            throw new ReadError('This "(" is never closed.', open);
        }
    };
}

function readCreateTable(c, tables, skip, problem) {
    if (c.accept('IF')) {
        c.accept('NOT');
        c.accept('EXISTS');
    }
    const { name, token } = c.name('a table name');
    if (!c.atPunct('(')) {
        skip(isWord(c.peek(), 'AS') ? 'CREATE TABLE … AS' : isWord(c.peek(), 'LIKE') ? 'CREATE TABLE … LIKE' : 'CREATE TABLE (other forms)');
        return nextStatement(c.tokens, c.p);
    }
    const table = { name, token, columns: [], primaryKey: [], unique: [], foreignKeys: [] };
    for (const element of c.group()) readElement(element, table, problem);
    const existing = findTable(tables, name);
    if (existing) {
        problem(`${name} is defined more than once; the last definition is used.`, token);
        tables.splice(tables.indexOf(existing), 1);
    }
    tables.push(table);
    return nextStatement(c.tokens, c.p);
}

function readAlterTable(c, tables, skip, problem) {
    if (c.accept('IF')) c.accept('EXISTS');
    c.accept('ONLY');
    const { name, token } = c.name('a table name');
    // SQL Server: WITH CHECK / WITH NOCHECK before ADD
    if (isWord(c.peek(), 'WITH') && isWord(c.peek(1), 'CHECK', 'NOCHECK')) c.p += 2;
    const rest = nextStatement(c.tokens, c.p);
    const table = findTable(tables, name);
    let applied = false;
    for (const action of splitTopLevel(c.tokens.slice(c.p, c.tokens.length - rest.length))) {
        if (!isWord(action[0], 'ADD')) continue;
        if (!table) {
            problem(`ALTER TABLE ${name}: the table isn't created earlier in this text, so the change was skipped.`, token);
            return rest;
        }
        const element = action.slice(isWord(action[1], 'COLUMN') ? 2 : 1);
        if (isWord(element[0], 'IF') && isWord(element[1], 'NOT') && isWord(element[2], 'EXISTS')) element.splice(0, 3);
        readElement(element, table, problem);
        applied = true;
    }
    if (!applied) skip('ALTER TABLE (other changes)');
    return rest;
}

// Splits tokens at top-level commas
function splitTopLevel(tokens) {
    const parts = [[]];
    let depth = 0;
    for (const t of tokens) {
        if (t.type === 'punct' && t.text === '(') depth++;
        if (t.type === 'punct' && t.text === ')') depth = Math.max(0, depth - 1);
        if (depth === 0 && t.type === 'punct' && t.text === ',') parts.push([]);
        else parts[parts.length - 1].push(t);
    }
    return parts.filter(p => p.length);
}

// Column names in a key list: "(a, b DESC, c(10))" → ['a', 'b', 'c']
function keyColumns(c) {
    return c.group().map(item => {
        const name = nameOf(item[0]);
        if (name === null) throw new ReadError('Expected a column name here.', item[0]);
        return name;
    });
}

/**
 * One item of a CREATE TABLE list, or what follows ADD in ALTER TABLE.
 * @param {Token[]} tokens
 * @param {any} table
 * @param {(message: string, token?: Token) => void} problem
 */
function readElement(tokens, table, problem) {
    const c = cursor(tokens);
    try {
        if (c.accept('CONSTRAINT')) c.name('a constraint name');
        if (c.accept('PRIMARY')) {
            c.accept('KEY');
            c.accept('CLUSTERED', 'NONCLUSTERED');
            table.primaryKey = keyColumns(c);
        } else if (c.accept('UNIQUE')) {
            c.accept('KEY', 'INDEX');
            c.accept('CLUSTERED', 'NONCLUSTERED');
            if (!c.atPunct('(')) c.name('an index name');
            table.unique.push(keyColumns(c));
        } else if (c.accept('FOREIGN')) {
            c.accept('KEY');
            if (!c.atPunct('(')) c.name('a key name');
            const columns = keyColumns(c);
            if (!c.accept('REFERENCES')) throw new ReadError('Expected REFERENCES here.', c.peek());
            table.foreignKeys.push({ columns, ...reference(c) });
        } else if (isWord(c.peek(), 'CHECK', 'EXCLUDE', 'KEY', 'INDEX', 'FULLTEXT', 'SPATIAL', 'PERIOD', 'DEFAULT')) {
            // Checks, indexes, SQL Server "DEFAULT … FOR col": not part of the schema
        } else if (isWord(c.peek(), 'LIKE')) {
            problem(`${table.name}: LIKE copies another table's columns, which isn't supported; they weren't added.`, c.peek());
        } else if (c.p > 0) {
            // CONSTRAINT name followed by something else
        } else {
            readColumn(c, table);
        }
    } catch (error) {
        if (!(error instanceof ReadError)) throw error;
        problem(`${table.name}: ${error.message}`, error.token);
    }
}

// REFERENCES table [(columns)]
function reference(c) {
    const { name } = c.name('the referenced table');
    return { refTable: name, refColumns: c.atPunct('(') ? keyColumns(c) : [] };
}

function readColumn(c, table) {
    const first = c.peek();
    const name = nameOf(first);
    if (name === null) throw new ReadError('Expected a column name here.', first);
    c.next();
    const column = { name, type: readType(c), nullable: true };
    table.columns.push(column);

    // Constraints and options, in any order
    while (c.p < c.tokens.length) {
        if (c.atPunct('(')) {
            c.group();
        } else if (c.accept('NOT')) {
            if (c.accept('NULL')) column.nullable = false;
        } else if (c.accept('NULL')) {
            column.nullable = true;
        } else if (c.accept('PRIMARY')) {
            c.accept('KEY');
            table.primaryKey = [name];
        } else if (c.accept('UNIQUE')) {
            c.accept('KEY');
            table.unique.push([name]);
        } else if (c.accept('REFERENCES')) {
            table.foreignKeys.push({ columns: [name], ...reference(c) });
        } else if (c.accept('DEFAULT')) {
            skipOperand(c);
        } else {
            c.next();
        }
    }
}

// A column type: words and (…) groups up to the first constraint word
function readType(c) {
    let type = '';
    while (c.p < c.tokens.length) {
        const t = c.peek();
        if (t.type === 'punct' && t.text === '(') {
            const args = c.group().map(item => item.map(x => x.text).join(' '));
            type += `(${args.join(', ')})`;
        } else if (t.type === 'quoted' && t.text === '[]') {
            type += '[]'; // PostgreSQL array
            c.next();
        } else if ((t.type === 'word' && !TYPE_STOP.has(t.text.toUpperCase())) || (t.type === 'quoted' && !type)) {
            // CHARACTER SET after a type is an option, not part of the type
            if (type && isWord(t, 'CHARACTER') && isWord(c.peek(1), 'SET')) break;
            type += `${type ? ' ' : ''}${t.type === 'quoted' ? t.value : t.text}`;
            c.next();
            // A qualified type name: dbo.my_type
            while (c.atPunct('.') && nameOf(c.peek(1)) !== null) {
                type += `.${nameOf(c.peek(1))}`;
                c.p += 2;
            }
        } else {
            break;
        }
    }
    return type;
}

// A DEFAULT value: one operand, with any casts and operators that follow it
function skipOperand(c) {
    const step = () => {
        if (c.atPunct('(')) c.group();
        else {
            c.next();
            if (c.atPunct('(')) c.group(); // a function call
        }
    };
    step();
    while (c.p < c.tokens.length && c.peek().type === 'op' && !isWord(c.peek(), 'NOT', 'NULL')) {
        c.next();
        step();
    }
}
