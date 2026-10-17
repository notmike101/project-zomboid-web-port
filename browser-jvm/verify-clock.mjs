import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';

const { PZ_JDK: jdk, PZ_BROWSER: executablePath, PZ_GAME_JAR: gameJar } = process.env;

if (!jdk || !executablePath || !gameJar) {
    throw new Error('Set PZ_JDK, PZ_BROWSER, PZ_GAME_JAR and prepare the public play SDK first.');
}

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'target/browser-jvm/clock');
const classes = path.join(output, 'classes');
const tools = path.join(output, 'tools');
const files = new Map();
const inputs = new Map();
const evidence = { pass: false, logs: [], denied: [] };
let browser;
let server;

/**
 * Computes an exact source digest.
 *
 * @param {Buffer} bytes - Input bytes.
 * @returns {string} SHA-256.
 */
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Snapshots an unchanged source and optionally serves it.
 *
 * @param {string} file - Source path.
 * @param {string} route - Optional allowlisted local route.
 * @returns {Promise<Buffer>} Snapshot bytes.
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
 * Executes a bounded literal JDK command.
 *
 * @param {string} name - Tool name.
 * @param {string[]} args - Process arguments.
 * @param {boolean} success - Whether success is required.
 * @returns {object} Completed result.
 */
function command(name, args, success = true) {
    const result = spawnSync(path.join(jdk, 'bin', name + (process.platform === 'win32' ? '.exe' : '')), args, { cwd: root, encoding: 'utf8', timeout: 60_000, windowsHide: true });

    if (result.error || (success && result.status !== 0)) {
        throw new Error(`${name}: ${result.error || result.stderr || result.stdout}`);
    }

    return result;
}

await mkdir(classes, { recursive: true });
await mkdir(tools, { recursive: true });

try {
    const preparation = path.join(root, 'browser-jvm/PrepareAtomic.java');
    const fixture = path.join(root, 'browser-jvm/ClockQualification.java');
    const helper = path.join(root, 'browser-jvm/host/port/host/BrowserClock.java');
    const worldView = path.join(root, 'target/browser-jvm/play/world-view.jar');

    await Promise.all([gameJar, preparation, fixture, helper].map((file) => snapshot(file)));
    const copiedWorld = path.join(output, 'world-view.jar');

    await writeFile(copiedWorld, await snapshot(worldView));
    command('javac', ['-d', tools, preparation]);
    command('java', ['-cp', tools, 'PrepareAtomic', copiedWorld, path.join(output, 'atomic-view.jar'), path.join(output, 'atomic-adaptation.json')]);
    command('javac', ['--release', '17', '-cp', gameJar, '-d', classes, helper, fixture]);
    command('jar', ['--create', '--file', path.join(output, 'qualification.jar'), '-C', classes, '.']);
    const badInput = path.join(output, `guard-${randomUUID()}.jar`);
    const badOutput = `${badInput}.rejected`;

    command('java', ['-cp', classes, 'ClockQualification$SourceGuard', copiedWorld, badInput]);
    const failure = command('java', ['-cp', tools, 'PrepareAtomic', badInput, badOutput, `${badOutput}.json`], false);

    assert.notEqual(failure.status, 0);
    assert.match(failure.stderr, /Unqualified vendor Sys clock source/);
    await assert.rejects(readFile(badOutput), { code: 'ENOENT' });
    evidence.sourceGuardRejected = true;
    evidence.adaptation = JSON.parse(await readFile(path.join(output, 'atomic-adaptation.json'), 'utf8'));
    assert.equal(evidence.adaptation.inputViewSha256, '9bb28825fe39df5aef074d6d5fa593d4b9545db151fc5d675a668f620b097290');
    assert.equal(evidence.adaptation.outputViewSha256, 'c08db27800fb3e855741480c6ff7fd42650565bc8215c91f8a4b7c3c6f80a2b6');
    assert.equal(evidence.adaptation.vendorClock.inputClassSha256, '451f856cf21998df2b57862357922ac0801680fc29aa26a7574a55e744fa5d17');
    assert.deepEqual(evidence.adaptation.vendorClock.sites, [{ method: 'getTime()J', originalBCI: 0 }, { method: 'getNanoTime()J', originalBCI: 0 }]);
    const sdk = ['animation-entry.jar', 'animation-view.jar', 'animation-sdk-view.jar', 'path-view.jar', 'float-bridge.jar', 'memory-bridge.jar', 'world-entry.jar'];

    await Promise.all(sdk.map((name) => snapshot(path.join(root, 'target/browser-jvm/play', name), `/${name}`)));
    await snapshot(path.join(output, 'qualification.jar'), '/qualification.jar');
    await snapshot(path.join(output, 'atomic-view.jar'), '/atomic-view.jar');
    await Promise.all(['browser-clock.js', 'sprite-webgl.js', 'glsl-compat.js'].map((name) => snapshot(path.join(root, 'browser-jvm', name), `/${name}`)));
    await Promise.all(['index.js', 'error.js', 'ast/index.js', 'ast/ast.js', 'ast/visit.js', 'ast/ast-types.js', 'parser/index.js', 'parser/parser.js', 'parser/generator.js', 'parser/grammar.js', 'parser/scope.js', 'parser/utils.js', 'preprocessor/index.js', 'preprocessor/preprocessor.js', 'preprocessor/preprocessor-parser.js', 'preprocessor/generator.js'].map((name) => snapshot(path.join(root, 'node_modules/@shaderfrog/glsl-parser', name), `/node_modules/@shaderfrog/glsl-parser/${name}`)));
    const classpath = ['qualification.jar', ...sdk, 'atomic-view.jar'].map((name) => `/app/${name}`).join(':');

    files.set('/', Buffer.from(`<meta charset="utf-8"><canvas width="64" height="64"></canvas><script src="https://cjrtnc.leaningtech.com/4.3/loader.js"></script><script type="module">
        import {createBrowserClock} from '/browser-clock.js';
        import {createSpriteNatives} from '/sprite-webgl.js';
        const clock=createBrowserClock(),graphics=createSpriteNatives(document.querySelector('canvas'));
        try {
            await cheerpjInit({version:17,status:'none',natives:{...clock.natives,...graphics.natives,Java_ClockQualification_report(lib,json){globalThis.result=JSON.parse(String(json));}}});
            globalThis.exit=await cheerpjRunMain('ClockQualification','${classpath}');
        }catch(error){globalThis.result={pass:false,error:String(error.stack||error)};}
        finally{globalThis.clock=clock.snapshot();document.querySelector('canvas').getContext('webgl2').getExtension('WEBGL_lose_context')?.loseContext();globalThis.completed=true;}
    </script>`));
    server = createServer((request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        const bytes = files.get(pathname);

        if (!bytes || !['GET', 'HEAD'].includes(request.method)) {
            evidence.denied.push(pathname);
            response.writeHead(404).end();

            return;
        }

        const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
        let type = 'text/javascript';

        if (pathname === '/') {
            type = 'text/html; charset=utf-8';
        } else if (pathname.endsWith('.jar')) {
            type = 'application/java-archive';
        }

        response.writeHead(range ? 206 : 200, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) }).end(bytes.subarray(start, end + 1));
    });
    await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;

    browser = await chromium.launch({ executablePath, headless: true });
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
    await page.goto(origin);
    await page.waitForFunction(() => globalThis.completed, null, { timeout: 90_000 });
    Object.assign(evidence, await page.evaluate(() => ({ result: globalThis.result, clock: globalThis.clock, exit: globalThis.exit })));
    assert.equal(evidence.result.pass, true, evidence.result.error);
    assert.equal(evidence.exit, 0);
    assert.ok(evidence.clock.reads > 100);
    assert.ok(Number.isFinite(evidence.clock.lastSeconds));
    assert.equal(evidence.denied.length, 0);
    assert.equal(evidence.logs.filter((line) => /Exception|Error:|SEVERE/.test(line)).length, 0);
    evidence.pass = true;
} catch (error) {
    evidence.error = String(error.stack || error);
} finally {
    await browser?.close();
    server?.closeAllConnections();

    if (server) {
        await new Promise((resolve) => {
            server.close(resolve);
        });
    }

    evidence.closed = true;
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
