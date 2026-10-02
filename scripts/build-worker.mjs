// Builds the database worker (SQLite, for the SQL Lab) into <out>/dist:
//   db-worker.js   src/db/worker.js bundled with SQLite's JavaScript
//   sqlite3.wasm   SQLite itself, copied from the pinned npm package
// Both are served from the app's own origin; nothing is loaded from a CDN.
// Run by `npm run build` (website) and scripts/build-mobile.mjs (app).
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

export async function buildWorker(out = root) {
    mkdirSync(join(out, 'dist'), { recursive: true });
    await build({
        entryPoints: [join(root, 'src/db/worker.js')],
        bundle: true,
        minify: true,
        format: 'iife',
        target: 'es2022',
        legalComments: 'none',
        // The browser build of SQLite; it finds its wasm through locateFile, not import.meta.url
        conditions: ['browser'],
        define: { 'import.meta.url': 'self.location.href' },
        outfile: join(out, 'dist/db-worker.js'),
        logLevel: 'warning'
    });
    const wasm = createRequire(import.meta.url).resolve('@sqlite.org/sqlite-wasm/sqlite3.wasm');
    copyFileSync(wasm, join(out, 'dist/sqlite3.wasm'));
}

if (process.argv[1] === import.meta.filename) {
    await buildWorker();
    console.log('dist/db-worker.js and dist/sqlite3.wasm built');
}
