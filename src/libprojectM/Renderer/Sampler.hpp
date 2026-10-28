/**
* @file Sampler.hpp
* @brief Defines a class to hold a texture sampling descriptor.
*/
#pragma once

#include <Renderer/Device/RenderDevice.hpp>

#include <memory>

namespace libprojectM {
namespace Renderer {

/**
 * @brief Stores a single texture sampler.
 *
 * A sampler is used to provide information about how to wrap and filter texels
 * when sampling them from shaders. One texture can have several samplers with
 * different modes.
 *
 * Currently, each texture has its own sampler instances. It also uses the same filter mode
 * for min and max. As projectM doesn't use mipmaps yet it makes no real difference.
 */
class Sampler
{
public:
    using Ptr = std::shared_ptr<Sampler>;

    Sampler() = delete;
    Sampler(const Sampler&) = delete;
    auto operator=(const Sampler&) -> Sampler& = delete;

    /**
     * @brief Constructor. Creates a new sampler with the given modes.
     * @param wrapMode
     * @param filterMode
     */
    Sampler(Device::WrapMode wrapMode, Device::FilterMode filterMode);

    Sampler(Sampler&& other) = default;
    auto operator=(Sampler&& other) -> Sampler& = default;

    ~Sampler();

    /**
     * @brief Binds the sampler to the given texture unit.
     * @param unit The texture unit to bind the current sampler to.
     */
    void Bind(int unit) const;

    /**
     * @brief Unbinds a previously bound sampler from the given texture unit.
     * @param unit The texture unit to unbind the sampler from.
     */
    static void Unbind(int unit);

    /**
     * @brief Returns the sampler wrap mode.
     * @return The sampler texture wrap mode.
     */
    auto WrapMode() const -> Device::WrapMode;

    /**
     * @brief Sets a new wrap mode for this sampler.
     * @param wrapMode the new wrap mode.
     */
    void WrapMode(Device::WrapMode wrapMode);

    /**
     * @brief Returns the sampler filter mode.
     * @return The sampler filter mode.
     */
    auto FilterMode() const -> Device::FilterMode;

    /**
     * @brief Sets a new filter mode for this sampler.
     * @param filterMode the new filter mode.
     */
    void FilterMode(Device::FilterMode filterMode);

private:
    Device::IRenderDevice* m_device{&Device::Current()}; //!< The device that owns the sampler.
    Device::SamplerHandle m_sampler;                      //!< The sampler object.
    Device::WrapMode m_wrapMode{};                        //!< The texture wrap mode.
    Device::FilterMode m_filterMode{};                    //!< The texture filtering mode.
};

} // namespace Renderer
} // namespace libprojectM
