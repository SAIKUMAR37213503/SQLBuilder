// @vitest-environment jsdom
// Smoke test for the committed browser bundle (what index.html actually loads).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const root = join(import.meta.dirname, '..');

test('dist/sqlbuilder.js boots the app from index.html', () => {
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    expect(html).toContain('<script src="dist/sqlbuilder.js" defer></script>');
    document.documentElement.innerHTML = html.replace(/^[\s\S]*?<html[^>]*>/i, '').replace(/<\/html>\s*$/i, '');

    // Run the classic script exactly as a browser would (not as a module)
    new Function(readFileSync(join(root, 'dist', 'sqlbuilder.js'), 'utf8'))();

    const table = document.querySelector('[data-path="select.from.table"]');
    const column = document.querySelector('[data-path="select.columns.0.expr"]');
    table.value = 'users';
    column.value = 'name';
    table.dispatchEvent(new Event('input', { bubbles: true }));
    column.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('generate-btn').click();
    expect(document.getElementById('sql-code').textContent).toBe('SELECT name\nFROM users;\n');
});

test('no inline scripts or styles (the CSP forbids them)', () => {
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    for (const file of ['src/ui/builder.js', 'src/ui/library.js', 'src/app.js']) {
        expect(readFileSync(join(root, file), 'utf8')).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML\s*=/);
    }
});
