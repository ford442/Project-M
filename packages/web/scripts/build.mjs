#!/usr/bin/env node
// Build the publishable @projectm/web package from the monorepo `html/` tree.
//
// Three stages:
//
//   1. VENDOR   the transitive module closure of `<project-m-visualizer>` from
//               `html/` into a package-local `staging/` directory. The published
//               package MUST be self-contained: `npm pack` only includes files
//               under the package directory, so `../../html/...` references
//               produce a broken tarball. The closure is esbuild's own module
//               graph (its metafile) plus the files the modules load by
//               `new URL(..., import.meta.url)`, so nothing is hand-listed.
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
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const htmlRoot = resolve(packageRoot, '..', '..', 'html');
const stagingRoot = join(packageRoot, 'staging');
const srcRoot = join(packageRoot, 'src');
const distRoot = join(packageRoot, 'dist');

// Entry module of the custom element; everything reachable from here ships.
const ENTRY = 'projectm-element.js';

// `import('./x.ts')` in JSDoc: type-only companions, which no bundler follows.
const TYPES_IMPORT_RE = /import\(['"](\.{1,2}\/[^'"]+\.ts)['"]\)/g;

// Files fetched by URL at run time, which no import graph reaches: the render
// worker (`new Worker(new URL('./projectm-render-worker.js', import.meta.url))`,
// a classic script) and the AudioWorklet processor. They are found the way a
// bundler with asset support would find them: from the `new URL('<relative>',
// import.meta.url)` expressions in the modules esbuild loads.
const URL_ASSET_RE = /new\s+URL\(\s*['"](\.{0,2}\/?[^'":]+\.js)['"]\s*,\s*import\.meta\.url\s*\)/g;

// A classic worker among those assets pulls in its own parts with
// `importScripts('./worker/x.js', ...)` or `importScripts(new URL('./x.js',
// self.location.href).href)`. Relative literals there resolve against the
// asset's own URL, so they are followed (recursively) and shipped next to it.
// A non-literal argument (the Emscripten glue's run-time URL) is not ours.
const IMPORT_SCRIPTS_RE = /importScripts\(([^)]*(?:\([^)]*\)[^)]*)*)\)/g;
const RELATIVE_JS_LITERAL_RE = /['"](\.{1,2}\/[^'":]+\.js)['"]/g;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} path */
const posix = (path) => path.split('\\').join('/');

/**
 * The module closure of ENTRY, from esbuild's own resolution (its metafile),
 * so side-effect imports, dynamic import() and html/context/'s `../` imports
 * are all seen exactly as the bundle step will see them. Also returns the
 * URL-loaded assets those modules reference (see URL_ASSET_RE).
 *
 * @returns {Promise<{ modules: string[], urlAssets: string[] }>} Paths relative to html/.
 */
async function computeClosure() {
  const require = createRequire(import.meta.url);
  /** @type {typeof import('esbuild')} */
  const esbuild = require('esbuild');
  const urlAssets = new Set();
  const result = await esbuild.build({
    entryPoints: [join(htmlRoot, ENTRY)],
    absWorkingDir: htmlRoot,
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    logLevel: 'warning',
    plugins: [
      {
        name: 'collect-url-assets',
        setup(build) {
          build.onLoad({ filter: /\.js$/ }, async (args) => {
            const contents = await readFile(args.path, 'utf8');
            for (const match of contents.matchAll(URL_ASSET_RE)) {
              const asset = posix(relative(htmlRoot, resolve(dirname(args.path), match[1])));
              urlAssets.add(asset);
            }
            return { contents, loader: 'js' };
          });
        },
      },
    ],
  });
  const modules = Object.keys(result.metafile.inputs)
    .map(posix)
    .filter((rel) => !rel.startsWith('..') && !rel.includes('node_modules/'));
  for (const asset of urlAssets) {
    if (!(await exists(join(htmlRoot, asset)))) {
      throw new Error(`new URL('${asset}', import.meta.url) points at a file html/ does not have`);
    }
  }
  // Set iteration visits entries added during the loop: that is the recursion.
  for (const asset of urlAssets) {
    const contents = await readFile(join(htmlRoot, asset), 'utf8');
    for (const call of contents.matchAll(IMPORT_SCRIPTS_RE)) {
      for (const literal of call[1].matchAll(RELATIVE_JS_LITERAL_RE)) {
        const part = posix(relative(htmlRoot, resolve(dirname(join(htmlRoot, asset)), literal[1])));
        if (!(await exists(join(htmlRoot, part)))) {
          throw new Error(`${asset} importScripts('${literal[1]}'), a file html/ does not have`);
        }
        urlAssets.add(part);
      }
    }
  }
  return { modules: [...new Set([...modules, ...urlAssets])].sort(), urlAssets: [...urlAssets].sort() };
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

  const { modules, urlAssets } = await computeClosure();
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
  return { modules, urlAssets, copied: [...copied].sort() };
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

  return { esm, iife };
}

function byteSize(meta, file) {
  const entry = meta?.outputs?.[file];
  return entry ? entry.bytes : 0;
}

async function main() {
  const { modules, urlAssets, copied } = await vendor();
  console.log(`Vendored ${copied.length} file(s) into staging/ from ${modules.length} module(s).`);

  await rm(distRoot, { recursive: true, force: true });
  await mkdir(distRoot, { recursive: true });

  emitDeclarations();
  console.log('Emitted dist/types/**/*.d.ts from the staged closure.');

  const { esm } = await bundle();

  // Files loaded by URL (the classic render worker, the AudioWorklet
  // processor) resolve against the module URL that loads them, i.e. against
  // dist/. They are copied as they are, at the same relative path, and never
  // folded into a bundle: they run in their own global scope.
  for (const asset of urlAssets) {
    await mkdir(dirname(join(distRoot, asset)), { recursive: true });
    await copyFile(join(stagingRoot, asset), join(distRoot, asset));
  }
  const outputs = Object.keys(esm.metafile.outputs)
    .filter((f) => f.endsWith('.js'))
    .sort();
  console.log('Bundled:');
  for (const file of outputs) {
    console.log(`  ${file} (${(byteSize(esm.metafile, file) / 1024).toFixed(1)} kB min)`);
  }
  console.log('  dist/projectm-web.iife.js (global `projectM`)');
  for (const asset of urlAssets) {
    console.log(`  dist/${asset} (loaded by URL, copied as is)`);
  }

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
