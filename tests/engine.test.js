// These tests drive the real compiled WASM module: run `npm run build` first.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { createEngine } from '../src/engine.js';

/**
 * Detached engine state, exactly as snapshot() returns it.
 *
 * @typedef {{apiVersion: number, tick: number, x: number, y: number, speed: number, action: number}} Snapshot
 */

const MODULE_URL = new URL(
    '../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm',
    import.meta.url,
);

const STEP = 1 / 60;
const IDLE = 0;
const MOVING = 1;
const WALKING = 2;

/**
 * Reads the browser artifact once so every test drives the same bytes.
 *
 * @returns {Promise<Uint8Array>} Compiled engine module bytes.
 * @throws {Error} When the module has not been built.
 */
async function readModuleBytes() {
    try {
        return new Uint8Array(await readFile(MODULE_URL));
    } catch {
        throw new Error(`Missing ${MODULE_URL.pathname}: run \`npm run build\` before node --test.`);
    }
}

const moduleBytes = await readModuleBytes();

/**
 * Instantiates an independent engine, because simulation state is per instance.
 *
 * @returns {Promise<import('../src/engine.js').Engine>} Fresh engine handle.
 */
function engine() {
    return createEngine(moduleBytes);
}

/**
 * Compares engine values, which are f32-backed and never round-trip exactly.
 *
 * @param {number} actual - Candidate value.
 * @param {number} expected - Expected value.
 * @returns {boolean} True within one ten-thousandth of a world unit.
 */
function near(actual, expected) {
    return Math.abs(actual - expected) <= 1e-4;
}

/**
 * Steps until the engine reports idle, failing instead of hanging forever.
 *
 * @param {object} subject - Engine handle from createEngine.
 * @param {number} [limit] - Maximum accepted steps.
 * @returns {Snapshot} Terminal snapshot.
 */
function runUntilIdle(subject, limit = 2_000) {
    let steps = 0;

    while (subject.snapshot().action !== IDLE) {
        subject.step(STEP);
        steps += 1;
        assert.ok(steps < limit, `movement never ended after ${steps} steps`);
    }

    return subject.snapshot();
}

test('initial state matches the integration contract', async () => {
    const snapshot = (await engine()).snapshot();

    assert.deepEqual(snapshot, {
        apiVersion: 1,
        tick: 0,
        x: 5,
        y: 5,
        speed: 1.5,
        action: IDLE,
        health: 100,
        dead: false,
    });
});

test('a destination is reached exactly, then the action ends', async () => {
    const subject = await engine();
    const assigned = subject.command({ type: 'moveTo', x: 2, y: 8 });

    assert.equal(assigned.action, MOVING);
    assert.equal(assigned.x, 5);
    // A command alone never advances time or position.
    assert.equal(assigned.tick, 0);
    const final = runUntilIdle(subject);

    assert.equal(final.x, 2);
    assert.equal(final.y, 8);
    assert.equal(final.action, IDLE);
    // sqrt(18) world units at 1.5 units/s needs roughly 170 frames.
    assert.ok(final.tick >= 165 && final.tick <= 175, `tick was ${final.tick}`);
    assert.equal(runUntilIdle(subject).tick, final.tick);
});

test('cancel prevents any subsequent movement', async () => {
    const subject = await engine();

    subject.command({ type: 'moveTo', x: 9, y: 5 });

    for (let index = 0; index < 20; index += 1) {
        subject.step(STEP);
    }

    const midway = subject.snapshot();

    assert.ok(midway.x > 5 && midway.x < 9, `unexpected midway x ${midway.x}`);
    assert.equal(midway.action, MOVING);
    const cancelled = subject.command({ type: 'cancel' });

    assert.equal(cancelled.action, IDLE);
    assert.equal(cancelled.x, midway.x);

    for (let index = 0; index < 60; index += 1) {
        subject.step(STEP);
    }

    const after = subject.snapshot();

    assert.equal(after.x, midway.x);
    assert.equal(after.y, 5);
    assert.equal(after.action, IDLE);
    assert.equal(after.tick, 80);
});

test('a diagonal heading is normalised, so length cannot buy distance', async () => {
    const subject = await engine();

    subject.command({ type: 'walk', x: 1, y: 1 });

    for (let index = 0; index < 60; index += 1) {
        subject.step(STEP);
    }

    const moved = subject.snapshot();
    const offsetX = moved.x - 5;
    const offsetY = moved.y - 5;

    assert.ok(near(offsetX, offsetY), `heading skewed: ${offsetX} against ${offsetY}`);
    assert.ok(near(Math.hypot(offsetX, offsetY), 1.5), `travelled ${Math.hypot(offsetX, offsetY)} in one second`);
});

test('walking ends at the world edge and stays there', async () => {
    const subject = await engine();

    subject.command({ type: 'walk', x: 3, y: 0 });
    const stopped = runUntilIdle(subject);

    assert.equal(stopped.x, 10);
    assert.equal(stopped.y, 5);
    assert.equal(stopped.action, IDLE);
    subject.step(STEP);
    assert.equal(subject.snapshot().x, 10);
});

test('a zero direction cancels instead of inventing a heading', async () => {
    const subject = await engine();

    subject.command({ type: 'walk', x: 0, y: -4 });
    subject.step(STEP);
    const moved = subject.snapshot();

    assert.ok(moved.y < 5);
    assert.equal(moved.action, WALKING);
    const cancelled = subject.command({ type: 'walk', x: 0, y: 0 });

    assert.equal(cancelled.action, IDLE);
    assert.equal(cancelled.y, moved.y);
});

test('a heading command replaces the previous destination', async () => {
    const subject = await engine();

    subject.command({ type: 'moveTo', x: 0, y: 0 });
    subject.command({ type: 'walk', x: 1, y: 0 });

    for (let index = 0; index < 10; index += 1) {
        subject.step(STEP);
    }

    const moved = subject.snapshot();

    assert.ok(moved.x > 5, `walked back toward the old destination: ${moved.x}`);
    assert.equal(moved.y, 5);
});

test('speed changes the distance covered in the same number of ticks', async () => {
    const slow = await engine();

    slow.command({ type: 'walk', x: 0, y: 1 });

    for (let index = 0; index < 60; index += 1) {
        slow.step(STEP);
    }

    const slowSnapshot = slow.snapshot();
    const fast = await engine();

    fast.setSpeed(3);
    assert.equal(fast.snapshot().speed, 3);
    fast.command({ type: 'walk', x: 0, y: 1 });

    for (let index = 0; index < 60; index += 1) {
        fast.step(STEP);
    }

    const fastSnapshot = fast.snapshot();

    assert.equal(fastSnapshot.tick, slowSnapshot.tick);
    assert.ok(near(slowSnapshot.y - 5, 1.5));
    assert.ok(near(fastSnapshot.y - 5, 3));
});

test('refused numbers never mutate state', async () => {
    const subject = await engine();

    subject.command({ type: 'moveTo', x: 7, y: 5 });
    subject.step(STEP);
    const before = subject.snapshot();

    assert.equal(before.action, MOVING);
    const refusedByEngine = [
        () => subject.command({ type: 'moveTo', x: 11, y: 5 }),
        () => subject.command({ type: 'moveTo', x: 5, y: -0.5 }),
        () => subject.command({ type: 'moveTo', x: 10.5, y: 5 }),
        () => subject.setSpeed(0),
        () => subject.setSpeed(0.05),
        () => subject.setSpeed(10.5),
        () => subject.step(0),
        () => subject.step(-STEP),
        () => subject.step(0.11),
        () => subject.command({ type: 'moveTo', x: 10.000_000_1, y: 5 }),
        () => subject.command({ type: 'moveTo', x: 5, y: 10.000_000_1 }),
        () => subject.setSpeed(0.099_999_999),
        () => subject.setSpeed(10.000_000_1),
        () => subject.step(0.100_000_000_1),
    ];

    for (const attempt of refusedByEngine) {
        assert.throws(attempt, RangeError);
    }

    const refusedAsBadNumbers = [
        () => subject.command({ type: 'moveTo', x: 5, y: Number.NaN }),
        () => subject.command({ type: 'walk', x: Number.NaN, y: 1 }),
        () => subject.command({ type: 'walk', x: Number.POSITIVE_INFINITY, y: 0 }),
        () => subject.setSpeed(Number.NaN),
        () => subject.setSpeed(Number.POSITIVE_INFINITY),
        () => subject.step(Number.NaN),
        () => subject.step(Number.POSITIVE_INFINITY),
    ];

    for (const attempt of refusedAsBadNumbers) {
        assert.throws(attempt, TypeError);
    }

    assert.deepEqual(subject.snapshot(), before);
});

test('malformed consumer input is rejected before the engine sees it', async () => {
    const subject = await engine();
    const before = subject.snapshot();
    const mistakes = [
        ['string coordinate', () => subject.command({ type: 'moveTo', x: '2', y: 5 })],
        ['missing coordinate', () => subject.command({ type: 'moveTo', x: 2 })],
        ['unknown command type', () => subject.command({ type: 'teleport', x: 2, y: 2 })],
        ['null command', () => subject.command(null)],
        ['string speed', () => subject.setSpeed('3')],
        ['missing step argument', () => subject.step()],
        ['string step', () => subject.step('0.016')],
    ];

    for (const [label, attempt] of mistakes) {
        assert.throws(attempt, TypeError, label);
    }

    assert.deepEqual(subject.snapshot(), before);
});

test('snapshots are detached and the engine handle is sealed', async () => {
    const subject = await engine();
    const first = subject.snapshot();

    first.x = 0;
    first.action = IDLE;
    assert.equal(subject.snapshot().x, 5);
    subject.command({ type: 'walk', x: 1, y: 0 });
    subject.step(STEP);
    assert.notDeepEqual(subject.snapshot(), first);
    assert.throws(() => {
        subject.speed = 99;
    }, TypeError);
});

test('reset clears movement, speed and counters', async () => {
    const subject = await engine();

    subject.setSpeed(8);
    subject.command({ type: 'walk', x: -1, y: -1 });

    for (let index = 0; index < 30; index += 1) {
        subject.step(STEP);
    }

    subject.reset();
    assert.deepEqual(subject.snapshot(), {
        apiVersion: 1,
        tick: 0,
        x: 5,
        y: 5,
        speed: 1.5,
        action: IDLE,
        health: 100,
        dead: false,
    });
    subject.step(STEP);
    assert.ok(near(subject.snapshot().x, 5));
});

test('a destination at the current position is already reached', async () => {
    const subject = await engine();

    assert.equal(subject.command({ type: 'moveTo', x: 5, y: 5 }).action, IDLE);
    subject.step(STEP);
    const after = subject.snapshot();

    assert.equal(after.x, 5);
    assert.equal(after.tick, 1);
});

test('each instance owns private state', async () => {
    const first = await engine();
    const second = await engine();

    first.command({ type: 'walk', x: 1, y: 0 });
    first.step(STEP);
    assert.ok(first.snapshot().x > 5);
    assert.equal(second.snapshot().x, 5);
    assert.equal(second.snapshot().tick, 0);
});

test('a module without the engine ABI is reported, not half-adopted', async () => {
    const empty = new Uint8Array([0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00]);

    await assert.rejects(createEngine(empty), /missing exports: api_version, reset/u);
    await assert.rejects(createEngine(undefined), TypeError);
    await assert.rejects(
        createEngine(new URL('../engine/target/not-built.wasm', import.meta.url)),
        /file: URLs/u,
    );
});

test('the documented speed and step edges are accepted', async () => {
    const subject = await engine();

    subject.setSpeed(0.1);
    assert.ok(near(subject.snapshot().speed, 0.1));
    subject.setSpeed(10);
    assert.equal(subject.snapshot().speed, 10);
    subject.command({ type: 'moveTo', x: 10, y: 0 });
    const final = runUntilIdle(subject);

    assert.equal(final.x, 10);
    assert.equal(final.y, 0);
    assert.equal(final.action, IDLE);
    subject.step(0.1);
    assert.equal(subject.snapshot().tick, final.tick + 1);
});

test('extreme finite headings still normalise to one second of travel', async () => {
    const huge = await engine();

    huge.command({ type: 'walk', x: Number.MAX_VALUE, y: Number.MAX_VALUE });
    assert.equal(huge.snapshot().action, WALKING);

    for (let index = 0; index < 60; index += 1) {
        huge.step(STEP);
    }

    const unit = 1.5 / Math.SQRT2;
    const moved = huge.snapshot();

    assert.ok(near(moved.x - 5, unit), `huge heading lost x: ${moved.x}`);
    assert.ok(near(moved.y - 5, unit), `huge heading lost y: ${moved.y}`);
    const small = await engine();

    small.command({ type: 'walk', x: 1e-3, y: -1e-3 });

    for (let index = 0; index < 60; index += 1) {
        small.step(STEP);
    }

    const travelled = small.snapshot();
    const distance = Math.hypot(travelled.x - 5, 5 - travelled.y);

    assert.ok(near(distance, 1.5), `small heading travelled ${distance}`);
    const none = await engine();

    assert.equal(none.command({ type: 'walk', x: 0, y: 0 }).action, IDLE);
});

test('finite tiny headings preserve direction rather than creating a deadzone', async () => {
    const tiny = await engine();
    const ordinary = await engine();

    tiny.command({ type: 'walk', x: 1e-300, y: 0 });
    ordinary.command({ type: 'walk', x: 1, y: 0 });
    tiny.step(STEP);
    ordinary.step(STEP);
    assert.deepEqual(tiny.snapshot(), ordinary.snapshot());
    assert.equal(tiny.snapshot().action, WALKING);
});

/**
 * Builds real-format row-major 8x8 records, with optional uniform-tag chunks.
 *
 * @param {function(number, number): number} [flags] - Flags at a cell-local tile.
 * @param {Map<number, number>} [tags] - Uniform tag overrides by chunk index.
 * @returns {Uint8Array} Complete synthetic cell bytes.
 */
function cellBytes(flags = () => 0, tags = new Map()) {
    const bytes = new Uint8Array(2 + 1_024 * 65);

    bytes[1] = 1;
    let offset = 2;

    for (let chunk = 0; chunk < 1_024; chunk += 1) {
        const tag = tags.get(chunk) ?? 2;

        bytes[offset++] = tag;

        if (tag === 2) {
            for (let tile = 0; tile < 64; tile += 1) {
                bytes[offset++] = flags((chunk % 32) * 8 + tile % 8,
                    Math.floor(chunk / 32) * 8 + Math.floor(tile / 8));
            }
        }
    }

    return bytes.subarray(0, offset);
}

/**
 * Encodes an unsigned integer for a WASM section length or export count.
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
 * Exposes only the original ABI from the real module, not a simulated engine.
 *
 * @param {Uint8Array} bytes - Real compiled module bytes.
 * @returns {Uint8Array} Module exposing only the original engine ABI.
 */
function legacyModule(bytes) {
    const keep = new Set(['api_version', 'reset', 'set_speed', 'move_to', 'walk',
        'cancel', 'step', 'position_x', 'position_y', 'speed', 'action', 'tick']);
    const output = [...bytes.subarray(0, 8)];
    let offset = 8;
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

        if (id !== 7) {
            for (const byte of bytes.subarray(start, end)) {
                output.push(byte);
            }
        } else {
            const count = unsigned();
            const entries = [];

            for (let index = 0; index < count; index += 1) {
                const entry = offset;
                const nameLength = unsigned();
                const name = new TextDecoder().decode(bytes.subarray(offset, offset + nameLength));

                offset += nameLength;
                // Export kind.
                offset += 1;
                // Export index.
                unsigned();

                if (keep.has(name)) {
                    entries.push(bytes.subarray(entry, offset));
                }
            }

            const payload = [...encode(entries.length), ...entries.flatMap((entry) => [...entry])];

            output.push(id, ...encode(payload.length), ...payload);
        }

        offset = end;
    }

    return new Uint8Array(output);
}

test('original ABI1 modules still move while optional methods clearly refuse support', async () => {
    const subject = await createEngine(legacyModule(moduleBytes));

    subject.command({ type: 'moveTo', x: 6, y: 5 });
    assert.equal(runUntilIdle(subject).x, 6);

    for (const attempt of [
        () => subject.worldImportCell(0, 0, cellBytes()),
        () => subject.navFlags(0, 0),
        () => subject.worldBounds(),
        () => subject.saveState(),
        () => subject.loadState({ version: 1, values: [5, 5, 1.5, 5, 5, 0, 0, 0, 0, 0] }),
        () => subject.worldReset(),
        () => subject.registerItemDefinition(shoe(), { owner: 'base' }),
        () => subject.itemDefinitions(),
        () => subject.beginItemDefinitionRegistration('base'),
        () => subject.commitItemDefinitionRegistration('base'),
        () => subject.rollbackItemDefinitionRegistration('base'),
        () => subject.freezeItemDefinitions(),
        () => subject.items(),
        () => subject.importItems([]),
        () => subject.inventoryState(),
        () => subject.wornItem('base:shoes'),
        () => subject.getHealth(),
        () => subject.isDead(),
        () => subject.command({ type: 'setHealth', health: 0 }),
        () => subject.command({ type: 'spawnItem', fullType: 'Base.Shoe', x: 5, y: 5 }),
        () => subject.command({ type: 'pickup', id: 1 }),
        () => subject.command({ type: 'wear', id: 1 }),
        () => subject.command({ type: 'unequip', id: 1 }),
        () => subject.command({ type: 'drop', id: 1, x: 5, y: 5 }),
        () => subject.command({ type: 'setCondition', id: 1, condition: 0 }),
        () => subject.command({ type: 'setWeight', id: 1, weight: 1 }),
        () => subject.command({ type: 'setActualWeight', id: 1, actualWeight: 1 }),
        () => subject.importDoors([], { squares: [] }),
        () => subject.doors(),
        () => subject.toggleDoor('door:10:10:0:0'),
        () => subject.saveDoorState(),
        () => subject.loadDoorState({}),
        () => subject.command({ type: 'toggleDoor', id: 'door:10:10:0:0' }),
    ]) {
        assert.throws(attempt, /unsupported/u);
    }
});

test('synthetic cells expose each tag and packed tile in detached signed-coordinate bounds', async () => {
    const subject = await engine();
    const bytes = cellBytes((x, y) => {
        if (x >= 48 && x < 56 && y === 0) {
            return [63, 1, 2, 4, 8, 16, 32, 0][x - 48];
        }

        return x === 55 && y === 7 ? 16 : 0;
    }, new Map([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]));
    // The nonzero byteOffset and DataView must not expose surrounding garbage.
    const padded = new Uint8Array(bytes.length + 9).fill(255);

    padded.set(bytes, 4);
    subject.worldImportCell(-1, 2, new DataView(padded.buffer, 4, bytes.length));
    assert.deepEqual(subject.worldBounds(), {
        active: true, minCx: -1, minCy: 2, maxCx: -1, maxCy: 2, cells: 1,
    });

    for (const [x, want] of [[-256, 0], [-248, 1], [-240, 0], [-232, 8],
        [-224, 16], [-216, 32], [-208, 63], [-207, 1], [-206, 2], [-205, 4],
        [-204, 8], [-203, 16], [-202, 32], [-201, 0]]) {
        assert.equal(subject.navFlags(x, 512), want);
    }

    assert.equal(subject.navFlags(-201, 519), 16, 'last packed word lost its final tile');
    assert.equal(subject.navFlags(-1, 767), 0);
    assert.equal(subject.navFlags(0, 512), 0xFF_FF_FF_FF);
    const bounds = subject.worldBounds();

    bounds.cells = 99;
    assert.equal(subject.worldBounds().cells, 1);
    subject.worldImportCell(100, -100, cellBytes());
    assert.equal(subject.navFlags(25_600, -25_600), 0);
    assert.deepEqual(subject.worldBounds(), {
        active: true, minCx: -1, minCy: -100, maxCx: 100, maxCy: 2, cells: 2,
    });
});

test('invalid or incomplete cell imports preserve the entire existing world', async () => {
    const subject = await engine();

    subject.worldImportCell(0, 0, cellBytes(() => 16));
    const before = subject.saveState();
    const bounds = subject.worldBounds();
    const valid = cellBytes();
    const badHeader = valid.slice();

    badHeader[0] = 1;
    const badTag = valid.slice();

    badTag[2 + 1_023 * 65] = 6;
    const badFlag = valid.slice();

    badFlag[badFlag.length - 1] = 64;
    const extra = new Uint8Array(valid.length + 1);

    extra.set(valid);

    for (const malformed of [
        new Uint8Array(), new Uint8Array([0]), badHeader, badTag, badFlag,
        valid.subarray(0, -1), valid.subarray(0, -65), extra,
        valid.buffer, 'bytes', null, new Uint16Array(10),
    ]) {
        assert.throws(() => subject.worldImportCell(0, 0, malformed), TypeError);
        assert.deepEqual(subject.worldBounds(), bounds);
        assert.equal(subject.navFlags(255, 255), 16);
        assert.equal(subject.navFlags(0, 0), 16);
        assert.deepEqual(subject.saveState(), before);
    }

    for (const value of [-101, 101, 4_294_967_296, -4_294_967_296]) {
        assert.throws(() => subject.worldImportCell(value, 0, valid), RangeError);
        assert.throws(() => subject.worldImportCell(0, value, valid), RangeError);
    }

    for (const value of [0.5, Number.NaN, Infinity, '0', 0n]) {
        assert.throws(() => subject.worldImportCell(value, 0, valid), TypeError);
        assert.throws(() => subject.navFlags(value, 0), TypeError);
    }

    for (const value of [-2_147_483_649, 2_147_483_648, 4_294_967_296]) {
        assert.throws(() => subject.navFlags(value, 0), RangeError);
        assert.throws(() => subject.navFlags(0, value), RangeError);
    }

    assert.equal(subject.navFlags(-2_147_483_648, 2_147_483_647), 0xFF_FF_FF_FF);
    assert.deepEqual(subject.worldBounds(), bounds);
    assert.deepEqual(subject.saveState(), before);
});

test('loaded solid tiles and shared walls stop movement without changing refused state', async () => {
    const subject = await engine();

    subject.worldImportCell(0, 0, cellBytes((x, y) => {
        if (x === 10 && y === 10) {
            return 1;
        }

        if (x === 11 && y === 5) {
            return 4;
        }

        if (x === 10 && y === 6) {
            return 2;
        }

        return 0;
    }));
    subject.loadState({ version: 2, values: [10.5, 5.5, 1.5, 10.5, 5.5, 0, 0, 0, 0, 1, 100, 1] });
    const before = subject.saveState();

    assert.throws(() => subject.command({ type: 'moveTo', x: 10.5, y: 10.5 }), RangeError);
    assert.throws(() => subject.command({ type: 'walk', x: 1, y: 0 }), /blocked/u);
    assert.throws(() => subject.command({ type: 'walk', x: 0, y: 1 }), /blocked/u);
    assert.deepEqual(subject.saveState(), before);
    subject.command({ type: 'walk', x: -1, y: 0 });
    subject.step(0.1);
    assert.ok(subject.snapshot().x < 10.5);
});

test('an imported nonzero cell supports an explicit idle spawn and world reset', async () => {
    const subject = await engine();

    subject.worldImportCell(2, 1, cellBytes());
    assert.equal(subject.snapshot().x, 5, 'import must not invent an actor spawn');
    subject.loadState({ version: 2, values: [530.5, 278.5, 1.5, 530.5, 278.5, 0, 0, 0, 0, 1, 100, 1] });
    subject.command({ type: 'moveTo', x: 534.5, y: 278.5 });
    const arrived = runUntilIdle(subject);

    assert.equal(arrived.x, 534.5);
    assert.equal(arrived.y, 278.5);
    subject.command({ type: 'walk', x: 1, y: 0 });
    const walking = subject.snapshot();

    subject.worldReset();
    assert.deepEqual(subject.snapshot(), { ...walking, action: IDLE });
    assert.equal(subject.navFlags(530, 278), 0xFF_FF_FF_FF);
    assert.equal(subject.worldBounds().active, false);
    assert.equal(subject.worldBounds().cells, 0);
    subject.reset();
    assert.equal(subject.command({ type: 'moveTo', x: 6, y: 5 }).action, MOVING);
    assert.equal(runUntilIdle(subject).x, 6);
});

test('an in-flight save resumes a detour on a freshly imported engine', async () => {
    const bytes = cellBytes((x, y) => (x === 20 && y >= 20 && y < 30 ? 5 : 0));
    const original = await engine();

    original.worldImportCell(2, 1, bytes);
    original.loadState({ version: 2, values: [530.5, 278.5, 3, 530.5, 278.5, 0, 0, 0, 0, 1, 100, 1] });
    original.command({ type: 'moveTo', x: 534.5, y: 278.5 });

    for (let index = 0; index < 8; index += 1) {
        original.step(STEP);
    }

    const saved = original.saveState();

    assert.equal(saved.version, 2);
    assert.deepEqual(saved.values.slice(10), [100, 1]);
    assert.equal(saved.values[7], MOVING);
    const restored = await engine();

    restored.worldImportCell(2, 1, bytes);
    restored.loadState(saved);
    assert.deepEqual(restored.snapshot(), original.snapshot());
    let leftBlockedRow = false;
    let steps = 0;

    while (restored.snapshot().action !== IDLE) {
        restored.step(STEP);
        const { x, y } = restored.snapshot();

        assert.equal(restored.navFlags(Math.floor(x), Math.floor(y)) & 1, 0,
            `restored detour entered solid tile at ${x}, ${y}`);

        if (y < 276 || y >= 286) {
            leftBlockedRow = true;
        }

        assert.ok(++steps < 5_000, 'restored detour never reached destination');
    }

    assert.ok(leftBlockedRow, 'restored route crossed the wall instead of taking a detour');
    assert.equal(restored.snapshot().x, 534.5);
    assert.equal(restored.snapshot().y, 278.5);
    assert.equal(runUntilIdle(original, 5_000).x, 534.5);
    saved.values[0] = -999;
    assert.equal(restored.snapshot().x, 534.5, 'save arrays must be detached');
});

test('invalid state envelopes and semantic refusals leave every state word untouched', async () => {
    const subject = await engine();

    subject.worldImportCell(0, 0, cellBytes((x, y) => (x === 7 && y === 7 ? 1 : 0)));
    subject.command({ type: 'moveTo', x: 9.5, y: 5.5 });
    subject.step(STEP);
    const before = subject.saveState();

    for (const state of [null, {}, { version: 1, values: before.values.slice(0, 10) },
        { version: 2, values: before.values.slice(1) },
        { version: 2, values: new Float64Array(before.values) },
        { version: 2, values: Array.from({ length: 12 }) }]) {
        assert.throws(() => subject.loadState(state), TypeError);
        assert.deepEqual(subject.saveState(), before);
    }

    for (let index = 0; index < 12; index += 1) {
        const values = [...before.values];

        values[index] = Infinity;
        assert.throws(() => subject.loadState({ version: 2, values }), TypeError);
        assert.deepEqual(subject.saveState(), before);
    }

    for (const [index, value] of [[0, -1], [2, 0], [3, 300], [7, 3], [7, 0.5],
        [8, -1], [8, 0.5], [8, 4_294_967_296], [9, 0], [9, 0.5],
        [10, -1], [10, 100.01], [11, 0], [11, 0.5], [11, 4_294_967_297]]) {
        const values = [...before.values];

        values[index] = value;
        assert.throws(() => subject.loadState({ version: 2, values }), RangeError);
        assert.deepEqual(subject.saveState(), before);
    }

    const blocked = [...before.values];

    blocked[0] = 7.5;
    blocked[1] = 7.5;
    assert.throws(() => subject.loadState({ version: 2, values: blocked }), RangeError);
    assert.deepEqual(subject.saveState(), before);
});

/**
 * Supplies one source-shaped footwear definition for real-WASM checks.
 *
 * @param {string} [fullType='Base.Shoe'] - Exact public item identity.
 * @param {object} [extra={}] - Numeric/source changes for the behavior under test.
 * @returns {object} Definition input, not a host gameplay implementation.
 */
function shoe(fullType = 'Base.Shoe', extra = {}) {
    return {
        fullType, bodyLocation: 'base:shoes', conditionMax: 30, stackLimit: 1,
        removeOnBroken: false, conditionLowerChanceOneIn: 20, weight: 1,
        source: { file: 'clothing.txt', model: 'Boots_Ground' }, ...extra,
    };
}

test('native item pickup refuses source weight51 without treating maxWeight8 as capacity', async () => {
    const subject = await engine();

    subject.registerItemDefinition(shoe('Base.Heavy', { weight: 51 }), { owner: 'base' });
    const id = subject.command({ type: 'spawnItem', fullType: 'Base.Heavy', x: 5, y: 5 }).id;
    const before = subject.items();
    const actor = subject.saveState();

    assert.throws(() => subject.command({ type: 'pickup', id }), RangeError);
    assert.deepEqual(subject.items(), before);
    assert.deepEqual(subject.saveState(), actor);
    assert.deepEqual(subject.inventoryState(), { capacityWeight: 0, capacity: 50, maxWeight: 8 });
    const { instance } = await WebAssembly.instantiate(moduleBytes, {});
    const api = instance.exports;

    assert.equal(api.item_definition_register(0, 1, 30, 1, 1, 0, 20, 0, 51), 0);
    assert.equal(api.item_spawn(0, 5, 5, 1, 30), 0);
    assert.notEqual(api.item_pickup(1), 0, 'the native shared pickup must enforce capacity');
});

test('native inventory capacity ignores count and applies worn reduction before pickup', async () => {
    const subject = await engine();

    subject.registerItemDefinition(shoe('Base.Load', { weight: 49, stackLimit: 100 }), { owner: 'base' });
    subject.registerItemDefinition(shoe('Base.One', { weight: 1 }), { owner: 'base' });
    const load = subject.command({ type: 'spawnItem', fullType: 'Base.Load', x: 5, y: 5, count: 100 }).id;
    const first = subject.command({ type: 'spawnItem', fullType: 'Base.One', x: 5, y: 5 }).id;
    const second = subject.command({ type: 'spawnItem', fullType: 'Base.One', x: 5, y: 5 }).id;

    subject.command({ type: 'pickup', id: load });
    assert.equal(subject.inventoryState().capacityWeight, 49);
    subject.command({ type: 'pickup', id: first });
    assert.equal(subject.inventoryState().capacityWeight, 50);
    assert.throws(() => subject.command({ type: 'pickup', id: second }), RangeError);
    subject.command({ type: 'wear', id: load });
    assert.ok(near(subject.inventoryState().capacityWeight, 15.7));
    subject.command({ type: 'pickup', id: second });
    assert.ok(near(subject.inventoryState().capacityWeight, 16.7));
    subject.command({ type: 'unequip', id: load });
    assert.equal(subject.inventoryState().capacityWeight, 51, 'unequip is not a pickup capacity check');
    subject.command({ type: 'drop', id: load, x: 5, y: 5 });
    assert.equal(subject.inventoryState().capacityWeight, 2);
    const detached = subject.inventoryState();

    detached.capacityWeight = 999;
    assert.equal(subject.inventoryState().capacityWeight, 2);
    subject.command({ type: 'setMoodleInputs', inputs: { maxWeight: 3 } });
    assert.deepEqual(subject.inventoryState(), { capacityWeight: 2, capacity: 50, maxWeight: 3 });
});

test('native pickup rounds current f32 weight to nearest hundredth rather than ceiling', async () => {
    await Promise.all([[49.994, 0.01, true], [49.996, 0.001, false]].map(async ([weight, incoming, accepted]) => {
        const subject = await engine();

        subject.registerItemDefinition(shoe('Base.Load', { weight }), { owner: 'base' });
        subject.registerItemDefinition(shoe('Base.Small', { weight: incoming }), { owner: 'base' });
        const load = subject.command({ type: 'spawnItem', fullType: 'Base.Load', x: 5, y: 5 }).id;
        const small = subject.command({ type: 'spawnItem', fullType: 'Base.Small', x: 5, y: 5 }).id;

        subject.command({ type: 'pickup', id: load });

        if (accepted) {
            subject.command({ type: 'pickup', id: small });
            assert.equal(subject.items()[1].location, 'inventory');
        } else {
            const before = subject.items();

            assert.throws(() => subject.command({ type: 'pickup', id: small }), RangeError);
            assert.deepEqual(subject.items(), before);
        }
    }));
});

test('native live base and actual weights remain independent across definition overrides', async () => {
    const subject = await engine();

    subject.registerItemDefinition(shoe('Base.Shoe', { weight: 1.25 }), { owner: 'base' });
    const id = subject.command({ type: 'spawnItem', fullType: 'Base.Shoe', x: 5, y: 5 }).id;

    subject.command({ type: 'pickup', id });
    subject.command({ type: 'setWeight', id, weight: 80.5 });
    assert.equal(subject.items()[0].weight, 80.5);
    assert.equal(subject.items()[0].actualWeight, 1.25);
    assert.equal(subject.inventoryState().capacityWeight, 1.25);
    subject.command({ type: 'setActualWeight', id, actualWeight: 2.125 });
    assert.equal(subject.items()[0].weight, 80.5);
    assert.equal(subject.inventoryState().capacityWeight, 2.125);
    subject.registerItemDefinition(shoe('Base.Shoe', { weight: 4.5 }), { owner: 'mod', override: true });
    subject.command({ type: 'spawnItem', fullType: 'Base.Shoe', x: 5, y: 5 });
    assert.deepEqual(subject.items().map(({ weight, actualWeight }) => [weight, actualWeight]),
        [[80.5, 2.125], [4.5, 4.5]]);
    const detached = subject.items();

    detached[0].actualWeight = 999;
    assert.equal(subject.items()[0].actualWeight, 2.125);
    const ordered = await engine();

    ordered.registerItemDefinition(shoe('Base.Ordered', { weight: 0 }), { owner: 'base' });
    const ids = [0, 1, 2].map(() => ordered.command({
        type: 'spawnItem', fullType: 'Base.Ordered', x: 5, y: 5,
    }).id);

    for (const orderedId of ids.toReversed()) {
        ordered.command({ type: 'pickup', id: orderedId });
    }

    for (const [orderedId, actualWeight] of [[ids[0], 16_777_216], [ids[1], 1], [ids[2], 1]]) {
        ordered.command({ type: 'setActualWeight', id: orderedId, actualWeight });
    }

    assert.deepEqual(ordered.items().map((item) => item.id), ids.toReversed());
    assert.equal(ordered.inventoryState().capacityWeight, 16_777_218,
        'f32 summation must follow pickup order, not spawn order');
    const orderedRestore = await engine();

    orderedRestore.registerItemDefinition(shoe('Base.Ordered', { weight: 0 }), { owner: 'base' });
    orderedRestore.importItems(ordered.items());
    orderedRestore.loadState(ordered.saveState());
    assert.equal(orderedRestore.inventoryState().capacityWeight, 16_777_218,
        'save item order must preserve the source float summation order');
    ordered.command({ type: 'drop', id: ids[2], x: 5, y: 5 });
    const orderBeforeRefusal = ordered.items();

    assert.throws(() => ordered.command({ type: 'pickup', id: ids[2] }), RangeError);
    assert.deepEqual(ordered.items(), orderBeforeRefusal);
});

test('native item weight restore and definition rollback refuse malformed overflow atomically', async () => {
    const subject = await engine();

    subject.registerItemDefinition(shoe('Base.Shoe', { weight: 1.25 }), { owner: 'base' });
    subject.beginItemDefinitionRegistration('mod');
    subject.registerItemDefinition(shoe('Base.Shoe', { weight: 3 }), { owner: 'mod', override: true });
    subject.registerItemDefinition(shoe('Base.Shoe', { weight: 4 }), { owner: 'mod', override: true });
    subject.rollbackItemDefinitionRegistration('mod');
    assert.equal(subject.itemDefinitions()[0].weight, 1.25);
    const id = subject.command({ type: 'spawnItem', fullType: 'Base.Shoe', x: 5, y: 5 }).id;

    subject.command({ type: 'setWeight', id, weight: 9.75 });
    subject.command({ type: 'setActualWeight', id, actualWeight: 0.125 });
    const records = subject.items();
    const restored = await engine();

    restored.registerItemDefinition(subject.itemDefinitions()[0], { owner: 'base' });
    restored.importItems(records);
    restored.loadState(subject.saveState());
    assert.deepEqual(restored.items(), records);
    const actor = restored.saveState();
    const definitions = restored.itemDefinitions();

    for (const value of [-Number.MIN_VALUE, Number.NaN, Infinity, Number.MAX_VALUE,
        3.402_823_466_385_288_6e38 + 2 ** 102, undefined, null]) {
        assert.throws(() => restored.registerItemDefinition(shoe('Bad.Weight', { weight: value }), { owner: 'base' }));
        assert.deepEqual(restored.itemDefinitions(), definitions);

        for (const field of ['weight', 'actualWeight']) {
            assert.throws(() => restored.command({ type: field === 'weight' ? 'setWeight' : 'setActualWeight', id, [field]: value }));
            assert.throws(() => restored.importItems([records[0], { ...records[0], id: 2, [field]: value }]));
            assert.deepEqual(restored.items(), records);
            assert.deepEqual(restored.saveState(), actor);
        }
    }

    const legacy = { ...records[0] };

    delete legacy.weight;
    delete legacy.actualWeight;
    restored.importItems([legacy]);
    assert.equal(restored.items()[0].weight, 1.25);
    assert.equal(restored.items()[0].actualWeight, 1.25);
    const defaultDefinition = shoe('Base.Default');

    delete defaultDefinition.weight;
    restored.registerItemDefinition(defaultDefinition, { owner: 'base' });
    restored.command({ type: 'spawnItem', fullType: 'Base.Default', x: 5, y: 5 });
    assert.equal(restored.items()[1].weight, 1);
    assert.equal(restored.items()[1].actualWeight, 1);
    const { instance } = await WebAssembly.instantiate(moduleBytes, {});
    const api = instance.exports;

    assert.equal(api.item_definition_register(0, 1, 30, 1, 1, 0, 20, 0, 1.25), 0);
    assert.equal(api.item_spawn(0, 5, 5, 1, 30), 0);
    assert.equal(api.item_import_begin(), 0);
    assert.equal(api.item_import_stage(50, 0, 1, 5, 5, 30, 1, 0, 2.5, 0.5), 0);
    assert.notEqual(api.item_import_stage(51, 0, 1, 5, 5, 30, 1, 0, 1, Number.MAX_VALUE), 0);
    assert.notEqual(api.item_import_commit(), 0);
    assert.equal(api.item_count(), 1);
    assert.equal(api.item_read(0), 0);
    assert.equal(new DataView(api.memory.buffer).getFloat64(api.scratch_ptr(), true), 1);

    for (const value of [-Number.MIN_VALUE, 3.402_823_466_385_288_6e38 + 2 ** 102, Number.NaN, Infinity]) {
        assert.notEqual(api.item_definition_register(1, 1, 30, 1, 1, 0, 20, 0, value), 0);
        assert.equal(api.item_definition_count(), 1);
        assert.notEqual(api.item_set_weight(1, value), 0);
        assert.notEqual(api.item_set_actual_weight(1, value), 0);
        assert.equal(api.item_read(0), 0);
        const live = new DataView(api.memory.buffer, api.scratch_ptr());

        assert.equal(live.getFloat64(64, true), 1.25);
        assert.equal(live.getFloat64(72, true), 1.25);
        assert.equal(api.item_import_begin(), 0);
        assert.equal(api.item_import_stage(50, 0, 1, 5, 5, 30, 1, 0, 2.5, 0.5), 0);
        assert.notEqual(api.item_import_stage(51, 0, 1, 5, 5, 30, 1, 0, 1, value), 0);
        assert.notEqual(api.item_import_commit(), 0);
        assert.equal(api.item_count(), 1);
        assert.equal(api.item_read(0), 0);
        assert.equal(new DataView(api.memory.buffer).getFloat64(api.scratch_ptr(), true), 1);
        api.state_save(api.scratch_ptr());
        assert.equal(new DataView(api.memory.buffer).getFloat64(api.scratch_ptr() + 88, true), 2);
    }
});

test('definition transactions restore first-touched numeric rows, owners and source metadata', async () => {
    const subject = await engine();
    const original = subject.registerItemDefinition(shoe(), { owner: 'base' });

    original.source.model = 'tampered';
    subject.beginItemDefinitionRegistration('mod');
    assert.throws(() => subject.beginItemDefinitionRegistration('mod'), /transaction|registration/u);
    assert.throws(() => subject.registerItemDefinition(shoe(), { owner: 'other', override: true }));
    subject.registerItemDefinition(shoe('Base.Shoe', { conditionMax: 6 }), { owner: 'mod', override: true });
    subject.registerItemDefinition(shoe('Base.Shoe', { conditionMax: 8 }), { owner: 'mod', override: true });
    subject.registerItemDefinition(shoe('Mod.Shoe'), { owner: 'mod' });
    assert.throws(() => subject.freezeItemDefinitions());
    assert.throws(() => subject.commitItemDefinitionRegistration('other'));
    subject.rollbackItemDefinitionRegistration('mod');
    assert.deepEqual(subject.itemDefinitions(), [{ ...shoe(), owner: 'base' }]);
    assert.throws(() => subject.registerItemDefinition(shoe(), { owner: 'base' }));
    subject.beginItemDefinitionRegistration('mod');
    subject.registerItemDefinition(shoe('Mod.Shoe'), { owner: 'mod' });
    subject.commitItemDefinitionRegistration('mod');
    assert.deepEqual(subject.itemDefinitions().map((row) => row.fullType), ['Base.Shoe', 'Mod.Shoe']);
    subject.freezeItemDefinitions();
    assert.throws(() => subject.registerItemDefinition(shoe('Late.Shoe'), { owner: 'late' }));
    assert.throws(() => subject.beginItemDefinitionRegistration('late'));
});

test('equipment replacement and broken-item policy preserve stable IDs and movement', async () => {
    const subject = await engine();

    subject.registerItemDefinition(shoe(), { owner: 'base' });
    subject.registerItemDefinition(shoe('Base.Disposable', { removeOnBroken: true }), { owner: 'base' });
    subject.freezeItemDefinitions();
    subject.command({ type: 'moveTo', x: 9, y: 7 });
    const before = subject.saveState().values.slice(0, 10);
    const first = subject.command({ type: 'spawnItem', fullType: 'Base.Shoe', x: 5, y: 5 }).id;
    const second = subject.command({ type: 'spawnItem', fullType: 'Base.Disposable', x: 5, y: 5 }).id;

    for (const id of [first, second]) {
        subject.command({ type: 'pickup', id });
        subject.command({ type: 'wear', id });
    }

    assert.equal(subject.wornItem('base:shoes').id, second);
    assert.equal(subject.items().find((item) => item.id === first).bodyLocation, null);
    subject.command({ type: 'setCondition', id: second, condition: 0 });
    assert.equal(subject.wornItem('base:shoes'), null);
    subject.command({ type: 'wear', id: first });
    subject.command({ type: 'setCondition', id: first, condition: 0 });
    assert.equal(subject.wornItem('base:shoes').condition, 0);
    assert.deepEqual(subject.saveState().values.slice(0, 10), before);
    subject.command({ type: 'unequip', id: first });
    subject.command({ type: 'drop', id: first, x: 6, y: 5 });
    assert.equal(subject.items()[0].location, 'ground');
    assert.equal(subject.items()[0].x, 6);
    assert.equal(subject.command({ type: 'spawnItem', fullType: 'Base.Shoe', x: 5, y: 5 }).id, second + 1);
    subject.step(STEP);
    assert.equal(subject.snapshot().action, MOVING);
});

test('explicit-ID import is atomic, detached and advances the exhausted sentinel without wrapping', async () => {
    const subject = await engine();

    subject.registerItemDefinition(shoe(), { owner: 'base' });
    const record = {
        id: 40, fullType: 'Base.Shoe', location: 'inventory',
        x: 5, y: 5, count: 1, condition: 12, bodyLocation: 'base:shoes',
    };

    subject.importItems([record]);
    const before = subject.items();
    const state = subject.saveState();

    for (const bad of [
        { ...record, id: 41, condition: 31 },
        { ...record, id: 41, fullType: 'Missing.Shoe' },
        { ...record, id: 41, bodyLocation: 'other:slot' },
        { ...record, id: 41, x: Infinity },
        { ...record, id: 41, count: 2 },
        { ...record, id: 40 },
    ]) {
        assert.throws(() => subject.importItems([record, bad]));
        assert.deepEqual(subject.items(), before);
        assert.deepEqual(subject.saveState(), state);
    }

    const detached = subject.items();

    detached[0].condition = 0;
    assert.equal(subject.wornItem('base:shoes').condition, 12);
    const invalidCounter = structuredClone(state);

    invalidCounter.values[11] = 40;
    assert.throws(() => subject.loadState(invalidCounter), RangeError);
    assert.deepEqual(subject.saveState(), state);
    subject.importItems([{ ...record, id: 4_294_967_295 }]);
    assert.equal(subject.saveState().values[11], 4_294_967_296);
    assert.throws(() => subject.command({ type: 'spawnItem', fullType: 'Base.Shoe', x: 5, y: 5 }));
    subject.importItems([]);
    assert.throws(() => subject.command({ type: 'spawnItem', fullType: 'Base.Shoe', x: 5, y: 5 }));
    assert.equal(subject.saveState().values[11], 4_294_967_296);
});

test('saved counters continue stable IDs and scalar health without a legacy actor representation', async () => {
    const original = await engine();

    original.registerItemDefinition(shoe(), { owner: 'base' });
    original.command({ type: 'walk', x: 1, y: 0 });
    const prefix = original.saveState().values.slice(0, 10);
    const id = original.command({ type: 'spawnItem', fullType: 'Base.Shoe', x: 5, y: 5 }).id;

    original.command({ type: 'setHealth', health: 0 });
    assert.equal(original.getHealth(), 0);
    assert.equal(original.isDead(), true);
    assert.equal(original.snapshot().dead, true);
    assert.deepEqual(original.saveState().values.slice(0, 10), prefix);
    const restored = await engine();

    restored.registerItemDefinition(shoe(), { owner: 'base' });
    restored.importItems(original.items());
    restored.loadState(original.saveState());
    assert.equal(restored.command({ type: 'spawnItem', fullType: 'Base.Shoe', x: 5, y: 5 }).id, id + 1);
    restored.worldReset();
    assert.equal(restored.items().length, 2);
    assert.equal(restored.getHealth(), 0);
    restored.reset();
    assert.deepEqual(restored.items(), []);
    assert.deepEqual(restored.itemDefinitions(), []);
    assert.equal(restored.getHealth(), 100);
});

test('item boundaries refuse malformed values and enforce capacity, world membership and project pickup radius', async () => {
    const subject = await engine();

    for (const extra of [{ conditionMax: 0 }, { stackLimit: 0 }, { removeOnBroken: 1 },
        { conditionLowerChanceOneIn: -1 }, { conditionMax: 2_147_483_648 },
        { stackLimit: 4_294_967_296 }, { bodyLocation: '' }]) {
        assert.throws(() => subject.registerItemDefinition(shoe('Bad.Shoe', extra), { owner: 'base' }));
        assert.deepEqual(subject.itemDefinitions(), []);
    }

    subject.registerItemDefinition(shoe(), { owner: 'base' });
    subject.worldImportCell(0, 0, cellBytes((x, y) => (x === 6 && y === 5 ? 1 : 0)));
    const id = subject.command({ type: 'spawnItem', fullType: 'Base.Shoe', x: 5, y: 5 }).id;

    subject.command({ type: 'pickup', id });
    subject.command({ type: 'drop', id, x: 6, y: 5 });
    subject.command({ type: 'pickup', id });
    subject.command({ type: 'drop', id, x: 8, y: 5 });
    const before = subject.items();
    const state = subject.saveState();

    for (const action of [{ type: 'pickup', id }, { type: 'wear', id },
        { type: 'drop', id, x: 256, y: 5 }, { type: 'setCondition', id, condition: 31 },
        { type: 'setCondition', id: 4_294_967_296, condition: 1 },
        { type: 'spawnItem', fullType: 'Base.Shoe', x: 5, y: 5, count: 2 },
        { type: 'setHealth', health: -1 }, { type: 'setHealth', health: 100.01 }]) {
        assert.throws(() => subject.command(action));
        assert.deepEqual(subject.items(), before);
        assert.deepEqual(subject.saveState(), state);
    }
});

test('numeric WASM staging cannot publish a valid prefix after a later invalid record', async () => {
    const { instance } = await WebAssembly.instantiate(moduleBytes, {});
    const api = instance.exports;

    assert.equal(api.item_definition_register(0, 1, 30, 1, 1, 0, 20, 0, 1), 0);
    assert.equal(api.item_spawn(0, 5, 5, 1, 30), 0);
    assert.equal(api.item_import_begin(), 0);
    assert.equal(api.item_import_stage(50, 0, 1, 5, 5, 20, 1, 1, 1, 1), 0);
    assert.notEqual(api.item_import_stage(51, 0, 1, 5, 5, 31, 1, 0, 1, 1), 0);
    assert.notEqual(api.item_import_commit(), 0);
    assert.equal(api.item_count(), 1);
    assert.equal(api.item_read(0), 0);
    assert.equal(new DataView(api.memory.buffer).getFloat64(api.scratch_ptr(), true), 1);
    assert.equal(api.item_definition_begin(2), 0);
    assert.equal(api.item_definition_register(0, 2, 40, 1, 1, 0, 10, 1, 2), 0);
    assert.equal(api.item_definition_register(0, 2, 50, 1, 1, 0, 5, 1, 3), 0);
    assert.equal(api.item_definition_rollback(2), 0);
    assert.equal(api.item_definition_read(0), 0);
    const row = new DataView(api.memory.buffer, api.scratch_ptr());

    assert.deepEqual(Array.from({ length: 7 }, (_, index) => row.getFloat64(index * 8, true)),
        [1, 30, 1, 1, 0, 20, 1]);
    assert.equal(api.item_definition_freeze(), 0);
    assert.notEqual(api.item_definition_register(0, 2, 40, 1, 1, 0, 10, 1, 2), 0);
});

test('live references refuse incompatible overrides and unloaded world holes refuse drops', async () => {
    const subject = await engine();

    subject.registerItemDefinition(shoe(), { owner: 'base' });
    subject.importItems([{
        id: 7, fullType: 'Base.Shoe', location: 'inventory',
        x: 5, y: 5, condition: 30, count: 1, bodyLocation: 'base:shoes',
    }]);
    const before = subject.itemDefinitions();

    subject.beginItemDefinitionRegistration('mod');

    for (const extra of [{ conditionMax: 6 }, { bodyLocation: 'base:hat' }]) {
        assert.throws(() => subject.registerItemDefinition(shoe('Base.Shoe', extra),
            { owner: 'mod', override: true }));
        assert.deepEqual(subject.itemDefinitions(), before);
    }

    subject.rollbackItemDefinitionRegistration('mod');
    subject.worldImportCell(0, 0, cellBytes());
    subject.worldImportCell(2, 0, cellBytes());
    const itemsBefore = subject.items();

    assert.throws(() => subject.command({ type: 'drop', id: 7, x: 300, y: 5 }));
    assert.deepEqual(subject.items(), itemsBefore);
    subject.command({ type: 'drop', id: 7, x: 530, y: 5 });
    assert.equal(subject.items()[0].x, 530);
});

test('the final uint32 ID is usable once and equipment commands leave a live heading intact', async () => {
    const subject = await engine();

    subject.registerItemDefinition(shoe('Base.Shoe', { removeOnBroken: true }), { owner: 'base' });
    subject.command({ type: 'walk', x: 1, y: 1 });
    const state = subject.saveState();

    state.values[11] = 4_294_967_295;
    subject.loadState(state);
    const prefix = subject.saveState().values.slice(0, 10);
    const id = subject.command({ type: 'spawnItem', fullType: 'Base.Shoe', x: 5, y: 5 }).id;

    assert.equal(id, 4_294_967_295);
    subject.command({ type: 'pickup', id });
    subject.command({ type: 'wear', id });
    subject.command({ type: 'unequip', id });
    subject.command({ type: 'drop', id, x: 5, y: 5 });
    subject.command({ type: 'pickup', id });
    subject.command({ type: 'wear', id });
    subject.command({ type: 'setCondition', id, condition: 0 });
    assert.deepEqual(subject.items(), []);
    assert.deepEqual(subject.saveState().values.slice(0, 10), prefix);
    assert.throws(() => subject.command({ type: 'spawnItem', fullType: 'Base.Shoe', x: 5, y: 5 }));
    subject.step(STEP);
    assert.equal(subject.snapshot().action, WALKING);
});

test('bounded numeric tables refuse overflow without changing live rows or the next ID', async () => {
    const { instance } = await WebAssembly.instantiate(moduleBytes, {});
    const api = instance.exports;

    for (let index = 0; index < 4_096; index += 1) {
        assert.equal(api.item_definition_register(index, 1, 30, 0, 1, 0, 20, 0, 1), 0);
        assert.equal(api.item_spawn(0, 5, 5, 1, 30), 0);
    }

    assert.notEqual(api.item_definition_register(4_096, 1, 30, 0, 1, 0, 20, 0, 1), 0);
    assert.notEqual(api.item_spawn(0, 5, 5, 1, 30), 0);
    assert.equal(api.item_definition_count(), 4_096);
    assert.equal(api.item_count(), 4_096);
    assert.equal(api.item_last_id(), 4_096);
    api.state_save(api.scratch_ptr());
    assert.equal(new DataView(api.memory.buffer).getFloat64(api.scratch_ptr() + 88, true), 4_097);
});

/**
 * Read one original moodle's authoritative level from a detached engine query.
 *
 * @param {import('../src/engine.js').Engine} subject - Engine instance under test.
 * @param {string} name - Original moodle name without the base namespace prefix.
 * @returns {number} Current derived level for that moodle.
 */
function moodleLevel(subject, name) {
    return subject.moodles().find(({ id }) => id === `base:${name}`).level;
}

test('all original moodles derive from owned inputs, including environment and body flags', async () => {
    const subject = await engine();

    assert.deepEqual(subject.moodles().map(({ id }) => id), [
        'base:endurance', 'base:tired', 'base:hungry', 'base:panic', 'base:sick',
        'base:bored', 'base:unhappy', 'base:bleeding', 'base:wet', 'base:hasacold',
        'base:angry', 'base:stress', 'base:thirst', 'base:injured', 'base:pain',
        'base:heavyload', 'base:drunk', 'base:dead', 'base:zombie', 'base:hyperthermia',
        'base:hypothermia', 'base:windchill', 'base:cantsprint', 'base:uncomfortable',
        'base:noxioussmell', 'base:foodeaten',
    ]);
    subject.command({
        type: 'setMoodleInputs', inputs: {
            endurance: 0, fatigue: 1, hunger: 1, panic: 100, sickness: 1,
            boredom: 100, unhappiness: 100, bleedingParts: 1, neckBleeding: true,
            wetness: 100, hasCold: true, coldStrength: 100, anger: 1,
            stress: 0.5, nicotineWithdrawal: 0.51, thirst: 1, pain: 100,
            capacityWeight: 14, maxWeight: 8, intoxication: 100, temperature: 40,
            windChill: 21, cantSprint: true, discomfort: 100, toxicBuilding: true,
            healthFromFoodTimer: 4_801,
        },
    });
    subject.command({ type: 'setHealth', health: 24 });

    for (let frame = 0; frame < 120; frame += 1) {
        subject.step(STEP);
    }

    assert.deepEqual(subject.moodles().map(({ level }) => level),
        [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 0, 0, 2, 0, 4, 1, 4, 4, 4]);
    subject.command({ type: 'setCharacterStat', name: 'temperature', value: 24 });
    assert.equal(moodleLevel(subject, 'hypothermia'), 4);
    const detached = subject.moodles();

    detached[0].level = 0;
    assert.equal(moodleLevel(subject, 'endurance'), 4);
});

test('injury strict boundaries and dead/zombie fake-infection gate follow original rules', async () => {
    const subject = await engine();

    for (const [health, level] of [[100, 0], [80, 0], [79.9, 1], [60, 1],
        [59.9, 2], [40, 2], [39.9, 3], [25, 3], [24.9, 4], [0, 0]]) {
        subject.command({ type: 'setHealth', health });
        assert.equal(moodleLevel(subject, 'injured'), level, `health=${health}`);
    }

    assert.equal(moodleLevel(subject, 'dead'), 4);
    subject.command({ type: 'setCharacterStat', name: 'zombieInfection', value: 0.001 });
    assert.equal(moodleLevel(subject, 'dead'), 0);
    assert.equal(moodleLevel(subject, 'zombie'), 4);
    assert.ok(subject.moodles().every(({ id, level }) => id === 'base:zombie' || level === 0));
    subject.command({ type: 'setMoodleInputs', inputs: { fakeInfected: true } });
    assert.equal(moodleLevel(subject, 'dead'), 4);
    assert.equal(moodleLevel(subject, 'zombie'), 0);
    subject.command({ type: 'setHealth', health: 100 });
    assert.equal(moodleLevel(subject, 'dead'), 0);
});

test('source stat, thermal, cold, load and environmental equality boundaries are retained', async () => {
    const subject = await engine();

    for (const [name, value, id, want] of [
        ['endurance', 0.75, 'endurance', 1], ['endurance', 0.5, 'endurance', 2],
        ['endurance', 0.25, 'endurance', 3], ['endurance', 0.1, 'endurance', 4],
        ['hunger', 0.15, 'hungry', 0], ['hunger', 0.25, 'hungry', 1],
        ['hunger', 0.45, 'hungry', 2], ['hunger', 0.7, 'hungry', 3],
        ['temperature', 37.5, 'hyperthermia', 0], ['temperature', 39, 'hyperthermia', 1],
        ['temperature', 40, 'hyperthermia', 2], ['temperature', 36.5, 'hypothermia', 0],
        ['temperature', 35, 'hypothermia', 1], ['temperature', 30, 'hypothermia', 2],
        ['temperature', 25, 'hypothermia', 3], ['discomfort', 20, 'uncomfortable', 1],
        ['discomfort', 40, 'uncomfortable', 2], ['discomfort', 60, 'uncomfortable', 3],
        ['discomfort', 80, 'uncomfortable', 4],
    ]) {
        subject.command({ type: 'setCharacterStat', name, value });
        assert.equal(moodleLevel(subject, id), want, `${name}=${value}`);
    }

    subject.command({ type: 'setMoodleInputs', inputs: { temperature: 34, intoxication: 71 } });
    assert.equal(moodleLevel(subject, 'hypothermia'), 0);
    subject.command({ type: 'setMoodleInputs', inputs: { intoxication: 70 } });
    assert.equal(moodleLevel(subject, 'hypothermia'), 2);

    for (const [capacityWeight, want] of [[8, 0], [8.1, 1], [10, 2], [12, 3], [14, 4]]) {
        subject.command({ type: 'setMoodleInputs', inputs: { capacityWeight } });
        assert.equal(moodleLevel(subject, 'heavyload'), want);
    }

    for (const [windChill, want] of [[10, 0], [10.1, 2], [15, 2], [15.1, 3], [20, 3], [20.1, 4]]) {
        subject.command({ type: 'setMoodleInputs', inputs: { windChill } });
        assert.equal(moodleLevel(subject, 'windchill'), want);
    }

    subject.command({ type: 'setMoodleInputs', inputs: { coldStrength: 100 } });
    assert.equal(moodleLevel(subject, 'hasacold'), 0);
    subject.command({ type: 'setMoodleInputs', inputs: { hasCold: true } });
    assert.equal(moodleLevel(subject, 'hasacold'), 4);
    subject.command({ type: 'setMoodleInputs', inputs: { corpseImpactEnabled: true } });

    for (const [corpseSicknessRate, want] of [[0, 0], [0.001, 1], [0.002, 2], [0.003, 3]]) {
        subject.command({ type: 'setMoodleInputs', inputs: { corpseSicknessRate } });
        assert.equal(moodleLevel(subject, 'noxioussmell'), want);
    }

    subject.command({ type: 'setMoodleInputs', inputs: { toxicBuilding: true, protectedFromToxic: true } });
    assert.equal(moodleLevel(subject, 'noxioussmell'), 3);
    subject.command({ type: 'setMoodleInputs', inputs: { protectedFromToxic: false } });
    assert.equal(moodleLevel(subject, 'noxioussmell'), 4);

    for (const [healthFromFoodTimer, want] of [[0, 0], [1_600, 1], [1_601, 2], [3_200, 2], [3_201, 3], [4_800, 3]]) {
        subject.command({ type: 'setMoodleInputs', inputs: { healthFromFoodTimer } });
        assert.equal(moodleLevel(subject, 'foodeaten'), want);
    }
});

test('moodle timers advance only on accepted steps and continue through detached save/load', async () => {
    const subject = await engine();

    subject.command({ type: 'walk', x: 1, y: 0 });
    subject.command({ type: 'setMoodleInputs', inputs: { pain: 76, cantSprint: true } });

    for (let frame = 0; frame < 119; frame += 1) {
        subject.step(STEP);
    }

    assert.equal(moodleLevel(subject, 'pain'), 0);
    const saved = subject.saveMoodleState();

    for (let query = 0; query < 150; query += 1) {
        subject.moodles();
    }

    assert.deepEqual(subject.saveMoodleState(), saved);
    assert.throws(() => subject.step(0));
    assert.deepEqual(subject.saveMoodleState(), saved);
    const restored = await engine();

    restored.loadMoodleState(saved);
    restored.step(STEP);
    assert.equal(moodleLevel(restored, 'pain'), 4);
    assert.equal(restored.saveMoodleState().painTimer, 0);
    restored.command({ type: 'setCharacterStat', name: 'pain', value: 0 });

    for (let frame = 0; frame < 119; frame += 1) {
        restored.step(STEP);
    }

    assert.equal(moodleLevel(restored, 'pain'), 4);
    restored.step(STEP);
    assert.equal(moodleLevel(restored, 'pain'), 0);

    for (let frame = 0; frame < 59; frame += 1) {
        restored.step(STEP);
    }

    assert.equal(moodleLevel(restored, 'cantsprint'), 1);
    restored.step(STEP);
    assert.equal(moodleLevel(restored, 'cantsprint'), 0);
    assert.equal(restored.saveMoodleState().cantSprintTimer, 300);
    subject.worldReset();
    assert.deepEqual(subject.saveMoodleState(), saved);
    saved.inputs.endurance = 0;
    assert.equal(subject.saveMoodleState().inputs.endurance, 1);
    subject.reset();
    assert.equal(subject.saveMoodleState().painTimer, 0);
    assert.equal(subject.saveMoodleState().inputs.cantSprint, false);
});

test('full and partial moodle imports refuse invalid fields atomically at full precision', async () => {
    const subject = await engine();

    subject.command({ type: 'setCharacterStat', name: 'hunger', value: 0.8 });
    const before = subject.saveMoodleState();

    for (const change of [
        { version: 2 }, { painTimer: 120 }, { painTimer: 0.1 }, { painLevel: 5 },
        { cantSprintTimer: 0 }, { extra: true },
        { inputs: { ...before.inputs, temperature: 40.000_000_001 } },
        { inputs: { ...before.inputs, hunger: Number.NaN } },
        { inputs: { ...before.inputs, hasCold: 1 } },
        { inputs: { ...before.inputs, maxWeight: 0 } },
    ]) {
        assert.throws(() => subject.loadMoodleState({ ...before, ...change }));
        assert.deepEqual(subject.saveMoodleState(), before);
    }

    const missing = structuredClone(before);

    delete missing.inputs.pain;
    assert.throws(() => subject.loadMoodleState(missing));

    for (const inputs of [{ hunger: 0.2, nonexistent: 0 }, { hunger: 0.2, endurance: -0.000_000_001 }]) {
        assert.throws(() => subject.command({ type: 'setMoodleInputs', inputs }));
        assert.deepEqual(subject.saveMoodleState(), before);
    }

    assert.throws(() => subject.command({ type: 'setCharacterStat', name: 'windChill', value: 1 }));
    const limits = subject.moodleInputLimits();

    assert.deepEqual(limits.hasCold, { type: 'boolean', default: false });
    assert.deepEqual(limits.temperature, { min: 20, max: 40, default: 37, integer: false });
    limits.temperature.max = 100;
    assert.equal(subject.moodleInputLimits().temperature.max, 40);
    subject.resetMoodleState();
    assert.equal(moodleLevel(subject, 'hungry'), 0);
    assert.equal(subject.saveState().values.length, 12);
});

test('remaining source thresholds, infection maximum and nicotine sum use real owned stats', async () => {
    const subject = await engine();

    for (const [name, id, cases] of [
        ['fatigue', 'tired', [[0.6, 0], [0.7, 1], [0.8, 2], [0.9, 3], [0.91, 4]]],
        ['panic', 'panic', [[6, 0], [30, 1], [65, 2], [80, 3], [81, 4]]],
        ['sickness', 'sick', [[0.25, 0], [0.5, 1], [0.75, 2], [0.9, 3], [0.91, 4]]],
        ['boredom', 'bored', [[25, 0], [50, 1], [75, 2], [90, 3], [91, 4]]],
        ['unhappiness', 'unhappy', [[20, 0], [45, 1], [60, 2], [80, 3], [81, 4]]],
        ['wetness', 'wet', [[15, 0], [40, 1], [70, 2], [90, 3], [91, 4]]],
        ['anger', 'angry', [[0.1, 0], [0.25, 1], [0.5, 2], [0.75, 3], [0.76, 4]]],
        ['stress', 'stress', [[0.25, 0], [0.5, 1], [0.75, 2], [0.9, 3], [0.91, 4]]],
        ['thirst', 'thirst', [[0.12, 0], [0.25, 1], [0.7, 2], [0.84, 3], [0.85, 4]]],
        ['intoxication', 'drunk', [[10, 0], [30, 1], [50, 2], [70, 3], [71, 4]]],
    ]) {
        for (const [value, want] of cases) {
            subject.command({ type: 'setCharacterStat', name, value });
            assert.equal(moodleLevel(subject, id), want, `${name}=${value}`);
        }
    }

    subject.command({
        type: 'setMoodleInputs', inputs: {
            sickness: 0, zombieInfection: 25, zombieFever: 25, foodSickness: 25,
        },
    });
    // max25/100, not summed75/100
    assert.equal(moodleLevel(subject, 'sick'), 0);
    subject.command({ type: 'setCharacterStat', name: 'foodSickness', value: 51 });
    assert.equal(moodleLevel(subject, 'sick'), 2);
    subject.command({ type: 'setMoodleInputs', inputs: { stress: 0.5, nicotineWithdrawal: 0.25 } });
    assert.equal(moodleLevel(subject, 'stress'), 2);
    subject.command({ type: 'setCharacterStat', name: 'nicotineWithdrawal', value: 0.51 });
    assert.equal(moodleLevel(subject, 'stress'), 4);
    subject.command({ type: 'setMoodleInputs', inputs: { neckBleeding: false } });

    for (const [bleedingParts, want] of [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [17, 4]]) {
        subject.command({ type: 'setMoodleInputs', inputs: { bleedingParts } });
        assert.equal(moodleLevel(subject, 'bleeding'), want);
    }

    subject.command({ type: 'setMoodleInputs', inputs: { hasCold: true } });

    for (const [coldStrength, want] of [[20, 0], [40, 1], [60, 2], [75, 3], [76, 4]]) {
        subject.command({ type: 'setMoodleInputs', inputs: { coldStrength } });
        assert.equal(moodleLevel(subject, 'hasacold'), want);
    }

    for (const [pain, want] of [[10, 0], [20, 1], [50, 2], [75, 3], [76, 4]]) {
        subject.command({ type: 'setCharacterStat', name: 'pain', value: pain });

        for (let frame = 0; frame < 120; frame += 1) {
            subject.step(STEP);
        }

        assert.equal(moodleLevel(subject, 'pain'), want);
    }

    subject.command({ type: 'setHealth', health: 0 });
    const deadTimers = subject.saveMoodleState();

    for (let frame = 0; frame < 120; frame += 1) {
        subject.step(STEP);
    }

    assert.deepEqual(subject.saveMoodleState(), deadTimers);
    subject.command({ type: 'setHealth', health: 100 });
    assert.equal(moodleLevel(subject, 'pain'), 0);
});

test('moodle state and death do not change the existing movement model or actor ABI', async () => {
    const normal = await engine();
    const affected = await engine();

    affected.command({ type: 'setMoodleInputs', inputs: { endurance: 0, pain: 100, cantSprint: true } });
    affected.command({ type: 'setHealth', health: 0 });

    for (const subject of [normal, affected]) {
        subject.command({ type: 'walk', x: 1, y: 1 });

        for (let frame = 0; frame < 60; frame += 1) {
            subject.step(STEP);
        }
    }

    assert.deepEqual(affected.saveState().values.slice(0, 10), normal.saveState().values.slice(0, 10));
    assert.equal(affected.snapshot().apiVersion, 1);
});

test('direct WASM moodle staging refuses malformed order, range and incomplete imports atomically', async () => {
    const { instance } = await WebAssembly.instantiate(moduleBytes, {});
    const api = instance.exports;

    assert.equal(api.set_character_stat(2, 0.8), 0);
    const before = Array.from({ length: 37 }, (_, index) => api.moodle_state_value(index));

    for (const [index, value] of [[0, 1.000_000_001], [0, Number.NaN], [1, 0], [34, 120]]) {
        api.moodle_import_begin();
        assert.notEqual(api.moodle_import_stage(index, value), 0);
        assert.notEqual(api.moodle_import_commit(), 0);
        assert.deepEqual(Array.from({ length: 37 }, (_, i) => api.moodle_state_value(i)), before);
    }

    api.moodle_import_begin();
    assert.equal(api.moodle_import_stage(0, 0), 0);
    assert.notEqual(api.moodle_import_commit(), 0);
    assert.deepEqual(Array.from({ length: 37 }, (_, index) => api.moodle_state_value(index)), before);

    for (const [index, value] of [[0, -0.000_000_001], [14, 40.000_000_001], [10, 0.510_000_001], [19, 0]]) {
        assert.notEqual(api.set_character_stat(index, value), 0);
        assert.deepEqual(Array.from({ length: 37 }, (_, i) => api.moodle_state_value(i)), before);
    }
});

/**
 * Source-shaped door; identity refers to CLOSED placement, not moved panels.
 *
 * @param {object} [extra={}] - Explicit source overrides.
 * @returns {object} Detached fixture.
 */
function nativeDoor(extra = {}) {
    return {
        id: 'door:10:10:0:0', x: 10, y: 10, z: 0, north: true,
        open: false, locked: false, lockedByKey: false, forceLocked: false,
        keyId: -1, roomId: -1, oppositeRoomId: -1, attachedE: false,
        attachedS: false, barricaded: false, independentWalls: 0,
        doubleDoor: 0, garageDoor: 0, interiorSide: false, ...extra,
    };
}

/**
 * Source square data stays separate from placement identities.
 *
 * @param {object} [extra={}] - Source overrides keyed by x:y.
 * @returns {object[]} Unique native square metadata.
 */
function doorSquares(extra = {}) {
    const rows = [];

    for (let y = 7; y <= 14; y += 1) {
        for (let x = 7; x <= 14; x += 1) {
            rows.push({
                x, y, z: 0, roomId: -1, outside: true, solid: false,
                solidTrans: false, tree: false, independentWalls: 0,
                vehicleObstructed: false, ...(extra[`${x}:${y}`] ?? {}),
            });
        }
    }

    return rows;
}

/**
 * Spawns through the existing authoritative actor save boundary.
 *
 * @param {object} subject - Real WASM wrapper.
 * @param {number} x - Actor x.
 * @param {number} y - Actor y.
 */
function doorSpawn(subject, x, y) {
    subject.loadState({ version: 2, values: [x, y, 1.5, x, y, 0, 0, 0, 0, 1, 100, 1] });
}

test('native doors close the original portal in both directions without corner cutting', async () => {
    const subject = await engine();

    subject.worldImportCell(0, 0, cellBytes());
    // Optional call keeps RED about observed traversal, not missing exports.
    subject.importDoors?.([nativeDoor()], { squares: doorSquares() });
    doorSpawn(subject, 10.5, 10.5);
    assert.throws(() => subject.command({ type: 'walk', x: 0, y: -1 }), /blocked/u,
        'a closed native door must block actual WASM movement');
    assert.throws(() => subject.command({ type: 'walk', x: -1, y: -1 }), /blocked/u);
    doorSpawn(subject, 10.5, 9.5);
    assert.throws(() => subject.command({ type: 'walk', x: 0, y: 1 }), /blocked/u);
    subject.toggleDoor(nativeDoor().id);
    subject.command({ type: 'walk', x: 0, y: 1 });
    subject.step(0.1);
    assert.ok(subject.snapshot().y > 9.5);
    subject.command({ type: 'cancel' });
    doorSpawn(subject, 10.5, 10.5);
    subject.command({ type: 'walk', x: 0, y: -1 });
    subject.step(0.1);
    assert.ok(subject.snapshot().y < 10.5);
});

test('native open ordinary doors leave render-wing edges passable and preserve independent walls', async () => {
    const subject = await engine();

    for (const [door, from, heading, opposite] of [
        [nativeDoor({ open: true }), [10.5, 10.5], [-1, 0], [9.5, 10.5]],
        [nativeDoor({ open: true, north: false }), [10.5, 10.5], [0, -1], [10.5, 9.5]],
        [nativeDoor({ open: true, attachedE: true }), [10.5, 10.5], [1, 0], [11.5, 10.5]],
        [nativeDoor({ open: true, attachedS: true }), [10.5, 10.5], [0, 1], [10.5, 11.5]],
    ]) {
        const portalFlags = door.north ? 2 : 4;

        subject.worldImportCell(0, 0, cellBytes((x, y) => (x === 10 && y === 10 ? portalFlags : 0)));
        subject.importDoors([door], { squares: doorSquares() });

        for (const [position, direction] of [
            [from, heading], [opposite, heading.map((value) => -value)],
        ]) {
            doorSpawn(subject, ...position);
            subject.command({ type: 'walk', x: direction[0], y: direction[1] });
            subject.step(0.1);
            assert.ok(subject.snapshot().x !== position[0] || subject.snapshot().y !== position[1],
                'native open TestCollide must not add a rotated render-wing blocker');
            subject.command({ type: 'cancel' });
        }
    }

    subject.worldImportCell(0, 0, cellBytes((x, y) => (x === 10 && y === 10 ? 2 : 0)));
    subject.importDoors([nativeDoor({ open: true, independentWalls: 2 })],
        { squares: doorSquares({ '10:10': { independentWalls: 2 } }) });
    doorSpawn(subject, 10.5, 10.5);
    assert.throws(() => subject.command({ type: 'walk', x: 0, y: -1 }), /blocked/u);
    doorSpawn(subject, 10.5, 9.5);
    assert.throws(() => subject.command({ type: 'walk', x: 0, y: 1 }), /blocked/u);
});

test('native door refusals leave lock state actor state and revision untouched', async () => {
    const subject = await engine();

    subject.worldImportCell(0, 0, cellBytes());

    for (const [door, squares, position] of [
        [nativeDoor({ locked: true }), doorSquares(), [10.5, 9.5]],
        [nativeDoor({ locked: true, lockedByKey: true, keyId: 7 }), doorSquares(), [10.5, 9.5]],
        [nativeDoor({ barricaded: true }), doorSquares(), [10.5, 10.5]],
        [nativeDoor(), doorSquares({ '10:10': { solid: true } }), [10.5, 9.5]],
        [nativeDoor(), doorSquares({ '10:10': { solidTrans: true } }), [10.5, 9.5]],
        [nativeDoor(), doorSquares({ '10:10': { tree: true } }), [10.5, 9.5]],
        [nativeDoor(), doorSquares(), [13.5, 13.5]],
        [nativeDoor({ id: 'door:10:10:1:0', z: 1 }), doorSquares(), [10.5, 10.5]],
    ]) {
        subject.importDoors([door], { squares });
        doorSpawn(subject, ...position);
        const before = subject.saveDoorState();
        const actor = subject.saveState();

        assert.throws(() => subject.toggleDoor(door.id), RangeError);
        assert.deepEqual(subject.saveDoorState(), before);
        assert.deepEqual(subject.saveState(), actor);
    }
});

test('native inside unlocking requires the exact adjacent room and respects forceLocked', async () => {
    const subject = await engine();
    const squares = doorSquares({
        '10:10': { roomId: 7, outside: false },
        '10:9': { roomId: 8, outside: false },
        '11:10': { roomId: 99, outside: false },
    });
    const door = nativeDoor({ locked: true, lockedByKey: true, keyId: 12, roomId: 7, oppositeRoomId: 8 });

    subject.worldImportCell(0, 0, cellBytes());
    subject.importDoors([door], { squares });
    doorSpawn(subject, 11.5, 10.5);
    assert.throws(() => subject.toggleDoor(door.id), RangeError);
    doorSpawn(subject, 10.5, 9.5);
    subject.command({ type: 'toggleDoor', id: door.id });
    assert.equal(subject.doors()[0].open, true);
    assert.equal(subject.doors()[0].locked, false);
    assert.equal(subject.doors()[0].lockedByKey, false);
    subject.importDoors([{ ...door, forceLocked: true }], { squares });
    const before = subject.saveDoorState();

    assert.throws(() => subject.toggleDoor(door.id), RangeError);
    assert.deepEqual(subject.saveDoorState(), before);
});

test('native door imports and restores validate all identities atomically', async () => {
    const subject = await engine();

    subject.worldImportCell(0, 0, cellBytes());
    subject.importDoors([nativeDoor()], { squares: doorSquares() });
    const before = subject.saveDoorState();
    const actor = subject.saveState();

    for (const rows of [
        [nativeDoor(), nativeDoor()], [nativeDoor(), nativeDoor({ id: 'wrong' })],
        [nativeDoor({ open: 1 })], [nativeDoor({ x: 10.25 })],
        [nativeDoor({ doubleDoor: 9 })], [nativeDoor({ roomId: Number.NaN })],
    ]) {
        assert.throws(() => subject.importDoors(rows, { squares: doorSquares() }));
        assert.deepEqual(subject.saveDoorState(), before);
        assert.deepEqual(subject.saveState(), actor);
    }

    for (const state of [
        { ...before, doors: [] },
        { ...before, doors: [{ ...before.doors[0], id: 'door:99:99:0:0' }] },
        { ...before, doors: [{ ...before.doors[0], open: true, x: 11 }] },
        { ...before, doors: [{ ...before.doors[0], locked: 1 }] },
        { ...before, revision: -1 },
    ]) {
        assert.throws(() => subject.loadDoorState(state));
        assert.deepEqual(subject.saveDoorState(), before);
    }

    const detached = subject.doors();

    detached[0].open = true;
    detached[0].id = 'modified';
    assert.deepEqual(subject.saveDoorState(), before);
});

test('native door saved closure and lock state restore without RNG or identity reroll', async () => {
    const subject = await engine();
    const restored = await engine();
    const rows = [nativeDoor({ locked: true, lockedByKey: true, keyId: 42, roomId: 7 })];
    const squares = doorSquares({ '10:10': { roomId: 7, outside: false } });

    for (const instance of [subject, restored]) {
        instance.worldImportCell(0, 0, cellBytes());
        instance.importDoors(rows, { squares });
        doorSpawn(instance, 10.5, 10.5);
    }

    const locked = subject.saveDoorState();

    subject.toggleDoor(rows[0].id);
    assert.equal(subject.saveDoorState().revision, locked.revision + 1);
    subject.toggleDoor(rows[0].id);
    assert.equal(subject.doors()[0].locked, false);
    const closed = subject.saveDoorState();

    restored.loadDoorState(closed);
    assert.deepEqual(restored.saveDoorState(), closed);
    restored.loadDoorState(closed);
    assert.deepEqual(restored.saveDoorState(), closed, 'unchanged restoration must not increment revision');
    restored.loadDoorState(locked);
    assert.deepEqual(restored.saveDoorState(), locked);
});

test('native door changes invalidate already planned routes before crossing', async () => {
    const subject = await engine();

    subject.worldImportCell(0, 0, cellBytes((x, y) => (
        x === 10 && y >= 8 && y <= 12 ? 0 : 1
    )));
    subject.importDoors([nativeDoor({ open: true })], { squares: doorSquares() });
    doorSpawn(subject, 10.5, 10.5);
    subject.command({ type: 'moveTo', x: 10.5, y: 8.5 });
    subject.toggleDoor(nativeDoor().id);
    runUntilIdle(subject);
    assert.ok(subject.snapshot().y >= 10, 'stale direct route crossed a closed portal');
});

test('native double panels move together and garage panels retain their original edge', async () => {
    const subject = await engine();
    const rows = [1, 2, 3, 4].map((doubleDoor) => nativeDoor({
        id: `door:${9 + doubleDoor}:10:0:0`, x: 9 + doubleDoor, doubleDoor,
        attachedE: doubleDoor >= 3,
    }));

    subject.worldImportCell(0, 0, cellBytes());
    subject.importDoors(rows, { squares: doorSquares() });
    doorSpawn(subject, 10.5, 10.5);
    subject.toggleDoor(rows[0].id);
    assert.deepEqual(subject.doors().map(({ open, x, y }) => [open, x, y]),
        [[true, 10, 10], [true, 10, 11], [true, 13, 11], [true, 13, 10]]);
    assert.ok(subject.doors().every(({ toggled }) => toggled === true));
    subject.toggleDoor(rows[0].id);
    assert.deepEqual(subject.doors().map(({ open, x, y }) => [open, x, y]),
        [[false, 10, 10], [false, 11, 10], [false, 12, 10], [false, 13, 10]]);
    assert.ok(subject.doors().every(({ toggled }) => toggled === true));
    const garage = [1, 2, 3].map((garageDoor) => nativeDoor({
        id: `door:${9 + garageDoor}:10:0:0`, x: 9 + garageDoor, garageDoor,
    }));

    subject.importDoors(garage, { squares: doorSquares() });
    subject.toggleDoor(garage[1].id);
    assert.ok(subject.doors().every(({ open }) => open));
    assert.ok(subject.doors().every(({ toggled }) => toggled === true));
    subject.command({ type: 'walk', x: 0, y: -1 });
    subject.command({ type: 'cancel' });
    subject.command({ type: 'walk', x: -1, y: 0 });
});

test('native new-world door constructors own seeded probabilities and force/open overrides', async () => {
    const subject = await engine();
    const repeat = await engine();
    const rows = [];
    const squares = [];

    for (let y = 0; y <= 33; y += 1) {
        for (let x = 0; x <= 33; x += 1) {
            squares.push({
                x, y, z: 0, roomId: -1, outside: true, solid: false,
                solidTrans: false, tree: false, independentWalls: 0, windows: 0,
                doorWalls: 0, vehicleObstructed: false,
            });

            if (x >= 1 && x <= 32 && y >= 1 && y <= 32) {
                rows.push(nativeDoor({ id: `door:${x}:${y}:0:0`, x, y }));
            }
        }
    }

    for (const instance of [subject, repeat]) {
        instance.worldImportCell(0, 0, cellBytes());
        instance.importDoors(rows, { squares, seed: 12_345, initializeLocks: true });
    }

    assert.deepEqual(subject.saveDoorState(), repeat.saveDoorState(), 'port seed must reproduce native state');
    const initialized = subject.saveDoorState();
    const lockedCount = initialized.doors.filter(({ locked }) => locked).length;
    const keyedCount = initialized.doors.filter(({ lockedByKey }) => lockedByKey).length;

    assert.ok(lockedCount >= 400 && lockedCount <= 620, `default4 locks ${lockedCount}/1024`);
    assert.ok(keyedCount >= 100 && keyedCount <= 260, `conditional1/3 key locks ${keyedCount}/1024`);
    assert.notDeepEqual(initialized.rngState, [12_345, 0]);
    subject.importDoors(rows, { squares, seed: 12_345, lockedHouses: 1, initializeLocks: true });
    assert.ok(subject.doors().every(({ locked, lockedByKey }) => !locked && !lockedByKey));
    assert.deepEqual(subject.saveDoorState().rngState, [12_345, 0], 'NeverLocked skips native random draws');
    subject.importDoors([
        nativeDoor({ forceLocked: true }),
        nativeDoor({ id: 'door:11:10:0:0', x: 11, forceLocked: true, open: true }),
    ], { squares, seed: 12_345, lockedHouses: 1, initializeLocks: true });
    assert.deepEqual(subject.doors().map(({ locked, lockedByKey }) => [locked, lockedByKey]),
        [[true, true], [false, false]], 'native forceLocked then initial open override order');
    repeat.loadDoorState(initialized);
    assert.deepEqual(repeat.saveDoorState(), initialized, 'restore must not invoke constructor RNG');
});

test('native special-panel obstruction and unrelated reach blockers refuse atomically', async () => {
    const subject = await engine();

    subject.worldImportCell(0, 0, cellBytes());
    const doubles = [1, 2, 3, 4].map((doubleDoor) => nativeDoor({
        id: `door:${9 + doubleDoor}:10:0:0`, x: 9 + doubleDoor, doubleDoor,
    }));

    subject.importDoors(doubles, { squares: doorSquares({ '11:11': { tree: true } }) });
    doorSpawn(subject, 10.5, 10.5);
    let before = subject.saveDoorState();

    assert.throws(() => subject.toggleDoor(doubles[0].id), RangeError);
    assert.deepEqual(subject.saveDoorState(), before);
    const garage = [1, 2, 3].map((garageDoor) => nativeDoor({
        id: `door:${9 + garageDoor}:10:0:0`, x: 9 + garageDoor, garageDoor, open: true,
    }));

    subject.importDoors(garage, { squares: doorSquares({ '12:10': { vehicleObstructed: true } }) });
    before = subject.saveDoorState();
    assert.throws(() => subject.toggleDoor(garage[0].id), RangeError);
    assert.deepEqual(subject.saveDoorState(), before);
    subject.importDoors([nativeDoor()], { squares: doorSquares({ '10:10': { independentWalls: 4 } }) });
    doorSpawn(subject, 9.5, 10.5);
    before = subject.saveDoorState();
    assert.throws(() => subject.toggleDoor(nativeDoor().id), RangeError);
    assert.deepEqual(subject.saveDoorState(), before);
    subject.importDoors([nativeDoor({ locked: true, lockedByKey: true, hoppable: true })],
        { squares: doorSquares() });
    doorSpawn(subject, 10.5, 10.5);
    subject.toggleDoor(nativeDoor().id);
    assert.equal(subject.doors()[0].locked, false);
    assert.equal(subject.doors()[0].lockedByKey, false);
});

test('native barricaded open doors block original facing edges but not render wings', async () => {
    const subject = await engine();

    for (const door of [
        nativeDoor({ open: true, barricaded: true }),
        nativeDoor({ open: true, barricaded: true, north: false }),
        nativeDoor({ open: true, barricaded: true, attachedE: true }),
        nativeDoor({ open: true, barricaded: true, attachedS: true }),
    ]) {
        const portalFlags = door.north ? 2 : 4;

        subject.worldImportCell(0, 0, cellBytes((x, y) => (x === 10 && y === 10 ? portalFlags : 0)));
        subject.importDoors([door], { squares: doorSquares() });
        const originalHeading = door.north ? [0, -1] : [-1, 0];
        const originalOpposite = door.north ? [10.5, 9.5] : [9.5, 10.5];

        doorSpawn(subject, 10.5, 10.5);
        assert.throws(() => subject.command({
            type: 'walk', x: originalHeading[0], y: originalHeading[1],
        }), /blocked/u, 'native barricades retain the original getNorth() facing');
        doorSpawn(subject, ...originalOpposite);
        assert.throws(() => subject.command({
            type: 'walk', x: -originalHeading[0], y: -originalHeading[1],
        }), /blocked/u);
        let wingHeading;

        if (door.attachedE) {
            wingHeading = [1, 0];
        } else if (door.attachedS) {
            wingHeading = [0, 1];
        } else if (door.north) {
            wingHeading = [-1, 0];
        } else {
            wingHeading = [0, -1];
        }

        const wingOpposite = [10.5 + wingHeading[0], 10.5 + wingHeading[1]];

        for (const [position, direction] of [
            [[10.5, 10.5], wingHeading],
            [wingOpposite, wingHeading.map((value) => -value)],
        ]) {
            doorSpawn(subject, ...position);
            subject.command({ type: 'walk', x: direction[0], y: direction[1] });
            subject.step(0.1);
            assert.ok(subject.snapshot().x !== position[0] || subject.snapshot().y !== position[1]);
            subject.command({ type: 'cancel' });
        }

        doorSpawn(subject, 10.5, 10.5);
        const before = subject.saveDoorState();

        assert.throws(() => subject.toggleDoor(door.id), RangeError);
        assert.deepEqual(subject.saveDoorState(), before);
    }
});

test('native door render history survives toggling back and portable restoration per identity', async () => {
    const subject = await engine();
    const restored = await engine();
    const rows = [nativeDoor(), nativeDoor({ id: 'door:13:13:0:0', x: 13, y: 13 })];
    const squares = doorSquares();

    for (const instance of [subject, restored]) {
        instance.worldImportCell(0, 0, cellBytes());
        instance.importDoors(rows, { squares });
        doorSpawn(instance, 10.5, 10.5);
    }

    subject.toggleDoor(rows[0].id);
    subject.toggleDoor(rows[0].id);
    assert.deepEqual(subject.doors().map(({ open, toggled }) => [open, toggled]),
        [[false, true], [false, false]], 'native art family is per door, not inferred from current open/revision');
    const saved = subject.saveDoorState();

    assert.deepEqual(saved.doors.map(({ toggled }) => toggled), [true, false]);
    restored.loadDoorState(saved);
    assert.deepEqual(restored.saveDoorState(), saved);
    assert.deepEqual(restored.doors().map(({ toggled }) => toggled), [true, false]);

    for (const value of [undefined, 0, 'true', null]) {
        const bad = structuredClone(saved);

        bad.doors[0].toggled = value;
        assert.throws(() => restored.loadDoorState(bad));
        assert.deepEqual(restored.saveDoorState(), saved);
    }

    const before = restored.saveDoorState();

    assert.throws(() => restored.toggleDoor(rows[1].id), RangeError);
    assert.deepEqual(restored.saveDoorState(), before);
    restored.importDoors(rows.map((row) => ({ ...row, toggled: true })), { squares });
    assert.ok(restored.doors().every(({ toggled }) => toggled === false),
        'source imports cannot spoof native successful-toggle history');
});
