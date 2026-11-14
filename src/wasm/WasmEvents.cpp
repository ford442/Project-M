// WasmEvents.cpp
//
// The page-event queue (see WasmEvents.hpp).
#include "WasmEvents.hpp"

#include <emscripten.h>
#include <emscripten/threading.h>

// One FIFO for the module, each entry tagged with the host its event names
// (null for events about no host: pmOnLog). Draining takes entries from the
// front until it is empty, so events a handler raises are delivered in the
// same pass, after the ones already queued. A handler that throws is reported
// and the rest still run.
// clang-format off
EM_JS(void, js_event_queue_install, (), {
    if (Module['pmEventQueue']) {
        return;
    }
    const queue = {
        items: [],
        draining: false,
        post(host, deliver) {
            queue.items.push({ host: host, deliver: deliver });
        },
        drain() {
            if (queue.draining) {
                return;
            }
            queue.draining = true;
            try {
                while (queue.items.length > 0) {
                    const entry = queue.items.shift();
                    try {
                        entry.deliver();
                    } catch (e) {
                        console.error('[projectM] page event handler threw:', e);
                    }
                }
            } finally {
                queue.draining = false;
            }
        },
        drop(host) {
            queue.items = queue.items.filter((entry) => entry.host !== host);
        },
    };
    Module['pmEventQueue'] = queue;
});

EM_JS(void, js_event_queue_drain, (), {
    const queue = Module['pmEventQueue'];
    if (queue) {
        queue.drain();
    }
});

EM_JS(void, js_event_queue_drop, (double host), {
    const queue = Module['pmEventQueue'];
    if (queue) {
        queue.drop(host);
    }
});
// clang-format on

namespace WasmEvents {

namespace {

// Per thread: a pthread's scopes never hold the main thread's queue back.
thread_local int t_engineDepth = 0;
thread_local bool t_eventsPending = false;
thread_local bool t_queueInstalled = false;

} // namespace

EngineCallScope::EngineCallScope() noexcept
{
    ++t_engineDepth;
}

EngineCallScope::~EngineCallScope()
{
    if (--t_engineDepth == 0 && t_eventsPending)
    {
        Drain();
    }
}

void PrepareQueue() noexcept
{
    if (t_queueInstalled || !emscripten_is_main_runtime_thread())
    {
        return;
    }
    t_queueInstalled = true;
    js_event_queue_install();
}

void EventPosted() noexcept
{
    if (t_engineDepth > 0)
    {
        t_eventsPending = true;
        return;
    }
    Drain();
}

void Drain() noexcept
{
    t_eventsPending = false;
    if (t_queueInstalled)
    {
        js_event_queue_drain();
    }
}

void DropHostEvents(double eventHandle) noexcept
{
    if (t_queueInstalled)
    {
        js_event_queue_drop(eventHandle);
    }
}

bool InsideEngine() noexcept
{
    return t_engineDepth > 0;
}

} // namespace WasmEvents
