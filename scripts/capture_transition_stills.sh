#!/usr/bin/env bash
# Renders the Shatter and StarWipe transitions over two patterned stand-in presets and writes
# docs/images/transitions/{shatter,starwipe}.gif plus a five-frame strip of each (.png).
#
#   scripts/capture_transition_stills.sh [<build-dir>]   (default: cmake-build)
#
# Needs a build with BUILD_TESTING=ON (projectM-unittest), a display or xvfb-run, and ffmpeg.
# The frames come from TransitionLooksTest.DumpStills (tests/libprojectM/TransitionLooksTest.cpp).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build="${1:-$root/cmake-build}"
out="$root/docs/images/transitions"

unittest="$(find "$build" -type f -name projectM-unittest -perm -u+x | head -n 1)"
if [[ -z "$unittest" ]]; then
    echo "No projectM-unittest under $build; configure with -DBUILD_TESTING=ON and build it." >&2
    exit 1
fi
command -v ffmpeg >/dev/null || { echo "ffmpeg is required." >&2; exit 1; }

frames="$(mktemp -d)"
trap 'rm -rf "$frames"' EXIT

run=("$unittest" --gtest_filter=TransitionLooksTest.DumpStills)
if [[ -z "${DISPLAY:-}" ]] && command -v xvfb-run >/dev/null; then
    run=(xvfb-run -a "${run[@]}")
fi
PROJECTM_TRANSITION_STILLS_DIR="$frames" "${run[@]}"

mkdir -p "$out"
for name in Shatter StarWipe; do
    lower="$(echo "$name" | tr '[:upper:]' '[:lower:]')"
    [[ -f "$frames/${name}_000.ppm" ]] || { echo "DumpStills wrote no $name frames." >&2; exit 1; }
    # Hold the first and last frame, 12 fps, one palette for the whole clip.
    ffmpeg -loglevel error -y -framerate 12 -i "$frames/${name}_%03d.ppm" \
        -vf "tpad=start_mode=clone:start_duration=0.5:stop_mode=clone:stop_duration=0.75,scale=320:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=4" \
        "$out/$lower.gif"
    # Five frames side by side, scaled to half size: t = 0, 0.25, 0.5, 0.75, 1.
    ffmpeg -loglevel error -y \
        -i "$frames/${name}_000.ppm" -i "$frames/${name}_009.ppm" -i "$frames/${name}_018.ppm" \
        -i "$frames/${name}_027.ppm" -i "$frames/${name}_036.ppm" \
        -filter_complex "hstack=inputs=5,scale=iw/2:-1" -frames:v 1 "$out/$lower-strip.png"
    echo "wrote $out/$lower.gif and $out/$lower-strip.png"
done
