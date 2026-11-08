// app-shell/dev-tools.js
//
// The core page's developer extras: the local-preset drop zone, the audio
// capture popup, the external-player launchers and PCM test sender (before the
// engine), and the engine-bound panels (mesh quality, governor, FBO banner,
// perf HUD, preset dev tools, experimental bridge, audio test panel).

import { setupExperimentalBridge } from '../projectm-experimental-bridge.js';
import { feedPCMToModule } from '../projectm-external-pcm.js';
import { setupFboFormatIndicator, setupWorkerFboFormatIndicator } from '../projectm-fbo-format.js';
import { setupFpsGovernor } from '../projectm-fps-governor.js';
import { claimGlobal } from '../projectm-globals.js';
import {
    exposeExperimentalGlobals,
    exposeFboFormatGlobals,
    exposeGovernorGlobals,
    exposeMeshQualityGlobals,
    exposePresetDevGlobals,
} from '../projectm-legacy-globals.js';
import { setupMeshQuality } from '../projectm-mesh-quality.js';
import { createPcmTestSender } from '../projectm-pcm-test-sender.js';
import { installHostPcmRingWriter } from '../projectm-pcm-ring.js';
import { setupPerfTools, setupTransportPerfTools } from '../projectm-perf.js';
import { setupPresetDevTools } from '../projectm-preset-dev.js';
import { LOCAL_PRESET_LAST_NAME_KEY, loadLocalPresetFile } from '../projectm-presets.js';
import { setupAudioTestPanel } from '../projectm-synthetic-audio.js';
import { startTransitionWhenReady } from '../projectm-transitions.js';
import { readStorage } from './config.js';

/**
 * @typedef {import('../generated/projectm-wasm-api.ts').ProjectMModule} ProjectMModule
 * @typedef {import('../projectm-context.js').ProjectMContext} ProjectMContext
 * @typedef {import('../projectm-app-shell-ui.js').ShellUi} ShellUi
 * @typedef {ReturnType<typeof import('../projectm-disposables.js').createDisposables>} Disposables
 * @typedef {ReturnType<typeof import('../projectm-audio-player.js').createAudioPlayerController>} AudioPlayer
 *
 * @typedef {object} DevPanelDeps
 * @property {ShellUi} ui
 * @property {Disposables} owned
 * @property {Window & typeof globalThis} windowRef
 * @property {Document} documentRef
 * @property {URLSearchParams} params
 * @property {Storage | null} storage
 * @property {string} log
 * @property {AudioPlayer} audioPlayer
 * @property {number} extrasDelayMs
 * @property {() => ProjectMContext | null} getContext
 * @property {() => ProjectMModule | undefined} getModule
 */

/** @param {DevPanelDeps} deps */
export function setupShellDevPanels({
    ui,
    owned,
    windowRef,
    documentRef,
    params,
    storage,
    log,
    audioPlayer,
    extrasDelayMs,
    getContext,
    getModule,
}) {
    if (params.get('localPresets') === '1') {
        ui.enableLocalPresetDrop({
            lastLabel: () => {
                const last = readStorage(storage, LOCAL_PRESET_LAST_NAME_KEY);
                return last ? `Last local preset: ${last}` : 'Last local preset: none';
            },
            onFile: (file) => {
                const pmContext = getContext();
                const load = pmContext
                    ? pmContext.loadPresetFile(file)
                    : loadLocalPresetFile(file, { module: getModule(), startTransitionWhenReady, documentRef });
                Promise.resolve(load).catch((error) => {
                    ui.showStatus(error instanceof Error ? error.message : String(error), 'error');
                    console.error(`${log} Failed to load local preset:`, error);
                });
            },
        });
    }

    // Tab / system audio capture (html/audio-capture.html): a popup, not an
    // iframe — the share picker needs its own user gesture and the page has
    // to stay open while the user switches to the shared tab. It posts PCM
    // to window.opener, or on BroadcastChannel('projectm-audio') when COOP
    // severs the opener.
    /** @type {Window | null} */
    let captureWindow = null;
    const openAudioCapture = () => {
        if (captureWindow && !captureWindow.closed) {
            captureWindow.focus();
            return captureWindow;
        }
        const url = new URL('./audio-capture.html', windowRef.location.href).toString();
        captureWindow = windowRef.open(url, 'projectm-audio-capture', 'popup,width=440,height=340');
        if (!captureWindow) console.warn('[projectM] audio capture popup blocked; allow popups or open', url);
        return captureWindow;
    };
    owned.add(claimGlobal(windowRef, 'openAudioCapture', openAudioCapture));
    owned.add(claimGlobal(windowRef, 'feedPCMToModuleForDebug', feedPCMToModule));

    // Launchers for the external players, in case the panel image has no
    // hit zone for them. After first paint, so the rest of the UI is there.
    owned.setTimeout(
        () =>
            ui.addLaunchers([
                {
                    id: 'modPlayerLaunchBtn',
                    label: 'MOD',
                    title: 'Open MOD Player (tracker) — sends PCM via postMessage',
                    open: () => audioPlayer.openModPlayer?.(),
                },
                {
                    id: 'flacPlayerLaunchBtn',
                    label: 'FLAC',
                    title: 'Open FLAC Player — sends PCM via postMessage',
                    open: () => audioPlayer.openFlacPlayer?.(),
                },
                {
                    id: 'audioCaptureLaunchBtn',
                    label: 'TAB',
                    title: 'Capture tab / system audio (getDisplayMedia) — sends PCM via postMessage',
                    open: () => void openAudioCapture(),
                },
            ]),
        extrasDelayMs
    );

    const sender = owned.add(createPcmTestSender({ windowRef }));
    owned.add(claimGlobal(windowRef, 'startLocalProjectMTestSender', sender.start));
    owned.add(claimGlobal(windowRef, 'stopLocalProjectMTestSender', sender.stop));
    const host = windowRef.location?.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || params.has('debugSender')) {
        owned.setTimeout(() => ui.addTestSenderPanel(sender), extrasDelayMs + 800);
    }
}

/**
 * The panels that read and write engine state through a module object on
 * this thread (preset dev tools, experimental bridge, ...). In the worker
 * topology there is no such object here, so they stay unbuilt (?renderWorker=0
 * brings them back); the perf HUD and FBO banner run on the transport.
 *
 * @param {ProjectMContext} context
 * @param {{ log: string, documentRef: Document, getModule: () => ProjectMModule | undefined }} deps
 */
export function ownDevTools(context, { log, documentRef, getModule }) {
    const module = /** @type {ProjectMModule | null} */ (context.module);
    if (module) {
        // The baked EM_JS worklet handler and media-element export get their
        // host implementations: one PCM ring writer (projectm-pcm-ring.js).
        context.own(installHostPcmRingWriter(module));
        const meshQuality = context.own(setupMeshQuality(module));
        context.own(exposeMeshQualityGlobals(meshQuality));
        // ProjectMContext follows the governor's render scale itself; a
        // second resize from here ran every tier change twice.
        const governor = context.own(setupFpsGovernor(module));
        context.own(exposeGovernorGlobals(governor));
        const fbo = context.own(setupFboFormatIndicator(module));
        context.own(exposeFboFormatGlobals(() => fbo.format()));
        context.own(setupPerfTools(module));
        context.own(exposePresetDevGlobals(context.own(setupPresetDevTools(module, { startTransitionWhenReady }))));
        context.own(exposeExperimentalGlobals(context.own(setupExperimentalBridge(module))));
        context.own(setupAudioTestPanel(() => getModule(), { documentRef }));
        return;
    }
    const transport = context.transport;
    if (transport) context.own(setupTransportPerfTools(transport));
    const workerHandle = transport?.workerHandle;
    if (workerHandle) {
        const fbo = context.own(setupWorkerFboFormatIndicator(workerHandle));
        context.own(exposeFboFormatGlobals(() => fbo.format()));
    }
    console.info(
        `${log} Rendering in the render worker; the preset dev tools and experimental bridge are inactive (use ?renderWorker=0 for them).`
    );
}
