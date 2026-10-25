import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Recover only exact recorded bytes; proprietary inputs remain in ignored target.
const [sourceFile, outputArgument, eagerSpecificationFile] = process.argv.slice(2);

assert.ok(sourceFile && outputArgument, 'Usage: node recover.mjs GENERATION_JSON TARGET_DIRECTORY [EAGER_SPECIFICATION_JSON]');
const generation = JSON.parse(await readFile(sourceFile, 'utf8'));

if (eagerSpecificationFile) {
    generation.eagerMedia = JSON.parse(await readFile(eagerSpecificationFile, 'utf8'));
}

assert.equal(generation.eagerMedia?.schema, 'same-owner-eager-metadata-v1', 'Recorded eager metadata specification required');
const originalRoot = await realpath(generation.root);
const target = path.resolve(import.meta.dirname, '../../target');
const output = path.resolve(outputArgument);

assert.ok(output.startsWith(`${target}${path.sep}`), 'Recovery output must stay under target');
assert.equal(await stat(output).then(() => true, (error) => {
    if (error.code !== 'ENOENT') {
        throw error;
    }

    return false;
}), false, 'Recovery requires a new generation directory');
await mkdir(output, { recursive: true });
assert.equal(await realpath(output), output, 'Recovery output must not use directory aliases');
/**
 * Computes an exact source identity.
 *
 * @param {Buffer} bytes - Frozen source bytes.
 * @returns {string} SHA-256 digest.
 */
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Copies only hash-matched recorded bytes into the new private generation.
 *
 * @param {string} source - Frozen input path.
 * @param {string} destination - Owned output path.
 * @param {object} record - Required byte count and identity.
 * @returns {Promise<void>} Completion after destination identity verification.
 */
async function exactCopy(source, destination, record) {
    const bytes = await readFile(source);

    assert.equal(bytes.length, record.bytes, source);
    assert.equal(digest(bytes), record.sha256, source);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    assert.equal(digest(await readFile(destination)), record.sha256, destination);
}

const populationURLs = ['/population-natives.js', '/population-kernel.js', '/population-save-codec.js'];

/* eslint-disable no-await-in-loop -- Bound archive memory and file handles during recovery. */
for (const record of generation.routes) {
    if (record.url.startsWith('/prepared/')) {
        continue;
    }

    const relative = path.relative(originalRoot, record.file);

    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    const destination = populationURLs.includes(record.url)
        ? path.join(output, 'population', record.url.slice(1))
        : path.join(output, relative);
    const source = record.url === '/stdlib.lua' ? generation.rootSourceInputs.find((input) => input.url === record.url)?.file : record.file;

    await exactCopy(source, destination, record);
    record.file = destination;

    if (['/original-boot.js', '/negative-stat.js', ...populationURLs].includes(record.url)) {
        const selected = path.join(import.meta.dirname, record.url.startsWith('/population-') ? '..' : '.', record.url.slice(1));
        const bytes = await readFile(selected);

        record.recoveredSource = { sha256: record.sha256, bytes: record.bytes };
        record.sha256 = digest(bytes);
        record.bytes = bytes.length;
        await writeFile(destination, bytes);
    }
}

// Resolve the exact frozen trio before expensive asset certification or browser creation.
await import(pathToFileURL(generation.routes.find((record) => record.url === '/population-natives.js').file).href);

const inventory = { file: generation.importer.inventoryFile, bytes: (await stat(generation.importer.inventoryFile)).size, sha256: generation.importer.inventorySha256 };

await exactCopy(inventory.file, path.join(output, 'combined-importer-inventory.json'), inventory);
generation.importer.inventoryFile = path.join(output, 'combined-importer-inventory.json');
generation.recoveredFrom = { file: path.resolve(sourceFile), sha256: digest(await readFile(sourceFile)), hostSources: generation.hostSources };
generation.root = output;
generation.hostSources = [];

for (const name of ['run.mjs', 'profile-routes.mjs', 'network-observer.mjs', 'closed-media.mjs', 'certify-published.mjs', 'map-four.mjs', 'memory-guard.mjs', 'memory-watch.ps1', '../file-watch-service.mjs', '../media-files.mjs']) {
    const file = path.resolve(import.meta.dirname, name);
    const bytes = await readFile(file);
    const evidenceFile = path.join(output, 'host-source-evidence', path.basename(name));
    const record = { file, evidenceFile, bytes: bytes.length, sha256: digest(bytes) };

    await exactCopy(file, evidenceFile, record);
    generation.hostSources.push(record);
}

await writeFile(path.join(output, 'generation.json'), `${JSON.stringify(generation, null, 2)}\n`);
console.info(path.join(output, 'generation.json'));
