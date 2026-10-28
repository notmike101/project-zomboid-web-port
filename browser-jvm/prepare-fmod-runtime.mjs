/* eslint-disable jsdoc/require-jsdoc -- This bounded preparation script has no exported callback API. */
/* eslint-disable no-await-in-loop -- Keep optional SDK verification and copying sequential and bounded. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [sdkArgument, outputArgument] = process.argv.slice(2);

assert.ok(sdkArgument && outputArgument, 'Usage: node prepare-fmod-runtime.mjs SUPPLIED_HTML5_SDK NEW_TARGET_DIRECTORY');
const sdk = await realpath(sdkArgument);
const output = path.resolve(outputArgument);
const target = path.resolve(import.meta.dirname, '../target');
const headerFile = path.join(sdk, 'api/core/inc/fmod_common.h');
const header = await readFile(headerFile, 'utf8');
const versionMatch = /^#define FMOD_VERSION\s+0x([a-f0-9]{8})\b/imu.exec(header);

assert.ok(versionMatch, 'Supplied SDK must declare its public FMOD_VERSION');
const versionHex = Number.parseInt(versionMatch[1], 16);
const version = new Map([[0x00_02_03_09, '2.03.09'], [0x00_02_04_00, '2.04.00']]).get(versionHex);

assert.ok(version, 'Only the reviewed supplied 2.03.09 and 2.04.00 SDK layouts can be packaged');
const library = versionHex === 0x00_02_03_09 ? 'api/studio/lib/wasm' : 'api/studio/lib/browser/single_threaded/js';

assert.ok(output.startsWith(`${target}${path.sep}`));
assert.equal(await stat(output).then(() => true, (error) => {
    if (error.code !== 'ENOENT') {
        throw error;
    }

    return false;
}), false);
await mkdir(path.join(output, 'fmod-runtime'), { recursive: true });
assert.equal(await realpath(output), output);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const routes = [];
const inputs = [];
let scriptPackaging;

for (const name of ['fmodstudioL.js', 'fmodstudioL.wasm']) {
    const source = path.join(sdk, library, name);
    const original = await readFile(source);
    let bytes = original;

    if (name.endsWith('.wasm')) {
        assert.equal(bytes.subarray(0, 8).toString('hex'), '0061736d01000000');
    } else {
        assert.ok(!bytes.includes(0));

        if (versionHex === 0x00_02_03_09) {
            assert.ok(bytes.includes(Buffer.from('var FMODModule')) && bytes.includes(Buffer.from('module.exports = FMODModule')),
                'Expected the supplied public UMD factory');
            const suffix = '\nexport default FMODModule;\n';

            bytes = Buffer.concat([original, Buffer.from(suffix)]);
            scriptPackaging = { factory: 'FMODModule', rawScriptSHA: sha(original), appendedExport: suffix };
        } else {
            assert.ok(bytes.includes(Buffer.from('export default createFMOD')));
        }
    }

    const file = path.join(output, 'fmod-runtime', name);

    await writeFile(file, bytes, { flag: 'wx' });
    assert.deepEqual(await readFile(file), bytes);
    routes.push({ url: `/fmod-runtime/${name}`, file, bytes: bytes.length, sha256: sha(bytes), type: name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' });
    inputs.push({ file: source, bytes: original.length, sha256: sha(original) });
}

const fields = ['DecayTime', 'EarlyDelay', 'LateDelay', 'HFReference', 'HFDecayRatio', 'Diffusion', 'Density',
    'LowShelfFrequency', 'LowShelfGain', 'HighCut', 'EarlyLateMix', 'WetLevel'];
const presets = [...header.matchAll(/#define FMOD_PRESET_(\w+)\s+\{([^}]+)\}/gu)].map((match) => {
    const values = match[2].split(',').map((value) => Math.fround(Number(value.trim().replace(/f$/u, ''))));

    assert.equal(values.length, fields.length);
    assert.ok(values.every(Number.isFinite));

    return { name: match[1], properties: Object.fromEntries(fields.map((field, index) => [field, values[index]])) };
});

assert.equal(presets.length, 24);
assert.equal(presets[0].name, 'OFF');
assert.equal(presets[1].name, 'GENERIC');
const presetBytes = Buffer.from(JSON.stringify(presets));
const presetFile = path.join(output, 'fmod-runtime/reverb-presets.json');

await writeFile(presetFile, presetBytes, { flag: 'wx' });
routes.push({ url: '/fmod-runtime/reverb-presets.json', file: presetFile, bytes: presetBytes.length, sha256: sha(presetBytes), type: 'application/json' });
inputs.push({ file: headerFile, bytes: Buffer.byteLength(header), sha256: sha(Buffer.from(header)) });
const manifest = {
    schema: 'fmod-html5-runtime-v1', version, versionHex,
    scriptSHA: routes[0].sha256, wasmSHA: routes[1].sha256, presetSHA: sha(presetBytes),
    ...(scriptPackaging ? { scriptPackaging } : {}),
};
const bytes = Buffer.from(JSON.stringify(manifest));
const file = path.join(output, 'fmod-runtime/manifest.json');

await writeFile(file, bytes, { flag: 'wx' });
routes.push({ url: '/fmod-runtime/manifest.json', file, bytes: bytes.length, sha256: sha(bytes), type: 'application/json' });

for (const name of ['fmod-runtime.js', 'fmod-natives.js', 'fmod.js', 'fmodstudio.js', 'fmodintegration64.js']) {
    const bytes = await readFile(path.join(import.meta.dirname, name));
    const file = path.join(output, name);

    await writeFile(file, bytes, { flag: 'wx' });
    assert.deepEqual(await readFile(file), bytes);
    routes.push({ url: `/${name}`, file, bytes: bytes.length, sha256: sha(bytes), type: 'text/javascript' });
}

await writeFile(path.join(output, 'audio-routes.json'), JSON.stringify({ audioRuntime: { manifestSHA: sha(bytes) }, routes }, null, 2));
await writeFile(path.join(output, 'sdk-inputs.json'), JSON.stringify(inputs, null, 2));
console.info(JSON.stringify({ output, audioRuntime: { manifestSHA: sha(bytes) }, routes }));
