# Web / Emscripten demo: Upgrade external FLAC player to postMessage PCM bridge

**Status**: Ready to implement on the player side  
**Related**: `diagnose-mod-flac` worktree + DIAGNOSIS_MOD_FLAC_PLAYER_CONNECTION.md

## Problem

The external FLAC player (https://test.1ink.us/flac-player and .su variant) contains a sender for feeding audio into the projectM WASM visualizer, but it only uses the legacy `BroadcastChannel("projectm-audio")` transport.

This fails in real usage because:
- BroadcastChannel is strictly same-origin.
- The player lives on different domains/subdomains from the main projectM demo pages.
- Popups (`window.open`) and embedded iframes both break the current bridge.

Result: Clicking the FLAC Player button opens the player, but no audio reaches the visualizer.

## Current Code (live in production)

```js
if (!window.opener) return () => {};
try {
  const t = new BroadcastChannel("projectm-audio");
  const n = new Float32Array(e.fftSize);
  ...
  const a = () => {
    e.getFloatTimeDomainData(n);
    t.postMessage({ type: "pcm", buffer: n.slice() });
    r = requestAnimationFrame(a);
  };
  ...
}
```

The host side in `html/projectm-core.html` has now been upgraded with a robust receiver that prefers `postMessage` while keeping the legacy channel as fallback.

## Proposed Fix

Add a primary `postMessage` path (works for both popups via `window.opener` and iframes via `parent`).

### Minimal Patch

See the attached diff: `patches/flac-player-bridge-upgrade-to-postmessage.diff`

Or apply this change around the existing bridge:

```diff
-    t.postMessage({type:"pcm", buffer: n.slice()});
+    const buf = n.slice();
+    t.postMessage({type:"pcm", buffer: buf, channels: 1});
+
+    // NEW: Primary cross-origin safe path
+    try {
+      if (window.opener) {
+        window.opener.postMessage({type: "pcm", buffer: buf, channels: 1}, "*");
+      } else if (window.parent && window.parent !== window) {
+        window.parent.postMessage({type: "pcm", buffer: buf, channels: 1}, "*");
+      }
+    } catch (ex) {
+      console.debug("[projectMBridge] postMessage failed (non-fatal):", ex);
+    }
```

## Recommended Extras

- Also expose a helper:
  ```js
  window.__projectM_sendPCM = (float32Array, channels = 1) => { ... }
  ```
- Clean up the channel on player close/pause.

## Acceptance Criteria

- When the FLAC player is opened as a popup from `projectm-core.html`, audio drives the visualizer.
- Works when embedded as iframe (in the variants that do this).
- No regression for any existing same-origin usage.

---

**Labels**: `enhancement`, `web`, `wasm`, `audio-integration`

**Related work**: See full diagnosis and host-side fixes in the `diagnose-mod-flac` branch.

---

## Resolution (in-repo sender, no bundle rebuild required)

The earlier `patches/flac-player-bridge-upgrade-to-postmessage.diff` targets the
player's *minified external bundle*, whose source we don't have. Instead, the
sender now lives in the in-repo player shell as a bundle-independent module:

- `html/flac-player/projectm-pcm-bridge.js` — patches the Web Audio graph at the
  prototype level: when any node connects to `context.destination`, it taps that
  node into a passive `AnalyserNode` and streams the time-domain PCM to the host
  via `postMessage` (opener for popups, parent for iframes) **and** the legacy
  BroadcastChannel. Emits the documented contract
  `{ type:'pcm', buffer:Float32Array, channels:1, sampleRate }`. No-ops when the
  page is opened standalone (not a feeder).
- `html/flac-player/index.html` — installs the bridge *before* loading the player
  bundle, so the prototype patches are in place when the bundle builds its graph.
- `tests/web/flac-pcm-bridge.test.mjs` — `node --test` coverage (feeder-mode
  detection, sender contract, the connect→tap→pump flow, and uninstall).

**Deployment dependency:** this fixes audio only if the host opens a player whose
served `index.html` includes the bridge — i.e. deploy `html/flac-player/` to
`flac.1ink.us` (the popup origin `projectm-core.html` opens, already on the host
receiver's allowlist), or point `localStorage.flacPlayerUrl` at the in-repo copy.