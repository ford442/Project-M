import { chromium } from 'playwright';

const versions = ['030', '030b', '033', '034', '035'];
const base = 'https://projectm.1ink.us/1ink.1ink';

const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
});

for (const wasm of versions) {
    const page = await browser.newPage();
    const events = [];
    page.on('console', (m) => events.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => events.push(`[pageerror] ${e.message}`));
    page.on('requestfailed', (r) => events.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));

    const url = wasm === '035' ? base : `${base}?wasm=${wasm}`;
    try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
        await page.waitForTimeout(12000);
        const state = await page.evaluate(() => ({
            crossOriginIsolated: window.crossOriginIsolated,
            hasCreateModule: typeof createModule === 'function',
            hasModule: !!window.Module,
            hasInit: typeof window.Module?._init === 'function',
            wasmVersion: document.getElementById('wasmVersionSelect')?.value,
            overlay: document.getElementById('pm-init-error')?.classList.contains('visible') ?? false,
            overlayText: document.getElementById('pm-init-error')?.innerText?.slice(0, 200) ?? '',
        }));
        let initCode = null;
        let initErr = null;
        if (state.hasInit) {
            try {
                initCode = await page.evaluate(() => window.Module._init());
            } catch (e) {
                initErr = String(e);
            }
        }
        console.log(`\n=== wasm=${wasm} url=${url} ===`);
        console.log('state', JSON.stringify(state));
        console.log('_init', initCode, initErr || '');
        const interesting = events.filter((e) =>
            /null function|_init|worker|1ijs|wasm|pthread|ERR_|failed|init/i.test(e)
        );
        console.log('events', interesting.slice(-12));
    } catch (e) {
        console.log(`\n=== wasm=${wasm} FAILED goto ===`, e.message);
        console.log('events', events.slice(-8));
    }
    await page.close();
}

await browser.close();
