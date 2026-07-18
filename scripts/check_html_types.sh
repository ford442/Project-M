#!/usr/bin/env bash
# Type-check generated WASM API helpers (html/generated/projectm-wasm-api.ts).
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT/html"
if [[ ! -x node_modules/.bin/tsc ]]; then
    npm install --no-save --no-package-lock typescript@5.8.3
fi
npx tsc -p tsconfig.json --noEmit
