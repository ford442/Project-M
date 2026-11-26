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
import { CLASSIC_SCRIPTS, listHtmlTsModules } from './scripts/html-ts-modules.mjs';

// html/'s TypeScript modules: lint the .ts, never the .js emitted from it.
const HTML_TS_MODULES = listHtmlTsModules();
const EMITTED_JS = HTML_TS_MODULES.map(({ js }) => `html/${js}`);
const HTML_TS = HTML_TS_MODULES.filter(({ ts }) => !CLASSIC_SCRIPTS.has(ts)).map(({ ts }) => `html/${ts}`);
const WORKER_TS = HTML_TS_MODULES.filter(({ ts }) => CLASSIC_SCRIPTS.has(ts)).map(({ ts }) => `html/${ts}`);

/** Writes to `window.*` outside projectm-globals.js (claimGlobal) are a bug. */
const WINDOW_WRITE = {
    selector: 'AssignmentExpression > MemberExpression.left[object.name=/^(window|globalThis|self|windowRef)$/]',
    message:
        'Do not assign window.* / globalThis.* / self.* directly: publish through claimGlobal() (projectm-globals.js) so a second context cannot clobber it. A slot the engine glue shares by name needs an OWNED_GLOBALS entry in scripts/check_host_globals.sh and a disable comment saying so.',
};

/**
 * What isolatedModules would have caught in the per-file emit
 * (scripts/build_html_ts.mjs): a type imported or re-exported as a value
 * survives the emit and fails to link at run time.
 */
const TS_MODULE_RULES = {
    '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'separate-type-imports' }],
    '@typescript-eslint/consistent-type-exports': 'error',
    // TypeScript resolves every name and allows declaration merging; the base
    // rules know neither `type` aliases nor merged interfaces.
    'no-undef': 'off',
    'no-redeclare': 'off',
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
            // Emitted from html/'s .ts modules (npm run check:html-build).
            ...EMITTED_JS,
            'packages/web/dist/**',
            'packages/web/staging/**',
            'packages/web/playground/**',
            'packages/web/scripts/**',
            // Types only (@projectm/types, declarations): tsc owns them.
            'packages/types/**',
            '**/*.d.ts',
        ],
    },
    js.configs.recommended,
    {
        linterOptions: { reportUnusedDisableDirectives: 'error' },
    },

    // ---- html/: the deployed host modules (DOM program) -------------------
    {
        files: ['html/**/*.js'],
        ignores: ['html/projectm-render-worker.js', 'html/worker/**', 'html/worklets/**'],
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
        // The TypeScript modules (scripts/html-ts-modules.mjs), held to
        // tsconfig.strict.json, the program that checks them.
        files: HTML_TS,
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: { ...globals.browser },
            parser: tseslint.parser,
            parserOptions: { project: './html/tsconfig.strict.json', tsconfigRootDir: import.meta.dirname },
        },
        plugins: { '@typescript-eslint': tseslint.plugin },
        rules: {
            ...TYPE_AWARE_RULES,
            ...TS_MODULE_RULES,
            'no-restricted-syntax': ['error', WINDOW_WRITE, INNERHTML_WRITE],
        },
    },
    {
        // claimGlobal() itself, and the classic (non-module) scripts.
        files: ['html/projectm-globals.js'],
        rules: { 'no-restricted-syntax': ['error', INNERHTML_WRITE] },
    },
    {
        // The FLAC player is its own page (loaded in an iframe or tab), not
        // the projectM host: its globals are that page's, with one owner.
        files: ['html/flac-player/**/*.js'],
        rules: { 'no-restricted-syntax': ['error', INNERHTML_WRITE] },
    },

    // ---- the render worker (WebWorker program) -----------------------------
    {
        // The entry and the parts it importScripts() (html/worker/): classic
        // scripts sharing one worker global scope.
        files: [...WORKER_TS, 'html/worker/**/*.js'],
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
    {
        files: WORKER_TS,
        rules: { 'no-undef': 'off', 'no-redeclare': 'off' },
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
