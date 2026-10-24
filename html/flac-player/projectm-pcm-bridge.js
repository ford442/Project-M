// projectM PCM bridge for the in-repo FLAC player shell (html/flac-player/index.html).
//
// Why this exists: the FLAC player's own (externally-built, minified) bundle only
// ships PCM to projectM over a BroadcastChannel("projectm-audio"). BroadcastChannel
// is *same-origin only*, so when the player is opened as a cross-origin popup
// (https://go.1ink.us/flac-player/) from the projectM host, the audio never arrives — see
// docs/DIAGNOSIS_MOD_FLAC_PLAYER_CONNECTION.md. The host receiver
// (html/projectm-external-pcm.js) already accepts the cross-origin-safe
// `window.postMessage` path; this module supplies the matching sender without
// needing to rebuild the player bundle.
//
// It works by patching the Web Audio graph at the prototype level *before* the
// bundle builds its graph: whenever any node connects to `context.destination`,
// it is also connected to a per-context capture node that sees every sample the
// player renders, exactly once, in all three player modes (Streaming = media
// element source, Web Audio = buffer source, AudioWorklet = the bundle's own
// processor). The capture node is an AudioWorkletNode when the context has an
// audioWorklet, else a ScriptProcessorNode. It ships interleaved stereo blocks
// at the context's sample rate to the projectM host via postMessage (opener for
// popups, parent for iframes), transferring the buffer; the legacy
// BroadcastChannel is only used when there is no window to post to, because a
// same-origin host listens on both and would otherwise get every block twice.
//
// This replaced an AnalyserNode polled once per animation frame. That poll
// re-sent the newest 2048 samples on every frame whether or not they were new
// (~2.8x real time at 60 Hz, overlapping), mono only, and it ran alongside the
// bundle's own analyser pump and its AudioWorklet PCM callback. With all of
// them feeding the engine's PCM ring at once it saw ~3.5x real-time audio and
// kept overrunning, so presets stopped tracking the beat.
//
// Every message is tagged with PCM_BRIDGE_PRODUCER and a sequence number. The
// host (html/projectm-external-pcm.js) drops untagged PCM — the bundle's own
// senders, which cannot be turned off without rebuilding it — while a tagged
// producer is active, and drops repeated sequence numbers.
//
// Contract (matches projectm-external-pcm.js):
//   target.postMessage({ type: 'pcm', buffer: Float32Array, channels: 2,
//                        sampleRate, producer, seq }, '*', [buffer.buffer])

export const AUDIO_CHANNEL_NAME = 'projectm-audio';

// The window the player should feed: the opener (popup case) or the embedding
// parent (iframe case). Null when the page is standalone (nothing to feed).
/**
 * @param {{ opener?: Window | null, parent?: Window | null }} win
 * @returns {Window | null}
 */
export function resolveFeedTarget(win) {
    if (win.opener && win.opener !== win) return win.opener;
    if (win.parent && win.parent !== win) return win.parent;
    return null;
}

// True when this page is acting as a projectM audio feeder rather than a
// standalone player: explicit ?projectm=1, the popup window.name the host uses,
// or simply having an opener/parent to feed.
/** @param {Window} win */
export function isProjectMFeederMode(win) {
    let params;
    try {
        params = new URLSearchParams(win.location.search);
    } catch {
        params = null;
    }
    if (params && params.get('projectm') === '1') return true;
    if (win.name === 'flac-player') return true;
    if (win.name === 'mod-player') return true;
    return !!resolveFeedTarget(win);
}

export const PCM_BRIDGE_PRODUCER = 'projectm-flac-bridge';
/** Frames per posted block: ~23 ms at 44.1 kHz, ~43 messages a second. */
export const DEFAULT_BLOCK_FRAMES = 1024;
export const CAPTURE_PROCESSOR_NAME = 'projectm-pcm-bridge-capture';

// AudioWorklet processor source. Accumulates the (stereo, upmixed by the input
// node) render quanta into blocks and posts each one, transferred, to the main
// thread. Silent blocks are not posted: a paused player sends nothing.
export const CAPTURE_PROCESSOR_SOURCE = `
class ProjectMPcmBridgeCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.blockFrames = Math.max(128, opts.blockFrames | 0 || ${DEFAULT_BLOCK_FRAMES});
    this.block = new Float32Array(this.blockFrames * 2);
    this.pos = 0;
    this.loud = false;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const left = input[0];
    const right = input.length > 1 ? input[1] : input[0];
    for (let i = 0; i < left.length; i++) {
      const l = left[i];
      const r = right[i];
      if (l !== 0 || r !== 0) this.loud = true;
      this.block[this.pos * 2] = l;
      this.block[this.pos * 2 + 1] = r;
      if (++this.pos === this.blockFrames) {
        if (this.loud) {
          const out = this.block;
          this.port.postMessage(out, [out.buffer]);
          this.block = new Float32Array(this.blockFrames * 2);
        }
        this.pos = 0;
        this.loud = false;
      }
    }
    return true;
  }
}
registerProcessor('${CAPTURE_PROCESSOR_NAME}', ProjectMPcmBridgeCapture);
`;

/**
 * Interleaves one ScriptProcessor input buffer into stereo. Returns null for a
 * silent block (nothing worth posting).
 * @param {{ numberOfChannels: number, length: number, getChannelData(ch: number): Float32Array }} inputBuffer
 * @returns {Float32Array | null}
 */
export function interleaveStereo(inputBuffer) {
    const frames = inputBuffer.length;
    if (!frames || !inputBuffer.numberOfChannels) return null;
    const left = inputBuffer.getChannelData(0);
    const right = inputBuffer.numberOfChannels > 1 ? inputBuffer.getChannelData(1) : left;
    const out = new Float32Array(frames * 2);
    let loud = false;
    for (let i = 0; i < frames; i++) {
        const l = left[i];
        const r = right[i];
        if (l !== 0 || r !== 0) loud = true;
        out[i * 2] = l;
        out[i * 2 + 1] = r;
    }
    return loud ? out : null;
}

// Build the PCM sender. Posts to `target` (cross-origin safe) with the buffer
// transferred; falls back to the BroadcastChannel (same-origin hosts only) when
// there is no target. Never both: a same-origin host hears both and would feed
// every block twice.
/**
 * @param {{ target?: { postMessage: Function } | null, broadcastChannel?: { postMessage: Function } | null, producer?: string }} [options]
 * @returns {(buffer: Float32Array, channels: number, sampleRate: number) => void}
 */
export function createPcmSender({ target, broadcastChannel = null, producer = PCM_BRIDGE_PRODUCER } = {}) {
    let seq = 0;
    return function send(buffer, channels, sampleRate) {
        seq += 1;
        const msg = { type: 'pcm', buffer, channels, sampleRate, producer, seq };
        if (target && typeof target.postMessage === 'function') {
            try {
                target.postMessage(msg, '*', [buffer.buffer]);
            } catch (error) {
                // A buffer that cannot be transferred (e.g. a view on shared or
                // already-detached memory) still goes out as a copy.
                try {
                    target.postMessage(msg, '*');
                } catch (retryError) {
                    console.debug('[projectM FLAC bridge] postMessage failed (non-fatal):', retryError);
                }
            }
            return;
        }
        if (broadcastChannel) {
            try {
                broadcastChannel.postMessage(msg);
            } catch (error) {
                console.debug('[projectM FLAC bridge] BroadcastChannel post failed (non-fatal):', error);
            }
        }
    };
}

/**
 * @typedef {object} PcmBridgeOptions
 * @property {Window & typeof globalThis} [windowRef]
 * @property {AudioNode} [audioNodeProto] The prototype whose connect() is patched.
 * @property {typeof BroadcastChannel} [broadcastChannelCtor]
 * @property {typeof AudioWorkletNode} [audioWorkletNodeCtor]
 * @property {typeof Blob} [blobCtor]
 * @property {(blob: Blob) => string} [createObjectURL]
 * @property {number} [blockFrames]
 * @property {string} [channelName]
 * @property {boolean} [force] Install even when the page is not a feeder.
 *
 * @typedef {object} CaptureTap One per AudioContext the player renders into.
 * @property {BaseAudioContext} context
 * @property {GainNode} input Sources connect here; the capture node hangs off it.
 * @property {GainNode} sink Muted, on the destination, so the capture node keeps running.
 * @property {AudioWorkletNode | ScriptProcessorNode | null} node
 * @property {boolean} closed
 *
 * @typedef {object} PcmBridge
 * @property {boolean} installed
 * @property {() => void} uninstall
 * @property {() => ({ blocks: number, frames: number, sampleRate: number, captureKind: string } | null)} stats
 */

// Install the bridge. Injectables (windowRef, audioNodeProto, …) exist so the
// wiring can be unit-tested without a real browser/Web Audio stack.
/**
 * @param {PcmBridgeOptions} [options]
 * @returns {PcmBridge}
 */
export function installProjectMPcmBridge({
    windowRef = typeof window !== 'undefined' ? window : undefined,
    audioNodeProto,
    broadcastChannelCtor,
    audioWorkletNodeCtor,
    blobCtor,
    createObjectURL,
    blockFrames = DEFAULT_BLOCK_FRAMES,
    channelName = AUDIO_CHANNEL_NAME,
    force = false
} = {}) {
    const noop = { installed: false, uninstall() {}, stats: () => null };
    if (!windowRef) return noop;
    if (!force && !isProjectMFeederMode(windowRef)) return noop;

    const proto = audioNodeProto
        || (windowRef.AudioNode && windowRef.AudioNode.prototype);
    if (!proto || typeof proto.connect !== 'function') {
        console.debug('[projectM FLAC bridge] AudioNode.connect unavailable; bridge inactive');
        return noop;
    }

    const target = resolveFeedTarget(windowRef);
    const BC = broadcastChannelCtor || windowRef.BroadcastChannel;
    /** @type {BroadcastChannel | null} */
    let broadcastChannel = null;
    if (!target && typeof BC === 'function') {
        try {
            broadcastChannel = new BC(channelName);
        } catch (error) {
            console.debug('[projectM FLAC bridge] BroadcastChannel unavailable:', error);
        }
    }

    const rawSend = createPcmSender({ target, broadcastChannel });
    const counters = { blocks: 0, frames: 0, sampleRate: 0, captureKind: 'none' };
    let active = true;
    /**
     * @param {Float32Array} buffer Interleaved stereo.
     * @param {number} sampleRate
     */
    const send = (buffer, sampleRate) => {
        if (!active) return;
        counters.blocks += 1;
        counters.frames += buffer.length >> 1;
        counters.sampleRate = sampleRate;
        rawSend(buffer, 2, sampleRate);
    };

    const WorkletNode = audioWorkletNodeCtor || windowRef.AudioWorkletNode;
    const BlobCtor = blobCtor || windowRef.Blob;
    const makeUrl = createObjectURL || (windowRef.URL && windowRef.URL.createObjectURL
        ? (/** @type {Blob} */ blob) => windowRef.URL.createObjectURL(blob)
        : null);
    /** @type {string | null} */
    let processorUrl = null;
    function captureModuleUrl() {
        if (processorUrl) return processorUrl;
        if (typeof BlobCtor !== 'function' || typeof makeUrl !== 'function') return null;
        processorUrl = makeUrl(new BlobCtor([CAPTURE_PROCESSOR_SOURCE], { type: 'application/javascript' }));
        return processorUrl;
    }

    // connect() is overloaded (AudioNode / AudioParam destinations); the bridge
    // only ever forwards its arguments, so one loose signature covers both.
    /** @type {(this: AudioNode, destination: AudioNode | AudioParam, ...rest: number[]) => unknown} */
    const originalConnect = /** @type {any} */ (proto.connect);
    /** Nodes the bridge built itself: their connect() calls are not tapped. */
    /** @type {WeakSet<AudioNode>} */
    const ownNodes = new WeakSet();
    /** @type {WeakMap<BaseAudioContext, GainNode>} */
    const tapsByContext = new WeakMap();
    /** @type {CaptureTap[]} */
    const taps = [];

    /**
     * @param {BaseAudioContext} context
     * @param {GainNode} input
     * @param {GainNode} sink
     * @returns {ScriptProcessorNode | null}
     */
    function attachScriptProcessor(context, input, sink) {
        if (typeof context.createScriptProcessor !== 'function') return null;
        const processor = context.createScriptProcessor(blockFrames, 2, 2);
        ownNodes.add(processor);
        processor.onaudioprocess = (/** @type {AudioProcessingEvent} */ event) => {
            const block = interleaveStereo(event.inputBuffer);
            if (block) send(block, context.sampleRate);
        };
        originalConnect.call(input, processor);
        originalConnect.call(processor, sink);
        counters.captureKind = 'script-processor';
        return processor;
    }

    /**
     * @param {BaseAudioContext} context
     * @param {GainNode} input
     * @param {GainNode} sink
     * @param {CaptureTap} tap
     * @returns {Promise<AudioWorkletNode | null>}
     */
    async function attachWorklet(context, input, sink, tap) {
        const url = captureModuleUrl();
        if (!url || typeof WorkletNode !== 'function' || !context.audioWorklet) {
            throw new Error('AudioWorklet unavailable');
        }
        await context.audioWorklet.addModule(url);
        if (!active || tap.closed) return null;
        const node = new WorkletNode(context, CAPTURE_PROCESSOR_NAME, {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            processorOptions: { blockFrames }
        });
        ownNodes.add(node);
        node.port.onmessage = (event) => {
            if (event.data instanceof Float32Array) send(event.data, context.sampleRate);
        };
        originalConnect.call(input, node);
        originalConnect.call(node, sink);
        counters.captureKind = 'audio-worklet';
        return node;
    }

    /**
     * @param {BaseAudioContext} context
     * @returns {GainNode}
     */
    function ensureTap(context) {
        const existing = tapsByContext.get(context);
        if (existing) return existing;
        // Sources connect here synchronously; the capture node is attached
        // behind it as soon as it exists. Explicit stereo upmixes mono sources.
        const input = context.createGain();
        ownNodes.add(input);
        try {
            input.channelCount = 2;
            input.channelCountMode = 'explicit';
            input.channelInterpretation = 'speakers';
        } catch { /* fakes / old engines */ }
        // The capture node outputs silence into a muted gain on the destination,
        // so every engine keeps pulling it (ScriptProcessor and some worklet
        // implementations only run while connected to the destination).
        const sink = context.createGain();
        ownNodes.add(sink);
        sink.gain.value = 0;
        originalConnect.call(sink, context.destination);

        /** @type {CaptureTap} */
        const tap = { context, input, sink, node: null, closed: false };
        tapsByContext.set(context, input);
        taps.push(tap);

        attachWorklet(context, input, sink, tap).then((node) => {
            tap.node = node;
        }, (error) => {
            if (!active || tap.closed) return;
            console.debug('[projectM FLAC bridge] AudioWorklet capture unavailable, using ScriptProcessor:', error);
            tap.node = attachScriptProcessor(context, input, sink);
        });
        return input;
    }

    /**
     * @this {AudioNode}
     * @param {AudioNode | AudioParam} destination
     * @param {number[]} rest output / input indices, forwarded as given
     */
    function patchedConnect(destination, ...rest) {
        const result = originalConnect.call(this, destination, ...rest);
        try {
            const context = this.context;
            if (context && destination && destination === context.destination && !ownNodes.has(this)) {
                originalConnect.call(this, ensureTap(context));
            }
        } catch (error) {
            console.debug('[projectM FLAC bridge] tap connect failed (non-fatal):', error);
        }
        return result;
    }
    proto.connect = /** @type {AudioNode['connect']} */ (/** @type {unknown} */ (patchedConnect));

    return {
        installed: true,
        stats: () => ({ ...counters }),
        uninstall() {
            active = false;
            proto.connect = /** @type {AudioNode['connect']} */ (/** @type {unknown} */ (originalConnect));
            for (const tap of taps) {
                tap.closed = true;
                for (const node of [tap.node, tap.input, tap.sink]) {
                    if (node && typeof node.disconnect === 'function') {
                        try { node.disconnect(); } catch { /* already gone */ }
                    }
                }
                if (tap.node && 'port' in tap.node) tap.node.port.onmessage = null;
                if (tap.node && 'onaudioprocess' in tap.node) tap.node.onaudioprocess = null;
            }
            taps.length = 0;
            if (broadcastChannel) {
                try { broadcastChannel.close(); } catch { /* ignore */ }
                broadcastChannel = null;
            }
        }
    };
}
