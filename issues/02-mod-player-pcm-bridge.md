# Web / Emscripten demo: Integrate projectM audio bridge into the MOD/XM player

**Status**: Needs implementation (currently has zero bridge)  
**Related**: `diagnose-mod-flac` worktree + DIAGNOSIS_MOD_FLAC_PLAYER_CONNECTION.md

## Problem

The excellent MOD/XM player at https://test.1ink.us/xm-player/index.html has **no integration** with the projectM WASM visualizer.

- It uses libopenmpt (via Emscripten) with a very high-quality dual audio engine (JS AudioWorklet + native C++/Wasm worklet).
- It already renders great audio and has rich position/pattern/VU data.
- When opened from the projectM demo, nothing is forwarded.

## Current Situation (from live bundle inspection)

- Strong audio architecture:
  - `OpenMPTWorkletEngine`
  - AnalyserNode (fftSize=2048) in the graph
  - Two engine modes ("worklet" and "native-worklet")
  - Excellent polling and event emission for position, BPM, channel VU, etc.
- **Zero** code that talks to projectM (no BroadcastChannel, no postMessage to opener/parent for PCM).

## Recommended Solution

Add a small audio bridge that forwards time-domain data (or ideally raw rendered samples) using the modern `postMessage` protocol that the host now supports.

### Preferred Quick Path (AnalyserNode)

Hook right after the analyser is created and connected (see full recommendation in `patches/mod-player-projectm-audio-bridge-recommendation.md`).

```js
if (window.opener || (window.parent !== window)) {
  const bc = new BroadcastChannel("projectm-audio");
  const buf = new Float32Array(analyser.fftSize || 2048);

  const tick = () => {
    analyser.getFloatTimeDomainData(buf);
    const copy = buf.slice();
    bc.postMessage({ type: "pcm", buffer: copy, channels: 1 });
    if (window.opener) window.opener.postMessage({ type: "pcm", buffer: copy, channels: 1 }, "*");
    if (window.parent !== window) window.parent.postMessage({ type: "pcm", buffer: copy, channels: 1 }, "*");
    requestAnimationFrame(tick);
  };
  tick();
}
```

### Better Long-Term Path

When using the native C++/Wasm worklet, expose the actual rendered stereo samples from the C++ side instead of re-deriving from an AnalyserNode. Suggested Emscripten exports:

- `_projectm_get_latest_pcm(float* out, int maxSamples)`
- Forward raw output buffer through the existing worklet `port.postMessage`

## Deliverables

- See the detailed guide + copy-paste code: `patches/mod-player-projectm-audio-bridge-recommendation.md`
- The host side (`html/projectm-core.html`) already has the matching robust receiver, visible launch buttons, and a local test sender for development.

## Acceptance Criteria

- Opening the MOD player from the projectM demo feeds real tracker audio into the visualizer.
- Works for both popup and (future) iframe usage.
- Minimal performance impact and clean teardown on stop/close.

---

**Labels**: `enhancement`, `web`, `wasm`, `audio-integration`, `libopenmpt`

**Related work**: Full diagnosis + host receiver improvements live in the `diagnose-mod-flac` branch.