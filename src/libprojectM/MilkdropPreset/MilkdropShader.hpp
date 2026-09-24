/**
 * @file MilkdropShader.hpp
 * @brief Holds a warp or composite shader of Milkdrop presets.
 *
 * This class wraps the conversion from HLSL shader code to GLSL and also manages the
 * drawing.
 */
#pragma once

#include "BlurTexture.hpp"
#include "ShaderTranspiler.hpp"

#include <Renderer/Shader.hpp>
#include <Renderer/TextureManager.hpp>

#include <array>
#include <cstdint>
#include <map>
#include <memory>
#include <set>
#include <string>

namespace libprojectM {

struct PresetPrepareContext;

namespace MilkdropPreset {

class PerFrameContext;
class PresetState;

/**
 * @brief What LoadCode() derives from a preset shader's code, before any texture or GL object is involved.
 *
 * Computing this is pure CPU work, so background preset preparation can do it off the render thread
 * and hand the result to MilkdropShader::LoadPrepared().
 */
struct MilkdropShaderSource {
    std::string fragmentShaderCode;                                              //!< The original preset fragment shader code.
    std::string preprocessedCode;                                                //!< The preprocessed preset shader code.
    std::set<std::string> samplerNames;                                          //!< All sampler names referenced in the shader code.
    BlurTexture::BlurLevel maxBlurLevelRequired{BlurTexture::BlurLevel::None}; //!< Max blur level of main texture required by this shader.
};

/**
 * @brief A preset shader prepared off the render thread.
 *
 * Besides the analysed source, it carries a speculative HLSL-to-GLSL transpile made with the sampler and
 * texsize declarations the render thread is predicted to generate. MilkdropShader::TranspileHLSLShader()
 * uses that GLSL only if the declarations it actually builds are identical, which makes the result
 * byte-identical to transpiling on the render thread; on any mismatch it transpiles there as before.
 */
struct PreparedMilkdropShader {
    MilkdropShaderSource source;               //!< The analysed shader source.
    bool transpiled{false};                    //!< True if a speculative transpile ran with the declarations below.
    std::set<std::string> samplerDeclarations; //!< Predicted sampler declarations the transpile used.
    std::set<std::string> texSizeDeclarations; //!< Predicted texsize declarations the transpile used.
    bool transpileSucceeded{false};            //!< Result of the speculative transpile.
    std::string glsl;                          //!< Transpiled GLSL, if the transpile succeeded.
    std::string transpileError;                //!< Transpiler error message, if it failed.
};

/**
 * @brief Prediction of the descriptor TextureManager::GetRandomTexture() returns for a random texture slot.
 */
struct PredictedRandomTexture {
    bool resolved{false};    //!< False if no texture file matches: the descriptor will be empty.
    bool predictable{true};  //!< False if the declaration depends on which file the random pick lands on.
    std::string samplerName; //!< Sampler name of the descriptor.
};

using PredictedRandomTextures = std::map<int, PredictedRandomTexture>; //!< Predictions by random slot, shared by warp and composite.

/**
 * @brief Holds a warp or composite shader of Milkdrop presets.
 * Also does the required shader translation from HLSL to GLSL using hlslparser.
 */
class MilkdropShader
{
public:
    using ShaderType = ShaderTranspiler::ShaderType; //!< Type of preset shader, either warp or composite.

    /**
     * constructor.
     * @param type The preset shader type.
     */
    explicit MilkdropShader(ShaderType type);

    /**
     * @brief Translates and compiles the shader code.
     * @param presetShaderCode The preset shader code.
     */
    void LoadCode(const std::string& presetShaderCode);

    /**
     * @brief Loads already analysed shader code, as returned by AnalyzeCode().
     * @param source The analysed shader source.
     */
    void LoadSource(MilkdropShaderSource source);

    /**
     * @brief Loads a shader prepared off the render thread, including its speculative GLSL.
     * @param prepared The prepared shader.
     */
    void LoadPrepared(PreparedMilkdropShader prepared);

    /**
     * @brief Analyses preset shader code: referenced samplers, required blur level and preprocessing.
     *
     * Pure CPU work with no dependency on textures or GL; safe to call from any thread.
     * @throws Renderer::ShaderException if preprocessing fails.
     * @param type The shader type.
     * @param presetShaderCode The preset shader code.
     * @return The analysed source.
     */
    static auto AnalyzeCode(ShaderType type, const std::string& presetShaderCode) -> MilkdropShaderSource;

    /**
     * @brief Speculatively transpiles a prepared shader to GLSL. Safe to call from any thread.
     *
     * Predicts the sampler and texsize declarations LoadTexturesAndCompile() will generate on the render
     * thread, from the texture snapshot in @a context instead of a TextureManager, and transpiles with them.
     * Leaves @a shader untranspiled if the prediction is not reliable or the context says the transpile
     * cache already holds GLSL for this shader type.
     * @param type The shader type.
     * @param shader The prepared shader. Its source must be filled.
     * @param randomTextures Random texture predictions, shared between the warp and composite shader in
     *                       that order, as PresetState::randomTextureDescriptors is on the render thread.
     * @param context Snapshot of the render thread's texture state.
     */
    static void PrepareTranspile(ShaderType type, PreparedMilkdropShader& shader,
                                 PredictedRandomTextures& randomTextures, const PresetPrepareContext& context);

    /**
     * @brief Loads the required texture references into the shader.
     * Binds the underlying shader program.
     * @param presetState The preset state to pull the values and textures from.
     */
    void LoadTexturesAndCompile(PresetState& presetState);

    /**
     * @brief Whether LoadTexturesAndCompile() left the program linking in the background
     *        (RenderContext::deferShaderLink).
     */
    auto IsCompilePending() const -> bool;

    /**
     * @brief Whether a background link has finished. Does not block.
     */
    auto IsCompileComplete() const -> bool;

    /**
     * @brief Finishes a background link, as LoadTexturesAndCompile() would have without deferral.
     *
     * If the program was cached GLSL that turns out not to compile, the shader is transpiled
     * again and compiled synchronously, as on the non-deferred path.
     * @throws Renderer::ShaderException if the shader does not compile or link.
     * @param presetState The preset state.
     */
    void FinishCompile(PresetState& presetState);

    /**
     * @brief Loads all required shader variables into the uniforms.
     * Binds the underlying shader program.
     * @param presetState The preset state to pull the values from.
     * @param perFrameContext The per-frame context with dynamically calculated values.
     */
    void LoadVariables(const PresetState& presetState, const PerFrameContext& perFrameContext);

    /**
     * @brief Number of shaders compiled from a prepared shader's speculative GLSL (diagnostics/tests).
     */
    static auto PreparedGlslUseCount() -> uint64_t;

    /**
     * @brief Number of prepared shaders whose predicted declarations did not match (diagnostics/tests).
     */
    static auto PreparedGlslMismatchCount() -> uint64_t;

    /**
     * @brief Returns the contained shader.
     * @return The shader program wrapper.
     */
    auto Shader() -> Renderer::Shader&;

private:
    /**
     * @brief Prepares the shader code to be translated into GLSL.
     * @param type The shader type.
     * @param program The program code to work on.
     */
    static void PreprocessPresetShader(ShaderType type, std::string& program);

    /**
     * @brief Searches for sampler references in the program and stores them in source.samplerNames.
     * @param program The program code to work on.
     * @param source The source to store the sampler names and required blur level in.
     */
    static void GetReferencedSamplers(const std::string& program, MilkdropShaderSource& source);

    /**
     * @brief Translates the HLSL shader into GLSL.
     * @param presetState The preset state to pull the blur textures from.
     * @param program The shader to transpile.
     * @param deferLink Start the program link without waiting for it (see FinishCompile()).
     * @param useTranspileCache Try the transpiled-GLSL cache first.
     */
    void TranspileHLSLShader(const PresetState& presetState, std::string& program, bool deferLink, bool useTranspileCache);

    /**
     * @brief Updates the requested blur level if higher than before.
     * Also adds the required samplers.
     * @param requestedLevel The requested blur level.
     * @param source The source to update.
     */
    static void UpdateMaxBlurLevel(BlurTexture::BlurLevel requestedLevel, MilkdropShaderSource& source);

    ShaderType m_type{ShaderType::WarpShader}; //!< Type of this shader.
    MilkdropShaderSource m_source;             //!< The analysed shader code.

    std::unique_ptr<PreparedMilkdropShader> m_prepared; //!< Speculative transpile from background preparation, until compiled.
    bool m_deferredLinkUsesCachedGlsl{false};           //!< The pending link is of cached GLSL, which may be stale.

    std::vector<Renderer::TextureSamplerDescriptor> m_mainTextureDescriptors;    //!< Descriptors for all main texture references.
    std::vector<Renderer::TextureSamplerDescriptor> m_textureSamplerDescriptors; //!< Descriptors of all referenced samplers in the shader code.

    std::array<float, 4> m_randValues{};               //!< Random values which don't change every frame.
    std::array<glm::vec3, 20> m_randTranslation{};     //!< Random translation vectors which don't change every frame.
    std::array<glm::vec3, 20> m_randRotationCenters{}; //!< Random rotation center vectors which don't change every frame.
    std::array<glm::vec3, 20> m_randRotationSpeeds{};  //!< Random rotation speeds which don't change every frame.

    Renderer::Shader m_shader;
};

} // namespace MilkdropPreset
} // namespace libprojectM
