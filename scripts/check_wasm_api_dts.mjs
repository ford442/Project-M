#!/usr/bin/env node
// Checks that the WASM API's four descriptions agree:
//
//   cmake/WasmApiManifest.cmake           the export list (the source)
//   src/wasm/generated/WasmApiExports.cpp the C++ exports, plus the link's
//   scripts/wasm_link_common.inc.sh       EXPORTED_FUNCTIONS and WasmApiErrors.hpp
//   packages/types/src/wasm-api.d.ts      the declarations TypeScript callers
//                                         (RenderTransport.call() included) are
//                                         checked against
//   html/generated/projectm-wasm-api.js   what actually runs
//
// It re-derives what each should say from the manifest on its own rather than
// running the CMake generator, so a generator bug that writes the same wrong
// thing into a file and its committed copy (which scripts/verify_wasm_link_common.sh
// cannot see) still fails here. The .d.ts is read with the TypeScript compiler
// API, not with regular expressions: a declaration counts as it type-checks.
//
//   node scripts/check_wasm_api_dts.mjs                  manifest, C++, .d.ts, .js
//   node scripts/check_wasm_api_dts.mjs --glue <x.js>    also a linked bundle's glue:
//                                                        every manifest export must be in it
//   node scripts/check_wasm_api_dts.mjs --no-dts --glue <x.js>
//                                                        without TypeScript installed (the
//                                                        Emscripten job): manifest, C++, glue
//
// npm run check:wasm-dts; CI: web_lint_gate.yml (full) and build_emscripten.yml (--glue).

import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROJECT_ROOT } from './html-ts-modules.mjs';
import { extractGlueApi } from './generate_wasm_builds_manifest.mjs';

const MANIFEST = 'cmake/WasmApiManifest.cmake';
const EXPORTS_CPP = 'src/wasm/generated/WasmApiExports.cpp';
const ERRORS_HPP = 'src/wasm/generated/WasmApiErrors.hpp';
const LINK_INC = 'scripts/wasm_link_common.inc.sh';
const DTS = 'packages/types/src/wasm-api.d.ts';
const DTS_SHIM = 'html/generated/projectm-wasm-api.d.ts';
const JS = 'html/generated/projectm-wasm-api.js';

const read = (rel) => readFileSync(join(PROJECT_ROOT, rel), 'utf8');

/** @type {string[]} */
const problems = [];
const fail = (message) => problems.push(message);

// ---- the manifest, parsed here ----------------------------------------------

/** The quoted entries of `set(<name> ...)` in the manifest. */
function cmakeList(text, name) {
    const block = new RegExp(`^set\\(${name}\\n([\\s\\S]*?)^\\)`, 'm').exec(text);
    if (!block) throw new Error(`${MANIFEST}: no set(${name} ...)`);
    return [...block[1].matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*$/gm)].map((m) => m[1].replace(/\\"/g, '"'));
}

const camel = (snake) => snake.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

/** @param {string} list `a:i32,b:cstr` */
const parseArgs = (list) =>
    list === ''
        ? []
        : list.split(',').map((pair) => {
              const [name, type] = pair.split(':');
              return { name, type };
          });

/**
 * One manifest entry and everything the four files should say about it.
 *
 * @param {string} line
 */
function parseEntry(line) {
    const fields = line.split('|');
    if (fields.length < 7) throw new Error(`${MANIFEST}: malformed entry ${line}`);
    const [name, visibility, scope, binding, returns, args] = fields;
    const [kind, scopeArg = ''] = scope.split(':');
    const returnType = returns.split('=')[0];
    const params = parseArgs(args);
    const entry = { name, visibility, kind, binding, returnType, params, legacy: name, v2: '', v2Params: [] };
    if (kind === 'host' || kind === 'host-v2') {
        entry.v2 = `pm_${name}`;
        entry.v2Params = [{ name: 'host', type: 'host' }, ...params];
    } else if (kind === 'handle' || kind === 'handle-or-active') {
        entry.v2 = scopeArg;
        entry.v2Params = params;
    }
    if (kind === 'host-v2') entry.legacy = '';
    // What the JS side calls it: a host-v2 entry has only its pm_ export, with
    // the host as its first argument.
    entry.symbol = kind === 'host-v2' ? entry.v2 : name;
    entry.jsName = camel(entry.symbol);
    entry.jsParams = kind === 'host-v2' ? [{ name: 'host', type: 'host' }, ...params] : params;
    return entry;
}

const manifestText = read(MANIFEST);
const entries = cmakeList(manifestText, 'PROJECTM_WASM_API_MANIFEST').map(parseEntry);
const errors = cmakeList(manifestText, 'PROJECTM_WASM_API_ERRORS').map((line) => {
    const [name, value] = line.split('|');
    return { name, value: Number(value) };
});
const jsEntries = entries.filter((e) => e.kind !== 'runtime');

const CXX_TYPES = {
    void: 'void',
    bool: 'bool',
    i32: 'int',
    u32: 'uint32_t',
    f32: 'float',
    f64: 'double',
    usize: 'uintptr_t',
    host: 'uintptr_t',
    error: 'int',
    cstr: 'const char*',
    'i32*': 'int32_t*',
    'u32*': 'uint32_t*',
    'f32*': 'float*',
    'u8*': 'uint8_t*',
};
/** What the .d.ts declares for a manifest type. */
const tsType = (type) =>
    ({ void: 'void', bool: 'boolean', cstr: 'string', host: 'HostHandle', error: 'ProjectMError' })[type] ?? 'number';
/** What crosses the ccall boundary (WasmApiSignature.paramTypes). */
const paramType = (type) => ({ bool: 'boolean', cstr: 'string' })[type] ?? 'number';

for (const e of entries) {
    for (const p of [...e.params, { name: 'return', type: e.returnType }]) {
        if (!(p.type in CXX_TYPES)) fail(`${MANIFEST}: ${e.name}: unknown type '${p.type}' (${p.name})`);
    }
}

// ---- manifest <-> C++ ----------------------------------------------------------

function checkCxx() {
    const cxx = read(EXPORTS_CPP);
    /** @type {Map<string, { ret: string, params: string[] }>} */
    const exported = new Map();
    for (const m of cxx.matchAll(/^EMSCRIPTEN_KEEPALIVE\n(.+?)\s+(\w+)\(([^)]*)\)\n\{/gm)) {
        const params =
            m[3].trim() === ''
                ? []
                : m[3].split(',').map((p) =>
                      p
                          .trim()
                          .replace(/\s*\w+$/, '')
                          .replace(/\s+\*/g, '*')
                  );
        exported.set(m[2], { ret: m[1].replace(/\s+\*/g, '*'), params });
    }
    /** @type {Map<string, { ret: string, params: string[] }>} */
    const expected = new Map();
    const cxxOf = (params) => params.map((p) => CXX_TYPES[p.type]);
    for (const e of entries.filter((x) => x.kind !== 'runtime')) {
        const ret = CXX_TYPES[e.returnType];
        if (e.legacy) expected.set(e.legacy, { ret, params: cxxOf(e.params) });
        if (e.v2) expected.set(e.v2, { ret, params: cxxOf(e.v2Params) });
    }
    for (const [name, want] of expected) {
        const got = exported.get(name);
        if (!got) {
            fail(`${EXPORTS_CPP}: no export ${name}() (the manifest has it)`);
        } else if (got.ret !== want.ret || got.params.join(', ') !== want.params.join(', ')) {
            fail(
                `${EXPORTS_CPP}: ${got.ret} ${name}(${got.params.join(', ')}), the manifest says ${want.ret} ${name}(${want.params.join(', ')})`
            );
        }
    }
    for (const name of exported.keys()) {
        if (!expected.has(name)) fail(`${EXPORTS_CPP}: export ${name}() is not in the manifest`);
    }

    // Exports written by hand outside the generated file would be neither in
    // the manifest nor in the .d.ts.
    const walk = (dir) =>
        readdirSync(join(PROJECT_ROOT, dir), { withFileTypes: true }).flatMap((d) =>
            d.isDirectory() ? (d.name === 'generated' ? [] : walk(join(dir, d.name))) : [join(dir, d.name)]
        );
    for (const file of walk('src/wasm').filter((f) => /\.(cpp|hpp|h)$/.test(f))) {
        const lines = read(file).split('\n');
        lines.forEach((line, index) => {
            if (/^\s*EMSCRIPTEN_KEEPALIVE\b/.test(line)) {
                fail(
                    `${file}:${index + 1}: EMSCRIPTEN_KEEPALIVE outside the generated exports (add it to ${MANIFEST})`
                );
            }
        });
    }

    // The link's EXPORTED_FUNCTIONS.
    const link = /PROJECTM_WASM_EXPORTED_FUNCTIONS=\(\n([\s\S]*?)\n\)/.exec(read(LINK_INC));
    if (!link) {
        fail(`${LINK_INC}: no PROJECTM_WASM_EXPORTED_FUNCTIONS`);
    } else {
        const linked = new Set(link[1].split(/\s+/).filter(Boolean));
        const want = new Set([
            '_main',
            ...entries.flatMap((e) => [e.legacy, e.v2].filter(Boolean).map((n) => `_${n}`)),
        ]);
        for (const name of want) if (!linked.has(name)) fail(`${LINK_INC}: ${name} is not in EXPORTED_FUNCTIONS`);
        for (const name of linked)
            if (!want.has(name)) fail(`${LINK_INC}: ${name} is exported but not in the manifest`);
    }

    // The error codes.
    const enumBody = /enum class WasmApiError : int\n\{([\s\S]*?)\};/.exec(read(ERRORS_HPP));
    const cxxErrors = enumBody ? [...enumBody[1].matchAll(/^\s*(\w+) = (\d+),/gm)].map((m) => `${m[1]}=${m[2]}`) : [];
    const wantErrors = errors.map((x) => `${x.name}=${x.value}`);
    if (cxxErrors.join(' ') !== wantErrors.join(' ')) {
        fail(`${ERRORS_HPP}: WasmApiError is {${cxxErrors.join(', ')}}, the manifest says {${wantErrors.join(', ')}}`);
    }
}

// ---- manifest <-> .d.ts (TypeScript compiler API) --------------------------------

function checkDts() {
    const require = createRequire(import.meta.url);
    /** @type {typeof import('typescript')} */
    const ts = require('typescript');
    const dtsPath = join(PROJECT_ROOT, DTS);
    const program = ts.createProgram([dtsPath], {
        strict: true,
        noEmit: true,
        target: ts.ScriptTarget.ES2022,
        lib: ['lib.es2022.d.ts'],
        types: [],
    });
    for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
        fail(`${DTS}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
    }
    const checker = program.getTypeChecker();
    const source = program.getSourceFile(dtsPath);
    const moduleSymbol = source && checker.getSymbolAtLocation(source);
    if (!moduleSymbol) {
        fail(`${DTS}: not a module`);
        return null;
    }
    const exports = new Map(checker.getExportsOfModule(moduleSymbol).map((s) => [s.getName(), s]));
    const show = (type) => checker.typeToString(type);
    /** `(a: number, b: string) => void` of a call signature, the way the manifest would put it. */
    const describe = (signature, skip = 0) => {
        const params = signature.parameters.slice(skip).map((p) => {
            const declaration = p.valueDeclaration;
            return `${p.getName()}: ${show(checker.getTypeOfSymbolAtLocation(p, declaration))}`;
        });
        return `(${params.join(', ')}) => ${show(signature.getReturnType())}`;
    };
    const want = (params, returnType) =>
        `(${params.map((p) => `${p.name}: ${tsType(p.type)}`).join(', ')}) => ${tsType(returnType)}`;

    // ProjectMError
    const enumSymbol = exports.get('ProjectMError');
    const enumDecl = enumSymbol?.declarations?.find(ts.isEnumDeclaration);
    if (!enumDecl || !(ts.getCombinedModifierFlags(enumDecl) & ts.ModifierFlags.Const)) {
        fail(`${DTS}: ProjectMError is not a const enum`);
    } else {
        const members = enumDecl.members.map((m) => `${m.name.getText(source)}=${checker.getConstantValue(m)}`);
        const expected = errors.map((x) => `${x.name}=${x.value}`);
        if (members.join(' ') !== expected.join(' ')) {
            fail(`${DTS}: ProjectMError is {${members.join(', ')}}, the manifest says {${expected.join(', ')}}`);
        }
    }

    // HostHandle is branded: a plain number must not be assignable to it.
    const hostHandle = exports.get('HostHandle');
    if (!hostHandle) {
        fail(`${DTS}: no HostHandle`);
    } else {
        const type = checker.getDeclaredTypeOfSymbol(hostHandle);
        if (checker.isTypeAssignableTo(checker.getNumberType(), type))
            fail(`${DTS}: HostHandle accepts any number (no brand)`);
        if (!checker.isTypeAssignableTo(type, checker.getNumberType())) fail(`${DTS}: HostHandle is not a number`);
    }

    // WasmApiCalls: one exact signature per call.
    const calls = exports.get('WasmApiCalls');
    const callsType = calls && checker.getDeclaredTypeOfSymbol(calls);
    const callNames = new Set();
    if (!callsType) {
        fail(`${DTS}: no WasmApiCalls`);
    } else {
        for (const property of checker.getPropertiesOfType(callsType)) {
            callNames.add(property.getName());
        }
        for (const e of jsEntries) {
            const property = callsType.getProperty(e.jsName);
            const signature = property && checker.getTypeOfSymbol(property).getCallSignatures()[0];
            if (!signature) {
                fail(`${DTS}: WasmApiCalls has no ${e.jsName}`);
                continue;
            }
            const got = describe(signature);
            const expected = want(e.jsParams, e.returnType);
            if (got !== expected) fail(`${DTS}: WasmApiCalls.${e.jsName} is ${got}, the manifest says ${expected}`);
        }
        for (const name of callNames) {
            if (!jsEntries.some((e) => e.jsName === name)) fail(`${DTS}: WasmApiCalls.${name} is not in the manifest`);
        }
    }

    // The wrappers: the same signature after the module.
    for (const e of jsEntries) {
        const fn = exports.get(e.jsName);
        const signature = fn && checker.getTypeOfSymbol(fn).getCallSignatures()[0];
        if (!signature) {
            fail(`${DTS}: no wrapper ${e.jsName}()`);
            continue;
        }
        const first = signature.parameters[0];
        if (!first || show(checker.getTypeOfSymbolAtLocation(first, first.valueDeclaration)) !== 'ProjectMModule') {
            fail(`${DTS}: ${e.jsName}() does not take the module first`);
        }
        const got = describe(signature, 1);
        const expected = want(e.jsParams, e.returnType);
        if (got !== expected) fail(`${DTS}: ${e.jsName}${got.replace(/ =>/, ':')}, the manifest says ${expected}`);
    }

    // ProjectMModule: the direct bindings are members (pm_ forms optional).
    const moduleType = exports.get('ProjectMModule') && checker.getDeclaredTypeOfSymbol(exports.get('ProjectMModule'));
    for (const e of jsEntries.filter((x) => x.binding === 'direct')) {
        const member = moduleType?.getProperty(`_${e.symbol}`);
        const signature = member && checker.getNonNullableType(checker.getTypeOfSymbol(member)).getCallSignatures()[0];
        if (!signature) {
            fail(`${DTS}: ProjectMModule has no _${e.symbol}`);
        } else if (signature.parameters.length !== e.jsParams.length) {
            fail(
                `${DTS}: ProjectMModule._${e.symbol} takes ${signature.parameters.length} argument(s), the manifest ${e.jsParams.length}`
            );
        }
        if (e.v2 && e.kind !== 'host-v2') {
            const v2 = moduleType?.getProperty(`_${e.v2}`);
            if (!v2 || !(v2.flags & ts.SymbolFlags.Optional))
                fail(`${DTS}: ProjectMModule._${e.v2} is missing or not optional`);
        }
    }

    // WASM_API_SYMBOLS: name -> symbol, as literal types.
    const symbolsType = exports.get('WASM_API_SYMBOLS') && checker.getTypeOfSymbol(exports.get('WASM_API_SYMBOLS'));
    const dtsSymbols = Object.fromEntries(
        (symbolsType ? checker.getPropertiesOfType(symbolsType) : []).map((p) => [
            p.getName(),
            show(checker.getTypeOfSymbol(p)),
        ])
    );
    const wantSymbols = Object.fromEntries(jsEntries.map((e) => [e.jsName, `"${e.symbol}"`]));
    if (JSON.stringify(dtsSymbols) !== JSON.stringify(wantSymbols))
        fail(`${DTS}: WASM_API_SYMBOLS differs from the manifest`);

    // PUBLIC_WASM_API: one element per public entry.
    const publicType = exports.get('PUBLIC_WASM_API') && checker.getTypeOfSymbol(exports.get('PUBLIC_WASM_API'));
    const publicCount =
        publicType && checker.isTupleType(publicType) ? checker.getTypeArguments(publicType).length : -1;
    const wantPublic = jsEntries.filter((e) => e.visibility === 'public').length;
    if (publicCount !== wantPublic)
        fail(`${DTS}: PUBLIC_WASM_API has ${publicCount} element(s), the manifest ${wantPublic} public call(s)`);

    // The values the .d.ts says the .js exports.
    const values = [...exports.values()]
        .filter((s) => s.flags & (ts.SymbolFlags.Function | ts.SymbolFlags.Variable | ts.SymbolFlags.Enum))
        .map((s) => s.getName())
        .sort();
    return { values };
}

// ---- .d.ts <-> .js --------------------------------------------------------------

async function checkJs(dts) {
    const shim = read(DTS_SHIM);
    if (!/^export \* from '@projectm\/types\/wasm-api';$/m.test(shim)) {
        fail(`${DTS_SHIM}: does not re-export @projectm/types/wasm-api`);
    }
    const api = await import(pathToFileURL(join(PROJECT_ROOT, JS)).href);
    const runtime = Object.keys(api).sort();
    if (dts) {
        for (const name of dts.values)
            if (!runtime.includes(name)) fail(`${JS}: does not export ${name}, which the .d.ts declares`);
        for (const name of runtime)
            if (!dts.values.includes(name)) fail(`${JS}: exports ${name}, which the .d.ts does not declare`);
    }
    const runtimeErrors = Object.entries(api.ProjectMError ?? {}).map(([k, v]) => `${k}=${v}`);
    const wantErrors = errors.map((x) => `${x.name}=${x.value}`);
    if (runtimeErrors.join(' ') !== wantErrors.join(' ')) fail(`${JS}: ProjectMError is {${runtimeErrors.join(', ')}}`);
    if (!Object.isFrozen(api.ProjectMError)) fail(`${JS}: ProjectMError is not frozen`);
    if (api.DEFAULT_HOST !== 0) fail(`${JS}: DEFAULT_HOST is ${api.DEFAULT_HOST}, not 0`);

    for (const e of jsEntries) {
        const wrapper = api[e.jsName];
        if (typeof wrapper !== 'function') {
            fail(`${JS}: ${e.jsName} is not a function`);
        } else if (wrapper.length !== 1 + e.jsParams.length) {
            fail(
                `${JS}: ${e.jsName}() takes ${wrapper.length - 1} argument(s) after the module, the manifest ${e.jsParams.length}`
            );
        }
        const signature = api.WASM_API_SIGNATURES?.[e.jsName];
        const wantParams = e.jsParams.map((p) => paramType(p.type));
        const wantArgs = wantParams.map((t) => (t === 'string' ? 'string' : 'number'));
        const wantReturn = e.returnType === 'void' ? null : paramType(e.returnType);
        if (!signature) {
            fail(`${JS}: WASM_API_SIGNATURES has no ${e.jsName}`);
        } else if (
            signature.symbol !== e.symbol ||
            signature.paramTypes.join() !== wantParams.join() ||
            signature.argTypes.join() !== wantArgs.join() ||
            signature.returnType !== wantReturn
        ) {
            fail(`${JS}: WASM_API_SIGNATURES.${e.jsName} is ${JSON.stringify(signature)}`);
        }
        if (api.WASM_API_SYMBOLS?.[e.jsName] !== e.symbol)
            fail(`${JS}: WASM_API_SYMBOLS.${e.jsName} is not '${e.symbol}'`);
    }
    for (const name of Object.keys(api.WASM_API_SIGNATURES ?? {})) {
        if (!jsEntries.some((e) => e.jsName === name))
            fail(`${JS}: WASM_API_SIGNATURES.${name} is not in the manifest`);
    }
}

// ---- manifest <-> a linked bundle ------------------------------------------------

function checkGlue(gluePath) {
    const glue = extractGlueApi(readFileSync(gluePath, 'utf8'));
    const linked = new Set(glue);
    const shown = relative(PROJECT_ROOT, gluePath);
    for (const e of entries) {
        for (const name of [e.legacy, e.v2].filter(Boolean)) {
            if (!linked.has(name))
                fail(`${shown}: the bundle does not export ${name}, which the manifest (and the .d.ts) have`);
        }
    }
    return glue.length;
}

async function main() {
    const args = process.argv.slice(2);
    const glueIndex = args.indexOf('--glue');
    const gluePath = glueIndex >= 0 ? args[glueIndex + 1] : null;
    if (glueIndex >= 0 && !gluePath) throw new Error('--glue needs a path');
    const withDts = !args.includes('--no-dts');

    checkCxx();
    const dts = withDts ? checkDts() : null;
    if (withDts) await checkJs(dts);
    const glueCount = gluePath ? checkGlue(gluePath) : 0;

    if (problems.length > 0) {
        console.error(`The WASM API's descriptions disagree (${problems.length}):`);
        for (const problem of problems) console.error(`  ${problem}`);
        console.error(`${MANIFEST} is the source: regenerate with scripts/sync_wasm_link_common.sh.`);
        process.exit(1);
    }
    const checked = [
        'C++ exports',
        ...(withDts ? ['.d.ts', '.js'] : []),
        ...(gluePath ? [`bundle (${glueCount} exports)`] : []),
    ];
    console.log(
        `${MANIFEST}: ${entries.length} entries, ${errors.length} error codes agree with the ${checked.join(', ')}.`
    );
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
