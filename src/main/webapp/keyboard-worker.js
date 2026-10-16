self.window = self;
self.portKeyboardCodes = new Set();
let module;
let started = false;
let pending = '';
const lines = [];
importScripts('/wasm/classes.wasm-runtime.js');
self.onmessage = async event => {
    const message = event.data;
    try {
        if (message.type === 'key') {
            if (message.down) self.portKeyboardCodes.add(message.code);
            else self.portKeyboardCodes.delete(message.code);
            return;
        }
        if (message.type === 'blur') { self.portKeyboardCodes.clear(); return; }
        if (message.type === 'query') {
            if (!module) throw new Error('Keyboard runtime is not ready');
            self.postMessage({id: message.id, value: module.exports.queryKey(message.key)});
            return;
        }
        if (message.type !== 'start' || started) throw new Error('Expected one keyboard runtime start');
        started = true;
        self.portGraphicsCanvas = message.canvas;
        module = await TeaVM.wasmGC.load('/wasm/probe.wasm', {installImports(imports) {
            imports.teavmConsole = {
                putcharStdout(c) { if (c === 10) { lines.push(pending); pending = ''; } else pending += String.fromCharCode(c); },
                putcharStderr(c) { throw new Error('WASM stderr character: ' + c); }
            };
        }});
        await module.exports.main([]);
        if (!(module.instance instanceof WebAssembly.Instance) || lines.length !== 1 || pending) throw new Error('Invalid keyboard runtime result');
        self.postMessage({ready: true, result: JSON.parse(lines[0]), windowHandle: module.exports.windowHandle()});
    } catch (error) { self.postMessage({error: String(error.stack || error), stdout: lines, pending}); }
};
