import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, '..');
const sourceRoot = path.join(repository, '.tools/earcut-4811a2b6');
const sdk = path.join(repository, '.tools/emsdk-3.1.74-source/emsdk-3d6d8ee910466516a53e665b86458faa81dae9ba');
const compiler = path.join(sdk, 'upstream/emscripten/emcc.py');
const pins = new Map([
    ['earcut.hpp', '3b838bc3f643d34ced850b6d53b19e2d9abdf6c2c067425b02868d131379b3cc'],
    ['LICENSE', '828f2aed51b6526881a236758ec9b08cd69928fbfc70346d9d44a0b3a3444fe1'],
]);

/**
 * Fingerprints an exact source or generated artifact.
 *
 * @param {Buffer|string} bytes - Actual file bytes.
 * @returns {string} SHA-256 digest.
 */
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Checks the canonical upstream files against the fixed source identities.
 *
 * @returns {Promise<void>} Completion after all source checks.
 */
async function verifySources() {
    const canonical = await realpath(sourceRoot);

    if (canonical !== path.join(await realpath(repository), '.tools/earcut-4811a2b6')) {
        throw new Error('Earcut source directory escapes the workspace');
    }

    await Promise.all([...pins].map(async ([name, expected]) => {
        const file = await realpath(path.join(sourceRoot, name));

        if (!file.startsWith(`${canonical}${path.sep}`) || digest(await readFile(file)) !== expected) {
            throw new Error(`Pinned Earcut source changed: ${name}`);
        }
    }));
}

/**
 * Creates one contained directory at a time, rejecting junction escapes before descending.
 *
 * @param {string[]} parts - Remaining output path components.
 * @param {string} parent - Existing canonical parent.
 * @param {string} target - Canonical workspace target root.
 * @returns {Promise<void>} Completion of validated directory creation.
 */
async function createOutput(parts, parent, target) {
    if (parts.length === 0) {
        return;
    }

    const directory = path.join(parent, parts[0]);

    await mkdir(directory).catch((error) => {
        if (error.code !== 'EEXIST') {
            throw error;
        }
    });
    const canonical = await realpath(directory);

    if (!canonical.startsWith(`${target}${path.sep}`)) {
        throw new Error('Earcut output escapes through a junction');
    }

    await createOutput(parts.slice(1), canonical, target);
}

/**
 * Builds the pinned upstream triangulator using the existing local SDK; downloads nothing.
 *
 * @param {string} outputDirectory - Owned workspace target subdirectory.
 * @returns {Promise<object>} Actual source, compiler and generated-artifact identities.
 */
export async function prepareEarcutRuntime(outputDirectory) {
    const output = path.resolve(outputDirectory);
    const targetPath = path.join(repository, 'target');

    if (!output.startsWith(`${targetPath}${path.sep}`)) {
        throw new Error('Earcut output must be a workspace target subdirectory');
    }

    await verifySources();

    if (digest(await readFile(compiler)) !== 'fa058b37c97812c47c71abf337e315e37001abe239655514459af391d988cbcd') {
        throw new Error('Pinned Emscripten 3.1.74 compiler changed or is unavailable');
    }

    const ledgerBytes = await readFile(path.join(import.meta.dirname, 'earcut-sources.json'));
    const ledger = JSON.parse(ledgerBytes);

    if (ledger.version !== '2.2.4' || ledger.upstream !== 'mapbox/earcut.hpp' || ledger.commit !== '4811a2b69b91f6127a75e780de6e2113609ddabb' || ledger.files.length !== 2
        || !ledger.files.every(({ file, sha256 }) => pins.get(file) === sha256)) {
        throw new Error('Earcut source ledger changed');
    }

    const bridge = path.join(import.meta.dirname, 'earcut-engine.cpp');
    const bridgeSha = digest(await readFile(bridge));

    await mkdir(targetPath, { recursive: true });
    const target = await realpath(targetPath);

    if (target !== path.join(await realpath(repository), 'target')) {
        throw new Error('Earcut target escapes through a junction');
    }

    await createOutput(path.relative(targetPath, output).split(path.sep), target, target);
    await Promise.all(['earcut-engine.mjs', 'earcut-engine.wasm', 'EARCUT-LICENSE.txt', 'earcut-manifest.json'].map(async (name) => {
        const file = path.join(output, name);
        const status = await lstat(file).catch((error) => {
            if (error.code !== 'ENOENT') {
                throw error;
            }

            return undefined;
        });

        if (status && (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1)) {
            throw new Error('Earcut output file must not alias another owner');
        }
    }));
    await execute('py', ['-3', compiler, '-std=c++17', '-O2', `-I${sourceRoot}`, bridge,
        '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sENVIRONMENT=web,node', '-sALLOW_MEMORY_GROWTH=1',
        '-sEXPORTED_FUNCTIONS=["_triangulate","_malloc","_free"]', '-o', path.join(output, 'earcut-engine.mjs')],
    { env: { ...process.env, EM_CONFIG: path.join(sdk, '.emscripten') }, timeout: 60_000, maxBuffer: 4_194_304, windowsHide: true });
    await verifySources();

    if (digest(await readFile(bridge)) !== bridgeSha || digest(await readFile(path.join(import.meta.dirname, 'earcut-sources.json'))) !== digest(ledgerBytes)) {
        throw new Error('Earcut build sources changed during compilation');
    }

    const manifest = {
        candidateVersion: ledger.version, candidateCommit: ledger.commit, installedVersion: 'unknown', versionMatchVerified: false,
        compilerVersion: '3.1.74', compilerVerification: 'emcc.py SHA-256; existing SDK required', bridgeSha,
        upstreamHeaderSha: pins.get('earcut.hpp'), upstreamLicenseSha: pins.get('LICENSE'),
        moduleSha: digest(await readFile(path.join(output, 'earcut-engine.mjs'))), wasmSha: digest(await readFile(path.join(output, 'earcut-engine.wasm'))),
    };

    await writeFile(path.join(output, 'EARCUT-LICENSE.txt'), await readFile(path.join(sourceRoot, 'LICENSE')));
    await writeFile(path.join(output, 'earcut-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    return manifest;
}
