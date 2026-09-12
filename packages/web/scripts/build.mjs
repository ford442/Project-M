#!/usr/bin/env node
// Build the publishable @projectm/web package from the monorepo `html/` tree.
//
// Three stages:
//
//   1. VENDOR   the transitive module closure of `<project-m-visualizer>` from
//               `html/` into a package-local `staging/` directory. The published
//               package MUST be self-contained: `npm pack` only includes files
//               under the package directory, so `../../html/...` references
//               produce a broken tarball. The closure is computed from the real
//               import graph, so it cannot drift from source.
//   2. DECLARE  emit `dist/types/**/*.d.ts` from the staged copies with
//               `tsc --emitDeclarationOnly` (tsconfig.build.json). The package's
//               type surface is generated, never hand-written.
//   3. BUNDLE   esbuild the staged entry points into minified, source-mapped
//               ESM (code-split, so a consumer importing both `.` and `./context`
//               shares one copy of the module-level state) plus a single-file
//               IIFE for `<script>` embedders.
//
// `staging/` is an intermediate: it is git-ignored and excluded from the tarball
// by `files`.

import { mkdir, readFile, rm, copyFile, access, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const htmlRoot = resolve(packageRoot, '..', '..', 'html');
const stagingRoot = join(packageRoot, 'staging');
const srcRoot = join(packageRoot, 'src');
const distRoot = join(packageRoot, 'dist');

// Entry module of the custom element; everything reachable from here ships.
const ENTRY = 'projectm-element.js';

// Modules that are reachable at RUN time but not through the static import
// graph, so the closure scan below cannot see them.
//
// projectm-render-worker.js is loaded as `new Worker(new URL('./projectm-render-
// worker.js', import.meta.url))` from projectm-render-worker-host.js. It is a
// *classic* worker (importScripts, no ES imports), which is why it has no
// imports of its own to follow and why it must stay a separate sibling file
// rather than being bundled into anything. Until now it was simply absent from
// the package, so the worker render topology 404'd for every npm consumer and
// silently fell back to the main thread.
const EXTRA_RUNTIME_MODULES = ['projectm-render-worker.js'];

const IMPORT_RE = /from\s+['"](\.\/[^'"]+)['"]/g;
const TYPES_IMPORT_RE = /import\(['"](\.\/[^'"]+\.ts)['"]\)/g;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Compute the transitive closure of relative `.js` imports starting at ENTRY. */
async function computeClosure() {
  const seen = new Set();
  const stack = [ENTRY, ...EXTRA_RUNTIME_MODULES];
  while (stack.length) {
    const rel = stack.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const src = await readFile(join(htmlRoot, rel), 'utf8');
    let m;
    while ((m = IMPORT_RE.exec(src))) {
      // Resolve relative to the importing module's directory.
      const target = join(dirname(rel), m[1].replace(/^\.\//, ''));
      stack.push(target.split('\\').join('/'));
    }
  }
  return [...seen].sort();
}

/** Collect `*-types.ts` companions referenced from JSDoc in the module closure. */
async function collectTypesCompanions(modules) {
  const companions = new Set();
  for (const rel of modules) {
    const src = await readFile(join(htmlRoot, rel), 'utf8');
    let m;
    while ((m = TYPES_IMPORT_RE.exec(src))) {
      const target = join(dirname(rel), m[1].replace(/^\.\//, '')).split('\\').join('/');
      companions.add(target);
    }
  }
  return [...companions].sort();
}

/**
 * Locate `tsc`'s entry script.
 *
 * `typescript` is a devDependency of this package, so plain resolution finds the
 * workspace-hoisted copy in CI (`npm ci` at the root). The html/ fallback covers
 * a working tree where only `html/node_modules` was ever installed.
 */
function resolveTsc() {
  const require = createRequire(import.meta.url);
  const candidates = [
    () => require.resolve('typescript/lib/tsc.js'),
    () => require.resolve('typescript/lib/tsc.js', { paths: [htmlRoot] }),
  ];
  for (const candidate of candidates) {
    try {
      return candidate();
    } catch {
      // try the next search path
    }
  }
  throw new Error('Cannot resolve typescript. Run `npm ci` at the workspace root.');
}

/** Emit `dist/types/**\/*.d.ts` from the staged closure. */
function emitDeclarations() {
  const result = spawnSync(
    process.execPath,
    [resolveTsc(), '-p', join(packageRoot, 'tsconfig.build.json')],
    { cwd: packageRoot, stdio: 'inherit' },
  );
  if (result.status !== 0) {
    throw new Error(`tsc declaration emit failed (exit ${result.status})`);
  }
}

async function vendor() {
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });

  const modules = await computeClosure();
  const typeCompanions = await collectTypesCompanions(modules);
  const toCopy = [...new Set([...modules, ...typeCompanions])].sort();
  const copied = new Set();
  for (const rel of toCopy) {
    const src = join(htmlRoot, rel);
    const dest = join(stagingRoot, rel);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
    copied.add(rel);

    // Ship sibling `.ts` sources for `.js` modules when present.
    if (!rel.endsWith('.js')) continue;
    const tsRel = rel.replace(/\.js$/, '.ts');
    if (tsRel === rel || !(await exists(join(htmlRoot, tsRel)))) continue;
    await copyFile(join(htmlRoot, tsRel), join(stagingRoot, tsRel));
    copied.add(tsRel);
  }
  return { modules, copied: [...copied].sort() };
}

/**
 * Bundle the staged closure.
 *
 * `import.meta.url` is load-bearing in two places — the default WASM base URL
 * (projectm-context.js / projectm-element.js) and the render worker's URL — so
 * the ESM build keeps it, and the IIFE build substitutes the classic-script
 * equivalent via `define` + a banner, since `import.meta` does not exist there.
 */
async function bundle() {
  const require = createRequire(import.meta.url);
  /** @type {typeof import('esbuild')} */
  const esbuild = require('esbuild');

  // NOTE: package.json deliberately has no `sideEffects` field. It applies to
  // the *source* trees during this build as well as to consumers, and listing
  // only the dist entry points made esbuild treat staging/projectm-element.js as
  // pure — silently dropping the bare `import '.../projectm-element.js'` that
  // registers the custom element from all three framework wrappers. The package
  // is pre-bundled and minified, so the tree-shaking hint buys a consumer almost
  // nothing next to that failure mode.
  const shared = {
    bundle: true,
    minify: true,
    sourcemap: true,
    target: ['es2022'],
    platform: 'browser',
    logLevel: 'warning',
    absWorkingDir: packageRoot,
  };

  const esm = await esbuild.build({
    ...shared,
    entryPoints: {
      // `.` and `./element` both resolve here; the element registers itself on
      // import, which is what `sideEffects` in package.json points at.
      'projectm-web': join(stagingRoot, 'projectm-element.js'),
      context: join(stagingRoot, 'projectm-context.js'),
      'wasm-version': join(stagingRoot, 'projectm-wasm-version.js'),
      'wasm-api': join(stagingRoot, 'generated', 'projectm-wasm-api.js'),
      // Framework wrappers. `react` is external — it is the consumer's copy, and
      // bundling a second React is the classic way to break hooks.
      react: join(srcRoot, 'react.js'),
      svelte: join(srcRoot, 'svelte.js'),
      vue: join(srcRoot, 'vue.js'),
    },
    external: ['react'],
    outdir: distRoot,
    format: 'esm',
    splitting: true,
    // Flat, deliberately: `import.meta.url` survives bundling and ends up in a
    // shared chunk, where it resolves against *that file's* directory. The
    // render worker (`new URL('./projectm-render-worker.js', import.meta.url)`)
    // and the default WASM base (`./pm/...`) both depend on every emitted module
    // sitting in the same directory. A `chunks/` subdirectory silently makes
    // both resolve one level too deep. tests/web/projectm-web-package.test.mjs
    // asserts this.
    chunkNames: 'chunk-[hash]',
    metafile: true,
  });

  const iife = await esbuild.build({
    ...shared,
    entryPoints: [join(stagingRoot, 'projectm-element.js')],
    outfile: join(distRoot, 'projectm-web.iife.js'),
    format: 'iife',
    globalName: 'projectM',
    define: { 'import.meta.url': '__projectmScriptUrl' },
    banner: {
      js:
        'var __projectmScriptUrl=(typeof document!=="undefined"&&document.currentScript&&document.currentScript.src)'
        + '||(typeof location!=="undefined"?location.href:"");',
    },
  });

  // The render worker stays a standalone classic script: it is fetched by URL at
  // run time, not imported, so it must not be folded into a bundle. bundle:false
  // preserves its top-level scope; only whitespace and names change.
  const worker = await esbuild.build({
    ...shared,
    bundle: false,
    entryPoints: [join(stagingRoot, 'projectm-render-worker.js')],
    outfile: join(distRoot, 'projectm-render-worker.js'),
  });

  return { esm, iife, worker };
}

function byteSize(meta, file) {
  const entry = meta?.outputs?.[file];
  return entry ? entry.bytes : 0;
}

async function main() {
  const { modules, copied } = await vendor();
  console.log(`Vendored ${copied.length} file(s) into staging/ from ${modules.length} module(s).`);

  await rm(distRoot, { recursive: true, force: true });
  await mkdir(distRoot, { recursive: true });

  emitDeclarations();
  console.log('Emitted dist/types/**/*.d.ts from the staged closure.');

  const { esm } = await bundle();
  const outputs = Object.keys(esm.metafile.outputs)
    .filter((f) => f.endsWith('.js'))
    .sort();
  console.log('Bundled:');
  for (const file of outputs) {
    console.log(`  ${file} (${(byteSize(esm.metafile, file) / 1024).toFixed(1)} kB min)`);
  }
  console.log('  dist/projectm-web.iife.js (global `projectM`)');
  console.log('  dist/projectm-render-worker.js (classic worker, loaded by URL)');

  // Outside dist/ on purpose: it is 25 kB of bundle-analysis metadata that
  // every consumer would otherwise download with the package.
  await writeFile(
    join(packageRoot, 'build-metafile.json'),
    JSON.stringify(esm.metafile, null, 2),
    'utf8',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
