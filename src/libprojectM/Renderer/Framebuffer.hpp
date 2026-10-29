/**
* @file Framebuffer.hpp
* @brief Defines a class to hold one or more render framebuffers.
*/
#pragma once

#include "Renderer/TextureAttachment.hpp"

#include <map>
#include <memory>
#include <set>
#include <atomic>
#include <vector>

namespace libprojectM {
namespace Renderer {

/**
 * @brief A framebuffer class holding one or more framebuffer objects.
 *
 * <p>Framebuffers act as both render targets and sampling sources. This class holds one or more of those
 * objects, either used to store current and previous frame images or sub images for multi-stage
 * rendering.</p>
 *
 * <p>Each framebuffer can have multiple color attachments (at least up to 8), one depth buffer,
 * one stencil buffer and one depth stencil buffer.</p>
 *
 * <p>All framebuffers and their attachments will share the same size.</p>
 *
 * <p>Draw buffers will be configured in this order for each framebuffer:</p>
 *
 * <ol>
 * <li>Color attachments in ascending order</li>
 * <li>Depth</li>
 * <li>Stencil</li>
 * <li>Depth Stencil</li>
 * </ol>
 */
class Framebuffer
{
public:
    /**
     * @brief Who owns the storage of an attachment set via SetAttachment().
     */
    enum class AttachmentStorage
    {
        Owned,   //!< The framebuffer owns the texture; SetSize() reallocates it.
        External //!< The caller owns the texture; SetSize() never reallocates or re-points it.
    };

    /**
     * @brief Creates a new framebuffer object with one framebuffer.
     */
    Framebuffer();

    /**
     * @brief Creates a new framebuffer object with a given number of framebuffers.
     * @param framebufferCount The number of framebuffers to create. Must be at least 1.
     */
    explicit Framebuffer(int framebufferCount);

    /**
     * @brief Destroys the framebuffer object and all attachments.
     */
    ~Framebuffer();

    /**
     * @brief Returns the number of framebuffers in this object.
     * @return The number of framebuffers in this object.
     */
    int Count() const;

    /**
     * @brief Binds the given index as the current read/write framebuffer.
     * @param framebufferIndex The framebuffer index.
     */
    void Bind(int framebufferIndex);

    /**
     * @brief Binds the given index as the current read framebuffer.
     * @param framebufferIndex The framebuffer index.
     */
    void BindRead(int framebufferIndex);

    /**
     * @brief Binds the given index as the current write/draw framebuffer.
     * @param framebufferIndex The framebuffer index.
     */
    void BindDraw(int framebufferIndex);

    /**
     * @brief Binds the default framebuffer for both reading and writing.
     */
    static void Unbind();

    /**
     * @brief Sets the framebuffer texture size.
     *
     * This will bind the framebuffers and reallocate all owned attachment textures, creating new
     * textures with the given size. Attachments set with AttachmentStorage::External are left
     * untouched: their texture object, size and attachment binding stay exactly as the caller
     * set them, so a caller holding that texture (e.g. as a named sampler or render target) keeps
     * a valid handle. The caller is responsible for resizing and re-attaching external textures.
     * The default framebuffer is bound after the call is finished.
     * If either width or height is zero or both equal the the current size, the framebuffer contents
     * won't be changed.
     * @param width The width of the framebuffer.
     * @param height The height of the framebuffer.
     * @return true if the framebuffer was resized, false if it's contents remain unchanged.
     */
    auto SetSize(int width, int height) -> bool;

    /**
     * Returns the width in pixels of the framebuffer.
     * @return The horizontal resolution.
     */
    auto Width() const -> int;

    /**
     * Returns the height in pixels of the framebuffer.
     * @return the vertical resolution.
     */
    auto Height() const -> int;

    /**
     * @brief Returns a texture attachment object.
     * @param framebufferIndex The framebuffer index.
     * @param type The attachment type to retrieve.
     * @param attachmentIndex The index of the color attachment, at least indices 0-7 are guaranteed
     *                        to be available. Ignored for non-color attachments.
     * @return The requested attachment or nullptr if there is no attachment in the requested slot.
     */
    auto GetAttachment(int framebufferIndex, TextureAttachment::AttachmentType type, int attachmentIndex = 0) const -> std::shared_ptr<TextureAttachment>;

    /**
     * @brief Sets a texture attachment slot to the given object.
     * Insert-or-assign: re-attaching to an occupied slot replaces the tracked attachment, so
     * GetAttachment() / GetColorAttachmentTexture() always match what the render target has attached.
     * Sets the read/write FBOs to the previously used ones in this instance. If a different
     * Framebuffer instance was used to read or draw, it must be bound again explicitly after this call.
     * @note The texture is only attached while the framebuffer has a non-zero size.
     * @param framebufferIndex The framebuffer index.
     * @param attachmentIndex The index of the color attachment, at least indices 0-7 are guaranteed
     *                        to be available. Ignored for non-color attachments.
     * @param attachment The attachment to add to the framebuffer.
     * @param storage Owned (default) lets SetSize() reallocate the texture. External marks it as
     *                caller-managed so SetSize() skips it. The flag is per slot and is reset by
     *                the next SetAttachment(), Create*Attachment() or Remove*Attachment() call.
     */
    void SetAttachment(int framebufferIndex, int attachmentIndex, const std::shared_ptr<TextureAttachment>& attachment,
                       AttachmentStorage storage = AttachmentStorage::Owned);

    /**
     * @brief Adds a new color attachment to the framebuffer.
     * The texture is always created in RGBA format.
     * @param framebufferIndex The framebuffer index.
     * @param attachmentIndex The index of the attachment, at least indices 0-7 are guaranteed to be available.
     */
    void CreateColorAttachment(int framebufferIndex, int attachmentIndex);

    /**
     * @brief Adds a new color attachment to the framebuffer with the specified format.
     * @param framebufferIndex The framebuffer index.
     * @param index The index of the attachment, at least indices 0-7 are guaranteed to be available.
     * @param format The texture storage format, e.g. Device::TextureFormat::RGBA8
     */
    void CreateColorAttachment(int framebufferIndex, int attachmentIndex, Device::TextureFormat format);

    /**
     * Removes the color attachment from the given slot, if there is any assigned.
     * Sets the read/write FBOs to the previously used ones in this instance. If a different
     * Framebuffer instance was used to read or draw, it must be bound again explicitly after this call.
     * @param framebufferIndex The framebuffer index.
     * @param attachmentIndex The index of the attachment to remove, at least indices 0-7 are guaranteed to be available.
     */
    void RemoveColorAttachment(int framebufferIndex, int attachmentIndex);

    /**
     * @brief Returns the texture ID of the given framebuffer and color attachment.
     * @param framebufferIndex The framebuffer index.
     * @param attachmentIndex The index of the attachment to return the texture for.
     * @return A shared pointer to the texture or nullptr if no texture is assigned.
     */
    auto GetColorAttachmentTexture(int framebufferIndex, int attachmentIndex) const -> std::shared_ptr<class Texture>;

    /**
     * @brief Adds a depth attachment to the framebuffer.
     * @param framebufferIndex The framebuffer index.
     */
    void CreateDepthAttachment(int framebufferIndex);

    /**
     * @brief Removes the depth attachment from the given framebuffer, if there is any assigned.
     * Sets the read/write FBOs to the previously used ones in this instance. If a different
     * Framebuffer instance was used to read or draw, it must be bound again explicitly after this call.
     * @param framebufferIndex The framebuffer index.
     */
    void RemoveDepthAttachment(int framebufferIndex);

    /**
     * @brief Adds a stencil buffer attachment to the framebuffer.
     * @param framebufferIndex The framebuffer index.
     */
    void CreateStencilAttachment(int framebufferIndex);

    /**
     * @brief Removes the stencil attachment from the given framebuffer, if there is any assigned.
     * Sets the read/write FBOs to the previously used ones in this instance. If a different
     * Framebuffer instance was used to read or draw, it must be bound again explicitly after this call.
     * @param framebufferIndex The framebuffer index.
     */
    void RemoveStencilAttachment(int framebufferIndex);

    /**
     * @brief Adds a depth stencil buffer attachment to the framebuffer.
     * @param framebufferIndex The framebuffer index.
     */
    void CreateDepthStencilAttachment(int framebufferIndex);

    /**
     * @brief Removes the depth stencil attachment from the given framebuffer, if there is any assigned.
     * Sets the read/write FBOs to the previously used ones in this instance. If a different
     * Framebuffer instance was used to read or draw, it must be bound again explicitly after this call.
     * @param framebufferIndex The framebuffer index.
     */
    void RemoveDepthStencilAttachment(int framebufferIndex);

    /**
     * @brief Sets the masked flag for a specific draw buffer.
     * This can be used to enable or disable rendering to specific color attachments.
     * With GLES 3.1 and lower, this will always mask all buffers.
     * @param bufferIndex The index of the buffer to set the mask flag on.
     * @param masked true if the attachment should be masked, false if not.
     */
    void MaskDrawBuffer(int bufferIndex, bool masked);

    /**
     * @brief Returns the render target of the given framebuffer.
     * @param framebufferIndex The framebuffer index.
     * @return The render target handle, or an invalid handle if the index is out of range.
     */
    auto Target(int framebufferIndex) const -> Device::RenderTargetHandle;

    /**
     * @brief Returns the number of live Framebuffer instances.
     *
     * Intended for unit tests that verify FBO lifecycle during rapid transitions.
     */
    static auto LiveInstanceCount() -> int;

private:
    static std::atomic<int> s_liveInstanceCount;
    /**
     * @brief Updates the draw buffer list for the fragment shader outputs of the given framebuffer.
     * Note that when calling this function, the framebuffer must already be bound.
     * @param framebufferIndex The framebuffer index.
     */
    void UpdateDrawBuffers(int framebufferIndex);

    /**
     * @brief Checks the framebuffer's completeness once its attachments are allocated, and
     *        replaces owned color attachments the driver cannot render to with RGBA8 ones
     *        (logging a warning). Leaves the framebuffer bound to ReadDraw.
     * @param framebufferIndex The framebuffer index.
     */
    void EnsureComplete(int framebufferIndex);

    /**
     * @brief Removes the given attachment type from the framebuffer.
     * @param framebufferIndex The framebuffer index.
     * @param attachmentType The attachment type to remove.
     */
    void RemoveAttachment(int framebufferIndex, Device::AttachmentPoint attachmentType);

    /**
     * @brief Creates an owned attachment, attaches it and updates the draw buffers.
     * @param framebufferIndex The framebuffer index.
     * @param point The attachment slot.
     * @param textureAttachment The new attachment.
     */
    void AddOwnedAttachment(int framebufferIndex, Device::AttachmentPoint point, std::shared_ptr<TextureAttachment> textureAttachment);

    using AttachmentsPerSlot = std::map<Device::AttachmentPoint, std::shared_ptr<TextureAttachment>>;
    Device::IRenderDevice* m_device{&Device::Current()}; //!< The device that owns the render targets.
    std::vector<Device::RenderTargetHandle> m_framebufferIds{}; //!< The render targets, one per framebuffer index.
    std::map<int, AttachmentsPerSlot> m_attachments; //!< Framebuffer texture attachments.
    std::map<int, std::set<Device::AttachmentPoint>> m_externalAttachments; //!< Slots set with AttachmentStorage::External, skipped by SetSize().

    int m_width{}; //!< Framebuffers texture width
    int m_height{}; //!< Framebuffers texture height.

    int m_readFramebuffer{}; //!< Index of the framebuffer currently being read.
    int m_drawFramebuffer{}; //!< Index of the framebuffer currently being drawn to.
};

} // namespace Renderer
} // namespace libprojectM
