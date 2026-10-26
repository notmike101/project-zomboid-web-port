/* eslint-disable no-await-in-loop -- Importer children and snapshot transfers intentionally run sequentially. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hash } from './profile-routes.mjs';

const [installationArgument, planArgument, jdkArgument, outputArgument, mode] = process.argv.slice(2);

assert.ok(process.argv.length === 7 && ['--plan-only', '--prepare'].includes(mode),
    'Usage: node prepare-scene-batches.mjs INSTALLATION PLAN_TSV JDK25 NEW_TARGET_DIRECTORY --plan-only|--prepare');
const source = path.resolve(import.meta.dirname, '..');
const workspace = await realpath(path.join(source, '..'));
const target = await realpath(path.join(workspace, 'target'));
const output = path.resolve(outputArgument);
const parent = await realpath(path.dirname(output));
const installation = await realpath(installationArgument);
const plan = await realpath(planArgument);
const jdk = await realpath(jdkArgument);

assert.ok(target.startsWith(workspace + path.sep));
assert.ok(output.startsWith(path.join(workspace, 'target') + path.sep));
assert.ok(parent === target || parent.startsWith(target + path.sep), 'Output parent escapes target');
assert.ok(!output.startsWith(installation + path.sep) && !installation.startsWith(output + path.sep));
const originalPlan = await readFile(plan);

assert.ok(originalPlan.length <= 4 * 1_024 * 1_024, 'Combined plan exceeds supported bound');
const planSHA = createHash('sha256').update(originalPlan).digest('hex');
const lines = originalPlan.toString('utf8').split(/\r?\n/u).filter(Boolean);

assert.ok(lines.length > 0 && lines.length <= 6_034, 'Supported combined inventory is at most 6034 identities');
const keys = lines.map((line) => line.split('\t')[0]);

assert.equal(new Set(keys).size, keys.length, 'Duplicate combined identity');
assert.ok(keys.every((key) => /^[a-f0-9]{64}$/u.test(key)));
await mkdir(output);
const classes = path.join(output, 'classes');

await mkdir(classes);

/**
 * Runs only authored importer preparation, never a game/server entry point.
 *
 * @param {string} tool - JDK executable.
 * @param {string[]} args - Exact arguments.
 * @returns {string} Tool output.
 */
function command(tool, args) {
    const result = spawnSync(path.join(jdk, 'bin', `${tool}${process.platform === 'win32' ? '.exe' : ''}`), args,
        { cwd: workspace, encoding: 'utf8', maxBuffer: 4 * 1_024 * 1_024 });

    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    return result.stdout;
}

const game = path.join(installation, 'projectzomboid.jar');
const dll = path.join(installation, 'jassimp64.dll');
const sources = ['animation/AiSceneSnapshot.java', 'animation/manifest/PrepareManifestScenes.java',
    'animation/manifest/ImportManifestRecord.java'].map((name) => path.join(source, name));
const sourceIdentities = await Promise.all([game, dll, plan, ...sources].map(async (file) => ({ file, sha256: await hash(file) })));

assert.equal(sourceIdentities.find((record) => record.file === plan).sha256, planSHA, 'Plan changed during admission');
const validator = path.join(output, 'ValidateManifestPlan.java');

await writeFile(validator, 'public final class ValidateManifestPlan { public static void main(String[] args)throws Exception { System.out.println(PrepareManifestScenes.inputs(java.nio.file.Path.of(args[0])).size()); } }\n');
command('javac', ['-J-Xmx256m', '--release', '17', '-cp', game, '-d', classes, ...sources, validator]);
const classpath = [classes, game].join(path.delimiter);
const batches = [];

for (let offset = 0; offset < lines.length; offset += 4_096) {
    const selected = lines.slice(offset, offset + 4_096);
    const file = path.join(output, `plan-${batches.length}.tsv`);

    await writeFile(file, `${selected.join('\n')}\n`, { flag: 'wx' });
    assert.equal(Number(command('java', ['-Xmx128m', '-cp', classpath, 'ValidateManifestPlan', file]).trim()), selected.length);
    const staging = path.join(output, `batch-${batches.length}`);
    const args = ['-Xmx128m', '-cp', classpath, 'PrepareManifestScenes', installation, file, staging, dll];

    batches.push({ file, sha256: await hash(file), count: selected.length, staging, javaArguments: args });
}

const recipe = {
    schema: 'original-manifest-batches-v1', plan, planSHA256: planSHA, identities: lines.length,
    sources: sourceIdentities, batches, nativeImporterExecuted: false, executionAdmitted: false,
};

for (const record of sourceIdentities) {
    assert.equal(await hash(record.file), record.sha256, 'Preparation input changed');
}

await writeFile(path.join(output, 'recipe.json'), JSON.stringify(recipe, null, 2));

if (mode === '--plan-only') {
    console.info(JSON.stringify({ output, batches: batches.length, identities: lines.length, nativeImporterExecuted: false }));
} else {
    // Each existing preparer owns one <=4096 plan and one original-native child at a time.
    for (const batch of batches) {
        command('java', batch.javaArguments);
    }

    const combined = path.join(output, 'combined');

    await mkdir(combined);
    const dllSHA = sourceIdentities.find((record) => record.file === dll).sha256;
    const index = new Map([['format', 'original-jassimp-relative-flags-v1'], ['plan.sha256', planSHA], ['dll.sha256', dllSHA]]);
    const proofs = [];

    for (const batch of batches) {
        assert.equal(await hash(batch.file), batch.sha256);
        const values = new Map((await readFile(path.join(batch.staging, 'index.properties'), 'latin1')).split(/\r?\n/u).filter(Boolean).map((line) => {
            const match = /^([^=\\]+)=([^\\]*)$/u.exec(line);

            assert.ok(match);

            return [match[1], match[2]];
        }));

        assert.equal(values.get('plan.sha256'), batch.sha256);
        assert.equal(values.get('dll.sha256'), dllSHA);
        assert.equal(values.size, 3 + 4 * batch.count);

        for (const row of (await readFile(batch.file, 'utf8')).trimEnd().split('\n')) {
            const [key, relative, sourceSHA256, , flags] = row.split('\t');
            const from = path.resolve(batch.staging, `${key}.ais`);
            const destination = path.resolve(combined, `${key}.ais`);

            assert.ok(from.startsWith(output + path.sep) && destination.startsWith(output + path.sep));
            assert.ok(!(await lstat(from)).isSymbolicLink());
            const sha256 = await hash(from);

            assert.equal(values.get(`${key}.snapshot`), sha256);
            assert.equal(values.get(`${key}.path`), relative);
            assert.equal(values.get(`${key}.source`), sourceSHA256);
            assert.equal(values.get(`${key}.flags`), flags);
            const bytes = (await stat(from)).size;

            // Transfer only owned generated snapshots; do not duplicate the 1GB output set.
            await rename(from, destination);
            assert.equal(await hash(destination), sha256);

            for (const suffix of ['path', 'source', 'flags', 'snapshot']) {
                index.set(`${key}.${suffix}`, values.get(`${key}.${suffix}`));
            }

            proofs.push({ key, file: destination, bytes, sha256, path: relative, flags, sourceSHA256 });
        }
    }

    for (const record of sourceIdentities) {
        assert.equal(await hash(record.file), record.sha256, 'Importer input changed');
    }

    await writeFile(path.join(combined, 'plan.tsv'), originalPlan, { flag: 'wx' });
    await writeFile(path.join(combined, 'index.properties'), `${[...index].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, { encoding: 'latin1', flag: 'wx' });
    const listing = `${[...proofs.map((proof) => `${proof.key}.ais`), 'index.list', 'index.properties'].sort().join('\n')}\n`;

    await writeFile(path.join(combined, 'whole-boot-directory-index.list'), listing, { flag: 'wx' });
    await writeFile(path.join(combined, 'snapshot-routes.json'), JSON.stringify(proofs, null, 2), { flag: 'wx' });
    await writeFile(path.join(combined, 'proof.json'), JSON.stringify({
        ...recipe, nativeImporterExecuted: true,
        indexSHA256: await hash(path.join(combined, 'index.properties')), snapshots: proofs.length,
        snapshotBytes: proofs.reduce((sum, proof) => sum + proof.bytes, 0),
    }, null, 2), { flag: 'wx' });
    console.info(JSON.stringify({ combined, batches: batches.length, snapshots: proofs.length, nativeImporterExecuted: true, executionAdmitted: false }));
}
