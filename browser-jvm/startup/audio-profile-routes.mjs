/* eslint-disable no-await-in-loop -- Keep optional SDK verification and copying sequential and bounded. */
import assert from 'node:assert/strict';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { hash } from './profile-routes.mjs';

const additions = ['/fmod-runtime.js', '/fmod-natives.js', '/fmod.js', '/fmodstudio.js', '/fmodintegration64.js',
    '/fmod-runtime/fmodstudioL.js', '/fmod-runtime/fmodstudioL.wasm', '/fmod-runtime/manifest.json', '/fmod-runtime/reverb-presets.json'];
const publicAudioUrls = ['/fmod20309-api.js', '/fmod20309-identities.js', '/fmod20309-files.js', '/fmod-owned-audio.js'];
const compressionUrls = ['/texture-compression-runtime.js', '/texture-compression/manifest.json',
    '/texture-compression/texture-compression-engine.mjs', '/texture-compression/texture-compression-engine.wasm'];

/**
 * Verifies the optional real FMOD closure before composing existing original route owners.
 *
 * @param {object} generation - New frozen generation with explicit audio runtime admission.
 * @returns {Promise<object>} Existing owners plus verified original FMOD host routes.
 */
export async function createOriginalBootRoutes(generation) {
    assert.ok(generation.audioEnabled === undefined || typeof generation.audioEnabled === 'boolean', 'audioEnabled must be an optional boolean');
    assert.ok(generation.textureCompressionEnabled === undefined || typeof generation.textureCompressionEnabled === 'boolean', 'textureCompressionEnabled must be an optional boolean');
    assert.ok(generation.textureCompressionEnabled !== true || generation.textureCompression, 'Texture compression requires an admitted encoder');

    if (generation.textureCompression !== undefined) {
        assert.match(generation.textureCompression?.manifestSHA, /^[a-f0-9]{64}$/u);
    }

    assert.match(generation.audioRuntime?.manifestSHA, /^[a-f0-9]{64}$/u);
    const optionalUrls = generation.textureCompression ? compressionUrls : [];
    const publicAudio = generation.routes.some((record) => publicAudioUrls.includes(record.url)) ? publicAudioUrls : [];
    const admittedUrls = [...additions, ...publicAudio, ...optionalUrls];
    const selected = generation.routes.filter((record) => admittedUrls.includes(record.url));

    assert.deepEqual(selected.map((record) => record.url).sort(), admittedUrls.toSorted());
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

    assert.deepEqual(admission.audioRuntime, generation.audioEnabled === false ? null : generation.audioRuntime,
        'Served audio admission must match the selected generation');
    assert.equal(admission.textureCompressionEnabled, generation.textureCompressionEnabled);
    assert.deepEqual(admission.textureCompression, generation.textureCompression);

    if (generation.textureCompression) {
        const record = selected.find((entry) => entry.url === '/texture-compression/manifest.json');

        assert.equal(record.sha256, generation.textureCompression.manifestSHA);
        const compressionManifest = JSON.parse(await readFile(record.file, 'utf8'));

        assert.equal(compressionManifest.schema, 'texture-compression-runtime-v1');

        for (const [key, url] of [['moduleSHA', compressionUrls[2]], ['wasmSHA', compressionUrls[3]], ['runtimeBridgeSHA', compressionUrls[0]]]) {
            assert.equal(compressionManifest[key], selected.find((entry) => entry.url === url).sha256);
        }
    }

    const manifestRecord = selected.find((record) => record.url === '/fmod-runtime/manifest.json');

    assert.equal(manifestRecord.sha256, generation.audioRuntime.manifestSHA);
    const manifest = JSON.parse(await readFile(manifestRecord.file, 'utf8'));

    assert.equal(manifest.schema, 'fmod-html5-runtime-v1');
    assert.equal(manifest.scriptSHA, selected.find((record) => record.url === '/fmod-runtime/fmodstudioL.js').sha256);
    assert.equal(manifest.wasmSHA, selected.find((record) => record.url === '/fmod-runtime/fmodstudioL.wasm').sha256);
    assert.equal(manifest.presetSHA, selected.find((record) => record.url === '/fmod-runtime/reverb-presets.json').sha256);
    const { createOriginalBootRoutes: createBase } = await import(generation.bullet ? './bullet-profile-routes.mjs' : './profile-routes.mjs');
    const owners = await createBase({ ...generation, routes: generation.routes.filter((record) => !admittedUrls.includes(record.url)) });

    for (const record of selected) {
        owners.routes.set(record.url, record);
    }

    return owners;
}

export { hash };
