#include "ExperimentalDepthSampler.hpp"

#include "PresetFileParser.hpp"

#include <sstream>

namespace libprojectM {
namespace MilkdropPreset {

namespace {

auto IsIdentifierChar(char c) -> bool
{
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_';
}

auto IsTextureName(const std::string& name) -> bool
{
    if (name.empty())
    {
        return false;
    }
    for (char const c : name)
    {
        if (!IsIdentifierChar(c))
        {
            return false;
        }
    }
    return true;
}

} // namespace

auto ExperimentalDepthSampler::TextureFor(const std::string& directives) -> std::string
{
    bool wantsDepth = false;
    std::string texture;

    std::istringstream tokens(directives);
    std::string token;
    while (tokens >> token)
    {
        auto const equals = token.find('=');
        if (equals == std::string::npos)
        {
            continue;
        }
        std::string const key = token.substr(0, equals);
        std::string value = token.substr(equals + 1);
        if (key == "depth-texture")
        {
            // The bridge's docs name the VFS basename; it writes NAME.png. Accept either.
            for (const char* extension : {".png", ".jpg", ".jpeg"})
            {
                std::string const suffix(extension);
                if (value.length() > suffix.length() && value.compare(value.length() - suffix.length(), suffix.length(), suffix) == 0)
                {
                    value.erase(value.length() - suffix.length());
                    break;
                }
            }
            if (IsTextureName(value))
            {
                texture = value;
                wantsDepth = true;
            }
        }
        else if (key == "depth" && (value == "auto" || value == "true"))
        {
            wantsDepth = true;
        }
    }

    if (!wantsDepth)
    {
        return {};
    }
    return texture.empty() ? DefaultTexture : texture;
}

auto ExperimentalDepthSampler::Apply(const std::string& shaderCode, const std::string& texture) -> std::string
{
    if (texture.empty())
    {
        return shaderCode;
    }

    std::string const sampler(SamplerName);
    std::string const texSize = std::string("texsize_") + SamplerName;

    std::string result;
    result.reserve(shaderCode.size());
    size_t pos = 0;
    while (pos < shaderCode.size())
    {
        if (!IsIdentifierChar(shaderCode[pos]))
        {
            result.push_back(shaderCode[pos]);
            pos++;
            continue;
        }

        size_t end = pos;
        while (end < shaderCode.size() && IsIdentifierChar(shaderCode[end]))
        {
            end++;
        }
        std::string const identifier = shaderCode.substr(pos, end - pos);
        if (identifier == sampler)
        {
            // "fc_": bilinear and clamped, so parallax lookups past the edge do not wrap. The
            // prefix also protects names like "pm_depth_map", whose "pm_" Milkdrop would
            // otherwise strip as a filter/wrap prefix and look up "depth_map".
            result.append("sampler_fc_").append(texture);
        }
        else if (identifier == texSize)
        {
            result.append("texsize_").append(texture);
        }
        else
        {
            result.append(identifier);
        }
        pos = end;
    }
    return result;
}

auto ExperimentalDepthSampler::ShaderCode(const PresetFileParser& parser, const std::string& keyPrefix) -> std::string
{
    return Apply(parser.GetCode(keyPrefix), TextureFor(parser.ExperimentalDirectives()));
}

} // namespace MilkdropPreset
} // namespace libprojectM
