import { normalizeDesktopShader, preprocessShaderUnit, instrumentAlphaTest, hasAlphaIdentifiers, alphaNames } from './glsl-compat.js';
import { SpriteAttributeState } from './sprite-attrib.js';

/**
 * Resolves an owned graphics handle and rejects foreign handles.
 *
 * @param {Map} map - Registry of owned browser objects indexed by handle.
 * @param {number} id - Numeric id argument for the declared operation.
 * @returns {unknown} Owned browser object, or the standard null sentinel.
 */
const object = (map, id) => {
    if (id === 0) {
        return null;
    }

    const value = map.get(id);

    if (!value) {
        throw new Error(`Unknown graphics handle ${id}`);
    }

    return value;
};

/**
 * Views Java byte storage without copying or moving its position.
 *
 * @param {unknown} value - Value returned by or passed to the underlying browser operation.
 * @returns {unknown} Result of the declared browser or runtime operation.
 */
const bytes = (value) => value === null ? null : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

/**
 * Views Java float storage without copying or moving its position.
 *
 * @param {unknown} value - Value returned by or passed to the underlying browser operation.
 * @returns {unknown} Result of the declared browser or runtime operation.
 */
const floats = (value) => new Float32Array(value.buffer, value.byteOffset, value.byteLength / 4);

/**
 * Real selected WebGL2 native facade. No desktop native pointers or libraries.
 *
 * @param {HTMLCanvasElement} canvas - Connected canvas owned by this browser qualification.
 * @param {function(string):void} report - Receives serialized original-code qualification results.
 * @returns {object} Owned native callbacks and lifecycle inspection functions.
 */
export function createSpriteNatives(canvas, report) {
    const gl = canvas.getContext('webgl2', { alpha: true, antialias: true, stencil: true, premultipliedAlpha: false, preserveDrawingBuffer: true });

    if (!gl) {
        throw new Error('WebGL2 unavailable');
    }

    let next = 1;
    let eventWidth = canvas.width;
    let eventHeight = canvas.height;
    let eventResized = false;
    let eventPumps = 0;
    const shaders = new Map();
    const programs = new Map();
    const textures = new Map();
    const buffers = new Map();
    // Scalar upload extents only; never retain Java arrays or pixel payloads.
    const textureExtents = new WeakMap();
    const bufferExtents = new WeakMap();
    const framebuffers = new Map();
    const renderbuffers = new Map();
    const locations = new Map();
    const shaderSources = new Map();
    const linkedStages = new Map();
    const shaderTypes = new Map();
    const sourceDefaults = new Map();
    const attached = new Map();
    const locationOwners = new Map();
    const clientArrays = new Set([32_884, 32_885, 32_886, 32_887, 32_888, 32_889, 33_879, 33_886]);
    const compatibility = { activeUnit: gl.TEXTURE0, legacyTexture: new Map(), lineSmoothEnabled: false, alphaEnabled: false, alphaFunction: 519, alphaReference: 0, error: 0 };
    const attributeState = new SpriteAttributeState(gl, buffers, textures, compatibility);
    const alphaPrograms = new WeakMap();
    /**
     * Excludes injected uniforms while retaining every original uniform on unsupported programs.
     *
     * @param {WebGLProgram} program - Actual linked program.
     * @returns {WebGLActiveInfo[]} Original active uniforms in driver order.
     */
    const visibleUniforms = (program) => {
        const info = alphaPrograms.get(program);
        const result = [];

        for (let index = 0; index < gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); index++) {
            const uniform = gl.getActiveUniform(program, index);

            if (!info?.supported || !alphaNames.slice(1).includes(uniform.name)) {
                result.push(uniform);
            }
        }

        return result;
    };

    /**
     * Applies current desktop alpha state before each actual draw without faking fixed-function rendering.
     */
    const applyAlpha = () => {
        const program = gl.getParameter(gl.CURRENT_PROGRAM);
        const info = program && alphaPrograms.get(program);

        if (compatibility.alphaEnabled && !info?.supported) {
            throw new Error(`Unsupported alpha-test draw: ${info?.reason || 'no instrumented fragment program'}`);
        }

        if (compatibility.alphaEnabled && gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)) {
            const type = gl.getFramebufferAttachmentParameter(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE);

            if (type !== gl.NONE && gl.getFramebufferAttachmentParameter(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE) === gl.FLOAT) {
                throw new Error('Unsupported alpha-test draw: floating-point color attachment');
            }
        }

        if (info?.supported) {
            gl.uniform1i(info.functionLocation, compatibility.alphaEnabled ? compatibility.alphaFunction : 519);
            gl.uniform1f(info.referenceLocation, compatibility.alphaReference);
        }
    };

    const diagnostics = [];
    /**
     * Records bounded compiler and graphics diagnostics.
     *
     * @param {string} text - Diagnostic or shader text.
     */
    const note = (text) => {
        diagnostics.push(text);

        if (diagnostics.length > 64) {
            diagnostics.shift();
        }
    };

    /**
     * Registers a real browser graphics object under an integer handle.
     *
     * @param {Map} map - Registry of owned browser objects indexed by handle.
     * @param {unknown} value - Value returned by or passed to the underlying browser operation.
     * @returns {number} Allocated integer handle, or zero for an absent object.
     */
    const add = (map, value) => {
        if (value === null) {
            return 0;
        }

        const id = next++;

        map.set(id, value);

        if (map === buffers || map === textures) {
            attributeState.remember(map === buffers ? 'buffer' : 'texture', id, value);
        }

        return id;
    };

    /**
     * Resolves a uniform handle, preserving the standard absent-location sentinel.
     *
     * @param {number} id - Numeric id argument for the declared operation.
     * @returns {unknown} Owned browser object, or the standard null sentinel.
     */
    const location = (id) => id === -1 ? null : object(locations, id);
    /**
     * Rejects operations after the actual graphics context is lost.
     */
    const ensure = () => {
        if (gl.isContextLost()) {
            throw new Error('WebGL context lost');
        }
    };

    /**
     * Adapts supported desktop GLSL syntax while retaining original shader operations.
     *
     * @param {number} id - Numeric id argument for the declared operation.
     * @param {string} source - Original shader source.
     * @returns {string} Shader source accepted by the supported ES dialect.
     */
    function translate(id, source) {
        const defaults = [];

        source = preprocessShaderUnit(source);

        sourceDefaults.set(id, defaults);
        const version = /^\s*#version\s+(330(?:\s+core)?|120)\s*$/m.exec(source);

        if (!version) {
            return source;
        }

        const legacy = version[1] === '120';

        source = `${source.slice(0, version.index)}#version 300 es\nprecision highp float;\nprecision highp int;\n${source.slice(version.index + version[0].length)}`;
        source = source.replaceAll(/^(\s*uniform\s+(float|int|vec[2-4])\s+([A-Z_a-z]\w*)\s*)=\s*([^;]+);/gm, (all, declaration, type, name, text) => {
            const literal = text.trim();
            const integer = type === 'int';

            if (type.startsWith('vec')) {
                const count = Number(type.slice(3));
                const match = new RegExp(`^${type}\\s*\\(([^()]*)\\)$`).exec(literal);

                if (!match) {
                    throw new Error(`Unsupported vector uniform initializer ${literal}`);
                }

                const parts = match[1].split(',').map((part) => part.trim());

                if (parts.length !== 1 && parts.length !== count) {
                    throw new Error('Invalid vector initializer arity');
                }

                const values = parts.map((part) => {
                    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(part)) {
                        throw new Error('Unsupported vector initializer component');
                    }

                    const value = Math.fround(Number(part));

                    if (!Number.isFinite(value)) {
                        throw new TypeError('Non-finite vector initializer');
                    }

                    return value;
                });

                defaults.push({ name, vector: parts.length === 1 ? Array.from({ length: count }, () => values[0]) : values });

                return `${declaration};`;
            }

            const pattern = integer ? /^[+-]?\d+$/ : /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/;

            if (!pattern.test(literal)) {
                throw new Error(`Unsupported GLSL uniform initializer ${literal}`);
            }

            let value = Number(literal);

            if (integer) {
                if (!Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) {
                    throw new Error('Integer uniform initializer out of range');
                }
            } else {
                value = Math.fround(value);
            }

            if (!Number.isFinite(value)) {
                throw new TypeError('Non-finite uniform initializer');
            }

            defaults.push({ name, integer, value });

            return `${declaration};`;
        });

        if (legacy) {
            if (shaderTypes.get(id) === gl.VERTEX_SHADER) {
                source = source.replaceAll(/^(\s*)attribute\b/gm, '$1in').replaceAll(/^(\s*)varying\b/gm, '$1out');
            } else if (shaderTypes.get(id) === gl.FRAGMENT_SHADER) {
                source = source.replaceAll(/^(\s*)varying\b/gm, '$1in');
            } else {
                throw new Error('Unsupported legacy shader stage');
            }
        }

        if (/\bgl_FragColor\b/.test(source)) {
            if (shaderTypes.get(id) !== gl.FRAGMENT_SHADER) {
                throw new Error('Fragment output in non-fragment shader');
            }

            source = source.replaceAll(/\bgl_FragColor\b/g, 'portFragmentOutput');
            const line = source.indexOf('\n');

            source = `${source.slice(0, line + 1)}layout(location=0) out highp vec4 portFragmentOutput;\n${source.slice(line + 1)}`;
        }

        return source;
    }

    let fboQualified;

    /**
     * Qualifies real color and depth attachments before exposing framebuffer support.
     *
     * @returns {boolean} Whether the actual color and depth framebuffer is complete.
     */
    function framebufferSupported() {
        if (fboQualified !== undefined) {
            return fboQualified;
        }

        ensure();
        const savedTexture = gl.getParameter(gl.TEXTURE_BINDING_2D);
        const savedRead = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
        const savedDraw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
        const color = gl.createTexture();
        const depth = gl.createTexture();
        const fbo = gl.createFramebuffer();

        try {
            gl.bindTexture(gl.TEXTURE_2D, color);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.bindTexture(gl.TEXTURE_2D, depth);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT16, 1, 1, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_SHORT, null);
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
            fboQualified = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
            note(`color-depth framebuffer qualification ${fboQualified}`);

            return fboQualified;
        } finally {
            gl.bindTexture(gl.TEXTURE_2D, savedTexture);
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, savedRead);
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, savedDraw);
            gl.deleteFramebuffer(fbo);
            gl.deleteTexture(color);
            gl.deleteTexture(depth);
        }
    }

    /**
     * Submits complete indexed desktop quads as winding-preserving triangle pairs.
     * The fourth vertex provokes both triangles. Original GPU storage is read only.
     *
     * @param {number} count - Original number of indices, including any incomplete tail.
     * @param {number} type - Original unsigned index encoding.
     * @param {number} offset - Byte offset into the original bound element buffer.
     * @param {number[]} range - Optional original inclusive index range.
     */
    function drawIndexedQuads(count, type, offset, range) {
        const Index = new Map([[gl.UNSIGNED_BYTE, Uint8Array], [gl.UNSIGNED_SHORT, Uint16Array], [gl.UNSIGNED_INT, Uint32Array]]).get(type);

        if (!Index) {
            compatibility.error ||= gl.INVALID_ENUM;

            return;
        }

        if (count < 0 || (range && range[1] < range[0])) {
            compatibility.error ||= gl.INVALID_VALUE;

            return;
        }

        // Delegate empty draws and lost-context behavior to the actual driver.
        if (count === 0 || gl.isContextLost()) {
            if (range) {
                gl.drawRangeElements(gl.TRIANGLES, range[0], range[1], 0, type, offset);
            } else {
                gl.drawElements(gl.TRIANGLES, 0, type, offset);
            }

            return;
        }

        const original = gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING);
        const width = Index.BYTES_PER_ELEMENT;

        if (!original || offset < 0 || offset % width !== 0 || offset + count * width > gl.getBufferParameter(gl.ELEMENT_ARRAY_BUFFER, gl.BUFFER_SIZE)) {
            compatibility.error ||= gl.INVALID_OPERATION;

            return;
        }

        let source;
        let triangles;

        try {
            source = new Index(count);
            /* Widen to avoid interpreting valid byte/short maximum indices as
               WebGL2's mandatory fixed primitive-restart sentinel. */
            triangles = new Uint32Array(Math.floor(count / 4) * 6);
        } catch (error) {
            if (!(error instanceof RangeError)) {
                throw error;
            }

            compatibility.error ||= gl.OUT_OF_MEMORY;

            return;
        }

        gl.getBufferSubData(gl.ELEMENT_ARRAY_BUFFER, offset, source);

        for (let input = 0, output = 0; input + 3 < count; input += 4, output += 6) {
            const a = source[input];
            const b = source[input + 1];
            const c = source[input + 2];
            const d = source[input + 3];

            triangles.set([a, b, d, b, c, d], output);
        }

        const temporary = gl.createBuffer();

        if (!temporary) {
            compatibility.error ||= gl.OUT_OF_MEMORY;

            return;
        }

        try {
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, temporary);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, triangles, gl.STREAM_DRAW);

            if (range) {
                gl.drawRangeElements(gl.TRIANGLES, range[0], range[1], triangles.length, gl.UNSIGNED_INT, 0);
            } else {
                gl.drawElements(gl.TRIANGLES, triangles.length, gl.UNSIGNED_INT, 0);
            }
        } finally {
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, original);
            gl.deleteBuffer(temporary);
        }
    }

    const api = {
        framebufferSupported,
        /**
         * Yields to the real DOM event loop and observes canvas resize state.
         */
        processMessages: async () => {
            ensure();
            await new Promise(requestAnimationFrame);
            eventResized = eventWidth !== canvas.width || eventHeight !== canvas.height;
            eventWidth = canvas.width;
            eventHeight = canvas.height;

            if (eventPumps++ === 0) {
                note('actual DOM display event pump');
            }
        },
        /**
         * Performs the is active operation for the owned browser runtime.
         *
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        isActive: () => canvas.isConnected && !document.hidden && document.hasFocus() && document.activeElement === canvas,
        /**
         * Performs the is visible operation for the owned browser runtime.
         *
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        isVisible: () => canvas.isConnected && !document.hidden && getComputedStyle(canvas).display !== 'none' && getComputedStyle(canvas).visibility !== 'hidden' && canvas.getBoundingClientRect().width > 0 && canvas.getBoundingClientRect().height > 0,
        /**
         * Performs the is close requested operation for the owned browser runtime.
         *
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        isCloseRequested: () => !canvas.isConnected,
        /**
         * Performs the was resized operation for the owned browser runtime.
         *
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        wasResized: () => eventResized,
        /**
         * Performs the get x operation for the owned browser runtime.
         *
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        getX: () => Math.round(canvas.getBoundingClientRect().x),
        /**
         * Performs the get y operation for the owned browser runtime.
         *
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        getY: () => Math.round(canvas.getBoundingClientRect().y),
        initialize: ensure,
        /**
         * Performs the context created operation for the owned browser runtime.
         *
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        contextCreated: () => !gl.isContextLost(),
        /**
         * Reads fullscreen from the real document, including a fullscreen canvas ancestor.
         *
         * @returns {boolean} Actual fullscreen ownership.
         */
        isFullscreen: () => {
            const element = canvas.ownerDocument.fullscreenElement;

            return element !== null && element.contains(canvas);
        },
        adoptDisplay: ensure,
        /**
         * Resizes the real drawing surface, avoiding destructive same-size assignments.
         *
         * @param {number} width - Validated width.
         * @param {number} height - Validated height.
         * @returns {boolean} Whether the real drawing buffer accepted the requested dimensions.
         */
        resizeDisplay: (width, height) => {
            const previousWidth = canvas.width;
            const previousHeight = canvas.height;

            if (canvas.width !== width) {
                canvas.width = width;
            }

            if (canvas.height !== height) {
                canvas.height = height;
            }

            if (gl.drawingBufferWidth !== width || gl.drawingBufferHeight !== height) {
                canvas.width = previousWidth;
                canvas.height = previousHeight;

                return false;
            }

            return true;
        },
        /**
         * Destroys the actual owned graphics context and observes its loss event.
         *
         * @returns {Promise<void>} Actual context destruction.
         */
        destroyDisplay: async () => {
            if (gl.isContextLost()) {
                return;
            }

            const extension = gl.getExtension('WEBGL_lose_context');

            await new Promise((resolve) => {
                canvas.addEventListener('webglcontextlost', resolve, { once: true });
                extension.loseContext();
            });
        },
        /**
         * Updates the title of the document which owns this graphics surface.
         *
         * @param {string} title - Original vendor window title.
         */
        setTitle: (title) => {
            canvas.ownerDocument.title = title;
        },
        /**
         * Performs the resize operation for the owned browser runtime.
         *
         * @param {number} w - Numeric w argument for the declared operation.
         * @param {number} h - Numeric h argument for the declared operation.
         */
        resize: (w, h) => {
            canvas.width = w;
            canvas.height = h;
        },
        /**
         * Performs the surface width operation for the owned browser runtime.
         *
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        surfaceWidth: () => gl.drawingBufferWidth,
        /**
         * Performs the surface height operation for the owned browser runtime.
         *
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        surfaceHeight: () => gl.drawingBufferHeight,
        /**
         * Performs the present operation for the owned browser runtime.
         *
         * @param {boolean} vsync - Requested boolean option.
         */
        present: async (vsync) => {
            ensure();
            gl.flush();

            if (vsync) {
                await new Promise(requestAnimationFrame);
            }
        }, report,
        /**
         * Performs the buffer create operation for the owned browser runtime.
         *
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        bufferCreate: () => add(buffers, gl.createBuffer()),
        /**
         * Performs the buffer bind operation for the owned browser runtime.
         *
         * @param {number} target - Numeric target argument for the declared operation.
         * @param {number} id - Numeric id argument for the declared operation.
         */
        bufferBind: (target, id) => {
            gl.bindBuffer(target, object(buffers, id));
            attributeState.collect();
        },
        /**
         * Performs the buffer delete operation for the owned browser runtime.
         *
         * @param {number} id - Numeric id argument for the declared operation.
         */
        bufferDelete: (id) => {
            attributeState.deleteBuffer(id);
        },
        /**
         * Performs the buffer is operation for the owned browser runtime.
         *
         * @param {number} id - Numeric id argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        bufferIs: (id) => buffers.has(id) && gl.isBuffer(buffers.get(id)),
        /**
         * Performs the buffer data size operation for the owned browser runtime.
         *
         * @param {number} target - Numeric target argument for the declared operation.
         * @param {number} size - Numeric size argument for the declared operation.
         * @param {number} usage - Numeric usage argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        bufferDataSize: (target, size, usage) => {
            gl.bufferData(target, size, usage);
            const binding = gl.getParameter(target === gl.ARRAY_BUFFER ? gl.ARRAY_BUFFER_BINDING : gl.ELEMENT_ARRAY_BUFFER_BINDING);

            if (binding) {
                bufferExtents.set(binding, size);
            }

            return undefined;
        },
        /**
         * Performs the buffer data bytes operation for the owned browser runtime.
         *
         * @param {number} target - Numeric target argument for the declared operation.
         * @param {Uint8Array|Float32Array|Int32Array|DataView} data - Java array storage exposed by the browser runtime.
         * @param {number} usage - Numeric usage argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        bufferDataBytes: (target, data, usage) => {
            gl.bufferData(target, bytes(data), usage);
            const binding = gl.getParameter(target === gl.ARRAY_BUFFER ? gl.ARRAY_BUFFER_BINDING : gl.ELEMENT_ARRAY_BUFFER_BINDING);

            if (binding) {
                bufferExtents.set(binding, data.byteLength);
            }

            return undefined;
        },
        /**
         * Performs the buffer upload operation for the owned browser runtime.
         *
         * @param {number} target - Numeric target argument for the declared operation.
         * @param {number} offset - Numeric offset argument for the declared operation.
         * @param {Uint8Array|Float32Array|Int32Array|DataView} data - Java array storage exposed by the browser runtime.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        bufferUpload: (target, offset, data) => gl.bufferSubData(target, offset, bytes(data)),
        /**
         * Performs the buffer read operation for the owned browser runtime.
         *
         * @param {number} target - Numeric target argument for the declared operation.
         * @param {number} offset - Numeric offset argument for the declared operation.
         * @param {Uint8Array|Float32Array|Int32Array|DataView} data - Java array storage exposed by the browser runtime.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        bufferRead: (target, offset, data) => gl.getBufferSubData(target, offset, bytes(data)),
        /**
         * Performs the buffer parameter operation for the owned browser runtime.
         *
         * @param {number} target - Numeric target argument for the declared operation.
         * @param {number} name - Numeric name argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        bufferParameter: (target, name) => {
            const value = gl.getBufferParameter(target, name);

            if (typeof value !== 'number') {
                throw new TypeError('Unsupported buffer parameter');
            }

            return value;
        },
        /**
         * Performs the raw error operation for the owned browser runtime.
         *
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        rawError: () => {
            const result = compatibility.error;

            compatibility.error = 0;

            return result || gl.getError();
        },
        /**
         * Returns actual WebGL vendor/version information required by original Core.init.
         *
         * @param {number} name - Original GL string selector.
         * @returns {string|null} Actual implementation information.
         */
        glGetString: (name) => {
            if (name === 0x1F_03) {
                return gl.getSupportedExtensions().join(' ');
            }

            if ([gl.VENDOR, gl.RENDERER, gl.VERSION, gl.SHADING_LANGUAGE_VERSION].includes(name)) {
                return gl.getParameter(name);
            }

            compatibility.error ||= gl.INVALID_ENUM;

            return null;
        },
        /**
         * Performs the integer state operation for the owned browser runtime.
         *
         * @param {number} name - Numeric name argument for the declared operation.
         * @returns {number} Actual scalar state or the corresponding owned object handle.
         */
        integerState: (name) => {
            if (name === 2_848) {
                return Number(compatibility.lineSmoothEnabled);
            }

            if (clientArrays.has(name)) {
                return 0;
            }

            if (name === 0x0B_B0) {
                return attributeState.server.length;
            }

            if (name === 0x0D_35) {
                return attributeState.maximum;
            }

            if (name === 0x0B_C1) {
                return compatibility.alphaFunction;
            }

            if (name === 0x0B_B1) {
                return attributeState.client.length;
            }

            if (name === 0x0D_3B) {
                return attributeState.maximum;
            }

            const value = gl.getParameter(name);

            if (typeof value === 'number') {
                return value;
            }

            if (typeof value === 'boolean') {
                return Number(value);
            }

            if (value === null) {
                return 0;
            }

            for (const map of [programs, textures, buffers, framebuffers]) {
                for (const [id, item] of map) {
                    if (item === value) {
                        return id;
                    }
                }
            }

            const retained = attributeState.objectId(value);

            if (retained !== undefined) {
                return retained;
            }

            throw new Error(`Unsupported scalar graphics query ${name}`);
        },
        /**
         * Performs the vertex pointer operation for the owned browser runtime.
         *
         * @param {number} index - Numeric index argument for the declared operation.
         * @param {number} size - Numeric size argument for the declared operation.
         * @param {number} type - Numeric type argument for the declared operation.
         * @param {boolean} normalized - Requested boolean option.
         * @param {number} stride - Numeric stride argument for the declared operation.
         * @param {number} offset - Numeric offset argument for the declared operation.
         */
        vertexPointer: (index, size, type, normalized, stride, offset) => {
            gl.vertexAttribPointer(index, size, type, normalized, stride, offset);
            attributeState.collect();
        },
        /**
         * Performs the draw range operation for the owned browser runtime.
         *
         * @param {number} mode - Numeric mode argument for the declared operation.
         * @param {number} first - Numeric first argument for the declared operation.
         * @param {number} last - Numeric last argument for the declared operation.
         * @param {number} count - Numeric count argument for the declared operation.
         * @param {number} type - Numeric type argument for the declared operation.
         * @param {number} offset - Numeric offset argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        drawRange: (mode, first, last, count, type, offset) => {
            applyAlpha();

            if (mode === 7) {
                return drawIndexedQuads(count, type, offset, [first >>> 0, last >>> 0]);
            }

            return gl.drawRangeElements(mode, first, last, count, type, offset);
        },
        /**
         * Performs the draw elements operation for the owned browser runtime.
         *
         * @param {number} mode - Numeric mode argument for the declared operation.
         * @param {number} count - Numeric count argument for the declared operation.
         * @param {number} type - Numeric type argument for the declared operation.
         * @param {number} offset - Numeric offset argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        drawElements: (mode, count, type, offset) => {
            applyAlpha();

            if (mode === 7) {
                return drawIndexedQuads(count, type, offset);
            }

            return gl.drawElements(mode, count, type, offset);
        },
        /**
         * Identifies an unrepresentable desktop vertex after ordinary input checks.
         * Java supplies the real UnsupportedOperationException before any draw.
         *
         * @param {number} count - Original unsigned-int index count.
         * @param {number} offset - Original index buffer byte offset.
         * @returns {boolean} Whether a complete quad uses the reserved browser index.
         */
        unsupportedQuadIndex: (count, offset) => {
            if (count < 4 || offset < 0 || offset % 4 !== 0 || gl.isContextLost() || !gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING)) {
                return false;
            }

            if (offset + count * 4 > gl.getBufferParameter(gl.ELEMENT_ARRAY_BUFFER, gl.BUFFER_SIZE)) {
                return false;
            }

            const complete = Math.floor(count / 4) * 4;
            const source = new Uint32Array(Math.min(complete, 4_096));

            for (let index = 0; index < complete; index += source.length) {
                const slice = source.subarray(0, Math.min(source.length, complete - index));

                gl.getBufferSubData(gl.ELEMENT_ARRAY_BUFFER, offset + index * 4, slice);

                if (slice.includes(0xFF_FF_FF_FF)) {
                    return true;
                }
            }

            return false;
        },
        /**
         * Executes the selected glEnableVertexAttribArray operation against the actual WebGL context.
         *
         * @param {number} index - Numeric index argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glEnableVertexAttribArray: (index) => gl.enableVertexAttribArray(index),
        /**
         * Executes the selected glDisableVertexAttribArray operation against the actual WebGL context.
         *
         * @param {number} index - Numeric index argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glDisableVertexAttribArray: (index) => gl.disableVertexAttribArray(index),
        /**
         * Executes the selected glActiveTexture operation against the actual WebGL context.
         *
         * @param {number} unit - Numeric unit argument for the declared operation.
         */
        glActiveTexture: (unit) => {
            gl.activeTexture(unit);

            if (unit >= gl.TEXTURE0 && unit < gl.TEXTURE0 + gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS)) {
                compatibility.activeUnit = unit;
            }
        },
        /**
         * Executes the selected glEnable operation against the actual WebGL context.
         *
         * @param {number} cap - Numeric cap argument for the declared operation.
         */
        glEnable: (cap) => {
            if (cap === 2_848) {
                compatibility.lineSmoothEnabled = true;

                return;
            }

            if (cap === 3_008) {
                compatibility.alphaEnabled = true;

                return;
            }

            if (cap === gl.TEXTURE_2D) {
                compatibility.legacyTexture.set(compatibility.activeUnit, true);
            } else {
                gl.enable(cap);
            }
        },
        /**
         * Executes the selected glDisable operation against the actual WebGL context.
         *
         * @param {number} cap - Numeric cap argument for the declared operation.
         */
        glDisable: (cap) => {
            if (cap === 2_848) {
                compatibility.lineSmoothEnabled = false;

                return;
            }

            if (cap === 3_008) {
                compatibility.alphaEnabled = false;

                return;
            }

            if (cap === gl.TEXTURE_2D) {
                compatibility.legacyTexture.set(compatibility.activeUnit, false);
            } else {
                gl.disable(cap);
            }
        },
        /**
         * Executes the selected glIsEnabled operation against the actual WebGL context.
         *
         * @param {number} cap - Numeric cap argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glIsEnabled: (cap) => {
            if (cap === 2_848) {
                return compatibility.lineSmoothEnabled;
            }

            if (clientArrays.has(cap)) {
                return false;
            }

            if (cap === 3_008) {
                return compatibility.alphaEnabled;
            }

            return cap === gl.TEXTURE_2D ? compatibility.legacyTexture.get(compatibility.activeUnit) === true : gl.isEnabled(cap);
        },
        /**
         * Retains the qualified default MODULATE invariant;
         invalid enums do not change GPU state.
         *
         * @param {number} target - Original texture environment selector.
         * @param {number} name - Original parameter name.
         * @param {number} value - Qualified MODULATE value, or invalid enum to report.
         */
        textureEnvironment: (target, name, value) => {
            if (target !== 8_960 || name !== 8_704 || value !== 8_448) {
                compatibility.error ||= gl.INVALID_ENUM;
            }
        },
        /**
         * Preserves filled rasterization without sending unavailable desktop enums to WebGL.
         *
         * @param {number} face - Original front, back or both enum.
         * @param {number} mode - Validated fill mode, or an invalid enum to report.
         */
        polygonMode: (face, mode) => {
            if (![1_028, 1_029, 1_032].includes(face) || mode !== 6_914) {
                compatibility.error ||= gl.INVALID_ENUM;
            }
        },
        /**
         * Retains the desktop comparison and normalized-buffer reference;
         invalid enums preserve state.
         *
         * @param {number} comparison - One of the eight original alpha comparison enums.
         * @param {number} reference - Reference value from the original float ABI.
         */
        glAlphaFunc: (comparison, reference) => {
            if (!Number.isInteger(comparison) || comparison < 512 || comparison > 519) {
                compatibility.error ||= gl.INVALID_ENUM;

                return;
            }

            compatibility.alphaFunction = comparison;
            compatibility.alphaReference = Math.fround(Math.min(1, Math.max(0, reference)));
        },
        /**
         * Executes the selected glBlendFunc operation against the actual WebGL context.
         *
         * @param {number} s - Numeric s argument for the declared operation.
         * @param {number} d - Numeric d argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glBlendFunc: (s, d) => gl.blendFunc(s, d),
        /**
         * Executes the selected glBlendFuncSeparate operation against the actual WebGL context.
         *
         * @param {number} a - Numeric a argument for the declared operation.
         * @param {number} b - Numeric b argument for the declared operation.
         * @param {number} c - Numeric c argument for the declared operation.
         * @param {number} d - Numeric d argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glBlendFuncSeparate: (a, b, c, d) => gl.blendFuncSeparate(a, b, c, d),
        /**
         * Executes the selected glBlendEquation operation against the actual WebGL context.
         *
         * @param {number} mode - Numeric mode argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glBlendEquation: (mode) => gl.blendEquation(mode),
        /**
         * Executes the selected glViewport operation against the actual WebGL context.
         *
         * @param {number} x - Numeric x argument for the declared operation.
         * @param {number} y - Numeric y argument for the declared operation.
         * @param {number} w - Numeric w argument for the declared operation.
         * @param {number} h - Numeric h argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glViewport: (x, y, w, h) => gl.viewport(x, y, w, h),
        /**
         * Keeps conventional arrays disabled independently of generic shader attributes.
         *
         * @param {number} array - Original client-array enum.
         */
        glDisableClientState: (array) => {
            if (!clientArrays.has(array)) {
                compatibility.error ||= gl.INVALID_ENUM;
            }
        },
        /**
         * Checks the actual draw surface before a desktop smooth-line draw.
         *
         * @param {number} mode - Original primitive enum.
         * @returns {boolean} Whether smooth coverage needs an unimplemented single-sample path.
         */
        unsupportedSmoothLine: (mode) => compatibility.lineSmoothEnabled && [1, 2, 3].includes(mode) && gl.getParameter(gl.SAMPLE_BUFFERS) === 0,
        /**
         * Sets actual implementation-supported line width.
         *
         * @param {number} width - Original requested width.
         */
        glLineWidth: (width) => {
            gl.lineWidth(width);
        },
        /**
         * Sets actual front-facing winding and retains driver validation.
         *
         * @param {number} winding - Original clockwise or counterclockwise enum.
         */
        glFrontFace: (winding) => {
            gl.frontFace(winding);
        },
        /**
         * Saves the actual groups selected by an original desktop attribute mask.
         *
         * @param {number} mask - Defined desktop group bits.
         */
        pushAttributes: (mask) => {
            attributeState.pushServer(mask);
        },
        /** Restores only server groups selected by the matching push. */
        glPopAttrib: () => {
            attributeState.popServer();
        },
        /**
         * Captures original client pixel-store and generic vertex-array state.
         *
         * @param {number} mask - Original desktop client attribute mask.
         */
        glPushClientAttrib: (mask) => {
            attributeState.pushClient(mask);
        },
        /** Restores only the matching client groups. */
        glPopClientAttrib: () => {
            attributeState.popClient();
        },
        /**
         * Executes the selected glClearColor operation against the actual WebGL context.
         *
         * @param {number} r - Numeric r argument for the declared operation.
         * @param {number} g - Numeric g argument for the declared operation.
         * @param {number} b - Numeric b argument for the declared operation.
         * @param {number} a - Numeric a argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glClearColor: (r, g, b, a) => gl.clearColor(r, g, b, a),
        /**
         * Executes the selected glClear operation against the actual WebGL context.
         *
         * @param {number} mask - Numeric mask argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        /* Desktop clears of an absent accumulation buffer have no effect;
           WebGL has none. */
        /**
         * Clears supported buffers while ignoring the absent accumulation buffer.
         *
         * @param {number} mask - Original clear mask.
         * @returns {undefined} Completion of the actual clear operation.
         */
        glClear: (mask) => gl.clear(mask & ~0x02_00),
        /**
         * Sets both faces' actual stencil write masks.
         *
         * @param {number} mask - Original unsigned stencil bit mask.
         * @returns {undefined} Completion of the WebGL state update.
         */
        glStencilMask: (mask) => gl.stencilMask(mask),
        /**
         * Sets both faces' stencil comparison; WebGL retains invalid-enum errors.
         *
         * @param {number} comparison - Original comparison enum.
         * @param {number} reference - Original stencil reference value.
         * @param {number} mask - Original unsigned comparison bit mask.
         * @returns {undefined} Completion of the WebGL state update.
         */
        glStencilFunc: (comparison, reference, mask) => gl.stencilFunc(comparison, reference, mask),
        /**
         * Sets actual stencil operations for stencil failure, depth failure and depth pass.
         *
         * @param {number} fail - Stencil-test failure operation.
         * @param {number} depthFail - Depth-test failure operation.
         * @param {number} depthPass - Depth-test pass operation.
         * @returns {undefined} Completion of the WebGL state update.
         */
        glStencilOp: (fail, depthFail, depthPass) => gl.stencilOp(fail, depthFail, depthPass),
        /**
         * Selects the actual color channels written by rendering and clears.
         *
         * @param {boolean} red - Whether to write red.
         * @param {boolean} green - Whether to write green.
         * @param {boolean} blue - Whether to write blue.
         * @param {boolean} alpha - Whether to write alpha.
         * @returns {undefined} Completion of the WebGL state update.
         */
        glColorMask: (red, green, blue, alpha) => gl.colorMask(red, green, blue, alpha),
        /**
         * Sets the actual depth clear value, including OpenGL's unit-interval clamping.
         *
         * @param {number} depth - Original desktop double-precision clear value.
         * @returns {undefined} Completion of the WebGL state update.
         */
        glClearDepth: (depth) => gl.clearDepth(depth),
        /**
         * Applies the ordered finite depth mapping validated and clamped by Java.
         *
         * @param {number} near - Clamped near endpoint.
         * @param {number} far - Clamped far endpoint.
         * @returns {undefined} Completion of the WebGL state update.
         */
        depthRange: (near, far) => gl.depthRange(near, far),
        /**
         * Generates real mip levels for the currently bound browser texture.
         *
         * @param {number} target - Original texture target;
         driver validates target and format.
         * @returns {undefined} Completion of actual mip generation.
         */
        glGenerateMipmap: (target) => gl.generateMipmap(target),
        /**
         * Sets the actual scissor box;
         * WebGL retains invalid negative-size errors.
         *
         * @param {number} x - Left edge in framebuffer pixels.
         * @param {number} y - Bottom edge in framebuffer pixels.
         * @param {number} width - Scissor width.
         * @param {number} height - Scissor height.
         * @returns {undefined} Completion of the WebGL state update.
         */
        glScissor: (x, y, width, height) => gl.scissor(x, y, width, height),
        /**
         * Sets the actual depth comparison function;
         * WebGL retains invalid-enum errors.
         *
         * @param {number} comparison - Original OpenGL depth comparison enum.
         * @returns {undefined} Completion of the WebGL state update.
         */
        glDepthFunc: (comparison) => gl.depthFunc(comparison),
        /**
         * Sets whether actual depth-buffer writes are enabled.
         *
         * @param {boolean} enabled - Original depth write mask.
         * @returns {undefined} Completion of the WebGL state update.
         */
        glDepthMask: (enabled) => gl.depthMask(enabled),
        /**
         * Executes the selected glDrawArrays operation against the actual WebGL context.
         *
         * @param {number} mode - Numeric mode argument for the declared operation.
         * @param {number} first - Numeric first argument for the declared operation.
         * @param {number} count - Numeric count argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glDrawArrays: (mode, first, count) => {
            applyAlpha();

            return gl.drawArrays(mode, first, count);
        },
        /**
         * Executes the selected glCreateShader operation against the actual WebGL context.
         *
         * @param {number} type - Numeric type argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glCreateShader: (type) => {
            const id = add(shaders, gl.createShader(type));

            shaderTypes.set(id, type);

            return id;
        },
        /**
         * Performs the shader text operation for the owned browser runtime.
         *
         * @param {number} id - Numeric id argument for the declared operation.
         * @param {string} text - Diagnostic or shader text.
         */
        shaderText: (id, text) => {
            const source = translate(id, String(text));

            shaderSources.set(id, source);
            gl.shaderSource(object(shaders, id), normalizeDesktopShader(source, shaderTypes.get(id) === gl.VERTEX_SHADER ? 'vertex' : 'fragment'));
        },
        /**
         * Executes the selected glCompileShader operation against the actual WebGL context.
         *
         * @param {number} id - Numeric id argument for the declared operation.
         */
        glCompileShader: (id) => {
            gl.compileShader(object(shaders, id));
            note(`compile ${id} ${gl.getShaderParameter(object(shaders, id), gl.COMPILE_STATUS)} ${gl.getShaderInfoLog(object(shaders, id))}`);
        },
        /**
         * Executes the selected glGetShaderi operation against the actual WebGL context.
         *
         * @param {number} id - Numeric id argument for the declared operation.
         * @param {number} name - Numeric name argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glGetShaderi: (id, name) => name === 0x8B_84 ? (gl.getShaderInfoLog(object(shaders, id)) || '').length + 1 : Number(gl.getShaderParameter(object(shaders, id), name)),
        /**
         * Executes the selected glGetShaderInfoLog operation against the actual WebGL context.
         *
         * @param {number} id - Numeric id argument for the declared operation.
         * @param {number} length - Numeric length argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glGetShaderInfoLog: (id, length) => (gl.getShaderInfoLog(object(shaders, id)) || '').slice(0, Math.max(0, length - 1)),
        /**
         * Executes the selected glDeleteShader operation against the actual WebGL context.
         *
         * @param {number} id - Numeric id argument for the declared operation.
         */
        glDeleteShader: (id) => {
            gl.deleteShader(object(shaders, id));
        },
        /**
         * Executes the selected glCreateProgram operation against the actual WebGL context.
         *
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glCreateProgram: () => add(programs, gl.createProgram()),
        /**
         * Executes the selected glAttachShader operation against the actual WebGL context.
         *
         * @param {number} program - Numeric program argument for the declared operation.
         * @param {number} shader - Numeric shader argument for the declared operation.
         */
        glAttachShader: (program, shader) => {
            object(programs, program);
            object(shaders, shader);

            if (!attached.has(program)) {
                attached.set(program, []);
            }

            if (attached.get(program).includes(shader)) {
                throw new Error('Duplicate shader attachment');
            }

            attached.get(program).push(shader);
        },
        /**
         * Executes the selected glDetachShader operation against the actual WebGL context.
         *
         * @param {number} program - Numeric program argument for the declared operation.
         * @param {number} shader - Numeric shader argument for the declared operation.
         */
        glDetachShader: (program, shader) => {
            object(programs, program);
            object(shaders, shader);
            const list = attached.get(program) || [];

            if (!list.includes(shader)) {
                throw new Error('Shader not attached');
            }

            attached.set(program, list.filter((id) => id !== shader));
        },
        /**
         * Performs the bind attribute operation for the owned browser runtime.
         *
         * @param {number} program - Numeric program argument for the declared operation.
         * @param {number} index - Numeric index argument for the declared operation.
         * @param {string} name - Original shader symbol name.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        bindAttribute: (program, index, name) => gl.bindAttribLocation(object(programs, program), index, String(name)),
        /**
         * Performs the attribute location operation for the owned browser runtime.
         *
         * @param {number} program - Numeric program argument for the declared operation.
         * @param {string} name - Original shader symbol name.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        attributeLocation: (program, name) => gl.getAttribLocation(object(programs, program), String(name)),
        /**
         * Executes the selected glLinkProgram operation against the actual WebGL context.
         *
         * @param {number} id - Numeric id argument for the declared operation.
         */
        glLinkProgram: (id) => {
            const program = object(programs, id);

            for (const shader of linkedStages.get(id) || []) {
                gl.detachShader(program, shader);
                gl.deleteShader(shader);
            }

            let alphaInfo = { supported: false, reason: 'No fragment stage' };
            const stages = [];

            linkedStages.set(id, stages);
            const groups = new Map();

            for (const shader of attached.get(id) || []) {
                const type = shaderTypes.get(shader);

                if (!groups.has(type)) {
                    groups.set(type, []);
                }

                groups.get(type).push(shaderSources.get(shader));
            }

            const alphaCollision = [...groups.values()].flat().some(hasAlphaIdentifiers);

            for (const [type, sources] of groups) {
                let source = sources.join('\n');

                if (sources.length > 1) {
                    source = `#version 300 es\nprecision highp float;\nprecision highp int;\n${source.replaceAll(/^\s*#version[^\n]*$/gm, '').replaceAll(/^\s*precision\s+highp\s+(float|int)\s*;/gm, '')}`;
                }

                source = normalizeDesktopShader(source, type === gl.VERTEX_SHADER ? 'vertex' : 'fragment');

                if (type === gl.FRAGMENT_SHADER) {
                    alphaInfo = alphaCollision ? { source, supported: false, reason: 'Program identifier collides with alpha adapter' } : instrumentAlphaTest(source);
                    source = alphaInfo.source;
                }

                const shader = gl.createShader(type);

                gl.shaderSource(shader, source);
                gl.compileShader(shader);
                note(`composed compile ${type} ${gl.getShaderParameter(shader, gl.COMPILE_STATUS)} ${gl.getShaderInfoLog(shader)}`);
                gl.attachShader(program, shader);
                stages.push(shader);
            }

            gl.linkProgram(program);
            note(`link ${id} ${gl.getProgramParameter(program, gl.LINK_STATUS)} ${gl.getProgramInfoLog(program)}`);

            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
                return;
            }

            alphaPrograms.set(program, {
                ...alphaInfo,
                functionLocation: gl.getUniformLocation(program, alphaNames[1]),
                referenceLocation: gl.getUniformLocation(program, alphaNames[2]),
            });
            const previous = gl.getParameter(gl.CURRENT_PROGRAM);

            gl.useProgram(program);

            try {
                for (const shader of attached.get(id) || []) {
                    for (const init of sourceDefaults.get(shader) || []) {
                        const where = gl.getUniformLocation(program, init.name);

                        if (where === null) {
                            continue;
                        }

                        if (init.vector) {
                            gl[`uniform${init.vector.length}fv`](where, new Float32Array(init.vector));
                        } else if (init.integer) {
                            gl.uniform1i(where, init.value);
                        } else {
                            gl.uniform1f(where, init.value);
                        }
                    }
                }
            } finally {
                gl.useProgram(previous);
            }
        },
        /**
         * Executes the selected glValidateProgram operation against the actual WebGL context.
         *
         * @param {number} id - Numeric id argument for the declared operation.
         */
        glValidateProgram: (id) => {
            gl.validateProgram(object(programs, id));
            note(`validate ${id} ${gl.getProgramParameter(object(programs, id), gl.VALIDATE_STATUS)} ${gl.getProgramInfoLog(object(programs, id))}`);
        },
        /**
         * Executes the selected glGetProgrami operation against the actual WebGL context.
         *
         * @param {number} id - Numeric id argument for the declared operation.
         * @param {number} name - Numeric name argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glGetProgrami: (id, name) => {
            if (name === gl.ACTIVE_UNIFORMS) {
                return visibleUniforms(object(programs, id)).length;
            }

            if (name === gl.ACTIVE_UNIFORM_MAX_LENGTH) {
                return Math.max(0, ...visibleUniforms(object(programs, id)).map((info) => info.name.length + 1));
            }

            return name === 0x8B_84 ? (gl.getProgramInfoLog(object(programs, id)) || '').length + 1 : Number(gl.getProgramParameter(object(programs, id), name));
        },
        /**
         * Executes the selected glGetProgramInfoLog operation against the actual WebGL context.
         *
         * @param {number} id - Numeric id argument for the declared operation.
         * @param {number} length - Numeric length argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glGetProgramInfoLog: (id, length) => (gl.getProgramInfoLog(object(programs, id)) || '').slice(0, Math.max(0, length - 1)),
        /**
         * Executes the selected glUseProgram operation against the actual WebGL context.
         *
         * @param {number} id - Numeric id argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glUseProgram: (id) => gl.useProgram(object(programs, id)),
        /**
         * Executes the selected glDeleteProgram operation against the actual WebGL context.
         *
         * @param {number} id - Numeric id argument for the declared operation.
         */
        glDeleteProgram: (id) => {
            for (const shader of linkedStages.get(id) || []) {
                gl.deleteShader(shader);
            }

            linkedStages.delete(id);
            gl.deleteProgram(object(programs, id));
            programs.delete(id);
            attached.delete(id);

            for (const [location, owner] of locationOwners) {
                if (owner === id) {
                    locationOwners.delete(location);
                    locations.delete(location);
                }
            }
        },
        /**
         * Performs the uniform location operation for the owned browser runtime.
         *
         * @param {number} program - Numeric program argument for the declared operation.
         * @param {string} name - Original shader symbol name.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        uniformLocation: (program, name) => {
            if (alphaPrograms.get(object(programs, program))?.supported && alphaNames.slice(1).includes(String(name))) {
                return -1;
            }

            const value = gl.getUniformLocation(object(programs, program), String(name));

            if (value === null) {
                return -1;
            }

            const id = add(locations, value);

            locationOwners.set(id, program);

            return id;
        },
        /**
         * Performs the uniform component operation for the owned browser runtime.
         *
         * @param {number} program - Numeric program argument for the declared operation.
         * @param {number} id - Numeric id argument for the declared operation.
         * @param {number} index - Numeric index argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        uniformComponent: (program, id, index) => {
            const value = gl.getUniform(object(programs, program), location(id));

            if (typeof value === 'number') {
                if (index !== 0) {
                    throw new Error('Scalar uniform index');
                }

                return value;
            }

            if (!value || index < 0 || index >= value.length) {
                throw new Error('Uniform component index');
            }

            return value[index];
        },
        /**
         * Performs the active uniform name operation for the owned browser runtime.
         *
         * @param {number} program - Numeric program argument for the declared operation.
         * @param {number} index - Numeric index argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        activeUniformName: (program, index) => {
            const value = visibleUniforms(object(programs, program))[index];

            if (!value) {
                throw new Error('Invalid uniform index');
            }

            return value.name;
        },
        /**
         * Performs the active uniform property operation for the owned browser runtime.
         *
         * @param {number} program - Numeric program argument for the declared operation.
         * @param {number} index - Numeric index argument for the declared operation.
         * @param {number} type - Numeric type argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        activeUniformProperty: (program, index, type) => {
            const value = visibleUniforms(object(programs, program))[index];

            if (!value) {
                throw new Error('Invalid uniform index');
            }

            return type ? value.type : value.size;
        },
        /**
         * Executes the selected glUniform1i operation against the actual WebGL context.
         *
         * @param {number} id - Numeric id argument for the declared operation.
         * @param {number} x - Numeric x argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glUniform1i: (id, x) => gl.uniform1i(location(id), x),
        /**
         * Executes the selected glUniform1f operation against the actual WebGL context.
         *
         * @param {number} id - Numeric id argument for the declared operation.
         * @param {number} x - Numeric x argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glUniform1f: (id, x) => gl.uniform1f(location(id), x),
        /**
         * Executes the selected glUniform2f operation against the actual WebGL context.
         *
         * @param {number} id - Numeric id argument for the declared operation.
         * @param {number} x - Numeric x argument for the declared operation.
         * @param {number} y - Numeric y argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glUniform2f: (id, x, y) => gl.uniform2f(location(id), x, y),
        /**
         * Executes the selected glUniform3f operation against the actual WebGL context.
         *
         * @param {number} id - Numeric id argument for the declared operation.
         * @param {number} x - Numeric x argument for the declared operation.
         * @param {number} y - Numeric y argument for the declared operation.
         * @param {number} z - Numeric z argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glUniform3f: (id, x, y, z) => gl.uniform3f(location(id), x, y, z),
        /**
         * Executes the selected glUniform4f operation against the actual WebGL context.
         *
         * @param {number} id - Numeric id argument for the declared operation.
         * @param {number} x - Numeric x argument for the declared operation.
         * @param {number} y - Numeric y argument for the declared operation.
         * @param {number} z - Numeric z argument for the declared operation.
         * @param {number} w - Numeric w argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glUniform4f: (id, x, y, z, w) => gl.uniform4f(location(id), x, y, z, w),
        /**
         * Uploads actual four by four matrices to the current program.
         *
         * @param {number} id - Numeric id argument for the declared operation.
         * @param {Uint8Array|Float32Array|Int32Array|DataView} data - Java array storage exposed by the browser runtime.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        matrix4: (id, data) => gl.uniformMatrix4fv(location(id), false, floats(data)),
        /**
         * Uploads actual three by three matrices to the current program.
         *
         * @param {number} id - Numeric id argument for the declared operation.
         * @param {Uint8Array|Float32Array|Int32Array|DataView} data - Java array storage exposed by the browser runtime.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        matrix3: (id, data) => gl.uniformMatrix3fv(location(id), false, floats(data)),
        /**
         * Executes the selected glGenTextures operation against the actual WebGL context.
         *
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glGenTextures: () => add(textures, gl.createTexture()),
        /**
         * Executes the selected glBindTexture operation against the actual WebGL context.
         *
         * @param {number} target - Numeric target argument for the declared operation.
         * @param {number} id - Numeric id argument for the declared operation.
         */
        glBindTexture: (target, id) => {
            gl.bindTexture(target, object(textures, id));
            attributeState.collect();
        },
        /**
         * Executes the selected glDeleteTextures operation against the actual WebGL context.
         *
         * @param {number} id - Numeric id argument for the declared operation.
         */
        glDeleteTextures: (id) => {
            attributeState.deleteTexture(id);
        },
        /**
         * Executes the selected glTexParameteri operation against the actual WebGL context.
         *
         * @param {number} target - Numeric target argument for the declared operation.
         * @param {number} name - Numeric name argument for the declared operation.
         * @param {unknown} value - Value returned by or passed to the underlying browser operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glTexParameteri: (target, name, value) => gl.texParameteri(target, name, value),
        /**
         * Computes the Java buffer extent using the current actual 2D unpack state.
         * The final row needs its pixels but no trailing alignment padding.
         *
         * @param {number} width - Image width in pixels.
         * @param {number} height - Image height in pixels.
         * @param {number} format - Qualified RED or RGBA format.
         * @param {number} type - Qualified UNSIGNED_BYTE pixel type.
         * @returns {number} Required byte extent, including leading skips and row padding.
         */
        textureByteCount: (width, height, format, type) => {
            if (![width, height].every((size) => Number.isInteger(size) && size >= 0)) {
                throw new RangeError('Invalid texture dimensions');
            }

            if (type !== gl.UNSIGNED_BYTE || ![gl.RED, gl.RGBA].includes(format)) {
                throw new Error('Unsupported texture buffer format');
            }

            if (width === 0 || height === 0) {
                return 0;
            }

            const channels = format === gl.RED ? 1 : 4;
            const alignment = gl.getParameter(gl.UNPACK_ALIGNMENT);
            const rowPixels = gl.getParameter(gl.UNPACK_ROW_LENGTH) || width;
            const stride = Math.ceil(rowPixels * channels / alignment) * alignment;
            const count = gl.getParameter(gl.UNPACK_SKIP_ROWS) * stride
                + gl.getParameter(gl.UNPACK_SKIP_PIXELS) * channels + (height - 1) * stride + width * channels;

            if (!Number.isSafeInteger(count) || count > 2_147_483_647) {
                throw new RangeError('Texture buffer extent exceeds Java array capacity');
            }

            return count;
        },
        /**
         * Performs the texture bytes operation for the owned browser runtime.
         *
         * @param {number} target - Numeric target argument for the declared operation.
         * @param {number} level - Numeric level argument for the declared operation.
         * @param {number} internal - Numeric internal argument for the declared operation.
         * @param {number} w - Numeric w argument for the declared operation.
         * @param {number} h - Numeric h argument for the declared operation.
         * @param {number} border - Numeric border argument for the declared operation.
         * @param {number} format - Numeric format argument for the declared operation.
         * @param {number} type - Numeric type argument for the declared operation.
         * @param {Uint8Array|Float32Array|Int32Array|DataView} data - Java array storage exposed by the browser runtime.
         */
        textureBytes: (target, level, internal, w, h, border, format, type, data) => {
            const color = format === gl.RGBA && type === gl.UNSIGNED_BYTE && [gl.RGBA, gl.RGBA8].includes(internal);
            const depth = data === null && format === gl.DEPTH_COMPONENT && type === gl.UNSIGNED_SHORT && internal === gl.DEPTH_COMPONENT16;

            const red = format === gl.RED && type === gl.UNSIGNED_BYTE && [gl.RED, gl.R8].includes(internal);

            if (!color && !depth && !red) {
                throw new Error('Unsupported texture format');
            }

            gl.texImage2D(target, level, red ? gl.R8 : internal, w, h, border, format, type, bytes(data));
            const binding = gl.getParameter(gl.TEXTURE_BINDING_2D);

            if (binding) {
                const levels = textureExtents.get(binding) ?? new Map();

                levels.set(level, w * h * (red ? 1 : 4) / (depth ? 2 : 1));
                textureExtents.set(binding, levels);
            }
        },
        /**
         * Performs the read pixels operation for the owned browser runtime.
         *
         * @param {number} x - Numeric x argument for the declared operation.
         * @param {number} y - Numeric y argument for the declared operation.
         * @param {number} w - Numeric w argument for the declared operation.
         * @param {number} h - Numeric h argument for the declared operation.
         * @param {number} format - Numeric format argument for the declared operation.
         * @param {number} type - Numeric type argument for the declared operation.
         * @param {Uint8Array|Float32Array|Int32Array|DataView} data - Java array storage exposed by the browser runtime.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        readPixels: (x, y, w, h, format, type, data) => gl.readPixels(x, y, w, h, format, type, bytes(data)),
        /**
         * Executes the selected glGenRenderbuffers operation against the actual WebGL context.
         *
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glGenRenderbuffers: () => add(renderbuffers, gl.createRenderbuffer()),
        /**
         * Executes the selected glBindRenderbuffer operation against the actual WebGL context.
         *
         * @param {number} target - Numeric target argument for the declared operation.
         * @param {number} id - Numeric id argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glBindRenderbuffer: (target, id) => gl.bindRenderbuffer(target, object(renderbuffers, id)),
        /**
         * Executes the selected glDeleteRenderbuffers operation against the actual WebGL context.
         *
         * @param {number} id - Numeric id argument for the declared operation.
         */
        glDeleteRenderbuffers: (id) => {
            gl.deleteRenderbuffer(object(renderbuffers, id));
            renderbuffers.delete(id);
        },
        /**
         * Executes the selected glRenderbufferStorage operation against the actual WebGL context.
         *
         * @param {number} target - Numeric target argument for the declared operation.
         * @param {number} format - Numeric format argument for the declared operation.
         * @param {number} w - Numeric w argument for the declared operation.
         * @param {number} h - Numeric h argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glRenderbufferStorage: (target, format, w, h) => gl.renderbufferStorage(target, format, w, h),
        /**
         * Executes the selected glRenderbufferStorageMultisample operation against the actual WebGL context.
         *
         * @param {number} target - Numeric target argument for the declared operation.
         * @param {number} samples - Numeric samples argument for the declared operation.
         * @param {number} format - Numeric format argument for the declared operation.
         * @param {number} w - Numeric w argument for the declared operation.
         * @param {number} h - Numeric h argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glRenderbufferStorageMultisample: (target, samples, format, w, h) => gl.renderbufferStorageMultisample(target, samples, format, w, h),
        /**
         * Executes the selected glFramebufferRenderbuffer operation against the actual WebGL context.
         *
         * @param {number} target - Numeric target argument for the declared operation.
         * @param {number} attachment - Numeric attachment argument for the declared operation.
         * @param {number} renderTarget - Numeric render target argument for the declared operation.
         * @param {number} id - Numeric id argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glFramebufferRenderbuffer: (target, attachment, renderTarget, id) => gl.framebufferRenderbuffer(target, attachment, renderTarget, object(renderbuffers, id)),
        /**
         * Executes the selected glBlitFramebuffer operation against the actual WebGL context.
         *
         * @param {...unknown} args - Arguments forwarded to the declared runtime operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glBlitFramebuffer: (...args) => gl.blitFramebuffer(...args),
        /**
         * Executes the selected glGenFramebuffers operation against the actual WebGL context.
         *
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glGenFramebuffers: () => add(framebuffers, gl.createFramebuffer()),
        /**
         * Executes the selected glBindFramebuffer operation against the actual WebGL context.
         *
         * @param {number} target - Numeric target argument for the declared operation.
         * @param {number} id - Numeric id argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glBindFramebuffer: (target, id) => gl.bindFramebuffer(target, object(framebuffers, id)),
        /**
         * Executes the selected glDeleteFramebuffers operation against the actual WebGL context.
         *
         * @param {number} id - Numeric id argument for the declared operation.
         */
        glDeleteFramebuffers: (id) => {
            gl.deleteFramebuffer(object(framebuffers, id));
            framebuffers.delete(id);
        },
        /**
         * Executes the selected glCheckFramebufferStatus operation against the actual WebGL context.
         *
         * @param {number} target - Numeric target argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glCheckFramebufferStatus: (target) => gl.checkFramebufferStatus(target),
        /**
         * Executes the selected glFramebufferTexture2D operation against the actual WebGL context.
         *
         * @param {number} target - Numeric target argument for the declared operation.
         * @param {number} attachment - Numeric attachment argument for the declared operation.
         * @param {number} textureTarget - Numeric texture target argument for the declared operation.
         * @param {number} id - Numeric id argument for the declared operation.
         * @param {number} level - Numeric level argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glFramebufferTexture2D: (target, attachment, textureTarget, id, level) => gl.framebufferTexture2D(target, attachment, textureTarget, object(textures, id), level),
    };

    api.drawArrays = api.glDrawArrays;

    const natives = {};

    for (const [name, callback] of Object.entries(api)) {
        /**
         * Forwards a declared Java native call and awaits actual asynchronous browser work.
         *
         * @param {unknown} lib - Reserved library context supplied by CheerpJ.
         * @param {...unknown} args - Arguments supplied by the Java native invocation.
         * @returns {Promise<unknown>} Result after the actual browser operation completes.
         */
        natives[`Java_port_host_SpriteGraphics_${name}`] = async (lib, ...args) => {
            if (name === 'adoptDisplay' || name === 'resizeDisplay') {
                if (!canvas.isConnected || gl.isContextLost()) {
                    throw await new (await lib.java.lang.IllegalStateException)('Browser Display surface is closed');
                }
            }

            if (name === 'adoptDisplay') {
                const [color, alpha, depth, stencil, samples] = args;
                const draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
                const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
                let bits;

                try {
                    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
                    bits = [gl.RED_BITS, gl.GREEN_BITS, gl.BLUE_BITS, gl.ALPHA_BITS,
                        gl.DEPTH_BITS, gl.STENCIL_BITS, gl.SAMPLES].map((parameter) => gl.getParameter(parameter));
                } finally {
                    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw);
                    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
                }

                if (color < 0 || alpha < 0 || depth < 0 || stencil < 0 || samples < 0
                    || color > bits.slice(0, 4).reduce((sum, value) => sum + value, 0)
                    || alpha > bits[3] || depth > bits[4] || stencil > bits[5] || samples > bits[6]) {
                    throw await new (await lib.org.lwjglx.LWJGLException)('Owned WebGL context cannot provide the requested pixel format');
                }
            }

            if (name === 'resizeDisplay') {
                const [width, height] = args;
                const maximum = gl.getParameter(gl.MAX_VIEWPORT_DIMS);

                if (width <= 0 || height <= 0 || width > maximum[0] || height > maximum[1]) {
                    throw await new (await lib.java.lang.IllegalArgumentException)('Browser Display dimensions exceed the owned WebGL limits');
                }
            }

            if (name === 'destroyDisplay' && !gl.isContextLost() && !gl.getExtension('WEBGL_lose_context')) {
                throw await new (await lib.java.lang.UnsupportedOperationException)('Browser context destruction is unavailable');
            }

            if (name === 'setTitle' && (!canvas.isConnected || gl.isContextLost())) {
                throw await new (await lib.java.lang.IllegalStateException)('Browser title surface is closed');
            }

            const result = await callback(...args);

            if (name === 'resizeDisplay' && !result) {
                throw await new (await lib.org.lwjglx.LWJGLException)('Browser drawing buffer did not accept the requested dimensions');
            }

            return result;
        };
    }

    return {
        natives, diagnostics,
        /**
         * Performs the resources operation for the owned browser runtime.
         *
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        resources: () => ({
            shaders: shaders.size, programs: programs.size, textures: textures.size + attributeState.pendingCount('texture'), buffers: buffers.size + attributeState.pendingCount('buffer'), framebuffers: framebuffers.size,
            /* Live registry extents exclude pending deletions, mipmap generation,
               internal transient uploads, driver overhead and framebuffer storage. */
            textureUploadedLevelBytes: [...textures.values()].reduce((sum, texture) => sum + [...(textureExtents.get(texture)?.values() ?? [])].reduce((total, size) => total + size, 0), 0),
            bufferAllocatedBytes: [...buffers.values()].reduce((sum, buffer) => sum + (bufferExtents.get(buffer) ?? 0), 0),
        }),
    };
}
