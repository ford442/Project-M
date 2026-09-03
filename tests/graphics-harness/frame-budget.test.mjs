import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    buildBenchmarkRecord, compareBenchmarks, formatMarkdownTable, percentile, summarize,
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
