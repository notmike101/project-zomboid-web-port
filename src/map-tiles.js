/**
 * @file User-selected Build 42 LOTH/LOTP v1 map geometry, without native execution.
 * Primary format writer (consulted, not copied):
 * https://github.com/Unjammer/WorldEd/blob/6de436e793cc8f12e31776ce7cbcedfdc47bc1c7/src/editor/lotfilesmanager256.cpp
 * Header/pack/chunk generation, especially lines 1010–1037, 1272–1375 and
 * 1384–1414. All integers LE; offsets are signed 64-bit, NOT
 * (position,size) pairs. A cell has 32x32 chunks of 8x8 squares. Table order is
 * chunkX,chunkY; each chunk's records traverse z,x,y. -1 followed by N skips N
 * squares INCLUDING the current square; runs may span levels. Positive count
 * includes the room-id field, leaving count-1 ordered catalogue references.
 *
 * Independently probed, read-only, all four installed Tutorial cells on
 * 2026-10-12: LOTH v1, width/height 8, LOTP v1, 1024 absolute offsets, complete
 * records and exactly 1024 zombie-intensity bytes after header metadata. The
 * shipped LOTP table marker is 8; the public writer writes 1024. Both explicitly
 * supported; older magic-less/v0/300-tile formats are deliberately rejected.
 * Tutorial 0_0: 557 names, z=0..2, 132512 placements; others: 31 names, z=0,
 * 22528/22528/3872 placements. All room ids in these shipped chunks were -1.
 * The real Tutorial door square (193,194,0) has eight ordered placements,
 * including carpentry_02_57, walls_exterior_wooden_01_39,
 * fixtures_doors_frames_01_9 and fixtures_doors_01_29, all matching pack names.
 * Tiles2x.pack joined 429/557 names; floor/overlay companion packs increased
 * this to 548/557. This loader preserves missing sprite names, never invents art
 * or buildings. Proprietary bytes/pixels were not copied into source/fixtures.
 */

const WINDOW_BYTES = 16 * 1_024;
const MAX_HEADER_BYTES = 16 * 1_024 * 1_024;
const MAX_CHUNK_BYTES = 4 * 1_024 * 1_024;
const MAX_NAMES = 65_536;
const MAX_STRING_BYTES = 4_096;
const MAX_RECORD_TILES = 256;
const MAX_CHUNK_PLACEMENTS = 262_144;
const CHUNKS_PER_AXIS = 32;
const CHUNK_SIZE = 8;
const CELL_SIZE = 256;
const INDEX_END = 12 + 1_024 * 8;

/** @typedef {{size:number,slice:(start:number,end:number)=>{arrayBuffer:()=>Promise<ArrayBuffer>}}} MapSource */
/** @typedef {{x:number,y:number,z:number,spriteName:string,roomId:number,order:number}} TilePlacement */
/** @typedef {{id:number,name:string,z:number,rects:Array<{x:number,y:number,width:number,height:number}>}} MapRoom */
/** @typedef {{chunkX:number,chunkY:number,x:number,y:number,offset:number,byteLength:number,present:boolean}} MapChunk */
/** @typedef {{cellX:number,cellY:number,cellSize:number,chunkSize:number,chunksPerAxis:number,minLevel:number,maxLevel:number,tileNames:Array<string>,rooms:Array<MapRoom>,chunks:Array<MapChunk>,readChunk:(chunkX:number,chunkY:number)=>Promise<TilePlacement[]>}} MapCell */

/**
 * Reject non-Blob-like sources before parsing.
 *
 * @param {MapSource} source - User file.
 * @param {string} label - Diagnostic label.
 * @returns {void}
 */
function validateSource(source, label) {
    if (!source || typeof source.slice !== 'function' || !Number.isSafeInteger(source.size) || source.size < 0) {
        throw new TypeError(`${label} must provide a safe size and Blob/File.slice`);
    }
}

/**
 * Independent cursors make concurrent readChunk calls safe, without a cache.
 *
 * @param {MapSource} source - Source Blob.
 * @param {string} label - Diagnostic label.
 * @param {number} [start] - First byte.
 * @param {number} [end] - Exclusive boundary; never read ahead into another chunk.
 * @returns {object} Bounded sequential reader.
 */
function cursor(source, label, start = 0, end = source.size) {
    let buffer = new Uint8Array(0);
    let bufferStart = start;
    const reader = {
        position: start,
        /**
         * Read one field without copying its bytes.
         *
         * @param {number} length - Field size.
         * @returns {Promise<Uint8Array>} Non-owning view.
         */
        async bytes(length) {
            const position = reader.position;

            if (position + length > end || position + length > source.size) {
                throw new Error(`Truncated ${label} at byte ${position}`);
            }

            if (position < bufferStart || position + length > bufferStart + buffer.length) {
                bufferStart = position;
                const sliceEnd = Math.min(end, source.size, position + WINDOW_BYTES);

                buffer = new Uint8Array(await source.slice(position, sliceEnd).arrayBuffer());

                if (buffer.length !== sliceEnd - position) {
                    throw new Error(`Truncated ${label} source read at byte ${position}`);
                }
            }

            reader.position += length;

            return buffer.subarray(position - bufferStart, position - bufferStart + length);
        },
        /**
         * Read a signed 32-bit integer.
         *
         * @returns {Promise<number>} Signed field.
         */
        async integer() {
            const bytes = await reader.bytes(4);

            return new DataView(bytes.buffer, bytes.byteOffset, 4).getInt32(0, true);
        },
        /**
         * Read a signed 64-bit offset without rounding it into an unsafe number.
         *
         * @returns {Promise<number>} Safe byte offset.
         */
        async offset() {
            const bytes = await reader.bytes(8);
            const value = new DataView(bytes.buffer, bytes.byteOffset, 8).getBigInt64(0, true);

            if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -1n) {
                throw new Error(`Unsupported ${label} offset ${value}`);
            }

            return Number(value);
        },
        /* eslint-disable no-await-in-loop -- Each string byte advances the same bounded source cursor. */
        /**
         * Read a Latin-1 newline string as emitted by SaveString.
         *
         * @returns {Promise<string>} Trimmed string.
         */
        async line() {
            let result = '';

            for (let length = 0; length <= MAX_STRING_BYTES; length += 1) {
                const byte = (await reader.bytes(1))[0];

                if (byte === 10) {
                    return result.trim();
                }

                if (length === MAX_STRING_BYTES || byte === 0) {
                    throw new Error(`Invalid ${label} string length/content at byte ${reader.position}`);
                }

                result += String.fromCharCode(byte);
            }

            throw new Error(`Invalid ${label} string`);
        },
        /* eslint-enable no-await-in-loop */
        /**
         * Advance past metadata that is not needed for tile placement.
         *
         * @param {number} length - Metadata byte count.
         * @returns {void}
         */
        skip(length) {
            if (reader.position + length > end || reader.position + length > source.size) {
                throw new Error(`Truncated ${label} metadata at byte ${reader.position}`);
            }

            reader.position += length;
        },
    };

    return reader;
}

/**
 * Reject invalid counts before allocating metadata.
 *
 * @param {object} reader - Sequential cursor.
 * @param {string} label - Field diagnostic.
 * @param {number} limit - Maximum count.
 * @returns {Promise<number>} Checked count.
 */
async function count(reader, label, limit) {
    const value = await reader.integer();

    if (value < 0 || value > limit) {
        throw new Error(`Invalid ${label} count ${value}; maximum ${limit}`);
    }

    return value;
}

/**
 * Require the independently verified v1 format.
 *
 * @param {object} reader - Sequential cursor.
 * @param {string} expected - Required magic.
 * @returns {Promise<void>}
 */
async function version(reader, expected) {
    const bytes = await reader.bytes(4);

    if (String.fromCharCode(...bytes) !== expected || await reader.integer() !== 1) {
        throw new Error(`Unsupported ${expected} format: require Build 42 ${expected} v1`);
    }
}

/* eslint-disable no-await-in-loop -- Header fields, offset table and chunk records share dependent sequential cursors. */
/**
 * Index one real map cell. Only header/index metadata is read until readChunk.
 * No navigation flags, generated geometry, GPU work, sprite remapping or cache.
 *
 * @param {object} options - User-owned paired files.
 * @param {number} options.cellX - Original cell-grid x.
 * @param {number} options.cellY - Original cell-grid y.
 * @param {MapSource} options.header - User-selected lotheader.
 * @param {MapSource} options.lotpack - User-selected lotpack.
 * @returns {Promise<MapCell>} Lazy geometry with world-tile coordinates.
 */
export async function openMapCell({ cellX, cellY, header, lotpack }) {
    if (!Number.isSafeInteger(cellX) || !Number.isSafeInteger(cellY)
        || !Number.isSafeInteger(cellX * CELL_SIZE + CELL_SIZE - 1)
        || !Number.isSafeInteger(cellY * CELL_SIZE + CELL_SIZE - 1)) {
        throw new TypeError('Map cell coordinates must produce safe integer world coordinates');
    }

    validateSource(header, 'Lotheader');
    validateSource(lotpack, 'Lotpack');

    if (header.size > MAX_HEADER_BYTES) {
        throw new Error(`Lotheader exceeds ${MAX_HEADER_BYTES} byte limit`);
    }

    const h = cursor(header, 'lotheader');

    await version(h, 'LOTH');
    const nameCount = await count(h, 'catalogue', MAX_NAMES);
    const tileNames = [];

    for (let index = 0; index < nameCount; index += 1) {
        const name = await h.line();

        if (!name) {
            throw new Error(`Empty catalogue name at index ${index}`);
        }

        tileNames.push(name);
    }

    const width = await h.integer();
    const height = await h.integer();

    if (width !== CHUNK_SIZE || height !== CHUNK_SIZE) {
        throw new Error(`Unsupported lotheader chunk dimensions ${width}x${height}; require 8x8`);
    }

    const minLevel = await h.integer();
    const maxLevel = await h.integer();

    if (minLevel < -32 || maxLevel > 31 || minLevel > maxLevel) {
        throw new Error(`Unsupported lotheader level range ${minLevel}..${maxLevel}`);
    }

    const roomCount = await count(h, 'rooms', MAX_NAMES);
    const rooms = [];

    for (let id = 0; id < roomCount; id += 1) {
        const name = await h.line();
        const z = await h.integer();
        const rectCount = await count(h, 'room rectangles', MAX_NAMES);
        const rects = [];

        for (let index = 0; index < rectCount; index += 1) {
            const x = await h.integer();
            const y = await h.integer();
            const rectWidth = await h.integer();
            const rectHeight = await h.integer();

            if (x < 0 || y < 0 || rectWidth < 0 || rectHeight < 0 || x + rectWidth > CELL_SIZE || y + rectHeight > CELL_SIZE) {
                throw new Error(`Invalid room rectangle in room ${id}`);
            }

            rects.push(Object.freeze({ x: cellX * CELL_SIZE + x, y: cellY * CELL_SIZE + y, width: rectWidth, height: rectHeight }));
        }

        const objectCount = await count(h, 'room meta objects', MAX_NAMES);

        // These are meta-enum,x,y records, NOT sprite catalogue references.
        h.skip(objectCount * 12);
        rooms.push(Object.freeze({ id, name, z, rects: Object.freeze(rects) }));
    }

    const buildingCount = await count(h, 'buildings', MAX_NAMES);

    for (let index = 0; index < buildingCount; index += 1) {
        const buildingRooms = await count(h, 'building rooms', roomCount);

        for (let room = 0; room < buildingRooms; room += 1) {
            const id = await h.integer();

            if (id < 0 || id >= roomCount) {
                throw new Error(`Invalid building room reference ${id}`);
            }
        }
    }

    // Zombie intensities are not tile geometry.
    h.skip(1_024);

    if (h.position !== header.size) {
        throw new Error('Unsupported trailing lotheader metadata');
    }

    const p = cursor(lotpack, 'lotpack index', 0, INDEX_END);

    await version(p, 'LOTP');
    const marker = await p.integer();

    if (marker !== 8 && marker !== 1_024) {
        throw new Error(`Unsupported lotpack table marker ${marker}`);
    }

    const chunks = [];
    /** @type {MapChunk | undefined} */
    let previous;

    for (let index = 0; index < 1_024; index += 1) {
        const offset = await p.offset();
        const chunkX = Math.floor(index / CHUNKS_PER_AXIS);
        const chunkY = index % CHUNKS_PER_AXIS;
        const chunk = { chunkX, chunkY, x: cellX * CELL_SIZE + chunkX * CHUNK_SIZE, y: cellY * CELL_SIZE + chunkY * CHUNK_SIZE, offset, byteLength: 0, present: offset > 0 };

        if (chunk.present) {
            if (offset < INDEX_END || offset >= lotpack.size || (previous && offset <= previous.offset)) {
                throw new Error(`Invalid lotpack chunk offset ${offset} at index ${index}`);
            }

            if (previous) {
                previous.byteLength = offset - previous.offset;
            } else if (offset !== INDEX_END) {
                throw new Error(`Unsupported padding before first lotpack chunk offset ${offset}`);
            }

            previous = chunk;
        }

        chunks.push(chunk);
    }

    if (previous) {
        previous.byteLength = lotpack.size - previous.offset;
    } else if (lotpack.size !== INDEX_END) {
        throw new Error('Unsupported trailing lotpack bytes without chunks');
    }

    for (const chunk of chunks) {
        if (chunk.byteLength > MAX_CHUNK_BYTES) {
            throw new Error(`Lotpack chunk exceeds ${MAX_CHUNK_BYTES} byte limit`);
        }

        Object.freeze(chunk);
    }

    /**
     * Decode exactly one selected chunk into original ordered placements.
     *
     * @param {number} chunkX - Cell-local chunk x.
     * @param {number} chunkY - Cell-local chunk y.
     * @returns {Promise<TilePlacement[]>} Ordered placements.
     */
    async function readChunk(chunkX, chunkY) {
        if (!Number.isInteger(chunkX) || !Number.isInteger(chunkY) || chunkX < 0 || chunkX >= CHUNKS_PER_AXIS || chunkY < 0 || chunkY >= CHUNKS_PER_AXIS) {
            throw new RangeError('Chunk coordinates must be integers in 0..31');
        }

        const chunk = chunks[chunkX * CHUNKS_PER_AXIS + chunkY];

        if (!chunk.present) {
            return [];
        }

        const end = chunk.offset + chunk.byteLength;
        const reader = cursor(lotpack, `lotpack chunk ${chunkX},${chunkY}`, chunk.offset, end);
        /** @type {TilePlacement[]} */
        const placements = [];
        const squareCount = (maxLevel - minLevel + 1) * CHUNK_SIZE * CHUNK_SIZE;
        let square = 0;

        while (square < squareCount) {
            const recordCount = await reader.integer();

            if (recordCount === -1) {
                const skip = await reader.integer();

                if (skip < 1 || skip > squareCount - square) {
                    throw new Error(`Invalid lotpack skip run ${skip} at square ${square}`);
                }

                square += skip;
                continue;
            }

            if (recordCount < 0 || recordCount > MAX_RECORD_TILES + 1) {
                throw new Error(`Unsupported lotpack tile count ${recordCount}`);
            }

            if (recordCount > 1) {
                const roomId = await reader.integer();

                if (roomId < -1 || roomId >= roomCount) {
                    throw new Error(`Invalid lotpack room reference ${roomId}`);
                }

                if (placements.length + recordCount - 1 > MAX_CHUNK_PLACEMENTS) {
                    throw new Error(`Lotpack chunk exceeds ${MAX_CHUNK_PLACEMENTS} placement limit`);
                }

                const x = chunk.x + Math.floor((square % 64) / CHUNK_SIZE);
                const y = chunk.y + square % CHUNK_SIZE;
                const z = minLevel + Math.floor(square / 64);

                for (let order = 0; order < recordCount - 1; order += 1) {
                    const reference = await reader.integer();

                    if (reference < 0 || reference >= tileNames.length) {
                        throw new Error(`Invalid lotpack catalogue reference ${reference}`);
                    }

                    placements.push({ x, y, z, spriteName: tileNames[reference], roomId, order });
                }
            }

            square += 1;
        }

        if (reader.position !== end) {
            throw new Error(`Unsupported trailing lotpack chunk bytes at ${reader.position}`);
        }

        return placements;
    }

    return Object.freeze({ cellX, cellY, cellSize: CELL_SIZE, chunkSize: CHUNK_SIZE, chunksPerAxis: CHUNKS_PER_AXIS, minLevel, maxLevel, tileNames: Object.freeze(tileNames), rooms: Object.freeze(rooms), chunks: Object.freeze(chunks), readChunk });
}
/* eslint-enable no-await-in-loop */
