import { createGameUI, createUIRenderer } from './game-ui.js';
import { parseX, createSkin, sampleSkin, MAX_X_BYTES } from './models.js';

const canvasCameras = new WeakMap();
// Direct WebGPU presentation for the M1 proof: one production backend, no WebGL fallback.

// Native IsoDepthHelper coefficients; all world consumers share this ground-camera frame.
const WORLD_DEPTH_XY = 0.001_443_354_2;
const WORLD_DEPTH_Z = 0.002_886_708_4;

/**
 * Native world depth with the common WebGPU camera translation.
 * Camera elevation is deliberately absent from the supported ground-centered view.
 *
 * @param {{x:number,y:number,z:number}} position - World position, including elevation.
 * @param {{x:number,y:number}} camera - Isometric ground camera.
 * @returns {number} Depth before WebGPU clipping, with smaller values nearer the camera.
 */
function worldDepth(position, camera) {
    return 0.5 - WORLD_DEPTH_XY * ((position.x - camera.x) + (position.y - camera.y)) - WORLD_DEPTH_Z * position.z;
}

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
const VIEW_UNIFORM_BYTES = 80;
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
    camera: vec2<f32>,
    viewport: vec2<f32>,
    worldMode: f32,
    character: f32,
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
    if (view.worldMode > 0.0) {
        let screen = vec2<f32>(ndc.x, -ndc.y) * view.viewport * 0.5;
        out.world = view.camera + vec2<f32>(screen.x + 2.0 * screen.y, -screen.x + 2.0 * screen.y);
    }

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

    if (inset < 0.0 && view.worldMode == 0.0) {
        return vec4<f32>(0.055, 0.070, 0.062, 1.0);
    }

    let tile = floor(world);
    let parity = f32((i32(tile.x) + i32(tile.y)) % 2);
    var colour = mix(vec3<f32>(0.155, 0.196, 0.165), vec3<f32>(0.129, 0.169, 0.141), parity);

    colour = mix(colour, vec3<f32>(0.235, 0.294, 0.247), gridAlpha(world, view.grid.y, line));
    colour = mix(colour, vec3<f32>(0.345, 0.439, 0.361), gridAlpha(world, view.grid.x, line));
    if (view.worldMode == 0.0) {
        colour = mix(colour, vec3<f32>(0.565, 0.647, 0.553), 1.0 - smoothstep(0.0, 2.5 * line, inset));
    }

    if (view.character == 0.0) {
        let radius = length(world - view.marker);
        colour = mix(colour, vec3<f32>(0.980, 0.871, 0.510), 1.0 - smoothstep(0.40, 0.46, radius));
        colour = mix(colour, vec3<f32>(0.545, 0.780, 0.949), view.action * (1.0 - smoothstep(0.0, 2.0 * line, abs(radius - 0.62))));
    }

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

const CHARACTER_SHADER = /* wgsl */ `
@group(0) @binding(0) var<uniform> projection: mat4x4<f32>;
@group(0) @binding(1) var<storage, read> palette: array<mat4x4<f32>>;
@group(0) @binding(2) var body: texture_2d<f32>;
@group(0) @binding(3) var bodySampler: sampler;
struct CharacterVertex {
    @builtin(position) clip: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) light: f32,
};
@vertex fn characterVertex(
    @location(0) position: vec3<f32>, @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>, @location(3) weights: vec4<f32>,
    @location(4) bones: vec4<f32>
) -> CharacterVertex {
    let skin = palette[u32(bones.x)] * weights.x + palette[u32(bones.y)] * weights.y
        + palette[u32(bones.z)] * weights.z + palette[u32(bones.w)] * weights.w;
    var out: CharacterVertex;
    out.clip = projection * skin * vec4<f32>(position, 1.0);
    out.uv = uv;
    let n = normalize((skin * vec4<f32>(normal, 0.0)).xyz);
    out.light = 0.65 + 0.35 * max(dot(n, normalize(vec3<f32>(-0.4, 0.8, 0.6))), 0.0);
    return out;
}
@fragment fn characterFragment(in: CharacterVertex) -> @location(0) vec4<f32> {
    let colour = textureSample(body, bodySampler, in.uv);
    if (colour.a < 0.05) { discard; }
    return vec4<f32>(colour.rgb * in.light, colour.a);
}
@fragment fn characterMask(in: CharacterVertex) -> @location(0) vec4<f32> {
    if (textureSample(body, bodySampler, in.uv).a < 0.5) { discard; }
    return vec4<f32>(1.0);
}`;

/**
 * Engine snapshot fields the renderer needs.
 *
 * @typedef {object} RendererSnapshot
 * @property {number} x World x coordinate (unbounded with world/character mode).
 * @property {number} y World y coordinate, increasing south.
 * @property {number} action Engine action code: 0 idle, 1 destination, 2 walking.
 * @property {number} [timeSeconds] Explicit nonnegative animation time; when absent advancing ticks use capped presentation elapsed time.
 * @property {number} [tick] Engine tick used to freeze animation while simulation is paused.
 * @property {number} [headingX] Movement heading x, used when position deltas are zero.
 * @property {number} [headingY] Movement heading y.
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
 * Read-only live view supplied synchronously at the source world-render event boundaries.
 * The same object is reused; consumers retaining a frame must copy the required scalars.
 *
 * @typedef {object} WorldRenderView
 * @property {{readonly x: number, readonly y: number}} camera Current isometric ground camera.
 * @property {number} width Current drawing-buffer width in physical pixels.
 * @property {number} height Current drawing-buffer height in physical pixels.
 * @property {number} tilePixels Current physical isometric diamond width.
 * @property {number} pixelRatio Applied drawing-buffer pixel density, including device caps.
 * @property {number} characterZ Actual current port actor root elevation, constrained to ground.
 */

/**
 * Renderer handle returned by {@link createRenderer}.
 *
 * @typedef {object} RendererHandle
 * @property {(file: File) => Promise<RendererAsset>} importImage Validates, uploads and describes one local PNG.
 * @property {(files: {model: File, idle?: File, walk?: File, texture: File, ticksPerSecond?: number}) => Promise<object>} importCharacter Uploads an actual skinned ASCII X character with explicit PNG atlas.
 * @property {(enabled: boolean) => void} setWorldMode Enables unbounded isometric camera following.
 * @property {(clientX: number, clientY: number) => {x: number, y: number}} worldFromCanvas Maps pointer using the current camera.
 * @property {(layer: object|null) => void} setWorldLayer Installs an external tile render/destroy layer.
 * @property {() => {device: GPUDevice, format: string, sampler: GPUSampler}} gpuResources Shared device for the external world layer.
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
 * Shared border-excluding logical content box for world projection and original UI input.
 * CSS transforms affect the axis scales; drawing-buffer DPR does not change logical pixels.
 *
 * @param {HTMLCanvasElement} canvas - Presentation canvas.
 * @returns {{left: number, top: number, width: number, height: number, scaleX: number, scaleY: number}} Visual content origin, logical size and positive visual scales.
 */
function canvasContentBox(canvas) {
    const box = canvas.getBoundingClientRect();
    const layoutWidth = Math.max(1, canvas.offsetWidth);
    const layoutHeight = Math.max(1, canvas.offsetHeight);
    const scaleX = axisScale(box.width, layoutWidth);
    const scaleY = axisScale(box.height, layoutHeight);

    return {
        left: box.left + canvas.clientLeft * scaleX,
        top: box.top + canvas.clientTop * scaleY,
        width: Math.max(1, canvas.clientWidth || layoutWidth),
        height: Math.max(1, canvas.clientHeight || layoutHeight),
        scaleX, scaleY,
    };
}

/**
 * Reads a finite in-bounds position from an engine snapshot.
 *
 * @param {RendererSnapshot} snapshot - Detached snapshot from the WASM engine.
 * @param {boolean} unbounded - True bypasses plane clamping for camera-following modes.
 * @returns {{x: number, y: number}} Position clamped onto the bounded plane.
 */
function requirePosition(snapshot, unbounded = false) {
    if (typeof snapshot?.x !== 'number' || typeof snapshot?.y !== 'number') {
        throw new TypeError('A snapshot with numeric x and y is required.');
    }

    if (!Number.isFinite(snapshot.x) || !Number.isFinite(snapshot.y)) {
        throw new RangeError('Snapshot coordinates must be finite.');
    }

    return unbounded
        ? { x: snapshot.x, y: snapshot.y }
        : { x: clamp(snapshot.x, WORLD_MIN, WORLD_MAX), y: clamp(snapshot.y, WORLD_MIN, WORLD_MAX) };
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
 * Releases the GPU buffers and texture owned by the imported character, if any.
 *
 * @param {{resources: (GPUBuffer|GPUTexture)[]}|null} value - Character record or null.
 * @returns {void} Destroys each owned resource.
 */
function releaseCharacter(value) {
    if (!value) {
        return;
    }

    for (const resource of value.resources) {
        resource.destroy();
    }
}

/**
 * Reads one selected local X file and parses its text; no network access.
 *
 * @param {File} file - Selected X model or animation file.
 * @returns {Promise<object>} Parsed X document from {@link parseX}.
 */
async function readModel(file) {
    if (!(file instanceof File)) {
        throw new TypeError('Character model/animations must be local X Files.');
    }

    if (!file.size || file.size > MAX_X_BYTES) {
        throw new RangeError('X file must be between 1 byte and 16 MiB.');
    }

    return parseX(await file.text());
}

/**
 * Presents WASM engine state using real WebGPU submissions, with optional imported
 * static world tiles and a moving character followed by the source UI.
 *
 * @param {HTMLCanvasElement} canvas - Canvas element to present into.
 * @param {(cause: Error) => void} onError - Receives the first unrecoverable GPU failure.
 * @param {{onWorldOpaque?: (view: WorldRenderView) => void, onWorldBuilding?: (view: WorldRenderView) => void}} [options] - Synchronous hooks before and after moving-character draws, only after prepared source tiles; exceptions propagate to the caller.
 * @returns {Promise<RendererHandle>} Ready renderer handle.
 */
async function createRenderer(canvas, onError, { onWorldOpaque, onWorldBuilding } = {}) {
    if (onWorldOpaque !== undefined && typeof onWorldOpaque !== 'function') {
        throw new TypeError('onWorldOpaque must be a function.');
    }

    if (onWorldBuilding !== undefined && typeof onWorldBuilding !== 'function') {
        throw new TypeError('onWorldBuilding must be a function.');
    }

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
    let worldMode = false;
    let worldLayer = null;
    let character = null;
    let depthTexture = null;
    let depthWidth = 0;
    let depthHeight = 0;
    const projection = new Float32Array(16);
    const characterProjection = new Float32Array(16);
    const objectMatrix = new Float32Array(16);
    let camera = { x: 5, y: 5 };
    const worldView = {
        device, format, projection, camera, tilePixels: 0, width: 0, height: 0,
        /**
         * Add the actual animated actor silhouette to the source behind-player exclusion mask.
         *
         * @param {GPURenderPassEncoder} pass - Original contour mask pass.
         * @returns {void} Encodes actual actor triangles, never a proxy shape.
         */
        renderPlayerMask(pass) {
            if (!character) {
                return;
            }

            pass.setPipeline(character.maskPipeline);
            pass.setBindGroup(0, character.bindGroup);
            pass.setVertexBuffer(0, character.vertices);
            pass.setIndexBuffer(character.indices, 'uint32');
            pass.drawIndexed(character.skin.indices.length);
        },
    };
    const renderView = Object.freeze({
        camera: Object.freeze({
            /**
             * Read the live camera's horizontal position.
             *
             * @returns {number} Camera x coordinate.
             */
            get x() {
                return worldView.camera.x;
            },
            /**
             * Read the live camera's vertical position.
             *
             * @returns {number} Camera y coordinate.
             */
            get y() {
                return worldView.camera.y;
            },
        }),
        /**
         * Read the current render viewport width.
         *
         * @returns {number} Viewport width in pixels.
         */
        get width() {
            return worldView.width;
        },
        /**
         * Read the current render viewport height.
         *
         * @returns {number} Viewport height in pixels.
         */
        get height() {
            return worldView.height;
        },
        /**
         * Read the live tile projection size.
         *
         * @returns {number} Rendered pixels per tile.
         */
        get tilePixels() {
            return worldView.tilePixels;
        },
        /**
         * Read the current render pixel ratio.
         *
         * @returns {number} Drawing scale relative to CSS pixels.
         */
        get pixelRatio() {
            return drawScale;
        },
        // ponytail: actor simulation is ground-only; read native z when vertical actor simulation is ported.
        characterZ: 0,
    });
    const uiSessions = new Set();
    let gameUI = null;
    const uiRenderer = await createUIRenderer(device, format, sampler);

    /**
     * Create isolated candidate roots and IDs without changing the committed VM's UI.
     *
     * @param {{storage?:Storage}} [options] - Origin-local persistent Core option storage.
     * @returns {object} Candidate UI owned by this renderer.
     */
    function newGameUI(options = {}) {
        if (stopped || destroyed) {
            throw new Error('Renderer is no longer active.');
        }

        const ui = createGameUI({
            document: canvas.ownerDocument,
            focusTarget: canvas,
            storage: options.storage,
            /**
             * Unregister the disposed session and withdraw it if currently presented.
             */
            onDispose: () => {
                uiSessions.delete(ui);

                if (gameUI === ui) {
                    gameUI = null;
                }
            },
        });

        ui.setViewport(Math.max(1, canvas.clientWidth || canvas.width), Math.max(1, canvas.clientHeight || canvas.height));
        uiSessions.add(ui);

        return ui;
    }

    /**
     * Publish a successfully activated candidate; caller retains/releases old session explicitly.
     *
     * @param {object|null} ui - Candidate, or null to withdraw presentation.
     * @returns {void}
     */
    function setGameUI(ui) {
        if (stopped || destroyed) {
            throw new Error('Renderer is no longer active.');
        }

        if (ui !== null && !uiSessions.has(ui)) {
            throw new Error('UI must belong to this renderer.');
        }

        gameUI = ui;
    }

    /**
     * Upload real source images, decoding each shared pack page once per batch.
     * Only cropped sprite rectangles remain on GPU; source bitmaps always close.
     *
     * @param {object[]} entries - Original image files, aliases and optional source crop/trim.
     * @returns {Promise<object[]>} Candidate uploaded images; failure releases the whole batch.
     */
    async function uploadUITextures(entries) {
        const files = new Map();
        const loaded = [];

        for (const entry of entries) {
            const group = files.get(entry.file) ?? [];

            group.push(entry);
            files.set(entry.file, group);
        }

        /**
         * Record one physical GPU image and its genuine source aliases/trim.
         *
         * @param {object} entry - Selected resource record.
         * @param {number} width - Uploaded pixel width.
         * @param {number} height - Uploaded pixel height.
         * @param {GPUTexture} texture - Newly owned GPU resource.
         */
        function retain(entry, width, height, texture) {
            loaded.push({
                path: entry.path, aliases: entry.aliases, width, height, widthOrig: entry.widthOrig, heightOrig: entry.heightOrig,
                offsetX: entry.offsetX, offsetY: entry.offsetY, texture,
                /**
                 * Release this physical uploaded image exactly once.
                 *
                 * @returns {void} No retained GPU image.
                 */
                destroy: () => texture.destroy(),
            });
        }

        try {
            for (const [file, group] of files) {
                if (!group.some((entry) => entry.crop)) {
                    for (const entry of group) {
                        // eslint-disable-next-line no-await-in-loop
                        const uploaded = await importImage(file, true);

                        retain(entry, uploaded.metadata.width, uploaded.metadata.height, uploaded.texture);
                    }

                    continue;
                }

                if (!(file instanceof File) || file.size === 0 || file.size > MAX_SOURCE_BYTES || group.some((entry) => !entry.crop)) {
                    throw new Error('Original UI pack page requires a bounded PNG File and source crop records');
                }

                // eslint-disable-next-line no-await-in-loop
                const header = parsePngHeader(new Uint8Array(await file.slice(0, PNG_HEADER_BYTES).arrayBuffer()));

                for (const { crop } of group) {
                    if (![crop.x, crop.y, crop.width, crop.height].every(Number.isSafeInteger)
                        || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0
                        || crop.width > maxDimension || crop.height > maxDimension
                        || crop.x + crop.width > header.width || crop.y + crop.height > header.height) {
                        throw new Error('Original UI sprite crop is outside its source PNG or device limit');
                    }
                }

                // eslint-disable-next-line no-await-in-loop
                const bitmap = await createImageBitmap(file, { premultiplyAlpha: 'premultiply' });

                try {
                    if (stopped || destroyed || bitmap.width !== header.width || bitmap.height !== header.height) {
                        throw new Error('Renderer stopped or original UI page decode disagrees with source dimensions');
                    }

                    for (const entry of group) {
                        const { crop, path } = entry;
                        const texture = device.createTexture({
                            label: path, size: [crop.width, crop.height], format: 'rgba8unorm',
                            usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
                        });

                        retain(entry, crop.width, crop.height, texture);
                        device.queue.copyExternalImageToTexture(
                            { source: bitmap, origin: { x: crop.x, y: crop.y } },
                            { texture, premultipliedAlpha: true }, [crop.width, crop.height],
                        );
                    }
                } finally {
                    bitmap.close();
                }
            }

            if (stopped || destroyed) {
                throw new Error('Renderer stopped during original UI image upload');
            }

            return loaded;
        } catch (cause) {
            for (const entry of loaded) {
                entry.destroy();
            }

            throw cause;
        }
    }

    /**
     * Preload genuine PNG resources into an explicit, uncommitted candidate.
     * Failed decode/metrics validation destroys only candidate uploads.
     *
     * @param {{ui:object,textures:object[],fonts?:Record<string,{descriptor:string,atlasPath:string}>,fontAliases?:Record<string,string>,font?:{descriptor:string,atlasPath:string},translations:object,settings:object,indexedTextures?:string[]|Set<string>,resolveItemTextures?:(definitions:object[])=>Promise<object[]>}} resources - Selected original files, verified font aliases, source trim/icon resolver and explicit port settings.
     * @returns {Promise<void>} Completed candidate resource initialization.
     */
    async function initializeGameUI({ ui, textures, fonts, fontAliases, font, translations, settings, indexedTextures, resolveItemTextures }) {
        if (!uiSessions.has(ui)) {
            throw new Error('Explicit candidate UI belonging to this renderer is required.');
        }

        if (ui === gameUI) {
            throw new Error('Cannot mutate the committed game UI; initialize an independent candidate.');
        }

        const loaded = await uploadUITextures(textures);

        try {
            /**
             * Prepare newly declared genuine icons without replacing existing source roots.
             *
             * @param {object[]} definitions - Current source-backed item definitions.
             * @returns {Promise<void>} Completed additive upload.
             */
            async function loadItemTextures(definitions) {
                if (!uiSessions.has(ui) || typeof resolveItemTextures !== 'function') {
                    throw new Error('Original UI item resource owner/resolver is unavailable');
                }

                const entries = (await resolveItemTextures(definitions)).filter((entry) => !ui.hasTexture(entry.path));
                const uploads = await uploadUITextures(entries);

                try {
                    if (!uiSessions.has(ui)) {
                        throw new Error('Original UI item resource owner was disposed during preload');
                    }

                    ui.addTextures(uploads);
                } catch (cause) {
                    for (const entry of uploads) {
                        entry.destroy();
                    }

                    throw cause;
                }
            }

            if (stopped || destroyed) {
                throw new Error('Renderer stopped during UI preload.');
            }

            ui.initialize({ textures: loaded, fonts, fontAliases, font, translations, settings, indexedTextures, loadItemTextures });
        } catch (cause) {
            for (const entry of loaded) {
                entry.destroy();
            }

            throw cause;
        }
    }

    /**
     * Enables or disables unbounded isometric camera following for direct engine coordinates.
     *
     * @param {boolean} enabled - True follows the snapshot camera; false restores the bounded plane.
     */
    function setWorldMode(enabled) {
        if (typeof enabled !== 'boolean') {
            throw new TypeError('World mode requires a boolean.');
        }

        if (destroyed || stopped) {
            throw new Error('Renderer is no longer active.');
        }

        worldMode = enabled;

        if (!worldMode && !character) {
            canvasCameras.delete(canvas);
        } else {
            canvasCameras.set(canvas, camera);
        }
    }

    /**
     * Swaps the active tile layer; the replaced layer is destroyed first.
     *
     * @param {{render: (pass: unknown, view: object) => boolean, destroy: () => void}|null} layer - External world layer; render returns true only after prepared, error-free source world draws.
     */
    function setWorldLayer(layer) {
        if (destroyed || stopped) {
            throw new Error('Renderer is no longer active.');
        }

        if (layer !== null && (typeof layer?.render !== 'function' || typeof layer?.destroy !== 'function')) {
            throw new TypeError('A world layer must provide render(pass, view) and destroy().');
        }

        if (worldLayer !== layer) {
            worldLayer?.destroy();
        }

        worldLayer = layer;
    }

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

        gameUI?.setViewport(cssWidth, cssHeight);
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
        const following = worldMode || !!character;
        const tilePixels = Math.min(canvas.width, canvas.height) / WORLD_SPAN;

        viewData[12] = camera.x;
        viewData[13] = camera.y;
        viewData[14] = canvas.width / tilePixels;
        viewData[15] = canvas.height / tilePixels;
        viewData[16] = following ? 1 : 0;
        viewData[17] = character ? 1 : 0;
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
     * @param {boolean} detached - True uploads without installing the texture as the live asset.
     * @returns {Promise<RendererAsset>} Detached metadata of the live texture.
     */
    async function importImage(file, detached = false) {
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
        let uploaded = null;

        try {
            if (stopped || destroyed) {
                throw new Error('This renderer stopped before the decoded PNG could be uploaded.');
            }

            if (bitmap.width !== header.width || bitmap.height !== header.height) {
                throw new Error('The decoded PNG dimensions disagree with its IHDR chunk.');
            }

            uploaded = device.createTexture({
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
            const metadata = {
                name: file.name,
                width: header.width,
                height: header.height,
                sourceBytes: file.size,
                textureBytes,
            };

            if (detached) {
                return { texture: uploaded, metadata };
            }

            replaceAsset(uploaded, metadata);
        } catch (cause) {
            uploaded?.destroy();
            throw cause;
        } finally {
            bitmap.close();
        }

        return { ...asset };
    }

    /**
     * Import a local ASCII X model and idle/walk AnimationSets plus an explicit PNG UV
     * atlas. Idle/walk can be separate self-contained X files; if omitted their sets
     * must exist in model. No texture-name guessing, network access or native converter.
     * Requires one triangular mesh, <=256 frames and <=4 weights/vertex. Animation
     * tick rate comes from AnimTicksPerSecond; ticksPerSecond is explicit calibration
     * only when metadata is absent. Rejected imports preserve the previous character.
     *
     * @param {{model: File, idle?: File, walk?: File, texture: File, ticksPerSecond?: number}} files - Local selections.
     * @returns {Promise<object>} Detached file, geometry, timing, atlas and scale evidence.
     */
    async function importCharacter(files) {
        if (destroyed || stopped) {
            throw new Error('This renderer is no longer accepting imports.');
        }

        const { model, idle, walk, texture: bodyTexture, ticksPerSecond } = files ?? {};
        const parsed = await readModel(model);
        const idleSource = idle ? await readModel(idle) : parsed;
        const walkSource = walk ? await readModel(walk) : parsed;
        const skin = createSkin(parsed);

        /**
         * Finds the clip for one animation kind and proves it fits the skin's hierarchy.
         *
         * @param {object} source - Parsed X file providing the animation sets.
         * @param {string} kind - Clip name substring to match, `idle` or `walk`.
         * @param {File|undefined} explicitFile - File selected explicitly for this kind.
         * @returns {import('./models.js').XClip} Validated animation clip.
         */
        function selectClip(source, kind, explicitFile) {
            const clip = source.animations.find((candidate) => candidate.name?.toLowerCase().includes(kind))
                ?? (explicitFile && source.animations.length === 1 ? source.animations[0] : null);

            if (!clip) {
                throw new TypeError(`A ${kind} AnimationSet is required.`);
            }

            for (const frame of skin.frames) {
                const weighted = skin.bones.some((bone) => bone.frame === skin.byName.get(frame.name) && bone.weights.some((weight) => weight > 0));

                if (weighted && !clip.tracks.has(frame.name)) {
                    throw new TypeError(`${kind} animation omits weighted bone ${frame.name}.`);
                }
            }

            if (source.frames.length) {
                const sourceFrames = new Map(source.frames.map((frame) => [frame.name, frame]));

                for (const frame of skin.frames) {
                    const other = sourceFrames.get(frame.name);

                    if (!other) {
                        // Unweighted helper frames need not be exported by every clip.
                        continue;
                    }

                    const parent = frame.parent < 0 ? null : skin.frames[frame.parent].name;
                    const otherParent = other.parent < 0 ? null : source.frames[other.parent].name;

                    if (parent !== otherParent) {
                        throw new TypeError(`Incompatible animation hierarchy at ${frame.name}.`);
                    }
                }
            }

            sampleSkin(skin, clip, 0, ticksPerSecond);

            return clip;
        }

        const idleClip = selectClip(idleSource, 'idle', idle);
        const walkClip = selectClip(walkSource, 'walk', walk);
        const height = skin.bounds.max[1] - skin.bounds.min[1];

        if (!(height > 1e-6)) {
            throw new TypeError('Character mesh has no vertical extent.');
        }

        const resources = [];

        device.pushErrorScope('validation');
        let scopeOpen = true;

        try {
            const uploaded = await importImage(bodyTexture, true);

            resources.push(uploaded.texture);
            const module = device.createShaderModule({ label: 'character-skinning', code: CHARACTER_SHADER });

            await requireCompiled(module);
            const layout = device.createBindGroupLayout({
                entries: [
                    { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform', minBindingSize: 64 } },
                    { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
                    { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                    { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
                ],
            });
            const vertex = {
                module, entryPoint: 'characterVertex', buffers: [{
                    arrayStride: 64, attributes: [
                        { shaderLocation: 0, offset: 0, format: 'float32x3' },
                        { shaderLocation: 1, offset: 12, format: 'float32x3' },
                        { shaderLocation: 2, offset: 24, format: 'float32x2' },
                        { shaderLocation: 3, offset: 32, format: 'float32x4' },
                        { shaderLocation: 4, offset: 48, format: 'float32x4' },
                    ],
                }],
            };
            const characterLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
            const pipeline = await device.createRenderPipelineAsync({
                label: 'textured-four-weight-character', layout: characterLayout,
                vertex,
                fragment: {
                    module, entryPoint: 'characterFragment', targets: [{
                        format, blend: {
                            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                        },
                    }],
                },
                primitive: { topology: 'triangle-list', cullMode: 'none' },
                depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less-equal' },
            });
            const maskPipeline = await device.createRenderPipelineAsync({
                label: 'original outline player exclusion', layout: characterLayout, vertex,
                fragment: { module, entryPoint: 'characterMask', targets: [{ format: 'rgba8unorm' }] },
                primitive: { topology: 'triangle-list', cullMode: 'none' },
                depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'always' },
            });

            /**
             * Creates a writeable device buffer and registers it for release with the character.
             *
             * @param {string} label - Buffer label for diagnostics.
             * @param {Float32Array} data - Initial contents.
             * @param {number} usage - GPUBufferUsage flags besides COPY_DST.
             * @returns {GPUBuffer} Initialized device buffer.
             */
            function buffer(label, data, usage) {
                const result = device.createBuffer({ label, size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST });

                resources.push(result);
                device.queue.writeBuffer(result, 0, data);

                return result;
            }

            const vertices = buffer('character-static-vertices', skin.vertices, GPUBufferUsage.VERTEX);
            const indices = buffer('character-static-indices', skin.indices, GPUBufferUsage.INDEX);
            const palette = buffer('character-palette', skin.palette, GPUBufferUsage.STORAGE);
            const transform = buffer('character-projection', new Float32Array(16), GPUBufferUsage.UNIFORM);
            const bindGroup = device.createBindGroup({
                layout, entries: [
                    { binding: 0, resource: { buffer: transform } }, { binding: 1, resource: { buffer: palette } },
                    { binding: 2, resource: uploaded.texture.createView() }, { binding: 3, resource: sampler },
                ],
            });
            const validation = await device.popErrorScope();

            scopeOpen = false;

            if (validation) {
                throw new Error(`Character WebGPU validation failed: ${validation.message}`);
            }

            if (stopped || destroyed) {
                throw new Error('Renderer stopped during character import.');
            }

            const metadata = {
                model: model.name, idle: idle?.name ?? model.name, walk: walk?.name ?? model.name,
                texture: uploaded.metadata, embeddedTextureNames: [...parsed.textureNames],
                vertices: skin.vertices.length / 16, triangles: skin.indices.length / 3, bones: skin.bones.length,
                idleTicksPerSecond: idleClip.ticksPerSecond ?? ticksPerSecond,
                walkTicksPerSecond: walkClip.ticksPerSecond ?? ticksPerSecond,
                calibrated: !idleClip.ticksPerSecond || !walkClip.ticksPerSecond,
                sourceHeight: height, worldHeight: 1.8, scale: 1.8 / height,
            };

            releaseCharacter(character);
            character = {
                resources, skin, idleClip, walkClip, ticksPerSecond, pipeline, maskPipeline, vertices, indices, palette, transform, bindGroup, metadata,
                facing: 0, previous: null, seconds: 0, previousTick: null, previousClock: null, animation: 'idle',
            };
            canvasCameras.set(canvas, camera);

            return structuredClone(metadata);
        } catch (cause) {
            if (scopeOpen) {
                await device.popErrorScope();
            }

            for (const resource of resources) {
                resource.destroy();
            }

            throw cause;
        }
    }

    /**
     * Advances facing and animation state, then uploads the character's palette and world matrix.
     *
     * @param {RendererSnapshot} snapshot - Detached engine snapshot.
     * @param {{x: number, y: number}} position - Plane position for the character.
     */
    function writeCharacter(snapshot, position) {
        const c = character;
        const now = performance.now() / 1_000;

        if (Number.isFinite(snapshot.timeSeconds) && snapshot.timeSeconds >= 0) {
            c.seconds = snapshot.timeSeconds;
        } else if (c.previousClock !== null && (snapshot.tick === undefined || snapshot.tick !== c.previousTick)) {
            c.seconds += Math.max(0, Math.min(0.1, now - c.previousClock));
        }

        c.previousClock = now;
        c.previousTick = snapshot.tick;
        let dx = c.previous ? position.x - c.previous.x : 0;
        let dy = c.previous ? position.y - c.previous.y : 0;

        if (Math.hypot(dx, dy) < 1e-6 && Number.isFinite(snapshot.headingX) && Number.isFinite(snapshot.headingY)) {
            dx = snapshot.headingX;
            dy = snapshot.headingY;
        }

        if (Math.hypot(dx, dy) > 1e-6) {
            c.facing = Math.atan2(dy, dx);
        }

        c.previous = position;
        c.animation = snapshot.action > 0 ? 'walk' : 'idle';
        const palette = sampleSkin(c.skin, c.animation === 'walk' ? c.walkClip : c.idleClip, c.seconds, c.ticksPerSecond);

        device.queue.writeBuffer(c.palette, 0, palette);
        const scale = c.metadata.scale;
        const cosine = Math.cos(c.facing);
        const sine = Math.sin(c.facing);

        // Model x/z span ground, model y is elevation. Face local +z along heading.
        objectMatrix.set([sine * scale, -cosine * scale, 0, 0, 0, 0, scale, 0,
            cosine * scale, sine * scale, 0, 0, position.x, position.y, -c.skin.bounds.min[1] * scale, 1]);

        for (let col = 0; col < 4; col++) {
            for (let row = 0; row < 4; row++) {
                characterProjection[col * 4 + row] = projection[row] * objectMatrix[col * 4]
                    + projection[4 + row] * objectMatrix[col * 4 + 1]
                    + projection[8 + row] * objectMatrix[col * 4 + 2]
                    + projection[12 + row] * objectMatrix[col * 4 + 3];
            }
        }

        device.queue.writeBuffer(c.transform, 0, characterProjection);
    }

    /**
     * Submits the plane, resident source world tiles, moving character, then source UI.
     *
     * @param {RendererSnapshot} snapshot - Detached engine snapshot.
     * @returns {void} Executes one GPU queue submission.
     */
    function render(snapshot) {
        if (stopped || destroyed) {
            return;
        }

        const following = worldMode || !!character;
        const position = requirePosition(snapshot, following);

        resize();

        const box = fitBox(canvas.width, canvas.height);
        const action = typeof snapshot.action === 'number' && snapshot.action > 0 ? 1 : 0;

        camera = { x: position.x, y: position.y };
        const tilePixels = Math.min(canvas.width, canvas.height) / WORLD_SPAN;

        if (following) {
            canvasCameras.set(canvas, camera);
            projection.set([tilePixels / canvas.width, -tilePixels / (2 * canvas.height), -WORLD_DEPTH_XY, 0,
                -tilePixels / canvas.width, -tilePixels / (2 * canvas.height), -WORLD_DEPTH_XY, 0,
                0, 3 * tilePixels / canvas.height, -WORLD_DEPTH_Z, 0,
                (-camera.x + camera.y) * tilePixels / canvas.width,
                (camera.x + camera.y) * tilePixels / (2 * canvas.height),
                0.5 + (camera.x + camera.y) * WORLD_DEPTH_XY, 1]);
        } else {
            canvasCameras.delete(canvas);
        }

        if (character) {
            writeCharacter(snapshot, position);
        }

        writePlane(box, position, action);

        if (asset && !following) {
            writeSprite(box, position, asset);
        }

        const encoder = device.createCommandEncoder();
        const colourView = context.getCurrentTexture().createView();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view: colourView,
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
        });

        pass.setPipeline(planePipeline);
        pass.setBindGroup(0, viewBindGroup);
        pass.draw(3);

        if (asset && !following) {
            pass.setPipeline(artPipeline);
            pass.setBindGroup(0, spriteBindGroup);
            pass.draw(4);
        }

        pass.end();

        if (following && (character || worldLayer)) {
            if (!depthTexture || depthWidth !== canvas.width || depthHeight !== canvas.height) {
                depthTexture?.destroy();
                depthWidth = canvas.width;
                depthHeight = canvas.height;
                depthTexture = device.createTexture({ label: 'world-depth', size: [depthWidth, depthHeight], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT });
            }

            const worldPass = encoder.beginRenderPass({
                colorAttachments: [{ view: colourView, loadOp: 'load', storeOp: 'store' }],
                depthStencilAttachment: { view: depthTexture.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
            });

            worldView.camera = camera;
            worldView.tilePixels = tilePixels;
            worldView.width = canvas.width;
            worldView.height = canvas.height;
            worldView.worldItems = snapshot.worldItems ?? [];
            worldView.worldHighlights = snapshot.worldHighlights ?? [];
            worldView.characterZ = renderView.characterZ;

            const worldRendered = worldLayer?.render(worldPass, worldView) === true;

            if (worldRendered && onWorldOpaque) {
                onWorldOpaque(renderView);
            }

            if (character) {
                worldPass.setPipeline(character.pipeline);
                worldPass.setBindGroup(0, character.bindGroup);
                worldPass.setVertexBuffer(0, character.vertices);
                worldPass.setIndexBuffer(character.indices, 'uint32');
                worldPass.drawIndexed(character.skin.indices.length);
            }

            worldPass.end();
            worldLayer?.renderOutlines?.(encoder, colourView, worldView);

            // Source FBO renderInternal calls DoBuilding(true) after world actors, before UI.
            if (worldRendered && onWorldBuilding) {
                onWorldBuilding(renderView);
            }
        }

        if (gameUI) {
            const commands = gameUI.render();

            if (commands.length) {
                const uiPass = encoder.beginRenderPass({
                    colorAttachments: [{ view: colourView, loadOp: 'load', storeOp: 'store' }],
                    depthStencilAttachment: uiRenderer.stencilAttachment(canvas.width, canvas.height),
                });

                uiRenderer.render(uiPass, commands, canvas.width, canvas.height, drawScale);
                uiPass.end();
            }
        }

        device.queue.submit([encoder.finish()]);
        frames += 1;
    }

    /**
     * Returns detached, JSON-serialisable backend and asset evidence.
     *
     * @returns {RendererDiagnostics} Current renderer state.
     */
    function diagnostics() {
        let presentation = 'legacy-plane';

        if (character) {
            presentation = 'textured-skinned-character';
        } else if (worldMode) {
            presentation = 'navigation-debug-no-character';
        }

        let cameraEvidence = null;

        if (worldMode || character) {
            cameraEvidence = { ...camera, projection: 'isometric-64x32', verticalPixelsPerTile: 96 };
        }

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
            worldMode: worldMode || !!character,
            presentation,
            camera: cameraEvidence,
            character: character ? { ...structuredClone(character.metadata), animation: character.animation, animationSeconds: character.seconds, facingRadians: character.facing } : null,
            frames,
            textureBytes: (asset?.textureBytes ?? 0) + (character?.metadata.texture.textureBytes ?? 0),
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

        for (const ui of uiSessions) {
            ui.dispose();
        }

        uiSessions.clear();
        gameUI = null;
        uiRenderer.destroy();
        releaseCharacter(character);
        character = null;
        worldLayer?.destroy();
        worldLayer = null;
        depthTexture?.destroy();
        depthTexture = null;
        canvasCameras.delete(canvas);

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

    return Object.freeze({
        importImage, importCharacter, render, diagnostics, destroy, setWorldMode, setWorldLayer,
        createGameUI: newGameUI, initializeGameUI, setGameUI,
        /**
         * Return the committed UI session currently presented by this renderer.
         *
         * @returns {ReturnType<typeof createGameUI>|null} Active session, or null when withdrawn.
         */
        get gameUI() {
            return gameUI;
        },
        /**
         * Maps a pointer through the live camera or plane fit of this renderer.
         *
         * @param {number} clientX - Pointer x in viewport pixels.
         * @param {number} clientY - Pointer y in viewport pixels.
         * @returns {{x: number, y: number}} World position under the pointer.
         */
        worldFromCanvas: (clientX, clientY) => worldFromCanvas(canvas, clientX, clientY),
        /**
         * Shares the device, swap-chain format and linear sampler with an external world layer.
         *
         * @returns {{device: GPUDevice, format: string, sampler: GPUSampler}} Shared GPU resources.
         */
        gpuResources: () => ({ device, format, sampler }),
    });
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
 * @returns {{x: number, y: number}} Unbounded iso ground coordinates when camera follows; otherwise clamped [0,10].
 */
function worldFromCanvas(canvas, clientX, clientY) {
    const { left, top, width, height, scaleX, scaleY } = canvasContentBox(canvas);
    const plane = fitBox(width, height);
    const ndcX = ((clientX - left) / (width * scaleX)) * 2 - 1;
    const ndcY = 1 - ((clientY - top) / (height * scaleY)) * 2;
    const camera = canvasCameras.get(canvas);

    if (camera) {
        const tilePixels = Math.min(width, height) / WORLD_SPAN;
        const sx = ndcX * width / (2 * tilePixels);
        const sy = -ndcY * height / (2 * tilePixels);

        return { x: camera.x + sx + 2 * sy, y: camera.y - sx + 2 * sy };
    }

    return {
        x: clamp(WORLD_MIN + WORLD_SPAN * (ndcX - plane.minX) / (plane.maxX - plane.minX), WORLD_MIN, WORLD_MAX),
        y: clamp(WORLD_MIN + WORLD_SPAN * (plane.maxY - ndcY) / (plane.maxY - plane.minY), WORLD_MIN, WORLD_MAX),
    };
}

// The byte gate is exported for focused header tests only; the public surface stays the handle.
export { canvasContentBox, createRenderer, parsePngHeader, WORLD_DEPTH_XY, WORLD_DEPTH_Z, worldDepth, worldFromCanvas };
