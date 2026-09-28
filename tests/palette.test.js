import { describe, expect, test } from 'vitest';
import { filterCommands } from '../src/ui/palette.js';

const noop = () => {};
const commands = [
    { id: 'generate', group: 'SQL', label: 'Generate SQL', keywords: 'run build', run: noop },
    { id: 'copy', group: 'SQL', label: 'Copy SQL', run: noop },
    { id: 'dialect-mysql', group: 'Dialect', label: 'Use MySQL', keywords: 'dialect database', run: noop },
    { id: 'theme', group: 'View', label: 'Switch theme to Dark', keywords: 'appearance', run: noop },
    { id: 'type-delete', group: 'Query', label: 'Switch to DELETE', run: noop }
];
const ids = (query) => filterCommands(commands, query).map(c => c.id);

describe('command palette filtering', () => {
    test('an empty query lists every command in order', () => {
        expect(ids('')).toEqual(commands.map(c => c.id));
        expect(ids('   ')).toHaveLength(commands.length);
    });

    test('every word must match the label, group or keywords, in any case', () => {
        expect(ids('sql')).toEqual(['generate', 'copy', 'dialect-mysql']);
        expect(ids('DARK theme')).toEqual(['theme']);
        expect(ids('database')).toEqual(['dialect-mysql']);
        expect(ids('copy dark')).toEqual([]);
    });

    test('labels starting with the query come first, then labels with a word starting with it', () => {
        // "Dark" and "DELETE" start a word; "build" and "dialect" only contain a d
        expect(ids('d')).toEqual(['theme', 'type-delete', 'generate', 'dialect-mysql']);
        expect(ids('u')).toEqual(['dialect-mysql', 'generate', 'type-delete']);
        expect(ids('switch')).toEqual(['theme', 'type-delete']);
    });
});
