/**
 * @file RenderGraph.hpp
 * @brief A frame declared as passes with the targets they read and write (B2).
 *
 * The frame is built every frame: imported (persistent) targets and transient ones, render
 * passes the graph begins and ends, and encoder passes (copies and blits, or helpers that run
 * render passes of their own). Compile() checks the declarations and gives each transient a
 * physical target from the graph's pool, sharing one between transients whose lifetimes do not
 * overlap; Execute() runs the passes in order. Variants of the frame (the copy paths) are
 * different declarations, not branches inside a pass.
 *
 * Nothing allocates once the pool holds the targets a preset needs: passes and resources live in
 * fixed arrays, names are static strings and pass functions are references to callables that
 * outlive Execute(). See docs/RENDER_DEVICE.md "Render graph".
 */
#pragma once

#include "Renderer/Device/RenderDevice.hpp"

#include <array>
#include <cstdint>
#include <initializer_list>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace libprojectM {
namespace Renderer {

class Framebuffer;
class Texture;

class RenderGraph
{
public:
    static constexpr size_t MaxPasses = 48;
    static constexpr size_t MaxResources = 24;
    static constexpr size_t MaxPassResources = 8; //!< Reads (and writes) per pass.

    /**
     * @brief A target the graph knows by index. Invalid until returned by Import*() or CreateTransient().
     */
    struct Resource {
        uint8_t index{0xff};

        [[nodiscard]] constexpr auto Valid() const -> bool
        {
            return index != 0xff;
        }

        friend constexpr auto operator==(Resource, Resource) -> bool = default;
    };

    /**
     * @brief Size and format of a transient target.
     */
    struct TargetDesc {
        int width{};
        int height{};
        Device::TextureFormat format{Device::TextureFormat::RGBA};

        friend auto operator==(const TargetDesc&, const TargetDesc&) -> bool = default;
    };

    enum class PassKind : uint8_t
    {
        Render, //!< The graph begins and ends a render pass on the pass's target around it.
        Encoder //!< Copies, blits, or a helper that runs its own render passes.
    };

    class PassContext;

    /**
     * @brief A non-owning reference to a callable taking a PassContext&. The callable must
     *        outlive Execute().
     */
    class PassFunction
    {
    public:
        PassFunction() = default;

        template<class Function>
        PassFunction(Function& function) // NOLINT(google-explicit-constructor): a reference, like std::function_ref.
            : m_object(&function)
            , m_call([](void* object, PassContext& context) { (*static_cast<Function*>(object))(context); })
        {
        }

        void operator()(PassContext& context) const
        {
            if (m_call != nullptr)
            {
                m_call(m_object, context);
            }
        }

    private:
        void* m_object{nullptr};
        void (*m_call)(void*, PassContext&){nullptr};
    };

    /**
     * @brief A pass's declaration.
     */
    struct PassDesc {
        PassKind kind{PassKind::Render};
        Resource target{};                                       //!< Render passes: the colour target.
        Device::TargetBinding binding{Device::TargetBinding::Draw}; //!< Render passes (GL: ReadDraw also binds it for reading).
        std::optional<Device::Rect> viewport{};                  //!< Render passes; unset: the target's size for transients.
        Device::LoadOp load{Device::LoadOp::Load};
        std::array<float, 4> clearColor{};
        std::initializer_list<Resource> reads{};  //!< Sampled or copied from; Resource{} entries are skipped. Only read during AddPass().
        std::initializer_list<Resource> writes{}; //!< Encoder passes: written (render passes write their target).
    };

    /**
     * @brief What a running pass can ask the graph.
     */
    class PassContext
    {
    public:
        explicit PassContext(RenderGraph& graph)
            : m_graph(graph)
        {
        }

        /// The render target a resource stands for this frame.
        [[nodiscard]] auto Target(Resource resource) const -> Device::RenderTargetHandle;

        /// A transient's physical framebuffer (one colour attachment at index 0), or nullptr.
        [[nodiscard]] auto Transient(Resource resource) const -> Framebuffer*;

    private:
        RenderGraph& m_graph;
    };

    /**
     * @brief Statistics of the last Compile(), for tests and the perf HUD.
     */
    struct Stats {
        size_t passes{};
        size_t transients{};
        size_t physicalTargets{}; //!< Targets the transients of this frame share.
        size_t pooledTargets{};   //!< Targets the pool holds, across frames.
    };

    RenderGraph();
    ~RenderGraph();

    RenderGraph(const RenderGraph&) = delete;
    auto operator=(const RenderGraph&) -> RenderGraph& = delete;
    RenderGraph(RenderGraph&&) = delete;
    auto operator=(RenderGraph&&) -> RenderGraph& = delete;

    /**
     * @brief Starts a frame: forgets the passes and resources, keeps the pool.
     */
    void Reset();

    /**
     * @brief A persistent target the graph does not own (a preset framebuffer, the host's target).
     */
    auto Import(const char* name, Device::RenderTargetHandle target) -> Resource;

    /**
     * @brief A target that lives from its first pass to its last; contents undefined at the first.
     */
    auto CreateTransient(const char* name, const TargetDesc& desc) -> Resource;

    /**
     * @brief Appends a pass. Passes run in the order they are added.
     */
    void AddPass(const char* name, const PassDesc& desc, PassFunction function);

    /**
     * @brief Checks the frame and assigns physical targets. Logs and returns false if a pass reads
     *        a transient nothing wrote before it, a render pass samples its own target, or a limit
     *        is exceeded; Execute() then runs nothing.
     */
    auto Compile() -> bool;

    /**
     * @brief Runs the compiled passes.
     */
    void Execute(Device::ICommandList& commands);

    [[nodiscard]] auto GetStats() const -> Stats
    {
        return m_stats;
    }

    /**
     * @brief One line per pass: kind, name, target, reads and writes (with physical target slots).
     *        Allocates; for logs and tests.
     */
    [[nodiscard]] auto Describe() const -> std::string;

    [[nodiscard]] auto PassCount() const -> size_t
    {
        return m_passCount;
    }

    [[nodiscard]] auto PassName(size_t index) const -> const char*;

private:
    struct ResourceRecord {
        const char* name{nullptr};
        bool transient{false};
        Device::RenderTargetHandle imported;
        TargetDesc desc;
        int firstUse{-1};
        int lastUse{-1};
        int physical{-1}; //!< Index into m_pool for transients.
    };

    struct PassRecord {
        const char* name{nullptr};
        PassKind kind{PassKind::Render};
        Resource target;
        Device::TargetBinding binding{Device::TargetBinding::Draw};
        std::optional<Device::Rect> viewport;
        Device::LoadOp load{Device::LoadOp::Load};
        std::array<float, 4> clearColor{};
        std::array<Resource, MaxPassResources> reads{};
        uint8_t readCount{};
        std::array<Resource, MaxPassResources> writes{};
        uint8_t writeCount{};
        PassFunction function;
    };

    struct PooledTarget {
        TargetDesc desc;
        std::unique_ptr<Framebuffer> framebuffer;
        int busyUntil{-1}; //!< Last pass of the transient holding it this frame.
    };

    auto Fail(const std::string& message) -> bool;
    auto AcquirePhysical(const TargetDesc& desc, int firstUse, int lastUse) -> int;

    std::array<PassRecord, MaxPasses> m_passes{};
    size_t m_passCount{};
    std::array<ResourceRecord, MaxResources> m_resources{};
    size_t m_resourceCount{};
    bool m_overflow{false};
    bool m_compiled{false};
    std::vector<PooledTarget> m_pool; //!< Grows only when a frame needs a target it has none for.
    Stats m_stats;
    std::string m_lastError; //!< Logged once per distinct message.
};

} // namespace Renderer
} // namespace libprojectM
