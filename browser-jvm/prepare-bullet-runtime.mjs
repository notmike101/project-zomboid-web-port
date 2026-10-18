import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, '..');
const sourceRoot = path.join(repository, '.tools/bullet3-2c204c49');
const sdk = path.join(repository, '.tools/emsdk-3.1.74-source/emsdk-3d6d8ee910466516a53e665b86458faa81dae9ba');
const compiler = path.join(sdk, 'upstream/emscripten/emcc.py');
const exports = ['scalar_bytes', 'create_mesh', 'add_hull', 'get_aabb', 'child_count', 'point_count', 'get_point', 'clear_mesh', 'live_meshes', 'create_world', 'world_state', 'destroy_world', 'create_mapped_world', 'activate_map', 'world_header', 'deactivate_map', 'map_info', 'map_chunk', 'destroy_mapped_world', 'malloc', 'free'];

/**
 * Computes a byte-exact source or generated artifact fingerprint.
 *
 * @param {Buffer|string} bytes - Exact input bytes.
 * @returns {string} SHA-256 digest.
 */
function digest(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Verifies every pinned upstream source before and after compilation.
 *
 * @param {Array<Array<string>>} inputs - Relative paths and required hashes.
 * @returns {Promise<void>} Completion of all source checks.
 */
async function verifySources(inputs) {
    const canonicalSource = await realpath(sourceRoot);

    await Promise.all(inputs.map(async ([name, expected]) => {
        const file = await realpath(path.join(sourceRoot, name));

        if (!file.startsWith(`${canonicalSource}${path.sep}`) || digest(await readFile(file)) !== expected) {
            throw new Error(`Pinned Bullet source changed: ${name}`);
        }
    }));
}

/**
 * Creates each output component only after its parent is known to remain owned.
 *
 * @param {Array<string>} parts - Remaining relative directory components.
 * @param {string} parent - Canonical validated parent directory.
 * @param {string} target - Canonical workspace target root.
 * @returns {Promise<void>} Completion of contained directory creation.
 */
async function createOutput(parts, parent, target) {
    if (parts.length === 0) {
        return;
    }

    const directory = path.join(parent, parts[0]);

    try {
        await mkdir(directory);
    } catch (error) {
        if (error.code !== 'EEXIST') {
            throw error;
        }
    }

    const canonical = await realpath(directory);

    if (!canonical.startsWith(`${target}${path.sep}`)) {
        throw new Error('Bullet output must not escape through a junction');
    }

    await createOutput(parts.slice(1), canonical, target);
}

/**
 * Validates the existing pinned local tools and compiles the real double-precision core.
 * No source, SDK, dependency, or game asset is downloaded by this helper.
 *
 * @param {string} outputDirectory - Owned directory under the workspace target directory.
 * @returns {Promise<object>} Source and output hashes for the compiled component.
 */
export async function prepareBulletRuntime(outputDirectory) {
    const output = path.resolve(outputDirectory);
    const targetPath = path.join(repository, 'target');

    await mkdir(targetPath, { recursive: true });

    const target = await realpath(targetPath);

    if (target !== path.join(await realpath(repository), 'target')) {
        throw new Error('Bullet target directory must not escape through a junction');
    }

    if (!output.startsWith(`${path.join(repository, 'target')}${path.sep}`)) {
        throw new Error('Bullet output must be a workspace target subdirectory');
    }

    await createOutput(path.relative(targetPath, output).split(path.sep), target, target);

    if (digest(await readFile(compiler)) !== 'fa058b37c97812c47c71abf337e315e37001abe239655514459af391d988cbcd') {
        throw new Error('Pinned Emscripten 3.1.74 compiler is unavailable or changed');
    }

    const sourceManifest = JSON.parse(await readFile(path.join(import.meta.dirname, 'bullet-sources.json'), 'utf8'));
    const inputs = sourceManifest.files.map(({ file, sha256 }) => [file, sha256]).sort((left, right) => left[0].localeCompare(right[0], 'en'));

    if (digest(JSON.stringify(inputs)) !== '63048c5718d2c086889682f6f40d79f6b599b90bd029a3acfb22fc06a1455273') {
        throw new Error('Pinned Bullet source inventory changed');
    }

    await verifySources(inputs);

    const bridge = path.join(import.meta.dirname, 'bullet-engine.cpp');
    const bridgeSha = digest(await readFile(bridge));
    const cpp = inputs.filter(([name]) => name.endsWith('.cpp')).map(([name]) => path.join(sourceRoot, name));

    await execute('py', ['-3', compiler, '-std=c++17', '-O1', '-DBT_USE_DOUBLE_PRECISION', `-I${path.join(sourceRoot, 'src')}`, bridge, ...cpp,
        '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sENVIRONMENT=web,node', '-sALLOW_MEMORY_GROWTH=1',
        `-sEXPORTED_FUNCTIONS=${JSON.stringify(exports.map((name) => `_${name}`))}`, '-o', path.join(output, 'bullet-engine.mjs')],
    { env: { ...process.env, EM_CONFIG: path.join(sdk, '.emscripten') }, timeout: 180_000, maxBuffer: 4_194_304 });

    const manifest = {
        candidateCommit: '2c204c49e56ed15ec5fcfa71d199ab6d6570b3f5', candidateVersion: '3.25', installedCoreVersion: 'unknown', versionMatchVerified: false,
        compilerVersion: '3.1.74', scalarBytes: 8, bridgeSha, sources: cpp.length,
        compilerVerification: 'emcc.py SHA-256; SDK release provenance is documented separately', upstreamLicense: 'BULLET-LICENSE.txt',
        moduleSha: digest(await readFile(path.join(output, 'bullet-engine.mjs'))), wasmSha: digest(await readFile(path.join(output, 'bullet-engine.wasm'))),
    };

    if (digest(await readFile(bridge)) !== bridgeSha) {
        throw new Error('Bullet bridge changed during compilation');
    }

    await verifySources(inputs);

    await writeFile(path.join(output, 'BULLET-LICENSE.txt'), await readFile(path.join(sourceRoot, 'LICENSE.txt')));
    await writeFile(path.join(output, 'bullet-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    return manifest;
}
