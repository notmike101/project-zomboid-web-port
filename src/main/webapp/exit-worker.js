// This worker owns exactly one Java runtime and its process-exit boundary.
self.window = self;
self.portOwnedRuntime = true;
self.portExited = false;
let started = false;
let pending = '';
const lines = [];

function expectedExitTrap(error) {
    if (self.portExited !== true || !(error instanceof WebAssembly.RuntimeError)) return false;
    if (!self.portTrapObserved) {
        self.portTrapObserved = true;
        self.postMessage({type: 'exit-trap', errorName: error.name, errorMessage: String(error.message)});
    }
    return true;
}

function fail(error) {
    self.postMessage({type: 'failure', error: String(error?.stack || error), stdout: lines, pending});
}

self.addEventListener('error', event => {
    if (expectedExitTrap(event.error)) event.preventDefault();
    else fail(event.error || event.message);
});
self.addEventListener('unhandledrejection', event => {
    if (expectedExitTrap(event.reason)) event.preventDefault();
    else fail(event.reason);
});

importScripts('/wasm/classes.wasm-runtime.js');
self.onmessage = async event => {
    try {
        if (event.data?.type !== 'start' || started) throw new Error('Expected one worker start');
        started = true;
        self.postMessage({type: 'status', status: 'loading'});
        const module = await TeaVM.wasmGC.load('/wasm/probe.wasm', {installImports(imports) {
            const offer = imports.teavmAsync?.offer;
            if (typeof offer !== 'function') throw new Error('Expected TeaVM asynchronous scheduler');
            // close() discards future tasks, so observe the trap inside the active fiber callback.
            imports.teavmAsync.offer = (fiber, callback, deadline) => offer(fiber, (...args) => {
                try { return callback(...args); }
                catch (error) { if (!expectedExitTrap(error)) throw error; }
            }, deadline);
            imports.teavmConsole = {
                putcharStdout(character) {
                    if (character === 10) {
                        lines.push(pending);
                        self.postMessage({type: 'stdout', line: pending});
                        pending = '';
                    } else pending += String.fromCharCode(character);
                },
                putcharStderr(character) { throw new Error('WASM stderr character: ' + character); }
            };
        }});
        if (!(module.instance instanceof WebAssembly.Instance)) throw new Error('Expected a real WASM instance');
        self.postMessage({type: 'status', status: 'wasm-ready', wasmInstance: true});
        await module.exports.main([]);
        // The export returns while a Java fiber is sleeping. Its return is not Java main completion.
        const deadline = performance.now() + 15000;
        while (!self.portExited) {
            if (performance.now() >= deadline) throw new Error('Java worker did not exit before deadline');
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    } catch (error) {
        if (!expectedExitTrap(error)) fail(error);
    }
};
