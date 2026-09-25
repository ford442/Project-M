#pragma once

#include "Renderer/Shader.hpp"

#include <cstddef>
#include <list>
#include <map>
#include <memory>
#include <string>

namespace libprojectM {
namespace Renderer {

/**
 * @brief Instance shader cache.
 *
 * Used to store shaders which only need to be compiled once per projectM instance.
 * Removes the need for the previously used static shader provider, and reduces
 * shader recompilation times.
 *
 * Shaders are accessed by arbitrary strings as keys.
 *
 * Most entries are permanent: a fixed set of built-in programs, inserted with Insert().
 * Programs generated per preset (the GPU per-pixel warp programs) are inserted with
 * InsertEvictable() instead, and only the most recently used EvictableCapacity() of them
 * are kept, so a long session cycling through presets does not accumulate one GL program
 * per preset it has ever shown.
 *
 * All cached shader programs will be properly deleted when the projectM instance is destroyed.
 * Classes storing a reference to a cached shader should ideally use an std::weak_ptr to do so.
 * A class that must keep using an evictable program for as long as it lives holds a
 * std::shared_ptr instead: eviction then only drops the cache's reference, and the program
 * is deleted when its last user lets go of it.
 */
class ShaderCache
{
public:
    /**
     * @brief Default number of evictable programs kept. Generous next to the two or three
     *        presets that render at any one time, small next to a playlist.
     */
    static constexpr std::size_t DefaultEvictableCapacity = 32;

    /**
     * @brief Adds a new shader to the cache.
     * If the shader already exists, the existing cache entry it NOT replaced.
     * @param key The key to store the shader with.
     * @param shader A shared pointer to the shader program to be cached.
     */
    void Insert(const std::string& key, const std::shared_ptr<Shader>& shader);

    /**
     * @brief Adds a new shader to the cache.
     * If the shader already exists, the existing cache entry it NOT replaced.
     * @param key The key to store the shader with.
     * @param shader A shared pointer to the shader program to be cached.
     */
    void Insert(const std::string& key, std::shared_ptr<Shader>&& shader);

    /**
     * @brief Adds a shader that may be evicted again when it has not been used for a while.
     *
     * The entry becomes the most recently used one. If that leaves more than
     * EvictableCapacity() evictable entries, the least recently used ones are removed.
     * If the key already exists, the existing cache entry is NOT replaced.
     * @param key The key to store the shader with.
     * @param shader A shared pointer to the shader program to be cached.
     */
    void InsertEvictable(const std::string& key, const std::shared_ptr<Shader>& shader);

    /**
     * @brief Removes a shader from the cache.
     * If the key does not exist in the cache, this function will not do anything.
     * @param key The key of the sahder to be removed.
     */
    void Remove(const std::string& key);

    /**
     * @brief Returns a cached shader.
     *
     * Marks an evictable entry as the most recently used one.
     * @param key the key of the cached shader to be returned.
     * @return A shared pointer to the cached shader program, or nullptr if the key wasn't found.
     */
    auto Get(const std::string& key) const -> std::shared_ptr<Shader>;

    /**
     * @brief Changes how many evictable entries are kept, evicting any excess right away.
     * @param capacity The new capacity. Zero keeps none.
     */
    void SetEvictableCapacity(std::size_t capacity);

    /**
     * @brief How many evictable entries are kept at most.
     */
    auto EvictableCapacity() const -> std::size_t;

    /**
     * @brief How many evictable entries the cache currently holds.
     */
    auto EvictableCount() const -> std::size_t;

private:
    struct Entry {
        std::shared_ptr<Shader> shader;             //!< The cached program.
        bool evictable{false};                      //!< Inserted with InsertEvictable().
        std::list<std::string>::iterator recentUse; //!< Position in m_recentlyUsed, if evictable.
    };

    /**
     * @brief Removes least recently used evictable entries until at most the capacity remain.
     */
    void EvictExcess();

    std::map<std::string, Entry> m_cachedShaders;
    mutable std::list<std::string> m_recentlyUsed;             //!< Evictable keys, most recently used first.
    std::size_t m_evictableCapacity{DefaultEvictableCapacity}; //!< Evictable entries kept at most.
};

} // namespace Renderer
} // namespace libprojectM
