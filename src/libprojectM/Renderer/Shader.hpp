/**
 * @file Shader.hpp
 * @brief Implements an interface to a single shader program instance.
 */
#pragma once

#include "Renderer/Texture.hpp"

#include <glm/vec2.hpp>
#include <glm/vec3.hpp>
#include <glm/vec4.hpp>
#include <glm/mat3x4.hpp>
#include <glm/mat4x4.hpp>

#include <map>
#include <memory>
#include <optional>
#include <string>

#ifndef GL_COMPLETION_STATUS_KHR
#define GL_COMPLETION_STATUS_KHR 0x91B1
#endif

namespace libprojectM {
namespace Renderer {

/**
 * @brief Shader compilation exception.
 */
class ShaderException : public std::exception
{
public:
    ShaderException(std::string message)
        : m_message(std::move(message))
    {
    }

    virtual ~ShaderException() = default;

    const char* what() const noexcept override
    {
        return m_message.c_str();
    }

    const std::string& message() const
    {
        return m_message;
    }

private:
    std::string m_message;
};


/**
 * @brief Base class containing a shader program, consisting of a vertex and fragment shader.
 */
class Shader
{
public:
    /**
     * GLSL version structure
     */
    struct GlslVersion {
        int major{}; //!< Major OpenGL shading language version
        int minor{}; //!< Minor OpenGL shading language version
    };

    /**
     * Creates a new shader.
     */
    Shader();

    /**
     * Destructor.
     */
    ~Shader();

    /**
     * @brief Compiles a vertex and fragment shader into a program.
     * @throws ShaderException Thrown if compilation of a shader or program linking failed.
     * @param vertexShaderSource The vertex shader source.
     * @param fragmentShaderSource The fragment shader source.
     */
    void CompileProgram(const std::string& vertexShaderSource,
                        const std::string& fragmentShaderSource);

    /**
     * @brief Starts compiling and linking a program without waiting for the result.
     *
     * With KHR_parallel_shader_compile the driver does the work on its own threads; poll
     * IsCompileComplete() and then call FinishCompileProgram() before using the program.
     * Without the extension, FinishCompileProgram() simply waits, as CompileProgram() does.
     * CompileProgram() is BeginCompileProgram() followed by FinishCompileProgram().
     * @param vertexShaderSource The vertex shader source.
     * @param fragmentShaderSource The fragment shader source.
     */
    void BeginCompileProgram(const std::string& vertexShaderSource,
                             const std::string& fragmentShaderSource);

    /**
     * @brief Whether a compile started with BeginCompileProgram() has not been finished yet.
     */
    [[nodiscard]] auto IsCompilePending() const -> bool;

    /**
     * @brief Whether the driver has finished a pending compile and link (GL_COMPLETION_STATUS_KHR).
     *
     * Does not block. Only call with KHR_parallel_shader_compile available (see
     * ParallelCompileSupported()); true if nothing is pending.
     */
    [[nodiscard]] auto IsCompileComplete() const -> bool;

    /**
     * @brief Checks the result of a pending compile and link. Blocks until the driver is done.
     * @throws ShaderException Thrown if compilation of a shader or program linking failed,
     *                         with the same message CompileProgram() would have thrown.
     */
    void FinishCompileProgram();

    /**
     * @brief Whether the current GL context supports KHR_parallel_shader_compile.
     *
     * The GL context must be current.
     */
    [[nodiscard]] static auto ParallelCompileSupported() -> bool;

    /**
     * @brief Test seam: makes IsCompileComplete() report @a complete instead of asking the driver.
     *
     * A driver may finish a link before it is first polled, which leaves the "still linking"
     * path untestable. std::nullopt restores the driver's answer. Not thread-safe; tests only.
     * @param complete The status to report, or std::nullopt.
     */
    static void OverrideCompileCompleteForTesting(std::optional<bool> complete);

    /**
     * @brief Validates that the program can run in the current state.
     * @param validationMessage The error message if validation failed.
     * @return true if the shader program is valid and can run, false if it broken.
     */
    [[nodiscard]] bool Validate(std::string& validationMessage) const;

    /**
     * Binds the program into the current context.
     */
    void Bind() const;

    /**
     * Unbinds the program.
     */
    static void Unbind();

    /**
     * @brief Sets a single float uniform.
     * The program must be bound before calling this method!
     * @param uniform The uniform name
     * @param value The value to set.
     */
    void SetUniformFloat(const char* uniform, float value) const;

    /**
     * @brief Sets a single integer uniform.
     * The program must be bound before calling this method!
     * @param uniform The uniform name
     * @param value The value to set.
     */
    void SetUniformInt(const char* uniform, int value) const;

    /**
     * @brief Sets a float vec2 uniform.
     * The program must be bound before calling this method!
     * @param uniform The uniform name
     * @param values The values to set.
     */
    void SetUniformFloat2(const char* uniform, const glm::vec2& values) const;

    /**
     * @brief Sets an int vec2 uniform.
     * The program must be bound before calling this method!
     * @param uniform The uniform name
     * @param values The values to set.
     */
    void SetUniformInt2(const char* uniform, const glm::ivec2& values) const;

    /**
     * @brief Sets a float vec3 uniform.
     * The program must be bound before calling this method!
     * @param uniform The uniform name
     * @param values The values to set.
     */
    void SetUniformFloat3(const char* uniform, const glm::vec3& values) const;

    /**
     * @brief Sets an int vec3 uniform.
     * The program must be bound before calling this method!
     * @param uniform The uniform name
     * @param values The values to set.
     */
    void SetUniformInt3(const char* uniform, const glm::ivec3& values) const;

    /**
     * @brief Sets a float vec4 uniform.
     * The program must be bound before calling this method!
     * @param uniform The uniform name
     * @param values The values to set.
     */
    void SetUniformFloat4(const char* uniform, const glm::vec4& values) const;

    /**
     * @brief Sets an int vec4 uniform.
     * The program must be bound before calling this method!
     * @param uniform The uniform name
     * @param values The values to set.
     */
    void SetUniformInt4(const char* uniform, const glm::ivec4& values) const;

    /**
     * @brief Sets a float 3x4 matrix uniform.
     * The program must be bound before calling this method!
     * @param uniform The uniform name
     * @param values The matrix to set.
     */
    void SetUniformMat3x4(const char* uniform, const glm::mat3x4& values) const;

    /**
     * @brief Sets a float 4x4 matrix uniform.
     * The program must be bound before calling this method!
     * @param uniform The uniform name
     * @param values The matrix to set.
     */
    void SetUniformMat4x4(const char* uniform, const glm::mat4x4& values) const;

    /**
     * @brief Parses the shading language version string returned from OpenGL.
     * If this function does not return a good version (e.g. "major" not >0), then OpenGL is probably
     * not properly initialized or the context not made current.
     * @return The parsed version, or {0,0} if the version could not be parsed.
     */
    [[nodiscard]] static auto GetShaderLanguageVersion() -> GlslVersion;

private:
    /**
     * @brief Shader objects of a compile started with BeginCompileProgram().
     */
    struct PendingCompile {
        GLuint vertexShader{};            //!< Vertex shader object.
        GLuint fragmentShader{};          //!< Fragment shader object.
        std::string vertexShaderSource;   //!< For error reports.
        std::string fragmentShaderSource; //!< For error reports.
    };

    /**
     * @brief Creates a shader object and starts compiling it, without checking the result.
     * @param source The shader source.
     * @param type The shader type, e.g. GL_VERTEX_SHADER.
     * @return The shader ID.
     */
    static auto BeginCompileShader(const std::string& source, GLenum type) -> GLuint;

    /**
     * @brief Detaches and deletes a pending compile's shader objects.
     */
    void DeleteShaders(const PendingCompile& pending);

    /**
     * @brief Abandons a pending compile, if any.
     */
    void ReleasePendingCompile();

    std::unique_ptr<PendingCompile> m_pending; //!< Compile started but not finished, if any.
    GLuint m_shaderProgram{}; //!< The program ID.
};

} // namespace Renderer
} // namespace libprojectM
