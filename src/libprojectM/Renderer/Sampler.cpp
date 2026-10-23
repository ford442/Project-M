#include "Sampler.hpp"

namespace libprojectM {
namespace Renderer {

Sampler::Sampler(const Device::WrapMode wrapMode, const Device::FilterMode filterMode)
    : m_wrapMode(wrapMode)
    , m_filterMode(filterMode)
{
    m_sampler = m_device->CreateSampler({filterMode, wrapMode});
}


Sampler::~Sampler()
{
    m_device->DestroySampler(m_sampler);
}

void Sampler::Bind(int unit) const
{
    m_device->Commands().BindSampler(unit, m_sampler);
}

void Sampler::Unbind(int unit)
{
    Device::Commands().BindSampler(unit, {});
}

auto Sampler::WrapMode() const -> Device::WrapMode
{
    return m_wrapMode;
}

void Sampler::WrapMode(Device::WrapMode wrapMode)
{
    if (wrapMode == m_wrapMode)
    {
        return;
    }

    m_wrapMode = wrapMode;

    m_device->SetSamplerWrap(m_sampler, wrapMode);
}

auto Sampler::FilterMode() const -> Device::FilterMode
{
    return m_filterMode;
}

void Sampler::FilterMode(Device::FilterMode filterMode)
{
    if (filterMode == m_filterMode)
    {
        return;
    }

    m_filterMode = filterMode;

    m_device->SetSamplerFilter(m_sampler, filterMode);
}

} // namespace Renderer
} // namespace libprojectM
