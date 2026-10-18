import { createSpriteNatives } from './sprite-webgl.js';

const canvas = document.querySelector('canvas');
const previousTitle = document.title;
const backend = createSpriteNatives(canvas);
const gl = canvas.getContext('webgl2');
const titles = [];
const original = backend.natives.Java_port_host_SpriteGraphics_setTitle;
const initialViewport = [...gl.getParameter(gl.VIEWPORT)];
let checks = 0;
let statePreserved = true;

/**
 * Records real title calls without changing their arguments or result.
 *
 * @param {object} lib - Actual Java native library.
 * @param {string} title - Vendor title.
 * @returns {Promise<void>} Original callback completion.
 */
backend.natives.Java_port_host_SpriteGraphics_setTitle = async (lib, title) => {
    titles.push(title);
    await original(lib, title);
};

try {
    await cheerpjInit({
        version: 17, status: 'none', natives: {
            ...backend.natives,
            /**
             * Observes DOM state and graphics independence after the original vendor call.
             *
             * @param {object} _lib - Native callback library.
             * @param {string} expected - Expected actual document title.
             * @param {number} calls - Expected original host call count.
             * @returns {boolean} Whether actual state matches.
             */
            Java_DisplayTitleQualification_observe(_lib, expected, calls) {
                const actual = document.title === expected && document.querySelector('title').textContent === expected;

                if (!gl.isContextLost()) {
                    statePreserved &&= gl.getParameter(gl.CURRENT_PROGRAM) === null
                        && [...gl.getParameter(gl.VIEWPORT)].every((value, i) => value === initialViewport[i])
                        && gl.getError() === gl.NO_ERROR;
                }

                return actual && titles.length === calls && statePreserved;
            },
            /**
             * Applies actual owner connection changes for lifecycle qualification.
             *
             * @param {object} _lib - Native callback library.
             * @param {boolean} connected - Requested DOM connection.
             */
            Java_DisplayTitleQualification_attach(_lib, connected) {
                if (connected) {
                    document.body.append(canvas);
                } else {
                    canvas.remove();
                }
            },
            /**
             * Waits for actual context loss before testing the original cache-only branch.
             *
             * @returns {Promise<void>} Actual context-loss event.
             */
            async Java_DisplayTitleQualification_loseContext() {
                await new Promise((resolve) => {
                    canvas.addEventListener('webglcontextlost', resolve, { once: true });
                    gl.getExtension('WEBGL_lose_context').loseContext();
                });
            },
            /**
             * Records completed original Java assertions.
             *
             * @param {object} _lib - Native callback library.
             * @param {number} count - Completed checks.
             */
            Java_DisplayTitleQualification_report(_lib, count) {
                checks = count;
            },
        },
    });
    const exit = await cheerpjRunMain('DisplayTitleQualification', '/app/qualification.jar:/app/sprite-view.jar');

    globalThis.result = { pass: exit === 0 && checks === 12 && statePreserved, exit, checks, titles, statePreserved, resources: backend.resources() };
} catch (error) {
    globalThis.result = { pass: false, error: String(error.stack || error), titles };
} finally {
    if (!canvas.isConnected) {
        document.body.append(canvas);
    }

    document.title = previousTitle;
    globalThis.result.titleRestored = document.title === previousTitle;
    globalThis.completed = true;
}
