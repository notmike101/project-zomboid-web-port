import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSourceFiles } from '../src/source-files.js';

/**
 * Model synchronous Web Storage, including atomic failure before replacement.
 *
 * @returns {object} Independent origin storage with injectable access failures.
 */
function storageFixture() {
    const values = new Map();

    return {
        values,
        readError: null,
        writeError: null,
        /**
         * Read the stored value or propagate the injected storage failure.
         *
         * @param {string} key - Storage key.
         * @returns {string|null} Stored value, or null when absent.
         */
        getItem(key) {
            if (this.readError) {
                throw this.readError;
            }

            return values.get(String(key)) ?? null;
        },
        /**
         * Replace a value atomically unless an injected storage failure occurs.
         *
         * @param {string} key - Storage key.
         * @param {string} value - Replacement text.
         * @returns {void} No result, matching synchronous Web Storage.
         */
        setItem(key, value) {
            if (this.writeError) {
                throw this.writeError;
            }

            values.set(String(key), String(value));
        },
    };
}

/**
 * Open the real backend against one fixture origin.
 *
 * @param {object} storage - Synchronous Storage fixture.
 * @param {string} [sourceBuild='42.21.0'] - Actual source version.
 * @param {string} [ownerId='pz-base-game'] - Source owner identity.
 * @returns {object} Candidate-local layout file handle.
 */
function open(storage, sourceBuild = '42.21.0', ownerId = 'pz-base-game') {
    return createSourceFiles({ storage, sourceBuild, ownerId });
}

test('layout creation and replacement stay staged until a flush and reopen', async () => {
    const storage = storageFixture();
    const files = open(storage);

    assert.equal(files.read('layout.ini'), null);
    assert.equal(files.read('layout.ini', true), '');
    assert.equal(open(storage).read('layout.ini'), null);
    await files.flush();
    assert.equal(open(storage).read('layout.ini'), '');
    files.write('layout.ini', 'window=inventory\n');
    files.write('layout.ini', 'x=40\n', true);
    assert.equal(files.read('layout.ini'), 'window=inventory\nx=40\n');
    assert.equal(open(storage).read('layout.ini'), '');
    await files.flush();
    const reopened = open(storage);

    assert.equal(reopened.read('layout.ini'), 'window=inventory\nx=40\n');
    reopened.write('layout.ini', 'x=80\n');
    await reopened.flush();
    assert.equal(open(storage).read('layout.ini'), 'x=80\n');
    storage.writeError = new Error('a clean flush must not touch storage');
    await reopened.flush();
});

test('a failed atomic commit retains durable content and dirty staging for retry', async () => {
    const storage = storageFixture();
    const files = open(storage);

    files.write('layout.ini', 'x=10\n');
    await files.flush();
    files.write('layout.ini', 'x=20\n');
    const failure = new DOMException('storage is full', 'QuotaExceededError');

    storage.writeError = failure;
    await assert.rejects(files.flush(), (error) => error === failure);
    assert.equal(open(storage).read('layout.ini'), 'x=10\n');
    assert.equal(files.read('layout.ini'), 'x=20\n');
    storage.writeError = null;
    await files.flush();
    assert.equal(open(storage).read('layout.ini'), 'x=20\n');
});

test('disposal invalidates the candidate and drops staging without deleting its durable file', async () => {
    const storage = storageFixture();
    const files = open(storage);

    files.write('layout.ini', 'visible=true\n');
    await files.flush();
    files.write('layout.ini', 'visible=false\n');
    files.dispose();
    files.dispose();
    assert.throws(() => files.read('layout.ini'), /disposed/u);
    assert.throws(() => files.write('layout.ini', ''), /disposed/u);
    await assert.rejects(files.flush(), /disposed/u);
    assert.equal(open(storage).read('layout.ini'), 'visible=true\n');
    const uncommitted = open(storage, '42.22.0');

    uncommitted.read('layout.ini', true);
    uncommitted.dispose();
    assert.equal(open(storage, '42.22.0').read('layout.ini'), null);
});

test('owner, source build, and origin namespaces cannot alias delimiter-containing identities', async () => {
    const storage = storageFixture();
    const identities = [['42.21.0', 'pz-base-game'], ['42.22.0', 'pz-base-game'], ['a:b', 'c'], ['a', 'b:c'], ['a', 'c']];

    let committed = Promise.resolve();

    for (const [index, [build, owner]] of identities.entries()) {
        committed = committed.then(() => {
            const files = open(storage, build, owner);

            files.write('layout.ini', `x=${index}\n`);

            return files.flush();
        });
    }

    await committed;

    for (const [index, [build, owner]] of identities.entries()) {
        assert.equal(open(storage, build, owner).read('layout.ini'), `x=${index}\n`);
    }

    assert.equal(open(storageFixture()).read('layout.ini'), null);
});

test('UTF8 limits reject overflow before replacing or appending staged content', async () => {
    const storage = storageFixture();
    const files = open(storage);
    const boundary = 'é'.repeat(32_768);

    files.write('layout.ini', boundary);
    assert.throws(() => files.write('layout.ini', 'x', true), RangeError);
    assert.throws(() => files.write('layout.ini', 'é'.repeat(32_769)), RangeError);
    assert.throws(() => files.write('layout.ini', '\uD800'), TypeError);
    assert.equal(files.read('layout.ini'), boundary);
    await files.flush();
    assert.equal(open(storage).read('layout.ini'), boundary);
    const reopened = open(storage);

    assert.throws(() => reopened.write('layout.ini', '🙂', true), RangeError);
    assert.equal(reopened.read('layout.ini'), boundary);
});

test('malformed or oversized durable content and real storage read errors are not reset', async () => {
    const storage = storageFixture();
    const files = open(storage);

    files.write('layout.ini', 'x=10\n');
    await files.flush();
    const [key] = storage.values.keys();

    for (const invalid of [false, '\uD800', 'x'.repeat(65_537)]) {
        storage.values.set(key, invalid);
        const candidate = open(storage);

        assert.throws(() => candidate.read('layout.ini', true));
        assert.throws(() => candidate.write('layout.ini', 'replacement'));
        assert.equal(storage.values.get(key), invalid);
    }

    storage.values.set(key, 'x=30\n');
    const candidate = open(storage);
    const failure = new DOMException('access denied', 'SecurityError');

    storage.readError = failure;
    assert.throws(() => candidate.read('layout.ini'), (error) => error === failure);
    storage.readError = null;
    assert.equal(candidate.read('layout.ini'), 'x=30\n');
});

test('only exact layout paths, primitive strings, and strict boolean flags reach storage', async () => {
    const storage = storageFixture();

    for (const options of [
        { storage, sourceBuild: '', ownerId: 'pz-base-game' },
        { storage, sourceBuild: '42.21.0', ownerId: '' },
        { storage, sourceBuild: { version: '42.21.0' }, ownerId: 'pz-base-game' },
        { storage, sourceBuild: '42.21.0', ownerId: new Object('pz-base-game') },
        { storage: {}, sourceBuild: '42.21.0', ownerId: 'pz-base-game' },
    ]) {
        assert.throws(() => createSourceFiles(options), TypeError);
    }

    const files = open(storage);

    for (const path of ['../layout.ini', '/layout.ini', 'layout.ini/extra', 'Layout.ini', 'options.ini', null]) {
        assert.throws(() => files.read(path));
        assert.throws(() => files.write(path, ''));
    }

    assert.throws(() => files.read('layout.ini', 1), TypeError);
    assert.throws(() => files.write('layout.ini', '', 0), TypeError);
    assert.throws(() => files.write('layout.ini', 1), TypeError);
    await files.flush();
    assert.equal(open(storage).read('layout.ini'), null);
});
