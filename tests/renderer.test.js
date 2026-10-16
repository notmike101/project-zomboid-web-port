/* The PNG byte gate and the pointer plane are pure numeric logic that needs no GPU; upload,
   presentation and device-loss behaviour are proven by the browser run. */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canvasContentBox, createRenderer, parsePngHeader, WORLD_DEPTH_XY, WORLD_DEPTH_Z, worldDepth, worldFromCanvas } from '../src/renderer.js';

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

test('shared UI content coordinates exclude unequal borders and CSS axis scales independently of DPR', () => {
    const canvas = {
        clientWidth: 400, clientHeight: 240, clientLeft: 10, clientTop: 20,
        offsetWidth: 420, offsetHeight: 280, width: 800, height: 480,
        /**
         * Measure the actual scaled visual border box.
         *
         * @returns {{left: number, top: number, width: number, height: number}} Actual scaled visual border box.
         */
        getBoundingClientRect: () => ({ left: 100, top: 50, width: 630, height: 560 }),
    };
    const content = canvasContentBox(canvas);

    assert.deepEqual(content, { left: 115, top: 90, width: 400, height: 240, scaleX: 1.5, scaleY: 2 });
    const logicalPoint = { x: 15.5, y: 15.5 };
    const clientPoint = {
        x: content.left + logicalPoint.x * content.scaleX,
        y: content.top + logicalPoint.y * content.scaleY,
    };

    assert.deepEqual({
        x: (clientPoint.x - content.left) / content.scaleX,
        y: (clientPoint.y - content.top) / content.scaleY,
    }, logicalPoint, 'a point beyond a 15px source radius stays beyond it on both axes');
    canvas.width = 400;
    canvas.height = 240;
    assert.deepEqual(canvasContentBox(canvas), content, 'physical drawing-buffer density does not compress logical UI pixels');
});

test('native world depth uses one ground-camera frame for horizontal motion and elevation', () => {
    const camera = { x: 10, y: 20 };
    const position = { x: 12, y: 23, z: 2 };
    const depth = worldDepth(position, camera);

    assert.ok(Math.abs(depth - 0.487_009_812_2) < 1e-12);
    assert.ok(Math.abs(worldDepth({ ...position, x: 13 }, camera) - depth + WORLD_DEPTH_XY) < 1e-12);
    assert.ok(Math.abs(worldDepth({ ...position, y: 24 }, camera) - depth + WORLD_DEPTH_XY) < 1e-12);
    assert.ok(Math.abs(worldDepth({ ...position, z: 3 }, camera) - depth + WORLD_DEPTH_Z) < 1e-12);
    assert.equal(worldDepth({ x: 10_012, y: -4_977, z: 2 }, { x: 10_010, y: -4_980 }), depth);
    assert.equal(worldDepth(position, { ...camera, z: 7 }), depth, 'camera elevation does not change the supported ground-centered view');
});

/**
 * Accept a command at the mocked external GPU boundary.
 *
 * @returns {void} No GPU execution is simulated.
 */
function acceptGpuCommand() {
    // Only real renderer uploads and handoffs are observed by this fixture.
}

/**
 * Produce an opaque external GPU handle.
 *
 * @returns {object} A fresh handle without simulated GPU state.
 */
function gpuHandle() {
    return {};
}

/**
 * Produce a destroyable external GPU texture handle.
 *
 * @returns {object} Opaque texture and view boundary.
 */
function gpuTexture() {
    return { destroy: acceptGpuCommand, createView: gpuHandle };
}

/**
 * Build one animation in the synthetic X fixture.
 *
 * @param {string} name - Animation set name.
 * @returns {string} Identity-root animation source.
 */
function animation(name) {
    return `AnimationSet ${name} {Animation {{Root} AnimationKey T {2;1;0;3;0,0,0;;;}}}`;
}

/**
 * Project one point onto a matrix row.
 *
 * @param {Float32Array} matrix - Column-major projection matrix.
 * @param {number[]} point - Three-dimensional position.
 * @param {number} row - Output component.
 * @returns {number} Projected component before perspective division.
 */
function projected(matrix, point, row) {
    return matrix[row] * point[0] + matrix[row + 4] * point[1] + matrix[row + 8] * point[2] + matrix[row + 12];
}

// Captures real renderer uploads and its world-layer handoff; no shader execution is claimed.
test('player and world layer share native depth, camera translation and the unchanged screen projection', async (t) => {
    const names = ['navigator', 'devicePixelRatio', 'GPUBufferUsage', 'GPUTextureUsage', 'GPUShaderStage', 'GPUColorWrite', 'createImageBitmap'];
    const globals = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);

    t.after(() => {
        for (const [name, descriptor] of globals) {
            if (descriptor) {
                Object.defineProperty(globalThis, name, descriptor);
            } else {
                Reflect.deleteProperty(globalThis, name);
            }
        }
    });
    const uniforms = new Map();
    const pipelines = new Map();
    const passes = [];
    const pass = {
        setPipeline: acceptGpuCommand,
        setBindGroup: acceptGpuCommand,
        setVertexBuffer: acceptGpuCommand,
        setIndexBuffer: acceptGpuCommand,
        draw: acceptGpuCommand,
        drawIndexed: acceptGpuCommand,
        end: acceptGpuCommand,
    };
    const device = {
        queue: {
            /**
             * Capture real renderer uniform values at the GPU boundary.
             *
             * @param {object} buffer - Receiving buffer handle.
             * @param {number} offset - Byte offset of this upload.
             * @param {Float32Array} data - Uploaded values.
             */
            writeBuffer(buffer, offset, data) {
                uniforms.set(buffer.label, new Float32Array(data));
            },
            writeTexture: acceptGpuCommand,
            copyExternalImageToTexture: acceptGpuCommand,
            submit: acceptGpuCommand,
        },
        createSampler: gpuHandle,
        /**
         * Preserve the descriptor label used to identify uniform uploads.
         *
         * @param {object} descriptor - Buffer creation descriptor.
         * @returns {object} Destroyable buffer boundary handle.
         */
        createBuffer: (descriptor) => ({ ...descriptor, destroy: acceptGpuCommand }),
        createTexture: gpuTexture,
        /**
         * Supply the asynchronous shader compilation boundary without shader execution.
         *
         * @returns {object} Shader compilation interface.
         */
        createShaderModule: () => ({
            /**
             * Settle the synthetic shader compilation result.
             *
             * @returns {Promise<object>} Empty compilation diagnostics.
             */
            getCompilationInfo: () => Promise.resolve({ messages: [] }),
        }),
        createBindGroupLayout: gpuHandle,
        createPipelineLayout: gpuHandle,
        createBindGroup: gpuHandle,
        /**
         * Capture the real pipeline policy.
         *
         * @param {object} descriptor - Pipeline creation descriptor.
         * @returns {object} Opaque pipeline handle.
         */
        createRenderPipeline(descriptor) {
            pipelines.set(descriptor.label, descriptor);

            return {};
        },
        /**
         * Capture the same policy through the asynchronous pipeline interface.
         *
         * @param {object} descriptor - Pipeline creation descriptor.
         * @returns {Promise<object>} Opaque pipeline handle.
         */
        createRenderPipelineAsync(descriptor) {
            return Promise.resolve(this.createRenderPipeline(descriptor));
        },
        /**
         * Capture render-pass descriptors at the command encoder boundary.
         *
         * @returns {object} Render-pass capture interface.
         */
        createCommandEncoder: () => ({
            /**
             * Record the actual renderer pass descriptor.
             *
             * @param {object} descriptor - Render-pass descriptor.
             * @returns {object} Command-accepting pass boundary.
             */
            beginRenderPass(descriptor) {
                passes.push(descriptor);

                return pass;
            },
            finish: gpuHandle,
        }),
        pushErrorScope: acceptGpuCommand,
        /**
         * Settle the external validation boundary without a GPU error.
         *
         * @returns {Promise<null>} No validation error.
         */
        popErrorScope: () => Promise.resolve(null),
        destroy: acceptGpuCommand,
    };
    const adapter = {
        limits: { maxTextureDimension2D: 4_096 },
        /**
         * Supply the captured GPU boundary.
         *
         * @returns {Promise<object>} Device fixture.
         */
        requestDevice: () => Promise.resolve(device),
    };
    const values = {
        navigator: {
            gpu: {
                /**
                 * Supply the synthetic adapter boundary.
                 *
                 * @returns {Promise<object>} Adapter fixture.
                 */
                requestAdapter: () => Promise.resolve(adapter),
                /**
                 * Report the fixture's presentation format.
                 *
                 * @returns {string} RGBA presentation format.
                 */
                getPreferredCanvasFormat: () => 'rgba8unorm',
            },
        },
        devicePixelRatio: 1,
        GPUBufferUsage: { COPY_DST: 1, VERTEX: 2, INDEX: 4, UNIFORM: 8, STORAGE: 16 },
        GPUTextureUsage: { COPY_DST: 1, TEXTURE_BINDING: 2, RENDER_ATTACHMENT: 4 },
        GPUShaderStage: { VERTEX: 1, FRAGMENT: 2 },
        GPUColorWrite: { ALL: 0xF },
        /**
         * Supply the imported character's external bitmap boundary.
         *
         * @returns {Promise<object>} One-pixel bitmap with a release operation.
         */
        createImageBitmap: () => Promise.resolve({
            width: 1, height: 1, close: acceptGpuCommand,
        }),
    };

    for (const name of names) {
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: values[name] });
    }

    const context = {
        configure: acceptGpuCommand,
        unconfigure: acceptGpuCommand,
        getCurrentTexture: gpuTexture,
    };
    const canvas = {
        width: 640, height: 640, clientWidth: 640, clientHeight: 640,
        offsetWidth: 640, offsetHeight: 640, clientLeft: 0, clientTop: 0,
        /**
         * Supply the external presentation context.
         *
         * @returns {object} Canvas GPU context boundary.
         */
        getContext: () => context,
        /**
         * Keep the fixture's CSS and drawing-buffer coordinates aligned.
         *
         * @returns {object} Canvas viewport rectangle.
         */
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 640 }),
    };
    const renderer = await createRenderer(canvas, (error) => assert.fail(error));

    t.after(() => renderer.destroy());
    const identity = '1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1';
    const source = `xof 0303txt 0032
Frame Root {FrameTransformMatrix {${identity};;}
Mesh Triangle {3;0;0;0;,1;0;0;,0;1;0;;1;3;0,1,2;;
MeshNormals {1;0;0;1;;1;3;0,0,0;;}
MeshTextureCoords {3;0;0;,1;0;,0;1;;}
XSkinMeshHeader {1;1;1;}
SkinWeights {"Root";3;0,1,2;1,1,1;${identity};;}}}
AnimTicksPerSecond {1;}
${animation('Idle')}
${animation('Walk')}`;

    await renderer.importCharacter({
        model: new File([source], 'synthetic.x'),
        texture: new File([pngHeader({ width: 1, height: 1 })], 'synthetic.png'),
    });
    let view;

    renderer.setWorldLayer({
        /**
         * Capture the real world-layer view without executing GPU commands.
         *
         * @param {object} worldPass - Shared renderer pass boundary.
         * @param {object} current - Real camera and projection state.
         * @returns {boolean} Indicates that the world layer rendered.
         */
        render(worldPass, current) {
            view = { ...current, projection: current.projection.slice() };

            return true;
        },
        destroy: acceptGpuCommand,
    });

    for (const camera of [{ x: 10, y: 20 }, { x: 10_010, y: -4_980 }]) {
        renderer.render({ ...camera, action: 0, timeSeconds: 0 });
        const player = uniforms.get('character-projection');
        const elevated = { ...camera, z: 1.8 };

        assert.ok(Math.abs(projected(player, [0, 0, 0], 2) - 0.5) < 2e-6, 'player ground origin has no depth bias');
        assert.ok(Math.abs(projected(player, [0, 1, 0], 2) - 0.494_803_924_88) < 2e-6);
        assert.ok(Math.abs(projected(player, [0, 1, 0], 2) - projected(view.projection, [elevated.x, elevated.y, elevated.z], 2)) < 2e-6);
        assert.ok(Math.abs(projected(player, [0, 1, 0], 2) - worldDepth(elevated, view.camera)) < 2e-6);
        assert.ok(Math.abs(projected(view.projection, [camera.x + 2, camera.y + 3, 2], 2) - 0.487_009_812_2) < 2e-6);
        assert.ok(Math.abs(projected(player, [0, 0, 0], 0)) < 2e-4);
        assert.ok(Math.abs(projected(player, [0, 0, 0], 1)) < 2e-4);
        assert.ok(Math.abs(projected(player, [0, 1, 0], 1) - 0.54) < 2e-4, 'native depth does not move the existing elevated screen position');
        assert.deepEqual(renderer.worldFromCanvas(320, 320), camera, 'pointer and render camera stay ground-centered');

        for (const [dx, dy, z] of [[-10, -10, 0], [10, 10, 8]]) {
            const depth = projected(view.projection, [camera.x + dx, camera.y + dy, z], 2);

            assert.ok(depth > 0 && depth < 1, 'ordinary visible world depth stays within WebGPU clip range');
        }
    }

    assert.equal(pipelines.get('textured-four-weight-character').depthStencil.depthCompare, 'less-equal');
    assert.equal(pipelines.get('textured-four-weight-character').depthStencil.depthWriteEnabled, true);
    assert.equal(passes.find((descriptor) => descriptor.depthStencilAttachment).depthStencilAttachment.depthClearValue, 1);
});
