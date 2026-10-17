import { createSpriteNatives } from './sprite-webgl.js';

const canvas = document.querySelector('canvas');
const backend = createSpriteNatives(canvas);
const gl = canvas.getContext('webgl2');
const shaders = [];
const ranges = [];
const mipmaps = [];
const observedTextures = new Set();
const mipmapCalls = [];
const generate = backend.natives.Java_port_host_SpriteGraphics_glGenerateMipmap;
let program;
let callbackError;

/**
 * Records the actual original mipmap calls while preserving their execution.
 *
 * @param {object} lib - Java native library.
 * @param {number} target - Original texture target.
 * @returns {Promise<unknown>} Original native completion.
 */
backend.natives.Java_port_host_SpriteGraphics_glGenerateMipmap = async (lib, target) => {
    mipmapCalls.push(target);

    return await generate(lib, target);
};

try {
    program = gl.createProgram();

    for (const [type, source] of [
        [gl.VERTEX_SHADER, '#version 300 es\nvoid main(){vec2 p[3]=vec2[3](vec2(-1,-1),vec2(3,-1),vec2(-1,3));gl_Position=vec4(p[gl_VertexID],0,1);}'],
        [gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float;out vec4 color;void main(){color=vec4(gl_FragCoord.z,0,0,1);}'],
    ]) {
        const shader = gl.createShader(type);

        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);

        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            throw new Error(gl.getShaderInfoLog(shader));
        }

        gl.attachShader(program, shader);
    }

    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program));
    }

    await cheerpjInit({
        version: 17, status: 'none', natives: {
            ...backend.natives,
            /**
             * Observes actual original Java depth/FBO behavior.
             *
             * @param {object} _lib - Java callback library.
             * @param {number} near - Expected near depth.
             * @param {number} far - Expected far depth.
             * @returns {boolean} Whether actual driver state matches.
             */
            Java_DepthMipmapQualification_depth(_lib, near, far) {
                const actual = [...gl.getParameter(gl.DEPTH_RANGE)];

                ranges.push(actual);

                return actual[0] === Math.fround(near) && actual[1] === Math.fround(far);
            },
            /**
             * Observes actual original Java depth/FBO behavior.
             *
             * @param {object} _lib - Java callback library.
             * @param {number} red - Expected exact depth-encoded channel.
             * @returns {boolean} Whether all actual GPU pixels match.
             */
            Java_DepthMipmapQualification_depthPixels(_lib, red) {
                gl.useProgram(program);
                gl.viewport(0, 0, 4, 2);
                gl.disable(gl.DEPTH_TEST);
                gl.disable(gl.SCISSOR_TEST);
                gl.clearColor(0, 0, 0, 1);
                gl.clear(gl.COLOR_BUFFER_BIT);
                gl.drawArrays(gl.TRIANGLES, 0, 3);
                const actual = new Uint8Array(32);

                gl.readPixels(0, 0, 4, 2, gl.RGBA, gl.UNSIGNED_BYTE, actual);

                return actual.every((value, i) => value === [red, 0, 0, 255][i % 4]);
            },
            /**
             * Observes actual original Java depth/FBO behavior.
             *
             * @param {object} _lib - Java callback library.
             * @param {number} texture - Original allocated texture identifier.
             * @param {boolean} blue - Whether to expect the blue redraw.
             * @returns {Promise<boolean>} Whether real generated mip levels match.
             */
            async Java_DepthMipmapQualification_mipPixels(_lib, texture, blue) {
                const draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
                const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
                const framebuffer = gl.createFramebuffer();

                try {
                    await backend.natives.Java_port_host_SpriteGraphics_glBindTexture(null, gl.TEXTURE_2D, texture);
                    const actualTexture = gl.getParameter(gl.TEXTURE_BINDING_2D);

                    observedTextures.add(actualTexture);
                    const levels = [];

                    mipmaps.push({ blue, levels });

                    for (const [level, size] of [[1, 2], [2, 1]]) {
                        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
                        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, actualTexture, level);

                        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
                            return false;
                        }

                        const pixels = new Uint8Array(size * size * 4);

                        gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                        levels.push([...pixels]);

                        if (!pixels.every((value, i) => {
                            if (blue) {
                                return value === [0, 0, 255, 255][i % 4];
                            }

                            if (level === 2) {
                                return value === [127, 127, 0, 255][i % 4];
                            }

                            return value === [i < 8 ? 254 : 0, i < 8 ? 0 : 254, 0, 255][i % 4];
                        })) {
                            return false;
                        }
                    }

                    return true;
                } catch (error) {
                    callbackError = String(error.stack || error);

                    return false;
                } finally {
                    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw);
                    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
                    gl.deleteFramebuffer(framebuffer);
                }
            },
            /**
             * Observes actual original Java depth/FBO behavior.
             *
             * @param {object} _lib - Java callback library.
             * @param {string} text - Original Java result JSON.
             */
            Java_DepthMipmapQualification_report(_lib, text) {
                globalThis.javaResult = JSON.parse(String(text));
            },
        },
    });
    const exit = await cheerpjRunMain('DepthMipmapQualification', '/app/qualification.jar:/app/sprite-view.jar');
    const resources = backend.resources();
    const remaining = resources.textures + resources.framebuffers;
    const texturesDeleted = [...observedTextures].every((texture) => !gl.isTexture(texture));
    const error = await backend.natives.Java_port_host_SpriteGraphics_rawError(null);

    globalThis.result = { pass: exit === 0 && globalThis.javaResult?.pass === true && mipmaps.length === 2 && remaining === 0 && texturesDeleted && error === 0, java: globalThis.javaResult, exit, ranges, mipmaps, mipmapCalls, resources, texturesDeleted, error, callbackError };
} catch (error) {
    globalThis.result = { pass: false, error: String(error.stack || error), ranges, mipmaps, mipmapCalls, callbackError };
} finally {
    if (program) {
        gl.deleteProgram(program);
    }

    for (const shader of shaders) {
        gl.deleteShader(shader);
    }

    gl.getExtension('WEBGL_lose_context')?.loseContext();
    globalThis.completed = true;
}
