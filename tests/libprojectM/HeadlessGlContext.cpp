#include "HeadlessGlContext.hpp"

#if defined(__linux__) && !defined(__ANDROID__) && !defined(__EMSCRIPTEN__)

#include <glad/gl.h>

#include <SDL.h>
#include <SDL_opengl.h>

namespace libprojectM {
namespace Test {

namespace {

constexpr int kSurfaceWidth = 64;
constexpr int kSurfaceHeight = 64;

} // namespace

// The video subsystem is initialised and released with SDL_InitSubSystem() / SDL_QuitSubSystem(),
// which are reference counted, rather than SDL_Init() / SDL_Quit(): SDL_Quit() tears down every
// window and GL context in the process, including those of other contexts still alive in the same
// test run (e.g. the shared one in PresetCompatTest.cpp).
auto HeadlessGlContext::IsAvailable() -> bool
{
    if (SDL_InitSubSystem(SDL_INIT_VIDEO) != 0)
    {
        return false;
    }

    SDL_QuitSubSystem(SDL_INIT_VIDEO);
    return true;
}

HeadlessGlContext::HeadlessGlContext()
{
    if (SDL_InitSubSystem(SDL_INIT_VIDEO) != 0)
    {
        return;
    }

    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 3);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
    SDL_GL_SetAttribute(SDL_GL_DOUBLEBUFFER, 1);

    m_window = SDL_CreateWindow("projectM-unittest",
                                SDL_WINDOWPOS_CENTERED,
                                SDL_WINDOWPOS_CENTERED,
                                kSurfaceWidth,
                                kSurfaceHeight,
                                SDL_WINDOW_OPENGL | SDL_WINDOW_HIDDEN);
    if (m_window == nullptr)
    {
        SDL_QuitSubSystem(SDL_INIT_VIDEO);
        return;
    }

    m_context = SDL_GL_CreateContext(m_window);
    if (m_context == nullptr)
    {
        SDL_DestroyWindow(m_window);
        m_window = nullptr;
        SDL_QuitSubSystem(SDL_INIT_VIDEO);
        return;
    }

    if (SDL_GL_MakeCurrent(m_window, m_context) != 0)
    {
        SDL_GL_DeleteContext(m_context);
        m_context = nullptr;
        SDL_DestroyWindow(m_window);
        m_window = nullptr;
        SDL_QuitSubSystem(SDL_INIT_VIDEO);
        return;
    }

    m_valid = true;
}

HeadlessGlContext::~HeadlessGlContext()
{
    if (m_context != nullptr)
    {
        SDL_GL_DeleteContext(m_context);
        m_context = nullptr;
    }

    if (m_window != nullptr)
    {
        SDL_DestroyWindow(m_window);
        m_window = nullptr;
        SDL_QuitSubSystem(SDL_INIT_VIDEO);
    }
}

auto HeadlessGlContext::Valid() const -> bool
{
    return m_valid;
}

auto HeadlessGlContext::MakeCurrent() -> bool
{
    return m_valid && SDL_GL_MakeCurrent(m_window, m_context) == 0;
}

auto HeadlessGlContext::InitializeGlad() -> bool
{
    if (!m_valid)
    {
        return false;
    }

    return gladLoadGL(reinterpret_cast<GLADloadfunc>(SDL_GL_GetProcAddress)) != 0;
}

} // namespace Test
} // namespace libprojectM

#else

namespace libprojectM {
namespace Test {

auto HeadlessGlContext::IsAvailable() -> bool
{
    return false;
}

HeadlessGlContext::HeadlessGlContext() = default;

HeadlessGlContext::~HeadlessGlContext() = default;

auto HeadlessGlContext::Valid() const -> bool
{
    return false;
}

auto HeadlessGlContext::MakeCurrent() -> bool
{
    return false;
}

auto HeadlessGlContext::InitializeGlad() -> bool
{
    return false;
}

} // namespace Test
} // namespace libprojectM

#endif
