// Promise-based wrappers around the native <dialog> elements in index.html.
// Native modal dialogs provide focus containment and Escape-to-close; focus
// is returned to the element that opened the dialog.

function open(dialog) {
    if (typeof dialog.showModal === 'function') {
        if (!dialog.open) dialog.showModal();
    } else {
        dialog.setAttribute('open', '');
    }
}

function close(dialog) {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
}

/**
 * Opens a dialog and resolves when it closes.
 * @param {any} dialog
 * @param {(dialog: any) => void} [onOpen]
 * @returns {Promise<string>} the dialog's returnValue
 */
export function showDialog(dialog, onOpen) {
    const opener = /** @type {any} */ (document.activeElement);
    return new Promise(resolve => {
        const onClose = () => {
            dialog.removeEventListener('close', onClose);
            if (opener && typeof opener.focus === 'function' && opener.isConnected) opener.focus();
            resolve(dialog.returnValue || '');
        };
        dialog.addEventListener('close', onClose);
        dialog.returnValue = '';
        open(dialog);
        if (onOpen) onOpen(dialog);
    });
}

export function closeDialog(dialog, value = '') {
    dialog.returnValue = value;
    close(dialog);
    // Environments without native <dialog> don't fire "close"
    if (typeof dialog.close !== 'function') dialog.dispatchEvent(new Event('close'));
}

/**
 * Asks for a line of text.
 * @returns {Promise<string | null>} the trimmed text, or null when cancelled
 */
export async function promptDialog(dialog, { title, label, value = '', confirmText = 'Save' }) {
    const input = dialog.querySelector('input');
    const error = dialog.querySelector('.dialog-error');
    dialog.querySelector('.dialog-title').textContent = title;
    dialog.querySelector('label').textContent = label;
    dialog.querySelector('[value="confirm"]').textContent = confirmText;
    input.value = value;
    error.textContent = '';
    const result = await showDialog(dialog, () => {
        input.focus();
        input.select();
    });
    return result === 'confirm' ? input.value.trim() : null;
}

/**
 * Asks for a template's name, description and category.
 * @param {any} dialog
 * @param {{ name: string, categories: string[], note: string }} options
 * @returns {Promise<{ name: string, description: string, category: string } | null>} null when cancelled
 */
export async function templateDialog(dialog, { name, categories, note }) {
    const nameInput = dialog.querySelector('#template-name');
    const description = dialog.querySelector('#template-description');
    const category = dialog.querySelector('#template-category');
    nameInput.value = name;
    description.value = '';
    category.value = '';
    dialog.querySelector('datalist').replaceChildren(...categories.map(c => Object.assign(document.createElement('option'), { value: c })));
    dialog.querySelector('#template-dialect-note').textContent = note;
    const result = await showDialog(dialog, () => {
        nameInput.focus();
        nameInput.select();
    });
    if (result !== 'confirm') return null;
    return { name: nameInput.value.trim(), description: description.value.trim(), category: category.value.trim() };
}

/** @returns {Promise<boolean>} */
export async function confirmDialog(dialog, { title, message, confirmText = 'Confirm' }) {
    dialog.querySelector('.dialog-title').textContent = title;
    dialog.querySelector('.dialog-message').textContent = message;
    dialog.querySelector('[value="confirm"]').textContent = confirmText;
    const result = await showDialog(dialog, (d) => d.querySelector('[value="cancel"]').focus());
    return result === 'confirm';
}

// Wires <form method="dialog"> buttons so they also work without native <dialog>.
export function enhanceDialog(dialog) {
    dialog.addEventListener('click', (event) => {
        const btn = event.target.closest('button[value]');
        if (btn && btn.closest('dialog') === dialog) {
            event.preventDefault();
            closeDialog(dialog, btn.value);
        }
    });
    dialog.addEventListener('submit', (event) => {
        event.preventDefault();
        closeDialog(dialog, 'confirm');
    });
    dialog.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && typeof dialog.showModal !== 'function') closeDialog(dialog, 'cancel');
    });
}
