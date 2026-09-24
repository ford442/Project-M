#include "MilkdropShader.hpp"

#include "PerPixelGlslLowering.hpp"
#include "PresetState.hpp"
#include "ShaderTranspiler.hpp"
#include "Utils.hpp"

#include <MilkdropStaticShaders.hpp>

#include <PreparedPreset.hpp>

#include <Renderer/ShaderTranspileCache.hpp>
#include <Renderer/TextureManager.hpp>

#include <Logging.hpp>

#include <glm/gtc/matrix_transform.hpp>
#include <glm/mat4x4.hpp>

#include <algorithm>
#include <atomic>
#include <locale>
#include <set>

namespace libprojectM {
namespace MilkdropPreset {

using libprojectM::MilkdropPreset::MilkdropStaticShaders;

static auto floatRand = []() { return static_cast<float>(rand() % 7381) / 7380.0f; };

MilkdropShader::MilkdropShader(ShaderType type)
    : m_type(type)
    , m_randValues({floatRand(), floatRand(), floatRand(), floatRand()})
{
    unsigned int index = 0;
    do
    {
        for (int i = 0; i < 4; i++)
        {
            float const m_randTranslationMult = 1;
            float const rotMult = 0.9f * powf(index / 8.0f, 3.2f);
            m_randTranslation[index].x = (floatRand() * 2 - 1) * m_randTranslationMult;
            m_randTranslation[index].y = (floatRand() * 2 - 1) * m_randTranslationMult;
            m_randTranslation[index].z = (floatRand() * 2 - 1) * m_randTranslationMult;
            m_randRotationCenters[index].x = floatRand() * 6.28f;
            m_randRotationCenters[index].y = floatRand() * 6.28f;
            m_randRotationCenters[index].z = floatRand() * 6.28f;
            m_randRotationSpeeds[index].x = (floatRand() * 2 - 1) * rotMult;
            m_randRotationSpeeds[index].y = (floatRand() * 2 - 1) * rotMult;
            m_randRotationSpeeds[index].z = (floatRand() * 2 - 1) * rotMult;
            index++;
        }
    } while (index < sizeof(m_randTranslation) / sizeof(m_randTranslation[0]));
}

namespace {

// How often TranspileHLSLShader() could use a prepared shader's speculative GLSL, and how often
// the declarations it actually built differed from the prediction. Test/diagnostic counters.
std::atomic<uint64_t> g_preparedGlslUsed{0};
std::atomic<uint64_t> g_preparedGlslMismatched{0};

auto IsRandomTextureName(const std::string& lowerCaseName, const std::locale& loc) -> bool
{
    return lowerCaseName.length() >= 6 &&
           lowerCaseName.substr(0, 4) == "rand" && std::isdigit(lowerCaseName.at(4), loc) && std::isdigit(lowerCaseName.at(5), loc);
}

// Mirrors TextureManager::GetRandomTexture() against the texture file snapshot: whether it returns
// a texture at all, and whether that texture could be a volume texture (which would change the
// declaration depending on which file the random pick lands on).
auto PredictRandomTexture(const std::string& randomName, const PresetPrepareContext& context) -> PredictedRandomTexture
{
    PredictedRandomTexture prediction;
    prediction.samplerName = randomName;

    std::string const lowerCaseName = Utils::ToLower(randomName);
    std::string prefix;
    if (lowerCaseName.length() > 7 && lowerCaseName.at(6) == '_')
    {
        prefix = lowerCaseName.substr(7);
    }

    for (const auto& file : context.textureFiles)
    {
        if (!prefix.empty() && file.substr(0, prefix.length()) != prefix)
        {
            continue;
        }
        prediction.resolved = true;
        if (context.volumeTextureNames.count(file) > 0)
        {
            prediction.predictable = false;
        }
    }

    return prediction;
}

} // namespace

void MilkdropShader::LoadCode(const std::string& presetShaderCode)
{
    LoadSource(AnalyzeCode(m_type, presetShaderCode));
}

void MilkdropShader::LoadSource(MilkdropShaderSource source)
{
    m_source = std::move(source);
    m_prepared.reset();
}

void MilkdropShader::LoadPrepared(PreparedMilkdropShader prepared)
{
    m_source = std::move(prepared.source);
    m_prepared.reset();
    if (prepared.transpiled)
    {
        m_prepared = std::make_unique<PreparedMilkdropShader>(std::move(prepared));
    }
}

auto MilkdropShader::AnalyzeCode(ShaderType type, const std::string& presetShaderCode) -> MilkdropShaderSource
{
    MilkdropShaderSource source;
    source.fragmentShaderCode = presetShaderCode;
    source.preprocessedCode = presetShaderCode;

    GetReferencedSamplers(source.preprocessedCode, source);
    PreprocessPresetShader(type, source.preprocessedCode);

    return source;
}

void MilkdropShader::PrepareTranspile(ShaderType type, PreparedMilkdropShader& shader,
                                      PredictedRandomTextures& randomTextures, const PresetPrepareContext& context)
{
    // This mirrors LoadTexturesAndCompile() followed by the declaration collection in
    // TranspileHLSLShader(). Keep the three in step: a divergence costs a render-thread
    // transpile (the declarations will not match), never a wrong shader.
    MilkdropShaderSource source = shader.source;
    bool predictable = true;
    std::set<std::string> samplerDeclarations;
    std::set<std::string> texSizeDeclarations;
    std::locale loc;

    // Iterate a copy: UpdateMaxBlurLevel() inserts into source.samplerNames, and only blur
    // names are ever inserted, which declare nothing here.
    const std::set<std::string> samplerNames = source.samplerNames;
    for (const auto& name : samplerNames)
    {
        std::string baseName = name;
        if (name.length() > 3 && name.at(2) == '_')
        {
            baseName = name.substr(3);
        }

        std::string const lowerCaseName = Utils::ToLower(baseName);

        // The main texture is the preset framebuffer's color attachment, always a 2D texture.
        if (lowerCaseName == "main")
        {
            samplerDeclarations.insert(Renderer::TextureSamplerDescriptor::SamplerDeclarationFor(name, false));
            texSizeDeclarations.insert(Renderer::TextureSamplerDescriptor::TexSizeDeclarationFor("main"));
            continue;
        }

        if (lowerCaseName == "blur1")
        {
            UpdateMaxBlurLevel(BlurTexture::BlurLevel::Blur1, source);
            continue;
        }
        if (lowerCaseName == "blur2")
        {
            UpdateMaxBlurLevel(BlurTexture::BlurLevel::Blur2, source);
            continue;
        }
        if (lowerCaseName == "blur3")
        {
            UpdateMaxBlurLevel(BlurTexture::BlurLevel::Blur3, source);
            continue;
        }

        if (IsRandomTextureName(lowerCaseName, loc))
        {
            int randomSlot = -1;
            try
            {
                randomSlot = std::stoi(lowerCaseName.substr(4, 2));
            }
            catch (...)
            {
            }

            if (randomSlot >= 0 && randomSlot <= 15)
            {
                auto slot = randomTextures.find(randomSlot);
                if (slot == randomTextures.end())
                {
                    slot = randomTextures.emplace(randomSlot, PredictRandomTexture(name, context)).first;
                }

                const auto& prediction = slot->second;
                predictable = predictable && prediction.predictable;
                if (prediction.resolved)
                {
                    samplerDeclarations.insert(Renderer::TextureSamplerDescriptor::SamplerDeclarationFor(prediction.samplerName, false));
                    texSizeDeclarations.insert(Renderer::TextureSamplerDescriptor::TexSizeDeclarationFor(prediction.samplerName));
                }
                else
                {
                    // An empty descriptor contributes empty declarations. (Not insert({}):
                    // that picks the initializer_list overload and inserts nothing.)
                    samplerDeclarations.insert(std::string());
                    texSizeDeclarations.insert(std::string());
                }
                continue;
            }
        }

        // TextureManager::GetTexture(): a loaded texture keeps its own type, anything it has to load
        // (from the callback, a file, or the placeholder) is 2D. Only the preloaded volume noise
        // textures are 3D.
        std::string const unqualifiedName = Renderer::TextureManager::UnqualifiedTextureName(name);
        bool const volumeTexture = context.volumeTextureNames.count(unqualifiedName) > 0;
        samplerDeclarations.insert(Renderer::TextureSamplerDescriptor::SamplerDeclarationFor(name, volumeTexture));
        texSizeDeclarations.insert(Renderer::TextureSamplerDescriptor::TexSizeDeclarationFor(unqualifiedName));
    }

    // The blur textures of a freshly initialized preset are uncapped (BlurTexture::SetLevelCap()
    // only runs per frame), so every level the shader requires is declared.
    auto const blurLevel = static_cast<int>(source.maxBlurLevelRequired);
    for (int level = 1; level <= blurLevel; level++)
    {
        samplerDeclarations.insert(Renderer::TextureSamplerDescriptor::SamplerDeclarationFor("blur" + std::to_string(level), false));
    }

    const auto typeIndex = static_cast<size_t>(type);
    if (!predictable || (typeIndex < context.cachedGlsl.size() && context.cachedGlsl.at(typeIndex)))
    {
        return;
    }

    shader.samplerDeclarations = std::move(samplerDeclarations);
    shader.texSizeDeclarations = std::move(texSizeDeclarations);
    shader.transpiled = true;
    shader.transpileSucceeded = ShaderTranspiler::TranspileToGlsl(shader.source.preprocessedCode,
                                                                  shader.samplerDeclarations, shader.texSizeDeclarations,
                                                                  MilkdropStaticShaders::Get()->GetGlslGeneratorVersion(),
                                                                  shader.glsl, shader.transpileError);
}

auto MilkdropShader::PreparedGlslUseCount() -> uint64_t
{
    return g_preparedGlslUsed.load();
}

auto MilkdropShader::PreparedGlslMismatchCount() -> uint64_t
{
    return g_preparedGlslMismatched.load();
}

void MilkdropShader::LoadTexturesAndCompile(PresetState& presetState)
{
    std::locale loc;

    // Now request the textures and descriptors from the texture manager.
    for (const auto& name : m_source.samplerNames)
    {
        std::string baseName = name;
        if (name.length() > 3 && name.at(2) == '_')
        {
            baseName = name.substr(3);
        }

        std::string lowerCaseName = Utils::ToLower(baseName);

        // The "main" and "blurX" textures are preset-specific and are not managed by TextureManager.
        if (lowerCaseName == "main")
        {
            Renderer::TextureSamplerDescriptor desc(presetState.mainTexture.lock(),
                                                    presetState.renderContext.textureManager->GetSampler(name),
                                                    name,
                                                    "main");
            m_mainTextureDescriptors.push_back(std::move(desc));
            continue;
        }

        // A few presets directly use the (undocumented) sampler name.
        if (lowerCaseName == "blur1")
        {
            UpdateMaxBlurLevel(BlurTexture::BlurLevel::Blur1, m_source);
            continue;
        }
        if (lowerCaseName == "blur2")
        {
            UpdateMaxBlurLevel(BlurTexture::BlurLevel::Blur2, m_source);
            continue;
        }
        if (lowerCaseName == "blur3")
        {
            UpdateMaxBlurLevel(BlurTexture::BlurLevel::Blur3, m_source);
            continue;
        }

        // Random textures need special treatment.
        if (IsRandomTextureName(lowerCaseName, loc))
        {
            // First look up the random texture index in the preset state so the texture matches between warp and composite shaders
            int randomSlot = -1;
            try
            {
                randomSlot = std::stoi(lowerCaseName.substr(4, 2));
            }
            catch (...) // Ignore any conversion errors.
            {
            }

            if (randomSlot >= 0 && randomSlot <= 15)
            {
                if (presetState.randomTextureDescriptors.find(randomSlot) != presetState.randomTextureDescriptors.end())
                {
                    // Use existing texture descriptor.
                    m_textureSamplerDescriptors.push_back(presetState.randomTextureDescriptors.at(randomSlot));
                    continue;
                }

                // Slot empty, request a new random texture.
                auto desc = presetState.renderContext.textureManager->GetRandomTexture(name);

                // Also store a copy in preset state!
                presetState.randomTextureDescriptors.insert({randomSlot, desc});

                m_textureSamplerDescriptors.push_back(std::move(desc));
                continue;
            }

            // Fall through if slot number is out of range and treat as normal texture.
        }

        auto desc = presetState.renderContext.textureManager->GetTexture(name);
        m_textureSamplerDescriptors.push_back(std::move(desc));
    }

    // Now that we have the textures, transpile the code.
    TranspileHLSLShader(presetState, m_source.preprocessedCode, presetState.renderContext.deferShaderLink, true);

    // Update blur texture level if shader was compiled successfully.
    if (!m_shader.IsCompilePending())
    {
        presetState.blurTexture.SetRequiredBlurLevel(m_source.maxBlurLevelRequired);
    }
}

auto MilkdropShader::IsCompilePending() const -> bool
{
    return m_shader.IsCompilePending();
}

auto MilkdropShader::IsCompileComplete() const -> bool
{
    return m_shader.IsCompileComplete();
}

void MilkdropShader::FinishCompile(PresetState& presetState)
{
    if (!m_shader.IsCompilePending())
    {
        return;
    }

    try
    {
        m_shader.FinishCompileProgram();
    }
    catch (const Renderer::ShaderException&)
    {
        if (!m_deferredLinkUsesCachedGlsl)
        {
            throw;
        }
        // What the non-deferred path does when cached GLSL fails to compile.
        LOG_WARN("[MilkdropShader] Cached transpiled GLSL failed to compile; re-transpiling "
                 + std::string(m_type == ShaderType::WarpShader ? "warp" : "composite") + " shader");
        TranspileHLSLShader(presetState, m_source.preprocessedCode, false, false);
    }

    // Update blur texture level now the shader is known to have compiled.
    presetState.blurTexture.SetRequiredBlurLevel(m_source.maxBlurLevelRequired);
}

void MilkdropShader::LoadVariables(const PresetState& presetState, const PerFrameContext& perFrameContext)
{
    // These are the inputs: http://www.geisswerks.com/milkdrop/milkdrop_preset_authoring.html#3f6

    auto floatTime = static_cast<float>(presetState.renderContext.time);
    auto timeSincePresetStartWrapped = floatTime - static_cast<int>(floatTime / 10000.0) * 10000;
    auto mipX = logf(static_cast<float>(presetState.renderContext.viewportSizeX)) / logf(2.0f);
    auto mipY = logf(static_cast<float>(presetState.renderContext.viewportSizeY)) / logf(2.0f);
    auto mipAvg = 0.5f * (mipX + mipY);

    BlurTexture::Values blurMin;
    BlurTexture::Values blurMax;
    BlurTexture::GetSafeBlurMinMaxValues(perFrameContext, blurMin, blurMax);

    m_shader.Bind();

    m_shader.SetUniformMat4x4("vertex_transformation", PresetState::orthogonalProjection);

    m_shader.SetUniformFloat4("rand_frame", {floatRand(),
                                             floatRand(),
                                             floatRand(),
                                             floatRand()});
    m_shader.SetUniformFloat4("rand_preset", {m_randValues[0],
                                              m_randValues[1],
                                              m_randValues[2],
                                              m_randValues[3]});

    m_shader.SetUniformFloat4("_c0", {presetState.renderContext.aspectX,
                                      presetState.renderContext.aspectY,
                                      1.0f / presetState.renderContext.aspectX,
                                      1.0f / presetState.renderContext.aspectY});
    m_shader.SetUniformFloat4("_c1", {0.0,
                                      0.0,
                                      0.0,
                                      0.0});
    m_shader.SetUniformFloat4("_c2", {timeSincePresetStartWrapped,
                                      presetState.renderContext.fps,
                                      presetState.renderContext.frame,
                                      presetState.renderContext.progress});
    m_shader.SetUniformFloat4("_c3", {presetState.audioData.bass,
                                      presetState.audioData.mid,
                                      presetState.audioData.treb,
                                      presetState.audioData.vol});
    m_shader.SetUniformFloat4("_c4", {presetState.audioData.bassAtt,
                                      presetState.audioData.midAtt,
                                      presetState.audioData.trebAtt,
                                      presetState.audioData.volAtt});
    m_shader.SetUniformFloat4("_c5", {blurMax[0] - blurMin[0],
                                      blurMin[0],
                                      blurMax[1] - blurMin[1],
                                      blurMin[1]});
    m_shader.SetUniformFloat4("_c6", {blurMax[2] - blurMin[2],
                                      blurMin[2],
                                      blurMin[0],
                                      blurMax[0]});
    m_shader.SetUniformFloat4("_c7", {presetState.renderContext.viewportSizeX,
                                      presetState.renderContext.viewportSizeY,
                                      1.0f / static_cast<float>(presetState.renderContext.viewportSizeX),
                                      1.0f / static_cast<float>(presetState.renderContext.viewportSizeY)});

    m_shader.SetUniformFloat4("_c8", {0.5f + 0.5f * cosf(floatTime * 0.329f + 1.2f),
                                      0.5f + 0.5f * cosf(floatTime * 1.293f + 3.9f),
                                      0.5f + 0.5f * cosf(floatTime * 5.070f + 2.5f),
                                      0.5f + 0.5f * cosf(floatTime * 20.051f + 5.4f)});

    m_shader.SetUniformFloat4("_c9", {0.5f + 0.5f * sinf(floatTime * 0.329f + 1.2f),
                                      0.5f + 0.5f * sinf(floatTime * 1.293f + 3.9f),
                                      0.5f + 0.5f * sinf(floatTime * 5.070f + 2.5f),
                                      0.5f + 0.5f * sinf(floatTime * 20.051f + 5.4f)});

    m_shader.SetUniformFloat4("_c10", {0.5f + 0.5f * cosf(floatTime * 0.0050f + 2.7f),
                                       0.5f + 0.5f * cosf(floatTime * 0.0085f + 5.3f),
                                       0.5f + 0.5f * cosf(floatTime * 0.0133f + 4.5f),
                                       0.5f + 0.5f * cosf(floatTime * 0.0217f + 3.8f)});

    m_shader.SetUniformFloat4("_c11", {0.5f + 0.5f * sinf(floatTime * 0.0050f + 2.7f),
                                       0.5f + 0.5f * sinf(floatTime * 0.0085f + 5.3f),
                                       0.5f + 0.5f * sinf(floatTime * 0.0133f + 4.5f),
                                       0.5f + 0.5f * sinf(floatTime * 0.0217f + 3.8f)});

    m_shader.SetUniformFloat4("_c12", {mipX,
                                       mipY,
                                       mipAvg,
                                       0});
    m_shader.SetUniformFloat4("_c13", {blurMin[1],
                                       blurMax[1],
                                       blurMin[2],
                                       blurMax[2]});


    std::array<glm::mat4, 24> tempMatrices{};

    // write matrices
    for (int i = 0; i < 20; i++)
    {
        glm::mat4 const rotationX = glm::rotate(glm::mat4(1.0f), m_randRotationCenters[i].x + m_randRotationSpeeds[i].x * floatTime, glm::vec3(1.0f, 0.0f, 0.0f));
        glm::mat4 const rotationY = glm::rotate(glm::mat4(1.0f), m_randRotationCenters[i].y + m_randRotationSpeeds[i].y * floatTime, glm::vec3(0.0f, 1.0f, 0.0f));
        glm::mat4 const rotationZ = glm::rotate(glm::mat4(1.0f), m_randRotationCenters[i].z + m_randRotationSpeeds[i].z * floatTime, glm::vec3(0.0f, 0.0f, 1.0f));

        glm::mat4 const randomTranslation = glm::translate(glm::mat4(1.0f), glm::vec3(m_randTranslation[i].x, m_randTranslation[i].y, m_randTranslation[i].z));

        tempMatrices[i] = randomTranslation * rotationX;
        tempMatrices[i] = rotationZ * tempMatrices[i];
        tempMatrices[i] = rotationY * tempMatrices[i];
    }

    // the last 4 are totally random, each frame
    for (int i = 20; i < 24; i++)
    {
        glm::mat4 const rotationX = glm::rotate(glm::mat4(1.0f), floatRand() * 6.28f, glm::vec3(1.0f, 0.0f, 0.0f));
        glm::mat4 const rotationY = glm::rotate(glm::mat4(1.0f), floatRand() * 6.28f, glm::vec3(0.0f, 1.0f, 0.0f));
        glm::mat4 const rotationZ = glm::rotate(glm::mat4(1.0f), floatRand() * 6.28f, glm::vec3(0.0f, 0.0f, 1.0f));

        glm::mat4 const randomTranslation = glm::translate(glm::mat4(1.0f), glm::vec3(floatRand(), floatRand(), floatRand()));

        tempMatrices[i] = randomTranslation * rotationX;
        tempMatrices[i] = rotationZ * tempMatrices[i];
        tempMatrices[i] = rotationY * tempMatrices[i];
    }

    m_shader.SetUniformMat3x4("rot_s1", tempMatrices[0]);
    m_shader.SetUniformMat3x4("rot_s2", tempMatrices[1]);
    m_shader.SetUniformMat3x4("rot_s3", tempMatrices[2]);
    m_shader.SetUniformMat3x4("rot_s4", tempMatrices[3]);
    m_shader.SetUniformMat3x4("rot_d1", tempMatrices[4]);
    m_shader.SetUniformMat3x4("rot_d2", tempMatrices[5]);
    m_shader.SetUniformMat3x4("rot_d3", tempMatrices[6]);
    m_shader.SetUniformMat3x4("rot_d4", tempMatrices[7]);
    m_shader.SetUniformMat3x4("rot_f1", tempMatrices[8]);
    m_shader.SetUniformMat3x4("rot_f2", tempMatrices[9]);
    m_shader.SetUniformMat3x4("rot_f3", tempMatrices[10]);
    m_shader.SetUniformMat3x4("rot_f4", tempMatrices[11]);
    m_shader.SetUniformMat3x4("rot_vf1", tempMatrices[12]);
    m_shader.SetUniformMat3x4("rot_vf2", tempMatrices[13]);
    m_shader.SetUniformMat3x4("rot_vf3", tempMatrices[14]);
    m_shader.SetUniformMat3x4("rot_vf4", tempMatrices[15]);
    m_shader.SetUniformMat3x4("rot_uf1", tempMatrices[16]);
    m_shader.SetUniformMat3x4("rot_uf2", tempMatrices[17]);
    m_shader.SetUniformMat3x4("rot_uf3", tempMatrices[18]);
    m_shader.SetUniformMat3x4("rot_uf4", tempMatrices[19]);
    m_shader.SetUniformMat3x4("rot_rand1", tempMatrices[20]);
    m_shader.SetUniformMat3x4("rot_rand2", tempMatrices[21]);
    m_shader.SetUniformMat3x4("rot_rand3", tempMatrices[22]);
    m_shader.SetUniformMat3x4("rot_rand4", tempMatrices[23]);

    // set program uniform "_q[a-h]" values (_qa.x, _qa.y, _qa.z, _qa.w, _qb.x, _qb.y ... ) alias q[1-32]
    for (int i = 0; i < QVarCount; i += 4)
    {
        std::string varName = "_q";
        varName.push_back(static_cast<char>('a' + i / 4));
        m_shader.SetUniformFloat4(varName.c_str(), {presetState.frameQVariables[i],
                                                    presetState.frameQVariables[i + 1],
                                                    presetState.frameQVariables[i + 2],
                                                    presetState.frameQVariables[i + 3]});
    }

    // Bind all texture and sampler descriptors. This includes the main and blur textures.
    GLint textureUnit{0};
    for (auto& desc : m_mainTextureDescriptors)
    {
        // Update main texture, swaps every frame.
        desc.Texture(presetState.mainTexture);
        desc.Bind(textureUnit, m_shader);
        textureUnit++;
    }
    presetState.blurTexture.Bind(textureUnit, m_shader);
    for (auto& desc : m_textureSamplerDescriptors)
    {
        if (desc.Empty())
        {
            desc.TryUpdate(*presetState.renderContext.textureManager);
        }
        desc.Bind(textureUnit, m_shader);
        textureUnit++;
    }
}

auto MilkdropShader::Shader() -> Renderer::Shader&
{
    return m_shader;
}

void MilkdropShader::PreprocessPresetShader(ShaderType type, std::string& program)
{
    try
    {
        ShaderTranspiler::PreprocessPresetShader(type, program);
    }
    catch (const Renderer::ShaderException&)
    {
        std::string shaderTypeString = (type == ShaderType::WarpShader) ? "warp" : "composite";
        LOG_DEBUG("[MilkdropShader] Failed " + shaderTypeString + " shader code:\n" + program);
        throw;
    }
}

void MilkdropShader::GetReferencedSamplers(const std::string& program, MilkdropShaderSource& source)
{
    // Look up samplers referenced in the shader program
    source.samplerNames.clear();

    // "main" should always be present.
    source.samplerNames.insert("main");

    // Strip comments so that commented-out sampler/texsize declarations are not matched.
    std::string const stripped = Utils::StripComments(program);

    // Search for sampler usage
    auto found = stripped.find("sampler_", 0);
    while (found != std::string::npos)
    {
        found += 8;
        size_t const end = stripped.find_first_of(" ;,\n\r)", found);

        if (end != std::string::npos)
        {
            std::string const sampler = stripped.substr(static_cast<int>(found), static_cast<int>(end - found));
            // Skip "sampler_state", as it's a reserved word and not a sampler.
            if (sampler != "state")
            {
                source.samplerNames.insert(sampler);
            }
        }

        found = stripped.find("sampler_", found);
    }

    // Also search for texsize usage, some presets don't reference the sampler.
    found = stripped.find("texsize_", 0);
    while (found != std::string::npos)
    {
        found += 8;
        size_t const end = stripped.find_first_of(" ;,.\n\r)", found);

        if (end != std::string::npos)
        {
            std::string const sampler = stripped.substr(static_cast<int>(found), static_cast<int>(end - found));
            source.samplerNames.insert(sampler);
        }

        found = stripped.find("texsize_", found);
    }

    {
        // Remove duplicate mentions or "randXX" names, keeping the long forms only (first one will determine the actual texture loaded).
        auto samplerName = source.samplerNames.begin();
        std::locale loc;
        while (samplerName != source.samplerNames.end())
        {
            std::string lowerCaseName = Utils::ToLower(*samplerName);
            if (lowerCaseName.length() == 6 &&
                lowerCaseName.substr(0, 4) == "rand" && std::isdigit(lowerCaseName.at(4), loc) && std::isdigit(lowerCaseName.at(5), loc))
            {
                auto additionalName = samplerName;
                additionalName++;
                if (additionalName != source.samplerNames.end())
                {
                    std::string addLowerCaseName = Utils::ToLower(*additionalName);
                    if (addLowerCaseName.length() > 7 &&
                        addLowerCaseName.substr(0, 6) == lowerCaseName &&
                        addLowerCaseName[6] == '_')
                    {
                        samplerName = source.samplerNames.erase(samplerName);
                    }
                }
            }
            samplerName++;
        }
    }

    if (stripped.find("GetBlur3") != std::string::npos)
    {
        UpdateMaxBlurLevel(BlurTexture::BlurLevel::Blur3, source);
    }
    else if (stripped.find("GetBlur2") != std::string::npos)
    {
        UpdateMaxBlurLevel(BlurTexture::BlurLevel::Blur2, source);
    }
    else if (stripped.find("GetBlur1") != std::string::npos)
    {
        UpdateMaxBlurLevel(BlurTexture::BlurLevel::Blur1, source);
    }
    else
    {
        source.maxBlurLevelRequired = BlurTexture::BlurLevel::None;
    }
}

void MilkdropShader::TranspileHLSLShader(const PresetState& presetState, std::string& program, bool deferLink, bool useTranspileCache)
{
    // Consumed here whichever path compiles the shader, so the prepared GLSL is not kept alive.
    const std::unique_ptr<PreparedMilkdropShader> prepared = std::move(m_prepared);

    std::string shaderTypeString = "composite";
    if (m_type == ShaderType::WarpShader)
    {
        shaderTypeString = "warp";
    }

    // Collect unique samplers and texsize uniforms
    std::set<std::string> samplerDeclarations;
    std::set<std::string> texSizeDeclarations;
    for (const auto& desc : m_mainTextureDescriptors)
    {
        samplerDeclarations.insert(desc.SamplerDeclaration());
        texSizeDeclarations.insert(desc.TexSizeDeclaration());
    }
    for (const auto& desc : presetState.blurTexture.GetDescriptorsForBlurLevel(m_source.maxBlurLevelRequired))
    {
        samplerDeclarations.insert(desc.SamplerDeclaration());
        // No texsize_blur1 etc.
    }
    for (const auto& desc : m_textureSamplerDescriptors)
    {
        samplerDeclarations.insert(desc.SamplerDeclaration());
        texSizeDeclarations.insert(desc.TexSizeDeclaration());
    }

    const auto& cacheKey = Renderer::GetTranspiledGlslCacheKey();
    const int shaderTypeInt = static_cast<int>(m_type);

    auto compileGlsl = [&](const std::string& glslCode) {
        // The warp vertex shader carries this preset's per-pixel code when it was
        // compiled to GLSL, so it has to be composed rather than taken as-is.
        const std::string vertexShader = m_type == ShaderType::WarpShader
                                             ? PerPixelGlslLowering::ComposeWarpVertexShader(presetState.perPixelGpuGlsl)
                                             : MilkdropStaticShaders::Get()->GetPresetCompVertexShader();
        if (deferLink)
        {
            // Errors surface in FinishCompile().
            m_shader.BeginCompileProgram(vertexShader, glslCode);
        }
        else
        {
            m_shader.CompileProgram(vertexShader, glslCode);
        }
    };

    m_deferredLinkUsesCachedGlsl = false;
    if (useTranspileCache && !cacheKey.empty())
    {
        if (auto cachedGlsl = Renderer::LookupTranspiledGlsl(cacheKey, shaderTypeInt))
        {
            try
            {
                LOG_TRACE("[MilkdropShader] Using cached transpiled GLSL " + shaderTypeString + " shader");
                compileGlsl(*cachedGlsl);
                m_deferredLinkUsesCachedGlsl = deferLink;
                return;
            }
            catch (const Renderer::ShaderException&)
            {
                LOG_WARN("[MilkdropShader] Cached transpiled GLSL failed to compile; re-transpiling "
                         + shaderTypeString + " shader");
            }
        }
    }

    // Transpile from HLSL (aka preset shader aka DirectX shader) to GLSL (aka OpenGL shader lang).
    // A background preparation may already have done this with the same inputs: the preprocessed
    // code is the same string and the generator version a process constant, so if the declarations
    // match too, its output is exactly what the transpiler would produce here.
    std::string glslCode;
    std::string errorMessage;
    bool transpiled{false};
    if (prepared && prepared->samplerDeclarations == samplerDeclarations && prepared->texSizeDeclarations == texSizeDeclarations)
    {
        g_preparedGlslUsed++;
        glslCode = std::move(prepared->glsl);
        errorMessage = std::move(prepared->transpileError);
        transpiled = prepared->transpileSucceeded;
    }
    else
    {
        if (prepared)
        {
            g_preparedGlslMismatched++;

            LOG_DEBUG("[MilkdropShader] Prepared " + shaderTypeString + " shader declarations differ from the render thread's; transpiling again");
        }
        transpiled = ShaderTranspiler::TranspileToGlsl(program, samplerDeclarations, texSizeDeclarations,
                                                       MilkdropStaticShaders::Get()->GetGlslGeneratorVersion(),
                                                       glslCode, errorMessage);
    }
    if (!transpiled)
    {
        LOG_DEBUG("[MilkdropShader] Failed " + shaderTypeString + " shader code:\n" + program);
        throw Renderer::ShaderException("[MilkdropShader] Error translating HLSL " + shaderTypeString + " shader: " + errorMessage);
    }

    LOG_TRACE("[MilkdropShader] Transpiled GLSL " + shaderTypeString + " shader code:\n" + glslCode);

    if (!cacheKey.empty())
    {
        Renderer::StoreTranspiledGlsl(cacheKey, shaderTypeInt, glslCode);
    }

    // Now we have GLSL source for the preset shader program (hopefully it's valid!)
    // Compile the preset shader fragment shader with the standard vertex shader and cross our fingers.
    compileGlsl(glslCode);
}

void MilkdropShader::UpdateMaxBlurLevel(BlurTexture::BlurLevel requestedLevel, MilkdropShaderSource& source)
{
    if (source.maxBlurLevelRequired >= requestedLevel)
    {
        return;
    }

    source.maxBlurLevelRequired = requestedLevel;

    if (source.maxBlurLevelRequired == BlurTexture::BlurLevel::Blur3)
    {
        source.samplerNames.insert("blur1");
        source.samplerNames.insert("blur2");
        source.samplerNames.insert("blur3");
    }
    else if (source.maxBlurLevelRequired == BlurTexture::BlurLevel::Blur2)
    {
        source.samplerNames.insert("blur1");
        source.samplerNames.insert("blur2");
    }
    else
    {
        source.samplerNames.insert("blur1");
    }
}

} // namespace MilkdropPreset
} // namespace libprojectM
