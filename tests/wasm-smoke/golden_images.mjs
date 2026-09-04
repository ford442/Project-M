#!/usr/bin/env node
/**
 * Golden-image regression gate for the WASM renderer.
 *
 * Captures a fixed preset set at fixed frame indices through
 * tests/wasm-smoke/deterministic_capture.html, then compares each capture with
 * the committed golden under tests/wasm-smoke/golden/.
 *
 * Usage:
 *   node tests/wasm-smoke/golden_images.mjs --module cmake-build/wasm-smoke/projectm-v.030-thread.js
 *   node tests/wasm-smoke/golden_images.mjs --module <js> --update      # regenerate goldens
 *   node tests/wasm-smoke/golden_images.mjs --module <js> --self-check  # determinism only, no goldens
 *   node tests/wasm-smoke/golden_images.mjs --module <js> --preset A.milk --preset B.milk
 *
 * Options:
 *   --gpu             Use the machine's real GL instead of SwiftShader. Fine for
 *                     a local look; goldens are committed from software GL.
 *   --self-check      Capture every preset twice in one browser and require
 *                     byte-identical output. This is the determinism test; it
 *                     needs no goldens and is the first thing to run when a
 *                     golden mismatch looks like noise.
 *   --update          Write captures as the new goldens instead of comparing.
 *   --artifacts DIR   Where failure triptychs and the JSON report go.
 *                     Default: benchmark-results/golden/.
 *
 * Exit code is non-zero when any preset fails, so this is usable as a CI gate.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodePngDataUrl, decodePng, encodePng } from './lib/png.mjs';
import { compareImages, evaluateComparison, composeStrip } from './lib/image-diff.mjs';
import {
    createStaticServer, detectRepoRoot, launchChromium, listen, loadPlaywright, rootRelative,
} from './lib/harness-runtime.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.PROJECTM_ROOT || detectRepoRoot(scriptDir));

function parseArgs(argv) {
    const options = {
        module: process.env.PROJECTM_WASM_JS || 'cmake-build/wasm-smoke/projectm-v.030-thread.js',
        manifest: join(root, 'tests/wasm-smoke/golden/manifest.json'),
        goldenDir: join(root, 'tests/wasm-smoke/golden'),
        artifacts: join(root, 'benchmark-results/golden'),
        presets: [],
        update: false,
        selfCheck: false,
        gpu: false,
    };
    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--module') options.module = argv[++i];
        else if (arg === '--manifest') options.manifest = resolve(argv[++i]);
        else if (arg === '--artifacts') options.artifacts = resolve(argv[++i]);
        else if (arg === '--preset') options.presets.push(argv[++i]);
        else if (arg === '--update') options.update = true;
        else if (arg === '--self-check') options.selfCheck = true;
        else if (arg === '--gpu') options.gpu = true;
        else {
            console.error(`Unknown argument: ${arg}`);
            process.exit(2);
        }
    }
    options.module = resolve(root, options.module);
    return options;
}

/** Stable, filesystem-safe name for a preset path. */
function presetKey(presetPath) {
    return presetPath.replace(/\.milk$/i, '').replace(/[^a-zA-Z0-9]+/g, '_');
}

function goldenPath(goldenDir, presetPath, frame) {
    return join(goldenDir, 'images', `${presetKey(presetPath)}__f${String(frame).padStart(5, '0')}.png`);
}

/**
 * Drives one deterministic capture and returns the page's result object with
 * each capture's PNG decoded.
 */
async function capturePreset(page, { port, capturePageUrl, moduleUrl, presetPath, entry, manifest }) {
    const query = new URLSearchParams({
        module: moduleUrl,
        preset: rootRelative(root, join(root, presetPath)),
        width: String(manifest.canvas?.width ?? 640),
        height: String(manifest.canvas?.height ?? 480),
        seed: String(manifest.seed ?? 20260901),
        fps: String(manifest.fps ?? 60),
        settleFrames: String(entry.settleFrames ?? manifest.settleFrames ?? 30),
        captureFrames: (entry.captureFrames ?? manifest.captureFrames ?? [60, 300]).join(','),
        meshWidth: String(manifest.mesh?.width ?? 80),
        meshHeight: String(manifest.mesh?.height ?? 60),
    });

    await page.goto(`http://127.0.0.1:${port}${capturePageUrl}?${query}`, {
        waitUntil: 'load',
        timeout: 60_000,
    });
    await page.waitForFunction(() => window.__projectMDeterministicCapture, null, { timeout: 300_000 });
    const result = await page.evaluate(() => window.__projectMDeterministicCapture);
    if (!result.ok) {
        throw new Error(result.error || 'capture reported failure');
    }
    return {
        ...result,
        captures: result.captures.map((capture) => ({
            frame: capture.frame,
            nonBlackFraction: capture.nonBlackFraction,
            image: decodePngDataUrl(capture.dataUrl),
        })),
    };
}

const options = parseArgs(process.argv);

if (!existsSync(options.module)) {
    console.error(
        `WASM bundle not found: ${options.module}\n`
        + 'Build one with scripts/build_wasm_smoke_wrapper.sh, or point --module at an existing bundle.',
    );
    process.exit(1);
}
if (!existsSync(options.module.replace(/\.(m?js|1ijs)$/, '.wasm'))) {
    console.warn(`Warning: no .wasm sibling found for ${basename(options.module)}; the loader may embed it.`);
}

const manifest = JSON.parse(readFileSync(options.manifest, 'utf8'));
const entries = (options.presets.length > 0
    ? manifest.presets.filter((entry) => options.presets.includes(entry.path))
    : manifest.presets);
if (entries.length === 0) {
    console.error(options.presets.length > 0
        ? `None of these presets are in the manifest: ${options.presets.join(', ')}`
        : 'Manifest lists no presets');
    process.exit(2);
}
if (options.presets.length > 0 && entries.length !== options.presets.length) {
    const known = new Set(entries.map((entry) => entry.path));
    console.error('Not in the manifest: ' + options.presets.filter((path) => !known.has(path)).join(', '));
    process.exit(2);
}
const missing = entries.filter((entry) => !existsSync(join(root, entry.path)));
if (missing.length > 0) {
    console.error('Manifest lists presets that do not exist:\n  ' + missing.map((e) => e.path).join('\n  '));
    process.exit(2);
}

mkdirSync(options.artifacts, { recursive: true });
mkdirSync(join(options.goldenDir, 'images'), { recursive: true });

const { chromium } = loadPlaywright(root);
const server = createStaticServer(root);
const port = await listen(server);
const capturePageUrl = rootRelative(root, join(root, 'tests/wasm-smoke/deterministic_capture.html'));
const moduleUrl = rootRelative(root, options.module);

const report = {
    capturedAt: new Date().toISOString(),
    module: rootRelative(root, options.module),
    gl: options.gpu ? 'gpu' : 'software (ANGLE/SwiftShader)',
    mode: options.update ? 'update' : (options.selfCheck ? 'self-check' : 'compare'),
    manifest: rootRelative(root, options.manifest),
    tolerance: manifest.tolerance ?? {},
    results: [],
};

let failures = 0;
const browser = await launchChromium(chromium, options.gpu ? 'gpu' : 'software');

try {
    const page = await browser.newPage({
        viewport: {
            width: (manifest.canvas?.width ?? 640) + 40,
            height: (manifest.canvas?.height ?? 480) + 80,
        },
    });
    page.on('pageerror', (error) => console.error('[browser:pageerror]', error));

    for (const entry of entries) {
        const label = entry.label ? `${entry.path} (${entry.label})` : entry.path;
        process.stdout.write(`• ${label}\n`);
        const entryReport = { preset: entry.path, label: entry.label ?? null, frames: [], ok: false, error: null };

        try {
            const first = await capturePreset(page, {
                port, capturePageUrl, moduleUrl, presetPath: entry.path, entry, manifest,
            });

            // Determinism self-check: same page, same build, same rasterizer,
            // captured twice. Anything other than byte-identical means an input
            // is still unpinned, and every comparison below is meaningless until
            // that is fixed — so this failure is reported on its own terms
            // rather than as a golden mismatch.
            let repeat = null;
            if (options.selfCheck) {
                repeat = await capturePreset(page, {
                    port, capturePageUrl, moduleUrl, presetPath: entry.path, entry, manifest,
                });
            }

            for (const capture of first.captures) {
                const frameReport = { frame: capture.frame, nonBlackFraction: capture.nonBlackFraction };
                const target = goldenPath(options.goldenDir, entry.path, capture.frame);

                if (options.selfCheck) {
                    const other = repeat.captures.find((c) => c.frame === capture.frame);
                    if (!other) throw new Error(`repeat run did not capture frame ${capture.frame}`);
                    const comparison = compareImages(capture.image, other.image, { pixelThreshold: 0 });
                    frameReport.repeatDifferingPixels = comparison.differingPixels;
                    frameReport.ok = comparison.differingPixels === 0;
                    if (!frameReport.ok) {
                        failures += 1;
                        const stripPath = join(options.artifacts, `${presetKey(entry.path)}__f${capture.frame}__nondeterministic.png`);
                        writeFileSync(stripPath, encodePng(composeStrip([capture.image, other.image, comparison.diff])));
                        frameReport.artifact = rootRelative(root, stripPath);
                        console.error(
                            `  ✗ frame ${capture.frame}: two runs of the same commit differ in `
                            + `${comparison.differingPixels} pixel(s) — determinism is not pinned. ${stripPath}`,
                        );
                    } else {
                        console.log(`  ✓ frame ${capture.frame}: byte-identical across two runs`);
                    }
                } else if (options.update) {
                    mkdirSync(dirname(target), { recursive: true });
                    writeFileSync(target, encodePng(capture.image));
                    frameReport.ok = true;
                    frameReport.golden = rootRelative(root, target);
                    console.log(`  ↑ wrote golden ${rootRelative(root, target)}`);
                } else if (!existsSync(target)) {
                    failures += 1;
                    frameReport.ok = false;
                    frameReport.error = 'no golden committed';
                    console.error(
                        `  ✗ frame ${capture.frame}: no golden at ${rootRelative(root, target)}. `
                        + 'Generate it with --update and commit it.',
                    );
                } else {
                    const golden = decodePng(readFileSync(target));
                    const comparison = compareImages(golden, capture.image, {
                        pixelThreshold: manifest.tolerance?.pixelThreshold ?? 8,
                    });
                    const verdict = evaluateComparison(comparison, manifest.tolerance ?? {});
                    Object.assign(frameReport, {
                        ok: verdict.pass,
                        ssim: Number(comparison.ssim.toFixed(6)),
                        differingFraction: Number(comparison.differingFraction.toFixed(6)),
                        maxChannelDelta: comparison.maxChannelDelta,
                    });
                    if (verdict.pass) {
                        console.log(`  ✓ frame ${capture.frame}: ssim ${comparison.ssim.toFixed(5)}`);
                    } else {
                        failures += 1;
                        frameReport.failures = verdict.failures;
                        const stripPath = join(
                            options.artifacts,
                            `${presetKey(entry.path)}__f${capture.frame}__golden-actual-diff.png`,
                        );
                        writeFileSync(stripPath, encodePng(composeStrip([golden, capture.image, comparison.diff])));
                        frameReport.artifact = rootRelative(root, stripPath);
                        console.error(`  ✗ frame ${capture.frame}: ${verdict.failures.join('; ')}`);
                        console.error(`    golden | actual | diff → ${stripPath}`);
                    }
                }

                entryReport.frames.push(frameReport);
            }

            entryReport.ok = entryReport.frames.every((frame) => frame.ok);
            if (first.consoleErrors.length > 0) entryReport.consoleErrors = first.consoleErrors;
        } catch (error) {
            failures += 1;
            entryReport.error = String(error && error.stack ? error.stack : error);
            console.error(`  ✗ ${entry.path}: ${entryReport.error.split('\n')[0]}`);
        }

        report.results.push(entryReport);
    }
} finally {
    await browser.close();
    await new Promise((closed) => server.close(closed));
}

report.failures = failures;
const reportPath = join(options.artifacts, 'golden_report.json');
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`\nReport: ${reportPath}`);

if (options.update) {
    console.log('Goldens updated. Review the images before committing — --update accepts whatever rendered.');
} else if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
} else {
    console.log('\nAll golden checks passed.');
}
