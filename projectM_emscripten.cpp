// projectM_emscripten.cpp  (ProjectMWasmMain)
//
// Init orchestration and AppData ownership for the projectM Emscripten/WASM
// host. Owns the process-global engine state, the WebGL context + extension
// setup, the transpiled-GLSL shader cache hooks, the render loop, and the
// engine-lifecycle / render C exports.
//
// The rest of the host glue lives in the focused WASM TUs:
//   WasmGraphics.hpp      dual-FBO classes + compositing shader
//   WasmDualFbo.cpp       dual_fbo_* / transition_* exports
//   WasmAudioBridge.cpp   audio worklet + stream analyser + PCM feed
//   WasmPerfGovernor.cpp  perf HUD + adaptive quality governor + OpenMP info
//   WasmPlaylistBridge.cpp preset callbacks + playlist path helpers
//   WasmJsBindings.cpp    EM_JS DOM/VFS bootstrap + host-page notifications
//
// See docs/EMSCRIPTEN.md ("Where to add a WASM export").
#include "ProjectMWasmInternal.hpp"
#include "WasmGraphics.hpp"

using namespace emscripten;

// ---- Core engine state (declared extern in ProjectMWasmInternal.hpp) -------
projectm_handle pm;
AppData app_data;
projectm_playlist_handle playlist={};

// ---- Async preset loading / transition gating (declared extern in header) --
bool g_presetBReady = false;
uint32_t g_renderedFrameCount = 0;
uint32_t g_presetReadyFrame = 0;
bool g_presetSwitchFailed = false;

// kWasmPthreadPoolSize comes from cmake/generated/ProjectMWasmBuildConfig.hpp
// (generated from PROJECTM_WASM_PTHREAD_POOL_SIZE in EmscriptenWasmFlags.cmake).
static void ConfigureWasmOpenMPThreadCount()
{
#ifdef _OPENMP
    omp_set_dynamic(0);
    omp_set_num_threads(kWasmPthreadPoolSize);
#endif
}

EMSCRIPTEN_WEBGL_CONTEXT_HANDLE gl_ctx = 0;

// ---- Canvas CSS selectors (Phase A of #168) ---------------------------------
// Defaults preserve the historical `#mcanvas` / `#scanvas` contract. Hosts may
// override via Module.primaryCanvasSelector / Module.secondaryCanvasSelector
// (read at init), set_canvas_selectors(), init_with_canvases(), or
// rebind_canvases(). True multi-instance (two engines in one Module) is not
// supported; see docs/EMSCRIPTEN.md § Configurable canvas selectors.
static constexpr size_t kCanvasSelectorMax = 256;
static char g_mainCanvasSelector[kCanvasSelectorMax] = "#mcanvas";
static char g_secondaryCanvasSelector[kCanvasSelectorMax] = "#scanvas";
static bool g_canvasSelectorsExplicit = false;

static void CopyCanvasSelector(char* dest, size_t destSize, const char* src, const char* fallback)
{
    const char* value = (src != nullptr && src[0] != '\0') ? src : fallback;
    std::snprintf(dest, destSize, "%s", value);
}

static void ApplyModuleCanvasSelectorsIfPresent()
{
    if (g_canvasSelectorsExplicit)
    {
        return;
    }

    // Pull optional Module factory config into the C selector buffers before
    // creating the WebGL context. Empty / missing properties keep defaults.
    EM_ASM({
        function copySel(key, fallback, ptr, len) {
            var sel = fallback;
            try {
                if (typeof Module !== 'undefined' && Module[key]) {
                    sel = String(Module[key]);
                }
            } catch (e) {}
            if (!sel) {
                sel = fallback;
            }
            stringToUTF8(sel, ptr, len);
        }
        copySel('primaryCanvasSelector', '#mcanvas', $0, $1);
        copySel('secondaryCanvasSelector', '#scanvas', $2, $3);
    },
           g_mainCanvasSelector,
           static_cast<int>(sizeof(g_mainCanvasSelector)),
           g_secondaryCanvasSelector,
           static_cast<int>(sizeof(g_secondaryCanvasSelector)));
}

static bool CanvasElementExists(const char* selector)
{
    if (selector == nullptr || selector[0] == '\0')
    {
        return false;
    }
    return EM_ASM_INT({
               try {
                   return document.querySelector(UTF8ToString($0)) ? 1 : 0;
               } catch (e) {
                   return 0;
               }
           },
                      selector) != 0;
}

static void TearDownEngineForRebind()
{
    // Cancel the Emscripten main loop if one is running so rebind can restart it
    // via start_render() after a fresh init().
    emscripten_cancel_main_loop();

    if (playlist)
    {
        projectm_playlist_destroy(playlist);
        playlist = nullptr;
    }
    if (pm)
    {
        projectm_destroy(pm);
        pm = nullptr;
    }
    app_data.projectm_engine = nullptr;
    app_data.playlist = nullptr;
    app_data.loading = EM_FALSE;

    g_dualFbo.ReleaseAll();
    if (gl_ctx)
    {
        emscripten_webgl_destroy_context(gl_ctx);
        gl_ctx = 0;
    }
}

/**
 * @brief Minimal WebGL 2 context attributes for projectM.
 *
 * Documented in docs/EMSCRIPTEN.md § WebGL context attributes. We intentionally
 * avoid exotic EGL-style config lists — Emscripten's html5 WebGL API is the
 * only supported path on wasm; browser presentation does not use eglSwapBuffers.
 */
static EmscriptenWebGLContextAttributes ProjectMDefaultWebGLAttributes()
{
    EmscriptenWebGLContextAttributes attrs;
    emscripten_webgl_init_context_attributes(&attrs);
    attrs.majorVersion = 2;
    attrs.minorVersion = 0;
    attrs.alpha = EM_TRUE;
    attrs.depth = EM_TRUE;
    attrs.stencil = EM_TRUE;
    attrs.antialias = EM_TRUE;
    attrs.premultipliedAlpha = EM_TRUE;
    attrs.preserveDrawingBuffer = EM_ASM_INT({
        try {
            var params = new URLSearchParams(window.location.search || '');
            return (window.__projectMCaptureMode === true || params.get('capture') === '1' || params.get('capture') === 'true') ? 1 : 0;
        } catch (e) {
            return window.__projectMCaptureMode === true ? 1 : 0;
        }
    }) ? EM_TRUE : EM_FALSE;
    attrs.enableExtensionsByDefault = EM_TRUE;
    attrs.powerPreference = EM_WEBGL_POWER_PREFERENCE_HIGH_PERFORMANCE;
    return attrs;
}

static bool ProjectMEnableRequiredWebGLExtensions(EMSCRIPTEN_WEBGL_CONTEXT_HANDLE ctx)
{
    emscripten_webgl_enable_extension(ctx, "OES_texture_float");
    emscripten_webgl_enable_extension(ctx, "OES_texture_half_float");
    emscripten_webgl_enable_extension(ctx, "OES_texture_half_float_linear");
    if (emscripten_webgl_enable_extension(ctx, "EXT_color_buffer_float") != EM_TRUE)
    {
        fprintf(stderr, "Warning: EXT_color_buffer_float not supported; float FBO rendering will not be available\n");
    }
    if (emscripten_webgl_enable_extension(ctx, "EXT_float_blend") != EM_TRUE)
    {
        fprintf(stderr, "Warning: EXT_float_blend not supported; float blending will not be available\n");
    }
    return true;
}

// =============================================================================
// Transpiled GLSL cache (browser IndexedDB via JS hooks)
// =============================================================================

static std::string g_shaderCacheKey;
static std::optional<std::string> g_importedWarpGlsl;
static std::optional<std::string> g_importedCompGlsl;

EM_JS(void, js_on_transpiled_shader_stored, (const char* key, int kind, const char* glsl), {
    if (typeof window.pmOnTranspiledShaderStored === 'function') {
        window.pmOnTranspiledShaderStored(UTF8ToString(key), kind, UTF8ToString(glsl));
    }
});

static void InstallShaderTranspileCacheHooks()
{
    libprojectM::Renderer::SetTranspiledGlslCacheCallbacks(
        [](const std::string& key, int shaderType) -> std::optional<std::string> {
            if (key != g_shaderCacheKey)
            {
                return std::nullopt;
            }
            if (shaderType == 0 && g_importedWarpGlsl)
            {
                return g_importedWarpGlsl;
            }
            if (shaderType == 1 && g_importedCompGlsl)
            {
                return g_importedCompGlsl;
            }
            return std::nullopt;
        },
        [](const std::string& key, int shaderType, const std::string& glsl) {
            js_on_transpiled_shader_stored(key.c_str(), shaderType, glsl.c_str());
        });
}

extern "C" {
EMSCRIPTEN_KEEPALIVE
void shader_cache_begin_load(const char* key)
{
    g_shaderCacheKey = key ? key : "";
    g_importedWarpGlsl.reset();
    g_importedCompGlsl.reset();
    libprojectM::Renderer::SetTranspiledGlslCacheKey(g_shaderCacheKey);
}

EMSCRIPTEN_KEEPALIVE
void shader_cache_import_glsl(int shaderType, const char* glsl)
{
    if (!glsl)
    {
        return;
    }
    if (shaderType == 0)
    {
        g_importedWarpGlsl = glsl;
    }
    else if (shaderType == 1)
    {
        g_importedCompGlsl = glsl;
    }
}

EMSCRIPTEN_KEEPALIVE
void shader_cache_end_load()
{
    libprojectM::Renderer::ClearTranspiledGlslCacheKey();
    g_shaderCacheKey.clear();
    g_importedWarpGlsl.reset();
    g_importedCompGlsl.reset();
}

EMSCRIPTEN_KEEPALIVE
int get_glsl_generator_version()
{
    return static_cast<int>(
        libprojectM::MilkdropPreset::MilkdropStaticShaders::Get()->GetGlslGeneratorVersion());
}
} // extern "C"

extern "C" {
EMSCRIPTEN_KEEPALIVE
void create_sprite() {
const char* new_sprite_code =
        "[preset01]"
        "img='textures/rv_IP_20250421_060250.png';"
        "per_frame_1=blendmode=1;"
        "per_frame_2=x = 0.5;"         // Center X
        "per_frame_3=y = 0.5;"         // Center Y
        "per_frame_4=z = 0.0;"         // Center Y
        "per_frame_5=scaling = 1.0;"   // Make it huge (twice the screen height)
        "per_pixel_2=a = 1;"         // Fully opaque
        "per_pixel_3=r = 1.0;"         // Bright Red
        "per_pixel_4=g = 0.0;"
        "per_pixel_5=b = 1.0;";
        
projectm_sprite_create(app_data.projectm_engine, "milkdrop", new_sprite_code);
return;
}

EMSCRIPTEN_KEEPALIVE
uintptr_t get_projectm_handle() { 
return reinterpret_cast<uintptr_t>(app_data.projectm_engine);
}
} // extern "C"

// Forward declaration: render_frame() is defined later in this file (Phase 5
// dual-FBO compositor pipeline), but renderLoop() — registered as the
// Emscripten main loop by start_render() — must call it every frame.
extern "C" void render_frame();

void renderLoop(){
if(app_data.loading==EM_TRUE){
g_wasLoading = true;
return;
}
if (g_wasLoading) {
    g_wasLoading = false;
    g_postLoadGraceFrames = kPostLoadGraceFrames;
    ResetGovernorCounters();
}
const double frameStartMs = emscripten_get_now();
if (g_is_streaming_audio) {
js_feed_stream_data_to_projectm(
reinterpret_cast<uintptr_t>(app_data.projectm_engine),


            2048 // This MUST match the analyser.fftSize


);
}
// Phase 5: Route through render_frame(). Steady-state frames render directly
// to the canvas; the dual-FBO compositor runs only during preset crossfades.
if (g_perfHudEnabled) {
    js_perf_gpu_begin_frame();
}
render_frame();
if (g_perfHudEnabled) {
    js_perf_gpu_end_frame();
}
// The compositor (and the legacy fallback) both leave the composited frame
// in the default framebuffer (FBO 0). The browser presents the canvas directly;
// no eglSwapBuffers() is required on wasm.
if (g_perfHudEnabled) {
    projectm_perf_frame_timings timings;
    projectm_perf_get_frame_timings(&timings);
    js_perf_report_frame(
        timings.total_ms, timings.audio_analysis_ms, timings.per_frame_eval_ms,
        timings.per_pixel_eval_ms, timings.blur_ms, timings.waveforms_shapes_ms,
        timings.composite_ms, js_perf_gpu_get_last_ms(), timings.fps);
}
UpdateQualityGovernor(emscripten_get_now() - frameStartMs);
return;
}

extern "C" {
EMSCRIPTEN_KEEPALIVE
void start_render(int width, int height){
// glClearColor( 1.0, 1.0, 1.0, 0.0 );
glClear(GL_COLOR_BUFFER_BIT|GL_DEPTH_BUFFER_BIT|GL_STENCIL_BUFFER_BIT);
printf("Setting window size: %i x %i\n", width, height);
glViewport(0,0,8192,8192);  //  viewport/scissor after UsePrg runs at full resolution
glViewport(0,0,width,height);  //  viewport/scissor after UsePrg runs at full resolution
glEnable(GL_SCISSOR_TEST);
glScissor(0,0,width,height);
glHint(GL_FRAGMENT_SHADER_DERIVATIVE_HINT,GL_NICEST);
glHint(GL_GENERATE_MIPMAP_HINT,GL_NICEST);
// GL_DITHER only affects fixed-function/blit paths on most GLES drivers and
// is a no-op for the shader-based render passes used here, but in the
// degraded RGBA8 dual-FBO fallback (DetectFormat() already ran in init())
// every bit of extra entropy on the final blit helps hide 8-bit banding, so
// leave it enabled in that case instead of unconditionally disabling it.
if(g_dualFbo.GetFormat()==FboFloatFormat::RGBA8){glEnable(GL_DITHER);}else{glDisable(GL_DITHER);}
glFrontFace(GL_CW);
glCullFace(GL_BACK);
app_data.loading=EM_FALSE;
projectm_set_window_size(pm,width,height);
// Phase 2: Allocate Preset A ping-pong FBOs now that the viewport
// dimensions are known. DetectFormat() was already called in init().
g_dualFbo.AllocatePresetA(width, height);
// Phase 5: Compile and link the compositing blend shader now that the GL
// context is current and Preset A's FBOs are allocated.
if (!g_compositorShader.Init())
{
    fprintf(stderr, "start_render: CompositingBlendShader failed to initialise – transitions will be unavailable.\n");
}
emscripten_set_main_loop((void (*)())renderLoop,0,0);


emscripten_set_main_loop_timing(2,1);


return;
}
} // extern "C"

extern "C" {
EMSCRIPTEN_KEEPALIVE int init();

EMSCRIPTEN_KEEPALIVE
void set_canvas_selectors(const char* primary, const char* secondary)
{
    if (primary != nullptr && primary[0] != '\0')
    {
        CopyCanvasSelector(g_mainCanvasSelector, sizeof(g_mainCanvasSelector), primary, "#mcanvas");
        g_canvasSelectorsExplicit = true;
    }
    if (secondary != nullptr && secondary[0] != '\0')
    {
        CopyCanvasSelector(g_secondaryCanvasSelector, sizeof(g_secondaryCanvasSelector), secondary, "#scanvas");
        g_canvasSelectorsExplicit = true;
    }
}

EMSCRIPTEN_KEEPALIVE
int init_with_canvases(const char* primary, const char* secondary)
{
    set_canvas_selectors(primary, secondary);
    return init();
}

EMSCRIPTEN_KEEPALIVE
int rebind_canvases(const char* primary, const char* secondary)
{
    // Single-instance rebind: tear down the active engine/GL context and re-init
    // against new canvas selectors. Does not support two simultaneous engines in
    // one Module (INITIAL_MEMORY ≈ 1 GiB per Module instance).
    set_canvas_selectors(primary, secondary);
    if (pm || gl_ctx)
    {
        TearDownEngineForRebind();
    }
    return init();
}

EMSCRIPTEN_KEEPALIVE
int init() {
if (pm) {
js_report_init_success();
return 0;
}
ConfigureWasmOpenMPThreadCount();
ApplyModuleCanvasSelectorsIfPresent();
// Clean up any previously created WebGL resources from a failed prior init attempt
// so that calling init() again after a partial failure is safe.
if (gl_ctx) {
emscripten_webgl_destroy_context(gl_ctx);
gl_ctx = 0;
}
js_init_projectm_dom();
EmscriptenWebGLContextAttributes webgl_attrs = ProjectMDefaultWebGLAttributes();
if (!CanvasElementExists(g_mainCanvasSelector))
{
    fprintf(stderr, "Failed to find primary canvas selector: %s\n", g_mainCanvasSelector);
    js_report_init_error(2, "Primary canvas selector not found in document");
    return 2;
}
gl_ctx = emscripten_webgl_create_context(g_mainCanvasSelector, &webgl_attrs);
if (!gl_ctx) {
fprintf(stderr, "Failed to create WebGL context on %s\n", g_mainCanvasSelector);
js_report_init_error(2, "Failed to create WebGL 2 context");
return 2;
}
EMSCRIPTEN_RESULT em_res = emscripten_webgl_make_context_current(gl_ctx);
if (em_res != EMSCRIPTEN_RESULT_SUCCESS) {
fprintf(stderr, "Failed to activate the WebGL context for rendering\n");
js_report_init_error(2, "Failed to activate the WebGL context for rendering");
return 2;
}
glHint(GL_FRAGMENT_SHADER_DERIVATIVE_HINT,GL_NICEST);
glHint(GL_GENERATE_MIPMAP_HINT,GL_NICEST);
ProjectMEnableRequiredWebGLExtensions(gl_ctx);

// Phase 2: Detect the best available floating-point texture format for the
// dual ping-pong FBO system. DetectFormat() checks EXT_color_buffer_float
// (RGBA32F), EXT_color_buffer_half_float (RGBA16F), and falls back to RGBA8.
// This must be called after the WebGL context is made current so that
// extension availability can be probed reliably.
g_dualFbo.DetectFormat(gl_ctx);

pm = projectm_create();
if (!pm) {
fprintf(stderr, "Failed to create projectM handle\n");
js_report_init_error(3, "projectm_create() returned null");
return 3;
}
app_data.projectm_engine = pm;
playlist = projectm_playlist_create(pm);
app_data.playlist = playlist;
const char * loc="/presets/";
projectm_playlist_add_path(playlist,loc,true,true);
projectm_playlist_set_preset_switched_event_callback(playlist,&load_preset_callback_done,&app_data);
const char* texture_search_paths[] = {"textures"};
projectm_set_texture_search_paths(pm, texture_search_paths, 1);
projectm_set_fps(pm, 60);
projectm_set_preset_duration(pm, 30.0);
projectm_set_soft_cut_duration(pm, 17.0);
// projectm_set_hard_cut_duration(pm, 48.0);
// projectm_set_hard_cut_enabled(pm, true);
projectm_set_beat_sensitivity(pm, 1.50);
projectm_playlist_set_shuffle(playlist,true);
projectm_set_preset_switch_failed_event_callback(pm, &_on_preset_switch_failed, nullptr);
projectm_set_preset_switch_requested_event_callback(pm, &on_preset_switch_requested, &app_data);
InstallShaderTranspileCacheHooks();
// projectm_playlist_connect(app_data.playlist,app_data.projectm_engine);
printf("  --==  projectM initialized!  ==--\n");
js_initialize_worklet_system_once(reinterpret_cast<uintptr_t>(app_data.projectm_engine));
js_initialize_stream_analyser();
js_report_init_success();
return 0;
}
} // extern "C"

extern "C" {
EMSCRIPTEN_KEEPALIVE
void set_mesh(int w,int h){
projectm_set_mesh_size(pm,w,h);
return;
}

EMSCRIPTEN_KEEPALIVE
void destruct() {
if (pm) {
projectm_destroy(pm);
}
pm = NULL;
// Phase 2: Release dual FBO resources before destroying the WebGL context
// to avoid calling OpenGL functions with an invalid context.
g_dualFbo.ReleaseAll();
if (gl_ctx) emscripten_webgl_destroy_context(gl_ctx);
gl_ctx = NULL;
return;
}

// Called from the host page's "webglcontextlost" handler (see
// html/projectm-context-loss.js), before the browser's "webglcontextrestored"
// event fires. At this point the WebGL context is already gone, so every GL
// call below (inside projectm_destroy() and g_dualFbo.ReleaseAll()) is a
// no-op per the WebGL spec; they only exist to reset projectM's bookkeeping
// (pm, playlist, gl_ctx, dual-FBO allocation flags) so that a subsequent
// init() call takes the full re-initialization path instead of the
// "already initialized" early return.
EMSCRIPTEN_KEEPALIVE
void pm_handle_context_loss() {
if (pm) {
projectm_destroy(pm);
}
pm = NULL;
app_data.projectm_engine = NULL;
playlist = NULL;
app_data.playlist = NULL;
g_dualFbo.ReleaseAll();
if (gl_ctx) emscripten_webgl_destroy_context(gl_ctx);
gl_ctx = NULL;
return;
}

EMSCRIPTEN_KEEPALIVE
void set_aspect_correction(bool enabled) {
if (!pm) return;
projectm_set_aspect_correction(pm, enabled);
return;
}

EMSCRIPTEN_KEEPALIVE
void set_preset_locked(bool locked) {
if (!pm) return;
projectm_set_preset_locked(pm, locked);
printf("Preset lock set to: %s\n", locked ? "true" : "false");
return;
}

EMSCRIPTEN_KEEPALIVE
void set_transparency_mode(bool enabled) {
if (!pm) return;
projectm_set_transparency_mode(pm, enabled);
return;
}

EMSCRIPTEN_KEEPALIVE
bool get_transparency_mode() {
if (!pm) return false;
return projectm_get_transparency_mode(pm);
}

EMSCRIPTEN_KEEPALIVE
void set_transparency_threshold(float threshold) {
if (!pm) return;
projectm_set_transparency_threshold(pm, threshold);
return;
}

EMSCRIPTEN_KEEPALIVE
float get_transparency_threshold() {
if (!pm) return 0.01f;
return projectm_get_transparency_threshold(pm);
}

// Returns true when the dual-FBO compositor path is required this frame.
// Steady-state playback renders directly to the canvas (one pass); the
// offscreen ping-pong FBO + fullscreen compositor blit is only used while a
// preset crossfade is active.
static bool ShouldUseDualFboCompositor()
{
    return g_transitionActive &&
           g_dualFbo.IsPresetAAllocated() &&
           g_dualFbo.IsPresetBAllocated() &&
           g_compositorShader.IsInitialized();
}

EMSCRIPTEN_KEEPALIVE
void render_frame() {
if (!pm) return;

// Phase 5: Integrated dual-FBO render pipeline (transitions only).
//
// When a crossfade is active, the render loop orchestrates:
//
//   1. Render Preset A → FBO_A_Write, ping-pong to FBO_A_Read.
//   2. Render Preset B → FBO_B_Write, ping-pong to FBO_B_Read.
//   3. Composite to screen: blend FBO_A_Read + FBO_B_Read using uBlend.
//   4. Advance blend timer; auto-complete when uBlend >= 1.0.
//
// Between transitions (the common case), render straight to the default
// framebuffer via projectm_opengl_render_frame() — the same path used before
// the dual-FBO work landed — avoiding an extra FBO resolve + fullscreen blit
// every frame.

if (!ShouldUseDualFboCompositor())
{
    // Direct-to-canvas path (steady state, startup, or compositor unavailable).
    GLStateGuard guard;
    projectm_opengl_render_frame(pm);
    g_renderedFrameCount++;
    return;
}

const int w = g_dualFbo.Width();
const int h = g_dualFbo.Height();
const bool ditherOutput = (g_dualFbo.GetFormat() == FboFloatFormat::RGBA8);
const bool transparencyMode = projectm_get_transparency_mode(pm);
const float transparencyThreshold = projectm_get_transparency_threshold(pm);

// --- Step 1: Render Preset A into its Write FBO ---
// Note: projectm_opengl_render_frame() hardcodes its final composite blit to
// FBO 0 (the default framebuffer / canvas) regardless of which FBO is bound
// when called. Use projectm_opengl_render_frame_fbo() so the final composite
// lands in our Write FBO instead of clobbering the canvas directly.
{
    GLStateGuard guard;
    projectm_opengl_render_frame_fbo(pm, g_dualFbo.GetAWriteFBO());
}
g_dualFbo.SwapPresetA();

// --- Step 2: Render Preset B into its Write FBO ---
gl_reset_state_between_pipelines();
{
    GLStateGuard guard;
    projectm_opengl_render_frame_fbo(pm, g_dualFbo.GetBWriteFBO());
}
g_dualFbo.SwapPresetB();

// --- Step 3: Composite to the default framebuffer (browser canvas) ---
g_compositorShader.Draw(g_dualFbo.GetAReadTex(), g_dualFbo.GetBReadTex(),
                        g_transitionBlend, w, h, ditherOutput,
                        transparencyMode, transparencyThreshold);

// --- Step 4: Advance blend timer ---
float newBlend;
if (g_transitionDuration <= 0.0f)
{
    // Hard cut: jump immediately to full B.
    newBlend = 1.0f;
}
else
{
    // Time-based blend (emscripten_get_now() returns milliseconds).
    const double now = emscripten_get_now();
    newBlend = static_cast<float>((now - g_transitionStartTime) / (static_cast<double>(g_transitionDuration) * 1000.0));
}
g_transitionBlend = newBlend < 1.0f ? newBlend : 1.0f;

if (g_transitionBlend >= 1.0f)
{
    // Transition complete: promote B → A, release B's FBOs, reset state.
    g_dualFbo.PromoteBtoA();
    g_transitionBlend    = 0.0f;
    g_transitionActive   = false;
    g_presetBReady       = false;
    fprintf(stderr, "Phase5: Transition complete – Preset B promoted to A.\n");
}
g_renderedFrameCount++;
return;
}

EMSCRIPTEN_KEEPALIVE
void set_window_size(int width, int height) {
if (!pm) return;
emscripten_set_canvas_element_size(g_mainCanvasSelector, width, height);
if (CanvasElementExists(g_secondaryCanvasSelector))
{
    emscripten_set_canvas_element_size(g_secondaryCanvasSelector, width, height);
}
glViewport(0,0,width,height);
glScissor(0,0,width,height);
projectm_set_window_size(pm, width, height);
// Phase 2: Resize all allocated dual ping-pong FBOs to match the new viewport.
g_dualFbo.Resize(width, height);
return;
}
} // extern "C"

int main(){
init();
return 0;
}
