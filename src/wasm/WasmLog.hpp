// WasmLog.hpp
//
// What src/wasm/ reports goes through libprojectM's Logging (Logging.hpp), the
// same path the library's own LOG_* messages take, instead of printf/fprintf.
// One global log callback (installed on first use) writes each message to the
// browser console at its level and hands it to globalThis.pmOnLog(level,
// message) when the page defines one. Before it existed the library's messages
// went nowhere on the web, because no callback was ever registered.
//
// scripts/check_wasm_no_printf.sh keeps printf/fprintf out of src/wasm/; the
// console write in WasmLog.cpp is the one exception.

#pragma once

enum class WasmLogLevel
{
    Info,
    Warning,
    Error
};

// Registers the console sink as projectM's global log callback. Idempotent; WasmLog() calls it.
void WasmInstallLogSink();

// printf-style formatting, then Logging::Log at `level` (dropped below the configured log level).
void WasmLog(WasmLogLevel level, const char* format, ...) __attribute__((format(printf, 2, 3)));

#define WASM_LOG_INFO(...) WasmLog(WasmLogLevel::Info, __VA_ARGS__)
#define WASM_LOG_WARN(...) WasmLog(WasmLogLevel::Warning, __VA_ARGS__)
#define WASM_LOG_ERROR(...) WasmLog(WasmLogLevel::Error, __VA_ARGS__)
