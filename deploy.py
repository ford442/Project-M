#!/usr/bin/env python3
"""
deploy.py — Project-M

Deployment goes through storage.noahcohn.com (Contabo VPS).
No SFTP passwords are stored in this repo.

Usage:
  python deploy.py                  # upload bundle (default: test staging)
  python deploy.py --dry-run        # list files that would be uploaded
  python deploy.py --check-bundle   # staged bundle vs this tree + its build-id (no network)
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
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

try:
    import requests
except ImportError:  # --check-bundle runs without it (CI); everything else needs it
    requests = None  # type: ignore[assignment]

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
]

# Optional on-disk pm/ mirror (also auto-generated in the zip from root WASM files).
DEPLOY_PM_GLOBS: list = [
    "pm/projectm-v.*-thread.wasm",
    "pm/projectm-v.*-thread.js",
    "pm/projectm-v.*-thread.1ijs",
    "pm/projectm-v.*-thread.3ijs",
    "pm/projectm-v.*-thread.worker.js",
    # Precompressed siblings html/.htaccess serves to clients that accept them,
    # and the build manifest hosts read (scripts/generate_wasm_builds_manifest.mjs).
    "pm/projectm-v.*-thread.js.br",
    "pm/projectm-v.*-thread.js.gz",
    "pm/projectm-v.*-thread.wasm.br",
    "pm/projectm-v.*-thread.wasm.gz",
    "pm/builds.json",
    "pm/builds.json.br",
    "pm/builds.json.gz",
]

# Never skipped by size (see build_zip): bundle files must go up as a set, and
# a manifest can change content without changing length (same-length hashes).
ALWAYS_UPLOAD_RE = re.compile(r"(^|/)(projectm-v\.[0-9a-z]+-thread\.|builds\.json|index\.json$|index\.html$)")

# Host pages load the module from ./pm/…; mirror every WASM artifact there too.
DEPLOY_MIRROR_SUBDIRS: list = ["pm"]

# Shared browser modules and demo hosts (flattened to the deploy root).
DEPLOY_HTML_GLOBS: list = [
    "html/projectm-*.js",
    # ProjectMContext's parts (projectm-context.js imports ./context/*.js).
    "html/context/*.js",
    "html/generated/*.js",
    # AudioWorklet processors -> worklets/ (WasmAudioBridge.cpp's addModule and
    # html/projectm-worklet-playback.js both load worklets/projectm-audio-processor.js).
    "html/worklets/*.js",
    "html/projectm*.1ink",  # projectm_panel2.1ink, projectm.1ink, etc.
    "html/projectm-core.html",
    "html/embed-demo.html",
    "html/audio-capture.html",  # tab/system audio capture popup (projectm-display-capture.js)
    "html/.htaccess",  # encoding, types, caching, legacy-glue redirect (docs/adr/0001-wasm-and-media-hosting.md)
    # External PCM feeders co-deployed with the host (same-origin ./flac-player/).
    # Use **/* — a trailing ** matches only directories on Python 3.12+
    # (IsADirectoryError when zip tries Path.read_bytes() on the folder).
    "html/flac-player/**/*",
    "html/xm-player/**/*",
    # Song library folders, with the index.json / index.html that
    # scripts/generate_songs_manifest.mjs writes (auto-indexes are off there).
    "mp3_songs/**/*",
    "mod_songs/**/*",
    "songs/**/*",
    # Legacy /flac/ decoder (BroadcastChannel sng/file).
    "html/flac-decode/example/**/*",
]

# Extra archive names for a file that moved in the repo: {deployed name: repo
# path}. The file is uploaded under its new name by the globs above and under
# each name here too, so a URL baked into something already deployed (a WASM
# bundle's EM_JS, a bookmarked page) keeps resolving.
DEPLOY_PATH_ALIASES: dict = {
    # WASM bundles linked before the move to html/worklets/ addModule() this
    # page-relative name. Drop it once every bundle in pm/builds.json is newer.
    "projectm_audio_processor.js": "html/worklets/projectm-audio-processor.js",
}

# Preset corpora: {repo folder: deployed folder}. The corpora live under
# presets/ in the repo, but the site fetches them from these top-level names
# (every manifest's `base`, html/projectm-preset-sources.js, the WASM glue's
# EM_JS), so they deploy there. Opt-in with --with-presets: it uploads ~460
# .milk files that most deploys have no reason to send again.
DEPLOY_PRESET_DIRS: dict = {
    "presets/custom": "custom_milk_fixed",
    "presets/weeks": "weeks_presets",
}

# Deploy under this remote folder (empty = use PROJECT_NAME).
# Matches the original SFTP remote target: projectm.1ink.us/
DEPLOY_FOLDER: str = "projectm.1ink.us"

# Public URL of each target: song indexes read remote-only songs from here.
TARGET_PUBLIC_URLS: dict = {
    "test": "https://test.1ink.us/projectm.1ink.us",
    "go": "https://go.1ink.us/projectm.1ink.us",
    "prod": "https://projectm.1ink.us",
}

# Folders that get a generated index.json + index.html (html/.htaccess turns
# their auto-index off).
SONG_FOLDERS: tuple = ("songs", "mp3_songs", "mod_songs")

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


def collect_deploy_files(with_presets: bool = False) -> list[Path]:
    matched: list[Path] = []
    for pattern in DEPLOY_FILE_PATTERNS + DEPLOY_PM_GLOBS:
        matched.extend(HERE.glob(pattern))

    for pattern in DEPLOY_HTML_GLOBS:
        matched.extend(HERE.glob(pattern))

    if with_presets:
        for folder in DEPLOY_PRESET_DIRS:
            matched.extend(HERE.glob(f"{folder}/**/*.milk"))

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
    for folder, deployed in DEPLOY_PRESET_DIRS.items():
        prefix = tuple(Path(folder).parts)
        if relative.parts[: len(prefix)] == prefix:
            return str(Path(deployed, *relative.parts[len(prefix):]))
    return str(relative)


def _to_utf8_bom(data: bytes) -> bytes:
    """Encode host-page bytes as UTF-8 with a BOM.

    .1ink pages used to ship as UTF-16 LE (DreamHost served .1ink as utf-16).
    A BOM decides the encoding before any header charset does, so a UTF-8 BOM
    page renders correctly whether the server still says utf-16 or, with
    html/.htaccess, utf-8; and it is half the size. See
    docs/adr/0001-wasm-and-media-hosting.md.
    """
    if data.startswith(b"\xff\xfe"):
        text = data.decode("utf-16")
    elif data.startswith(b"\xfe\xff"):
        text = data.decode("utf-16-be")
    else:
        text = data.decode("utf-8-sig")
    return b"\xef\xbb\xbf" + text.encode("utf-8")


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


def build_song_indexes(remote_sizes: dict[str, int], target_site: str) -> dict[str, bytes]:
    """index.json + index.html for each song folder (scripts/generate_songs_manifest.mjs).

    The songs themselves are uploaded out of band and mostly exist only on the
    server, so the file list is the target's size map (what fetch_remote_sizes
    returned) plus any local files; metadata comes from the local file, or from
    the first 64 KiB of the public URL. Without a size map it reads the live
    listing instead (the auto-index, or the index.html generated last time).
    """
    if not shutil.which("node"):
        print("  ! node not found; song indexes not regenerated")
        return {}
    base = TARGET_PUBLIC_URLS.get(target_site, TARGET_PUBLIC_URLS["prod"])
    script = HERE / "scripts" / "generate_songs_manifest.mjs"
    out: dict[str, bytes] = {}
    with tempfile.TemporaryDirectory() as tmp:
        for folder in SONG_FOLDERS:
            remote = sorted(k for k in remote_sizes if k.startswith(f"{folder}/") and k.count("/") == 1)
            local_dir = HERE / folder
            dest = Path(tmp) / folder
            dest.mkdir()
            args = ["node", str(script), "--out", str(dest / "index.json"), "--base-url", f"{base}/{folder}/"]
            if local_dir.is_dir():
                args += ["--dir", str(local_dir)]
            if remote:
                names = dest / "names.json"
                names.write_text(json.dumps(remote), encoding="utf-8")
                args += ["--names", str(names)]
            elif not remote_sizes:
                args += ["--listing", f"{base}/{folder}/"]
            result = subprocess.run(args, capture_output=True, text=True)
            if result.returncode != 0:
                print(f"  ! {folder}/index.json not generated: {(result.stderr or result.stdout).strip()}")
                continue
            tracks = json.loads((dest / "index.json").read_text(encoding="utf-8")).get("tracks") or []
            if not tracks:
                continue
            out[f"{folder}/index.json"] = (dest / "index.json").read_bytes()
            out[f"{folder}/index.html"] = (dest / "index.html").read_bytes()
            print(f"  {folder}/index.json: {len(tracks)} tracks")
    return out


def build_zip(
    skip_sizes: dict[str, int] | None = None,
    generated: dict[str, bytes] | None = None,
    with_presets: bool = False,
) -> bytes:
    """Zip WASM artifacts (plus pm/ mirrors), shared html host files, and `generated` (archive name -> bytes)."""
    generated = generated or {}
    matched = collect_deploy_files(with_presets)

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

    panel2_bytes: bytes | None = None
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for file in matched:
            if not file.is_file():
                continue
            archive_name = zip_entry_name(file)
            if archive_name in generated:
                continue  # e.g. a stale local songs/index.json; the generated one wins
            data = file.read_bytes()
            if archive_name.endswith(".1ink"):
                data = _to_utf8_bom(data)
                if archive_name == PANEL2_HOST:
                    panel2_bytes = data
            # WASM bundle artifacts (.wasm/.js/.1ijs/.3ijs/.worker.js) are a tightly
            # coupled set: the .wasm's compiled-in ASM_CONSTS call-site indices must
            # match the ASM_CONSTS array baked into its paired .js glue from the same
            # build. A same-name file that coincidentally has the same byte length as
            # what's already deployed (e.g. a trivial code change that doesn't shift
            # binary size) is not necessarily byte-identical, so skip-by-size must
            # never apply here — a false "unchanged" skip would leave a stale sibling
            # on the server and desync ASM_CONSTS between glue and binary, producing
            # "ASM_CONSTS[code] is not a function" at runtime. Always re-upload these.
            # Also covers the pm/ copies prepare_deploy_bundle.sh stages, their
            # .br/.gz siblings, and the builds/songs manifests.
            is_wasm_bundle_file = file in wasm_files
            always_upload = is_wasm_bundle_file or bool(ALWAYS_UPLOAD_RE.search(archive_name))
            _zip_write(zf, archive_name, data, skip_sizes, allow_size_skip=not always_upload)

            if is_wasm_bundle_file:
                for subdir in DEPLOY_MIRROR_SUBDIRS:
                    if file.name in mirrored_names:
                        continue
                    mirrored = f"{subdir}/{file.name}"
                    _zip_write(zf, mirrored, file.read_bytes(), skip_sizes, allow_size_skip=False)
                    mirrored_names.add(file.name)

        for archive_name, data in generated.items():
            _zip_write(zf, archive_name, data, skip_sizes, allow_size_skip=False)

        for alias, source in DEPLOY_PATH_ALIASES.items():
            source_path = HERE / source
            if source_path.is_file():
                _zip_write(zf, alias, source_path.read_bytes(), skip_sizes)
            else:
                print(f"  ! warning: {source} missing; skipped {alias} alias")

        # Keep production URL /1ink.1ink identical to panel2 (stop hand-editing drift).
        if panel2_bytes is not None:
            _zip_write(zf, PRODUCTION_HOST_ALIAS, panel2_bytes, skip_sizes)
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


def canonical_bundle() -> str | None:
    """``projectm-v.NNN-thread`` for PROJECTM_WASM_VERSION, or None if unreadable."""
    version_js = (HERE / "html" / "projectm-wasm-version.js").read_text(encoding="utf-8")
    match = re.search(r"PROJECTM_WASM_VERSION\s*=\s*'([^']+)'", version_js)
    return f"projectm-v.{match.group(1)}-thread" if match else None


def read_build_id(path: Path) -> tuple[str, dict[str, str]]:
    """Line 1 (source fingerprint + flavor tags) and the key=value lines after it."""
    lines = path.read_text(encoding="utf-8").splitlines()
    facts = dict(line.split("=", 1) for line in lines[1:] if "=" in line)
    return (lines[0].strip() if lines else ""), facts


def check_staged_bundle_is_current() -> str | None:
    """Return an error if the canonical staged bundle was not built from this tree.

    scripts/prepare_deploy_bundle.sh stages ``<bundle>.build-id`` next to the
    bundle: line 1 is the source fingerprint (scripts/wasm_source_fingerprint.sh)
    the link was made from. Uploading a bundle older than its sources is the
    worst failure this repo has, because the golden-image gate runs in CI, not here.
    """
    bundle = canonical_bundle()
    if bundle is None:
        return "could not read PROJECTM_WASM_VERSION from html/projectm-wasm-version.js"
    if not (HERE / f"{bundle}.wasm").exists():
        return None  # nothing staged for the canonical version; host files only
    stamp = HERE / f"{bundle}.build-id"
    if not stamp.exists():
        return f"{stamp.name} is missing: stage with scripts/prepare_deploy_bundle.sh"
    try:
        current = subprocess.run(
            ["bash", str(HERE / "scripts" / "wasm_source_fingerprint.sh")],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as error:
        detail = getattr(error, "stderr", "") or str(error)
        return f"could not fingerprint this tree (needs bash + git): {detail.strip()}"
    recorded, _ = read_build_id(stamp)
    if recorded != current:
        return (
            f"{bundle}.wasm was built from a different tree "
            f"(build-id {recorded}, this tree {current}); "
            "re-run scripts/prepare_deploy_bundle.sh"
        )
    return None


def _decompress_brotli(data: bytes) -> bytes:
    try:
        import brotli  # type: ignore[import-not-found]

        return brotli.decompress(data)
    except ImportError:
        pass
    # No brotli module: node is on any machine that staged the bundle
    # (prepare_deploy_bundle.sh runs scripts/generate_wasm_builds_manifest.mjs).
    result = subprocess.run(
        ["node", "-e", "process.stdout.write(require('zlib').brotliDecompressSync(require('fs').readFileSync(0)))"],
        input=data,
        capture_output=True,
        check=True,
    )
    return result.stdout


def check_staged_bundle_binaries() -> list[str]:
    """Every staged copy of the canonical bundle must be the binary the link produced.

    ``<bundle>.build-id`` records the sha256 of the .wasm and of the staged glue.
    The repo-root and pm/ copies, the .br/.gz siblings html/.htaccess serves to
    clients that accept them, and any legacy UTF-16/32 glue must all decode to
    those bytes. Anything that rewrote one of them after staging (a post-link
    optimiser, a minifier, a hand copy) would otherwise ship a binary no gate
    saw, and a different one depending on the client's Accept-Encoding.
    """
    bundle = canonical_bundle()
    if bundle is None or not (HERE / f"{bundle}.wasm").exists():
        return []
    stamp = HERE / f"{bundle}.build-id"
    if not stamp.exists():
        return []  # check_staged_bundle_is_current() reports it
    _, facts = read_build_id(stamp)
    expected = {"wasm": facts.get("wasm-sha256"), "js": facts.get("js-sha256")}
    if not expected["wasm"] or not expected["js"]:
        return [f"{stamp.name} records no binary hashes: re-stage with scripts/build_wasm.sh --stage"]

    errors = []
    legacy_encodings = {"1ijs": "utf-16", "3ijs": "utf-32"}
    for directory in (HERE, HERE / "pm"):
        for kind, digest in expected.items():
            base = directory / f"{bundle}.{kind}"
            candidates = [(base, lambda data: data)]
            candidates.append((base.with_name(base.name + ".gz"), gzip.decompress))
            candidates.append((base.with_name(base.name + ".br"), _decompress_brotli))
            if kind == "js":
                for suffix, encoding in legacy_encodings.items():
                    candidates.append(
                        (
                            directory / f"{bundle}.{suffix}",
                            lambda data, encoding=encoding: data.decode(encoding).encode("utf-8"),
                        )
                    )
            for path, decode in candidates:
                if not path.exists():
                    if path == base:
                        errors.append(f"{path.relative_to(HERE)} is missing")
                    continue
                try:
                    actual = hashlib.sha256(decode(path.read_bytes())).hexdigest()
                except (OSError, ValueError, subprocess.CalledProcessError) as error:
                    errors.append(f"{path.relative_to(HERE)} could not be decoded: {error}")
                    continue
                if actual != digest:
                    errors.append(
                        f"{path.relative_to(HERE)} has sha256 {actual[:12]}… (decoded), "
                        f"not the build-id's {kind} ({digest[:12]}…)"
                    )
    return errors


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
    parser.add_argument(
        "--allow-stale-wasm",
        action="store_true",
        help="Upload even if the staged canonical bundle's build-id does not match this tree",
    )
    parser.add_argument(
        "--check-bundle",
        action="store_true",
        help="Only check the staged bundle against this tree and its build-id (no network); "
        "exit 1 on any mismatch. What CI runs after scripts/build_wasm.sh --stage.",
    )
    parser.add_argument(
        "--with-presets",
        action="store_true",
        help="Also upload the preset corpora (presets/custom, presets/weeks) under their "
        "deployed names (custom_milk_fixed/, weeks_presets/); see DEPLOY_PRESET_DIRS",
    )
    parser.add_argument(
        "--no-song-index",
        action="store_true",
        help="Do not regenerate songs/ (and mp3_songs/, mod_songs/) index.json + index.html",
    )
    args = parser.parse_args()

    if args.check_bundle:
        problems = []
        bundle = canonical_bundle()
        if bundle is None or not (HERE / f"{bundle}.wasm").exists():
            problems.append(f"nothing staged for {bundle or 'the canonical version'}: run scripts/build_wasm.sh --stage")
        stale = check_staged_bundle_is_current()
        if stale:
            problems.append(stale)
        problems.extend(check_staged_bundle_binaries())
        if problems:
            report = "\n  ".join(problems)
            print(f"ERROR: staged bundle check failed:\n  {report}", file=sys.stderr)
            sys.exit(1)
        print(f"Staged bundle {canonical_bundle()} matches this tree and its build-id.")
        sys.exit(0)

    if requests is None:
        print("ERROR: deploy.py needs the requests package: pip install requests", file=sys.stderr)
        sys.exit(1)

    targets = _parse_targets(args.target)

    stale = check_staged_bundle_is_current()
    if stale:
        if not args.allow_stale_wasm and not args.dry_run:
            print(f"ERROR: {stale}\n(--allow-stale-wasm overrides)", file=sys.stderr)
            sys.exit(1)
        print(f"WARNING: {stale}", file=sys.stderr)

    # Not overridable: a mismatch here is not "old", it is a binary nobody tested.
    mismatched = check_staged_bundle_binaries()
    if mismatched:
        report = "\n  ".join(mismatched)
        if not args.dry_run:
            print(
                f"ERROR: staged bundle files do not match its build-id:\n  {report}\n"
                "Re-stage with scripts/build_wasm.sh --stage (nothing may modify the bundle afterwards).",
                file=sys.stderr,
            )
            sys.exit(1)
        print(f"WARNING: staged bundle files do not match its build-id:\n  {report}", file=sys.stderr)

    print(f"\n=== Deploying '{PROJECT_NAME}' via Contabo -> {', '.join(targets)} ===\n")

    print("Building zip archive...")
    # Per-target size maps can differ; first target is used for the shared zip
    # (server-side skip still applies on later targets).
    first_target = targets[0]
    skip_sizes = fetch_remote_sizes(DEPLOY_FOLDER or PROJECT_NAME, first_target)
    song_indexes = {} if args.no_song_index else build_song_indexes(skip_sizes, first_target)
    zip_bytes = build_zip(skip_sizes, song_indexes, with_presets=args.with_presets)
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
