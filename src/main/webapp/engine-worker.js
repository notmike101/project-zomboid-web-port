// One isolated runtime; filesystem writes remain inside its virtual filesystem.
globalThis.window = globalThis;
globalThis.portOwnedRuntime = true;
let started = false;
let pending = '';
const lines = [];
/**
 * Reports a runtime failure and stops the owned operation.
 *
 * @param {unknown} error - Failure reported by the runtime.
 * @returns {void} No return value.
 */
const fail = (error) => self.postMessage({ error: String(error?.stack || error), stdout: lines, pending });

self.addEventListener('error', (event) => fail(event.error || event.message));
self.addEventListener('unhandledrejection', (event) => fail(event.reason));
importScripts('/wasm/classes.wasm-runtime.js');
/**
 * Handles the next message from the owned runtime.
 *
 * @param {MessageEvent} event - Message or error delivered by the owned worker.
 */
globalThis.addEventListener('message', async (event) => {
    try {
        if (started) {
            throw new Error('Runtime already started');
        }

        started = true;
        globalThis.portGraphicsCanvas = event.data.canvas;
        importScripts('/resource-host.js');
        importScripts('/generic-host.js');
        const assetResponse = await fetch('/asset-manifest.json');

        if (!assetResponse.ok) {
            throw new Error(`Asset manifest HTTP ${assetResponse.status}`);
        }

        globalThis.portAssetManifest = await assetResponse.json();
        globalThis.portAssetFiles = new Map();

        for (const entry of globalThis.portAssetManifest) {
            if (typeof entry.path !== 'string' || !(entry.path.startsWith('/media/') || entry.path === '/stdlib.lua')
                || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 1_024 * 1_024
                || !/^[\da-f]{64}$/.test(entry.sha256) || globalThis.portAssetFiles.has(entry.path)) {
                throw new Error('Invalid asset manifest entry');
            }

            // eslint-disable-next-line no-await-in-loop -- Verify and publish this manifest entry before advancing to the next asset.
            const response = await fetch(`/asset?path=${encodeURIComponent(entry.path)}`);

            if (!response.ok) {
                throw new Error(`Asset HTTP ${response.status}`);
            }

            // eslint-disable-next-line no-await-in-loop -- Verify and publish this manifest entry before advancing to the next asset.
            const bytes = new Uint8Array(await response.arrayBuffer());
            // eslint-disable-next-line no-await-in-loop -- Verify and publish this manifest entry before advancing to the next asset.
            const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
            const hash = Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('');

            if (bytes.length !== entry.size || hash !== entry.sha256) {
                throw new Error('Asset integrity mismatch');
            }

            globalThis.portAssetFiles.set(entry.path, bytes);
        }

        const module = await globalThis.TeaVM.wasmGC.load('/wasm/probe.wasm', {
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

                        if (pending.length > 65_536 || lines.length > 1_024) {
                            throw new Error('Engine stdout exceeds limit');
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

        if (!(module.instance instanceof WebAssembly.Instance)) {
            throw new TypeError('No WASM instance');
        }

        await module.exports.main([]);
        const deadline = performance.now() + 15_000;

        while (!lines.length && performance.now() < deadline) {
            // eslint-disable-next-line no-await-in-loop -- Wait for this cooperative runtime operation before polling the same deadline again.
            await new Promise((resolve) => {
                setTimeout(resolve, 10);
            });
        }

        if (pending) {
            throw new Error('Incomplete engine stdout');
        }

        const results = lines.filter((line) => line.trimStart().startsWith('{')).map((line) => JSON.parse(line));

        if (results.length !== 1 || !Array.isArray(results[0].cases) || typeof results[0].pass !== 'boolean') {
            throw new Error('Expected one complete engine result');
        }

        self.postMessage({ result: results[0], stdout: lines, wasmInstance: true });
    } catch (error) {
        fail(error);
    }
});
