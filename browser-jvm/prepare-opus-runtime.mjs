import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repository = path.resolve(import.meta.dirname, '..');
const source = path.join(repository, '.tools/opus-1.3.1');
const sdk = path.join(repository, '.tools/emsdk-3.1.74-source/emsdk-3d6d8ee910466516a53e665b86458faa81dae9ba');
/**
 * Computes the exact source identity.
 *
 * @param {Buffer} bytes - Source bytes.
 * @returns {string} SHA256 identity.
 */
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Builds the pinned genuine Opus library with the source-qualified mono voice parameters.
 *
 * @param {string} directory - Fresh target output directory.
 * @returns {Promise<object>} Source and generated binary identities.
 */
export async function prepareOpusRuntime(directory) {
    if (await realpath(repository) !== repository) {
        throw new Error('Opus workspace aliases another directory');
    }

    const targetPath = path.join(repository, 'target');
    const target = await realpath(targetPath);
    const output = path.resolve(directory);

    if (target !== targetPath || !output.startsWith(`${target}${path.sep}`)) {
        throw new Error('Opus output must remain inside the workspace target');
    }

    const parent = path.dirname(output);
    const parentInfo = await lstat(parent);

    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || await realpath(parent) !== parent) {
        throw new Error('Opus output parent aliases another directory');
    }

    await mkdir(output);

    if (await realpath(output) !== output) {
        throw new Error('Opus output aliases another directory');
    }

    const ledgerFile = path.join(import.meta.dirname, 'opus-sources.json');
    const ledgerBytes = await readFile(ledgerFile);
    const ledger = JSON.parse(ledgerBytes);
    const bridge = path.join(import.meta.dirname, 'opus-engine.c');
    const bridgeSha = hash(await readFile(bridge));
    const compiler = path.join(sdk, 'upstream/emscripten/emcc.py');

    if (hash(ledgerBytes) !== '8124e2e65fa5f0b38fc6057885dd2bfa3bc20e245b27d5b36b59f43523dfb819'
        || ledger.archiveSha !== '65b58e1e25b2a114157014736a3d9dfeaad8d41be1c8179866f144a2fb44ff9d'
        || hash(await readFile(compiler)) !== 'fa058b37c97812c47c71abf337e315e37001abe239655514459af391d988cbcd') {
        throw new Error('Pinned Opus release/compiler changed');
    }

    const canonical = await realpath(source);

    if (canonical !== source) {
        throw new Error('Opus source aliases another directory');
    }

    /**
     * Checks every pinned source and authored build input before and after compilation.
     *
     * @returns {Promise<void>} Completion after exact identity verification.
     */
    const verify = async () => {
        await Promise.all(ledger.files.map(async (file) => {
            const candidate = path.resolve(source, file.name);

            if (!candidate.startsWith(`${source}${path.sep}`) || await realpath(candidate) !== candidate
                || hash(await readFile(candidate)) !== file.sha256) {
                throw new Error(`Pinned Opus source changed: ${file.name}`);
            }
        }));

        if (hash(await readFile(bridge)) !== bridgeSha || hash(await readFile(ledgerFile)) !== hash(ledgerBytes)) {
            throw new Error('Opus authored build input changed');
        }
    };

    await verify();

    const license = await readFile(path.join(import.meta.dirname, 'OPUS-LICENSE.txt'));

    if (hash(license) !== '8338ce8d922bb4416ce3dd1e5680173332435e3f0755007ac7801ccd674fe682') {
        throw new Error('Pinned Opus license changed');
    }

    if (ledger.sources.some((name) => !ledger.files.some((file) => file.name === name))) {
        throw new Error('Unpinned Opus translation unit');
    }

    const exports = ['voice_codec_create', 'voice_codec_destroy', 'voice_codec_encode', 'voice_codec_decode', 'malloc', 'free'];
    const arguments_ = ['-3', compiler, '-O2', '-DOPUS_BUILD', '-DUSE_ALLOCA', '-DHAVE_LRINTF', '-DHAVE_LRINT',
        ...['include', 'celt', 'silk', 'silk/float'].map((name) => `-I${path.join(source, name)}`), bridge,
        ...ledger.sources.map((name) => path.join(source, name)), '-sMODULARIZE=1', '-sEXPORT_ES6=1',
        '-sENVIRONMENT=web,node', '-sALLOW_MEMORY_GROWTH=1', `-sEXPORTED_FUNCTIONS=${JSON.stringify(exports.map((name) => `_${name}`))}`,
        '-o', path.join(output, 'opus-engine.mjs')];
    const result = await execute('py', arguments_, { env: { ...process.env, EM_CONFIG: path.join(sdk, '.emscripten') }, timeout: 180_000, maxBuffer: 4_194_304, windowsHide: true });

    await verify();
    await writeFile(path.join(output, 'opus-build.log'), `${result.stdout}\n${result.stderr}`);

    const manifest = {
        version: ledger.version, originalCodecVersionVerified: false, archiveSha: ledger.archiveSha,
        sourceLedgerSha: hash(ledgerBytes), bridgeSha, licenseSha: hash(license), compilerVersion: '3.1.74', arguments: arguments_,
        moduleSha: hash(await readFile(path.join(output, 'opus-engine.mjs'))),
        wasmSha: hash(await readFile(path.join(output, 'opus-engine.wasm'))),
    };

    await writeFile(path.join(output, 'OPUS-LICENSE.txt'), license);
    await writeFile(path.join(output, 'opus-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    return manifest;
}
