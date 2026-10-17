/** Desktop attribute groups over the state hosted by the existing WebGL facade. */
const groups = {
    CURRENT: 1, LINE: 4, POLYGON: 8, DEPTH: 256, STENCIL: 1_024,
    VIEWPORT: 2_048, ENABLE: 8_192, COLOR: 16_384, HINT: 32_768,
    TEXTURE: 262_144, SCISSOR: 524_288, MULTISAMPLE: 536_870_912,
};

/**
 * Captures and restores real supported desktop groups without owning another renderer.
 */
export class SpriteAttributeState {
    /**
     * Shares the existing context and resource owners.
     *
     * @param {WebGL2RenderingContext} gl - Existing graphics context.
     * @param {Map} buffers - Live public buffer names.
     * @param {Map} textures - Live public texture names.
     * @param {object} compatibility - Existing desktop compatibility state owner.
     */
    constructor(gl, buffers, textures, compatibility) {
        this.gl = gl;
        this.buffers = buffers;
        this.textures = textures;
        this.compatibility = compatibility;
        this.server = [];
        this.client = [];
        this.maximum = 16;
        this.records = new WeakMap();
        this.pending = new Set();
        this.capabilities = [gl.BLEND, gl.CULL_FACE, gl.DEPTH_TEST, gl.DITHER, gl.POLYGON_OFFSET_FILL, gl.SAMPLE_ALPHA_TO_COVERAGE, gl.SAMPLE_COVERAGE, gl.SCISSOR_TEST, gl.STENCIL_TEST, gl.RASTERIZER_DISCARD];
        this.textureTargets = [gl.TEXTURE_2D, gl.TEXTURE_CUBE_MAP, gl.TEXTURE_3D, gl.TEXTURE_2D_ARRAY];
        this.textureBindings = [gl.TEXTURE_BINDING_2D, gl.TEXTURE_BINDING_CUBE_MAP, gl.TEXTURE_BINDING_3D, gl.TEXTURE_BINDING_2D_ARRAY];
        this.textureParameters = [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER, gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R, gl.TEXTURE_BASE_LEVEL, gl.TEXTURE_MAX_LEVEL, gl.TEXTURE_MIN_LOD, gl.TEXTURE_MAX_LOD, gl.TEXTURE_COMPARE_MODE, gl.TEXTURE_COMPARE_FUNC];
        this.bufferTargets = [gl.ARRAY_BUFFER, gl.ELEMENT_ARRAY_BUFFER, gl.COPY_READ_BUFFER, gl.COPY_WRITE_BUFFER, gl.PIXEL_PACK_BUFFER, gl.PIXEL_UNPACK_BUFFER, gl.UNIFORM_BUFFER, gl.TRANSFORM_FEEDBACK_BUFFER];
        this.bufferBindings = [gl.ARRAY_BUFFER_BINDING, gl.ELEMENT_ARRAY_BUFFER_BINDING, gl.COPY_READ_BUFFER_BINDING, gl.COPY_WRITE_BUFFER_BINDING, gl.PIXEL_PACK_BUFFER_BINDING, gl.PIXEL_UNPACK_BUFFER_BINDING, gl.UNIFORM_BUFFER_BINDING, gl.TRANSFORM_FEEDBACK_BUFFER_BINDING];
        this.pixelParameters = [gl.PACK_ALIGNMENT, gl.PACK_ROW_LENGTH, gl.PACK_SKIP_PIXELS, gl.PACK_SKIP_ROWS, gl.UNPACK_ALIGNMENT, gl.UNPACK_ROW_LENGTH, gl.UNPACK_SKIP_PIXELS, gl.UNPACK_SKIP_ROWS, gl.UNPACK_IMAGE_HEIGHT, gl.UNPACK_SKIP_IMAGES];
    }

    /**
     * Records a public name without changing its graphics object.
     *
     * @param {string} kind - Buffer or texture resource kind.
     * @param {number} id - Original public name.
     * @param {object} object - Actual graphics object.
     */
    remember(kind, id, object) {
        this.records.set(object, { kind, id, object, deleted: false });
    }

    /**
     * Resolves actual restored objects to their original names.
     *
     * @param {object} object - Actual graphics object.
     * @returns {number|undefined} Its retained original name, including an unnamed retained object.
     */
    objectId(object) {
        return this.records.get(object)?.id;
    }

    /**
     * Counts real resources retained after logical deletion.
     *
     * @param {string} kind - Resource kind retained after public deletion.
     * @returns {number} Real objects still owned by saved or restored state.
     */
    pendingCount(kind) {
        let count = 0;

        for (const record of this.pending) {
            if (record.kind === kind) {
                count++;
            }
        }

        return count;
    }

    /**
     * Preserves the first desktop compatibility error.
     *
     * @param {number} code - Desktop compatibility error.
     */
    error(code) {
        this.compatibility.error ||= code;
    }

    /**
     * Reads the actual generic vertex-array pointer state.
     *
     * @param {number} index - Generic vertex attribute index.
     * @returns {object} Actual pointer description, independent of current values.
     */
    vertex(index) {
        const gl = this.gl;

        return {
            index,
            buffer: gl.getVertexAttrib(index, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING),
            size: gl.getVertexAttrib(index, gl.VERTEX_ATTRIB_ARRAY_SIZE),
            type: gl.getVertexAttrib(index, gl.VERTEX_ATTRIB_ARRAY_TYPE),
            normalized: gl.getVertexAttrib(index, gl.VERTEX_ATTRIB_ARRAY_NORMALIZED),
            stride: gl.getVertexAttrib(index, gl.VERTEX_ATTRIB_ARRAY_STRIDE),
            offset: gl.getVertexAttribOffset(index, gl.VERTEX_ATTRIB_ARRAY_POINTER),
            enabled: gl.getVertexAttrib(index, gl.VERTEX_ATTRIB_ARRAY_ENABLED),
            integer: gl.getVertexAttrib(index, gl.VERTEX_ATTRIB_ARRAY_INTEGER),
            divisor: gl.getVertexAttrib(index, gl.VERTEX_ATTRIB_ARRAY_DIVISOR),
        };
    }

    /**
     * Restores a real vertex pointer, including an initially null buffer.
     *
     * @param {object} value - Saved pointer description.
     */
    restoreVertex(value) {
        const gl = this.gl;
        const temporary = value.buffer ? null : gl.createBuffer();

        gl.bindBuffer(gl.ARRAY_BUFFER, value.buffer || temporary);

        if (value.integer) {
            gl.vertexAttribIPointer(value.index, value.size, value.type, value.stride, value.offset);
        } else {
            gl.vertexAttribPointer(value.index, value.size, value.type, value.normalized, value.stride, value.offset);
        }

        gl.vertexAttribDivisor(value.index, value.divisor);

        if (value.enabled) {
            gl.enableVertexAttribArray(value.index);
        } else {
            gl.disableVertexAttribArray(value.index);
        }

        // Real deletion detaches the temporary and retains its pointer's format/offset.
        if (temporary) {
            gl.deleteBuffer(temporary);
        }
    }

    /**
     * Captures only the selected original client groups.
     *
     * @param {number} mask - Original desktop client mask;
     unknown bits are ignored.
     */
    pushClient(mask) {
        const gl = this.gl;

        if (this.client.length === this.maximum) {
            this.error(0x05_03);

            return;
        }

        const saved = { mask: mask & 3, references: new Set() };

        if (saved.mask & 1) {
            saved.pixel = [];

            for (const name of this.pixelParameters) {
                saved.pixel.push([name, gl.getParameter(name)]);
            }

            saved.pack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
            saved.unpack = gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING);
            saved.references.add(saved.pack);
            saved.references.add(saved.unpack);
        }

        if (saved.mask & 2) {
            saved.array = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
            saved.element = gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING);
            saved.vertices = [];
            saved.references.add(saved.array);
            saved.references.add(saved.element);

            for (let index = 0; index < gl.getParameter(gl.MAX_VERTEX_ATTRIBS); index++) {
                const value = this.vertex(index);

                saved.vertices.push(value);
                saved.references.add(value.buffer);
            }
        }

        this.client.push(saved);
    }

    /** Restores the matching selected client groups without touching current attribute values. */
    popClient() {
        const gl = this.gl;

        if (!this.client.length) {
            this.error(0x05_04);

            return;
        }

        const saved = this.client.pop();

        if (saved.mask & 1) {
            for (const [name, value] of saved.pixel) {
                gl.pixelStorei(name, value);
            }

            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, saved.pack);
            gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, saved.unpack);
        }

        if (saved.mask & 2) {
            for (const value of saved.vertices) {
                this.restoreVertex(value);
            }

            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, saved.element);
            gl.bindBuffer(gl.ARRAY_BUFFER, saved.array);
        }

        this.collect();
    }

    /**
     * Reads all supported texture targets on every texture unit.
     *
     * @returns {object} Every supported texture target and bound-object parameter set.
     */
    captureTextures() {
        const gl = this.gl;
        const active = gl.getParameter(gl.ACTIVE_TEXTURE);
        const units = [];
        const parameters = new Map();

        try {
            for (let index = 0; index < gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS); index++) {
                gl.activeTexture(gl.TEXTURE0 + index);
                const bindings = [];

                for (let target = 0; target < this.textureTargets.length; target++) {
                    const object = gl.getParameter(this.textureBindings[target]);

                    bindings.push(object);

                    if (object && !parameters.has(object)) {
                        parameters.set(object, { target: this.textureTargets[target], values: this.textureValues(this.textureTargets[target]) });
                    }
                }

                units.push(bindings);
            }
        } finally {
            gl.activeTexture(active);
        }

        return { active, units, parameters };
    }

    /**
     * Reads parameters of the currently bound actual texture object.
     *
     * @param {number} target - Supported texture target.
     * @returns {Array} Original parameter/value pairs.
     */
    textureValues(target) {
        const values = [];

        for (const name of this.textureParameters) {
            values.push([name, this.gl.getTexParameter(target, name)]);
        }

        return values;
    }

    /**
     * Captures only selected supported server groups.
     *
     * @param {number} mask - Original server mask;
     defined supported groups are captured.
     */
    pushServer(mask) {
        const gl = this.gl;
        const host = this.compatibility;

        if (this.server.length === this.maximum) {
            this.error(0x05_03);

            return;
        }

        const saved = { mask: mask & 0x20_0F_FF_FF, references: new Set() };

        if (saved.mask & groups.CURRENT) {
            saved.current = [];

            for (let index = 0; index < gl.getParameter(gl.MAX_VERTEX_ATTRIBS); index++) {
                saved.current.push(gl.getVertexAttrib(index, gl.CURRENT_VERTEX_ATTRIB));
            }
        }

        if (saved.mask & groups.VIEWPORT) {
            saved.viewport = [gl.getParameter(gl.VIEWPORT), gl.getParameter(gl.DEPTH_RANGE)];
        }

        if (saved.mask & groups.LINE) {
            saved.line = [gl.getParameter(gl.LINE_WIDTH), host.lineSmoothEnabled];
        }

        if (saved.mask & groups.POLYGON) {
            saved.polygon = [gl.getParameter(gl.CULL_FACE_MODE), gl.getParameter(gl.FRONT_FACE), gl.getParameter(gl.POLYGON_OFFSET_FACTOR), gl.getParameter(gl.POLYGON_OFFSET_UNITS), gl.isEnabled(gl.CULL_FACE), gl.isEnabled(gl.POLYGON_OFFSET_FILL)];
        }

        if (saved.mask & groups.DEPTH) {
            saved.depth = [gl.isEnabled(gl.DEPTH_TEST), gl.getParameter(gl.DEPTH_FUNC), gl.getParameter(gl.DEPTH_WRITEMASK), gl.getParameter(gl.DEPTH_CLEAR_VALUE)];
        }

        if (saved.mask & groups.SCISSOR) {
            saved.scissor = [gl.isEnabled(gl.SCISSOR_TEST), gl.getParameter(gl.SCISSOR_BOX)];
        }

        if (saved.mask & groups.COLOR) {
            saved.color = [host.alphaEnabled, host.alphaFunction, host.alphaReference, gl.isEnabled(gl.BLEND), gl.isEnabled(gl.DITHER), gl.getParameter(gl.BLEND_SRC_RGB), gl.getParameter(gl.BLEND_DST_RGB), gl.getParameter(gl.BLEND_SRC_ALPHA), gl.getParameter(gl.BLEND_DST_ALPHA), gl.getParameter(gl.BLEND_EQUATION_RGB), gl.getParameter(gl.BLEND_EQUATION_ALPHA), gl.getParameter(gl.BLEND_COLOR), gl.getParameter(gl.COLOR_CLEAR_VALUE), gl.getParameter(gl.COLOR_WRITEMASK)];
        }

        if (saved.mask & groups.STENCIL) {
            saved.stencil = [gl.isEnabled(gl.STENCIL_TEST), gl.getParameter(gl.STENCIL_CLEAR_VALUE), []];

            for (const back of [false, true]) {
                const names = back ? [gl.STENCIL_BACK_FUNC, gl.STENCIL_BACK_REF, gl.STENCIL_BACK_VALUE_MASK, gl.STENCIL_BACK_WRITEMASK, gl.STENCIL_BACK_FAIL, gl.STENCIL_BACK_PASS_DEPTH_FAIL, gl.STENCIL_BACK_PASS_DEPTH_PASS] : [gl.STENCIL_FUNC, gl.STENCIL_REF, gl.STENCIL_VALUE_MASK, gl.STENCIL_WRITEMASK, gl.STENCIL_FAIL, gl.STENCIL_PASS_DEPTH_FAIL, gl.STENCIL_PASS_DEPTH_PASS];
                const values = [];

                for (const name of names) {
                    values.push(gl.getParameter(name));
                }

                saved.stencil[2].push(values);
            }
        }

        if (saved.mask & groups.HINT) {
            saved.hints = [gl.getParameter(gl.GENERATE_MIPMAP_HINT), gl.getParameter(gl.FRAGMENT_SHADER_DERIVATIVE_HINT)];
        }

        if (saved.mask & groups.MULTISAMPLE) {
            saved.samples = [gl.isEnabled(gl.SAMPLE_ALPHA_TO_COVERAGE), gl.isEnabled(gl.SAMPLE_COVERAGE), gl.getParameter(gl.SAMPLE_COVERAGE_VALUE), gl.getParameter(gl.SAMPLE_COVERAGE_INVERT)];
        }

        if (saved.mask & groups.ENABLE) {
            saved.enables = [];

            for (const cap of this.capabilities) {
                saved.enables.push([cap, gl.isEnabled(cap)]);
            }

            saved.alphaEnabled = host.alphaEnabled;
            saved.lineSmoothEnabled = host.lineSmoothEnabled;
        }

        if (saved.mask & (groups.ENABLE | groups.TEXTURE)) {
            saved.legacy = new Map(host.legacyTexture);
        }

        if (saved.mask & groups.TEXTURE) {
            saved.textures = this.captureTextures();

            for (const object of saved.textures.parameters.keys()) {
                saved.references.add(object);
            }
        }

        this.server.push(saved);
    }

    /**
     * Restores one actual enable capability.
     *
     * @param {number} cap - Actual WebGL enable capability.
     * @param {boolean} enabled - Saved enable state.
     */
    enable(cap, enabled) {
        if (enabled) {
            this.gl.enable(cap);
        } else {
            this.gl.disable(cap);
        }
    }

    /**
     Restores selected server groups;
    program/FBO/content state is deliberately excluded.
     */
    popServer() {
        const gl = this.gl;
        const host = this.compatibility;

        if (!this.server.length) {
            this.error(0x05_04);

            return;
        }

        const saved = this.server.pop();

        if (saved.current) {
            for (let index = 0; index < saved.current.length; index++) {
                const value = saved.current[index];

                if (value instanceof Int32Array) {
                    gl.vertexAttribI4iv(index, value);
                } else if (value instanceof Uint32Array) {
                    gl.vertexAttribI4uiv(index, value);
                } else {
                    gl.vertexAttrib4fv(index, value);
                }
            }
        }

        if (saved.viewport) {
            gl.viewport(...saved.viewport[0]);
            gl.depthRange(...saved.viewport[1]);
        }

        if (saved.line) {
            gl.lineWidth(saved.line[0]);
            host.lineSmoothEnabled = saved.line[1];
        }

        if (saved.polygon) {
            const v = saved.polygon;

            gl.cullFace(v[0]);
            gl.frontFace(v[1]);
            gl.polygonOffset(v[2], v[3]);
            this.enable(gl.CULL_FACE, v[4]);
            this.enable(gl.POLYGON_OFFSET_FILL, v[5]);
        }

        if (saved.depth) {
            const v = saved.depth;

            this.enable(gl.DEPTH_TEST, v[0]);
            gl.depthFunc(v[1]);
            gl.depthMask(v[2]);
            gl.clearDepth(v[3]);
        }

        if (saved.scissor) {
            this.enable(gl.SCISSOR_TEST, saved.scissor[0]);
            gl.scissor(...saved.scissor[1]);
        }

        if (saved.color) {
            const v = saved.color;

            host.alphaEnabled = v[0];
            host.alphaFunction = v[1];
            host.alphaReference = v[2];
            this.enable(gl.BLEND, v[3]);
            this.enable(gl.DITHER, v[4]);
            gl.blendFuncSeparate(v[5], v[6], v[7], v[8]);
            gl.blendEquationSeparate(v[9], v[10]);
            gl.blendColor(...v[11]);
            gl.clearColor(...v[12]);
            gl.colorMask(...v[13]);
        }

        if (saved.stencil) {
            this.enable(gl.STENCIL_TEST, saved.stencil[0]);
            gl.clearStencil(saved.stencil[1]);

            for (let index = 0; index < 2; index++) {
                const v = saved.stencil[2][index];
                const face = index ? gl.BACK : gl.FRONT;

                gl.stencilFuncSeparate(face, v[0], v[1], v[2]);
                gl.stencilMaskSeparate(face, v[3]);
                gl.stencilOpSeparate(face, v[4], v[5], v[6]);
            }
        }

        if (saved.hints) {
            gl.hint(gl.GENERATE_MIPMAP_HINT, saved.hints[0]);
            gl.hint(gl.FRAGMENT_SHADER_DERIVATIVE_HINT, saved.hints[1]);
        }

        if (saved.samples) {
            this.enable(gl.SAMPLE_ALPHA_TO_COVERAGE, saved.samples[0]);
            this.enable(gl.SAMPLE_COVERAGE, saved.samples[1]);
            gl.sampleCoverage(saved.samples[2], saved.samples[3]);
        }

        if (saved.enables) {
            for (const [cap, enabled] of saved.enables) {
                this.enable(cap, enabled);
            }

            host.alphaEnabled = saved.alphaEnabled;
            host.lineSmoothEnabled = saved.lineSmoothEnabled;
        }

        if (saved.legacy) {
            host.legacyTexture.clear();

            for (const [unit, enabled] of saved.legacy) {
                host.legacyTexture.set(unit, enabled);
            }
        }

        if (saved.textures) {
            for (const [object, value] of saved.textures.parameters) {
                gl.bindTexture(value.target, object);

                for (const [name, parameter] of value.values) {
                    if (name === gl.TEXTURE_MIN_LOD || name === gl.TEXTURE_MAX_LOD) {
                        gl.texParameterf(value.target, name, parameter);
                    } else {
                        gl.texParameteri(value.target, name, parameter);
                    }
                }
            }

            for (let index = 0; index < saved.textures.units.length; index++) {
                gl.activeTexture(gl.TEXTURE0 + index);

                for (let target = 0; target < this.textureTargets.length; target++) {
                    gl.bindTexture(this.textureTargets[target], saved.textures.units[index][target]);
                }
            }

            gl.activeTexture(saved.textures.active);
            host.activeUnit = saved.textures.active;
        }

        this.collect();
    }

    /**
     * Finds live current references before collecting deleted objects.
     *
     * @returns {Set} Objects retained by actual current bindings and attribute pointers.
     */
    currentReferences() {
        const gl = this.gl;
        const references = new Set();

        for (const name of this.bufferBindings) {
            references.add(gl.getParameter(name));
        }

        for (let index = 0; index < gl.getParameter(gl.MAX_VERTEX_ATTRIBS); index++) {
            references.add(gl.getVertexAttrib(index, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING));
        }

        const active = gl.getParameter(gl.ACTIVE_TEXTURE);

        try {
            for (let index = 0; index < gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS); index++) {
                gl.activeTexture(gl.TEXTURE0 + index);

                for (const name of this.textureBindings) {
                    references.add(gl.getParameter(name));
                }
            }
        } finally {
            gl.activeTexture(active);
        }

        return references;
    }

    /** Releases deleted objects only after every saved/current reference is gone. */
    collect() {
        if (!this.pending.size) {
            return;
        }

        const references = this.currentReferences();

        for (const stack of [this.server, this.client]) {
            for (const saved of stack) {
                for (const object of saved.references) {
                    references.add(object);
                }
            }
        }

        for (const record of this.pending) {
            if (references.has(record.object)) {
                continue;
            }

            if (record.kind === 'buffer') {
                this.gl.deleteBuffer(record.object);
            } else {
                this.gl.deleteTexture(record.object);
            }

            this.pending.delete(record);
        }
    }

    /**
     * Removes a public buffer name and immediately detaches current references.
     *
     * @param {number} id - Public buffer name to delete immediately.
     */
    deleteBuffer(id) {
        const gl = this.gl;
        const object = this.buffers.get(id);

        if (!object) {
            return;
        }

        const record = this.records.get(object);

        this.buffers.delete(id);
        record.deleted = true;
        this.pending.add(record);
        const array = gl.getParameter(gl.ARRAY_BUFFER_BINDING);

        for (let index = 0; index < gl.getParameter(gl.MAX_VERTEX_ATTRIBS); index++) {
            const value = this.vertex(index);

            if (value.buffer === object) {
                value.buffer = null;
                this.restoreVertex(value);
            }
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, array === object ? null : array);

        for (let index = 0; index < this.bufferTargets.length; index++) {
            if (gl.getParameter(this.bufferBindings[index]) === object) {
                gl.bindBuffer(this.bufferTargets[index], null);
            }
        }

        this.collect();
    }

    /**
     * Removes a public texture name and immediately detaches current references.
     *
     * @param {number} id - Public texture name to delete immediately.
     */
    deleteTexture(id) {
        const gl = this.gl;
        const object = this.textures.get(id);

        if (!object) {
            return;
        }

        const record = this.records.get(object);

        this.textures.delete(id);
        record.deleted = true;
        this.pending.add(record);
        const active = gl.getParameter(gl.ACTIVE_TEXTURE);

        try {
            for (let index = 0; index < gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS); index++) {
                gl.activeTexture(gl.TEXTURE0 + index);

                for (let target = 0; target < this.textureTargets.length; target++) {
                    if (gl.getParameter(this.textureBindings[target]) === object) {
                        gl.bindTexture(this.textureTargets[target], null);
                    }
                }
            }
        } finally {
            gl.activeTexture(active);
        }

        for (const target of [gl.DRAW_FRAMEBUFFER, gl.READ_FRAMEBUFFER]) {
            if (!gl.getParameter(target === gl.DRAW_FRAMEBUFFER ? gl.DRAW_FRAMEBUFFER_BINDING : gl.READ_FRAMEBUFFER_BINDING)) {
                continue;
            }

            const attachments = [gl.DEPTH_ATTACHMENT, gl.STENCIL_ATTACHMENT];

            for (let index = 0; index < gl.getParameter(gl.MAX_COLOR_ATTACHMENTS); index++) {
                attachments.push(gl.COLOR_ATTACHMENT0 + index);
            }

            for (const attachment of attachments) {
                if (gl.getFramebufferAttachmentParameter(target, attachment, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE) !== gl.TEXTURE) {
                    continue;
                }

                if (gl.getFramebufferAttachmentParameter(target, attachment, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME) === object) {
                    gl.framebufferTexture2D(target, attachment, gl.TEXTURE_2D, null, 0);
                }
            }
        }

        this.collect();
    }
}
