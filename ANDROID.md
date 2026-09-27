# Android app

The Android app is the same SQL builder as the website, packaged with [Capacitor](https://capacitorjs.com/) 8. The web files are **bundled inside the APK/AAB** and served from the app itself (`https://localhost`), so it works fully offline and never loads the Vercel site.

| | |
|---|---|
| App name | SQL Builder Pro Lite (`android/app/src/main/res/values/strings.xml`, `capacitor.config.json`) |
| Package (applicationId) | `com.saikumar.sqlbuilder` |
| Version | `version` in `package.json` → versionName `1.0.0`, versionCode `10000` (major×10000 + minor×100 + patch) |
| compileSdk / targetSdk | 36 / 36 (`android/variables.gradle`) |
| minSdk | 24 (Android 7.0) |
| Permissions | none requested by the app (the merged manifest contains only `com.saikumar.sqlbuilder.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`, an app-private signature permission added by AndroidX that protects the app's own broadcast receivers) |
| Toolchain | Android Gradle Plugin 8.13, Gradle 8.14.3, JDK 21 |

## How it's put together

```
src/            shared app (unchanged SQL core: model, generator, validation, …)
src/platform/   web.js    – browser clipboard, <a download>, no-op back button
                native.js – Capacitor Clipboard, Filesystem + Share, SystemBars, back button, SplashScreen
                compat.js – shows a message if the Android System WebView is too old
src/main.js         website entry  → dist/sqlbuilder.js       (no Capacitor code)
src/main.native.js  Android entry  → www/dist/sqlbuilder.js   (npm run build:mobile)
www/            generated web bundle that Capacitor copies into the app (git-ignored)
android/        native project (committed)
```

`app.js` gets a `platform` object and uses it for everything that differs between the browser and Android. Nothing else in the SQL core knows it runs on Android.

What Android adds:
- **Copy** uses the native clipboard.
- **Download / Export** (SQL, query JSON, templates) writes the file to the app's cache and opens the Android share sheet, so you can save it to Files/Drive or send it to another app. Cancelling shows "Export cancelled."
- A **Share** button next to Copy shares the SQL text.
- The **back button** closes an open dialog or the File menu first, and only then leaves the app.
- Status and navigation bar icons follow the light/dark theme. The layout respects display cutouts and gesture bars (edge-to-edge is mandatory from API 35).
- Branded adaptive icon (with a monochrome layer for themed icons) and an Android 12+ splash screen.
- Saved data (settings, history, templates, the current query) is kept in the WebView's localStorage on the device. `allowBackup="false"`, so it's not copied to cloud backups.

## Prerequisites

- Node.js 22.22+ and `npm ci`
- JDK 21
- Android SDK with *Android SDK Platform 36* and *Build-Tools 36* (install with Android Studio, or `sdkmanager "platforms;android-36" "build-tools;36.0.0"`). Point Gradle at it with `ANDROID_HOME` or `android/local.properties` (`sdk.dir=/path/to/sdk`).

## Build

```bash
npm ci
npm run cap:sync          # build www/ and copy it + plugins into android/
npm run android:open      # open in Android Studio (optional)

npm run android:debug     # → android/app/build/outputs/apk/debug/app-debug.apk
npm run android:bundle    # → android/app/build/outputs/bundle/release/app-release.aab
```

Run `npm run cap:sync` after every change to `src/` or `style.css`. Otherwise the app keeps the old web bundle.

Install a debug build on a device or emulator: `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`.

Other Gradle tasks (run inside `android/`): `./gradlew lintDebug`, `./gradlew connectedDebugAndroidTest` (needs a device/emulator), `./gradlew assembleRelease` (APK instead of AAB).

## Release signing

Google Play needs the AAB signed with your **upload key**. The key and passwords must never be committed. `android/.gitignore` excludes `keystore.properties`, `*.jks` and `*.keystore`.

1. Create an upload key once. Keep the file and passwords somewhere safe, such as a password manager, **outside the repository**:
   ```bash
   keytool -genkeypair -v -keystore ~/keys/sqlbuilder-upload.jks \
     -alias upload -keyalg RSA -keysize 4096 -validity 10000
   ```
2. Create `android/keystore.properties` (git-ignored):
   ```properties
   storeFile=/home/you/keys/sqlbuilder-upload.jks
   storePassword=…
   keyAlias=upload
   keyPassword=…
   ```
   Alternatively (for CI) set the environment variables `ANDROID_KEYSTORE_FILE`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`.
3. `npm run android:bundle` produces a signed `android/app/build/outputs/bundle/release/app-release.aab`. Check it with `jarsigner -verify android/app/build/outputs/bundle/release/app-release.aab`.

Without signing details, Gradle prints a notice and builds an **unsigned** release, which Play will not accept.

### Building the Play AAB on GitHub (no local Android SDK needed)

`.github/workflows/android-release.yml` builds the signed AAB in GitHub Actions. It only builds; it never publishes to Google Play.
1. Add four repository secrets under **Settings → Secrets and variables → Actions**:
   - `ANDROID_KEYSTORE_BASE64`: the keystore, base64-encoded (`base64 -w0 upload.jks`, or on macOS `base64 -i upload.jks`)
   - `ANDROID_KEYSTORE_PASSWORD`
   - `ANDROID_KEY_ALIAS`
   - `ANDROID_KEY_PASSWORD`
2. Go to **Actions → "Android release (Play upload AAB)" → Run workflow**. You can override the versionCode there if needed.
3. The run checks, builds and verifies the signature, and prints the certificate's SHA-256 fingerprint. Download the `app-release-aab-for-play` artifact, unzip it and upload `app-release.aab` in Play Console.

The keystore is decoded only inside the job and deleted after signing. Artifacts of a public repository can be downloaded by any signed-in GitHub user for 7 days, which is fine: the AAB contains no secrets.

Use **Play App Signing**, which Play Console offers by default: Google holds the app signing key, and you upload with your upload key. If the upload key is lost, it can be reset through Play Console support.

**Every Play upload needs a higher versionCode:** bump `version` in `package.json` (for example 1.0.1 → 10001), or pass `-PversionCode=<n>`.

## Continuous integration

`.github/workflows/android.yml` runs on pushes and PRs:
1. **Build APK + AAB:** `npm ci`, `npm run build`, `cap sync`, then `assembleDebug`, `lintDebug` and `bundleRelease`.
   - The AAB is signed with a throw-away key generated during the run, only to prove the signing setup works. **That artifact is not for Play.**
   - It then prints the merged manifest (permissions, SDK levels).
2. **Emulator E2E:** boots an API 36 emulator and runs the instrumented tests (`android/app/src/androidTest`). It then runs `scripts/android-e2e.mjs`, which drives the real app over the WebView DevTools protocol **in airplane mode**:
   - SQL generation for every example
   - copy (read back from the clipboard)
   - export (share sheet opens, file contents checked)
   - share
   - back-button handling
   - theme and safe areas
   - rotation
   - persistence across a restart
   - no console errors, crashes or CSP violations

   Screenshots, logcat and `report.json` are uploaded as the `e2e-screenshots-and-logs` artifact.

## Icons and store graphics

`node scripts/generate-icons.mjs` regenerates everything from one definition (the database symbol from the web header on `#1D5FD6`):
- Android launcher icons (adaptive + legacy PNGs)
- the splash icon
- PWA icons in `icons/`
- `store/play-icon-512.png`
- `store/feature-graphic-1024x500.png`

## Renaming to "SQL Builder Pro"

Change `appName` in `capacitor.config.json`, `app_name` / `title_activity_main` in `android/app/src/main/res/values/strings.xml`, `BRAND.name` in `scripts/generate-icons.mjs` (and the text in `featureGraphic()`), and `name` in `manifest.webmanifest`, then update the tests in `tests/mobile-config.test.js`. **Do not change the package name** (`com.saikumar.sqlbuilder`). Play identifies the app by it and it can never change after the first upload.

## iOS later

The platform layer is not Android-specific: `npm i @capacitor/ios && npx cap add ios` reuses `www/` and `src/main.native.js`. iOS needs a Mac with Xcode, and has not been set up or tested.

## Troubleshooting

- **"SDK location not found":** set `ANDROID_HOME` or create `android/local.properties` with `sdk.dir=…`.
- **The app shows old content:** run `npm run cap:sync` again, then rebuild.
- **"Please update your browser" screen:** update *Android System WebView* (or Chrome) from the Play Store. The app needs WebView 98+.
- **Debugging:** debug builds allow `chrome://inspect` from a desktop Chrome while connected over USB.
