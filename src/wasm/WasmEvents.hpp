// WasmEvents.hpp
//
// Engine-to-page events never run inside engine code (ABI v2, #352 B).
//
// Every page callback the engine raises (pmOnPerfFrame, pmOnRhythmEvent,
// pmOnGovernor*, pmOnPresetSwitchFailed, pmReportInitError, pmHideInitError,
// pmSetPerfHudEnabled, pmOnTranspiledShaderStored, pmOnLog) goes through
// PostEvent(). While engine code is on the stack (an export's barrier, the
// render loop's tick, a preset-activation timer) the event is queued, tagged
// with the host it names; the queue is drained when the outermost of those
// returns, after the frame or the export has finished with its host. Each
// handler runs in its own try/catch.
//
// So a handler may call any export, including destroy_host() on the host the
// event names: nothing below it on the stack is still using that host.
// destroy_host() drops the events still queued for the host it destroys.
//
// The queue is a JavaScript object on the Module (Module.pmEventQueue,
// installed by the first PostEvent() on the main runtime thread). On a pthread
// there is no page and no queue: the js_* notification delivers to that
// worker's globals directly, as before.
//
// See docs/WASM_JS_API.md ("Events are delivered after the frame").
#pragma once

namespace WasmEvents {

// Marks engine code as running on this thread for the scope's lifetime.
// Scopes nest; when the outermost one ends, the events queued under it are
// delivered. WasmApiDetail::RunGuarded() (every export's barrier) and the
// render loop's tick open one.
class EngineCallScope
{
public:
    EngineCallScope() noexcept;
    ~EngineCallScope();

    EngineCallScope(const EngineCallScope&) = delete;
    EngineCallScope(EngineCallScope&&) = delete;
    auto operator=(const EngineCallScope&) -> EngineCallScope& = delete;
    auto operator=(EngineCallScope&&) -> EngineCallScope& = delete;
};

// Installs the page-side queue on this thread, once. Only the main runtime
// thread (the page, or the render worker that owns the module) has one.
void PrepareQueue() noexcept;

// After a js_* notification queued an event: delivers the queue now if no
// engine code is on the stack, else marks it for the outermost scope's end.
void EventPosted() noexcept;

// Delivers every queued event, in order. Safe to call re-entrantly from a
// handler (the outer delivery picks up what the inner call would have).
void Drain() noexcept;

// Drops the events still queued for the host whose event handle is
// `eventHandle` (destroy_host()).
void DropHostEvents(double eventHandle) noexcept;

// Engine code is on this thread's stack.
bool InsideEngine() noexcept;

} // namespace WasmEvents

// Raises a page event: `notify` is a call to one of the js_* notifications,
// each of which hands its handler to Module.pmEventQueue when there is one.
template<typename Notify>
void PostEvent(Notify&& notify)
{
    WasmEvents::PrepareQueue();
    notify();
    WasmEvents::EventPosted();
}
