// One help popover shared by every info button. A button opens it on hover
// (after a short delay), on keyboard focus, or on click / tap, which keeps
// it open until the next click, a click elsewhere or Escape. Hovering a
// section's title opens it too. Content is written with textContent only.

import { h } from './dom.js';

export const HELP_POPOVER_ID = 'help-popover';
const HOVER_DELAY = 300;
const TITLE_HOVER_DELAY = 600;
const HIDE_DELAY = 150;
const MARGIN = 8;
const GAP = 6;

/**
 * The info button for a section. `data-help` names its entry.
 * @param {string} key
 * @param {string} title
 */
export function helpButton(key, title) {
    return h('button', {
        type: 'button',
        class: 'help-btn',
        'aria-label': `About ${title}`,
        'aria-expanded': 'false',
        'aria-controls': HELP_POPOVER_ID,
        dataset: { help: key }
    }, h('span', { 'aria-hidden': 'true' }, 'i'));
}

/**
 * Where to put a box of `size` next to `anchor` inside the viewport: below
 * it, or above when it doesn't fit below; centred on it, kept `margin` from
 * the edges. `maxHeight` is set when it fits neither above nor below.
 * @param {{ top: number, bottom: number, left: number, width: number }} anchor
 * @param {{ width: number, height: number }} size
 * @param {{ width: number, height: number }} viewport
 */
export function placePopover(anchor, size, viewport, margin = MARGIN, gap = GAP) {
    const width = Math.min(size.width, viewport.width - 2 * margin);
    const left = Math.max(margin, Math.min(anchor.left + anchor.width / 2 - width / 2, viewport.width - margin - width));
    const below = viewport.height - margin - (anchor.bottom + gap);
    const above = anchor.top - gap - margin;
    if (size.height <= below) return { left, top: anchor.bottom + gap, maxHeight: null, side: 'below' };
    if (size.height <= above) return { left, top: anchor.top - gap - size.height, maxHeight: null, side: 'above' };
    // Neither fits: use the larger side and scroll inside
    return below >= above
        ? { left, top: anchor.bottom + gap, maxHeight: Math.max(below, 80), side: 'below' }
        : { left, top: margin, maxHeight: Math.max(above, 80), side: 'above' };
}

/** @param {any} help a resolved sectionHelp() entry */
function renderHelp(help, dialectLabel) {
    const rows = [];
    if (help.definition) rows.push(h('dt', {}, 'What it is'), h('dd', {}, help.definition));
    for (const part of help.parts) rows.push(h('dt', {}, part.label), h('dd', {}, part.text));
    rows.push(h('dt', {}, 'What SQL does'), h('dd', {}, help.operation));
    if (help.example) rows.push(h('dt', {}, 'Example'), h('dd', {}, h('code', { class: 'help-code' }, help.example)));
    return [
        h('p', { class: 'help-title' }, h('strong', {}, help.title), ` — ${help.tagline}`),
        h('dl', { class: 'help-list' }, rows),
        help.note ? h('p', { class: 'help-note' }, h('strong', {}, `${dialectLabel}: `), help.note) : null
    ];
}

/**
 * @param {{ doc: Document, root: HTMLElement, content: (key: string) => any, dialectLabel: () => string,
 *   signal?: AbortSignal }} options
 */
export function createHelpPopover({ doc, root, content, dialectLabel, signal }) {
    const win = doc.defaultView || globalThis;
    const popover = h('div', { id: HELP_POPOVER_ID, class: 'help-popover', role: 'tooltip', hidden: true });
    // Inside the page's main landmark, so it is read as part of the page
    (root.closest('main') || doc.body).appendChild(popover);
    signal?.addEventListener('abort', () => popover.remove());

    /** @type {HTMLElement | null} */
    let anchor = null;
    let pinned = false;
    let showTimer = 0;
    let hideTimer = 0;

    const buttonFor = (/** @type {Element} */ node) => {
        const trigger = node.closest('[data-help], [data-help-hover]');
        if (!trigger || !root.contains(trigger)) return null;
        if (trigger.matches('[data-help]')) return /** @type {HTMLElement} */ (trigger);
        const key = /** @type {HTMLElement} */ (trigger).dataset.helpHover;
        const frame = trigger.closest('.section-frame, .dml-head');
        return frame ? /** @type {HTMLElement | null} */ (frame.querySelector(`[data-help="${key}"]`)) : null;
    };

    function clearTimers() {
        win.clearTimeout(showTimer);
        win.clearTimeout(hideTimer);
    }

    function position() {
        if (!anchor || popover.hidden) return;
        if (!anchor.isConnected) {
            hide();
            return;
        }
        popover.style.maxHeight = '';
        const rect = anchor.getBoundingClientRect();
        const box = popover.getBoundingClientRect();
        const viewport = { width: doc.documentElement.clientWidth || win.innerWidth, height: win.innerHeight || doc.documentElement.clientHeight };
        const place = placePopover(rect, { width: box.width, height: box.height }, viewport);
        popover.style.left = `${Math.round(place.left)}px`;
        popover.style.top = `${Math.round(place.top)}px`;
        popover.style.maxHeight = place.maxHeight === null ? '' : `${Math.floor(place.maxHeight)}px`;
        // When it has to scroll (a short screen), it can be scrolled from the keyboard too
        if (place.maxHeight === null) popover.removeAttribute('tabindex');
        else popover.setAttribute('tabindex', '0');
        popover.dataset.side = place.side;
    }

    /** @param {HTMLElement} button */
    function show(button, { pin = false } = {}) {
        clearTimers();
        const help = content(button.dataset.help || '');
        if (!help) return;
        if (anchor && anchor !== button) release(anchor);
        anchor = button;
        pinned = pin;
        popover.replaceChildren(...renderHelp(help, dialectLabel()).filter(Boolean));
        popover.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        button.setAttribute('aria-describedby', HELP_POPOVER_ID);
        position();
    }

    function release(button) {
        button.setAttribute('aria-expanded', 'false');
        button.removeAttribute('aria-describedby');
    }

    function hide() {
        clearTimers();
        if (anchor) release(anchor);
        anchor = null;
        pinned = false;
        popover.hidden = true;
    }

    function hideSoon() {
        if (pinned) return;
        win.clearTimeout(hideTimer);
        hideTimer = win.setTimeout(hide, HIDE_DELAY);
    }

    // Hover (mouse and pen only; a tap is handled as a click)
    root.addEventListener('pointerover', (event) => {
        if (event.pointerType === 'touch') return;
        const button = buttonFor(/** @type {Element} */ (event.target));
        if (!button) return;
        win.clearTimeout(hideTimer);
        if (anchor === button && !popover.hidden) return;
        if (pinned) return;
        win.clearTimeout(showTimer);
        const delay = /** @type {Element} */ (event.target).closest('[data-help]') ? HOVER_DELAY : TITLE_HOVER_DELAY;
        showTimer = win.setTimeout(() => show(button), delay);
    }, { signal });
    root.addEventListener('pointerout', (event) => {
        if (event.pointerType === 'touch') return;
        const from = buttonFor(/** @type {Element} */ (event.target));
        const to = event.relatedTarget instanceof win.Element ? event.relatedTarget : null;
        if (!from || (to && (buttonFor(to) === from || popover.contains(to)))) return;
        win.clearTimeout(showTimer);
        if (anchor === from && doc.activeElement !== from) hideSoon();
    }, { signal });
    // The popover can be hovered (to read it) without closing
    popover.addEventListener('pointerenter', () => win.clearTimeout(hideTimer), { signal });
    popover.addEventListener('pointerleave', (event) => {
        if (anchor && event.relatedTarget instanceof win.Node && anchor.contains(event.relatedTarget)) return;
        if (anchor && doc.activeElement !== anchor) hideSoon();
    }, { signal });

    // Keyboard focus
    root.addEventListener('focusin', (event) => {
        const target = /** @type {HTMLElement} */ (event.target);
        if (!target.matches?.('[data-help]') || (anchor === target && !popover.hidden)) return;
        show(target);
    }, { signal });
    root.addEventListener('focusout', (event) => {
        if (event.target === anchor && !pinned) hide();
    }, { signal });

    // Click or tap: open and keep open; again: close
    root.addEventListener('click', (event) => {
        const button = /** @type {Element} */ (event.target).closest('[data-help]');
        if (!button || !root.contains(button)) return;
        event.preventDefault();
        if (anchor === button && !popover.hidden && pinned) hide();
        else show(/** @type {HTMLElement} */ (button), { pin: true });
    }, { signal });

    doc.addEventListener('pointerdown', (event) => {
        if (popover.hidden) return;
        const target = /** @type {Node} */ (event.target);
        if (popover.contains(target) || (anchor && anchor.contains(target))) return;
        hide();
    }, { signal, capture: true });
    doc.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || popover.hidden) return;
        event.preventDefault();
        event.stopPropagation();
        hide();
    }, { signal, capture: true });
    win.addEventListener('resize', position, { signal });
    win.addEventListener('scroll', position, { signal, capture: true, passive: true });

    return {
        /** After the builder re-renders: a popover whose button is gone closes. */
        sync() {
            if (anchor && !anchor.isConnected) hide();
        },
        hide,
        get open() { return !popover.hidden; },
        get element() { return popover; }
    };
}
