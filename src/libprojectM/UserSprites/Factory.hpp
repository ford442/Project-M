#pragma once

#include "UserSprites/Sprite.hpp"

#include "UserSprites/MilkdropSprite.hpp"

#include <memory>
#include <string>

namespace libprojectM {
namespace UserSprites {

class Factory
{
public:
    Factory() = delete;

    /**
     * @param type The sprite type name.
     * @param milkdropGlobals The engine's sprite gmegabuf and registers, for a "milkdrop" sprite.
     *                        Must outlive the sprite.
     */
    static auto CreateSprite(const std::string& type, MilkdropSpriteGlobals& milkdropGlobals) -> Sprite::Ptr;
};

} // namespace UserSprites
} // namespace libprojectM
