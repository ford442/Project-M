#pragma once

#include <string>

/**
 * @brief Minimal EGL pbuffer context for headless OpenGL unit tests.
 *
 * Skips initialization when EGL is unavailable (e.g. some CI images without a GPU stack).
 * Only desktop Linux has a backend; everywhere else the constructor leaves IsValid() false
 * and Reason() says why, so callers can GTEST_SKIP().
 */
class GlOffscreenContext
{
public:
    GlOffscreenContext();
    ~GlOffscreenContext();

    GlOffscreenContext(const GlOffscreenContext&) = delete;
    auto operator=(const GlOffscreenContext&) -> GlOffscreenContext& = delete;

    [[nodiscard]] auto IsValid() const -> bool;
    [[nodiscard]] auto Reason() const -> const std::string&;

private:
    void* m_display{nullptr};
    void* m_surface{nullptr};
    void* m_context{nullptr};
    bool m_valid{false};
    std::string m_reason;
};
