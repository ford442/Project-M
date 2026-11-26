#!/usr/bin/env node
/**
 * Symbolizer round trip on a forced trap: load a bundle in Chromium, make it
 * trap (debug_force_trap(), a wasm `unreachable`; tests/wasm-smoke/symbolize_trap.html),
 * and hand the browser's stack trace to scripts/symbolize_wasm_trace.mjs with
 * the files that bundle's link wrote next to it.
 *
 *   node tests/wasm-smoke/symbolize_trap.mjs --module cmake-build/wasm-smoke/projectm-v.030-thread.js
 *   node tests/wasm-smoke/symbolize_trap.mjs --module cmake-build/wasm-smoke-profile/projectm-v.030-thread.js --require-dwarf
 *
 * Every bundle: the innermost wasm frame must resolve to
 * ForceTrapForSymbolizerTest through the symbol map (<bundle>.js.symbols), or to
 * the debug_force_trap export it is inlined into by the release link. A
 * bundle with a <bundle>.debug.wasm (the profile flavor) must also resolve it
 * through the DWARF to src/wasm/projectM_emscripten.cpp, at the line of the
 * __builtin_trap() in this tree, and through the .wasm's own name section.
 * --require-dwarf fails when there is no .debug.wasm (CI's profile leg).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    findLlvmSymbolizer, parseSymbolMap, parseTrace, readNameSection, resolveDwarf, symbolizeTrace,
} from '../../scripts/symbolize_wasm_trace.mjs';
import {
    createStaticServer, detectRepoRoot, launchChromium, listen, loadPlaywright, rootRelative,
} from './lib/harness-runtime.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.PROJECTM_ROOT || detectRepoRoot(scriptDir));

const options = {
    module: process.env.PROJECTM_WASM_JS || 'cmake-build/wasm-smoke/projectm-v.030-thread.js',
    requireDwarf: false,
};
for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === '--module') options.module = process.argv[++i];
    else if (arg === '--require-dwarf') options.requireDwarf = true;
    else throw new Error(`Unknown argument: ${arg}`);
}

const modulePath = resolve(root, options.module);
const base = modulePath.replace(/\.js$/, '');
const symbolsFile = `${base}.js.symbols`;
const debugFile = `${base}.debug.wasm`;
const trapFunction = 'ForceTrapForSymbolizerTest';

// The line the trap must resolve to: the __builtin_trap() in this tree.
const trapSource = 'src/wasm/projectM_emscripten.cpp';
const sourceLines = readFileSync(resolve(root, trapSource), 'utf8').split('\n');
const trapDefinition = sourceLines.findIndex((line) => line.includes(`void ${trapFunction}()`));
const trapLine = sourceLines.findIndex((line, i) => i > trapDefinition && line.includes('__builtin_trap()')) + 1;
if (trapDefinition < 0 || trapLine <= 0) {
    throw new Error(`${trapSource} has no ${trapFunction}() with a __builtin_trap()`);
}

const failures = [];
const check = (ok, message) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
    if (!ok) failures.push(message);
};

const { chromium } = loadPlaywright(root);
const server = createStaticServer(root);
const port = await listen(server);
const url = (path) => rootRelative(root, resolve(root, path));
let browser;
try {
    browser = await launchChromium(chromium, 'software');
    const page = await browser.newPage();
    page.on('pageerror', (error) => console.error('[browser:pageerror]', error.message));
    await page.goto(`http://127.0.0.1:${port}${url('tests/wasm-smoke/symbolize_trap.html')}?`
        + new URLSearchParams({ module: url(options.module) }), { waitUntil: 'load', timeout: 60000 });
    const handle = await page.waitForFunction(() => window.__projectMTrap, null, { timeout: 120000 });
    const trap = await handle.jsonValue();
    if (!trap.ok) {
        throw new Error(trap.error);
    }
    console.log(`trap: ${trap.name}: ${trap.message}\n${trap.stack}\n`);
    check(trap.name === 'RuntimeError', `a RuntimeError, not a caught exception (${trap.name})`);

    const frames = parseTrace(trap.stack);
    check(frames.length > 0, `the trace has wasm frames (${frames.length})`);
    const innermost = frames[0];
    check(innermost?.offset !== null, 'the innermost frame carries a byte offset');

    // The release link's wasm-opt inlines the trap function into the export
    // (binaryen does not read clang's noinline), so there either one is right.
    const names = parseSymbolMap(readFileSync(symbolsFile, 'utf8'));
    const bySymbols = symbolizeTrace(trap.stack, { names });
    const bySymbolsName = bySymbols.frames[0]?.resolved[0]?.function ?? '';
    check(bySymbolsName.startsWith(trapFunction) || bySymbolsName === 'debug_force_trap',
        `${symbolsFile.slice(root.length + 1)}: innermost frame is ${bySymbolsName || '(unresolved)'}`);

    if (existsSync(debugFile)) {
        const nameSection = readNameSection(readFileSync(modulePath.replace(/\.js$/, '.wasm')));
        const byNames = symbolizeTrace(trap.stack, { names: nameSection });
        check(byNames.frames[0]?.resolved[0]?.function?.startsWith(trapFunction),
            `name section: innermost frame is ${byNames.frames[0]?.resolved[0]?.function}`);

        const symbolizer = findLlvmSymbolizer(undefined);
        check(!!symbolizer, `llvm-symbolizer found (${symbolizer ?? 'activate emsdk or set LLVM_SYMBOLIZER'})`);
        if (symbolizer) {
            const dwarf = resolveDwarf(symbolizer, debugFile, frames.map((f) => f.offset).filter((o) => o !== null),
                (file) => file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file);
            const byDwarf = symbolizeTrace(trap.stack, { names, dwarf });
            console.log(`\nsymbolized with ${debugFile.slice(root.length + 1)}:\n${byDwarf.text}\n`);
            const location = byDwarf.frames[0]?.resolved[0];
            check(location?.function?.startsWith(trapFunction)
                && location.file === trapSource && location.line === trapLine,
            `DWARF: innermost frame is ${location?.function} at ${location?.file}:${location?.line} `
                + `(expected ${trapSource}:${trapLine})`);
            check(byDwarf.frames.some((f) => f.resolved.some((l) => l.function === 'WasmApi::debug_force_trap()')),
                'DWARF: the export that called it is on the stack');
        }
    } else {
        check(!options.requireDwarf, options.requireDwarf
            ? `${debugFile.slice(root.length + 1)} is missing (--require-dwarf: build with --flavor profile)`
            : `no ${debugFile.slice(root.length + 1)}: DWARF and name section not checked (not the profile flavor)`);
    }
} finally {
    await browser?.close();
    server.close();
}

if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
}
console.log('\nsymbolizer round trip OK');
