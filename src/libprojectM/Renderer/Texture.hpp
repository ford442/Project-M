/**
* @file Texture.hpp
* @brief Defines a class to hold a GPU texture.
*/
#pragma once

#include "Renderer/Sampler.hpp"

#include <string>

namespace libprojectM {
namespace Renderer {

/**
 * @brief Stores a texture in the GPU and manages a few properties and the samplers.
 *
 * This object will take ownership of a single texture and manage the samplers for use in shaders.
 */
class Texture
{
public:
    Texture(const Texture&) = delete;
    auto operator=(const Texture&) -> Texture& = delete;

    /**
     * @brief Constructor. Creates an empty texture with zero size.
     */
    Texture() = default;

    /**
     * @brief Constructor. Allocates a new, empty texture with the given size.
     * @param name Optional name of the texture for referencing in Milkdrop shaders.
     * @param width Width in pixels.
     * @param height Height in pixels.
     * @param isUserTexture true if the texture is an externally-loaded image, false if it's an internal texture.
     */
    explicit Texture(std::string name, int width, int height, bool isUserTexture);

    /**
     * @brief Constructor. Allocates a new, empty texture with the given size and format.
     * @param name Optional name of the texture for referencing in Milkdrop shaders.
     * @param target The texture target, 2D or 3D.
     * @param width Width in pixels.
     * @param height Height in pixels.
     * @param depth Depth in pixels (for 3D textures).
     * @param format Storage format.
     * @param isUserTexture true if the texture is an externally-loaded image, false if it's an internal texture.
     */
    explicit Texture(std::string name, Device::TextureTarget target, int width, int height, int depth,
                     Device::TextureFormat format, bool isUserTexture);

    /**
     * @brief Constructor. Creates a new texture instance from an existing device texture.
     * @param name Optional name of the texture for referencing in Milkdrop shaders.
     * @param texture The texture (on the GL backend, a host's GL texture name is a valid handle).
     * @param target The texture target type.
     * @param width Width in pixels.
     * @param height Height in pixels.
     * @param isUserTexture true if the texture is an externally-loaded image, false if it's an internal texture.
     * @param owned If true (default), the class takes ownership and will delete the texture when destroyed.
     *              If false, the texture is managed externally and won't be deleted.
     */
    explicit Texture(std::string name, Device::TextureHandle texture, Device::TextureTarget target,
                     int width, int height,
                     bool isUserTexture, bool owned = true);

    /**
     * @brief Constructor. Creates a new texture from image data with the given size and format.
     * @param name Optional name of the texture for referencing in Milkdrop shaders.
     * @param data The texture data to upload, in the format's layout.
     * @param target The texture target, 2D or 3D.
     * @param width Width in pixels.
     * @param height Height in pixels.
     * @param depth Depth in pixels (for 3D textures).
     * @param format Storage format.
     * @param isUserTexture true if the texture is an externally-loaded image, false if it's an internal texture.
     * @param dataOrder Channel order of @a data.
     */
    explicit Texture(std::string name, const void* data, Device::TextureTarget target, int width, int height, int depth,
                     Device::TextureFormat format, bool isUserTexture,
                     Device::PixelOrder dataOrder = Device::PixelOrder::Rgba);

    Texture(Texture&& other) = default;
    auto operator=(Texture&& other) -> Texture& = default;

    ~Texture();

    /**
     * @brief Binds the texture to the given texture unit.
     * Also resets the last used counter to zero.
     * @param slot The texture unit to bind the texture to.
     * @param sampler An optional sampler to bind in the same slot.
     */
    void Bind(int slot, const Sampler::Ptr& sampler = nullptr) const;

    /**
     * Unbinds the texture to the given texture unit.
     * @param slot The texture unit to unbind the texture from.
     */
    void Unbind(int slot) const;

    /**
     * @brief Returns the device texture.
     * @return The texture handle, invalid if the texture is empty.
     */
    auto Handle() const noexcept -> Device::TextureHandle;

    /**
     * @brief Returns the backend's texture id (on the GL backend, the GL texture name).
     * @return The texture id, 0 if the texture is empty.
     */
    auto TextureID() const noexcept -> uint32_t;

    /**
     * @brief Returns the texture name, e.g. base filename.
     * @return The texture name, for referencing the texture in shader code etc.
     */
    auto Name() const noexcept -> const std::string&;

    /**
     * @brief Returns the texture target.
     * @return The texture target, 2D or 3D.
     */
    auto Type() const noexcept -> Device::TextureTarget;

    /**
     * @brief Returns the width of the texture image in pixels.
     * @return The width of the texture image in pixels.
     */
    auto Width() const noexcept -> int;

    /**
     * @brief Returns the height of the texture image in pixels.
     * @return The height of the texture image in pixels.
     */
    auto Height() const noexcept -> int;

    /**
     * @brief Returns the depth of the texture image in pixels.
     * @return The depth of the texture image in pixels.
     */
    auto Depth() const noexcept -> int;

    /**
     * @brief Returns if the texture is user-defined, e.g. loaded from an image.
     * @return true if the texture is a user texture, false if it's an internally generated texture.
     */
    auto IsUserTexture() const noexcept -> bool;

    /**
     * @brief Returns true if the texture is empty/unallocated.
     * @return true if the texture is not yet allocated (e.g. the ID 0), false if the object contains a valid texture.
     */
    auto Empty() const noexcept -> bool;

    /**
     * @brief Uploads new image data for the texture.
     * @note Automatically binds and unbinds the texture.
     * @param data The new texture image data. Must match the size and format used to create the texture.
     */
    void Update(const void* data) const;

    /**
     * @brief Replaces the image with one of a possibly different size, keeping the device texture.
     *
     * Everything holding this texture (preset sampler descriptors, sprites) samples the new
     * image from the next draw on, without being told. Only for textures this object owns.
     *
     * @param data The new image data, in the texture's format.
     * @param width The new width in pixels.
     * @param height The new height in pixels.
     */
    void Replace(const void* data, int width, int height);

private:
    /**
     * @brief Creates a new, blank texture with the given size.
     */
    void CreateNewTexture();

    Device::IRenderDevice* m_device{&Device::Current()}; //!< The device that owns the texture.
    Device::TextureHandle m_texture;                      //!< The texture.
    Device::TextureDesc m_desc;                           //!< Target, size and format.

    std::string m_name;          //!< The texture name for identifying it in shaders.
    bool m_isUserTexture{false}; //!< true if it's a user texture, false if an internal one.
    bool m_owned{true};          //!< true if this class owns the texture and should delete it.
};

} // namespace Renderer
} // namespace libprojectM
