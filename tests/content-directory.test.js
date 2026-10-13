/** @file Synthetic-only directory provisioning privacy and startup contracts. */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { provisionContent } from '../scripts/provision-content.mjs';

const execute = promisify(execFile);
const provisionScript = fileURLToPath(new URL('../scripts/provision-content.mjs', import.meta.url));

/**
 * Create separate synthetic install/content/mod trees.
 *
 * @param {import('node:test').TestContext} t - Fixture owner.
 * @returns {Promise<{source:string,output:string,mods:string}>} Isolated directories.
 */
async function fixture(t) {
    const base = await mkdtemp(join(tmpdir(), 'pz-content-'));

    t.after(() => rm(base, { recursive: true, force: true }));

    return { source: join(base, 'install'), output: join(base, 'content'), mods: join(base, 'user-mods') };
}

/**
 * Write synthetic fixture bytes without touching user content.
 *
 * @param {string} root - Fixture root.
 * @param {string} path - Relative filename.
 * @param {string|Buffer} [bytes] - Synthetic contents.
 * @returns {Promise<void>} Resolves when written.
 */
async function put(root, path, bytes = 'synthetic-only') {
    const full = join(root, path);

    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, bytes);
}

/**
 * Supply all mandatory bounded startup paths, never native asset bytes.
 *
 * @param {string} source - Synthetic installation root.
 * @returns {Promise<void>} Resolves after fixture writes.
 */
async function startup(source) {
    await put(source, 'media/texturepacks/Tiles2x.pack');
    await put(source, 'media/texturepacks/Tiles2x.floor.pack');
    await put(source, 'media/texturepacks/Overlays2x.pack');
    await put(source, 'media/texturepacks/Overlays2x.floor.pack');
    await put(source, 'media/texturepacks/JumboTreesBigs2x.pack');
    await put(source, 'media/models_X/Skinned/MaleBody.x');
    await put(source, 'media/anims_X/Bob/Bob_Idle.x');
    await put(source, 'media/anims_X/Bob/Bob_Walk.x');
    await put(source, 'media/textures/Body/MaleBody02a.png');

    for (const [x, y] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
        // eslint-disable-next-line no-await-in-loop -- Keep fixture writes ordered.
        await put(source, `media/maps/challengemaps/Tutorial/${x}_${y}.lotheader`);
        // eslint-disable-next-line no-await-in-loop -- Keep fixture writes ordered.
        await put(source, `media/maps/challengemaps/Tutorial/world_${x}_${y}.lotpack`);
        // eslint-disable-next-line no-await-in-loop -- Keep fixture writes ordered.
        await put(source, `media/maps/challengemaps/Tutorial/chunkdata_${x}_${y}.bin`);
    }
}

test('provisioning preserves existing and original files, indexes bounded startup and B42 mods without binaries', async (t) => {
    const { source, output, mods } = await fixture(t);

    await startup(source);
    await put(source, 'stdlib.lua', '-- synthetic standard library');
    await put(source, 'ProjectZomboid64.exe', 'PRIVATE_EXECUTABLE');
    await put(source, 'media/private.jar', 'PRIVATE_JAR');
    await put(source, 'media/maps/Muldraugh, KY/map.info');
    await put(source, 'saves/player.bin', 'PRIVATE_SAVE');
    await put(output, 'media/texturepacks/Tiles2x.pack', 'existing-copy');
    await put(output, 'unrelated.txt', 'leave-alone');
    await put(mods, 'WorkshopThing/common/mod.info', 'name=Synthetic');
    await put(mods, 'WorkshopThing/42/media/lua/client/example.lua', '-- synthetic');
    await put(mods, 'WorkshopThing/42/danger.dll', 'PRIVATE_DLL');
    await put(mods, 'webmod/mod.json', '{"id":"synthetic","entry":"main.js"}');
    await put(mods, 'webmod/main.js', 'export function activate() {}');
    const manifest = await provisionContent({ source, output, modsSource: mods, hash: true });

    assert.equal(manifest.format, 'pz-web-content-directory');
    assert.equal(manifest.formatVersion, 1);
    assert.deepEqual(manifest.sourceBuild, { version: 'unknown' });
    assert.equal(manifest.startup.packs.length, 5);
    assert.deepEqual(manifest.startup.cells.map(({ x, y }) => [x, y]), [[0, 0], [0, 1], [1, 0], [1, 1]]);
    assert.equal(manifest.startup.character.texture, 'media/textures/Body/MaleBody02a.png');
    assert.deepEqual(manifest.startup.spawn, { x: 190.5, y: 190.5 });
    assert.equal(manifest.files.find(({ path }) => path === 'media/texturepacks/Tiles2x.pack').size, 13);
    assert.ok(manifest.files.every(({ path, sha256 }) => !/exe|jar|dll|saves/u.test(path) && /^[a-f0-9]{64}$/u.test(sha256)));
    assert.ok(manifest.files.some(({ path }) => path === 'stdlib.lua'));
    assert.ok(manifest.files.some(({ path }) => path === 'media/maps/Muldraugh, KY/map.info'));
    assert.deepEqual(new Set(manifest.mods.map(({ root, kind, files }) => ({ root, kind, files: new Set(files) }))), new Set([
        {
            root: 'mods/WorkshopThing', kind: 'native-lua',
            files: new Set(['mods/WorkshopThing/common/mod.info', 'mods/WorkshopThing/42/media/lua/client/example.lua']),
        },
        {
            root: 'mods/webmod', kind: 'javascript',
            files: new Set(['mods/webmod/mod.json', 'mods/webmod/main.js']),
        },
    ]));
    assert.equal(await readFile(join(output, 'media/texturepacks/Tiles2x.pack'), 'utf8'), 'existing-copy');
    assert.equal(await readFile(join(source, 'media/texturepacks/Tiles2x.pack'), 'utf8'), 'synthetic-only');
    assert.equal(await readFile(join(output, 'unrelated.txt'), 'utf8'), 'leave-alone');
    assert.deepEqual(JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8')), manifest);
    const indexed = await provisionContent({ output, indexOnly: true });

    assert.equal(indexed.files.some(({ path }) => path === 'unrelated.txt'), false);
    assert.equal(indexed.startup.cells.length, 4);
});

test('a hard-interrupted copy stays unpublished and reruns complete media and mod assets', { timeout: 20_000 }, async (t) => {
    const { source, output, mods } = await fixture(t);

    await startup(source);
    await put(output, 'unrelated.txt', 'leave-alone');
    await put(output, '.copy-user/unknown.bin', 'leave-staging-lookalikes-alone');
    await put(mods, 'Example/mod.info', 'name=Synthetic');
    const bytes = Buffer.alloc(64 * 1_024, 0x5A);

    for (const [root, sourcePath, contentPath] of [
        [source, 'media/interrupted.bin', 'media/interrupted.bin'],
        [mods, 'Example/media/interrupted.bin', 'mods/Example/media/interrupted.bin'],
    ]) {
        // eslint-disable-next-line no-await-in-loop -- Exercise both shared-copy callers independently.
        await put(root, sourcePath, bytes);
        const child = spawn(process.execPath, ['--input-type=module', '-e', `
            import fs from 'node:fs/promises';
            import { syncBuiltinESMExports } from 'node:module';
            const [moduleUrl, options, target] = process.argv.slice(1);
            const copyFile = fs.copyFile;
            fs.copyFile = async (source, destination, flags) => {
                await copyFile(source, destination, flags);
                if (source === target) {
                    // Deterministic incomplete-copy boundary: real copied bytes, no returned completion.
                    await fs.truncate(destination, 7);
                    process.send({ pending: destination });
                    await new Promise(() => {});
                }
            };
            syncBuiltinESMExports();
            const { provisionContent } = await import(moduleUrl);
            await provisionContent(JSON.parse(options));
        `, new URL('../scripts/provision-content.mjs', import.meta.url).href,
        JSON.stringify({ source, output, modsSource: mods }), join(root, sourcePath)], {
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
        const closed = once(child, 'close');
        let stderr = '';

        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (data) => {
            stderr += data;
        });
        t.after(() => child.kill('SIGKILL'));
        // eslint-disable-next-line no-await-in-loop -- Wait for the real incomplete filesystem boundary.
        const [pending] = await Promise.race([
            once(child, 'message'),
            closed.then(() => {
                throw new Error(`Copy child exited before interruption: ${stderr}`);
            }),
        ]);

        try {
            // eslint-disable-next-line no-await-in-loop -- Pending bytes must never occupy the final name.
            await assert.rejects(readFile(join(output, contentPath)), { code: 'ENOENT' });
            // eslint-disable-next-line no-await-in-loop -- The probe interrupts actual partial on-disk bytes.
            assert.equal((await stat(pending.pending)).size, 7);
        } finally {
            child.kill('SIGKILL');
            // eslint-disable-next-line no-await-in-loop -- Ensure hard interruption precedes rerunning.
            await closed;
        }

        // eslint-disable-next-line no-await-in-loop -- Restart only after the killed copier has exited.
        const manifest = await provisionContent({ source, output, modsSource: mods });

        assert.equal(manifest.files.find(({ path }) => path === contentPath).size, bytes.length);
        assert.ok(manifest.files.every(({ path }) => !path.includes('.copy-')));
        // eslint-disable-next-line no-await-in-loop -- Never delete a prior process's unindexed pending bytes.
        assert.equal((await stat(pending.pending)).size, 7);
        // eslint-disable-next-line no-await-in-loop -- Staging-shaped user directories are not ours to clean.
        assert.equal(await readFile(join(output, '.copy-user/unknown.bin'), 'utf8'), 'leave-staging-lookalikes-alone');
        // eslint-disable-next-line no-await-in-loop -- Check final bytes, not copy-call arguments.
        assert.deepEqual(await readFile(join(output, contentPath)), bytes);
        // eslint-disable-next-line no-await-in-loop -- Final copies must not hardlink the private original.
        await writeFile(join(output, contentPath), 'user-edit');
        // eslint-disable-next-line no-await-in-loop -- The original must remain independently owned.
        assert.deepEqual(await readFile(join(root, sourcePath)), bytes);
        // eslint-disable-next-line no-await-in-loop -- Unknown user files remain untouched across reruns.
        assert.equal(await readFile(join(output, 'unrelated.txt'), 'utf8'), 'leave-alone');
        // eslint-disable-next-line no-await-in-loop -- Deliberately different legitimate contents stay preserved.
        await provisionContent({ source, output, modsSource: mods });
        // eslint-disable-next-line no-await-in-loop -- Restart must retain the user's independent asset edit.
        assert.equal(await readFile(join(output, contentPath), 'utf8'), 'user-edit');
    }
});

test('provisioning rejects directory junctions, nested output and foreign manifests without private copying', async (t) => {
    const { source, output } = await fixture(t);

    await startup(source);
    await assert.rejects(provisionContent({ source, output: join(source, 'media', 'copy') }), /overlap/u);
    await assert.rejects(provisionContent({ source, output: 'dist/content' }), /separate/u);
    await assert.rejects(provisionContent({ source, output: 'release/content' }), /separate/u);
    await put(output, 'manifest.json', '{"unrelated":true}');
    await assert.rejects(provisionContent({ source, output }), /manifest/u);
    await rm(join(output, 'manifest.json'));
    const privateDir = join(dirname(source), 'private');

    await put(privateDir, 'secret.txt', 'PRIVATE_BYTES');
    await symlink(privateDir, join(source, 'media', 'linked'), 'junction');
    await assert.rejects(provisionContent({ source, output }), /link|escape/u);
    await rm(join(source, 'media', 'linked'));
    await mkdir(output, { recursive: true });
    await symlink(privateDir, join(output, 'media'), 'junction');
    await assert.rejects(provisionContent({ source, output }), /link|escape/u);
    assert.equal(await readFile(join(privateDir, 'secret.txt'), 'utf8'), 'PRIVATE_BYTES');
});

test('startup-only copying excludes unrelated media and incomplete startup fails without a manifest', async (t) => {
    const { source, output } = await fixture(t);

    await startup(source);
    await put(source, 'media/other.png');
    const manifest = await provisionContent({ source, output, startupOnly: true });

    assert.equal(manifest.files.some(({ path }) => path === 'media/other.png'), false);
    await rm(join(output, 'media/anims_X/Bob/Bob_Walk.x'));
    await rm(join(output, 'manifest.json'));
    await assert.rejects(provisionContent({ output, indexOnly: true }), /Bob_Walk/u);
    await assert.rejects(readFile(join(output, 'manifest.json')), { code: 'ENOENT' });
});

test('one CLI command provisions an automatic-startup directory without native execution', async (t) => {
    const { source, output } = await fixture(t);

    await startup(source);
    const { stdout } = await execute(process.execPath, [
        provisionScript, '--source', source, '--output', output, '--startup-only', '--source-build', 'synthetic-observed',
    ]);
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));

    assert.match(stdout, /Indexed/u);
    assert.deepEqual(manifest.sourceBuild, { version: 'synthetic-observed' });
    assert.equal(manifest.startup.cells[0].navigation, 'media/maps/challengemaps/Tutorial/chunkdata_0_0.bin');
    await execute(process.execPath, [provisionScript, '--index-only', '--output', output]);
    assert.equal(JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8')).files.length, manifest.files.length);
});

test('startup roles use original inventory case for portable static URLs on copying and indexing', async (t) => {
    const { source, output } = await fixture(t);

    await startup(source);
    await rm(join(source, 'media/anims_X/Bob/Bob_Idle.x'));
    await put(source, 'media/anims_X/Bob/Bob_Idle.X');
    const manifest = await provisionContent({ source, output, startupOnly: true });

    assert.equal(manifest.startup.character.idle, 'media/anims_X/Bob/Bob_Idle.X');
    assert.ok(manifest.files.some(({ path }) => path === manifest.startup.character.idle));
    assert.equal(new URL(manifest.startup.character.idle, 'https://example.invalid/content/').pathname, '/content/media/anims_X/Bob/Bob_Idle.X');
    assert.equal(await readFile(join(output, manifest.startup.character.idle), 'utf8'), 'synthetic-only');
    const indexed = await provisionContent({ output, indexOnly: true });

    assert.equal(indexed.startup.character.idle, 'media/anims_X/Bob/Bob_Idle.X');

    if (process.platform === 'linux') {
        await assert.rejects(readFile(join(output, 'media/anims_X/Bob/Bob_Idle.x')), { code: 'ENOENT' });
    }
});

test('case-sensitive Linux hosts reject ambiguous startup role files even when one is an exact match', { skip: process.platform !== 'linux' }, async (t) => {
    const { source, output } = await fixture(t);

    await startup(source);
    await put(source, 'media/anims_X/Bob/Bob_Idle.X');
    await assert.rejects(provisionContent({ source, output, startupOnly: true }), /ambiguous.*Bob_Idle/iu);
    await assert.rejects(readFile(join(output, 'manifest.json')), { code: 'ENOENT' });
});
