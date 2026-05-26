# Diagnosis: projectM Connection to mod-player and flac_player

**Date:** Current session in `diagnose-mod-flac` worktree  
**Focus:** Why the integration between the projectM WASM visualizer and external MOD/FLAC players is not "going well".

## Overview of the Intended Architecture

projectM (libprojectM) consumes raw PCM via `projectm_pcm_add_float()` (and friends). In the Emscripten/WASM builds, audio can arrive via several paths:

1. **Internal Worklet Path** (`projectm_audio_processor.js` + `js_initialize_worklet_system_once` in `projectM_emscripten.cpp`): For local decoded WAV/MP3 etc. files. Batches mono PCM and posts 'pcmData' to main thread which copies to a pre-allocated WASM buffer and calls the wrapper.
2. **Stream Analyser Path**: Uses Web Audio AnalyserNode on a media element (`#audio-stream-element` or `#track`).
3. **External Player Path** (mod-player / flac_player): Intended for separate popup windows or iframes (`https://mod.1ink.us`, `https://flac.1ink.us`, `https://test.1ink.us/flac_player`) that perform actual decoding of MOD modules and FLAC files (which the browser can't do natively in all cases, or for tracker playback). They downmix to PCM and push it to the visualizer.

The "connection" for #3 lives in the hosting HTML/JS (not inside the WASM module itself).

## Current Implementation of the External Player Connection

Found primarily in:
- `html/projectm-core.html` (the "refactored core" UI)
  - Defines `AUDIO_CHANNEL_NAME = 'projectm-audio'`
  - `ensureAudioChannel()` creates a `BroadcastChannel`
  - `feedPCMToModule(buffer: Float32Array)`: 
    - `malloc(len*4)`
    - `HEAPF32.set(buffer, ptr>>2)`
    - Calls `Module._projectm_pcm_add_float_wrapper(0, ptr, len/2, 2)`  ← **always assumes stereo interleaved**
    - `free(ptr)`
  - `openFlacPlayer()` / `openModPlayer()`: `window.open(...)` popups + ensure channel
  - Button wiring attempts via `getElementById('flacPlayerBtn')` etc.
- `html/projectm-core.css`: Has placeholder styles (`.mod-player-btn`, `.flac-player-btn`)
- `projectM_emscripten.cpp`: Exports the `_projectm_pcm_add_float_wrapper` (EMSCRIPTEN_KEEPALIVE) and has the worklet/analyser paths. No knowledge of the BroadcastChannel.
- Various `.1ink` files (projectm.1ink, panel variants): 
  - Some embed FLAC as `<iframe src="https://.../flac_player">` inside a toggleable section.
  - No PCM feeding code at all for external players.
  - Dummy `flacPlayer()` stubs that only `console.log`.

The player pages themselves (the senders) are hosted externally and not present in this repository.

## Critical Issues Identified

### 1. BroadcastChannel is Fundamentally Broken for This Use Case (Cross-Origin)
- `BroadcastChannel` only delivers messages within the **exact same origin** (scheme + host + port).
- The players live at `mod.1ink.us`, `flac.1ink.us`, `test.1ink.us` (different hosts/subdomains from the typical host of the projectM page).
- Even same-site subdomains are separate origins. Messages from the popup/iframe are silently dropped.
- In the iframe embed case (`projectm.1ink`), cross-origin iframe → parent also cannot use BroadcastChannel.
- **Result**: PCM never arrives. Visuals stay silent when using the "player" buttons.

### 2. Dead / Dangling UI Wiring in projectm-core.html (and absent elsewhere)
- `document.getElementById('modPlayerBtn').addEventListener(...)` — **no such element exists anywhere in the file or its panel markup**. Will throw on load.
- `document.getElementById('flacPlayerBtn')...` — no element with that ID. The visible flac button in the panel is an anonymous `<button onclick="flacPlayer()">` which calls the no-op stub `function flacPlayer() { console.log... }`.
- The sophisticated `open*Player` + channel + feed functions are **completely unreachable dead code**.
- `projectm.1ink` (the primary full-featured UI) and panel variants have **zero** equivalent logic. They only have the flac iframe toggle (no message plumbing) and no MOD player UI at all.
- CSS has mod-player styles that are never applied to real buttons.

### 3. Unsafe / Inefficient PCM Transfer in `feedPCMToModule`
- **Per-packet malloc/free**: Every audio chunk does `Module._malloc(len*4); ... _free`. At audio rates (e.g. 86+ calls/sec for 512-sample blocks) this creates measurable overhead + potential WASM heap fragmentation/pressure (unlike the worklet path which pre-allocates one 2048-float buffer).
- **Hardcoded stereo assumption**:
  ```js
  Module._projectm_pcm_add_float_wrapper(0, ptr, len / 2, 2);
  ```
  - `len / 2` in JS (floating) then truncated when passed as unsigned int.
  - If the player ever sends mono (`Float32Array` of N samples for 1 channel), this produces wrong `samples_per_channel`, reads past the buffer (or interprets garbage as R channel), and passes `channels=2`.
  - Inside `PCM::AddToBuffer`, for channels>1 it does `samples[1 + i*channels]`. Mismatch = corruption or OOB in the JS view.
- No channel count in the message protocol. No validation. No support for the mono path used by the official worklet.
- No backpressure or dropping of late buffers.

### 4. Inconsistent and Incomplete Integration Across UI Variants
- "Core" (stripped) has partial (broken) popup code.
- Full `.1ink` files have rich UI but no external-player audio path.
- Iframe embed for FLAC exists in one variant but has no `postMessage` listener or forwarding to the WASM module.
- No shared module / utility for the connection logic.
- The Emscripten C++ side (`projectM_emscripten.cpp`) and built artifacts (`projectm-v.*.1ijs`) know nothing about it; it's all host-page glue.

### 5. Lack of Sender Specification / Contract
- No documentation or example of the exact message format the MOD/FLAC player pages are supposed to send (`{type: 'pcm', buffer: Float32Array}` via BC).
- No guidance on downmixing, sample rate handling, chunk sizing, or timing (projectM's internal buffers are fixed ~576 samples for analysis).
- Popups are easily blocked by browsers; iframes have autoplay/security restrictions.

### 6. Minor / Related Issues
- The `flacPlayer()` stub in core.html conflicts in name with the intended popup opener.
- No tracking of popup `close` events or recovery.
- `ensureAudioChannel()` is idempotent but attached listeners stay forever.
- In some paths, `pm_handle_value` is passed but the wrapper ignores it and uses the global `app_data.projectm_engine`.
- Potential for duplicate PCM if both a local track and an external player are active.

## Root Cause Summary

The feature was **sketched during rapid UI experimentation** (many AI-assisted custom presets, multiple HTML variants, "1ink" ecosystem) but never completed or hardened:

- Relied on an inappropriate IPC primitive (BroadcastChannel) for a cross-origin popup/iframe architecture.
- UI integration was left half-done (functions written, buttons never added or wired correctly).
- PCM handoff code has incorrect assumptions and perf pitfalls compared to the mature worklet path.
- The "core" refactoring intentionally stripped features but left this half-ported.
- No end-to-end testing possible without the external player pages, and no contract tests.

**Consequently, clicking the player buttons (where they exist) either does nothing, errors, or opens a player whose audio never reaches the visualizer.**

## Recommendations & Path to "Getting Going Well"

### Short Term (Make It Functional)
1. Switch the host-side receiver to `window.addEventListener('message', ...)` + `postMessage` from children (support both `window.opener` for popups and `parent` / `postMessage` to specific target for iframes).
2. Add proper button elements (or repurpose existing panel buttons) in `projectm-core.html` and wire the openers.
3. Port a minimal version of the receiver into `projectm.1ink` (at least for the existing FLAC iframe).
4. Fix `feedPCMToModule`:
   - Pre-allocate a reusable transfer buffer (mirroring `projectMAudioBufferPtr`).
   - Accept `{type:'pcm', buffer, channels?: 1|2 }` (default 2 for backward).
   - Compute `samplesPerChannel = buffer.length / (channels || 2)` safely; validate.
   - Pass the correct channel count to the wrapper.
5. Update (or document for) the external player pages to send via `postMessage` instead of (or in addition to) BroadcastChannel.

### Medium Term (Robustness)
- Define a small `ProjectMExternalAudio` helper module that both core and full UIs can import.
- Add origin allow-listing (even if using `'*'` initially).
- Support the same batching / 576-sample trimming as the analyser path.
- Expose a clean JS API from the Module for "external PCM source registration".
- Add a demo / test player stub inside the repo (or a simple AudioWorklet + file decode example) so the path can be exercised without external deps.
- Consider WebRTC DataChannel or a SharedWorker for more advanced multi-tab scenarios, but postMessage is sufficient and simplest.

### Long Term
- If MOD/FLAC support is important, evaluate bringing lightweight decoders into the WASM build itself (e.g. via Emscripten ports of libopenmpt + libflac, or using WebCodecs where possible + a tracker engine in JS). This would eliminate the popup/iframe dance entirely and the cross-origin headaches.
- Or keep the external players but make them first-class "audio sources" with a documented, versioned postMessage protocol.

## Files Requiring Changes

- `html/projectm-core.html` (primary broken implementation + missing buttons)
- `html/projectm-core.css` (button styles can stay)
- `html/projectm.1ink` + variants (to add the feature consistently)
- Possibly `projectM_emscripten.cpp` (minor: better exported helper for external PCM if desired)
- New: shared JS utility + DIAGNOSIS + usage docs
- External (out of scope here): the actual mod/flac player pages on the 1ink.us domains

This connection is not a libprojectM core issue — it is entirely in the surrounding web host / demo UI layer.

---

## Post-Fix Sender Contract (for the mod/flac player pages)

After the changes in `html/projectm-core.html`, the recommended way for a player page to push audio is:

```js
// From inside the popup (window.open case):
function sendPcmToProjectM(interleavedFloat32, numChannels = 2) {
  if (window.opener) {
    window.opener.postMessage({
      type: 'pcm',
      buffer: interleavedFloat32,   // L R L R ... or mono samples
      channels: numChannels
    }, '*');   // tighten to the exact origin of the projectM host in production
  }
}

// From inside an <iframe> embed:
function sendPcmToProjectM(interleavedFloat32, numChannels = 2) {
  if (window.parent) {
    window.parent.postMessage({ type: 'pcm', buffer: interleavedFloat32, channels: numChannels }, '*');
  }
}

// Call this periodically with downmixed chunks (e.g. every 256-1024 samples).
// projectM is happy with either mono (will duplicate) or stereo interleaved.
```

The receiver now:
- Always listens (postMessage + legacy BC).
- Uses a pre-allocated WASM buffer for small/medium chunks (no malloc churn).
- Correctly computes samplesPerChannel from total length / channels.
- Exposes `window.openModPlayer()`, `window.openFlacPlayer()`, and `window.feedPCMToModuleForDebug(buf, ch)` for manual testing.

---
## Live Analysis of the Actual Player Implementations (Fetched May 2026)

On 2026-05-26 the two real player deployments were inspected via their production bundles (using curl + targeted extraction on the ~1 MB minified React bundles).

### MOD / XM Player (`https://test.1ink.us/xm-player/index.html`)

- **Tech stack**: React 18 + **libopenmpt** (loaded from `https://wasm.noahcohn.com/libmpt/libopenmptjs.js` with careful pre-init via `window.libopenmptReady` Promise).
- Extremely solid engine (`OpenMPTWorkletEngine` + "native-worklet" C++/Wasm variant).
  - Two playback modes with shared WASM memory for the JS worklet path.
  - Full tracker features: pattern data via dozens of `_openmpt_module_get_pattern_row_channel_command` calls, `_poll_position`, VU data as Float32Array, seek by order+row, BPM, etc.
- Audio graph (simplified from bundle):
  ```
  AudioContext
    → (AudioWorkletNode or native C++ worklet)
    → AnalyserNode (fftSize=2048, smoothing 0.8)
    → StereoPanner
    → Gain
    → destination
  ```
- **Critical finding**: **Zero projectM bridge code exists today**.
  - 0 `BroadcastChannel`
  - 0 `window.opener` / `parent.postMessage` in the audio path
  - 0 mentions of `projectm-audio`, `pcm`, `projectM`, `feedPCM` etc.
- They already produce high-quality rendered stereo PCM internally. Adding a bridge is low-risk and re-uses all existing infrastructure.

### FLAC Player (`https://test.1ink.us/flac-player/index.html` and `.su` variant)

- Title: "FLAC Player with WebGPU".
- Single bundle (`bundle.d896f2679d3f7cda9fce.js`).
- **Has a sender** — but it is exclusively the legacy path we identified as broken:

```js
// Live production code (minified, de-obfuscated for clarity)
if (!window.opener) return () => {};
try {
  const t = new BroadcastChannel("projectm-audio");
  const n = new Float32Array(e.fftSize);
  let r;
  const a = () => {
    e.getFloatTimeDomainData(n);
    t.postMessage({ type: "pcm", buffer: n.slice() });
    r = requestAnimationFrame(a);
  };
  return r = requestAnimationFrame(a);
} catch(e) { console.debug("[projectMBridge] ...", e); }
```

- Strictly gated on `window.opener` (popup only).
- Also initializes WebGPU (`requestAdapter` / `requestDevice`, shaders, pipeline) — presumably for a live spectrum / waveform visualizer that runs next to the audio.
- 17 total `postMessage` calls, but the projectM one only travels through the BroadcastChannel.

### Live Inspection Conclusions

1. The FLAC player already implemented *exactly* what the old host code expected (BC + `{type:"pcm", buffer: Float32Array}` from analyser). This is why the user felt it "almost" worked.
2. The MOD player (musically the more interesting one) has **no integration at all**.
3. Both players are high-quality and already have the PCM we need. The only gap is a small modern `postMessage` sender (now supported on the host side after the fixes).
4. The four actions requested (doc update, host helper, patches, deep dive) have now been executed against the real running code.

All receiver-side problems previously diagnosed are confirmed by the live senders. The patches below give the players the minimal upgrade they need.