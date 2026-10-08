#include "Audio/RhythmAnalyzer.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace libprojectM {
namespace Audio {

namespace {

constexpr double kPi = 3.14159265358979323846;

// Onset detection. Bins are FftSize-point FFT bins, so at 44.1 kHz one bin is ~43 Hz.
constexpr float kLogGain = 0.4f;          //!< Log compression: log(1 + kLogGain * |X|). A full-scale sine peaks at |X| = 256.
constexpr int kLowBegin = 1;              //!< ~43 Hz; bin 0 (DC) is ignored.
constexpr int kLowEnd = 5;                //!< ~215 Hz.
constexpr int kMidEnd = 47;               //!< ~2 kHz.
constexpr int kHighEnd = 256;             //!< ~11 kHz.
constexpr float kOnsetFloor = 0.05f;      //!< Smallest peak the normalized onsets are scaled against.
constexpr double kOnsetPeakSeconds = 3.0; //!< Decay of the onset normalization peak.
constexpr double kOnsetLatency = 0.010;   //!< How late the rising edge of an onset reaches the envelope (~one hop).

// Time base.
constexpr double kMaxFrameSeconds = 1.0; //!< A longer frame (stall, hidden tab) only advances this much.
constexpr double kMaxHopGap = 0.5;       //!< Longer gaps between hops (no audio) are filled with silence.
constexpr double kAudioTimeout = 0.25;   //!< Without new samples for this long, the audio counts as silent.

// Tempo.
constexpr double kEnvelopeMeanSeconds = 1.5;    //!< Running mean removed from the onset envelope.
constexpr double kAutocorrelationSeconds = 2.5; //!< Time constant of the weighted autocorrelation.
constexpr double kTempoUpdateSeconds = 0.25;    //!< Tempo comb evaluation interval.
constexpr double kFirstTempoSeconds = 1.5;      //!< Envelope needed before the first estimate.
constexpr float kBpmStep = 0.5f;                //!< Tempo comb candidate spacing.
constexpr int kCombHarmonics = 4;               //!< Lags tau, 2 tau, 3 tau, 4 tau.
constexpr float kOffbeatPenalty = 0.5f;         //!< Weight of the half-period teeth, see EstimateTempo().
constexpr float kPriorCenterBpm = 130.0f;       //!< Log-Gaussian tempo prior center...
constexpr float kPriorOctaves = 1.0f;           //!< ...and width. See the constructor.
constexpr float kPeriodicityLow = 0.02f;        //!< Comb contrast mapped to periodicity 0...
constexpr float kPeriodicityHigh = 0.15f;       //!< ...and to periodicity 1.
constexpr double kSmallTempoChange = 0.04;      //!< Relative change followed smoothly.
constexpr double kTempoSmoothing = 0.35;        //!< Per update, for small changes.
constexpr int kTempoJumpConfirmations = 3;      //!< Updates a larger change must persist for.

// Beat clock.
constexpr double kPhaseUpdateSeconds = 0.05; //!< Phase measurement interval.
constexpr double kPhaseRecencySeconds = 1.5; //!< Age weighting of onsets in the phase histogram.
constexpr double kPhaseGain = 0.2;           //!< Share of the measured phase error corrected per measurement.
constexpr double kPulseSeconds = 0.1;        //!< beatPulse decay.

// Bars.
constexpr double kAccentWindow = 0.15; //!< Beat phase distance in which a low onset counts as the beat's accent.
constexpr float kAccentSmoothing = 0.15f;
constexpr float kDownbeatContrast = 1.2f;   //!< Strongest position must beat the average by this much...
constexpr float kDownbeatHysteresis = 1.1f; //!< ...and the current downbeat by this much.

// Descriptors and confidence.
constexpr double kDescriptorSeconds = 0.05;
constexpr double kRmsSeconds = 0.3;
constexpr double kConfidenceSeconds = 0.4;
constexpr float kSilentRms = 0.003f; //!< ~-50 dBFS: no confidence below.
constexpr float kActiveRms = 0.015f; //!< ~-36 dBFS: full confidence above.

// Sections.
constexpr double kSectionHopSeconds = 0.25;
constexpr int kRecentHops = 12;     //!< 3 s.
constexpr int kReferenceHops = 32;  //!< 8 s before that.
constexpr int kMinSectionHops = 32; //!< At most one section change per 8 s.
constexpr double kNoveltyStatsSeconds = 30.0;
constexpr double kNoveltyDeviations = 4.0;
constexpr double kNoveltyFloor = 0.15;
constexpr int kSectionBandEdges[] = {1, 2, 3, 5, 8, 13, 23, 38, 64, 108, 181, 304, 512};

auto Smoothstep(float edge0, float edge1, float x) -> float
{
    const float t = std::clamp((x - edge0) / (edge1 - edge0), 0.0f, 1.0f);
    return t * t * (3.0f - 2.0f * t);
}

/** @brief Wraps a phase difference to [-0.5, 0.5). */
auto WrapSigned(double phase) -> double
{
    return phase - std::floor(phase + 0.5);
}

/** @brief Share of the remaining distance an exponential follower covers in dt. */
auto FollowRate(double dt, double timeConstant) -> double
{
    return 1.0 - std::exp(-dt / timeConstant);
}

auto NormalizeOnset(float value, float& peak, double dt) -> float
{
    peak = std::max({value, peak * static_cast<float>(std::exp(-dt / kOnsetPeakSeconds)), kOnsetFloor});
    return std::min(1.0f, value / peak);
}

auto CandidateBpm(int index) -> float
{
    return RhythmAnalyzer::MinBpm + static_cast<float>(index) * kBpmStep;
}

} // namespace

RhythmAnalyzer::RhythmAnalyzer()
{
    static_assert(TempoCandidates == static_cast<int>((MaxBpm - MinBpm) / kBpmStep) + 1, "TempoCandidates must cover MinBpm..MaxBpm");
    static_assert(static_cast<int>(sizeof(kSectionBandEdges) / sizeof(kSectionBandEdges[0])) == SectionBands + 1,
                  "One more section band edge than bands");
    static_assert(kSectionBandEdges[SectionBands] <= Bins, "Section bands exceed the spectrum");
    static_assert(kHighEnd <= Bins, "Onset bands exceed the spectrum");
    static_assert((Bins & (Bins - 1)) == 0, "The FFT needs a power of two");

    for (int index = 0; index < FftSize; index++)
    {
        m_hann[index] = static_cast<float>(0.5 - 0.5 * std::cos(2.0 * kPi * index / FftSize));
    }

    int bits = 0;
    while ((1 << bits) < Bins)
    {
        bits++;
    }
    for (int index = 0; index < Bins; index++)
    {
        int reversed = 0;
        for (int bit = 0; bit < bits; bit++)
        {
            reversed |= ((index >> bit) & 1) << (bits - 1 - bit);
        }
        m_bitReverse[index] = reversed;
    }
    for (int index = 0; index < Bins / 2; index++)
    {
        m_twiddleCos[index] = static_cast<float>(std::cos(2.0 * kPi * index / Bins));
        m_twiddleSin[index] = static_cast<float>(std::sin(2.0 * kPi * index / Bins));
    }
    for (int index = 0; index < Bins; index++)
    {
        m_unpackCos[index] = static_cast<float>(std::cos(2.0 * kPi * index / FftSize));
        m_unpackSin[index] = static_cast<float>(std::sin(2.0 * kPi * index / FftSize));
    }

    for (int age = 0; age < PhaseWindow; age++)
    {
        m_recencyWeights[age] = static_cast<float>(std::exp(-static_cast<double>(age) / (EnvelopeRate * kPhaseRecencySeconds)));
    }

    // Ellis (2007) weights tempi with a log-Gaussian around a preferred tempo. Here it mostly
    // breaks the tie between a periodicity and its double: a plain click track has comb
    // peaks of the same height at both. Centered at 130 BPM, one octave wide, the faster of
    // the two wins up to ~184 BPM (174 rather than 87, 120 rather than 60) and the slower
    // above it (100 rather than 200).
    for (int index = 0; index < TempoCandidates; index++)
    {
        const double octaves = std::log2(static_cast<double>(CandidateBpm(index)) / kPriorCenterBpm) / kPriorOctaves;
        m_tempoPrior[index] = static_cast<float>(std::exp(-0.5 * octaves * octaves));
    }

    Reset();
}

void RhythmAnalyzer::Reset()
{
    m_samples.fill(0.0f);
    m_samplePosition = 0;
    m_samplesSinceHop = 0;
    m_magnitudes.fill(0.0f);

    m_previousLog.fill(0.0f);
    m_havePreviousSpectrum = false;
    m_frameOnset = 0.0f;
    m_frameLow = 0.0f;
    m_frameMid = 0.0f;
    m_frameHigh = 0.0f;
    m_hopThisFrame = false;
    m_onsetPeak = 0.0f;
    m_onsetLowPeak = 0.0f;
    m_onsetMidPeak = 0.0f;
    m_onsetHighPeak = 0.0f;

    m_envelope.assign(2 * HistorySize, 0.0f);
    m_rise.assign(HistorySize, 0.0f);
    m_previousEnvelope = 0.0f;
    m_envelopeCount = 0;
    m_envelopeMean = 0.0;
    m_time = 0.0;
    m_previousHopTime = 0.0;
    m_previousHopOnset = 0.0f;
    m_lastAudioTime = -1.0;

    m_autocorrelation.fill(0.0f);
    m_nextTempoUpdate = 0.0;
    m_tempoPeriod = 0.5;
    m_haveTempo = false;
    m_pendingPeriod = 0.0;
    m_pendingCount = 0;
    m_periodicity = 0.0f;
    m_activeHint = 0.0f;

    m_phase = 0.0;
    m_nextPhaseUpdate = 0.0;
    m_beatIndex = 0;

    m_accent.fill(0.0f);
    m_accentWindow = 0.0f;
    m_downbeatOffset = 0;

    m_rmsSlow = 0.0f;
    m_confidence = 0.0f;
    m_centroid = 0.0f;
    m_flatness = 0.0f;

    m_sectionAccumulator.fill(0.0f);
    m_sectionAccumulatedTime = 0.0;
    m_sectionAccumulatedHops = 0;
    m_sectionFeatures.assign(SectionHistory, {});
    m_sectionHopCount = 0;
    m_lastSectionHop = 0;
    m_noveltyMean = 0.0;
    m_noveltyVariance = 0.0;
    m_noveltyArmed = true;

    m_info = RhythmInfo{};
}

void RhythmAnalyzer::SetTempoHint(float bpm)
{
    m_tempoHint.store(bpm > 0.0f ? std::clamp(bpm, 1.0f, 1000.0f) : 0.0f, std::memory_order_relaxed);
}

auto RhythmAnalyzer::TempoHint() const -> float
{
    return m_tempoHint.load(std::memory_order_relaxed);
}

auto RhythmAnalyzer::Info() const -> const RhythmInfo&
{
    return m_info;
}

void RhythmAnalyzer::Update(const float* samples, std::size_t sampleCount, double secondsSinceLastFrame)
{
    const double dt = std::isfinite(secondsSinceLastFrame) ? std::clamp(secondsSinceLastFrame, 0.0, kMaxFrameSeconds) : 0.0;

    m_info.beat = false;
    m_info.bar = false;
    m_info.sectionChanged = false;

    const float hint = m_tempoHint.load(std::memory_order_relaxed);
    if (hint != m_activeHint)
    {
        m_activeHint = hint;
        if (hint > 0.0f)
        {
            SetTempoPeriod(60.0 / static_cast<double>(hint));
        }
        // Clearing the hint keeps the current period until the comb has something better.
    }

    // Spread the new samples evenly over the frame: sample i of n arrived at
    // frameStart + dt * (i + 1) / n, so the newest one is "now".
    const double frameStart = m_time;
    m_time += dt;
    m_hopThisFrame = false;
    if (samples != nullptr && sampleCount > 0)
    {
        m_lastAudioTime = m_time;
        const double secondsPerSample = dt / static_cast<double>(sampleCount);
        for (std::size_t index = 0; index < sampleCount; index++)
        {
            m_samples[m_samplePosition] = samples[index];
            m_samplePosition = (m_samplePosition + 1) % FftSize;
            if (++m_samplesSinceHop >= HopSamples)
            {
                m_samplesSinceHop = 0;
                AnalyzeHop(frameStart + secondsPerSample * static_cast<double>(index + 1));
            }
        }
    }

    const float rms = WindowRms();
    if (dt > 0.0)
    {
        if (m_activeHint <= 0.0f && m_time >= m_nextTempoUpdate)
        {
            m_nextTempoUpdate = m_time + kTempoUpdateSeconds;
            EstimateTempo();
        }

        m_rmsSlow += static_cast<float>(FollowRate(dt, kRmsSeconds)) * (rms - m_rmsSlow);
        const float activity = Smoothstep(kSilentRms, kActiveRms, m_rmsSlow);
        m_confidence += static_cast<float>(FollowRate(dt, kConfidenceSeconds)) * (m_periodicity * activity - m_confidence);
    }
    if (m_activeHint > 0.0f)
    {
        // The host knows the tempo; nothing to be unsure about.
        m_confidence = 1.0f;
    }

    AdvanceClock(dt, m_frameLow);

    const bool confident = m_confidence >= ConfidenceThreshold;

    m_info.onset = NormalizeOnset(m_frameOnset, m_onsetPeak, dt);
    m_info.onsetLow = NormalizeOnset(m_frameLow, m_onsetLowPeak, dt);
    m_info.onsetMid = NormalizeOnset(m_frameMid, m_onsetMidPeak, dt);
    m_info.onsetHigh = NormalizeOnset(m_frameHigh, m_onsetHighPeak, dt);
    m_info.centroid = m_centroid;
    m_info.flatness = m_flatness;
    m_info.rms = rms;
    m_info.confidence = m_confidence;
    m_info.bpm = confident ? static_cast<float>(60.0 / m_tempoPeriod) : 0.0f;

    // Single precision would round a phase a hair below 1 up to exactly 1.
    constexpr float belowOne = 1.0f - std::numeric_limits<float>::epsilon();
    m_info.beatPhase = std::min(static_cast<float>(m_phase), belowOne);
    m_info.beatIndex = m_beatIndex;

    const auto barPosition = static_cast<int>((m_beatIndex + BeatsPerBar - m_downbeatOffset) % BeatsPerBar);
    m_info.barPhase = std::min(static_cast<float>((static_cast<double>(barPosition) + m_phase) / BeatsPerBar), belowOne);
    if (m_info.beat)
    {
        m_info.bar = barPosition == 0;
    }
}

auto RhythmAnalyzer::WindowRms() const -> float
{
    if (m_lastAudioTime < 0.0 || m_time - m_lastAudioTime > kAudioTimeout)
    {
        return 0.0f;
    }
    float sumSquares = 0.0f;
    for (const float sample : m_samples)
    {
        sumSquares += sample * sample;
    }
    return std::sqrt(sumSquares / static_cast<float>(FftSize));
}

void RhythmAnalyzer::ComputeMagnitudes()
{
    // Real FFT of FftSize samples through a complex FFT of half the size: even samples go
    // into the real part, odd ones into the imaginary part, and the two interleaved spectra
    // are separated afterwards. The ring's oldest sample is at m_samplePosition.
    for (int index = 0; index < Bins; index++)
    {
        const int even = 2 * index;
        const int target = m_bitReverse[index];
        m_fftReal[target] = m_samples[(m_samplePosition + even) % FftSize] * m_hann[even];
        m_fftImaginary[target] = m_samples[(m_samplePosition + even + 1) % FftSize] * m_hann[even + 1];
    }

    for (int size = 2; size <= Bins; size <<= 1)
    {
        const int half = size / 2;
        const int step = Bins / size;
        for (int start = 0; start < Bins; start += size)
        {
            for (int offset = 0; offset < half; offset++)
            {
                const float twiddleReal = m_twiddleCos[offset * step];
                const float twiddleImaginary = -m_twiddleSin[offset * step];
                const int top = start + offset;
                const int bottom = top + half;
                const float real = twiddleReal * m_fftReal[bottom] - twiddleImaginary * m_fftImaginary[bottom];
                const float imaginary = twiddleReal * m_fftImaginary[bottom] + twiddleImaginary * m_fftReal[bottom];
                m_fftReal[bottom] = m_fftReal[top] - real;
                m_fftImaginary[bottom] = m_fftImaginary[top] - imaginary;
                m_fftReal[top] += real;
                m_fftImaginary[top] += imaginary;
            }
        }
    }

    // X[k] = E[k] + exp(-2 pi i k / N) O[k], with E = (Z[k] + conj Z[M-k]) / 2 and
    // O = (Z[k] - conj Z[M-k]) / 2i.
    for (int bin = 0; bin < Bins; bin++)
    {
        const int mirror = (Bins - bin) % Bins;
        const float zReal = m_fftReal[bin];
        const float zImaginary = m_fftImaginary[bin];
        const float mirrorReal = m_fftReal[mirror];
        const float mirrorImaginary = -m_fftImaginary[mirror];
        const float evenReal = 0.5f * (zReal + mirrorReal);
        const float evenImaginary = 0.5f * (zImaginary + mirrorImaginary);
        const float oddReal = 0.5f * (zImaginary - mirrorImaginary);
        const float oddImaginary = -0.5f * (zReal - mirrorReal);
        const float twiddleReal = m_unpackCos[bin];
        const float twiddleImaginary = -m_unpackSin[bin];
        const float real = evenReal + twiddleReal * oddReal - twiddleImaginary * oddImaginary;
        const float imaginary = evenImaginary + twiddleReal * oddImaginary + twiddleImaginary * oddReal;
        m_magnitudes[bin] = std::sqrt(real * real + imaginary * imaginary);
    }
}

void RhythmAnalyzer::AnalyzeHop(double time)
{
    ComputeMagnitudes();

    // Half-wave rectified flux: only rising energy is an onset.
    float low = 0.0f;
    float mid = 0.0f;
    float high = 0.0f;
    auto flux = [this](int begin, int end) {
        float sum = 0.0f;
        for (int bin = begin; bin < end; bin++)
        {
            const float logMagnitude = std::log1p(kLogGain * m_magnitudes[bin]);
            sum += std::max(0.0f, logMagnitude - m_previousLog[bin]);
            m_previousLog[bin] = logMagnitude;
        }
        // Mean per bin, so the wide high band does not drown out the four low bins.
        return sum / static_cast<float>(end - begin);
    };
    low = flux(kLowBegin, kLowEnd);
    mid = flux(kLowEnd, kMidEnd);
    high = flux(kMidEnd, kHighEnd);
    if (!m_havePreviousSpectrum)
    {
        // Nothing to compare the first spectrum against; all of it would read as an onset.
        m_havePreviousSpectrum = true;
        low = 0.0f;
        mid = 0.0f;
        high = 0.0f;
    }
    const float onset = low + mid + high;

    // Resample onto the fixed envelope grid (sample k at k / EnvelopeRate), linearly
    // interpolating between this hop and the previous one.
    const double hopSeconds = std::max(0.0, time - m_previousHopTime);
    const bool gap = hopSeconds > kMaxHopGap;
    while (static_cast<double>(m_envelopeCount) / EnvelopeRate <= time)
    {
        const double sampleTime = static_cast<double>(m_envelopeCount) / EnvelopeRate;
        if (gap && time - sampleTime > 1.0 / EnvelopeRate)
        {
            // No audio for a while: fill with silence (at most one history's worth matters).
            if (time - sampleTime > HistorySize / EnvelopeRate)
            {
                m_envelopeCount = static_cast<std::uint64_t>(std::floor((time - HistorySize / EnvelopeRate) * EnvelopeRate)) + 1;
                continue;
            }
            PushEnvelopeSample(0.0f);
            continue;
        }
        const double blend = hopSeconds > 0.0 && !gap ? std::clamp((sampleTime - m_previousHopTime) / hopSeconds, 0.0, 1.0) : 1.0;
        PushEnvelopeSample(m_previousHopOnset + (onset - m_previousHopOnset) * static_cast<float>(blend));
    }
    m_previousHopTime = time;
    m_previousHopOnset = onset;

    ComputeDescriptors(hopSeconds);
    AccumulateSectionFeatures(hopSeconds);

    if (!m_hopThisFrame)
    {
        m_hopThisFrame = true;
        m_frameOnset = onset;
        m_frameLow = low;
        m_frameMid = mid;
        m_frameHigh = high;
    }
    else
    {
        m_frameOnset = std::max(m_frameOnset, onset);
        m_frameLow = std::max(m_frameLow, low);
        m_frameMid = std::max(m_frameMid, mid);
        m_frameHigh = std::max(m_frameHigh, high);
    }
}

void RhythmAnalyzer::ComputeDescriptors(double hopSeconds)
{
    double magnitudeSum = 0.0;
    double weightedSum = 0.0;
    double powerSum = 0.0;
    for (int bin = 1; bin < Bins; bin++)
    {
        const double magnitude = m_magnitudes[bin];
        magnitudeSum += magnitude;
        weightedSum += magnitude * bin;
        powerSum += magnitude * magnitude;
    }

    float centroid = 0.0f;
    float flatness = 0.0f;
    constexpr double silentMagnitudeSum = 1e-3; // Roughly -100 dBFS spread over the spectrum.
    if (magnitudeSum > silentMagnitudeSum)
    {
        centroid = static_cast<float>(weightedSum / magnitudeSum / Bins);

        // Geometric over arithmetic mean of the power spectrum. The floor is relative, so
        // the measure does not depend on the signal level.
        constexpr int bins = Bins - 1;
        const double meanPower = powerSum / bins;
        const double floor = meanPower * 1e-6 + 1e-20;
        double logSum = 0.0;
        for (int bin = 1; bin < Bins; bin++)
        {
            const double magnitude = m_magnitudes[bin];
            logSum += std::log(magnitude * magnitude + floor);
        }
        flatness = static_cast<float>(std::clamp(std::exp(logSum / bins) / (meanPower + floor), 0.0, 1.0));
    }

    const auto rate = static_cast<float>(hopSeconds > 0.0 ? FollowRate(hopSeconds, kDescriptorSeconds) : 1.0);
    m_centroid += rate * (centroid - m_centroid);
    m_flatness += rate * (flatness - m_flatness);
}

void RhythmAnalyzer::PushEnvelopeSample(float value)
{
    static const double meanRate = FollowRate(1.0 / EnvelopeRate, kEnvelopeMeanSeconds);
    static const auto autocorrelationRate = static_cast<float>(FollowRate(1.0 / EnvelopeRate, kAutocorrelationSeconds));

    m_envelopeMean += meanRate * (value - m_envelopeMean);
    const auto sample = static_cast<float>(value - m_envelopeMean);

    const auto index = static_cast<int>(m_envelopeCount % HistorySize);
    m_envelope[index] = sample;
    m_envelope[index + HistorySize] = sample;
    m_rise[index] = std::max(0.0f, value - m_previousEnvelope);
    m_previousEnvelope = value;
    m_envelopeCount++;

    // Exponentially weighted autocorrelation, one envelope sample at a time:
    //   r[lag] = (1 - a) * r[lag] + a * x[n] * x[n - lag]
    // The doubled history makes x[n - lag] a contiguous, descending read.
    const float* newest = &m_envelope[index + HistorySize];
    const float keep = 1.0f - autocorrelationRate;
    const float scaled = autocorrelationRate * sample;
    for (int lag = 0; lag <= MaxLag; lag++)
    {
        m_autocorrelation[lag] = keep * m_autocorrelation[lag] + scaled * newest[-lag];
    }
}

void RhythmAnalyzer::EstimateTempo()
{
    if (static_cast<double>(m_envelopeCount) < kFirstTempoSeconds * EnvelopeRate || m_autocorrelation[0] <= 1e-12f)
    {
        m_periodicity = 0.0f;
        return;
    }

    // Normalize to r[0] and smooth slightly, so onset jitter of a hop or two still lands on a
    // peak.
    //
    // Lag L only starts accumulating L samples in, so early on the long lags hold less weight
    // than the short ones, and the comb would favor fast tempi (whose teeth are all short
    // lags) until the history fills up. Dividing each lag by the weight it has had time to
    // gather removes that warm-up bias.
    const double elapsed = static_cast<double>(m_envelopeCount);
    const double samplesPerTimeConstant = kAutocorrelationSeconds * EnvelopeRate;
    auto coverage = [elapsed, samplesPerTimeConstant](int lag) {
        return 1.0 - std::exp(-std::max(0.0, elapsed - lag) / samplesPerTimeConstant);
    };
    const double coverageAtZero = coverage(0);
    std::array<float, MaxLag + 1> normalized{};
    const float inverseEnergy = 1.0f / m_autocorrelation[0];
    normalized[0] = 1.0f;
    for (int lag = 1; lag <= MaxLag; lag++)
    {
        const float smoothed = lag < MaxLag
                                   ? 0.25f * m_autocorrelation[lag - 1] + 0.5f * m_autocorrelation[lag] + 0.25f * m_autocorrelation[lag + 1]
                                   : m_autocorrelation[lag];
        // Lags with under a fifth of the weight are left out rather than amplified.
        const double lagCoverage = coverage(lag);
        normalized[lag] = lagCoverage > 0.2 * coverageAtZero ? smoothed * inverseEnergy * static_cast<float>(coverageAtZero / lagCoverage) : 0.0f;
    }

    auto interpolate = [&normalized](double lag) {
        const auto lower = static_cast<int>(lag);
        if (lower < 0 || lower >= MaxLag)
        {
            return 0.0f;
        }
        const auto fraction = static_cast<float>(lag - lower);
        return normalized[lower] * (1.0f - fraction) + normalized[lower + 1] * fraction;
    };

    // Comb: a tempo explains the envelope if it correlates with itself one, two, three and
    // four beats later. Requiring all four suppresses the octave below (which only explains
    // every other comb tooth of the true tempo) and sharpens the estimate, since the fourth
    // tooth locates the period four times more precisely than the first.
    //
    // Half a period off each tooth, the envelope should *not* correlate: if it does just as
    // well there, the candidate is half the true tempo. A click on every beat scores the same
    // on both combs otherwise, and only the prior would keep 174 BPM from reading as 87.
    // An accented beat with weaker off-beats (kick and hi-hat) correlates less at the half
    // period than at the full one, so the slower tempo still wins there.
    std::array<float, TempoCandidates> raw{};
    std::array<float, TempoCandidates> weighted{};
    float rawSum = 0.0f;
    int best = 0;
    for (int index = 0; index < TempoCandidates; index++)
    {
        const double lag = 60.0 / CandidateBpm(index) * EnvelopeRate;
        float score = 0.0f;
        for (int harmonic = 1; harmonic <= kCombHarmonics; harmonic++)
        {
            score += interpolate(lag * harmonic) - kOffbeatPenalty * interpolate(lag * (harmonic - 0.5));
        }
        score /= static_cast<float>(kCombHarmonics);
        raw[index] = score;
        weighted[index] = score * m_tempoPrior[index];
        rawSum += score;
        if (weighted[index] > weighted[best])
        {
            best = index;
        }
    }

    const float contrast = raw[best] - rawSum / static_cast<float>(TempoCandidates);
    m_periodicity = Smoothstep(kPeriodicityLow, kPeriodicityHigh, contrast);
    if (m_periodicity <= 0.0f)
    {
        return;
    }

    // Parabolic interpolation between the candidates.
    double offset = 0.0;
    if (best > 0 && best < TempoCandidates - 1)
    {
        const double left = weighted[best - 1];
        const double center = weighted[best];
        const double right = weighted[best + 1];
        const double denominator = left - 2.0 * center + right;
        if (denominator < 0.0)
        {
            offset = std::clamp(0.5 * (left - right) / denominator, -0.5, 0.5);
        }
    }

    const double bpm = static_cast<double>(MinBpm) + (static_cast<double>(best) + offset) * kBpmStep;
    AdoptTempoEstimate(60.0 / bpm);
}

void RhythmAnalyzer::AdoptTempoEstimate(double period)
{
    if (!m_haveTempo)
    {
        SetTempoPeriod(period);
        return;
    }

    if (std::fabs(period - m_tempoPeriod) < kSmallTempoChange * m_tempoPeriod)
    {
        m_tempoPeriod += kTempoSmoothing * (period - m_tempoPeriod);
        m_pendingCount = 0;
        return;
    }

    // A jump (tempo change, or an octave flip on ambiguous material) has to repeat before it
    // is believed.
    if (m_pendingCount > 0 && std::fabs(period - m_pendingPeriod) < kSmallTempoChange * m_pendingPeriod)
    {
        m_pendingPeriod = 0.5 * (m_pendingPeriod + period);
        m_pendingCount++;
    }
    else
    {
        m_pendingPeriod = period;
        m_pendingCount = 1;
    }

    if (m_pendingCount >= kTempoJumpConfirmations)
    {
        SetTempoPeriod(m_pendingPeriod);
        m_pendingCount = 0;
    }
}

void RhythmAnalyzer::SetTempoPeriod(double period)
{
    m_tempoPeriod = period;
    m_haveTempo = true;
}

auto RhythmAnalyzer::MeasurePhaseError() -> double
{
    const int available = static_cast<int>(std::min<std::uint64_t>(m_envelopeCount, PhaseWindow));
    if (available < static_cast<int>(EnvelopeRate))
    {
        return 0.0;
    }

    // Fold the recent onsets onto the beat clock: where would the clock, running at its
    // current period, have been when each onset happened? Onsets on the beat pile up at the
    // same phase. The rising edge of the envelope is folded rather than the envelope itself:
    // flux keeps coming for a few hops after an attack whose spectrum keeps moving (a
    // pitch-dropping kick), which would pull the beat late by however long that takes.
    //
    // Extrapolating the *current* clock backwards (instead of remembering the phase at the
    // time) means the histogram always measures the clock as it is now, so a correction
    // shows up in the very next measurement and the loop cannot oscillate.
    std::array<double, PhaseBins> histogram{};
    const double period = m_tempoPeriod;
    const std::uint64_t newest = m_envelopeCount - 1;
    for (int age = 0; age < available; age++)
    {
        const std::uint64_t sample = newest - static_cast<std::uint64_t>(age);
        const float value = m_rise[sample % HistorySize];
        if (value <= 0.0f)
        {
            continue;
        }
        const double sampleAge = m_time - static_cast<double>(sample) / EnvelopeRate;
        double phase = m_phase - sampleAge / period;
        phase -= std::floor(phase);
        const double position = phase * PhaseBins;
        const auto bin = static_cast<int>(position) % PhaseBins;
        const double fraction = position - std::floor(position);
        const double weight = static_cast<double>(value) * m_recencyWeights[age];
        histogram[bin] += weight * (1.0 - fraction);
        histogram[(bin + 1) % PhaseBins] += weight * fraction;
    }

    std::array<double, PhaseBins> smoothed{};
    int best = 0;
    for (int bin = 0; bin < PhaseBins; bin++)
    {
        smoothed[bin] = (histogram[(bin + PhaseBins - 2) % PhaseBins] + 4.0 * histogram[(bin + PhaseBins - 1) % PhaseBins] +
                         6.0 * histogram[bin] + 4.0 * histogram[(bin + 1) % PhaseBins] + histogram[(bin + 2) % PhaseBins]) /
                        16.0;
        if (smoothed[bin] > smoothed[best])
        {
            best = bin;
        }
    }
    if (smoothed[best] <= 1e-9)
    {
        return 0.0;
    }

    // Centroid around the peak for sub-bin precision.
    double weightedOffset = 0.0;
    double total = 0.0;
    for (int offset = -3; offset <= 3; offset++)
    {
        const double value = smoothed[(best + offset + PhaseBins) % PhaseBins];
        weightedOffset += value * offset;
        total += value;
    }
    const double peakPhase = (best + weightedOffset / total) / PhaseBins;

    // Onsets reach the envelope a little late, so the clock should read slightly past zero
    // when they arrive.
    return WrapSigned(peakPhase - kOnsetLatency / period);
}

void RhythmAnalyzer::AdvanceClock(double dt, float lowOnset)
{
    if (dt <= 0.0)
    {
        return;
    }

    const double previousPhase = m_phase;
    double phase = m_phase + dt / m_tempoPeriod;

    if (m_haveTempo && m_time >= m_nextPhaseUpdate)
    {
        m_nextPhaseUpdate = m_time + kPhaseUpdateSeconds;
        m_phase = phase; // MeasurePhaseError() reads the clock at m_time.
        phase -= kPhaseGain * MeasurePhaseError();
    }

    // A correction may pull the clock back across zero. Holding it at zero instead of
    // wrapping backwards keeps every beat counted exactly once; the clock simply waits
    // for the beat.
    phase = std::max(phase, 0.0);

    // Accent of the beat around zero phase, for downbeat detection.
    if (phase >= 1.0 - kAccentWindow || phase - std::floor(phase) < kAccentWindow)
    {
        m_accentWindow = std::max(m_accentWindow, lowOnset);
    }

    if (phase >= 1.0)
    {
        const double wraps = std::floor(phase);
        phase -= wraps;
        m_beatIndex += static_cast<std::uint64_t>(wraps);
        if (m_confidence >= ConfidenceThreshold)
        {
            m_info.beat = true;
            m_info.beatPulse = 1.0f;
        }
    }
    else if (previousPhase < 0.5 && phase >= 0.5)
    {
        // Half a beat after the beat: its accent window has closed.
        UpdateDownbeat();
    }

    if (!m_info.beat)
    {
        m_info.beatPulse = m_confidence >= ConfidenceThreshold ? m_info.beatPulse * static_cast<float>(std::exp(-dt / kPulseSeconds)) : 0.0f;
    }

    m_phase = phase;
}

void RhythmAnalyzer::UpdateDownbeat()
{
    const auto position = static_cast<int>(m_beatIndex % BeatsPerBar);
    m_accent[position] += kAccentSmoothing * (m_accentWindow - m_accent[position]);
    m_accentWindow = 0.0f;

    if (m_confidence < ConfidenceThreshold)
    {
        return;
    }

    int strongest = 0;
    float sum = 0.0f;
    for (int candidate = 0; candidate < BeatsPerBar; candidate++)
    {
        sum += m_accent[candidate];
        if (m_accent[candidate] > m_accent[strongest])
        {
            strongest = candidate;
        }
    }
    const float mean = sum / BeatsPerBar;
    const auto current = static_cast<int>(m_downbeatOffset % BeatsPerBar);
    if (strongest != current && m_accent[strongest] > kDownbeatContrast * mean &&
        m_accent[strongest] > kDownbeatHysteresis * m_accent[current])
    {
        m_downbeatOffset = static_cast<std::uint64_t>(strongest);
    }
}

void RhythmAnalyzer::AccumulateSectionFeatures(double hopSeconds)
{
    for (int band = 0; band < SectionBands; band++)
    {
        const int begin = kSectionBandEdges[band];
        const int end = kSectionBandEdges[band + 1];
        float sum = 0.0f;
        for (int bin = begin; bin < end; bin++)
        {
            sum += m_magnitudes[bin];
        }
        m_sectionAccumulator[band] += std::log1p(kLogGain * sum / static_cast<float>(end - begin));
    }
    m_sectionAccumulatedHops++;
    m_sectionAccumulatedTime += hopSeconds;

    if (m_sectionAccumulatedTime < kSectionHopSeconds)
    {
        return;
    }

    auto& feature = m_sectionFeatures[m_sectionHopCount % SectionHistory];
    for (int band = 0; band < SectionBands; band++)
    {
        feature[band] = m_sectionAccumulator[band] / static_cast<float>(m_sectionAccumulatedHops);
    }
    m_sectionHopCount++;
    m_sectionAccumulator.fill(0.0f);
    m_sectionAccumulatedHops = 0;
    m_sectionAccumulatedTime = std::min(m_sectionAccumulatedTime - kSectionHopSeconds, kSectionHopSeconds);

    EvaluateSectionNovelty();
}

void RhythmAnalyzer::EvaluateSectionNovelty()
{
    if (m_sectionHopCount < static_cast<std::uint64_t>(kRecentHops + kReferenceHops))
    {
        return;
    }

    // Box-kernel novelty: how far the last 3 s are from the 8 s before them.
    std::array<double, SectionBands> recent{};
    std::array<double, SectionBands> reference{};
    for (int hop = 0; hop < kRecentHops + kReferenceHops; hop++)
    {
        const auto& feature = m_sectionFeatures[(m_sectionHopCount - 1 - static_cast<std::uint64_t>(hop)) % SectionHistory];
        auto& target = hop < kRecentHops ? recent : reference;
        for (int band = 0; band < SectionBands; band++)
        {
            target[band] += feature[band];
        }
    }
    double distance = 0.0;
    for (int band = 0; band < SectionBands; band++)
    {
        const double difference = recent[band] / kRecentHops - reference[band] / kReferenceHops;
        distance += difference * difference;
    }
    const double novelty = std::sqrt(distance / SectionBands);

    const double threshold = std::max(kNoveltyFloor, m_noveltyMean + kNoveltyDeviations * std::sqrt(m_noveltyVariance));
    const bool active = m_rmsSlow >= kSilentRms;
    const bool spaced = m_sectionHopCount - m_lastSectionHop >= static_cast<std::uint64_t>(kMinSectionHops) || m_info.section == 0;

    if (m_noveltyArmed && active && spaced && novelty > threshold)
    {
        m_info.section++;
        m_info.sectionChanged = true;
        m_lastSectionHop = m_sectionHopCount;
        m_noveltyArmed = false;
    }
    else if (novelty < 0.7 * threshold)
    {
        m_noveltyArmed = true;
    }

    // Running statistics of the novelty curve; a fast start so the first threshold is not 0.
    const auto evaluated = static_cast<double>(m_sectionHopCount - static_cast<std::uint64_t>(kRecentHops + kReferenceHops) + 1);
    const double rate = std::max(1.0 / evaluated, kSectionHopSeconds / kNoveltyStatsSeconds);
    const double deviation = novelty - m_noveltyMean;
    m_noveltyMean += rate * deviation;
    m_noveltyVariance = (1.0 - rate) * (m_noveltyVariance + rate * deviation * deviation);
}

} // namespace Audio
} // namespace libprojectM
