/* eslint-disable no-await-in-loop -- Original initialization, source overlays and mutation phases are ordered. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createFileWatchService } from './file-watch-service.mjs';

const { PZ_JDK: jdk, PZ_BROWSER: executablePath, PZ_GAME_JAR: gameJar, PZ_WATCH_VM_EXIT: vmExitMode } = process.env;
const vmExitQualification = vmExitMode === '1';

assert.ok(jdk && executablePath && gameJar, 'Set PZ_JDK, PZ_BROWSER and PZ_GAME_JAR; prepare the play SDK first.');
const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'browser-jvm');
const output = path.join(root, 'target/browser-jvm/file-watch', randomUUID());
const inputs = new Map();
const routes = new Map();
const archives = ['play-entry.jar', 'animation-entry.jar', 'animation-view.jar', 'animation-sdk-view.jar', 'path-view.jar', 'float-bridge.jar', 'memory-bridge.jar', 'world-entry.jar', 'atomic-view.jar'];
const evidence = { pass: false, vmExitQualification, output, startedUtc: new Date().toISOString(), logs: [], denied: [], forcedTermination: false, deadlineExceeded: false };
let server;
let service;
let owner;
let page;
let timer;
let mutationPhase = -1;

/**
 * Hashes an exact input snapshot.
 *
 * @param {Buffer} bytes - Input bytes.
 * @returns {string} SHA-256 digest.
 */
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Freezes a source or runtime input before serving.
 *
 * @param {string} file - Input path.
 * @returns {Promise<Buffer>} Frozen bytes.
 */
async function snapshot(file) {
    if (!inputs.has(file)) {
        inputs.set(file, await readFile(file));
    }

    return inputs.get(file);
}

/**
 * Runs a bounded literal JDK tool without launching the installed game or server.
 *
 * @param {string} name - Tool name.
 * @param {string[]} args - Literal arguments.
 * @param {string} [cwd] - Owned working directory.
 * @returns {object} Completed process result.
 */
function command(name, args, cwd = output) {
    const result = spawnSync(path.join(jdk, 'bin', name + (process.platform === 'win32' ? '.exe' : '')), args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1_024 * 1_024 });

    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);

    return result;
}

/**
 * Bounds cleanup belonging to this verifier.
 *
 * @param {Promise<unknown>} operation - Owned operation.
 * @returns {Promise<unknown>} Completion within five seconds.
 */
function cleanup(operation) {
    let deadline;

    return Promise.race([operation, new Promise((resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('Owned watcher cleanup deadline')), 5_000);
    })]).finally(() => clearTimeout(deadline));
}

/**
 * Confirms effective original watcher classes differ only in their qualified major version.
 *
 * @param {string[]} jars - Frozen archives in actual classpath order.
 * @returns {Promise<void>} Completed class audit.
 */
async function auditClasses(jars) {
    const names = ['zombie/DebugFileWatcher.class', 'zombie/DebugFileWatcher$1.class', 'zombie/DebugFileWatcher$IOnInitListener.class', 'zombie/PredicatedFileWatcher.class', 'zombie/PredicatedFileWatcher$IPredicatedFileWatcherCallback.class'];
    const effective = new Map();
    const original = path.join(output, 'original-classes');

    await mkdir(original);
    command('jar', ['xf', path.join(output, 'reference-game.jar'), ...names], original);

    for (const [index, jar] of jars.entries()) {
        const entries = new Set(command('jar', ['tf', jar]).stdout.split(/\r?\n/u));
        const found = names.filter((name) => !effective.has(name) && entries.has(name));

        if (!found.length) {
            continue;
        }

        const destination = path.join(output, `effective-${index}`);

        await mkdir(destination);
        command('jar', ['xf', jar, ...found], destination);

        for (const name of found) {
            effective.set(name, await readFile(path.join(destination, name)));
        }
    }

    evidence.classAudit = [];

    for (const name of names) {
        const before = await readFile(path.join(original, name));
        const after = effective.get(name);

        assert.ok(after, `Missing effective original ${name}`);
        const restored = Buffer.from(after);

        if (before.readUInt16BE(6) === 69 && restored.readUInt16BE(6) === 61) {
            restored.writeUInt16BE(69, 6);
        }

        assert.deepEqual(restored, before, `Original class body changed: ${name}`);
        evidence.classAudit.push({ name, originalSha: sha(before), loadedSha: sha(after), bodyUnchanged: true });
    }
}

/**
 * Compiles authored consumers and snapshots the existing prepared Java runtime.
 */
async function prepare() {
    await mkdir(path.join(output, 'classes'), { recursive: true });
    const original = await snapshot(gameJar);

    await writeFile(path.join(output, 'reference-game.jar'), original);
    const javaSources = ['NioWatchQualification.java', 'FileWatchQualification.java'];

    await Promise.all([...javaSources, 'file-watch-natives.js', 'file-watch-service.mjs', 'verify-file-watch.mjs', 'scheduler-runtime.js'].map((name) => snapshot(path.join(source, name))));
    command('javac', ['--release', '17', '-cp', path.join(output, 'reference-game.jar'), '-d', path.join(output, 'classes'), ...javaSources.map((name) => path.join(source, name))]);
    command('jar', ['--create', '--file', path.join(output, 'qualification.jar'), '-C', path.join(output, 'classes'), '.']);
    routes.set('/qualification.jar', await snapshot(path.join(output, 'qualification.jar')));
    const jars = [];

    for (const name of archives) {
        const bytes = await snapshot(path.join(root, 'target/browser-jvm/play', name));
        const destination = path.join(output, name);

        await writeFile(destination, bytes);
        routes.set(`/${name}`, bytes);
        jars.push(destination);
    }

    await auditClasses(jars);

    for (const name of ['scheduler-runtime.js', 'file-watch-natives.js']) {
        routes.set(`/${name}`, await snapshot(path.join(source, name)));
    }

    for (const name of ['manifest.json', 'cj3.js', 'load-function.js']) {
        routes.set(`/scheduler-runtime/${name}`, await snapshot(path.join(root, 'target/browser-jvm/bullet-qualification/scheduler-runtime', name)));
    }
}

/**
 * Runs the same original consumer and pure-JDK contract on an unchanged native JDK.
 *
 * @returns {Promise<void>} Completed contained reference.
 */
async function nativeReference() {
    const owned = path.join(output, 'native');

    await Promise.all([mkdir(path.join(owned, 'home'), { recursive: true }), mkdir(path.join(owned, 'tmp'), { recursive: true })]);
    const result = command('java', [`-Duser.home=${owned}/home`, `-Djava.io.tmpdir=${owned}/tmp`, '-cp', [path.join(output, 'qualification.jar'), path.join(output, 'reference-game.jar')].join(path.delimiter), 'FileWatchQualification', 'native', owned], owned);

    await writeFile(path.join(output, 'native.log'), result.stdout + result.stderr);
    const reports = result.stdout.split(/\r?\n/u).filter((line) => line.startsWith('{"pass":')).map((line) => JSON.parse(line));

    assert.equal(reports.length, 2);
    assert.ok(reports.every((report) => report.pass));
    assert.ok(reports[0].checks >= 17);
    assert.equal(reports[1].checks, 14);
    assert.equal(reports[1].callbacks, 3);
    assert.equal(reports[1].registered, 4);
    assert.equal(result.stderr, '');
    evidence.native = { exit: result.status, reports };
}

/**
 * Serves frozen runtime bytes or actual, owned and deliberately mutable media.
 *
 * @param {object} request - Owned request.
 * @param {object} response - Owned response.
 * @param {Buffer} bytes - Actual response bytes.
 * @param {string} type - MIME type.
 */
function send(request, response, bytes, type) {
    const range = request.headers.range;
    const match = range?.match(/^bytes=(\d+)-(\d*)$/u);
    const start = match ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;

    if (range && (!match || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start < 0)) {
        evidence.rangeRejections ??= [];
        evidence.rangeRejections.push({ path: request.url, range, size: bytes.length });
        response.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` }).end();

        return;
    }

    response.writeHead(range ? 206 : 200, { 'Content-Type': type, 'Content-Length': Math.max(0, end - start + 1), 'Cache-Control': 'no-store', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) });
    response.end(request.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1));
}

/**
 * Reads only this gate's temporary media mount; mutation stays in the Node driver.
 *
 * @param {object} request - Owned HTTP request.
 * @param {object} response - Owned HTTP response.
 * @param {string} pathname - Decoded virtual path.
 * @returns {Promise<void>} Completed actual media response.
 */
async function mediaResponse(request, response, pathname) {
    const media = path.join(output, 'media');
    const relative = pathname.slice('/media'.length);
    const file = path.join(media, relative);

    assert.ok(file === media || file.startsWith(media + path.sep), 'Outside owned media');

    try {
        if (pathname.endsWith('/index.list')) {
            send(request, response, Buffer.from(`${(await readdir(path.dirname(file))).join('\n')}\n`), 'text/plain');

            return;
        }

        const info = await stat(file);

        if (info.isDirectory() && !pathname.endsWith('/')) {
            response.writeHead(302, { Location: encodeURI(`${pathname}/`) }).end();

            return;
        }

        send(request, response, info.isDirectory() ? Buffer.alloc(0) : await readFile(file), 'application/octet-stream');
    } catch (error) {
        const optionalFolders = new Set(['/media/anims', '/media/anims_x', '/media/animsets', '/media/actiongroups']);
        const deletedFixture = mutationPhase === 3 && pathname === '/media/new-child/observed.txt';

        if (error.code === 'ENOENT' && (deletedFixture || optionalFolders.has(pathname.toLowerCase()))) {
            evidence.expectedAbsent ??= [];
            evidence.expectedAbsent.push(pathname);
            response.writeHead(404).end();

            return;
        }

        throw error;
    }
}

/**
 * Routes fixed runtime inputs and the single owned watch fixture mount.
 *
 * @param {object} request - Owned request.
 * @param {object} response - Owned response.
 * @returns {Promise<void>} Completed route.
 */
async function serve(request, response) {
    if (service.handle(request, response)) {
        return;
    }

    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);

    if (!['GET', 'HEAD'].includes(request.method) || pathname.includes('\\') || pathname.split('/').includes('..')) {
        evidence.denied.push(pathname);
        response.writeHead(404).end();

        return;
    }

    if (pathname === '/media' || pathname.startsWith('/media/')) {
        await mediaResponse(request, response, pathname);

        return;
    }

    const bytes = routes.get(pathname);

    if (!bytes) {
        evidence.denied.push(pathname);
        response.writeHead(404).end();

        return;
    }

    const extension = path.extname(pathname);
    const types = { '.jar': 'application/java-archive', '.js': 'text/javascript', '.json': 'application/json' };

    send(request, response, bytes, types[extension] ?? 'text/html');
}

/**
 * Drives genuine filesystem mutations while original Java owns watch processing.
 *
 * @param {object} page - Owned page.
 * @returns {Promise<void>} Completed four real external mutation phases.
 */
async function mutate(page) {
    const directory = path.join(output, 'media/new-child');
    const file = path.join(directory, 'observed.txt');

    for (let phase = 0; phase < 4; phase++) {
        await page.waitForFunction((value) => globalThis.done || globalThis.phase === value, phase, { timeout: 40_000 });
        assert.equal(await page.evaluate(() => Boolean(globalThis.done)), false, 'Original Java ended before remote mutation');
        mutationPhase = phase;

        switch (phase) {
            case 0: {
                await mkdir(directory);

                break;
            }
            case 1: {
                await writeFile(file, 'nested');

                break;
            }
            case 2: {
                await writeFile(file, 'modified-remote');

                break;
            }

            default: {
                await unlink(file);
            }
        }

        await page.evaluate(() => {
            const resume = globalThis.resume;

            globalThis.resume = null;
            resume();
        });
    }
}

try {
    await prepare();

    if (!vmExitQualification) {
        await nativeReference();
    }

    await mkdir(path.join(output, 'media/sub'), { recursive: true });
    service = createFileWatchService({ mounts: [{ virtualPrefix: '/app/media', root: path.join(output, 'media') }] });
    const owned = `/files/file-watch/${randomUUID()}`;

    routes.set('/', Buffer.from(`<script src="https://cjrtnc.leaningtech.com/4.3/loader.js"></script><script type="module">
        import {startSchedulerRuntime} from '/scheduler-runtime.js';
        import {createFileWatchNatives} from '/file-watch-natives.js';
        const watch=createFileWatchNatives();globalThis.reports=[];globalThis.watchDiagnostics=()=>watch.diagnostics();
        globalThis.unhandledRejections=[];
        addEventListener('unhandledrejection',event=>globalThis.unhandledRejections.push(String(event.reason?.stack||event.reason)));
        try {
            await startSchedulerRuntime({version:17,status:'none',javaProperties:['user.home=${owned}/home','user.dir=/app','java.io.tmpdir=${owned}/tmp'],natives:{...watch.natives,
                Java_NioWatchQualification_report(lib,text){
                    const report={kind:'jdk',...JSON.parse(String(text))};reports.push(report);
                    if(report.stage==='before-system-exit'){
                        const before=watch.diagnostics();globalThis.beforeVmExit=before;
                        let rejected=false;try{watch.dispose();}catch(error){rejected=String(error).includes('Original watch owners remain');}
                        globalThis.strictDisposeRejected=rejected;
                        const after=watch.diagnostics();
                        if(!rejected||before.owned!==3||before.polls!==1||JSON.stringify(before)!==JSON.stringify(after))throw new Error('Actual live watch ownership/strict disposal failed');
                    }
                },
                Java_FileWatchQualification_report(lib,text){reports.push({kind:'original',...JSON.parse(String(text))});},
                Java_FileWatchQualification_remoteMutation(lib,phase){globalThis.phase=phase;return new Promise(resolve=>{globalThis.resume=resolve;});}
            }});
            watch.install();
            globalThis.exit=await cheerpjRunMain('${vmExitQualification ? 'NioWatchQualification' : 'FileWatchQualification'}','/app/qualification.jar:${archives.map((name) => `/app/${name}`).join(':')}','${vmExitQualification ? 'vm-exit' : 'browser'}','${vmExitQualification ? '/app/media/sub' : owned}','/app/media');
            globalThis.vmExitObserved=true;
            if(${vmExitQualification}){
                globalThis.beforeVmExitDispose=watch.diagnostics();
                await watch.disposeAfterVmExit();
                await watch.disposeAfterVmExit();
                await new Promise(resolve=>setTimeout(resolve,100));
            }else{watch.dispose();}
        } catch(error){globalThis.error=String(error.stack||error);}
        finally{globalThis.diagnostics=watch.diagnostics();globalThis.done=true;}
    </script>`));
    server = createServer((request, response) => {
        void serve(request, response).catch((error) => {
            evidence.serverError = String(error);
            response.writeHead(500).end();
        });
    });
    await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    owner = await chromium.launchServer({ executablePath, headless: true });
    evidence.owner = { pid: owner.process().pid, startUtc: new Date().toISOString(), deadlineUtc: new Date(Date.now() + 90_000).toISOString() };
    timer = setTimeout(() => {
        evidence.deadlineExceeded = true;
        evidence.forcedTermination = true;
        void owner.kill();
    }, 90_000);
    const browser = await chromium.connect(owner.wsEndpoint());
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const origin = `http://127.0.0.1:${server.address().port}`;

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
    page.on('pageerror', (error) => evidence.logs.push(`PAGEERROR: ${String(error)}`));
    await page.goto(origin);

    if (!vmExitQualification) {
        await mutate(page);
    }

    await page.waitForFunction(() => globalThis.done, null, { timeout: 20_000 });
    evidence.browser = await page.evaluate(() => ({
        exit: globalThis.exit, reports: globalThis.reports, diagnostics: globalThis.diagnostics, error: globalThis.error,
        vmExitObserved: globalThis.vmExitObserved, beforeVmExit: globalThis.beforeVmExit, beforeVmExitDispose: globalThis.beforeVmExitDispose,
        strictDisposeRejected: globalThis.strictDisposeRejected, unhandledRejections: globalThis.unhandledRejections,
    }));
    assert.equal(evidence.browser.exit, 0);
    assert.equal(evidence.browser.error, undefined);
    assert.equal(evidence.browser.vmExitObserved, true);
    assert.deepEqual(evidence.browser.unhandledRejections, []);
    assert.ok(evidence.browser.reports.every((report) => report.pass));

    if (vmExitQualification) {
        assert.equal(evidence.browser.reports.length, 1);
        assert.equal(evidence.browser.strictDisposeRejected, true);
        assert.equal(evidence.browser.beforeVmExitDispose.owned, 3);
        assert.equal(evidence.browser.beforeVmExitDispose.polls, 1);
        assert.equal(evidence.browser.diagnostics.callCounts.close, 3);
        assert.equal(evidence.browser.diagnostics.callCounts['poll-closed'], undefined);
        assert.equal(evidence.browser.diagnostics.callCounts['vm-exit-poll-abandoned'], 1);
        assert.equal(evidence.browser.diagnostics.cancelledSubscriptions, 1);
        assert.equal(evidence.browser.diagnostics.unsettledNativePromises, 1);
        assert.equal(evidence.browser.diagnostics.callCounts['vm-exit-dispose'], 1);
    } else {
        assert.equal(evidence.browser.reports.length, 2);
        assert.ok(evidence.browser.reports[0].checks >= 17);
        assert.equal(evidence.browser.reports[1].checks, 20);
        assert.equal(evidence.browser.reports[1].callbacks, 4);
        assert.equal(evidence.browser.reports[1].registered, 4);
    }

    assert.equal(evidence.browser.diagnostics.owned, 0);
    assert.equal(evidence.browser.diagnostics.polls, 0);
    assert.equal(evidence.browser.diagnostics.remoteState, 2);
    assert.equal(evidence.browser.diagnostics.remoteFailure, undefined);
    assert.deepEqual(evidence.logs.filter((line) => /Exception|Error:|SEVERE|PAGEERROR:/u.test(line)), []);
    evidence.pass = true;
} catch (error) {
    evidence.pass = false;
    evidence.error = String(error.stack || error);

    if (page && !page.isClosed()) {
        await cleanup(page.evaluate(() => ({ exit: globalThis.exit, reports: globalThis.reports, phase: globalThis.phase, diagnostics: globalThis.watchDiagnostics?.(), error: globalThis.error }))).then((snapshot) => {
            evidence.browserAtFailure = snapshot;
        }).catch((snapshotError) => {
            evidence.snapshotError = String(snapshotError);
        });
    }
} finally {
    if (owner) {
        await cleanup(owner.close()).catch(async (error) => {
            evidence.closeError = String(error);
            evidence.forcedTermination = true;
            await cleanup(owner.kill());
        });
    }

    clearTimeout(timer);
    evidence.closed = !owner || owner.process().exitCode !== null || owner.process().signalCode !== null;

    if (service) {
        await cleanup(service.close());
        evidence.service = service.diagnostics();
        assert.equal(evidence.service.watchers + evidence.service.clients + evidence.service.queued + evidence.service.entries + evidence.service.watcherListeners, 0);
        assert.equal(evidence.service.timerActive, false);
    }

    if (server) {
        server.closeAllConnections();
        await cleanup(new Promise((resolve) => {
            server.close(resolve);
        }));
    }

    evidence.inputs = await Promise.all([...inputs].map(async ([file, bytes]) => ({ file, before: sha(bytes), after: sha(await readFile(file)) })));
    evidence.pass &&= evidence.closed && !evidence.forcedTermination && !evidence.deadlineExceeded && !evidence.serverError && !evidence.closeError && evidence.denied.length === 0 && evidence.inputs.every((input) => input.before === input.after);
    evidence.finishedUtc = new Date().toISOString();
    await writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ pass: evidence.pass, output, native: evidence.native, browser: evidence.browser?.reports, closed: evidence.closed, error: evidence.error }));
}

if (!evidence.pass) {
    process.exitCode = 1;
}
