import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';

const { PZ_JDK: jdk, PZ_BROWSER: executablePath } = process.env;

if (!jdk || !executablePath) {
    throw new Error('Set PZ_JDK to the JDK directory and PZ_BROWSER to a Chromium executable.');
}

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'target/browser-jvm/native-long');
const classes = path.join(output, 'classes');
const archive = path.join(output, 'qualification.jar');
const source = path.join(root, 'browser-jvm/NativeLongQualification.java');
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
    command('javac', ['--release', '17', '-d', classes, source]);
    command('jar', ['--create', '--file', archive, '-C', classes, 'NativeLongQualification.class']);
    const modulePath = path.join(root, 'browser-jvm/native-long-return.js');
    const moduleBytes = await readFile(modulePath);

    evidence.moduleHashBefore = hash(moduleBytes);
    const html = `<meta charset="utf-8"><script src="https://cjrtnc.leaningtech.com/4.3/loader.js"></script><script type="module">
        import {installNativeLongReturnRepair} from '/native-long-return.js';
        const values=[0n,1n,-1n,-(1n<<63n),(1n<<63n)-1n,(1n<<53n)-1n,1n<<53n,(1n<<53n)+1n,-((1n<<53n)+1n),1n<<64n,1n<<63n,(1n<<64n)-1n,-(1n<<64n)+1n];
        let identity=false,tamper=false;
        const install=(lib)=>{const counters=installNativeLongReturnRepair(lib);identity=installNativeLongReturnRepair(lib)===counters;globalThis.counters=counters;};
        try {
            await cheerpjInit({version:17,status:'none',natives:{
                Java_NativeLongQualification_sync(lib,index){install(lib);return values[index];},
                async Java_NativeLongQualification_async(lib,index){install(lib);await Promise.resolve();return values[index];},
                Java_NativeLongQualification_integer(){return 123456789;},
                Java_NativeLongQualification_floating(){return -0.125;},
                Java_NativeLongQualification_text(){return 'Unicode Ω 😃';},
                async Java_NativeLongQualification_object(lib){return await new(await lib.java.lang.Object)();},
                Java_NativeLongQualification_array(){return new BigInt64Array(values.map(value=>BigInt.asIntN(64,value)));},
                async Java_NativeLongQualification_fail(lib){throw await new(await lib.java.lang.IllegalStateException)('native-fixture');},
                async Java_NativeLongQualification_report(lib,json){
                    const constructor=Object.getPrototypeOf(lib).constructor,wrapper=constructor.restart;
                    constructor.restart=function(){};
                    try{installNativeLongReturnRepair(lib);}catch{tamper=true;}finally{constructor.restart=wrapper;}
                    const Input=await lib.NativeLongQualification;
                    const scalarInputBoundary=await Input.input(1n);
                    globalThis.result={...JSON.parse(String(json)),identity,tamper,scalarInputBoundary};
                }
            }});
            await cheerpjRunMain('NativeLongQualification','/app/qualification.jar');
            if(!globalThis.result)throw new Error('Missing Java qualification report');
        }catch(error){globalThis.result={pass:false,error:String(error.stack||error)};}
        finally{globalThis.completed=true;}
    </script>`;
    const files = new Map([
        ['/', Buffer.from(html)],
        ['/qualification.jar', await readFile(archive)],
        ['/native-long-return.js', moduleBytes],
    ]);

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

        const textType = pathname === '/' ? 'text/html; charset=utf-8' : 'text/javascript';
        const headers = {
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
            'Content-Type': pathname.endsWith('.jar') ? 'application/java-archive' : textType,
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

    const runtimeReads = [];

    page.on('response', (response) => {
        if (response.url() === 'https://cjrtnc.leaningtech.com/4.3/cj3.js') {
            runtimeReads.push(response.body().then((bytes) => hash(bytes)));
        }
    });
    page.on('console', (message) => evidence.logs.push(message.text()));
    page.on('pageerror', (error) => evidence.logs.push(String(error)));
    await page.goto(origin);
    await page.waitForFunction(() => globalThis.completed, undefined, { timeout: 90_000 });
    evidence.result = await page.evaluate(() => globalThis.result);
    evidence.counters = await page.evaluate(() => globalThis.counters);
    evidence.runtimeHashes = await Promise.all(runtimeReads);
    assert.deepEqual(evidence.runtimeHashes, ['5bcf00711009cbb12b858dcbea865cfe0e9d652cfc95f55ad20a600724462644']);
    assert.equal(evidence.result.pass, true, evidence.result.error);
    assert.equal(evidence.denied.length, 0, 'Requests escaped the qualification allowlist');
    assert.equal(evidence.result.nativeLongReturns, 26);
    assert.equal(evidence.result.delegatedTypes, 5);
    assert.equal(evidence.result.javaExceptionCaught, true);
    assert.equal(evidence.result.finallyExecuted, true);
    assert.equal(evidence.result.identity, true);
    assert.equal(evidence.result.tamper, true);
    assert.equal(evidence.result.scalarInputBoundary, '0');
    assert.equal(evidence.counters.repaired, 26);
    assert.equal(evidence.counters.wrapped, 8);
    assert.ok(evidence.counters.delegated >= 6);
    assert.deepEqual(evidence.logs, []);
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
        evidence.moduleHashAfter = hash(await readFile(path.join(root, 'browser-jvm/native-long-return.js')));
    } catch (error) {
        evidence.hashError = String(error);
        evidence.pass = false;
    }

    if (evidence.moduleHashBefore !== evidence.moduleHashAfter) {
        evidence.pass = false;
    }

    await writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
}

console.info(`Native long return qualification: ${evidence.pass ? 'PASS' : 'FAIL'}; evidence: ${path.join(output, 'result.json')}`);

if (!evidence.pass) {
    process.exitCode = 1;
}
