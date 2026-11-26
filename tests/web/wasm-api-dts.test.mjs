// scripts/check_wasm_api_dts.mjs: the manifest, the C++ exports, the .d.ts and
// the .js agree, and a linked bundle that lacks an export the .d.ts declares is
// refused (the `func is not a function` class of bug, #269). Run here so
// `npm test` fails on drift too, not only the lint gate.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const script = join(repoRoot, 'scripts', 'check_wasm_api_dts.mjs');

/** @param {string[]} args */
function runCheck(args = []) {
    return spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: 'utf8' });
}

/** Glue that exports `names` the way an Emscripten link writes its export table. */
function fakeGlue(names) {
    const dir = mkdtempSync(join(tmpdir(), 'pm-glue-'));
    const file = join(dir, 'projectm-v.030-thread.js');
    writeFileSync(file, names.map((name) => `Module["_${name}"] = wasmExports["${name}"];`).join('\n'));
    return { file, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Every export the link has: its EXPORTED_FUNCTIONS, which the check itself
 * holds to the manifest (the first test).
 */
function linkedExports() {
    const inc = readFileSync(join(repoRoot, 'scripts', 'wasm_link_common.inc.sh'), 'utf8');
    const list = /PROJECTM_WASM_EXPORTED_FUNCTIONS=\(\n([\s\S]*?)\n\)/.exec(inc);
    assert.ok(list, 'wasm_link_common.inc.sh has PROJECTM_WASM_EXPORTED_FUNCTIONS');
    return list[1]
        .split(/\s+/)
        .filter(Boolean)
        .map((name) => name.replace(/^_/, ''));
}

test('the manifest, the C++ exports, the .d.ts and the .js agree', () => {
    const result = runCheck();
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /agree with the C\+\+ exports, \.d\.ts, \.js/);
});

test('a bundle missing an export the .d.ts declares is refused', () => {
    const glue = fakeGlue(linkedExports().filter((name) => name !== 'pm_set_mesh'));
    try {
        const result = runCheck(['--no-dts', '--glue', glue.file]);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /does not export pm_set_mesh/);
    } finally {
        glue.dispose();
    }
});

test('--glue accepts a bundle that exports everything the manifest has', () => {
    // A superset is fine: the export table also lists runtime helpers.
    const glue = fakeGlue([...linkedExports(), 'some_runtime_helper']);
    try {
        const result = runCheck(['--no-dts', '--glue', glue.file]);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /bundle \(\d+ exports\)/);
    } finally {
        glue.dispose();
    }
});
