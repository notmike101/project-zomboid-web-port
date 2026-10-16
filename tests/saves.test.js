import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createEngine } from '../src/engine.js';
import { createSaveStore, SAVE_VERSION, validateSave } from '../src/saves.js';
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
    const group = engine.equipmentOperation('groupGet', 'Human', true);

    for (const name of ['Shoes', 'Hands']) {
        engine.equipmentOperation('locationAdd', group, engine.equipmentOperation('lookup', name));
    }

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

    const store = createSaveStore({
        engineSource: bytes, appVersion: 'test',
        /**
         * Declare fixture registry rules before importing legacy worn rows.
         *
         * @param {object} target - Fresh staged engine.
         */
        initializeEquipment(target) {
            const e = target.equipmentOperation;
            const human = e('groupGet', 'Human', true);

            for (const name of ['Shoes', 'Hands']) {
                e('locationAdd', human, e('lookup', name));
            }

            e('multiSet', human, e('lookup', 'Shoes'), true);
        },
    });

    return { engine, record: await signed(payload), store };
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
 * @param {'pre-body' | 'trap' | 'pre-hand' | 'hand-trap' | 'graph-trap' | 'pre-climate' | 'climate-trap'} mode - Actual native capability or capture failure.
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

                let trappedExport = 'body_part_value';

                switch (mode) {
                    case 'graph-trap': {
                        trappedExport = 'item_import_commit';

                        break;
                    }
                    case 'hand-trap': {
                        trappedExport = 'hand_item_get';

                        break;
                    }
                    case 'climate-trap': {
                        trappedExport = 'climate_save_size';

                        break;
                    }
                // No default
                }

                if (name === trappedExport && kind === 0) {
                    bodyReader = target;
                }

                if ((mode !== 'pre-body' || !(name.startsWith('body_')
                    || name === 'thermal_action_modifier' || name === 'set_injury_severity'))
                && (mode !== 'pre-hand' || !name.startsWith('hand_item'))
                && (mode !== 'pre-climate' || !name.startsWith('climate_'))) {
                    entries.push(bytes.subarray(entry, offset));
                }
            }

            const payload = [...encode(entries.length), ...entries.flatMap((entry) => [...entry])];

            output.push(id, ...encode(payload.length), ...payload);
        } else if (id === 10 && ['trap', 'hand-trap', 'graph-trap', 'climate-trap'].includes(mode)) {
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
    const payload = await validateSave(record);

    delete payload.integrity;

    payload.formatVersion = SAVE_VERSION + 1;
    await assert.rejects(validateSave(await signed(payload)), TypeError);
    payload.formatVersion = SAVE_VERSION;
    payload.world.cells.push({ ...payload.world.cells[0] });
    await assert.rejects(validateSave(await signed(payload)), TypeError);
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

    assert.equal(exported.formatVersion, 6);
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

    assert.equal(current.formatVersion, 6);
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

    assert.equal(exported.queue.version, 2);
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
    assert.notEqual(engine.items()[0].worldPosition, null);
    completeActions(restored.engine);
    assert.equal(restored.engine.items()[0].id, id);
    assert.equal(restored.engine.items()[0].ownerContainerId, restored.engine.playerInventoryId());
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

    engine.importInventoryGraph({
        ...engine.exportInventoryGraph(),
        items: [{
            id: 0xFF_FF_FF_FF, fullType: definition.fullType, definitionOrdinal: 0,
            ownerContainerId: engine.playerInventoryId(), internalContainerId: null, worldPosition: null,
            condition: 10, count: 1, bodyLocation: null, weight: 10, actualWeight: 10,
            favorite: false, consumed: false,
        }],
    });
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

test('portable equipment preserves custom identities, detached bound groups and same-slot worn order', async () => {
    const { engine, record, store } = await fixture();
    const e = engine.equipmentOperation;
    const location = e('register', 'Fixture:Layer');
    const group = e('groupGet', 'FixtureGroup', true);

    e('locationAdd', group, location);
    e('multiSet', group, location, true);
    const shoes = e('lookup', 'Shoes');

    e('locationAdd', group, shoes);
    e('relationSet', group, location, shoes, 3);
    e('relationSet', group, location, shoes, 1);
    e('relationSet', group, shoes, location, 2);
    e('wornGroupSet', group);
    e('reset');
    const active = e('groupGet', 'FixtureGroup', true);

    e('locationAdd', active, shoes);
    engine.registerItemDefinition({
        fullType: 'Fixture.Layer', bodyLocation: 'fixture:layer', canBeEquipped: 'Shoes',
        conditionMax: 10, stackLimit: 1, removeOnBroken: false, conditionLowerChanceOneIn: 0,
    }, { owner: 'fixture' });
    const rows = [1, 0xFF_FF_FF_FF].map((id) => ({
        id, fullType: 'Fixture.Layer', definitionOrdinal: 0, ownerContainerId: engine.playerInventoryId(),
        internalContainerId: null, worldPosition: null,
        condition: 10, count: 1, bodyLocation: 'fixture:layer', weight: 1, actualWeight: 1,
        favorite: false, consumed: false,
    }));

    engine.importInventoryGraph({ ...engine.exportInventoryGraph(), items: rows, wornOrder: [0xFF_FF_FF_FF, 1] });
    const cells = record.world.cells.map((cell) => ({
        x: cell.x, y: cell.y, bytes: new Uint8Array(Buffer.from(cell.bytes, 'base64')),
    }));
    const actor = engine.saveState();
    const exported = await store.exportLive(engine, { cells, modState: record.modState });
    const captured = JSON.parse(await exported.text());
    const restored = await store.restore(captured);

    assert.equal(captured.formatVersion, 6);
    assert.deepEqual(restored.engine.saveState(), actor);
    assert.equal(captured.equipmentState.version, 1);
    assert.equal(captured.equipmentState.groups.find(({ name }) => name === 'FixtureGroup').active, false);
    assert.deepEqual(restored.engine.wornItems(), [
        { id: 0xFF_FF_FF_FF, bodyLocation: 'fixture:layer' }, { id: 1, bodyLocation: 'fixture:layer' },
    ]);
    assert.notEqual(restored.engine.equipmentOperation('groupGet', 'FixtureGroup', false),
        restored.engine.equipmentOperation('wornGroupGet'), 'active same-name group must not replace detached binding');
    assert.deepEqual(restored.engine.saveEquipmentState(), engine.saveEquipmentState());
});

test('portable worn snapshots survive later multiplicity and exclusivity rule changes', async () => {
    const { engine, record, store } = await fixture();
    const e = engine.equipmentOperation;
    const group = e('wornGroupGet');
    const shoes = e('lookup', 'Shoes');
    const hands = e('lookup', 'Hands');

    e('multiSet', group, shoes, true);
    engine.registerItemDefinition({
        fullType: 'Fixture.RuleChange', bodyLocation: 'Shoes', conditionMax: 10,
        stackLimit: 1, removeOnBroken: false, conditionLowerChanceOneIn: 0, weight: 1,
    }, { owner: 'fixture' });
    const rows = [[1, 'Shoes'], [2, 'Shoes'], [3, 'Hands']].map(([id, bodyLocation]) => ({
        id, fullType: 'Fixture.RuleChange', definitionOrdinal: 0, ownerContainerId: 1,
        internalContainerId: null, worldPosition: null, condition: 10, count: 1,
        bodyLocation, weight: 1, actualWeight: 1, favorite: false, consumed: false,
    }));

    engine.importInventoryGraph({ ...engine.exportInventoryGraph(), items: rows, wornOrder: [2, 1, 3] });
    e('multiSet', group, shoes, false);
    e('relationSet', group, shoes, hands, 1);
    const exported = JSON.parse(await (await store.exportLive(engine, {
        cells: [{ x: 0, y: 0, bytes: Buffer.from(record.world.cells[0].bytes, 'base64') }],
    })).text());
    const restored = await store.restore(exported);

    assert.deepEqual(restored.engine.wornItems(), [
        { id: 2, bodyLocation: 'base:shoes' },
        { id: 1, bodyLocation: 'base:shoes' },
        { id: 3, bodyLocation: 'base:hands' },
    ]);
    assert.equal(restored.engine.equipmentOperation('multiGet', group, shoes), false);
    assert.equal(restored.engine.equipmentOperation('relationGet', group, shoes, hands, 1), true);
    assert.deepEqual(restored.engine.saveEquipmentState(), engine.saveEquipmentState());
    const missing = structuredClone(exported);

    delete missing.integrity;
    missing.inventoryGraph.items[0].bodyLocation = 'fixture:missing';
    await assert.rejects(validateSave(await signed(missing)), /equipment/iu);
    assert.deepEqual(engine.wornItems().map(({ id }) => id), [2, 1, 3]);
});

test('legacy equipment derives stable group-index order without preferred-location or blanket multi-slot rejection', async () => {
    const { engine, record, store } = await fixture();
    const e = engine.equipmentOperation;

    e('multiSet', e('wornGroupGet'), e('lookup', 'Shoes'), true);
    engine.registerItemDefinition({
        fullType: 'Fixture.Legacy', bodyLocation: 'Hands',
        conditionMax: 10, stackLimit: 1, removeOnBroken: false, conditionLowerChanceOneIn: 0,
    }, { owner: 'fixture' });
    const rows = [[3, 'Hands'], [1, 'Shoes'], [0xFF_FF_FF_FF, 'Shoes']].map(([id, bodyLocation]) => ({
        id, fullType: 'Fixture.Legacy', location: 'inventory', x: 5, y: 5,
        condition: 10, count: 1, bodyLocation, weight: 1, actualWeight: 1,
    }));

    engine.importInventoryGraph({
        ...engine.exportInventoryGraph(), wornOrder: undefined,
        items: rows.map((item) => ({
            id: item.id, fullType: item.fullType, condition: item.condition, count: item.count,
            bodyLocation: item.bodyLocation, weight: item.weight, actualWeight: item.actualWeight,
            definitionOrdinal: 0, ownerContainerId: engine.playerInventoryId(),
            internalContainerId: null, worldPosition: null, favorite: false, consumed: false,
        })),
    });
    const cells = record.world.cells.map((cell) => ({
        x: cell.x, y: cell.y, bytes: new Uint8Array(Buffer.from(cell.bytes, 'base64')),
    }));
    const actor = engine.saveState();
    const exported = await store.exportLive(engine, { cells });
    const payload = JSON.parse(await exported.text());

    delete payload.integrity;
    delete payload.equipmentState;
    delete payload.inventoryGraph;
    payload.formatVersion = 2;
    payload.items = rows;
    payload.itemDefs[0].bodyLocation = 'Hands';
    delete payload.itemDefs[0].canBeEquipped;
    const restored = await store.restore(await signed(payload));

    assert.deepEqual(restored.engine.saveState(), actor);
    assert.deepEqual(restored.engine.wornItems(), [
        { id: 1, bodyLocation: 'base:shoes' }, { id: 0xFF_FF_FF_FF, bodyLocation: 'base:shoes' },
        { id: 3, bodyLocation: 'base:hands' },
    ]);
    assert.equal(restored.engine.itemDefinitions()[0].bodyLocation, 'base:hands');
});

test('ordered graph backups preserve container allocator, nested ownership, traits and overcapacity', async () => {
    const { engine, record, store } = await fixture();

    engine.command({ type: 'cancel' });
    engine.registerItemDefinition({
        fullType: 'Fixture.SaveBag', weight: 1, bodyLocation: null, conditionMax: 10,
        stackLimit: 1, removeOnBroken: false, conditionLowerChanceOneIn: 0,
        isBag: true, capacity: 2, weightReduction: 50, maxItemSize: 10,
    }, { owner: 'fixture' });
    const graph = engine.exportInventoryGraph();
    const actor = graph.containers.find(({ kind }) => kind === 'actor');
    const bagContainer = {
        id: 7, kind: 'bag', parentKind: null, parentId: null, containingItemId: 11,
        capacity: 2, weightReduction: 50, worldPosition: null, explored: true, looted: false,
        definitionOrdinal: 0, type: 'container', onlyAcceptCategory: null, acceptItemFunction: null,
    };
    const shell = {
        id: 11, fullType: 'Fixture.SaveBag', definitionOrdinal: 0, ownerContainerId: actor.id,
        internalContainerId: 7, worldPosition: null, condition: 10, count: 1,
        bodyLocation: null, weight: 1, actualWeight: 1,
        favorite: true, consumed: false,
    };
    const inner = { ...bagContainer, id: 8, containingItemId: 13 };

    graph.containers.push(bagContainer, inner);
    graph.items = [
        shell, { ...shell, id: 13, ownerContainerId: 7, internalContainerId: 8, weight: 8, actualWeight: 8, consumed: true },
    ];
    Object.assign(graph, {
        nextContainerId: 95, organized: true, disorganized: true, equippedMultiplier: 0.25,
        dropItemsOnSquareCenter: true,
    });
    engine.importInventoryGraph(graph);
    const cells = [{ x: 0, y: 0, bytes: Buffer.from(record.world.cells[0].bytes, 'base64') }];
    const exported = JSON.parse(await (await store.exportLive(engine, { cells })).text());
    const restored = await store.restore(exported);

    assert.deepEqual(restored.engine.exportInventoryGraph(), engine.exportInventoryGraph());
    assert.equal(exported.inventoryGraph.nextContainerId, 95);
    const signedCapacity = structuredClone(exported);

    delete signedCapacity.integrity;
    signedCapacity.inventoryGraph.containers[1].capacity = -1;
    const restoredNegative = await store.restore(await signed(signedCapacity));

    assert.equal(restoredNegative.engine.getContainer(7).capacity, -1,
        'original signed stored capacity is structural state, not admission success');
    const spawned = restored.engine.command({ type: 'spawnItem', fullType: 'Fixture.SaveBag', x: 5, y: 5 });

    assert.equal(restored.engine.getItem(spawned.id).internalContainerId, 96,
        'new floor consumes allocator 95 before new bag consumes 96');
    const before = engine.exportInventoryGraph();
    const mutations = [
        (value) => {
            value.items[1].ownerContainerId = 999;
        },
        (value) => {
            value.items[0].internalContainerId = 8;
        },
        (value) => {
            value.items[0].ownerContainerId = 7;
        },
        (value) => {
            value.items[0].ownerContainerId = 8;
        },
        (value) => {
            value.items.push({ ...value.items[0] });
        },
        (value) => {
            value.containers.push({ ...value.containers[0] });
        },
        (value) => {
            value.items[1].worldPosition = { x: 5, y: 5, z: 0 };
        },
        (value) => {
            value.items[1].bodyLocation = 'base:shoes';
            value.wornOrder = [13];
        },
        (value) => {
            value.nextContainerId = 8;
        },
        (value) => {
            value.items[0].favorite = 1;
        },
        (value) => {
            value.dropItemsOnSquareCenter = 1;
        },
        (value) => {
            value.containers[0].parentId = 99;
        },
        (value) => {
            value.containers[1].containingItemId = 99;
        },
        (value) => {
            value.wornOrder = [13];
        },
        (value) => {
            value.items[0].location = 'inventory';
        },
        (value) => {
            value.containers.push({
                ...value.containers[0], id: 50, kind: 'floor', parentKind: 'square', parentId: 0,
                worldPosition: { x: 256, y: 0, z: 0 }, type: 'floor',
            });
        },
    ];

    await Promise.all(mutations.map(async (mutate) => {
        const invalid = structuredClone(exported);

        delete invalid.integrity;
        mutate(invalid.inventoryGraph);
        const invalidRecord = await signed(invalid);

        await Promise.all([
            assert.rejects(validateSave(invalidRecord), /inventory|container|graph|equipment/iu),
            assert.rejects(store.restore(invalidRecord)),
        ]);
        assert.deepEqual(engine.exportInventoryGraph(), before);
    }));

    const held = structuredClone(exported);

    delete held.integrity;
    held.handState = { version: 1, primary: 13, secondary: null };
    await assert.rejects(validateSave(await signed(held)), /hand/iu);
    const tampered = structuredClone(exported);

    tampered.inventoryGraph.equippedMultiplier = 0.5;
    await assert.rejects(store.restore(tampered), /integrity/u);
});

test('authenticated flat v2 migration preserves encounter order, real floor roots and unknown-owner refusal', async () => {
    const { engine, record, store } = await fixture();

    engine.registerItemDefinition({
        fullType: 'Fixture.Flat', weight: 1, bodyLocation: null, conditionMax: 10,
        stackLimit: 1, removeOnBroken: false, conditionLowerChanceOneIn: 0,
    }, { owner: 'fixture' });
    const payload = {
        ...record, formatVersion: 2, engine: { abiVersion: 1, state: engine.saveState() },
        itemDefs: engine.itemDefinitions(),
        items: [
            { id: 9, fullType: 'Fixture.Flat', location: 'ground', x: 5.5, y: 6.5, condition: 10, count: 1, bodyLocation: null },
            { id: 3, fullType: 'Fixture.Flat', location: 'inventory', x: 5.5, y: 6.5, condition: 10, count: 1, bodyLocation: null },
            { id: 7, fullType: 'Fixture.Flat', location: 'ground', x: 5.9, y: 6.1, condition: 10, count: 1, bodyLocation: null },
        ],
    };

    delete payload.integrity;
    payload.engine.state.values[11] = 10;
    const flat = await signed(payload);
    const unchanged = structuredClone(flat);
    const validated = await validateSave(flat);
    const restored = await store.restore(flat);

    assert.deepEqual(flat, unchanged);
    assert.deepEqual(validated.inventoryGraph.items.map(({ id }) => id), [9, 3, 7]);
    assert.deepEqual(validated.inventoryGraph.items.map(({ ownerContainerId }) => ownerContainerId), [2, 1, 2]);
    assert.equal(validated.inventoryGraph.nextContainerId, 3);
    assert.deepEqual(validated.inventoryGraph.containers[1].worldPosition, { x: 5, y: 6, z: 0 });
    assert.deepEqual(restored.engine.items().map(({ id }) => id), [9, 3, 7]);
    assert.equal(Object.hasOwn(restored.record, 'items'), false);
    flat.items[0].location = 'unknown';
    await assert.rejects(validateSave(flat), /integrity/u);
    await assert.rejects(validateSave(await signed({ ...payload, items: flat.items })), /inventory|item/iu);
});

test('required native graph import traps propagate without touching the live graph', async () => {
    const { engine, record, store } = await fixture();
    const exported = JSON.parse(await (await store.exportLive(engine, {
        cells: [{ x: 0, y: 0, bytes: Buffer.from(record.world.cells[0].bytes, 'base64') }],
    })).text());
    const bytes = bodyModule(await readFile(new URL(
        '../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url,
    )), 'graph-trap');
    const failing = createSaveStore({ engineSource: bytes, appVersion: 'test' });
    const before = engine.exportInventoryGraph();

    await assert.rejects(failing.restore(exported), WebAssembly.RuntimeError);
    assert.deepEqual(engine.exportInventoryGraph(), before);
});

test('portable transfer queue resumes immutable container intent after graph and source geometry restore', async () => {
    const { engine, record, store } = await fixture();

    engine.command({ type: 'cancel' });
    const definition = {
        bodyLocation: null, conditionMax: 10, stackLimit: 1,
        removeOnBroken: false, conditionLowerChanceOneIn: 0, weight: 1,
    };

    engine.registerItemDefinition({
        ...definition, fullType: 'Fixture.TransferBag', isBag: true,
        capacity: 20, weightReduction: 0, maxItemSize: 10,
    }, { owner: 'fixture' });
    engine.registerItemDefinition({ ...definition, fullType: 'Fixture.TransferItem' }, { owner: 'fixture' });
    const actor = engine.snapshot();
    const bagId = engine.command({ type: 'spawnItem', fullType: 'Fixture.TransferBag', x: actor.x, y: actor.y }).id;
    const itemId = engine.command({ type: 'spawnItem', fullType: 'Fixture.TransferItem', x: actor.x, y: actor.y }).id;

    for (const id of [bagId, itemId]) {
        engine.actions.requestPickup(id);
        completeActions(engine);
    }

    const destinationContainerId = engine.getItem(bagId).internalContainerId;
    const accepted = engine.actions.requestTransfer(itemId, engine.playerInventoryId(), destinationContainerId);

    assert.equal(accepted.accepted, true);
    engine.frameStep(1 / 60);
    const before = engine.actions.getState();
    const exported = JSON.parse(await (await store.exportLive(engine, {
        cells: [{ x: 0, y: 0, bytes: Buffer.from(record.world.cells[0].bytes, 'base64') }],
    })).text());
    const restored = await store.restore(exported);

    importPickupSquares(restored.engine, actor.x, actor.y);
    restored.engine.loadDoorState(restored.doorState);
    restored.engine.loadQueueState(restored.queueState);
    restored.engine.sourceActions.validateSourceOwners(restored.sourceOwners);
    assert.deepEqual(restored.engine.actions.getState(), before);
    assert.equal(restored.engine.actions.getState().current.destinationContainerId, destinationContainerId);
    completeActions(restored.engine);
    assert.equal(restored.engine.getItem(itemId).ownerContainerId, destinationContainerId);
    assert.deepEqual(restored.engine.containerItems(destinationContainerId).map(({ id }) => id), [itemId]);
    assert.equal(engine.getItem(itemId).ownerContainerId, engine.playerInventoryId());
});

test('supported original transfer actor traits and metabolic target survive authenticated native restore', async () => {
    const { engine, record, store } = await fixture();

    engine.sourceTiming.setTrait('base:hemophobic', true);
    engine.sourceActions.setMetabolicTarget(3.2);
    assert.equal(engine.sourceActions.getMetabolicTarget(), Math.fround(3.2));
    const exported = JSON.parse(await (await store.exportLive(engine, {
        cells: [{ x: 0, y: 0, bytes: Buffer.from(record.world.cells[0].bytes, 'base64') }],
    })).text());
    const restored = await store.restore(exported);

    assert.equal(exported.bodyState.metabolicTarget, Math.fround(3.2));
    assert.equal(restored.engine.sourceActions.getMetabolicTarget(), Math.fround(3.2));
    importPickupSquares(restored.engine, engine.snapshot().x, engine.snapshot().y);
    restored.engine.loadDoorState(restored.doorState);
    restored.engine.loadQueueState(restored.queueState);
    assert.equal(restored.engine.sourceTiming.hasTrait('base:hemophobic'), true);
    assert.equal(restored.engine.sourceTiming.hasTrait('base:dextrous'), false);
    const tampered = structuredClone(exported);

    tampered.bodyState.metabolicTarget = 1.5;
    await assert.rejects(store.restore(tampered), /integrity/u);
    const invalid = structuredClone(exported);

    delete invalid.integrity;
    invalid.bodyState.metabolicTarget = 11;
    await assert.rejects(store.restore(await signed(invalid)));
    assert.equal(engine.sourceActions.getMetabolicTarget(), Math.fround(3.2));
    const legacyBody = structuredClone(exported);

    delete legacyBody.integrity;
    delete legacyBody.bodyState.metabolicTarget;
    assert.equal((await store.restore(await signed(legacyBody))).engine.sourceActions.getMetabolicTarget(), 1.5);
});

test('format5 clothing wetness survives restore and authenticated graph1 migrates with constructor defaults', async () => {
    const { engine, record, store } = await fixture();

    engine.command({ type: 'cancel' });
    engine.registerItemDefinition({
        fullType: 'Fixture.Wet', type: 'Clothing', bodyLocation: null, conditionMax: 10,
        stackLimit: 1, removeOnBroken: false, conditionLowerChanceOneIn: 0,
    }, { owner: 'fixture' });
    const id = engine.command({ type: 'spawnItem', fullType: 'Fixture.Wet', x: 5, y: 5 }).id;

    engine.sourceActions.itemSetWetness(id, 47.5);
    const cells = record.world.cells.map((cell) => ({ ...cell, bytes: Buffer.from(cell.bytes, 'base64') }));
    const saved = JSON.parse(await (await store.exportLive(engine, { cells })).text());
    const restored = await store.restore(saved);

    assert.equal(saved.formatVersion, 6);
    assert.equal(saved.inventoryGraph.version, 2);
    assert.equal(restored.engine.sourceActions.itemWetness(id), 47.5);
    const legacy = structuredClone(saved);

    delete legacy.integrity;
    legacy.formatVersion = 3;
    delete legacy.worldClock;
    legacy.inventoryGraph.version = 1;
    delete legacy.inventoryGraph.items[0].wetness;
    const signedLegacy = await signed(legacy);
    const migrated = await validateSave(signedLegacy);

    assert.equal(migrated.formatVersion, 6);
    assert.equal(migrated.inventoryGraph.version, 2);
    assert.equal(migrated.inventoryGraph.items[0].wetness, 0);
    assert.equal((await store.restore(signedLegacy)).engine.sourceActions.itemWetness(id), 0);
    assert.equal(signedLegacy.inventoryGraph.version, 1, 'migration cannot mutate authenticated input');

    /**
     * Reject one authenticated invalid wetness or graph-version record.
     *
     * @param {number} outer - Save format version.
     * @param {number} inner - Inventory graph version.
     * @param {number|string} wetness - Invalid wetness or version-pair payload.
     * @returns {Promise<void>} Resolves after rejection is asserted.
     */
    async function rejectInvalid(outer, inner, wetness) {
        const invalid = structuredClone(saved);

        delete invalid.integrity;
        invalid.formatVersion = outer;
        invalid.inventoryGraph.version = inner;
        invalid.inventoryGraph.items[0].wetness = wetness;
        await assert.rejects(validateSave(await signed(invalid)), /wetness|graph/iu);
    }

    await rejectInvalid(4, 2, 101);
    await rejectInvalid(4, 2, '47.5');
    await rejectInvalid(4, 3, 47.5);
    await rejectInvalid(3, 1, 47.5);
    await rejectInvalid(4, 1, 47.5);
    await rejectInvalid(5, 2, 101);
    await rejectInvalid(5, 1, 47.5);
    assert.equal(engine.sourceActions.itemWetness(id), 47.5);
});

test('authenticated world-item placement and orientation round-trip with atomic malformed-state refusal', async () => {
    const { engine, record, store } = await fixture();

    engine.command({ type: 'cancel' });
    engine.registerItemDefinition({
        fullType: 'Fixture.WorldVisual', type: 'Normal', clothingItem: 'FixtureVisual', bodyLocation: null, conditionMax: 10,
        stackLimit: 1, removeOnBroken: false, conditionLowerChanceOneIn: 0,
    }, { owner: 'fixture' });
    const id = engine.command({ type: 'spawnItem', fullType: 'Fixture.WorldVisual', x: 5.125, y: 5.75 }).id;

    engine.initializeItemVisual(id, { baseTextureCount: 2, textureChoiceCount: 0, allowRandomTint: false, allowRandomHue: false });
    const graph = engine.exportInventoryGraph();

    Object.assign(graph.items[0].worldVisual, { worldXRotation: 12, worldYRotation: 34, worldZRotation: 56, worldScale: 0.75 });
    engine.importInventoryGraph(graph);
    const cells = record.world.cells.map((cell) => ({ ...cell, bytes: Buffer.from(cell.bytes, 'base64') }));
    const saved = JSON.parse(await (await store.exportLive(engine, { cells })).text());

    assert.deepEqual((await store.restore(saved)).engine.worldItemVisuals(), engine.worldItemVisuals());
    const malformed = structuredClone(saved);

    delete malformed.integrity;
    malformed.inventoryGraph.items[0].worldVisual.xoff = 0.5;
    await assert.rejects(store.restore(await signed(malformed)), /offset/iu);
    assert.deepEqual(engine.exportInventoryGraph(), graph);
    const badVisual = structuredClone(saved);

    delete badVisual.integrity;
    badVisual.inventoryGraph.items[0].visual.tint[0] = 2;
    await assert.rejects(store.restore(await signed(badVisual)), /ItemVisual/iu);
    assert.deepEqual(engine.exportInventoryGraph(), graph);
    const legacy = structuredClone(saved);

    delete legacy.integrity;
    delete legacy.inventoryGraph.items[0].worldVisual;
    delete legacy.inventoryGraph.items[0].visual;
    const migrated = (await store.restore(await signed(legacy))).engine.worldItemVisuals()[0];

    assert.deepEqual([migrated.x + migrated.xoff, migrated.y + migrated.yoff], [5.125, 5.75]);
    assert.deepEqual([migrated.worldXRotation, migrated.worldYRotation, migrated.worldZRotation, migrated.worldScale], [0, 0, -1, 1]);
    assert.equal(migrated.visual, undefined, 'legacy absence is not an invented historical selection');
});

test('authenticated v1-v4 saves start a new source-default timeline without changing prior state', async () => {
    const { engine, record, store } = await fixture();
    const current = JSON.parse(await (await store.exportLive(engine, {
        cells: [{ x: 0, y: 0, bytes: Buffer.from(record.world.cells[0].bytes, 'base64') }],
        modState: record.modState, settings: { retained: true },
    })).text());
    const expectedClock = {
        version: 1, year: 1_993, month: 6, day: 22,
        timeOfDay: 9, lastTimeOfDay: 9, nightsSurvived: 0, minutesPerDay: 90,
    };

    /**
     * Restore and authenticate one legacy envelope without changing prior state.
     *
     * @param {number} version - Legacy save format version.
     * @returns {Promise<void>} Resolves after migration and integrity assertions.
     */
    async function assertLegacyRestore(version) {
        const payload = structuredClone(version < 3 ? record : current);

        delete payload.integrity;
        delete payload.worldClock;
        payload.formatVersion = version;
        payload.revision = 17;

        if (version === 2) {
            payload.engine.state = engine.saveState();
            payload.itemDefs = [];
            payload.items = [];
        } else if (version === 3) {
            payload.inventoryGraph.version = 1;
        }

        const legacy = await signed(payload);
        const before = structuredClone(legacy);
        const restored = await store.restore(legacy);

        assert.deepEqual(legacy, before);
        assert.equal(restored.record.formatVersion, 6);
        assert.equal(restored.record.migratedFrom, version);
        assert.equal(restored.record.revision, 17);
        assert.deepEqual(restored.record.worldClock, expectedClock);
        assert.deepEqual(restored.engine.worldClockState(), expectedClock);
        assert.deepEqual(restored.record.world, payload.world);
        assert.deepEqual(restored.record.modState, payload.modState);
        assert.deepEqual(restored.record.settings, payload.settings);
        assert.deepEqual(restored.engine.saveState().values.slice(0, payload.engine.state.values.length), payload.engine.state.values);
        assert.deepEqual(await validateSave(restored.record), restored.record, 'migration must re-sign the resulting envelope');
        legacy.revision++;
        await assert.rejects(store.restore(legacy), /integrity/u);
    }

    await assertLegacyRestore(1);
    await assertLegacyRestore(2);
    await assertLegacyRestore(3);
    await assertLegacyRestore(4);
});

test('world clock restores before clothing load so wetness has no offline catch-up', async () => {
    const { engine, record, store } = await fixture();
    const clock = {
        version: 1, year: 2_000, month: 1, day: 28,
        timeOfDay: 9, lastTimeOfDay: 8.5, nightsSurvived: 8, minutesPerDay: 60,
    };

    engine.command({ type: 'cancel' });
    engine.importWorldClockState(clock);
    engine.registerItemDefinition({
        fullType: 'Fixture.ClockBag', isBag: true, capacity: 10, bodyLocation: null,
        conditionMax: 10, stackLimit: 1, removeOnBroken: false, conditionLowerChanceOneIn: 0,
    }, { owner: 'fixture' });
    engine.registerItemDefinition({
        fullType: 'Fixture.ClockClothing', type: 'Clothing', bodyLocation: null,
        rawFields: [{ name: 'BloodLocation', value: 'Shirt' }],
        conditionMax: 10, stackLimit: 1, removeOnBroken: false, conditionLowerChanceOneIn: 0,
    }, { owner: 'fixture' });
    const bag = engine.command({ type: 'spawnItem', fullType: 'Fixture.ClockBag', x: 5, y: 5 }).id;
    const id = engine.command({ type: 'spawnItem', fullType: 'Fixture.ClockClothing', x: 5, y: 5 }).id;
    const graph = engine.exportInventoryGraph();
    const ownerContainerId = engine.getItem(bag).internalContainerId;

    graph.items = graph.items.map((item) => item.id === id
        ? { ...item, ownerContainerId, worldPosition: null, wetness: 47.5 }
        : item);
    engine.importInventoryGraph(graph);
    const cells = [{ x: 0, y: 0, bytes: Buffer.from(record.world.cells[0].bytes, 'base64') }];
    const saved = JSON.parse(await (await store.exportLive(engine, { cells })).text());
    const restored = await store.restore(saved);

    assert.deepEqual(saved.worldClock, clock);
    assert.deepEqual(restored.engine.worldClockState(), clock);
    assert.deepEqual(restored.engine.exportInventoryGraph(), engine.exportInventoryGraph());
    assert.equal(Object.hasOwn(saved.inventoryGraph.items.find((item) => item.id === id), 'lastWetnessUpdate'), false);
    restored.engine.sourceActions.itemUpdateWetness(id);
    assert.equal(restored.engine.sourceActions.itemWetness(id), 47.5, 'load initializes timestamp at restored age, not default age');
    restored.engine.sourceActions.worldClockSet('timeOfDay', 9.031_25);
    restored.engine.sourceActions.itemUpdateWetness(id);
    assert.equal(restored.engine.sourceActions.itemWetness(id), 46.875, 'a later eligible minute dries from the restored timestamp');
    engine.step(0.1);
    restored.engine.importWorldClockState(clock);
    restored.engine.step(0.1);
    assert.deepEqual(restored.engine.worldClockState(), engine.worldClockState());
});

test('format5 authenticates clock before normalization and refuses missing or malformed clock state', async () => {
    const { engine, record, store } = await fixture();
    const saved = JSON.parse(await (await store.exportLive(engine, {
        cells: [{ x: 0, y: 0, bytes: Buffer.from(record.world.cells[0].bytes, 'base64') }],
    })).text());
    const before = engine.worldClockState();
    const tampered = structuredClone(saved);

    tampered.worldClock.timeOfDay = 'invalid';
    await assert.rejects(validateSave(tampered), /integrity/u);

    const noncanonical = structuredClone(saved);

    delete noncanonical.integrity;
    Object.assign(noncanonical.worldClock, { month: -1, day: 40, timeOfDay: 9.1 });
    const normalized = await validateSave(await signed(noncanonical));

    assert.equal(normalized.worldClock.month, -1, 'saved setters retain source direct-assignment semantics');
    assert.equal(normalized.worldClock.day, 40);
    assert.equal(normalized.worldClock.timeOfDay, Math.fround(9.1));
    assert.deepEqual(await validateSave(normalized), normalized, 'canonical f32 snapshot must remain authentically signed');

    /**
     * Reject one authenticated invalid clock without changing live time.
     *
     * @param {function(object): void} change - Invalid clock mutation.
     * @returns {Promise<void>} Resolves after restore rejection and state assertions.
     */
    async function rejectInvalidClock(change) {
        const invalid = structuredClone(saved);

        delete invalid.integrity;
        change(invalid);
        await assert.rejects(store.restore(await signed(invalid)), /clock|year|nightsSurvived|timeOfDay|minutesPerDay/iu);
        assert.deepEqual(engine.worldClockState(), before);
    }

    await rejectInvalidClock((payload) => {
        delete payload.worldClock;
    });
    await rejectInvalidClock((payload) => {
        payload.worldClock.version = 2;
    });
    await rejectInvalidClock((payload) => {
        payload.worldClock.year = 2_147_483_648;
    });
    await rejectInvalidClock((payload) => {
        payload.worldClock.nightsSurvived = 0.5;
    });
    await rejectInvalidClock((payload) => {
        payload.worldClock.timeOfDay = '9';
    });
    await rejectInvalidClock((payload) => {
        payload.worldClock.minutesPerDay = 1e39;
    });
});

test('format6 authenticates exact climate and deterministically begins a new legacy weather epoch without mutating records', async () => {
    const { engine, record, store } = await fixture();
    const cells = [{ x: 0, y: 0, bytes: Buffer.from(record.world.cells[0].bytes, 'base64') }];
    const unconfigured = JSON.parse(await (await store.exportLive(engine, { cells })).text());

    assert.equal((await store.restore(unconfigured)).engine.isClimateInitialized(), false,
        'native absence survives a legitimate core-mode save without seeding weather');

    engine.initializeClimate(0x89_AB_CD_EF);
    engine.frameStep(1);
    const saved = JSON.parse(await (await store.exportLive(engine, { cells, modState: record.modState })).text());
    const restored = await store.restore(saved);

    assert.equal(saved.formatVersion, 6);
    assert.deepEqual(restored.engine.saveClimateState(), engine.saveClimateState());
    const tampered = structuredClone(saved);

    tampered.climate.bytes = 'AAAA';
    await assert.rejects(store.restore(tampered), /integrity/iu);
    delete tampered.integrity;
    await assert.rejects(store.restore(await signed(tampered)), /climate/iu);
    assert.deepEqual(engine.saveClimateState(), restored.engine.saveClimateState(),
        'authenticated malformed producer state cannot alter the committed world');
    const legacy = structuredClone(saved);

    delete legacy.integrity;
    delete legacy.climate;
    delete legacy.queue;
    delete legacy.doorState;
    legacy.formatVersion = 5;
    const authenticated = await signed(legacy);
    const before = structuredClone(authenticated);
    const first = await store.restore(authenticated);
    const second = await store.restore(authenticated);

    assert.deepEqual(authenticated, before, 'reading must not rewrite an authenticated legacy record');
    assert.deepEqual(first.engine.worldClockState(), engine.worldClockState());
    assert.deepEqual(first.engine.exportInventoryGraph(), engine.exportInventoryGraph());
    assert.deepEqual(first.record.modState, record.modState);
    assert.deepEqual(first.record.climateEpoch, {
        version: 1, kind: 'legacy-new-source-weather', sourceIntegrity: authenticated.integrity,
        seed: Number.parseInt(authenticated.integrity.slice(0, 8), 16),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    assert.deepEqual(first.engine.saveClimateState(), second.engine.saveClimateState());
    assert.equal(first.engine.isClimateInitialized(), true);
    const selectedZone = structuredClone(first.record);

    delete selectedZone.integrity;
    selectedZone.climateEpoch.timeZone = 'UTC';
    const zoned = await store.restore(await signed(selectedZone));
    const zonedBackup = JSON.parse(await (await store.exportLive(zoned.engine, {
        cells, climateEpoch: zoned.record.climateEpoch,
    })).text());

    assert.equal(zonedBackup.climateEpoch.timeZone, 'UTC');
    assert.deepEqual((await store.restore(zonedBackup)).engine.saveClimateState(), zoned.engine.saveClimateState(),
        'a migrated epoch retains its selected zone through full native capture instead of adopting the next host zone');
});

test('climate persistence omits only genuinely absent native exports and propagates real native capture failure', async () => {
    const bytes = await readFile(new URL('../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url));
    const legacyBytes = bodyModule(bytes, 'pre-climate');
    const legacy = await createEngine(legacyBytes);
    const legacyStore = createSaveStore({ engineSource: legacyBytes, appVersion: 'test' });
    const record = JSON.parse(await (await legacyStore.exportLive(legacy)).text());

    assert.equal(Object.hasOwn(record, 'climate'), false);
    assert.equal(legacy.canSaveClimateState(), false);
    const before = structuredClone(record);
    const currentStore = createSaveStore({ engineSource: bytes, appVersion: 'test' });
    const migrated = await currentStore.restore(record);
    const repeated = await currentStore.restore(record);

    for (const staged of [migrated, repeated]) {
        assert.equal(staged.engine.isClimateInitialized(), false,
            'new weather waits for restored source geometry and queue timing');
        assert.equal(staged.climateSeed, staged.record.climateEpoch.seed);
        staged.engine.loadDoorState(staged.doorState);
        staged.engine.loadQueueState(staged.queueState);
        staged.engine.sourceActions.validateSourceOwners(staged.sourceOwners);
        staged.engine.initializeClimate(staged.climateSeed, staged.record.climateEpoch.timeZone);
        assert.equal(staged.engine.isClimateInitialized(), true,
            'genuinely unsupported prior weather begins a new source epoch');
    }

    assert.deepEqual(record, before, 'migration must not rewrite the authenticated input');
    assert.deepEqual(migrated.engine.saveClimateState(), repeated.engine.saveClimateState());
    const current = JSON.parse(await (await currentStore.exportLive(migrated.engine)).text());

    await assert.rejects(legacyStore.restore(current), /unsupported/iu);
    const trappedBytes = bodyModule(bytes, 'climate-trap');
    const trapped = await createEngine(trappedBytes);
    const trappedStore = createSaveStore({ engineSource: trappedBytes, appVersion: 'test' });

    await assert.rejects(trappedStore.exportLive(trapped), WebAssembly.RuntimeError);
});
