// Scripts written for SQL Server Management Studio (and most SQL editors)
// often leave out the semicolons between statements, and separate batches
// with a line holding only GO. SQLite needs a semicolon after each statement,
// so SQL Lab reads such scripts in two steps:
//   - replaceBatchSeparators turns each GO line into a semicolon before the
//     script runs (it never changes text inside strings, names or comments);
//   - when SQLite reports a syntax error exactly where a line starts with a
//     statement keyword, the adapter ends the statement before that line and
//     runs it on its own (isStatementStartAt). SQL that SQLite accepts as it
//     is never reaches this step, so valid scripts run unchanged.

const STATEMENT_START = new Set([
    'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'WITH', 'VALUES',
    'CREATE', 'DROP', 'ALTER', 'PRAGMA', 'EXPLAIN', 'ANALYZE', 'VACUUM', 'REINDEX',
    'ATTACH', 'DETACH', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE'
]);

/**
 * Replaces each line holding only GO (optionally `GO 5` or `GO;`) with a
 * semicolon, keeping every other character, so line numbers stay the same.
 * @param {string} sql
 */
export function replaceBatchSeparators(sql) {
    const text = String(sql ?? '');
    if (!/^[ \t]*go\b/im.test(text)) return text;
    let out = '';
    let i = 0;
    let lineStart = true;
    while (i < text.length) {
        const c = text[i];
        if (lineStart) {
            const m = /^[ \t]*go(?:[ \t]+\d+)?[ \t]*;?[ \t]*(?=\r?\n|$)/i.exec(text.slice(i, i + 200));
            if (m) {
                out += ';';
                i += m[0].length;
                lineStart = false;
                continue;
            }
        }
        lineStart = false;
        if (c === '\n') {
            out += c;
            i++;
            lineStart = true;
        } else if (c === "'" || c === '"' || c === '`' || c === '[') {
            const close = c === '[' ? ']' : c;
            let j = i + 1;
            for (; j < text.length; j++) {
                if (text[j] === close) {
                    if (close !== ']' && text[j + 1] === close) j++;
                    else break;
                }
            }
            out += text.slice(i, j + 1);
            i = j + 1;
        } else if (c === '-' && text[i + 1] === '-') {
            const j = text.indexOf('\n', i);
            const end = j < 0 ? text.length : j;
            out += text.slice(i, end);
            i = end;
        } else if (c === '/' && text[i + 1] === '*') {
            const j = text.indexOf('*/', i + 2);
            const end = j < 0 ? text.length : j + 2;
            out += text.slice(i, end);
            i = end;
        } else {
            out += c;
            i++;
        }
    }
    return out;
}

/**
 * Whether `bytes[at]` starts a statement keyword that is the first thing on
 * its line, below the statement's own first line (`from`).
 * @param {Uint8Array} bytes the script, UTF-8
 * @param {number} from where the statement starts
 * @param {number} at the byte SQLite reported the syntax error at
 */
export function isStatementStartAt(bytes, from, at) {
    if (at <= from || at >= bytes.length) return false;
    // Only spaces or tabs between the line's start and the keyword, and the line is not the statement's first
    let i = at - 1;
    while (i >= from && (bytes[i] === 32 || bytes[i] === 9)) i--;
    if (i < from || bytes[i] !== 10) return false;
    let word = '';
    for (let j = at; j < bytes.length && j < at + 12; j++) {
        const b = bytes[j];
        if ((b >= 65 && b <= 90) || (b >= 97 && b <= 122)) word += String.fromCharCode(b);
        else if ((b >= 48 && b <= 57) || b === 95) return false;
        else break;
    }
    return STATEMENT_START.has(word.toUpperCase());
}
