import type { ProjectMContext } from './projectm-context.ts';
import type { ProjectMAudioSource, ProjectMMeshQuality } from './projectm-context.ts';

export { ELEMENT_TAG, OBSERVED_ATTRIBUTES } from './projectm-element-attributes.js';

export interface ProjectMElementRegisterOptions {
    tagName?: string;
}

export declare class ProjectMVisualizerElement extends HTMLElement {
    static readonly observedAttributes: readonly string[];
    readonly context: ProjectMContext | null;
    ready(): Promise<ProjectMContext | null>;
    loadPreset(url: string): Promise<{ url: string; vfsPath: string; filename: string }>;
    loadPresetFile(file: File): Promise<{ filename: string; vfsPath: string }>;
    nextPreset(): void;
}

export declare function registerProjectMElement(options?: ProjectMElementRegisterOptions): void;

export declare function buildProjectMWasmUrls(baseUrl?: string): {
    scriptPm: string;
    scriptRoot: string;
    wasm: string;
    worker: string;
};

export type { ProjectMAudioSource, ProjectMMeshQuality };
