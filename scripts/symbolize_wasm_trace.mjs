#!/usr/bin/env node
/**
 * Symbolizes the wasm frames of a browser stack trace from the projectM bundle.
 *
 *   node scripts/symbolize_wasm_trace.mjs --symbols projectm-v.040-thread.symbols < trace.txt
 *   node scripts/symbolize_wasm_trace.mjs --dwarf cmake-build/wasm-smoke-profile/projectm-v.030-thread.debug.wasm trace.txt
 *   node scripts/symbolize_wasm_trace.mjs --wasm cmake-build/wasm-smoke-profile/projectm-v.030-thread.wasm trace.txt
 *
 * The trace is a file argument or stdin, pasted as the browser printed it. Every
 * line with a wasm frame is rewritten as `at <function> (<file>:<line>:<col>)`,
 * followed by the original frame in brackets. Other lines pass through unchanged.
 * Recognized frames:
 *   Chrome   at wasm://wasm/1a2b3c4d:wasm-function[1234]:0x5678
 *            at name (https://host/pm/x.wasm:wasm-function[1234]:0x5678)
 *   Firefox  name@https://host/pm/x.wasm:wasm-function[1234]:0x5678
 *   Safari   <?>.wasm-function[1234]@[wasm code]     (index only, no offset)
 *
 * Sources, best first (pass any combination):
 *   --dwarf <file>   the profile flavor's projectm-v.030-thread.debug.wasm
 *                    (scripts/build_wasm.sh --flavor profile): function, file, line
 *                    and inlined frames, through llvm-symbolizer (emsdk ships one;
 *                    --llvm-symbolizer, $LLVM_SYMBOLIZER, $EMSDK/upstream/bin, beside
 *                    emcc on PATH, then PATH; an older distribution build reads no wasm
 *                    line table and prints functions without file:line).
 *                    Needs the frame's byte offset (0x...), which Safari omits.
 *   --symbols <file> the release flavor's symbol map (<bundle>.js.symbols, staged as
 *                    projectm-v.<version>-thread.symbols): function names by index.
 *   --wasm <file>    a .wasm that kept its name section (the profile flavor does,
 *                    the release one does not): function names by index.
 *
 * Only a source from the *same link* as the trace's bundle is meaningful: two
 * links number their functions differently. The release bundle's .wasm carries no
 * names and no DWARF, so a production trace takes the .symbols kept for that
 * version (docs/EMSCRIPTEN.md "Symbolizing a production stack trace").
 *
 * --json prints the parsed frames and what each resolved to instead of the trace.
 * Exit status: 0, or 1 when the trace has wasm frames and none resolved (wrong
 * file, or a source from another link); 2 on a usage error.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join, relative, resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FRAME_RE = /wasm-function\[(\d+)\](?::(0x[0-9a-fA-F]+))?/;

/**
 * @typedef {{ line: number, index: number, offset: number | null, text: string }} WasmFrame
 * @typedef {{ function: string, file?: string, line?: number, column?: number, inlined?: boolean }} ResolvedLocation
 */

/**
 * The wasm frames of a stack trace, one per line that has one.
 *
 * @param {string} text
 * @returns {WasmFrame[]}
 */
export function parseTrace(text) {
    /** @type {WasmFrame[]} */
    const frames = [];
    text.split(/\r?\n/).forEach((lineText, line) => {
        const match = FRAME_RE.exec(lineText);
        if (match) {
            frames.push({
                line,
                index: Number(match[1]),
                offset: match[2] ? Number.parseInt(match[2], 16) : null,
                text: lineText,
            });
        }
    });
    return frames;
}

/**
 * `--emit-symbol-map` output (`index:name` per line) → Map(index, name).
 *
 * @param {string} text
 * @returns {Map<number, string>}
 */
export function parseSymbolMap(text) {
    const names = new Map();
    for (const lineText of text.split(/\r?\n/)) {
        const colon = lineText.indexOf(':');
        if (colon <= 0) continue;
        const index = Number(lineText.slice(0, colon));
        if (Number.isInteger(index)) names.set(index, lineText.slice(colon + 1));
    }
    return names;
}

/**
 * Function names from a wasm module's "name" custom section (subsection 1),
 * Map(index, name). Empty when the module has none.
 *
 * @param {Uint8Array} bytes
 * @returns {Map<number, string>}
 */
export function readNameSection(bytes) {
    const names = new Map();
    let pos = 8; // magic + version
    const u32 = () => {
        let result = 0;
        let shift = 0;
        for (;;) {
            if (pos >= bytes.length) throw new Error('truncated LEB128 in wasm module');
            const byte = bytes[pos++];
            result += (byte & 0x7f) * 2 ** shift;
            if ((byte & 0x80) === 0) return result;
            shift += 7;
        }
    };
    const decoder = new TextDecoder();
    const str = () => {
        const length = u32();
        const value = decoder.decode(bytes.subarray(pos, pos + length));
        pos += length;
        return value;
    };
    if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
        throw new Error('not a wasm module');
    }
    while (pos < bytes.length) {
        const id = bytes[pos++];
        const size = u32();
        const end = pos + size;
        if (id === 0 && str() === 'name') {
            while (pos < end) {
                const subsection = bytes[pos++];
                const subsectionSize = u32();
                const subsectionEnd = pos + subsectionSize;
                if (subsection === 1) {
                    const count = u32();
                    for (let i = 0; i < count; i += 1) {
                        const index = u32();
                        names.set(index, str());
                    }
                }
                pos = subsectionEnd;
            }
        }
        pos = end;
    }
    return names;
}

/**
 * The llvm-symbolizer to run: the explicit one, $LLVM_SYMBOLIZER, emsdk's ($EMSDK, or
 * beside an emcc on PATH), or PATH's.
 *
 * @param {string | undefined} explicit
 * @returns {string | null}
 */
export function findLlvmSymbolizer(explicit, env = process.env) {
    const candidates = [explicit, env.LLVM_SYMBOLIZER];
    if (env.EMSDK) candidates.push(join(env.EMSDK, 'upstream', 'bin', 'llvm-symbolizer'));
    const dirs = (env.PATH || '').split(delimiter).filter(Boolean);
    // emsdk's own, next to an emcc on PATH (upstream/emscripten/emcc -> upstream/bin):
    // a distribution's older llvm-symbolizer names wasm functions but reads no line table.
    for (const dir of dirs) {
        if (existsSync(join(dir, 'emcc'))) candidates.push(join(dir, '..', 'bin', 'llvm-symbolizer'));
    }
    for (const dir of dirs) candidates.push(join(dir, 'llvm-symbolizer'));
    return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

/**
 * Byte offsets → source locations through llvm-symbolizer and a DWARF file, one
 * call for all of them. The innermost location comes first; the ones after it
 * are the functions it was inlined into, and the last one is the real frame.
 *
 * @param {string} symbolizer
 * @param {string} dwarfFile
 * @param {number[]} offsets
 * @param {(file: string) => string} [mapFile]
 * @returns {Map<number, ResolvedLocation[]>}
 */
export function resolveDwarf(symbolizer, dwarfFile, offsets, mapFile = (file) => file) {
    const unique = [...new Set(offsets)];
    const resolved = new Map();
    if (unique.length === 0) return resolved;
    const output = execFileSync(symbolizer, [
        '--output-style=JSON', '--inlines', '--demangle', '-e', dwarfFile,
        ...unique.map((offset) => `0x${offset.toString(16)}`),
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    for (const entry of JSON.parse(output)) {
        const offset = Number.parseInt(entry.Address, 16);
        /** @type {ResolvedLocation[]} */
        const locations = (entry.Symbol || [])
            .filter((symbol) => symbol.FunctionName && symbol.FunctionName !== '??')
            .map((symbol, i) => ({
                function: symbol.FunctionName,
                ...(symbol.FileName ? { file: mapFile(symbol.FileName) } : {}),
                ...(symbol.Line ? { line: symbol.Line } : {}),
                ...(symbol.Column ? { column: symbol.Column } : {}),
            }));
        // Innermost first, like a stack trace: every entry but the last was
        // inlined into the one after it, and the last is the physical frame.
        locations.slice(0, -1).forEach((location) => {
            location.inlined = true;
        });
        if (locations.length > 0) resolved.set(offset, locations);
    }
    return resolved;
}

/**
 * @param {ResolvedLocation} location
 * @returns {string}
 */
function formatLocation(location) {
    if (!location.file) return location.function;
    const position = [location.line, location.column].filter((n) => n).join(':');
    return `${location.function} (${location.file}${position ? `:${position}` : ''})`;
}

/**
 * The trace with every wasm frame it could resolve rewritten.
 *
 * @param {string} text
 * @param {{ names?: Map<number, string>, dwarf?: Map<number, ResolvedLocation[]> }} sources
 * @returns {{ text: string, frames: Array<WasmFrame & { resolved: ResolvedLocation[] }>, resolvedCount: number }}
 */
export function symbolizeTrace(text, { names = new Map(), dwarf = new Map() } = {}) {
    const lines = text.split(/\r?\n/);
    const frames = parseTrace(text).map((frame) => {
        const fromDwarf = frame.offset !== null ? dwarf.get(frame.offset) : undefined;
        const name = names.get(frame.index);
        /** @type {ResolvedLocation[]} */
        const resolved = fromDwarf ?? (name ? [{ function: name }] : []);
        return { ...frame, resolved };
    });
    for (const frame of frames) {
        if (frame.resolved.length === 0) continue;
        const indent = /^\s*/.exec(frame.text)?.[0] ?? '';
        const original = FRAME_RE.exec(frame.text)?.[0] ?? '';
        lines[frame.line] = frame.resolved
            .map((location, i) => `${indent}at ${formatLocation(location)}${location.inlined ? ' [inlined]' : ''}`
                + (i === 0 ? `  [${original}]` : ''))
            .join('\n');
    }
    return { text: lines.join('\n'), frames, resolvedCount: frames.filter((f) => f.resolved.length > 0).length };
}

function usage() {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const header = /\/\*\*([\s\S]*?)\*\//.exec(source)?.[1] ?? '';
    return header.split('\n').map((l) => l.replace(/^ \* ?/, '')).join('\n').trim();
}

async function main(argv) {
    /** @type {{ symbols?: string, wasm?: string, dwarf?: string, symbolizer?: string, json: boolean, input?: string, root: string }} */
    const options = { json: false, root: resolve(dirname(fileURLToPath(import.meta.url)), '..') };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const value = () => {
            if (i + 1 >= argv.length) throw new UsageError(`${arg} needs a value`);
            return argv[++i];
        };
        if (arg === '--symbols') options.symbols = value();
        else if (arg === '--wasm') options.wasm = value();
        else if (arg === '--dwarf') options.dwarf = value();
        else if (arg === '--llvm-symbolizer') options.symbolizer = value();
        else if (arg === '--json') options.json = true;
        else if (arg === '-h' || arg === '--help') {
            console.log(usage());
            return 0;
        } else if (arg.startsWith('-') && arg !== '-') throw new UsageError(`unknown option ${arg}`);
        else if (options.input) throw new UsageError('more than one trace file');
        else options.input = arg;
    }
    if (!options.symbols && !options.wasm && !options.dwarf) {
        throw new UsageError('pass at least one of --dwarf, --symbols, --wasm');
    }

    const text = options.input && options.input !== '-' ? readFileSync(options.input, 'utf8') : readFileSync(0, 'utf8');
    const frames = parseTrace(text);

    /** @type {Map<number, string>} */
    const names = new Map();
    if (options.wasm) {
        for (const [index, name] of readNameSection(readFileSync(options.wasm))) names.set(index, name);
    }
    if (options.symbols) {
        // The symbol map is the release link's own: it wins over a name section.
        for (const [index, name] of parseSymbolMap(readFileSync(options.symbols, 'utf8'))) names.set(index, name);
    }

    /** @type {Map<number, ResolvedLocation[]>} */
    let dwarf = new Map();
    if (options.dwarf) {
        const symbolizer = findLlvmSymbolizer(options.symbolizer);
        if (!symbolizer) {
            throw new UsageError('--dwarf needs llvm-symbolizer: activate emsdk, or pass --llvm-symbolizer / set LLVM_SYMBOLIZER');
        }
        const offsets = frames.map((frame) => frame.offset).filter((offset) => offset !== null);
        if (offsets.length < frames.length) {
            console.error(`note: ${frames.length - offsets.length} frame(s) have no byte offset (Safari); DWARF cannot place them`);
        }
        // Paths inside this checkout print relative to it.
        const mapFile = (/** @type {string} */ file) => {
            const rel = isAbsolute(file) ? relative(options.root, file) : file;
            return rel && !rel.startsWith('..') ? rel : file;
        };
        dwarf = resolveDwarf(symbolizer, options.dwarf, /** @type {number[]} */ (offsets), mapFile);
    }

    const result = symbolizeTrace(text, { names, dwarf });
    if (options.json) {
        console.log(JSON.stringify(result.frames.map(({ text: _text, ...frame }) => frame), null, 2));
    } else {
        process.stdout.write(result.text.endsWith('\n') ? result.text : `${result.text}\n`);
    }
    if (frames.length > 0 && result.resolvedCount === 0) {
        console.error(`error: none of the ${frames.length} wasm frame(s) resolved; is the source from the link that produced this trace?`);
        return 1;
    }
    return 0;
}

class UsageError extends Error {}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main(process.argv.slice(2)).then((code) => {
        process.exitCode = code;
    }, (error) => {
        console.error(`symbolize_wasm_trace: ${error.message}`);
        process.exitCode = error instanceof UsageError ? 2 : 1;
    });
}
