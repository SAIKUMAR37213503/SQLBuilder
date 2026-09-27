// Browser entry point, bundled to dist/sqlbuilder.js (a classic script, so
// index.html also works when opened directly from disk).
import { startApp } from './app.js';

function start() {
    if (document.getElementById('builder')) startApp();
    registerServiceWorker();
}

// PWA offline support for the website (https or local development only; a page
// opened from disk via file:// can't use service workers).
function registerServiceWorker() {
    const secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!('serviceWorker' in navigator) || !secure) return;
    navigator.serviceWorker.register('sw.js').catch(() => {
        // Offline support is optional; the app works without it
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
} else {
    start();
}
