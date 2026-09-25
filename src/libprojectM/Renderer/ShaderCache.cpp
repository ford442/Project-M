#include "ShaderCache.hpp"

#include <utility>

namespace libprojectM {
namespace Renderer {

void ShaderCache::Insert(const std::string& key, const std::shared_ptr<Shader>& shader)
{
    m_cachedShaders.emplace(key, Entry{shader, false, {}});
}

void ShaderCache::Insert(const std::string& key, std::shared_ptr<Shader>&& shader)
{
    m_cachedShaders.emplace(key, Entry{std::move(shader), false, {}});
}

void ShaderCache::InsertEvictable(const std::string& key, const std::shared_ptr<Shader>& shader)
{
    if (m_cachedShaders.find(key) != m_cachedShaders.end())
    {
        return;
    }

    m_recentlyUsed.push_front(key);
    m_cachedShaders.emplace(key, Entry{shader, true, m_recentlyUsed.begin()});
    EvictExcess();
}

void ShaderCache::Remove(const std::string& key)
{
    const auto entry = m_cachedShaders.find(key);
    if (entry == m_cachedShaders.end())
    {
        return;
    }

    if (entry->second.evictable)
    {
        m_recentlyUsed.erase(entry->second.recentUse);
    }
    m_cachedShaders.erase(entry);
}

auto ShaderCache::Get(const std::string& key) const -> std::shared_ptr<Shader>
{
    const auto entry = m_cachedShaders.find(key);
    if (entry == m_cachedShaders.end())
    {
        return {};
    }

    if (entry->second.evictable)
    {
        // Moving the node keeps every stored iterator valid.
        m_recentlyUsed.splice(m_recentlyUsed.begin(), m_recentlyUsed, entry->second.recentUse);
    }

    return entry->second.shader;
}

void ShaderCache::SetEvictableCapacity(std::size_t capacity)
{
    m_evictableCapacity = capacity;
    EvictExcess();
}

auto ShaderCache::EvictableCapacity() const -> std::size_t
{
    return m_evictableCapacity;
}

auto ShaderCache::EvictableCount() const -> std::size_t
{
    return m_recentlyUsed.size();
}

void ShaderCache::EvictExcess()
{
    while (m_recentlyUsed.size() > m_evictableCapacity)
    {
        // Dropping the entry releases the cache's reference. The program is deleted
        // (glDeleteProgram in ~Shader) as soon as no preset still holds it.
        m_cachedShaders.erase(m_recentlyUsed.back());
        m_recentlyUsed.pop_back();
    }
}

} // namespace Renderer
} // namespace libprojectM
