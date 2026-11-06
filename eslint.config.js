import js from '@eslint/js';
import globals from 'globals';

export default [
    { ignores: ['node_modules/**', '.agent-state/**', 'test/fixtures/**', 'runs/**'] },
    js.configs.recommended,
    {
        languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } },
        rules: {
            'no-empty': ['error', { allowEmptyCatch: true }],
            'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
            'no-useless-assignment': 'off',
            'preserve-caught-error': 'off',
            'no-ex-assign': 'off',
            'no-control-regex': 'off',
        },
    },
    { files: ['**/*.cjs'], languageOptions: { sourceType: 'commonjs' } },
    { files: ['src/sandbox/assets/**'], languageOptions: { sourceType: 'commonjs' } },
    { files: ['src/vision/world_worker.cjs'], languageOptions: { globals: { ...globals.worker } } },
    {
        files: ['src/tools/compute-worker.js'],
        languageOptions: { globals: { lockdown: 'readonly', Compartment: 'readonly' } },
    },
];
