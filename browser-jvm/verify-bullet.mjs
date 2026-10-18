import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { prepareBulletRuntime } from './prepare-bullet-runtime.mjs';
import { prepareSchedulerRuntime } from './prepare-scheduler-runtime.mjs';

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'target/browser-jvm/bullet-qualification');
const classes = path.join(output, 'classes');
const jdk = process.env.PZ_JDK ?? path.join(root, '.tools/jdk-25.0.1+8');
const game = process.env.PZ_GAME_DIR;
const sdk = process.env.PZ_BULLET_SDK;
const browserExecutable = process.env.PZ_BROWSER;

if (!game || !sdk || !browserExecutable) {
    throw new Error('Set PZ_GAME_DIR, PZ_BULLET_SDK (prepared SDK), and PZ_BROWSER; PZ_JDK must select JDK25.');
}

const gameJar = path.join(game, 'projectzomboid.jar');
const dll = path.join(game, 'PZBullet64.dll');
const jars = ['animation-entry.jar', 'animation-view.jar', 'animation-sdk-view.jar', 'path-view.jar', 'float-bridge.jar', 'memory-bridge.jar', 'world-entry.jar', 'atomic-view.jar'];
const files = new Map();
const inputs = new Map();
const logs = [];
const denied = [];
let owner;
let server;
let deadline;
const evidence = { pass: false, deadlineExceeded: false, forcedTermination: false };

/**
 * Fingerprints exact source, original input, or immutable served bytes.
 *
 * @param {Buffer|string} bytes - Bytes to hash.
 * @returns {string} SHA-256 digest.
 */
function digest(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Captures one source before execution and optionally serves its immutable bytes.
 *
 * @param {string} file - Actual source path.
 * @param {string} [route] - Optional same-origin resource route.
 * @returns {Promise<void>} Completion of capture.
 */
async function capture(file, route) {
    const bytes = await readFile(file);

    inputs.set(file, digest(bytes));

    if (route) {
        files.set(route, bytes);
    }
}

/**
 * Bounds an owner-handle cleanup operation and clears its watchdog.
 *
 * @param {Promise<unknown>} promise - Owned operation.
 * @param {number} milliseconds - Maximum duration.
 * @returns {Promise<unknown>} Completion or deadline rejection.
 */
function bounded(promise, milliseconds) {
    let timer;

    return Promise.race([promise, new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Bullet owned operation deadline')), milliseconds);
    })]).finally(() => clearTimeout(timer));
}

/**
 * Serves captured bytes with original JVM archive range support.
 *
 * @param {object} request - Actual HTTP request.
 * @param {object} response - Actual HTTP response.
 */
function serve(request, response) {
    const name = new URL(request.url, 'http://fixture').pathname;
    const bytes = files.get(name);

    if (!bytes || !['GET', 'HEAD'].includes(request.method)) {
        denied.push(name);
        response.writeHead(404).end();

        return;
    }

    const match = /^bytes=(\d+)-(\d*)$/u.exec(request.headers.range ?? '');
    const start = match ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;

    if (start > end) {
        response.writeHead(416).end();

        return;
    }

    let type = 'text/html';

    if (/\.m?js$/u.test(name)) {
        type = 'text/javascript';
    } else if (name.endsWith('.wasm')) {
        type = 'application/wasm';
    } else if (name.endsWith('.json')) {
        type = 'application/json';
    } else if (name.endsWith('.jar')) {
        type = 'application/java-archive';
    }

    response.writeHead(match ? 206 : 200, {
        'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
        ...(match ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}),
    }).end(request.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1));
}

try {
    await mkdir(classes, { recursive: true });
    await Promise.all([capture(gameJar), capture(dll)]);
    assert.equal(inputs.get(dll), '76141df900f08ef71c0808bcd6248c929c47b8c5900b86af4875131a780897ef', 'Unknown DLL: refusing fixed-address FFM queries');
    assert.equal(inputs.get(gameJar), 'e1a69eb743ede60b213a0fe7f8b83d4fcab773036d256cc4543a336f3b058a33', 'Unqualified original game JAR');

    const java = path.join(jdk, 'bin/java.exe');
    const javac = path.join(jdk, 'bin/javac.exe');
    const jar = path.join(jdk, 'bin/jar.exe');
    const qualification = path.join(import.meta.dirname, 'BulletQualification.java');
    const reference = path.join(import.meta.dirname, 'BulletNativeReference.java');

    await execute(javac, ['--release', '17', '-cp', gameJar, '-d', classes, qualification], { timeout: 30_000 });
    await execute(javac, ['-cp', [gameJar, classes].join(path.delimiter), '-d', classes, reference], { timeout: 30_000 });
    await execute(jar, ['--create', '--file', path.join(output, 'probe.jar'), '-C', classes, 'BulletQualification.class'], { timeout: 30_000 });
    evidence.engine = await prepareBulletRuntime(output);
    evidence.scheduler = await prepareSchedulerRuntime(path.join(output, 'scheduler-runtime'));

    await Promise.all([
        ...['bullet-natives.js', 'PZBullet64.js', 'native-library-loader.js', 'scheduler-runtime.js', 'unsafe-short-repair.js'].map((name) => capture(path.join(import.meta.dirname, name), `/${name}`)),
        ...['bullet-engine.mjs', 'bullet-engine.wasm', 'probe.jar'].map((name) => capture(path.join(output, name), `/${name}`)),
        ...jars.map((name) => capture(path.join(sdk, name), `/${name}`)),
        ...['manifest.json', 'cj3.js', 'load-function.js'].map((name) => capture(path.join(output, 'scheduler-runtime', name), `/scheduler-runtime/${name}`)),
        ...[qualification, reference, import.meta.filename, path.join(import.meta.dirname, 'bullet-engine.cpp'), path.join(import.meta.dirname, 'prepare-bullet-runtime.mjs'), path.join(import.meta.dirname, 'bullet-sources.json')].map((name) => capture(name)),
    ]);

    const className = 'zombie/core/physics/Bullet.class';
    const listingResults = await Promise.all(jars.map((name) => execute(jar, ['tf', path.join(sdk, name)], { timeout: 30_000, maxBuffer: 16_777_216 })));
    const listings = listingResults.map((result) => result.stdout.split(/\r?\n/u));
    const selected = jars[listings.findIndex((listing) => listing.includes(className))];

    evidence.maximumClassListingBytes = Math.max(...listingResults.map((result) => Buffer.byteLength(result.stdout)));

    assert.ok(selected, 'Prepared original Bullet class is required');

    const originalDirectory = path.join(output, 'original-class');
    const preparedDirectory = path.join(output, 'prepared-class');

    await Promise.all([mkdir(originalDirectory, { recursive: true }), mkdir(preparedDirectory, { recursive: true })]);
    await Promise.all([
        execute(jar, ['xf', gameJar, className], { cwd: originalDirectory, timeout: 30_000 }),
        execute(jar, ['xf', path.resolve(sdk, selected), className], { cwd: preparedDirectory, timeout: 30_000 }),
    ]);

    const [originalClass, preparedClass] = await Promise.all([readFile(path.join(originalDirectory, className)), readFile(path.join(preparedDirectory, className))]);

    assert.deepEqual(Buffer.concat([originalClass.subarray(0, 6), originalClass.subarray(8)]), Buffer.concat([preparedClass.subarray(0, 6), preparedClass.subarray(8)]));
    evidence.classAudit = { archive: selected, unchangedExceptMajor: true, originalMajor: originalClass.readUInt16BE(6), preparedMajor: preparedClass.readUInt16BE(6) };

    const owned = path.join(output, `native-${randomUUID()}`);

    await mkdir(owned);
    evidence.native = await execute(java, ['--enable-native-access=ALL-UNNAMED', '-Xmx128m', `-Duser.home=${owned}`, `-Djava.io.tmpdir=${owned}`, `-Djava.library.path=${path.resolve(game)}`,
        '-cp', [classes, path.resolve(gameJar)].join(path.delimiter), 'BulletNativeReference'], { cwd: owned, timeout: 20_000, maxBuffer: 1_048_576 });
    await writeFile(path.join(output, 'native-reference.json'), JSON.stringify(evidence.native, null, 2));

    const referenceRows = evidence.native.stdout.split(/\r?\n/u).filter((line) => line.startsWith('BULLET_REFERENCE ')).map((line) => JSON.parse(line.slice(17)));

    assert.equal(evidence.native.stderr, '');
    assert.ok(evidence.native.stdout.split(/\r?\n/u).includes('BULLET_QUALIFICATION_PASS'));

    const productionModule = files.get('/PZBullet64.js');
    const observedModule = Buffer.concat([productionModule, Buffer.from('\nglobalThis.bulletQualificationBackend = bullet;\n')]);

    files.set('/PZBullet64.js', observedModule);
    evidence.observer = { productionSha: digest(productionModule), servedSha: digest(observedModule), change: 'Verifier-only capture of the existing exported backend; no second engine instance' };

    const classpath = ['probe.jar', ...jars].map((name) => `/app/${name}`).join(':');

    files.set('/', Buffer.from(`<script src="https://cjrtnc.leaningtech.com/4.3/loader.js"></script><script type="module">
import {startSchedulerRuntime} from '/scheduler-runtime.js';
import {installUnsafeShortRepair} from '/unsafe-short-repair.js';
import {installNativeLibraryLoader} from '/native-library-loader.js';
globalThis.samples=[];
try {
 await startSchedulerRuntime({version:17,status:'none',javaProperties:['user.home=/files/bullet-owned/${randomUUID()}','user.dir=/app','java.library.path=/app'],natives:{
  Java_BulletQualification_report(lib,stage){globalThis.samples.push({stage:String(stage),...globalThis.bulletQualificationBackend.snapshot()});}
 }});
 installUnsafeShortRepair(globalThis.cj3Module);installNativeLibraryLoader(globalThis.cj3Module);
 globalThis.exit=await cheerpjRunMain('BulletQualification','${classpath}');
}catch(error){globalThis.failure=String(error.stack||error);}finally{globalThis.done=true;}
</script>`));

    const generation = path.join(output, `generation-${randomUUID()}`);

    await mkdir(generation);
    await Promise.all(Array.from(files, ([name, bytes]) => writeFile(path.join(generation, name.replaceAll('/', '_')), bytes)));
    await writeFile(path.join(generation, 'manifest.json'), JSON.stringify(Array.from(files, ([name, bytes]) => ({ name, sha256: digest(bytes) })), null, 2));
    evidence.generation = generation;
    server = createServer(serve);
    await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });

    const origin = `http://127.0.0.1:${server.address().port}`;

    owner = await chromium.launchServer({ executablePath: browserExecutable, headless: true });
    evidence.browserOwner = { pid: owner.process().pid, startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 110_000).toISOString() };
    deadline = setTimeout(() => {
        evidence.deadlineExceeded = true;
        evidence.forcedTermination = true;
        void owner.kill();
    }, 110_000);

    const browser = await chromium.connect(owner.wsEndpoint());
    const context = await browser.newContext({ serviceWorkers: 'block' });

    await context.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());

        if (['GET', 'HEAD'].includes(request.method()) && (url.origin === origin || (url.origin === 'https://cjrtnc.leaningtech.com' && url.pathname.startsWith('/4.3/')))) {
            await route.continue();
        } else {
            denied.push(url.href);
            await route.abort();
        }
    });

    const page = await context.newPage();

    page.on('console', (message) => logs.push(message.text()));
    page.on('pageerror', (error) => logs.push(`PAGEERROR ${error}`));
    await page.goto(origin);
    await page.waitForFunction(() => globalThis.done, null, { timeout: 100_000 });
    evidence.browser = await page.evaluate(() => ({ samples: globalThis.samples, exit: globalThis.exit, failure: globalThis.failure }));
    assert.equal(evidence.browser.exit, 0);
    assert.equal(evidence.browser.failure, undefined);
    assert.deepEqual(evidence.browser.samples.map((sample) => sample.stage), ['bootstrap', 'single', 'compound', 'rejected', 'cleared', 'finally', 'map0', 'overlap', 'retained1', 'empty', 'reused', 'chunks-finally']);

    for (const referenceRow of referenceRows) {
        const sample = evidence.browser.samples.find((row) => row.stage === referenceRow.stage);

        assert.deepEqual(sample.meshes, referenceRow.meshes);
        assert.deepEqual(sample.dynamics?.slice(0, 4) ?? null, referenceRow.dynamics);
    }

    const chunkRows = evidence.native.stdout.split(/\r?\n/u).filter((line) => line.startsWith('CHUNK_REFERENCE ')).map((line) => JSON.parse(line.slice(16)));

    assert.deepEqual(chunkRows.map((row) => [row.stage, row.distinct, row.shared]), [
        ['map0', 169, 0], ['overlap', 182, 156], ['retained1', 169, 0], ['empty', 0, 0], ['reused', 169, 0],
    ]);

    for (const row of chunkRows) {
        const sample = evidence.browser.samples.find((entry) => entry.stage === row.stage);

        for (const field of ['maps', 'chunks', 'distinct', 'shared']) {
            assert.deepEqual(sample[field], row[field]);
        }

        assert.deepEqual(sample.header, [-250, -250, 250, 250, -64_000, -64_000]);
    }

    assert.equal(evidence.browser.samples.at(-1).distinct, 0);
    const bootstrap = evidence.browser.samples[0].bootstrap;

    assert.equal(bootstrap.callbackStored, true);
    assert.equal(bootstrap.validatedBones.length, 35);
    assert.equal(evidence.browser.samples.at(-1).liveMeshes, 0);
    assert.ok(evidence.browser.samples.every((sample) => sample.scalarBytes === 8));
    evidence.pass = true;
} catch (error) {
    evidence.failure = String(error.stack ?? error);
} finally {
    clearTimeout(deadline);

    if (owner) {
        try {
            await bounded(owner.close(), 5_000);
        } catch (error) {
            evidence.closeFailure = String(error);

            if (owner.process().exitCode === null && owner.process().signalCode === null) {
                evidence.forcedTermination = true;
                await bounded(owner.kill(), 5_000);
            }
        }
    }

    evidence.closed = !owner || owner.process().exitCode !== null || owner.process().signalCode !== null;

    if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => {
            server.close(resolve);
        });
    }

    evidence.inputs = await Promise.all(Array.from(inputs, async ([file, before]) => ({ file, before, after: digest(await readFile(file)) })));
    Object.assign(evidence, { logs, denied });
    evidence.pass &&= evidence.closed && !evidence.closeFailure && !evidence.deadlineExceeded && !evidence.forcedTermination
        && denied.length === 0 && !logs.some((line) => /Exception|PAGEERROR|ERROR:|SEVERE/u.test(line)) && evidence.inputs.every((input) => input.before === input.after);
    await writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ pass: evidence.pass, closed: evidence.closed, forcedTermination: evidence.forcedTermination, failure: evidence.failure, output: path.join(output, 'result.json') }));
}

if (!evidence.pass) {
    process.exitCode = 1;
}
