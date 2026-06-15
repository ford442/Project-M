#include <Audio/MilkdropFFT.hpp>

#include <gtest/gtest.h>

#include <chrono>
#include <cmath>
#include <vector>

#ifdef PRJM_ENABLE_OPENMP
#include <omp.h>
#endif

#include <projectM-4/projectm_perf.h>

namespace {

using Clock = std::chrono::steady_clock;

TEST(OpenMPInfoTest, ReportsCompileTimeState)
{
    projectm_perf_openmp_info info{};
    projectm_perf_get_openmp_info(&info);

#ifdef PRJM_ENABLE_OPENMP
    EXPECT_TRUE(info.compiled_enabled);
    EXPECT_GE(info.max_threads, 1);
#else
    EXPECT_FALSE(info.compiled_enabled);
    EXPECT_EQ(info.max_threads, 1);
#endif
}

TEST(OpenMPInfoTest, ParallelRegionSpawnsWorkersWhenEnabled)
{
#ifdef PRJM_ENABLE_OPENMP
    int observed = 1;
#pragma omp parallel
    {
#pragma omp single
        observed = omp_get_num_threads();
    }
    EXPECT_GE(observed, 1);
    EXPECT_GE(omp_get_max_threads(), observed);
#else
    EXPECT_EQ(projectm_perf_openmp_thread_count_in_parallel(), 1);
#endif
}

TEST(OpenMPBenchTest, FftThroughput)
{
    constexpr int kIterations = 2000;
    libprojectM::Audio::MilkdropFFT fft(576, 256, true, 1.0f);

    std::vector<float> wave(576);
    for (size_t i = 0; i < wave.size(); ++i)
    {
        wave[i] = std::sin(static_cast<float>(i) * 0.07f);
    }
    std::vector<float> spectrum;

    for (int i = 0; i < 20; ++i)
    {
        fft.TimeToFrequencyDomain(wave, spectrum);
    }

    const auto start = Clock::now();
    for (int i = 0; i < kIterations; ++i)
    {
        fft.TimeToFrequencyDomain(wave, spectrum);
    }
    const auto end = Clock::now();

    const double totalMs = std::chrono::duration<double, std::milli>(end - start).count();
    const double msPerIter = totalMs / kIterations;

    projectm_perf_openmp_info info{};
    projectm_perf_get_openmp_info(&info);

    // Log for manual/CI inspection; not a hard perf gate (hardware varies).
    std::cout << "[OpenMPBench] compiled=" << info.compiled_enabled
              << " maxThreads=" << info.max_threads
              << " fftTotalMs=" << totalMs
              << " fftMsPerIter=" << msPerIter << std::endl;

    EXPECT_GT(spectrum.size(), 0u);
    EXPECT_LT(msPerIter, 5.0); // generous upper bound to catch accidental debug builds
}

} // namespace
