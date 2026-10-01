// User preferences, persisted in localStorage.

import { DIALECTS, DEFAULT_DIALECT } from './dialects.js';

export const THEMES = ['system', 'light', 'dark'];
export const OUTPUT_MODES = ['formatted', 'compact'];
// How much the Query structure panel explains (see explain.js)
export const EXPLAIN_LEVELS = ['beginner', 'developer', 'advanced'];
// SQL format options (see generator.js); the first of each is the default
export const KEYWORD_CASES = ['upper', 'lower'];
export const INDENT_STYLES = ['4', '2', 'tab'];
export const COMMA_POSITIONS = ['trailing', 'leading'];

export const DEFAULT_SETTINGS = Object.freeze({
    dialect: DEFAULT_DIALECT,
    quoteIdentifiers: false,
    livePreview: true,
    saveHistory: true,
    restoreSession: true,
    theme: 'system',
    outputMode: 'formatted',
    wrapOutput: false,
    explainLevel: 'beginner',
    keywordCase: 'upper',
    indentStyle: '4',
    commaPosition: 'trailing',
    expandLists: false
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
        outputMode: oneOf('outputMode', OUTPUT_MODES),
        wrapOutput: bool('wrapOutput'),
        explainLevel: oneOf('explainLevel', EXPLAIN_LEVELS),
        keywordCase: oneOf('keywordCase', KEYWORD_CASES),
        indentStyle: oneOf('indentStyle', INDENT_STYLES),
        commaPosition: oneOf('commaPosition', COMMA_POSITIONS),
        expandLists: bool('expandLists')
    };
}

/** The generator options that come from the SQL format settings. */
export function formatOptions(settings) {
    return {
        keywordCase: settings.keywordCase,
        indentStyle: settings.indentStyle,
        commaPosition: settings.commaPosition,
        expandLists: settings.expandLists
    };
}

export const FORMAT_SETTINGS = Object.freeze(Object.keys(formatOptions(DEFAULT_SETTINGS)));

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
