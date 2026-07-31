#!/usr/bin/env bash
# Node unit tests for embed SDK modules (no browser/WASM required).
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

node --test \
  tests/web/projectm-wasm-version.test.mjs \
  tests/web/projectm-init.test.mjs \
  tests/web/projectm-init-errors.test.mjs \
  tests/web/projectm-context.test.mjs \
  tests/web/projectm-element.test.mjs \
  tests/web/projectm-external-pcm.test.mjs \
  tests/web/projectm-presets.test.mjs \
  tests/web/projectm-transitions.test.mjs

(cd packages/web && node scripts/build.mjs)
