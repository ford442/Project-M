//=============================================================================
//
// WGSLGenerator.h
//
// WGSL code generator for the HLSL tree, next to GLSLGenerator. projectM addition
// (Phase C of the WebGPU backend, docs/adr/0002-wgsl-shader-path.md).
//
// It walks the same HLSLTree the GLSL generator walks and keeps the GLSL generator's
// Milkdrop semantics (DX9 NaN-free multiply, abs() in sqrt/log/pow, the DX9 acos/asin
// extension, GLSL's floor-based float modulo, the HLSL row-major matrix model), so a
// preset renders the same on both paths within float tolerance. The bindings and the
// uniform layout come from the tree, as a Reflection, not from a regex over the output.
//
//=============================================================================

#ifndef WGSL_GENERATOR_H
#define WGSL_GENERATOR_H

#include "HLSLTree.h"

#include <map>
#include <set>
#include <string>
#include <vector>

namespace M4 {

class WGSLGenerator
{
public:
    enum Target
    {
        Target_FragmentShader,
    };

    enum Flags
    {
        //! Multiply like DX9 shader model 3: 0 * x is 0 even when x is inf or NaN.
        //! The GLSL generator's Flag_AlternateNanPropagation.
        Flag_AlternateNanPropagation = 1 << 0,
    };

    struct Options {
        unsigned int flags{0};
        //! Bind group of the uniform buffers (cbuffers and the plain-uniform block).
        unsigned int uniformGroup{0};
        //! Bind group of the textures and samplers.
        unsigned int textureGroup{1};
        //! Name of the generated @fragment function.
        const char* entryPointName{"fs_main"};

        Options() = default;
        explicit Options(unsigned int _flags)
            : flags(_flags)
        {
        }
    };

    enum BindingKind
    {
        BindingKind_UniformBuffer,
        BindingKind_Texture2D,
        BindingKind_Texture3D,
        BindingKind_Sampler,
    };

    //! One member of a uniform buffer, with its WGSL (uniform address space) layout.
    struct UniformMember {
        std::string name; //!< The HLSL name, which is also the WGSL member name unless it had to be renamed.
        std::string wgslName;
        std::string type; //!< WGSL type, e.g. "vec4f" or "mat3x4f".
        unsigned int offset{0};
        unsigned int size{0};
    };

    struct Binding {
        BindingKind kind{BindingKind_UniformBuffer};
        unsigned int group{0};
        unsigned int binding{0};
        std::string wgslName;   //!< Name of the module-scope variable.
        std::string sourceName; //!< HLSL name: the cbuffer, or the sampler a texture/sampler pair came from.
        // Uniform buffers only:
        unsigned int size{0};
        std::vector<UniformMember> members;
    };

    //! A fragment input or output, mapped from its HLSL semantic.
    struct StageVariable {
        std::string semantic;
        std::string type;
        int location{-1};    //!< -1 for a builtin.
        std::string builtin; //!< "position" / "frag_depth", or empty.
    };

    struct Reflection {
        std::string entryPoint;
        std::vector<Binding> bindings;
        std::vector<StageVariable> inputs;
        std::vector<StageVariable> outputs;

        //! The binding with this WGSL variable name, or nullptr.
        const Binding* FindBinding(const std::string& wgslName) const;
    };

    //! Name of the module-scope block that holds plain (non-cbuffer, non-sampler) uniforms.
    static const char* const kGlobalsBlockName;

    //! Location of an input semantic: TEXCOORDn is n, COLORn is 8 + n.
    static int InputLocation(const char* semantic);

    WGSLGenerator();

    bool Generate(HLSLTree* tree, Target target, const char* entryName, const Options& options);
    bool Generate(HLSLTree* tree, Target target, const char* entryName)
    {
        return Generate(tree, target, entryName, Options());
    }

    const char* GetResult() const;
    const Reflection& GetReflection() const;
    //! The first error, empty after a successful Generate().
    const std::string& GetError() const;

private:
    struct FunctionInfo {
        std::string wgslName;
    };

    struct FunctionScope {
        std::set<std::string> pointerParams; //!< out/inout parameters, accessed through a pointer.
        std::set<std::string> samplerParams;
    };

    // Module layout.
    void CollectGlobals(HLSLStatement* statement);
    void EmitTopLevel(HLSLStatement* statement);
    void EmitBuffer(HLSLBuffer* buffer);
    void EmitGlobalsBlock();
    void EmitFunction(HLSLFunction* function);
    void EmitStruct(HLSLStruct* structure);
    bool EmitEntryPoint(HLSLFunction* entryFunction);

    // Statements.
    void EmitStatements(int indent, HLSLStatement* statement, const HLSLType* returnType);
    void EmitDeclaration(int indent, HLSLDeclaration* declaration);
    std::string DeclarationInitializer(HLSLDeclaration* declaration);
    std::string SimpleStatement(HLSLExpression* expression);
    std::string Assignment(HLSLBinaryExpression* expression);
    std::string LValue(HLSLExpression* expression);

    // Expressions.
    std::string Expr(HLSLExpression* expression, const HLSLType* dstType = nullptr);
    std::string ExprRaw(HLSLExpression* expression);
    std::string Convert(const std::string& value, const HLSLType& srcType, const HLSLType& dstType, HLSLExpression* source = nullptr);
    std::string Identifier(HLSLIdentifierExpression* identifier);
    std::string Constructor(const HLSLType& type, HLSLExpression* arguments);
    std::string MatrixConstructor(const HLSLType& type, HLSLExpression* arguments);
    std::string Binary(HLSLBinaryExpression* expression);
    std::string Unary(HLSLUnaryExpression* expression);
    std::string Conditional(HLSLConditionalExpression* expression);
    std::string MemberAccess(HLSLMemberAccess* expression);
    std::string ArrayAccess(HLSLArrayAccess* expression);
    std::string Call(HLSLFunctionCall* call);
    std::string Intrinsic(HLSLFunctionCall* call, bool& handled);
    std::string Arguments(HLSLExpression* argument, const HLSLArgument* parameter);
    std::string SamplerPair(HLSLExpression* expression);
    std::string Literal(HLSLLiteralExpression* literal, const HLSLType* dstType);
    bool IsConstant(HLSLExpression* expression) const;
    std::string RuntimeValue(HLSLExpression* expression, const HLSLType* dstType);

    // Types and names.
    std::string TypeName(const HLSLType& type);
    std::string TypeName(HLSLBaseType baseType);
    std::string SafeName(const char* name) const;
    std::string FunctionName(const HLSLFunction* function);
    std::string FunctionKey(const HLSLFunction* function) const;
    bool IsUserFunction(const HLSLFunction* function) const;
    bool LayoutOf(const HLSLType& type, unsigned int& align, unsigned int& size);

    // Helpers emitted once at module scope.
    std::string Helper(const std::string& name, const std::string& code);
    std::string MatrixRowHelper(HLSLBaseType matrixType);
    std::string MatrixCastHelper(HLSLBaseType srcType, HLSLBaseType dstType);
    std::string TypedHelper(const char* base, HLSLBaseType type);

    void Error(const char* format, ...);

    std::string Indent(int indent) const;

    HLSLTree* m_tree{nullptr};
    Options m_options;
    const char* m_entryName{nullptr};

    std::string m_result;
    std::string m_body;
    std::map<std::string, std::string> m_helpers;
    std::vector<std::string> m_helperOrder;

    Reflection m_reflection;
    std::string m_error;
    bool m_hasError{false};

    // Global symbols.
    std::map<std::string, std::string> m_bufferFieldOwner; //!< cbuffer field -> WGSL buffer variable.
    std::map<std::string, std::string> m_bufferFieldName;  //!< cbuffer field -> WGSL member name.
    std::vector<HLSLDeclaration*> m_globalUniforms;        //!< Members of the plain-uniform block.
    std::set<std::string> m_globalUniformNames;
    std::map<std::string, HLSLBaseType> m_samplers;     //!< Global sampler -> sampler type.
    std::vector<HLSLDeclaration*> m_globalInitializers; //!< Private globals initialized in the entry point.
    std::set<const HLSLFunction*> m_userFunctions;
    std::map<std::string, FunctionInfo> m_functions; //!< FunctionKey() -> name.
    std::map<std::string, int> m_functionNameCount;
    unsigned int m_nextTextureBinding{0};
    unsigned int m_nextUniformBinding{0};

    const FunctionScope* m_scope{nullptr};
    int m_temporaryCounter{0};
};

} // namespace M4

#endif
