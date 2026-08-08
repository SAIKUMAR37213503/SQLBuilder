'use strict';

// SQL Generation Functions
export function generateSelect(table, columns, where, orderBy, limit, joins = [], groupBys = [], havings = []) {
    let sql = `SELECT ${columns} FROM ${table}`;
    joins.forEach(join => {
        sql += ` ${join.type} ${join.table} ON ${join.leftCol} = ${join.rightCol}`;
    });
    if (where) sql += ` WHERE ${where}`;
    if (groupBys.length > 0) sql += ` GROUP BY ${groupBys.join(', ')}`;
    havings.forEach(having => {
        sql += ` HAVING ${having.col} ${having.op} ${having.val}`;
    });
    if (orderBy) sql += ` ORDER BY ${orderBy}`;
    if (limit) sql += ` LIMIT ${limit}`;
    return formatSQL(sql + ';');
}

export function generateInsert(table, columns, values) {
    return formatSQL(`INSERT INTO ${table} (${columns})\nVALUES (${values});`);
}

export function generateUpdate(table, setClause, where) {
    return formatSQL(`UPDATE ${table}\nSET ${setClause}\nWHERE ${where};`);
}

export function generateDelete(table, where) {
    return formatSQL(`DELETE FROM ${table}\nWHERE ${where};`);
}

export function formatSQL(sql) {
    // Basic SQL Formatter
    // Placeholder for strings to avoid formatting keywords inside them
    const strings = [];
    const tempSql = sql.replace(/'[^']*'/g, (match) => {
        const placeholder = `___STRING_${strings.length}___`;
        strings.push(match);
        return placeholder;
    });
    
    let formatted = tempSql
        .replace(/\n/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/ (SELECT|FROM|WHERE|ORDER BY|LIMIT|INSERT INTO|VALUES|UPDATE|SET|DELETE FROM|INNER JOIN|LEFT JOIN|RIGHT JOIN|ON|GROUP BY|HAVING|UNION ALL|UNION)/gi, '\n$1')
        .replace(/\nDELETE/gi, 'DELETE')
        .replace(/\s\n/g, '\n')
        .replace(/^\n/, '')
        .trim();
    
    // Restore strings
    return formatted.replace(/___STRING_(\d+)___/g, (match, index) => strings[index]);
}

export function highlightSQL(sql) {
    // 1. Escape HTML first to prevent XSS
    const escaped = escapeHtml(sql);
    
    // 2. Tokenize and highlight (order matters: longer keywords first)
    // We use temporary placeholders to avoid re-highlighting existing tags
    let result = escaped
        .replace(/\b(ORDER BY|INSERT INTO|DELETE FROM|INNER JOIN|LEFT JOIN|RIGHT JOIN|GROUP BY|UNION ALL)\b/gi, '___K1___$1___K2___')
        .replace(/\b(SELECT|FROM|WHERE|LIMIT|VALUES|UPDATE|SET|AND|OR|ON|JOIN|HAVING|UNION)\b/gi, '___K1___$1___K2___')
        .replace(/(=|!=|<>|>|<|>=|<=)/g, '___O1___$1___O2___')
        .replace(/'[^']*'/g, '___S1___$&___S2___')
        .replace(/\b\d+\b/g, '___N1___$&___N2___');
        
    // 3. Replace placeholders with actual HTML tags
    return result
        .replace(/___K1___/g, '<span class="token keyword">')
        .replace(/___K2___/g, '</span>')
        .replace(/___O1___/g, '<span class="token operator">')
        .replace(/___O2___/g, '</span>')
        .replace(/___S1___/g, '<span class="token string">')
        .replace(/___S2___/g, '</span>')
        .replace(/___N1___/g, '<span class="token number">')
        .replace(/___N2___/g, '</span>');
}

const state = {
    currentType: 'select',
    theme: 'light'
};

const elements = {
    form: null,
    typeRadios: null,
    fieldSections: {},
    generateBtn: null,
    clearBtn: null,
    copyBtn: null,
    downloadBtn: null,
    outputMessage: null,
    sqlOutput: null,
    themeToggle: null,
    joinContainer: null,
    addJoinBtn: null
};

const selectors = {
    fieldSections: {
        select: 'select-fields',
        insert: 'insert-fields',
        update: 'update-fields',
        delete: 'delete-fields'
    },
    requiredFields: {
        select: ['select-table', 'select-columns'],
        insert: ['insert-table', 'insert-columns', 'insert-values'],
        update: ['update-table', 'update-set', 'update-where'],
        delete: ['delete-table', 'delete-where']
    }
};

function init() {
    cacheElements();
    bindEvents();
    loadTheme();
    updateFieldVisibility();
}

function addJoinUI() {
    const row = document.createElement('div');
    row.className = 'join-row';
    row.innerHTML = `
        <div class="join-row-header">
            <strong>JOIN</strong>
            <button type="button" class="remove-join-btn">Remove</button>
        </div>
        <div class="join-fields">
            <select class="join-type">
                <option value="INNER JOIN">INNER JOIN</option>
                <option value="LEFT JOIN">LEFT JOIN</option>
                <option value="RIGHT JOIN">RIGHT JOIN</option>
            </select>
            <input type="text" class="join-table" placeholder="Table Name" required>
            <input type="text" class="join-left" placeholder="Left Column" required>
            <input type="text" class="join-right" placeholder="Right Column" required>
        </div>
    `;
    row.querySelector('.remove-join-btn').addEventListener('click', () => row.remove());
    elements.joinContainer.appendChild(row);
}

function getJoins() {
    const rows = elements.joinContainer.querySelectorAll('.join-row');
    return Array.from(rows).map(row => ({
        type: row.querySelector('.join-type').value,
        table: row.querySelector('.join-table').value.trim(),
        leftCol: row.querySelector('.join-left').value.trim(),
        rightCol: row.querySelector('.join-right').value.trim()
    }));
}

function addGroupbyUI() {
    const row = document.createElement('div');
    row.className = 'join-row';
    row.innerHTML = `
        <div class="join-row-header">
            <strong>GROUP BY</strong>
            <button type="button" class="remove-join-btn">Remove</button>
        </div>
        <input type="text" class="groupby-col" placeholder="Column" required style="width:100%">
    `;
    row.querySelector('.remove-join-btn').addEventListener('click', () => row.remove());
    elements.groupbyContainer.appendChild(row);
}

function addHavingUI() {
    const row = document.createElement('div');
    row.className = 'join-row';
    row.innerHTML = `
        <div class="join-row-header">
            <strong>HAVING</strong>
            <button type="button" class="remove-join-btn">Remove</button>
        </div>
        <div class="join-fields">
            <input type="text" class="having-col" placeholder="Column/Expr" required>
            <select class="having-op">
                <option value="=">=</option>
                <option value="!=">!=</option>
                <option value=">">></option>
                <option value="<"><</option>
                <option value=">=">>=</option>
                <option value="<="><=</option>
            </select>
            <input type="text" class="having-val" placeholder="Value" required style="grid-column: span 2">
        </div>
    `;
    row.querySelector('.remove-join-btn').addEventListener('click', () => row.remove());
    elements.havingContainer.appendChild(row);
}

function getGroupBys() {
    const rows = elements.groupbyContainer.querySelectorAll('.join-row');
    return Array.from(rows).map(row => row.querySelector('.groupby-col').value.trim());
}

function getHavings() {
    const rows = elements.havingContainer.querySelectorAll('.join-row');
    return Array.from(rows).map(row => ({
        col: row.querySelector('.having-col').value.trim(),
        op: row.querySelector('.having-op').value,
        val: row.querySelector('.having-val').value.trim()
    }));
}

function toggleUnionFields() {
    elements.unionFields.classList.toggle('hidden', !elements.enableUnion.checked);
}

export function generateUnionQuery(sql1, type, sql2) {
    // Remove trailing semicolon from first query if present
    const cleanSql1 = sql1.replace(/;$/, '');
    const cleanSql2 = sql2.replace(/;$/, '');
    return formatSQL(`${cleanSql1}\n${type}\n${cleanSql2};`);
}


function cacheElements() {
    elements.form = document.getElementById('query-form');
    elements.typeRadios = document.querySelectorAll('input[name="query-type"]');
    Object.keys(selectors.fieldSections).forEach(key => {
        elements.fieldSections[key] = document.getElementById(selectors.fieldSections[key]);
    });
    elements.generateBtn = document.getElementById('generate-btn');
    elements.clearBtn = document.getElementById('clear-btn');
    elements.copyBtn = document.getElementById('copy-btn');
    elements.downloadBtn = document.getElementById('download-btn');
    elements.outputMessage = document.getElementById('output-message');
    elements.sqlOutput = document.getElementById('sql-output');
    elements.themeToggle = document.getElementById('theme-toggle');
    elements.joinContainer = document.getElementById('join-container');
    elements.addJoinBtn = document.getElementById('add-join-btn');
    elements.groupbyContainer = document.getElementById('groupby-container');
    elements.addGroupbyBtn = document.getElementById('add-groupby-btn');
    elements.havingContainer = document.getElementById('having-container');
    elements.addHavingBtn = document.getElementById('add-having-btn');
    elements.enableUnion = document.getElementById('enable-union');
    elements.unionFields = document.getElementById('union-fields');
    elements.unionType = document.getElementById('union-type');
    elements.selectTable2 = document.getElementById('select-table-2');
    elements.selectColumns2 = document.getElementById('select-columns-2');
    elements.selectWhere2 = document.getElementById('select-where-2');
}

function bindEvents() {
    elements.typeRadios.forEach(radio => {
        radio.addEventListener('change', handleTypeChange);
    });

    elements.form.addEventListener('submit', handleGenerate);
    elements.clearBtn.addEventListener('click', handleClear);
    elements.copyBtn.addEventListener('click', handleCopy);
    elements.downloadBtn.addEventListener('click', handleDownload);
    elements.addJoinBtn.addEventListener('click', addJoinUI);
    elements.addGroupbyBtn.addEventListener('click', addGroupbyUI);
    elements.addHavingBtn.addEventListener('click', addHavingUI);
    elements.enableUnion.addEventListener('change', toggleUnionFields);
    elements.themeToggle.addEventListener('click', toggleTheme);

    // Explicitly re-attach event listeners to buttons
    const copyBtn = document.getElementById('copy-btn');
    const downloadBtn = document.getElementById('download-btn');
    
    copyBtn.addEventListener('click', (e) => {
        console.log('Copy button clicked');
        handleCopy(e);
    });
    
    downloadBtn.addEventListener('click', (e) => {
        console.log('Download button clicked');
        handleDownload(e);
    });

    document.querySelectorAll('.query-form input').forEach(input => {
        input.addEventListener('input', () => clearError(input));
        input.addEventListener('blur', () => validateField(input));
    });
}

function handleTypeChange(e) {
    state.currentType = e.target.value;
    updateFieldVisibility();
    clearAllErrors();
    resetOutput();
}

function updateFieldVisibility() {
    Object.keys(elements.fieldSections).forEach(key => {
        const section = elements.fieldSections[key];
        if (section) {
            section.classList.toggle('hidden', key !== state.currentType);
        }
    });
}

function handleGenerate(e) {
    e.preventDefault();

    if (!validateForm()) {
        return;
    }

    const joins = state.currentType === 'select' ? getJoins() : [];
    const groupBys = state.currentType === 'select' ? getGroupBys() : [];
    const havings = state.currentType === 'select' ? getHavings() : [];
    let sql = getSqlFromInputs(state.currentType, joins, groupBys, havings);

    if (state.currentType === 'select' && elements.enableUnion.checked) {
        console.log('Generating UNION SQL');
        const sql2 = getSqlFromInputs('select', [], [], [], '-2');
        sql = generateUnionQuery(sql, elements.unionType.value, sql2);
    }
    
    displaySQL(sql);
}

function getSqlFromInputs(type, joins = [], groupBys = [], havings = [], suffix = '') {
    switch (type) {
        case 'select':
            return generateSelect(getValue(`select-table${suffix}`), getValue(`select-columns${suffix}`), getValue(`select-where${suffix}`), getValue(`select-order${suffix}`), getValue(`select-limit${suffix}`), joins, groupBys, havings);
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
    const requiredIds = selectors.requiredFields[state.currentType] || [];
    let isValid = true;

    requiredIds.forEach(id => {
        const input = document.getElementById(id);
        if (input && !input.value.trim()) {
            showError(input, 'This field is required');
            isValid = false;
        }
    });

    if (state.currentType === 'select') {
        const joinRows = elements.joinContainer.querySelectorAll('.join-row');
        joinRows.forEach(row => {
            const inputs = row.querySelectorAll('input');
            inputs.forEach(input => {
                if (!input.value.trim()) {
                    showError(input, 'This field is required');
                    isValid = false;
                }
            });
        });
        const groupbyRows = elements.groupbyContainer.querySelectorAll('.join-row');
        groupbyRows.forEach(row => {
            const input = row.querySelector('.groupby-col');
            if (!input.value.trim()) {
                showError(input, 'This field is required');
                isValid = false;
            }
        });
        const havingRows = elements.havingContainer.querySelectorAll('.join-row');
        havingRows.forEach(row => {
            const inputs = row.querySelectorAll('input');
            inputs.forEach(input => {
                if (!input.value.trim()) {
                    showError(input, 'This field is required');
                    isValid = false;
                }
            });
        });

        if (elements.enableUnion.checked) {
            const secondFields = ['select-table-2', 'select-columns-2'];
            secondFields.forEach(id => {
                const input = document.getElementById(id);
                if (input && !input.value.trim()) {
                    showError(input, 'This field is required');
                    isValid = false;
                }
            });
        }
    }

    const limitInput = document.getElementById('select-limit');
    if (limitInput && limitInput.value && (limitInput.value < 1 || !Number.isInteger(Number(limitInput.value)))) {
        showError(limitInput, 'Limit must be a positive integer');
        isValid = false;
    }

    if (state.currentType === 'select' && elements.enableUnion.checked) {
        const col1 = document.getElementById('select-columns').value;
        const col2 = document.getElementById('select-columns-2').value;
        const count1 = countColumns(col1);
        const count2 = countColumns(col2);

        if (count1 !== -1 && count2 !== -1 && count1 !== count2) {
            showError(document.getElementById('select-columns-2'), 'UNION queries must select the same number of columns.');
            isValid = false;
        }
    }

    return isValid;
}

export function countColumns(columnString) {
    if (!columnString) return 0;
    const trimmed = columnString.trim();
    if (trimmed === '*') return -1;
    const cols = trimmed.split(',').map(c => c.trim()).filter(c => c.length > 0);
    return cols.length;
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
    const errorEl = input.parentElement.querySelector('.error-message');
    if (errorEl) {
        errorEl.textContent = message;
    }
}

function clearError(input) {
    input.classList.remove('error');
    const errorEl = input.parentElement.querySelector('.error-message');
    if (errorEl) {
        errorEl.textContent = '';
    }
}

function clearAllErrors() {
    document.querySelectorAll('.query-form input.error').forEach(input => {
        clearError(input);
    });
}

function getValue(id) {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
}

function displaySQL(sql) {
    elements.sqlOutput.innerHTML = `<code>${highlightSQL(sql)}</code>`;
    elements.copyBtn.classList.remove('copied');
    elements.copyBtn.querySelector('span').textContent = 'Copy';
}

function resetOutput() {
    elements.sqlOutput.innerHTML = '<code>Select a query type and fill in the fields to generate SQL.</code>';
    elements.copyBtn.classList.remove('copied');
    elements.copyBtn.querySelector('span').textContent = 'Copy';
    elements.outputMessage.textContent = '';
}

function handleClear() {
    elements.form.reset();
    clearAllErrors();
    resetOutput();
    elements.joinContainer.innerHTML = '';
}

export function getGeneratedSQL(codeEl) {
    return codeEl ? codeEl.textContent : '';
}

async function handleCopy() {
    const text = getGeneratedSQL(elements.sqlOutput.querySelector('code'));
    if (!text || text.includes('Select a query type')) return;

    try {
        await navigator.clipboard.writeText(text);
        elements.copyBtn.classList.add('copied');
        elements.copyBtn.querySelector('span').textContent = 'Copied!';
        setTimeout(() => {
            elements.copyBtn.classList.remove('copied');
            elements.copyBtn.querySelector('span').textContent = 'Copy';
        }, 2000);
    } catch (err) {
        fallbackCopy(text);
    }
}

function handleDownload() {
    const text = getGeneratedSQL(elements.sqlOutput.querySelector('code'));
    if (!text || text.includes('Select a query type')) {
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
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function showMessage(msg) {
    elements.outputMessage.textContent = msg;
    setTimeout(() => { elements.outputMessage.textContent = ''; }, 3000);
}

function fallbackCopy(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
        document.execCommand('copy');
        elements.copyBtn.classList.add('copied');
        elements.copyBtn.querySelector('span').textContent = 'Copied!';
        setTimeout(() => {
            elements.copyBtn.classList.remove('copied');
            elements.copyBtn.querySelector('span').textContent = 'Copy';
        }, 2000);
    } catch (e) {
        console.error('Copy failed', e);
    }
    document.body.removeChild(textarea);
}

function toggleTheme() {
    state.theme = state.theme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', state.theme);
    localStorage.setItem('theme', state.theme);
}

function loadTheme() {
    const saved = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    state.theme = saved || (prefersDark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', state.theme);
}

function escapeHtml(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
}
