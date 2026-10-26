import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hash } from './profile-routes.mjs';

const [installationArgument, namespaceArgument, outputArgument] = process.argv.slice(2);

assert.ok(process.argv.length === 5,
    'Usage: node inventory-scenes.mjs INSTALLATION CERTIFIED_NAMESPACE_JSON NEW_TARGET_DIRECTORY');
const installation = await realpath(installationArgument);
const namespaceFile = await realpath(namespaceArgument);
const namespaceBytes = await readFile(namespaceFile);
const namespaceSHA = createHash('sha256').update(namespaceBytes).digest('hex');
const namespace = JSON.parse(namespaceBytes);
const workspace = await realpath(path.resolve(import.meta.dirname, '../..'));
const target = await realpath(path.join(workspace, 'target'));
const output = path.resolve(outputArgument);
const parent = await realpath(path.dirname(output));

assert.ok(target.startsWith(workspace + path.sep));
assert.ok(output.startsWith(path.join(workspace, 'target') + path.sep));
assert.ok(parent === target || parent.startsWith(target + path.sep), 'Output parent escapes target');
const files = new Map();

for (const entry of namespace.filter((record) => record.kind === 'file')) {
    assert.ok(typeof entry.relative === 'string' && !entry.relative.includes('\\')
        && !entry.relative.split('/').some((part) => !part || part === '.' || part === '..'));
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && /^[a-f0-9]{64}$/u.test(entry.sha256));
    const key = entry.relative.toLowerCase();

    assert.ok(!files.has(key), 'Ambiguous case-folded source namespace');
    files.set(key, entry);
}

// Exact original FileTask_LoadMesh / FileTask_LoadAnimation enum values and postProcess operations.
const values = {
    JOIN_IDENTICAL_VERTICES: 2, MAKE_LEFT_HANDED: 4, TRIANGULATE: 8,
    LIMIT_BONE_WEIGHTS: 512, REMOVE_REDUNDANT_MATERIALS: 4_096, FIND_INSTANCES: 1_048_576, OPTIMIZE_MESHES: 2_097_152,
};
const meshFlags = Object.keys(values).sort();
const animationFlags = ['MAKE_LEFT_HANDED', 'REMOVE_REDUNDANT_MATERIALS'];
const entries = new Map();
const definitions = [];
const definitionInputs = [];

/**
 * Adds an exact original source/flag tuple to the finite conversion inventory.
 *
 * @param {object} file - Certified source metadata.
 * @param {string[]} flags - Original enum names.
 * @param {string} producer - Definition or original caller evidence.
 */
function add(file, flags, producer) {
    assert.ok(file && /\.(?:x|fbx|glb)$/iu.test(file.relative), 'Unsupported original importer source');
    assert.ok(/^[\x20-\x7E]+$/u.test(file.relative), 'Unaudited non-ASCII model path');
    const relative = `media/${file.relative}`;
    const sorted = [...flags].sort();
    const key = createHash('sha256').update(`${relative.toLowerCase()}|${sorted.join(',')}`).digest('hex');
    const existing = entries.get(key);

    if (existing) {
        existing.producers.push(producer);
    } else {
        entries.set(key, {
            key, path: relative, bytes: file.bytes, sha256: file.sha256, flags: sorted,
            flagsRaw: sorted.reduce((sum, name) => sum + values[name], 0), snapshotIdentity: `${key}.ais`, producers: [producer],
        });
    }
}

/**
 * Mirrors the audited original explicit-path then FBX/GLB/X model resolution order.
 *
 * @param {string} mesh - Original meshFile field.
 * @returns {object} Actual certified file, or throws for missing/unsupported data.
 */
function resolveMesh(mesh) {
    const base = `models_x/${mesh.toLowerCase()}`;
    const result = [base, `${base}.fbx`, `${base}.glb`, `${base}.x`].map((name) => files.get(name)).find(Boolean);

    assert.ok(result, `Unresolved original mesh ${mesh}`);

    return result;
}

// All actual vanilla models are a finite preparation superset; original runtime selection remains unchanged.
for (const file of files.values()) {
    if (file.relative.toLowerCase().startsWith('models_x/') && /\.(?:x|fbx|glb)$/iu.test(file.relative)) {
        add(file, meshFlags, 'FileTask_LoadMesh default flags');
    }
}

const modelDefaults = entries.size;

/* eslint-disable no-await-in-loop -- Only the two actual definition inputs are read and verified. */
for (const name of ['scripts/generated/animations_meshes.txt', 'scripts/generated/models_isoobject_animationsMesh.txt']) {
    const metadata = files.get(name.toLowerCase());

    assert.ok(metadata, 'Original animationMesh definitions missing from source namespace');
    const file = await realpath(path.join(installation, 'media', metadata.relative));

    assert.ok(file.startsWith(installation + path.sep));
    const bytes = await readFile(file);
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    assert.equal(bytes.length, metadata.bytes);
    assert.equal(sha256, metadata.sha256);
    definitionInputs.push({ file, bytes: bytes.length, sha256 });
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '');

    for (const match of text.matchAll(/\banimationsMesh\s+(\w+)\s*\{([^{}]*)\}/giu)) {
        const [, definitionName, body] = match;
        const fields = new Map();

        for (const pair of body.matchAll(/(\w+)\s*=\s*([^,\r\n]+)\s*,/gu)) {
            const key = pair[1].toLowerCase();

            if (!fields.has(key)) {
                fields.set(key, []);
            }

            fields.get(key).push(pair[2].trim());
        }

        assert.equal(fields.get('meshfile')?.length, 1, 'Unsupported flat animationMesh declaration');
        const flags = new Set(meshFlags);

        for (const operation of (fields.get('postprocess') ?? []).flatMap((value) => value.split(/\s+/u))) {
            const flag = operation.slice(1);

            assert.ok(Object.hasOwn(values, flag), 'Unknown original postProcess enum');

            if (operation.startsWith('-')) {
                assert.ok(flags.delete(flag));
            } else if (operation.startsWith('+')) {
                flags.add(flag);
            } else {
                assert.fail('Unknown original postProcess operation');
            }
        }

        const mesh = resolveMesh(fields.get('meshfile')[0]);
        const directories = fields.get('animationdirectory') ?? [];
        const prefixes = fields.get('animationprefix') ?? [];

        add(mesh, [...flags], `animationMesh ${definitionName}`);
        definitions.push({
            name: definitionName, source: `media/${metadata.relative}`, mesh: mesh.relative,
            directories, prefixes, flags: [...flags].sort(),
        });

        for (const directory of directories) {
            const prefix = `anims_x/${directory.toLowerCase()}/`;
            const candidates = [...files.values()].filter((entry) => entry.relative.toLowerCase().startsWith(prefix));

            assert.ok(candidates.length, `Missing original animation directory ${directory}`);

            for (const candidate of candidates) {
                const basename = path.posix.basename(candidate.relative).toLowerCase();
                const allowed = (!prefixes.length || prefixes.some((value) => !value.startsWith('!') && basename.startsWith(value.toLowerCase())))
                    && !prefixes.some((value) => value.startsWith('!') && basename.startsWith(value.slice(1).toLowerCase()));

                if (allowed) {
                    add(candidate, animationFlags, `animationMesh ${definitionName}`);
                }
            }
        }
    }
}

const records = [...entries.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
const counts = Object.fromEntries([4_100, 3_150_348, 3_150_350].map((raw) => [raw, records.filter((record) => record.flagsRaw === raw).length]));

assert.equal(definitions.length, 75, 'Installed definition revision requires a new source/caller qualification');
assert.equal(modelDefaults, 3_871);
assert.deepEqual(counts, { 4_100: 2_161, 3_150_348: 2, 3_150_350: 3_871 });
assert.equal(records.length, 6_034);
assert.equal(await hash(namespaceFile), namespaceSHA, 'Source namespace changed');

for (const record of definitionInputs) {
    assert.equal(await hash(record.file), record.sha256, 'Original definition changed');
}

await mkdir(output);
const plan = records.map((record) => [record.key, record.path, record.sha256, record.bytes, record.flags.join(','), record.flagsRaw].join('\t')).join('\n');

await writeFile(path.join(output, 'plan.tsv'), `${plan}\n`, { flag: 'wx' });
await writeFile(path.join(output, 'inventory.json'), JSON.stringify({
    scope: 'Original vanilla definition closure plus finite default-model superset; not a runtime requested-set trace',
    namespace: { file: namespaceFile, bytes: namespaceBytes.length, sha256: namespaceSHA }, definitionInputs,
    definitions, entries: records, counts, identities: records.length, planSHA256: await hash(path.join(output, 'plan.tsv')),
    sourcePayloadsValidatedByNativePreparer: false, nativeImporterExecuted: false, executionAdmitted: false,
}, null, 2), { flag: 'wx' });
console.info(JSON.stringify({ output, definitions: definitions.length, identities: records.length, counts, nativeImporterExecuted: false }));
/* eslint-enable no-await-in-loop */
