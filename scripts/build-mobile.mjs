// Builds www/ — the web content packaged inside the Android (and future iOS)
// app by Capacitor. Same index.html and style.css as the website, but with the
// native entry point (src/main.native.js) and a Content-Security-Policy meta
// tag (the website gets its CSP from vercel.json headers instead).
//
// Everything the app needs is inside the package: it never loads the website.
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stamp } from './stamp-assets.mjs';

const root = join(import.meta.dirname, '..');
const out = join(root, 'www');

export const NATIVE_CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
].join('; ');

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'dist'), { recursive: true });

await build({
    entryPoints: [join(root, 'src/main.native.js')],
    bundle: true,
    minify: true,
    format: 'iife',
    target: 'es2022',
    legalComments: 'none',
    outfile: join(out, 'dist/sqlbuilder.js'),
    logLevel: 'warning'
});

cpSync(join(root, 'style.css'), join(out, 'style.css'));

let html = readFileSync(join(root, 'index.html'), 'utf8');
// Website-only features (PWA manifest / service worker) are not used in the app
html = html.replace(/\s*<link rel="manifest"[^>]*>/, '').replace(/\s*<meta name="theme-color"[^>]*>/g, '').replace(/\s*<link rel="apple-touch-icon"[^>]*>/, '');
html = html.replace('<meta charset="UTF-8">', `<meta charset="UTF-8">\n    <meta http-equiv="Content-Security-Policy" content="${NATIVE_CSP}">`);
writeFileSync(join(out, 'index.html'), stamp(html, out));

console.log('www/ built for Capacitor');
