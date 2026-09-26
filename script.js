// Loaded as a classic script (not a module) so index.html also works when
// opened directly from disk (file://). The pure SQL helpers are exposed on
// globalThis.SQLBuilder for tests.
(function () {
'use strict';

// SQL Generation Functions
function generateSelect(table, columns, where, orderBy, limit, joins = [], groupBys = [], havings = []) {
    let sql = `SELECT ${columns} FROM ${table}`;
    joins.forEach(join => {
        sql += ` ${join.type} ${join.table} ON ${join.leftCol} = ${join.rightCol}`;
    });
    if (where) sql += ` WHERE ${where}`;
    if (groupBys.length > 0) sql += ` GROUP BY ${groupBys.join(', ')}`;
    if (havings.length > 0) {
        sql += ` HAVING ${havings.map(h => `${h.col} ${h.op} ${h.val}`).join(' AND ')}`;
    }
    if (orderBy) sql += ` ORDER BY ${orderBy}`;
    if (limit) sql += ` LIMIT ${limit}`;
    return formatSQL(sql + ';');
}

function generateInsert(table, columns, values) {
    return formatSQL(`INSERT INTO ${table} (${columns})\nVALUES (${values});`);
}

function generateUpdate(table, setClause, where) {
    return formatSQL(`UPDATE ${table}\nSET ${setClause}\nWHERE ${where};`);
}

function generateDelete(table, where) {
    return formatSQL(`DELETE FROM ${table}\nWHERE ${where};`);
}

// ORDER BY / LIMIT apply to the combined result, so they go after the last SELECT
function generateUnionQuery(sql1, type, sql2, orderBy = '', limit = '') {
    const cleanSql1 = sql1.replace(/;$/, '');
    const cleanSql2 = sql2.replace(/;$/, '');
    let sql = `${cleanSql1}\n${type}\n${cleanSql2}`;
    if (orderBy) sql += ` ORDER BY ${orderBy}`;
    if (limit) sql += ` LIMIT ${limit}`;
    return formatSQL(sql + ';');
}

function formatSQL(sql) {
    // Swap string literals for placeholders so keywords inside them are left alone
    const strings = [];
    const tempSql = sql.replace(/'[^']*'/g, (match) => {
        const placeholder = `___STRING_${strings.length}___`;
        strings.push(match);
        return placeholder;
    });

    const formatted = tempSql
        .replace(/\s+/g, ' ')
        .replace(/ (SELECT|FROM|WHERE|ORDER BY|LIMIT|INSERT INTO|VALUES|UPDATE|SET|DELETE FROM|INNER JOIN|LEFT JOIN|RIGHT JOIN|ON|GROUP BY|HAVING|UNION ALL|UNION)\b/gi, '\n$1')
        .trim();

    return formatted.replace(/___STRING_(\d+)___/g, (match, index) => strings[index]);
}

// Single-pass tokenizer: string literals, keywords, operators, numbers.
// Each token (and the text between tokens) is HTML-escaped individually.
const HIGHLIGHT_RE = new RegExp([
    "('(?:[^']|'')*')",
    '\\b(ORDER\\s+BY|INSERT\\s+INTO|DELETE\\s+FROM|(?:INNER|LEFT|RIGHT)\\s+JOIN|GROUP\\s+BY|UNION\\s+ALL|SELECT|FROM|WHERE|LIMIT|VALUES|UPDATE|SET|AND|OR|ON|JOIN|HAVING|UNION)\\b',
    "(<>|!=|>=|<=|=|[<>](?=[\\s\\d'(-]))",
    '\\b(\\d+(?:\\.\\d+)?)\\b'
].join('|'), 'gi');

function highlightSQL(sql) {
    let result = '';
    let lastIndex = 0;
    for (const match of sql.matchAll(HIGHLIGHT_RE)) {
        const [token, str, keyword, operator] = match;
        const cls = str ? 'string' : keyword ? 'keyword' : operator ? 'operator' : 'number';
        result += escapeHtml(sql.slice(lastIndex, match.index));
        result += `<span class="token ${cls}">${escapeHtml(token)}</span>`;
        lastIndex = match.index + token.length;
    }
    return result + escapeHtml(sql.slice(lastIndex));
}

// Counts top-level columns (commas inside parentheses, e.g. CONCAT(a, b), don't count).
// Returns -1 when a wildcard makes the count unknowable.
function countColumns(columnString) {
    if (!columnString || !columnString.trim()) return 0;
    const cols = [];
    let depth = 0;
    let current = '';
    for (const ch of columnString) {
        if (ch === '(') depth++;
        if (ch === ')') depth = Math.max(0, depth - 1);
        if (ch === ',' && depth === 0) {
            cols.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    cols.push(current.trim());
    const nonEmpty = cols.filter(c => c.length > 0);
    if (nonEmpty.some(c => c === '*' || c.endsWith('.*'))) return -1;
    return nonEmpty.length;
}

function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

const PLACEHOLDER_TEXT = 'Select a query type and fill in the fields to generate SQL.';

const state = {
    currentType: 'select',
    sql: '',
    theme: 'light'
};

const elements = {};

// Templates for the repeatable SELECT rows (static markup only, never user input)
const ROW_TEMPLATES = {
    join: {
        title: 'JOIN',
        fields: `
            <div class="join-fields">
                <select class="join-type" aria-label="JOIN type">
                    <option value="INNER JOIN">INNER JOIN</option>
                    <option value="LEFT JOIN">LEFT JOIN</option>
                    <option value="RIGHT JOIN">RIGHT JOIN</option>
                </select>
                <input type="text" class="join-table" placeholder="Table Name" aria-label="JOIN table" required>
                <input type="text" class="join-left" placeholder="Left Column" aria-label="Left column" required>
                <input type="text" class="join-right" placeholder="Right Column" aria-label="Right column" required>
            </div>`
    },
    groupby: {
        title: 'GROUP BY',
        fields: '<input type="text" class="groupby-col full-width" placeholder="Column" aria-label="GROUP BY column" required>'
    },
    having: {
        title: 'HAVING',
        fields: `
            <div class="join-fields">
                <input type="text" class="having-col" placeholder="Column/Expr" aria-label="HAVING expression" required>
                <select class="having-op" aria-label="HAVING operator">
                    <option value="=">=</option>
                    <option value="!=">!=</option>
                    <option value="&gt;">&gt;</option>
                    <option value="&lt;">&lt;</option>
                    <option value="&gt;=">&gt;=</option>
                    <option value="&lt;=">&lt;=</option>
                </select>
                <input type="text" class="having-val span-2" placeholder="Value" aria-label="HAVING value" required>
            </div>`
    }
};

function init() {
    cacheElements();
    bindEvents();
    loadTheme();
    updateFieldVisibility();
    toggleUnionFields();
}

function cacheElements() {
    const byId = id => document.getElementById(id);
    elements.form = byId('query-form');
    elements.typeRadios = document.querySelectorAll('input[name="query-type"]');
    elements.fieldSections = {
        select: byId('select-fields'),
        insert: byId('insert-fields'),
        update: byId('update-fields'),
        delete: byId('delete-fields')
    };
    elements.clearBtn = byId('clear-btn');
    elements.copyBtn = byId('copy-btn');
    elements.downloadBtn = byId('download-btn');
    elements.outputMessage = byId('output-message');
    elements.sqlOutput = byId('sql-output');
    elements.themeToggle = byId('theme-toggle');
    elements.rowContainers = {
        join: byId('join-container'),
        groupby: byId('groupby-container'),
        having: byId('having-container')
    };
    elements.addJoinBtn = byId('add-join-btn');
    elements.addGroupbyBtn = byId('add-groupby-btn');
    elements.addHavingBtn = byId('add-having-btn');
    elements.enableUnion = byId('enable-union');
    elements.unionFields = byId('union-fields');
    elements.unionType = byId('union-type');
}

function bindEvents() {
    elements.typeRadios.forEach(radio => {
        radio.addEventListener('change', handleTypeChange);
    });

    elements.form.addEventListener('submit', handleGenerate);
    elements.clearBtn.addEventListener('click', handleClear);
    elements.copyBtn.addEventListener('click', handleCopy);
    elements.downloadBtn.addEventListener('click', handleDownload);
    elements.addJoinBtn.addEventListener('click', () => addRow('join'));
    elements.addGroupbyBtn.addEventListener('click', () => addRow('groupby'));
    elements.addHavingBtn.addEventListener('click', () => addRow('having'));
    elements.enableUnion.addEventListener('change', toggleUnionFields);
    elements.themeToggle.addEventListener('click', toggleTheme);

    // Delegated so dynamically added JOIN/GROUP BY/HAVING inputs are covered too
    elements.form.addEventListener('input', (e) => {
        if (e.target.matches('input')) clearError(e.target);
    });
    elements.form.addEventListener('focusout', (e) => {
        if (e.target.matches('input')) validateField(e.target);
    });
    elements.form.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('.remove-join-btn');
        if (removeBtn) removeBtn.closest('.join-row').remove();
    });
}

function addRow(kind) {
    const { title, fields } = ROW_TEMPLATES[kind];
    const row = document.createElement('div');
    row.className = 'join-row';
    row.innerHTML = `
        <div class="join-row-header">
            <strong>${title}</strong>
            <button type="button" class="remove-join-btn">Remove</button>
        </div>
        ${fields}`;
    elements.rowContainers[kind].appendChild(row);
    row.querySelector('input').focus();
}

function readRows(kind, mapRow) {
    return Array.from(elements.rowContainers[kind].querySelectorAll('.join-row'), mapRow);
}

const fieldValue = (row, selector) => row.querySelector(selector).value.trim();

function getJoins() {
    return readRows('join', row => ({
        type: row.querySelector('.join-type').value,
        table: fieldValue(row, '.join-table'),
        leftCol: fieldValue(row, '.join-left'),
        rightCol: fieldValue(row, '.join-right')
    }));
}

function getGroupBys() {
    return readRows('groupby', row => fieldValue(row, '.groupby-col'));
}

function getHavings() {
    return readRows('having', row => ({
        col: fieldValue(row, '.having-col'),
        op: row.querySelector('.having-op').value,
        val: fieldValue(row, '.having-val')
    }));
}

function toggleUnionFields() {
    elements.unionFields.classList.toggle('hidden', !elements.enableUnion.checked);
}

function handleTypeChange(e) {
    state.currentType = e.target.value;
    updateFieldVisibility();
    clearAllErrors();
    resetOutput();
}

function updateFieldVisibility() {
    Object.entries(elements.fieldSections).forEach(([key, section]) => {
        section.classList.toggle('hidden', key !== state.currentType);
    });
}

function isUnionEnabled() {
    return state.currentType === 'select' && elements.enableUnion.checked;
}

function handleGenerate(e) {
    e.preventDefault();

    if (!validateForm()) {
        const firstError = elements.form.querySelector('input.error');
        if (firstError) firstError.focus();
        return;
    }

    displaySQL(buildSQL());
}

function buildSQL() {
    switch (state.currentType) {
        case 'select': {
            const joins = getJoins();
            const groupBys = getGroupBys();
            const havings = getHavings();
            const orderBy = getValue('select-order');
            const limit = getValue('select-limit');
            const table = getValue('select-table');
            const columns = getValue('select-columns');
            const where = getValue('select-where');

            if (!isUnionEnabled()) {
                return generateSelect(table, columns, where, orderBy, limit, joins, groupBys, havings);
            }
            const sql1 = generateSelect(table, columns, where, '', '', joins, groupBys, havings);
            const sql2 = generateSelect(getValue('select-table-2'), getValue('select-columns-2'), getValue('select-where-2'), '', '');
            return generateUnionQuery(sql1, elements.unionType.value, sql2, orderBy, limit);
        }
        case 'insert':
            return generateInsert(getValue('insert-table'), getValue('insert-columns'), getValue('insert-values'));
        case 'update':
            return generateUpdate(getValue('update-table'), getValue('update-set'), getValue('update-where'));
        case 'delete':
            return generateDelete(getValue('delete-table'), getValue('delete-where'));
        default:
            return '';
    }
}

function validateForm() {
    const section = elements.fieldSections[state.currentType];
    let isValid = true;

    // Every visible [required] input in the active section, including dynamic rows
    section.querySelectorAll('input[required]').forEach(input => {
        if (input.closest('.hidden')) return;
        if (!validateField(input)) isValid = false;
    });

    if (state.currentType === 'select') {
        const limitInput = inputById('select-limit');
        const limit = Number(limitInput.value);
        if (limitInput.value && !(Number.isInteger(limit) && limit >= 1)) {
            showError(limitInput, 'Limit must be a positive integer');
            isValid = false;
        }
    }

    if (isUnionEnabled()) {
        const columns2 = inputById('select-columns-2');
        const count1 = countColumns(getValue('select-columns'));
        const count2 = countColumns(columns2.value);

        if (count1 > 0 && count2 > 0 && count1 !== count2) {
            showError(columns2, 'UNION queries must select the same number of columns.');
            isValid = false;
        }
    }

    return isValid;
}

function validateField(input) {
    if (input.hasAttribute('required') && !input.value.trim()) {
        showError(input, 'This field is required');
        return false;
    }
    clearError(input);
    return true;
}

function showError(input, message) {
    input.classList.add('error');
    input.setAttribute('aria-invalid', 'true');
    input.title = message;
    const errorEl = input.parentElement.querySelector('.error-message');
    if (errorEl) {
        errorEl.textContent = message;
    }
}

function clearError(input) {
    input.classList.remove('error');
    input.removeAttribute('aria-invalid');
    input.removeAttribute('title');
    const errorEl = input.parentElement.querySelector('.error-message');
    if (errorEl) {
        errorEl.textContent = '';
    }
}

function clearAllErrors() {
    elements.form.querySelectorAll('input.error').forEach(clearError);
}

/**
 * @param {string} id
 * @returns {HTMLInputElement}
 */
function inputById(id) {
    return /** @type {HTMLInputElement} */ (document.getElementById(id));
}

function getValue(id) {
    const el = inputById(id);
    return el ? el.value.trim() : '';
}

function setCopyButtonState(copied) {
    elements.copyBtn.classList.toggle('copied', copied);
    elements.copyBtn.querySelector('span').textContent = copied ? 'Copied!' : 'Copy';
}

function showCopied() {
    setCopyButtonState(true);
    setTimeout(() => setCopyButtonState(false), 2000);
}

function displaySQL(sql) {
    state.sql = sql;
    elements.sqlOutput.innerHTML = `<code>${highlightSQL(sql)}</code>`;
    setCopyButtonState(false);
    elements.outputMessage.textContent = '';
}

function resetOutput() {
    state.sql = '';
    elements.sqlOutput.innerHTML = `<code>${PLACEHOLDER_TEXT}</code>`;
    setCopyButtonState(false);
    elements.outputMessage.textContent = '';
}

function handleClear() {
    elements.form.reset();
    clearAllErrors();
    resetOutput();
    Object.values(elements.rowContainers).forEach(container => container.replaceChildren());
    toggleUnionFields();
}

async function handleCopy() {
    const text = state.sql;
    if (!text) {
        showMessage('Generate a query first!');
        return;
    }

    try {
        await navigator.clipboard.writeText(text);
        showCopied();
    } catch {
        // Clipboard API unavailable (e.g. insecure context) or permission denied
        if (fallbackCopy(text)) {
            showCopied();
        } else {
            showMessage('Copy failed — select the SQL and copy manually.');
        }
    }
}

function fallbackCopy(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.className = 'visually-hidden';
    document.body.appendChild(textarea);
    textarea.select();
    try {
        return document.execCommand('copy');
    } catch {
        return false;
    } finally {
        textarea.remove();
    }
}

function handleDownload() {
    const text = state.sql;
    if (!text) {
        showMessage('Generate a query first!');
        return;
    }

    const blob = new Blob([text], { type: 'text/sql' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sqlbuilder-${state.currentType}.sql`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke on the next tick so the download has started in every browser
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

let messageTimer;
function showMessage(msg) {
    clearTimeout(messageTimer);
    elements.outputMessage.textContent = msg;
    messageTimer = setTimeout(() => { elements.outputMessage.textContent = ''; }, 3000);
}

// localStorage can throw (privacy modes, blocked storage); the theme is a nicety,
// so failures must never stop the app from initialising.
function readStoredTheme() {
    try {
        return localStorage.getItem('theme');
    } catch {
        return null;
    }
}

function storeTheme(theme) {
    try {
        localStorage.setItem('theme', theme);
    } catch {
        // ignore
    }
}

function toggleTheme() {
    state.theme = state.theme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', state.theme);
    storeTheme(state.theme);
}

function loadTheme() {
    const saved = readStoredTheme();
    const prefersDark = typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-color-scheme: dark)').matches;
    state.theme = saved === 'dark' || saved === 'light' ? saved : (prefersDark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', state.theme);
}

globalThis.SQLBuilder = {
    generateSelect,
    generateInsert,
    generateUpdate,
    generateDelete,
    generateUnionQuery,
    formatSQL,
    highlightSQL,
    countColumns
};

if (typeof document !== 'undefined') {
    const start = () => {
        if (document.getElementById('query-form')) init();
    };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
}
})();
