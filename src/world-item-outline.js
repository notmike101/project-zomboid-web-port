/**
 * Source silhouette postprocess rewritten from the installed outline shader algorithms.
 * Only the caller draws source geometry and, for behind-player groups, the actual actor mask.
 */
// Existing renderer framebuffer bound, including DPR2 viewports.
const MAX_DIMENSION = 4_096;
// Binary mask + horizontal + vertical rgba8unorm + depth32float.
const TEXEL_BYTES = 16;
const MAX_BYTES = MAX_DIMENSION * MAX_DIMENSION * TEXEL_BYTES;
const SHADER = /* wgsl */ `
struct Parameters { resolution: vec2<f32>, radius: f32, axis: f32, color: vec4<f32> };
@group(0) @binding(0) var imageSampler: sampler;
@group(0) @binding(1) var image: texture_2d<f32>;
@group(0) @binding(2) var<uniform> parameters: Parameters;
@group(0) @binding(3) var mask: texture_2d<f32>;
struct Vertex { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> Vertex {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    var out: Vertex;
    out.position = vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), 0.0, 1.0);
    out.uv = uv;
    return out;
}
@fragment fn thicken(in: Vertex) -> @location(0) vec4<f32> {
    let step = select(vec2<f32>(parameters.radius / parameters.resolution.x, 0.0),
        vec2<f32>(0.0, parameters.radius / parameters.resolution.y), parameters.axis > 0.5);
    var sum = textureSampleLevel(image, imageSampler, in.uv, 0.0).a;
    for (var tap = -4; tap <= 4; tap++) {
        if (tap != 0) { sum += textureSampleLevel(image, imageSampler, in.uv + step * f32(tap), 0.0).a; }
    }
    // rgba8unorm attachment storage clamps each pass, AFTER multiplying source color alpha.
    return vec4<f32>(parameters.color.rgb, sum * parameters.color.a);
}
@fragment fn composite(in: Vertex) -> @location(0) vec4<f32> {
    let thickened = textureSampleLevel(image, imageSampler, in.uv, 0.0);
    let alpha = thickened.a * (1.0 - textureSampleLevel(mask, imageSampler, in.uv, 0.0).a);
    // Equivalent source RGB to original SRC_ALPHA blend, in a premultiplied destination.
    return vec4<f32>(thickened.rgb * alpha, alpha);
}
`;

/**
 * Round a clamped channel to the value stored by an rgba8unorm attachment.
 *
 * @param {number} value - Unquantized normalized channel.
 * @returns {number} Normalized eight-bit channel.
 */
function unorm(value) {
    return Math.round(Math.max(0, Math.min(1, value)) * 255) / 255;
}

/**
 * Original ModelOutlines.endFrame lerp(.5, .2, zoom / 2.5), without an invented clamp.
 *
 * @param {number} zoom - Original camera zoom (128 / current tile pixels at tileScale 2).
 * @returns {number} Source sampling radius in framebuffer pixels.
 */
function sourceOutlineRadius(zoom) {
    if (!Number.isFinite(zoom) || zoom < 0) {
        throw new RangeError('Invalid source outline zoom');
    }

    return 0.5 + (0.2 - 0.5) * (zoom / 2.5);
}

/**
 * Pure pixel reference for the binary mask, linear nine-tap sums and source-alpha blit.
 * This accepts authored alpha fixtures, not asset bytes; output is premultiplied RGBA.
 *
 * @param {{length:number,[index:number]:number}} alpha - Row-major unthresholded silhouette alpha.
 * @param {number} width - Fixture width.
 * @param {number} height - Fixture height.
 * @param {number[]} color - Exact normalized source color.
 * @param {number} radius - Source sampling radius.
 * @returns {Float64Array} Row-major premultiplied RGBA after rgba8 intermediate storage.
 */
function sourceOutlinePixels(alpha, width, height, color, radius) {
    validate(width, height, color, radius);

    if (alpha.length !== width * height || !Array.from(alpha).every((a) => Number.isFinite(a) && a >= 0 && a <= 1)) {
        throw new TypeError('Invalid outline alpha mask');
    }

    const mask = Float64Array.from(alpha, (a) => a >= 0.5 ? 1 : 0);
    /**
     * Read one alpha texel, clamping integer coordinates to the fixture edges.
     *
     * @param {Float64Array} pixels - Row-major alpha plane.
     * @param {number} x - Integer horizontal coordinate.
     * @param {number} y - Integer vertical coordinate.
     * @returns {number} Clamped-edge alpha sample.
     */
    const sample = (pixels, x, y) => pixels[Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))];
    /**
     * Sum the source nine-tap filter along one axis and quantize its colored alpha.
     *
     * @param {Float64Array} pixels - Input alpha plane.
     * @param {boolean} vertical - Whether to sample vertically instead of horizontally.
     * @returns {Float64Array} Quantized output alpha plane.
     */
    const pass = (pixels, vertical) => Float64Array.from(pixels, (_, index) => {
        const x = index % width;
        const y = Math.floor(index / width);
        let sum = pixels[index];

        for (let tap = -4; tap <= 4; tap++) {
            if (tap === 0) {
                continue;
            }

            const offset = tap * radius;
            const low = Math.floor(offset);
            const fraction = offset - low;
            const a = sample(pixels, x + (vertical ? 0 : low), y + (vertical ? low : 0));
            const b = sample(pixels, x + (vertical ? 0 : low + 1), y + (vertical ? low + 1 : 0));

            sum += a * (1 - fraction) + b * fraction;
        }

        return unorm(sum * color[3]);
    });
    const thickened = pass(pass(mask, false), true);
    const output = new Float64Array(width * height * 4);

    for (const [i, element] of mask.entries()) {
        const a = thickened[i] * (1 - element);

        output.set([unorm(color[0]) * a, unorm(color[1]) * a, unorm(color[2]) * a, a], i * 4);
    }

    return output;
}

/**
 * Account for the full source outline framebuffer at the existing renderer dimension limit.
 *
 * @param {number} width - Framebuffer width in physical pixels.
 * @param {number} height - Framebuffer height in physical pixels.
 * @returns {number} Bytes for three rgba8unorm targets and one depth32float target.
 */
function sourceOutlineStorage(width, height) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
        throw new RangeError('Outline framebuffer exceeds renderer dimensions or has invalid dimensions');
    }

    return width * height * TEXEL_BYTES;
}

/**
 * Validate the shared framebuffer/color trust boundary before allocating GPU storage.
 *
 * @param {number} width - Framebuffer width.
 * @param {number} height - Framebuffer height.
 * @param {number[]} color - Normalized source RGBA.
 * @param {number} radius - Finite source radius; signed extrapolation preserves the lerp.
 * @returns {void} Throws for invalid framebuffer, color or radius inputs.
 */
function validate(width, height, color, radius) {
    sourceOutlineStorage(width, height);

    if (color?.length !== 4 || !Array.from(color).every((c) => Number.isFinite(c) && c >= 0 && c <= 1) || !Number.isFinite(radius)) {
        throw new TypeError('Invalid source outline color or radius');
    }
}

/**
 * Create the outline consumer without allocating a viewport until begin is requested.
 * The supplied shader exposes vertexMain/fragmentMask and reads the source pipeline groups.
 * begin returns the genuine-geometry mask pass; caller MUST end it before finish.
 *
 * @param {{device:GPUDevice,format:string,sampler:GPUSampler,shader:GPUShaderModule,vertexBuffers:{arrayStride:number,stepMode?:string,attributes:{format:string,offset:number,shaderLocation:number}[]}[]}} options - Shared GPU inputs and source vertex layout.
 * @returns {object} Mask pipeline, passes, explicit residency and resource lifetime.
 */
function createWorldItemOutline({ device, format, sampler, shader, vertexBuffers }) {
    let pipelines = new WeakMap();
    let pipelineCount = 0;
    let width = 0;
    let height = 0;
    let textures = [];
    let views = [];
    let owner = null;
    let cursor = 0;
    let active = null;
    let destroyed = false;
    let begins = 0;
    let composites = 0;
    let playerMasks = 0;
    const slots = [];
    const uniformStride = device.limits.minUniformBufferOffsetAlignment;
    const module = device.createShaderModule({ label: 'source world-item outline sums', code: SHADER });
    const layout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', minBindingSize: 32 } },
            { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const vertex = { module, entryPoint: 'vertexMain' };
    const thicken = device.createRenderPipeline({
        label: 'source colored nine-tap outline', layout: pipelineLayout, vertex,
        fragment: { module, entryPoint: 'thicken', targets: [{ format: 'rgba8unorm' }] }, primitive: { topology: 'triangle-list' },
    });
    const blit = device.createRenderPipeline({
        label: 'source exterior outline composite', layout: pipelineLayout, vertex,
        fragment: {
            module, entryPoint: 'composite', targets: [{
                format, blend: {
                    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                },
            }],
        }, primitive: { topology: 'triangle-list' },
    });
    /**
     * Reject use after this consumer releases its resources.
     *
     * @returns {void} Throws if the consumer has been destroyed.
     */
    const checkAlive = () => {
        if (destroyed) {
            throw new Error('World-item outline is destroyed');
        }
    };

    /**
     * Bind a parameter slot, sampled alpha plane and original silhouette mask.
     *
     * @param {GPUBuffer} buffer - Per-group parameter buffer.
     * @param {GPUTextureView} source - Alpha plane sampled by this pass.
     * @param {number} offset - Aligned byte offset of this axis's parameters.
     * @returns {GPUBindGroup} Bindings for one filter or composite pass.
     */
    const group = (buffer, source, offset) => device.createBindGroup({
        layout, entries: [
            { binding: 0, resource: sampler }, { binding: 1, resource: source },
            { binding: 2, resource: { buffer, offset, size: 32 } }, { binding: 3, resource: views[0] },
        ],
    });

    /**
     * Replace viewport textures and invalidate bindings that referenced their views.
     *
     * @param {number} w - Validated framebuffer width in physical pixels.
     * @param {number} h - Validated framebuffer height in physical pixels.
     * @returns {void} Retains the new viewport or releases partial allocation on failure.
     */
    function resize(w, h) {
        if (width === w && height === h) {
            return;
        }

        for (const texture of textures) {
            texture.destroy();
        }

        textures = [];
        views = [];
        width = 0;
        height = 0;

        for (const slot of slots) {
            slot.groups = null;
        }

        try {
            for (let i = 0; i < 4; i++) {
                textures.push(device.createTexture({
                    label: `world-item outline ${['mask', 'horizontal', 'vertical', 'depth'][i]}`,
                    size: [w, h], format: i === 3 ? 'depth32float' : 'rgba8unorm',
                    usage: GPUTextureUsage.RENDER_ATTACHMENT | (i === 3 ? 0 : GPUTextureUsage.TEXTURE_BINDING),
                }));
            }

            views = textures.map((texture) => texture.createView());
            width = w;
            height = h;
        } catch (error) {
            for (const texture of textures) {
                texture.destroy();
            }

            textures = [];
            views = [];
            throw error;
        }
    }

    return {
        /**
         * Cache the genuine-geometry mask pipeline for a source layout and cull mode.
         *
         * @param {GPURenderPipeline} sourcePipeline - Source geometry pipeline supplying bind-group layouts.
         * @param {string} cullMode - Source primitive culling mode.
         * @returns {GPURenderPipeline} Compatible binary-silhouette pipeline.
         */
        pipeline(sourcePipeline, cullMode) {
            checkAlive();
            let variants = pipelines.get(sourcePipeline);

            if (!variants) {
                variants = new Map();
                pipelines.set(sourcePipeline, variants);
            }

            if (!variants.has(cullMode)) {
                variants.set(cullMode, device.createRenderPipeline({
                    label: 'actual source world-item silhouette',
                    layout: device.createPipelineLayout({ bindGroupLayouts: [sourcePipeline.getBindGroupLayout(0), sourcePipeline.getBindGroupLayout(1)] }),
                    vertex: { module: shader, entryPoint: 'vertexMain', buffers: vertexBuffers },
                    fragment: { module: shader, entryPoint: 'fragmentMask', targets: [{ format: 'rgba8unorm' }] },
                    primitive: { topology: 'triangle-list', cullMode }, depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
                }));
                pipelineCount++;
            }

            return variants.get(cullMode);
        },
        /**
         * Begin a binary silhouette pass with parameters isolated from earlier groups.
         *
         * @param {GPUCommandEncoder} encoder - Encoder owning this outline sequence.
         * @param {number} w - Framebuffer width in physical pixels.
         * @param {number} h - Framebuffer height in physical pixels.
         * @param {number[]} color - Exact normalized source RGBA.
         * @param {number} radius - Source sampling radius in framebuffer pixels.
         * @returns {GPURenderPassEncoder} Geometry mask pass that the caller must end before finish.
         */
        begin(encoder, w, h, color, radius) {
            checkAlive();

            if (active) {
                throw new Error('Finish the previous world-item outline before beginning another');
            }

            validate(w, h, color, radius);

            if (w > device.limits.maxTextureDimension2D || h > device.limits.maxTextureDimension2D) {
                throw new RangeError('Outline exceeds device texture limit');
            }

            resize(w, h);

            if (owner !== encoder) {
                owner = encoder;
                cursor = 0;
            }

            let slot = slots[cursor++];

            if (!slot) {
                slot = { buffer: device.createBuffer({ label: 'outline group parameters', size: uniformStride + 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }), groups: null };
                slots.push(slot);
            }

            // Separate per-encoder slots prevent later color-group writes from recoloring earlier draws.
            device.queue.writeBuffer(slot.buffer, 0, new Float32Array([w, h, radius, 0, ...color]));
            device.queue.writeBuffer(slot.buffer, uniformStride, new Float32Array([w, h, radius, 1, ...color]));

            if (!slot.groups) {
                slot.groups = [group(slot.buffer, views[0], 0), group(slot.buffer, views[1], uniformStride), group(slot.buffer, views[2], 0)];
            }

            active = slot;
            begins++;

            return encoder.beginRenderPass({
                label: 'genuine world-item binary silhouette',
                colorAttachments: [{ view: views[0], clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
                depthStencilAttachment: { view: views[3], depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
            });
        },
        /**
         * Encode the two sums, optional actor exclusion and exterior color composite.
         *
         * @param {GPUCommandEncoder} encoder - Encoder that began the active outline.
         * @param {{renderPlayerMask?:(pass:GPURenderPassEncoder)=>void}|null|undefined} view - Optional genuine actor-mask renderer.
         * @param {GPUTextureView} colorView - Destination color attachment to load and composite over.
         * @returns {void} Completes the active outline sequence.
         */
        finish(encoder, view, colorView) {
            checkAlive();

            if (!active || owner !== encoder) {
                throw new Error('No matching world-item outline mask pass');
            }

            for (let axis = 0; axis < 2; axis++) {
                const pass = encoder.beginRenderPass({
                    label: axis ? 'source outline vertical sum' : 'source outline horizontal sum',
                    colorAttachments: [{ view: views[axis + 1], clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
                });

                pass.setPipeline(thicken);
                pass.setBindGroup(0, active.groups[axis]);
                pass.draw(3);
                pass.end();
            }

            // Original order: thicken the item mask first, then subtract the actual actor silhouette.
            if (view?.renderPlayerMask) {
                const playerPass = encoder.beginRenderPass({
                    label: 'source behind-player silhouette exclusion',
                    colorAttachments: [{ view: views[0], loadOp: 'load', storeOp: 'store' }],
                    depthStencilAttachment: { view: views[3], depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
                });

                view.renderPlayerMask(playerPass);
                playerPass.end();
                playerMasks++;
            }

            const pass = encoder.beginRenderPass({ label: 'source outline exterior composite', colorAttachments: [{ view: colorView, loadOp: 'load', storeOp: 'store' }] });

            pass.setPipeline(blit);
            pass.setBindGroup(0, active.groups[2]);
            pass.draw(3);
            pass.end();
            composites++;
            active = null;
        },
        /**
         * Report retained viewport storage and encoded outline activity.
         *
         * @returns {{width:number,height:number,bytes:number,maxBytes:number,pipelineCount:number,begins:number,composites:number,playerMasks:number,occlusion:string}} Detached resource and pass counters.
         */
        diagnostics() {
            return {
                width, height, bytes: width ? sourceOutlineStorage(width, height) : 0, maxBytes: MAX_BYTES, pipelineCount, begins, composites, playerMasks,
                occlusion: 'caller-supplied genuine player mask after sums for native behind-player groups',
            };
        },
        /**
         * Release all owned textures and parameter buffers; repeated calls are harmless.
         *
         * @returns {void} Invalidates this consumer and clears its retained resources.
         */
        destroy() {
            if (destroyed) {
                return;
            }

            for (const texture of textures) {
                texture.destroy();
            }

            for (const slot of slots) {
                slot.buffer.destroy();
            }

            textures = [];
            views = [];
            slots.length = 0;
            width = 0;
            height = 0;
            pipelines = new WeakMap();
            pipelineCount = 0;
            owner = null;
            active = null;
            destroyed = true;
        },
    };
}

export { sourceOutlineRadius, sourceOutlinePixels, sourceOutlineStorage, createWorldItemOutline };
