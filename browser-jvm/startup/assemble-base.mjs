import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareSchedulerRuntime } from '../prepare-scheduler-runtime.mjs';
import { generatedUrls, hash, shaderParserModules, sourceModules } from './profile-routes.mjs';

const [specificationFile, outputArgument] = process.argv.slice(2);

assert.ok(outputArgument && process.argv.length === 4,
    'Usage: node assemble-base.mjs INPUTS_JSON NEW_TARGET_DIRECTORY (jarManifest, gameRoot, sceneRoot, raknetManifest, earcutManifest, closedMedia, eagerMedia)');
const specificationPath = await realpath(specificationFile);
const specificationBytes = await readFile(specificationPath);
const specificationRecord = {
    file: specificationPath, bytes: specificationBytes.length,
    sha256: createHash('sha256').update(specificationBytes).digest('hex'),
};
const specification = JSON.parse(specificationBytes);
const source = path.resolve(import.meta.dirname, '..');
const workspace = await realpath(path.join(source, '..'));
const target = await realpath(path.join(workspace, 'target'));
const output = path.resolve(outputArgument);
const parent = await realpath(path.dirname(output));

assert.ok(target.startsWith(workspace + path.sep));
assert.ok(output.startsWith(path.join(workspace, 'target') + path.sep));
assert.ok(parent === target || parent.startsWith(target + path.sep), 'Output parent escapes canonical target');
await mkdir(output);
const routes = [];
const inputs = [];

/**
 * Identifies immutable file bytes without retaining large payloads.
 *
 * @param {string} file - Actual input file.
 * @returns {Promise<object>} File identity.
 */
async function identity(file) {
    const canonical = await realpath(file);

    return { file: canonical, bytes: (await stat(canonical)).size, sha256: await hash(canonical) };
}

/**
 * Reads and records a small input document.
 *
 * @param {string} file - Source document.
 * @returns {Promise<object>} Parsed JSON document.
 */
async function document(file) {
    const record = await identity(file);
    const bytes = await readFile(record.file);

    assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256);
    inputs.push(record);

    return JSON.parse(bytes);
}

/**
 * Freezes one small route under its actual browser URL spelling.
 *
 * @param {string} url - Absolute route URL.
 * @param {string} file - Source bytes.
 * @param {object} expected - Optional required identity.
 * @returns {Promise<object>} Frozen route record.
 */
async function route(url, file, expected = {}) {
    assert.ok(url.startsWith('/') && !url.split('/').includes('..') && !url.includes('\\'));
    assert.ok(!routes.some((record) => record.url === url), `Duplicate URL ${url}`);
    const record = await identity(file);

    if (expected.sha256) {
        assert.equal(record.sha256, expected.sha256, url);
    }

    if (expected.bytes !== undefined) {
        assert.equal(record.bytes, expected.bytes, url);
    }

    const destination = path.join(output, url.slice(1));

    await mkdir(path.dirname(destination), { recursive: true });
    const bytes = await readFile(record.file);

    assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256, file);
    await writeFile(destination, bytes, { flag: 'wx' });
    assert.equal(await hash(destination), record.sha256, 'Frozen route write differs');
    const types = {
        '.jar': 'application/java-archive', '.wasm': 'application/wasm', '.js': 'text/javascript',
        '.mjs': 'text/javascript', '.html': 'text/html',
    };
    const frozen = { ...record, url, file: destination, type: types[path.extname(url)] ?? 'text/plain' };

    routes.push(frozen);

    return frozen;
}

const jars = await document(specification.jarManifest);

assert.equal(jars.schema, 'original-startup-source-jars-v1');
assert.equal(jars.executionAdmitted, false);
assert.equal(jars.routes.length, 17);

/* eslint-disable no-await-in-loop -- Bound open files and payload memory; scene snapshots are streamed one at a time. */
for (const record of jars.inputs.filter((input) => /\.(?:java|jar)$/u.test(input.file))) {
    const current = await identity(record.file);

    assert.equal(current.bytes, record.bytes, 'Archive source changed after build');
    assert.equal(current.sha256, record.sha256, 'Archive source changed after build');
}

for (const record of jars.routes) {
    await route(record.url, record.file, record);
}

for (const name of sourceModules) {
    await route(`/${name}`, path.join(name === 'negative-stat.js' ? import.meta.dirname : source, name));
}

await import(pathToFileURL(path.join(output, 'population-natives.js')).href);
await route('/original-boot.js', path.join(import.meta.dirname, 'original-boot.js'));
const html = await route('/original-boot.html', path.join(import.meta.dirname, 'original-boot.html'));

routes.push({ ...html, url: '/' });

for (const name of shaderParserModules) {
    await route(`/node_modules/@shaderfrog/glsl-parser/${name}`, path.join(workspace, 'node_modules/@shaderfrog/glsl-parser', name));
}

// Supplied public-builder manifests retain source provenance; no old generation is an input.
for (const [kind, prefix, manifestFile] of [
    ['raknet', '/', specification.raknetManifest],
    ['earcut', '/browser-jvm/earcut/', specification.earcutManifest],
]) {
    const manifest = await document(manifestFile);

    assert.equal(manifest.compilerVersion, '3.1.74');
    assert.equal(await hash(path.join(source, `${kind}-engine.cpp`)), manifest.bridgeSha);

    if (kind === 'raknet') {
        assert.equal(await hash(path.join(source, 'raknet-sources.json')), manifest.sourceLedgerSha);
        assert.equal(await hash(path.join(source, 'rakvoice-engine.h')), manifest.voiceHeaderSha);
    } else {
        assert.equal(manifest.upstreamHeaderSha, '3b838bc3f643d34ced850b6d53b19e2d9abdf6c2c067425b02868d131379b3cc');
    }

    for (const [suffix, sha256] of [['mjs', manifest.moduleSha], ['wasm', manifest.wasmSha]]) {
        await route(`${prefix}${kind}-engine.${suffix}`, path.join(path.dirname(manifestFile), `${kind}-engine.${suffix}`), { sha256 });
    }
}

const scheduler = path.join(output, 'scheduler-runtime');
const schedulerManifest = await prepareSchedulerRuntime(scheduler);

for (const [name, sha256] of [['cj3.js', schedulerManifest.runtimeOutputSha], ['load-function.js', schedulerManifest.loaderModuleSha], ['manifest.json', undefined]]) {
    const record = await identity(path.join(scheduler, name));

    if (sha256) {
        assert.equal(record.sha256, sha256);
    }

    routes.push({ ...record, url: `/scheduler-runtime/${name}`, type: name.endsWith('.js') ? 'text/javascript' : 'application/json' });
}

for (const name of ['sqlite3.mjs', 'sqlite3.wasm']) {
    await route(`/${name}`, path.join(workspace, 'node_modules/@sqlite.org/sqlite-wasm/sqlite-wasm/jswasm', name));
}

const gameRoot = await realpath(specification.gameRoot);
const mediaRoot = await realpath(path.join(gameRoot, 'media'));
const stdlib = await identity(path.join(gameRoot, 'stdlib.lua'));

await route('/stdlib.lua', stdlib.file, stdlib);
const sceneRoot = await realpath(specification.sceneRoot);
const plan = await identity(path.join(sceneRoot, 'plan.tsv'));
const snapshotProofs = await document(path.join(sceneRoot, 'snapshot-routes.json'));
const indexRecord = await identity(path.join(sceneRoot, 'index.properties'));
const index = new Map((await readFile(indexRecord.file, 'latin1')).split(/\r?\n/u).filter(Boolean).map((line) => {
    const match = /^([^=\\]+)=([^\\]*)$/u.exec(line);

    assert.ok(match, 'Unsupported original importer index');

    return [match[1], match[2]];
}));

assert.equal(index.get('format'), 'original-jassimp-relative-flags-v1');
assert.equal(index.get('plan.sha256'), plan.sha256);
assert.equal(await hash(path.join(gameRoot, 'jassimp64.dll')), index.get('dll.sha256'));
assert.equal(snapshotProofs.length, 6_034);
assert.equal(new Set(snapshotProofs.map((record) => record.key)).size, 6_034);
assert.equal(index.size, 3 + 4 * snapshotProofs.length);
const entries = [];

for (const proof of snapshotProofs) {
    const flags = proof.flags.split(',').sort();
    const key = createHash('sha256').update(`${proof.path.toLowerCase()}|${flags.join(',')}`).digest('hex');

    assert.equal(proof.key, key);
    assert.equal(index.get(`${key}.path`), proof.path);
    assert.equal(index.get(`${key}.flags`), flags.join(','));
    assert.equal(index.get(`${key}.source`), proof.sourceSHA256);
    assert.equal(index.get(`${key}.snapshot`), proof.sha256);
    const record = await identity(path.join(sceneRoot, `${key}.ais`));

    assert.equal(record.bytes, proof.bytes);
    assert.equal(record.sha256, proof.sha256);
    routes.push({ ...record, url: `/prepared/${key}.ais`, type: 'application/octet-stream' });
    entries.push({ path: proof.path, flags, sha256: proof.sourceSHA256, snapshotIdentity: `${key}.ais` });
}

routes.push({ ...indexRecord, url: '/prepared/index.properties', type: 'text/plain' });
const listing = await identity(path.join(sceneRoot, 'whole-boot-directory-index.list'));
const listed = (await readFile(listing.file, 'utf8')).split(/\r?\n/u).filter(Boolean).sort();

assert.deepEqual(listed, [...entries.map((entry) => entry.snapshotIdentity), 'index.list', 'index.properties'].sort());

for (const url of ['/prepared/', '/prepared/index.list']) {
    routes.push({ ...listing, url, type: 'text/plain' });
}

const inventoryFile = path.join(output, 'combined-importer-inventory.json');

await writeFile(inventoryFile, JSON.stringify({ scope: 'Supplied native snapshots; browser integration unadmitted', entries }));
const closedMedia = { ...specification.closedMedia, snapshotParent: await realpath(specification.closedMedia.snapshotParent ?? tmpdir()) };
const closedMediaInputs = [];

for (const prefix of ['namespace', 'certificate', 'ledger']) {
    const record = await identity(closedMedia[`${prefix}File`]);

    assert.equal(record.sha256, closedMedia[`${prefix}SHA256`]);
    closedMedia[`${prefix}File`] = record.file;
    closedMediaInputs.push(record);
}

const media = JSON.parse(await readFile(closedMedia.ledgerFile, 'utf8'));
const mediaByPath = new Map(media.map((entry) => [entry.path.toLowerCase(), entry]));

assert.equal(mediaByPath.size, media.length, 'Ambiguous source ledger paths');

for (const entry of entries) {
    assert.ok(entry.path.startsWith('media/') && !entry.path.split('/').includes('..'));
    assert.equal(mediaByPath.get(entry.path.slice(6).toLowerCase())?.sha256, entry.sha256, 'Scene source differs from installed ledger');
}

for (const protectedRoot of [gameRoot, sceneRoot, output]) {
    const relative = path.relative(protectedRoot, closedMedia.snapshotParent);

    assert.ok(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), 'Snapshot parent must be outside immutable inputs');
}

await route('/media-negative-certificate.json', closedMedia.certificateFile, { sha256: closedMedia.certificateSHA256 });
assert.equal(specification.eagerMedia.schema, 'same-owner-eager-metadata-v1');
const hostSources = [];

for (const name of ['run.mjs', 'profile-routes.mjs', 'network-observer.mjs', 'closed-media.mjs', 'certify-published.mjs',
    'map-four.mjs', 'persistent-play.mjs', 'memory-guard.mjs', 'memory-watch.ps1', '../file-watch-service.mjs', '../media-files.mjs']) {
    const record = await identity(path.resolve(import.meta.dirname, name));
    const evidenceFile = path.join(output, 'host-source-evidence', path.basename(name));

    await mkdir(path.dirname(evidenceFile), { recursive: true });
    await writeFile(evidenceFile, await readFile(record.file), { flag: 'wx' });
    assert.equal(await hash(evidenceFile), record.sha256, 'Host evidence write differs');
    hostSources.push({ ...record, evidenceFile });
}

const admission = { scope: 'original-frontend-setup', executionAdmitted: false, classpath: jars.classpath };
const admissionFile = path.join(output, 'original-boot-admission.json');

await writeFile(admissionFile, JSON.stringify(admission));
routes.push({ ...await identity(admissionFile), url: '/original-boot-admission.json', type: 'application/json' });
const names = [...new Set(['media', ...routes.filter((record) => record.url !== '/').map((record) => record.url.split('/')[1])])].sort();
const rootListing = path.join(output, 'index.list');

await writeFile(rootListing, `${names.join('\n\n')}\n`);
routes.push({ ...await identity(rootListing), url: '/index.list', type: 'text/plain' });
assert.ok(generatedUrls.every((url) => routes.some((record) => record.url === url)));
const generation = {
    ...admission, root: output, mediaRoot, routes, hostSources, closedMedia, closedMediaInputs, media,
    mediaLedger: { file: closedMedia.ledgerFile, sha256: closedMedia.ledgerSHA256, files: media.length, bytes: media.reduce((sum, record) => sum + record.bytes, 0) },
    eagerMedia: specification.eagerMedia, rootSourceInputs: [{ ...stdlib, url: '/stdlib.lua', type: 'text/plain' }],
    importer: {
        root: sceneRoot, inventoryFile, inventorySha256: await hash(inventoryFile), planSha256: plan.sha256,
        indexSha256: indexRecord.sha256, dllSha256: index.get('dll.sha256'), snapshots: entries.length,
        snapshotBytes: snapshotProofs.reduce((sum, record) => sum + record.bytes, 0), browserModelManagerQualified: false,
    },
    sourceAssembly: {
        specification: specificationRecord, componentInputs: inputs, archiveManifest: await identity(specification.jarManifest),
        maintainedSources: await Promise.all([import.meta.filename, path.join(source, 'prepare-scheduler-runtime.mjs'),
            path.join(source, 'prepare-raknet-runtime.mjs'), path.join(source, 'prepare-earcut-runtime.mjs')].map(identity)),
    },
    missing: ['Root review and explicit matching generation/served admission', 'Actual full original startup qualification', 'Required real Bullet composition and optional audio selection'],
    browserExecuted: false, serverStarted: false, originalInitializersExecuted: false,
};

assert.deepEqual(await identity(specificationPath), specificationRecord, 'Assembly specification changed during preparation');
await writeFile(path.join(output, 'generation.json'), JSON.stringify(generation, null, 2));
console.info(JSON.stringify({ output, routes: routes.length, snapshots: entries.length, executionAdmitted: false }));
/* eslint-enable no-await-in-loop */
