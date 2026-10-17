/* eslint-disable no-await-in-loop -- Original shader compilation and resource disposal are ordered. */
import { createSpriteNatives } from './sprite-webgl.js';

const canvas = document.querySelector('canvas');
const backend = createSpriteNatives(canvas);
const gl = canvas.getContext('webgl2');
/**
 * Invokes the same native callback used by the Java graphics facade.
 *
 * @param {string} name - Host operation name.
 * @param {...unknown} args - Declared operation arguments.
 * @returns {Promise<unknown>} Actual browser operation result.
 */
const call = (name, ...args) =>
    backend.natives[`Java_port_host_SpriteGraphics_${name}`](null, ...args);
const shaders = [];
const resources = [];
let program;
let texture;
const rows = [];

/**
 * Records an actual GPU or state assertion.
 *
 * @param {boolean} ok - Required result.
 * @param {string} label - Diagnostic description.
 */
function check(ok, label) {
    if (!ok) {
        throw new Error(label);
    }

    rows.push(label);
}

/**
 * Reads both normalized RGBA pixels.
 *
 * @returns {number[]} Eight exact channel values.
 */
function pixels() {
    const x = new Uint8Array(8);

    gl.readPixels(0, 0, 2, 1, gl.RGBA, gl.UNSIGNED_BYTE, x);

    return [...x];
}

try {
    program = await call('glCreateProgram');

    for (const [stage, file] of [
        [gl.VERTEX_SHADER, 'default.vert'],
        [gl.FRAGMENT_SHADER, 'default.frag'],
    ]) {
        const shader = await call('glCreateShader', stage);

        shaders.push(shader);
        await call(
            'shaderText',
            shader,
            await (await fetch(`/original-shaders/${file}`)).text(),
        );
        await call('glCompileShader', shader);
        check(
            await call('glGetShaderi', shader, gl.COMPILE_STATUS),
            `Original ${file} compiles`,
        );
        await call('glAttachShader', program, shader);
    }

    await call('glLinkProgram', program);
    check(
        await call('glGetProgrami', program, gl.LINK_STATUS),
        'Actual original default pair links',
    );
    await call('glUseProgram', program);
    const actual = gl.getParameter(gl.CURRENT_PROGRAM);

    gl.uniformMatrix4fv(
        gl.getUniformLocation(actual, 'ModelViewProjection'),
        false,
        new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    );
    gl.uniform1i(gl.getUniformLocation(actual, 'useTexture'), 1);
    gl.uniform1i(gl.getUniformLocation(actual, 'DIFFUSE'), 0);
    const buffer = gl.createBuffer();

    resources.push(buffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 3, -1, -1, 3]),
        gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.disableVertexAttribArray(1);
    gl.vertexAttrib2f(1, 0.5, 0.5);
    gl.disableVertexAttribArray(2);
    gl.vertexAttrib4f(2, 0.5, 0.5, 0.5, 0.5);
    texture = gl.createTexture();

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        1,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array([128, 64, 32, 128]),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.viewport(0, 0, 2, 1);
    gl.clearColor(0, 0, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, 1, 1);
    await call('glEnable', 3_008);
    await call('glAlphaFunc', 516, 0.3);
    await call('glDrawArrays', 4, 0, 3);
    check(
        pixels().join() === '0,0,255,255,0,0,255,255',
        'Original multiplied alpha .25 fails reference .3',
    );
    await call('glAlphaFunc', 516, 0.2);
    await call('glDrawArrays', 4, 0, 3);
    check(
        pixels().join() === '64,32,16,64,0,0,255,255',
        'Original shader RGBA texture times vertex color and scissor exact pixels',
    );
    /**
     * Snapshots unrelated real WebGL state for preservation checks.
     *
     * @returns {string} Serialized scissor, active unit and viewport.
     */
    const state = () =>
        JSON.stringify({
            scissor: [...gl.getParameter(gl.SCISSOR_BOX)],
            scissorEnabled: gl.isEnabled(gl.SCISSOR_TEST),
            active: gl.getParameter(gl.ACTIVE_TEXTURE),
            viewport: [...gl.getParameter(gl.VIEWPORT)],
        });
    const initial = state();

    await cheerpjInit({
        version: 17,
        status: 'none',
        natives: {
            ...backend.natives,
            /**
             * Verifies state after each actual original vendor texture-environment call.
             */
            async Java_TextureEnvQualification_unchanged() {
                check(
                    gl.getParameter(gl.CURRENT_PROGRAM) === actual,
                    'Texture-env call preserves actual current program',
                );
                check(
                    state() === initial,
                    'Texture-env call preserves scissor/active unit/viewport',
                );
                check(
                    await call('glIsEnabled', 3_008),
                    'Texture-env call preserves alpha enable',
                );
            },
            /**
             * Records the completed Java semantic assertions.
             *
             * @param {object} lib - Actual Java callback namespace.
             * @param {number} count - Passed Java assertion count.
             */
            Java_TextureEnvQualification_report(lib, count) {
                globalThis.javaChecks = count;
            },
        },
    });
    globalThis.exit = await cheerpjRunMain(
        'TextureEnvQualification',
        '/app/qualification.jar:/app/sprite-view.jar',
    );
    check(
        globalThis.exit === 0 && globalThis.javaChecks === 18,
        'Actual original vendor TexEnvi Java ABI and exceptions pass',
    );
    gl.clearColor(0, 0, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    await call('glDrawArrays', 4, 0, 3);
    check(
        pixels().join() === '64,32,16,64,0,0,255,255',
        'Exact RGBA modulation remains after original JNI envcalls',
    );
    check((await call('rawError')) === 0, 'No residual GL error');
    globalThis.result = {
        pass: true,
        javaChecks: globalThis.javaChecks,
        checks: rows.length,
        pixels: pixels(),
    };
} catch (e) {
    globalThis.result = {
        pass: false,
        error: String(e.stack || e),
        javaChecks: globalThis.javaChecks,
        checks: rows,
    };
} finally {
    if (texture) {
        gl.deleteTexture(texture);
    }

    for (const s of shaders) {
        await call('glDeleteShader', s);
    }

    if (program) {
        await call('glDeleteProgram', program);
    }

    for (const b of resources) {
        gl.deleteBuffer(b);
    }

    gl.getExtension('WEBGL_lose_context')?.loseContext();
    globalThis.completed = true;
}
