import assert from 'node:assert/strict';
import { NativeMT, collision } from './population-kernel.js';
import { createPopulationNatives } from './population-natives.js';
import { decodeCell, encodeCollision } from './population-save-codec.js';

// Original DLL source priority: only exact 32 is unset; zero and flags containing bit 32 stay opaque.
const sourceFlags = [32, 33, 34, 63, 255, 0, 1, 8];
const sourceChunks = Array.from({ length: 1_024 }, () => Uint8Array.from({ length: 64 }, (_, i) => sourceFlags[i % 8]));
const lowerChunks = Array.from({ length: 1_024 }, () => new Uint8Array(64).fill(8));
const layered = collision(Buffer.from(encodeCollision(lowerChunks)), collision(Buffer.from(encodeCollision(sourceChunks))));

assert.deepEqual([...layered[1].slice(0, 8)], [8, 33, 34, 63, 255, 0, 1, 8]);
assert.deepEqual([...collision(Buffer.from(encodeCollision(sourceChunks)))[1].slice(0, 8)], sourceFlags);

const originalNow = Date.now;
let clock = 1_000_000;
let observeClock;

/**
 * Supplies the isolated host fixture clock.
 *
 * @returns {number} Fixture epoch milliseconds.
 */
Date.now = () => {
    observeClock?.();

    return clock;
};

/**
 * Creates a transport-level owner using the actual candidate service and codecs.
 *
 * @param {Array<number>} [bounds] - Original metadata x, y, width and height.
 * @returns {Promise<object>} Service calls and in-memory IO observations.
 */
async function fixture(bounds = [0, 0, 1, 1]) {
    const files = new Map();
    const writes = [];
    let failure;
    let reads = 0;
    const service = createPopulationNatives();
    const transport = {
        /**
         * Models binding the isolated in-memory transport owner.
         *
         * @param {string} root - Original owned save root.
         */
        openOwnedRoot(root) {
            assert.equal(root, '/files/test/cache/Saves/Sandbox/Owned');
        },
        /**
         * Reads actual retained fixture bytes.
         *
         * @param {string} file - Owned relative filename.
         * @returns {string} Actual fixture hex bytes or genuine absence.
         */
        readOwned(file) {
            reads++;

            return files.get(file) ?? '';
        },
        /**
         * Writes fixture bytes or throws the selected real transport failure.
         *
         * @param {string} file - Owned relative filename.
         * @param {string} bytes - Actual codec output.
         * @param {boolean} atomic - Original allocator replacement policy.
         */
        writeOwned(file, bytes, atomic) {
            if (failure) {
                throw failure;
            }

            writes.push({ file, bytes, atomic });
            files.set(file, bytes);
        },
        /**
         * Models the existing Java transport by copying actual encoded record bytes.
         *
         * @param {Buffer} target - Owned test buffer.
         * @param {string} encoded - Actual candidate publication bytes.
         * @returns {number} Whole records copied.
         */
        writeRecords(target, encoded) {
            const bytes = Buffer.from(encoded, 'hex');

            assert.equal(bytes.length % 33, 0);
            assert.ok(target.length >= bytes.length);
            bytes.copy(target);

            return bytes.length / 33;
        },
        /**
         * Transports actual fixture outfit names.
         *
         * @param {Array<string>} values - Original ordered names.
         * @returns {string} Newline-delimited names.
         */
        names(values) {
            return values.join('\n');
        },
        /**
         * Carries authored integer-array arguments in the actual transport format.
         *
         * @param {Array<number>} values - Ordered integers.
         * @returns {string} Comma-delimited integers.
         */
        integers(values) {
            return values.join(',');
        },
        /**
         * Carries authored float-array arguments in the actual transport format.
         *
         * @param {Array<number>} values - Ordered float values.
         * @returns {string} Comma-delimited values.
         */
        floats(values) {
            return values.join(',');
        },
    };
    const lib = { port: { host: { PopulationBuffers: transport } }, java: { lang: { UnsupportedOperationException: Error } } };
    /**
     * Calls one actual candidate JNI selector.
     *
     * @param {string} name - Original selector suffix.
     * @param {...unknown} args - Original arguments.
     * @returns {Promise<unknown>} Serialized native-host result.
     */
    const m = (name, ...args) => service.natives[`Java_zombie_MapCollisionData_n_1${name}`](lib, ...args);
    /**
     * Calls one actual candidate JNI selector.
     *
     * @param {string} name - Original selector suffix.
     * @param {...unknown} args - Original arguments.
     * @returns {Promise<unknown>} Serialized native-host result.
     */
    const z = (name, ...args) => service.natives[`Java_zombie_popman_ZombiePopulationManager_n_1${name}`](lib, ...args);

    await m('setGameState', 'Core.GameMode', 'Sandbox');
    await m('setGameState', 'Core.GameSaveWorld', 'Owned');
    await m('setGameState', 'GameWindow.GameModeCacheDir', '/files/test/cache/Saves/Sandbox');
    await m('setGameState', 'Core.noSave', false);
    await m('setGameState', 'PAUSED', true);
    await m('setGameState', 'SandboxOptions.Distribution', 1);
    await m('initMetaGrid', ...bounds);
    await m('init', ...bounds);
    await z('init', false, false, ...bounds);
    await z('setOutfitNames', []);

    return {
        service, m, z, files, writes,
        /**
         * Counts actual owned-file reads without exposing service state.
         *
         * @returns {number} Transport read count.
         */
        reads() {
            return reads;
        }, /**
            * Selects the actual transport failure object for subsequent IO.
            *
            * @param {Error} error - Error whose identity must propagate.
            */
        fail(error) {
            failure = error;
        },
    };
}

try {
    // Manual pre-worker snapshot preserves pending commands, release wins, original write order.
    const pending = await fixture();

    await pending.z('registerZombie', 1, 2, 0, 0, 0, 0, 11);
    await pending.z('registerZombie', 3, 4, 0, 0, 0, 0, 12);
    await pending.z('releaseZombie', 11);
    const before = pending.service.diagnostics();

    await pending.z('save');
    const after = pending.service.diagnostics();

    assert.equal(after.pending, before.pending);
    assert.equal(after.updates, 0);
    assert.equal(after.registered, 0);
    assert.equal(after.saveDeadline, before.saveDeadline);
    assert.deepEqual(pending.writes.map((entry) => entry.file), ['zpop/zpop_ids.bin', 'zpop/zpop_virtual.bin', 'zpop/zpop_0_0.bin']);
    const cell = decodeCell(Uint8Array.from(Buffer.from(pending.files.get('zpop/zpop_0_0.bin'), 'hex')));

    assert.deepEqual(cell.chunks.flatMap((chunk) => chunk.records).map((record) => record.id), [12]);
    assert.deepEqual(cell.scalars, [0, 0]);

    // Genuine codec input is moved by the actual worker into pending output, then saved without consuming it.
    const output = await fixture();

    output.files.set('zpop/zpop_0_0.bin', pending.files.get('zpop/zpop_0_0.bin'));
    await output.z('configFloat', 'RedistributeHours', 12);
    await output.z('updateMain', 1, 0);
    await output.z('loadChunk', 0, 0, true);
    await output.z('hasDataForThread');
    await output.z('updateThread');
    const outputBefore = output.service.diagnostics();

    assert.equal(outputBefore.pendingOutput, 1);
    await output.z('save');
    const outputAfter = output.service.diagnostics();

    assert.equal(outputAfter.pendingOutput, 1);
    assert.equal(outputAfter.updates, outputBefore.updates);
    const restored = decodeCell(Uint8Array.from(Buffer.from(output.files.get('zpop/zpop_0_0.bin'), 'hex')));

    assert.deepEqual(restored.chunks.flatMap((chunk) => chunk.records).map((record) => record.id), [12]);
    // MAIN-owned publication is excluded from save and remains available to its consumer.
    const mainOutput = await fixture();

    mainOutput.files.set('zpop/zpop_0_0.bin', pending.files.get('zpop/zpop_0_0.bin'));
    await mainOutput.z('configFloat', 'RedistributeHours', 12);
    await mainOutput.z('updateMain', 1, 0);
    await mainOutput.z('loadChunk', 0, 0, true);
    await mainOutput.z('hasDataForThread');
    await mainOutput.z('updateThread');
    await mainOutput.z('updateMain', 1, 0);
    assert.equal(await mainOutput.z('getAddZombieCount'), 1);
    await mainOutput.z('save');
    assert.equal(await mainOutput.z('getAddZombieCount'), 1);
    const excluded = decodeCell(Uint8Array.from(Buffer.from(mainOutput.files.get('zpop/zpop_0_0.bin'), 'hex')));

    assert.deepEqual(excluded.chunks.flatMap((chunk) => chunk.records), []);
    assert.equal(mainOutput.service.diagnostics().mainFront, 1);
    assert.equal(mainOutput.service.diagnostics().pendingOutput, 0);
    const delivered = Buffer.alloc(33);

    assert.equal(await mainOutput.z('getAddZombieData', 0, delivered), 1);
    assert.equal(delivered.readInt32BE(29), 12);
    await assert.rejects(mainOutput.z('getAddZombieData', 0, delivered), /re-reading freed native record/u);

    // Selected saves preserve cell binding order and exclude pending registrations.
    const selected = await fixture([0, 0, 2, 1]);

    await selected.z('configFloat', 'RedistributeHours', 12);
    await selected.z('updateMain', 1, 0);
    await selected.z('loadChunk', 0, 0, false);
    await selected.z('loadChunk', 32, 0, false);
    await selected.z('hasDataForThread');
    await selected.z('updateThread');
    await selected.z('registerZombie', 1, 2, 0, 0, 0, 0, 300);
    await selected.z('registerZombie', 3, 4, 0, 0, 0, 0, 301);
    await selected.z('hasDataForThread');
    await selected.z('updateThread');
    await selected.z('save');
    const otherCell = selected.files.get('zpop/zpop_1_0.bin');
    /**
     * Reads actual serialized cell order from the existing codec.
     *
     * @returns {Array<number>} Ordered persistent record IDs.
     */
    const selectedIDs = () => decodeCell(Buffer.from(selected.files.get('zpop/zpop_0_0.bin'), 'hex')).chunks.flatMap((chunk) => chunk.records).map((record) => record.id);

    await selected.z('updateRealZombies', 1, [300, 0], [5, 6, 0]);
    await selected.z('hasDataForThread');
    await selected.z('updateThread');
    await selected.z('saveCell', 0, 0);
    assert.deepEqual(selectedIDs(), [300, 301]);
    await selected.z('updateRealZombies', 1, [300, 0], [6, 7, 0]);
    await selected.z('save');
    await selected.z('hasDataForThread');
    await selected.z('updateThread');
    await selected.z('saveCell', 0, 0);
    assert.deepEqual(selectedIDs(), [300, 301]);
    await selected.z('updateRealZombies', 1, [300, 0], [257, 2, 0]);
    await selected.z('hasDataForThread');
    await selected.z('updateThread');
    await selected.z('updateRealZombies', 1, [300, 0], [1, 2, 0]);
    await selected.z('hasDataForThread');
    await selected.z('updateThread');
    await selected.z('saveCell', 0, 0);
    assert.deepEqual(selectedIDs(), [301, 300]);
    await selected.z('registerZombie', 7, 7, 0, 0, 0, 0, 900);
    await selected.z('hasDataForThread');
    await selected.z('updateThread');
    const queuedID = await selected.z('registerZombie', 5, 5, 0, 0, 0, 0, 0);

    selected.writes.length = 0;
    await selected.z('saveCell', 0, 0);
    assert.deepEqual(selected.writes.map((entry) => entry.file), ['zpop/zpop_ids.bin', 'zpop/zpop_0_0.bin']);
    assert.deepEqual(selectedIDs(), [301, 300, 900]);
    assert.equal(selectedIDs().includes(queuedID), false);
    assert.equal(selected.service.diagnostics().pending, 1);
    assert.equal(selected.files.get('zpop/zpop_1_0.bin'), otherCell);
    selected.writes.length = 0;
    await selected.z('saveCell', 0, 0);
    await selected.z('saveCell', 2, 0);
    assert.deepEqual(selected.writes, []);

    // Selected dirty clears before allocator I/O, and the real failure poisons the owner.
    await selected.z('hasDataForThread');
    await selected.z('updateThread');
    await selected.z('registerZombie', 6, 6, 0, 0, 0, 0, 0);
    const selectedFailure = new Error('selected allocator replacement failed');

    selected.fail(selectedFailure);
    await assert.rejects(selected.z('saveCell', 0, 0), (error) => error === selectedFailure);
    assert.equal(selected.service.diagnostics().dirtyPopulationCells.includes('0,0'), false);
    await assert.rejects(selected.z('saveCell', 0, 0), /terminal persistence owner/u);

    // Cached clean allocator/virtual state avoids unconditional writes.
    const clean = await fixture();

    await clean.z('save');
    const firstWrites = clean.writes.length;

    await clean.z('save');
    assert.equal(clean.writes.length, firstWrites);
    const deadline = clean.service.diagnostics().saveDeadline;

    await clean.z('configFloat', 'RedistributeHours', 12);
    await clean.z('updateMain', 1, 0);
    await clean.z('hasDataForThread');
    clock = deadline + 1;
    await clean.z('updateThread');
    assert.equal(clean.service.diagnostics().saveDeadline, deadline);
    await clean.m('setGameState', 'PAUSED', false);
    clock = deadline;
    await clean.z('updateThread');
    assert.equal(clean.service.diagnostics().saveDeadline, deadline);
    clock++;
    await clean.z('updateThread');
    assert.equal(clean.service.diagnostics().saveDeadline, clock + 300_000);
    assert.equal(clean.service.diagnostics().successfulSaves, 3);

    // Observe collection through the real config map; clock sampling must follow it exactly once.
    await clean.z('configFloat', 'RedistributeHours', 13);
    await clean.z('hasDataForThread');
    const OriginalMap = globalThis.Map;
    let collected = false;
    let clockReads = 0;

    /** Observes real next-config collection without changing existing maps. */
    class ObservedConfigMap extends OriginalMap {
        /**
         * Retains ordinary map insertion while recording the queued config value.
         *
         * @param {unknown} name - Actual map key.
         * @param {unknown} value - Actual map value.
         * @returns {Map} Actual map owner.
         */
        set(name, value) {
            if (name === 'RedistributeHours' && value === 13) {
                collected = true;
            }

            return super.set(name, value);
        }
    }

    globalThis.Map = ObservedConfigMap;

    /** Asserts the actual sample follows collected configuration. */
    observeClock = () => {
        assert.equal(collected, true, 'Queued config must be collected before the worker clock sample');
        clockReads++;
    };

    try {
        clock = clean.service.diagnostics().saveDeadline + 1;
        await clean.z('updateThread');
        assert.equal(clockReads, 1);
        assert.equal(clean.service.diagnostics().saveDeadline, clock + 300_000);
    } finally {
        observeClock = undefined;
        globalThis.Map = OriginalMap;
    }

    // Authored codec seed; later-age replay admits only cells already loaded at age2.
    const originalNext = NativeMT.prototype.next;
    let draws = 0;

    /**
     * Counts actual draws while preserving the native recurrence operation.
     *
     * @returns {number} Original recurrence output.
     */
    NativeMT.prototype.next = function () {
        draws++;

        return originalNext.call(this);
    };

    /**
     * Checks one rejected worker destination with a separate transport owner.
     *
     * @param {string} mode - Register or known feedback destination.
     * @returns {Promise<void>} Completion of actual service assertions.
     */
    async function lateAgeGuard(mode) {
        const owner = await fixture([0, 0, 2, 1]);

        try {
            owner.files.set('zpop/zpop_0_0.bin', pending.files.get('zpop/zpop_0_0.bin'));
            await owner.z('configFloat', 'RedistributeHours', 12);
            await owner.z('updateMain', 1, 2);
            await owner.z('loadChunk', 0, 0, false);
            await owner.z('registerZombie', 1, 2, 0, 0, 0, 0, 30);
            await owner.z('hasDataForThread');
            await owner.z('updateThread');
            await owner.z('updateMain', 1, 3);
            await owner.z('loadChunk', 0, 0, false);
            await owner.z('hasDataForThread');
            await owner.z('updateThread');
            assert.equal(owner.service.diagnostics().cells, 1, 'Loaded age3 cell accepted');
            const beforeTime = owner.service.diagnostics();

            await assert.rejects(owner.z('updateMain', 1, 3.01), /time outside qualified/u);
            const afterTime = owner.service.diagnostics();

            for (const field of ['cells', 'metadataCells', 'nextID', 'pending', 'updates']) {
                assert.deepEqual(afterTime[field], beforeTime[field], field);
            }

            if (mode === 'register') {
                await owner.z('registerZombie', 257, 2, 0, 0, 0, 0, 31);
            } else {
                await owner.z('updateRealZombies', 1, [30, 0], [257, 2, 0]);
            }

            await owner.z('hasDataForThread');
            const before = owner.service.diagnostics();
            const readCount = owner.reads();
            const files = [...owner.files];

            await assert.rejects(owner.z('updateThread'), /later-age replay requires an already-loaded cell/u);
            const after = owner.service.diagnostics();

            for (const field of ['cells', 'metadataCells', 'registered', 'nextID', 'pending', 'updates', 'dirtyPopulationCells', 'successfulSaves']) {
                assert.deepEqual(after[field], before[field], `${mode}:${field}`);
            }

            assert.equal(owner.reads(), readCount);
            assert.equal(draws, 0);
            assert.deepEqual([...owner.files], files);
        } finally {
            await owner.z('stop');
            await owner.m('stop');
        }
    }

    try {
        await lateAgeGuard('register');
        await lateAgeGuard('feedback');
    } finally {
        NativeMT.prototype.next = originalNext;
    }

    // Actual transport exception is propagated unchanged, never a successful partial save/retry.
    const broken = await fixture();
    const actual = new Error('owned replacement failed');

    broken.fail(actual);
    await assert.rejects(broken.z('save'), (error) => error === actual);
    assert.equal(broken.service.diagnostics().successfulSaves, 0);
    assert.match(broken.service.diagnostics().terminalFailure, /owned replacement failed/u);
    await assert.rejects(broken.z('save'), /terminal persistence owner/u);
    await assert.rejects(broken.z('updateThread'), /terminal persistence owner/u);
    console.info('POPULATION_AUTOSAVE_HOST_ASSERTIONS_PASS');
} finally {
    Date.now = originalNow;
}
