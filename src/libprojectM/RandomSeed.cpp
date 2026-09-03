#include "RandomSeed.hpp"

#include <cstdlib>
#include <random>

namespace libprojectM {
namespace RandomSeed {
namespace {

bool s_deterministic{false};
uint32_t s_seed{0};

/**
 * FNV-1a over the domain name. Chosen for being short, dependency-free and
 * stable across compilers/platforms — the goldens are compared across machines,
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

} // namespace

void SetDeterministicSeed(uint32_t seed)
{
    s_deterministic = true;
    s_seed = seed;
    // MilkdropShader's rand_frame/rand_preset values come from libc rand().
    std::srand(static_cast<unsigned int>(seed));
}

void ClearDeterministicSeed()
{
    s_deterministic = false;
    s_seed = 0;
}

auto IsDeterministic() -> bool
{
    return s_deterministic;
}

auto Get(const char* domain) -> uint32_t
{
    if (!s_deterministic)
    {
        std::random_device randomDevice;
        return static_cast<uint32_t>(randomDevice());
    }
    const uint64_t mixed = Mix((static_cast<uint64_t>(s_seed) << 32) ^ HashDomain(domain));
    return static_cast<uint32_t>(mixed ^ (mixed >> 32));
}

} // namespace RandomSeed
} // namespace libprojectM
