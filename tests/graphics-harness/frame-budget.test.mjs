import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    GPU_STAGES, buildBenchmarkRecord, compareBenchmarks, formatGpuStageTable, formatMarkdownTable, percentile, summarize,
} from '../wasm-smoke/lib/frame-budget.mjs';

function record(presets, extra = {}) {
    return buildBenchmarkRecord({
        commit: 'deadbeef',
        presets: presets.map(([preset, p95]) => ({
            preset,
            frameMs: { count: 300, mean: p95 * 0.8, min: p95 * 0.5, p50: p95 * 0.8, p95, p99: p95 * 1.1, max: p95 * 1.4 },
        })),
        ...extra,
    });
}

test('percentile uses nearest rank, so it reports a real sample', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.equal(percentile(values, 0.5), 5);
    assert.equal(percentile(values, 0.95), 10);
    assert.equal(percentile(values, 1), 10);
    assert.equal(percentile([], 0.95), 0);
});

test('summarize ignores non-finite samples instead of poisoning the mean', () => {
    const summary = summarize([10, 20, NaN, 30, Infinity, undefined]);
    assert.equal(summary.count, 3);
    assert.equal(summary.mean, 20);
    assert.equal(summary.min, 10);
    assert.equal(summary.max, 30);
});

test('a p95 regression past the threshold fails the gate', () => {
    const comparison = compareBenchmarks(
        record([['a.milk', 10]]),
        record([['a.milk', 12]]),
        { maxRegressionPct: 15 },
    );
    assert.equal(comparison.pass, false);
    assert.equal(comparison.rows[0].status, 'regressed');
    assert.ok(comparison.rows[0].deltaPct > 15);
});

test('a regression inside the threshold passes', () => {
    const comparison = compareBenchmarks(record([['a.milk', 10]]), record([['a.milk', 11]]));
    assert.equal(comparison.pass, true);
    assert.equal(comparison.rows[0].status, 'unchanged');
});

test('a large percentage on a tiny absolute delta does not gate', () => {
    // 0.30 -> 0.36 ms is +20% and means nothing on a CI runner.
    const comparison = compareBenchmarks(record([['a.milk', 0.30]]), record([['a.milk', 0.36]]));
    assert.equal(comparison.pass, true);
    assert.equal(comparison.rows[0].status, 'unchanged');
});

test('software-GL runs are reported but never gate', () => {
    const comparison = compareBenchmarks(
        record([['a.milk', 10]], { softwareGl: true }),
        record([['a.milk', 40]], { softwareGl: true }),
    );
    assert.equal(comparison.pass, true, 'software GL timings must not fail a PR');
    assert.equal(comparison.rows[0].status, 'regressed', 'still reported');
    assert.match(comparison.notes.join(' '), /software rasterizer/);
});

test('cross-runner comparisons are reported but never gate', () => {
    const comparison = compareBenchmarks(
        record([['a.milk', 10]], { runner: 'gpu-box-1' }),
        record([['a.milk', 40]], { runner: 'gpu-box-2' }),
    );
    assert.equal(comparison.pass, true);
    assert.match(comparison.notes.join(' '), /not comparable/);
});

test('presets added or dropped are labelled, not scored', () => {
    const comparison = compareBenchmarks(
        record([['a.milk', 10], ['gone.milk', 10]]),
        record([['a.milk', 10], ['new.milk', 99]]),
    );
    const byPreset = Object.fromEntries(comparison.rows.map((row) => [row.preset, row.status]));
    assert.equal(byPreset['new.milk'], 'new');
    assert.equal(byPreset['gone.milk'], 'missing');
    assert.equal(comparison.pass, true);
});

test('an improvement is flagged as such', () => {
    const comparison = compareBenchmarks(record([['a.milk', 20]]), record([['a.milk', 10]]));
    assert.equal(comparison.rows[0].status, 'improved');
    assert.equal(comparison.pass, true);
});

test('the markdown table names the presets that moved and the verdict', () => {
    const comparison = compareBenchmarks(
        record([['warp.milk', 10], ['steady.milk', 5]]),
        record([['warp.milk', 14], ['steady.milk', 5]]),
    );
    const table = formatMarkdownTable(comparison);
    assert.match(table, /warp\.milk/);
    assert.doesNotMatch(table, /steady\.milk/, 'unchanged rows are collapsed');
    assert.match(table, /1 preset\(s\) unchanged/);
    assert.match(table, /\*\*Result: fail/);
    assert.match(formatMarkdownTable(comparison, { includeUnchanged: true }), /steady\.milk/);
});

test('an all-clear comparison says so instead of printing an empty table', () => {
    const table = formatMarkdownTable(compareBenchmarks(record([['a.milk', 10]]), record([['a.milk', 10]])));
    assert.match(table, /No preset moved/);
    assert.match(table, /\*\*Result: pass/);
});

// ---- Per-stage GPU breakdown -----------------------------------------------------

/** @param {number} p50 */
const stat = (p50) => ({ count: 10, mean: p50, min: p50, p50, p95: p50, p99: p50, max: p50 });

test('the stage table puts the copies beside the CPU per-pixel bucket and as a share of GPU time', () => {
    const head = buildBenchmarkRecord({
        commit: 'cafef00d',
        presets: [
            {
                preset: '/presets/tests/110-per_pixel.milk',
                label: 'no composite shader (old-school)',
                category: 'no-composite',
                frameMs: stat(8),
                gpuMs: stat(4),
                gpuStagesMs: { warp: stat(1), blur: stat(0.5), copy: stat(1), composite: stat(1), present: stat(0.5) },
                perPixelEvalMs: stat(3),
            },
            {
                preset: '/custom_milk_fixed/milk015.milk',
                category: 'dual-fbo-cut',
                mode: 'crossfade',
                frameMs: stat(9),
                gpuMs: stat(6),
                gpuStagesMs: { copy: stat(0.3) },
            },
            // No timer extension on this one: no stage map, so no row.
            { preset: '/presets/tests/000-empty.milk', frameMs: stat(2) },
        ],
    });

    const table = formatGpuStageTable(head);
    const lines = table.split('\n');
    assert.match(lines[2], /\| GPU total \| warp \| blur \| shapes \| copy \| composite \| present \| other \| copy \/ GPU \| CPU per-pixel \|/);
    const oldSchool = lines.find((line) => line.includes('no composite shader'));
    // 1 ms of copies in a 4 ms GPU frame, next to 3 ms of CPU per-pixel work.
    assert.match(oldSchool, /\| no-composite \| 4\.00 \| 1\.00 \| 0\.50 \| — \| 1\.00 \| 1\.00 \| 0\.50 \| — \| 25\.0% \| 3\.00 \|$/);
    const cut = lines.find((line) => line.includes('milk015'));
    assert.match(cut, /dual-fbo-cut, crossfade/);
    assert.match(cut, /\| 5\.0% \| — \|$/);
    assert.equal(lines.some((line) => line.includes('000-empty')), false);
});

test('a record without stage timings says why instead of printing an empty table', () => {
    const table = formatGpuStageTable(record([['a.milk', 10]]));
    assert.match(table, /No per-stage GPU timings in this record/);
    assert.equal(GPU_STAGES.length, 7, 'one per projectm_perf_gpu_stage');
});
