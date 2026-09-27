# Privacy Policy: SQL Builder Pro Lite

_Last updated: 27 September 2026_

This policy covers the **SQL Builder Pro Lite** Android app (package `com.saikumar.sqlbuilder`) and the SQL Builder website. They are the same application.

SQL Builder Pro Lite is a tool that **writes SQL text**. It does not connect to any database, it does not run the SQL it generates, and it has no accounts, server or backend.

## What the app stores, and where

Everything you enter stays **on your device**:

| Data | Purpose | Where it's kept |
|---|---|---|
| The query you are building | Restores your work when you reopen the app | App storage on your device (WebView localStorage) |
| Query history | Lets you reopen recent queries (can be turned off in Settings) | Same |
| Saved templates | Queries you chose to save | Same |
| Settings (theme, dialect, formatting options) | Remembers your preferences | Same |

- This data is never sent to the developer or anyone else.
- On Android, the app opts out of Android backup (`allowBackup="false"`), so it is not copied to Google Drive or other backups. It is deleted when you uninstall the app or clear its storage.
- You can delete history, templates and settings at any time: **Settings → Delete all saved data…** in the app (or **Clear history** in the History tab), or Android **Settings → Apps → SQL Builder Pro Lite → Storage → Clear storage**.

## What the app does not do

- It collects no personal information. There are no accounts or sign-in.
- It includes no analytics, crash reporting, advertising or tracking SDKs.
- It makes no network requests. The Android app is packaged with all its files and requests **no Android permissions**, not even internet access. The only entry in its manifest is an internal permission, added by the AndroidX library, that stops other apps from sending it broadcasts.
- It doesn't connect to databases or execute SQL.
- It doesn't upload your queries or send them to any external service or AI.

## Sharing and exporting

When you tap **Copy**, **Share** or **Download/Export**, the app hands the SQL or JSON to Android: the clipboard, or the system share sheet. The app writes the exported file to its private cache folder so that the share sheet can pass it on.
- **You** choose where the content goes, for example Files, Drive, email or another app.
- The app sends it nowhere on its own.
- Once you share content with another app, that app's privacy policy applies.

## The website

The website version (hosted on Vercel) works the same way:
- your data is stored only in your browser's localStorage;
- the page sends nothing you type to any server.

Like any web host, Vercel receives standard request information, such as your IP address and browser type, when your browser downloads the page. That is outside the app's code and is covered by [Vercel's privacy policy](https://vercel.com/legal/privacy-policy). The Android app does not contact Vercel or any other server.

The Windows app from the Microsoft Store is this website installed as an app (a progressive web app packaged with PWABuilder). It loads its files from the website and then works offline, stores data only on your PC, and sends nothing you type anywhere.

## Children

The app is a general-purpose developer tool and is not directed at children. It collects no data from anyone.

## Changes

If this policy changes, the updated version is published at the same location with a new "Last updated" date.

## Contact

Questions about this policy: [pappalapandit@gmail.com](mailto:pappalapandit@gmail.com)
