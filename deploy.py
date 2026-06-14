#!/usr/bin/env python3
"""
deploy.py — Project-M

Deployment now goes through storage.noahcohn.com (Contabo VPS).
No SFTP passwords are stored in this repo.

Usage:
  python deploy.py

This script zips the compiled WASM/JS output files and uploads them as a
single bundle. The server pushes them to projectm.1ink.us/ via a persistent
SFTP connection on the VPS side.

Requirements:
  pip install requests
"""

import glob
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

# Files to deploy — globs matched against the project root.
# These are the compiled WASM + JS output artifacts.
DEPLOY_FILE_PATTERNS: list = ["*.wasm", "*.1ijs", "*.3ijs"]

# Deploy under this remote folder (empty = use PROJECT_NAME).
# Matches the original SFTP remote target: projectm.1ink.us/
DEPLOY_FOLDER: str = "projectm.1ink.us"

# Required. No default — see docs/DEPLOYMENT.md for how to obtain/rotate this token.
DEPLOY_TOKEN: str = os.environ.get("DEPLOY_TOKEN", "")
# ============================================================

HERE = Path(__file__).parent


def build_zip() -> bytes:
    """Zip only the WASM/JS output files from the project root."""
    buf = io.BytesIO()
    matched: list[Path] = []
    for pattern in DEPLOY_FILE_PATTERNS:
        matched.extend(sorted(HERE.glob(pattern)))

    if not matched:
        print("ERROR: No files matched deploy patterns:")
        for p in DEPLOY_FILE_PATTERNS:
            print(f"  {p}")
        sys.exit(1)

    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for file in matched:
            zf.write(file, file.name)
            print(f"  + {file.name}")
    return buf.getvalue()


def deploy_bundle() -> bool:
    """Zip the output files and upload as a single bundle."""
    target_folder = DEPLOY_FOLDER or PROJECT_NAME
    url = f"{CONTABO_BASE_URL}/api/deploy/{PROJECT_NAME}/bundle"
    headers = {}
    if DEPLOY_TOKEN:
        headers["X-Deploy-Token"] = DEPLOY_TOKEN

    print("Building zip archive...")
    zip_bytes = build_zip()
    print(f"Archive size: {len(zip_bytes) / 1024:.1f} KB\n")

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
    if not DEPLOY_TOKEN:
        print(
            "ERROR: DEPLOY_TOKEN is not set.\n"
            "  export DEPLOY_TOKEN=\"your_long_token_from_vps_env\"\n"
            "See docs/DEPLOYMENT.md and .env.example for details.",
            file=sys.stderr,
        )
        sys.exit(1)

    print(f"\n=== Deploying '{PROJECT_NAME}' via Contabo -> projectm.1ink.us/ ===\n")

    try:
        health = requests.get(f"{CONTABO_BASE_URL}/api/deploy/health", timeout=10)
        if health.status_code == 200:
            print(f"Contabo deploy service: {health.json().get('status', 'unknown')}")
    except Exception:
        print("Warning: Could not contact storage.noahcohn.com (continuing anyway).")

    print()
    success = deploy_bundle()

    print(f"\n=== {'Deployment complete' if success else 'Deployment finished with errors'} ===")
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
