// Unit tests for the HLSL-to-WGSL generator (vendor/hlslparser/src/WGSLGenerator.cpp), the
// shader path of the WebGPU backend (docs/adr/0002-wgsl-shader-path.md). The corpus-wide checks
// are PresetCompatWgsl (PresetCompatTest.cpp) and scripts/check_wgsl_corpus.sh.

#include <gtest/gtest.h>

#ifdef PROJECTM_WGSL_EMIT

#include <MilkdropPreset/MilkdropShader.hpp>
#include <MilkdropPreset/ShaderTranspiler.hpp>

#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <set>
#include <string>

namespace ShaderTranspiler = libprojectM::MilkdropPreset::ShaderTranspiler;
using libprojectM::MilkdropPreset::MilkdropFrameUniforms;
using M4::WGSLGenerator;

namespace {

/**
 * @brief Transpiles a preset shader ("shader_body { ... }" plus anything before it) to WGSL,
 *        declaring sampler_main and the given extra samplers like the engine does.
 */
auto Transpile(ShaderTranspiler::ShaderType type, std::string code, ShaderTranspiler::WgslShader& shader, std::string& error,
               const std::set<std::string>& extraSamplers = {}) -> bool
{
    ShaderTranspiler::PreprocessPresetShader(type, code);
    std::set<std::string> samplers{"uniform sampler2D sampler_main;\n"};
    std::set<std::string> texSizes{"uniform float4 texsize_main;\n"};
    for (const auto& name : extraSamplers)
    {
        samplers.insert("uniform sampler2D sampler_" + name + ";\n");
        texSizes.insert("uniform float4 texsize_" + name + ";\n");
    }
    return ShaderTranspiler::TranspileToWgsl(code, samplers, texSizes, shader, error);
}

auto TranspileComposite(const std::string& code, std::string* errorOut = nullptr) -> ShaderTranspiler::WgslShader
{
    ShaderTranspiler::WgslShader shader;
    std::string error;
    const bool ok = Transpile(ShaderTranspiler::ShaderType::CompositeShader, code, shader, error);
    if (errorOut != nullptr)
    {
        *errorOut = error;
    }
    else
    {
        EXPECT_TRUE(ok) << error;
    }
    return shader;
}

auto Contains(const std::string& haystack, const std::string& needle) -> bool
{
    return haystack.find(needle) != std::string::npos;
}

/**
 * @brief Validates @a code with naga when PROJECTM_NAGA names the binary; returns an empty string
 *        if valid or naga is not configured, else naga's output.
 */
auto NagaErrors(const std::string& code) -> std::string
{
    const char* naga = std::getenv("PROJECTM_NAGA");
    if (naga == nullptr || *naga == 0)
    {
        return {};
    }
    const auto dir = std::filesystem::temp_directory_path();
    const auto source = dir / ("projectm-wgsl-test-" + std::to_string(std::hash<std::string>{}(code)) + ".wgsl");
    const auto log = std::filesystem::path(source).replace_extension(".log");
    std::ofstream(source) << code;
    const std::string command = std::string("\"") + naga + "\" \"" + source.string() + "\" > \"" + log.string() + "\" 2>&1";
    const int status = std::system(command.c_str());
    std::string output;
    if (status != 0)
    {
        std::ifstream file(log);
        output.assign(std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>());
        if (output.empty())
        {
            output = "naga failed";
        }
    }
    std::filesystem::remove(source);
    std::filesystem::remove(log);
    return output;
}

} // namespace

TEST(WgslGenerator, FrameBlockLayoutMatchesMilkdropFrameUniforms)
{
    // The host fills the WGSL uniform buffer with the same struct it gives the GLSL std140 block,
    // so every member must sit at the same offset. The layout comes from the tree, not from
    // parsing the output.
    const auto shader = TranspileComposite("shader_body { ret = tex2D(sampler_main, uv).xyz; }");
    const auto* frame = shader.reflection.FindBinding(MilkdropFrameUniforms::BlockName);
    ASSERT_NE(frame, nullptr);
    EXPECT_EQ(frame->kind, WGSLGenerator::BindingKind_UniformBuffer);
    EXPECT_EQ(frame->group, 0u);
    EXPECT_EQ(frame->size, sizeof(MilkdropFrameUniforms));

    auto offsetOf = [&](const std::string& name) -> long {
        for (const auto& member : frame->members)
        {
            if (member.name == name)
            {
                return static_cast<long>(member.offset);
            }
        }
        return -1;
    };
    EXPECT_EQ(offsetOf("rand_frame"), static_cast<long>(offsetof(MilkdropFrameUniforms, randFrame)));
    EXPECT_EQ(offsetOf("rand_preset"), static_cast<long>(offsetof(MilkdropFrameUniforms, randPreset)));
    for (int i = 0; i < 18; i++)
    {
        EXPECT_EQ(offsetOf("_c" + std::to_string(i)), static_cast<long>(offsetof(MilkdropFrameUniforms, c) + i * 16)) << "_c" << i;
    }
    const char* banks[] = {"_qa", "_qb", "_qc", "_qd", "_qe", "_qf", "_qg", "_qh"};
    for (int i = 0; i < 8; i++)
    {
        EXPECT_EQ(offsetOf(banks[i]), static_cast<long>(offsetof(MilkdropFrameUniforms, q) + i * 16)) << banks[i];
    }
    const char* rotations[] = {"rot_s1", "rot_s2", "rot_s3", "rot_s4", "rot_d1", "rot_d2", "rot_d3", "rot_d4",
                               "rot_f1", "rot_f2", "rot_f3", "rot_f4", "rot_vf1", "rot_vf2", "rot_vf3", "rot_vf4",
                               "rot_uf1", "rot_uf2", "rot_uf3", "rot_uf4", "rot_rand1", "rot_rand2", "rot_rand3", "rot_rand4"};
    for (int i = 0; i < 24; i++)
    {
        EXPECT_EQ(offsetOf(rotations[i]), static_cast<long>(offsetof(MilkdropFrameUniforms, rot) + i * 48)) << rotations[i];
    }
    EXPECT_TRUE(Contains(shader.code, "rot_s1: mat3x4f,")) << "float4x3 is three columns of vec4, like the std140 mat3x4";
}

TEST(WgslGenerator, SamplersAreTextureAndSamplerPairsInTheTextureGroup)
{
    ShaderTranspiler::WgslShader shader;
    std::string error;
    ASSERT_TRUE(Transpile(ShaderTranspiler::ShaderType::CompositeShader,
                          "shader_body { ret = tex2D(sampler_main, uv).xyz + tex2D(sampler_noise_lq, uv).xyz * texsize_noise_lq.x; }",
                          shader, error, {"noise_lq"}))
        << error;

    const auto& reflection = shader.reflection;
    EXPECT_EQ(reflection.entryPoint, "fs_main");
    for (const char* name : {"sampler_main", "sampler_noise_lq"})
    {
        const auto* texture = reflection.FindBinding(std::string(name) + "_tex");
        const auto* sampler = reflection.FindBinding(std::string(name) + "_smp");
        ASSERT_NE(texture, nullptr) << name;
        ASSERT_NE(sampler, nullptr) << name;
        EXPECT_EQ(texture->kind, WGSLGenerator::BindingKind_Texture2D);
        EXPECT_EQ(sampler->kind, WGSLGenerator::BindingKind_Sampler);
        EXPECT_EQ(texture->group, 1u);
        EXPECT_EQ(sampler->binding, texture->binding + 1);
        EXPECT_EQ(texture->sourceName, name);
    }
    EXPECT_TRUE(Contains(shader.code, "textureSample(sampler_noise_lq_tex, sampler_noise_lq_smp, "));

    // Plain uniforms (texsize_*) are one block next to the frame block.
    const auto* globals = reflection.FindBinding(WGSLGenerator::kGlobalsBlockName);
    ASSERT_NE(globals, nullptr);
    EXPECT_EQ(globals->group, 0u);
    EXPECT_EQ(globals->members.size(), 2u);
    EXPECT_EQ(globals->size, 32u);
    EXPECT_TRUE(Contains(shader.code, "pmw_globals.texsize_noise_lq.x"));
    EXPECT_EQ(NagaErrors(shader.code), "");
}

TEST(WgslGenerator, WarpEntryPointWritesBothRenderTargets)
{
    ShaderTranspiler::WgslShader shader;
    std::string error;
    ASSERT_TRUE(Transpile(ShaderTranspiler::ShaderType::WarpShader, "shader_body { ret = tex2D(sampler_main, uv).xyz; }", shader, error)) << error;

    // COLOR0 is the image, COLOR1 the motion-vector UVs (ShaderTranspiler's warp signature).
    ASSERT_EQ(shader.reflection.outputs.size(), 2u);
    EXPECT_EQ(shader.reflection.outputs[0].location, 0);
    EXPECT_EQ(shader.reflection.outputs[1].location, 1);
    // Inputs: TEXCOORDn at location n, COLORn at 8 + n.
    ASSERT_EQ(shader.reflection.inputs.size(), 3u);
    EXPECT_EQ(shader.reflection.inputs[0].semantic, "COLOR");
    EXPECT_EQ(shader.reflection.inputs[0].location, 8);
    EXPECT_EQ(shader.reflection.inputs[1].location, 0);
    EXPECT_EQ(shader.reflection.inputs[1].type, "vec4f");
    EXPECT_EQ(shader.reflection.inputs[2].location, 1);
    EXPECT_TRUE(Contains(shader.code, "@fragment\nfn fs_main(pmw_in: PmwFragmentInput) -> PmwFragmentOutput"));
    EXPECT_EQ(NagaErrors(shader.code), "");
}

TEST(WgslGenerator, AssignmentToASwizzleOfTheUvMacroIsLowered)
{
    // uv is "_uv.xy": uv.y = ... assigns through a swizzle of a swizzle, and uv.xy *= ... to a
    // multi-component swizzle, which WGSL cannot address.
    const auto shader = TranspileComposite("shader_body {\n"
                                           "uv.y = uv.y - 0.1;\n"
                                           "uv.xy *= 2;\n"
                                           "ret.xz = float2(0.5, 0.25);\n"
                                           "ret.y = tex2D(sampler_main, uv).y;\n"
                                           "}");
    EXPECT_TRUE(Contains(shader.code, "_uv.y = (_uv.xy.y - 0.1);")) << shader.code;
    EXPECT_TRUE(Contains(shader.code, "_uv.x = pmw_t")) << shader.code;
    EXPECT_TRUE(Contains(shader.code, "ret.z = pmw_t")) << shader.code;
    EXPECT_EQ(NagaErrors(shader.code), "");
}

TEST(WgslGenerator, KeepsTheGlslPathsMilkdropSemantics)
{
    const auto shader = TranspileComposite("shader_body {\n"
                                           "float a = pow(-2.0, 1);\n"     // pow(x, 1) is x, also for x < 0
                                           "float b = pow(uv.x, 2.0);\n"   // abs() of the base otherwise
                                           "float c = sqrt(uv.x - 0.5);\n" // and of sqrt/log arguments
                                           "float d = uv.x % 0.3;\n"       // GLSL's floor-based mod()
                                           "float e = acos(uv.x * 3);\n"   // DX9's acos beyond [-1, 1]
                                           "ret = a * b * c * d * e;\n"    // DX9's 0 * x = 0
                                           "}");
    EXPECT_TRUE(Contains(shader.code, "var a: f32 = ((-(2.0)));")) << shader.code;
    EXPECT_TRUE(Contains(shader.code, "pow(abs(_uv.xy.x), 2.0)")) << shader.code;
    EXPECT_TRUE(Contains(shader.code, "sqrt(abs((_uv.xy.x - 0.5)))")) << shader.code;
    EXPECT_TRUE(Contains(shader.code, "pmw_mod_f32(_uv.xy.x, 0.3)")) << shader.code;
    EXPECT_TRUE(Contains(shader.code, "fn pmw_acos_f32(x: f32) -> f32")) << shader.code;
    EXPECT_TRUE(Contains(shader.code, "fn pmw_mul_f32(x: f32, y: f32) -> f32")) << shader.code;
    EXPECT_TRUE(Contains(shader.code, "x - y * floor(x / y)")) << shader.code;
    EXPECT_EQ(NagaErrors(shader.code), "");
}

TEST(WgslGenerator, RenamesWgslReservedWordsAndOverloads)
{
    const auto shader = TranspileComposite("float3 shade(float3 c) { return c * 2; }\n"
                                           "float3 shade(float c) { return c; }\n"
                                           "shader_body {\n"
                                           "float target = 0.5;\n" // reserved in WGSL
                                           "float3 filter = 1;\n"  // reserved in WGSL
                                           "float step = 2;\n"     // a WGSL builtin, shadowed
                                           "ret = shade(filter) + shade(target) * step;\n"
                                           "}");
    EXPECT_TRUE(Contains(shader.code, "var pmw_u_target: f32")) << shader.code;
    EXPECT_TRUE(Contains(shader.code, "var pmw_u_filter: vec3f")) << shader.code;
    EXPECT_TRUE(Contains(shader.code, "var pmw_u_step: f32")) << shader.code;
    EXPECT_TRUE(Contains(shader.code, "fn shade(")) << shader.code;
    EXPECT_TRUE(Contains(shader.code, "fn shade_1(")) << shader.code;
    EXPECT_EQ(NagaErrors(shader.code), "");
}

TEST(WgslGenerator, MatrixConstructorsAreRowMajorLikeHlsl)
{
    // HLSL lists float2x3 elements by row; WGSL's mat3x2f constructor takes columns.
    const auto shader = TranspileComposite("shader_body {\n"
                                           "float2x3 m = float2x3(1.0, 2.0, 3.0, 4.0, 5.0, 6.0);\n"
                                           "float3 row = m[1];\n"
                                           "ret = mul(m, float3(uv, 1)).xyy + row + m._m01;\n"
                                           "}");
    // Columns (1, 4), (2, 5), (3, 6).
    EXPECT_TRUE(Contains(shader.code, "return mat3x2f(a0, d0, b0, e0, c0, f0);")) << shader.code;
    EXPECT_TRUE(Contains(shader.code, "fn pmw_row_mat3x2f(m: mat3x2f, i: i32) -> vec3f")) << shader.code;
    EXPECT_TRUE(Contains(shader.code, "m[1][0]")) << "_m01 is row 0, column 1" << shader.code;
    EXPECT_EQ(NagaErrors(shader.code), "");
}

TEST(WgslGenerator, ArrayInitializedFromAFlatComponentList)
{
    const auto shader = TranspileComposite("shader_body {\n"
                                           "float4 k[2] = { 0, 1, 2, 3, 4, 5, 6, 7 };\n"
                                           "ret = k[1].xyz;\n"
                                           "}");
    EXPECT_TRUE(Contains(shader.code, "array<vec4f, 2>(vec4f(0.0, 1.0, 2.0, 3.0), vec4f(4.0, 5.0, 6.0, 7.0))")) << shader.code;
    EXPECT_EQ(NagaErrors(shader.code), "");
}

TEST(WgslGenerator, UnsupportedConstructsFailWithAReason)
{
    std::string error;
    TranspileComposite("uniform samplerCUBE sampler_cube;\nshader_body { ret = texCUBE(sampler_cube, float3(uv, 1)).xyz; }", &error);
    EXPECT_TRUE(Contains(error, "WGSL generating failed")) << error;
    EXPECT_TRUE(Contains(error, "only 2D and 3D samplers")) << error;
}

#endif // PROJECTM_WGSL_EMIT
