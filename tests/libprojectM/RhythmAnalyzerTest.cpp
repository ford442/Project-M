/**
 * Tempo, beat-phase, bar and section tests for Audio::RhythmAnalyzer.
 *
 * Every signal is synthesized at test time (no audio fixtures) and goes through the real
 * PCM path: PCM::Add() in frame-sized chunks, PCM::UpdateFrameAudioData() (FFT) and
 * PCM::UpdateRhythmAnalysis(), exactly as ProjectM::RenderFrame() drives it.
 */
#include "Audio/PCM.hpp"

#include <gtest/gtest.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <functional>
#include <random>
#include <sstream>
#include <vector>

using libprojectM::Audio::PCM;
using libprojectM::Audio::RhythmAnalyzer;
using libprojectM::Audio::RhythmInfo;

namespace {

constexpr double kSampleRate = 44100.0;
constexpr double kPi = 3.14159265358979323846;

/** @brief Adds a decaying event into a signal buffer starting at a given time. */
void AddEvent(std::vector<float>& signal, double start, double seconds, const std::function<float(double)>& shape)
{
    const auto first = static_cast<std::int64_t>(std::ceil(start * kSampleRate));
    const auto last = static_cast<std::int64_t>((start + seconds) * kSampleRate);
    for (std::int64_t index = std::max<std::int64_t>(first, 0); index < last && index < static_cast<std::int64_t>(signal.size()); index++)
    {
        signal[static_cast<size_t>(index)] += shape(static_cast<double>(index) / kSampleRate - start);
    }
}

/** @brief A beat section: kick (+click) on the beat, hi-hat on the (optionally swung) off-beat. */
struct Pattern {
    double bpm{120.0};
    double start{0.0};          //!< First beat.
    double end{20.0};           //!< No beats at or after this time.
    double offbeat{0.0};        //!< Off-beat hi-hat position in the beat (0.5 straight, ~0.62 swung), 0 = none.
    double jitterSeconds{0.0};  //!< Gaussian timing jitter of every hit.
    bool accentDownbeat{false}; //!< Louder kick on every fourth beat.
};

void RenderPattern(std::vector<float>& signal, const Pattern& pattern, std::mt19937& random)
{
    std::normal_distribution<double> jitter(0.0, pattern.jitterSeconds > 0.0 ? pattern.jitterSeconds : 1e-12);
    std::uniform_real_distribution<float> noise(-1.0f, 1.0f);
    const double period = 60.0 / pattern.bpm;

    int beat = 0;
    for (double time = pattern.start; time < pattern.end; time = pattern.start + (++beat) * period)
    {
        const float level = pattern.accentDownbeat && beat % 4 == 0 ? 0.9f : 0.55f;
        const double kickTime = time + (pattern.jitterSeconds > 0.0 ? jitter(random) : 0.0);
        AddEvent(signal, kickTime, 0.25, [level, &noise, &random](double t) {
            // Pitch drops from 180 Hz to 50 Hz over the first ~50 ms, like a typical kick drum.
            const double body = std::sin(2.0 * kPi * (50.0 * t + 130.0 * 0.03 * (1.0 - std::exp(-t / 0.03)))) * std::exp(-t / 0.09);
            const double click = noise(random) * std::exp(-t / 0.004) * 0.5;
            return static_cast<float>(level * (body + click));
        });

        if (pattern.offbeat > 0.0)
        {
            const double hatTime = time + pattern.offbeat * period + (pattern.jitterSeconds > 0.0 ? jitter(random) : 0.0);
            float previous = 0.0f;
            AddEvent(signal, hatTime, 0.08, [&previous, &noise, &random](double t) {
                // First difference of white noise: a crude high-pass.
                const float white = noise(random);
                const float hat = (white - previous) * 0.5f;
                previous = white;
                return static_cast<float>(0.22 * hat * std::exp(-t / 0.02));
            });
        }
    }
}

/** @brief A sustained chord, to put tonal material between the hits. */
void RenderPad(std::vector<float>& signal, double start, double end, std::initializer_list<double> frequencies, float level)
{
    AddEvent(signal, start, end - start, [frequencies, level](double t) {
        double sum = 0.0;
        for (const double frequency : frequencies)
        {
            sum += std::sin(2.0 * kPi * frequency * t);
        }
        return static_cast<float>(level * sum / static_cast<double>(frequencies.size()));
    });
}

struct FrameRecord {
    double time;
    RhythmInfo info;
};

struct RunOptions {
    double fps{60.0};
    double frameJitter{0.0}; //!< Relative random variation of each frame duration.
    float tempoHint{0.0f};
    unsigned seed{7};
};

/** @brief Feeds a signal through PCM frame by frame, as ProjectM::RenderFrame() does. */
auto Analyze(const std::vector<float>& signal, const RunOptions& options = {}) -> std::vector<FrameRecord>
{
    PCM pcm;
    if (options.tempoHint > 0.0f)
    {
        pcm.SetRhythmHint(options.tempoHint);
    }

    std::mt19937 random(options.seed);
    std::uniform_real_distribution<double> frameJitter(-options.frameJitter, options.frameJitter);

    std::vector<FrameRecord> frames;
    double time = 0.0;
    size_t fed = 0;
    std::uint32_t frame = 0;
    const double duration = static_cast<double>(signal.size()) / kSampleRate;
    while (true)
    {
        const double dt = (1.0 / options.fps) * (1.0 + frameJitter(random));
        if (time + dt > duration)
        {
            break;
        }
        time += dt;
        const auto until = static_cast<size_t>(time * kSampleRate);
        if (until > fed)
        {
            pcm.Add(signal.data() + fed, 1, until - fed);
            fed = until;
        }
        pcm.UpdateFrameAudioData(dt, frame++);
        pcm.UpdateRhythmAnalysis(dt);
        frames.push_back({time, pcm.GetFrameAudioData().rhythm});
    }
    return frames;
}

/** @brief Times the beat clock wrapped, interpolated between frames. */
auto PredictedBeats(const std::vector<FrameRecord>& frames, double from) -> std::vector<double>
{
    std::vector<double> beats;
    for (size_t index = 1; index < frames.size(); index++)
    {
        const auto& previous = frames[index - 1];
        const auto& current = frames[index];
        if (current.info.beatIndex == previous.info.beatIndex || current.time < from)
        {
            continue;
        }
        // The clock covered (1 - previous phase) + current phase over this frame.
        const double before = 1.0 - static_cast<double>(previous.info.beatPhase);
        const double after = static_cast<double>(current.info.beatPhase);
        const double share = before + after > 0.0 ? before / (before + after) : 1.0;
        beats.push_back(previous.time + share * (current.time - previous.time));
    }
    return beats;
}

/** @brief Signed distance of each predicted beat from the nearest beat of the grid. */
auto PhaseErrors(const std::vector<double>& beats, double gridStart, double bpm) -> std::vector<double>
{
    const double period = 60.0 / bpm;
    std::vector<double> errors;
    for (const double beat : beats)
    {
        const double position = (beat - gridStart) / period;
        errors.push_back((position - std::round(position)) * period);
    }
    return errors;
}

auto MeanAbsolute(const std::vector<double>& values) -> double
{
    double sum = 0.0;
    for (const double value : values)
    {
        sum += std::fabs(value);
    }
    return values.empty() ? 0.0 : sum / static_cast<double>(values.size());
}

auto Trace(const std::vector<FrameRecord>& frames, double step = 0.5) -> std::string
{
    std::ostringstream out;
    double next = 0.0;
    for (const auto& frame : frames)
    {
        if (frame.time >= next)
        {
            out << "t=" << frame.time << " bpm=" << frame.info.bpm << " conf=" << frame.info.confidence
                << " phase=" << frame.info.beatPhase << " beat#=" << frame.info.beatIndex << "\n";
            next += step;
        }
    }
    return out.str();
}

struct TempoCase {
    double bpm;
    double offbeat;
    double jitter;
};

auto operator<<(std::ostream& stream, const TempoCase& tempoCase) -> std::ostream&
{
    return stream << tempoCase.bpm << " BPM, off-beat " << tempoCase.offbeat << ", jitter " << tempoCase.jitter * 1000.0 << " ms";
}

class RhythmTempoTest : public ::testing::TestWithParam<TempoCase>
{
};

} // namespace

TEST_P(RhythmTempoTest, LocksTempoAndPhaseAfterWarmup)
{
    const auto& tempoCase = GetParam();
    constexpr double duration = 20.0;
    constexpr double warmup = 4.0;
    constexpr double firstBeat = 0.137;

    std::mt19937 random(static_cast<unsigned>(tempoCase.bpm * 10));
    std::vector<float> signal(static_cast<size_t>(duration * kSampleRate), 0.0f);
    RenderPad(signal, 0.0, duration, {220.0, 277.2, 329.6}, 0.05f);
    RenderPattern(signal, {tempoCase.bpm, firstBeat, duration, tempoCase.offbeat, tempoCase.jitter, false}, random);

    const auto frames = Analyze(signal);

    int confident = 0;
    int evaluated = 0;
    double worstBpmError = 0.0;
    for (const auto& frame : frames)
    {
        if (frame.time < warmup)
        {
            continue;
        }
        evaluated++;
        if (frame.info.confidence >= RhythmAnalyzer::ConfidenceThreshold)
        {
            confident++;
            worstBpmError = std::max(worstBpmError, std::fabs(static_cast<double>(frame.info.bpm) - tempoCase.bpm));
        }
    }

    EXPECT_EQ(confident, evaluated) << "not confident on every frame after the warm-up\n"
                                    << Trace(frames);
    EXPECT_LE(worstBpmError, 1.0) << Trace(frames);

    const auto errors = PhaseErrors(PredictedBeats(frames, warmup), firstBeat, tempoCase.bpm);
    ASSERT_GE(errors.size(), static_cast<size_t>((duration - warmup) * tempoCase.bpm / 60.0) - 1);
    double meanSigned = 0.0;
    for (const double error : errors)
    {
        meanSigned += error;
    }
    meanSigned /= static_cast<double>(errors.size());
    RecordProperty("mean_abs_phase_error_ms", std::to_string(MeanAbsolute(errors) * 1000.0));
    RecordProperty("mean_phase_error_ms", std::to_string(meanSigned * 1000.0));
    RecordProperty("worst_bpm_error", std::to_string(worstBpmError));
    EXPECT_LT(MeanAbsolute(errors), 0.020) << Trace(frames);
    for (const double error : errors)
    {
        EXPECT_LT(std::fabs(error), 0.040);
    }
}

INSTANTIATE_TEST_SUITE_P(ClickTracks, RhythmTempoTest,
                         ::testing::Values(TempoCase{90.0, 0.0, 0.0},
                                           TempoCase{120.0, 0.0, 0.0},
                                           TempoCase{128.0, 0.0, 0.0},
                                           TempoCase{174.0, 0.0, 0.0},
                                           // Swung off-beat hats and +-5 ms (1 sigma) timing jitter on every hit.
                                           TempoCase{90.0, 0.64, 0.005},
                                           TempoCase{120.0, 0.62, 0.005},
                                           TempoCase{128.0, 0.5, 0.005},
                                           TempoCase{174.0, 0.6, 0.005}));

TEST(RhythmAnalyzer, ConvergesAfterTempoChange)
{
    constexpr double duration = 24.0;
    constexpr double change = 10.0;

    std::mt19937 random(3);
    std::vector<float> signal(static_cast<size_t>(duration * kSampleRate), 0.0f);
    RenderPad(signal, 0.0, duration, {196.0, 246.9, 293.7}, 0.05f);
    RenderPattern(signal, {120.0, 0.137, change, 0.5, 0.003, false}, random);
    RenderPattern(signal, {140.0, change + 0.05, duration, 0.5, 0.003, false}, random);

    const auto frames = Analyze(signal);

    double converged = -1.0;
    for (const auto& frame : frames)
    {
        const bool locked = std::fabs(static_cast<double>(frame.info.bpm) - 140.0) <= 1.0;
        if (frame.time >= change && locked && converged < 0.0)
        {
            converged = frame.time;
        }
        else if (!locked)
        {
            converged = -1.0;
        }
    }
    ASSERT_GE(converged, change) << Trace(frames);
    EXPECT_LT(converged - change, 4.0) << Trace(frames);

    const auto errors = PhaseErrors(PredictedBeats(frames, change + 4.0), change + 0.05, 140.0);
    EXPECT_LT(MeanAbsolute(errors), 0.020) << Trace(frames);
}

TEST(RhythmAnalyzer, SilenceHasNoConfidenceAndNoTempo)
{
    std::vector<float> signal(static_cast<size_t>(10.0 * kSampleRate), 0.0f);
    const auto frames = Analyze(signal);
    for (const auto& frame : frames)
    {
        EXPECT_EQ(frame.info.bpm, 0.0f);
        EXPECT_LT(frame.info.confidence, 0.01f);
        EXPECT_FALSE(frame.info.beat);
        EXPECT_EQ(frame.info.beatPulse, 0.0f);
        EXPECT_EQ(frame.info.onset, 0.0f);
        EXPECT_EQ(frame.info.rms, 0.0f);
    }
}

TEST(RhythmAnalyzer, ConfidenceDropsWhenMusicStops)
{
    constexpr double musicEnd = 10.0;
    constexpr double duration = 16.0;

    std::mt19937 random(5);
    std::vector<float> signal(static_cast<size_t>(duration * kSampleRate), 0.0f);
    RenderPattern(signal, {125.0, 0.1, musicEnd, 0.5, 0.0, false}, random);

    const auto frames = Analyze(signal);
    for (const auto& frame : frames)
    {
        if (frame.time > musicEnd - 1.0 && frame.time < musicEnd)
        {
            EXPECT_GE(frame.info.confidence, RhythmAnalyzer::ConfidenceThreshold);
        }
        if (frame.time >= musicEnd + 1.5)
        {
            EXPECT_EQ(frame.info.bpm, 0.0f) << "at t=" << frame.time;
            EXPECT_FALSE(frame.info.beat);
        }
        if (frame.time >= musicEnd + 5.0)
        {
            EXPECT_LT(frame.info.confidence, 0.05f) << "at t=" << frame.time;
        }
    }
}

TEST(RhythmAnalyzer, IndependentOfFrameRate)
{
    constexpr double duration = 16.0;
    constexpr double bpm = 128.0;
    constexpr double firstBeat = 0.21;

    std::mt19937 random(11);
    std::vector<float> signal(static_cast<size_t>(duration * kSampleRate), 0.0f);
    RenderPad(signal, 0.0, duration, {220.0, 261.6, 329.6}, 0.05f);
    RenderPattern(signal, {bpm, firstBeat, duration, 0.5, 0.004, false}, random);

    struct Rate {
        double fps;
        double jitter;
    };
    for (const Rate rate : {Rate{30.0, 0.0}, Rate{144.0, 0.0}, Rate{60.0, 0.3}})
    {
        RunOptions options;
        options.fps = rate.fps;
        options.frameJitter = rate.jitter;
        const auto frames = Analyze(signal, options);

        double worstBpmError = 0.0;
        for (const auto& frame : frames)
        {
            if (frame.time >= 4.0)
            {
                EXPECT_GE(frame.info.confidence, RhythmAnalyzer::ConfidenceThreshold) << rate.fps << " fps";
                worstBpmError = std::max(worstBpmError, std::fabs(static_cast<double>(frame.info.bpm) - bpm));
            }
        }
        EXPECT_LE(worstBpmError, 1.0) << rate.fps << " fps, jitter " << rate.jitter;

        const auto errors = PhaseErrors(PredictedBeats(frames, 4.0), firstBeat, bpm);
        EXPECT_LT(MeanAbsolute(errors), 0.020) << rate.fps << " fps, jitter " << rate.jitter << "\n"
                                               << Trace(frames);
    }
}

TEST(RhythmAnalyzer, TempoHintOverridesEstimate)
{
    constexpr double duration = 12.0;
    constexpr double firstBeat = 0.3;

    std::mt19937 random(13);
    std::vector<float> signal(static_cast<size_t>(duration * kSampleRate), 0.0f);
    RenderPattern(signal, {100.0, firstBeat, duration, 0.0, 0.0, false}, random);

    RunOptions options;
    options.tempoHint = 100.0f;
    const auto frames = Analyze(signal, options);
    for (const auto& frame : frames)
    {
        EXPECT_EQ(frame.info.bpm, 100.0f);
        EXPECT_EQ(frame.info.confidence, 1.0f);
    }

    // The hint fixes the tempo; the phase still locks to the audio.
    const auto errors = PhaseErrors(PredictedBeats(frames, 4.0), firstBeat, 100.0);
    EXPECT_LT(MeanAbsolute(errors), 0.020) << Trace(frames);
}

TEST(RhythmAnalyzer, HintCanBeCleared)
{
    PCM pcm;
    pcm.SetRhythmHint(97.0f);
    EXPECT_EQ(pcm.RhythmHint(), 97.0f);
    pcm.SetRhythmHint(0.0f);
    EXPECT_EQ(pcm.RhythmHint(), 0.0f);
    pcm.SetRhythmHint(-5.0f);
    EXPECT_EQ(pcm.RhythmHint(), 0.0f);
}

TEST(RhythmAnalyzer, BeatPulseFiresOnBeatFramesAndDecays)
{
    constexpr double duration = 10.0;
    std::mt19937 random(17);
    std::vector<float> signal(static_cast<size_t>(duration * kSampleRate), 0.0f);
    RenderPattern(signal, {120.0, 0.1, duration, 0.0, 0.0, false}, random);

    const auto frames = Analyze(signal);
    int beats = 0;
    for (size_t index = 1; index < frames.size(); index++)
    {
        const auto& frame = frames[index];
        if (frame.info.beat)
        {
            beats++;
            EXPECT_EQ(frame.info.beatPulse, 1.0f);
            EXPECT_GT(frame.info.beatIndex, frames[index - 1].info.beatIndex);
        }
        else if (frame.time > 4.0)
        {
            EXPECT_LT(frame.info.beatPulse, frames[index - 1].info.beatPulse + 1e-6f);
        }
        EXPECT_GE(frame.info.beatPhase, 0.0f);
        EXPECT_LT(frame.info.beatPhase, 1.0f);
        EXPECT_GE(frame.info.barPhase, 0.0f);
        EXPECT_LT(frame.info.barPhase, 1.0f);
    }
    // ~2 beats a second once confident.
    EXPECT_GE(beats, 14);
    EXPECT_LE(beats, 20);
}

TEST(RhythmAnalyzer, FindsAccentedDownbeat)
{
    constexpr double duration = 24.0;
    constexpr double firstBeat = 0.25;
    constexpr double bpm = 120.0;

    std::mt19937 random(19);
    std::vector<float> signal(static_cast<size_t>(duration * kSampleRate), 0.0f);
    RenderPattern(signal, {bpm, firstBeat, duration, 0.5, 0.0, true}, random);

    const auto frames = Analyze(signal);

    // Bars start on beats 0, 4, 8, ... of the pattern, the accented ones.
    int bars = 0;
    int onDownbeat = 0;
    const double period = 60.0 / bpm;
    for (const auto& frame : frames)
    {
        if (frame.time < 12.0 || !frame.info.bar)
        {
            continue;
        }
        bars++;
        const double beatTime = frame.time - static_cast<double>(frame.info.beatPhase) * period;
        const auto beat = static_cast<long>(std::lround((beatTime - firstBeat) / period));
        if (beat % 4 == 0)
        {
            onDownbeat++;
        }
    }
    EXPECT_GE(bars, 5);
    EXPECT_EQ(onDownbeat, bars);
}

TEST(RhythmAnalyzer, DetectsSectionChange)
{
    constexpr double change = 30.0;
    constexpr double duration = 60.0;

    std::mt19937 random(23);
    std::vector<float> signal(static_cast<size_t>(duration * kSampleRate), 0.0f);
    // Verse: low pad, kick only. Chorus: bright pad, kick and hats.
    RenderPad(signal, 0.0, change, {110.0, 138.6, 164.8}, 0.12f);
    RenderPattern(signal, {124.0, 0.2, change, 0.0, 0.002, false}, random);
    RenderPad(signal, change, duration, {880.0, 1108.7, 1318.5, 1760.0}, 0.12f);
    RenderPattern(signal, {124.0, change + 0.2, duration, 0.5, 0.002, false}, random);

    const auto frames = Analyze(signal);

    std::vector<double> changes;
    int lastSection = 0;
    for (const auto& frame : frames)
    {
        if (frame.info.sectionChanged)
        {
            changes.push_back(frame.time);
            EXPECT_EQ(frame.info.section, lastSection + 1);
        }
        lastSection = frame.info.section;
    }
    ASSERT_EQ(changes.size(), 1U);
    EXPECT_GT(changes[0], change);
    EXPECT_LT(changes[0], change + 4.0);
}

TEST(RhythmAnalyzer, DescriptorsTrackSpectralShape)
{
    constexpr double duration = 2.0;
    std::vector<float> tone(static_cast<size_t>(duration * kSampleRate), 0.0f);
    RenderPad(tone, 0.0, duration, {440.0}, 0.5f);

    std::vector<float> noise(static_cast<size_t>(duration * kSampleRate), 0.0f);
    std::mt19937 random(29);
    std::uniform_real_distribution<float> white(-0.5f, 0.5f);
    for (auto& sample : noise)
    {
        sample = white(random);
    }

    const auto toneInfo = Analyze(tone).back().info;
    const auto noiseInfo = Analyze(noise).back().info;

    EXPECT_LT(toneInfo.flatness, 0.1f);
    EXPECT_GT(noiseInfo.flatness, 0.3f);
    EXPECT_LT(toneInfo.centroid, noiseInfo.centroid);
    EXPECT_NEAR(toneInfo.rms, 0.5f / std::sqrt(2.0f), 0.02f);
    EXPECT_NEAR(noiseInfo.rms, 0.5f / std::sqrt(3.0f), 0.03f);
    for (const auto& info : {toneInfo, noiseInfo})
    {
        EXPECT_GE(info.centroid, 0.0f);
        EXPECT_LE(info.centroid, 1.0f);
        EXPECT_GE(info.onset, 0.0f);
        EXPECT_LE(info.onset, 1.0f);
    }
}
