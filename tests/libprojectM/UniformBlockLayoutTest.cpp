/**
 * @file UniformBlockLayoutTest.cpp
 * @brief The std140 blocks of the built-in shaders against their C++ mirrors (GPU).
 *
 * Every value a built-in program reads is a member of a uniform block that C++ fills as a
 * struct (Renderer/UniformBlocks.hpp, MilkdropFrameUniforms, PerPixelUniforms). The structs'
 * static_asserts check the offsets std140 says; this test checks what the driver actually laid
 * out. A link observer records every built-in block of every program the engine links while it
 * renders presets with transitions, the blur chain, motion vectors, textured shapes, waves,
 * GPU per-pixel code, user sprites and the flash limiter, on both copy and blur paths; then each
 * block's members, offsets, size and slot are compared with the struct. A block no program
 * declared fails too, so a renamed block cannot go unchecked.
 */
#include "HeadlessGlContext.hpp"

#include <MilkdropPreset/MilkdropShader.hpp>
#include <MilkdropPreset/PerPixelGlslLowering.hpp>
#include <Renderer/Shader.hpp>
#include <Renderer/UniformBlocks.hpp>

#include "TestGl.hpp"

#include <src/wasm/WasmCompositorShader.hpp>

#include <gtest/gtest.h>

#include <projectM-4/projectM.h>

#include <cstddef>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

namespace {

namespace Renderer = libprojectM::Renderer;
using libprojectM::MilkdropPreset::MilkdropFrameUniforms;
using libprojectM::MilkdropPreset::PerPixelGlslLowering;
using libprojectM::MilkdropPreset::PerPixelUniforms;

/** @brief One block as the driver laid it out in one program. */
struct LinkedBlock {
    GLint dataSize{};
    GLint binding{};
    std::map<std::string, GLint> offsets; //!< By member name ("u_pp_q[0]" for an array).
};

/** @brief One block as its struct says it is. */
struct ExpectedBlock {
    size_t size{};
    int slot{};
    std::map<std::string, size_t> offsets;
};

#define PM_MEMBER(Struct, member) static_cast<size_t>(offsetof(Struct, member))

auto ExpectedBlocks() -> std::map<std::string, ExpectedBlock>
{
    std::map<std::string, ExpectedBlock> blocks;

    {
        using S = MilkdropFrameUniforms;
        auto& block = blocks[S::BlockName];
        block = {sizeof(S), S::Slot, {{"rand_frame", PM_MEMBER(S, randFrame)}, {"rand_preset", PM_MEMBER(S, randPreset)}}};
        for (int i = 0; i < 18; i++)
        {
            block.offsets["_c" + std::to_string(i)] = PM_MEMBER(S, c) + 16 * static_cast<size_t>(i);
        }
        for (int i = 0; i < 8; i++)
        {
            block.offsets[std::string("_q") + static_cast<char>('a' + i)] = PM_MEMBER(S, q) + 16 * static_cast<size_t>(i);
        }
        const char* const rotations[] = {"s", "d", "f", "vf", "uf", "rand"};
        for (int group = 0; group < 6; group++)
        {
            for (int i = 0; i < 4; i++)
            {
                block.offsets[std::string("rot_") + rotations[group] + std::to_string(i + 1)] =
                    PM_MEMBER(S, rot) + 48 * static_cast<size_t>(group * 4 + i);
            }
        }
    }
    {
        using S = Renderer::TransformUniforms;
        blocks[S::BlockName] = {sizeof(S), S::Slot, {{"vertex_transformation", PM_MEMBER(S, vertexTransformation)}, {"vertex_point_size", PM_MEMBER(S, vertexPointSize)}}};
    }
    {
        using S = Renderer::CopyUniforms;
        blocks[S::BlockName] = {sizeof(S), S::Slot, {{"vertex_transformation", PM_MEMBER(S, vertexTransformation)}, {"u_transparencyEnabled", PM_MEMBER(S, transparencyEnabled)}, {"u_transparencyThreshold", PM_MEMBER(S, transparencyThreshold)}}};
    }
    {
        using S = Renderer::MotionVectorUniforms;
        blocks[S::BlockName] = {sizeof(S), S::Slot, {{"vertex_transformation", PM_MEMBER(S, vertexTransformation)}, {"length_multiplier", PM_MEMBER(S, lengthMultiplier)}, {"minimum_length", PM_MEMBER(S, minimumLength)}}};
    }
    {
        using S = Renderer::WarpUniforms;
        blocks[S::BlockName] = {sizeof(S), S::Slot, {{"vertex_transformation", PM_MEMBER(S, vertexTransformation)}, {"aspect", PM_MEMBER(S, aspect)}, {"warpFactors", PM_MEMBER(S, warpFactors)}, {"texelOffset", PM_MEMBER(S, texelOffset)}, {"warpTime", PM_MEMBER(S, warpTime)}, {"warpScaleInverse", PM_MEMBER(S, warpScaleInverse)}, {"decay", PM_MEMBER(S, decay)}, {"u_flipMainTex", PM_MEMBER(S, flipMainTex)}}};
    }
    {
        using S = Renderer::BlurUniforms;
        blocks[S::BlockName] = {sizeof(S), S::Slot, {{"_c0", PM_MEMBER(S, c0)}, {"_c1", PM_MEMBER(S, c1)}, {"_c2", PM_MEMBER(S, c2)}, {"_c3", PM_MEMBER(S, c3)}, {"_c5", PM_MEMBER(S, c5)}, {"_c6", PM_MEMBER(S, c6)}, {"flipVertical", PM_MEMBER(S, flipVertical)}}};
    }
    {
        using S = Renderer::TransitionUniforms;
        blocks[S::BlockName] = {sizeof(S), S::Slot, {
                                                        {"durationParams", PM_MEMBER(S, durationParams)},
                                                        {"iRandStatic", PM_MEMBER(S, randStatic)},
                                                        {"iRandFrame", PM_MEMBER(S, randFrame)},
                                                        {"iResolution", PM_MEMBER(S, resolution)},
                                                        {"iFrameRate", PM_MEMBER(S, frameRate)},
                                                        {"iBeatValues", PM_MEMBER(S, beatValues)},
                                                        {"iFrame", PM_MEMBER(S, frame)},
                                                        {"iBeatAttValues", PM_MEMBER(S, beatAttValues)},
                                                        {"iPass", PM_MEMBER(S, pass)},
                                                        {"timeParams", PM_MEMBER(S, timeParams)},
                                                        {"iAspectX", PM_MEMBER(S, aspectX)},
                                                        {"iAspectY", PM_MEMBER(S, aspectY)},
                                                        {"iInvAspectX", PM_MEMBER(S, invAspectX)},
                                                        {"iInvAspectY", PM_MEMBER(S, invAspectY)},
                                                        {"u_transparencyEnabled", PM_MEMBER(S, transparencyEnabled)},
                                                        {"u_transparencyThreshold", PM_MEMBER(S, transparencyThreshold)},
                                                        {"iBlendMode", PM_MEMBER(S, blendMode)},
                                                        {"iMaskBound", PM_MEMBER(S, maskBound)},
                                                    }};
    }
    {
        using S = Renderer::FlashLimiterUniforms;
        blocks[S::BlockName] = {sizeof(S), S::Slot, {{"threshold", PM_MEMBER(S, threshold)}, {"envelope_decay", PM_MEMBER(S, envelopeDecay)}, {"reset_history", PM_MEMBER(S, resetHistory)}, {"premultiplied_alpha", PM_MEMBER(S, premultipliedAlpha)}}};
    }
    {
        using S = Renderer::SpriteUniforms;
        blocks[S::BlockName] = {sizeof(S), S::Slot, {{"blend_mode", PM_MEMBER(S, blendMode)}}};
    }
    {
        using S = Renderer::CompositorUniforms;
        blocks[S::BlockName] = {sizeof(S), S::Slot, {{"uBlend", PM_MEMBER(S, blend)}, {"uDither", PM_MEMBER(S, dither)}, {"u_transparencyEnabled", PM_MEMBER(S, transparencyEnabled)}, {"u_transparencyThreshold", PM_MEMBER(S, transparencyThreshold)}}};
    }
    {
        using S = PerPixelUniforms;
        auto& block = blocks[S::BlockName];
        block = {sizeof(S), S::Slot, {{"u_pp_seed_transforms", PM_MEMBER(S, seedTransforms)}, {"u_pp_q[0]", PM_MEMBER(S, q)}, {"u_pp_seed_center", PM_MEMBER(S, seedCenter)}, {"u_pp_seed_distance", PM_MEMBER(S, seedDistance)}, {"u_pp_seed_stretch", PM_MEMBER(S, seedStretch)}}};
        for (int bit = 0; bit < S::ScalarCount; bit++)
        {
            block.offsets[PerPixelGlslLowering::ScalarUniformName(bit)] = PM_MEMBER(S, scalars) + 4 * static_cast<size_t>(bit);
        }
    }
    return blocks;
}

#undef PM_MEMBER

/** @brief Reads one block of a linked program; false if the program has no such block. */
auto ReadBlock(GLuint program, const char* name, LinkedBlock& block) -> bool
{
    const GLuint index = glGetUniformBlockIndex(program, name);
    if (index == GL_INVALID_INDEX)
    {
        return false;
    }
    glGetActiveUniformBlockiv(program, index, GL_UNIFORM_BLOCK_DATA_SIZE, &block.dataSize);
    glGetActiveUniformBlockiv(program, index, GL_UNIFORM_BLOCK_BINDING, &block.binding);
    GLint memberCount{};
    glGetActiveUniformBlockiv(program, index, GL_UNIFORM_BLOCK_ACTIVE_UNIFORMS, &memberCount);
    std::vector<GLint> members(static_cast<size_t>(memberCount));
    glGetActiveUniformBlockiv(program, index, GL_UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES, members.data());
    for (const GLint member : members)
    {
        const auto memberIndex = static_cast<GLuint>(member);
        GLint offset{-1};
        glGetActiveUniformsiv(program, 1, &memberIndex, GL_UNIFORM_OFFSET, &offset);
        std::array<char, 128> memberName{};
        GLsizei length{};
        glGetActiveUniformName(program, memberIndex, static_cast<GLsizei>(memberName.size()), &length, memberName.data());
        block.offsets[std::string(memberName.data(), static_cast<size_t>(length))] = offset;
    }
    return true;
}

class UniformBlockLayoutTest : public testing::Test
{
protected:
    static void SetUpTestSuite()
    {
        if (!libprojectM::Test::HeadlessGlContext::IsAvailable())
        {
            return;
        }
        s_context = std::make_unique<libprojectM::Test::HeadlessGlContext>();
        if (!s_context->Valid() || !s_context->InitializeGlad())
        {
            s_context.reset();
        }
    }

    static void TearDownTestSuite()
    {
        s_context.reset();
    }

    void SetUp() override
    {
        if (s_context == nullptr || !s_context->MakeCurrent())
        {
            GTEST_SKIP() << "could not create a headless OpenGL context";
        }
        Renderer::Shader::SetLinkObserverForTesting([this](Renderer::Device::ProgramHandle program) {
            for (const auto& builtIn : Renderer::BuiltInUniformBlocks)
            {
                LinkedBlock block;
                if (ReadBlock(program.id, builtIn.name, block))
                {
                    m_linked[builtIn.name].push_back(std::move(block));
                }
            }
        });
    }

    void TearDown() override
    {
        Renderer::Shader::SetLinkObserverForTesting({});
    }

    /** @brief Renders a few frames of one engine, through every built-in program it has. */
    void RenderEngine(uint32_t renderPathFlags)
    {
        projectm_handle instance = projectm_create();
        ASSERT_NE(instance, nullptr);
        projectm_set_render_path_flags(instance, renderPathFlags);
        projectm_set_window_size(instance, 64, 48);
        projectm_set_flash_limit_enabled(instance, true);
        projectm_set_soft_cut_duration(instance, 0.2);
        projectm_set_preset_locked(instance, true);
        // UserSpriteApiTest's sprite: one of the built-in images.
        EXPECT_NE(projectm_sprite_create(instance, "milkdrop",
                                         "[img01]\n"
                                         "img=rv_IP_20250421_060250\n"
                                         "init_1=blendmode=1; x=0.5; y=0.5; sx=1.0; sy=1.0;\n"
                                         "code_1=a=1; r=1.0; g=0.0; b=1.0;\n"),
                  0u);

        std::vector<float> pcm(1024);
        for (size_t i = 0; i < pcm.size(); i++)
        {
            pcm[i] = (i % 64 < 32) ? 0.5f : -0.5f;
        }

        double time = 0.0;
        const auto render = [&](int frames) {
            for (int frame = 0; frame < frames; frame++)
            {
                projectm_pcm_add_float(instance, pcm.data(), static_cast<unsigned int>(pcm.size() / 2), PROJECTM_STEREO);
                projectm_set_frame_time(instance, time);
                projectm_opengl_render_frame(instance);
                time += 1.0 / 30.0;
            }
        };

        projectm_load_preset_data(instance, kPresetWithEverything, false);
        render(4);
        // A soft cut to the same preset again: the transition shader.
        projectm_load_preset_data(instance, kPresetWithEverything, true);
        render(4);
        projectm_destroy(instance);
    }

    static std::unique_ptr<libprojectM::Test::HeadlessGlContext> s_context;
    std::map<std::string, std::vector<LinkedBlock>> m_linked;

    // Motion vectors, a textured and an untextured shape with a border, a wave, per-pixel code
    // the GPU path takes, a warp shader and a composite shader that reads the blur chain.
    static constexpr const char* kPresetWithEverything =
        "MILKDROP_PRESET_VERSION=201\n"
        "PSVERSION=3\n"
        "PSVERSION_WARP=3\n"
        "PSVERSION_COMP=3\n"
        "[preset00]\n"
        "fDecay=0.98\n"
        "zoom=1.01\n"
        "wave_mode=0\n"
        "wave_a=1\n"
        "nMotionVectorsX=12\n"
        "nMotionVectorsY=9\n"
        "mv_a=1\n"
        "mv_l=1\n"
        "shapecode_0_enabled=1\n"
        "shapecode_0_sides=4\n"
        "shapecode_0_textured=1\n"
        "shapecode_0_rad=0.3\n"
        "shapecode_0_a=1\n"
        "shapecode_0_border_a=1\n"
        "shapecode_1_enabled=1\n"
        "shapecode_1_sides=5\n"
        "shapecode_1_rad=0.2\n"
        "shapecode_1_a=1\n"
        "shapecode_1_border_a=1\n"
        "per_pixel_1=zoom = 1.01 + 0.01*sin(rad*bass) + q1*0.0;\n"
        "warp_1=`shader_body\n"
        "warp_2=`{\n"
        "warp_3=`ret = tex2D(sampler_main, uv).xyz * 0.98;\n"
        "warp_4=`}\n"
        "comp_1=`shader_body\n"
        "comp_2=`{\n"
        "comp_3=`ret = GetPixel(uv) * 0.5 + GetBlur1(uv) * 0.25 + GetBlur3(uv) * 0.25;\n"
        "comp_4=`}\n";
};

std::unique_ptr<libprojectM::Test::HeadlessGlContext> UniformBlockLayoutTest::s_context;

} // namespace

TEST_F(UniformBlockLayoutTest, EveryBuiltInBlockMatchesItsStruct)
{
    projectm_set_deterministic_seed(1);
    RenderEngine(0);
    RenderEngine(PROJECTM_RENDER_PATH_BLUR_COPY | PROJECTM_RENDER_PATH_COPY_SHADER);
    projectm_clear_deterministic_seed();

    // The compositor lives in the WASM host, which this build does not link: its program is
    // linked here from the same source.
    {
        auto toCore = [](std::string text) {
#ifndef USE_GLES
            const std::string esVersion = "#version 300 es";
            text.replace(text.find(esVersion), esVersion.size(), "#version 330 core");
#endif
            return text;
        };
        Renderer::Shader compositor;
        compositor.CompileProgram(toCore(kCompositorVertexShader), toCore(kCompositorFragmentShader));
    }

    const auto expected = ExpectedBlocks();
    ASSERT_EQ(expected.size(), Renderer::BuiltInUniformBlocks.size());
    for (const auto& builtIn : Renderer::BuiltInUniformBlocks)
    {
        SCOPED_TRACE(builtIn.name);
        const auto expectedBlock = expected.find(builtIn.name);
        ASSERT_NE(expectedBlock, expected.end()) << "no struct for the block";
        EXPECT_EQ(expectedBlock->second.slot, builtIn.slot);

        const auto linked = m_linked.find(builtIn.name);
        ASSERT_NE(linked, m_linked.end()) << "no program declared the block: renamed, or no longer drawn here";
        for (const auto& block : linked->second)
        {
            // std140 makes every member active, so the driver lists all of them.
            std::set<std::string> names;
            for (const auto& [name, offset] : block.offsets)
            {
                names.insert(name);
                const auto member = expectedBlock->second.offsets.find(name);
                if (member == expectedBlock->second.offsets.end())
                {
                    ADD_FAILURE() << "member " << name << " (offset " << offset << ") has no field in the struct";
                    continue;
                }
                EXPECT_EQ(static_cast<size_t>(offset), member->second) << name;
            }
            for (const auto& [name, offset] : expectedBlock->second.offsets)
            {
                EXPECT_EQ(names.count(name), 1u) << "the block has no member " << name;
            }
            // The struct may be padded past the block, never shorter than it.
            EXPECT_LE(static_cast<size_t>(block.dataSize), expectedBlock->second.size);
            EXPECT_EQ(block.binding, builtIn.slot);
        }
    }
    EXPECT_EQ(glGetError(), static_cast<GLenum>(GL_NO_ERROR));
}
