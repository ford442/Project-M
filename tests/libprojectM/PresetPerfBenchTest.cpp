#include <MilkdropPreset/PresetFileParser.hpp>

#include <gtest/gtest.h>

#include <chrono>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include <projectM-4/projectm_perf.h>

namespace {

using Clock = std::chrono::steady_clock;

std::vector<std::string> BenchPresetPaths()
{
    return {
        std::string(PROJECTM_PRESET_TESTS_DIR) + "/110-per_pixel.milk",
        std::string(PROJECTM_PRESET_TESTS_DIR) + "/300-beatdetect-bassmidtreb.milk",
        std::string(PROJECTM_PRESET_TESTS_DIR) + "/260-compshader-noise_lq.milk",
    };
}

double BenchPresetParse(const std::string& path, int iterations)
{
    std::ifstream stream(path);
    if (!stream.good())
    {
        return -1.0;
    }

    std::string fileContents((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());

    for (int i = 0; i < 5; ++i)
    {
        std::istringstream warmupStream(fileContents);
        libprojectM::MilkdropPreset::PresetFileParser parser;
        if (!parser.Read(warmupStream))
        {
            return -1.0;
        }
        (void)parser.GetCode("per_pixel_");
        (void)parser.GetCode("per_frame_");
        (void)parser.GetCode("warp_");
        (void)parser.GetCode("comp_");
    }

    const auto start = Clock::now();
    for (int i = 0; i < iterations; ++i)
    {
        std::istringstream iterStream(fileContents);
        libprojectM::MilkdropPreset::PresetFileParser parser;
        if (!parser.Read(iterStream))
        {
            return -1.0;
        }
        (void)parser.GetCode("per_pixel_");
        (void)parser.GetCode("per_frame_");
        (void)parser.GetCode("warp_");
        (void)parser.GetCode("comp_");
    }
    const auto end = Clock::now();

    return std::chrono::duration<double, std::milli>(end - start).count() / static_cast<double>(iterations);
}

} // namespace

TEST(PresetPerfBenchTest, ParseThroughput)
{
    projectm_perf_openmp_info info{};
    projectm_perf_get_openmp_info(&info);

    constexpr int kIterations = 500;
    int measured = 0;

    for (const auto& path : BenchPresetPaths())
    {
        if (!std::filesystem::exists(path))
        {
            continue;
        }

        const double msPerIter = BenchPresetParse(path, kIterations);
        ASSERT_GE(msPerIter, 0.0) << path;

        std::cout << "[PresetPerfBench] preset=" << path
                  << " openmp=" << info.compiled_enabled
                  << " maxThreads=" << info.max_threads
                  << " parseMsPerIter=" << msPerIter << std::endl;
        ++measured;
    }

    EXPECT_GT(measured, 0);
}
