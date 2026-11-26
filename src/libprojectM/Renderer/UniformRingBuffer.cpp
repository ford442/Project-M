#include "UniformRingBuffer.hpp"

#include <Logging.hpp>

#include <string>

namespace libprojectM {
namespace Renderer {

namespace {
auto AlignUp(size_t value, size_t alignment) -> size_t
{
    return (value + alignment - 1) / alignment * alignment;
}
} // namespace

UniformRingBuffer::UniformRingBuffer(size_t capacity)
    : m_device(&Device::Current())
    , m_capacity(capacity)
{
}

UniformRingBuffer::~UniformRingBuffer()
{
    m_device->DestroyBuffer(m_buffer);
}

void UniformRingBuffer::BeginFrame()
{
    m_frameBytes = 0;
}

void UniformRingBuffer::Allocate(size_t capacity)
{
    m_device->DestroyBuffer(m_buffer);
    m_capacity = capacity;
    m_buffer = m_device->CreateUniformBuffer(m_capacity);
    m_head = 0;
    m_allocations++;
}

auto UniformRingBuffer::Write(const void* data, size_t bytes) -> Range
{
    if (m_alignment == 0)
    {
        m_alignment = m_device->UniformBufferOffsetAlignment();
    }
    const size_t slotBytes = AlignUp(bytes, m_alignment);

    // Wrapping skips the tail; it counts against the frame, so a frame's ranges never overlap.
    const bool wraps = m_head + slotBytes > m_capacity;
    const size_t wrapBytes = wraps ? m_capacity - m_head : 0;
    if (!m_buffer.Valid() || m_frameBytes + wrapBytes + slotBytes > m_capacity)
    {
        // Room for twice what this frame has needed so far, so the next frames fit.
        const size_t needed = m_buffer.Valid() ? 2 * (m_frameBytes + slotBytes) : slotBytes;
        size_t capacity = m_capacity;
        while (capacity < needed)
        {
            capacity *= 2;
        }
        if (m_buffer.Valid())
        {
            LOG_DEBUG("[UniformRingBuffer] A frame needs more than " + std::to_string(m_capacity) + " bytes; growing to " + std::to_string(capacity));
        }
        // The new buffer holds none of this frame's earlier ranges, so it starts empty.
        Allocate(capacity);
        m_frameBytes = 0;
    }
    else if (wraps)
    {
        m_head = 0;
        m_frameBytes += wrapBytes;
    }

    Range range{m_buffer, m_head, bytes};
    m_device->WriteBuffer(m_buffer, m_head, data, bytes);
    m_head += slotBytes;
    m_frameBytes += slotBytes;
    return range;
}

auto UniformRingBuffer::WriteAndBind(int slot, const void* data, size_t bytes) -> Range
{
    const Range range = Write(data, bytes);
    m_device->Commands().BindUniformBuffer(slot, range.buffer, range.offset, range.size);
    return range;
}

} // namespace Renderer
} // namespace libprojectM
