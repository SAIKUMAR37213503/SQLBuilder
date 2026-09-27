# SQL Query Builder Pro Lite

Build SQL visually in your browser: SELECT (with joins, nested conditions, subqueries, CTEs, CASE, window functions, grouping and UNION / INTERSECT / EXCEPT), INSERT, UPDATE and DELETE. The output is clean, consistently formatted SQL for Generic SQL, PostgreSQL, MySQL or SQL Server.

It is a static page with no server, no accounts and no analytics. It **never connects to a database or runs queries**, and nothing you type leaves your browser.

**▶ Live app: [sql-builder-saikumar.vercel.app](https://sql-builder-saikumar.vercel.app)**. It is redeployed automatically from `main`.

It comes in three forms, all built from the same code:
- **Website:** any modern browser.
- **Installable web app (PWA):** "Install app" / "Add to Home screen". After the first visit it works offline.
- **Android app:** packaged with Capacitor. All files are bundled in the app, so it runs fully offline and requests no permissions. See [ANDROID.md](ANDROID.md).

---

## Features

**Query types:** SELECT, INSERT (one or many rows), UPDATE, DELETE.

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
- a **Subquery**.

**Output**
- Formatted SQL (one clause per line, 4-space indentation) or a single line
- Syntax highlighting and line numbers; the line numbers are never copied
- Live preview while you type (can be switched off)
- Copy, Select all, Download `.sql`. On Android, Download and Export open the share sheet so you can save to Files or Drive, or send to another app. A Share button shares the SQL text.

**Checks:** the checks panel shows three kinds of message:
- **Errors** (block generation): missing fields, invalid names or aliases, unbalanced quotes or parentheses, a join without a condition, column-count mismatches between combined queries, INSERT value/column mismatches, wrong window-function arguments, a window result used in WHERE/HAVING, operators or functions the dialect lacks, …
- **Warnings** (never block):
  - UPDATE or DELETE without WHERE
  - columns missing from GROUP BY
  - `= NULL`
  - duplicate column names
  - unquoted text in INSERT values
  - ranking window functions without ORDER BY (an error on SQL Server)
- **Tips**, e.g. LIMIT without ORDER BY, LIKE without a wildcard, or INTERSECT precedence.

"Go to field" jumps to the problem.

**Workspace**
- **History** of generated queries: search, restore, copy, delete, clear. It keeps the last 50, and can be turned off.
- **Templates**: save, load, rename, duplicate, delete, and import/export as JSON.
- **Examples**: twelve starter queries.
- Import/export of the current query as JSON (validated, never executed), and download of the SQL.
- Undo / redo of every change.
- Unsaved work is restored when you come back; this can be turned off.
- Settings: dialect, identifier quoting, live preview, history, session restore, theme, and delete all saved data.
- Light / Dark / System theme.

## SQL dialects

Generic SQL is the default. Dialects change only what is listed here:

| | Generic | PostgreSQL | MySQL | SQL Server |
|---|---|---|---|---|
| Quoted identifiers (optional setting) | `"name"` | `"name"` | `` `name` `` | `[name]` |
| Text values | `'it''s'` | `'it''s'` | `'it''s'`, backslashes doubled | `'it''s'` |
| Booleans | `TRUE` / `FALSE` | `TRUE` / `FALSE` | `TRUE` / `FALSE` | `1` / `0` |
| LIMIT n | `LIMIT n` | `LIMIT n` | `LIMIT n` | `SELECT TOP n` |
| LIMIT n OFFSET m | `LIMIT n OFFSET m` | same | same | `OFFSET m ROWS FETCH NEXT n ROWS ONLY` (adds `ORDER BY (SELECT NULL)` if there is no ORDER BY) |
| OFFSET only | `OFFSET m` | `OFFSET m` | `LIMIT 18446744073709551615 OFFSET m` | `OFFSET m ROWS` |
| FULL JOIN | ✓ | ✓ | reported as an error | ✓ |
| INTERSECT / EXCEPT | ✓ (+ `ALL`) | ✓ (+ `ALL`) | ✓ (+ `ALL`), tip: needs 8.0.31+ | ✓ (no `ALL` variants) |
| NTH_VALUE | ✓ | ✓ | ✓ | reported as an error |
| Ranking functions without ORDER BY | warning | warning | warning | error (required) |

Not dialect-aware (yet): date/time functions, parameter placeholders, `RETURNING`/`OUTPUT`, upserts. Expressions you type are passed through unchanged.

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

**Android:** install an APK built from this repository ([ANDROID.md](ANDROID.md)). Google Play distribution is being prepared ([PLAY_STORE_RELEASE_CHECKLIST.md](PLAY_STORE_RELEASE_CHECKLIST.md)).

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
├── dialects.js       Everything dialect-specific (quoting, booleans, pagination, FULL JOIN)
├── validation.js     model → issues { level, category, message, path }
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

## Browser support

Current versions of Chrome, Edge, Firefox and Safari. Minimums, set by `structuredClone` and `<dialog>`: Chrome/Edge 98, Firefox 98, Safari 15.4.

Android: 7.0 (API 24) or later with Android System WebView 98+, which updates through Google Play. An older WebView gets a "please update" message instead of a blank screen.

## Deployment

The site is static: `index.html`, `style.css`, `dist/`, plus the PWA files `manifest.webmanifest`, `sw.js` and `icons/`. There's no build step on the server.
- **Vercel:** import the repository, or run `npm run deploy` (`npx vercel --prod`).
  - `vercel.json` sets the security headers and `Cache-Control: max-age=0, must-revalidate`, because file names aren't content-hashed.
  - `.vercelignore` publishes only the app files; `Fabric_Sync/`, sources and tests are not served.
- **Any static host:** upload `index.html`, `style.css`, `dist/`, `manifest.webmanifest`, `sw.js` and `icons/`.
- **Android:** see [ANDROID.md](ANDROID.md) (build, signing) and [PLAY_STORE_RELEASE_CHECKLIST.md](PLAY_STORE_RELEASE_CHECKLIST.md).

## Project structure

```
index.html  style.css  dist/sqlbuilder.js(.map)   ← the app
manifest.webmanifest  sw.js  icons/               ← PWA (install + offline)
capacitor.config.json  android/                   ← Android app (Capacitor); www/ is generated
scripts/                                          ← asset stamping, mobile build, icon generator, Android E2E
store/  resources/                                ← Play Store graphics, master icon
src/                                              ← sources (see Architecture)
tests/                                            ← Vitest: unit, UI (jsdom) and bundle tests
vercel.json  .vercelignore                        ← deployment
eslint.config.js  jsconfig.json  package.json     ← tooling
.github/workflows/ci.yml                          ← lint, typecheck, tests, bundle freshness
.github/workflows/android.yml                     ← APK/AAB build, Android lint, emulator E2E
Fabric_Sync/                                      ← unrelated Power BI content (not deployed)
```

## Limitations

- **Not a SQL parser.** Expressions you type (columns, custom conditions, CASE parts, INSERT values) are inserted as written. Validation only checks balanced quotes and parentheses and rejects `;` and `--`. It cannot tell whether a column exists or a function is valid.
- You can't paste SQL in to edit it; queries are built with the builder or imported as JSON.
- CTEs are only allowed on the main query, and recursive CTEs aren't supported.
- INSERT values are SQL expressions: write text in quotes. A warning flags likely unquoted text.
- GROUP BY checking is a heuristic: it compares expressions textually and can't know about functional dependencies.
- Dialect support covers only the differences listed above.
- Window frames are limited to three `ROWS` presets.
- MySQL's minimum versions (8.0 for window functions, 8.0.31 for INTERSECT/EXCEPT) aren't enforced; they're shown only as notes and tips.

## Roadmap

Candidates, in rough priority order:
- `INSERT … SELECT` and upserts (`ON CONFLICT`, `ON DUPLICATE KEY`, `MERGE`)
- Parameter placeholders per dialect (`$1`, `?`, `@p1`)
- Recursive CTEs
- More window options: named `WINDOW` clauses, `RANGE`/`GROUPS` frames and custom frame bounds
- Optional schema hints (known tables/columns) for autocomplete and validation

## License

MIT
