/**
 * @file Delivery boundary tests: staging copies only approved real files, and the
 * preview server refuses anything whose real path leaves its root.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { applicationFiles, stageApplication } from '../scripts/build.mjs';

const serveScript = fileURLToPath(new URL('../scripts/serve.mjs', import.meta.url));
const secretBytes = 'SYNTHETIC_PRIVACY_PROBE_ONLY';
const approvedHtml = '<!doctype html>approved index';
const approvedWasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 3, 2, 1, 0, 7, 10, 1, 6, 97, 110, 115, 119, 101, 114, 0, 0, 10, 6, 1, 4, 0, 65, 42, 11]);

/**
 * Create an isolated application root beside a private directory outside it.
 *
 * @param {import('node:test').TestContext} context - Test that owns the tree.
 * @returns {Promise<{ root: string, outside: string }>} Fixture directory paths.
 */
async function makeFixture(context) {
    const base = await mkdtemp(join(tmpdir(), 'pz-delivery-'));
    const root = join(base, 'app');
    const outside = join(base, 'private');

    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    context.after(() => rm(base, { recursive: true, force: true }));

    return { outside, root };
}

/**
 * Write one fixture file, creating its parent directory.
 *
 * @param {string} root - Tree root the relative path is resolved against.
 * @param {string} path - Slash-separated path inside the tree.
 * @param {string|Uint8Array} contents - File contents.
 * @returns {Promise<void>} Resolves once the file exists.
 */
async function put(root, path, contents) {
    const full = join(root, path);

    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents);
}

/**
 * List every real file below one directory, relative to the tree root.
 *
 * @param {string} root - Tree root reported against.
 * @param {string} directory - Directory being walked.
 * @returns {Promise<string[]>} Sorted slash-separated file paths.
 */
async function listFiles(root, directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const found = await Promise.all(entries.map((entry) => walkEntry(root, join(directory, entry.name), entry)));

    return found.flat().sort();
}

/**
 * Report the files one directory entry contributes, never following links.
 *
 * @param {string} root - Tree root reported against.
 * @param {string} full - Absolute path of the entry.
 * @param {import('node:fs').Dirent} entry - Entry being classified.
 * @returns {Promise<string[]>|string[]} Relative file paths, empty for links.
 */
function walkEntry(root, full, entry) {
    if (entry.isSymbolicLink()) {
        return [];
    }

    if (entry.isDirectory()) {
        return listFiles(root, full);
    }

    return [full.slice(root.length + 1).replaceAll('\\', '/')];
}

/**
 * Point one path inside a tree at a directory outside it.
 *
 * @param {string} target - Directory outside the tree that must never be delivered.
 * @param {string} link - Path that becomes the junction or link.
 * @returns {Promise<void>} Resolves once the link exists.
 */
async function makeOutsideLink(target, link) {
    await symlink(target, link, 'junction');
}

/**
 * Write every approved application source into the fixture root.
 *
 * @param {string} root - Fixture root to write into.
 * @returns {Promise<void>} Resolves once all approved sources exist.
 */
async function writeSources(root) {
    await Promise.all(applicationFiles.map((file) => put(root, file.source, `// ${file.source}\n`)));
}

/**
 * Re-supply the `src/` sources only outside the root, leaving the root copy deleted.
 *
 * @param {string} root - Fixture root whose `src/` tree is removed.
 * @param {string} outside - Private directory standing in for the escaped source.
 * @returns {Promise<void>} Resolves once `src/` lives only outside the root.
 */
async function moveSourcesOutside(root, outside) {
    await rm(join(root, 'src'), { recursive: true, force: true });
    await Promise.all(applicationFiles.filter((file) => file.source.startsWith('src/')).map((file) => put(outside, file.source, secretBytes)));
}

test('the staged tree holds exactly the approved application files', async (t) => {
    const { root } = await makeFixture(t);
    const expected = [...applicationFiles.map((file) => file.target), 'dist/build.json'].sort();

    await writeSources(root);
    await put(root, 'mods/accessible-walking/saves/player.json', `{"note":"${secretBytes}"}`);
    await put(root, 'mods/accessible-walking/media/icon.png', secretBytes);
    await put(root, 'src/notes.txt', secretBytes);
    await put(root, 'engine/target/wasm32-unknown-unknown/debug/pz_engine.wasm', secretBytes);
    await stageApplication(root);

    assert.deepEqual(await listFiles(root, join(root, 'dist')), expected);
});

test('an ancestor junction cannot deliver a private source file', async (t) => {
    const { outside, root } = await makeFixture(t);

    await writeSources(root);
    await moveSourcesOutside(root, outside);
    await makeOutsideLink(join(outside, 'src'), join(root, 'src'));
    await assert.rejects(stageApplication(root), /outside the checkout|non-regular source/u);

    const shipped = await listFiles(root, join(root, 'dist'));
    const bodies = await Promise.all(shipped.map((path) => readFile(join(root, path))));

    assert.equal(shipped.some((path) => path.startsWith('dist/src/')), false);
    assert.equal(bodies.some((body) => body.includes(secretBytes)), false);
});

test('a selected symbolic link cannot deliver a private file', async (t) => {
    const { outside, root } = await makeFixture(t);

    await writeSources(root);
    await put(outside, 'index.html', secretBytes);

    try {
        await rm(join(root, 'index.html'));
        await symlink(join(outside, 'index.html'), join(root, 'index.html'));
    } catch {
        t.skip('this host forbids unprivileged file symbolic links');

        return;
    }

    await assert.rejects(stageApplication(root), /outside the checkout|non-regular source/u);
});

/**
 * Read the preview server readiness line and report the address it really bound.
 *
 * @param {import('node:child_process').ChildProcess} child - Running server process.
 * @returns {Promise<string>} `host:port` from the readiness log.
 */
async function readAddress(child) {
    let logged = '';

    for await (const chunk of child.stdout.iterator({ destroyOnReturn: false })) {
        logged += chunk;

        const announced = logged.split('\n').find((line) => line.startsWith('Preview http://'));

        if (announced !== undefined) {
            return announced.slice('Preview http://'.length).split(' ')[0];
        }
    }

    throw new Error(`preview server exited before announcing an address: ${logged}`);
}

/**
 * Report the status code one URL gets from the preview server.
 *
 * @param {string} url - Absolute request URL.
 * @returns {Promise<number>} Response status code.
 */
async function statusOf(url) {
    const response = await fetch(url);

    await response.arrayBuffer();

    return response.status;
}

test('the preview server stays inside dist and never follows a link out', { timeout: 15_000 }, async (t) => {
    const fixture = await mkdtemp(join(tmpdir(), 'pz-server-'));
    const root = join(fixture, 'app');
    const outside = join(fixture, 'private');

    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    const child = spawn(process.execPath, [serveScript], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });

    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit', { signal: AbortSignal.timeout(3_000) });

            child.kill('SIGKILL');
            await exited;
        }

        child.stdout.destroy();
        child.stderr.destroy();
        await rm(fixture, { recursive: true, force: true });
    });

    const address = await readAddress(child);
    const base = `http://${address}/`;

    assert.match(address, /^127\.0\.0\.1:\d+$/u, 'the preview binds loopback only');
    assert.equal(await statusOf(`${base}index.html`), 404, 'an absent dist is refused per request');

    await put(root, 'dist/index.html', approvedHtml);
    await put(root, 'dist/engine/pz_engine.wasm', approvedWasm);
    await put(outside, 'secret.txt', secretBytes);
    await makeOutsideLink(outside, join(root, 'dist', 'privacy-probe'));

    const index = await fetch(base);
    const wasm = await fetch(`${base}engine/pz_engine.wasm`);
    const head = await fetch(`${base}engine/pz_engine.wasm`, { method: 'HEAD' });

    assert.equal(index.status, 200);
    assert.equal(index.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal((await index.text()).startsWith('<!doctype html>'), true);
    const module = await WebAssembly.instantiate(await wasm.arrayBuffer());

    assert.equal(module.instance.exports.answer(), 42);
    assert.equal(wasm.headers.get('content-type'), 'application/wasm');
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), 'application/wasm');
    assert.equal(await head.text(), '');
    assert.equal(await statusOf(`${base}privacy-probe/secret.txt`), 404, 'a link out of dist is refused');
    assert.equal(await statusOf(`${base}%2e%2e%2fprivate%2fsecret.txt`), 404, 'encoded traversal is refused');
    assert.equal(await statusOf(`${base}missing.js`), 404);
});
