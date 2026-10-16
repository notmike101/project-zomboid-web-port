/**
 * @file Real filesystem regressions for canonical content roots and privacy boundaries.
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const serveScript = fileURLToPath(new URL('../scripts/serve.mjs', import.meta.url));

/**
 * Write synthetic bytes under one fixture directory.
 *
 * @param {string} path - Absolute fixture file path.
 * @returns {Promise<void>} Resolves after writing the fixture.
 */
async function put(path) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '0123456789');
}

/**
 * Start the actual preview script under its fixture's teardown ownership.
 *
 * @param {string} root - Application working directory.
 * @param {string} content - Selected CONTENT_ROOT spelling.
 * @param {{child?:import('node:child_process').ChildProcess}} owner - Fixture owning the process.
 * @returns {Promise<string>} Ready server origin.
 */
async function preview(root, content, owner) {
    const child = spawn(process.execPath, [serveScript], {
        cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: '0', CONTENT_ROOT: content },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    owner.child = child;
    let output = '';

    for await (const chunk of child.stdout.iterator({ destroyOnReturn: false })) {
        output += chunk.toString();
        const match = /Preview (http:\/\/\S+)/u.exec(output);

        if (match) {
            return match[1];
        }
    }

    throw new Error(`Preview exited before announcing its address: ${output}`);
}

/**
 * Create an isolated canonical fixture, without inheriting a temporary-directory symlink.
 *
 * @param {import('node:test').TestContext} context - Owning test.
 * @returns {Promise<{fixture:string,root:string,content:string,child?:import('node:child_process').ChildProcess}>} Owned fixture and process.
 */
async function fixtureFor(context) {
    const fixture = await mkdtemp(join(await realpath(tmpdir()), 'pz-content-root-'));
    const root = join(fixture, 'app');
    const content = join(fixture, 'approved-content');
    const owner = { fixture, root, content, child: undefined };

    context.after(async () => {
        const { child } = owner;

        if (child) {
            if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
                const exited = once(child, 'exit');

                child.kill('SIGKILL');
                await exited;
            }

            child.stdout.destroy();
            child.stderr.destroy();
        }

        await rm(fixture, { recursive: true, force: true });
    });

    await put(join(root, 'dist', 'index.html'));
    await put(join(content, 'media', 'example.pack'));

    return owner;
}

test('canonical content roots serve exact ranges and refuse escaped files and forbidden paths', { timeout: 15_000 }, async (t) => {
    const owner = await fixtureFor(t);
    const { fixture, root, content } = owner;
    const outside = join(fixture, 'private');

    await put(join(outside, 'secret.pack'));
    await symlink(outside, join(content, 'media', 'linked'), 'junction');
    await put(join(content, 'media', 'private.jar'));
    await put(join(content, 'ProjectZomboid64.exe'));
    await put(join(content, 'saves', 'player.bin'));
    const base = await preview(root, content, owner);
    const response = await fetch(`${base}/content/media/example.pack`, { headers: { Range: 'bytes=2-5' } });

    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(response.headers.get('content-length'), '4');
    assert.equal(await response.text(), '2345');

    for (const path of ['media/linked/secret.pack', 'media/private.jar', 'ProjectZomboid64.exe', 'saves/player.bin', '%2e%2e%2fprivate%2fsecret.pack']) {
        // eslint-disable-next-line no-await-in-loop -- Each privacy rejection exercises an independent real request.
        const rejected = await fetch(`${base}/content/${path}`);

        assert.equal(rejected.status, 404, path);
        // eslint-disable-next-line no-await-in-loop -- Drain the rejected response before the next request.
        await rejected.arrayBuffer();
    }
});

test('content roots reject selected and ancestor junctions and both canonical dist overlaps', { timeout: 15_000 }, async (t) => {
    for (const scenario of ['selected-junction', 'ancestor-junction', 'inside-dist', 'contains-dist', 'dist-junction']) {
        // eslint-disable-next-line no-await-in-loop -- Isolate each filesystem layout and server process.
        await t.test(scenario, async (context) => {
            const owner = await fixtureFor(context);
            const { fixture, root, content } = owner;
            let selected = content;

            switch (scenario) {
                case 'selected-junction': {
                    selected = join(fixture, 'linked-content');
                    await symlink(content, selected, 'junction');

                    break;
                }
                case 'ancestor-junction': {
                    const alias = join(fixture, 'linked-parent');

                    await symlink(fixture, alias, 'junction');
                    selected = join(alias, 'approved-content');

                    break;
                }
                case 'inside-dist': {
                    selected = join(root, 'dist', 'approved-content');
                    await put(join(selected, 'media', 'example.pack'));

                    break;
                }
                case 'contains-dist': {
                    selected = fixture;
                    await put(join(selected, 'media', 'example.pack'));

                    break;
                }

                default: {
                    await rm(join(root, 'dist'), { recursive: true, force: true });
                    await symlink(content, join(root, 'dist'), 'junction');
                }
            }

            const base = await preview(root, selected, owner);
            const response = await fetch(`${base}/content/media/example.pack`, { headers: { Range: 'bytes=2-5' } });

            assert.equal(response.status, 404);
            assert.equal(await response.text(), '');
        });
    }
});

test('Windows short-name CONTENT_ROOT aliases serve the same exact byte range', { timeout: 15_000, skip: process.platform !== 'win32' }, async (t) => {
    const owner = await fixtureFor(t);
    const { root, content } = owner;
    const result = spawnSync('cmd.exe', ['/d', '/s', '/c', `for %I in ("${content}") do @echo %~fsI`], {
        encoding: 'utf8', windowsVerbatimArguments: true,
    });

    assert.equal(result.status, 0, result.stderr);
    const alias = result.stdout.trim();
    const canonical = await realpath(content);

    if (resolve(alias).toLowerCase() === canonical.toLowerCase()) {
        t.skip('The fixture volume has no available 8.3 short-name alias');

        return;
    }

    assert.equal((await realpath(alias)).toLowerCase(), canonical.toLowerCase());
    const base = await preview(root, alias, owner);
    const response = await fetch(`${base}/content/media/example.pack`, { headers: { Range: 'bytes=2-5' } });

    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(response.headers.get('content-length'), '4');
    assert.equal(await response.text(), '2345');
});
