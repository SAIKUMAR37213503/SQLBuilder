// Command palette (Ctrl/⌘+K): a searchable list of the app's commands in a
// native <dialog>. It follows the ARIA combobox pattern: focus stays in the
// text field, the arrow keys move the active option and Enter runs it.

import { h } from './dom.js';
import { showDialog, closeDialog } from './dialogs.js';

/**
 * @typedef {{ id: string, label: string, group: string, keywords?: string, keys?: string[], run: () => any }} Command
 */

/**
 * Commands whose label, group or keywords contain every word typed, best
 * matches first: labels starting with the first word, then labels with a word
 * starting with it, then the rest; ties keep their original order.
 * @param {Command[]} commands
 * @param {string} query
 * @returns {Command[]}
 */
export function filterCommands(commands, query) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return commands.slice();
    const scored = [];
    commands.forEach((command, index) => {
        const label = command.label.toLowerCase();
        const text = `${label} ${command.group.toLowerCase()} ${(command.keywords || '').toLowerCase()}`;
        if (!words.every(word => text.includes(word))) return;
        const score = label.startsWith(words[0]) ? 0 : label.split(/[^a-z0-9]+/).some(part => part.startsWith(words[0])) ? 1 : 2;
        scored.push({ command, score, index });
    });
    return scored.sort((a, b) => a.score - b.score || a.index - b.index).map(s => s.command);
}

/**
 * Opens the palette and resolves with the chosen command once the dialog has
 * closed and focus is back where it was, or null when it was dismissed.
 * @param {any} dialog
 * @param {Command[]} commands
 * @param {(key: string) => string} keyLabel shows 'Mod' as Ctrl or ⌘
 * @returns {Promise<Command | null>}
 */
export async function openPalette(dialog, commands, keyLabel) {
    const input = dialog.querySelector('[role="combobox"]');
    const list = dialog.querySelector('[role="listbox"]');
    const empty = dialog.querySelector('.palette-empty');
    /** @type {Command[]} */
    let matches = [];
    let active = 0;
    /** @type {Command | null} */
    let chosen = null;

    function setActive(index) {
        active = index;
        Array.from(list.children).forEach((/** @type {any} */ option, i) => option.setAttribute('aria-selected', String(i === active)));
        const option = list.children[active];
        if (option) {
            input.setAttribute('aria-activedescendant', option.id);
            if (typeof option.scrollIntoView === 'function') option.scrollIntoView({ block: 'nearest' });
        } else {
            input.removeAttribute('aria-activedescendant');
        }
    }

    function render() {
        matches = filterCommands(commands, input.value);
        list.replaceChildren(...matches.map((command, i) => h('li', {
            id: `palette-option-${i}`,
            role: 'option',
            class: 'palette-option',
            'aria-selected': 'false',
            dataset: { index: i }
        },
        h('span', { class: 'palette-label' }, command.label),
        h('span', { class: 'palette-group' }, command.group),
        command.keys ? h('span', { class: 'palette-keys' }, command.keys.map(k => h('kbd', {}, keyLabel(k)))) : null)));
        list.hidden = matches.length === 0;
        empty.hidden = matches.length > 0;
        input.setAttribute('aria-expanded', String(matches.length > 0));
        setActive(0);
    }

    function choose(index) {
        chosen = matches[index] || null;
        if (chosen) closeDialog(dialog, 'run');
    }

    const onKeydown = (/** @type {KeyboardEvent} */ event) => {
        if (!matches.length) return;
        const moves = { ArrowDown: active + 1, ArrowUp: active - 1, PageDown: active + 5, PageUp: active - 5 };
        if (event.key in moves) {
            event.preventDefault();
            const to = moves[event.key];
            setActive(event.key.startsWith('Arrow')
                ? (to + matches.length) % matches.length
                : Math.min(Math.max(to, 0), matches.length - 1));
        } else if (event.key === 'Enter') {
            event.preventDefault();
            choose(active);
        }
    };
    const onClick = (/** @type {any} */ event) => {
        const option = event.target.closest('[role="option"]');
        if (option) choose(Number(option.dataset.index));
    };

    input.value = '';
    render();
    input.addEventListener('input', render);
    input.addEventListener('keydown', onKeydown);
    list.addEventListener('click', onClick);
    try {
        await showDialog(dialog, () => input.focus());
    } finally {
        input.removeEventListener('input', render);
        input.removeEventListener('keydown', onKeydown);
        list.removeEventListener('click', onClick);
    }
    return chosen;
}
