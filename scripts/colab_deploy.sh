#!/usr/bin/env bash
set -euo pipefail

# Colab deployment helper for Project-M WASM builds.
#
# Preferred path (matches docs/DEPLOYMENT.md):
#   export DEPLOY_TOKEN=...
#   PROJECT_ROOT=/content/build_space/projectm bash scripts/colab_deploy.sh
#
# Legacy SFTP fallback (when DEPLOY_TOKEN is unset):
#   export PASSWORD=...   # or SFTP_PASS
#   PROJECT_ROOT=/content/build_space/projectm bash scripts/colab_deploy.sh
#
# Optional env:
#   PROJECT_ROOT, PROJECTM_WASM_VERSION, HOST, USERNAME, PASSWORD, SFTP_PASS, PORT

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${PROJECT_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

HOST="${HOST:-1ink.us}"
USERNAME="${USERNAME:-ford442}"
PASSWORD="${PASSWORD:-${SFTP_PASS:-}}"
PORT="${PORT:-22}"

read_projectm_wasm_version() {
    local version_js="$1"
    sed -n "s/^export const PROJECTM_WASM_VERSION = '\([0-9][0-9][0-9]\)';/\1/p" \
        "$version_js" | head -n1
}

if [ ! -d "$PROJECT_ROOT" ]; then
    echo "ERROR: PROJECT_ROOT does not exist: $PROJECT_ROOT" >&2
    exit 1
fi

version_js="$PROJECT_ROOT/html/projectm-wasm-version.js"
if [ -z "${PROJECTM_WASM_VERSION:-}" ]; then
    PROJECTM_WASM_VERSION="$(read_projectm_wasm_version "$version_js")"
fi
if [ -z "$PROJECTM_WASM_VERSION" ]; then
    echo "ERROR: could not read PROJECTM_WASM_VERSION from $version_js" >&2
    exit 1
fi

bundle="projectm-v.${PROJECTM_WASM_VERSION}-thread"
ARTIFACT_EXTS=(wasm 1ijs 3ijs worker.js)

ensure_artifacts() {
    local missing=0
    for ext in wasm 1ijs 3ijs; do
        if [ ! -s "$PROJECT_ROOT/${bundle}.${ext}" ]; then
            missing=1
            break
        fi
    done

    if [ "$missing" -eq 1 ]; then
        echo "=== Staging missing deploy artifacts via prepare_deploy_bundle.sh ==="
        PROJECT_ROOT="$PROJECT_ROOT" \
            PROJECTM_WASM_VERSION="$PROJECTM_WASM_VERSION" \
            bash "$PROJECT_ROOT/scripts/prepare_deploy_bundle.sh"
    fi

    if [ ! -s "$PROJECT_ROOT/${bundle}.wasm" ] || [ ! -s "$PROJECT_ROOT/${bundle}.1ijs" ]; then
        echo "ERROR: expected ${bundle}.{wasm,1ijs} under $PROJECT_ROOT" >&2
        echo "Run scripts/colab_build.sh first." >&2
        exit 1
    fi

    PROJECTM_WASM_VERSION="$PROJECTM_WASM_VERSION" \
        bash "$PROJECT_ROOT/scripts/stage_pm_mirror_from_root.sh"
}

deploy_via_contabo() {
    echo "=== Deploying via deploy.py (Contabo bundle upload) ==="
    if [ -z "${DEPLOY_TOKEN:-}" ]; then
        echo "ERROR: DEPLOY_TOKEN is not set." >&2
        echo "See docs/DEPLOYMENT.md for obtaining a deploy token." >&2
        exit 1
    fi
    python3 "$PROJECT_ROOT/deploy.py" "$@"
}

upload_file_sftp() {
    local local_path="$1"
    local remote_path="$2"

    if [ ! -f "$local_path" ]; then
        echo "Skipping missing file: $local_path"
        return 1
    fi

    echo "Uploading $local_path -> $remote_path"
    if curl -T "$local_path" --silent --fail "sftp://${USERNAME}:${PASSWORD}@${HOST}/${remote_path}"; then
        echo "   curl upload succeeded"
        return 0
    fi

    if ! command -v sshpass >/dev/null 2>&1; then
        echo "sshpass not found, installing..."
        if command -v apt-get >/dev/null 2>&1; then
            sudo apt-get update -y
            sudo apt-get install -y sshpass
        else
            echo "Cannot install sshpass automatically." >&2
            return 1
        fi
    fi

    sshpass -p "$PASSWORD" scp -P "$PORT" -o StrictHostKeyChecking=no \
        "$local_path" "${USERNAME}@${HOST}:${remote_path}"
}

deploy_via_legacy_sftp() {
    if [ -z "$PASSWORD" ]; then
        echo "ERROR: set DEPLOY_TOKEN for deploy.py, or PASSWORD/SFTP_PASS for legacy SFTP." >&2
        exit 1
    fi

    echo "=== Deploying ${bundle} via legacy SFTP (root + pm/ mirror) ==="
    local remote_bases=("projectm.1ink.us/" "projectm.1ink.us/pm/")

    for ext in "${ARTIFACT_EXTS[@]}"; do
        local_path="$PROJECT_ROOT/${bundle}.${ext}"
        for base in "${remote_bases[@]}"; do
            remote_path="${base}${bundle}.${ext}"
            upload_file_sftp "$local_path" "$remote_path" || true
        done
    done
}

ensure_artifacts

if [ -n "${DEPLOY_TOKEN:-}" ]; then
    deploy_via_contabo "$@"
else
    echo "DEPLOY_TOKEN not set; using legacy SFTP upload." >&2
    deploy_via_legacy_sftp
fi

echo "=== Deploy complete (${bundle}) ==="
echo "Verify:"
echo "  scripts/verify_deploy_urls.sh https://projectm.1ink.us/ ${bundle}"
