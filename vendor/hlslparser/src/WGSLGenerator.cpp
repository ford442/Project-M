//=============================================================================
//
// WGSLGenerator.cpp
//
// See WGSLGenerator.h. The GLSL generator is the reference for every Milkdrop quirk
// kept here; each one says what it mirrors, so that the two can be changed together.
//
//=============================================================================

#include "WGSLGenerator.h"

#include "Engine.h"

#include <algorithm>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <locale>
#include <sstream>

namespace M4 {

namespace {

const HLSLType kFloat(HLSLBaseType_Float);
const HLSLType kInt(HLSLBaseType_Int);
const HLSLType kBool(HLSLBaseType_Bool);

// WGSL keywords and reserved words (WGSL spec, "Keyword Summary" and "Reserved Words").
// Browsers (Tint) reject every one of these as an identifier; naga rejects most.
const std::set<std::string>& ReservedWords()
{
    static const std::set<std::string> words = {
        // Keywords.
        "alias",
        "break",
        "case",
        "const",
        "const_assert",
        "continue",
        "continuing",
        "default",
        "diagnostic",
        "discard",
        "else",
        "enable",
        "false",
        "fn",
        "for",
        "if",
        "let",
        "loop",
        "override",
        "requires",
        "return",
        "struct",
        "switch",
        "true",
        "var",
        "while",
        // Reserved words.
        "NULL",
        "Self",
        "abstract",
        "active",
        "alignas",
        "alignof",
        "as",
        "asm",
        "asm_fragment",
        "async",
        "attribute",
        "auto",
        "await",
        "become",
        "binding_array",
        "cast",
        "catch",
        "class",
        "co_await",
        "co_return",
        "co_yield",
        "coherent",
        "column_major",
        "common",
        "compile",
        "compile_fragment",
        "concept",
        "const_cast",
        "consteval",
        "constexpr",
        "constinit",
        "crate",
        "debugger",
        "decltype",
        "delete",
        "demote",
        "demote_to_helper",
        "do",
        "dynamic_cast",
        "enum",
        "explicit",
        "export",
        "extends",
        "extern",
        "external",
        "fallthrough",
        "filter",
        "final",
        "finally",
        "friend",
        "from",
        "fxgroup",
        "get",
        "goto",
        "groupshared",
        "highp",
        "impl",
        "implements",
        "import",
        "inline",
        "instanceof",
        "interface",
        "layout",
        "lowp",
        "macro",
        "macro_rules",
        "match",
        "mediump",
        "meta",
        "mod",
        "module",
        "move",
        "mut",
        "mutable",
        "namespace",
        "new",
        "nil",
        "noexcept",
        "noinline",
        "nointerpolation",
        "non_coherent",
        "noncoherent",
        "noperspective",
        "null",
        "nullptr",
        "of",
        "operator",
        "package",
        "packoffset",
        "partition",
        "pass",
        "patch",
        "pixelfragment",
        "precise",
        "precision",
        "premerge",
        "priv",
        "protected",
        "pub",
        "public",
        "readonly",
        "ref",
        "regardless",
        "register",
        "reinterpret_cast",
        "require",
        "resource",
        "restrict",
        "self",
        "set",
        "shared",
        "sizeof",
        "smooth",
        "snorm",
        "static",
        "static_assert",
        "static_cast",
        "std",
        "subroutine",
        "super",
        "target",
        "template",
        "this",
        "thread_local",
        "throw",
        "trait",
        "try",
        "type",
        "typedef",
        "typeid",
        "typename",
        "typeof",
        "union",
        "unless",
        "unorm",
        "unsafe",
        "unsized",
        "use",
        "using",
        "varying",
        "virtual",
        "volatile",
        "wgsl",
        "where",
        "with",
        "writeonly",
        "yield",
        // Not reserved, but naga and Tint treat them as reserved or they name the entry structs.
        "input",
        "output",
        "main",
    };
    return words;
}

// Predeclared WGSL names. WGSL lets a declaration shadow them, but a preset variable named
// "step" would then break a later step() call in the same scope, so they are renamed too.
const std::set<std::string>& PredeclaredNames()
{
    static const std::set<std::string> names = {
        "abs",
        "acos",
        "acosh",
        "all",
        "any",
        "array",
        "arrayLength",
        "asin",
        "asinh",
        "atan",
        "atan2",
        "atanh",
        "atomic",
        "bitcast",
        "bool",
        "ceil",
        "clamp",
        "cos",
        "cosh",
        "countLeadingZeros",
        "countOneBits",
        "countTrailingZeros",
        "cross",
        "degrees",
        "determinant",
        "distance",
        "dot",
        "dpdx",
        "dpdxCoarse",
        "dpdxFine",
        "dpdy",
        "dpdyCoarse",
        "dpdyFine",
        "exp",
        "exp2",
        "extractBits",
        "f16",
        "f32",
        "faceForward",
        "firstLeadingBit",
        "firstTrailingBit",
        "floor",
        "fma",
        "fract",
        "frexp",
        "fwidth",
        "fwidthCoarse",
        "fwidthFine",
        "i32",
        "insertBits",
        "inverseSqrt",
        "ldexp",
        "length",
        "log",
        "log2",
        "mat2x2",
        "mat2x3",
        "mat2x4",
        "mat3x2",
        "mat3x3",
        "mat3x4",
        "mat4x2",
        "mat4x3",
        "mat4x4",
        "mat2x2f",
        "mat2x3f",
        "mat2x4f",
        "mat3x2f",
        "mat3x3f",
        "mat3x4f",
        "mat4x2f",
        "mat4x3f",
        "mat4x4f",
        "max",
        "min",
        "mix",
        "modf",
        "normalize",
        "pow",
        "ptr",
        "quantizeToF16",
        "radians",
        "reflect",
        "refract",
        "reverseBits",
        "round",
        "sampler",
        "sampler_comparison",
        "saturate",
        "select",
        "sign",
        "sin",
        "sinh",
        "smoothstep",
        "sqrt",
        "step",
        "tan",
        "tanh",
        "textureDimensions",
        "textureGather",
        "textureLoad",
        "textureSample",
        "textureSampleBias",
        "textureSampleGrad",
        "textureSampleLevel",
        "transpose",
        "trunc",
        "u32",
        "vec2",
        "vec3",
        "vec4",
        "vec2f",
        "vec3f",
        "vec4f",
        "vec2i",
        "vec3i",
        "vec4i",
        "vec2u",
        "vec3u",
        "vec4u",
        "texture_1d",
        "texture_2d",
        "texture_2d_array",
        "texture_3d",
        "texture_cube",
        "texture_cube_array",
    };
    return names;
}

int Components(HLSLBaseType type)
{
    if (type < HLSLBaseType_FirstNumeric || type > HLSLBaseType_LastNumeric)
    {
        return 0;
    }
    if (IsMatrixType(type))
    {
        return baseTypeDescriptions[type].numComponents * baseTypeDescriptions[type].height;
    }
    return baseTypeDescriptions[type].numComponents;
}

NumericType Numeric(HLSLBaseType type)
{
    if (type < HLSLBaseType_FirstNumeric || type > HLSLBaseType_LastNumeric)
    {
        return NumericType_NaN;
    }
    return baseTypeDescriptions[type].numericType;
}

bool IsNumericScalarOrVector(HLSLBaseType type)
{
    return IsScalarType(type) || IsVectorType(type);
}

HLSLBaseType VectorType(NumericType numeric, int components)
{
    if (components < 1 || components > 4)
    {
        return HLSLBaseType_Unknown;
    }
    switch (numeric)
    {
        case NumericType_Float:
            return static_cast<HLSLBaseType>(HLSLBaseType_Float + components - 1);
        case NumericType_Bool:
            return static_cast<HLSLBaseType>(HLSLBaseType_Bool + components - 1);
        case NumericType_Int:
            return static_cast<HLSLBaseType>(HLSLBaseType_Int + components - 1);
        case NumericType_Uint:
            return static_cast<HLSLBaseType>(HLSLBaseType_Uint + components - 1);
        default:
            return HLSLBaseType_Unknown;
    }
}

// The common type of two scalar operands, as the GLSL generator's commonScalarType().
const HLSLType* CommonScalarType(const HLSLType& lhs, const HLSLType& rhs)
{
    static const HLSLType kUint(HLSLBaseType_Uint);
    if (!IsScalarType(lhs) || !IsScalarType(rhs))
    {
        return nullptr;
    }
    if (lhs.baseType == HLSLBaseType_Float || rhs.baseType == HLSLBaseType_Float)
    {
        return &kFloat;
    }
    if (lhs.baseType == HLSLBaseType_Uint || rhs.baseType == HLSLBaseType_Uint)
    {
        return &kUint;
    }
    if (lhs.baseType == HLSLBaseType_Int || rhs.baseType == HLSLBaseType_Int)
    {
        return &kInt;
    }
    return &kBool;
}

NumericType CommonNumeric(NumericType a, NumericType b)
{
    if (a == NumericType_Float || b == NumericType_Float)
    {
        return NumericType_Float;
    }
    if (a == NumericType_Uint || b == NumericType_Uint)
    {
        return NumericType_Uint;
    }
    if (a == NumericType_Int || b == NumericType_Int)
    {
        return NumericType_Int;
    }
    return NumericType_Bool;
}

std::string Sanitize(std::string text)
{
    for (auto& c : text)
    {
        if (!isalnum(static_cast<unsigned char>(c)))
        {
            c = '_';
        }
    }
    return text;
}

std::string Parenthesize(const std::string& value)
{
    // Identifiers and calls do not need parentheses for a member access or index.
    bool simple = !value.empty();
    int depth = 0;
    for (char c : value)
    {
        if (c == '(' || c == '[')
        {
            depth++;
        }
        else if (c == ')' || c == ']')
        {
            depth--;
        }
        else if (depth == 0 && !isalnum(static_cast<unsigned char>(c)) && c != '_' && c != '.')
        {
            simple = false;
            break;
        }
    }
    if (simple && (value.front() == '(' || isdigit(static_cast<unsigned char>(value.front()))))
    {
        // "(*p)" and "(a + b)" are fine as they are; a literal is not.
        simple = value.front() == '(' && value.back() == ')';
        if (simple)
        {
            // "(a) + (b)" starts and ends with parentheses but is not one group.
            int level = 0;
            for (size_t i = 0; i < value.size(); i++)
            {
                if (value[i] == '(')
                {
                    level++;
                }
                else if (value[i] == ')')
                {
                    level--;
                    if (level == 0 && i + 1 < value.size())
                    {
                        simple = false;
                        break;
                    }
                }
            }
        }
    }
    return simple ? value : "(" + value + ")";
}

const char kSwizzle[] = "xyzw";

int SwizzleIndex(char c)
{
    switch (c)
    {
        case 'x':
        case 'r':
            return 0;
        case 'y':
        case 'g':
            return 1;
        case 'z':
        case 'b':
            return 2;
        case 'w':
        case 'a':
            return 3;
        default:
            return -1;
    }
}

// v.xy.y is v.y: folds a chain of vector swizzles into one on the innermost vector, so the
// result can be assigned to (the header's "uv" is _uv.xy, and presets assign uv.y).
HLSLExpression* ComposeSwizzle(HLSLMemberAccess* member, std::string& field)
{
    field = member->field;
    HLSLExpression* object = member->object;
    while (object->nodeType == HLSLNodeType_MemberAccess)
    {
        auto* inner = static_cast<HLSLMemberAccess*>(object);
        if (!IsVectorType(inner->object->expressionType.baseType))
        {
            break;
        }
        const std::string innerField = inner->field;
        std::string composed;
        for (char c : field)
        {
            const int index = SwizzleIndex(c);
            if (index < 0 || index >= static_cast<int>(innerField.size()))
            {
                return object;
            }
            composed += innerField[static_cast<size_t>(index)];
        }
        field = composed;
        object = inner->object;
    }
    return object;
}

int GetFunctionArguments(HLSLFunctionCall* call, HLSLExpression* expression[], int maxArguments)
{
    HLSLExpression* argument = call->argument;
    int count = 0;
    while (argument != nullptr)
    {
        if (count < maxArguments)
        {
            expression[count] = argument;
        }
        argument = argument->nextExpression;
        ++count;
    }
    return count;
}

bool ParseMatrixSwizzle(const char* field, std::vector<std::pair<int, int>>& elements)
{
    // HLSL "_m00_m12" (zero-based) or "_11_23" (one-based): row, then column.
    const char* n = field;
    while (n[0] != 0)
    {
        if (n[0] != '_')
        {
            return false;
        }
        ++n;
        char base = '1';
        if (n[0] == 'm')
        {
            base = '0';
            ++n;
        }
        if (!isdigit(static_cast<unsigned char>(n[0])) || !isdigit(static_cast<unsigned char>(n[1])))
        {
            return false;
        }
        elements.emplace_back(n[0] - base, n[1] - base);
        n += 2;
    }
    return !elements.empty();
}

} // namespace

const char* const WGSLGenerator::kGlobalsBlockName = "pmw_globals";

const WGSLGenerator::Binding* WGSLGenerator::Reflection::FindBinding(const std::string& wgslName) const
{
    for (const auto& binding : bindings)
    {
        if (binding.wgslName == wgslName)
        {
            return &binding;
        }
    }
    return nullptr;
}

int WGSLGenerator::InputLocation(const char* semantic)
{
    if (semantic == nullptr)
    {
        return -1;
    }
    if (strncmp(semantic, "TEXCOORD", 8) == 0)
    {
        int index = semantic[8] == 0 ? 0 : atoi(semantic + 8);
        return index >= 0 && index < 8 ? index : -1;
    }
    if (strncmp(semantic, "COLOR", 5) == 0)
    {
        int index = semantic[5] == 0 ? 0 : atoi(semantic + 5);
        return index >= 0 && index < 8 ? 8 + index : -1;
    }
    return -1;
}

WGSLGenerator::WGSLGenerator() = default;

const char* WGSLGenerator::GetResult() const
{
    return m_result.c_str();
}

const WGSLGenerator::Reflection& WGSLGenerator::GetReflection() const
{
    return m_reflection;
}

const std::string& WGSLGenerator::GetError() const
{
    return m_error;
}

void WGSLGenerator::Error(const char* format, ...)
{
    if (m_hasError)
    {
        return;
    }
    m_hasError = true;

    char buffer[1024];
    va_list args;
    va_start(args, format);
    vsnprintf(buffer, sizeof(buffer), format, args);
    va_end(args);
    m_error = buffer;
}

std::string WGSLGenerator::Indent(int indent) const
{
    return std::string(static_cast<size_t>(indent) * 4, ' ');
}

//-----------------------------------------------------------------------------
// Types and names
//-----------------------------------------------------------------------------

std::string WGSLGenerator::TypeName(HLSLBaseType baseType)
{
    switch (baseType)
    {
        case HLSLBaseType_Void:
            return "void";
        case HLSLBaseType_Float:
            return "f32";
        case HLSLBaseType_Float2:
            return "vec2f";
        case HLSLBaseType_Float3:
            return "vec3f";
        case HLSLBaseType_Float4:
            return "vec4f";
        case HLSLBaseType_Bool:
            return "bool";
        case HLSLBaseType_Bool2:
            return "vec2<bool>";
        case HLSLBaseType_Bool3:
            return "vec3<bool>";
        case HLSLBaseType_Bool4:
            return "vec4<bool>";
        case HLSLBaseType_Int:
            return "i32";
        case HLSLBaseType_Int2:
            return "vec2i";
        case HLSLBaseType_Int3:
            return "vec3i";
        case HLSLBaseType_Int4:
            return "vec4i";
        case HLSLBaseType_Uint:
            return "u32";
        case HLSLBaseType_Uint2:
            return "vec2u";
        case HLSLBaseType_Uint3:
            return "vec3u";
        case HLSLBaseType_Uint4:
            return "vec4u";
        case HLSLBaseType_Sampler:
        case HLSLBaseType_Sampler2D:
            return "texture_2d<f32>";
        case HLSLBaseType_Sampler3D:
            return "texture_3d<f32>";
        default:
            break;
    }
    if (IsMatrixType(baseType))
    {
        // HLSL floatRxC (R rows of C) is matCxR, as GLSL's mat names: the same matrix,
        // stored by columns. The table's numComponents is R and its height is C.
        const auto& description = baseTypeDescriptions[baseType];
        return "mat" + std::to_string(description.height) + "x" + std::to_string(description.numComponents) + "f";
    }
    const char* name = baseType < HLSLBaseType_Count ? baseTypeDescriptions[baseType].typeName : nullptr;
    Error("Type %s is not supported in WGSL", name != nullptr ? name : "?");
    return "f32";
}

std::string WGSLGenerator::TypeName(const HLSLType& type)
{
    std::string name;
    if (type.baseType == HLSLBaseType_UserDefined)
    {
        name = SafeName(type.typeName);
    }
    else
    {
        name = TypeName(type.baseType);
    }
    if (type.array)
    {
        int size = 0;
        if (type.arraySize == nullptr || !m_tree->GetExpressionValue(type.arraySize, size) || size <= 0)
        {
            Error("Array size must be a positive constant");
            size = 1;
        }
        name = "array<" + name + ", " + std::to_string(size) + ">";
    }
    return name;
}

std::string WGSLGenerator::SafeName(const char* name) const
{
    if (name == nullptr)
    {
        return "pmw_unnamed";
    }
    std::string value(name);
    if (value.empty() || value == "_" || value.rfind("__", 0) == 0 || value.rfind("pmw_", 0) == 0 ||
        ReservedWords().count(value) > 0 || PredeclaredNames().count(value) > 0)
    {
        return "pmw_u_" + value;
    }
    return value;
}

std::string WGSLGenerator::FunctionKey(const HLSLFunction* function) const
{
    std::string key = function->name;
    key += "(";
    for (const HLSLArgument* argument = function->argument; argument != nullptr; argument = argument->nextArgument)
    {
        key += std::to_string(argument->type.baseType);
        if (argument->type.typeName != nullptr)
        {
            key += argument->type.typeName;
        }
        key += argument->type.array ? "[]," : ",";
    }
    key += ")";
    return key;
}

std::string WGSLGenerator::FunctionName(const HLSLFunction* function)
{
    auto it = m_functions.find(FunctionKey(function));
    if (it != m_functions.end())
    {
        return it->second.wgslName;
    }
    return SafeName(function->name);
}

bool WGSLGenerator::IsUserFunction(const HLSLFunction* function) const
{
    return m_userFunctions.count(function) > 0;
}

bool WGSLGenerator::LayoutOf(const HLSLType& type, unsigned int& align, unsigned int& size)
{
    // WGSL alignment and size rules (uniform address space): vec3 aligns as vec4, a matrix
    // is C columns of vecR, each column at a multiple of the column alignment.
    if (type.array)
    {
        return false;
    }
    const HLSLBaseType baseType = type.baseType;
    if (Numeric(baseType) == NumericType_Bool)
    {
        return false; // bool is not host-shareable
    }
    if (IsScalarType(baseType))
    {
        align = 4;
        size = 4;
        return true;
    }
    if (IsVectorType(baseType))
    {
        const int n = Components(baseType);
        align = n == 2 ? 8 : 16;
        size = static_cast<unsigned int>(4 * n);
        return true;
    }
    if (IsMatrixType(baseType))
    {
        const unsigned int rows = static_cast<unsigned int>(baseTypeDescriptions[baseType].numComponents);
        const unsigned int columns = static_cast<unsigned int>(baseTypeDescriptions[baseType].height);
        align = rows == 2 ? 8 : 16;
        size = columns * align;
        return true;
    }
    return false;
}

//-----------------------------------------------------------------------------
// Helpers
//-----------------------------------------------------------------------------

std::string WGSLGenerator::Helper(const std::string& name, const std::string& code)
{
    if (m_helpers.find(name) == m_helpers.end())
    {
        m_helpers[name] = code;
        m_helperOrder.push_back(name);
    }
    return name;
}

std::string WGSLGenerator::TypedHelper(const char* base, HLSLBaseType type)
{
    const std::string typeName = TypeName(type);
    const std::string name = std::string("pmw_") + base + "_" + Sanitize(typeName);
    if (m_helpers.find(name) != m_helpers.end())
    {
        return name;
    }

    const int n = Components(type);
    const bool vector = IsVectorType(type);
    const std::string zero = vector ? typeName + "(0.0)" : "0.0";
    std::string code;

    if (strcmp(base, "mod") == 0)
    {
        // GLSL mod(), which the GLSL generator emits for HLSL's float % and fmod().
        code = "fn " + name + "(x: " + typeName + ", y: " + typeName + ") -> " + typeName + " {\n" +
               "    return x - y * floor(x / y);\n}\n";
    }
    else if (strcmp(base, "mul") == 0)
    {
        // DX9's multiply: 0 * x is 0 for any x (GLSLGenerator's Flag_AlternateNanPropagation).
        const std::string condition = vector ? "(x == " + zero + ") | (y == " + zero + ")" : "x == 0.0 || y == 0.0";
        code = "fn " + name + "(x: " + typeName + ", y: " + typeName + ") -> " + typeName + " {\n" +
               "    return select(x * y, " + zero + ", " + condition + ");\n}\n";
    }
    else if (strcmp(base, "acos") == 0 || strcmp(base, "asin") == 0)
    {
        // Shader model 3's acos/asin are defined beyond [-1, 1]; the GLSL generator matches
        // them with these polynomials.
        const bool isAcos = strcmp(base, "acos") == 0;
        if (vector)
        {
            const std::string scalar = TypedHelper(base, HLSLBaseType_Float);
            code = "fn " + name + "(x: " + typeName + ") -> " + typeName + " {\n    return " + typeName + "(";
            for (int i = 0; i < n; i++)
            {
                code += (i > 0 ? ", " : "") + scalar + "(x." + kSwizzle[i] + ")";
            }
            code += ");\n}\n";
        }
        else
        {
            code = "fn " + name + "(x: f32) -> f32 {\n"
                                  "    if (abs(x) > 1.0) {\n";
            code += isAcos ? "        return 0.39269908169872415 * (4.0 - sign(x) * (abs(x) - 3.0) * (abs(x) - 3.0));\n"
                           : "        return 0.39269908169872415 * sign(x) * (abs(x) - 3.0) * (abs(x) - 3.0);\n";
            code += std::string("    }\n    return ") + base + "(x);\n}\n";
        }
    }
    else if (strcmp(base, "clip") == 0)
    {
        const std::string condition = vector ? "any(x < " + zero + ")" : "x < 0.0";
        code = "fn " + name + "(x: " + typeName + ") {\n    if (" + condition + ") {\n        discard;\n    }\n}\n";
    }
    else if (strcmp(base, "modf") == 0)
    {
        code = "fn " + name + "(x: " + typeName + ", ip: ptr<function, " + typeName + ">) -> " + typeName + " {\n" +
               "    let r = modf(x);\n    *ip = r.whole;\n    return r.fract;\n}\n";
    }
    else if (strcmp(base, "sincos") == 0)
    {
        code = "fn " + name + "(x: " + typeName + ", s: ptr<function, " + typeName + ">, c: ptr<function, " + typeName + ">) {\n" +
               "    *s = sin(x);\n    *c = cos(x);\n}\n";
    }
    else if (strcmp(base, "isnan") == 0)
    {
        code = "fn " + name + "(x: f32) -> bool {\n    return x != x;\n}\n";
    }
    else if (strcmp(base, "isinf") == 0)
    {
        code = "fn " + name + "(x: f32) -> bool {\n    return x == x && abs(x) > 3.40282347e38;\n}\n";
    }
    else
    {
        Error("Internal error: no helper %s", base);
        return name;
    }
    return Helper(name, code);
}

std::string WGSLGenerator::MatrixRowHelper(HLSLBaseType matrixType)
{
    // HLSL m[i] is row i; WGSL indexes columns.
    const std::string typeName = TypeName(matrixType);
    const std::string name = "pmw_row_" + typeName;
    const int columns = baseTypeDescriptions[matrixType].height;
    const std::string rowType = TypeName(VectorType(NumericType_Float, columns));
    std::string code = "fn " + name + "(m: " + typeName + ", i: i32) -> " + rowType + " {\n    return " + rowType + "(";
    for (int c = 0; c < columns; c++)
    {
        code += (c > 0 ? ", " : "") + std::string("m[") + std::to_string(c) + "][i]";
    }
    code += ");\n}\n";
    return Helper(name, code);
}

std::string WGSLGenerator::MatrixCastHelper(HLSLBaseType srcType, HLSLBaseType dstType)
{
    // A matrix to matrix cast keeps the upper-left elements and fills the rest from the
    // identity, as GLSL's matrix-from-matrix constructor does. A scalar source makes a
    // diagonal matrix, as GLSL's mat3(s).
    const std::string dstName = TypeName(dstType);
    const bool fromScalar = IsScalarType(srcType);
    const std::string srcName = fromScalar ? "f32" : TypeName(srcType);
    const std::string name = "pmw_cast_" + Sanitize(srcName) + "_to_" + dstName;
    if (m_helpers.find(name) != m_helpers.end())
    {
        return name;
    }

    const int dstRows = baseTypeDescriptions[dstType].numComponents;
    const int dstColumns = baseTypeDescriptions[dstType].height;
    const int srcRows = fromScalar ? 0 : baseTypeDescriptions[srcType].numComponents;
    const int srcColumns = fromScalar ? 0 : baseTypeDescriptions[srcType].height;

    std::string code = "fn " + name + "(m: " + srcName + ") -> " + dstName + " {\n    return " + dstName + "(";
    for (int c = 0; c < dstColumns; c++)
    {
        for (int r = 0; r < dstRows; r++)
        {
            std::string element;
            if (fromScalar)
            {
                element = r == c ? "m" : "0.0";
            }
            else if (r < srcRows && c < srcColumns)
            {
                element = "m[" + std::to_string(c) + "][" + std::to_string(r) + "]";
            }
            else
            {
                element = r == c ? "1.0" : "0.0";
            }
            code += (c > 0 || r > 0 ? ", " : "") + element;
        }
    }
    code += ");\n}\n";
    return Helper(name, code);
}

//-----------------------------------------------------------------------------
// Module
//-----------------------------------------------------------------------------

bool WGSLGenerator::Generate(HLSLTree* tree, Target target, const char* entryName, const Options& options)
{
    m_tree = tree;
    m_options = options;
    m_entryName = entryName;
    m_result.clear();
    m_body.clear();
    m_helpers.clear();
    m_helperOrder.clear();
    m_reflection = Reflection();
    m_error.clear();
    m_hasError = false;
    m_bufferFieldOwner.clear();
    m_bufferFieldName.clear();
    m_globalUniforms.clear();
    m_globalUniformNames.clear();
    m_samplers.clear();
    m_globalInitializers.clear();
    m_userFunctions.clear();
    m_functions.clear();
    m_functionNameCount.clear();
    m_scope = nullptr;
    m_temporaryCounter = 0;

    if (target != Target_FragmentShader)
    {
        Error("Only fragment shaders are supported");
        return false;
    }

    // Uniform-block members are read-only in WGSL too: the same local copies as for GLSL.
    m_tree->ReplaceUniformsAssignments();

    HLSLRoot* root = m_tree->GetRoot();
    HLSLFunction* entryFunction = m_tree->FindFunction(entryName);
    if (entryFunction == nullptr)
    {
        Error("Entry point '%s' doesn't exist", entryName);
        return false;
    }

    CollectGlobals(root->statement);

    std::string declarations;

    // Uniform buffers first (cbuffers in source order, then the plain-uniform block),
    // then the texture/sampler pairs, so binding numbers follow the source.
    std::map<unsigned int, unsigned int> nextBinding;
    auto allocateBinding = [&](unsigned int group) {
        return nextBinding[group]++;
    };

    std::string structs;
    std::string bindings;

    for (HLSLStatement* statement = root->statement; statement != nullptr; statement = statement->nextStatement)
    {
        if (statement->hidden)
        {
            continue;
        }
        if (statement->nodeType == HLSLNodeType_Buffer)
        {
            auto* buffer = static_cast<HLSLBuffer*>(statement);
            if (buffer->field == nullptr)
            {
                continue;
            }
            Binding binding;
            binding.kind = BindingKind_UniformBuffer;
            binding.group = m_options.uniformGroup;
            binding.binding = allocateBinding(binding.group);
            binding.wgslName = SafeName(buffer->name);
            binding.sourceName = buffer->name;

            const std::string structName = binding.wgslName + "_block";
            structs += "struct " + structName + " {\n";
            unsigned int offset = 0;
            unsigned int maxAlign = 16;
            for (HLSLDeclaration* field = buffer->field; field != nullptr; field = static_cast<HLSLDeclaration*>(field->nextStatement))
            {
                unsigned int align = 0;
                unsigned int size = 0;
                if (!LayoutOf(field->type, align, size))
                {
                    Error("cbuffer member %s has a type a uniform buffer cannot hold", field->name);
                    break;
                }
                offset = (offset + align - 1) / align * align;
                UniformMember member;
                member.name = field->name;
                member.wgslName = SafeName(field->name);
                member.type = TypeName(field->type);
                member.offset = offset;
                member.size = size;
                binding.members.push_back(member);
                structs += "    " + member.wgslName + ": " + member.type + ",\n";
                offset += size;
                maxAlign = std::max(maxAlign, align);
            }
            structs += "}\n\n";
            binding.size = (offset + maxAlign - 1) / maxAlign * maxAlign;
            bindings += "@group(" + std::to_string(binding.group) + ") @binding(" + std::to_string(binding.binding) + ") var<uniform> " +
                        binding.wgslName + ": " + structName + ";\n";
            m_reflection.bindings.push_back(binding);
        }
    }

    if (!m_globalUniforms.empty())
    {
        Binding binding;
        binding.kind = BindingKind_UniformBuffer;
        binding.group = m_options.uniformGroup;
        binding.binding = allocateBinding(binding.group);
        binding.wgslName = kGlobalsBlockName;
        binding.sourceName = kGlobalsBlockName;

        const std::string structName = "pmw_globals_block";
        structs += "struct " + structName + " {\n";
        unsigned int offset = 0;
        unsigned int maxAlign = 16;
        for (HLSLDeclaration* declaration : m_globalUniforms)
        {
            unsigned int align = 0;
            unsigned int size = 0;
            if (!LayoutOf(declaration->type, align, size))
            {
                Error("Uniform %s has a type a uniform buffer cannot hold", declaration->name);
                break;
            }
            offset = (offset + align - 1) / align * align;
            UniformMember member;
            member.name = declaration->name;
            member.wgslName = SafeName(declaration->name);
            member.type = TypeName(declaration->type);
            member.offset = offset;
            member.size = size;
            binding.members.push_back(member);
            structs += "    " + member.wgslName + ": " + member.type + ",\n";
            offset += size;
            maxAlign = std::max(maxAlign, align);
        }
        structs += "}\n\n";
        binding.size = (offset + maxAlign - 1) / maxAlign * maxAlign;
        bindings += "@group(" + std::to_string(binding.group) + ") @binding(" + std::to_string(binding.binding) + ") var<uniform> " +
                    binding.wgslName + ": " + structName + ";\n";
        m_reflection.bindings.push_back(binding);
    }

    // Samplers, in source order: each HLSL sampler is a texture and a sampler binding.
    for (HLSLStatement* statement = root->statement; statement != nullptr; statement = statement->nextStatement)
    {
        if (statement->hidden || statement->nodeType != HLSLNodeType_Declaration)
        {
            continue;
        }
        for (auto* declaration = static_cast<HLSLDeclaration*>(statement); declaration != nullptr; declaration = declaration->nextDeclaration)
        {
            if (!IsSamplerType(declaration->type))
            {
                continue;
            }
            const HLSLBaseType samplerType = declaration->type.baseType;
            if (samplerType != HLSLBaseType_Sampler && samplerType != HLSLBaseType_Sampler2D && samplerType != HLSLBaseType_Sampler3D)
            {
                Error("Sampler %s: only 2D and 3D samplers are supported", declaration->name);
                continue;
            }
            const std::string name = SafeName(declaration->name);

            Binding texture;
            texture.kind = samplerType == HLSLBaseType_Sampler3D ? BindingKind_Texture3D : BindingKind_Texture2D;
            texture.group = m_options.textureGroup;
            texture.binding = allocateBinding(texture.group);
            texture.wgslName = name + "_tex";
            texture.sourceName = declaration->name;
            bindings += "@group(" + std::to_string(texture.group) + ") @binding(" + std::to_string(texture.binding) + ") var " +
                        texture.wgslName + ": " + TypeName(samplerType) + ";\n";
            m_reflection.bindings.push_back(texture);

            Binding sampler;
            sampler.kind = BindingKind_Sampler;
            sampler.group = m_options.textureGroup;
            sampler.binding = allocateBinding(sampler.group);
            sampler.wgslName = name + "_smp";
            sampler.sourceName = declaration->name;
            bindings += "@group(" + std::to_string(sampler.group) + ") @binding(" + std::to_string(sampler.binding) + ") var " +
                        sampler.wgslName + ": sampler;\n";
            m_reflection.bindings.push_back(sampler);
        }
    }

    EmitTopLevel(root->statement);
    EmitEntryPoint(entryFunction);

    // Preset code samples textures under non-uniform control flow (an if on a computed
    // value). GLSL accepts that; WGSL makes it an error unless the diagnostic is off.
    m_result = "// Generated by projectM's WGSLGenerator from the preset's HLSL.\n"
               "diagnostic(off, derivative_uniformity);\n\n";
    m_result += structs;
    if (!bindings.empty())
    {
        m_result += bindings + "\n";
    }
    for (const auto& name : m_helperOrder)
    {
        m_result += m_helpers[name] + "\n";
    }
    m_result += m_body;

    m_tree = nullptr;
    return !m_hasError;
}

void WGSLGenerator::CollectGlobals(HLSLStatement* statement)
{
    for (; statement != nullptr; statement = statement->nextStatement)
    {
        if (statement->hidden)
        {
            continue;
        }
        switch (statement->nodeType)
        {
            case HLSLNodeType_Declaration:
                for (auto* declaration = static_cast<HLSLDeclaration*>(statement); declaration != nullptr; declaration = declaration->nextDeclaration)
                {
                    if (IsSamplerType(declaration->type))
                    {
                        m_samplers[declaration->name] = declaration->type.baseType;
                    }
                    else if (declaration->type.baseType == HLSLBaseType_Texture)
                    {
                        // GLSL ignores texture objects too.
                    }
                    else if ((declaration->type.flags & HLSLTypeFlag_Uniform) != 0 && declaration->assignment == nullptr)
                    {
                        m_globalUniforms.push_back(declaration);
                        m_globalUniformNames.insert(declaration->name);
                    }
                    else if (declaration->assignment != nullptr)
                    {
                        // A non-uniform global, or a uniform with a default nothing overrides:
                        // the GLSL generator initializes both at the start of main().
                        m_globalInitializers.push_back(declaration);
                    }
                }
                break;

            case HLSLNodeType_Buffer: {
                auto* buffer = static_cast<HLSLBuffer*>(statement);
                for (HLSLDeclaration* field = buffer->field; field != nullptr; field = static_cast<HLSLDeclaration*>(field->nextStatement))
                {
                    m_bufferFieldOwner[field->name] = SafeName(buffer->name);
                    m_bufferFieldName[field->name] = SafeName(field->name);
                }
                break;
            }

            case HLSLNodeType_Function: {
                auto* function = static_cast<HLSLFunction*>(statement);
                m_userFunctions.insert(function);
                if (function->forward == nullptr)
                {
                    // WGSL has no overloading: the second "foo" with other parameters is foo_1.
                    const std::string key = FunctionKey(function);
                    if (m_functions.find(key) == m_functions.end())
                    {
                        int& count = m_functionNameCount[function->name];
                        FunctionInfo info;
                        info.wgslName = SafeName(function->name);
                        if (count > 0)
                        {
                            info.wgslName += "_" + std::to_string(count);
                        }
                        count++;
                        m_functions[key] = info;
                    }
                }
                break;
            }

            default:
                break;
        }
    }
}

void WGSLGenerator::EmitTopLevel(HLSLStatement* statement)
{
    for (; statement != nullptr; statement = statement->nextStatement)
    {
        if (statement->hidden)
        {
            continue;
        }
        switch (statement->nodeType)
        {
            case HLSLNodeType_Declaration:
                for (auto* declaration = static_cast<HLSLDeclaration*>(statement); declaration != nullptr; declaration = declaration->nextDeclaration)
                {
                    if (IsSamplerType(declaration->type) || declaration->type.baseType == HLSLBaseType_Texture ||
                        m_globalUniformNames.count(declaration->name) > 0)
                    {
                        continue;
                    }
                    m_body += "var<private> " + SafeName(declaration->name) + ": " + TypeName(declaration->type) + ";\n";
                }
                break;

            case HLSLNodeType_Struct:
                EmitStruct(static_cast<HLSLStruct*>(statement));
                break;

            case HLSLNodeType_Function: {
                auto* function = static_cast<HLSLFunction*>(statement);
                if (function->forward == nullptr)
                {
                    EmitFunction(function);
                }
                break;
            }

            case HLSLNodeType_Buffer:
            case HLSLNodeType_Technique:
            case HLSLNodeType_Pipeline:
            case HLSLNodeType_Stage:
            case HLSLNodeType_Macro:
                break;

            default:
                Error("Unsupported top-level statement");
                break;
        }
    }
}

void WGSLGenerator::EmitStruct(HLSLStruct* structure)
{
    m_body += "struct " + SafeName(structure->name) + " {\n";
    for (HLSLStructField* field = structure->field; field != nullptr; field = field->nextField)
    {
        m_body += "    " + SafeName(field->name) + ": " + TypeName(field->type) + ",\n";
    }
    m_body += "}\n\n";
}

void WGSLGenerator::EmitFunction(HLSLFunction* function)
{
    FunctionScope scope;
    std::string parameters;
    std::string shadows;

    for (HLSLArgument* argument = function->argument; argument != nullptr; argument = argument->nextArgument)
    {
        if (!parameters.empty())
        {
            parameters += ", ";
        }
        const std::string name = SafeName(argument->name);
        if (IsSamplerType(argument->type))
        {
            scope.samplerParams.insert(argument->name);
            parameters += name + "_tex: " + TypeName(argument->type.baseType) + ", " + name + "_smp: sampler";
        }
        else if (argument->modifier == HLSLArgumentModifier_Out || argument->modifier == HLSLArgumentModifier_Inout)
        {
            scope.pointerParams.insert(argument->name);
            parameters += name + ": ptr<function, " + TypeName(argument->type) + ">";
        }
        else
        {
            // WGSL parameters are immutable; HLSL code assigns to its parameters
            // (uv += ... in a preset assigns to the entry point's _uv), so each one is
            // copied into a variable of its own name.
            parameters += "pmw_in_" + name + ": " + TypeName(argument->type);
            shadows += "    var " + name + ": " + TypeName(argument->type) + " = pmw_in_" + name + ";\n";
        }
    }

    const bool returnsValue = function->returnType.baseType != HLSLBaseType_Void;
    m_body += "fn " + FunctionName(function) + "(" + parameters + ")";
    if (returnsValue)
    {
        m_body += " -> " + TypeName(function->returnType);
    }
    m_body += " {\n" + shadows;

    const FunctionScope* previous = m_scope;
    m_scope = &scope;
    EmitStatements(1, function->statement, &function->returnType);
    m_scope = previous;

    if (returnsValue)
    {
        // HLSL lets a path fall off the end; WGSL does not. Unreachable after a return.
        m_body += "    return " + TypeName(function->returnType) + "();\n";
    }
    m_body += "}\n\n";
}

bool WGSLGenerator::EmitEntryPoint(HLSLFunction* entryFunction)
{
    std::string inputFields;
    std::string outputFields;
    std::string setup;
    std::string callArguments;
    std::string copyOut;

    auto outputLocation = [](const char* semantic) {
        if (semantic == nullptr)
        {
            return -1;
        }
        if (strncmp(semantic, "COLOR", 5) == 0)
        {
            return semantic[5] == 0 ? 0 : atoi(semantic + 5);
        }
        if (strncmp(semantic, "SV_Target", 9) == 0)
        {
            return semantic[9] == 0 ? 0 : atoi(semantic + 9);
        }
        return -1;
    };

    auto addOutput = [&](const HLSLType& type, const char* semantic, const std::string& fieldName, const std::string& value) {
        StageVariable variable;
        variable.semantic = semantic != nullptr ? semantic : "";
        variable.type = TypeName(type);
        if (semantic != nullptr && String_Equal(semantic, "SV_Depth"))
        {
            variable.builtin = "frag_depth";
            outputFields += "    @builtin(frag_depth) " + fieldName + ": f32,\n";
            // Like the GLSL generator: D3D clamps depth, GL rejects the fragment.
            copyOut += "    pmw_out." + fieldName + " = clamp(f32(" + value + "), 0.0, 1.0);\n";
        }
        else
        {
            variable.location = outputLocation(semantic);
            if (variable.location < 0)
            {
                Error("Output semantic %s does not map to a render target", semantic != nullptr ? semantic : "(none)");
                return;
            }
            outputFields += "    @location(" + std::to_string(variable.location) + ") " + fieldName + ": " + variable.type + ",\n";
            copyOut += "    pmw_out." + fieldName + " = " + value + ";\n";
        }
        m_reflection.outputs.push_back(variable);
    };

    for (HLSLArgument* argument = entryFunction->argument; argument != nullptr; argument = argument->nextArgument)
    {
        const std::string name = SafeName(argument->name);
        if (!callArguments.empty())
        {
            callArguments += ", ";
        }
        if (argument->type.baseType == HLSLBaseType_UserDefined || IsSamplerType(argument->type))
        {
            Error("Entry point argument %s: struct and sampler arguments are not supported", argument->name);
            continue;
        }
        if (argument->modifier == HLSLArgumentModifier_Out || argument->modifier == HLSLArgumentModifier_Inout)
        {
            setup += "    var " + name + ": " + TypeName(argument->type) + ";\n";
            callArguments += "&" + name;
            addOutput(argument->type, argument->semantic, name, name);
            continue;
        }
        if (argument->modifier == HLSLArgumentModifier_Uniform)
        {
            Error("Entry point argument %s: uniform arguments are not supported", argument->name);
            continue;
        }

        StageVariable variable;
        variable.semantic = argument->semantic != nullptr ? argument->semantic : "";
        variable.type = TypeName(argument->type);
        if (argument->semantic != nullptr && (String_Equal(argument->semantic, "SV_Position") || String_Equal(argument->semantic, "VPOS")))
        {
            variable.builtin = "position";
            inputFields += "    @builtin(position) " + name + ": vec4f,\n";
            setup += "    var " + name + ": " + variable.type + " = " + Convert("pmw_in." + name, HLSLType(HLSLBaseType_Float4), argument->type) + ";\n";
        }
        else
        {
            variable.location = InputLocation(argument->semantic);
            if (variable.location < 0)
            {
                Error("Input semantic %s of %s does not map to a location", argument->semantic != nullptr ? argument->semantic : "(none)", argument->name);
                continue;
            }
            const bool integer = Numeric(argument->type.baseType) == NumericType_Int || Numeric(argument->type.baseType) == NumericType_Uint;
            inputFields += "    @location(" + std::to_string(variable.location) + ")" + (integer ? " @interpolate(flat)" : "") + " " + name + ": " + variable.type + ",\n";
            setup += "    var " + name + ": " + variable.type + " = pmw_in." + name + ";\n";
        }
        m_reflection.inputs.push_back(variable);
        callArguments += name;
    }

    std::string call = FunctionName(entryFunction) + "(" + callArguments + ");\n";
    if (entryFunction->returnType.baseType != HLSLBaseType_Void)
    {
        if (entryFunction->returnType.baseType == HLSLBaseType_UserDefined)
        {
            Error("Entry point returning a struct is not supported");
        }
        else
        {
            call = "let pmw_result = " + call;
            addOutput(entryFunction->returnType, entryFunction->semantic, "pmw_result", "pmw_result");
        }
    }
    if (outputFields.empty())
    {
        Error("Fragment shader must output a color");
        return false;
    }

    std::string entry;
    if (!inputFields.empty())
    {
        entry += "struct PmwFragmentInput {\n" + inputFields + "}\n\n";
    }
    entry += "struct PmwFragmentOutput {\n" + outputFields + "}\n\n";
    entry += "@fragment\nfn " + std::string(m_options.entryPointName) + "(" + (inputFields.empty() ? "" : "pmw_in: PmwFragmentInput") +
             ") -> PmwFragmentOutput {\n";

    // Globals with initializers, before the entry function runs (GLSL does the same in main()).
    for (HLSLDeclaration* declaration : m_globalInitializers)
    {
        entry += "    " + SafeName(declaration->name) + " = " + DeclarationInitializer(declaration) + ";\n";
    }
    entry += setup;
    entry += "    " + call;
    entry += "    var pmw_out: PmwFragmentOutput;\n";
    entry += copyOut;
    entry += "    return pmw_out;\n}\n";

    m_body += entry;
    m_reflection.entryPoint = m_options.entryPointName;
    return !m_hasError;
}

//-----------------------------------------------------------------------------
// Statements
//-----------------------------------------------------------------------------

void WGSLGenerator::EmitStatements(int indent, HLSLStatement* statement, const HLSLType* returnType)
{
    const std::string pad = Indent(indent);
    for (; statement != nullptr; statement = statement->nextStatement)
    {
        if (statement->hidden)
        {
            continue;
        }
        switch (statement->nodeType)
        {
            case HLSLNodeType_Declaration:
                EmitDeclaration(indent, static_cast<HLSLDeclaration*>(statement));
                break;

            case HLSLNodeType_ExpressionStatement: {
                std::string text = SimpleStatement(static_cast<HLSLExpressionStatement*>(statement)->expression);
                m_body += pad + text + (text.back() == '}' ? "\n" : ";\n");
                break;
            }

            case HLSLNodeType_ReturnStatement: {
                auto* returnStatement = static_cast<HLSLReturnStatement*>(statement);
                if (returnStatement->expression == nullptr)
                {
                    m_body += pad + "return;\n";
                }
                else if (returnType == nullptr || returnType->baseType == HLSLBaseType_Void)
                {
                    m_body += pad + SimpleStatement(returnStatement->expression) + ";\n" + pad + "return;\n";
                }
                else
                {
                    m_body += pad + "return " + Expr(returnStatement->expression, returnType) + ";\n";
                }
                break;
            }

            case HLSLNodeType_DiscardStatement:
                m_body += pad + "discard;\n";
                break;

            case HLSLNodeType_BreakStatement:
                m_body += pad + "break;\n";
                break;

            case HLSLNodeType_ContinueStatement:
                m_body += pad + "continue;\n";
                break;

            case HLSLNodeType_IfStatement: {
                auto* ifStatement = static_cast<HLSLIfStatement*>(statement);
                m_body += pad + "if (" + Expr(ifStatement->condition, &kBool) + ") {\n";
                EmitStatements(indent + 1, ifStatement->statement, returnType);
                if (ifStatement->elseStatement != nullptr)
                {
                    m_body += pad + "} else {\n";
                    EmitStatements(indent + 1, ifStatement->elseStatement, returnType);
                }
                m_body += pad + "}\n";
                break;
            }

            case HLSLNodeType_ForStatement: {
                auto* forStatement = static_cast<HLSLForStatement*>(statement);
                std::string initialization;
                if (forStatement->initialization != nullptr)
                {
                    HLSLDeclaration* declaration = forStatement->initialization;
                    if (declaration->nextDeclaration != nullptr)
                    {
                        Error("A for loop may declare one variable only");
                    }
                    initialization = "var " + SafeName(declaration->name) + ": " + TypeName(declaration->type);
                    if (declaration->assignment != nullptr)
                    {
                        initialization += " = " + DeclarationInitializer(declaration);
                    }
                }
                else if (forStatement->initializationWithoutType != nullptr)
                {
                    initialization = SimpleStatement(forStatement->initializationWithoutType);
                }
                std::string condition = forStatement->condition != nullptr ? Expr(forStatement->condition, &kBool) : "";
                std::string increment = forStatement->increment != nullptr ? SimpleStatement(forStatement->increment) : "";
                if ((!initialization.empty() && initialization.back() == '}') || (!increment.empty() && increment.back() == '}'))
                {
                    Error("Multi-component swizzle assignment in a for loop header is not supported");
                }
                m_body += pad + "for (" + initialization + "; " + condition + "; " + increment + ") {\n";
                EmitStatements(indent + 1, forStatement->statement, returnType);
                m_body += pad + "}\n";
                break;
            }

            case HLSLNodeType_WhileStatement: {
                auto* whileStatement = static_cast<HLSLWhileStatement*>(statement);
                m_body += pad + "while (" + Expr(whileStatement->condition, &kBool) + ") {\n";
                EmitStatements(indent + 1, whileStatement->statement, returnType);
                m_body += pad + "}\n";
                break;
            }

            case HLSLNodeType_BlockStatement:
                m_body += pad + "{\n";
                EmitStatements(indent + 1, static_cast<HLSLBlockStatement*>(statement)->statement, returnType);
                m_body += pad + "}\n";
                break;

            default:
                Error("Unsupported statement");
                break;
        }
    }
}

void WGSLGenerator::EmitDeclaration(int indent, HLSLDeclaration* declaration)
{
    for (; declaration != nullptr; declaration = declaration->nextDeclaration)
    {
        if (declaration->type.baseType == HLSLBaseType_Texture)
        {
            continue;
        }
        if (IsSamplerType(declaration->type))
        {
            Error("Local sampler %s is not supported", declaration->name);
            continue;
        }
        std::string line = Indent(indent) + "var " + SafeName(declaration->name) + ": " + TypeName(declaration->type);
        if (declaration->assignment != nullptr)
        {
            line += " = " + DeclarationInitializer(declaration);
        }
        m_body += line + ";\n";
    }
}

std::string WGSLGenerator::DeclarationInitializer(HLSLDeclaration* declaration)
{
    const HLSLType& type = declaration->type;
    HLSLExpression* assignment = declaration->assignment;

    if (type.array)
    {
        HLSLType elementType = type;
        elementType.array = false;
        elementType.arraySize = nullptr;
        int listed = 0;
        int listedComponents = 0;
        for (HLSLExpression* element = assignment; element != nullptr; element = element->nextExpression)
        {
            listed++;
            listedComponents += std::max(1, Components(element->expressionType.baseType));
        }
        int size = 0;
        if (type.arraySize == nullptr || !m_tree->GetExpressionValue(type.arraySize, size))
        {
            size = listed;
        }

        std::string elements;
        const int elementComponents = Components(elementType.baseType);
        if (listed > size && IsVectorType(elementType.baseType) && listedComponents == size * elementComponents)
        {
            // float4 a[2] = { 1, 2, 3, 4, 5, 6, 7, 8 }: HLSL fills the elements from a flat
            // list of components.
            const NumericType numeric = Numeric(elementType.baseType);
            HLSLExpression* element = assignment;
            for (int i = 0; i < size; i++)
            {
                std::string group;
                int filled = 0;
                while (element != nullptr && filled < elementComponents)
                {
                    const int n = std::max(1, Components(element->expressionType.baseType));
                    HLSLType part(VectorType(numeric, std::min(n, elementComponents - filled)));
                    group += (filled > 0 ? ", " : "") + Expr(element, &part);
                    filled += n;
                    element = element->nextExpression;
                }
                elements += (i > 0 ? ", " : "") + TypeName(elementType) + "(" + group + ")";
            }
        }
        else
        {
            int count = 0;
            for (HLSLExpression* element = assignment; element != nullptr; element = element->nextExpression)
            {
                elements += (count++ > 0 ? ", " : "") + Expr(element, &elementType);
            }
        }
        return "array<" + TypeName(elementType) + ", " + std::to_string(size) + ">(" + elements + ")";
    }

    if (IsMatrixType(type.baseType))
    {
        // The GLSL generator builds every non-matrix initializer of a matrix with its
        // row-major constructor, also a single scalar (which then fills only _m00).
        bool matrixArgument = false;
        for (HLSLExpression* argument = assignment; argument != nullptr; argument = argument->nextExpression)
        {
            matrixArgument = matrixArgument || IsMatrixType(argument->expressionType.baseType);
        }
        if (!matrixArgument)
        {
            return MatrixConstructor(type, assignment);
        }
    }

    if (assignment->nextExpression != nullptr)
    {
        // float3 v = { 1, 2, 3 };
        return Constructor(type, assignment);
    }
    return Expr(assignment, &type);
}

std::string WGSLGenerator::SimpleStatement(HLSLExpression* expression)
{
    // A WGSL statement is an assignment, an increment or a call; anything else is a
    // phony assignment.
    if (expression->nodeType == HLSLNodeType_BinaryExpression &&
        IsAssignOp(static_cast<HLSLBinaryExpression*>(expression)->binaryOp))
    {
        return Assignment(static_cast<HLSLBinaryExpression*>(expression));
    }
    if (expression->nodeType == HLSLNodeType_UnaryExpression)
    {
        auto* unary = static_cast<HLSLUnaryExpression*>(expression);
        const bool increment = unary->unaryOp == HLSLUnaryOp_PreIncrement || unary->unaryOp == HLSLUnaryOp_PostIncrement;
        const bool decrement = unary->unaryOp == HLSLUnaryOp_PreDecrement || unary->unaryOp == HLSLUnaryOp_PostDecrement;
        if (increment || decrement)
        {
            const HLSLBaseType type = unary->expression->expressionType.baseType;
            const std::string target = LValue(unary->expression);
            if (type == HLSLBaseType_Int || type == HLSLBaseType_Uint)
            {
                return target + (increment ? "++" : "--");
            }
            return target + (increment ? " += 1.0" : " -= 1.0");
        }
    }
    if (expression->nodeType == HLSLNodeType_FunctionCall)
    {
        auto* call = static_cast<HLSLFunctionCall*>(expression);
        if (call->function->returnType.baseType == HLSLBaseType_Void)
        {
            return Call(call);
        }
    }
    return "_ = " + Expr(expression);
}

std::string WGSLGenerator::Assignment(HLSLBinaryExpression* expression)
{
    HLSLExpression* lhs = expression->expression1;
    HLSLExpression* rhs = expression->expression2;
    const HLSLType& lhsType = lhs->expressionType;

    const char* op = " = ";
    const char* arithmetic = nullptr;
    switch (expression->binaryOp)
    {
        case HLSLBinaryOp_Assign:
            break;
        case HLSLBinaryOp_AddAssign:
            op = " += ";
            arithmetic = " + ";
            break;
        case HLSLBinaryOp_SubAssign:
            op = " -= ";
            arithmetic = " - ";
            break;
        case HLSLBinaryOp_MulAssign:
            op = " *= ";
            arithmetic = " * ";
            break;
        case HLSLBinaryOp_DivAssign:
            op = " /= ";
            arithmetic = " / ";
            break;
        default:
            Error("Unsupported assignment");
            return "";
    }

    // The right-hand side: converted to the target type, except a scalar of the target's
    // component type, which WGSL applies to every component of a vector or matrix target
    // in a compound assignment.
    auto value = [&]() {
        const HLSLType& rhsType = rhs->expressionType;
        if (arithmetic != nullptr && IsScalarType(rhsType) && !IsScalarType(lhsType))
        {
            if (IsMatrixType(lhsType.baseType) || Numeric(rhsType.baseType) == Numeric(lhsType.baseType))
            {
                return Expr(rhs, IsMatrixType(lhsType.baseType) ? &kFloat : nullptr);
            }
            HLSLType scalar(VectorType(Numeric(lhsType.baseType), 1));
            return Expr(rhs, &scalar);
        }
        return Expr(rhs, &lhsType);
    };

    if (lhs->nodeType == HLSLNodeType_MemberAccess)
    {
        auto* member = static_cast<HLSLMemberAccess*>(lhs);
        if (IsVectorType(member->object->expressionType.baseType))
        {
            std::string field;
            HLSLExpression* object = ComposeSwizzle(member, field);
            if (field.size() > 1)
            {
                // WGSL cannot assign to a multi-component swizzle: compute the new value once
                // and store it a component at a time.
                const std::string base = LValue(object);
                std::string newValue = value();
                if (arithmetic != nullptr)
                {
                    newValue = "(" + base + "." + field + arithmetic + newValue + ")";
                }
                const std::string temporary = "pmw_t" + std::to_string(m_temporaryCounter++);
                std::string text = "{ let " + temporary + " = " + newValue + ";";
                for (size_t i = 0; i < field.size(); i++)
                {
                    text += std::string(" ") + base + "." + field[i] + " = " + temporary + "." + kSwizzle[i] + ";";
                }
                return text + " }";
            }
        }
    }

    return LValue(lhs) + op + value();
}

std::string WGSLGenerator::LValue(HLSLExpression* expression)
{
    switch (expression->nodeType)
    {
        case HLSLNodeType_IdentifierExpression: {
            auto* identifier = static_cast<HLSLIdentifierExpression*>(expression);
            if (identifier->global && (m_bufferFieldOwner.count(identifier->name) > 0 || m_globalUniformNames.count(identifier->name) > 0))
            {
                Error("Assignment to uniform %s", identifier->name);
            }
            return Identifier(identifier);
        }

        case HLSLNodeType_MemberAccess: {
            auto* member = static_cast<HLSLMemberAccess*>(expression);
            const HLSLBaseType objectType = member->object->expressionType.baseType;
            if (IsMatrixType(objectType))
            {
                std::vector<std::pair<int, int>> elements;
                if (!ParseMatrixSwizzle(member->field, elements) || elements.size() != 1)
                {
                    Error("Unsupported matrix element assignment .%s", member->field);
                    return "";
                }
                return LValue(member->object) + "[" + std::to_string(elements[0].second) + "][" + std::to_string(elements[0].first) + "]";
            }
            if (IsScalarType(objectType))
            {
                if (strlen(member->field) == 1)
                {
                    return LValue(member->object);
                }
                Error("Assignment to a swizzle of a scalar");
                return "";
            }
            if (IsVectorType(objectType))
            {
                std::string field;
                HLSLExpression* object = ComposeSwizzle(member, field);
                if (field.size() > 1)
                {
                    Error("Multi-component swizzle .%s is not addressable", field.c_str());
                    return "";
                }
                return LValue(object) + "." + field;
            }
            const std::string field = objectType == HLSLBaseType_UserDefined ? SafeName(member->field) : std::string(member->field);
            return LValue(member->object) + "." + field;
        }

        case HLSLNodeType_ArrayAccess: {
            auto* access = static_cast<HLSLArrayAccess*>(expression);
            if (!access->array->expressionType.array && IsMatrixType(access->array->expressionType.baseType))
            {
                Error("Assignment to a matrix row is not supported");
                return "";
            }
            return LValue(access->array) + "[" + Expr(access->index, &kInt) + "]";
        }

        default:
            Error("Expression is not assignable");
            return "";
    }
}

//-----------------------------------------------------------------------------
// Expressions
//-----------------------------------------------------------------------------

std::string WGSLGenerator::Expr(HLSLExpression* expression, const HLSLType* dstType)
{
    if (expression->nodeType == HLSLNodeType_LiteralExpression && dstType != nullptr &&
        IsNumericScalarOrVector(dstType->baseType) && !dstType->array)
    {
        auto* literal = static_cast<HLSLLiteralExpression*>(expression);
        HLSLType scalar(VectorType(Numeric(dstType->baseType), 1));
        const std::string value = Literal(literal, &scalar);
        return IsVectorType(dstType->baseType) ? TypeName(*dstType) + "(" + value + ")" : value;
    }
    const std::string value = ExprRaw(expression);
    if (dstType == nullptr)
    {
        return value;
    }
    return Convert(value, expression->expressionType, *dstType, expression);
}

std::string WGSLGenerator::Convert(const std::string& value, const HLSLType& srcType, const HLSLType& dstType, HLSLExpression* /*source*/)
{
    const HLSLBaseType src = srcType.baseType;
    const HLSLBaseType dst = dstType.baseType;
    if (src == dst || srcType.array || dstType.array)
    {
        return value;
    }
    if (src < HLSLBaseType_FirstNumeric || src > HLSLBaseType_LastNumeric ||
        dst < HLSLBaseType_FirstNumeric || dst > HLSLBaseType_LastNumeric)
    {
        // Samplers, structs and unknown types are passed through as they are.
        return value;
    }

    if (IsMatrixType(dst))
    {
        if (IsMatrixType(src) || IsScalarType(src))
        {
            const std::string scalar = IsScalarType(src) ? Convert(value, srcType, kFloat) : value;
            return MatrixCastHelper(src, dst) + "(" + scalar + ")";
        }
        Error("Cannot convert %s to a matrix", baseTypeDescriptions[src].typeName);
        return value;
    }
    if (IsMatrixType(src))
    {
        Error("Cannot convert a matrix to %s", baseTypeDescriptions[dst].typeName);
        return value;
    }

    const int srcN = Components(src);
    const int dstN = Components(dst);
    const NumericType srcT = Numeric(src);
    const NumericType dstT = Numeric(dst);

    auto convertScalar = [&](const std::string& scalar) {
        return srcT == dstT ? scalar : TypeName(VectorType(dstT, 1)) + "(" + scalar + ")";
    };

    if (srcN == 1)
    {
        const std::string scalar = convertScalar(value);
        return dstN == 1 ? scalar : TypeName(dst) + "(" + scalar + ")";
    }
    if (dstN == 1)
    {
        // HLSL truncates a vector to its first component.
        return convertScalar(Parenthesize(value) + ".x");
    }
    if (srcN > dstN)
    {
        std::string truncated = Parenthesize(value) + "." + std::string(kSwizzle, static_cast<size_t>(dstN));
        return srcT == dstT ? truncated : TypeName(dst) + "(" + truncated + ")";
    }
    if (srcN < dstN)
    {
        // The GLSL generator pads a widened vector with zeros.
        std::string widened = srcT == dstT ? value : TypeName(VectorType(dstT, srcN)) + "(" + value + ")";
        std::string result = TypeName(dst) + "(" + widened;
        for (int i = srcN; i < dstN; i++)
        {
            result += dstT == NumericType_Bool ? ", false" : ", 0";
        }
        return result + ")";
    }
    return TypeName(dst) + "(" + value + ")";
}

std::string WGSLGenerator::Literal(HLSLLiteralExpression* literal, const HLSLType* dstType)
{
    NumericType target = Numeric(literal->type);
    if (dstType != nullptr && IsScalarType(dstType->baseType))
    {
        target = Numeric(dstType->baseType);
    }

    double value = 0.0;
    switch (literal->type)
    {
        case HLSLBaseType_Float:
            value = literal->fValue;
            break;
        case HLSLBaseType_Int:
        case HLSLBaseType_Uint:
            value = literal->iValue;
            break;
        case HLSLBaseType_Bool:
            value = literal->bValue ? 1.0 : 0.0;
            break;
        default:
            Error("Unsupported literal");
            return "0";
    }

    switch (target)
    {
        case NumericType_Bool:
            return value != 0.0 ? "true" : "false";

        case NumericType_Int: {
            // value holds the literal exactly (an int, a bool or a float widened to double).
            // A float outside i32 has no integer value; converting it would be undefined.
            if (!std::isfinite(value) || value <= -2147483649.0 || value >= 2147483648.0)
            {
                Error("Literal %g does not fit an i32", value);
                return "0";
            }
            const int intValue = static_cast<int>(value);
            const std::string text = std::to_string(intValue);
            return intValue < 0 ? "(" + text + ")" : text;
        }

        case NumericType_Uint: {
            if (literal->type == HLSLBaseType_Int || literal->type == HLSLBaseType_Uint)
            {
                // A negative int literal wraps, as in HLSL.
                return std::to_string(static_cast<unsigned int>(literal->iValue)) + "u";
            }
            if (!std::isfinite(value) || value <= -1.0 || value >= 4294967296.0)
            {
                Error("Literal %g does not fit a u32", value);
                return "0u";
            }
            return std::to_string(static_cast<unsigned int>(value)) + "u";
        }

        case NumericType_Float:
        default: {
            const float floatValue = literal->type == HLSLBaseType_Float ? literal->fValue : static_cast<float>(value);
            if (!std::isfinite(floatValue))
            {
                Error("Literal is not finite");
                return "0.0";
            }
            // The GLSL generator prints literals with an ostream's default precision, six
            // significant digits (String_FormatFloat()): 43758.5453 is 43758.5 on GL. The same
            // rounding here keeps the two paths' pixels together; fix both at once (ADR 0002).
            std::ostringstream stream;
            stream.imbue(std::locale::classic());
            stream << floatValue;
            std::string text = stream.str();
            if (text.find_first_of(".eE") == std::string::npos)
            {
                text += ".0";
            }
            return text[0] == '-' ? "(" + text + ")" : text;
        }
    }
}

std::string WGSLGenerator::ExprRaw(HLSLExpression* expression)
{
    switch (expression->nodeType)
    {
        case HLSLNodeType_IdentifierExpression:
            return Identifier(static_cast<HLSLIdentifierExpression*>(expression));

        case HLSLNodeType_LiteralExpression:
            return Literal(static_cast<HLSLLiteralExpression*>(expression), nullptr);

        case HLSLNodeType_ConstructorExpression: {
            auto* constructor = static_cast<HLSLConstructorExpression*>(expression);
            return Constructor(constructor->type, constructor->argument);
        }

        case HLSLNodeType_CastingExpression: {
            auto* cast = static_cast<HLSLCastingExpression*>(expression);
            return Expr(cast->expression, &cast->type);
        }

        case HLSLNodeType_UnaryExpression:
            return Unary(static_cast<HLSLUnaryExpression*>(expression));

        case HLSLNodeType_BinaryExpression:
            return Binary(static_cast<HLSLBinaryExpression*>(expression));

        case HLSLNodeType_ConditionalExpression:
            return Conditional(static_cast<HLSLConditionalExpression*>(expression));

        case HLSLNodeType_MemberAccess:
            return MemberAccess(static_cast<HLSLMemberAccess*>(expression));

        case HLSLNodeType_ArrayAccess:
            return ArrayAccess(static_cast<HLSLArrayAccess*>(expression));

        case HLSLNodeType_FunctionCall:
            return Call(static_cast<HLSLFunctionCall*>(expression));

        default:
            Error("Unsupported expression");
            return "0";
    }
}

std::string WGSLGenerator::Identifier(HLSLIdentifierExpression* identifier)
{
    const char* name = identifier->name;
    if (!identifier->global && m_scope != nullptr)
    {
        if (m_scope->pointerParams.count(name) > 0)
        {
            return "(*" + SafeName(name) + ")";
        }
        if (m_scope->samplerParams.count(name) > 0)
        {
            Error("Sampler %s used as a value", name);
            return SafeName(name);
        }
    }
    if (identifier->global)
    {
        auto owner = m_bufferFieldOwner.find(name);
        if (owner != m_bufferFieldOwner.end())
        {
            return owner->second + "." + m_bufferFieldName[name];
        }
        if (m_globalUniformNames.count(name) > 0)
        {
            return std::string(kGlobalsBlockName) + "." + SafeName(name);
        }
        if (m_samplers.count(name) > 0)
        {
            Error("Sampler %s used as a value", name);
        }
    }
    return SafeName(name);
}

std::string WGSLGenerator::SamplerPair(HLSLExpression* expression)
{
    if (expression->nodeType != HLSLNodeType_IdentifierExpression)
    {
        Error("A sampler argument must name a sampler");
        return "";
    }
    auto* identifier = static_cast<HLSLIdentifierExpression*>(expression);
    const bool parameter = !identifier->global && m_scope != nullptr && m_scope->samplerParams.count(identifier->name) > 0;
    if (!parameter && m_samplers.count(identifier->name) == 0)
    {
        Error("%s is not a sampler", identifier->name);
    }
    const std::string name = SafeName(identifier->name);
    return name + "_tex, " + name + "_smp";
}

std::string WGSLGenerator::Constructor(const HLSLType& type, HLSLExpression* arguments)
{
    if (IsMatrixType(type.baseType))
    {
        if (arguments != nullptr && arguments->nextExpression == nullptr && IsMatrixType(arguments->expressionType.baseType))
        {
            return Expr(arguments, &type);
        }
        return MatrixConstructor(type, arguments);
    }
    if (type.baseType == HLSLBaseType_UserDefined)
    {
        std::string text = SafeName(type.typeName) + "(";
        int count = 0;
        for (HLSLExpression* argument = arguments; argument != nullptr; argument = argument->nextExpression)
        {
            text += (count++ > 0 ? ", " : "") + ExprRaw(argument);
        }
        return text + ")";
    }
    if (!IsNumericScalarOrVector(type.baseType))
    {
        Error("Unsupported constructor type");
        return "";
    }

    const int needed = Components(type.baseType);
    const NumericType numeric = Numeric(type.baseType);

    if (arguments != nullptr && arguments->nextExpression == nullptr)
    {
        const HLSLType& argumentType = arguments->expressionType;
        if (IsScalarType(argumentType))
        {
            HLSLType scalar(VectorType(numeric, 1));
            const std::string value = Expr(arguments, &scalar);
            return needed == 1 ? value : TypeName(type) + "(" + value + ")";
        }
        return Expr(arguments, &type);
    }

    std::string text = TypeName(type) + "(";
    int provided = 0;
    for (HLSLExpression* argument = arguments; argument != nullptr && provided < needed; argument = argument->nextExpression)
    {
        const HLSLBaseType argumentType = argument->expressionType.baseType;
        if (!IsNumericScalarOrVector(argumentType))
        {
            Error("Unsupported constructor argument");
            return "";
        }
        int n = Components(argumentType);
        if (n > needed - provided)
        {
            n = needed - provided;
        }
        HLSLType target(VectorType(numeric, n));
        text += (provided > 0 ? ", " : "") + Expr(argument, &target);
        provided += n;
    }
    for (; provided < needed; provided++)
    {
        text += numeric == NumericType_Bool ? ", false" : ", 0";
    }
    return text + ")";
}

std::string WGSLGenerator::MatrixConstructor(const HLSLType& type, HLSLExpression* arguments)
{
    // HLSL lists matrix elements by rows, WGSL by columns. Like the GLSL generator, a
    // function per constructor signature reorders them (it reads vector arguments by
    // component, so each argument is evaluated once).
    const HLSLBaseType matrixType = type.baseType;
    const int rows = baseTypeDescriptions[matrixType].numComponents;
    const int columns = baseTypeDescriptions[matrixType].height;
    const std::string typeName = TypeName(matrixType);

    std::string name = "pmw_" + typeName + "_from";
    std::string parameters;
    std::string callArguments;
    std::vector<std::string> slots(static_cast<size_t>(rows * columns), "0.0");
    int argumentIndex = 0;
    int element = 0;
    for (HLSLExpression* argument = arguments; argument != nullptr; argument = argument->nextExpression, argumentIndex++)
    {
        const HLSLBaseType argumentType = argument->expressionType.baseType;
        if (!IsNumericScalarOrVector(argumentType))
        {
            Error("Unsupported matrix constructor argument");
            return "";
        }
        const std::string argumentTypeName = TypeName(argumentType);
        const std::string parameter = std::string(1, static_cast<char>('a' + (argumentIndex % 26))) + std::to_string(argumentIndex / 26);
        name += "_" + Sanitize(argumentTypeName);
        parameters += (argumentIndex > 0 ? ", " : "") + parameter + ": " + argumentTypeName;
        callArguments += (argumentIndex > 0 ? ", " : "") + ExprRaw(argument);

        const int n = Components(argumentType);
        const bool isFloat = Numeric(argumentType) == NumericType_Float;
        for (int i = 0; i < n; i++, element++)
        {
            if (element >= rows * columns)
            {
                break;
            }
            std::string component = IsScalarType(argumentType) ? parameter : parameter + "." + kSwizzle[i];
            if (!isFloat)
            {
                component = "f32(" + component + ")";
            }
            const int row = element / columns;
            const int column = element % columns;
            slots[static_cast<size_t>(column * rows + row)] = component;
        }
    }

    if (m_helpers.find(name) == m_helpers.end())
    {
        std::string code = "fn " + name + "(" + parameters + ") -> " + typeName + " {\n    return " + typeName + "(";
        for (size_t i = 0; i < slots.size(); i++)
        {
            code += (i > 0 ? ", " : "") + slots[i];
        }
        code += ");\n}\n";
        Helper(name, code);
    }
    return name + "(" + callArguments + ")";
}

bool WGSLGenerator::IsConstant(HLSLExpression* expression) const
{
    // Would WGSL treat the emitted expression as a const-expression? Literals and anything
    // built only from literals by operators, constructors and builtins are; identifiers are
    // not (the generator never declares a WGSL const).
    switch (expression->nodeType)
    {
        case HLSLNodeType_LiteralExpression:
            return true;
        case HLSLNodeType_UnaryExpression:
            return IsConstant(static_cast<HLSLUnaryExpression*>(expression)->expression);
        case HLSLNodeType_BinaryExpression: {
            auto* binary = static_cast<HLSLBinaryExpression*>(expression);
            return IsConstant(binary->expression1) && IsConstant(binary->expression2);
        }
        case HLSLNodeType_CastingExpression:
            return IsConstant(static_cast<HLSLCastingExpression*>(expression)->expression);
        case HLSLNodeType_MemberAccess:
            return IsConstant(static_cast<HLSLMemberAccess*>(expression)->object);
        case HLSLNodeType_ConstructorExpression:
        case HLSLNodeType_FunctionCall: {
            HLSLExpression* argument = expression->nodeType == HLSLNodeType_ConstructorExpression
                                           ? static_cast<HLSLConstructorExpression*>(expression)->argument
                                           : static_cast<HLSLFunctionCall*>(expression)->argument;
            if (expression->nodeType == HLSLNodeType_FunctionCall && IsUserFunction(static_cast<HLSLFunctionCall*>(expression)->function))
            {
                return false;
            }
            for (; argument != nullptr; argument = argument->nextExpression)
            {
                if (!IsConstant(argument))
                {
                    return false;
                }
            }
            return true;
        }
        default:
            return false;
    }
}

std::string WGSLGenerator::RuntimeValue(HLSLExpression* expression, const HLSLType* dstType)
{
    // WGSL evaluates const-expressions when the shader is created and rejects the module if
    // one is out of a builtin's domain or not representable: log(0.0), 1.0 / 0.0,
    // inverseSqrt(0.0). GLSL compiles them and yields inf or NaN at run time. Passing a
    // constant through a function call keeps it a runtime value, so the pixels match GL.
    const std::string value = Expr(expression, dstType);
    if (!IsConstant(expression))
    {
        return value;
    }
    const HLSLBaseType type = dstType != nullptr ? dstType->baseType : expression->expressionType.baseType;
    if (!IsNumericScalarOrVector(type))
    {
        return value;
    }
    const std::string typeName = TypeName(type);
    const std::string name = "pmw_runtime_" + Sanitize(typeName);
    Helper(name, "fn " + name + "(x: " + typeName + ") -> " + typeName + " {\n    return x;\n}\n");
    return name + "(" + value + ")";
}

std::string WGSLGenerator::Unary(HLSLUnaryExpression* expression)
{
    const HLSLType& type = expression->expressionType;
    switch (expression->unaryOp)
    {
        case HLSLUnaryOp_Negative:
            return "(-" + Parenthesize(Expr(expression->expression)) + ")";
        case HLSLUnaryOp_Positive:
            return Expr(expression->expression);
        case HLSLUnaryOp_Not: {
            const int n = IsVectorType(expression->expression->expressionType) ? Components(expression->expression->expressionType.baseType) : 1;
            HLSLType boolType(VectorType(NumericType_Bool, n));
            const std::string value = "(!" + Parenthesize(Expr(expression->expression, &boolType)) + ")";
            return Numeric(type.baseType) == NumericType_Bool || type.baseType == HLSLBaseType_Unknown ? value : Convert(value, boolType, type);
        }
        case HLSLUnaryOp_BitNot:
            return "(~" + Parenthesize(Expr(expression->expression)) + ")";
        default:
            Error("Increment or decrement inside an expression is not supported");
            return "";
    }
}

std::string WGSLGenerator::Binary(HLSLBinaryExpression* expression)
{
    HLSLExpression* e1 = expression->expression1;
    HLSLExpression* e2 = expression->expression2;
    const HLSLType& type = expression->expressionType;
    const HLSLType& t1 = e1->expressionType;
    const HLSLType& t2 = e2->expressionType;
    const HLSLBinaryOp op = expression->binaryOp;

    if (IsAssignOp(op))
    {
        Error("Assignment inside an expression is not supported");
        return "";
    }

    if (op == HLSLBinaryOp_Mod && Numeric(type.baseType) == NumericType_Float)
    {
        // As the GLSL generator: HLSL's float % becomes GLSL's floor-based mod().
        return TypedHelper("mod", type.baseType) + "(" + Expr(e1, &type) + ", " + Expr(e2, &type) + ")";
    }

    const char* text = "?";
    switch (op)
    {
        case HLSLBinaryOp_Add:
            text = " + ";
            break;
        case HLSLBinaryOp_Sub:
            text = " - ";
            break;
        case HLSLBinaryOp_Mul:
            text = " * ";
            break;
        case HLSLBinaryOp_Div:
            text = " / ";
            break;
        case HLSLBinaryOp_Mod:
            text = " % ";
            break;
        case HLSLBinaryOp_Less:
            text = " < ";
            break;
        case HLSLBinaryOp_Greater:
            text = " > ";
            break;
        case HLSLBinaryOp_LessEqual:
            text = " <= ";
            break;
        case HLSLBinaryOp_GreaterEqual:
            text = " >= ";
            break;
        case HLSLBinaryOp_Equal:
            text = " == ";
            break;
        case HLSLBinaryOp_NotEqual:
            text = " != ";
            break;
        case HLSLBinaryOp_And:
            text = " && ";
            break;
        case HLSLBinaryOp_Or:
            text = " || ";
            break;
        case HLSLBinaryOp_BitAnd:
            text = " & ";
            break;
        case HLSLBinaryOp_BitOr:
            text = " | ";
            break;
        case HLSLBinaryOp_BitXor:
            text = " ^ ";
            break;
        default:
            break;
    }

    if (IsCompareOp(op))
    {
        if (IsVectorType(t1) || IsVectorType(t2))
        {
            const int n = std::max(IsVectorType(t1) ? Components(t1.baseType) : 1, IsVectorType(t2) ? Components(t2.baseType) : 1);
            HLSLType operand(VectorType(CommonNumeric(Numeric(t1.baseType), Numeric(t2.baseType)), n));
            return "(" + Expr(e1, &operand) + text + Expr(e2, &operand) + ")";
        }
        const HLSLType* common = CommonScalarType(t1, t2);
        return "(" + Expr(e1, common) + text + Expr(e2, common) + ")";
    }

    if (op == HLSLBinaryOp_And || op == HLSLBinaryOp_Or)
    {
        if (IsVectorType(type))
        {
            // WGSL's && and || take scalars only; & and | work per component on bools.
            return "(" + Expr(e1, &type) + (op == HLSLBinaryOp_And ? " & " : " | ") + Expr(e2, &type) + ")";
        }
        return "(" + Expr(e1, &kBool) + text + Expr(e2, &kBool) + ")";
    }

    if (op == HLSLBinaryOp_BitAnd || op == HLSLBinaryOp_BitOr || op == HLSLBinaryOp_BitXor)
    {
        const HLSLType* common = IsScalarType(type) ? CommonScalarType(t1, t2) : &type;
        return "(" + Expr(e1, common) + text + Expr(e2, common) + ")";
    }

    // Arithmetic.
    if (IsMatrixType(type.baseType))
    {
        // matrix * scalar stays a scalar operand; everything else is converted. Note that
        // matrix * matrix is a matrix product here, as in GLSL (HLSL's * is per element).
        auto operand = [&](HLSLExpression* e) {
            return IsScalarType(e->expressionType) ? Expr(e, &kFloat) : Expr(e, &type);
        };
        return "(" + operand(e1) + text + operand(e2) + ")";
    }

    if (op == HLSLBinaryOp_Mul && (m_options.flags & Flag_AlternateNanPropagation) != 0 && Numeric(type.baseType) == NumericType_Float)
    {
        return TypedHelper("mul", type.baseType) + "(" + Expr(e1, &type) + ", " + Expr(e2, &type) + ")";
    }

    if (op == HLSLBinaryOp_Div && IsConstant(e2))
    {
        // x / 0.0 is a shader-creation error when both sides are constant (see RuntimeValue()).
        const HLSLType* divisorType = IsVectorType(type) && IsScalarType(t2) ? nullptr : &type;
        if (divisorType == nullptr)
        {
            HLSLType scalar(VectorType(Numeric(type.baseType), 1));
            return "(" + Expr(e1, &type) + text + RuntimeValue(e2, &scalar) + ")";
        }
        return "(" + Expr(e1, &type) + text + RuntimeValue(e2, divisorType) + ")";
    }

    auto operand = [&](HLSLExpression* e) {
        // A scalar of the vector's component type is applied to each component as it is.
        if (IsVectorType(type) && IsScalarType(e->expressionType) && e->nodeType != HLSLNodeType_LiteralExpression)
        {
            if (Numeric(e->expressionType.baseType) == Numeric(type.baseType))
            {
                return Expr(e);
            }
            HLSLType scalar(VectorType(Numeric(type.baseType), 1));
            return Expr(e, &scalar);
        }
        return Expr(e, &type);
    };
    return "(" + operand(e1) + text + operand(e2) + ")";
}

std::string WGSLGenerator::Conditional(HLSLConditionalExpression* expression)
{
    // WGSL has no ?:; select() evaluates both sides, which cannot have side effects here.
    const HLSLType& type = expression->expressionType;
    const HLSLType& conditionType = expression->condition->expressionType;
    HLSLType condition(HLSLBaseType_Bool);
    if (IsVectorType(conditionType) && IsVectorType(type))
    {
        condition = HLSLType(VectorType(NumericType_Bool, Components(type.baseType)));
    }
    return "select(" + Expr(expression->falseExpression, &type) + ", " + Expr(expression->trueExpression, &type) + ", " +
           Expr(expression->condition, &condition) + ")";
}

std::string WGSLGenerator::MemberAccess(HLSLMemberAccess* expression)
{
    HLSLExpression* object = expression->object;
    const HLSLBaseType objectType = object->expressionType.baseType;
    const char* field = expression->field;

    if (IsScalarType(objectType))
    {
        // float.xxx: a splat.
        const size_t length = strlen(field);
        const std::string value = Expr(object);
        if (length == 1)
        {
            return value;
        }
        return TypeName(VectorType(Numeric(objectType), static_cast<int>(length))) + "(" + value + ")";
    }

    const std::string value = Parenthesize(Expr(object));
    if (IsMatrixType(objectType))
    {
        std::vector<std::pair<int, int>> elements;
        if (!ParseMatrixSwizzle(field, elements))
        {
            Error("Unsupported matrix swizzle .%s", field);
            return value;
        }
        auto elementText = [&](const std::pair<int, int>& rowColumn) {
            return value + "[" + std::to_string(rowColumn.second) + "][" + std::to_string(rowColumn.first) + "]";
        };
        if (elements.size() == 1)
        {
            return elementText(elements[0]);
        }
        std::string text = TypeName(VectorType(NumericType_Float, static_cast<int>(elements.size()))) + "(";
        for (size_t i = 0; i < elements.size(); i++)
        {
            text += (i > 0 ? ", " : "") + elementText(elements[i]);
        }
        return text + ")";
    }

    if (objectType == HLSLBaseType_UserDefined)
    {
        return value + "." + SafeName(field);
    }
    for (const char* c = field; *c != 0; c++)
    {
        if (SwizzleIndex(*c) < 0)
        {
            Error("Unsupported swizzle .%s", field);
            break;
        }
    }
    return value + "." + field;
}

std::string WGSLGenerator::ArrayAccess(HLSLArrayAccess* expression)
{
    const HLSLType& arrayType = expression->array->expressionType;
    if (!arrayType.array && IsMatrixType(arrayType.baseType))
    {
        return MatrixRowHelper(arrayType.baseType) + "(" + Expr(expression->array) + ", " + Expr(expression->index, &kInt) + ")";
    }
    return Parenthesize(Expr(expression->array)) + "[" + Expr(expression->index, &kInt) + "]";
}

std::string WGSLGenerator::Arguments(HLSLExpression* argument, const HLSLArgument* parameter)
{
    std::string text;
    int count = 0;
    for (; argument != nullptr; argument = argument->nextExpression, count++)
    {
        if (count > 0)
        {
            text += ", ";
        }
        if (parameter == nullptr)
        {
            text += Expr(argument);
            continue;
        }
        if (IsSamplerType(parameter->type))
        {
            text += SamplerPair(argument);
        }
        else if (parameter->modifier == HLSLArgumentModifier_Out || parameter->modifier == HLSLArgumentModifier_Inout)
        {
            if (argument->expressionType.baseType != parameter->type.baseType)
            {
                Error("An out argument must have the parameter's type");
            }
            if (argument->nodeType == HLSLNodeType_IdentifierExpression && static_cast<HLSLIdentifierExpression*>(argument)->global)
            {
                Error("A global variable cannot be an out argument");
            }
            text += "&" + LValue(argument);
        }
        else
        {
            text += Expr(argument, &parameter->type);
        }
        parameter = parameter->nextArgument;
    }
    return text;
}

std::string WGSLGenerator::Call(HLSLFunctionCall* call)
{
    if (IsUserFunction(call->function))
    {
        return FunctionName(call->function) + "(" + Arguments(call->argument, call->function->argument) + ")";
    }
    bool handled = false;
    std::string text = Intrinsic(call, handled);
    if (!handled)
    {
        Error("Intrinsic %s is not supported", call->function->name);
    }
    return text;
}

std::string WGSLGenerator::Intrinsic(HLSLFunctionCall* call, bool& handled)
{
    handled = true;
    const HLSLFunction* function = call->function;
    const char* name = function->name;
    const HLSLType& returnType = function->returnType;

    HLSLExpression* argument[4] = {};
    const int count = GetFunctionArguments(call, argument, 4);
    const HLSLArgument* parameter[4] = {};
    {
        const HLSLArgument* p = function->argument;
        for (int i = 0; i < 4 && p != nullptr; i++, p = p->nextArgument)
        {
            parameter[i] = p;
        }
    }
    auto arg = [&](int i) {
        return parameter[i] != nullptr ? Expr(argument[i], &parameter[i]->type) : Expr(argument[i]);
    };
    auto expect = [&](int n) {
        if (count != n)
        {
            Error("%s expects %d arguments", name, n);
            return false;
        }
        return true;
    };

    // Same meaning, same name.
    static const std::set<std::string> passThrough = {
        "abs",
        "atan",
        "atan2",
        "ceil",
        "cos",
        "cross",
        "distance",
        "dot",
        "exp",
        "exp2",
        "floor",
        "fwidth",
        "length",
        "max",
        "min",
        "normalize",
        "reflect",
        "refract",
        "round",
        "sign",
        "sin",
        "step",
        "tan",
        "transpose",
        "determinant",
        "degrees",
        "radians",
        "trunc",
        "cosh",
        "sinh",
        "tanh",
    };
    static const std::map<std::string, std::string> renamed = {
        {"lerp", "mix"},
        {"frac", "fract"},
        {"ddx", "dpdx"},
        {"ddy", "dpdy"},
        {"faceforward", "faceForward"},
    };

    if ((String_Equal(name, "normalize") || String_Equal(name, "dot")) && count >= 1 && parameter[0] != nullptr &&
        IsScalarType(parameter[0]->type))
    {
        // HLSL and GLSL take scalars here; WGSL's normalize() and dot() want vectors.
        if (String_Equal(name, "dot"))
        {
            return expect(2) ? "(" + arg(0) + " * " + arg(1) + ")" : "";
        }
        const std::string helper = Helper("pmw_normalize_f32", "fn pmw_normalize_f32(x: f32) -> f32 {\n    return x / abs(x);\n}\n");
        return helper + "(" + arg(0) + ")";
    }
    if (String_Equal(name, "normalize") && count == 1)
    {
        return "normalize(" + RuntimeValue(argument[0], &parameter[0]->type) + ")";
    }
    if (passThrough.count(name) > 0)
    {
        return std::string(name) + "(" + Arguments(call->argument, function->argument) + ")";
    }
    auto rename = renamed.find(name);
    if (rename != renamed.end())
    {
        return rename->second + "(" + Arguments(call->argument, function->argument) + ")";
    }

    if (String_Equal(name, "mul"))
    {
        if (!expect(2))
        {
            return "";
        }
        if (IsVectorType(parameter[0]->type) && IsVectorType(parameter[1]->type))
        {
            return "dot(" + arg(0) + ", " + arg(1) + ")";
        }
        return "(" + arg(0) + " * " + arg(1) + ")";
    }
    if (String_Equal(name, "saturate"))
    {
        if (!expect(1))
        {
            return "";
        }
        if (Numeric(argument[0]->expressionType.baseType) == NumericType_Float)
        {
            return "saturate(" + Expr(argument[0]) + ")";
        }
        return "clamp(" + Expr(argument[0]) + ", 0, 1)";
    }
    if (String_Equal(name, "rsqrt"))
    {
        // DX9 takes the absolute value (projectM issue #724); so does the GLSL generator.
        if (!expect(1))
        {
            return "";
        }
        return "inverseSqrt(abs(" + RuntimeValue(argument[0], &parameter[0]->type) + "))";
    }
    if (String_Equal(name, "sqrt") || String_Equal(name, "log") || String_Equal(name, "log2"))
    {
        if (!expect(1))
        {
            return "";
        }
        return std::string(name) + "(abs(" + RuntimeValue(argument[0], &parameter[0]->type) + "))";
    }
    if (String_Equal(name, "log10"))
    {
        if (!expect(1))
        {
            return "";
        }
        return "(log(abs(" + RuntimeValue(argument[0], &parameter[0]->type) + ")) / log(10.0))";
    }
    if (String_Equal(name, "clamp"))
    {
        if (!expect(3))
        {
            return "";
        }
        // GLSL defines clamp() as min(max(x, low), high), for any low and high. WGSL's clamp()
        // rejects a constant low > high.
        return "min(max(" + arg(0) + ", " + arg(1) + "), " + arg(2) + ")";
    }
    if (String_Equal(name, "smoothstep"))
    {
        if (!expect(3))
        {
            return "";
        }
        // GLSL's definition, which WGSL's builtin shares except that it rejects a constant
        // low == high.
        const std::string typeName = TypeName(returnType.baseType);
        const std::string helper = Helper("pmw_smoothstep_" + Sanitize(typeName),
                                          "fn pmw_smoothstep_" + Sanitize(typeName) + "(low: " + typeName + ", high: " + typeName + ", x: " + typeName +
                                              ") -> " + typeName + " {\n    let t = saturate((x - low) / (high - low));\n    return t * t * (3.0 - 2.0 * t);\n}\n");
        return helper + "(" + arg(0) + ", " + arg(1) + ", " + arg(2) + ")";
    }
    if (String_Equal(name, "pow"))
    {
        if (!expect(2))
        {
            return "";
        }
        // As the GLSL generator: pow(x, 1) is x, even for a negative x; otherwise abs(x).
        if (argument[1]->nodeType == HLSLNodeType_LiteralExpression)
        {
            auto* literal = static_cast<HLSLLiteralExpression*>(argument[1]);
            const bool one = (literal->type == HLSLBaseType_Float && literal->fValue == 1.0f) ||
                             ((literal->type == HLSLBaseType_Int || literal->type == HLSLBaseType_Uint) && literal->iValue == 1) ||
                             (literal->type == HLSLBaseType_Bool && literal->bValue);
            if (one)
            {
                return "(" + Expr(argument[0], &returnType) + ")";
            }
        }
        return "pow(abs(" + RuntimeValue(argument[0], &returnType) + "), " + Expr(argument[1], &returnType) + ")";
    }
    if (String_Equal(name, "ldexp"))
    {
        if (!expect(2))
        {
            return "";
        }
        // HLSL's exponent is a float: x * exp2(e), as the GLSL generator.
        return "(" + Expr(argument[0], &returnType) + " * exp2(" + Expr(argument[1], &returnType) + "))";
    }
    if (String_Equal(name, "fmod"))
    {
        if (!expect(2))
        {
            return "";
        }
        // The GLSL generator maps fmod to mod (floor-based, not truncated); keep the pixels.
        return TypedHelper("mod", returnType.baseType) + "(" + Expr(argument[0], &returnType) + ", " + Expr(argument[1], &returnType) + ")";
    }
    if (String_Equal(name, "acos") || String_Equal(name, "asin"))
    {
        if (!expect(1))
        {
            return "";
        }
        return TypedHelper(name, returnType.baseType) + "(" + Expr(argument[0], &returnType) + ")";
    }
    if (String_Equal(name, "clip"))
    {
        if (!expect(1))
        {
            return "";
        }
        return TypedHelper("clip", parameter[0]->type.baseType) + "(" + arg(0) + ")";
    }
    if (String_Equal(name, "rcp"))
    {
        if (!expect(1))
        {
            return "";
        }
        return "(1.0 / " + RuntimeValue(argument[0], &parameter[0]->type) + ")";
    }
    if (String_Equal(name, "mad"))
    {
        if (!expect(3))
        {
            return "";
        }
        return "(" + arg(0) + " * " + arg(1) + " + " + arg(2) + ")";
    }
    if (String_Equal(name, "isnan") || String_Equal(name, "isinf"))
    {
        if (!expect(1))
        {
            return "";
        }
        return TypedHelper(name, HLSLBaseType_Float) + "(" + Expr(argument[0], &kFloat) + ")";
    }
    if (String_Equal(name, "asuint"))
    {
        if (!expect(1))
        {
            return "";
        }
        return "bitcast<u32>(" + Expr(argument[0], &kFloat) + ")";
    }
    if (String_Equal(name, "any") || String_Equal(name, "all"))
    {
        if (!expect(1))
        {
            return "";
        }
        const HLSLBaseType type = argument[0]->expressionType.baseType;
        if (IsMatrixType(type))
        {
            Error("%s of a matrix is not supported", name);
            return "";
        }
        HLSLType boolType(VectorType(NumericType_Bool, std::max(1, Components(type))));
        return std::string(name) + "(" + Expr(argument[0], &boolType) + ")";
    }
    if (String_Equal(name, "modf"))
    {
        if (!expect(2))
        {
            return "";
        }
        if (argument[1]->expressionType.baseType != returnType.baseType)
        {
            Error("modf: the out argument must have the value's type");
            return "";
        }
        return TypedHelper("modf", returnType.baseType) + "(" + Expr(argument[0], &returnType) + ", &" + LValue(argument[1]) + ")";
    }
    if (String_Equal(name, "sincos"))
    {
        if (!expect(3))
        {
            return "";
        }
        const HLSLBaseType type = argument[0]->expressionType.baseType;
        if (argument[1]->expressionType.baseType != type || argument[2]->expressionType.baseType != type)
        {
            Error("sincos: the out arguments must have the value's type");
            return "";
        }
        return TypedHelper("sincos", type) + "(" + Expr(argument[0]) + ", &" + LValue(argument[1]) + ", &" + LValue(argument[2]) + ")";
    }

    // Textures. Each HLSL sampler is a texture and a sampler in WGSL.
    if (String_Equal(name, "tex2D") || String_Equal(name, "tex3D"))
    {
        if (!expect(2))
        {
            return "";
        }
        return "textureSample(" + SamplerPair(argument[0]) + ", " + arg(1) + ")";
    }
    if (String_Equal(name, "tex2Dgrad"))
    {
        if (!expect(4))
        {
            return "";
        }
        return "textureSampleGrad(" + SamplerPair(argument[0]) + ", " + arg(1) + ", " + arg(2) + ", " + arg(3) + ")";
    }
    if (String_Equal(name, "tex2Dlod") || String_Equal(name, "tex2Dbias") || String_Equal(name, "tex2Dproj") ||
        String_Equal(name, "tex3Dlod") || String_Equal(name, "tex3Dbias"))
    {
        if (!expect(2))
        {
            return "";
        }
        const bool volume = name[3] == '3';
        const std::string textureType = volume ? "texture_3d<f32>" : "texture_2d<f32>";
        const std::string coordinates = volume ? "c.xyz" : "c.xy";
        std::string body;
        if (String_Equal(name + 5, "lod"))
        {
            body = "textureSampleLevel(t, s, " + coordinates + ", c.w)";
        }
        else if (String_Equal(name + 5, "bias"))
        {
            body = "textureSampleBias(t, s, " + coordinates + ", c.w)";
        }
        else
        {
            body = "textureSample(t, s, c.xy / c.w)";
        }
        const std::string helper = Helper(std::string("pmw_") + name,
                                          std::string("fn pmw_") + name + "(t: " + textureType + ", s: sampler, c: vec4f) -> vec4f {\n    return " + body + ";\n}\n");
        return helper + "(" + SamplerPair(argument[0]) + ", " + arg(1) + ")";
    }
    if (String_Equal(name, "tex2Dfetch"))
    {
        if (!expect(2))
        {
            return "";
        }
        const std::string helper = Helper("pmw_tex2Dfetch",
                                          "fn pmw_tex2Dfetch(t: texture_2d<f32>, c: vec3i) -> vec4f {\n    return textureLoad(t, c.xy, c.z);\n}\n");
        const std::string pair = SamplerPair(argument[0]);
        return helper + "(" + pair.substr(0, pair.find(',')) + ", " + arg(1) + ")";
    }
    if (String_Equal(name, "tex2Dsize") || String_Equal(name, "tex3Dsize"))
    {
        if (!expect(1))
        {
            return "";
        }
        const std::string pair = SamplerPair(argument[0]);
        return std::string(name[3] == '3' ? "vec3i" : "vec2i") + "(textureDimensions(" + pair.substr(0, pair.find(',')) + "))";
    }

    handled = false;
    return "";
}

} // namespace M4
