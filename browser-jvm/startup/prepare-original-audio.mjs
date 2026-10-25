/* eslint-disable jsdoc/require-jsdoc -- This preparation CLI exposes no host callbacks. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const [sourceFile, sdk, outputArgument, jdk, bulletEngine] = process.argv.slice(2);

assert.ok(sourceFile && sdk && outputArgument && jdk,
    'Usage: node prepare-original-audio.mjs BASE_GENERATION_JSON HTML5_SDK NEW_TARGET_DIRECTORY JDK_DIRECTORY [QUALIFIED_BULLET_ENGINE_DIRECTORY]');
const source = JSON.parse(await readFile(sourceFile, 'utf8'));

assert.ok(!source.audioRuntime && !source.bullet, 'Select the base generation before optional Bullet/audio composition');
const output = path.resolve(outputArgument);
const execute = promisify(execFile);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const tool = (name) => path.join(import.meta.dirname, name);

if (bulletEngine) {
    await execute(process.execPath, [tool('prepare-real-bullet.mjs'), path.resolve(sourceFile), output, path.resolve(bulletEngine)], { timeout: 300_000 });
} else {
    await execute(process.execPath, [tool('recover.mjs'), path.resolve(sourceFile), output], { timeout: 300_000 });
}

const generationFile = path.join(output, 'generation.json');
const generation = JSON.parse(await readFile(generationFile, 'utf8'));

await execute(process.execPath, [tool('../prepare-fmod-runtime.mjs'), path.resolve(sdk), path.join(output, 'audio-sdk')], { timeout: 30_000 });
const audio = JSON.parse(await readFile(path.join(output, 'audio-sdk/audio-routes.json'), 'utf8'));

for (const record of audio.routes) {
    assert.ok(!generation.routes.some((previous) => previous.url === record.url));
}

generation.routes.push(...audio.routes);
generation.audioRuntime = audio.audioRuntime;
const admissionRecord = generation.routes.find((record) => record.url === '/original-boot-admission.json');
const admission = JSON.parse(await readFile(admissionRecord.file, 'utf8'));

admission.audioRuntime = generation.audioRuntime;
const admissionBytes = Buffer.from(JSON.stringify(admission));

await writeFile(admissionRecord.file, admissionBytes);
Object.assign(admissionRecord, { bytes: admissionBytes.length, sha256: digest(admissionBytes) });
await writeFile(generationFile, JSON.stringify(generation, null, 2));

// Rebuild only authored startup/array helpers; original archive entries stay byte-identical.
const entryFile = path.join(output, 'audio-entry.jar');

await execute(process.execPath, [tool('build-entry.mjs'), generationFile, path.resolve(jdk), entryFile], { timeout: 60_000 });
const entryRecord = generation.routes.find((record) => record.url === '/original-boot-entry.jar');
const entryBytes = await readFile(entryFile);

Object.assign(entryRecord, { file: entryFile, bytes: entryBytes.length, sha256: digest(entryBytes) });
const profile = tool('audio-profile-routes.mjs');
const profileBytes = await readFile(profile);
const profileEvidence = path.join(output, 'host-source-evidence/audio-profile-routes.mjs');

await writeFile(profileEvidence, profileBytes, { flag: 'wx' });
const oldCount = generation.hostSources.length;

generation.hostSources.push({ file: profile, evidenceFile: profileEvidence, bytes: profileBytes.length, sha256: digest(profileBytes) });
const runnerRecord = generation.hostSources.find((record) => path.basename(record.evidenceFile) === 'run.mjs');
let runner = await readFile(runnerRecord.file, 'utf8');
const before = `assert.equal(generation.hostSources.length, ${oldCount});`;

assert.ok(runner.includes(before));
runner = runner.replace(before, `assert.equal(generation.hostSources.length, ${oldCount + 1});`);
const sourceProfile = pathToFileURL(tool(bulletEngine ? 'bullet-profile-routes.mjs' : 'profile-routes.mjs')).href;

runner = runner.replaceAll(/from '\.\/([^']+)'/gu, (_match, name) => `from '${pathToFileURL(tool(name)).href}'`);
assert.ok(runner.includes(`from '${sourceProfile}'`));
runner = runner.replace(`from '${sourceProfile}'`, `from '${pathToFileURL(profile).href}'`);
const runnerFile = path.join(output, 'run-original-audio.mjs');

await writeFile(runnerFile, runner, { flag: 'wx' });
await writeFile(runnerRecord.evidenceFile, runner);
Object.assign(runnerRecord, { file: runnerFile, bytes: Buffer.byteLength(runner), sha256: digest(runner) });
await writeFile(generationFile, JSON.stringify(generation, null, 2));
console.info(JSON.stringify({ generation: generationFile, runner: runnerFile, audioRuntime: generation.audioRuntime, browserExecuted: false }));
