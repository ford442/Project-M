#!/usr/bin/env python3
"""
deploy.py — Project-M

Deployment goes through storage.noahcohn.com (Contabo VPS).
No SFTP passwords are stored in this repo.

Usage:
  python deploy.py                  # upload bundle (default: test staging)
  python deploy.py --dry-run        # list files that would be uploaded
  python deploy.py --target prod    # DreamHost projectm.1ink.us (needs Contabo DEPLOY_BASE_DIR_PROD)
  python deploy.py --target test,go # multi-target

Env:
  DEPLOY_TOKEN          required
  DEPLOY_TARGET_SITE    test|go|prod (default test; overridden by --target)

The Contabo deploy API writes to DreamHost paths configured on the storage VPS:
  test -> DEPLOY_BASE_DIR/.../projectm.1ink.us/     (https://test.1ink.us/projectm.1ink.us/)
  go   -> DEPLOY_BASE_DIR_GO/.../projectm.1ink.us/  (https://go.1ink.us/projectm.1ink.us/)
  prod -> DEPLOY_BASE_DIR_PROD/projectm.1ink.us/    (https://projectm.1ink.us/)

Requirements:
  pip install requests
"""

from __future__ import annotations

import argparse
import io
import os
import sys
import zipfile
from pathlib import Path

import requests

# ============================================================
# PER-PROJECT CONFIGURATION
# ============================================================
PROJECT_NAME: str = "project-m"
CONTABO_BASE_URL: str = "https://storage.noahcohn.com"

# WASM artifacts at the repo root (built + iconv'd before deploy).
DEPLOY_FILE_PATTERNS: list = [
    "projectm-v.*-thread.wasm",
    "projectm-v.*-thread.js",  # UTF-8 glue (rewrite target for smoke→deploy rename)
    "projectm-v.*-thread.1ijs",
    "projectm-v.*-thread.3ijs",
    "projectm-v.*-thread.worker.js",
    # AudioWorklet loaded by WasmAudioBridge.cpp via addModule('projectm_audio_processor.js')
    "projectm_audio_processor.js",
]

# Optional on-disk pm/ mirror (also auto-generated in the zip from root WASM files).
DEPLOY_PM_GLOBS: list = [
    "pm/projectm-v.*-thread.wasm",
    "pm/projectm-v.*-thread.js",
    "pm/projectm-v.*-thread.1ijs",
    "pm/projectm-v.*-thread.3ijs",
    "pm/projectm-v.*-thread.worker.js",
]

# Host pages load the module from ./pm/…; mirror every WASM artifact there too.
DEPLOY_MIRROR_SUBDIRS: list = ["pm"]

# Shared browser modules and demo hosts (flattened to the deploy root).
DEPLOY_HTML_GLOBS: list = [
    "html/projectm-*.js",
    "html/generated/*.js",
    "html/projectm*.1ink",  # projectm_panel2.1ink, projectm.1ink, etc.
    "html/projectm-core.html",
    "html/projectm-core.css",
    "html/embed-demo.html",
    "html/.htaccess",  # no-gzip for legacy UTF-16 .1ijs (Chrome ERR_CONTENT_DECODING_FAILED)
    # External PCM feeders co-deployed with the host (same-origin ./flac-player/).
    # Use **/* — a trailing ** matches only directories on Python 3.12+
    # (IsADirectoryError when zip tries Path.read_bytes() on the folder).
    "html/flac-player/**/*",
    "html/xm-player/**/*",
    # Song library folders (Apache-style directory listings).
    "mp3_songs/**/*",
    "mod_songs/**/*",
    "songs/**/*",
    # Legacy /flac/ decoder (BroadcastChannel sng/file).
    "html/flac-decode/example/**/*",
]

# Deploy under this remote folder (empty = use PROJECT_NAME).
# Matches the original SFTP remote target: projectm.1ink.us/
DEPLOY_FOLDER: str = "projectm.1ink.us"

# Canonical production entry URL alias (must stay identical to panel2).
PANEL2_HOST = "projectm_panel2.1ink"
PRODUCTION_HOST_ALIAS = "1ink.1ink"

# Required. No default — see docs/DEPLOYMENT.md for how to obtain/rotate this token.
DEPLOY_TOKEN: str = os.environ.get("DEPLOY_TOKEN", "")
# ============================================================

HERE = Path(__file__).parent


def _unique_paths(paths: list[Path]) -> list[Path]:
    seen: set[Path] = set()
    ordered: list[Path] = []
    for path in paths:
        resolved = path.resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        ordered.append(path)
    return ordered


def collect_deploy_files() -> list[Path]:
    matched: list[Path] = []
    for pattern in DEPLOY_FILE_PATTERNS + DEPLOY_PM_GLOBS:
        matched.extend(HERE.glob(pattern))

    for pattern in DEPLOY_HTML_GLOBS:
        matched.extend(HERE.glob(pattern))

    # `**` globs include directories (html/flac-player, html/flac-player/vendor,
    # empty song folders). Zip only files — Path.read_bytes() on a dir is
    # IsADirectoryError (seen on Colab).
    return _unique_paths([path for path in matched if path.is_file()])


def zip_entry_name(file: Path) -> str:
    """Place html/ sources at the deploy root; keep pm/ paths as-is."""
    try:
        relative = file.relative_to(HERE)
    except ValueError:
        return file.name

    if relative.parts[:2] == ("html", "flac-decode"):
        # Live decoder is projectm.1ink.us/flac/example/...
        return str(Path("flac", *relative.parts[2:]))
    if relative.parts and relative.parts[0] == "html":
        return str(Path(*relative.parts[1:]))
    return str(relative)


def _to_utf16_le_bom(data: bytes) -> bytes:
    """Encode host-page bytes as UTF-16 LE with BOM (DreamHost .1ink charset)."""
    if data.startswith(b"\xff\xfe"):
        return data
    if data.startswith(b"\xfe\xff"):
        return data.decode("utf-16-be").encode("utf-16")
    text = data.decode("utf-8-sig")
    return text.encode("utf-16")


def fetch_remote_sizes(target_folder: str, target_site: str) -> dict[str, int]:
    """Ask the VPS for {rel_path: bytes} already on the deploy target."""
    url = f"{CONTABO_BASE_URL.rstrip('/')}/api/deploy/{PROJECT_NAME}/sizes"
    headers = {}
    if DEPLOY_TOKEN:
        headers["X-Deploy-Token"] = DEPLOY_TOKEN
    try:
        response = requests.get(
            url,
            params={"target_site": target_site, "target_folder": target_folder},
            headers=headers,
            timeout=60,
        )
        if response.status_code == 200:
            files = response.json().get("files") or {}
            print(f"Remote size map ({target_site}): {len(files)} file(s)")
            return {str(k).replace("\\", "/"): int(v) for k, v in files.items()}
        print(f"  ! sizes HTTP {response.status_code}; uploading all files")
    except Exception as exc:
        print(f"  ! Could not fetch remote sizes ({exc}); uploading all files")
    return {}


def _zip_write(
    zf: zipfile.ZipFile,
    archive_name: str,
    data: bytes,
    skip_sizes: dict[str, int] | None = None,
    allow_size_skip: bool = True,
) -> None:
    if allow_size_skip and skip_sizes and skip_sizes.get(archive_name) == len(data):
        print(f"  = {archive_name} ({len(data)} bytes, unchanged)")
        return
    zf.writestr(archive_name, data)
    print(f"  + {archive_name}")


def build_zip(skip_sizes: dict[str, int] | None = None) -> bytes:
    """Zip WASM artifacts (plus pm/ mirrors) and shared html host files."""
    matched = collect_deploy_files()

    if not matched:
        print("ERROR: No files matched deploy patterns:")
        for pattern in DEPLOY_FILE_PATTERNS + DEPLOY_HTML_GLOBS:
            print(f"  {pattern}")
        sys.exit(1)

    wasm_files = [
        path for path in matched
        if path.suffix in {".wasm", ".1ijs", ".3ijs", ".js"}
        and path.name.startswith("projectm-v.")
        and "-thread." in path.name
        and path.parent == HERE
    ]

    mirrored_names: set[str] = set()
    for path in matched:
        if path.parent == HERE / "pm":
            mirrored_names.add(path.name)

    panel2_utf16: bytes | None = None
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for file in matched:
            if not file.is_file():
                continue
            archive_name = zip_entry_name(file)
            data = file.read_bytes()
            if archive_name.endswith(".1ink"):
                data = _to_utf16_le_bom(data)
                if archive_name == PANEL2_HOST:
                    panel2_utf16 = data
            # WASM bundle artifacts (.wasm/.js/.1ijs/.3ijs/.worker.js) are a tightly
            # coupled set: the .wasm's compiled-in ASM_CONSTS call-site indices must
            # match the ASM_CONSTS array baked into its paired .js glue from the same
            # build. A same-name file that coincidentally has the same byte length as
            # what's already deployed (e.g. a trivial code change that doesn't shift
            # binary size) is not necessarily byte-identical, so skip-by-size must
            # never apply here — a false "unchanged" skip would leave a stale sibling
            # on the server and desync ASM_CONSTS between glue and binary, producing
            # "ASM_CONSTS[code] is not a function" at runtime. Always re-upload these.
            is_wasm_bundle_file = file in wasm_files
            _zip_write(zf, archive_name, data, skip_sizes, allow_size_skip=not is_wasm_bundle_file)

            if is_wasm_bundle_file:
                for subdir in DEPLOY_MIRROR_SUBDIRS:
                    if file.name in mirrored_names:
                        continue
                    mirrored = f"{subdir}/{file.name}"
                    _zip_write(zf, mirrored, file.read_bytes(), skip_sizes, allow_size_skip=False)
                    mirrored_names.add(file.name)

        # Keep production URL /1ink.1ink identical to panel2 (stop hand-editing drift).
        if panel2_utf16 is not None:
            _zip_write(zf, PRODUCTION_HOST_ALIAS, panel2_utf16, skip_sizes)
        else:
            print(f"  ! warning: {PANEL2_HOST} missing; skipped {PRODUCTION_HOST_ALIAS} alias")

    return buf.getvalue()


def _parse_targets(raw: str | None) -> list[str]:
    text = (raw or os.environ.get("DEPLOY_TARGET_SITE") or "test").strip().lower()
    targets: list[str] = []
    for part in text.replace(";", ",").split(","):
        name = part.strip()
        if not name:
            continue
        if name not in {"test", "go", "prod"}:
            print(f"ERROR: unknown deploy target '{name}' (expected test|go|prod)", file=sys.stderr)
            sys.exit(2)
        if name not in targets:
            targets.append(name)
    return targets or ["test"]


def deploy_bundle(zip_bytes: bytes, target_site: str) -> bool:
    """Upload a pre-built zip bundle to one Contabo target_site."""
    target_folder = DEPLOY_FOLDER or PROJECT_NAME
    url = f"{CONTABO_BASE_URL}/api/deploy/{PROJECT_NAME}/bundle"
    headers = {}
    if DEPLOY_TOKEN:
        headers["X-Deploy-Token"] = DEPLOY_TOKEN

    print(f"Uploading bundle (target_site={target_site}, folder={target_folder})...")
    try:
        response = requests.post(
            url,
            files={"bundle": ("build.zip", zip_bytes, "application/zip")},
            data={
                "target_folder": target_folder,
                "target_site": target_site,
                "DEPLOY_TARGET": target_site,
            },
            headers=headers,
            timeout=300,
        )
    except Exception as exc:
        print(f"  ✗ Upload exception: {exc}")
        return False

    if response.status_code == 200:
        data = response.json()
        print(f"  ✓ {data.get('uploaded', 0)} files uploaded -> {target_site}")
        if data.get("failed"):
            print("  Failures:")
            for f in data["failed"]:
                print(f"    ✗ {f['path']}: {f['error']}")
        return not data.get("failed")

    print(f"  ✗ {response.status_code}: {response.text[:400]}")
    return False


def main():
    parser = argparse.ArgumentParser(description="Deploy projectM WASM + host assets")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List bundle contents without uploading",
    )
    parser.add_argument(
        "--target",
        default=None,
        help="Deploy target site(s): test|go|prod (comma-separated). "
        "Overrides DEPLOY_TARGET_SITE. Default: test.",
    )
    args = parser.parse_args()
    targets = _parse_targets(args.target)

    print(f"\n=== Deploying '{PROJECT_NAME}' via Contabo -> {', '.join(targets)} ===\n")

    print("Building zip archive...")
    # Per-target size maps can differ; first target is used for the shared zip
    # (server-side skip still applies on later targets).
    first_target = targets[0]
    skip_sizes = fetch_remote_sizes(DEPLOY_FOLDER or PROJECT_NAME, first_target)
    zip_bytes = build_zip(skip_sizes)
    print(f"Archive size: {len(zip_bytes) / 1024:.1f} KB\n")

    if args.dry_run:
        print("Dry run complete (no upload).")
        sys.exit(0)

    if not DEPLOY_TOKEN:
        print(
            "ERROR: DEPLOY_TOKEN is not set.\n"
            "  export DEPLOY_TOKEN=\"your_long_token_from_vps_env\"\n"
            "See docs/DEPLOYMENT.md and .env.example for details.",
            file=sys.stderr,
        )
        sys.exit(1)

    try:
        health = requests.get(f"{CONTABO_BASE_URL}/api/deploy/health", timeout=10)
        if health.status_code == 200:
            payload = health.json()
            print(f"Contabo deploy service: {payload.get('status', 'unknown')}")
            if "prod" in targets and not payload.get("deploy_base_dir_prod"):
                print(
                    "WARNING: Contabo health has no deploy_base_dir_prod — "
                    "set DEPLOY_BASE_DIR_PROD=/home/ford442 on the storage VPS "
                    "before --target prod can reach https://projectm.1ink.us/",
                    file=sys.stderr,
                )
    except Exception:
        print("Warning: Could not contact storage.noahcohn.com (continuing anyway).")

    print()
    ok = True
    for target in targets:
        if not deploy_bundle(zip_bytes, target):
            ok = False

    print(f"\n=== {'Deployment complete' if ok else 'Deployment finished with errors'} ===")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
