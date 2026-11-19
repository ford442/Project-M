#include "Renderer/TransitionShaderManager.hpp"

#include "BuiltInTransitionsResources.hpp"
#include "Renderer/ShaderPrelude.hpp"

#include <RandomSeed.hpp>

namespace libprojectM {
namespace Renderer {

TransitionShaderManager::TransitionShaderManager()
    : m_mersenneTwister(RandomSeed::Get("TransitionShaderManager"))
{
    // Compile all candidate shaders and keep only those that succeeded.
    // Each entry is {shaderBody, passCount}. Most are single-pass (1).
    // Glitch, HeatWave, MultiPassTest, PageCurl and Tunnel use 2 passes for
    // enhanced visual quality. The name is the shader file's
    // TransitionShaderBuiltIn<Name>Glsl330 part.
    struct Candidate
    {
        const char* name;
        const std::string& body;
        int passCount;
    };

    std::vector<Candidate> candidates;
    candidates.emplace_back(Candidate{"Burn", kTransitionShaderBuiltInBurnGlsl330, 1});
    candidates.emplace_back(Candidate{"Circle", kTransitionShaderBuiltInCircleGlsl330, 1});
    candidates.emplace_back(Candidate{"CubeRotate", kTransitionShaderBuiltInCubeRotateGlsl330, 1});
    candidates.emplace_back(Candidate{"Dreamy", kTransitionShaderBuiltInDreamyGlsl330, 1});
    candidates.emplace_back(Candidate{"Glitch", kTransitionShaderBuiltInGlitchGlsl330, 2});
    candidates.emplace_back(Candidate{"HeatWave", kTransitionShaderBuiltInHeatWaveGlsl330, 2});
    candidates.emplace_back(Candidate{"Kaleidoscope", kTransitionShaderBuiltInKaleidoscopeGlsl330, 1});
    candidates.emplace_back(Candidate{"LiquidMelt", kTransitionShaderBuiltInLiquidMeltGlsl330, 1});
    candidates.emplace_back(Candidate{"MosaicZoom", kTransitionShaderBuiltInMosaicZoomGlsl330, 1});
    candidates.emplace_back(Candidate{"MotionBlur", kTransitionShaderBuiltInMotionBlurGlsl330, 1});
    candidates.emplace_back(Candidate{"MultiPassTest", kTransitionShaderBuiltInMultiPassTestGlsl330, 2});
    candidates.emplace_back(Candidate{"PageCurl", kTransitionShaderBuiltInPageCurlGlsl330, 2});
    candidates.emplace_back(Candidate{"Pixelate", kTransitionShaderBuiltInPixelateGlsl330, 1});
    candidates.emplace_back(Candidate{"Plasma", kTransitionShaderBuiltInPlasmaGlsl330, 1});
    candidates.emplace_back(Candidate{"RadialWipe", kTransitionShaderBuiltInRadialWipeGlsl330, 1});
    candidates.emplace_back(Candidate{"Shatter", kTransitionShaderBuiltInShatterGlsl330, 1});
    candidates.emplace_back(Candidate{"SliceSwipe", kTransitionShaderBuiltInSliceSwipeGlsl330, 1});
    candidates.emplace_back(Candidate{"StarWipe", kTransitionShaderBuiltInStarWipeGlsl330, 1});
    candidates.emplace_back(Candidate{"Sweep", kTransitionShaderBuiltInSweepGlsl330, 1});
    candidates.emplace_back(Candidate{"TileFlip", kTransitionShaderBuiltInTileFlipGlsl330, 1});
    candidates.emplace_back(Candidate{"Tunnel", kTransitionShaderBuiltInTunnelGlsl330, 2});
    candidates.emplace_back(Candidate{"Warp", kTransitionShaderBuiltInWarpGlsl330, 1});
    candidates.emplace_back(Candidate{"WaterDrop", kTransitionShaderBuiltInWaterDropGlsl330, 1});
    candidates.emplace_back(Candidate{"ZoomBlur", kTransitionShaderBuiltInZoomBlurGlsl330, 1});

    for (auto& entry : candidates)
    {
        auto shader = CompileTransitionShader(entry.body);
        if (shader != nullptr)
        {
            m_transitionShaders.push_back({std::move(shader), entry.passCount, entry.name});
        }
    }

    // Always compile SimpleBlend separately as a guaranteed fallback used when
    // every entry in m_transitionShaders failed to compile.
    m_fallbackShader = CompileTransitionShader(kTransitionShaderBuiltInSimpleBlendGlsl330);
}

auto TransitionShaderManager::RandomTransition() -> std::shared_ptr<Shader>
{
    if (!m_transitionShaders.empty())
    {
        return m_transitionShaders.at(m_mersenneTwister() % m_transitionShaders.size()).shader;
    }

    // All custom shaders failed to compile — use the SimpleBlend fallback.
    return m_fallbackShader;
}

auto TransitionShaderManager::CompiledShaderCount() const -> std::size_t
{
    return m_transitionShaders.size();
}

auto TransitionShaderManager::CompiledShaderAt(std::size_t index) const -> std::shared_ptr<Shader>
{
    if (index >= m_transitionShaders.size())
    {
        return nullptr;
    }

    return m_transitionShaders.at(index).shader;
}

auto TransitionShaderManager::PassCountAt(std::size_t index) const -> int
{
    if (index >= m_transitionShaders.size())
    {
        return m_fallbackPassCount;
    }

    return m_transitionShaders.at(index).passCount;
}

auto TransitionShaderManager::NameAt(std::size_t index) const -> std::string
{
    if (index >= m_transitionShaders.size())
    {
        return {};
    }

    return m_transitionShaders.at(index).name;
}

auto TransitionShaderManager::IndexOf(const std::string& name) const -> std::optional<std::size_t>
{
    for (std::size_t index = 0; index < m_transitionShaders.size(); ++index)
    {
        if (m_transitionShaders.at(index).name == name)
        {
            return index;
        }
    }

    return std::nullopt;
}

auto TransitionShaderManager::GetPassCount(const std::shared_ptr<Shader>& shader) const -> int
{
    if (!shader)
    {
        return 1;
    }

    for (const auto& entry : m_transitionShaders)
    {
        if (entry.shader == shader)
        {
            return entry.passCount;
        }
    }

    // Fallback shader or unknown — default to single-pass.
    return m_fallbackPassCount;
}

auto TransitionShaderManager::CompileTransitionShader(const std::string& shaderBodyCode) -> std::shared_ptr<Shader>
{

    std::string fragmentShaderSource(kShaderPrelude);
    fragmentShaderSource.append(kTransitionShaderHeaderGlsl330);
    fragmentShaderSource.append("\n");
    fragmentShaderSource.append(shaderBodyCode);
    fragmentShaderSource.append("\n");
    fragmentShaderSource.append(kTransitionShaderMainGlsl330);

    try
    {
        auto transitionShader = std::make_shared<Shader>();
        transitionShader->CompileProgram(std::string(kShaderPrelude) + kTransitionVertexShaderGlsl330, fragmentShaderSource);
        return transitionShader;
    }
    catch (const ShaderException&)
    {
        // ToDo: Log proper shader compile error once logging API is in place
        return {};
    }
}

} // namespace Renderer
} // namespace libprojectM
