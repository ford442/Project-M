#!/usr/bin/env node
/**
 * Generate pm/builds.json, the list of deployed WASM builds that hosts read
 * instead of guessing file names (html/projectm-wasm-manifest.js).
 *
 * For every `pm/projectm-v.<ver>-thread.js` (UTF-8 glue) + `.wasm` pair under
 * --root it records the paths, sha256 and size of both, the separate pthread
 * worker script if there is one, and the C API the glue exports (read from
 * its `Module["_name"] = wasmExports[...]` table, since the .wasm export
 * names are minified). Hosts gate optional calls on that list.
 *
 * Builds deployed earlier and not present locally are carried over from
 * --merge (the live manifest, a URL or a file). On the first run there is no
 * live manifest: --fetch-missing <site> downloads each selectable version's
 * UTF-8 glue + wasm from the site instead. Versions that exist only as UTF-16
 * `.1ijs` are reported and left out; scripts/transcode_legacy_glue.sh makes
 * UTF-8 copies of them.
 *
 * The result is validated with the same parser the hosts use
 * (parseWasmBuildsManifest), so a manifest the hosts would reject fails here.
 *
 * Usage:
 *   node scripts/generate_wasm_builds_manifest.mjs [--root <dir with pm/>]
 *       [--merge <url|file>] [--fetch-missing <site url>]
 *       [--default <ver>] [--status <ver>=<stable|beta|legacy|withdrawn> ...]
 *       [--precompress] [--out <file>] [--check]
 *
 *   --precompress   also write .br and .gz next to each local glue/wasm and the
 *                   manifest (served by html/.htaccess when the client accepts them)
 *   --check         validate an existing --out file instead of writing one
 *
 * scripts/prepare_deploy_bundle.sh runs this after staging a bundle.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const versionModule = await import(pathToFileURL(join(repoRoot, 'html', 'projectm-wasm-version.js')).href);
const {
    PROJECTM_WASM_BUILDS_SCHEMA,
    PROJECTM_WASM_DEFAULT_VERSION,
    PROJECTM_WASM_SELECTABLE_VERSIONS,
    parseWasmBuildsManifest,
} = versionModule;

const STATUSES = ['stable', 'beta', 'legacy', 'withdrawn'];
const BUNDLE_RE = /^projectm-v\.([0-9]{3}[a-z]?)-thread\.js$/;

/** Exported C symbols, from the glue's export table (no leading underscore). */
export function extractGlueApi(glueText) {
    const names = new Set();
    for (const match of glueText.matchAll(/Module\["_([A-Za-z][A-Za-z0-9_]*)"\]\s*=/g)) {
        names.add(match[1]);
    }
    return [...names].filter((name) => !/^(emscripten_|dynCall_|stack)/.test(name)).sort();
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Checks one glue/wasm pair and builds its manifest entry.
 * @param {string} version
 * @param {Buffer} glue
 * @param {Buffer} wasm
 * @param {{ worker?: string | null, status?: string, buildId?: string | null }} extra
 */
export function buildEntry(version, glue, wasm, extra = {}) {
    const bundle = `projectm-v.${version}-thread`;
    const problems = [];
    if (glue[0] === 0xff && glue[1] === 0xfe) problems.push('glue is UTF-16/32 (BOM); only UTF-8 glue is listed');
    if (glue.subarray(0, 256).some((b) => b === 0 || b >= 0x80)) problems.push('glue does not start with ASCII JavaScript');
    if (wasm.subarray(0, 4).toString('latin1') !== '\0asm') problems.push('wasm has no \\0asm magic');
    const glueText = glue.toString('utf8');
    if (!glueText.includes(`${bundle}.wasm`)) {
        problems.push(`glue does not reference ${bundle}.wasm (smoke-tag rename missing? see prepare_deploy_bundle.sh)`);
    }
    if (problems.length) throw new Error(`${bundle}: ${problems.join('; ')}`);
    return {
        glue: `pm/${bundle}.js`,
        wasm: `pm/${bundle}.wasm`,
        worker: extra.worker ?? null,
        sha256: { glue: sha256(glue), wasm: sha256(wasm) },
        bytes: { glue: glue.length, wasm: wasm.length },
        api: extractGlueApi(glueText),
        status: extra.status || null,
        ...(extra.buildId ? { buildId: extra.buildId } : {}),
    };
}

/** Local builds: every UTF-8 glue in <root>/pm with its .wasm next to it. */
function scanLocal(root) {
    const pm = join(root, 'pm');
    const builds = {};
    const skipped = [];
    if (!existsSync(pm)) return { builds, skipped };
    for (const name of readdirSync(pm).sort()) {
        const match = BUNDLE_RE.exec(name);
        if (!match || name.endsWith('.worker.js')) continue;
        const version = match[1];
        const bundle = `projectm-v.${version}-thread`;
        const wasmPath = join(pm, `${bundle}.wasm`);
        if (!existsSync(wasmPath)) {
            skipped.push(`${version}: pm/${name} has no pm/${bundle}.wasm`);
            continue;
        }
        const workerPath = join(pm, `${bundle}.worker.js`);
        // Emscripten >= 3.1.58 runs pthreads from the main glue; a worker
        // script only counts when it is real JS (not a saved 302 page).
        const worker = existsSync(workerPath) && statSync(workerPath).size > 1024 ? `pm/${bundle}.worker.js` : null;
        const buildIdPath = [join(root, `${bundle}.build-id`), join(pm, `${bundle}.build-id`)].find(existsSync);
        builds[version] = buildEntry(version, readFileSync(join(pm, name)), readFileSync(wasmPath), {
            worker,
            // Line 1 is the source fingerprint; the key=value lines after it
            // (binary hashes, build settings) are deploy.py's, and the hashes
            // are in the entry already.
            buildId: buildIdPath ? readFileSync(buildIdPath, 'utf8').split('\n')[0].trim() : null,
        });
    }
    for (const name of readdirSync(pm)) {
        const legacy = /^projectm-v\.([0-9]{3}[a-z]?)-thread\.(1ijs|3ijs)$/.exec(name);
        if (legacy && !builds[legacy[1]]) {
            skipped.push(`${legacy[1]}: only UTF-16/32 glue (pm/${name}); run scripts/transcode_legacy_glue.sh`);
        }
    }
    return { builds, skipped: [...new Set(skipped)] };
}

async function readSource(source) {
    if (/^https?:\/\//.test(source)) {
        const response = await fetch(source, { cache: 'no-store' });
        if (!response.ok) return { missing: `HTTP ${response.status}` };
        const type = response.headers.get('content-type') || '';
        if (!/json/i.test(type)) return { missing: `served as ${type || 'no content type'} (soft 404?)` };
        return { json: await response.json() };
    }
    if (!existsSync(source)) return { missing: 'no such file' };
    return { json: JSON.parse(readFileSync(source, 'utf8')) };
}

async function fetchBuild(site, version) {
    const bundle = `projectm-v.${version}-thread`;
    const get = async (rel) => {
        const response = await fetch(`${site}/${rel}`, { cache: 'no-store', redirect: 'manual' });
        if (response.status !== 200) return null;
        return Buffer.from(await response.arrayBuffer());
    };
    const glue = await get(`pm/${bundle}.js`);
    const wasm = glue ? await get(`pm/${bundle}.wasm`) : null;
    if (!glue || !wasm) return null;
    return buildEntry(version, glue, wasm);
}

function parseArgs(argv) {
    const opts = { root: repoRoot, merge: null, fetchMissing: null, defaultVersion: null, status: {}, precompress: false, out: null, check: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = () => {
            if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
            return argv[++i];
        };
        if (arg === '--root') opts.root = resolve(next());
        else if (arg === '--merge') opts.merge = next();
        else if (arg === '--fetch-missing') opts.fetchMissing = next().replace(/\/$/, '');
        else if (arg === '--default') opts.defaultVersion = next();
        else if (arg === '--status') {
            const [version, status] = next().split('=');
            if (!STATUSES.includes(status)) throw new Error(`--status ${version}=${status}: use one of ${STATUSES.join(', ')}`);
            opts.status[version] = status;
        } else if (arg === '--precompress') opts.precompress = true;
        else if (arg === '--out') opts.out = resolve(next());
        else if (arg === '--check') opts.check = true;
        else if (arg === '--help' || arg === '-h') {
            console.log('see the header of scripts/generate_wasm_builds_manifest.mjs');
            process.exit(0);
        } else throw new Error(`unknown argument ${arg}`);
    }
    opts.out ??= join(opts.root, 'pm', 'builds.json');
    return opts;
}

/** Writes `<file>.br` and `<file>.gz` (max compression) next to `file`. */
export function precompress(file) {
    const bytes = readFileSync(file);
    writeFileSync(`${file}.br`, brotliCompressSync(bytes, {
        params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
            [zlibConstants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
        },
    }));
    writeFileSync(`${file}.gz`, gzipSync(bytes, { level: 9 }));
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));

    if (opts.check) {
        const parsed = parseWasmBuildsManifest(JSON.parse(readFileSync(opts.out, 'utf8')));
        if (!parsed) throw new Error(`${opts.out}: hosts would reject this manifest`);
        console.log(`${opts.out}: ok (${Object.keys(parsed.builds).length} builds, default ${parsed.default})`);
        return;
    }

    const { builds: local, skipped } = scanLocal(opts.root);
    let merged = {};
    let mergedDefault = null;
    if (opts.merge) {
        const source = await readSource(opts.merge);
        if (source.missing) {
            console.warn(`merge source ${opts.merge} unavailable (${source.missing}); starting from local builds only`);
        } else {
            const parsed = parseWasmBuildsManifest(source.json);
            if (!parsed) throw new Error(`merge source ${opts.merge} is not a valid builds manifest`);
            // Keep the raw entries (bytes, buildId) rather than the parsed subset.
            for (const version of Object.keys(parsed.builds)) merged[version] = source.json.builds[version];
            mergedDefault = parsed.default;
        }
    }

    const builds = { ...merged };
    for (const [version, entry] of Object.entries(local)) {
        // A rebuilt version keeps the status it had (a withdrawn build stays withdrawn).
        builds[version] = { ...entry, status: merged[version]?.status || null };
    }

    if (opts.fetchMissing) {
        for (const version of PROJECTM_WASM_SELECTABLE_VERSIONS) {
            if (builds[version]) continue;
            const entry = await fetchBuild(opts.fetchMissing, version);
            if (entry) {
                builds[version] = entry;
                console.log(`  fetched ${version} from ${opts.fetchMissing}`);
            } else {
                skipped.push(`${version}: no UTF-8 pm/ glue on ${opts.fetchMissing}`);
            }
        }
    }

    for (const [version, status] of Object.entries(opts.status)) {
        if (!builds[version]) throw new Error(`--status ${version}: no such build`);
        builds[version].status = status;
    }

    const versions = Object.keys(builds).sort();
    if (versions.length === 0) throw new Error(`no builds found under ${join(opts.root, 'pm')}`);
    const latest = versions.filter((v) => builds[v].status !== 'withdrawn').at(-1) || versions.at(-1);
    const wantedDefault = opts.defaultVersion || mergedDefault || PROJECTM_WASM_DEFAULT_VERSION;
    const defaultVersion = builds[wantedDefault] && builds[wantedDefault].status !== 'withdrawn' ? wantedDefault : latest;
    if (defaultVersion !== wantedDefault) {
        console.warn(`default ${wantedDefault} is not a deployable build here; using ${defaultVersion}`);
    }
    // A build nobody gave a status: the default and the latest are stable,
    // anything older is legacy (still listed and loadable).
    for (const version of versions) {
        builds[version].status ||= version === latest || version === defaultVersion ? 'stable' : 'legacy';
    }

    const manifest = {
        schema: PROJECTM_WASM_BUILDS_SCHEMA,
        generatedAt: new Date().toISOString(),
        default: defaultVersion,
        latest,
        builds: Object.fromEntries(versions.map((v) => [v, builds[v]])),
    };
    if (!parseWasmBuildsManifest(manifest)) throw new Error('generated manifest does not validate');

    writeFileSync(opts.out, `${JSON.stringify(manifest, null, 2)}\n`);
    if (opts.precompress) {
        precompress(opts.out);
        for (const version of Object.keys(local)) {
            for (const rel of [local[version].glue, local[version].wasm]) precompress(join(opts.root, rel));
        }
    }

    console.log(`wrote ${opts.out}: ${versions.length} builds (default ${defaultVersion}, latest ${latest})`);
    for (const version of versions) {
        const entry = builds[version];
        const from = local[version] ? 'local' : (merged[version] ? 'merged' : 'fetched');
        console.log(`  ${version.padEnd(5)} ${entry.status.padEnd(9)} ${from.padEnd(7)} ${entry.api ? `${entry.api.length} exports` : 'exports unknown'}`);
    }
    for (const line of skipped) console.warn(`  skipped ${line}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(`ERROR: ${error.message}`);
        process.exit(1);
    });
}
