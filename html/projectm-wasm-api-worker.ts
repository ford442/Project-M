// projectm-wasm-api-worker.ts
//
// Typed symbol names for the render-worker ccall proxy. The worker itself runs
// untyped JS; the main-thread host imports these constants to avoid string drift.

export { WASM_API_SYMBOLS, type ProjectMModule } from './generated/projectm-wasm-api.js';

/** ccall names used by projectm-render-worker-host.js today. */
export const WORKER_CCALL_SYMBOLS = {
    setPresetLocked: 'set_preset_locked',
    loadPresetFile: 'load_preset_file',
    addPresetFile: 'add_preset_file',
} as const;
