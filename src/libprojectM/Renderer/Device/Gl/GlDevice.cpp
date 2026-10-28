#include "Renderer/Device/Gl/GlDevice.hpp"

#include "Renderer/Device/Gl/GlEnums.hpp"

#include <cstdlib>
#include <cstring>

#ifndef GL_COMPLETION_STATUS_KHR
#define GL_COMPLETION_STATUS_KHR 0x91B1
#endif

#ifdef __EMSCRIPTEN__
// WebGL 2 readback; glad's GLES loader has no glGetBufferSubData.
extern "C" void emscripten_glGetBufferSubData(GLenum target, GLintptr offset, GLsizeiptr size, void* data);
#endif

namespace libprojectM {
namespace Renderer {
namespace Device {
namespace Gl {

namespace {

auto IsSamplerType(GLenum type) -> bool
{
    switch (type)
    {
        case GL_SAMPLER_2D:
        case GL_SAMPLER_3D:
        case GL_SAMPLER_CUBE:
        case GL_SAMPLER_2D_SHADOW:
        case GL_SAMPLER_2D_ARRAY:
        case GL_SAMPLER_2D_ARRAY_SHADOW:
        case GL_SAMPLER_CUBE_SHADOW:
        case GL_INT_SAMPLER_2D:
        case GL_INT_SAMPLER_3D:
        case GL_INT_SAMPLER_CUBE:
        case GL_INT_SAMPLER_2D_ARRAY:
        case GL_UNSIGNED_INT_SAMPLER_2D:
        case GL_UNSIGNED_INT_SAMPLER_3D:
        case GL_UNSIGNED_INT_SAMPLER_CUBE:
        case GL_UNSIGNED_INT_SAMPLER_2D_ARRAY:
            return true;
        default:
            return false;
    }
}

/**
 * @brief The info log of a shader stage that failed to compile, or nothing if it compiled.
 */
auto StageCompileError(GLuint shader, std::string& log) -> bool
{
    GLint shaderCompiled{};
    glGetShaderiv(shader, GL_COMPILE_STATUS, &shaderCompiled);
    if (shaderCompiled == GL_TRUE)
    {
        return false;
    }

    GLint infoLogLength{};
    glGetShaderiv(shader, GL_INFO_LOG_LENGTH, &infoLogLength);
    std::vector<char> message(infoLogLength + 1);
    glGetShaderInfoLog(shader, infoLogLength, nullptr, message.data());
    log = message.data();
    return true;
}

auto CreateStage(GLenum type, const std::string& source) -> GLuint
{
    auto shader = glCreateShader(type);
    const auto* shaderSourceCStr = source.c_str();
    glShaderSource(shader, 1, &shaderSourceCStr, nullptr);

    glCompileShader(shader);

    return shader;
}

void TexImage(GLenum target, const TextureDesc& desc, const void* data)
{
    const auto format = ToGl(desc.format, desc.dataOrder);
    switch (desc.target)
    {
        case TextureTarget::Texture2D:
            glTexImage2D(target, 0, format.internalFormat, desc.width, desc.height, 0, format.format, format.type, data);
            break;
        case TextureTarget::Texture3D:
            glTexImage3D(target, 0, format.internalFormat, desc.width, desc.height, desc.depth, 0, format.format, format.type, data);
            break;
    }
}

} // anonymous namespace

// ==== GlCommandList ===================================================================

GlCommandList::GlCommandList(ResourceStateTracker& tracker)
    : m_tracker(tracker)
{
}

void GlCommandList::BeginPass(const RenderPassDesc& pass)
{
    BindRenderTarget(pass.binding, pass.target);
    if (pass.viewport)
    {
        SetViewport(*pass.viewport);
    }
    if (pass.load == LoadOp::Clear)
    {
        SetClearColor(pass.clearColor);
        Clear(ClearColor);
    }
}

void GlCommandList::EndPass()
{
    m_tracker.OnEndPass();
}

void GlCommandList::BindRenderTarget(TargetBinding binding, RenderTargetHandle target)
{
    glBindFramebuffer(ToGl(binding), target.id);
    m_tracker.OnBindRenderTarget(binding, target);
}

auto GlCommandList::BoundRenderTarget(TargetBinding binding) -> RenderTargetHandle
{
    GLint framebuffer{};
    glGetIntegerv(BindingQuery(binding), &framebuffer);
    return {static_cast<uint32_t>(framebuffer)};
}

void GlCommandList::AttachTexture(TargetBinding binding, AttachmentPoint point, TextureHandle texture)
{
    glFramebufferTexture2D(ToGl(binding), ToGl(point), GL_TEXTURE_2D, texture.id, 0);
    m_tracker.OnAttach(binding, point, texture);
}

void GlCommandList::SetDrawBuffers(const std::vector<AttachmentPoint>& points)
{
    std::vector<GLenum> buffers;
    buffers.reserve(points.size());
    for (const auto point : points)
    {
        buffers.push_back(ToGl(point));
    }
    glDrawBuffers(static_cast<GLsizei>(buffers.size()), buffers.data());
}

void GlCommandList::SetReadBuffer(AttachmentPoint point)
{
    glReadBuffer(ToGl(point));
}

auto GlCommandList::CheckRenderTarget(TargetBinding binding) -> RenderTargetStatus
{
    const GLenum status = glCheckFramebufferStatus(ToGl(binding));
    return {status == GL_FRAMEBUFFER_COMPLETE, static_cast<uint32_t>(status)};
}

void GlCommandList::SetViewport(const Rect& viewport)
{
    glViewport(viewport.x, viewport.y, viewport.width, viewport.height);
}

auto GlCommandList::Viewport() -> Rect
{
    GLint viewport[4]{};
    glGetIntegerv(GL_VIEWPORT, viewport);
    return {viewport[0], viewport[1], viewport[2], viewport[3]};
}

void GlCommandList::SetScissor(const Rect& box)
{
    glScissor(box.x, box.y, box.width, box.height);
}

void GlCommandList::SetEnabled(Capability capability, bool enabled)
{
    const GLenum glCapability = ToGl(capability);
    if (glCapability == GL_NONE)
    {
        return;
    }
    if (enabled)
    {
        glEnable(glCapability);
    }
    else
    {
        glDisable(glCapability);
    }
}

auto GlCommandList::IsEnabled(Capability capability) -> bool
{
    const GLenum glCapability = ToGl(capability);
    return glCapability != GL_NONE && glIsEnabled(glCapability) == GL_TRUE;
}

void GlCommandList::SetBlendFunction(BlendFactor source, BlendFactor destination)
{
    glBlendFunc(ToGl(source), ToGl(destination));
}

void GlCommandList::SetBlendFunction(const BlendFunction& function)
{
    glBlendFuncSeparate(ToGl(function.sourceColor), ToGl(function.destinationColor),
                        ToGl(function.sourceAlpha), ToGl(function.destinationAlpha));
}

auto GlCommandList::GetBlendFunction() -> BlendFunction
{
    GLint sourceColor{GL_ONE};
    GLint destinationColor{GL_ZERO};
    GLint sourceAlpha{GL_ONE};
    GLint destinationAlpha{GL_ZERO};
    glGetIntegerv(GL_BLEND_SRC_RGB, &sourceColor);
    glGetIntegerv(GL_BLEND_DST_RGB, &destinationColor);
    glGetIntegerv(GL_BLEND_SRC_ALPHA, &sourceAlpha);
    glGetIntegerv(GL_BLEND_DST_ALPHA, &destinationAlpha);
    return {BlendFactorFromGl(static_cast<GLenum>(sourceColor)), BlendFactorFromGl(static_cast<GLenum>(destinationColor)),
            BlendFactorFromGl(static_cast<GLenum>(sourceAlpha)), BlendFactorFromGl(static_cast<GLenum>(destinationAlpha))};
}

void GlCommandList::SetDepthMask(bool writeEnabled)
{
    glDepthMask(writeEnabled ? GL_TRUE : GL_FALSE);
}

auto GlCommandList::DepthMask() -> bool
{
    GLboolean depthMask{GL_TRUE};
    glGetBooleanv(GL_DEPTH_WRITEMASK, &depthMask);
    return depthMask == GL_TRUE;
}

void GlCommandList::SetColorMask(bool red, bool green, bool blue, bool alpha)
{
    glColorMask(red ? GL_TRUE : GL_FALSE, green ? GL_TRUE : GL_FALSE, blue ? GL_TRUE : GL_FALSE, alpha ? GL_TRUE : GL_FALSE);
}

void GlCommandList::SetDrawBufferWriteMask(int drawBuffer, bool writeEnabled)
{
    const auto mask = static_cast<GLboolean>(writeEnabled);
#ifdef USE_GLES
    (void) drawBuffer;
    glColorMask(mask, mask, mask, mask);
#else
    glColorMaski(drawBuffer, mask, mask, mask, mask);
#endif
}

void GlCommandList::SetCullMode(FrontFace frontFace, CullFace cullFace)
{
    glFrontFace(frontFace == FrontFace::Clockwise ? GL_CW : GL_CCW);
    glCullFace(cullFace == CullFace::Back ? GL_BACK : GL_FRONT);
}

void GlCommandList::SetLineWidth(float width)
{
    glLineWidth(width);
}

void GlCommandList::SetNicestQualityHints()
{
    glHint(GL_FRAGMENT_SHADER_DERIVATIVE_HINT, GL_NICEST);
#ifdef USE_GLES
    // Removed from desktop core profiles.
    glHint(GL_GENERATE_MIPMAP_HINT, GL_NICEST);
#endif
}

void GlCommandList::SetClearColor(const std::array<float, 4>& color)
{
    glClearColor(color[0], color[1], color[2], color[3]);
}

void GlCommandList::Clear(uint8_t clearMask)
{
    GLbitfield bits{};
    if ((clearMask & ClearColor) != 0)
    {
        bits |= GL_COLOR_BUFFER_BIT;
    }
    if ((clearMask & ClearDepth) != 0)
    {
        bits |= GL_DEPTH_BUFFER_BIT;
    }
    if ((clearMask & ClearStencil) != 0)
    {
        bits |= GL_STENCIL_BUFFER_BIT;
    }
    glClear(bits);
}

void GlCommandList::ClearColorAttachment(int drawBuffer, const std::array<float, 4>& color)
{
    glClearBufferfv(GL_COLOR, drawBuffer, color.data());
}

void GlCommandList::SetProgram(ProgramHandle program)
{
    glUseProgram(program.id);
    m_tracker.OnSetProgram(program);
}

void GlCommandList::SetUniform(int location, UniformType type, int count, const void* data)
{
    if (location < 0 || count <= 0)
    {
        return;
    }

    const auto* floats = static_cast<const GLfloat*>(data);
    const auto* ints = static_cast<const GLint*>(data);
    switch (type)
    {
        case UniformType::Float:
            glUniform1fv(location, count, floats);
            break;
        case UniformType::Float2:
            glUniform2fv(location, count, floats);
            break;
        case UniformType::Float3:
            glUniform3fv(location, count, floats);
            break;
        case UniformType::Float4:
            glUniform4fv(location, count, floats);
            break;
        case UniformType::Int:
            glUniform1iv(location, count, ints);
            m_tracker.OnSetUniformInt(location, count, ints);
            break;
        case UniformType::Int2:
            glUniform2iv(location, count, ints);
            break;
        case UniformType::Int3:
            glUniform3iv(location, count, ints);
            break;
        case UniformType::Int4:
            glUniform4iv(location, count, ints);
            break;
        case UniformType::Mat3x4:
            glUniformMatrix3x4fv(location, count, GL_FALSE, floats);
            break;
        case UniformType::Mat4x4:
            glUniformMatrix4fv(location, count, GL_FALSE, floats);
            break;
    }
}

void GlCommandList::BindTexture(int unit, TextureTarget target, TextureHandle texture)
{
    glActiveTexture(GL_TEXTURE0 + unit);
    glBindTexture(ToGl(target), texture.id);
    m_tracker.OnBindTexture(unit, target, texture);
}

auto GlCommandList::BoundTexture2D() -> TextureHandle
{
    GLint texture{};
    glGetIntegerv(GL_TEXTURE_BINDING_2D, &texture);
    return {static_cast<uint32_t>(texture)};
}

void GlCommandList::BindSampler(int unit, SamplerHandle sampler)
{
    glBindSampler(unit, sampler.id);
}

void GlCommandList::SetActiveTextureUnit(int unit)
{
    glActiveTexture(GL_TEXTURE0 + unit);
}

auto GlCommandList::ActiveTextureUnit() -> int
{
    GLint activeTexture{GL_TEXTURE0};
    glGetIntegerv(GL_ACTIVE_TEXTURE, &activeTexture);
    return activeTexture - GL_TEXTURE0;
}

void GlCommandList::SetBoundTextureFilter(int unit, TextureTarget target, FilterMode filter)
{
    glActiveTexture(GL_TEXTURE0 + unit);
    glTexParameteri(ToGl(target), GL_TEXTURE_MIN_FILTER, ToGl(filter));
    glTexParameteri(ToGl(target), GL_TEXTURE_MAG_FILTER, ToGl(filter));
}

void GlCommandList::SetBoundTextureWrap(int unit, TextureTarget target, WrapMode wrap)
{
    glActiveTexture(GL_TEXTURE0 + unit);
    glTexParameteri(ToGl(target), GL_TEXTURE_WRAP_S, ToGl(wrap));
    glTexParameteri(ToGl(target), GL_TEXTURE_WRAP_T, ToGl(wrap));
}

void GlCommandList::SetBoundTextureMaxAnisotropy(int unit, TextureTarget target, float maxAnisotropy)
{
#ifdef GL_EXT_texture_filter_anisotropic
    glActiveTexture(GL_TEXTURE0 + unit);
    glTexParameterf(ToGl(target), GL_TEXTURE_MAX_ANISOTROPY_EXT, maxAnisotropy);
#else
    (void) unit;
    (void) target;
    (void) maxAnisotropy;
#endif
}

void GlCommandList::CopyToBoundTexture(int unit, int width, int height)
{
    glActiveTexture(GL_TEXTURE0 + unit);
    glCopyTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, 0, 0, width, height);
    m_tracker.OnCopyToTexture(unit);
}

void GlCommandList::BindVertexArray(VertexArrayHandle vertexArray)
{
    glBindVertexArray(vertexArray.id);
}

void GlCommandList::BindBuffer(BufferKind kind, BufferHandle buffer)
{
    glBindBuffer(ToGl(kind), buffer.id);
}

void GlCommandList::UploadBoundBuffer(BufferKind kind, const void* data, size_t bytes, BufferUsage usage, bool reallocate)
{
    if (reallocate)
    {
        glBufferData(ToGl(kind), static_cast<GLsizeiptr>(bytes), data, ToGl(usage));
    }
    else
    {
        glBufferSubData(ToGl(kind), 0, static_cast<GLsizeiptr>(bytes), data);
    }
}

void GlCommandList::SetVertexAttributeLayout(int index, const VertexAttributeLayout& layout)
{
    glVertexAttribPointer(index, layout.components, GL_FLOAT, GL_FALSE, layout.stride,
                          reinterpret_cast<const void*>(layout.offset)); // NOLINT(performance-no-int-to-ptr): GL takes buffer offsets as pointers.
}

void GlCommandList::SetVertexAttributeEnabled(int index, bool enabled)
{
    if (enabled)
    {
        glEnableVertexAttribArray(index);
    }
    else
    {
        glDisableVertexAttribArray(index);
    }
}

void GlCommandList::SetConstantVertexAttribute(int index, const std::array<float, 4>& value)
{
    glVertexAttrib4f(index, value[0], value[1], value[2], value[3]);
}

void GlCommandList::Draw(PrimitiveType primitive, int first, int count)
{
    glDrawArrays(ToGl(primitive), first, count);
    m_tracker.OnDraw();
}

void GlCommandList::DrawIndexed(PrimitiveType primitive, int count)
{
    glDrawElements(ToGl(primitive), count, GL_UNSIGNED_INT, nullptr);
    m_tracker.OnDraw();
}

void GlCommandList::Blit(const Rect& source, const Rect& destination, FilterMode filter)
{
    glBlitFramebuffer(source.x, source.y, source.x + source.width, source.y + source.height,
                      destination.x, destination.y, destination.x + destination.width, destination.y + destination.height,
                      GL_COLOR_BUFFER_BIT, static_cast<GLenum>(ToGl(filter)));
    m_tracker.OnBlit();
}

void GlCommandList::ReadPixels(const Rect& area, void* destination)
{
    glPixelStorei(GL_PACK_ALIGNMENT, 1);
    glReadPixels(area.x, area.y, area.width, area.height, GL_RGBA, GL_UNSIGNED_BYTE, destination);
    glPixelStorei(GL_PACK_ALIGNMENT, 4);
}

auto GlCommandList::CaptureState() -> StateSnapshot
{
    StateSnapshot state;
    state.blendEnabled = glIsEnabled(GL_BLEND) == GL_TRUE;
    state.blendFunction = GetBlendFunction();
    state.depthMask = DepthMask();
    state.viewport = Viewport();
    state.scissorEnabled = glIsEnabled(GL_SCISSOR_TEST) == GL_TRUE;
    GLint scissorBox[4]{};
    glGetIntegerv(GL_SCISSOR_BOX, scissorBox);
    state.scissorBox = {scissorBox[0], scissorBox[1], scissorBox[2], scissorBox[3]};
    state.activeTextureUnit = ActiveTextureUnit();
    glActiveTexture(GL_TEXTURE0);
    state.unit0Texture2D = BoundTexture2D();
    glActiveTexture(GL_TEXTURE0 + state.activeTextureUnit);
    state.drawTarget = BoundRenderTarget(TargetBinding::ReadDraw);
    return state;
}

void GlCommandList::RestoreState(const StateSnapshot& state)
{
    BindRenderTarget(TargetBinding::ReadDraw, state.drawTarget);
    SetEnabled(Capability::Blend, state.blendEnabled);
    SetBlendFunction(state.blendFunction);
    SetDepthMask(state.depthMask);
    SetViewport(state.viewport);
    SetEnabled(Capability::ScissorTest, state.scissorEnabled);
    SetScissor(state.scissorBox);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, state.unit0Texture2D.id);
    m_tracker.OnBindTexture(0, TextureTarget::Texture2D, state.unit0Texture2D);
    glActiveTexture(GL_TEXTURE0 + state.activeTextureUnit);
}

// ==== GlDevice ========================================================================

GlDevice::GlDevice()
{
    const char* const validation = std::getenv("PROJECTM_DEVICE_VALIDATION");
    if (validation != nullptr && validation[0] == '1')
    {
        m_tracker.SetEnabled(true);
    }
}

auto GlDevice::Commands() -> ICommandList&
{
    return m_commands;
}

auto GlDevice::Validation() -> ResourceStateTracker&
{
    return m_tracker;
}

auto GlDevice::ShadingLanguageVersionString() -> std::string
{
    const auto* version = reinterpret_cast<const char*>(glGetString(GL_SHADING_LANGUAGE_VERSION));
    return version == nullptr ? std::string() : std::string(version);
}

auto GlDevice::SupportsParallelShaderCompile() -> bool
{
    GLint extensionCount{};
    glGetIntegerv(GL_NUM_EXTENSIONS, &extensionCount);
    for (GLint index = 0; index < extensionCount; index++)
    {
        const auto* extension = reinterpret_cast<const char*>(glGetStringi(GL_EXTENSIONS, static_cast<GLuint>(index)));
        if (extension == nullptr)
        {
            continue;
        }
        // WebGL reports it without the GL_ prefix through some bindings.
        const std::string name(extension);
        if (name == "GL_KHR_parallel_shader_compile" || name == "KHR_parallel_shader_compile" ||
            name == "GL_ARB_parallel_shader_compile")
        {
            return true;
        }
    }
    return false;
}

auto GlDevice::MaxTextureAnisotropy() -> float
{
#ifdef GL_EXT_texture_filter_anisotropic
    GLfloat maxAnisotropy = 0.0f;
    glGetFloatv(GL_MAX_TEXTURE_MAX_ANISOTROPY_EXT, &maxAnisotropy);
    return maxAnisotropy;
#else
    return 0.0f;
#endif
}

auto GlDevice::CreateTexture(const TextureDesc& desc, const void* data) -> TextureHandle
{
    GLuint texture{};
    glGenTextures(1, &texture);
    UpdateTexture({texture}, desc, data);
    return {texture};
}

void GlDevice::UpdateTexture(TextureHandle texture, const TextureDesc& desc, const void* data)
{
    const GLenum target = ToGl(desc.target);
    glBindTexture(target, texture.id);
    TexImage(target, desc, data);
    if (desc.sampling)
    {
        glTexParameteri(target, GL_TEXTURE_MIN_FILTER, ToGl(desc.sampling->filter));
        glTexParameteri(target, GL_TEXTURE_MAG_FILTER, ToGl(desc.sampling->filter));
        glTexParameteri(target, GL_TEXTURE_WRAP_S, ToGl(desc.sampling->wrap));
        glTexParameteri(target, GL_TEXTURE_WRAP_T, ToGl(desc.sampling->wrap));
    }
    glBindTexture(target, 0);
}

void GlDevice::DestroyTexture(TextureHandle texture)
{
    if (!texture.Valid())
    {
        return;
    }
    m_tracker.OnDestroyTexture(texture);
    glDeleteTextures(1, &texture.id);
}

auto GlDevice::CreateSampler(const TextureSampling& sampling) -> SamplerHandle
{
    GLuint sampler{};
    glGenSamplers(1, &sampler);
    glSamplerParameteri(sampler, GL_TEXTURE_MIN_FILTER, ToGl(sampling.filter));
    glSamplerParameteri(sampler, GL_TEXTURE_MAG_FILTER, ToGl(sampling.filter));
    glSamplerParameteri(sampler, GL_TEXTURE_WRAP_S, ToGl(sampling.wrap));
    glSamplerParameteri(sampler, GL_TEXTURE_WRAP_T, ToGl(sampling.wrap));
    return {sampler};
}

void GlDevice::SetSamplerFilter(SamplerHandle sampler, FilterMode filter)
{
    glSamplerParameteri(sampler.id, GL_TEXTURE_MIN_FILTER, ToGl(filter));
    glSamplerParameteri(sampler.id, GL_TEXTURE_MAG_FILTER, ToGl(filter));
}

void GlDevice::SetSamplerWrap(SamplerHandle sampler, WrapMode wrap)
{
    glSamplerParameteri(sampler.id, GL_TEXTURE_WRAP_S, ToGl(wrap));
    glSamplerParameteri(sampler.id, GL_TEXTURE_WRAP_T, ToGl(wrap));
}

void GlDevice::DestroySampler(SamplerHandle sampler)
{
    if (sampler.Valid())
    {
        glDeleteSamplers(1, &sampler.id);
    }
}

auto GlDevice::CreateBuffer() -> BufferHandle
{
    GLuint buffer{};
    glGenBuffers(1, &buffer);
    return {buffer};
}

void GlDevice::DestroyBuffer(BufferHandle buffer)
{
    if (buffer.Valid())
    {
        glDeleteBuffers(1, &buffer.id);
    }
}

void GlDevice::ReadBoundBuffer(BufferKind kind, size_t bytes, void* destination)
{
#if defined(__EMSCRIPTEN__)
    emscripten_glGetBufferSubData(ToGl(kind), 0, static_cast<GLsizeiptr>(bytes), destination);
#elif defined(USE_GLES)
    const void* mapped = glMapBufferRange(ToGl(kind), 0, static_cast<GLsizeiptr>(bytes), GL_MAP_READ_BIT);
    if (mapped != nullptr)
    {
        std::memcpy(destination, mapped, bytes);
        glUnmapBuffer(ToGl(kind));
    }
#else
    glGetBufferSubData(ToGl(kind), 0, static_cast<GLsizeiptr>(bytes), destination);
#endif
}

auto GlDevice::CreateVertexArray() -> VertexArrayHandle
{
    GLuint vertexArray{};
    glGenVertexArrays(1, &vertexArray);
    return {vertexArray};
}

void GlDevice::DestroyVertexArray(VertexArrayHandle vertexArray)
{
    if (vertexArray.Valid())
    {
        glDeleteVertexArrays(1, &vertexArray.id);
    }
}

auto GlDevice::CreateRenderTarget() -> RenderTargetHandle
{
    GLuint framebuffer{};
    glGenFramebuffers(1, &framebuffer);
    return {framebuffer};
}

void GlDevice::DestroyRenderTarget(RenderTargetHandle target)
{
    if (!target.Valid())
    {
        return;
    }
    m_tracker.OnDestroyRenderTarget(target);
    glDeleteFramebuffers(1, &target.id);
}

auto GlDevice::CreateProgram() -> ProgramHandle
{
    return {glCreateProgram()};
}

void GlDevice::DestroyProgram(ProgramHandle program)
{
    if (!program.Valid())
    {
        return;
    }
    m_tracker.OnDestroyProgram(program);
    glDeleteProgram(program.id);
}

auto GlDevice::BeginCompileProgram(ProgramHandle program,
                                   const std::string& vertexSource,
                                   const std::string& fragmentSource) -> PendingProgram
{
    // Issue everything without reading any status back: reading the compile or link
    // status is what makes the driver finish the work. With KHR_parallel_shader_compile
    // it then runs on driver threads, and IsProgramCompileComplete() can poll for it.
    PendingProgram pending;
    pending.vertexStage = CreateStage(GL_VERTEX_SHADER, vertexSource);
    pending.fragmentStage = CreateStage(GL_FRAGMENT_SHADER, fragmentSource);

    glAttachShader(program.id, pending.vertexStage);
    glAttachShader(program.id, pending.fragmentStage);

    glLinkProgram(program.id);
    return pending;
}

auto GlDevice::IsProgramCompileComplete(ProgramHandle program) -> bool
{
    GLint completed{GL_TRUE};
    glGetProgramiv(program.id, GL_COMPLETION_STATUS_KHR, &completed);
    return completed == GL_TRUE;
}

auto GlDevice::FinishCompileProgram(ProgramHandle program, const PendingProgram& pending) -> ProgramCompileResult
{
    ProgramCompileResult result;

    // Vertex stage first, as compiling synchronously reported it.
    if (StageCompileError(pending.vertexStage, result.log))
    {
        AbandonCompileProgram(program, pending);
        result.status = ProgramCompileResult::Status::VertexCompileFailed;
        return result;
    }
    if (StageCompileError(pending.fragmentStage, result.log))
    {
        AbandonCompileProgram(program, pending);
        result.status = ProgramCompileResult::Status::FragmentCompileFailed;
        return result;
    }

    // Shader objects are no longer needed after linking, free the memory.
    AbandonCompileProgram(program, pending);

    GLint programLinked{};
    glGetProgramiv(program.id, GL_LINK_STATUS, &programLinked);
    if (programLinked == GL_TRUE)
    {
        if (m_tracker.Enabled())
        {
            RegisterSamplerUniforms(program);
        }
        return result;
    }

    GLint infoLogLength{};
    glGetProgramiv(program.id, GL_INFO_LOG_LENGTH, &infoLogLength);
    std::vector<char> message(infoLogLength + 1);
    glGetProgramInfoLog(program.id, infoLogLength, nullptr, message.data());
    result.status = ProgramCompileResult::Status::LinkFailed;
    result.log = message.data();
    return result;
}

void GlDevice::AbandonCompileProgram(ProgramHandle program, const PendingProgram& pending)
{
    glDetachShader(program.id, pending.vertexStage);
    glDetachShader(program.id, pending.fragmentStage);
    glDeleteShader(pending.vertexStage);
    glDeleteShader(pending.fragmentStage);
}

auto GlDevice::ValidateProgram(ProgramHandle program, std::string& log) -> bool
{
    GLint result{GL_FALSE};
    int infoLogLength;

    glValidateProgram(program.id);

    glGetProgramiv(program.id, GL_VALIDATE_STATUS, &result);
    glGetProgramiv(program.id, GL_INFO_LOG_LENGTH, &infoLogLength);
    if (infoLogLength > 0)
    {
        std::vector<char> validationErrorMessage(infoLogLength + 1);
        glGetProgramInfoLog(program.id, infoLogLength, nullptr, validationErrorMessage.data());
        log = std::string(validationErrorMessage.data());
    }

    return result;
}

auto GlDevice::UniformLocation(ProgramHandle program, const char* name) -> int
{
    return glGetUniformLocation(program.id, name);
}

auto GlDevice::AttributeLocation(ProgramHandle program, const char* name) -> int
{
    return glGetAttribLocation(program.id, name);
}

auto GlDevice::CreateFence() -> FenceHandle
{
    return {reinterpret_cast<uintptr_t>(glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0))};
}

auto GlDevice::PollFence(FenceHandle fence) -> FenceStatus
{
    const GLenum result = glClientWaitSync(reinterpret_cast<GLsync>(fence.id), 0, 0); // NOLINT(performance-no-int-to-ptr): the handle stores the GLsync.
    if (result == GL_ALREADY_SIGNALED || result == GL_CONDITION_SATISFIED)
    {
        return FenceStatus::Signaled;
    }
    return result == GL_WAIT_FAILED ? FenceStatus::Failed : FenceStatus::Pending;
}

void GlDevice::DestroyFence(FenceHandle fence)
{
    if (fence.Valid())
    {
        glDeleteSync(reinterpret_cast<GLsync>(fence.id)); // NOLINT(performance-no-int-to-ptr): the handle stores the GLsync.
    }
}

void GlDevice::RegisterSamplerUniforms(ProgramHandle program)
{
    GLint uniformCount{};
    GLint maxNameLength{};
    glGetProgramiv(program.id, GL_ACTIVE_UNIFORMS, &uniformCount);
    glGetProgramiv(program.id, GL_ACTIVE_UNIFORM_MAX_LENGTH, &maxNameLength);
    std::vector<char> name(static_cast<size_t>(maxNameLength) + 1);
    std::vector<int> samplerLocations;
    for (GLint index = 0; index < uniformCount; index++)
    {
        GLsizei length{};
        GLint size{};
        GLenum type{};
        glGetActiveUniform(program.id, static_cast<GLuint>(index), maxNameLength, &length, &size, &type, name.data());
        if (!IsSamplerType(type))
        {
            continue;
        }
        const GLint location = glGetUniformLocation(program.id, name.data());
        for (GLint element = 0; location >= 0 && element < size; element++)
        {
            samplerLocations.push_back(location + element);
        }
    }
    m_tracker.OnProgramLinked(program, samplerLocations);
}

} // namespace Gl
} // namespace Device
} // namespace Renderer
} // namespace libprojectM
