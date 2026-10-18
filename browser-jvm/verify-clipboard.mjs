import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';

const { PZ_JDK: jdk, PZ_BROWSER: executablePath, PZ_GAME_JAR: gameJar } = process.env;

if (!jdk || !executablePath || !gameJar) {
    throw new Error('Set PZ_JDK, PZ_BROWSER and PZ_GAME_JAR; prepare the play atomic-view.jar first.');
}

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'target/browser-jvm/clipboard');
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
        timer = setTimeout(() => reject(new Error('Clipboard owner operation deadline')), milliseconds);
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
    const runtime = path.join(root, 'target/browser-jvm/play/atomic-view.jar');

    await snapshot(gameJar);
    const runtimeCopy = path.join(output, 'atomic-view.jar');

    await writeFile(runtimeCopy, await snapshot(runtime));
    const host = path.join(root, 'browser-jvm/host/port/host/BrowserClipboard.java');
    const fixture = path.join(root, 'browser-jvm/ClipboardQualification.java');
    const preparation = path.join(root, 'browser-jvm/PrepareClipboard.java');

    await Promise.all([host, fixture, preparation, import.meta.filename].map(snapshot));
    command('javac', ['--release', '17', '-cp', gameJar, '-d', classes, host, fixture]);
    command('javac', ['-d', preparer, preparation]);
    command('java', ['-cp', preparer, 'PrepareClipboard', runtimeCopy, path.join(output, 'clipboard-view.jar'), path.join(output, 'clipboard-manifest.json')]);
    command('jar', ['--create', '--file', path.join(output, 'qualification.jar'), '-C', classes, '.']);
    evidence.manifest = JSON.parse(await readFile(path.join(output, 'clipboard-manifest.json'), 'utf8'));
    assert.equal(evidence.manifest.gameClassesEmitted, 0);
    assert.equal(evidence.manifest.selected.length, 4);
    assert.equal(evidence.manifest.unchangedOtherMethods, 207);
    const routes = new Map([
        ['/qualification.jar', path.join(output, 'qualification.jar')],
        ['/clipboard-view.jar', path.join(output, 'clipboard-view.jar')],
        ['/atomic-view.jar', runtimeCopy],
        ...['clipboard-qualification.html', 'clipboard-qualification.js', 'unsafe-short-repair.js'].map((name) => [`/browser-jvm/${name}`, path.join(root, 'browser-jvm', name)]),
    ]);

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
    await page.goto(`${origin}/browser-jvm/clipboard-qualification.html`);
    await page.waitForFunction(() => globalThis.completed, null, { timeout: 100_000 });
    evidence.result = await page.evaluate(() => globalThis.result);
    assert.equal(evidence.result.pass, true, evidence.result.error);
    assert.equal(evidence.result.java.checks, 26);
    assert.equal(evidence.result.java.workerStopped, true);
    assert.equal(evidence.result.exit, 0);
    assert.equal(evidence.result.systemCalls, 0);
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
