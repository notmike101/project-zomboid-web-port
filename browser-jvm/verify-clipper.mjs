import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';

const { PZ_JDK: jdk, PZ_BROWSER: executablePath, PZ_GAME_JAR: gameJar } = process.env;

if (!jdk || !executablePath || !gameJar) {
    throw new Error('Set PZ_JDK, PZ_BROWSER and PZ_GAME_JAR. Prepare the play profile and its pinned Clipper2 dependency first.');
}

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'target/browser-jvm/clipper');
const classes = path.join(output, 'classes');
const archive = path.join(output, 'qualification.jar');
const prepared = path.join(root, 'target/browser-jvm/play/sprite-view.jar');
const dependency = path.join(root, '.tools/clipper2-2.0.1b.jar');
const nativeLibrary = path.join(path.dirname(gameJar), 'PZClipper64.dll');
const evidence = { pass: false, denied: [], logs: [] };
let browser;
let browserServer;
let deadline;
let server;

/**
 * Hashes an immutable input snapshot.
 *
 * @param {Buffer} bytes - Input file bytes.
 * @returns {string} SHA-256 digest.
 */
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Runs one bounded build or data-only native reference command.
 *
 * @param {string} name - JDK executable name.
 * @param {string[]} args - Literal process arguments.
 * @param {string} cwd - Private working directory.
 * @returns {string} Standard output from the completed process.
 */
function command(name, args, cwd = output) {
    const binary = path.join(jdk, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
    const result = spawnSync(binary, args, { cwd, encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 4 * 1_024 * 1_024 });

    if (result.error || result.status !== 0) {
        throw new Error(`${name} failed: ${result.error || result.stderr || result.stdout}`);
    }

    return result.stdout;
}

/**
 * Bounds an operation on this verifier's actual browser owner.
 *
 * @param {Promise<unknown>} operation - Owned browser operation.
 * @returns {Promise<unknown>} Its completion.
 */
async function bounded(operation) {
    let timer;

    try {
        return await Promise.race([operation, new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Owned browser cleanup exceeded five seconds')), 5_000);
        })]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Canonicalizes only the starting point, preserving the polygon's winding.
 *
 * @param {number[][]} points - Ordered ring coordinates.
 * @returns {string} Stable ring representation.
 */
function ring(points) {
    return points.map((_, index) => JSON.stringify([...points.slice(index), ...points.slice(0, index)])).sort()[0];
}

/**
 * Ignores ring starts and multipart ordering, retaining every other ABI result.
 *
 * @param {object[]} rows - Native or browser reports.
 * @returns {object[]} Reports suitable for exact equality.
 */
function canonical(rows) {
    return rows.map((row) => ({
        ...row,
        polygons: row.polygons.map((polygon) => ({ ...polygon, outer: ring(polygon.outer), holes: polygon.holes.map(ring).sort() })).sort((a, b) => a.outer.localeCompare(b.outer)),
    }));
}

/**
 * Computes an oriented cross product using double precision for every delta.
 *
 * @param {number[]} a - First point.
 * @param {number[]} b - Second point.
 * @param {number[]} c - Third point.
 * @returns {number} Twice the signed triangle area.
 */
function cross(a, b, c) {
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/**
 * Decodes the reported float32 vertex table without changing the stored raw report.
 *
 * @param {object} row - Raw indexed ABI report.
 * @returns {number[][][]} Counterclockwise triangles.
 */
function triangles(row) {
    const vertices = row.vertices.map((point) => point.map(Math.fround));
    const result = [];

    assert.equal(row.indices.length, row.returned);
    assert.equal(row.returned % 3, 0);

    for (let index = 0; index < row.returned; index += 3) {
        const ids = row.indices.slice(index, index + 3);

        assert(ids.every((id) => Number.isInteger(id) && id >= 0 && id < vertices.length));
        const triangle = ids.map((id) => vertices[id]);

        assert(cross(...triangle) > 0, 'Triangulation winding must remain strictly counterclockwise');
        result.push(triangle);
    }

    return result;
}

/**
 * Tests triangle coverage, allowing only double-arithmetic roundoff on shared edges.
 *
 * @param {number[][][]} mesh - Decoded triangles.
 * @param {number[]} point - Sample location.
 * @returns {boolean} Whether the polygon covers the location.
 */
function covers(mesh, point) {
    return mesh.some(([a, b, c]) => [cross(a, b, point), cross(b, c, point), cross(c, a, point)].every((value) => value >= -Number.EPSILON * 100));
}

/**
 * Compares genuine native and browser indexed meshes by ABI and geometric coverage.
 * Triangle index order is retained in the evidence and is not claimed identical.
 *
 * @param {object[]} reference - Original DLL reports.
 * @param {object[]} actual - Actual original browser JNI reports.
 * @returns {object[]} Geometric comparison summaries.
 */
function compareTriangulations(reference, actual) {
    assert.equal(reference.length, 10);
    assert.equal(actual.length, 10);

    return reference.map((native, index) => {
        const browser = actual[index];

        for (const field of ['triangulation', 'polygon', 'vertices', 'returned', 'position', 'limit', 'tailUnchanged']) {
            assert.deepEqual(browser[field], native[field], `Indexed ABI mismatch: ${field}`);
        }

        const nativeMesh = triangles(native);
        const browserMesh = triangles(browser);
        const nativeArea = nativeMesh.reduce((sum, triangle) => sum + cross(...triangle) / 2, 0);
        const browserArea = browserMesh.reduce((sum, triangle) => sum + cross(...triangle) / 2, 0);

        assert(Math.abs(nativeArea - browserArea) <= Math.max(1, nativeArea) * Number.EPSILON * 64, 'Triangle areas differ');
        const xs = native.vertices.map(([x]) => Math.fround(x));
        const ys = native.vertices.map(([, y]) => Math.fround(y));
        const bounds = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];

        for (let x = 0; x < 31; x++) {
            for (let y = 0; y < 31; y++) {
                const point = [bounds[0] + (bounds[1] - bounds[0]) * (2 * x + 1) / 62, bounds[2] + (bounds[3] - bounds[2]) * (2 * y + 1) / 62];

                assert.equal(covers(browserMesh, point), covers(nativeMesh, point), 'Triangle coverage differs');
            }
        }

        if (native.triangulation === 'hole') {
            assert.equal(covers(browserMesh, [5, 5]), false);
        } else if (native.triangulation === 'two-holes') {
            assert.equal(covers(browserMesh, [2, 2]), false);
            assert.equal(covers(browserMesh, [7, 7]), false);
        }

        return { name: native.triangulation, polygon: native.polygon, triangles: browserMesh.length, area: browserArea, coverageSamples: 961, identicalIndexOrder: JSON.stringify(native.indices) === JSON.stringify(browser.indices) };
    });
}

await mkdir(classes, { recursive: true });

try {
    const inputs = [path.resolve(gameJar), nativeLibrary, dependency, prepared, import.meta.filename,
        ...['host/port/host/ClipperSupport.java', 'ClipperQualification.java', 'ClipperTriangulationQualification.java', 'browser-physics.js'].map((name) => path.join(root, 'browser-jvm', name))];
    const snapshots = await Promise.all(inputs.map(async (file) => ({ file, sha256: hash(await readFile(file)) })));

    evidence.inputsBefore = snapshots;
    const provenance = JSON.parse(await readFile(path.join(root, 'browser-jvm/third-party/clipper2/provenance.json'), 'utf8'));

    assert.equal(snapshots[2].sha256, provenance.sha256, 'Pinned Clipper2 dependency hash');
    const originalDirectory = path.join(output, 'original');
    const viewDirectory = path.join(output, 'view');
    const entry = 'zombie/vehicles/Clipper.class';

    await mkdir(originalDirectory, { recursive: true });
    await mkdir(viewDirectory, { recursive: true });
    command('jar', ['--extract', '--file', path.resolve(gameJar), entry], originalDirectory);
    command('jar', ['--extract', '--file', prepared, entry], viewDirectory);
    const originalClass = await readFile(path.join(originalDirectory, entry));
    const viewClass = await readFile(path.join(viewDirectory, entry));

    assert.equal(viewClass.readUInt16BE(6), 61, 'Prepared Clipper must target Java 17');
    assert.deepEqual(viewClass.subarray(0, 6), originalClass.subarray(0, 6));
    assert.deepEqual(viewClass.subarray(8), originalClass.subarray(8), 'Original Clipper code changed');
    evidence.originalClipper = { originalSha256: hash(originalClass), viewSha256: hash(viewClass), codeUnchanged: true };
    const tessellatorEntries = command('jar', ['--list', '--file', prepared]).split(/\r?\n/).filter((name) => name.startsWith('org/lwjgl/util/glu/') && name.endsWith('.class'));

    assert(tessellatorEntries.includes('org/lwjgl/util/glu/tessellation/GLUtessellatorImpl.class'));
    command('jar', ['--extract', '--file', path.resolve(gameJar), ...tessellatorEntries], originalDirectory);
    command('jar', ['--extract', '--file', prepared, ...tessellatorEntries], viewDirectory);
    evidence.shippedTessellator = await Promise.all(tessellatorEntries.map(async (name) => {
        const original = await readFile(path.join(originalDirectory, name));
        const view = await readFile(path.join(viewDirectory, name));

        assert.deepEqual(view, original, 'Shipped GLU class changed');

        return { name, sha256: hash(view) };
    }));
    const viewArchive = path.join(output, 'clipper-view.jar');

    command('jar', ['--create', '--file', viewArchive, '-C', viewDirectory, '.']);
    command('javac', ['--release', '17', '-cp', [path.resolve(gameJar), dependency].join(path.delimiter), '-d', classes,
        path.join(root, 'browser-jvm/host/port/host/ClipperSupport.java'), path.join(root, 'browser-jvm/ClipperQualification.java'), path.join(root, 'browser-jvm/ClipperTriangulationQualification.java')]);
    command('jar', ['--create', '--file', archive, ...[
        'ClipperQualification.class', 'AdapterChecks.class', 'port/host/ClipperSupport.class',
        'port/host/ClipperSupport$State.class', 'port/host/ClipperSupport$Polygon.class',
        'port/host/ClipperSupport$Triangulation.class', 'port/host/ClipperSupport$Tessellation.class', 'ClipperTriangulationQualification.class',
    ].flatMap((name) => ['-C', classes, name])]);
    const stdout = command('java', ['--enable-native-access=ALL-UNNAMED', `-Djava.library.path=${path.dirname(path.resolve(gameJar))}`, '-Dzomboid.debuglibs.clipper=0',
        '-cp', [archive, dependency, path.resolve(gameJar)].join(path.delimiter), 'ClipperQualification', 'native']);

    await writeFile(path.join(output, 'native.jsonl'), stdout);
    evidence.nativeRows = stdout.split(/\r?\n/).filter((line) => line.startsWith('{"name":')).map(JSON.parse);
    assert.equal(evidence.nativeRows.length, 134, 'Missing native reference cases');
    assert.equal(evidence.nativeRows.filter((row) => row.operation === 1).length, 67, 'Missing intersection cases');
    assert.equal(evidence.nativeRows.filter((row) => row.operation === 3).length, 67, 'Missing difference cases');
    assert(stdout.includes('CLIPPER_ADAPTER_CHECKS_PASS'), 'Native adapter boundary assertions did not complete');
    const triangulationStdout = command('java', ['--enable-native-access=ALL-UNNAMED', `-Djava.library.path=${path.dirname(path.resolve(gameJar))}`, '-Dzomboid.debuglibs.clipper=0',
        '-cp', [archive, dependency, path.resolve(gameJar)].join(path.delimiter), 'ClipperTriangulationQualification', 'native']);

    await writeFile(path.join(output, 'native-triangulation.jsonl'), triangulationStdout);
    evidence.triangulationNativeRows = triangulationStdout.split(/\r?\n/).filter((line) => line.startsWith('{"triangulation":')).map(JSON.parse);
    assert.equal(evidence.triangulationNativeRows.length, 10);
    const html = `<link rel="icon" href="data:,"><script src="https://cjrtnc.leaningtech.com/4.3/loader.js"></script><script type="module">
        import { createBrowserPhysics } from '/browser-physics.js';
        try {
            const physics = createBrowserPhysics();
            await cheerpjInit({version:17,status:'none',javaProperties:['user.dir=/files/clipper-qualification'],natives:physics.natives});
            const code = await cheerpjRunMain('ClipperQualification','/app/qualification.jar:/app/clipper2.jar:/app/clipper-view.jar');
            const triangles = code === 0 ? await cheerpjRunMain('ClipperTriangulationQualification','/app/qualification.jar:/app/clipper2.jar:/app/clipper-view.jar') : -1;
            globalThis.result = {pass:code===0&&triangles===0,code,triangles,containers:physics.snapshot().clipperContainers};
        } catch (error) { globalThis.result={pass:false,error:String(error.stack||error)}; }
        finally { globalThis.completed=true; }
    </script>`;
    const files = new Map([
        ['/', Buffer.from(html)], ['/qualification.jar', await readFile(archive)],
        ['/clipper-view.jar', await readFile(viewArchive)], ['/clipper2.jar', await readFile(dependency)],
        ['/browser-physics.js', await readFile(path.join(root, 'browser-jvm/browser-physics.js'))],
        ['/ragdoll-definitions.js', await readFile(path.join(root, 'browser-jvm/ragdoll-definitions.js'))],
    ]);

    evidence.served = [...files].map(([route, bytes]) => ({ route, sha256: hash(bytes), bytes: bytes.length }));
    server = createServer((request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        const bytes = files.get(pathname);

        if (!['GET', 'HEAD'].includes(request.method) || !bytes) {
            evidence.denied.push({ pathname, method: request.method });
            response.writeHead(404).end();

            return;
        }

        const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;

        if ((request.headers.range && !range) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= bytes.length) {
            response.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` }).end();

            return;
        }

        let contentType = 'text/html';

        if (pathname.endsWith('.jar')) {
            contentType = 'application/java-archive';
        } else if (pathname.endsWith('.js')) {
            contentType = 'text/javascript';
        }

        const headers = {
            'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Content-Length': end - start + 1,
            'Content-Type': contentType,
        };

        if (range) {
            headers['Content-Range'] = `bytes ${start}-${end}/${bytes.length}`;
        }

        response.writeHead(range ? 206 : 200, headers);
        response.end(request.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1));
    });
    await new Promise((done, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', done);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;

    browserServer = await chromium.launchServer({ executablePath, headless: true });
    deadline = setTimeout(() => {
        evidence.deadlineExceeded = true;
        void bounded(browserServer.kill()).catch((error) => evidence.logs.push(String(error)));
    }, 150_000);
    browser = await chromium.connect(browserServer.wsEndpoint());
    const context = await browser.newContext({ serviceWorkers: 'block' });

    await context.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const allowed = url.origin === origin || (url.origin === 'https://cjrtnc.leaningtech.com' && url.pathname.startsWith('/4.3/'));

        if (!['GET', 'HEAD'].includes(request.method()) || !allowed) {
            evidence.denied.push({ url: request.url(), method: request.method() });
            await route.abort();
        } else {
            await route.continue();
        }
    });
    const page = await context.newPage();

    evidence.browserRows = [];
    evidence.triangulationBrowserRows = [];
    page.on('console', (message) => {
        evidence.logs.push(message.text());

        if (message.text().startsWith('{"name":')) {
            evidence.browserRows.push(JSON.parse(message.text()));
        } else if (message.text().startsWith('{"triangulation":')) {
            evidence.triangulationBrowserRows.push(JSON.parse(message.text()));
        }
    });
    page.on('pageerror', (error) => evidence.logs.push(String(error)));
    await page.goto(origin);
    await page.waitForFunction(() => globalThis.completed, undefined, { timeout: 90_000 });
    evidence.result = await page.evaluate(() => globalThis.result);
    assert.equal(evidence.result.pass, true, evidence.result.error);
    assert.equal(evidence.browserRows.length, 134, 'Missing browser cases');
    assert(evidence.logs.some((line) => line.includes('CLIPPER_ADAPTER_CHECKS_PASS')), 'Browser adapter boundary assertions did not complete');
    assert.deepEqual(canonical(evidence.browserRows), canonical(evidence.nativeRows));
    evidence.triangulationComparison = compareTriangulations(evidence.triangulationNativeRows, evidence.triangulationBrowserRows);
    assert(evidence.logs.some((line) => line.trim() === 'CLIPPER_TRIANGULATION_GUARDS_PASS'), 'Original JNI rejection/finally checks did not complete');
    assert.deepEqual(evidence.result.containers, { allocations: 2, clears: 143 });
    assert.equal(evidence.denied.length, 0, 'Requests escaped the qualification allowlist');
    evidence.pass = true;
} catch (error) {
    evidence.error = String(error.stack || error);
} finally {
    clearTimeout(deadline);

    try {
        await bounded(browser?.close() || Promise.resolve());
    } catch (error) {
        evidence.cleanupError = String(error);
        evidence.pass = false;
    }

    if (browserServer) {
        const process = browserServer.process();

        try {
            if (process.exitCode === null && process.signalCode === null) {
                await bounded(browserServer.kill());
            }

            evidence.browserClosed = process.exitCode !== null || process.signalCode !== null;
            evidence.pass = evidence.pass && evidence.browserClosed;
        } catch (error) {
            evidence.cleanupError = String(error);
            evidence.pass = false;
        }
    }

    try {
        if (server) {
            server.closeAllConnections();
            await new Promise((done, reject) => {
                server.close((error) => {
                    if (error) {
                        reject(error);
                    } else {
                        done();
                    }
                });
            });
        }

        evidence.serverClosed = true;
    } catch (error) {
        evidence.cleanupError = String(error);
        evidence.pass = false;
    }

    try {
        evidence.inputsAfter = await Promise.all((evidence.inputsBefore || []).map(async ({ file }) => ({ file, sha256: hash(await readFile(file)) })));
        assert.deepEqual(evidence.inputsAfter, evidence.inputsBefore);
    } catch (error) {
        evidence.hashError = String(error);
        evidence.pass = false;
    }

    await writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
}

console.info(`Clipper JNI qualification: ${evidence.pass ? 'PASS' : 'FAIL'}; evidence: ${path.join(output, 'result.json')}`);

if (!evidence.pass) {
    process.exitCode = 1;
}
