import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

const [generationFile, jdk, outputArgument] = process.argv.slice(2);

assert.ok(generationFile && jdk && outputArgument && process.argv.length === 5,
    'Usage: node build-entry.mjs GENERATION_JSON JDK_DIRECTORY OUTPUT_JAR');
const output = path.resolve(outputArgument);
const generation = JSON.parse(await readFile(generationFile, 'utf8'));
const classpath = generation.classpath.map((url) => {
    const records = generation.routes.filter((record) => record.url === url.replace(/^\/app\//u, '/'));

    assert.equal(records.length, 1, `Expected one classpath route: ${url}`);

    return records[0];
});
const entry = classpath.find((record) => record.url === '/original-boot-entry.jar');

assert.ok(entry, 'Original entry route required');
assert.ok(classpath.every((record) => path.resolve(record.file) !== output), 'Output must not overwrite any input');
await Promise.all(classpath.map(async (record) => {
    const bytes = await readFile(record.file);

    assert.equal(bytes.length, record.bytes, record.file);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256, record.file);
}));
await mkdir(path.dirname(output), { recursive: true });
const work = await mkdtemp(path.join(path.dirname(output), 'startup-build-'));

/**
 * Runs only JDK build tools; original game initializers are never invoked.
 *
 * @param {string} tool - JDK tool name.
 * @param {string[]} args - Tool arguments.
 * @param {string} cwd - Working directory.
 * @returns {string} Tool stdout.
 */
function command(tool, args, cwd = work) {
    const result = spawnSync(path.resolve(jdk, 'bin', tool + (process.platform === 'win32' ? '.exe' : '')), args,
        { cwd, encoding: 'utf8', maxBuffer: 8 * 1_024 * 1_024 });

    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    return result.stdout;
}

const authored = /^(?:zombie\/Browser(?:LifecycleBoot|LifecycleController|OriginalBoot)(?:\$[^/]+)?|port\/host\/(?:BrowserAvatarDiagnostics|PopulationBuffers|SpriteBuffers(?:\$[^/]+)?))\.class$/u;
const shadowedGraphics = /^port\/host\/SpriteGraphics(?:\$[^/]+)?\.class$/u;
const earlierArchives = classpath.slice(0, classpath.indexOf(entry));

assert.ok(earlierArchives.some((record) => command('jar', ['--list', '--file', path.resolve(record.file)])
    .split(/\r?\n/u).includes('port/host/SpriteGraphics.class')), 'The qualified graphics facade must precede the entry archive');

try {
    const classes = path.join(work, 'classes');
    const java = path.join(import.meta.dirname, 'java/zombie');
    const sources = ['BrowserLifecycleBoot.java', 'BrowserLifecycleController.java', 'BrowserOriginalBoot.java']
        .map((name) => path.join(java, name));

    sources.push(path.resolve(import.meta.dirname, '../host/port/host/BrowserAvatarDiagnostics.java'));
    sources.push(...['SpriteBuffers.java', 'PopulationBuffers.java'].map((name) => path.resolve(import.meta.dirname, '../host/port/host', name)));
    await mkdir(classes);
    command('javac', ['--release', '17', '-classpath', classpath.map((record) => path.resolve(record.file)).join(path.delimiter),
        '-d', classes, ...sources]);
    const candidate = path.join(work, 'entry.jar');

    const base = path.join(work, 'base');
    const baseNames = command('jar', ['--list', '--file', path.resolve(entry.file)]).trim().split(/\r?\n/u);

    assert.ok(baseNames.every((name) => !name.startsWith('/') && !name.includes('\\') && !name.split('/').includes('..')));
    await mkdir(base);
    command('jar', ['--extract', '--file', path.resolve(entry.file)], base);
    await Promise.all(baseNames.filter((name) => shadowedGraphics.test(name)).map((name) => rm(path.join(base, name))));
    command('jar', ['--create', '--no-manifest', '--file', candidate, '-C', base, '.']);
    command('jar', ['--update', '--file', candidate, '-C', classes, '.']);
    const archives = [];

    // Bound to the small entry archive; reject traversal before using the JDK extractor.
    /* eslint-disable no-await-in-loop -- Verify each extracted archive in a separate owned directory. */
    for (const [index, file] of [entry.file, candidate].entries()) {
        const names = command('jar', ['--list', '--file', path.resolve(file)]).trim().split(/\r?\n/u);

        assert.ok(names.every((name) => !name.startsWith('/') && !name.includes('\\')
            && !name.split('/').includes('..')), 'Unsafe entry archive path');
        assert.equal(new Set(names).size, names.length, 'Duplicate archive entries');
        const directory = path.join(work, `archive-${index}`);

        await mkdir(directory);
        command('jar', ['--extract', '--file', path.resolve(file)], directory);
        archives.push({ names, directory });
    }

    const [before, after] = archives;

    for (const name of before.names) {
        if (shadowedGraphics.test(name)) {
            assert.equal(after.names.includes(name), false, `Raw graphics facade still shadows qualified archive: ${name}`);
            continue;
        }

        assert.ok(after.names.includes(name), `Removed entry: ${name}`);

        if (!name.endsWith('/') && !authored.test(name)) {
            assert.deepEqual(await readFile(path.join(before.directory, name)),
                await readFile(path.join(after.directory, name)), `Modified original entry: ${name}`);
        }
    }

    for (const name of after.names.filter((name) => !before.names.includes(name) && !name.endsWith('/'))) {
        assert.ok(authored.test(name), `Unexpected new entry: ${name}`);
    }

    /* eslint-enable no-await-in-loop */
    await copyFile(candidate, output, constants.COPYFILE_EXCL);
    const bytes = await readFile(output);

    console.info(JSON.stringify({
        output, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
        originalEntriesPreserved: true,
    }, null, 2));
} finally {
    await rm(work, { recursive: true, force: true });
}
