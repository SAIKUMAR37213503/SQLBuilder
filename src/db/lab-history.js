// SQL Lab's history: the SQL run in SQL Lab, newest first, with which
// database it ran in and what the engine reported. Kept apart from the
// builder's history (its own app-level key, `lab-history`).

export const LAB_HISTORY_LIMIT = 50;
const MAX_SQL_CHARS = 100 * 1024;
const KEY = 'lab-history';

/**
 * @typedef {{ id: string, sql: string, databaseId: string, databaseName: string,
 *   ranAt: number, ok: boolean, summary: string }} LabHistoryEntry
 */

const valid = (/** @type {any} */ e) => e && typeof e.id === 'string' && typeof e.sql === 'string' && typeof e.ranAt === 'number';

/**
 * @param {any} storage
 * @param {{ limit?: number, now?: () => number }} [options]
 */
export function createLabHistory(storage, { limit = LAB_HISTORY_LIMIT, now = () => Date.now() } = {}) {
    let next = 0;
    /** @returns {LabHistoryEntry[]} */
    function read() {
        const stored = storage.get(KEY, []);
        return Array.isArray(stored) ? stored.filter(valid) : [];
    }
    const write = (/** @type {LabHistoryEntry[]} */ entries) => storage.set(KEY, entries);

    return {
        list: read,

        get: (/** @type {string} */ id) => read().find(e => e.id === id) || null,

        /**
         * Adds a run. Running the same SQL again in the same database moves it to the top.
         * Returns the entry, or null when the SQL is empty or too long to keep.
         * @param {{ sql: string, databaseId: string, databaseName: string, ok: boolean, summary: string }} run
         */
        add({ sql, databaseId, databaseName, ok, summary }) {
            const text = String(sql ?? '').trim();
            if (!text || text.length > MAX_SQL_CHARS) return null;
            const ranAt = now();
            /** @type {LabHistoryEntry} */
            const entry = { id: `${ranAt.toString(36)}-${(next++).toString(36)}`, sql: text, databaseId, databaseName, ranAt, ok: Boolean(ok), summary: String(summary ?? '') };
            const rest = read().filter(e => !(e.sql === text && e.databaseId === databaseId));
            write([entry, ...rest].slice(0, limit));
            return entry;
        },

        remove(/** @type {string} */ id) {
            write(read().filter(e => e.id !== id));
        },

        clear() {
            storage.remove(KEY);
        }
    };
}
