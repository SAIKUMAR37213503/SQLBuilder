// How the page talks to the database engine. The worker client starts the
// database worker the first time it's needed; the direct client runs the
// engine in the page (tests). Both expose the same interface:
//
//   call(op, args)   a promise of the operation's result (see dispatch.js)
//   start()          starts the engine; a promise of its info
//   restart()        stops whatever is running (a long query) and starts over;
//                    the open database is closed and must be opened again
//   state            { status: 'idle' | 'starting' | 'ready' | 'failed', info, error }
//   destroy()

import { DatabaseError } from './engine.js';
import { dispatch, serializeError, deserializeError } from './dispatch.js';

/**
 * @param {{
 *   createWorker: () => Worker,
 *   wasmUrl: string,
 *   onChange?: (state: any) => void
 * }} options
 */
export function createWorkerClient({ createWorker, wasmUrl, onChange = () => {} }) {
    /** @type {Worker | null} */
    let worker = null;
    /** @type {Promise<any> | null} */
    let starting = null;
    /** @type {Map<number, { resolve: (value: any) => void, reject: (error: any) => void }>} */
    const pending = new Map();
    let nextId = 1;
    const state = { status: 'idle', info: null, error: null };

    function set(changes) {
        Object.assign(state, changes);
        onChange({ ...state });
    }

    function failAll(error) {
        for (const { reject } of pending.values()) reject(error);
        pending.clear();
    }

    function stopWorker(error) {
        if (worker) {
            worker.terminate();
            worker = null;
        }
        starting = null;
        failAll(error);
    }

    function post(op, args) {
        return new Promise((resolve, reject) => {
            const id = nextId++;
            pending.set(id, { resolve, reject });
            worker.postMessage({ id, op, args });
        });
    }

    function start() {
        if (starting) return starting;
        set({ status: 'starting', error: null });
        try {
            worker = createWorker();
        } catch (error) {
            set({ status: 'failed', error: serializeError(error).message });
            return Promise.reject(new DatabaseError('The database engine couldn\'t start in this browser.', { code: 'ENGINE_UNAVAILABLE' }));
        }
        worker.onmessage = (event) => {
            const { id, ok, value, error } = event.data || {};
            const waiting = pending.get(id);
            if (!waiting) return;
            pending.delete(id);
            if (ok) waiting.resolve(value);
            else waiting.reject(deserializeError(error));
        };
        worker.onerror = (event) => {
            event.preventDefault?.();
            stopWorker(new DatabaseError('The database engine stopped unexpectedly.', { code: 'ENGINE_UNAVAILABLE' }));
            set({ status: 'failed', error: event.message || 'The database worker failed to load.' });
        };
        const started = post('init', { wasmUrl }).then(
            (info) => {
                set({ status: 'ready', info });
                return info;
            },
            (error) => {
                stopWorker(error);
                set({ status: 'failed', error: error.message });
                // A failed start stays failed until restart(), so later calls don't retry silently
                starting = Promise.reject(new DatabaseError('The database engine couldn\'t start in this browser.', { code: 'ENGINE_UNAVAILABLE' }));
                starting.catch(() => {});
                throw error;
            });
        starting = started;
        return started;
    }

    return {
        get state() {
            return { ...state };
        },
        start,
        async call(op, args = {}) {
            await start();
            return post(op, args);
        },
        restart() {
            stopWorker(new DatabaseError('Stopped.', { code: 'STOPPED' }));
            set({ status: 'idle', info: null, error: null });
            return start();
        },
        destroy() {
            stopWorker(new DatabaseError('Stopped.', { code: 'STOPPED' }));
            set({ status: 'idle', info: null, error: null });
        }
    };
}

/**
 * The engine in the page, behind the same interface (results are copied and
 * errors re-created, as when they cross from the worker).
 * @param {() => any | Promise<any>} createAdapter
 * @param {{ onChange?: (state: any) => void, storageReason?: string | null }} [options]
 */
export function createDirectClient(createAdapter, { onChange = () => {}, storageReason = null } = {}) {
    /** @type {Promise<any> | null} */
    let adapter = null;
    const state = { status: 'idle', info: null, error: null };
    const set = (changes) => {
        Object.assign(state, changes);
        onChange({ ...state });
    };

    async function start() {
        if (!adapter) {
            set({ status: 'starting' });
            adapter = Promise.resolve().then(createAdapter);
        }
        const engine = await adapter;
        const info = { ...engine.info(), storageReason };
        if (state.status !== 'ready') set({ status: 'ready', info });
        return info;
    }

    return {
        get state() {
            return { ...state };
        },
        start,
        async call(op, args = {}) {
            await start();
            const engine = await adapter;
            try {
                return structuredClone(await dispatch(engine, op, structuredClone(args)));
            } catch (error) {
                throw deserializeError(serializeError(error));
            }
        },
        async restart() {
            const engine = await adapter;
            engine?.close();
            set({ status: 'idle', info: null });
            return start();
        },
        destroy() {
            adapter?.then(engine => engine.destroy());
            adapter = null;
            set({ status: 'idle', info: null, error: null });
        }
    };
}
