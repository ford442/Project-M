# Deployment

`deploy.py` uploads the compiled WASM/JS bundle and shared HTML host modules to
`storage.noahcohn.com`, which SFTPs them onto DreamHost using credentials that
live only on the Contabo storage VPS. No SFTP passwords are stored in this repo.

## Staging vs production

| `target_site` | Contabo env | Remote path | Public URL |
|---------------|-------------|-------------|------------|
| `test` (default) | `DEPLOY_BASE_DIR` | `{base}/projectm.1ink.us/` | `https://test.1ink.us/projectm.1ink.us/` |
| `go` | `DEPLOY_BASE_DIR_GO` | `{base}/projectm.1ink.us/` | `https://go.1ink.us/projectm.1ink.us/` |
| `prod` | `DEPLOY_BASE_DIR_PROD` | `{base}/projectm.1ink.us/` | `https://projectm.1ink.us/` |

Production requires `DEPLOY_BASE_DIR_PROD=/home/ford442` on the **storage**
VPS (`storage.noahcohn.com`, currently `173.249.14.134` — not every Contabo box).
Until that env var is set and the deploy service restarted, `python deploy.py
--target prod` cannot update DreamHost production.

`1ink.1ink` is packaged as a UTF-16 copy of `projectm_panel2.1ink` at zip time —
do not hand-edit production `1ink.1ink`.

## What gets deployed

WASM artifacts at the **repo root** (after `scripts/prepare_deploy_bundle.sh`):

- `projectm-v.<ver>-thread.wasm`
- `projectm-v.<ver>-thread.js` (UTF-8 glue; preferred by hosts)
- `projectm-v.<ver>-thread.1ijs` (UTF-16 wrapper around the `.js` glue)
- `projectm-v.<ver>-thread.3ijs`
- `projectm-v.<ver>-thread.worker.js` (when Emscripten emits a separate worker)

Each WASM artifact is uploaded **twice**: once at the site root and again under
`pm/`. Hosts prefer `./pm/projectm-v.<ver>-thread.js`; the `.wasm` sibling is
resolved relative to that script URL. Deploying only to the site root (without
the `pm/` mirror) produces HTTP 404 HTML responses and the browser error
**Unexpected token '<'** when parsing the missing script.

`scripts/build_wasm_smoke_wrapper.sh` always emits `projectm-v.030-thread.*`
(CI smoke tag). `prepare_deploy_bundle.sh` renames those files to the deploy
version **and rewrites** the Emscripten `locateFile("projectm-v.030-thread.wasm")`
string inside the glue JS before running `iconv`. Renaming alone leaves the
browser fetching `./pm/projectm-v.030-thread.wasm`, which soft-404s as UTF-16
HTML (WASM magic `3c 00 21 00`) and aborts instantiation.

Shared browser modules and demo hosts from `html/` (flattened to the deploy
root, because hosts `import './projectm-*.js'`):

- `projectm-*.js`, `projectm-*.1ink` (iconv'd to UTF-16 LE at zip time),
  `1ink.1ink` (alias of `projectm_panel2.1ink`), `projectm-core.html`,
  `projectm-core.css`

The active bundle version is defined once in `html/projectm-wasm-version.js`
(`PROJECTM_WASM_VERSION` / `PROJECTM_WASM_BUNDLE`, currently `projectm-v.036-thread`).
Keep it aligned with `scripts/prepare_deploy_bundle.sh` and
`scripts/verify_deploy_urls.sh` (checked by `scripts/verify_wasm_version_sync.sh`).

First-party hosts also expose a WASM version picker (`?wasm=030|030b|032|033|034|035|036`).
Each version is a distinct filename (`projectm-v.<ver>-thread.*`), so deploying a new
tag does not overwrite older CDN artifacts. The host default (`?wasm=` when omitted)
is `PROJECTM_WASM_DEFAULT_VERSION` in `html/projectm-wasm-version.js` (currently `032`)
and may temporarily lag the latest bundle when that tag has known regressions.

## Usage

```bash
# 0. Activate Emscripten (once per shell). SDK 3.1.74 recommended.
source /path/to/emsdk/emsdk_env.sh

# 1. Build + install libprojectM static libs for wasm (required before staging)
INSTALL_DIR=install scripts/build_wasm_install.sh

# 2. Build wrapper + stage artifacts at repo root and pm/
PROJECTM_WASM_VERSION=036 \
  INSTALL_DIR=install OUT_DIR=cmake-build/wasm-smoke \
  scripts/prepare_deploy_bundle.sh

# 3. Upload (ships root WASM, pm/ mirror, and html/projectm-*.js hosts)
export DEPLOY_TOKEN="your_long_token_from_vps_env"
python deploy.py --dry-run              # optional: preview bundle contents
python deploy.py                        # staging: test.1ink.us/projectm.1ink.us/
python deploy.py --target go            # staging: go.1ink.us/projectm.1ink.us/
python deploy.py --target prod          # production: projectm.1ink.us/ (needs DEPLOY_BASE_DIR_PROD)
python deploy.py --target test,go,prod  # all configured targets

# 4. Verify (no HTML 404s under pm/)
scripts/verify_deploy_urls.sh https://test.1ink.us/projectm.1ink.us/ projectm-v.036-thread
scripts/verify_deploy_urls.sh https://projectm.1ink.us/ projectm-v.036-thread
scripts/check_coop_coep.sh https://projectm.1ink.us/
```

`deploy.py` **requires** `DEPLOY_TOKEN` to be set in the environment and exits with an
error (no upload attempt) if it is missing or empty. There is no default/fallback token
in source — see `.env.example` for a template you can copy to `.env` and `source` (or
load with your shell/CI's dotenv support) before running the script.

## Obtaining / rotating `DEPLOY_TOKEN`

`DEPLOY_TOKEN` is the value of the deploy service's token environment variable on the
Contabo VPS (used by `storage.noahcohn.com`'s `/api/deploy/<project>/bundle` endpoint via
the `X-Deploy-Token` header). To rotate it:

1. On the VPS, generate a new token value and update the deploy service's environment
   (the service that backs `storage.noahcohn.com`).
2. Restart/reload that service so it picks up the new token.
3. Update `DEPLOY_TOKEN` in your local `.env`/shell and in any CI secret stores that run
   `deploy.py`.
4. Treat the old token as invalid — if it was ever committed to git history, also assume
   it is compromised and confirm the service rejects it after rotation.

## Least privilege

- `DEPLOY_TOKEN` should only grant access to the `project-m` deploy endpoint
  (`/api/deploy/project-m/bundle`), not broader VPS/SFTP access.
- Prefer per-environment or per-CI-job tokens where the deploy service supports it, so a
  single leaked token has limited blast radius and can be revoked independently.
- Never `print()`/log the token value. `deploy.py` only sends it as a request header.

## Cross-Origin Isolation (COOP/COEP)

The Emscripten build is compiled with `-s SHARED_MEMORY=1 -pthread -s WASM_WORKERS=1`
(`CMakeLists.txt`, lines ~160–207) for multi-threaded audio/render workers and
`SharedArrayBuffer`-backed PCM ring buffers (`html/projectm-render-worker-host.js`).
Browsers only enable `SharedArrayBuffer` and pthreads on pages that are **cross-origin
isolated** — i.e. served with both:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

(`credentialless` is also accepted for COEP — see "Cross-origin iframes" below.) Without
both headers, `window.crossOriginIsolated` is `false` and this build's pthread runtime
cannot start.

### Example server configs

**nginx:**

```nginx
location / {
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Cross-Origin-Embedder-Policy "require-corp" always;
}
```

**Caddy:**

```caddyfile
projectm.1ink.us {
    header {
        Cross-Origin-Opener-Policy "same-origin"
        Cross-Origin-Embedder-Policy "require-corp"
    }
    file_server
}
```

**Cloudflare Pages** (`_headers` file in the deployed bundle's root):

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```

For a Cloudflare Worker fronting the origin, set the same two headers on the response
before returning it.

### Fallback behavior when isolation is unavailable

`html/projectm-init-errors.js` exports `checkCrossOriginIsolation()`, called by every
primary host (`projectm-core.html`, `projectm.1ink`, `projectm_new.1ink`,
`projectm_panel.1ink`, `projectm_panel2.1ink`) at the start of `attemptInit()`, *before*
the WASM module is loaded. If `window.crossOriginIsolated` is `false`, it shows the
`#pm-init-error` overlay (code `4`, see `docs/EMSCRIPTEN.md#init-error-codes`) with a
message explaining that the page is missing COOP/COEP headers, and `attemptInit()`
returns without attempting to load the module. This turns what would otherwise be a
cryptic pthread/`SharedArrayBuffer` exception (or a silently-blank canvas) into a clear,
actionable error — there is no automatic single-threaded degrade path; this build
requires cross-origin isolation to run at all.

### Cross-origin iframes and the external-PCM `postMessage` path

`Cross-Origin-Embedder-Policy: require-corp` blocks any cross-origin subresource
(including `<iframe>` embeds) that does not itself send
`Cross-Origin-Resource-Policy: cross-origin` (or `cross-origin`/`same-origin` CORP as
appropriate). This can affect embedded MOD/FLAC players hosted on a different origin. If
those third-party players cannot add CORP headers, use:

```
Cross-Origin-Embedder-Policy: credentialless
```

instead of `require-corp` — `credentialless` still enables `crossOriginIsolated` /
`SharedArrayBuffer`, but allows cross-origin subresources/iframes to load without CORP
(their requests are sent without credentials).

The `postMessage`-based external PCM path (`html/projectm-external-pcm.js`, used by
`?debugSender` and embedded players) is **unaffected either way** —
`window.postMessage` between frames does not require COEP/CORP and works identically
with or without cross-origin isolation.

### CI / deploy-time check

`scripts/check_coop_coep.sh [URL]` runs `curl -I` against a deployed URL (default
`https://projectm.1ink.us/`) and verifies both headers are present with an accepted
value, exiting non-zero if not:

```bash
scripts/check_coop_coep.sh https://projectm.1ink.us/
```

Run this after deploying (e.g. as a follow-up step to `python deploy.py`, or in CI
against a staging URL) to catch a server config regression before it breaks
threaded/audio features in production. You can also verify manually in the browser
console on the deployed page: `crossOriginIsolated` should be `true`.

## Troubleshooting: `Unexpected token '<'` / panel 404s

| Symptom | Typical cause | Fix |
|---------|---------------|-----|
| `Unexpected token '<'` loading `projectm-v.*.1ijs` | `./pm/…` path 404 (Apache returns HTML) | Re-run `python deploy.py` after `prepare_deploy_bundle.sh` so `pm/` mirrors exist; or copy all four artifacts into your site's `pm/` folder. Hosts also fall back to `./projectm-v.*-thread.1ijs` at the site root when `pm/` is missing (`resolveWasmScriptUrl()` in `projectm-init.js`). |
| Module loads but WASM fails with magic `3c 00 21 00` / wrong MIME `text/html` | Glue still embeds `projectm-v.030-thread.wasm` after a version rename; `locateFile` requests `./pm/projectm-v.030-thread.wasm`, which soft-404s as the UTF-16 HTML ErrorDocument | `prepare_deploy_bundle.sh` must rewrite smoke-tag strings inside the `.js` before `iconv` (not only `mv` the files). Hosts also pass `buildProjectMLocateFile()` as a runtime safety net. Redeploy after rebuilding the bundle. |
| Module loads but WASM fails | `.wasm` missing next to the `.1ijs` under the same directory | Deploy/copy `pm/projectm-v.<ver>-thread.wasm` alongside the `.1ijs` |
| Root WASM 200 but `pm/` + `projectm-*.js` 302 | Legacy SFTP uploaded only `.wasm`/`.1ijs` to site root | Run `python deploy.py` (not a legacy direct-SFTP script). It zips root WASM, auto-mirrors under `pm/`, and flattens `html/projectm-*.js` + `projectm_panel2.1ink` to the deploy root. Preview with `python deploy.py --dry-run`. |
| Duplicate script tags (root + `pm/`) | Custom host loads `./projectm-v.*.1ijs` and `./pm/…` | Load **only** from `./pm/` via `PROJECTM_WASM_SCRIPT` in `projectm-init.js` |
| `verify_deploy_urls.sh` green but browser still fails | Old verifier only checked HTTP 200 | Current script rejects `text/html` soft-404s, checks WASM magic `00 61 73 6d`, and ensures the glue references `${BUNDLE}.wasm` rather than a stale `projectm-v.030-thread.wasm` |
| `init()` throws `TypeError: ASM_CONSTS[code] is not a function` | A stale `.wasm` (or `.js`) sibling was left on the server from a previous deploy of the same version tag, so the `.wasm`'s compiled-in `ASM_CONSTS` call-site indices no longer match the `ASM_CONSTS` array baked into the currently-served `.js` glue — Emscripten does not guarantee stable `ASM_CONSTS` ordering across builds, even for small unrelated code changes | Redeploy: re-run `prepare_deploy_bundle.sh` (same or bumped version) then `python deploy.py`. `deploy.py`'s bandwidth-saving skip-by-size optimization (see `fetch_remote_sizes`) never applies to `projectm-v.*-thread.{wasm,js,1ijs,3ijs,worker.js}` — a same-size-but-different-content rebuild would otherwise silently leave one half of the pair stale. If you still see this after redeploying, hard-refresh (bypass any CDN/browser cache) so the browser doesn't mix a cached `.js` with a freshly fetched `.wasm` or vice versa. |

Custom hosts on other domains must mirror the full `pm/` directory locally (or
symlink to `https://projectm.1ink.us/pm/…` with CORP headers). Loading from
`js.1ink.us` only works if that host also carries the complete `pm/` tree.

## Other deploy-related scripts (legacy / audit)

A repo-wide grep for `token|password|api_key` previously turned up additional
**hardcoded SFTP credentials** outside the scope of this doc's `deploy.py` flow:

- `deploy_old.py`, `upload_module.py` — direct-SFTP scripts hardcoding the same
  plaintext password, fully superseded by `deploy.py`; deleted from the tree.
- `scripts/colab_deploy.sh`, `scripts/upload_project.sh` — Colab/manual SFTP
  helpers, kept (still useful outside the `deploy.py` token flow) but now
  **require** `PASSWORD`/`SFTP_PASS` to be set — no hardcoded fallback.

**The plaintext password itself was committed to git history** before this cleanup
(it is gone from the current tree, but still recoverable from old commits until the
history is rewritten). If that SFTP password is still live on the `1ink.us` VPS,
rotate it now — deleting/fixing the scripts does not invalidate a credential that
was already exposed.
