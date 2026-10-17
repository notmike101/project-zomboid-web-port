import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { deriveSchedulerRuntime, prepareSchedulerRuntime } from './prepare-scheduler-runtime.mjs';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'target/browser-jvm/scheduler');
const classes = path.join(output, 'classes');
const sdk = process.env.PZ_SDK || path.join(root, 'target/browser-jvm/play');
const { PZ_JDK: jdk, PZ_GAME_JAR: gameJar, PZ_BROWSER: executablePath } = process.env;
const inputs = new Map();
const files = new Map();
const evidence = { pass: false, cases: [] };
const jars = ['animation-entry.jar', 'animation-view.jar', 'animation-sdk-view.jar', 'path-view.jar', 'float-bridge.jar', 'memory-bridge.jar', 'world-entry.jar', 'atomic-view.jar'];

if (!jdk || !gameJar || !executablePath) {
    throw new Error('Set PZ_JDK, PZ_GAME_JAR and PZ_BROWSER; optionally PZ_SDK for an immutable prepared SDK.');
}

/**
 * Hashes source bytes.
 *
 * @param {Buffer} bytes - Source bytes.
 * @returns {string} SHA-256 digest.
 */
function hash(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Snapshots an unchanged input and optionally exposes its bytes.
 *
 * @param {string} file - Exact input path.
 * @param {string} route - Optional HTTP route.
 * @returns {Promise<Buffer>} Source bytes.
 */
async function snapshot(file, route) {
    const bytes = await readFile(file);

    inputs.set(file, hash(bytes));

    if (route) {
        files.set(route, bytes);
    }

    return bytes;
}

/**
 * Executes a bounded owned JDK process.
 *
 * @param {string} name - JDK tool.
 * @param {string[]} args - Literal arguments.
 * @returns {void}
 */
function command(name, args) {
    const result = spawnSync(path.join(jdk, 'bin', name + (process.platform === 'win32' ? '.exe' : '')), args, { timeout: 60_000, windowsHide: true, encoding: 'utf8' });

    assert.equal(result.status, 0, String(result.error || result.stderr));
}

/**
 * Enforces a Node-side deadline even when the renderer cannot answer.
 *
 * @param {Promise} operation - Owned operation.
 * @param {number} milliseconds - Absolute bound.
 * @returns {Promise} Operation result.
 */
async function bounded(operation, milliseconds) {
    let timer;

    try {
        return await Promise.race([operation, new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Owned scheduler deadline exceeded')), milliseconds);
        })]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Closes only the owned Playwright server and confirms actual process exit.
 *
 * @param {import('playwright-core').BrowserServer} browserServer - Owned server.
 * @param {object} record - Cleanup evidence.
 * @param {boolean} force - Whether a deadline requires immediate termination.
 * @returns {Promise<void>} Actual process termination.
 */
async function closeOwned(browserServer, record, force = false) {
    if (!browserServer) {
        record.closed = true;

        return;
    }

    try {
        if (force) {
            await bounded(browserServer.kill(), 5_000);
        } else {
            await bounded(browserServer.close(), 5_000);
        }
    } catch (error) {
        record.gracefulCloseError = String(error);
        await bounded(browserServer.kill(), 5_000);
    }

    const child = browserServer.process();

    assert.ok(child.exitCode !== null || child.signalCode !== null, 'Owned browser process has not exited');
    record.closed = true;
}

/**
 * Exercises forced owner-handle cleanup against an actually busy renderer.
 *
 * @returns {Promise<void>} Confirmed owned process exit.
 */
async function qualifyTermination() {
    const record = { entry: 'owned-renderer-termination', pass: false };
    const browserServer = await chromium.launchServer({ executablePath, headless: true, timeout: 30_000 });

    evidence.cases.push(record);

    try {
        const browser = await chromium.connect(browserServer.wsEndpoint());
        const page = await browser.newPage();
        const entered = page.waitForEvent('console', {
            /**
             * Identifies the breadcrumb emitted immediately before the busy loop.
             *
             * @param {import('playwright-core').ConsoleMessage} message - Renderer console message.
             * @returns {boolean} Whether the loop was entered.
             */
            predicate: (message) => message.text() === 'SCHEDULER_BUSY', timeout: 5_000,
        });
        const busy = page.evaluate('console.log("SCHEDULER_BUSY");for(;;){}').catch(() => undefined);

        await bounded(entered, 5_000);
        await closeOwned(browserServer, record, true);
        await bounded(busy, 5_000);
        record.pass = true;
    } finally {
        if (!record.closed) {
            await closeOwned(browserServer, record, true);
        }
    }
}

/**
 * Produces a standard module page using the actual production starter.
 *
 * @param {string} entry - Authored Java entry class.
 * @returns {Buffer} HTML bytes.
 */
function pageBytes(entry) {
    const classpath = ['qualification.jar', ...jars].map((name) => `/app/${name}`).join(':');

    return Buffer.from(`<script src="https://cjrtnc.leaningtech.com/4.3/loader.js"></script><script type="module">
import {startSchedulerRuntime} from '/scheduler-runtime.js';
try {
 const originalGlobalOptions=globalThis.cj3InitOptions;
 const originalGlobalOptionsJson=JSON.stringify(originalGlobalOptions);
 const options={version:17,status:'none',javaProperties:['user.home=/files/scheduler-owned','user.dir=/app'],natives:{
 Java_SchedulerStressQualification_report(lib,text){globalThis.result=JSON.parse(String(text));},
 Java_WorldStreamerStopQualification_report(lib,text){globalThis.result=JSON.parse(String(text));},
 Java_WorldStreamerStopQualification_phase(lib,text){console.log('WORLD_PHASE:'+String(text));}
 }};
 const first=startSchedulerRuntime(options);
 if(startSchedulerRuntime(options)!==first)throw Error('Initialization promise identity changed');
 await first;
 globalThis.optionState={sameGlobalOptions:globalThis.cj3InitOptions===originalGlobalOptions,unchangedGlobalOptions:JSON.stringify(globalThis.cj3InitOptions)===originalGlobalOptionsJson,globalVersion:globalThis.cj3InitOptions.version};
 try{startSchedulerRuntime({...options});throw Error('Conflicting initialization accepted');}catch(error){if(!String(error).includes('different options'))throw error;}
 globalThis.exit=await cheerpjRunMain('${entry}','${classpath}');
}catch(error){globalThis.result={pass:false,error:String(error.stack||error)};}
finally{globalThis.completed=true;}
</script>`);
}

/**
 * Serves only immutable owned snapshots with bounded byte ranges.
 *
 * @param {object} record - Current case evidence.
 * @param {string} mode - Positive or negative delivery case.
 * @param {Buffer} html - Authored page.
 * @param {import('node:http').IncomingMessage} request - HTTP request.
 * @param {import('node:http').ServerResponse} response - HTTP response.
 * @returns {void}
 */
function serve(record, mode, html, request, response) {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    let bytes = pathname === '/' ? html : files.get(pathname);

    if (pathname === '/scheduler-runtime/cj3.js') {
        if (mode === 'missing') {
            response.writeHead(404).end();

            return;
        }

        if (mode === 'mismatch') {
            bytes = Buffer.from(bytes);
            bytes[0] ^= 1;
        }
    }

    if (!bytes || !['GET', 'HEAD'].includes(request.method)) {
        record.denied.push(pathname);
        response.writeHead(404).end();

        return;
    }

    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    let type = 'text/javascript';

    if (pathname === '/') {
        type = 'text/html';
    } else if (pathname.endsWith('.jar')) {
        type = 'application/java-archive';
    } else if (pathname.endsWith('.json')) {
        type = 'application/json';
    }

    if (start > end) {
        response.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` }).end();

        return;
    }

    response.writeHead(range ? 206 : 200, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) }).end(request.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1));
}

/**
 * Qualifies one fresh ordinary-URI browser runtime and closes its owned process.
 *
 * @param {string} entry - Authored Java entry.
 * @param {string} mode - Delivery mode.
 * @returns {Promise<void>} Completed evidence.
 */
async function qualify(entry, mode) {
    const record = { entry, mode, pass: false, logs: [], denied: [], requests: [] };
    const server = createServer(serve.bind(null, record, mode, pageBytes(entry)));
    let browserServer;
    let deadlineKill;
    const deadline = setTimeout(() => {
        record.deadlineExceeded = true;

        if (browserServer) {
            deadlineKill = closeOwned(browserServer, record, true).catch((error) => {
                record.cleanupError = String(error);
            });
        }
    }, 90_000);

    evidence.cases.push(record);
    await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;

    try {
        browserServer = await bounded(chromium.launchServer({ executablePath, headless: true, timeout: 30_000 }), 30_000);
        const browser = await chromium.connect(browserServer.wsEndpoint());
        const context = await browser.newContext({ serviceWorkers: 'block' });

        await context.route('**/*', async (route) => {
            const request = route.request();
            const url = new URL(request.url());

            if (['GET', 'HEAD'].includes(request.method()) && (url.origin === origin || (url.origin === 'https://cjrtnc.leaningtech.com' && url.pathname.startsWith('/4.3/')))) {
                record.requests.push(url.href);
                await route.continue();
            } else {
                record.denied.push(url.href);
                await route.abort();
            }
        });
        const page = await context.newPage();

        page.on('console', (message) => record.logs.push(message.text()));
        page.on('pageerror', (error) => record.logs.push(`PAGEERROR:${error}`));
        await bounded(page.goto(origin), 30_000);
        await bounded(page.waitForFunction(() => globalThis.completed, null, { timeout: 45_000 }), 45_000);
        Object.assign(record, await page.evaluate(() => ({ result: globalThis.result, exit: globalThis.exit, optionState: globalThis.optionState, moduleNull: globalThis.cj3Module === null, loaded: globalThis.cj3Loaded })));
        assert.equal(record.denied.length, 0);

        if (mode === 'valid') {
            assert.equal(record.result.pass, true, record.result.error);
            assert.equal(record.exit, 0);
            assert.deepEqual(record.optionState, { sameGlobalOptions: true, unchangedGlobalOptions: true, globalVersion: 8 });
            assert.equal(record.logs.filter((line) => /PAGEERROR:|Exception|Error:|SEVERE/.test(line)).length, 0);
            assert.ok(record.requests.some((url) => url.endsWith('/4.3/cj3.wasm')));
            assert.ok(record.requests.some((url) => url.includes('/jre/')));
            assert.equal(record.requests.some((url) => url.endsWith('/4.3/cj3.js')), false);

            if (entry === 'SchedulerStressQualification') {
                assert.equal(record.result.bothProgressedBeforeJoin, true);
                assert.ok(record.result.gcRequests > 0);
            } else {
                assert.equal(record.result.actualWorkerTerminated, true);
                assert.ok(record.logs.includes('WORLD_PHASE:java-finally'));
            }
        } else {
            assert.equal(record.result.pass, false);
            assert.match(record.result.error, /before VM startup/);
            assert.equal(record.moduleNull, true);
            assert.equal(record.loaded, 0);
            assert.equal(record.requests.some((url) => url.includes('/jre/') || url.endsWith('.wasm')), false);
        }

        record.pass = true;
    } finally {
        clearTimeout(deadline);

        try {
            await deadlineKill;
            await closeOwned(browserServer, record);
        } catch (error) {
            record.cleanupError = String(error);
            record.pass = false;
        }

        server.closeAllConnections();
        await new Promise((resolve) => {
            server.close(resolve);
        });
    }
}

await mkdir(classes, { recursive: true });

try {
    const fixtures = ['SchedulerStressQualification', 'WorldStreamerStopQualification'].map((name) => path.join(import.meta.dirname, `${name}.java`));

    await Promise.all([gameJar, ...fixtures, path.join(import.meta.dirname, 'verify-scheduler.mjs')].map((file) => snapshot(file)));
    command('javac', ['--release', '17', '-cp', gameJar, '-d', classes, ...fixtures]);
    command('jar', ['--create', '--file', path.join(output, 'qualification.jar'), '-C', classes, '.']);
    evidence.preparation = await prepareSchedulerRuntime(path.join(output, 'runtime'));
    const runtimeResponse = await fetch(`${evidence.preparation.resourceBase}/cj3.js`, { signal: AbortSignal.timeout(30_000) });
    const loaderResponse = await fetch(`${evidence.preparation.resourceBase}/loader.js`, { signal: AbortSignal.timeout(30_000) });
    const runtime = Buffer.from(await runtimeResponse.arrayBuffer());
    const loader = Buffer.from(await loaderResponse.arrayBuffer());
    const changed = Buffer.from(runtime);

    changed[0] ^= 1;
    assert.throws(() => deriveSchedulerRuntime(changed, loader), /Unqualified/);
    assert.throws(() => deriveSchedulerRuntime(Buffer.alloc(0), loader), /Unqualified/);
    assert.deepEqual(deriveSchedulerRuntime(runtime, loader).manifest, evidence.preparation);
    await Promise.all(jars.map((name) => snapshot(path.join(sdk, name), `/${name}`)));
    await snapshot(path.join(output, 'qualification.jar'), '/qualification.jar');
    await snapshot(path.join(import.meta.dirname, 'scheduler-runtime.js'), '/scheduler-runtime.js');
    await snapshot(path.join(import.meta.dirname, 'prepare-scheduler-runtime.mjs'));
    await Promise.all(['cj3.js', 'load-function.js', 'manifest.json'].map((name) => snapshot(path.join(output, 'runtime', name), `/scheduler-runtime/${name}`)));
    await qualifyTermination();
    await qualify('SchedulerStressQualification', 'missing');
    await qualify('SchedulerStressQualification', 'mismatch');
    await qualify('SchedulerStressQualification', 'valid');
    await qualify('WorldStreamerStopQualification', 'valid');
    evidence.pass = evidence.cases.every((record) => record.pass && record.closed && !record.cleanupError && !record.deadlineExceeded);
} catch (error) {
    evidence.error = String(error.stack || error);
} finally {
    evidence.inputs = await Promise.all([...inputs].map(async ([file, before]) => ({ file, before, after: hash(await readFile(file)) })));

    if (evidence.inputs.some((input) => input.before !== input.after)) {
        evidence.pass = false;
    }

    await writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
}

console.info(JSON.stringify(evidence));

if (!evidence.pass) {
    process.exitCode = 1;
}
