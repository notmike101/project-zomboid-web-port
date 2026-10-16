import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseItemDefinitions } from '../src/item-definitions.js';
import { WORLD_DEPTH_XY, WORLD_DEPTH_Z, worldDepth } from '../src/renderer.js';
import { createWorldItemAssets } from '../src/world-item-assets.js';
import { worldItemTransform, worldItemVisible, selectWorldItems, worldItemTint, createWorldItemLayer } from '../src/world-item-renderer.js';

const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const item = { id: 7, x: 10, y: 20, z: 0, xoff: 0.2, yoff: 0.3, zoff: 0.1, worldXRotation: 0, worldYRotation: 0, worldZRotation: 0, worldScale: 2 };
const representation = { kind: 'model', transform: identity, bounds: { min: [0, 0.48, 0], max: [1, 1.48, 1] } };
/**
 * Project a world point using the real uploaded or caller-supplied camera matrix.
 *
 * @param {Float32Array} values - Projection matrix at the beginning of the array.
 * @param {number[]} point - Homogeneous world point.
 * @returns {number[]} Clip-space XYZ coordinates.
 */
const project = (values, point) => [0, 1, 2].map((row) => point.reduce((sum, component, col) => sum + values[col * 4 + row] * component, 0));

// Core.DoPushIsoStuff + WorldModelCamera use native placement, not arbitrary actor-sized models.
test('source model coordinates retain native offsets, axis conversion, scale and rotation', () => {
    const matrix = worldItemTransform(item, representation);
    /**
     * Transform a source point with the actual native world-item matrix.
     *
     * @param {number} x - Source x coordinate.
     * @param {number} y - Source y coordinate.
     * @param {number} z - Source z coordinate.
     * @returns {number[]} Transformed world coordinates.
     */
    const point = (x, y, z) => [0, 1, 2].map((row) => matrix[row] * x + matrix[4 + row] * y + matrix[8 + row] * z + matrix[12 + row]);
    const actual = point(1, 0.24, 1);
    const expected = [13.2, 17.3, 0.101_75];

    for (const [i, value] of actual.entries()) {
        assert.ok(Math.abs(value - expected[i]) < 0.000_01, `${actual} != ${expected}`);
    }

    const rotated = worldItemTransform({ ...item, worldZRotation: 90 }, representation);

    assert.ok(Math.abs(rotated[0]) < 0.000_01);
    assert.ok(Math.abs(rotated[1] - 3) < 0.000_01);
    assert.throws(() => worldItemTransform({ ...item, xoff: undefined }, representation), /native world-item/iu);
    assert.equal(worldItemTransform({ ...item, worldScale: -1 }, representation)[0], -1.5);
    assert.equal(worldItemTransform({ ...item, worldScale: 0 }, representation)[0], 0);
    assert.doesNotThrow(() => worldItemTransform({ ...item, worldScale: 0 }, { kind: 'sprite' }));
    assert.equal(worldItemTransform(item, { ...representation, source: { selection: 'head-clothing' } })[0], 1.5);
});

// A native ownership change must erase stale drawing even while source decoding is pending.
test('native current-level item selection rejects duplicate ownership and does not retain removed ids', () => {
    const otherLevel = { ...item, id: 8, z: 1 };

    assert.deepEqual(selectWorldItems([item, otherLevel], 0), [item]);
    assert.deepEqual(selectWorldItems([], 0), []);
    assert.throws(() => selectWorldItems([item, item], 0), /duplicate/iu);
});

// Exact transformed source bounds use the live camera, clipping, and current z.
test('world-item clipping projects genuine model bounds and source sprite trim', () => {
    const view = { camera: { x: 10, y: 20 }, tilePixels: 64, width: 640, height: 640, characterZ: 0 };

    assert.equal(worldItemVisible(item, representation, view), true);
    assert.equal(worldItemVisible({ ...item, x: 1_000 }, representation, view), false);
    const sprite = { kind: 'sprite', quad: { left: -8, top: -12, width: 16, height: 16 } };

    assert.equal(worldItemVisible(item, sprite, view), true);
    assert.equal(worldItemVisible({ ...item, z: 1 }, sprite, view), false);
});

test('model clipping uses the source camera normalization at both viewport edges without moving sprites', () => {
    const view = { camera: { x: 0, y: 0 }, tilePixels: 128, width: 640, height: 100, characterZ: 0 };
    const model = { ...representation, bounds: { min: [0, 0, 0], max: [0.01, 0.01, 0.01] } };
    const edgeItem = { ...item, x: 0.1, y: 0.1, xoff: 0, yoff: 0, zoff: 0, worldScale: 1 };
    const sprite = { kind: 'sprite', quad: { left: 0, top: 0, width: 1, height: 1 } };

    assert.equal(worldItemVisible(edgeItem, model, view), true, 'the normalized model is inside despite its raw camera anchor falling below the viewport');
    assert.equal(worldItemVisible({ ...edgeItem, x: -1.4, y: -1.4 }, model, view), false, 'the normalized model is above the viewport despite its raw camera anchor being inside');
    assert.equal(worldItemVisible(edgeItem, sprite, view), true);
    assert.equal(worldItemVisible({ ...edgeItem, x: 0.9, y: 0.9 }, sprite, view), false, 'sprites must not receive the model-only upward shift');
});

// Model highlight replaces source tint; the sprite path retains its original TintMod.
test('original highlighted material tint changes only the requested live representation', () => {
    const color = { r: 0.98, g: 0.56, b: 0.11, a: 1 };
    const model = { kind: 'model', tint: [0.5, 0.25, 0.75, 0.8] };
    const sprite = { ...model, kind: 'sprite' };

    assert.deepEqual(worldItemTint(model), model.tint);
    assert.deepEqual(worldItemTint(model, { enabled: true, color }), [0.98, 0.56, 0.11, 1]);
    assert.deepEqual(worldItemTint(sprite, { enabled: true, color }), [0.49, 0.14, 0.082_5, 0.8]);
    assert.deepEqual(worldItemTint(model, { enabled: false, color }), model.tint);
});

/**
 * Expose GPU allocation and upload boundaries while running the real item layer.
 *
 * @param {object} t - Test context owning restoration of browser globals.
 * @param {number} [width] - Decoded bitmap width.
 * @param {number} [height] - Decoded bitmap height.
 * @returns {object} GPU device double and observed allocations/uploads.
 */
function gpuBoundary(t, width = 4_096, height = 4_095) {
    const globals = ['GPUBufferUsage', 'GPUTextureUsage', 'GPUShaderStage', 'createImageBitmap'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);

    t.after(() => {
        for (const [name, descriptor] of globals) {
            if (descriptor) {
                Object.defineProperty(globalThis, name, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, name);
            }
        }
    });
    const stats = { bitmapsClosed: 0, destroyed: 0, textures: 0, uniforms: new Map(), pipelines: [] };

    globalThis.GPUBufferUsage = { COPY_DST: 1, VERTEX: 2, INDEX: 4, UNIFORM: 8 };
    globalThis.GPUTextureUsage = { COPY_DST: 1, TEXTURE_BINDING: 2, RENDER_ATTACHMENT: 4 };
    globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
    /**
     * Resolve a near-budget decoded bitmap and count its eventual release.
     *
     * @returns {Promise<object>} Decoded bitmap boundary double.
     */
    globalThis.createImageBitmap = () => Promise.resolve({
        width,
        height,
        /**
         * Count bitmap closure after the layer attempts GPU admission.
         */
        close() {
            stats.bitmapsClosed += 1;
        },
    });
    /**
     * Create a GPU allocation boundary double that tracks resource release.
     *
     * @param {object} descriptor - GPU allocation descriptor.
     * @returns {object} Allocation exposing destruction and texture-view creation.
     */
    const allocation = (descriptor) => ({
        label: descriptor.label,
        /**
         * Count release of this GPU allocation.
         */
        destroy() {
            stats.destroyed += 1;
        },
        /**
         * Supply the opaque texture-view handle consumed by bind-group creation.
         *
         * @returns {object} Texture-view boundary double.
         */
        createView() {
            return {};
        },
    });
    const device = {
        limits: { maxTextureDimension2D: 8_192 },
        queue: {
            /**
             * Capture actual native item uniform uploads before their values can change.
             *
             * @param {object} target - GPU buffer receiving the upload.
             * @param {number} offset - Destination byte offset.
             * @param {Float32Array|Uint32Array} data - Uploaded buffer values.
             */
            writeBuffer(target, offset, data) {
                if (target.label.startsWith('native world item ') && offset === 0) {
                    stats.uniforms.set(target.label, data.slice());
                }
            },
            /**
             * Accept decoded bitmap copies at the GPU boundary.
             *
             * @returns {undefined} No GPU execution result.
             */
            copyExternalImageToTexture() {
                return undefined;
            },
        },
        /**
         * Supply the opaque shader handle used for pipeline creation.
         *
         * @returns {object} Shader-module boundary double.
         */
        createShaderModule() {
            return {};
        },
        /**
         * Supply the opaque layout handle used for bind groups.
         *
         * @returns {object} Bind-group-layout boundary double.
         */
        createBindGroupLayout() {
            return {};
        },
        /**
         * Supply the opaque layout handle used for pipelines.
         *
         * @returns {object} Pipeline-layout boundary double.
         */
        createPipelineLayout() {
            return {};
        },
        /**
         * Supply a render pipeline exposing the layer's required layout lookup.
         *
         * @param {object} descriptor - Actual material pipeline configuration.
         * @returns {object} Render-pipeline boundary double.
         */
        createRenderPipeline(descriptor) {
            stats.pipelines.push(descriptor);

            return {
                /**
                 * Supply the opaque layout for the requested pipeline group.
                 *
                 * @returns {object} Bind-group-layout boundary double.
                 */
                getBindGroupLayout() {
                    return {};
                },
            };
        },
        /**
         * Supply the opaque bind-group handle retained by each resident item.
         *
         * @returns {object} Bind-group boundary double.
         */
        createBindGroup() {
            return {};
        },
        createBuffer: allocation,
        /**
         * Count actual texture allocations made by the real renderer.
         *
         * @param {object} descriptor - GPU texture allocation descriptor.
         * @returns {object} Texture boundary double.
         */
        createTexture(descriptor) {
            stats.textures += 1;

            return allocation(descriptor);
        },
    };

    const submitted = [];
    const pass = {
        /**
         * Accept the source material pipeline without executing a GPU draw.
         *
         * @returns {undefined} No GPU execution result.
         */
        setPipeline() {
            return undefined;
        },
        /**
         * Accept the item uniform or texture bind group.
         *
         * @returns {undefined} No GPU execution result.
         */
        setBindGroup() {
            return undefined;
        },
        /**
         * Accept the uploaded source vertex buffer.
         *
         * @returns {undefined} No GPU execution result.
         */
        setVertexBuffer() {
            return undefined;
        },
        /**
         * Accept the uploaded source index buffer.
         *
         * @returns {undefined} No GPU execution result.
         */
        setIndexBuffer() {
            return undefined;
        },
        /**
         * Record submitted index counts for the live ownership assertion.
         *
         * @param {number} count - Number of source indices submitted.
         */
        drawIndexed(count) {
            submitted.push(count);
        },
    };

    return { device, stats, pass, submitted };
}

test('native model camera shares the floor frame while retaining source target depth and foreground tests', async (t) => {
    const { device, stats, pass } = gpuBoundary(t, 16, 16);
    let sourceTransform = identity;
    const assets = {
        /**
         * Supply authored static source geometry with its native model transform.
         *
         * @returns {Promise<object>} Source model representation for the real item layer.
         */
        resolve() {
            return Promise.resolve({
                ...representation, transform: sourceTransform, key: 'authored-depth-model', texture: new Blob(),
                bounds: { min: [0, 0, 0], max: [1, 1, 0] },
                positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
                uvs: new Float32Array([0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]),
            });
        },
    };
    const layer = createWorldItemLayer({ device, format: 'rgba8unorm', sampler: {}, assets });

    t.after(() => layer.destroy());
    const projection = new Float32Array([
        0.2, -0.1, -WORLD_DEPTH_XY, 0, -0.2, -0.1, -WORLD_DEPTH_XY, 0,
        0, 0.6, -WORLD_DEPTH_Z, 0, 2, 3, 0.5 + 30 * WORLD_DEPTH_XY, 1,
    ]);
    const view = { projection, camera: { x: 10, y: 20 }, characterZ: 0, tilePixels: 128, width: 640, height: 640, worldItems: [item] };

    layer.render(pass, view);
    await layer.whenLoaded();
    layer.render(pass, view);
    const uniform = stats.uniforms.get(`native world item ${item.id}`);
    const matrix = worldItemTransform(item, representation);
    const origin = [matrix[12], matrix[13], matrix[14], 1];
    const logicalOrigin = [item.x + item.xoff, item.y + item.yoff, item.z + item.zoff, 1];
    const actual = project(uniform, origin);
    const unchangedPixels = project(projection, origin);
    const target = project(projection, logicalOrigin);

    assert.ok(Math.abs(actual[0] - unchangedPixels[0]) < 1e-7);
    assert.ok(Math.abs(actual[1] - unchangedPixels[1] - 2 * 56 / view.height) < 1e-7);
    assert.ok(Math.abs(actual[2] - target[2]) < 1e-7);
    assert.ok(Math.abs(actual[2] - worldDepth({ x: logicalOrigin[0], y: logicalOrigin[1], z: logicalOrigin[2] }, view.camera)) < 1e-7, 'model target depth is the actual tile/player common frame');
    assert.ok(unchangedPixels[2] > target[2], 'the unrebased source camera origin incorrectly sits behind its placement depth');
    const raisedVertex = origin.map((value, axis) => axis < 3 ? value + matrix[4 + axis] : value);
    const foreground = project(projection, [logicalOrigin[0] + 2, ...logicalOrigin.slice(1)]);
    const background = project(projection, [logicalOrigin[0] - 2, ...logicalOrigin.slice(1)]);

    assert.ok(project(uniform, raisedVertex)[2] < actual[2], 'genuine local vertex depth variation remains');
    assert.ok(foreground[2] < actual[2], 'foreground geometry still wins the ordinary depth test');
    assert.ok(background[2] > actual[2]);
    assert.ok(stats.pipelines.every(({ depthStencil }) => depthStencil.depthWriteEnabled && depthStencil.depthCompare === 'less-equal'));

    sourceTransform = identity.slice();
    sourceTransform.set([0.4, 0.2, -0.3], 12);
    const moved = { ...item, id: 8, z: 2, zoff: 0.35, worldXRotation: 15, worldYRotation: -10, worldZRotation: 35 };
    const movedView = { ...view, characterZ: 2, worldItems: [moved] };

    layer.render(pass, movedView);
    await layer.whenLoaded();
    layer.render(pass, movedView);
    const movedUniform = stats.uniforms.get('native world item 8');
    const movedMatrix = worldItemTransform(moved, { ...representation, transform: sourceTransform });
    const movedOrigin = [movedMatrix[12], movedMatrix[13], movedMatrix[14], 1];
    const cameraZ = -0.48 * 1.5 / Math.sqrt(6) + 0.001_75;
    const physicalOrigin = [...movedOrigin];

    physicalOrigin[2] -= cameraZ;
    const expectedMovedDepth = project(projection, physicalOrigin)[2];
    const actualMoved = project(movedUniform, movedOrigin);
    const placementDepth = project(projection, [moved.x + moved.xoff, moved.y + moved.yoff, moved.z + moved.zoff, 1])[2];

    assert.ok(Math.abs(actualMoved[2] - expectedMovedDepth) < 1e-7);
    assert.ok(Math.abs(actualMoved[2] - placementDepth) > 1e-5, 'mesh-local translation and native rotations must not be cancelled with the camera origin');
    const rawMoved = project(projection, movedOrigin);

    assert.equal(actualMoved[0], rawMoved[0]);
    assert.ok(Math.abs(actualMoved[1] - rawMoved[1] - 2 * 56 / movedView.height) < 1e-7);
    const movedVertex = movedOrigin.map((value, axis) => axis < 3 ? value + movedMatrix[4 + axis] : value);
    const rawDifference = project(projection, movedVertex)[2] - project(projection, movedOrigin)[2];
    const actualDifference = project(movedUniform, movedVertex)[2] - actualMoved[2];

    assert.ok(Math.abs(actualDifference - rawDifference) < 1e-7, 'local mesh depth variation survives target-depth anchoring');

    sourceTransform = identity;
    const groundItem = { ...item, id: 9, x: 10, y: 20, xoff: 0, yoff: 0, zoff: 0, worldScale: 1 };

    layer.render(pass, { ...view, worldItems: [groundItem] });
    await layer.whenLoaded();

    for (const dpr of [1, 1.5, 2]) {
        const width = 1_000 * dpr;
        const height = 800 * dpr;
        const tilePixels = 80 * dpr;
        const groundProjection = new Float32Array([
            tilePixels / width, -tilePixels / (2 * height), -WORLD_DEPTH_XY, 0,
            -tilePixels / width, -tilePixels / (2 * height), -WORLD_DEPTH_XY, 0,
            0, 3 * tilePixels / height, -WORLD_DEPTH_Z, 0,
            10 * tilePixels / width, 30 * tilePixels / (2 * height), 0.5 + 30 * WORLD_DEPTH_XY, 1,
        ]);
        const originalProjection = groundProjection.slice();
        const groundView = { ...view, projection: groundProjection, width, height, tilePixels, worldItems: [groundItem] };

        layer.render(pass, groundView);
        const groundUniform = stats.uniforms.get('native world item 9');
        const groundMatrix = worldItemTransform(groundItem, representation);
        const groundOrigin = [groundMatrix[12], groundMatrix[13], groundMatrix[14], 1];
        const normalized = project(groundUniform, groundOrigin);
        const raw = project(groundProjection, groundOrigin);
        const groundAnchor = project(groundProjection, [groundItem.x, groundItem.y, 0, 1]);
        const cssLift = (normalized[1] - raw[1]) * height / (2 * dpr);
        const residualPixels = (groundAnchor[1] - normalized[1]) * height / 2;
        const expectedResidual = (0.48 * 1.5 / Math.sqrt(6) * 192 - 0.001_75 * 192 - 56) * tilePixels / 128;

        assert.ok(Math.abs(cssLift - 35) < 0.000_1, 'physical tile and viewport dimensions already include DPR');
        assert.ok(Math.abs(residualPixels - expectedResidual) < 0.000_1, 'the genuine camera baseline and native placement lift leave their source residual');
        assert.deepEqual(groundProjection, originalProjection, 'model normalization must not mutate the common tile/player projection');
    }
});

// Browser-free GPU boundary double: tests real admission/ownership lifecycle, not rendered pixels.
test('capacity-deferred genuine representations re-admit only after another owner releases residency', async (t) => {
    const { device, stats, pass, submitted } = gpuBoundary(t);
    const assets = {
        /**
         * Resolve distinct source geometry keys to exercise GPU residency admission.
         *
         * @param {object} row - Native world-item record being resolved.
         * @returns {Promise<object>} Source geometry and texture for this item.
         */
        resolve(row) {
            return Promise.resolve({ ...representation, key: `${row.id}`, texture: new Blob(), positions: new Float32Array([0, 0.48, 0, 1, 0.48, 0, 0, 1.48, 0]), uvs: new Float32Array([0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) });
        },
    };
    const layer = createWorldItemLayer({ device, format: 'rgba8unorm', sampler: {}, assets });

    t.after(() => layer.destroy());
    const view = { projection: identity, camera: { x: 10, y: 20 }, characterZ: 0, tilePixels: 64, width: 640, height: 640, worldItems: [item, { ...item, id: 8 }] };

    layer.render(pass, view);
    await layer.whenLoaded();
    assert.match(layer.diagnostics().errors[0].message, /64 MiB/u);
    assert.equal(layer.diagnostics().residentRepresentations, 1);
    layer.render(pass, { ...view, worldItems: [view.worldItems[1]] });
    await layer.whenLoaded();
    layer.render(pass, { ...view, worldItems: [view.worldItems[1]] });
    assert.deepEqual(layer.diagnostics().errors, []);
    assert.deepEqual(layer.diagnostics().drawn.map(({ id }) => id), [8]);
    assert.deepEqual(submitted, [3]);
    assert.equal(stats.bitmapsClosed, 3);
    assert.ok(stats.destroyed >= 4);
    layer.render(pass, { ...view, worldItems: [] });
    assert.equal(layer.diagnostics().residentRepresentations, 0);
    assert.deepEqual(layer.diagnostics().drawn, []);
});

// A color-only visual change must not multiply the texture residency budget.
test('17 native sprite tints share a 1024-pixel GPU texture while retaining distinct uploaded colors', async (t) => {
    const { device, stats, pass, submitted } = gpuBoundary(t, 1_024, 1_024);
    const header = Buffer.alloc(33);

    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
    header.writeUInt32BE(13, 8);
    header.write('IHDR', 12);
    header.writeUInt32BE(1_024, 16);
    header.writeUInt32BE(1_024, 20);
    header[24] = 8;
    header[25] = 6;
    const texture = new Blob([header]);
    const path = 'media/textures/Item_Authored.png';
    const assets = await createWorldItemAssets({
        manifest: { files: [{ path }] },
        /**
         * Read the authored PNG header through the real manifest-bounded resolver.
         *
         * @param {string} requested - Requested content manifest path.
         * @returns {Blob} Dimension-only PNG fixture; bitmap decoding is the GPU boundary double.
         */
        getFile(requested) {
            assert.equal(requested, path);

            return texture;
        },
    });
    const definition = parseItemDefinitions('module Test { item Thing { ItemType = base:normal, Icon = Authored, } }', 'authored-items.txt')[0];
    const items = Array.from({ length: 17 }, (_, index) => ({
        ...item,
        id: index + 1,
        definition,
        visual: { tint: [index / 16, 1 - index / 16, 0.5, 1] },
    }));
    const layer = createWorldItemLayer({ device, format: 'rgba8unorm', sampler: {}, assets });

    t.after(() => layer.destroy());
    const view = { projection: identity, camera: { x: 10, y: 20 }, characterZ: 0, tilePixels: 64, width: 640, height: 640, worldItems: items };

    layer.render(pass, view);
    await layer.whenLoaded();
    layer.render(pass, view);
    const diagnostics = layer.diagnostics();

    assert.deepEqual(diagnostics.errors, []);
    assert.equal(diagnostics.residentItems, 17);
    assert.equal(diagnostics.residentRepresentations, 1);
    assert.equal(diagnostics.bytes, 4_194_408);
    assert.equal(stats.textures, 1);
    assert.deepEqual(diagnostics.drawn.map(({ id }) => id), items.map(({ id }) => id));
    assert.deepEqual(submitted, Array.from({ length: 17 }).fill(6));
    assert.equal(stats.uniforms.size, 17);

    for (const [index, row] of items.entries()) {
        const values = stats.uniforms.get(`native world item ${row.id}`);

        assert.ok(values, `missing actual uniform upload for item ${row.id}`);
        assert.deepEqual([...values.subarray(32, 36)], [index / 16, 1 - index / 16, 0.5, 1]);
        assert.deepEqual(values.subarray(0, 16), view.projection, 'sprite projection stays in the unchanged shared floor frame');
    }

    layer.render(pass, { ...view, worldItems: [items[16]] });
    assert.equal(layer.diagnostics().residentRepresentations, 1);
    assert.equal(layer.diagnostics().bytes, 4_194_408);
    layer.render(pass, { ...view, worldItems: [] });
    assert.equal(layer.diagnostics().residentRepresentations, 0);
    assert.equal(layer.diagnostics().bytes, 0);
});
