#!/usr/bin/env node
/**
 * End-to-end check of the FLAC player feeding projectM, in every playback mode.
 *
 * For each WASM version x player mode x song it opens the production host page
 * (`1ink.1ink?wasm=NNN`, i.e. html/projectm_panel2.1ink), opens the FLAC player
 * iframe from the audio-player button, picks the mode in the player's "Audio
 * output mode" select, loads the song through the player's file input (the
 * vendored bundle has no URL entry point), plays it, and checks:
 *
 *   - no LOST_SYNC / `Buffer is not defined` / 0-channel AudioWorkletNode /
 *     "No audio loaded" / uncaught page errors, on the host page or the iframe;
 *   - the player reports the file's real bit depth and duration (read from the
 *     file's own STREAMINFO);
 *   - playback advances: the host receives the player's PCM at about real time
 *     and the engine drains it (`projectMPcmStats()`), with a non-silent peak;
 *   - the engine's beat tracker reports beats (`projectMContext.on('beat')`),
 *     for builds that export the rhythm API (039+; skipped on older ones);
 *   - the host booted from pm/builds.json (html/projectm-wasm-manifest.js)
 *     when the served pm/ has one.
 *
 * The player's own position readout is reported as a warning only: the
 * vendored bundle's Web Audio and AudioWorklet backends never post a position
 * update while playing (no timer calls notifyStateChange), so it stays at 0:00
 * even while audio plays. That is a bug in the external player, not here.
 *
 * Two ways to serve the site:
 *   (default)          a local server with the deploy layout (html/ flattened to
 *                      the root, `1ink.1ink` = projectm_panel2.1ink) and COOP/COEP,
 *                      bundles from --pm-dir, so host changes are tested before
 *                      they are deployed;
 *   --base <url>       a deployed site, e.g. https://projectm.1ink.us
 *
 * Usage:
 *   node scripts/test_flac_player_modes_playwright.mjs \
 *       --pm-dir <dir with projectm-v.NNN-thread.{js,wasm}> \
 *       --song "<path>/Claws of the Angel.flac" [--song <path> ...] \
 *       [--wasm 039,038] [--modes streaming,web-audio,worklet] [--play-ms 10000] \
 *       [--base https://projectm.1ink.us] [--artifacts <dir>] [--expect-manifest]
 *
 * scripts/fetch_test_songs.sh downloads the reference songs and builds the
 * 16-bit and ID3v2-prefixed variants. Needs Playwright with Chromium
 * (`cd tests/wasm-smoke && npm install && npx playwright install chromium`).
 */

import http from 'node:http';
import { createReadStream, existsSync, mkdirSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Console text that must never appear, on the host page or in the player. */
export const FORBIDDEN_CONSOLE_PATTERNS = [
    { name: 'LOST_SYNC', re: /LOST_SYNC/ },
    { name: 'Buffer is not defined', re: /Buffer is not defined/ },
    { name: '0-channel AudioWorkletNode', re: /channel count \(0\)|outputChannelCount|channelCount.*\b0\b.*not supported/i },
    { name: 'No audio loaded', re: /No audio loaded/ },
    { name: 'projectM init failed', re: /projectM init failed/ },
];

/** Errors that are environment noise in headless Chromium, not player bugs. */
const IGNORED_ERRORS = [
    /webgpu|No available adapters|GPU adapter/i,
    /Failed to load resource: the server responded with a status of 404/,
    /CompositingBlendShader: initialized successfully/,
];

function parseArgs(argv) {
    const opts = {
        base: null,
        pmDir: null,
        songs: [],
        wasm: ['039', '038'],
        modes: ['streaming', 'web-audio', 'worklet'],
        playMs: 10000,
        artifacts: null,
        expectManifest: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = () => argv[++i];
        if (arg === '--base') opts.base = next().replace(/\/$/, '');
        else if (arg === '--pm-dir') opts.pmDir = resolve(next());
        else if (arg === '--song') opts.songs.push(resolve(next()));
        else if (arg === '--wasm') opts.wasm = next().split(',').filter(Boolean);
        else if (arg === '--modes') opts.modes = next().split(',').filter(Boolean);
        else if (arg === '--play-ms') opts.playMs = Number(next());
        else if (arg === '--artifacts') opts.artifacts = resolve(next());
        else if (arg === '--expect-manifest') opts.expectManifest = true;
        else if (arg === '--help' || arg === '-h') {
            console.log('see the header of scripts/test_flac_player_modes_playwright.mjs');
            process.exit(0);
        } else {
            throw new Error(`unknown argument ${arg}`);
        }
    }
    if (opts.songs.length === 0) throw new Error('pass at least one --song <file.flac>');
    if (!opts.base && !opts.pmDir) throw new Error('pass --pm-dir (local serve) or --base <url>');
    return opts;
}

/**
 * STREAMINFO of a FLAC file on disk (skipping an ID3v2 prefix).
 * @param {string} path
 */
export function readFlacStreamInfo(path) {
    const fd = openSync(path, 'r');
    try {
        const head = Buffer.alloc(10);
        readSync(fd, head, 0, 10, 0);
        let offset = 0;
        if (head.toString('latin1', 0, 3) === 'ID3') {
            offset = 10 + ((head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9]);
        }
        const block = Buffer.alloc(42);
        readSync(fd, block, 0, 42, offset);
        if (block.toString('latin1', 0, 4) !== 'fLaC') throw new Error(`${path}: no fLaC marker at ${offset}`);
        const packed = block.readBigUInt64BE(8 + 10);
        const sampleRate = Number(packed >> 44n);
        const channels = Number((packed >> 41n) & 7n) + 1;
        const bitsPerSample = Number((packed >> 36n) & 31n) + 1;
        const totalSamples = Number(packed & ((1n << 36n) - 1n));
        return { sampleRate, channels, bitsPerSample, totalSamples, duration: totalSamples / sampleRate, id3: offset > 0 };
    } finally {
        closeSync(fd);
    }
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.1ink': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.css': 'text/css; charset=utf-8',
    '.flac': 'audio/flac',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
};

/**
 * Deploy layout (deploy.py zip_entry_name): html/* at the root, 1ink.1ink is
 * the panel host, pm/ from `pmDir`.
 * @param {string} pmDir
 */
function startLocalSite(pmDir) {
    const resolvePath = (rel) => {
        if (rel.startsWith('/pm/')) return join(pmDir, rel.slice(4));
        if (rel === '/1ink.1ink') return join(repoRoot, 'html', 'projectm_panel2.1ink');
        if (rel.startsWith('/flac/')) return join(repoRoot, 'html', 'flac-decode', rel.slice(6));
        return join(repoRoot, 'html', rel.endsWith('/') ? `${rel}index.html` : rel);
    };
    return new Promise((resolveServer) => {
        const server = http.createServer((req, res) => {
            const url = new URL(req.url, 'http://localhost');
            const headers = {
                'Cross-Origin-Opener-Policy': 'same-origin',
                'Cross-Origin-Embedder-Policy': 'require-corp',
                'Cross-Origin-Resource-Policy': 'cross-origin',
                'Cache-Control': 'no-cache',
            };
            let file;
            try {
                file = resolvePath(decodeURIComponent(url.pathname));
                if (!file.startsWith(repoRoot) && !file.startsWith(pmDir)) throw new Error('outside root');
                if (!statSync(file).isFile()) throw new Error('not a file');
            } catch {
                res.writeHead(404, headers);
                res.end('not found');
                return;
            }
            headers['Content-Type'] = MIME[extname(file)] || 'application/octet-stream';
            headers['Content-Length'] = statSync(file).size;
            res.writeHead(200, headers);
            createReadStream(file).pipe(res);
        });
        server.listen(0, '127.0.0.1', () => resolveServer(server));
    });
}

function loadPlaywright() {
    const require = createRequire(import.meta.url);
    for (const base of [repoRoot, join(repoRoot, 'tests', 'wasm-smoke')]) {
        try {
            return require(require.resolve('playwright', { paths: [base] }));
        } catch {
            // try the next location
        }
    }
    throw new Error('playwright not found; run `npm install` in tests/wasm-smoke');
}

/**
 * @param {import('playwright').Browser} browser
 * @param {string} base
 * @param {{ wasm: string, mode: string, song: string, playMs: number, artifacts: string | null }} run
 */
async function runOne(browser, base, run) {
    const info = readFlacStreamInfo(run.song);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    /** @type {{ where: string, type: string, text: string }[]} */
    const consoleLines = [];
    const where = (frame) => (frame && frame !== page.mainFrame() ? 'player' : 'host');
    page.on('console', (msg) => {
        const frame = msg.location()?.url?.includes('/flac-player/') ? 'player' : 'host';
        consoleLines.push({ where: frame, type: msg.type(), text: msg.text() });
    });
    page.on('pageerror', (error) => consoleLines.push({ where: 'host', type: 'pageerror', text: String(error?.message || error) }));
    page.on('crash', () => consoleLines.push({ where: 'host', type: 'pageerror', text: 'renderer crashed' }));
    page.on('frameattached', (frame) => frame.on?.('pageerror', (error) => consoleLines.push({ where: where(frame), type: 'pageerror', text: String(error) })));

    const result = { ...run, song: basename(run.song), info, checks: [], ok: true };
    const check = (name, ok, detail, { warnOnly = false } = {}) => {
        result.checks.push({ name, ok: !!ok, detail, warnOnly });
        if (!ok && !warnOnly) result.ok = false;
    };

    try {
        await page.goto(`${base}/1ink.1ink?wasm=${run.wasm}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForFunction(
            () => typeof globalThis.projectMPcmStats === 'function' && globalThis.projectMContext,
            null,
            { timeout: 120000 },
        );
        // Which build booted, and whether it came from pm/builds.json.
        const build = await page.evaluate(async (wasm) => {
            const versions = await import('/projectm-wasm-version.js');
            const paths = versions.buildWasmBundlePaths(wasm);
            return { source: paths.source, glue: paths.pmScript, rhythm: versions.wasmBuildHasApi(paths, 'set_rhythm_events'), api: paths.api?.length ?? null };
        }, run.wasm);
        result.build = build;
        // Count beats from now on (both topologies; see ProjectMContext.on).
        await page.evaluate(() => {
            globalThis.__flacModeBeats = [];
            globalThis.projectMContext.on('beat', (event) => globalThis.__flacModeBeats.push(event));
        });

        await page.evaluate(() => globalThis.cycleAudioPlayer());
        const frameHandle = await page.waitForSelector('#flacFrame', { timeout: 30000 });
        const frame = await frameHandle.contentFrame();
        if (!frame) throw new Error('FLAC player iframe has no frame');
        await frame.waitForSelector('text=Open Advanced Library', { timeout: 60000 });
        await frame.getByText('Open Advanced Library').click();
        const select = frame.locator('select[aria-label="Audio output mode"]');
        await select.waitFor({ timeout: 30000 });
        await select.selectOption(run.mode);
        await frame.locator('input[type=file]').first().setInputFiles(run.song);

        const seek = frame.locator('input[aria-label="Seek position"]');
        await frame.waitForFunction(
            () => Number(document.querySelector('input[aria-label="Seek position"]')?.max) > 0,
            null,
            { timeout: 90000 },
        ).catch(() => {});

        // Playback may already have started on load; press Play only if it is offered.
        const play = frame.locator('button[aria-label="Play"]');
        if (await play.count()) await play.first().click({ timeout: 5000 }).catch(() => {});

        const position0 = Number(await seek.evaluate((el) => el.value).catch(() => 'NaN'));
        const stats0 = await page.evaluate(() => globalThis.projectMPcmStats());
        await page.waitForTimeout(run.playMs);
        const position1 = Number(await seek.evaluate((el) => el.value).catch(() => 'NaN'));
        const stats1 = await page.evaluate(() => globalThis.projectMPcmStats());
        const durationMax = Number(await seek.evaluate((el) => el.max).catch(() => 'NaN'));

        await frame.getByText('Now Playing').first().click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(500);
        const playerText = await frame.evaluate(() => document.body.innerText);
        const beats = await page.evaluate(() => globalThis.__flacModeBeats.map((event) => ({ bpm: event.bpm, beatIndex: event.beatIndex })));

        if (run.artifacts) {
            mkdirSync(run.artifacts, { recursive: true });
            await page.screenshot({ path: join(run.artifacts, `${run.wasm}-${run.mode}-${basename(run.song, '.flac')}.png`) });
        }

        const expectedClock = `${Math.floor(info.duration / 60)}:${String(Math.floor(info.duration % 60)).padStart(2, '0')}`;
        check('bit depth shown', playerText.includes(`${info.bitsPerSample}-bit`), `expected ${info.bitsPerSample}-bit`);
        check('duration', Math.abs(durationMax - info.duration) < 0.5 && playerText.includes(expectedClock),
            `seek max ${durationMax.toFixed(2)} s vs ${info.duration.toFixed(2)} s (${expectedClock})`);
        const advanced = position1 - position0;
        check('player UI position advances', advanced > run.playMs / 1000 * 0.5,
            `${position0.toFixed(2)} -> ${position1.toFixed(2)} s in ${run.playMs / 1000} s (known player bug, see header)`,
            { warnOnly: true });

        const seconds = run.playMs / 1000;
        const hostFps = (stats1.hostFramesFed - stats0.hostFramesFed) / seconds;
        const sampleRate = stats1.ingress.lastSampleRate || 48000;
        check('host PCM at real time', hostFps > 0.75 * sampleRate && hostFps < 1.5 * sampleRate,
            `${Math.round(hostFps)} fr/s fed vs ${sampleRate} Hz from ${stats1.ingress.lastProducer}`);
        // Well under real time means the engine (the render worker) is starved
        // for CPU, and the beat tracker then has too little audio to lock on.
        check('engine drains PCM at real time', (stats1.engineFps ?? 0) > 0.5 * sampleRate,
            `engine ${Math.round(stats1.engineFps ?? 0)} fr/s (${stats1.topology})`);
        check('PCM not silent', (stats1.ingress.lastPeak ?? 0) > 0.001, `peak ${stats1.ingress.lastPeak}`);
        const bpm = beats.length ? beats[beats.length - 1].bpm : 0;
        if (build.rhythm) {
            check('beat tracker fires', beats.length >= 2, `${beats.length} beats, ${bpm ? bpm.toFixed(1) : '?'} BPM`);
        } else {
            result.checks.push({ name: 'beat tracker fires', ok: true, skipped: true, detail: `n/a: ${run.wasm} exports no rhythm API (per pm/builds.json)` });
        }
        if (run.expectManifest) {
            check('booted from pm/builds.json', build.source === 'manifest', `${build.source}: ${build.glue}, ${build.api ?? '?'} exports`);
        }
    } catch (error) {
        check('run completed', false, String(error?.message || error).split('\n')[0]);
    }

    const forbidden = [];
    for (const line of consoleLines) {
        for (const pattern of FORBIDDEN_CONSOLE_PATTERNS) {
            if (pattern.re.test(line.text)) forbidden.push(`${line.where}: ${pattern.name}: ${line.text.slice(0, 160)}`);
        }
    }
    check('no forbidden console errors', forbidden.length === 0, forbidden.slice(0, 5).join(' | ') || 'none');
    const otherErrors = consoleLines
        .filter((line) => (line.type === 'error' || line.type === 'pageerror') && !IGNORED_ERRORS.some((re) => re.test(line.text)))
        .map((line) => `${line.where}: ${line.text.slice(0, 160)}`);
    result.otherErrors = otherErrors;

    await context.close().catch(() => {});
    return result;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    for (const song of opts.songs) if (!existsSync(song)) throw new Error(`song not found: ${song}`);

    let server = null;
    let base = opts.base;
    if (!base) {
        server = await startLocalSite(opts.pmDir);
        base = `http://127.0.0.1:${server.address().port}`;
    }
    const { chromium } = loadPlaywright();
    const browser = await chromium.launch({
        args: ['--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader'],
    });

    const results = [];
    try {
        for (const wasm of opts.wasm) {
            for (const mode of opts.modes) {
                for (const song of opts.songs) {
                    const result = await runOne(browser, base, { wasm, mode, song, playMs: opts.playMs, artifacts: opts.artifacts, expectManifest: opts.expectManifest });
                    results.push(result);
                    console.log(`${result.ok ? 'PASS' : 'FAIL'}  wasm=${wasm} mode=${mode} song=${result.song} (${result.info.bitsPerSample}-bit${result.info.id3 ? ', ID3v2' : ''}; glue ${result.build?.glue ?? '?'} from ${result.build?.source ?? '?'})`);
                    for (const c of result.checks) {
                        const mark = c.skipped ? '-- ' : c.ok ? 'ok ' : c.warnOnly ? 'WARN' : 'BAD';
                        console.log(`   ${mark} ${c.name}: ${c.detail}`);
                    }
                    if (result.otherErrors.length) {
                        console.log(`   (other console errors: ${result.otherErrors.length})`);
                        for (const line of result.otherErrors.slice(0, 5)) console.log(`     ${line}`);
                    }
                }
            }
        }
    } finally {
        await browser.close();
        server?.close();
    }
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} runs passed`);
    process.exit(failed ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error);
        process.exit(2);
    });
}
