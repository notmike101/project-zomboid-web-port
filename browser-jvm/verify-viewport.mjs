import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';

const { PZ_JDK: jdk, PZ_BROWSER: executablePath, PZ_GAME_JAR: gameJar } = process.env;

if (!jdk || !executablePath || !gameJar) {
    throw new Error('Set PZ_JDK, PZ_BROWSER and PZ_GAME_JAR; prepare the play runtime-view.jar first.');
}

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'target/browser-jvm/viewport');
const classes = path.join(output, 'classes');
const preparer = path.join(output, 'preparer');
const inputs = new Map();
const evidence = { pass: false, denied: [], logs: [] };
let browser;
let server;

/**
 * Computes an exact input digest.
 *
 * @param {Buffer} bytes - Input bytes.
 * @returns {string} SHA-256 digest.
 */
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Runs one bounded literal JDK command.
 *
 * @param {string} name - Tool name.
 * @param {string[]} args - Process arguments.
 */
function command(name, args) {
    const result = spawnSync(path.join(jdk, 'bin', name + (process.platform === 'win32' ? '.exe' : '')), args, { cwd: root, encoding: 'utf8', timeout: 60_000, windowsHide: true });

    if (result.error || result.status !== 0) {
        throw new Error(`${name}: ${result.error || result.stderr || result.stdout}`);
    }
}

/**
 * Retains one immutable served source and its digest.
 *
 * @param {string} file - Input path.
 * @returns {Promise<Buffer>} Snapshot bytes.
 */
async function snapshot(file) {
    if (!inputs.has(file)) {
        inputs.set(file, await readFile(file));
    }

    return inputs.get(file);
}

await mkdir(classes, { recursive: true });
await mkdir(preparer, { recursive: true });

try {
    const runtime = path.join(root, 'target/browser-jvm/play/runtime-view.jar');

    await snapshot(gameJar);
    const runtimeCopy = path.join(output, 'runtime-view.jar');

    await writeFile(runtimeCopy, await snapshot(runtime));
    const hostSources = ['SpriteGraphics.java', 'SpriteBuffers.java'].map((name) => path.join(root, 'browser-jvm/host/port/host', name));
    const fixture = path.join(root, 'browser-jvm/ViewportQualification.java');
    const textureFixture = path.join(root, 'browser-jvm/TextureEnvQualification.java');
    const preparation = path.join(root, 'browser-jvm/PrepareSpriteGraphics.java');

    await Promise.all([...hostSources, fixture, textureFixture, preparation].map(snapshot));
    command('javac', ['--release', '17', '-cp', gameJar, '-d', classes, ...hostSources, fixture, textureFixture]);
    command('javac', ['-d', preparer, preparation]);
    command('java', ['-cp', preparer, 'PrepareSpriteGraphics', runtimeCopy, output, classes]);
    command('jar', ['--create', '--file', path.join(output, 'qualification.jar'), '-C', classes, 'ViewportQualification.class', '-C', classes, 'TextureEnvQualification.class']);
    evidence.manifest = JSON.parse(await readFile(path.join(output, 'sprite-graphics-manifest.json'), 'utf8'));
    const legacy = evidence.manifest.adaptedVendorClasses.find((entry) => entry.class === 'org/lwjgl/opengl/GL11');

    assert.deepEqual(legacy.methods.slice().sort(), ['glAlphaFunc(IF)V->glAlphaFunc', 'glPopAttrib()V->glPopAttrib', 'glPolygonMode(II)V->glPolygonMode', 'glPushAttrib(I)V->glPushAttrib', 'glTexEnvi(III)V->glTexEnvi', 'glDisableClientState(I)V->glDisableClientState', 'glEnableClientState(I)V->glEnableClientState', 'glLineWidth(F)V->glLineWidth', 'glFrontFace(I)V->glFrontFace'].sort());
    assert.equal(evidence.manifest.gameMethodBodiesUnchanged, true);
    const shaderRoot = path.join(path.dirname(gameJar), 'media/shaders');
    const routes = new Map([
        ['/original-shaders/default.vert', path.join(shaderRoot, 'default.vert')],
        ['/original-shaders/default.frag', path.join(shaderRoot, 'default.frag')],
        ['/browser-jvm/texture-env-qualification.html', path.join(root, 'browser-jvm/texture-env-qualification.html')],
        ['/browser-jvm/texture-env-qualification.js', path.join(root, 'browser-jvm/texture-env-qualification.js')],
        ['/qualification.jar', path.join(output, 'qualification.jar')],
        ['/sprite-view.jar', path.join(output, 'sprite-view.jar')],
        ['/browser-jvm/viewport-qualification.html', path.join(root, 'browser-jvm/viewport-qualification.html')],
        ['/browser-jvm/sprite-webgl.js', path.join(root, 'browser-jvm/sprite-webgl.js')],
        ['/browser-jvm/glsl-compat.js', path.join(root, 'browser-jvm/glsl-compat.js')],
    ]);

    await Promise.all([...routes.values()].map(snapshot));
    const parserRoot = path.join(root, 'node_modules/@shaderfrog/glsl-parser');

    server = createServer(async (request, response) => {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        let file = routes.get(pathname);
        const parser = path.resolve(root, `.${pathname}`);

        if (!file && parser.startsWith(parserRoot + path.sep) && !parser.includes(`${path.sep}test`)) {
            file = parser;
        }

        try {
            if (!['GET', 'HEAD'].includes(request.method) || !file) {
                throw new Error('Unlisted route');
            }

            const bytes = await snapshot(file);
            const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
            const start = range ? Number(range[1]) : 0;
            const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
            let type = 'text/javascript';

            if (pathname.endsWith('.html')) {
                type = 'text/html; charset=utf-8';
            } else if (pathname.endsWith('.jar')) {
                type = 'application/java-archive';
            }

            response.writeHead(range ? 206 : 200, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) }).end(bytes.subarray(start, end + 1));
        } catch {
            evidence.denied.push(pathname);
            response.writeHead(404).end();
        }
    });
    await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;

    browser = await chromium.launch({ executablePath, headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block' });

    await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());

        if (url.origin === origin || (url.origin === 'https://cjrtnc.leaningtech.com' && url.pathname.startsWith('/4.3/'))) {
            await route.continue();
        } else {
            evidence.denied.push(url.href);
            await route.abort();
        }
    });
    const page = await context.newPage();

    page.on('console', (message) => evidence.logs.push(message.text()));
    page.on('pageerror', (error) => evidence.logs.push(String(error)));
    await page.goto(`${origin}/browser-jvm/viewport-qualification.html`);
    await page.waitForFunction(() => globalThis.completed, null, { timeout: 90_000 });
    evidence.result = await page.evaluate(() => globalThis.result);
    assert.equal(evidence.result.pass, true, evidence.result.error);
    assert.equal(evidence.result.stackDepth, 0);
    await page.close();
    const texturePage = await context.newPage();

    texturePage.on('console', (message) => evidence.logs.push(message.text()));
    texturePage.on('pageerror', (error) => evidence.logs.push(String(error)));
    await texturePage.goto(`${origin}/browser-jvm/texture-env-qualification.html`);
    await texturePage.waitForFunction(() => globalThis.completed, null, { timeout: 90_000 });
    evidence.textureEnvironment = await texturePage.evaluate(() => globalThis.result);
    assert.equal(evidence.textureEnvironment.pass, true, evidence.textureEnvironment.error);
    assert.equal(evidence.textureEnvironment.javaChecks, 18);
    assert.equal(evidence.textureEnvironment.checks, 47);
    assert.deepEqual(evidence.textureEnvironment.pixels, [64, 32, 16, 64, 0, 0, 255, 255]);
    assert.equal(evidence.denied.length, 0);
    assert.equal(evidence.logs.filter((line) => /Exception|Error:|SEVERE/.test(line)).length, 0);
    evidence.pass = true;
} catch (error) {
    evidence.error = String(error.stack || error);
} finally {
    await browser?.close();
    server?.closeAllConnections();

    if (server) {
        await new Promise((resolve) => {
            server.close(resolve);
        });
    }

    evidence.closed = true;
    evidence.inputs = await Promise.all([...inputs].map(async ([file, bytes]) => ({ file, before: hash(bytes), after: hash(await readFile(file)) })));

    if (evidence.inputs.some((input) => input.before !== input.after)) {
        evidence.pass = false;
    }

    await writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
}

console.info(JSON.stringify(evidence));

if (!evidence.pass) {
    process.exitCode = 1;
}
