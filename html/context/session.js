// GENERATED from session.ts by scripts/build_html_ts.mjs — do not edit.
// Edit the .ts, then run `npm run build:html` (CI: npm run check:html-build).
import { toDisposeFunction } from '../projectm-disposables.js';
function runStep(dispose) {
    try {
        dispose();
    } catch (error) {
        console.warn('[ProjectMContext] cleanup step failed:', error);
    }
}
export class StartGate {
    constructor() {
        this.attempt = null;
        this.pending = null;
    }
    /**
     * The signal of the current attempt: the boot in flight, or the one that
     * finished, until teardown aborts it. Undefined before the first start().
     */
    get signal() {
        return this.attempt?.signal;
    }
    /**
     * `run`'s promise, started now unless a boot is already in flight (then its
     * promise). The gate forgets a boot once it settles, so a later start()
     * after a failure starts over.
     */
    start(run) {
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
    abort() {
        this.attempt?.abort();
        this.attempt = null;
    }
}
export class TeardownStack {
    constructor() {
        this.steps = [];
    }
    /**
     * Registers an undo step for something just acquired. It runs at the next
     * run(): when the context is destroyed, or when the start that acquired it
     * fails.
     */
    add(disposable) {
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
    adopt(disposable, destroyed) {
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
    run() {
        for (const dispose of this.steps.splice(0).reverse()) {
            runStep(dispose);
        }
    }
}
