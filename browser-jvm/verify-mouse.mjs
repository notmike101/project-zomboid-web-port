/* eslint-disable no-await-in-loop -- Input phases and immutable file snapshots are intentionally ordered. */
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
const out = `${root}target/browser-jvm/mouse/`;
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
const preparedInput = await readFile(`${root}target/browser-jvm/play/atomic-view.jar`);

await writeFile(`${out}atomic-view.jar`, preparedInput);
command('javac', ['-d', `${out}tools`, `${root}browser-jvm/PrepareMouse.java`]);
const rejectedOutput = `${out}guard-${randomUUID()}.jar`;
const rejected = command('java', ['-cp', `${out}tools`, 'PrepareMouse', gameJar, rejectedOutput, `${rejectedOutput}.json`], false);

assert.notEqual(rejected.status, 0);
assert.match(rejected.stderr, /Unqualified vendor Mouse source/);
await assert.rejects(readFile(rejectedOutput), { code: 'ENOENT' });
await assert.rejects(readFile(`${rejectedOutput}.json`), { code: 'ENOENT' });
command('java', [
    '-cp',
    `${out}tools`,
    'PrepareMouse',
    `${out}atomic-view.jar`,
    `${out}mouse-view.jar`,
    `${out}adaptation.json`,
]);
command('javac', [
    '--release',
    '17',
    '-cp',
    gameJar,
    '-d',
    `${out}classes`,
    `${root}browser-jvm/host/port/host/BrowserMouse.java`,
    `${root}browser-jvm/MouseQualification.java`,
]);
command('jar', [
    '--create',
    '--file',
    `${out}mouse-entry.jar`,
    '-C',
    `${out}classes`,
    '.',
]);
/**
 * Hashes exact input bytes.
 *
 * @param {Buffer} b - Source bytes.
 * @returns {string} SHA-256 digest.
 */
const sha = (b) => createHash('sha256').update(b).digest('hex');

/**
 * Snapshots an allowlisted source route.
 *
 * @param {string} url - HTTP route.
 * @param {string} p - Input file path.
 */
async function add(url, p) {
    const b = await readFile(p);

    files.set(url, b);

    if (p.startsWith(`${root}browser-jvm/`) && p.endsWith('.js')) {
        await writeFile(out + path.basename(p), b);
    }

    hashes.set(p, sha(b));
}

for (const n of ['mouse-entry.jar', 'mouse-view.jar']) {
    await add(`/${n}`, out + n);
}

for (const n of ['browser-clock.js', 'browser-mouse.js']) {
    await add(`/${n}`, `${root}browser-jvm/${n}`);
}

for (const n of [
    'PrepareMouse.java',
    'MouseQualification.java',
    'host/port/host/BrowserMouse.java',
]) {
    const p = `${root}browser-jvm/${n}`;

    hashes.set(p, sha(await readFile(p)));
}

hashes.set(gameJar, originalGameHash);
const adaptation = JSON.parse(await readFile(`${out}adaptation.json`, 'utf8'));

assert.equal(
    adaptation.inputClassSha256,
    '222c9f1d55624bb6749b1888437ad32f6b7c74b09a812c616b4b4c76a437df24',
);
assert.equal(adaptation.originalBCI, 4);
assert.equal(adaptation.allOtherInstructionsUnchanged, true);

for (const n of [
    'play-entry.jar',
    'animation-entry.jar',
    'animation-view.jar',
    'animation-sdk-view.jar',
    'path-view.jar',
    'float-bridge.jar',
    'memory-bridge.jar',
    'world-entry.jar',
    'atomic-view.jar',
]) {
    const b = await readFile(`${root}target/browser-jvm/play/${n}`);

    if (n === 'atomic-view.jar') {
        assert.equal(sha(b), sha(preparedInput), 'Prepared SDK changed during snapshot');
    }

    await writeFile(out + n, b);
    await add(`/${n}`, out + n);
    hashes.set(`${root}target/browser-jvm/play/${n}`, sha(b));
}

for (const n of ['sprite-webgl.js', 'sprite-attrib.js', 'glsl-compat.js']) {
    await add(`/${n}`, `${root}browser-jvm/${n}`);
}

/**
 * Snapshots installed parser JavaScript dependencies, excluding tests.
 *
 * @param {string} d - Dependency-relative directory.
 */
async function parser(d = 'node_modules/@shaderfrog/glsl-parser') {
    for (const e of await readdir(root + d, { withFileTypes: true })) {
        const n = `${d}/${e.name}`;

        if (e.isDirectory() && !e.name.includes('test')) {
            await parser(n);
        } else if (e.isFile() && e.name.endsWith('.js')) {
            await add(`/${n}`, root + n);
        }
    }
}

await parser();
const cp = [
    'mouse-entry.jar',
    'mouse-view.jar',
    'play-entry.jar',
    'animation-entry.jar',
    'animation-view.jar',
    'animation-sdk-view.jar',
    'path-view.jar',
    'float-bridge.jar',
    'memory-bridge.jar',
    'world-entry.jar',
    'atomic-view.jar',
]
    .map((n) => `/app/${n}`)
    .join(':');

files.set(
    '/',
    Buffer.from(`<meta charset="utf-8"><style>body{margin:0}canvas{width:256px;height:128px}</style><canvas width="512" height="256" tabindex="0"></canvas><button>Other focus</button><script src="https://cjrtnc.leaningtech.com/4.3/loader.js"></script><script type="module">
import{createSpriteNatives}from'/sprite-webgl.js';import{createBrowserClock}from'/browser-clock.js';import{createBrowserMouse}from'/browser-mouse.js';
const canvas=document.querySelector('canvas'),graphics=createSpriteNatives(canvas,()=>{}),clock=createBrowserClock(),mouse=createBrowserMouse(canvas);globalThis.records=[];globalThis.mouseBackend=mouse;
try{await cheerpjInit({version:17,status:'none',natives:{...graphics.natives,...clock.natives,...mouse.natives,Java_MouseQualification_ready(_lib,phase){globalThis.phase=phase;return new Promise(r=>globalThis.resume=r);},Java_MouseQualification_report(_lib,text){const x=JSON.parse(String(text));records.push(x);if('pass'in x)globalThis.result=x;}}});globalThis.exit=await cheerpjRunMain('MouseQualification','${cp}');}catch(e){globalThis.result={pass:false,error:String(e.stack||e)}}finally{mouse.dispose();globalThis.mouse=mouse.snapshot();globalThis.clock=clock.snapshot();canvas.getContext('webgl2').getExtension('WEBGL_lose_context')?.loseContext();globalThis.done=true;}</script>`),
);
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
let evidence = { pass: false };

try {
    browser = await chromium.launch({
        executablePath,
        headless: true,
        args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    const context = await browser.newContext({ serviceWorkers: 'block' });

    await context.route('**/*', async (route) => {
        const req = route.request();
        const u = new URL(req.url());

        if (
            !['GET', 'HEAD'].includes(req.method())
            || (u.origin !== origin
                && !(
                    u.origin === 'https://cjrtnc.leaningtech.com'
                    && u.pathname.startsWith('/4.3/')
                ))
        ) {
            denied.push(req.url());
            await route.abort();
        } else {
            await route.continue();
        }
    });
    const page = await context.newPage();

    page.on('console', (m) => logs.push(m.text()));
    page.on('pageerror', (e) => logs.push(String(e)));
    await page.goto(origin);

    for (let phase = 0; phase < 13; phase++) {
        await page.waitForFunction(
            (p) =>
                globalThis.phase === p
                && typeof globalThis.resume === 'function',
            phase,
            { timeout: 45_000 },
        );

        if (phase === 0) {
            await page.mouse.move(50, 30);
        }

        if (phase === 1) {
            await page.mouse.down({ button: 'left' });
        }

        if (phase === 2) {
            await page.mouse.up({ button: 'left' });
            await page.mouse.down({ button: 'right' });
        }

        if (phase === 3) {
            await page.mouse.up({ button: 'right' });
            await page.mouse.down({ button: 'middle' });
        }

        if (phase === 4) {
            await page.mouse.up({ button: 'middle' });
            await page.mouse.down({ button: 'left' });
            await page.keyboard.press('Tab');
        }

        if (phase === 5) {
            await page.mouse.up({ button: 'left' });
            await page.mouse.move(255, 127);
        }

        if (phase === 6) {
            await page.mouse.click(50, 30);
        }

        if (phase === 7) {
            await page.mouse.down({ button: 'left' });
        }

        if (phase === 8) {
            await page.mouse.down({ button: 'right' });
        }

        if (phase === 9) {
            await page.mouse.up({ button: 'left' });
        }

        if (phase === 10) {
            await page.mouse.up({ button: 'right' });
        }

        if (phase === 11) {
            await page.mouse.move(50, 30);
            await page.mouse.down({ button: 'left' });
            await page.mouse.move(400, 200);
            await page.mouse.up({ button: 'left' });
        }

        if (phase === 12) {
            await page.evaluate(() => globalThis.mouseBackend.dispose());
        }

        await page.evaluate(() => {
            const r = globalThis.resume;

            globalThis.resume = null;
            r();
        });
    }

    await page.waitForFunction(() => globalThis.done, null, { timeout: 30_000 });
    evidence = await page.evaluate(() => ({
        result: globalThis.result,
        records: globalThis.records,
        mouse: globalThis.mouse,
        clock: globalThis.clock,
        exit: globalThis.exit,
    }));
    assert.equal(evidence.result.pass, true);
    assert.equal(evidence.exit, 0);
    assert.equal(evidence.records.length, 14);
    assert.ok(evidence.clock.reads > 0);
    assert.equal(
        logs.filter((line) => /Exception|Error:|SEVERE/.test(line)).length,
        0,
    );
    const r = evidence.records;

    assert.equal(r[0].x, 100);
    assert.equal(r[0].y, 196);
    assert.equal(r[1].left, true);
    assert.equal(r[2].left, false);
    assert.equal(r[2].right, true);
    assert.equal(r[3].middle, true);
    assert.equal(r[4].left, false);
    assert.equal(r[4].ups, 2);
    assert.equal(r[5].x, 510);
    assert.equal(r[5].y, 2);
    assert.equal(r[6].downs, 1);
    assert.equal(r[6].ups, 1);
    assert.equal(r[7].left, true);
    assert.equal(r[8].left, true);
    assert.equal(r[8].right, true);
    assert.equal(r[9].left, false);
    assert.equal(r[9].right, true);
    assert.equal(r[10].left, false);
    assert.equal(r[10].right, false);
    assert.equal(r[11].releaseX, 800);
    assert.equal(r[11].releaseY, -144);
    assert.equal(r[11].x, 511);
    assert.equal(r[11].y, 0);
    assert.equal(r[12].disposedCaught, true);
    assert.equal(r[12].finallyRan, true);
    assert.equal(evidence.mouse.held.length, 0);
    assert.equal(evidence.mouse.pending, 0);
    assert.equal(evidence.mouse.disposed, true);
    assert.equal(denied.length, 0);
    evidence.pass = true;
} catch (e) {
    evidence.pass = false;
    evidence.error = String(e.stack || e);
} finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((r) => {
        server.close(r);
    });
    evidence.hashes = [];

    for (const [p, before] of hashes) {
        const after = sha(await readFile(p));

        evidence.hashes.push({ path: p, before, after });

        if (before !== after) {
            evidence.pass = false;
        }
    }

    Object.assign(evidence, { closed: true, logs, denied, adaptation, sourceGuardRejected: true });
    await writeFile(`${out}result.json`, JSON.stringify(evidence, null, 2));
    console.info(
        JSON.stringify({
            pass: evidence.pass,
            error: evidence.error,
            result: evidence.result,
            records: evidence.records,
            mouse: evidence.mouse,
            closed: true,
            denied: denied.length,
        }),
    );
}

if (!evidence.pass) {
    process.exitCode = 1;
}
