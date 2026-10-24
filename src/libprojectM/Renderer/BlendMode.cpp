#include "Renderer/BlendMode.hpp"

namespace libprojectM {
namespace Renderer {

void BlendMode::Set(bool enable, Function srcFunc, Function dstFunc)
{
    SetBlendActive(enable);
    SetBlendFunction(srcFunc, dstFunc);
}

void BlendMode::SetBlendActive(bool enable)
{
    Device::Commands().SetEnabled(Device::Capability::Blend, enable);
}

void BlendMode::SetBlendFunction(Function srcFunc, Function dstFunc)
{
    Device::Commands().SetBlendFunction(srcFunc, dstFunc);
}

} // namespace Renderer
} // namespace libprojectM
