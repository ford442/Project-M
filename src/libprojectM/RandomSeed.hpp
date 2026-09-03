/**
 * @file RandomSeed.hpp
 * @brief Process-global seed source for every RNG in libprojectM.
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
 * Not covered here: libc `rand()`, used by `MilkdropShader`'s per-frame
 * `rand_frame` uniform. `SetDeterministicSeed()` calls `std::srand()` so that
 * stream is pinned too, but it is a single global sequence — it reproduces only
 * when the sequence of calls into it is itself identical, which holds when the
 * frame schedule is deterministic (the harness's whole purpose) and does not
 * hold if you interleave two engines in one process.
 */
#pragma once

#include <cstdint>

namespace libprojectM {
namespace RandomSeed {

/**
 * @brief Switches the library into deterministic seeding and pins libc rand().
 * @param seed The host-chosen seed. Any value is valid, including 0.
 */
void SetDeterministicSeed(uint32_t seed);

/**
 * @brief Returns to `std::random_device` seeding. Does not un-seed libc rand().
 */
void ClearDeterministicSeed();

/**
 * @brief Whether deterministic seeding is currently active.
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

} // namespace RandomSeed
} // namespace libprojectM
