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
        engine: { abiVersion: 1, state: { version: 1, values: engine.saveState().values.slice(0, 10) } },
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

    payload.formatVersion = 3;
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

test('legacy migration preserves world and namespace history without mutating the signed backup', async () => {
    const { record, store } = await fixture();
    const payload = structuredClone(record);

    delete payload.integrity;

    payload.revision = 19;
    payload.modState.absent = { schemaVersion: 7, data: { retained: true, nested: { value: 42 } } };
    const legacy = await signed(payload);
    const before = structuredClone(legacy);
    const restored = await store.restore(legacy);

    assert.deepEqual(legacy, before);
    assert.equal(restored.record.revision, 19);
    assert.deepEqual(restored.record.world, before.world);
    assert.deepEqual(restored.record.modState, before.modState);
    assert.deepEqual(restored.engine.saveState().values.slice(0, 10), before.engine.state.values);
    assert.deepEqual((await validateSave(restored.record)).modState, before.modState);
    assert.deepEqual((await store.restore(restored.record)).engine.saveState(), restored.engine.saveState());

    const tampered = structuredClone(legacy);

    tampered.modState.absent.data.nested.value = 43;
    await assert.rejects(store.restore(tampered), /integrity/u);
});

test('portable inventory restores stable worn IDs and damaged condition without cancelling travel', async () => {
    const { engine, record, store } = await fixture();

    engine.registerItemDefinition({
        fullType: 'Synthetic.Sandals', bodyLocation: 'base:shoes', conditionMax: 6,
        stackLimit: 1, removeOnBroken: false, conditionLowerChanceOneIn: 2,
    }, { owner: 'test' });
    engine.freezeItemDefinitions();
    const actor = engine.snapshot();
    const spawned = engine.command({ type: 'spawnItem', fullType: 'Synthetic.Sandals', x: actor.x, y: actor.y });

    engine.command({ type: 'pickup', id: spawned.id });
    engine.command({ type: 'wear', id: spawned.id });
    engine.command({ type: 'setCondition', id: spawned.id, condition: 1 });
    const cells = record.world.cells.map((cell) => ({
        x: cell.x, y: cell.y, bytes: new Uint8Array(Buffer.from(cell.bytes, 'base64')),
    }));
    const exported = await store.exportLive(engine, { cells, modState: record.modState });
    const restored = await store.restore(JSON.parse(await exported.text()));
    const worn = restored.engine.wornItem('base:shoes');

    assert.equal(worn.id, spawned.id);
    assert.equal(worn.condition, 1);
    assert.equal(worn.fullType, 'Synthetic.Sandals');
    assert.deepEqual(restored.engine.items(), engine.items());
    assert.equal(restored.engine.snapshot().action, 1);
    engine.step(0.1);
    restored.engine.step(0.1);
    assert.deepEqual(restored.engine.snapshot(), engine.snapshot());
});

test('portable moodle inputs retain pain timing and reject signed invalid state atomically', async () => {
    const { engine, record, store } = await fixture();

    engine.command({ type: 'setMoodleInputs', inputs: { pain: 80, hunger: 0.8, cantSprint: true } });

    for (let index = 0; index < 119; index++) {
        engine.step(0.01);
    }

    const cells = record.world.cells.map((cell) => ({
        x: cell.x, y: cell.y, bytes: new Uint8Array(Buffer.from(cell.bytes, 'base64')),
    }));
    const exported = JSON.parse(await (await store.exportLive(engine, { cells })).text());
    const restored = await store.restore(exported);

    assert.deepEqual(restored.engine.saveMoodleState(), engine.saveMoodleState());
    engine.step(0.01);
    restored.engine.step(0.01);
    assert.deepEqual(restored.engine.moodles(), engine.moodles());
    assert.equal(restored.engine.moodles().find(({ id }) => id === 'base:pain').level, 4);
    const before = engine.saveMoodleState();
    const invalid = structuredClone(exported);

    delete invalid.integrity;
    invalid.moodleState.inputs.temperature = -1;
    await assert.rejects(store.restore(await signed(invalid)));
    assert.deepEqual(engine.saveMoodleState(), before);
});

/**
 * Build genuine native metadata; never load persisted rows without their source.
 *
 * @returns {Promise<object>} Independent compiled engine, store and source metadata.
 */
async function doorFixture() {
    const value = await fixture();
    const rows = [{
        id: 'door:10:10:0:0', x: 10, y: 10, z: 0, north: true,
        open: false, locked: true, lockedByKey: true, forceLocked: false,
        keyId: 42, roomId: 7, oppositeRoomId: -1, attachedE: false,
        attachedS: false, barricaded: false, independentWalls: 0,
        doubleDoor: 0, garageDoor: 0, interiorSide: false,
    }];
    const squares = [];

    for (let y = 7; y <= 14; y++) {
        for (let x = 7; x <= 14; x++) {
            squares.push({
                x, y, z: 0, roomId: x === 10 && y === 10 ? 7 : -1,
                outside: !(x === 10 && y === 10), solid: false, solidTrans: false,
                tree: false, independentWalls: 0, vehicleObstructed: false,
            });
        }
    }

    value.engine.importDoors(rows, { squares, seed: 0xFF_FF_FF_FF, lockedHouses: 4, initializeLocks: true });
    value.engine.loadState({ version: 2, values: [10.5, 10.5, 1.5, 10.5, 10.5, 0, 0, 0, 0, 1, 100, 1] });
    const cells = value.record.world.cells.map((cell) => ({
        x: cell.x, y: cell.y, bytes: new Uint8Array(Buffer.from(cell.bytes, 'base64')),
    }));

    return { ...value, rows, squares, cells };
}

test('portable door state preserves unlocked closure and RNG after matching source import', async () => {
    const { engine, store, rows, squares, cells } = await doorFixture();

    engine.toggleDoor(rows[0].id);
    engine.toggleDoor(rows[0].id);
    const exported = JSON.parse(await (await store.exportLive(engine, { cells })).text());

    assert.equal(exported.formatVersion, 2);
    assert.equal(exported.engine.state.values.length, 12);
    assert.equal(exported.doorState.seed, 0xFF_FF_FF_FF);
    assert.equal(exported.doorState.doors[0].locked, false);
    assert.equal(exported.doorState.doors[0].toggled, true);
    assert.equal(exported.doorState.doors[0].open, false);
    const restored = await store.restore(exported);

    assert.deepEqual(restored.doorState, engine.saveDoorState());
    assert.deepEqual(restored.engine.doors(), [], 'store must not perform a source-free door restore');
    restored.engine.importDoors(rows, { squares, seed: restored.doorState.seed, initializeLocks: false });
    restored.engine.loadDoorState(restored.doorState);
    assert.deepEqual(restored.engine.saveDoorState(), engine.saveDoorState());
    assert.throws(() => restored.engine.command({ type: 'walk', x: 0, y: -1 }), /blocked/u);
    restored.engine.toggleDoor(rows[0].id);
    restored.engine.command({ type: 'walk', x: 0, y: -1 });
    restored.engine.step(0.1);
    assert.ok(restored.engine.snapshot().y < 10.5, 'restored native portal changes actual movement');
    restored.doorState.doors[0].locked = true;
    assert.equal(exported.doorState.doors[0].locked, false, 'restored field is detached from exported bytes');
});

test('door state corruption fails integrity without changing the live native world', async () => {
    const { engine, store, cells } = await doorFixture();
    const exported = JSON.parse(await (await store.exportLive(engine, { cells })).text());
    const before = engine.saveDoorState();

    exported.doorState.doors[0].open = true;
    await assert.rejects(store.restore(exported), /integrity/u);
    assert.deepEqual(engine.saveDoorState(), before);
});

test('signed door state rejects malformed boundaries and duplicate identities before source import', async () => {
    const { engine, store, cells } = await doorFixture();
    const exported = JSON.parse(await (await store.exportLive(engine, { cells })).text());
    const before = engine.saveDoorState();
    const changes = [
        (state) => {
            state.version = 2;
        },
        (state) => {
            state.seed = 0;
        },
        (state) => {
            state.seed = 0x1_00_00_00_00;
        },
        (state) => {
            state.revision = -1;
        },
        (state) => {
            state.revision = 0x1_00_00_00_00;
        },
        (state) => {
            state.rngState = [1];
        },
        (state) => {
            state.rngState[1] = -1;
        },
        (state) => {
            state.rngState = Array.from({ length: 2 });
        },
        (state) => {
            state.lockedHouses = 7;
        },
        (state) => {
            state.doors[0].x = 25_856;
        },
        (state) => {
            state.doors[0].y = -25_601;
        },
        (state) => {
            state.doors[0].z = 32;
        },
        (state) => {
            state.doors[0].open = 1;
        },
        (state) => {
            state.doors[0].keyId = -2;
        },
        (state) => {
            state.doors[0].id = 'door:010:10:0:0';
        },
        (state) => {
            state.doors[0].toggled = 1;
        },
        (state) => {
            delete state.doors[0].toggled;
        },
        (state) => {
            state.doors[0].extra = true;
        },
        (state) => {
            state.doors.push({ ...state.doors[0] });
        },
        (state) => {
            state.extra = true;
        },
    ];

    await Promise.all(changes.map(async (change) => {
        const invalid = structuredClone(exported);

        delete invalid.integrity;
        change(invalid.doorState);
        await assert.rejects(store.restore(await signed(invalid)), /door/iu);
    }));

    const boundary = structuredClone(exported);

    delete boundary.integrity;
    Object.assign(boundary.doorState, { revision: 0xFF_FF_FF_FF, rngState: [0, 0xFF_FF_FF_FF], lockedHouses: 6 });
    Object.assign(boundary.doorState.doors[0], { x: -25_600, y: 25_855, z: -32, keyId: 0x7F_FF_FF_FF });
    assert.deepEqual((await validateSave(await signed(boundary))).doorState, boundary.doorState);
    assert.deepEqual(engine.saveDoorState(), before);
    assert.notDeepEqual(before.rngState, [0xFF_FF_FF_FF, 0], 'constructor consumes real native lock RNG');
});

test('legacy and current backups without door state retain explicit source initialization', async () => {
    const { record, store } = await fixture();
    const restored = await store.restore(record);

    assert.equal(Object.hasOwn(restored.record, 'doorState'), false);
    assert.equal(Object.hasOwn(restored, 'doorState'), false);
    const current = structuredClone(restored.record);

    assert.equal(current.formatVersion, 2);
    assert.equal(Object.hasOwn(await validateSave(current), 'doorState'), false);
    assert.equal(Object.hasOwn(await store.restore(current), 'doorState'), false);
});

test('door metadata mismatch fails staged native restore without altering the prior world', async () => {
    const { engine, store, rows, squares, cells } = await doorFixture();
    const before = engine.saveDoorState();
    const exported = JSON.parse(await (await store.exportLive(engine, { cells })).text());
    const staged = await store.restore(exported);

    staged.engine.importDoors([{ ...rows[0], id: 'door:10:10:0:1' }], {
        squares, seed: staged.doorState.seed, initializeLocks: false,
    });
    const candidateBefore = staged.engine.saveDoorState();

    assert.throws(() => staged.engine.loadDoorState(staged.doorState), /identit/iu);
    assert.deepEqual(staged.engine.saveDoorState(), candidateBefore);
    assert.deepEqual(engine.saveDoorState(), before);
});
