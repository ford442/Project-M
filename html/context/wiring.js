// context/wiring.js
//
// What start() hooks up around an engine once it is booted: the page-wide
// PCM / preset / context-loss hooks, the engine settings applied before its
// first frame, the governor's render-scale feed, and the engine reports
// (init failures, failed preset switches) that become this context's errors.
// Each function returns its undo step(s) for the context's teardown list.

import { setupAudioUnlock } from '../projectm-audio-bootstrap.js';
import { installWorkletPlaybackSafetyNet } from '../projectm-worklet-playback.js';
import { subscribeWasmCallback } from '../projectm-wasm-callbacks.js';
import { setupContextLossRecovery } from '../projectm-context-loss.js';
import { setExternalPcmTransport } from '../projectm-external-pcm.js';
import { setupPcmHud } from '../projectm-pcm-hud.js';
import { setQualityGovernorEnabled, setTargetFps } from '../projectm-fps-governor.js';
import { installTransportPcmWriter, installTransportPresetWriter } from '../projectm-render-transport.js';
import { INIT_CONTEXT_LOST } from '../projectm-init-errors.js';
import { setMeshQuality } from '../projectm-mesh-quality.js';
import { resolveFlashLimit } from '../projectm-context-config.js';

/**
 * @typedef {import('../projectm-context-types.ts').ProjectMResolvedContextOptions} ProjectMResolvedContextOptions
 * @typedef {import('../generated/projectm-wasm-api.ts').ProjectMModule} ProjectMModule
 * @typedef {import('../projectm-transport-types.ts').RenderTransport} RenderTransport
 * @typedef {(() => void) | { dispose(): void } | null | undefined} Disposable
 */

/**
 * `ProjectMErrorDetail.code` of a preset that failed to load or compile. Not a
 * boot failure: the engine keeps running its previous preset, so a page can show
 * a toast and carry on. `detail.error.preset` is the VFS path that failed.
 */
export const PRESET_SWITCH_FAILED = -2;

/**
 * The process-wide hooks that route PCM, preset bytes and context loss to this
 * context's transport.
 *
 * @param {{
 *   transport: RenderTransport,
 *   documentRef?: Document,
 *   windowRef?: (Window & typeof globalThis),
 * }} params
 * @returns {Disposable[]}
 */
export function installTransportHooks({ transport, documentRef, windowRef }) {
    return [
        // External PCM arrives on this thread either way; tell it which
        // engine to hand the samples to. A claim, not an assignment: the
        // release leaves a sibling context's registration alone.
        setExternalPcmTransport(transport),
        // PCM-rate readout (host ingress, engine/worker drain); overlay with ?pcmhud=1.
        setupPcmHud({ transport, windowRef, documentRef }),
    ];
}

/**
 * The hooks installed after the audio router: audio unlock, the worklet
 * safety net and the transport's PCM / preset writers, then context loss.
 *
 * @param {Parameters<typeof installTransportHooks>[0] & {
 *   context: Parameters<typeof setupContextLossRecovery>[0],
 *   canvas: HTMLCanvasElement,
 * }} params
 * @returns {Disposable[]}
 */
export function installPlaybackHooks({ transport, context, canvas, documentRef, windowRef }) {
    return [
        setupAudioUnlock(),
        installWorkletPlaybackSafetyNet(),
        // The worklet runs on this thread in both topologies; this is what
        // decides where its PCM goes.
        installTransportPcmWriter(transport),
        // Preset milk is fetched on this thread; the worker owns the VFS.
        installTransportPresetWriter(transport),
        // Both topologies: on the main thread the canvas is heard here, in
        // the worker the loss is relayed through the transport.
        setupContextLossRecovery(context, { canvas, documentRef, windowRef }),
    ];
}

/**
 * The flash limiter is on before the engine's first frame: a viewer who needs
 * it must never be shown an unlimited one. The worker applied it from its init
 * message already.
 *
 * @param {RenderTransport} transport
 * @param {ProjectMResolvedContextOptions} options
 */
export function applyInitialFlashLimit(transport, options) {
    const flashLimit = resolveFlashLimit(options);
    if (flashLimit && transport.topology === 'main') {
        transport.setFlashLimit(flashLimit.enabled, flashLimit.threshold);
    }
}

/**
 * Mesh/fps/governor on a main-thread engine. They go to the worker in its init
 * message, since it must have them before the first frame; setting them again
 * over the wire would be a second source of truth.
 *
 * @param {ProjectMModule} engine
 * @param {ProjectMResolvedContextOptions} options
 */
export function applyEngineSettings(engine, { meshQuality, targetFps, qualityGovernor }) {
    setMeshQuality(engine, meshQuality);
    setTargetFps(engine, targetFps);
    setQualityGovernorEnabled(engine, qualityGovernor);
}

/**
 * Governor v2 (docs/PERFORMANCE.md): the caller syncs the starting render
 * scale (getGovernorRenderScale()); this resizes on every tier change (WasmPerfGovernor.cpp pushes here via
 * js_governor_report_render_scale()). Shrinking the canvas backing store
 * while keeping its CSS size fixed is what actually applies the "internal
 * FBO render scale" tier — see syncCanvasSize() in context/render.js.
 *
 * In the worker topology the backing store is not ours to shrink, so the
 * worker applies the same factor to the canvas it owns and the main thread
 * keeps renderScale at 1 — see html/projectm-render-worker.js.
 *
 * @param {{
 *   windowRef?: (Window & typeof globalThis),
 *   engineHost: number,
 *   onScaleChange: (scale: number) => void,
 * }} params
 * @returns {Disposable}
 */
export function followGovernorRenderScale({ windowRef, engineHost, onScaleChange }) {
    // Via the injected windowRef, like every other global hook the context
    // installs — a bare `window` here ignores the caller's window and throws
    // outright where there is no global one. The engine calls the hook by its
    // global name, so it goes through the callback bus: destroying one context
    // leaves the rest subscribed, and the engineHost filter keeps a sibling
    // engine's tier change from resizing this canvas.
    if (!windowRef) {
        return null;
    }
    return subscribeWasmCallback('pmOnGovernorRenderScaleChange', ({ scale }) => {
        onScaleChange(scale);
    }, windowRef, { engineHost });
}

/**
 * Surfaces an init failure the engine reports for *this* context's host
 * after start() — a context-loss recovery whose init() failed, say. Failures
 * during start() are reported where they happen, with their code; this
 * subscription starts after that. A sibling engine's failure is filtered out,
 * and so is a bundle that predates the host argument (it cannot say whose it was).
 *
 * @param {{
 *   windowRef: Window & typeof globalThis,
 *   engineHost: number,
 *   isDestroyed: () => boolean,
 *   report: (error: Error, code: number) => void,
 * }} params
 * @returns {Disposable}
 */
export function watchEngineInitErrors({ windowRef, engineHost, isDestroyed, report }) {
    return subscribeWasmCallback('pmReportInitError', ({ host, code, detail }) => {
        // 5 is "the context is still lost": the context-loss overlay is up
        // and the restore event retries; not a failure to report.
        if (host === null || code === INIT_CONTEXT_LOST || isDestroyed()) {
            return;
        }
        const suffix = detail ? `: ${detail}` : '';
        report(new Error(`projectM engine init failed (init code ${code})${suffix}`), code);
    }, windowRef, { engineHost });
}

/**
 * Surfaces a preset the engine could not switch to, as
 * {@link PRESET_SWITCH_FAILED}. The engine reports it through the callback bus
 * (`pmOnPresetSwitchFailed`) instead of writing the page's DOM, so this is the
 * one place a failed preset becomes a page-visible event. Main-thread engines
 * only: a render worker's report stays in its own console, as it always has.
 *
 * @param {{
 *   windowRef: Window & typeof globalThis,
 *   engineHost: number,
 *   isDestroyed: () => boolean,
 *   report: (detail: { code: number, message: string, error: Error & { preset: string } }) => void,
 * }} params
 * @returns {Disposable}
 */
export function watchPresetSwitchFailures({ windowRef, engineHost, isDestroyed, report }) {
    // A context that booted its own Module never learns its handle
    // (checkInit() returns only the init code), so `engineHost` is 0 there
    // while the engine's events carry the real one -- and `engineHost: 0`
    // means "the legacy default host", which would drop them. That engine is
    // the Module's only one, so it hears everything.
    const filter = engineHost ? { engineHost } : {};
    return subscribeWasmCallback('pmOnPresetSwitchFailed', ({ preset, message }) => {
        if (isDestroyed()) {
            return;
        }
        const name = preset.split('/').pop() || preset;
        const text = message ? `Preset failed: ${name} (${message})` : `Preset failed: ${name}`;
        const error = Object.assign(new Error(text), { preset });
        // Not deduplicated like the start() errors: each failed switch is its own event.
        report({ code: PRESET_SWITCH_FAILED, message: text, error });
    }, windowRef, filter);
}
