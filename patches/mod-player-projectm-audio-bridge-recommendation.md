# MOD Player (xm-player) — Recommended projectM Audio Bridge Integration

## Current Situation (as of live bundle inspection 2026-05)
- The player has an excellent, well-architected audio engine (`OpenMPTWorkletEngine` / native C++ worklet variant).
- It already extracts high-quality rendered audio via AudioWorklet + AnalyserNode (fftSize often 2048).
- It has rich position / pattern / VU data emission.
- **Zero** code currently forwards any PCM to a parent projectM visualizer.

## Best Integration Points (low risk, high fidelity)

### Option A — Recommended (Easiest + Highest Quality): Hook the existing Analyser (like the FLAC player already does)

In the play / audio graph setup (around the place where `_e.current` / analyser is created and connected):

```js
// After this line (or equivalent):
// St.connect(_e.current); _e.current.connect(...)

// Add the projectM bridge (only when opened from a projectM host)
if (window.opener || (window.parent !== window)) {
  const pmChannel = new BroadcastChannel("projectm-audio"); // legacy fallback
  const pmBuffer = new Float32Array(_e.current.fftSize || 2048);
  let raf;

  const sendToProjectM = () => {
    _e.current.getFloatTimeDomainData(pmBuffer);
    const data = pmBuffer.slice();

    // Legacy (for current hosts)
    try { pmChannel.postMessage({ type: "pcm", buffer: data, channels: 1 }); } catch {}

    // Modern (cross-origin safe)
    try {
      if (window.opener) {
        window.opener.postMessage({ type: "pcm", buffer: data, channels: 1 }, "*");
      } else if (window.parent !== window) {
        window.parent.postMessage({ type: "pcm", buffer: data, channels: 1 }, "*");
      }
    } catch (e) {}

    raf = requestAnimationFrame(sendToProjectM);
  };

  // Start when playback actually begins
  // (hook into the existing "loaded" / play / "position" event)
  sendToProjectM();   // or start it from the play() success path

  // Clean up on pause/stop/destroy (add to existing qt() / destroy logic)
  // cancelAnimationFrame(raf); pmChannel.close();
}
```

### Option B — Even Better (Native Engine Path)
When using the native C++/Wasm worklet (`native-worklet` mode), the C++ side already produces the final stereo float samples before they go to the AudioWorkletNode.

The cleanest long-term solution is to add a tiny C++ export (or postMessage from the worklet) that gives the host page direct access to the most recent rendered block. This would give projectM bit-perfect tracker output instead of re-analysing from an AnalyserNode.

Suggested new Emscripten export ideas (add to the native module):
- `_projectm_get_latest_pcm(float* out, int maxSamples)`
- Or have the worklet forward the raw output buffer via its `port.postMessage` (already used for "position").

The JS side can then forward those exact samples via `postMessage` to the projectM host with `channels: 2`.

### Minimal One-File Sender Helper (copy-paste for quick test)

Add this small utility near the top of the main component or in a `projectmBridge.js`:

```js
export function attachProjectMBridge(analyserNode, { channels = 1 } = {}) {
  if (!analyserNode || (!window.opener && window.parent === window)) return () => {};

  const bc = new BroadcastChannel("projectm-audio");
  const buf = new Float32Array(analyserNode.fftSize || 2048);
  let rafId;

  const tick = () => {
    analyserNode.getFloatTimeDomainData(buf);
    const copy = buf.slice();
    bc.postMessage({ type: "pcm", buffer: copy, channels });
    if (window.opener) window.opener.postMessage({ type: "pcm", buffer: copy, channels }, "*");
    if (window.parent !== window) window.parent.postMessage({ type: "pcm", buffer: copy, channels }, "*");
    rafId = requestAnimationFrame(tick);
  };

  tick();

  return () => {
    cancelAnimationFrame(rafId);
    bc.close();
  };
}
```

Call it right after you create and connect the analyser in `cn()` / play path.

## Why This Will "Just Work" After the Host-Side Fixes
The host (`projectm-core.html` + the improved receiver) now:
- Listens to both `postMessage` (primary) and the legacy BroadcastChannel.
- Uses a pre-allocated transfer buffer (no malloc spam).
- Correctly handles mono (channels=1) or stereo.
- Has visible launch buttons and `window.open*Player()` helpers.

Once the MOD player calls the bridge above, tracker audio will drive projectM beautifully.

## Sender Contract (must match the host receiver)

The host receiver lives in `html/projectm-external-pcm.js`
(`setupExternalAudioReceiver()`). It accepts a message whose `data` is exactly:

```js
{
  type: 'pcm',              // required literal
  buffer: Float32Array,     // required; rejected if not a Float32Array
  channels: 1 | 2,          // optional, defaults to 2; non-1/2 values coerced to 2
  sampleRate: number        // optional (informational)
}
```

Notes for the sender:
- For `channels: 2`, `buffer` must be **interleaved L/R with an even length** —
  odd-length stereo payloads are dropped by the host.
- Transport: the host listens on **both** `window.postMessage` (primary — works
  for popup `window.opener` and iframe `window.parent`) and a legacy
  `BroadcastChannel("projectm-audio")` fallback. Send via whichever is available;
  sending both (as in the snippets above) is fine — the host de-dupes by feeding
  whatever arrives.
- Host origin allow-list: the receiver only accepts `postMessage` from
  `https://mod.1ink.us`, `https://flac.1ink.us`, `https://test.1ink.us` (plus any
  `externalPcmOrigins`/`externalPcmAllowedOrigins` localStorage override).

## Audio-only / projectM-embed mode (`?projectm=1`)

When projectM opens the player as a pure audio feeder it now appends
**`?projectm=1`** to the player URL — both for popups
(`createPopupAudioPlayerController` → `withProjectMAudioFlag()` in
`html/projectm-audio-player.js`) and for the iframe embeds in the
`projectm_panel*.1ink` / `projectm_new.1ink` variants. The popup `window.name`
target is also `mod-player` / `flac-player`.

The player should detect this (`new URLSearchParams(location.search).get('projectm') === '1'`,
or `window.name === 'mod-player'`) and, when set:

- **Skip WebGPU / pattern-canvas initialization** — projectM is the visualizer,
  so the standalone pattern/VU/spectrum display is redundant and wastes GPU
  budget. The host cannot disable the remote player's canvas; only the player can.
- Render a **compact transport-only UI** (play/pause, file load, position).
- **Auto-start the PCM bridge** on playback and **tear it down on pause/stop/close**
  (`cancelAnimationFrame(rafId); bc.close();`) so there is no runaway
  `requestAnimationFrame` after playback ends.

## Files to Touch (approximate from bundle analysis)
- The main React component that owns `ke.current`, `_e.current` (analyser), `Ce.current` (worklet node).
- `openmpt-worklet.js` / native worklet (for Option B).
- `destroy()` / `qt()` cleanup paths.

This integration should be < 30 lines and re-uses 100% of the excellent existing audio architecture.
