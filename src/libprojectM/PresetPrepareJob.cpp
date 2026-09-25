#include "PresetPrepareJob.hpp"

#include "PresetFactoryManager.hpp"

#include <sstream>
#include <utility>

namespace libprojectM {

auto PresetPrepareJob::FromFile(std::shared_ptr<const PresetFactoryManager> factories,
                                PresetPrepareContext context,
                                std::string filename) -> std::unique_ptr<PresetPrepareJob>
{
    return std::unique_ptr<PresetPrepareJob>(new PresetPrepareJob(std::move(factories), std::move(context),
                                                                  std::move(filename), {}, false));
}

auto PresetPrepareJob::FromData(std::shared_ptr<const PresetFactoryManager> factories,
                                PresetPrepareContext context,
                                std::string data) -> std::unique_ptr<PresetPrepareJob>
{
    return std::unique_ptr<PresetPrepareJob>(new PresetPrepareJob(std::move(factories), std::move(context),
                                                                  {}, std::move(data), true));
}

PresetPrepareJob::PresetPrepareJob(std::shared_ptr<const PresetFactoryManager> factories, PresetPrepareContext context,
                                   std::string filename, std::string data, bool fromData)
    : m_factories(std::move(factories))
    , m_context(std::move(context))
    , m_filename(std::move(filename))
    , m_data(std::move(data))
    , m_fromData(fromData)
{
}

PresetPrepareJob::~PresetPrepareJob() = default;

void PresetPrepareJob::Run()
{
    if (m_hasRun)
    {
        return;
    }

    try
    {
        if (m_fromData)
        {
            std::istringstream presetData(m_data);
            m_result = m_factories->PreparePresetFromStream(".milk", presetData, m_context);
        }
        else
        {
            m_result = m_factories->PreparePresetFromFile(m_filename, m_context);
        }
    }
    catch (const std::exception& ex)
    {
        m_failed = true;
        m_error = ex.what();
        m_result.reset();
    }

    // The preset text has been parsed; free it now rather than when the job is loaded.
    m_data.clear();
    m_data.shrink_to_fit();
    m_hasRun = true;
}

auto PresetPrepareJob::HasRun() const -> bool
{
    return m_hasRun;
}

auto PresetPrepareJob::Failed() const -> bool
{
    return m_failed;
}

auto PresetPrepareJob::Error() const -> const std::string&
{
    return m_error;
}

auto PresetPrepareJob::Filename() const -> const std::string&
{
    return m_filename;
}

auto PresetPrepareJob::TakePreparedPreset() -> std::unique_ptr<PreparedPreset>
{
    return std::move(m_result);
}

} // namespace libprojectM
