/**
 * Perceptual image comparison for the golden-image gate.
 *
 * Why not byte equality: two GPUs — or the same GPU on two driver versions, or
 * RGBA16F where the fallback picked RGBA8 — legitimately differ in the low bits
 * of most pixels while rendering the same picture. A byte-equality gate on a
 * visualizer goes red on its first driver bump and gets disabled a week later.
 *
 * So the gate has two numbers with different jobs:
 *
 *   ssim              — structural similarity. Catches "the picture changed":
 *                       a flip, a shifted mesh, a missing blur pass, a preset
 *                       that stopped reacting. Insensitive to uniform small
 *                       shifts in level.
 *   differingFraction — share of pixels off by more than `pixelThreshold` on
 *                       any channel. Catches localized damage that a
 *                       whole-image SSIM average can dilute.
 *
 * Byte equality still has one job, and the harness's own acceptance test uses
 * it: two runs on the *same* commit and the *same* software rasterizer must
 * produce identical bytes, or determinism is not actually pinned. That is
 * `differingPixels === 0`, not a tolerance.
 */

/**
 * @typedef {import('./png.mjs').RgbaImage} RgbaImage
 */

/**
 * @typedef {object} ImageComparison
 * @property {number} width
 * @property {number} height
 * @property {number} differingPixels
 * @property {number} differingFraction 0..1
 * @property {number} maxChannelDelta 0..255
 * @property {number} meanChannelDelta 0..255
 * @property {number} ssim Mean structural similarity, 1.0 for identical images.
 * @property {RgbaImage} diff Red where pixels differ, dimmed original elsewhere.
 */

const SSIM_WINDOW = 8;
const SSIM_C1 = (0.01 * 255) ** 2;
const SSIM_C2 = (0.03 * 255) ** 2;

/**
 * Rec. 709 luma. The presets are colour, but structure is what the gate is
 * looking for, and per-channel SSIM triples the cost to report three numbers
 * that move together.
 *
 * @param {RgbaImage} image
 * @returns {Float64Array}
 */
export function toLuma({ width, height, data }) {
    const luma = new Float64Array(width * height);
    for (let i = 0, p = 0; i < luma.length; i += 1, p += 4) {
        luma[i] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
    }
    return luma;
}

/**
 * Mean SSIM over non-overlapping windows.
 *
 * Non-overlapping rather than sliding: an order of magnitude cheaper, and the
 * gate compares whole frames where a sliding window's extra precision changes
 * the third decimal, not the verdict. Partial windows at the right/bottom edge
 * are included at their real size rather than dropped, so a regression confined
 * to an edge strip still registers.
 *
 * @param {RgbaImage} expected
 * @param {RgbaImage} actual
 * @returns {number} Mean SSIM; 1.0 for identical input.
 */
export function meanSsim(expected, actual) {
    const { width, height } = expected;
    const a = toLuma(expected);
    const b = toLuma(actual);

    let total = 0;
    let windows = 0;

    for (let wy = 0; wy < height; wy += SSIM_WINDOW) {
        for (let wx = 0; wx < width; wx += SSIM_WINDOW) {
            const maxY = Math.min(wy + SSIM_WINDOW, height);
            const maxX = Math.min(wx + SSIM_WINDOW, width);
            const n = (maxY - wy) * (maxX - wx);

            let sumA = 0;
            let sumB = 0;
            for (let y = wy; y < maxY; y += 1) {
                for (let x = wx; x < maxX; x += 1) {
                    const i = y * width + x;
                    sumA += a[i];
                    sumB += b[i];
                }
            }
            const meanA = sumA / n;
            const meanB = sumB / n;

            let varA = 0;
            let varB = 0;
            let covar = 0;
            for (let y = wy; y < maxY; y += 1) {
                for (let x = wx; x < maxX; x += 1) {
                    const i = y * width + x;
                    const da = a[i] - meanA;
                    const db = b[i] - meanB;
                    varA += da * da;
                    varB += db * db;
                    covar += da * db;
                }
            }
            // Sample variance (n - 1), except for a 1-pixel window where the
            // only sensible reading is "no variance".
            const divisor = n > 1 ? n - 1 : 1;
            varA /= divisor;
            varB /= divisor;
            covar /= divisor;

            const numerator = (2 * meanA * meanB + SSIM_C1) * (2 * covar + SSIM_C2);
            const denominator = (meanA * meanA + meanB * meanB + SSIM_C1) * (varA + varB + SSIM_C2);
            total += numerator / denominator;
            windows += 1;
        }
    }

    return windows > 0 ? total / windows : 1;
}

/**
 * Compares two same-sized RGBA images.
 *
 * @param {RgbaImage} expected
 * @param {RgbaImage} actual
 * @param {object} [options]
 * @param {number} [options.pixelThreshold] Channel delta (0..255) a pixel must
 *   exceed to count as differing. 0 makes the count byte-exact.
 * @returns {ImageComparison}
 */
export function compareImages(expected, actual, { pixelThreshold = 8 } = {}) {
    if (expected.width !== actual.width || expected.height !== actual.height) {
        throw new Error(
            `compareImages: size mismatch ${expected.width}x${expected.height} vs ${actual.width}x${actual.height}`,
        );
    }

    const { width, height } = expected;
    const diff = new Uint8Array(width * height * 4);
    let differingPixels = 0;
    let maxChannelDelta = 0;
    let deltaSum = 0;

    for (let p = 0; p < diff.length; p += 4) {
        const dr = Math.abs(expected.data[p] - actual.data[p]);
        const dg = Math.abs(expected.data[p + 1] - actual.data[p + 1]);
        const db = Math.abs(expected.data[p + 2] - actual.data[p + 2]);
        const worst = Math.max(dr, dg, db);
        deltaSum += (dr + dg + db) / 3;
        if (worst > maxChannelDelta) maxChannelDelta = worst;

        if (worst > pixelThreshold) {
            differingPixels += 1;
            // Solid red: the eye finds a scattered handful of red pixels on a
            // dim backdrop far faster than a heat map of magnitudes.
            diff[p] = 255;
            diff[p + 1] = 0;
            diff[p + 2] = 0;
        } else {
            const dim = Math.round(
                (0.2126 * expected.data[p] + 0.7152 * expected.data[p + 1] + 0.0722 * expected.data[p + 2]) * 0.25,
            );
            diff[p] = dim;
            diff[p + 1] = dim;
            diff[p + 2] = dim;
        }
        diff[p + 3] = 255;
    }

    const pixels = width * height;
    return {
        width,
        height,
        differingPixels,
        differingFraction: pixels > 0 ? differingPixels / pixels : 0,
        maxChannelDelta,
        meanChannelDelta: pixels > 0 ? deltaSum / pixels : 0,
        ssim: meanSsim(expected, actual),
        diff: { width, height, data: diff },
    };
}

/**
 * @typedef {object} GoldenTolerance
 * @property {number} [minSsim] Minimum acceptable structural similarity.
 * @property {number} [maxDifferingFraction] Maximum share of pixels over the
 *   per-pixel threshold.
 * @property {number} [pixelThreshold] Per-pixel channel delta, passed to
 *   compareImages.
 */

/**
 * Applies a tolerance to a comparison.
 *
 * Both checks must pass. They fail different regressions on purpose — a broad,
 * subtle shift trips SSIM while barely moving the pixel count; a small block of
 * badly wrong pixels trips the pixel count while barely moving SSIM.
 *
 * @param {ImageComparison} comparison
 * @param {GoldenTolerance} tolerance
 * @returns {{ pass: boolean, failures: string[] }}
 */
export function evaluateComparison(comparison, tolerance) {
    const { minSsim = 0.995, maxDifferingFraction = 0.002 } = tolerance ?? {};
    const failures = [];

    if (comparison.ssim < minSsim) {
        failures.push(`ssim ${comparison.ssim.toFixed(6)} < ${minSsim}`);
    }
    if (comparison.differingFraction > maxDifferingFraction) {
        failures.push(
            `differing pixels ${(comparison.differingFraction * 100).toFixed(4)}% > ${(maxDifferingFraction * 100).toFixed(4)}%`,
        );
    }

    return { pass: failures.length === 0, failures };
}

/**
 * Lays images out left to right with a separator between them, for the
 * before/after/diff artifact a reviewer actually looks at.
 *
 * @param {RgbaImage[]} images Same height; typically [golden, actual, diff].
 * @param {object} [options]
 * @param {number} [options.gap] Separator width in pixels.
 * @returns {RgbaImage}
 */
export function composeStrip(images, { gap = 8 } = {}) {
    if (images.length === 0) throw new Error('composeStrip: no images');
    const height = Math.max(...images.map((image) => image.height));
    const width = images.reduce((sum, image) => sum + image.width, 0) + gap * (images.length - 1);
    const out = new Uint8Array(width * height * 4);

    // Mid-grey ground so both black separators and black frames stay visible.
    for (let i = 0; i < out.length; i += 4) {
        out[i] = 32;
        out[i + 1] = 32;
        out[i + 2] = 40;
        out[i + 3] = 255;
    }

    let xOffset = 0;
    for (const image of images) {
        for (let y = 0; y < image.height; y += 1) {
            const src = y * image.width * 4;
            const dst = (y * width + xOffset) * 4;
            out.set(image.data.subarray(src, src + image.width * 4), dst);
        }
        xOffset += image.width + gap;
    }

    return { width, height, data: out };
}
