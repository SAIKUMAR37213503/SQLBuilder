// A small context menu, as the explorer's right-click menu in SSMS: opens at
// the pointer (or under the focused item with Shift+F10 or the Menu key),
// Up / Down / Home / End move, Enter or Space picks, Escape or a click
// elsewhere closes it, and focus goes back to where it was.

import { h } from './dom.js';

/**
 * @typedef {{ id: string, label: string, hint?: string } | { separator: true } | { heading: string }} MenuItem
 */

/** @type {null | (() => void)} the menu open now */
let closeOpen = null;

/**
 * Shows a menu and resolves with the picked item's id, or null.
 * @param {{ doc: Document, label: string, items: MenuItem[], anchor: HTMLElement, x?: number | null, y?: number | null }} options
 * @returns {Promise<string | null>}
 */
export function openMenu({ doc, label, items, anchor, x = null, y = null }) {
    closeOpen?.();
    return new Promise((resolve) => {
        const buttons = [];
        const menu = h('div', { class: 'lab-menu', role: 'menu', 'aria-label': label, tabindex: '-1' },
            items.map((item) => {
                if ('separator' in item) return h('div', { class: 'lab-menu-separator', role: 'separator' });
                if ('heading' in item) return h('div', { class: 'lab-menu-heading', role: 'presentation' }, item.heading);
                const button = h('button', { type: 'button', class: 'lab-menu-item', role: 'menuitem', tabindex: '-1', dataset: { menuId: item.id } },
                    h('span', {}, item.label),
                    item.hint ? h('span', { class: 'lab-menu-hint' }, item.hint) : null);
                buttons.push(button);
                return button;
            }));
        doc.body.append(menu);
        // At the pointer, or under the item, kept inside the window
        const box = anchor.getBoundingClientRect();
        const view = doc.defaultView;
        const width = menu.offsetWidth;
        const height = menu.offsetHeight;
        const left = Math.max(4, Math.min((x ?? box.left) + (view?.scrollX || 0), (view?.innerWidth || 1e6) + (view?.scrollX || 0) - width - 4));
        let top = (y ?? box.bottom) + (view?.scrollY || 0);
        if (view && top + height > view.innerHeight + view.scrollY - 4) top = Math.max(view.scrollY + 4, (y ?? box.top) + view.scrollY - height);
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;

        let done = false;
        const finish = (/** @type {string | null} */ id, refocus = true) => {
            if (done) return;
            done = true;
            closeOpen = null;
            doc.removeEventListener('pointerdown', outside, true);
            view?.removeEventListener('resize', cancel);
            view?.removeEventListener('blur', cancel);
            menu.remove();
            if (refocus && anchor.isConnected) anchor.focus();
            resolve(id);
        };
        const cancel = () => finish(null, false);
        const outside = (/** @type {Event} */ event) => {
            if (!menu.contains(/** @type {Node} */ (event.target))) finish(null, false);
        };
        closeOpen = () => finish(null, false);
        doc.addEventListener('pointerdown', outside, true);
        view?.addEventListener('resize', cancel);
        view?.addEventListener('blur', cancel);

        const move = (/** @type {number} */ to) => buttons[(to + buttons.length) % buttons.length]?.focus();
        menu.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
            const at = buttons.indexOf(/** @type {any} */ (doc.activeElement));
            if (event.key === 'ArrowDown') move(at + 1);
            else if (event.key === 'ArrowUp') move(at < 0 ? buttons.length - 1 : at - 1);
            else if (event.key === 'Home') move(0);
            else if (event.key === 'End') move(buttons.length - 1);
            else if (event.key === 'Escape') finish(null);
            else if (event.key === 'Tab') finish(null);
            else if (event.key.length === 1 && /\S/.test(event.key)) {
                // Type a letter to move to the next item starting with it
                const letter = event.key.toLowerCase();
                const order = [...buttons.slice(at + 1), ...buttons.slice(0, at + 1)];
                order.find(b => b.textContent.trim().toLowerCase().startsWith(letter))?.focus();
            } else return;
            event.preventDefault();
            event.stopPropagation();
        });
        menu.addEventListener('click', (event) => {
            const button = /** @type {any} */ (event.target).closest('[data-menu-id]');
            if (button) finish(button.dataset.menuId);
        });
        buttons[0]?.focus();
    });
}

/** Closes the open menu, if any (the view is redrawn or hidden). */
export function closeMenu() {
    closeOpen?.();
}
