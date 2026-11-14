# GenerateWasmApi.cmake
#
# Generates, from cmake/WasmApiManifest.cmake (included through
# EmscriptenWasmFlags.cmake by GenerateWasmLinkCommon.cmake, which includes
# this file and sets _impl_out, _exports_out, _ts_out and _js_out):
#
#   src/wasm/generated/WasmApiImpl.hpp     WasmApi:: declarations the TUs define
#   src/wasm/generated/WasmApiExports.cpp  every extern "C" export, each a
#                                          barrier (WasmApiBarrier.hpp) over
#                                          its WasmApi:: implementation
#   html/generated/projectm-wasm-api.ts/.js  typed wrappers, signatures,
#                                          bindModuleToHost(), createHostApi()
#
# Regenerate with scripts/sync_wasm_link_common.sh; CI checks the files are
# current with scripts/verify_wasm_link_common.sh.

function(_projectm_wasm_snake_to_camel snake out_var)
    string(REPLACE "_" ";" _parts "${snake}")
    set(_camel "")
    set(_first TRUE)
    foreach(_part IN LISTS _parts)
        if(_first)
            set(_camel "${_part}")
            set(_first FALSE)
        else()
            string(SUBSTRING "${_part}" 0 1 _initial)
            string(TOUPPER "${_initial}" _initial)
            string(SUBSTRING "${_part}" 1 -1 _rest)
            set(_camel "${_camel}${_initial}${_rest}")
        endif()
    endforeach()
    set(${out_var} "${_camel}" PARENT_SCOPE)
endfunction()

# Manifest type -> C++ type.
function(_projectm_wasm_cxx_type type out_var)
    if(type STREQUAL "void")
        set(_t "void")
    elseif(type STREQUAL "bool")
        set(_t "bool")
    elseif(type STREQUAL "i32")
        set(_t "int")
    elseif(type STREQUAL "u32")
        set(_t "uint32_t")
    elseif(type STREQUAL "f32")
        set(_t "float")
    elseif(type STREQUAL "f64")
        set(_t "double")
    elseif(type STREQUAL "usize")
        set(_t "uintptr_t")
    elseif(type STREQUAL "cstr")
        set(_t "const char*")
    elseif(type STREQUAL "i32*")
        set(_t "int32_t*")
    elseif(type STREQUAL "u32*")
        set(_t "uint32_t*")
    elseif(type STREQUAL "f32*")
        set(_t "float*")
    elseif(type STREQUAL "u8*")
        set(_t "uint8_t*")
    else()
        message(FATAL_ERROR "WASM API manifest: unknown type '${type}'")
    endif()
    set(${out_var} "${_t}" PARENT_SCOPE)
endfunction()

# Manifest type -> JS-facing type (what the generated wrappers take/return):
# number | boolean | string | pointer | void.
function(_projectm_wasm_js_type type out_var)
    if(type STREQUAL "void")
        set(_t "void")
    elseif(type STREQUAL "bool")
        set(_t "boolean")
    elseif(type STREQUAL "cstr")
        set(_t "string")
    elseif(type MATCHES "\\*$")
        set(_t "pointer")
    else()
        set(_t "number")
    endif()
    set(${out_var} "${_t}" PARENT_SCOPE)
endfunction()

# JS type -> TypeScript type.
function(_projectm_wasm_ts_type js_type out_var)
    if(js_type STREQUAL "void" OR js_type STREQUAL "boolean" OR js_type STREQUAL "string")
        set(${out_var} "${js_type}" PARENT_SCOPE)
    else()
        set(${out_var} "number" PARENT_SCOPE)
    endif()
endfunction()

# "a:i32,b:cstr" -> cxx params "int a, const char* b", call args "a, b".
function(_projectm_wasm_cxx_params args out_params out_call)
    set(_params "")
    set(_call "")
    if(NOT args STREQUAL "")
        string(REPLACE "," ";" _pairs "${args}")
        foreach(_pair IN LISTS _pairs)
            string(REPLACE ":" ";" _fields "${_pair}")
            list(GET _fields 0 _arg_name)
            list(GET _fields 1 _arg_type)
            _projectm_wasm_cxx_type("${_arg_type}" _cxx)
            list(APPEND _params "${_cxx} ${_arg_name}")
            list(APPEND _call "${_arg_name}")
        endforeach()
    endif()
    list(JOIN _params ", " _params)
    list(JOIN _call ", " _call)
    set(${out_params} "${_params}" PARENT_SCOPE)
    set(${out_call} "${_call}" PARENT_SCOPE)
endfunction()

# Joins "first" and "rest" with ", " when both are non-empty.
function(_projectm_wasm_join_args first rest out_var)
    if(first STREQUAL "")
        set(${out_var} "${rest}" PARENT_SCOPE)
    elseif(rest STREQUAL "")
        set(${out_var} "${first}" PARENT_SCOPE)
    else()
        set(${out_var} "${first}, ${rest}" PARENT_SCOPE)
    endif()
endfunction()

# =============================================================================
# C++: WasmApiImpl.hpp + WasmApiExports.cpp
# =============================================================================
set(_impl_decls "")
set(_export_protos "")
set(_export_defs "")

foreach(_entry IN LISTS PROJECTM_WASM_API_MANIFEST)
    projectm_wasm_api_parse("${_entry}" e)
    if(e_kind STREQUAL "runtime")
        continue()
    endif()

    _projectm_wasm_cxx_type("${e_return_type}" _ret)
    _projectm_wasm_cxx_params("${e_args}" _params _call)
    _projectm_wasm_cxx_params("${e_impl_args}" _impl_params _impl_call)
    if(e_return_failure STREQUAL "")
        set(_failure "{}")
    else()
        set(_failure "${e_return_failure}")
    endif()
    if(_ret STREQUAL "void")
        set(_return "")
        set(_template "")
        set(_failure_arg "")
    else()
        set(_return "return ")
        set(_template "<${_ret}>")
        set(_failure_arg "${_failure}, ")
    endif()

    # ---- implementation declaration ----
    set(_host_scoped FALSE)
    if(e_kind STREQUAL "host" OR e_kind STREQUAL "host-v2" OR e_kind STREQUAL "handle" OR e_kind STREQUAL "handle-or-active")
        set(_host_scoped TRUE)
    endif()
    if(_host_scoped)
        _projectm_wasm_join_args("WasmHost& host" "${_impl_params}" _decl_params)
        string(APPEND _impl_decls "${_ret} ${e_impl}(${_decl_params});\n")
    elseif(NOT e_kind STREQUAL "alias")
        string(APPEND _impl_decls "${_ret} ${e_impl}(${_params});\n")
    endif()

    # ---- exports ----
    _projectm_wasm_join_args("h" "${_impl_call}" _host_call)
    set(_host_lambda "[&](WasmHost& h) { ${_return}WasmApi::${e_impl}(${_host_call}); }")

    if(_host_scoped)
        # pm_<name>(host, ...): the one barrier of this export.
        _projectm_wasm_join_args("uintptr_t host" "${_impl_params}" _v2_params)
        string(APPEND _export_protos "${_ret} ${e_v2}(${_v2_params});\n")
        string(APPEND _export_defs "
// ${e_doc}
EMSCRIPTEN_KEEPALIVE
${_ret} ${e_v2}(${_v2_params})
{
    ${_return}WithHost${_template}(host, ${_failure_arg}\"${e_v2}\", ${_host_lambda});
}
")
    endif()

    # Compat names forward to the pm_ export, so each export has one barrier.
    set(_pm_name "pm_${e_impl}")
    if(e_kind STREQUAL "host" OR e_kind STREQUAL "alias")
        _projectm_wasm_join_args("ActiveHostHandle()" "${_call}" _forward_call)
        string(APPEND _export_defs "
// Compat shim: ${_pm_name}() on the host set_active_host() selected.
EMSCRIPTEN_KEEPALIVE
${_ret} ${e_legacy}(${_params})
{
    ${_return}${_pm_name}(${_forward_call});
}
")
    elseif(e_kind STREQUAL "handle")
        # 0 names no host here (these names never had an implicit default).
        string(REGEX MATCH "^[^:,]+" _handle_arg "${e_args}")
        if(_ret STREQUAL "void")
            set(_body "if (${_handle_arg} != 0)\n    {\n        ${_pm_name}(${_call});\n    }")
        else()
            if(e_return_failure STREQUAL "")
                set(_failure_value "${_ret}{}")
            else()
                set(_failure_value "${_ret}{${e_return_failure}}")
            endif()
            set(_body "return ${_handle_arg} != 0 ? ${_pm_name}(${_call}) : ${_failure_value};")
        endif()
        string(APPEND _export_defs "
// Compat name of ${_pm_name}() (a stale, unknown or 0 ${_handle_arg} is a no-op).
EMSCRIPTEN_KEEPALIVE
${_ret} ${e_legacy}(${_params})
{
    ${_body}
}
")
    elseif(e_kind STREQUAL "handle-or-active")
        string(REGEX MATCH "^[^:,]+" _handle_arg "${e_args}")
        string(REGEX REPLACE "^[^,]+" "${_handle_arg} != 0 ? ${_handle_arg} : ActiveHostHandle()" _forward_call "${_call}")
        string(APPEND _export_defs "
// Compat name of ${_pm_name}() (${_handle_arg} 0 is the active host).
EMSCRIPTEN_KEEPALIVE
${_ret} ${e_legacy}(${_params})
{
    ${_return}${_pm_name}(${_forward_call});
}
")
    elseif(e_kind STREQUAL "module" OR e_kind STREQUAL "legacy")
        if(e_kind STREQUAL "legacy")
            set(_comment "Compat only: ${e_doc}")
        else()
            set(_comment "${e_doc}")
        endif()
        string(APPEND _export_defs "
// ${_comment}
EMSCRIPTEN_KEEPALIVE
${_ret} ${e_legacy}(${_params})
{
    ${_return}Guarded${_template}(${_failure_arg}\"${e_legacy}\", [&]() { ${_return}WasmApi::${e_impl}(${_call}); });
}
")
    endif()
endforeach()

file(WRITE "${_impl_out}" "// WasmApiImpl.hpp
// AUTO-GENERATED by cmake/GenerateWasmApi.cmake from cmake/WasmApiManifest.cmake
// — do not edit by hand. Regenerate: scripts/sync_wasm_link_common.sh
//
// The implementation of every WASM export. The src/wasm/ TUs define these;
// generated/WasmApiExports.cpp exports them. A host-scoped implementation gets
// the WasmHost its pm_ export resolved (or, for a compat shim, the active
// host) and must not look up any other: Host() is for the barriers only.
#pragma once

#include <cstdint>

struct WasmHost;

namespace WasmApi {

${_impl_decls}
} // namespace WasmApi
")

file(WRITE "${_exports_out}" "// WasmApiExports.cpp
// AUTO-GENERATED by cmake/GenerateWasmApi.cmake from cmake/WasmApiManifest.cmake
// — do not edit by hand. Regenerate: scripts/sync_wasm_link_common.sh
//
// Every extern \"C\" export of the wrapper. Each engine call is one barrier
// (WasmApiBarrier.hpp) around its WasmApi:: implementation:
//   WithHost   pm_<name>(host, ...): resolve the handle, bind the host (its GL
//              context current), catch exceptions into the host's last error,
//              return the failure value otherwise
//   Guarded    module-level and compat-only exports
// and every compat name of an engine call forwards to its pm_ export: with
// ActiveHostHandle() (the host set_active_host() selected), or with the handle
// it was given.
// See docs/WASM_JS_API.md (\"ABI v2\").
#include \"WasmApiBarrier.hpp\"
#include \"generated/WasmApiImpl.hpp\"

#include <emscripten.h>

extern \"C\" {

${_export_protos}${_export_defs}
} // extern \"C\"
")

# =============================================================================
# JavaScript / TypeScript
# =============================================================================
set(_ts_module_members "")
set(_ts_wrappers "")
set(_js_wrappers "")
set(_symbols "")
set(_signature_lines "")
set(_host_symbol_lines "")
set(_public_names "")
set(_ts_host_api_members "")
set(_host_api_items "")

foreach(_entry IN LISTS PROJECTM_WASM_API_MANIFEST)
    projectm_wasm_api_parse("${_entry}" e)
    if(e_kind STREQUAL "runtime")
        continue()
    endif()

    # A host-v2 entry has no compat name: its JS wrapper calls the pm_ export
    # and takes the host as an explicit first argument.
    if(e_kind STREQUAL "host-v2")
        set(_symbol "${e_v2}")
        _projectm_wasm_join_args("host:usize" "${e_args}" _js_args)
    else()
        set(_symbol "${e_legacy}")
        set(_js_args "${e_args}")
    endif()
    _projectm_wasm_snake_to_camel("${_symbol}" _js_name)
    _projectm_wasm_js_type("${e_return_type}" _js_ret)
    _projectm_wasm_ts_type("${_js_ret}" _ts_ret)

    set(_ts_params "")
    set(_js_params "")
    set(_wasm_params "")
    set(_ccall_types "")
    set(_call_args "")
    set(_param_types "")
    if(NOT _js_args STREQUAL "")
        string(REPLACE "," ";" _pairs "${_js_args}")
        foreach(_pair IN LISTS _pairs)
            string(REPLACE ":" ";" _fields "${_pair}")
            list(GET _fields 0 _arg_name)
            list(GET _fields 1 _arg_type)
            _projectm_wasm_js_type("${_arg_type}" _js_arg)
            _projectm_wasm_ts_type("${_js_arg}" _ts_arg)
            list(APPEND _ts_params "${_arg_name}: ${_ts_arg}")
            list(APPEND _js_params "${_arg_name}")
            if(_js_arg STREQUAL "string")
                list(APPEND _ccall_types "'string'")
                list(APPEND _wasm_params "${_arg_name}: number")
            else()
                list(APPEND _ccall_types "'number'")
                list(APPEND _wasm_params "${_arg_name}: number")
            endif()
            list(APPEND _param_types "'${_ts_arg}'")
            if(_js_arg STREQUAL "boolean")
                list(APPEND _call_args "${_arg_name} ? 1 : 0")
            else()
                list(APPEND _call_args "${_arg_name}")
            endif()
        endforeach()
    endif()
    list(JOIN _ts_params ", " _ts_params)
    list(JOIN _js_params ", " _js_params)
    list(JOIN _wasm_params ", " _wasm_params)
    list(JOIN _ccall_types ", " _ccall_types)
    list(JOIN _call_args ", " _call_args)
    list(JOIN _param_types ", " _param_types)

    if(_js_ret STREQUAL "void")
        set(_ccall_ret "null")
    else()
        set(_ccall_ret "'${_ts_ret}'")
    endif()

    # Module members (direct bindings only; ccall-only symbols are not on the
    # module object). pm_ exports are optional: bundles before ABI v2 lack them.
    if(e_binding STREQUAL "direct")
        string(APPEND _ts_module_members "    _${_symbol}: (${_wasm_params}) => ${_ts_ret};\n")
        if(NOT e_v2 STREQUAL "" AND NOT e_kind STREQUAL "host-v2")
            set(_v2_wasm_params "${_wasm_params}")
            if(e_host_mode STREQUAL "prepend")
                _projectm_wasm_join_args("host: number" "${_wasm_params}" _v2_wasm_params)
            endif()
            string(APPEND _ts_module_members "    _${e_v2}?: (${_v2_wasm_params}) => ${_ts_ret};\n")
        endif()
    endif()

    # Wrapper body.
    if(e_binding STREQUAL "ccall")
        set(_body "module.ccall('${_symbol}', ${_ccall_ret}, [${_ccall_types}], [${_call_args}])")
    else()
        set(_body "module._${_symbol}(${_call_args})")
        if(_js_ret STREQUAL "boolean")
            set(_body "!!${_body}")
        endif()
    endif()
    _projectm_wasm_join_args("module: ProjectMModule" "${_ts_params}" _ts_sig)
    _projectm_wasm_join_args("module" "${_js_params}" _js_sig)
    if(_js_ret STREQUAL "void")
        set(_ts_line "    ${_body};\n")
        set(_js_line "    ${_body};\n")
    elseif(e_binding STREQUAL "ccall")
        set(_ts_line "    return ${_body} as ${_ts_ret};\n")
        set(_js_line "    return ${_body};\n")
    else()
        set(_ts_line "    return ${_body};\n")
        set(_js_line "    return ${_body};\n")
    endif()
    string(APPEND _ts_wrappers "\n/** ${e_doc} */\nexport function ${_js_name}(${_ts_sig}): ${_ts_ret} {\n${_ts_line}}\n")
    string(APPEND _js_wrappers "\n/** ${e_doc} */\nexport function ${_js_name}(${_js_sig}) {\n${_js_line}}\n")

    string(APPEND _symbols "    ${_js_name}: '${_symbol}',\n")
    if(e_host_symbol STREQUAL "")
        set(_sig_host "hostSymbol: null, hostMode: null")
    else()
        set(_sig_host "hostSymbol: '${e_host_symbol}', hostMode: '${e_host_mode}'")
        string(APPEND _host_symbol_lines "    ['${_symbol}', ['${e_host_symbol}', '${e_host_mode}']],\n")
    endif()
    string(APPEND _signature_lines
        "    ${_js_name}: { symbol: '${_symbol}', returnType: ${_ccall_ret}, argTypes: [${_ccall_types}], paramTypes: [${_param_types}], ${_sig_host} },\n")

    if(e_visibility STREQUAL "public")
        list(APPEND _public_names "    ${_js_name}")
    endif()

    # createHostApi(): one method per engine call, named after the
    # implementation (spriteCreate, not projectmSpriteCreateWrapper), taking
    # what the implementation takes after the host.
    if(NOT e_kind STREQUAL "module" AND NOT e_kind STREQUAL "legacy" AND NOT e_kind STREQUAL "alias")
        _projectm_wasm_snake_to_camel("${e_impl}" _api_name)
        set(_api_ts_params "")
        set(_api_js_params "")
        if(NOT e_impl_args STREQUAL "")
            string(REPLACE "," ";" _pairs "${e_impl_args}")
            foreach(_pair IN LISTS _pairs)
                string(REPLACE ":" ";" _fields "${_pair}")
                list(GET _fields 0 _arg_name)
                list(GET _fields 1 _arg_type)
                _projectm_wasm_js_type("${_arg_type}" _js_arg)
                _projectm_wasm_ts_type("${_js_arg}" _ts_arg)
                list(APPEND _api_ts_params "${_arg_name}: ${_ts_arg}")
                list(APPEND _api_js_params "${_arg_name}")
            endforeach()
        endif()
        list(JOIN _api_ts_params ", " _api_ts_params)
        list(JOIN _api_js_params ", " _api_js_params)
        if(e_kind STREQUAL "host")
            _projectm_wasm_join_args("view" "${_api_js_params}" _api_call)
        else()
            # host-v2 and handle entries take the handle explicitly.
            _projectm_wasm_join_args("view, host" "${_api_js_params}" _api_call)
        endif()
        string(APPEND _ts_host_api_members "    /** ${e_doc} */\n    ${_api_name}(${_api_ts_params}): ${_ts_ret};\n")
        string(APPEND _host_api_items "        ${_api_name}: (${_api_js_params}) => ${_js_name}(${_api_call}),\n")
    endif()
endforeach()
list(JOIN _public_names ",\n" _public_names)

# ---- bindModuleToHost() -------------------------------------------------------
# A view of the module bound to one engine. With an ABI v2 bundle (it exports
# pm_host_is_live) every engine call reached through the view is rewritten to
# its pm_ export with the view's host as the handle: nothing is activated, so
# no other caller's set_active_host() can come between. A bundle from before
# ABI v2 gets the old behaviour: activate the host before each engine call.
set(_bind_doc "
/**
 * The pm_ export a host-bound view calls instead of each compat export, and
 * how it passes the host: 'prepend' inserts the host as the first argument,
 * 'first' means the first argument already is a host handle (0 meaning the
 * view's host). Exports not listed are not engine state and pass through.
 */")
set(_bind_doc_fn "
/**
 * A view of `module` bound to one engine: every engine export reached through
 * it, `module._sym(...)` and `module.ccall('sym', ...)` alike (hence every
 * wrapper in this file and every helper that takes a module), acts on `host`.
 *
 * With an ABI v2 bundle each call goes to the export's pm_ form with `host` as
 * its handle (0 is the implicit default host a legacy init() created), so the
 * call cannot land on another engine however long the caller awaited before
 * making it, and nothing changes which host is active. A bundle from before
 * ABI v2 has no pm_ exports; the view then selects `host` with
 * set_active_host() before each engine call (host 0 returns `module` itself).
 *
 * Either way a call through a view whose host has been destroyed throws rather
 * than reaching some other engine. Everything that is not an engine export (FS,
 * HEAP views, runtime helpers) is the module's own.
 */")
set(_bind_body "    const target = module as unknown as Record<string, unknown> & { ccall: EmscriptenModule['ccall'] };
    const isLive = target._pm_host_is_live as ((handle: number) => number) | undefined;
    if (typeof isLive === 'function') {
        const check = () => {
            if (!isLive(host)) {
                throw new Error(`projectM engine host \${host} no longer exists`);
            }
        };
        return new Proxy(target, {
            get(obj, property) {
                const value = Reflect.get(obj, property);
                if (typeof property !== 'string' || typeof value !== 'function') {
                    return value;
                }
                const fn = value as (...args: unknown[]) => unknown;
                if (property === 'ccall') {
                    return (name: string, returnType: unknown, argTypes: unknown[], args: unknown[], ...rest: unknown[]) => {
                        const route = HOST_SYMBOLS.get(name);
                        if (!route) {
                            return fn.call(obj, name, returnType, argTypes, args, ...rest);
                        }
                        check();
                        const [hostSymbol, mode] = route;
                        if (mode === 'first') {
                            const routed = [...args];
                            routed[0] = routed[0] || host;
                            return fn.call(obj, hostSymbol, returnType, argTypes, routed, ...rest);
                        }
                        return fn.call(obj, hostSymbol, returnType, ['number', ...argTypes], [host, ...args], ...rest);
                    };
                }
                const route = property.startsWith('_') ? HOST_SYMBOLS.get(property.slice(1)) : undefined;
                if (!route) {
                    return value;
                }
                const [hostSymbol, mode] = route;
                const routed = Reflect.get(obj, `_\${hostSymbol}`) as ((...args: unknown[]) => unknown) | undefined;
                if (typeof routed !== 'function') {
                    return value;
                }
                if (mode === 'first') {
                    return (handle: unknown, ...args: unknown[]) => {
                        check();
                        return routed.call(obj, handle || host, ...args);
                    };
                }
                return (...args: unknown[]) => {
                    check();
                    return routed.call(obj, host, ...args);
                };
            },
        }) as unknown as M;
    }
    if (!host) {
        return module;
    }
    // Before ABI v2: activate, and check the activation took. set_active_host()
    // ignores a handle that is no longer live and leaves the previous host
    // active, so a view that outlived its engine would quietly drive a
    // sibling's. Refuse instead.
    const getActive = target._get_active_host as (() => number) | undefined;
    const activate = () => {
        target.ccall('set_active_host', null, ['number'], [host]);
        if (typeof getActive === 'function' && getActive() !== host) {
            throw new Error(`projectM engine host \${host} no longer exists`);
        }
    };
    return new Proxy(target, {
        get(obj, property) {
            const value = Reflect.get(obj, property);
            if (typeof property !== 'string' || typeof value !== 'function') {
                return value;
            }
            const fn = value as (...args: unknown[]) => unknown;
            if (property === 'ccall') {
                return (name: string, ...rest: unknown[]) => {
                    if (HOST_SYMBOLS.has(name)) {
                        activate();
                    }
                    return fn.call(obj, name, ...rest);
                };
            }
            if (property.startsWith('_') && HOST_SYMBOLS.has(property.slice(1))) {
                return (...args: unknown[]) => {
                    activate();
                    return fn.apply(obj, args);
                };
            }
            return value;
        },
    }) as unknown as M;
")
set(_bind_body_js "${_bind_body}")
# Each item is "<TypeScript text>@@<JavaScript text>" ("@@" never occurs in
# the type text, unlike "|"). An empty right side deletes the type text.
foreach(_pair IN ITEMS
        " as unknown as Record<string, unknown> & { ccall: EmscriptenModule['ccall'] }@@"
        " as ((handle: number) => number) | undefined@@"
        " as ((...args: unknown[]) => unknown) | undefined@@"
        " as (() => number) | undefined@@"
        " as (...args: unknown[]) => unknown@@"
        "(name: string, returnType: unknown, argTypes: unknown[], args: unknown[], ...rest: unknown[])@@(name, returnType, argTypes, args, ...rest)"
        "(name: string, ...rest: unknown[])@@(name, ...rest)"
        "(handle: unknown, ...args: unknown[])@@(handle, ...args)"
        "(...args: unknown[])@@(...args)")
    string(FIND "${_pair}" "@@" _sep)
    string(SUBSTRING "${_pair}" 0 ${_sep} _from)
    math(EXPR _to_start "${_sep} + 2")
    string(SUBSTRING "${_pair}" ${_to_start} -1 _to)
    string(REPLACE "${_from}" "${_to}" _bind_body_js "${_bind_body_js}")
endforeach()
string(REPLACE "}) as unknown as M" "})" _bind_body_js "${_bind_body_js}")

set(_host_api_doc "
/**
 * The engine calls of one host as methods: `createHostApi(module, host).setMesh(48, 32)`.
 * Bound through {@link bindModuleToHost}, so every method acts on `host` (and
 * throws once it has been destroyed). Methods are named after the call, not
 * the compat export (spriteCreate, not projectmSpriteCreateWrapper), and take
 * what the call takes after the host.
 */")

# ---- TypeScript ----------------------------------------------------------------
file(WRITE "${_ts_out}" "// projectm-wasm-api.ts
// AUTO-GENERATED by cmake/GenerateWasmApi.cmake — do not edit by hand.
// Canonical definitions live in cmake/WasmApiManifest.cmake.
// Regenerate: scripts/sync_wasm_link_common.sh

/** Minimal Emscripten module surface used by projectM hosts. */
export interface EmscriptenModule {
    ccall: (name: string, returnType: string | null, argTypes: string[], args: unknown[]) => unknown;
    _malloc: (size: number) => number;
    _free: (ptr: number) => void;
    HEAPF32: Float32Array;
    FS?: {
        writeFile: (path: string, data: Uint8Array | string) => void;
    };
}

export type ProjectMModule = EmscriptenModule & {
${_ts_module_members}};

/** C symbol names for render-worker ccall proxying. */
export const WASM_API_SYMBOLS = {
${_symbols}} as const;

/** One row of {@link WASM_API_SIGNATURES}. */
export interface WasmApiSignature {
    /** The C symbol, as in {@link WASM_API_SYMBOLS}. */
    symbol: string;
    /** What to hand Module.ccall as its return type; null for void. */
    returnType: 'number' | 'string' | 'boolean' | null;
    /** ccall argument types, positional. */
    argTypes: Array<'number' | 'string'>;
    /** Manifest-level argument types, for coercing booleans to 0/1. */
    paramTypes: Array<'number' | 'string' | 'boolean'>;
    /** The pm_ export taking a host handle (ABI v2), or null for a non-engine call. */
    hostSymbol: string | null;
    /** How the host reaches hostSymbol: inserted first, or already the first argument. */
    hostMode: 'prepend' | 'first' | null;
}

/**
 * Everything needed to marshal a call without knowing its signature by hand.
 * Keyed like {@link WASM_API_SYMBOLS}; see html/projectm-render-transport.js,
 * which uses it to issue the same call over either topology.
 */
export const WASM_API_SIGNATURES: Record<string, WasmApiSignature> = {
${_signature_lines}};
${_bind_doc}
export const HOST_SYMBOLS: ReadonlyMap<string, readonly [string, 'prepend' | 'first']> = new Map<string, readonly [string, 'prepend' | 'first']>([
${_host_symbol_lines}]);
${_bind_doc_fn}
export function bindModuleToHost<M extends ProjectMModule>(module: M, host: number): M {
${_bind_body}}

/**
 * Feed interleaved float PCM into projectM (malloc + HEAPF32 marshaling).
 * @param channels Channel count (default 2).
 */
export function feedPcmFloat(
    module: ProjectMModule,
    data: Float32Array,
    samplesPerChannel: number,
    channels = 2,
): void {
    const ptr = module._malloc(data.length * 4);
    module.HEAPF32.set(data, ptr >> 2);
    try {
        module._projectm_pcm_add_float_wrapper(0, ptr, samplesPerChannel, channels);
    } finally {
        module._free(ptr);
    }
}
${_ts_wrappers}
/** One host's engine calls; see {@link createHostApi}. */
export interface HostApi {
    /** The host handle every method acts on. */
    readonly host: number;
${_ts_host_api_members}}
${_host_api_doc}
export function createHostApi(module: ProjectMModule, host: number): HostApi {
    const view = bindModuleToHost(module, host);
    return {
        host,
${_host_api_items}    };
}

/** Stable public embed API (see docs/WASM_JS_API.md). */
export const PUBLIC_WASM_API = [
${_public_names}
] as const;
")

# ---- JavaScript ----------------------------------------------------------------
file(WRITE "${_js_out}" "// projectm-wasm-api.js
// AUTO-GENERATED by cmake/GenerateWasmApi.cmake — do not edit by hand.
// Canonical definitions live in cmake/WasmApiManifest.cmake.
// Regenerate: scripts/sync_wasm_link_common.sh

/** C symbol names for render-worker ccall proxying. */
export const WASM_API_SYMBOLS = {
${_symbols}};

/**
 * Everything needed to marshal a call without knowing its signature by hand:
 * the C symbol, the ccall return type (null for void), the ccall argument
 * types, the manifest-level argument types so a caller can coerce a JS
 * boolean to the 0/1 the WASM boundary wants, and the call's pm_ export
 * (ABI v2) with how it takes its host.
 *
 * Keyed like WASM_API_SYMBOLS. See html/projectm-render-transport.js, which
 * uses it to issue the same call over either render topology.
 *
 * @typedef {{ symbol: string, returnType: 'number' | 'string' | 'boolean' | null, argTypes: Array<'number' | 'string'>, paramTypes: Array<'number' | 'string' | 'boolean'>, hostSymbol: string | null, hostMode: 'prepend' | 'first' | null }} WasmApiSignature
 */

/** @type {Record<string, WasmApiSignature>} */
export const WASM_API_SIGNATURES = {
${_signature_lines}};
${_bind_doc}
/** @type {ReadonlyMap<string, readonly [string, 'prepend' | 'first']>} */
export const HOST_SYMBOLS = new Map([
${_host_symbol_lines}]);

/**
 * Feed interleaved float PCM into projectM (malloc + HEAPF32 marshaling).
 * @param {object} module Emscripten module instance.
 * @param {Float32Array} data Interleaved PCM samples.
 * @param {number} samplesPerChannel Samples per channel.
 * @param {number} [channels=2] Channel count.
 */
export function feedPcmFloat(module, data, samplesPerChannel, channels = 2) {
    const ptr = module._malloc(data.length * 4);
    module.HEAPF32.set(data, ptr >> 2);
    try {
        module._projectm_pcm_add_float_wrapper(0, ptr, samplesPerChannel, channels);
    } finally {
        module._free(ptr);
    }
}
${_bind_doc_fn}
/**
 * @template {object} M
 * @param {M} module
 * @param {number} host
 * @returns {M}
 */
export function bindModuleToHost(module, host) {
${_bind_body_js}}
${_js_wrappers}${_host_api_doc}
/**
 * @param {object} module
 * @param {number} host
 */
export function createHostApi(module, host) {
    const view = bindModuleToHost(module, host);
    return {
        host,
${_host_api_items}    };
}

/** Stable public embed API (see docs/WASM_JS_API.md). */
export const PUBLIC_WASM_API = [
${_public_names}
];
")
