/**
 * @file ShaderTranspileCacheTest.cpp
 * @brief The transpiled-GLSL cache hooks may call back into ShaderTranspileCache.
 *
 * The hooks reach host code (JS in the WASM build), which can read the cache key or swap
 * the hooks from inside one. They used to run under the cache's non-recursive mutex, so a
 * re-entrant call deadlocked. Each case runs on a detached thread; on a timeout the binary
 * exits with a message, since the deadlocked thread holds the mutex every later test needs.
 */

#include <EngineContext.hpp>
#include <Renderer/ShaderTranspileCache.hpp>

#include <gtest/gtest.h>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <functional>
#include <future>
#include <memory>
#include <thread>

using namespace libprojectM::Renderer;

namespace {

/** Runs @a body on a detached thread; exits the process if it does not finish in time. */
void RunWithDeadline(const char* what, std::function<void()> body)
{
    auto done = std::make_shared<std::promise<void>>();
    auto finished = done->get_future();
    std::thread([body = std::move(body), done] {
        body();
        done->set_value();
    }).detach();
    if (finished.wait_for(std::chrono::seconds(5)) != std::future_status::ready)
    {
        std::fprintf(stderr, "ShaderTranspileCacheTest: %s deadlocked\n", what);
        std::fflush(stderr);
        std::_Exit(1);
    }
}

class ShaderTranspileCacheTest : public testing::Test
{
protected:
    void TearDown() override
    {
        ClearTranspiledGlslCacheCallbacks();
        ClearTranspiledGlslCacheKey();
    }
};

} // namespace

TEST_F(ShaderTranspileCacheTest, LookupHookMayReadTheKey)
{
    SetTranspiledGlslCacheKey("preset-a");
    SetTranspiledGlslCacheCallbacks(
        [](const std::string& cacheKey, int) -> std::optional<std::string> {
            return GetTranspiledGlslCacheKey() + "|" + cacheKey;
        },
        nullptr);

    std::optional<std::string> result;
    RunWithDeadline("a lookup hook reading the cache key", [&result] { result = LookupTranspiledGlsl("warp", 0); });
    EXPECT_EQ(result, std::optional<std::string>("preset-a|warp"));
}

TEST_F(ShaderTranspileCacheTest, StoreHookMayReplaceTheHooks)
{
    int stores = 0;
    SetTranspiledGlslCacheCallbacks(nullptr, [&stores](const std::string&, int, const std::string&) {
        ++stores;
        // A host tearing the cache down from inside its own store callback.
        ClearTranspiledGlslCacheCallbacks();
        SetTranspiledGlslCacheKey("next");
    });

    RunWithDeadline("a store hook calling back into the cache", [] { StoreTranspiledGlsl("comp", 1, "void main() {}"); });
    EXPECT_EQ(stores, 1);
    EXPECT_EQ(GetTranspiledGlslCacheKey(), "next");

    StoreTranspiledGlsl("comp", 1, "void main() {}");
    EXPECT_EQ(stores, 1) << "the hook cleared from inside itself still ran";
}

TEST_F(ShaderTranspileCacheTest, NoHooksAreNoOps)
{
    EXPECT_FALSE(LookupTranspiledGlsl("warp", 0).has_value());
    StoreTranspiledGlsl("warp", 0, "void main() {}");
}

// Each engine may have its own hooks and key; one that has neither uses the process ones.
TEST_F(ShaderTranspileCacheTest, EnginesHaveTheirOwnHooksAndKey)
{
    using libprojectM::EngineContext;
    using libprojectM::ScopedEngineContext;

    SetTranspiledGlslCacheKey("process-key");
    SetTranspiledGlslCacheCallbacks(
        [](const std::string&, int) -> std::optional<std::string> { return std::string("process"); }, nullptr);

    EngineContext follower;
    EngineContext own;
    SetTranspiledGlslCacheKey(own.TranspileCache(), std::string("own-key"));
    SetTranspiledGlslCacheCallbacks(
        own.TranspileCache(), [](const std::string&, int) -> std::optional<std::string> { return std::string("own"); }, nullptr);

    {
        const ScopedEngineContext scope(follower);
        EXPECT_EQ(GetTranspiledGlslCacheKey(), "process-key");
        EXPECT_EQ(LookupTranspiledGlsl("k", 0).value_or(""), "process");
    }
    {
        const ScopedEngineContext scope(own);
        EXPECT_EQ(GetTranspiledGlslCacheKey(), "own-key");
        EXPECT_EQ(LookupTranspiledGlsl("k", 0).value_or(""), "own");

        // Clearing inside an engine drops its own key, which falls back to the process one.
        ClearTranspiledGlslCacheKey();
        EXPECT_EQ(GetTranspiledGlslCacheKey(), "process-key");
    }
    EXPECT_EQ(GetTranspiledGlslCacheKey(), "process-key");
    EXPECT_EQ(LookupTranspiledGlsl("k", 0).value_or(""), "process");
}
