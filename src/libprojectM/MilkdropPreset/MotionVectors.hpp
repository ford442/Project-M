#pragma once

#include "PerFrameContext.hpp"
#include "PresetState.hpp"

#include "Renderer/RenderItem.hpp"

/**
 * @brief Draws a flexible motion vector field.
 *
 * This is broken right now, as it only renders a relatively static 1px point grid, with no apparent motion trails.
 * Milkdrop renders this as lines with trails.
 *
 * @todo Reverse-engineer the original Milkdrop code and reimplement it properly.
 *       https://github.com/projectM-visualizer/milkdrop2/blob/f05b0d811a87a17c4624170c26c93bac39b05bde/src/vis_milk2/milkdropfs.cpp#L1239
 */
class MotionVectors : public RenderItem
{
public:
    MotionVectors() = delete;

    explicit MotionVectors(PresetState& presetState);

    void InitVertexAttrib();

    /**
     * Redners the motion vectors.
     * @param presetPerFrameContext The per-frame context variables.
     */
    void Draw(const PerFrameContext& presetPerFrameContext);

private:
    void ReversePropagatePoint(float posX1, float posY1, float& posX2, float&posY2);

    PresetState& m_presetState; //!< The global preset state.
};
