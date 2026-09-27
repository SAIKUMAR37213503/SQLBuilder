// Capacitor (Android / iOS) implementation of the platform interface.
//
// Plugins are passed in rather than imported, so this module has no hard
// dependency on Capacitor packages: main.native.js supplies the real plugins,
// tests supply fakes. The SQL core never sees any of this.

import { createWebPlatform } from './web.js';

const EXPORT_DIR = 'exports';

/** Keeps generated file names safe for any file system. */
export function safeFilename(name) {
    const cleaned = String(name).replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
    return cleaned || 'export.txt';
}

function errorMessage(error) {
    if (error && typeof error === 'object' && 'message' in error) return String(error.message);
    return String(error);
}

// The share sheet rejects with "Share canceled" when dismissed without a choice
function isCancellation(error) {
    return /cancel/i.test(errorMessage(error));
}

/**
 * @param {{
 *   platformName: string,
 *   Clipboard: { write(options: { string: string }): Promise<void> },
 *   Share: { share(options: object): Promise<unknown> },
 *   Filesystem: {
 *     writeFile(options: object): Promise<{ uri: string }>,
 *     rmdir(options: object): Promise<void>
 *   },
 *   App: { addListener(event: string, listener: () => void): unknown, minimizeApp?(): Promise<void>, exitApp(): Promise<void> },
 *   SplashScreen?: { hide(): Promise<void> },
 *   SystemBars?: { setStyle(options: { style: string }): Promise<void> }
 * }} plugins
 * @param {import('./types.js').Platform} [fallback] used when a native call fails
 * @returns {import('./types.js').Platform}
 */
export function createNativePlatform(plugins, fallback = createWebPlatform()) {
    const { platformName, Clipboard, Share, Filesystem, App, SplashScreen, SystemBars } = plugins;

    async function copyText(text) {
        try {
            await Clipboard.write({ string: text });
            return true;
        } catch {
            return fallback.copyText(text);
        }
    }

    // Writes the file into the app's private cache, then opens the system share
    // sheet so the user chooses where it goes (Files/Drive "save", mail, chat…).
    // No storage permission is needed for this.
    /** @returns {Promise<import('./types.js').SaveResult>} */
    async function saveFile({ filename, text }) {
        const name = safeFilename(filename);
        let uri;
        try {
            // Best effort: keep only the latest export in the cache
            await Filesystem.rmdir({ path: EXPORT_DIR, directory: 'CACHE', recursive: true }).catch(() => {});
            ({ uri } = await Filesystem.writeFile({
                path: `${EXPORT_DIR}/${name}`,
                data: text,
                directory: 'CACHE',
                encoding: 'utf8',
                recursive: true
            }));
        } catch (error) {
            return { status: 'failed', message: `The file could not be created (${errorMessage(error)}).` };
        }
        try {
            await Share.share({ title: name, files: [uri], dialogTitle: `Save or send ${name}` });
            return { status: 'shared' };
        } catch (error) {
            if (isCancellation(error)) return { status: 'cancelled' };
            return { status: 'failed', message: errorMessage(error) };
        }
    }

    /** @returns {Promise<import('./types.js').SaveResult>} */
    async function shareText({ title, text }) {
        try {
            await Share.share({ title, text, dialogTitle: title });
            return { status: 'shared' };
        } catch (error) {
            if (isCancellation(error)) return { status: 'cancelled' };
            return { status: 'failed', message: errorMessage(error) };
        }
    }

    function setAppearance(theme) {
        // DARK = light icons for a dark background, LIGHT = dark icons for a light background
        SystemBars?.setStyle({ style: theme === 'dark' ? 'DARK' : 'LIGHT' }).catch(() => {});
    }

    // Close in-app overlays first; otherwise behave like Android's default for a
    // root screen (the app goes to the background and keeps its state).
    function onBack(handler) {
        App.addListener('backButton', () => {
            if (handler()) return;
            const leave = App.minimizeApp ? App.minimizeApp() : App.exitApp();
            Promise.resolve(leave).catch(() => App.exitApp());
        });
    }

    return {
        name: platformName,
        isNative: true,
        canShare: true,
        copyText,
        saveFile,
        shareText,
        setAppearance,
        onBack,
        ready: () => { SplashScreen?.hide().catch(() => {}); }
    };
}
