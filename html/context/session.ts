// context/session.ts
//
// ProjectMContext's lifecycle state: the one boot in flight, and the undo steps
// for everything the context has acquired.
//
//   StartGate      start() is idempotent under concurrency — overlapping calls
//                  share one boot — and teardown aborts it: whatever the boot is
//                  still awaiting gives up, and a continuation that outlives the
//                  context checks the signal before touching anything.
//   TeardownStack  every resource is registered the moment it is acquired, and
//                  released newest first. That is what lets one routine tear
//                  down both a finished context and a half-booted one.
//
// Neither knows what is being booted or released: projectm-context.ts drives
// them, context/connect.ts registers what it wires up.

import { toDisposeFunction } from '../projectm-disposables.js';

/** Something a context can own: a disposer, a `{ dispose }`, or nothing. */
export type Disposable = (() => void) | { dispose(): void } | null | undefined;

/** Runs `dispose`, reporting (not throwing) a failure: one bad step must not stop the rest. */
function runStep(dispose: () => void): void {
    try {
        dispose();
    } catch (error) {
        console.warn('[ProjectMContext] cleanup step failed:', error);
    }
}

/** One boot at a time, shared by every caller that asks while it runs. */
export class StartGate<T> {
    private attempt: AbortController | null = null;
    private pending: Promise<T> | null = null;

    /**
     * The signal of the current attempt: the boot in flight, or the one that
     * finished, until teardown aborts it. Undefined before the first start().
     */
    get signal(): AbortSignal | undefined {
        return this.attempt?.signal;
    }

    /**
     * `run`'s promise, started now unless a boot is already in flight (then its
     * promise). The gate forgets a boot once it settles, so a later start()
     * after a failure starts over.
     */
    start(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
        if (!this.pending) {
            const attempt = new AbortController();
            this.attempt = attempt;
            const promise = run(attempt.signal).finally(() => {
                if (this.pending === promise) {
                    this.pending = null;
                }
            });
            this.pending = promise;
        }
        return this.pending;
    }

    /** Aborts the current attempt (a no-op once it has been aborted). */
    abort(): void {
        this.attempt?.abort();
        this.attempt = null;
    }
}

/** Undo steps, oldest first; run() takes them newest first. */
export class TeardownStack {
    private readonly steps: Array<() => void> = [];

    /**
     * Registers an undo step for something just acquired. It runs at the next
     * run(): when the context is destroyed, or when the start that acquired it
     * fails.
     */
    add(disposable: Disposable): void {
        const dispose = toDisposeFunction(disposable);
        if (dispose) {
            this.steps.push(dispose);
        }
    }

    /**
     * {@link add} for something a host built around the context. On a context
     * that is already destroyed it is disposed at once.
     *
     * @returns `disposable`, so a setup can be owned where it is made.
     */
    adopt<T extends Disposable>(disposable: T, destroyed: boolean): T {
        const dispose = toDisposeFunction(disposable);
        if (!dispose) {
            return disposable;
        }
        if (destroyed) {
            runStep(dispose);
            return disposable;
        }
        this.steps.push(dispose);
        return disposable;
    }

    /** Runs and forgets every step, newest first. A step that throws is reported and skipped. */
    run(): void {
        for (const dispose of this.steps.splice(0).reverse()) {
            runStep(dispose);
        }
    }
}
