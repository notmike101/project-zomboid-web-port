// This worker owns exactly one Java runtime and its process-exit boundary.
globalThis.window = globalThis;
globalThis.portOwnedRuntime = true;
globalThis.portExited = false;
let started = false;
let pending = '';
const lines = [];

/**
 * Recognizes and reports the expected nonreturning worker exit trap.
 *
 * @param {unknown} error - Failure reported by the runtime.
 * @returns {boolean} Whether this is the expected worker exit trap.
 */
function expectedExitTrap(error) {
    if (globalThis.portExited !== true || !(error instanceof WebAssembly.RuntimeError)) {
        return false;
    }

    if (!globalThis.portTrapObserved) {
        globalThis.portTrapObserved = true;
        self.postMessage({ type: 'exit-trap', errorName: error.name, errorMessage: String(error.message) });
    }

    return true;
}

/**
 * Reports a runtime failure and stops the owned operation.
 *
 * @param {unknown} error - Failure reported by the runtime.
 */
function fail(error) {
    self.postMessage({ type: 'failure', error: String(error?.stack || error), stdout: lines, pending });
}

self.addEventListener('error', (event) => {
    if (expectedExitTrap(event.error)) {
        event.preventDefault();
    } else {
        fail(event.error || event.message);
    }
});
self.addEventListener('unhandledrejection', (event) => {
    if (expectedExitTrap(event.reason)) {
        event.preventDefault();
    } else {
        fail(event.reason);
    }
});

importScripts('/wasm/classes.wasm-runtime.js');
/**
 * Handles the next message from the owned runtime.
 *
 * @param {MessageEvent} event - Message or error delivered by the owned worker.
 */
globalThis.addEventListener('message', async (event) => {
    try {
        if (event.data?.type !== 'start' || started) {
            throw new Error('Expected one worker start');
        }

        started = true;
        self.postMessage({ type: 'status', status: 'loading' });
        const module = await globalThis.TeaVM.wasmGC.load('/wasm/probe.wasm', {
            /**
             * Installs the host functions used by the compiled WebAssembly runtime.
             *
             * @param {WebAssembly.Imports} imports - Imports populated for the compiled runtime.
             */
            installImports(imports) {
                const offer = imports.teavmAsync?.offer;

                if (typeof offer !== 'function') {
                    throw new TypeError('Expected TeaVM asynchronous scheduler');
                }

                // close() discards future tasks, so observe the trap inside the active fiber callback.
                /**
                 * Wraps a scheduled fiber so its expected process-exit trap is observed.
                 *
                 * @param {unknown} fiber - Fiber supplied by the runtime scheduler.
                 * @param {(...args: unknown[]) => unknown} callback - Original scheduled fiber callback.
                 * @param {number} deadline - Scheduler deadline in milliseconds.
                 * @returns {void} No return value.
                 */
                imports.teavmAsync.offer = (fiber, callback, deadline) => offer(fiber, (...args) => {
                    try {
                        return callback(...args);
                    } catch (error) {
                        if (!expectedExitTrap(error)) {
                            throw error;
                        }
                    }
                }, deadline);
                imports.teavmConsole = {
                /**
                 * Collects one character of the original runtime stdout.
                 *
                 * @param {number} character - Character code emitted by the runtime.
                 */
                    putcharStdout(character) {
                        if (character === 10) {
                            lines.push(pending);
                            self.postMessage({ type: 'stdout', line: pending });
                            pending = '';
                        } else {
                            pending += String.fromCharCode(character);
                        }
                    },
                    /**
                     * Rejects unexpected output on the runtime stderr channel.
                     *
                     * @param {number} character - Character code emitted by the runtime.
                     */
                    putcharStderr(character) {
                        throw new Error(`WASM stderr character: ${character}`);
                    },
                };
            },
        });

        if (!(module.instance instanceof WebAssembly.Instance)) {
            throw new TypeError('Expected a real WASM instance');
        }

        self.postMessage({ type: 'status', status: 'wasm-ready', wasmInstance: true });
        await module.exports.main([]);
        // The export returns while a Java fiber is sleeping. Its return is not Java main completion.
        const deadline = performance.now() + 15_000;

        while (!globalThis.portExited) {
            if (performance.now() >= deadline) {
                throw new Error('Java worker did not exit before deadline');
            }

            // eslint-disable-next-line no-await-in-loop -- Wait for this cooperative runtime operation before polling the same deadline again.
            await new Promise((resolve) => {
                setTimeout(resolve, 10);
            });
        }
    } catch (error) {
        if (!expectedExitTrap(error)) {
            fail(error);
        }
    }
});
