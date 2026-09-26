# SQL Query Builder Pro Lite

Build SQL visually in your browser: SELECT (with joins, nested conditions, subqueries, CTEs, CASE, grouping and UNION), INSERT, UPDATE and DELETE. The output is clean, consistently formatted SQL for Generic SQL, PostgreSQL, MySQL or SQL Server.

It is a static page with no server, no accounts and no analytics. It **never connects to a database or runs queries**, and nothing you type leaves your browser.

---

## Features

**Query types:** SELECT, INSERT (one or many rows), UPDATE, DELETE.

**SELECT builder**
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
- `UNION` / `UNION ALL` with any number of queries. `ORDER BY` / `LIMIT` apply to the combined result.
- Subqueries nest up to 4 levels deep.

**Values vs. expressions:** every condition value is either
- a **Value**, which is quoted and escaped for you: `John` → `'John'`, `O'Brien` → `'O''Brien'`, while numbers stay numbers, `true`/`false` become the dialect's boolean, and `null` becomes `NULL`;
- a **Column / expression**, inserted as written (`o.user_id`, `CURRENT_DATE`); or
- a **Subquery**.

**Output**
- Formatted SQL (one clause per line, 4-space indentation) or a single line
- Syntax highlighting and line numbers; the line numbers are never copied
- Live preview while you type (can be switched off)
- Copy, Select all, Download `.sql`

**Checks:** the checks panel shows three kinds of message:
- **Errors** (block generation): missing fields, invalid names or aliases, unbalanced quotes or parentheses, a join without a condition, UNION column-count mismatches, INSERT value/column mismatches, …
- **Warnings** (never block):
  - UPDATE or DELETE without WHERE
  - columns missing from GROUP BY
  - `= NULL`
  - duplicate column names
  - unquoted text in INSERT values
- **Tips**, e.g. LIMIT without ORDER BY, or LIKE without a wildcard.

"Go to field" jumps to the problem.

**Workspace**
- **History** of generated queries: search, restore, copy, delete, clear. It keeps the last 50, and can be turned off.
- **Templates**: save, load, rename, duplicate, delete, and import/export as JSON.
- **Examples**: ten starter queries.
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

**Online / locally:** open `index.html` in a browser. Opening it straight from disk (`file://`) works too, because the app ships as one prebuilt script (`dist/sqlbuilder.js`).

```bash
npm ci            # dev tooling only
npm run dev       # http://localhost:3000
```

## Development

Requires Node.js 22.22+ (or 24.15+).

```bash
npm test            # unit + UI tests (Vitest, jsdom)
npm run lint        # ESLint
npm run typecheck   # TypeScript checkJs over src/
npm run build       # bundle src/ → dist/sqlbuilder.js (esbuild)
npm run check       # all of the above; CI runs the same and fails if dist/ is stale
```

Source is plain ES modules in `src/`. The committed `dist/sqlbuilder.js` is what the page loads; **run `npm run build` and commit `dist/` after changing `src/`**.

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
├── main.js           Entry point (bundled)
└── ui/
    ├── builder.js    Renders the editor from the model (recursive for subqueries)
    ├── output.js     SQL view with tokens and line numbers
    ├── library.js    History / Templates / Examples lists
    ├── dialogs.js    Native <dialog> helpers
    ├── theme.js, shortcuts.js, dom.js (safe element builder)
```

Design decisions:
- **One structured model.** The builder, generator, validator, history, templates, import/export and undo all operate on the same JSON model, so SQL is never parsed back from text. New constructs (window functions, `INTERSECT`/`EXCEPT`, …) are added as a model field, a generator branch, a validation rule and an editor control.
- **Formatting happens during generation.** The generator emits `[indent, text]` lines and pretty-prints or joins them, so user values are never reformatted.
- **No framework.** Rendering uses a ~30-line `h()` helper with `textContent`/`setAttribute`; there is no `innerHTML`. Events are delegated: inputs carry `data-path` (their location in the model) and buttons carry `data-action`.
- **Bundled classic script.** ES modules can't load from `file://`, so esbuild bundles them into one IIFE. The only runtime dependency is the browser.

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
- The deployment sends a strict Content-Security-Policy.

## Browser support

Current versions of Chrome, Edge, Firefox and Safari. Minimums, set by `structuredClone` and `<dialog>`: Chrome/Edge 98, Firefox 98, Safari 15.4.

## Deployment

The site is static: `index.html`, `style.css` and `dist/`. There's no build step on the server.
- **Vercel:** import the repository, or run `npm run deploy` (`npx vercel --prod`).
  - `vercel.json` sets the security headers and `Cache-Control: max-age=0, must-revalidate`, because file names aren't content-hashed.
  - `.vercelignore` publishes only the app files; `Fabric_Sync/`, sources and tests are not served.
- **Any static host:** upload `index.html`, `style.css` and `dist/`.

## Project structure

```
index.html  style.css  dist/sqlbuilder.js(.map)   ← the app
src/                                              ← sources (see Architecture)
tests/                                            ← Vitest: unit, UI (jsdom) and bundle tests
vercel.json  .vercelignore                        ← deployment
eslint.config.js  jsconfig.json  package.json     ← tooling
.github/workflows/ci.yml                          ← lint, typecheck, tests, bundle freshness
Fabric_Sync/                                      ← unrelated Power BI content (not deployed)
```

## Limitations

- **Not a SQL parser.** Expressions you type (columns, custom conditions, CASE parts, INSERT values) are inserted as written. Validation only checks balanced quotes and parentheses and rejects `;` and `--`. It cannot tell whether a column exists or a function is valid.
- You can't paste SQL in to edit it; queries are built with the builder or imported as JSON.
- CTEs are only allowed on the main query, and recursive CTEs aren't supported.
- INSERT values are SQL expressions: write text in quotes. A warning flags likely unquoted text.
- GROUP BY checking is a heuristic: it compares expressions textually and can't know about functional dependencies.
- Dialect support covers only the differences listed above.

## Roadmap

Candidates, in rough priority order:
- `INTERSECT` / `EXCEPT` (the model's set operators are ready for them)
- Window functions (`OVER (PARTITION BY … ORDER BY …)`)
- `INSERT … SELECT` and upserts (`ON CONFLICT`, `ON DUPLICATE KEY`, `MERGE`)
- Parameter placeholders per dialect (`$1`, `?`, `@p1`)
- Recursive CTEs
- Optional schema hints (known tables/columns) for autocomplete and validation

## License

MIT
