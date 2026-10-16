// Module closure of the html/ host layer, as scripts/build.mjs vendors it.
//
// The package must ship every file a module can load at run time, not only the
// ones a static `from '...'` names. Three reference forms reach a sibling file:
//
//   import { x } from './a.js';  /  import './a.js';      static
//   import('./a.js')                                       dynamic
//   new URL('./a.js', import.meta.url)                     fetched by URL
//                                                          (Worker, AudioWorklet)
//
// The scan used to follow only the first, so a module reached any other way was
// silently missing from @projectm/web: the render worker 404'd for every npm
// consumer until it was hard-coded into a list. Every form is followed now, and
// a reference that resolves to nothing under the root is reported instead of
// dropped, so the build can fail on it (or copy it from elsewhere on purpose).
//
// Only string-literal specifiers are followed; a computed `import(name)` cannot
// be resolved statically. Comments are stripped first: JSDoc's
// `{import('./x.ts').T}` is a type reference, not a run-time load.

import { readFile, access } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';

const STATIC_RE = /(?:\bfrom|^\s*import)\s*['"](\.{1,2}\/[^'"]+)['"]/gm;
const DYNAMIC_RE = /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
const URL_RE = /\bnew\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g;

/**
 * Removes block comments and whole-line `//` comments. Trailing `// ...` after
 * code is left alone: telling it apart from `//` inside a string literal
 * ('https://...') needs a tokenizer, and a reference in a trailing comment is
 * not a thing this tree does.
 *
 * @param {string} source
 * @returns {string}
 */
export function stripComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Relative specifiers a module source references, by kind.
 *
 * @param {string} source
 * @returns {{ static: string[], dynamic: string[], url: string[] }}
 */
export function scanModuleReferences(source) {
    const code = stripComments(source);
    const collect = (/** @type {RegExp} */ re) => [...code.matchAll(re)].map((m) => m[1]);
    return {
        static: collect(STATIC_RE),
        dynamic: collect(DYNAMIC_RE),
        // `new URL('x.js', import.meta.url)` is relative even without `./`.
        url: collect(URL_RE).filter((spec) => !/^[a-z][a-z0-9+.-]*:/i.test(spec) && !spec.startsWith('/')),
    };
}

async function exists(path) {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

/**
 * The transitive closure of `.js` files reachable from `entries` under `root`.
 *
 * @param {string} root   directory the entries (and every result) are relative to
 * @param {string[]} entries
 * @returns {Promise<{ modules: string[], unresolved: Array<{ from: string, specifier: string, kind: string }> }>}
 *   `modules` sorted, POSIX-relative to `root`; `unresolved` lists references
 *   whose target is not a file under `root` (outside it, or missing).
 */
export async function computeModuleClosure(root, entries) {
    const seen = new Set();
    /** @type {Array<{ from: string, specifier: string, kind: string }>} */
    const unresolved = [];
    const stack = [...entries];
    while (stack.length) {
        const rel = /** @type {string} */ (stack.pop());
        if (seen.has(rel)) continue;
        seen.add(rel);
        const refs = scanModuleReferences(await readFile(join(root, rel), 'utf8'));
        for (const [kind, specifiers] of Object.entries(refs)) {
            for (const specifier of specifiers) {
                const target = normalize(join(dirname(rel), specifier)).split('\\').join('/');
                // URL references may name non-module assets; only .js files are modules.
                if (kind === 'url' && !target.endsWith('.js')) continue;
                if (target.startsWith('../') || !(await exists(join(root, target)))) {
                    unresolved.push({ from: rel, specifier, kind });
                    continue;
                }
                stack.push(target);
            }
        }
    }
    return { modules: [...seen].sort(), unresolved };
}
