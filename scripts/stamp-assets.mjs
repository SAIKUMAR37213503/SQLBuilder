// Adds a content hash to the asset URLs in index.html
//   style.css          -> style.css?v=<hash>
//   dist/sqlbuilder.js -> dist/sqlbuilder.js?v=<hash>
// A changed file gets a new URL, so browsers never keep using an old copy
// (earlier deployments told browsers to cache these files for a year).
// Run automatically by `npm run build`; CI fails if index.html is stale.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const ASSETS = ['style.css', 'dist/sqlbuilder.js'];

export function hashOf(file, base = root) {
    return createHash('sha256').update(readFileSync(join(base, file))).digest('hex').slice(0, 12);
}

/** @param {string} html @param {string} [base] directory the asset paths are relative to */
export function stamp(html, base = root) {
    let result = html;
    for (const file of ASSETS) {
        const escaped = file.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
        const pattern = new RegExp(`(["'])${escaped}(?:\\?v=[0-9a-f]+)?\\1`, 'g');
        if (!pattern.test(result)) throw new Error(`index.html does not reference ${file}`);
        result = result.replace(pattern, `$1${file}?v=${hashOf(file, base)}$1`);
    }
    return result;
}

if (process.argv[1] === import.meta.filename) {
    const path = join(root, 'index.html');
    const html = readFileSync(path, 'utf8');
    const stamped = stamp(html);
    if (stamped !== html) writeFileSync(path, stamped);
    console.log(stamped !== html ? 'index.html: asset versions updated' : 'index.html: asset versions up to date');
}
