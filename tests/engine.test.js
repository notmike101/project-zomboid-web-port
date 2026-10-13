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
    subject.loadState({ version: 1, values: [10.5, 5.5, 1.5, 10.5, 5.5, 0, 0, 0, 0, 1] });
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
    subject.loadState({ version: 1, values: [530.5, 278.5, 1.5, 530.5, 278.5, 0, 0, 0, 0, 1] });
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
    original.loadState({ version: 1, values: [530.5, 278.5, 3, 530.5, 278.5, 0, 0, 0, 0, 1] });
    original.command({ type: 'moveTo', x: 534.5, y: 278.5 });

    for (let index = 0; index < 8; index += 1) {
        original.step(STEP);
    }

    const saved = original.saveState();

    assert.equal(saved.version, 1);
    assert.equal(saved.values.length, 10);
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

    for (const state of [null, {}, { version: 2, values: before.values },
        { version: 1, values: before.values.slice(1) },
        { version: 1, values: new Float64Array(before.values) },
        { version: 1, values: Array.from({ length: 10 }) }]) {
        assert.throws(() => subject.loadState(state), TypeError);
        assert.deepEqual(subject.saveState(), before);
    }

    for (let index = 0; index < 10; index += 1) {
        const values = [...before.values];

        values[index] = Infinity;
        assert.throws(() => subject.loadState({ version: 1, values }), TypeError);
        assert.deepEqual(subject.saveState(), before);
    }

    for (const [index, value] of [[0, -1], [2, 0], [3, 300], [7, 3], [7, 0.5],
        [8, -1], [8, 0.5], [8, 4_294_967_296], [9, 0], [9, 0.5]]) {
        const values = [...before.values];

        values[index] = value;
        assert.throws(() => subject.loadState({ version: 1, values }), RangeError);
        assert.deepEqual(subject.saveState(), before);
    }

    const blocked = [...before.values];

    blocked[0] = 7.5;
    blocked[1] = 7.5;
    assert.throws(() => subject.loadState({ version: 1, values: blocked }), RangeError);
    assert.deepEqual(subject.saveState(), before);
});
