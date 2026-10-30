#include "EngineContext.hpp"

#include "Renderer/Device/Gl/GlDevice.hpp"

#include <atomic>

namespace libprojectM {

namespace {

// The process-wide part of seeding, plus the current context per thread. These are the only
// mutable namespace-scope state the engine keeps (scripts/check_engine_globals.sh).
std::mutex s_processSeedMutex;
std::optional<uint32_t> s_processSeed;
std::atomic<uint64_t> s_processSeedEpoch{0}; //!< Bumped on every SetProcessSeed().

thread_local EngineContext* t_currentContext{nullptr};

/**
 * FNV-1a over the domain name. Chosen for being short, dependency-free and
 * stable across compilers/platforms -- the goldens are compared across machines,
 * so `std::hash` (explicitly not required to be stable) would not do.
 */
auto HashDomain(const char* domain) -> uint64_t
{
    uint64_t hash{0xcbf29ce484222325ull};
    for (const char* c = domain; c != nullptr && *c != '\0'; ++c)
    {
        hash ^= static_cast<uint64_t>(static_cast<unsigned char>(*c));
        hash *= 0x100000001b3ull;
    }
    return hash;
}

/** splitmix64 finalizer: cheap avalanche so neighbouring domains/seeds diverge. */
auto Mix(uint64_t value) -> uint64_t
{
    value += 0x9e3779b97f4a7c15ull;
    value = (value ^ (value >> 30)) * 0xbf58476d1ce4e5b9ull;
    value = (value ^ (value >> 27)) * 0x94d049bb133111ebull;
    return value ^ (value >> 31);
}

auto SeedForDomain(uint32_t seed, const char* domain) -> uint32_t
{
    const uint64_t mixed = Mix((static_cast<uint64_t>(seed) << 32) ^ HashDomain(domain));
    return static_cast<uint32_t>(mixed ^ (mixed >> 32));
}

constexpr const char* kStreamDomain = "EngineContext::NextRandom";

} // namespace

EngineContext::EngineContext()
    : EngineContext(ProcessDefaultTag{})
{
    m_device = std::make_unique<Renderer::Device::Gl::GlDevice>();
}

EngineContext::EngineContext(ProcessDefaultTag)
{
    std::random_device randomDevice;
    m_stream.seed(randomDevice());
    m_streamEpoch = s_processSeedEpoch.load();
    if (const auto seed = ProcessSeed())
    {
        m_stream.seed(SeedForDomain(*seed, kStreamDomain));
    }
}

void EngineContext::SetSeed(std::optional<uint32_t> seed)
{
    std::lock_guard<std::mutex> lock(m_mutex);
    m_ownSeed = seed;
    m_streamEpoch = s_processSeedEpoch.load();
    const auto effective = EffectiveSeed();
    if (effective)
    {
        m_stream.seed(SeedForDomain(*effective, kStreamDomain));
    }
}

auto EngineContext::OwnSeed() const -> std::optional<uint32_t>
{
    std::lock_guard<std::mutex> lock(m_mutex);
    return m_ownSeed;
}

auto EngineContext::EffectiveSeed() const -> std::optional<uint32_t>
{
    return m_ownSeed ? m_ownSeed : ProcessSeed();
}

auto EngineContext::IsDeterministic() const -> bool
{
    std::lock_guard<std::mutex> lock(m_mutex);
    return EffectiveSeed().has_value();
}

auto EngineContext::SeedFor(const char* domain) const -> uint32_t
{
    std::optional<uint32_t> seed;
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        seed = EffectiveSeed();
    }
    if (!seed)
    {
        std::random_device randomDevice;
        return static_cast<uint32_t>(randomDevice());
    }
    return SeedForDomain(*seed, domain);
}

auto EngineContext::NextRandom() -> uint32_t
{
    std::lock_guard<std::mutex> lock(m_mutex);
    // An engine following the process seed restarts its stream when that seed is set again,
    // the way srand() used to restart the libc rand() stream these values came from.
    const auto epoch = s_processSeedEpoch.load();
    if (!m_ownSeed && epoch != m_streamEpoch)
    {
        m_streamEpoch = epoch;
        if (const auto seed = ProcessSeed())
        {
            m_stream.seed(SeedForDomain(*seed, kStreamDomain));
        }
    }
    return static_cast<uint32_t>(m_stream());
}

auto EngineContext::Current() -> EngineContext&
{
    return t_currentContext != nullptr ? *t_currentContext : ProcessDefault();
}

auto EngineContext::ProcessDefault() -> EngineContext&
{
    // Never destroyed: static objects may still draw during static destruction.
    static auto* const context = new EngineContext(ProcessDefaultTag{});
    return *context;
}

void EngineContext::SetProcessSeed(std::optional<uint32_t> seed)
{
    {
        std::lock_guard<std::mutex> lock(s_processSeedMutex);
        s_processSeed = seed;
    }
    ++s_processSeedEpoch;
}

auto EngineContext::ProcessSeed() -> std::optional<uint32_t>
{
    std::lock_guard<std::mutex> lock(s_processSeedMutex);
    return s_processSeed;
}

void EngineContext::SetLogCallback(Logging::UserCallback callback)
{
    std::lock_guard<std::mutex> lock(m_logMutex);
    m_logCallback = callback;
}

auto EngineContext::LogCallback() const -> Logging::UserCallback
{
    std::lock_guard<std::mutex> lock(m_logMutex);
    return m_logCallback;
}

void EngineContext::SetLogLevel(Logging::LogLevel level)
{
    std::lock_guard<std::mutex> lock(m_logMutex);
    m_logLevel = level;
}

auto EngineContext::LogLevel() const -> Logging::LogLevel
{
    std::lock_guard<std::mutex> lock(m_logMutex);
    return m_logLevel;
}

ScopedEngineContext::ScopedEngineContext(EngineContext& context)
    : m_previous(t_currentContext)
{
    t_currentContext = &context;
    if (auto* device = context.RenderDevice())
    {
        m_device.emplace(*device);
    }
}

ScopedEngineContext::~ScopedEngineContext()
{
    m_device.reset();
    t_currentContext = m_previous;
}

namespace Perf {

auto CurrentState() -> State&
{
    return EngineContext::Current().PerfState();
}

auto ProcessState() -> State&
{
    return EngineContext::ProcessDefault().PerfState();
}

} // namespace Perf

} // namespace libprojectM
