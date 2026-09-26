// Minimal DOM builder. All text goes through text nodes / textContent and
// attributes through setAttribute, so user input can never become markup.

const PROPERTY_KEYS = new Set(['value', 'checked', 'selected', 'disabled', 'hidden', 'open', 'indeterminate']);

/**
 * h('button', { class: 'btn', dataset: { action: 'x' }, 'aria-label': 'Close' }, 'Text', childNode)
 * @param {string} tag
 * @param {Record<string, any>} [props]
 * @param {...any} children strings, nodes, arrays, null/false (skipped)
 * @returns {any}
 */
export function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'class') el.className = value;
        else if (key === 'dataset') {
            for (const [dKey, dValue] of Object.entries(value)) {
                if (dValue !== undefined && dValue !== null && dValue !== false) el.dataset[dKey] = String(dValue);
            }
        } else if (key === 'text') el.textContent = value;
        else if (PROPERTY_KEYS.has(key)) el[key] = value;
        else el.setAttribute(key, value === true ? '' : String(value));
    }
    append(el, children);
    return el;
}

function append(el, children) {
    for (const child of children) {
        if (child === undefined || child === null || child === false) continue;
        if (Array.isArray(child)) append(el, child);
        else if (typeof child === 'string' || typeof child === 'number') el.appendChild(document.createTextNode(String(child)));
        else el.appendChild(child);
    }
}

/** Escapes a value for use inside a CSS attribute selector. */
export function cssEscape(value) {
    return globalThis.CSS?.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&');
}

export function byPath(root, path) {
    return root.querySelector(`[data-path="${cssEscape(path)}"]`);
}

export function debounce(fn, wait) {
    let timer;
    const debounced = (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), wait);
    };
    debounced.flush = (...args) => {
        clearTimeout(timer);
        fn(...args);
    };
    debounced.cancel = () => clearTimeout(timer);
    return debounced;
}

export function isTextEntry(el) {
    if (!el || !el.tagName) return false;
    if (el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
    if (el.tagName !== 'INPUT') return false;
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color'].includes(el.type);
}

export function formatTime(timestamp) {
    try {
        return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
    } catch {
        return new Date(timestamp).toLocaleString();
    }
}
