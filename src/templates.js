// Saved query templates (user-named workspaces), kept in localStorage.

import { createId } from './storage.js';
import { normalizeWorkspace } from './serialization.js';
import { DIALECTS } from './dialects.js';

export const TEMPLATE_LIMIT = 200;
export const TEMPLATE_NAME_MAX = 80;
export const TEMPLATE_DESCRIPTION_MAX = 200;
export const TEMPLATE_CATEGORY_MAX = 40;

const cleanText = (text, max) => (typeof text === 'string' ? text.trim().replace(/\s+/g, ' ').slice(0, max) : '');

/**
 * Optional details of a template: the dialect it was saved for, a description
 * and a category. Templates from older versions have none of them; empty or
 * unknown values are left out.
 * @param {{ dialect?: any, description?: any, category?: any }} source
 */
export function templateDetails({ dialect, description, category } = {}) {
    const details = {};
    if (typeof dialect === 'string' && Object.hasOwn(DIALECTS, dialect)) details.dialect = dialect;
    const text = cleanText(description, TEMPLATE_DESCRIPTION_MAX);
    if (text) details.description = text;
    const group = cleanText(category, TEMPLATE_CATEGORY_MAX);
    if (group) details.category = group;
    return /** @type {{ dialect?: string, description?: string, category?: string }} */ (details);
}
const TEMPLATES_KEY = 'templates';

export class TemplateError extends Error {}

export function createTemplateStore(storage, { now = () => Date.now() } = {}) {
    let templates = load();

    function load() {
        const stored = storage.get(TEMPLATES_KEY, []);
        if (!Array.isArray(stored)) return [];
        return stored.flatMap(t => {
            try {
                if (typeof t.id !== 'string' || typeof t.name !== 'string') return [];
                return [{
                    id: t.id,
                    name: t.name.slice(0, TEMPLATE_NAME_MAX),
                    createdAt: Number(t.createdAt) || 0,
                    updatedAt: Number(t.updatedAt) || 0,
                    ...templateDetails(t),
                    workspace: normalizeWorkspace(t.workspace)
                }];
            } catch {
                return [];
            }
        });
    }

    function persist() {
        if (!storage.set(TEMPLATES_KEY, templates)) {
            throw new TemplateError(storage.available
                ? 'Browser storage is full; delete some templates or history first.'
                : 'Browser storage is unavailable, so templates can\'t be saved.');
        }
    }

    function cleanName(name) {
        const trimmed = String(name ?? '').trim().replace(/\s+/g, ' ');
        if (!trimmed) throw new TemplateError('Enter a template name.');
        if (trimmed.length > TEMPLATE_NAME_MAX) throw new TemplateError(`Template names can be at most ${TEMPLATE_NAME_MAX} characters.`);
        return trimmed;
    }

    // "Report" -> "Report (2)" when the name is taken
    function uniqueName(name, exceptId = null) {
        const taken = new Set(templates.filter(t => t.id !== exceptId).map(t => t.name.toLowerCase()));
        if (!taken.has(name.toLowerCase())) return name;
        const base = name.replace(/ \(\d+\)$/, '');
        for (let n = 2; ; n++) {
            const candidate = `${base} (${n})`;
            if (!taken.has(candidate.toLowerCase())) return candidate;
        }
    }

    function withTransaction(change) {
        const before = templates;
        try {
            change();
            persist();
        } catch (error) {
            templates = before;
            throw error;
        }
    }

    function find(id) {
        const template = templates.find(t => t.id === id);
        if (!template) throw new TemplateError('That template no longer exists.');
        return template;
    }

    return {
        list: () => templates.slice().sort((a, b) => a.name.localeCompare(b.name)),

        get: (id) => templates.find(t => t.id === id) || null,

        /**
         * @param {string} name
         * @param {any} workspace
         * @param {{ dialect?: string, description?: string, category?: string }} [details]
         */
        create(name, workspace, details = {}) {
            if (templates.length >= TEMPLATE_LIMIT) throw new TemplateError(`You can keep up to ${TEMPLATE_LIMIT} templates.`);
            const time = now();
            const template = {
                id: createId(),
                name: uniqueName(cleanName(name)),
                createdAt: time,
                updatedAt: time,
                ...templateDetails(details),
                workspace: structuredClone(workspace)
            };
            withTransaction(() => { templates = [...templates, template]; });
            return template;
        },

        /** Categories in use, for suggestions when saving. */
        categories: () => [...new Set(templates.map(t => t.category).filter(Boolean))].sort((a, b) => a.localeCompare(b)),

        rename(id, name) {
            const existing = find(id);
            const renamed = { ...existing, name: uniqueName(cleanName(name), id), updatedAt: now() };
            withTransaction(() => {
                templates = templates.map(t => (t.id === id ? renamed : t));
            });
            return renamed;
        },

        duplicate(id) {
            const source = find(id);
            return this.create(`${source.name} copy`, source.workspace, source);
        },

        remove(id) {
            withTransaction(() => { templates = templates.filter(t => t.id !== id); });
        },

        /** Adds already-validated templates; name clashes get a numeric suffix. */
        importMany(items) {
            if (templates.length + items.length > TEMPLATE_LIMIT) {
                throw new TemplateError(`Importing would exceed the limit of ${TEMPLATE_LIMIT} templates.`);
            }
            const added = [];
            withTransaction(() => {
                for (const item of items) {
                    const time = now();
                    const template = {
                        id: createId(),
                        name: uniqueName(cleanName(item.name)),
                        createdAt: time,
                        updatedAt: time,
                        ...templateDetails(item),
                        workspace: structuredClone(item.workspace)
                    };
                    templates = [...templates, template];
                    added.push(template);
                }
            });
            return added;
        }
    };
}
