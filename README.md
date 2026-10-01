# SQL Query Builder Pro Lite

Build SQL visually in your browser: SELECT (with joins, nested conditions, subqueries, CTEs, CASE, window functions, grouping and UNION / INTERSECT / EXCEPT), INSERT, UPDATE and DELETE. The output is clean, consistently formatted SQL for Generic SQL, PostgreSQL, MySQL or SQL Server.

It is a static page with no server, no accounts and no analytics. It **never connects to a database or runs queries**, and nothing you type leaves your browser.

**▶ Live app: [sql-builder-saikumar.vercel.app](https://sql-builder-saikumar.vercel.app)**. It is redeployed automatically from `main`.

It comes in four forms, all built from the same code:
- **Website:** any modern browser.
- **Installable web app (PWA):** "Install app" / "Add to Home screen". After the first visit it works offline.
- **Windows app (Microsoft Store):** the PWA packaged with PWABuilder and submitted to the Microsoft Store as "SQL Builder Pro Lite". It updates automatically whenever the website is redeployed. See [MICROSOFT_STORE.md](MICROSOFT_STORE.md).
- **Android app:** packaged with Capacitor. All files are bundled in the app, so it runs fully offline and requests no permissions. See [ANDROID.md](ANDROID.md).

---

## Features

**Query types:** SELECT, INSERT, UPDATE, DELETE.

**INSERT builder**
- Rows from `VALUES` (one or many rows) or from a query (`INSERT INTO … SELECT …`), with the column count checked.
- **Upserts** ("On conflict"): PostgreSQL `ON CONFLICT (…) DO NOTHING` / `DO UPDATE SET …` and MySQL `ON DUPLICATE KEY UPDATE …`. Update values can be the inserted value (`EXCLUDED.col` / `VALUES(col)`), a value, a column/expression or a parameter; "Update all inserted columns" fills them in.
- Numbers with a leading zero (`007`) are flagged, because they are stored as numbers and lose the zero.

**SELECT builder**
- **Window functions** (`… OVER (PARTITION BY … ORDER BY … frame)`):
  - ranking: `ROW_NUMBER`, `RANK`, `DENSE_RANK`, `PERCENT_RANK`, `CUME_DIST`, `NTILE(n)`
  - offset: `LAG` / `LEAD` (with optional offset and default)
  - value: `FIRST_VALUE`, `LAST_VALUE`, `NTH_VALUE`
  - aggregates: `SUM`, `AVG`, `MIN`, `MAX`, `COUNT`
  - frame presets: running total, whole partition, moving N rows
- Columns with aliases, calculated expressions, aggregates (`COUNT`, `COUNT(DISTINCT …)`, `SUM`, `AVG`, `MIN`, `MAX`) and `CASE WHEN … THEN … ELSE … END` columns. Leaving the column of a `COUNT` empty gives `COUNT(*)`.
- `DISTINCT`
- `FROM` a table (with alias or `schema.table`) or a subquery (derived table)
- Any number of joins: `INNER`, `LEFT`, `RIGHT`, `FULL` and `CROSS`. A joined source can be a table or a subquery, and `ON` accepts multiple conditions.
- `WHERE` and `HAVING` built from conditions, **nested AND/OR groups** (parentheses) and `NOT`. Operators:
  - `=`, `!=`, `<>`, `<`, `<=`, `>`, `>=`
  - `LIKE` / `NOT LIKE`
  - `IN` / `NOT IN` (a list or a subquery)
  - `BETWEEN` / `NOT BETWEEN`
  - `IS NULL` / `IS NOT NULL`
  - `EXISTS` / `NOT EXISTS`
  - custom SQL conditions
- `GROUP BY`, `ORDER BY` (multiple columns, ASC/DESC), `LIMIT`, `OFFSET`
- `WITH` (common table expressions) on the main query, with optional column names (`reports (id, name, depth) AS (…)`)
- **Recursive CTEs** for hierarchies such as org charts and category trees: tick **Recursive** on a CTE, give it a starting SELECT and a `UNION ALL` part that joins back to the CTE. It is written as `WITH RECURSIVE`, or plain `WITH` on SQL Server. The checks catch a missing `UNION ALL` part, a starting SELECT that uses the CTE, what each dialect refuses in the recursive part (aggregates everywhere; also `GROUP BY` and `DISTINCT` on SQL Server and MySQL, window functions on MySQL, outer joins and `UNION` without `ALL` on SQL Server, a second recursive part on PostgreSQL), `ORDER BY` / `LIMIT` on the CTE, and a recursive part with no condition to stop it, with the dialect's depth limit (100 levels on SQL Server, 1,000 on MySQL, none on PostgreSQL). A query with a recursive CTE is saved and exported as model version 2; every other query stays version 1, so those files still open in older copies of the app, which refuse a version 2 file instead of misreading it.
- `UNION`, `UNION ALL`, `INTERSECT`, `INTERSECT ALL`, `EXCEPT` and `EXCEPT ALL` with any number of queries. `ORDER BY` / `LIMIT` apply to the combined result. As in SQL, `INTERSECT` binds tighter than `UNION`/`EXCEPT`; a tip points this out when they are mixed.
- Subqueries nest up to 4 levels deep.

**Values vs. expressions:** every condition value is either
- a **Value**, which is quoted and escaped for you: `John` → `'John'`, `O'Brien` → `'O''Brien'`, while numbers stay numbers, `true`/`false` become the dialect's boolean, and `null` becomes `NULL`;
- a **Column / expression**, inserted as written (`o.user_id`, `CURRENT_DATE`); or
- a **Subquery**; or
- a **Parameter** placeholder written in the dialect's style (`:name` / `?`, `$1`, `?`, `@name`), numbered in output order.

Values with a leading zero, such as ZIP codes (`01234`), are quoted as text so the zero is kept.

A custom SQL condition that contains a top-level `AND`/`OR` is wrapped in parentheses when it sits next to other conditions, so it can't change the meaning of the group.

**Output**
- Formatted SQL (one clause per line, 4-space indentation) or a single line, with an optional Wrap toggle for long lines
- **SQL format** (Settings, or the command palette): keywords in UPPERCASE or lowercase; an indent of 4 spaces, 2 spaces or a tab; commas at the end or the start of a line; and an option to put each GROUP BY and ORDER BY item, INSERT column and nested AND / OR group on its own line. A preview in Settings shows the result. The options change only what the builder writes: text typed into a field is never changed. The defaults write exactly the same SQL as before, and every combination writes the same tokens, which the tests check for every example in every dialect.
- Syntax highlighting (including parameter placeholders) and line numbers; the line numbers are never copied
- Live preview while you type (can be switched off)
- **Query structure**: a panel under the SQL that lists the parts of the query in the order a database works through them (for a SELECT: WITH, FROM, JOIN, WHERE, GROUP BY, HAVING, SELECT, UNION, ORDER BY, LIMIT/TOP), each with a one-line explanation. Selecting a step opens that part of the builder. Above the steps, an insights row counts the CTEs, joins, subqueries, combined queries, aggregates, window functions and filters, shows the nesting depth, and gives an overall band: simple, moderate or involved. A one-sentence summary above it says what the query does in plain words (“Returns department and the average salary from employees, where salary is greater than 50000, one row per department, sorted by AVG(salary) descending.”). An **Explain for** switch picks how much each step explains, and is remembered: **Beginner** (what each step does), **Developer** (how LEFT and other joins treat unmatched rows, repeated matches, NULLs in comparisons, NOT IN with a subquery, WHERE vs HAVING, what DISTINCT has to do, a WHERE condition that undoes a LEFT JOIN) and **Advanced** (window frames, including the RANGE default with ORDER BY, set-operation precedence, and the selected dialect's NULL ordering and pagination rules). The insights row describes structure only; it says nothing about speed.
- **Query flow** (inside Query structure, for a SELECT with CTEs, subqueries or UNION parts): one box per part of the query, drawn above the part it feeds, with the main query at the bottom. Each box lists the tables it reads and what it does in order (JOIN, WHERE, GROUP BY, aggregates, HAVING, window functions, DISTINCT, ORDER BY, a row limit); links say how a part is used (CTE, a join, `IN`, `NOT EXISTS`, `UNION ALL` …). A recursive CTE's repeating part says so instead of linking to itself, and a CTE nothing uses says that too. The parts are listed as text under the drawing; selecting one opens that part in the builder, including sections it sits inside.
- **Tables and joins diagram** (inside Query structure, for a SELECT with joins): the main query's tables, CTEs and derived tables as boxes, with a link for each join drawn from its ON condition and labeled with the join type. With a schema, boxes mark key columns (PK, FK), links that follow a foreign key are highlighted, and each link says whether a row can match one row or many (“many : many” is highlighted, since rows can repeat). A join whose ON names no earlier table, and a CROSS JOIN, are drawn dashed. The same links are listed as text under the drawing; selecting one opens that join. Both drawings are made on the device as SVG with no layout library; a link that skips a row passes between boxes, and a wide drawing scrolls sideways.
- **Compare dialects** (Compare… next to the dialect picker, or the command palette): the current query as the selected dialect writes it next to another dialect's SQL, with each difference listed by line (“LIMIT 20 OFFSET 40” becomes “OFFSET 40 ROWS FETCH NEXT 20 ROWS ONLY”, TRUE becomes 1, `$1` becomes `?`) and the checks the other dialect would add, such as an upsert SQL Server can't express or `GETDATE()` in PostgreSQL. Nothing changes unless you choose Switch.
- Copy, Select all, Download `.sql`. On Android, Download and Export open the share sheet so you can save to Files or Drive, or send to another app. A Share button shares the SQL text.

**Checks:** the checks panel shows four kinds of message:
- **Errors** (block generation): missing fields, ORDER BY in a subquery without TOP/LIMIT on SQL Server, LIMIT inside an `IN` subquery on MySQL, INSERT … SELECT column-count mismatches, upserts the dialect doesn't support, invalid names or aliases, unbalanced quotes or parentheses, a join without a condition, column-count mismatches between combined queries, INSERT value/column mismatches, wrong window-function arguments, a window result used in WHERE/HAVING, operators or functions the dialect lacks, …
- **Warnings** (never block):
  - UPDATE or DELETE without WHERE
  - columns missing from GROUP BY
  - `= NULL`
  - duplicate column names
  - unquoted text in INSERT values
  - ranking window functions without ORDER BY (an error on SQL Server)
  - reserved words used as table, alias or column names without identifier quoting
  - a SELECT alias used in HAVING (except MySQL, which accepts it)
  - leading-zero numbers in INSERT values
  - an upsert that updates from an inserted value for a column the INSERT doesn't list
  - conditions that can never both be true (`price > 50 AND price < 10`, `status = 'paid' AND status = 'void'`), and `BETWEEN 50 AND 10`
  - a join whose ON condition mentions only the joined table, or only the tables before it
  - functions, operators and name quoting typed in an expression, custom condition or value that the selected dialect doesn't have, with the usual replacement: `GETDATE()` in PostgreSQL (use `CURRENT_TIMESTAMP`), `NOW()` on SQL Server, `ISNULL(a, b)` or `IFNULL` outside their dialect (use `COALESCE`), `ILIKE`, `::` casts, `LEN`/`LENGTH`, `CHARINDEX`, `DATEADD`/`DATE_ADD`, `DATEDIFF` with the other dialect's arguments, `GROUP_CONCAT`/`STRING_AGG`, `IIF`/`IF`, `NEWID`/`UUID`, `` `name` `` and `[name]` quoting, and more. Typed text is flagged, never rewritten. With Generic SQL these are tips instead, saying which database the syntax comes from.
- **Suggestions** (never block): valid SQL that could be clearer: a plain `SELECT *` on the main query, DISTINCT that GROUP BY already makes redundant, a condition repeated in the same group, a table alias that is never used, and subqueries nested three or more levels deep. The analysis rules are deliberately conservative: when a condition can't be read with certainty (custom SQL, parameters, unqualified column names, text that some databases compare case-insensitively or as dates), they stay silent rather than guess.
- **Tips**, e.g. LIMIT without ORDER BY, LIKE without a wildcard, INTERSECT precedence, ORDER BY in a subquery (the database may ignore it), parameter names the dialect ignores, or syntax that needs a later version (`STRING_AGG` needs SQL Server 2017).

Messages are listed errors first, then warnings, then tips. On narrower screens the bottom bar's View SQL button shows the number of errors and warnings.

"Go to field" jumps to the problem.

**Workspace**
- **History** of generated queries: search, restore, copy, delete, clear. It keeps the last 50, and can be turned off.
- **Save** (button above the SQL, or Ctrl/⌘+S): the first save names the query as a template; after that, and after loading a template, Save updates that template in place. The template's name is shown above the SQL, with "unsaved changes" when the query or dialect differs from what was saved. Loading an example, restoring history, importing or Reset all start a new unsaved query.
- **Templates**: save, load, rename, duplicate, delete, and import/export as JSON. Each template can have a description and a category, and the list can be searched (name, description, category, dialect), filtered by dialect and sorted by name or most recently updated. Pin a template to keep it at the top; the template you are editing is marked "Editing". Pins are kept in exports. A template remembers its dialect and switches to it when loaded (restoring history does the same).
- **Practice** (a library tab): 15 exercises from Beginner to Advanced over a small shop and staff schema, covering filtering, joins, aggregation, subqueries and CTEs (one recursive), window functions, UPDATE and DELETE. Starting one opens it above the builder with its goal and tables, and starts an empty query (Undo brings back the previous one). **Check my query** lists which parts of the goal the query has, each with a hint when it doesn't, and keeps the list up to date while you edit. Hints come one at a time, and the model answer is shown in the selected dialect and can be loaded into the builder. The checks look at how the query is built (tables read, joins and which side keeps its rows, conditions every row must meet, grouping, sorting, limits, window functions, CTEs, subqueries), never at results: the app doesn't run SQL. They accept the usual variations (aliases, quoted names, `COUNT(*)` or `COUNT(id)`, `ORDER BY` an alias or a column number, `NOT EXISTS` or `LEFT JOIN … IS NULL`); a correct query written another way can still miss a check, so the panel says so. "Add the practice tables to my schema" adds the six tables for suggestions and the JOIN assistant, leaving any table with the same name as it is. Which exercises are done is kept in this browser (not in backups); a pass after loading the model answer doesn't count.
- **Examples**: twenty-seven starter queries, each tagged Beginner, Intermediate or Advanced and with a topic (filtering, joins, aggregation, window functions and more). They are filtered to the selected dialect and can be filtered by topic (the upsert example only exists for PostgreSQL and MySQL). Each one shows a one-line preview of the SQL it produces in that dialect.
- Import/export of the current query as JSON (validated, never executed), and download of the SQL. An exported query remembers its dialect, and importing it switches back to that dialect.
- **Schema** (Schema tab): describe your tables once and keep them in this browser. Add or edit a table as a `CREATE TABLE` statement (types are optional), or import many at once by pasting or choosing a `.sql` file (pg_dump, mysqldump and SQL Server "Script Table as" output work) or a schema `.json` file. The import shows what it found, which statements it skipped (indexes, functions, `SET`, …) and any lines it couldn't read, before anything is saved. Primary keys, unique keys and foreign keys (inline `REFERENCES` or `ALTER TABLE … ADD CONSTRAINT`) are kept. Tables and columns can be searched, and the schema can be exported as JSON or as `CREATE TABLE` statements. The SQL you paste is only read, never run, and the schema doesn't change the SQL the builder generates. Limits: 500 tables, 500 columns per table.
- **Suggestions** (once the schema has tables): table fields list your tables and the query's CTEs; column and expression fields (columns, conditions, JOIN ON, GROUP BY, ORDER BY, CASE, window functions, SET) list the columns of the tables in that query, qualified with the alias when there are several, plus a few common functions for the selected dialect. Typing `e.` lists the columns of alias `e`. A subquery in WHERE also sees the outer query's tables; a derived table or CTE shows the columns it selects. ↓ (or Alt+↓) opens the list, ↑/↓ move, Enter or a tap puts the suggestion in the field, Esc or Tab closes it. Nothing is picked unless you choose it, and names that need quotes are quoted for the dialect. Without a schema, fields work exactly as before.
- **JOIN assistant** (with a schema): when a joined table and the tables before it are in the schema, the ON section offers the conditions their foreign keys imply, in either direction ("Use e.department_id = d.id"); one tap fills ON, and Undo takes it back. Checks then adds, without ever blocking generation:
  - a tip when ON doesn't use the schema's link, or when no foreign key links the tables (only if the schema has foreign keys at all);
  - a warning when the joined columns aren't a primary or unique key on either side, so rows can repeat;
  - tips for table and column names that aren't in the schema (qualified names always; unqualified ones only when every table in scope is known).
- **Import SQL** (File → Import SQL, or the command palette): paste a SELECT, INSERT, UPDATE or DELETE statement, choose a `.sql` file, or drop one on the dialog, and edit it in the builder. The dialect is guessed from syntax only one dialect uses (backquotes, `[brackets]`, `TOP`, `$1`, `::`…) and can be picked by hand. Before anything changes, the dialog shows either where the SQL can't be imported (“Line 7, column 3: JOIN … USING isn't supported yet”) or a round-trip check: the SQL the builder will write is compared with yours, ignoring layout, comments, keyword case and optional words (AS, INNER, OUTER, ASC), and every remaining difference is listed by line (for example MySQL's `LIMIT 10, 20` becomes `LIMIT 20 OFFSET 10`, and `a AND b OR c` gains parentheses that keep its meaning). Import replaces only the query of the same type (your drafts of the other types stay), switches to the SQL's dialect, and Undo brings the previous query back. For SELECT it reads CTEs (with column names, and `WITH RECURSIVE`; on SQL Server a CTE that uses its own name is read as recursive), DISTINCT, TOP, aggregates, CASE and window columns (when the builder can write them the same way), all five join types with ON, WHERE / HAVING with AND / OR groups and every builder operator, GROUP BY, UNION / INTERSECT / EXCEPT, ORDER BY, LIMIT / OFFSET / FETCH, parameters in each dialect's style, and subqueries in FROM, JOIN and conditions. INSERT reads a column list with VALUES rows or a SELECT, plus PostgreSQL `ON CONFLICT … DO NOTHING / DO UPDATE` and MySQL `ON DUPLICATE KEY UPDATE` (`EXCLUDED.col` / `VALUES(col)` become “the value this row tried to insert”); UPDATE reads SET and WHERE; DELETE reads FROM and WHERE. Expressions are kept word for word; conditions the builder has no operator for (ILIKE, `= ANY (…)`, …) become custom SQL conditions. Values become plain values only when the builder writes them back identically (`'John'` → John, `'042'` → 042).
- **Full backup** (File → Back up everything / Restore from backup…): one JSON file (`sql-builder-backup`, version 2) with all templates (including pins and dates), history, the schema and settings. Version 1 backups still restore. Restoring validates every field first and asks how to restore: **Merge** (default) adds the templates, history and schema tables that aren't here yet and skips exact copies (a table already here keeps your version), keeping your settings; **Replace** asks for confirmation, then swaps templates, history, schema and settings for the backup's (a version 1 backup leaves the schema as it is). History isn't restored while saving history is turned off. A backup never contains anything that leaves your device unless you move the file yourself.
- Undo / redo of every change.
- **Command palette** (Ctrl/⌘+K, or File → Commands… on touch screens): search and run commands such as Generate, Copy, Save, switching the query type, dialect, output format or theme, opening the library tabs, import/export and settings. It only lists commands that apply right now and runs the same actions as the buttons.
- Unsaved work is restored when you come back; this can be turned off.
- Settings: dialect (also next to the SQL heading), identifier quoting, live preview, history, session restore, theme, and delete all saved data.
- Light / Dark / System theme.

## SQL dialects

Four dialects are supported: **Generic SQL** (the default), **Microsoft SQL Server**, **PostgreSQL** and **MySQL** (8.0.31 or later is assumed). Pick one with the **Dialect** menu next to the SQL heading, above the generated SQL (or in Settings). The query itself is kept when you switch: only the generated SQL and the checks change, and a message says how many parts of the query the new dialect can't express.

All four dialects share one query model, generator and validator. Everything that differs is described once per dialect in `src/dialects.js` as settings and capability flags (for example `supports.fullJoin` or `restrictions.rankingNeedsOrderBy`), and a test makes sure the generator, validator and UI never check which dialect is selected.

When a dialect can't express something, the builder keeps it rather than deleting it:
- menu options it lacks stay visible, labelled for example "FULL JOIN (not in MySQL)";
- choosing one is reported in Checks as an error, and no SQL is generated until it's changed;
- the row-limit field is called **TOP** on SQL Server, and on Generic and SQL Server the INSERT builder shows a short note instead of the upsert options (an upsert that is already set up stays visible, with its error).

What changes per dialect:

| | Generic | SQL Server | PostgreSQL | MySQL |
|---|---|---|---|---|
| Quoted identifiers (optional setting) | `"name"` | `[name]` | `"name"` | `` `name` `` |
| Text values | `'it''s'` | `'it''s'` | `'it''s'` | `'it''s'`, backslashes doubled |
| Booleans (Value fields) | `TRUE` / `FALSE` | `1` / `0` | `TRUE` / `FALSE` | `TRUE` / `FALSE` |
| `TRUE` / `FALSE` typed into an expression | ✓ | warning: write `1` / `0` | ✓ | ✓ |
| Row limit only | `LIMIT n` | `SELECT TOP n` | `LIMIT n` | `LIMIT n` |
| Limit and offset | `LIMIT n OFFSET m` | `OFFSET m ROWS FETCH NEXT n ROWS ONLY` | `LIMIT n OFFSET m` | `LIMIT n OFFSET m` |
| Offset only | `OFFSET m` | `OFFSET m ROWS` | `OFFSET m` | `LIMIT 18446744073709551615 OFFSET m` |
| Limit with UNION / INTERSECT / EXCEPT | `LIMIT n` | `OFFSET 0 ROWS FETCH NEXT n ROWS ONLY` | `LIMIT n` | `LIMIT n` |
| OFFSET without ORDER BY | tip | `ORDER BY (SELECT NULL)` is added, with a note | tip | tip |
| FULL JOIN | ✓ | ✓ | ✓ | error |
| UNION / INTERSECT / EXCEPT | ✓ (+ `ALL`) | ✓ (no `INTERSECT ALL` / `EXCEPT ALL`) | ✓ (+ `ALL`) | ✓ (+ `ALL`); INTERSECT / EXCEPT need 8.0.31 (tip) |
| NTH_VALUE | ✓ | error | ✓ | ✓ |
| Ranking, LAG / LEAD, NTILE without ORDER BY in OVER | warning | error | warning | warning |
| FIRST_VALUE / LAST_VALUE without ORDER BY in OVER | allowed | error | allowed | allowed |
| Window frame without ORDER BY in OVER | warning | error | warning | warning |
| Parameter placeholders | `:name`, or `?` if unnamed | `@name`, or `@p1`, `@p2`, … | `$1`, `$2`, … (names ignored, tip shown) | `?` (names ignored, tip shown) |
| Upsert | not available | not available (`MERGE` isn't generated) | `ON CONFLICT (…) DO NOTHING` / `DO UPDATE SET …`, inserted value `EXCLUDED.col` | `ON DUPLICATE KEY UPDATE …`, inserted value `VALUES(col)` (tip: deprecated from 8.0.20) |
| ORDER BY in a subquery or CTE | tip | error unless TOP or OFFSET is set | tip | tip |
| Recursive CTE keyword | `WITH RECURSIVE` | `WITH` | `WITH RECURSIVE` | `WITH RECURSIVE` |
| Recursive CTE: refused in the recursive part | aggregates, window functions | aggregates, `GROUP BY`, `DISTINCT`, outer joins; `UNION` must be `UNION ALL` | aggregates; only one recursive part | aggregates, window functions, `GROUP BY`, `DISTINCT` |
| Recursive CTE: ORDER BY / row limit on it | warning | error | error | ORDER BY error, LIMIT ✓ |
| LIMIT in an `IN (subquery)` | ✓ | ✓ (`TOP`) | ✓ | error |
| SELECT alias in HAVING | warning | warning | warning | accepted |

Everything else (joins, WHERE, GROUP BY, CTEs, CASE, INSERT … SELECT, UPDATE, DELETE, the other window functions and frames) is written the same way in every dialect.

Not built for any dialect yet: `RETURNING` / `OUTPUT` and `MERGE`. The builder doesn't add SQL Server's `OPTION (MAXRECURSION n)` or change MySQL's `cte_max_recursion_depth`. Functions and data types you type (date/time functions, casts, …) are not translated between dialects: expressions are passed through unchanged, and the only check on them is the `TRUE` / `FALSE` warning on SQL Server. The app never connects to a database, so it can't check a specific server version or schema.

## Example

```sql
SELECT
    Name,
    Salary
FROM Employees
WHERE Salary > 50000
ORDER BY Salary DESC
LIMIT 10;
```

A single column stays on the `SELECT` line (`SELECT * FROM …`); two or more are listed one per line. Output is deterministic: the same query always produces the same text.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl`/`⌘` + `Enter` | Generate SQL (and add it to history) |
| `Ctrl`/`⌘` + `Shift` + `C` | Copy SQL. Some browsers reserve this shortcut for their developer tools; the Copy button always works. |
| `Ctrl`/`⌘` + `S` | Save the query (updates the template it was loaded from, or asks for a name) |
| `Ctrl`/`⌘` + `K` | Command palette: type to find any command (also File → Commands…) |
| `Ctrl`/`⌘` + `Z` | Undo, when focus is not in a text field (text fields keep the browser's own undo) |
| `Ctrl`/`⌘` + `Shift` + `Z` (or `Ctrl` + `Y`) | Redo, outside text fields |
| `?` | Show shortcuts |
| `↓` | In a table or column field, show suggestions from your schema |
| `Esc` | Close suggestions, dialogs and menus |

## Using it

**Online:** [sql-builder-saikumar.vercel.app](https://sql-builder-saikumar.vercel.app).

**Locally:** open `index.html` in a browser. Opening it straight from disk (`file://`) works too, because the app ships as one prebuilt script (`dist/sqlbuilder.js`).

```bash
npm ci            # dev tooling only
npm run dev       # http://localhost:3000
```

**Offline / install (PWA):** the site has a web app manifest and a service worker (`sw.js`).
- After one online visit, the page, stylesheet and script are cached and the app opens without a connection.
- Pages are fetched network-first, so a new deployment shows up on the next online visit.
- The versioned assets are cache-first.
- The service worker only runs over `https` or on `localhost`; from `file://` the app simply works without it.

**Windows:** install it from the Microsoft Store once it's published, or install the PWA from Edge or Chrome (address bar → *Install*). It is packaged with PWABuilder; see [MICROSOFT_STORE.md](MICROSOFT_STORE.md).

**Android:** install an APK built from this repository ([ANDROID.md](ANDROID.md)). It is not published on Google Play; the signing setup and [PLAY_STORE_RELEASE_CHECKLIST.md](PLAY_STORE_RELEASE_CHECKLIST.md) are kept in case that changes.

## Development

Requires Node.js 22.22+ (or 24.15+).

```bash
npm test            # unit + UI tests (Vitest, jsdom)
npm run lint        # ESLint
npm run typecheck   # TypeScript checkJs over src/
npm run build       # bundle src/ → dist/sqlbuilder.js (esbuild), then version asset URLs in index.html
npm run check       # all of the above; CI runs the same and fails if dist/ is stale

npm run cap:sync        # Android: build www/ (native bundle) and sync it into android/
npm run android:debug   # Android debug APK   (needs JDK 21 + Android SDK 36)
npm run android:bundle  # Android release AAB (signing: ANDROID.md → Release signing)
```

Source is plain ES modules in `src/`. The committed `dist/sqlbuilder.js` is what the page loads; **run `npm run build` and commit `dist/` and `index.html` after changing `src/` or `style.css`**. The build appends a content hash to the asset URLs (`style.css?v=…`, `dist/sqlbuilder.js?v=…`, via `scripts/stamp-assets.mjs`), so browsers always fetch changed files instead of reusing an old cached copy.

## Architecture

```
src/
├── model.js          Query model: plain JSON objects + factories + path helpers
├── generator.js      model → SQL (formatted or one line, with format options), no string post-processing
├── dialects.js       Every dialect difference: writing rules plus supports/restrictions flags
├── validation.js     model → issues { level, category, message, path }
├── analysis.js       Analysis rules (contradictions, unlinked joins, unused aliases, …) and query insights
├── dialect-functions.js  Dialect-specific functions, operators and quoting found in typed SQL
├── dialect-compare.js    The current query written for two dialects, and what differs
├── explain.js        Developer / Advanced explanation notes and the one-sentence summary
├── structure.js      model → the query's steps in processing order, with explanations
├── sql-utils.js      Quote/paren-aware splitting and balance checks (not a SQL parser)
├── tokenizer.js      Highlighting tokens (no HTML)
├── serialization.js  JSON import/export; rebuilds untrusted input field by field
├── schema.js         Schema model (tables, columns, keys), validation, storage, CREATE TABLE output
├── ddl.js            Reads CREATE TABLE / ALTER TABLE … ADD text into schema tables (never runs it)
├── sql-lexer.js      SQL tokens with positions, for reading pasted DDL and imported SQL
├── sql-import.js     Reads a SELECT into the model (recursive descent; refuses with line and column)
├── roundtrip.js      Compares imported SQL with the builder's SQL, token by token
├── diagram.js        Tables and joins diagram, and the shared box-and-link layout (no DOM)
├── flow.js           Query flow: which part of a SELECT feeds which (no DOM)
├── exercises.js      Practice exercises, their checks, hints, model answers and tables
├── practice.js       Checks a query against an exercise by its structure; practice progress
├── suggest.js        Which tables/columns a builder field can use (scope, aliases, CTEs)
├── joins.js          JOIN assistant (ON from foreign keys) and schema checks (tips/warnings)
├── storage.js        Guarded localStorage wrapper
├── settings.js / history.js / templates.js / undo.js / examples.js
├── app.js            Controller: state, events, rendering pipeline
├── main.js           Website entry point (bundled to dist/; registers the service worker)
├── main.native.js    Android entry point (bundled to www/ by scripts/build-mobile.mjs)
├── platform/         web.js / native.js: clipboard, file export, share, back button, system bars
└── ui/
    ├── builder.js    Renders the editor from the model (recursive for subqueries)
    ├── output.js     SQL view with tokens and line numbers
    ├── library.js    History / Templates / Examples / Schema lists
    ├── dialogs.js    Native <dialog> helpers
    ├── palette.js    Command palette (filtering + combobox dialog)
    ├── suggest.js    Suggestion list under builder fields (ARIA combobox)
    ├── sql-import.js Import SQL dialog preview (check result and differences)
    ├── compare.js    Compare dialects dialog (differences, checks, both SQLs)
    ├── diagram.js    Draws the tables and joins diagram and the query flow as SVG, with their lists
    ├── practice.js   The Practice tab's list and the open exercise above the builder
    ├── theme.js, shortcuts.js, dom.js (safe element builder)
```

Design decisions:
- **One structured model.** The builder, generator, validator, history, templates, import/export and undo all operate on the same JSON model. The only place SQL text is read back is Import SQL, which turns it into that model once and proves the result with a round-trip check. New constructs are added as a model field, a generator branch, a validation rule and an editor control. Window functions and `INTERSECT`/`EXCEPT` were added exactly this way.
- **Formatting happens during generation.** The generator emits `[indent, text]` lines and pretty-prints or joins them, so user values are never reformatted.
- **No framework.** Rendering uses a ~30-line `h()` helper with `textContent`/`setAttribute`; there is no `innerHTML`. Events are delegated: inputs carry `data-path` (their location in the model) and buttons carry `data-action`.
- **Bundled classic script.** ES modules can't load from `file://`, so esbuild bundles them into one IIFE. The only runtime dependency is the browser.
- **Platform adapter.** The few things that differ between browser and Android (clipboard, saving files, share, back button, status-bar colour, splash) go through a `platform` object passed to `startApp()`. The SQL core has no platform code, and the website bundle contains no Capacitor code (a test checks this). An iOS target can reuse the same adapter.

## Accessibility

- Semantic landmarks, headings and a skip link. Every control has a visible label or an `aria-label`, and a test enforces this.
- Everything is reachable by keyboard: native `<details>` sections, native modal `<dialog>`s (focus contained, Esc closes, focus returns), a radio-group query-type switch, and library tabs following the ARIA tabs pattern (arrow keys, Home/End).
- Focus moves into newly added rows and back to the Add button after a remove.
- Invalid fields get `aria-invalid` and are linked with `aria-describedby` to their message. Status messages use a polite live region.
- Visible focus rings, and WCAG AA contrast for every text/background token pair in both themes (checked by script during development).
- `prefers-reduced-motion` and `prefers-color-scheme` are respected.

## Security and privacy

See [SECURITY.md](SECURITY.md). In short:
- No network requests are made with your data.
- User input is rendered as text only.
- Imported JSON and pasted SQL are validated and never executed.
- Storage is limited to this browser, and you can delete it from Settings.
- The deployment sends a strict Content-Security-Policy. The Android app embeds an equivalent CSP.
- The Android app requests no permissions, has no analytics or ads, and never loads remote content. See [PRIVACY.md](PRIVACY.md).
- The Windows (Microsoft Store) app is the same PWA, so it gets the same headers and CSP as the website.

## Browser support

Current versions of Chrome, Edge, Firefox and Safari. Minimums, set by `structuredClone` and `<dialog>`: Chrome/Edge 98, Firefox 98, Safari 15.4.

Android: 7.0 (API 24) or later with Android System WebView 98+, which updates through Google Play. An older WebView gets a "please update" message instead of a blank screen.

## Deployment

The site is static: `index.html`, `style.css`, `dist/`, plus the PWA files `manifest.webmanifest`, `sw.js` and `icons/`. There's no build step on the server.
- **Vercel:** import the repository, or run `npm run deploy` (`npx vercel --prod`).
  - `vercel.json` sets the security headers and `Cache-Control: max-age=0, must-revalidate`, because file names aren't content-hashed.
  - `.vercelignore` publishes only the app files; `Fabric_Sync/`, sources and tests are not served.
- **Any static host:** upload `index.html`, `style.css`, `dist/`, `manifest.webmanifest`, `sw.js` and `icons/`.
- **Microsoft Store (Windows):** package the live URL with PWABuilder and submit it in Partner Center, following [MICROSOFT_STORE.md](MICROSOFT_STORE.md). Website deployments reach the installed app automatically; re-package only when the name, icons or manifest scope change.
- **Android:** see [ANDROID.md](ANDROID.md) (build, signing) and [PLAY_STORE_RELEASE_CHECKLIST.md](PLAY_STORE_RELEASE_CHECKLIST.md).

## Project structure

```
index.html  style.css  dist/sqlbuilder.js(.map)   ← the app
manifest.webmanifest  sw.js  icons/               ← PWA (install + offline)
capacitor.config.json  android/                   ← Android app (Capacitor); www/ is generated
scripts/                                          ← asset stamping, mobile build, icon generator, Android E2E
store/windows/                                    ← Microsoft Store screenshots, poster art and box art
store/  resources/                                ← Play Store graphics, master icon
src/                                              ← sources (see Architecture)
tests/                                            ← Vitest: unit, UI (jsdom) and bundle tests
vercel.json  .vercelignore                        ← deployment
eslint.config.js  jsconfig.json  package.json     ← tooling
.github/workflows/ci.yml                          ← lint, typecheck, tests, bundle freshness
.github/workflows/android.yml                     ← APK/AAB build, Android lint, emulator E2E
.github/workflows/android-release.yml             ← manual: Play-upload AAB signed with the upload key
Fabric_Sync/                                      ← unrelated Power BI content (not deployed)
```

## Limitations

- **Not a SQL parser.** Expressions you type (columns, custom conditions, CASE parts, INSERT values) are inserted as written. Validation only checks balanced quotes and parentheses and rejects `;` and `--`. It cannot tell whether a column exists or a function is valid.
- Import SQL reads one statement. INSERT with `DEFAULT VALUES`, `SET`, `IGNORE` or `RETURNING`; UPDATE with an alias, `FROM`, several tables, `ORDER BY`/`LIMIT` or `OUTPUT`; DELETE with `USING`, a join or an alias; any statement after `WITH`; and SELECTs using `DISTINCT ON`, `USING`, `NATURAL` or `LATERAL` joins, `APPLY`, comma-separated FROM tables, table functions or hints, `MATERIALIZED` CTEs, `NULLS FIRST/LAST`, `WITH ROLLUP`, named windows, parenthesized UNION parts, `FOR UPDATE`, `RETURNING` or a SELECT without FROM, are refused with their location. Comments aren't kept, PostgreSQL parameter names can't be recovered from `$1`, and a CASE or window column the builder can't write the same way stays a plain expression.
- Schema checks look at plain column references only (`e.name`, `name`); names inside expressions such as `UPPER(e.nmae)` aren't checked. Columns of CTEs and derived tables are known only when they are plain columns or have an alias.
- Suggestions come from the saved schema and what the query selects; a column produced by an expression without an alias has no name to suggest.
- CTEs are only allowed on the main query (Import SQL refuses a WITH inside a subquery). A recursive CTE's column types aren't checked; the Advanced explanation says what each dialect expects.
- INSERT values are SQL expressions: write text in quotes. A warning flags likely unquoted text.
- GROUP BY checking is a heuristic: it compares expressions textually and can't know about functional dependencies.
- Dialect support covers only the differences listed in [SQL dialects](#sql-dialects).
- Reserved-word warnings use a short curated list, not each database's full keyword list.
- Upserts cover PostgreSQL and MySQL only; SQL Server `MERGE` is not generated.
- MySQL's backslash handling inside `LIKE` patterns is not special-cased.
- Window frames are limited to three `ROWS` presets.
- MySQL's minimum versions (8.0 for window functions, 8.0.31 for INTERSECT/EXCEPT) aren't enforced; they're shown only as notes and tips.

## Roadmap

Candidates, in rough priority order:
- SQL Server `MERGE`, and `RETURNING` / `OUTPUT`
- More window options: named `WINDOW` clauses, `RANGE`/`GROUPS` frames and custom frame bounds

## License

MIT
