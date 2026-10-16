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

test('the AudioWorklet processor ships next to the bundle that loads it', () => {
    // html/projectm-worklet-playback.js resolves the processor against its own
    // module URL, which after bundling is a file in dist/. A bare relative URL
    // resolved against the embedding page instead, so npm consumers got a 404
    // for a file the package never contained.
    const processor = join(distRoot, 'projectm_audio_processor.js');
    assert.ok(existsSync(processor), 'dist/projectm_audio_processor.js is missing');
    assert.equal(
        readFileSync(processor, 'utf8'),
        readFileSync(join(repoRoot, 'projectm_audio_processor.js'), 'utf8'),
        'the shipped processor must be the repo\'s, byte for byte (it is not minified or renamed)',
    );

    // The URL is built from import.meta.url in the bundle, not written as a bare path.
    // (The processor names itself in a comment, so it is not one of the bundles.)
    const chunks = readdirSync(distRoot).filter((name) => name.endsWith('.js') && name !== 'projectm_audio_processor.js');
    const referencing = chunks.filter((name) => readFileSync(join(distRoot, name), 'utf8').includes('projectm_audio_processor.js'));
    assert.ok(referencing.length > 0, 'no bundle references the processor');
    for (const name of referencing) {
        const source = readFileSync(join(distRoot, name), 'utf8');
        assert.match(
            source,
            /new URL\(["']projectm_audio_processor\.js["'],[^)]*\)/,
            `${name} must resolve the processor with new URL(..., <module url>), not a page-relative string`,
        );
    }
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

// ---------------------------------------------------------------------------
// The vendored closure (packages/web/scripts/module-closure.mjs).
// ---------------------------------------------------------------------------

const htmlRoot = join(repoRoot, 'html');
const stagingRoot = join(packageRoot, 'staging');
const { computeModuleClosure, scanModuleReferences, stripComments } = await import(
    `file://${join(packageRoot, 'scripts', 'module-closure.mjs')}`
);

test('scanModuleReferences finds static, dynamic and import.meta.url references', () => {
    const refs = scanModuleReferences([
        "import { a } from './a.js';",
        "import './side-effect.js';",
        "export { b } from '../up/b.js';",
        "const lazy = await import('./lazy.js');",
        "const w = new Worker(new URL('./worker.js', import.meta.url));",
        "const p = new URL('processor.js', import.meta.url).href;",
        "const abs = new URL('https://cdn.example/x.js', import.meta.url);",
        "const page = new URL('./page.js', location.href);",
        'const computed = import(name);',
        "import fs from 'node:fs';",
    ].join('\n'));
    assert.deepEqual(refs.static, ['./a.js', './side-effect.js', '../up/b.js']);
    assert.deepEqual(refs.dynamic, ['./lazy.js']);
    // Only URLs resolved against the module itself; absolute and page-relative ones are not files of ours.
    assert.deepEqual(refs.url, ['./worker.js', 'processor.js']);
});

test('scanModuleReferences ignores JSDoc type imports and commented-out code', () => {
    const source = [
        '/** @typedef {import(\'./types.ts\').T} T */',
        '/**',
        " * Loads it with import('./doc-only.js').",
        ' */',
        "// import('./commented.js');",
        "const url = 'https://example.com/a.js'; // trailing note",
    ].join('\n');
    assert.deepEqual(scanModuleReferences(source), { static: [], dynamic: [], url: [] });
    assert.ok(stripComments(source).includes("'https://example.com/a.js'"), 'string contents with // survive');
});

test('the closure follows dynamic imports and URL references, and reports what it cannot resolve', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const root = await mkdtemp(join(tmpdir(), 'pm-closure-'));
    try {
        await writeFile(join(root, 'entry.js'), "import './static.js';\nconst m = import('./dynamic.js');\n");
        await writeFile(join(root, 'static.js'), "new Worker(new URL('./worker.js', import.meta.url));\n");
        await writeFile(join(root, 'dynamic.js'), "new URL('../outside.js', import.meta.url);\nnew URL('./style.css', import.meta.url);\n");
        await writeFile(join(root, 'worker.js'), "importScripts('glue.js');\n");
        const { modules, unresolved } = await computeModuleClosure(root, ['entry.js']);
        assert.deepEqual(modules, ['dynamic.js', 'entry.js', 'static.js', 'worker.js']);
        assert.deepEqual(unresolved, [{ from: 'dynamic.js', specifier: '../outside.js', kind: 'url' }]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('staging holds exactly the module closure of the element (plus type companions)', async () => {
    const { modules, unresolved } = await computeModuleClosure(htmlRoot, ['projectm-element.js']);
    // Reached only by `new URL(..., import.meta.url)`: these are the files the
    // old static-import-only scan dropped.
    assert.ok(modules.includes('projectm-render-worker.js'), 'render worker missing from the closure');
    assert.ok(modules.includes('projectm-element.js') && modules.includes('projectm-context.js'));
    // The one URL reference outside html/ is the worklet processor, which build.mjs copies from the repo root.
    assert.deepEqual(unresolved.map((ref) => ref.specifier), ['projectm_audio_processor.js']);

    const walk = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true })
        .flatMap((entry) => (entry.isDirectory()
            ? walk(join(dir, entry.name), `${prefix}${entry.name}/`)
            : [`${prefix}${entry.name}`]));
    const stagedJs = walk(stagingRoot).filter((rel) => rel.endsWith('.js')).sort();
    assert.deepEqual(stagedJs, modules, 'packages/web/staging/*.js must be the closure, nothing more or less');
    for (const rel of walk(stagingRoot).filter((name) => name.endsWith('.ts'))) {
        assert.ok(existsSync(join(htmlRoot, rel)), `staged ${rel} has no html/ source`);
    }
});
