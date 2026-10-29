/**
 * @file RandomSeed.hpp
 * @brief Seed source for every RNG in libprojectM; a facade over EngineContext.
 *
 * projectM's visual output is a function of (preset, audio, frame index, time,
 * RNG). Four of those five are already injectable from the host — the fifth was
 * not: every RNG in the library seeded itself from `std::random_device` (or the
 * system clock, or an unseeded libc `rand()`), so two runs of the same preset on
 * the same frames produced different pixels. That makes golden-image regression
 * testing impossible, which is why no sub-issue of the graphics FPS recovery
 * work has a measured before/after.
 *
 * This header routes all of those seeds through one place. In the default mode
 * nothing changes: `Get()` returns `std::random_device`. When a host calls
 * `projectm_set_deterministic_seed()` (see `projectM-4/debug.h`), `Get()`
 * becomes a pure function of the host seed and a call-site domain name.
 *
 * Deliberate property: the deterministic value depends only on (seed, domain),
 * *not* on how many times `Get()` has already been called. Call-site ordering
 * across unrelated subsystems is not a stable thing to hash — an added log line
 * or a lazily-constructed object would silently reshuffle every downstream
 * seed and invalidate the goldens. The cost is that two objects in the same
 * domain (e.g. two `PresetState`s alive at once during a crossfade) draw the
 * same values in deterministic mode. For a capture harness rendering one preset
 * per page that is the desired behaviour, not a limitation.
 *
 * `Get()` and `Next()` draw from EngineContext::Current(): the engine the
 * calling code runs for (see EngineContext.hpp), so two engines in one process
 * draw independently. `SetDeterministicSeed()` sets the process default every
 * engine without a seed of its own follows; ProjectM::SetSeed() gives one engine
 * its own. `Next()` replaces the libc `rand()` stream MilkdropShader's
 * rand_preset/rand_frame values used to come from, which was one sequence shared
 * by every engine and so reproduced only with one engine per process.
 */
#pragma once

#include <cstdint>

namespace libprojectM {
namespace RandomSeed {

/**
 * @brief Switches every engine without its own seed to deterministic seeding, and
 *        restarts their random streams.
 * @param seed The host-chosen seed. Any value is valid, including 0.
 */
void SetDeterministicSeed(uint32_t seed);

/**
 * @brief Returns engines without their own seed to `std::random_device` seeding.
 */
void ClearDeterministicSeed();

/**
 * @brief Whether the process default seed is set.
 */
auto IsDeterministic() -> bool;

/**
 * @brief The seed a call site should hand to a freshly constructed RNG.
 * @param domain A stable, unique-per-call-site name, e.g. "PresetState". Used
 *               only in deterministic mode. Must not be null.
 * @return A non-reproducible value from `std::random_device` in the default
 *         mode; a pure function of (host seed, domain) in deterministic mode.
 */
auto Get(const char* domain) -> uint32_t;

/**
 * @brief The next value of the current engine's random stream (EngineContext::NextRandom()).
 */
auto Next() -> uint32_t;

} // namespace RandomSeed
} // namespace libprojectM
