// html/'s TypeScript modules (scripts/html-ts-modules.mjs) and the .js each is
// emitted to (scripts/build_html_ts.mjs). The .js is what deploys and what the
// rest of this suite imports, so it must be the current emit of its .ts; and
// the .ts, not the .js, must be what the type checker and the linter see.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { CLASSIC_SCRIPTS, HTML_ROOT, listHtmlTsModules } from '../../scripts/html-ts-modules.mjs';
import { emitHtmlTsModule } from '../../scripts/build_html_ts.mjs';

const require = createRequire(import.meta.url);
/** @type {typeof import('typescript')} */
const ts = require('typescript');

const modules = listHtmlTsModules();

/** The root files of an html/ tsconfig, as tsc would resolve its include/exclude. */
function programFiles(config) {
    const path = join(HTML_ROOT, config);
    const parsed = ts.getParsedCommandLineOfConfigFile(
        path,
        {},
        { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} }
    );
    assert.ok(parsed, `${config} parses`);
    return new Set(parsed.fileNames.map((file) => file.slice(HTML_ROOT.length + 1)));
}

test('the protocol modules are TypeScript', () => {
    const names = modules.map((m) => m.ts);
    for (const expected of [
        'projectm-context.ts',
        'projectm-pcm-ring.ts',
        'projectm-render-transport.ts',
        'projectm-render-worker-host.ts',
        'projectm-render-worker.ts',
    ]) {
        assert.ok(names.includes(expected), `${expected} is a TypeScript module`);
    }
});

test('every emitted .js is the current emit of its .ts', async () => {
    for (const { ts: source, js } of modules) {
        const committed = readFileSync(join(HTML_ROOT, js), 'utf8');
        assert.equal(committed, await emitHtmlTsModule(source), `html/${js} is stale: run npm run build:html`);
        assert.match(committed, /^\/\/ GENERATED from /, `html/${js} says it is generated`);
    }
});

test('a classic worker script emits a classic script', () => {
    for (const { ts: source, js } of modules.filter((m) => CLASSIC_SCRIPTS.has(m.ts))) {
        // vm.Script refuses top-level import/export.
        new vm.Script(readFileSync(join(HTML_ROOT, js), 'utf8'), { filename: js });
        assert.ok(source.endsWith('.ts'));
    }
});

test('the type checker sees each .ts, never the .js emitted from it', () => {
    const dom = programFiles('tsconfig.json');
    const strict = programFiles('tsconfig.strict.json');
    const worker = programFiles('tsconfig.worker.json');
    for (const { ts: source, js } of modules) {
        for (const [name, files] of [
            ['tsconfig.json', dom],
            ['tsconfig.strict.json', strict],
            ['tsconfig.worker.json', worker],
        ]) {
            assert.ok(!files.has(js), `${name} checks the emitted html/${js}`);
        }
        const strictProgram = CLASSIC_SCRIPTS.has(source) ? worker : strict;
        assert.ok(strictProgram.has(source), `html/${source} is not in its strict program`);
    }
});
