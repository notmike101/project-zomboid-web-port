/* eslint-disable jsdoc/require-jsdoc -- Preparation CLI; no runtime host callbacks. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const repository = path.resolve(import.meta.dirname, '..');
const sdk = path.join(repository, '.tools/emsdk-3.1.74-source/emsdk-3d6d8ee910466516a53e665b86458faa81dae9ba');
const compiler = path.join(sdk, 'upstream/emscripten/emcc.py');
const compilerSHA = 'fa058b37c97812c47c71abf337e315e37001abe239655514459af391d988cbcd';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const execute = promisify(execFile);
const output = path.resolve(process.argv[2] ?? '');
const target = await realpath(path.join(repository, 'target'));
const parent = await realpath(path.dirname(output));

assert.ok(process.argv[2] && process.argv.length === 3, 'Usage: node prepare-texture-compression.mjs NEW_TARGET_DIRECTORY');
assert.equal(target, path.join(await realpath(repository), 'target'));
assert.ok(output.startsWith(`${target}${path.sep}`) && (parent === target || parent.startsWith(`${target}${path.sep}`)), 'Output escapes owned target');
const ledgerFile = path.join(import.meta.dirname, 'texture-compression-sources.json');
const ledgerBytes = await readFile(ledgerFile);
const ledger = JSON.parse(ledgerBytes);

assert.equal(ledger.upstream, 'nothings/stb');
assert.equal(ledger.commit, '003501f6d7a8668ce8b6d875e34dd97ad0d5d5b5');
const pins = new Map([
    ['stb_dxt.h', '807667ef98e0fd749cdb65cca0c2d980bc148109d2fed6f1873c81ae0f449933'],
    ['LICENSE', 'bebfe904b14301657e4e5d655c811d51fd31b97c455b9cc2d8600d6bac6cff63'],
]);

assert.equal(ledger.files.length, pins.size);
const source = await realpath(path.join(repository, ledger.sourceRoot));

assert.equal(source, path.join(await realpath(repository), '.tools/stb-003501f6'));
await Promise.all(ledger.files.map(async (record) => {
    assert.equal(record.sha256, pins.get(record.file));
    assert.equal(digest(await readFile(path.join(source, record.file))), record.sha256);
}));

assert.equal(digest(await readFile(compiler)), compilerSHA);
const bridge = path.join(import.meta.dirname, 'texture-compression-engine.cpp');
const bridgeBytes = await readFile(bridge);
const runtimeFile = path.join(import.meta.dirname, 'texture-compression-runtime.js');
const runtimeBytes = await readFile(runtimeFile);

await mkdir(output); // Fresh directory only; canonical parent was checked before any write.
await execute('py', ['-3', compiler, '-std=c++17', '-O2', `-I${source}`, bridge,
    '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sENVIRONMENT=web,node', '-sALLOW_MEMORY_GROWTH=1',
    '-sSTACK_SIZE=65536', '-sINITIAL_MEMORY=2097152', '-sMAXIMUM_MEMORY=8388608',
    '-sEXPORTED_FUNCTIONS=["_tc_encode_row","_malloc","_free"]',
    '-o', path.join(output, 'texture-compression-engine.mjs')],
{ env: { ...process.env, EM_CONFIG: path.join(sdk, '.emscripten') }, timeout: 60_000, maxBuffer: 1_048_576, windowsHide: true });
assert.equal(digest(await readFile(bridge)), digest(bridgeBytes));
assert.equal(digest(await readFile(runtimeFile)), digest(runtimeBytes));
assert.equal(digest(await readFile(ledgerFile)), digest(ledgerBytes));
await Promise.all([...pins].map(async ([file, expected]) => {
    assert.equal(digest(await readFile(path.join(source, file))), expected);
}));
const moduleBytes = await readFile(path.join(output, 'texture-compression-engine.mjs'));
const wasmBytes = await readFile(path.join(output, 'texture-compression-engine.wasm'));
const manifest = {
    schema: 'texture-compression-runtime-v1', upstream: ledger.upstream, commit: ledger.commit,
    compilerSHA, bridgeSHA: digest(bridgeBytes), headerSHA: pins.get('stb_dxt.h'), licenseSHA: pins.get('LICENSE'),
    runtimeBridgeSHA: digest(runtimeBytes), moduleSHA: digest(moduleBytes), wasmSHA: digest(wasmBytes),
    format: 'BC3/DXT5', encoderMode: 'STB_DXT_HIGHQUAL', scratchRows: 4, executionAdmitted: false,
};
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);

await writeFile(path.join(output, 'manifest.json'), manifestBytes, { flag: 'wx' });
await writeFile(path.join(output, 'STB-LICENSE.txt'), await readFile(path.join(source, 'LICENSE')), { flag: 'wx' });
await writeFile(path.join(output, 'texture-compression-runtime.js'), runtimeBytes, { flag: 'wx' });
const routes = [
    { url: '/texture-compression-runtime.js', file: path.join(output, 'texture-compression-runtime.js'), data: runtimeBytes },
    { url: '/texture-compression/manifest.json', file: path.join(output, 'manifest.json'), data: manifestBytes },
    { url: '/texture-compression/texture-compression-engine.mjs', file: path.join(output, 'texture-compression-engine.mjs'), data: moduleBytes },
    { url: '/texture-compression/texture-compression-engine.wasm', file: path.join(output, 'texture-compression-engine.wasm'), data: wasmBytes },
].map(({ url, file, data }) => ({
    url, file, bytes: data.length, sha256: digest(data),
    type: url.endsWith('.wasm') ? 'application/wasm' : url.endsWith('.json') ? 'application/json' : 'text/javascript',
}));
const result = { textureCompression: { manifestSHA: digest(manifestBytes) }, routes };

await writeFile(path.join(output, 'texture-compression-routes.json'), JSON.stringify(result, null, 2));
console.info(JSON.stringify({ output, ...result.textureCompression, browserExecuted: false }));
