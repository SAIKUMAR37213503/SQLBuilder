# Publishing to the Microsoft Store (Windows)

The Windows app is the website packaged as a progressive web app (PWA). [PWABuilder](https://www.pwabuilder.com) turns the live site into Store packages, so no Windows build tools are needed. There is no separate Windows code: when the website is updated, the installed app picks up the update on its next start, and it works offline after the first launch.

| | |
|---|---|
| Live URL packaged | https://sql-builder-saikumar.vercel.app |
| App name | SQL Builder Pro Lite |
| Manifest | `manifest.webmanifest` (id, name, icons 192/512 + maskable, standalone, offline service worker `sw.js`) |
| Screenshots (1920×1080) | `store/windows/*.png` |
| Store logo | `store/play-icon-512.png` (512×512) |
| Privacy policy | https://github.com/SAIKUMAR37213503/SQLBuilder/blob/main/PRIVACY.md |

## 1. Reserve the name in Partner Center

1. Sign in at https://partner.microsoft.com/dashboard.
2. Go to **Apps and games → + New product → MSIX or PWA app**.
3. Reserve the name **SQL Builder Pro Lite**. If it's taken, try "SQL Builder Pro Lite for Windows".
4. Open **Product management → Product identity** and copy these three values:
   - **Package/Identity/Name** (PWABuilder calls it *Package ID*)
   - **Package/Identity/Publisher** (the *Publisher ID*, starts with `CN=`)
   - **Package/Properties/PublisherDisplayName** (the *Publisher display name*)

## 2. Build the packages with PWABuilder

1. Open https://www.pwabuilder.com, enter `https://sql-builder-saikumar.vercel.app` and click **Start**. It checks the manifest, service worker and HTTPS; all three should pass.
2. Click **Package for stores**, then **Generate Package** under **Windows**.
3. Choose the **Store** options. Paste the three Partner Center values into **Package ID**, **Publisher ID** and **Publisher display name**, and keep version `1.0.0`.
4. Click **Download Package**. The zip contains a `.msixbundle`, a `.classic.appxbundle`, and a test-install guide. Keep it; it is not committed to Git.

Optional: to try the app before submitting, follow the test-install instructions in the downloaded zip.

## 3. Submit in Partner Center

Open the reserved app and click **Start your submission**, then fill in each section:

- **Pricing and availability**: Free, all markets (or the ones you choose).
- **Properties**:
  - Category: **Developer tools**. If that isn't offered, use Productivity or Utilities & tools.
  - Privacy policy URL: the one in the table above.
  - Support contact: `pappalapandit@gmail.com`.
- **Age ratings**: complete the questionnaire. It is a utility with no user-to-user interaction, no purchases and no data collection.
- **Packages**: drag in **both** the `.msixbundle` and the `.classic.appxbundle`. Warnings about restricted capabilities such as `runFullTrust` are expected for PWABuilder packages and can be ignored.
- **Store listings (English)**:
  - Description, for example:
    > SQL Builder Pro Lite helps you write correct, readable SQL without memorising syntax. Pick a query type, fill in tables, columns and conditions, and the SQL updates as you type. It supports joins, nested AND/OR conditions, subqueries, CTEs, CASE, window functions, UNION/INTERSECT/EXCEPT, INSERT, UPDATE and DELETE, for Generic SQL, PostgreSQL, MySQL and SQL Server. It gives instant validation, history, templates and examples, and lets you copy or export as .sql or JSON, in light or dark theme. It is private by design: no account, and everything stays on your PC. It only generates SQL text; it never connects to a database or runs queries.
  - Screenshots: upload `store/windows/1-join-query.png` … `4-examples-library-dark.png`.
  - Store logo: `store/play-icon-512.png`.
  - Short description / keywords: sql, query builder, database, sql generator, postgresql, mysql, sql server.
- **Submission options**: leave the defaults.

Click **Submit to the Store**. Review usually takes 24–48 hours (PWABuilder docs), and Partner Center shows the status and any requested fixes.

## Updating the app

Website changes merged to `main` deploy to Vercel and reach Windows users automatically. Re-package with PWABuilder, with a higher version such as `1.0.1`, only when the app's identity changes: name, icons, or manifest `start_url` / `scope`.
