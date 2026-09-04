/**
 * Frame-budget bookkeeping: summarise per-frame samples, and compare a head
 * run against a base run to decide whether a change regressed the frame budget.
 *
 * The gate is **relative and one-sided**. Absolute thresholds ("p95 must be
 * under 16.6 ms") do not survive contact with CI: a shared runner's numbers
 * move by more than the effects being measured, so an absolute gate is red on
 * arrival and disabled by the end of the month. Comparing head against base
 * measured on the same runner in the same job cancels most of that.
 *
 * Two further guards against flapping:
 *
 *   * `minAbsoluteDeltaMs` — a percentage on a sub-millisecond number is noise.
 *     A preset that goes 0.30 → 0.36 ms is +20% and means nothing.
 *   * p95, not mean — the mean hides the stalls that make a visualizer look
 *     broken, and p99 on a few hundred frames is one sample.
 *
 * Every function here is pure and unit-tested (tests/graphics-harness/), because
 * this is the part of the harness that decides whether a PR is red.
 */

/** Current shape of the JSON written to benchmark-results/. */
export const BENCHMARK_SCHEMA = 'projectm.frame-budget/1';

/**
 * Nearest-rank percentile over an unsorted sample.
 *
 * Nearest-rank (rather than interpolated) so a reported p95 is always a frame
 * that actually happened.
 *
 * @param {number[]} values
 * @param {number} p 0..1
 * @returns {number}
 */
export function percentile(values, p) {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const rank = Math.ceil(p * sorted.length);
    const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
    return sorted[index];
}

/**
 * @typedef {object} SampleSummary
 * @property {number} count
 * @property {number} mean
 * @property {number} min
 * @property {number} p50
 * @property {number} p95
 * @property {number} p99
 * @property {number} max
 */

/**
 * @param {number[]} values
 * @returns {SampleSummary}
 */
export function summarize(values) {
    const clean = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
    if (clean.length === 0) {
        return { count: 0, mean: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    }
    const sorted = [...clean].sort((a, b) => a - b);
    return {
        count: sorted.length,
        mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
        min: sorted[0],
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
        max: sorted[sorted.length - 1],
    };
}

/**
 * @typedef {object} PresetBudget
 * @property {string} preset
 * @property {SampleSummary} frameMs Wall-clock frame time.
 * @property {SampleSummary} [gpuMs] EXT_disjoint_timer_query_webgl2, when available.
 * @property {number} [heapBytesPeak]
 * @property {number} [governorTier] Quality tier the governor settled on.
 */

/**
 * @typedef {object} BenchmarkRecord
 * @property {string} schema
 * @property {string} commit
 * @property {string} [branch]
 * @property {string} [runner] Free-form runner identity — GPU perf numbers are
 *   only comparable within one runner, so this travels with the data.
 * @property {string} [gpu]
 * @property {boolean} softwareGl Whether this ran on a software rasterizer. Such
 *   a run's timings are not a perf measurement and must not gate.
 * @property {string} capturedAt ISO timestamp.
 * @property {PresetBudget[]} presets
 */

/**
 * @param {Partial<BenchmarkRecord> & { commit: string, presets: PresetBudget[] }} fields
 * @returns {BenchmarkRecord}
 */
export function buildBenchmarkRecord(fields) {
    return {
        schema: BENCHMARK_SCHEMA,
        capturedAt: new Date().toISOString(),
        softwareGl: false,
        ...fields,
    };
}

/**
 * @typedef {object} BudgetRow
 * @property {string} preset
 * @property {number | null} baseP95Ms
 * @property {number | null} headP95Ms
 * @property {number | null} deltaMs
 * @property {number | null} deltaPct
 * @property {'regressed' | 'improved' | 'unchanged' | 'new' | 'missing'} status
 */

/**
 * @typedef {object} BudgetComparison
 * @property {boolean} pass
 * @property {BudgetRow[]} rows
 * @property {string[]} notes Things a reader must know to read the table right.
 * @property {number} maxRegressionPct
 */

/**
 * Compares two benchmark records preset by preset.
 *
 * @param {BenchmarkRecord} base
 * @param {BenchmarkRecord} head
 * @param {object} [options]
 * @param {number} [options.maxRegressionPct] p95 regression that fails the gate.
 * @param {number} [options.minAbsoluteDeltaMs] Deltas below this are called
 *   unchanged whatever the percentage.
 * @returns {BudgetComparison}
 */
export function compareBenchmarks(base, head, {
    maxRegressionPct = 15,
    minAbsoluteDeltaMs = 0.5,
} = {}) {
    const notes = [];
    const baseByPreset = new Map((base?.presets ?? []).map((p) => [p.preset, p]));
    const headByPreset = new Map((head?.presets ?? []).map((p) => [p.preset, p]));

    if (base?.softwareGl || head?.softwareGl) {
        notes.push(
            'One or both runs used a software rasterizer. Timings from software GL are not a '
            + 'performance measurement; this comparison is reported but never gates.',
        );
    }
    if (base?.runner && head?.runner && base.runner !== head.runner) {
        notes.push(
            `Base ran on "${base.runner}" and head on "${head.runner}". Cross-runner timings are `
            + 'not comparable; this comparison is reported but never gates.',
        );
    }

    const gateable = !(base?.softwareGl || head?.softwareGl)
        && !(base?.runner && head?.runner && base.runner !== head.runner);

    /** @type {BudgetRow[]} */
    const rows = [];
    const presets = new Set([...baseByPreset.keys(), ...headByPreset.keys()]);

    for (const preset of [...presets].sort()) {
        const basePreset = baseByPreset.get(preset);
        const headPreset = headByPreset.get(preset);
        const baseP95Ms = basePreset ? basePreset.frameMs.p95 : null;
        const headP95Ms = headPreset ? headPreset.frameMs.p95 : null;

        if (baseP95Ms === null || headP95Ms === null) {
            rows.push({
                preset,
                baseP95Ms,
                headP95Ms,
                deltaMs: null,
                deltaPct: null,
                status: headP95Ms === null ? 'missing' : 'new',
            });
            continue;
        }

        const deltaMs = headP95Ms - baseP95Ms;
        const deltaPct = baseP95Ms > 0 ? (deltaMs / baseP95Ms) * 100 : 0;
        let status = 'unchanged';
        if (Math.abs(deltaMs) >= minAbsoluteDeltaMs) {
            if (deltaPct > maxRegressionPct) status = 'regressed';
            else if (deltaPct < -maxRegressionPct) status = 'improved';
        }
        rows.push({ preset, baseP95Ms, headP95Ms, deltaMs, deltaPct, status });
    }

    const regressions = rows.filter((row) => row.status === 'regressed');
    const maxRegressionPct_ = rows.reduce(
        (worst, row) => (row.deltaPct !== null && row.deltaPct > worst ? row.deltaPct : worst),
        0,
    );

    if (rows.some((row) => row.status === 'missing')) {
        notes.push('Presets marked `missing` are in the base run but absent from head — check the preset set, not the renderer.');
    }

    return {
        pass: gateable ? regressions.length === 0 : true,
        rows,
        notes,
        maxRegressionPct: maxRegressionPct_,
    };
}

const STATUS_MARK = {
    regressed: '🔴',
    improved: '🟢',
    unchanged: '·',
    new: '🆕',
    missing: '⚠️',
};

function formatMs(value) {
    return value === null ? '—' : `${value.toFixed(2)} ms`;
}

function formatPct(value) {
    if (value === null) return '—';
    const sign = value > 0 ? '+' : '';
    return `${sign}${value.toFixed(1)}%`;
}

/**
 * Renders a comparison as a Markdown table for a PR comment.
 *
 * Unchanged rows are collapsed into a trailing count by default: a reviewer
 * needs the presets that moved, and a 30-row table of `·` buries them.
 *
 * @param {BudgetComparison} comparison
 * @param {object} [options]
 * @param {boolean} [options.includeUnchanged]
 * @param {string} [options.title]
 * @returns {string}
 */
export function formatMarkdownTable(comparison, { includeUnchanged = false, title = 'Frame budget (p95)' } = {}) {
    const moved = comparison.rows.filter((row) => row.status !== 'unchanged');
    const shown = includeUnchanged ? comparison.rows : moved;
    const unchangedCount = comparison.rows.length - moved.length;

    const lines = [`### ${title}`, ''];

    if (shown.length === 0) {
        lines.push(`No preset moved by more than the gate's threshold (${comparison.rows.length} compared).`);
    } else {
        lines.push('| | Preset | Base p95 | Head p95 | Δ | Δ% |');
        lines.push('|---|---|---:|---:|---:|---:|');
        for (const row of shown) {
            lines.push(
                `| ${STATUS_MARK[row.status] ?? ''} | \`${row.preset}\` | ${formatMs(row.baseP95Ms)} `
                + `| ${formatMs(row.headP95Ms)} | ${formatMs(row.deltaMs)} | ${formatPct(row.deltaPct)} |`,
            );
        }
        if (!includeUnchanged && unchangedCount > 0) {
            lines.push('');
            lines.push(`_${unchangedCount} preset(s) unchanged, not listed._`);
        }
    }

    if (comparison.notes.length > 0) {
        lines.push('');
        for (const note of comparison.notes) lines.push(`> ${note}`);
    }

    lines.push('');
    lines.push(comparison.pass
        ? '**Result: pass.**'
        : '**Result: fail — a preset regressed past the frame-budget threshold.**');

    return lines.join('\n');
}
