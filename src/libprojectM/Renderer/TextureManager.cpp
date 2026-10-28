#include "Renderer/TextureManager.hpp"

#include "Renderer/FileScanner.hpp"
#include "Renderer/IdleTextures.hpp"
#include "Renderer/MilkdropNoise.hpp"
#include "Renderer/Texture.hpp"

#include <Logging.hpp>
#include <Utils.hpp>

#include <stb_image.h>

#include <algorithm>
#include <cstdlib>
#include <memory>
#include <random>
#include <vector>

namespace libprojectM {
namespace Renderer {

TextureManager::TextureManager(const std::vector<std::string>& textureSearchPaths)
    : m_textureSearchPaths(textureSearchPaths)
    , m_placeholderTexture(std::make_shared<Texture>("placeholder", 1, 1, false))
{
    Preload();
}

void TextureManager::SetCurrentPresetPath(const std::string&)
{
}

TextureSamplerDescriptor TextureManager::GetTexture(const std::string& fullName)
{
    std::string unqualifiedName;
    Device::WrapMode wrapMode{};
    Device::FilterMode filterMode{};

    ExtractTextureSettings(fullName, wrapMode, filterMode, unqualifiedName);
    if (m_textures.find(unqualifiedName) == m_textures.end())
    {
        return TryLoadingTexture(fullName);
    }

    return {m_textures[unqualifiedName], m_samplers.at({wrapMode, filterMode}), fullName, unqualifiedName};
}

auto TextureManager::GetSampler(const std::string& fullName) -> std::shared_ptr<class Sampler>
{
    std::string unqualifiedName;
    Device::WrapMode wrapMode{};
    Device::FilterMode filterMode{};

    ExtractTextureSettings(fullName, wrapMode, filterMode, unqualifiedName);

    return m_samplers.at({wrapMode, filterMode});
}

void TextureManager::Preload()
{
    // Create samplers
    using Device::FilterMode;
    using Device::WrapMode;
    for (const auto& [wrapMode, filterMode] : {std::make_pair(WrapMode::ClampToEdge, FilterMode::Linear),
                                               std::make_pair(WrapMode::ClampToEdge, FilterMode::Nearest),
                                               std::make_pair(WrapMode::Repeat, FilterMode::Linear),
                                               std::make_pair(WrapMode::Repeat, FilterMode::Nearest)})
    {
        m_samplers.emplace(std::make_pair(wrapMode, filterMode), std::make_shared<Sampler>(wrapMode, filterMode));
    }

    int width{};
    int height{};
    int channels{};

    {
        std::unique_ptr<stbi_uc, decltype(&free)> const imageData(stbi_load_from_memory(M_data, M_bytes, &width, &height, &channels, 0), free);

        auto format = TextureFormatFromChannels(channels);
        if (imageData.get() != nullptr && format)
        {
            m_textures["idlem"] = std::make_shared<Texture>("idlem", reinterpret_cast<const void*>(imageData.get()), Device::TextureTarget::Texture2D, width, height, 0, *format, false);
        }
    }

    {
        std::unique_ptr<stbi_uc, decltype(&free)> const imageData(stbi_load_from_memory(headphones_data, headphones_bytes, &width, &height, &channels, 0), free);

        auto format = TextureFormatFromChannels(channels);
        if (imageData.get() != nullptr && format)
        {
            m_textures["idleheadphones"] = std::make_shared<Texture>("idleheadphones", reinterpret_cast<const void*>(imageData.get()), Device::TextureTarget::Texture2D, width, height, 0, *format, false);
        }
    }

    // Noise textures
    m_textures["noise_lq_lite"] = MilkdropNoise::LowQualityLite();
    m_textures["noise_lq"] = MilkdropNoise::LowQuality();
    m_textures["noise_mq"] = MilkdropNoise::MediumQuality();
    m_textures["noise_hq"] = MilkdropNoise::HighQuality();
    m_textures["noisevol_lq"] = MilkdropNoise::LowQualityVolume();
    m_textures["noisevol_hq"] = MilkdropNoise::HighQualityVolume();
}

void TextureManager::PurgeTextures()
{
    // Increment age of all textures
    for (auto& texture : m_textures)
    {
        if (texture.second->IsUserTexture())
        {
            m_textureStats.at(texture.first).age++;
        }
    }

    // Clear file cache
    m_scannedTextureFiles.clear();
    m_filesScanned = false;

    // Only purge textures with an age of 2 or higher, so we don't evict textures used by the preset being blended out
    uint32_t newest = 99999999;
    uint32_t oldest = 0;
    bool foundTextureToEvict = false;
    for (const auto& stat : m_textureStats)
    {
        if (stat.second.sizeBytes > 0 && stat.second.age > 1)
        {
            newest = std::min(newest, stat.second.age);
            oldest = std::max(oldest, stat.second.age);
            foundTextureToEvict = true;
        }
    }

    if (!foundTextureToEvict)
    {
        return;
    }

    uint32_t biggestBytes = 0;
    std::string biggestName;
    for (const auto& stat : m_textureStats)
    {
        if (stat.second.sizeBytes > 0 && stat.second.age > 1)
        {
            auto sizeMultiplicator = 1.0f + static_cast<float>(stat.second.age - newest) / static_cast<float>(oldest - newest);
            auto scaledSize = static_cast<uint32_t>(stat.second.sizeBytes * sizeMultiplicator);
            if (scaledSize > biggestBytes)
            {
                biggestBytes = scaledSize;
                biggestName = stat.first;
            }
        }
    }

    if (biggestName.empty())
    {
        return;
    }

    // Purge one texture. No need to inform presets, as the texture will stay alive until the preset
    // is unloaded.
    m_textures.erase(m_textures.find(biggestName));
    m_textureStats.erase(m_textureStats.find(biggestName));
    m_fileTextures.erase(biggestName);

    LOG_DEBUG("[TextureManager] Purged texture \"" + biggestName + "\"");
}

auto TextureManager::ReloadTexture(const std::string& name) -> bool
{
    // A file base name, not a sampler name: "pm_depth_map" must not lose "pm_" as a filter prefix.
    std::string const lowerCaseName = Utils::ToLower(name);

    auto const loaded = m_textures.find(lowerCaseName);
    if (loaded == m_textures.end() || m_fileTextures.count(lowerCaseName) == 0)
    {
        // Not loaded, or not from a file (generated, or from the load callback): nothing a
        // file can update in place.
        return false;
    }

    // The file may have been written since the last scan.
    m_scannedTextureFiles.clear();
    m_filesScanned = false;
    ScanTextures();

    for (const auto& file : m_scannedTextureFiles)
    {
        if (file.lowerCaseBaseName != lowerCaseName)
        {
            continue;
        }

        int width{};
        int height{};
        std::unique_ptr<stbi_uc, decltype(&free)> imageData(stbi_load(file.filePath.c_str(), &width, &height, nullptr, 4), free);
        if (imageData == nullptr || width <= 0 || height <= 0)
        {
            LOG_WARN("[TextureManager] Failed to decode \"" + file.filePath + "\" for reloading texture \"" + name + "\"");
            return false;
        }

        loaded->second->Replace(imageData.get(), width, height);
        auto stats = m_textureStats.find(lowerCaseName);
        if (stats != m_textureStats.end())
        {
            stats->second.sizeBytes = static_cast<uint32_t>(width) * static_cast<uint32_t>(height) * 4;
        }
        LOG_DEBUG("[TextureManager] Reloaded texture \"" + name + "\" from file: " + file.filePath);
        return true;
    }

    return false;
}

auto TextureManager::TryLoadingTexture(const std::string& name) -> TextureSamplerDescriptor
{
    Device::WrapMode wrapMode{};
    Device::FilterMode filterMode{};
    std::string unqualifiedName;

    ExtractTextureSettings(name, wrapMode, filterMode, unqualifiedName);

    std::string lowerCaseUnqualifiedName = Utils::ToLower(unqualifiedName);

    // Try callback first if registered
    if (m_textureLoadCallback)
    {
        TextureLoadData loadData;
        m_textureLoadCallback(unqualifiedName, loadData);

        // Check if callback provided an existing texture ID (a GL texture name on the GL device)
        if (loadData.textureId != 0 && loadData.width > 0 && loadData.height > 0)
        {
            // App-provided textures are not owned by projectM - pass false for ownership
            auto newTexture = std::make_shared<Texture>(unqualifiedName, Device::TextureHandle{loadData.textureId},
                                                        Device::TextureTarget::Texture2D, loadData.width, loadData.height, true, false);
            m_textures[lowerCaseUnqualifiedName] = newTexture;
            m_fileTextures.erase(lowerCaseUnqualifiedName);
            uint32_t memoryBytes = loadData.width * loadData.height * (loadData.channels > 0 ? loadData.channels : 4);
            m_textureStats.insert({lowerCaseUnqualifiedName, {memoryBytes}});
            LOG_DEBUG("[TextureManager] Loaded texture \"" + unqualifiedName + "\" from callback (texture ID)");
            return {newTexture, m_samplers.at({wrapMode, filterMode}), name, unqualifiedName};
        }
        else if (loadData.textureId != 0)
        {
            LOG_WARN("[TextureManager] Callback provided texture ID for \"" + unqualifiedName + "\" but width/height are invalid; falling back to filesystem");
        }

        // Check if callback provided raw pixel data
        if (loadData.data != nullptr && loadData.width > 0 && loadData.height > 0)
        {
            int width = static_cast<int>(loadData.width);
            int height = static_cast<int>(loadData.height);
            int channels = static_cast<int>(loadData.channels > 0 ? loadData.channels : 4);

            auto format = TextureFormatFromChannels(channels);
            auto newTexture = format ? std::make_shared<Texture>(unqualifiedName,
                                                                 reinterpret_cast<const void*>(loadData.data),
                                                                 Device::TextureTarget::Texture2D, width, height, 0,
                                                                 *format, true)
                                     : nullptr;
            if (newTexture && !newTexture->Empty())
            {
                m_textures[lowerCaseUnqualifiedName] = newTexture;
                m_fileTextures.erase(lowerCaseUnqualifiedName);
                uint32_t memoryBytes = width * height * channels;
                m_textureStats.insert({lowerCaseUnqualifiedName, {memoryBytes}});
                LOG_DEBUG("[TextureManager] Loaded texture \"" + unqualifiedName + "\" from callback (pixel data)");
                return {newTexture, m_samplers.at({wrapMode, filterMode}), name, unqualifiedName};
            }
            else
            {
                LOG_WARN("[TextureManager] Failed to create a texture from callback pixel data for \"" + unqualifiedName + "\"; falling back to filesystem");
            }
        }
    }

    // Fall back to filesystem loading
    ScanTextures();

    for (const auto& file : m_scannedTextureFiles)
    {
        if (file.lowerCaseBaseName != lowerCaseUnqualifiedName)
        {
            continue;
        }

        auto texture = LoadTexture(file);

        if (texture)
        {
            LOG_DEBUG("[TextureManager] Loaded texture \"" + unqualifiedName + "\" from file: " + file.filePath);
            return {texture, m_samplers.at({wrapMode, filterMode}), name, unqualifiedName};
        }
    }

    LOG_WARN("[TextureManager] Failed to find requested texture \"" + unqualifiedName + "\"");

    // Return a placeholder.
    return {m_placeholderTexture, m_samplers.at({wrapMode, filterMode}), name, unqualifiedName};
}

auto TextureManager::LoadTexture(const ScannedFile& file) -> std::shared_ptr<Texture>
{
    if (m_textures.find(file.lowerCaseBaseName) != m_textures.end())
    {
        return m_textures.at(file.lowerCaseBaseName);
    }

    int width{};
    int height{};

    std::unique_ptr<stbi_uc, decltype(&free)> imageData(stbi_load(file.filePath.c_str(), &width, &height, nullptr, 4), free);

    if (imageData.get() == nullptr)
    {
        LOG_DEBUG("[TextureManager] Failed to decode image data.");
        return {};
    }

    auto newTexture = std::make_shared<Texture>(file.lowerCaseBaseName, reinterpret_cast<const void*>(imageData.get()), Device::TextureTarget::Texture2D, width, height, 0, Device::TextureFormat::RGBA, true);

    imageData.reset();

    uint32_t const memoryBytes = width * height * 4; // RGBA, unsigned byte color channels.
    m_textures[file.lowerCaseBaseName] = newTexture;
    m_textureStats.insert({file.lowerCaseBaseName, {memoryBytes}});
    m_fileTextures.insert(file.lowerCaseBaseName);

    return newTexture;
}

auto TextureManager::GetRandomTexture(const std::string& randomName) -> TextureSamplerDescriptor
{
    std::string selectedFilename;

    std::random_device rndDevice;
    std::default_random_engine rndEngine(rndDevice());

    ScanTextures();

    std::string lowerCaseName = Utils::ToLower(randomName);

    if (m_scannedTextureFiles.empty())
    {
        LOG_DEBUG("[TextureManager] Texture file list is empty.");
        return {};
    }

    std::string prefix;
    if (lowerCaseName.length() > 7 && lowerCaseName.at(6) == '_')
    {
        prefix = lowerCaseName.substr(7);
    }

    if (prefix.empty())
    {
        // Just pick a random index.
        std::uniform_int_distribution<size_t> distribution(0, m_scannedTextureFiles.size() - 1);
        selectedFilename = m_scannedTextureFiles.at(distribution(rndEngine)).lowerCaseBaseName;
    }
    else
    {

        std::vector<ScannedFile> filteredFiles;
        auto prefixLength = prefix.length();
        std::copy_if(m_scannedTextureFiles.begin(), m_scannedTextureFiles.end(),
                     std::back_inserter(filteredFiles),
                     [&prefix, prefixLength](const ScannedFile& file) {
                         return file.lowerCaseBaseName.substr(0, prefixLength) == prefix;
                     });

        if (!filteredFiles.empty())
        {
            std::uniform_int_distribution<size_t> distribution(0, filteredFiles.size() - 1);
            selectedFilename = filteredFiles.at(distribution(rndEngine)).lowerCaseBaseName;
        }
    }

    // If a prefix was set and no file matched, filename can be empty.
    if (selectedFilename.empty())
    {
        LOG_DEBUG("[TextureManager] No random texture found. Prefix: \"" + prefix + "\".");
        return {};
    }

    // Use selected filename to load the texture.
    auto desc = GetTexture(selectedFilename);

    // Create new descriptor with the original "rand00[_prefix]" name.
    return {desc.Texture(), desc.Sampler(), randomName, randomName};
}

void TextureManager::AddTextureFile(const std::string& fileName, const std::string& baseName)
{
    std::string lowerCaseBaseName = Utils::ToLower(baseName);

    ScannedFile file;
    file.filePath = fileName;
    file.lowerCaseBaseName = lowerCaseBaseName;

    m_scannedTextureFiles.push_back(std::move(file));
}

auto TextureManager::ScannedTextureFileNames() -> std::vector<std::string>
{
    ScanTextures();

    std::vector<std::string> names;
    names.reserve(m_scannedTextureFiles.size());
    for (const auto& file : m_scannedTextureFiles)
    {
        names.push_back(file.lowerCaseBaseName);
    }
    return names;
}

auto TextureManager::VolumeTextureNames() const -> std::set<std::string>
{
    std::set<std::string> names;
    for (const auto& texture : m_textures)
    {
        if (texture.second && texture.second->Type() == Device::TextureTarget::Texture3D)
        {
            names.insert(texture.first);
        }
    }
    return names;
}

auto TextureManager::UnqualifiedTextureName(const std::string& qualifiedName) -> std::string
{
    Device::WrapMode wrapMode{};
    Device::FilterMode filterMode{};
    std::string name;
    ExtractTextureSettings(qualifiedName, wrapMode, filterMode, name);
    return name;
}

void TextureManager::ExtractTextureSettings(const std::string& qualifiedName, Device::WrapMode& wrapMode, Device::FilterMode& filterMode, std::string& name)
{
    if (qualifiedName.length() <= 3 || qualifiedName.at(2) != '_')
    {
        name = qualifiedName;
        filterMode = Device::FilterMode::Linear;
        wrapMode = Device::WrapMode::Repeat;
        return;
    }

    std::string lowerQualifiedName = Utils::ToLower(qualifiedName);

    // Default mode for user textures is "fw" (bilinear filtering + wrap).
    wrapMode = Device::WrapMode::Repeat;
    filterMode = Device::FilterMode::Linear;

    if (lowerQualifiedName.substr(0, 3) == "fc_" || lowerQualifiedName.substr(0, 3) == "cf_")
    {
        name = qualifiedName.substr(3);
        filterMode = Device::FilterMode::Linear;
        wrapMode = Device::WrapMode::ClampToEdge;
    }
    else if (lowerQualifiedName.substr(0, 3) == "fw_" || lowerQualifiedName.substr(0, 3) == "wf_")
    {
        name = qualifiedName.substr(3);
        filterMode = Device::FilterMode::Linear;
        wrapMode = Device::WrapMode::Repeat;
    }
    else if (lowerQualifiedName.substr(0, 3) == "pc_" || lowerQualifiedName.substr(0, 3) == "cp_")
    {
        name = qualifiedName.substr(3);
        filterMode = Device::FilterMode::Nearest;
        wrapMode = Device::WrapMode::ClampToEdge;
    }
    else if (lowerQualifiedName.substr(0, 3) == "pw_" || lowerQualifiedName.substr(0, 3) == "wp_")
    {
        name = qualifiedName.substr(3);
        filterMode = Device::FilterMode::Nearest;
        wrapMode = Device::WrapMode::Repeat;
    }
    else
    {
        name = qualifiedName.substr(3); // Milkdrop also removes the XY_ prefix in the case nothing matches.
        filterMode = Device::FilterMode::Linear;
        wrapMode = Device::WrapMode::Repeat;
    }
}

void TextureManager::ScanTextures()
{
    if (!m_filesScanned)
    {
        FileScanner fileScanner = FileScanner(m_textureSearchPaths, m_extensions);

        using namespace std::placeholders;
        fileScanner.Scan(std::bind(&TextureManager::AddTextureFile, this, _1, _2));
        m_filesScanned = true;
    }
}

auto TextureManager::TextureFormatFromChannels(int channels) -> std::optional<Device::TextureFormat>
{
    switch (channels)
    {
        case 1:
            return Device::TextureFormat::R;
        case 2:
            return Device::TextureFormat::RG;
        case 3:
            return Device::TextureFormat::RGB;
        case 4:
            return Device::TextureFormat::RGBA;
        default:
            return std::nullopt;
    }
}

void TextureManager::SetTextureLoadCallback(TextureLoadCallback callback)
{
    m_textureLoadCallback = std::move(callback);
}

} // namespace Renderer
} // namespace libprojectM
