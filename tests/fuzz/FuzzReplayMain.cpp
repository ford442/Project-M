// main() for the fuzz targets when they are built without libFuzzer (BUILD_TESTING without
// ENABLE_FUZZING, any compiler): runs LLVMFuzzerTestOneInput() once on every file named on
// the command line, recursing into directories, so ctest replays the regression corpus in
// the ordinary Debug/Release and sanitizer CI builds. Arguments starting with '-' are
// libFuzzer flags (-runs=0 ...) and are ignored, so both builds take the same command line.
// Dotfiles (.gitkeep) are skipped. Exits non-zero only if an input could not be read; a
// real finding crashes, aborts or trips a sanitizer.

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size);

namespace {

auto RunFile(const std::filesystem::path& path) -> bool
{
    std::ifstream file(path, std::ios_base::in | std::ios_base::binary);
    if (!file)
    {
        std::fprintf(stderr, "fuzz replay: cannot read %s\n", path.string().c_str());
        return false;
    }
    std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    std::fprintf(stderr, "fuzz replay: %s (%zu bytes)\n", path.string().c_str(), bytes.size());
    // Like libFuzzer, never hand the target a null pointer for an empty input.
    static const uint8_t empty = 0;
    LLVMFuzzerTestOneInput(bytes.empty() ? &empty : bytes.data(), bytes.size());
    return true;
}

auto IsHidden(const std::filesystem::path& path) -> bool
{
    const auto name = path.filename().string();
    return !name.empty() && name.front() == '.';
}

} // namespace

int main(int argc, char** argv)
{
    size_t inputs = 0;
    bool ok = true;
    for (int arg = 1; arg < argc; arg++)
    {
        const std::string value = argv[arg];
        if (value.empty() || value.front() == '-')
        {
            continue;
        }
        const std::filesystem::path path(value);
        std::error_code error;
        if (std::filesystem::is_directory(path, error))
        {
            std::vector<std::filesystem::path> files;
            for (const auto& entry : std::filesystem::recursive_directory_iterator(path, error))
            {
                if (entry.is_regular_file() && !IsHidden(entry.path()))
                {
                    files.push_back(entry.path());
                }
            }
            std::sort(files.begin(), files.end());
            for (const auto& file : files)
            {
                ok = RunFile(file) && ok;
                inputs++;
            }
        }
        else
        {
            ok = RunFile(path) && ok;
            inputs++;
        }
    }
    std::fprintf(stderr, "fuzz replay: %zu input(s) run\n", inputs);
    return ok ? 0 : 1;
}
