// Each worker owns one Java runtime and the transferred canvas.
self.window = self;
let module;
const lines = [];
let pending = '';
importScripts('/wasm/classes.wasm-runtime.js');
self.onmessage = async event => {
    const {id, type} = event.data;
    try {
        if (type === 'start') {
            if (module) throw new Error('Runtime already started');
            self.portGraphicsCanvas = event.data.canvas;
            self.portGraphicsCanvas.addEventListener('webglcontextlost', () => {
                self.postMessage({type: 'failure', error: 'Worker WebGL context lost'});
            });
            if (event.data.resources) importScripts('/resource-host.js');
            module = await TeaVM.wasmGC.load('/wasm/probe.wasm', {installImports(imports) {
                imports.teavmConsole = {
                    putcharStdout(c) { if (c === 10) { lines.push(pending); pending = ''; } else pending += String.fromCharCode(c); },
                    putcharStderr(c) { throw new Error('WASM stderr character: ' + c); }
                };
            }});
            await module.exports.main([]);
            const deadline = performance.now() + 15000;
            while (!lines.length && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
            if (lines.length !== 1 || pending) throw new Error('Expected one worker result');
            const result = JSON.parse(lines[0]);
            const webgl2 = self.portGraphicsCanvas.getContext('webgl2') instanceof WebGL2RenderingContext;
            self.postMessage({id, result: {result, webgl2}});
        } else if (type === 'render') {
            if (!module) throw new Error('Runtime is not ready');
            self.postMessage({id, result: JSON.parse(module.exports.renderColor(...event.data.values))});
        } else throw new Error('Unknown worker operation');
    } catch (error) {
        self.postMessage({id, type: 'failure', error: String(error.stack || error), stdout: lines, pending});
    }
};
