#pragma once

namespace libprojectM {
namespace OpenMp {

// Minimum loop iterations before OpenMP fork/join is profitable.
//
// Tuned against OpenMPBenchTest (native) and wasm pthread pool overhead
// (PTHREAD_POOL_SIZE=4). Waveform loops (~256–480 iters), loudness band sums
// (~85), and FFT magnitude output (256) stay serial; per-pixel mesh (≥3125
// verts at 64×48) and noise generation (256×256) still parallelize.
inline constexpr int kMinParallelLoopIters = 512;

// Per-vertex mesh / composite grids: higher per-iteration cost than waveforms.
inline constexpr int kMinPerPixelMeshVerts = 1000;

} // namespace OpenMp
} // namespace libprojectM
