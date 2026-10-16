globalThis.window = globalThis;
globalThis.portKeyboardCodes = new Set();
let module;
let started = false;
let pending = '';
const lines = [];

importScripts('/wasm/classes.wasm-runtime.js');
/**
 * Handles the next message from the owned runtime.
 *
 * @param {MessageEvent} event - Message or error delivered by the owned worker.
 */
globalThis.addEventListener('message', async (event) => {
    const message = event.data;

    try {
        if (message.type === 'key') {
            if (message.down) {
                globalThis.portKeyboardCodes.add(message.code);
            } else {
                globalThis.portKeyboardCodes.delete(message.code);
            }

            return;
        }

        if (message.type === 'blur') {
            globalThis.portKeyboardCodes.clear();

            return;
        }

        if (message.type === 'frames') {
            if (!module || typeof module.exports.pollInput !== 'function' || !Number.isInteger(message.count)
                || message.count < 1 || message.count > 2) {
                throw new Error('Invalid original input frame request');
            }

            for (let frame = 0; frame < message.count; frame++) {
                module.exports.pollInput();
            }

            if (message.id !== undefined) {
                self.postMessage({ id: message.id, value: true });
            }

            return;
        }

        if (message.type === 'query') {
            if (!module) {
                throw new Error('Keyboard runtime is not ready');
            }

            self.postMessage({ id: message.id, value: message.state ? module.exports.queryState(message.key) : module.exports.queryKey(message.key) });

            return;
        }

        if (message.type !== 'start' || started) {
            throw new Error('Expected one keyboard runtime start');
        }

        started = true;
        globalThis.portGraphicsCanvas = message.canvas;
        module = await globalThis.TeaVM.wasmGC.load('/wasm/probe.wasm', {
            /**
             * Installs the host functions used by the compiled WebAssembly runtime.
             *
             * @param {WebAssembly.Imports} imports - Imports populated for the compiled runtime.
             */
            installImports(imports) {
                imports.portNative = {
                    /**
                     * Reports the unavailable Steam Workshop capability.
                     */
                    steamWorkshopFolders() {
                        throw new Error('Steam Workshop is unavailable in this browser host');
                    },
                };
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

        if (!(module.instance instanceof WebAssembly.Instance) || lines.length !== 1 || pending) {
            throw new Error('Invalid keyboard runtime result');
        }

        self.postMessage({ ready: true, result: JSON.parse(lines[0]), windowHandle: module.exports.windowHandle() });
    } catch (error) {
        self.postMessage({ error: String(error.stack || error), stdout: lines, pending });
    }
});
