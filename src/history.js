// Query history: the most recent generated queries, kept in localStorage.
// Entries are only added on an explicit Generate, never while typing.

import { createId } from './storage.js';
import { normalizeWorkspace } from './serialization.js';

export const HISTORY_LIMIT = 50;
const MAX_ENTRY_BYTES = 100 * 1024;
const HISTORY_KEY = 'history';

export function createHistory(storage, { limit = HISTORY_LIMIT, now = () => Date.now() } = {}) {
    let entries = load();

    function load() {
        const stored = storage.get(HISTORY_KEY, []);
        if (!Array.isArray(stored)) return [];
        // Drop anything malformed rather than failing to start
        return stored.flatMap(entry => {
            try {
                if (typeof entry.sql !== 'string' || typeof entry.id !== 'string') return [];
                return [{
                    id: entry.id,
                    timestamp: Number(entry.timestamp) || 0,
                    type: String(entry.type),
                    dialect: String(entry.dialect || 'generic'),
                    sql: entry.sql,
                    workspace: normalizeWorkspace(entry.workspace)
                }];
            } catch {
                return [];
            }
        }).slice(0, limit);
    }

    function persist() {
        // If storage is full, keep dropping the oldest half until it fits
        let toSave = entries;
        while (!storage.set(HISTORY_KEY, toSave)) {
            if (toSave.length <= 1) return false;
            toSave = toSave.slice(0, Math.ceil(toSave.length / 2));
        }
        entries = toSave;
        return true;
    }

    return {
        list: () => entries.slice(),

        /** Adds an entry (newest first). Returns the entry, or null if not stored. */
        add({ type, dialect, sql, workspace }) {
            if (!sql) return null;
            const snapshot = structuredClone(workspace);
            if (JSON.stringify(snapshot).length + sql.length > MAX_ENTRY_BYTES) return null;
            const latest = entries[0];
            if (latest && latest.sql === sql && latest.dialect === dialect) {
                latest.timestamp = now();
                latest.workspace = snapshot;
                persist();
                return latest;
            }
            const entry = { id: createId(), timestamp: now(), type, dialect, sql, workspace: snapshot };
            entries = [entry, ...entries].slice(0, limit);
            persist();
            return entry;
        },

        get: (id) => entries.find(e => e.id === id) || null,

        /**
         * Restores entries from a backup (already validated). Merge adds the
         * ones that aren't here yet; replace swaps the list. Newest first,
         * up to the history limit.
         * @param {any[]} items
         * @param {{ replace?: boolean }} [options]
         * @returns {{ added: number, skipped: number, dropped: number }}
         */
        restore(items, { replace = false } = {}) {
            const key = (e) => `${e.timestamp}|${e.dialect}|${e.sql}`;
            const base = replace ? [] : entries;
            const seen = new Set(base.map(key));
            const fresh = [];
            let skipped = 0;
            for (const item of items) {
                if (seen.has(key(item))) {
                    skipped++;
                    continue;
                }
                seen.add(key(item));
                fresh.push({ id: createId(), timestamp: item.timestamp, type: item.type, dialect: item.dialect, sql: item.sql, workspace: structuredClone(item.workspace) });
            }
            const combined = [...base, ...fresh].sort((a, b) => b.timestamp - a.timestamp);
            entries = combined.slice(0, limit);
            if (entries.length) persist(); // may keep fewer when storage is nearly full
            else storage.remove(HISTORY_KEY);
            const keptIds = new Set(entries.map(e => e.id));
            return { added: fresh.filter(e => keptIds.has(e.id)).length, skipped, dropped: combined.length - entries.length };
        },

        remove(id) {
            entries = entries.filter(e => e.id !== id);
            persist();
        },

        clear() {
            entries = [];
            storage.remove(HISTORY_KEY);
        },

        search(query) {
            const needle = query.trim().toLowerCase();
            if (!needle) return entries.slice();
            return entries.filter(e => e.sql.toLowerCase().includes(needle) || e.type.includes(needle));
        }
    };
}
