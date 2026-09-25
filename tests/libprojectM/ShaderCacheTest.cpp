// Shader program caching: the bounded cache for per-preset programs, the per-program
// uniform location cache, and the hash their keys are built from.
//
// The GPU per-pixel path (docs/GPU_PERPIXEL_EVAL.md) compiles one warp program per preset.
// Those go into the instance ShaderCache as evictable entries, so a long session does not
// keep every program it has ever built, and their keys hash the generated source with a
// 64-bit FNV-1a, because std::hash is 32 bits on wasm32.

#include "Renderer/ShaderCache.hpp"
#include "HeadlessGlContext.hpp"
#include "Renderer/OpenGL.h"
#include "Renderer/Shader.hpp"

#include <Utils.hpp>

#include <gtest/gtest.h>

#include <array>
#include <memory>
#include <string>

namespace {

using libprojectM::Renderer::Shader;
using libprojectM::Renderer::ShaderCache;
using libprojectM::Test::HeadlessGlContext;

constexpr const char* kVertexShader = R"(#version 330
layout(location = 0) in vec2 position;
uniform float scale;
uniform vec4 offsets[8];
void main()
{
    gl_Position = vec4(position * scale + offsets[0].xy + offsets[7].zw, 0.0, 1.0);
}
)";

constexpr const char* kFragmentShader = R"(#version 330
uniform vec4 tint;
out vec4 color;
void main()
{
    color = tint;
}
)";

auto MakeShader() -> std::shared_ptr<Shader>
{
    auto shader = std::make_shared<Shader>();
    shader->CompileProgram(kVertexShader, kFragmentShader);
    return shader;
}

/** @brief Reads the first component of a uniform back from the currently bound program. */
auto ReadUniform(const char* name) -> float
{
    GLint program = 0;
    glGetIntegerv(GL_CURRENT_PROGRAM, &program);
    // Room for the widest type the tests use: glGetUniformfv writes every component.
    std::array<float, 16> value{};
    glGetUniformfv(static_cast<GLuint>(program), glGetUniformLocation(static_cast<GLuint>(program), name), value.data());
    return value[0];
}

} // namespace

TEST(Fnv1a64Test, MatchesTheReferenceVectors)
{
    // From the FNV reference test suite.
    EXPECT_EQ(libprojectM::Utils::Fnv1a64(""), 0xcbf29ce484222325ull);
    EXPECT_EQ(libprojectM::Utils::Fnv1a64("a"), 0xaf63dc4c8601ec8cull);
    EXPECT_EQ(libprojectM::Utils::Fnv1a64("foobar"), 0x85944171f73967e8ull);
}

class ShaderCacheTest : public ::testing::Test
{
protected:
    void SetUp() override
    {
        if (!HeadlessGlContext::IsAvailable())
        {
            GTEST_SKIP() << "Headless OpenGL context is unavailable on this platform.";
        }
        m_glContext = std::make_unique<HeadlessGlContext>();
        if (!m_glContext->Valid() || !m_glContext->InitializeGlad())
        {
            GTEST_SKIP() << "Failed to create headless OpenGL context for shader cache tests.";
        }
        while (glGetError() != GL_NO_ERROR)
        {
        }
    }

    void TearDown() override
    {
        if (m_glContext)
        {
            Shader::Unbind();
            EXPECT_EQ(glGetError(), static_cast<GLenum>(GL_NO_ERROR));
        }
    }

    std::unique_ptr<HeadlessGlContext> m_glContext;
};

TEST_F(ShaderCacheTest, EvictableEntriesAreBoundedLeastRecentlyUsedFirst)
{
    ShaderCache cache;
    cache.SetEvictableCapacity(3);

    const auto permanent = MakeShader();
    cache.Insert("built-in", permanent);

    cache.InsertEvictable("a", MakeShader());
    cache.InsertEvictable("b", MakeShader());
    cache.InsertEvictable("c", MakeShader());
    EXPECT_EQ(cache.EvictableCount(), 3u);

    // Using "a" makes "b" the least recently used one.
    EXPECT_NE(cache.Get("a"), nullptr);
    cache.InsertEvictable("d", MakeShader());

    EXPECT_EQ(cache.EvictableCount(), 3u);
    EXPECT_NE(cache.Get("a"), nullptr);
    EXPECT_EQ(cache.Get("b"), nullptr);
    EXPECT_NE(cache.Get("c"), nullptr);
    EXPECT_NE(cache.Get("d"), nullptr);

    // Permanent entries neither count against the capacity nor get evicted.
    cache.SetEvictableCapacity(0);
    EXPECT_EQ(cache.EvictableCount(), 0u);
    EXPECT_EQ(cache.Get("built-in"), permanent);
}

TEST_F(ShaderCacheTest, EvictionDropsOnlyTheCachesReference)
{
    ShaderCache cache;
    cache.SetEvictableCapacity(1);

    auto inUse = MakeShader();
    std::weak_ptr<Shader> unused = [&cache] {
        auto shader = MakeShader();
        cache.InsertEvictable("unused", shader);
        return std::weak_ptr<Shader>(shader);
    }();
    EXPECT_FALSE(unused.expired());

    // A preset still drawing with an evicted program keeps it alive...
    cache.InsertEvictable("in-use", inUse);
    EXPECT_TRUE(unused.expired()) << "an evicted program nobody holds must be deleted";

    cache.InsertEvictable("next", MakeShader());
    EXPECT_EQ(cache.Get("in-use"), nullptr);
    ASSERT_NE(inUse, nullptr);
    inUse->Bind();
    EXPECT_EQ(glGetError(), static_cast<GLenum>(GL_NO_ERROR)) << "...and it is still a valid program";
}

TEST_F(ShaderCacheTest, ReinsertingAKeyKeepsTheExistingEntry)
{
    ShaderCache cache;
    const auto first = MakeShader();
    cache.InsertEvictable("key", first);
    cache.InsertEvictable("key", MakeShader());
    EXPECT_EQ(cache.Get("key"), first);
    EXPECT_EQ(cache.EvictableCount(), 1u);

    cache.Remove("key");
    EXPECT_EQ(cache.Get("key"), nullptr);
    EXPECT_EQ(cache.EvictableCount(), 0u);
}

TEST_F(ShaderCacheTest, CachedUniformLocationsSetTheRightUniforms)
{
    auto shader = MakeShader();
    shader->Bind();

    // Twice each: the second call is served from the location cache.
    for (int pass = 0; pass < 2; pass++)
    {
        const float scale = 0.5f + static_cast<float>(pass);
        shader->SetUniformFloat("scale", scale);
        shader->SetUniformFloat4("tint", {0.25f, 0.5f, 0.75f, 1.0f});
        EXPECT_FLOAT_EQ(ReadUniform("scale"), scale);
        EXPECT_FLOAT_EQ(ReadUniform("tint"), 0.25f);
    }

    // A name the program does not have is a silent no-op, before and after caching.
    shader->SetUniformFloat("no_such_uniform", 1.0f);
    shader->SetUniformFloat("no_such_uniform", 2.0f);
    EXPECT_EQ(glGetError(), static_cast<GLenum>(GL_NO_ERROR));
}

TEST_F(ShaderCacheTest, ArrayUniformIsSetInOneCall)
{
    auto shader = MakeShader();
    shader->Bind();

    std::array<glm::vec4, 8> offsets;
    for (std::size_t index = 0; index < offsets.size(); index++)
    {
        offsets[index] = glm::vec4(static_cast<float>(index), 0.0f, 0.0f, 0.0f);
    }
    shader->SetUniformFloat4Array("offsets", offsets.data(), static_cast<int>(offsets.size()));

    // The program reads elements 0 and 7 only; the ones in between are ignored by GL.
    EXPECT_FLOAT_EQ(ReadUniform("offsets[0]"), 0.0f);
    EXPECT_FLOAT_EQ(ReadUniform("offsets[7]"), 7.0f);
}

TEST_F(ShaderCacheTest, RelinkingForgetsCachedLocations)
{
    auto shader = MakeShader();
    shader->Bind();
    shader->SetUniformFloat("scale", 3.0f);

    // A program with the same uniform names declared in a different order, so the
    // locations are free to move. A stale cache would write the wrong uniform.
    constexpr const char* kReordered = R"(#version 330
layout(location = 0) in vec2 position;
uniform vec4 offsets[8];
uniform float padding[5];
uniform float scale;
void main()
{
    gl_Position = vec4(position * scale + offsets[0].xy + padding[4], 0.0, 1.0);
}
)";
    shader->CompileProgram(kReordered, kFragmentShader);
    shader->Bind();
    shader->SetUniformFloat("scale", 4.0f);
    EXPECT_FLOAT_EQ(ReadUniform("scale"), 4.0f);
}
