import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareTiles, createSpriteResidencyPlan, isTileVisible, spriteQuad, tileScreenPosition, visibleChunkBounds } from '../src/tile-renderer.js';

const PAGE = { width: 1_024, height: 1_024 };
const SPRITE = { x: 321, y: 417, w: 117, h: 235, xoff: 5, yoff: 13, totalW: 256, totalH: 512 };
const DOUBLE_ANCHOR = { x: 128, y: 384, nativeTilePixels: 256 };

// Catches losing trim offsets, atlas edges, or scaling trimmed width as the entire canvas.
test('original atlas trim becomes a native anchored quad, not a stretched sprite', () => {
    assert.deepEqual(spriteQuad(SPRITE, PAGE, 256, DOUBLE_ANCHOR), {
        left: -123, top: -371, width: 117, height: 235,
        u0: 321 / 1_024, v0: 417 / 1_024, u1: 438 / 1_024, v1: 652 / 1_024,
    });
    const scaled = spriteQuad(SPRITE, PAGE, 64, DOUBLE_ANCHOR);

    assert.equal(scaled.left, -123 / 4);
    assert.equal(scaled.top, -371 / 4);
    assert.equal(scaled.width, 117 / 4);
    assert.equal(scaled.height, 235 / 4);
    assert.equal(scaled.u1, 438 / 1_024);
});

// Catches hard-coded centring that ignores explicit native-offset calibration.
test('native tile anchor can be calibrated without changing original world coordinates', () => {
    const quad = spriteQuad(SPRITE, PAGE, 128, { x: 120, y: 400, nativeTilePixels: 256 });

    assert.equal(quad.left, -115 / 2);
    assert.equal(quad.top, -387 / 2);
    assert.deepEqual(tileScreenPosition({ x: 193, y: 194, z: 2 }, { x: 193, y: 194 }, 64), { x: 0, y: -192, depth: 0.496 });
    assert.deepEqual(tileScreenPosition({ x: 194, y: 194, z: 0 }, { x: 193, y: 194 }, 64), { x: 32, y: 16, depth: 0.498 });
});

// Catches sampling beyond the page, trim beyond the native canvas, and division by zero.
test('trim validation admits exact atlas boundaries and transparent zero-size sprites', () => {
    assert.equal(spriteQuad({ ...SPRITE, x: 907, y: 789 }, PAGE, 64).u1, 1);
    assert.equal(spriteQuad({ ...SPRITE, x: 907, y: 789 }, PAGE, 64).v1, 1);
    assert.equal(spriteQuad({ ...SPRITE, w: 0, h: 0, xoff: 256, yoff: 512 }, PAGE, 64).width, 0);
    assert.throws(() => spriteQuad({ ...SPRITE, x: 908 }, PAGE, 64), /atlas/iu);
    assert.throws(() => spriteQuad({ ...SPRITE, xoff: 140 }, PAGE, 64), /trim/iu);
    assert.throws(() => spriteQuad(SPRITE, PAGE, 0), /scale/iu);
});

// Catches row-major or truncating negative chunks, missing tall occluders, and z cropping.
test('visible chunk bounds include negative cells, tall sprites and elevated anchors', () => {
    const bounds = visibleChunkBounds({ x: -1, y: -1, width: 640, height: 640, tilePixels: 64 }, {
        left: -32, right: 32, top: -128, bottom: 32, minLevel: -1, maxLevel: 2,
    });

    assert.deepEqual(bounds, { minX: -3, maxX: 3, minY: -3, maxY: 3 });
    // The z=2 anchor is outside the viewport but its tall wall reaches into it.
    const point = tileScreenPosition({ x: 19, y: 19, z: 2 }, { x: -1, y: -1 }, 64);

    assert.equal(point.y - 128 <= 320, true);
    assert.equal(Math.floor(19 / 8) <= bounds.maxX, true);
    assert.throws(() => visibleChunkBounds({ x: 0, y: 0, width: 0, height: 1, tilePixels: 1 }), /viewport/iu);
});

// Catches inverted south/east depth, roof depth and record-stack reordering across pages.
test('depth sorting preserves near south/east, elevated geometry and original stack order', () => {
    const base = { x: 193, y: 194, z: 0, order: 0 };
    const east = { ...base, x: 194 };
    const upper = { ...base, z: 1 };
    const overlay = { ...base, order: 1 };

    assert.equal(compareTiles({ tile: base }, { tile: east }) < 0, true);
    assert.equal(compareTiles({ tile: base }, { tile: upper }) < 0, true);
    assert.equal(compareTiles({ tile: base }, { tile: overlay }) < 0, true);
    assert.equal(compareTiles({ tile: base }, { tile: base }), 0);
});

// Catches confusing a 128px source tile with a 256px tile or anchoring the floor centre.
test('nominal 128x256 floors anchor at the diamond top and meet neighbouring world tiles', () => {
    const floor = { x: 0, y: 0, w: 128, h: 64, xoff: 0, yoff: 192, totalW: 128, totalH: 256 };
    const quad = spriteQuad(floor, PAGE, 64);
    const camera = { x: 193, y: 194 };

    assert.equal(quad.left, -32);
    assert.equal(quad.top, 0);
    assert.equal(quad.width, 64);
    assert.equal(quad.height, 32);
    assert.equal(tileScreenPosition({ x: 193.5, y: 194.5, z: 0 }, camera, 64).y, quad.height / 2);
    assert.equal(tileScreenPosition({ x: 194, y: 194, z: 0 }, camera, 64).x, quad.width / 2);
    assert.equal(tileScreenPosition({ x: 194, y: 194, z: 0 }, camera, 64).y, quad.height / 2);
});

// Catches admitting entire chunks/pages when only trimmed rectangles touching the screen matter.
test('exact viewport culling includes elevated wall overhang but excludes edge-only and transparent rectangles', () => {
    const view = { x: 0, y: 0, width: 640, height: 640, tilePixels: 64 };
    const quad = { left: -32, top: -128, width: 64, height: 128 };

    assert.equal(isTileVisible({ x: 19, y: 19, z: 2 }, quad, view), true);
    assert.equal(isTileVisible({ x: 20, y: 20, z: 2 }, quad, view), false);
    assert.equal(isTileVisible({ x: 0, y: 0, z: 0 }, { ...quad, width: 0 }, view), false);
    assert.equal(isTileVisible({ x: 6, y: -5, z: 0 }, { left: -32, top: 0, width: 64, height: 32 }, view), false);
    assert.equal(isTileVisible({ x: 5, y: -5, z: 0 }, { left: -32, top: 0, width: 64, height: 32 }, view), true);
});

// Catches charging a whole atlas, double-charging repeated sprites, or overshooting a hard budget.
test('cropped residency charges unique original trim rectangles and never exceeds budget', () => {
    const sprites = [
        { key: 'pack:0:0', w: 128, h: 64 },
        { key: 'pack:0:0', w: 128, h: 64 },
        { key: 'pack:0:1', w: 64, h: 128 },
        { key: 'pack:1:0', w: 256, h: 256 },
    ];
    const plan = createSpriteResidencyPlan(sprites, 65_536);

    assert.deepEqual([...plan.selected], ['pack:0:0', 'pack:0:1']);
    assert.deepEqual(plan.deferred, ['pack:1:0']);
    assert.equal(plan.bytes, 65_536);
    assert.equal(createSpriteResidencyPlan(sprites, 32_767).bytes, 0);
    assert.equal(createSpriteResidencyPlan([{ key: 'transparent', w: 0, h: 0 }], 4).selected.size, 0);
    assert.throws(() => createSpriteResidencyPlan([{ key: 'bad', w: -1, h: 1 }], 4), /dimensions/iu);
});
