/* eslint-disable no-await-in-loop -- Validate and copy one bounded artifact at a time. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, cp, lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hash } from './profile-routes.mjs';

const [sourceArgument, routesArgument, outputArgument] = process.argv.slice(2);

assert.ok(sourceArgument && routesArgument && outputArgument,
    'Usage: node prepare-original-texture-compression.mjs GENERATION_JSON COMPRESSION_ROUTES_JSON NEW_TARGET_DIRECTORY');
const sourceFile = await realpath(sourceArgument);
const source = JSON.parse(await readFile(sourceFile, 'utf8'));
const specification = JSON.parse(await readFile(routesArgument, 'utf8'));
const originalRoot = await realpath(source.root);
const output = path.resolve(outputArgument);
const target = await realpath(path.resolve(import.meta.dirname, '../../target'));
const urls = ['/texture-compression-runtime.js', '/texture-compression/manifest.json',
    '/texture-compression/texture-compression-engine.mjs', '/texture-compression/texture-compression-engine.wasm'];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

assert.ok(output.startsWith(`${target}${path.sep}`), 'Output must stay inside target');
assert.equal(await realpath(path.dirname(output)), path.dirname(output), 'Output parent must already exist without aliases');
assert.equal(await stat(output).then(() => true, (error) => {
    if (error.code !== 'ENOENT') throw error;
    return false;
}), false, 'Output must be new');
assert.ok(source.audioRuntime, 'Connected audio-profile generation required, including disabled-audio generations');
assert.ok(source.textureCompressionEnabled === undefined || typeof source.textureCompressionEnabled === 'boolean');
assert.match(specification.textureCompression?.manifestSHA, /^[a-f0-9]{64}$/u);
assert.deepEqual(specification.routes.map((record) => record.url).sort(), urls.toSorted());
assert.ok(!source.routes.some((record) => urls.includes(record.url)), 'Select a generation without an existing compression closure');

// Admit every selected file before creating the output; no source or original archive is modified.
for (const record of [...source.routes.filter((entry) => !entry.url.startsWith('/prepared/')), ...source.hostSources, ...specification.routes]) {
    assert.ok(Number.isSafeInteger(record.bytes) && record.bytes >= 0);
    assert.match(record.sha256, /^[a-f0-9]{64}$/u);
    const file = await realpath(record.file);

    assert.equal((await stat(file)).size, record.bytes, file);
    assert.equal(await hash(file), record.sha256, file);
}
const manifestRecord = specification.routes.find((record) => record.url === urls[1]);

assert.equal(manifestRecord.sha256, specification.textureCompression.manifestSHA);
const manifest = JSON.parse(await readFile(manifestRecord.file, 'utf8'));

assert.equal(manifest.schema, 'texture-compression-runtime-v1');
for (const [key, url] of [['runtimeBridgeSHA', urls[0]], ['moduleSHA', urls[2]], ['wasmSHA', urls[3]]]) {
    assert.equal(manifest[key], specification.routes.find((record) => record.url === url).sha256);
}
const admissionRecord = source.routes.find((record) => record.url === '/original-boot-admission.json');
const listingRecord = source.routes.find((record) => record.url === '/index.list');

assert.ok(admissionRecord && listingRecord);
assert.ok(source.hostSources.some((record) => path.basename(record.evidenceFile) === 'audio-profile-routes.mjs'), 'Connected audio profile required');
assert.ok(source.routes.some((record) => record.url === '/original-boot.js'), 'Connected boot consumer required');
assert.ok(source.routes.some((record) => record.url === '/sprite-webgl.js'), 'Connected graphics consumer required');
const admission = JSON.parse(await readFile(admissionRecord.file, 'utf8'));

assert.deepEqual(admission.audioRuntime, source.audioEnabled === false ? null : source.audioRuntime);
for (const record of source.routes.filter((entry) => !entry.url.startsWith('/prepared/'))) {
    const relative = path.relative(originalRoot, await realpath(record.file));

    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), record.url);
}
let copiedBytes = 0;
const directories = [originalRoot];

while (directories.length) {
    const directory = directories.pop();

    for (const name of await readdir(directory)) {
        const file = path.join(directory, name);
        const info = await lstat(file);

        assert.ok(!info.isSymbolicLink(), 'Generation copy must not traverse links');
        if (info.isDirectory()) directories.push(file);
        else copiedBytes += info.size;
        assert.ok(copiedBytes <= 4 * 1_024 ** 3, 'Generation contains large media/snapshots; keep those externally owned');
    }
}
// Retain the connected runner layout and external certified snapshot references unchanged.
await cp(originalRoot, output, { recursive: true, errorOnExist: true, force: false });
const relocate = (value) => {
    if (typeof value === 'string') return value.startsWith(originalRoot + path.sep) ? output + value.slice(originalRoot.length) : value;
    if (Array.isArray(value)) return value.map(relocate);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, relocate(entry)]));
    return value;
};
const generation = relocate(source);

for (const name of ['original-boot.js', 'sprite-webgl.js', 'audio-profile-routes.mjs']) {
    const bytes = await readFile(path.join(import.meta.dirname, name === 'sprite-webgl.js' ? '../sprite-webgl.js' : name));
    const record = name.endsWith('.js')
        ? generation.routes.find((entry) => entry.url === `/${name}`)
        : generation.hostSources.find((entry) => path.basename(entry.evidenceFile) === name);

    assert.ok(record, `Connected generation missing ${name}`);
    if (name === 'audio-profile-routes.mjs') {
        record.file = path.join(output, name);
        record.evidenceFile = path.join(output, 'host-source-evidence', name);
    }
    for (const file of [record.file, record.evidenceFile].filter(Boolean)) {
        assert.ok(file.startsWith(output + path.sep), 'Mutated record must be owned by the new generation');
        await mkdir(path.dirname(file), { recursive: true });
    }
    await writeFile(record.file, bytes);
    if (record.evidenceFile && record.evidenceFile !== record.file) await writeFile(record.evidenceFile, bytes);
    Object.assign(record, { bytes: bytes.length, sha256: digest(bytes) });
}

for (const record of specification.routes) {
    const destination = path.join(output, record.url.slice(1));

    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(record.file, destination);
    generation.routes.push({ ...record, file: destination });
}
generation.root = output;
generation.textureCompression = specification.textureCompression;
admission.textureCompression = generation.textureCompression;
if (generation.textureCompressionEnabled !== undefined) {
    admission.textureCompressionEnabled = generation.textureCompressionEnabled;
}
generation.executionAdmitted = false;
admission.executionAdmitted = false;
for (const [url, bytes] of [
    ['/original-boot-admission.json', Buffer.from(JSON.stringify(admission))],
    ['/index.list', Buffer.from(`${[...new Set((await readFile(listingRecord.file, 'utf8')).split(/\r?\n/u).filter(Boolean)
        .concat(urls.map((url) => url.split('/')[1])))].sort().join('\n\n')}\n`)],
]) {
    const record = generation.routes.find((entry) => entry.url === url);

    await writeFile(record.file, bytes);
    Object.assign(record, { bytes: bytes.length, sha256: digest(bytes) });
}
generation.compressionPreparedFrom = { file: sourceFile, sha256: await hash(sourceFile) };
const generationFile = path.join(output, 'generation.json');

await writeFile(generationFile, JSON.stringify(generation, null, 2));
console.info(JSON.stringify({ generation: generationFile, browserExecuted: false,
    pending: 'Bind the qualified graphics/entry archives before execution; current boot consumer and audio-profile wrapper are bound.' }));
