// projectm-app-shell-ui.js
//
// The DOM half of the first-party page shell (projectm-app-shell.js): the
// circular control panel's knob, button pulse, show/hide, beat LED and splash,
// the canvas layout for bezel / full-window mode, the status toast, and the
// optional extras a profile turns on (keyboard shortcuts, WASM version picker,
// local-preset drop zone, external-player launchers, the PCM test sender's
// debug panel).
//
// Buttons say what they do with `data-pm-action="<name>"`; one delegated click
// listener on the document dispatches to the shell's actions. That replaced
// inline `onclick="lockPreset()"` handlers, which on projectm-core.html named
// functions that only existed inside its module script and so threw a
// ReferenceError on every click.
//
// Nothing here touches the engine. Everything it adds — listeners, timers,
// elements — goes on one Disposables list, so dispose() leaves the page as the
// markup shipped it.

import { createDisposables } from './projectm-disposables.js';

/**
 * @typedef {import('./projectm-disposables.js').Disposables} Disposables
 * @typedef {Record<string, (() => void) | undefined>} ShellActions
 *
 * @typedef {object} ShellLauncher A small fixed button for an external audio source.
 * @property {string} id
 * @property {string} label
 * @property {string} title
 * @property {() => void} open
 *
 * @typedef {object} ShellUiOptions
 * @property {Window & typeof globalThis} [windowRef]
 * @property {ShellActions} actions What `data-pm-action` buttons and shortcuts call.
 * @property {string[]} [chromeIds] Elements faded out with the panel.
 * @property {boolean} [keyboard] Space / L / H / A / Escape shortcuts.
 * @property {number} [splashMs] When the splash images come down without an engine.
 * @property {() => boolean} [isBezelMode]
 * @property {() => void} [onBezelLayout] Called after a bezel-mode layout (the bezel redraw).
 * @property {(event: Event) => void} [onContextMenuCustom] Right-click on #customMilkBtn.
 *
 * @typedef {object} ShellUi
 * @property {() => void} hidePanel
 * @property {() => void} showPanel
 * @property {() => void} updateLayout Positions #contain1 / #circle for the current mode.
 * @property {() => void} sizeCanvases Backing-store size before an engine owns the canvases.
 * @property {() => void} hideSplash
 * @property {(message: string, tone?: 'error' | 'warn', ms?: number) => void} showStatus
 * @property {(locked: boolean) => void} setLocked
 * @property {(bezel: boolean) => void} setBezel
 * @property {(enabled: boolean) => void} setTransparency
 * @property {(options: LocalPresetDropOptions) => void} enableLocalPresetDrop
 * @property {(launchers: ShellLauncher[]) => void} addLaunchers
 * @property {(options: WasmPickerOptions) => () => void} setupWasmPicker Returns a re-render,
 *   for when the caller learns about more versions.
 * @property {(sender: { start(useMic?: boolean): unknown, stop(): void }) => void} addTestSenderPanel
 * @property {Disposables} owned Lets the shell hang its own DOM work on the same list.
 * @property {() => void} dispose
 *
 * @typedef {object} LocalPresetDropOptions
 * @property {(file: File) => void} onFile
 * @property {() => string} lastLabel
 *
 * @typedef {object} WasmPickerOptions
 * @property {() => string[]} versions
 * @property {() => string} active
 * @property {(version: string) => void} onChange
 */

const STATUS_TONES = {
    error: { background: 'rgba(127, 29, 29, 0.92)', color: '#fecaca', border: '1px solid rgba(248,113,113,0.5)' },
    warn: { background: 'rgba(120, 53, 15, 0.92)', color: '#fde68a', border: '1px solid rgba(245,158,11,0.5)' },
};

/**
 * @param {Document} documentRef
 * @param {ShellUiOptions} options
 * @returns {ShellUi}
 */
export function setupShellUi(documentRef, options) {
    const {
        windowRef = /** @type {Window & typeof globalThis} */ (documentRef.defaultView ?? window),
        actions,
        chromeIds = [],
        keyboard = false,
        splashMs = 5200,
        isBezelMode = () => true,
        onBezelLayout,
        onContextMenuCustom,
    } = options;
    const owned = createDisposables({ label: 'projectM shell UI' });
    const byId = (/** @type {string} */ id) => /** @type {HTMLElement | null} */ (documentRef.getElementById(id));
    const reducedMotion = !!windowRef.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    // ---- actions: one delegated listener for every data-pm-action button
    owned.listen(documentRef, 'click', (event) => {
        const target = /** @type {Element | null} */ (event.target);
        const button = /** @type {HTMLElement | null} */ (target?.closest?.('[data-pm-action]') ?? null);
        if (!button) return;
        const name = button.dataset.pmAction ?? '';
        const action = actions[name];
        if (!action) {
            console.warn(`[projectM] no shell action named "${name}"`);
            return;
        }
        if (button.classList.contains('clickable-button')) pulse(button);
        action();
    });
    if (onContextMenuCustom) {
        owned.listen(byId('customMilkBtn'), 'contextmenu', onContextMenuCustom);
    }

    // ---- button pulse
    /** @param {HTMLElement} button */
    function pulse(button) {
        if (reducedMotion) return;
        button.classList.remove('pulse');
        void button.offsetWidth; // restart the CSS animation
        button.classList.add('pulse');
        owned.setTimeout(() => button.classList.remove('pulse'), 420);
    }

    // ---- knob: drag to rotate, tints the panel's glow
    const knob = byId('knob');
    const panel = byId('panel-container');
    if (knob && panel) {
        let rotation = 0;
        let dragging = false;
        let startAngle = 0;
        /** @param {{ clientX: number, clientY: number }} point */
        const angle = (point) => {
            const r = knob.getBoundingClientRect();
            return (
                (Math.atan2(point.clientY - (r.top + r.height / 2), point.clientX - (r.left + r.width / 2)) * 180) /
                Math.PI
            );
        };
        /** @param {number} deg */
        const rotate = (deg) => {
            knob.style.transform = `translate(-50%,-50%) rotate(${deg}deg)`;
            const hue = ((deg % 360) + 360) % 360;
            panel.style.filter = `drop-shadow(0 0 18px hsla(${hue}, 55%, 50%, 0.42))`;
        };
        /** @param {{ clientX: number, clientY: number } | undefined} point */
        const begin = (point) => {
            if (!point) return;
            dragging = true;
            startAngle = angle(point) - rotation;
        };
        /** @param {{ clientX: number, clientY: number } | undefined} point */
        const move = (point) => {
            if (!dragging || !point) return;
            rotation = angle(point) - startAngle;
            rotate(rotation);
        };
        const end = () => {
            dragging = false;
        };
        owned.listen(knob, 'mousedown', (e) => begin(/** @type {MouseEvent} */ (e)));
        owned.listen(documentRef, 'mousemove', (e) => move(/** @type {MouseEvent} */ (e)));
        owned.listen(documentRef, 'mouseup', end);
        owned.listen(knob, 'touchstart', (e) => begin(/** @type {TouchEvent} */ (e).touches?.[0]));
        owned.listen(documentRef, 'touchmove', (e) => move(/** @type {TouchEvent} */ (e).touches?.[0]));
        owned.listen(documentRef, 'touchend', end);

        if (!reducedMotion) {
            // Idle wobble once the page has settled.
            owned.setTimeout(() => {
                knob.style.transition = 'transform 1.5s cubic-bezier(0.34,1.56,0.64,1)';
                knob.style.transform = `translate(-50%, -50%) rotate(${Math.random() * 25 - 12}deg)`;
            }, 1200);
        }
    }

    // ---- beat LED (a heartbeat, not the music's beat)
    const beatLed = documentRef.querySelector('.led--beat');
    if (beatLed && !reducedMotion) {
        owned.setInterval(() => beatLed.classList.toggle('on'), 500);
    }

    // ---- panel show / hide
    /** @param {string} opacity */
    const setChromeOpacity = (opacity) => {
        for (const id of chromeIds) {
            const el = byId(id);
            if (el) el.style.opacity = opacity;
        }
    };
    function hidePanel() {
        if (!panel) return;
        panel.style.transition = 'all 0.3s ease';
        panel.style.opacity = '0';
        owned.setTimeout(() => {
            panel.style.display = 'none';
            byId('show-btn')?.classList.remove('hidden');
            setChromeOpacity('0');
        }, 280);
    }
    function showPanel() {
        if (!panel) return;
        panel.style.display = 'block';
        panel.style.opacity = '0';
        owned.setTimeout(() => {
            panel.style.transition = 'all 0.3s ease';
            panel.style.opacity = '1';
            setChromeOpacity('1');
        }, 10);
        byId('show-btn')?.classList.add('hidden');
    }

    // ---- splash
    function hideSplash() {
        const spinner = byId('splash2');
        if (spinner) spinner.style.display = 'none';
        const shroud = byId('splash1');
        if (shroud) shroud.style.display = 'none';
    }
    owned.setTimeout(() => {
        const spinner = byId('splash2');
        if (spinner) spinner.style.display = 'none';
    }, splashMs);
    owned.setTimeout(() => {
        const shroud = byId('splash1');
        if (shroud) shroud.style.display = 'none';
    }, splashMs + 300);

    // ---- layout
    function updateLayout() {
        const contain = byId('contain1');
        const wrap = byId('wrap');
        const circle = byId('circle');
        const glass = byId('gl');
        const bezel = isBezelMode();
        byId('toggleBezelBtn')?.classList.toggle('engaged', bezel);

        if (bezel) {
            const size = windowRef.innerHeight;
            if (wrap) Object.assign(wrap.style, { width: '', height: '', position: '', top: '', left: '' });
            if (contain) {
                Object.assign(contain.style, {
                    width: `${size}px`,
                    height: `${size}px`,
                    left: `calc(50vw - ${size / 2}px)`,
                    top: `calc(50vh - ${size / 2}px)`,
                    position: 'absolute',
                });
            }
            if (circle) circle.style.display = 'block';
            if (glass) glass.style.display = 'block';
            onBezelLayout?.();
        } else {
            if (wrap)
                Object.assign(wrap.style, { width: '100vw', height: '100vh', position: 'fixed', top: '0', left: '0' });
            if (contain)
                Object.assign(contain.style, {
                    width: '100vw',
                    height: '100vh',
                    left: '0',
                    top: '0',
                    position: 'fixed',
                });
            if (circle) circle.style.display = 'none';
            if (glass) glass.style.display = 'none';
        }
        for (const id of ['mcanvas', 'scanvas']) {
            const canvas = byId(id);
            if (canvas) Object.assign(canvas.style, { left: '0', top: '0' });
        }
    }

    // Before the engine exists only the canvases' size can follow the layout;
    // once it does, ProjectMContext.resize() owns this.
    function sizeCanvases() {
        const contain = byId('contain1');
        if (!contain) return;
        const rect = contain.getBoundingClientRect();
        const dpr = windowRef.devicePixelRatio || 1;
        for (const id of ['mcanvas', 'scanvas']) {
            const canvas = /** @type {HTMLCanvasElement | null} */ (byId(id));
            if (!canvas) continue;
            canvas.width = Math.max(1, Math.round(rect.width * dpr));
            canvas.height = Math.max(1, Math.round(rect.height * dpr));
            canvas.style.width = `${rect.width}px`;
            canvas.style.height = `${rect.height}px`;
        }
    }

    // ---- status toast (#stat)
    /** @type {ReturnType<typeof setTimeout> | null} */
    let statusTimer = null;
    owned.add(() => {
        if (statusTimer) clearTimeout(statusTimer);
    });
    /**
     * @param {string} message
     * @param {'error' | 'warn'} [tone]
     * @param {number} [ms] 0 keeps it up.
     */
    function showStatus(message, tone = 'warn', ms = 0) {
        const stat = byId('stat');
        if (!stat) return;
        stat.textContent = message;
        Object.assign(stat.style, STATUS_TONES[tone], {
            display: 'block',
            padding: '0.45rem 0.7rem',
            borderRadius: '0.45rem',
        });
        if (statusTimer) clearTimeout(statusTimer);
        statusTimer =
            ms > 0
                ? setTimeout(() => {
                      statusTimer = null;
                      stat.style.display = 'none';
                  }, ms)
                : null;
    }

    // ---- state reflected in the DOM
    /** @param {boolean} locked */
    function setLocked(locked) {
        documentRef.body.classList.toggle('has-lock', locked);
        byId('lockPresetBtn')?.classList.toggle('engaged', locked);
    }
    /** @param {boolean} bezel */
    function setBezel(bezel) {
        byId('toggleBezelBtn')?.classList.toggle('engaged', bezel);
    }
    /** @param {boolean} enabled */
    function setTransparency(enabled) {
        const scanvas = byId('scanvas');
        if (scanvas) scanvas.style.display = enabled ? 'none' : 'block';
        const bgMedia = byId('bg-media');
        if (bgMedia) bgMedia.style.display = enabled ? 'block' : 'none';
        documentRef.querySelectorAll('[data-pm-action="toggleTransparencyMode"]').forEach((button) => {
            button.classList.toggle('engaged', enabled);
        });
        documentRef.querySelector('.led--glass')?.classList.toggle('on', enabled);
        documentRef.body.classList.toggle('has-transparency', enabled);
    }

    // ---- keyboard shortcuts
    if (keyboard) {
        owned.listen(documentRef, 'keydown', (event) => {
            const e = /** @type {KeyboardEvent} */ (event);
            const key = (e.key ?? '').toLowerCase();
            if (key === ' ') {
                e.preventDefault();
                actions.randomPreset?.();
            } else if (key === 'l') {
                actions.lockPreset?.();
            } else if (key === 'h') {
                hidePanel();
            } else if (key === 'a') {
                actions.cycleAudioPlayer?.();
            } else if (key === 'escape') {
                actions.closeAudioPlayer?.();
            }
        });
    }

    // ---- optional extras
    /** @param {LocalPresetDropOptions} drop */
    function enableLocalPresetDrop({ onFile, lastLabel }) {
        const devPanel = byId('local-preset-dev');
        const input = /** @type {HTMLInputElement | null} */ (byId('localPresetInput'));
        const dropzone = byId('local-preset-dropzone');
        if (!devPanel || !input || !dropzone) return;
        devPanel.hidden = false;
        const label = byId('localPresetLast');
        const refresh = () => {
            if (label) label.textContent = lastLabel();
        };
        refresh();
        /** @param {File | undefined | null} file */
        const take = (file) => {
            if (!file) return;
            onFile(file);
            refresh();
        };
        owned.listen(input, 'change', () => {
            take(input.files?.[0]);
            input.value = '';
        });
        for (const type of ['dragenter', 'dragover']) {
            owned.listen(dropzone, type, (event) => {
                event.preventDefault();
                dropzone.classList.add('dragover');
            });
        }
        for (const type of ['dragleave', 'drop']) {
            owned.listen(dropzone, type, (event) => {
                event.preventDefault();
                dropzone.classList.remove('dragover');
            });
        }
        owned.listen(dropzone, 'drop', (event) => take(/** @type {DragEvent} */ (event).dataTransfer?.files?.[0]));
    }

    /** @param {ShellLauncher[]} launchers */
    function addLaunchers(launchers) {
        if (launchers.length === 0 || byId(launchers[0].id)) return;
        const style = documentRef.createElement('style');
        style.textContent = `
          .pm-ext-player-btn {
            position: fixed; z-index: 3500; width: 28px; height: 22px;
            background: #222; color: #0f0; border: 1px solid #0a0; border-radius: 3px;
            font: 10px/1 'Lucida Console', monospace; cursor: pointer; opacity: 0.85;
          }
          .pm-ext-player-btn:hover { opacity: 1; background:#111; }
        `;
        owned.append(documentRef.head, style);
        launchers.forEach((launcher, index) => {
            const button = documentRef.createElement('button');
            button.type = 'button';
            button.id = launcher.id;
            button.className = 'pm-ext-player-btn';
            button.textContent = launcher.label;
            button.title = launcher.title;
            button.style.left = `${8 + index * 32}px`;
            button.style.top = '8px';
            owned.listen(button, 'click', launcher.open);
            owned.append(documentRef.body, button);
        });
    }

    /**
     * @param {WasmPickerOptions} picker
     * @returns {() => void}
     */
    function setupWasmPicker({ versions, active, onChange }) {
        const select = /** @type {HTMLSelectElement | null} */ (byId('wasmVersionSelect'));
        if (!select) return () => {};
        const render = () => {
            const current = active();
            select.replaceChildren();
            for (const version of versions()) {
                const option = documentRef.createElement('option');
                option.value = version;
                option.textContent = version === current ? `${version} (active)` : version;
                select.appendChild(option);
            }
            select.value = current;
        };
        render();
        owned.listen(select, 'change', () => onChange(select.value));
        owned.add(() => select.replaceChildren());
        return render;
    }

    /** @param {{ start(useMic?: boolean): unknown, stop(): void }} sender */
    function addTestSenderPanel(sender) {
        const container = documentRef.createElement('div');
        container.id = 'pm-test-sender-panel';
        container.style.cssText =
            'position:fixed;bottom:8px;right:8px;z-index:99999;background:#111;color:#0f0;font:11px/1.3 monospace;padding:6px 10px;border:1px solid #0a0;border-radius:4px;opacity:0.9';
        const title = documentRef.createElement('div');
        title.style.cssText = 'margin-bottom:4px;font-weight:bold';
        title.textContent = 'projectM Sender Test';
        container.appendChild(title);
        for (const [label, run] of /** @type {const} */ ([
            ['Tone → PM', () => sender.start(false)],
            ['Mic → PM', () => sender.start(true)],
            ['Stop', () => sender.stop()],
        ])) {
            const button = documentRef.createElement('button');
            button.type = 'button';
            button.textContent = label;
            button.style.marginRight = '4px';
            owned.listen(button, 'click', () => void run());
            container.appendChild(button);
        }
        owned.append(documentRef.body, container);
    }

    return {
        hidePanel,
        showPanel,
        updateLayout,
        sizeCanvases,
        hideSplash,
        showStatus,
        setLocked,
        setBezel,
        setTransparency,
        enableLocalPresetDrop,
        addLaunchers,
        setupWasmPicker,
        addTestSenderPanel,
        owned,
        dispose: () => owned.dispose(),
    };
}
