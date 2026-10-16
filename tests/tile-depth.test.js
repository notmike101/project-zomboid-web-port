import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { createTileDepthAssets, decodeDepthPng, parseTileDepthAssignments } from '../src/tile-depth.js';

/**
 * Compute a PNG chunk checksum independently of the decoder.
 *
 * @param {Uint8Array} bytes - Chunk type and payload bytes.
 * @returns {number} Unsigned CRC-32.
 */
function crc(bytes) {
    let value = 0xFF_FF_FF_FF;

    for (const byte of bytes) {
        value ^= byte;

        for (let bit = 0; bit < 8; bit += 1) {
            value = (value >>> 1) ^ ((value & 1) ? 0xED_B8_83_20 : 0);
        }
    }

    return (value ^ 0xFF_FF_FF_FF) >>> 0;
}

/**
 * Encode a PNG chunk with its length and CRC.
 *
 * @param {string} type - Four-letter chunk type.
 * @param {Uint8Array|number[]} bytes - Chunk payload.
 * @returns {Buffer} Encoded chunk.
 */
function chunk(type, bytes) {
    const data = Buffer.from(bytes);
    const result = Buffer.alloc(data.length + 12);

    result.writeUInt32BE(data.length);
    result.write(type, 4);
    data.copy(result, 8);
    result.writeUInt32BE(crc(result.subarray(4, -4)), result.length - 4);

    return result;
}

/**
 * Build a noninterlaced 8-bit PNG fixture.
 *
 * @param {number} width - Image width.
 * @param {number} height - Image height.
 * @param {number} type - PNG color type.
 * @param {function(number, number): number[]} pixel - Samples for each pixel.
 * @param {number[]|null} palette - Optional RGB palette.
 * @param {number[]|null} alpha - Optional transparency payload.
 * @returns {Buffer} Complete encoded PNG.
 */
function png(width, height, type = 6, pixel = () => [255, 0, 19, 255], palette = null, alpha = null) {
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
    const header = Buffer.alloc(13);

    header.writeUInt32BE(width);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = type;
    const rows = Buffer.alloc(height * (width * channels + 1));

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            rows.set(pixel(x, y), y * (width * channels + 1) + 1 + x * channels);
        }
    }

    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), ...(palette ? [chunk('PLTE', palette)] : []), ...(alpha ? [chunk('tRNS', alpha)] : []), chunk('IDAT', deflateSync(rows)), chunk('IEND', [])]);
}

/**
 * Create a private content fixture with required native depth sheets.
 *
 * @param {{[key: string]: Uint8Array}} images - Sheets keyed by native name.
 * @param {string} assignments - Assignment fields after VERSION.
 * @returns {object} Manifest, file lookup, and mutable fixture bytes.
 */
function content(images, assignments = '') {
    const files = new Map(Object.entries(images).map(([name, bytes]) => [`media/depthmaps/DEPTH_${name}.png`, bytes]));

    for (const name of ['whole_tile', 'billboard', 'preset_depthmaps_01']) {
        if (!files.has(`media/depthmaps/DEPTH_${name}.png`)) {
            files.set(`media/depthmaps/DEPTH_${name}.png`, png(name === 'preset_depthmaps_01' ? 1_024 : 128, 256));
        }
    }

    const path = 'media/tileDepthTextureAssignments.txt';
    const manifest = { startup: { tileDepth: { assignments: path, images: [...files.keys()] } } };

    files.set(path, Buffer.from(`tileDepthTextureAssignments { VERSION = 1, ${assignments} }`));

    return {
        manifest,
        /**
         * Read advertised bytes from the fixture.
         *
         * @param {string} name - Advertised file path.
         * @returns {Blob} Fixture file.
         */
        getFile(name) {
            const bytes = files.get(name);

            if (!bytes) {
                throw new Error(`Missing advertised bytes: ${name}`);
            }

            return new Blob([bytes]);
        }, files,
    };
}

const ordinary = { objectClass: 'IsoObject' };

/**
 * Build the test sprite's immutable-registry representation.
 *
 * @param {Array<Array<string>>} properties - Native property entries.
 * @returns {Map<string, object>} Single-sprite registry.
 */
function registry(properties = []) {
    return new Map([['test_0', { name: 'test_0', tilesetName: 'test', tileSheetIndex: 0, properties: new Map(properties) }]]);
}

test('native file assignment parser trims, ignores blanks/self, keeps last duplicate and requires VERSION1', () => {
    const result = parseTileDepthAssignments('tileDepthTextureAssignments { VERSION = 1, a_0 = b_1, a_0 = c_2, a_0 = , a_0 = a_0, x_0 = x_0, }');

    assert.deepEqual([...result], [['a_0', 'c_2']]);
    assert.throws(() => parseTileDepthAssignments('tileDepthTextureAssignments { a_0=b_0, }'), /VERSION/);
    assert.throws(() => parseTileDepthAssignments('tileDepthTextureAssignments { VERSION=2, }'), /VERSION/);
});

test('lossless PNG decoding uses BLUE and unpremultiplied nonzero alpha in every original format', async () => {
    for (const [type, pixel, palette, alpha, blue, opacity] of [
        [6, () => [251, 7, 19, 1], undefined, undefined, 19, 1],
        [3, () => [0], [250, 9, 31], [2], 31, 2],
        [4, () => [42, 3], undefined, undefined, 42, 3],
        [0, () => [53], undefined, undefined, 53, 255],
    ]) {
        // eslint-disable-next-line no-await-in-loop -- Decode one bounded fixture at a time, retaining the same per-format assertions.
        const decoded = await decodeDepthPng(png(1, 1, type, pixel, palette, alpha));

        assert.equal(decoded.blue[0], blue);
        assert.equal(decoded.alpha[0], opacity);
    }
});

test('PNG ingestion rejects CRC corruption, truncation, oversized dimensions, bad palette and inflated overflow', async () => {
    const bytes = png(1, 1);
    const badCrc = Buffer.from(bytes);

    badCrc[20] ^= 1;
    await assert.rejects(decodeDepthPng(badCrc), /CRC/);
    await assert.rejects(decodeDepthPng(bytes.subarray(0, -3)), /Truncated|IEND/);
    await assert.rejects(decodeDepthPng(png(16_385, 1, 0, () => [1])), /dimension|bounds/);
    await assert.rejects(decodeDepthPng(png(1, 1, 3, () => [1], [1, 2, 3])), /palette/);
    const overflow = Buffer.concat([bytes.subarray(0, 33), chunk('IDAT', deflateSync(Buffer.alloc(100))), chunk('IEND', [])]);

    await assert.rejects(decodeDepthPng(overflow), /inflate|Inflat/);
});

test('direct nonempty map wins, assignments are exactly one hop and empty targets use source floor fallback', async () => {
    const source = content({ test: png(1_024, 256), target: png(1_024, 256, 6, () => [1, 2, 231, 255]) }, 'test_0=target_0, target_0=other_0,');
    let assets = await createTileDepthAssets(source, registry());

    assert.equal((await assets.resolve('test_0', ordinary)).source.path, 'media/depthmaps/DEPTH_test.png');
    source.files.set('media/depthmaps/DEPTH_test.png', png(1_024, 256, 6, () => [0, 0, 0, 0]));
    assets = await createTileDepthAssets(source, registry());
    assert.equal((await assets.resolve('test_0', ordinary)).pixels[100 * 128], 231);
    source.files.set('media/depthmaps/DEPTH_target.png', png(1_024, 256, 6, () => [0, 0, 0, 0]));
    assets = await createTileDepthAssets(source, registry([['solidfloor', 'true']]));
    assert.equal((await assets.resolve('test_0', ordinary)).source.index, 0);
    const oneHop = content({ target: png(1_024, 256, 6, () => [0, 0, 0, 0]), other: png(1_024, 256) }, 'test_0=target_0, target_0=other_0,');

    assert.equal((await (await createTileDepthAssets(oneHop, registry())).resolve('test_0', ordinary)).source.path, 'media/depthmaps/DEPTH_whole_tile.png');
});

test('native top64 clamp keeps invalid alpha0, promotes valid blue0, excludes roofs and resets per local tile row', async () => {
    const data = png(1_024, 512, 6, (x) => [255, 0, 0, x === 1 ? 0 : 1]);
    const assets = await createTileDepthAssets(content({ test: data, roofs_test: data }), registry());
    const first = await assets.resolve('test_0', ordinary);

    assert.equal(first.pixels[0], 129);
    assert.equal(first.pixels[1], 0);
    assert.equal(first.pixels[63 * 128], 3);
    assert.equal(first.pixels[64 * 128], 1);
    assert.equal(first.pixels[255 * 128], 1);
    assert.equal((await assets.resolve('test_8', ordinary)).pixels[0], 129);
    assert.equal((await assets.resolve('roofs_test_0', ordinary)).pixels[0], 1);
    assert.deepEqual([first.width, first.height, first.offsetX, first.offsetY], [128, 256, 0, 0]);
    assert.equal((await assets.resolve('test_16', ordinary)).source.path, 'media/depthmaps/DEPTH_whole_tile.png');
});

test('native fallback precedence uses floor/render layer, parent map, window and doorframe presets, then whole tile', async () => {
    const source = content({ parent: png(1_024, 256) });
    /**
     * Select the source descriptor for one fallback context.
     *
     * @param {Array<Array<string>>} props - Native sprite property entries.
     * @param {object} context - Proven owner and render state.
     * @returns {Promise<{path: string, index: number}>} Selected native source.
     */
    const select = async (props, context = ordinary) => (await (await createTileDepthAssets(source, registry(props))).resolve('test_0', context)).source;

    assert.equal((await select([['RenderLayer', 'Floor']])).index, 0);
    assert.equal((await select([['WallOverlay', 'true'], ['attachedW', 'true']], { objectClass: 'IsoObject', parentSpriteName: 'parent_0', isParentSprite: false })).path, 'media/depthmaps/DEPTH_parent.png');
    assert.equal((await select([['windowN', 'true'], ['DoorWallN', 'true']])).index, 3);
    assert.equal((await select([['windowW', 'true'], ['DoorWallW', 'true'], ['doorW', 'true']])).index, 4);
    assert.equal((await select([])).path, 'media/depthmaps/DEPTH_whole_tile.png');
});

test('native object exclusions retain ordinary less-equal policy; attached fire uses actual billboard', async () => {
    const assets = await createTileDepthAssets(content({}), registry());

    assert.deepEqual(await assets.resolve('test_0', { objectClass: 'IsoCarBatteryCharger' }), { kind: 'untextured', depthTest: 'less-equal', depthWrite: true, reason: 'IsoCarBatteryCharger', geometry: { scaleX: 1, scaleY: 1, soffX: 0, soffY: 0 } });
    assert.equal((await assets.resolve('test_0', { objectClass: 'IsoFire', isParentSprite: false })).source.path, 'media/depthmaps/DEPTH_billboard.png');
    await assert.rejects(assets.resolve('test_0', {}), /objectClass/);
    await assert.rejects(assets.resolve('test_0', { objectClass: 'IsoBarbecue' }), /isParentSprite/);
});

test('advertised missing bytes and hostile manifest paths fail rather than inventing native absence', async () => {
    const source = content({ test: png(1_024, 256) });

    source.files.delete('media/depthmaps/DEPTH_test.png');
    const assets = await createTileDepthAssets(source, registry());

    await assert.rejects(assets.resolve('test_0', ordinary), /Missing advertised/);
    source.manifest.startup.tileDepth.images.push('media/depthmaps/../outside.png');
    await assert.rejects(createTileDepthAssets(source, registry()), /path|inventory/);
});

test('additional native seam draws use alpha masks, source quad vertices, wrapped filter gutters and independent depth', async () => {
    const source = content({});

    source.manifest.startup.tileDepth.seams = 'media/depthmaps/SEAMS_01.png';
    source.files.set(source.manifest.startup.tileDepth.seams, png(1_024, 256, 6, (x, y) => [255, 0, 0, x === 1_023 && y === 255 ? 17 : 0]));
    const assets = await createTileDepthAssets(source, registry([['solidfloor', 'true']]));
    const base = await assets.resolve('test_0', { ...ordinary, seams: [{ name: 'FloorSouth', screenOffset: { x: -6, y: 3 } }] });

    assert.equal(base.seam, undefined);
    assert.equal(base.additionalDraws.length, 1);
    const draw = base.additionalDraws[0];

    assert.deepEqual(draw.screenOffset, { x: -6, y: 3 });
    assert.deepEqual(draw.seam.vertices, [5, 221, 69, 253, 63, 256, -1, 224]);
    assert.deepEqual([draw.seam.mask.width, draw.seam.mask.height, draw.seam.mask.offsetX, draw.seam.mask.offsetY], [132, 260, -2, -2]);
    assert.equal(draw.seam.mask.pixels[132 + 1], 17);
    assert.equal(draw.source.index, 0);
    assert.notEqual(draw.key, base.key);
    source.files.delete(source.manifest.startup.tileDepth.seams);
    await assert.rejects(assets.resolve('test_0', { ...ordinary, seam: 'FloorSouth' }), /Missing advertised/);
});

test('all five PNG filters reconstruct exact scanlines instead of transforming depth samples', async () => {
    const header = png(2, 2, 0, () => [0]).subarray(0, 33);
    const encoded = [
        [0, 10, 20, 0, 30, 40],
        [1, 10, 10, 1, 30, 10],
        [2, 10, 20, 2, 20, 20],
        [3, 10, 15, 3, 25, 15],
        [4, 10, 10, 4, 20, 10],
    ];

    for (const rows of encoded) {
        const image = Buffer.concat([header, chunk('IDAT', deflateSync(Buffer.from(rows))), chunk('IEND', [])]);

        // eslint-disable-next-line no-await-in-loop -- Check each filter serially without retaining multiple inflated fixtures.
        assert.deepEqual([...(await decodeDepthPng(image)).blue], [10, 20, 30, 40]);
    }
});

test('empty native floor presets remain transparent textures, never whole-tile substitutes', async () => {
    const source = content({ preset_depthmaps_01: png(1_024, 256, 4, () => [255, 0]) });
    const assets = await createTileDepthAssets(source, registry([['solidfloor', 'true']]));
    const result = await assets.resolve('test_0', ordinary);

    assert.equal(result.kind, 'texture');
    assert.equal(result.source.path, 'media/depthmaps/DEPTH_preset_depthmaps_01.png');
    assert.equal(result.pixels.some(Boolean), false);
});

test('native suppressed placements do not require an invented owner and effective sprites select both assets', async () => {
    const assets = await createTileDepthAssets(content({ target: png(1_024, 256) }), registry());

    assert.equal((await assets.resolve('test_0', { rendered: false })).kind, 'suppressed');
    const result = await assets.resolve('test_0', { ...ordinary, currentSpriteName: 'target_0' });

    assert.equal(result.spriteName, 'target_0');
    assert.equal(result.source.path, 'media/depthmaps/DEPTH_target.png');
});

test('source wall renderer direction is explicit and overrides ordinary floor fallback', async () => {
    const assets = await createTileDepthAssets(content({}), registry([['solidfloor', 'true'], ['DoorWallN', 'true']]));

    assert.equal((await assets.resolve('test_0', { ...ordinary, wallDirection: 'N' })).source.index, 3);
    assert.equal((await assets.resolve('test_0', { ...ordinary, wallDirection: 'NW' })).source.index, 6);
    assert.equal((await assets.resolve('test_0', { ...ordinary, wallDirection: 'SE' })).source.index, 7);
    await assert.rejects(assets.resolve('test_0', { ...ordinary, wallDirection: 'invalid' }), /direction/);
});

test('native whole_tile and billboard remain one-by-one even when a supplied image has extra rows', async () => {
    const source = content({ whole_tile: png(128, 512), billboard: png(128, 512) }, 'test_0=billboard_1,');
    const assets = await createTileDepthAssets(source, registry());

    assert.equal((await assets.resolve('test_0', ordinary)).source.path, 'media/depthmaps/DEPTH_whole_tile.png');
    assert.equal((await assets.resolve('whole_tile_1', ordinary)).source.index, 0);
});

test('concurrent duplicate placements share cropped bytes without sharing context geometry', async () => {
    const assets = await createTileDepthAssets(content({ test: png(1_024, 256) }), registry());
    const [first, second] = await Promise.all([
        assets.resolve('test_0', ordinary),
        assets.resolve('test_0', { ...ordinary, scaleX: 2 }),
    ]);

    assert.equal(first.pixels, second.pixels);
    assert.notEqual(first.geometry, second.geometry);
    assert.equal(first.geometry.scaleX, 1);
    assert.equal(second.geometry.scaleX, 2);
});

test('source scene property snapshots preserve mutations absent from the immutable tile registry', async () => {
    const assets = await createTileDepthAssets(content({}), registry());
    const result = await assets.resolve('test_0', {
        ...ordinary,
        spriteProperties: Object.freeze({ windowN: 'true', DoorWallN: 'true' }),
    });

    assert.equal(result.source.index, 3);
    assert.equal(result.source.path, 'media/depthmaps/DEPTH_preset_depthmaps_01.png');
});

test('moving native owner position follows texture, untextured and additional seam draws without mutating context', async () => {
    const source = content({});

    source.manifest.startup.tileDepth.seams = 'media/depthmaps/SEAMS_01.png';
    source.files.set(source.manifest.startup.tileDepth.seams, png(1_024, 256));
    const assets = await createTileDepthAssets(source, registry([['solidfloor', 'true']]));
    const renderPosition = Object.freeze({ x: 0.5, y: -2, z: 1 });
    const result = await assets.resolve('test_0', {
        ...ordinary, renderPosition,
        seams: [{ name: 'FloorSouth', screenOffset: { x: -6, y: 3 } }],
    });

    assert.deepEqual(result.renderPosition, renderPosition);
    assert.notEqual(result.renderPosition, renderPosition);
    assert.deepEqual(result.additionalDraws[0].renderPosition, renderPosition);
    assert.deepEqual((await assets.resolve('test_0', { objectClass: 'IsoCarBatteryCharger', renderPosition })).renderPosition, renderPosition);
    await assert.rejects(assets.resolve('test_0', { ...ordinary, renderPosition: { x: Number.NaN, y: 0, z: 0 } }), /renderPosition/);
});

test('excluded native trees adjust only depth position by their original .99 square offset', async () => {
    const assets = await createTileDepthAssets(content({}), registry());
    const result = await assets.resolve('test_0', { objectClass: 'IsoTree', renderPosition: { x: 3, y: 4, z: 0 } });

    assert.equal(result.kind, 'untextured');
    assert.deepEqual(result.depthPositionOffset, { x: 0.99, y: 0.99 });
    assert.deepEqual(result.renderPosition, { x: 3, y: 4, z: 0 });
    assert.equal(result.screenOffset, undefined);
});
