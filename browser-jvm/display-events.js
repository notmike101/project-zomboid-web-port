import { createCustomCursors } from './custom-cursor.js';

/**
 * Owns browser window observations while reusing the existing keyboard and mouse owners.
 *
 * @param {HTMLCanvasElement} canvas - Existing connected graphics owner.
 * @param {object} keyboard - Existing opt-in text event owner and focus snapshot.
 * @returns {object} Native callbacks, observations and disposal.
 */
export function createDisplayEvents(canvas, keyboard) {
    const cursors = createCustomCursors(canvas);
    const gl = canvas.getContext('webgl2');
    let closed = false;
    let snapshot = null;
    let pumps = 0;
    let modes = 0;

    /**
     * Rejects calls after actual surface or service destruction.
     *
     * @param {object} lib - Java native callback library.
     */
    async function live(lib) {
        if (closed || !canvas.isConnected || gl.isContextLost()) {
            throw await new (await lib.java.lang.IllegalStateException)('Display event surface is closed');
        }
    }

    /**
     * Rejects pointer lock before the original Java cursor cache changes.
     *
     * @param {object} lib - Java native callback library.
     */
    async function supportedCursor(lib) {
        await live(lib);

        if (document.pointerLockElement !== null) {
            throw await new (await lib.java.lang.UnsupportedOperationException)('Pointer lock/relative cursor is unqualified');
        }
    }

    return {
        natives: {
            ...cursors.natives,
            /**
             * Samples actual DOM state and runs the original callback nestmates.
             *
             * @param {object} lib - Java native callback library.
             */
            async Java_port_host_BrowserDisplayEvents_pollEvents(lib) {
                await live(lib);
                // A real DOM task, deliberately independent of rAF/background repaint availability.
                await new Promise((resolve) => {
                    setTimeout(resolve, 0);
                });
                await live(lib);
                const rect = canvas.getBoundingClientRect();
                const style = getComputedStyle(canvas);
                const current = {
                    width: canvas.width, height: canvas.height,
                    framebufferWidth: gl.drawingBufferWidth, framebufferHeight: gl.drawingBufferHeight,
                    x: Math.round(rect.x), y: Math.round(rect.y),
                    visible: !document.hidden && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0,
                    focused: document.hasFocus() && !document.hidden && keyboard.snapshot().focused,
                };
                const dirty = snapshot === null || ['width', 'height', 'framebufferWidth', 'framebufferHeight', 'x', 'y', 'visible']
                    .some((name) => current[name] !== snapshot[name]);

                snapshot = current;
                const Display = await lib.org.lwjglx.opengl.Display;

                await Display.browserPublishEvents(current.width, current.height, current.framebufferWidth,
                    current.framebufferHeight, current.x, current.y, current.visible ? 1 : 0, dirty ? 1 : 0);
                pumps++;
            },
            /**
             * Returns the focused attribute of the same owned input surface.
             *
             * @param {object} lib - Java native callback library.
             * @param {number|bigint} window - Original zero browser window identifier.
             * @param {number} attribute - Requested GLFW attribute.
             * @returns {Promise<number>} Actual latched focused state.
             */
            async Java_port_host_BrowserDisplayEvents_windowAttrib(lib, window, attribute) {
                await live(lib);

                if ((window !== 0 && window !== 0n) || attribute !== 131_073) {
                    throw await new (await lib.java.lang.UnsupportedOperationException)('Only owned browser GLFW_FOCUSED query is qualified');
                }

                if (snapshot === null) {
                    throw await new (await lib.java.lang.IllegalStateException)('Display events have not been sampled');
                }

                return snapshot.focused ? 1 : 0;
            },
            /**
             * Validates actual browser cursor support without changing its state.
             *
             * @param {object} lib - Java native callback library.
             */
            async Java_port_host_BrowserDisplayEvents_checkSurfaceCursor(lib) {
                await supportedCursor(lib);
            },
            /**
             * Applies an admitted normal or hidden CSS cursor to the owned canvas.
             *
             * @param {object} lib - Java native callback library.
             * @param {number|bigint} window - Original zero browser window identifier.
             * @param {number} selector - Requested GLFW input selector.
             * @param {number} value - Requested cursor mode.
             */
            async Java_port_host_BrowserDisplayEvents_setInputMode(lib, window, selector, value) {
                await supportedCursor(lib);

                if ((window !== 0 && window !== 0n) || selector !== 208_897 || ![212_993, 212_994].includes(value)) {
                    throw await new (await lib.java.lang.UnsupportedOperationException)('Only normal/hidden owned browser cursor is qualified');
                }

                await cursors.setMode(lib, value);

                modes++;
            },
        },
        /**
         * Reports the shared image owner without changing state.
         *
         * @returns {object} Image diagnostics.
         */
        cursorSnapshot: () => cursors.snapshot(),
        /**
         * Reports actual window observations and lifecycle counters.
         *
         * @returns {object} Display diagnostics.
         */
        snapshot: () => ({ ...snapshot, pumps, modes, closed, cursor: canvas.style.cursor }),
        /**
         * Releases this service and restores the prior owned cursor style.
         *
         */
        dispose() {
            closed = true;
            cursors.dispose();
        },
    };
}
