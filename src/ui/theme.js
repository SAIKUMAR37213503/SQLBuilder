// Theme handling. "system" removes the data-theme attribute so the CSS
// prefers-color-scheme media query decides; light/dark force a palette.

export const THEME_LABELS = { system: 'System', light: 'Light', dark: 'Dark' };
const NEXT_THEME = { system: 'light', light: 'dark', dark: 'system' };

export function applyTheme(theme, root = document.documentElement) {
    if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
    else root.removeAttribute('data-theme');
}

export function nextTheme(theme) {
    return NEXT_THEME[theme] || 'system';
}

/** The palette actually in use, for labels ("System (dark)"). */
export function effectiveTheme(theme) {
    if (theme === 'light' || theme === 'dark') return theme;
    try {
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch {
        return 'light';
    }
}
