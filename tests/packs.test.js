/** @file Synthetic pack fixtures only; no installed game bytes are retained. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { openContentDirectory } from '../src/content.js';
import { openPack } from '../src/packs.js';

/**
 * Encode one synthetic little-endian integer.
 *
 * @param {number} value - Integer.
 * @returns {Buffer} Little-endian field.
 */
function integer(value) {
    const bytes = Buffer.alloc(4);

    bytes.writeUInt32LE(value);

    return bytes;
}

/**
 * Encode a synthetic length-prefixed UTF-8 string.
 *
 * @param {string} value - Name.
 * @returns {Buffer} Length-prefixed UTF-8.
 */
function string(value) {
    const bytes = Buffer.from(value);

    return Buffer.concat([integer(bytes.length), bytes]);
}

/**
 * Compute the standard PNG checksum for synthetic chunks.
 *
 * @param {Buffer} bytes - Chunk type and data.
 * @returns {number} PNG CRC.
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
 * Construct a checksummed synthetic PNG chunk.
 *
 * @param {string} type - Chunk type.
 * @param {Buffer} data - Payload.
 * @returns {Buffer} PNG chunk.
 */
function chunk(type, data) {
    const length = Buffer.alloc(4);

    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const checksum = Buffer.alloc(4);

    checksum.writeUInt32BE(crc(body));

    return Buffer.concat([length, body, checksum]);
}

/**
 * Construct a decodable synthetic PNG with optional large ancillary data.
 *
 * @param {number} [padding] - Ancillary chunk bytes.
 * @returns {Buffer} Valid synthetic 1024-square RGBA PNG.
 */
function png(padding = 0) {
    const header = Buffer.alloc(13);

    header.writeUInt32BE(1_024, 0);
    header.writeUInt32BE(1_024, 4);
    header[8] = 8;
    header[9] = 6;
    const chunks = [chunk('IHDR', header)];

    if (padding) {
        chunks.push(chunk('tEXt', Buffer.concat([Buffer.from('padding\0'), Buffer.alloc(padding, 65)])));
    }

    chunks.push(chunk('IDAT', deflateSync(Buffer.alloc(1_024 * (1_024 * 4 + 1)))));
    chunks.push(chunk('IEND', Buffer.alloc(0)));

    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]);
}

const IMAGE = png();
const GEOMETRY = [321, 417, 117, 235, 5, 13, 128, 256];

/**
 * Encode a sprite's atlas rectangle and reconstructed-canvas geometry.
 *
 * @param {string} name - Sprite name.
 * @param {number[]} [geometry] - Rect and trim.
 * @returns {Buffer} Entry.
 */
function sprite(name, geometry = GEOMETRY) {
    return Buffer.concat([string(name), ...geometry.map(integer)]);
}

/**
 * Encode one page's metadata and embedded PNG.
 *
 * @param {string} name - Page name.
 * @param {Buffer[]} entries - Sprites.
 * @param {Buffer} [image] - PNG.
 * @param {boolean} [legacy] - Legacy stream.
 * @returns {Buffer} Page.
 */
function page(name, entries, image = IMAGE, legacy = false) {
    return Buffer.concat([string(name), integer(entries.length), integer(1), ...entries, ...(legacy ? [] : [integer(image.length)]), image]);
}

/**
 * Encode a pack header with the actual number of page buffers.
 *
 * @param {Buffer[]} pages - Pages.
 * @param {boolean} [legacy] - Legacy stream.
 * @returns {Buffer} Pack.
 */
function pack(pages, legacy = false) {
    return Buffer.concat([...(legacy ? [] : [Buffer.from('PZPK'), integer(1)]), integer(pages.length), ...pages]);
}

/**
 * Wrap a real Blob to record slicing and refuse eager whole-file reads.
 *
 * @param {Buffer} bytes - Synthetic source.
 * @returns {object} Blob-backed source recording actual reads.
 */
function tracked(bytes) {
    const blob = new Blob([bytes]);
    const reads = [];
    const slices = [];

    return {
        name: 'synthetic.pack', size: blob.size, lastModified: 1_234,
        webkitRelativePath: 'texturepacks/synthetic.pack', reads, slices,
        /**
         * Refuse eager access to the source so tests catch whole-pack buffering.
         */
        arrayBuffer() {
            throw new Error('whole-source read forbidden');
        },
        /**
         * Return a real Blob slice and record its byte range.
         *
         * @param {number} start - Slice start.
         * @param {number} end - Slice end.
         * @param {string} [type] - Blob content type.
         * @returns {Blob} Tracked slice.
         */
        slice(start, end, type) {
            slices.push([start, end, type]);
            const result = blob.slice(start, end, type);

            /**
             * Materialize a slice while recording exactly which bytes were read.
             *
             * @returns {Promise<ArrayBuffer>} Real slice bytes.
             */
            result.arrayBuffer = () => {
                reads.push([start, end]);

                return Blob.prototype.arrayBuffer.call(result);
            };

            return result;
        },
    };
}

test('PZPK preserves trim geometry, provenance and duplicates without mutable index state', async () => {
    const file = tracked(pack([
        page('Tiles2x0', [sprite('fixtures_doors_01_0'), sprite('same')]),
        page('Tiles2x1', [sprite('same', [0, 0, 64, 128, 0, 0, 64, 128])]),
    ]));
    const index = await openPack(file);

    assert.equal(index.format, 'PZPK');
    assert.equal(index.version, 1);
    assert.deepEqual(index.source, { name: 'synthetic.pack', size: file.size, lastModified: 1_234, relativePath: 'texturepacks/synthetic.pack' });
    assert.deepEqual(index.lookup('fixtures_doors_01_0'), {
        name: 'fixtures_doors_01_0', pageIndex: 0, entryIndex: 0,
        x: 321, y: 417, w: 117, h: 235, xoff: 5, yoff: 13, totalW: 128, totalH: 256,
    });
    assert.equal(index.lookup('same').pageIndex, 0);
    assert.deepEqual(index.lookupAll('same').map((entry) => entry.pageIndex), [0, 1]);
    assert.equal(index.lookup('missing'), undefined);
    assert.deepEqual(index.lookupAll('missing'), []);
    assert.equal(index.findByPrefix('fixtures_doors_01_').length, 1);
    assert.equal(index.pages[0].width, 1_024);
    assert.equal(index.pages[0].height, 1_024);
    assert.equal(index.pages[0].hasAlpha, 1);
    assert.throws(() => {
        index.pages[0].sprites[0].x = 99;
    }, TypeError);
    assert.throws(() => {
        index.pages.push({});
    }, TypeError);
    assert.throws(() => {
        index.lookupAll('same').pop();
    }, TypeError);
    await assert.rejects(index.pageBlob(-1), /page index/i);
    await assert.rejects(index.pageBlob(0.5), /page index/i);
    await assert.rejects(index.pageBlob(2), /page index/i);
    const previousReads = file.reads.length;
    const image = await index.pageBlob(1);

    assert.equal(image.type, 'image/png');
    assert.equal(file.reads.length, previousReads, 'creating a page Blob must not materialize bytes');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), IMAGE);
    assert.deepEqual(file.slices.at(-1), [index.pages[1].pngStart, index.pages[1].pngEnd, 'image/png']);
});

test('113-page indexing uses bounded metadata reads and skips large PNG payloads', async () => {
    const image = png(256 * 1_024);
    const pages = Array.from({ length: 113 }, (_, index) => page(`Tiles2x${index}`, [sprite(`floor_${index}`)], image));
    const file = tracked(pack(pages));
    const index = await openPack(file);

    assert.equal(index.pages.length, 113);
    assert.equal(index.lookup('floor_112').pageIndex, 112);
    assert.ok(file.reads.every(([start, end]) => end - start <= 16 * 1_024));
    assert.ok(file.reads.reduce((sum, [start, end]) => sum + end - start, 0) < file.size / 10);
    assert.equal((await index.pageBlob(112)).size, image.length);
});

test('metadata windows cross UTF-8 strings and geometry without losing entries', async () => {
    const entries = Array.from({ length: 600 }, (_, index) => sprite(`sprites_é_${index}`));
    const index = await openPack(tracked(pack([page('page', entries)])));

    assert.equal(index.sprites.length, 600);
    assert.equal(index.lookup('sprites_é_599').entryIndex, 599);
    assert.equal(index.lookup('sprites_é_599').totalH, 256);
});

test('legacy PNG chunk skipping handles optional DEADBEEF markers and multiple pages', async () => {
    const marker = integer(0xDE_AD_BE_EF);

    await Promise.all([Buffer.alloc(0), marker].map(async (boundary) => {
        const file = tracked(pack([
            Buffer.concat([page('legacy0', [sprite('old_0')], IMAGE, true), boundary]),
            Buffer.concat([page('legacy1', [sprite('old_1')], IMAGE, true), marker]),
        ], true));
        const index = await openPack(file);

        assert.equal(index.format, 'legacy');
        assert.equal(index.version, 0);
        assert.equal(index.pages.length, 2);
        assert.deepEqual(Buffer.from(await (await index.pageBlob(0)).arrayBuffer()), IMAGE);
        assert.equal(index.lookup('old_1').pageIndex, 1);
    }));
});

test('truncated headers, strings, entry fields and PNG ranges are refused explicitly', async () => {
    const valid = pack([page('page', [sprite('sprite')])]);

    await Promise.all([0, 3, 7, 11, 14, 18, 27, 45, 72, valid.length - 1].map((length) =>
        assert.rejects(openPack(tracked(valid.subarray(0, length))), /truncat/i)));

    const invalidLength = Buffer.from(valid);
    const imageLengthOffset = 12 + 4 + 4 + 8 + 4 + 6 + 32;

    invalidLength.writeUInt32LE(0xFF_FF_FF_FF, imageLengthOffset);
    await assert.rejects(openPack(tracked(invalidLength)), /truncat|length/i);
});

test('unsupported versions and excessive counts or strings are refused before allocations', async () => {
    await assert.rejects(openPack(tracked(Buffer.concat([Buffer.from('PZPK'), integer(2), integer(1)]))), /version/i);

    await Promise.all([0, 513, 0xFF_FF_FF_FF].map((count) =>
        assert.rejects(openPack(tracked(Buffer.concat([Buffer.from('PZPK'), integer(1), integer(count)]))), /page count|limit/i)));

    await assert.rejects(openPack(tracked(Buffer.concat([integer(1), integer(4_097)]))), /string|limit/i);
    await assert.rejects(openPack(tracked(Buffer.concat([integer(1), string('page'), integer(0xFF_FF_FF_FF), integer(1)]))), /entry count|limit/i);
});

test('invalid trim/canvas and atlas rectangles are refused rather than silently clipped', async () => {
    await Promise.all([
        [0, 0, 117, 235, 20, 13, 128, 256],
        [0, 0, 117, 235, 5, 30, 128, 256],
        [1_000, 0, 117, 235, 5, 13, 128, 256],
        [0, 1_000, 117, 235, 5, 13, 128, 256],
        [0, 0, 1, 1, 0, 0, 0, 0],
    ].map((geometry) =>
        assert.rejects(openPack(tracked(pack([page('page', [sprite('bad', geometry)])]))), /rect|canvas|offset/i)));
});

test('bad PNG signatures, lengths, terminal chunks and trailing bytes fail at indexing', async () => {
    const signature = Buffer.from(IMAGE);

    signature[0] = 0;
    await assert.rejects(openPack(tracked(pack([page('page', [], signature)]))), /png/i);
    const noEnd = IMAGE.subarray(0, -12);

    await assert.rejects(openPack(tracked(pack([page('page', [], noEnd)]))), /iend|png/i);
    const brokenChunk = Buffer.from(IMAGE);

    brokenChunk.writeUInt32BE(0xFF_FF_FF_FF, 33);
    await assert.rejects(openPack(tracked(pack([page('page', [], brokenChunk, true)], true))), /truncat|chunk|length/i);
    await assert.rejects(openPack(tracked(Buffer.concat([pack([page('page', [])]), Buffer.from('junk')]))), /trailing/i);
    await assert.rejects(openPack(tracked(Buffer.concat([pack([page('page', [], IMAGE, true)], true), Buffer.from('junk')]))), /trailing/i);
});

test('opaque signed alpha fields and transparent trimmed sprites survive indexing', async () => {
    const bytes = pack([page('page', [sprite('transparent', [0, 0, 0, 0, 128, 256, 128, 256])])]);

    bytes.writeUInt32LE(0xFF_FF_FF_FF, 24);
    const index = await openPack(new Blob([bytes]));

    assert.equal(index.pages[0].hasAlpha, -1);
    assert.equal(index.lookup('transparent').w, 0);
    assert.equal(index.lookup('transparent').xoff, 128);
    assert.equal(index.source.name, '');
    assert.equal(index.source.lastModified, null);
});

test('invalid UTF-8, control names and malformed source sizes are explicit refusals', async () => {
    const bytes = pack([page('page', [])]);

    bytes[16] = 0xFF;
    await assert.rejects(openPack(tracked(bytes)), /utf-8/i);
    await assert.rejects(openPack(tracked(pack([page('bad\u0000name', [])]))), /control/i);

    await Promise.all([-1, Number.NaN, Number.MAX_SAFE_INTEGER + 1].map((size) =>
        assert.rejects(openPack({ size, slice: Blob.prototype.slice }), /source/i)));

    await assert.rejects(openPack({
        size: 100,
        /**
         * Simulate a source that cannot return its declared bytes.
         *
         * @returns {Blob} An empty, truncated slice.
         */
        slice() {
            return new Blob([]);
        },
    }), /truncat/i);
});

test('HTTP indexing skips large pack payloads and materializes only the requested page', async (t) => {
    const image = png(256 * 1_024);
    const bytes = pack(Array.from({ length: 113 }, (_, index) => page(`page${index}`, [sprite(`floor_${index}`)], image)));
    const path = 'media/texturepacks/Tiles2x.pack';
    const ranges = [];
    const document = {
        format: 'pz-web-content-directory', formatVersion: 1, sourceBuild: {},
        files: [{ path, size: bytes.length, lastModified: 1_234 }],
        startup: {
            packs: [path], cells: [{ x: 0, y: 0, navigation: path, header: path, lotpack: path }],
            character: { model: path, idle: path, walk: path, texture: path }, spawn: { x: 190.5, y: 190.5 },
        },
        mods: [],
    };

    t.mock.method(globalThis, 'fetch', (url, options) => {
        if (String(url).endsWith('/manifest.json')) {
            return Promise.resolve(new Response(JSON.stringify(document)));
        }

        const match = /^bytes=(\d+)-(\d+)$/u.exec(options.headers.Range);

        assert.ok(match, 'every asset fetch must request a bounded range');
        const start = Number(match[1]);
        const end = Number(match[2]) + 1;

        ranges.push([start, end]);

        return Promise.resolve(new Response(bytes.subarray(start, end), {
            status: 206, headers: { 'Content-Range': `bytes ${start}-${end - 1}/${bytes.length}` },
        }));
    });
    const directory = await openContentDirectory('https://example.test/content/manifest.json');
    const index = await openPack(directory.getFile(path));

    assert.equal(index.pages.length, 113);
    assert.equal(index.source.relativePath, path);
    assert.ok(ranges.every(([start, end]) => end - start <= 16 * 1_024));
    assert.ok(ranges.reduce((sum, [start, end]) => sum + end - start, 0) < bytes.length / 10);
    const readsBeforeDecode = ranges.length;
    const blobPromise = index.pageBlob(112);

    assert.ok(blobPromise instanceof Promise);
    const blob = await blobPromise;

    assert.equal(blob.type, 'image/png');
    assert.equal(ranges.length, readsBeforeDecode + 1);
    assert.deepEqual(ranges.at(-1), [index.pages[112].pngStart, index.pages[112].pngEnd]);
    assert.deepEqual(Buffer.from(await blob.arrayBuffer()), image);
});
