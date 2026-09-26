// Browser entry point, bundled to dist/sqlbuilder.js (a classic script, so
// index.html also works when opened directly from disk).
import { startApp } from './app.js';

function start() {
    if (document.getElementById('builder')) startApp();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
} else {
    start();
}
