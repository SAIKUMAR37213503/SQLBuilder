// Projects: separate sets of templates, history, a schema and the query
// being built, for working on more than one database. Settings are shared;
// each project remembers its own dialect.
//
// The first project, Main, keeps its data under the same storage keys as
// before projects existed, so nothing is migrated and an older copy of the
// app still sees it. Other projects keep theirs under keys prefixed with
// the project's id.

import { createId } from './storage.js';
import { DIALECTS } from './dialects.js';

export const MAIN_PROJECT = 'main';
export const PROJECT_LIMIT = 20;
export const PROJECT_NAME_MAX = 60;

const PROJECTS_KEY = 'projects';
/** The keys a project's data lives under (see storageFor). */
export const PROJECT_KEYS = Object.freeze(['templates', 'history', 'schema', 'draft', 'draft-source']);

const ID = /^[a-z0-9-]{1,40}$/;

export class ProjectError extends Error {}

/** A project name as kept: trimmed, single spaces, at most PROJECT_NAME_MAX. */
export function cleanProjectName(name) {
    const text = String(name ?? '').trim().replace(/\s+/g, ' ');
    if (!text) throw new ProjectError('Enter a project name.');
    if (text.length > PROJECT_NAME_MAX) throw new ProjectError(`Project names can be at most ${PROJECT_NAME_MAX} characters.`);
    return text;
}

/**
 * A storage that keeps one project's keys apart: Main uses the plain keys,
 * any other project the same keys prefixed with its id.
 * @param {any} storage
 * @param {string} id
 */
export function projectStorage(storage, id) {
    if (id === MAIN_PROJECT) return storage;
    const scoped = (/** @type {string} */ key) => `p.${id}.${key}`;
    return {
        get available() { return storage.available; },
        get: (/** @type {string} */ key, fallback = null) => storage.get(scoped(key), fallback),
        set: (/** @type {string} */ key, /** @type {any} */ value) => storage.set(scoped(key), value),
        remove: (/** @type {string} */ key) => storage.remove(scoped(key)),
        getLegacy: () => null
    };
}

/**
 * @typedef {{ id: string, name: string, createdAt: number, dialect?: string }} Project
 */

/**
 * The list of projects and which one is open. Stored data is read as
 * untrusted: bad ids, names or dialects are dropped, Main always exists.
 * @param {any} storage
 * @param {{ now?: () => number }} [options]
 */
export function createProjectStore(storage, { now = () => Date.now() } = {}) {
    /** @type {Project[]} */
    let projects = [];
    let active = MAIN_PROJECT;

    const stored = storage.get(PROJECTS_KEY, null);
    if (stored && typeof stored === 'object' && Array.isArray(stored.projects)) {
        const seen = new Set();
        for (const p of stored.projects.slice(0, PROJECT_LIMIT * 2)) {
            if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !ID.test(p.id) || seen.has(p.id)) continue;
            let name;
            try {
                name = cleanProjectName(p.name);
            } catch {
                continue;
            }
            if (projects.some(q => q.name.toLowerCase() === name.toLowerCase())) continue;
            if (projects.length >= PROJECT_LIMIT) break;
            seen.add(p.id);
            projects.push({
                id: p.id,
                name,
                createdAt: Number.isFinite(p.createdAt) && p.createdAt > 0 ? p.createdAt : 0,
                ...(typeof p.dialect === 'string' && Object.hasOwn(DIALECTS, p.dialect) ? { dialect: p.dialect } : {})
            });
        }
        if (typeof stored.active === 'string' && seen.has(stored.active)) active = stored.active;
    }
    if (!projects.some(p => p.id === MAIN_PROJECT)) {
        const name = projects.some(p => p.name.toLowerCase() === 'main') ? 'Main (1)' : 'Main';
        projects = [{ id: MAIN_PROJECT, name, createdAt: 0 }, ...projects.slice(0, PROJECT_LIMIT - 1)];
    }

    function persist(next, nextActive = active) {
        // Only Main and nothing changed: no key at all, as before projects
        const plain = next.length === 1 && next[0].name === 'Main' && !next[0].dialect && nextActive === MAIN_PROJECT;
        const ok = plain ? (storage.remove(PROJECTS_KEY), true) : storage.set(PROJECTS_KEY, { active: nextActive, projects: next });
        if (!ok) {
            throw new ProjectError(storage.available
                ? 'Browser storage is full; delete some templates or history first.'
                : 'Browser storage is unavailable, so projects can\'t be saved.');
        }
        projects = next;
        active = nextActive;
    }

    function find(id) {
        const project = projects.find(p => p.id === id);
        if (!project) throw new ProjectError('That project no longer exists.');
        return project;
    }

    function uniqueCheck(name, exceptId = null) {
        const taken = projects.find(p => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase());
        if (taken) throw new ProjectError(`A project named ${taken.name} already exists.`);
    }

    return {
        /** Main first, then the others by name. */
        list: () => [
            ...projects.filter(p => p.id === MAIN_PROJECT),
            ...projects.filter(p => p.id !== MAIN_PROJECT).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
        ],

        get: (/** @type {string} */ id) => projects.find(p => p.id === id) || null,

        /** A project by name, ignoring case. */
        named: (/** @type {string} */ name) => projects.find(p => p.name.toLowerCase() === String(name).trim().toLowerCase()) || null,

        get active() { return active; },

        get size() { return projects.length; },

        /** The storage a project's data lives in. */
        storageFor: (/** @type {string} */ id) => projectStorage(storage, find(id).id),

        /**
         * @param {string} name
         * @param {{ dialect?: string }} [details]
         */
        create(name, { dialect } = {}) {
            const clean = cleanProjectName(name);
            uniqueCheck(clean);
            if (projects.length >= PROJECT_LIMIT) throw new ProjectError(`You can have up to ${PROJECT_LIMIT} projects.`);
            let id = createId().toLowerCase();
            while (projects.some(p => p.id === id) || id === MAIN_PROJECT) id = createId().toLowerCase();
            /** @type {Project} */
            const project = {
                id, name: clean, createdAt: now(),
                ...(dialect && Object.hasOwn(DIALECTS, dialect) ? { dialect } : {})
            };
            persist([...projects, project]);
            return project;
        },

        rename(id, name) {
            const clean = cleanProjectName(name);
            find(id);
            uniqueCheck(clean, id);
            persist(projects.map(p => (p.id === id ? { ...p, name: clean } : p)));
            return find(id);
        },

        /** Deletes a project and everything kept in it. Main can't be deleted. */
        remove(id) {
            const project = find(id);
            if (project.id === MAIN_PROJECT) throw new ProjectError('The Main project can\'t be deleted.');
            const scoped = projectStorage(storage, project.id);
            persist(projects.filter(p => p.id !== id), active === id ? MAIN_PROJECT : active);
            for (const key of PROJECT_KEYS) scoped.remove(key);
        },

        setActive(id) {
            persist(projects, find(id).id);
        },

        /** Remembers the dialect a project was last used with. */
        setDialect(id, dialect) {
            const project = find(id);
            if (project.dialect === dialect || !Object.hasOwn(DIALECTS, dialect)) return;
            persist(projects.map(p => (p.id === id ? { ...p, dialect } : p)));
        },

        /** Deletes every project but Main, with its data, and resets Main. */
        clear() {
            for (const p of projects) {
                if (p.id !== MAIN_PROJECT) for (const key of PROJECT_KEYS) projectStorage(storage, p.id).remove(key);
            }
            persist([{ id: MAIN_PROJECT, name: 'Main', createdAt: 0 }], MAIN_PROJECT);
        }
    };
}

/**
 * How much a project holds, read straight from storage (for the list).
 * @param {any} scoped a projectStorage
 */
export function projectCounts(scoped) {
    const length = (/** @type {any} */ value) => (Array.isArray(value) ? value.length : 0);
    const schema = scoped.get('schema', null);
    return {
        templates: length(scoped.get('templates', [])),
        history: length(scoped.get('history', [])),
        tables: schema && typeof schema === 'object' ? length(schema.tables) : 0
    };
}
