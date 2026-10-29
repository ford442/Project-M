#include "Renderer/CopyTexture.hpp"
#include "Renderer/ShaderPrelude.hpp"

#include <algorithm>
#include <cstdlib>

namespace libprojectM {
namespace Renderer {

namespace {

/**
 * Ablation switch for benchmarking: setting PROJECTM_COPY_SHADER_PATH=1 restores the
 * pre-#179 behaviour where every texture copy is a fullscreen textured quad, so the
 * framebuffer blit path can be A/B'd against it on a single build.
 * See docs/GRAPHICS_PERF_RECOVERY_PLAN.md.
 */
auto BlitPathEnabled() -> bool
{
    static const bool enabled = []() {
        const char* const value = std::getenv("PROJECTM_COPY_SHADER_PATH");
        return !(value != nullptr && value[0] == '1');
    }();

    return enabled;
}

} // anonymous namespace

static constexpr char CopyTextureVertexShader[] = R"(
layout(location = 0) in vec2 position;
layout(location = 2) in vec2 tex_coord;

out vec2 fragment_tex_coord;

uniform mat4 vertex_transformation;

void main() {
    gl_Position = vec4(position, 0.0, 1.0) * vertex_transformation;
    fragment_tex_coord = tex_coord;
}
)";

static constexpr char CopyTextureFragmentShader[] = R"(
in vec2 fragment_tex_coord;

uniform sampler2D texture_sampler;
uniform int u_transparencyEnabled;
uniform float u_transparencyThreshold;

out vec4 color;

void main(){
    vec4 texColor = texture(texture_sampler, fragment_tex_coord);
    if (u_transparencyEnabled > 0) {
        // A preset's alpha channel is blend-mode leftovers, not coverage. Transparency
        // mode writes opaque pixels, or (0, 0, 0, 0) where it cuts one out: valid
        // premultiplied output, and the same pixels for straight alpha.
        float maxComponent = max(max(texColor.r, texColor.g), texColor.b);
        texColor = maxComponent < u_transparencyThreshold ? vec4(0.0) : vec4(texColor.rgb, 1.0);
    }
    color = texColor;
}

)";

CopyTexture::CopyTexture()
    : m_mesh(VertexBufferUsage::StaticDraw, false, true)
{
    m_framebuffer.CreateColorAttachment(0, 0);

    m_mesh.SetRenderPrimitiveType(Mesh::PrimitiveType::TriangleStrip);

    m_mesh.SetVertexCount(4);
    m_mesh.Vertices().Set({{-1.0, 1.0},
                           {1.0, 1.0},
                           {-1.0, -1.0},
                           {1.0, -1.0}});

    m_mesh.UVs().Set({{0.0, 1.0},
                      {1.0, 1.0},
                      {0.0, 0.0},
                      {1.0, 0.0}});

    m_mesh.Indices().Set({0, 1, 2, 3});

    m_mesh.Update();
}

CopyTexture::~CopyTexture()
{
    m_device->DestroyRenderTarget(m_blitReadFramebuffer);
    m_blitReadFramebuffer = {};
}

void CopyTexture::SetTransparencyMode(bool enabled)
{
    m_transparencyMode = enabled;
}

void CopyTexture::SetTransparencyThreshold(float threshold)
{
    m_transparencyThreshold = std::max(0.0f, threshold);
}

void CopyTexture::Draw(ShaderCache& shaderCache,
                       const std::shared_ptr<class Texture>& originalTexture,
                       bool flipVertical, bool flipHorizontal,
                       bool transparencyMode, float transparencyThreshold)
{
    if (originalTexture == nullptr)
    {
        return;
    }

    // Just bind the texture and draw it to the currently bound buffer.
    originalTexture->Bind(0);
    Copy(shaderCache, flipVertical, flipHorizontal, transparencyMode, transparencyThreshold);
}

void CopyTexture::Draw(ShaderCache& shaderCache,
                       const std::shared_ptr<class Texture>& originalTexture,
                       const std::shared_ptr<class Texture>& targetTexture,
                       bool flipVertical, bool flipHorizontal)
{
    if (originalTexture == nullptr ||
        originalTexture->Empty() ||
        (targetTexture != nullptr && targetTexture->Empty()) ||
        originalTexture == targetTexture)
    {
        return;
    }

    if (targetTexture == nullptr)
    {
        UpdateTextureSize(originalTexture->Width(), originalTexture->Height());
    }
    else
    {
        UpdateTextureSize(targetTexture->Width(), targetTexture->Height());
    }

    if (m_width == 0 || m_height == 0)
    {
        return;
    }

    m_framebuffer.Bind(0);

    // Plain copy into our own attachment: a hardware blit does the same work (including the
    // flip) without a shader quad. Only valid while the internal texture is the bound target.
    if (targetTexture == nullptr && TryBlit(originalTexture, flipVertical, flipHorizontal))
    {
        Framebuffer::Unbind();
        return;
    }

    std::shared_ptr<class Texture> internalTexture;

    // Draw from unflipped texture
    originalTexture->Bind(0);

    if (targetTexture)
    {
        internalTexture = m_framebuffer.GetColorAttachmentTexture(0, 0);
        m_framebuffer.GetAttachment(0, TextureAttachment::AttachmentType::Color, 0)->Texture(targetTexture);
    }

    Copy(shaderCache, flipVertical, flipHorizontal, false, 0.01f);

    // Rebind our internal texture.
    if (targetTexture)
    {
        m_framebuffer.GetAttachment(0, TextureAttachment::AttachmentType::Color, 0)->Texture(internalTexture);
    }

    Framebuffer::Unbind();
}

void CopyTexture::Draw(ShaderCache& shaderCache,
                       const std::shared_ptr<class Texture>& originalTexture,
                       Framebuffer& framebuffer, int framebufferIndex,
                       bool flipVertical, bool flipHorizontal)
{
    if (originalTexture == nullptr                                               //
        || originalTexture->Empty()                                              //
        || framebuffer.GetColorAttachmentTexture(framebufferIndex, 0) == nullptr //
        || framebuffer.GetColorAttachmentTexture(framebufferIndex, 0)->Empty())
    {
        return;
    }

    UpdateTextureSize(framebuffer.Width(), framebuffer.Height());

    if (m_width == 0 || m_height == 0)
    {
        return;
    }

    m_framebuffer.Bind(0);

    if (!TryBlit(originalTexture, flipVertical, flipHorizontal))
    {
        // Draw from unflipped texture
        originalTexture->Bind(0);

        Copy(shaderCache, flipVertical, flipHorizontal, false, 0.01f);
    }

    // Swap texture attachments
    auto tempAttachment = framebuffer.GetAttachment(framebufferIndex, TextureAttachment::AttachmentType::Color, 0);
    framebuffer.RemoveColorAttachment(framebufferIndex, 0);
    framebuffer.SetAttachment(framebufferIndex, 0, m_framebuffer.GetAttachment(0, TextureAttachment::AttachmentType::Color, 0));
    m_framebuffer.RemoveColorAttachment(0, 0);
    m_framebuffer.SetAttachment(0, 0, tempAttachment);

    Framebuffer::Unbind();
}

void CopyTexture::Draw(ShaderCache& shaderCache,
                       const std::shared_ptr<struct Texture>& originalTexture,
                       const std::shared_ptr<struct Texture>& targetTexture,
                       int left, int top, int width, int height)
{
    if (originalTexture == nullptr ||
        originalTexture->Empty() ||
        targetTexture == nullptr ||
        targetTexture->Empty() ||
        originalTexture == targetTexture)
    {
        return;
    }

    UpdateTextureSize(targetTexture->Width(), targetTexture->Height());

    if (m_width == 0 || m_height == 0)
    {
        return;
    }

    std::shared_ptr<class Texture> internalTexture;

    m_framebuffer.Bind(0);

    // Draw from original texture
    originalTexture->Bind(0);
    internalTexture = m_framebuffer.GetColorAttachmentTexture(0, 0);
    m_framebuffer.GetAttachment(0, TextureAttachment::AttachmentType::Color, 0)->Texture(targetTexture);

    Copy(shaderCache, left, top, width, height);

    // Rebind our internal texture.
    m_framebuffer.GetAttachment(0, TextureAttachment::AttachmentType::Color, 0)->Texture(internalTexture);

    Framebuffer::Unbind();
}

void CopyTexture::Draw(ShaderCache& shaderCache,
                       Device::TextureHandle originalTexture,
                       int viewportWidth, int viewportHeight,
                       int left, int top, int width, int height)
{
    if (!originalTexture.Valid())
    {
        return;
    }

    if (viewportWidth == 0 || viewportHeight == 0)
    {
        return;
    }

    int oldWidth = m_width;
    int oldHeight = m_height;

    m_width = viewportWidth;
    m_height = viewportHeight;

    // Draw from original texture
    m_device->Commands().BindTexture(0, Device::TextureTarget::Texture2D, originalTexture);
    Copy(shaderCache, left, top, width, height);

    m_width = oldWidth;
    m_height = oldHeight;
}

auto CopyTexture::Texture() -> std::shared_ptr<class Texture>
{
    return m_framebuffer.GetColorAttachmentTexture(0, 0);
}

void CopyTexture::UpdateTextureSize(int width, int height)
{
    if (m_width == width &&
        m_height == height)
    {
        return;
    }

    m_width = width;
    m_height = height;

    m_framebuffer.SetSize(m_width, m_height);
}

auto CopyTexture::TryBlit(const std::shared_ptr<class Texture>& originalTexture,
                          bool flipVertical, bool flipHorizontal) -> bool
{
    if (!BlitPathEnabled() || originalTexture == nullptr || originalTexture->Empty())
    {
        return false;
    }

    auto& commands = m_device->Commands();

    // A blit ignores blending (and the fragment shader entirely), so it is only
    // equivalent to the quad draw while blending is off.
    if (commands.IsEnabled(Device::Capability::Blend))
    {
        return false;
    }

    // The quad path is clipped by the viewport, the blit path is not. Only take the blit when
    // the viewport covers the whole destination, so both produce the same pixels.
    const auto viewport = commands.Viewport();

    if (viewport.x > 0 || viewport.y > 0 || viewport.width < m_width || viewport.height < m_height)
    {
        return false;
    }

    if (!m_blitReadFramebuffer.Valid())
    {
        m_blitReadFramebuffer = m_device->CreateRenderTarget();

        if (!m_blitReadFramebuffer.Valid())
        {
            return false;
        }
    }

    using Device::AttachmentPoint;
    using Device::TargetBinding;

    commands.BindRenderTarget(TargetBinding::Read, m_blitReadFramebuffer);
    commands.AttachTexture(TargetBinding::Read, AttachmentPoint::Color0, originalTexture->Handle());
    commands.SetReadBuffer(AttachmentPoint::Color0);

    // Not every color format a preset texture can carry is color-renderable, and only
    // color-renderable formats can be blitted from. Fall back if the driver disagrees.
    if (!commands.CheckRenderTarget(TargetBinding::Read).complete)
    {
        commands.AttachTexture(TargetBinding::Read, AttachmentPoint::Color0, {});
        // Restore the read binding the caller had (Bind() sets read and draw to the same FBO).
        m_framebuffer.Bind(0);
        return false;
    }

    const int sourceWidth = originalTexture->Width();
    const int sourceHeight = originalTexture->Height();

    // A flip is expressed by inverting the destination rectangle, which a blit
    // supports natively — no extra pass and no shader involved.
    const int destinationLeft = flipHorizontal ? m_width : 0;
    const int destinationRight = flipHorizontal ? 0 : m_width;
    const int destinationBottom = flipVertical ? m_height : 0;
    const int destinationTop = flipVertical ? 0 : m_height;

    commands.Blit({0, 0, sourceWidth, sourceHeight},
                  {destinationLeft, destinationBottom, destinationRight - destinationLeft, destinationTop - destinationBottom},
                  Device::FilterMode::Nearest);

    // Don't keep the source texture attached; it is owned by another framebuffer and may be
    // resized or deleted while this instance is idle.
    commands.AttachTexture(TargetBinding::Read, AttachmentPoint::Color0, {});
    m_framebuffer.Bind(0);

    return true;
}

void CopyTexture::Copy(ShaderCache& shaderCache,
                       bool flipVertical, bool flipHorizontal,
                       bool transparencyMode, float transparencyThreshold)
{
    glm::mat4x4 flipMatrix(1.0);

    flipMatrix[0][0] = flipHorizontal ? -1.0 : 1.0;
    flipMatrix[1][1] = flipVertical ? -1.0 : 1.0;

    std::shared_ptr<Shader> shader = BindShader(shaderCache);

    shader->SetUniformInt("texture_sampler", 0);
    shader->SetUniformInt("u_transparencyEnabled", transparencyMode ? 1 : 0);
    shader->SetUniformFloat("u_transparencyThreshold", transparencyThreshold);
    shader->SetUniformMat4x4("vertex_transformation", flipMatrix);

    m_sampler.Bind(0);

    m_mesh.Draw();

    m_device->Commands().BindTexture(0, Device::TextureTarget::Texture2D, {});
    Mesh::Unbind();
    Sampler::Unbind(0);
    Shader::Unbind();
}

void CopyTexture::Copy(ShaderCache& shaderCache,
                       int left, int top, int width, int height)
{
    glm::mat4x4 translationMatrix(1.0);
    translationMatrix[0][0] = static_cast<float>(width) / static_cast<float>(m_width);
    translationMatrix[1][1] = static_cast<float>(height) / static_cast<float>(m_height);

    translationMatrix[3][0] = static_cast<float>(left) / static_cast<float>(m_width);
    translationMatrix[3][1] = static_cast<float>(top) / static_cast<float>(m_height);

    std::shared_ptr<Shader> shader = BindShader(shaderCache);

    shader->SetUniformInt("texture_sampler", 0);
    shader->SetUniformInt("u_transparencyEnabled", 0);
    shader->SetUniformFloat("u_transparencyThreshold", 0.01f);
    shader->SetUniformMat4x4("vertex_transformation", translationMatrix);

    m_sampler.Bind(0);

    m_mesh.Draw();

    Mesh::Unbind();
    Sampler::Unbind(0);
    Shader::Unbind();
}

std::shared_ptr<Shader> CopyTexture::BindShader(ShaderCache& shaderCache)
{
    auto shader = m_shader.lock();

    if (!shader)
    {
        shader = shaderCache.Get("copy_texture");
    }

    if (!shader)
    {
        std::string vertexShader(kShaderPrelude);
        std::string fragmentShader(kShaderPrelude);
        vertexShader.append(CopyTextureVertexShader);
        fragmentShader.append(CopyTextureFragmentShader);

        shader = std::make_shared<Shader>();
        shader->CompileProgram(vertexShader, fragmentShader);

        m_shader = shader;
        shaderCache.Insert("copy_texture", shader);
    }

    shader->Bind();

    return shader;
}

} // namespace Renderer
} // namespace libprojectM
