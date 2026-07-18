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
