import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';

const { PZ_JDK: jdk, PZ_BROWSER: executablePath, PZ_GAME_JAR: gameJar } = process.env;

if (!jdk || !executablePath || !gameJar) {
    throw new Error('Set PZ_JDK to the JDK directory and PZ_BROWSER to a Chromium executable. Set PZ_GAME_JAR to the original game JAR. Prepare the play profile first.');
}

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'target/browser-jvm/unsafe-short');
const prepared = path.join(root, 'target/browser-jvm/play/sprite-view.jar');
const classes = path.join(output, 'classes');
const archive = path.join(output, 'qualification.jar');
const sources = ['BufferPrimitiveQualification', 'BufferCodecQualification'];
const sdkNames = ['play-entry.jar', 'animation-entry.jar', 'animation-view.jar', 'animation-sdk-view.jar', 'path-view.jar', 'float-bridge.jar', 'memory-bridge.jar', 'world-entry.jar', 'atomic-view.jar'];
const protectedInputs = new Map();
const evidence = { pass: false, denied: [], logs: [] };
let browser;
let server;

/**
 * Hashes a snapshot without changing the prepared archive.
 *
 * @param {Buffer} bytes - Archive bytes.
 * @returns {string} SHA-256 digest.
 */
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Runs one bounded JDK build operation.
 *
 * @param {string} name - JDK executable name.
 * @param {string[]} args - Literal process arguments.
 */
function command(name, args) {
    const binary = path.join(jdk, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
    const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 60_000, windowsHide: true });

    if (result.error || result.status !== 0) {
        throw new Error(`${name} failed: ${result.error || result.stderr || result.stdout}`);
    }
}

await mkdir(classes, { recursive: true });

try {
    const preparedBytes = await readFile(prepared);

    evidence.preparedArchive = prepared;
    evidence.sha256Before = hash(preparedBytes);
    protectedInputs.set(gameJar, hash(await readFile(gameJar)));
    const sdk = await Promise.all(sdkNames.map(async (name) => {
        const file = path.join(root, 'target/browser-jvm/play', name);
        const bytes = await readFile(file);

        protectedInputs.set(file, hash(bytes));

        return [`/${name}`, bytes];
    }));

    for (const name of sources) {
        command('javac', ['--release', '17', '-cp', gameJar, '-d', classes, path.join(root, 'browser-jvm', `${name}.java`)]);
    }

    evidence.jvm = [];

    for (const name of sources) {
        const result = spawnSync(path.join(jdk, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), ['-Dstdout.encoding=UTF-8', '-cp', classes + path.delimiter + gameJar, name, 'jvm'], { encoding: 'utf8', timeout: 60_000, windowsHide: true });

        assert.equal(result.status, 0, result.stderr);
        const rows = result.stdout.trim().split(/\r?\n/).filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));

        assert.equal(rows.at(-1).pass, true);
        evidence.jvm.push(rows.filter((row) => row.progress));
    }

    command('jar', ['--create', '--file', archive, '-C', classes, '.']);
    const classpath = ['/app/qualification.jar', ...sdkNames.map((name) => `/app/${name}`)].join(':');
    const html = `<script src="https://cjrtnc.leaningtech.com/4.3/loader.js"></script><script type="module">
        import {installUnsafeShortRepair} from '/unsafe-short-repair.js';
        globalThis.rows=[[],[]];globalThis.results=[];let current=0;
        const report=(lib,json)=>{const value=JSON.parse(String(json));if(value.progress)rows[current].push(value);else results.push(value);};
        try {
            await cheerpjInit({version:17,status:'none',natives:{Java_BufferPrimitiveQualification_report:report,Java_BufferCodecQualification_report:report}});
            const originalStore=cj3Module.Java_jdk_internal_misc_Unsafe_putShort;
            globalThis.counters=installUnsafeShortRepair(cj3Module);
            const alternate={Java_jdk_internal_misc_Unsafe_putShort:originalStore};installUnsafeShortRepair(alternate);
            alternate.Java_jdk_internal_misc_Unsafe_putShort=originalStore;
            let tamperRejected=false;try{installUnsafeShortRepair(alternate);}catch{tamperRejected=true;}
            if(!tamperRejected)throw Error('Replaced repair was silently accepted');
            let fingerprintRejected=false;try{installUnsafeShortRepair({Java_jdk_internal_misc_Unsafe_putShort(){}});}catch{fingerprintRejected=true;}
            if(!fingerprintRejected)throw Error('Unknown runtime implementation accepted');
            if(installUnsafeShortRepair(cj3Module)!==counters)throw Error('Repair installation is not idempotent');
            const storage=new ArrayBuffer(16),view=new Int8Array(storage,4,8);view.E=66;new Uint8Array(storage).fill(90);
            cj3Module.Java_jdk_internal_misc_Unsafe_putShort(null,view,0,2n,0x1234,null);
            if(Array.from(new Uint8Array(storage)).join(',')!=='90,90,90,90,90,90,52,18,90,90,90,90,90,90,90,90')throw Error('Nonzero byteOffset differs');
            let rejected=false;try{cj3Module.Java_jdk_internal_misc_Unsafe_putShort(null,view,0,7n,1,null);}catch(error){rejected=error instanceof RangeError;}
            if(!rejected)throw Error('Out-of-range raw store accepted');
            await cheerpjRunMain('BufferPrimitiveQualification','${classpath}');current=1;
            await cheerpjRunMain('BufferCodecQualification','${classpath}');
            globalThis.result={pass:results.length===2&&results.every((value)=>value.pass),rows,counters};
        }catch(error){globalThis.result={pass:false,error:String(error.stack||error)};}
        finally{globalThis.completed=true;}
    </script>`;
    const files = new Map([['/', Buffer.from(html)], ['/qualification.jar', await readFile(archive)], ['/unsafe-short-repair.js', await readFile(path.join(root, 'browser-jvm/unsafe-short-repair.js'))], ...sdk]);

    server = createServer((request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        const bytes = files.get(pathname);

        if (!['GET', 'HEAD'].includes(request.method) || !bytes) {
            evidence.denied.push({ pathname, method: request.method });
            response.writeHead(404).end();

            return;
        }

        const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;

        if ((request.headers.range && !range) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= bytes.length) {
            response.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` }).end();

            return;
        }

        const type = pathname.endsWith('.js') ? 'text/javascript' : 'text/html';
        const headers = {
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
            'Content-Type': pathname.endsWith('.jar') ? 'application/java-archive' : type,
            'Content-Length': end - start + 1,
        };

        if (range) {
            headers['Content-Range'] = `bytes ${start}-${end}/${bytes.length}`;
        }

        response.writeHead(range ? 206 : 200, headers);
        response.end(request.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1));
    });
    await new Promise((done, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', done);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;

    browser = await chromium.launch({ executablePath, headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block' });

    await context.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const allowed = url.origin === origin || (url.origin === 'https://cjrtnc.leaningtech.com' && url.pathname.startsWith('/4.3/'));

        if (!['GET', 'HEAD'].includes(request.method()) || !allowed) {
            evidence.denied.push({ url: request.url(), method: request.method() });
            await route.abort();
        } else {
            await route.continue();
        }
    });
    const page = await context.newPage();

    page.on('console', (message) => evidence.logs.push(message.text()));
    page.on('pageerror', (error) => evidence.logs.push(String(error)));
    await page.goto(origin);
    await page.waitForFunction(() => globalThis.completed, undefined, { timeout: 90_000 });
    evidence.result = await page.evaluate(() => globalThis.result);
    assert.equal(evidence.result.pass, true, evidence.result.error);
    assert.equal(evidence.denied.length, 0, 'Requests escaped the qualification allowlist');
    assert.deepEqual(evidence.result.rows, evidence.jvm, 'Original JVM/browser rows differ');
    assert.deepEqual(evidence.jvm.map((rows) => rows.length), [140, 26]);
    assert.ok(evidence.result.counters.repaired > 0 && evidence.result.counters.delegated > 0);
    evidence.pass = true;
} catch (error) {
    evidence.error = String(error.stack || error);
} finally {
    try {
        await browser?.close();
        evidence.browserClosed = true;
    } catch (error) {
        evidence.cleanupError = String(error);
        evidence.pass = false;
    }

    if (server) {
        server.closeAllConnections();
        await new Promise((done) => {
            server.close(done);
        });
    }

    try {
        evidence.sha256After = hash(await readFile(prepared));
    } catch (error) {
        evidence.hashError = String(error);
        evidence.pass = false;
    }

    evidence.inputs = [];

    evidence.inputs = await Promise.all([...protectedInputs].map(async ([file, before]) => ({ file, before, after: hash(await readFile(file)) })));

    if (evidence.inputs.some(({ before, after }) => before !== after)) {
        evidence.pass = false;
    }

    if (evidence.sha256Before !== evidence.sha256After) {
        evidence.pass = false;
    }

    await writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
}

console.info(`Unsafe short qualification: ${evidence.pass ? 'PASS' : 'FAIL'}; evidence: ${path.join(output, 'result.json')}`);

if (!evidence.pass) {
    process.exitCode = 1;
}
