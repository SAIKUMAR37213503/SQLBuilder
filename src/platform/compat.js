// Runtime capability check. The app needs structuredClone and <dialog>
// (Chrome / Android System WebView 98+, Safari 15.4+). Android devices update
// their WebView through Google Play, but an outdated one would otherwise fail
// with a blank screen, so explain what to do instead.

export function isSupportedRuntime(win = globalThis) {
    return typeof win.structuredClone === 'function' && typeof win.HTMLDialogElement === 'function';
}

export function showUnsupportedMessage(doc = document) {
    const main = doc.querySelector('main') || doc.body;
    const box = doc.createElement('div');
    box.className = 'panel';
    box.setAttribute('role', 'alert');
    const title = doc.createElement('h2');
    title.textContent = 'Please update your browser';
    const text = doc.createElement('p');
    text.textContent = 'SQL Query Builder needs a newer browser engine. On Android, update "Android System WebView" (or Chrome) from Google Play, then reopen the app.';
    box.append(title, text);
    main.replaceChildren(box);
}
