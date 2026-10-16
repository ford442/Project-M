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

// Waveform sample loops (the built-in waves, custom waves and their scale and
// point passes): at most a few hundred samples (custom waves: 512) of a few
// multiplies or a sin/cos each. A parallel region costs a wake-up of every
// helper, and with helpers that sleep between regions (wasm's
// kmp_set_blocktime(0)) that wake-up dwarfs the loop. Measured natively
// (libgomp, 3 threads, OMP_WAIT_POLICY=passive, 2026-10-16): the custom-wave
// scale + point body over 512 samples took ~114 us per region in parallel
// against ~11 us serial, and the parallel loop was still slower at 8192. So
// these stay serial at every sample count a preset can ask for; the gate only
// lets a far larger loop, should one appear, parallelize.
inline constexpr int kMinWaveformLoopIters = 1 << 16;

} // namespace OpenMp
} // namespace libprojectM
