// Runs sw.js in a sandbox with fake caches/fetch to check its caching rules:
// pages network-first (so deployments are never stale), content-hashed assets
// cache-first, offline fallbacks, old asset versions dropped, cross-origin ignored.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const source = readFileSync(join(import.meta.dirname, '..', 'sw.js'), 'utf8');
const ORIGIN = 'https://sql.example';

function page(css, js) {
    return `<link rel="stylesheet" href="style.css?v=${css}"><script src="dist/sqlbuilder.js?v=${js}" defer></script>`;
}

function setup(server) {
    const store = new Map();
    const cache = {
        match: async (req) => store.get(typeof req === 'string' ? req : req.url)?.clone(),
        put: async (req, res) => { store.set(typeof req === 'string' ? req : req.url, res); },
        keys: async () => [...store.keys()].map(url => ({ url })),
        delete: async (req) => store.delete(req.url)
    };
    const listeners = {};
    const fetch = vi.fn(async (req) => {
        const url = typeof req === 'string' ? req : req.url;
        if (server.offline) throw new TypeError('Failed to fetch');
        const body = server.files[new URL(url).pathname + new URL(url).search] ?? server.files[new URL(url).pathname];
        return body === undefined ? new Response('missing', { status: 404 }) : new Response(body, { status: 200 });
    });
    const context = {
        self: {
            addEventListener: (type, fn) => { listeners[type] = fn; },
            registration: { scope: `${ORIGIN}/` },
            location: { origin: ORIGIN },
            skipWaiting: async () => {},
            clients: { claim: async () => {} }
        },
        caches: {
            open: async () => cache,
            match: (req) => cache.match(req),
            keys: async () => ['sqlb-offline-v1', 'old-cache'],
            delete: vi.fn(async () => true)
        },
        fetch, URL, Response, Promise, Set, Array
    };
    vm.runInNewContext(source, context);

    async function dispatch(type, extra = {}) {
        const waits = [];
        let responded;
        const event = { ...extra, waitUntil: (p) => waits.push(p), respondWith: (p) => { responded = p; } };
        listeners[type](event);
        const response = responded ? await responded : undefined;
        await Promise.all(waits);
        return { response, handled: Boolean(responded) };
    }

    return { store, fetch, dispatch, context };
}

const request = (path, mode = 'no-cors', method = 'GET') => ({ url: new URL(path, ORIGIN).href, mode, method });

describe('service worker', () => {
    let server;
    let sw;

    beforeEach(async () => {
        server = { offline: false, files: { '/': page('aaa', 'bbb'), '/style.css?v=aaa': 'css-a', '/dist/sqlbuilder.js?v=bbb': 'js-b', '/icons/icon-192.png': 'png' } };
        sw = setup(server);
        await sw.dispatch('install');
    });

    test('install caches the page and the assets it references', () => {
        expect([...sw.store.keys()]).toEqual([`${ORIGIN}/`, `${ORIGIN}/style.css?v=aaa`, `${ORIGIN}/dist/sqlbuilder.js?v=bbb`]);
    });

    test('the real page: the SQL Lab engine (worker and wasm) is cached for offline use', async () => {
        const html = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8');
        const paths = [...html.matchAll(/(?:href|src)="([^"]+\?v=[0-9a-f]+)"/g)].map(m => `/${m[1]}`);
        expect(paths.map(p => p.split('?')[0]).sort()).toEqual(['/dist/db-worker.js', '/dist/sqlbuilder.js', '/dist/sqlite3.wasm', '/style.css']);
        const real = { offline: false, files: Object.fromEntries([['/', html], ...paths.map(p => [p, `body of ${p}`])]) };
        const worker = setup(real);
        await worker.dispatch('install');
        real.offline = true;
        for (const p of paths) {
            const { response } = await worker.dispatch('fetch', { request: request(p) });
            expect(await response.text()).toBe(`body of ${p}`);
        }
    });

    test('activate removes caches from older versions', async () => {
        await sw.dispatch('activate');
        expect(sw.context.caches.delete).toHaveBeenCalledWith('old-cache');
        expect(sw.context.caches.delete).not.toHaveBeenCalledWith('sqlb-offline-v1');
    });

    test('pages are network-first: a new deployment is served immediately', async () => {
        server.files['/'] = page('ccc', 'ddd');
        server.files['/style.css?v=ccc'] = 'css-c';
        server.files['/dist/sqlbuilder.js?v=ddd'] = 'js-d';
        const { response } = await sw.dispatch('fetch', { request: request('/', 'navigate') });
        expect(await response.text()).toContain('style.css?v=ccc');
        // new assets cached, superseded versions dropped
        expect([...sw.store.keys()].sort()).toEqual([`${ORIGIN}/`, `${ORIGIN}/dist/sqlbuilder.js?v=ddd`, `${ORIGIN}/style.css?v=ccc`]);
    });

    test('offline: pages and assets come from the cache', async () => {
        server.offline = true;
        const nav = await sw.dispatch('fetch', { request: request('/', 'navigate') });
        expect(await nav.response.text()).toContain('style.css?v=aaa');
        const css = await sw.dispatch('fetch', { request: request('/style.css?v=aaa') });
        expect(await css.response.text()).toBe('css-a');
    });

    test('versioned assets are cache-first (no network request when cached)', async () => {
        sw.fetch.mockClear();
        const { response } = await sw.dispatch('fetch', { request: request('/dist/sqlbuilder.js?v=bbb') });
        expect(await response.text()).toBe('js-b');
        expect(sw.fetch).not.toHaveBeenCalled();
    });

    test('unversioned files are network-first with an offline fallback', async () => {
        const online = await sw.dispatch('fetch', { request: request('/icons/icon-192.png') });
        expect(await online.response.text()).toBe('png');
        server.offline = true;
        const offline = await sw.dispatch('fetch', { request: request('/icons/icon-192.png') });
        expect(await offline.response.text()).toBe('png');
    });

    test('ignores cross-origin and non-GET requests', async () => {
        expect((await sw.dispatch('fetch', { request: request('https://other.example/x') })).handled).toBe(false);
        expect((await sw.dispatch('fetch', { request: request('/', 'navigate', 'POST') })).handled).toBe(false);
    });
});

describe('PWA wiring', () => {
    const root = join(import.meta.dirname, '..');
    test('manifest, icons and registration', () => {
        const manifest = JSON.parse(readFileSync(join(root, 'manifest.webmanifest'), 'utf8'));
        expect(manifest).toMatchObject({ name: 'SQL Builder Pro Lite', display: 'standalone', start_url: './' });
        expect(manifest.icons.map(i => i.purpose)).toEqual(['any', 'any', 'maskable']);
        const html = readFileSync(join(root, 'index.html'), 'utf8');
        expect(html).toContain('<link rel="manifest" href="manifest.webmanifest">');
        expect(readFileSync(join(root, 'src/main.js'), 'utf8')).toContain("navigator.serviceWorker.register('sw.js')");
        expect(readFileSync(join(root, 'src/main.native.js'), 'utf8')).not.toContain('serviceWorker');
        expect(readFileSync(join(root, '.vercelignore'), 'utf8')).toMatch(/!manifest\.webmanifest[\s\S]*!sw\.js[\s\S]*!icons/);
    });
});
