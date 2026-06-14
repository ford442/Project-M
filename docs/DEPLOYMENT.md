# Deployment

`deploy.py` uploads the compiled WASM/JS bundle (`*.wasm`, `*.1ijs`, `*.3ijs` in the
repo root) to `storage.noahcohn.com`, which pushes it to `projectm.1ink.us/` via a
persistent SFTP connection on the VPS side. No SFTP credentials are stored in this repo
for this path.

## Usage

```bash
export DEPLOY_TOKEN="your_long_token_from_vps_env"
python deploy.py
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

## Other deploy-related scripts (legacy / audit)

A repo-wide grep for `token|password|api_key` turned up additional **hardcoded SFTP
credentials** outside the scope of this doc's `deploy.py` flow:

- `deploy_old.py` — hardcoded SFTP `password`
- `upload_module.py` — hardcoded SFTP `username`/`password` (legacy direct-SFTP path,
  superseded by `deploy.py`)
- `scripts/colab_deploy.sh`, `scripts/upload_project.sh` — default SFTP password
  fallback (overridable via `PASSWORD`/`SFTP_PASS` env vars)

These were **not** modified as part of the `DEPLOY_TOKEN` fix above. If these
credentials are still live, they should be rotated on the VPS/SFTP side and the scripts
updated to require environment variables (no hardcoded fallback), matching the pattern
in this file.
