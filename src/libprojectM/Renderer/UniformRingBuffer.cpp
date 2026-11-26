#include "UniformRingBuffer.hpp"

#include <Logging.hpp>

#include <cstring>
#include <string>

namespace libprojectM {
namespace Renderer {

namespace {
auto AlignUp(size_t value, size_t alignment) -> size_t
{
    return (value + alignment - 1) / alignment * alignment;
}
} // namespace

UniformRingBuffer::UniformRingBuffer(Device::IRenderDevice& device, size_t capacity)
    : m_device(&device)
    , m_capacity(capacity)
{
}

UniformRingBuffer::UniformRingBuffer(size_t capacity)
    : UniformRingBuffer(Device::Current(), capacity)
{
}

UniformRingBuffer::~UniformRingBuffer()
{
    m_device->DestroyBuffer(m_buffer);
}

void UniformRingBuffer::BeginFrame()
{
    m_frameBytes = 0;
    m_framed = true;
    m_lastRange = {};
}

void UniformRingBuffer::Allocate(size_t capacity)
{
    m_device->DestroyBuffer(m_buffer);
    m_capacity = capacity;
    m_buffer = m_device->CreateUniformBuffer(m_capacity);
    m_head = 0;
    m_allocations++;
    m_lastRange = {};
}

auto UniformRingBuffer::Write(const void* data, size_t bytes) -> Range
{
    if (m_alignment == 0)
    {
        m_alignment = m_device->UniformBufferOffsetAlignment();
    }
    if (m_lastRange.buffer.Valid() && m_lastRange.size == bytes && std::memcmp(m_lastBytes.data(), data, bytes) == 0)
    {
        m_reusedWrites++;
        return m_lastRange;
    }

    const size_t slotBytes = AlignUp(bytes, m_alignment);

    // Wrapping skips the tail; it counts against the frame, so a frame's ranges never overlap.
    const bool wraps = m_head + slotBytes > m_capacity;
    const size_t wrapBytes = wraps ? m_capacity - m_head : 0;
    if (!m_framed && m_buffer.Valid() && slotBytes <= m_capacity && m_frameBytes + wrapBytes + slotBytes > m_capacity)
    {
        // No frames to keep apart (see BeginFrame()): start over instead of growing.
        m_frameBytes = 0;
    }
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

    const auto* first = static_cast<const uint8_t*>(data);
    m_lastBytes.assign(first, first + bytes);
    m_lastRange = range;
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
