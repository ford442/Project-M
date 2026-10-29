#!/bin/bash
# ================================================
# kimi_upgrade_preset.sh
#
# Generates a ready-to-run Kimi CLI prompt for upgrading a legacy .milk preset to be
# WASM-safe and HLSL-9 compliant, embedding the "10 Most Frequent Errors" pitfall
# checklist from docs/WRITING_NEW_MILK_PRESETS_GUIDE.md section 9 so the agent
# self-checks its own edits before handing back.
#
# This script does NOT invoke Kimi itself — it prints (or writes) the prompt text so it
# can be reviewed, piped into `kimi`, or copy-pasted. After Kimi finishes, validate the
# result with scripts/kimi_validate_preset.sh.
#
# Usage:
#   scripts/kimi_upgrade_preset.sh <preset.milk> [<output-prompt-file>]
#
# Examples:
#   scripts/kimi_upgrade_preset.sh custom_milk_fixed/milk011.milk
#   scripts/kimi_upgrade_preset.sh weeks_presets/old_swirl.milk /tmp/kimi_prompt.txt
#   scripts/kimi_upgrade_preset.sh custom_milk_fixed/milk011.milk | kimi
#
# See also: docs/kimi_preset_authoring_plan.md (Kimi CLI runbook),
# docs/WRITING_NEW_MILK_PRESETS_GUIDE.md section 9 (pitfalls checklist).
# ================================================

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRESET_FILE="${1:-}"
OUT_FILE="${2:-}"

if [ -z "${PRESET_FILE}" ]; then
    echo "usage: $(basename "$0") <preset.milk> [<output-prompt-file>]" >&2
    exit 2
fi

if [ ! -f "${PRESET_FILE}" ]; then
    echo "error: preset file '${PRESET_FILE}' does not exist" >&2
    exit 2
fi

REL_PRESET="${PRESET_FILE}"
case "${REL_PRESET}" in
    "${PROJECT_ROOT}"/*) REL_PRESET="${REL_PRESET#"${PROJECT_ROOT}"/}" ;;
esac

PROMPT=$(cat <<EOF
You are upgrading the legacy MilkDrop preset "${REL_PRESET}" to be WASM-safe and
HLSL-9 compliant for the projectM-visualizer fork (see AGENTS.md and
docs/WRITING_NEW_MILK_PRESETS_GUIDE.md). Apply the "old -> WASM-safe" upgrade rubric
from docs/kimi_preset_authoring_plan.md section 6, then self-check your edit against
the Common Pitfalls Checklist (docs/WRITING_NEW_MILK_PRESETS_GUIDE.md section 9 - The
10 Most Frequent Errors) before finishing:

  1. Missing numeric index: warp_N/comp_N (and shapecode/wavecode/shape/wave blocks)
     must be a contiguous sequence starting at 1, with no gaps.
  2. Every shader line must start with a backtick (\`), no leading spaces.
  3. Do not redeclare built-in variables/aliases (e.g. uv_orig) - use them directly.
  4. Match HLSL types exactly; swizzle (.xyz) when assigning float4 -> float3.
  5. Initialize every q1-q32 you read in per_frame or per_frame_init before use.
  6. Every sampler_<name> reference must have a matching shapecode_N_image (or use a
     built-in sampler) - no dangling samplers.
  7. Keep the file under 1 MiB; factor large shader logic into helper functions.
  8. Ensure the file is plain UTF-8 text with no embedded null bytes.
  9. Guard divisions and pow(x, negative) against x near zero (NaN risk).
 10. Every comp_N (composite) shader chain must end with: ret = saturate(ret);

Also convert any remaining GLSL syntax to HLSL-9 (vecN -> floatN, mix -> lerp,
fract -> frac, mod -> fmod), remove #include/Texture2D/dynamic loops, and use
GetBlur1()/GetBlur2()/GetBlur3() for blur sampling per
docs/WRITING_NEW_MILK_PRESETS_GUIDE.md section 4.

When done, run:
  scripts/kimi_validate_preset.sh ${REL_PRESET}
and report PASS/FAIL plus a one-line summary of what changed, per
docs/kimi_preset_authoring_plan.md section 9 (Deliverables for each Kimi session).
EOF
)

if [ -n "${OUT_FILE}" ]; then
    printf '%s\n' "${PROMPT}" > "${OUT_FILE}"
    echo "Wrote Kimi upgrade prompt to ${OUT_FILE}" >&2
else
    printf '%s\n' "${PROMPT}"
fi
