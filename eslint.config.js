// SPDX-License-Identifier: GPL-3.0-or-later
// GNOME Shell's ESLint rules: the shared GNOME configuration at the commit Shell pins, and the rules Shell adds to
// it. Shell's JSDoc rules are left out; this code describes functions with line comments.
import {defineConfig} from 'eslint/config';
import globals from 'globals';
import gnome from 'eslint-config-gnome';

export default defineConfig([
    gnome.configs.recommended,
    {ignores: ['dist/**', 'node_modules/**']},
    {
        rules: {
            camelcase: ['error', {properties: 'never'}],
            'consistent-return': 'error',
            'eqeqeq': ['error', 'smart'],
            'key-spacing': ['error', {mode: 'minimum', beforeColon: false, afterColon: true}],
            'prefer-arrow-callback': 'error',
            'prefer-const': ['error', {destructuring: 'all'}],
            // Streaming pixels band by band, retrying the recorder and running tests in order wait in loops on purpose.
            'no-await-in-loop': 'off',
        },
    },
    // Modules GNOME Shell loads see its `global` object.
    {files: ['extension/**'], languageOptions: {globals: {global: 'readonly'}}},
    {files: ['tests/*.test.js'], languageOptions: {globals: globals.node}},
]);
