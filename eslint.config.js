import javascript from '@notmike101/eslint-config-js';
import jsdoc from '@notmike101/eslint-config-jsdoc';
import globals from 'globals';

export default [
    { ignores: ['vendor/**', 'dist/**', 'release/**', 'content/**', 'engine/target/**', '.omp/**', '.local/**', 'node_modules/**'] },
    ...javascript,
    ...jsdoc,
    { files: ['src/**/*.js', 'mods/**/*.js', 'mod-worker.js'], languageOptions: { globals: { ...globals.browser, GPUBufferUsage: 'readonly', GPUTextureUsage: 'readonly', GPUShaderStage: 'readonly' } } },
    { files: ['tests/**/*.js', 'scripts/**/*.mjs'], languageOptions: { globals: globals.node } },
    { files: ['scripts/check-browser-*.mjs'], languageOptions: { globals: globals.browser } },
];
