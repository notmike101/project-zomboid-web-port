/**
 * @file Local mod package tests for the parts that are pure: dependency ordering,
 * package validation and the `/__mods__/` request contract in `src/mod-manager.js`.
 *
 * Stored-bytes behaviour (IndexedDB writes, the service worker's serving of a real
 * relative import, quota recovery) cannot be exercised without a browser and is
 * proven there by `npm start` plus the documented browser checks, not mocked here.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MANIFEST_NAME, MAX_FILES, MAX_FILE_BYTES, MAX_MANIFEST_BYTES, MAX_PACKAGE_BYTES, parseModPackage, readPackageFile, resolveModOrder, splitModPath } from '../src/mod-manager.js';

/** The host API version the fixtures name; the resolver is given it, never a constant. */
const HOST_API = '0.1.0';

/**
 * One picked file, as a directory selection reports it.
 *
 * @param {string} path - Path including the picked folder name.
 * @param {string} contents - File text.
 * @returns {{ name: string, size: number, webkitRelativePath: string, arrayBuffer: () => Promise<ArrayBuffer> }} Picked file.
 */
function pickedFile(path, contents) {
    const file = new File([contents], path.split('/').at(-1));

    return {
        name: file.name, size: file.size, webkitRelativePath: path,
        /**
         * Read the picked file's bytes.
         *
         * @returns {Promise<ArrayBuffer>} Detached file contents.
         */
        arrayBuffer: () => file.arrayBuffer(),
    };
}

/**
 * A complete picked folder: `test-mod/mod.json`, its entry and any extras.
 *
 * @param {object} [fields] - Manifest fields to override or add.
 * @param {object} [extra] - Extra package files keyed by package-relative path.
 * @returns {{ name: string, size: number, webkitRelativePath: string, arrayBuffer: () => Promise<ArrayBuffer> }[]} Picked files.
 */
function packageFolder(fields = {}, extra = {}) {
    const manifest = { id: 'alpha', name: 'Alpha', version: '1.0.0', apiVersion: HOST_API, entry: 'main.js', ...fields };
    const files = [pickedFile(`test-mod/${MANIFEST_NAME}`, JSON.stringify(manifest)), pickedFile('test-mod/main.js', 'export const manifest = { id: \'alpha\' };\n')];

    for (const [path, contents] of Object.entries(extra)) {
        files.push(pickedFile(`test-mod/${path}`, contents));
    }

    return files;
}

/**
 * Resolver input for one installed package.
 *
 * @param {string} id - Package id.
 * @param {object} [fields] - Fields to override.
 * @returns {object} One package as the resolver sees it.
 */
function pkg(id, fields = {}) {
    return {
        id,
        version: '1.0.0',
        apiVersion: HOST_API,
        enabled: true,
        dependencies: {},
        optionalDependencies: {},
        conflicts: [],
        loadBefore: [],
        loadAfter: [],
        ...fields,
    };
}

/**
 * Asserts a call failed with a `ModManagerError` matching the pattern.
 *
 * @param {() => Promise<unknown>} action - Call expected to fail.
 * @param {RegExp} pattern - Message pattern.
 * @param {string} [stage] - Expected lifecycle stage.
 * @returns {Promise<Error>} The attributed failure, for further assertions.
 */
async function rejects(action, pattern, stage) {
    let failure;

    try {
        await action();
    } catch (cause) {
        failure = /** @type {Error} */ (cause);
    }

    assert.ok(failure !== undefined, 'the call must fail');
    assert.equal(failure.name, 'ModManagerError');
    assert.match(failure.message, pattern);

    if (stage !== undefined) {
        assert.equal(failure.stage, stage);
    }

    return failure;
}

test('enabled packages with no constraints load in ascending id order', () => {
    assert.deepEqual(resolveModOrder([pkg('zeta'), pkg('alpha'), pkg('mid')], HOST_API), ['alpha', 'mid', 'zeta']);
});

test('disabled packages are left out of the load order', () => {
    assert.deepEqual(resolveModOrder([pkg('beta'), pkg('gamma', { enabled: false }), pkg('alpha')], HOST_API), ['alpha', 'beta']);
});

test('a required dependency loads first', () => {
    assert.deepEqual(resolveModOrder([pkg('game-mod', { dependencies: { 'util-lib': '1.0.0' } }), pkg('util-lib')], HOST_API), ['util-lib', 'game-mod']);
});

test('a missing required dependency is reported as missing or disabled', async () => {
    const missing = await rejects(() => resolveModOrder([pkg('game-mod', { dependencies: { 'util-lib': '1.0.0' } })], HOST_API), /required dependency 'util-lib' is not installed/u);

    assert.deepEqual(missing.ids, ['game-mod', 'util-lib']);

    const disabled = await rejects(() => resolveModOrder([pkg('game-mod', { dependencies: { 'util-lib': '1.0.0' } }), pkg('util-lib', { enabled: false })], HOST_API), /required dependency 'util-lib' is installed but disabled/u);

    assert.equal(disabled.modId, 'game-mod');
});

test('a required dependency version must match exactly', async () => {
    await rejects(() => resolveModOrder([pkg('alpha', { dependencies: { beta: '2.0.0' } }), pkg('beta')], HOST_API), /required dependency 'beta' must be exactly 2\.0\.0, found 1\.0\.0/u, 'resolve');
});

test('an optional dependency is free when absent and binding when present', async () => {
    assert.deepEqual(resolveModOrder([pkg('alpha', { optionalDependencies: { beta: '1.0.0' } })], HOST_API), ['alpha']);
    assert.deepEqual(resolveModOrder([pkg('beta'), pkg('alpha', { optionalDependencies: { beta: '1.0.0' } })], HOST_API), ['alpha', 'beta']);
    await rejects(() => resolveModOrder([pkg('alpha', { optionalDependencies: { beta: '1.0.0' } }), pkg('beta', { version: '1.1.0' })], HOST_API), /optional dependency 'beta' must be exactly 1\.0\.0, found 1\.1\.0/u, 'resolve');
});

test('conflicting packages are refused, but a disabled conflict is harmless', async () => {
    const conflict = await rejects(() => resolveModOrder([pkg('alpha', { conflicts: ['beta'] }), pkg('beta')], HOST_API), /conflicts with enabled package 'beta'/u);

    assert.deepEqual(conflict.ids, ['alpha', 'beta']);
    assert.deepEqual(resolveModOrder([pkg('alpha', { conflicts: ['beta'] }), pkg('beta', { enabled: false })], HOST_API), ['alpha']);
});

test('load hints outrank lexicographic order and absent hints are ignored', () => {
    assert.deepEqual(resolveModOrder([pkg('aardvark', { loadAfter: ['zebra'] }), pkg('zebra')], HOST_API), ['zebra', 'aardvark']);
    assert.deepEqual(resolveModOrder([pkg('zebra', { loadBefore: ['aardvark'] }), pkg('aardvark')], HOST_API), ['zebra', 'aardvark']);
    assert.deepEqual(resolveModOrder([pkg('aardvark', { loadAfter: ['ghost'], loadBefore: ['phantom'] })], HOST_API), ['aardvark']);
});

test('a load-order cycle names the packages that form it', async () => {
    const cycle = await rejects(() => resolveModOrder([pkg('alpha', { loadAfter: ['beta'] }), pkg('beta', { loadAfter: ['alpha'] })], HOST_API), /load order forms a cycle: alpha -> beta -> alpha/u);

    assert.deepEqual(cycle.ids, ['alpha', 'beta']);
});

test('mutually dependent packages are reported as a cycle too', async () => {
    await rejects(() => resolveModOrder([pkg('alpha', { dependencies: { beta: '1.0.0' } }), pkg('beta', { dependencies: { alpha: '1.0.0' } })], HOST_API), /load order forms a cycle/u, 'resolve');
});

test('the host API version passed in decides, never a version baked into the resolver', () => {
    assert.deepEqual(resolveModOrder([pkg('alpha', { apiVersion: '9.9.9' })], '9.9.9'), ['alpha']);
});

test('a package written for another mod API version is refused by id', async () => {
    const failure = await rejects(() => resolveModOrder([pkg('alpha', { apiVersion: '0.2.0' })], HOST_API), /needs mod API '0\.2\.0', this host is '0\.1\.0'/u);

    assert.equal(failure.modId, 'alpha');
});

test('two installed records claiming one id are refused', async () => {
    await rejects(() => resolveModOrder([pkg('alpha'), pkg('alpha')], HOST_API), /two installed packages claim the same id/u, 'resolve');
});

test('a valid multifile folder yields package-relative paths, types and a revision', async () => {
    const parsed = await parseModPackage(packageFolder({
        description: 'A folder mod',
        dependencies: { 'util-lib': '1.0.0' },
        optionalDependencies: { 'fx-pack': '2.0.0' },
        conflicts: ['other-walking'],
        loadBefore: ['late-mod'],
        assets: ['art/tile.png'],
        settings: { speed: 2.25 },
    }, {
        'lib/util.js': 'export const two = 2;\n',
        'art/tile.png': 'png-bytes',
        'audio/tone.ogg': 'ogg-bytes',
        'data.json': '{}',
        'engine.wasm': 'wasm-bytes',
    }));

    assert.deepEqual(parsed.entries.map((entry) => `${entry.path}:${entry.mime}`).sort(), [
        'art/tile.png:image/png',
        'audio/tone.ogg:audio/ogg',
        'data.json:application/json',
        'engine.wasm:application/wasm',
        'lib/util.js:text/javascript; charset=utf-8',
        'main.js:text/javascript; charset=utf-8',
        'mod.json:application/json',
    ]);
    assert.deepEqual(parsed.manifest.dependencies, { 'util-lib': '1.0.0' });
    assert.deepEqual(parsed.manifest.optionalDependencies, { 'fx-pack': '2.0.0' });
    assert.deepEqual(parsed.manifest.conflicts, ['other-walking']);
    assert.deepEqual(parsed.manifest.loadBefore, ['late-mod']);
    assert.deepEqual(parsed.manifest.assets, ['art/tile.png']);
    assert.deepEqual(parsed.manifest.settings, { speed: 2.25 });
    assert.equal(parsed.manifest.description, 'A folder mod');
    assert.match(parsed.revision, /^[\da-f]{16}$/);
    let expectedBytes = 0;

    for (const entry of parsed.entries) {
        expectedBytes += entry.size;
    }

    assert.equal(parsed.totalBytes, expectedBytes);
    assert.ok(parsed.entries.every((entry) => entry.size === entry.bytes.byteLength));
});

test('a minimal folder resolves every optional manifest field to its default', async () => {
    const parsed = await parseModPackage(packageFolder());

    assert.deepEqual(parsed.manifest.dependencies, {});
    assert.deepEqual(parsed.manifest.optionalDependencies, {});
    assert.deepEqual(parsed.manifest.conflicts, []);
    assert.deepEqual(parsed.manifest.loadBefore, []);
    assert.deepEqual(parsed.manifest.loadAfter, []);
    assert.deepEqual(parsed.manifest.assets, []);
    assert.deepEqual(parsed.manifest.settings, {});
    assert.equal(parsed.manifest.description, '');
    assert.equal(parsed.entries.length, 2);
});

test('the revision follows package content, so an update changes every served URL', async () => {
    const first = await parseModPackage(packageFolder());
    const identical = await parseModPackage(packageFolder());
    const updated = await parseModPackage(packageFolder({ version: '1.0.1' }));

    assert.equal(first.revision, identical.revision, 'the same bytes give the same revision');
    assert.notEqual(first.revision, updated.revision, 'a manifest change gives a new revision');
});

test('unsafe paths are refused before any byte is read', async () => {
    const unsafe = ['../outside.js', '/etc/passwd', 'sub/../../outside.js', 'nul\u0000.js', 'up\\..\\main.js', 'dotted/../sibling.js'];

    await Promise.all(unsafe.map(async (path) => {
        const files = [...packageFolder(), pickedFile(`test-mod/${path}`, 'export const x = 1;\n')];
        const failure = await rejects(() => parseModPackage(files), /is not a safe package-relative path/u, 'package');

        assert.ok(failure.message.includes(`'${path.replaceAll('\\', '/')}'`), failure.message);
    }));
});

test('two picked files naming the same package path are refused', async () => {
    await rejects(() => parseModPackage([...packageFolder(), pickedFile('test-mod/MAIN.JS', 'export const x = 1;\n')]), /name the same package file/u, 'package');
});

test('a folder without mod.json at its root is refused', async () => {
    const files = packageFolder().filter((file) => file.webkitRelativePath !== `test-mod/${MANIFEST_NAME}`);

    files.push(pickedFile('test-mod/nested/mod.json', JSON.stringify({ id: 'alpha', name: 'Alpha', version: '1.0.0', apiVersion: HOST_API, entry: 'main.js' })));
    await rejects(() => parseModPackage(files), /mod\.json must sit at the root of the selected folder/u, 'package');
});

test('the entry must be a stored .js or .mjs package path', async () => {
    await rejects(() => parseModPackage(packageFolder({ entry: 'missing.js' })), /entry 'missing\.js' is not one of the selected files/u, 'package');
    const nested = await parseModPackage(packageFolder({ entry: 'lib/util.js' }, { 'lib/util.js': 'export const two = 2;\n' }));

    assert.equal(nested.manifest.entry, 'lib/util.js');
    await rejects(() => parseModPackage(packageFolder({ entry: 'data.json' })), /entry must be a package-relative \.js or \.mjs path/u, 'manifest');
});

test('unsupported file types are refused at install rather than served', async () => {
    await rejects(() => parseModPackage(packageFolder({}, { 'notes.txt': 'notes' })), /unsupported type; packages may hold JavaScript, JSON, CSS, WASM, images and audio/u, 'package');
});

test('malformed manifests are attributed to the package', async () => {
    await rejects(() => parseModPackage(packageFolder({ id: 'Alpha' })), /id must match/u, 'manifest');
    await rejects(() => parseModPackage(packageFolder({ id: 'host' })), /cannot be a package id/u, 'manifest');
    await rejects(() => parseModPackage(packageFolder({ version: '1' })), /version must be dotted major\.minor\.patch/u, 'manifest');
    await rejects(() => parseModPackage(packageFolder({ apiVersion: 'latest' })), /apiVersion must be dotted major\.minor\.patch/u, 'manifest');
    await rejects(() => parseModPackage(packageFolder({ name: '  ' })), /name must be a non-empty string/u, 'manifest');
    await rejects(() => parseModPackage(packageFolder({ description: 7 })), /description must be a string when present/u, 'manifest');
    await rejects(() => parseModPackage(packageFolder({ dependencies: { beta: '^2.0.0' } })), /dependencies\.'beta' must be an exact dotted major\.minor\.patch version/u, 'manifest');
    await rejects(() => parseModPackage(packageFolder({ dependencies: { Bad: '2.0.0' } })), /dependencies key 'Bad' must match/u, 'manifest');
    await rejects(() => parseModPackage(packageFolder({ conflicts: 'beta' })), /conflicts must be an array of package ids/u, 'manifest');
    await rejects(() => parseModPackage(packageFolder({ loadAfter: ['alpha'] })), /loadAfter may not name the package itself/u, 'manifest');
    await rejects(() => parseModPackage(packageFolder({ assets: ['art/missing.png'] })), /assets entry 'art\/missing\.png' is not one of the selected files/u, 'manifest');
    await rejects(() => parseModPackage(packageFolder({ settings: [1, 2] })), /settings must be a JSON object when present/u, 'manifest');
    await rejects(() => parseModPackage([pickedFile(`test-mod/${MANIFEST_NAME}`, '{ not json')]), /mod\.json is not valid JSON/u, 'manifest');
});

test('the per-file and whole-package size bounds stop the read', async () => {
    const oversize = {
        name: 'huge.js', size: MAX_FILE_BYTES + 1, webkitRelativePath: 'test-mod/huge.js',
        /**
         * Fail if validation attempts to read an over-limit file.
         *
         * @returns {never} Always fails the test.
         */
        arrayBuffer: () => {
            assert.fail('an over-limit file must not be read');
        },
    };

    await rejects(() => parseModPackage([...packageFolder(), oversize]), new RegExp(`over the ${MAX_FILE_BYTES}-byte per-file limit`), 'package');

    const many = Array.from({ length: 5 }, (unused, index) => ({
        name: `big${index}.js`, size: 13 * 1_024 * 1_024, webkitRelativePath: `test-mod/big${index}.js`,
        /**
         * Fail if validation attempts to read an over-limit package.
         *
         * @returns {never} Always fails the test.
         */
        arrayBuffer: () => {
            assert.fail('an over-limit package must not be read');
        },
    }));

    await rejects(() => parseModPackage([...packageFolder(), ...many]), new RegExp(`over the ${MAX_PACKAGE_BYTES}-byte package limit`), 'package');
});

test('an oversized manifest is refused', async () => {
    const body = JSON.stringify({ id: 'alpha', name: 'Alpha', version: '1.0.0', apiVersion: HOST_API, entry: 'main.js', description: 'x'.repeat(MAX_MANIFEST_BYTES) });

    await rejects(() => parseModPackage([pickedFile(`test-mod/${MANIFEST_NAME}`, body), pickedFile('test-mod/main.js', '')]), new RegExp(`over the ${MAX_MANIFEST_BYTES}-byte manifest limit`), 'package');
});

test('a folder over the file-count bound is refused', async () => {
    const files = Array.from({ length: MAX_FILES + 1 }, (unused, index) => pickedFile(`test-mod/file${index}.js`, 'export const x = 1;\n'));

    await rejects(() => parseModPackage(files), new RegExp(`at most ${MAX_FILES} files, got ${MAX_FILES + 1}`), 'package');
});

test('an empty selection says what to select instead', async () => {
    await rejects(() => parseModPackage([]), /select a mod folder containing mod\.json/u, 'package');
});

test('a valid package request splits into id, revision and path', () => {
    assert.deepEqual(splitModPath('/__mods__/alpha/0123456789abcdef/lib/util.js'), { id: 'alpha', revision: '0123456789abcdef', path: 'lib/util.js' });
    assert.deepEqual(splitModPath('/__mods__/a-1_b.2/0000000000000000/mod.json'), { id: 'a-1_b.2', revision: '0000000000000000', path: 'mod.json' });
});

test('malformed or traversing package requests never reach a storage lookup', () => {
    const rejected = ['/src/main.js', '/__mods__/', '/__mods__/alpha', '/__mods__/alpha/0123456789abcdef', '/__mods__/Alpha/0123456789abcdef/main.js', '/__mods__/alpha/01234/main.js', '/__mods__/alpha/0123456789ABCDEF/main.js', '/__mods__/alpha%2Fbeta/0123456789abcdef/main.js', '/__mods__/alpha/0123456789abcdef/%2E%2E%2Fsecret.js', '/__mods__/alpha/0123456789abcdef/../secret.js', '/__mods__/alpha/0123456789abcdef/', '/__mods__/alpha/0123456789abcdef/%25'];

    for (const pathname of rejected) {
        assert.equal(splitModPath(pathname), undefined, pathname);
    }
});

test('the reserved host id and an impossible revision never reach a lookup', async () => {
    assert.equal(await readPackageFile('host', '0123456789abcdef', 'main.js'), undefined);
    assert.equal(await readPackageFile('alpha', '01234', 'main.js'), undefined);
    assert.equal(await readPackageFile('alpha', '0123456789abcdef', '../outside.js'), undefined);
    assert.equal(await readPackageFile('alpha', '0123456789abcdef', '%'), undefined);
});
