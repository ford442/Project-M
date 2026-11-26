#!/usr/bin/env bash
# Renders every preset of the corpora with projectm-render and prints one hash per preset
# and render-path variant, for before/after comparisons of renderer changes that must be
# bit-identical (docs/RENDER_DEVICE.md "Equivalence").
#
#   scripts/render_hash_corpus.sh <projectm-render> <out-file> [preset-dir...]
#
# Default dirs: presets/tests presets/custom presets/weeks. Each preset renders
# RENDER_HASH_SECONDS (default 0.3) of tests/tools/data/beat-10s.flac at
# RENDER_HASH_SIZE (default 256x192), 30 fps, seed 1, once per variant:
#   default     the default render paths
#   copypaths   PROJECTM_COPY_SHADER_PATH=1 PROJECTM_BLUR_COPY_PATH=1
#   cpu         PROJECTM_PER_PIXEL_EVAL=cpu
#   transition  a soft cut from each preset to the next one in the list (projectm-render --then),
#               rendered for twice as long
# Compare two runs with: diff <(sort a) <(sort b)
set -euo pipefail

tool=${1:?usage: render_hash_corpus.sh <projectm-render> <out-file> [preset-dir...]}
out=${2:?usage: render_hash_corpus.sh <projectm-render> <out-file> [preset-dir...]}
shift 2
root=$(cd "$(dirname "$0")/.." && pwd)
dirs=("$@")
if [ ${#dirs[@]} -eq 0 ]; then
    dirs=("$root/presets/tests" "$root/presets/custom" "$root/presets/weeks")
fi
size=${RENDER_HASH_SIZE:-256x192}
seconds=${RENDER_HASH_SECONDS:-0.3}
jobs=${RENDER_HASH_JOBS:-$(nproc)}
audio="$root/tests/tools/data/beat-10s.flac"
variants=${RENDER_HASH_VARIANTS:-"default copypaths cpu transition"}

export tool size seconds audio
render_one() {
    local variant preset then
    IFS=$'\t' read -r variant preset then <<<"$1"
    local -a env=() extra=()
    local length=$seconds
    case $variant in
        copypaths) env=(PROJECTM_COPY_SHADER_PATH=1 PROJECTM_BLUR_COPY_PATH=1) ;;
        cpu) env=(PROJECTM_PER_PIXEL_EVAL=cpu) ;;
        transition)
            extra=(--then "$then")
            length=$(awk "BEGIN { print 2 * $seconds }")
            ;;
    esac
    local result
    result=$(env "${env[@]}" "$tool" --preset "$preset" "${extra[@]}" --audio "$audio" --duration "$length" \
        --width "${size%x*}" --height "${size#*x}" --fps 30 --seed 1 \
        --texture-path "$(dirname "$preset")" --hash 2>&1 | grep -o 'fnv1a64 [0-9a-f]*' || echo "failed")
    echo "$variant $preset${then:+ -> $then} $result"
}
export -f render_one

list=$(find "${dirs[@]}" -maxdepth 1 -name '*.milk' | sort)
for variant in $variants; do
    if [ "$variant" = transition ]; then
        paste <(echo "$list") <(echo "$list" | tail -n +2; echo "$list" | head -n 1) | sed "s|^|$variant\t|"
    else
        echo "$list" | sed "s|^|$variant\t|"
    fi
done | xargs -d '\n' -P "$jobs" -n 1 bash -c 'render_one "$0"' | sed "s|$root/||g" | sort > "$out"
echo "$(wc -l < "$out") renders, $(grep -c failed "$out" || true) failed -> $out"
