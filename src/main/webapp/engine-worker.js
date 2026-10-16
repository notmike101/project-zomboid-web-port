// One isolated runtime; filesystem writes remain inside its virtual filesystem.
self.window = self;
self.portOwnedRuntime = true;
let started = false;
let pending = '';
const lines = [];
const fail = error => self.postMessage({error: String(error?.stack || error), stdout: lines, pending});
self.addEventListener('error', event => fail(event.error || event.message));
self.addEventListener('unhandledrejection', event => fail(event.reason));
importScripts('/wasm/classes.wasm-runtime.js');
self.onmessage = async event => {
    try {
        if (started) throw new Error('Runtime already started');
        started = true;
        self.portGraphicsCanvas = event.data.canvas;
        importScripts('/resource-host.js');
        const assetResponse = await fetch('/asset-manifest.json');
        if (!assetResponse.ok) throw new Error('Asset manifest HTTP ' + assetResponse.status);
        self.portAssetManifest = await assetResponse.json();
        self.portAssetFiles = new Map();
        for (const entry of self.portAssetManifest) {
            if (typeof entry.path !== 'string' || !entry.path.startsWith('/media/')
                    || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 1024 * 1024
                    || !/^[0-9a-f]{64}$/.test(entry.sha256) || self.portAssetFiles.has(entry.path)) {
                throw new Error('Invalid asset manifest entry');
            }
            const response = await fetch('/asset?path=' + encodeURIComponent(entry.path));
            if (!response.ok) throw new Error('Asset HTTP ' + response.status);
            const bytes = new Uint8Array(await response.arrayBuffer());
            const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
            const hash = Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
            if (bytes.length !== entry.size || hash !== entry.sha256) throw new Error('Asset integrity mismatch');
            self.portAssetFiles.set(entry.path, bytes);
        }
        const module = await TeaVM.wasmGC.load('/wasm/probe.wasm', {installImports(imports) {
            imports.portNative = {steamWorkshopFolders() {
                throw new Error('Steam Workshop is unavailable in this browser host');
            }};
            imports.teavmConsole = {
                putcharStdout(c) {
                    if (c === 10) { lines.push(pending); pending = ''; }
                    else pending += String.fromCharCode(c);
                },
                putcharStderr(c) { throw new Error('WASM stderr character: ' + c); }
            };
        }});
        if (!(module.instance instanceof WebAssembly.Instance)) throw new Error('No WASM instance');
        await module.exports.main([]);
        const deadline = performance.now() + 15000;
        while (!lines.length && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
        if (lines.length !== 1 || pending) throw new Error('Expected one complete engine result');
        self.postMessage({result: JSON.parse(lines[0]), wasmInstance: true});
    } catch (error) { fail(error); }
};
