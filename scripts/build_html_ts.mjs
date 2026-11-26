#!/usr/bin/env node
// Emit every TypeScript module under html/ to the .js next to it.
//
//   node scripts/build_html_ts.mjs           write the .js files (npm run build:html)
//   node scripts/build_html_ts.mjs --check   fail if any committed .js is not what
//                                            its .ts emits (npm run check:html-build)
//
// Each .ts is transformed on its own by esbuild (types stripped, ES2020, ES
// modules kept as they are, no bundling), then formatted with the repo's
// Prettier config so the committed output reads like the rest of html/. The .js
// is committed: it is what deploys, what node:test imports and what
// packages/web vendors, and keeping its name is what keeps the deploy names,
// `new URL('./x.js', import.meta.url)` and every importer unchanged.
//
// Which files are TypeScript modules is scripts/html-ts-modules.mjs's rule.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { CLASSIC_SCRIPTS, HTML_ROOT, PROJECT_ROOT, listHtmlTsModules } from './html-ts-modules.mjs';

const require = createRequire(import.meta.url);

/** Language level of the emitted .js. ES2020 sits under the browser floor (docs/EMSCRIPTEN.md). */
export const EMIT_TARGET = 'es2020';

/**
 * @param {string} tsPath relative to html/
 * @returns {string}
 */
function headerFor(tsPath) {
    const base = tsPath.split('/').pop();
    return (
        `// GENERATED from ${base} by scripts/build_html_ts.mjs — do not edit.\n` +
        `// Edit the .ts, then run \`npm run build:html\` (CI: npm run check:html-build).\n`
    );
}

/**
 * The .js `tsPath` emits.
 *
 * @param {string} tsPath relative to html/
 * @returns {Promise<string>}
 */
export async function emitHtmlTsModule(tsPath) {
    /** @type {typeof import('esbuild')} */
    const esbuild = require('esbuild');
    /** @type {typeof import('prettier')} */
    const prettier = require('prettier');

    const source = await readFile(join(HTML_ROOT, tsPath), 'utf8');
    const result = await esbuild.transform(source, {
        loader: 'ts',
        target: EMIT_TARGET,
        sourcefile: tsPath,
        // Class fields as constructor assignments, as html/'s JS has always
        // written them: no __publicField helper in the output. Imports used
        // only as types are elided (TypeScript's default); the programs do not
        // set isolatedModules because ProjectMError is an ambient const enum,
        // which reads the frozen object projectm-wasm-api.js exports here.
        // ESLint's consistent-type-imports/-exports covers what isolatedModules
        // would have caught.
        tsconfigRaw: { compilerOptions: { useDefineForClassFields: false } },
        legalComments: 'inline',
        charset: 'utf8',
    });
    if (result.warnings.length > 0) {
        const messages = await esbuild.formatMessages(result.warnings, { kind: 'warning' });
        throw new Error(`${tsPath}: esbuild warnings:\n${messages.join('\n')}`);
    }
    if (CLASSIC_SCRIPTS.has(tsPath) && /^\s*(import|export)\b/m.test(result.code)) {
        throw new Error(
            `${tsPath} runs as a classic worker script, but its emitted .js has an import/export: use \`import type\` only`
        );
    }
    const config = (await prettier.resolveConfig(join(HTML_ROOT, tsPath.replace(/\.ts$/, '.js')))) ?? {};
    const formatted = await prettier.format(result.code, { ...config, parser: 'babel' });
    return headerFor(tsPath) + formatted;
}

async function main() {
    const check = process.argv.includes('--check');
    const modules = listHtmlTsModules();
    /** @type {string[]} */
    const stale = [];
    for (const { ts, js } of modules) {
        const emitted = await emitHtmlTsModule(ts);
        const target = join(HTML_ROOT, js);
        let current = null;
        try {
            current = await readFile(target, 'utf8');
        } catch {
            // Not emitted yet.
        }
        if (current === emitted) continue;
        if (check) {
            stale.push(js);
        } else {
            await writeFile(target, emitted, 'utf8');
            console.log(`html/${js} <- html/${ts}`);
        }
    }
    if (check) {
        if (stale.length > 0) {
            console.error('These emitted files are out of date with their .ts:');
            for (const js of stale) console.error(`  html/${js}`);
            console.error('Run: npm run build:html (and commit the .js)');
            process.exit(1);
        }
        console.log(`html/: ${modules.length} TypeScript module(s), every emitted .js up to date.`);
    }
}

if (process.argv[1] && join(process.argv[1]) === join(PROJECT_ROOT, 'scripts', 'build_html_ts.mjs')) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
