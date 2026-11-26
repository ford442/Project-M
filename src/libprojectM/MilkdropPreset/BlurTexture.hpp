/**
 * @file BlurTexture.hpp
 * @brief Blurs a given texture in multiple passes and stores the results.
 */
#pragma once

#include <Renderer/Framebuffer.hpp>
#include <Renderer/Mesh.hpp>
#include <Renderer/RenderGraph.hpp>
#include <Renderer/RenderContext.hpp>
#include <Renderer/Shader.hpp>
#include <Renderer/TextureSamplerDescriptor.hpp>

#include <array>
#include <memory>

namespace libprojectM {
namespace MilkdropPreset {

class PerFrameContext;
class PresetState;

/**
 * @brief Blurs a given texture in multiple passes and stores the results.
 *
 * Blur textures are not stored in the texture manager to enable independent blur textures
 * for each loaded preset, e.g. during blending.
 */
class BlurTexture
{
public:
    using Values = std::array<float, 3>;

    /**
     * Maximum main texture blur level used in the shader
     */
    enum class BlurLevel : int
    {
        None,  //!< No blur used.
        Blur1, //!< First blur level (2 passes)
        Blur2, //!< Second blur level (4 passes)
        Blur3  //!< Third blur level (6 passes)
    };

    /**
     * Constructor.
     */
    BlurTexture();

    /**
     * Destructor.
     */
    virtual ~BlurTexture();

    /**
     * @brief Initializes the blur texture.
     * @param renderContext
     */
    void Initialize(const Renderer::RenderContext& renderContext);

    /**
     * @brief Sets the minimum required blur level.
     * If the current level isn't high enough, it'll be increased.
     * @param level The minim blur level.
     */
    void SetRequiredBlurLevel(BlurLevel level);

    /**
     * @brief Caps the blur level actually rendered/sampled this frame.
     *
     * Used by the adaptive quality governor to cut blur pass count under sustained
     * frame-budget pressure without changing what the preset itself requested
     * (SetRequiredBlurLevel()). Levels above the cap are simply not rendered this
     * frame and not exposed via GetDescriptorsForBlurLevel()/Bind().
     * @param cap -1 for uncapped (default), otherwise a BlurLevel value (0-3).
     */
    void SetLevelCap(int cap);

    /**
     * @brief Scales the resolution blur textures are allocated at, independent of the
     * governor's overall internal render scale (see docs/PERFORMANCE.md "Governor v2").
     *
     * Blur is a low-frequency effect and tolerates more aggressive downscaling than the
     * main scene without a visible quality loss, so this lets the governor shrink the
     * (already-progressively-halved) blur chain further under sustained frame-budget
     * pressure. Applied to every blur level uniformly; takes effect on the next
     * AllocateTextures() call (i.e. the next size change or forced reallocation).
     * @param scale (0, 1.0]. 1.0 (default) applies no extra downscale.
     */
    void SetResolutionScale(float scale);

    /**
     * @brief Returns a list of descriptors for the given blur level.
     * The blur textures don't need to be present and can be empty placeholders.
     * @param blurLevel The blur level.
     */
    auto GetDescriptorsForBlurLevel(BlurLevel blurLevel) const -> std::vector<Renderer::TextureSamplerDescriptor>;

    /**
     * @brief Renders the required blur passes on the given texture.
     * @param sourceTexture The texture to create the blur levels from.
     * @param perFrameContext The per-frame variables.
     */
    void Update(const Renderer::Texture& sourceTexture, const PerFrameContext& perFrameContext);

    /**
     * @brief The resource half of Update(): allocates the blur textures, picks the render path and
     *        computes this frame's scale and bias. Call while building the frame graph.
     * @return false if there is nothing to blur this frame.
     */
    auto Prepare(const Renderer::Texture& sourceTexture, const PerFrameContext& perFrameContext) -> bool;

    /**
     * @brief Declares the blur: a prepare pass (Prepare()), then one pass per level on the render
     *        path, between a begin and an end pass that save and restore the caller's targets.
     *        @a sourceTexture and @a perFrameContext must outlive the graph's Execute().
     */
    void AddPasses(Renderer::RenderGraph& graph, const Renderer::Texture& sourceTexture, const PerFrameContext& perFrameContext,
                   Renderer::RenderGraph::Resource source, Renderer::RenderGraph::Resource blurTextures);

    /**
     * @brief Binds the user-readable blur textures to the texture slots starting with the given index.
     * The shader must already be bound.
     * @param[in,out] unit The first texture unit to bind the blur textures from. Returns the next
     *                     free unit, which can be the same as the input slot if no blur textures
     *                     are used.
     */
    void Bind(int& unit, Renderer::Shader& shader) const;

    /**
     * @brief Adds the textures Bind() binds to a bind group, from @a unit on, and advances @a unit
     *        past them.
     */
    void AddBindings(int& unit, Renderer::Device::BindGroupDesc& group) const;

    /**
     * @brief Sets the sampler uniforms Bind() sets, for textures bound from @a unit on, and
     *        advances @a unit past them.
     */
    void SetUniforms(int& unit, const Renderer::Shader& shader) const;

    /**
     * @brief Returns properly scaled and clamped vlur values from the given context.
     * @param perFrameContext The per-frame context to retrieve the initial values from.
     * @param blurMin The calculated min values.
     * @param blurMax The calculated max values.
     */
    static void GetSafeBlurMinMaxValues(const PerFrameContext& perFrameContext,
                                        Values& blurMin,
                                        Values& blurMax);

private:
    static constexpr int NumBlurTextures = 6; //!< Maximum number of blur passes/textures.

    /**
     * How the blur passes get their results into the blur textures.
     */
    enum class RenderPath
    {
        Undecided, //!< Not probed yet.
        Direct,    //!< Blur textures are attached to the FBO and rendered into directly.
        Copy       //!< Legacy path: render into a scratch attachment, then copy it into the texture.
    };

    /**
     * Allocates the blur textures.
     * @param sourceTexture The source texture.
     */
    void AllocateTextures(const Renderer::Texture& sourceTexture);

    /**
     * @brief Makes sure a usable render target exists and picks the render path.
     *
     * On first call, the blur textures are probed as direct color attachments. If the
     * driver reports an incomplete framebuffer for that format, the legacy scratch
     * attachment plus copy path is set up instead.
     *
     * @return true if a render target is available, false if neither path works.
     */
    auto EnsureRenderTarget() -> bool;

    /**
     * @brief Binds the render target for the given blur pass and sets the viewport.
     * @param pass The blur pass index.
     * @param copyPath Render into the scratch attachment (then copied) instead of the blur texture.
     */
    void BindPassTarget(size_t pass, bool copyPath);

    /**
     * @brief Clamps a requested blur level against the governor cap, if any.
     * @param requested The level the preset/shader wants.
     * @return requested, or m_levelCap if lower and the cap is active.
     */
    auto EffectiveLevel(BlurLevel requested) const -> BlurLevel;

    void BeginPasses(bool copyPath);
    void RenderLevel(unsigned int pass, bool copyPath);
    void EndPasses();

    /**
     * @brief What Prepare() worked out for the frame's passes.
     */
    struct Frame {
        const Renderer::Texture* source{nullptr};
        unsigned int passes{};
        float blur1EdgeDarken{};
        std::array<float, 3> scale{};
        std::array<float, 3> bias{};
        Renderer::Device::RenderTargetHandle origReadFramebuffer;
        Renderer::Device::RenderTargetHandle origDrawFramebuffer;
        bool aborted{false}; //!< A blur shader was missing: the rest of the frame's blur is skipped.
    };
    Frame m_frame;

    /**
     * @brief A graph pass function: one of the blur's steps (AddPasses()).
     */
    struct Step {
        enum Kind : uint8_t
        {
            Prepare,
            Begin,
            Level,
            End
        };
        BlurTexture* blur{nullptr};
        Kind kind{Begin};
        unsigned int pass{};
        bool copyPath{false};
        void operator()(Renderer::RenderGraph::PassContext& context) const;
    };
    std::array<Step, NumBlurTextures + 3> m_steps{};
    const Renderer::Texture* m_prepareSource{nullptr};     //!< AddPasses(): what the prepare step blurs.
    const PerFrameContext* m_prepareContext{nullptr};      //!< AddPasses(): the per-frame variables it reads.

    Renderer::Mesh m_blurMesh; //!< The blur mesh (a simple quad).

    std::weak_ptr<Renderer::Shader> m_blur1Shader; //!< The shader used on the first blur pass.
    std::weak_ptr<Renderer::Shader> m_blur2Shader; //!< The shader used for subsequent blur passes after the initial pass.

    int m_sourceTextureWidth{};  //!< Width of the source texture used to create the blur textures.
    int m_sourceTextureHeight{}; //!< Height of the source texture used to create the blur textures.

    float m_resolutionScale{1.0f};         //!< Governor-requested extra downscale, see SetResolutionScale().
    float m_appliedResolutionScale{1.0f};  //!< Scale actually baked into the currently allocated textures.

    Renderer::Framebuffer m_blurFramebuffer;                                        //!< Scratch framebuffer, only used by the legacy copy path.
    // TEMPORARY: raw render target instead of Renderer::Framebuffer. It predates
    // Framebuffer::AttachmentStorage::External, which now lets a Framebuffer hold
    // caller-owned textures without SetSize() reallocating them (see FramebufferTest).
    // Migrating also needs SetAttachment() to bind while the FBO has no size of its own,
    // because each pass targets a differently sized blur texture.
    Renderer::Device::IRenderDevice* m_device{&Renderer::Device::Current()};       //!< The device that owns the direct render target.
    Renderer::Device::RenderTargetHandle m_directFramebufferId;                     //!< FBO used to render blur passes straight into the blur textures.
    RenderPath m_renderPath{RenderPath::Undecided};                                 //!< How blur results reach the blur textures.
    std::shared_ptr<Renderer::Sampler> m_blurSampler;                               //!< The blur sampler.
    std::array<std::shared_ptr<Renderer::Texture>, NumBlurTextures> m_blurTextures; //!< The blur textures for each pass.
    BlurLevel m_blurLevel{BlurLevel::None};                                         //!< Current blur level.
    int m_levelCap{-1};                                                             //!< Governor cap on blur level, -1 = uncapped.
};

} // namespace MilkdropPreset
} // namespace libprojectM
