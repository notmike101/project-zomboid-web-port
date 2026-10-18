/* eslint-disable no-await-in-loop -- Compilation, file snapshots and trusted input phases are ordered. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';

const { PZ_JDK: jdk, PZ_BROWSER: executablePath, PZ_GAME_JAR: gameJar, PZ_MENU_SDK: menuSdk } = process.env;

if (!jdk || !executablePath || !gameJar) {
    throw new Error('Set PZ_JDK, PZ_BROWSER and PZ_GAME_JAR; prepare the menu SDK first (exact runtime donor and startup input class pins are required).');
}

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'browser-jvm');
const output = path.join(root, 'target/browser-jvm/display-events');
const menu = path.resolve(menuSdk || path.join(root, 'target/browser-jvm/menu'));
const classes = path.join(output, 'classes');
const tools = path.join(output, 'tools');
const inputs = new Map();
const routes = new Map();
const evidence = { pass: false, denied: [], logs: [], forcedTermination: false, deadlineExceeded: false };
const sdk = ['animation-entry.jar', 'animation-view.jar', 'animation-sdk-view.jar', 'path-view.jar', 'float-bridge.jar', 'memory-bridge.jar', 'world-entry.jar', 'atomic-view.jar'];
let owner;
let timer;
let server;
let control;
let page;
let rejectRuntime;
const runtimeFailure = new Promise((resolve, reject) => {
    rejectRuntime = reject;
});

runtimeFailure.catch(() => {
    // Phase waits still race the rejection; prevent an early unhandled event.
});

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
 * Snapshots a prepared menu SDK and builds only the focused event and clipboard overlays.
 */
async function prepare() {
    await Promise.all([classes, tools].map((directory) => mkdir(directory, { recursive: true })));
    await snapshot(gameJar);
    const runtime = path.join(output, 'runtime-view.jar');
    const startup = path.join(output, 'startup-input-view.jar');
    const atomic = path.join(output, 'atomic-view.jar');

    await writeFile(runtime, await snapshot(path.join(menu, 'runtime-view.jar')));
    await writeFile(startup, await snapshot(path.join(menu, 'menu-input-view.jar')));
    await writeFile(atomic, await snapshot(path.join(menu, 'atomic-view.jar')));
    const hostSources = ['host/port/host/BrowserClipboard.java', 'host/port/host/BrowserMouse.java', 'host/port/host/BrowserKeyboardEvents.java', 'host/port/host/BrowserClock.java', 'host/port/host/BrowserDisplayEvents.java', 'DisplayEventsQualification.java', 'host/port/host/BrowserControllers.java', 'host/port/host/BrowserCustomCursor.java', 'host/org/lwjgl/stb/STBImage.java', 'CustomCursorQualification.java'].map((name) => path.join(source, name));
    const preparers = ['PrepareDisplayEvents.java', 'PrepareClipboard.java', 'PrepareControllers.java', 'PrepareCustomCursor.java'].map((name) => path.join(source, name));

    await Promise.all([...hostSources, ...preparers, import.meta.filename].map(snapshot));
    command('javac', ['--release', '17', '-cp', [gameJar, atomic].join(path.delimiter), '-d', classes, ...hostSources]);
    command('javac', ['-d', tools, ...preparers]);
    command('java', ['-cp', [tools, gameJar].join(path.delimiter), 'PrepareDisplayEvents', runtime, startup, path.join(output, 'display-events-view.jar'), path.join(output, 'display-events-manifest.json')]);
    command('java', ['-cp', tools, 'PrepareClipboard', atomic, path.join(output, 'clipboard-view.jar'), path.join(output, 'clipboard-manifest.json')]);
    command('java', ['-cp', tools, 'PrepareControllers', atomic, path.join(output, 'controller-view.jar'), path.join(output, 'controller-manifest.json'), path.join(output, 'clipboard-view.jar'), startup]);
    command('java', ['-cp', tools, 'PrepareCustomCursor', atomic, path.join(menu, 'menu-mouse-view.jar'), path.join(output, 'cursor-view.jar'), path.join(output, 'cursor-manifest.json')]);
    const aliasOutput = path.join(output, 'cursor-alias.jar');
    const aliasManifest = path.join(output, 'cursor-alias.json');

    await writeFile(aliasOutput, Buffer.from('owned output sentinel'));
    await writeFile(aliasManifest, Buffer.from('owned manifest sentinel'));
    const aliasCases = [
        [atomic, atomic, aliasManifest],
        [path.join(menu, 'menu-mouse-view.jar'), aliasOutput, aliasOutput],
        [path.join(menu, 'menu-mouse-view.jar'), aliasOutput, atomic],
        [path.join(menu, 'menu-mouse-view.jar'), path.join(output, '.', 'atomic-view.jar'), aliasManifest],
    ];
    const hardAlias = path.join(output, `cursor-hardlink-${randomUUID()}.jar`);

    await link(atomic, hardAlias);
    aliasCases.push([path.join(menu, 'menu-mouse-view.jar'), hardAlias, aliasManifest]);
    const protectedFiles = [atomic, path.join(menu, 'menu-mouse-view.jar'), aliasOutput, aliasManifest];
    const protectedHashes = await Promise.all(protectedFiles.map(async (file) => sha(await readFile(file))));

    for (const [mouseInput, destination, manifest] of aliasCases) {
        const rejected = spawnSync(path.join(jdk, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), ['-cp', tools, 'PrepareCustomCursor', atomic, mouseInput, destination, manifest], { encoding: 'utf8', timeout: 10_000, windowsHide: true });

        assert.notEqual(rejected.status, 0);
        assert.match(rejected.stderr, /Aliased cursor paths/u);
        assert.deepEqual(await Promise.all(protectedFiles.map(async (file) => sha(await readFile(file)))), protectedHashes);
    }

    evidence.cursorAliasChecks = aliasCases.length;
    const oracle = spawnSync(path.join(jdk, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), ['-cp', [classes, gameJar].join(path.delimiter), 'CustomCursorQualification'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });

    assert.equal(oracle.status, 0, oracle.stderr || oracle.stdout);
    assert.match(oracle.stdout, /RGBA16bytes fe807fffc3b2a1ffff0201ffffffffff/u);
    evidence.nativeCursorOracle = oracle.stdout.trim();
    evidence.cursorAdaptation = JSON.parse(await readFile(path.join(output, 'cursor-manifest.json'), 'utf8'));
    assert.equal(evidence.cursorAdaptation.cursorUnchanged, 6);
    assert.equal(evidence.cursorAdaptation.mouseUnchanged, 30);
    routes.set('/controller-view.jar', await snapshot(path.join(output, 'controller-view.jar')));
    routes.set('/media/gamecontrollerdb.txt', await snapshot(path.join(path.dirname(gameJar), 'media/gamecontrollerdb.txt')));
    command('jar', ['--create', '--file', path.join(output, 'qualification.jar'), '-C', classes, '.']);
    evidence.adaptation = JSON.parse(await readFile(path.join(output, 'display-events-manifest.json'), 'utf8'));
    assert.equal(evidence.adaptation.unchangedOtherMethods, 50);
    assert.equal(evidence.adaptation.redirects, 5);
    assert.equal(evidence.adaptation.verifiedClassFile, true);
    assert.equal(evidence.adaptation.gameClassesEmitted, 0);

    for (const name of ['media/ui/cursor_blank.png', 'media/ui/cursor_white.png', 'media/fileGuidTable.xml']) {
        routes.set(`/${name}`, await snapshot(path.join(path.dirname(gameJar), name)));
    }

    for (const name of sdk) {
        routes.set(`/${name}`, await snapshot(name === 'atomic-view.jar' ? atomic : path.join(menu, name)));
    }

    routes.set('/menu-mouse-view.jar', await snapshot(path.join(menu, 'menu-mouse-view.jar')));

    for (const name of ['cursor-view.jar', 'startup-input-view.jar', 'qualification.jar', 'display-events-view.jar', 'clipboard-view.jar']) {
        routes.set(`/${name}`, await snapshot(path.join(output, name)));
    }

    for (const name of ['display-events-qualification.html', 'display-events-qualification.js', 'display-events.js', 'custom-cursor.js', 'keyboard.js', 'browser-clock.js', 'browser-mouse.js', 'sprite-webgl.js', 'sprite-attrib.js', 'glsl-compat.js', 'unsafe-short-repair.js', 'controller-natives.js']) {
        routes.set(`/browser-jvm/${name}`, await snapshot(path.join(source, name)));
    }
}

/**
 * Waits for this exact owned browser process to exit.
 *
 * @returns {Promise<void>} Actual process termination.
 */
async function exited() {
    if (owner.exitCode === null && owner.signalCode === null) {
        await new Promise((resolve) => {
            owner.once('exit', resolve);
        });
    }
}

/** Closes the real browser through CDP, then waits for its actual process. */
async function closeOwned() {
    if (owner.exitCode === null && owner.signalCode === null) {
        if (!control) {
            throw new Error('Owned CDP browser connection unavailable');
        }

        await control.send('Browser.close');
        await exited();
    }
}

/** Terminates only the owned process after a failed bounded close. */
async function killOwned() {
    if (owner.exitCode === null && owner.signalCode === null) {
        owner.kill();
    }

    await exited();
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
    await writeFile(path.join(output, 'frozen-inputs.json'), JSON.stringify([...inputs].map(([file, bytes]) => ({ file, sha256: sha(bytes) })), null, 2));
    server = createServer(serve);
    await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;

    const profile = path.join(output, `chrome-profile-${randomUUID()}`);

    await mkdir(profile);
    owner = spawn(executablePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    evidence.owner = { pid: owner.pid, startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 120_000).toISOString(), profile, connection: 'connectOverCDP noDefaults/default context' };
    await writeFile(path.join(output, 'owner.json'), JSON.stringify(evidence.owner, null, 2));
    console.info(JSON.stringify({ output, owner: evidence.owner }));
    timer = setTimeout(() => {
        evidence.deadlineExceeded = true;
        evidence.forcedTermination = true;
        void killOwned().catch((error) => {
            evidence.killFailure = String(error);
        });
    }, 120_000);
    let port;

    for (let attempt = 0; attempt < 100; attempt++) {
        try {
            port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
            break;
        } catch {
            await new Promise((resolve) => {
                setTimeout(resolve, 25);
            });
        }
    }

    assert.ok(port, 'Owned browser CDP endpoint missing');
    /* https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp-option-no-defaults
    This documented option skips synthetic focus/visibility overrides on the owned default context. */
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true, timeout: 5_000 });

    control = await browser.newBrowserCDPSession();
    const context = browser.contexts()[0];

    await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());

        if (url.origin === origin || (url.origin === 'https://cjrtnc.leaningtech.com' && url.pathname.startsWith('/4.3/'))) {
            await route.continue();
        } else {
            evidence.denied.push(url.href);
            await route.abort();
        }
    });
    page = context.pages()[0] || await context.newPage();
    page.on('console', (message) => {
        evidence.logs.push(message.text());

        if (/Exception|Error:|SEVERE/u.test(message.text())) {
            rejectRuntime(new Error(message.text()));
        }
    });
    page.on('pageerror', (error) => {
        evidence.logs.push(String(error));
        rejectRuntime(error);
    });
    await page.goto(`${origin}/browser-jvm/display-events-qualification.html?root=/files/display-events/${randomUUID()}`);
    let background;

    for (let phase = 1; phase <= 7; phase++) {
        await Promise.race([page.waitForFunction((value) => globalThis.done || (globalThis.phase === value && typeof globalThis.resume === 'function'), phase, { timeout: 90_000, polling: 50 }), runtimeFailure]);
        assert.equal(await page.evaluate(() => Boolean(globalThis.done)), false, 'Java completed before input phase');
        background = await drive(page, context, phase, background);
        await page.evaluate(() => {
            const resume = globalThis.resume;

            globalThis.resume = null;
            resume();
        });
    }

    await Promise.race([page.waitForFunction(() => globalThis.done, null, { timeout: 20_000, polling: 50 }), runtimeFailure]);
    evidence.result = await page.evaluate(() => globalThis.result);
    verifyResult(evidence.result);
    assert.equal(evidence.denied.length, 0);
    assert.deepEqual(evidence.logs.filter((line) => /Exception|Error:|SEVERE/u.test(line)), []);
    evidence.pass = true;
} catch (error) {
    evidence.pass = false;
    evidence.error = String(error.stack || error);

    if (page) {
        try {
            evidence.observedBeforeClose = await bounded(page.evaluate(() => ({ result: globalThis.result, phase: globalThis.phase, java: globalThis.java, trace: globalThis.trace })), 2_000);
        } catch (observationError) {
            evidence.observationError = String(observationError);
        }
    }
} finally {
    clearTimeout(timer);

    if (owner) {
        await bounded(closeOwned(), 5_000).catch(async (error) => {
            evidence.closeFailure = String(error);
            evidence.forcedTermination = true;
            await bounded(killOwned(), 5_000).catch((killError) => {
                evidence.killFailure = String(killError);
            });
        });
    }

    evidence.closed = !owner || owner.exitCode !== null || owner.signalCode !== null;
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
 * Requires the original event pipeline result and actual input/context cleanup.
 *
 * @param {object} result - Actual browser result.
 */
function verifyResult(result) {
    assert.equal(result.pass, true, result.error);
    assert.equal(result.exit, 0);
    assert.equal(result.java.checks, 27);
    assert.equal(result.cursorEvidence.java.checks, 28);
    assert.equal(result.cursorEvidence.java.pass, true);
    assert.equal(result.cursorEvidence.observations.length, 11);
    assert.equal(result.cursorEvidence.pixelChecks.length, 3);
    assert.ok(result.cursorEvidence.pixelChecks.every((check) => check.rawMatch && check.decodedMatch));
    assert.equal(result.cursorEvidence.pixelChecks[2].actualSHA, 'd1949d50e95a41b3793225b460e1ea0a76d622b67277d590b12ee7207b39760b');
    assert.equal(result.cursorEvidence.pixelChecks[2].decodedSHA, result.cursorEvidence.pixelChecks[2].actualSHA);
    assert.equal(result.cursors.created, 3);
    assert.equal(result.cursors.revoked, 3);
    assert.equal(result.cursors.owned, 0);
    assert.equal(result.cursors.closed, true);
    assert.equal(result.controllers.before.listeners, 0);
    assert.equal(result.controllers.after.listeners, 0);
    assert.deepEqual(result.controllers.before.queries, Array.from({ length: 16 }, (_, index) => index));
    assert.equal(result.controllers.before.mapping.bytes, 589_746);
    assert.equal(result.controllers.before.mapping.sha256, '5552a9d2d39781903db666baf5c6d074ce0a8659266ce31915735e1df40dcd72');
    assert.equal(result.java.gained, 2);
    assert.equal(result.java.lost, 1);
    assert.equal(result.java.clipboardReads, 3);
    assert.equal(result.contextLost, true);
    assert.equal(result.titleRestored, true);
    assert.equal(result.cursorRestored, true);
    assert.equal(result.systemCalls, 0);

    for (const input of [result.keyboard, result.mouse]) {
        assert.deepEqual(input.held, []);
        assert.equal(input.pending, 0);
        assert.equal(input.disposed, true);
    }

    assert.equal(result.keyboard.sinkValue, '');
    assert.ok(result.keyboard.observed.every((event) => event.trusted));
    assert.ok(result.keyboard.observed.filter((event) => event.type === 'beforeinput').every((event) => event.cancelable));
    assert.equal(result.display.closed, true);
}

/**
 * Performs trusted input and real tab/resize actions on this verifier's owned default context.
 *
 * @param {object} page - Owned qualification page.
 * @param {object} context - Owned default context without Playwright focus overrides.
 * @param {number} phase - Original Java observation boundary.
 * @param {object|undefined} background - Owned second tab.
 * @returns {Promise<object|undefined>} Current owned second tab.
 */
async function drive(page, context, phase, background) {
    switch (phase) {
        case 1:
        case 5: {
            if (background) {
                await background.close();
            }

            await page.bringToFront();
            await page.locator('canvas').click({ position: { x: 30, y: 30 } });

            break;
        }
        case 2: {
            await page.evaluate(() => globalThis.events.focusText());
            await page.keyboard.insertText('Q');

            break;
        }
        case 3: {
            await page.locator('#outside').click();

            break;
        }
        case 4: {
            background = await context.newPage();
            await background.goto('about:blank');
            await background.bringToFront();
            evidence.backgroundObservation = await page.evaluate(() => ({ hidden: document.hidden, focused: document.hasFocus() }));
            assert.equal(evidence.backgroundObservation.hidden, true);

            break;
        }
        case 6: {
            await page.evaluate(() => {
                const canvas = document.querySelector('canvas');

                canvas.width = 96;
                canvas.height = 80;
                canvas.style.width = '192px';
                canvas.style.height = '160px';
            });

            break;
        }
    // No default
    }

    return background;
}
