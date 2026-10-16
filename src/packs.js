/** @file Bounded browser indexing of PZPK v1 and legacy PNG texture packs. */

const WINDOW_BYTES = 16 * 1_024;
const MAX_PAGES = 512;
const MAX_PAGE_SPRITES = 100_000;
const MAX_SPRITES = 250_000;
const MAX_METADATA_BYTES = 64 * 1_024 * 1_024;
const MAX_STRING_BYTES = 4_096;
const MAX_DIMENSION = 4_096;
const MAX_PNG_CHUNKS = 65_536;
const END_MARKER = 0xDE_AD_BE_EF;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const EMPTY = Object.freeze([]);
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** @typedef {import('../types/packs.js').PackSource} PackSource */
/** @typedef {import('../types/packs.js').PackSprite} PackSprite */
/** @typedef {import('../types/packs.js').PackPage} PackPage */
/** @typedef {import('../types/packs.js').PackIndex} PackIndex */

/**
 * Small sequential read window. Skipping a PNG changes the cursor, not its bytes.
 * A refill may read ahead at most 16 KiB into an image; no page payload is buffered.
 *
 * @param {PackSource} file - Blob/File or HTTP-backed slice source.
 * @returns {object} Private cursor.
 */
function cursor(file) {
    let buffer = new Uint8Array(0);
    let bufferStart = 0;
    const reader = {
        position: 0,
        /**
         * Return the next bounded field from the cursor window.
         *
         * @param {number} count - Bounded field length.
         * @returns {Promise<Uint8Array>} View valid until the next refill.
         */
        async bytes(count) {
            const start = reader.position;
            const end = start + count;

            if (end > file.size) {
                throw new Error(`Truncated pack at byte ${start}: need ${count} bytes`);
            }

            if (start < bufferStart || end > bufferStart + buffer.length) {
                bufferStart = start;
                const sliceEnd = Math.min(file.size, start + WINDOW_BYTES);

                buffer = new Uint8Array(await file.slice(start, sliceEnd).arrayBuffer());

                if (buffer.length !== sliceEnd - start) {
                    throw new Error(`Truncated source read at byte ${start}`);
                }
            }

            reader.position = end;

            return buffer.subarray(start - bufferStart, end - bufferStart);
        },
        /**
         * Read the next unsigned little-endian field.
         *
         * @returns {Promise<number>} Little-endian unsigned integer.
         */
        async integer() {
            const bytes = await reader.bytes(4);

            return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
        },
    };

    return reader;
}

/**
 * Read dimensions without decompressing pixels. PNG CRC/IDAT validity remains
 * the browser decoder's job; indexing never claims that a page has decoded.
 *
 * @param {object} reader - Cursor.
 * @param {number} end - Maximum image end.
 * @returns {Promise<{width:number,height:number}>} PNG dimensions.
 */
async function pngHeader(reader, end) {
    if (reader.position + 45 > end) {
        throw new Error(`Invalid PNG length at byte ${reader.position}`);
    }

    const bytes = await reader.bytes(33);
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    if (PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)
        || data.getUint32(8) !== 13
        || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') {
        throw new Error('Invalid PNG signature or IHDR in pack page');
    }

    const width = data.getUint32(16);
    const height = data.getUint32(20);

    if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION) {
        throw new Error(`PNG dimension limit: ${width} × ${height}, maximum ${MAX_DIMENSION}`);
    }

    const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

    if (!depths[bytes[25]]?.includes(bytes[24]) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) {
        throw new Error('Unsupported PNG color/depth/compression/interlace header');
    }

    return { width, height };
}

/* eslint-disable no-await-in-loop -- Each PNG chunk length determines the next cursor position. */
/**
 * Skip chunk payloads (including IDAT) by their big-endian PNG lengths.
 *
 * @param {object} reader - Cursor after IHDR.
 * @param {number} fileSize - Source size.
 * @returns {Promise<number>} End of IEND, excluding the pack end marker.
 */
async function legacyPngEnd(reader, fileSize) {
    for (let index = 0; index < MAX_PNG_CHUNKS; index += 1) {
        const bytes = await reader.bytes(8);
        const length = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
        const type = String.fromCharCode(...bytes.subarray(4));

        if (!/^[A-Za-z]{4}$/u.test(type)) {
            throw new Error('Invalid PNG chunk type in legacy pack');
        }

        const end = reader.position + length + 4;

        if (end > fileSize) {
            throw new Error(`Truncated legacy PNG chunk ${type}: length ${length}`);
        }

        if (type === 'IEND') {
            if (length !== 0) {
                throw new Error('Invalid PNG IEND length');
            }

            reader.position = end;

            return end;
        }

        if (type === 'IHDR') {
            throw new Error('Invalid repeated PNG IHDR chunk');
        }

        reader.position = end;
    }

    throw new Error(`PNG chunk count exceeds limit ${MAX_PNG_CHUNKS}`);
}
/* eslint-enable no-await-in-loop */

/**
 * Consume a legacy-compatible marker only when the boundary contains one.
 *
 * @param {object} reader - Cursor at a pack boundary.
 * @param {number} size - Source length.
 * @returns {Promise<void>} Consumes one optional DEADBEEF marker.
 */
async function skipMarker(reader, size) {
    if (reader.position + 4 <= size) {
        const value = await reader.integer();

        if (value !== END_MARKER) {
            reader.position -= 4;
        }
    }
}

/* eslint-disable no-await-in-loop -- Pack metadata and PNG ranges form one sequential cursor stream. */
/**
 * Build a deeply frozen atlas index, retaining only metadata and the slice source.
 * Duplicate names are retained; lookup selects the first on-disk occurrence.
 * pageBlob asynchronously returns a PNG Blob, fetching only that HTTP page.
 *
 * @param {PackSource} file - Blob/File or provisioned HTTP slice source.
 * @returns {Promise<PackIndex>} Index, without image decoding or GPU work.
 */
export async function openPack(file) {
    if (!file || typeof file.slice !== 'function' || !Number.isSafeInteger(file.size) || file.size < 0) {
        throw new TypeError('Pack source must provide a safe byte size and slice().arrayBuffer()');
    }

    const reader = cursor(file);
    let metadataBytes = 0;

    /**
     * Enforces the aggregate metadata allocation limit.
     *
     * @param {number} count - Metadata field bytes.
     * @returns {void}
     */
    function metadata(count) {
        metadataBytes += count;

        if (metadataBytes > MAX_METADATA_BYTES) {
            throw new Error(`Pack metadata exceeds limit ${MAX_METADATA_BYTES} bytes`);
        }
    }

    /**
     * Account for and read one metadata integer.
     *
     * @returns {Promise<number>} Metadata integer.
     */
    function integer() {
        metadata(4);

        return reader.integer();
    }

    /**
     * Read and validate a length-prefixed pack name.
     *
     * @returns {Promise<string>} Bounded UTF-8 name.
     */
    async function name() {
        const length = await integer();

        if (!length || length > MAX_STRING_BYTES) {
            throw new Error(`Pack string length ${length} exceeds bounds 1..${MAX_STRING_BYTES}`);
        }

        metadata(length);
        let value;

        try {
            value = UTF8.decode(await reader.bytes(length));
        } catch (error) {
            if (error instanceof TypeError) {
                throw new Error(`Invalid UTF-8 pack name at byte ${reader.position - length}`, { cause: error });
            }

            throw error;
        }

        for (const character of value) {
            const codePoint = character.codePointAt(0);

            if (codePoint < 32 || codePoint === 127) {
                throw new Error('Invalid control character in pack name');
            }
        }

        return value;
    }

    const magic = String.fromCharCode(...await reader.bytes(4));
    const format = magic === 'PZPK' ? 'PZPK' : 'legacy';
    let version = 0;

    if (format === 'PZPK') {
        version = await integer();

        if (version !== 1) {
            throw new Error(`Unsupported PZPK version ${version}; expected 1`);
        }
    } else {
        reader.position = 0;
    }

    const pageCount = await integer();

    if (!pageCount || pageCount > MAX_PAGES) {
        throw new Error(`Pack page count ${pageCount} exceeds bounds 1..${MAX_PAGES}`);
    }

    /** @type {PackPage[]} */
    const pages = [];
    /** @type {PackSprite[]} */
    const sprites = [];
    /** @type {Map<string, PackSprite[]>} */
    const byName = new Map();

    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
        await skipMarker(reader, file.size);
        const pageName = await name();
        const entryCount = await integer();

        if (entryCount > MAX_PAGE_SPRITES || sprites.length + entryCount > MAX_SPRITES) {
            throw new Error(`Pack entry count exceeds limit (${MAX_PAGE_SPRITES} per page, ${MAX_SPRITES} total)`);
        }

        const alphaField = await integer();
        const hasAlpha = alphaField > 0x7F_FF_FF_FF ? alphaField - 2 ** 32 : alphaField;
        /** @type {PackSprite[]} */
        const entries = [];

        for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
            const spriteName = await name();
            const x = await integer();
            const y = await integer();
            const w = await integer();
            const h = await integer();
            const xoff = await integer();
            const yoff = await integer();
            const totalW = await integer();
            const totalH = await integer();

            if (!totalW || !totalH || totalW > MAX_DIMENSION || totalH > MAX_DIMENSION
                || xoff + w > totalW || yoff + h > totalH) {
                throw new Error(`Invalid sprite canvas/trim offsets for ${spriteName}`);
            }

            const entry = Object.freeze({ name: spriteName, pageIndex, entryIndex, x, y, w, h, xoff, yoff, totalW, totalH });

            entries.push(entry);
            sprites.push(entry);
            const matches = byName.get(spriteName);

            if (matches) {
                matches.push(entry);
            } else {
                byName.set(spriteName, [entry]);
            }
        }

        const imageLength = format === 'PZPK' ? await integer() : undefined;
        const pngStart = reader.position;
        let pngEnd = imageLength === undefined ? file.size : pngStart + imageLength;

        if (pngEnd > file.size) {
            throw new Error(`Truncated page ${pageName}: PNG length ${imageLength} exceeds file size`);
        }

        const { width, height } = await pngHeader(reader, pngEnd);

        if (format === 'legacy') {
            pngEnd = await legacyPngEnd(reader, file.size);
        } else {
            reader.position = pngEnd - 12;
            const tail = await reader.bytes(12);

            if (new DataView(tail.buffer, tail.byteOffset, 4).getUint32(0) !== 0
                || String.fromCharCode(...tail.subarray(4, 8)) !== 'IEND') {
                throw new Error(`Invalid PNG IEND or declared image length for ${pageName}`);
            }
        }

        reader.position = pngEnd;

        for (const entry of entries) {
            if (entry.x + entry.w > width || entry.y + entry.h > height) {
                throw new Error(`Sprite rectangle outside PNG atlas for ${entry.name}`);
            }
        }

        pages.push(Object.freeze({ index: pageIndex, name: pageName, hasAlpha, width, height, pngStart, pngEnd, sprites: Object.freeze(entries) }));
    }

    await skipMarker(reader, file.size);

    if (reader.position !== file.size) {
        throw new Error(`Unexpected trailing pack bytes at ${reader.position}`);
    }

    for (const matches of byName.values()) {
        Object.freeze(matches);
    }

    return Object.freeze({
        format, version,
        source: Object.freeze({ name: file.name ?? '', size: file.size, lastModified: file.lastModified ?? null, relativePath: file.relativePath ?? file.webkitRelativePath ?? '' }),
        pages: Object.freeze(pages), sprites: Object.freeze(sprites),
        /**
         * Select the first on-disk sprite occurrence.
         *
         * @param {string} spriteName - Exact name.
         * @returns {PackSprite|undefined} First occurrence.
         */
        lookup(spriteName) {
            return byName.get(spriteName)?.[0];
        },
        /**
         * Return every on-disk occurrence without discarding duplicate names.
         *
         * @param {string} spriteName - Exact name.
         * @returns {readonly PackSprite[]} All occurrences in disk order.
         */
        lookupAll(spriteName) {
            return byName.get(spriteName) ?? EMPTY;
        },
        /**
         * Select every matching occurrence in on-disk order.
         *
         * @param {string} prefix - Name prefix.
         * @returns {readonly PackSprite[]} Matching occurrences in disk order.
         */
        findByPrefix(prefix) {
            return Object.freeze(sprites.filter((entry) => entry.name.startsWith(prefix)));
        },
        /**
         * Resolve a PNG Blob; Blob sources remain zero-copy, HTTP sources read one page.
         *
         * @param {number} pageIndex - Zero-based page.
         * @returns {Promise<Blob>} PNG slice ready for a browser decoder.
         */
        async pageBlob(pageIndex) {
            if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pages.length) {
                throw new RangeError(`Invalid pack page index ${pageIndex}`);
            }

            const page = pages[pageIndex];
            const slice = file.slice(page.pngStart, page.pngEnd, 'image/png');

            if (slice instanceof Blob) {
                return slice;
            }

            const bytes = await slice.arrayBuffer();

            if (bytes.byteLength !== page.pngEnd - page.pngStart) {
                throw new Error(`Truncated source read for pack page ${pageIndex}`);
            }

            return new Blob([bytes], { type: 'image/png' });
        },
    });
}
/* eslint-enable no-await-in-loop */
