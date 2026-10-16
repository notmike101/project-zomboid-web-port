import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, sep } from 'node:path';
import { chromium } from 'playwright-core';

const root = resolve(import.meta.dirname, '..');
const executablePath = process.env.PZ_BROWSER;

if (!executablePath) {
    throw new Error('Set PZ_BROWSER to a Chromium executable before running this GPU qualification.');
}

const server = createServer(async (request, response) => {
    try {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        const file = resolve(root, `.${pathname}`);
        const allowed = ['glsl-compat.js', 'sprite-webgl.js'].some((name) => file === resolve(root, 'browser-jvm', name))
            || (file.startsWith(resolve(root, 'node_modules/@shaderfrog/glsl-parser') + sep) && !file.includes(`${sep}test`));

        if (!['GET', 'HEAD'].includes(request.method) || !allowed) {
            response.writeHead(404).end();

            return;
        }

        response.setHeader('Content-Type', 'text/javascript');
        response.end(request.method === 'HEAD' ? undefined : await readFile(file));
    } catch {
        response.writeHead(404).end();
    }
});

await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
});
let browser;

try {
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage();

    await page.goto(`http://127.0.0.1:${server.address().port}/browser-jvm/sprite-webgl.js`);
    const result = await page.evaluate(async () => {
        const modulePath = '/browser-jvm/sprite-webgl.js';
        const { createSpriteNatives } = await import(modulePath);
        const canvas = globalThis.document.createElement('canvas');

        canvas.width = 4;
        canvas.height = 2;
        const backend = createSpriteNatives(canvas, () => undefined);
        const gl = canvas.getContext('webgl2');
        const shaders = [];
        const checks = [];
        const framebuffer = gl.createFramebuffer();
        const texture = gl.createTexture();
        const depthStencil = gl.createRenderbuffer();
        const program = gl.createProgram();
        /**
         * Invokes the actual browser callback used by the Java host facade.
         *
         * @param {string} name - Java native operation name.
         * @param {...unknown} args - Original host arguments.
         * @returns {Promise<unknown>} Actual WebGL callback result.
         */
        const call = (name, ...args) => backend.natives[`Java_port_host_SpriteGraphics_${name}`](null, ...args);
        /**
         * Records a state or framebuffer assertion.
         *
         * @param {boolean} condition - Required GPU result.
         * @param {string} label - Diagnostic assertion name.
         */
        const require = (condition, label) => {
            if (!condition) {
                throw new Error(label);
            }

            checks.push(label);
        };

        /**
         * Reads all actual RGBA pixels, preserving their framebuffer order.
         *
         * @returns {number[]} Eight actual framebuffer pixels.
         */
        const pixels = () => {
            const bytes = new Uint8Array(32);

            gl.readPixels(0, 0, 4, 2, gl.RGBA, gl.UNSIGNED_BYTE, bytes);

            return [...bytes];
        };

        /**
         * Checks every channel of all framebuffer pixels against one color.
         *
         * @param {number[]} color - Exact expected RGBA bytes.
         * @param {string} label - Diagnostic assertion name.
         * @returns {undefined} Completion of the exact pixel assertion.
         */
        const solid = (color, label) => require(pixels().every((value, index) => value === color[index % 4]), label);

        try {
            require(gl.getContextAttributes().stencil && gl.getParameter(gl.STENCIL_BITS) >= 8, 'Default framebuffer has an actual stencil attachment');
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 4, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.bindRenderbuffer(gl.RENDERBUFFER, depthStencil);
            gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, 4, 2);
            gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
            gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, depthStencil);
            require(gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE, 'Actual packed depth/stencil framebuffer complete');

            for (const [type, text] of [
                [gl.VERTEX_SHADER, '#version 300 es\nuniform float z;void main(){gl_Position=vec4(float((gl_VertexID<<1)&2)*2.0-1.0,float(gl_VertexID&2)*2.0-1.0,z,1);}'],
                [gl.FRAGMENT_SHADER, '#version 300 es\nprecision highp float;uniform vec4 color;out vec4 outColor;void main(){outColor=color;}'],
            ]) {
                const shader = gl.createShader(type);

                shaders.push(shader);
                gl.shaderSource(shader, text);
                gl.compileShader(shader);
                require(gl.getShaderParameter(shader, gl.COMPILE_STATUS), `Authored shader compiles: ${type}`);
                gl.attachShader(program, shader);
            }

            gl.linkProgram(program);
            require(gl.getProgramParameter(program, gl.LINK_STATUS), 'Authored program links');
            gl.useProgram(program);
            const color = gl.getUniformLocation(program, 'color');

            gl.viewport(0, 0, 4, 2);
            gl.uniform4f(color, 1, 0, 0, 1);
            await call('glClearDepth', 1);
            gl.clearColor(0, 0, 0, 1);
            gl.clearStencil(0);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
            await call('glStencilMask', 0x80);
            await call('glStencilFunc', gl.ALWAYS, 0x80, 0xFF);
            await call('glStencilOp', gl.KEEP, gl.KEEP, gl.REPLACE);
            await call('glColorMask', false, false, false, false);
            await call('glScissor', 0, 0, 2, 2);
            gl.enable(gl.STENCIL_TEST);
            gl.enable(gl.SCISSOR_TEST);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            solid([0, 0, 0, 255], 'Stencil mask draw suppresses every color channel');
            require(gl.getParameter(gl.STENCIL_WRITEMASK) === 0x80 && gl.getParameter(gl.STENCIL_BACK_WRITEMASK) === 0x80, 'Both faces receive stencil write mask');
            gl.disable(gl.SCISSOR_TEST);
            await call('glColorMask', true, true, true, true);
            await call('glStencilMask', 0);
            await call('glStencilFunc', gl.EQUAL, 0x80, 0x80);
            await call('glStencilOp', gl.KEEP, gl.KEEP, gl.KEEP);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            require(pixels().every((value, index) => value === ((index % 16) < 8 ? [255, 0, 0, 255] : [0, 0, 0, 255])[index % 4]), 'Scissor and stencil test select only the left half');
            await call('glStencilMask', 0xFF);
            gl.clearStencil(0x55);
            gl.clear(gl.STENCIL_BUFFER_BIT);
            await call('glStencilMask', 0x80);
            await call('glStencilFunc', gl.ALWAYS, 0x80, 0xFF);
            await call('glStencilOp', gl.KEEP, gl.KEEP, gl.REPLACE);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            await call('glStencilFunc', gl.EQUAL, 0xD5, 0xFF);
            gl.uniform4f(color, 0, 0, 1, 1);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            solid([0, 0, 255, 255], 'Masked stencil replacement preserves the lower seven bits');
            await call('glStencilMask', 0xFF);
            await call('glStencilFunc', gl.NEVER, 3, 0xFF);
            await call('glStencilOp', gl.REPLACE, gl.KEEP, gl.KEEP);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            await call('glStencilFunc', gl.EQUAL, 3, 0xFF);
            await call('glStencilOp', gl.KEEP, gl.KEEP, gl.KEEP);
            gl.uniform4f(color, 1, 0, 0, 1);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            solid([255, 0, 0, 255], 'Stencil-failure operation updates actual stencil storage');
            gl.enable(gl.DEPTH_TEST);
            gl.depthFunc(gl.LESS);
            await call('glClearDepth', 0);
            gl.clear(gl.DEPTH_BUFFER_BIT);
            await call('glStencilFunc', gl.ALWAYS, 4, 0xFF);
            await call('glStencilOp', gl.KEEP, gl.REPLACE, gl.KEEP);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            gl.disable(gl.DEPTH_TEST);
            await call('glStencilFunc', gl.EQUAL, 4, 0xFF);
            await call('glStencilOp', gl.KEEP, gl.KEEP, gl.KEEP);
            gl.uniform4f(color, 0, 0, 1, 1);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            solid([0, 0, 255, 255], 'Depth-failure operation updates actual stencil storage');
            gl.disable(gl.STENCIL_TEST);
            await call('glColorMask', true, false, true, false);
            gl.clearColor(1, 1, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            solid([255, 0, 0, 255], 'Partial color mask affects actual clears');
            await call('glColorMask', true, true, true, true);
            gl.clearColor(0, 0, 0, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            gl.enable(gl.DEPTH_TEST);
            await call('glClearDepth', 0.25);
            gl.clear(gl.DEPTH_BUFFER_BIT);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            solid([0, 0, 0, 255], 'Depth clear value rejects farther fragment');
            await call('glClearDepth', 0.75);
            gl.clear(gl.DEPTH_BUFFER_BIT);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            solid([0, 0, 255, 255], 'Depth clear value permits nearer fragment');
            await call('glClearDepth', -1);
            require(gl.getParameter(gl.DEPTH_CLEAR_VALUE) === 0, 'Negative clear depth clamps to zero');
            await call('glClearDepth', 2);
            require(gl.getParameter(gl.DEPTH_CLEAR_VALUE) === 1, 'Large clear depth clamps to one');
            await call('glStencilFunc', -1, 0, 0xFF);
            require(gl.getError() === gl.INVALID_ENUM && gl.getParameter(gl.STENCIL_FUNC) === gl.EQUAL, 'Unsupported comparison retains INVALID_ENUM and previous state');
            await call('glStencilOp', -1, gl.KEEP, gl.KEEP);
            require(gl.getError() === gl.INVALID_ENUM && gl.getParameter(gl.STENCIL_FAIL) === gl.KEEP, 'Unsupported stencil operation retains INVALID_ENUM and previous state');
            await call('glScissor', 0, 0, -1, 2);
            require(gl.getError() === gl.INVALID_VALUE && [...gl.getParameter(gl.SCISSOR_BOX)].join(',') === '0,0,2,2', 'Negative scissor size retains INVALID_VALUE and previous box');
            require(gl.getError() === gl.NO_ERROR, 'No unconsumed GPU errors');

            return { pass: true, checks };
        } finally {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.deleteFramebuffer(framebuffer);
            gl.deleteTexture(texture);
            gl.deleteRenderbuffer(depthStencil);
            gl.deleteProgram(program);

            for (const shader of shaders) {
                gl.deleteShader(shader);
            }

            gl.getExtension('WEBGL_lose_context')?.loseContext();
        }
    });

    assert.equal(result.pass, true);
    await mkdir(resolve(root, 'target/browser-jvm/stencil'), { recursive: true });
    await writeFile(resolve(root, 'target/browser-jvm/stencil/result.json'), JSON.stringify(result, null, 2));
    console.info(`Stencil/depth/scissor GPU qualification: ${result.checks.length} checks passed.`);
} finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((done, reject) => {
        server.close((error) => error ? reject(error) : done());
    });
}
