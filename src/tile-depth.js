/** @file Original loose tile-depth resources; no original bytes are embedded here. */
const MAX_FILE_BYTES = 16 * 1_024 * 1_024;
const MAX_PIXELS = 1_024 * 16_384;
const TILE_WIDTH = 128;
const TILE_HEIGHT = 256;
const PRESETS = { Floor: 0, WDoorFrame: 2, NDoorFrame: 3, WWall: 4, NWall: 5, NWWall: 6, SEWall: 7 };
const SEAMS = ['FloorSouth', 'FloorEast', 'WallSouth', 'WallEast', 'FloorSouthOneThird', 'FloorEastOneThird', 'FloorSouthTwoThirds', 'FloorEastTwoThirds'];
const SEAM_VERTICES = {
    FloorSouth: [5, 221, 69, 253, 63, 256, -1, 224],
    FloorEast: [57, 253, 121, 221, 127, 224, 63, 256],
    FloorSouthOneThird: [5, 157, 69, 189, 63, 192, -1, 160],
    FloorEastOneThird: [57, 189, 121, 157, 127, 160, 63, 192],
    FloorSouthTwoThirds: [5, 93, 69, 125, 63, 128, -1, 96],
    FloorEastTwoThirds: [57, 125, 121, 93, 127, 96, 63, 128],
};
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
    let value = index;

    for (let bit = 0; bit < 8; bit += 1) {
        value = (value >>> 1) ^ ((value & 1) ? 0xED_B8_83_20 : 0);
    }

    return value >>> 0;
});

/**
 * Native Java String.trim, not Unicode whitespace normalization.
 *
 * @param {string} value - Text to trim.
 * @returns {string} Text without leading or trailing code units at most 32.
 */
function trim(value) {
    let start = 0;
    let end = value.length;

    while (start < end && value.charCodeAt(start) <= 32) {
        start += 1;
    }

    while (end > start && value.charCodeAt(end - 1) <= 32) {
        end -= 1;
    }

    return value.slice(start, end);
}

/**
 * VERSION1 file semantics: blank values and self links do not erase earlier entries.
 *
 * @param {string} text - Original assignment file text.
 * @returns {Map<string, string>} One-hop sprite assignments.
 */
function parseTileDepthAssignments(text) {
    if (typeof text !== 'string' || text.length > MAX_FILE_BYTES) {
        throw new TypeError('Tile depth assignment text exceeds bounds');
    }

    const clean = text.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/\/\/[^\r\n]*/gu, '');
    const match = /^\s*tileDepthTextureAssignments\s*\{([^{}]*)\}\s*$/u.exec(clean);

    if (!match) {
        throw new Error('Invalid tile depth assignment block');
    }

    const pairs = match[1].split(',').map((entry) => {
        const equal = entry.indexOf('=');

        if (equal === -1) {
            if (trim(entry)) {
                throw new Error('Invalid tile depth assignment field');
            }

            return null;
        }

        return [trim(entry.slice(0, equal)), trim(entry.slice(equal + 1))];
    }).filter(Boolean);
    const version = pairs.find(([key]) => key === 'VERSION')?.[1];

    if (!version || !/^[+]?0*1$/u.test(version)) {
        throw new Error('Unsupported or missing tile depth assignment VERSION; expected 1');
    }

    const assignments = new Map();

    for (const [key, value] of pairs) {
        if (key && value && key !== value && key !== 'VERSION') {
            assignments.set(key, value);
        }
    }

    return assignments;
}

/**
 * Compute the PNG chunk CRC over its type and payload.
 *
 * @param {Uint8Array} bytes - Chunk type and payload bytes.
 * @returns {number} Unsigned CRC-32.
 */
function crc(bytes) {
    let value = 0xFF_FF_FF_FF;

    for (const byte of bytes) {
        value = (value >>> 8) ^ CRC_TABLE[(value ^ byte) & 255];
    }

    return (value ^ 0xFF_FF_FF_FF) >>> 0;
}

/**
 * Inflate with an exact output ceiling; never collect unbounded decompressor output.
 *
 * @param {Uint8Array} bytes - Zlib-compressed scanlines.
 * @param {number} expected - Exact permitted inflated byte count.
 * @returns {Promise<Uint8Array>} Complete bounded scanlines.
 */
async function inflate(bytes, expected) {
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
    const result = new Uint8Array(expected);
    let position = 0;

    try {
        for (;;) {
            // eslint-disable-next-line no-await-in-loop -- Read serially for stream backpressure and enforce the ceiling before the next chunk.
            const { value, done } = await reader.read();

            if (done) {
                break;
            }

            if (value.length > expected - position) {
                throw new Error('PNG inflated bytes exceed bounds');
            }

            result.set(value, position);
            position += value.length;
        }

        if (position !== expected) {
            throw new Error('Truncated PNG inflated bytes');
        }

        return result;
    } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
    } finally {
        reader.releaseLock();
    }
}

/**
 * Predict a PNG sample with Paeth's specified tie order.
 *
 * @param {number} a - Left sample.
 * @param {number} b - Upper sample.
 * @param {number} c - Upper-left sample.
 * @returns {number} Selected neighboring sample.
 */
function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);

    if (pa <= pb && pa <= pc) {
        return a;
    }

    return pb <= pc ? b : c;
}

/**
 * Lossless PNG BLUE/alpha decode. Actual loose originals use noninterlaced 8-bit
 * indexed, gray+alpha and gray PNGs; RGB/RGBA also support synthetic consumers.
 * The 16384-row bound is required by actual originals (not diffuse pack limits).
 *
 * @param {ArrayBuffer|{buffer: ArrayBuffer, byteOffset: number, byteLength: number}} input - Complete encoded PNG.
 * @returns {Promise<{width: number, height: number, blue: Uint8Array, alpha: Uint8Array}>} Lossless blue and alpha planes.
 */
async function decodeDepthPng(input) {
    const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);

    if (bytes.length > MAX_FILE_BYTES || bytes.length < 45 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) {
        throw new Error('Invalid PNG signature or file bounds');
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 8;
    let width;
    let height;
    let type;
    let channels;
    let palette;
    let transparency;
    let ended = false;
    let dataEnded = false;
    const data = [];
    let dataLength = 0;

    for (let count = 0; at < bytes.length && count < 65_536; count += 1) {
        if (at + 12 > bytes.length) {
            throw new Error('Truncated PNG chunk');
        }

        const size = view.getUint32(at);
        const end = at + 12 + size;

        if (end > bytes.length) {
            throw new Error('Truncated PNG chunk payload');
        }

        const name = String.fromCharCode(...bytes.subarray(at + 4, at + 8));

        if (!/^[A-Za-z]{4}$/u.test(name) || (bytes[at + 6] & 32)) {
            throw new Error('Invalid PNG chunk type');
        }

        if (crc(bytes.subarray(at + 4, end - 4)) !== view.getUint32(end - 4)) {
            throw new Error(`PNG CRC mismatch in ${name}`);
        }

        const body = bytes.subarray(at + 8, end - 4);

        if (count === 0 && name !== 'IHDR') {
            throw new Error('PNG IHDR must be first');
        }

        switch (name) {
            case 'IHDR': {
                if (width !== undefined || size !== 13) {
                    throw new Error('Invalid PNG IHDR');
                }

                width = view.getUint32(at + 8);
                height = view.getUint32(at + 12);
                type = body[9];
                channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];

                if (!width || !height || width > 16_384 || height > 16_384 || width * height > MAX_PIXELS) {
                    throw new Error('PNG dimension bounds exceeded');
                }

                if (body[8] !== 8 || !channels || body[10] !== 0 || body[11] !== 0 || body[12] !== 0) {
                    throw new Error('Unsupported depth PNG format; expected noninterlaced 8-bit samples');
                }

                break;
            }
            case 'PLTE': {
                if (palette || data.length || !size || size % 3 || size > 768 || type === 0 || type === 4) {
                    throw new Error('Invalid PNG palette');
                }

                palette = body;
                break;
            }
            case 'tRNS': {
                if (transparency || data.length || (type === 3 && (!palette || size > palette.length / 3)) || (type === 0 && size !== 2) || (type === 2 && size !== 6) || type === 4 || type === 6) {
                    throw new Error('Invalid PNG transparency');
                }

                transparency = body;
                break;
            }
            case 'IDAT': {
                if (dataEnded || (type === 3 && !palette)) {
                    throw new Error('Invalid PNG IDAT/palette order');
                }

                data.push(body);
                dataLength += size;
                break;
            }
            case 'IEND': {
                if (size || !data.length || end !== bytes.length) {
                    throw new Error('Invalid PNG IEND or trailing bytes');
                }

                ended = true;
                break;
            }

            default: {
                if (!(bytes[at + 4] & 32)) {
                    throw new Error(`Unsupported critical PNG chunk ${name}`);
                }

                if (data.length) {
                    dataEnded = true;
                }
            }
        }

        if (ended) {
            break;
        }

        at = end;
    }

    if (!ended) {
        throw new Error('Truncated PNG: missing IEND');
    }

    const compressed = new Uint8Array(dataLength);
    let position = 0;

    for (const part of data) {
        compressed.set(part, position);
        position += part.length;
    }

    const stride = width * channels;
    const scanlines = await inflate(compressed, (stride + 1) * height);
    const blue = new Uint8Array(width * height);
    const alpha = new Uint8Array(width * height);
    let previous = new Uint8Array(stride);
    let current = new Uint8Array(stride);
    /**
     * Read an optional 16-bit transparent-color sample.
     *
     * @param {number} offset - Byte offset in tRNS.
     * @returns {number} Transparent sample, or -1 when absent.
     */
    const transparentSample = (offset) => transparency ? transparency[offset] * 256 + transparency[offset + 1] : -1;

    for (let y = 0; y < height; y += 1) {
        const start = y * (stride + 1);
        const filter = scanlines[start];

        if (filter > 4) {
            throw new Error('Invalid PNG scanline filter');
        }

        for (let x = 0; x < stride; x += 1) {
            const left = x < channels ? 0 : current[x - channels];
            const up = previous[x];
            const corner = x < channels ? 0 : previous[x - channels];
            let prediction = 0;

            switch (filter) {
                case 1: {
                    prediction = left;
                    break;
                }
                case 2: {
                    prediction = up;
                    break;
                }
                case 3: {
                    prediction = Math.floor((left + up) / 2);
                    break;
                }
                case 4: {
                    prediction = paeth(left, up, corner);
                    break;
                }

                default: break;
            }

            current[x] = (scanlines[start + 1 + x] + prediction) & 255;
        }

        for (let x = 0; x < width; x += 1) {
            const i = x * channels;
            const target = y * width + x;
            let depth = current[i];
            let opacity = 255;

            switch (type) {
                case 3: {
                    if (depth * 3 + 2 >= palette.length) {
                        throw new Error('PNG palette index exceeds bounds');
                    }

                    opacity = transparency?.[depth] ?? 255;
                    depth = palette[depth * 3 + 2];

                    break;
                }
                case 6:
                case 2: {
                    depth = current[i + 2];

                    if (type === 6) {
                        opacity = current[i + 3];
                    } else if (current[i] === transparentSample(0) && current[i + 1] === transparentSample(2) && depth === transparentSample(4)) {
                        opacity = 0;
                    }

                    break;
                }
                case 4: {
                    opacity = current[i + 1];
                    break;
                }

                default: if (depth === transparentSample(0)) {
                    opacity = 0;
                }
            }

            blue[target] = depth;
            alpha[target] = opacity;
        }

        [previous, current] = [current, previous];
    }

    return { width, height, blue, alpha };
}

/**
 * Validate and default native sprite scale and screen offsets.
 *
 * @param {object} context - Native render context.
 * @returns {{scaleX: number, scaleY: number, soffX: number, soffY: number}} Validated geometry.
 */
function geometry(context) {
    const result = { scaleX: context.scaleX ?? 1, scaleY: context.scaleY ?? 1, soffX: context.soffX ?? 0, soffY: context.soffY ?? 0 };

    if (!Object.values(result).every(Number.isFinite) || result.scaleX <= 0 || result.scaleY <= 0) {
        throw new TypeError('Invalid native sprite geometry');
    }

    return result;
}

/**
 * Split a native depth sprite name into sheet and tile index.
 *
 * @param {string} name - Sprite name.
 * @returns {{tileset: string, index: number}|null} Parsed identity, or null for an invalid name.
 */
function tileIdentity(name) {
    const match = /^(.*)_([+]?[0-9]+)$/u.exec(name);

    if (!match || !Number.isSafeInteger(Number(match[2]))) {
        return null;
    }

    return { tileset: match[1], index: Number(match[2]) };
}

/**
 * Read exactly the advertised private source; failures are never native absence.
 *
 * @param {object} content - Private content source.
 * @param {string} path - Advertised file path.
 * @returns {Promise<ArrayBuffer>} Complete file bytes.
 */
async function readFile(content, path) {
    const file = content.getFile(path);

    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE_BYTES) {
        throw new Error(`Tile depth file exceeds bounds: ${path}`);
    }

    const buffer = await file.arrayBuffer();

    if (buffer.byteLength !== file.size) {
        throw new Error(`Truncated tile depth file: ${path}`);
    }

    return buffer;
}

/**
 * Native TileDepthTexture.load/updateGPUTexture, preserving alpha-only emptiness.
 *
 * @param {{width: number, height: number, blue: Uint8Array, alpha: Uint8Array}} image - Decoded sheet.
 * @param {string} tileset - Native sheet name.
 * @param {number} index - Tile index.
 * @param {number} columns - Native sheet column count.
 * @param {boolean} keepEmpty - Preserve transparent preset tiles.
 * @returns {Uint8Array|null} Cropped native depth values, or null when absent.
 */
function tilePixels(image, tileset, index, columns, keepEmpty = false) {
    const x = index % columns * TILE_WIDTH;
    const y = Math.floor(index / columns) * TILE_HEIGHT;

    if (index < 0 || x + TILE_WIDTH > image.width || y + TILE_HEIGHT > image.height) {
        return null;
    }

    const pixels = new Uint8Array(TILE_WIDTH * TILE_HEIGHT);
    let nonempty = false;

    for (let row = 0; row < TILE_HEIGHT; row += 1) {
        /* INFERENCE from TileGeometryUtils' ortho + Rx30/Ry315 upper XZ plane:
           pixel-center depth = .5-(row+.5)/128, plus native 3/255. The
           simplification is not a native runtime comparison; only rows0..63 apply. */
        const clamp = row < 64 && !tileset.startsWith('roofs_') ? Math.fround(Math.fround(0.5 - (row + 0.5) / 128) + Math.fround(3 / 255)) : 0;

        for (let column = 0; column < TILE_WIDTH; column += 1) {
            const input = (y + row) * image.width + x + column;

            if (!image.alpha[input]) {
                continue;
            }

            nonempty = true;
            const depth = Math.max(Math.fround(image.blue[input] / 255), clamp);

            pixels[row * TILE_WIDTH + column] = Math.max(1, Math.floor(Math.fround(Math.min(1, depth) * 255)));
        }
    }

    return nonempty || keepEmpty ? pixels : null;
}

/**
 * Create a source-backed resolver. Decoded whole sheets are shared only while
 * reads are in flight; the factory retains no atlas or unbounded tile-pixel cache.
 * context.objectClass must be established by the represented native producer,
 * not inferred from an incomplete tile-property heuristic.
 *
 * @param {object} content - Private content source and startup manifest.
 * @param {Map<string, object>} tileRegistry - Immutable native sprite registry.
 * @returns {Promise<{resolve: function(string, object=): Promise<object>}>} Native depth resolver.
 */
async function createTileDepthAssets(content, tileRegistry) {
    const config = content?.manifest?.startup?.tileDepth;

    if (!config || config.assignments !== 'media/tileDepthTextureAssignments.txt' || !Array.isArray(config.images)) {
        throw new TypeError('Native tile depth inventory is required');
    }

    if (config.seams !== undefined && config.seams !== 'media/depthmaps/SEAMS_01.png') {
        throw new TypeError('Invalid native seam inventory path');
    }

    const paths = new Map();

    for (const path of config.images) {
        if (typeof path !== 'string' || !/^media\/depthmaps\/DEPTH_[^/\\%?#:]+\.png$/u.test(path) || path.includes('..')) {
            throw new TypeError(`Invalid tile depth inventory path: ${path}`);
        }

        for (let index = 0; index < path.length; index += 1) {
            if (path.charCodeAt(index) < 32) {
                throw new TypeError(`Invalid tile depth inventory path: ${path}`);
            }
        }

        const name = path.slice('media/depthmaps/DEPTH_'.length, -4);

        if (paths.has(name)) {
            throw new TypeError(`Duplicate tile depth inventory path: ${path}`);
        }

        paths.set(name, path);
    }

    for (const name of ['whole_tile', 'billboard', 'preset_depthmaps_01']) {
        if (!paths.has(name)) {
            throw new Error(`Missing native tile depth inventory resource: ${name}`);
        }
    }

    const assignments = parseTileDepthAssignments(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(content, config.assignments)));
    const loading = new Map();
    /* Weak keys let duplicate placements share crops only during a sheet's live
       ingestion window; neither map extends the lifetime of decoded atlas bytes. */
    const depthCrops = new WeakMap();
    const seamCrops = new WeakMap();
    /* A single ingestion lane bounds temporary inflated sheets even when the GPU
       requests many unrelated sprites concurrently. Only cropped results escape. */
    let decodeTail = Promise.resolve();

    /**
     * Share in-flight sheet reads through the bounded decode lane.
     *
     * @param {string} path - Advertised image path.
     * @returns {Promise<{width: number, height: number, blue: Uint8Array, alpha: Uint8Array}>} Decoded sheet.
     */
    async function imageFor(path) {
        let pending = loading.get(path);

        if (!pending) {
            pending = decodeTail.then(() => readFile(content, path)).then(decodeDepthPng);
            decodeTail = pending.then(() => undefined, () => undefined);
            loading.set(path, pending);
        }

        try {
            return await pending;
        } finally {
            if (loading.get(path) === pending) {
                loading.delete(path);
            }
        }
    }

    /**
     * Crop a seam alpha mask with wrapped filtering gutters.
     *
     * @param {string} name - Native seam name.
     * @returns {Promise<object>} Seam geometry and mask.
     */
    async function seamFor(name) {
        const index = SEAMS.indexOf(name);

        if (index === -1) {
            throw new TypeError(`Invalid native seam ${name}`);
        }

        if (!config.seams) {
            throw new Error('Native seam resource is missing from inventory');
        }

        const image = await imageFor(config.seams);

        if (image.width !== 1_024 || image.height !== 256) {
            throw new Error('Invalid native seam sheet geometry');
        }

        let crops = seamCrops.get(image);

        if (!crops) {
            crops = new Map();
            seamCrops.set(image, crops);
        }

        if (crops.has(index)) {
            return crops.get(index);
        }

        /* Native flags0 masks use LINEAR/REPEAT (TextureID.generateHwId).
           Two wrapped texels preserve interpolation beyond the native x=-1 quad
           corner without retaining/uploading the complete atlas. */
        const width = 132;
        const height = 260;
        const pixels = new Uint8Array(width * height);

        for (let y = 0; y < height; y += 1) {
            const sourceY = (y - 2 + image.height) % image.height;

            for (let x = 0; x < width; x += 1) {
                const sourceX = (index * TILE_WIDTH + x - 2 + image.width) % image.width;

                pixels[y * width + x] = image.alpha[sourceY * image.width + sourceX];
            }
        }

        const descriptor = {
            name, vertices: SEAM_VERTICES[name]?.slice() ?? null, mask: {
                key: `${config.seams}:${index}`, width, height, pixels, offsetX: -2, offsetY: -2,
                clip: { offsetX: 0, offsetY: 0, width: TILE_WIDTH, height: TILE_HEIGHT },
                filter: 'linear', source: { path: config.seams, index },
            },
        };

        crops.set(index, descriptor);

        return descriptor;
    }

    /**
     * Resolve one depth tile without following assignments.
     *
     * @param {string} name - Native sprite name.
     * @param {boolean} keepEmpty - Preserve transparent preset tiles.
     * @returns {Promise<object|null>} Depth texture descriptor, or null when absent.
     */
    async function direct(name, keepEmpty = false) {
        const identity = tileIdentity(name);
        const path = identity && paths.get(identity.tileset);

        if (!path) {
            return null;
        }

        const image = await imageFor(path);
        const columns = identity.tileset === 'whole_tile' || identity.tileset === 'billboard' ? 1 : 8;

        if (columns === 1 && identity.index !== 0) {
            return null;
        }

        // Native rows are PNG-height/256, columns remain8 even on narrow originals.
        if (image.height % TILE_HEIGHT || image.width % TILE_WIDTH || image.width > columns * TILE_WIDTH) {
            throw new Error(`Invalid native depth sheet geometry: ${path}`);
        }

        let crops = depthCrops.get(image);

        if (!crops) {
            crops = new Map();
            depthCrops.set(image, crops);
        }

        const cropKey = `${identity.index}:${keepEmpty}`;

        if (crops.has(cropKey)) {
            return crops.get(cropKey);
        }

        const pixels = tilePixels(image, identity.tileset, identity.index, columns, keepEmpty);
        const descriptor = pixels ? { kind: 'texture', key: `${path}:${identity.index}`, width: TILE_WIDTH, height: TILE_HEIGHT, pixels, offsetX: 0, offsetY: 0, source: { path, index: identity.index } } : null;

        crops.set(cropKey, descriptor);

        return descriptor;
    }

    /**
     * Prefer a direct tile, then follow at most one file assignment.
     *
     * @param {string} name - Native sprite name.
     * @returns {Promise<object|null>} Selected depth texture, or null when absent.
     */
    async function assigned(name) {
        return await direct(name) ?? (assignments.has(name) ? direct(assignments.get(name)) : null);
    }

    const snapshotProperties = new WeakMap();
    const noProperties = new Map();

    /**
     * Read authoritative sprite properties, preserving immutable snapshots.
     *
     * @param {string|undefined} name - Registry sprite name.
     * @param {Map<string, string>|object|undefined} snapshot - Source property snapshot.
     * @returns {Map<string, string>} Effective native properties.
     */
    function properties(name, snapshot) {
        if (snapshot === undefined) {
            return tileRegistry.get(name)?.properties ?? noProperties;
        }

        if (snapshot instanceof Map) {
            return snapshot;
        }

        if (!snapshot || typeof snapshot !== 'object' || !Object.isFrozen(snapshot)
            || ![null, Object.prototype].includes(Object.getPrototypeOf(snapshot))) {
            throw new TypeError('Native sprite properties require an immutable source snapshot');
        }

        let result = snapshotProperties.get(snapshot);

        if (!result) {
            result = new Map(Object.entries(snapshot));
            snapshotProperties.set(snapshot, result);
        }

        return result;
    }

    /**
     * Select native depth assets and geometry for one represented draw.
     *
     * @param {string} spriteName - Rendered sprite name.
     * @param {object} context - Proven native owner and render state.
     * @returns {Promise<object>} Suppressed, untextured, or textured draw descriptor.
     */
    async function resolve(spriteName, context = {}) {
        if (context.rendered === false) {
            return { kind: 'suppressed' };
        }

        if (context.currentSpriteName !== undefined) {
            if (typeof context.currentSpriteName !== 'string' || !context.currentSpriteName) {
                throw new TypeError('Invalid native currentSpriteName');
            }

            spriteName = context.currentSpriteName;
        }

        if (!Object.hasOwn(context, 'objectClass')) {
            throw new TypeError('Native tile depth context requires objectClass');
        }

        const nativeClass = context.objectClass;

        if (nativeClass !== null && (typeof nativeClass !== 'string' || !nativeClass)) {
            throw new TypeError('Native tile depth context requires a proven objectClass');
        }

        const effectiveSprite = context.currentSpriteName === undefined ? {} : { spriteName };

        if (context.renderPosition !== undefined) {
            const position = context.renderPosition;

            if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) {
                throw new TypeError('Invalid native renderPosition');
            }

            effectiveSprite.renderPosition = { x: position.x, y: position.y, z: position.z };
        }

        const shape = geometry(context);
        /**
         * Preserve ordinary native depth policy without a depth texture.
         *
         * @param {string} reason - Native exclusion or absence reason.
         * @returns {object} Untextured draw descriptor.
         */
        const untextured = (reason) => ({ kind: 'untextured', depthTest: 'less-equal', depthWrite: !context.renderTranslucentOnly || nativeClass === 'IsoTree', reason, geometry: shape, ...effectiveSprite });
        /**
         * Validate parent-sprite evidence before testing attachment status.
         *
         * @returns {boolean} Whether this draw is an attachment.
         */
        const isAttachment = () => {
            if (typeof context.isParentSprite !== 'boolean') {
                throw new TypeError(`Native ${nativeClass} depth requires isParentSprite`);
            }

            return !context.isParentSprite;
        };

        /* IsoSprite.prepareToRenderSprite changes calculateDepth's XY arguments,
           not the visible quad position, for the native tree exclusion path. */
        if (nativeClass === 'IsoTree') {
            return { ...untextured('IsoTree'), depthPositionOffset: { x: 0.99, y: 0.99 } };
        }

        if (nativeClass === 'IsoBarbecue' && isAttachment()) {
            return untextured('IsoBarbecue attachment');
        }

        let texture;
        let billboard = false;

        if (nativeClass === 'IsoFire' && isAttachment()) {
            texture = await direct('billboard_0');
            billboard = true;
        } else {
            if (['IsoCarBatteryCharger', 'IsoMolotovCocktail', 'IsoWorldInventoryObject', 'IsoZombieGiblets', 'IsoGameCharacter'].includes(nativeClass)) {
                return untextured(nativeClass);
            }

            if (nativeClass === 'IsoTrap') {
                if (!Object.hasOwn(context, 'textureName')) {
                    throw new TypeError('Native IsoTrap depth requires textureName');
                }

                if (context.textureName?.startsWith('Item_')) {
                    return untextured('IsoTrap item texture');
                }
            }

            const props = properties(spriteName, context.spriteProperties);

            texture = await assigned(spriteName);
            /**
             * Load a preset, including a deliberately empty one.
             *
             * @param {string} name - Native preset name.
             * @returns {Promise<object|null>} Preset texture descriptor.
             */
            const preset = (name) => direct(`preset_depthmaps_01_${PRESETS[name]}`, true);
            /**
             * Choose the native wall or doorframe preset.
             *
             * @param {string} direction - Native wall direction.
             * @param {Map<string, string>} selectedProps - Effective wall properties.
             * @returns {Promise<object|null>} Wall texture descriptor.
             */
            const wall = (direction, selectedProps = props) => {
                if (!['N', 'W', 'NW', 'SE'].includes(direction)) {
                    throw new TypeError('Invalid native wall direction');
                }

                let name;

                switch (direction) {
                    case 'N': {
                        name = selectedProps.has('DoorWallN') && !selectedProps.has('doorN') ? 'NDoorFrame' : 'NWall';
                        break;
                    }
                    case 'NW': {
                        name = 'NWWall';
                        break;
                    }
                    case 'SE': {
                        name = 'SEWall';
                        break;
                    }

                    default: {
                        name = selectedProps.has('DoorWallW') && !selectedProps.has('doorW') ? 'WDoorFrame' : 'WWall';
                    }
                }

                if (!context.seam && direction === 'W' && selectedProps.has('WallSE')) {
                    name = 'SEWall';
                }

                return preset(name);
            };

            const parentProps = properties(context.parentSpriteName, context.parentSpriteProperties);
            const canUseParent = context.parentSpriteName && context.parentSpriteName !== spriteName && ((context.depthFlags & 1) || (props.has('WallOverlay') && (props.has('attachedN') || props.has('attachedW'))));
            const wallDirection = context.wallDirection ?? (context.seam?.startsWith('Wall') ? context.direction : undefined);

            if (wallDirection !== undefined) {
                if (!['N', 'W', 'NW', 'SE'].includes(wallDirection)) {
                    throw new TypeError('Invalid native wall direction');
                }

                if (!texture && !context.seam && canUseParent) {
                    texture = await assigned(context.parentSpriteName);
                }

                if (!texture) {
                    texture = await wall(wallDirection, !context.seam && context.depthFlags & 1 && context.parentSpriteName ? parentProps : props);
                }
            } else {
                if (!texture && (props.has('solidfloor') || props.has('FloorOverlay') || props.get('RenderLayer') === 'Floor' || context.renderLayer === 1)) {
                    texture = await preset('Floor');
                }

                if (!texture && canUseParent) {
                    texture = await assigned(context.parentSpriteName);
                }

                if (!texture && (props.has('windowN') || (nativeClass === 'IsoWindow' && parentProps.has('windowN')))) {
                    texture = await wall('N');
                }

                if (!texture && (props.has('windowW') || (nativeClass === 'IsoWindow' && parentProps.has('windowW')))) {
                    texture = await wall('W');
                }

                if (!texture && props.has('WallOverlay') && props.has('attachedW')) {
                    texture = await wall('W');
                }

                if (!texture && props.has('WallOverlay') && props.has('attachedN')) {
                    texture = await wall('N');
                }

                if (!texture && nativeClass === 'IsoFireplace' && isAttachment()) {
                    if (typeof context.fireplaceUsesParentDepth !== 'boolean') {
                        throw new TypeError('Native IsoFireplace requires fireplaceUsesParentDepth');
                    }

                    if (context.fireplaceUsesParentDepth && context.parentSpriteName) {
                        texture = await assigned(context.parentSpriteName);
                    }
                }
            }

            texture ??= await direct('whole_tile_0');
        }

        if (!texture) {
            return untextured('empty native default');
        }

        const result = { ...texture, geometry: shape, ...effectiveSprite, ...(billboard ? { depthPositionOffset: { x: -0.5, y: -0.5 } } : {}) };

        if (context.seam) {
            result.seam = await seamFor(context.seam);
            result.key += `:seam:${context.seam}`;
        }

        if (context.seams?.length) {
            result.additionalDraws = await Promise.all(context.seams.map(async (draw) => {
                if (!draw || !Number.isFinite(draw.screenOffset?.x) || !Number.isFinite(draw.screenOffset?.y)) {
                    throw new TypeError('Native additional seam requires screenOffset');
                }

                const descriptor = await resolve(spriteName, { ...context, seams: undefined, seam: draw.name, direction: draw.direction ?? context.direction, wallDirection: draw.direction ?? context.wallDirection });

                return { ...descriptor, screenOffset: { ...draw.screenOffset } };
            }));
        }

        return result;
    }

    return Object.freeze({ resolve });
}

export { createTileDepthAssets, decodeDepthPng, parseTileDepthAssignments };
