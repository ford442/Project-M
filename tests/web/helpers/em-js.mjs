// Pulls the JavaScript bodies out of the EM_JS / EM_ASYNC_JS / EM_ASM* macros in
// src/wasm/*.cpp, so a Node test can read them (and run them) without an
// Emscripten link. A body is a JS block written inside a C++ macro argument:
// braces, quotes, template literals and comments all have to be skipped
// correctly to find where it ends, which a regex cannot do.

/**
 * Index of the bracket that closes the one at `open`, skipping JS strings,
 * template literals and comments. -1 when unbalanced.
 *
 * @param {string} text
 * @param {number} open Index of `{` or `(`.
 */
export function findClosing(text, open) {
    const pairs = { '{': '}', '(': ')' };
    const opener = text[open];
    const closer = pairs[opener];
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
        const ch = text[i];
        const next = text[i + 1];
        if (ch === '/' && next === '/') {
            i = text.indexOf('\n', i);
            if (i === -1) return -1;
        } else if (ch === '/' && next === '*') {
            i = text.indexOf('*/', i + 2) + 1;
            if (i === 0) return -1;
        } else if (ch === '"' || ch === "'" || ch === '`') {
            for (i += 1; i < text.length && text[i] !== ch; i += 1) {
                if (text[i] === '\\') i += 1;
            }
        } else if (ch === opener) {
            depth += 1;
        } else if (ch === closer) {
            depth -= 1;
            if (depth === 0) return i;
        }
    }
    return -1;
}

/**
 * @typedef {object} EmJsBlock
 * @property {string} macro `EM_JS`, `EM_ASYNC_JS`, `EM_ASM`, `EM_ASM_INT`, ...
 * @property {string} name The C++ function name (EM_JS / EM_ASYNC_JS only).
 * @property {string[]} params Parameter names (EM_JS / EM_ASYNC_JS only; EM_ASM bodies use `$0`...).
 * @property {string} body The JS between the braces.
 */

/**
 * @param {string} source A C++ translation unit.
 * @returns {EmJsBlock[]}
 */
export function extractEmJs(source) {
    /** @type {EmJsBlock[]} */
    const blocks = [];
    const macroRe = /\b(EM_JS|EM_ASYNC_JS|EM_ASM_INT|EM_ASM_DOUBLE|EM_ASM_PTR|EM_ASM)\s*\(/g;
    let match;
    while ((match = macroRe.exec(source)) !== null) {
        const open = match.index + match[0].length - 1;
        const close = findClosing(source, open);
        if (close === -1) continue;
        const args = source.slice(open + 1, close);
        const braceStart = args.indexOf('{');
        if (braceStart === -1) continue;
        const braceEnd = findClosing(args, braceStart);
        const body = args.slice(braceStart + 1, braceEnd === -1 ? undefined : braceEnd);
        if (match[1] === 'EM_JS' || match[1] === 'EM_ASYNC_JS') {
            // (return type, name, (params), { body })
            const head = args.slice(0, braceStart);
            const paren = head.indexOf('(');
            const [, name = ''] = head.slice(0, paren).split(',').map((part) => part.trim());
            const params = head.slice(paren + 1, head.lastIndexOf(')'))
                .split(',')
                .map((part) => part.trim().split(/[\s*]+/).pop() ?? '')
                .filter(Boolean);
            blocks.push({ macro: match[1], name, params, body });
        } else {
            blocks.push({ macro: match[1], name: '', params: [], body });
        }
        macroRe.lastIndex = close;
    }
    return blocks;
}

/** Drops // line comments and block comments (outside strings, good enough for EM_JS bodies). */
export function stripJsComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}
