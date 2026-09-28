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
- `WITH` (common table expressions) on the main query
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
- Syntax highlighting (including parameter placeholders) and line numbers; the line numbers are never copied
- Live preview while you type (can be switched off)
- **Query structure**: a panel under the SQL that lists the parts of the query in the order a database works through them (for a SELECT: WITH, FROM, JOIN, WHERE, GROUP BY, HAVING, SELECT, UNION, ORDER BY, LIMIT/TOP), each with a one-line explanation. Selecting a step opens that part of the builder. It describes structure only; it says nothing about speed.
- Copy, Select all, Download `.sql`. On Android, Download and Export open the share sheet so you can save to Files or Drive, or send to another app. A Share button shares the SQL text.

**Checks:** the checks panel shows three kinds of message:
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
- **Tips**, e.g. LIMIT without ORDER BY, LIKE without a wildcard, INTERSECT precedence, ORDER BY in a subquery (the database may ignore it), or parameter names the dialect ignores.

Messages are listed errors first, then warnings, then tips. On narrower screens the bottom bar's View SQL button shows the number of errors and warnings.

"Go to field" jumps to the problem.

**Workspace**
- **History** of generated queries: search, restore, copy, delete, clear. It keeps the last 50, and can be turned off.
- **Save** (button above the SQL, or Ctrl/⌘+S): the first save names the query as a template; after that, and after loading a template, Save updates that template in place. The template's name is shown above the SQL, with "unsaved changes" when the query or dialect differs from what was saved. Loading an example, restoring history, importing or Reset all start a new unsaved query.
- **Templates**: save, load, rename, duplicate, delete, and import/export as JSON. Each template can have a description and a category, and the list can be searched (name, description, category, dialect), filtered by dialect and sorted by name or most recently updated. Pin a template to keep it at the top; the template you are editing is marked "Editing". Pins are kept in exports. A template remembers its dialect and switches to it when loaded (restoring history does the same).
- **Examples**: twenty-two starter queries, each tagged Beginner, Intermediate or Advanced and with a topic (filtering, joins, aggregation, window functions and more). They are filtered to the selected dialect and can be filtered by topic (the upsert example only exists for PostgreSQL and MySQL). Each one shows a one-line preview of the SQL it produces in that dialect.
- Import/export of the current query as JSON (validated, never executed), and download of the SQL. An exported query remembers its dialect, and importing it switches back to that dialect.
- **Full backup** (File → Back up everything / Restore from backup…): one JSON file (`sql-builder-backup`, version 1) with all templates (including pins and dates), history and settings. Restoring validates every field first and asks how to restore: **Merge** (default) adds the templates and history that aren't here yet and skips exact copies, keeping your settings; **Replace** asks for confirmation, then swaps templates, history and settings for the backup's. History isn't restored while saving history is turned off. A backup never contains anything that leaves your device unless you move the file yourself.
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
| LIMIT in an `IN (subquery)` | ✓ | ✓ (`TOP`) | ✓ | error |
| SELECT alias in HAVING | warning | warning | warning | accepted |

Everything else (joins, WHERE, GROUP BY, CTEs, CASE, INSERT … SELECT, UPDATE, DELETE, the other window functions and frames) is written the same way in every dialect.

Not built for any dialect yet: `RETURNING` / `OUTPUT`, `MERGE` and recursive CTEs. Functions and data types you type (date/time functions, casts, …) are not translated between dialects: expressions are passed through unchanged, and the only check on them is the `TRUE` / `FALSE` warning on SQL Server. The app never connects to a database, so it can't check a specific server version or schema.

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
| `Esc` | Close dialogs and menus |

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
├── generator.js      model → SQL (formatted or one line), no string post-processing
├── dialects.js       Every dialect difference: writing rules plus supports/restrictions flags
├── validation.js     model → issues { level, category, message, path }
├── structure.js      model → the query's steps in processing order, with explanations
├── sql-utils.js      Quote/paren-aware splitting and balance checks (not a SQL parser)
├── tokenizer.js      Highlighting tokens (no HTML)
├── serialization.js  JSON import/export; rebuilds untrusted input field by field
├── storage.js        Guarded localStorage wrapper
├── settings.js / history.js / templates.js / undo.js / examples.js
├── app.js            Controller: state, events, rendering pipeline
├── main.js           Website entry point (bundled to dist/; registers the service worker)
├── main.native.js    Android entry point (bundled to www/ by scripts/build-mobile.mjs)
├── platform/         web.js / native.js: clipboard, file export, share, back button, system bars
└── ui/
    ├── builder.js    Renders the editor from the model (recursive for subqueries)
    ├── output.js     SQL view with tokens and line numbers
    ├── library.js    History / Templates / Examples lists
    ├── dialogs.js    Native <dialog> helpers
    ├── palette.js    Command palette (filtering + combobox dialog)
    ├── theme.js, shortcuts.js, dom.js (safe element builder)
```

Design decisions:
- **One structured model.** The builder, generator, validator, history, templates, import/export and undo all operate on the same JSON model, so SQL is never parsed back from text. New constructs are added as a model field, a generator branch, a validation rule and an editor control. Window functions and `INTERSECT`/`EXCEPT` were added exactly this way.
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
- Imported JSON is validated and never executed.
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
- You can't paste SQL in to edit it; queries are built with the builder or imported as JSON.
- CTEs are only allowed on the main query, and recursive CTEs aren't supported.
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
- Recursive CTEs
- More window options: named `WINDOW` clauses, `RANGE`/`GROUPS` frames and custom frame bounds
- Optional schema hints (known tables/columns) for autocomplete and validation

## License

MIT
