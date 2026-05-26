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