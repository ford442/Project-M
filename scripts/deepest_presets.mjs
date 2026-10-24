#!/usr/bin/env node
// Lists the presets whose code nests deepest, for the stack-overflow CI leg.
//
// The preset prepare thread parses equations (projectM-eval) and transpiles
// shaders (hlslparser's recursive-descent parser) on a pthread stack
// (DEFAULT_PTHREAD_STACK_SIZE, cmake/EmscriptenWasmFlags.cmake). Both recurse
// once per nesting level of (), [] and {}, so the presets that nest deepest are
// the ones that find out whether that stack is big enough. build_emscripten.yml
// loads these into the -sSTACK_OVERFLOW_CHECK=2 link (scripts/build_wasm.sh --debug).
//
// Usage:
//   node scripts/deepest_presets.mjs [--top N] [--exclude name,name] [--verbose] [dir...]
//
// Prints a comma-separated list of repo-relative .milk paths (the form
// scripts/capture_custom_milk_screenshots.mjs --presets takes). Default dirs:
// tests/libprojectM/data/PresetPrepare (prepare-deep-nesting.milk, the
// deliberate worst case), presets/tests and custom_milk_fixed.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Maximum bracket nesting depth of one block of code; comments are skipped. */
export function nestingDepth(code) {
    let depth = 0;
    let max = 0;
    for (const line of code.split('\n')) {
        const text = line.replace(/\/\/.*$/, '');
        for (const ch of text) {
            if (ch === '(' || ch === '[' || ch === '{') {
                depth++;
                if (depth > max) max = depth;
            } else if ((ch === ')' || ch === ']' || ch === '}') && depth > 0) {
                depth--;
            }
        }
    }
    return max;
}

/**
 * Deepest block of a preset: per_frame_, per_pixel_, warp_, comp_, and each
 * shape/wave's equations, each joined in line order as the parser sees them.
 */
export function presetDepth(text) {
    const blocks = new Map();
    for (const line of text.split(/\r?\n/)) {
        const match = /^([A-Za-z_]+?(?:\d+_[A-Za-z_]+?)?)_?(\d+)=(.*)$/.exec(line);
        if (!match) continue;
        const [, prefix, , code] = match;
        const shaderLine = prefix === 'warp' || prefix === 'comp';
        // Shader lines keep a leading backtick in some writers.
        const body = shaderLine ? code.replace(/^`/, '') : code;
        blocks.set(prefix, `${blocks.get(prefix) ?? ''}${body}\n`);
    }
    let max = 0;
    for (const code of blocks.values()) {
        max = Math.max(max, nestingDepth(code));
    }
    return max;
}

function parseArgs(argv) {
    const opts = { top: 4, exclude: new Set(), verbose: false, dirs: [] };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--top') opts.top = Number(argv[++i]);
        else if (arg === '--exclude') for (const name of argv[++i].split(',')) opts.exclude.add(name.trim());
        else if (arg === '--verbose') opts.verbose = true;
        else opts.dirs.push(resolve(arg));
    }
    if (opts.dirs.length === 0) {
        opts.dirs = [
            join(root, 'tests', 'libprojectM', 'data', 'PresetPrepare'),
            join(root, 'presets', 'tests'),
            join(root, 'custom_milk_fixed'),
        ];
    }
    return opts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const opts = parseArgs(process.argv);
    const ranked = [];
    for (const dir of opts.dirs) {
        if (!existsSync(dir)) continue;
        for (const name of readdirSync(dir)) {
            if (!name.endsWith('.milk') || opts.exclude.has(basename(name, '.milk'))) continue;
            const path = join(dir, name);
            ranked.push({ path: relative(root, path), depth: presetDepth(readFileSync(path, 'latin1')) });
        }
    }
    ranked.sort((a, b) => b.depth - a.depth || a.path.localeCompare(b.path));
    const picked = ranked.slice(0, opts.top);
    if (opts.verbose) {
        for (const { path, depth } of picked) console.error(`${depth}\t${path}`);
    }
    console.log(picked.map(({ path }) => path).join(','));
}
