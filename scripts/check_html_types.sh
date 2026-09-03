#!/usr/bin/env bash
# Type-check generated WASM API helpers (html/generated/projectm-wasm-api.ts).
#
# Prefer `npm install && npm run typecheck` from the repo root (the html/
# and packages/web/ npm workspace) — this script is the standalone
# fallback for callers that only want html/'s typecheck and haven't run a
# root install.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT/html"
if [[ ! -x node_modules/.bin/tsc && ! -x "$PROJECT_ROOT/node_modules/.bin/tsc" ]]; then
    npm install --no-package-lock
fi
npm run typecheck
