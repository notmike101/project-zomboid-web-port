import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';

import { chromium } from 'playwright-core';

const output = process.env.PZ_BULLET_VEHICLE_GENERATION;

if (!output || !path.isAbsolute(output)) {
    throw new Error('PZ_BULLET_VEHICLE_GENERATION must select an absolute prepared qualification directory');
}

const browserExecutable = process.env.PZ_BROWSER;
const jars = ['animation-entry.jar', 'animation-view.jar', 'animation-sdk-view.jar', 'path-view.jar', 'float-bridge.jar', 'memory-bridge.jar', 'world-entry.jar', 'atomic-view.jar'];

if (!browserExecutable) {
    throw new Error('PZ_BROWSER must select the admitted Chromium executable');
}

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
    const staged = JSON.parse(await readFile(path.join(output, 'staged-inputs.json'), 'utf8'));
    const sources = JSON.parse(await readFile(path.join(output, 'source-inputs.json'), 'utf8'));

    await Promise.all(Object.entries(sources).map(async ([file, expected]) => {
        await capture(file);
        assert.equal(inputs.get(file), expected);
    }));

    await Promise.all(Object.entries(staged).map(async ([route, expected]) => {
        const file = path.join(output, route.slice(1));

        await capture(file, route);
        assert.equal(inputs.get(file), expected);
    }));

    const nativeReference = JSON.parse(files.get('/foundation-native.json').toString());
    const vehicleReference = JSON.parse(files.get('/vehicle-native.json').toString());

    assert.equal(vehicleReference.pass, true);
    assert.equal(vehicleReference.exit, 0);
    assert.equal(vehicleReference.closed, true);
    assert.equal(nativeReference.stderr, '');
    assert.ok(nativeReference.stdout.includes('BULLET_QUALIFICATION_PASS'));
    evidence.native = nativeReference;
    const referenceRows = evidence.native.stdout.split(/\r?\n/u).filter((line) => line.startsWith('BULLET_REFERENCE ')).map((line) => JSON.parse(line.slice(17)));
    const contactRows = vehicleReference.stdout.split(/\r?\n/u).filter((line) => line.startsWith('VEHICLE_CONTACT ')).map((line) => JSON.parse(line.slice(line.indexOf('['))).map(Math.fround));

    assert.equal(contactRows.length, 3);
    const classpath = ['probe.jar', ...jars].map((name) => `/app/${name}`).join(':');

    files.set('/', Buffer.from(`<script src="https://cjrtnc.leaningtech.com/4.3/loader.js"></script><script type="module">
import {startSchedulerRuntime} from '/scheduler-runtime.js';
import {installUnsafeShortRepair} from '/unsafe-short-repair.js';
import {installNativeLibraryLoader} from '/native-library-loader.js';
globalThis.samples=[];globalThis.contacts=[];globalThis.unhandled=[];
addEventListener('unhandledrejection',event=>globalThis.unhandled.push(String(event.reason)));
try {
 await startSchedulerRuntime({version:17,status:'none',javaProperties:['user.home=/files/bullet-owned/${randomUUID()}','user.dir=/app','java.library.path=/app'],natives:{
  Java_BulletQualification_report(lib,stage){globalThis.samples.push({stage:String(stage),...globalThis.bulletQualificationBackend.snapshot()});},
  Java_VehicleContactQualification_report(lib,step,packed){
   if(!(packed instanceof Float32Array)||packed.length!==30)throw new Error('Actual JNI Float32Array required');
   globalThis.contacts.push({step,packed:Array.from(packed),state:globalThis.bulletQualificationBackend.snapshot()});
  },
  Java_VehicleContactQualification_finished(lib,workerClosed,exceptions){globalThis.vehicleFinal={workerClosed,exceptions,state:globalThis.bulletQualificationBackend.snapshot()};}
 }});
 installUnsafeShortRepair(globalThis.cj3Module);installNativeLibraryLoader(globalThis.cj3Module);
 globalThis.exit=await cheerpjRunMain('VehicleContactQualification','${classpath}');
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
    evidence.browser = await page.evaluate(() => ({ samples: globalThis.samples, exit: globalThis.exit, failure: globalThis.failure, contacts: globalThis.contacts, vehicleFinal: globalThis.vehicleFinal, unhandled: globalThis.unhandled }));
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
    assert.deepEqual(evidence.browser.contacts.map((row) => row.step), [1, 2, 3]);
    assert.deepEqual(evidence.browser.contacts.map((row) => row.packed), contactRows);
    assert.deepEqual(evidence.browser.unhandled, []);
    assert.equal(evidence.browser.vehicleFinal.workerClosed, true);
    assert.equal(evidence.browser.vehicleFinal.exceptions, 0);
    const finalState = evidence.browser.vehicleFinal.state;

    assert.equal(finalState.world, null);
    assert.equal(finalState.dynamics, null);
    assert.equal(finalState.liveMeshes, 0);
    assert.equal(finalState.definitionCount, 0);
    assert.equal(finalState.vehicleId, null);
    assert.equal(finalState.distinct, 0);
    assert.deepEqual(finalState.maps, []);
    const steps = finalState.calls.filter((row) => row.method === 'stepSimulation');
    const callbacks = finalState.calls.filter((row) => row.method === 'original-level-callback');

    assert.equal(steps.length, 3);
    assert.ok(steps.every((row) => row.geometryBodies === 13 && row.registeredVehicles === 1 && row.dynamics[3] === 14));
    assert.ok(callbacks.length === 27 && callbacks.every((row) => row.uploaded === 0));
    await bounded(page.close(), 5_000);
    evidence.pageClosed = page.isClosed();
    await bounded(context.close(), 5_000);
    evidence.contextClosed = context.pages().length === 0;
    await bounded(browser.close(), 5_000);
    evidence.browserDisconnected = !browser.isConnected();
    assert.equal(evidence.pageClosed, true);
    assert.equal(evidence.contextClosed, true);
    assert.equal(evidence.browserDisconnected, true);
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

    evidence.serverClosed = !server || !server.listening;
    evidence.inputs = await Promise.all(Array.from(inputs, async ([file, before]) => ({ file, before, after: digest(await readFile(file)) })));
    Object.assign(evidence, { logs, denied });
    evidence.pass &&= evidence.closed && evidence.serverClosed && !evidence.closeFailure && !evidence.deadlineExceeded && !evidence.forcedTermination
        && denied.length === 0 && !logs.some((line) => /Exception|PAGEERROR|ERROR:|SEVERE/u.test(line)) && evidence.inputs.every((input) => input.before === input.after);
    await writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ pass: evidence.pass, closed: evidence.closed, forcedTermination: evidence.forcedTermination, failure: evidence.failure, output: path.join(output, 'result.json') }));
}

if (!evidence.pass) {
    process.exitCode = 1;
}
