#!/usr/bin/env node
// Promote a draft or quarantined .milk preset into custom_milk_fixed/.
//
// Gates (draft → curated):
//   1. Static audit — zero `error` findings (scripts/audit_presets.mjs)
//   2. Transpile — scripts/kimi_validate_preset.sh exits 0 (when build dir exists)
//   3. Tier — light or medium (heavy requires --allow-heavy)
//   4. Capture — if screenshots/custom_milk_baseline/capture_report.json has an entry,
//      it must be ok=true unless --skip-capture-check
//
// Usage:
//   node scripts/promote_preset.mjs <source.milk> [--dest-name name.milk]
//   node scripts/promote_preset.mjs presets/drafts/foo.milk --skip-capture-check
//
// After promotion:
//   node scripts/generate_custom_preset_manifest.mjs
//   node scripts/build_featured_pack.mjs

import { readFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { auditText } from './audit_presets.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CURATED_DIR = join(PROJECT_ROOT, 'custom_milk_fixed');
const CAPTURE_REPORT = join(PROJECT_ROOT, 'screenshots', 'custom_milk_baseline', 'capture_report.json');

function parseArgs(argv) {
    const opts = { allowHeavy: false, skipCapture: false, destName: null, buildDir: join(PROJECT_ROOT, 'cmake-build') };
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--allow-heavy') opts.allowHeavy = true;
        else if (a === '--skip-capture-check') opts.skipCapture = true;
        else if (a === '--dest-name') opts.destName = argv[++i];
        else if (a === '--build-dir') opts.buildDir = argv[++i];
        else if (a.startsWith('--')) { console.error(`unknown flag: ${a}`); process.exit(2); }
        else positional.push(a);
    }
    if (positional.length !== 1) {
        console.error('usage: node scripts/promote_preset.mjs <source.milk> [--dest-name name.milk] [--allow-heavy] [--skip-capture-check]');
        process.exit(2);
    }
    opts.source = resolve(PROJECT_ROOT, positional[0]);
    return opts;
}

function runValidate(source, buildDir) {
    if (!existsSync(buildDir)) {
        console.warn(`warning: build dir ${buildDir} missing — skipping transpile gate`);
        return true;
    }
    const script = join(PROJECT_ROOT, 'scripts', 'kimi_validate_preset.sh');
    const out = spawnSync(script, [source, buildDir], { cwd: PROJECT_ROOT, encoding: 'utf8' });
    if (out.status !== 0) {
        console.error(out.stdout || out.stderr);
        return false;
    }
    return true;
}

function checkCapture(fileName, skip) {
    if (skip || !existsSync(CAPTURE_REPORT)) return true;
    const report = JSON.parse(readFileSync(CAPTURE_REPORT, 'utf8'));
    const entry = (report.results || []).find((r) => r.preset === fileName);
    if (!entry) return true;
    if (entry.ok === true) return true;
    console.error(`capture baseline marks ${fileName} as broken: ${entry.error || 'capture failed'}`);
    return false;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!existsSync(opts.source)) {
        console.error(`source not found: ${opts.source}`);
        process.exit(2);
    }
    if (!opts.source.toLowerCase().endsWith('.milk')) {
        console.error('source must be a .milk file');
        process.exit(2);
    }

    const destName = opts.destName || basename(opts.source);
    const dest = join(CURATED_DIR, destName);

    console.log(`Promoting ${opts.source} → ${dest}`);

    const text = readFileSync(opts.source, 'utf8');
    const audit = auditText(text, destName);
    if (!audit.ok) {
        console.error('static audit errors:');
        for (const f of audit.findings.filter((x) => x.severity === 'error')) {
            console.error(`  [${f.code}] ${f.message}`);
        }
        process.exit(1);
    }
    if (audit.tier === 'heavy' && !opts.allowHeavy) {
        console.error(`tier is ${audit.tier}; pass --allow-heavy to promote anyway`);
        process.exit(1);
    }
    console.log(`  audit: ok (tier=${audit.tier}, reactive=${audit.reactive})`);

    if (!runValidate(opts.source, opts.buildDir)) {
        console.error('transpile gate failed');
        process.exit(1);
    }
    console.log('  transpile: ok');

    if (!checkCapture(destName, opts.skipCapture)) {
        console.error('capture gate failed (use --skip-capture-check for new presets)');
        process.exit(1);
    }
    console.log('  capture: ok');

    mkdirSync(CURATED_DIR, { recursive: true });
    copyFileSync(opts.source, dest);
    console.log(`\nPromoted to ${dest}`);
    console.log('Next: node scripts/generate_custom_preset_manifest.mjs && node scripts/build_featured_pack.mjs');
}

main();
