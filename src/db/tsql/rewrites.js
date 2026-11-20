// Running MERGE, CROSS / OUTER APPLY and PIVOT / UNPIVOT on SQLite, which
// has none of them. shapes.js reads the statements; this file turns them into
// steps SQLite can run: APPLY becomes a join on a table of the right side's
// rows for each left row, PIVOT a GROUP BY with one CASE per column, UNPIVOT
// a UNION ALL, and MERGE a few passes over a table of matched rows.
//
// It follows SQL Server's documented behaviour (learn.microsoft.com T-SQL
// reference). It isn't SQL Server and uses none of its code.

import { tokens } from '../dialect-translate.js';
import { sigTokens } from './parse.js';
import { findApply, findPivot, parseMerge, sourceAliases } from './shapes.js';
import { unquote } from './modules.js';

/** SQLite's quoting. */
const q = (/** @type {string} */ name) => `"${String(name).replace(/"/g, '""')}"`;
/** T-SQL's quoting, for text that goes through the translator. */
const b = (/** @type {string} */ name) => `[${String(name).replace(/]/g, ']]')}]`;
const lower = (/** @type {string} */ s) => String(s).toLowerCase();
const nstr = (/** @type {string} */ s) => `N'${String(s).replace(/'/g, '\'\'')}'`;

/** At most this many different left-side values for one APPLY. */
export const MAX_APPLY_KEYS = 50000;
/** At most this many rows changed by one MERGE. */
export const MAX_MERGE_ROWS = 200000;

/**
 * What the engine lends these steps.
 * @typedef {{
 *   translate(text: string): string,
 *   rows(sql: string, at: number, bind?: unknown[]): { columns: string[], rows: any[][] },
 *   run(sql: string, at: number, bind?: unknown[]): number,
 *   setVar(name: string, value: unknown): void,
 *   deleteVar(name: string): void,
 *   temp(prefix: string): string,
 *   drop(table: string): void,
 *   dropAtEnd(table: string): void,
 *   fail(message: string, number: number, at: number): never,
 *   perCall: boolean
 * }} Api
 */

/** WITH a AS (…), b AS (…) before the statement's own SELECT, or ''. */
export function ctePrefix(src) {
    const sig = sigTokens(src);
    if (sig[0]?.u !== 'WITH') return '';
    let depth = 0;
    for (let k = 1; k < sig.length; k++) {
        const t = sig[k];
        if (t.t === 'p' && t.v === '(') depth++;
        else if (t.t === 'p' && t.v === ')') depth--;
        else if (depth === 0 && ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(t.u)) return src.slice(0, t.start);
    }
    return '';
}

/** The text from `from` to the end of its parentheses (or of the statement). */
function levelText(src, from) {
    const rest = src.slice(from);
    let depth = 0;
    for (const t of sigTokens(rest)) {
        if (t.t !== 'p') continue;
        if (t.v === '(') depth++;
        else if (t.v === ')' && --depth < 0) return rest.slice(0, t.start);
    }
    return rest;
}

/** Column names made unique (SQLite tables can't repeat one). */
function uniqueNames(columns) {
    const seen = new Map();
    return columns.map(c => {
        const key = lower(c);
        const n = (seen.get(key) || 0) + 1;
        seen.set(key, n);
        return n === 1 ? c : `${c}_${n}`;
    });
}

// ---- APPLY

/**
 * Rewrites every CROSS / OUTER APPLY in a statement as a join. The right side
 * runs once for each different set of left-side values it uses, and its rows
 * go in a temp table with those values, which the join matches on.
 * @param {Api} api
 * @param {string} text the statement
 * @param {number} at its offset in the script
 */
export function rewriteApply(api, text, at) {
    let out = text;
    /** @type {Map<string, string[]>} an APPLY's alias → its columns (its table also holds the key columns, which * mustn't show) */
    const applied = new Map();
    for (let round = 0; round < 32; round++) {
        const a = findApply(out);
        if (!a) return out;
        const prefix = ctePrefix(out);
        const withs = prefix && a.from >= prefix.length ? prefix : '';
        // Columns of the left side the right side uses (o.Id), unless it names its own source the same
        const innerSig = sigTokens(a.inner);
        const innerFrom = innerSig.findIndex(t => t.u === 'FROM');
        const own = new Set(innerFrom >= 0 ? sourceAliases(a.inner.slice(innerSig[innerFrom].end)).map(lower) : []);
        const outer = new Set(a.leftAliases.map(lower).filter(x => !own.has(x)));
        const id = round + 1 + Math.floor(Math.random() * 1e6);
        /** @type {{ name: string, text: string }[]} */
        const refs = [];
        const byKey = new Map();
        const toks = tokens(a.inner);
        for (let i = 0; i < toks.length; i++) {
            const t = toks[i];
            const col = toks[i + 2];
            if ((t.t !== 'word' && t.t !== 'ident') || toks[i + 1]?.v !== '.' || !col || (col.t !== 'word' && col.t !== 'ident')) continue;
            if (toks[i - 1]?.v === '.' || !outer.has(lower(unquote(t.v)))) continue;
            const key = `${lower(unquote(t.v))}.${lower(unquote(col.v))}`;
            let ref = byKey.get(key);
            if (!ref) {
                ref = { name: `@__ak${id}_${refs.length}`, text: `${t.v}.${col.v}` };
                refs.push(ref);
                byKey.set(key, ref);
            }
            toks.splice(i, 3, { t: 'word', v: ref.name });
        }
        const inner = toks.map(x => x.v).join('');
        const alias = b(a.alias);
        let join;
        if (!refs.length) {
            // The right side doesn't depend on the left: a plain join
            join = a.kind === 'CROSS' ? `CROSS JOIN (${inner}) AS ${alias}` : `LEFT JOIN (${inner}) AS ${alias} ON 1 = 1`;
        } else {
            const keyList = refs.map((r, j) => `${r.text} AS ${b(`__k${j}`)}`).join(', ');
            const keys = api.rows(api.translate(`${withs}SELECT DISTINCT ${keyList} FROM ${a.leftText}`), at).rows;
            if (keys.length > MAX_APPLY_KEYS) api.fail(`${a.kind} APPLY ran its right side for more than ${MAX_APPLY_KEYS.toLocaleString()} different rows, which SQL Lab doesn't do. Filter the left side first.`, 8623, at);
            const name = api.temp('apply');
            const table = `temp.${name}`;
            api.run(`DROP TABLE IF EXISTS ${table}`, at);
            api.dropAtEnd(name);
            const once = api.perCall ? null : api.translate(`${withs}${inner}`);
            /** @type {string[] | null} */
            let columns = null;
            const create = (/** @type {string} */ sqlInner) => {
                columns = api.rows(`SELECT * FROM (${sqlInner}) WHERE 0`, at).columns;
                const names = uniqueNames(columns);
                api.run(`CREATE TABLE ${table} (${[...refs.map((r, j) => q(`__k${j}`)), ...names.map(q)].join(', ')})`, at);
                columns = names;
            };
            try {
                if (!keys.length) {
                    for (const r of refs) api.setVar(r.name, null);
                    create(once ?? api.translate(`${withs}${inner}`));
                }
                for (const row of keys) {
                    refs.forEach((r, j) => api.setVar(r.name, row[j]));
                    const sqlInner = once ?? api.translate(`${withs}${inner}`);
                    if (!columns) create(sqlInner);
                    api.run(`INSERT INTO ${table} SELECT ${refs.map(r => r.name).join(', ')}, __x.* FROM (${sqlInner}) AS __x`, at);
                }
            } finally {
                for (const r of refs) api.deleteVar(r.name);
            }
            applied.set(lower(a.alias), /** @type {string[]} */ (/** @type {unknown} */ (columns)));
            const on = refs.map((r, j) => `${alias}.${b(`__k${j}`)} IS ${r.text}`).join(' AND ');
            join = `${a.kind === 'CROSS' ? 'JOIN' : 'LEFT JOIN'} ${table} AS ${alias} ON ${on}`;
        }
        const everyAlias = sourceAliases(levelText(out, a.from).replace(/^\s*FROM\b/i, ''));
        out = out.slice(0, a.applyStart) + join + out.slice(a.applyEnd);
        // The select list is before the APPLY, so its offsets still hold
        const list = expandStars(out.slice(a.selectStart, a.selectEnd), everyAlias, applied);
        out = out.slice(0, a.selectStart) + list + out.slice(a.selectEnd);
    }
    return out;
}

/** * and x.* in a select list, written out where a table holds columns that mustn't show. */
function expandStars(list, aliases, applied) {
    if (!applied.size) return list;
    const toks = tokens(list);
    const prevSig = (/** @type {number} */ k) => {
        let j = k - 1;
        while (j >= 0 && (toks[j].t === 'ws' || toks[j].t === 'nl' || toks[j].t === 'comment')) j--;
        return j;
    };
    const columnsOf = (/** @type {string} */ alias) => /** @type {string[]} */ (applied.get(lower(alias))).map(c => `${b(alias)}.${b(c)}`).join(', ');
    for (let k = toks.length - 1; k >= 0; k--) {
        if (toks[k].v !== '*') continue;
        const p = prevSig(k);
        if (p >= 0 && toks[p].v === '.') {
            const name = prevSig(p);
            if (name >= 0 && applied.has(lower(unquote(toks[name].v)))) toks.splice(name, k - name + 1, { t: 'word', v: columnsOf(unquote(toks[name].v)) });
            continue;
        }
        if (p >= 0 && toks[p].v !== ',') continue;
        toks.splice(k, 1, { t: 'word', v: aliases.map(x => (applied.has(lower(x)) ? columnsOf(x) : `${b(x)}.*`)).join(', ') });
    }
    return toks.map(x => x.v).join('');
}

// ---- PIVOT / UNPIVOT

/**
 * Rewrites every PIVOT as a GROUP BY over the source's other columns, with
 * AGG(CASE WHEN column = value THEN … END) for each value, and every UNPIVOT
 * as a UNION ALL with one SELECT per column.
 * @param {Api} api
 * @param {string} text
 * @param {number} at
 */
export function rewritePivot(api, text, at) {
    let out = text;
    for (let round = 0; round < 16; round++) {
        const p = findPivot(out);
        if (!p) return out;
        const prefix = ctePrefix(out);
        const withs = prefix && p.start >= prefix.length ? prefix : '';
        const as = b(p.sourceAlias || '__pv');
        const columns = api.rows(api.translate(`${withs}SELECT * FROM ${p.source} AS ${as} WHERE 1 = 0`), at).columns;
        const has = new Set(columns.map(lower));
        const pc = lower(p.pivotColumn);
        let replacement;
        if (p.kind === 'PIVOT') {
            if (!has.has(pc)) api.fail(`Invalid column name '${p.pivotColumn}'.`, 207, at);
            const used = new Set(tokens(/** @type {string} */ (p.aggArg)).filter(t => t.t === 'word' || t.t === 'ident').map(t => lower(unquote(t.v))));
            const groups = columns.filter(c => lower(c) !== pc && !used.has(lower(c))).map(c => `${as}.${b(c)}`);
            const cases = p.values.map(v => `${p.agg}(CASE WHEN CAST(${as}.${b(p.pivotColumn)} AS NVARCHAR(4000)) = ${nstr(v)} THEN ${p.aggArg} END) AS ${b(v)}`);
            replacement = `(SELECT ${[...groups, ...cases].join(', ')} FROM ${p.source} AS ${as}${groups.length ? ` GROUP BY ${groups.join(', ')}` : ''}) AS ${b(p.alias)}`;
        } else {
            for (const v of p.values) if (!has.has(lower(v))) api.fail(`Invalid column name '${v}'.`, 207, at);
            const valueSet = new Set(p.values.map(lower));
            const others = columns.filter(c => !valueSet.has(lower(c))).map(c => `${as}.${b(c)}`);
            const parts = p.values.map(v => `SELECT ${[...others, `${nstr(v)} AS ${b(p.pivotColumn)}`, `${as}.${b(v)} AS ${b(/** @type {string} */ (p.value))}`].join(', ')} FROM ${p.source} AS ${as} WHERE ${as}.${b(v)} IS NOT NULL`);
            replacement = `(${parts.join(' UNION ALL ')}) AS ${b(p.alias)}`;
        }
        out = out.slice(0, p.start) + replacement + out.slice(p.end);
    }
    return out;
}

// ---- MERGE

/**
 * Runs a MERGE: the source rows go in a temp table, the target rows that
 * match them in another (with the WHEN clause each one takes, first that
 * fits), then the updates, deletes and inserts run, inside a savepoint so a
 * failure leaves the target as it was.
 * @param {Api} api
 * @param {string} text
 * @param {number} at
 * @returns {{ affected: number, inserted: number, output: { columns: string[], rows: any[][] } | null, into: string, intoColumns: string }}
 */
export function runMerge(api, text, at) {
    const m = parseMerge(text, at);
    const ta = b(m.targetAlias);
    const sa = b(m.sourceAlias);
    const target = m.target;
    const phys = api.translate(`SELECT * FROM ${target}`).replace(/^\s*SELECT\s+\*\s+FROM\s+/i, '').trim();
    const targetColumns = api.rows(`SELECT * FROM ${phys} WHERE 0`, at).columns;
    const known = new Set(targetColumns.map(lower));
    for (const c of m.clauses) {
        for (const column of [...c.sets.map(s => s.column), ...c.columns]) {
            if (!known.has(lower(column))) api.fail(`Invalid column name '${column}'.`, 207, at);
        }
    }
    /** @type {string[]} */
    const temps = [];
    const temp = (/** @type {string} */ prefix) => {
        const t = api.temp(prefix);
        temps.push(t);
        return `temp.${t}`;
    };
    const savepoint = q(`__merge_${Math.floor(Math.random() * 1e9)}`);
    api.run(`SAVEPOINT ${savepoint}`, at);
    let affected = 0;
    let inserted = 0;
    /** @type {{ columns: string[], rows: any[][] } | null} */
    let output = null;
    try {
        // The source's rows
        const src = temp('msrc');
        let select;
        if (m.source.kind === 'values') select = `SELECT ${m.source.columns.map((c, k) => `column${k + 1} AS ${b(c)}`).join(', ')} FROM (${m.source.text})`;
        else if (m.source.kind === 'query') {
            select = m.source.text;
            if (m.source.columns.length) {
                const named = api.rows(`SELECT * FROM (${api.translate(select)}) WHERE 0`, at).columns;
                if (named.length !== m.source.columns.length) api.fail(`'${m.sourceAlias}' has fewer columns than were specified in the column list.`, 8158, at);
                select = `SELECT ${named.map((c, k) => `__q.${b(c)} AS ${b(m.source.columns[k])}`).join(', ')} FROM (${select}) AS __q`;
            }
        } else select = `SELECT * FROM ${m.source.text}`;
        api.run(`CREATE TABLE ${src} AS ${api.translate(select)}`, at);

        // Target rows that match source rows, and the WHEN clause each pair takes
        const pair = temp('mpair');
        api.run(`CREATE TABLE ${pair} AS ${api.translate(`SELECT ${ta}.rowid AS trid, ${sa}.rowid AS srid, NULL AS clause FROM ${target} AS ${ta} JOIN ${src} AS ${sa} ON ${m.on}`)}`, at);
        const numbered = m.clauses.map((c, k) => ({ ...c, k }));
        const assign = (/** @type {string} */ table, /** @type {typeof numbered} */ list, /** @type {string} */ from, /** @type {string} */ where) => {
            for (const c of list) {
                const cond = c.cond ? ` AND EXISTS (${api.translate(`SELECT 1 FROM ${from} WHERE ${where} AND (${c.cond})`)})` : '';
                api.run(`UPDATE ${table} AS __p SET clause = ${c.k} WHERE clause IS NULL${cond}`, at);
            }
        };
        assign(pair, numbered.filter(c => c.match === 'matched'), `${target} AS ${ta}, ${src} AS ${sa}`, `${ta}.rowid = __p.trid AND ${sa}.rowid = __p.srid`);
        if (api.rows(`SELECT 1 FROM ${pair} WHERE clause IS NOT NULL GROUP BY trid HAVING COUNT(*) > 1 LIMIT 1`, at).rows.length) {
            api.fail('The MERGE statement attempted to UPDATE or DELETE the same row more than once. This happens when a target row matches more than one source row. A MERGE statement cannot UPDATE/DELETE the same row of the target table multiple times. Refine the ON clause to ensure a target row matches at most one source row, or use the GROUP BY clause to group the source rows.', 8672, at);
        }
        const byTarget = numbered.filter(c => c.match === 'target');
        const bySource = numbered.filter(c => c.match === 'source');
        let nt = '';
        if (byTarget.length) {
            nt = temp('mnt');
            api.run(`CREATE TABLE ${nt} AS SELECT rowid AS srid, NULL AS clause FROM ${src} WHERE rowid NOT IN (SELECT srid FROM ${pair})`, at);
            assign(nt, byTarget, `${src} AS ${sa}`, `${sa}.rowid = __p.srid`);
        }
        let ns = '';
        if (bySource.length) {
            ns = temp('mns');
            api.run(`CREATE TABLE ${ns} AS SELECT rowid AS trid, NULL AS clause FROM ${phys} WHERE rowid NOT IN (SELECT trid FROM ${pair})`, at);
            assign(ns, bySource, `${target} AS ${ta}`, `${ta}.rowid = __p.trid`);
        }
        const count = (/** @type {string} */ table) => Number(api.rows(`SELECT COUNT(*) FROM ${table} WHERE clause IS NOT NULL`, at).rows[0][0]);
        if (count(pair) + (nt ? count(nt) : 0) + (ns ? count(ns) : 0) > MAX_MERGE_ROWS) api.fail(`MERGE would change more than ${MAX_MERGE_ROWS.toLocaleString()} rows, which SQL Lab doesn't do in one statement.`, 8623, at);

        // For OUTPUT: the rows as they were, and what happened to each
        /** @type {[string, number | null, number | null, number | null][]} action, old rowid, new rowid, source rowid */
        const actions = [];
        let old = '';
        if (m.output) {
            old = temp('mold');
            api.run(`CREATE TABLE ${old} AS SELECT rowid AS __rid, * FROM ${phys} WHERE rowid IN (SELECT trid FROM ${pair} WHERE clause IS NOT NULL${ns ? ` UNION SELECT trid FROM ${ns} WHERE clause IS NOT NULL` : ''})`, at);
        }

        // Updates and deletes, of matched rows and then of rows only in the target
        for (const [table, list, joinSource] of /** @type {[string, typeof numbered, boolean][]} */ ([[pair, numbered.filter(c => c.match === 'matched'), true], [ns, bySource, false]])) {
            for (const c of list) {
                const from = `${table} AS __p JOIN ${target} AS ${ta} ON ${ta}.rowid = __p.trid${joinSource ? ` JOIN ${src} AS ${sa} ON ${sa}.rowid = __p.srid` : ''}`;
                if (c.action === 'update') {
                    const found = api.rows(api.translate(`SELECT __p.trid, ${joinSource ? '__p.srid' : 'NULL'}${c.sets.map(s => `, ${s.expr}`).join('')} FROM ${from} WHERE __p.clause = ${c.k}`), at).rows;
                    const sql = `UPDATE ${phys} SET ${c.sets.map(s => `${q(s.column)} = ?`).join(', ')} WHERE rowid = ?`;
                    for (const r of found) {
                        affected += api.run(sql, at, [...r.slice(2), r[0]]);
                        actions.push(['UPDATE', r[0], r[0], r[1]]);
                    }
                } else {
                    const found = api.rows(`SELECT __p.trid, ${joinSource ? '__p.srid' : 'NULL'} FROM ${table} AS __p WHERE __p.clause = ${c.k}`, at).rows;
                    for (const r of found) {
                        affected += api.run(`DELETE FROM ${phys} WHERE rowid = ?`, at, [r[0]]);
                        actions.push(['DELETE', r[0], null, r[1]]);
                    }
                }
            }
        }

        // Inserts of source rows the target doesn't have
        const plainColumns = (/** @type {number} */ n) => {
            if (n === targetColumns.length) return targetColumns;
            // Without a column list the IDENTITY (INTEGER PRIMARY KEY) column is left out, as SQL Server does
            const name = phys.replace(/^temp\./i, '').replace(/^main\./i, '');
            const info = api.rows(`SELECT name, type, pk FROM pragma_table_info(?, ${/^temp\./i.test(phys) ? '\'temp\'' : '\'main\''})`, at, [unquote(name)]).rows;
            const rest = info.filter(r => !(Number(r[2]) === 1 && /^INTEGER$/i.test(String(r[1])))).map(r => String(r[0]));
            if (n !== rest.length) api.fail('Column name or number of supplied values does not match table definition.', 213, at);
            return rest;
        };
        for (const c of byTarget) {
            const values = c.values || [];
            const columns = c.values ? (c.columns.length ? c.columns : plainColumns(values.length)) : [];
            const found = api.rows(api.translate(`SELECT __p.srid${values.map(v => `, ${v}`).join('')} FROM ${nt} AS __p JOIN ${src} AS ${sa} ON ${sa}.rowid = __p.srid WHERE __p.clause = ${c.k} ORDER BY __p.srid`), at).rows;
            const sql = c.values
                ? `INSERT INTO ${phys} (${columns.map(q).join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) RETURNING rowid`
                : `INSERT INTO ${phys} DEFAULT VALUES RETURNING rowid`;
            for (const r of found) {
                const back = api.rows(sql, at, r.slice(1)).rows;
                affected++;
                inserted++;
                actions.push(['INSERT', null, back[0] ? Number(back[0][0]) : null, r[0]]);
            }
        }

        if (m.output) {
            const mo = temp('mout');
            api.run(`CREATE TABLE ${mo} (n INTEGER PRIMARY KEY, action TEXT, oldrid INTEGER, newrid INTEGER, srid INTEGER)`, at);
            for (const r of actions) api.run(`INSERT INTO ${mo} (action, oldrid, newrid, srid) VALUES (?, ?, ?, ?)`, at, r);
            const list = m.output.list
                .replace(/\$action\b/gi, '__mo.action AS [$action]')
                .replace(/\b(inserted|deleted)\s*\.\s*\*/gi, (_, side) => targetColumns.map(c => `${side}.${b(c)}`).join(', '));
            const query = `SELECT ${list} FROM ${mo} AS __mo LEFT JOIN ${target} AS inserted ON inserted.rowid = __mo.newrid LEFT JOIN ${old} AS deleted ON deleted.__rid = __mo.oldrid LEFT JOIN ${src} AS ${sa} ON ${sa}.rowid = __mo.srid ORDER BY __mo.n`;
            output = api.rows(api.translate(query), at);
        }
        api.run(`RELEASE ${savepoint}`, at);
    } catch (e) {
        try {
            api.run(`ROLLBACK TO ${savepoint}`, at);
            api.run(`RELEASE ${savepoint}`, at);
        } catch {
            // the savepoint went with a ROLLBACK inside a trigger
        }
        throw e;
    } finally {
        for (const t of temps) api.drop(t);
    }
    return { affected, inserted, output, into: m.output?.into || '', intoColumns: m.output?.intoColumns || '' };
}
