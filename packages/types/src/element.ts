// `<project-m-visualizer>`'s public surface (@projectm/types/element): the
// props a framework wrapper maps onto its attributes, and the lifecycle events
// it dispatches. html/projectm-element.js implements it; packages/web's React,
// Svelte and Vue wrappers import these instead of describing the element again.
//
// Two lists in html/ are the run-time half and are checked against this file:
// OBSERVED_ATTRIBUTES (html/projectm-element-attributes.js) by
// tests/web/projectm-element-types.test.mjs, and EVENT_FOR_HANDLER
// (packages/web/src/bindings.js) by its JSDoc type.

import type {
    ProjectMAudioSource,
    ProjectMAudioSourceStatus,
    ProjectMErrorDetail,
    ProjectMMeshQuality,
    ProjectMPresetDetail,
} from './context.ts';

/** `pm-preset-changed`'s detail: the preset that loaded, and the URL it came from when it came from one. */
export interface ProjectMVisualizerPresetDetail extends ProjectMPresetDetail {
    url?: string;
}

/** The events the element dispatches (bubbling, composed), by type. */
export interface ProjectMVisualizerEventMap {
    /** The engine is running; `version` is the WASM bundle's URL. */
    'pm-ready': CustomEvent<{ version: string }>;
    /** A failed start (once per failure) or an engine error. */
    'pm-error': CustomEvent<ProjectMErrorDetail>;
    'pm-preset-changed': CustomEvent<ProjectMVisualizerPresetDetail>;
    'pm-fps': CustomEvent<{ fps: number }>;
    'pm-audio-source': CustomEvent<ProjectMAudioSourceStatus>;
}

/** The detail of event `K`. */
export type ProjectMVisualizerEventDetail<K extends keyof ProjectMVisualizerEventMap> =
    ProjectMVisualizerEventMap[K]['detail'];

/**
 * The element's attributes as camelCase props: one per OBSERVED_ATTRIBUTES
 * entry. `false`, `null` and `undefined` remove the attribute, `true` sets it
 * empty (the boolean attributes), arrays are JSON-encoded.
 */
export interface ProjectMVisualizerAttributeProps {
    presetUrl?: string;
    audioSource?: ProjectMAudioSource;
    /** A CSS selector for the `<audio>` / `<video>` with `audioSource: 'element'`. */
    audioElement?: string;
    wasmBaseUrl?: string;
    wasmScriptUrl?: string;
    meshQuality?: ProjectMMeshQuality;
    targetFps?: number;
    transparent?: boolean;
    locked?: boolean;
    crossoriginIsolated?: boolean;
    requireCrossOriginIsolation?: boolean;
    externalPcmOrigins?: string[];
}

/** A handler prop: the event's detail, then the event. */
export type ProjectMVisualizerHandler<K extends keyof ProjectMVisualizerEventMap> = (
    detail: ProjectMVisualizerEventDetail<K>,
    event: ProjectMVisualizerEventMap[K]
) => void;

/**
 * Which event each handler prop subscribes to: the type of packages/web's
 * EVENT_FOR_HANDLER, and what {@link ProjectMVisualizerHandlerProps} is made of.
 */
export interface ProjectMVisualizerEventForHandler {
    readonly onReady: 'pm-ready';
    readonly onError: 'pm-error';
    readonly onPresetChanged: 'pm-preset-changed';
    readonly onFps: 'pm-fps';
    readonly onAudioSource: 'pm-audio-source';
}

/** The element's events as `on*` props. */
export type ProjectMVisualizerHandlerProps = {
    [P in keyof ProjectMVisualizerEventForHandler]?: ProjectMVisualizerHandler<ProjectMVisualizerEventForHandler[P]>;
};

/** Everything a framework wrapper of the element takes. */
export type ProjectMVisualizerProps = ProjectMVisualizerAttributeProps & ProjectMVisualizerHandlerProps;
