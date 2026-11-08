#!/usr/bin/env bash
# Render-device hazard inventory (#315 Phase B0).
#
# Renders every preset in the given directories with projectm-render under
# PROJECTM_DEVICE_VALIDATION=1 and collects each distinct feedback hazard the
# ResourceStateTracker reports ("[RenderDevice] Feedback hazard: ..."). A hazard
# is a texture sampled while attached to the draw target, or a blit/copy that
# reads what it writes: legal-ish in GL, a validation error in WebGPU. The
# output is the WebGPU risk list before any WGSL exists.
#
# usage: scripts/hazard_inventory.sh <projectm-render> <out-dir> [preset-dir...]
#   default preset dirs: presets/tests presets/custom presets/weeks
# env:   HAZARD_DURATION (seconds per preset, default 2), HAZARD_SIZE (default 320x180),
#        HAZARD_AUDIO (optional FLAC/WAV/MP3; default tests/tools/data/beat-10s.flac if present)
#        HAZARD_FAIL_ON_HAZARD=1 exits 1 when any preset reports a hazard.
#
# Writes <out-dir>/hazards.json, hazards.md and logs/<preset>.log. Exits 2 on setup errors.
set -euo pipefail

if [[ $# -lt 2 ]]; then
    sed -n '2,20p' "$0" >&2
    exit 2
fi
render=$1
out=$2
shift 2
root=$(cd "$(dirname "$0")/.." && pwd)
dirs=("$@")
if [[ ${#dirs[@]} -eq 0 ]]; then
    dirs=("$root/presets/tests" "$root/presets/custom" "$root/presets/weeks")
fi
[[ -x $render ]] || { echo "hazard_inventory: not executable: $render" >&2; exit 2; }

duration=${HAZARD_DURATION:-2}
size=${HAZARD_SIZE:-320x180}
audio=${HAZARD_AUDIO:-$root/tests/tools/data/beat-10s.flac}
audio_args=()
[[ -f $audio ]] && audio_args=(--audio "$audio")

mkdir -p "$out/logs"
records="$out/records.tsv"
: >"$records"

total=0
for dir in "${dirs[@]}"; do
    [[ -d $dir ]] || { echo "hazard_inventory: skipping missing dir $dir" >&2; continue; }
    while IFS= read -r -d '' preset; do
        total=$((total + 1))
        rel=${preset#"$root"/}
        log="$out/logs/$(echo "$rel" | tr '/' '_').log"
        status=ok
        if ! PROJECTM_DEVICE_VALIDATION=1 timeout 120 "$render" --preset "$preset" \
            --duration "$duration" --width "${size%x*}" --height "${size#*x}" \
            --seed 1 --hash --log "${audio_args[@]}" >"$log" 2>&1; then
            status=failed
        fi
        printf '%s\t%s\t%s\n' "$rel" "$status" "$log" >>"$records"
    done < <(find "$dir" -maxdepth 1 -name '*.milk' -print0 | sort -z)
done

python3 - "$records" "$out" <<'EOF'
import json, re, sys, collections
records, out = sys.argv[1], sys.argv[2]
marker = "[RenderDevice] Feedback hazard: "
presets, kinds = [], collections.Counter()
for line in open(records):
    rel, status, log = line.rstrip("\n").split("\t")
    text = open(log, errors="replace").read()
    hazards = sorted({l.split(marker, 1)[1].strip() for l in text.splitlines() if marker in l})
    errors = [l for l in text.splitlines() if l.startswith("projectm: [error]")]
    for h in hazards:
        # bucket by the message with ids stripped, so the summary groups by kind
        kinds[re.sub(r"\d+", "N", h)] += 1
    presets.append({"preset": rel, "status": status, "hazards": hazards, "errors": len(errors)})
with_h = [p for p in presets if p["hazards"]]
failed = [p for p in presets if p["status"] != "ok"]
json.dump({"presets": len(presets), "with_hazards": len(with_h), "failed": len(failed),
           "kinds": dict(kinds.most_common()), "results": presets}, open(f"{out}/hazards.json", "w"), indent=1)
with open(f"{out}/hazards.md", "w") as md:
    md.write(f"# Render-device hazard inventory\n\n{len(presets)} presets, "
             f"{len(with_h)} with hazards, {len(failed)} failed to render.\n\n")
    if kinds:
        md.write("| Hazard kind | Presets |\n|---|---|\n")
        for k, n in kinds.most_common():
            md.write(f"| `{k}` | {n} |\n")
        md.write("\n## Presets\n\n")
        for p in with_h:
            md.write(f"- `{p['preset']}`\n" + "".join(f"  - `{h}`\n" for h in p["hazards"]))
    if failed:
        md.write("\n## Failed renders\n\n" + "".join(f"- `{p['preset']}`\n" for p in failed))
print(open(f"{out}/hazards.md").read().split("\n## Presets")[0])
EOF

if [[ ${HAZARD_FAIL_ON_HAZARD:-0} == 1 ]]; then
    python3 -c 'import json,sys; sys.exit(1 if json.load(open(sys.argv[1]))["with_hazards"] else 0)' "$out/hazards.json"
fi
