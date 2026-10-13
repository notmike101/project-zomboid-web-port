/** @file Hand-authored map fixtures only; never installed game bytes. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openMapCell } from '../src/map-tiles.js';

/**
 * Encode one signed fixture field.
 *
 * @param {number} value - Signed field.
 * @returns {Buffer} LE bytes.
 */
function int(value) {
    const bytes = Buffer.alloc(4);

    bytes.writeInt32LE(value);

    return bytes;
}

/**
 * Encode a newline-terminated fixture name.
 *
 * @param {string} value - Catalogue or room string.
 * @returns {Buffer} Latin-1 line.
 */
function line(value) {
    return Buffer.from(`${value}\n`, 'latin1');
}

/**
 * Construct a synthetic header with one room and one building.
 *
 * @param {object} [options] - Fixture fields.
 * @param {string[]} [options.names] - Sprite catalogue.
 * @param {number} [options.min] - Lowest level.
 * @param {number} [options.max] - Highest level.
 * @param {number} [options.version] - Header version.
 * @param {number} [options.width] - Chunk width.
 * @returns {Buffer} Complete header.
 */
function header({ names = ['floor_0', 'wall_1'], min = -1, max = 1, version = 1, width = 8 } = {}) {
    return Buffer.concat([
        Buffer.from('LOTH'), int(version), int(names.length), ...names.map(line),
        int(width), int(8), int(min), int(max), int(1),
        line('test room'), int(0), int(1), int(2), int(3), int(4), int(5), int(0),
        int(1), int(1), int(0), Buffer.alloc(1_024),
    ]);
}

/**
 * Construct absolute chunk offsets and synthetic records.
 *
 * @param {Map<number, number[]>} bodies - Chunk-index to record integers.
 * @param {number} [marker] - Shipped or writer table marker.
 * @returns {Buffer} LOTP v1 fixture.
 */
function pack(bodies, marker = 8) {
    const table = Buffer.alloc(8_192);
    const chunks = [];
    let offset = 8_204;

    for (const [index, values] of [...bodies].sort(([a], [b]) => a - b)) {
        const body = Buffer.concat(values.map(int));

        table.writeBigInt64LE(BigInt(offset), index * 8);
        chunks.push(body);
        offset += body.length;
    }

    return Buffer.concat([Buffer.from('LOTP'), int(1), int(marker), table, ...chunks]);
}

/**
 * Record reads from real Blob slices while refusing eager whole-file access.
 *
 * @param {Buffer} bytes - Source bytes.
 * @returns {object} Blob-backed source with read accounting.
 */
function tracked(bytes) {
    const blob = new Blob([bytes]);
    const reads = [];

    return {
        size: blob.size, reads,
        /**
         * Refuse whole-file materialization.
         */
        arrayBuffer() {
            throw new Error('Whole-file reads are forbidden');
        },
        /**
         * Return an independently readable bounded slice.
         *
         * @param {number} start - First byte.
         * @param {number} end - Exclusive boundary.
         * @returns {object} Tracked slice.
         */
        slice(start, end) {
            return {
                /**
                 * Materialize a real slice and record its range.
                 *
                 * @returns {Promise<ArrayBuffer>} Slice bytes.
                 */
                arrayBuffer() {
                    reads.push([start, end]);

                    return blob.slice(start, end).arrayBuffer();
                },
            };
        },
    };
}

/**
 * Open paired fixture Blobs at nontrivial original cell coordinates.
 *
 * @param {Buffer} bytes - LOTP fixture.
 * @param {Buffer} [meta] - LOTH fixture.
 * @returns {Promise<object>} Imported map.
 */
function open(bytes, meta = header()) {
    return openMapCell({ cellX: 2, cellY: -3, header: new Blob([meta]), lotpack: new Blob([bytes]) });
}

// Catches transposed chunk/local axes, off-by-one skip, reset-at-z skip, and reordered tile stacks.
test('x-major chunks and squares preserve negative z, cross-level skip runs, stack order and room ids', async () => {
    const bytes = pack(new Map([[35, [-1, 63, 3, 0, 1, 0, -1, 2, 2, -1, 0, -1, 125]]]));
    const cell = await open(bytes);

    assert.deepEqual(await cell.readChunk(1, 3), [
        { x: 527, y: -737, z: -1, spriteName: 'wall_1', roomId: 0, order: 0 },
        { x: 527, y: -737, z: -1, spriteName: 'floor_0', roomId: 0, order: 1 },
        { x: 520, y: -742, z: 0, spriteName: 'floor_0', roomId: -1, order: 0 },
    ]);
    assert.deepEqual(await cell.readChunk(3, 1), []);
    assert.deepEqual(cell.rooms[0], { id: 0, name: 'test room', z: 0, rects: [{ x: 514, y: -765, width: 4, height: 5 }] });
});

// Catches eager body reads and accidental whole-file buffering.
test('opening reads only bounded header/index windows and selected chunks remain lazy', async () => {
    const bodies = new Map();

    for (let index = 0; index < 1_024; index += 1) {
        bodies.set(index, Array.from({ length: 64 }, () => [2, -1, 0]).flat());
    }

    const lotpack = tracked(pack(bodies));
    const meta = tracked(header({ min: 0, max: 0 }));
    const cell = await openMapCell({ cellX: 0, cellY: 0, header: meta, lotpack });

    assert.equal(lotpack.reads.reduce((sum, [start, end]) => sum + end - start, 0), 8_204);
    const openedReadCount = lotpack.reads.length;

    assert.equal((await cell.readChunk(20, 11)).length, 64);
    assert.ok(lotpack.reads.slice(openedReadCount).every(([start, end]) => start >= cell.chunks[651].offset && end <= cell.chunks[651].offset + cell.chunks[651].byteLength));
    assert.ok([...meta.reads, ...lotpack.reads].every(([start, end]) => end - start <= 16 * 1_024));
});

/* eslint-disable no-await-in-loop -- Each malformed fixture is rejected independently before advancing to the next case. */
// Catches silently shortened chunks, illegal skips, negative fields and unchecked catalogue/room references.
test('malformed records fail without returning partial or invented geometry', async () => {
    for (const [values, error] of [
        [[-1, 0], /skip/iu], [[-1, 193], /skip/iu], [[-2], /count/iu],
        [[2, -1, 2, -1, 191], /catalogue/iu], [[2, -1, -1, -1, 191], /catalogue/iu],
        [[2, 1, 0, -1, 191], /room/iu], [[3, -1, 0], /truncated/iu],
        [[-1, 191], /truncated/iu], [[-1, 192, 0], /trailing/iu],
    ]) {
        const cell = await open(pack(new Map([[0, values]])));

        await assert.rejects(cell.readChunk(0, 0), error);
    }
});
/* eslint-enable no-await-in-loop */

// Catches incorrect interpretation of count 0/1 as carrying a room/tile field.
test('empty count records and a final skip consume exactly the level range', async () => {
    const cell = await open(pack(new Map([[0, [0, 1, -1, 190]]])));

    assert.deepEqual(await cell.readChunk(0, 0), []);
    await assert.rejects(cell.readChunk(32, 0), /chunk/iu);
    await assert.rejects(cell.readChunk(0, 0.5), /chunk/iu);
});

// Catches permissive guessing of legacy/dimension/offset variants and missing final header bytes.
test('unsupported formats and truncated metadata/indexes are rejected explicitly', async () => {
    const bytes = pack(new Map([[0, [-1, 192]]]));

    await assert.rejects(open(bytes, header({ version: 0 })), /unsupported/iu);
    await assert.rejects(open(bytes, header({ width: 10 })), /unsupported/iu);
    await assert.rejects(open(bytes, header({ min: -33 })), /level/iu);
    await assert.rejects(open(bytes, header().subarray(0, -1)), /truncated/iu);
    await assert.rejects(open(bytes.subarray(0, 8_203)), Error);
    await assert.rejects(open(pack(new Map(), 30)), /unsupported/iu);
    const high = Buffer.from(bytes);

    high.writeBigInt64LE(9_007_199_254_740_992n, 12);
    await assert.rejects(open(high), /offset/iu);
    const overlap = pack(new Map([[0, [-1, 192]], [1, [-1, 192]]]));

    overlap.writeBigInt64LE(8_204n, 20);
    await assert.rejects(open(overlap), /offset/iu);
    const beforeTable = Buffer.from(bytes);

    beforeTable.writeBigInt64LE(12n, 12);
    await assert.rejects(open(beforeTable), /offset/iu);
});

test('the primary writer chunk-count marker uses the same geometry', async () => {
    const cell = await open(pack(new Map([[0, [-1, 192]]]), 1_024));

    assert.deepEqual(await cell.readChunk(0, 0), []);
});

// Catches unchecked coordinate multiplication, malformed sources and empty catalogue entries.
test('unsafe caller coordinates and invalid file/catalogue inputs fail at the boundary', async () => {
    const bytes = pack(new Map());
    const valid = { cellX: 0, cellY: 0, header: new Blob([header()]), lotpack: new Blob([bytes]) };

    await assert.rejects(openMapCell({ ...valid, cellX: Number.MAX_SAFE_INTEGER }), /coordinate/iu);
    await assert.rejects(openMapCell({ ...valid, cellY: 0.5 }), /coordinate/iu);
    await assert.rejects(openMapCell({ ...valid, header: {} }), /slice/iu);
    await assert.rejects(open(bytes, header({ names: [''] })), /catalogue/iu);
    await assert.rejects(open(bytes, header({ names: ['a'.repeat(4_097)] })), /string/iu);
});
