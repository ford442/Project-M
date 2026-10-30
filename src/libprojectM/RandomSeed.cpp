#include "RandomSeed.hpp"

#include "EngineContext.hpp"

namespace libprojectM {
namespace RandomSeed {

void SetDeterministicSeed(uint32_t seed)
{
    EngineContext::SetProcessSeed(seed);
}

void ClearDeterministicSeed()
{
    EngineContext::SetProcessSeed(std::nullopt);
}

auto IsDeterministic() -> bool
{
    return EngineContext::ProcessSeed().has_value();
}

auto Get(const char* domain) -> uint32_t
{
    return EngineContext::Current().SeedFor(domain);
}

auto Next() -> uint32_t
{
    return EngineContext::Current().NextRandom();
}

} // namespace RandomSeed
} // namespace libprojectM
