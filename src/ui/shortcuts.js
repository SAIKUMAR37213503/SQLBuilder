// Keyboard shortcuts. Undo/redo only take over when focus is NOT in a text
// field, so the browser's native text undo keeps working while typing.

import { isTextEntry } from './dom.js';

export const SHORTCUTS = [
    { keys: ['Mod', 'Enter'], description: 'Generate SQL (and save it to history)' },
    { keys: ['Mod', 'Shift', 'C'], description: 'Copy SQL' },
    { keys: ['Mod', 'S'], description: 'Save the query (updates the template it was loaded from)' },
    { keys: ['Mod', 'Z'], description: 'Undo (outside text fields)' },
    { keys: ['Mod', 'Shift', 'Z'], description: 'Redo (outside text fields)' },
    { keys: ['?'], description: 'Show keyboard shortcuts' },
    { keys: ['Esc'], description: 'Close dialogs and menus' }
];

export function isMac() {
    return /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || '');
}

export function modLabel() {
    return isMac() ? '⌘' : 'Ctrl';
}

/**
 * @param {EventTarget} target
 * @param {AbortSignal} signal removes the listener when aborted
 * @param {{ generate: () => void, copy: () => void, save: () => void, undo: () => void, redo: () => void, help: () => void, escape: () => void }} handlers
 */
export function bindShortcuts(target, signal, handlers) {
    target.addEventListener('keydown', (/** @type {any} */ event) => {
        const mod = event.ctrlKey || event.metaKey;
        const key = event.key.toLowerCase();

        if (mod && key === 'enter') {
            event.preventDefault();
            handlers.generate();
        } else if (mod && event.shiftKey && key === 'c') {
            event.preventDefault();
            handlers.copy();
        } else if (mod && !event.shiftKey && !event.altKey && key === 's') {
            // Replaces the browser's "Save page", which has no use here
            event.preventDefault();
            handlers.save();
        } else if (mod && !event.altKey && (key === 'z' || key === 'y')) {
            if (isTextEntry(event.target)) return; // native text undo
            const redo = key === 'y' || event.shiftKey;
            event.preventDefault();
            if (redo) handlers.redo();
            else handlers.undo();
        } else if (key === '?' && !mod && !isTextEntry(event.target) && event.target.tagName !== 'SELECT') {
            event.preventDefault();
            handlers.help();
        } else if (key === 'escape') {
            handlers.escape();
        }
    }, { signal });
}
