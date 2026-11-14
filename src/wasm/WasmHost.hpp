// WasmHost.hpp
//
// Per-instance host state for the projectM Emscripten/WASM wrapper (#168 Phase B).
//
// Historically every export operated on a cluster of process-global variables
// (pm / app_data / playlist, the dual-FBO manager, the transition timeline, the
// quality governor, the audio-source flag, the WebGL context and the canvas
// selectors). That made two visualizers in one Module impossible: a second
// engine would silently share the first one's GL context and transition state.
//
// WasmHost gathers all of that per-instance state into a single heap-allocated
// struct, kept in a small registry (capped at kMaxHosts). Every engine export
// is a pm_<name>(host, ...) that names its host (ABI v2, #352): the generated
// barrier (WasmApiBarrier.hpp) resolves the handle and hands the
// implementation its WasmHost&. Implementations reach no other host.
//
// The "active" host survives only for the compat shims (the pre-v2 export
// names, which act on whichever host set_active_host() selected) and for
// legacy single-engine pages, which get a lazily-created compat *default* host
// (slot 0) that pm_ exports address as handle 0.
//
// See docs/EMSCRIPTEN.md ("Multi-instance host state") and docs/WASM_JS_API.md
// ("ABI v2").
#pragma once

#include "ProjectMWasmInternal.hpp"
#include "WasmGraphics.hpp"
#include "WasmPresetPrepare.hpp"
#include "WasmWebGLContext.hpp"
#include "generated/WasmApiImpl.hpp"

#include <map>
#include <memory>
#include <optional>
#include <utility>

// Maximum simultaneous engines in one Module: PROJECTM_WASM_MAX_HOSTS in
// cmake/EmscriptenWasmFlags.cmake, which also sizes the pthread pool (one
// preset prepare thread per host). Each host owns an engine, a dual-FBO pair,
// a PCM ring and a WebGL context, so the real bound is VRAM and the browser's
// live-context limit, not the heap. The one AudioWorklet fans every quantum out
// to each host's ring. A create_host() past the cap fails with a typed error
// rather than silently sharing GL state.
constexpr int kMaxHosts = kWasmMaxHosts;

// =============================================================================
// PcmRingState – one host's WASM-owned PCM ring (#246). Layout and threading
// contract are documented in WasmPcmRing.cpp.
// =============================================================================
struct PcmRingState {
    int32_t* header = nullptr;
    float* data = nullptr;
    int capacityFrames = 0;
    int readIndex = 0;
    int indexModulus = 0;
    // Reused across drains so the per-frame ingest does not allocate.
    std::vector<float> drainScratch;
};

// =============================================================================
// ShaderCacheLoadState – one host's in-flight transpiled-GLSL cache load
// (#246). See WasmShaderCache.cpp.
// =============================================================================
struct ShaderCacheLoadState {
    std::string key;                     //!< Host-supplied key ("" = not loading).
    std::string namespacedKey;           //!< key prefixed with the host handle.
    std::optional<std::string> warpGlsl; //!< Imported cached warp shader.
    std::optional<std::string> compGlsl; //!< Imported cached composite shader.
};

// =============================================================================
// EngineSettings – page-applied engine settings that must survive the engine
// being re-created. Unset fields keep init()'s defaults.
// =============================================================================
struct EngineSettings {
    std::optional<std::pair<size_t, size_t>> meshSize; //!< set_mesh(), or the governor's tier.
    std::optional<bool> aspectCorrection;
    std::optional<bool> presetLocked;
    std::optional<bool> transparencyMode;
    std::optional<float> transparencyThreshold;
    std::optional<float> rhythmHint;                            //!< set_rhythm_hint().
    std::optional<std::pair<int, uint32_t>> presetSwitchPolicy; //!< set_preset_switch_policy().
    std::optional<float> transitionBeats;                       //!< transition_set_duration_beats().
    std::optional<bool> hardCutOnBeat;                          //!< set_hard_cut_on_beat().
    std::optional<double> rhythmLatencyMs;                      //!< set_rhythm_latency_ms().
    std::optional<uint32_t> presetSwitchPhrase;                 //!< set_preset_switch_phrase().
    std::optional<bool> sectionHardCut;                         //!< set_section_hard_cut().
    std::optional<bool> flashLimitEnabled;                      //!< set_flash_limit_enabled().
    std::optional<float> flashLimitThreshold;                   //!< set_flash_limit_threshold().
};

// =============================================================================
// LiveTextureSlot – one live texture the page feeds (WasmLiveInput.cpp).
//
// The page writes a frame straight into `staging` on the WASM heap
// (texture_slot_buffer()) and commits it; render_frame() uploads it. The staging
// copy belongs to the host, not the engine, so a context-loss restore re-uploads
// the last frame instead of starting black.
// =============================================================================
struct LiveTextureSlot {
    int width = 0;
    int height = 0;
    std::vector<uint8_t> staging; //!< width * height RGBA8, top row first.
    bool dirty = false;           //!< Committed since the last upload.
    //! Changes with every (re)allocation of `staging`: what texture_slot_commit_generation()
    //! compares, so a frame written into a replaced buffer is never committed.
    uint32_t generation = 0;
};

// =============================================================================
// FrameCaptureState – one host's capture_frame_*() readback (WasmPresent.cpp).
//
// A capture is requested for the next frame and taken inside that frame's
// render_frame(), after the compositor drew the canvas and before a manual-
// present commit: the only point where the image is known to be in the drawing
// buffer without preserveDrawingBuffer. Per host, so two canvases never share
// a staging allocation.
// =============================================================================
enum class FrameCaptureStatus : int
{
    Idle = 0,      //!< Nothing requested, or the last result was released.
    Requested = 1, //!< Will be taken from the next rendered frame.
    Pending = 2,   //!< Read into the pixel-pack buffer; waiting on its fence.
    Ready = 3,     //!< `pixels` holds the frame.
    Failed = 4,    //!< The frame could not be read (no context, zero size).
};

struct FrameCaptureState {
    FrameCaptureStatus status = FrameCaptureStatus::Idle;
    std::vector<uint8_t> pixels; //!< Tightly packed RGBA8, top row first.
    int width = 0;
    int height = 0;
    uint32_t frameIndex = 0; //!< renderedFrameCount of the captured frame.
    // Manual-present hosts only: the asynchronous read. The live (browser
    // present) path never allocates these.
    libprojectM::Renderer::Device::BufferHandle pixelPackBuffer;
    size_t pixelPackBufferBytes = 0;
    libprojectM::Renderer::Device::FenceHandle fence;
};

// =============================================================================
// WasmHost – ownership record for one projectM engine instance.
//
// Field groups mirror the former global clusters so the per-function reference
// aliases in each TU read the same as the old code (e.g. `auto& pm =
// H.appData.projectm_engine;`).
// =============================================================================
struct WasmHost {
    // ---- Core engine (was pm / app_data / playlist) ----
    AppData appData{}; // { projectm_engine, playlist, loading }

    // ---- Async preset loading / transition gating ----
    bool presetBReady = false;
    uint32_t renderedFrameCount = 0;
    uint32_t presetReadyFrame = 0;
    bool presetSwitchFailed = false;

    // ---- Background preset preparation (WasmPresetPrepare.cpp) ----
    // Created by init(); lives as long as the host, across context loss.
    std::unique_ptr<PresetPrepareQueue> presetPrepare;
    // The engine asked for a timer-driven switch while a load was in flight and
    // was told to wait; replayed if that load fails.
    bool switchRequestDeferred = false;
    bool deferredSwitchHardCut = false;
    // A prepared preset the engine has accepted and is linking in the background.
    std::optional<PendingPresetSwitch> pendingSwitch;
    // A timer is armed to poll pendingSwitch without waiting for a frame.
    bool linkPollScheduled = false;

    // ---- Transition controller (Phase 5) ----
    float transitionDuration = 3.0f;
    // Crossfade length in beats (transition_set_duration_beats()), 0 = use seconds.
    float transitionBeats = 0.0f;
    // The duration the running crossfade resolved to when transition_start() armed it.
    float activeTransitionDuration = 3.0f;
    bool transitionActive = false;
    float transitionBlend = 0.0f;
    double transitionStartTime = 0.0;
    double transitionEndTime = 0.0;
    float dualFboIdleReleaseSec = 5.0f;

    // ---- Engine settings the page applied (re-applied by init()) ----
    // Engine state is lost whenever the engine is re-created (context loss,
    // rebind_canvases()), so init() puts back whatever the page had set on
    // the previous engine rather than silently reverting to the defaults.
    EngineSettings engineSettings;

    // ---- Deterministic clock (WasmDeterminism.cpp) ----
    // Per host: the shared main loop ticks every started host once per frame,
    // so a process-wide index advanced once per host per tick.
    uint32_t deterministicFrameIndex = 0;
    double virtualNowMs = 0.0;

    // ---- Present pass (WasmPresent.cpp) ----
    FrameCaptureState capture;
    // emscripten_webgl_commit_frame() calls on an explicitSwapControl host.
    uint32_t committedFrameCount = 0;
    // get_flash_limit_clamped_frames() reads the count back from the GPU, so the
    // perf HUD refreshes this copy at most every kFlashCountRefreshMs.
    uint32_t flashClampedFrames = 0;
    double flashClampedFramesReadMs = -1.0;

    // ---- Musical-time events (WasmRhythm.cpp) ----
    // set_rhythm_events(): report beats/bars/sections to globalThis.pmOnRhythmEvent.
    bool rhythmEventsEnabled = false;
    // Events seen during the current render_frame() (it may render the engine twice
    // during a crossfade; only the first render of a tick carries the events).
    int pendingRhythmEvents = 0;

    // ---- Perf HUD / adaptive quality governor ----
    bool perfHudEnabled = false;
    int postLoadGraceFrames = 0;
    bool governorEnabled = true;
    int targetFps = 60;
    int qualityTier = 0;
    bool qualityTierInitialized = false;
    int overBudgetFrames = 0;
    int underBudgetFrames = 0;

    // ---- WebGL context + graphics (was g_glCtx / g_dualFbo / g_compositorShader) ----
    EMSCRIPTEN_WEBGL_CONTEXT_HANDLE glCtx = 0;
    DualPingPongFramebuffer dualFbo;
    CompositingBlendShader compositorShader;
    // GL state the host established for this context (start_render() captures
    // it, set_window_size() keeps viewport/scissor current); what
    // RenderStateGuard restores after each preset render. Cleared with the
    // graphics resources.
    std::optional<RenderDevice::StateSnapshot> glBaseline;

    // ---- WebGL context attributes + dual-FBO precision (#246) ----
    // Baked into glCtx at create time; never rewritten while glCtx is live.
    // create_host_with_config() sets it before the context exists.
    WasmContextConfig contextConfig;
    // What glCtx offered when it was created; reset with it.
    WasmContextCaps contextCaps;
    // Legacy set_context_config() hand-off only (bundles' host JS from before
    // create_host_with_config()): a config set while this host already had a
    // context, held for whichever context is created next — a create_host()
    // issued while this host is active, or this host's own re-creation.
    WasmContextConfig legacyPendingContextConfig;
    bool hasLegacyPendingContextConfig = false;

    // ---- Audio ingest (#246) ----
    PcmRingState pcmRing;

    // ---- Live input (WasmLiveInput.cpp) ----
    // Live textures by lower-case name, and the host variables (eval_set()) the
    // engine applies every frame. Both outlive the engine, like EngineSettings.
    std::map<std::string, LiveTextureSlot> liveTextures;
    //! Next LiveTextureSlot::generation; per host, so a slot removed and
    //! registered again never repeats one.
    uint32_t nextBufferGeneration = 1;
    std::map<std::string, double> hostVariables;

    // ---- Transpiled-GLSL cache load (#246) ----
    ShaderCacheLoadState shaderCache;

    // ---- Canvas CSS selectors (Phase A, now per-host) ----
    char primarySelector[kCanvasSelectorMax] = "#mcanvas";
    char secondarySelector[kCanvasSelectorMax] = "#scanvas";
    bool canvasSelectorsExplicit = false;

    // Allocated lazily by Host() for a legacy no-handle export rather than by
    // create_host(). While it has no engine and no context, the next
    // create_host() adopts it instead of taking another slot.
    bool implicitDefault = false;

    // This host's opaque handle (HostHandle()): slot index + 1 in the low byte,
    // the slot's generation above it. Assigned by AllocateHost(); never 0.
    uintptr_t handle = 0;

    // Whether start_render() has run for this host (so the shared Emscripten
    // main loop renders it). The loop itself is process-global; each host opts
    // in individually.
    bool renderLoopStarted = false;

    // ---- Last error an export reported on this host (WasmApiBarrier.hpp) ----
    // pm_get_last_error() / pm_get_last_error_message(); kept until
    // pm_clear_last_error() or the next error.
    int lastErrorCode = 0;
    std::string lastErrorMessage;
};

// Process-global Emscripten main-loop registration flag. The loop services
// every started host; start_render() registers it once. This is the one
// documented process-global left in the host layer (see
// scripts/check_wasm_host_globals.sh).
extern bool g_mainLoopRegistered;

// ---- Active-host accessor (compat shims only) ---------------------------------
// Host() returns the active host, lazily creating the compat default (slot 0)
// so it is never null; it throws std::bad_alloc when even that fails. Only the
// registry (WasmHost.cpp) and the compat-only exports (WasmLegacyExports.cpp)
// call it; scripts/check_wasm_host_globals.sh fails anything else that does.
WasmHost& Host();

// The handle of Host(), for a compat name forwarding to its pm_ export
// (generated/WasmApiExports.cpp). Never throws: when the default host cannot be
// allocated it records the error and returns a handle that names no host, so
// the pm_ export returns its failure value.
uintptr_t ActiveHostHandle() noexcept;

// Switches the active host (set_active_host()) and binds it (BindHost(): its
// WebGL context current). Passing nullptr falls back to the default host.
void SetActiveHost(WasmHost* host);

// The host `handle` names: create_host*()'s handle while it is live, or for 0
// the implicit default host a legacy init() brought up. nullptr otherwise.
// Never creates a host.
WasmHost* ResolveHost(uintptr_t handle);

// Makes `host` the host the next GL calls are for: its WebGL context current
// and libprojectM's shader-cache key on its in-flight load. Does not change
// which host is active.
void BindHost(WasmHost& host);

// Allocates a new host (up to kMaxHosts) and returns it, or nullptr at the cap.
// Does NOT init the engine or make it active; callers (create_host export) do.
WasmHost* AllocateHost();

// Tears down and frees a host: destroys its engine/playlist/GL context under
// its own context, removes it from the registry, and re-points the active host
// at a surviving host (or the default).
void ReleaseHost(WasmHost* host);

// Registry iteration for the shared render loop.
int HostSlotCount();           //!< kMaxHosts (fixed-size slot array).
WasmHost* HostSlot(int index); //!< Live host in slot, or nullptr.
int LiveHostCount();           //!< Number of currently-allocated hosts.

// The active host without lazily creating the default (nullptr if none).
WasmHost* ActiveHostOrNull();

// The implicit default host (handle 0 of a pm_ export), or nullptr.
WasmHost* ImplicitDefaultHost();

// Opaque handle for a host (the value create_host() returns / JS tags ring
// descriptors with), and the registry-checked reverse lookup (nullptr for a
// stale or unknown handle). A handle is (slot index + 1) | generation << 8, not
// an address: a slot's generation advances every time it is freed, so a handle
// to a destroyed host never names the host that reuses its slot or its memory.
uintptr_t HostHandle(const WasmHost& host);
WasmHost* HostFromHandle(uintptr_t handle);

// The handle a page callback (pmOnGovernor*, pmOnPerfFrame, pmReportInitError,
// pmOnRhythmEvent, ...) carries to say which engine it came from: the handle
// create_host*() returned, or 0 for the legacy default host that init() brought
// up without one — the same 0 a single-engine ProjectMContext holds. A double
// because EM_JS hands a uintptr_t to JavaScript as a signed i32.
double EventHostHandle(const WasmHost& host);

// The event handle for a failure that happened before any engine existed (a
// create_host*() refused at the kMaxHosts cap). No context's handle is -1, so
// a host-filtered listener never takes it for its own.
constexpr double kNoEventHost = -1.0;

// The live engine `engineHandle` names (what get_projectm_handle() hands to JS:
// its host's handle), or nullptr if that host is gone or has no engine. JS
// passes such integers back into the PCM and sprite exports; this is the check
// that keeps a stale or made-up one from being dereferenced as an engine.
projectm_handle EngineFromHandle(uintptr_t engineHandle);

// Points libprojectM's process-wide transpiled-GLSL cache key at `host`'s
// in-flight load (or clears it). BindHost() calls this so the key always
// belongs to the host being driven. Defined in WasmShaderCache.cpp.
void ArmShaderCacheKeyForHost(const WasmHost& host);
