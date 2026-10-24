#pragma once

#include "Renderer/Device/RenderDevice.hpp"

namespace libprojectM {
namespace Renderer {

/**
 * @brief Wraps a vertex array object.
 * Creates, destroys and binds a single VAO.
 */
class VertexArray
{
public:
    /**
     * Constructor. Creates a new VAO.
     */
    VertexArray()
        : m_vaoID(m_device->CreateVertexArray())
    {
    }

    /**
     * Destructor. Deletes the stored VAO.
     */
    virtual ~VertexArray()
    {
        m_device->DestroyVertexArray(m_vaoID);
        m_vaoID = {};
    }

    /**
     * Binds the stored VAO.
     */
    void Bind() const
    {
        m_device->Commands().BindVertexArray(m_vaoID);
    }

    /**
     * Binds the default VAO with ID 0.
     */
    static void Unbind()
    {
        Device::Commands().BindVertexArray({});
    }

private:
    Device::IRenderDevice* m_device{&Device::Current()}; //!< The device that owns the VAO.
    Device::VertexArrayHandle m_vaoID; //!< The vertex array object for this mesh's vertex data.

};


} // namespace Renderer
} // namespace libprojectM
