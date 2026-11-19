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
    // Someone else (the host, another engine) may have used the context since this device last did.
    device.Commands().InvalidateState();
}

ScopedDevice::~ScopedDevice()
{
    auto& leaving = Current();
    t_currentDevice = m_previous;
    // The device we hand back to cannot know what the engine changed.
    auto& resumed = Current();
    if (&resumed != &leaving)
    {
        resumed.Commands().InvalidateState();
    }
}

auto Hash(const PipelineDesc& desc) -> size_t
{
    // FNV-1a over the fields, not the bytes: padding is indeterminate.
    uint64_t hash = 0xcbf29ce484222325ULL;
    const auto add = [&hash](uint64_t value) {
        for (int byte = 0; byte < 8; ++byte)
        {
            hash ^= (value >> (byte * 8)) & 0xFFU;
            hash *= 0x100000001b3ULL;
        }
    };
    const auto addBlend = [&add](const BlendState& blend) {
        add(blend.enabled);
        add(static_cast<uint64_t>(blend.function.sourceColor) | static_cast<uint64_t>(blend.function.destinationColor) << 8U |
            static_cast<uint64_t>(blend.function.sourceAlpha) << 16U | static_cast<uint64_t>(blend.function.destinationAlpha) << 24U);
    };

    add(desc.shader.id);
    add(static_cast<uint64_t>(desc.topology));
    add(desc.vertexLayout.attributeCount);
    for (int i = 0; i < desc.vertexLayout.attributeCount; ++i)
    {
        const auto& attribute = desc.vertexLayout.attributes.at(i);
        add(attribute.location | attribute.components << 8U | attribute.buffer << 16U);
        add(attribute.offset);
    }
    add(desc.vertexLayout.bufferCount);
    for (int i = 0; i < desc.vertexLayout.bufferCount; ++i)
    {
        add(desc.vertexLayout.strides.at(i));
    }
    add(desc.raster.cullEnabled | desc.raster.lineSmooth << 1U |
        static_cast<uint64_t>(desc.raster.frontFace) << 8U | static_cast<uint64_t>(desc.raster.cullFace) << 16U);
    add(desc.depthStencil.depthTest | desc.depthStencil.depthWrite << 1U);
    add(desc.targetCount);
    for (const auto& target : desc.targets)
    {
        add(static_cast<uint64_t>(target.format) | target.writeRed << 8U | target.writeGreen << 9U |
            target.writeBlue << 10U | target.writeAlpha << 11U);
        addBlend(target.blend);
    }
    return static_cast<size_t>(hash);
}

} // namespace Device
} // namespace Renderer
} // namespace libprojectM
