/** @file Lazy original map placements and pack rectangles in the shared WebGPU world pass. */

const DEFAULT_ANCHOR = Object.freeze({ x: 64, y: 192, nativeTilePixels: 128 });
const MAX_TEXTURE_BYTES = 63 * 1_024 * 1_024;
const MAX_CHUNKS = 512;
const INSTANCE_BYTES = 48;

const SHADER = /* wgsl */ `
struct View {
    projection: mat4x4<f32>,
    viewport: vec2<f32>,
    tilePixels: f32,
    padding: f32,
};
@group(0) @binding(0) var<uniform> view: View;
@group(1) @binding(0) var atlas: texture_2d<f32>;
@group(1) @binding(1) var atlasSampler: sampler;
struct Vertex {
    @builtin(position) clip: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) @interpolate(flat) bounds: vec4<f32>,
};
@vertex fn vertexMain(
    @builtin(vertex_index) vertex: u32,
    @location(0) anchor: vec4<f32>,
    @location(1) rect: vec4<f32>,
    @location(2) uv: vec4<f32>,
) -> Vertex {
    let corners = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
        vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0),
    );
    let corner = corners[vertex];
    let pixels = (rect.xy + corner * rect.zw) * view.tilePixels;
    var out: Vertex;
    out.clip = view.projection * vec4<f32>(anchor.xyz, 1.0);
    out.clip = vec4<f32>(out.clip.xy + pixels * vec2<f32>(2.0, -2.0) / view.viewport, out.clip.zw);
    // Preserve the original stack order even across atlas-page batches.
    out.clip.z -= anchor.w * 0.000001;
    out.uv = mix(uv.xy, uv.zw, corner);
    out.bounds = uv;
    return out;
}
@fragment fn fragmentMain(in: Vertex) -> @location(0) vec4<f32> {
    let halfTexel = 0.5 / vec2<f32>(textureDimensions(atlas));
    let uv = clamp(in.uv, in.bounds.xy + halfTexel, in.bounds.zw - halfTexel);
    let colour = textureSample(atlas, atlasSampler, uv);
    if (colour.a <= 0.01) { discard; }
    return colour;
}
`;

/** @typedef {import('./map-tiles.js').MapCell} MapCell */
/** @typedef {import('./map-tiles.js').TilePlacement} TilePlacement */
/** @typedef {import('./packs.js').PackIndex} PackIndex */
/** @typedef {import('./packs.js').PackSprite} PackSprite */
/** @typedef {{x:number,y:number,nativeTilePixels:number}} TileAnchor */
/** @typedef {{x:number,y:number,width:number,height:number,tilePixels?:number}} TileView */
/** @typedef {{left:number,top:number,width:number,height:number,u0:number,v0:number,u1:number,v1:number}} Quad */
/** @typedef {{pack:PackIndex,sprite:PackSprite,key:string,pageKey:string,quad:Quad}} JoinedSprite */

/**
 * Convert a trimmed atlas rectangle into tile-relative sprite geometry.
 * Original floor metadata uses a nominal 128x256 source canvas, anchored at
 * the diamond top. Calibration never alters original placement coordinates.
 *
 * @param {PackSprite} sprite - Original unmodified descriptor.
 * @param {{width:number,height:number}} page - Original atlas dimensions.
 * @param {number} tilePixels - Isometric diamond width on screen.
 * @param {TileAnchor} [anchor] - Offset and source tile width in native pixels.
 * @returns {Quad} Trim geometry and exact atlas UV bounds.
 */
function spriteQuad(sprite, page, tilePixels, anchor = DEFAULT_ANCHOR) {
    const { x, y, w, h, xoff, yoff, totalW, totalH } = sprite;
    const numbers = [x, y, w, h, xoff, yoff, totalW, totalH, page.width, page.height];

    if (!numbers.every(Number.isSafeInteger) || numbers.some(isNegative)
        || page.width < 1 || page.height < 1 || totalW < 1 || totalH < 1
        || x + w > page.width || y + h > page.height) {
        throw new RangeError('Invalid sprite atlas rectangle');
    }

    if (xoff + w > totalW || yoff + h > totalH) {
        throw new RangeError('Invalid sprite trim/canvas rectangle');
    }

    if (!Number.isFinite(tilePixels) || tilePixels <= 0 || !Number.isFinite(anchor.x)
        || !Number.isFinite(anchor.y) || !Number.isFinite(anchor.nativeTilePixels) || anchor.nativeTilePixels <= 0) {
        throw new RangeError('Invalid native sprite scale or anchor');
    }

    const scale = tilePixels / anchor.nativeTilePixels;

    return {
        left: (xoff - anchor.x) * scale, top: (yoff - anchor.y) * scale,
        width: w * scale, height: h * scale,
        u0: x / page.width, v0: y / page.height, u1: (x + w) / page.width, v1: (y + h) / page.height,
    };
}

/**
 * Check an unsigned descriptor field.
 *
 * @param {number} value - Descriptor field.
 * @returns {boolean} Whether the field is negative.
 */
function isNegative(value) {
    return value < 0;
}

/**
 * Project an original placement with the character renderer's exact convention.
 *
 * @param {{x:number,y:number,z:number}} tile - Original world position.
 * @param {{x:number,y:number}} camera - Camera ground position.
 * @param {number} tilePixels - Isometric diamond width.
 * @returns {{x:number,y:number,depth:number}} Camera-relative screen pixels and depth.
 */
function tileScreenPosition(tile, camera, tilePixels) {
    const dx = tile.x - camera.x;
    const dy = tile.y - camera.y;

    return {
        x: (dx - dy) * tilePixels / 2,
        y: (dx + dy) * tilePixels / 4 - tile.z * tilePixels * 1.5,
        depth: 0.5 - (dx + dy) * 0.002 - tile.z * 0.002,
    };
}

/**
 * Invert the screen rectangle expanded by trim extents and all imported levels.
 * Chunk flooring deliberately handles negative original world coordinates.
 *
 * @param {TileView} view - Camera and physical viewport pixels.
 * @param {{left?:number,right?:number,top?:number,bottom?:number,minLevel?:number,maxLevel?:number}} [extents] - Sprite pixel bounds and original z range.
 * @returns {{minX:number,maxX:number,minY:number,maxY:number}} Inclusive world 8x8 chunk bounds.
 */
function visibleChunkBounds(view, extents = {}) {
    const { x, y, width, height } = view;
    const tilePixels = view.tilePixels ?? Math.min(width, height) / 10;
    const { left = 0, right = 0, top = 0, bottom = 0, minLevel = 0, maxLevel = 0 } = extents;
    const values = [x, y, width, height, tilePixels, left, right, top, bottom, minLevel, maxLevel];

    if (!values.every(Number.isFinite) || width <= 0 || height <= 0 || tilePixels <= 0 || minLevel > maxLevel) {
        throw new RangeError('Invalid tile viewport or height bounds');
    }

    const minScreenX = -width / 2 - right;
    const maxScreenX = width / 2 - left;
    const minScreenY = -height / 2 - bottom + minLevel * tilePixels * 1.5;
    const maxScreenY = height / 2 - top + maxLevel * tilePixels * 1.5;

    return {
        minX: Math.floor((x + minScreenX / tilePixels + 2 * minScreenY / tilePixels) / 8),
        maxX: Math.floor((x + maxScreenX / tilePixels + 2 * maxScreenY / tilePixels) / 8),
        minY: Math.floor((y - maxScreenX / tilePixels + 2 * minScreenY / tilePixels) / 8),
        maxY: Math.floor((y - minScreenX / tilePixels + 2 * maxScreenY / tilePixels) / 8),
    };
}

/**
 * Cull the exact trimmed rectangle, not its whole canvas, square or source page.
 *
 * @param {{x:number,y:number,z:number}} tile - Original placement position.
 * @param {{left:number,top:number,width:number,height:number}} quad - Native trim bounds in screen pixels.
 * @param {TileView} view - Actual camera viewport.
 * @returns {boolean} Whether positive-area trimmed pixels intersect the viewport.
 */
function isTileVisible(tile, quad, view) {
    const tilePixels = view.tilePixels ?? Math.min(view.width, view.height) / 10;
    const position = tileScreenPosition(tile, view, tilePixels);
    const left = position.x + quad.left;
    const top = position.y + quad.top;

    return quad.width > 0 && quad.height > 0
        && left < view.width / 2 && left + quad.width > -view.width / 2
        && top < view.height / 2 && top + quad.height > -view.height / 2;
}

/**
 * Admit unique cropped sprite allocations in supplied priority order.
 * Source atlas dimensions do not enter this GPU budget; no full pages are retained.
 *
 * @param {Array<{key:string,w:number,h:number}>} sprites - Prioritized original trim sizes.
 * @param {number} budget - Hard RGBA8 texture-byte cap.
 * @returns {{selected:Set<string>,deferred:string[],bytes:number}} Exact bounded allocation plan.
 */
function createSpriteResidencyPlan(sprites, budget) {
    if (!Number.isSafeInteger(budget) || budget < 0 || budget > MAX_TEXTURE_BYTES) {
        throw new RangeError('Invalid cropped sprite budget');
    }

    const selected = new Set();
    const seen = new Set();
    const deferred = [];
    let bytes = 0;

    for (const { key, w, h } of sprites) {
        if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w < 0 || h < 0 || !Number.isSafeInteger(w * h * 4)) {
            throw new RangeError('Invalid cropped sprite dimensions');
        }

        if (seen.has(key) || !w || !h) {
            continue;
        }

        seen.add(key);
        const allocation = w * h * 4;

        if (bytes + allocation <= budget) {
            selected.add(key);
            bytes += allocation;
        } else {
            deferred.push(key);
        }
    }

    return { selected, deferred, bytes };
}

/**
 * Preserve far-to-near alpha blending and original same-square stack order.
 * Camera translation adds the same depth to every placement, so it is absent here.
 *
 * @param {{tile:TilePlacement}} a - First joined placement.
 * @param {{tile:TilePlacement}} b - Second joined placement.
 * @returns {number} Stable depth/order comparison.
 */
function compareTiles(a, b) {
    const depthA = -(a.tile.x + a.tile.y + a.tile.z) * 0.002 - a.tile.order * 0.000_001;
    const depthB = -(b.tile.x + b.tile.y + b.tile.z) * 0.002 - b.tile.order * 0.000_001;

    return depthB - depthA || a.tile.x - b.tile.x || a.tile.y - b.tile.y || a.tile.z - b.tile.z || a.tile.order - b.tile.order;
}

/**
 * Cache detached current door placements only when native state changes.
 * Source keys remove exactly the authored base placement; dynamic placements are
 * drawn separately so a moved panel never depends on its source chunk residency.
 *
 * @param {{visuals:object[],revision:()=>number,read:()=>object[]}} doors - Static source identities and authoritative native state.
 * @returns {()=>{revision:number,sourceKeys:Set<string>,tiles:object[]}} Atomic revision snapshot reader.
 */
function createDoorRenderProjection(doors) {
    if (!doors || !Array.isArray(doors.visuals) || typeof doors.revision !== 'function' || typeof doors.read !== 'function') {
        throw new TypeError('Door rendering requires source visuals and native revision/read callbacks');
    }

    const sourceKeys = new Set();
    const identities = new Set();

    for (const visual of doors.visuals) {
        if (!visual || typeof visual.id !== 'string' || !visual.id || identities.has(visual.id)
            || !Number.isInteger(visual.sourceX) || !Number.isInteger(visual.sourceY) || !Number.isInteger(visual.z)
            || !Number.isInteger(visual.order) || visual.order < 0
            || ['closedSpriteName', 'openSpriteName', 'toggledClosedSpriteName', 'toggledOpenSpriteName'].some((key) => typeof visual[key] !== 'string' || !visual[key])) {
            throw new TypeError('Invalid or duplicate source door visual identity');
        }

        const key = `${visual.sourceX}:${visual.sourceY}:${visual.z}:${visual.order}`;

        if (sourceKeys.has(key)) {
            throw new Error(`Duplicate source door placement ${key}`);
        }

        sourceKeys.add(key);
        identities.add(visual.id);
    }

    let snapshot;

    return function refresh() {
        const revision = doors.revision();

        if (!Number.isSafeInteger(revision) || revision < 0) {
            throw new TypeError('Invalid native door revision');
        }

        if (snapshot?.revision === revision) {
            return snapshot;
        }

        const rows = doors.read();

        if (!Array.isArray(rows)) {
            throw new TypeError('Native door state must be an array');
        }

        const current = new Map();

        for (const row of rows) {
            if (!row || !identities.has(row.id) || current.has(row.id)) {
                throw new Error('Unknown or duplicate native door identity');
            }

            if (![row.x, row.y, row.z].every((value) => Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647)) {
                throw new TypeError(`Invalid native door coordinate for ${row.id}`);
            }

            if (typeof row.open !== 'boolean' || typeof row.toggled !== 'boolean') {
                throw new TypeError(`Native door open/toggled state must be boolean for ${row.id}`);
            }

            current.set(row.id, row);
        }

        const tiles = doors.visuals.map((visual) => {
            const row = current.get(visual.id);

            if (!row) {
                throw new Error(`Missing native door state for ${visual.id}`);
            }

            if (row.z !== visual.z) {
                throw new TypeError(`Native door coordinate level changed for ${visual.id}`);
            }

            let spriteName;

            if (row.toggled) {
                if (row.open) {
                    spriteName = visual.toggledOpenSpriteName;
                } else {
                    spriteName = visual.toggledClosedSpriteName;
                }
            } else if (row.open) {
                spriteName = visual.openSpriteName;
            } else {
                spriteName = visual.closedSpriteName;
            }

            return { x: row.x, y: row.y, z: row.z, order: visual.order, spriteName };
        });

        snapshot = { revision, sourceKeys, tiles };

        return snapshot;
    };
}

/**
 * Create one bounded original-content world layer. Pack precedence is the supplied
 * array order, followed by first on-disk occurrence; no missing names are remapped.
 *
 * @param {{device:GPUDevice,format:string,sampler:GPUSampler,packs:Array<PackIndex>,cells:Array<MapCell>,anchor?:TileAnchor,textureBudget?:number,doors?:{visuals:object[],revision:()=>number,read:()=>object[]}}} options - Shared renderer resources and user-selected metadata.
 * @returns {object} Async update/whenLoaded, synchronous render, diagnostics and destroy.
 */
function createTileLayer({ device, format, sampler, packs, cells, anchor = DEFAULT_ANCHOR, textureBudget = MAX_TEXTURE_BYTES, doors }) {
    if (!Number.isSafeInteger(textureBudget) || textureBudget < 4 || textureBudget > MAX_TEXTURE_BYTES) {
        throw new RangeError('Tile texture budget must be positive and below 64 MiB');
    }

    if (!Number.isFinite(anchor.x) || !Number.isFinite(anchor.y) || !Number.isFinite(anchor.nativeTilePixels) || anchor.nativeTilePixels <= 0) {
        throw new RangeError('Invalid native sprite scale or anchor');
    }

    const effectiveAnchor = Object.freeze({ ...anchor });
    const refreshDoors = doors === undefined ? undefined : createDoorRenderProjection(doors);
    const doorSpriteNames = new Set();

    for (const visual of doors?.visuals ?? []) {
        doorSpriteNames.add(visual.closedSpriteName);
        doorSpriteNames.add(visual.openSpriteName);
        doorSpriteNames.add(visual.toggledClosedSpriteName);
        doorSpriteNames.add(visual.toggledOpenSpriteName);
    }

    /** @type {Map<string, JoinedSprite>} */
    const catalogue = new Map();
    const missingSprites = new Set();
    const errors = new Map();
    const chunks = new Map();
    const textures = new Map();
    const geometry = new Map();
    const uniforms = new Float32Array(20);
    const frameView = { x: 0, y: 0, width: 1, height: 1, tilePixels: 1 };
    const floorCalibration = [];
    const extents = { left: 0, right: 0, top: 0, bottom: 0, minLevel: 0, maxLevel: 0 };
    let textureBytes = 0;
    let destroyed = false;
    let loading = false;
    let clock = 0;
    let desired = null;
    let activeKey = '';
    let completedKey = '';
    let pending = Promise.resolve();
    let runs = [];
    let visiblePlacements = 0;
    let deferredSprites = [];
    let renderedInstances = 0;
    let visibleMissingPlacements = 0;
    let drawTiles = [];
    let cachedPlacements = 0;
    let visibleSourceAtlasBytes = 0;

    for (const cell of cells) {
        extents.minLevel = Math.min(extents.minLevel, cell.minLevel);
        extents.maxLevel = Math.max(extents.maxLevel, cell.maxLevel);
    }

    for (const names of [...cells.map((cell) => cell.tileNames), doorSpriteNames]) {
        for (const name of names) {
            if (catalogue.has(name) || missingSprites.has(name)) {
                continue;
            }

            let joined;

            for (const [packIndex, pack] of packs.entries()) {
                const sprite = pack.lookup(name);

                if (sprite) {
                    const page = pack.pages[sprite.pageIndex];
                    const quad = spriteQuad(sprite, page, 1, effectiveAnchor);

                    joined = { pack, sprite, quad, key: `${packIndex}:${sprite.pageIndex}:${sprite.entryIndex}`, pageKey: `${packIndex}:${sprite.pageIndex}` };
                    break;
                }
            }

            if (!joined) {
                missingSprites.add(name);
                continue;
            }

            catalogue.set(name, joined);
            const { sprite, pack, quad } = joined;

            if (floorCalibration.length < 8 && name.includes('floors') && sprite.w > 0 && Math.abs(sprite.h * 2 - sprite.w) <= 2) {
                floorCalibration.push({
                    name, source: pack.source.name,
                    trim: { xoff: sprite.xoff, yoff: sprite.yoff, width: sprite.w, height: sprite.h },
                    canvas: { width: sprite.totalW, height: sprite.totalH },
                    suggestedAnchor: { x: sprite.totalW / 2, y: sprite.yoff, nativeTilePixels: sprite.totalW },
                    confidence: 'Original floor trim and nominal canvas; diamond-top anchor, not diamond centre',
                });
            }

            extents.left = Math.min(extents.left, quad.left);
            extents.right = Math.max(extents.right, quad.left + quad.width);
            extents.top = Math.min(extents.top, quad.top);
            extents.bottom = Math.max(extents.bottom, quad.top + quad.height);
        }
    }

    const module = device.createShaderModule({ label: 'original tile quads', code: SHADER });
    const pipeline = device.createRenderPipeline({
        label: 'original tile world layer', layout: 'auto',
        vertex: {
            module, entryPoint: 'vertexMain',
            buffers: [{
                arrayStride: INSTANCE_BYTES, stepMode: 'instance',
                attributes: [
                    { shaderLocation: 0, offset: 0, format: 'float32x4' },
                    { shaderLocation: 1, offset: 16, format: 'float32x4' },
                    { shaderLocation: 2, offset: 32, format: 'float32x4' },
                ],
            }],
        },
        fragment: {
            module, entryPoint: 'fragmentMain',
            targets: [{
                format,
                blend: {
                    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                },
            }],
        },
        primitive: { topology: 'triangle-list' },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
    });
    const uniformBuffer = device.createBuffer({ label: 'tile projection', size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const viewGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uniformBuffer } }] });

    /**
     * Destroy CPU-window geometry after a window change, never each frame.
     *
     * @returns {void} Releases instance buffers and draw runs.
     */
    function clearGeometry() {
        for (const batch of geometry.values()) {
            batch.buffer.destroy();
        }

        geometry.clear();
        runs = [];
    }

    /**
     * Rebuild instances only after cropped residency or visible geometry changes.
     * Contiguous runs retain global alpha order; each original sprite owns one buffer.
     *
     * @returns {void} Updates immutable instance buffers and draw runs.
     */
    function rebuild() {
        clearGeometry();
        const tiles = [];
        const bySprite = new Map();

        for (const entry of drawTiles) {
            if (textures.has(entry.joined.key)) {
                tiles.push(entry);
            }
        }

        tiles.sort(compareTiles);

        for (const entry of tiles) {
            let batch = bySprite.get(entry.joined.key);

            if (!batch) {
                batch = [];
                bySprite.set(entry.joined.key, batch);
            }

            const first = batch.length;
            const last = runs.at(-1);

            batch.push(entry);

            if (last?.key === entry.joined.key) {
                last.count += 1;
            } else {
                runs.push({ key: entry.joined.key, first, count: 1 });
            }
        }

        for (const [key, entries] of bySprite) {
            const data = new Float32Array(entries.length * 12);

            for (const [index, { tile, joined }] of entries.entries()) {
                const { quad } = joined;

                data.set([tile.x, tile.y, tile.z, tile.order, quad.left, quad.top, quad.width, quad.height, 0, 0, 1, 1], index * 12);
            }

            if (data.byteLength > device.limits.maxBufferSize) {
                errors.set(`geometry:${key}`, 'Visible sprite instances exceed the GPU buffer limit');
                continue;
            }

            const buffer = device.createBuffer({ label: `tile instances ${key}`, size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });

            device.queue.writeBuffer(buffer, 0, data);
            geometry.set(key, { buffer });
        }
    }

    /**
     * Evict least-recently-used nonselected textures before a new allocation.
     *
     * @param {number} bytes - Required new allocation.
     * @param {Set<string>} pinned - Cropped sprites admitted for the current viewport.
     * @returns {void} Frees enough cache space or leaves an explicit budget error.
     */
    function evict(bytes, pinned) {
        while (textureBytes + bytes > textureBudget) {
            let oldest;

            for (const [key, texture] of textures) {
                if (!pinned.has(key) && (!oldest || texture.used < oldest.texture.used)) {
                    oldest = { key, texture };
                }
            }

            if (!oldest) {
                throw new RangeError('Visible cropped sprites exceed the tile texture budget');
            }

            oldest.texture.texture.destroy();
            textureBytes -= oldest.texture.bytes;
            textures.delete(oldest.key);
        }
    }

    /**
     * Decode one source PNG for all needed cropped sprites on that page.
     * Never retain the complete atlas on GPU; late async bitmaps always close.
     *
     * @param {JoinedSprite[]} group - Exact original sprites from one source page.
     * @param {Set<string>} pinned - Current admitted crop allocations.
     * @returns {Promise<void>} Resolves after original rectangle uploads or cancellation.
     */
    async function upload(group, pinned) {
        const first = group[0];
        const page = first.pack.pages[first.sprite.pageIndex];
        const blob = await first.pack.pageBlob(first.sprite.pageIndex);

        if (destroyed) {
            return;
        }

        const bitmap = await createImageBitmap(blob);

        try {
            if (destroyed) {
                return;
            }

            if (bitmap.width !== page.width || bitmap.height !== page.height) {
                throw new RangeError('Decoded atlas dimensions disagree with original metadata');
            }

            for (const joined of group) {
                if (destroyed) {
                    return;
                }

                const { sprite, key, pageKey } = joined;
                const bytes = sprite.w * sprite.h * 4;

                if (sprite.w > device.limits.maxTextureDimension2D || sprite.h > device.limits.maxTextureDimension2D) {
                    throw new RangeError('Original sprite crop exceeds GPU texture dimensions');
                }

                evict(bytes, pinned);
                let texture;

                try {
                    texture = device.createTexture({
                        label: `original sprite ${key}`, size: [sprite.w, sprite.h], format: 'rgba8unorm',
                        usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
                    });
                    device.queue.copyExternalImageToTexture(
                        { source: bitmap, origin: { x: sprite.x, y: sprite.y } },
                        { texture, premultipliedAlpha: true }, [sprite.w, sprite.h],
                    );
                    const bindGroup = device.createBindGroup({
                        layout: pipeline.getBindGroupLayout(1),
                        entries: [{ binding: 0, resource: texture.createView() }, { binding: 1, resource: sampler }],
                    });

                    textures.set(key, { texture, group: bindGroup, pageKey, bytes, used: ++clock });
                    textureBytes += bytes;
                } catch (error) {
                    texture?.destroy();
                    throw error;
                }
            }
        } finally {
            bitmap.close();
        }
    }

    /**
     * Compute the cheap screen/height window key before touching chunk metadata.
     *
     * @param {TileView} view - Requested camera viewport.
     * @param {object|undefined} doorSnapshot - Revision-cached native door projection.
     * @returns {{key:string,bounds:object,tilePixels:number}} Normalized window identity.
     */
    function windowFor(view, doorSnapshot) {
        const tilePixels = view.tilePixels ?? Math.min(view.width, view.height) / 10;
        const bounds = visibleChunkBounds(view, {
            left: extents.left * tilePixels, right: extents.right * tilePixels,
            top: extents.top * tilePixels, bottom: extents.bottom * tilePixels,
            minLevel: extents.minLevel, maxLevel: extents.maxLevel,
        });

        return { key: `${view.x}:${view.y}:${view.width}:${view.height}:${tilePixels}:${doorSnapshot?.revision ?? ''}`, bounds, tilePixels, doorSnapshot };
    }

    /**
     * Select actual cell-local chunk indices only when the window changes.
     *
     * @param {TileView} view - Requested camera viewport.
     * @param {{key:string,bounds:object,tilePixels:number,doorSnapshot?:object}} window - Normalized camera/native-state identity.
     * @returns {{key:string,view:TileView,selected:Map<string,object>,doorSnapshot?:object}} Bounded selected window.
     */
    function select(view, { key, bounds, tilePixels, doorSnapshot }) {
        const selected = new Map();

        for (const [cellIndex, cell] of cells.entries()) {
            const originX = cell.cellX * cell.chunksPerAxis;
            const originY = cell.cellY * cell.chunksPerAxis;
            let chunkX = Math.max(0, bounds.minX - originX);
            const endX = Math.min(cell.chunksPerAxis - 1, bounds.maxX - originX);

            while (chunkX <= endX) {
                let chunkY = Math.max(0, bounds.minY - originY);
                const endY = Math.min(cell.chunksPerAxis - 1, bounds.maxY - originY);

                while (chunkY <= endY) {
                    const chunk = cell.chunks[chunkX * cell.chunksPerAxis + chunkY];

                    if (chunk.present) {
                        selected.set(`${cellIndex}:${chunkX}:${chunkY}`, { cell, chunkX, chunkY });
                    }

                    chunkY += 1;
                }

                chunkX += 1;
            }
        }

        if (selected.size > MAX_CHUNKS) {
            throw new RangeError(`Tile viewport exceeds the ${MAX_CHUNKS}-chunk cache limit`);
        }

        return { key, view: { ...view, tilePixels }, selected, doorSnapshot };
    }

    /**
     * Fill exactly one chunk cache entry, retaining original parser failures.
     *
     * @param {string} key - Cell-local chunk identity.
     * @param {{cell:MapCell,chunkX:number,chunkY:number}} chunk - Lazy original chunk.
     * @returns {Promise<void>} Resolves after a read, retained error or cancellation.
     */
    async function loadChunk(key, chunk) {
        if (chunks.has(key) || destroyed) {
            return;
        }

        try {
            const placements = await chunk.cell.readChunk(chunk.chunkX, chunk.chunkY);

            if (!destroyed) {
                chunks.set(key, placements);
            }
        } catch (error) {
            if (!destroyed) {
                errors.set(`chunk:${key}`, String(error));
            }
        }
    }

    /**
     * Drain the latest requested window; intermediate camera updates are coalesced.
     *
     * @returns {Promise<void>} Resolves when the current window has settled.
     */
    async function drain() {
        while (desired && !destroyed) {
            const request = desired;

            desired = null;
            activeKey = request.key;
            errors.clear();

            for (const key of chunks.keys()) {
                if (!request.selected.has(key)) {
                    chunks.delete(key);
                }
            }

            // Sequential chunk reads bound parser working memory to one chunk.
            /* eslint-disable no-await-in-loop */
            for (const [key, chunk] of request.selected) {
                await loadChunk(key, chunk);
            }
            /* eslint-enable no-await-in-loop */

            if (destroyed) {
                return;
            }

            const wanted = new Map();
            const sourcePages = new Map();

            drawTiles = [];
            cachedPlacements = 0;
            visibleSourceAtlasBytes = 0;

            visiblePlacements = 0;
            visibleMissingPlacements = 0;

            const placementGroups = [...chunks.values()];

            if (request.doorSnapshot) {
                placementGroups.push(request.doorSnapshot.tiles);
            }

            for (const placements of placementGroups) {
                const dynamicDoors = placements === request.doorSnapshot?.tiles;

                if (!dynamicDoors) {
                    cachedPlacements += placements.length;
                }

                for (const tile of placements) {
                    if (!dynamicDoors && request.doorSnapshot?.sourceKeys.has(`${tile.x}:${tile.y}:${tile.z}:${tile.order}`)) {
                        continue;
                    }

                    const joined = catalogue.get(tile.spriteName);

                    if (!joined) {
                        visibleMissingPlacements += 1;
                    }

                    if (!joined || !joined.sprite.w || !joined.sprite.h) {
                        continue;
                    }

                    const quad = joined.quad;
                    const screenQuad = {
                        left: quad.left * request.view.tilePixels, top: quad.top * request.view.tilePixels,
                        width: quad.width * request.view.tilePixels, height: quad.height * request.view.tilePixels,
                    };

                    if (!isTileVisible(tile, screenQuad, request.view)) {
                        continue;
                    }

                    visiblePlacements += 1;
                    drawTiles.push({ tile, joined });
                    sourcePages.set(joined.pageKey, joined.pack.pages[joined.sprite.pageIndex]);
                    const distance = (tile.x - request.view.x) ** 2 + (tile.y - request.view.y) ** 2;
                    const previous = wanted.get(joined.key);

                    if (!previous || distance < previous.distance) {
                        wanted.set(joined.key, { joined, distance });
                    }
                }
            }

            const ordered = [...wanted.values()].sort(compareSprites);
            const plan = createSpriteResidencyPlan(ordered.map(residencyEntry), textureBudget);
            const pinned = plan.selected;
            const groups = new Map();

            deferredSprites = [];

            for (const page of sourcePages.values()) {
                visibleSourceAtlasBytes += page.width * page.height * 4;
            }

            for (const key of plan.deferred) {
                const { joined } = wanted.get(key);

                deferredSprites.push({ key, source: joined.pack.source.name, sprite: joined.sprite.name, bytes: joined.sprite.w * joined.sprite.h * 4, reason: 'texture budget' });
            }

            for (const [key, texture] of textures) {
                if (wanted.has(key) && !pinned.has(key)) {
                    texture.texture.destroy();
                    textureBytes -= texture.bytes;
                    textures.delete(key);
                }
            }

            for (const { joined } of ordered) {
                if (!pinned.has(joined.key)) {
                    continue;
                }

                if (textures.has(joined.key)) {
                    textures.get(joined.key).used = ++clock;
                    continue;
                }

                let group = groups.get(joined.pageKey);

                if (!group) {
                    group = [];
                    groups.set(joined.pageKey, group);
                }

                group.push(joined);
            }

            rebuild();

            // Decode only one original page at a time; all needed crops share its bitmap.
            /* eslint-disable no-await-in-loop */
            for (const [pageKey, group] of groups) {
                if (destroyed) {
                    return;
                }

                try {
                    await upload(group, pinned);

                    if (!destroyed) {
                        rebuild();
                    }
                } catch (error) {
                    if (!destroyed) {
                        errors.set(`page:${pageKey}`, String(error));
                    }
                }
            }
            /* eslint-enable no-await-in-loop */

            completedKey = request.key;
        }
    }

    /**
     * Request the latest camera window; a stationary window reuses all geometry.
     *
     * @param {TileView} view - Camera and viewport pixels.
     * @returns {Promise<void>} Settled latest window; detailed partial failures are in diagnostics.
     */
    function update(view) {
        if (destroyed) {
            return Promise.reject(new Error('Tile layer is destroyed'));
        }

        const window = windowFor(view, refreshDoors?.());

        if (window.key === activeKey && loading) {
            desired = null;

            return pending;
        }

        if (window.key === desired?.key || (window.key === completedKey && !loading)) {
            return pending;
        }

        desired = select(view, window);

        if (!loading) {
            loading = true;
            pending = drain().finally(finishLoading);
            pending.catch(recordFailure);
        }

        return pending;
    }

    /**
     * Settle the worker and pick up requests queued during promise completion.
     *
     * @returns {void} Marks the latest load settled.
     */
    function finishLoading() {
        loading = false;
        activeKey = '';

        if (desired && !destroyed) {
            loading = true;
            pending = drain().finally(finishLoading);
            pending.catch(recordFailure);
        }
    }

    /**
     * Retain asynchronous errors instead of hiding failures from the parent UI.
     *
     * @param {unknown} error - Decode/update exception.
     * @returns {void} Records an actionable error string.
     */
    function recordFailure(error) {
        if (!destroyed) {
            errors.set('update', String(error));
        }
    }

    return {
        update,
        /**
         * Wait for the current coalesced window for parent browser evidence.
         *
         * @returns {Promise<void>} Latest settled window and GPU upload completion.
         */
        async whenLoaded() {
            while (loading && !destroyed) {
                // eslint-disable-next-line no-await-in-loop -- A camera request can replace the worker promise while the previous one settles.
                await pending;
            }

            if (!destroyed) {
                await device.queue.onSubmittedWorkDone();
            }
        },
        /**
         * Draw only cached instances; camera movement is a uniform change.
         *
         * @param {GPURenderPassEncoder} pass - Shared character depth pass.
         * @param {{projection:Float32Array,camera:{x:number,y:number},tilePixels:number,width:number,height:number}} context - Shared isometric view.
         * @returns {boolean} True after a prepared, error-free world window encoded real source tile draws.
         */
        render(pass, { projection, camera, tilePixels, width, height }) {
            if (destroyed) {
                return false;
            }

            try {
                frameView.x = camera.x;
                frameView.y = camera.y;
                frameView.width = width;
                frameView.height = height;
                frameView.tilePixels = tilePixels;
                update(frameView);
            } catch (error) {
                recordFailure(error);
            }

            uniforms.set(projection, 0);
            uniforms[16] = width;
            uniforms[17] = height;
            uniforms[18] = tilePixels;
            device.queue.writeBuffer(uniformBuffer, 0, uniforms);
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, viewGroup);
            renderedInstances = 0;

            for (const run of runs) {
                const texture = textures.get(run.key);
                const batch = geometry.get(run.key);

                if (texture && batch) {
                    pass.setBindGroup(1, texture.group);
                    pass.setVertexBuffer(0, batch.buffer);
                    pass.draw(6, run.count, 0, run.first);
                    renderedInstances += run.count;
                }
            }

            return renderedInstances > 0 && completedKey !== '' && errors.size === 0;
        },
        /**
         * Report missing names, incomplete page admission and actual cache state.
         * No diagnostics claim native anchor calibration or complete scene fidelity.
         *
         * @returns {object} Detached metadata, never original pixels or asset bytes.
         */
        diagnostics() {
            return {
                destroyed, loading, textureBytes, textureBudget,
                cachedChunks: chunks.size, chunkLimit: MAX_CHUNKS,
                residentSprites: textures.size, residentPages: new Set([...textures.values()].map(texturePageKey)).size,
                visiblePlacements, cachedPlacements, visibleMissingPlacements, renderedInstances, drawRuns: runs.length,
                visibleSourceAtlasBytes, textureStorage: 'original trimmed sprite crops',
                missingSprites: [...missingSprites], missingSpriteCount: missingSprites.size,
                errors: [...errors.entries()].map(errorEntry), deferredSprites: [...deferredSprites],
                anchor: { ...effectiveAnchor }, anchorConfidence: 'Original nominal128x256 floor canvas and diamond-top convention; caller-calibratable',
                floorCalibration: [...floorCalibration],
                packPrecedence: packs.map(packName),
                complete: !loading && !errors.size && !missingSprites.size && !deferredSprites.length,
            };
        },
        /**
         * Release ownership immediately; late async bitmaps close without upload.
         *
         * @returns {void} Releases GPU and window caches idempotently.
         */
        destroy() {
            if (destroyed) {
                return;
            }

            destroyed = true;
            desired = null;
            clearGeometry();
            uniformBuffer.destroy();

            for (const texture of textures.values()) {
                texture.texture.destroy();
            }

            textures.clear();
            chunks.clear();
            catalogue.clear();
            drawTiles = [];
            textureBytes = 0;
        },
    };
}

/**
 * Prioritize the nearest visible original sprite without arbitrary name remaps.
 *
 * @param {{distance:number,joined:JoinedSprite}} a - First needed sprite.
 * @param {{distance:number,joined:JoinedSprite}} b - Second needed sprite.
 * @returns {number} Deterministic distance and original sprite-id ordering.
 */
function compareSprites(a, b) {
    return a.distance - b.distance || a.joined.key.localeCompare(b.joined.key);
}

/**
 * Detach one retained error for JSON-friendly parent status.
 *
 * @param {[string,string]} entry - Error source and message.
 * @returns {{source:string,message:string}} Displayable failure.
 */
function errorEntry([source, message]) {
    return { source, message };
}

/**
 * Report source precedence without retaining original bytes in diagnostics.
 *
 * @param {PackIndex} pack - Imported original index.
 * @returns {string} Original source name.
 */
function packName(pack) {
    return pack.source.name;
}

/**
 * Extract exact original crop dimensions for the shared residency planner.
 *
 * @param {{joined:JoinedSprite}} entry - Needed original sprite.
 * @returns {{key:string,w:number,h:number}} Stable identity and allocation size.
 */
function residencyEntry({ joined }) {
    return { key: joined.key, w: joined.sprite.w, h: joined.sprite.h };
}

/**
 * Count original page owners without pretending the full atlases are resident.
 *
 * @param {{pageKey:string}} texture - Cropped sprite allocation.
 * @returns {string} Original pack/page identity.
 */
function texturePageKey(texture) {
    return texture.pageKey;
}

export { compareTiles, createDoorRenderProjection, createSpriteResidencyPlan, createTileLayer, isTileVisible, spriteQuad, tileScreenPosition, visibleChunkBounds };
