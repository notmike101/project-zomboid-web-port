import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { prepareBulletRuntime } from './prepare-bullet-runtime.mjs';
import { prepareSchedulerRuntime } from './prepare-scheduler-runtime.mjs';

const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, '..');
const jars = ['animation-entry.jar', 'animation-view.jar', 'animation-sdk-view.jar', 'path-view.jar', 'float-bridge.jar', 'memory-bridge.jar', 'world-entry.jar', 'atomic-view.jar'];

/**
 * Computes a byte-exact input fingerprint.
 *
 * @param {Buffer|string} bytes - Actual bytes.
 * @returns {string} SHA-256 digest.
 */
function digest(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Prepares an explicit vehicle qualification without starting Java, WASM or a browser.
 * Caller supplies owned local original-derived fixtures; none ship in the repository.
 *
 * @param {object} options - Explicit local inputs.
 * @param {string} options.outputDirectory - Existing owned target subdirectory.
 * @param {string} options.gameDirectory - Installed input directory; read only.
 * @param {string} options.sdkDirectory - Existing prepared original SDK archives.
 * @param {string} options.fixtureDirectory - Hash-manifest-bound local references and binary inputs.
 * @param {string} options.jdkDirectory - JDK25 compiler and archive tools.
 * @param {string} [options.engineDirectory] - Optional existing matching vehicle-profile artifact.
 * @returns {Promise<object>} Immutable served-file and source manifests.
 */
export async function prepareBulletVehicleQualification({ outputDirectory, gameDirectory, sdkDirectory, fixtureDirectory, jdkDirectory, engineDirectory }) {
    for (const directory of [outputDirectory, gameDirectory, sdkDirectory, fixtureDirectory, jdkDirectory, ...(engineDirectory ? [engineDirectory] : [])]) {
        assert.ok(typeof directory === 'string' && path.isAbsolute(directory), 'Qualification input paths must be absolute');
    }

    const output = await realpath(outputDirectory);
    const target = await realpath(path.join(repository, 'target'));

    if (target !== path.join(await realpath(repository), 'target') || !output.startsWith(`${target}${path.sep}`)) {
        throw new Error('Vehicle qualification output must be an existing contained target subdirectory');
    }

    assert.deepEqual(await readdir(output), [], 'Qualification generation must start in a fresh empty owned directory');

    const inputs = {};
    const staged = {};

    /**
     * Binds an actual input and optionally copies it to an explicit immutable route.
     *
     * @param {string} file - Actual source path.
     * @param {string} [route] - Fixed same-origin route.
     * @returns {Promise<Buffer>} Exact source bytes.
     */
    async function capture(file, route) {
        const bytes = await readFile(file);

        inputs[file] = digest(bytes);

        if (route) {
            const destination = path.join(output, route.slice(1));

            await mkdir(path.dirname(destination), { recursive: true });
            await writeFile(destination, bytes);
            staged[route] = digest(bytes);
        }

        return bytes;
    }

    const upstream = JSON.parse((await capture(path.join(import.meta.dirname, 'bullet-sources.json'))).toString()).files;

    assert.equal(upstream.length, 397);
    await Promise.all(upstream.map(async ({ file, sha256 }) => {
        assert.equal(digest(await capture(path.join(repository, '.tools/bullet3-2c204c49', file))), sha256);
    }));
    const bridgeSha = digest(await capture(path.join(import.meta.dirname, 'bullet-vehicle-engine.cpp')));
    const patchSha = digest(await capture(path.join(import.meta.dirname, 'bullet-vehicle-warmstart.patch')));
    const gameJar = path.join(gameDirectory, 'projectzomboid.jar');
    const jarSha = digest(await capture(gameJar));
    const dllSha = digest(await capture(path.join(gameDirectory, 'PZBullet64.dll')));

    assert.equal(jarSha, 'e1a69eb743ede60b213a0fe7f8b83d4fcab773036d256cc4543a336f3b058a33');
    assert.equal(dllSha, '76141df900f08ef71c0808bcd6248c929c47b8c5900b86af4875131a780897ef');
    const fixtures = JSON.parse((await capture(path.join(fixtureDirectory, 'fixtures-manifest.json'))).toString());

    assert.equal(fixtures.installedJarSHA256, jarSha);
    assert.equal(fixtures.installedDllSHA256, dllSha);
    await Promise.all(['carnormal-original.bin', 'chunk-packet.bin', 'vehicle-native.json', 'foundation-native.json'].map(async (name) => {
        const bytes = await capture(path.join(fixtureDirectory, name), `/${name}`);

        assert.equal(digest(bytes), fixtures.files[name], `Original-derived fixture changed: ${name}`);
    }));

    const engine = engineDirectory ?? output;
    const manifest = engineDirectory
        ? JSON.parse((await capture(path.join(engine, 'bullet-manifest.json'))).toString())
        : await prepareBulletRuntime(output, { profile: 'vehicle' });

    assert.equal(manifest.profile, 'vehicle');
    assert.equal(manifest.bridgeSha, bridgeSha);
    assert.equal(manifest.solverOverlay.patchSha, patchSha);
    assert.equal(manifest.solverOverlay.overlaySha, '60b2b900e7d43187443f636429acb19acaa436e2b4bbc79018f2ca28f103b456');
    assert.equal(manifest.solverOverlay.headerSha, '3b0ffd801b3aeb630de963ea7e22893e585314bf3eb5fee49cb28c2c3e618f56');
    assert.equal(manifest.solverOverlay.originalSha, '5b0a5553fbf0aa3c57fd9af431775613f0a6c7da46a7efe78443d1eb2563daa6');
    assert.equal(manifest.sources, 153);
    assert.equal(manifest.sourceInventorySha, '63048c5718d2c086889682f6f40d79f6b599b90bd029a3acfb22fc06a1455273');
    assert.equal(manifest.solverOverlay.replacements, 1);
    assert.equal(manifest.compilerSha, 'fa058b37c97812c47c71abf337e315e37001abe239655514459af391d988cbcd');
    assert.equal(manifest.scalarBytes, 8);
    assert.equal(manifest.compilerVersion, '3.1.74');
    assert.equal(manifest.candidateCommit, '2c204c49e56ed15ec5fcfa71d199ab6d6570b3f5');
    await Promise.all([['bullet-engine.mjs', manifest.moduleSha], ['bullet-engine.wasm', manifest.wasmSha]].map(async ([name, expected]) => {
        assert.equal(digest(await capture(path.join(engine, name), `/${name}`)), expected);
    }));

    const classes = path.join(output, `classes-${randomUUID()}`);
    const javac = path.join(jdkDirectory, 'bin/javac.exe');
    const jar = path.join(jdkDirectory, 'bin/jar.exe');
    const javaSources = ['BulletQualification.java', 'VehicleContactQualification.java'];

    await mkdir(classes);
    await Promise.all([capture(javac), capture(jar), ...javaSources.map((name) => capture(path.join(import.meta.dirname, name)))]);
    await execute(javac, ['--release', '17', '-cp', gameJar, '-d', classes, ...javaSources.map((name) => path.join(import.meta.dirname, name))], { timeout: 30_000 });
    await execute(jar, ['--create', '--file', path.join(output, 'probe.jar'), '-C', classes, '.'], { timeout: 30_000 });
    await capture(path.join(output, 'probe.jar'), '/probe.jar');
    await Promise.all(jars.map((name) => capture(path.join(sdkDirectory, name), `/${name}`)));

    const listings = await Promise.all(jars.map(async (name) => {
        const result = await execute(jar, ['tf', path.join(sdkDirectory, name)], { timeout: 30_000, maxBuffer: 16_777_216 });

        return result.stdout.split(/\r?\n/u);
    }));
    const audit = await Promise.all(['zombie/core/physics/Bullet.class', 'zombie/iso/IsoCell.class', 'zombie/iso/WorldReuserThread.class'].map(async (className) => {
        const selected = jars[listings.findIndex((listing) => listing.includes(className))];

        assert.ok(selected, `Original class is absent from prepared SDK: ${className}`);
        const originalDirectory = path.join(classes, `original-${randomUUID()}`);
        const preparedDirectory = path.join(classes, `prepared-${randomUUID()}`);

        await Promise.all([mkdir(originalDirectory), mkdir(preparedDirectory)]);
        await Promise.all([
            execute(jar, ['xf', gameJar, className], { cwd: originalDirectory, timeout: 30_000 }),
            execute(jar, ['xf', path.join(sdkDirectory, selected), className], { cwd: preparedDirectory, timeout: 30_000 }),
        ]);
        const [original, prepared] = await Promise.all([readFile(path.join(originalDirectory, className)), readFile(path.join(preparedDirectory, className))]);

        assert.deepEqual(Buffer.concat([original.subarray(0, 6), original.subarray(8)]), Buffer.concat([prepared.subarray(0, 6), prepared.subarray(8)]));

        return { className, selected, originalMajor: original.readUInt16BE(6), preparedMajor: prepared.readUInt16BE(6), bodyExact: true };
    }));

    await writeFile(path.join(output, 'class-audit.json'), JSON.stringify(audit, null, 2));
    await prepareSchedulerRuntime(path.join(output, 'scheduler-runtime'));
    await Promise.all(['manifest.json', 'cj3.js', 'load-function.js'].map((name) => capture(path.join(output, 'scheduler-runtime', name), `/scheduler-runtime/${name}`)));
    await Promise.all(['bullet-natives.js', 'bullet-vehicle-natives.js', 'native-library-loader.js', 'scheduler-runtime.js', 'unsafe-short-repair.js'].map((name) => capture(path.join(import.meta.dirname, name), `/${name}`)));
    const directCalls = new Set();

    const hostSources = await Promise.all(['bullet-natives.js', 'bullet-vehicle-natives.js'].map((name) => readFile(path.join(import.meta.dirname, name))));

    for (const bytes of hostSources) {
        const source = bytes.toString();

        for (const match of source.matchAll(/engine\.(_[a-z_]+)\(/gu)) {
            directCalls.add(match[1].slice(1));
        }
    }

    assert.ok(Array.from(directCalls).every((name) => manifest.exports.includes(name)), 'Vehicle artifact must export every actual host engine call');
    const productionModule = await capture(path.join(import.meta.dirname, 'PZBulletVehicle64.js'));
    const observedModule = Buffer.concat([productionModule, Buffer.from('\nglobalThis.bulletQualificationBackend = bullet;\n')]);

    await writeFile(path.join(output, 'PZBullet64.js'), observedModule);
    staged['/PZBullet64.js'] = digest(observedModule);
    await capture(import.meta.filename);
    await capture(path.join(import.meta.dirname, 'prepare-bullet-runtime.mjs'));
    await capture(path.join(import.meta.dirname, 'verify-bullet-vehicle.mjs'));
    await Promise.all(Object.entries(inputs).map(async ([file, expected]) => {
        assert.equal(digest(await readFile(file)), expected, `Source changed during preparation: ${file}`);
    }));
    await writeFile(path.join(output, 'source-inputs.json'), JSON.stringify(inputs, null, 2));
    await writeFile(path.join(output, 'staged-inputs.json'), JSON.stringify(staged, null, 2));

    return { output, sourceInputs: Object.keys(inputs).length, stagedInputs: Object.keys(staged).length, engine: manifest, classAudit: audit, observer: { productionSha: digest(productionModule), servedSha: digest(observedModule) } };
}
