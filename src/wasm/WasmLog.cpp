// WasmLog.cpp
//
// The console sink for projectM's log messages on the web, and the formatting
// front end src/wasm/ uses to log through Logging.hpp. See WasmLog.hpp.

#include "WasmLog.hpp"

#include <Logging.hpp>

#include <emscripten.h>
#include <projectM-4/logging.h>

#include <cstdarg>
#include <cstdio>
#include <mutex>
#include <string>

// level: projectm_log_level. Runs on whichever thread logged; on a pthread,
// console is that worker's and pmOnLog is not defined there.
// clang-format off
EM_JS(void, js_log_message, (int level, const char* message), {
    const text = UTF8ToString(message);
    if (level >= 5) {
        console.error(text);
    } else if (level === 4) {
        console.warn(text);
    } else {
        console.log(text);
    }
    if (typeof globalThis.pmOnLog === 'function') {
        try {
            globalThis.pmOnLog(level, text);
        } catch (e) {
        }
    }
});
// clang-format on

namespace {

void ConsoleLogSink(const char* message, projectm_log_level logLevel, void* /*userData*/)
{
    js_log_message(static_cast<int>(logLevel), message);
}

} // namespace

void WasmInstallLogSink()
{
    static std::once_flag installed;
    std::call_once(installed, [] {
        projectm_set_log_callback(&ConsoleLogSink, false, nullptr);
    });
}

void WasmLog(WasmLogLevel level, const char* format, ...)
{
    using libprojectM::Logging;
    WasmInstallLogSink();

    va_list args;
    va_start(args, format);
    va_list sizeArgs;
    va_copy(sizeArgs, args);
    const int length = vsnprintf(nullptr, 0, format, sizeArgs);
    va_end(sizeArgs);
    std::string message(length > 0 ? static_cast<size_t>(length) : 0, '\0');
    if (length > 0)
    {
        vsnprintf(message.data(), message.size() + 1, format, args);
    }
    va_end(args);

    switch (level)
    {
        case WasmLogLevel::Info:
            LOG_INFO(message);
            break;
        case WasmLogLevel::Warning:
            LOG_WARN(message);
            break;
        case WasmLogLevel::Error:
            LOG_ERROR(message);
            break;
    }
}
