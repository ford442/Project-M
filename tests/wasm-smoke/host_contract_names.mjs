#!/usr/bin/env node
/**
 * Host-contract name gate for a linked WASM glue file.
 *
 * The EM_JS / EM_ASM bodies in src/wasm/ and its --pre-js talk to the host page
 * through plain property names: globalThis.pmOnPerfFrame,
 * globalThis.projectMWritePcmRing, globalThis.projectMPresetSwitchFailed,
 * Module.__pmPerfGpu, the worklet's { audioData, channelsForPM } message, ...
 * The host side (html/, packages/web/) is not part of the emcc link, so a JS
 * minifier that renames properties (Closure ADVANCED, `--closure 1`) breaks
 * that contract silently: the module still boots, renders and passes the
 * browser smoke test, while audio ingest, the preset-failure overlay, the perf
 * HUD and the governor callbacks stop firing.
 *
 * This checks the one property that matters for that failure mode: every name
 * the engine-side JS reaches for on globalThis / window / Module still appears
 * verbatim in the emitted glue.
 *
 * Usage:
 *   node tests/wasm-smoke/host_contract_names.mjs cmake-build/wasm-smoke/projectm-v.030-thread.js
 *
 * Exit code is non-zero and every missing name is listed when the glue does not
 * carry the contract. A `--closure 1` link (with only the FS methods pinned in
 * externs) fails this with 33 of 41 names missing — see docs/PERFORMANCE.md
 * "Closure Compiler" for the recorded run.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '../..');
const wasmSourceDir = join(root, 'src/wasm');

// Object fields that cross into JS the engine does not link. html/
// projectm-worklet-playback.js reads these off the port message that
// WasmAudioBridge.cpp posts; they are not reachable through globalThis/Module.
const CROSS_BOUNDARY_FIELDS = ['audioData', 'channelsForPM'];

/** Drops // line comments and block comments so prose never becomes contract. */
function stripComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

export function collectContractNames(sourceDir = wasmSourceDir) {
    const names = new Set(CROSS_BOUNDARY_FIELDS);
    const files = readdirSync(sourceDir).filter((f) => /\.(cpp|hpp|js)$/.test(f));
    for (const file of files) {
        const text = stripComments(readFileSync(join(sourceDir, file), 'utf8'));
        for (const match of text.matchAll(/\b(?:globalThis|window|Module)\.([A-Za-z_$][\w$]*)/g)) {
            names.add(match[1]);
        }
    }
    return [...names].sort();
}

export function findMissingNames(glue, names) {
    return names.filter((name) => {
        const escaped = name.replace(/\$/g, '\\$');
        return !new RegExp(`(\\.${escaped}\\b|['"]${escaped}['"])`).test(glue);
    });
}

function main() {
    const gluePath = process.argv[2];
    if (!gluePath) {
        console.error('Usage: node tests/wasm-smoke/host_contract_names.mjs <projectm glue .js>');
        process.exit(2);
    }
    const glue = readFileSync(resolve(gluePath), 'utf8');
    const names = collectContractNames();
    const missing = findMissingNames(glue, names);
    if (missing.length > 0) {
        console.error(`Host contract broken: ${missing.length} of ${names.length} names missing from ${gluePath}`);
        for (const name of missing) {
            console.error(`  - ${name}`);
        }
        process.exit(1);
    }
    console.log(`Host contract intact: all ${names.length} names present in ${gluePath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
