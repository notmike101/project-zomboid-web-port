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

const output = path.join(root, 'target/browser-jvm/lighting-vertical-qualification');
const classes = path.join(output, 'classes');
const source = path.join(root, 'browser-jvm/LightingVerticalQualification.java');
const archive = path.join(output, 'qualification.jar');
const gameJar = path.join(installation, 'projectzomboid.jar');
const nativeLibrary = path.join(installation, 'Lighting64.dll');
const sdkNames = [
    'animation-entry.jar', 'animation-view.jar', 'animation-sdk-view.jar', 'path-view.jar',
    'float-bridge.jar', 'memory-bridge.jar', 'world-entry.jar', 'atomic-view.jar',
];
const directions = [[0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1]];
const cases = [
    ...['closed', 'open', 'hole', 'down', 'stairs', 'many', 'geometry', 'world', 'null'].map((name) => [name, 33, 32]),
    ['up', 32, 32], ['open', 32, 34], ['stairs-hole', 33, 34], ['stairs-blocked', 33, 34],
    ['origin', 32, 32], ['asymmetric', 32, 32], ['asymmetric-vertex', 32, 32],
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
 * Derives a deterministic undirected three-dimensional opaque edge.
 *
 * @param {number} width - Region width.
 * @param {number[]} first - First square coordinates.
 * @param {number[]} second - Second square coordinates.
 * @returns {boolean} Whether the authored geometry admits this edge.
 */
function edge(width, first, second) {
    const [x, y, z] = second;

    if (x < 0 || x >= width || y < 0 || y >= width || z < 32 || z > 34) {
        return false;
    }

    const a = (first[2] - 32) * width * width + first[1] * width + first[0];
    const b = (z - 32) * width * width + y * width + x;

    return (Math.min(a, b) * 31 + Math.max(a, b) * 17 + 19) % 7 !== 0;
}

/**
 * Constructs one independent original JNI input square.
 *
 * @param {string} kind - Fixture geometry.
 * @param {number} width - Region width.
 * @param {number} x - Square X.
 * @param {number} y - Square Y.
 * @param {number} z - Native level.
 * @returns {object|null} Authored square input, or explicit absence.
 */
function makeSquare(kind, width, x, y, z) {
    if (kind.startsWith('asymmetric')) {
        const source = kind === 'asymmetric-vertex';
        const edgeBit = source ? 64 : 4;
        const mask = x === (source ? 2 : 3) && y === 2 && z === 32 ? edgeBit : 0;

        return { mask, vision: 0, up: false, down: false, stairs: false };
    }

    if (kind === 'null' && x === 3 && y === 3 && z === 33) {
        return null;
    }

    const varied = kind === 'geometry' || kind === 'world';
    const hole = kind !== 'closed' && kind !== 'stairs-blocked'
        && (!['hole', 'stairs-hole'].includes(kind) || (x === 4 && y === 4));
    let up = hole && z < 34 && kind !== 'down';
    let down = hole && z > 32 && kind !== 'up';

    if (varied) {
        up = edge(width, [x, y, z], [x, y, z + 1]);
        down = edge(width, [x, y, z], [x, y, z - 1]);
    }

    if (kind === 'origin') {
        up = z < 34 && (x + y + 288) % 7 !== 0;
        down = z > 32 && (x + y + 288) % 7 !== 0;
    }

    let mask = 0;
    let vision = 0;

    for (const [direction, [dx, dy]] of directions.entries()) {
        if (x + dx >= 0 && x + dx < width && y + dy >= 0 && y + dy < width
            && (!varied || edge(width, [x, y, z], [x + dx, y + dy, z]))) {
            mask |= 1 << direction;
        }
    }

    for (let dz = -1; dz <= 1; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                let blocked = x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= width
                    || z + dz < 32 || z + dz > 34 || (dz > 0 && !up) || (dz < 0 && !down);

                if (varied) {
                    blocked = !edge(width, [x, y, z], [x + dx, y + dy, z + dz]);
                }

                if (blocked) {
                    vision |= 1 << dx + 1 + (dy + 1) * 3 + (dz + 1) * 9;
                }
            }
        }
    }

    return { mask, vision, up, down, stairs: kind.startsWith('stairs') && x === 4 && y === 4 };
}

/**
 * Builds a complete three-level scene independently from original native output.
 *
 * @param {string} kind - Fixture geometry.
 * @param {number} lightZ - Native light level.
 * @param {number} playerZ - Native player level.
 * @returns {object} Kernel scene.
 */
function makeScene(kind, lightZ, playerZ) {
    const width = kind === 'world' || kind === 'origin' ? 24 : 8;
    const cells = [];

    for (let z = 32; z <= 34; z++) {
        for (let y = 0; y < width; y++) {
            for (let x = 0; x < width; x++) {
                cells.push(makeSquare(kind, width, x, y, z));
            }
        }
    }

    const lights = [{
        id: 1, x: width === 24 ? 19 : 4, y: width === 24 ? 12 : 4, z: lightZ,
        radius: width === 24 ? 14 : 10, color: [Math.fround(0.2), 1, Math.fround(0.5)],
    }];

    if (kind === 'origin') {
        lights[0] = {
            id: 1, x: 8, y: 18, z: lightZ, radius: 9,
            color: [1, Math.fround(0.784_313_738_346_099_9), Math.fround(0.627_451_002_597_808_8)],
        };
    }

    if (kind.startsWith('asymmetric')) {
        lights[0] = { id: 1, x: 2, y: 2, z: 32, radius: kind === 'asymmetric-vertex' ? 1 : 6, color: [1, 0.5, 0] };
    }

    if (kind === 'many') {
        for (const [index, [x, y, z]] of [[0, 0, 32], [7, 7, 34], [0, 7, 33], [7, 0, 32], [3, 3, 34], [2, 5, 33]].entries()) {
            lights.push({
                id: index + 2, x, y, z, radius: 8 + index,
                color: [Math.fround(Math.fround(0.3) + Math.fround(index * Math.fround(0.05))), Math.fround(0.4), Math.fround(0.8)],
            });
        }
    }

    return {
        width, height: width, minimum: 32, maximum: 34, cells, lights,
        player: [width === 24 ? 12.5 : 2.5, width === 24 ? 11.5 : 3.5, playerZ],
        ...(kind === 'origin' ? { origin: [144, 144, 0], player: [9.5, 14.5, playerZ] } : {}),
    };
}

/**
 * Selects complete comparable reference records from original Java output.
 *
 * @param {string} text - Standard output.
 * @returns {string[]} Packed-square and per-level publication lines.
 */
function referenceLines(text) {
    return text.split(/\r?\n/u).filter((line) => /^(VERTICAL|VRANGE) /u.test(line));
}

await mkdir(classes, { recursive: true });
const files = new Map([
    ['/qualification.jar', archive],
    ...['lighting-kernel.js', 'lighting-natives.js', 'Lighting64.js', 'native-library-loader.js']
        .map((name) => [`/${name}`, path.join(root, 'browser-jvm', name)]),
    ...sdkNames.map((name) => [`/${name}`, path.join(frozenSdk, name)]),
]);
const inputs = [source, path.join(root, 'browser-jvm/verify-lighting-vertical.mjs'), gameJar, nativeLibrary, ...files.values()]
    .filter((file) => file !== archive);
const evidence = { pass: false, before: {}, after: {}, requests: [], denied: [], errors: [] };

evidence.before = Object.fromEntries(await Promise.all(inputs.map(async (file) => [file, await hashFile(file)])));
let browser;
let server;

try {
    await command('javac', ['--release', '17', '-cp', gameJar, '-d', classes, source]);
    await command('jar', ['--create', '--file', archive, '-C', classes, 'LightingVerticalQualification.class']);
    evidence.before[archive] = await hashFile(archive);
    const args = ['-cp', `${classes};${gameJar}`, 'LightingVerticalQualification', nativeLibrary];
    const runs = await Promise.allSettled([command('java', args), command('java', args)]);

    for (const result of runs) {
        assert.equal(result.status, 'fulfilled', String(result.reason));
    }

    const [first, repeated] = runs.map((result) => result.value);

    await writeFile(path.join(output, 'native.txt'), first);
    await writeFile(path.join(output, 'native-repeated.txt'), repeated);
    assert.equal(first, repeated, 'fresh native JVM determinism');
    const expected = referenceLines(first);
    const scenes = new Map(cases.map(([name, lightZ, playerZ]) => {
        const scene = makeScene(name, lightZ, playerZ);
        const calculated = calculateLighting(scene);

        if (scene.origin) {
            for (const payload of calculated) {
                for (let record = 0; record < payload[13]; record++) {
                    payload[15 + record * 6] += scene.origin[0];
                    payload[16 + record * 6] += scene.origin[1];
                }
            }
        }

        return [`${name}:${lightZ}:${playerZ}`, { scene, output: calculated }];
    }));
    let cells = 0;

    for (const line of expected) {
        const match = /^VERTICAL ([\w-]+) (\d+) (\d+) (\d+) (\d+) (\d+) (\w+) (\w+) (\[.*\])$/u.exec(line);

        if (match) {
            const [, name, lightZ, playerZ, x, y, z, , ok, words] = match;
            const result = scenes.get(`${name}:${lightZ}:${playerZ}`);
            const index = (Number(z) - 32) * result.scene.width ** 2 + Number(y) * result.scene.width + Number(x);

            assert.equal(ok, 'true');
            assert.deepEqual(result.output[index], JSON.parse(words), `kernel ${name}:${x},${y},${z}`);
            cells++;
        }
    }

    assert.equal(cells, 6_143);
    evidence.kernel = { cells, integers: cells * 49 };
    evidence.native = { deterministic: true, lines: expected };
    const classpath = ['/app/qualification.jar', ...sdkNames.map((name) => `/app/${name}`)].join(':');
    const html = `<script src="https://cjrtnc.leaningtech.com/4.3/loader.js"></script><script type="module">
        import {installNativeLibraryLoader} from '/native-library-loader.js';
        try {
            await cheerpjInit({version:17,status:'none',javaProperties:['java.library.path=/app/'],natives:{
                Java_LightingVerticalQualification_report(lib,json){globalThis.result=JSON.parse(String(json));}
            }});
            const installed=installNativeLibraryLoader(globalThis.cj3Module);
            const code=await cheerpjRunMain('LightingVerticalQualification','${classpath}','browser');
            if(!globalThis.result)throw new Error('Missing vertical JNI report, exit '+code);
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
    assert.deepEqual(actual, expected, 'original native/browser vertical JNI');
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
    pass: evidence.pass, kernel: evidence.kernel, lines: evidence.browser.lines.length,
    inputsUnchanged: evidence.inputsUnchanged, closed: evidence.closed,
}));
