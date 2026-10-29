#pragma once

#include <cmath>
#include <cstdint>
#include <string>
#include <string_view>

namespace libprojectM {
namespace Utils {

/**
 * @brief 64-bit FNV-1a hash of @a text.
 *
 * Stable across compilers and platforms, and 64 bits wide everywhere. Use it instead of
 * std::hash for anything used as a cache key: std::hash<std::string> is only 32 bits on
 * wasm32, so two keys colliding there is a realistic event rather than a theoretical one.
 */
auto Fnv1a64(std::string_view text) -> std::uint64_t;

/**
 * @brief Converts an expression value to int without undefined behavior.
 *
 * A plain static_cast<int> of NaN, infinity or anything outside int's range is UB natively
 * (WASM only saturates because it builds with -mnontrapping-fptoint). Preset equations can
 * produce any of those, so every double that came out of an expression goes through this.
 *
 * @return @a value truncated toward zero and clamped to [@a lo, @a hi]; NaN returns @a lo.
 */
inline auto SaturatingToInt(double value, int lo, int hi) -> int
{
    if (!(value > static_cast<double>(lo))) // also catches NaN
    {
        return lo;
    }
    if (value >= static_cast<double>(hi))
    {
        return hi;
    }
    return static_cast<int>(value);
}

/**
 * @brief The truth value of an expression value, as static_cast<int>(value) != 0 would give it
 *        for finite values, without the cast: NaN is false, infinities are true.
 */
inline auto ExpressionIsTrue(double value) -> bool
{
    return std::fabs(value) >= 1.0;
}

auto ToLower(const std::string& str) -> std::string;
auto ToUpper(const std::string& str) -> std::string;

void ToLowerInPlace(std::string& str);
void ToUpperInPlace(std::string& str);

/**
 * @brief Strips C and C++ style comments from source code.
 *
 * Replaces // line comments and block comments with spaces, preserving
 * string length and newline positions so that character offsets remain valid.
 *
 * @param source The source code string to strip comments from.
 * @return A copy of the source with all comment content replaced by spaces.
 */
auto StripComments(const std::string& source) -> std::string;

} // namespace Utils
} // namespace libprojectM
