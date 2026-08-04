(function() {
    'use strict';

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
        sqlOutput: null,
        themeToggle: null
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

    function cacheElements() {
        elements.form = document.getElementById('query-form');
        elements.typeRadios = document.querySelectorAll('input[name="query-type"]');
        Object.keys(selectors.fieldSections).forEach(key => {
            elements.fieldSections[key] = document.getElementById(selectors.fieldSections[key]);
        });
        elements.generateBtn = document.getElementById('generate-btn');
        elements.clearBtn = document.getElementById('clear-btn');
        elements.copyBtn = document.getElementById('copy-btn');
        elements.sqlOutput = document.getElementById('sql-output');
        elements.themeToggle = document.getElementById('theme-toggle');
    }

    function bindEvents() {
        elements.typeRadios.forEach(radio => {
            radio.addEventListener('change', handleTypeChange);
        });

        elements.form.addEventListener('submit', handleGenerate);
        elements.clearBtn.addEventListener('click', handleClear);
        elements.copyBtn.addEventListener('click', handleCopy);
        elements.themeToggle.addEventListener('click', toggleTheme);

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

        const sql = generateSQL(state.currentType);
        displaySQL(sql);
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

        const limitInput = document.getElementById('select-limit');
        if (limitInput && limitInput.value && (limitInput.value < 1 || !Number.isInteger(Number(limitInput.value)))) {
            showError(limitInput, 'Limit must be a positive integer');
            isValid = false;
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

    function generateSQL(type) {
        switch (type) {
            case 'select':
                return buildSelect();
            case 'insert':
                return buildInsert();
            case 'update':
                return buildUpdate();
            case 'delete':
                return buildDelete();
            default:
                return '';
        }
    }

    function buildSelect() {
        const table = getValue('select-table');
        const columns = getValue('select-columns');
        const where = getValue('select-where');
        const orderBy = getValue('select-order');
        const limit = getValue('select-limit');

        let sql = `SELECT ${columns}\nFROM ${table}`;

        if (where) {
            sql += `\nWHERE ${where}`;
        }
        if (orderBy) {
            sql += `\nORDER BY ${orderBy}`;
        }
        if (limit) {
            sql += `\nLIMIT ${limit}`;
        }

        return sql + ';';
    }

    function buildInsert() {
        const table = getValue('insert-table');
        const columns = getValue('insert-columns');
        const values = getValue('insert-values');

        return `INSERT INTO ${table} (${columns})\nVALUES (${values});`;
    }

    function buildUpdate() {
        const table = getValue('update-table');
        const setClause = getValue('update-set');
        const where = getValue('update-where');

        return `UPDATE ${table}\nSET ${setClause}\nWHERE ${where};`;
    }

    function buildDelete() {
        const table = getValue('delete-table');
        const where = getValue('delete-where');

        return `DELETE FROM ${table}\nWHERE ${where};`;
    }

    function getValue(id) {
        const el = document.getElementById(id);
        return el ? el.value.trim() : '';
    }

    function displaySQL(sql) {
        elements.sqlOutput.innerHTML = `<code>${escapeHtml(sql)}</code>`;
        elements.copyBtn.classList.remove('copied');
        elements.copyBtn.querySelector('span').textContent = 'Copy';
    }

    function resetOutput() {
        elements.sqlOutput.innerHTML = '<code>Select a query type and fill in the fields to generate SQL.</code>';
        elements.copyBtn.classList.remove('copied');
        elements.copyBtn.querySelector('span').textContent = 'Copy';
    }

    function handleClear() {
        elements.form.reset();
        clearAllErrors();
        resetOutput();
    }

    async function handleCopy() {
        const codeEl = elements.sqlOutput.querySelector('code');
        if (!codeEl) return;

        const text = codeEl.textContent;
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
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();