#!/usr/bin/env node
// Vendor the transitive module closure of the `<project-m-visualizer>` element
// from the monorepo `html/` tree into a package-local `dist/` directory.
//
// The published npm package MUST be self-contained: `npm pack` only includes
// files under the package directory, so referencing `../../html/...` from
// `package.json` `files`/`exports` produces a broken tarball. This script
// resolves the real import graph (so it can never drift from the source) and
// copies every reachable `.js` module — plus its sibling `.ts` source when one
// exists — into `dist/`, preserving the `generated/` subdirectory layout.

import { mkdir, readFile, writeFile, rm, copyFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const htmlRoot = resolve(packageRoot, '..', '..', 'html');
const distRoot = join(packageRoot, 'dist');

// Entry module of the custom element; everything reachable from here ships.
const ENTRY = 'projectm-element.js';

const IMPORT_RE = /from\s+['"](\.\/[^'"]+)['"]/g;

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
  const stack = [ENTRY];
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

async function main() {
  await rm(distRoot, { recursive: true, force: true });
  await mkdir(distRoot, { recursive: true });

  const modules = await computeClosure();
  const copied = [];
  for (const rel of modules) {
    const src = join(htmlRoot, rel);
    const dest = join(distRoot, rel);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
    copied.push(rel);

    // Ship the TypeScript source alongside the compiled `.js` when present so
    // downstream consumers get real types (matching the `exports` `types`).
    const tsRel = rel.replace(/\.js$/, '.ts');
    if (tsRel !== rel && (await exists(join(htmlRoot, tsRel)))) {
      await copyFile(join(htmlRoot, tsRel), join(distRoot, tsRel));
      copied.push(tsRel);
    }
  }

  console.log(`Vendored ${copied.length} file(s) into dist/ from ${modules.length} module(s):`);
  for (const rel of copied) console.log(`  dist/${rel}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
