import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';

const { PZ_JDK: jdk, PZ_BROWSER: executablePath } = process.env;

if (!jdk || !executablePath) {
    throw new Error('Set PZ_JDK to the JDK directory and PZ_BROWSER to a Chromium executable. Prepare the play profile first.');
}

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'target/browser-jvm/native-memory');
const prepared = path.join(root, 'target/browser-jvm/play/runtime-view.jar');
const classes = path.join(output, 'classes');
const hostClasses = path.join(output, 'host-classes');
const tools = path.join(output, 'tools');
const archive = path.join(output, 'qualification.jar');
const source = path.join(root, 'browser-jvm/NativeMemoryQualification.java');
const inputSources = [source, import.meta.filename, ...['PrepareSpriteGraphics.java', 'host/port/host/SpriteGraphics.java', 'host/port/host/SpriteBuffers.java'].map((name) => path.join(root, 'browser-jvm', name))];
const evidence = { pass: false, denied: [], logs: [] };
let browser;
let browserServer;
let deadline;
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

/**
 * Bounds an operation on the browser owned by this verifier.
 *
 * @param {Promise<unknown>} operation - Owned browser operation.
 * @returns {Promise<unknown>} The completed operation.
 */
async function bounded(operation) {
    let timer;

    try {
        return await Promise.race([operation, new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Owned browser cleanup exceeded five seconds')), 5_000);
        })]);
    } finally {
        clearTimeout(timer);
    }
}

await mkdir(classes, { recursive: true });
await mkdir(hostClasses, { recursive: true });
await mkdir(tools, { recursive: true });

try {
    const preparedBytes = await readFile(prepared);

    evidence.preparedArchive = prepared;
    evidence.sha256Before = hash(preparedBytes);
    evidence.sources = await Promise.all(inputSources.map(async (file) => ({ file, before: hash(await readFile(file)) })));
    const hostSources = ['host/port/host/SpriteGraphics.java', 'host/port/host/SpriteBuffers.java'].map((name) => path.join(root, 'browser-jvm', name));

    command('javac', ['--release', '17', '-cp', prepared, '-d', hostClasses, ...hostSources]);
    command('javac', ['-d', tools, path.join(root, 'browser-jvm/PrepareSpriteGraphics.java')]);
    command('java', ['-cp', tools, 'PrepareSpriteGraphics', prepared, output, hostClasses]);
    const view = path.join(output, 'sprite-view.jar');
    const viewBytes = await readFile(view);

    evidence.viewSha256Before = hash(viewBytes);

    command('javac', ['--release', '17', '-cp', view, '-d', classes, source]);
    command('java', ['-Djdk.util.jar.version=17', '-cp', [classes, view].join(path.delimiter), 'NativeMemoryQualification', 'jvm']);
    evidence.jvmPassed = true;
    command('jar', ['--create', '--file', archive, '-C', classes, 'NativeMemoryQualification.class']);
    const html = `<script src="https://cjrtnc.leaningtech.com/4.3/loader.js"></script><script>
        (async () => {
            try {
                await cheerpjInit({version:17,status:'none',natives:{
                    Java_NativeMemoryQualification_report(lib,json){globalThis.result=JSON.parse(String(json));}
                }});
                await cheerpjRunMain('NativeMemoryQualification','/app/qualification.jar:/app/sprite-view.jar');
                if (!globalThis.result) throw new Error('Missing qualification report');
            } catch (error) { globalThis.result={pass:false,error:String(error.stack||error)}; }
            finally { globalThis.completed=true; }
        })();
    </script>`;
    const files = new Map([
        ['/', Buffer.from(html)],
        ['/qualification.jar', await readFile(archive)],
        ['/sprite-view.jar', viewBytes],
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

        const headers = {
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store',
            'Content-Type': pathname.endsWith('.jar') ? 'application/java-archive' : 'text/html',
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

    browserServer = await chromium.launchServer({ executablePath, headless: true });
    deadline = setTimeout(() => {
        evidence.deadlineExceeded = true;
        void browserServer.kill().catch((error) => evidence.logs.push(String(error)));
    }, 150_000);
    browser = await chromium.connect(browserServer.wsEndpoint());
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
    evidence.pass = true;
} catch (error) {
    evidence.error = String(error.stack || error);
} finally {
    clearTimeout(deadline);

    try {
        await bounded(browser?.close() || Promise.resolve());
    } catch (error) {
        evidence.cleanupError = String(error);
        evidence.pass = false;
    }

    if (browserServer) {
        const process = browserServer.process();

        try {
            if (process.exitCode === null && process.signalCode === null) {
                await bounded(browserServer.kill());
            }

            evidence.browserClosed = process.exitCode !== null || process.signalCode !== null;
            evidence.pass = evidence.pass && evidence.browserClosed;
        } catch (error) {
            evidence.cleanupError = String(error);
            evidence.pass = false;
        }
    }

    if (server) {
        server.closeAllConnections();
        await new Promise((done) => {
            server.close(done);
        });
    }

    try {
        evidence.sha256After = hash(await readFile(prepared));
        evidence.viewSha256After = hash(await readFile(path.join(output, 'sprite-view.jar')));
        await Promise.all((evidence.sources || []).map(async (input) => {
            input.after = hash(await readFile(input.file));

            if (input.before !== input.after) {
                evidence.pass = false;
            }
        }));
    } catch (error) {
        evidence.hashError = String(error);
        evidence.pass = false;
    }

    if (evidence.sha256Before !== evidence.sha256After || evidence.viewSha256Before !== evidence.viewSha256After) {
        evidence.pass = false;
    }

    await writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
}

console.info(`Native memory qualification: ${evidence.pass ? 'PASS' : 'FAIL'}; evidence: ${path.join(output, 'result.json')}`);

if (!evidence.pass) {
    process.exitCode = 1;
}
