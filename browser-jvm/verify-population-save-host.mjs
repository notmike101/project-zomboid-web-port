import assert from 'node:assert/strict';
import { createPopulationNatives } from './population-natives.js';
import { decodeCell } from './population-save-codec.js';

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
 * @returns {Promise<object>} Service calls and in-memory IO observations.
 */
async function fixture() {
    const files = new Map();
    const writes = [];
    let failure;
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
    await m('initMetaGrid', 0, 0, 1, 1);
    await m('init', 0, 0, 1, 1);
    await z('init', false, false, 0, 0, 1, 1);
    await z('setOutfitNames', []);

    return {
        service, m, z, files, writes, /**
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
