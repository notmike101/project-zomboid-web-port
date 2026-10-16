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
        const allowed
            = ['glsl-compat.js', 'sprite-webgl.js'].some((name) => file === resolve(root, 'browser-jvm', name))
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

        canvas.width = 1;
        canvas.height = 1;
        const backend = createSpriteNatives(canvas, () => undefined);
        const gl = canvas.getContext('webgl2');
        /**
         * Invokes the same native callback used by the Java graphics facade.
         *
         * @param {string} name - Native operation name.
         * @param {...unknown} args - Original native arguments.
         * @returns {Promise<unknown>} Actual graphics result.
         */
        const call = (name, ...args) => backend.natives[`Java_port_host_SpriteGraphics_${name}`](null, ...args);
        const checks = [];
        /**
         * Records one actual graphics assertion.
         *
         * @param {boolean} ok - Required GPU outcome.
         * @param {string} label - Diagnostic assertion name.
         */
        const require = (ok, label) => {
            if (!ok) {
                throw new Error(label);
            }

            checks.push(label);
        };

        const fbo = gl.createFramebuffer();
        const tex = gl.createTexture();
        const ds = gl.createRenderbuffer();
        const ebo = gl.createBuffer();
        const programs = [];
        const shaders = [];

        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindRenderbuffer(gl.RENDERBUFFER, ds);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, 1, 1);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, ds);
        require(gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE, 'real depth/stencil framebuffer');
        gl.viewport(0, 0, 1, 1);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2]), gl.STATIC_DRAW);
        const vertex = '#version 330 core\nvoid main(){gl_Position=vec4(float((gl_VertexID<<1)&2)*2.0-1.0,float(gl_VertexID&2)*2.0-1.0,0,1);}';

        /**
         * Builds a real program through the composed desktop-shader facade.
         *
         * @param {string} body - Authored fragment main body.
         * @param {string} declarations - Fragment globals.
         * @param {string} version - Desktop shader version.
         * @param {string} vertexSource - Authored vertex shader source.
         * @returns {Promise<number>} Owned linked program handle.
         */
        async function program(
            body = 'color=vec4(1,0,0,alpha);',
            declarations = 'uniform float alpha;out vec4 color;',
            version = '330 core',
            vertexSource = vertex,
        ) {
            const p = await call('glCreateProgram');

            programs.push(p);

            await Promise.all([
                [gl.VERTEX_SHADER, vertexSource],
                [gl.FRAGMENT_SHADER, `#version ${version}\n${declarations}void main(){${body}}`],
            ].map(async ([type, source]) => {
                const s = await call('glCreateShader', type);

                shaders.push(s);
                await call('shaderText', s, source);
                await call('glCompileShader', s);
                require(await call('glGetShaderi', s, gl.COMPILE_STATUS), `unit shader compiles ${await call('glGetShaderInfoLog', s, 1_000)}`);
                await call('glAttachShader', p, s);
            }));

            await call('glLinkProgram', p);
            require(await call('glGetProgrami', p, gl.LINK_STATUS), `composed program links ${await call('glGetProgramInfoLog', p, 1_000)}`);

            return p;
        }

        /**
         * Selects a program and its authored alpha input.
         *
         * @param {number} p - Owned program handle.
         * @param {number} alpha - Fragment alpha value.
         */
        async function bind(p, alpha) {
            await call('glUseProgram', p);
            const u = await call('uniformLocation', p, 'alpha');

            if (u !== -1) {
                await call('glUniform1f', u, alpha);
            }
        }

        /**
         * Reads the actual framebuffer pixel.
         *
         * @returns {number[]} Actual RGBA bytes.
         */
        const pixel = () => {
            const a = new Uint8Array(4);

            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, a);

            return [...a];
        };

        /**
         * Clears color without changing depth or stencil storage.
         */
        const black = () => {
            gl.clearColor(0, 0, 0, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
        };

        /**
         * Exercises one real array or indexed draw entry point.
         *
         * @param {string} kind - Native draw operation name.
         */
        async function draw(kind = 'glDrawArrays') {
            if (kind === 'glDrawArrays') {
                await call(kind, gl.TRIANGLES, 0, 3);
            } else if (kind === 'drawRange') {
                await call(kind, gl.TRIANGLES, 0, 2, 3, gl.UNSIGNED_SHORT, 0);
            } else {
                await call(kind, gl.TRIANGLES, 3, gl.UNSIGNED_SHORT, 0);
            }
        }

        /**
         * Checks red-channel visibility after one alpha-tested draw.
         *
         * @param {number} p - Owned program handle.
         * @param {number} alpha - Fragment alpha value.
         * @param {boolean} passes - Whether the fragment must survive.
         * @param {string} label - Diagnostic assertion name.
         * @param {string} kind - Native draw operation name.
         */
        async function red(p, alpha, passes, label, kind) {
            await bind(p, alpha);
            black();
            await draw(kind);
            require(pixel()[0] === (passes ? 255 : 0), `${label} ${pixel()}`);
        }

        try {
            require(!(await call('glIsEnabled', 3_008)) && (await call('integerState', 0xB_C1)) === 519, 'desktop disabled/ALWAYS defaults');
            const p = await program();

            await call('glEnable', 3_008);
            require(await call('glIsEnabled', 3_008), 'actual alpha enable state');

            const comparisons = Array.from({ length: 8 }, (_, index) => index + 512).flatMap((fn) => [0.25, 0.5, 0.75].map((alpha) => [fn, alpha]));

            for await (const [fn, alpha] of comparisons) {
                await call('glAlphaFunc', fn, 0.5);
                const expected = [false, alpha < 0.5, alpha === 0.5, alpha <= 0.5, alpha > 0.5, alpha !== 0.5, alpha >= 0.5, true][fn - 512];

                await red(p, alpha, expected, `comparison ${fn} alpha ${alpha}`);
            }

            await call('glAlphaFunc', 513, 0);
            await red(p, -1, false, 'normalized output negative alpha clamps zero');
            await call('glAlphaFunc', 514, 0);
            await red(p, -1, true, 'normalized output negative alpha equals clamped zero');
            await call('glAlphaFunc', 516, 1);
            await red(p, 2, false, 'normalized output large alpha clamps one');
            await call('glAlphaFunc', 514, 1);
            await red(p, 2, true, 'normalized output large alpha equals clamped one');
            await call('glAlphaFunc', 516, -1);
            await red(p, 0, false, 'negative reference clamps zero');
            await red(p, 0.25, true, 'positive alpha passes zero ref');
            await call('glAlphaFunc', 516, 2);
            await red(p, 1, false, 'large reference clamps one');
            await call('glAlphaFunc', 512, 0);
            await red(p, 0.75, false, 'NEVER enabled');
            await call('glDisable', 3_008);
            await red(p, 0.75, true, 'disabled bypasses NEVER');
            await call('glEnable', 3_008);
            await red(p, 0.75, false, 'reenabled restores NEVER');
            await call('glAlphaFunc', 516, 0.5);
            await call('glAlphaFunc', 123, 0.1);
            require((await call('rawError')) === gl.INVALID_ENUM
                && (await call('integerState', 0xB_C1)) === 516, 'invalid function reports enum and preserves state');
            require((await call('glGetProgrami', p, gl.ACTIVE_UNIFORMS)) === 1
                && (await call('activeUniformName', p, 0)) === 'alpha', 'internal alpha uniforms hidden from enumeration');
            require((await call('uniformLocation', p, 'portAlphaFunction')) === -1
                && (await call('uniformLocation', p, 'portAlphaReference')) === -1, 'internal uniform locations hidden');
            const early = await program('if(alpha<0.5){color=vec4(1,0,0,alpha);return;}color=vec4(1,0,0,alpha);');

            await red(early, 0.25, false, 'early main return still alpha tested');
            await red(early, 0.75, true, 'main fallthrough still alpha tested');
            const discard = await program('if(alpha>0.5)discard;color=vec4(1,0,0,alpha);');

            await call('glAlphaFunc', 519, 0);
            await red(discard, 0.75, false, 'original discard preserved');
            await call('glAlphaFunc', 516, 0.5);

            for await (const kind of ['glDrawArrays', 'drawElements', 'drawRange']) {
                await red(p, 0.25, false, `${kind} rejection`, kind);
                await red(p, 0.75, true, `${kind} pass`, kind);
            }

            await bind(p, 0.25);
            black();
            gl.clearColor(0, 0, 1, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            require(pixel().join(',') === '0,0,255,255', 'alpha never modifies clear operations');
            const p2 = await program();

            await red(p2, 0.75, true, 'program two state applied');
            await red(p, 0.25, false, 'program one state reapplied');
            await red(p2, 0.25, false, 'program two changed alpha');
            await call('glLinkProgram', p);
            require(await call('glGetProgrami', p, gl.LINK_STATUS), 'relink succeeds');
            await red(p, 0.25, false, 'relink reacquires private locations');
            const depth = await program('gl_FragDepth=0.2;color=vec4(1,0,0,alpha);');
            const blue = await program('color=vec4(0,0,1,alpha);');

            gl.clearDepth(1);
            gl.clearStencil(0);
            gl.stencilMask(255);
            gl.clear(gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
            gl.enable(gl.DEPTH_TEST);
            gl.depthFunc(gl.LESS);
            gl.enable(gl.STENCIL_TEST);
            gl.stencilFunc(gl.ALWAYS, 7, 255);
            gl.stencilOp(gl.REPLACE, gl.REPLACE, gl.REPLACE);
            await red(depth, 0.25, false, 'rejected fragment with FragDepth has no color write');
            await call('glDisable', 3_008);
            gl.stencilFunc(gl.EQUAL, 7, 255);
            gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
            await bind(blue, 1);
            await draw();
            require(pixel().join(',') === '0,0,0,255', 'alpha rejection leaves stencil unchanged');
            gl.disable(gl.STENCIL_TEST);
            await draw();
            require(pixel().join(',') === '0,0,255,255', 'alpha rejection leaves depth unchanged');
            gl.disable(gl.DEPTH_TEST);
            await call('glAlphaFunc', 516, 0.5);
            await call('glEnable', 3_008);
            const legacy = await program('gl_FragColor=vec4(1,0,0,alpha);return;', 'uniform float alpha;', '120');

            await red(legacy, 0.25, false, 'legacy FragColor early return alpha rejection');
            await red(legacy, 0.75, true, 'legacy FragColor pass');
            const explicit = await program('color=vec4(1,0,0,alpha);', 'uniform float alpha;layout(location=0)out vec4 color;');

            await red(explicit, 0.25, false, 'explicit location zero alpha rejection');
            const namedAlpha = await program('alpha=vec4(1,0,0,amount);', 'uniform float amount;out vec4 alpha;');

            await bind(namedAlpha, 0);
            await call('glUniform1f', await call('uniformLocation', namedAlpha, 'amount'), 0.25);
            black();
            await draw();
            require(pixel()[0] === 0, 'output named alpha does not shadow wrapper local');
            const cross = await program(
                'color=vec4(1,0,0,alpha);',
                'uniform float alpha;out vec4 color;',
                '330 core',
                vertex.replace('void main()', 'uniform float portAlphaReference;void main()').replace(',0,1);}', ',0,1);gl_Position.x+=portAlphaReference;}'),
            );

            await call('glDisable', 3_008);
            await bind(cross, 0.75);
            const originalLocation = await call('uniformLocation', cross, 'portAlphaReference');

            require(originalLocation !== -1, 'vertex adapter-name collision remains visible');
            await call('glUniform1f', originalLocation, 4);
            black();
            await draw();
            require(pixel()[0] === 0, 'disabled alpha retains vertex uniform position effect');
            await call('glUniform1f', originalLocation, 0);
            black();
            await draw();
            require(pixel()[0] === 255, 'disabled alpha preserves original vertex uniform update');
            require((await call('glGetProgrami', cross, gl.ACTIVE_UNIFORMS)) === 2, 'vertex original uniform count unchanged');
            await call('glEnable', 3_008);
            let crossRejected = false;

            try {
                await draw();
            } catch {
                crossRejected = true;
            }

            require(crossRejected, 'vertex-only collision rejects enabled alpha');
            const unsupported = await program('color[0]=vec4(1);color[1]=vec4(1);', 'layout(location=0)out vec4 color[2];');

            await bind(unsupported, 1);
            await call('glDisable', 3_008);
            await draw();
            require((await call('rawError')) === 0, 'array fragment output remains usable when alpha disabled');
            await call('glEnable', 3_008);
            let rejected = false;

            try {
                await draw();
            } catch {
                rejected = true;
            }

            require(rejected, 'array fragment output rejects enabled alpha');
            const collision = await program('color=vec4(portAlphaReference);', 'uniform float portAlphaReference;out vec4 color;');

            await bind(collision, 1);
            await call('glDisable', 3_008);
            await draw();
            require((await call('rawError')) === 0, 'collision shader remains usable with alpha disabled');
            await call('glEnable', 3_008);
            rejected = false;

            try {
                await draw();
            } catch {
                rejected = true;
            }

            require(rejected, 'adapter identifier collision rejects enabled alpha');

            if (gl.getExtension('EXT_color_buffer_float')) {
                const floatTexture = gl.createTexture();

                try {
                    gl.bindTexture(gl.TEXTURE_2D, floatTexture);
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 1, 0, gl.RGBA, gl.FLOAT, null);
                    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, floatTexture, 0);
                    require(gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE, 'actual floating-point color framebuffer');
                    await bind(p, 0.75);
                    await call('glDisable', 3_008);
                    await draw();
                    require((await call('rawError')) === 0, 'floating-point draw unchanged when alpha disabled');
                    await call('glEnable', 3_008);
                    let floatRejected = false;

                    try {
                        await draw();
                    } catch {
                        floatRejected = true;
                    }

                    require(floatRejected, 'unqualified floating-point alpha comparison fails explicitly');
                } finally {
                    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
                    gl.deleteTexture(floatTexture);
                }
            }

            await call('glUseProgram', 0);
            rejected = false;

            try {
                await draw();
            } catch {
                rejected = true;
            }

            require(rejected, 'missing fixed pipeline rejects enabled alpha');
            await call('glDisable', 3_008);
            await draw();
            require((await call('rawError')) === gl.INVALID_OPERATION, 'disabled missing-program draw preserves original WebGL error');
            require((await call('rawError')) === 0, 'no unconsumed GL errors');

            return { pass: true, checks };
        } finally {
            await call('glUseProgram', 0);

            await Promise.all(programs.map((p) => call('glDeleteProgram', p)));
            await Promise.all(shaders.map((s) => call('glDeleteShader', s)));

            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.deleteFramebuffer(fbo);
            gl.deleteTexture(tex);
            gl.deleteRenderbuffer(ds);
            gl.deleteBuffer(ebo);
            gl.getExtension('WEBGL_lose_context')?.loseContext();
        }
    });

    assert.equal(result.pass, true);
    await mkdir(resolve(root, 'target/browser-jvm/alpha'), { recursive: true });
    await writeFile(resolve(root, 'target/browser-jvm/alpha/result.json'), JSON.stringify(result, null, 2));
    console.info(`Alpha-test GPU qualification: ${result.checks.length} checks passed.`);
} finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((done, reject) => {
        server.close((error) => (error ? reject(error) : done()));
    });
}
