import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createEngine } from '../src/engine.js';
import { createSaveStore, validateSave } from '../src/saves.js';
import { completeActions, importPickupSquares } from './queue-test-helpers.js';

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
    importPickupSquares(engine, engine.snapshot().x, engine.snapshot().y);
    const payload = {
        format: 'pz-web-save', formatVersion: 1, id: 'test-save', revision: 1,
        engine: { abiVersion: 1, state: { version: 1, values: engine.saveState().values.slice(0, 10) } },
        world: { cells: [{ x: 0, y: 0, bytes: Buffer.from(cells).toString('base64') }] },
        contentPacks: [], mods: [], modState: { absent: { schemaVersion: 1, data: { retained: true } } },
    };

    return { engine, record: await signed(payload), store: createSaveStore({ engineSource: bytes, appVersion: 'test' }) };
}

/**
 * Encodes a WASM section length, export count or function body length.
 *
 * @param {number} value - Unsigned integer to encode.
 * @returns {number[]} Unsigned LEB128 bytes.
 */
function encode(value) {
    const result = [];

    do {
        const byte = value & 127;

        value >>>= 7;
        result.push(byte | (value ? 128 : 0));
    } while (value);

    return result;
}

/**
 * Remove optional body/hand exports or trap their native reader in the real module.
 * Like engine.test.js's legacyModule fixture, only WASM sections are changed.
 *
 * @param {Uint8Array} bytes - Compiled engine module.
 * @param {'pre-body' | 'trap' | 'pre-hand' | 'hand-trap'} mode - Native capability or capture failure.
 * @returns {Uint8Array} Independent native module fixture.
 */
function bodyModule(bytes, mode) {
    const output = [...bytes.subarray(0, 8)];
    let offset = 8;
    let bodyReader;
    /**
     * Reads an unsigned LEB128 word and advances the section cursor.
     *
     * @returns {number} Decoded unsigned integer.
     */
    const unsigned = () => {
        let value = 0;
        let shift = 0;
        let byte;

        do {
            byte = bytes[offset++];
            value |= (byte & 127) << shift;
            shift += 7;
        } while (byte & 128);

        return value;
    };

    while (offset < bytes.length) {
        const start = offset;
        const id = bytes[offset++];
        const length = unsigned();
        const end = offset + length;

        if (id === 7) {
            const count = unsigned();
            const entries = [];

            for (let index = 0; index < count; index++) {
                const entry = offset;
                const nameLength = unsigned();
                const name = new TextDecoder().decode(bytes.subarray(offset, offset + nameLength));

                offset += nameLength;
                const kind = bytes[offset++];
                const target = unsigned();

                if (name === (mode === 'hand-trap' ? 'hand_item_get' : 'body_part_value') && kind === 0) {
                    bodyReader = target;
                }

                if ((mode !== 'pre-body' || !(name.startsWith('body_')
                    || name === 'thermal_action_modifier' || name === 'set_injury_severity'))
                && (mode !== 'pre-hand' || !name.startsWith('hand_item'))) {
                    entries.push(bytes.subarray(entry, offset));
                }
            }

            const payload = [...encode(entries.length), ...entries.flatMap((entry) => [...entry])];

            output.push(id, ...encode(payload.length), ...payload);
        } else if (id === 10 && (mode === 'trap' || mode === 'hand-trap')) {
            const count = unsigned();
            const payload = [...encode(count)];

            assert.notEqual(bodyReader, undefined, 'fixture requires the native capture reader export');

            /* createEngine instantiates without imports, so export function
               indices identify the corresponding code bodies directly. */
            for (let index = 0; index < count; index++) {
                const size = unsigned();
                const body = index === bodyReader ? [0, 0, 0x0B] : bytes.subarray(offset, offset + size);

                payload.push(...encode(body.length));

                for (const byte of body) {
                    payload.push(byte);
                }

                offset += size;
            }

            output.push(id, ...encode(payload.length));

            for (const byte of payload) {
                output.push(byte);
            }
        } else {
            for (const byte of bytes.subarray(start, end)) {
                output.push(byte);
            }
        }

        offset = end;
    }

    return new Uint8Array(output);
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

test('portable inventory preserves f32 pickup eligibility when pickup order differs from spawn IDs', async () => {
    const { engine, record, store } = await fixture();

    engine.command({ type: 'cancel' });
    const actor = engine.snapshot();
    const weights = [0.000_001, 0.000_001, 49.994_995, 0.009];
    const ids = weights.map((weight, index) => {
        const fullType = `Synthetic.OrderWeight${index}`;

        engine.registerItemDefinition({
            fullType, weight, bodyLocation: 'base:shoes', conditionMax: 1, stackLimit: 1,
            removeOnBroken: false, conditionLowerChanceOneIn: 1,
        }, { owner: 'test' });

        return engine.command({ type: 'spawnItem', fullType, x: actor.x, y: actor.y }).id;
    });

    for (const id of [ids[2], ids[0], ids[1]]) {
        engine.command({ type: 'pickup', id });
        completeActions(engine);
    }

    const before = engine.inventoryState().capacityWeight;
    const cells = record.world.cells.map((cell) => ({
        x: cell.x, y: cell.y, bytes: new Uint8Array(Buffer.from(cell.bytes, 'base64')),
    }));
    const exported = await store.exportLive(engine, { cells });
    const restored = await store.restore(JSON.parse(await exported.text()));

    assert.equal(restored.engine.inventoryState().capacityWeight, before);
    importPickupSquares(restored.engine, restored.engine.snapshot().x, restored.engine.snapshot().y);
    engine.command({ type: 'pickup', id: ids[3] });
    completeActions(engine);
    restored.engine.command({ type: 'pickup', id: ids[3] });
    completeActions(restored.engine);
    assert.equal(restored.engine.inventoryState().capacityWeight, engine.inventoryState().capacityWeight);
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
    completeActions(engine);
    engine.command({ type: 'moveTo', x: 24.5, y: 18.5 });
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

test('portable save restores tagged native handwear without a stored actor glove flag', async () => {
    const { engine, record, store } = await fixture();

    engine.registerItemDefinition({
        fullType: 'Synthetic.Gloves', bodyLocation: 'base:hands', conditionMax: 10,
        stackLimit: 1, removeOnBroken: false, conditionLowerChanceOneIn: 10,
        tags: ['base:awkwardgloves', 'fixture:portable'],
    }, { owner: 'test' });
    const actor = engine.snapshot();
    const id = engine.command({ type: 'spawnItem', fullType: 'Synthetic.Gloves', x: actor.x, y: actor.y }).id;

    engine.command({ type: 'pickup', id });
    completeActions(engine);
    engine.command({ type: 'wear', id });
    assert.equal(engine.isWearingAwkwardGloves(), true);
    const cells = record.world.cells.map((cell) => ({
        x: cell.x, y: cell.y, bytes: new Uint8Array(Buffer.from(cell.bytes, 'base64')),
    }));
    const exported = JSON.parse(await (await store.exportLive(engine, { cells })).text());
    const restored = await store.restore(exported);

    assert.deepEqual(restored.engine.itemDefinitions()[0].tags, ['base:awkwardgloves', 'fixture:portable']);
    assert.equal(restored.engine.wornItem('base:hands').id, id);
    assert.equal(restored.engine.isWearingAwkwardGloves(), true);
    assert.deepEqual(restored.engine.items(), engine.items());
    assert.equal(restored.engine.saveState().values.length, 12, 'actor persistence has no additional glove flag');
    restored.engine.command({ type: 'unequip', id });
    assert.equal(restored.engine.isWearingAwkwardGloves(), false);
    restored.engine.command({ type: 'wear', id });
    assert.equal(restored.engine.isWearingAwkwardGloves(), true);
    assert.equal(engine.isWearingAwkwardGloves(), true, 'restored inventory mutations are isolated');
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
                reachWalls: { north: false, west: false },
                solidFloor: true,
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
    completeActions(engine);
    engine.toggleDoor(rows[0].id);
    completeActions(engine);
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
    completeActions(restored.engine);
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

test('portable body injuries and cold nodes survive real export restore without expanding actor words', async () => {
    const { engine, record, store } = await fixture();

    engine.command({
        type: 'setBodyPart', part: 'Hand_L',
        values: { scratchTime: 10, bandaged: true, skinTemperature: 20 },
    });
    engine.command({ type: 'setInjurySeverity', severity: 'high' });
    const exported = JSON.parse(await (await store.exportLive(engine, {
        cells: [{ x: 0, y: 0, bytes: Buffer.from(record.world.cells[0].bytes, 'base64') }],
    })).text());
    const restored = await store.restore(exported);

    assert.equal(exported.engine.state.values.length, 12);
    assert.deepEqual(restored.engine.bodyParts(), engine.bodyParts());
    assert.equal(restored.engine.thermalActionModifier(), engine.thermalActionModifier());
    const before = engine.saveBodyState();

    exported.bodyState.parts[0].scratchTime = 80;
    await assert.rejects(store.restore(exported), /integrity/u);
    assert.deepEqual(engine.saveBodyState(), before);
    const invalid = structuredClone(exported);

    delete invalid.integrity;
    invalid.bodyState.parts[1].id = invalid.bodyState.parts[0].id;
    await assert.rejects(store.restore(await signed(invalid)));
    assert.deepEqual(engine.saveBodyState(), before);
    const legacy = await store.restore(record);

    legacy.engine.command({ type: 'setBodyPart', part: 'Hand_L', values: { scratchTime: 10 } });
    assert.equal(legacy.engine.bodyParts().find((part) => part.id === 'Hand_L').pain, 17);
    assert.equal(Object.hasOwn(legacy.record, 'bodyState'), false);
});

test('pre-body ABI1 native modules still export and restore portable saves without body state', async () => {
    const bytes = bodyModule(await readFile(new URL(
        '../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url,
    )), 'pre-body');
    const engine = await createEngine(bytes);
    const store = createSaveStore({ engineSource: bytes, appVersion: 'test' });
    const cells = new Uint8Array(1_026);

    cells[1] = 1;
    engine.worldImportCell(0, 0, cells);
    engine.command({ type: 'moveTo', x: 24.5, y: 18.5 });
    engine.step(0.1);
    engine.command({ type: 'setMoodleInputs', inputs: { pain: 80, hunger: 0.8 } });
    const exported = JSON.parse(await (await store.exportLive(engine, {
        cells: [{ x: 0, y: 0, bytes: cells }], modState: { retained: { data: 42 } },
    })).text());
    const restored = await store.restore(exported);

    assert.equal(exported.engine.abiVersion, 1);
    assert.equal(exported.engine.state.values.length, 12);
    assert.equal(Object.hasOwn(exported, 'bodyState'), false);
    assert.equal(Object.hasOwn(restored.record, 'bodyState'), false);
    assert.deepEqual(restored.record.modState, { retained: { data: 42 } });
    assert.deepEqual(restored.engine.saveState(), engine.saveState());
    assert.deepEqual(restored.engine.saveMoodleState(), engine.saveMoodleState());
    assert.throws(() => engine.saveBodyState(), /unsupported/u);
    engine.step(0.1);
    restored.engine.step(0.1);
    assert.deepEqual(restored.engine.snapshot(), engine.snapshot());
});

test('native body capture traps propagate through save and live export instead of omitting body state', async () => {
    const bytes = bodyModule(await readFile(new URL(
        '../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url,
    )), 'trap');
    const engine = await createEngine(bytes);
    const store = createSaveStore({ engineSource: bytes, appVersion: 'test' });
    const before = engine.saveState();

    const { canSaveBodyState, ...customEngine } = engine;

    assert.equal(canSaveBodyState(), true);

    await Promise.all([engine, customEngine].map((handle) => {
        assert.throws(() => store.save(handle), WebAssembly.RuntimeError);

        return assert.rejects(store.exportLive(handle), WebAssembly.RuntimeError);
    }));

    assert.deepEqual(engine.saveState(), before);
});

test('portable queue payload stages native progress after source geometry and rejects corrupt bytes atomically', async () => {
    const { engine, record, store } = await fixture();

    engine.command({ type: 'cancel' });
    engine.registerItemDefinition({
        fullType: 'Synthetic.Queue', bodyLocation: null,
        conditionMax: 1, stackLimit: 1, removeOnBroken: false, conditionLowerChanceOneIn: 0,
        weight: 1,
    }, { owner: 'test' });
    const actor = engine.snapshot();
    const id = engine.command({ type: 'spawnItem', fullType: 'Synthetic.Queue', x: actor.x, y: actor.y }).id;

    engine.sourceTiming.setTrait('base:dextrous', true);
    engine.actions.requestPickup(id);
    engine.frameStep(1 / 60);
    const state = engine.actions.getState();
    const cells = record.world.cells.map((cell) => ({
        x: cell.x, y: cell.y, bytes: new Uint8Array(Buffer.from(cell.bytes, 'base64')),
    }));
    const exported = JSON.parse(await (await store.exportLive(engine, { cells })).text());

    assert.equal(exported.queue.version, 1);
    assert.equal(typeof exported.queue.bytes, 'string');
    const restored = await store.restore(exported);

    assert.equal(restored.engine.actions.getState().current, null, 'store does not restore actions before source identities');
    importPickupSquares(restored.engine, actor.x, actor.y);
    restored.engine.loadDoorState(restored.doorState);
    restored.engine.loadQueueState(restored.queueState);
    assert.deepEqual(restored.engine.actions.getState(), state);
    const corrupt = restored.queueState.slice();

    corrupt[0] ^= 255;
    assert.throws(() => restored.engine.loadQueueState(corrupt));
    assert.deepEqual(restored.engine.actions.getState(), state);
    assert.equal(engine.items()[0].location, 'ground');
    completeActions(restored.engine);
    assert.equal(restored.engine.items()[0].id, id);
    assert.equal(restored.engine.items()[0].location, 'inventory');
    engine.sourceActions.setSaveHook(() => {
        throw new Error('opaque source closure cannot be resumed');
    });
    await assert.rejects(() => store.exportLive(engine, { cells }), /opaque source closure/u);
    assert.deepEqual(engine.actions.getState(), state);
});

test('portable queue source owners are canonical exact records and cannot claim SDK work', async () => {
    const { engine, record, store } = await fixture();

    engine.command({ type: 'cancel' });
    const cells = record.world.cells.map((cell) => ({
        x: cell.x, y: cell.y, bytes: new Uint8Array(Buffer.from(cell.bytes, 'base64')),
    }));
    const exported = JSON.parse(await (await store.exportLive(engine, { cells })).text());

    assert.deepEqual(exported.queue.sourceOwners, []);
    const payload = structuredClone(exported);

    delete payload.integrity;
    payload.queue.sourceOwners = [{ actionId: 1, ownerId: 'pz-base-game' }, { actionId: 1, ownerId: 'other' }];
    const duplicate = await signed(payload);

    await assert.rejects(() => validateSave(duplicate), /owner mapping/u);
    const accepted = engine.actions.requestWalk({ x: 7, y: 5, z: 0 });
    const before = engine.actions.getState();

    engine.sourceActions.setOwnerExport(() => [{ actionId: accepted.actionId, ownerId: 'pz-base-game' }]);
    await assert.rejects(() => store.exportLive(engine, { cells }), /every native Lua action/u);
    assert.deepEqual(engine.actions.getState(), before);
});

test('portable held refs restore MAX pairs before source code and malformed payloads keep the live session', async () => {
    const { engine, record, store } = await fixture();
    const definition = {
        fullType: 'Base.HeldSave', conditionMax: 10, bodyLocation: null, stackLimit: 1,
        removeOnBroken: true, conditionLowerChanceOneIn: 0, weight: 10, tags: [],
    };

    engine.registerItemDefinition(definition, { owner: 'base' });
    const x = engine.snapshot().x;
    const y = engine.snapshot().y;

    engine.importItems([{
        id: 0xFF_FF_FF_FF, fullType: definition.fullType, location: 'inventory',
        x, y, condition: 10, count: 1, bodyLocation: null, weight: 10, actualWeight: 10,
    }]);
    engine.setHandItem('primary', 0xFF_FF_FF_FF);
    engine.setHandItem('secondary', 0xFF_FF_FF_FF);
    const exported = JSON.parse(await (await store.exportLive(engine, {
        cells: [{ x: 0, y: 0, bytes: Buffer.from(record.world.cells[0].bytes, 'base64') }],
        modState: record.modState,
    })).text());
    const restored = await store.restore(exported);

    assert.deepEqual(exported.handState, { version: 1, primary: 0xFF_FF_FF_FF, secondary: 0xFF_FF_FF_FF });
    assert.deepEqual(restored.engine.saveHandState(), engine.saveHandState());
    assert.equal(restored.engine.inventoryState().capacityWeight, 3);
    assert.equal(restored.engine.saveState().values.length, 12);
    assert.deepEqual(restored.record.modState, record.modState);
    const observed = [];

    const observerErrors = [];

    restored.engine.observeHandItems((event) => observed.push(event), (cause) => observerErrors.push(cause));
    restored.engine.setHandItem('primary', 0xFF_FF_FF_FF);
    assert.deepEqual(observed, [], 'source reassigning restored refs cannot replay OnEquip');
    assert.deepEqual(observerErrors, []);
    const tampered = structuredClone(exported);

    tampered.handState.primary = null;
    await assert.rejects(store.restore(tampered), /integrity/u);

    /**
     * Rejects one malformed pair without changing the live session.
     *
     * @param {object|null} handState - Candidate malformed held state.
     * @returns {Promise<void>} Completes the rejection and live-state assertion.
     */
    const rejectHandState = async (handState) => {
        const invalid = structuredClone(exported);

        delete invalid.integrity;
        invalid.handState = handState;
        await assert.rejects(store.restore(await signed(invalid)), /hand/iu);
        assert.deepEqual(engine.saveHandState(), exported.handState);
    };

    await rejectHandState(null);
    await rejectHandState({});
    await rejectHandState({ ...exported.handState, version: 2 });
    await rejectHandState({ ...exported.handState, extra: true });
    await rejectHandState({ ...exported.handState, primary: -1 });
    await rejectHandState({ ...exported.handState, primary: 0x1_00_00_00_00 });
    await rejectHandState({ ...exported.handState, secondary: 7 });

    const absent = structuredClone(exported);

    delete absent.integrity;
    delete absent.handState;
    assert.deepEqual((await store.restore(await signed(absent))).engine.getHandItems(), { primary: null, secondary: null });
    assert.deepEqual((await store.restore(record)).engine.getHandItems(), { primary: null, secondary: null });
});

test('actual pre-hand ABI1 omits held state while native held-reader traps cannot be hidden', async () => {
    const bytes = await readFile(new URL('../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url));
    const legacyBytes = bodyModule(bytes, 'pre-hand');
    const legacy = await createEngine(legacyBytes);
    const legacyStore = createSaveStore({ engineSource: legacyBytes, appVersion: 'test' });
    const legacyRecord = JSON.parse(await (await legacyStore.exportLive(legacy)).text());

    assert.equal(legacy.canSaveHandState(), false);
    assert.equal(Object.hasOwn(legacyRecord, 'handState'), false);
    assert.equal(Object.hasOwn((await legacyStore.restore(legacyRecord)).record, 'handState'), false);
    assert.throws(() => legacy.getHandItems(), /unsupported/u);
    const trapBytes = bodyModule(bytes, 'hand-trap');
    const trap = await createEngine(trapBytes);
    const trapStore = createSaveStore({ engineSource: trapBytes, appVersion: 'test' });

    assert.equal(trap.canSaveHandState(), true);
    assert.throws(() => trap.saveHandState(), WebAssembly.RuntimeError);
    await assert.rejects(trapStore.exportLive(trap), WebAssembly.RuntimeError);
    assert.throws(() => trapStore.save(trap), WebAssembly.RuntimeError);
});
