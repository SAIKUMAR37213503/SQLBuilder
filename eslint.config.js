import js from '@eslint/js';
import globals from 'globals';

export default [
    {
        ignores: ['node_modules/', 'Fabric_Sync/', 'graphify-out/']
    },
    js.configs.recommended,
    {
        // Browser app, loaded as a classic <script> so it works from file://
        files: ['script.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: { ...globals.browser }
        }
    },
    {
        files: ['*.test.js', 'eslint.config.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.node, ...globals.browser }
        }
    },
    {
        rules: {
            'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            eqeqeq: ['error', 'always'],
            'prefer-const': 'error',
            'no-var': 'error'
        }
    }
];
