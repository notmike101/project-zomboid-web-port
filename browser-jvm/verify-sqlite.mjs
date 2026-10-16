/* eslint-disable no-await-in-loop -- Fresh browser VMs and same-path persistence phases must run serially; source snapshots are bounded. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';

const { PZ_JDK: jdk, PZ_BROWSER: executablePath, PZ_GAME_JAR: gameJar } = process.env;

if (!jdk || !executablePath || !gameJar) {
    throw new Error('Set PZ_JDK, PZ_BROWSER, and PZ_GAME_JAR. Prepare the public play SDK first.');
}

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'target/browser-jvm/sqlite');
const classes = path.join(output, 'classes');
const native = path.join(output, 'native');
const source = path.join(root, 'browser-jvm/qualifications/sqlite');
const engine = path.join(root, 'node_modules/@sqlite.org/sqlite-wasm/sqlite-wasm/jswasm');
// Ordering is part of the existing qualified host SDK contract.
const sdk = ['play-entry.jar', 'animation-entry.jar', 'animation-view.jar', 'animation-sdk-view.jar', 'path-view.jar', 'float-bridge.jar', 'memory-bridge.jar', 'world-entry.jar', 'atomic-view.jar'];
const uuid = randomUUID();
const evidence = { pass: false, phases: [], denied: [], logs: [], hashes: [] };
const files = new Map();
let server;
let context;

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
 * @param {string[]} args - Literal process arguments.
 * @param {string} cwd - Working directory.
 * @returns {object} Completed process result.
 */
function command(name, args, cwd = output) {
    const result = spawnSync(path.join(jdk, 'bin', name + (process.platform === 'win32' ? '.exe' : '')), args, { cwd, encoding: 'utf8', timeout: 60_000, windowsHide: true });

    if (result.error || result.status !== 0) {
        throw new Error(`${name}: ${result.error || result.stderr || result.stdout}`);
    }

    return result;
}

/**
 * Snapshots one allowlisted file.
 *
 * @param {string} url - Local route.
 * @param {string} file - Source path.
 */
async function serve(url, file) {
    const bytes = await readFile(file);

    files.set(url, bytes);
    evidence.hashes.push({ file, before: hash(bytes) });
}

await mkdir(classes, { recursive: true });
await mkdir(native, { recursive: true });
await mkdir(path.join(output, 'sdk'), { recursive: true });

try {
    evidence.gameBefore = hash(await readFile(gameJar));

    for (const name of sdk) {
        const input = path.join(root, 'target/browser-jvm/play', name);
        const snapshot = path.join(output, 'sdk', name);
        const bytes = await readFile(input);

        await writeFile(snapshot, bytes);
        assert.equal(hash(await readFile(input)), hash(bytes));
        await serve(`/${name}`, snapshot);
    }

    const javaSources = (await readdir(source)).filter((name) => name.endsWith('.java')).map((name) => path.join(source, name));
    const helperSources = ['SqliteFiles', 'SqliteSupport'].map((name) => path.join(root, 'browser-jvm/host/port/host', `${name}.java`));

    command('javac', ['--release', '17', '-encoding', 'UTF-8', '-cp', gameJar, '-d', classes, ...helperSources, ...javaSources]);
    command('jar', ['--create', '--file', path.join(output, 'qualification.jar'), '-C', classes, '.']);
    await serve('/qualification.jar', path.join(output, 'qualification.jar'));

    for (const name of ['sqlitejdbc.js', 'sqlite-natives.js', 'sqlite-namespace.js', 'native-long-return.js', 'native-library-loader.js']) {
        await serve(`/${name}`, path.join(root, 'browser-jvm', name));
    }

    for (const name of ['sqlite3.mjs', 'sqlite3.wasm']) {
        await serve(`/${name}`, path.join(engine, name));
    }

    assert.equal(hash(files.get('/sqlite3.mjs')), '5c3247fd2b4bc9d95efc12e35b556f6967e0277465533b60b3e02fc32af053e0');
    assert.equal(hash(files.get('/sqlite3.wasm')), '456c64017447e00ffb56eb10576bf7f94e98f4a3051809ed7476fa86f62afd0c');
    const cp = ['/app/qualification.jar', ...sdk.map((name) => `/app/${name}`)].join(':');
    const entries = { jdbc: 'SqliteJdbcProbe', crud: 'AccountBrowserProbe', boundary: 'SqliteBoundaryProbe', writer: 'AccountPersistProbe', reader: 'AccountPersistProbe' };
    const callbacks = [...new Set(Object.values(entries))].map((name) => `async Java_${name}_report(lib,text){const Support=await lib.port.host.SqliteSupport;globalThis.result={...JSON.parse(String(text)),identities:await Support.identities(),failures:await Support.pendingFailures()};}`).join(',');

    files.set('/', Buffer.from(`<meta charset="utf-8"><script src="https://cjrtnc.leaningtech.com/4.3/loader.js"></script><script type="module">
        import {reserveSqliteNamespace} from '/sqlite-namespace.js';
        import {getSqliteSnapshot} from '/sqlite-natives.js';
        import {installNativeLibraryLoader} from '/native-library-loader.js';
        const phase=new URL(location.href).searchParams.get('phase'),entries=${JSON.stringify(entries)};
        try{
            await reserveSqliteNamespace();
            await cheerpjInit({version:17,status:'none',natives:{${callbacks},async Java_AccountPersistProbe_image(lib,array){globalThis.imageHex=await(await lib.port.host.SqliteSupport).hex(array);}}});
            installNativeLibraryLoader(cj3Module);
            const code=await cheerpjRunMain(entries[phase],'${cp}',phase,'${uuid}');
            if(code!==0||!globalThis.result?.pass)throw Error('Java fixture failed: '+code+' '+JSON.stringify(globalThis.result));
            globalThis.result.natives=getSqliteSnapshot();
            try{await(await import('/sqlite-namespace.js?late')).reserveSqliteNamespace();throw Error('Late namespace accepted');}catch(e){if(!String(e).includes('before initializing'))throw e;globalThis.result.lateReservationRejected=true;}
        }catch(e){globalThis.result={pass:false,error:String(e.stack||e)};}finally{globalThis.done=true;}
    </script>`));
    files.set('/lock-probe', Buffer.from(`<meta charset="utf-8"><script type="module">
        import{reserveSqliteNamespace}from'/sqlite-namespace.js';
        try{if(new URL(location.href).searchParams.has('missing'))Object.defineProperty(navigator,'locks',{value:undefined});await reserveSqliteNamespace();globalThis.probe={rejected:false};}catch(e){globalThis.probe={rejected:true,message:String(e)};}
    </script>`));
    server = createServer((request, response) => {
        const route = new URL(request.url, 'http://localhost').pathname;
        const bytes = files.get(route);

        if (!bytes || !['GET', 'HEAD'].includes(request.method)) {
            evidence.denied.push(route);
            response.writeHead(404).end();

            return;
        }

        const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
        let type = 'text/html; charset=utf-8';

        if (route.endsWith('.wasm')) {
            type = 'application/wasm';
        } else if (route.endsWith('.jar')) {
            type = 'application/java-archive';
        } else if (/\.m?js$/.test(route)) {
            type = 'text/javascript';
        }

        response.writeHead(range ? 206 : 200, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}) }).end(bytes.subarray(start, end + 1));
    });
    await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const profile = path.join(output, 'profiles', uuid);

    for (const phase of Object.keys(entries)) {
        context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, serviceWorkers: 'block' });

        try {
            await context.route('**/*', async (route) => {
                const url = new URL(route.request().url());

                if (url.origin !== origin && !(url.origin === 'https://cjrtnc.leaningtech.com' && url.pathname.startsWith('/4.3/'))) {
                    evidence.denied.push(url.href);
                    await route.abort();
                } else {
                    await route.continue();
                }
            });
            const page = context.pages()[0];

            page.on('console', (message) => evidence.logs.push({ phase, type: message.type(), text: message.text() }));
            page.on('pageerror', (error) => evidence.logs.push({ phase, type: 'pageerror', text: String(error) }));
            await page.goto(`${origin}/?phase=${phase}`);
            await page.waitForFunction(() => globalThis.done, null, { timeout: 120_000 });
            const result = await page.evaluate(() => ({ ...globalThis.result, imageHex: globalThis.imageHex }));

            if (result.imageHex) {
                const image = Buffer.from(result.imageHex, 'hex');

                await writeFile(path.join(output, `account-${phase}.db`), image);
                result.imageHash = hash(image);
                delete result.imageHex;
            }

            evidence.phases.push({ phase, ...result });
            assert.equal(result.pass, true, JSON.stringify(result));
            assert.equal(result.natives.databases, 0);
            assert.equal(result.natives.statements, 0);
            assert.equal(result.natives.workingFiles, 0);
            assert.equal(result.identities, 0);
            assert.equal(result.failures, 0);
            assert.ok(result.natives.nativeEntries >= 60);
            assert.equal(result.lateReservationRejected, true);

            if (phase === 'jdbc') {
                const other = await context.newPage();

                await other.goto(`${origin}/lock-probe`);
                await other.waitForFunction(() => globalThis.probe);
                evidence.contention = await other.evaluate(() => globalThis.probe);
                assert.equal(evidence.contention.rejected, true);
                assert.match(evidence.contention.message, /already owned/);
                await other.close();
                const missing = await context.newPage();

                await missing.goto(`${origin}/lock-probe?missing`);
                await missing.waitForFunction(() => globalThis.probe);
                evidence.missingWebLocks = await missing.evaluate(() => globalThis.probe);
                assert.equal(evidence.missingWebLocks.rejected, true);
                assert.match(evidence.missingWebLocks.message, /requires the Web Locks/);
                await missing.close();
            }
        } finally {
            await context.close();
            context = null;
        }
    }

    assert.equal(evidence.phases.at(-1).imageHash, evidence.phases.at(-2).imageHash);
    // Extract the original native driver into the qualification output only.
    command('jar', ['--extract', '--file', gameJar, 'org/sqlite/native/Windows/x86_64/sqlitejdbc.dll'], native);
    await copyFile(path.join(native, 'org/sqlite/native/Windows/x86_64/sqlitejdbc.dll'), path.join(native, 'sqlitejdbc.dll'));
    evidence.dllBefore = hash(await readFile(path.join(native, 'sqlitejdbc.dll')));
    const imagePaths = ['writer', 'reader'].map((phase) => path.join(output, `account-${phase}.db`));

    evidence.jvm = command('java', ['-Dstdout.encoding=UTF-8', `-Dorg.sqlite.lib.path=${native}`, '-Dorg.sqlite.lib.name=sqlitejdbc.dll', `-Dorg.sqlite.tmpdir=${native}`, '-cp', classes + path.delimiter + gameJar, 'PersistentImageRead', ...imagePaths]);
    evidence.dllAfter = hash(await readFile(path.join(native, 'sqlitejdbc.dll')));
    assert.equal(evidence.dllBefore, evidence.dllAfter);

    for (const [index, imagePath] of imagePaths.entries()) {
        assert.equal(hash(await readFile(imagePath)), evidence.phases[index + 3].imageHash);
    }

    assert.equal(evidence.denied.length, 0);
    assert.equal(evidence.logs.filter((row) => row.type === 'pageerror' || /Exception|Error:|SEVERE/.test(row.text)).length, 0);
    evidence.pass = true;
} catch (error) {
    evidence.error = String(error.stack || error);
} finally {
    await context?.close();
    server?.closeAllConnections();

    if (server) {
        await new Promise((resolve) => {
            server.close(resolve);
        });
    }

    evidence.closed = true;
    evidence.gameAfter = hash(await readFile(gameJar));

    if (evidence.gameBefore !== evidence.gameAfter) {
        evidence.pass = false;
    }

    for (const input of evidence.hashes) {
        input.after = hash(await readFile(input.file));

        if (input.before !== input.after) {
            evidence.pass = false;
        }
    }

    await writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
}

console.info(JSON.stringify(evidence));

if (!evidence.pass) {
    process.exitCode = 1;
}
