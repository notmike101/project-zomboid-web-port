import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * Certifies only previously published payload snapshots; never reads installed sources.
 *
 * @param {object} options - Exact frozen namespace and retained payload-owner proof.
 * @param {object} options.owner - Still-active original closed-media owner.
 * @param {Array<object>} options.namespace - Pinned canonical namespace entries.
 * @param {string} options.namespaceSHA - Pinned namespace identity.
 * @param {string} options.sourceRoot - Original canonical media root, used lexically only.
 * @param {string} options.inodeHelperSource - Exact pinned original helper text.
 * @param {number} options.deadlineAt - Existing total host owner deadline.
 * @param {object} options.audit - Caller-owned actual handle lifecycle diagnostics.
 * @returns {Promise<object>} Positive metadata certificate backed by verified owned bytes.
 */
export async function certifyPublished({ owner, namespace, namespaceSHA, sourceRoot, inodeHelperSource, deadlineAt, audit }) {
    assert.ok(Number.isSafeInteger(deadlineAt) && Date.now() < deadlineAt, 'Certificate preparation deadline');
    assert.ok(Array.isArray(audit.handles) && audit.handles.length === 0);
    assert.match(namespaceSHA, /^[a-f0-9]{64}$/u);
    assert.equal(createHash('sha256').update(JSON.stringify(namespace)).digest('hex'), namespaceSHA);
    assert.equal(typeof inodeHelperSource, 'string');
    const state = owner.diagnostics();

    assert.equal(state.active, true);
    assert.equal(state.terminalFailure, null);
    assert.equal(state.namespaceSHA, namespaceSHA);
    assert.equal(state.requests, 0, 'Certify only at an owner-controlled quiescent boundary');
    const snapshotRoot = path.resolve(state.snapshots);

    assert.equal(await realpath(snapshotRoot), snapshotRoot);
    assert.equal((await lstat(snapshotRoot)).isSymbolicLink(), false);
    assert.ok(!snapshotRoot.startsWith(`${path.resolve(sourceRoot)}${path.sep}`));
    assert.notEqual(snapshotRoot, path.resolve(sourceRoot));
    const canonical = new Map();

    for (const entry of namespace) {
        if (entry.kind === 'file') {
            assert.equal(canonical.has(entry.relative), false);
            canonical.set(entry.relative, entry);
        }
    }

    const records = owner.publishedFiles();

    assert.equal(records.length, state.published);

    /**
     * Rechecks one already-owned payload using one bounded file handle.
     *
     * @param {object} record - Actual publication proof.
     * @returns {Promise<object>} Exact canonical metadata.
     */
    async function certifyRecord(record) {
        assert.ok(Date.now() < deadlineAt, 'Certificate record deadline');
        const relative = path.relative(path.resolve(sourceRoot), path.resolve(record.source)).split(path.sep).join('/');
        const entry = canonical.get(relative);

        assert.ok(entry, 'Publication must identify an exact canonical frozen file');
        assert.equal(entry.bytes, record.bytes);
        assert.equal(entry.sha256, record.sha256);
        assert.ok(Number.isSafeInteger(record.bytes) && record.bytes >= 0 && record.bytes <= 0x7F_FF_FF_FF);
        assert.match(record.sha256, /^[a-f0-9]{64}$/u);
        const expectedName = createHash('sha256').update(relative).digest('hex');
        const snapshot = path.resolve(record.snapshot);

        assert.equal(snapshot, path.join(snapshotRoot, expectedName));
        assert.equal(await realpath(snapshot), snapshot);
        const before = await lstat(snapshot, { bigint: true });

        assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n);
        assert.equal(before.size, BigInt(record.bytes));
        const handle = await open(snapshot, 'r');
        const lifecycle = { snapshot, fd: handle.fd, closed: false };

        let primary;

        try {
            audit.handles.push(lifecycle);
            const opened = await handle.stat({ bigint: true });

            assert.equal(opened.dev, before.dev);
            assert.equal(opened.ino, before.ino);
            const digest = createHash('sha256');

            for await (const bytes of handle.createReadStream({ autoClose: false })) {
                assert.ok(Date.now() < deadlineAt, 'Certificate stream deadline');
                digest.update(bytes);
            }

            assert.equal(digest.digest('hex'), record.sha256);
            const after = await handle.stat({ bigint: true });
            const named = await lstat(snapshot, { bigint: true });

            for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'nlink']) {
                assert.equal(after[key], before[key]);
                assert.equal(named[key], before[key]);
            }
        } catch (error) {
            primary = error;
        } finally {
            try {
                await handle.close();
                lifecycle.closed = true;
            } catch (error) {
                lifecycle.closeError = String(error.stack ?? error);

                primary = primary ? new AggregateError([primary, error], 'Certificate operation and handle cleanup failed') : error;
            }
        }

        if (primary) {
            throw primary;
        }

        return Object.freeze({ path: `/media/${relative}`, bytes: record.bytes, sha256: record.sha256 });
    }

    const files = [];

    /**
     * Serializes certification so only one payload handle is open at a time.
     *
     * @param {number} index - Next actual publication index.
     * @returns {Promise<void>} Completion of the finite publication list.
     */
    async function certifyNext(index) {
        if (index === records.length) {
            return;
        }

        files.push(await certifyRecord(records[index]));
        await certifyNext(index + 1);
    }

    await certifyNext(0);

    assert.equal(new Set(files.map((file) => file.path)).size, files.length);
    const finalState = owner.diagnostics();

    assert.equal(finalState.active, true);
    assert.equal(finalState.terminalFailure, null);
    assert.equal(finalState.requests, 0);
    assert.equal(finalState.published, records.length, 'Publication set changed during certification');

    return Object.freeze({
        schema: 'verified-owned-positive-v1', namespaceSHA, inodeHelperSource,
        metadataOnly: true, lastModified: 0, files: Object.freeze(files),
    });
}
