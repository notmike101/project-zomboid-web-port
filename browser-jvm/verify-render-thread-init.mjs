import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';

const { PZ_JDK: jdk, PZ_BROWSER: executablePath, PZ_GAME_JAR: gameJar } = process.env;

if (!jdk || !executablePath || !gameJar) {
    throw new Error('Set PZ_JDK, PZ_BROWSER and PZ_GAME_JAR; prepare the play and display-init SDKs first.');
}

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'target/browser-jvm/render-thread-init', randomUUID());
const classes = path.join(output, 'classes');
const preparer = path.join(output, 'preparer');
const inputs = new Map();
const evidence = { pass: false, denied: [], logs: [], deadlineExceeded: false, forcedTermination: false };
let owner;
let deadline;
let server;
let page;

/**
 * Bounds an operation on this verifier's owner handle.
 *
 * @param {Promise<unknown>} promise - Owned operation.
 * @param {number} milliseconds - Maximum duration.
 * @returns {Promise<unknown>} Completion or timeout rejection.
 */
function bounded(promise, milliseconds) {
    let timer;

    return Promise.race([promise, new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Render initialization owner deadline')), milliseconds);
    })]).finally(() => clearTimeout(timer));
}

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
    const runtime = path.join(root, 'target/browser-jvm/display-init/graphics/atomic-view.jar');

    await snapshot(gameJar);
    const runtimeCopy = path.join(output, 'atomic-view.jar');

    await writeFile(runtimeCopy, await snapshot(runtime));
    const privateRoot = path.join(root, 'browser-jvm');
    const sources = ['host/port/host/BrowserControllers.java', 'RenderThreadInitQualification.java', 'PrepareControllers.java', 'render-thread-init-qualification.js', 'render-thread-init-qualification.html'].map((name) => path.join(privateRoot, name));

    await Promise.all([...sources, path.join(root, 'browser-jvm/host/port/host/BrowserClipboard.java'), path.join(root, 'browser-jvm/PrepareClipboard.java'), import.meta.filename].map(snapshot));
    const frozenSources = await Promise.all(sources.map(async (file) => {
        const copy = path.join(output, path.basename(file));

        await writeFile(copy, await snapshot(file));

        return copy;
    }));
    const frozenHost = path.join(output, 'BrowserClipboard.java');

    await writeFile(frozenHost, await snapshot(path.join(root, 'browser-jvm/host/port/host/BrowserClipboard.java')));
    const frozenPreparer = path.join(output, 'PrepareClipboard.java');

    await writeFile(frozenPreparer, await snapshot(path.join(root, 'browser-jvm/PrepareClipboard.java')));

    const keyboardHost = path.join(output, 'BrowserKeyboardEvents.java');

    await writeFile(keyboardHost, await snapshot(path.join(root, 'browser-jvm/host/port/host/BrowserKeyboardEvents.java')));
    const displayEventsHost = path.join(output, 'BrowserDisplayEvents.java');

    await writeFile(displayEventsHost, await snapshot(path.join(root, 'browser-jvm/host/port/host/BrowserDisplayEvents.java')));
    command('javac', ['--release', '17', '-cp', runtimeCopy, '-d', classes, frozenHost, keyboardHost, displayEventsHost, frozenSources[0], frozenSources[1]]);
    command('javac', ['-d', preparer, frozenPreparer, frozenSources[2]]);
    command('java', ['-cp', preparer, 'PrepareClipboard', runtimeCopy, path.join(output, 'clipboard-view.jar'), path.join(output, 'clipboard-manifest.json')]);
    const startupCopy = path.join(output, 'startup-input-view.jar');

    await writeFile(startupCopy, await snapshot(path.join(root, 'target/browser-jvm/display-init/startup-input-view.jar')));
    command('java', ['-cp', preparer, 'PrepareControllers', runtimeCopy, path.join(output, 'controller-view.jar'), path.join(output, 'controller-manifest.json'), path.join(output, 'clipboard-view.jar'), startupCopy]);
    const alias = path.join(output, 'input-hardlink.jar');

    await link(runtimeCopy, alias);
    const untouched = path.join(output, 'rejected-output.jar');
    const rejectedManifest = path.join(output, 'rejected-manifest.json');
    const clipboard = path.join(output, 'clipboard-view.jar');
    const cases = [
        [runtimeCopy, runtimeCopy, rejectedManifest, clipboard, startupCopy],
        [runtimeCopy, untouched, untouched, clipboard, startupCopy],
        [runtimeCopy, alias, rejectedManifest, clipboard, startupCopy],
        [runtimeCopy, untouched, rejectedManifest, clipboard, clipboard],
    ];

    for (const args of cases) {
        const rejected = spawnSync(path.join(jdk, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), ['-cp', preparer, 'PrepareControllers', ...args], { cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true });

        assert.equal(rejected.error, undefined);
        assert.notEqual(rejected.status, 0, 'Unsafe preparation must reject before writes');
    }

    assert.equal(await readFile(untouched).then(() => true, () => false), false);
    assert.equal(await readFile(rejectedManifest).then(() => true, () => false), false);
    assert.equal(hash(await readFile(alias)), hash(await snapshot(runtime)));
    evidence.preparationGuards = cases.length;
    command('jar', ['--create', '--file', path.join(output, 'qualification.jar'), '-C', classes, '.']);
    evidence.manifest = JSON.parse(await readFile(path.join(output, 'controller-manifest.json'), 'utf8'));
    const routes = new Map([
        ['/qualification.jar', path.join(output, 'qualification.jar')], ['/controller-view.jar', path.join(output, 'controller-view.jar')], ['/atomic-view.jar', runtimeCopy],
        ['/browser-jvm/render-thread-init-qualification.html', sources[4]], ['/browser-jvm/render-thread-init-qualification.js', sources[3]],
        ['/browser-jvm/unsafe-short-repair.js', path.join(root, 'browser-jvm/unsafe-short-repair.js')],
        ['/media/gamecontrollerdb.txt', path.join(path.dirname(gameJar), 'media/gamecontrollerdb.txt')],
    ]);

    for (const name of ['startup-input-view.jar', 'play-entry.jar', 'animation-entry.jar', 'animation-view.jar', 'animation-sdk-view.jar', 'path-view.jar', 'float-bridge.jar', 'memory-bridge.jar', 'world-entry.jar']) {
        let file = path.join(root, 'target/browser-jvm/play', name);

        if (name === 'startup-input-view.jar') {
            file = startupCopy;
        } else if (['animation-sdk-view.jar', 'path-view.jar'].includes(name)) {
            file = path.join(root, 'target/browser-jvm/display-init/graphics', name);
        }

        routes.set(`/${name}`, file);
    }

    for (const name of ['sprite-webgl.js', 'sprite-attrib.js', 'glsl-compat.js', 'keyboard.js', 'browser-clock.js', 'controller-natives.js']) {
        routes.set(`/browser-jvm/${name}`, path.join(root, 'browser-jvm', name));
    }

    const parser = path.join(root, 'node_modules/@shaderfrog/glsl-parser');

    for (const relative of await readdir(parser, { recursive: true })) {
        if (relative.endsWith('.js')) {
            routes.set(`/node_modules/@shaderfrog/glsl-parser/${relative.replaceAll('\\', '/')}`, path.join(parser, relative));
        }
    }

    await Promise.all([...routes.values()].map(snapshot));
    server = createServer(async (request, response) => {
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        const file = routes.get(pathname);

        try {
            if (!['GET', 'HEAD'].includes(request.method) || !file) {
                throw new Error('Unlisted route');
            }

            const bytes = await snapshot(file);
            const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
            const start = range ? Number(range[1]) : 0;
            const end = range?.[2] ? Number(range[2]) : bytes.length - 1;

            if (request.headers.range !== undefined && (!range || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start < 0 || end >= bytes.length)) {
                response.writeHead(416, { 'Content-Range': `bytes */${bytes.length}`, 'Content-Length': 0 }).end();

                return;
            }

            let type = 'text/javascript';

            if (pathname.endsWith('.html')) {
                type = 'text/html; charset=utf-8';
            } else if (pathname.endsWith('.jar')) {
                type = 'application/java-archive';
            }

            response.writeHead(range ? 206 : 200, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) });
            response.end(request.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1));
        } catch {
            evidence.denied.push(pathname);
            response.writeHead(404).end();
        }
    });
    await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;

    owner = await chromium.launchServer({ executablePath, headless: true });
    evidence.browserOwner = { pid: owner.process().pid, startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 110_000).toISOString() };
    await writeFile(path.join(output, 'owner.json'), JSON.stringify(evidence.browserOwner, null, 2));
    console.info(JSON.stringify({ output, browserOwner: evidence.browserOwner }));
    deadline = setTimeout(() => {
        evidence.deadlineExceeded = true;
        evidence.forcedTermination = true;
        void owner.kill().catch((error) => {
            evidence.killFailure = String(error);
        });
    }, 110_000);
    const browser = await chromium.connect(owner.wsEndpoint());
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
    page = await context.newPage();

    page.on('console', (message) => evidence.logs.push(message.text()));
    page.on('pageerror', (error) => evidence.logs.push(String(error)));
    await page.goto(`${origin}/browser-jvm/render-thread-init-qualification.html?root=/files/render-thread-init/${path.basename(output)}`);
    await page.waitForFunction(() => globalThis.completed, null, { timeout: 100_000 });
    evidence.result = await page.evaluate(() => globalThis.result);
    assert.equal(evidence.result.pass, true, evidence.result.error);
    const raw = await snapshot(path.join(path.dirname(gameJar), 'media/gamecontrollerdb.txt'));
    const normalized = raw.toString('utf8').split(/\r?\n/).filter((line, index, all) => !line.startsWith('#') && (index !== all.length - 1 || line !== '')).map((line) => `${line}\n`).join('');
    const observed = evidence.result.controllers;

    assert.equal(observed.mapping.supported, false);
    assert.equal(observed.mapping.bytes, Buffer.byteLength(`${normalized}\0`));
    assert.equal(observed.mapping.sha256, hash(Buffer.from(`${normalized}\0`)));
    assert.deepEqual(observed.queries, Array.from({ length: 16 }, (_, index) => index));
    assert.equal(observed.guardRejections, 1);
    assert.deepEqual(observed.events, [{ type: 'gamepadconnected', trusted: false }]);
    assert.equal(observed.listeners, 0);
    assert.equal(observed.recentSamples.every((slots) => slots.every((pad) => pad === null)), true);
    assert.equal(evidence.result.java.checks, 66);
    assert.equal(evidence.result.java.originalInputQuit, true);
    assert.equal(evidence.result.java.releasedGamepadValues, 32);
    assert.equal(evidence.result.java.controllerDisposed, true);
    assert.equal(evidence.result.java.displayClosed, true);
    assert.equal(evidence.result.java.fullShutdownQualified, false);
    assert.equal(evidence.result.keyboard.disposed, true);
    assert.equal(evidence.denied.length, 0);
    assert.equal(evidence.logs.filter((line) => /Exception|Error:|SEVERE/.test(line)).length, 0);
    evidence.pass = true;
} catch (error) {
    evidence.error = String(error.stack || error);

    if (page) {
        try {
            evidence.observedBeforeClose = await bounded(page.evaluate(() => globalThis.result), 2_000);
        } catch (observationError) {
            evidence.observationError = String(observationError);
        }
    }
} finally {
    clearTimeout(deadline);

    if (owner) {
        try {
            await bounded(owner.close(), 5_000);
        } catch (error) {
            evidence.closeFailure = String(error);

            if (owner.process().exitCode === null && owner.process().signalCode === null) {
                evidence.forcedTermination = true;

                await bounded(owner.kill(), 5_000).catch((killError) => {
                    evidence.killFailure = String(killError);
                });
            }
        }
    }

    evidence.closed = !owner || owner.process().exitCode !== null || owner.process().signalCode !== null;
    server?.closeAllConnections();

    if (server) {
        await new Promise((resolve) => {
            server.close(resolve);
        });
    }

    evidence.inputs = await Promise.all([...inputs].map(async ([file, bytes]) => ({ file, before: hash(bytes), after: hash(await readFile(file)) })));

    if (evidence.inputs.some((input) => input.before !== input.after)) {
        evidence.pass = false;
    }

    evidence.pass &&= evidence.closed && !evidence.closeFailure && !evidence.deadlineExceeded && !evidence.forcedTermination && !evidence.killFailure;
    await writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
}

console.info(JSON.stringify({ pass: evidence.pass, checks: evidence.result?.java?.checks, closed: evidence.closed, forcedTermination: evidence.forcedTermination, error: evidence.error, output: path.join(output, 'result.json') }));

if (!evidence.pass) {
    process.exitCode = 1;
}
