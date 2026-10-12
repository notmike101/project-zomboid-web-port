// Direct WebGPU presentation for the M1 proof: one production backend, no WebGL fallback.

const WORLD_MIN = 0;
const WORLD_SPAN = 10;
const WORLD_MAX = WORLD_MIN + WORLD_SPAN;
const MAX_SOURCE_BYTES = 16 * 1_024 * 1_024;
const MAX_TEXTURE_BYTES = 64 * 1_024 * 1_024;
const MAX_HEADER_DIMENSION = 4_096;
const MAX_PIXEL_RATIO = 2;
const BYTES_PER_TEXEL = 4;
const SPRITE_WORLD_SIZE = 2;
const GRID_MAJOR = 1;
const GRID_MINOR = 0.25;
const VIEW_UNIFORM_BYTES = 48;
const SPRITE_UNIFORM_BYTES = 64;
const PNG_HEADER_BYTES = 33;
const PNG_IHDR_LENGTH = 13;
const PNG_IHDR_TYPE_OFFSET = 12;
const PNG_IHDR_LENGTH_OFFSET = 8;
const PNG_WIDTH_OFFSET = 16;
const PNG_HEIGHT_OFFSET = 20;
const PNG_BIT_DEPTH_OFFSET = 24;
const PNG_COLOR_TYPE_OFFSET = 25;
const PNG_COMPRESSION_OFFSET = 26;
const PNG_FILTER_OFFSET = 27;
const PNG_INTERLACE_OFFSET = 28;
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_COLOR_TYPE_BIT_DEPTHS = new Map([
    [0, [1, 2, 4, 8, 16]],
    [2, [8, 16]],
    [3, [1, 2, 4, 8]],
    [4, [8, 16]],
    [6, [8, 16]],
]);
const PNG_INTERLACE_METHODS = [0, 1];

// Full-screen triangle; the fragment stage draws the bounded plane, tile grid, border and idle marker.
const PLANE_SHADER = /* wgsl */ `
struct View {
    rectMin: vec2<f32>,
    rectMax: vec2<f32>,
    marker: vec2<f32>,
    grid: vec2<f32>,
    pixel: vec2<f32>,
    action: f32,
    plane: f32,
};

@group(0) @binding(0) var<uniform> view: View;

struct PlaneVertex {
    @builtin(position) clip: vec4<f32>,
    @location(0) world: vec2<f32>,
};

@vertex
fn planeVertex(@builtin(vertex_index) index: u32) -> PlaneVertex {
    var corners = array<vec2<f32>, 3>(vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0));
    let ndc = corners[index];
    let extent = view.rectMax - view.rectMin;
    var out: PlaneVertex;

    out.clip = vec4<f32>(ndc, 0.0, 1.0);
    out.world = view.plane * vec2<f32>(
        (ndc.x - view.rectMin.x) / extent.x,
        1.0 - (ndc.y - view.rectMin.y) / extent.y
    );

    return out;
}

fn gridAlpha(world: vec2<f32>, cell: f32, width: f32) -> f32 {
    let dx = abs(fract(world.x / cell + 0.5) - 0.5) * cell;
    let dy = abs(fract(world.y / cell + 0.5) - 0.5) * cell;

    return max(1.0 - smoothstep(0.0, width, dx), 1.0 - smoothstep(0.0, width, dy));
}

@fragment
fn planeFragment(in: PlaneVertex) -> @location(0) vec4<f32> {
    let world = in.world;
    let inset = min(min(world.x, view.plane - world.x), min(world.y, view.plane - world.y));
    let line = max(view.pixel.x, view.pixel.y);

    if (inset < 0.0) {
        return vec4<f32>(0.055, 0.070, 0.062, 1.0);
    }

    let tile = floor(world);
    let parity = f32((i32(tile.x) + i32(tile.y)) % 2);
    var colour = mix(vec3<f32>(0.155, 0.196, 0.165), vec3<f32>(0.129, 0.169, 0.141), parity);

    colour = mix(colour, vec3<f32>(0.235, 0.294, 0.247), gridAlpha(world, view.grid.y, line));
    colour = mix(colour, vec3<f32>(0.345, 0.439, 0.361), gridAlpha(world, view.grid.x, line));
    colour = mix(colour, vec3<f32>(0.565, 0.647, 0.553), 1.0 - smoothstep(0.0, 2.5 * line, inset));

    let radius = length(world - view.marker);
    colour = mix(colour, vec3<f32>(0.980, 0.871, 0.510), 1.0 - smoothstep(0.40, 0.46, radius));
    colour = mix(colour, vec3<f32>(0.545, 0.780, 0.949), view.action * (1.0 - smoothstep(0.0, 2.0 * line, abs(radius - 0.62))));

    return vec4<f32>(colour, 1.0);
}
`;

// Unit quad sampled from the imported texture; texture row 0 is the top of the art.
const ART_SHADER = /* wgsl */ `
struct Sprite {
    rectMin: vec2<f32>,
    rectMax: vec2<f32>,
};

@group(0) @binding(0) var<uniform> sprite: Sprite;
@group(0) @binding(1) var art: texture_2d<f32>;
@group(0) @binding(2) var artSampler: sampler;

struct ArtVertex {
    @builtin(position) clip: vec4<f32>,
    @location(0) texcoord: vec2<f32>,
};

@vertex
fn artVertex(@builtin(vertex_index) index: u32) -> ArtVertex {
    var corners = array<vec2<f32>, 4>(vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 1.0));
    let corner = corners[index];
    var out: ArtVertex;

    out.clip = vec4<f32>(
        mix(sprite.rectMin.x, sprite.rectMax.x, corner.x),
        mix(sprite.rectMax.y, sprite.rectMin.y, corner.y),
        0.0,
        1.0
    );
    out.texcoord = corner;

    return out;
}

@fragment
fn artFragment(in: ArtVertex) -> @location(0) vec4<f32> {
    return textureSample(art, artSampler, in.texcoord);
}
`;

/**
 * Engine snapshot fields the renderer needs.
 *
 * @typedef {object} RendererSnapshot
 * @property {number} x World x coordinate on the shared [0, 10] plane.
 * @property {number} y World y coordinate on the shared [0, 10] plane, increasing south.
 * @property {number} action Engine action code: 0 idle, 1 destination, 2 walking.
 */

/**
 * Detached description of one uploaded PNG.
 *
 * @typedef {object} RendererAsset
 * @property {string} name Selected file name.
 * @property {number} width Texture width in texels.
 * @property {number} height Texture height in texels.
 * @property {number} sourceBytes Encoded PNG byte count.
 * @property {number} textureBytes Estimated uploaded RGBA byte count.
 */

/**
 * JSON-serialisable presentation evidence.
 *
 * @typedef {object} RendererDiagnostics
 * @property {string} backend Always `WebGPU`.
 * @property {boolean|null} fallbackAdapter True when the adapter is the software fallback, false for hardware, null when the adapter withholds the answer.
 * @property {{vendor: string, architecture: string, device: string, description: string}|null} adapter Adapter identity, or null when unavailable; the driver may leave fields empty.
 * @property {string[]} features Adapter feature names.
 * @property {{maxTextureDimension2D: number, maxUniformBufferBindingSize: number}} limits Device limits enforced during import.
 * @property {string} canvasFormat Swap chain texture format.
 * @property {{width: number, height: number, pixelRatio: number}} canvas Drawing buffer size and applied pixel density.
 * @property {{min: number, max: number}} worldPlane Bounded plane shared with {@link worldFromCanvas}.
 * @property {number} frames Submitted frame count.
 * @property {number} textureBytes Estimated bytes of live imported textures.
 * @property {RendererAsset|null} asset Imported asset metadata, or null before import.
 * @property {boolean} stopped True after an unrecoverable GPU failure.
 * @property {boolean} destroyed True after {@link createRenderer} handle destruction.
 */

/**
 * Renderer handle returned by {@link createRenderer}.
 *
 * @typedef {object} RendererHandle
 * @property {(file: File) => Promise<RendererAsset>} importImage Validates, uploads and describes one local PNG.
 * @property {(snapshot: RendererSnapshot) => void} render Submits one frame for a detached snapshot.
 * @property {() => RendererDiagnostics} diagnostics Detached backend evidence.
 * @property {() => void} destroy Releases every GPU resource.
 */

/**
 * Restricts a value to an inclusive range.
 *
 * @param {number} value - Candidate value.
 * @param {number} minimum - Lower bound.
 * @param {number} maximum - Upper bound.
 * @returns {number} Bounded value.
 */
function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
}

/**
 * Fits the square world plane inside a canvas box and reports its normalised device coordinate bounds.
 * The result depends only on aspect, so pointer mapping and shaders agree at any pixel density.
 *
 * @param {number} width - Box width in pixels.
 * @param {number} height - Box height in pixels.
 * @returns {{minX: number, minY: number, maxX: number, maxY: number}} Plane bounds in normalised device coordinates.
 */
function fitBox(width, height) {
    const side = Math.min(width, height);
    const offset = (width - side) / 2;
    const top = (height - side) / 2;

    return {
        minX: -1 + (2 * offset) / width,
        maxX: 1 - (2 * offset) / width,
        minY: -1 + (2 * top) / height,
        maxY: 1 - (2 * top) / height,
    };
}

/**
 * Compares a visual measurement with the same length reported by the layout boxes.
 *
 * @param {number} visual - Length as reported by getBoundingClientRect.
 * @param {number} layout - Length as reported by the element's layout boxes.
 * @returns {number} Positive axis-aligned scale, or 1 when either length is degenerate.
 */
function axisScale(visual, layout) {
    return visual > 0 && layout > 0 ? visual / layout : 1;
}

/**
 * Reads a finite in-bounds position from an engine snapshot.
 *
 * @param {RendererSnapshot} snapshot - Detached snapshot from the WASM engine.
 * @returns {{x: number, y: number}} Position clamped onto the bounded plane.
 */
function requirePosition(snapshot) {
    if (typeof snapshot?.x !== 'number' || typeof snapshot?.y !== 'number') {
        throw new TypeError('A snapshot with numeric x and y is required.');
    }

    if (!Number.isFinite(snapshot.x) || !Number.isFinite(snapshot.y)) {
        throw new RangeError('Snapshot coordinates must be finite.');
    }

    return { x: clamp(snapshot.x, WORLD_MIN, WORLD_MAX), y: clamp(snapshot.y, WORLD_MIN, WORLD_MAX) };
}

/**
 * Validates the PNG signature and IHDR chunk before any pixel allocation happens.
 * Colour type and bit depth must form one of the PNG specification's valid combinations;
 * Adam7 interlacing and 16-bit samples are decoded by the browser and down-converted to
 * 8-bit RGBA on upload, and an animated PNG contributes its first frame.
 *
 * @internal
 * @param {Uint8Array} bytes - First {@link PNG_HEADER_BYTES} bytes of the selected file.
 * @returns {{width: number, height: number}} Declared dimensions.
 */
function parsePngHeader(bytes) {
    if (bytes.length < PNG_HEADER_BYTES) {
        throw new TypeError('The PNG header is truncated.');
    }

    for (const [index, signatureByte] of PNG_SIGNATURE.entries()) {
        if (bytes[index] !== signatureByte) {
            throw new TypeError('The selected file is not a PNG image.');
        }
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    if (view.getUint32(PNG_IHDR_LENGTH_OFFSET) !== PNG_IHDR_LENGTH
        || String.fromCharCode(
            bytes[PNG_IHDR_TYPE_OFFSET],
            bytes[PNG_IHDR_TYPE_OFFSET + 1],
            bytes[PNG_IHDR_TYPE_OFFSET + 2],
            bytes[PNG_IHDR_TYPE_OFFSET + 3],
        ) !== 'IHDR') {
        throw new TypeError('The PNG IHDR chunk is malformed.');
    }

    const width = view.getUint32(PNG_WIDTH_OFFSET);
    const height = view.getUint32(PNG_HEIGHT_OFFSET);

    if (width === 0 || height === 0) {
        throw new RangeError('The PNG declares an empty image.');
    }

    const bitDepths = PNG_COLOR_TYPE_BIT_DEPTHS.get(bytes[PNG_COLOR_TYPE_OFFSET]);

    if (!bitDepths?.includes(bytes[PNG_BIT_DEPTH_OFFSET])
        || bytes[PNG_COMPRESSION_OFFSET] !== 0
        || bytes[PNG_FILTER_OFFSET] !== 0
        || !PNG_INTERLACE_METHODS.includes(bytes[PNG_INTERLACE_OFFSET])) {
        throw new TypeError('The PNG declares an unsupported colour type, bit depth, compression, filter or interlace method.');
    }

    return { width, height };
}

/**
 * Scales the sprite so the longest art side keeps the requested world size.
 *
 * @param {number} width - Texture width in texels.
 * @param {number} height - Texture height in texels.
 * @returns {{width: number, height: number}} Sprite extent in world units.
 */
function spriteExtent(width, height) {
    const scale = SPRITE_WORLD_SIZE / Math.max(width, height);

    return { width: width * scale, height: height * scale };
}

/**
 * Rejects invalid WGSL with the compiler message instead of a later uncaptured error.
 *
 * @param {GPUShaderModule} module - Shader module to compile.
 * @returns {Promise<void>} Resolves once the compiler reports no error.
 */
async function requireCompiled(module) {
    const info = await module.getCompilationInfo();

    for (const message of info.messages) {
        if (message.type === 'error') {
            throw new Error(`WGSL compilation failed: ${message.message}`);
        }
    }
}

/**
 * Presents WASM engine state over a bounded synthetic plane using real WebGPU submission.
 * Rendering works before any import; acceptance requires an imported PNG sprite.
 *
 * @param {HTMLCanvasElement} canvas - Canvas element to present into.
 * @param {(cause: Error) => void} onError - Receives the first unrecoverable GPU failure.
 * @returns {Promise<RendererHandle>} Ready renderer handle.
 */
export async function createRenderer(canvas, onError) {
    if (!navigator.gpu) {
        throw new Error('WebGPU is unavailable in this browser; there is no fallback renderer.');
    }

    const context = canvas.getContext('webgpu');

    if (!context) {
        throw new Error('The canvas element cannot provide a WebGPU context.');
    }

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });

    if (!adapter) {
        throw new Error('No WebGPU adapter could be acquired.');
    }

    const device = await adapter.requestDevice();
    const format = navigator.gpu.getPreferredCanvasFormat();

    context.configure({ device, format, alphaMode: 'opaque' });

    const adapterInfo = adapter.info ?? await adapter.requestAdapterInfo?.() ?? null;
    const maxDimension = Math.min(MAX_HEADER_DIMENSION, adapter.limits.maxTextureDimension2D);
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const viewBuffer = device.createBuffer({ label: 'plane-view', size: VIEW_UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const spriteBuffer = device.createBuffer({ label: 'art-sprite', size: SPRITE_UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const viewData = new Float32Array(VIEW_UNIFORM_BYTES / BYTES_PER_TEXEL);
    const spriteData = new Float32Array(SPRITE_UNIFORM_BYTES / BYTES_PER_TEXEL);

    let frames = 0;
    let stopped = false;
    let destroyed = false;
    let drawScale = 1;
    /** @type {RendererAsset|null} */
    let asset = null;
    /** @type {GPUTexture|null} */
    let texture = null;
    /** @type {GPUBindGroup|null} */
    let spriteBindGroup = null;

    /**
     * Reports the first unrecoverable failure once; a page reload is the recovery path.
     *
     * @param {Error} cause - Failure to surface to the host.
     * @returns {void}
     */
    function fail(cause) {
        if (stopped || destroyed) {
            return;
        }

        stopped = true;
        onError(cause);
    }

    /**
     * Surfaces a WebGPU validation error that would otherwise be silently dropped.
     *
     * @param {GPUUncapturedErrorEvent} event - Uncaptured error event.
     * @returns {void}
     */
    function reportUncapturedError(event) {
        fail(new Error(`Uncaptured WebGPU error: ${event.error.message}`));
    }

    /**
     * Turns device loss into a reported, terminal failure.
     *
     * @param {GPUDeviceLostInfo} loss - Reason and message from the device.
     * @returns {void}
     */
    function reportDeviceLost(loss) {
        fail(new Error(`WebGPU device lost (${loss.reason}): ${loss.message} Reload the page to recover.`));
    }

    device.onuncapturederror = reportUncapturedError;

    if (device.lost) {
        device.lost.then(reportDeviceLost);
    }

    const planeModule = device.createShaderModule({ label: 'plane', code: PLANE_SHADER });
    const artModule = device.createShaderModule({ label: 'art', code: ART_SHADER });

    await requireCompiled(planeModule);
    await requireCompiled(artModule);

    const viewLayout = device.createBindGroupLayout({
        entries: [{
            binding: 0,
            visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
            buffer: { type: 'uniform', hasDynamicOffset: false, minBindingSize: VIEW_UNIFORM_BYTES },
        }],
    });
    const artLayout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform', hasDynamicOffset: false, minBindingSize: 16 } },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        ],
    });
    const planePipeline = device.createRenderPipeline({
        label: 'plane',
        layout: device.createPipelineLayout({ bindGroupLayouts: [viewLayout] }),
        vertex: { module: planeModule, entryPoint: 'planeVertex' },
        fragment: { module: planeModule, entryPoint: 'planeFragment', targets: [{ format }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
    });
    const artPipeline = device.createRenderPipeline({
        label: 'art',
        layout: device.createPipelineLayout({ bindGroupLayouts: [artLayout] }),
        vertex: { module: artModule, entryPoint: 'artVertex' },
        fragment: {
            module: artModule,
            entryPoint: 'artFragment',
            targets: [{
                format,
                blend: {
                    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                },
            }],
        },
        primitive: { topology: 'triangle-strip', cullMode: 'none' },
    });
    const viewBindGroup = device.createBindGroup({ layout: viewLayout, entries: [{ binding: 0, resource: { buffer: viewBuffer } }] });

    /**
     * Matches the drawing buffer to the CSS content box, keeping the CSS aspect ratio under
     * the pixel-density and device dimension caps so the shader plane stays aligned with
     * {@link worldFromCanvas} at any display size.
     *
     * @returns {void} Resizes the canvas backing store when needed.
     */
    function resize() {
        const cssWidth = Math.max(1, canvas.clientWidth || canvas.width);
        const cssHeight = Math.max(1, canvas.clientHeight || canvas.height);
        const scale = Math.min(
            devicePixelRatio || 1,
            MAX_PIXEL_RATIO,
            maxDimension / cssWidth,
            maxDimension / cssHeight,
        );
        const width = Math.max(1, Math.round(cssWidth * scale));
        const height = Math.max(1, Math.round(cssHeight * scale));

        drawScale = scale;

        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
    }

    /**
     * Uploads the plane uniform. Layout matches the WGSL View struct exactly.
     *
     * @param {{minX: number, minY: number, maxX: number, maxY: number}} box - Plane bounds in device coordinates.
     * @param {{x: number, y: number}} position - World position of the marker.
     * @param {number} action - Engine action code.
     * @returns {void} Queues one uniform write.
     */
    function writePlane(box, position, action) {
        viewData[0] = box.minX;
        viewData[1] = box.minY;
        viewData[2] = box.maxX;
        viewData[3] = box.maxY;
        viewData[4] = position.x;
        viewData[5] = position.y;
        viewData[6] = GRID_MAJOR;
        viewData[7] = GRID_MINOR;

        const worldPerPixel = WORLD_SPAN / Math.min(canvas.width, canvas.height);

        viewData[8] = worldPerPixel;
        viewData[9] = worldPerPixel;
        viewData[10] = action > 0 ? 1 : 0;
        viewData[11] = WORLD_SPAN;
        device.queue.writeBuffer(viewBuffer, 0, viewData);
    }

    /**
     * Uploads the sprite rectangle for the current asset at the snapshot position.
     *
     * @param {{minX: number, minY: number, maxX: number, maxY: number}} box - Plane bounds in device coordinates.
     * @param {{x: number, y: number}} position - World position of the marker.
     * @param {RendererAsset} imported - Live asset metadata.
     * @returns {void} Queues one uniform write.
     */
    function writeSprite(box, position, imported) {
        const extent = spriteExtent(imported.width, imported.height);
        const perUnitX = (box.maxX - box.minX) / WORLD_SPAN;
        const perUnitY = (box.maxY - box.minY) / WORLD_SPAN;
        const centreX = box.minX + position.x * perUnitX;
        const centreY = box.maxY - position.y * perUnitY;
        const halfX = (extent.width / 2) * perUnitX;
        const halfY = (extent.height / 2) * perUnitY;

        spriteData[0] = centreX - halfX;
        spriteData[1] = centreY - halfY;
        spriteData[2] = centreX + halfX;
        spriteData[3] = centreY + halfY;
        device.queue.writeBuffer(spriteBuffer, 0, spriteData);
    }

    /**
     * Publishes a new texture and releases the one it replaces.
     *
     * @param {GPUTexture} uploaded - Newly uploaded texture.
     * @param {RendererAsset} metadata - Detached description of the uploaded art.
     * @returns {void}
     */
    function replaceAsset(uploaded, metadata) {
        if (texture) {
            texture.destroy();
        }

        texture = uploaded;
        asset = metadata;
        spriteBindGroup = device.createBindGroup({
            layout: artLayout,
            entries: [
                { binding: 0, resource: { buffer: spriteBuffer } },
                { binding: 1, resource: uploaded.createView() },
                { binding: 2, resource: sampler },
            ],
        });
    }

    /**
     * Validates, decodes and uploads one user-selected PNG without ever leaving the device.
     * Every spec-valid colour type, bit depth and interlace method is accepted; the decoder
     * premultiplies alpha and down-converts to 8-bit RGBA, so 16-bit art loses precision and
     * an animated PNG contributes its first frame.
     *
     * @param {File} file - Selected PNG file.
     * @returns {Promise<RendererAsset>} Detached metadata of the live texture.
     */
    async function importImage(file) {
        if (destroyed) {
            throw new Error('This renderer has been destroyed.');
        }

        if (stopped) {
            throw new Error('The renderer stopped after a GPU failure; reload the page to recover.');
        }

        if (!(file instanceof File)) {
            throw new TypeError('A PNG File from the local file input is required.');
        }

        if (file.size === 0 || file.size > MAX_SOURCE_BYTES) {
            throw new RangeError(`The PNG must be between 1 and ${MAX_SOURCE_BYTES} bytes.`);
        }

        const header = parsePngHeader(new Uint8Array(await file.slice(0, PNG_HEADER_BYTES).arrayBuffer()));

        if (stopped || destroyed) {
            throw new Error('This renderer is no longer accepting imports.');
        }

        if (header.width > maxDimension || header.height > maxDimension) {
            throw new RangeError(`The PNG must be at most ${maxDimension} texels per side on this device.`);
        }

        const textureBytes = header.width * header.height * BYTES_PER_TEXEL;

        if (textureBytes > MAX_TEXTURE_BYTES) {
            throw new RangeError(`The decoded texture would need ${textureBytes} bytes, above the ${MAX_TEXTURE_BYTES} byte limit.`);
        }

        const bitmap = await createImageBitmap(file, { premultiplyAlpha: 'premultiply' });

        try {
            if (stopped || destroyed) {
                throw new Error('This renderer stopped before the decoded PNG could be uploaded.');
            }

            if (bitmap.width !== header.width || bitmap.height !== header.height) {
                throw new Error('The decoded PNG dimensions disagree with its IHDR chunk.');
            }

            const uploaded = device.createTexture({
                label: 'imported-art',
                size: { width: header.width, height: header.height },
                format: 'rgba8unorm',
                usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            });

            device.queue.copyExternalImageToTexture(
                { source: bitmap },
                { texture: uploaded, premultipliedAlpha: true },
                { width: header.width, height: header.height },
            );
            replaceAsset(uploaded, {
                name: file.name,
                width: header.width,
                height: header.height,
                sourceBytes: file.size,
                textureBytes,
            });
        } finally {
            bitmap.close();
        }

        return { ...asset };
    }

    /**
     * Submits one frame: procedural bounded plane plus the imported art at snapshot coordinates.
     *
     * @param {RendererSnapshot} snapshot - Detached engine snapshot.
     * @returns {void} Executes one GPU queue submission.
     */
    function render(snapshot) {
        if (stopped || destroyed) {
            return;
        }

        const position = requirePosition(snapshot);

        resize();

        const box = fitBox(canvas.width, canvas.height);
        const action = typeof snapshot.action === 'number' && snapshot.action > 0 ? 1 : 0;

        writePlane(box, position, action);

        if (asset) {
            writeSprite(box, position, asset);
        }

        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: context.getCurrentTexture().createView(),
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
        });

        pass.setPipeline(planePipeline);
        pass.setBindGroup(0, viewBindGroup);
        pass.draw(3);

        if (asset) {
            pass.setPipeline(artPipeline);
            pass.setBindGroup(0, spriteBindGroup);
            pass.draw(4);
        }

        pass.end();
        device.queue.submit([encoder.finish()]);
        frames += 1;
    }

    /**
     * Returns detached, JSON-serialisable backend and asset evidence.
     *
     * @returns {RendererDiagnostics} Current renderer state.
     */
    function diagnostics() {
        return {
            backend: 'WebGPU',
            fallbackAdapter: adapterInfo?.isFallbackAdapter ?? null,
            adapter: adapterInfo
                ? {
                        vendor: adapterInfo.vendor,
                        architecture: adapterInfo.architecture,
                        device: adapterInfo.device,
                        description: adapterInfo.description,
                    }
                : null,
            features: [...adapter.features],
            limits: {
                maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
                maxUniformBufferBindingSize: adapter.limits.maxUniformBufferBindingSize,
            },
            canvasFormat: format,
            canvas: {
                width: canvas.width,
                height: canvas.height,
                pixelRatio: drawScale,
            },
            worldPlane: { min: WORLD_MIN, max: WORLD_MAX },
            frames,
            textureBytes: asset?.textureBytes ?? 0,
            asset: asset ? { ...asset } : null,
            stopped,
            destroyed,
        };
    }

    /**
     * Releases every GPU resource and stops presentation; safe to call more than once.
     *
     * @returns {void}
     */
    function destroy() {
        if (destroyed) {
            return;
        }

        destroyed = true;
        device.onuncapturederror = null;

        if (texture) {
            texture.destroy();
        }

        texture = null;
        spriteBindGroup = null;
        asset = null;
        viewBuffer.destroy();
        spriteBuffer.destroy();
        context.unconfigure();
        device.destroy();
    }

    return Object.freeze({ importImage, render, diagnostics, destroy });
}

/**
 * Maps a pointer position on the canvas onto the same bounded plane the renderer draws.
 * The border-excluding content box is the box `resize` sizes the drawing buffer from, and
 * viewport coordinates are normalised by the element's layout boxes, so a bordered or
 * zoomed canvas cannot desynchronise clicks from presentation. Assumes an axis-aligned,
 * positively scaled layout; a rotated or reflected canvas is not supported.
 *
 * @param {HTMLCanvasElement} canvas - Presentation canvas.
 * @param {number} clientX - Pointer x in viewport pixels.
 * @param {number} clientY - Pointer y in viewport pixels.
 * @returns {{x: number, y: number}} World coordinates clamped to [0, 10].
 */
export function worldFromCanvas(canvas, clientX, clientY) {
    const box = canvas.getBoundingClientRect();
    const layoutWidth = Math.max(1, canvas.offsetWidth);
    const layoutHeight = Math.max(1, canvas.offsetHeight);
    const scaleX = axisScale(box.width, layoutWidth);
    const scaleY = axisScale(box.height, layoutHeight);
    const width = Math.max(1, canvas.clientWidth || layoutWidth);
    const height = Math.max(1, canvas.clientHeight || layoutHeight);
    const plane = fitBox(width, height);
    const ndcX = ((clientX - box.left - canvas.clientLeft * scaleX) / (width * scaleX)) * 2 - 1;
    const ndcY = 1 - ((clientY - box.top - canvas.clientTop * scaleY) / (height * scaleY)) * 2;

    return {
        x: clamp(WORLD_MIN + WORLD_SPAN * (ndcX - plane.minX) / (plane.maxX - plane.minX), WORLD_MIN, WORLD_MAX),
        y: clamp(WORLD_MIN + WORLD_SPAN * (plane.maxY - ndcY) / (plane.maxY - plane.minY), WORLD_MIN, WORLD_MAX),
    };
}

// The byte gate is exported for focused header tests only; the public surface stays the handle.
export { parsePngHeader };
