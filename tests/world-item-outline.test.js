import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sourceOutlinePixels, sourceOutlineRadius, sourceOutlineStorage } from '../src/world-item-outline.js';

/* Catches changed alpha threshold, missing +/-4 taps, normalizing rather than summing,
   applying color alpha only once, filling the source silhouette, or clamping source zoom. */
test('source outline uses a binary silhouette, two colored nine-tap sums and exterior exclusion', () => {
    assert.equal(sourceOutlineRadius(0), 0.5);
    assert.ok(Math.abs(sourceOutlineRadius(1.25) - 0.35) < 1e-12);
    assert.ok(Math.abs(sourceOutlineRadius(2.5) - 0.2) < 1e-12);
    assert.ok(Math.abs(sourceOutlineRadius(3.75) - 0.05) < 1e-12);
    const alpha = new Float32Array(13 * 13);

    alpha[6 * 13 + 6] = 0.5;
    alpha[0] = 0.499;
    const rgba = sourceOutlinePixels(alpha, 13, 13, [0.2, 0.4, 0.6, 0.5], 1);
    /**
     * Read a premultiplied RGBA texel from the thirteen-pixel-wide reference output.
     *
     * @param {number} x - Zero-based column.
     * @param {number} y - Zero-based row.
     * @returns {number[]} Four normalized premultiplied RGBA channels.
     */
    const pixel = (x, y) => Array.from(rgba.slice((y * 13 + x) * 4, (y * 13 + x + 1) * 4));

    assert.deepEqual(pixel(6, 6), [0, 0, 0, 0]);
    assert.deepEqual(pixel(0, 0), [0, 0, 0, 0]);
    assert.deepEqual(pixel(1, 6), [0, 0, 0, 0]);
    assert.deepEqual(pixel(2, 2), [0.2 * (64 / 255), 0.4 * (64 / 255), 0.6 * (64 / 255), 64 / 255]);
    assert.deepEqual(pixel(10, 10), pixel(2, 2));
    // At radius .5 the +/-4 taps reach precisely two pixels, never three.
    const half = sourceOutlinePixels(alpha, 13, 13, [1, 1, 1, 1], 0.5);

    assert.equal(half[(4 * 13 + 4) * 4 + 3], 1);
    assert.equal(half[(3 * 13 + 6) * 4 + 3], 0);
    // Transparent interior holes remain eligible exterior pixels, not a filled bbox.
    const ring = new Float32Array([1, 1, 1, 1, 0, 1, 1, 1, 1]);

    assert.equal(sourceOutlinePixels(ring, 3, 3, [1, 1, 1, 1], 1)[(1 * 3 + 1) * 4 + 3], 1);
});

// Catches rejecting supported DPR2 viewports or admitting dimensions beyond the renderer limit.
test('outline storage accepts the renderer high-DPI viewport without allocating pixels', () => {
    assert.equal(sourceOutlineStorage(3_840, 2_160), 132_710_400);
    assert.equal(sourceOutlineStorage(4_096, 4_096), 256 * 1_024 * 1_024);

    for (const [width, height] of [[4_097, 1], [1, 4_097], [0, 1], [1.5, 1], [Infinity, 1]]) {
        assert.throws(() => sourceOutlineStorage(width, height), RangeError);
    }
});
