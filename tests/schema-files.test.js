import { describe, expect, test } from 'vitest';
import { readDdl } from '../src/ddl.js';
import { createSchemaStore } from '../src/schema.js';
import {
    readSchemaInput, createSchemaExport, createBackup, parseBackupFile, parseQueryFile, parseTemplatesFile,
    APP_ID, BACKUP_FORMAT
} from '../src/serialization.js';
import { createStorage, createMemoryBackend } from '../src/storage.js';
import { sanitizeSettings } from '../src/settings.js';
import { EXAMPLES } from '../src/examples.js';
import { generateSQL } from '../src/generator.js';
import { PG_DUMP } from './fixtures/ddl.js';

const memoryStorage = () => createStorage(createMemoryBackend());
// A table's shape without the reader's position info
const shape = (tables) => JSON.parse(JSON.stringify(tables));

describe('schema files and backups', () => {
    test('readSchemaInput: JSON schema files, bare lists, and CREATE TABLE text', () => {
        const tables = readDdl(PG_DUMP).tables;
        const exported = JSON.stringify(createSchemaExport(tables));
        expect(JSON.parse(exported)).toMatchObject({ app: APP_ID, kind: 'schema', format: 'sql-builder-schema', version: 1 });
        const fromJson = readSchemaInput(exported);
        expect(fromJson.ok && shape(fromJson.tables)).toEqual(shape(tables));
        expect(readSchemaInput('[{"name":"t","columns":["a"]}]')).toMatchObject({ ok: true, source: 'json' });
        const fromSql = readSchemaInput(PG_DUMP);
        expect(fromSql).toMatchObject({ ok: true, source: 'sql' });
    });

    test('readSchemaInput explains what is wrong', () => {
        const error = (text) => { const r = readSchemaInput(text); return r.ok ? null : r.error; };
        expect(error('   ')).toMatch(/Paste CREATE TABLE/);
        expect(error('{ nope')).toBe("The file isn't valid JSON.");
        expect(error('{"kind":"backup"}')).toMatch(/full backup/);
        expect(error('{"kind":"templates","templates":[]}')).toMatch(/templates file/);
        expect(error('{"tables":{}}')).toMatch(/list of tables/);
        expect(error('{"tables":[{"name":"t","columns":["a","a"]}]}')).toBe('Schema: t has two columns named a.');
        expect(error('SELECT 1;')).toBe('No CREATE TABLE statements were found; only other statements.');
        expect(error('hello')).toBe('No CREATE TABLE statements were found; only other statements.');
        expect(error('x'.repeat(4 * 1024 * 1024 + 1))).toMatch(/too long/);
    });

    test('other importers point a schema file to the Schema panel', () => {
        const file = JSON.stringify(createSchemaExport([]));
        expect(parseQueryFile(file)).toMatchObject({ ok: false, error: 'This is a schema file. Import it from the Schema panel.' });
        expect(parseTemplatesFile(file)).toMatchObject({ ok: false, error: 'This is a schema file. Import it from the Schema panel.' });
        expect(parseBackupFile(file)).toMatchObject({ ok: false, error: 'This is a schema file. Import it from the Schema panel.' });
    });

    test('backup version 2 carries the schema; version 1 files have none', () => {
        const schema = readDdl(PG_DUMP).tables;
        const backup = createBackup({ templates: [], history: [], settings: sanitizeSettings({}), schema });
        expect(backup.version).toBe(2);
        const parsed = parseBackupFile(JSON.stringify(backup));
        expect(parsed.ok && shape(parsed.schema)).toEqual(shape(schema));

        const v1 = { app: APP_ID, kind: 'backup', format: BACKUP_FORMAT, version: 1, settings: {}, templates: [], history: [] };
        expect(parseBackupFile(JSON.stringify(v1))).toMatchObject({ ok: true, schema: null });
        const damaged = { ...backup, schema: { tables: [{ name: 't', columns: ['a', 'a'] }] } };
        expect(parseBackupFile(JSON.stringify(damaged))).toMatchObject({ ok: false, error: "The backup's schema: t has two columns named a." });
        expect(parseBackupFile(JSON.stringify({ ...backup, schema: 'x' }))).toMatchObject({ ok: false });
    });

    test('the schema never changes generated SQL', () => {
        // The generator doesn't import the schema modules at all
        const before = EXAMPLES.map(e => generateSQL(e.build(), { dialect: 'sqlserver' }));
        const schema = createSchemaStore(memoryStorage());
        schema.apply(readDdl(PG_DUMP).tables);
        expect(EXAMPLES.map(e => generateSQL(e.build(), { dialect: 'sqlserver' }))).toEqual(before);
    });
});
