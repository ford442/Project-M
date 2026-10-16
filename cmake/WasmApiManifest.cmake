# WasmApiManifest.cmake
#
# WASM JavaScript API metadata: signatures, bindings, and visibility tiers.
# Included by cmake/EmscriptenWasmFlags.cmake; drives generation of
# html/generated/projectm-wasm-api.ts via cmake/GenerateWasmLinkCommon.cmake.
#
# Each entry: name|visibility|binding|returns|args|doc
#   visibility: public | internal | runtime | debug
#   binding:    direct | ccall
#   returns:    void | number | boolean | string
#   args:       comma-separated name:type pairs (types: number, boolean, string, pointer)
#
# This list *is* the export list: cmake/EmscriptenWasmFlags.cmake derives
# EXPORTED_FUNCTIONS from it. `public` entries are the @projectm/web surface
# (gated by scripts/check_wasm_public_api.sh), `internal` ones are called by
# the in-repo host layer only, `runtime` ones are Emscripten's own (no wrapper
# is generated). `debug` entries are test hooks: their C names start with
# debug_, and the link exports them only with PROJECTM_WASM_DEBUG_EXPORTS=1 (the
# default of scripts/build_wasm_smoke_wrapper.sh, never of a deployed bundle).
# They get generated wrappers so a test can reach them through the render
# transport, but no host code may call them.
#
# Every entry must have a caller in html/, packages/web/src or tests/
# (scripts/check_wasm_public_api.sh --no-orphans); an export nothing calls is
# removed, not kept "just in case".

set(PROJECTM_WASM_API_MANIFEST
    "malloc|runtime|direct|number|size:number|Allocate bytes on the WASM heap"
    "free|runtime|direct|void|ptr:number|Free a WASM heap allocation"
    "debug_add_audio_data|debug|direct|void|data:pointer,len:number|Legacy uint8 PCM feed"
    "pl|internal|ccall|void|songPath:string|Play audio file from VFS path"
    "destruct|internal|direct|void||Tear down projectM engine"
    "debug_get_projectm_handle|debug|direct|number||Opaque projectM handle pointer"
    "init|public|direct|number||Initialize EGL/WebGL and projectM, returns 0 on success"
    "set_canvas_selectors|public|ccall|void|primary:string,secondary:string|Set primary/secondary canvas CSS selectors (default #mcanvas/#scanvas)"
    "set_context_config|public|ccall|void|antialias:number,preserveDrawingBuffer:number,depth:number,stencil:number,alpha:number,powerPreference:number,fboPrecision:number|Deprecated shim for host JS that predates create_host_with_config(): sets the active host's config if it has no context yet, else holds it for the next context created (fboPrecision: 0=RGBA16F, 1=RGBA32F, 2=RGBA8)"
    "set_render_path_overrides|public|direct|void|blurCopyPath:boolean,copyShaderPath:boolean,perPixelForceCpu:boolean|Set the ?blurPath=copy / ?copyPath=shader / ?perPixelEval=cpu ablation switches from the host (call before init — overrides the URL and is the only way they reach the render worker)"
    "get_render_path_overrides|public|direct|number||Render-path switches in effect as a bitmask (1=blurPath copy, 2=copyPath shader, 4=perPixelEval cpu)"
    "init_with_canvases|public|ccall|number|primary:string,secondary:string|Set canvas selectors then init (returns 0 on success)"
    "rebind_canvases|public|ccall|number|primary:string,secondary:string|Tear down and re-init against new canvas selectors (single-instance)"
    "create_host|public|ccall|number|primary:string,secondary:string|Create and init a new engine instance on the given canvases, returning an opaque host handle (0 if at the instance cap or init failed)"
    "create_host_with_config|public|ccall|number|primary:string,secondary:string,flags:number,powerPreference:number,fboPrecision:number|Create and init an engine instance whose WebGL context uses this config (flags: bitmask of CONTEXT_CONFIG_FLAGS, powerPreference 0 default/1 low-power/2 high-performance, fboPrecision 0=RGBA16F/1=RGBA32F/2=RGBA8), returning its host handle or 0 (see get_last_init_error)"
    "get_last_init_error|public|direct|number||Code of the most recent init()/create_host*() failure, 0 after a success (docs/EMSCRIPTEN.md Init Error Codes)"
    "set_active_host|public|ccall|void|handle:number|Select which host subsequent no-handle exports operate on and make its WebGL context current (0 = default host)"
    "get_active_host|public|direct|number||Opaque handle of the active host (0 if none)"
    "destroy_host|public|ccall|void|handle:number|Tear down and free a host created with create_host()"
    "host_count|public|direct|number||Number of live engine instances in this Module"
    "max_host_count|public|direct|number||Compile-time cap on simultaneous engine instances per Module"
    "load_preset_file|public|ccall|void|vfsPath:string|Load preset from Emscripten VFS path"
    "load_preset_file_hard|public|ccall|void|vfsPath:string|Load preset from VFS path with a hard cut (no crossfade)"
    "switch_preset|public|direct|void||Advance playlist to next preset"
    "set_preset_duration|public|direct|void|seconds:number,randomExtraSeconds:number|How long each preset runs before the timer switches: seconds plus a uniform random 0..randomExtraSeconds from the seeded RNG (default 30 s, no random part)"
    "set_aspect_correction|public|direct|void|enabled:boolean|Enable bezel/aspect correction"
    "render_frame|public|direct|void||Render one visualization frame"
    "start_render|public|direct|void|width:number,height:number|Create render targets and start loop"
    "set_window_size|public|direct|void|width:number,height:number|Resize projectM viewport"
    "set_mesh|public|direct|void|width:number,height:number|Set per-pixel mesh grid size"
    "add_preset_file|public|ccall|void|vfsPath:string|Add preset file to playlist"
    "projectm_pcm_add_float_wrapper|public|direct|void|pmHandle:number,audioPtr:pointer,samplesPerChannel:number,channels:number|Feed interleaved float PCM (use feedPcmFloat helper)"
    "pcm_ring_init|public|direct|number|capacityFrames:number|Allocate the WASM-owned PCM ring (0 = default 16384 frames), returns 1 on success"
    "debug_pcm_ring_drain|debug|direct|number||Feed every frame written since the last drain, returns frames fed"
    "get_pcm_ring_header_ptr|public|direct|number||Byte offset of the ring's int32 header in the WASM heap"
    "get_pcm_ring_data_ptr|public|direct|number||Byte offset of the ring's interleaved float storage in the WASM heap"
    "get_pcm_ring_capacity_frames|public|direct|number||Ring capacity in stereo frames"
    "get_pcm_ring_index_modulus|public|direct|number||Modulus the ring's frame indices wrap at"
    "debug_get_pcm_ring_write_index|debug|direct|number||Current producer write index, in frames"
    "debug_get_pcm_ring_read_index|debug|direct|number||Current drain read index, in frames"
    "debug_get_pcm_ring_overruns|debug|direct|number||Drains that skipped unread audio because producers lapped the ring"
    "attach_worklet_ingest|public|direct|void||Hand the audio worklet its ring descriptor and install the postMessage fallback"
    "debug_create_sprite|debug|direct|void||Create demo user sprite"
    "stop_worklet_playback|internal|direct|void||Stop audio worklet playback"
    "set_audio_source_to_stream|internal|direct|void|isStreaming:boolean|Toggle streaming vs capture audio source"
    "set_preset_locked|public|direct|void|locked:boolean|Lock or unlock automatic preset switching"
    "set_transparency_mode|public|direct|void|enabled:boolean|Enable glass-layer transparency on near-black pixels"
    "get_transparency_mode|public|direct|boolean||Whether transparency mode is enabled"
    "set_transparency_threshold|public|direct|void|threshold:number|Set RGB threshold for transparency mode (default 0.01)"
    "set_perf_hud|internal|direct|void|enabled:number|Toggle on-canvas performance HUD"
    "set_target_fps|public|direct|void|fps:number|Set render target frame rate"
    "set_quality_governor|public|direct|void|enabled:boolean|Enable adaptive quality governor"
    "get_quality_tier|public|direct|number||Current quality tier index (0=high, 1=regular, 2=low)"
    "get_governor_render_scale|public|direct|number||Current governor internal render-scale factor (1.0/0.75/0.5)"
    "get_governor_blur_cap|public|direct|number||Current governor blur-level cap (-1 = unlimited, else 0-3)"
    "debug_is_preset_ready|debug|direct|number|minFramesSinceReady:number|Whether preset shaders are ready"
    "get_rendered_frame_count|internal|direct|number||Total frames rendered since init"
    "debug_preset_switch_failed|debug|direct|number||Whether last preset switch failed (0/1)"
    "debug_get_preset_duration|debug|direct|number||Current preset duration in seconds as the engine timer sees it (set_preset_duration() test hook)"
    "debug_live_playlist_count|debug|direct|number||Playlists created by init() and not yet destroyed, across all hosts (lifecycle test hook)"
    "debug_get_main_loop_timing_mode|debug|direct|number||Emscripten main-loop timing mode (1 = requestAnimationFrame), -1 before start_render (pacing test hook)"
    "get_omp_enabled|internal|direct|number||Whether OpenMP was compiled in (0/1)"
    "get_omp_max_threads|internal|direct|number||Configured OpenMP max thread count"
    "get_omp_thread_count_in_parallel|internal|direct|number||OpenMP threads observed in parallel region"
    "get_omp_blocktime|internal|direct|number||libomp spin-wait blocktime in ms (0 = sleep immediately, -1 = no libomp)"
    "shader_cache_begin_load|internal|ccall|void|cacheKey:string|Begin preset load with optional transpiled GLSL cache key"
    "shader_cache_import_glsl|internal|ccall|void|shaderType:number,glsl:string|Inject cached transpiled GLSL (0=warp, 1=composite)"
    "shader_cache_end_load|internal|direct|void||Clear transpiled GLSL cache key after preset load"
    "get_glsl_generator_version|public|direct|number||GLSL generator version enum for cache invalidation"
    "pm_handle_context_loss|public|direct|void||Tear down GL state after WebGL context loss"
    "dual_fbo_begin_transition|public|direct|boolean||Allocate preset-B FBO for transition"
    "debug_dual_fbo_end_transition|debug|direct|void||Finalize dual-FBO transition"
    "dual_fbo_cancel_transition|internal|direct|void||Cancel in-progress dual-FBO transition"
    "dual_fbo_is_preset_a_allocated|public|direct|boolean||Whether preset-A FBO is allocated (lazily allocated per transition)"
    "dual_fbo_is_preset_b_allocated|public|direct|boolean||Whether preset-B FBO is allocated"
    "dual_fbo_is_preset_b_ready|public|direct|boolean||Whether preset-B shaders are ready"
    "dual_fbo_get_format|public|direct|number||Dual-FBO format (0=RGBA16F, 1=RGBA32F, 2=RGBA8 — the fboPrecision numbering)"
    "debug_dual_fbo_render_preset_a|debug|direct|void||Render preset A into dual FBO"
    "debug_dual_fbo_render_preset_b|debug|direct|void||Render preset B into dual FBO"
    "transition_start|public|direct|void||Start visual preset transition blend"
    "transition_is_active|public|direct|boolean||Whether a transition is in progress"
    "transition_set_duration|public|direct|void|seconds:number|Set transition duration in seconds"
    "set_deterministic_seed|public|direct|void|enabled:boolean,seed:number|Pin libprojectM's RNG to a seed so a preset renders identical pixels run to run"
    "is_deterministic_seed|public|direct|boolean||Whether deterministic RNG seeding is active"
    "set_deterministic_clock|public|direct|void|enabled:boolean,fps:number|Drive the engine from a virtual clock where frame N happens at N/fps (golden-image capture only, never perf runs)"
    "is_deterministic_clock|public|direct|boolean||Whether the virtual clock is active"
    "deterministic_now_ms|public|direct|number||The host time base in milliseconds: virtual when the clock is on, real otherwise"
    "deterministic_frame_index|public|direct|number||Frames ticked since the virtual clock was last enabled"
    "set_render_loop_paused|public|direct|void|paused:boolean|Pause/resume the requestAnimationFrame main loop so a harness can drive render_frame() itself"
    "get_rhythm_bpm|public|direct|number||Tempo in BPM from the rhythm analysis (0 while the tracker is not confident)"
    "get_rhythm_beat_phase|public|direct|number||Beat phase 0..1, 0 = the (predicted) beat"
    "get_rhythm_bar_phase|public|direct|number||Bar phase 0..1 over four beats, 0 = downbeat"
    "get_rhythm_confidence|public|direct|number||Tempo tracker confidence 0..1 (1 while a tempo hint is set)"
    "get_rhythm_beat_index|public|direct|number||Beats counted since the engine started"
    "get_rhythm_section|public|direct|number||Section index, incremented on every detected section change"
    "set_rhythm_hint|public|direct|void|bpm:number|Use a known tempo (MIDI clock, track BPM) instead of estimating it (0 goes back to estimating)"
    "set_preset_switch_policy|public|direct|void|policy:number,bars:number|Switch presets on the timer (0), every N bars (1) or on a detected section change (2), bars 0 = 16"
    "transition_set_duration_beats|public|direct|void|beats:number|Crossfade length in beats, resolved against the tempo when each crossfade starts (0 = use seconds)"
    "set_hard_cut_on_beat|public|direct|void|enabled:boolean|Make beat-detection hard cuts wait for the next beat"
    "set_rhythm_events|public|direct|void|enabled:boolean|Report beats, bars and section changes to globalThis.pmOnRhythmEvent (off by default)"
    "set_flash_limit_enabled|public|direct|void|enabled:boolean|Turn the temporal flash limiter on or off (off by default, see docs/FLASH_LIMITER.md)"
    "get_flash_limit_enabled|public|direct|boolean||Whether the flash limiter is on"
    "set_flash_limit_threshold|public|direct|void|threshold:number|Span of mean relative luminance (0.005..1, default 0.06) the presented frames may cover within the limiter's ~1/3 s memory"
    "get_flash_limit_threshold|public|direct|number||The flash limiter's threshold"
    "get_flash_limit_clamped_frames|public|direct|number||Frames the flash limiter blended toward the previous frame since it was enabled (reads back from the GPU: poll a few times a second at most)"
    "get_committed_frame_count|public|direct|number||emscripten_webgl_commit_frame() calls since the host was created (0 unless the host presents manually)"
    "capture_frame_request|public|direct|number||Read back the next rendered frame (1 accepted, 0 no context), replacing an unclaimed capture"
    "capture_frame_status|public|direct|number||Capture state: 0 idle, 1 requested, 2 pending (GPU read in flight), 3 ready, 4 failed (never waits)"
    "capture_frame_resolve|public|direct|number|wait:boolean|capture_frame_status(), but wait=true takes a pending capture now, waiting for the GPU if it must"
    "capture_frame_data_ptr|public|direct|number||Heap address of the ready capture's RGBA8 pixels, top row first (0 unless ready)"
    "capture_frame_width|public|direct|number||Width in pixels of the last capture"
    "capture_frame_height|public|direct|number||Height in pixels of the last capture"
    "capture_frame_index|public|direct|number||get_rendered_frame_count() right after the captured frame"
    "capture_frame_release|public|direct|void||Free the captured pixels"
)

# init() / create_host*() failure codes: what init() returns, what
# get_last_init_error() reports, and the `code` of globalThis.pmReportInitError.
# Generates `enum class WasmInitError` (cmake/generated/ProjectMWasmInitErrors.hpp,
# included by src/wasm/ProjectMWasmInternal.hpp) and INIT_ERROR
# (html/generated/projectm-init-error-codes.js, read by html/projectm-init-errors.js),
# so the C++ and JS numberings cannot drift. Codes are part of the host contract:
# never renumber one, only add. The JS constant name is the C++ name in
# UPPER_SNAKE_CASE. docs/EMSCRIPTEN.md "Init Error Codes" describes each.
#
# Each entry: code|Name|doc
set(PROJECTM_WASM_INIT_ERRORS
    "0|Ok|Success"
    "2|ContextCreateFailed|emscripten_webgl_create_context() returned 0: no WebGL 2"
    "3|EngineCreateFailed|projectm_create() returned null after the context came up"
    "4|CrossOriginIsolation|JS-side only: crossOriginIsolated is false, so SharedArrayBuffer and pthreads are unavailable"
    "5|ContextLost|The host's WebGL context is lost and not yet restored (not an error to show)"
    "6|CanvasMissing|The primary canvas selector resolves to nothing"
    "7|MakeCurrentFailed|The context was created but could not be made current"
    "8|PerformanceCaveat|failIfMajorPerformanceCaveat refused a software (SwiftShader / llvmpipe) context"
    "9|ExplicitSwapUnavailable|explicitSwapControl was requested of a bundle linked without OFFSCREEN_FRAMEBUFFER"
    "10|InstanceLimit|create_host*() refused: the Module already runs kMaxHosts engines"
)

# Exports that act on the host registry rather than on the active host's engine.
# Everything else in the manifest operates on whichever host set_active_host()
# selected last, so the generated bindModuleToHost() activates its host before
# any other call; these are passed through untouched (activating first would be
# wrong for get_active_host and pointless for the rest).
set(PROJECTM_WASM_API_HOST_REGISTRY
    malloc
    free
    create_host
    create_host_with_config
    get_last_init_error
    set_active_host
    get_active_host
    destroy_host
    host_count
    max_host_count
)
