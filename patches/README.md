# projectM + MOD/FLAC Player Bridge Patches

This directory contains the concrete deliverables for making the external players talk reliably to projectM.

## Files

- `flac-player-bridge-upgrade-to-postmessage.diff`  
  Minimal unified diff to upgrade the existing BroadcastChannel sender in the FLAC player to also use the modern `postMessage` path (opener + parent). Backward compatible.

- `mod-player-projectm-audio-bridge-recommendation.md`  
  Detailed integration guide + copy-paste ready code for the MOD/xm-player (which currently has zero bridge code). Shows both the quick AnalyserNode approach (matching what FLAC already does) and the higher-fidelity native worklet path.

These patches were produced after live inspection of the production bundles on 2026-05-26.

Apply the FLAC diff to the player source, then test by loading `html/projectm-core.html?debugSender` (the local test helper) or the real players after they are updated.

The host side (`html/projectm-core.html`) already contains the matching robust receiver + visible launch buttons + local test sender simulator.

## Host Receiver Contract

The browser host pages import `html/projectm-external-pcm.js`, which listens for both modern `postMessage` PCM and the
legacy same-origin `BroadcastChannel("projectm-audio")` path.

External player pages should send PCM chunks like this:

```js
window.opener.postMessage({ type: 'pcm', buffer: Float32Array, channels: 1|2, sampleRate: 44100 }, '*');
```

Use `window.parent.postMessage(...)` instead when the player is embedded as an iframe. The host accepts messages from
`https://mod.1ink.us`, `https://flac.1ink.us`, and `https://test.1ink.us` by default. Override the allowlist with a
comma-separated `localStorage.externalPcmOrigins` value on the host page when testing other origins.
