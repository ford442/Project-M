/**
 * @file UniformRingBuffer.hpp
 * @brief One uniform buffer that per-draw uniform blocks are sub-allocated from, round-robin.
 *
 * WebGPU-shaped: each draw's block is written to its own aligned range (WebGPU's dynamic
 * offsets) instead of being uploaded into the program, and nothing is allocated per frame.
 * See docs/RENDER_DEVICE.md "Uniform buffers".
 */
#pragma once

#include "Renderer/Device/RenderDevice.hpp"

#include <cstddef>

namespace libprojectM {
namespace Renderer {

class UniformRingBuffer
{
public:
    /**
     * @brief A written range: bind it with ICommandList::BindUniformBuffer().
     */
    struct Range {
        Device::BufferHandle buffer;
        size_t offset{};
        size_t size{};
    };

    static constexpr size_t DefaultCapacity = 64 * 1024;

    /**
     * @brief Uses the current device; the GPU buffer is created on the first Write().
     */
    explicit UniformRingBuffer(size_t capacity = DefaultCapacity);
    ~UniformRingBuffer();

    UniformRingBuffer(const UniformRingBuffer&) = delete;
    auto operator=(const UniformRingBuffer&) -> UniformRingBuffer& = delete;
    UniformRingBuffer(UniformRingBuffer&&) = delete;
    auto operator=(UniformRingBuffer&&) -> UniformRingBuffer& = delete;

    /**
     * @brief Starts a frame. Ranges written in one frame never overlap: a frame that needs more
     *        than the capacity grows the buffer (once; the next frames reuse it).
     */
    void BeginFrame();

    /**
     * @brief Copies @a bytes of @a data into the next free aligned range.
     */
    auto Write(const void* data, size_t bytes) -> Range;

    /**
     * @brief Writes @a data and binds its range to uniform block slot @a slot.
     */
    auto WriteAndBind(int slot, const void* data, size_t bytes) -> Range;

    [[nodiscard]] auto Capacity() const -> size_t
    {
        return m_capacity;
    }

    /**
     * @brief Bytes the current frame has written, alignment padding included.
     */
    [[nodiscard]] auto FrameBytes() const -> size_t
    {
        return m_frameBytes;
    }

    /**
     * @brief How often the buffer had to be (re)created: 1 after the first write, more only if
     *        a frame outgrew it.
     */
    [[nodiscard]] auto Allocations() const -> size_t
    {
        return m_allocations;
    }

private:
    void Allocate(size_t capacity);

    Device::IRenderDevice* m_device;
    Device::BufferHandle m_buffer;
    size_t m_capacity;
    size_t m_alignment{};
    size_t m_head{};       //!< Next write position.
    size_t m_frameBytes{}; //!< Written since BeginFrame().
    size_t m_allocations{};
};

} // namespace Renderer
} // namespace libprojectM
