import javascript from '@notmike101/eslint-config-js';
import jsdoc from '@notmike101/eslint-config-jsdoc';
import html from 'eslint-plugin-html';
import globals from 'globals';

export default [
    { ignores: ['target/**', '.tools/**', '.m2/**', '.local/**', 'node_modules/**'] },
    ...javascript,
    ...jsdoc,
    {
        files: ['**/*.mjs'],
        languageOptions: { globals: globals.nodeBuiltin },
    },
    {
        files: ['src/main/webapp/**/*.{js,html}', 'browser-jvm/**/*.{js,html}'],
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.worker,
                cheerpjInit: 'readonly',
                cheerpjRunMain: 'readonly',
            },
        },
    },
    {
        files: ['**/*.html'],
        plugins: { html },
    },
];
