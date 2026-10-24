#include "Renderer/Texture.hpp"

#include <utility>

namespace libprojectM {
namespace Renderer {

Texture::Texture(std::string name, const int width, const int height, const bool isUserTexture)
    : m_name(std::move(name))
    , m_isUserTexture(isUserTexture)
{
    m_desc.target = Device::TextureTarget::Texture2D;
    m_desc.width = width;
    m_desc.height = height;
    m_desc.format = Device::TextureFormat::RGB;
    CreateNewTexture();
}

Texture::Texture(std::string name, Device::TextureTarget target, int width, int height, int depth,
                 Device::TextureFormat format, bool isUserTexture)
    : m_name(std::move(name))
    , m_isUserTexture(isUserTexture)
{
    m_desc.target = target;
    m_desc.width = width;
    m_desc.height = height;
    m_desc.depth = depth;
    m_desc.format = format;
    CreateNewTexture();
}

Texture::Texture(std::string name, const Device::TextureHandle texture, const Device::TextureTarget target,
                 const int width, const int height, const bool isUserTexture, const bool owned)
    : m_texture(texture)
    , m_name(std::move(name))
    , m_isUserTexture(isUserTexture)
    , m_owned(owned)
{
    m_desc.target = target;
    m_desc.width = width;
    m_desc.height = height;
}

Texture::Texture(std::string name, const void* data, Device::TextureTarget target, int width, int height, int depth,
                 Device::TextureFormat format, bool isUserTexture, Device::PixelOrder dataOrder)
    : m_name(std::move(name))
    , m_isUserTexture(isUserTexture)
{
    m_desc.target = target;
    m_desc.width = width;
    m_desc.height = height;
    m_desc.depth = depth;
    m_desc.format = format;
    m_desc.dataOrder = dataOrder;
    m_texture = m_device->CreateTexture(m_desc, data);
}

Texture::~Texture()
{
    if (m_texture.Valid() && m_owned)
    {
        m_device->DestroyTexture(m_texture);
        m_texture = {};
    }
}

void Texture::Bind(int slot, const Sampler::Ptr& sampler) const
{
    m_device->Commands().BindTexture(slot, m_desc.target, m_texture);

    if (sampler)
    {
        sampler->Bind(slot);
    }
}

void Texture::Unbind(int slot) const
{
    m_device->Commands().BindTexture(slot, m_desc.target, {});
}

auto Texture::Handle() const noexcept -> Device::TextureHandle
{
    return m_texture;
}

auto Texture::TextureID() const noexcept -> uint32_t
{
    return m_texture.id;
}

auto Texture::Name() const noexcept -> const std::string&
{
    return m_name;
}

auto Texture::Type() const noexcept -> Device::TextureTarget
{
    return m_desc.target;
}

auto Texture::Width() const noexcept -> int
{
    return m_desc.width;
}

auto Texture::Height() const noexcept -> int
{
    return m_desc.height;
}

auto Texture::Depth() const noexcept -> int
{
    return m_desc.depth;
}

auto Texture::IsUserTexture() const noexcept -> bool
{
    return m_isUserTexture;
}

auto Texture::Empty() const noexcept -> bool
{
    return !m_texture.Valid();
}

void Texture::Update(const void* data) const
{
    m_device->UpdateTexture(m_texture, m_desc, data);
}

void Texture::Replace(const void* data, int width, int height)
{
    m_desc.width = width;
    m_desc.height = height;
    // The device re-specifies the whole image, so a new size reuses the same texture name.
    m_device->UpdateTexture(m_texture, m_desc, data);
}

void Texture::CreateNewTexture()
{
    m_texture = m_device->CreateTexture(m_desc, nullptr);
}

} // namespace Renderer
} // namespace libprojectM
