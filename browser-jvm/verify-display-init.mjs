/* eslint-disable no-await-in-loop -- Compilation, file snapshots and trusted input phases are ordered. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';

const { PZ_JDK: jdk, PZ_BROWSER: executablePath, PZ_GAME_JAR: gameJar } = process.env;

if (!jdk || !executablePath || !gameJar) {
    throw new Error('Set PZ_JDK, PZ_BROWSER and PZ_GAME_JAR; prepare a fresh play SDK from current sources first (the startup overlay pins its graphics-adapted Display).');
}

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'browser-jvm');
const output = path.join(root, 'target/browser-jvm/display-init');
const graphics = path.join(output, 'graphics');
const classes = path.join(output, 'classes');
const tools = path.join(output, 'tools');
const inputs = new Map();
const routes = new Map();
const evidence = { pass: false, denied: [], logs: [], forcedTermination: false, deadlineExceeded: false };
const sdk = ['play-entry.jar', 'animation-entry.jar', 'animation-view.jar', 'animation-sdk-view.jar', 'path-view.jar', 'float-bridge.jar', 'memory-bridge.jar', 'world-entry.jar', 'atomic-view.jar'];
let owner;
let timer;
let server;

/**
 * Hashes one exact input.
 *
 * @param {Buffer} bytes - Original bytes.
 * @returns {string} SHA-256 digest.
 */
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Keeps an immutable snapshot and before/after hash for a source or runtime input.
 *
 * @param {string} file - Input file.
 * @returns {Promise<Buffer>} Snapshot bytes.
 */
async function snapshot(file) {
    if (!inputs.has(file)) {
        inputs.set(file, await readFile(file));
    }

    return inputs.get(file);
}

/**
 * Runs one bounded literal JDK command without launching original game code.
 *
 * @param {string} name - JDK tool name.
 * @param {string[]} args - Literal arguments.
 */
function command(name, args) {
    const result = spawnSync(path.join(jdk, 'bin', name + (process.platform === 'win32' ? '.exe' : '')), args, { cwd: root, encoding: 'utf8', timeout: 60_000, windowsHide: true });

    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
}

/**
 * Bounds an operation owned by this verifier.
 *
 * @param {Promise<unknown>} promise - Owner operation.
 * @param {number} milliseconds - Maximum wait.
 * @returns {Promise<unknown>} Completion or deadline failure.
 */
function bounded(promise, milliseconds) {
    let deadline;

    return Promise.race([promise, new Promise((resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('Display startup owner deadline')), milliseconds);
    })]).finally(() => clearTimeout(deadline));
}

/**
 * Prepares the existing graphics-to-animation overlays without importing models or mutating play output.
 */
async function prepare() {
    await Promise.all([classes, tools, graphics].map((directory) => mkdir(directory, { recursive: true })));
    await snapshot(gameJar);
    const runtime = path.join(graphics, 'runtime-view.jar');

    await writeFile(runtime, await snapshot(path.join(root, 'target/browser-jvm/play/runtime-view.jar')));
    const hostSources = ['host/port/host/SpriteGraphics.java', 'host/port/host/SpriteBuffers.java', 'host/port/host/BrowserKeyboardEvents.java', 'KeyboardEventsQualification.java', 'DisplayInitQualification.java'].map((name) => path.join(source, name));
    const preparers = ['PrepareSpriteGraphics.java', 'PrepareInput.java', 'PrepareWorld.java', 'PrepareAtomic.java', 'animation/PreparePath.java', 'animation/PrepareAnimationSdk.java', 'PrepareKeyboardEvents.java'].map((name) => path.join(source, name));

    await Promise.all([...hostSources, ...preparers, import.meta.filename].map(snapshot));
    command('javac', ['--release', '17', '-cp', gameJar, '-d', classes, ...hostSources]);
    command('javac', ['-d', tools, ...preparers]);
    command('java', ['-cp', tools, 'PrepareSpriteGraphics', runtime, graphics, classes]);
    command('java', ['-cp', tools, 'PrepareInput', path.join(graphics, 'sprite-view.jar'), path.join(graphics, 'input-view.jar')]);
    command('java', ['-cp', tools, 'PrepareWorld', path.join(graphics, 'input-view.jar'), path.join(graphics, 'world-view.jar'), path.join(graphics, 'world-sdk-manifest.json')]);
    command('java', ['-cp', tools, 'PrepareAtomic', path.join(graphics, 'world-view.jar'), path.join(graphics, 'atomic-view.jar'), path.join(graphics, 'atomic-manifest.json')]);
    command('java', ['-cp', tools, 'PreparePath', path.join(graphics, 'atomic-view.jar'), path.join(graphics, 'path-view.jar'), path.join(graphics, 'path-manifest.json')]);
    command('java', ['-cp', tools, 'PrepareAnimationSdk', path.join(graphics, 'atomic-view.jar'), path.join(graphics, 'animation-sdk-view.jar'), path.join(graphics, 'animation-sdk-manifest.json')]);
    command('java', ['-cp', tools, 'PrepareKeyboardEvents', path.join(graphics, 'atomic-view.jar'), path.join(output, 'startup-input-view.jar'), path.join(output, 'startup-adaptation.json')]);
    command('jar', ['--create', '--file', path.join(output, 'qualification.jar'), '-C', classes, 'DisplayInitQualification.class', '-C', classes, 'KeyboardEventsQualification.class', '-C', classes, 'port/host/BrowserKeyboardEvents.class']);
    evidence.graphics = JSON.parse(await readFile(path.join(graphics, 'sprite-graphics-manifest.json'), 'utf8'));
    evidence.adaptation = JSON.parse(await readFile(path.join(output, 'startup-adaptation.json'), 'utf8'));
    assert.equal(evidence.graphics.gameMethodBodiesUnchanged, true);
    assert.equal(evidence.adaptation.allOtherInstructionsUnchanged, true);
    assert.equal(evidence.adaptation.display.unchangedOtherMethods, 60);
    assert.equal(evidence.adaptation.display.keyboardCreateOriginal, true);
    const regenerated = new Set(['animation-sdk-view.jar', 'path-view.jar', 'atomic-view.jar']);

    for (const name of sdk) {
        const file = regenerated.has(name) ? path.join(graphics, name) : path.join(root, 'target/browser-jvm/play', name);

        routes.set(`/${name}`, await snapshot(file));
    }

    for (const name of ['startup-input-view.jar', 'qualification.jar']) {
        routes.set(`/${name}`, await snapshot(path.join(output, name)));
    }

    for (const name of ['display-init-qualification.html', 'display-init-qualification.js', 'keyboard.js', 'browser-clock.js', 'sprite-webgl.js', 'sprite-attrib.js', 'glsl-compat.js', 'unsafe-short-repair.js']) {
        routes.set(`/browser-jvm/${name}`, await snapshot(path.join(source, name)));
    }
}

/**
 * Snapshots only JavaScript from the existing GLSL parser dependency.
 *
 * @param {string} relative - Dependency directory.
 */
async function parser(relative = 'node_modules/@shaderfrog/glsl-parser') {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
        const name = `${relative}/${entry.name}`;

        if (entry.isDirectory() && !entry.name.includes('test')) {
            await parser(name);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            routes.set(`/${name}`, await snapshot(path.join(root, name)));
        }
    }
}

/**
 * Serves immutable allowlisted qualification inputs.
 *
 * @param {object} request - Owned HTTP request.
 * @param {object} response - Owned HTTP response.
 */
function serve(request, response) {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const bytes = routes.get(pathname);

    if (!bytes || !['GET', 'HEAD'].includes(request.method)) {
        evidence.denied.push(pathname);
        response.writeHead(404).end();

        return;
    }

    const header = request.headers.range;
    const range = typeof header === 'string' ? header.match(/^bytes=(\d+)-(\d*)$/u) : null;
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Number(range[2]) : bytes.length - 1;

    if (header !== undefined && (!range || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 0 || start > end || end >= bytes.length)) {
        response.writeHead(416, { 'Content-Range': `bytes */${bytes.length}`, 'Content-Length': 0 }).end();

        return;
    }

    let type = 'text/javascript; charset=utf-8';

    if (pathname.endsWith('.jar')) {
        type = 'application/java-archive';
    } else if (pathname.endsWith('.html')) {
        type = 'text/html; charset=utf-8';
    }

    response.writeHead(range ? 206 : 200, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) });

    if (request.method === 'HEAD') {
        response.end();
    } else {
        response.end(bytes.subarray(start, end + 1));
    }
}

try {
    await prepare();
    await parser();
    server = createServer(serve);
    await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;

    owner = await chromium.launchServer({ executablePath, headless: true });
    evidence.owner = { pid: owner.process().pid, startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 120_000).toISOString() };
    await writeFile(path.join(output, 'owner.json'), JSON.stringify(evidence.owner, null, 2));
    console.info(JSON.stringify({ output, owner: evidence.owner }));
    timer = setTimeout(() => {
        evidence.deadlineExceeded = true;
        evidence.forcedTermination = true;
        void owner.kill().catch((error) => {
            evidence.killFailure = String(error);
        });
    }, 120_000);
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
    const page = await context.newPage();

    page.on('console', (message) => evidence.logs.push(message.text()));
    page.on('pageerror', (error) => evidence.logs.push(String(error)));
    await page.goto(`${origin}/browser-jvm/display-init-qualification.html?root=/files/display-init/${randomUUID()}`);

    for (let phase = 0; phase < 11; phase++) {
        await page.waitForFunction((value) => globalThis.completed || (globalThis.phase === value && typeof globalThis.resume === 'function'), phase, { timeout: 90_000 });
        assert.equal(await page.evaluate(() => Boolean(globalThis.completed)), false, 'Original Java completed before an input phase');
        await queueInput(page, phase);
        await page.evaluate(() => {
            const resume = globalThis.resume;

            globalThis.resume = null;
            resume();
        });
    }

    await page.waitForFunction(() => globalThis.completed, null, { timeout: 20_000 });
    evidence.result = await page.evaluate(() => globalThis.result);
    verifyResult(evidence.result);
    assert.equal(evidence.denied.length, 0);
    assert.deepEqual(evidence.logs.filter((line) => /Exception|Error:|SEVERE/u.test(line)), []);
    evidence.pass = true;
} catch (error) {
    evidence.pass = false;
    evidence.error = String(error.stack || error);
} finally {
    clearTimeout(timer);

    if (owner) {
        await bounded(owner.close(), 5_000).catch(async (error) => {
            evidence.closeFailure = String(error);
            evidence.forcedTermination = true;
            await bounded(owner.kill(), 5_000).catch((killError) => {
                evidence.killFailure = String(killError);
            });
        });
    }

    evidence.closed = !owner || owner.process().exitCode !== null || owner.process().signalCode !== null;
    server?.closeAllConnections();

    if (server) {
        await new Promise((resolve) => {
            server.close(resolve);
        });
    }

    evidence.inputs = await Promise.all([...inputs].map(async ([file, bytes]) => ({ file, before: sha(bytes), after: sha(await readFile(file)) })));
    evidence.pass &&= !evidence.error && evidence.closed && !evidence.closeFailure && !evidence.killFailure && !evidence.deadlineExceeded && !evidence.forcedTermination && evidence.inputs.every((input) => input.before === input.after);
    await writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
}

console.info(JSON.stringify({ pass: evidence.pass, checks: evidence.result?.java?.checks, closed: evidence.closed, forced: evidence.forcedTermination, error: evidence.error, result: path.join(output, 'result.json') }));

if (!evidence.pass) {
    process.exitCode = 1;
}

/**
 * Requires exact original startup and queue results, including real cleanup.
 *
 * @param {object} result - Actual browser result.
 */
function verifyResult(result) {
    assert.equal(result.pass, true, result.error);
    assert.equal(result.exit, 0);
    assert.equal(result.java.checks, 33);
    assert.equal(result.java.actualGameWindowInitDisplay, true);
    assert.equal(result.contextLost, true);
    assert.equal(result.titleRestored, true);
    assert.equal(result.queue.disposedCaught, true);
    assert.equal(result.queue.finallyRan, true);
    assert.ok(result.queue.scancodeQueries >= 100);
    assert.ok(result.clock.reads > 0);
    assert.deepEqual(result.inputDisposed.held, []);
    assert.equal(result.inputDisposed.pending, 0);
    assert.equal(result.inputDisposed.sinkValue, '');
    assert.equal(result.inputDisposed.disposed, true);
    assert.ok(result.inputDisposed.observed.every((event) => event.trusted));
    assert.ok(result.inputDisposed.observed.filter((event) => event.type === 'beforeinput').every((event) => event.cancelable));
    const expected = [[[30, 0, true], [0, 97, true], [30, 0, false]], [[42, 0, true], [30, 0, true], [0, 65, true], [30, 0, false]], [[42, 0, false], [14, 0, true], [14, 0, false]], [[0, 233, true], [0, 937, true], [0, 20_013, true]], [[45, 0, true], [0, 120, true], [0, 120, true]], [[45, 0, true], [0, 120, true]], [[45, 0, false], [203, 0, true], [203, 0, false]], [[29, 0, true], [30, 0, true], [30, 0, false], [29, 0, false], [48, 0, true], [0, 98, true]], [[15, 0, true], [48, 0, false], [15, 0, false]], [[0, 62_382, true]]];

    assert.deepEqual(result.records.slice(0, 10).map((row) => row.events), expected);
}

/**
 * Drives the existing qualified queue phases with trusted browser input.
 *
 * @param {object} page - Owned page.
 * @param {number} phase - Ordered phase.
 */
async function queueInput(page, phase) {
    if (phase === 0) {
        await page.keyboard.type('a');
    }

    if (phase === 1) {
        await page.keyboard.down('Shift');
        await page.keyboard.press('A');
    }

    if (phase === 2) {
        await page.keyboard.up('Shift');
        await page.keyboard.press('Backspace');
    }

    if (phase === 3) {
        await page.keyboard.insertText('\u00E9\u03A9\u4E2D');
    }

    if (phase === 4) {
        await page.keyboard.down('x');
        await page.keyboard.down('x');
    }

    if (phase === 5) {
        await page.keyboard.down('x');
    }

    if (phase === 6) {
        await page.keyboard.up('x');
        await page.keyboard.press('ArrowLeft');
    }

    if (phase === 7) {
        await page.keyboard.down('Control');
        await page.keyboard.press('a');
        await page.keyboard.up('Control');
        await page.keyboard.down('b');
    }

    if (phase === 8) {
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement.tagName), 'BODY');
        assert.equal(await page.evaluate(() => globalThis.backend.snapshot().focused), false);
        assert.deepEqual(await page.evaluate(() => globalThis.backend.snapshot().held), []);
        await page.keyboard.up('b');
    }

    if (phase === 9) {
        await page.evaluate(() => globalThis.backend.focusText());
        await page.keyboard.insertText('\u{1F3AE}');
    }

    if (phase === 10) {
        await page.evaluate(() => globalThis.backend.dispose());
    }
}
