/* eslint-disable no-await-in-loop -- GPU submissions and readbacks must remain ordered. */
import { createSpriteNatives } from './sprite-webgl.js';

const canvas = document.querySelector('canvas');
const backend = createSpriteNatives(canvas);
const gl = canvas.getContext('webgl2');
/**
 * Calls the actual production JNI callback.
 *
 * @param {string} name - Graphics operation.
 * @param {...unknown} args - Declared native arguments.
 * @returns {Promise<unknown>} Actual browser result.
 */
const call = (name, ...args) => backend.natives[`Java_port_host_SpriteGraphics_${name}`](null, ...args);
const shaders = [];
const checks = [];
const samples = [];
let program;
let element;
let array;
let vao;

/**
 * Records a GPU or state requirement.
 *
 * @param {boolean} value - Required actual condition.
 * @param {string} label - Failure diagnostic.
 */
function check(value, label) {
    if (!value) {
        throw new Error(label);
    }

    checks.push(label);
}

/**
 * Reads the complete small actual framebuffer.
 *
 * @returns {number[]} Exact RGBA channels.
 */
function pixels() {
    const result = new Uint8Array(32);

    gl.readPixels(0, 0, 4, 2, gl.RGBA, gl.UNSIGNED_BYTE, result);

    return [...result];
}

/** Clears actual color storage without changing indexed draw state. */
function clear() {
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
}

try {
    program = gl.createProgram();

    for (const [type, source] of [
        [gl.VERTEX_SHADER, `#version 300 es
        precision highp float;
        flat out vec4 tint;
        void main() {
            vec2 positions[8]=vec2[8](vec2(-1,-1),vec2(0,-1),vec2(0,1),vec2(-1,1),vec2(0,-1),vec2(1,-1),vec2(1,1),vec2(0,1));
            int vertex=gl_VertexID%8;
            gl_Position=vec4(positions[vertex],0,1);
            tint=vertex==3?vec4(1,0,0,1):vertex==7?vec4(0,1,0,1):vec4(0,0,1,1);
        }`],
        [gl.FRAGMENT_SHADER, `#version 300 es
        precision highp float;
        flat in vec4 tint;
        out vec4 color;
        void main(){color=tint;}`],
    ]) {
        const shader = gl.createShader(type);

        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        check(gl.getShaderParameter(shader, gl.COMPILE_STATUS), gl.getShaderInfoLog(shader));
        gl.attachShader(program, shader);
    }

    gl.linkProgram(program);
    check(gl.getProgramParameter(program, gl.LINK_STATUS), gl.getProgramInfoLog(program));
    gl.useProgram(program);
    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    element = gl.createBuffer();
    array = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, array);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([123, 456]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, element);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 3, 4, 5, 6, 7]), gl.DYNAMIC_DRAW);
    gl.drawRangeElements(7, 0, 8, 8, gl.UNSIGNED_SHORT, 0);
    check(gl.getError() === gl.INVALID_ENUM, 'Untranslated original map mode is unsupported by raw WebGL');
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    gl.viewport(0, 0, 4, 2);
    const redGreen = Array.from({ length: 32 }, (_, i) => [(i >> 2) % 4 < 2 ? 255 : 0, (i >> 2) % 4 < 2 ? 0 : 255, 0, 255][i % 4]);

    for (const [Index, type] of [[Uint8Array, gl.UNSIGNED_BYTE], [Uint16Array, gl.UNSIGNED_SHORT], [Uint32Array, gl.UNSIGNED_INT]]) {
        for (const ranged of [false, true]) {
            const source = new Index([99, 99, 0, 1, 2, 3, 4, 5, 6, 7, 99, 99]);

            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, source, gl.DYNAMIC_DRAW);
            const before = [...new Uint8Array(source.buffer)];

            clear();

            if (ranged) {
                await call('drawRange', 7, 0, 8, 8, type, 2 * Index.BYTES_PER_ELEMENT);
            } else {
                await call('drawElements', 7, 8, type, 2 * Index.BYTES_PER_ELEMENT);
            }

            const actual = pixels();

            check(actual.every((value, i) => value === redGreen[i]), `Two complete indexed quads, winding and fourth provoking vertex: ${type}/${ranged}`);
            samples.push({ type, ranged, pixels: actual });
            check(gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING) === element, 'Original EBO restored');
            check(gl.getParameter(gl.ARRAY_BUFFER_BINDING) === array, 'Original VBO preserved');
            check(gl.getParameter(gl.VERTEX_ARRAY_BINDING) === vao, 'Original VAO preserved');
            check(gl.getParameter(gl.CURRENT_PROGRAM) === program, 'Current shader preserved');
            const after = new Uint8Array(source.byteLength);

            gl.getBufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, after);
            check(after.every((value, i) => value === before[i]), 'Original index bytes unchanged');
            check(await call('rawError') === gl.NO_ERROR, 'Translated indexed draw has no error');
        }
    }

    for (const [Index, type, base] of [[Uint8Array, gl.UNSIGNED_BYTE, 252], [Uint16Array, gl.UNSIGNED_SHORT, 65_532], [Uint32Array, gl.UNSIGNED_INT, 65_532]]) {
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Index([base, base + 1, base + 2, base + 3]), gl.DYNAMIC_DRAW);
        clear();
        await call('drawRange', 7, base, base + 3, 4, type, 0);
        const actual = pixels();

        check(actual.every((value, i) => value === [0, (i >> 2) % 4 < 2 ? 0 : 255, 0, 255][i % 4]), `Maximum byte/short vertex is not primitive restart: ${type}`);
        check(await call('rawError') === gl.NO_ERROR, 'Widened indices have no error');
    }

    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 3, 4, 5]), gl.DYNAMIC_DRAW);
    clear();
    await call('drawElements', 7, 6, gl.UNSIGNED_SHORT, 0);
    check(pixels().every((value, i) => value === [(i >> 2) % 4 < 2 ? 255 : 0, 0, 0, 255][i % 4]), 'Incomplete trailing quad is ignored');
    await call('drawRange', 7, 9, 1, 4, gl.UNSIGNED_SHORT, 0);
    check(await call('rawError') === gl.INVALID_VALUE, 'Reversed inclusive range rejects before index conversion');
    await call('drawElements', 7, -1, gl.UNSIGNED_SHORT, 0);
    check(await call('rawError') === gl.INVALID_VALUE, 'Negative count retains GL error');
    await call('drawElements', 7, 4, gl.FLOAT, 0);
    check(await call('rawError') === gl.INVALID_ENUM, 'Invalid index type retains GL error');
    await call('drawElements', 7, 4, gl.UNSIGNED_SHORT, 1);
    check(await call('rawError') === gl.INVALID_OPERATION, 'Misaligned byte offset retains GL error');
    await call('drawElements', 7, 8, gl.UNSIGNED_SHORT, 0);
    check(await call('rawError') === gl.INVALID_OPERATION, 'Out-of-store index range rejects without mutation');
    check(gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING) === element, 'Rejected draws preserve original element binding');
    await cheerpjInit({
        version: 17, status: 'none', natives: {
            ...backend.natives,
            /**
             * Supplies original Java ABI qualification state.
             *
             * @param {object} _lib - Original Java library.
             * @param {number} variant - Ordinary indices or a reserved index in the first/later chunk.
             */
            Java_IndexedQuadQualification_setup(_lib, variant) {
                let source = new Uint16Array([0, 1, 2, 3, 4, 5, 6, 7]);

                if (variant !== 0) {
                    source = new Uint32Array(variant === 1 ? 4 : 4_100);
                    source.fill(0xFF_FF_FF_FF, source.length - 4);
                }

                gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, source, gl.DYNAMIC_DRAW);
            },
            /**
             * Supplies original Java ABI qualification state.
             *
             * @param {object} _lib - Original Java library.
             * @param {number} count - Passed original Java assertions.
             */
            Java_IndexedQuadQualification_report(_lib, count) {
                globalThis.javaChecks = count;
            },
        },
    });
    const exit = await cheerpjRunMain('IndexedQuadQualification', '/app/qualification.jar:/app/sprite-view.jar');

    check(exit === 0 && globalThis.javaChecks === 8, 'Actual vendor quad draw and unsupported-index Java catch/finally');
    check(pixels().every((value, i) => value === redGreen[i]), 'Actual original vendor map-signature draw fills both quads');
    check(gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING) === element, 'Actual Java error paths preserve element binding');
    check(await call('rawError') === gl.NO_ERROR, 'Final GL error queue empty');
    globalThis.result = { pass: true, checks: checks.length, javaChecks: globalThis.javaChecks, samples };
} catch (error) {
    globalThis.result = { pass: false, error: String(error.stack || error), checks };
} finally {
    gl.bindVertexArray(null);

    if (element) {
        gl.deleteBuffer(element);
    }

    if (array) {
        gl.deleteBuffer(array);
    }

    if (vao) {
        gl.deleteVertexArray(vao);
    }

    if (program) {
        gl.deleteProgram(program);
    }

    for (const shader of shaders) {
        gl.deleteShader(shader);
    }

    gl.getExtension('WEBGL_lose_context')?.loseContext();
    globalThis.completed = true;
}
