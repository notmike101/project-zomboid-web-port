/* Original ItemModelRenderer geometry/material consumer in the shared WebGPU depth pass. */
import { createWorldItemOutline, sourceOutlineRadius } from './world-item-outline.js';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const MAX_BYTES = 64 * 1_024 * 1_024;
const MODEL_CAMERA_Z = -0.48 * 1.5 / Math.sqrt(6) + 0.001_75;
// IsoCamera's standing ground anchor is 56 native pixels below the viewport centre at tile width 128.
const MODEL_CAMERA_GROUND_Y = 56 / 128;
const SHADER = /* wgsl */ `
struct ItemView {
    projection: mat4x4<f32>, object: mat4x4<f32>, tint: vec4<f32>,
    viewport: vec4<f32>, parameters: vec4<f32>,
};
@group(0) @binding(0) var<uniform> view: ItemView;
@group(1) @binding(0) var image: texture_2d<f32>;
@group(1) @binding(1) var imageSampler: sampler;
struct Vertex { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vertexMain(@location(0) position: vec3<f32>, @location(1) uv: vec2<f32>) -> Vertex {
    var out: Vertex;
    if (view.parameters.x > 0.5) {
        out.position = view.projection * view.object[3];
        out.position.x += position.x * view.viewport.z / 128.0 * 2.0 / view.viewport.x;
        out.position.y -= position.y * view.viewport.z / 128.0 * 2.0 / view.viewport.y;
    } else {
        out.position = view.projection * view.object * vec4<f32>(position, 1.0);
    }
    out.uv = uv;
    return out;
}
@fragment fn fragmentMain(in: Vertex) -> @location(0) vec4<f32> {
    let sample = textureSample(image, imageSampler, in.uv);
    if (sample.a <= 0.01) { discard; }
    return vec4<f32>(sample.rgb * view.tint.rgb * view.tint.a, sample.a * view.tint.a);
}
@fragment fn fragmentMask(in: Vertex) -> @location(0) vec4<f32> {
    if (textureSample(image, imageSampler, in.uv).a < 0.5) { discard; }
    return vec4<f32>(1.0);
}
`;

/**
 * Multiply column-major source matrices without changing their coordinate system.
 *
 * @param {Float32Array} a - Left matrix.
 * @param {Float32Array} b - Right matrix.
 * @returns {Float32Array} Product.
 */
function multiply(a, b) {
    const out = new Float32Array(16);

    for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
            for (let k = 0; k < 4; k++) {
                out[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
            }
        }
    }

    return out;
}

/**
 * Retain exact source camera rotation order: Rx(worldX), Ry(worldZ), Rz(worldY).
 *
 * @param {number} axis - Axis ordinal.
 * @param {number} degrees - Native angle.
 * @returns {Float32Array} Right-handed rotation.
 */
function rotation(axis, degrees) {
    const out = IDENTITY.slice();
    const a = (axis + 1) % 3;
    const b = (axis + 2) % 3;
    const radians = degrees * Math.PI / 180;

    out[a * 4 + a] = Math.cos(radians);
    out[b * 4 + b] = Math.cos(radians);
    out[a * 4 + b] = Math.sin(radians);
    out[b * 4 + a] = -Math.sin(radians);

    return out;
}

/**
 * Native source coordinates, never guessed mesh normalization or inventory coordinates.
 * Core.DoPushIsoStuff/WorldModelCamera: (-1.5,1.5,1.5), y=-.48 and sqrt(6) level units.
 *
 * @param {object} item - Current native visual/placement record.
 * @param {object} representation - Actual source geometry and world attachment transform.
 * @returns {Float32Array} Source-local to authoritative world matrix.
 */
export function worldItemTransform(item, representation) {
    const fields = ['x', 'y', 'z', 'xoff', 'yoff', 'zoff', 'worldXRotation', 'worldYRotation', 'worldZRotation', 'worldScale'];

    if (!fields.every((field) => Number.isFinite(item[field]))) {
        throw new TypeError(`Incomplete native world-item transform: ${item.id}`);
    }

    const out = IDENTITY.slice();

    out[12] = item.x + item.xoff;
    out[13] = item.y + item.yoff;
    out[14] = item.z + item.zoff;

    if (representation.kind === 'sprite') {
        return out;
    }

    const conversion = new Float32Array([1.5, 0, 0, 0, 0, 0, 1.5 / Math.sqrt(6), 0, 0, -1.5, 0, 0, 0, 0, MODEL_CAMERA_Z, 1]);
    const scale = IDENTITY.slice();
    const nativeScale = representation.source?.selection === 'head-clothing' ? 1 : item.worldScale;

    scale[0] = nativeScale;
    scale[5] = nativeScale;
    scale[10] = nativeScale;
    const local = representation.transform;

    if (!(local instanceof Float32Array) || local.length !== 16 || !local.every(Number.isFinite)) {
        throw new TypeError(`Missing actual source model transform: ${item.id}`);
    }

    let matrix = multiply(out, conversion);

    matrix = multiply(matrix, rotation(0, item.worldXRotation));
    matrix = multiply(matrix, rotation(1, item.worldZRotation));
    matrix = multiply(matrix, rotation(2, item.worldYRotation));

    return multiply(multiply(matrix, local), scale);
}

/**
 * Select only this native level and reject ambiguous stable ownership.
 *
 * @param {object[]} items - Fresh native ground ownership records (inventory ids are absent).
 * @param {number} z - Actual current actor elevation.
 * @returns {object[]} Current-level records.
 */
export function selectWorldItems(items, z) {
    if (!Array.isArray(items) || !Number.isFinite(z)) {
        throw new TypeError('Invalid native world-item snapshot');
    }

    const seen = new Set();

    return items.filter((item) => {
        if (!Number.isSafeInteger(item.id) || item.id <= 0 || seen.has(item.id)) {
            throw new TypeError('Invalid or duplicate native world-item id');
        }

        seen.add(item.id);

        return item.z === Math.floor(z);
    });
}

/**
 * Project exact transformed source bounds to the live viewport.
 *
 * @param {object} item - Native record.
 * @param {object} representation - Original model bounds or sprite trim.
 * @param {object} view - Shared render view.
 * @param {Float32Array} [matrix] - Reused native/source matrix.
 * @returns {boolean} Whether positive-area source geometry intersects the viewport.
 */
export function worldItemVisible(item, representation, view, matrix = worldItemTransform(item, representation)) {
    if (item.z !== Math.floor(view.characterZ)) {
        return false;
    }

    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    /**
     * Project a world-space point relative to the current isometric camera.
     *
     * @param {number} x - World x coordinate.
     * @param {number} y - World y coordinate.
     * @param {number} z - World elevation.
     * @returns {number[]} Camera-relative pixel coordinates.
     */
    const project = (x, y, z) => {
        const dx = x - view.camera.x;
        const dy = y - view.camera.y;

        return [(dx - dy) * view.tilePixels / 2, (dx + dy) * view.tilePixels / 4 - z * view.tilePixels * 1.5];
    };

    if (representation.kind === 'sprite') {
        const [x, y] = project(matrix[12], matrix[13], matrix[14]);
        const q = representation.quad;

        left = x + q.left * view.tilePixels / 128;
        right = left + q.width * view.tilePixels / 128;
        top = y + q.top * view.tilePixels / 128;
        bottom = top + q.height * view.tilePixels / 128;
    } else {
        const bounds = representation.bounds;

        if (!bounds || ![...bounds.min, ...bounds.max].every(Number.isFinite)) {
            throw new TypeError('Missing actual source model bounds');
        }

        for (let corner = 0; corner < 8; corner++) {
            const x = (corner & 1 ? bounds.max : bounds.min)[0];
            const y = (corner & 2 ? bounds.max : bounds.min)[1];
            const z = (corner & 4 ? bounds.max : bounds.min)[2];
            const p = project(matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12], matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13], matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]);

            left = Math.min(left, p[0]);
            right = Math.max(right, p[0]);
            top = Math.min(top, p[1]);
            bottom = Math.max(bottom, p[1]);
        }

        top -= MODEL_CAMERA_GROUND_Y * view.tilePixels;
        bottom -= MODEL_CAMERA_GROUND_Y * view.tilePixels;
    }

    return right > left && bottom > top && left < view.width / 2 && right > -view.width / 2 && top < view.height / 2 && bottom > -view.height / 2;
}

/**
 * Apply the source model tint replacement or sprite TintMod multiplication.
 *
 * @param {object} representation - Actual source material.
 * @param {object} [highlight] - Current original world-object highlight state.
 * @returns {number[]} Material RGBA.
 */
export function worldItemTint(representation, highlight) {
    const tint = representation.tint ?? [1, 1, 1, 1];

    if (!highlight?.enabled) {
        return tint;
    }

    const { r, g, b } = highlight.color;

    if (![r, g, b].every(Number.isFinite)) {
        throw new TypeError('Invalid original world-item highlight color');
    }

    return representation.kind === 'sprite' ? [tint[0] * r, tint[1] * g, tint[2] * b, tint[3]] : [r, g, b, 1];
}

/**
 * Create the actual source mesh/sprite GPU consumer; source loading is never substituted by a quad box.
 *
 * @param {{device:GPUDevice,format:string,sampler:GPUSampler,assets:object}} options - Shared GPU and source resolver.
 * @returns {object} Shared-pass render lifecycle and explicit failures.
 */
export function createWorldItemLayer({ device, format, sampler, assets }) {
    const module = device.createShaderModule({ label: 'original ground item material', code: SHADER });
    const pipelines = new Map();
    const records = new Map();
    const resources = new Map();
    const errors = new Map();
    let destroyed = false;
    let bytes = 0;
    let drawn = [];
    let capacityRevision = 0;
    const pending = new Set();
    let outline;
    const vertexBuffers = [{ arrayStride: 20, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x2' }] }];
    const viewLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: 176 } }] });
    const textureLayout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }, { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } }] });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [viewLayout, textureLayout] });
    /**
     * Cache the shared material pipeline for the source culling mode.
     *
     * @param {string} cullMode - Source front, back, or disabled face culling.
     * @returns {object} Matching GPU render pipeline.
     */
    const pipeline = (cullMode) => {
        if (!pipelines.has(cullMode)) {
            pipelines.set(cullMode, device.createRenderPipeline({
                label: 'original world item', layout: pipelineLayout,
                vertex: { module, entryPoint: 'vertexMain', buffers: vertexBuffers },
                fragment: { module, entryPoint: 'fragmentMain', targets: [{ format, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }] },
                primitive: { topology: 'triangle-list', cullMode }, depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
            }));
        }

        return pipelines.get(cullMode);
    };

    /**
     * Release an item's uniform and its final shared geometry/texture reference.
     *
     * @param {object} record - Resident or partially loaded item record.
     */
    const release = (record) => {
        record.uniform?.destroy();
        const resource = record.resource;

        if (resource && --resource.references === 0) {
            resource.vertices.destroy();
            resource.indices.destroy();
            resource.texture.destroy();
            bytes -= resource.bytes;
            resources.delete(resource.key);
            capacityRevision += 1;
        }
    };

    /**
     * Upload an indexed geometry array to a GPU buffer.
     *
     * @param {string} label - GPU debugging label.
     * @param {Float32Array|Uint32Array} data - Geometry values to upload.
     * @param {number} usage - Required GPU buffer usage flags.
     * @returns {object} Uploaded GPU buffer.
     */
    const buffer = (label, data, usage) => {
        const result = device.createBuffer({ label, size: Math.max(4, data.byteLength), usage: usage | GPUBufferUsage.COPY_DST });

        device.queue.writeBuffer(result, 0, data);

        return result;
    };

    /**
     * Resolve source assets and acquire shared GPU residency for a live item.
     *
     * @param {object} record - Item record whose identity guards asynchronous loading.
     * @param {object} item - Current native item placement and visual state.
     * @returns {Promise<void>} Completion of this item's source/GPU loading.
     */
    async function load(record, item) {
        const rep = await assets.resolve(item, () => !destroyed && records.get(item.id) === record);

        if (destroyed || records.get(item.id) !== record) {
            return;
        }

        if (!rep) {
            throw new TypeError(`Missing actual world-item representation: ${item.id}`);
        }

        record.representation = rep;

        if (rep.kind === 'hidden') {
            return;
        }

        if (!['model', 'sprite'].includes(rep.kind) || typeof rep.key !== 'string') {
            throw new TypeError('Missing actual world-item representation');
        }

        let resource = resources.get(rep.key);

        if (!resource) {
            const bitmap = rep.crop ? await createImageBitmap(rep.texture, rep.crop.x, rep.crop.y, rep.crop.width, rep.crop.height) : await createImageBitmap(rep.texture);

            try {
                if (destroyed || records.get(item.id) !== record) {
                    return;
                }

                // Another same-source decode can settle while this bitmap is loading.
                resource = resources.get(rep.key);

                if (!resource) {
                    const q = rep.quad;
                    const positions = rep.kind === 'sprite' ? new Float32Array([q.left, q.top, 0, q.left + q.width, q.top, 0, q.left, q.top + q.height, 0, q.left + q.width, q.top + q.height, 0]) : rep.positions;
                    const uv = rep.kind === 'sprite' ? new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]) : rep.uvs;
                    const indices = rep.kind === 'sprite' ? new Uint32Array([0, 1, 2, 2, 1, 3]) : rep.indices;

                    if (!(positions instanceof Float32Array) || !(uv instanceof Float32Array) || !(indices instanceof Uint32Array) || positions.length / 3 !== uv.length / 2) {
                        throw new TypeError('Invalid actual world-item geometry');
                    }

                    const vertices = new Float32Array(positions.length / 3 * 5);

                    for (let i = 0; i < positions.length / 3; i++) {
                        vertices.set(positions.subarray(i * 3, i * 3 + 3), i * 5);
                        vertices.set(uv.subarray(i * 2, i * 2 + 2), i * 5 + 3);
                    }

                    const cost = vertices.byteLength + indices.byteLength + bitmap.width * bitmap.height * 4;

                    if (bytes + cost > MAX_BYTES) {
                        record.capacityRevision = capacityRevision;
                        throw new RangeError('Original world-item GPU residency exceeds 64 MiB');
                    }

                    if (bitmap.width > device.limits.maxTextureDimension2D || bitmap.height > device.limits.maxTextureDimension2D) {
                        throw new RangeError('Original world-item texture exceeds device limit');
                    }

                    const texture = device.createTexture({ label: `original item ${rep.key}`, size: [bitmap.width, bitmap.height], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });

                    device.queue.copyExternalImageToTexture({ source: bitmap }, { texture, premultipliedAlpha: true }, [bitmap.width, bitmap.height]);
                    const cullMode = rep.cullFace === 'back' || rep.cullFace === 'front' ? rep.cullFace : 'none';
                    const selected = pipeline(cullMode);

                    resource = { key: rep.key, bytes: cost, references: 0, texture, pipeline: selected, cullMode, vertices: buffer('original item vertices', vertices, GPUBufferUsage.VERTEX), indices: buffer('original item indices', indices, GPUBufferUsage.INDEX), count: indices.length };
                    resource.group = device.createBindGroup({ layout: selected.getBindGroupLayout(1), entries: [{ binding: 0, resource: texture.createView() }, { binding: 1, resource: sampler }] });
                    resources.set(rep.key, resource);
                    bytes += cost;
                }
            } finally {
                bitmap.close();
            }
        }

        record.resource = resource;
        resource.references += 1;
        record.uniform = device.createBuffer({ label: `native world item ${item.id}`, size: 176, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        record.values = new Float32Array(44);
        record.group = device.createBindGroup({ layout: resource.pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: record.uniform } }] });
    }

    /**
     * Wait until all current and subsequently queued source loads settle.
     *
     * @returns {Promise<void>} Resolution once no pending loads remain.
     */
    function whenLoaded() {
        return pending.size ? Promise.all(pending).then(whenLoaded) : Promise.resolve();
    }

    return {
        /**
         * Synchronize native ownership and draw visible resident source geometry.
         *
         * @param {object} pass - Shared GPU render pass with the world depth attachment.
         * @param {object} view - Current native items, camera, projection, and highlights.
         */
        render(pass, view) {
            if (destroyed) {
                return;
            }

            drawn = [];
            const items = selectWorldItems(view.worldItems ?? [], view.characterZ);
            const current = new Set(items.map((item) => item.id));

            for (const [id, record] of records) {
                if (!current.has(id)) {
                    release(record);
                    records.delete(id);
                    errors.delete(id);
                }
            }

            for (const item of items) {
                const signature = JSON.stringify([item.type ?? item.fullType, item.definition, item.visual]);
                let record = records.get(item.id);

                if (record?.signature !== signature || (record.capacityRevision !== undefined && record.capacityRevision !== capacityRevision)) {
                    if (record) {
                        release(record);
                    }

                    record = { signature };
                    records.set(item.id, record);
                    errors.delete(item.id);
                    const promise = load(record, item).catch((error) => {
                        if (!destroyed && records.get(item.id) === record) {
                            errors.set(item.id, String(error));
                        }
                    }).finally(() => pending.delete(promise));

                    pending.add(promise);
                }

                if (!record.resource) {
                    continue;
                }

                const rep = record.representation;
                const matrix = worldItemTransform(item, rep);

                if (!worldItemVisible(item, rep, view, matrix)) {
                    continue;
                }

                const highlight = view.worldHighlights?.find((entry) => entry.kind === 'item' && entry.id === item.id && entry.enabled);
                const tint = worldItemTint(rep, highlight);
                const values = record.values;

                values.set(view.projection, 0);

                if (rep.kind === 'model') {
                    // Normalize the source camera's ground anchor to the shared floor frame, in physical pixels.
                    values[13] += 2 * MODEL_CAMERA_GROUND_Y * view.tilePixels / view.height;
                    /* Original targetDepth anchors the camera origin to the logical placement
                       while retaining mesh-local depth: squareDepth + depth(vertex) - depth(camera origin).
                       This clip-Z rebase preserves local transforms and ordinary wall depth tests. */
                    values[14] -= view.projection[10] * MODEL_CAMERA_Z;
                }

                values.set(matrix, 16);
                values.set(tint, 32);
                values.set([view.width, view.height, view.tilePixels, 0], 36);
                values[40] = rep.kind === 'sprite' ? 1 : 0;
                device.queue.writeBuffer(record.uniform, 0, values);
                const gpu = record.resource;

                pass.setPipeline(gpu.pipeline);
                pass.setBindGroup(0, record.group);
                pass.setBindGroup(1, gpu.group);
                pass.setVertexBuffer(0, gpu.vertices);
                pass.setIndexBuffer(gpu.indices, 'uint32');
                pass.drawIndexed(gpu.count);
                drawn.push({ id: item.id, kind: rep.kind, key: rep.key, highlighted: Boolean(highlight) });
            }
        },
        /**
         * Draw source silhouette outlines, grouped by color and player occlusion.
         *
         * @param {object} encoder - GPU command encoder for outline passes.
         * @param {object} colorView - Destination world color texture view.
         * @param {object} view - Current native items, camera, and outline highlight state.
         */
        renderOutlines(encoder, colorView, view) {
            const groups = new Map();

            for (const entry of drawn) {
                const state = view.worldHighlights?.find((highlight) => highlight.kind === 'item' && highlight.id === entry.id && highlight.outline);

                if (!state) {
                    continue;
                }

                const item = view.worldItems.find((row) => row.id === entry.id);
                const behindPlayer = item.x + item.xoff + item.y + item.yoff < view.camera.x + view.camera.y;
                const color = state.outlineColor;

                if (!color || ![color.r, color.g, color.b, color.a].every(Number.isFinite)) {
                    throw new TypeError('Missing original world-item outline color');
                }

                const key = JSON.stringify([color, behindPlayer]);

                if (!groups.has(key)) {
                    groups.set(key, { color, behindPlayer, entries: [] });
                }

                groups.get(key).entries.push(entry);
            }

            if (!groups.size) {
                return;
            }

            outline ??= createWorldItemOutline({ device, format, sampler, shader: module, vertexBuffers });

            for (const { color, behindPlayer, entries } of groups.values()) {
                const pass = outline.begin(encoder, view.width, view.height, [color.r, color.g, color.b, color.a], sourceOutlineRadius(128 / view.tilePixels));

                for (const entry of entries) {
                    const record = records.get(entry.id);
                    const gpu = record.resource;

                    pass.setPipeline(outline.pipeline(gpu.pipeline, gpu.cullMode));
                    pass.setBindGroup(0, record.group);
                    pass.setBindGroup(1, gpu.group);
                    pass.setVertexBuffer(0, gpu.vertices);
                    pass.setIndexBuffer(gpu.indices, 'uint32');
                    pass.drawIndexed(gpu.count);
                    entry.outlined = true;
                }

                pass.end();
                outline.finish(encoder, behindPlayer ? view : { ...view, renderPlayerMask: undefined }, colorView);
            }
        },
        whenLoaded,
        /**
         * Report pending loads, GPU residency, actual draws, outlines, and source failures.
         *
         * @returns {object} Snapshot of the current layer lifecycle.
         */
        diagnostics() {
            return { loading: pending.size, residentItems: records.size, residentRepresentations: resources.size, bytes, budget: MAX_BYTES, drawn: [...drawn], outlines: outline?.diagnostics() ?? null, errors: [...errors].map(([id, message]) => ({ id, message })) };
        },
        /**
         * Release all resident GPU resources and invalidate pending source loads.
         */
        destroy() {
            destroyed = true;
            outline?.destroy();

            for (const record of records.values()) {
                release(record);
            }

            records.clear();
            errors.clear();
            drawn = [];
        },
    };
}
