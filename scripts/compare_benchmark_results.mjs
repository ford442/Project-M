#!/usr/bin/env node
/**
 * Compares two frame-budget records and decides whether the head run regressed.
 *
 * The gate is relative: a preset fails when its p95 frame time is more than
 * `--max-regression-pct` above the base run's, and the absolute delta is large
 * enough to mean something. It never checks an absolute frame-time target —
 * see tests/wasm-smoke/lib/frame-budget.mjs for why.
 *
 * Usage:
 *   node scripts/compare_benchmark_results.mjs --base <base.json> --head <head.json>
 *   node scripts/compare_benchmark_results.mjs --base ... --head ... --markdown comment.md
 *   node scripts/compare_benchmark_results.mjs --base ... --head ... --max-regression-pct 10
 *
 * Exits 1 when the gate fails, 0 otherwise. Runs that are not comparable
 * (software GL, or two different runners) are printed and always exit 0 — a
 * gate that fires on incomparable numbers is a gate people turn off.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { compareBenchmarks, formatMarkdownTable } from '../tests/wasm-smoke/lib/frame-budget.mjs';

function parseArgs(argv) {
    const options = {
        base: null,
        head: null,
        markdown: null,
        maxRegressionPct: 15,
        minAbsoluteDeltaMs: 0.5,
        includeUnchanged: false,
    };
    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--base') options.base = resolve(argv[++i]);
        else if (arg === '--head') options.head = resolve(argv[++i]);
        else if (arg === '--markdown') options.markdown = resolve(argv[++i]);
        else if (arg === '--max-regression-pct') options.maxRegressionPct = Number(argv[++i]);
        else if (arg === '--min-absolute-delta-ms') options.minAbsoluteDeltaMs = Number(argv[++i]);
        else if (arg === '--include-unchanged') options.includeUnchanged = true;
        else {
            console.error(`Unknown argument: ${arg}`);
            process.exit(2);
        }
    }
    if (!options.base || !options.head) {
        console.error('Both --base and --head are required.');
        process.exit(2);
    }
    return options;
}

const options = parseArgs(process.argv);
for (const [label, path] of [['base', options.base], ['head', options.head]]) {
    if (!existsSync(path)) {
        console.error(`No ${label} record at ${path}`);
        process.exit(2);
    }
}

const base = JSON.parse(readFileSync(options.base, 'utf8'));
const head = JSON.parse(readFileSync(options.head, 'utf8'));

const comparison = compareBenchmarks(base, head, {
    maxRegressionPct: options.maxRegressionPct,
    minAbsoluteDeltaMs: options.minAbsoluteDeltaMs,
});

const markdown = formatMarkdownTable(comparison, {
    includeUnchanged: options.includeUnchanged,
    title: `Frame budget (p95) — ${String(base.commit).slice(0, 8)} → ${String(head.commit).slice(0, 8)}`,
});

console.log(markdown);
if (options.markdown) {
    writeFileSync(options.markdown, markdown + '\n');
    console.log(`\nWrote ${options.markdown}`);
}

process.exit(comparison.pass ? 0 : 1);
