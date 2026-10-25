import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { prepareBulletRuntime } from '../prepare-bullet-runtime.mjs';

const [sourceGeneration, outputArgument, engineArgument] = process.argv.slice(2);

assert.ok(sourceGeneration && outputArgument, 'Usage: node prepare-real-bullet.mjs GENERATION_JSON NEW_TARGET_DIRECTORY [VEHICLE_ENGINE_DIRECTORY]');
const output = path.resolve(outputArgument);
const execute = promisify(execFile);
/**
 * Binds one copied source or compiled artifact to its exact bytes.
 *
 * @param {Buffer|string} bytes - Original captured bytes.
 * @returns {string} SHA-256 identity.
 */
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Existing recovery rejects an existing output and copies only recorded, immutable inputs.
await execute(process.execPath, [path.join(import.meta.dirname, 'recover.mjs'), path.resolve(sourceGeneration), output], { timeout: 300_000 });
const generationFile = path.join(output, 'generation.json');
const generation = JSON.parse(await readFile(generationFile, 'utf8'));
const engine = engineArgument ? path.resolve(engineArgument) : path.join(output, 'bullet-engine');
const manifest = engineArgument
    ? JSON.parse(await readFile(path.join(engine, 'bullet-manifest.json'), 'utf8'))
    : await prepareBulletRuntime(engine, { profile: 'vehicle' });

assert.equal(manifest.profile, 'vehicle');
assert.equal(manifest.scalarBytes, 8);
assert.equal(manifest.compilerVersion, '3.1.74');
assert.equal(manifest.bridgeSha, digest(await readFile(path.join(import.meta.dirname, '../bullet-vehicle-engine.cpp'))));
assert.equal(manifest.ragdollTemplateSha, digest(await readFile(path.join(import.meta.dirname, '../bullet-ragdoll-template.h'))));
assert.equal(manifest.ragdollBodySha, digest(await readFile(path.join(import.meta.dirname, '../bullet-ragdoll-body.h'))));
assert.equal(manifest.ragdollActionsSha, digest(await readFile(path.join(import.meta.dirname, '../bullet-ragdoll-actions.h'))));
assert.equal(manifest.ragdollReadbackSha, digest(await readFile(path.join(import.meta.dirname, '../bullet-ragdoll-readback.h'))));
assert.equal(manifest.sourceInventorySha, '63048c5718d2c086889682f6f40d79f6b599b90bd029a3acfb22fc06a1455273');
assert.equal(manifest.solverOverlay.overlaySha, '2a79dede1585b30244f86201202a53af14255999add3cbc16e0914456ed4012d');
assert.equal(manifest.capsuleOverlay.originalSha, 'a5ca083fd8eaa1a5c7343cbd79d7bdeec52b85c680e492ecec1d9cb3917c02e5');
assert.equal(manifest.capsuleOverlay.overlaySha, '9cf066a92ff92625041e871e0b049dc4a19e245734cc41f70cf0205651ba35f3');

for (const [url, source, expected] of [
    ['/bullet-startup.js', path.join(import.meta.dirname, '../bullet-startup.js')],
    ['/bullet-natives.js', path.join(import.meta.dirname, '../bullet-natives.js')],
    ['/bullet-vehicle-natives.js', path.join(import.meta.dirname, '../bullet-vehicle-natives.js')],
    ['/PZBullet64.js', path.join(import.meta.dirname, '../PZBulletStartup64.js')],
    ['/bullet-engine.mjs', path.join(engine, 'bullet-engine.mjs'), manifest.moduleSha],
    ['/bullet-engine.wasm', path.join(engine, 'bullet-engine.wasm'), manifest.wasmSha],
]) {
    assert.equal(generation.routes.some((record) => record.url === url), false, `Existing Bullet route ${url}`);
    // eslint-disable-next-line no-await-in-loop -- Freeze one immutable new route at a time.
    const bytes = await readFile(source);
    const sha256 = digest(bytes);

    if (expected) {
        assert.equal(sha256, expected, source);
    }

    const file = path.join(output, url.slice(1));

    // eslint-disable-next-line no-await-in-loop -- Each destination belongs to the new generation.
    await writeFile(file, bytes, { flag: 'wx' });
    generation.routes.push({ url, file, source, bytes: bytes.length, sha256, type: url.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' });
}

const entry = generation.routes.find((record) => record.url === '/original-boot.js');
let source = (await readFile(entry.file, 'utf8'));
const importBefore = 'import { createBrowserPhysics } from \'./browser-physics.js\';';
const ownerBefore = 'const physics = createBrowserPhysics();';

assert.equal(source.split(importBefore).length, 2);
assert.equal(source.split(ownerBefore).length, 2);
source = source.replace(importBefore, 'import { createBrowserPhysics } from \'./bullet-startup.js\';').replace(ownerBefore, 'const physics = await createBrowserPhysics();');
await writeFile(entry.file, source);
Object.assign(entry, { bytes: Buffer.byteLength(source), sha256: digest(source) });
const manifestFile = path.join(output, 'bullet-manifest.json');

await copyFile(path.join(engine, 'bullet-manifest.json'), manifestFile);
generation.bullet = { profile: 'vehicle', bridgeSha: manifest.bridgeSha, manifest: manifestFile, manifestSha: digest(await readFile(manifestFile)) };

// A derivative runner selects the extra routes without editing the current startup owner.
const runnerFile = path.join(output, 'run-real-bullet.mjs');
let runner = await readFile(path.join(import.meta.dirname, 'run.mjs'), 'utf8');

assert.ok(runner.includes('assert.equal(generation.hostSources.length, 11);'));
runner = runner.replace('assert.equal(generation.hostSources.length, 11);', 'assert.equal(generation.hostSources.length, 13);');
runner = runner.replaceAll(/from '\.\/([^']+)'/gu, (_match, name) => `from '${pathToFileURL(path.join(import.meta.dirname, name === 'profile-routes.mjs' ? 'bullet-profile-routes.mjs' : name)).href}'`);
const cleanup = 'assert.equal(result.afterDispose?.physics.dynamicBodies.objects, 0);';

assert.ok(runner.includes(cleanup));
runner = runner.replace(cleanup, `${cleanup}\n    assert.equal(result.afterDispose?.physics.realBullet.world, null);\n    assert.equal(result.afterDispose?.physics.realBullet.liveMeshes, 0);`);
await writeFile(runnerFile, runner, { flag: 'wx' });
const runnerRecord = generation.hostSources.find((record) => path.basename(record.file) === 'run.mjs');

assert.ok(runnerRecord);
Object.assign(runnerRecord, { file: runnerFile, bytes: Buffer.byteLength(runner), sha256: digest(runner) });
await writeFile(runnerRecord.evidenceFile, runner);

for (const file of [path.join(import.meta.dirname, 'bullet-profile-routes.mjs'), manifestFile]) {
    // eslint-disable-next-line no-await-in-loop -- Bind both extra inputs into the existing final immutable audit.
    const bytes = await readFile(file);
    const evidenceFile = path.join(output, 'host-source-evidence', path.basename(file));

    // eslint-disable-next-line no-await-in-loop -- Freeze each extra host input before publishing the generation.
    await writeFile(evidenceFile, bytes, { flag: 'wx' });
    generation.hostSources.push({ file, evidenceFile, bytes: bytes.length, sha256: digest(bytes) });
}

await writeFile(generationFile, `${JSON.stringify(generation, null, 2)}\n`);
console.info(JSON.stringify({ generation: generationFile, runner: runnerFile, profile: 'vehicle', browserExecuted: false }));
