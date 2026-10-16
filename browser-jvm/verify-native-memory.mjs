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
const prepared = path.join(root, 'target/browser-jvm/play/sprite-view.jar');
const classes = path.join(output, 'classes');
const archive = path.join(output, 'qualification.jar');
const source = path.join(root, 'browser-jvm/NativeMemoryQualification.java');
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
    command('javac', ['--release', '17', '-cp', prepared, '-d', classes, source]);
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
        ['/sprite-view.jar', preparedBytes],
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

    if (evidence.sha256Before !== evidence.sha256After) {
        evidence.pass = false;
    }

    await writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
}

console.info(`Native memory qualification: ${evidence.pass ? 'PASS' : 'FAIL'}; evidence: ${path.join(output, 'result.json')}`);

if (!evidence.pass) {
    process.exitCode = 1;
}
