#include "GlOffscreenContext.hpp"

#include <EGL/egl.h>

GlOffscreenContext::GlOffscreenContext()
{
    EGLDisplay display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    if (display == EGL_NO_DISPLAY)
    {
        m_reason = "eglGetDisplay failed";
        return;
    }

    EGLint major = 0;
    EGLint minor = 0;
    if (!eglInitialize(display, &major, &minor))
    {
        m_reason = "eglInitialize failed";
        return;
    }

    const EGLint configAttribs[] = {
        EGL_SURFACE_TYPE, EGL_PBUFFER_BIT,
        EGL_RENDERABLE_TYPE, EGL_OPENGL_BIT,
        EGL_RED_SIZE, 8,
        EGL_GREEN_SIZE, 8,
        EGL_BLUE_SIZE, 8,
        EGL_ALPHA_SIZE, 8,
        EGL_DEPTH_SIZE, 0,
        EGL_STENCIL_SIZE, 0,
        EGL_NONE,
    };

    EGLConfig config = nullptr;
    EGLint configCount = 0;
    if (!eglChooseConfig(display, configAttribs, &config, 1, &configCount) || configCount == 0)
    {
        m_reason = "eglChooseConfig failed";
        eglTerminate(display);
        return;
    }

    const EGLint pbufferAttribs[] = {
        EGL_WIDTH, 64,
        EGL_HEIGHT, 64,
        EGL_NONE,
    };

    EGLSurface surface = eglCreatePbufferSurface(display, config, pbufferAttribs);
    if (surface == EGL_NO_SURFACE)
    {
        m_reason = "eglCreatePbufferSurface failed";
        eglTerminate(display);
        return;
    }

    if (!eglBindAPI(EGL_OPENGL_API))
    {
        m_reason = "eglBindAPI(EGL_OPENGL_API) failed";
        eglDestroySurface(display, surface);
        eglTerminate(display);
        return;
    }

    EGLContext context = eglCreateContext(display, config, EGL_NO_CONTEXT, nullptr);
    if (context == EGL_NO_CONTEXT)
    {
        m_reason = "eglCreateContext failed";
        eglDestroySurface(display, surface);
        eglTerminate(display);
        return;
    }

    if (!eglMakeCurrent(display, surface, surface, context))
    {
        m_reason = "eglMakeCurrent failed";
        eglDestroyContext(display, context);
        eglDestroySurface(display, surface);
        eglTerminate(display);
        return;
    }

    m_display = display;
    m_surface = surface;
    m_context = context;
    m_valid = true;
}

GlOffscreenContext::~GlOffscreenContext()
{
    if (!m_valid)
    {
        return;
    }

    auto* display = static_cast<EGLDisplay>(m_display);
    auto* surface = static_cast<EGLSurface>(m_surface);
    auto* context = static_cast<EGLContext>(m_context);

    eglMakeCurrent(display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    eglDestroyContext(display, context);
    eglDestroySurface(display, surface);
    eglTerminate(display);
}

auto GlOffscreenContext::IsValid() const -> bool
{
    return m_valid;
}

auto GlOffscreenContext::Reason() const -> const std::string&
{
    return m_reason;
}
