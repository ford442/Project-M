// context/connect.ts
//
// ProjectMContext's event wiring: everything start() connects once it has an
// engine — the transport hooks, the page's audio graph and page lifecycle, the
// audio router and source, the playback and governor hooks, the rhythm options,
// the engine's error reports, the container's size and the preset events — and
// how the context reports errors to its host (`onError` and the `error` event).
//
// Every listener, timer and claim is registered on the context's teardown stack
// the moment it exists (`host.own`), so a start that fails half way releases
// exactly what it had connected. The steps run in the order the engine needs
// them; the comments say why where it matters.

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
import type { Disposable } from './session.js';
import type { DevicePixelSize } from './render.js';
import type { ProjectMContext } from '../projectm-context.js';
import type { ProjectMErrorDetail } from '@projectm/types/context';
import type { RenderTransport } from '@projectm/types/transport';

/** How often `rhythmLatency: 'auto'` re-measures the output latency. */
const RHYTHM_LATENCY_REMEASURE_MS = 3000;

/**
 * Hands a context's failures to its `onError` and its `error` event.
 *
 * A failed start is reported once: start() reports some failures where they
 * happen (they carry a specific code) and the outer handler sees the same error
 * again on its way out. Errors from a running engine are not deduplicated: each
 * one is a separate event.
 */
export class ContextErrorReporter {
    private reported: unknown = undefined;

    constructor(private readonly context: ProjectMContext) {}

    /** Forgets the last failure: a new start() reports its own. */
    reset(): void {
        this.reported = undefined;
    }

    /** A failure of start(): reported once, with `code` (docs/EMSCRIPTEN.md Init Error Codes, -1 for none). */
    report(error: unknown, code = -1): void {
        if (this.reported === error) {
            return;
        }
        this.reported = error;
        const message = error instanceof Error ? error.message : String(error);
        this.emit({ code, message, error });
    }

    /** An error from a running engine (the worker), as opposed to a failed start. */
    reportRuntime(message: string): void {
        this.emit({ code: -1, message, error: new Error(message) });
    }

    /** An engine report that already is a detail (a preset that failed to switch). */
    reportDetail(detail: ProjectMErrorDetail): void {
        this.emit(detail);
    }

    /** `onError` and the event each get their own copy: a listener that edits it cannot reach the other. */
    private emit(detail: ProjectMErrorDetail): void {
        this.context.options.onError?.(detail);
        emitContextEvent(this.context, 'error', { ...detail });
    }
}

/** What connectEngine() needs of the context beyond its public state. */
export interface ConnectHost {
    readonly context: ProjectMContext;
    /** Registers an undo step on the context's teardown stack. */
    own(disposable: Disposable): void;
    readonly errors: ContextErrorReporter;
    /** The container's device-pixel content box changed (null: not observable); resize to it. */
    onContainerResize(size: DevicePixelSize | null): void;
}

/**
 * Connects everything a started context needs around its engine, in order.
 * Throws (after registering whatever it had connected) if a step fails; the
 * caller tears down and reports.
 */
export function connectEngine(host: ConnectHost, transport: RenderTransport, signal: AbortSignal): void {
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
    // The page's AudioContext + worklet: closed when the last holder goes.
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

    // Everything from here drives the engine, through the transport or
    // engineOf(). Both select this context's host on every call, so the
    // `await context.loadPresetUrl()` start() makes next cannot resume on a
    // sibling's engine; nothing here relies on an activation lasting.

    context.resize();

    const engine = engineOf(context);
    if (engine) {
        // The worker calls _start_render() itself, on its own canvas,
        // before it reports ready.
        startRender(engine, context.canvas.width, context.canvas.height);
    }
    flushQueuedExternalPCM();

    if (engine) {
        applyEngineSettings(engine, options);
    }
    transport.callVoid('setPresetLocked', presetLocked);
    applyRhythmOptions(options, context);
    if (options.rhythmLatency === 'auto') {
        // outputLatency is only known once the AudioContext runs, and it
        // changes with the output device: re-measure every few seconds.
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

    // Governor v2 render scale; see followGovernorRenderScale() in context/wiring.js.
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

/** Engine reports that become the context's errors; see context/wiring.js. */
function watchEngineReports({ context, own, errors }: ConnectHost): void {
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

/** Resizes the canvases whenever the container (or the devicePixelRatio) changes. */
function observeContainer({ context, own, onContainerResize }: ConnectHost): void {
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
