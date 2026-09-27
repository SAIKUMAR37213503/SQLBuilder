// @vitest-environment jsdom
// Platform adapters: the native (Capacitor) adapter with fake plugins, and the
// app running on a native platform (Share button, export results, back button).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createNativePlatform, safeFilename } from '../src/platform/native.js';
import { createWebPlatform } from '../src/platform/web.js';
import { isSupportedRuntime, showUnsupportedMessage } from '../src/platform/compat.js';
import { startApp } from '../src/app.js';
import { createStorage, createMemoryBackend } from '../src/storage.js';

function fakePlugins(overrides = {}) {
    const listeners = {};
    return {
        platformName: 'android',
        Clipboard: { write: vi.fn().mockResolvedValue() },
        Share: { share: vi.fn().mockResolvedValue({ activityType: 'com.example' }) },
        Filesystem: {
            writeFile: vi.fn().mockResolvedValue({ uri: 'file:///cache/exports/q.sql' }),
            rmdir: vi.fn().mockResolvedValue()
        },
        App: {
            addListener: vi.fn((event, fn) => { listeners[event] = fn; }),
            minimizeApp: vi.fn().mockResolvedValue(),
            exitApp: vi.fn().mockResolvedValue()
        },
        SplashScreen: { hide: vi.fn().mockResolvedValue() },
        SystemBars: { setStyle: vi.fn().mockResolvedValue() },
        listeners,
        ...overrides
    };
}

describe('native platform adapter', () => {
    test('copies with the Clipboard plugin', async () => {
        const plugins = fakePlugins();
        const platform = createNativePlatform(plugins);
        expect(await platform.copyText('SELECT 1;')).toBe(true);
        expect(plugins.Clipboard.write).toHaveBeenCalledWith({ string: 'SELECT 1;' });
    });

    test('falls back to the web clipboard when the plugin fails, and reports failure', async () => {
        const plugins = fakePlugins({ Clipboard: { write: vi.fn().mockRejectedValue(new Error('denied')) } });
        const fallback = { ...createWebPlatform(), copyText: vi.fn().mockResolvedValue(false) };
        const platform = createNativePlatform(plugins, fallback);
        expect(await platform.copyText('x')).toBe(false);
        expect(fallback.copyText).toHaveBeenCalledWith('x');
    });

    test('saveFile writes to the app cache and opens the share sheet with the file', async () => {
        const plugins = fakePlugins();
        const platform = createNativePlatform(plugins);
        const result = await platform.saveFile({ filename: 'select-query.sql', text: 'SELECT 1;\n', mimeType: 'application/sql' });
        expect(result).toEqual({ status: 'shared' });
        expect(plugins.Filesystem.writeFile).toHaveBeenCalledWith({
            path: 'exports/select-query.sql', data: 'SELECT 1;\n', directory: 'CACHE', encoding: 'utf8', recursive: true
        });
        expect(plugins.Share.share).toHaveBeenCalledWith(expect.objectContaining({ files: ['file:///cache/exports/q.sql'] }));
    });

    test('saveFile reports cancellation and failures distinctly', async () => {
        const cancelled = fakePlugins({ Share: { share: vi.fn().mockRejectedValue(new Error('Share canceled')) } });
        expect(await createNativePlatform(cancelled).saveFile({ filename: 'a.sql', text: '' })).toEqual({ status: 'cancelled' });

        const writeFails = fakePlugins();
        writeFails.Filesystem.writeFile.mockRejectedValue(new Error('disk full'));
        expect(await createNativePlatform(writeFails).saveFile({ filename: 'a.sql', text: '' }))
            .toEqual({ status: 'failed', message: 'The file could not be created (disk full).' });

        const shareFails = fakePlugins({ Share: { share: vi.fn().mockRejectedValue(new Error('No Activity found')) } });
        expect(await createNativePlatform(shareFails).saveFile({ filename: 'a.sql', text: '' }))
            .toEqual({ status: 'failed', message: 'No Activity found' });
    });

    test('shareText opens the share sheet with the SQL', async () => {
        const plugins = fakePlugins();
        const platform = createNativePlatform(plugins);
        expect(await platform.shareText({ title: 'SQL query', text: 'SELECT 1;' })).toEqual({ status: 'shared' });
        expect(plugins.Share.share).toHaveBeenCalledWith({ title: 'SQL query', text: 'SELECT 1;', dialogTitle: 'SQL query' });
    });

    test('back button: consumed by the handler, otherwise the app goes to the background', () => {
        const plugins = fakePlugins();
        const platform = createNativePlatform(plugins);
        let consume = true;
        platform.onBack(() => consume);
        plugins.listeners.backButton();
        expect(plugins.App.minimizeApp).not.toHaveBeenCalled();
        consume = false;
        plugins.listeners.backButton();
        expect(plugins.App.minimizeApp).toHaveBeenCalledTimes(1);
    });

    test('appearance maps to system bar styles; ready hides the splash', () => {
        const plugins = fakePlugins();
        const platform = createNativePlatform(plugins);
        platform.setAppearance('dark');
        platform.setAppearance('light');
        expect(plugins.SystemBars.setStyle.mock.calls).toEqual([[{ style: 'DARK' }], [{ style: 'LIGHT' }]]);
        platform.ready();
        expect(plugins.SplashScreen.hide).toHaveBeenCalled();
    });

    test('safeFilename', () => {
        expect(safeFilename('select-query.sql')).toBe('select-query.sql');
        expect(safeFilename('../../etc/passwd')).toBe('etc-passwd');
        expect(safeFilename('my query?.sql')).toBe('my-query-.sql');
        expect(safeFilename('...')).toBe('export.txt');
    });
});

describe('runtime compatibility check', () => {
    test('detects missing APIs and explains how to fix it', () => {
        expect(isSupportedRuntime({ structuredClone() {}, HTMLDialogElement: function () {} })).toBe(true);
        expect(isSupportedRuntime({ HTMLDialogElement: function () {} })).toBe(false);
        document.body.innerHTML = '<main><p>app</p></main>';
        showUnsupportedMessage(document);
        expect(document.querySelector('[role="alert"]').textContent).toContain('Android System WebView');
    });
});

describe('app on a native platform', () => {
    const html = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8')
        .replace(/^[\s\S]*?<html[^>]*>/i, '').replace(/<\/html>\s*$/i, '');
    let app;
    let plugins;
    const $ = (s) => /** @type {any} */ (document.querySelector(s));
    const settle = () => vi.advanceTimersByTimeAsync(1000);
    const toast = () => $('#toast').textContent;

    async function fillQuery() {
        for (const [path, value] of [['select.from.table', 'users'], ['select.columns.0.expr', 'name']]) {
            const input = $(`[data-path="${path}"]`);
            input.value = value;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        await settle();
    }

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        document.documentElement.innerHTML = html;
        plugins = fakePlugins();
        app = startApp({ doc: document, storage: createStorage(createMemoryBackend()), platform: createNativePlatform(plugins) });
    });

    afterEach(() => {
        app.destroy();
        vi.useRealTimers();
    });

    test('Share button is shown and shares the generated SQL', async () => {
        expect($('#share-btn').hidden).toBe(false);
        await fillQuery();
        $('#share-btn').click();
        await settle();
        expect(plugins.Share.share).toHaveBeenCalledWith(expect.objectContaining({ text: 'SELECT name\nFROM users;' }));
    });

    test('Download exports through the share sheet with clear feedback', async () => {
        await fillQuery();
        $('#download-btn').click();
        await settle();
        expect(plugins.Filesystem.writeFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'exports/select-query.sql', data: 'SELECT name\nFROM users;\n' }));
        expect(toast()).toBe('Exported select-query.sql.');

        plugins.Share.share.mockRejectedValueOnce(new Error('Share canceled'));
        $('#download-btn').click();
        await settle();
        expect(toast()).toBe('Export cancelled.');

        plugins.Filesystem.writeFile.mockRejectedValueOnce(new Error('no space'));
        $('#download-btn').click();
        await settle();
        expect(toast()).toBe('Export failed: The file could not be created (no space).');
    });

    test('Copy uses the native clipboard and confirms', async () => {
        await fillQuery();
        $('#copy-btn').click();
        await settle();
        expect(plugins.Clipboard.write).toHaveBeenCalledWith({ string: 'SELECT name\nFROM users;' });
        expect(toast()).toBe('SQL copied to the clipboard.');
    });

    test('back button closes dialogs and menus before leaving the app', async () => {
        const back = () => plugins.listeners.backButton();
        $('#settings-btn').click();
        expect($('#settings-dialog').hasAttribute('open')).toBe(true);
        back();
        await settle();
        expect($('#settings-dialog').hasAttribute('open')).toBe(false);
        expect(plugins.App.minimizeApp).not.toHaveBeenCalled();

        $('#file-menu').open = true;
        back();
        expect($('#file-menu').open).toBe(false);
        expect(plugins.App.minimizeApp).not.toHaveBeenCalled();

        back();
        expect(plugins.App.minimizeApp).toHaveBeenCalledTimes(1);
    });

    test('a confirm dialog closed with back resolves as cancel (nothing deleted)', async () => {
        await fillQuery();
        $('#generate-btn').click();
        await settle();
        expect(app.history.list()).toHaveLength(1);
        $('#history-clear-btn').click();
        await settle();
        plugins.listeners.backButton();
        await settle();
        expect(app.history.list()).toHaveLength(1);
    });

    test('system bars follow the theme; storage note says "on this device"', () => {
        expect(plugins.SystemBars.setStyle).toHaveBeenCalledWith({ style: 'LIGHT' });
        $('#theme-btn').click(); // system -> light
        $('#theme-btn').click(); // light -> dark
        expect(plugins.SystemBars.setStyle).toHaveBeenLastCalledWith({ style: 'DARK' });
        expect($('#storage-note').textContent).toContain('on this device');
    });
});

describe('web platform keeps the existing behaviour', () => {
    test('Share button stays hidden in the browser build', () => {
        document.documentElement.innerHTML = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8')
            .replace(/^[\s\S]*?<html[^>]*>/i, '').replace(/<\/html>\s*$/i, '');
        const app = startApp({ doc: document, storage: createStorage(createMemoryBackend()) });
        expect(document.getElementById('share-btn').hidden).toBe(true);
        expect(document.getElementById('storage-note').textContent).toContain('in this browser');
        app.destroy();
    });
});
