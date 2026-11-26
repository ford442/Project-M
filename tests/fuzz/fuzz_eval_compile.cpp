// fuzz_eval_compile: projectm-eval compile + one execute (docs/FUZZING.md).
//
// Input: Milkdrop expression code, the text of a per_frame_/per_pixel_/wave/shape block.
// It is compiled in a fresh context with the variables a per-frame context registers, and if
// it compiles, executed once. A fresh memory buffer, register bank and rand() seed per input
// keep runs independent of each other, so a crasher replays alone.
// Seeds: the equation blocks of presets/tests/ (tests/fuzz/extract_seeds.py).
// Dictionary: dictionaries/eval.dict.
//
// Loop budget: loop(n, ...) and while(...) each run up to 1048576 times (MAX_LOOP_COUNT in
// vendor/projectm-eval/projectm-eval/TreeFunctions.c), so nested loops multiply into hours.
// That is a known, bounded cost, not a memory-safety bug, and it would bury real findings in
// timeouts. So an input may contain at most one loop/while keyword, and then only 256 bytes
// of code around it: at most ~1M executions of a body that small, well under the timeout.

#include <projectm-eval.h>

#include <algorithm>
#include <cctype>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>

namespace {

constexpr size_t MaxCodeSize = 16 * 1024;
constexpr size_t MaxCodeSizeWithLoop = 256;

/**
 * @brief Counts "loop" and "while" substrings, case-insensitively (the scanner is case-insensitive).
 */
auto CountLoopKeywords(const std::string& code) -> int
{
    std::string lower(code);
    std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char c) {
        return static_cast<char>(std::tolower(c));
    });
    int count = 0;
    for (const char* keyword : {"loop", "while"})
    {
        for (auto pos = lower.find(keyword); pos != std::string::npos; pos = lower.find(keyword, pos + 1))
        {
            count++;
        }
    }
    return count;
}

// The per-frame variables PerFrameContext registers, plus the per-pixel ones.
const char* const RegisteredVariables[] = {
    "zoom", "zoomexp", "rot", "warp", "cx", "cy", "dx", "dy", "sx", "sy", "decay",
    "time", "fps", "frame", "progress", "bass", "mid", "treb", "bass_att", "mid_att", "treb_att",
    "wave_r", "wave_g", "wave_b", "wave_a", "wave_x", "wave_y", "wave_mode", "wave_mystery",
    "ob_size", "ob_r", "ob_g", "ob_b", "ob_a", "ib_size", "ib_r", "ib_g", "ib_b", "ib_a",
    "mv_x", "mv_y", "mv_dx", "mv_dy", "mv_l", "mv_r", "mv_g", "mv_b", "mv_a",
    "echo_zoom", "echo_alpha", "echo_orient", "gamma", "monitor", "meshx", "meshy",
    "pixelsx", "pixelsy", "aspectx", "aspecty", "x", "y", "rad", "ang",
    "q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8", "q9", "q10", "q11", "q12", "q13", "q14", "q15", "q16",
    "q17", "q18", "q19", "q20", "q21", "q22", "q23", "q24", "q25", "q26", "q27", "q28", "q29", "q30", "q31", "q32",
    "t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"};

} // namespace

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size)
{
    if (size > MaxCodeSize || std::memchr(data, 0, size) != nullptr)
    {
        return 0; // The compiler takes a C string; PresetFileParser refuses NUL anyway.
    }

    const std::string code(reinterpret_cast<const char*>(data), size);
    const int loops = CountLoopKeywords(code);
    if (loops > 1 || (loops == 1 && size > MaxCodeSizeWithLoop))
    {
        return 0;
    }

    PRJM_EVAL_F globalRegisters[100]{};
    projectm_eval_mem_buffer globalMemory = projectm_eval_memory_buffer_create();
    projectm_eval_context* context = projectm_eval_context_create(globalMemory, &globalRegisters);
    projectm_eval_context_seed_rand(context, 1);

    for (const char* name : RegisteredVariables)
    {
        PRJM_EVAL_F* variable = projectm_eval_context_register_variable(context, name);
        if (variable != nullptr)
        {
            *variable = 0.5;
        }
    }

    projectm_eval_code* compiled = projectm_eval_code_compile(context, code.c_str());
    if (compiled != nullptr)
    {
        volatile PRJM_EVAL_F result = projectm_eval_code_execute(compiled);
        (void) result;
        projectm_eval_code_destroy(compiled);
    }
    else
    {
        int line = 0;
        int column = 0;
        (void) projectm_eval_get_error(context, &line, &column);
    }

    projectm_eval_context_destroy(context);
    projectm_eval_memory_buffer_destroy(globalMemory);
    return 0;
}
