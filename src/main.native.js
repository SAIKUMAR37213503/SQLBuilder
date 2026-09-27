// Entry point for the Capacitor (Android / iOS) app, bundled into
// www/dist/sqlbuilder.js by `npm run build:mobile`. Same app, same UI; only
// the platform adapter differs from the browser entry (main.js).
import { Capacitor, SystemBars } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Clipboard } from '@capacitor/clipboard';
import { Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { SplashScreen } from '@capacitor/splash-screen';
import { startApp } from './app.js';
import { createNativePlatform } from './platform/native.js';
import { createWebPlatform } from './platform/web.js';
import { showUnsupportedMessage, isSupportedRuntime } from './platform/compat.js';

function start() {
    if (!document.getElementById('builder')) return;
    const platform = Capacitor.isNativePlatform()
        ? createNativePlatform({ platformName: Capacitor.getPlatform(), App, Clipboard, Filesystem, Share, SplashScreen, SystemBars })
        : createWebPlatform();
    try {
        if (!isSupportedRuntime()) {
            showUnsupportedMessage();
            return;
        }
        startApp({ platform });
    } finally {
        // Never leave the splash screen up, even if start-up failed
        platform.ready();
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
} else {
    start();
}
