# Archive

Documents kept for the record and no longer maintained. Nothing here describes the code as it
is now; follow the links in the current docs instead. Last reviewed 2026-11-13. `git log --follow`
on a path shows its history from before it was moved here.

| Path | What it is | Why it is archived |
|---|---|---|
| [`html-REFACTORING_NOTES.md`](html-REFACTORING_NOTES.md) | Notes from the first split of the browser host page into `projectm-core.html` and modules (was `html/REFACTORING_NOTES.md`; moved 2026-11-13). | Last updated 2026-04-24. The host layer was restructured several times since, and the notes name `projectm-core.css`, which no longer exists. Current architecture: [`html/README.md`](../../html/README.md) and [`docs/HOST_LAYER.md`](../HOST_LAYER.md). |
| [`DETAILED_AUDIT_REPORT.md`](DETAILED_AUDIT_REPORT.md) | A point-in-time build and performance audit of the Emscripten build (2026-05-04). | Its findings were acted on or superseded. See [`EMSCRIPTEN.md`](../EMSCRIPTEN.md) and [`PERFORMANCE.md`](../PERFORMANCE.md). |
| [`DIAGNOSIS_MOD_FLAC_PLAYER_CONNECTION.md`](DIAGNOSIS_MOD_FLAC_PLAYER_CONNECTION.md) | Diagnosis of why the external MOD and FLAC players did not feed projectM reliably. | Both PCM bridges have since shipped (see `html/projectm-pcm-bridge.js` and [`AUDIO_PIPELINE.md`](../AUDIO_PIPELINE.md)), so the diagnosis is stale. |
| [`milkdrop2_vs_projectm_multipass.md`](milkdrop2_vs_projectm_multipass.md) | Comparison of how Milkdrop 2 and this engine do multi-pass transitions (2026-05-07). | Design input for work that has since landed. The live roadmap is [`option_b_milkdrop_parity.md`](../option_b_milkdrop_parity.md); shader reference: [`transition_shaders.md`](../transition_shaders.md). |
| [`authoring/`](authoring/) | Kimi CLI prompts and agent-swarm role prompts for authoring `.milk` presets and transition shaders. | Superseded by [`docs/agents/kimi_preset_authoring_plan.md`](../agents/kimi_preset_authoring_plan.md), which indexes them. |
| [`issues/`](issues/) | Two drafted GitHub issues for the external-player PCM bridges, ready to paste. | Both bridges have since shipped (see above). |
| [`patches/`](patches/) | A diff and an integration guide for the same two bridges. | Same reason: the bridges have since shipped. |

Reviewed on 2026-11-13 and deliberately **not** moved here:

- `docs/GRAPHICS_PERF_RECOVERY_PLAN.md`: a long log, but a script, a test library, a workflow and several source comments
  point at it, and into its "Hardware capture contract" section. It carries a status banner instead.
- `docs/option_b_milkdrop_parity.md`: a source comment (`TransitionShaderBuiltInTunnelGlsl330.frag`) and the agent prompts in
  `docs/agents/grok/` still use it as the transition roadmap. Its stale file paths were fixed in place.
