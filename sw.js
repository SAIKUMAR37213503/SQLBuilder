// Service worker for the website (PWA): makes SQL Builder work offline after
// the first visit. Not used inside the Android app, which is already local.
//
// Strategy (chosen so users always get new deployments):
//   - pages (index.html): network-first, cached copy only when offline
//   - content-hashed assets (style.css?v=…, dist/sqlbuilder.js?v=…): cache-first;
//     safe because a changed file always gets a new URL
//   - other same-origin files (icons, manifest): network-first with cache fallback
// Nothing is sent anywhere: the worker only handles same-origin GET requests.
'use strict';

const CACHE = 'sqlb-offline-v1';
const VERSIONED = /[?&]v=[0-9a-f]+$/;

// Asset URLs referenced by a page, e.g. href="style.css?v=ab12"
function assetUrls(html, base) {
    return Array.from(html.matchAll(/(?:href|src)="([^"]+\?v=[0-9a-f]+)"/g), m => new URL(m[1], base).href);
}

async function cachePage(response, url) {
    const cache = await caches.open(CACHE);
    const html = await response.clone().text();
    await cache.put(new URL('./', url).href, response.clone());
    const assets = assetUrls(html, url);
    await Promise.all(assets.map(async (asset) => {
        if (await cache.match(asset)) return;
        const res = await fetch(asset);
        if (res.ok) await cache.put(asset, res);
    }));
    // Drop older versions of the same assets
    const keep = new Set(assets.map(a => new URL(a).pathname));
    for (const request of await cache.keys()) {
        const u = new URL(request.url);
        if (VERSIONED.test(u.search) && keep.has(u.pathname) && !assets.includes(request.url)) await cache.delete(request);
    }
}

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const url = new URL('./', self.registration.scope).href;
        const response = await fetch(url, { cache: 'no-store' });
        if (response.ok) await cachePage(response, url);
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.origin !== self.location.origin) return;

    if (request.mode === 'navigate') {
        event.respondWith((async () => {
            try {
                const response = await fetch(request);
                if (response.ok) event.waitUntil(cachePage(response.clone(), request.url));
                return response;
            } catch {
                return (await caches.match(new URL('./', request.url).href)) || Response.error();
            }
        })());
        return;
    }

    if (VERSIONED.test(url.search)) {
        event.respondWith((async () => {
            const cached = await caches.match(request);
            if (cached) return cached;
            const response = await fetch(request);
            if (response.ok) {
                const copy = response.clone();
                event.waitUntil(caches.open(CACHE).then(cache => cache.put(request, copy)));
            }
            return response;
        })());
        return;
    }

    event.respondWith((async () => {
        try {
            const response = await fetch(request);
            if (response.ok) {
                const copy = response.clone();
                event.waitUntil(caches.open(CACHE).then(cache => cache.put(request, copy)));
            }
            return response;
        } catch {
            return (await caches.match(request)) || Response.error();
        }
    })());
});
