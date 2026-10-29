/**
 * @file TextureAttachment.hpp
 * @brief Defines a class to hold a framebuffer texture attachment.
 */
#pragma once

#include "Renderer/Texture.hpp"

#include <memory>
#include <optional>

namespace libprojectM {
namespace Renderer {

/**
 * @brief Framebuffer texture attachment. Stores the texture and attachment type.
 */
class TextureAttachment
{
public:
    /**
     * Framebuffer attachment type this attachment is used for.
     */
    enum class AttachmentType
    {
        Color,       //!< Color texture attachment. Uses RGBA (RGBA16F with HDR, sRGB with an sRGB framebuffer).
        Depth,       //!< Depth buffer attachment. Uses 24-bit depth.
        Stencil,     //!< Stencil buffer attachment. Uses 8-bit stencil.
        DepthStencil //!< Depth stencil buffer attachment. Uses packed 24-bit depth + 8-bit stencil.
    };

    TextureAttachment() = delete;
    TextureAttachment(const TextureAttachment&) = delete;
    auto operator=(const TextureAttachment&) -> TextureAttachment& = delete;

    /**
     * @brief Creates a new texture attachment with the given type and size.
     * @param attachmentType The attachment type.
     * @param width The width of the texture in pixels.
     * @param height The height of the texture in pixels.
     */
    explicit TextureAttachment(AttachmentType attachmentType, int width, int height);

    /**
     * @brief Creates a new 2D color texture attachment with the given format and size.
     * Must have the same size as the framebuffer.
     * @param format The texture storage format, e.g. Device::TextureFormat::RGBA8
     * @param width The width of the texture in pixels.
     * @param height The height of the texture in pixels.
     */
    explicit TextureAttachment(Device::TextureFormat format, int width, int height);

    TextureAttachment(TextureAttachment&& other) = default;
    auto operator=(TextureAttachment&& other) -> TextureAttachment& = default;

    ~TextureAttachment() = default;

    /**
     * @brief Returns the attachment type.
     * @return The attachment type value.
     */
    auto Type() const -> AttachmentType;

    /**
     * @brief Returns the internal texture of this attachment.
     * @return The texture instance of this attachment.
     */
    auto Texture() const -> std::shared_ptr<class Texture>;

    /**
     * @brief Replaces the current internal texture with the given one.
     * Texture size is not changed.
     * @param texture
     */
    void Texture(const std::shared_ptr<class Texture>& texture);

    /**
     * @brief Sets a new texture size.
     * Effectively reallocates the texture.
     * @param width The new width.
     * @param height The new height.
     */
    void SetSize(int width, int height);

    /**
     * @brief The color format this attachment was created with, or nullopt for the build's
     *        default color format (RGBA, RGBA16F with HDR, sRGB with an sRGB framebuffer).
     */
    auto ColorFormat() const -> std::optional<Device::TextureFormat>;

private:
    /**
     * @brief Replaces the current texture with a new one, e.g. if the framebuffer was resized.
     * @param width The new texture width.
     * @param height The new texture height.
     */
    void ReplaceTexture(int width, int height);

    AttachmentType m_attachmentType{AttachmentType::Color};                      //!< Attachment type of this texture.
    std::shared_ptr<class Texture> m_texture{std::make_shared<class Texture>()}; //!< The texture.

    std::optional<Device::TextureFormat> m_colorFormat; //!< Color format, or the build's default color format if not set.
};

} // namespace Renderer
} // namespace libprojectM
