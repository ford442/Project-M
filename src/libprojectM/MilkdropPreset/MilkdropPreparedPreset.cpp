#include "MilkdropPreparedPreset.hpp"

#include "ExperimentalDepthSampler.hpp"
#include "FinalComposite.hpp"
#include "MilkdropPreset.hpp"
#include "MilkdropPresetExceptions.hpp"
#include "PerPixelMesh.hpp"
#include "PresetFileParser.hpp"
#include "PresetState.hpp"

#include <Logging.hpp>

#include <sstream>

namespace libprojectM {
namespace MilkdropPreset {

MilkdropPreparedPreset::MilkdropPreparedPreset(const std::string& absoluteFilePath, const PresetPrepareContext& context)
    : m_absoluteFilePath(absoluteFilePath)
    , m_parser(std::make_unique<PresetFileParser>())
{
    LOG_DEBUG("[MilkdropPreset] Loading preset from file \"" + absoluteFilePath + "\".");

    bool parsed{false};
    if (context.fileContents)
    {
        // PresetFileParser::Read(path) is this stream over the opened file.
        std::istringstream contents(*context.fileContents, std::ios_base::in | std::ios_base::binary);
        parsed = m_parser->Read(contents);
    }
    else
    {
        parsed = m_parser->Read(absoluteFilePath);
    }

    if (!parsed)
    {
        const std::string error = "[MilkdropPreset] Could not parse preset file \"" + absoluteFilePath + "\".";
        LOG_ERROR(error);
        throw MilkdropPresetLoadException(error);
    }

    Prepare(context);
}

MilkdropPreparedPreset::MilkdropPreparedPreset(std::istream& presetData, const PresetPrepareContext& context)
    : m_parser(std::make_unique<PresetFileParser>())
{
    LOG_DEBUG("[MilkdropPreset] Loading preset from stream.");

    if (!m_parser->Read(presetData))
    {
        const std::string error = "[MilkdropPreset] Could not parse preset data.";
        LOG_ERROR(error);
        throw MilkdropPresetLoadException(error);
    }

    Prepare(context);
}

MilkdropPreparedPreset::~MilkdropPreparedPreset() = default;

auto MilkdropPreparedPreset::Instantiate() -> std::unique_ptr<Preset>
{
    return std::make_unique<MilkdropPreset>(std::move(*this));
}

void MilkdropPreparedPreset::Prepare(const PresetPrepareContext& context)
{
    // Decide which shaders the preset uses exactly as PresetState::Initialize() followed by
    // MilkdropPreset::LoadShaderCode() does.
    int presetVersion{PresetState::DefaultPresetVersion};
    int warpShaderVersion{PresetState::DefaultShaderVersion};
    int compositeShaderVersion{PresetState::DefaultShaderVersion};
    PresetState::ReadShaderVersions(*m_parser, presetVersion, warpShaderVersion, compositeShaderVersion);

    if (auto source = PerPixelMesh::SelectWarpShaderSource(warpShaderVersion, ExperimentalDepthSampler::ShaderCode(*m_parser, "warp_")))
    {
        m_warpShader.emplace();
        m_warpShader->source = std::move(*source);
    }

    if (compositeShaderVersion > 0)
    {
        m_compositeShader.emplace();
        m_compositeShader->source = FinalComposite::SelectCompositeShaderSource(ExperimentalDepthSampler::ShaderCode(*m_parser, "comp_"));
    }

    // The transpile cache state the load began with, for the render thread's compile.
    if (context.transpileCacheKey)
    {
        const auto attachCacheState = [&context](PreparedMilkdropShader& shader, MilkdropShader::ShaderType type) {
            shader.transpileCacheKey = context.transpileCacheKey;
            shader.cachedGlsl = context.cachedGlsl.at(static_cast<size_t>(type));
        };
        if (m_warpShader)
        {
            attachCacheState(*m_warpShader, MilkdropShader::ShaderType::WarpShader);
        }
        if (m_compositeShader)
        {
            attachCacheState(*m_compositeShader, MilkdropShader::ShaderType::CompositeShader);
        }
    }

    if (!context.transpileShaders)
    {
        return;
    }

    // Warp before composite: random texture slots are shared between the two, and the render
    // thread resolves the warp shader's first (MilkdropPreset::Initialize()).
    PredictedRandomTextures randomTextures;
    if (m_warpShader)
    {
        MilkdropShader::PrepareTranspile(MilkdropShader::ShaderType::WarpShader, *m_warpShader, randomTextures, context);
    }
    if (m_compositeShader)
    {
        MilkdropShader::PrepareTranspile(MilkdropShader::ShaderType::CompositeShader, *m_compositeShader, randomTextures, context);
    }
}

} // namespace MilkdropPreset
} // namespace libprojectM
