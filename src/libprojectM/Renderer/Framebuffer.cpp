#include "Renderer/Framebuffer.hpp"

#include <atomic>

namespace libprojectM {
namespace Renderer {

std::atomic<int> Framebuffer::s_liveInstanceCount{0};

namespace {

using Device::AttachmentPoint;
using Device::TargetBinding;

auto AttachmentPointFor(TextureAttachment::AttachmentType type, int attachmentIndex) -> AttachmentPoint
{
    switch (type)
    {
        case TextureAttachment::AttachmentType::Color:
            break;
        case TextureAttachment::AttachmentType::Depth:
            return AttachmentPoint::Depth;
        case TextureAttachment::AttachmentType::Stencil:
            return AttachmentPoint::Stencil;
        case TextureAttachment::AttachmentType::DepthStencil:
            return AttachmentPoint::DepthStencil;
    }
    return Device::ColorAttachment(attachmentIndex);
}

} // anonymous namespace

Framebuffer::Framebuffer()
    : Framebuffer(1)
{
}

Framebuffer::Framebuffer(int framebufferCount)
{
    ++s_liveInstanceCount;
    m_framebufferIds.resize(framebufferCount);
    for (int index = 0; index < framebufferCount; index++)
    {
        m_framebufferIds[index] = m_device->CreateRenderTarget();
        m_attachments.emplace(index, AttachmentsPerSlot());
    }
}

Framebuffer::~Framebuffer()
{
    --s_liveInstanceCount;
    if (!m_framebufferIds.empty())
    {
        // Delete FBOs first — this also releases driver references to attached textures.
        for (const auto framebuffer : m_framebufferIds)
        {
            m_device->DestroyRenderTarget(framebuffer);
        }
        m_framebufferIds.clear();

        m_attachments.clear();
    }
}

auto Framebuffer::Count() const -> int
{
    return static_cast<int>(m_framebufferIds.size());
}

auto Framebuffer::LiveInstanceCount() -> int
{
    return s_liveInstanceCount.load();
}

auto Framebuffer::Target(int framebufferIndex) const -> Device::RenderTargetHandle
{
    if (framebufferIndex < 0 || framebufferIndex >= static_cast<int>(m_framebufferIds.size()))
    {
        return {};
    }

    return m_framebufferIds.at(framebufferIndex);
}

void Framebuffer::Bind(int framebufferIndex)
{
    if (framebufferIndex < 0 || framebufferIndex >= static_cast<int>(m_framebufferIds.size()))
    {
        return;
    }

    m_device->Commands().BindRenderTarget(TargetBinding::ReadDraw, m_framebufferIds.at(framebufferIndex));

#ifdef PROJECTM_SRGB_FRAMEBUFFER
    m_device->Commands().SetEnabled(Device::Capability::FramebufferSrgb, true);
#endif

    m_readFramebuffer = m_drawFramebuffer = framebufferIndex;
}

void Framebuffer::BindRead(int framebufferIndex)
{
    if (framebufferIndex < 0 || framebufferIndex >= static_cast<int>(m_framebufferIds.size()))
    {
        return;
    }

    m_device->Commands().BindRenderTarget(TargetBinding::Read, m_framebufferIds.at(framebufferIndex));

    m_readFramebuffer = framebufferIndex;
}

void Framebuffer::BindDraw(int framebufferIndex)
{
    if (framebufferIndex < 0 || framebufferIndex >= static_cast<int>(m_framebufferIds.size()))
    {
        return;
    }

    m_device->Commands().BindRenderTarget(TargetBinding::Draw, m_framebufferIds.at(framebufferIndex));

    m_drawFramebuffer = framebufferIndex;
}

void Framebuffer::Unbind()
{
    auto& commands = Device::Commands();
#ifdef PROJECTM_SRGB_FRAMEBUFFER
    commands.SetEnabled(Device::Capability::FramebufferSrgb, false);
#endif
    commands.BindRenderTarget(TargetBinding::Draw, {});
}

bool Framebuffer::SetSize(int width, int height)
{
    if (width == 0 || height == 0 ||
        (width == m_width && height == m_height))
    {
        return false;
    }

    m_width = width;
    m_height = height;

    auto& commands = m_device->Commands();
    for (auto& attachments : m_attachments)
    {
        Bind(attachments.first);
        const auto& externalSlots = m_externalAttachments[attachments.first];
        for (auto& texture : attachments.second)
        {
            if (externalSlots.count(texture.first) != 0)
            {
                // Caller-managed storage: never reallocate or re-point it here.
                continue;
            }
            // Detach old texture, resize (destroys old and creates new), reattach new.
            commands.AttachTexture(TargetBinding::ReadDraw, texture.first, {});
            texture.second->SetSize(width, height);
            commands.AttachTexture(TargetBinding::ReadDraw, texture.first, texture.second->Texture()->Handle());
        }
    }
    commands.BindRenderTarget(TargetBinding::ReadDraw, {});

    return true;
}

auto Framebuffer::Width() const -> int
{
    return m_width;
}

auto Framebuffer::Height() const -> int
{
    return m_height;
}

auto Framebuffer::GetAttachment(int framebufferIndex, TextureAttachment::AttachmentType type, int attachmentIndex) const -> std::shared_ptr<TextureAttachment>
{
    if (framebufferIndex < 0 || framebufferIndex >= static_cast<int>(m_framebufferIds.size()))
    {
        return {};
    }

    const auto& framebufferAttachments = m_attachments.at(framebufferIndex);
    const auto textureType = AttachmentPointFor(type, attachmentIndex);

    if (framebufferAttachments.find(textureType) == framebufferAttachments.end()) {
        return {};
    }

    return framebufferAttachments.at(textureType);
}

void Framebuffer::SetAttachment(int framebufferIndex, int attachmentIndex, const std::shared_ptr<TextureAttachment>& attachment,
                                AttachmentStorage storage)
{
    if (!attachment)
    {
        return;
    }

    if (framebufferIndex < 0 || framebufferIndex >= static_cast<int>(m_framebufferIds.size()))
    {
        return;
    }

    const auto textureType = AttachmentPointFor(attachment->Type(), attachmentIndex);

    // insert_or_assign, not insert: re-attaching to an existing slot must replace the
    // tracked attachment, otherwise the render target and m_attachments disagree and
    // GetColorAttachmentTexture() keeps returning the previous texture.
    m_attachments.at(framebufferIndex).insert_or_assign(textureType, attachment);
    if (storage == AttachmentStorage::External)
    {
        m_externalAttachments[framebufferIndex].insert(textureType);
    }
    else
    {
        m_externalAttachments[framebufferIndex].erase(textureType);
    }

    auto& commands = m_device->Commands();
    commands.BindRenderTarget(TargetBinding::ReadDraw, m_framebufferIds.at(framebufferIndex));

    if (m_width > 0 && m_height > 0)
    {
        commands.AttachTexture(TargetBinding::ReadDraw, textureType, attachment->Texture()->Handle());
    }
    UpdateDrawBuffers(framebufferIndex);

    // Reset to previous read/draw buffers
    commands.BindRenderTarget(TargetBinding::Read, m_framebufferIds.at(m_readFramebuffer));
    commands.BindRenderTarget(TargetBinding::Draw, m_framebufferIds.at(m_drawFramebuffer));
}

void Framebuffer::CreateColorAttachment(int framebufferIndex, int attachmentIndex)
{
    CreateColorAttachment(framebufferIndex, attachmentIndex, Device::TextureFormat::RGBA);
}

void Framebuffer::CreateColorAttachment(int framebufferIndex, int attachmentIndex, Device::TextureFormat format)
{
    if (framebufferIndex < 0 || framebufferIndex >= static_cast<int>(m_framebufferIds.size()))
    {
        return;
    }

    AddOwnedAttachment(framebufferIndex, Device::ColorAttachment(attachmentIndex),
                       std::make_shared<TextureAttachment>(format, m_width, m_height));
}

void Framebuffer::RemoveColorAttachment(int framebufferIndex, int attachmentIndex)
{
    RemoveAttachment(framebufferIndex, Device::ColorAttachment(attachmentIndex));
}

auto Framebuffer::GetColorAttachmentTexture(int framebufferIndex, int attachmentIndex) const -> std::shared_ptr<class Texture>
{
    if (framebufferIndex < 0 || framebufferIndex >= static_cast<int>(m_framebufferIds.size()))
    {
        return {};
    }

    const auto& attachment = m_attachments.at(framebufferIndex);
    const auto point = Device::ColorAttachment(attachmentIndex);
    if (attachment.find(point) == attachment.end())
    {
        return {};
    }

    return attachment.at(point)->Texture();
}

void Framebuffer::CreateDepthAttachment(int framebufferIndex)
{
    if (framebufferIndex < 0 || framebufferIndex >= static_cast<int>(m_framebufferIds.size()))
    {
        return;
    }

    AddOwnedAttachment(framebufferIndex, AttachmentPoint::Depth,
                       std::make_shared<TextureAttachment>(TextureAttachment::AttachmentType::Depth, m_width, m_height));
}

void Framebuffer::RemoveDepthAttachment(int framebufferIndex)
{
    RemoveAttachment(framebufferIndex, AttachmentPoint::Depth);
}

void Framebuffer::CreateStencilAttachment(int framebufferIndex)
{
    if (framebufferIndex < 0 || framebufferIndex >= static_cast<int>(m_framebufferIds.size()))
    {
        return;
    }

    AddOwnedAttachment(framebufferIndex, AttachmentPoint::Stencil,
                       std::make_shared<TextureAttachment>(TextureAttachment::AttachmentType::Stencil, m_width, m_height));
}

void Framebuffer::RemoveStencilAttachment(int framebufferIndex)
{
    RemoveAttachment(framebufferIndex, AttachmentPoint::Stencil);
}

void Framebuffer::CreateDepthStencilAttachment(int framebufferIndex)
{
    if (framebufferIndex < 0 || framebufferIndex >= static_cast<int>(m_framebufferIds.size()))
    {
        return;
    }

    AddOwnedAttachment(framebufferIndex, AttachmentPoint::DepthStencil,
                       std::make_shared<TextureAttachment>(TextureAttachment::AttachmentType::DepthStencil, m_width, m_height));
}

void Framebuffer::RemoveDepthStencilAttachment(int framebufferIndex)
{
    RemoveAttachment(framebufferIndex, AttachmentPoint::DepthStencil);
}

void Framebuffer::MaskDrawBuffer(int bufferIndex, bool masked)
{
    // Invert the flag, as "true" means the color channel *will* be written.
    m_device->Commands().SetDrawBufferWriteMask(bufferIndex, !masked);
}

void Framebuffer::AddOwnedAttachment(int framebufferIndex, AttachmentPoint point, std::shared_ptr<TextureAttachment> textureAttachment)
{
    const auto texture = textureAttachment->Texture();
    m_attachments.at(framebufferIndex).insert_or_assign(point, std::move(textureAttachment));
    m_externalAttachments[framebufferIndex].erase(point);

    Bind(framebufferIndex);
    auto& commands = m_device->Commands();
    if (m_width > 0 && m_height > 0)
    {
        commands.AttachTexture(TargetBinding::ReadDraw, point, texture->Handle());
    }
    UpdateDrawBuffers(framebufferIndex);
    commands.BindRenderTarget(TargetBinding::ReadDraw, {});
}

void Framebuffer::UpdateDrawBuffers(int framebufferIndex)
{
    if (framebufferIndex < 0 || framebufferIndex >= static_cast<int>(m_framebufferIds.size()))
    {
        return;
    }

    const auto& attachments = m_attachments.at(framebufferIndex);

    std::vector<AttachmentPoint> buffers;

    bool hasDepthAttachment = false;
    bool hasStencilAttachment = false;
    bool hasDepthStencilAttachment = false;

    for (const auto& attachment : attachments)
    {
        switch (attachment.first)
        {
            case AttachmentPoint::Depth:
                hasDepthAttachment = true;
                break;
            case AttachmentPoint::Stencil:
                hasStencilAttachment = true;
                break;
            case AttachmentPoint::DepthStencil:
                hasDepthStencilAttachment = true;
                break;
            default:
                buffers.push_back(attachment.first);
                break;
        }
    }

    if (hasDepthAttachment)
    {
        buffers.push_back(AttachmentPoint::Depth);
    }
    if (hasStencilAttachment)
    {
        buffers.push_back(AttachmentPoint::Stencil);
    }
    if (hasDepthStencilAttachment)
    {
        buffers.push_back(AttachmentPoint::DepthStencil);
    }

    m_device->Commands().SetDrawBuffers(buffers);
}

void Framebuffer::RemoveAttachment(int framebufferIndex, AttachmentPoint attachmentType)
{
    if (framebufferIndex < 0 || framebufferIndex >= static_cast<int>(m_framebufferIds.size()))
    {
        return;
    }

    auto& commands = m_device->Commands();
    commands.BindRenderTarget(TargetBinding::ReadDraw, m_framebufferIds.at(framebufferIndex));

    commands.AttachTexture(TargetBinding::ReadDraw, attachmentType, {});
    UpdateDrawBuffers(framebufferIndex);

    m_attachments.at(framebufferIndex).erase(attachmentType);
    m_externalAttachments[framebufferIndex].erase(attachmentType);

    // Reset to previous read/draw buffers
    commands.BindRenderTarget(TargetBinding::Read, m_framebufferIds.at(m_readFramebuffer));
    commands.BindRenderTarget(TargetBinding::Draw, m_framebufferIds.at(m_drawFramebuffer));
}

} // namespace Renderer
} // namespace libprojectM
