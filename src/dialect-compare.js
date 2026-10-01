// Compares how two dialects write the current query: the SQL of each, the
// parts that differ (token by token, ignoring layout and optional words),
// and the checks the other dialect adds. Nothing is converted or changed;
// the query model is the same, only the dialect used to write it differs.

import { generateSQL } from './generator.js';
import { validateWorkspace, hasErrors } from './validation.js';
import { getDialect } from './dialects.js';
import { compareSql } from './roundtrip.js';

/**
 * @param {any} workspace
 * @param {string} fromId the current dialect
 * @param {string} toId the dialect to compare with
 * @param {{ quoteIdentifiers?: boolean, pretty?: boolean, format?: object }} [options]
 *   format: SQL format options (see generator.js)
 */
export function compareDialects(workspace, fromId, toId, { quoteIdentifiers = false, pretty = true, format = {} } = {}) {
    const side = (id) => {
        const dialect = getDialect(id);
        const issues = validateWorkspace(workspace, { dialect: id, quoteIdentifiers });
        let sql = '';
        try {
            sql = generateSQL(workspace, { ...format, dialect: id, quoteIdentifiers, pretty });
        } catch {
            // An incomplete query; the errors say why
        }
        return { id: dialect.id, label: dialect.label, shortLabel: dialect.shortLabel, dialect, issues, blocked: hasErrors(issues), sql };
    };
    const from = side(fromId);
    const to = side(toId);

    // Quote characters differ on every name: said once instead of per name
    const quoteFrom = from.dialect.quoteIdentifier('name');
    const quoteTo = to.dialect.quoteIdentifier('name');
    const notes = [];
    if (quoteIdentifiers && quoteFrom !== quoteTo) notes.push(`Names are quoted as ${quoteTo} instead of ${quoteFrom}.`);

    const check = compareSql(from.sql, to.sql, from.dialect.syntax, { builderSyntax: to.dialect.syntax, quoting: false });

    // What the other dialect's checks add: problems and dialect notes, not the tips both share
    const known = new Set(from.issues.map(i => i.message));
    const added = to.issues.filter(i => !known.has(i.message) && (i.level === 'error' || i.level === 'warning' || i.category === 'dialect'));

    return {
        from: { id: from.id, label: from.label, sql: from.sql, blocked: from.blocked },
        to: { id: to.id, label: to.label, shortLabel: to.shortLabel, sql: to.sql, blocked: to.blocked },
        check,
        notes,
        added: added.map(({ level, message }) => ({ level, message }))
    };
}
