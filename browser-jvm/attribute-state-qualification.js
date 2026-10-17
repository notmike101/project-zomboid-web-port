import { createSpriteNatives } from './sprite-webgl.js';

const canvas = document.querySelector('canvas');
const backend = createSpriteNatives(canvas, () => undefined);
const gl = canvas.getContext('webgl2');
let checks = 0;
let callbackError;
const samples = [];

/**
 * Asserts one actual driver or production-service observation.
 *
 * @param {boolean} value - Observed condition.
 * @param {string} label - Failure explanation.
 */
function check(value, label) {
    if (!value) {
        throw new Error(label);
    }

    checks++;
}

/**
 * Calls the same production native callbacks used by original Java.
 *
 * @param {string} name - Host service name.
 * @param {...unknown} args - Actual ABI arguments.
 * @returns {Promise<unknown>} Actual service result.
 */
async function call(name, ...args) {
    return await backend.natives[`Java_port_host_SpriteGraphics_${name}`](null, ...args);
}

/**
 * Reads a value-copy of selected actual scalar/vector state.
 *
 * @param {number[]} names - Real WebGL query enums.
 * @returns {string} Stable comparable values.
 */
function values(names) {
    const result = [];

    for (const name of names) {
        const value = gl.getParameter(name);

        result.push(ArrayBuffer.isView(value) ? [...value] : value);
    }

    return JSON.stringify(result);
}

/**
 * Exercises mutation, exact selection, actual pixels, and deleted-owner lifetimes.
 *
 * @returns {Promise<boolean>} True only after every actual state/pixel check.
 */
async function exercise() {
    const buffers = [];
    const textures = [];
    const shaders = [];
    let program;

    try {
        const stateNames = [gl.VIEWPORT, gl.DEPTH_RANGE, gl.LINE_WIDTH, gl.FRONT_FACE, gl.CULL_FACE_MODE, gl.POLYGON_OFFSET_FACTOR, gl.POLYGON_OFFSET_UNITS, gl.DEPTH_FUNC, gl.DEPTH_WRITEMASK, gl.DEPTH_CLEAR_VALUE, gl.SCISSOR_BOX, gl.BLEND_SRC_RGB, gl.BLEND_DST_RGB, gl.BLEND_SRC_ALPHA, gl.BLEND_DST_ALPHA, gl.BLEND_EQUATION_RGB, gl.BLEND_EQUATION_ALPHA, gl.BLEND_COLOR, gl.COLOR_CLEAR_VALUE, gl.COLOR_WRITEMASK, gl.STENCIL_FUNC, gl.STENCIL_REF, gl.STENCIL_VALUE_MASK, gl.STENCIL_WRITEMASK, gl.STENCIL_FAIL, gl.STENCIL_PASS_DEPTH_FAIL, gl.STENCIL_PASS_DEPTH_PASS, gl.STENCIL_BACK_FUNC, gl.STENCIL_BACK_REF, gl.STENCIL_BACK_VALUE_MASK, gl.STENCIL_BACK_WRITEMASK, gl.STENCIL_BACK_FAIL, gl.STENCIL_BACK_PASS_DEPTH_FAIL, gl.STENCIL_BACK_PASS_DEPTH_PASS, gl.STENCIL_CLEAR_VALUE, gl.SAMPLE_COVERAGE_VALUE, gl.SAMPLE_COVERAGE_INVERT, gl.GENERATE_MIPMAP_HINT, gl.FRAGMENT_SHADER_DERIVATIVE_HINT];
        const caps = [gl.BLEND, gl.CULL_FACE, gl.DEPTH_TEST, gl.DITHER, gl.POLYGON_OFFSET_FILL, gl.SAMPLE_ALPHA_TO_COVERAGE, gl.SAMPLE_COVERAGE, gl.SCISSOR_TEST, gl.STENCIL_TEST, gl.RASTERIZER_DISCARD];
        const before = values(stateNames);
        const enabled = [];

        for (const cap of caps) {
            enabled.push(gl.isEnabled(cap));
        }

        await call('pushAttributes', 0x20_0F_FF_FF);
        gl.viewport(1, 1, 2, 2);
        gl.depthRange(0.2, 0.7);
        gl.frontFace(gl.CW);
        gl.cullFace(gl.FRONT);
        gl.polygonOffset(2, 3);
        gl.depthFunc(gl.GREATER);
        gl.depthMask(false);
        gl.clearDepth(0.25);
        gl.scissor(1, 2, 3, 2);
        gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
        gl.blendEquationSeparate(gl.FUNC_SUBTRACT, gl.FUNC_REVERSE_SUBTRACT);
        gl.blendColor(0.25, 0.5, 0.75, 1);
        gl.clearColor(0.25, 0.5, 0.75, 0.25);
        gl.colorMask(false, true, false, true);
        gl.stencilFuncSeparate(gl.FRONT, gl.LESS, 3, 0x5A);
        gl.stencilMaskSeparate(gl.FRONT, 0x33);
        gl.stencilOpSeparate(gl.FRONT, gl.REPLACE, gl.INCR, gl.DECR);
        gl.stencilFuncSeparate(gl.BACK, gl.GREATER, 5, 0xA5);
        gl.stencilMaskSeparate(gl.BACK, 0xCC);
        gl.stencilOpSeparate(gl.BACK, gl.ZERO, gl.INVERT, gl.KEEP);
        gl.clearStencil(7);
        gl.sampleCoverage(0.25, true);
        gl.hint(gl.GENERATE_MIPMAP_HINT, gl.NICEST);
        gl.hint(gl.FRAGMENT_SHADER_DERIVATIVE_HINT, gl.FASTEST);

        for (const cap of caps) {
            gl.enable(cap);
        }

        await call('glEnable', 3_008);
        await call('glAlphaFunc', 516, 0.75);
        await call('glEnable', 2_848);
        await call('glPopAttrib');
        check(values(stateNames) === before, 'All hosted scalar/vector groups restore exactly');

        for (const [index, cap] of caps.entries()) {
            check(gl.isEnabled(cap) === enabled[index], 'All hosted enable bits restore');
        }

        check(!(await call('glIsEnabled', 3_008)) && !(await call('glIsEnabled', 2_848)) && await call('integerState', 0x0B_C1) === 519, 'Alpha and line compatibility owners restore');
        check(gl.getError() === 0, 'Combined server mutation/restoration has no error');
        await call('pushAttributes', 2_048);
        gl.viewport(1, 1, 1, 1);
        gl.clearColor(1, 0, 0, 1);
        await call('glPopAttrib');
        check(values([gl.VIEWPORT]) === JSON.stringify([[0, 0, 4, 4]]) && values([gl.COLOR_CLEAR_VALUE]) === JSON.stringify([[1, 0, 0, 1]]), 'Selected viewport group leaves color mutation intact');
        await call('pushAttributes', 0x00_0F_FF_FF);
        gl.sampleCoverage(0.375, true);
        await call('glPopAttrib');
        check(gl.getParameter(gl.SAMPLE_COVERAGE_VALUE) === 0.375, 'Original ALL mask does not invent missing multisample bit');
        gl.sampleCoverage(1, false);
        gl.vertexAttrib4f(3, 0.25, 0.5, 0.75, 1);
        await call('glPushClientAttrib', 2);
        gl.vertexAttrib4f(3, 0.75, 0.5, 0.25, 1);
        await call('glPopClientAttrib');
        check(JSON.stringify([...gl.getVertexAttrib(3, gl.CURRENT_VERTEX_ATTRIB)]) === JSON.stringify([0.75, 0.5, 0.25, 1]), 'Client arrays do not restore generic current values');
        await call('pushAttributes', 1);
        gl.vertexAttrib4f(3, 0, 0, 0, 1);
        await call('glPopAttrib');
        check(JSON.stringify([...gl.getVertexAttrib(3, gl.CURRENT_VERTEX_ATTRIB)]) === JSON.stringify([0.75, 0.5, 0.25, 1]), 'Server CURRENT restores generic current values');
        const unpackBefore = values([gl.UNPACK_ALIGNMENT, gl.UNPACK_ROW_LENGTH, gl.UNPACK_SKIP_PIXELS, gl.UNPACK_SKIP_ROWS, gl.UNPACK_IMAGE_HEIGHT, gl.UNPACK_SKIP_IMAGES]);

        await call('glPushClientAttrib', 1);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 8);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 1);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 2);
        gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 16);
        gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, 1);
        await call('glPopClientAttrib');
        check(values([gl.UNPACK_ALIGNMENT, gl.UNPACK_ROW_LENGTH, gl.UNPACK_SKIP_PIXELS, gl.UNPACK_SKIP_ROWS, gl.UNPACK_IMAGE_HEIGHT, gl.UNPACK_SKIP_IMAGES]) === unpackBefore, 'Client pixel-store state restores exact actual values');

        await Promise.all([[35_633, '#version 330\nlayout(location=0) in vec2 position;void main(){gl_Position=vec4(position,0,1);}'], [35_632, '#version 330\nuniform sampler2D image;void main(){gl_FragColor=texture2D(image,vec2(.5));}']].map(async ([type, source]) => {
            const shader = await call('glCreateShader', type);

            shaders.push(shader);
            await call('shaderText', shader, source);
            await call('glCompileShader', shader);
            check(Boolean(await call('glGetShaderi', shader, 35_713)), 'Real draw shader compiles');
        }));

        program = await call('glCreateProgram');

        await Promise.all(shaders.map((shader) => call('glAttachShader', program, shader)));

        await call('glLinkProgram', program);
        check(Boolean(await call('glGetProgrami', program, 35_714)), 'Real draw program links');
        await call('glUseProgram', program);
        const originalProgram = gl.getParameter(gl.CURRENT_PROGRAM);
        const buffer = await call('bufferCreate');

        buffers.push(buffer);
        await call('bufferBind', gl.ARRAY_BUFFER, buffer);
        await call('bufferDataBytes', gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        await call('vertexPointer', 0, 2, gl.FLOAT, false, 0, 0);
        await call('glEnableVertexAttribArray', 0);
        const actualBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING);

        await call('glPushClientAttrib', 2);
        await call('glPushClientAttrib', 2);
        await call('bufferDelete', buffer);
        check(!(await call('bufferIs', buffer)) && gl.getParameter(gl.ARRAY_BUFFER_BINDING) === null && gl.getVertexAttrib(0, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING) === null, 'Deleted public buffer detaches current state immediately');
        check(gl.isBuffer(actualBuffer) && backend.resources().buffers === 1, 'Saved frame retains the actual deleted buffer');
        await call('glPopClientAttrib');
        check(gl.getVertexAttrib(0, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING) === actualBuffer, 'Client pop restores the retained pointer');
        const replacement = await call('bufferCreate');

        buffers.push(replacement);
        await call('bufferBind', gl.ARRAY_BUFFER, replacement);
        await call('bufferDataBytes', gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        await call('vertexPointer', 0, 2, gl.FLOAT, false, 0, 0);
        check(gl.isBuffer(actualBuffer), 'Outer nested frame retains deleted buffer after current pointer changes');
        await call('glPopClientAttrib');
        check(gl.getVertexAttrib(0, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING) === actualBuffer, 'Outer pop restores retained geometry');
        const texture = await call('glGenTextures');

        textures.push(texture);
        await call('glActiveTexture', gl.TEXTURE0);
        await call('glBindTexture', gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([64, 128, 192, 255]));
        await call('glTexParameteri', gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        await call('glTexParameteri', gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        const actualTexture = gl.getParameter(gl.TEXTURE_BINDING_2D);

        await call('pushAttributes', 262_144);
        await call('glTexParameteri', gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        await call('glDeleteTextures', texture);
        check(gl.getParameter(gl.TEXTURE_BINDING_2D) === null && gl.isTexture(actualTexture) && backend.resources().textures === 1, 'Texture deletion detaches immediately but saved frame owns real image');
        await call('glPopAttrib');
        check(gl.getParameter(gl.TEXTURE_BINDING_2D) === actualTexture && gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER) === gl.NEAREST, 'Texture pop restores actual retained binding and object parameters');
        check(gl.getParameter(gl.CURRENT_PROGRAM) === originalProgram, 'Attribute stacks never replace original shader program');
        await call('glUniform1i', await call('uniformLocation', program, 'image'), 0);
        gl.viewport(0, 0, 4, 4);
        gl.disable(gl.DITHER);
        await call('glDrawArrays', gl.TRIANGLES, 0, 3);
        const rgba = new Uint8Array(4);

        gl.readPixels(1, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
        samples.push([...rgba]);
        check(JSON.stringify([...rgba]) === JSON.stringify([64, 128, 192, 255]), 'Deleted-but-retained geometry and texture produce exact actual pixels');
        await call('bufferBind', gl.ARRAY_BUFFER, replacement);
        await call('vertexPointer', 0, 2, gl.FLOAT, false, 0, 0);
        check(!gl.isBuffer(actualBuffer), 'Final pointer replacement physically deletes unnamed buffer');
        await call('glBindTexture', gl.TEXTURE_2D, 0);
        check(!gl.isTexture(actualTexture), 'Final unbind physically deletes unnamed texture');
        check(gl.getError() === 0, 'Actual retained draw and final release have no driver error');
        await call('glActiveTexture', gl.TEXTURE0 + 2);
        const extraTexture = await call('glGenTextures');

        textures.push(extraTexture);
        await call('glBindTexture', gl.TEXTURE_2D, extraTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([1, 2, 3, 255]));
        const actualExtra = gl.getParameter(gl.TEXTURE_BINDING_2D);

        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_MIN_LOD, 0.5);
        await call('glEnable', gl.TEXTURE_2D);
        await call('pushAttributes', 262_144);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameterf(gl.TEXTURE_2D, gl.TEXTURE_MIN_LOD, 2.5);
        // Contents remain live object data; attribute restoration does not roll them back.
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([9, 8, 7, 255]));
        await call('glDisable', gl.TEXTURE_2D);
        await call('glActiveTexture', gl.TEXTURE0);
        await call('glPopAttrib');
        check(gl.getParameter(gl.ACTIVE_TEXTURE) === gl.TEXTURE0 + 2 && gl.getParameter(gl.TEXTURE_BINDING_2D) === actualExtra, 'Texture group restores active selector and nonzero unit binding');
        check(gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S) === gl.CLAMP_TO_EDGE && gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MIN_LOD) === 0.5 && await call('glIsEnabled', gl.TEXTURE_2D), 'Actual object parameters and per-unit compatibility enable restore');
        const fbo = gl.createFramebuffer();

        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, actualExtra, 0);
        const image = new Uint8Array(4);

        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, image);
        check(JSON.stringify([...image]) === JSON.stringify([9, 8, 7, 255]), 'Texture image changes survive attribute pop');
        await call('pushAttributes', 262_144);
        await call('glDeleteTextures', extraTexture);
        check(gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE) === gl.NONE && gl.getParameter(gl.TEXTURE_BINDING_2D) === null, 'Logical texture deletion immediately detaches current FBO and unit binding');
        await call('glPopAttrib');
        check(gl.getParameter(gl.FRAMEBUFFER_BINDING) === fbo && gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE) === gl.NONE, 'Texture attributes never restore framebuffer attachments or bindings');
        await call('glBindTexture', gl.TEXTURE_2D, 0);
        check(!gl.isTexture(actualExtra), 'Retained attached texture releases after final unit unbind');
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fbo);
        await call('glActiveTexture', gl.TEXTURE0);
        check(gl.getError() === 0, 'Multiunit parameters/image/deletion checks have no driver error');

        return true;
    } finally {
        await Promise.all(buffers.map((buffer) => call('bufferDelete', buffer)));

        await Promise.all(textures.map((texture) => call('glDeleteTextures', texture)));

        if (program) {
            await call('glUseProgram', 0);
            await call('glDeleteProgram', program);
        }

        await Promise.all(shaders.map((shader) => call('glDeleteShader', shader)));
    }
}

try {
    await cheerpjInit({
        version: 17, status: 'none', natives: {
            ...backend.natives,
            /**
             * Runs browser checks while preserving genuine Java assertion and finally delivery.
             *
             * @returns {Promise<boolean>} Actual qualification outcome.
             */
            async Java_AttributeStateQualification_exercise() {
                try {
                    return await exercise();
                } catch (error) {
                    callbackError = String(error.stack || error);

                    return false;
                }
            },
            /**
             * Records original vendor ABI checks.
             *
             * @param {object} _lib - Runtime callback library.
             * @param {number} count - Passed Java checks.
             * @param {boolean} pass - Actual Java outcome.
             */
            Java_AttributeStateQualification_report(_lib, count, pass) {
                globalThis.javaResult = { checks: count, pass };
            },
        },
    });
    const exit = await cheerpjRunMain('AttributeStateQualification', '/app/qualification.jar:/app/sprite-view.jar');

    globalThis.result = { pass: exit === 0 && globalThis.javaResult?.pass === true && !callbackError && await call('rawError') === 0, exit, java: globalThis.javaResult, checks, samples, callbackError, resources: backend.resources() };
} catch (error) {
    globalThis.result = { pass: false, error: String(error.stack || error), callbackError, checks, samples, resources: backend.resources() };
} finally {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    globalThis.completed = true;
}
