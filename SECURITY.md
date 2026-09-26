# Security model

SQL Query Builder Pro Lite is a **text generator**. It runs entirely in the browser as a static page.

## What the app never does

- Connect to a database or execute SQL
- Send queries, inputs, history or templates over the network. The app code makes no network requests at all; the only files loaded are its own `index.html`, `style.css` and `dist/sqlbuilder.js`.
- Collect analytics or telemetry
- Evaluate imported data or generated SQL (there is no `eval`, `new Function` or dynamic `import()` in the app code)

## Rendering

- All UI is built with DOM APIs (`createElement`, `textContent`, `setAttribute`) through a small helper, `src/ui/dom.js`. The app code contains no `innerHTML`, `outerHTML` or `insertAdjacentHTML`, and a test (`tests/bundle.test.js`) enforces this.
- Syntax highlighting tokenizes SQL into plain token objects (`src/tokenizer.js`), which are rendered as text nodes. User input such as `<script>` or `<img onerror=…>` therefore always appears as literal text; a UI test checks this.

## Content Security Policy (production headers, `vercel.json`)

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

`index.html` contains no inline scripts, inline styles or inline event handlers; a test checks this too. The deployment also sends:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: no-referrer`
- a restrictive `Permissions-Policy`

`.vercelignore` publishes only the app files.

## Imported files (queries and templates)

`src/serialization.js` treats JSON files as untrusted:
- Files larger than 1 MB are rejected before they are read.
- They are parsed with `JSON.parse`, never evaluated.
- Every field is rebuilt into a fresh object with type checks and enum allow-lists.
- Strings and lists have length caps (10,000 characters and 200 items), and nesting depth is capped.
- Unknown keys are dropped, which also neutralises `__proto__` payloads.
- Malformed files produce a readable error and leave the current work untouched.

Imported SQL fragments are still only text: they are inserted into generated SQL and never run.

## Browser storage

Stored in `localStorage` under the `sqlb:v1:` prefix, and only in the current browser:
- **settings**
- **history**: generated queries, at most 50, each at most 100 KB. It can be turned off.
- **templates**: at most 200, saved only when you choose to.
- **draft**: the unsaved workspace, so a reload doesn't lose work. It can be turned off.

Settings → "Delete all saved data" removes everything. Stored data is re-validated when read, so corrupted or tampered entries are skipped rather than trusted. If storage is blocked or full, the app keeps working and tells you what can't be saved.

**Anything you type into a query is stored locally if history or session restore is on.** Don't put secrets (passwords, tokens) into queries, or turn both options off.

## Generated SQL

Validation catches common mistakes, but it is not a SQL parser and cannot guarantee that a statement is safe. For example:
- UPDATE and DELETE without a WHERE clause get a prominent warning, but are still allowed.
- Expressions and custom conditions are passed through unchanged, though `;` (statement chaining) and `--` (comments) are rejected.

**Always review generated SQL before running it against a database.**

## Reporting a problem

Please open an issue in this repository describing the problem and how to reproduce it.
