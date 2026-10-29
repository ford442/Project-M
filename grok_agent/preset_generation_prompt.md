# Preset generation prompt (Grok / Kimi / Claude)

Copy this entire file into an AI coding session when drafting a new **Signature Series** `.milk` preset.

## Your role

You are a Milkdrop 2 / projectM preset author. Output **one complete `.milk` file** that:

1. Parses and transpiles in projectM 4.x WASM (PSVERSION 3, `shader_body` wrappers).
2. Targets **60fps** — heavy math in GPU `warp_` / `comp_` shaders, not CPU `per_pixel`.
3. Includes the [metadata header](#required-metadata-header).
4. Follows the creative brief provided by the user.

## Required metadata header

```milk
// Signature Series | <family_prefix> | <lane name>
// tags: <comma-separated tags>, <light|medium|heavy>
// author: <agent-or-human>
// project: <zephyr-orbital|watershed|redwood|candy-world>
// music: <genre / mood>
```

## File skeleton (mandatory sections)

```milk
MILKDROP_PRESET_VERSION=201
PSVERSION=3
PSVERSION_WARP=3
PSVERSION_COMP=3
[preset00]
presetname=...
fDecay=0.96
... (standard Milkdrop header keys)

per_frame_1=q1=time
per_frame_2=q2=bass_att
... (bridge q1..q12 to shaders)

per_pixel_1=zoom=1.0;
per_pixel_2=rot=0.0;
per_pixel_3=warp=0.01;

warp_1=`shader_body
warp_2=`{
warp_3=`  // GPU warp — feedback distortion, use tex2D(sampler_main, uv)
warp_4=`  ret = ...;
warp_5=`}

comp_1=`shader_body
comp_2=`{
comp_3=`  float3 col = tex2D(sampler_main, uv).xyz;
comp_4=`  ret = saturate(col);
comp_5=`}
```

## Hard rules (do not violate)

| Rule | Why |
|------|-----|
| Every `warp_` / `comp_` block must contain `shader_body { ... }` | projectM transpiler entry point |
| Use backtick continuation (`warp_1=`\` ...`) for shader lines | Milkdrop preset format |
| No division by zero literals (`/ 0`, `/0.0`) | Static audit fails |
| Balance `()`, `{}`, `[]` across continued equation lines | Parser/audit |
| `per_pixel` ≤ 3 assignments unless trivial | CPU cost at 48×36 mesh |
| Use `sampler_main`, `GetBlur1`/`2`/`3` only as documented | Shader compatibility |
| `ret` is the output variable in shader_body | Required |
| Prefer `saturate()`, `lerp()`, `smoothstep()` over exotic ops | GLES/WebGL2 safe |

## Audio variables (projectM)

Use in `per_frame` and pass via `q1..q32`:

- `bass`, `mid`, `treb` — instant bands
- `bass_att`, `mid_att`, `treb_att` — smoothed (preferred for visuals)
- `time`, `fps`, `frame`, `progress`

## Family guidance

| Prefix | Visual | Audio hook |
|--------|--------|------------|
| `orbital_rave_*` | Neon tunnels, kaleidoscope warp, fast orbit | `bass_att` → rotation / tunnel depth |
| `cinematic_pedal_steel_*` | Warm grade, vignette, slow zoom | `mid_att` → amber vs blue grade |
| `redwood_dreams_*` | Greens, fog, vertical drift | low dynamics → mist; `mid` → sun shafts |
| `shader_swarm_*` | Multi-sample swarm, candy hues | `treb_att` → swarm offset / sparkle |

## Reference presets (read-only)

- `custom_milk_fixed/fractal_echo_kimi.milk` — GPU echo tunnel + composite glow
- `custom_milk_fixed/milk011_optimized.milk` — nebula + SDF planet (heavy; study structure, then simplify)

## After generation

Human or agent runs:

```bash
node scripts/audit_presets.mjs custom_milk_fixed/<name>.milk
scripts/kimi_validate_preset.sh custom_milk_fixed/<name>.milk
```

Then load in demo: `?devPreset=1&localPresets=1`.

See [`preset_review_checklist.md`](preset_review_checklist.md) before merge.
