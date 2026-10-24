#!/usr/bin/env bash
# ================================================
# check_web_format.sh
#
# Guards JavaScript layout with `prettier --check` against .prettierrc.json,
# over a fixed, growing list of paths. Same rollout as check_cpp_format.sh:
# most of html/ and tests/web/ predates the formatter, and reformatting all
# of it in one commit would bury every real diff in `git blame` and review.
#
# To widen PATHS: run `npx prettier --write <dir>` in a commit that does
# nothing else, add that commit's SHA to .git-blame-ignore-revs with a
# `# style(web): ...` line, then add the directory here. Never add a path that
# is not already clean, or this gate goes red for everyone.
#
# Today PATHS holds the files written after the formatter existed (no blame
# history to protect) and the lint/format configuration itself.
#
# Usage:
#   scripts/check_web_format.sh          # check
#   scripts/check_web_format.sh --write  # reformat the same paths
# ================================================

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

PATHS=(
    eslint.config.mjs
    html/projectm-app-shell.js
    html/projectm-app-shell-ui.js
    html/projectm-audio-capture-page.js
    html/projectm-bezel.js
    html/projectm-disposables.js
    html/projectm-embed-demo.js
    html/projectm-pcm-test-sender.js
    html/projectm-redirect-stub.js
    html/flac-player/boot.js
    html/flac-player/preboot.js
    html/tsconfig.worklet.json
    tests/web/tsconfig.json
)

PRETTIER="$PROJECT_ROOT/node_modules/.bin/prettier"
if [[ ! -x "$PRETTIER" ]]; then
    echo "check_web_format.sh: prettier is not installed; run \`npm ci\` at the repo root." >&2
    exit 1
fi

mode=--check
[[ "${1:-}" == "--write" ]] && mode=--write
exec "$PRETTIER" "$mode" "${PATHS[@]}"
