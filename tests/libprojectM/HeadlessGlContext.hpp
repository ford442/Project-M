#pragma once

struct SDL_Window;

namespace libprojectM {
namespace Test {

/**
 * @brief Minimal headless OpenGL 3.3 context for unit tests (SDL hidden window).
 *
 * Tests should call GTEST_SKIP() when IsAvailable() returns false.
 * On headless CI, run under xvfb-run.
 */
class HeadlessGlContext
{
public:
    static auto IsAvailable() -> bool;

    HeadlessGlContext();
    ~HeadlessGlContext();

    HeadlessGlContext(const HeadlessGlContext&) = delete;
    auto operator=(const HeadlessGlContext&) -> HeadlessGlContext& = delete;

    auto Valid() const -> bool;

    /**
     * @brief Makes this context current again, e.g. after another test made its own current.
     */
    auto MakeCurrent() -> bool;

    /**
     * @brief Makes no context current on this thread, so another thread can make this one current.
     */
    void ReleaseCurrent();

    /**
     * @brief Frees what SDL keeps per thread for a thread that made a context current.
     *
     * SDL_GL_MakeCurrent() stores the current window and context in SDL's thread-local storage, and
     * SDL only frees that for threads it started itself (SDL_CreateThread). A std::thread that makes
     * a context current must call this as its last act, after ReleaseCurrent(), or LeakSanitizer
     * reports the storage as leaked from inside libSDL2. Do not call it on the main thread.
     */
    static void ReleaseThreadResources();

    /**
     * @brief Loads GL entry points via GLAD after the context is current.
     */
    auto InitializeGlad() -> bool;

private:
    SDL_Window* m_window{nullptr};
    void* m_context{nullptr};
    bool m_valid{false};
};

} // namespace Test
} // namespace libprojectM
