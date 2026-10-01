import { describe, expect, test } from 'vitest';
import { lex, significant } from '../src/sql-lexer.js';
import { readDdl } from '../src/ddl.js';
import {
    readTable, readTables, findTable, tableToDdl, schemaToDdl, createSchemaStore, SchemaError,
    SCHEMA_TABLE_LIMIT, SCHEMA_COLUMN_LIMIT
} from '../src/schema.js';
import { createStorage, createMemoryBackend, STORAGE_PREFIX } from '../src/storage.js';
import { PG_DUMP } from './fixtures/ddl.js';

const memoryStorage = (initial) => createStorage(createMemoryBackend(initial));
const types = (text, options) => significant(lex(text, options)).map(t => `${t.type}:${t.value ?? t.text}`);
// A table's shape without the reader's position info
const shape = (tables) => JSON.parse(JSON.stringify(tables));

describe('SQL lexer', () => {
    test('reads strings, quoted names, parameters, numbers and operators', () => {
        expect(types(`SELECT "a""b", [c d], \`e\`, 'it''s', N'x', 1.5e3, .5, ?, $1, :name, a::int, b <> c`)).toEqual([
            'word:SELECT', 'quoted:a"b', 'punct:,', 'quoted:c d', 'punct:,', 'quoted:e', 'punct:,', "string:it's", 'punct:,',
            'string:x', 'punct:,', 'number:1.5e3', 'punct:,', 'number:.5', 'punct:,', 'param:?', 'punct:,', 'param:$1', 'punct:,',
            'param::name', 'punct:,', 'word:a', 'op:::', 'word:int', 'punct:,', 'word:b', 'op:<>', 'word:c'
        ]);
    });

    test('T-SQL @names and #temp tables are words; a lone @ or # is an operator', () => {
        expect(types('@id #tmp @@ROWCOUNT a @> b c <@ d e<=>f g @ h')).toEqual([
            'word:@id', 'word:#tmp', 'word:@@ROWCOUNT', 'word:a', 'op:@>', 'word:b', 'word:c', 'op:<@', 'word:d',
            'word:e', 'op:<=>', 'word:f', 'word:g', 'op:@', 'word:h'
        ]);
    });

    test('keeps positions, skips comments and reads dollar-quoted bodies whole', () => {
        const tokens = lex("-- note\n/* block\n */ CREATE $$ a; b $$ x");
        const create = tokens.find(t => t.text === 'CREATE');
        expect(create).toMatchObject({ line: 3, col: 5 });
        expect(significant(tokens).map(t => t.type)).toEqual(['word', 'string', 'word']);
        expect(significant(tokens)[1].value).toBe(' a; b ');
    });

    test('MySQL options: backslash escapes and # comments', () => {
        expect(types("'a\\'b' # c", { backslashEscapes: true, hashComments: true })).toEqual(["string:a'b"]);
        expect(types('#temp')).toEqual(['word:#temp']); // SQL Server temp table
    });

    test('never throws: unclosed text is marked, unknown characters become operators', () => {
        const tokens = lex("x 'open");
        expect(tokens.at(-1)).toMatchObject({ type: 'string', unterminated: true });
        expect(lex('/* open').at(-1)).toMatchObject({ type: 'comment', unterminated: true });
        expect(lex('[open').at(-1)).toMatchObject({ type: 'quoted', unterminated: true });
        expect(types('a ~ b 😀')).toEqual(['word:a', 'op:~', 'word:b', 'op:😀']);
        expect(() => lex('\u0000￿'.repeat(1000))).not.toThrow();
    });

    test('unicode names', () => {
        expect(types('SELECT prénom FROM données')).toEqual(['word:SELECT', 'word:prénom', 'word:FROM', 'word:données']);
    });
});


const MYSQL_DUMP = "CREATE TABLE `customers` (\n  `id` int NOT NULL AUTO_INCREMENT,\n  `name` varchar(50) NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB;\n" +
    "CREATE TABLE `orders` (\n  `id` int unsigned NOT NULL AUTO_INCREMENT,\n  `customer_id` int NOT NULL,\n  `status` enum('new','paid') DEFAULT 'new',\n" +
    "  `note` varchar(200) CHARACTER SET utf8mb4 DEFAULT NULL COMMENT 'it\\'s # not a comment',\n  PRIMARY KEY (`id`),\n  UNIQUE KEY `uq` (`customer_id`,`status`),\n" +
    "  KEY `idx_c` (`customer_id`),\n  CONSTRAINT `fk_c` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`) ON DELETE CASCADE\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n# a comment\n";

const SSMS = `SET ANSI_NULLS ON
GO
CREATE TABLE [dbo].[Customers](
	[CustomerID] [int] IDENTITY(1,1) NOT NULL,
	[Name] [nvarchar](100) NULL,
	[Total] [decimal](10, 2) NULL,
	[FullName] AS ([Name] + N'!'),
 CONSTRAINT [PK_Customers] PRIMARY KEY CLUSTERED ([CustomerID] ASC) WITH (PAD_INDEX = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
CREATE TABLE [dbo].[Orders]([OrderID] [int] NOT NULL, [CustomerID] [int] NULL)
ALTER TABLE [dbo].[Orders]  WITH CHECK ADD  CONSTRAINT [FK_O_C] FOREIGN KEY([CustomerID]) REFERENCES [dbo].[Customers] ([CustomerID])
GO
ALTER TABLE [dbo].[Orders] CHECK CONSTRAINT [FK_O_C]
GO
ALTER TABLE [dbo].[Orders] ADD  CONSTRAINT [DF_O]  DEFAULT ((0)) FOR [OrderID]
GO`;

describe('CREATE TABLE reader', () => {
    test('pg_dump: tables, types, NOT NULL, and keys added by ALTER TABLE', () => {
        const { tables, skipped, problems } = readDdl(PG_DUMP);
        expect(problems).toEqual([]);
        expect(shape(tables)).toEqual([
            {
                name: 'public.departments',
                columns: [
                    { name: 'id', type: 'integer', nullable: false },
                    { name: 'name', type: 'character varying(100)', nullable: false },
                    { name: 'created', type: 'timestamp with time zone', nullable: false },
                    { name: 'tags', type: 'text[]', nullable: true },
                    { name: 'budget', type: 'numeric(12, 2)', nullable: true }
                ],
                primaryKey: ['id'], unique: [], foreignKeys: []
            },
            {
                name: 'public.employees',
                columns: [
                    { name: 'id', type: 'integer', nullable: false },
                    { name: 'department_id', type: 'integer', nullable: true },
                    { name: 'manager_id', type: 'integer', nullable: true },
                    { name: 'email', type: 'text', nullable: false }
                ],
                primaryKey: ['id'],
                unique: [['email']],
                foreignKeys: [
                    { columns: ['department_id'], refTable: 'public.departments', refColumns: ['id'] },
                    { columns: ['manager_id'], refTable: 'public.employees', refColumns: ['id'] }
                ]
            }
        ]);
        expect(skipped).toEqual([
            { label: 'SET', count: 1 },
            { label: 'SELECT', count: 1 },
            { label: 'CREATE FUNCTION', count: 1 },
            { label: 'ALTER TABLE (other changes)', count: 1 },
            { label: 'CREATE INDEX', count: 1 }
        ]);
    });

    test('mysqldump: backticks, AUTO_INCREMENT, inline keys and \\\' in comments', () => {
        const { tables, problems } = readDdl(MYSQL_DUMP);
        expect(problems).toEqual([]);
        const orders = findTable(tables, 'ORDERS');
        expect(orders.columns.map(c => `${c.name} ${c.type}`)).toEqual([
            'id int unsigned', 'customer_id int', "status enum('new', 'paid')", 'note varchar(200)'
        ]);
        expect(orders.primaryKey).toEqual(['id']);
        expect(orders.unique).toEqual([['customer_id', 'status']]);
        expect(orders.foreignKeys).toEqual([{ columns: ['customer_id'], refTable: 'customers', refColumns: ['id'] }]);
    });

    test('SQL Server scripts: GO, brackets, statements without ";", WITH CHECK ADD', () => {
        const { tables, skipped, problems } = readDdl(SSMS);
        expect(problems).toEqual([]);
        expect(tables.map(t => t.name)).toEqual(['dbo.Customers', 'dbo.Orders']);
        expect(tables[0].columns.map(c => `${c.name}:${c.type}:${c.nullable}`)).toEqual([
            'CustomerID:int:false', 'Name:nvarchar(100):true', 'Total:decimal(10, 2):true', 'FullName::true'
        ]);
        expect(tables[0].primaryKey).toEqual(['CustomerID']);
        expect(tables[1].foreignKeys).toEqual([{ columns: ['CustomerID'], refTable: 'dbo.Customers', refColumns: ['CustomerID'] }]);
        expect(skipped).toEqual([{ label: 'SET', count: 1 }, { label: 'ALTER TABLE (other changes)', count: 1 }]);
    });

    test('hand-written: types optional, inline REFERENCES, composite keys, IF NOT EXISTS', () => {
        const { tables, problems } = readDdl(`
            create table if not exists regions (code, name);
            CREATE TABLE sales (
                region varchar(3) references regions,
                year int,
                amount decimal(10,2) not null default 0,
                primary key (region, year)
            );
            CREATE TEMPORARY TABLE t (x int unique, y int, FOREIGN KEY (y, x) REFERENCES sales (year, region));
        `);
        expect(problems).toEqual([]);
        expect(tables[0].columns).toEqual([{ name: 'code', type: '', nullable: true }, { name: 'name', type: '', nullable: true }]);
        // No key on regions, so the reference can't be completed
        expect(tables[1].foreignKeys).toEqual([{ columns: ['region'], refTable: 'regions', refColumns: [] }]);
        expect(tables[1].primaryKey).toEqual(['region', 'year']);
        expect(tables[1].columns.map(c => c.nullable)).toEqual([false, false, false]);
        expect(tables[2].unique).toEqual([['x']]);
        expect(tables[2].foreignKeys).toEqual([{ columns: ['y', 'x'], refTable: 'sales', refColumns: ['year', 'region'] }]);
    });

    test('a reference without columns uses the referenced primary key', () => {
        const { tables } = readDdl('CREATE TABLE a (id int PRIMARY KEY); CREATE TABLE b (a_id int REFERENCES a);');
        expect(tables[1].foreignKeys[0].refColumns).toEqual(['id']);
    });

    test('problems are reported with their line; other tables still load', () => {
        const { tables, problems } = readDdl([
            'CREATE TABLE ok (id int);',
            'CREATE TABLE twice (a int, a text);',
            'CREATE TABLE badkey (y int, FOREIGN KEY (z) REFERENCES ok (id));',
            'ALTER TABLE missing ADD PRIMARY KEY (id);',
            'CREATE TABLE copy LIKE ok;',
            'CREATE TABLE ok (id int, extra int);',
            'CREATE TABLE open (q varchar(10'
        ].join('\n'));
        expect(tables.map(t => `${t.name}:${t.columns.length}`)).toEqual(['ok:2']);
        expect(problems.map(p => `${p.line}: ${p.message}`)).toEqual([
            '2: twice has two columns named a.',
            "3: badkey: foreign key 1 refers to z, which isn't in the table.",
            "4: ALTER TABLE missing: the table isn't created earlier in this text, so the change was skipped.",
            '6: ok is defined more than once; the last definition is used.',
            '7: This "(" is never closed.'
        ]);
        expect(readDdl('CREATE TABLE copy LIKE ok;').skipped).toEqual([{ label: 'CREATE TABLE … LIKE', count: 1 }]);
    });

    test('an unclosed quote is reported where it starts', () => {
        const { problems } = readDdl("CREATE TABLE a (id int);\nCREATE TABLE b (s text DEFAULT 'x);");
        expect(problems.map(p => `${p.line}:${p.col} ${p.message}`)).toEqual([
            '2:16 This "(" is never closed.',
            "2:32 A quote is never closed, so the text after it can't be read."
        ]);
    });

    test('hostile input: deep nesting and long text end without throwing', () => {
        expect(() => readDdl(`CREATE TABLE t (a int DEFAULT ${'('.repeat(5000)}1${')'.repeat(5000)});`)).not.toThrow();
        expect(() => readDdl('CREATE TABLE '.repeat(20000))).not.toThrow();
        expect(() => readDdl(')'.repeat(10000) + ';,'.repeat(10000))).not.toThrow();
        const wide = `CREATE TABLE w (${Array.from({ length: SCHEMA_COLUMN_LIMIT + 1 }, (_, i) => `c${i} int`).join(', ')});`;
        expect(readDdl(wide).problems[0].message).toMatch(/more than 500 columns/);
    });

    test('names in other scripts and quotes keep their spelling', () => {
        const { tables } = readDdl('CREATE TABLE "Order Details" ("Unit Price" money, "données" text);');
        expect(tables[0].name).toBe('Order Details');
        expect(tables[0].columns.map(c => c.name)).toEqual(['Unit Price', 'données']);
    });
});

describe('schema model', () => {
    test('readTable cleans input and rejects what would be wrong', () => {
        expect(readTable({ name: ' t ', columns: ['a', { name: 'b', type: ' INT   NOT ', nullable: false }], primaryKey: ['A'] })).toEqual({
            name: 't',
            columns: [{ name: 'a', type: '', nullable: false }, { name: 'b', type: 'INT NOT', nullable: false }],
            primaryKey: ['a'], unique: [], foreignKeys: []
        });
        const error = (input) => { try { readTable(input); return null; } catch (e) { return e instanceof SchemaError ? e.message : `other: ${e}`; } };
        expect(error(null)).toBe('Table 1 is not an object.');
        expect(error({ name: '', columns: [] })).toBe('Table 1 has no name.');
        expect(error({ name: 'x'.repeat(129), columns: [] })).toMatch(/longer than 128/);
        expect(error({ name: 'a\u0000b', columns: [] })).toMatch(/control characters/);
        expect(error({ name: 't', columns: 'a' })).toBe('t: columns must be a list.');
        expect(error({ name: 't', columns: ['a', 'A'] })).toBe('t has two columns named A.');
        expect(error({ name: 't', columns: ['a'], primaryKey: ['b'] })).toMatch(/refers to b/);
        expect(error({ name: 't', columns: ['a'], unique: 'a' })).toBe('t: unique keys must be a list.');
        expect(error({ name: 't', columns: ['a'], foreignKeys: [{ columns: ['a'], refTable: 'u', refColumns: ['x', 'y'] }] })).toMatch(/1 column refers to 2/);
        expect(readTable({ name: 't', columns: [{ name: 'a', type: 'x'.repeat(100) }] }).columns[0].type).toHaveLength(64);
    });

    test('unique keys that repeat the primary key are dropped', () => {
        expect(readTable({ name: 't', columns: ['a', 'b'], primaryKey: ['a'], unique: [['A'], ['b'], ['b']] }).unique).toEqual([['b']]);
    });

    test('readTables rejects duplicate names and too many tables', () => {
        expect(() => readTables([{ name: 'a', columns: [] }, { name: 'A', columns: [] }])).toThrow('There are two tables named A.');
        expect(() => readTables(Array.from({ length: SCHEMA_TABLE_LIMIT + 1 }, (_, i) => ({ name: `t${i}`, columns: [] })))).toThrow(/at most 500/);
        expect(() => readTables({})).toThrow(/list of tables/);
    });

    test('CREATE TABLE text reads back to the same table', () => {
        const { tables } = readDdl(PG_DUMP + MYSQL_DUMP.replaceAll('`', '"').replace("\\'", "''"));
        const again = readDdl(schemaToDdl(tables));
        expect(again.problems).toEqual([]);
        expect(shape(again.tables)).toEqual(shape(tables));
        expect(tableToDdl(readTable({ name: 'order', columns: ['select', 'x y'], primaryKey: ['select'] })))
            .toBe('CREATE TABLE "order" (\n    "select" PRIMARY KEY,\n    "x y"\n);');
    });
});

describe('schema store', () => {
    const table = (name, columns = ['id'], extra = {}) => ({ name, columns, ...extra });

    test('save, rename, conflicts and remove', () => {
        const storage = memoryStorage();
        const schema = createSchemaStore(storage);
        schema.save(table('b'));
        schema.save(table('a', ['id', 'b_id'], { primaryKey: ['id'], foreignKeys: [{ columns: ['b_id'], refTable: 'B' }] }));
        expect(schema.list().map(t => t.name)).toEqual(['a', 'b']);
        expect(() => schema.save(table('A'))).toThrow('A table named a already exists.');
        schema.save(table('c'), { previousName: 'b' });
        expect(schema.list().map(t => t.name)).toEqual(['a', 'c']);
        expect(createSchemaStore(storage).list().map(t => t.name)).toEqual(['a', 'c']);
        schema.remove('A');
        schema.remove('c');
        expect(schema.size).toBe(0);
        expect(storage.get('schema')).toBe(null);
    });

    test('apply: add with replace-by-name, keep existing, or replace everything; all or nothing', () => {
        const schema = createSchemaStore(memoryStorage());
        schema.save(table('a', ['old']));
        expect(schema.apply([table('a', ['new']), table('b')])).toEqual({ added: 1, replaced: 1, kept: 0 });
        expect(schema.get('a').columns[0].name).toBe('new');
        expect(schema.apply([table('a', ['other']), table('c')], { onConflict: 'keep' })).toEqual({ added: 1, replaced: 0, kept: 1 });
        expect(schema.get('a').columns[0].name).toBe('new');
        expect(() => schema.apply([table('d'), table('D')])).toThrow(/two tables/);
        expect(schema.list().map(t => t.name)).toEqual(['a', 'b', 'c']);
        expect(schema.apply([table('z')], { replace: true })).toEqual({ added: 1, replaced: 0, kept: 0 });
        expect(schema.list().map(t => t.name)).toEqual(['z']);
    });

    test('foreign keys without columns are completed from the target table', () => {
        const schema = createSchemaStore(memoryStorage());
        schema.apply([table('child', ['p_id'], { foreignKeys: [{ columns: ['p_id'], refTable: 'parent' }] })]);
        expect(schema.get('child').foreignKeys[0].refColumns).toEqual([]);
        schema.apply([table('parent', ['id'], { primaryKey: ['id'] })]);
        expect(schema.get('child').foreignKeys[0].refColumns).toEqual(['id']);
    });

    test('a full or blocked browser storage reports an error and keeps the schema', () => {
        let full = false;
        const backend = createMemoryBackend();
        const setItem = backend.setItem;
        backend.setItem = (k, v) => { if (full) throw new Error('quota'); setItem(k, v); };
        const schema = createSchemaStore(createStorage(backend));
        schema.save(table('a'));
        full = true;
        expect(() => schema.save(table('b'))).toThrow(/storage is full/);
        expect(() => schema.apply([table('c')])).toThrow(/storage is full/);
        expect(schema.list().map(t => t.name)).toEqual(['a']);
        const blocked = createSchemaStore(createStorage(null));
        expect(() => blocked.save(table('a'))).toThrow(/unavailable/);
    });

    test('a schema over the size limit is refused', () => {
        const schema = createSchemaStore(memoryStorage());
        const big = Array.from({ length: 60 }, (_, i) => table(`t${i}`, Array.from({ length: 300 }, (__, j) => ({ name: `column_${j}_${'x'.repeat(60)}`, type: 'VARCHAR(100)' }))));
        expect(() => schema.apply(big)).toThrow(/too large/);
        expect(schema.size).toBe(0);
    });

    test('damaged stored data: bad tables are skipped, the rest load', () => {
        const storage = memoryStorage({
            [`${STORAGE_PREFIX}schema`]: JSON.stringify({ tables: [{ name: 'ok', columns: ['a'] }, { name: 'bad', columns: 'x' }, 7, { name: 'OK', columns: [] }] })
        });
        expect(createSchemaStore(storage).list().map(t => t.name)).toEqual(['ok']);
        expect(createSchemaStore(memoryStorage({ [`${STORAGE_PREFIX}schema`]: '"nope"' })).size).toBe(0);
    });
});
