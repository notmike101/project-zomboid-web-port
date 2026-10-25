/* eslint-disable no-await-in-loop -- Keep optional SDK verification and copying sequential and bounded. */
import assert from 'node:assert/strict';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { hash } from './profile-routes.mjs';

const additions = ['/fmod-runtime.js', '/fmod-natives.js', '/fmod.js', '/fmodstudio.js', '/fmodintegration64.js',
    '/fmod-runtime/fmodstudioL.js', '/fmod-runtime/fmodstudioL.wasm', '/fmod-runtime/manifest.json'];

/**
 * Verifies the optional real FMOD closure before composing existing original route owners.
 *
 * @param {object} generation - New frozen generation with explicit audio runtime admission.
 * @returns {Promise<object>} Existing owners plus verified original FMOD host routes.
 */
export async function createOriginalBootRoutes(generation) {
    assert.match(generation.audioRuntime?.manifestSHA, /^[a-f0-9]{64}$/u);
    const selected = generation.routes.filter((record) => additions.includes(record.url));

    assert.deepEqual(selected.map((record) => record.url).sort(), additions.toSorted());
    const root = await realpath(generation.root);

    for (const record of selected) {
        const file = await realpath(record.file);
        const relative = path.relative(root, file);

        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        assert.equal((await stat(file)).size, record.bytes);
        assert.equal(await hash(file), record.sha256);
    }

    const admissionRecord = generation.routes.find((record) => record.url === '/original-boot-admission.json');
    const admission = JSON.parse(await readFile(admissionRecord.file, 'utf8'));

    assert.deepEqual(admission.audioRuntime, generation.audioRuntime, 'Served audio admission must match the selected generation');
    const manifestRecord = selected.find((record) => record.url === '/fmod-runtime/manifest.json');

    assert.equal(manifestRecord.sha256, generation.audioRuntime.manifestSHA);
    const manifest = JSON.parse(await readFile(manifestRecord.file, 'utf8'));

    assert.equal(manifest.schema, 'fmod-html5-runtime-v1');
    assert.equal(manifest.scriptSHA, selected.find((record) => record.url === '/fmod-runtime/fmodstudioL.js').sha256);
    assert.equal(manifest.wasmSHA, selected.find((record) => record.url === '/fmod-runtime/fmodstudioL.wasm').sha256);
    const { createOriginalBootRoutes: createBase } = await import(generation.bullet ? './bullet-profile-routes.mjs' : './profile-routes.mjs');
    const owners = await createBase({ ...generation, routes: generation.routes.filter((record) => !additions.includes(record.url)) });

    for (const record of selected) {
        owners.routes.set(record.url, record);
    }

    return owners;
}

export { hash };
