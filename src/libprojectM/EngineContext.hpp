#pragma once

#include "PerfTimers.hpp"
#include "Renderer/ShaderTranspileCache.hpp"

#include <cstdint>
#include <memory>
#include <mutex>
#include <optional>
#include <random>

namespace libprojectM {

/**
 * @brief State that belongs to one engine (one ProjectM instance) rather than to the process.
 *
 * Today: random numbers. Everything an engine draws -- per-domain seeds (noise textures, preset
 * state, transitions), the stream MilkdropShader's rand_preset/rand_frame values come from,
 * random texture picks -- goes through the engine's context, so two engines in one process
 * do not disturb each other and one engine can be made deterministic on its own.
 *
 * Code deep in the renderer reaches the context through Current(): ProjectM installs its own
 * with a ScopedEngineContext on every entry point that can draw, and a PresetPrepareJob
 * installs the one it was created with while it runs. Outside any engine, Current() is a
 * process-wide default context.
 *
 * Seeding: an engine follows the process default (RandomSeed::SetDeterministicSeed(),
 * projectm_set_deterministic_seed()) until it is given a seed of its own with SetSeed().
 */
class EngineContext
{
public:
    EngineContext();

    EngineContext(const EngineContext&) = delete;
    auto operator=(const EngineContext&) -> EngineContext& = delete;

    /**
     * @brief Gives this engine its own seed (deterministic), or nullopt to follow the process
     *        default again. Restarts the engine's random stream.
     */
    void SetSeed(std::optional<uint32_t> seed);

    /**
     * @brief The seed this engine was given with SetSeed(), if any.
     */
    auto OwnSeed() const -> std::optional<uint32_t>;

    /**
     * @brief Whether this engine currently draws deterministically (its own seed, or a
     *        deterministic process default).
     */
    auto IsDeterministic() const -> bool;

    /**
     * @brief A seed for one consumer, named by @a domain. Deterministic: a stable function of
     *        the effective seed and the domain. Otherwise: from std::random_device.
     */
    auto SeedFor(const char* domain) const -> uint32_t;

    /**
     * @brief The next value of the engine's random stream, uniform over 32 bits.
     *
     * One stream per engine, for consumers that draw a sequence (each shader its own values,
     * each random texture its own pick). Deterministic engines restart it whenever their
     * effective seed is set. Thread-safe.
     */
    auto NextRandom() -> uint32_t;

    /**
     * @brief This engine's perf timer state: frame timings, current GPU stage and its own
     * GPU stage callback. See Perf::State.
     */
    auto PerfState() -> Perf::State&
    {
        return m_perfState;
    }

    /**
     * @brief This engine's transpiled-GLSL cache hooks and key. See
     * Renderer::TranspileCacheState.
     */
    auto TranspileCache() -> Renderer::TranspileCacheState&
    {
        return m_transpileCache;
    }

    /**
     * @brief The context code on this thread draws from: the innermost ScopedEngineContext's,
     *        or the process default.
     */
    static auto Current() -> EngineContext&;

    /**
     * @brief The process-wide default context, used outside any engine.
     */
    static auto ProcessDefault() -> EngineContext&;

    /**
     * @brief Sets (or with nullopt clears) the seed every engine without its own seed follows.
     */
    static void SetProcessSeed(std::optional<uint32_t> seed);

    /**
     * @brief The process-wide seed, if set.
     */
    static auto ProcessSeed() -> std::optional<uint32_t>;

private:
    /** @brief The seed in effect: OwnSeed(), else the process seed. */
    auto EffectiveSeed() const -> std::optional<uint32_t>;

    mutable std::mutex m_mutex;
    std::optional<uint32_t> m_ownSeed;
    std::mt19937 m_stream;
    uint64_t m_streamEpoch{0}; //!< The process seed epoch m_stream was last restarted for.

    Perf::State m_perfState;
    Renderer::TranspileCacheState m_transpileCache;
};

/**
 * @brief Makes @a context EngineContext::Current() on this thread for its lifetime.
 */
class ScopedEngineContext
{
public:
    explicit ScopedEngineContext(EngineContext& context);
    ~ScopedEngineContext();

    ScopedEngineContext(const ScopedEngineContext&) = delete;
    auto operator=(const ScopedEngineContext&) -> ScopedEngineContext& = delete;

private:
    EngineContext* m_previous;
};

} // namespace libprojectM
