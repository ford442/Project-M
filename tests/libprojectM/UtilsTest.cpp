#include <Utils.hpp>

#include <gtest/gtest.h>

#include <limits>

using libprojectM::Utils::ExpressionIsTrue;
using libprojectM::Utils::SaturatingToInt;

TEST(Utils, SaturatingToIntTruncatesInRange)
{
    EXPECT_EQ(SaturatingToInt(2.9, 0, 10), 2);
    EXPECT_EQ(SaturatingToInt(-2.9, -10, 10), -2);
    EXPECT_EQ(SaturatingToInt(0.0, 0, 10), 0);
}

TEST(Utils, SaturatingToIntClampsOutOfRange)
{
    EXPECT_EQ(SaturatingToInt(1e30, 3, 100), 100);
    EXPECT_EQ(SaturatingToInt(-1e30, 3, 100), 3);
    EXPECT_EQ(SaturatingToInt(std::numeric_limits<double>::infinity(), 0, 4), 4);
    EXPECT_EQ(SaturatingToInt(-std::numeric_limits<double>::infinity(), 0, 4), 0);

    constexpr int intMin = std::numeric_limits<int>::min();
    constexpr int intMax = std::numeric_limits<int>::max();
    EXPECT_EQ(SaturatingToInt(1e30, intMin, intMax), intMax);
    EXPECT_EQ(SaturatingToInt(-1e30, intMin, intMax), intMin);
}

TEST(Utils, SaturatingToIntMapsNanToLow)
{
    EXPECT_EQ(SaturatingToInt(std::numeric_limits<double>::quiet_NaN(), 3, 100), 3);
    EXPECT_EQ(SaturatingToInt(-std::numeric_limits<double>::quiet_NaN(), -7, 7), -7);
}

TEST(Utils, ExpressionIsTrueMatchesIntCastForFiniteValues)
{
    for (double value : {-2.5, -1.0, -0.999, 0.0, 0.5, 0.999, 1.0, 7.25})
    {
        EXPECT_EQ(ExpressionIsTrue(value), static_cast<int>(value) != 0) << value;
    }
    EXPECT_FALSE(ExpressionIsTrue(std::numeric_limits<double>::quiet_NaN()));
    EXPECT_TRUE(ExpressionIsTrue(std::numeric_limits<double>::infinity()));
    EXPECT_TRUE(ExpressionIsTrue(1e30));
}
