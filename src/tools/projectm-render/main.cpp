/**
 * @file main.cpp
 * @brief projectm-render: renders a preset over an audio file, headless, frame by frame.
 *
 * Decodes FLAC, WAV or MP3 with dr_libs, creates a surfaceless EGL context, and drives
 * projectm_render_offline_frame() on a virtual clock. Writes raw RGBA frames (for ffmpeg) and/or
 * prints a hash of every pixel, so two runs can be compared. See docs/OFFLINE_RENDER.md.
 */

#define DR_FLAC_IMPLEMENTATION
#include <dr_flac.h>
#define DR_WAV_IMPLEMENTATION
#include <dr_wav.h>
#define DR_MP3_IMPLEMENTATION
#include <dr_mp3.h>

#ifdef USE_GLES
#include <glad/gles2.h>
#else
#include <glad/gl.h>
#endif

#include <EGL/egl.h>
#include <EGL/eglext.h>

#include <projectM-4/projectM.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace {

struct Options
{
    std::string preset;
    std::string audio;
    std::string output;
    std::string texturePath;
    int width{1280};
    int height{720};
    int fps{60};
    double duration{-1.0};
    uint32_t seed{0};
    bool hash{false};
};

void PrintUsage()
{
    std::fprintf(stderr,
                 "usage: projectm-render --preset FILE.milk [options]\n"
                 "  --audio FILE       FLAC, WAV or MP3 to visualize (default: silence)\n"
                 "  --duration SECS    seconds to render (default: the audio's length, or 10)\n"
                 "  --width N          frame width (default 1280)\n"
                 "  --height N         frame height (default 720)\n"
                 "  --fps N            frames per second (default 60)\n"
                 "  --seed N           random seed (default 0)\n"
                 "  --texture-path DIR where presets find their textures\n"
                 "  --output FILE      write raw RGBA frames, bottom row first ('-' for stdout)\n"
                 "  --hash             print a hash of all frames\n"
                 "Example: projectm-render --preset a.milk --audio song.flac --output - |\n"
                 "  ffmpeg -f rawvideo -pix_fmt rgba -s 1280x720 -r 60 -i - -vf vflip out.mp4\n");
}

auto ParseOptions(int argc, char** argv, Options& options) -> bool
{
    for (int i = 1; i < argc; i++)
    {
        const std::string arg = argv[i];
        if (arg == "--hash")
        {
            options.hash = true;
            continue;
        }
        if (i + 1 >= argc)
        {
            std::fprintf(stderr, "projectm-render: unknown option or missing value: %s\n", arg.c_str());
            return false;
        }
        const char* value = argv[++i];
        if (arg == "--preset")
        {
            options.preset = value;
        }
        else if (arg == "--audio")
        {
            options.audio = value;
        }
        else if (arg == "--output")
        {
            options.output = value;
        }
        else if (arg == "--texture-path")
        {
            options.texturePath = value;
        }
        else if (arg == "--width")
        {
            options.width = std::atoi(value);
        }
        else if (arg == "--height")
        {
            options.height = std::atoi(value);
        }
        else if (arg == "--fps")
        {
            options.fps = std::atoi(value);
        }
        else if (arg == "--duration")
        {
            options.duration = std::atof(value);
        }
        else if (arg == "--seed")
        {
            options.seed = static_cast<uint32_t>(std::strtoul(value, nullptr, 10));
        }
        else
        {
            std::fprintf(stderr, "projectm-render: unknown option: %s\n", arg.c_str());
            return false;
        }
    }
    if (options.preset.empty() || options.width <= 0 || options.height <= 0 || options.fps <= 0)
    {
        return false;
    }
    if (options.output.empty() && !options.hash)
    {
        std::fprintf(stderr, "projectm-render: nothing to do, pass --output and/or --hash\n");
        return false;
    }
    return true;
}

/// Decoded audio, interleaved stereo float.
struct Audio
{
    std::vector<float> samples;
    unsigned int sampleRate{44100};

    auto Frames() const -> size_t
    {
        return samples.size() / 2;
    }
};

auto EndsWith(const std::string& text, const char* suffix) -> bool
{
    const size_t length = std::strlen(suffix);
    if (text.size() < length)
    {
        return false;
    }
    std::string tail = text.substr(text.size() - length);
    std::transform(tail.begin(), tail.end(), tail.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return tail == suffix;
}

/// Converts @a channels-channel interleaved samples to stereo: mono is duplicated, extra
/// channels are dropped.
void ToStereo(const float* data, uint64_t frames, unsigned int channels, Audio& audio)
{
    audio.samples.resize(static_cast<size_t>(frames) * 2);
    for (uint64_t frame = 0; frame < frames; frame++)
    {
        const float left = data[frame * channels];
        const float right = channels > 1 ? data[frame * channels + 1] : left;
        audio.samples[frame * 2] = left;
        audio.samples[frame * 2 + 1] = right;
    }
}

auto DecodeAudio(const std::string& path, Audio& audio) -> bool
{
    unsigned int channels{0};
    unsigned int sampleRate{0};
    uint64_t frames{0};
    float* data{nullptr};
    if (EndsWith(path, ".flac"))
    {
        drflac_uint64 count{0};
        data = drflac_open_file_and_read_pcm_frames_f32(path.c_str(), &channels, &sampleRate, &count, nullptr);
        frames = count;
    }
    else if (EndsWith(path, ".wav"))
    {
        drwav_uint64 count{0};
        data = drwav_open_file_and_read_pcm_frames_f32(path.c_str(), &channels, &sampleRate, &count, nullptr);
        frames = count;
    }
    else if (EndsWith(path, ".mp3"))
    {
        drmp3_config config{};
        drmp3_uint64 count{0};
        data = drmp3_open_file_and_read_pcm_frames_f32(path.c_str(), &config, &count, nullptr);
        channels = config.channels;
        sampleRate = config.sampleRate;
        frames = count;
    }
    else
    {
        std::fprintf(stderr, "projectm-render: unsupported audio format (want .flac, .wav or .mp3): %s\n", path.c_str());
        return false;
    }
    if (data == nullptr || channels == 0 || sampleRate == 0)
    {
        std::fprintf(stderr, "projectm-render: could not decode %s\n", path.c_str());
        drflac_free(data, nullptr);
        return false;
    }
    ToStereo(data, frames, channels, audio);
    audio.sampleRate = sampleRate;
    // All three libraries allocate with the default (malloc) allocator.
    drflac_free(data, nullptr);
    return true;
}

/// A surfaceless EGL context, current on this thread while the object lives.
class HeadlessEgl
{
public:
    HeadlessEgl()
    {
        auto getPlatformDisplay = reinterpret_cast<PFNEGLGETPLATFORMDISPLAYEXTPROC>(eglGetProcAddress("eglGetPlatformDisplayEXT"));
        if (getPlatformDisplay != nullptr)
        {
            m_display = getPlatformDisplay(EGL_PLATFORM_SURFACELESS_MESA, EGL_DEFAULT_DISPLAY, nullptr);
        }
        if (m_display == EGL_NO_DISPLAY)
        {
            m_display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
        }
        if (m_display == EGL_NO_DISPLAY || eglInitialize(m_display, nullptr, nullptr) == EGL_FALSE)
        {
            m_display = EGL_NO_DISPLAY;
            return;
        }

#ifdef USE_GLES
        const EGLint renderableType = EGL_OPENGL_ES3_BIT;
        eglBindAPI(EGL_OPENGL_ES_API);
        const EGLint contextAttributes[] = {EGL_CONTEXT_MAJOR_VERSION, 3, EGL_CONTEXT_MINOR_VERSION, 2, EGL_NONE};
#else
        const EGLint renderableType = EGL_OPENGL_BIT;
        eglBindAPI(EGL_OPENGL_API);
        const EGLint contextAttributes[] = {EGL_CONTEXT_MAJOR_VERSION, 3, EGL_CONTEXT_MINOR_VERSION, 3,
                                            EGL_CONTEXT_OPENGL_PROFILE_MASK, EGL_CONTEXT_OPENGL_CORE_PROFILE_BIT, EGL_NONE};
#endif
        const EGLint configAttributes[] = {EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_RENDERABLE_TYPE, renderableType,
                                           EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_NONE};
        EGLConfig config{};
        EGLint configCount{0};
        if (eglChooseConfig(m_display, configAttributes, &config, 1, &configCount) == EGL_FALSE || configCount == 0)
        {
            return;
        }
        m_context = eglCreateContext(m_display, config, EGL_NO_CONTEXT, contextAttributes);
        if (m_context == EGL_NO_CONTEXT)
        {
            return;
        }
        // Surfaceless if the driver allows it, otherwise a 1x1 pbuffer; we draw into our own FBO.
        if (eglMakeCurrent(m_display, EGL_NO_SURFACE, EGL_NO_SURFACE, m_context) == EGL_FALSE)
        {
            const EGLint pbufferAttributes[] = {EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE};
            m_surface = eglCreatePbufferSurface(m_display, config, pbufferAttributes);
            if (m_surface == EGL_NO_SURFACE || eglMakeCurrent(m_display, m_surface, m_surface, m_context) == EGL_FALSE)
            {
                return;
            }
        }
#ifdef USE_GLES
        m_valid = gladLoadGLES2(reinterpret_cast<GLADloadfunc>(eglGetProcAddress)) != 0;
#else
        m_valid = gladLoadGL(reinterpret_cast<GLADloadfunc>(eglGetProcAddress)) != 0;
#endif
    }

    ~HeadlessEgl()
    {
        if (m_display == EGL_NO_DISPLAY)
        {
            return;
        }
        eglMakeCurrent(m_display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
        if (m_surface != EGL_NO_SURFACE)
        {
            eglDestroySurface(m_display, m_surface);
        }
        if (m_context != EGL_NO_CONTEXT)
        {
            eglDestroyContext(m_display, m_context);
        }
        eglTerminate(m_display);
    }

    HeadlessEgl(const HeadlessEgl&) = delete;
    auto operator=(const HeadlessEgl&) -> HeadlessEgl& = delete;

    auto Valid() const -> bool
    {
        return m_valid;
    }

private:
    EGLDisplay m_display{EGL_NO_DISPLAY};
    EGLContext m_context{EGL_NO_CONTEXT};
    EGLSurface m_surface{EGL_NO_SURFACE};
    bool m_valid{false};
};

/// FNV-1a, 64 bit. Not cryptographic: it only has to tell two renders apart.
class Fnv1a
{
public:
    void Add(const unsigned char* data, size_t size)
    {
        for (size_t i = 0; i < size; i++)
        {
            m_hash ^= data[i];
            m_hash *= 0x100000001b3ULL;
        }
    }

    auto Value() const -> uint64_t
    {
        return m_hash;
    }

private:
    uint64_t m_hash{0xcbf29ce484222325ULL};
};

} // namespace

int main(int argc, char** argv)
{
    Options options;
    if (!ParseOptions(argc, argv, options))
    {
        PrintUsage();
        return 2;
    }

    Audio audio;
    if (!options.audio.empty() && !DecodeAudio(options.audio, audio))
    {
        return 1;
    }
    double duration = options.duration;
    if (duration < 0.0)
    {
        duration = options.audio.empty() ? 10.0 : static_cast<double>(audio.Frames()) / audio.sampleRate;
    }
    const auto frameCount = static_cast<uint64_t>(std::floor(duration * options.fps));

    HeadlessEgl egl;
    if (!egl.Valid())
    {
        std::fprintf(stderr, "projectm-render: could not create a headless EGL OpenGL context\n");
        return 1;
    }

    GLuint texture{0};
    GLuint framebuffer{0};
    glGenTextures(1, &texture);
    glBindTexture(GL_TEXTURE_2D, texture);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, options.width, options.height, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
    glGenFramebuffers(1, &framebuffer);
    glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, texture, 0);
    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE)
    {
        std::fprintf(stderr, "projectm-render: could not create a %dx%d framebuffer\n", options.width, options.height);
        return 1;
    }
    glBindFramebuffer(GL_FRAMEBUFFER, 0);

    projectm_handle instance = projectm_create();
    if (instance == nullptr)
    {
        std::fprintf(stderr, "projectm-render: projectm_create() failed\n");
        return 1;
    }
    projectm_set_seed(instance, options.seed);
    projectm_set_window_size(instance, static_cast<size_t>(options.width), static_cast<size_t>(options.height));
    projectm_set_fps(instance, options.fps);
    projectm_set_preset_duration(instance, duration + 3600.0);
    projectm_set_preset_locked(instance, true);
    if (!options.texturePath.empty())
    {
        const char* paths[] = {options.texturePath.c_str()};
        projectm_set_texture_search_paths(instance, paths, 1);
    }
    projectm_load_preset_file(instance, options.preset.c_str(), false);

    FILE* output{nullptr};
    if (options.output == "-")
    {
        output = stdout;
    }
    else if (!options.output.empty())
    {
        output = std::fopen(options.output.c_str(), "wb");
        if (output == nullptr)
        {
            std::fprintf(stderr, "projectm-render: could not open %s\n", options.output.c_str());
            projectm_destroy(instance);
            return 1;
        }
    }

    Fnv1a hash;
    std::vector<unsigned char> pixels(static_cast<size_t>(options.width) * options.height * 4);
    int result = 0;
    for (uint64_t frame = 0; frame < frameCount; frame++)
    {
        // This frame's audio: the samples from its start time to the next frame's.
        const auto first = std::min<uint64_t>(frame * audio.sampleRate / options.fps, audio.Frames());
        const auto last = std::min<uint64_t>((frame + 1) * audio.sampleRate / options.fps, audio.Frames());
        const float* samples = last > first ? audio.samples.data() + first * 2 : nullptr;
        if (!projectm_render_offline_frame(instance, samples, static_cast<unsigned int>(last - first),
                                           static_cast<double>(frame) / options.fps, framebuffer))
        {
            std::fprintf(stderr, "projectm-render: frame %llu failed\n", static_cast<unsigned long long>(frame));
            result = 1;
            break;
        }
        glBindFramebuffer(GL_FRAMEBUFFER, framebuffer);
        glPixelStorei(GL_PACK_ALIGNMENT, 1);
        glReadPixels(0, 0, options.width, options.height, GL_RGBA, GL_UNSIGNED_BYTE, pixels.data());
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
        hash.Add(pixels.data(), pixels.size());
        if (output != nullptr && std::fwrite(pixels.data(), 1, pixels.size(), output) != pixels.size())
        {
            std::fprintf(stderr, "projectm-render: write failed\n");
            result = 1;
            break;
        }
    }

    if (output != nullptr && output != stdout)
    {
        std::fclose(output);
    }
    projectm_destroy(instance);
    glDeleteFramebuffers(1, &framebuffer);
    glDeleteTextures(1, &texture);

    if (result == 0 && options.hash)
    {
        // stderr when the frames go to stdout, so the hash does not end up in the video.
        std::fprintf(options.output == "-" ? stderr : stdout, "frames %llu fnv1a64 %016llx\n",
                     static_cast<unsigned long long>(frameCount), static_cast<unsigned long long>(hash.Value()));
    }
    return result;
}
