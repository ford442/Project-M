#pragma once

#include "FileScanner.hpp"
#include "Texture.hpp"
#include "projectM-opengl.h"
#include <iostream>
#include <map>
#include <string>
#include <vector>


class TextureManager
{
public:
    /**
     * Constructor.
     * @param textureSearchPaths List of paths to search for textures. These paths are search in the given order.
     */
    TextureManager(std::vector<std::string>& textureSearchPaths);
    ~TextureManager();

    TextureSamplerDesc tryLoadingTexture(const std::string name);
    TextureSamplerDesc getTexture(const std::string fullName, const GLenum defaultWrap, const GLenum defaultFilter);
    TextureSamplerDesc getRandomTextureName(std::string rand_name);
    void clearRandomTextures();

private:
    void Clear();
    void Preload();

    TextureSamplerDesc loadTexture(const std::string name, const std::string imageUrl);
    void ExtractTextureSettings(const std::string qualifiedName, GLint& _wrap_mode, GLint& _filter_mode, std::string& name);

    std::vector<std::string>& m_textureDirectories;
    std::map<std::string, Texture*> m_textures;
    std::vector<std::string> m_randomTextures;
    std::vector<std::string> m_extensions{".jpg", ".jpeg", ".dds", ".png", ".tga", ".bmp", ".dib"};
};
