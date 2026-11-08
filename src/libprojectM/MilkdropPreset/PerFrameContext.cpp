#include "PerFrameContext.hpp"

#include "HostVariables.hpp"
#include "MilkdropPresetExceptions.hpp"

#include "EvalRandom.hpp"

#include <Logging.hpp>

#include <array>
#include <string_view>

#define REG_VAR(var) \
    var = projectm_eval_context_register_variable(perFrameCodeContext, #var);

namespace libprojectM {
namespace MilkdropPreset {

namespace {

using VariableMember = PRJM_EVAL_F* PerFrameContext::*;

struct HostWritableVariable {
    std::string_view name;
    VariableMember member;
};

#define HOST_VAR(var) HostWritableVariable{#var, &PerFrameContext::var}

// The per-frame variables a preset's own code may assign, i.e. everything RegisterBuiltinVariables()
// registers except the inputs LoadStateVariables() writes from the engine every frame (time, fps,
// frame, progress, audio levels, mesh and viewport sizes, aspect, pm_*). q1..q32 are handled apart.
constexpr auto kHostWritableVariables = std::to_array<HostWritableVariable>({
    HOST_VAR(zoom), HOST_VAR(zoomexp), HOST_VAR(rot), HOST_VAR(warp),
    HOST_VAR(cx), HOST_VAR(cy), HOST_VAR(dx), HOST_VAR(dy), HOST_VAR(sx), HOST_VAR(sy),
    HOST_VAR(decay),
    HOST_VAR(wave_a), HOST_VAR(wave_r), HOST_VAR(wave_g), HOST_VAR(wave_b),
    HOST_VAR(wave_x), HOST_VAR(wave_y), HOST_VAR(wave_mystery), HOST_VAR(wave_mode),
    HOST_VAR(ob_size), HOST_VAR(ob_r), HOST_VAR(ob_g), HOST_VAR(ob_b), HOST_VAR(ob_a),
    HOST_VAR(ib_size), HOST_VAR(ib_r), HOST_VAR(ib_g), HOST_VAR(ib_b), HOST_VAR(ib_a),
    HOST_VAR(mv_x), HOST_VAR(mv_y), HOST_VAR(mv_dx), HOST_VAR(mv_dy),
    HOST_VAR(mv_l), HOST_VAR(mv_r), HOST_VAR(mv_g), HOST_VAR(mv_b), HOST_VAR(mv_a),
    HOST_VAR(echo_zoom), HOST_VAR(echo_alpha), HOST_VAR(echo_orient),
    HOST_VAR(wave_usedots), HOST_VAR(wave_thick), HOST_VAR(wave_additive), HOST_VAR(wave_brighten),
    HOST_VAR(darken_center), HOST_VAR(gamma), HOST_VAR(wrap), HOST_VAR(invert),
    HOST_VAR(brighten), HOST_VAR(darken), HOST_VAR(solarize),
    HOST_VAR(blur1_min), HOST_VAR(blur2_min), HOST_VAR(blur3_min),
    HOST_VAR(blur1_max), HOST_VAR(blur2_max), HOST_VAR(blur3_max), HOST_VAR(blur1_edge_darken),
});

#undef HOST_VAR

/**
 * @return The 0-based index for "q1".."q32", or -1.
 */
auto QVariableIndex(std::string_view name) -> int
{
    if (name.size() < 2 || name.size() > 3 || name.front() != 'q')
    {
        return -1;
    }
    int index = 0;
    for (size_t position = 1; position < name.size(); position++)
    {
        char const digit = name[position];
        if (digit < '0' || digit > '9' || (position == 1 && digit == '0'))
        {
            return -1;
        }
        index = index * 10 + (digit - '0');
    }
    return index >= 1 && index <= QVarCount ? index - 1 : -1;
}

auto FindHostWritableVariable(std::string_view name) -> const HostWritableVariable*
{
    for (const auto& variable : kHostWritableVariables)
    {
        if (variable.name == name)
        {
            return &variable;
        }
    }
    return nullptr;
}

} // namespace

auto IsHostWritableVariable(std::string_view lowerCaseName) -> bool
{
    return QVariableIndex(lowerCaseName) >= 0 || FindHostWritableVariable(lowerCaseName) != nullptr;
}

PerFrameContext::PerFrameContext(projectm_eval_mem_buffer gmegabuf, PRJM_EVAL_F (*globalRegisters)[100])
    : perFrameCodeContext(projectm_eval_context_create(gmegabuf, globalRegisters))
{
    SeedEvalRandom(perFrameCodeContext);
}

PerFrameContext::~PerFrameContext()
{
    if (perFrameCodeHandle != nullptr)
    {
        projectm_eval_code_destroy(perFrameCodeHandle);
    }

    if (perFrameCodeContext != nullptr)
    {
        projectm_eval_context_destroy(perFrameCodeContext);
    }
}

void PerFrameContext::RegisterBuiltinVariables()
{
    projectm_eval_context_reset_variables(perFrameCodeContext);

    REG_VAR(zoom);
    REG_VAR(zoomexp);
    REG_VAR(rot);
    REG_VAR(warp);
    REG_VAR(cx);
    REG_VAR(cy);
    REG_VAR(dx);
    REG_VAR(dy);
    REG_VAR(sx);
    REG_VAR(sy);
    REG_VAR(time);
    REG_VAR(fps);
    REG_VAR(bass);
    REG_VAR(mid);
    REG_VAR(treb);
    REG_VAR(bass_att);
    REG_VAR(mid_att);
    REG_VAR(treb_att);
    REG_VAR(frame);
    REG_VAR(decay);
    REG_VAR(wave_a);
    REG_VAR(wave_r);
    REG_VAR(wave_g);
    REG_VAR(wave_b);
    REG_VAR(wave_x);
    REG_VAR(wave_y);
    REG_VAR(wave_mystery);
    REG_VAR(wave_mode);
    for (int q = 0; q < QVarCount; q++)
    {
        std::string qvar = "q" + std::to_string(q + 1);
        q_vars[q] = projectm_eval_context_register_variable(perFrameCodeContext, qvar.c_str());
    }
    REG_VAR(progress);
    REG_VAR(ob_size);
    REG_VAR(ob_r);
    REG_VAR(ob_g);
    REG_VAR(ob_b);
    REG_VAR(ob_a);
    REG_VAR(ib_size);
    REG_VAR(ib_r);
    REG_VAR(ib_g);
    REG_VAR(ib_b);
    REG_VAR(ib_a);
    REG_VAR(mv_x);
    REG_VAR(mv_y);
    REG_VAR(mv_dx);
    REG_VAR(mv_dy);
    REG_VAR(mv_l);
    REG_VAR(mv_r);
    REG_VAR(mv_g);
    REG_VAR(mv_b);
    REG_VAR(mv_a);
    REG_VAR(echo_zoom);
    REG_VAR(echo_alpha);
    REG_VAR(echo_orient);
    REG_VAR(wave_usedots);
    REG_VAR(wave_thick);
    REG_VAR(wave_additive);
    REG_VAR(wave_brighten);
    REG_VAR(darken_center);
    REG_VAR(gamma);
    REG_VAR(wrap);
    REG_VAR(invert);
    REG_VAR(brighten);
    REG_VAR(darken);
    REG_VAR(solarize);
    REG_VAR(meshx);
    REG_VAR(meshy);
    REG_VAR(pixelsx);
    REG_VAR(pixelsy);
    REG_VAR(aspectx);
    REG_VAR(aspecty);
    REG_VAR(blur1_min);
    REG_VAR(blur2_min);
    REG_VAR(blur3_min);
    REG_VAR(blur1_max);
    REG_VAR(blur2_max);
    REG_VAR(blur3_max);
    REG_VAR(blur1_edge_darken);
    rhythm.Register(perFrameCodeContext);
}

void PerFrameContext::EvaluateInitCode(PresetState& state)
{
    if (state.perFrameInitCode.empty())
    {
        return;
    }

    auto* initCode = projectm_eval_code_compile(perFrameCodeContext, state.perFrameInitCode.c_str());
    if (initCode == nullptr)
    {
        std::string error;
        int line;
        int col;
        auto* errmsg = projectm_eval_get_error(perFrameCodeContext, &line, &col);
        if (errmsg)
        {
            error = "[PerFrameContext] Could not compile per-frame INIT code: ";
            error += errmsg;
            error += "(L" + std::to_string(line) + " C" + std::to_string(col) + ")";
        }
        else
        {
            error = "[PerFrameContext] Could not compile per-frame init code.";
        }
        LOG_DEBUG("[PerFrameContext] Failed per-frame INIT code:\n" + state.perFrameInitCode);
        throw MilkdropCompileException(error);
    }

    projectm_eval_code_execute(initCode);
    projectm_eval_code_destroy(initCode);

    for (int q = 0; q < QVarCount; q++)
    {
        q_values_after_init_code[q] = *q_vars[q];
        state.frameQVariables[q] = *q_vars[q];
    }
}

void PerFrameContext::LoadStateVariables(PresetState& state)
{
    *zoom = static_cast<PRJM_EVAL_F>(state.zoom);
    *zoomexp = static_cast<PRJM_EVAL_F>(state.zoomExponent);
    *rot = static_cast<PRJM_EVAL_F>(state.rot);
    *warp = static_cast<PRJM_EVAL_F>(state.warpAmount);
    *cx = static_cast<PRJM_EVAL_F>(state.rotCX);
    *cy = static_cast<PRJM_EVAL_F>(state.rotCY);
    *dx = static_cast<PRJM_EVAL_F>(state.xPush);
    *dy = static_cast<PRJM_EVAL_F>(state.yPush);
    *sx = static_cast<PRJM_EVAL_F>(state.stretchX);
    *sy = static_cast<PRJM_EVAL_F>(state.stretchY);
    *time = static_cast<PRJM_EVAL_F>(state.renderContext.time);
    *fps = static_cast<PRJM_EVAL_F>(state.renderContext.fps);
    *bass = static_cast<PRJM_EVAL_F>(state.audioData.bass);
    *mid = static_cast<PRJM_EVAL_F>(state.audioData.mid);
    *treb = static_cast<PRJM_EVAL_F>(state.audioData.treb);
    *bass_att = static_cast<PRJM_EVAL_F>(state.audioData.bassAtt);
    *mid_att = static_cast<PRJM_EVAL_F>(state.audioData.midAtt);
    *treb_att = static_cast<PRJM_EVAL_F>(state.audioData.trebAtt);
    *frame = static_cast<PRJM_EVAL_F>(state.renderContext.frame);
    for (int q = 0; q < QVarCount; q++)
    {
        *q_vars[q] = q_values_after_init_code[q];
    }
    *progress = static_cast<PRJM_EVAL_F>(state.renderContext.progress);
    *decay = static_cast<PRJM_EVAL_F>(state.decay);
    *wave_a = static_cast<PRJM_EVAL_F>(state.waveAlpha);
    *wave_r = static_cast<PRJM_EVAL_F>(state.waveR);
    *wave_g = static_cast<PRJM_EVAL_F>(state.waveG);
    *wave_b = static_cast<PRJM_EVAL_F>(state.waveB);
    *wave_x = static_cast<PRJM_EVAL_F>(state.waveX);
    *wave_y = static_cast<PRJM_EVAL_F>(state.waveY);
    *wave_mystery = static_cast<PRJM_EVAL_F>(state.waveParam);
    *wave_mode = static_cast<PRJM_EVAL_F>(state.waveMode);
    *ob_size = static_cast<PRJM_EVAL_F>(state.outerBorderSize);
    *ob_r = static_cast<PRJM_EVAL_F>(state.outerBorderR);
    *ob_g = static_cast<PRJM_EVAL_F>(state.outerBorderG);
    *ob_b = static_cast<PRJM_EVAL_F>(state.outerBorderB);
    *ob_a = static_cast<PRJM_EVAL_F>(state.outerBorderA);
    *ib_size = static_cast<PRJM_EVAL_F>(state.innerBorderSize);
    *ib_r = static_cast<PRJM_EVAL_F>(state.innerBorderR);
    *ib_g = static_cast<PRJM_EVAL_F>(state.innerBorderG);
    *ib_b = static_cast<PRJM_EVAL_F>(state.innerBorderB);
    *ib_a = static_cast<PRJM_EVAL_F>(state.innerBorderA);
    *mv_x = static_cast<PRJM_EVAL_F>(state.mvX);
    *mv_y = static_cast<PRJM_EVAL_F>(state.mvY);
    *mv_dx = static_cast<PRJM_EVAL_F>(state.mvDX);
    *mv_dy = static_cast<PRJM_EVAL_F>(state.mvDY);
    *mv_l = static_cast<PRJM_EVAL_F>(state.mvL);
    *mv_r = static_cast<PRJM_EVAL_F>(state.mvR);
    *mv_g = static_cast<PRJM_EVAL_F>(state.mvG);
    *mv_b = static_cast<PRJM_EVAL_F>(state.mvB);
    *mv_a = static_cast<PRJM_EVAL_F>(state.mvA);
    *echo_zoom = static_cast<PRJM_EVAL_F>(state.videoEchoZoom);
    *echo_alpha = static_cast<PRJM_EVAL_F>(state.videoEchoAlpha);
    *echo_orient = static_cast<PRJM_EVAL_F>(state.videoEchoOrientation);
    *wave_usedots = static_cast<PRJM_EVAL_F>(state.waveDots);
    *wave_thick = static_cast<PRJM_EVAL_F>(state.waveThick);
    *wave_additive = static_cast<PRJM_EVAL_F>(state.additiveWaves);
    *wave_brighten = static_cast<PRJM_EVAL_F>(state.maximizeWaveColor);
    *darken_center = static_cast<PRJM_EVAL_F>(state.darkenCenter);
    *gamma = static_cast<PRJM_EVAL_F>(state.gammaAdj);
    *wrap = static_cast<PRJM_EVAL_F>(state.texWrap);
    *invert = static_cast<PRJM_EVAL_F>(state.invert);
    *brighten = static_cast<PRJM_EVAL_F>(state.brighten);
    *darken = static_cast<PRJM_EVAL_F>(state.darken);
    *solarize = static_cast<PRJM_EVAL_F>(state.solarize);
    *meshx = static_cast<PRJM_EVAL_F>(state.renderContext.perPixelMeshX);
    *meshy = static_cast<PRJM_EVAL_F>(state.renderContext.perPixelMeshY);
    *pixelsx = static_cast<PRJM_EVAL_F>(state.renderContext.viewportSizeX);
    *pixelsy = static_cast<PRJM_EVAL_F>(state.renderContext.viewportSizeY);
    *aspectx = static_cast<PRJM_EVAL_F>(state.renderContext.invAspectX);
    *aspecty = static_cast<PRJM_EVAL_F>(state.renderContext.invAspectY);
    *blur1_min = static_cast<PRJM_EVAL_F>(state.blur1Min);
    *blur2_min = static_cast<PRJM_EVAL_F>(state.blur2Min);
    *blur3_min = static_cast<PRJM_EVAL_F>(state.blur3Min);
    *blur1_max = static_cast<PRJM_EVAL_F>(state.blur1Max);
    *blur2_max = static_cast<PRJM_EVAL_F>(state.blur2Max);
    *blur3_max = static_cast<PRJM_EVAL_F>(state.blur3Max);
    *blur1_edge_darken = static_cast<PRJM_EVAL_F>(state.blur1EdgeDarken);
    rhythm.Load(state.audioData.rhythm);
}

void PerFrameContext::CompilePerFrameCode(const std::string& perFrameCode)
{
    if (perFrameCode.empty())
    {
        return;
    }

    perFrameCodeHandle = projectm_eval_code_compile(perFrameCodeContext, perFrameCode.c_str());
    if (perFrameCodeHandle == nullptr)
    {
        std::string error;
        int line;
        int col;
        auto* errmsg = projectm_eval_get_error(perFrameCodeContext, &line, &col);
        if (errmsg)
        {
            error = "[PerFrameContext] Could not compile per-frame code: ";
            error += errmsg;
            error += "(L" + std::to_string(line) + " C" + std::to_string(col) + ")";
        }
        else
        {
            error = "[PerFrameContext] Could not compile per-frame code.";
        }
        LOG_DEBUG("[PerFrameContext] Failed per-frame code:\n" + perFrameCode);
        throw MilkdropCompileException(error);
    }
}

void PerFrameContext::LoadHostVariables(const std::map<std::string, double>& hostVariables)
{
    for (const auto& [name, value] : hostVariables)
    {
        int const qIndex = QVariableIndex(name);
        if (qIndex >= 0)
        {
            *q_vars[qIndex] = static_cast<PRJM_EVAL_F>(value);
            continue;
        }
        if (const auto* variable = FindHostWritableVariable(name))
        {
            *(this->*(variable->member)) = static_cast<PRJM_EVAL_F>(value);
        }
    }
}

void PerFrameContext::ExecutePerFrameCode()
{
    if (perFrameCodeHandle != nullptr)
    {
        projectm_eval_code_execute(perFrameCodeHandle);
    }
}

} // namespace MilkdropPreset
} // namespace libprojectM
