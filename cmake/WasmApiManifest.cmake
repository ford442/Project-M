# WasmApiManifest.cmake
#
# The WASM export list: every C export of the src/wasm/ wrapper, its JavaScript
# binding and its documentation. It is the only place an export is written down.
# scripts/sync_wasm_link_common.sh (cmake/GenerateWasmLinkCommon.cmake) generates
# from it:
#   - the link's EXPORTED_FUNCTIONS (scripts/wasm_link_common.inc.sh);
#   - src/wasm/generated/WasmApiImpl.hpp: the WasmApi:: implementation each
#     entry needs, which the src/wasm/ TUs define;
#   - src/wasm/generated/WasmApiExports.cpp: the extern "C" exports themselves,
#     each behind an exception barrier;
#   - html/generated/projectm-wasm-api.{ts,js}: typed wrappers, signatures and
#     bindModuleToHost()/createHostApi().
#
# Each entry: name|visibility|scope|binding|returns|args|doc
#   visibility: public | internal | runtime
#   scope (docs/WASM_JS_API.md "ABI v2"):
#     host                      engine export. Implemented as
#                               WasmApi::<name>(WasmHost&, args...); exported as
#                               pm_<name>(host, args...) and, for one bundle
#                               version, as the compat shim <name>(args...) on
#                               the host set_active_host() selected.
#     host-v2                   like host, but only pm_<name>(host, args...).
#     handle:<pm_name>          legacy export whose first argument already is a
#                               host handle (pmHandle); implemented as
#                               WasmApi::<pm_name minus pm_>(WasmHost&, rest...)
#                               and exported as <pm_name>(host, rest...) plus
#                               the compat <name>(pmHandle, rest...).
#     handle-or-active:<pm_name> the same, except the compat export's pmHandle 0
#                               means the active host (legacy PCM feed).
#     alias:<impl>              compat-only export over the active host for the
#                               WasmApi::<impl> another entry implements.
#     module                    not engine state (the host registry, process
#                               info, the shared main loop and audio graph):
#                               WasmApi::<name>(args...), exported as <name>.
#     legacy                    compat-only, works on the active host (init(),
#                               set_active_host(), ...): WasmApi::<name>(args...),
#                               exported as <name>, going away with the shims.
#     runtime                   Emscripten runtime helper (malloc/free).
#   binding: direct | ccall (how the generated JS calls it)
#   returns / args: C types, args as comma-separated name:type pairs:
#     void bool i32 u32 f32 f64 usize cstr, and pointers i32* u32* f32* u8*.
#     JavaScript sees bool as boolean, cstr as string, everything else as a
#     number. A return type may carry the value an export returns when it
#     fails, e.g. i32=-1 (default 0 / false / null).
#   doc: one line, copied into the generated wrappers. No semicolons: CMake
#        would split the entry there.
#
# A pm_<name> export takes the host handle create_host*() returned, or 0 for
# the implicit default host a legacy init() brought up. It never creates a
# host, never changes which host is active, and returns the failure value for
# a handle that names no live host.

set(PROJECTM_WASM_API_MANIFEST
    "malloc|runtime|runtime|direct|usize|size:usize|Allocate bytes on the WASM heap"
    "free|runtime|runtime|direct|void|ptr:usize|Free a WASM heap allocation"
    "add_audio_data|internal|legacy|direct|void|data:u8*,len:i32|Legacy uint8 PCM feed"
    "pl|internal|module|ccall|void|songPath:cstr|Play audio file from VFS path"
    "destruct|internal|host|direct|void||Tear down projectM engine"
    "get_projectm_handle|public|host|direct|usize||Opaque projectM handle of the active host: the pmHandle the projectm_sprite_*_wrapper and PCM exports take (its host handle, 0 without an engine)"
    "init|public|host|direct|i32=-1||Initialize (or after a context loss re-initialize) EGL/WebGL and projectM on the host, returns 0 on success, -1 for an unknown host"
    "set_canvas_selectors|public|legacy|ccall|void|primary:cstr,secondary:cstr|Set primary/secondary canvas CSS selectors (default #mcanvas/#scanvas)"
    "set_context_config|public|legacy|ccall|void|antialias:i32,preserveDrawingBuffer:i32,depth:i32,stencil:i32,alpha:i32,powerPreference:i32,fboPrecision:i32|Deprecated shim for host JS that predates create_host_with_config(): sets the active host's config if it has no context yet, else holds it for the next context created (fboPrecision: 0=RGBA16F, 1=RGBA32F, 2=RGBA8)"
    "set_render_path_overrides|public|module|direct|void|blurCopyPath:bool,copyShaderPath:bool,perPixelForceCpu:bool|Set the ?blurPath=copy / ?copyPath=shader / ?perPixelEval=cpu ablation switches for every engine created afterwards (call before init / create_host — overrides the URL and is the only way they reach the render worker)"
    "get_render_path_overrides|public|host|direct|i32||Render-path switches this host's engine runs with as a bitmask (1=blurPath copy, 2=copyPath shader, 4=perPixelEval cpu, 0 without an engine)"
    "init_with_canvases|public|legacy|ccall|i32|primary:cstr,secondary:cstr|Set canvas selectors then init (returns 0 on success)"
    "rebind_canvases|public|host|ccall|i32|primary:cstr,secondary:cstr|Tear down and re-init against new canvas selectors (single-instance)"
    "create_host|public|module|ccall|usize|primary:cstr,secondary:cstr|Create and init a new engine instance on the given canvases, returning an opaque host handle (0 if at the instance cap or init failed)"
    "create_host_with_config|public|module|ccall|usize|primary:cstr,secondary:cstr,flags:i32,powerPreference:i32,fboPrecision:i32|Create and init an engine instance whose WebGL context uses this config (flags: bitmask of CONTEXT_CONFIG_FLAGS, powerPreference 0 default/1 low-power/2 high-performance, fboPrecision 0=RGBA16F/1=RGBA32F/2=RGBA8), returning its host handle or 0 (see get_last_init_error)"
    "get_last_init_error|public|module|direct|i32||Code of the last create_host*() that returned 0, else the active host's last init() failure, 0 after a success (docs/EMSCRIPTEN.md Init Error Codes)"
    "set_active_host|public|legacy|ccall|void|handle:usize|Select which host subsequent no-handle exports operate on and make its WebGL context current (0 = default host)"
    "get_active_host|public|legacy|direct|usize||Opaque handle of the active host (0 if none)"
    "destroy_host|public|module|ccall|void|handle:usize|Tear down and free a host created with create_host()"
    "host_count|public|module|direct|i32||Number of live engine instances in this Module"
    "max_host_count|public|module|direct|i32||Compile-time cap on simultaneous engine instances per Module"
    "load_preset_file|public|host|ccall|void|vfsPath:cstr|Load preset from Emscripten VFS path"
    "load_preset_file_hard|public|host|ccall|void|vfsPath:cstr|Load preset from VFS path with a hard cut (no crossfade)"
    "load_preset_data|public|host|ccall|i32|data:u8*,len:usize,name:cstr,mode:i32|Hand a preset to the engine as bytes the caller wrote to the WASM heap (data/len, freed by the caller after the call), stored under name (an absolute path, a relative one goes under /presets/) so the playlist and a context-loss reload find it by that name. mode: 0 load, 1 load with a hard cut, 2 add to the playlist, 3 store only (load it later by name). Returns 1, or 0 for a bad name or mode, when the bytes could not be stored, or without an engine (modes 0 to 2)"
    "switch_preset|public|host|direct|void||Advance playlist to next preset"
    "set_aspect_correction|public|host|direct|void|enabled:bool|Enable bezel/aspect correction"
    "render_frame|public|host|direct|void||Render one visualization frame"
    "start_render|public|host|direct|void|width:i32,height:i32|Create render targets and start loop"
    "set_window_size|public|host|direct|void|width:i32,height:i32|Resize projectM viewport"
    "set_mesh|public|host|direct|void|width:i32,height:i32|Set per-pixel mesh grid size"
    "add_preset_path|internal|host|direct|void||Register default /presets/ playlist directory"
    "add_existing_vfs_presets|internal|host|direct|void||Bulk-add numbered presets from VFS"
    "add_preset_file|public|host|ccall|void|vfsPath:cstr|Add preset file to playlist"
    "add_custom_milk_paths|internal|host|direct|void|count:i32|Add custom_milk_fixed presets by count"
    "projectm_pcm_add_float_wrapper|public|handle-or-active:pm_pcm_add_float|direct|void|pmHandle:usize,audioPtr:f32*,samplesPerChannel:u32,channels:i32|Feed interleaved float PCM (use feedPcmFloat helper)"
    "pcm_ring_init|public|host|direct|i32|capacityFrames:i32|Allocate the WASM-owned PCM ring (0 = default 16384 frames), returns 1 on success"
    "pcm_ring_shutdown|internal|host|direct|void||Release the PCM ring"
    "pcm_ring_drain|internal|host|direct|i32||Feed every frame written since the last drain, returns frames fed"
    "get_pcm_ring_header_ptr|public|host|direct|usize||Byte offset of the ring's int32 header in the WASM heap"
    "get_pcm_ring_data_ptr|public|host|direct|usize||Byte offset of the ring's interleaved float storage in the WASM heap"
    "get_pcm_ring_capacity_frames|public|host|direct|i32||Ring capacity in stereo frames"
    "get_pcm_ring_index_modulus|public|host|direct|i32||Modulus the ring's frame indices wrap at"
    "get_pcm_ring_write_index|internal|host|direct|i32||Current producer write index, in frames"
    "get_pcm_ring_read_index|internal|host|direct|i32||Current drain read index, in frames"
    "get_pcm_ring_overruns|internal|host|direct|i32||Drains that skipped unread audio because producers lapped the ring"
    "attach_worklet_ingest|public|module|direct|void||Hand the audio worklet its ring descriptor and install the postMessage fallback"
    "pcm_ring_release_retired|internal|module|direct|bool|headerPtr:usize|The audio worklet dropped its views of the released ring at headerPtr (its pcmRingDetached answer): the storage may be reused. Returns whether such a ring was parked"
    "pcm_ring_parked_count|internal|module|direct|i32||Released rings still parked until the audio worklet acknowledges their pcmRingDetach"
    "connect_media_element_source|public|module|ccall|i32|selector:cstr|Route an <audio>/<video> element into the worklet (returns 1 on success)"
    "create_sprite|public|alias:sprite_create|ccall|u32|type:cstr,code:cstr|Create a user sprite on the active host (type 'milkdrop', code in the Milkdrop sprite format), returning its id, or 0 on failure or at the sprite limit"
    "projectm_sprite_create_wrapper|public|handle:pm_sprite_create|ccall|u32|pmHandle:usize,type:cstr,code:cstr|Create a user sprite on the engine pmHandle names (see create_sprite). Every projectm_sprite_*_wrapper is a no-op for a stale or unknown pmHandle"
    "projectm_sprite_destroy_wrapper|public|handle:pm_sprite_destroy|direct|void|pmHandle:usize,spriteId:u32|Destroy one user sprite"
    "projectm_sprite_destroy_all_wrapper|public|handle:pm_sprite_destroy_all|direct|void|pmHandle:usize|Destroy every user sprite"
    "projectm_sprite_get_sprite_count_wrapper|public|handle:pm_sprite_get_sprite_count|direct|u32|pmHandle:usize|Number of live user sprites"
    "projectm_sprite_get_sprite_ids_wrapper|public|handle:pm_sprite_get_sprite_ids|direct|void|pmHandle:usize,spriteIds:u32*|Write the live sprite ids, oldest first, to a uint32 array of projectm_sprite_get_sprite_count_wrapper() entries on the WASM heap"
    "projectm_sprite_set_max_sprites_wrapper|public|handle:pm_sprite_set_max_sprites|direct|void|pmHandle:usize,maxSprites:u32|Sprite limit (lowering it destroys the oldest sprites over it)"
    "projectm_sprite_get_max_sprites_wrapper|public|handle:pm_sprite_get_max_sprites|direct|u32|pmHandle:usize|Current sprite limit"
    "projectm_sprite_get_var_wrapper|public|handle:pm_sprite_get_var|ccall|f64|pmHandle:usize,spriteId:u32,varName:cstr|Value of a sprite expression variable (0 for an unknown sprite or variable)"
    "projectm_sprite_set_var_wrapper|public|handle:pm_sprite_set_var|ccall|void|pmHandle:usize,spriteId:u32,varName:cstr,value:f64|Set a sprite expression variable (per-frame code may overwrite it on the next frame)"
    "reload_texture|internal|host|ccall|i32|name:cstr|Re-read a texture file rewritten in the VFS into the active host's loaded texture so running presets sample the new image (1 if a loaded texture was updated, 0 if it was not loaded from a file)"
    "texture_slot_register|public|host|ccall|i32|name:cstr,width:i32,height:i32|Create or resize a live texture on the active host (RGBA8, starts black, 1..8192 px a side) that presets sample by name (sampler_<name>), with its staging buffer on the WASM heap (1 on success). Register before loading presets that sample it"
    "texture_slot_buffer|public|host|ccall|usize|name:cstr,bytes:i32|Heap address to write a live texture's next frame to (RGBA8, top row first), or 0 for an unknown slot or when bytes is not its width*height*4"
    "texture_slot_commit|public|host|ccall|i32|name:cstr|Mark the frame written to texture_slot_buffer() complete, for the next render_frame() to upload once (1 if the slot exists)"
    "texture_slot_generation|public|host|ccall|u32|name:cstr|Generation of a live texture's staging buffer: it changes whenever texture_slot_buffer()'s address would (a resize, or the slot recreated), 0 for an unknown slot. A page that awaited between getting the buffer and writing it checks this first"
    "texture_slot_commit_generation|public|host|ccall|i32|name:cstr,generation:u32|texture_slot_commit(), refused for a buffer generation the slot has replaced: 1 committed, 0 unknown slot, -1 stale (the host's last error becomes 3)"
    "texture_slot_unregister|public|host|ccall|i32|name:cstr|Remove a live texture (1 if it existed). Presets sampling it keep its last frame until reloaded"
    "eval_set|public|host|ccall|i32|name:cstr,value:f64|Set a per-frame variable (q1..q32, zoom, decay, wave_r, ...) for every preset from the next frame on, loaded before the preset's per-frame code runs, until eval_clear() (1 if accepted, read-only inputs such as time or bass are refused)"
    "eval_clear|public|host|ccall|i32|name:cstr|Remove an eval_set() value, or every value for an empty name (1 if one was removed)"
    "stop_worklet_playback|internal|module|direct|void||Stop audio worklet playback"
    "set_audio_source_to_stream|internal|module|direct|void|isStreaming:bool|Toggle streaming vs capture audio source"
    "set_preset_locked|public|host|direct|void|locked:bool|Lock or unlock automatic preset switching"
    "set_transparency_mode|public|host|direct|void|enabled:bool|Enable glass-layer transparency on near-black pixels"
    "get_transparency_mode|public|host|direct|bool||Whether transparency mode is enabled"
    "set_transparency_threshold|public|host|direct|void|threshold:f32|Set RGB threshold for transparency mode (default 0.01)"
    "get_transparency_threshold|public|host|direct|f32||Current transparency threshold"
    "set_perf_hud|internal|host|direct|void|enabled:i32|Toggle on-canvas performance HUD"
    "set_target_fps|public|host|direct|void|fps:i32|Set render target frame rate"
    "set_quality_governor|public|host|direct|void|enabled:bool|Enable adaptive quality governor"
    "get_quality_tier|public|host|direct|i32||Current quality tier index (0=high, 1=regular, 2=low)"
    "get_governor_render_scale|public|host|direct|f64||Current governor internal render-scale factor (1.0/0.75/0.5)"
    "get_governor_blur_cap|public|host|direct|i32||Current governor blur-level cap (-1 = unlimited, else 0-3)"
    "is_preset_ready|internal|host|direct|i32|minFramesSinceReady:i32|Whether preset shaders are ready"
    "get_rendered_frame_count|internal|host|direct|i32||Total frames rendered since init"
    "preset_switch_failed|internal|host|direct|i32||Whether last preset switch failed (0/1)"
    "live_playlist_count|internal|module|direct|i32||Playlists created by init() and not yet destroyed, across all hosts (lifecycle test hook)"
    "get_main_loop_timing_mode|internal|module|direct|i32=-1||Emscripten main-loop timing mode (1 = requestAnimationFrame), -1 before start_render (pacing test hook)"
    "get_omp_enabled|internal|module|direct|i32||Whether OpenMP was compiled in (0/1)"
    "get_omp_max_threads|internal|module|direct|i32||Configured OpenMP max thread count"
    "get_omp_thread_count_in_parallel|internal|module|direct|i32||OpenMP threads observed in parallel region"
    "get_omp_blocktime|internal|module|direct|i32||libomp spin-wait blocktime in ms (0 = sleep immediately, -1 = no libomp)"
    "shader_cache_begin_load|internal|host|ccall|void|cacheKey:cstr|Begin preset load with optional transpiled GLSL cache key"
    "shader_cache_import_glsl|internal|host|ccall|void|shaderType:i32,glsl:cstr|Inject cached transpiled GLSL (0=warp, 1=composite)"
    "shader_cache_end_load|internal|host|direct|void||Clear transpiled GLSL cache key after preset load"
    "get_glsl_generator_version|public|module|direct|i32||GLSL generator version enum for cache invalidation"
    "pm_handle_context_loss|public|legacy:context_lost|direct|void||Tear down GL state after WebGL context loss"
    "dual_fbo_begin_transition|public|host|direct|bool||Allocate preset-B FBO for transition"
    "dual_fbo_end_transition|internal|host|direct|void||Finalize dual-FBO transition"
    "dual_fbo_cancel_transition|internal|host|direct|void||Cancel in-progress dual-FBO transition"
    "dual_fbo_swap_preset_a|internal|host|direct|void||Swap preset A ping-pong buffers"
    "dual_fbo_swap_preset_b|internal|host|direct|void||Swap preset B ping-pong buffers"
    "dual_fbo_get_a_read_fbo|internal|host|direct|u32||Preset A read FBO handle"
    "dual_fbo_get_a_write_fbo|internal|host|direct|u32||Preset A write FBO handle"
    "dual_fbo_get_a_read_tex|internal|host|direct|u32||Preset A read texture handle"
    "dual_fbo_get_a_write_tex|internal|host|direct|u32||Preset A write texture handle"
    "dual_fbo_get_b_read_fbo|internal|host|direct|u32||Preset B read FBO handle"
    "dual_fbo_get_b_write_fbo|internal|host|direct|u32||Preset B write FBO handle"
    "dual_fbo_get_b_read_tex|internal|host|direct|u32||Preset B read texture handle"
    "dual_fbo_get_b_write_tex|internal|host|direct|u32||Preset B write texture handle"
    "dual_fbo_is_preset_a_allocated|public|host|direct|bool||Whether preset-A FBO is allocated (lazily allocated per transition)"
    "dual_fbo_is_preset_b_allocated|public|host|direct|bool||Whether preset-B FBO is allocated"
    "dual_fbo_set_idle_release_seconds|public|host|direct|void|seconds:f32|Idle seconds before the preset-A FBO pair is reclaimed (0=immediate, <0=never)"
    "dual_fbo_get_idle_release_seconds|public|host|direct|f32||Configured preset-A idle release threshold in seconds"
    "dual_fbo_is_preset_b_ready|public|host|direct|bool||Whether preset-B shaders are ready"
    "dual_fbo_get_format|public|host|direct|i32||Dual-FBO format (0=RGBA16F, 1=RGBA32F, 2=RGBA8 — the fboPrecision numbering)"
    "get_context_snapshot|public|host|direct|i32||What this host negotiated with WebGL, packed in an int (0 before init): bit0 has a context, bit1 EXT_color_buffer_float, bit2 EXT_float_blend, bit3 WEBGL_lose_context present, bits 8-9 active dual-FBO format (0=RGBA16F, 1=RGBA32F, 2=RGBA8). Decoded into ProjectMContext.contextSnapshot"
    "dual_fbo_render_preset_a|internal|host|direct|void||Render preset A into dual FBO"
    "dual_fbo_render_preset_b|internal|host|direct|void||Render preset B into dual FBO"
    "transition_start|public|host|direct|void||Start visual preset transition blend"
    "transition_cancel|public|host|direct|void||Cancel active transition"
    "transition_is_active|public|host|direct|bool||Whether a transition is in progress"
    "transition_get_blend|public|host|direct|f32||Current transition blend factor 0..1"
    "transition_set_duration|public|host|direct|void|seconds:f32|Set transition duration in seconds"
    "transition_get_duration|public|host|direct|f32||Configured transition duration in seconds"
    "set_deterministic_seed|public|module|direct|void|enabled:bool,seed:u32|Pin the RNG of every engine in this Module to a seed: the live ones and every one created afterwards (set before init / create_host so engine creation is covered too). One engine only: pm_set_host_deterministic_seed"
    "set_host_deterministic_seed|public|host-v2|direct|void|enabled:bool,seed:u32|Pin this host's engine's RNG to a seed so a preset renders identical pixels run to run. It covers what the engine draws from then on: for what it draws while it is created, set_deterministic_seed() before create_host"
    "is_deterministic_seed|public|host|direct|bool||Whether this host's engine has a deterministic seed"
    "set_deterministic_clock|public|module|direct|void|enabled:bool,fps:f64|Drive every engine in this Module from a virtual clock where frame N happens at N/fps: the live ones and every one created afterwards (golden-image capture only, never perf runs). One engine only: pm_set_host_deterministic_clock"
    "set_host_deterministic_clock|public|host-v2|direct|void|enabled:bool,fps:f64|Drive this host's engine from a virtual clock where frame N happens at N/fps (golden-image capture only, never perf runs)"
    "is_deterministic_clock|public|host|direct|bool||Whether this host's virtual clock is active"
    "deterministic_now_ms|public|host|direct|f64||The host time base in milliseconds: virtual when the clock is on, real otherwise"
    "deterministic_frame_index|public|host|direct|u32||Frames ticked since the virtual clock was last enabled"
    "set_render_loop_paused|public|module|direct|void|paused:bool|Pause/resume the requestAnimationFrame main loop so a harness can drive render_frame() itself"
    "get_rhythm_bpm|public|host|direct|f32||Tempo in BPM from the rhythm analysis (0 while the tracker is not confident)"
    "get_rhythm_beat_phase|public|host|direct|f32||Beat phase 0..1, 0 = the (predicted) beat"
    "get_rhythm_bar_phase|public|host|direct|f32||Bar phase 0..1 over four beats, 0 = downbeat"
    "get_rhythm_confidence|public|host|direct|f32||Tempo tracker confidence 0..1 (1 while a tempo hint is set)"
    "get_rhythm_beat_index|public|host|direct|f64||Beats counted since the engine started"
    "get_rhythm_section|public|host|direct|i32||Section index, incremented on every detected section change"
    "set_rhythm_hint|public|host|direct|void|bpm:f32|Use a known tempo (MIDI clock, track BPM) instead of estimating it (0 goes back to estimating)"
    "set_preset_switch_policy|public|host|direct|void|policy:i32,bars:i32|Switch presets on the timer (0), every N bars (1) or on a detected section change (2), bars 0 = 16"
    "get_preset_switch_policy|public|host|direct|i32||Preset switch policy (0 timer, 1 bars, 2 section)"
    "transition_set_duration_beats|public|host|direct|void|beats:f32|Crossfade length in beats, resolved against the tempo when each crossfade starts (0 = use seconds)"
    "transition_get_duration_beats|public|host|direct|f32||Configured crossfade length in beats (0 = seconds)"
    "set_hard_cut_on_beat|public|host|direct|void|enabled:bool|Make beat-detection hard cuts wait for the next beat"
    "set_rhythm_latency_ms|public|host|direct|void|ms:f64|Delay the beat clock (and switches on it) by the audio output latency, 0..1000 ms, so the visual beat matches the audible one"
    "get_rhythm_latency_ms|public|host|direct|f64||Output latency compensated by the beat clock, ms"
    "set_preset_switch_phrase|public|host|direct|void|bars:i32|Quantise bar/section switches to phrases of N bars counted from the last section change (0 = off)"
    "set_section_hard_cut|public|host|direct|void|enabled:bool|Hard cut on the first downbeat after each detected section change (a drop cut)"
    "set_rhythm_events|public|host|direct|void|enabled:bool|Report beats, bars and section changes to globalThis.pmOnRhythmEvent (off by default)"
    "set_flash_limit_enabled|public|host|direct|void|enabled:bool|Turn the temporal flash limiter on or off (off by default, see docs/FLASH_LIMITER.md)"
    "get_flash_limit_enabled|public|host|direct|bool||Whether the flash limiter is on"
    "set_flash_limit_threshold|public|host|direct|void|threshold:f32|Span of mean relative luminance (0.005..1, default 0.06) the presented frames may cover within the limiter's ~1/3 s memory"
    "get_flash_limit_threshold|public|host|direct|f32||The flash limiter's threshold"
    "get_flash_limit_clamped_frames|public|host|direct|u32||Frames the flash limiter blended toward the previous frame since it was enabled (reads back from the GPU: poll a few times a second at most)"
    "get_committed_frame_count|public|host|direct|u32||emscripten_webgl_commit_frame() calls since the host was created (0 unless the host presents manually)"
    "capture_frame_request|public|host|direct|i32||Read back the next rendered frame (1 accepted, 0 no context), replacing an unclaimed capture"
    "capture_frame_status|public|host|direct|i32||Capture state: 0 idle, 1 requested, 2 pending (GPU read in flight), 3 ready, 4 failed (never waits)"
    "capture_frame_resolve|public|host|direct|i32|wait:bool|capture_frame_status(), but wait=true takes a pending capture now, waiting for the GPU if it must"
    "capture_frame_data_ptr|public|host|direct|usize||Heap address of the ready capture's RGBA8 pixels, top row first (0 unless ready)"
    "capture_frame_width|public|host|direct|i32||Width in pixels of the last capture"
    "capture_frame_height|public|host|direct|i32||Height in pixels of the last capture"
    "capture_frame_index|public|host|direct|u32||get_rendered_frame_count() right after the captured frame"
    "capture_frame_release|public|host|direct|void||Free the captured pixels"
    "debug_emit_events|internal|host-v2|direct|i32=-1||Test hook for the page-event queue: raises every page event about this host from inside the export, returning how many were raised with the host intact after each (-1 if one destroyed it underneath)"
    "debug_throw|internal|host-v2|direct|i32|kind:i32|Test hook for the exception barrier: 1 throws std::runtime_error, 2 allocates past the heap (std::bad_alloc), returning 1 if nothing was thrown"
    "pm_host_is_live|public|module|direct|bool|handle:usize|Whether handle names a live host: create_host*()'s handle until destroy_host(), or 0 while the implicit default host exists"
    "get_init_error|public|host-v2|direct|i32||Code of this host's last init() failure, 0 after a success (docs/EMSCRIPTEN.md Init Error Codes)"
    "get_last_error|public|host-v2|direct|i32||Code of the last error an export reported on this host (0 none, 1 exception, 2 out of memory, 3 stale buffer generation), see pm_get_last_error_message"
    "get_last_error_message|public|host-v2|ccall|cstr||Message of the last error an export reported on this host (\"\" for none)"
    "clear_last_error|public|host-v2|direct|void||Reset this host's last error to 0"
    "context_lost|public|host-v2|direct|void||Tear down this host's engine and GL state after its WebGL context was lost (the per-host form of pm_handle_context_loss)"
)

# -----------------------------------------------------------------------------
# projectm_wasm_api_parse(<entry> <prefix>)
#
# Splits one manifest entry into <prefix>_name, _visibility, _scope, _binding,
# _returns, _args, _doc, plus what the generators derive from it:
#   _scope_kind     host | host-v2 | handle | handle-or-active | alias | module | legacy | runtime
#   _scope_arg      the text after ':' in the scope (a pm_ name or an impl name)
#   _return_type    _returns without a failure value
#   _return_failure the value after '=' in _returns ("" for the type's default)
#   _legacy         the compat / plain export name ("" for host-v2)
#   _v2             the pm_<name>(host, ...) export ("" if the entry has none)
#   _impl           the WasmApi:: function implementing it ("" for runtime)
#   _impl_args      the impl's arguments after the WasmHost& (the manifest
#                   args minus the pmHandle of a handle entry)
#   _host_symbol    what a host-bound JS view calls instead of _legacy ("" if
#                   the legacy export is not host-scoped)
#   _host_mode      prepend (insert the host first) | first (the first arg is
#                   already a host handle; 0 means the view's host) | ""
# -----------------------------------------------------------------------------
function(projectm_wasm_api_parse entry prefix)
    if(NOT entry MATCHES "^([^|]*)\\|([^|]*)\\|([^|]*)\\|([^|]*)\\|([^|]*)\\|([^|]*)\\|(.*)$")
        message(FATAL_ERROR "Invalid WASM API manifest entry: ${entry}")
    endif()
    set(_name "${CMAKE_MATCH_1}")
    set(_scope "${CMAKE_MATCH_3}")
    set(_returns "${CMAKE_MATCH_5}")
    set(_args "${CMAKE_MATCH_6}")
    set(${prefix}_name "${_name}" PARENT_SCOPE)
    set(${prefix}_visibility "${CMAKE_MATCH_2}" PARENT_SCOPE)
    set(${prefix}_scope "${_scope}" PARENT_SCOPE)
    set(${prefix}_binding "${CMAKE_MATCH_4}" PARENT_SCOPE)
    set(${prefix}_returns "${_returns}" PARENT_SCOPE)
    set(${prefix}_args "${_args}" PARENT_SCOPE)
    set(${prefix}_doc "${CMAKE_MATCH_7}" PARENT_SCOPE)

    set(_kind "${_scope}")
    set(_arg "")
    if(_scope MATCHES "^([^:]+):(.+)$")
        set(_kind "${CMAKE_MATCH_1}")
        set(_arg "${CMAKE_MATCH_2}")
    endif()
    set(_return_type "${_returns}")
    set(_return_failure "")
    if(_returns MATCHES "^([^=]+)=(.+)$")
        set(_return_type "${CMAKE_MATCH_1}")
        set(_return_failure "${CMAKE_MATCH_2}")
    endif()

    set(_legacy "${_name}")
    set(_v2 "")
    set(_impl "${_name}")
    set(_impl_args "${_args}")
    set(_host_symbol "")
    set(_host_mode "")
    if(_kind STREQUAL "runtime")
        set(_impl "")
    elseif(_kind STREQUAL "host")
        set(_v2 "pm_${_name}")
        set(_host_symbol "${_v2}")
        set(_host_mode "prepend")
    elseif(_kind STREQUAL "host-v2")
        set(_legacy "")
        set(_v2 "pm_${_name}")
    elseif(_kind STREQUAL "handle" OR _kind STREQUAL "handle-or-active")
        if(NOT _arg MATCHES "^pm_(.+)$")
            message(FATAL_ERROR "WASM API manifest: ${_name}: ${_kind} needs a pm_ export name")
        endif()
        set(_impl "${CMAKE_MATCH_1}")
        set(_v2 "${_arg}")
        set(_host_symbol "${_v2}")
        set(_host_mode "first")
        string(FIND "${_args}" "," _comma)
        if(_comma LESS 0)
            set(_impl_args "")
        else()
            math(EXPR _comma "${_comma} + 1")
            string(SUBSTRING "${_args}" ${_comma} -1 _impl_args)
        endif()
    elseif(_kind STREQUAL "alias")
        set(_impl "${_arg}")
        set(_host_symbol "pm_${_arg}")
        set(_host_mode "prepend")
    elseif(_kind STREQUAL "legacy")
        if(NOT _arg STREQUAL "")
            set(_host_symbol "pm_${_arg}")
            set(_host_mode "prepend")
        endif()
    elseif(NOT _kind STREQUAL "module")
        message(FATAL_ERROR "WASM API manifest: ${_name}: unknown scope '${_scope}'")
    endif()
    foreach(_out IN ITEMS kind arg return_type return_failure legacy v2 impl impl_args host_symbol host_mode)
        set(${prefix}_${_out} "${_${_out}}" PARENT_SCOPE)
    endforeach()
    set(${prefix}_scope_kind "${_kind}" PARENT_SCOPE)
    set(${prefix}_scope_arg "${_arg}" PARENT_SCOPE)
endfunction()

# The link's EXPORTED_FUNCTIONS: every compat / plain export in manifest order,
# then every pm_ export. Nothing else may add to it.
set(PROJECTM_WASM_WRAPPER_EXPORTED_FUNCTIONS _main)
set(_projectm_wasm_v2_exports "")
foreach(_projectm_wasm_entry IN LISTS PROJECTM_WASM_API_MANIFEST)
    projectm_wasm_api_parse("${_projectm_wasm_entry}" _projectm_wasm_api)
    if(NOT _projectm_wasm_api_legacy STREQUAL "")
        list(APPEND PROJECTM_WASM_WRAPPER_EXPORTED_FUNCTIONS "_${_projectm_wasm_api_legacy}")
    endif()
    if(NOT _projectm_wasm_api_v2 STREQUAL "")
        list(APPEND _projectm_wasm_v2_exports "_${_projectm_wasm_api_v2}")
    endif()
endforeach()
list(APPEND PROJECTM_WASM_WRAPPER_EXPORTED_FUNCTIONS ${_projectm_wasm_v2_exports})
list(REMOVE_DUPLICATES PROJECTM_WASM_WRAPPER_EXPORTED_FUNCTIONS)
