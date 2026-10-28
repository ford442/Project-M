#include "Shader.hpp"

#include <Logging.hpp>
#include <glm/gtc/type_ptr.hpp>

#include <string_view>

namespace libprojectM {
namespace Renderer {

namespace {
std::optional<bool> g_compileCompleteOverride; //!< See Shader::OverrideCompileCompleteForTesting().
} // namespace

Shader::Shader()
    : m_shaderProgram(m_device->CreateProgram())
{
}

Shader::~Shader()
{
    ReleasePendingCompile();
    m_device->DestroyProgram(m_shaderProgram);
}

void Shader::CompileProgram(const std::string& vertexShaderSource,
                            const std::string& fragmentShaderSource)
{
    BeginCompileProgram(vertexShaderSource, fragmentShaderSource);
    FinishCompileProgram();
}

void Shader::BeginCompileProgram(const std::string& vertexShaderSource,
                                 const std::string& fragmentShaderSource)
{
    ReleasePendingCompile();

    // Relinking may move every uniform.
    m_uniformLocations.clear();

    m_pending = std::make_unique<PendingCompile>();
    m_pending->vertexShaderSource = vertexShaderSource;
    m_pending->fragmentShaderSource = fragmentShaderSource;
    m_pending->stages = m_device->BeginCompileProgram(m_shaderProgram, vertexShaderSource, fragmentShaderSource);
}

auto Shader::IsCompilePending() const -> bool
{
    return m_pending != nullptr;
}

auto Shader::IsCompileComplete() const -> bool
{
    if (!m_pending)
    {
        return true;
    }

    if (g_compileCompleteOverride)
    {
        return *g_compileCompleteOverride;
    }

    // Only meaningful with KHR_parallel_shader_compile, whose callers are the only ones that poll.
    return m_device->IsProgramCompileComplete(m_shaderProgram);
}

void Shader::FinishCompileProgram()
{
    if (!m_pending)
    {
        return;
    }

    const auto pending = std::move(m_pending);

    using Status = Device::ProgramCompileResult::Status;
    const auto result = m_device->FinishCompileProgram(m_shaderProgram, pending->stages);
    switch (result.status)
    {
        case Status::Ok:
            return;

        // Report a failed shader compile the way compiling it synchronously did,
        // vertex shader first.
        case Status::VertexCompileFailed:
        case Status::FragmentCompileFailed: {
            const bool vertex = result.status == Status::VertexCompileFailed;
            std::string compileError = "[Shader] Error compiling " + std::string(vertex ? "vertex" : "fragment") + " shader: " + result.log;
            LOG_ERROR(compileError);
            LOG_DEBUG("[Shader] Failed source: " + (vertex ? pending->vertexShaderSource : pending->fragmentShaderSource));
            throw ShaderException(compileError);
        }

        case Status::LinkFailed:
            break;
    }

    std::string linkError = "[Shader] Error linking compiled shader program: " + result.log;
    LOG_ERROR(linkError);
    LOG_DEBUG("[Shader] Vertex shader source: " + pending->vertexShaderSource);
    LOG_DEBUG("[Shader] Fragment shader source: " + pending->fragmentShaderSource);
    throw ShaderException(linkError);
}

void Shader::ReleasePendingCompile()
{
    if (m_pending)
    {
        m_device->AbandonCompileProgram(m_shaderProgram, m_pending->stages);
        m_pending.reset();
    }
}

bool Shader::Validate(std::string& validationMessage) const
{
    return m_device->ValidateProgram(m_shaderProgram, validationMessage);
}

void Shader::Bind() const
{
    if (m_shaderProgram.Valid())
    {
        m_device->Commands().SetProgram(m_shaderProgram);
    }
}

void Shader::Unbind()
{
    Device::Commands().SetProgram({});
}

auto Shader::AttributeLocation(const char* attribute) const -> int
{
    return m_device->AttributeLocation(m_shaderProgram, attribute);
}

void Shader::SetUniformFloat(const char* uniform, float value) const
{
    SetUniform(uniform, Device::UniformType::Float, 1, &value);
}

void Shader::SetUniformInt(const char* uniform, int value) const
{
    SetUniform(uniform, Device::UniformType::Int, 1, &value);
}

void Shader::SetUniformFloat2(const char* uniform, const glm::vec2& values) const
{
    SetUniform(uniform, Device::UniformType::Float2, 1, glm::value_ptr(values));
}

void Shader::SetUniformInt2(const char* uniform, const glm::ivec2& values) const
{
    SetUniform(uniform, Device::UniformType::Int2, 1, glm::value_ptr(values));
}

void Shader::SetUniformFloat3(const char* uniform, const glm::vec3& values) const
{
    SetUniform(uniform, Device::UniformType::Float3, 1, glm::value_ptr(values));
}

void Shader::SetUniformInt3(const char* uniform, const glm::ivec3& values) const
{
    SetUniform(uniform, Device::UniformType::Int3, 1, glm::value_ptr(values));
}

void Shader::SetUniformFloat4(const char* uniform, const glm::vec4& values) const
{
    SetUniform(uniform, Device::UniformType::Float4, 1, glm::value_ptr(values));
}

void Shader::SetUniformInt4(const char* uniform, const glm::ivec4& values) const
{
    SetUniform(uniform, Device::UniformType::Int4, 1, glm::value_ptr(values));
}

void Shader::SetUniformFloat4Array(const char* uniform, const glm::vec4* values, int count) const
{
    if (count <= 0)
    {
        return;
    }
    SetUniform(uniform, Device::UniformType::Float4, count, glm::value_ptr(values[0]));
}

void Shader::SetUniformMat3x4(const char* uniform, const glm::mat3x4& values) const
{
    SetUniform(uniform, Device::UniformType::Mat3x4, 1, glm::value_ptr(values));
}

void Shader::SetUniformMat4x4(const char* uniform, const glm::mat4x4& values) const
{
    SetUniform(uniform, Device::UniformType::Mat4x4, 1, glm::value_ptr(values));
}

void Shader::SetUniform(const char* uniform, Device::UniformType type, int count, const void* data) const
{
    const auto location = UniformLocation(uniform);
    if (location < 0)
    {
        return;
    }
    m_device->Commands().SetUniform(location, type, count, data);
}

auto Shader::UniformLocation(const char* uniform) const -> int
{
    const std::string_view name(uniform);
    const auto cached = m_uniformLocations.find(name);
    if (cached != m_uniformLocations.end())
    {
        return cached->second;
    }

    // Asking the driver is a JavaScript call and a string decode on WebGL, and the renderer
    // sets dozens of uniforms per frame. A location never changes until the next link, so
    // each name is asked for once, including the names that turn out to be inactive (-1).
    const int location = m_device->UniformLocation(m_shaderProgram, uniform);
    m_uniformLocations.emplace(name, location);
    return location;
}

void Shader::OverrideCompileCompleteForTesting(std::optional<bool> complete)
{
    g_compileCompleteOverride = complete;
}

auto Shader::ParallelCompileSupported() -> bool
{
    return Device::Current().SupportsParallelShaderCompile();
}

auto Shader::GetShaderLanguageVersion() -> Shader::GlslVersion
{
    std::string shaderLanguageVersionString = Device::Current().ShadingLanguageVersionString();

    if (shaderLanguageVersionString.empty())
    {
        return {};
    }

    // Some OpenGL implementations add non-standard-conforming text in front, e.g. WebGL, which returns "OpenGL ES GLSL ES 3.00 ..."
    // Find the first digit and start there.
    auto firstDigit = shaderLanguageVersionString.find_first_of("0123456789");
    if (firstDigit != std::string::npos && firstDigit != 0)
    {
        shaderLanguageVersionString = shaderLanguageVersionString.substr(firstDigit);
    }

    // Cut off the vendor-specific information, if any
    auto spacePos = shaderLanguageVersionString.find(' ');
    if (spacePos != std::string::npos)
    {
        shaderLanguageVersionString.resize(spacePos);
    }

    auto dotPos = shaderLanguageVersionString.find('.');
    if (dotPos == std::string::npos)
    {
        return {};
    }

    int versionMajor = std::stoi(shaderLanguageVersionString.substr(0, dotPos));
    int versionMinor = std::stoi(shaderLanguageVersionString.substr(dotPos + 1));

    return {versionMajor, versionMinor};
}

} // namespace Renderer
} // namespace libprojectM
