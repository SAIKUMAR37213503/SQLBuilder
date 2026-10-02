// The list of databases in the SQL Lab: names and dates, kept in browser
// storage under one app-wide key (databases are shared by all projects).
// The data itself lives with the engine (see files.js); this list is what
// the explorer shows. Stored data is read as untrusted.

import { createId } from '../storage.js';
import { isDatabaseId } from './engine.js';

export const DATABASE_LIMIT = 50;
export const DATABASE_NAME_MAX = 60;
const KEY = 'databases';

export class DatabaseListError extends Error {}

/**
 * @typedef {{ id: string, name: string, createdAt: number, updatedAt: number }} DatabaseEntry
 */

/** A database name as kept: trimmed, single spaces, at most DATABASE_NAME_MAX. */
export function cleanDatabaseName(name) {
    const text = String(name ?? '').trim().replace(/\s+/g, ' ');
    if (!text) throw new DatabaseListError('Enter a database name.');
    if (text.length > DATABASE_NAME_MAX) throw new DatabaseListError(`Database names can be at most ${DATABASE_NAME_MAX} characters.`);
    return text;
}

const validTime = (/** @type {unknown} */ t) => (typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : 0);

/**
 * @param {any} storage
 * @param {{ now?: () => number }} [options]
 */
export function createDatabaseList(storage, { now = () => Date.now() } = {}) {
    /** @type {DatabaseEntry[]} */
    let entries = [];
    /** @type {string | null} */
    let lastOpen = null;

    const stored = storage.get(KEY, null);
    if (stored && typeof stored === 'object' && Array.isArray(stored.databases)) {
        for (const d of stored.databases.slice(0, DATABASE_LIMIT * 2)) {
            if (!d || typeof d !== 'object' || !isDatabaseId(d.id) || entries.some(e => e.id === d.id)) continue;
            let name;
            try {
                name = cleanDatabaseName(d.name);
            } catch {
                continue;
            }
            if (entries.some(e => e.name.toLowerCase() === name.toLowerCase())) continue;
            if (entries.length >= DATABASE_LIMIT) break;
            entries.push({ id: d.id, name, createdAt: validTime(d.createdAt), updatedAt: validTime(d.updatedAt) || validTime(d.createdAt) });
        }
        if (typeof stored.lastOpen === 'string' && entries.some(e => e.id === stored.lastOpen)) lastOpen = stored.lastOpen;
    }

    function persist(next, nextLastOpen = lastOpen) {
        const ok = next.length ? storage.set(KEY, { lastOpen: nextLastOpen, databases: next }) : (storage.remove(KEY), true);
        if (!ok) {
            throw new DatabaseListError(storage.available
                ? 'Browser storage is full; delete some templates or history first.'
                : 'Browser storage is unavailable, so the database list can\'t be saved.');
        }
        entries = next;
        lastOpen = nextLastOpen;
    }

    function find(id) {
        const entry = entries.find(e => e.id === id);
        if (!entry) throw new DatabaseListError('That database no longer exists.');
        return entry;
    }

    function checkName(name, exceptId = null) {
        const clean = cleanDatabaseName(name);
        const taken = entries.find(e => e.id !== exceptId && e.name.toLowerCase() === clean.toLowerCase());
        if (taken) throw new DatabaseListError(`A database named ${taken.name} already exists.`);
        return clean;
    }

    return {
        /** By name. */
        list: () => [...entries].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),

        get: (/** @type {string} */ id) => entries.find(e => e.id === id) || null,

        get size() { return entries.length; },

        get lastOpen() { return lastOpen; },

        /**
         * Checks a new database can be added; returns its id and cleaned name.
         * Nothing is stored until add(), after the engine has created the data.
         * @param {string} name
         */
        prepare(name) {
            const clean = checkName(name);
            if (entries.length >= DATABASE_LIMIT) throw new DatabaseListError(`You can have up to ${DATABASE_LIMIT} databases.`);
            let id = createId().toLowerCase();
            while (entries.some(e => e.id === id)) id = createId().toLowerCase();
            return { id, name: clean };
        },

        /** @param {{ id: string, name: string }} prepared */
        add({ id, name }) {
            if (!isDatabaseId(id) || entries.some(e => e.id === id)) throw new DatabaseListError('That database id isn\'t valid.');
            const clean = checkName(name);
            const time = now();
            const entry = { id, name: clean, createdAt: time, updatedAt: time };
            persist([...entries, entry]);
            return entry;
        },

        rename(id, name) {
            find(id);
            const clean = checkName(name, id);
            persist(entries.map(e => (e.id === id ? { ...e, name: clean } : e)));
            return find(id);
        },

        /** Notes that a database's data changed. */
        touch(id) {
            if (!entries.some(e => e.id === id)) return;
            try {
                persist(entries.map(e => (e.id === id ? { ...e, updatedAt: now() } : e)));
            } catch {
                // the date is informational; the data itself is saved by the engine
            }
        },

        remove(id) {
            find(id);
            persist(entries.filter(e => e.id !== id), lastOpen === id ? null : lastOpen);
        },

        setLastOpen(id) {
            if (id !== null) find(id);
            if (lastOpen !== id) persist(entries, id);
        },

        /** A free name based on `name`: "Company DB (copy)", "Company DB (copy 2)"... */
        copyName(name) {
            for (let n = 1; ; n++) {
                const suffix = n === 1 ? ' (copy)' : ` (copy ${n})`;
                const candidate = `${String(name).slice(0, DATABASE_NAME_MAX - suffix.length).trimEnd()}${suffix}`;
                if (!entries.some(e => e.name.toLowerCase() === candidate.toLowerCase())) return candidate;
            }
        },

        clear() {
            persist([], null);
        }
    };
}
