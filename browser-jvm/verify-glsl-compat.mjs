import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
        const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        const file = resolve(root, `.${path}`);
        const allowed = ['glsl-compat.js', 'sprite-webgl.js'].some((name) => file === resolve(root, 'browser-jvm', name)) || (file.startsWith(resolve(root, 'node_modules/@shaderfrog/glsl-parser') + sep) && !file.includes(`${sep}test`));

        if (!allowed) {
            response.writeHead(404).end();

            return;
        }

        response.setHeader('Content-Type', 'text/javascript');
        response.end(await readFile(file));
    } catch {
        response.writeHead(404).end();
    }
});

await new Promise((done) => {
    server.listen(0, '127.0.0.1', done);
});
let browser;

try {
    browser = await chromium.launch({ executablePath, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    const page = await browser.newPage();

    await page.goto(`http://127.0.0.1:${server.address().port}/browser-jvm/glsl-compat.js`);
    const results = await page.evaluate(`(async () => {
        const { normalizeDesktopShader } = await import('/browser-jvm/glsl-compat.js');
        const gl = document.createElement('canvas').getContext('webgl2', { antialias: false });
        if (!gl) throw new Error('WebGL2 unavailable');
        const shaders = [], programs = [];
        const vertex = '#version 300 es\\nprecision highp float;void main(){gl_Position=vec4(float((gl_VertexID<<1)&2)*2.0-1.0,float(gl_VertexID&2)*2.0-1.0,0,1);}';
        const prefix = '#version 300 es\\nprecision highp float;precision highp int;out vec4 color;';
        function compile(type, source) {
            const shader = gl.createShader(type); shaders.push(shader);
            gl.shaderSource(shader, source); gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader)+'\\n'+source);
            return shader;
        }
        function program(source, vertexSource = vertex) {
            const result = gl.createProgram(); programs.push(result);
            gl.attachShader(result, compile(gl.VERTEX_SHADER, normalizeDesktopShader(vertexSource, 'vertex')));
            gl.attachShader(result, compile(gl.FRAGMENT_SHADER, normalizeDesktopShader(prefix+source, 'fragment')));
            gl.linkProgram(result);
            if (!gl.getProgramParameter(result, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(result));
            return result;
        }
        function pixel(program, value) {
            gl.useProgram(program); const u = gl.getUniformLocation(program, 'u');
            if (u !== null) gl.uniform1f(u,value);
            gl.viewport(0,0,1,1); gl.drawArrays(gl.TRIANGLES,0,3);
            const data = new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,data);
            if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL operation failed');
            return [...data];
        }
        async function composedGlobals() {
            const { createSpriteNatives } = await import('/browser-jvm/sprite-webgl.js');
            const canvas = document.createElement('canvas');
            const facade = createSpriteNatives(canvas, () => {});
            const context = canvas.getContext('webgl2');
            const call = (name, ...args) => facade.natives['Java_port_host_SpriteGraphics_' + name](null, ...args);
            const handles = [];
            const program = await call('glCreateProgram');
            const status = [];
            try {
                // Root first deliberately puts the library's initialized global after main.
                for (const [stage, source] of [
                    [35633, vertex],
                    [35632, prefix+'uniform sampler2D rootTexture;vec4 sampleRoot(){return texture2D(rootTexture,vec2(0));}float helper();void main(){color=vec4(helper(),0,0,1);}'],
                    [35632, prefix.replace('out vec4 color;', '')+'uniform sampler2D libraryTexture;vec4 sampleLibrary(){return texture2D(libraryTexture,vec2(0));}uniform float u;float g=u;float helper(){return g;}'],
                ]) {
                    const shader = await call('glCreateShader', stage); handles.push(shader);
                    await call('shaderText', shader, source);
                    await call('glCompileShader', shader);
                    status.push(Boolean(await call('glGetShaderi', shader, 35713)));
                    await call('glAttachShader', program, shader);
                }
                await call('glLinkProgram', program);
                if (!(await call('glGetProgrami', program, 35714))) throw new Error(await call('glGetProgramInfoLog', program, 10000));
                await call('glUseProgram', program);
                const location = await call('uniformLocation', program, 'u');
                const pixels = [];
                for (const value of [0.25, 0.75]) {
                    await call('glUniform1f', location, value);
                    context.viewport(0,0,1,1);
                    await call('glDrawArrays', 4, 0, 3);
                    const data = new Uint8Array(4);
                    context.readPixels(0,0,1,1,context.RGBA,context.UNSIGNED_BYTE,data);
                    if (context.getError() !== context.NO_ERROR) throw new Error('Composed global draw failed');
                    pixels.push([...data]);
                }
                return { status, pixels };
            } finally {
                await call('glDeleteProgram', program);
                for (const shader of handles) await call('glDeleteShader', shader);
                context.getExtension('WEBGL_lose_context')?.loseContext();
            }
        }
        async function legacyTexture() {
            const { createSpriteNatives } = await import('/browser-jvm/sprite-webgl.js');
            const canvas = document.createElement('canvas');
            const facade = createSpriteNatives(canvas, () => {});
            const context = canvas.getContext('webgl2');
            const call = (name, ...args) => facade.natives['Java_port_host_SpriteGraphics_' + name](null, ...args);
            const handles = [];
            const program = await call('glCreateProgram');
            const texture = context.createTexture();
            try {
                for (const [stage, source] of [
                    [35633, vertex],
                    [35632, '#version 330\\n' + 'uniform sampler2D texture;float portLegacyTexture2D=0.0;vec4 texture2D(float value){return vec4(value);}void main(){gl_FragColor=(texture2D(texture,vec2(.5))+texture2D(texture,vec2(.5),0))*.5+texture2D(0.0);}'],
                ]) {
                    const shader = await call('glCreateShader', stage); handles.push(shader);
                    await call('shaderText', shader, source);
                    await call('glCompileShader', shader);
                    if (!(await call('glGetShaderi', shader, 35713))) throw new Error(await call('glGetShaderInfoLog', shader, 10000));
                    await call('glAttachShader', program, shader);
                }
                await call('glLinkProgram', program);
                if (!(await call('glGetProgrami', program, 35714))) throw new Error(await call('glGetProgramInfoLog', program, 10000));
                await call('glUseProgram', program);
                const location = await call('uniformLocation', program, 'texture');
                if (location === -1) throw new Error('Original texture uniform is hidden');
                await call('glUniform1i', location, 0);
                context.bindTexture(context.TEXTURE_2D, texture);
                context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.NEAREST);
                context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.NEAREST);
                const pixels = [];
                for (const rgba of [[32,96,160,224], [240,128,64,192]]) {
                    context.texImage2D(context.TEXTURE_2D,0,context.RGBA8,1,1,0,context.RGBA,context.UNSIGNED_BYTE,new Uint8Array(rgba));
                    context.viewport(0,0,1,1);
                    await call('glDrawArrays', 4, 0, 3);
                    const data = new Uint8Array(4);
                    context.readPixels(0,0,1,1,context.RGBA,context.UNSIGNED_BYTE,data);
                    if (context.getError() !== context.NO_ERROR) throw new Error('Legacy texture draw failed');
                    pixels.push([...data]);
                }
                return pixels;
            } finally {
                context.deleteTexture(texture);
                await call('glDeleteProgram', program);
                for (const shader of handles) await call('glDeleteShader', shader);
                context.getExtension('WEBGL_lose_context')?.loseContext();
            }
        }
        try {
            const baseline = [
                'void main(){float d=0.5;color=vec4(d>0?1.0:0.0);}',
                'uniform float u;float g=u;void main(){color=vec4(g);}',
                'float max(float a,float b){return 0.25;}void main(){color=vec4(max(0.0,1.0));}',
            ].map(source => {
                const shader = gl.createShader(gl.FRAGMENT_SHADER); shaders.push(shader);
                gl.shaderSource(shader,prefix+source);gl.compileShader(shader);
                return gl.getShaderParameter(shader,gl.COMPILE_STATUS);
            });
            const overload = program('float max(float a,float b){return 0.25;} void main(){vec3 v=max(vec3(0,1,0),vec3(1,0,0));color=vec4(v.xy,max(0.0,1.0),1);}');
            const integerOverload = program('float max(float a,float b){return 0.25;}void main(){int n=max(2,3);color=vec4(float(n)/3.0,max(0.2,0.3),0,1);}');
            const vectorClamp = program('float clamp(float a,float b,float c){return 0.25;}void main(){vec4 v=clamp(vec4(-1,2,0.5,1),0,1);color=vec4(v.y,clamp(0.2,0.0,1.0),v.z,1);}');
            const legacyColor = program('void main(){color=gl_Color;}', vertex.replace('gl_Position=', 'gl_FrontColor=vec4(0.25,0.5,0.75,1.0);gl_Position='));
            const globals = program('uniform float u;float g=u;float h=g*2;void main(){color=vec4(g,h,0,1);}');
            const scopes = program('void main(){float f=0.5;float a=0;{int f=1;int values[2]=int[2](0,1);if(f/2==0 && values[1]==1 && (1<<2)==4)a=1;}color=vec4(f>0?a:0,0,0,1);}');
            const numeric = program('float helper(vec2 p,float n){return n/4;}float max(float a,float b){return a>b?a:b;}float result(){return 1-max(0.0,0.0);}void main(){float n=20;color=vec4(helper(vec2(0),3),result(),(1-0.5)*n/20,1);}');
            return { baseline, overload:pixel(overload), integerOverload:pixel(integerOverload), vectorClamp:pixel(vectorClamp), legacyColor:pixel(legacyColor), globalsFirst:pixel(globals,0.25), globalsSecond:pixel(globals,0.5), scopes:pixel(scopes), numeric:pixel(numeric), composedGlobals:await composedGlobals(), legacyTexture:await legacyTexture() };
        } finally {
            for (const program of programs) gl.deleteProgram(program);
            for (const shader of shaders) gl.deleteShader(shader);
            gl.getExtension('WEBGL_lose_context')?.loseContext();
        }
    })()`);

    assert.deepEqual(results, { baseline: [false, false, false], overload: [255, 255, 64, 255], integerOverload: [255, 64, 0, 255], vectorClamp: [255, 64, 128, 255], legacyColor: [64, 128, 191, 255], globalsFirst: [64, 128, 0, 255], globalsSecond: [128, 255, 0, 255], scopes: [255, 0, 0, 255], numeric: [191, 255, 128, 255], composedGlobals: { status: [true, false, false], pixels: [[64, 0, 0, 255], [191, 0, 0, 255]] }, legacyTexture: [[32, 96, 160, 224], [240, 128, 64, 192]] });
    console.info('GLSL compatibility: nine WebGL2 semantic cases passed, including composed globals and legacy texture sampling.', JSON.stringify(results));
} finally {
    await browser?.close();
    await new Promise((done, reject) => {
        server.close((error) => error ? reject(error) : done());
    });
}
