# benchmark-results/

One JSON record per commit, written by `scripts/record_frame_budget.mjs` and
read by `scripts/compare_benchmark_results.mjs`. These records are the history
the frame-budget gate compares against, so they are **committed**, not scratch —
see `docs/GRAPHICS_BENCHMARK_HARNESS.md`.

| File | Committed? | What |
|---|---|---|
| `<sha>.json` | yes | Frame-budget record for that commit: per-preset p50/p95/p99, GPU time where the timer query is available, governor tier, and the provenance (runner, renderer string, `softwareGl`) that decides whether two records may be compared at all |
| `preset-benchmark.json` | no | Raw output of `scripts/benchmark_presets_wasm.mjs`, the input to the record |
| `preset-benchmark-native.json` | no | Same, from the native benchmark |
| `frame-budget-comparison.md` | no | Rendered comparison table for a run's step summary |
| `golden/` | no | Golden-gate report and failure triptychs |

A record with `"softwareGl": true` came off a runner that fell back to a
software rasterizer. It is kept for provenance, and `compare_benchmark_results.mjs`
reports it but refuses to gate on it: SwiftShader frame times are not a
performance measurement. The nightly workflow skips such records when it picks a
base, so a software run cannot silently turn the gate off.
