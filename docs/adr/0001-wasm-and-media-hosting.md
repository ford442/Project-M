# ADR 0001: How WASM builds, glue, songs and audio are hosted and loaded

- **Status:** accepted. Items 1, 2, 3 and 5 are implemented. Items 4 and 6 are designed here but not built.
- **Date:** 2026-10-16
- **Scope:** `html/` hosts, `html/.htaccess`, `deploy.py`, `scripts/prepare_deploy_bundle.sh`, the song folders on projectm.1ink.us, the FLAC player bridge

## Context

Several open bugs trace back to how the site is put together rather than to the
engine:

| Symptom | Cause |
|---|---|
| `?wasm=030`/`035`–`037` loaded UTF-16 `.1ijs` glue although UTF-8 `.js` was deployed | `buildWasmBundlePaths()` guessed the glue extension from a hardcoded list (`PROJECTM_WASM_UTF8_GLUE_VERSIONS = ['038','039']`). |
| `net::ERR_CONTENT_DECODING_FAILED`, then `RuntimeError: null function` from `_init` | `.1ijs`/`.3ijs` UTF-16/32 glue, gzipped on the fly by `mod_deflate` (ETag `…-gzip`, `Vary: Accept-Encoding,User-Agent`), fetched again by every pthread worker. |
| `application/x-javascript` for `.js`; 2-day `max-age` on bundle files that are redeployed under the same name (glue/wasm `ASM_CONSTS` mismatch after a redeploy) | No `ForceType`; caching left to `mod_expires`. |
| An 80 MB FLAC must download completely before it plays | The player fetches the whole file, then decodes it. |
| `/songs/` is an open Apache directory listing, which the hosts and the WASM glue scrape for the song catalog | `Options +Indexes`, no song index. |
| Several AudioContexts (the player iframe's, the host's worklet, the capture popup's); drift and doubled feeds | Each audio source owns its own graph and posts PCM separately. |

Production, measured on 2026-10-16 with `scripts/check_production_headers.mjs https://projectm.1ink.us --builds 039,038`, fails 14 of 42 checks: no `pm/builds.json`, an auto-indexed `/songs/`, `application/x-javascript`, `Vary: …User-Agent` and `max-age=172800` on every bundle file, `max-age=600` on the host page, and `.1ijs` still served as UTF-16.

## Decision

### 1. Versioned build manifest, `pm/builds.json` (implemented)

```json
{
  "schema": 1,
  "generatedAt": "2026-10-16T00:04:35.349Z",
  "default": "039",
  "latest": "039",
  "builds": {
    "039": {
      "glue": "pm/projectm-v.039-thread.js",
      "wasm": "pm/projectm-v.039-thread.wasm",
      "worker": null,
      "sha256": { "glue": "…", "wasm": "…" },
      "bytes": { "glue": 191202, "wasm": 1639147 },
      "api": ["add_preset_file", "…", "set_context_config", "set_rhythm_events", "…"],
      "status": "stable",
      "buildId": "…"
    }
  }
}
```

- **Generator:** `scripts/generate_wasm_builds_manifest.mjs`, run by `prepare_deploy_bundle.sh`. It lists every UTF-8 `pm/…js` + `.wasm` pair under the deploy root and carries over builds deployed earlier from the live manifest (`--merge`). The first time there is no live manifest, so `--fetch-missing <site>` downloads each version's glue and wasm instead. `api` comes from the glue's `Module["_name"] = wasmExports[…]` table, because the `.wasm` export names are minified. The output is validated with the same `parseWasmBuildsManifest()` the hosts use.
- **Loader:** `html/projectm-wasm-manifest.js` (`loadWasmBuildsManifest()`) fetches the manifest with `cache: 'no-cache'` and a 2.5 s timeout, then registers it with `projectm-wasm-version.js`. From then on `buildWasmBundlePaths()`, `normalizeWasmVersion()`, `getSelectableWasmVersions()` and `getDefaultWasmVersion()` answer from the manifest. Every failure (offline, a 302 to DreamHost's HTML 404 page, bad JSON, another schema) resolves `null` and leaves the built-in table in charge, so the manifest can improve a boot but never break one. `ProjectMContext.start()` and `bootProjectMSharedModule()` await it before resolving paths.
- **Picker and default:** `projectm_panel2.1ink` builds its version picker from the manifest. A version newer than the page's built-in list (say `?wasm=040`) becomes selectable without a host redeploy. `projectm-wasm-default-redirect.js` reads `default` from the manifest and falls back to its built-in constant after 1.2 s.
- **API gating:** in the render-worker topology the module is on the other side of `postMessage`, and `transport.supports()` used to answer `true` for every call. It now answers from the build's `api` list, so `ProjectMContext` skips calls the bundle does not export instead of sending a ccall that fails in the worker. For example, 038 has no `set_rhythm_events`, so `on('beat')` stays quiet instead of erroring. `wasmBuildHasApi()` does the same check for main-thread code.
- **Status:** `stable` | `beta` | `legacy` | `withdrawn`. The picker lists the first three. A withdrawn build still resolves, so old links keep working, but it is not offered. A build without an explicit status is `stable` if it is the default or the latest, else `legacy` (`--status 038=stable` overrides).

### 2. UTF-8 glue only (implemented)

- `prepare_deploy_bundle.sh` no longer makes `.1ijs`/`.3ijs`, and it deletes stale ones for the version it stages so `deploy.py` cannot upload them next to a newer `.js`. `PROJECTM_DEPLOY_LEGACY_GLUE=1` brings them back.
- `scripts/transcode_legacy_glue.sh` converts the four builds that were only ever deployed as UTF-16 (030b, 032, 033, 034) to UTF-8 `pm/…js` once, and copies their `.wasm` next to them; 030b and 032 lived only at the site root. The conversion is `iconv` only, so the text is identical (checked: pure ASCII, and each one references its own `.wasm`).
- `html/.htaccess` redirects `projectm-v.NNN-thread.{1ijs,3ijs}` with a 301 to the `.js` beside it, but only when that `.js` exists. Embeds that hardcode `.1ijs` keep working, and the UTF-16 files can then be deleted from the server.
- **Host pages (`.1ink`):** `deploy.py` now ships them as UTF-8 with a BOM, where it used to write UTF-16 LE with a BOM, and `.htaccess` declares `charset=utf-8`. A BOM decides the encoding before any header charset (WHATWG encoding sniffing), so pages already on the server as UTF-16 + BOM keep rendering under the new header, and a new UTF-8 + BOM page would render even under the old one. The pages also roughly halve in size. The `.1ink` extension stays: the URLs are public.

### 3. Correct headers (implemented)

`html/.htaccess`:

- **Encoding:** a WASM bundle file or `pm/builds.json` is served from its precompressed `.br`, then `.gz`, sibling when the client accepts that encoding and the sibling exists (`generate_wasm_builds_manifest.mjs --precompress` writes them; brotli takes the 039 `.wasm` from 1.6 MB to about 440 KB). Otherwise the file goes out as-is. `mod_deflate` never touches these files, `.br`/`.gz`, or audio, so there is exactly one `Content-Encoding` and no on-the-fly layer.
- **Types:** `text/javascript; charset=utf-8` (forced with `ForceType`, because the server config wins over `AddType` for `.js`), `application/wasm`, `application/json; charset=utf-8`, and `audio/flac`, each kept for the `.br`/`.gz` sibling too.
- **Caching:** frozen bundle versions are `public, max-age=31536000, immutable`. The newest version is `max-age=0, must-revalidate` (ETag/304), because it is redeployed under the same name. HTML, `.1ink`, `pm/builds.json` and `songs/index.json` are `no-cache`. Bundle files send `Vary: Accept-Encoding` instead of the server's `Accept-Encoding,User-Agent`.
- **COOP/COEP/CORP** are unchanged.
- **The whole site's rules:** `deploy.py` uploads this file over the live one on every deploy. Until now the live site depended on a hand-uploaded copy (`DirectoryIndex 1ink.1ink`, the HTTPS redirect, `Access-Control-Allow-Origin: *`, `ErrorDocument 404`), and each deploy dropped those rules, turning `/` into a 404 until the copy was re-uploaded. They are now in `html/.htaccess`, and `check_production_headers.mjs` checks `/`, the HTTPS redirect and CORS. That copy also set `.js` to `application/x-javascript`, which is where that type came from.
- **Checks:** `scripts/check_production_headers.mjs [site]` requests everything the way Chrome does, over raw `node:https`, and checks status, type, charset, encoding layers, cache policy, `Vary`, isolation headers, the decoded sha256 against the manifest, the legacy redirect, and the songs folder. `scripts/test_htaccess_apache.sh` runs that check against a local Apache configured like DreamHost (server-level `x-javascript`, on-the-fly deflate, `Vary: User-Agent`, `Options +Indexes`, a 2-day `mod_expires`), where the new rules pass all 76 checks and the old file fails 7. `.github/workflows/hosting_headers.yml` runs the Apache test on changes and the live check daily.

### 4. Streaming FLAC (designed, not built)

The player is a separately built bundle (`html/flac-player/`, source in the flac-player repository), hardened here by `decode-guard.js` without being rebuilt. The server side is ready: songs answer `Range` requests with `206`, `Accept-Ranges: bytes` and no `Content-Encoding` (checked by `check_production_headers.mjs`).

The change belongs in the player:

1. Read STREAMINFO from the first 64 KiB (`Range: bytes=0-65535`), skipping an ID3v2 prefix. This gives duration and bit depth before any audio downloads.
2. Fetch the rest as a `ReadableStream`. Feed `FLACDecoderWebWorker.decode(chunk)` with a carry-over buffer that only hands over whole frames: a frame starts at the sync code `0xFFF8`/`0xFFF9` and is confirmed by its header CRC-8. `decode-guard.js` already parses and rewrites frame headers (`parseFlacFrameHeader`, `normalizeFlacFrameHeaders`), so this is the code to reuse. Start playback after about 2 s of decoded audio.
3. To seek, map the time to a byte offset (a SEEKTABLE if present, else interpolate), issue a `Range` request from there, and resynchronise on the next valid frame header.
4. As a fallback for files the WASM decoder rejects, use a native `<audio>` element plus `MediaElementSource`. Browsers stream FLAC natively; this loses the 24-bit path but never the playback.

Acceptance: the first sound within 2 s of pressing Play on `Claws of the Angel.flac`, no full-file download (check the Network panel), and no `LOST_SYNC` at chunk boundaries.

### 5. Songs manifest (implemented)

- `scripts/generate_songs_manifest.mjs` writes `songs/index.json`: `{ schema: 1, tracks: [{ title, artist, url, file, format, duration, sampleRate, channels, bitsPerSample, bytes, id3? }] }`. FLAC metadata comes from STREAMINFO and the Vorbis comment block (after an ID3v2 prefix), WAV from its chunks. It also writes `songs/index.html`, a `<pre>` of `<a href>` lines shaped like the Apache listing. Every deployed WASM build's glue (`WasmJsBindings.cpp` `scanSongDirectory`) scrapes that shape and cannot be changed after the fact, so legacy builds keep their catalog.
- The songs mostly exist only on the server, uploaded out of band. `deploy.py` regenerates the index of each song folder (`songs/`, `mp3_songs/`, `mod_songs/`) on every deploy. It takes the file list from the deploy API's size map plus any local files, and the metadata from the local file or from a 64 KiB `Range` read of the public URL. Without a size map it reads the live listing instead. `--no-song-index` skips this.
- `projectm-song-loader.js` reads `index.json` first and falls back to scraping the listing.
- `html/.htaccess` turns auto-indexing off for the song folders (`Options -Indexes` inside `<If>`, which DreamHost permits in `.htaccess`). A folder is listed only through its generated `index.html`, and a folder without one returns 403 instead of a listing. Other folders, such as the weeks-on-fire presets the host still scrapes, are unchanged.

### 6. One shared AudioContext (designed, not built)

Today the FLAC player iframe owns an AudioContext, plays through it, and taps it with the bridge's capture worklet (`projectm-pcm-bridge.js`), which posts PCM to the host. The host feeds that into the engine's PCM ring (`projectm-external-pcm.js` enforces one producer and drops duplicates). The tab-capture popup and the host's own worklet each have another context.

Target:

1. The host page owns the only AudioContext and one AudioWorklet (`projectm-worklet-playback.js` already has it). Every source writes into it: local files, streams, and the player.
2. The worklet writes into the SharedArrayBuffer PCM ring the engine reads. In the render-worker topology that ring is already shared with the worker (`projectm-pcm-ring.js`, `WasmAudioBridge.cpp`), so the worker reads samples without a `postMessage` per block.
3. The player iframe becomes UI plus decoder. It posts decoded blocks (transferred `Float32Array`s, tagged with its producer ID and a sequence number like today) to the host, which plays them through the shared worklet, so the audio you hear and the PCM the engine sees come from one clock. The iframe's own AudioContext, and with it the capture tap, go away.
4. Migrate one source at a time behind the existing producer gate. Measure each step with the PCM HUD (`?pcmhud=1`): host rate ≈ engine rate ≈ sample rate, and overruns flat.

This needs the player rebuilt, like item 4, so the two should land together.

## Consequences

- Shipping a new build becomes a deploy plus a manifest entry. There are no edits to the host's version list, no extension guessing, and no redeploy for a new default.
- The first deploy has to put everything in place in one go, because each step only works once the previous one is on the server:
  1. `scripts/transcode_legacy_glue.sh https://projectm.1ink.us . 030b 032 033 034`
  2. `PROJECTM_BUILDS_ARGS="--status 038=stable" scripts/prepare_deploy_bundle.sh`. There is no live manifest yet, so it fetches 030 and 035–038 from the site to list them; later runs merge the live manifest instead.
  3. `python deploy.py --dry-run`. Check that it lists `pm/builds.json*`, the `.br`/`.gz` siblings, the transcoded `pm/…js`, and `songs/index.{json,html}`. Then `python deploy.py --target prod`.
  4. `node scripts/check_production_headers.mjs https://projectm.1ink.us --all-builds` and `scripts/verify_deploy_urls.sh`.
  5. `node scripts/test_flac_player_modes_playwright.mjs --base https://projectm.1ink.us --song <Claws of the Angel.flac> …` for every player mode, on 039 and 038.
  6. When the redirect checks pass, the `.1ijs`/`.3ijs` files can be deleted from the server.
- **Rollback:** the hosts work without the manifest, which is exactly what happens when it is missing. Reverting `.htaccess` restores the old transport. The song `index.html` keeps the glue's catalog working either way.
- **Risk:** if `Options` were not allowed in `.htaccess`, Apache would answer 500 for the whole site. DreamHost documents `Options -Indexes` in `.htaccess`, and step 4 catches it within seconds. To roll back, remove the `<If>` block; the generated `index.html` alone already hides the listing.
- **Known issue outside this repo:** the FLAC player's Web Audio and AudioWorklet backends never post a position update while playing, so its elapsed-time readout stays at 0:00 while audio plays (`scripts/test_flac_player_modes_playwright.mjs` reports it as a warning). This belongs with the player rebuild in item 4.
