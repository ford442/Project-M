/**
 * @file PerPixelGpuRenderTest.cpp
 * @brief End-to-end check that the GPU per-pixel path renders what the CPU path renders.
 *
 * PerPixelGlslLoweringTest proves the generated GLSL computes the same ten transform
 * channels as the evaluator. This file closes the remaining gap: that those channels
 * are wired into the warp vertex shader correctly, that the per-frame seeds and
 * uniforms arrive, and that the resulting frame looks the same.
 *
 * Each preset is rendered twice through the full engine at a fixed seed and a fixed
 * frame clock -- once with PROJECTM_PER_PIXEL_EVAL=cpu, once on the default path --
 * and the two framebuffers are compared. The warp mesh feeds back into itself every
 * frame, so this also catches a difference too small to see in one frame but that
 * compounds over a sequence.
 *
 * The named list is the top of docs/PRESET_WORKLIST.md: the presets whose dominant
 * cost is per-pixel equations, which are the ones the GPU path exists for.
 */

#include "HeadlessGlContext.hpp"

#include <MilkdropPreset/PerPixelContext.hpp>
#include <MilkdropPreset/PerPixelGlslLowering.hpp>
#include <MilkdropPreset/PresetFileParser.hpp>

#include <glad/gl.h>

#include <gtest/gtest.h>

#include <cstdlib>
#include <filesystem>
#include <memory>
#include <string>
#include <vector>

#include <projectM-4/projectM.h>

using libprojectM::MilkdropPreset::PerPixelContext;
using libprojectM::MilkdropPreset::PerPixelGlslLowering;
using libprojectM::MilkdropPreset::PresetFileParser;

namespace {

constexpr int kWidth = 192;
constexpr int kHeight = 144;
constexpr double kFrameStep = 1.0 / 60.0;

/**
 * @brief Frame counts for the two comparisons.
 *
 * The warp mesh samples the previous frame, so a preset is a feedback system and most
 * of them are chaotic: any difference in the last bits of a UV -- between the double
 * CPU evaluator and the 32-bit shader, but equally between two GPUs -- is amplified
 * frame over frame. Measured on `390 threx no more warningsce amy-able.milk`, whose
 * per-pixel code steps on int() and equal() of a continuous angle, the mean channel
 * difference runs 0 at frame 1, 0.0004 at frame 2, 0.46 at frame 5, 4.1 at frame 15
 * and 10.8 at frame 40. Nothing there is a wiring fault; it is what a step function of
 * a rounded input does inside a feedback loop.
 *
 * So the assertion lives at the short horizon, where a real fault (a channel not
 * wired through, a uniform not uploaded, a seed missed) shows up immediately and
 * hugely, while rounding has not yet had time to compound. The long horizon is
 * rendered and reported, because its trend is worth seeing, but it is not a pass/fail
 * criterion for a chaotic system.
 */
constexpr int kShortFrames = 8;
constexpr int kLongFrames = 40;

/**
 * @brief Two bars, for two different things.
 *
 * The inputs both paths see are bit-identical: x, y, rad and ang are all computed in
 * 32-bit float on the CPU too, and the GPU derives them from the same vertex
 * attributes with the same operations in the same order. Only the evaluation itself
 * differs, double against float, so anything past the fault bar means a value never
 * arrived rather than a value rounded differently.
 *
 * Below the fault bar there is still a class of preset that diverges visibly:
 * per-pixel code whose output is a step function of a continuous input --
 * `seg = int(seg)`, `equal(seg, num)`, `above(seg, 0)` -- flips a whole segment when
 * rounding pushes the input across the step, and the boundary sweeps across the mesh
 * as `time` advances. `390 threx no more warningsce amy-able.milk` is that case. The
 * budget records how many such presets there are rather than pretending there are
 * none, so a change that adds one shows up here.
 */
constexpr double kFaultDifferingShare = 0.02;
constexpr double kFaultMeanAbsolute = 4.0;
constexpr double kCloseDifferingShare = 0.005;
constexpr double kCloseMeanAbsolute = 1.0;
constexpr std::size_t kVisiblyDifferentBudget = 1;

/**
 * @brief The heaviest presets in docs/PRESET_WORKLIST.md whose dominant term is
 *        per-pixel equations, plus the trivial per-pixel fixture from the golden set.
 */
const char* const kFixturePreset = "/110-per_pixel.milk";

const char* const kHeavyPresets[] = {
    "sun fan phoets newborns of satan.milk",
    "sun fan phoets.milk",
    "Mashup ADAMFX 2 Flexi + Geiss - Bipolar vs. reaction diffusion + Another Flexi + Fishbrain  + Digitaly imported + Fernie Ernie 3.milk",
    "bdrv et.AL Aderrasi - Accelerator (orbital Migraine)bdrv94 gdy neck problem solution (tense for hours) atrocious (adj.) fellucinate (n.).milk",
    "jambi abrachordabra jumaenzhi simzaelavimn - 1-ret.milk",
    "jambi abrachordabra jumaenzhi simzaelavimn - best boy dolly grip affair.milk",
    "amock fuck.milk",
    "bdrv flexi - shuriken 2 nz+ treat your conic section whores right.milk",
    "big hock sara silverman.milk",
    "youtube - broadcast yourself - smudge drug weinredong daemboniq gesturth.milk",
    "Weizenbaum, Hofstadter, Metzinger et al - brain-drain.milk",
    "390 threx no more warningsce amy-able.milk",
    "27_super_goats - mandelbrot - flx grid reference - pussies and booties (schwrequetomb).milk",
    "suksma - mandolinkrotch zet.milk",
    "suksma - kooperpear donglong.milk",
    "shifter - robotopia v2 molding chaos - little miss scale oven vs scala nz+.milk",
    "shifter - robotopia v2 nz+.milk",
    "shifter - robotopia v2 nz amplitudinal god modulation.milk",
    "fleekus flokus - fucking violent and insane homicidal air molecules - 778.milk",
    "shifter - robotopia v2 molding chaos all four waves.milk",
    "suksma - shifter - spincycle c - skin sheen specular highlights on dry warm tan ass.milk",
    "shifter - robotopia v2 molding chaos - little miss scale oven vs scala.milk",
    "shifter - robotopia v2 molding chaos.milk",
    "shifter - robotopia v2 roam3.milk",
    "shifter - robotopia v2.milk",
    "shifter - bronchiole conjoin (beta 4) - fight it.milk",
    "bdrv + al Rovastar - Fractopia bdrv132456 mix bleuarg - bloomberg quadogy.milk",
    "Flexi + geiss - botnet nz+ of the friar.milk",
    "Hexcollie, BDRV n Flexi - Cosmic evolution.milk",
};

/** @brief How two renderings of the same preset differ. */
struct FrameDifference
{
    double meanAbsolute{};   //!< Mean per-channel difference, 0..255.
    double maxAbsolute{};    //!< Largest per-channel difference, 0..255.
    double differingShare{}; //!< Share of channels differing by more than 8/255.
};

/** @brief Renders one preset into an offscreen framebuffer and returns its pixels. */
auto RenderPreset(const std::string& path, bool forceCpuPerPixel, int frames, std::string& error)
    -> std::vector<unsigned char>
{
    // Read at preset-compile time by MilkdropPreset::LowerPerPixelCodeToGlsl(), so it
    // has to be in place before the preset is loaded.
    if (forceCpuPerPixel)
    {
        setenv("PROJECTM_PER_PIXEL_EVAL", "cpu", 1);
    }
    else
    {
        unsetenv("PROJECTM_PER_PIXEL_EVAL");
    }

    // A fixed seed pins the noise textures and every other random draw, so the only
    // thing left that could differ between the two runs is the per-pixel path itself.
    projectm_set_deterministic_seed(0x5eed1234u);

    GLuint texture = 0;
    GLuint framebuffer = 0;
    glGenTextures(1, &texture);
    glBindTexture(GL_TEXTURE_2D, texture);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, kWidth, kHeight, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glGenFramebuffers(1, &framebuffer);
    glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, texture, 0);

    std::vector<unsigned char> pixels;
    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
    {
        error = "offscreen framebuffer incomplete";
    }
    else
    {
        auto* instance = projectm_create();
        if (instance == nullptr)
        {
            error = "projectm_create() failed";
        }
        else
        {
            projectm_set_window_size(instance, kWidth, kHeight);
            projectm_set_preset_duration(instance, 3600.0);
            projectm_set_soft_cut_duration(instance, 0.0);
            projectm_load_preset_file(instance, path.c_str(), false);

            for (int frame = 0; frame < frames; frame++)
            {
                projectm_set_frame_time(instance, static_cast<double>(frame) * kFrameStep);
                projectm_opengl_render_frame_fbo(instance, framebuffer);
            }

            pixels.resize(static_cast<std::size_t>(kWidth) * kHeight * 4);
            glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
            glReadPixels(0, 0, kWidth, kHeight, GL_RGBA, GL_UNSIGNED_BYTE, pixels.data());

            projectm_destroy(instance);
        }
    }

    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glDeleteFramebuffers(1, &framebuffer);
    glDeleteTextures(1, &texture);
    projectm_clear_deterministic_seed();
    unsetenv("PROJECTM_PER_PIXEL_EVAL");

    return pixels;
}

auto Compare(const std::vector<unsigned char>& first, const std::vector<unsigned char>& second)
    -> FrameDifference
{
    FrameDifference difference;
    if (first.size() != second.size() || first.empty())
    {
        difference.meanAbsolute = 255.0;
        difference.maxAbsolute = 255.0;
        difference.differingShare = 1.0;
        return difference;
    }

    double total = 0.0;
    std::size_t differing = 0;
    std::size_t counted = 0;
    for (std::size_t index = 0; index < first.size(); index++)
    {
        if (index % 4 == 3)
        {
            continue; // alpha carries no picture
        }
        const double delta = std::abs(static_cast<double>(first[index]) -
                                      static_cast<double>(second[index]));
        total += delta;
        difference.maxAbsolute = std::max(difference.maxAbsolute, delta);
        if (delta > 8.0)
        {
            differing++;
        }
        counted++;
    }

    difference.meanAbsolute = total / static_cast<double>(counted);
    difference.differingShare = static_cast<double>(differing) / static_cast<double>(counted);
    return difference;
}

/** @brief True if this preset's per-pixel code is one the compiler accepts. */
auto Lowers(const std::string& path, std::string& reason) -> bool
{
    PresetFileParser parser;
    if (!parser.Read(path))
    {
        reason = "preset could not be parsed";
        return false;
    }
    const auto code = parser.GetCode("per_pixel_");
    if (code.empty())
    {
        reason = "preset has no per-pixel code";
        return false;
    }

    PerPixelContext context(nullptr, nullptr);
    context.RegisterBuiltinVariables();
    try
    {
        context.CompilePerPixelCode(code);
    }
    catch (const std::exception& exception)
    {
        reason = exception.what();
        return false;
    }

    const auto lowering = PerPixelGlslLowering::Lower(context.perPixelCodeHandle);
    reason = lowering.reason;
    return lowering.lowered;
}

class PerPixelGpuRenderTest : public testing::Test
{
protected:
    void SetUp() override
    {
        if (!PerPixelGlslLowering::Available())
        {
            GTEST_SKIP() << "built without access to the projectM-Eval expression tree";
        }
        if (!libprojectM::Test::HeadlessGlContext::IsAvailable())
        {
            GTEST_SKIP() << "no headless OpenGL context available";
        }
        m_context = std::make_unique<libprojectM::Test::HeadlessGlContext>();
        if (!m_context->Valid() || !m_context->InitializeGlad())
        {
            GTEST_SKIP() << "could not create a headless OpenGL context";
        }
    }

    /**
     * @brief Renders @p path both ways and returns how the two frames differ.
     *
     * The tolerance is perceptual, not exact: the CPU evaluates in double and the
     * shader in 32-bit float, and the warp mesh feeds its own output back in every
     * frame, so the two sequences drift slightly. What must not happen is a different
     * picture, which shows up as a large share of visibly different pixels.
     */
    auto CompareBothPaths(const std::string& path, int frames, FrameDifference& difference) -> bool
    {
        std::string error;
        const auto cpuPixels = RenderPreset(path, true, frames, error);
        if (cpuPixels.empty())
        {
            ADD_FAILURE() << "CPU render of " << path << " failed: " << error;
            return false;
        }
        const auto gpuPixels = RenderPreset(path, false, frames, error);
        if (gpuPixels.empty())
        {
            ADD_FAILURE() << "GPU render of " << path << " failed: " << error;
            return false;
        }

        difference = Compare(cpuPixels, gpuPixels);
        return true;
    }

    std::unique_ptr<libprojectM::Test::HeadlessGlContext> m_context;
};

} // namespace

/**
 * @brief The trivial per-pixel fixture from the golden set must be pixel-identical.
 *
 * `zoom = 0.9615 - rad*0.1` has no accumulation and no stiff function, so there is no
 * excuse for the two paths to differ here at all.
 */
TEST_F(PerPixelGpuRenderTest, TrivialPerPixelFixtureRendersIdentically)
{
    const std::string path = std::string(PROJECTM_PRESET_TESTS_DIR) + kFixturePreset;
    if (!std::filesystem::exists(path))
    {
        GTEST_SKIP() << "fixture preset not present: " << path;
    }

    std::string reason;
    ASSERT_TRUE(Lowers(path, reason)) << "fixture no longer lowers: " << reason;

    FrameDifference difference;
    ASSERT_TRUE(CompareBothPaths(path, kLongFrames, difference));

    std::cout << "[  RENDER  ] " << kFixturePreset << " (" << kLongFrames
              << " frames): mean " << difference.meanAbsolute << ", max "
              << difference.maxAbsolute << ", differing "
              << difference.differingShare * 100.0 << "%\n";

    // No accumulation and no stiff function here, so even the long sequence must match
    // exactly. If this one drifts, something is genuinely wired wrong.
    EXPECT_LE(difference.maxAbsolute, 1.0)
        << "the fixture preset should render identically on both paths";
}

/**
 * @brief The heavy presets that lower must render the same picture on both paths.
 *
 * This is acceptance criterion 1 of #227, minus the frame-time half, which needs a GPU
 * this environment does not have: at least five currently-heavy presets run on the GPU
 * per-pixel path at equal screenshot similarity.
 */
TEST_F(PerPixelGpuRenderTest, HeavyPresetsRenderTheSameOnBothPaths)
{
    int checked = 0;
    int refused = 0;
    std::vector<std::string> visiblyDifferent;

    for (const auto* name : kHeavyPresets)
    {
        const std::string path = std::string(PROJECTM_WEEKS_PRESETS_DIR) + "/" + name;
        if (!std::filesystem::exists(path))
        {
            continue;
        }

        std::string reason;
        if (!Lowers(path, reason))
        {
            refused++;
            std::cout << "[  RENDER  ] " << name << ": stays on CPU (" << reason << ")\n";
            continue;
        }

        FrameDifference shortRun;
        if (!CompareBothPaths(path, kShortFrames, shortRun))
        {
            continue;
        }
        FrameDifference longRun;
        if (!CompareBothPaths(path, kLongFrames, longRun))
        {
            continue;
        }
        checked++;

        std::cout << "[  RENDER  ] " << name << ": " << kShortFrames << " frames mean "
                  << shortRun.meanAbsolute << " differing " << shortRun.differingShare * 100.0
                  << "%, " << kLongFrames << " frames mean " << longRun.meanAbsolute
                  << " differing " << longRun.differingShare * 100.0 << "%\n";

        // The hard bar catches a fault: a channel not wired through, a uniform never
        // uploaded, a seed missed. Any of those redraws the picture, which lands in the
        // tens for the mean and in the tens of percent for the differing share.
        EXPECT_LE(shortRun.differingShare, kFaultDifferingShare)
            << name << ": " << shortRun.differingShare * 100.0
            << "% of channels differ by more than 8/255 after " << kShortFrames << " frames";
        EXPECT_LE(shortRun.meanAbsolute, kFaultMeanAbsolute)
            << name << ": mean channel difference " << shortRun.meanAbsolute << " after "
            << kShortFrames << " frames";

        if (shortRun.differingShare > kCloseDifferingShare ||
            shortRun.meanAbsolute > kCloseMeanAbsolute)
        {
            visiblyDifferent.push_back(name);
        }
    }

    std::cout << "[  RENDER  ] " << checked << " heavy presets rendered on the GPU path, "
              << refused << " stayed on the CPU\n";
    for (const auto& name : visiblyDifferent)
    {
        std::cout << "[  RENDER  ]   visibly different at " << kShortFrames << " frames: "
                  << name << "\n";
    }

    EXPECT_GE(checked, 5) << "fewer than five heavy presets reach the GPU per-pixel path";
    EXPECT_LE(visiblyDifferent.size(), kVisiblyDifferentBudget)
        << visiblyDifferent.size() << " of " << checked
        << " presets differ visibly between the two paths; the budget is "
        << kVisiblyDifferentBudget;
}
