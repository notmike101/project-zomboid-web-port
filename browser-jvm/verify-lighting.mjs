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
import { createLightingNatives } from './lighting-natives.js';
import { installNativeLibraryLoader } from './native-library-loader.js';

const { PZ_JDK: jdk, PZ_BROWSER: executablePath, PZ_GAME_DIR: installation } = process.env;

if (!jdk || !executablePath || !installation || process.platform !== 'win32') {
    throw new Error('Set PZ_JDK (JDK25+), PZ_BROWSER and PZ_GAME_DIR on Windows. Prepare the play SDK profile first.');
}

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'target/browser-jvm/lighting-qualification');
const classes = path.join(output, 'classes');
const archive = path.join(output, 'qualification.jar');
const source = path.join(root, 'browser-jvm/LightingQualification.java');
const gameJar = path.join(installation, 'projectzomboid.jar');
const nativeLibrary = path.join(installation, 'Lighting64.dll');
const sdkNames = [
    'animation-entry.jar', 'animation-view.jar', 'animation-sdk-view.jar', 'path-view.jar',
    'float-bridge.jar', 'memory-bridge.jar', 'world-entry.jar', 'atomic-view.jar',
];
const modes = ['general', 'incremental', 'publication', 'pending', 'overlap'];
const expectedLines = { general: 976, incremental: 1_040, publication: 18, pending: 18, overlap: 20 };
const directions = [[0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1]];
const run = promisify(execFile);

/**
 * Hashes an input through a stream without changing installed files.
 *
 * @param {string} file - Actual input file path.
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
 * Runs one bounded JDK build or data-only native reference process.
 *
 * @param {string} name - JDK executable basename.
 * @param {string[]} args - Literal executable arguments.
 * @returns {Promise<string>} Process standard output.
 */
async function command(name, args) {
    const binary = path.join(jdk, 'bin', `${name}.exe`);
    const result = await run(binary, args, {
        cwd: output, windowsHide: true, timeout: 90_000, maxBuffer: 8 * 1_024 * 1_024,
    });

    return result.stdout;
}

/**
 * Produces a canonical undirected edge key.
 *
 * @param {number} x - First X.
 * @param {number} y - First Y.
 * @param {number} adjacentX - Second X.
 * @param {number} adjacentY - Second Y.
 * @returns {string} Canonical endpoint pair.
 */
function edgeKey(x, y, adjacentX, adjacentY) {
    return [[x, y], [adjacentX, adjacentY]].sort((a, b) => a[1] - b[1] || a[0] - b[0])
        .map((point) => point.join(',')).join(':');
}

/**
 * Builds independent original adjacency and vision inputs from opaque cardinal edges.
 *
 * @param {string} name - Fixture name.
 * @param {number} width - Width in squares.
 * @param {number} height - Height in squares.
 * @param {number[][]} edges - Blocked undirected cardinal edges.
 * @param {object[]} lights - Original static light inputs.
 * @param {number[]} player - Actual player position.
 * @returns {object} Complete authored scene.
 */
function makeScene(name, width, height, edges, lights, player = [1.5, 1.5]) {
    const blocked = new Set(edges.map((edge) => edgeKey(...edge)));
    /**
     * Tests whether a coordinate belongs to the authored scene.
     *
     * @param {number} x - Local X.
     * @param {number} y - Local Y.
     * @returns {boolean} Whether the square is inside.
     */
    const inside = (x, y) => x >= 0 && x < width && y >= 0 && y < height;
    /**
     * Tests one opaque cardinal edge without consulting lighting results.
     *
     * @param {number} x - Source X.
     * @param {number} y - Source Y.
     * @param {number} adjacentX - Destination X.
     * @param {number} adjacentY - Destination Y.
     * @returns {boolean} Whether the cardinal edge is open.
     */
    const cardinal = (x, y, adjacentX, adjacentY) => inside(x, y) && inside(adjacentX, adjacentY)
        && !blocked.has(edgeKey(x, y, adjacentX, adjacentY));
    const cells = [];

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            let mask = 0;
            let vision = 0;

            for (const [direction, [dx, dy]] of directions.entries()) {
                const adjacentX = x + dx;
                const adjacentY = y + dy;
                let allowed = cardinal(x, y, adjacentX, adjacentY);

                if (dx && dy) {
                    allowed = cardinal(x, y, adjacentX, y) && cardinal(x, y, x, adjacentY)
                        && cardinal(adjacentX, y, adjacentX, adjacentY) && cardinal(x, adjacentY, adjacentX, adjacentY);
                }

                if (allowed) {
                    mask |= 1 << direction;
                } else {
                    vision |= 1 << dx + 1 + (dy + 1) * 3 + 9;
                }
            }

            cells.push({ mask, vision });
        }
    }

    return { name, width, height, cells, lights, player };
}

/**
 * Generates reproducible arbitrary opaque edges independently of lighting output.
 *
 * @param {number} width - Scene width.
 * @param {number} height - Scene height.
 * @param {number} seed - Fixed generator seed.
 * @param {number} density - Edge blocking probability.
 * @returns {number[][]} Generated cardinal walls.
 */
function noiseEdges(width, height, seed, density) {
    const edges = [];
    let state = seed;
    /**
     * Advances the reproducible fixture generator.
     *
     * @returns {number} Next value in the half-open unit interval.
     */
    const random = () => {
        state = Math.imul(state, 1_664_525) + 1_013_904_223 >>> 0;

        return state / 4_294_967_296;
    };

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (x + 1 < width && random() < density) {
                edges.push([x, y, x + 1, y]);
            }

            if (y + 1 < height && random() < density) {
                edges.push([x, y, x, y + 1]);
            }
        }
    }

    return edges;
}

/**
 * Describes one authored original static light.
 *
 * @param {number} id - Original identifier.
 * @param {number} x - Local square X.
 * @param {number} y - Local square Y.
 * @param {number} radius - Native radius.
 * @param {number[]} color - Original RGB floats.
 * @returns {object} Static light input.
 */
function light(id, x, y, radius, color) {
    return { id, x, y, radius, color };
}

const scenes = [
    makeScene('open', 8, 8, [], [light(1, 2, 3, 6, [1, 0.25, 0.1])]),
    makeScene('gap', 8, 8, Array.from({ length: 8 }, (value, y) => [3, y, 4, y]).filter((edge) => edge[1] !== 3),
        [light(1, 2, 3, 6, [1, 0.25, 0.1])]),
    makeScene('maze', 8, 8, [
        ...[0, 1, 2, 4, 5, 6, 7].map((y) => [3, y, 4, y]),
        ...[0, 1, 2, 3, 5, 6, 7].map((x) => [x, 4, x, 5]),
    ], [light(1, 1, 2, 7, [1, 0.4, 0.2])]),
    makeScene('two', 8, 8, [], [light(9, 6, 6, 5, [0.1, 0.2, 1]), light(2, 1, 2, 6, [1, 0.3, 0.1])]),
    makeScene('seam', 16, 8, [0, 1, 2, 3, 5, 6, 7].map((y) => [7, y, 8, y]),
        [light(3, 6, 4, 8, [0.2, 1, 0.5]), light(4, 12, 2, 5, [1, 0.1, 0.3])]),
    makeScene('noise1', 8, 8, noiseEdges(8, 8, 7_123, 0.18), [
        light(27, 1, 1, 8, [0.8, 0.1, 0.3]), light(4, 6, 6, 7, [0.1, 0.7, 1]), light(15, 3, 4, 6, [0.5, 0.4, 0.2]),
    ], [3.5, 3.5]),
    makeScene('noise2', 16, 16, noiseEdges(16, 16, 18_472, 0.11), [
        light(51, 1, 1, 14, [0.9, 0.1, 0.3]), light(8, 14, 14, 14, [0.1, 0.7, 0.9]),
        light(29, 7, 5, 10, [0.2, 0.4, 0.1]), light(1, 5, 11, 9, [0.5, 0.2, 0.9]), light(90, 12, 3, 8, [0.8, 0.6, 0.1]),
    ], [8.5, 8.5]),
    makeScene('noise3', 24, 8, noiseEdges(24, 8, 9_831, 0.26), [
        light(10, 1, 3, 15, [0.4, 0.2, 0.7]), light(2, 11, 4, 14, [0.1, 0.8, 0.6]), light(3, 22, 6, 12, [0.8, 0.4, 0.1]),
    ], [12.5, 4.5]),
];

/**
 * Encodes authored inputs in Java DataInputStream's fixed big-endian format.
 *
 * @returns {Buffer} Complete fixture transport.
 */
function encodeScenes() {
    const pieces = [];
    /**
     * Appends one Java big-endian int.
     *
     * @param {number} value - Integer fixture field.
     */
    const integer = (value) => {
        const bytes = Buffer.alloc(4);

        bytes.writeInt32BE(value);
        pieces.push(bytes);
    };

    /**
     * Appends one Java big-endian float.
     *
     * @param {number} value - Float fixture field.
     */
    const float = (value) => {
        const bytes = Buffer.alloc(4);

        bytes.writeFloatBE(value);
        pieces.push(bytes);
    };

    integer(scenes.length);

    for (const scene of scenes) {
        const name = Buffer.from(scene.name);
        const length = Buffer.alloc(2);

        length.writeUInt16BE(name.length);
        pieces.push(length, name);
        integer(scene.width);
        integer(scene.height);

        for (const value of scene.player) {
            float(value);
        }

        integer(scene.lights.length);

        for (const point of scene.lights) {
            for (const value of [point.id, point.x, point.y, point.radius]) {
                integer(value);
            }

            for (const value of point.color) {
                float(value);
            }
        }

        for (const cell of scene.cells) {
            integer(cell.mask);
            integer(cell.vision);
        }
    }

    return Buffer.concat(pieces);
}

/**
 * Selects comparable original native output while retaining full raw logs privately.
 *
 * @param {string} text - Java standard output.
 * @returns {string[]} Complete payload, counter and dirty-bit lines.
 */
function referenceLines(text) {
    return text.split(/\r?\n/).filter((line) => /^(GRID|FRAME|DONE|CELL|PUB|PENDING) /u.test(line));
}

/**
 * Stages the small authored indoor plane for atomic-publication rejection checks.
 *
 * @param {object} methods - Actual production JNI protocol methods.
 * @param {boolean} geometry - Whether to submit the initial complete chunk.
 * @param {boolean} [cleared] - Whether the original LOS cache was invalidated.
 */
function stageValidationPlane(methods, geometry, cleared = true) {
    const scene = scenes[0];

    methods.stateBeginUpdate(0, 0, 0, 1, 1);
    methods.playerSet(1.5, 1.5, 32, 1, 0, false, false, false, false, 0, 20, Math.fround(-0.2));
    methods.stateEndFrame(1, 1, 1, Math.fround(0.1), 1, 20, 20, cleared, 100, 0);

    if (geometry) {
        methods.chunkBeginUpdate(0, 0, 32, 32);
        methods.chunkLevelBeginUpdate(32);

        for (let y = 0; y < 8; y++) {
            for (let x = 0; x < 8; x++) {
                const cell = scene.cells[y * 8 + x];

                methods.squareBeginUpdate(x, y, 32);
                methods.squareSet(cell.mask, false, false, false, cell.vision, -1n, -1n, 0, false);
                methods.squareSetLightTransmission(1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0);
                methods.squareEndUpdate();
            }
        }

        methods.chunkLevelEndUpdate();
        methods.chunkEndUpdate();
    }
}

/**
 * Checks unsupported inputs and ensures failed input does not publish state.
 */
function verifyValidation() {
    const calls = [];
    const runtime = {
        /**
         * Records the original native loader ABI without dereferencing test pointers.
         *
         * @param {...unknown} args - Delegated native arguments.
         * @returns {number} Distinct reference handle.
         */
        cj3LoadLibrary(...args) {
            calls.push(args);

            return 17;
        },
    };
    const continuation = {};

    assert.equal(installNativeLibraryLoader(runtime), true);
    assert.equal(runtime.JVM_LoadLibrary(123, true, continuation), 17);
    assert.deepEqual(calls, [[123, -1, continuation]]);
    const installed = runtime.JVM_LoadLibrary;

    assert.equal(installNativeLibraryLoader(runtime), false);
    assert.equal(runtime.JVM_LoadLibrary, installed);
    assert.throws(() => installNativeLibraryLoader({}), /unavailable/u);
    assert.throws(() => installNativeLibraryLoader({ ...runtime, JVM_LoadLibrary: 1 }), /Invalid/u);

    for (const mutate of [
        (scene) => {
            scene.width = Number.NaN;
        },
        (scene) => {
            scene.cells[0].mask = -1;
        },
        (scene) => {
            scene.cells[0].vision = 2 ** 27;
        },
        (scene) => {
            delete scene.cells[0];
        },
        (scene) => {
            scene.player[0] = Number.POSITIVE_INFINITY;
        },
        (scene) => {
            delete scene.player[0];
        },
        (scene) => {
            scene.lights[0].radius = 0;
        },
        (scene) => {
            scene.lights[0].color[1] = Number.NaN;
        },
        (scene) => {
            delete scene.lights[0].color[1];
        },
        (scene) => {
            scene.lights.push({ ...scene.lights[0] });
        },
    ]) {
        const invalid = structuredClone(scenes[0]);

        mutate(invalid);
        assert.throws(() => calculateLighting(invalid), /Unsupported lighting boundary/u);
    }

    const backend = createLightingNatives();
    const before = backend.snapshot();

    assert.throws(() => backend.methods.configure(Number.NaN));
    assert.deepEqual(backend.snapshot(), before);
    backend.methods.configure(Math.fround(0.005));
    const ready = backend.snapshot();

    assert.throws(() => backend.methods.stateBeginUpdate(0, 0, 0, Number.NaN, 1));
    assert.deepEqual(backend.snapshot(), ready);
    backend.methods.stateBeginUpdate(0, 0, 0, 1, 1);
    assert.throws(() => backend.methods.stateEndUpdate(), /incomplete region update/u);
    assert.equal(backend.methods.stateUpdateCounter(0), -1);
    assert.deepEqual(backend.snapshot(), ready);
    assert.throws(() => backend.methods.updateTorch(), /Unsupported lighting boundary/u);
    backend.methods.destroy();
    stageValidationPlane(backend.methods, true);
    backend.methods.stateEndUpdate();
    assert.throws(() => backend.methods.getSquareLighting(0, 1, 1, 32, new Int32Array(49)), /unpublished lighting readback/u);
    backend.methods.DoLightingUpdateNew(1_000_000_000n, false);
    stageValidationPlane(backend.methods, false);
    backend.methods.stateEndUpdate();
    backend.methods.DoLightingUpdateNew(1_100_000_000n, false);
    assert.equal(backend.snapshot().updates.length, 1);
    const published = new Int32Array(49);

    backend.methods.getSquareLighting(0, 1, 1, 32, published);
    const retained = backend.snapshot();
    const counter = backend.methods.stateUpdateCounter(0);

    stageValidationPlane(backend.methods, false);
    assert.throws(() => backend.methods.playerSet(-0.5, 1.5, 32, 1, 0,
        false, false, false, false, 0, 20, Math.fround(-0.2)), /moving-player history/u);
    const afterFailure = new Int32Array(49);

    backend.methods.getSquareLighting(0, 1, 1, 32, afterFailure);
    assert.deepEqual(afterFailure, published);
    assert.equal(backend.methods.stateUpdateCounter(0), counter);
    assert.deepEqual(backend.snapshot(), retained);
    backend.methods.destroy();
    assert.deepEqual(backend.snapshot().updates, []);
    stageValidationPlane(backend.methods, true);
    backend.methods.stateEndUpdate();
    backend.methods.DoLightingUpdateNew(1_000_000_000n, false);
    const unchanged = backend.snapshot();

    stageValidationPlane(backend.methods, false, false);
    backend.methods.chunkBeginUpdate(0, 0, 32, 32);
    backend.methods.chunkLevelBeginUpdate(32);
    backend.methods.squareBeginUpdate(0, 0, 32);
    backend.methods.squareSet(scenes[0].cells[0].mask, false, false, false,
        scenes[0].cells[0].vision ^ 512, -1n, -1n, 0, false);
    backend.methods.squareSetLightTransmission(1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0);
    backend.methods.squareEndUpdate();
    backend.methods.chunkLevelEndUpdate();
    backend.methods.chunkEndUpdate();
    assert.throws(() => backend.methods.stateEndUpdate(), /without LOS invalidation/u);
    assert.equal(backend.methods.stateUpdateCounter(0), 0);
    assert.deepEqual(backend.snapshot(), unchanged);
    backend.methods.destroy();
}

verifyValidation();
await mkdir(classes, { recursive: true });
const fixture = path.join(output, 'scenes.bin');

await writeFile(fixture, encodeScenes());
const files = new Map([
    ['/qualification.jar', archive], ['/scenes.bin', fixture],
    ['/lighting-kernel.js', path.join(root, 'browser-jvm/lighting-kernel.js')],
    ['/lighting-natives.js', path.join(root, 'browser-jvm/lighting-natives.js')],
    ['/Lighting64.js', path.join(root, 'browser-jvm/Lighting64.js')],
    ['/native-library-loader.js', path.join(root, 'browser-jvm/native-library-loader.js')],
]);

for (const name of sdkNames) {
    files.set(`/${name}`, path.join(root, 'target/browser-jvm/play', name));
}

const inputs = [source, gameJar, nativeLibrary, ...files.values()].filter((file) => file !== archive);
const evidence = { pass: false, before: {}, after: {}, native: {}, browser: {}, requests: [], denied: [], errors: [] };

evidence.before = Object.fromEntries(await Promise.all(inputs.map(async (input) => [input, await hashFile(input)])));

let browser;
let server;

try {
    await command('javac', ['--release', '17', '-cp', gameJar, '-d', classes, source]);
    await command('jar', ['--create', '--file', archive, '-C', classes, 'LightingQualification.class']);
    evidence.before[archive] = await hashFile(archive);

    const nativeResults = await Promise.allSettled(modes.map(async (mode) => {
        const args = ['-cp', `${classes};${gameJar}`, 'LightingQualification', nativeLibrary, mode, fixture];
        const runs = await Promise.allSettled([command('java', args), command('java', args)]);

        for (const result of runs) {
            assert.equal(result.status, 'fulfilled', String(result.reason));
        }

        const [first, repeated] = runs.map((result) => result.value);

        await writeFile(path.join(output, `native-${mode}.txt`), first);
        await writeFile(path.join(output, `native-${mode}-repeated.txt`), repeated);
        const originalLines = first.split(/\r?\n/u);
        const repeatedLines = repeated.split(/\r?\n/u);
        const difference = originalLines.findIndex((line, index) => line !== repeatedLines[index]);

        assert.ok(first === repeated, `fresh native JVM determinism: ${mode}, line ${difference + 1}: `
        + `${originalLines[difference]} versus ${repeatedLines[difference]}`);
        evidence.native[mode] = { deterministic: true, lines: referenceLines(first) };
        assert.equal(evidence.native[mode].lines.length, expectedLines[mode]);
    }));

    for (const result of nativeResults) {
        assert.equal(result.status, 'fulfilled', String(result.reason));
    }

    let compared = 0;
    const predictions = new Map(scenes.map((scene) => [scene.name, calculateLighting(scene)]));

    for (const line of evidence.native.general.lines) {
        const match = /^GRID (\w+) (\d+) (\d+) (\[.*\])$/u.exec(line);

        if (match) {
            const [, name, x, y, json] = match;
            const scene = scenes.find((candidate) => candidate.name === name);
            const payload = predictions.get(name)[Number(y) * scene.width + Number(x)];

            assert.deepEqual(payload, JSON.parse(json), `pure kernel ${name}:${x},${y}`);
            compared++;
        }
    }

    assert.equal(compared, 896);
    evidence.kernel = { cells: compared, integers: compared * 49 };
    const classpath = ['/app/qualification.jar', ...sdkNames.map((name) => `/app/${name}`)].join(':');
    const pages = new Map(modes.map((mode) => [`/${mode}.html`, `<script src="https://cjrtnc.leaningtech.com/4.3/loader.js"></script>
        <script type="module">
            import {installNativeLibraryLoader} from '/native-library-loader.js';
            try {
                await cheerpjInit({version:17,status:'none',javaProperties:['java.library.path=/app/'],natives:{
                    Java_LightingQualification_report(lib,json){globalThis.result=JSON.parse(String(json));}
                }});
                const installed=installNativeLibraryLoader(globalThis.cj3Module);
                const code=await cheerpjRunMain('LightingQualification','${classpath}','browser','${mode}','/app/scenes.bin');
                if(!globalThis.result)throw new Error('Missing JNI qualification report, exit '+code);
                globalThis.result.loaderInstalled=installed;
            } catch(error) {globalThis.result={pass:false,error:String(error.stack||error)};}
            finally {globalThis.completed=true;}
        </script>`]));

    server = createServer(async (request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        const record = { method: request.method, pathname, range: request.headers.range ?? null };

        evidence.requests.push(record);
        response.on('finish', () => {
            record.status = response.statusCode;
        });

        try {
            if (!['GET', 'HEAD'].includes(request.method)) {
                throw new Error('readonly qualification server');
            }

            if (pages.has(pathname)) {
                response.writeHead(200, { 'Content-Type': 'text/html' }).end(pages.get(pathname));

                return;
            }

            const file = files.get(pathname);

            if (!file) {
                if (pathname === '/PortMissingLightingService.js') {
                    response.writeHead(404).end();

                    return;
                }

                throw new Error('outside qualification allowlist');
            }

            const { size } = await stat(file);
            const range = /^bytes=(\d+)-(\d*)$/u.exec(request.headers.range ?? '');
            let start = 0;
            let end = size - 1;

            if (range) {
                start = Number(range[1]);

                if (range[2]) {
                    end = Math.min(Number(range[2]), end);
                }
            }

            if ((request.headers.range && !range) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
                || start < 0 || end < start || start >= size) {
                response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();

                return;
            }

            const headers = { 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': 'application/octet-stream' };

            if (pathname.endsWith('.js')) {
                headers['Content-Type'] = 'text/javascript';
            }

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
            evidence.denied.push({ pathname, error: String(error) });

            if (!response.headersSent) {
                response.writeHead(404).end();
            } else {
                response.destroy();
            }
        }
    });
    await new Promise((done, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', done);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;

    browser = await chromium.launch({ executablePath, headless: true });
    evidence.browserVersion = browser.version();

    /**
     * Runs one isolated Java17 browser JVM against the actual native reference.
     *
     * @param {string} mode - Fixture protocol to compare.
     */
    async function qualifyBrowser(mode) {
        const context = await browser.newContext({ serviceWorkers: 'block' });
        const logs = [];

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

        page.on('console', (message) => logs.push(message.text()));
        page.on('pageerror', (error) => evidence.errors.push(String(error)));
        await page.goto(`${origin}/${mode}.html`);
        await page.waitForFunction(() => globalThis.completed, undefined, { timeout: 180_000 });
        const result = await page.evaluate(() => globalThis.result);
        const actual = referenceLines(logs.join(''));

        evidence.browser[mode] = { result, lines: actual, logs };
        assert.equal(result.pass, true, result.error);
        assert.equal(result.originalInitialization, true);
        assert.equal(result.javaFailureCleanup, true);
        assert.deepEqual(actual, evidence.native[mode].lines, `browser/native ${mode}`);
        await context.close();
    }

    await qualifyBrowser('general');
    await qualifyBrowser('incremental');
    await qualifyBrowser('publication');
    await qualifyBrowser('pending');
    await qualifyBrowser('overlap');

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

    evidence.after = Object.fromEntries(await Promise.all(Object.keys(evidence.before)
        .map(async (input) => [input, await hashFile(input)])));

    evidence.inputsUnchanged = JSON.stringify(evidence.before) === JSON.stringify(evidence.after);
    evidence.pass = evidence.pass && evidence.inputsUnchanged;
    await writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
}

assert.equal(evidence.pass, true, evidence.error || 'input hashes or native comparison failed');
console.info(JSON.stringify({
    pass: evidence.pass, kernel: evidence.kernel, browser: evidence.browserVersion,
    lines: Object.fromEntries(modes.map((mode) => [mode, evidence.browser[mode].lines.length])),
    inputsUnchanged: evidence.inputsUnchanged, closed: evidence.closed,
}));
