import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareTiles, createSpriteResidencyPlan, createTileLayer, isTileVisible, spriteQuad, tileDepthQuad, tileScreenPosition, visibleChunkBounds } from '../src/tile-renderer.js';

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
    assert.deepEqual(tileScreenPosition({ x: 193, y: 194, z: 2 }, { x: 193, y: 194 }, 64), { x: 0, y: -192, depth: 0.5 - 2 * 0.002_886_708_4 });
    assert.deepEqual(tileScreenPosition({ x: 194, y: 194, z: 0 }, { x: 193, y: 194 }, 64), { x: 32, y: 16, depth: 0.5 - 0.001_443_354_2 });
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
    assert.equal(compareTiles({ tile: { ...base, order: 1_000_000 } }, { tile: east }) < 0, true, 'stack order cannot displace genuine square depth');
    assert.equal(compareTiles({ tile: { ...base, x: 194, y: 193, order: 2 } }, { tile: { ...base, order: 1 } }) > 0, true, 'equal-depth ties preserve original placement order');
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

// Catches stretching depth UVs over a different diffuse trim or dropping native offsets/scale.
test('native depth intersection crops geometry and both independently owned UV rectangles', () => {
    const sprite = { ...SPRITE, xoff: 10, yoff: 20, w: 40, h: 80 };
    const depth = { kind: 'texture', width: 50, height: 70, offsetX: 30, offsetY: 25, geometry: { scaleX: 2, scaleY: 1, soffX: 3, soffY: 5 } };

    assert.deepEqual(tileDepthQuad(sprite, depth), {
        left: (30 - 64) / 128, top: (25 - 192) / 128,
        width: 50 / 128, height: 70 / 128,
        u0: 7 / 80, v0: 0, u1: 57 / 80, v1: 70 / 80,
        depthU0: 0, depthV0: 0, depthU1: 1, depthV1: 1,
    });
    const disjoint = tileDepthQuad(sprite, { ...depth, offsetX: 200 });

    assert.equal(disjoint.width, 0);
    assert.throws(() => tileDepthQuad(sprite, { ...depth, width: -1 }), /depth/iu);
});

test('depth allocations participate in exact sprite admission rather than exceeding the hard cap', () => {
    const sprites = [{ key: 'first', w: 2, h: 2, depthBytes: 9 }, { key: 'second', w: 2, h: 2, depthBytes: 9 }];

    assert.deepEqual(createSpriteResidencyPlan(sprites, 49), { selected: new Set(['first']), deferred: ['second'], bytes: 25 });
    assert.throws(() => createSpriteResidencyPlan([{ ...sprites[0], depthBytes: -1 }], 49), /dimensions/iu);
});

// Catches per-frame door snapshot reads, constructor/toggled art confusion and moved-panel source-coordinate reuse.
test('door render projection refreshes only by native revision and preserves current panel position and original stack order', async () => {
    const { createDoorRenderProjection } = await import('../src/tile-renderer.js');

    const visuals = [
        { id: 'door:7:3:1:4', x: 7, y: 3, z: 1, order: 4, sourceX: 7, sourceY: 3, sourceSpriteName: 'synthetic_closed', closedSpriteName: 'synthetic_closed', openSpriteName: 'synthetic_constructor_open', toggledClosedSpriteName: 'synthetic_toggle_closed', toggledOpenSpriteName: 'synthetic_toggle_open' },
        { id: 'door:-1:0:0:9', x: -1, y: 0, z: 0, order: 9, sourceX: -2, sourceY: 1, sourceSpriteName: 'synthetic_open', closedSpriteName: 'synthetic_constructor_closed', openSpriteName: 'synthetic_open', toggledClosedSpriteName: 'synthetic_panel_closed', toggledOpenSpriteName: 'synthetic_panel_open' },
    ];
    const before = structuredClone(visuals);
    let revision = 0;
    let reads = 0;
    let rows = [
        { id: visuals[0].id, x: 7, y: 3, z: 1, open: false, toggled: false },
        { id: visuals[1].id, x: -2, y: 1, z: 0, open: true, toggled: false },
    ];
    const refresh = createDoorRenderProjection({
        visuals,
        /**
         * Read the fixture's native revision without allocating a snapshot.
         *
         * @returns {number} Current native revision.
         */
        revision: () => revision,
        /**
         * Count native reads and return the current fixture state.
         *
         * @returns {Array<{id:string,x:number,y:number,z:number,open:boolean,toggled:boolean}>} Current door rows.
         */
        read: () => {
            reads += 1;

            return rows;
        },
    });
    const initial = refresh();

    assert.deepEqual(initial.tiles, [
        { x: 7, y: 3, z: 1, order: 4, spriteName: 'synthetic_closed' },
        { x: -2, y: 1, z: 0, order: 9, spriteName: 'synthetic_open' },
    ]);
    assert.equal(initial.sourceKeys.has('7:3:1:4'), true);
    assert.equal(initial.sourceKeys.has('-2:1:0:9'), true);
    assert.equal(initial.sourceKeys.has('7:3:1:5'), false);
    assert.equal(refresh(), initial);
    assert.equal(refresh(), initial);
    assert.equal(reads, 1);
    rows = [
        { id: visuals[0].id, x: 8, y: 4, z: 1, open: true, toggled: true },
        { id: visuals[1].id, x: -1, y: 0, z: 0, open: false, toggled: true },
    ];
    revision += 1;
    const opened = refresh();

    assert.notEqual(opened, initial);
    assert.deepEqual(opened.tiles, [
        { x: 8, y: 4, z: 1, order: 4, spriteName: 'synthetic_toggle_open' },
        { x: -1, y: 0, z: 0, order: 9, spriteName: 'synthetic_panel_closed' },
    ]);
    assert.equal(opened.sourceKeys, initial.sourceKeys);
    assert.equal(opened.tiles[0].sourceX, 7, 'moved panel depth resolves against original constructor ownership');
    assert.equal(opened.tiles[0].sourceY, 3);
    assert.equal(Object.keys(opened.tiles[0]).includes('sourceX'), false, 'private resolver identity does not change the public projection snapshot');
    assert.equal(refresh(), opened);
    assert.equal(reads, 2);
    // Exact current-position culling still respects original z instead of flattening moved panels.
    const view = { x: 8, y: 4, width: 2, height: 2, tilePixels: 64 };

    assert.equal(isTileVisible(opened.tiles[0], { left: -1, top: -1, width: 2, height: 2 }, view), false);
    assert.equal(isTileVisible({ ...opened.tiles[0], z: 0 }, { left: -1, top: -1, width: 2, height: 2 }, view), true);
    rows[0] = { ...rows[0], x: 7, y: 3, open: false };
    revision += 1;
    assert.equal(refresh().tiles[0].spriteName, 'synthetic_toggle_closed');
    assert.deepEqual(visuals, before);
});

// Catches detached native IDs, duplicate source identity and partial publication on invalid native state.
test('door render projection refuses missing or invalid native state without guessing a closed sprite', async () => {
    const { createDoorRenderProjection } = await import('../src/tile-renderer.js');

    const visual = { id: 'door:0:0:0:1', x: 0, y: 0, z: 0, order: 1, sourceX: 0, sourceY: 0, sourceSpriteName: 'synthetic_closed', closedSpriteName: 'synthetic_closed', openSpriteName: 'synthetic_open', toggledClosedSpriteName: 'synthetic_closed', toggledOpenSpriteName: 'synthetic_open' };
    const row = { id: visual.id, x: 0, y: 0, z: 0, open: false, toggled: false };
    let rows = [row];
    let revision = 1;
    const refresh = createDoorRenderProjection({
        visuals: [visual],
        /**
         * Read the revision shared by valid and invalid fixture states.
         *
         * @returns {number} Current native revision.
         */
        revision: () => revision,
        /**
         * Return fixture rows, including deliberately invalid toggle history.
         *
         * @returns {Array<{id:string,x:number,y:number,z:number,open:boolean,toggled:boolean|undefined}>} Current test state.
         */
        read: () => rows,
    });
    const initial = refresh();

    rows = [];
    revision += 1;
    assert.throws(refresh, /missing.*door/i);
    rows = [{ ...row, toggled: undefined }];
    assert.throws(refresh, /toggled/i);
    rows = [{ ...row, x: Number.NaN }];
    assert.throws(refresh, /coordinate/i);
    rows = [row];
    assert.deepEqual(refresh().tiles, initial.tiles);
    assert.throws(() => createDoorRenderProjection({
        visuals: [visual, { ...visual, id: 'different' }],
        /**
         * Supply a stable revision for duplicate source rejection.
         *
         * @returns {number} Fixed native revision.
         */
        revision: () => 1,
        /**
         * Supply the native row for the original fixture identity.
         *
         * @returns {Array<{id:string,x:number,y:number,z:number,open:boolean,toggled:boolean}>} Single original door row.
         */
        read: () => [row],
    }), /duplicate.*source/i);
});

/**
 * Capture only browser/GPU boundaries while exercising the real tile window, admission and upload paths.
 *
 * @param {object} t - Test-owned globals.
 * @returns {object} Recorded resource ownership and real layer options.
 */
function tileGpuBoundary(t) {
    const stats = { textures: [], writes: [], buffers: [], pipelines: [], groups: [], samplers: [], shader: '', closed: 0, copies: 0 };

    for (const [name, value] of Object.entries({
        GPUBufferUsage: { UNIFORM: 1, COPY_DST: 2, VERTEX: 4 },
        GPUTextureUsage: { COPY_DST: 1, TEXTURE_BINDING: 2, RENDER_ATTACHMENT: 4 },
        /**
         * Decode only the external bitmap boundary; original upload geometry remains real.
         *
         * @returns {Promise<object>} Synthetic bitmap with source-page dimensions.
         */
        createImageBitmap: () => Promise.resolve({
            width: 16, height: 16,
            /** Count release of the decoded boundary bitmap. */
            close() {
                stats.closed += 1;
            },
        }),
    })) {
        const before = Object.getOwnPropertyDescriptor(globalThis, name);

        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
        t.after(() => before ? Object.defineProperty(globalThis, name, before) : Reflect.deleteProperty(globalThis, name));
    }

    const device = {
        limits: { maxTextureDimension2D: 8_192, maxBufferSize: 1_048_576 },
        /**
         * Capture the submitted WGSL, not the source module text.
         *
         * @param {object} descriptor - Submitted shader descriptor.
         * @returns {object} Opaque GPU module handle.
         */
        createShaderModule(descriptor) {
            stats.shader = descriptor.code;

            return {};
        },
        /**
         * Capture the actual source mask sampling policy.
         *
         * @param {object} descriptor - Sampler settings.
         * @returns {object} Opaque sampler handle.
         */
        createSampler(descriptor) {
            stats.samplers.push(descriptor);

            return descriptor;
        },
        /**
         * Capture the real vertex layout, shader entry and depth policy.
         *
         * @param {object} descriptor - Submitted pipeline.
         * @returns {object} Opaque pipeline with auto-layout lookup.
         */
        createRenderPipeline(descriptor) {
            const pipeline = {
                descriptor,
                /**
                 * Keep bind-group owners distinct between automatically generated layouts.
                 *
                 * @param {number} index - Requested group.
                 * @returns {object} Layout identity.
                 */
                getBindGroupLayout(index) {
                    return { pipeline, index };
                },
            };

            stats.pipelines.push(pipeline);

            return pipeline;
        },
        /**
         * Retain the uploaded instance or uniform data at the GPU boundary.
         *
         * @param {object} descriptor - Buffer allocation.
         * @returns {object} Owned buffer handle.
         */
        createBuffer(descriptor) {
            const buffer = {
                descriptor, destroyed: false,
                /** Observe the resource owner's release. */
                destroy() {
                    this.destroyed = true;
                },
            };

            stats.buffers.push(buffer);

            return buffer;
        },
        /**
         * Capture texture format, dimensions and ownership without simulating GPU execution.
         *
         * @param {object} descriptor - Texture allocation.
         * @returns {object} Owned texture handle.
         */
        createTexture(descriptor) {
            const texture = {
                descriptor, destroyed: false,
                /** Observe the resource owner's release. */
                destroy() {
                    this.destroyed = true;
                },
                /**
                 * Preserve the texture owner through its view.
                 *
                 * @returns {object} Opaque view.
                 */
                createView() {
                    return { texture: this };
                },
            };

            stats.textures.push(texture);

            return texture;
        },
        /**
         * Preserve texture and layout bindings for draw-order assertions.
         *
         * @param {object} descriptor - Submitted bind group.
         * @returns {object} Opaque bind group.
         */
        createBindGroup(descriptor) {
            stats.groups.push(descriptor);

            return descriptor;
        },
        queue: {
            /**
             * Snapshot actual uploaded instance or uniform values.
             *
             * @param {object} buffer - Receiving buffer.
             * @param {number} offset - Byte offset.
             * @param {Float32Array} data - Uploaded values.
             */
            writeBuffer(buffer, offset, data) {
                buffer.data = data.slice();
            },
            /**
             * Snapshot exact source depth/mask bytes at the GPU boundary.
             *
             * @param {object} target - Receiving texture.
             * @param {Uint8Array} data - Native processed bytes.
             * @param {object} layout - Source byte layout.
             * @param {number[]} size - Texture extent.
             */
            writeTexture(target, data, layout, size) {
                stats.writes.push({ target, data: data.slice(), layout, size });
            },
            /** Count diffuse-only browser bitmap conversion. */
            copyExternalImageToTexture() {
                stats.copies += 1;
            },
            /**
             * Settle the external GPU queue boundary.
             *
             * @returns {Promise<void>} Completed external submission.
             */
            onSubmittedWorkDone() {
                return Promise.resolve();
            },
        },
    };
    const sprites = new Map(['first', 'second', 'excluded'].map((name, entryIndex) => [name, {
        name, pageIndex: 0, entryIndex, x: entryIndex * 2, y: 0, w: 2, h: 2, xoff: 64, yoff: 192, totalW: 128, totalH: 256,
    }]));
    const placements = [{ x: 0, y: 0, z: 0, order: 0, spriteName: 'first' }];
    const pack = {
        source: { name: 'synthetic' }, pages: [{ width: 16, height: 16 }],
        /**
         * Resolve only synthetic original pack descriptors.
         *
         * @param {string} name - Exact sprite name.
         * @returns {object|undefined} Authored crop.
         */
        lookup(name) {
            return sprites.get(name);
        },
        /**
         * Supply an opaque external decode input.
         *
         * @returns {Promise<Blob>} Synthetic page input.
         */
        pageBlob() {
            return Promise.resolve(new Blob());
        },
    };
    const cell = {
        cellX: 0, cellY: 0, chunksPerAxis: 1, minLevel: 0, maxLevel: 0,
        chunks: [{ present: true }], tileNames: [...sprites.keys()],
        /**
         * Keep chunk caching and mutable native placement ownership real.
         *
         * @returns {Promise<object[]>} Current fixture placements.
         */
        readChunk() {
            return Promise.resolve(placements);
        },
    };
    const calls = [];
    const tileDepth = {
        /**
         * Supply original-equivalent descriptors at the asset factory boundary.
         *
         * @param {string} name - Exact art name.
         * @param {object} context - Actual placement passed by the layer.
         * @returns {Promise<object>} Native byte descriptor or explicit ordinary draw policy.
         */
        resolve(name, context) {
            calls.push({ name, context });

            return Promise.resolve(name === 'excluded'
                ? { kind: 'untextured', depthTest: 'less-equal', depthWrite: true, reason: 'source exclusion' }
                : { kind: 'texture', key: name, width: 3, height: 3, offsetX: 64, offsetY: 192, pixels: new Uint8Array([0, 1, 2, 127, 128, 129, 253, 254, 255]), source: { path: 'synthetic.png', index: 0 } });
        },
    };
    const draws = [];
    let activePipeline;
    let activeGroup;
    const pass = {
        /**
         * Preserve the selected material policy for each submitted draw.
         *
         * @param {object} value - Pipeline handle.
         */
        setPipeline(value) {
            activePipeline = value;
        },
        /**
         * Preserve the selected material owner for draw ordering.
         *
         * @param {number} index - Bind-group slot.
         * @param {object} value - Group handle.
         */
        setBindGroup(index, value) {
            if (index === 1) {
                activeGroup = value;
            }
        },
        /** Accept the real instance-buffer binding. */
        setVertexBuffer() {
            // Binding is accepted at the external GPU boundary.
        },
        /**
         * Capture the real draw command and currently bound resources.
         *
         * @param {number} vertexCount - Vertex count.
         * @param {number} count - Instance count.
         * @param {number} first - First vertex.
         * @param {number} instance - First instance.
         */
        draw(vertexCount, count, first, instance) {
            draws.push({ pipeline: activePipeline, group: activeGroup, vertexCount, count, first, instance });
        },
    };

    return { stats, calls, draws, pass, placements, tileDepth, options: { device, format: 'rgba8unorm', sampler: {}, packs: [pack], cells: [cell], tileDepth } };
}

// Catches RGBA/premultiplied depth imports, UV ownership mistakes, omitted depth span and leaked paired allocations.
test('real tile loading uploads exact single-channel bytes and binds per-fragment native depth', async (t) => {
    const { stats, calls, draws, pass, options } = tileGpuBoundary(t);
    const layer = createTileLayer({ ...options, textureBudget: 25 });

    t.after(() => layer.destroy());
    await layer.update({ x: 0, y: 0, width: 128, height: 128, tilePixels: 128 });
    assert.equal(layer.diagnostics().textureBytes, 25);
    assert.equal(calls[0].context.spriteName, 'first');
    assert.deepEqual(stats.textures.map(({ descriptor }) => descriptor.format), ['rgba8unorm', 'r8unorm']);
    assert.deepEqual([...stats.writes[0].data], [0, 1, 2, 127, 128, 129, 253, 254, 255]);
    assert.equal(stats.writes[0].layout.bytesPerRow, 3);
    assert.deepEqual(stats.writes[0].size, [3, 3]);
    assert.equal(stats.copies, 1, 'only diffuse pixels pass through browser bitmap conversion');
    assert.equal(stats.closed, 1);
    const instance = stats.buffers.find(({ descriptor }) => descriptor.label.startsWith('tile instances')).data;

    assert.deepEqual([...instance.subarray(12, 20)], [0, 0, 1, 0, 1, 1, 0, 1]);
    assert.deepEqual([...instance.subarray(20, 28)], [0, 0, Math.fround(2 / 3), 0, Math.fround(2 / 3), Math.fround(2 / 3), 0, Math.fround(2 / 3)]);
    const projection = new Float32Array([1, 0, -0.001_443_354_2, 0, 0, 1, -0.001_443_354_2, 0, 0, 0, -0.002_886_708_4, 0, 0, 0, 0.5, 1]);

    layer.render(pass, { projection, camera: { x: 0, y: 0 }, tilePixels: 128, width: 128, height: 128 });
    const uniform = stats.buffers.find(({ descriptor }) => descriptor.label === 'tile projection').data;

    assert.equal(uniform[19], Math.fround(0.005_773_416_8));
    assert.equal(draws.length, 1);
    assert.equal(draws[0].pipeline.descriptor.depthStencil.depthCompare, 'less-equal');
    assert.equal(draws[0].pipeline.descriptor.depthStencil.depthWriteEnabled, true);
    assert.match(stats.shader, /textureLoad\(tileDepth/);
    assert.match(stats.shader, /if \(d == 0\.0\) { discard; }/);
    assert.match(stats.shader, /out\.depth = b \+ view\.depthSpan \* d/);
    layer.destroy();
    assert.equal(stats.textures.every(({ destroyed }) => destroyed), true);
    assert.equal(layer.diagnostics().textureBytes, 0);
});

test('depth budget defers paired sprites, releases excluded depth, and uses source ordinary draw policy', async (t) => {
    const { stats, draws, pass, placements, options } = tileGpuBoundary(t);

    placements.push({ ...placements[0], order: 1, spriteName: 'second' });
    const layer = createTileLayer({ ...options, textureBudget: 49 });

    t.after(() => layer.destroy());
    await layer.update({ x: 0, y: 0, width: 128, height: 128, tilePixels: 128 });
    assert.equal(layer.diagnostics().residentSprites, 1);
    assert.equal(layer.diagnostics().deferredSprites.length, 1);
    const oldTextures = [...stats.textures];

    placements.splice(0, placements.length, { x: 0, y: 0, z: 0, order: 0, spriteName: 'excluded' });
    await layer.update({ x: 0.01, y: 0, width: 128, height: 128, tilePixels: 128 });
    // Cached source chunk still contains the mutable fixture placements, as real doors replace their snapshot.
    layer.render(pass, { projection: new Float32Array(16), camera: { x: 0.01, y: 0 }, tilePixels: 128, width: 128, height: 128 });
    assert.equal(draws.at(-1).pipeline.descriptor.fragment.entryPoint, 'fragmentUntextured');
    assert.equal(draws.at(-1).pipeline.descriptor.depthStencil.depthWriteEnabled, true);
    assert.equal(stats.textures.filter(({ descriptor }) => descriptor.format === 'r8unorm').length, 1, 'exclusion never fabricates a constant depth map');
    placements[0] = { ...placements[0], spriteName: 'second' };
    await layer.update({ x: 0.02, y: 0, width: 128, height: 128, tilePixels: 128 });
    assert.equal(oldTextures.every(({ destroyed }) => destroyed), true, 'eviction releases the diffuse/depth pair before admitting another pair');
    assert.ok(layer.diagnostics().textureBytes <= 49);
    layer.destroy();
    assert.equal(oldTextures.every(({ destroyed }) => destroyed), true);
});

// Catches uploading or retaining either texture after a source decode outlives its owner.
test('destroying during bitmap decode closes late data without allocating diffuse or depth textures', async (t) => {
    const { stats, options } = tileGpuBoundary(t);
    let finish;
    let entered;
    const gate = new Promise((resolve) => {
        finish = resolve;
    });
    const started = new Promise((resolve) => {
        entered = resolve;
    });

    /**
     * Hold the external decoder until the real layer loses ownership.
     *
     * @returns {Promise<object>} Delayed bitmap.
     */
    globalThis.createImageBitmap = () => {
        entered();

        return gate;
    };

    const layer = createTileLayer(options);
    const loading = layer.update({ x: 0, y: 0, width: 128, height: 128, tilePixels: 128 });

    await started;
    layer.destroy();
    finish({
        width: 16, height: 16,
        /** Observe closure of the late decoded bitmap. */
        close() {
            stats.closed += 1;
        },
    });
    await loading;
    assert.equal(stats.textures.length, 0);
    assert.equal(stats.closed, 1);
    assert.equal(layer.diagnostics().textureBytes, 0);
});

// Catches flattening an additional native seam into its base draw, losing the slanted corners or omitting mask residency.
test('additional seam draw keeps all four native corners and owns its exact alpha-only mask bytes', async (t) => {
    const { stats, draws, pass, options, tileDepth } = tileGpuBoundary(t);
    const resolve = tileDepth.resolve;

    /**
     * Model the asset boundary's additional native seam descriptor.
     *
     * @param {string} name - Original sprite.
     * @param {object} context - Native placement.
     * @returns {Promise<object>} Base and additional source draw.
     */
    tileDepth.resolve = async (name, context) => {
        const base = await resolve(name, context);

        return {
            ...base,
            additionalDraws: [{
                ...base, key: 'seam-depth', screenOffset: { x: 6, y: -3 },
                seam: {
                    name: 'synthetic-slanted',
                    vertices: [64, 192, 66, 192, 65, 194, 63, 194],
                    mask: { key: 'synthetic-mask', width: 3, height: 3, offsetX: 64, offsetY: 192, pixels: new Uint8Array([255, 255, 0, 255, 255, 255, 0, 255, 255]) },
                },
            }],
        };
    };

    const layer = createTileLayer({ ...options, textureBudget: 200 });

    t.after(() => layer.destroy());
    await layer.update({ x: 0, y: 0, width: 128, height: 128, tilePixels: 128 });
    layer.render(pass, { projection: new Float32Array(16), camera: { x: 0, y: 0 }, tilePixels: 128, width: 128, height: 128 });
    assert.equal(draws.length, 2);
    assert.equal(draws[0].pipeline.descriptor.fragment.entryPoint, 'fragmentSeam', 'native per-object seam draw precedes its base');
    assert.equal(draws[1].pipeline.descriptor.fragment.entryPoint, 'fragmentMain');
    assert.equal(layer.diagnostics().textureBytes, 123, 'native seam diffuse halo is charged along with depth and mask');
    assert.deepEqual([...stats.writes.at(-1).data], [255, 255, 0, 255, 255, 255, 0, 255, 255]);
    const vertices = stats.buffers.find(({ descriptor }) => descriptor.label.startsWith('tile instances') && descriptor.label.includes(':seam-depth:')).data;

    assert.deepEqual([...vertices.subarray(4, 12)], [6 / 128, -3 / 128, 8 / 128, -3 / 128, 7 / 128, -1 / 128, 5 / 128, -1 / 128]);
    assert.deepEqual([...vertices.subarray(12, 20)], [Math.fround(2 / 5), 1 / 4, Math.fround(4 / 5), 1 / 4, Math.fround(3 / 5), 3 / 4, Math.fround(1 / 5), 3 / 4]);
    assert.equal(stats.copies, 5, 'seam diffuse halo crossing both atlas axes copies actual wrapped source strips, not clamped edge colours');
    assert.match(stats.shader, /if \(d \* mask == 0\.0\) { discard; }/);
    assert.equal(stats.samplers[0].minFilter, 'linear', 'native mask alpha interpolation is not nearest depth sampling');
    layer.destroy();
    assert.equal(stats.textures.every(({ destroyed }) => destroyed), true);
});

test('source-suppressed placements never allocate art, while constructor substitution chooses effective diffuse art', async (t) => {
    const { options, stats, pass, draws, placements, tileDepth } = tileGpuBoundary(t);
    const resolve = tileDepth.resolve;

    placements[0].spriteName = 'absent-source';
    /**
     * Model a positively suppressed source constructor result.
     *
     * @returns {Promise<object>} Suppressed draw policy.
     */
    tileDepth.resolve = () => Promise.resolve({ kind: 'suppressed' });
    const layer = createTileLayer(options);

    t.after(() => layer.destroy());
    await layer.update({ x: 0, y: 0, width: 128, height: 128, tilePixels: 128 });
    assert.equal(stats.textures.length, 0);
    assert.equal(layer.diagnostics().missingSpriteCount, 0);
    /**
     * Model the native constructor's effective-art substitution.
     *
     * @param {string} name - Original source identity.
     * @param {object} context - Native placement.
     * @returns {Promise<object>} Effective diffuse art with real source depth bytes.
     */
    tileDepth.resolve = async (name, context) => ({ ...await resolve(name, context), spriteName: 'second' });
    await layer.update({ x: 0.01, y: 0, width: 128, height: 128, tilePixels: 128 });
    layer.render(pass, { projection: new Float32Array(16), camera: { x: 0.01, y: 0 }, tilePixels: 128, width: 128, height: 128 });
    assert.match(draws[0].group.entries[0].resource.texture.descriptor.label, /original sprite 0:0:1:/u);
    assert.equal(layer.diagnostics().missingSpriteCount, 0);
});

test('painter stack order survives material batches without displacing per-pixel square depth', async (t) => {
    const { options, stats, pass, draws, placements } = tileGpuBoundary(t);

    placements[0].order = 1_000_000;
    placements.push({ ...placements[0], order: 0, spriteName: 'second' });
    const layer = createTileLayer(options);

    t.after(() => layer.destroy());
    await layer.update({ x: 0, y: 0, width: 128, height: 128, tilePixels: 128 });
    layer.render(pass, { projection: new Float32Array(16), camera: { x: 0, y: 0 }, tilePixels: 128, width: 128, height: 128 });
    assert.match(draws[0].group.entries[0].resource.texture.descriptor.label, /original sprite 0:0:1:/u);
    assert.match(draws[1].group.entries[0].resource.texture.descriptor.label, /original sprite 0:0:0:/u);

    for (const buffer of stats.buffers.filter(({ descriptor }) => descriptor.label.startsWith('tile instances'))) {
        assert.equal(Math.abs(buffer.data[3]), 0, 'stack order is not a GPU depth offset');
    }
});

test('a failed depth upload releases both allocations without charging or drawing a partial sprite', async (t) => {
    const { options, stats } = tileGpuBoundary(t);

    /** Fail the external upload after the layer allocates its two real owners. */
    options.device.queue.writeTexture = () => {
        throw new Error('GPU depth upload failure');
    };

    const layer = createTileLayer(options);

    t.after(() => layer.destroy());
    await layer.update({ x: 0, y: 0, width: 128, height: 128, tilePixels: 128 });
    assert.equal(stats.textures.length, 2);
    assert.equal(stats.textures.every(({ destroyed }) => destroyed), true);
    assert.equal(layer.diagnostics().textureBytes, 0);
    assert.equal(layer.diagnostics().residentSprites, 0);
    assert.match(layer.diagnostics().errors[0].message, /GPU depth upload failure/u);
    assert.equal(stats.closed, 1);
});

test('a padded linear seam mask clips wall geometry to its native rectangle, not its halo', () => {
    const sprite = { ...SPRITE, xoff: 0, yoff: 0, w: 128, h: 256 };
    const depth = {
        kind: 'texture', width: 128, height: 256, offsetX: 0, offsetY: 0,
        seam: {
            vertices: null,
            mask: { width: 132, height: 260, offsetX: -2, offsetY: -2, clip: { offsetX: 0, offsetY: 32, width: 128, height: 128 } },
        },
    };
    const quad = tileDepthQuad(sprite, depth);

    assert.equal(quad.left, -0.5);
    assert.equal(quad.top, -1.25);
    assert.equal(quad.width, 1);
    assert.equal(quad.height, 1);
    assert.equal(quad.v0, 0.125);
    assert.equal(quad.v1, 0.625);
    assert.throws(() => tileDepthQuad(sprite, { ...depth, screenOffset: { x: Number.NaN, y: 0 } }), /screen offset/iu);
});

test('source non-textured translucent policy retains ordinary depth testing without writing depth', async (t) => {
    const { options, pass, draws, tileDepth } = tileGpuBoundary(t);

    /**
     * Supply the source non-tree translucent branch, not an invented disabled depth test.
     *
     * @returns {Promise<object>} Native read-only ordinary depth policy.
     */
    tileDepth.resolve = () => Promise.resolve({ kind: 'untextured', depthTest: 'less-equal', depthWrite: false, reason: 'native translucent non-tree' });
    const layer = createTileLayer(options);

    t.after(() => layer.destroy());
    await layer.update({ x: 0, y: 0, width: 128, height: 128, tilePixels: 128 });
    layer.render(pass, { projection: new Float32Array(16), camera: { x: 0, y: 0 }, tilePixels: 128, width: 128, height: 128 });
    assert.equal(draws[0].pipeline.descriptor.depthStencil.depthWriteEnabled, false);
    assert.equal(draws[0].pipeline.descriptor.depthStencil.depthCompare, 'less-equal');
});

test('a moving door attachment uses its actual owner position for culling, ordering and GPU world depth', async (t) => {
    const { options, stats, placements, tileDepth, pass, draws } = tileGpuBoundary(t);
    const resolve = tileDepth.resolve;

    placements.push({ ...placements[0], spriteName: 'second', x: 2, order: 1 });
    /**
     * Preserve source identity while publishing the actual native moving owner coordinates.
     *
     * @param {string} name - Source attachment art.
     * @param {object} context - Original placement identity.
     * @returns {Promise<object>} Descriptor with the actual native draw position.
     */
    tileDepth.resolve = async (name, context) => ({
        ...await resolve(name, context),
        ...(name === 'first' ? { renderPosition: { x: 3, y: 0, z: 0 } } : {}),
    });
    const layer = createTileLayer(options);

    t.after(() => layer.destroy());
    await layer.update({ x: 3, y: 0, width: 640, height: 128, tilePixels: 128 });
    layer.render(pass, { projection: new Float32Array(16), camera: { x: 3, y: 0 }, tilePixels: 128, width: 640, height: 128 });
    assert.equal(draws.length, 2, 'the moved attachment is visible even though its old source anchor is outside the vertical viewport');
    assert.match(draws[0].group.entries[0].resource.texture.descriptor.label, /original sprite 0:0:1:/u);
    assert.match(draws[1].group.entries[0].resource.texture.descriptor.label, /original sprite 0:0:0:/u);
    const attachment = stats.buffers.find(({ descriptor }) => descriptor.label.startsWith('tile instances 0:0:0:')).data;

    assert.deepEqual([...attachment.subarray(0, 3)], [3, 0, 0], 'shared projection must receive the effective owner world position, not a depth-only correction');
    assert.equal(placements[0].x, 0, 'source placement identity remains available for the next native revision');
});

test('the native tree exclusion offsets only its ordinary depth origin by .99 on both world axes', async (t) => {
    const { options, stats, tileDepth, pass, draws, placements } = tileGpuBoundary(t);

    placements[0].spriteName = 'excluded';
    /**
     * Model setupTileDepth=false for IsoTree and its original prepareToRenderSprite depth position.
     *
     * @returns {Promise<object>} Native untextured tree policy.
     */
    tileDepth.resolve = () => Promise.resolve({
        kind: 'untextured', depthTest: 'less-equal', depthWrite: true, reason: 'native IsoTree exclusion',
        depthPositionOffset: { x: 0.99, y: 0.99 },
    });
    const layer = createTileLayer(options);

    t.after(() => layer.destroy());
    await layer.update({ x: 0, y: 0, width: 128, height: 128, tilePixels: 128 });
    const projection = new Float32Array([1, 0, -0.001_443_354_2, 0, 0, 1, -0.001_443_354_2, 0, 0, 0, -0.002_886_708_4, 0, 0, 0, 0.5, 1]);

    layer.render(pass, { projection, camera: { x: 0, y: 0 }, tilePixels: 128, width: 128, height: 128 });
    const instance = stats.buffers.find(({ descriptor }) => descriptor.label.startsWith('tile instances')).data;

    assert.equal(draws[0].pipeline.descriptor.fragment.entryPoint, 'fragmentUntextured');
    assert.deepEqual([...instance.subarray(0, 3)], [0, 0, 0], 'source tree screen anchor must not move .99 tiles');
    assert.deepEqual([...instance.subarray(4, 12)], [0, 0, 1 / 64, 0, 1 / 64, 1 / 64, 0, 1 / 64]);
    assert.equal(instance[3], Math.fround(-0.002_857_841_316), 'ordinary depth uses D(x+.99,y+.99,z), not D(x,y,z)');
    assert.ok(Math.abs(0.5 + instance[3] - 0.497_142_158_684) < 1e-8);
    assert.equal(stats.textures.length, 1, 'source exclusion does not fabricate a depth map');
});
