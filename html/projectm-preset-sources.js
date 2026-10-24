// projectm-preset-sources.js
//
// Where preset files are fetched from: the URL bases tried, in order, for a
// manifest entry's `base` collection. Local copies first (next to the page,
// then one directory up, which is how the deploy lays them out), the CDN
// last. This is policy, kept apart from the IndexedDB cache
// (projectm-preset-cache.js) and the loader (projectm-preset-library.js),
// which both take a resolver and default to this one.

/**
 * @param {string} [base] The entry's collection; anything else means `custom_milk_fixed`.
 * @returns {string[]} Candidate URL bases, tried in order.
 */
export function defaultBasesForBase(base) {
    if (base === 'weeks_presets') {
        return ['../weeks_presets/', './weeks_presets/', 'https://glsl.1ink.us/weeks_presets/'];
    }
    return ['../custom_milk_fixed/', './custom_milk_fixed/', 'https://glsl.1ink.us/custom_milk/'];
}
