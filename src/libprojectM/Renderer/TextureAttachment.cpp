#include "Renderer/TextureAttachment.hpp"

namespace libprojectM {
namespace Renderer {

TextureAttachment::TextureAttachment(AttachmentType attachment, int width, int height)
    : m_attachmentType(attachment)
{
    if (width > 0 && height > 0)
    {
        ReplaceTexture(width, height);
    }
}

TextureAttachment::TextureAttachment(Device::TextureFormat format, int width, int height)
    : m_attachmentType(AttachmentType::Color)
    , m_colorFormat(format)
{
    if (width > 0 && height > 0)
    {
        ReplaceTexture(width, height);
    }
}

auto TextureAttachment::Type() const -> TextureAttachment::AttachmentType
{
    return m_attachmentType;
}

auto TextureAttachment::ColorFormat() const -> std::optional<Device::TextureFormat>
{
    return m_colorFormat;
}

auto TextureAttachment::Texture() const -> std::shared_ptr<class Texture>
{
    return m_texture;
}

void TextureAttachment::Texture(const std::shared_ptr<class Texture>& texture)
{
    m_texture = texture;
}

void TextureAttachment::SetSize(int width, int height)
{
    if (width > 0 && height > 0)
    {
        ReplaceTexture(width, height);
    }
    else
    {
        m_texture = std::make_unique<class Texture>();
    }
}

void TextureAttachment::ReplaceTexture(int width, int height)
{
    Device::TextureDesc desc;

    // Don't replace if size hasn't changed
    if (m_texture->Width() == width && m_texture->Height() == height)
    {
        return;
    }

    switch(m_attachmentType)
    {
        case AttachmentType::Color:
            if (m_colorFormat)
            {
                desc.format = *m_colorFormat;
            }
            else
            {
#ifdef PROJECTM_HDR_RENDERING
                desc.format = Device::TextureFormat::RGBA16F;
#elif defined(PROJECTM_SRGB_FRAMEBUFFER)
                desc.format = Device::TextureFormat::SRGB8Alpha8;
#else
                desc.format = Device::TextureFormat::RGBA;
#endif
            }
            break;
        case AttachmentType::Depth:
            desc.format = Device::TextureFormat::Depth24;
            break;
        case AttachmentType::Stencil:
            desc.format = Device::TextureFormat::Stencil8;
            break;
        case AttachmentType::DepthStencil:
            desc.format = Device::TextureFormat::Depth24Stencil8;
            break;

        default:
            return;
    }

    m_texture.reset();

    desc.target = Device::TextureTarget::Texture2D;
    desc.width = width;
    desc.height = height;
    desc.sampling = Device::TextureSampling{Device::FilterMode::Nearest, Device::WrapMode::ClampToEdge};

    auto& device = Device::Current();
    const auto texture = device.CreateTexture(desc, nullptr);

    m_texture = std::make_shared<class Texture>("", texture, Device::TextureTarget::Texture2D, width, height, false);
}

} // namespace Renderer
} // namespace libprojectM
