#!/usr/bin/env node
/**
 * Normalises a benchmark run into a per-commit frame-budget record.
 *
 * `scripts/benchmark_presets_wasm.mjs` produces a rich, run-shaped JSON blob.
 * What the regression gate needs is narrower and must stay stable over time:
 * one p50/p95/p99 per preset, the commit it came from, and enough provenance to
 * know whether two records may be compared at all (same runner? real GPU?).
 * This script is that projection, kept separate so the benchmark page can keep
 * evolving without breaking the gate's on-disk format.
 *
 * Usage:
 *   node scripts/record_frame_budget.mjs --input benchmark-results/preset-benchmark.json
 *   node scripts/record_frame_budget.mjs --input <json> --out benchmark-results/<sha>.json
 *   node scripts/record_frame_budget.mjs --input <json> --runner gpu-box-1 --gpu "RTX 4070"
 *
 * Defaults `--out` to benchmark-results/<commit>.json, which is how the
 * directory accumulates one record per commit.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildBenchmarkRecord } from '../tests/wasm-smoke/lib/frame-budget.mjs';
import { detectRepoRoot } from '../tests/wasm-smoke/lib/harness-runtime.mjs';

const root = resolve(process.env.PROJECTM_ROOT || detectRepoRoot(dirname(fileURLToPath(import.meta.url))));

function gitCommit() {
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    } catch (_) {
        return 'unknown';
    }
}

function gitBranch() {
    try {
        return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    } catch (_) {
        return null;
    }
}

function parseArgs(argv) {
    const options = {
        input: join(root, 'benchmark-results/preset-benchmark.json'),
        out: null,
        commit: null,
        branch: null,
        runner: process.env.PROJECTM_BENCH_RUNNER ?? null,
        gpu: null,
        softwareGl: null,
    };
    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--input') options.input = resolve(argv[++i]);
        else if (arg === '--out') options.out = resolve(argv[++i]);
        else if (arg === '--commit') options.commit = argv[++i];
        else if (arg === '--branch') options.branch = argv[++i];
        else if (arg === '--runner') options.runner = argv[++i];
        else if (arg === '--gpu') options.gpu = argv[++i];
        else if (arg === '--software-gl') options.softwareGl = true;
        else {
            console.error(`Unknown argument: ${arg}`);
            process.exit(2);
        }
    }
    return options;
}

const options = parseArgs(process.argv);
if (!existsSync(options.input)) {
    console.error(`Benchmark input not found: ${options.input}\nRun scripts/benchmark_presets_wasm.mjs first.`);
    process.exit(1);
}

const raw = JSON.parse(readFileSync(options.input, 'utf8'));
if (!raw.ok) {
    console.error(`Benchmark run did not succeed: ${raw.error ?? 'unknown error'}`);
    process.exit(1);
}

const commit = options.commit ?? gitCommit();
// Trust the page's own renderer probe over a flag: a run mislabelled as GPU
// would let SwiftShader timings gate a PR.
const softwareGl = options.softwareGl ?? Boolean(raw.gl?.softwareGl);

const presets = (raw.presets ?? []).map((preset) => {
    const frameMs = preset.totalMs ?? {};
    const gpuMs = preset.breakdownMs?.gpuMs;
    return {
        preset: preset.presetUrl ?? preset.preset,
        frameMs: {
            count: frameMs.count ?? preset.frames ?? 0,
            mean: frameMs.mean ?? 0,
            min: frameMs.min ?? 0,
            p50: frameMs.p50 ?? frameMs.median ?? 0,
            p95: frameMs.p95 ?? 0,
            // Older benchmark.html builds have no p99; p95 is the honest
            // stand-in, and the gate reads p95 anyway.
            p99: frameMs.p99 ?? frameMs.p95 ?? 0,
            max: frameMs.max ?? 0,
        },
        ...(gpuMs ? { gpuMs } : {}),
        ...(preset.governorTier === null || preset.governorTier === undefined
            ? {} : { governorTier: preset.governorTier }),
    };
});

if (presets.length === 0) {
    console.error('Benchmark run contains no presets; refusing to write an empty record.');
    process.exit(1);
}

const record = buildBenchmarkRecord({
    commit,
    branch: options.branch ?? gitBranch(),
    runner: options.runner,
    gpu: options.gpu ?? raw.gl?.renderer ?? null,
    softwareGl,
    source: {
        input: options.input.slice(root.length + 1),
        canvas: raw.canvas ?? null,
        framesPerPreset: raw.framesPerPreset ?? null,
        audioLoad: raw.audioLoad ?? null,
        openmp: raw.openmp ?? null,
    },
    presets,
});

const outPath = options.out ?? join(root, 'benchmark-results', `${commit}.json`);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(record, null, 2) + '\n');

console.log(`Wrote ${outPath}`);
console.log(`  commit     ${record.commit}${record.branch ? ` (${record.branch})` : ''}`);
console.log(`  runner     ${record.runner ?? 'unidentified'}${record.gpu ? ` — ${record.gpu}` : ''}`);
console.log(`  software   ${record.softwareGl ? 'yes — these timings must never gate' : 'no'}`);
console.log(`  presets    ${record.presets.length}`);
