// Smoke tests for the built @projectm/web package.
//
// The package is assembled by packages/web/scripts/build.mjs (vendor -> declare
// -> bundle) and, unlike the html/ sources, nothing else exercises the result.
// These assert the properties that silently break a published tarball: a broken
// exports map, a file that is only reachable at run time going missing, and
// `import.meta.url` landing in a file at the wrong directory depth.
//
// scripts/test_web_embed.sh runs the package build before this suite.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const packageRoot = join(repoRoot, 'packages', 'web');
const distRoot = join(packageRoot, 'dist');
const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));

/** Every path the exports map and `files` promise, flattened. */
function exportTargets() {
    const targets = [];
    for (const [subpath, value] of Object.entries(pkg.exports)) {
        if (typeof value === 'string') {
            targets.push([subpath, value]);
            continue;
        }
        for (const [condition, target] of Object.entries(value)) {
            targets.push([`${subpath} (${condition})`, target]);
        }
    }
    return targets;
}

test('every exports target exists in the built package', () => {
    for (const [label, target] of exportTargets()) {
        assert.ok(
            existsSync(join(packageRoot, target)),
            `exports ${label} -> ${target} does not exist; run packages/web build`,
        );
    }
});

test('the bin entry exists and is listed in files', () => {
    for (const target of Object.values(pkg.bin)) {
        assert.ok(existsSync(join(packageRoot, target)), `bin ${target} missing`);
    }
    assert.ok(
        pkg.files.some((entry) => entry === 'scripts/fetch-wasm.mjs'),
        'the bin script must be in `files` or `npm pack` drops it',
    );
});

test('the render worker ships and is still a standalone classic worker', () => {
    // projectm-render-worker-host.js loads it as
    // `new Worker(new URL('./projectm-render-worker.js', import.meta.url))`,
    // which the build's import-graph scan cannot see. It was missing from the
    // package entirely before, so the worker topology 404'd for npm consumers.
    const worker = join(distRoot, 'projectm-render-worker.js');
    assert.ok(existsSync(worker), 'dist/projectm-render-worker.js is missing');

    const source = readFileSync(worker, 'utf8');
    assert.ok(source.includes('self.onmessage'), 'worker lost its message handler');
    assert.ok(source.includes('importScripts'), 'worker is no longer a classic worker');
    // A classic script parses as a vm.Script; top-level `import`/`export` does
    // not. This is the check that the build never folds the worker into an ES
    // module, and it beats grepping for keywords that also occur in strings.
    new vm.Script(source, { filename: 'projectm-render-worker.js' });
});

test('import.meta.url only appears in files at the dist root', () => {
    // `import.meta.url` resolves against the containing FILE's directory. The
    // render worker URL and the default WASM base (`./pm/...`) are both relative
    // to it, so a shared chunk emitted into a subdirectory resolves one level
    // too deep and 404s. Keep every emitted module flat.
    const walk = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true })
        .flatMap((entry) => (entry.isDirectory()
            ? walk(join(dir, entry.name), `${prefix}${entry.name}/`)
            : [[`${prefix}${entry.name}`, join(dir, entry.name)]]));

    for (const [rel, absolute] of walk(distRoot)) {
        if (!rel.endsWith('.js')) continue;
        if (!readFileSync(absolute, 'utf8').includes('import.meta.url')) continue;
        assert.ok(
            !rel.includes('/'),
            `${rel} uses import.meta.url but is not at the dist root; `
            + 'relative asset URLs inside it will resolve to the wrong directory',
        );
    }
});

test('the ESM bundle exports the element API and registers the element', async () => {
    // The element subclasses HTMLElement at module scope and self-registers when
    // the custom-element globals exist, so importing it needs both present.
    const defined = [];
    globalThis.HTMLElement = class {};
    globalThis.customElements = {
        get: (tag) => defined.find((entry) => entry.tag === tag)?.ctor,
        define: (tag, ctor) => defined.push({ tag, ctor }),
    };

    const module = await import(`file://${join(distRoot, 'projectm-web.js')}`);
    assert.deepEqual(defined.map((entry) => entry.tag), ['project-m-visualizer']);
    for (const name of [
        'ProjectMVisualizerElement',
        'registerProjectMElement',
        'ELEMENT_TAG',
        'OBSERVED_ATTRIBUTES',
        'buildProjectMWasmUrls',
    ]) {
        assert.ok(name in module, `dist/projectm-web.js does not export ${name}`);
    }
    // The `.` entry deliberately does NOT re-export the context API; it lives at
    // `@projectm/web/context`. The hand-written types used to claim otherwise.
    assert.ok(!('ProjectMContext' in module), 'context API leaked into the element entry');
});

test('the context bundle exports the context API', async () => {
    const module = await import(`file://${join(distRoot, 'context.js')}`);
    assert.ok('ProjectMContext' in module);
    assert.ok('createProjectMContext' in module);
});

test('the IIFE bundle is syntactically valid and self-contained', () => {
    const source = readFileSync(join(distRoot, 'projectm-web.iife.js'), 'utf8');
    // Throws on a syntax error without executing anything.
    new vm.Script(source, { filename: 'projectm-web.iife.js' });
    assert.ok(
        !source.includes('import.meta'),
        'import.meta does not exist in a classic script; the build must substitute it',
    );
    assert.ok(source.includes('__projectmScriptUrl'), 'missing the import.meta.url substitute');
});

test('generated declarations cover the public entry points', () => {
    for (const entry of [
        'types/staging/projectm-element.d.ts',
        'types/staging/projectm-context.d.ts',
        'types/staging/projectm-wasm-version.d.ts',
        'types/staging/generated/projectm-wasm-api.d.ts',
        'types/src/react.d.ts',
        'types/src/svelte.d.ts',
        'types/src/vue.d.ts',
    ]) {
        assert.ok(existsSync(join(distRoot, entry)), `missing dist/${entry}`);
    }
});

test('staging is not published', () => {
    assert.ok(
        !pkg.files.includes('staging'),
        'staging/ is a build intermediate and must not ship',
    );
});
