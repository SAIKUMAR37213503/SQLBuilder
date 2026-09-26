import js from '@eslint/js';
import globals from 'globals';

export default [
    {
        ignores: ['node_modules/', 'dist/', 'Fabric_Sync/', 'graphify-out/']
    },
    js.configs.recommended,
    {
        // Legacy single-file app (replaced by src/ + dist/ in a later step)
        files: ['script.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: { ...globals.browser }
        }
    },
    {
        files: ['src/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.browser }
        }
    },
    {
        files: ['*.test.js', 'tests/**/*.js', '*.config.js', 'scripts/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.node, ...globals.browser }
        }
    },
    {
        rules: {
            'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            eqeqeq: ['error', 'always', { null: 'ignore' }],
            'prefer-const': 'error',
            'no-var': 'error'
        }
    }
];
