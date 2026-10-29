#include "Renderer/FlashLimiter.hpp"

#include "Renderer/Shader.hpp"
#include "Renderer/ShaderPrelude.hpp"

#include <Logging.hpp>

#include <algorithm>
#include <cmath>
#include <string>

namespace libprojectM {
namespace Renderer {

namespace {

/// Side of the square luminance grid the frame is reduced to.
constexpr int LumaGridSize{32};

/// The 3x1 state texture: texels 0 and 1 hold the luminance history, texel 2 the blend
/// factor and the clamped-frame count.
constexpr int StateWidth{3};

// Attribute-less fullscreen triangle: vertex IDs 0, 1, 2 cover the viewport.
constexpr char FullscreenVertexShader[] = R"(
void main() {
    vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}
)";

// Shared by all three fragment shaders. Everything the limiter stores lives in RGBA8
// textures, so values that need more than 8 bits are packed into two or three channels:
// no float render target (and so no EXT_color_buffer_float) is needed anywhere.
constexpr char CommonFunctions[] = R"(
vec3 SrgbToLinear(vec3 c)
{
    c = clamp(c, 0.0, 1.0);
    return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

vec3 LinearToSrgb(vec3 c)
{
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// WCAG relative luminance of an sRGB-encoded colour.
float RelativeLuminance(vec3 srgb)
{
    return dot(SrgbToLinear(srgb), vec3(0.2126, 0.7152, 0.0722));
}

vec2 Pack16(float value)
{
    float scaled = floor(clamp(value, 0.0, 1.0) * 65535.0 + 0.5);
    float high = floor(scaled / 256.0);
    return vec2(high, scaled - high * 256.0) / 255.0;
}

float Unpack16(vec2 encoded)
{
    vec2 bytes = floor(encoded * 255.0 + 0.5);
    return (bytes.x * 256.0 + bytes.y) / 65535.0;
}

vec3 Pack24(float value)
{
    float high = floor(value / 65536.0);
    float rest = value - high * 65536.0;
    float middle = floor(rest / 256.0);
    return vec3(high, middle, rest - middle * 256.0) / 255.0;
}

float Unpack24(vec3 encoded)
{
    vec3 bytes = floor(encoded * 255.0 + 0.5);
    return bytes.x * 65536.0 + bytes.y * 256.0 + bytes.z;
}
)";

// Pass 1: each of the 32x32 cells averages the relative luminance of a 4x4 grid of pixels
// inside it. texelFetch, not filtered taps: luminance is linear in light, sRGB values are
// not, so averaging before decoding would bias the mean.
constexpr char DownsampleFragmentShader[] = R"(
uniform sampler2D frame_texture;

out vec4 color;

void main()
{
    ivec2 frameSize = textureSize(frame_texture, 0);
    vec2 cellSize = vec2(frameSize) / 32.0;
    vec2 cellOrigin = floor(gl_FragCoord.xy) * cellSize;
    float sum = 0.0;
    for (int y = 0; y < 4; y++)
    {
        for (int x = 0; x < 4; x++)
        {
            ivec2 pixel = ivec2(cellOrigin + (vec2(x, y) + 0.5) * cellSize / 4.0);
            pixel = clamp(pixel, ivec2(0), frameSize - 1);
            sum += RelativeLuminance(texelFetch(frame_texture, pixel, 0).rgb);
        }
    }
    color = vec4(Pack16(sum / 16.0), 0.0, 1.0);
}
)";

// Pass 2: the limiter's decision, written to a 3x1 state texture.
//
//   texel 0: rg = luminance of the frame presented now, ba = upper envelope
//   texel 1: rg = lower envelope
//   texel 2: rgb = frames clamped so far, a = blend factor toward the new frame
//
// The envelopes follow the presented luminance: each holds the highest (lowest) value
// shown recently and relaxes toward the latest one at `envelope_decay` per frame. The
// presented luminance must stay within `threshold` of both, so it never spans more than
// `threshold` across the envelopes' memory, whatever the frame rate or the strobe pattern.
// The blend factor is the fraction of the way from the held frame to the new one that
// stays inside that band, rounded down to what an RGBA8 channel carries so the stored
// history is what the mix pass actually draws.
constexpr char StateFragmentShader[] = R"(
uniform sampler2D luma_texture;
uniform sampler2D previous_state;
uniform float threshold;
uniform float envelope_decay;
uniform int reset_history;

out vec4 color;

void main()
{
    float sum = 0.0;
    for (int y = 0; y < 32; y++)
    {
        for (int x = 0; x < 32; x++)
        {
            sum += Unpack16(texelFetch(luma_texture, ivec2(x, y), 0).rg);
        }
    }
    float frameLuma = sum / 1024.0;

    vec4 history = texelFetch(previous_state, ivec2(0, 0), 0);
    vec4 lower = texelFetch(previous_state, ivec2(1, 0), 0);
    vec4 counters = texelFetch(previous_state, ivec2(2, 0), 0);
    float heldLuma = Unpack16(history.rg);
    float upperEnvelope = Unpack16(history.ba);
    float lowerEnvelope = Unpack16(lower.rg);
    float clampedFrames = Unpack24(counters.rgb);

    float blend = 1.0;
    float presentedLuma = frameLuma;
    if (reset_history == 0)
    {
        // Relax toward the frame shown last, which always stays inside the envelopes.
        upperEnvelope = max(upperEnvelope - envelope_decay, heldLuma);
        lowerEnvelope = min(lowerEnvelope + envelope_decay, heldLuma);
        float target = clamp(frameLuma, upperEnvelope - threshold, lowerEnvelope + threshold);
        float delta = frameLuma - heldLuma;
        if (abs(delta) > 1.0e-6)
        {
            blend = clamp((target - heldLuma) / delta, 0.0, 1.0);
        }
        blend = floor(blend * 255.0) / 255.0;
        presentedLuma = heldLuma + blend * delta;
        if (blend < 1.0)
        {
            clampedFrames = min(clampedFrames + 1.0, 16777215.0);
        }
        upperEnvelope = max(upperEnvelope, presentedLuma);
        lowerEnvelope = min(lowerEnvelope, presentedLuma);
    }
    else
    {
        upperEnvelope = frameLuma;
        lowerEnvelope = frameLuma;
    }

    if (gl_FragCoord.x < 1.0)
    {
        color = vec4(Pack16(presentedLuma), Pack16(upperEnvelope));
    }
    else if (gl_FragCoord.x < 2.0)
    {
        color = vec4(Pack16(lowerEnvelope), 0.0, 1.0);
    }
    else
    {
        color = vec4(Pack24(clampedFrames), blend);
    }
}
)";

// Pass 3: the presented frame. Blended in linear light, so the mean luminance of the
// result is the one pass 2 decided on. An unlimited frame is copied bit for bit.
constexpr char MixFragmentShader[] = R"(
uniform sampler2D frame_texture;
uniform sampler2D held_texture;
uniform sampler2D state_texture;
uniform int premultiplied_alpha;

out vec4 color;

void main()
{
    ivec2 pixel = ivec2(gl_FragCoord.xy);
    vec4 frame = texelFetch(frame_texture, pixel, 0);
    float blend = texelFetch(state_texture, ivec2(2, 0), 0).a;
    if (blend >= 1.0)
    {
        color = frame;
        return;
    }
    vec4 held = texelFetch(held_texture, pixel, 0);
    vec3 blended = LinearToSrgb(mix(SrgbToLinear(held.rgb), SrgbToLinear(frame.rgb), blend));
    float alpha = mix(held.a, frame.a, blend);
    // The colour mixes in linear light and the alpha does not, so next to a pixel
    // transparency mode cut out the encoded colour can exceed the alpha. Only then is the
    // alpha coverage; otherwise it is blend-mode leftovers and must not dim the colour.
    if (premultiplied_alpha > 0)
    {
        blended = min(blended, vec3(alpha));
    }
    color = vec4(blended, alpha);
}
)";

auto BuildFragmentShader(const char* body) -> std::string
{
    std::string source(kShaderPrelude);
    source.append(CommonFunctions);
    source.append(body);
    return source;
}

} // anonymous namespace

FlashLimiter::FlashLimiter() = default;

FlashLimiter::~FlashLimiter()
{
    Release(false);
    m_device->DestroyVertexArray(m_vertexArray);
    m_vertexArray = {};
}

void FlashLimiter::SetEnabled(bool enabled)
{
    if (enabled && !m_enabled)
    {
        // The state textures still carry the previous run's count if they were never
        // released; the next Allocate() starts them at zero.
        Release(false);
        m_clampedFrames = 0;
        m_resetHistory = true;
    }
    m_enabled = enabled;
}

auto FlashLimiter::Enabled() const -> bool
{
    return m_enabled;
}

void FlashLimiter::SetThreshold(float threshold)
{
    if (!std::isfinite(threshold))
    {
        return;
    }
    m_threshold = std::clamp(threshold, 0.005f, 1.0f);
}

auto FlashLimiter::Threshold() const -> float
{
    return m_threshold;
}

auto FlashLimiter::BeginFrame(int width, int height) -> bool
{
    if (!m_enabled || m_shadersFailed || width <= 0 || height <= 0)
    {
        if (!m_enabled && m_allocated)
        {
            Release();
        }
        return false;
    }

    if (!m_allocated || width != m_width || height != m_height)
    {
        if (!Allocate(width, height))
        {
            Release();
            return false;
        }
    }

    m_device->Commands().BeginPass({m_frame.framebuffer, Device::TargetBinding::Draw, Device::Rect{0, 0, width, height}});
    return true;
}

void FlashLimiter::EndFrame(Device::RenderTargetHandle targetFramebuffer, double secondsSinceLastFrame, bool premultipliedAlpha)
{
    if (!m_allocated)
    {
        return;
    }

    using Device::Capability;
    auto& commands = m_device->Commands();
    const bool blendEnabled = commands.IsEnabled(Capability::Blend);
    const bool scissorEnabled = commands.IsEnabled(Capability::ScissorTest);
    const bool cullEnabled = commands.IsEnabled(Capability::CullFace);
    const bool depthEnabled = commands.IsEnabled(Capability::DepthTest);
    commands.SetEnabled(Capability::Blend, false);
    commands.SetEnabled(Capability::ScissorTest, false);
    commands.SetEnabled(Capability::CullFace, false);
    commands.SetEnabled(Capability::DepthTest, false);
    commands.BindVertexArray(m_vertexArray);

    const int previous = m_current;
    const int next = 1 - m_current;

    // Pass 1: frame -> 32x32 luminance cells.
    m_downsampleShader->Bind();
    m_downsampleShader->SetUniformInt("frame_texture", 0);
    BindTexture(0, m_frame.texture);
    DrawFullscreen(m_luma, LumaGridSize, LumaGridSize);

    // Pass 2: cells + previous state -> next state.
    const double step = std::clamp(secondsSinceLastFrame, 0.0, 1.0);
    const auto envelopeDecay = static_cast<float>(static_cast<double>(m_threshold) * step / WindowSeconds);
    m_stateShader->Bind();
    m_stateShader->SetUniformInt("luma_texture", 0);
    m_stateShader->SetUniformInt("previous_state", 1);
    m_stateShader->SetUniformFloat("threshold", m_threshold);
    m_stateShader->SetUniformFloat("envelope_decay", envelopeDecay);
    m_stateShader->SetUniformInt("reset_history", m_resetHistory ? 1 : 0);
    BindTexture(0, m_luma.texture);
    BindTexture(1, m_state.at(previous).texture);
    DrawFullscreen(m_state.at(next), StateWidth, 1);

    // Pass 3: frame + held frame + next state -> next held frame.
    m_mixShader->Bind();
    m_mixShader->SetUniformInt("frame_texture", 0);
    m_mixShader->SetUniformInt("held_texture", 1);
    m_mixShader->SetUniformInt("state_texture", 2);
    m_mixShader->SetUniformInt("premultiplied_alpha", premultipliedAlpha ? 1 : 0);
    BindTexture(0, m_frame.texture);
    BindTexture(1, m_held.at(previous).texture);
    BindTexture(2, m_state.at(next).texture);
    DrawFullscreen(m_held.at(next), m_width, m_height);

    for (int unit = 0; unit < 3; unit++)
    {
        BindTexture(unit, {});
    }
    commands.SetActiveTextureUnit(0);
    Shader::Unbind();
    commands.BindVertexArray({});

    m_current = next;
    m_presented = true;
    m_resetHistory = false;
    m_clampedFramesStale = true;

    // Present: copy the limited frame to where the frame belongs.
    commands.BindRenderTarget(Device::TargetBinding::Read, m_held.at(next).framebuffer);
    commands.SetReadBuffer(Device::AttachmentPoint::Color0);
    commands.BindRenderTarget(Device::TargetBinding::Draw, targetFramebuffer);
#ifdef USE_GLES
    // Same as the unlimited path in ProjectM::RenderFrame(): FBO 0 must draw to GL_BACK.
    if (!targetFramebuffer.Valid())
    {
        commands.SetDrawBuffers({Device::AttachmentPoint::Back});
    }
#endif
    commands.SetViewport({0, 0, m_width, m_height});
    if (scissorEnabled)
    {
        commands.SetEnabled(Capability::ScissorTest, true);
    }
    commands.Blit({0, 0, m_width, m_height}, {0, 0, m_width, m_height}, Device::FilterMode::Nearest);

    if (blendEnabled)
    {
        commands.SetEnabled(Capability::Blend, true);
    }
    if (cullEnabled)
    {
        commands.SetEnabled(Capability::CullFace, true);
    }
    if (depthEnabled)
    {
        commands.SetEnabled(Capability::DepthTest, true);
    }
}

auto FlashLimiter::ClampedFrames() -> uint32_t
{
    if (m_allocated && m_presented && m_clampedFramesStale)
    {
        m_clampedFrames = ReadClampedFrames(m_state.at(m_current));
        m_clampedFramesStale = false;
    }
    return m_clampedFrames;
}

auto FlashLimiter::PresentedFramebuffer() const -> Device::RenderTargetHandle
{
    return (m_allocated && m_presented) ? m_held.at(m_current).framebuffer : Device::RenderTargetHandle{};
}

auto FlashLimiter::Allocate(int width, int height) -> bool
{
    if (!CompileShaders())
    {
        return false;
    }
    if (!m_vertexArray.Valid())
    {
        m_vertexArray = m_device->CreateVertexArray();
    }

    // A resize keeps the counters but the held frame no longer matches the frame size.
    const bool keepState = m_allocated;
    const uint32_t clampedFrames = keepState ? ClampedFrames() : m_clampedFrames;

    for (auto* target : {&m_frame, &m_held.at(0), &m_held.at(1)})
    {
        DeleteTarget(*target);
        *target = CreateTarget(width, height);
    }
    if (!keepState)
    {
        DeleteTarget(m_luma);
        m_luma = CreateTarget(LumaGridSize, LumaGridSize);
        for (auto& state : m_state)
        {
            DeleteTarget(state);
            state = CreateTarget(StateWidth, 1);
        }
    }

    using Device::TargetBinding;
    auto& commands = m_device->Commands();
    const auto previousDraw = commands.BoundRenderTarget(TargetBinding::Draw);
    bool complete = true;
    for (const auto* target : {&m_frame, &m_held.at(0), &m_held.at(1), &m_luma, &m_state.at(0), &m_state.at(1)})
    {
        commands.BindRenderTarget(TargetBinding::Draw, target->framebuffer);
        complete = complete && commands.CheckRenderTarget(TargetBinding::Draw).complete;
    }
    if (!keepState && complete)
    {
        // Start the clamp count at zero: the count is carried in the state texture.
        const bool scissorEnabled = commands.IsEnabled(Device::Capability::ScissorTest);
        commands.SetEnabled(Device::Capability::ScissorTest, false);
        commands.SetClearColor({0.0f, 0.0f, 0.0f, 0.0f});
        for (const auto& state : m_state)
        {
            commands.BindRenderTarget(TargetBinding::Draw, state.framebuffer);
            commands.Clear(Device::ClearColor);
        }
        if (scissorEnabled)
        {
            commands.SetEnabled(Device::Capability::ScissorTest, true);
        }
    }
    commands.BindRenderTarget(TargetBinding::Draw, previousDraw);

    if (!complete)
    {
        LOG_ERROR("FlashLimiter: could not create its framebuffers; the limiter stays off.");
        return false;
    }

    if (keepState)
    {
        // Carry the count across the resize: it lives in the state texture the next frame
        // reads, which is left as it was.
        m_clampedFrames = clampedFrames;
    }
    m_allocated = true;
    m_width = width;
    m_height = height;
    m_presented = false;
    m_resetHistory = true;
    return true;
}

void FlashLimiter::Release(bool keepClampedFrames)
{
    if (keepClampedFrames && m_allocated && m_presented)
    {
        // Keep the count readable after the limiter is switched off.
        ClampedFrames();
    }
    for (auto* target : {&m_frame, &m_held.at(0), &m_held.at(1), &m_luma, &m_state.at(0), &m_state.at(1)})
    {
        DeleteTarget(*target);
    }
    m_allocated = false;
    m_presented = false;
    m_clampedFramesStale = false;
    m_width = 0;
    m_height = 0;
    m_current = 0;
}

auto FlashLimiter::CompileShaders() -> bool
{
    if (m_mixShader)
    {
        return true;
    }
    if (m_shadersFailed)
    {
        return false;
    }

    try
    {
        const std::string vertexShader = std::string(kShaderPrelude) + FullscreenVertexShader;
        auto downsample = std::make_unique<Shader>();
        downsample->CompileProgram(vertexShader, BuildFragmentShader(DownsampleFragmentShader));
        auto state = std::make_unique<Shader>();
        state->CompileProgram(vertexShader, BuildFragmentShader(StateFragmentShader));
        auto mix = std::make_unique<Shader>();
        mix->CompileProgram(vertexShader, BuildFragmentShader(MixFragmentShader));
        m_downsampleShader = std::move(downsample);
        m_stateShader = std::move(state);
        m_mixShader = std::move(mix);
    }
    catch (const ShaderException& ex)
    {
        LOG_ERROR(std::string("FlashLimiter: shader compilation failed; the limiter stays off: ") + ex.message());
        m_shadersFailed = true;
        return false;
    }
    return true;
}

void FlashLimiter::DrawFullscreen(const Target& target, int width, int height) const
{
    auto& commands = m_device->Commands();
    commands.BeginPass({target.framebuffer, Device::TargetBinding::Draw, Device::Rect{0, 0, width, height}});
    commands.Draw(Device::PrimitiveType::Triangles, 0, 3);
    commands.EndPass();
}

auto FlashLimiter::ReadClampedFrames(const Target& state) const -> uint32_t
{
    using Device::TargetBinding;
    auto& commands = m_device->Commands();
    const auto previousRead = commands.BoundRenderTarget(TargetBinding::Read);
    commands.BindRenderTarget(TargetBinding::Read, state.framebuffer);
    commands.SetReadBuffer(Device::AttachmentPoint::Color0);
    std::array<uint8_t, 4> texel{};
    commands.ReadPixels({StateWidth - 1, 0, 1, 1}, texel.data());
    commands.BindRenderTarget(TargetBinding::Read, previousRead);
    return (static_cast<uint32_t>(texel[0]) << 16U) | (static_cast<uint32_t>(texel[1]) << 8U) | texel[2];
}

auto FlashLimiter::CreateTarget(int width, int height) -> Target
{
    Target target;
    Device::TextureDesc desc;
    desc.width = width;
    desc.height = height;
    desc.format = Device::TextureFormat::RGBA8;
    // Every read is a texelFetch, but a texture is only complete (and texelFetch only
    // returns its contents) with a non-mipmapped minification filter.
    desc.sampling = Device::TextureSampling{Device::FilterMode::Nearest, Device::WrapMode::ClampToEdge};
    target.texture = m_device->CreateTexture(desc, nullptr);

    using Device::TargetBinding;
    auto& commands = m_device->Commands();
    const auto previousDraw = commands.BoundRenderTarget(TargetBinding::Draw);
    target.framebuffer = m_device->CreateRenderTarget();
    commands.BindRenderTarget(TargetBinding::Draw, target.framebuffer);
    commands.AttachTexture(TargetBinding::Draw, Device::AttachmentPoint::Color0, target.texture);
    commands.BindRenderTarget(TargetBinding::Draw, previousDraw);
    return target;
}

void FlashLimiter::DeleteTarget(Target& target)
{
    m_device->DestroyRenderTarget(target.framebuffer);
    m_device->DestroyTexture(target.texture);
    target = {};
}

void FlashLimiter::BindTexture(int unit, Device::TextureHandle texture) const
{
    // No sampler object overrides the texture's own parameters.
    auto& commands = m_device->Commands();
    commands.BindTexture(unit, Device::TextureTarget::Texture2D, texture);
    commands.BindSampler(unit, {});
}

} // namespace Renderer
} // namespace libprojectM
