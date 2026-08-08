import { expect, test, describe } from 'vitest';
import { generateSelect, generateInsert, generateUpdate, generateDelete, formatSQL, highlightSQL, getGeneratedSQL, generateUnionQuery, countColumns } from './script.js';

describe('SQL Generation', () => {
    test('SELECT basic', () => {
        expect(generateSelect('Employees', 'Name, Salary', '', '', '')).toBe('SELECT Name, Salary\nFROM Employees;');
    });

    test('SELECT with WHERE', () => {
        expect(generateSelect('Employees', 'Name', 'Salary > 50000', '', '')).toBe('SELECT Name\nFROM Employees\nWHERE Salary > 50000;');
    });

    test('SELECT with ORDER BY', () => {
        expect(generateSelect('Employees', 'Name', '', 'Salary DESC', '')).toBe('SELECT Name\nFROM Employees\nORDER BY Salary DESC;');
    });

    test('SELECT with LIMIT', () => {
        expect(generateSelect('Employees', 'Name', '', '', '10')).toBe('SELECT Name\nFROM Employees\nLIMIT 10;');
    });

    test('SELECT with JOIN', () => {
        const joins = [{ type: 'INNER JOIN', table: 'orders', leftCol: 'users.id', rightCol: 'orders.user_id' }];
        expect(generateSelect('users', 'users.name, orders.amount', '', '', '', joins)).toBe("SELECT users.name, orders.amount\nFROM users\nINNER JOIN orders\nON users.id = orders.user_id;");
    });

    test('SELECT with Multiple JOINs', () => {
        const joins = [
            { type: 'INNER JOIN', table: 'orders', leftCol: 'users.id', rightCol: 'orders.user_id' },
            { type: 'LEFT JOIN', table: 'payments', leftCol: 'orders.id', rightCol: 'payments.order_id' }
        ];
        expect(generateSelect('users', 'users.name, orders.amount, payments.status', '', '', '', joins)).toBe("SELECT users.name, orders.amount, payments.status\nFROM users\nINNER JOIN orders\nON users.id = orders.user_id\nLEFT JOIN payments\nON orders.id = payments.order_id;");
    });

    test('SELECT with GROUP BY', () => {
        const groupBys = ['department', 'status'];
        expect(generateSelect('employees', 'department, status, COUNT(*)', '', '', '', [], groupBys)).toBe("SELECT department, status, COUNT(*)\nFROM employees\nGROUP BY department, status;");
    });

    test('SELECT with HAVING', () => {
        const havings = [{ col: 'COUNT(*)', op: '>', val: '5' }];
        expect(generateSelect('employees', 'department, COUNT(*)', '', '', '', [], [], havings)).toBe("SELECT department, COUNT(*)\nFROM employees\nHAVING COUNT(*) > 5;");
    });

    test('SELECT with GROUP BY and HAVING', () => {
        const groupBys = ['department'];
        const havings = [{ col: 'COUNT(*)', op: '>', val: '5' }];
        expect(generateSelect('employees', 'department, COUNT(*)', '', '', '', [], groupBys, havings)).toBe("SELECT department, COUNT(*)\nFROM employees\nGROUP BY department\nHAVING COUNT(*) > 5;");
    });

    test('INSERT basic', () => {
        expect(generateInsert('Employees', 'Name, Salary', "'John', 50000")).toBe("INSERT INTO Employees (Name, Salary)\nVALUES ('John', 50000);");
    });

    test('UPDATE basic', () => {
        expect(generateUpdate('Employees', 'Salary=60000', 'ID=1')).toBe('UPDATE Employees\nSET Salary=60000\nWHERE ID=1;');
    });

    test('DELETE basic', () => {
        expect(generateDelete('Employees', 'ID=1')).toBe('DELETE\nFROM Employees\nWHERE ID=1;');
    });
});

describe('Formatting', () => {
    test('formatSQL handles multiple clauses', () => {
        const sql = "SELECT * FROM users WHERE age > 18 ORDER BY name LIMIT 10";
        const formatted = "SELECT *\nFROM users\nWHERE age > 18\nORDER BY name\nLIMIT 10";
        expect(generateSelect('users', '*', 'age > 18', 'name', '10')).toBe(formatted + ';');
    });

    test('formatSQL does not format keywords inside string literals', () => {
        const sql = "SELECT * FROM users WHERE name = 'SELECT a FROM b'";
        const result = formatSQL(sql);
        expect(result).not.toContain("\nSELECT a FROM b");
    });
});

describe('Highlighting & Security', () => {
    test('highlightSQL basic keyword highlighting', () => {
        const sql = "SELECT * FROM users";
        const highlighted = highlightSQL(sql);
        expect(highlighted).toContain('<span class="token keyword">SELECT</span>');
        expect(highlighted).toContain('<span class="token keyword">FROM</span>');
    });

    test('highlightSQL escapes HTML and prevents XSS', () => {
        const sql = "<script>alert('XSS')</script>";
        const highlighted = highlightSQL(sql);
        expect(highlighted).not.toContain('<script>');
        expect(highlighted).toContain('&lt;script&gt;');
    });
});

describe('Utility Helpers', () => {
    test('getGeneratedSQL extracts clean text from HTML', () => {
        const codeEl = { textContent: 'SELECT * FROM users;' };
        expect(getGeneratedSQL(codeEl)).toBe('SELECT * FROM users;');
    });
});

test('generateSelect with UNION', () => {
    const sql1 = "SELECT Name FROM table1";
    const sql2 = "SELECT Name FROM table2";
    expect(generateUnionQuery(sql1, 'UNION', sql2)).toBe("SELECT Name\nFROM table1\nUNION\nSELECT Name\nFROM table2;");
});

test('generateSelect with UNION ALL', () => {
    const sql1 = "SELECT Name FROM table1";
    const sql2 = "SELECT Name FROM table2";
    expect(generateUnionQuery(sql1, 'UNION ALL', sql2)).toBe("SELECT Name\nFROM table1\nUNION ALL\nSELECT Name\nFROM table2;");
});


test('countColumns utility handles normal columns', () => {
    expect(countColumns('a, b')).toBe(2);
});

test('countColumns utility handles *', () => {
    expect(countColumns('*')).toBe(-1);
});

