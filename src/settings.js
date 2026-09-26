// User preferences, persisted in localStorage.

import { DIALECTS, DEFAULT_DIALECT } from './dialects.js';

export const THEMES = ['system', 'light', 'dark'];
export const OUTPUT_MODES = ['formatted', 'compact'];

export const DEFAULT_SETTINGS = Object.freeze({
    dialect: DEFAULT_DIALECT,
    quoteIdentifiers: false,
    livePreview: true,
    saveHistory: true,
    restoreSession: true,
    theme: 'system',
    outputMode: 'formatted'
});

const SETTINGS_KEY = 'settings';

/** Returns a complete, valid settings object from untrusted input. */
export function sanitizeSettings(input) {
    const source = input && typeof input === 'object' ? input : {};
    const bool = (key) => (typeof source[key] === 'boolean' ? source[key] : DEFAULT_SETTINGS[key]);
    const oneOf = (key, allowed) => (allowed.includes(source[key]) ? source[key] : DEFAULT_SETTINGS[key]);
    return {
        dialect: oneOf('dialect', Object.keys(DIALECTS)),
        quoteIdentifiers: bool('quoteIdentifiers'),
        livePreview: bool('livePreview'),
        saveHistory: bool('saveHistory'),
        restoreSession: bool('restoreSession'),
        theme: oneOf('theme', THEMES),
        outputMode: oneOf('outputMode', OUTPUT_MODES)
    };
}

export function loadSettings(storage) {
    const stored = storage.get(SETTINGS_KEY);
    if (stored) return sanitizeSettings(stored);
    // Earlier versions stored only the theme, under the unprefixed "theme" key
    const legacyTheme = storage.getLegacy('theme');
    return sanitizeSettings({ theme: legacyTheme });
}

export function saveSettings(storage, settings) {
    return storage.set(SETTINGS_KEY, sanitizeSettings(settings));
}
