#!/usr/bin/env node
// Download the projectM WASM bundle for self-hosting.
//
// The npm package ships JavaScript only — the glue script and the ~2.6 MB
// `.wasm` binary are hosted artifacts. Without this, an embedder who wants to
// serve them from their own origin (for offline use, for a pinned version, or
// because they will not take a hard runtime dependency on someone else's CDN)
// has to reverse-engineer the layout that projectm-init.js probes for.
//
// This writes that layout, plus a lockfile recording each file's SHA-256 and an
// SRI `integrity` string, so the download can be verified in CI later with
// `--verify` (no network) and pinned independently of whatever the CDN serves
// today.
//
//   npx projectm-fetch-wasm --out public/pm
//   npx projectm-fetch-wasm --out public/pm --verify
//
// Layout written (matching resolveWasmScriptUrl()'s first candidate, `./pm/`):
//   <out>/projectm-v.<version>-thread.<js|1ijs>
//   <out>/projectm-v.<version>-thread.wasm
//   <out>/projectm-wasm.lock.json
//
// Point the element at the *parent* of that directory:
//   <project-m-visualizer wasm-base-url="/static/">   with files in /static/pm/

import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));

/**
 * Load the version constants.
 *
 * In the published package `dist/` always exists (`prepare` builds it). In the
 * monorepo before a build, fall back to the html/ source they are vendored from.
 */
async function loadVersionModule() {
  const candidates = [
    resolve(scriptDir, '..', 'dist', 'wasm-version.js'),
    resolve(scriptDir, '..', '..', '..', 'html', 'projectm-wasm-version.js'),
  ];
  for (const path of candidates) {
    try {
      return await import(`file://${path}`);
    } catch {
      // try the next location
    }
  }
  throw new Error('Cannot load the WASM version module. Run `npm run build` first.');
}

function parseArgs(argv) {
  const args = {
    out: 'public/pm',
    base: null,
    version: null,
    verify: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--out':
      case '--base':
      case '--version':
        args[arg.slice(2)] = argv[++i];
        break;
      case '--verify':
        args.verify = true;
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

const USAGE = `projectm-fetch-wasm — download the projectM WASM bundle for self-hosting

  --out <dir>       where to write artifacts (default: public/pm)
  --base <url>      origin to download from (default: the first-party CDN)
  --version <tag>   bundle version, e.g. 036 (default: the package's pinned tag)
  --verify          re-hash the files already in <dir> against the lockfile; no network
  --help
`;

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function sri(buffer) {
  return `sha384-${createHash('sha384').update(buffer).digest('base64')}`;
}

/** Fetch a URL, returning null on any non-2xx or HTML soft-404. */
async function tryFetch(url) {
  let response;
  try {
    response = await fetch(url);
  } catch {
    return null;
  }
  if (!response.ok) return null;
  // Soft-404s on static hosts come back as 200 text/html.
  const type = (response.headers.get('content-type') || '').toLowerCase();
  if (type.includes('text/html')) return null;
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Probe `pm/` then the site root, in the same order and for the same reason as
 * resolveWasmScriptUrl(): canonical deploys ship under `pm/`, older tags were
 * only ever pushed to the root.
 */
async function fetchCandidate(base, relPaths) {
  for (const rel of relPaths) {
    const url = `${base}/${rel}`;
    process.stdout.write(`  GET ${url} ... `);
    const body = await tryFetch(url);
    if (body) {
      console.log(`ok (${(body.length / 1024).toFixed(0)} kB)`);
      return { url, body };
    }
    console.log('not found');
  }
  return null;
}

async function verify(outDir) {
  const lockPath = join(outDir, 'projectm-wasm.lock.json');
  let lock;
  try {
    lock = JSON.parse(await readFile(lockPath, 'utf8'));
  } catch {
    throw new Error(`No lockfile at ${lockPath}. Run without --verify first.`);
  }
  let failed = 0;
  for (const file of lock.files) {
    let actual;
    try {
      actual = sha256(await readFile(join(outDir, file.name)));
    } catch {
      console.error(`  MISSING  ${file.name}`);
      failed += 1;
      continue;
    }
    if (actual !== file.sha256) {
      console.error(`  MISMATCH ${file.name}`);
      console.error(`    expected ${file.sha256}`);
      console.error(`    actual   ${actual}`);
      failed += 1;
      continue;
    }
    console.log(`  ok       ${file.name}`);
  }
  if (failed) {
    throw new Error(`${failed} file(s) failed verification against ${lockPath}`);
  }
  console.log(`Verified ${lock.files.length} file(s) for bundle ${lock.bundle}.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const outDir = resolve(process.cwd(), args.out);
  if (args.verify) {
    await verify(outDir);
    return;
  }

  const versions = await loadVersionModule();
  const version = args.version || versions.PROJECTM_WASM_VERSION;
  const base = (args.base || versions.PROJECTM_WASM_DEFAULT_CDN_BASE).replace(/\/$/, '');
  const paths = versions.buildWasmBundlePaths(version);

  if (versions.normalizeWasmVersion(version) === null) {
    throw new Error(
      `Unknown bundle version "${version}". Known tags: `
      + versions.PROJECTM_WASM_SELECTABLE_VERSIONS.join(', '),
    );
  }

  if (paths.version !== versions.PROJECTM_WASM_DEFAULT_VERSION) {
    console.warn(
      `Note: ${paths.version} is this package's pinned tag, but the first-party hosts\n`
      + `currently default to ${versions.PROJECTM_WASM_DEFAULT_VERSION} `
      + `(see html/projectm-wasm-version.js for why).\n`
      + `If you hit audio or framerate problems, try: --version `
      + `${versions.PROJECTM_WASM_DEFAULT_VERSION}\n`,
    );
  }

  console.log(`Fetching bundle ${paths.bundle} from ${base}`);
  const glue = await fetchCandidate(base, [
    `pm/${paths.bundle}.${paths.glueExt}`,
    `${paths.bundle}.${paths.glueExt}`,
  ]);
  if (!glue) {
    throw new Error(`Could not find the glue script for ${paths.bundle} at ${base}`);
  }
  // The binary lives next to whichever glue script answered.
  const glueDir = glue.url.slice(0, glue.url.lastIndexOf('/'));
  const wasmUrl = `${glueDir}/${paths.bundle}.wasm`;
  process.stdout.write(`  GET ${wasmUrl} ... `);
  const wasmBody = await tryFetch(wasmUrl);
  if (!wasmBody) {
    console.log('not found');
    throw new Error(`Found the glue script but not ${paths.bundle}.wasm next to it`);
  }
  console.log(`ok (${(wasmBody.length / 1024 / 1024).toFixed(1)} MB)`);

  await mkdir(outDir, { recursive: true });
  const artifacts = [
    { name: `${paths.bundle}.${paths.glueExt}`, url: glue.url, body: glue.body },
    { name: `${paths.bundle}.wasm`, url: wasmUrl, body: wasmBody },
  ];
  for (const artifact of artifacts) {
    await writeFile(join(outDir, artifact.name), artifact.body);
  }

  const lock = {
    bundle: paths.bundle,
    version: paths.version,
    source: base,
    fetchedAt: new Date().toISOString(),
    files: artifacts.map((artifact) => ({
      name: artifact.name,
      url: artifact.url,
      bytes: artifact.body.length,
      sha256: sha256(artifact.body),
      integrity: sri(artifact.body),
    })),
  };
  await writeFile(
    join(outDir, 'projectm-wasm.lock.json'),
    `${JSON.stringify(lock, null, 2)}\n`,
  );

  console.log(`\nWrote ${artifacts.length} artifact(s) + projectm-wasm.lock.json to ${args.out}`);
  console.log('Commit the lockfile and re-check in CI with:');
  console.log(`  npx projectm-fetch-wasm --out ${args.out} --verify`);
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
