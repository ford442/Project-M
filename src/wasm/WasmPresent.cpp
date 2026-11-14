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

#include <Renderer/Device/RenderDevice.hpp>

#include <cstring>

namespace {

// How often the perf HUD may read the clamp count back from the GPU.
constexpr double kFlashCountRefreshMs = 500.0;

void DeleteFence(FrameCaptureState& capture)
{
    if (capture.fence.Valid())
    {
        RenderDevice::Current().DestroyFence(capture.fence);
        capture.fence = {};
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
    auto& device = RenderDevice::Current();
    device.Commands().BindBuffer(RenderDevice::BufferKind::PixelPack, capture.pixelPackBuffer);
    device.ReadBoundBuffer(RenderDevice::BufferKind::PixelPack, bytes, bottomUp.data());
    device.Commands().BindBuffer(RenderDevice::BufferKind::PixelPack, {});
    DeleteFence(capture);
    StoreFlipped(capture, bottomUp.data());
    capture.status = FrameCaptureStatus::Ready;
}

// Moves a Pending capture to Ready once its fence has signalled; never waits.
void PollPendingCapture(FrameCaptureState& capture)
{
    if (capture.status != FrameCaptureStatus::Pending || !capture.fence.Valid())
    {
        return;
    }
    if (RenderDevice::Current().PollFence(capture.fence) == RenderDevice::FenceStatus::Signaled)
    {
        ResolvePendingCapture(capture);
    }
}

// The host's capture, or nullptr while it has no context (the barrier made
// that context current).
FrameCaptureState* ContextCapture(WasmHost& H)
{
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
    using RenderDevice::BufferKind;
    using RenderDevice::TargetBinding;
    auto& device = RenderDevice::Current();
    auto& commands = device.Commands();
    const auto previousRead = commands.BoundRenderTarget(TargetBinding::Read);
    commands.BindRenderTarget(TargetBinding::Read, {});
    // A manual-present context draws "FBO 0" into Emscripten's offscreen back
    // buffer, which is a real framebuffer object; the browser's own default
    // framebuffer reads from its back buffer.
    commands.SetReadBuffer(manualPresent ? RenderDevice::AttachmentPoint::Color0 : RenderDevice::AttachmentPoint::Back);

    const RenderDevice::Rect area{0, 0, width, height};
    const size_t bytes = static_cast<size_t>(width) * static_cast<size_t>(height) * 4;
    if (manualPresent)
    {
        if (!capture.pixelPackBuffer.Valid())
        {
            capture.pixelPackBuffer = device.CreateBuffer();
        }
        commands.BindBuffer(BufferKind::PixelPack, capture.pixelPackBuffer);
        if (capture.pixelPackBufferBytes != bytes)
        {
            commands.UploadBoundBuffer(BufferKind::PixelPack, nullptr, bytes, RenderDevice::BufferUsage::StreamRead, true);
            capture.pixelPackBufferBytes = bytes;
        }
        // With a pack buffer bound the destination is an offset into it.
        commands.ReadPixels(area, nullptr);
        commands.BindBuffer(BufferKind::PixelPack, {});
        DeleteFence(capture);
        capture.fence = device.CreateFence();
        capture.status = FrameCaptureStatus::Pending;
    }
    else
    {
        std::vector<uint8_t> bottomUp(bytes);
        commands.ReadPixels(area, bottomUp.data());
        StoreFlipped(capture, bottomUp.data());
        capture.status = FrameCaptureStatus::Ready;
    }

    commands.BindRenderTarget(TargetBinding::Read, previousRead);
}

void ReleaseFrameCapture(WasmHost& host)
{
    FrameCaptureState& capture = host.capture;
    DeleteFence(capture);
    if (capture.pixelPackBuffer.Valid())
    {
        RenderDevice::Current().DestroyBuffer(capture.pixelPackBuffer);
        capture.pixelPackBuffer = {};
    }
    capture.pixelPackBufferBytes = 0;
    capture.pixels.clear();
    capture.pixels.shrink_to_fit();
    // A request outstanding across a context loss can no longer be served.
    capture.status = capture.status == FrameCaptureStatus::Idle ? FrameCaptureStatus::Idle : FrameCaptureStatus::Failed;
}

double FlashClampedFramesForHud(WasmHost& host)
{
    projectm_handle pm = host.appData.projectm_engine;
    if (pm == nullptr || !projectm_get_flash_limit_enabled(pm))
    {
        return -1.0;
    }
    const double now = emscripten_get_now();
    if (host.flashClampedFramesReadMs < 0.0 || now - host.flashClampedFramesReadMs >= kFlashCountRefreshMs)
    {
        host.flashClampedFrames = projectm_get_flash_limit_clamped_frames(pm);
        host.flashClampedFramesReadMs = now;
    }
    return static_cast<double>(host.flashClampedFrames);
}

namespace WasmApi {

/**
 * Turns the temporal flash limiter on or off for the active host's engine
 * (projectm_set_flash_limit_enabled()). Remembered across engine re-creation.
 */
void set_flash_limit_enabled(WasmHost& H, bool enabled)
{
    auto& pm = H.appData.projectm_engine;
    H.engineSettings.flashLimitEnabled = enabled;
    H.flashClampedFrames = 0;
    H.flashClampedFramesReadMs = -1.0;
    if (!pm)
    {
        return;
    }
    projectm_set_flash_limit_enabled(pm, enabled);
}

bool get_flash_limit_enabled(WasmHost& H)
{
    auto& pm = H.appData.projectm_engine;
    if (!pm)
    {
        return H.engineSettings.flashLimitEnabled.value_or(false);
    }
    return projectm_get_flash_limit_enabled(pm);
}

/** The limiter's threshold (projectm_set_flash_limit_threshold()). */
void set_flash_limit_threshold(WasmHost& H, float threshold)
{
    auto& pm = H.appData.projectm_engine;
    H.engineSettings.flashLimitThreshold = threshold;
    if (!pm)
    {
        return;
    }
    projectm_set_flash_limit_threshold(pm, threshold);
}

float get_flash_limit_threshold(WasmHost& H)
{
    auto& pm = H.appData.projectm_engine;
    if (!pm)
    {
        return H.engineSettings.flashLimitThreshold.value_or(0.0f);
    }
    return projectm_get_flash_limit_threshold(pm);
}

/**
 * Frames the active host's limiter clamped since it was enabled. Reads back
 * from the GPU: poll it a few times a second, not every frame.
 */
uint32_t get_flash_limit_clamped_frames(WasmHost& H)
{
    auto& pm = H.appData.projectm_engine;
    if (!pm)
    {
        return H.flashClampedFrames;
    }
    H.flashClampedFrames = projectm_get_flash_limit_clamped_frames(pm);
    H.flashClampedFramesReadMs = emscripten_get_now();
    return H.flashClampedFrames;
}

/** emscripten_webgl_commit_frame() calls on this host since it was created (0 unless explicitSwapControl). */
uint32_t get_committed_frame_count(WasmHost& H)
{
    return H.committedFrameCount;
}

/**
 * Asks for the next frame this host renders to be read back. Replaces a
 * capture that has not been picked up. Returns 1, or 0 when the host has no
 * context.
 */
int capture_frame_request(WasmHost& H)
{
    FrameCaptureState* capture = ContextCapture(H);
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
int capture_frame_status(WasmHost& H)
{
    FrameCaptureState* capture = ContextCapture(H);
    if (capture == nullptr)
    {
        return static_cast<int>(H.capture.status);
    }
    PollPendingCapture(*capture);
    return static_cast<int>(capture->status);
}

/**
 * capture_frame_status(), except that `wait` != 0 takes a pending capture
 * now, waiting for the GPU if it has to (an export tick can afford that; a
 * live frame should poll capture_frame_status() instead).
 */
int capture_frame_resolve(WasmHost& H, bool wait)
{
    FrameCaptureState* capture = ContextCapture(H);
    if (capture == nullptr)
    {
        return static_cast<int>(H.capture.status);
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
uintptr_t capture_frame_data_ptr(WasmHost& H)
{
    const FrameCaptureState& capture = H.capture;
    if (capture.status != FrameCaptureStatus::Ready || capture.pixels.empty())
    {
        return 0;
    }
    return reinterpret_cast<uintptr_t>(capture.pixels.data());
}

int capture_frame_width(WasmHost& H)
{
    return H.capture.width;
}

int capture_frame_height(WasmHost& H)
{
    return H.capture.height;
}

/** get_rendered_frame_count() as it read right after the captured frame. */
uint32_t capture_frame_index(WasmHost& H)
{
    return H.capture.frameIndex;
}

/** Frees the captured pixels (the pack buffer is kept for the next capture). */
void capture_frame_release(WasmHost& H)
{
    FrameCaptureState& capture = H.capture;
    if (capture.status == FrameCaptureStatus::Pending)
    {
        DeleteFence(capture);
    }
    capture.pixels.clear();
    capture.pixels.shrink_to_fit();
    capture.status = FrameCaptureStatus::Idle;
}

} // namespace WasmApi
