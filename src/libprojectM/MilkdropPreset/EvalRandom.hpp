#pragma once

#include <RandomSeed.hpp>

#include <projectm-eval.h>

namespace libprojectM {
namespace MilkdropPreset {

/**
 * @brief Seeds an expression context's rand() stream from the current engine.
 *
 * Each projectm-eval context draws rand() from its own stream. Seeding it from
 * EngineContext::Current()'s stream makes rand() in preset code follow the engine's
 * seed, and keeps one engine's code from shifting another's values. Only the vendored
 * projectm-eval has per-context streams; with an installed one, rand() stays on its
 * single process-wide stream.
 *
 * @param context The context to seed. Null is ignored.
 */
inline void SeedEvalRandom(projectm_eval_context* context)
{
#ifdef PROJECTM_EVAL_INTERNAL_TREE_AVAILABLE
    if (context != nullptr)
    {
        projectm_eval_context_seed_rand(context, RandomSeed::Next());
    }
#else
    static_cast<void>(context);
#endif
}

} // namespace MilkdropPreset
} // namespace libprojectM
