// WasmPresent.cpp
//
// The end of a frame, per host: the flash limiter's switches (a thin forward to
// libprojectM's C API, which owns the pass — see docs/FLASH_LIMITER.md), the
// frame readback a recorder or screenshot button pulls, and the manual-present
// commit counter.
//
// Readback. capture_frame_request() asks for the next frame. render_frame()
// takes it (TakeRequestedFrameCapture()) after the compositor drew the canvas
// and before an explicitSwapControl host commits it — inside the task that
// drew it, which is the only point where the drawing buffer is guaranteed to
// hold the image without preserveDrawingBuffer. How it is read depends on how
// the host presents:
//
//   * browser present (the live player): one synchronous glReadPixels into the
//     host's buffer. It waits for that frame's GPU work, once, only when asked;
//     nothing is allocated until the first capture.
//   * manual present (explicitSwapControl, the offline-export path): the read
//     goes into a pixel-pack buffer behind a fence, so the frame that issued it
//     does not wait. capture_frame_status() picks the pixels up once the fence
//     has signalled; capture_frame_resolve(1) takes them at once (waiting if it
//     must, which an export tick can afford). The live player never allocates
//     the pack buffer.
//
// The pixels are RGBA8 with the top row first, exactly the drawing buffer's
// contents (alpha included), sized to the drawing buffer. Each host has its own
// buffers, so two canvases in one Module never share a staging allocation.
#include "WasmHost.hpp"

#include <cstring>

// Emscripten's WebGL 2 readback; glad's GLES loader has no glGetBufferSubData.
extern "C" void emscripten_glGetBufferSubData(GLenum target, GLintptr offset, GLsizeiptr size, void* data);

namespace {

// How often the perf HUD may read the clamp count back from the GPU.
constexpr double kFlashCountRefreshMs = 500.0;

void DeleteFence(FrameCaptureState& capture)
{
    if (capture.fence != nullptr)
    {
        glDeleteSync(capture.fence);
        capture.fence = nullptr;
    }
}

// Copies a bottom-up image (glReadPixels row order) into capture.pixels, top row first.
void StoreFlipped(FrameCaptureState& capture, const uint8_t* bottomUp)
{
    const size_t stride = static_cast<size_t>(capture.width) * 4;
    capture.pixels.resize(stride * static_cast<size_t>(capture.height));
    for (int row = 0; row < capture.height; ++row)
    {
        std::memcpy(capture.pixels.data() + static_cast<size_t>(row) * stride,
                    bottomUp + static_cast<size_t>(capture.height - 1 - row) * stride, stride);
    }
}

// Copies the pack buffer into the host's pixels. Waits for the GPU if the
// fence has not signalled yet.
void ResolvePendingCapture(FrameCaptureState& capture)
{
    const size_t bytes = static_cast<size_t>(capture.width) * static_cast<size_t>(capture.height) * 4;
    std::vector<uint8_t> bottomUp(bytes);
    glBindBuffer(GL_PIXEL_PACK_BUFFER, capture.pixelPackBuffer);
    emscripten_glGetBufferSubData(GL_PIXEL_PACK_BUFFER, 0, static_cast<GLsizeiptr>(bytes), bottomUp.data());
    glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
    DeleteFence(capture);
    StoreFlipped(capture, bottomUp.data());
    capture.status = FrameCaptureStatus::Ready;
}

// Moves a Pending capture to Ready once its fence has signalled; never waits.
void PollPendingCapture(FrameCaptureState& capture)
{
    if (capture.status != FrameCaptureStatus::Pending || capture.fence == nullptr)
    {
        return;
    }
    const GLenum result = glClientWaitSync(capture.fence, 0, 0);
    if (result == GL_ALREADY_SIGNALED || result == GL_CONDITION_SATISFIED)
    {
        ResolvePendingCapture(capture);
    }
}

// The active host's capture, with its GL context current (every export below
// runs after bindModuleToHost()/set_active_host() selected the host).
FrameCaptureState* ActiveCapture()
{
    WasmHost& H = Host();
    if (H.glCtx == 0)
    {
        return nullptr;
    }
    return &H.capture;
}

} // namespace

void TakeRequestedFrameCapture(WasmHost& host)
{
    FrameCaptureState& capture = host.capture;
    if (capture.status != FrameCaptureStatus::Requested)
    {
        return;
    }
    int width = 0;
    int height = 0;
    if (host.glCtx == 0 || emscripten_webgl_get_drawing_buffer_size(host.glCtx, &width, &height) != EMSCRIPTEN_RESULT_SUCCESS ||
        width <= 0 || height <= 0)
    {
        capture.status = FrameCaptureStatus::Failed;
        return;
    }
    capture.width = width;
    capture.height = height;
    capture.frameIndex = host.renderedFrameCount + 1;

    const bool manualPresent = host.contextConfig.explicitSwapControl != 0;
    GLint previousRead = 0;
    glGetIntegerv(GL_READ_FRAMEBUFFER_BINDING, &previousRead);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, 0);
    // A manual-present context draws "FBO 0" into Emscripten's offscreen back
    // buffer, which is a real framebuffer object; the browser's own default
    // framebuffer reads from its back buffer.
    glReadBuffer(manualPresent ? GL_COLOR_ATTACHMENT0 : GL_BACK);
    glPixelStorei(GL_PACK_ALIGNMENT, 1);

    const size_t bytes = static_cast<size_t>(width) * static_cast<size_t>(height) * 4;
    if (manualPresent)
    {
        if (capture.pixelPackBuffer == 0)
        {
            glGenBuffers(1, &capture.pixelPackBuffer);
        }
        glBindBuffer(GL_PIXEL_PACK_BUFFER, capture.pixelPackBuffer);
        if (capture.pixelPackBufferBytes != bytes)
        {
            glBufferData(GL_PIXEL_PACK_BUFFER, static_cast<GLsizeiptr>(bytes), nullptr, GL_STREAM_READ);
            capture.pixelPackBufferBytes = bytes;
        }
        glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
        glBindBuffer(GL_PIXEL_PACK_BUFFER, 0);
        DeleteFence(capture);
        capture.fence = glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
        capture.status = FrameCaptureStatus::Pending;
    }
    else
    {
        std::vector<uint8_t> bottomUp(bytes);
        glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, bottomUp.data());
        StoreFlipped(capture, bottomUp.data());
        capture.status = FrameCaptureStatus::Ready;
    }

    glPixelStorei(GL_PACK_ALIGNMENT, 4);
    glBindFramebuffer(GL_READ_FRAMEBUFFER, static_cast<GLuint>(previousRead));
}

void ReleaseFrameCapture(WasmHost& host)
{
    FrameCaptureState& capture = host.capture;
    DeleteFence(capture);
    if (capture.pixelPackBuffer != 0)
    {
        glDeleteBuffers(1, &capture.pixelPackBuffer);
        capture.pixelPackBuffer = 0;
    }
    capture.pixelPackBufferBytes = 0;
    capture.pixels.clear();
    capture.pixels.shrink_to_fit();
    // A request outstanding across a context loss can no longer be served.
    capture.status = capture.status == FrameCaptureStatus::Idle ? FrameCaptureStatus::Idle : FrameCaptureStatus::Failed;
}

double FlashClampedFramesForHud(WasmHost& host)
{
    projectm_handle engine = host.appData.Engine();
    if (engine == nullptr || !projectm_get_flash_limit_enabled(engine))
    {
        return -1.0;
    }
    const double now = emscripten_get_now();
    if (host.flashClampedFramesReadMs < 0.0 || now - host.flashClampedFramesReadMs >= kFlashCountRefreshMs)
    {
        host.flashClampedFrames = projectm_get_flash_limit_clamped_frames(engine);
        host.flashClampedFramesReadMs = now;
    }
    return static_cast<double>(host.flashClampedFrames);
}

extern "C" {

/**
 * Turns the temporal flash limiter on or off for the active host's engine
 * (projectm_set_flash_limit_enabled()). Remembered across engine re-creation.
 */
EMSCRIPTEN_KEEPALIVE
void set_flash_limit_enabled(bool enabled)
{
    WasmHost& H = Host();
    projectm_handle engine = H.appData.Engine();
    H.engineSettings.flashLimitEnabled = enabled;
    H.flashClampedFrames = 0;
    H.flashClampedFramesReadMs = -1.0;
    if (engine == nullptr)
    {
        return;
    }
    projectm_set_flash_limit_enabled(engine, enabled);
}

EMSCRIPTEN_KEEPALIVE
bool get_flash_limit_enabled()
{
    WasmHost& H = Host();
    projectm_handle engine = H.appData.Engine();
    if (engine == nullptr)
    {
        return H.engineSettings.flashLimitEnabled.value_or(false);
    }
    return projectm_get_flash_limit_enabled(engine);
}

/** The limiter's threshold (projectm_set_flash_limit_threshold()). */
EMSCRIPTEN_KEEPALIVE
void set_flash_limit_threshold(float threshold)
{
    WasmHost& H = Host();
    projectm_handle engine = H.appData.Engine();
    H.engineSettings.flashLimitThreshold = threshold;
    if (engine == nullptr)
    {
        return;
    }
    projectm_set_flash_limit_threshold(engine, threshold);
}

EMSCRIPTEN_KEEPALIVE
float get_flash_limit_threshold()
{
    WasmHost& H = Host();
    projectm_handle engine = H.appData.Engine();
    if (engine == nullptr)
    {
        return H.engineSettings.flashLimitThreshold.value_or(0.0f);
    }
    return projectm_get_flash_limit_threshold(engine);
}

/**
 * Frames the active host's limiter clamped since it was enabled. Reads back
 * from the GPU: poll it a few times a second, not every frame.
 */
EMSCRIPTEN_KEEPALIVE
unsigned int get_flash_limit_clamped_frames()
{
    WasmHost& H = Host();
    projectm_handle engine = H.appData.Engine();
    if (engine == nullptr)
    {
        return H.flashClampedFrames;
    }
    H.flashClampedFrames = projectm_get_flash_limit_clamped_frames(engine);
    H.flashClampedFramesReadMs = emscripten_get_now();
    return H.flashClampedFrames;
}

/** emscripten_webgl_commit_frame() calls on this host since it was created (0 unless explicitSwapControl). */
EMSCRIPTEN_KEEPALIVE
unsigned int get_committed_frame_count()
{
    return Host().committedFrameCount;
}

/**
 * Asks for the next frame this host renders to be read back. Replaces a
 * capture that has not been picked up. Returns 1, or 0 when the host has no
 * context.
 */
EMSCRIPTEN_KEEPALIVE
int capture_frame_request()
{
    FrameCaptureState* capture = ActiveCapture();
    if (capture == nullptr)
    {
        return 0;
    }
    DeleteFence(*capture);
    capture->status = FrameCaptureStatus::Requested;
    return 1;
}

/**
 * The capture's state: 0 idle, 1 requested (the frame has not rendered yet),
 * 2 pending (read issued, GPU not done), 3 ready, 4 failed. Moves a pending
 * capture to ready once the GPU has finished, without waiting for it.
 */
EMSCRIPTEN_KEEPALIVE
int capture_frame_status()
{
    FrameCaptureState* capture = ActiveCapture();
    if (capture == nullptr)
    {
        return static_cast<int>(Host().capture.status);
    }
    PollPendingCapture(*capture);
    return static_cast<int>(capture->status);
}

/**
 * capture_frame_status(), except that `wait` != 0 takes a pending capture
 * now, waiting for the GPU if it has to (an export tick can afford that; a
 * live frame should poll capture_frame_status() instead).
 */
EMSCRIPTEN_KEEPALIVE
int capture_frame_resolve(int wait)
{
    FrameCaptureState* capture = ActiveCapture();
    if (capture == nullptr)
    {
        return static_cast<int>(Host().capture.status);
    }
    if (wait != 0 && capture->status == FrameCaptureStatus::Pending)
    {
        ResolvePendingCapture(*capture);
    }
    else
    {
        PollPendingCapture(*capture);
    }
    return static_cast<int>(capture->status);
}

/** Heap address of the ready capture's RGBA8 pixels (top row first), or 0. */
EMSCRIPTEN_KEEPALIVE
uintptr_t capture_frame_data_ptr()
{
    const FrameCaptureState& capture = Host().capture;
    if (capture.status != FrameCaptureStatus::Ready || capture.pixels.empty())
    {
        return 0;
    }
    return reinterpret_cast<uintptr_t>(capture.pixels.data());
}

EMSCRIPTEN_KEEPALIVE
int capture_frame_width()
{
    return Host().capture.width;
}

EMSCRIPTEN_KEEPALIVE
int capture_frame_height()
{
    return Host().capture.height;
}

/** get_rendered_frame_count() as it read right after the captured frame. */
EMSCRIPTEN_KEEPALIVE
unsigned int capture_frame_index()
{
    return Host().capture.frameIndex;
}

/** Frees the captured pixels (the pack buffer is kept for the next capture). */
EMSCRIPTEN_KEEPALIVE
void capture_frame_release()
{
    FrameCaptureState& capture = Host().capture;
    if (capture.status == FrameCaptureStatus::Pending)
    {
        DeleteFence(capture);
    }
    capture.pixels.clear();
    capture.pixels.shrink_to_fit();
    capture.status = FrameCaptureStatus::Idle;
}

} // extern "C"
