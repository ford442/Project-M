// ESLint for the browser host layer: html/ (the deployed modules), the
// framework wrappers in packages/web/src and the node:test suite in tests/web.
//
// Type-aware: every linted file belongs to one of the tsconfig programs that
// `npm run typecheck` already runs, so the promise rules see the same types tsc
// does. A file no program includes cannot be linted here — that is the point:
// "covered by lint" and "covered by typecheck" are the same set of files.
//
// The rules are the ones the host layer has been bitten by: a floating promise
// that swallowed a rejection (preset-tweaker's onApply), an async listener whose
// rejection went nowhere, page-global writes that a second context clobbers
// (scripts/check_host_globals.sh is the stricter, name-aware version of that
// check), and innerHTML built from strings that are not ours.

import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Writes to `window.*` outside projectm-globals.js (claimGlobal) are a bug. */
const WINDOW_WRITE = {
    selector: "AssignmentExpression > MemberExpression.left[object.name='window']",
    message:
        'Do not assign window.* directly: publish through claimGlobal() (projectm-globals.js) so a second context cannot clobber it.',
};

/** innerHTML from anything but a constant string is an injection point. */
const INNERHTML_WRITE = {
    selector:
        "AssignmentExpression[left.property.name=/^(innerHTML|outerHTML)$/]:not([right.type='Literal']):not([right.type='TemplateLiteral'][right.expressions.length=0])",
    message: 'innerHTML/outerHTML only take constant markup. Build dynamic parts with textContent / createElement.',
};

const TYPE_AWARE_RULES = {
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false, attributes: false } }],
    // The base rule cannot see `await using` / thenables; the TS one can.
    'require-await': 'off',
    '@typescript-eslint/require-await': 'error',
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': [
        'error',
        {
            args: 'after-used',
            argsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
            caughtErrors: 'none',
            ignoreRestSiblings: true,
        },
    ],
};

export default tseslint.config(
    {
        ignores: [
            '**/node_modules/**',
            // Third-party code, deployed as-is.
            'html/flac-decode/example/**',
            'html/flac-player/bundle.*.js',
            'html/flac-player/vendor/**',
            // Generated from cmake/WasmApiManifest.cmake; checked by check:api.
            'html/generated/**',
            'packages/web/dist/**',
            'packages/web/staging/**',
            'packages/web/playground/**',
            'packages/web/scripts/**',
            // Type declarations: tsc owns them.
            '**/*.ts',
        ],
    },
    js.configs.recommended,
    {
        linterOptions: { reportUnusedDisableDirectives: 'error' },
    },

    // ---- html/: the deployed host modules (DOM program) -------------------
    {
        files: ['html/**/*.js'],
        ignores: ['html/projectm-render-worker.js', 'html/worklets/**'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.browser },
            parser: tseslint.parser,
            parserOptions: { project: './html/tsconfig.json', tsconfigRootDir: import.meta.dirname },
        },
        plugins: { '@typescript-eslint': tseslint.plugin },
        rules: {
            ...TYPE_AWARE_RULES,
            'no-restricted-syntax': ['error', WINDOW_WRITE, INNERHTML_WRITE],
        },
    },
    {
        // claimGlobal() itself, and the classic (non-module) scripts.
        files: ['html/projectm-globals.js'],
        rules: { 'no-restricted-syntax': ['error', INNERHTML_WRITE] },
    },

    // ---- the render worker (WebWorker program) -----------------------------
    {
        files: ['html/projectm-render-worker.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: { ...globals.worker },
            parser: tseslint.parser,
            parserOptions: { project: './html/tsconfig.worker.json', tsconfigRootDir: import.meta.dirname },
        },
        plugins: { '@typescript-eslint': tseslint.plugin },
        rules: { ...TYPE_AWARE_RULES, 'no-restricted-syntax': ['error', INNERHTML_WRITE] },
    },

    // ---- AudioWorklet processors (AudioWorklet program) --------------------
    {
        files: ['html/worklets/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: { ...globals.audioWorklet },
            parser: tseslint.parser,
            parserOptions: { project: './html/tsconfig.worklet.json', tsconfigRootDir: import.meta.dirname },
        },
        plugins: { '@typescript-eslint': tseslint.plugin },
        rules: TYPE_AWARE_RULES,
    },

    // ---- packages/web/src: the framework wrappers --------------------------
    {
        files: ['packages/web/src/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.browser },
            parser: tseslint.parser,
            parserOptions: {
                project: './packages/web/tsconfig.src.json',
                tsconfigRootDir: import.meta.dirname,
                ecmaFeatures: { jsx: true },
            },
        },
        plugins: { '@typescript-eslint': tseslint.plugin },
        rules: TYPE_AWARE_RULES,
    },

    // ---- tests/web: the node:test suite ------------------------------------
    {
        files: ['tests/web/**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.node },
            parser: tseslint.parser,
            parserOptions: { project: './tests/web/tsconfig.json', tsconfigRootDir: import.meta.dirname },
        },
        plugins: { '@typescript-eslint': tseslint.plugin },
        rules: {
            ...TYPE_AWARE_RULES,
            // node:test's test()/describe() return promises the runner awaits.
            '@typescript-eslint/no-floating-promises': [
                'error',
                {
                    allowForKnownSafeCalls: [
                        { from: 'package', package: 'node:test', name: ['test', 'describe', 'it', 'suite'] },
                    ],
                },
            ],
            // Fakes implement async interfaces without awaiting anything.
            '@typescript-eslint/require-await': 'off',
        },
    }
);
