import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { decodeCell, decodeIDs, decodeEmptyVirtual } from './population-save-codec.js';

const { PZ_JDK: jdk, PZ_BROWSER: executablePath, PZ_GAME_JAR: gameJar } = process.env;

if (!jdk || !executablePath || !gameJar) {
    throw new Error('Set PZ_JDK, PZ_BROWSER and PZ_GAME_JAR; prepare the public play SDK first.');
}

const repository = path.resolve(import.meta.dirname, '..');
const installation = path.dirname(fs.realpathSync(gameJar));
const output = path.join(repository, 'target/browser-jvm/population');

fs.mkdirSync(output, { recursive: true });

const root = path.join(output, randomUUID());

fs.mkdirSync(root);
assert.ok(fs.realpathSync(root).startsWith(`${fs.realpathSync(output)}${path.sep}`));
assert.ok(!fs.realpathSync(root).startsWith(`${fs.realpathSync(installation)}${path.sep}`));

const nativeClasses = path.join(root, 'native-classes');
const browserClasses = path.join(root, 'browser-classes');
const source = import.meta.dirname;
const inputs = new Map();
const routes = new Map();
const originalMap = path.join(installation, 'media/maps/Muldraugh, KY');
const jars = ['animation-entry.jar', 'animation-view.jar', 'animation-sdk-view.jar', 'path-view.jar', 'float-bridge.jar', 'memory-bridge.jar', 'world-entry.jar', 'atomic-view.jar'];
const ordinaryInputs = ['stdlib.lua', 'media/lua/shared/defines.lua', 'media/lua/shared/Sandbox/Apocalypse.lua', 'media/lua/shared/NPCs/ZombiesZoneDefinition.lua', 'media/fileGuidTable.xml', 'media/clothing/clothing.xml'];
const collisionName = 'media/maps/Muldraugh, KY/chunkdata_41_40.bin';
const evidence = { pass: false, root, startedUtc: new Date().toISOString(), native: [], browsers: [], denied: [] };
let server;
let browserServer;
let deadline;
let active;
let mapBefore;

/**
 * Computes a source or emitted-file digest without changing it.
 *
 * @param {Buffer} bytes - Actual source bytes.
 * @returns {string} SHA-256 digest.
 */
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Snapshots one actual dependency before any listener or original-code execution.
 *
 * @param {string} file - Actual original or authored input path.
 * @returns {Buffer} Frozen source bytes.
 */
function snapshot(file) {
    const bytes = fs.readFileSync(file);

    const before = inputs.get(file);

    if (before) {
        assert.equal(digest(bytes), before, `Input changed during preparation: ${file}`);
    }

    inputs.set(file, digest(bytes));

    return bytes;
}

/**
 * Lists actual source files while retaining relative names and sizes.
 *
 * @param {string} directory - Existing original source directory.
 * @returns {Array<object>} Stable original directory metadata.
 */
function inventory(directory) {
    return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
            const file = path.join(entry.parentPath, entry.name);
            const info = fs.statSync(file);

            return { name: path.relative(directory, file), size: info.size, mtimeMs: info.mtimeMs };
        }).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Copies immutable actual inputs into a fresh owned work tree.
 *
 * @param {string} owner - Canonical fixture root.
 * @param {Array<string>} names - Original installation-relative paths.
 * @returns {void} Completes owned copies only.
 */
function copyInputs(owner, names) {
    fs.mkdirSync(path.join(owner, 'home'), { recursive: true });

    for (const name of names) {
        const target = path.join(owner, 'work', name);

        fs.mkdirSync(path.dirname(target), { recursive: true });
        const bytes = snapshot(path.join(installation, name));

        fs.writeFileSync(target, bytes);
        inputs.set(target, digest(bytes));
    }
}

/**
 * Runs one bounded, data-only JDK tool or original JNI component.
 *
 * @param {string} label - Evidence label.
 * @param {string} tool - JDK executable name.
 * @param {Array<string>} args - Exact argument vector, never shell text.
 * @param {string} cwd - Owned working directory.
 * @param {number} timeout - Fixed per-process maximum in milliseconds.
 * @returns {string} Original stdout and stderr for assertions.
 */
function command(label, tool, args, cwd = root, timeout = 30_000) {
    const result = spawnSync(path.join(jdk, 'bin', `${tool}${process.platform === 'win32' ? '.exe' : ''}`), args,
        { cwd, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 8 * 1_024 * 1_024 });
    const text = `${result.stdout || ''}${result.stderr || ''}`;

    fs.writeFileSync(path.join(root, `${label}.log`), text);
    evidence.native.push({ label, status: result.status, signal: result.signal, error: result.error?.message });
    assert.equal(result.status, 0, `${label}: ${text.slice(-2_000)}`);
    assert.ok(!/error:|\b\w*exception\s*:|failed to open for writing|severe:/i.test(text), `${label}: original error`);

    return text;
}

/**
 * Runs the same original worker/save/reopen calls against the original copied DLL.
 *
 * @param {string} label - Native evidence label.
 * @param {string} owner - Fresh owned private root.
 * @param {string} phase - Original writer or reader phase.
 * @returns {string} Bounded original native output.
 */
function nativePhase(label, owner, phase) {
    return command(label, 'java', ['--enable-native-access=ALL-UNNAMED', `-Duser.home=${path.join(owner, 'home')}`,
        `-Djava.library.path=${root}`, '-cp', `${nativeClasses}${path.delimiter}${gameJar}`,
        'PopulationQualification', owner, phase, '', 'native'], path.join(owner, 'work'));
}

/**
 * Limits browser-owner close and kill independently of the JVM page.
 *
 * @param {Promise<unknown>} operation - Actual owned browser operation.
 * @param {number} milliseconds - Fixed operation limit.
 * @returns {Promise<unknown>} Actual completion, or a bounded ownership error.
 */
async function bounded(operation, milliseconds) {
    let timer;

    try {
        return await Promise.race([operation, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Owned browser operation timed out')), milliseconds);
        })]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Closes only the browser process owned by the current qualification phase.
 *
 * @returns {Promise<void>} Bounded closure with honest forced-termination evidence.
 */
async function closeBrowser() {
    clearTimeout(deadline);

    if (!browserServer) {
        return;
    }

    const child = browserServer.process();

    try {
        await bounded(browserServer.close(), 5_000);
    } catch (error) {
        active.closeError = String(error);
    }

    if (child.exitCode === null && child.signalCode === null) {
        active.forcedTermination = true;
        await bounded(browserServer.kill(), 5_000);
    }

    active.closed = child.exitCode !== null || child.signalCode !== null;
    browserServer = undefined;
}

/**
 * Creates the verifier-only observer around the exact CheerpJ-loaded host instance.
 *
 * @param {string} phase - Writer or fresh reader VM.
 * @param {Array<string>} reopen - Original filenames emitted by the writer.
 * @returns {string} Authored qualification HTML.
 */
function pageSource(phase, reopen) {
    const cp = ['qualification.jar', ...jars].map((name) => `/app/${name}`).join(':');

    return `<!doctype html><script src="https://cjrtnc.leaningtech.com/4.3/loader.js"></script><script type="module">
import {installUnsafeShortRepair} from '/unsafe-short-repair.js';
import {installNativeLibraryLoader} from '/native-library-loader.js';
try {
 await cheerpjInit({version:17,status:'none',javaProperties:['user.dir=/files/population-qualification/work','user.home=/files/population-qualification/home','java.library.path=/app/'],natives:{Java_PopulationQualification_progress(lib,kind){if(!globalThis.populationQualificationService)throw Error('Actual loaded population instance unavailable');const state=globalThis.populationQualificationService.diagnostics();return kind===0?state.updates:state.pending;}}});
 installUnsafeShortRepair(globalThis.cj3Module);installNativeLibraryLoader(globalThis.cj3Module);
 const buffers=await cheerpjRunMain('PopulationBuffersQualification','${cp}');
 if(buffers!==0)throw Error('Actual Java buffer checks failed');
 const code=await cheerpjRunMain('PopulationQualification','${cp}','/files/population-qualification','${phase}',${JSON.stringify(reopen.join(','))},'browser');
 globalThis.result={pass:code===0,code,diagnostics:globalThis.populationQualificationService?.diagnostics()};
} catch(error){globalThis.result={pass:false,error:String(error.stack||error)};}finally{globalThis.completed=true;}
</script>`;
}

/**
 * Executes one fresh browser VM against the frozen public host sources.
 *
 * @param {string} phase - Writer or reader phase.
 * @param {object} emitted - Owned writer bytes, keyed by original relative filename.
 * @returns {Promise<void>} Original Java completion, file checks and owned cleanup.
 */
async function browserPhase(phase, emitted) {
    const exports = new Map();

    active = { phase, pass: false, logs: [], startUtc: new Date().toISOString() };
    evidence.browsers.push(active);
    routes.set('/', Buffer.from(pageSource(phase, Object.keys(emitted))));

    for (const [name, bytes] of Object.entries(emitted)) {
        routes.set(`/reopen/${name}`, bytes);
    }

    const origin = `http://127.0.0.1:${server.address().port}`;
    const start = Date.now();

    active.deadlineUtc = new Date(start + 120_000).toISOString();
    deadline = setTimeout(() => {
        active.deadlineExceeded = true;

        if (browserServer) {
            void bounded(browserServer.kill(), 5_000).catch((error) => {
                active.killError = String(error);
            });
        }
    }, 120_000);

    try {
        browserServer = await chromium.launchServer({ executablePath, headless: true, timeout: 30_000 });
        active.pid = browserServer.process().pid;
        fs.writeFileSync(path.join(root, 'live-result.json'), JSON.stringify(evidence, null, 2));

        const browser = await chromium.connect(browserServer.wsEndpoint());
        const context = await browser.newContext({ serviceWorkers: 'block' });

        await context.route('**/*', (route) => {
            const request = route.request();
            const url = new URL(request.url());
            const local = url.origin === origin && !url.search && routes.has(decodeURIComponent(url.pathname));
            const runtime = url.origin === 'https://cjrtnc.leaningtech.com' && url.pathname.startsWith('/4.3/');

            if (['GET', 'HEAD'].includes(request.method()) && (local || runtime)) {
                return route.continue();
            }

            evidence.denied.push({ method: request.method(), url: request.url() });

            return route.abort();
        });
        const page = await context.newPage();

        page.on('console', (message) => {
            const text = message.text();

            active.logs.push(text);
            fs.appendFileSync(path.join(root, `browser-${phase}.log`), `${text}\n`);
            const record = /^POPULATION_FILE (\S+) (\d+) (\d+) ([\da-f]+)$/.exec(text.trim());

            if (record) {
                if (/^(?:z_outfits\.bin|zpop\/zpop_(?:41_40|ids|virtual)\.bin)$/.test(record[1])) {
                    const offset = Number(record[2]);
                    const total = Number(record[3]);
                    const previous = exports.get(record[1]) || { total, hex: '' };

                    if (previous.total !== total || previous.hex.length !== offset || total % 2
                        || total > 8 * 1_024 * 1_024 || record[4].length % 2 || offset + record[4].length > total) {
                        active.fileError = `Invalid export frame: ${record[1]}`;
                    } else {
                        previous.hex += record[4];
                        exports.set(record[1], previous);

                        if (previous.hex.length === total) {
                            emitted[record[1]] = Buffer.from(previous.hex, 'hex');
                        }
                    }
                } else {
                    active.fileError = `Unqualified emitted filename: ${record[1]}`;
                }
            }
        });
        page.on('pageerror', (error) => active.logs.push(String(error)));
        await page.goto(origin);
        await page.waitForFunction(() => globalThis.completed, undefined, { timeout: 120_000 });
        active.result = await page.evaluate(() => globalThis.result);
        assert.equal(active.result.pass, true, active.result.error);
        assert.equal(active.fileError, undefined);
        assert.ok(active.logs.some((text) => text.includes('POPULATION_BUFFERS_PASS checks=24')));
        assert.ok(active.logs.some((text) => text.includes('ORIGINAL_CLEANUP_PASS')));
        assert.ok(active.logs.some((text) => text.includes('POPULATION_SAVE_REOPEN_PASS')));
        assert.ok(!active.logs.some((text) => /error:|\b\w*exception\s*:|severe:/i.test(text)));
        assert.equal(active.result.diagnostics.live, false);
        assert.equal(active.result.diagnostics.pending, 0);
        assert.equal(active.result.diagnostics.callbacks, 45);
        active.pass = true;
    } finally {
        await closeBrowser();
        active.pass &&= active.closed && !active.forcedTermination && !active.deadlineExceeded;
        active.finishedUtc = new Date().toISOString();
        fs.writeFileSync(path.join(root, 'live-result.json'), JSON.stringify(evidence, null, 2));
    }
}

try {
    mapBefore = inventory(originalMap);

    fs.writeFileSync(path.join(root, 'map-metadata-before.json'), JSON.stringify(mapBefore));

    for (const entry of mapBefore.filter((item) => /\.lotheader$|^chunkdata_-?\d+_-?\d+\.bin$|^map\.info$|^worldgenoverride\.lua$/i.test(item.name))) {
        snapshot(path.join(originalMap, entry.name));
    }

    snapshot(gameJar);
    fs.writeFileSync(path.join(root, 'PZPopMan64.dll'), snapshot(path.join(installation, 'PZPopMan64.dll')));
    snapshot(path.join(root, 'PZPopMan64.dll'));

    for (const name of ['PopulationInputs.java', 'PopulationQualification.java', 'PopulationBuffersQualification.java', 'host/port/host/PopulationBuffers.java']) {
        const target = path.join(root, 'sources', name);

        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, snapshot(path.join(source, name)));
    }

    snapshot(import.meta.filename);
    const java = ['PopulationInputs.java', 'PopulationQualification.java', 'PopulationBuffersQualification.java', 'host/port/host/PopulationBuffers.java'].map((name) => path.join(root, 'sources', name));

    fs.mkdirSync(nativeClasses);
    fs.mkdirSync(browserClasses);
    command('compile-native', 'javac', ['--release', '17', '-cp', gameJar, '-d', nativeClasses, ...java]);
    const preparation = path.join(root, 'prepare');
    const generation = inventory(path.join(installation, 'media/lua/server/WorldGen')).map((entry) => `media/lua/server/WorldGen/${entry.name}`);

    copyInputs(preparation, [...ordinaryInputs, ...generation, 'media/lua/server/metazones/BiomeMapConfig.lua', 'media/lua/server/metazones/AnimalsPathConfig.lua', 'media/lua/server/Zombies/VoronoiNoise.lua']);
    const link = path.join(preparation, 'work/media/maps/Muldraugh, KY');

    fs.mkdirSync(path.dirname(link), { recursive: true });
    assert.equal(fs.existsSync(link), false);
    fs.symlinkSync(originalMap, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(fs.realpathSync(link), fs.realpathSync(originalMap));
    assert.ok(!fs.realpathSync(path.join(preparation, 'home')).startsWith(fs.realpathSync(originalMap)));
    evidence.inputJunction = { target: fs.realpathSync(link), readOnlyEnforced: false };
    const preparedText = command('original-inputs', 'java', [`-Duser.home=${path.join(preparation, 'home')}`, '-cp', `${nativeClasses}${path.delimiter}${gameJar}`, 'PopulationInputs', preparation], path.join(preparation, 'work'), 120_000);

    assert.ok(preparedText.includes('POPULATION_INPUTS_PASS'));
    const density = snapshot(path.join(preparation, 'original-density.bin'));
    const nativeOwner = path.join(root, 'native-world');

    copyInputs(nativeOwner, [...ordinaryInputs, collisionName]);
    fs.writeFileSync(path.join(nativeOwner, 'work/original-density.bin'), density);
    assert.ok(nativePhase('native-write', nativeOwner, 'write').includes('POSITIVE_WRITER_PASS'));
    assert.ok(nativePhase('native-read', nativeOwner, 'read').includes('POSITIVE_READER_PASS'));

    const cp = [];

    for (const name of jars) {
        const target = path.join(root, name);

        fs.writeFileSync(target, snapshot(path.join(repository, 'target/browser-jvm/play', name)));
        routes.set(`/${name}`, fs.readFileSync(target));
        cp.push(target);
    }

    command('compile-browser', 'javac', ['--release', '17', '-cp', cp.join(path.delimiter), '-d', browserClasses, ...java]);
    command('archive', 'jar', ['--create', '--file', path.join(root, 'qualification.jar'), '-C', browserClasses, '.']);
    routes.set('/qualification.jar', fs.readFileSync(path.join(root, 'qualification.jar')));

    for (const name of [...ordinaryInputs, collisionName]) {
        routes.set(`/${name}`, snapshot(path.join(installation, name)));
    }

    routes.set('/original-density.bin', density);

    for (const name of ['population-natives.js', 'population-kernel.js', 'population-save-codec.js', 'unsafe-short-repair.js', 'native-library-loader.js']) {
        routes.set(`/${name}`, snapshot(path.join(source, name)));
    }

    const adapter = snapshot(path.join(source, 'PZPopMan64.js'));
    const observed = Buffer.from(adapter.toString().replace('export { population };', 'globalThis.populationQualificationService = population;\nexport { population };'));

    assert.notEqual(observed.toString(), adapter.toString());
    routes.set('/PZPopMan64.js', observed);
    evidence.adapter = { productionSHA256: digest(adapter), servedSHA256: digest(observed), observer: 'one verifier-only assignment captures exact original-loader module instance' };
    fs.writeFileSync(path.join(root, 'before-hashes.json'), JSON.stringify(Object.fromEntries(inputs), null, 2));
    server = createServer((request, response) => {
        let pathname;

        try {
            pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        } catch {
            response.writeHead(400).end();

            return;
        }

        const bytes = routes.get(pathname);

        if (!bytes || !['GET', 'HEAD'].includes(request.method)) {
            evidence.denied.push({ method: request.method, path: pathname });
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

        const type = pathname.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
        const headers = { 'Content-Type': pathname === '/' ? 'text/html' : type, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 };

        if (range) {
            headers['Content-Range'] = `bytes ${start}-${end}/${bytes.length}`;
        }

        response.writeHead(range ? 206 : 200, headers).end(request.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1));
    });
    await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    const emitted = {};

    await browserPhase('write', emitted);
    assert.equal(Object.keys(emitted).length, 4);
    const cell = decodeCell(emitted['zpop/zpop_41_40.bin']);

    assert.ok(cell.chunks.some((chunk) => chunk.records.length));
    assert.ok(decodeIDs(emitted['zpop/zpop_ids.bin']) > 1);
    assert.equal(decodeEmptyVirtual(emitted['zpop/zpop_virtual.bin']).length, 609);
    await browserPhase('read', emitted);
    const cross = path.join(root, 'native-crossread');

    copyInputs(cross, [...ordinaryInputs, collisionName]);
    fs.writeFileSync(path.join(cross, 'work/original-density.bin'), density);

    const crossreadHashes = new Map();

    for (const [name, bytes] of Object.entries(emitted)) {
        const target = path.join(cross, 'home/Zomboid/Saves/Sandbox/PopulationOracle', name);

        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, bytes);
        crossreadHashes.set(target, digest(bytes));
    }

    assert.ok(nativePhase('native-crossread', cross, 'read').includes('POSITIVE_READER_PASS'));
    assert.ok([...crossreadHashes].every(([file, before]) => digest(fs.readFileSync(file)) === before));
    evidence.crossreadFilesUnchanged = true;
    evidence.nativeCrossread = true;
    evidence.mapMetadataUnchanged = JSON.stringify(inventory(originalMap)) === JSON.stringify(mapBefore);
    assert.deepEqual(evidence.denied, []);
    evidence.pass = evidence.browsers.every((phase) => phase.pass) && evidence.mapMetadataUnchanged;
} catch (error) {
    evidence.error = String(error.stack || error);
} finally {
    if (browserServer) {
        await closeBrowser().catch((error) => {
            evidence.cleanupError = String(error);
        });
    }

    if (server) {
        server.closeAllConnections();
        await bounded(new Promise((resolve) => {
            server.close(resolve);
        }), 5_000).catch((error) => {
            evidence.cleanupError = String(error);
        });
    }

    evidence.serverClosed = !server || !server.listening;

    try {
        evidence.inputsUnchanged = [...inputs].every(([file, before]) => digest(fs.readFileSync(file)) === before);
        evidence.mapMetadataUnchanged = !mapBefore || JSON.stringify(inventory(originalMap)) === JSON.stringify(mapBefore);
    } catch (error) {
        evidence.integrityError = String(error);
    }

    evidence.finishedUtc = new Date().toISOString();
    evidence.pass &&= evidence.inputsUnchanged && evidence.mapMetadataUnchanged && evidence.serverClosed && !evidence.cleanupError && !evidence.integrityError;
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ root, pass: evidence.pass, error: evidence.error, browsers: evidence.browsers.map((phase) => ({ phase: phase.phase, pass: phase.pass, closed: phase.closed })), nativeCrossread: evidence.nativeCrossread, inputsUnchanged: evidence.inputsUnchanged, serverClosed: evidence.serverClosed }));
}

if (!evidence.pass) {
    process.exitCode = 1;
}
