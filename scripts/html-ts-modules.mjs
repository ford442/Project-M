// The html/ modules written in TypeScript, and the .js each one is emitted to.
//
// One rule, shared by everything that has to know it: scripts/build_html_ts.mjs
// (which emits them), eslint.config.mjs (which lints the .ts and skips the
// emitted .js) and tests/web/html-ts-build.test.mjs. A module is TypeScript
// when html/ holds `<name>.ts` that is not a declaration file and not a
// `*-types.ts` companion; its `<name>.js` is generated and committed, so the
// deployed file names, `new URL('./x.js', import.meta.url)` and every `.js`
// importer keep working unchanged (docs/HOST_LAYER.md "TypeScript modules").

import { readdirSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const HTML_ROOT = join(PROJECT_ROOT, 'html');

/** Directories under html/ that never hold first-party TypeScript modules. */
const SKIP_DIRS = new Set(['node_modules', 'generated', 'flac-decode', 'xm-player', 'vendor']);

/**
 * The classic (non-module) scripts among them: they run as a Worker's script,
 * so the emitted .js must have no import/export left (the build checks).
 */
export const CLASSIC_SCRIPTS = new Set(['projectm-render-worker.ts']);

/**
 * @returns {{ ts: string, js: string }[]} Paths relative to html/, posix
 *   separators, sorted.
 */
export function listHtmlTsModules() {
    /** @type {{ ts: string, js: string }[]} */
    const found = [];
    /** @param {string} dir */
    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
                continue;
            }
            const name = entry.name;
            if (!name.endsWith('.ts') || name.endsWith('.d.ts') || name.endsWith('-types.ts')) continue;
            const ts = relative(HTML_ROOT, join(dir, name)).split('\\').join('/');
            found.push({ ts, js: ts.replace(/\.ts$/, '.js') });
        }
    };
    walk(HTML_ROOT);
    return found.sort((a, b) => a.ts.localeCompare(b.ts));
}
