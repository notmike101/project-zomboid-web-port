import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createEngine } from '../src/engine.js';
import { createSaveStore, validateSave } from '../src/saves.js';

/**
 * Sign a synthetic backup using the public file format, not store internals.
 *
 * @param {object} payload - Backup data.
 * @returns {Promise<object>} Signed envelope.
 */
async function signed(payload) {
    const text = JSON.stringify(payload, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
        : item);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));

    return { ...payload, integrity: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('') };
}

/**
 * Build a portable empty-cell backup with an in-flight destination.
 *
 * @returns {Promise<object>} Store, original engine and backup.
 */
async function fixture() {
    const bytes = await readFile(new URL('../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url));
    const engine = await createEngine(bytes);
    const cells = new Uint8Array(1_026);

    cells[1] = 1;
    engine.worldImportCell(0, 0, cells);
    engine.command({ type: 'moveTo', x: 24.5, y: 18.5 });
    engine.step(0.1);
    const payload = {
        format: 'pz-web-save', formatVersion: 1, id: 'test-save', revision: 1,
        engine: { abiVersion: 1, state: engine.saveState() },
        world: { cells: [{ x: 0, y: 0, bytes: Buffer.from(cells).toString('base64') }] },
        contentPacks: [], mods: [], modState: { absent: { schemaVersion: 1, data: { retained: true } } },
    };

    return { engine, record: await signed(payload), store: createSaveStore({ engineSource: bytes, appVersion: 'test' }) };
}

test('exported save restores movement continuation in an independent WASM instance', async () => {
    const { engine, record, store } = await fixture();
    const loaded = await store.restore(record);

    assert.deepEqual(loaded.engine.saveState(), engine.saveState());
    engine.step(0.1);
    loaded.engine.step(0.1);
    assert.deepEqual(loaded.engine.snapshot(), engine.snapshot());
    loaded.record.modState.absent.data.retained = false;
    assert.equal(record.modState.absent.data.retained, true);
    loaded.engine.command({ type: 'cancel' });
    assert.equal(engine.snapshot().action, 1);
});

test('damaged exported save is refused before restoration and leaves source session unchanged', async () => {
    const { engine, record, store } = await fixture();
    const before = engine.saveState();

    record.engine.state.values[0] += 2;
    await assert.rejects(store.restore(record), /integrity/u);
    assert.deepEqual(engine.saveState(), before);
});

test('integrity-valid malformed cell backup fails staged restoration', async () => {
    const { record, store } = await fixture();
    const payload = structuredClone(record);

    delete payload.integrity;

    payload.world.cells[0].bytes = Buffer.from([0, 1, 2]).toString('base64');
    await assert.rejects(store.restore(await signed(payload)), /truncat|record|cell/u);
});

test('future save format and duplicate cell coordinates are refused', async () => {
    const { record } = await fixture();
    const payload = structuredClone(record);

    delete payload.integrity;

    payload.formatVersion = 2;
    await assert.rejects(validateSave(await signed(payload)), /version/u);
    payload.formatVersion = 1;
    payload.world.cells.push({ ...payload.world.cells[0] });
    await assert.rejects(validateSave(await signed(payload)), /Duplicate/u);
});

test('live backup exports and restores without IndexedDB access', async () => {
    const { engine, record, store } = await fixture();
    const cells = record.world.cells.map((cell) => ({
        x: cell.x, y: cell.y, bytes: new Uint8Array(Buffer.from(cell.bytes, 'base64')),
    }));
    const exported = await store.exportLive(engine, { cells, modState: record.modState });
    const restored = await store.restore(JSON.parse(await exported.text()));

    assert.deepEqual(restored.engine.saveState(), engine.saveState());
    assert.deepEqual(restored.record.modState, record.modState);
});
