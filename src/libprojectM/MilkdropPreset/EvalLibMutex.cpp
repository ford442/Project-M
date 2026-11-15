#include <EngineContext.hpp>

#include <projectm-eval.h>

#include <mutex>

// projectM-Eval locks around block allocation and free in a memory buffer (MemoryBuffer.c).
// The hook takes no argument, so it locks the engine whose code is running on this thread:
// every buffer projectM hands the evaluator belongs to one engine (PresetState::globalMemory,
// a context's own megabuf, the engine's sprite memory), so an engine's own mutex covers it.
// Entry points and preset-prepare jobs install their engine with ScopedEngineContext; a thread
// with none uses the process default's. The lock and its unlock run inside one evaluator call
// on one thread, so both resolve to the same mutex. Not recursive, as the evaluator documents.
//
// The CPU per-pixel loop no longer runs a program that touches memory on more than one thread
// (PerPixelGlslLowering::ClassifyEvaluationOrder()), so in practice this separates an engine's
// render thread from its own prepare thread.

void projectm_eval_memory_host_lock_mutex()
{
    libprojectM::EngineContext::Current().EvalMemoryMutex().lock();
}

void projectm_eval_memory_host_unlock_mutex()
{
    libprojectM::EngineContext::Current().EvalMemoryMutex().unlock();
}
