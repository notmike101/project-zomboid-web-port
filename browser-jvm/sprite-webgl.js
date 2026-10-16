import { normalizeDesktopShader, instrumentAlphaTest, hasAlphaIdentifiers, alphaNames } from './glsl-compat.js';

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
    const gl = canvas.getContext('webgl2', { alpha: true, antialias: false, stencil: true, premultipliedAlpha: false, preserveDrawingBuffer: true });

    if (!gl) {
        throw new Error('WebGL2 unavailable');
    }

    let next = 1;
    let activeUnit = gl.TEXTURE0;
    let eventWidth = canvas.width;
    let eventHeight = canvas.height;
    let eventResized = false;
    let eventPumps = 0;
    const shaders = new Map();
    const programs = new Map();
    const textures = new Map();
    const buffers = new Map();
    const framebuffers = new Map();
    const renderbuffers = new Map();
    const locations = new Map();
    const shaderSources = new Map();
    const linkedStages = new Map();
    const shaderTypes = new Map();
    const sourceDefaults = new Map();
    const attached = new Map();
    const locationOwners = new Map();
    const legacyTexture = new Map();
    let alphaEnabled = false;
    let alphaFunction = 519;
    let alphaReference = 0;
    let compatibilityError = 0;
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

        if (alphaEnabled && !info?.supported) {
            throw new Error(`Unsupported alpha-test draw: ${info?.reason || 'no instrumented fragment program'}`);
        }

        if (alphaEnabled && gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING)) {
            const type = gl.getFramebufferAttachmentParameter(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE);

            if (type !== gl.NONE && gl.getFramebufferAttachmentParameter(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE) === gl.FLOAT) {
                throw new Error('Unsupported alpha-test draw: floating-point color attachment');
            }
        }

        if (info?.supported) {
            gl.uniform1i(info.functionLocation, alphaEnabled ? alphaFunction : 519);
            gl.uniform1f(info.referenceLocation, alphaReference);
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
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        bufferBind: (target, id) => gl.bindBuffer(target, object(buffers, id)),
        /**
         * Performs the buffer delete operation for the owned browser runtime.
         *
         * @param {number} id - Numeric id argument for the declared operation.
         */
        bufferDelete: (id) => {
            gl.deleteBuffer(object(buffers, id));
            buffers.delete(id);
        },
        /**
         * Performs the buffer is operation for the owned browser runtime.
         *
         * @param {number} id - Numeric id argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        bufferIs: (id) => gl.isBuffer(object(buffers, id)),
        /**
         * Performs the buffer data size operation for the owned browser runtime.
         *
         * @param {number} target - Numeric target argument for the declared operation.
         * @param {number} size - Numeric size argument for the declared operation.
         * @param {number} usage - Numeric usage argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        bufferDataSize: (target, size, usage) => gl.bufferData(target, size, usage),
        /**
         * Performs the buffer data bytes operation for the owned browser runtime.
         *
         * @param {number} target - Numeric target argument for the declared operation.
         * @param {Uint8Array|Float32Array|Int32Array|DataView} data - Java array storage exposed by the browser runtime.
         * @param {number} usage - Numeric usage argument for the declared operation.
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        bufferDataBytes: (target, data, usage) => gl.bufferData(target, bytes(data), usage),
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
            const result = compatibilityError;

            compatibilityError = 0;

            return result || gl.getError();
        },
        /**
         * Performs the integer state operation for the owned browser runtime.
         *
         * @param {number} name - Numeric name argument for the declared operation.
         * @returns {number} Actual scalar state or the corresponding owned object handle.
         */
        integerState: (name) => {
            if (name === 0x0B_C1) {
                return alphaFunction;
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
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        vertexPointer: (index, size, type, normalized, stride, offset) => gl.vertexAttribPointer(index, size, type, normalized, stride, offset),
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

            return gl.drawElements(mode, count, type, offset);
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
                activeUnit = unit;
            }
        },
        /**
         * Executes the selected glEnable operation against the actual WebGL context.
         *
         * @param {number} cap - Numeric cap argument for the declared operation.
         */
        glEnable: (cap) => {
            if (cap === 3_008) {
                alphaEnabled = true;

                return;
            }

            if (cap === gl.TEXTURE_2D) {
                legacyTexture.set(activeUnit, true);
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
            if (cap === 3_008) {
                alphaEnabled = false;

                return;
            }

            if (cap === gl.TEXTURE_2D) {
                legacyTexture.set(activeUnit, false);
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
            if (cap === 3_008) {
                return alphaEnabled;
            }

            return cap === gl.TEXTURE_2D ? legacyTexture.get(activeUnit) === true : gl.isEnabled(cap);
        },
        /**
         * Retains the desktop comparison and normalized-buffer reference; invalid enums preserve state.
         *
         * @param {number} comparison - One of the eight original alpha comparison enums.
         * @param {number} reference - Reference value from the original float ABI.
         */
        glAlphaFunc: (comparison, reference) => {
            if (!Number.isInteger(comparison) || comparison < 512 || comparison > 519) {
                compatibilityError ||= gl.INVALID_ENUM;

                return;
            }

            alphaFunction = comparison;
            alphaReference = Math.fround(Math.min(1, Math.max(0, reference)));
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
        glClear: (mask) => gl.clear(mask),
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
         * Sets the actual scissor box; WebGL retains invalid negative-size errors.
         *
         * @param {number} x - Left edge in framebuffer pixels.
         * @param {number} y - Bottom edge in framebuffer pixels.
         * @param {number} width - Scissor width.
         * @param {number} height - Scissor height.
         * @returns {undefined} Completion of the WebGL state update.
         */
        glScissor: (x, y, width, height) => gl.scissor(x, y, width, height),
        /**
         * Sets the actual depth comparison function; WebGL retains invalid-enum errors.
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
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        glBindTexture: (target, id) => gl.bindTexture(target, object(textures, id)),
        /**
         * Executes the selected glDeleteTextures operation against the actual WebGL context.
         *
         * @param {number} id - Numeric id argument for the declared operation.
         */
        glDeleteTextures: (id) => {
            gl.deleteTexture(object(textures, id));
            textures.delete(id);
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
    const natives = {};

    for (const [name, callback] of Object.entries(api)) {
        /**
         * Forwards a declared Java native call and awaits actual asynchronous browser work.
         *
         * @param {unknown} lib - Reserved library context supplied by CheerpJ.
         * @param {...unknown} args - Arguments supplied by the Java native invocation.
         * @returns {Promise<unknown>} Result after the actual browser operation completes.
         */
        natives[`Java_port_host_SpriteGraphics_${name}`] = async (lib, ...args) => await callback(...args);
    }

    return {
        natives, diagnostics,
        /**
         * Performs the resources operation for the owned browser runtime.
         *
         * @returns {unknown} Result of the declared browser or runtime operation.
         */
        resources: () => ({ shaders: shaders.size, programs: programs.size, textures: textures.size, buffers: buffers.size, framebuffers: framebuffers.size }),
    };
}
