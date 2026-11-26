// GENERATED from connect.ts by scripts/build_html_ts.mjs — do not edit.
// Edit the .ts, then run `npm run build:html` (CI: npm run check:html-build).
import { getAudioContext } from '../projectm-audio-bootstrap.js';
import { flushQueuedExternalPCM } from '../projectm-external-pcm.js';
import { getGovernorRenderScale } from '../projectm-fps-governor.js';
import { acquireAudioGraph } from '../projectm-worklet-playback.js';
import { startRender } from '../generated/projectm-wasm-api.js';
import { contextConfigFor } from './boot.js';
import { attachAudioRouter, resolveMediaElement, wireAudioSource } from './audio.js';
import { watchPageLifecycle } from './lifecycle.js';
import { applyRhythmOptions, clampRhythmLatencyMs, measureOutputLatencyMs, relayPresetEvents } from './presets.js';
import { followContainerSize, readContextSnapshot } from './render.js';
import { emitContextEvent, engineOf, rhythmOf, setContextSnapshot } from './controls.js';
import {
    applyEngineSettings,
    applyInitialFlashLimit,
    followGovernorRenderScale,
    installPlaybackHooks,
    installTransportHooks,
    watchEngineInitErrors,
    watchPresetSwitchFailures,
} from './wiring.js';
const RHYTHM_LATENCY_REMEASURE_MS = 3e3;
export class ContextErrorReporter {
    constructor(context) {
        this.context = context;
        this.reported = void 0;
    }
    /** Forgets the last failure: a new start() reports its own. */
    reset() {
        this.reported = void 0;
    }
    /** A failure of start(): reported once, with `code` (docs/EMSCRIPTEN.md Init Error Codes, -1 for none). */
    report(error, code = -1) {
        if (this.reported === error) {
            return;
        }
        this.reported = error;
        const message = error instanceof Error ? error.message : String(error);
        this.emit({ code, message, error });
    }
    /** An error from a running engine (the worker), as opposed to a failed start. */
    reportRuntime(message) {
        this.emit({ code: -1, message, error: new Error(message) });
    }
    /** An engine report that already is a detail (a preset that failed to switch). */
    reportDetail(detail) {
        this.emit(detail);
    }
    /** `onError` and the event each get their own copy: a listener that edits it cannot reach the other. */
    emit(detail) {
        this.context.options.onError?.(detail);
        emitContextEvent(this.context, 'error', { ...detail });
    }
}
export function connectEngine(host, transport, signal) {
    const { context, own } = host;
    const { options } = context;
    const {
        documentRef,
        windowRef,
        transparent,
        transparencyThreshold,
        presetLocked,
        audioSource,
        audioElement,
        onAudioSourceChange,
        audioRouter: existingAudioRouter,
        onPresetChanged,
    } = options;
    installTransportHooks({ transport, documentRef, windowRef }).forEach((d) => own(d));
    own(acquireAudioGraph({ audioContext: options.audioContext }));
    own(watchPageLifecycle({ context, transport, documentRef, windowRef, wakeLock: options.wakeLock }));
    const router = attachAudioRouter({
        existingRouter: existingAudioRouter,
        module: context.module,
        transport,
        audioSource,
        publish: (status) => {
            onAudioSourceChange?.(status);
            emitContextEvent(context, 'audio-source', status);
        },
        own: (dispose) => own(dispose),
    });
    context.audioRouter = router;
    installPlaybackHooks({ transport, context, canvas: context.canvas, documentRef, windowRef }).forEach((d) => own(d));
    applyInitialFlashLimit(transport, options);
    context.resize();
    const engine = engineOf(context);
    if (engine) {
        startRender(engine, context.canvas.width, context.canvas.height);
    }
    flushQueuedExternalPCM();
    if (engine) {
        applyEngineSettings(engine, options);
    }
    transport.callVoid('setPresetLocked', presetLocked);
    applyRhythmOptions(options, context);
    if (options.rhythmLatency === 'auto') {
        const nudge = options.rhythmLatencyNudge ?? 0;
        let applied = -1;
        const timer = setInterval(() => {
            const ms = clampRhythmLatencyMs(measureOutputLatencyMs(getAudioContext()) + nudge);
            if (Math.abs(ms - applied) >= 1) {
                applied = context.setRhythmLatency(ms);
            }
        }, RHYTHM_LATENCY_REMEASURE_MS);
        own(() => clearInterval(timer));
    }
    rhythmOf(context).sync(transport);
    if (engine) {
        context.renderScale = getGovernorRenderScale(engine) || 1;
        own(
            followGovernorRenderScale({
                windowRef,
                engineHost: context.hostHandle,
                onScaleChange: (scale) => {
                    context.renderScale = scale;
                    context.resize();
                },
            })
        );
    }
    watchEngineReports(host);
    if (transparent) {
        transport.callVoid('setTransparencyMode', true);
        if (typeof transparencyThreshold === 'number') {
            transport.callVoid('setTransparencyThreshold', transparencyThreshold);
        }
        if (context.secondaryCanvas) {
            context.secondaryCanvas.style.display = 'none';
        }
    }
    const media = wireAudioSource({
        audioSource,
        media:
            audioSource === 'element' ? (context.audioElement ?? resolveMediaElement(audioElement, documentRef)) : null,
        externalPcmOrigins: options.externalPcmOrigins,
        router,
        sharedRouter: !!existingAudioRouter,
        transport: context.transport,
        signal,
        own: (dispose) => own(dispose),
    });
    if (media) {
        context.audioElement = media;
    }
    if (!existingAudioRouter) {
        router.setModule(context.module);
        router.setTransport(transport);
    }
    observeContainer(host);
    own(
        relayPresetEvents(windowRef, (detail) => {
            onPresetChanged?.(detail);
            emitContextEvent(context, 'preset-changed', detail);
        })
    );
    setContextSnapshot(context, readContextSnapshot(transport, contextConfigFor(options)));
}
function watchEngineReports({ context, own, errors }) {
    const { windowRef } = context.options;
    if (!windowRef || !context.module) {
        return;
    }
    const isDestroyed = () => context.destroyed;
    own(
        watchEngineInitErrors({
            windowRef,
            engineHost: context.hostHandle,
            isDestroyed,
            report: (error, code) => errors.report(error, code),
        })
    );
    own(
        watchPresetSwitchFailures({
            windowRef,
            engineHost: context.hostHandle,
            isDestroyed,
            report: (detail) => errors.reportDetail(detail),
        })
    );
}
function observeContainer({ context, own, onContainerResize }) {
    const follow = followContainerSize({
        container: context.container,
        windowRef: context.options.windowRef,
        onResize: (devicePixelSize) => onContainerResize(devicePixelSize),
    });
    if (!follow) {
        return;
    }
    context.resizeObserver = follow.observer;
    own(() => {
        follow.dispose();
        context.resizeObserver = null;
    });
}
