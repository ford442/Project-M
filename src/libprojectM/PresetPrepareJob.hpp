/**
 * @file PresetPrepareJob.hpp
 * @brief One preset load, split so its CPU-side half can run on another thread.
 */
#pragma once

#include "PreparedPreset.hpp"

#include <memory>
#include <string>

namespace libprojectM {

class PresetFactoryManager;

/**
 * @brief A preset load in three steps: begin on the render thread, run anywhere, load on the render thread.
 *
 * ProjectM::BeginPreparePresetFile() / BeginPreparePresetData() create the job and capture the
 * render-thread state preparation needs. Run() reads, parses and analyses the preset and transpiles
 * its shaders; it touches neither GL nor the ProjectM instance, so it may run on a worker thread while
 * the render thread keeps drawing, and the job stays valid even if the instance is destroyed. Then
 * ProjectM::LoadPreparedPreset() instantiates and initializes the preset on the render thread and
 * starts the transition, or raises the preset switch failed event with the error Run() recorded.
 */
class PresetPrepareJob
{
public:
    /**
     * @brief Creates a job that loads a preset file or URL, as ProjectM::LoadPresetFile() does.
     * @param factories The preset factories. Shared so the job outlives the instance if it has to.
     * @param context Render-thread state captured for this preparation.
     * @param filename The preset filename or URL.
     * @return The job.
     */
    static auto FromFile(std::shared_ptr<const PresetFactoryManager> factories,
                         PresetPrepareContext context,
                         std::string filename) -> std::unique_ptr<PresetPrepareJob>;

    /**
     * @brief Creates a job that loads preset data in Milkdrop format, as ProjectM::LoadPresetData() does.
     * @param factories The preset factories.
     * @param context Render-thread state captured for this preparation.
     * @param data The preset data.
     * @return The job.
     */
    static auto FromData(std::shared_ptr<const PresetFactoryManager> factories,
                         PresetPrepareContext context,
                         std::string data) -> std::unique_ptr<PresetPrepareJob>;

    PresetPrepareJob(const PresetPrepareJob&) = delete;
    auto operator=(const PresetPrepareJob&) -> PresetPrepareJob& = delete;

    ~PresetPrepareJob();

    /**
     * @brief Does the CPU-side work. Any thread; only one thread at a time per job. Runs at most once.
     */
    void Run();

    /**
     * @brief Whether Run() has completed.
     */
    auto HasRun() const -> bool;

    /**
     * @brief Whether Run() failed, in which case Error() says why.
     */
    auto Failed() const -> bool;

    /**
     * @brief The failure message, in the form the preset switch failed event reports it.
     */
    auto Error() const -> const std::string&;

    /**
     * @brief The filename or URL the job loads; empty for preset data.
     */
    auto Filename() const -> const std::string&;

    /**
     * @brief Hands over the prepared preset. Null before Run(), after a failure, or where the
     *        factory declines the URL (ProjectM then leaves the current preset in place).
     */
    auto TakePreparedPreset() -> std::unique_ptr<PreparedPreset>;

private:
    PresetPrepareJob(std::shared_ptr<const PresetFactoryManager> factories, PresetPrepareContext context,
                     std::string filename, std::string data, bool fromData);

    std::shared_ptr<const PresetFactoryManager> m_factories; //!< Factories doing the preparation.
    PresetPrepareContext m_context;                          //!< Render-thread state for the preparation.
    std::string m_filename;                                  //!< Filename or URL, empty for data.
    std::string m_data;                                      //!< Preset data, if loading from memory.
    bool m_fromData{false};                                  //!< True if loading m_data rather than m_filename.

    bool m_hasRun{false};                     //!< Whether Run() completed.
    std::string m_error;                      //!< Failure message, if Run() failed.
    bool m_failed{false};                     //!< Whether Run() failed.
    std::unique_ptr<PreparedPreset> m_result; //!< The prepared preset.
};

} // namespace libprojectM
