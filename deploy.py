#!/usr/bin/env python3
"""
deploy.py — Project-M

Deployment now goes through storage.noahcohn.com (Contabo VPS).
No SFTP passwords are stored in this repo.

Usage:
  python deploy.py              # upload bundle
  python deploy.py --dry-run    # list files that would be uploaded

This script zips the compiled WASM/JS output files and uploads them as a
single bundle. The server pushes them to projectm.1ink.us/ via a persistent
SFTP connection on the VPS side.

Requirements:
  pip install requests
"""

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
    "projectm-v.*-thread.1ijs",
    "projectm-v.*-thread.3ijs",
    "projectm-v.*-thread.worker.js",
]

# Optional on-disk pm/ mirror (also auto-generated in the zip from root WASM files).
DEPLOY_PM_GLOBS: list = [
    "pm/projectm-v.*-thread.wasm",
    "pm/projectm-v.*-thread.1ijs",
    "pm/projectm-v.*-thread.3ijs",
    "pm/projectm-v.*-thread.worker.js",
]

# Host pages load the module from ./pm/…; mirror every WASM artifact there too.
DEPLOY_MIRROR_SUBDIRS: list = ["pm"]

# Shared browser modules and demo hosts (flattened to the deploy root).
DEPLOY_HTML_GLOBS: list = [
    "html/projectm-*.js",
    "html/projectm*.1ink",  # projectm_panel2.1ink, projectm.1ink, etc.
    "html/projectm-core.html",
    "html/projectm-core.css",
]

# Deploy under this remote folder (empty = use PROJECT_NAME).
# Matches the original SFTP remote target: projectm.1ink.us/
DEPLOY_FOLDER: str = "projectm.1ink.us"

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

    return _unique_paths(matched)


def zip_entry_name(file: Path) -> str:
    """Place html/ sources at the deploy root; keep pm/ paths as-is."""
    try:
        relative = file.relative_to(HERE)
    except ValueError:
        return file.name

    if relative.parts and relative.parts[0] == "html":
        return str(Path(*relative.parts[1:]))
    return str(relative)


def build_zip() -> bytes:
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

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for file in matched:
            archive_name = zip_entry_name(file)
            zf.write(file, archive_name)
            print(f"  + {archive_name}")

            if file in wasm_files:
                for subdir in DEPLOY_MIRROR_SUBDIRS:
                    mirrored = f"{subdir}/{file.name}"
                    if file.name in mirrored_names:
                        continue
                    zf.write(file, mirrored)
                    print(f"  + {mirrored} (mirror)")
                    mirrored_names.add(file.name)

    return buf.getvalue()


def deploy_bundle(zip_bytes: bytes) -> bool:
    """Upload a pre-built zip bundle."""
    target_folder = DEPLOY_FOLDER or PROJECT_NAME
    url = f"{CONTABO_BASE_URL}/api/deploy/{PROJECT_NAME}/bundle"
    headers = {}
    if DEPLOY_TOKEN:
        headers["X-Deploy-Token"] = DEPLOY_TOKEN

    print("Uploading bundle...")
    try:
        response = requests.post(
            url,
            files={"bundle": ("build.zip", zip_bytes, "application/zip")},
            data={"target_folder": target_folder},
            headers=headers,
            timeout=300,
        )
    except Exception as exc:
        print(f"  ✗ Upload exception: {exc}")
        return False

    if response.status_code == 200:
        data = response.json()
        print(f"  ✓ {data.get('uploaded', 0)} files uploaded")
        if data.get("failed"):
            print("  Failures:")
            for f in data["failed"]:
                print(f"    ✗ {f['path']}: {f['error']}")
        return not data.get("failed")
    else:
        print(f"  ✗ {response.status_code}: {response.text[:400]}")
        return False


def main():
    parser = argparse.ArgumentParser(description="Deploy projectM WASM + host assets")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List bundle contents without uploading",
    )
    args = parser.parse_args()

    print(f"\n=== Deploying '{PROJECT_NAME}' via Contabo -> projectm.1ink.us/ ===\n")

    print("Building zip archive...")
    zip_bytes = build_zip()
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
            print(f"Contabo deploy service: {health.json().get('status', 'unknown')}")
    except Exception:
        print("Warning: Could not contact storage.noahcohn.com (continuing anyway).")

    print()
    success = deploy_bundle(zip_bytes)

    print(f"\n=== {'Deployment complete' if success else 'Deployment finished with errors'} ===")
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
