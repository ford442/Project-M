#include "Renderer/UniformBlocks.hpp"

#include <EngineContext.hpp>

namespace libprojectM {
namespace Renderer {

UniformBlockWriter::~UniformBlockWriter() = default;

UniformBlockWriter::UniformBlockWriter(UniformBlockWriter&&) noexcept = default;

auto UniformBlockWriter::operator=(UniformBlockWriter&&) noexcept -> UniformBlockWriter& = default;

auto UniformBlockWriter::Ring() -> UniformRingBuffer&
{
    if (auto* engineRing = EngineContext::Current().UniformRing())
    {
        return *engineRing;
    }
    if (!m_ownRing)
    {
        m_ownRing = std::make_unique<UniformRingBuffer>(Device::Current(), OwnRingCapacity);
    }
    return *m_ownRing;
}

} // namespace Renderer
} // namespace libprojectM
