#!/usr/bin/env bash
# Mirror projectm-v.*-thread.{wasm,1ijs,3ijs,worker.js} from the repo root into pm/.
#
# Use when WASM artifacts are already at the site root (legacy SFTP upload) but pm/
# was never created. deploy.py also mirrors into the zip at upload time; this script
# keeps a local pm/ tree for inspection or manual SFTP uploads.
#
# Usage:
#   PROJECTM_WASM_VERSION=036 scripts/stage_pm_mirror_from_root.sh
#   python deploy.py

set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PROJECTM_WASM_VERSION="${PROJECTM_WASM_VERSION:-036}"
bundle="projectm-v.${PROJECTM_WASM_VERSION}-thread"
dest_pm="$PROJECT_ROOT/pm"

mkdir -p "$dest_pm"

copied=0
for ext in wasm 1ijs 3ijs worker.js; do
    src="$PROJECT_ROOT/${bundle}.${ext}"
    if [[ -s "$src" ]]; then
        cp -f "$src" "$dest_pm/"
        copied=$((copied + 1))
    fi
done

if [[ "$copied" -eq 0 ]]; then
    echo "ERROR: no ${bundle}.* artifacts found at $PROJECT_ROOT" >&2
    echo "Run scripts/prepare_deploy_bundle.sh first, or copy your build outputs to the repo root." >&2
    exit 1
fi

echo "Mirrored ${bundle} artifacts into pm/:"
ls -lh "$dest_pm/${bundle}."* 2>/dev/null || ls -lh "$dest_pm/"
