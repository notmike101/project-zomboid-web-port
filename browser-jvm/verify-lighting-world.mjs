import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { calculateLighting } from './lighting-kernel.js';

const root = path.resolve(import.meta.dirname, '..');
const { PZ_JDK: jdk, PZ_BROWSER: executablePath, PZ_GAME_DIR: installation, PZ_LIGHTING_SDK: frozenSdk } = process.env;

if (!jdk || !executablePath || !installation || !frozenSdk) {
    throw new Error('Set PZ_JDK, PZ_BROWSER, PZ_GAME_DIR and PZ_LIGHTING_SDK (prepared frozen SDK directory).');
}

const output = path.join(root, 'target/browser-jvm/lighting-world-qualification');
const classes = path.join(output, 'classes');
const source = path.join(root, 'browser-jvm/WorldLightingQualification.java');
const archive = path.join(output, 'qualification.jar');
const gameJar = path.join(installation, 'projectzomboid.jar');
const nativeLibrary = path.join(installation, 'Lighting64.dll');
const sdkNames = [
    'animation-entry.jar', 'animation-view.jar', 'animation-sdk-view.jar', 'path-view.jar',
    'float-bridge.jar', 'memory-bridge.jar', 'world-entry.jar', 'atomic-view.jar',
];
const execute = promisify(execFile);

/**
 * Hashes protected inputs without buffering complete installed archives.
 *
 * @param {string} file - Input path.
 * @returns {Promise<string>} SHA256 digest.
 */
async function hashFile(file) {
    const hash = createHash('sha256');

    for await (const bytes of createReadStream(file)) {
        hash.update(bytes);
    }

    return hash.digest('hex');
}

/**
 * Runs only the authored data-only transport or JDK compiler/archive tools.
 *
 * @param {string} name - JDK executable basename.
 * @param {string[]} args - Literal arguments.
 * @returns {Promise<string>} Standard output.
 */
async function command(name, args) {
    const result = await execute(path.join(jdk, 'bin', `${name}.exe`), args, {
        cwd: output, windowsHide: true, timeout: 90_000, maxBuffer: 8 * 1_024 * 1_024,
    });

    return result.stdout;
}

/**
 * Selects complete comparable reference records from original Java output.
 *
 * @param {string} text - Standard output.
 * @returns {string[]} Packed-square and per-level publication lines.
 */
function referenceLines(text) {
    return text.split(/\r?\n/u).filter((line) => /^WORLD /u.test(line));
}

/**
 * Checks the explicit ambient-order boundary and malformed metadata independently.
 */
function verifyBoundaries() {
    const cells = Array.from({ length: 64 }, () => ({
        mask: 255, vision: 0, up: false, down: false, stairs: false,
        openAir: true, room: -1, transmission: Array.from({ length: 20 }, () => 0),
    }));
    const scene = { width: 8, height: 8, cells, player: [1.5, 1.5], lights: [], sky: 0xFF_FF_FF };

    cells[0].transmission[3] = Math.fround(0.15);
    assert.equal(calculateLighting(scene).length, 64);
    assert.throws(() => calculateLighting({ ...scene, sky: 0xAC_CF_E1 }), /colored ambient transmission/u);
    const colored = structuredClone(scene);

    colored.cells[0].transmission.splice(0, 3, 0.2, 0.7, 0.5);
    assert.throws(() => calculateLighting(colored), /colored ambient transmission/u);
    assert.equal(calculateLighting({ ...colored, sky: 0 }).length, 64);
    const invalid = structuredClone(scene);

    delete invalid.cells[0].transmission[0];
    assert.throws(() => calculateLighting(invalid), /square transmission/u);
    invalid.cells[0].transmission[0] = 0;
    invalid.cells[0].objects = [null];
    assert.throws(() => calculateLighting(invalid), /square object/u);
    const absentSource = structuredClone(scene);

    absentSource.cells[0] = null;
    absentSource.lights = [{ id: 1, x: 0, y: 0, radius: 4, color: [1, 1, 1] }];
    assert.throws(() => calculateLighting(absentSource), /static light on absent square/u);
}

verifyBoundaries();
await mkdir(classes, { recursive: true });
const files = new Map([
    ['/qualification.jar', archive],
    ...['lighting-kernel.js', 'lighting-natives.js', 'Lighting64.js', 'native-library-loader.js']
        .map((name) => [`/${name}`, path.join(root, 'browser-jvm', name)]),
    ...sdkNames.map((name) => [`/${name}`, path.join(frozenSdk, name)]),
]);
const inputs = [source, path.join(root, 'browser-jvm/verify-lighting-world.mjs'), gameJar, nativeLibrary, ...files.values()]
    .filter((file) => file !== archive);
const evidence = { pass: false, before: {}, after: {}, requests: [], denied: [], errors: [] };

evidence.before = Object.fromEntries(await Promise.all(inputs.map(async (file) => [file, await hashFile(file)])));
let browser;
let server;

try {
    await command('javac', ['--release', '17', '-cp', gameJar, '-d', classes, source]);
    await command('jar', ['--create', '--file', archive, '-C', classes, 'WorldLightingQualification.class']);
    evidence.before[archive] = await hashFile(archive);
    const args = ['-cp', `${classes};${gameJar}`, 'WorldLightingQualification', nativeLibrary];
    const runs = await Promise.allSettled([command('java', args), command('java', args)]);

    for (const result of runs) {
        assert.equal(result.status, 'fulfilled', String(result.reason));
    }

    const [first, repeated] = runs.map((result) => result.value);

    await writeFile(path.join(output, 'native.txt'), first);
    await writeFile(path.join(output, 'native-repeated.txt'), repeated);
    assert.equal(first, repeated, 'fresh native JVM determinism');
    const expected = referenceLines(first);
    const cells = expected.filter((line) => line.startsWith('WORLD CELL ')).length;

    assert.equal(cells, 15_563);
    assert.equal(expected.length, 15_830);
    evidence.payloads = { cells, integers: cells * 49, publications: 11, chunkRecords: 245 };
    evidence.native = { deterministic: true, lines: expected };
    const classpath = ['/app/qualification.jar', ...sdkNames.map((name) => `/app/${name}`)].join(':');
    const html = `<script src="https://cjrtnc.leaningtech.com/4.3/loader.js"></script><script type="module">
        import {installNativeLibraryLoader} from '/native-library-loader.js';
        try {
            await cheerpjInit({version:17,status:'none',javaProperties:['java.library.path=/app/'],natives:{
                Java_WorldLightingQualification_report(lib,json){globalThis.result=JSON.parse(String(json));}
            }});
            const installed=installNativeLibraryLoader(globalThis.cj3Module);
            const code=await cheerpjRunMain('WorldLightingQualification','${classpath}','browser');
            if(!globalThis.result)throw new Error('Missing world JNI report, exit '+code);
            globalThis.result.loaderInstalled=installed;
        }catch(error){globalThis.result={pass:false,error:String(error.stack||error)};}
        finally{globalThis.completed=true;}
        </script>`;

    server = createServer(async (request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        const record = { method: request.method, pathname, range: request.headers.range ?? null };

        evidence.requests.push(record);
        response.on('finish', () => {
            record.status = response.statusCode;
        });

        try {
            if (!['GET', 'HEAD'].includes(request.method)) {
                response.writeHead(405).end();

                return;
            }

            if (pathname === '/') {
                response.writeHead(200, { 'Content-Type': 'text/html' }).end(request.method === 'HEAD' ? '' : html);

                return;
            }

            const file = files.get(pathname);

            if (!file) {
                response.writeHead(404).end();

                return;
            }

            const size = (await stat(file)).size;
            const range = /^bytes=(\d+)-(\d*)$/u.exec(request.headers.range ?? '');
            const start = range ? Number(range[1]) : 0;
            const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;

            if (start < 0 || start >= size || end < start || (request.headers.range && !range)) {
                response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();

                return;
            }

            const headers = {
                'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
                'Content-Type': pathname.endsWith('.js') ? 'text/javascript' : 'application/octet-stream',
            };

            if (range) {
                headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
            }

            response.writeHead(range ? 206 : 200, headers);

            if (request.method === 'HEAD') {
                response.end();
            } else {
                const stream = createReadStream(file, { start, end });

                stream.on('error', () => response.destroy());
                response.on('close', () => stream.destroy());
                stream.pipe(response);
            }
        } catch (error) {
            evidence.errors.push(String(error));
            response.destroy();
        }
    });
    await new Promise((done, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', done);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;

    browser = await chromium.launch({ executablePath, headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block' });

    await context.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const allowed = url.origin === origin
            || (url.origin === 'https://cjrtnc.leaningtech.com' && url.pathname.startsWith('/4.3/'));

        if (allowed && ['GET', 'HEAD'].includes(request.method())) {
            await route.continue();
        } else {
            evidence.denied.push({ url: request.url(), method: request.method() });
            await route.abort();
        }
    });
    const page = await context.newPage();
    const logs = [];

    page.on('console', (message) => logs.push(message.text()));
    page.on('pageerror', (error) => evidence.errors.push(String(error)));
    await page.goto(origin);
    await page.waitForFunction(() => globalThis.completed, undefined, { timeout: 180_000 });
    const result = await page.evaluate(() => globalThis.result);
    const actual = referenceLines(logs.join(''));

    evidence.browser = { result, lines: actual, logs, version: browser.version() };
    assert.equal(result.pass, true, result.error);
    assert.equal(result.originalInitialization, true);
    assert.equal(result.javaFailureCleanup, true);
    assert.equal(result.originalStop, true);
    assert.deepEqual(actual, expected, 'original native/browser world JNI');
    assert.equal(evidence.denied.length, 0);
    assert.equal(evidence.errors.length, 0);
    evidence.pass = true;
} catch (error) {
    evidence.error = String(error.stack || error);
} finally {
    await browser?.close();

    if (server) {
        server.closeAllConnections();
        await new Promise((done) => {
            server.close(done);
        });
    }

    evidence.closed = true;
    evidence.after = Object.fromEntries(await Promise.all(Object.keys(evidence.before).map(async (file) => [file, await hashFile(file)])));
    evidence.inputsUnchanged = JSON.stringify(evidence.before) === JSON.stringify(evidence.after);
    evidence.pass = evidence.pass && evidence.inputsUnchanged;
    await writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
}

assert.equal(evidence.pass, true, evidence.error || 'input hashes changed');
console.info(JSON.stringify({
    pass: evidence.pass, payloads: evidence.payloads, lines: evidence.browser.lines.length,
    inputsUnchanged: evidence.inputsUnchanged, closed: evidence.closed,
}));
