#!/usr/bin/env bash
# Ensures PROJECTM_WASM_VERSION stays aligned across deploy scripts and browser hosts.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

version_js="$(
    sed -n "s/^export const PROJECTM_WASM_VERSION = '\([0-9][0-9][0-9]\)';/\1/p" \
        "$PROJECT_ROOT/html/projectm-wasm-version.js" | head -n1
)"

if [[ -z "$version_js" ]]; then
    echo "Could not read PROJECTM_WASM_VERSION from html/projectm-wasm-version.js" >&2
    exit 1
fi

prepare_default="$(
    sed -n 's/^PROJECTM_WASM_VERSION="\${PROJECTM_WASM_VERSION:-\([0-9][0-9][0-9]\)}".*/\1/p' \
        "$PROJECT_ROOT/scripts/prepare_deploy_bundle.sh" | head -n1
)"

verify_default="$(
    sed -n 's/^BUNDLE="\${2:-projectm-v\.\([0-9][0-9][0-9]\)-thread}".*/\1/p' \
        "$PROJECT_ROOT/scripts/verify_deploy_urls.sh" | head -n1
)"

redirect_default="$(
    sed -n "s/^var DEFAULT_WASM_VERSION = '\([0-9][0-9][0-9]\)';/\1/p" \
        "$PROJECT_ROOT/html/projectm-wasm-default-redirect.js" | head -n1
)"

errors=0
if [[ "$version_js" != "$prepare_default" ]]; then
    echo "Mismatch: html/projectm-wasm-version.js=$version_js vs prepare_deploy_bundle.sh default=$prepare_default" >&2
    errors=1
fi

if [[ -n "$verify_default" && "$version_js" != "$verify_default" ]]; then
    echo "Mismatch: html/projectm-wasm-version.js=$version_js vs verify_deploy_urls.sh default=$verify_default" >&2
    errors=1
fi

if [[ -z "$redirect_default" ]]; then
    echo "Could not read DEFAULT_WASM_VERSION from html/projectm-wasm-default-redirect.js" >&2
    errors=1
elif [[ "$version_js" != "$redirect_default" ]]; then
    echo "Mismatch: html/projectm-wasm-version.js=$version_js vs projectm-wasm-default-redirect.js=$redirect_default" >&2
    errors=1
fi

if [[ "$errors" -ne 0 ]]; then
    exit 1
fi

echo "WASM version sync OK: $version_js"
