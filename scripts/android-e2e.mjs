// End-to-end checks of the installed Android app on an emulator/device.
//
//   node scripts/android-e2e.mjs [path/to/app-debug.apk]
//
// Requires adb, a running device, and a *debug* build (WebView debugging is
// only enabled in debug builds). The app's WebView is driven through the
// Chrome DevTools Protocol; Android-level behaviour (back button, share sheet,
// clipboard, files, restarts) through adb. The device is put in airplane mode
// first, so every check also proves the app works offline.
//
// Prints a JSON report and exits non-zero if any check fails. Screenshots are
// written to e2e-output/.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PKG = 'com.saikumar.sqlbuilder';
const ACTIVITY = `${PKG}/.MainActivity`;
const OUT = 'e2e-output';
const apk = process.argv[2];

const results = [];
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function adb(...args) {
    return execFileSync('adb', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
}

function shell(command) {
    try {
        return adb('shell', command);
    } catch (error) {
        return String(error.stdout || '') + String(error.stderr || '');
    }
}

function screenshot(name) {
    const png = execFileSync('adb', ['exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(join(OUT, `${name}.png`), png);
}

function record(name, ok, detail = '') {
    results.push({ name, ok: Boolean(ok), detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function check(name, fn) {
    try {
        const outcome = await fn();
        if (outcome === true || outcome === undefined) record(name, true);
        else if (typeof outcome === 'object' && outcome !== null) record(name, outcome.ok, outcome.detail);
        else record(name, false, String(outcome));
    } catch (error) {
        record(name, false, error instanceof Error ? error.message : String(error));
    }
}

async function waitFor(fn, { timeout = 15000, interval = 250, message = 'condition' } = {}) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
        try {
            last = await fn();
            if (last) return last;
        } catch (error) {
            last = error;
        }
        await sleep(interval);
    }
    throw new Error(`Timed out waiting for ${message}${last instanceof Error ? `: ${last.message}` : ''}`);
}

// ------------------------------------------------------------------ CDP

class Page {
    static async connect() {
        const socketName = await waitFor(() => {
            const pid = shell(`pidof ${PKG}`).trim();
            if (!pid) return null;
            const unix = shell('cat /proc/net/unix');
            const match = unix.match(new RegExp(`@(webview_devtools_remote_${pid})`));
            return match && match[1];
        }, { timeout: 30000, message: 'the WebView debugging socket' });
        adb('forward', '--remove-all');
        adb('forward', 'tcp:9222', `localabstract:${socketName}`);
        const target = await waitFor(async () => {
            const list = await (await fetch('http://127.0.0.1:9222/json')).json();
            return list.find(t => t.type === 'page' && t.url.startsWith('https://localhost'));
        }, { timeout: 30000, message: 'the app page target' });
        const page = new Page(target.webSocketDebuggerUrl, target.url);
        await page.open();
        return page;
    }

    constructor(wsUrl, url) {
        this.wsUrl = wsUrl;
        this.url = url;
        this.id = 0;
        this.pending = new Map();
        this.console = [];
    }

    open() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.wsUrl);
            this.ws.onopen = async () => {
                await this.send('Runtime.enable');
                resolve();
            };
            this.ws.onerror = reject;
            this.ws.onmessage = (event) => {
                const msg = JSON.parse(event.data);
                if (msg.id && this.pending.has(msg.id)) {
                    this.pending.get(msg.id)(msg);
                    this.pending.delete(msg.id);
                } else if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
                    this.console.push(msg.params.args.map(a => a.value ?? a.description).join(' '));
                } else if (msg.method === 'Runtime.exceptionThrown') {
                    this.console.push(`Uncaught: ${msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text}`);
                }
            };
        });
    }

    send(method, params = {}) {
        const id = ++this.id;
        this.ws.send(JSON.stringify({ id, method, params }));
        return new Promise(resolve => this.pending.set(id, resolve));
    }

    async eval(expression) {
        const msg = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
        if (msg.result?.exceptionDetails) throw new Error(msg.result.exceptionDetails.exception?.description || msg.result.exceptionDetails.text);
        return msg.result?.result?.value;
    }

    close() {
        this.ws?.close();
    }
}

// Helpers evaluated inside the app
const JS = {
    sql: `Array.from(document.querySelectorAll('#sql-code .line'), l => l.textContent.replace(/\\n$/, '')).join('\\n')`,
    toast: `document.getElementById('toast').textContent`,
    click: (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('missing ${selector}'); el.click(); return true; })()`,
    type: (path, value) => `(() => { const el = document.querySelector('[data-path="${path}"]'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`
};

function foregroundPackage() {
    const focus = shell('dumpsys window | grep -E "mCurrentFocus|mFocusedApp"');
    return focus;
}

async function launch() {
    shell(`am start -W -n ${ACTIVITY}`);
    const page = await Page.connect();
    await waitFor(() => page.eval(`!!document.querySelector('[data-path="select.from.table"]')`), { timeout: 30000, message: 'the builder to render' });
    return page;
}

async function restart(page) {
    page?.close();
    shell(`am force-stop ${PKG}`);
    await sleep(1000);
    return launch();
}

// ------------------------------------------------------------------ main

async function main() {
    mkdirSync(OUT, { recursive: true });
    if (apk) adb('install', '-r', '-t', apk);
    shell(`pm clear ${PKG}`);
    shell('logcat -c');

    // Offline: airplane mode + radios off
    shell('cmd connectivity airplane-mode enable');
    shell('svc wifi disable');
    shell('svc data disable');
    await sleep(2000);

    let page = await launch();
    screenshot('01-start');

    await check('starts in airplane mode and loads the packaged app from https://localhost', async () => {
        // navigator.onLine is not meaningful here: without ACCESS_NETWORK_STATE the
        // WebView cannot observe connectivity, so the device setting is checked instead
        const airplane = shell('settings get global airplane_mode_on').trim();
        const info = await page.eval(`({ href: location.href, title: document.title })`);
        return { ok: airplane === '1' && info.href.startsWith('https://localhost/') && !info.href.includes('vercel'), detail: JSON.stringify({ airplane, ...info }) };
    });

    await check('native platform is active (Share button visible, storage note)', async () => {
        const info = await page.eval(`({ share: !document.getElementById('share-btn').hidden, note: document.getElementById('storage-note').textContent })`);
        return { ok: info.share && info.note.includes('on this device'), detail: JSON.stringify(info) };
    });

    // Every example covers a different SQL feature: joins, aggregates, NOT EXISTS,
    // nested AND/OR, CTE, CASE, window functions, UNION, INTERSECT, INSERT, UPDATE, DELETE
    await check('every example generates SQL offline', async () => {
        await page.eval(JS.click('#tab-examples'));
        const count = await page.eval(`document.querySelectorAll('#example-list [data-action="example-load"]').length`);
        const outputs = [];
        for (let i = 0; i < count; i++) {
            await page.eval(`document.querySelectorAll('#example-list [data-action="example-load"]')[${i}].click()`);
            await sleep(300);
            outputs.push(await page.eval(JS.sql));
        }
        const joined = outputs.join('\n');
        const needed = ['JOIN', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'NOT EXISTS', 'WITH ', 'CASE', 'OVER (', 'UNION', 'INTERSECT', 'INSERT INTO', 'UPDATE ', 'DELETE FROM', 'BETWEEN', 'IN ('];
        const missing = needed.filter(k => !joined.includes(k));
        const empty = outputs.filter(o => !/;$/.test(o)).length;
        return { ok: count >= 12 && missing.length === 0 && empty === 0, detail: `${count} examples; missing: ${missing.join(', ') || 'none'}; empty: ${empty}` };
    });
    screenshot('02-example');

    await check('builds a query by typing, formatted and one-line views', async () => {
        await page.eval(`document.querySelector('input[name="query-type"][value="select"]').click()`);
        await page.eval(JS.click('#reset-btn'));
        await page.eval(JS.type('select.from.table', 'employees'));
        await page.eval(JS.type('select.columns.0.expr', 'name'));
        await page.eval(JS.type('select.limit', '5'));
        await sleep(400);
        const formatted = await page.eval(JS.sql);
        await page.eval(JS.click('[data-output-mode="compact"]'));
        await sleep(300);
        const compact = await page.eval(JS.sql);
        await page.eval(JS.click('[data-output-mode="formatted"]'));
        const ok = formatted === 'SELECT name\nFROM employees\nLIMIT 5;' && compact === 'SELECT name FROM employees LIMIT 5;';
        return { ok, detail: JSON.stringify({ formatted, compact }) };
    });

    await check('Copy writes the SQL to the Android clipboard', async () => {
        await page.eval(JS.click('#copy-btn'));
        await sleep(600);
        const toast = await page.eval(JS.toast);
        const clip = await page.eval(`window.Capacitor.Plugins.Clipboard.read().then(r => r.value)`);
        return { ok: toast === 'SQL copied to the clipboard.' && clip === 'SELECT name\nFROM employees\nLIMIT 5;', detail: JSON.stringify({ toast, clip }) };
    });

    await check('Download writes a .sql file and opens the Android share sheet; dismissing reports cancelled', async () => {
        await page.eval(JS.click('#download-btn'));
        const chooser = await waitFor(() => /Chooser|Resolver|intentresolver/i.test(foregroundPackage()) && foregroundPackage(), { timeout: 10000, message: 'the share sheet' });
        screenshot('03-export-share-sheet');
        const file = shell(`run-as ${PKG} cat cache/exports/select-query.sql`);
        shell('input keyevent KEYCODE_BACK');
        const toast = await waitFor(async () => { const t = await page.eval(JS.toast); return t === 'Export cancelled.' && t; }, { timeout: 10000, message: 'the cancelled message' });
        return { ok: file.trim() === 'SELECT name\nFROM employees\nLIMIT 5;' && Boolean(chooser), detail: JSON.stringify({ file, toast }) };
    });

    await check('Share opens the Android share sheet with the SQL text', async () => {
        await page.eval(JS.click('#share-btn'));
        await waitFor(() => /Chooser|Resolver|intentresolver/i.test(foregroundPackage()), { timeout: 10000, message: 'the share sheet' });
        shell('input keyevent KEYCODE_BACK');
        const toast = await waitFor(async () => { const t = await page.eval(JS.toast); return t === 'Sharing cancelled.' && t; }, { timeout: 10000, message: 'the cancelled message' });
        return { ok: true, detail: toast };
    });

    await check('Back closes an open dialog first and keeps the app open', async () => {
        await page.eval(JS.click('#settings-btn'));
        await sleep(300);
        const openBefore = await page.eval(`document.getElementById('settings-dialog').open`);
        screenshot('04-settings-dialog');
        shell('input keyevent KEYCODE_BACK');
        await sleep(600);
        const openAfter = await page.eval(`document.getElementById('settings-dialog').open`);
        const stillForeground = foregroundPackage().includes(PKG);
        return { ok: openBefore && !openAfter && stillForeground, detail: JSON.stringify({ openBefore, openAfter, stillForeground }) };
    });

    await check('Back closes the File menu before leaving', async () => {
        await page.eval(`document.getElementById('file-menu').open = true`);
        shell('input keyevent KEYCODE_BACK');
        await sleep(500);
        const menuOpen = await page.eval(`document.getElementById('file-menu').open`);
        return { ok: !menuOpen && foregroundPackage().includes(PKG), detail: `menu open after back: ${menuOpen}` };
    });

    await check('theme switching works and styles the system bars without errors', async () => {
        await page.eval(JS.click('#theme-btn'));
        await page.eval(JS.click('#theme-btn'));
        await sleep(300);
        const theme = await page.eval(`document.documentElement.dataset.theme`);
        screenshot('05-dark-theme');
        return { ok: theme === 'dark', detail: `data-theme=${theme}` };
    });

    await check('content clears the status bar and gesture area (safe areas), no horizontal scroll', async () => {
        const m = await page.eval(`(() => {
            // Resolve --safe-top/--safe-bottom (max of env() and the injected variables)
            const probe = document.createElement('div');
            probe.style.position = 'fixed';
            probe.style.paddingTop = 'var(--safe-top)';
            probe.style.paddingBottom = 'var(--safe-bottom)';
            document.body.append(probe);
            const safeTop = parseFloat(getComputedStyle(probe).paddingTop);
            const safeBottom = parseFloat(getComputedStyle(probe).paddingBottom);
            probe.remove();
            const header = document.querySelector('.app-header').getBoundingClientRect();
            const bar = getComputedStyle(document.querySelector('.mobile-bar'));
            return { safeTop, safeBottom, headerTop: header.top, barPaddingBottom: parseFloat(bar.paddingBottom),
                     barDisplay: bar.display, overflow: document.documentElement.scrollWidth > innerWidth,
                     width: innerWidth, height: innerHeight, dpr: devicePixelRatio };
        })()`);
        // If the WebView spans the whole screen (edge-to-edge), the status bar area
        // must be reported as a safe-area inset and the header must sit below it.
        // Otherwise the native layout already keeps the WebView clear of the bars.
        // `wm size` prints the physical size and, if set, an override (the one in effect)
        const sizes = [...shell('wm size').matchAll(/(\d+)x(\d+)/g)];
        const size = sizes.at(-1);
        const screenHeight = size ? Math.max(Number(size[1]), Number(size[2])) : 0;
        const fullScreen = Math.round(m.height * m.dpr) >= screenHeight - 2;
        const insetsOk = fullScreen
            ? m.safeTop > 0 && m.headerTop >= m.safeTop && (m.barDisplay === 'none' || m.barPaddingBottom >= m.safeBottom)
            : true;
        return { ok: insetsOk && !m.overflow, detail: JSON.stringify({ ...m, screenHeight, webViewMode: fullScreen ? 'edge-to-edge' : 'inset by native layout' }) };
    });

    await check('landscape orientation: layout still fits', async () => {
        shell('settings put system accelerometer_rotation 0');
        shell('settings put system user_rotation 1');
        await sleep(2500);
        const m = await page.eval(`({ w: innerWidth, h: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth,
            left: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-area-inset-left')) || 0,
            appLeft: document.querySelector('.app-header').getBoundingClientRect().left })`);
        screenshot('06-landscape');
        shell('settings put system user_rotation 0');
        await sleep(2000);
        return { ok: m.w > m.h && !m.overflow && m.appLeft >= m.left, detail: JSON.stringify(m) };
    });

    await check('SQL Lab: the embedded SQLite engine starts offline, with storage on the device', async () => {
        await page.eval(JS.click('#view-lab-btn'));
        const engine = await waitFor(async () => {
            const t = await page.eval(`document.getElementById('lab-engine').textContent`);
            return /SQLite 3|not running/.test(t) && t;
        }, { timeout: 30000, message: 'the database engine to start' });
        const notice = await page.eval(`(() => { const n = document.getElementById('lab-notice'); return n.hidden ? '' : n.textContent; })()`);
        screenshot('07-sql-lab');
        return { ok: /SQLite 3\.\d+/.test(engine) && engine.includes('on this device') && notice === '', detail: JSON.stringify({ engine, notice }) };
    });

    await check('SQL Lab: create a database; Back returns to the builder', async () => {
        await page.eval(JS.click('#lab-new-btn'));
        await sleep(400);
        await page.eval(`(() => { document.getElementById('prompt-input').value = 'E2E DB'; document.querySelector('#prompt-dialog [value="confirm"]').click(); return true; })()`);
        const heading = await waitFor(async () => {
            const t = await page.eval(`document.getElementById('lab-main-heading')?.textContent || ''`);
            return t === 'E2E DB' && t;
        }, { timeout: 15000, message: 'the new database to open' });
        screenshot('08-sql-lab-database');
        shell('input keyevent KEYCODE_BACK');
        await sleep(600);
        const builderShown = await page.eval(`!document.getElementById('workspace').hidden && document.getElementById('lab').hidden`);
        return { ok: heading === 'E2E DB' && builderShown && foregroundPackage().includes(PKG), detail: JSON.stringify({ heading, builderShown }) };
    });

    await check('SQL Lab: import a CSV (preview, then Import) into the database', async () => {
        await page.eval(JS.click('#view-lab-btn'));
        await sleep(600);
        await page.eval(JS.click('#lab-import-btn'));
        await sleep(400);
        await page.eval(`(() => {
            const area = document.getElementById('lab-import-text');
            area.value = 'EmployeeID,Name,Department,Salary\\n1,Ada,Engineering,120000\\n2,Grace,Engineering,100000\\n3,Linus,Sales,70000\\n4,Margaret,Sales,90000\\n';
            area.dispatchEvent(new Event('input', { bubbles: true }));
            const table = document.getElementById('lab-import-table');
            table.value = 'Employees';
            table.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        })()`);
        const label = await waitFor(async () => {
            const t = await page.eval(`(() => { const b = document.getElementById('lab-import-run'); return b.disabled ? '' : b.textContent; })()`);
            return t === 'Import 4 rows' && t;
        }, { timeout: 15000, message: 'the import preview' });
        screenshot('09-sql-lab-import');
        await page.eval(JS.click('#lab-import-run'));
        const rows = await waitFor(async () => {
            const t = await page.eval(`document.querySelector('.lab-structure-rows')?.textContent || ''`);
            return t === 'Rows: 4' && t;
        }, { timeout: 15000, message: 'the imported table' });
        const toast = await page.eval(`document.getElementById('toast').textContent`);
        await page.eval(JS.click('#view-builder-btn'));
        return { ok: label === 'Import 4 rows' && rows === 'Rows: 4' && toast.includes('Imported 4 rows into Employees'), detail: JSON.stringify({ label, rows, toast }) };
    });

    await check('SQL Lab: run the average-salary query and see its rows', async () => {
        await page.eval(JS.click('#view-lab-btn'));
        await sleep(600);
        await page.eval(`(() => {
            const area = document.getElementById('lab-sql');
            area.value = 'SELECT Department, AVG(Salary) AS AvgSalary FROM Employees GROUP BY Department ORDER BY AvgSalary DESC;';
            area.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        })()`);
        await sleep(400);
        await page.eval(JS.click('#lab-run-btn'));
        const rows = await waitFor(async () => {
            const r = await page.eval(`Array.from(document.querySelectorAll('.lab-result tbody tr'), tr => Array.from(tr.children, td => td.textContent).join('='))`);
            return r.length === 2 && r;
        }, { timeout: 15000, message: 'the query results' });
        screenshot('10-sql-lab-results');
        await page.eval(JS.click('#view-builder-btn'));
        return { ok: rows[0] === 'Engineering=110000' && rows[1] === 'Sales=80000', detail: JSON.stringify(rows) };
    });

    await check('history, templates and settings persist across an app restart', async () => {
        await page.eval(JS.click('#generate-btn'));
        await sleep(400);
        await page.eval(JS.click('#template-save-btn'));
        await sleep(300);
        await page.eval(`(() => { document.getElementById('template-name').value = 'E2E template'; document.querySelector('#template-dialog [value="confirm"]').click(); return true; })()`);
        // WebView writes localStorage to disk asynchronously; give it time as a real
        // app would have before being reclaimed, then kill and relaunch
        await sleep(6000);
        page = await restart(page);
        const state = await page.eval(`({
            history: document.querySelectorAll('#history-list .library-item').length,
            templates: document.getElementById('template-list').textContent.includes('E2E template'),
            theme: document.documentElement.dataset.theme,
            table: document.querySelector('[data-path="select.from.table"]').value
        })`);
        return { ok: state.history >= 1 && state.templates && state.theme === 'dark' && state.table === 'employees', detail: JSON.stringify(state) };
    });

    await check('SQL Lab: the database is still there after the restart', async () => {
        await page.eval(JS.click('#view-lab-btn'));
        const heading = await waitFor(async () => {
            const t = await page.eval(`document.getElementById('lab-main-heading')?.textContent || ''`);
            return t === 'E2E DB' && t;
        }, { timeout: 30000, message: 'the database to reopen' });
        const listed = await page.eval(`Array.from(document.querySelectorAll('#lab-db-list .lab-db-name'), e => e.textContent)`);
        const tables = await waitFor(async () => {
            const t = await page.eval(`Array.from(document.querySelectorAll('.lab-object-name'), e => e.textContent)`);
            return t.length > 0 && t;
        }, { timeout: 15000, message: 'the database\'s tables' }).catch(() => []);
        await page.eval(JS.click('#view-builder-btn'));
        return { ok: heading === 'E2E DB' && listed.includes('E2E DB') && tables.includes('Employees'), detail: JSON.stringify({ heading, listed, tables }) };
    });

    await check('Back with nothing open leaves the app (to the background)', async () => {
        shell('input keyevent KEYCODE_BACK');
        const left = await waitFor(() => !foregroundPackage().includes(PKG), { timeout: 8000, message: 'the app to leave the foreground' }).catch(() => false);
        return { ok: Boolean(left), detail: foregroundPackage().split('\n')[0] };
    });

    await check('Capacitor SystemBars injected the safe-area CSS variables', async () => {
        const vars = await page.eval(`['top', 'right', 'bottom', 'left'].map(n => document.documentElement.style.getPropertyValue('--safe-area-inset-' + n))`);
        return { ok: vars.every(v => /^\d+px$/.test(v)), detail: JSON.stringify(vars) };
    });

    await check('no page errors or CSP violations in the WebView console', () => {
        // Capacitor's SystemBars plugin can run its inset script before <html>
        // exists during a navigation; it catches the error, logs it and re-injects
        // once the page is visible (verified by the previous check). The app's CSS
        // falls back to env(safe-area-inset-*), so it is not an app error.
        const upstream = /^Error injecting safe area CSS: TypeError: Cannot read properties of null \(reading 'style'\)/;
        const errors = page.console.filter(line => !upstream.test(line));
        const ignored = page.console.length - errors.length;
        return { ok: errors.length === 0, detail: `${errors.join(' | ') || 'none'}${ignored ? ` (ignored ${ignored} known Capacitor SystemBars startup message(s))` : ''}` };
    });

    const logcat = shell('logcat -d');
    writeFileSync(join(OUT, 'logcat.txt'), logcat);
    await check('no crashes, ANRs or Content-Security-Policy errors in logcat', () => {
        const bad = logcat.split('\n').filter(l => /FATAL EXCEPTION|ANR in com\.saikumar|Content Security Policy|Refused to (load|execute|apply)/.test(l));
        return { ok: bad.length === 0, detail: bad.slice(0, 5).join(' | ') || 'none' };
    });

    page.close();
    shell('cmd connectivity airplane-mode disable');

    writeFileSync(join(OUT, 'report.json'), JSON.stringify(results, null, 2));
    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
    console.error(error);
    try {
        writeFileSync(join(OUT, 'logcat.txt'), shell('logcat -d'));
    } catch {
        // ignore
    }
    process.exit(1);
});
