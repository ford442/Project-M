/**
 * @file MilkdropPreparedPreset.hpp
 * @brief A parsed Milkdrop preset with its shaders analysed and (optionally) transpiled.
 */
#pragma once

#include "MilkdropShader.hpp"

#include <PreparedPreset.hpp>

#include <iosfwd>
#include <memory>
#include <optional>
#include <string>

namespace libprojectM {
namespace MilkdropPreset {

class MilkdropPreset;
class PresetFileParser;

/**
 * @brief The CPU-side result of loading a Milkdrop preset. Construct on any thread.
 *
 * Holds the parsed preset file and the warp/composite shaders as MilkdropPreset would load them,
 * including the fallbacks it applies (no warp shader if the warp code does not preprocess, the
 * default composite shader if the composite code does not). MilkdropPreset's constructor taking
 * this skips everything done here.
 */
class MilkdropPreparedPreset : public PreparedPreset
{
public:
    /**
     * @brief Reads, parses and prepares a preset file.
     * @throws MilkdropPresetLoadException if the file cannot be read or parsed.
     * @param absoluteFilePath The preset file path.
     * @param context Render-thread state captured for this preparation.
     */
    MilkdropPreparedPreset(const std::string& absoluteFilePath, const PresetPrepareContext& context);

    /**
     * @brief Parses and prepares preset data.
     * @throws MilkdropPresetLoadException if the data cannot be parsed.
     * @param presetData The preset data.
     * @param context Render-thread state captured for this preparation.
     */
    MilkdropPreparedPreset(std::istream& presetData, const PresetPrepareContext& context);

    ~MilkdropPreparedPreset() override;

    auto Instantiate() -> std::unique_ptr<Preset> override;

private:
    friend class MilkdropPreset;

    void Prepare(const PresetPrepareContext& context);

    std::string m_absoluteFilePath;                          //!< The file path, if loaded from a file.
    std::unique_ptr<PresetFileParser> m_parser;              //!< The parsed preset file.
    std::optional<PreparedMilkdropShader> m_warpShader;      //!< Prepared warp shader, if the preset uses one.
    std::optional<PreparedMilkdropShader> m_compositeShader; //!< Prepared composite shader, if the preset uses one.
};

} // namespace MilkdropPreset
} // namespace libprojectM
