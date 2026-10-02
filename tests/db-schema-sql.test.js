// Schema tab tables written as SQLite CREATE TABLE statements, checked by
// running them in the real SQLite.
import { beforeAll, describe, expect, test } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { sqliteCreateTables, sqliteType, sqliteName, sqliteTableName } from '../src/db/schema-sql.js';
import { readTables } from '../src/schema.js';
import { createSqliteAdapter } from '../src/db/sqlite-adapter.js';
import { createMemoryFiles } from '../src/db/files.js';

let sqlite3;
beforeAll(async () => {
    sqlite3 = await sqlite3InitModule();
});

describe('SQLite DDL', () => {
    test('types SQLite reads are kept as written', () => {
        for (const t of ['INT', 'VARCHAR(255)', 'DECIMAL(10,2)', 'NUMERIC(18, 0)', 'DATETIME2(7)', 'DOUBLE PRECISION', 'INT UNSIGNED', 'TIMESTAMP WITH TIME ZONE', '']) {
            expect(sqliteType(t)).toBe(t);
        }
    });

    test('types SQLite can\'t read are reduced to their leading words', () => {
        expect(sqliteType('NVARCHAR(MAX)')).toBe('NVARCHAR');
        expect(sqliteType('VARBINARY(MAX)')).toBe('VARBINARY');
        expect(sqliteType("ENUM('a','b')")).toBe('ENUM');
        expect(sqliteType('INT GENERATED ALWAYS AS IDENTITY')).toBe('INT');
        expect(sqliteType('TEXT[]')).toBe('TEXT');
        expect(sqliteType('VARCHAR(20) NOT NULL')).toBe('VARCHAR(20)');
        expect(sqliteType('(weird)')).toBe('');
    });

    test('names: keywords and unusual names are quoted; schemas are dropped', () => {
        expect(sqliteName('Employees')).toBe('Employees');
        expect(sqliteName('Order')).toBe('"Order"');
        expect(sqliteName('first name')).toBe('"first name"');
        expect(sqliteName('a"b')).toBe('"a""b"');
        expect(sqliteTableName('dbo.Employees')).toBe('Employees');
        expect(sqliteTableName('Employees')).toBe('Employees');
    });

    test('every table is created in SQLite, with keys, and adaptations are listed', async () => {
        const tables = readTables([
            { name: 'dbo.Departments', columns: [{ name: 'DepartmentID', type: 'INT' }, { name: 'Name', type: 'NVARCHAR(MAX)', nullable: false }], primaryKey: ['DepartmentID'] },
            {
                name: 'dbo.Employees',
                columns: [{ name: 'EmployeeID', type: 'INT' }, { name: 'Name', type: 'VARCHAR(100)', nullable: false }, { name: 'DepartmentID', type: 'INT' }, { name: 'Order', type: 'INT' }, { name: 'Salary', type: 'DECIMAL(10,2)' }],
                primaryKey: ['EmployeeID'],
                unique: [['Name']],
                foreignKeys: [{ columns: ['DepartmentID'], refTable: 'dbo.Departments', refColumns: ['DepartmentID'] }]
            },
            { name: 'Pairs', columns: [{ name: 'a', type: "ENUM('x','y')" }, { name: 'b' }], primaryKey: ['a', 'b'] }
        ]);
        const { sql, statements, notes } = sqliteCreateTables(tables);
        expect(statements).toHaveLength(3);
        expect(statements[1]).toBe([
            'CREATE TABLE Employees (',
            '    EmployeeID INT PRIMARY KEY,',
            '    Name VARCHAR(100) NOT NULL,',
            '    DepartmentID INT,',
            '    "Order" INT,',
            '    Salary DECIMAL(10,2),',
            '    UNIQUE (Name),',
            '    FOREIGN KEY (DepartmentID) REFERENCES Departments (DepartmentID)',
            ');'
        ].join('\n'));
        expect(notes).toEqual([
            'SQLite has no schemas, so dbo.Departments is created as Departments.',
            'Departments.Name: SQLite can\'t read the type NVARCHAR(MAX), so it is written as NVARCHAR.',
            'SQLite has no schemas, so dbo.Employees is created as Employees.',
            'Pairs.a: SQLite can\'t read the type ENUM(\'x\',\'y\'), so it is written as ENUM.'
        ]);

        const adapter = createSqliteAdapter(sqlite3, createMemoryFiles(sqlite3));
        await adapter.create('ddl1');
        const run = adapter.execute(`BEGIN;\n${sql}\nCOMMIT;`);
        expect(run.error).toBeNull();
        const schema = adapter.schema();
        expect(schema.map(t => t.name)).toEqual(['Departments', 'Employees', 'Pairs']);
        expect(schema[1].foreignKeys).toEqual([{ columns: ['DepartmentID'], refTable: 'Departments', refColumns: ['DepartmentID'] }]);
        expect(schema[2].primaryKey).toEqual(['a', 'b']);
        expect(schema[0].columns[1]).toMatchObject({ name: 'Name', type: 'NVARCHAR', notNull: true });
    });
});
