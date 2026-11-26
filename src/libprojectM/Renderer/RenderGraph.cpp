#include "RenderGraph.hpp"

#include "Renderer/Framebuffer.hpp"

#include <Logging.hpp>

#include <algorithm>

namespace libprojectM {
namespace Renderer {

RenderGraph::RenderGraph() = default;
RenderGraph::~RenderGraph() = default;

void RenderGraph::Reset()
{
    m_passCount = 0;
    m_resourceCount = 0;
    m_overflow = false;
    m_compiled = false;
}

auto RenderGraph::Import(const char* name, Device::RenderTargetHandle target) -> Resource
{
    if (m_resourceCount >= MaxResources)
    {
        m_overflow = true;
        return {};
    }
    auto& record = m_resources.at(m_resourceCount);
    record = {};
    record.name = name;
    record.imported = target;
    return {static_cast<uint8_t>(m_resourceCount++)};
}

auto RenderGraph::CreateTransient(const char* name, const TargetDesc& desc) -> Resource
{
    if (m_resourceCount >= MaxResources)
    {
        m_overflow = true;
        return {};
    }
    auto& record = m_resources.at(m_resourceCount);
    record = {};
    record.name = name;
    record.transient = true;
    record.desc = desc;
    return {static_cast<uint8_t>(m_resourceCount++)};
}

void RenderGraph::AddPass(const char* name, const PassDesc& desc, PassFunction function)
{
    if (m_passCount >= MaxPasses || desc.reads.size() > MaxPassResources || desc.writes.size() > MaxPassResources)
    {
        m_overflow = true;
        return;
    }
    auto& pass = m_passes.at(m_passCount++);
    pass = {};
    pass.name = name;
    pass.kind = desc.kind;
    pass.target = desc.target;
    pass.binding = desc.binding;
    pass.viewport = desc.viewport;
    pass.load = desc.load;
    pass.clearColor = desc.clearColor;
    // Resource{} in a list stands for "none" (an optional target this frame does not have).
    for (const auto read : desc.reads)
    {
        if (read.Valid())
        {
            pass.reads.at(pass.readCount++) = read;
        }
    }
    for (const auto write : desc.writes)
    {
        if (write.Valid())
        {
            pass.writes.at(pass.writeCount++) = write;
        }
    }
    pass.function = function;
}

auto RenderGraph::Fail(const std::string& message) -> bool
{
    if (message != m_lastError)
    {
        LOG_ERROR("[RenderGraph] " + message);
        m_lastError = message;
    }
    m_compiled = false;
    return false;
}

auto RenderGraph::Compile() -> bool
{
    m_compiled = false;
    if (m_overflow)
    {
        return Fail("frame exceeds the graph's limits (" + std::to_string(MaxPasses) + " passes, " + std::to_string(MaxResources) + " resources)");
    }

    const auto valid = [this](Resource resource) {
        return resource.Valid() && resource.index < m_resourceCount;
    };
    const auto touch = [this](Resource resource, int pass) {
        auto& record = m_resources.at(resource.index);
        if (record.firstUse < 0)
        {
            record.firstUse = pass;
        }
        record.lastUse = pass;
    };

    for (size_t index = 0; index < m_passCount; index++)
    {
        const auto& pass = m_passes.at(index);
        const int i = static_cast<int>(index);
        // Writes first: a pass may read what it writes itself (an encoder pass's own ping-pong).
        if (pass.kind == PassKind::Render)
        {
            if (!valid(pass.target))
            {
                return Fail(std::string("render pass ") + pass.name + " has no target");
            }
            touch(pass.target, i);
        }
        for (uint8_t w = 0; w < pass.writeCount; w++)
        {
            if (!valid(pass.writes.at(w)))
            {
                return Fail(std::string("pass ") + pass.name + " writes an unknown resource");
            }
            touch(pass.writes.at(w), i);
        }
        for (uint8_t r = 0; r < pass.readCount; r++)
        {
            const auto read = pass.reads.at(r);
            if (!valid(read))
            {
                return Fail(std::string("pass ") + pass.name + " reads an unknown resource");
            }
            const auto& record = m_resources.at(read.index);
            if (record.transient && record.firstUse < 0)
            {
                return Fail(std::string("pass ") + pass.name + " reads transient " + record.name + " before any pass writes it");
            }
            if (pass.kind == PassKind::Render && read == pass.target)
            {
                return Fail(std::string("render pass ") + pass.name + " samples its own target " + record.name);
            }
            touch(read, i);
        }
    }

    // Physical targets: transients in order of first use, each taking a pooled target of its size
    // and format that no transient still alive holds.
    for (auto& pooled : m_pool)
    {
        pooled.busyUntil = -1;
    }
    std::array<uint8_t, MaxResources> order{};
    size_t transientCount = 0;
    for (size_t index = 0; index < m_resourceCount; index++)
    {
        auto& record = m_resources.at(index);
        record.physical = -1;
        if (record.transient && record.firstUse >= 0)
        {
            order.at(transientCount++) = static_cast<uint8_t>(index);
        }
    }
    std::sort(order.begin(), order.begin() + static_cast<std::ptrdiff_t>(transientCount), [this](uint8_t lhs, uint8_t rhs) {
        return m_resources.at(lhs).firstUse < m_resources.at(rhs).firstUse;
    });
    std::array<bool, MaxResources * 2> used{};
    size_t physicalCount = 0;
    for (size_t i = 0; i < transientCount; i++)
    {
        auto& record = m_resources.at(order.at(i));
        record.physical = AcquirePhysical(record.desc, record.firstUse, record.lastUse);
        if (record.physical < 0)
        {
            return Fail(std::string("could not allocate transient ") + record.name);
        }
        if (static_cast<size_t>(record.physical) < used.size() && !used.at(static_cast<size_t>(record.physical)))
        {
            used.at(static_cast<size_t>(record.physical)) = true;
            physicalCount++;
        }
    }

    // Drop pooled targets of a size or format no transient has any more (a resize).
    for (size_t index = m_pool.size(); index-- > 0;)
    {
        const bool wanted = std::any_of(order.begin(), order.begin() + static_cast<std::ptrdiff_t>(transientCount), [&](uint8_t resource) {
            return m_resources.at(resource).desc == m_pool.at(index).desc;
        });
        if (!wanted)
        {
            m_pool.erase(m_pool.begin() + static_cast<std::ptrdiff_t>(index));
            for (size_t r = 0; r < m_resourceCount; r++)
            {
                if (m_resources.at(r).physical > static_cast<int>(index))
                {
                    m_resources.at(r).physical--;
                }
            }
        }
    }

    m_stats = {m_passCount, transientCount, physicalCount, m_pool.size()};
    m_compiled = true;
    return true;
}

auto RenderGraph::AcquirePhysical(const TargetDesc& desc, int firstUse, int lastUse) -> int
{
    for (size_t index = 0; index < m_pool.size(); index++)
    {
        auto& pooled = m_pool.at(index);
        if (pooled.desc == desc && pooled.busyUntil < firstUse)
        {
            pooled.busyUntil = lastUse;
            return static_cast<int>(index);
        }
    }
    if (desc.width <= 0 || desc.height <= 0)
    {
        return -1;
    }
    PooledTarget pooled;
    pooled.desc = desc;
    pooled.framebuffer = std::make_unique<Framebuffer>(1);
    pooled.framebuffer->CreateColorAttachment(0, 0, desc.format);
    pooled.framebuffer->SetSize(desc.width, desc.height);
    pooled.busyUntil = lastUse;
    m_pool.push_back(std::move(pooled));
    return static_cast<int>(m_pool.size() - 1);
}

void RenderGraph::Execute(Device::ICommandList& commands)
{
    if (!m_compiled)
    {
        return;
    }
    PassContext context(*this);
    for (size_t index = 0; index < m_passCount; index++)
    {
        const auto& pass = m_passes.at(index);
        if (pass.kind == PassKind::Encoder)
        {
            pass.function(context);
            continue;
        }

        const auto& target = m_resources.at(pass.target.index);
        Device::RenderPassDesc renderPass;
        renderPass.target = context.Target(pass.target);
        renderPass.binding = pass.binding;
        renderPass.viewport = pass.viewport;
        if (!renderPass.viewport && target.transient)
        {
            renderPass.viewport = Device::Rect{0, 0, target.desc.width, target.desc.height};
        }
        renderPass.load = pass.load;
        renderPass.clearColor = pass.clearColor;
        // Nothing reads a transient after its last pass.
        renderPass.store = target.transient && target.lastUse == static_cast<int>(index) ? Device::StoreOp::Discard : Device::StoreOp::Store;
        renderPass.label = pass.name;
        commands.BeginRenderPass(renderPass);
        pass.function(context);
        commands.EndRenderPass();
    }
}

auto RenderGraph::PassContext::Target(Resource resource) const -> Device::RenderTargetHandle
{
    if (!resource.Valid() || resource.index >= m_graph.m_resourceCount)
    {
        return {};
    }
    const auto& record = m_graph.m_resources.at(resource.index);
    if (!record.transient)
    {
        return record.imported;
    }
    auto* framebuffer = Transient(resource);
    return framebuffer != nullptr ? framebuffer->Target(0) : Device::RenderTargetHandle{};
}

auto RenderGraph::PassContext::Transient(Resource resource) const -> Framebuffer*
{
    if (!resource.Valid() || resource.index >= m_graph.m_resourceCount)
    {
        return nullptr;
    }
    const auto& record = m_graph.m_resources.at(resource.index);
    if (!record.transient || record.physical < 0 || static_cast<size_t>(record.physical) >= m_graph.m_pool.size())
    {
        return nullptr;
    }
    return m_graph.m_pool.at(static_cast<size_t>(record.physical)).framebuffer.get();
}

auto RenderGraph::PassName(size_t index) const -> const char*
{
    return index < m_passCount ? m_passes.at(index).name : nullptr;
}

auto RenderGraph::Describe() const -> std::string
{
    const auto name = [this](Resource resource) {
        if (!resource.Valid() || resource.index >= m_resourceCount)
        {
            return std::string("?");
        }
        const auto& record = m_resources.at(resource.index);
        std::string text = record.name;
        if (record.transient)
        {
            text += "@" + std::to_string(record.physical);
        }
        return text;
    };
    std::string text;
    for (size_t index = 0; index < m_passCount; index++)
    {
        const auto& pass = m_passes.at(index);
        text += pass.kind == PassKind::Render ? "render  " : "encoder ";
        text += pass.name;
        if (pass.kind == PassKind::Render)
        {
            text += " -> " + name(pass.target);
            if (pass.load == Device::LoadOp::Clear)
            {
                text += " (clear)";
            }
        }
        for (uint8_t r = 0; r < pass.readCount; r++)
        {
            text += (r == 0 ? " reads " : ", ") + name(pass.reads.at(r));
        }
        for (uint8_t w = 0; w < pass.writeCount; w++)
        {
            text += (w == 0 ? " writes " : ", ") + name(pass.writes.at(w));
        }
        text += "\n";
    }
    return text;
}

} // namespace Renderer
} // namespace libprojectM
