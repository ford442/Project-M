// fuzz_preset_parser: PresetFileParser on arbitrary bytes (docs/FUZZING.md).
//
// Input: a whole .milk file. Seeds: presets/tests/. Dictionary: dictionaries/milk.dict.
// Besides Read(), it pulls values out the way PresetState and the experimental hooks do,
// so the typed getters and GetCode()'s key walk see the parsed map too.

#include <MilkdropPreset/PresetFileParser.hpp>

#include <cstddef>
#include <cstdint>
#include <sstream>
#include <string>

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size)
{
    using libprojectM::MilkdropPreset::PresetFileParser;

    std::istringstream stream(std::string(reinterpret_cast<const char*>(data), size), std::ios_base::in | std::ios_base::binary);
    PresetFileParser parser;
    if (!parser.Read(stream))
    {
        return 0;
    }

    static const char* const codePrefixes[] = {
        "per_frame_", "per_frame_init_", "per_pixel_", "warp_", "comp_",
        "wavecode_0_per_frame", "wavecode_0_per_point", "shapecode_0_per_frame", "warp_pass1_"};
    size_t total = 0;
    for (const char* prefix : codePrefixes)
    {
        total += parser.GetCode(prefix).size();
    }

    static const char* const valueKeys[] = {
        "MILKDROP_PRESET_VERSION", "PSVERSION", "PSVERSION_WARP", "PSVERSION_COMP",
        "fDecay", "zoom", "nWaveMode", "bAdditiveWaves", "warp_nPasses", "comp_nPasses"};
    for (const char* key : valueKeys)
    {
        total += static_cast<size_t>(parser.GetInt(key, 0));
        total += static_cast<size_t>(parser.GetFloat(key, 0.0f) != 0.0f);
        total += static_cast<size_t>(parser.GetBool(key, false));
        total += parser.GetString(key, {}).size();
    }
    total += parser.ExperimentalDirectives().size();
    total += parser.PresetValues().size();

    // Keep the work observable so the optimizer cannot drop it.
    volatile size_t sink = total;
    (void) sink;
    return 0;
}
