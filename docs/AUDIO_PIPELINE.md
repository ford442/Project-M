# Audio pipeline (B3HD / WASM)

How audio reaches preset equations and shaders, how to verify reactivity, and known
limitations. Companion to issue [#115](https://github.com/ford442/Project-M/issues/115)
(Preset Modernization M2).

## End-to-end flow

```mermaid
flowchart LR
  subgraph ingress [JavaScript producers]
    WL[AudioWorklet\nprojectm_audio_processor.js]
    ST[Media element\nMediaElementAudioSourceNode]
    EXT[External PCM\nprojectm-external-pcm.js]
    SYN[Synthetic test\nprojectm-synthetic-audio.js]
  end
  subgraph wasm [WASM / libprojectM]
    PCMRING[(PCM ring\n16384 stereo frames\nWasmPcmRing.cpp)]
    DRAIN[render_frame\npcm_ring_drain]
    ADD[projectm_pcm_add_float\nPCM::Add]
    RING[(576-sample ring\nper channel)]
    UPD[PCM::UpdateFrameAudioData]
    FFT[MilkdropFFT]
    LOUD[Loudness bass/mid/treb]
    ALIGN[WaveformAligner]
    FRAME[FrameAudioData]
    EQ[per_frame / per_pixel / shaders]
  end
  WL --> PCMRING
  ST --> WL
  EXT --> PCMRING
  SYN --> PCMRING
  PCMRING --> DRAIN
  DRAIN --> ADD
  ADD --> RING
  RING --> UPD
  UPD --> FFT --> LOUD
  UPD --> ALIGN
  FFT --> FRAME
  ALIGN --> FRAME
  LOUD --> FRAME
  FRAME --> EQ
```

Each rendered frame calls `PCM::UpdateFrameAudioData()` **once** (see
`ProjectM.cpp`). That step:

1. Copies the circular input buffer → aligned waveform (480 samples exposed to presets)
2. Runs FFT → 512-bin spectrum (left/right)
3. Aligns waveforms to previous frame (calmer motion)
4. Updates bass / mid / treb beat-detection values + attenuated variants

Preset code reads these via evaluator variables (`bass`, `bass_att`, `mid`, `treb`,
`value1`/`value2` spectrum samples, waveform arrays in custom waves, etc.).

## Constants (C++)

| Symbol | Value | Role |
|--------|-------|------|
| `AudioBufferSamples` | 576 | Internal PCM ring + FFT input window |
| `WaveformSamples` | 480 | Waveform data exposed per frame |
| `SpectrumSamples` | 512 | FFT output bins |

Defined in `src/libprojectM/Audio/AudioConstants.hpp`.

Beat bands split the spectrum into sixths (`Loudness::Band` in `Loudness.hpp`):

- **bass** — bins 0–85
- **mid** — bins 86–170
- **treb** — bins 171–255

Relative values (`bass`, `mid`, `treb`) revolve around **1.0**; spikes on transients,
quieter during silence. Attenuated variants (`bass_att`, …) change more slowly.

## The PCM ring: one ingest

Every producer writes into a single ring buffer that lives in the WASM heap and
is owned by `src/wasm/WasmPcmRing.cpp`. `render_frame()` drains everything
written since the last frame and hands it to `projectm_pcm_add_float()` in one
**stereo** call.

| | |
|---|---|
| Capacity | 16384 stereo frames (~0.37 s at 44.1 kHz) |
| Layout | `int32[4]` header — write index, capacity, read index, overruns — plus `float32[capacity * 2]` interleaved stereo |
| Handshake | producers publish the write index with `Atomics.store`; the drain reads it with a sequentially-consistent atomic load |
| Indices | frame counts wrapping at `capacity * 1024`, so neither side overflows int32 during a long session |
| Overrun policy | a drain that finds more than `capacity` frames outstanding skips forward to the newest ones and bumps the overrun counter — it skips rather than tearing |

Producers write at **audio rate**, not frame rate. A dropped animation frame
delays the audio by one frame instead of discarding a frame's worth of samples.

Descriptor exports (`get_pcm_ring_data_ptr`, `get_pcm_ring_header_ptr`,
`get_pcm_ring_capacity_frames`, `get_pcm_ring_index_modulus`) let JavaScript map
views over the ring; `html/projectm-pcm-ring.js` is the host-side writer, and
`projectm_audio_processor.js` writes each 128-sample quantum directly when the
page is cross-origin isolated.

### Transports

There is one ingest and two transports into it:

| Transport | When | Path |
|-----------|------|------|
| Direct ring write | cross-origin isolated (COOP/COEP), so the WASM heap is a `SharedArrayBuffer` | producer → ring |
| `postMessage` | no cross-origin isolation | producer → main thread / worker → same ring |

Both land in the same ring with the same overrun policy. The same holds for the
OffscreenCanvas render worker: the module there owns its ring and drains it in
`render_frame()`, and the host either writes it directly (descriptor posted back
over `pcm-ring`) or posts chunks the worker writes on arrival.

### What this replaced

`js_feed_stream_data_to_projectm` polled an `AnalyserNode` once per animation
frame and forwarded the newest **576 mono** samples of a 2048-sample window. At
48 kHz a 60 Hz page produces ~800 samples per frame, so ~28% of the signal was
never analysed, stereo separation was lost before the engine saw it, and the code
could only run on the main thread because it reached for `window` and
`document`. Both it and `js_initialize_stream_analyser` are gone.

## JavaScript ingress paths

### Single-active-source policy (`AudioSourceRouter`)

Multiple ingress paths can coexist in one host page (worklet decode, `#track`
stream analyser, external `postMessage` PCM, synthetic debug feeds). Without
coordination they all call `projectm_pcm_add_float` and **double-feed** the
engine.

`html/projectm-audio-source-router.js` enforces an **exclusive** policy by
default:

| Active source | Element (`#audio-stream-element`) | Worklet (`pl()`) | External PCM |
|---------------|-----------------------------------|------------------|--------------|
| `none` | off | stopped | dropped |
| `element` | connected (`set_audio_source_to_stream(true)`) | stopped | dropped |
| `external` | off | stopped | accepted |
| `worklet` | off | playing | dropped |

- **`ProjectMContext`** creates a router from `audioSource` (`element` /
  `external` / `none`) and wires `projectm-external-pcm.js` through
  `feedGate` + `wrapExternalFeed`.
- **`projectm-core.html`** shares one router with `autoSwitchOnFeed: true` so
  the first FLAC/MOD PCM chunk or `pl()` call promotes that path and mutes the
  others.
- Status is exposed as `context.getAudioSourceStatus()` and the custom-element
  event **`pm-audio-source`** (`detail`: `{ activeSource, mode, streamEnabled,
  externalEnabled, workletAllowed }`).

**Mix mode** (`mode: 'mix'`) is reserved for a future multi-source blend;
it is documented but not implemented — behaviour matches exclusive until
designed.

| Path | File | Feed size | Preprocessing |
|------|------|-----------|---------------|
| **Worklet** (local decode) | `projectm_audio_processor.js` | 128-frame quantum, stereo | none — written straight to the ring |
| **Media element** | `html/projectm-audio-element-source.js` → the same worklet | 128-frame quantum, stereo | none |
| **External PCM** | `html/projectm-external-pcm.js` | whole chunk, stereo | optional `externalPcmGain` |
| **Synthetic** | `html/projectm-synthetic-audio.js` | whole chunk | none |
| **Legacy uint8** | `add_audio_data()` | variable | Mono 8-bit centered at 128 (does not use the ring) |

FLAC “Start/Change Song” uses the worklet path: the `./flac/` decoder posts a WAV on
`BroadcastChannel('file')`, WASM writes it to MEMFS and calls `pl()`. If
`projectMWorkletNode_Global_Cpp` is missing, playback never starts — hosts must call
`ensureWorkletReady()` on the music gesture and `installWorkletPlaybackSafetyNet()` after init
(`html/projectm-worklet-playback.js`).

All float paths write the same ring, so beat detection sees the same signal
regardless of source — there is no per-path analysis window left to keep in sync.

### External PCM tuning

```javascript
localStorage.externalPcmGain = "1.8";  // boost quiet FLAC/MOD analyser levels
setupExternalAudioReceiver({ debugRms: true });  // log RMS per chunk
```

See `docs/EMSCRIPTEN.md` § External Audio Sources for manual parity checks against
`#track` on `milk011.milk`.

### Synthetic / debug

| Tool | Enable | Purpose |
|------|--------|---------|
| `?audioTest=1` | `projectm-core.html` | Panel: silence / bass / mid / treble / beat / sweep |
| `?debugSender=1` | `projectm-core.html` | Local tone/mic → external PCM bridge |
| `window.feedPCMToModuleForDebug(buf, ch)` | always in core | Direct feed from console |

Generators live in `html/projectm-synthetic-audio.js`.

## External PCM sender / receiver contract

### Transport

| Channel | When to use | Origin check |
|---------|-------------|--------------|
| `window.postMessage` / `parent.postMessage` / `window.opener.postMessage` | Cross-origin popups and iframes | **Required** — receiver allowlist |
| `BroadcastChannel('projectm-audio')` | Same-origin embeds only | Not applicable (same page) |

Player-side helper: `html/flac-player/projectm-pcm-bridge.js` (`createPcmSender`,
`installProjectMPcmBridge`).

### Message shape (sender → host)

```javascript
{
  type: 'pcm',              // required discriminator
  buffer: Float32Array,     // interleaved when channels === 2
  channels: 1 | 2,          // default stereo if omitted
  sampleRate: 44100         // optional metadata (not resampled by host)
}
```

### Host preprocessing (receiver)

1. **Origin allowlist** — `setupExternalAudioReceiver({ allowedOrigins: [...] })`
   or `<project-m-visualizer external-pcm-origins='["https://player.example"]'>`.
   Untrusted `postMessage` origins are ignored (debug log only).
2. **Router gate** — when another source is active, chunks are **dropped** (not
   queued). See `AudioSourceRouter.externalFeedGate()`.
3. **Gain** — multiply by `externalPcmGain` (default `1.0`, overridable via
   `localStorage.externalPcmGain` or `setExternalPcmGain()`).
4. **Feed** — write the whole chunk into the PCM ring. Chunks are no longer
   trimmed to 576 frames: that trim only existed to mirror the analyser poll,
   which could forward one window per animation frame and dropped the rest.

### Queue behaviour (module not ready)

If WASM is not initialized yet, up to **24** chunks are retained; additional
chunks drop the **oldest** entry. A 100 ms flush interval replays the queue once
`Module` can accept PCM.

### Fixture tests

```bash
node --test tests/web/projectm-external-pcm.test.mjs \
  tests/web/projectm-audio-source-router.test.mjs \
  tests/web/projectm-pcm-ring.test.mjs \
  tests/web/projectm-audio-element-source.test.mjs
```

Optional Playwright host-layer smoke (no WASM build required):

```bash
node scripts/test_external_pcm_router_playwright.mjs
```

See `tests/wasm-smoke/external_pcm_router.html` — mock `postMessage` producer +
`AudioSourceRouter` gate against a stub `Module`.

## WASM initialization

- `projectm_set_beat_sensitivity(pm, 1.50)` at init (`projectM_emscripten.cpp`)
- Sensitivity scales detection **after** PCM ingestion; fix amplitude/window parity first
  when comparing sources.

## Verification

### 1. Native unit tests (recommended, no GL)

```bash
cmake -DBUILD_TESTING=ON ...
cmake --build cmake-build --config Debug --target projectM-unittest
./cmake-build/tests/libprojectM/Debug/projectM-unittest --gtest_filter=PCMAudioReactivity.*
```

`tests/libprojectM/PCMAudioReactivityTest.cpp` feeds synthetic sine/silence/beat
impulses directly into `PCM` and asserts:

- Silence → near-zero waveform
- Tone → non-zero waveform + spectrum
- 80 Hz vs 6 kHz → different spectral band energy
- Beat onset → `bass` relative spike
- Mono duplicates to right channel

### 2. Reference preset (visual)

Load `presets/tests/300-beatdetect-bassmidtreb.milk`:

- Red wave → **bass**
- Green wave → **mid**
- Blue wave → **treb**

Use `?audioTest=1` and switch bass / mid / treble modes; each band's wave should
rise/fall independently.

### 3. WASM automated smoke (optional)

```bash
# After WASM smoke build
node scripts/test_audio_reactivity_wasm.mjs cmake-build/wasm-smoke/projectm-v.030-thread.js
```

`tests/wasm-smoke/audio_reactivity.html` compares canvas channel means (silence vs
80 Hz vs 5 kHz) on the beatdetect preset.

### 4. Manual reference tracks

| Signal | Expected |
|--------|----------|
| Silence | Low `bass`/`mid`/`treb`; minimal wave motion |
| Steady 80 Hz sine | Strong bass band / red wave |
| Steady 800 Hz sine | Strong mid / green wave |
| Steady 5 kHz sine | Strong treb / blue wave |
| 120 BPM kick pattern | Rhythmic `bass` spikes |
| Frequency sweep | Band response migrates bass → treb |

## Multi-source policy (`AudioSourceRouter`)

### Problem: double-feed risk

Four JavaScript paths can all call `projectm_pcm_add_float` independently.  If two are
active simultaneously the PCM ring buffer is overwritten on every frame, producing
unpredictable waveforms and beat-detection artefacts.

### Exclusive-mode policy (default)

`html/projectm-audio-router.js` implements a lightweight `AudioSourceRouter` that
tracks exactly one *active* source at a time.  Switching activates the new source and
silences the gate for the previous one.

```
AudioSourceRouter
  .activate('external')  → sets activeSource = 'external'
  .activate('element')   → sets activeSource = 'element'
  .shouldFeedExternal()  → true only when activeSource === 'external'
```

`ProjectMContext` creates one router instance per context (`context.audioSourceRouter`).
`#wireAudio` calls `router.activate()` for whichever source is configured; the external
PCM feed is wrapped in a guard that calls `router.shouldFeedExternal()` before forwarding
each chunk to the engine:

```javascript
setupExternalAudioReceiver({
    onFeed: (buffer, channels, sampleRate, samplesPerChannel) => {
        if (!router.shouldFeedExternal()) return false;   // exclusive gate
        return defaultFeedPCMToModule(buffer, channels, sampleRate, samplesPerChannel);
    },
});
```

Chunks arriving when the router is not in `'external'` mode are returned as `false` and
queued by `setupExternalAudioReceiver`; they can be flushed later if the source switches
back.

> **Note on WASM-managed paths**: the worklet is created by C++ inside the WASM
> module, so the router can stop its playback (`stop_worklet_playback`) but not
> unhook it. `set_audio_source_to_stream` is now only a record of the host's
> choice — with one ring behind every source, nothing in the render loop branches
> on it.

### Source names

| Name | Description |
|------|-------------|
| `'none'` | No source configured (initial / reset state) |
| `'worklet'` | Internal AudioWorklet (`projectm_audio_processor.js`) |
| `'element'` | Media element routed through the worklet (`#audio-stream-element`) |
| `'external'` | MOD/FLAC players via `postMessage` / `BroadcastChannel` |

### `pm-audio-source` event

Whenever the active source changes, the router dispatches a `CustomEvent` on `window`:

```javascript
window.addEventListener('pm-audio-source', (event) => {
    console.log('active source:', event.detail.source);
    // → 'none' | 'worklet' | 'element' | 'external'
});
```

Hosts can use this to update a status badge, mute/unmute UI controls, or log analytics
without polling `context.activeAudioSource`.

### Accessing the current source

```javascript
const context = new ProjectMContext({ canvas, audioSource: 'external', ... });
await context.start();

console.log(context.activeAudioSource);            // 'external'
console.log(context.audioSourceRouter.activeSource); // same
context.audioSourceRouter.shouldFeedExternal();    // true
```

### Switching sources at runtime

The router supports runtime switching (e.g. FLAC player popup opened while element
audio is playing):

```javascript
// Activate external PCM — element feed is now gated
context.audioSourceRouter.activate('external');

// Switch back to element; external PCM is gated again
context.audioSourceRouter.activate('element');
```

### Mix mode (not yet implemented)

Mixing multiple sources is intentionally **not** the default because double-feeding
degrades beat detection.  If you need mixing, bypass `shouldFeedExternal()` in your own
`onFeed` wrapper and document the policy in your host.  A formal mix-mode API can be
added to `AudioSourceRouter` without breaking the exclusive default.

---

## External PCM sender contract

This section documents the message shape expected by `html/projectm-external-pcm.js`
(the receiver) so that external players (`ford442/mod-player`,
`ford442/flac_player`, custom web players) can interoperate reliably.

### `postMessage` shape

```
{
  type:       'pcm',          // required, literal string
  buffer:     Float32Array,   // required — interleaved samples (see below)
  channels:   1 | 2,          // required — 1 = mono, 2 = stereo interleaved
  sampleRate: number          // optional but recommended (e.g. 44100, 48000)
}
```

Post to `window.opener` or the parent window:

```javascript
// Minimum viable sender (player page)
window.opener.postMessage(
    { type: 'pcm', buffer: float32Array, channels: 1, sampleRate: 48000 },
    '*'          // origin '*' is acceptable; receiver enforces its own allowlist
);
```

Also broadcast on `BroadcastChannel('projectm-audio')` for same-origin tabs:

```javascript
const bc = new BroadcastChannel('projectm-audio');
bc.postMessage({ type: 'pcm', buffer: float32Array, channels: 1 });
```

### Buffer layout

| `channels` | Buffer layout | `buffer.length` |
|-----------|---------------|-----------------|
| `1` (mono) | `[L0, L1, …, Ln]` | n samples |
| `2` (stereo) | `[L0, R0, L1, R1, …]` | 2n samples (interleaved) |

Stereo buffers with an **odd** total length are silently rejected.

### Analysis window

Send **≥ 576 samples per channel** per message for full beat-detection coverage.  The
receiver trims to the most recent 576 samples before feeding the engine (matching the
internal worklet and stream paths).  Sending fewer samples is allowed but reduces FFT
resolution.

```
Recommended: buffer.length ≥ 576 * channels (= 576 mono, 1152 stereo)
```

### Origin allowlist

The receiver enforces an origin allowlist.  External players must originate from an
allowed domain (the visualizer page's own origin is always trusted):

| Configuration | Default |
|---------------|---------|
| `setupExternalAudioReceiver({ allowedOrigins: [...] })` | `go.1ink.us`, `test.1ink.us`, `projectm.1ink.us`, `flac.1ink.us`, `mod.1ink.us` |
| `localStorage.externalPcmOrigins` | overrides the configured list |

Origins not in the allowlist are silently dropped (debug log only).

### Gain

If the external player's AnalyserNode output is quieter than the worklet path (common
for MOD/FLAC players that expose raw analyser amplitude), boost it:

```javascript
localStorage.externalPcmGain = "1.8";   // applied after the 576-sample trim
// or: setupExternalAudioReceiver({ gain: 1.8 })
```

### Player integration pattern

```javascript
// In ford442/mod-player or ford442/flac_player page:
function sendPcmToProjectM(analyserNode, sampleRate) {
    const buf = new Float32Array(576);
    analyserNode.getFloatTimeDomainData(buf);
    window.opener?.postMessage(
        { type: 'pcm', buffer: buf, channels: 1, sampleRate },
        '*'
    );
}
// Call sendPcmToProjectM() once per render frame (requestAnimationFrame).
```

See `html/flac-player/projectm-pcm-bridge.js` for the full bridge used by the
FLAC player, including `AudioNode.connect` tap and automatic opener/parent detection.

### Queue and backpressure

The receiver maintains a pending queue (max 24 chunks).  If the WASM module is not yet
ready, chunks are queued and flushed automatically once the module initialises.  When
the queue is full the **oldest** chunk is silently dropped (LIFO eviction).  Players
need not implement flow-control: sending at ~60 fps is fine.

### E2E smoke test (deferred)

A Playwright mock-producer test that exercises the full postMessage → allowlist →
`projectm_pcm_add_float` → audio-reactivity counter pipeline is tracked in
[issue #172](https://github.com/ford442/Project-M/issues/172).  The infrastructure
for it exists in `tests/wasm-smoke/` (Playwright, synthetic PCM, audio reactivity
helper); the fixture and job wiring are deferred to a follow-up PR.

---



| Symptom | Likely cause | Mitigation |
|---------|--------------|------------|
| External player less reactive than `#track` | Analyser amplitude lower; no gain stage | `externalPcmGain` |
| Preset “dead” on Signature GPU presets | Reactivity in warp shader only; audit shows `reactivity: none` in header | Add `bass_att` to `per_frame` or warp |
| Beat values stuck at 1.0 | Silence or constant-level tone after long average | Normal; test transients |
| One frame lag | Audio fed after render | Feed PCM before `_render_frame` each tick |
| Stale ring buffer | No new PCM while rendering | Silence slowly decays; keep feeding |
| Worklet vs stream mismatch | Was 512 vs 576 batch (fixed 2026-07) | Ensure current worklet + emscripten |

## Performance notes

Hot path: `PCM::UpdateFrameAudioData()` → FFT (`MilkdropFFT.cpp`) + loudness sums.
OpenMP parallelizes loudness band sums and other audio helpers when `ENABLE_OPENMP=ON`.
SIMD builds benefit from contiguous waveform copy in `PCM::CopyNewWaveformData`.

Perf HUD (`?perf=1`) shows **Audio FFT/Loudness** timing via `audio_analysis_ms`.

## Files

| File | Role |
|------|------|
| `projectm_audio_processor.js` | Web Audio worklet; batches PCM to main thread |
| `projectM_emscripten.cpp` | Worklet/stream glue, `_projectm_pcm_add_float_wrapper` |
| `html/projectm-audio-router.js` | `AudioSourceRouter` — single-active-source policy + `pm-audio-source` events |
| `html/projectm-external-pcm.js` | MOD/FLAC postMessage bridge |
| `html/projectm-audio-source-router.js` | Exclusive single-source policy |
| `html/projectm-synthetic-audio.js` | Test signal generators |
| `html/projectm-context.js` | `ProjectMContext` — wires router, exposes `activeAudioSource` |
| `src/libprojectM/Audio/PCM.cpp` | Ring buffer, FFT, beat detection |
| `src/libprojectM/Audio/Loudness.cpp` | bass/mid/treb relative values |
| `tests/libprojectM/PCMAudioReactivityTest.cpp` | Automated PCM tests |
| `tests/web/audio-router.test.mjs` | Unit tests for `AudioSourceRouter` |
| `tests/web/projectm-external-pcm.test.mjs` | Unit tests for origin allowlist, queue drop, stereo/mono |

## Related docs

- [`docs/EMSCRIPTEN.md`](EMSCRIPTEN.md) — external source parity, COOP/COEP
- [`docs/PERFORMANCE.md`](PERFORMANCE.md) — OpenMP audio benchmarks
- [`docs/PRESET_METADATA.md`](PRESET_METADATA.md) — `reactivity` metadata field
