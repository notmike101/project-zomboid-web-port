/* The PNG byte gate and the pointer plane are pure numeric logic that needs no GPU; upload,
   presentation and device-loss behaviour are proven by the browser run. */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parsePngHeader, worldFromCanvas } from '../src/renderer.js';

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const IHDR_LENGTH_OFFSET = 8;
const IHDR_TYPE_OFFSET = 12;
const WIDTH_OFFSET = 16;
const HEIGHT_OFFSET = 20;
const BIT_DEPTH_OFFSET = 24;
const COLOUR_TYPE_OFFSET = 25;
const COMPRESSION_OFFSET = 26;
const FILTER_OFFSET = 27;
const INTERLACE_OFFSET = 28;

/**
 * Builds the first 33 bytes of a PNG: the signature followed by an IHDR chunk.
 *
 * @param {{width?: number, height?: number, bitDepth?: number, colourType?: number, compression?: number, filter?: number, interlace?: number, signature?: boolean, chunk?: string, ihdrLength?: number}} [fields] - Overrides for a valid 64x64 8-bit RGBA baseline header.
 * @returns {Uint8Array} Header bytes for {@link parsePngHeader} to judge.
 */
function pngHeader(fields = {}) {
    const {
        width = 64, height = 64, bitDepth = 8, colourType = 6, compression = 0, filter = 0, interlace = 0,
        signature = true, chunk = 'IHDR', ihdrLength = 13,
    } = fields;
    const bytes = new Uint8Array(33);
    const view = new DataView(bytes.buffer);

    bytes.set(signature ? SIGNATURE : SIGNATURE.map((byte) => byte + 1), 0);
    view.setUint32(IHDR_LENGTH_OFFSET, ihdrLength);

    for (const [index, character] of [...chunk].entries()) {
        bytes[IHDR_TYPE_OFFSET + index] = character.charCodeAt(0);
    }

    view.setUint32(WIDTH_OFFSET, width);
    view.setUint32(HEIGHT_OFFSET, height);
    bytes[BIT_DEPTH_OFFSET] = bitDepth;
    bytes[COLOUR_TYPE_OFFSET] = colourType;
    bytes[COMPRESSION_OFFSET] = compression;
    bytes[FILTER_OFFSET] = filter;
    bytes[INTERLACE_OFFSET] = interlace;

    return bytes;
}

test('a baseline RGBA header reports the declared dimensions', () => {
    assert.deepEqual(parsePngHeader(pngHeader()), { width: 64, height: 64 });
    assert.deepEqual(parsePngHeader(pngHeader({ width: 1, height: 1 })), { width: 1, height: 1 });
    // Byte and dimension bounds are enforced by the import path, which also holds the device limit.
    assert.deepEqual(parsePngHeader(pngHeader({ width: 65_535, height: 1 })), { width: 65_535, height: 1 });
});

test('colour type and bit depth must form a PNG-valid pair', () => {
    const valid = [
        [0, 1], [0, 2], [0, 4], [0, 8], [0, 16],
        [2, 8], [2, 16],
        [3, 1], [3, 2], [3, 4], [3, 8],
        [4, 8], [4, 16],
        [6, 8], [6, 16],
    ];

    for (const [colourType, bitDepth] of valid) {
        assert.deepEqual(
            parsePngHeader(pngHeader({ colourType, bitDepth })),
            { width: 64, height: 64 },
            `colour type ${colourType} at ${bitDepth} bits should be accepted`,
        );
    }

    const invalid = [[3, 16], [0, 3], [0, 5], [0, 0], [2, 4], [6, 2], [6, 12], [1, 8], [5, 8], [7, 8]];

    for (const [colourType, bitDepth] of invalid) {
        assert.throws(
            () => parsePngHeader(pngHeader({ colourType, bitDepth })),
            { name: 'TypeError', message: /colour type/ },
            `colour type ${colourType} at ${bitDepth} bits should be rejected`,
        );
    }
});

test('interlace, compression and filter must be declared methods', () => {
    // Adam7 is decoded by the browser before upload, so it is accepted.
    assert.deepEqual(parsePngHeader(pngHeader({ interlace: 1 })), { width: 64, height: 64 });

    for (const interlace of [2, 7]) {
        assert.throws(
            () => parsePngHeader(pngHeader({ interlace })),
            { name: 'TypeError', message: /interlace/ },
            `interlace method ${interlace} should be rejected`,
        );
    }

    assert.throws(() => parsePngHeader(pngHeader({ compression: 1 })), { name: 'TypeError', message: /compression/ });
    assert.throws(() => parsePngHeader(pngHeader({ filter: 1 })), { name: 'TypeError', message: /filter/ });
});

test('a truncated, mislabelled or impossible IHDR is refused', () => {
    assert.throws(() => parsePngHeader(new Uint8Array(32)), { name: 'TypeError', message: /truncated/ });
    assert.throws(() => parsePngHeader(pngHeader({ signature: false })), { name: 'TypeError', message: /not a PNG/ });
    assert.throws(() => parsePngHeader(pngHeader({ chunk: 'IEXI' })), { name: 'TypeError', message: /malformed/ });
    assert.throws(() => parsePngHeader(pngHeader({ ihdrLength: 12 })), { name: 'TypeError', message: /malformed/ });
    assert.throws(() => parsePngHeader(pngHeader({ width: 0 })), { name: 'RangeError', message: /empty image/ });
    assert.throws(() => parsePngHeader(pngHeader({ height: 0 })), { name: 'RangeError', message: /empty image/ });
});

/**
 * Builds a canvas-like element whose layout metrics carry a 2px border and a 2x visual scale.
 *
 * @returns {{clientHeight: number, clientLeft: number, clientTop: number, clientWidth: number, offsetHeight: number, offsetWidth: number, getBoundingClientRect: () => {height: number, left: number, top: number, width: number}}} Metrics {@link worldFromCanvas} reads: 480x300 content inside a 484x304 layout box drawn at 2x from (100, 50).
 */
function scaledCanvas() {
    return {
        clientHeight: 300,
        clientLeft: 2,
        clientTop: 2,
        clientWidth: 480,
        offsetHeight: 304,
        offsetWidth: 484,
        /**
         * Return the visual border box after positive 2x scaling.
         *
         * @returns {{height: number, left: number, top: number, width: number}} Viewport rectangle.
         */
        getBoundingClientRect: () => ({ height: 608, left: 100, top: 50, width: 968 }),
    };
}

test('pointer mapping uses the border-excluding, scale-normalised content box', () => {
    const canvas = scaledCanvas();

    /* The inscribed square plane spans 600x600 of the 960x600 visual content area, so its
       edges sit at x 284 and 884 and y 54 and 654, while the content area spans 104 to 1064. */
    assert.deepEqual(worldFromCanvas(canvas, 584, 354), { x: 5, y: 5 });
    assert.deepEqual(worldFromCanvas(canvas, 284, 354), { x: 0, y: 5 });
    assert.deepEqual(worldFromCanvas(canvas, 884, 354), { x: 10, y: 5 });
    assert.deepEqual(worldFromCanvas(canvas, 584, 54), { x: 5, y: 0 });
    assert.deepEqual(worldFromCanvas(canvas, 584, 654), { x: 5, y: 10 });
    // The letterbox band clamps onto the plane instead of reporting coordinates outside it.
    assert.deepEqual(worldFromCanvas(canvas, 100, 50), { x: 0, y: 0 });
});
