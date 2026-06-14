#include <gtest/gtest.h>

#include <HLSLParser.h>
#include <HLSLTree.h>

#include <cstring>
#include <string>

namespace {

bool ParseHLSL(const char* code)
{
    M4::Allocator allocator;
    M4::HLSLTree tree(&allocator);
    M4::HLSLParser parser(&allocator, &tree);
    return parser.Parse("test.hlsl", code, strlen(code));
}

bool Preprocess(const char* code, std::string& sourcePreprocessed)
{
    M4::Allocator allocator;
    M4::HLSLTree tree(&allocator);
    M4::HLSLParser parser(&allocator, &tree);
    return parser.ApplyPreprocessor("test.hlsl", code, strlen(code), sourcePreprocessed);
}

} // namespace

// Regression test for issue #940: parenthesized constructor with binary operator
// was rejected with "expected ';'" error.
TEST(HLSLParser, ParenthesizedConstructorWithMultiply)
{
    EXPECT_TRUE(ParseHLSL(
        "float scalar = 2.0;\n"
        "float2 var = (float2(1.0, 2.0)) * scalar;\n"
    ));
}

TEST(HLSLParser, ParenthesizedConstructorWithAdd)
{
    EXPECT_TRUE(ParseHLSL(
        "float2 var = (float2(1.0, 2.0)) + float2(3.0, 4.0);\n"
    ));
}

TEST(HLSLParser, DoubleNestedParensWithOperator)
{
    EXPECT_TRUE(ParseHLSL(
        "float2 var = ((float2(1.0, 2.0))) * 2.0;\n"
    ));
}

TEST(HLSLParser, BothOperandsParenthesized)
{
    EXPECT_TRUE(ParseHLSL(
        "float2 var = (float2(1.0, 2.0)) * (float2(3.0, 4.0));\n"
    ));
}

TEST(HLSLParser, ChainedOperatorsAfterParens)
{
    EXPECT_TRUE(ParseHLSL(
        "float a = 1.0; float b = 2.0; float c = 3.0;\n"
        "float x = (a) * b + c;\n"
    ));
}

TEST(HLSLParser, ConstructorWithoutParensStillWorks)
{
    EXPECT_TRUE(ParseHLSL(
        "float2 var = float2(1.0, 2.0) * 2.0;\n"
    ));
}

// Regression test for issue #90 / upstream projectM-visualizer/projectm#993:
// "#ifdef"/"#ifndef" were not recognized by the preprocessor, causing chained
// "#define"/"#ifdef"/"#endif" blocks to be merged into malformed tokens
// (e.g. "#ifdef(#defineUSE_POST_PROCESSING)") instead of being evaluated.
TEST(HLSLParser, IfdefWithDefinedMacroKeepsBody)
{
    std::string out;
    ASSERT_TRUE(Preprocess(
        "#define HAS_HEART\n"
        "#define USE_POST_PROCESSING 1\n"
        "#ifdef HAS_HEART\n"
        "float T = 1;\n"
        "#endif\n",
        out));

    EXPECT_NE(out.find("float T = 1;"), std::string::npos);
    EXPECT_EQ(out.find("#ifdef"), std::string::npos);
    EXPECT_EQ(out.find("#endif"), std::string::npos);
}

TEST(HLSLParser, IfdefWithUndefinedMacroDropsBody)
{
    std::string out;
    ASSERT_TRUE(Preprocess(
        "#ifdef NOT_DEFINED\n"
        "float T = 1;\n"
        "#endif\n"
        "float U = 2;\n",
        out));

    EXPECT_EQ(out.find("float T = 1;"), std::string::npos);
    EXPECT_NE(out.find("float U = 2;"), std::string::npos);
}

TEST(HLSLParser, IfndefWithUndefinedMacroKeepsBody)
{
    std::string out;
    ASSERT_TRUE(Preprocess(
        "#ifndef NOT_DEFINED\n"
        "float T = 1;\n"
        "#endif\n",
        out));

    EXPECT_NE(out.find("float T = 1;"), std::string::npos);
}

// An empty "#define" must not swallow the following line's tokens as its value.
TEST(HLSLParser, EmptyDefineDoesNotConsumeNextLine)
{
    std::string out;
    ASSERT_TRUE(Preprocess(
        "#define HAS_HEART\n"
        "#define VALUE 42\n"
        "#ifdef VALUE\n"
        "float V = VALUE;\n"
        "#endif\n",
        out));

    // Macro expansion does not preserve the whitespace before the expanded
    // identifier, so "VALUE" becomes "(42)" with no leading space.
    EXPECT_NE(out.find("float V =(42);"), std::string::npos);
    EXPECT_EQ(out.find("VALUE"), std::string::npos);
}

// Unmatched preprocessor directives must be reported as a preprocessing
// failure, never via assert()/UB on an empty conditional stack.
TEST(HLSLParser, UnmatchedEndifReturnsError)
{
    std::string out;
    EXPECT_FALSE(Preprocess("#endif\nfloat T = 1;\n", out));
}

TEST(HLSLParser, UnmatchedElseReturnsError)
{
    std::string out;
    EXPECT_FALSE(Preprocess("#else\nfloat T = 1;\n", out));
}

TEST(HLSLParser, UnterminatedIfdefReturnsError)
{
    std::string out;
    EXPECT_FALSE(Preprocess("#ifdef SOMETHING\nfloat T = 1;\n", out));
}

TEST(HLSLParser, ElifSelectsActiveBranch)
{
    std::string out;
    ASSERT_TRUE(Preprocess(
        "#if 0\n"
        "float A = 1;\n"
        "#elif 1\n"
        "float B = 2;\n"
        "#else\n"
        "float C = 3;\n"
        "#endif\n",
        out));

    EXPECT_EQ(out.find("float A = 1;"), std::string::npos);
    EXPECT_NE(out.find("float B = 2;"), std::string::npos);
    EXPECT_EQ(out.find("float C = 3;"), std::string::npos);
}
