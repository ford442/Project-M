#pragma once

#include "Preset.hpp"
#include "PreparedPreset.hpp"

#include <memory>

namespace libprojectM {

class PresetFactory
{

public:
    PresetFactory() = default;

    virtual ~PresetFactory() = default;

    /**
     * @brief Returns the protocol portion for the given URL
     *
     * Some implementation may hand over "file:///path/to/preset" as the preset filename. This method
     * takes care of cutting of the URL portion and return the path. Internally, it can be used to load
     * the default idle preset via the "idle://" URL.
     *
     * @param url The URL to parse
     * @param path [out] The path portion of the URL, basically everything after the "://" delimiter.
     * @return The protocol, e.g. "file"
     */
    static std::string Protocol(const std::string& url, std::string& path);

    /**
     * @brief Constructs a new preset from a local file
     * @param filename The preset filename
     * @returns A valid preset object
     */
    virtual std::unique_ptr<Preset> LoadPresetFromFile(const std::string& filename) = 0;

    /**
     * @brief Constructs a new preset from a stream
     * @param data The preset data stream
     * @returns A valid preset object
     */
    virtual std::unique_ptr<Preset> LoadPresetFromStream(std::istream& data) = 0;

    /**
     * @brief Does the CPU-only half of LoadPresetFromFile(): read, parse, analyse shaders.
     *
     * Creates no GL objects and touches no shared state, so it may run on any thread, concurrently
     * with rendering and with other preparations. PreparedPreset::Instantiate() finishes the load
     * on the render thread.
     * @param filename The preset filename or URL, as for LoadPresetFromFile().
     * @param context Render-thread state captured for this preparation.
     * @returns The prepared preset, or nullptr where LoadPresetFromFile() would return nullptr.
     */
    virtual std::unique_ptr<PreparedPreset> PreparePresetFromFile(const std::string& filename,
                                                                  const PresetPrepareContext& context) const = 0;

    /**
     * @brief Does the CPU-only half of LoadPresetFromStream(). See PreparePresetFromFile().
     * @param data The preset data stream
     * @param context Render-thread state captured for this preparation.
     * @returns The prepared preset.
     */
    virtual std::unique_ptr<PreparedPreset> PreparePresetFromStream(std::istream& data,
                                                                    const PresetPrepareContext& context) const = 0;

    /**
     * Returns a space separated list of supported extensions
     * @return A space separated list of supported extensions
     */
    virtual std::string supportedExtensions() const = 0;
};

} // namespace libprojectM
