#include <projectm-eval.h>

#include <mutex>

namespace {

// Guards gmegabuf block allocation/free (MemoryBuffer.c) and the shared
// reg00-reg99 storage. Required because PerPixelMesh::CalculateMesh() now
// runs per-pixel code for multiple vertices concurrently via OpenMP, with
// all per-thread eval contexts sharing the same gmegabuf/reg vars
// (PresetState::globalMemory/globalRegisters). A single non-recursive mutex
// is sufficient per the projectM-Eval threading docs.
std::mutex g_evalMemoryMutex;

} // anonymous namespace

void projectm_eval_memory_host_lock_mutex()
{
    g_evalMemoryMutex.lock();
}

void projectm_eval_memory_host_unlock_mutex()
{
    g_evalMemoryMutex.unlock();
}
