// scripts/symbolize_wasm_trace.mjs without a browser or a bundle: the three
// browsers' frame formats, the symbol map, a hand-built name section, inlined
// DWARF locations, and the CLI's exit codes. The real round trip (a forced trap
// in Chromium, symbolized with the profile flavor's DWARF) is
// tests/wasm-smoke/symbolize_trap.mjs in build_emscripten.yml.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    findLlvmSymbolizer, parseSymbolMap, parseTrace, readNameSection, symbolizeTrace,
} from '../../scripts/symbolize_wasm_trace.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const script = join(repoRoot, 'scripts', 'symbolize_wasm_trace.mjs');

const CHROME = [
    'RuntimeError: unreachable',
    '    at wasm://wasm/0a1b2c3d:wasm-function[385]:0x16298',
    '    at projectm.wasm.debug_force_trap (https://example.test/pm/projectm-v.040-thread.wasm:wasm-function[919]:0x291d8)',
    '    at https://example.test/index.html:38:18',
].join('\n');
const FIREFOX = 'debug_force_trap@https://example.test/pm/projectm-v.040-thread.wasm:wasm-function[919]:0x291d8';
const SAFARI = '<?>.wasm-function[919]@[wasm code]';

test('parseTrace: Chrome, Firefox and Safari frames, offsets where the browser gives one', () => {
    assert.deepEqual(parseTrace(CHROME).map(({ line, index, offset }) => ({ line, index, offset })), [
        { line: 1, index: 385, offset: 0x16298 },
        { line: 2, index: 919, offset: 0x291d8 },
    ]);
    assert.deepEqual(parseTrace(FIREFOX).map(({ index, offset }) => ({ index, offset })), [{ index: 919, offset: 0x291d8 }]);
    assert.deepEqual(parseTrace(SAFARI).map(({ index, offset }) => ({ index, offset })), [{ index: 919, offset: null }]);
    assert.deepEqual(parseTrace('Error: no wasm here\n    at f (a.js:1:2)'), []);
});

test('parseSymbolMap: index:name lines, names that contain colons kept whole', () => {
    const names = parseSymbolMap('0:emscripten_get_now\n385:ForceTrapForSymbolizerTest()\n919:WasmApi::debug_force_trap()\n\njunk\n');
    assert.equal(names.get(0), 'emscripten_get_now');
    assert.equal(names.get(385), 'ForceTrapForSymbolizerTest()');
    assert.equal(names.get(919), 'WasmApi::debug_force_trap()');
    assert.equal(names.size, 3);
});

/** A module with a type section (skipped) and a name section naming two functions. */
function moduleWithNames(entries) {
    const enc = new TextEncoder();
    const str = (s) => [...leb(enc.encode(s).length), ...enc.encode(s)];
    function leb(n) {
        const out = [];
        do {
            let byte = n & 0x7f;
            n >>>= 7;
            if (n) byte |= 0x80;
            out.push(byte);
        } while (n);
        return out;
    }
    const functionNames = [...leb(entries.length), ...entries.flatMap(([i, name]) => [...leb(i), ...str(name)])];
    const moduleName = [0, ...leb(3), ...str('pm')];
    const payload = [...str('name'), ...moduleName, 1, ...leb(functionNames.length), ...functionNames];
    const typeSection = [1, 1, 0];
    return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...typeSection, 0, ...leb(payload.length), ...payload]);
}

test('readNameSection: function names by index, other subsections and sections skipped', () => {
    const names = readNameSection(moduleWithNames([[385, 'ForceTrapForSymbolizerTest()'], [200, 'x'.repeat(200)]]));
    assert.equal(names.get(385), 'ForceTrapForSymbolizerTest()');
    assert.equal(names.get(200), 'x'.repeat(200));
    assert.equal(readNameSection(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])).size, 0);
    assert.throws(() => readNameSection(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /not a wasm module/);
});

test('symbolizeTrace: names by index, DWARF by offset with inlined frames innermost first', () => {
    const names = new Map([[385, 'ForceTrapForSymbolizerTest()'], [919, 'debug_force_trap']]);
    const dwarf = new Map([[0x291d8, [
        { function: 'Guarded<...>', file: 'src/wasm/WasmApiBarrier.hpp', line: 147, column: 5, inlined: true },
        { function: 'debug_force_trap', file: 'src/wasm/generated/WasmApiExports.cpp', line: 1171, column: 5 },
    ]]]);
    const result = symbolizeTrace(CHROME, { names, dwarf });
    assert.equal(result.resolvedCount, 2);
    assert.deepEqual(result.text.split('\n'), [
        'RuntimeError: unreachable',
        '    at ForceTrapForSymbolizerTest()  [wasm-function[385]:0x16298]',
        '    at Guarded<...> (src/wasm/WasmApiBarrier.hpp:147:5) [inlined]  [wasm-function[919]:0x291d8]',
        '    at debug_force_trap (src/wasm/generated/WasmApiExports.cpp:1171:5)',
        '    at https://example.test/index.html:38:18',
    ]);
    // Nothing known: the trace comes back unchanged.
    assert.equal(symbolizeTrace(CHROME).text, CHROME);
});

test('findLlvmSymbolizer: explicit path, then $LLVM_SYMBOLIZER, then emsdk, then PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'symbolizer-'));
    try {
        const tool = join(dir, 'llvm-symbolizer');
        writeFileSync(tool, '');
        assert.equal(findLlvmSymbolizer(tool, {}), tool);
        assert.equal(findLlvmSymbolizer(undefined, { LLVM_SYMBOLIZER: tool }), tool);
        assert.equal(findLlvmSymbolizer(undefined, { PATH: dir }), tool);
        assert.equal(findLlvmSymbolizer(undefined, { PATH: join(dir, 'missing') }), null);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('CLI: rewrites the trace from a symbol map, fails when nothing resolves, refuses no source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'symbolize-cli-'));
    try {
        const trace = join(dir, 'trace.txt');
        writeFileSync(trace, `${CHROME}\n`);
        const symbols = join(dir, 'bundle.symbols');
        writeFileSync(symbols, '385:ForceTrapForSymbolizerTest()\n');
        const ok = spawnSync(process.execPath, [script, '--symbols', symbols, trace], { encoding: 'utf8' });
        assert.equal(ok.status, 0, ok.stderr);
        assert.match(ok.stdout, /at ForceTrapForSymbolizerTest\(\) {2}\[wasm-function\[385\]:0x16298\]/);

        const json = spawnSync(process.execPath, [script, '--symbols', symbols, '--json'], { input: CHROME, encoding: 'utf8' });
        assert.equal(json.status, 0, json.stderr);
        assert.deepEqual(JSON.parse(json.stdout).map((frame) => frame.resolved.length), [1, 0]);

        writeFileSync(symbols, '1:unrelated\n');
        const none = spawnSync(process.execPath, [script, '--symbols', symbols, trace], { encoding: 'utf8' });
        assert.equal(none.status, 1);
        assert.match(none.stderr, /none of the 2 wasm frame\(s\) resolved/);

        const usage = spawnSync(process.execPath, [script, trace], { encoding: 'utf8' });
        assert.equal(usage.status, 2);
        assert.match(usage.stderr, /at least one of --dwarf, --symbols, --wasm/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
