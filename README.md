# SQL Query Builder Pro Lite

A lightweight, zero-dependency web application for visually generating SQL queries. Runs entirely in the browser with no internet connection required.

## Features

- **Four Query Types**: SELECT, INSERT, UPDATE, DELETE
- **Clean SQL Output**: Keywords uppercase, consistent indentation, one clause per line
- **Form Validation**: Required field checking with friendly error messages
- **Copy to Clipboard**: One-click copy with visual feedback
- **Clear Form**: Reset all fields instantly
- **Dark/Light Mode**: Persisted theme preference with system detection
- **Responsive Design**: Works on desktop, tablet, and mobile
- **Accessible**: Semantic HTML, proper labels, keyboard navigation
- **Zero Dependencies**: Pure HTML5, CSS3, Vanilla JavaScript (ES6)

## Screenshots

### Light Mode
![Light Mode](https://via.placeholder.com/800x400/f8f9fa/212529?text=Light+Mode)

### Dark Mode
![Dark Mode](https://via.placeholder.com/800x400/111827/f9fafb?text=Dark+Mode)

## How to Run

### Local Development
1. Clone or download this repository
2. Open `index.html` in any modern web browser
3. Start building SQL queries immediately

No build step, no server, no installation required.

### Deploy to Vercel

**Option 1: Vercel CLI**
```bash
npm install -g vercel
vercel --prod
```

**Option 2: GitHub Integration**
1. Push this folder to a GitHub repository
2. Go to [vercel.com/new](https://vercel.com/new)
3. Import the repository
4. Deploy (zero configuration needed)

**Option 3: Drag & Drop**
1. Run `npm install` (optional, for local preview)
2. Run `npm run dev` to preview locally at `http://localhost:3000`
3. Drag the project folder to [vercel.com/new](https://vercel.com/new)

The `vercel.json` handles all configuration automatically.

## Folder Structure

```
/
├── index.html      # Main HTML structure
├── style.css       # All styling (light/dark themes, responsive)
├── script.js       # Application logic (SQL generation, validation, theme)
├── vercel.json     # Vercel deployment configuration
├── package.json    # Project metadata & deploy scripts
└── README.md       # This file
```

## Usage

1. **Select Query Type**: Click SELECT, INSERT, UPDATE, or DELETE
2. **Fill Fields**: Enter table name, columns, conditions as needed
3. **Generate**: Click "Generate SQL" to produce formatted output
4. **Copy**: Click "Copy" to copy the SQL to clipboard
5. **Clear**: Click "Clear Form" to reset all fields

### JOIN Queries (SELECT only)
1. Click SELECT.
2. Click "+ Add JOIN".
3. Select JOIN type (INNER, LEFT, RIGHT), specify joined table, and column mapping (e.g., `users.id` = `orders.user_id`).
4. Multiple JOINs can be added and removed as needed.

### GROUP BY and HAVING (SELECT only)
1. Click SELECT.
2. Click "+ Add GROUP BY" to group results by columns.
3. Click "+ Add HAVING" to filter groups with aggregate conditions (e.g., `COUNT(*)` `>` `5`).

### UNION Queries (SELECT only)
1. Click SELECT.
2. Enable "Enable UNION".
3. Select UNION type (UNION or UNION ALL).
4. Configure the second SELECT query (Table, Columns, WHERE).
5. The application validates that both SELECT queries have the same number of columns, where possible.

### Example Outputs

**SELECT**
```sql
SELECT Name, Salary
FROM Employees
WHERE Salary > 50000
ORDER BY Salary DESC
LIMIT 10;
```

**INSERT**
```sql
INSERT INTO Employees (Name, Salary)
VALUES ('John', 50000);
```

**UPDATE**
```sql
UPDATE Employees
SET Salary = 60000
WHERE EmployeeID = 1;
```

**DELETE**
```sql
DELETE FROM Employees
WHERE EmployeeID = 1;
```

## Security / Safety

**SQLBuilder** is a client-side SQL query generation tool. It ONLY generates SQL strings as text.

- **No Database Connection**: This tool does not connect to, query, or execute SQL against any database.
- **Review Before Execution**: All generated SQL should be thoroughly reviewed by a qualified user before being executed in any database environment.
- **Do Not Execute Blindly**: Never execute untrusted or blindly generated SQL.

## Browser Support

- Chrome 60+
- Firefox 55+
- Safari 11+
- Edge 79+

Requires: `navigator.clipboard` (secure context) or fallback to `document.execCommand`

## Future Improvements

- Multiple row INSERT support
- JOIN clause builder for SELECT
- Subquery support
- SQL syntax highlighting in output
- Export/import query templates
- Keyboard shortcuts (Ctrl+Enter to generate, Ctrl+Shift+C to copy)
- Custom delimiter support
- Query history with localStorage

## License

MIT License - Feel free to use, modify, and distribute.