#include "Renderer/Device/RenderDevice.hpp"

#include "Renderer/Device/Gl/GlDevice.hpp"

namespace libprojectM {
namespace Renderer {
namespace Device {

namespace {

thread_local IRenderDevice* t_currentDevice{nullptr};

auto DefaultDevice() -> IRenderDevice&
{
    // Never destroyed: resource wrappers held by static objects may still release their
    // handles during static destruction.
    static auto* const device = new Gl::GlDevice();
    return *device;
}

} // anonymous namespace

auto Current() -> IRenderDevice&
{
    return t_currentDevice != nullptr ? *t_currentDevice : DefaultDevice();
}

ScopedDevice::ScopedDevice(IRenderDevice& device)
    : m_previous(t_currentDevice)
{
    t_currentDevice = &device;
}

ScopedDevice::~ScopedDevice()
{
    t_currentDevice = m_previous;
}

} // namespace Device
} // namespace Renderer
} // namespace libprojectM
