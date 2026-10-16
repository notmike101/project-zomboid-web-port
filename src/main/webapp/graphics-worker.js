// Each worker owns one Java runtime and the transferred canvas.
globalThis.window = globalThis;
let module;
const lines = [];
let pending = '';

importScripts('/wasm/classes.wasm-runtime.js');
/**
 * Handles the next message from the owned runtime.
 *
 * @param {MessageEvent} event - Message or error delivered by the owned worker.
 */
globalThis.addEventListener('message', async (event) => {
    const { id, type, canvas, resources, values } = event.data;

    try {
        if (type === 'start') {
            if (module) {
                throw new Error('Runtime already started');
            }

            globalThis.portGraphicsCanvas = canvas;
            globalThis.portGraphicsCanvas.addEventListener('webglcontextlost', () => {
                self.postMessage({ type: 'failure', error: 'Worker WebGL context lost' });
            });

            if (resources) {
                importScripts('/resource-host.js');
            }

            module = await globalThis.TeaVM.wasmGC.load('/wasm/probe.wasm', {
                /**
                 * Installs the host functions used by the compiled WebAssembly runtime.
                 *
                 * @param {WebAssembly.Imports} imports - Imports populated for the compiled runtime.
                 */
                installImports(imports) {
                    imports.teavmConsole = {
                    /**
                     * Collects one character of the original runtime stdout.
                     *
                     * @param {number} c - Character code emitted by the runtime.
                     */
                        putcharStdout(c) {
                            if (c === 10) {
                                lines.push(pending);
                                pending = '';
                            } else {
                                pending += String.fromCharCode(c);
                            }
                        },
                        /**
                         * Rejects unexpected output on the runtime stderr channel.
                         *
                         * @param {number} c - Character code emitted by the runtime.
                         */
                        putcharStderr(c) {
                            throw new Error(`WASM stderr character: ${c}`);
                        },
                    };
                },
            });
            await module.exports.main([]);
            const deadline = performance.now() + 15_000;

            while (!lines.length && performance.now() < deadline) {
                // eslint-disable-next-line no-await-in-loop -- Wait for this cooperative runtime operation before polling the same deadline again.
                await new Promise((resolve) => {
                    setTimeout(resolve, 10);
                });
            }

            if (lines.length !== 1 || pending) {
                throw new Error('Expected one worker result');
            }

            const result = JSON.parse(lines[0]);
            const webgl2 = globalThis.portGraphicsCanvas.getContext('webgl2') instanceof WebGL2RenderingContext;

            self.postMessage({ id, result: { result, webgl2 } });
        } else if (type === 'render') {
            if (!module) {
                throw new Error('Runtime is not ready');
            }

            self.postMessage({ id, result: JSON.parse(module.exports.renderColor(...values)) });
        } else {
            throw new Error('Unknown worker operation');
        }
    } catch (error) {
        self.postMessage({ id, type: 'failure', error: String(error.stack || error), stdout: lines, pending });
    }
});
