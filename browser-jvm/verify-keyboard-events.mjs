/* eslint-disable no-await-in-loop -- Input phases and immutable file snapshots are intentionally ordered. */
/* eslint-disable max-depth -- Native results are verified within an owned browser/context lifecycle. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';

const {
    PZ_JDK: jdk,
    PZ_BROWSER: executablePath,
    PZ_GAME_JAR: gameJar,
} = process.env;

if (!jdk || !executablePath || !gameJar) {
    throw new Error(
        'Set PZ_JDK, PZ_BROWSER, PZ_GAME_JAR and prepare the public play SDK first.',
    );
}

const root = `${path.resolve(import.meta.dirname, '..')}/`;
const out = `${root}target/browser-jvm/keyboard-events/`;
const files = new Map();
const hashes = new Map();
const logs = [];
const denied = [];

await mkdir(`${out}classes`, { recursive: true });
await mkdir(`${out}tools`, { recursive: true });

/**
 * Runs a bounded JDK tool with literal arguments.
 *
 * @param {string} name - JDK tool name.
 * @param {string[]} args - Process arguments.
 * @param {boolean} success - Whether a successful exit is required.
 * @returns {object} Completed process result.
 */
function command(name, args, success = true) {
    const r = spawnSync(
        path.join(
            jdk,
            'bin',
            name + (process.platform === 'win32' ? '.exe' : ''),
        ),
        args,
        { cwd: root, encoding: 'utf8', timeout: 60_000, windowsHide: true },
    );

    if (r.error || (success && r.status !== 0)) {
        throw new Error(String(r.error || r.stderr || r.stdout));
    }

    return r;
}

const originalGameHash = createHash('sha256').update(await readFile(gameJar)).digest('hex');
const sdk = ['play-entry.jar', 'animation-entry.jar', 'animation-view.jar', 'animation-sdk-view.jar', 'path-view.jar', 'float-bridge.jar', 'memory-bridge.jar', 'world-entry.jar', 'atomic-view.jar'];
/**
 * Coordinates the bounded original keyboard qualification.
 *
 * @param {Buffer} bytes - Exact input bytes.
 * @returns {string} SHA-256 digest.
 */
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Coordinates the bounded original keyboard qualification.
 *
 * @param {string} url - Allowlisted route.
 * @param {string} input - Source file path.
 * @param {boolean} copy - Whether to save an immutable local copy.
 */
async function add(url, input, copy = false) {
    const bytes = await readFile(input);

    hashes.set(input, sha(bytes));
    files.set(url, bytes);

    if (copy) {
        await writeFile(out + path.basename(url), bytes);
    }
}

for (const name of sdk) {
    await add(`/${name}`, `${root}target/browser-jvm/play/${name}`, true);
}

await add('/font-assets.jar', `${root}target/browser-jvm/play/font-data/font-assets.jar`, true);
await add('/Button_Close.png', path.join(path.dirname(gameJar), 'media/ui/inventoryPanes/Button_Close.png'), true);
const prepared = `${out}atomic-view.jar`;

command('javac', ['-d', `${out}tools`, `${root}browser-jvm/PrepareKeyboardEvents.java`]);
const rejectedOutput = `${out}guard-${randomUUID()}.jar`;

assert.notEqual(command('java', ['-cp', `${out}tools`, 'PrepareKeyboardEvents', gameJar, rejectedOutput, `${rejectedOutput}.json`], false).status, 0);
command('java', ['-cp', `${out}tools`, 'PrepareKeyboardEvents', prepared, `${out}keyboard-events-view.jar`, `${out}adaptation.json`]);
command('javac', ['--release', '17', '-cp', `${gameJar + path.delimiter + out}play-entry.jar`, '-d', `${out}classes`, ...['host/port/host/BrowserKeyboardEvents.java', 'KeyboardEventsQualification.java', 'KeyboardTextEntryQualification.java'].map((n) => `${root}browser-jvm/${n}`)]);
command('jar', ['--create', '--file', `${out}keyboard-events-entry.jar`, '-C', `${out}classes`, '.']);

for (const name of ['keyboard-events-entry.jar', 'keyboard-events-view.jar']) {
    await add(`/${name}`, out + name);
}

for (const name of ['keyboard.js', 'browser-clock.js', 'sprite-webgl.js', 'sprite-attrib.js', 'glsl-compat.js', 'keyboard-events-qualification.js']) {
    await add(`/${name}`, `${root}browser-jvm/${name}`, true);
}

await add('/', `${root}browser-jvm/keyboard-events-qualification.html`);

for (const name of ['PrepareKeyboardEvents.java', 'KeyboardEventsQualification.java', 'KeyboardTextEntryQualification.java', 'host/port/host/BrowserKeyboardEvents.java', 'verify-keyboard-events.mjs']) {
    const file = `${root}browser-jvm/${name}`;

    hashes.set(file, sha(await readFile(file)));
}

hashes.set(gameJar, originalGameHash);
const adaptation = JSON.parse(await readFile(`${out}adaptation.json`, 'utf8'));

assert.equal(adaptation.inputClassSha256, '31cc6df18d521a02a4752eb15169f72b188483cd62c10483a97872d2ddf0b9cd');
assert.equal(adaptation.originalBCI, 288);
assert.equal(adaptation.allOtherInstructionsUnchanged, true);

/**
 * Coordinates the bounded original keyboard qualification.
 *
 * @param {string} dir - Dependency directory.
 */
async function parser(dir = 'node_modules/@shaderfrog/glsl-parser') {
    for (const entry of await readdir(root + dir, { withFileTypes: true })) {
        const file = `${dir}/${entry.name}`;

        if (entry.isDirectory() && !entry.name.includes('test')) {
            await parser(file);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            await add(`/${file}`, root + file);
        }
    }
}

await parser();
const server = createServer((req, res) => {
    const p = new URL(req.url, 'http://localhost').pathname;
    const b = files.get(p);

    if (!b || !['GET', 'HEAD'].includes(req.method)) {
        denied.push(p);
        res.writeHead(404).end();

        return;
    }

    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    const a = m ? Number(m[1]) : 0;
    const z = m && m[2] ? Math.min(Number(m[2]), b.length - 1) : b.length - 1;

    if (a > z) {
        res.writeHead(416, { 'Content-Range': `bytes */${b.length}` }).end();

        return;
    }

    res.writeHead(m ? 206 : 200, {
        'Content-Length': z - a + 1,
        // eslint-disable-next-line no-nested-ternary -- Three fixed response MIME types.
        'Content-Type': p.endsWith('.js')
            ? 'text/javascript'
            : p.endsWith('.jar')
                ? 'application/java-archive'
                : 'text/html',
        'Accept-Ranges': 'bytes',
        ...(m ? { 'Content-Range': `bytes ${a}-${z}/${b.length}` } : {}),
    }).end(req.method === 'HEAD' ? undefined : b.subarray(a, z + 1));
});

await new Promise((r) => {
    server.listen(0, '127.0.0.1', r);
});
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const evidence = { pass: false, phases: [] };

try {
    browser = await chromium.launch({ executablePath, headless: true });

    for (const mode of ['queue', 'ui', 'composition', 'noncancelable', 'inputonly']) {
        const ui = mode === 'ui';
        const negative = mode !== 'queue' && !ui;
        const context = await browser.newContext({ serviceWorkers: 'block' });

        await context.route('**/*', async (route) => {
            const url = new URL(route.request().url());

            if (url.origin === origin || (url.origin === 'https://cjrtnc.leaningtech.com' && url.pathname.startsWith('/4.3/'))) {
                await route.continue();
            } else {
                denied.push(url.href);
                await route.abort();
            }
        });
        const page = await context.newPage();

        page.on('console', (message) => logs.push(message.text()));
        page.on('pageerror', (error) => logs.push(String(error)));
        let route = '/';
        let phaseCount = 11;

        if (ui) {
            route = '/?ui';
            phaseCount = 9;
        }

        if (negative) {
            route = `/?unsupported=${mode}`;
            phaseCount = 1;
        }

        await page.goto(origin + route);

        try {
            for (let phase = 0; phase < phaseCount; phase++) {
                await page.waitForFunction((p) => globalThis.done || (globalThis.phase === p && typeof globalThis.resume === 'function'), phase, { timeout: 90_000 });

                if (await page.evaluate(() => globalThis.done)) {
                    throw new Error('Premature original Java completion');
                }

                if (negative) {
                    await unsupportedInput(page, mode);
                } else if (ui) {
                    await uiInput(page, phase);
                } else {
                    await queueInput(page, phase);
                }

                await page.evaluate(() => {
                    const resume = globalThis.resume;

                    globalThis.resume = null;
                    resume();
                });
            }

            await page.waitForFunction(() => globalThis.done, null, { timeout: 30_000 });
            const result = await page.evaluate(() => ({ result: globalThis.result, records: globalThis.records, snapshot: globalThis.snapshot, disposedSnapshot: globalThis.disposedSnapshot, clock: globalThis.clock, exit: globalThis.exit }));

            evidence.phases.push({ mode, ui, ...result });
            await page.locator('canvas').focus();
            await page.keyboard.press('q');
            assert.deepEqual(await page.evaluate(() => globalThis.backend.snapshot().held), []);
            assert.equal(await page.evaluate(() => globalThis.backend.snapshot().pending), 0);
            assert.equal(await page.locator('textarea').count(), 0);

            assert.equal(result.result.pass, true);
            assert.equal(result.exit, 0);
            assert.deepEqual(result.disposedSnapshot.held, []);
            assert.equal(result.disposedSnapshot.pending, 0);
            assert.equal(result.disposedSnapshot.sinkValue, '');
            assert.equal(result.disposedSnapshot.disposed, true);
            assert.ok(result.snapshot.observed.every((event) => event.trusted === !negative));

            if (!negative) {
                assert.ok(result.snapshot.observed.filter((event) => event.type === 'beforeinput').every((event) => event.cancelable));
            }

            if (!negative) {
                assert.ok(result.clock.reads > 0);
            }

            if (negative) {
                assert.equal(result.result.unsupportedCaught, true);
                assert.equal(result.result.finallyRan, true);
            } else if (ui) {
                assert.deepEqual(result.records.filter((row) => 'phase' in row).map((row) => row.text), ['Ab', 'AbéΩ中', 'Abé中', 'bé中', 'bé中Z', 'bé中Z', 'bé中Z', 'Rename', 'Renam']);
                assert.equal(result.result.assetExecutorShutdown, true);
                assert.equal(result.result.cacheInjected, false);
            } else {
                const expected = [[[30, 0, true], [0, 97, true], [30, 0, false]], [[42, 0, true], [30, 0, true], [0, 65, true], [30, 0, false]], [[42, 0, false], [14, 0, true], [14, 0, false]], [[0, 233, true], [0, 937, true], [0, 20_013, true]], [[45, 0, true], [0, 120, true], [0, 120, true]], [[45, 0, true], [0, 120, true]], [[45, 0, false], [203, 0, true], [203, 0, false]], [[29, 0, true], [30, 0, true], [30, 0, false], [29, 0, false], [48, 0, true], [0, 98, true]], [[15, 0, true], [48, 0, false], [15, 0, false]], [[0, 62_382, true]]];

                assert.deepEqual(result.records.slice(0, 10).map((row) => row.events), expected);
                assert.equal(result.records[1].shiftHeld, true);
                assert.equal(result.records[2].shiftHeld, false);
                assert.equal(result.records[4].xHeld, true);
                assert.equal(result.records[5].xHeld, true);
                assert.equal(result.records[6].xHeld, false);
                assert.equal(result.result.disposedCaught, true);
                assert.equal(result.result.finallyRan, true);
            }
        } catch (error) {
            evidence.failure = await page.evaluate(() => ({ records: globalThis.records, snapshot: globalThis.snapshot || globalThis.backend.snapshot(), result: globalThis.result }));
            throw error;
        } finally {
            await context.close();
        }
    }

    assert.deepEqual(denied, []);
    assert.deepEqual(logs.filter((text) => /Exception|Error:|SEVERE/u.test(text)), []);
    evidence.pass = true;
} catch (error) {
    evidence.error = String(error.stack || error);
} finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => {
        server.close(resolve);
    });
    evidence.hashes = [];

    for (const [file, before] of hashes) {
        const after = sha(await readFile(file));

        evidence.hashes.push({ path: file, before, after });

        if (after !== before) {
            evidence.pass = false;
        }
    }

    Object.assign(evidence, { closed: true, logs, denied, adaptation });
    await writeFile(`${out}result.json`, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ pass: evidence.pass, phases: evidence.phases.map((p) => ({ ui: p.ui, result: p.result })), error: evidence.error, closed: true }));
}

if (!evidence.pass) {
    process.exitCode = 1;
}

/**
 * Coordinates the bounded original keyboard qualification.
 *
 * @param {object} page - Owned browser page.
 * @param {number} phase - Ordered input phase.
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
        await page.keyboard.insertText('éΩ中');
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
        await page.keyboard.insertText('🎮');
    }

    if (phase === 10) {
        await page.evaluate(() => globalThis.backend.dispose());
    }
}

/**
 * Coordinates the bounded original keyboard qualification.
 *
 * @param {object} page - Owned browser page.
 * @param {number} phase - Ordered input phase.
 */
async function uiInput(page, phase) {
    if (phase === 0) {
        await page.keyboard.type('Ab');
    }

    if (phase === 1) {
        await page.keyboard.insertText('éΩ中');
    }

    if (phase === 2) {
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('Backspace');
    }

    if (phase === 3) {
        await page.keyboard.press('Home');
        await page.keyboard.press('Delete');
    }

    if (phase === 4) {
        await page.keyboard.press('End');
        await page.keyboard.down('Shift');
        await page.keyboard.press('Z');
        await page.keyboard.up('Shift');
    }

    if (phase === 5) {
        await page.keyboard.down('Control');
    }

    if (phase === 6) {
        await page.keyboard.press('a');
        await page.keyboard.up('Control');
    }

    if (phase === 7) {
        await page.keyboard.type('Rename');
    }

    if (phase === 8) {
        await page.keyboard.press('Backspace');
    }
}

/**
 * Injects an authored unsupported-input notification to verify Java failure cleanup.
 * This is not a trusted browser IME/paste qualification.
 *
 * @param {object} page - Owned browser page.
 * @param {string} mode - Explicit rejected input family.
 */
async function unsupportedInput(page, mode) {
    await page.evaluate((kind) => {
        const sink = document.querySelector('textarea');

        sink.dispatchEvent(new InputEvent(kind === 'inputonly' ? 'input' : 'beforeinput', {
            bubbles: true,
            cancelable: kind !== 'noncancelable',
            inputType: kind === 'composition' ? 'insertCompositionText' : 'insertText',
            isComposing: kind === 'composition',
            data: 'x',
        }));
    }, mode);
}
