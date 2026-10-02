# Google Play release checklist: SQL Builder Pro Lite

Nothing here is submitted automatically; every Play Console step is manual. Google's policies and forms change often, so check each item against the current Play Console and [Play policy](https://play.google.com/about/developer-content-policy/) pages rather than relying on this list alone.

## App facts (from the repository)

| Item | Value | Source |
|---|---|---|
| App name (max 30 chars) | SQL Builder Pro Lite | `strings.xml`, `capacitor.config.json` |
| Package name | `com.saikumar.sqlbuilder` (permanent after the first upload) | `android/app/build.gradle` |
| Version | 1.0.0 (versionCode 10000) | `package.json` |
| targetSdk / minSdk | 36 / 24 | `android/variables.gradle` |
| Permissions | none requested; the merged manifest has only AndroidX's app-private `…DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` | `AndroidManifest.xml`; CI prints the merged manifest and fails on any other permission |
| Network access | none; all content is bundled in the app | `capacitor.config.json` has no `server.url` |
| Ads / analytics / accounts | none / none / none | |
| App icon 512×512 | `store/play-icon-512.png` | `scripts/generate-icons.mjs` |
| Feature graphic 1024×500 (24-bit PNG, no alpha) | `store/feature-graphic-1024x500.png` | same |
| Privacy policy | `PRIVACY.md`; must be published at a public URL | |

> Google Play requires new apps and updates to target **API 36 from 31 August 2026**. The app already targets 36.

## 1. Before building

- [ ] `npm ci && npm run check` passes (lint, types, tests, web bundle)
- [ ] Android CI (`.github/workflows/android.yml`) is green on the release commit: build, lint, instrumented tests and emulator E2E
- [ ] `version` bumped in `package.json` if this isn't the first upload, since each upload needs a higher versionCode
- [ ] Upload key created and stored outside Git; `android/keystore.properties` filled in ([ANDROID.md → Release signing](ANDROID.md#release-signing))

## 2. Build the release

- [ ] `npm run android:bundle`, or run the **Android release (Play upload AAB)** workflow on GitHub (see ANDROID.md) and download `app-release-aab-for-play`
- [ ] `jarsigner -verify android/app/build/outputs/bundle/release/app-release.aab` reports "jar verified"
- [ ] Install a release build on a real device and smoke-test it. One way: `bundletool build-apks --connected-device --bundle=… --output=app.apks --ks=…` then `bundletool install-apks --apks=app.apks`.
  - [ ] launches, with the splash screen then the app
  - [ ] airplane mode: build a SELECT, a JOIN and an INSERT; the SQL updates
  - [ ] Copy, then paste into another app
  - [ ] Download SQL → share sheet → save to Files; the file contains the SQL
  - [ ] Share button works
  - [ ] Back closes dialogs and menus first, then leaves the app
  - [ ] dark mode; rotation; a gesture-navigation and a 3-button-navigation device
  - [ ] close and reopen: the query, history and settings are kept

## 3. Play Console: create the app

- [ ] Developer account verified. New personal accounts must run a **closed test** with a minimum number of testers for a minimum period before production access; check the current numbers in Play Console.
- [ ] Create app: name "SQL Builder Pro Lite", default language, **App**, **Free**
- [ ] Accept the declarations (Developer Program Policies, US export laws)
- [ ] Enrol in **Play App Signing** (default) and upload the AAB signed with your upload key

## 4. Store listing

- [ ] **Short description** (max 80 characters). Suggestion (73 characters):
  `Build SQL queries visually: joins, subqueries, CTEs. Offline and private.`
- [ ] **Full description** (max 4000 characters). Suggestion:

  > SQL Builder Pro Lite helps you write correct, readable SQL without memorising syntax. Pick a query type, fill in tables, columns and conditions, and the SQL updates as you type.
  >
  > • SELECT with joins, nested AND/OR conditions, subqueries, CTEs (WITH), CASE expressions, GROUP BY / HAVING, ORDER BY and pagination
  > • Window functions (ROW_NUMBER, RANK, running totals…) and UNION / INTERSECT / EXCEPT
  > • INSERT, UPDATE and DELETE
  > • Generic SQL, PostgreSQL, MySQL and SQL Server output
  > • Instant validation with clear messages
  > • History, reusable templates and ready-made examples
  > • Copy, share or export as a .sql or JSON file
  > • Light and dark themes
  >
  > Private by design: the app works completely offline, needs no account and requests no permissions. Your queries stay on your device. SQL Builder Pro Lite never connects to a database server; its SQL Lab runs SQL only in a SQLite database kept on your device.

  Before publishing, make sure every claim still matches the app, and don't add unverifiable claims ("best", "#1").
- [ ] App icon: `store/play-icon-512.png`
- [ ] Feature graphic: `store/feature-graphic-1024x500.png`
- [ ] Phone screenshots, at least 2 (take them from a device or emulator; the CI artifact `e2e-screenshots-and-logs` has emulator captures to start from). Suggested set: the builder with a JOIN query, generated SQL in dark mode, the examples/templates library, the export share sheet.
- [ ] 7" and 10" tablet screenshots (optional, needed for tablet promotion)
- [ ] Category: **Tools** (or Productivity)
- [ ] Contact email: pappalapandit@gmail.com (required); website: https://sql-builder-saikumar.vercel.app

## 5. App content (Policy → App content)

- [ ] **Privacy policy URL**: publish `PRIVACY.md` at a public URL, for example GitHub's rendered file view or a page on the website (contact: pappalapandit@gmail.com).
- [ ] **Ads**: "No, my app does not contain ads"
- [ ] **App access**: "All functionality is available without special access"
- [ ] **Content rating**: complete the IARC questionnaire (utility app, no user-generated content shared between users, no violence and so on)
- [ ] **Target audience**: 18+ recommended (a developer tool not aimed at children); avoid "Designed for Families"
- [ ] **Data safety**: answer from the implementation, reviewing Google's current definitions of "collected" and "shared" yourself.
  - What the code does: no data leaves the device through the app; there is no INTERNET permission and no SDKs. Queries, history, templates and settings are stored locally only. Export and share are started by the user through the Android share sheet.
  - Likely answer: "No data collected / no data shared", and not "data is encrypted in transit", since nothing is transmitted.
  - **This is the developer's legal declaration.** Confirm it against the final build's merged manifest and dependencies.
- [ ] **Government apps / Financial features / Health**: not applicable
- [ ] **News app**: no

## 6. Testing tracks and rollout

- [ ] Internal testing: upload the AAB and install from Play on at least one device (this checks Play-signed installs)
- [ ] Review the **pre-launch report**: crashes, accessibility, and screenshots on many devices
- [ ] Closed testing if your account requires it; recruit the testers and wait the required period
- [ ] Production: staged rollout (for example 20% → 100%) and watch Android vitals (crashes, ANRs)

## 7. After release

- [ ] Tag the release in Git (`v1.0.0`)
- [ ] Keep the upload key and passwords backed up securely
- [ ] For updates: bump `version`, run `npm run android:bundle`, upload to a track, and write release notes
