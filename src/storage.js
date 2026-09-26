// Safe wrapper around localStorage. Storage can be unavailable (privacy
// modes, blocked site data) or full; the app must keep working either way,
// so every access is guarded and failures are reported, never thrown.

export const STORAGE_PREFIX = 'sqlb:v1:';

function defaultBackend() {
    try {
        return globalThis.localStorage || null;
    } catch {
        return null; // some browsers throw just for reading window.localStorage
    }
}

// Returns the backend if it can at least be read, otherwise null. A full
// storage (quota exceeded) is still readable; writes then fail individually.
function readable(backend) {
    if (!backend) return null;
    try {
        backend.getItem(`${STORAGE_PREFIX}probe`);
        return backend;
    } catch {
        return null;
    }
}

/**
 * @param {any} [candidate] a Storage-like object; defaults to window.localStorage
 */
export function createStorage(candidate = defaultBackend()) {
    const backend = readable(candidate);
    return {
        available: backend !== null,

        /** Parsed JSON value, or `fallback` when missing/unreadable. */
        get(key, fallback = null) {
            if (!backend) return fallback;
            try {
                const raw = backend.getItem(STORAGE_PREFIX + key);
                return raw === null ? fallback : JSON.parse(raw);
            } catch {
                return fallback;
            }
        },

        /** Returns false when the value could not be stored (e.g. quota exceeded). */
        set(key, value) {
            if (!backend) return false;
            try {
                backend.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
                return true;
            } catch {
                return false;
            }
        },

        remove(key) {
            if (!backend) return;
            try {
                backend.removeItem(STORAGE_PREFIX + key);
            } catch {
                // ignore
            }
        },

        // Reads a key written without the prefix by an older version of the app.
        getLegacy(key) {
            if (!backend) return null;
            try {
                return backend.getItem(key);
            } catch {
                return null;
            }
        }
    };
}

/** In-memory Storage implementation (tests, and a fallback shape reference). */
export function createMemoryBackend(initial = {}) {
    const data = new Map(Object.entries(initial));
    return {
        getItem: (key) => (data.has(key) ? data.get(key) : null),
        setItem: (key, value) => { data.set(key, String(value)); },
        removeItem: (key) => { data.delete(key); },
        get size() { return data.size; }
    };
}

export function createId() {
    const random = globalThis.crypto?.getRandomValues
        ? Array.from(globalThis.crypto.getRandomValues(new Uint32Array(2)), n => n.toString(36)).join('')
        : Math.random().toString(36).slice(2);
    return `${Date.now().toString(36)}-${random}`;
}
