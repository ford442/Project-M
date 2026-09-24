#include "Factory.hpp"

#include "IdlePreset.hpp"
#include "MilkdropPreparedPreset.hpp"
#include "MilkdropPreset.hpp"

#include <sstream>

namespace libprojectM {
namespace MilkdropPreset {

std::unique_ptr<::libprojectM::Preset> Factory::LoadPresetFromFile(const std::string& filename)
{
    std::string path;
    auto protocol = PresetFactory::Protocol(filename, path);
    if (protocol == "idle")
    {
        return IdlePresets::allocate();
    }
    else if (protocol == "" || protocol == "file")
    {
        return std::make_unique<MilkdropPreset>(path);
    }
    else
    {
        // ToDO: Throw unsupported protocol exception instead to provide more information.
        return nullptr;
    }
}

std::unique_ptr<Preset> Factory::LoadPresetFromStream(std::istream& data)
{
    return std::make_unique<MilkdropPreset>(data);
}

std::unique_ptr<PreparedPreset> Factory::PreparePresetFromFile(const std::string& filename,
                                                               const PresetPrepareContext& context) const
{
    std::string path;
    auto protocol = PresetFactory::Protocol(filename, path);
    if (protocol == "idle")
    {
        // IdlePresets::allocate() builds the preset from its embedded text.
        std::istringstream in(IdlePresets::presetText());
        return std::make_unique<MilkdropPreparedPreset>(in, context);
    }
    else if (protocol == "" || protocol == "file")
    {
        return std::make_unique<MilkdropPreparedPreset>(path, context);
    }
    else
    {
        return nullptr;
    }
}

std::unique_ptr<PreparedPreset> Factory::PreparePresetFromStream(std::istream& data,
                                                                 const PresetPrepareContext& context) const
{
    return std::make_unique<MilkdropPreparedPreset>(data, context);
}

} // namespace MilkdropPreset
} // namespace libprojectM
