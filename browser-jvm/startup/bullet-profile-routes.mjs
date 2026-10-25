import assert from 'node:assert/strict';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createOriginalBootRoutes as createBaseRoutes, hash } from './profile-routes.mjs';

const additions = ['/bullet-startup.js', '/bullet-natives.js', '/bullet-vehicle-natives.js', '/bullet-engine.mjs', '/bullet-engine.wasm', '/PZBullet64.js'];

/**
 * Adds only the explicitly selected, immutable real Bullet closure to the original route owner.
 *
 * @param {object} generation - A new generation prepared with the real vehicle engine.
 * @returns {Promise<object>} The original owners and verified additional routes.
 */
export async function createOriginalBootRoutes(generation) {
    assert.equal(generation.bullet?.profile, 'vehicle');
    const selected = generation.routes.filter((record) => additions.includes(record.url));

    assert.deepEqual(selected.map((record) => record.url).sort(), additions.toSorted());
    const root = await realpath(generation.root);

    await Promise.all(selected.map(async (record) => {
        const file = await realpath(record.file);
        const relative = path.relative(root, file);

        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        assert.equal((await stat(file)).size, record.bytes);
        assert.equal(await hash(file), record.sha256);
    }));

    const manifest = JSON.parse(await readFile(generation.bullet.manifest, 'utf8'));

    assert.equal(manifest.profile, 'vehicle');
    assert.equal(manifest.bridgeSha, generation.bullet.bridgeSha);
    assert.equal(manifest.moduleSha, selected.find((record) => record.url === '/bullet-engine.mjs').sha256);
    assert.equal(manifest.wasmSha, selected.find((record) => record.url === '/bullet-engine.wasm').sha256);
    const owners = await createBaseRoutes({ ...generation, routes: generation.routes.filter((record) => !additions.includes(record.url)) });

    for (const record of selected) {
        owners.routes.set(record.url, record);
    }

    return owners;
}

export { hash };
