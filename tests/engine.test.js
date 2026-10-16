// These tests drive the real compiled WASM module: run `npm run build` first.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { createEngine, WORLD_CLOCK_DEFAULT_STATE, normalizeWorldClockState } from '../src/engine.js';
import { parseItemDefinitions } from '../src/item-definitions.js';
import { assertDoorRefused, completeActions, completeQueueRequest, importPickupSquares } from './queue-test-helpers.js';

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
async function engine() {
    const subject = await createEngine(moduleBytes);
    const e = subject.equipmentOperation;
    const group = e('groupGet', 'Human', true);

    for (const name of ['Shoes', 'Hands']) {
        e('locationAdd', group, e('lookup', name));
    }

    return subject;
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

test('world clock owns source f32 order, strict seven crossing and single midnight rollover', async () => {
    const subject = await engine();
    const source = subject.sourceActions;
    const f = Math.fround;

    assert.deepEqual(subject.worldClockState(), WORLD_CLOCK_DEFAULT_STATE);
    assert.equal(source.worldClockGet('worldAgeHours'), 2);
    subject.frameStep(STEP);
    const delta = f(f(f(f(1 / 90) / 60) * f(0.8)) / 2);

    assert.equal(source.worldClockGet('timeOfDay'), f(9 + delta));
    subject.importWorldClockState({ ...WORLD_CLOCK_DEFAULT_STATE, timeOfDay: 7 });
    subject.step(0);
    assert.equal(source.worldClockGet('nightsSurvived'), 1);
    subject.importWorldClockState({ ...WORLD_CLOCK_DEFAULT_STATE, timeOfDay: f(7 - delta) });
    subject.step(0);
    assert.equal(source.worldClockGet('timeOfDay'), 7);
    assert.equal(source.worldClockGet('nightsSurvived'), 0);
    subject.importWorldClockState({ ...WORLD_CLOCK_DEFAULT_STATE, year: 1_500, month: 1, day: 27, timeOfDay: 24 });
    subject.step(0);
    assert.equal(source.worldClockGet('day'), 28, 'default GregorianCalendar uses Julian leap years before cutover');
    assert.equal(source.worldClockDaysInMonth(1_500, 1), 29);
    assert.equal(source.worldClockDaysInMonth(1_700, 1), 28);
    subject.importWorldClockState({ ...WORLD_CLOCK_DEFAULT_STATE, month: 11, day: 30, timeOfDay: 72 });
    subject.step(0);
    assert.equal(source.worldClockGet('timeOfDay'), f(f(72 + delta) - 24));
    assert.equal(source.worldClockGet('year'), 1_994);
    assert.equal(source.worldClockGet('month'), 0);
    assert.equal(source.worldClockGet('day'), 0);
});

test('world clock imports atomically and setters preserve source direct assignment', async () => {
    const subject = await engine();
    const source = subject.sourceActions;
    const direct = {
        ...WORLD_CLOCK_DEFAULT_STATE, year: -1, month: 37, day: -5, nightsSurvived: -7,
        timeOfDay: -1.25, lastTimeOfDay: 25.125, minutesPerDay: -90,
    };

    subject.importWorldClockState(direct);
    assert.deepEqual(subject.worldClockState(), direct);
    assert.equal(source.worldClockGet('hour'), -2);
    assert.equal(source.worldClockGet('minutes'), -15);
    source.worldClockSet('timeOfDay', 9.123_456_789);
    assert.equal(source.worldClockGet('timeOfDay'), Math.fround(9.123_456_789));
    const before = subject.worldClockState();

    for (const patch of [{ version: 2 }, { day: 0.5 }, { year: 2 ** 31 }, { minutesPerDay: Infinity },
        { timeOfDay: 3.5e38 }, { lastTimeOfDay: '9' }]) {
        assert.throws(() => subject.importWorldClockState({ ...before, ...patch }));
        assert.deepEqual(subject.worldClockState(), before);
    }

    assert.throws(() => source.worldClockSet('hour', 1));
    assert.equal(source.worldClockCheckHours(-1, 7), 7);
    assert.equal(source.worldClockCheckHours(8, 7), 7);
    const canonical = normalizeWorldClockState(before);

    canonical.day = 99;
    assert.deepEqual(subject.worldClockState(), before);
    source.worldClockSet('timeOfDay', 25);
    const raw = subject.worldClockState();
    const actor = subject.snapshot();
    const timing = subject.sourceTiming.getState();

    assert.throws(() => subject.frameStep(STEP));
    assert.deepEqual(subject.worldClockState(), raw, 'reached malformed month refuses without normalizing');
    assert.deepEqual(subject.snapshot(), actor);
    assert.deepEqual(subject.sourceTiming.getState(), timing);
    source.worldClockSet('minutesPerDay', 0);
    assert.throws(() => subject.frameStep(STEP));
    assert.equal(source.worldClockGet('timeOfDay'), 25, 'nonfinite source delta refuses atomically');
    subject.loadState(subject.saveState());
    assert.deepEqual(subject.worldClockState(), WORLD_CLOCK_DEFAULT_STATE);
});

test('native climate preserves exact continuation, absence and malformed restore rollback', async () => {
    const subject = await engine();
    const restored = await engine();
    const absent = subject.saveClimateState();

    assert.equal(subject.isClimateInitialized(), false);
    restored.loadClimateState(absent);
    assert.equal(restored.isClimateInitialized(), false);

    for (const timeZone of ['', '\0', 'x'.repeat(129), null, 'Not/AZone']) {
        assert.throws(() => subject.initializeClimate(0x12_34_56_78, timeZone));
        assert.equal(subject.isClimateInitialized(), false, 'invalid zone admission cannot partially initialize the producer');
    }

    subject.initializeClimate(0x12_34_56_78, 'America/Chicago');
    assert.equal(subject.isClimateInitialized(), true);
    assert.throws(() => subject.initializeClimate(7), /refused|range/iu);
    const utc = await engine();

    utc.initializeClimate(0x12_34_56_78, 'UTC');
    assert.notDeepEqual(utc.saveClimateState(), subject.saveClimateState(),
        'identical entropy does not erase the actual source local calendar zone');
    utc.loadClimateState(subject.saveClimateState());
    assert.deepEqual(utc.saveClimateState(), subject.saveClimateState(), 'restore retains saved zone instead of current host zone');

    for (let frame = 0; frame < 150; frame++) {
        subject.frameStep(1);
    }

    const clock = subject.worldClockState();
    const climate = subject.saveClimateState();

    restored.importWorldClockState(clock);
    restored.loadClimateState(climate);
    assert.deepEqual(restored.saveClimateState(), climate);

    for (const malformed of [climate.subarray(0, 3), new Uint8Array(climate.length), Uint8Array.of(...climate, 0)]) {
        assert.throws(() => restored.loadClimateState(malformed));
        assert.deepEqual(restored.saveClimateState(), climate);
        assert.deepEqual(restored.worldClockState(), clock);
    }

    restored.sourceActions.worldClockSet('month', 37);
    const invalidClock = restored.worldClockState();
    const actor = restored.snapshot();
    const timing = restored.sourceTiming.getState();

    assert.throws(() => restored.frameStep(1));
    assert.deepEqual(restored.worldClockState(), invalidClock, 'producer rejection rolls back the preceding source clock advance');
    assert.deepEqual(restored.sourceTiming.getState(), timing);
    assert.deepEqual(restored.snapshot(), actor);
    assert.deepEqual(restored.saveClimateState(), climate);
    restored.importWorldClockState(clock);

    for (let frame = 0; frame < 300; frame++) {
        subject.frameStep(1);
        restored.frameStep(1);
    }

    assert.deepEqual(restored.saveClimateState(), subject.saveClimateState());
    restored.loadClimateState(absent);
    assert.equal(restored.isClimateInitialized(), false);
});

test('zero explicit step advances one logic frame and raw RAF elapsed preserves source FPS', async () => {
    const subject = await engine();

    subject.step(0);
    assert.equal(subject.snapshot().tick, 1);
    assert.equal(subject.sourceTiming.getState().fpsMultiplier, 1);
    subject.frameStep(0.5);
    assert.equal(subject.snapshot().tick, 2);
    assert.equal(subject.sourceTiming.getState().fpsMultiplier, 5);
    assert.equal(subject.sourceTiming.getState().elapsedSeconds, 0.5);
    assert.throws(() => subject.frameStep(-1));
});

test('native actor input nullifies only live aim and refreshes held input without cancelling work', async () => {
    const subject = await engine();
    const input = subject.sourceActions;
    const initial = {
        forceAim: false, charging: false, rawAiming: false, aiming: false,
        cachedAiming: false, cachedCharging: false, aimDown: false,
    };

    assert.deepEqual(input.actorInputState(0), initial);
    assert.equal(input.setIsAiming(0, true), undefined);
    assert.equal(input.actorIsAiming(0), true, 'the real raw setter reaches the effective getter');
    assert.equal(input.setForceAim(0, true), undefined);
    input.refreshActorInput(0, true, false, false);
    const held = input.actorInputState(0);

    assert.ok(held.forceAim && held.charging && held.rawAiming && held.aiming && held.aimDown);
    subject.actions.requestWalk({ x: 6, y: 5, z: 0 });
    const queue = subject.actions.getState();
    const movement = subject.saveState();

    assert.equal(input.nullifyAiming(0), undefined);
    assert.deepEqual(input.actorInputState(0), {
        ...held, forceAim: false, charging: false, rawAiming: false, aiming: false,
    });
    assert.deepEqual(subject.actions.getState(), queue);
    assert.deepEqual(subject.saveState(), movement);
    input.refreshActorInput(0, true, false, false);
    assert.equal(input.actorIsAiming(0), true, 'held physical input reasserts on the next refresh');
    assert.equal(input.actorInputState(0).charging, true);
    input.nullifyAiming(0);
    input.nullifyAiming(0);
    assert.equal(input.actorIsAiming(0), false);
    assert.equal(input.toggleForceAim(0), true);
    assert.equal(input.toggleForceAim(0), false);
    input.setForceAim(0, true);
    input.refreshActorInput(0, false, true, false);
    assert.equal(input.actorInputState(0).forceAim, false, 'run clears force aim after the cached input sample');
    assert.equal(input.actorIsAiming(0), true);
    input.refreshActorInput(0, false, false, false);
    assert.equal(input.actorIsAiming(0), false);

    input.setIsAiming(0, true);
    const before = input.actorInputState(0);

    for (const invalid of [
        () => input.nullifyAiming(1), () => input.actorIsAiming(1),
        () => input.setIsAiming(0, 1), () => input.setForceAim(0, 'true'),
        () => input.refreshActorInput(0, true, 0, false),
        () => input.refreshActorInput(0, true, false, false, false),
        () => input.toggleForceAim(-1),
        () => subject.loadState({ ...movement, values: movement.values.with(2, -1) }),
    ]) {
        assert.throws(invalid);
        assert.deepEqual(input.actorInputState(0), before, 'refusal leaves every input field unchanged');
    }

    subject.loadState(movement);
    assert.deepEqual(input.actorInputState(0), initial, 'nonserialized input reconstructs on successful actor restore');
    input.setForceAim(0, true);
    input.refreshActorInput(0, true, false, false);
    subject.reset();
    assert.deepEqual(input.actorInputState(0), initial);
});
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
 * @param {string[]} [omit] - When supplied, retain all exports except these optional names.
 * @returns {Uint8Array} Module exposing only the original engine ABI.
 */
function legacyModule(bytes, omit) {
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

                if (omit ? !omit.includes(name) : keep.has(name)) {
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

    for (const action of [{ type: 'walk', x: 1, y: 0 }, { type: 'moveTo', x: 9, y: 7 }]) {
        const before = subject.snapshot();

        subject.command(action);
        subject.command({ type: 'cancel' });
        subject.step(STEP);
        assert.deepEqual([subject.snapshot().x, subject.snapshot().y, subject.snapshot().action],
            [before.x, before.y, IDLE], 'the real legacy void cancellation does not invent a queue capability');
    }

    assert.equal(subject.canSaveQueueState(), false);

    for (const attempt of [
        () => subject.frameStep(STEP),
        () => subject.actions.getState(),
        () => subject.actions.requestPickup(1),
        () => subject.actions.requestDoor('door:10:10:0:0'),
        () => subject.actions.requestWalk({ x: 6, y: 5, z: 0 }),
        () => subject.actions.cancel(),
        () => subject.sourceTiming.getState(),
        () => subject.sourceTiming.set('multiplier', 1),
        () => subject.sourceTiming.hasTrait('base:dextrous'),
        () => subject.sourceTiming.setTrait('base:dextrous', true),
        () => subject.sourceTiming.getGameMode(),
        () => subject.sourceTiming.setGameMode('Sandbox'),
        () => subject.worldClockState(),
        () => subject.importWorldClockState(WORLD_CLOCK_DEFAULT_STATE),
        () => subject.sourceActions.worldClockSet('timeOfDay', 9),
        () => subject.sourceActions.worldClockDaysInMonth(1_993, 6),
        () => subject.sourceActions.worldClockCheckHours(1, 2),
        () => subject.sourceActions.actorInputState(0),
        () => subject.sourceActions.actorIsAiming(0),
        () => subject.sourceActions.nullifyAiming(0),
        () => subject.sourceActions.setIsAiming(0, true),
        () => subject.sourceActions.setForceAim(0, true),
        () => subject.sourceActions.toggleForceAim(0),
        () => subject.sourceActions.refreshActorInput(0, true, false, false),
        () => subject.saveQueueState(),
        () => subject.loadQueueState(new Uint8Array([1])),
        () => subject.worldImportCell(0, 0, cellBytes()),
        () => subject.navFlags(0, 0),
        () => subject.worldBounds(),
        () => subject.saveState(),
        () => subject.loadState({ version: 1, values: [5, 5, 1.5, 5, 5, 0, 0, 0, 0, 0] }),
        () => subject.worldReset(),
        () => subject.registerItemDefinition(shoe(), { owner: 'base' }),
        () => subject.itemDefinitions(),
        () => subject.getItemDefinition('Base.Shoe'),
        () => subject.beginItemDefinitionRegistration('base'),
        () => subject.commitItemDefinitionRegistration('base'),
        () => subject.rollbackItemDefinitionRegistration('base'),
        () => subject.freezeItemDefinitions(),
        () => subject.items(),
        () => subject.getItem(1),
        () => subject.sourceActions.itemMatchesFloorPlacement(1, 1, 5, 5, 0),
        () => subject.sourceActions.removeAttachedItem(1),
        () => subject.sourceActions.squareDistanceToProper(0, 0, 0, 1, 1, 0),
        () => subject.importInventoryGraph({ ...subject.exportInventoryGraph(), items: [], wornOrder: undefined }),
        () => subject.inventoryState(),
        () => subject.wornItem('base:shoes'),
        () => subject.isWearingAwkwardGloves(),
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
        () => subject.getSquare(0, 0, 0),
        () => subject.doors(),
        () => subject.toggleDoor('door:10:10:0:0'),
        () => subject.saveDoorState(),
        () => subject.loadDoorState({}),
        () => subject.command({ type: 'toggleDoor', id: 'door:10:10:0:0' }),
        () => subject.bodyParts(),
        () => subject.bodyPartInputLimits(),
        () => subject.thermalActionModifier(),
        () => subject.saveBodyState(),
        () => subject.loadBodyState({}),
        () => subject.command({ type: 'setBodyPart', part: 'Hand_L', values: { scratchTime: 1 } }),
        () => subject.command({ type: 'setInjurySeverity', severity: 'normal' }),
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
        canBeEquipped: null,
        removeOnBroken: false, conditionLowerChanceOneIn: 20, weight: 1, tags: [],
        isBag: extra.type?.toLowerCase().replace(/^base:/u, '') === 'container',
        capacity: 0, weightReduction: 0, maxItemSize: 0,
        containerType: extra.type?.toLowerCase().replace(/^base:/u, '') === 'container' ? 'container' : null,
        category: extra.type?.toLowerCase().replace(/^base:/u, '') === 'container' ? 'container' : 'item',
        sourceCategory: extra.type?.toLowerCase().replace(/^base:/u, '') === 'container' ? 'Container' : 'Item',
        onlyAcceptCategory: null, acceptItemFunction: null,
        lightWhenAttached: false, fakeEquipped: false, unsupportedSubtype: false,
        source: { file: 'clothing.txt', model: 'Boots_Ground' }, ...extra,
    };
}

test('native world visuals absorb absolute placement once and persist rotations through supported drops', async () => {
    const subject = await engine();

    subject.registerItemDefinition(shoe('Fixture.WorldItem', { bodyLocation: null }), { owner: 'fixture' });
    const id = subject.command({ type: 'spawnItem', fullType: 'Fixture.WorldItem', x: 5.25, y: 5.75 }).id;
    const initial = subject.worldItemVisuals()[0];

    assert.equal(initial.x + initial.xoff, 5.25);
    assert.equal(initial.y + initial.yoff, 5.75);
    assert.equal(initial.worldScale, 1);
    assert.ok(Number.isInteger(initial.worldZRotation) && initial.worldZRotation >= 0 && initial.worldZRotation < 360);
    assert.ok(Object.isFrozen(initial));
    const graph = subject.exportInventoryGraph();

    Object.assign(graph.items[0].worldVisual, { worldXRotation: 12, worldYRotation: 34, worldZRotation: 56, worldScale: 0.75 });
    subject.importInventoryGraph(graph);
    assert.deepEqual(subject.exportInventoryGraph(), graph);
    const before = subject.exportInventoryGraph();

    for (const patch of [{ worldScale: Infinity }, { worldZRotation: 3.5e38 }, { xoff: 0.5 }, { extra: 1 }]) {
        const bad = structuredClone(before);

        Object.assign(bad.items[0].worldVisual, patch);
        assert.throws(() => subject.importInventoryGraph(bad));
        assert.deepEqual(subject.exportInventoryGraph(), before, 'invalid visual import publishes nothing');
    }

    const held = structuredClone(before);

    held.items[0].ownerContainerId = subject.playerInventoryId();
    held.items[0].worldPosition = null;
    subject.importInventoryGraph(held);
    assert.deepEqual(subject.worldItemVisuals(), [], 'native ownership, not retained visual fields, controls visibility');
    subject.command({ type: 'drop', id, x: 6.125, y: 5.5 });
    const dropped = subject.worldItemVisuals()[0];

    assert.equal(dropped.id, id);
    assert.equal(dropped.x + dropped.xoff, 6.125);
    assert.equal(dropped.y + dropped.yoff, 5.5);
    assert.deepEqual([dropped.worldXRotation, dropped.worldYRotation, dropped.worldZRotation, dropped.worldScale], [0, 0, 56, 0.75]);
    const restored = await engine();

    restored.registerItemDefinition(shoe('Fixture.WorldItem', { bodyLocation: null }), { owner: 'fixture' });
    restored.importInventoryGraph(subject.exportInventoryGraph());
    assert.deepEqual(restored.worldItemVisuals(), subject.worldItemVisuals());
});

test('old port inventory graphs preserve fractional placement without inventing historical orientation', async () => {
    const subject = await engine();

    subject.registerItemDefinition(shoe('Fixture.LegacyWorldItem', { bodyLocation: null }), { owner: 'fixture' });
    subject.command({ type: 'spawnItem', fullType: 'Fixture.LegacyWorldItem', x: 5.000_000_000_000_001, y: 5.75 });
    const graph = subject.exportInventoryGraph();

    delete graph.items[0].worldVisual;
    subject.importInventoryGraph(graph);
    const visual = subject.worldItemVisuals()[0];

    assert.equal(visual.x + visual.xoff, graph.items[0].worldPosition.x);
    assert.equal(visual.y + visual.yoff, graph.items[0].worldPosition.y);
    assert.deepEqual([visual.worldXRotation, visual.worldYRotation, visual.worldZRotation, visual.worldScale], [0, 0, -1, 1]);
});

test('native first-use ItemVisual selection persists without repeated RNG draws or transaction leakage', async () => {
    const subject = await engine();

    subject.registerItemDefinition(shoe('Fixture.VisualChoice', { bodyLocation: null, clothingItem: 'FixtureVisual' }), { owner: 'fixture' });
    const id = subject.command({ type: 'spawnItem', fullType: 'Fixture.VisualChoice', x: 5.25, y: 5.75 }).id;
    const rules = { baseTextureCount: 2, textureChoiceCount: 1, allowRandomTint: false, allowRandomHue: false };

    assert.equal(subject.worldItemVisuals()[0].visual, undefined, 'no fabricated visual before source metadata is ready');
    subject.beginItemDefinitionRegistration('fixture');
    const before = subject.saveDoorState();

    assert.throws(() => subject.initializeItemVisual(id, rules));
    assert.deepEqual(subject.saveDoorState(), before);
    assert.equal(subject.worldItemVisuals()[0].visual, undefined);
    subject.rollbackItemDefinitionRegistration('fixture');
    const visual = subject.initializeItemVisual(id, rules);

    assert.ok([0, 1].includes(visual.baseTexture));
    assert.equal(visual.textureChoice, 0);
    assert.equal(visual.hue, 0);
    assert.deepEqual(visual.tint, [1, 1, 1, 1], 'white is the nonrandom source getTint result, not a missing-state fallback');
    const initializedRng = subject.saveDoorState();

    assert.deepEqual(subject.initializeItemVisual(id, rules), visual);
    assert.deepEqual(subject.worldItemVisuals()[0].visual, visual);
    assert.deepEqual(subject.saveDoorState(), initializedRng);
    const graph = subject.exportInventoryGraph();
    const restored = await engine();

    restored.registerItemDefinition(subject.itemDefinitions()[0], { owner: 'fixture' });
    restored.importInventoryGraph(graph);
    const restoredRng = restored.saveDoorState();

    assert.deepEqual(restored.initializeItemVisual(id, rules), visual);
    assert.deepEqual(restored.saveDoorState(), restoredRng, 'saved actual choices never get reconstructed randomly');

    for (const patch of [{ baseTexture: -2 }, { baseTexture: 2 }, { textureChoice: 1.5 }, { tint: [1, 1, 1] }, { hue: Infinity }]) {
        const invalid = structuredClone(graph);

        Object.assign(invalid.items[0].visual, patch);
        assert.throws(() => restored.importInventoryGraph(invalid));
        assert.deepEqual(restored.exportInventoryGraph(), graph);
    }

    const carried = structuredClone(graph);

    carried.items[0].ownerContainerId = restored.playerInventoryId();
    carried.items[0].worldPosition = null;
    restored.importInventoryGraph(carried);
    restored.command({ type: 'drop', id, x: 6.25, y: 5.5 });
    assert.deepEqual(restored.worldItemVisuals()[0].visual, visual, 'supported native drop preserves actual texture/tint selection');
});

test('native tooltip state retains source clothing defenses and restored visual state', async () => {
    const subject = await engine();
    const [definition] = parseItemDefinitions(`module TooltipFixture { item Gloves {
        Type = Clothing, BodyLocation = Hands, ScratchDefense = 30,
        Insulation = 0.25, WindResistance = 0.3, FatigueChange = 25,
    } }`, 'synthetic-tooltip-contract');

    subject.registerItemDefinition(shoe(definition.fullType, { ...definition }), { owner: 'fixture' });
    const id = subject.command({ type: 'spawnItem', fullType: definition.fullType, x: 5, y: 5, condition: 1 }).id;

    /**
     * Read the current native tooltip state for the fixture item.
     *
     * @returns {object} Current item tooltip state.
     */
    const read = () => subject.sourceActions.itemTooltipState(id);

    assert.equal(read().clothing.scratchDefense, 30, 'positive condition does not scale defense');
    assert.equal(read().clothing.biteDefense, 0);
    assert.equal(read().clothing.waterResistance, 0);
    assert.equal(read().clothing.cosmetic, false);
    assert.equal(read().clothing.holeCount, 0);
    assert.equal(read().visionModifier, 1);
    assert.equal(read().fatigueChange, 0.25, 'factory divides authored percentage by 100');
    assert.equal(read().remoteControlId, -1);
    assert.equal(read().maxCapacity, -1);
    assert.equal(read().attributes, null);
    assert.equal(read().fluidContainer, null);
    assert.equal(read().durability, null);
    subject.sourceActions.itemSetWetness(id, 37.5);
    const graph = subject.exportInventoryGraph();
    const restoredState = graph.items[0].tooltipState;

    restoredState.bloodLevel = 12.5;
    restoredState.dirtyness = 22.5;
    restoredState.holes[0] = 255;
    restoredState.holes[17] = 1;
    subject.importInventoryGraph(graph);
    assert.equal(read().clothing.bloodLevel, 12.5);
    assert.equal(read().clothing.dirtyness, 22.5);
    assert.equal(read().clothing.holeCount, 2);
    assert.equal(read().clothing.wetness, 37.5);
    assert.deepEqual(subject.exportInventoryGraph(), graph);
    const bad = structuredClone(graph);

    bad.items[0].tooltipState.holes[1] = 256;
    assert.throws(() => subject.importInventoryGraph(bad));
    assert.deepEqual(subject.exportInventoryGraph(), graph, 'invalid visual restore publishes nothing');
    subject.command({ type: 'setCondition', id, condition: 0 });
    assert.equal(read().clothing.scratchDefense, 0);
    assert.equal(read().clothing.insulation, 0.25, 'insulation is not condition gated');
    assert.throws(() => subject.sourceActions.itemTooltipState(0));
    assert.throws(() => subject.sourceActions.itemTooltipState(0xFF_FF_FF_FF));
    const before = subject.itemDefinitions();

    assert.throws(() => subject.registerItemDefinition({
        ...before[0], insulation: Infinity,
    }, { owner: 'fixture', override: true }));
    assert.deepEqual(subject.itemDefinitions(), before, 'invalid stat refusal precedes registration');
});

test('known poison uses intact source tags before concrete Food and refuses live class reinterpretation', async () => {
    const subject = await engine();
    const definitions = parseItemDefinitions(`module PoisonFixture {
        item Untagged { ItemType = base:clothing, }
        item Visible { ItemType = Normal, Tags = ShowPoison, }
        item Hidden { ItemType = Container, Tags = ShowPoison;NoDetect, }
        item Namespaced { ItemType = Normal, Tags = mod:ShowPoison;mod:NoDetect, }
        item Food { ItemType = Normal, }
    }`, { path: 'poison-fixture.txt' });
    const ids = definitions.map((definition) => {
        subject.registerItemDefinition(shoe(definition.fullType, {
            ...definition, bodyLocation: null, sourceCategory: 'Food',
        }), { owner: 'fixture' });

        return subject.command({ type: 'spawnItem', fullType: definition.fullType, x: 5, y: 5 }).id;
    });
    const query = subject.sourceActions.playerIsKnownPoison;

    assert.deepEqual(ids.map(query), [false, true, false, false, false]);
    const before = subject.itemDefinitions();
    const graph = subject.exportInventoryGraph();

    assert.throws(() => subject.registerItemDefinition({
        ...before[0], type: 'Food', weight: 9,
    }, { owner: 'fixture', override: true }), /unsupported/i);
    assert.deepEqual(subject.itemDefinitions(), before, 'class refusal must precede all numeric or metadata mutation');
    assert.deepEqual(subject.exportInventoryGraph(), graph);
    assert.equal(subject.sourceActions.itemIsFood(ids[0]), false);
    subject.registerItemDefinition({ ...before[0], tags: ['BASE:ShowPoison'] }, { owner: 'fixture', override: true });
    assert.equal(query(ids[0]), true, 'same-class definition tag changes remain live');
    subject.beginItemDefinitionRegistration('fixture');
    subject.registerItemDefinition({ ...subject.getItemDefinition(before[0].fullType), tags: ['NoDetect', 'ShowPoison'] },
        { owner: 'fixture', override: true });
    assert.equal(query(ids[0]), false);
    subject.rollbackItemDefinitionRegistration('fixture');
    assert.equal(query(ids[0]), true);
    const restored = await engine();

    for (const definition of subject.itemDefinitions()) {
        restored.registerItemDefinition(definition, { owner: definition.owner });
    }

    restored.importInventoryGraph(graph);
    assert.deepEqual(ids.map(restored.sourceActions.playerIsKnownPoison), [true, true, false, false, false]);

    for (const id of [0, -1, 1.5, '1', null, undefined, {}, 0xFF_FF_FF_FF]) {
        assert.throws(() => query(id));
    }
});

test('literature class stays independent of names and categories and refuses live reclassification atomically', async () => {
    const subject = await engine();
    const definitions = parseItemDefinitions(`module LiteratureFixture {
        item Literature { Type = Normal, DisplayCategory = Literature, Tags = Literature, }
        item Clothing { ItemType = BASE:CLOTHING, }
        item Bag { ItemType = base:container, }
        item Book { ItemType = BASE:LITERATURE, }
    }`, { path: 'literature-fixture.txt' });

    for (const definition of definitions) {
        subject.registerItemDefinition(shoe(definition.fullType, {
            ...definition, bodyLocation: null, sourceCategory: 'Literature',
        }), { owner: 'fixture' });
    }

    const ids = definitions.slice(0, 3).map(({ fullType }) => subject.command({ type: 'spawnItem', fullType, x: 5, y: 5 }).id);
    const query = subject.sourceActions.itemIsLiterature;

    assert.deepEqual(ids.map(query), [false, false, false]);
    assert.throws(() => subject.command({ type: 'spawnItem', fullType: definitions[3].fullType, x: 5, y: 5 }), /unsupported/i,
        'the class predicate must not admit the unported Literature subtype');
    const before = subject.itemDefinitions();
    const graph = subject.exportInventoryGraph();

    assert.throws(() => subject.registerItemDefinition({
        ...before[0], type: 'base:literature', weight: 9,
    }, { owner: 'fixture', override: true }), /unsupported/i);
    assert.deepEqual(subject.itemDefinitions(), before, 'class refusal precedes numeric and metadata mutation');
    assert.deepEqual(subject.exportInventoryGraph(), graph);
    subject.beginItemDefinitionRegistration('fixture');
    assert.throws(() => subject.registerItemDefinition({
        ...before[1], type: 'Literature', weight: 9,
    }, { owner: 'fixture', override: true }), /unsupported/i);
    subject.rollbackItemDefinitionRegistration('fixture');
    assert.deepEqual(subject.itemDefinitions(), before);
    const restored = await engine();

    for (const definition of before) {
        restored.registerItemDefinition(definition, { owner: definition.owner });
    }

    restored.importInventoryGraph(graph);
    assert.deepEqual(ids.map(restored.sourceActions.itemIsLiterature), [false, false, false]);
    const refused = structuredClone(graph);

    refused.items[0].fullType = definitions[3].fullType;
    refused.items[0].definitionOrdinal = 3;
    assert.throws(() => restored.importInventoryGraph(refused), /unsupported/i,
        'restoring a graph cannot bypass the Literature admission refusal');
    assert.deepEqual(restored.exportInventoryGraph(), graph);
    subject.registerItemDefinition({
        ...before[0], displayCategory: 'Books', sourceCategory: 'Books',
    }, { owner: 'fixture', override: true });
    assert.equal(query(ids[0]), false, 'same-class live metadata cannot rewrite concrete identity');
    subject.registerItemDefinition({
        ...before[3], type: 'Normal', unsupportedSubtype: false,
    }, { owner: 'fixture', override: true });
    const formerlyLiterature = subject.command({ type: 'spawnItem', fullType: definitions[3].fullType, x: 5, y: 5 }).id;

    assert.equal(query(formerlyLiterature), false, 'an unused definition may change factory class before instantiation');

    for (const id of [0, -1, 1.5, '1', null, undefined, {}, 0xFF_FF_FF_FF]) {
        assert.throws(() => query(id));
    }
});

test('media progress uses native non-media authority and refuses unresolved Normal media and live reinterpretation', async () => {
    const subject = await engine();
    const definitions = parseItemDefinitions(`module MediaFixture {
        item Ordinary { ItemType = base:normal, DisplayCategory = Retail-VHS, }
        item Clothing { ItemType = base:clothing, }
        item Bag { ItemType = base:container, }
        item Disc { ItemType = base:normal, MediaCategory = CDs, }
        item Retail { ItemType = base:normal, MediaCategory = Retail-VHS, }
        item Home { ItemType = base:normal, MediaCategory = Home-VHS, }
    }`, { path: 'media-progress-fixture.txt' });
    const ids = definitions.map((definition) => {
        subject.registerItemDefinition(shoe(definition.fullType, { ...definition, bodyLocation: null }), { owner: 'fixture' });

        return subject.command({ type: 'spawnItem', fullType: definition.fullType, x: 5, y: 5 }).id;
    });
    const queries = [subject.sourceActions.itemHasBeenSeen, subject.sourceActions.itemHasBeenHeard];

    for (const query of queries) {
        assert.deepEqual(ids.slice(0, 3).map((id) => query(id, 0)), [false, false, false]);

        for (const id of ids.slice(3)) {
            assert.throws(() => query(id, 0), /unsupported/i, 'script category is not proof of a recorded index or player progress');
        }

        for (const player of [1, 0xFF_FF_FF_FF, -1, 0.5, '0', null, undefined, {}]) {
            assert.throws(() => query(ids[0], player));
        }

        for (const id of [0, -1, 1.5, '1', null, undefined, {}, 0xFF_FF_FF_FF]) {
            assert.throws(() => query(id, 0));
        }
    }

    const before = subject.itemDefinitions();
    const graph = subject.exportInventoryGraph();

    for (const [index, rawFields] of [[0, [{ name: 'MediaCategory', value: 'CDs' }]], [3, []]]) {
        assert.throws(() => subject.registerItemDefinition({
            ...before[index], rawFields, weight: 9,
        }, { owner: 'fixture', override: true }), /unsupported/i);
        assert.deepEqual(subject.itemDefinitions(), before, 'media authority refusal precedes numeric and metadata mutation');
        assert.deepEqual(subject.exportInventoryGraph(), graph);
    }

    const restored = await engine();

    for (const definition of before) {
        restored.registerItemDefinition(definition, { owner: definition.owner });
    }

    restored.importInventoryGraph(graph);
    assert.equal(restored.sourceActions.itemHasBeenSeen(ids[0], 0), false);
    assert.throws(() => restored.sourceActions.itemHasBeenHeard(ids[3], 0), /unsupported/i);
});

test('map-read predicate uses concrete MapItem class, permits null and refuses unresolved map history', async () => {
    const subject = await engine();
    const definitions = parseItemDefinitions(`module MapFixture {
        item Map { ItemType = base:normal, Map = LouisvilleMap1, DisplayCategory = Cartography, }
        item Clothing { ItemType = base:clothing, }
        item Bag { ItemType = base:container, }
        item Actual { ItemType = BASE:MAP, Map = LouisvilleMap1, }
    }`, { path: 'map-read-fixture.txt' });

    for (const definition of definitions) {
        subject.registerItemDefinition(shoe(definition.fullType, { ...definition, bodyLocation: null }), { owner: 'fixture' });
    }

    const ids = definitions.slice(0, 3).map(({ fullType }) => subject.command({ type: 'spawnItem', fullType, x: 5, y: 5 }).id);
    const query = subject.sourceActions.playerHasReadMap;

    assert.deepEqual(ids.map((id) => query(id, 0)), [false, false, false]);
    assert.equal(query(null, 0), false);
    assert.equal(query(undefined, 0), false);
    assert.throws(() => subject.command({ type: 'spawnItem', fullType: definitions[3].fullType, x: 5, y: 5 }), /unsupported/i);
    const before = subject.itemDefinitions();
    const graph = subject.exportInventoryGraph();

    assert.throws(() => subject.registerItemDefinition({ ...before[0], type: 'Map', weight: 9 },
        { owner: 'fixture', override: true }), /unsupported/i);
    assert.deepEqual(subject.itemDefinitions(), before, 'class refusal precedes numeric and metadata mutation');
    assert.deepEqual(subject.exportInventoryGraph(), graph);
    const restored = await engine();

    for (const definition of before) {
        restored.registerItemDefinition(definition, { owner: definition.owner });
    }

    restored.importInventoryGraph(graph);
    assert.deepEqual(ids.map((id) => restored.sourceActions.playerHasReadMap(id, 0)), [false, false, false]);

    for (const player of [1, -1, 0.5, '0', null, undefined, {}]) {
        assert.throws(() => query(ids[0], player));
    }

    for (const id of [0, -1, 1.5, '1', {}, 0xFF_FF_FF_FF]) {
        assert.throws(() => query(id, 0));
    }
});

test('no-recipes proves only absent item modData and refuses unresolved producers or persisted modData', async () => {
    const subject = await engine();
    const definitions = parseItemDefinitions(`module NoRecipesFixture {
        item Ordinary { ItemType = base:normal, LearnedRecipes = Anything, }
        item Marker { ItemType = base:normal, itemNoRecipes = Original Name, }
        item Callback { ItemType = base:normal, OnCreate = Fixture.Create, }
        item Config { ItemType = base:normal, ItemConfig = FixtureConfig, }
    }`, { path: 'no-recipes-fixture.txt' });

    definitions.push({ fullType: 'NoRecipesFixture.Default', type: 'Normal', defaultModData: { itemNoRecipes: 'Original Name' } });
    const ids = definitions.map((definition) => {
        subject.registerItemDefinition(shoe(definition.fullType, { ...definition, bodyLocation: null }), { owner: 'fixture' });

        return subject.command({ type: 'spawnItem', fullType: definition.fullType, x: 5, y: 5 }).id;
    });
    const query = subject.sourceActions.itemIsNoRecipes;

    assert.equal(query(ids[0], 0), false, 'recipe metadata is unrelated to the per-item marker');

    for (const id of ids) {
        assert.equal(query(id, null), false, 'source null player precedes item modData lookup');
    }

    for (const id of ids.slice(1)) {
        assert.throws(() => query(id, 0), /unsupported/i);
    }

    const before = subject.itemDefinitions();
    const graph = subject.exportInventoryGraph();

    for (const [index, rawFields] of [[0, [{ name: 'itemNoRecipes', value: 'Original Name' }]], [1, []]]) {
        assert.throws(() => subject.registerItemDefinition({
            ...before[index], rawFields, weight: 9,
        }, { owner: 'fixture', override: true }), /unsupported/i);
        assert.deepEqual(subject.itemDefinitions(), before);
        assert.deepEqual(subject.exportInventoryGraph(), graph);
    }

    const restored = await engine();

    for (const definition of before) {
        restored.registerItemDefinition(definition, { owner: definition.owner });
    }

    restored.importInventoryGraph(graph);
    assert.equal(restored.sourceActions.itemIsNoRecipes(ids[0], 0), false, 'current graph saves preserve proven absence');
    assert.throws(() => restored.sourceActions.itemIsNoRecipes(ids[1], 0), /unsupported/i);

    for (const key of ['modData', 'defaultModData', 'itemNoRecipes']) {
        const rejected = structuredClone(graph);

        rejected.items[0][key] = key === 'itemNoRecipes' ? 'Original Name' : { itemNoRecipes: 'Original Name' };
        assert.throws(() => restored.importInventoryGraph(rejected), /unsupported.*moddata/i);
        assert.deepEqual(restored.exportInventoryGraph(), graph, 'unknown persisted modData cannot be silently discarded');
    }

    for (const player of [1, -1, 0.5, '0', {}]) {
        assert.throws(() => query(ids[0], player));
    }

    for (const id of [0, -1, 1.5, '1', null, undefined, {}, 0xFF_FF_FF_FF]) {
        assert.throws(() => query(id, null));
    }
});

test('favourite recipe input native adapter validates identity only and accepts no preference proof', async () => {
    const subject = await engine();

    subject.registerItemDefinition(shoe('RecipeFixture.Input', { bodyLocation: null }), { owner: 'fixture' });
    const id = subject.command({ type: 'spawnItem', fullType: 'RecipeFixture.Input', x: 5, y: 5 }).id;
    const check = subject.sourceActions.itemFavouriteRecipeInputIdentity;

    assert.equal(check(id, 0), undefined, 'identity admission is not a predicate result');
    assert.equal(check(id, 0, false), undefined, 'an arbitrary extra value cannot supply a false preference proof');

    for (const player of [1, -1, 0.5, '0', null, undefined, {}]) {
        assert.throws(() => check(id, player));
    }

    for (const invalid of [0, -1, 1.5, '1', null, undefined, {}, 0xFF_FF_FF_FF]) {
        assert.throws(() => check(invalid, 0));
    }
});

test('DrainableComboItem class uses factory identity without admitting drainable behavior or live reclassification', async () => {
    const subject = await engine();
    const definitions = parseItemDefinitions(`module DrainableFixture {
        item DrainableComboItem { ItemType = Normal, DisplayCategory = DrainableComboItem, UseDelta = 0.1, }
        item Clothing { ItemType = BASE:CLOTHING, }
        item Bag { ItemType = base:container, }
        item Actual { ItemType = BASE:DRAINABLE, UseDelta = 0.1, }
    }`, { path: 'drainable-class-fixture.txt' });

    for (const definition of definitions) {
        subject.registerItemDefinition(shoe(definition.fullType, { ...definition, bodyLocation: null }), { owner: 'fixture' });
    }

    const ids = definitions.slice(0, 3).map(({ fullType }) => subject.command({ type: 'spawnItem', fullType, x: 5, y: 5 }).id);
    const query = subject.sourceActions.itemIsDrainableComboItem;

    assert.deepEqual(ids.map(query), [false, false, false]);
    assert.throws(() => subject.command({ type: 'spawnItem', fullType: definitions[3].fullType, x: 5, y: 5 }), /unsupported/i);
    const before = subject.itemDefinitions();
    const graph = subject.exportInventoryGraph();

    assert.throws(() => subject.registerItemDefinition({ ...before[0], type: 'base:drainable', weight: 9 },
        { owner: 'fixture', override: true }), /unsupported/i);
    assert.deepEqual(subject.itemDefinitions(), before, 'concrete class refusal precedes numeric and metadata mutation');
    assert.deepEqual(subject.exportInventoryGraph(), graph);
    const rejected = structuredClone(graph);

    rejected.items[0].fullType = definitions[3].fullType;
    rejected.items[0].definitionOrdinal = 3;
    assert.throws(() => subject.importInventoryGraph(rejected), /unsupported/i);
    assert.deepEqual(subject.exportInventoryGraph(), graph, 'class recognition does not enable drainable imports');
    subject.registerItemDefinition({ ...before[0], displayCategory: 'Water' }, { owner: 'fixture', override: true });
    assert.equal(query(ids[0]), false);

    for (const id of [0, -1, 1.5, '1', null, undefined, {}, 0xFF_FF_FF_FF]) {
        assert.throws(() => query(id));
    }
});

test('private immediate attachment removal leaves unattached floor and inventory items unchanged', async () => {
    const subject = await engine();

    subject.registerItemDefinition(shoe('Fixture.Attachment', { bodyLocation: null }), { owner: 'fixture' });
    const id = subject.command({ type: 'spawnItem', fullType: 'Fixture.Attachment', x: 5, y: 5 }).id;
    const remove = subject.sourceActions.removeAttachedItem;
    const floor = subject.exportInventoryGraph();

    assert.equal(Object.hasOwn(subject, 'removeAttachedItem'), false);
    assert.equal(remove(id), false);
    assert.equal(remove(id), false);
    assert.deepEqual(subject.exportInventoryGraph(), floor);
    subject.command({ type: 'pickup', id });
    completeActions(subject);
    const inventory = subject.exportInventoryGraph();

    assert.equal(remove(id), false);
    assert.deepEqual(subject.exportInventoryGraph(), inventory);

    for (const invalid of [0, -1, 1.5, 0x1_00_00_00_00, '1', null, undefined]) {
        assert.throws(() => remove(invalid));
    }

    assert.throws(() => remove(0xFF_FF_FF_FF), /outside the accepted range/u);
    assert.deepEqual(subject.exportInventoryGraph(), inventory);
});

test('native direct item reads and square collections retain live ownership and full uint32 identity', async () => {
    const subject = await engine();

    subject.registerItemDefinition(shoe(), { owner: 'base' });
    subject.worldImportCell(-1, 0, cellBytes());
    subject.worldImportCell(0, 0, cellBytes());
    const spawned = subject.command({ type: 'spawnItem', fullType: 'Base.Shoe', x: -1.5, y: 5.5 }).id;
    const records = subject.items();

    records[0].id = 0xFF_FF_FF_FF;
    subject.importInventoryGraph({ ...subject.exportInventoryGraph(), items: records, wornOrder: undefined });
    const id = records[0].id;
    const read = subject.getItem(id);
    const matches = subject.sourceActions.itemMatchesFloorPlacement;
    const owner = read.ownerContainerId;
    const placementBefore = subject.exportInventoryGraph();
    const actorBefore = subject.saveState();

    assert.equal(Object.hasOwn(subject, 'itemMatchesFloorPlacement'), false, 'placement query stays private');
    assert.equal(matches(id, owner, -1.5, 5.5, 0), true);
    assert.equal(matches(spawned, owner, -1.5, 5.5, 0), false, 'missing valid identity is not a stale live item');
    assert.equal(matches(id, 0xFF_FF_FF_FF, -1.5, 5.5, 0), false, 'missing expected owner is not a sentinel');

    for (const coords of [[-1.5 + Number.EPSILON, 5.5, 0], [-1.5, 5.5 + 1e-12, 0], [-1.5, 5.5, 1e-12],
        [Number.MAX_VALUE, 5.5, 0]]) {
        assert.equal(matches(id, owner, ...coords), false, 'comparison preserves exact finite f64 coordinates');
    }

    for (const index of [0, 1]) {
        for (const invalid of [0, -1, 0x1_00_00_00_00]) {
            const args = [id, owner, -1.5, 5.5, 0];

            args[index] = invalid;
            assert.throws(() => matches(...args), RangeError);
        }

        for (const invalid of [1.5, Number.NaN, Infinity, -Infinity, '1', null, undefined]) {
            const args = [id, owner, -1.5, 5.5, 0];

            args[index] = invalid;
            assert.throws(() => matches(...args), TypeError);
        }
    }

    for (const index of [2, 3, 4]) {
        for (const invalid of [Number.NaN, Infinity, -Infinity, '0', null, undefined]) {
            const args = [id, owner, -1.5, 5.5, 0];

            args[index] = invalid;
            assert.throws(() => matches(...args), TypeError);
        }
    }

    assert.throws(() => matches(id, owner, -1.5, 5.5), TypeError);
    assert.throws(() => matches(id, owner, -1.5, 5.5, 0, 0), TypeError);
    assert.deepEqual(subject.exportInventoryGraph(), placementBefore, 'successful, false and rejected queries do not mutate inventory');
    assert.deepEqual(subject.saveState(), actorBefore);

    assert.equal(subject.getItem(spawned), null);
    assert.deepEqual(read, records[0]);
    read.worldPosition.x = 999;
    assert.equal(subject.getItem(id).worldPosition.x, -1.5);
    assert.equal(subject.sourceActions.worldItemCount(-2, 5, 0), 1);
    assert.equal(subject.sourceActions.worldItemGet(-2, 5, 0, 0), id);
    assert.equal(subject.sourceActions.worldItemCount(-1, 5, 0), 0);
    assert.equal(subject.sourceActions.worldItemCount(-2, 5, 1), 0);
    assert.throws(() => subject.sourceActions.worldItemGet(-2, 5, 0, 1), RangeError);
    assert.throws(() => subject.sourceActions.worldItemGet(-2, 5, 0, -1), RangeError);

    for (const invalid of [0, -1, 0x1_00_00_00_00]) {
        assert.throws(() => subject.getItem(invalid), RangeError);
    }

    for (const invalid of [1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        assert.throws(() => subject.getItem(invalid), TypeError);
    }

    const shifted = { ...records[0], worldPosition: { x: -1.5 + Number.EPSILON, y: 5.5, z: 0 } };

    subject.importInventoryGraph({ ...subject.exportInventoryGraph(), items: [shifted], wornOrder: undefined });
    assert.equal(matches(id, owner, -1.5, 5.5, 0), false, 'same-owner coordinate changes invalidate the captured stamp');
    assert.equal(matches(id, owner, shifted.worldPosition.x, 5.5, 0), true, 'current f64 stamp is exposed without f32 narrowing');

    subject.importInventoryGraph({ ...subject.exportInventoryGraph(), items: [{ ...records[0], ownerContainerId: 1, worldPosition: null }], wornOrder: undefined });
    assert.equal(matches(id, owner, -1.5, 5.5, 0), false, 'actor-owned nonworld item invalidates the captured stamp');
    assert.equal(matches(id, 1, 0, 0, 0), false, 'matching actor ownership cannot pass as floor placement');
    subject.command({ type: 'drop', id, x: 6.5, y: 5.5 });
    assert.equal(subject.sourceActions.worldItemCount(-2, 5, 0), 0);
    assert.equal(subject.sourceActions.worldItemGet(6, 5, 0, 0), id);
    assert.equal(subject.getItem(id).worldPosition.x, 6.5);
    const dropped = subject.getItem(id);

    assert.notEqual(dropped.ownerContainerId, owner);
    assert.equal(matches(id, owner, 6.5, 5.5, 0), false, 'current coordinates cannot hide an owner change');
    assert.equal(matches(id, dropped.ownerContainerId, 6.5, 5.5, 0), true);
    subject.importInventoryGraph({ ...subject.exportInventoryGraph(), items: [{ ...records[0], ownerContainerId: 1, worldPosition: null }], wornOrder: undefined });
    assert.equal(subject.sourceActions.worldItemCount(6, 5, 0), 0);
    assert.equal(subject.getItem(id).ownerContainerId, 1);
    subject.importInventoryGraph({ ...subject.exportInventoryGraph(), items: [], wornOrder: undefined });
    assert.equal(subject.getItem(id), null);
    assert.equal(matches(id, owner, -1.5, 5.5, 0), false, 'deleted live item cannot retain a captured placement');
    subject.importInventoryGraph({ ...subject.exportInventoryGraph(), items: records, wornOrder: undefined });
    assert.notEqual(subject.getItem(id).worldPosition, null);
    subject.reset();
    assert.equal(subject.getItem(id), null);
    assert.equal(subject.sourceActions.worldItemCount(-2, 5, 0), 0);
    assert.equal(matches(id, owner, -1.5, 5.5, 0), false);
});

test('native item pickup refuses source weight51 without treating maxWeight8 as capacity', async () => {
    const subject = await engine();

    subject.registerItemDefinition(shoe('Base.Heavy', { weight: 51 }), { owner: 'base' });
    const id = subject.command({ type: 'spawnItem', fullType: 'Base.Heavy', x: 5, y: 5 }).id;
    const before = subject.items();
    const actor = subject.saveState();

    assert.throws(() => subject.command({ type: 'pickup', id }), /blocked/u);
    assert.deepEqual(subject.actions.getState(), { current: null, pending: [] });
    assert.deepEqual(subject.items(), before);
    assert.deepEqual(subject.saveState(), actor);
    assert.deepEqual(subject.inventoryState(), { capacityWeight: 0, capacity: 50, maxWeight: 8 });
    const { instance } = await WebAssembly.instantiate(moduleBytes, {});
    const api = instance.exports;

    assert.equal(api.item_definition_register(0, 1, 30, 1, 1, 0, 20, 0, 51, 0), 0);
    assert.equal(api.item_spawn(0, 5, 5, 1, 30), 0);
    assert.ok(api.item_pickup(api.item_last_id()) < 0, 'native admission must refuse capacity, not return a queue ID');
});

test('native inventory capacity ignores count and applies worn reduction before pickup', async () => {
    const subject = await engine();

    subject.registerItemDefinition(shoe('Base.Load', { weight: 49, stackLimit: 100 }), { owner: 'base' });
    subject.registerItemDefinition(shoe('Base.One', { weight: 1 }), { owner: 'base' });
    const load = subject.command({ type: 'spawnItem', fullType: 'Base.Load', x: 5, y: 5, count: 100 }).id;
    const first = subject.command({ type: 'spawnItem', fullType: 'Base.One', x: 5, y: 5 }).id;
    const second = subject.command({ type: 'spawnItem', fullType: 'Base.One', x: 5, y: 5 }).id;

    subject.command({ type: 'pickup', id: load });
    completeActions(subject);
    assert.equal(subject.inventoryState().capacityWeight, 49);
    subject.command({ type: 'pickup', id: first });
    completeActions(subject);
    assert.equal(subject.inventoryState().capacityWeight, 50);
    const full = subject.items();
    const actor = subject.saveState();

    assert.throws(() => subject.command({ type: 'pickup', id: second }), /blocked/u);
    assert.deepEqual(subject.items(), full);
    assert.deepEqual(subject.saveState(), actor);
    assert.deepEqual(subject.actions.getState(), { current: null, pending: [] });
    subject.command({ type: 'wear', id: load });
    assert.ok(near(subject.inventoryState().capacityWeight, 15.7));
    subject.command({ type: 'pickup', id: second });
    completeActions(subject);
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
        completeActions(subject);

        if (accepted) {
            subject.command({ type: 'pickup', id: small });
            completeActions(subject);
            assert.equal(subject.items()[1].ownerContainerId, 1);
        } else {
            const before = subject.items();

            const actor = subject.saveState();

            assert.throws(() => subject.command({ type: 'pickup', id: small }), /blocked/u);
            assert.deepEqual(subject.saveState(), actor);
            assert.deepEqual(subject.actions.getState(), { current: null, pending: [] });
            assert.deepEqual(subject.items(), before);
        }
    }));
});

test('native live base and actual weights remain independent across definition overrides', async () => {
    const subject = await engine();

    subject.registerItemDefinition(shoe('Base.Shoe', { weight: 1.25 }), { owner: 'base' });
    const id = subject.command({ type: 'spawnItem', fullType: 'Base.Shoe', x: 5, y: 5 }).id;

    subject.command({ type: 'pickup', id });
    completeActions(subject);
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
        completeActions(ordered);
    }

    for (const [orderedId, actualWeight] of [[ids[0], 16_777_216], [ids[1], 1], [ids[2], 1]]) {
        ordered.command({ type: 'setActualWeight', id: orderedId, actualWeight });
    }

    assert.deepEqual(ordered.items().map((item) => item.id), ids.toReversed());
    assert.equal(ordered.inventoryState().capacityWeight, 16_777_218,
        'f32 summation must follow pickup order, not spawn order');
    const orderedRestore = await engine();

    orderedRestore.registerItemDefinition(shoe('Base.Ordered', { weight: 0 }), { owner: 'base' });
    orderedRestore.importInventoryGraph(ordered.exportInventoryGraph());
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

    subject.registerItemDefinition(shoe('Base.Shoe', {
        weight: 1.25, bodyLocation: 'base:hands', tags: ['base:awkwardgloves'],
    }), { owner: 'base' });
    const id = subject.command({ type: 'spawnItem', fullType: 'Base.Shoe', x: 5, y: 5 }).id;

    subject.command({ type: 'pickup', id });
    completeActions(subject);
    subject.command({ type: 'wear', id });
    assert.equal(subject.isWearingAwkwardGloves(), true);
    subject.beginItemDefinitionRegistration('mod');
    subject.registerItemDefinition(shoe('Base.Shoe', { weight: 3, bodyLocation: 'base:hands' }),
        { owner: 'mod', override: true });
    assert.equal(subject.isWearingAwkwardGloves(), false);
    subject.registerItemDefinition(shoe('Base.Shoe', { weight: 4, bodyLocation: 'base:hands' }),
        { owner: 'mod', override: true });
    subject.rollbackItemDefinitionRegistration('mod');
    assert.equal(subject.itemDefinitions()[0].weight, 1.25);
    assert.deepEqual(subject.itemDefinitions()[0].tags, ['base:awkwardgloves']);
    assert.equal(subject.isWearingAwkwardGloves(), true);

    subject.command({ type: 'setWeight', id, weight: 9.75 });
    subject.command({ type: 'setActualWeight', id, actualWeight: 0.125 });
    const records = subject.items();
    const restored = await engine();

    restored.registerItemDefinition(subject.itemDefinitions()[0], { owner: 'base' });
    restored.importInventoryGraph(subject.exportInventoryGraph());
    restored.loadState(subject.saveState());
    assert.deepEqual(restored.items(), records);
    assert.equal(restored.isWearingAwkwardGloves(), true);
    const actor = restored.saveState();
    const definitions = restored.itemDefinitions();

    for (const value of [-Number.MIN_VALUE, Number.NaN, Infinity, Number.MAX_VALUE,
        3.402_823_466_385_288_6e38 + 2 ** 102, undefined, null]) {
        assert.throws(() => restored.registerItemDefinition(shoe('Bad.Weight', { weight: value }), { owner: 'base' }));
        assert.deepEqual(restored.itemDefinitions(), definitions);

        for (const field of ['weight', 'actualWeight']) {
            assert.throws(() => restored.command({ type: field === 'weight' ? 'setWeight' : 'setActualWeight', id, [field]: value }));
            assert.throws(() => restored.importInventoryGraph({ ...restored.exportInventoryGraph(), items: [records[0], { ...records[0], id: 2, [field]: value }], wornOrder: undefined }));
            assert.deepEqual(restored.items(), records);
            assert.deepEqual(restored.saveState(), actor);
        }
    }

    const legacy = { ...records[0] };

    delete legacy.weight;
    delete legacy.actualWeight;
    restored.importInventoryGraph({ ...restored.exportInventoryGraph(), items: [legacy], wornOrder: undefined });
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

    assert.equal(api.item_definition_register(0, 1, 30, 1, 1, 0, 20, 0, 1.25, 0), 0);
    assert.equal(api.item_spawn(0, 5, 5, 1, 30), 0);
    assert.equal(api.item_import_begin(), 0);
    assert.equal(api.item_import_stage(50, 0, 1, 5, 5, 30, 1, 0, 2.5, 0.5, 0, 0), 0);
    assert.notEqual(api.item_import_stage(51, 0, 1, 5, 5, 30, 1, 0, 1, Number.MAX_VALUE, 0, 0), 0);
    assert.notEqual(api.item_import_commit(), 0);
    assert.equal(api.item_count(), 1);
    assert.equal(api.item_read(0), 0);
    assert.equal(new DataView(api.memory.buffer).getFloat64(api.scratch_ptr(), true), 1);

    for (const value of [-Number.MIN_VALUE, 3.402_823_466_385_288_6e38 + 2 ** 102, Number.NaN, Infinity]) {
        assert.notEqual(api.item_definition_register(1, 1, 30, 1, 1, 0, 20, 0, value, 0), 0);
        assert.equal(api.item_definition_count(), 1);
        assert.notEqual(api.item_set_weight(1, value), 0);
        assert.notEqual(api.item_set_actual_weight(1, value), 0);
        assert.equal(api.item_read(0), 0);
        const live = new DataView(api.memory.buffer, api.scratch_ptr());

        assert.equal(live.getFloat64(64, true), 1.25);
        assert.equal(live.getFloat64(72, true), 1.25);
        assert.equal(api.item_import_begin(), 0);
        assert.equal(api.item_import_stage(50, 0, 1, 5, 5, 30, 1, 0, 2.5, 0.5, 0, 0), 0);
        assert.notEqual(api.item_import_stage(51, 0, 1, 5, 5, 30, 1, 0, 1, value, 0, 0), 0);
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
    const original = subject.registerItemDefinition(shoe('Base.Shoe', {
        type: 'Clothing', sourceCategory: 'Clothing', category: 'clothing',
        insulation: 0.25, scratchDefense: 30, visionModifier: 0.75, fatigueChange: 25,
        tags: ['base:showcondition'], rawFields: [{ name: 'Tooltip', value: 'Tooltip_OriginalShoe' }],
    }), { owner: 'base' });

    original.source.model = 'tampered';
    const detached = subject.getItemDefinition('Base.Shoe');

    detached.source.model = 'tampered';
    assert.equal(subject.getItemDefinition('Base.Shoe').source.model, 'Boots_Ground');
    assert.equal(subject.getItemDefinition('Unknown.Shoe'), null);
    assert.throws(() => subject.getItemDefinition(''), TypeError);
    const existing = subject.command({ type: 'spawnItem', fullType: 'Base.Shoe', x: 5, y: 5, condition: 3 }).id;

    subject.beginItemDefinitionRegistration('mod');
    assert.throws(() => subject.beginItemDefinitionRegistration('mod'), /transaction|registration/u);
    assert.throws(() => subject.registerItemDefinition(shoe(), { owner: 'other', override: true }));
    subject.registerItemDefinition(shoe('Base.Shoe', {
        type: 'Clothing', conditionMax: 6, weight: 1.1, insulation: 0.5,
        scratchDefense: 90, visionModifier: 0.5, fatigueChange: 50,
        source: { file: 'mod.txt', model: 'Mod_Ground' },
        rawFields: [{ name: 'Tooltip', value: 'Tooltip_OverrideShoe' }],
    }), { owner: 'mod', override: true });
    assert.equal(subject.getItemDefinition('Base.Shoe').conditionMax, 6);
    assert.equal(subject.getItemDefinition('Base.Shoe').weight, Math.fround(1.1));
    assert.equal(subject.getItemDefinition('Base.Shoe').owner, 'mod');
    assert.equal(subject.getItemDefinition('Base.Shoe').scratchDefense, 90);
    assert.equal(subject.sourceActions.itemTooltipState(existing).visionModifier, 0.5);
    assert.equal(subject.sourceActions.itemTooltipState(existing).tooltip, 'Tooltip_OverrideShoe');
    subject.registerItemDefinition(shoe('Base.Shoe', {
        type: 'Clothing', conditionMax: 8, insulation: 0.875, scratchDefense: 80,
        visionModifier: 0.25, fatigueChange: 75,
        source: { file: 'second.txt', model: 'Second_Ground' },
        rawFields: [{ name: 'Tooltip', value: 'Tooltip_SecondShoe' }],
    }), { owner: 'mod', override: true });
    assert.equal(subject.getItemDefinition('Base.Shoe').conditionMax, 8);
    subject.registerItemDefinition(shoe('Mod.Shoe'), { owner: 'mod' });
    assert.equal(subject.getItemDefinition('Mod.Shoe').owner, 'mod');
    assert.throws(() => subject.freezeItemDefinitions());
    assert.throws(() => subject.commitItemDefinitionRegistration('other'));
    assert.throws(() => subject.rollbackItemDefinitionRegistration('other'));
    assert.equal(subject.getItemDefinition('Base.Shoe').owner, 'mod');
    assert.equal(subject.getItemDefinition('Base.Shoe').scratchDefense, 80);
    subject.rollbackItemDefinitionRegistration('mod');
    const restored = subject.getItemDefinition('Base.Shoe');

    assert.equal(subject.itemDefinitions().length, 1);
    assert.equal(restored.fullType, 'Base.Shoe');
    assert.equal(restored.owner, 'base');
    assert.equal(restored.conditionMax, 30);
    assert.equal(restored.weight, 1);
    assert.equal(restored.insulation, 0.25);
    assert.equal(restored.scratchDefense, 30);
    assert.equal(restored.visionModifier, 0.75);
    assert.deepEqual(restored.source, { file: 'clothing.txt', model: 'Boots_Ground' });
    assert.deepEqual(restored.rawFields, [{ name: 'Tooltip', value: 'Tooltip_OriginalShoe' }]);
    assert.deepEqual(restored.tags, ['base:showcondition']);
    const fresh = subject.command({ type: 'spawnItem', fullType: 'Base.Shoe', x: 5, y: 5 }).id;

    assert.equal(subject.getItem(fresh).condition, 30);
    assert.equal(subject.getItem(fresh).weight, 1);

    for (const id of [existing, fresh]) {
        const tooltip = subject.sourceActions.itemTooltipState(id);

        assert.equal(tooltip.clothing.insulation, 0.25);
        assert.equal(tooltip.clothing.scratchDefense, 30);
        assert.equal(tooltip.visionModifier, 0.75);
        assert.equal(tooltip.fatigueChange, 0.25);
        assert.equal(tooltip.showCondition, true);
        assert.equal(tooltip.tooltip, 'Tooltip_OriginalShoe');
    }

    assert.equal(subject.getItemDefinition('Mod.Shoe'), null);
    assert.throws(() => subject.command({ type: 'spawnItem', fullType: 'Mod.Shoe', x: 5, y: 5 }));
    assert.throws(() => subject.registerItemDefinition(shoe(), { owner: 'base' }));
    subject.beginItemDefinitionRegistration('mod');
    subject.registerItemDefinition(shoe('Mod.Shoe'), { owner: 'mod' });
    subject.commitItemDefinitionRegistration('mod');
    assert.deepEqual(subject.itemDefinitions().map((row) => row.fullType), ['Base.Shoe', 'Mod.Shoe']);
    assert.equal(subject.getItemDefinition('Mod.Shoe').owner, 'mod');
    subject.freezeItemDefinitions();
    assert.throws(() => subject.registerItemDefinition(shoe('Late.Shoe'), { owner: 'late' }));
    assert.throws(() => subject.beginItemDefinitionRegistration('late'));
});

test('equipment replacement and broken-item policy preserve stable IDs and movement', async () => {
    const subject = await engine();

    subject.registerItemDefinition(shoe(), { owner: 'base' });
    subject.registerItemDefinition(shoe('Base.Disposable', { removeOnBroken: true }), { owner: 'base' });
    subject.freezeItemDefinitions();
    const first = subject.command({ type: 'spawnItem', fullType: 'Base.Shoe', x: 5, y: 5 }).id;
    const second = subject.command({ type: 'spawnItem', fullType: 'Base.Disposable', x: 5, y: 5 }).id;

    for (const id of [first, second]) {
        subject.command({ type: 'pickup', id });
        completeActions(subject);
    }

    subject.command({ type: 'moveTo', x: 9, y: 7 });
    const before = subject.saveState().values.slice(0, 10);

    for (const id of [first, second]) {
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
    assert.notEqual(subject.items()[0].worldPosition, null);
    assert.equal(subject.items()[0].worldPosition.x, 6);
    assert.equal(subject.command({ type: 'spawnItem', fullType: 'Base.Shoe', x: 5, y: 5 }).id, second + 1);
    subject.step(STEP);
    assert.equal(subject.snapshot().action, MOVING);
});

test('awkward-glove timing follows the actual tagged item worn on hands', async () => {
    const subject = await engine();

    assert.equal(subject.isWearingAwkwardGloves(), false);

    for (const [fullType, bodyLocation, tags] of [
        ['Base.TaggedGlove', 'base:hands', ['base:awkwardgloves']],
        ['Base.PlainGlove', 'base:hands', []],
        ['Base.TaggedShoe', 'base:shoes', ['base:awkwardgloves']],
    ]) {
        subject.registerItemDefinition(shoe(fullType, { bodyLocation, tags }), { owner: 'base' });
    }

    const tagged = subject.command({ type: 'spawnItem', fullType: 'Base.TaggedGlove', x: 5, y: 5 }).id;
    const plain = subject.command({ type: 'spawnItem', fullType: 'Base.PlainGlove', x: 5, y: 5 }).id;
    const shoeId = subject.command({ type: 'spawnItem', fullType: 'Base.TaggedShoe', x: 5, y: 5 }).id;

    for (const id of [tagged, plain, shoeId]) {
        subject.command({ type: 'pickup', id });
        completeActions(subject);
    }

    subject.command({ type: 'wear', id: tagged });
    assert.equal(subject.isWearingAwkwardGloves(), true);
    subject.command({ type: 'wear', id: plain });
    subject.command({ type: 'wear', id: shoeId });
    assert.equal(subject.isWearingAwkwardGloves(), false);
    subject.command({ type: 'wear', id: tagged });
    subject.command({ type: 'unequip', id: tagged });
    assert.equal(subject.isWearingAwkwardGloves(), false);
});

test('item tags normalize detached resource IDs and reject malformed new rows and overrides atomically', async () => {
    const subject = await engine();
    const definition = shoe('Base.Glove', {
        bodyLocation: 'base:hands', tags: [' AwkwardGloves ', 'Other:Tool:Grip'],
    });
    const registered = subject.registerItemDefinition(definition, { owner: 'base' });

    assert.deepEqual(registered.tags, ['base:awkwardgloves', 'other:tool:grip']);
    definition.tags.length = 0;
    registered.tags.length = 0;
    assert.deepEqual(subject.itemDefinitions()[0].tags, ['base:awkwardgloves', 'other:tool:grip']);
    const id = subject.command({ type: 'spawnItem', fullType: 'Base.Glove', x: 5, y: 5 }).id;

    subject.command({ type: 'pickup', id });
    completeActions(subject);
    assert.equal(subject.isWearingAwkwardGloves(), false);
    subject.command({ type: 'wear', id });
    const before = subject.itemDefinitions();

    for (const tags of [null, undefined, 'AwkwardGloves', {}, [1], [''], [':path'],
        ['namespace:'], ['  '], ['base:awkwardgloves', null], Array.from({ length: 1 })]) {
        assert.throws(() => subject.registerItemDefinition(shoe('Bad.Glove', { tags }), { owner: 'mod' }));
        assert.throws(() => subject.registerItemDefinition(shoe('Base.Glove', { tags, bodyLocation: 'base:hands' }),
            { owner: 'mod', override: true }));
        assert.deepEqual(subject.itemDefinitions(), before);
        assert.equal(subject.isWearingAwkwardGloves(), true);
    }

    const plain = shoe('Base.PlainGlove', { bodyLocation: 'base:hands' });

    delete plain.tags;
    assert.deepEqual(subject.registerItemDefinition(plain, { owner: 'base' }).tags, []);
    subject.command({ type: 'drop', id, x: 5, y: 5 });
    assert.equal(subject.isWearingAwkwardGloves(), false);
});

test('native awkward-glove ingress rejects nonboolean flags without changing definitions or worn state', async () => {
    const { instance } = await WebAssembly.instantiate(moduleBytes, {});
    const api = instance.exports;

    assert.equal(api.body_group_location_add(api.worn_group_get(), 1), 0);
    assert.equal(api.item_definition_register(0, 1, 30, 1, 1, 0, 20, 0, 1, 1), 0);
    assert.equal(api.item_spawn(0, 5, 5, 1, 30), 0);
    const id = api.item_last_id();
    const accepted = api.item_pickup(id);

    assert.ok(accepted > 0, 'pickup returns a stable queue action ID, not a mutation status');
    assert.equal(api.queue_action_read(accepted), 0);
    assert.equal(new DataView(api.memory.buffer).getFloat64(api.queue_scratch_ptr() + 24, true), id);

    for (let frame = 0; frame < 10_000 && api.queue_length() !== 0; frame += 1) {
        assert.equal(api.frame_step(STEP), 0);
    }

    assert.equal(api.queue_length(), 0, 'actual native pickup must finish before equipment ingress');
    assert.equal(api.item_wear(id), 0);
    assert.equal(api.item_wearing_awkward_gloves(0), 0);
    assert.equal(api.item_wearing_awkward_gloves(1), 1);
    assert.notEqual(api.item_definition_register(0, 2, 30, 1, 1, 0, 20, 1, 1, 2), 0);
    assert.notEqual(api.item_definition_register(1, 2, 30, 1, 1, 0, 20, 0, 1, 2), 0);
    assert.equal(api.item_definition_count(), 1);
    assert.equal(api.item_wearing_awkward_gloves(1), 1);
});

test('explicit-ID import is atomic, detached and advances the exhausted sentinel without wrapping', async () => {
    const subject = await engine();

    subject.registerItemDefinition(shoe(), { owner: 'base' });
    const record = {
        id: 40, fullType: 'Base.Shoe', definitionOrdinal: 0, ownerContainerId: 1, internalContainerId: null,
        worldPosition: null, favorite: false, consumed: false, count: 1, condition: 12, bodyLocation: 'base:shoes',
    };

    subject.importInventoryGraph({ ...subject.exportInventoryGraph(), items: [record], wornOrder: undefined });
    const before = subject.items();
    const state = subject.saveState();

    for (const bad of [
        { ...record, id: 41, condition: 31 },
        { ...record, id: 41, fullType: 'Missing.Shoe' },
        { ...record, id: 41, bodyLocation: 'other:slot' },
        { ...record, id: 41, worldPosition: { x: Infinity, y: 5, z: 0 } },
        { ...record, id: 41, count: 2 },
        { ...record, id: 40 },
    ]) {
        assert.throws(() => subject.importInventoryGraph({ ...subject.exportInventoryGraph(), items: [record, bad], wornOrder: undefined }));
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
    subject.importInventoryGraph({ ...subject.exportInventoryGraph(), items: [{ ...record, id: 4_294_967_295 }], wornOrder: undefined });
    assert.equal(subject.saveState().values[11], 4_294_967_296);
    assert.throws(() => subject.command({ type: 'spawnItem', fullType: 'Base.Shoe', x: 5, y: 5 }));
    subject.importInventoryGraph({ ...subject.exportInventoryGraph(), items: [], wornOrder: undefined });
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
    restored.importInventoryGraph(original.exportInventoryGraph());
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

test('item boundaries refuse malformed values and pickup resolves real source adjacency and queued travel', async () => {
    const subject = await engine();

    for (const extra of [{ conditionMax: 0 }, { stackLimit: 0 }, { removeOnBroken: 1 },
        { conditionLowerChanceOneIn: -1 }, { conditionMax: 2_147_483_648 },
        { stackLimit: 4_294_967_296 }, { bodyLocation: '' }]) {
        assert.throws(() => subject.registerItemDefinition(shoe('Bad.Shoe', extra), { owner: 'base' }));
        assert.deepEqual(subject.itemDefinitions(), []);
    }

    subject.registerItemDefinition(shoe(), { owner: 'base' });
    subject.worldImportCell(0, 0, cellBytes((x, y) => (x === 6 && y === 5 ? 1 : 0)));
    importPickupSquares(subject, 5, 5, [{ x: 6, y: 5 }]);
    const id = subject.command({ type: 'spawnItem', fullType: 'Base.Shoe', x: 5, y: 5 }).id;

    subject.command({ type: 'pickup', id });
    completeActions(subject);
    subject.command({ type: 'drop', id, x: 6, y: 5 });
    const before = subject.items();
    const state = subject.saveState();

    for (const action of [{ type: 'wear', id },
        { type: 'drop', id, x: 256, y: 5 }, { type: 'setCondition', id, condition: 31 },
        { type: 'setCondition', id: 4_294_967_296, condition: 1 },
        { type: 'spawnItem', fullType: 'Base.Shoe', x: 5, y: 5, count: 2 },
        { type: 'setHealth', health: -1 }, { type: 'setHealth', health: 100.01 }]) {
        assert.throws(() => subject.command(action));
        assert.deepEqual(subject.items(), before);
        assert.deepEqual(subject.saveState(), state);
    }

    subject.command({ type: 'pickup', id });
    assert.deepEqual(subject.items(), before, 'admission is not an immediate transfer');
    completeActions(subject);
    assert.equal(subject.items()[0].ownerContainerId, 1, 'a solid item tile still has a reachable adjacent actor square');
    subject.command({ type: 'drop', id, x: 7, y: 7 });
    const ground = subject.items();

    subject.command({ type: 'pickup', id });
    assert.equal(subject.actions.getState().current.kind, 'walk', 'far pickup queues genuine travel before transfer');
    assert.deepEqual(subject.items(), ground);
    completeActions(subject);
    assert.equal(subject.items()[0].ownerContainerId, 1);
    assert.ok(subject.snapshot().x !== 5 || subject.snapshot().y !== 5);
    subject.command({ type: 'drop', id, x: 3, y: 3 });
    importPickupSquares(subject, 5, 5, [
        { x: 3, y: 3 }, { x: 4, y: 3 }, { x: 3, y: 4 }, { x: 4, y: 4 },
    ]);
    const sealedItems = subject.items();
    const sealedActor = subject.saveState();

    assert.equal(subject.sourceActions.findAdjacent({ x: 3, y: 3, z: 0 }), null);
    assert.throws(() => subject.command({ type: 'pickup', id }), /blocked/u);
    assert.deepEqual(subject.items(), sealedItems);
    assert.deepEqual(subject.saveState(), sealedActor);
    assert.deepEqual(subject.actions.getState(), { current: null, pending: [] });
});

test('numeric WASM staging cannot publish a valid prefix after a later invalid record', async () => {
    const { instance } = await WebAssembly.instantiate(moduleBytes, {});
    const api = instance.exports;

    assert.equal(api.body_group_location_add(api.worn_group_get(), 1), 0);
    assert.equal(api.item_definition_register(0, 1, 30, 1, 1, 0, 20, 0, 1, 0), 0);
    assert.equal(api.item_spawn(0, 5, 5, 1, 30), 0);
    assert.equal(api.item_import_begin(), 0);
    assert.equal(api.item_import_stage(50, 0, 1, 5, 5, 20, 1, 1, 1, 1, 0, 0), 0);
    assert.notEqual(api.item_import_stage(51, 0, 1, 5, 5, 31, 1, 0, 1, 1, 0, 0), 0);
    assert.notEqual(api.item_import_commit(), 0);
    assert.equal(api.item_count(), 1);
    assert.equal(api.item_read(0), 0);
    assert.equal(new DataView(api.memory.buffer).getFloat64(api.scratch_ptr(), true), 1);
    assert.equal(api.item_definition_begin(2), 0);
    assert.equal(api.item_definition_register(0, 2, 40, 1, 1, 0, 10, 1, 2, 0), 0);
    assert.equal(api.item_definition_register(0, 2, 50, 1, 1, 0, 5, 1, 3, 0), 0);
    assert.equal(api.item_definition_rollback(2), 0);
    assert.equal(api.item_definition_read(0), 0);
    const row = new DataView(api.memory.buffer, api.scratch_ptr());

    assert.deepEqual(Array.from({ length: 7 }, (_, index) => row.getFloat64(index * 8, true)),
        [1, 30, 1, 1, 0, 20, 1]);
    assert.equal(api.item_definition_freeze(), 0);
    assert.notEqual(api.item_definition_register(0, 2, 40, 1, 1, 0, 10, 1, 2, 0), 0);
});

test('live references refuse incompatible overrides and unloaded world holes refuse drops', async () => {
    const subject = await engine();

    subject.registerItemDefinition(shoe(), { owner: 'base' });
    subject.importInventoryGraph({
        ...subject.exportInventoryGraph(), items: [{
            id: 7, fullType: 'Base.Shoe', definitionOrdinal: 0, ownerContainerId: 1, internalContainerId: null,
            worldPosition: null, favorite: false, consumed: false, condition: 30, count: 1, bodyLocation: 'base:shoes',
        }], wornOrder: undefined,
    });
    const before = subject.itemDefinitions();

    subject.beginItemDefinitionRegistration('mod');

    assert.throws(() => subject.registerItemDefinition(shoe('Base.Shoe', { conditionMax: 6 }),
        { owner: 'mod', override: true }));
    assert.deepEqual(subject.itemDefinitions(), before);
    subject.registerItemDefinition(shoe('Base.Shoe', { bodyLocation: 'base:hat' }),
        { owner: 'mod', override: true });
    assert.equal(subject.getItem(7).bodyLocation, 'base:shoes',
        'preferred definition changes must not rewrite explicit actual worn membership');

    subject.rollbackItemDefinitionRegistration('mod');
    subject.worldImportCell(0, 0, cellBytes());
    subject.worldImportCell(2, 0, cellBytes());
    const itemsBefore = subject.items();

    assert.throws(() => subject.command({ type: 'drop', id: 7, x: 300, y: 5 }));
    assert.deepEqual(subject.items(), itemsBefore);
    subject.command({ type: 'drop', id: 7, x: 530, y: 5 });
    assert.equal(subject.items()[0].worldPosition.x, 530);
});

test('the final uint32 ID is usable once and equipment commands leave a live heading intact', async () => {
    const subject = await engine();

    subject.registerItemDefinition(shoe('Base.Shoe', { removeOnBroken: true }), { owner: 'base' });
    const state = subject.saveState();

    state.values[11] = 4_294_967_295;
    subject.loadState(state);
    const id = subject.command({ type: 'spawnItem', fullType: 'Base.Shoe', x: 5, y: 5 }).id;

    assert.equal(id, 4_294_967_295);
    subject.command({ type: 'pickup', id });
    const queued = subject.actions.getState();

    assert.equal(queued.current.target.id, id);
    assert.deepEqual(queued.current.groups[0].itemIds, [id]);
    const portable = subject.saveQueueState();

    subject.actions.cancel();
    subject.loadQueueState(portable);
    assert.deepEqual(subject.actions.getState(), queued, 'portable queue retains the full uint32 target and group member');
    completeActions(subject);
    subject.command({ type: 'walk', x: 1, y: 1 });
    const firstHeading = subject.saveState().values.slice(0, 10);

    subject.command({ type: 'wear', id });
    subject.command({ type: 'unequip', id });
    subject.command({ type: 'drop', id, x: 5, y: 5 });
    assert.deepEqual(subject.saveState().values.slice(0, 10), firstHeading, 'wear, unequip and drop preserve the live heading');
    subject.command({ type: 'cancel' });
    subject.command({ type: 'pickup', id });
    completeActions(subject);
    subject.command({ type: 'walk', x: 1, y: 1 });
    const prefix = subject.saveState().values.slice(0, 10);

    subject.command({ type: 'wear', id });
    subject.command({ type: 'unequip', id });
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
        assert.equal(api.item_definition_register(index, 1, 30, 0, 1, 0, 20, 0, 1, 0), 0);
        assert.equal(api.item_spawn(0, 5, 5, 1, 30), 0);
    }

    assert.notEqual(api.item_definition_register(4_096, 1, 30, 0, 1, 0, 20, 0, 1, 0), 0);
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
    assert.throws(() => subject.step(-STEP));
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
        reachWalls: Array.from({ length: 4 }, () => ({ north: false, west: false })),
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
                x, y, z: 0, roomId: -1, outside: true, solid: false, solidFloor: true,
                solidTrans: false, tree: false, independentWalls: 0,
                reachWalls: { north: false, west: false },
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

test('native stationary collection counts require loaded squares and exclude doors, floor items and the actor', async () => {
    const subject = await engine();

    subject.worldImportCell(0, 0, cellBytes());
    assert.throws(() => subject.sourceActions.squareStaticMovingObjectCount(10, 10, 0), RangeError,
        'navigation alone does not create an authoritative source square');
    subject.importDoors([nativeDoor()], { squares: doorSquares() });
    subject.registerItemDefinition(shoe(), { owner: 'base' });
    subject.command({ type: 'spawnItem', fullType: 'Base.Shoe', x: 10.5, y: 10.5 });
    const actor = subject.saveState();

    actor.values[0] = 10.5;
    actor.values[1] = 10.5;
    actor.values[3] = 10.5;
    actor.values[4] = 10.5;
    subject.loadState(actor);
    const before = {
        actor: subject.saveState(), doors: subject.saveDoorState(),
        inventory: subject.exportInventoryGraph(), queue: subject.saveQueueState(),
    };

    assert.equal(subject.sourceActions.squareDoorCount(10, 10, 0), 1);
    assert.equal(subject.sourceActions.worldItemCount(10, 10, 0), 1);
    assert.equal(subject.sourceActions.squareStaticMovingObjectCount(10, 10, 0), 0);
    assert.equal(subject.sourceActions.squareStaticMovingObjectCount(11, 10, 0), 0);

    for (const coords of [[6, 10, 0], [10, 10, 1], [0x7F_FF_FF_FF, 10, 0],
        [10, 10, 0x80_00_00_00]]) {
        assert.throws(() => subject.sourceActions.squareStaticMovingObjectCount(...coords), RangeError);
    }

    for (const coords of [[10.5, 10, 0], [10, Number.NaN, 0]]) {
        assert.throws(() => subject.sourceActions.squareStaticMovingObjectCount(...coords), TypeError);
    }

    assert.throws(() => subject.importInventoryGraph({
        ...before.inventory, containers: before.inventory.containers.map((row) => ({ ...row, kind: 'corpse' })),
    }), /container kind/u, 'unsupported corpse roots cannot be admitted as stationary objects');
    assert.deepEqual(subject.saveState(), before.actor);
    assert.deepEqual(subject.saveDoorState(), before.doors);
    assert.deepEqual(subject.exportInventoryGraph(), before.inventory);
    assert.deepEqual(subject.saveQueueState(), before.queue);

    subject.importDoors([], { squares: [] });
    assert.throws(() => subject.sourceActions.squareStaticMovingObjectCount(10, 10, 0), RangeError,
        'removing source-square metadata cannot leave a cached empty census');
});

test('native blocked-square relations distinguish source window properties and directional stairs', async () => {
    const subject = await engine();
    const from = { x: 10, y: 10, z: 0 };
    const north = { x: 10, y: 9, z: 0 };
    const west = { x: 9, y: 10, z: 0 };
    /**
     * Replace the calling square's source properties without legacy collision changes.
     *
     * @param {object} interactionProperties - Actual property, window and stair facts.
     * @returns {void} Commits complete square metadata.
     */
    const replace = (interactionProperties) => subject.importDoors([], {
        squares: doorSquares({ '10:10': { interactionProperties } }),
    });

    subject.worldImportCell(0, 0, cellBytes());
    replace({ collideN: true });
    assert.equal(subject.isBlockedTo(from, north), true);
    assert.equal(subject.isBlockedTo(north, from), true, 'wall relation tests both endpoint-facing edges');
    replace({ collideN: true, windowN: true });
    assert.equal(subject.isBlockedTo(from, north), false, 'raw windowN excludes the wall without inventing a blocked IsoWindow');
    replace({ collideN: true, windowN: true, blockedWindowN: true });
    assert.equal(subject.isBlockedTo(from, north), true, 'actual blocked-window state is independent of raw window flags');
    replace({ stairsTW: true });
    assert.equal(subject.isBlockedTo(from, west), true);
    assert.equal(subject.isBlockedTo(west, from), false, 'stair relation belongs to the calling square');
    replace({ stairsTN: true });
    assert.equal(subject.isBlockedTo(from, north), true);
    assert.equal(subject.isBlockedTo(north, from), false);
    assert.equal(subject.isBlockedTo(from, from), false);
    assert.equal(subject.isBlockedTo(from, null), false);
    assert.equal(subject.isBlockedTo(from, { x: 100, y: 100, z: 0 }), false, 'absent other square has source null semantics');
});

test('native source-square standability keeps floor and adjacent-edge precedence', async () => {
    const subject = await engine();

    subject.worldImportCell(0, 0, cellBytes());

    subject.importDoors([], {
        squares: doorSquares({
            '7:7': { solidFloor: false },
            '8:8': { solidFloor: true },
            '10:8': { solid: true, solidFloor: true, windows: 2 },
            '11:8': { solidTrans: true, hoppableEdges: 2 },
            '12:8': { solidTrans: true, solidFloor: true },
            '8:11': { solidTrans: true },
            '8:12': { windows: 2 },
            '10:11': { solidTrans: true },
            '11:11': { hoppableEdges: 4 },
            '13:12': { solidTrans: true, windows: 2 },
            '14:14': { tree: true, vehicleObstructed: true, solidFloor: true },
            '12:10': { windows: 6, windowEdges: 2 },
            '12:9': { solidTrans: true },
            '11:10': { solidTrans: true },
        }),
    });

    for (const [x, y, expected] of [
        [8, 8, true], [10, 8, false], [11, 8, true], [12, 8, false], [7, 7, false],
        [8, 11, true], [10, 11, true], [13, 12, true], [14, 14, true],
        [12, 9, true], [11, 10, false],
    ]) {
        assert.equal(subject.getSquare?.(x, y, 0)?.canStand, expected,
            `source standability at ${x},${y}`);
    }

    assert.equal(subject.navFlags(12, 10) & 6, 6,
        'raw north/west collision stays intact while actual created windows supply only north stand edges');

    assert.equal(subject.getSquare(8, 8, 1), null, 'another elevation is not a loaded square');
    assert.equal(subject.getSquare(8, 8, 100), null, 'query elevation is not limited to import bounds');
    assert.equal(subject.getSquare(100, 100, 0), null, 'unloaded metadata is not invented');
    const before = subject.getSquare(8, 8, 0);

    assert.equal(before.canStand, true);
    assert.equal(before.solidFloor, true);
    assert.equal(before.haveRoof, false, 'no loaded square above supplies a roof');
    const detached = subject.getSquare(8, 8, 0);

    detached.solidFloor = false;
    assert.equal(subject.getSquare(8, 8, 0).solidFloor, true, 'query results do not alias scratch or source');

    for (const coordinates of [[0.5, 0, 0], [0, 2 ** 31, 0], [0, 0, 2 ** 31], [0, 0, -(2 ** 31) - 1]]) {
        assert.throws(() => subject.getSquare(...coordinates), /integer|inside/u);
    }

    assert.equal(subject.getSquare(-(2 ** 31), 2 ** 31 - 1, 0), null, 'signed int32 queries never wrap');

    assert.throws(() => subject.importDoors([], {
        squares: doorSquares({ '8:8': { solidFloor: 'true' } }),
    }), TypeError);
    assert.deepEqual(subject.getSquare(8, 8, 0), before, 'invalid replacement preserves live metadata');

    for (const hoppableEdges of [1, 8, 2.5, null]) {
        assert.throws(() => subject.importDoors([], {
            squares: doorSquares({ '8:8': { hoppableEdges } }),
        }), /hoppableEdges/u);
        assert.deepEqual(subject.getSquare(8, 8, 0), before);
    }

    for (const windowEdges of [1, 8, 2.5, null]) {
        assert.throws(() => subject.importDoors([], {
            squares: doorSquares({ '8:8': { windowEdges } }),
        }), /windowEdges/u);
        assert.deepEqual(subject.getSquare(8, 8, 0), before);
    }

    for (const standEdges of [[2], [2, 0, 2, 1], [2, 0, 2, 0, 0], null]) {
        assert.throws(() => subject.importDoors([nativeDoor({ standEdges })], {
            squares: doorSquares(),
        }), /standEdges/u);
        assert.deepEqual(subject.getSquare(8, 8, 0), before);
    }

    for (const squareFlags of [[2], [2, 0, 0, 1], [0, 0, 16, 0], [2, 0, 0, 0, 0], null]) {
        assert.throws(() => subject.importDoors([nativeDoor({ squareFlags })], {
            squares: doorSquares(),
        }), /squareFlags/u);
        assert.deepEqual(subject.getSquare(8, 8, 0), before);
    }

    const door = nativeDoor({ standEdges: [2, 4, 4, 0] });
    const squares = doorSquares({ '10:9': { solidTrans: true }, '9:10': { solidTrans: true } });

    subject.importDoors([door], { squares });
    doorSpawn(subject, 10.5, 10.5);
    assert.equal(subject.getSquare(10, 9, 0).canStand, true, 'current closed-door sprite supplies its edge');
    completeQueueRequest(subject, subject.toggleDoor(door.id));
    assert.equal(subject.getSquare(10, 9, 0).canStand, false, 'opening uses the actual replacement sprite edge');
    completeQueueRequest(subject, subject.toggleDoor(door.id));
    assert.equal(subject.getSquare(10, 9, 0).canStand, false, 'toggled closed art is not initial closed art');
    assert.equal(subject.getSquare(9, 10, 0).canStand, true, 'toggled closed art supplies its west edge');
    const saved = subject.saveDoorState();

    completeQueueRequest(subject, subject.toggleDoor(door.id));
    subject.loadDoorState(saved);
    assert.deepEqual(subject.saveDoorState(), saved, 'stand metadata does not enter mutable portable state');
    assert.equal(subject.getSquare(9, 10, 0).canStand, true, 'restore rebuilds the current edge union');

    subject.importDoors([nativeDoor({ open: true, standEdges: [0, 4, 0, 2] })], { squares });
    assert.equal(subject.getSquare(9, 10, 0).canStand, true, 'initial open art selects the second mask');
    completeQueueRequest(subject, subject.toggleDoor(door.id));
    assert.equal(subject.getSquare(9, 10, 0).canStand, false);
    completeQueueRequest(subject, subject.toggleDoor(door.id));
    assert.equal(subject.getSquare(10, 9, 0).canStand, true, 'toggled open art selects the fourth mask');

    subject.importDoors([nativeDoor({ doubleDoor: 2, standEdges: [0, 0, 0, 4], squareFlags: [2, 0, 0, 32] })], {
        squares: doorSquares({ '8:11': { solidTrans: true }, '9:10': { solidTrans: true } }),
    });
    completeQueueRequest(subject, subject.toggleDoor(door.id));
    assert.equal(subject.getSquare(8, 11, 0).canStand, true, 'moved panel owns edges at its actual position');
    assert.equal(subject.getSquare(9, 10, 0).canStand, false, 'closed origin does not keep a moved edge');
    assert.equal(subject.getSquare(9, 11, 0).solidFloor, true, 'current source facts move with the panel');
    assert.equal(subject.getSquare(10, 10, 0).solid, false, 'closed sprite facts do not remain at its origin');

    const sourceDoor = nativeDoor({ squareFlags: [34, 8, 4, 32], standEdges: [0, 0, 2, 0] });

    subject.importDoors([sourceDoor], { squares: doorSquares({ '10:10': { solidFloor: false } }) });
    assert.equal(subject.getSquare(10, 10, 0).solid, true);
    assert.equal(subject.getSquare(10, 10, 0).solidFloor, true);
    assert.equal(subject.getSquare(10, 10, 0).canStand, false, 'initial closed source solid wins over its floor');
    completeQueueRequest(subject, subject.toggleDoor(door.id));
    assert.equal(subject.getSquare(10, 10, 0).solid, false);
    assert.equal(subject.getSquare(10, 10, 0).solidFloor, true);
    assert.equal(subject.getSquare(10, 10, 0).canStand, true,
        'toggle changes source query facts without self-obstructing on its old solid flag');
    const sourceSave = subject.saveDoorState();

    completeQueueRequest(subject, subject.toggleDoor(door.id));
    assert.equal(subject.getSquare(10, 10, 0).solidTrans, true);
    assert.equal(subject.getSquare(10, 10, 0).solidFloor, false);
    assert.equal(subject.getSquare(10, 10, 0).canStand, true, 'merged solidtrans facts use the current edge');
    subject.loadDoorState(sourceSave);
    assert.deepEqual(subject.saveDoorState(), sourceSave);
    assert.equal(subject.getSquare(10, 10, 0).solidTrans, false, 'restored sprite facts replace the old union');

    subject.importDoors([nativeDoor({ ...sourceDoor, open: true })], {
        squares: doorSquares({ '10:10': { solidFloor: false } }),
    });
    assert.equal(subject.getSquare(10, 10, 0).tree, true, 'initial open source tree is not frozen');
    assert.equal(subject.getSquare(10, 10, 0).solidFloor, false);
    assert.equal(subject.getSquare(10, 10, 0).canStand, false, 'tree alone does not supply a floor or edge');
});

test('direct WASM square staging rejects reserved flags, edges and scratch words without changing live metadata', async () => {
    const { instance } = await WebAssembly.instantiate(moduleBytes, {});
    const api = instance.exports;
    const square = [8, 8, 0, 7, 33, 0, 0, 0, 0, 0, 0, 0];

    /**
     * Writes one complete native import record into private scratch.
     *
     * @param {number[]} values - Twelve numeric scratch words.
     */
    const writeWords = (values) => {
        const view = new DataView(api.memory.buffer, api.scratch_ptr(), api.scratch_size());

        for (const [index, value] of values.entries()) {
            view.setFloat64(index * 8, value, true);
        }
    };

    /**
     * Read the live square without retaining mutable native scratch memory.
     *
     * @returns {number[]} Detached query values.
     */
    const readSquare = () => {
        assert.equal(api.square_read(8, 8, 0), 0);
        const view = new DataView(api.memory.buffer, api.scratch_ptr());

        return Array.from({ length: 6 }, (_, index) => view.getFloat64(index * 8, true));
    };

    assert.equal(api.door_import_begin(1, 4, 0), 0);
    writeWords(square);
    assert.equal(api.door_square_stage(), 0);
    assert.equal(api.door_import_commit(), 0);
    assert.equal(readSquare()[3], 7, 'staging imports the source room');
    assert.equal(readSquare()[5], 1, 'source floor permits standing');
    assert.equal(api.square_read(8, 8, 100), -2);

    for (const [index, value] of [
        [4, 64], [8, 1], [8, 8], [8, 2.5], [8, Number.NaN],
        [9, 1], [9, 8], [9, 2.5], [9, Number.NaN],
        [11, 1], [11, 2], [11, 3], [11, 4], [11, 5], [11, 0.5], [11, Number.NaN],
    ]) {
        const invalid = [...square];
        const before = readSquare();

        invalid[index] = value;
        assert.equal(api.door_import_begin(1, 4, 0), 0);
        writeWords(invalid);
        assert.equal(api.door_square_stage(), -4);
        api.door_import_abort();
        assert.deepEqual(readSquare(), before, 'rejected legacy staging preserves all live square facts');
    }

    for (const spriteFacts of [1, 128, 16_384, 2_097_152, 268_435_456, 2.5, Number.NaN]) {
        const before = readSquare();

        assert.equal(api.door_import_begin(1, 4, 0), 0);
        writeWords([1, 10, 10, 0, 1, -1, -1, -1, 0, 0, 0, spriteFacts]);
        assert.equal(api.door_import_stage(), -4);
        api.door_import_abort();
        assert.deepEqual(readSquare(), before, 'rejected sprite staging preserves all live square facts');
    }

    for (const [version, blocker, expectedRoofFlags] of [
        [0, 0, 0], [1, 0, 64], [1, 1, 192], [1, 2, 192], [1, 3, 192], [1, 4, 0],
    ]) {
        assert.equal(api.door_import_begin(1, 4, 0), 0);

        if (version === 1) {
            assert.equal(api.door_import_rain_blockers_version(1), 0);
        }

        writeWords([...square.slice(0, 2), 1, ...square.slice(3, 11), blocker]);
        assert.equal(api.door_square_stage(), 0);
        writeWords(square);
        assert.equal(api.door_square_stage(), 0);
        assert.equal(api.door_import_commit(), 0);
        assert.equal(readSquare()[4] & 192, expectedRoofFlags,
            `roof authority below blocker ${blocker} on wire version ${version}`);
    }
});

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
    completeQueueRequest(subject, subject.toggleDoor(nativeDoor().id));
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
        [nativeDoor({ id: 'door:10:10:1:0', z: 1 }), doorSquares(), [10.5, 10.5]],
    ]) {
        subject.importDoors([door], { squares });
        doorSpawn(subject, ...position);
        const before = subject.saveDoorState();
        const actor = subject.saveState();

        assertDoorRefused(subject, door.id);
        assert.deepEqual(subject.saveDoorState(), before);
        assert.deepEqual(subject.saveState().values.filter((_, index) => index !== 8),
            actor.values.filter((_, index) => index !== 8), 'failed door work does not mutate actor fields; logical frames still tick');
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
    const approach = subject.actions.requestDoor(door.id);

    assert.equal(approach.accepted, true);
    assert.equal(subject.doors()[0].open, false, 'wrong-room actor cannot unlock at admission');
    assert.equal(subject.actions.getState().current.kind, 'walk');
    completeActions(subject);
    assert.equal(subject.doors()[0].open, true, 'actual adjacent walk reaches an allowed source room before unlocking');
    subject.importDoors([door], { squares });
    doorSpawn(subject, 10.5, 9.5);
    completeQueueRequest(subject, subject.command({ type: 'toggleDoor', id: door.id }));
    assert.equal(subject.doors()[0].open, true);
    assert.equal(subject.doors()[0].locked, false);
    assert.equal(subject.doors()[0].lockedByKey, false);
    subject.importDoors([{ ...door, forceLocked: true }], { squares });
    const before = subject.saveDoorState();

    assertDoorRefused(subject, door.id);
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

    completeQueueRequest(subject, subject.toggleDoor(rows[0].id));
    assert.equal(subject.saveDoorState().revision, locked.revision + 1);
    completeQueueRequest(subject, subject.toggleDoor(rows[0].id));
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
    completeQueueRequest(subject, subject.toggleDoor(nativeDoor().id));
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
    completeQueueRequest(subject, subject.toggleDoor(rows[0].id));
    assert.deepEqual(subject.doors().map(({ open, x, y }) => [open, x, y]),
        [[true, 10, 10], [true, 10, 11], [true, 13, 11], [true, 13, 10]]);
    assert.ok(subject.doors().every(({ toggled }) => toggled === true));
    completeQueueRequest(subject, subject.toggleDoor(rows[0].id));
    assert.deepEqual(subject.doors().map(({ open, x, y }) => [open, x, y]),
        [[false, 10, 10], [false, 11, 10], [false, 12, 10], [false, 13, 10]]);
    assert.ok(subject.doors().every(({ toggled }) => toggled === true));
    const garage = [1, 2, 3].map((garageDoor) => nativeDoor({
        id: `door:${9 + garageDoor}:10:0:0`, x: 9 + garageDoor, garageDoor,
    }));

    subject.importDoors(garage, { squares: doorSquares() });
    completeQueueRequest(subject, subject.toggleDoor(garage[1].id));
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

test('native special-panel obstruction and unavailable source adjacency refuse atomically while legal alternate sides walk', async () => {
    const subject = await engine();

    subject.worldImportCell(0, 0, cellBytes());
    const doubles = [1, 2, 3, 4].map((doubleDoor) => nativeDoor({
        id: `door:${9 + doubleDoor}:10:0:0`, x: 9 + doubleDoor, doubleDoor,
    }));

    subject.importDoors(doubles, { squares: doorSquares({ '11:11': { tree: true } }) });
    doorSpawn(subject, 10.5, 10.5);
    let before = subject.saveDoorState();

    assertDoorRefused(subject, doubles[0].id);
    assert.deepEqual(subject.saveDoorState(), before);
    const garage = [1, 2, 3].map((garageDoor) => nativeDoor({
        id: `door:${9 + garageDoor}:10:0:0`, x: 9 + garageDoor, garageDoor, open: true,
    }));

    subject.importDoors(garage, { squares: doorSquares({ '12:10': { vehicleObstructed: true } }) });
    before = subject.saveDoorState();
    assertDoorRefused(subject, garage[0].id);
    assert.deepEqual(subject.saveDoorState(), before);
    subject.importDoors([nativeDoor()], { squares: doorSquares({ '10:10': { independentWalls: 4 } }) });
    doorSpawn(subject, 9.5, 10.5);
    before = subject.saveDoorState();
    const adjacent = subject.sourceActions.findAdjacent({ x: 10, y: 10, z: 0 }, nativeDoor().id);
    const approach = subject.actions.requestDoor(nativeDoor().id);

    assert.equal(approach.accepted, true);
    assert.equal(subject.actions.getState().current.kind, 'walk');
    assert.deepEqual(subject.saveDoorState(), before, 'alternate-side admission does not mutate the door');
    completeActions(subject);
    assert.equal(subject.doors()[0].open, true, 'a wall on one side does not discard the genuine reachable door side');
    assert.equal(Math.floor(subject.snapshot().x), adjacent.x);
    assert.equal(Math.floor(subject.snapshot().y), adjacent.y);
    subject.importDoors([nativeDoor()], {
        squares: doorSquares({
            '10:10': { solid: true, independentWalls: 4 },
            '10:9': { solid: true }, '9:9': { solid: true }, '11:9': { solid: true },
            '9:11': { solid: true }, '11:11': { solid: true },
        }),
    });
    doorSpawn(subject, 9.5, 10.5);
    before = subject.saveDoorState();

    assert.equal(subject.sourceActions.findAdjacent({ x: 10, y: 10, z: 0 }, nativeDoor().id), null,
        'both source door sides and every diagonal fallback are genuinely unavailable');
    assertDoorRefused(subject, nativeDoor().id);
    assert.deepEqual(subject.saveDoorState(), before);
    subject.importDoors([nativeDoor({ locked: true, lockedByKey: true, hoppable: true })],
        { squares: doorSquares() });
    doorSpawn(subject, 10.5, 10.5);
    completeQueueRequest(subject, subject.toggleDoor(nativeDoor().id));
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

        assertDoorRefused(subject, door.id);
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

    completeQueueRequest(subject, subject.toggleDoor(rows[0].id));
    completeQueueRequest(subject, subject.toggleDoor(rows[0].id));
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

    const approach = restored.actions.requestDoor(rows[1].id);

    assert.equal(approach.accepted, true);
    assert.equal(restored.actions.getState().current.kind, 'walk');
    assert.deepEqual(restored.saveDoorState(), before, 'far-door admission cannot manufacture successful render history');
    completeActions(restored);
    assert.deepEqual(restored.doors().map(({ open, toggled }) => [open, toggled]), [[false, true], [true, true]]);
    restored.importDoors([rows[0], { ...rows[1], barricaded: true }], { squares });
    restored.loadDoorState(saved);
    assertDoorRefused(restored, rows[1].id);
    assert.deepEqual(restored.saveDoorState(), saved, 'a genuine native blocker retains restored per-door history');
    restored.importDoors(rows.map((row) => ({ ...row, toggled: true })), { squares });
    assert.ok(restored.doors().every(({ toggled }) => toggled === false),
        'source imports cannot spoof native successful-toggle history');
});

test('native body wound pain uses actual injury and treatment state for action timing', async () => {
    const subject = await engine();

    subject.command({ type: 'setBodyPart', part: 'Hand_L', values: { scratchTime: 10 } });
    assert.equal(subject.bodyParts().find((part) => part.id === 'Hand_L').pain, 17);
    subject.command({ type: 'setBodyPart', part: 'Hand_L', values: { bandaged: true } });
    assert.ok(near(subject.bodyParts().find((part) => part.id === 'Hand_L').pain, 17 / 1.5));
    subject.command({
        type: 'setBodyPart', part: 'Hand_L',
        values: { woundInfectionLevel: 3, additionalPain: 2, stiffness: 7 },
    });
    assert.ok(near(subject.bodyParts().find((part) => part.id === 'Hand_L').pain, 17 / 1.5 + 7));
    const before = subject.bodyParts();

    assert.throws(() => subject.command({
        type: 'setBodyPart', part: 'Hand_L', values: { scratchTime: 20, stiffness: Number.NaN },
    }));
    assert.deepEqual(subject.bodyParts(), before, 'a rejected multi-field injury change cannot partially heal or injure');
});

test('native cold action factor uses real arm nodes and does not charge unrelated body regions', async () => {
    const subject = await engine();

    subject.command({ type: 'setBodyPart', part: 'Foot_L', values: { skinTemperature: 20 } });
    assert.equal(subject.thermalActionModifier(), 1);
    subject.command({ type: 'setBodyPart', part: 'Hand_L', values: { skinTemperature: 20 } });
    assert.ok(near(subject.thermalActionModifier(), 1.000_75));
    subject.command({ type: 'setBodyPart', part: 'ForeArm_R', values: { skinTemperature: 20 } });
    assert.ok(near(subject.thermalActionModifier(), 1.002_062_5));
    subject.command({ type: 'setBodyPart', part: 'UpperArm_L', values: { skinTemperature: 20 } });
    assert.ok(near(subject.thermalActionModifier(), 1.003_187_5));
    subject.command({ type: 'setBodyPart', part: 'Hand_L', values: { skinTemperature: 33 } });
    assert.ok(near(subject.thermalActionModifier(), 1.002_437_5));
    const saved = subject.saveBodyState();
    const restored = await engine();

    restored.loadBodyState(saved);
    assert.deepEqual(restored.bodyParts(), subject.bodyParts());
    assert.equal(restored.thermalActionModifier(), subject.thermalActionModifier());
});

test('native body bite stitch fracture and severity preserve source treatment order', async () => {
    const subject = await engine();

    subject.command({
        type: 'setBodyPart', part: 'Hand_R',
        values: {
            biteTime: 1, stitchTime: 10, fractureTime: 40, splintFactor: 1,
            haveBullet: true, haveGlass: true,
        },
    });
    assert.equal(subject.bodyParts()[1].pain, 155);
    subject.command({
        type: 'setBodyPart', part: 'Hand_R',
        values: { bandaged: true, woundInfectionLevel: 4, additionalPain: 3, stiffness: 7 },
    });
    assert.ok(near(subject.bodyParts()[1].pain, 90.666_666_666_7));
    subject.command({ type: 'setInjurySeverity', severity: 'low' });
    assert.ok(near(subject.bodyParts()[1].pain, 63.466_666_666_7));
    subject.command({ type: 'setInjurySeverity', severity: 'high' });
    assert.ok(near(subject.bodyParts()[1].pain, 117.866_666_666_7));
    subject.command({ type: 'setInjurySeverity', severity: 'normal' });
    subject.command({ type: 'setBodyPart', part: 'Hand_R', values: { stitchTime: 35, splintFactor: 0 } });
    assert.ok(near(subject.bodyParts()[1].pain, 95.666_666_666_7));
});

test('native body restore refuses malformed rows and precision violations without publishing a prefix', async () => {
    const subject = await engine();

    subject.command({ type: 'setBodyPart', part: 'Neck', values: { additionalPain: -10, skinTemperature: -5 } });
    const before = subject.saveBodyState();
    const invalidStates = [
        { ...before, version: 2 },
        { ...before, injurySeverity: 'HIGH' },
        { ...before, parts: before.parts.slice(1) },
        { ...before, parts: [...before.parts.slice(0, 16), before.parts[0]] },
    ];

    for (const mutate of [
        (state) => {
            state.parts[16].pain = 0;
        },
        (state) => {
            delete state.parts[16].bandaged;
        },
        (state) => {
            state.parts[16].stiffness = 100 + 1e-10;
        },
        (state) => {
            state.parts[16].deepWoundTime = -Number.MIN_VALUE;
        },
    ]) {
        const state = structuredClone(before);

        state.parts[0].health = 3;
        mutate(state);
        invalidStates.push(state);
    }

    for (const state of invalidStates) {
        assert.throws(() => subject.loadBodyState(state));
        assert.deepEqual(subject.saveBodyState(), before);
    }

    for (const values of [
        { cutTime: 100 + 1e-10 }, { burnTime: -Number.MIN_VALUE },
        { additionalPain: 3.402_823_466_385_288_6e38 * (1 + Number.EPSILON) },
        { bandaged: 1 }, { pain: 20 }, { skinSurface: 1 },
    ]) {
        assert.throws(() => subject.command({ type: 'setBodyPart', part: 'Hand_L', values }));
        assert.deepEqual(subject.saveBodyState(), before);
    }

    const reversed = structuredClone(before);

    reversed.parts.reverse();
    subject.loadBodyState(reversed);
    assert.deepEqual(subject.saveBodyState(), before);
    const detached = subject.bodyParts();

    detached[0].health = 0;
    assert.equal(subject.bodyParts()[0].health, 100);
    subject.command({
        type: 'setBodyPart', part: 'Hand_L',
        values: { deepWoundTime: 3.402_823_466_385_288_6e38, skinTemperature: -3.402_823_466_385_288_6e38 },
    });
    assert.equal(subject.bodyParts()[0].pain, Infinity);
    assert.equal(subject.thermalActionModifier(), Infinity);
    assert.equal(subject.saveBodyState().parts[0].deepWoundTime, 3.402_823_466_385_288_6e38);
});

test('direct native body transactions validate all words before publishing and retain actor ABI', async () => {
    const { instance } = await WebAssembly.instantiate(moduleBytes, {});
    const native = instance.exports;

    assert.equal(native.api_version(), 1);
    assert.equal(native.state_size(), 12);
    assert.equal(native.scratch_size(), 96);
    assert.equal(native.body_part_value(0, 0), 100);
    assert.equal(native.body_part_value(0, 15), 33);
    assert.equal(native.body_update_begin(0), 0);
    assert.equal(native.body_update_stage(1, 10), 0);
    assert.notEqual(native.body_update_stage(11, 100 + 1e-10), 0);
    assert.notEqual(native.body_update_commit(), 0);
    assert.equal(native.body_part_value(0, 1), 0);
    assert.equal(native.body_import_begin(2), 0);
    assert.equal(native.body_import_stage(0, 4), 0);
    assert.notEqual(native.body_import_stage(1, -Number.MIN_VALUE), 0);
    assert.notEqual(native.body_import_commit(), 0);
    assert.equal(native.body_part_value(0, 0), 100);
    assert.equal(native.body_injury_severity(), 1);
    assert.equal(native.body_import_begin(2), 0);
    assert.equal(native.body_import_stage(0, 4), 0);
    assert.notEqual(native.body_import_commit(), 0);
    assert.equal(native.body_part_value(0, 0), 100);
    assert.equal(native.body_update_begin(0), 0);
    assert.equal(native.body_update_stage(1, 10), 0);
    assert.notEqual(native.body_update_stage(1, 20), 0);
    assert.notEqual(native.body_update_commit(), 0);
    assert.equal(native.body_part_value(0, 1), 0);
    assert.equal(native.body_update_begin(0), 0);
    assert.equal(native.body_update_stage(1, 10), 0);
    assert.equal(native.body_update_commit(), 0);
    assert.equal(native.body_part_value(0, 16), 17);
    assert.equal(native.set_injury_severity(0), 0);
    native.reset();
    assert.equal(native.body_part_value(0, 16), 0);
    assert.equal(native.body_injury_severity(), 1);
});

test('source trait and live slow motion govern queued stable-ID pickup completion', async () => {
    const subject = await engine();

    subject.worldImportCell(0, 0, cellBytes());
    subject.importDoors([], { squares: doorSquares({ '10:10': { solidFloor: true } }) });
    doorSpawn(subject, 10.5, 10.5);
    subject.registerItemDefinition(shoe('Base.QueueItem', { weight: 1 }), { owner: 'base' });
    const id = subject.command({ type: 'spawnItem', fullType: 'Base.QueueItem', x: 10.5, y: 10.5 }).id;

    subject.sourceTiming.setTrait('base:dextrous', true);
    subject.sourceTiming.set('slowHalf', true);
    const accepted = subject.command({ type: 'pickup', id });

    assert.equal(accepted.accepted, true);
    assert.notEqual(subject.items().find((item) => item.id === id).worldPosition, null);
    assert.equal(subject.actions.getState().current.maxTime, 24, 'Dextrous halves the source 48-unit request');

    for (let frame = 0; frame < 30; frame += 1) {
        subject.frameStep(STEP);
    }

    assert.notEqual(subject.items().find((item) => item.id === id).worldPosition, null);
    assert.ok(Math.abs(subject.actions.getState().current.currentTime - 12) < 0.000_1);
    subject.sourceTiming.set('slowHalf', false);

    for (let frame = 0; frame < 16; frame += 1) {
        subject.frameStep(STEP);
    }

    assert.equal(subject.items().find((item) => item.id === id).ownerContainerId, 1);
    assert.deepEqual(subject.actions.getState().pending, []);
    assert.equal(subject.actions.getState().current, null);
});

test('native grouped pickup retains first duration, twenty-item boundaries, partial capacity prefix and immutable views', async () => {
    const subject = await engine();

    subject.registerItemDefinition(shoe('Base.Grouped', { weight: 1 }), { owner: 'base' });
    const ids = Array.from({ length: 21 }, () => subject.command({ type: 'spawnItem', fullType: 'Base.Grouped', x: 5, y: 5 }).id);

    subject.actions.requestPickup(ids[0]);
    subject.command({ type: 'setActualWeight', id: ids[1], actualWeight: 2 });

    for (const id of ids.slice(1)) {
        subject.actions.requestPickup(id);
    }

    const state = subject.actions.getState();

    assert.equal(state.current.groups.length, 2);
    assert.deepEqual(state.current.groups.map((group) => group.itemIds.length), [20, 1]);
    assert.equal(state.current.groups[0].rawTime, 48, 'later heavier item does not replace first group time');
    assert.ok(Object.isFrozen(state) && Object.isFrozen(state.current) && Object.isFrozen(state.current.groups[0].itemIds));
    assert.equal(subject.containerItems(1).length, 0);
    completeActions(subject);
    assert.equal(subject.containerItems(1).length, 21);
    assert.equal(subject.inventoryState().capacityWeight, 22);

    const extra = Array.from({ length: 3 }, () => subject.command({ type: 'spawnItem', fullType: 'Base.Grouped', x: 5, y: 5 }).id);

    subject.command({ type: 'setActualWeight', id: extra[0], actualWeight: 20 });
    subject.command({ type: 'setActualWeight', id: extra[1], actualWeight: 20 });

    for (const id of extra) {
        subject.actions.requestPickup(id);
    }

    completeActions(subject);
    assert.deepEqual(extra.map((id) => subject.getItem(id).worldPosition === null),
        [true, false, false], 'source prefix stops at first invalid carry item');
});

test('native queue portable bytes resume stable IDs, live timing and progress and bad staging is atomic', async () => {
    const subject = await engine();

    subject.registerItemDefinition(shoe('Base.Queued'), { owner: 'base' });
    const id = subject.command({ type: 'spawnItem', fullType: 'Base.Queued', x: 5, y: 5 }).id;

    subject.sourceTiming.setTrait('base:allthumbs', true);
    subject.sourceTiming.set('slowQuarter', true);
    subject.sourceTiming.setGameMode('LastStand');
    subject.actions.requestPickup(id);
    subject.frameStep(STEP);
    const before = subject.actions.getState();
    const bytes = subject.saveQueueState();
    const restored = await engine();

    restored.registerItemDefinition(shoe('Base.Queued'), { owner: 'base' });
    restored.importInventoryGraph(subject.exportInventoryGraph());
    restored.loadState(subject.saveState());
    restored.loadQueueState(bytes);
    assert.deepEqual(restored.actions.getState(), before);
    assert.deepEqual(restored.sourceTiming.getState(), subject.sourceTiming.getState());
    const corrupt = bytes.slice();

    corrupt[0] ^= 255;
    assert.throws(() => restored.loadQueueState(corrupt));
    assert.deepEqual(restored.saveQueueState(), bytes);
    completeActions(subject);
    completeActions(restored);
    assert.deepEqual(restored.items(), subject.items());
    const next = restored.command({ type: 'spawnItem', fullType: 'Base.Queued', x: 5, y: 5 }).id;

    restored.actions.requestPickup(next);
    restored.actions.cancel();
    assert.notEqual(restored.getItem(next).worldPosition, null);
    assert.deepEqual(restored.actions.getState(), { current: null, pending: [] });
});

test('queued progress preserves source NaN bits without JSON null and explicit cancellation retains ground item', async () => {
    const subject = await engine();

    subject.registerItemDefinition(shoe('Base.FloatQueue'), { owner: 'base' });
    const id = subject.command({ type: 'spawnItem', fullType: 'Base.FloatQueue', x: 5, y: 5 }).id;
    const accepted = subject.actions.requestPickup(id);

    subject.sourceActions.actionSet(accepted.actionId, 1, Number.NaN);
    assert.ok(Number.isNaN(subject.actions.getState().current.currentTime));
    const bytes = subject.saveQueueState();

    subject.loadQueueState(bytes);
    assert.ok(Number.isNaN(subject.actions.getState().current.currentTime));
    assert.deepEqual(subject.saveQueueState(), bytes);
    subject.command({ type: 'cancel' });
    assert.notEqual(subject.items()[0].worldPosition, null);
    assert.equal(subject.actions.getState().current, null);
    assert.throws(() => subject.sourceTiming.hasTrait('base:unknown'), /Unsupported source trait/u);
    assert.throws(() => subject.sourceTiming.set('unknown', 1), /Unsupported source timing/u);
});

test('queued SDK door request walks to native source adjacency before actual toggle', async () => {
    const subject = await engine();

    subject.worldImportCell(0, 0, cellBytes());
    subject.importDoors([nativeDoor()], { squares: doorSquares() });
    doorSpawn(subject, 13.5, 13.5);
    const accepted = subject.actions.requestDoor(nativeDoor().id);

    assert.equal(accepted.accepted, true);
    assert.equal(subject.actions.getState().current.kind, 'walk');
    assert.equal(subject.doors()[0].open, false);
    completeActions(subject);
    assert.equal(subject.doors()[0].open, true);
    assert.ok(Math.abs(subject.snapshot().x - 10.5) < 0.001);
    assert.ok(subject.snapshot().y === 10.5 || subject.snapshot().y === 9.5);
    assert.deepEqual(subject.actions.getState(), { current: null, pending: [] });
});

test('native source mode staging preserves exact UTF8 and refuses malformed host strings without mutation', async () => {
    const subject = await engine();

    subject.sourceTiming.setGameMode('Sandbox 日本語');
    assert.equal(subject.sourceTiming.getGameMode(), 'Sandbox 日本語');
    const before = subject.saveQueueState();

    assert.throws(() => subject.sourceTiming.setGameMode('\uD800'), /UTF8/u);
    assert.throws(() => subject.sourceTiming.setGameMode('語'.repeat(43)), /128/u);
    assert.deepEqual(subject.saveQueueState(), before);
});

test('queued source pickup modifiers use the actual canonical hands slot and AllThumbs-or-gloves once', async () => {
    const subject = await engine();

    subject.registerItemDefinition(shoe('Base.TaggedShoe', { tags: ['base:awkwardgloves'] }), { owner: 'base' });
    subject.registerItemDefinition(shoe('Base.AwkwardHands', { bodyLocation: 'base:hands', tags: ['base:awkwardgloves'] }), { owner: 'base' });
    subject.registerItemDefinition(shoe('Base.Transfer'), { owner: 'base' });
    const footwear = subject.command({ type: 'spawnItem', fullType: 'Base.TaggedShoe', x: 5, y: 5 }).id;

    subject.actions.requestPickup(footwear);
    completeActions(subject);
    subject.command({ type: 'wear', id: footwear });
    const target = subject.command({ type: 'spawnItem', fullType: 'Base.Transfer', x: 5, y: 5 }).id;

    subject.actions.requestPickup(target);
    assert.equal(subject.actions.getState().current.maxTime, 48, 'a tagged shoe cannot act as awkward handwear');
    subject.actions.cancel();
    const gloves = subject.command({ type: 'spawnItem', fullType: 'Base.AwkwardHands', x: 5, y: 5 }).id;

    subject.actions.requestPickup(gloves);
    completeActions(subject);
    subject.command({ type: 'wear', id: gloves });
    subject.actions.requestPickup(target);
    assert.equal(subject.actions.getState().current.maxTime, 96);
    subject.actions.cancel();
    subject.sourceTiming.setTrait('base:allthumbs', true);
    subject.actions.requestPickup(target);
    assert.equal(subject.actions.getState().current.maxTime, 96, 'AllThumbs and gloves are OR, not stacked multipliers');
    subject.actions.cancel();
    subject.sourceTiming.setTrait('base:dextrous', true);
    subject.actions.requestPickup(target);
    assert.equal(subject.actions.getState().current.maxTime, 48, 'Dextrous applies separately from the shared OR factor');
});

test('native source canReach combines immutable object-wall facts with its final wall relation', async () => {
    const subject = await engine();
    const from = { x: 10, y: 10, z: 0 };
    const east = { x: 11, y: 10, z: 0 };

    subject.worldImportCell(0, 0, cellBytes());
    subject.importDoors([], {
        squares: doorSquares({
            '11:10': { interactionProperties: { collideW: true }, reachWalls: { north: false, west: false } },
        }),
    });
    assert.equal(subject.isBlockedTo(from, east), true);
    assert.equal(subject.sourceActions.canReachTo(from, east), false,
        'source canReachTo still applies its final isWallTo rejection after the object-wall checks');
    subject.importDoors([], {
        squares: doorSquares({
            '11:10': { reachWalls: { north: false, west: true } },
        }),
    });
    assert.equal(subject.isBlockedTo(from, east), false);
    assert.equal(subject.sourceActions.canReachTo(from, east), false, 'a qualifying raw source wall need not have collideW');
    subject.importDoors([], {
        squares: doorSquares({
            '11:10': {
                interactionProperties: { collideW: true, windowW: true },
                reachWalls: { north: false, west: false },
            },
        }),
    });
    assert.equal(subject.isBlockedTo(from, east), false);
    assert.equal(subject.sourceActions.canReachTo(from, east), true,
        'a genuine window property exempts a collision wall without inventing an actual blocked window');
    assert.equal(subject.sourceActions.canReachTo(from, from), true);
    assert.equal(subject.sourceActions.canReachTo(from, { x: 12, y: 10, z: 0 }), false, 'source reach remains adjacent');
    const before = subject.getSquare(10, 10, 0);

    assert.throws(() => subject.importDoors([], {
        squares: doorSquares({
            '11:10': { reachWalls: { north: false, west: 1 } },
        }),
    }), /boolean north and west/u);
    assert.deepEqual(subject.getSquare(10, 10, 0), before);
    const unknown = doorSquares();

    for (const square of unknown) {
        delete square.reachWalls;
    }

    subject.importDoors([], { squares: unknown });
    assert.throws(() => subject.sourceActions.canReachTo(from, east), /can_reach/u, 'missing source reach facts refuse rather than fabricate false');
});

test('private curtain bridge distinguishes genuine own constructor fields from missing eligibility metadata', async () => {
    const subject = await engine();

    subject.worldImportCell(0, 0, cellBytes());
    subject.importDoors([nativeDoor()], { squares: doorSquares() });
    assert.deepEqual(subject.sourceActions.doorCurtainState(nativeDoor().id),
        { has: false, open: false, inside: false, canAdd: null });
    subject.importDoors([nativeDoor({ curtainCapabilities: [true, false, false, true] })], { squares: doorSquares() });
    assert.deepEqual(subject.sourceActions.doorCurtainState(nativeDoor().id),
        { has: false, open: false, inside: false, canAdd: true });
    doorSpawn(subject, 10.5, 10.5);
    completeQueueRequest(subject, subject.actions.requestDoor(nativeDoor().id));
    assert.equal(subject.sourceActions.doorCurtainState(nativeDoor().id).canAdd, true, 'toggled open uses its real fourth source snapshot');
    completeQueueRequest(subject, subject.actions.requestDoor(nativeDoor().id));
    assert.equal(subject.sourceActions.doorCurtainState(nativeDoor().id).canAdd, false, 'toggled closed uses its real third source snapshot');
    const before = subject.saveDoorState();

    assert.throws(() => subject.importDoors([nativeDoor({ curtainCapabilities: [true, 1, false, false] })],
        { squares: doorSquares() }), /strict booleans/u);
    assert.deepEqual(subject.saveDoorState(), before);
    assert.throws(() => subject.sourceActions.doorCurtainState('door:99:99:0:0'), /Unknown door/u);
    assert.equal(Object.hasOwn(before.doors[0], 'curtainCapabilities'), false, 'immutable blueprint metadata is not mutable save state');
});

test('public engine action cancellation stops primitive headings and destinations without waiting for queue-owned work', async () => {
    await Promise.all([{ type: 'walk', x: 1, y: 0 }, { type: 'moveTo', x: 9, y: 7 }].map(async (action) => {
        const subject = await engine();

        subject.command(action);
        assert.equal(subject.actions.getState().current, null);
        const state = subject.actions.cancel();

        assert.deepEqual(state, { current: null, pending: [] });
        subject.step(STEP);
        assert.deepEqual([subject.snapshot().x, subject.snapshot().y, subject.snapshot().action], [5, 5, IDLE]);
    }));

    const source = await engine();

    source.command({ type: 'walk', x: 1, y: 0 });
    source.sourceActions.clear();
    source.step(STEP);
    assert.ok(source.snapshot().x > 5, 'private source queue clear deliberately does not cancel unrelated primitive movement');
});

test('private source couldBeOpen routes actual native menu policy rather than queued commit feasibility', async () => {
    const subject = await engine();
    const id = nativeDoor().id;

    subject.worldImportCell(0, 0, cellBytes());
    subject.importDoors([nativeDoor({ locked: true })], { squares: doorSquares() });
    doorSpawn(subject, 10.5, 10.5);
    assert.equal(subject.sourceActions.doorCouldBeOpen(id), true, 'ordinary locking alone does not disable the original menu');
    assertDoorRefused(subject, id);
    assert.equal(subject.doors()[0].open, false, 'menu eligibility does not authorize a locked native commit');
    subject.importDoors([nativeDoor({ barricaded: true })], { squares: doorSquares() });
    assert.equal(subject.sourceActions.doorCouldBeOpen(id), false, 'the actual native barricade disables the menu');
    subject.importDoors([nativeDoor({ lockedByKey: true, keyId: 7 })], { squares: doorSquares() });
    assert.throws(() => subject.sourceActions.doorCouldBeOpen(id), /doorCouldBeOpen/u,
        'unsupported outside key or cheat authority is not fabricated as a boolean');
    assert.throws(() => subject.sourceActions.doorCouldBeOpen('door:99:99:0:0'), /Unknown door/u);
});

test('real held item pair preserves MAX IDs, exact carry state and silent atomic restore', async () => {
    const subject = await engine();

    subject.registerItemDefinition(shoe('Base.Held', { removeOnBroken: true }), { owner: 'base' });
    const floorId = subject.sourceActions.floorContainer(5, 5, 0);

    subject.importInventoryGraph({
        ...subject.exportInventoryGraph(), items: [
            {
                id: 0xFF_FF_FF_FF, fullType: 'Base.Held', definitionOrdinal: 0, ownerContainerId: 1,
                internalContainerId: null, worldPosition: null, favorite: false, consumed: false,
                condition: 10, count: 1, bodyLocation: null, weight: 10, actualWeight: 10,
            },
            {
                id: 1, fullType: 'Base.Held', definitionOrdinal: 0, ownerContainerId: floorId,
                internalContainerId: null, worldPosition: { x: 5, y: 5, z: 0 }, favorite: false, consumed: false,
                condition: 10, count: 1, bodyLocation: null, weight: 1, actualWeight: 1,
            },
        ], wornOrder: undefined,
    });
    const events = [];
    const observerErrors = [];
    const off = subject.observeHandItems((event) => events.push(event), (cause) => observerErrors.push(cause));

    subject.setHandItem('primary', 0xFF_FF_FF_FF);
    subject.setHandItem('secondary', 0xFF_FF_FF_FF);
    subject.setHandItem('primary', 0xFF_FF_FF_FF);
    assert.deepEqual(subject.getHandItems(), { primary: 0xFF_FF_FF_FF, secondary: 0xFF_FF_FF_FF });
    assert.equal(subject.inventoryState().capacityWeight, 3);
    assert.equal(subject.wornItem('base:shoes'), null);
    assert.equal(events.length, 2);
    const saved = subject.saveHandState();

    for (const bad of [{ ...saved, version: 2 }, { ...saved, secondary: 1 }, { ...saved, extra: true },
        { ...saved, primary: -1 }, { ...saved, primary: undefined }]) {
        assert.throws(() => subject.loadHandState(bad));
        assert.deepEqual(subject.saveHandState(), saved);
    }

    assert.throws(() => subject.setHandItem('primary', 1));
    assert.throws(() => subject.setHandItem('worn', null));
    assert.throws(() => subject.setHandItem('secondary', 0x1_00_00_00_00));
    assert.throws(() => subject.command({ type: 'drop', id: 0xFF_FF_FF_FF, x: Number.NaN, y: 5 }));
    assert.equal(events.length, 2);
    subject.loadHandState({ version: 1, primary: null, secondary: null });
    subject.loadHandState(saved);
    assert.equal(events.length, 2, 'restores never replay equipment events');
    subject.command({ type: 'drop', id: 0xFF_FF_FF_FF, x: 5, y: 5 });
    assert.deepEqual(events.slice(2), [
        { slot: 'primary', playerIndex: 0, itemId: null },
        { slot: 'secondary', playerIndex: 0, itemId: null },
    ]);
    assert.deepEqual(subject.getHandItems(), { primary: null, secondary: null });
    const records = subject.items();

    records[0].ownerContainerId = 1;
    records[0].worldPosition = null;
    subject.importInventoryGraph({ ...subject.exportInventoryGraph(), items: records, wornOrder: undefined });
    subject.loadHandState(saved);
    subject.command({ type: 'setCondition', id: 0xFF_FF_FF_FF, condition: 0 });
    assert.deepEqual(subject.getHandItems(), { primary: null, secondary: null });
    assert.equal(subject.items().some((item) => item.id === 0xFF_FF_FF_FF), false);
    assert.deepEqual(events.slice(4), [
        { slot: 'primary', playerIndex: 0, itemId: null },
        { slot: 'secondary', playerIndex: 0, itemId: null },
    ]);
    subject.importInventoryGraph({ ...subject.exportInventoryGraph(), items: [records[0]], wornOrder: undefined });
    subject.loadHandState(saved);
    subject.worldReset();
    assert.deepEqual(subject.saveHandState(), saved, 'world-only reset preserves inventory and held refs');
    assert.equal(events.length, 6);
    subject.reset();
    assert.deepEqual(subject.getHandItems(), { primary: null, secondary: null });
    assert.deepEqual(events.slice(6), [
        { slot: 'primary', playerIndex: 0, itemId: null },
        { slot: 'secondary', playerIndex: 0, itemId: null },
    ]);
    off();
    assert.deepEqual(observerErrors, []);
});

test('native equipment canonicalizes without definition-created identities and imports worn order atomically', async () => {
    const subject = await createEngine(moduleBytes);
    const e = subject.equipmentOperation;
    const shoes = e('lookup', 'Shoes');
    const hands = e('lookup', 'BASE:Hands');
    const group = e('groupGet', 'Human', true);

    assert.equal(e('groupCount'), 1);
    assert.equal(e('groupAt', 0), group);
    assert.equal(e('groupName', group), 'Human');
    assert.equal(e('count'), 114);
    assert.equal(e('read', shoes, 0), 'base:shoes');
    assert.equal(e('lookup', 'base:SHOES'), shoes);
    assert.equal(e('canonical', 'Fixture:Path:Second'), 'fixture:path:second');
    assert.equal(e('canonical', ' Shoes '), 'base: shoes ', 'native resource canonicalization does not trim');
    assert.throws(() => e('canonical', 'é'.repeat(49)), /96-byte/u);
    assert.throws(() => e('canonical', 'x'.repeat(96)), 'namespacing must report native output overflow');
    assert.throws(() => e('register', 'Base:Custom'));
    assert.equal(e('lookup', 'Unknown'), null);
    assert.throws(() => subject.registerItemDefinition(shoe('Base.Unknown', { bodyLocation: 'Unknown' }), { owner: 'base' }));
    subject.registerItemDefinition(shoe('Base.Ordered', { bodyLocation: 'Hands', canBeEquipped: 'Shoes' }), { owner: 'base' });
    assert.equal(e('lookup', 'Unknown'), null);
    assert.equal(e('locationCount', group), 0, 'definitions must not add group membership');
    e('locationAdd', group, shoes);
    e('locationAdd', group, hands);
    e('multiSet', group, shoes, true);
    assert.equal(e('locationCount', group), 2);
    assert.equal(e('locationIndex', group, hands), 1);
    assert.equal(e('multiGet', group, shoes), true);
    e('relationSet', group, shoes, hands, 1);
    assert.equal(e('relationGet', group, shoes, hands, 1), true);
    assert.equal(e('relationCount', group, shoes, 1), 1);
    assert.equal(e('relationAt', group, shoes, 1, 0), hands);
    assert.equal(e('initialized', true), true);
    assert.equal(e('initialized'), true);
    const rows = [1, 0xFF_FF_FF_FF].map((id) => ({
        id, fullType: 'Base.Ordered', definitionOrdinal: 0, ownerContainerId: 1, internalContainerId: null,
        worldPosition: null, favorite: false, consumed: false,
        condition: 30, count: 1, bodyLocation: 'Shoes', weight: 1, actualWeight: 1,
    }));

    subject.importInventoryGraph({ ...subject.exportInventoryGraph(), items: rows, wornOrder: [0xFF_FF_FF_FF, 1] });
    assert.equal(subject.itemDefinitions()[0].canBeEquipped, 'base:shoes');
    assert.equal(subject.wornItem('BASE:Shoes').id, 0xFF_FF_FF_FF);
    assert.deepEqual(subject.wornItems(), [
        { id: 0xFF_FF_FF_FF, bodyLocation: 'base:shoes' }, { id: 1, bodyLocation: 'base:shoes' },
    ]);
    assert.throws(() => subject.importInventoryGraph({ ...subject.exportInventoryGraph(), items: rows, wornOrder: [1, 1] }));
    assert.deepEqual(subject.wornItems().map(({ id }) => id), [0xFF_FF_FF_FF, 1]);
    assert.throws(() => subject.importInventoryGraph({ ...subject.exportInventoryGraph(), items: rows, wornOrder: [1] }));
    assert.deepEqual(subject.items().map(({ id }) => id), [1, 0xFF_FF_FF_FF]);
    subject.importInventoryGraph({
        ...subject.exportInventoryGraph(), items: [
            { ...rows[0], bodyLocation: 'Hands' }, rows[1],
        ], wornOrder: [1, 0xFF_FF_FF_FF],
    });
    assert.deepEqual(subject.wornItems(), [
        { id: 1, bodyLocation: 'base:hands' }, { id: 0xFF_FF_FF_FF, bodyLocation: 'base:shoes' },
    ], 'explicit snapshot order is structural state, not a replay against current render indices');
    e('multiSet', group, shoes, false);
    subject.importInventoryGraph({ ...subject.exportInventoryGraph(), items: rows, wornOrder: [0xFF_FF_FF_FF, 1] });
    assert.deepEqual(subject.wornItems().map(({ id }) => id), [0xFF_FF_FF_FF, 1],
        'a later multi-item rule change does not invalidate captured coexistence');
    assert.throws(() => subject.importInventoryGraph({ ...subject.exportInventoryGraph(), items: rows, wornOrder: undefined }), 'legacy inferred import still applies current group multiplicity');
    assert.deepEqual(subject.wornItems().map(({ id }) => id), [0xFF_FF_FF_FF, 1]);
});

test('ordered native graph retains nested identities, direct membership and allocator across atomic restore', async () => {
    const subject = await engine();

    subject.registerItemDefinition(shoe('Fixture.Bag', {
        bodyLocation: null, type: 'Container', capacity: 20, weightReduction: 50,
        maxItemSize: 10, containerType: 'bag', weight: 1,
    }), { owner: 'fixture' });
    subject.registerItemDefinition(shoe('Fixture.Load', { bodyLocation: null, weight: 2 }), { owner: 'fixture' });
    const bagIds = [0, 1, 2].map(() => subject.command({ type: 'spawnItem', fullType: 'Fixture.Bag', x: 5, y: 5 }).id);
    const load = subject.command({ type: 'spawnItem', fullType: 'Fixture.Load', x: 5, y: 5 }).id;
    const interiors = bagIds.map((id) => subject.getItem(id).internalContainerId);
    const graph = subject.exportInventoryGraph();

    for (const [index, item] of graph.items.entries()) {
        item.ownerContainerId = index === 0 ? 1 : interiors[index - 1];
        item.worldPosition = null;
    }

    subject.importInventoryGraph(graph);
    assert.deepEqual(subject.containerItems(1).map(({ id }) => id), [bagIds[0]]);
    assert.deepEqual(subject.containerItems(interiors[2]).map(({ id }) => id), [load]);
    assert.equal(subject.sourceActions.containerContains(1, load, false), false);
    assert.equal(subject.sourceActions.containerContains(1, load, true), true);
    assert.equal(subject.sourceActions.containerIsInside(interiors[2], bagIds[0]), true);
    assert.equal(subject.sourceActions.containerActorOwner(interiors[2]), 1);
    assert.equal(subject.sourceActions.containerOutermost(interiors[2]), 1);
    assert.equal(subject.itemWeights(bagIds[0]).contentsWeight, 4);
    assert.equal(subject.itemWeights(bagIds[0]).unequippedWeight, 5);
    const snapshot = subject.exportInventoryGraph();

    for (const change of [
        (copy) => {
            copy.items[0].ownerContainerId = interiors[2];
        },
        (copy) => {
            copy.items[3].ownerContainerId = 0x1_00_00_00_00;
        },
        (copy) => {
            copy.items[3].actualWeight = -Number.MIN_VALUE;
        },
        (copy) => {
            copy.containers[0].capacity = 2 ** 31;
        },
        (copy) => {
            copy.nextContainerId = 1;
        },
    ]) {
        const malformed = structuredClone(snapshot);

        change(malformed);
        assert.throws(() => subject.importInventoryGraph(malformed));
        assert.deepEqual(subject.exportInventoryGraph(), snapshot);
    }

    const restored = await engine();

    for (const definition of subject.itemDefinitions()) {
        restored.registerItemDefinition(definition, { owner: definition.owner });
    }

    restored.importInventoryGraph(snapshot);
    assert.deepEqual(restored.exportInventoryGraph(), snapshot);
    const fresh = restored.command({ type: 'spawnItem', fullType: 'Fixture.Bag', x: 5, y: 5 }).id;

    assert.equal(restored.getItem(fresh).internalContainerId, snapshot.nextContainerId);
});

test('source bag fields are case insensitive and Capacity observes Weight at its authored position', async () => {
    const records = parseItemDefinitions(`module Fixture {
        item Before { type=Container, capacity=60, weight=10, weightreduction=150, maxitemsize=-1, }
        item After { Type=Container, Weight=10, Capacity=60, WeightReduction=-3, MaxItemSize=2.125, }
    }`, 'fixture-authored');

    assert.deepEqual(records.map(({ capacity, weightReduction, maxItemSize }) => ({ capacity, weightReduction, maxItemSize })),
        [{ capacity: 49, weightReduction: 150, maxItemSize: -1 }, { capacity: 40, weightReduction: -3, maxItemSize: 2.125 }]);
    const subject = await engine();

    for (const record of records) {
        subject.registerItemDefinition(shoe(record.fullType, { bodyLocation: null, ...record }), { owner: 'fixture' });
    }

    assert.deepEqual(subject.itemDefinitions().map(({ capacity, weightReduction }) => ({ capacity, weightReduction })),
        [{ capacity: 49, weightReduction: 100 }, { capacity: 40, weightReduction: 0 }]);
    const original = subject.itemDefinitions();

    subject.beginItemDefinitionRegistration('override');
    subject.registerItemDefinition(shoe('Fixture.Before', {
        bodyLocation: null, type: 'Container', capacity: 7, weightReduction: 2, maxItemSize: 1,
        onlyAcceptCategory: 'Clothing', acceptItemFunction: 'Fixture.accept',
    }), { owner: 'override', override: true });
    assert.equal(subject.itemDefinitions()[0].onlyAcceptCategory, 'clothing');
    subject.rollbackItemDefinitionRegistration('override');
    assert.deepEqual(subject.itemDefinitions(), original);
});

test('private proper square distance uses native f32 centers and ignores elevation', async () => {
    const subject = await engine();
    const distance = subject.sourceActions.squareDistanceToProper;
    const squares = [
        { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 },
        { x: 3, y: 4, z: 0 }, { x: 3, y: 4, z: 1 },
        { x: 6, y: 25_000, z: 0 },
    ].map((coords) => ({
        ...coords, roomId: -1, outside: true, solid: false, solidTrans: false,
        tree: false, vehicleObstructed: false, solidFloor: true, independentWalls: 0,
    }));

    subject.importDoors([], { squares });
    const before = subject.saveDoorState();

    assert.equal(Object.hasOwn(subject, 'squareDistanceToProper'), false);
    assert.equal(distance(0, 0, 0, 0, 0, 0), 0);
    assert.equal(distance(0, 0, 0, 1, 1, 0), 1.414_213_538_169_860_8);
    assert.equal(distance(0, 0, 0, 3, 4, 0), 5);
    assert.equal(distance(0, 0, 0, 3, 4, 1), 5);
    assert.equal(distance(3, 4, 1, 0, 0, 0), 5);
    assert.equal(distance(0, 0, 0, 6, 25_000, 0), 25_000,
        'IsoUtils squares and adds in f64 after f32 deltas, not an all-f32 length');
    assert.throws(() => distance(0, 0, 0, 9, 9, 0), /outside the accepted range/u);
    assert.throws(() => distance(9, 9, 0, 0, 0, 0), /outside the accepted range/u);

    for (const invalid of [0.5, Number.NaN, Infinity, 0x80_00_00_00, '0', null, undefined]) {
        assert.throws(() => distance(invalid, 0, 0, 0, 0, 0));
        assert.throws(() => distance(0, 0, 0, 0, 0, invalid));
    }

    assert.deepEqual(subject.saveDoorState(), before);
});

test('native authored floor metadata drives original window, staircase and apparent-elevation queries', async () => {
    const subject = await engine();

    subject.worldImportCell(0, 0, cellBytes());
    const squares = doorSquares({
        '10:10': { floorFlags: 9, stairTypes: 0, slopeDirection: 0, slopeMin: 0, slopeMax: 0 },
        '11:10': { floorFlags: 17, stairTypes: 0, slopeDirection: 0, slopeMin: 0, slopeMax: 0 },
        '12:10': { floorFlags: 0, stairTypes: 1, slopeDirection: 0, slopeMin: 0, slopeMax: 0 },
        '12:11': { floorFlags: 0, stairTypes: 2, slopeDirection: 0, slopeMin: 0, slopeMax: 0 },
        '12:12': { floorFlags: 0, stairTypes: 4, slopeDirection: 0, slopeMin: 0, slopeMax: 0 },
        '13:10': { floorFlags: 0, stairTypes: 0, slopeDirection: 1, slopeMin: 0.25, slopeMax: 0.75 },
    }).map((row) => ({ floorFlags: 1, stairTypes: 0, slopeDirection: 0, slopeMin: 0, slopeMax: 0, ...row }));

    subject.importDoors([], { squares });
    const q = subject.sourceActions;
    const from = { x: 10, y: 10, z: 0 };

    assert.equal(q.squareFloorState(from).solidFloor, true);
    assert.equal(q.squareWindowTo(from, { x: 10, y: 9, z: 0 }), true);
    assert.equal(q.squareWindowTo(from, { x: 11, y: 10, z: 0 }), true);
    assert.equal(q.squareWindowTo(from, from), false);
    assert.equal(q.squareWindowTo(from, { x: 9, y: 10, z: 0 }), false);
    assert.equal(q.squareFloorState({ x: 12, y: 10, z: 0 }).solidFloor, true);
    assert.equal(q.squareSameStaircase({ x: 12, y: 10, z: 0 }, { x: 12, y: 12, z: 0 }), true);
    assert.equal(q.squareSameStaircase({ x: 12, y: 12, z: 0 }, { x: 12, y: 10, z: 0 }), true);
    assert.equal(q.squareSameStaircase({ x: 12, y: 10, z: 0 }, from), false);
    assert.equal(q.squareApparentZ(from, 0.5, 0.5), 0);
    assert.equal(q.squareApparentZ({ x: 13, y: 10, z: 0 }, 0.5, 0.25), 0.625);
    assert.equal(q.squareApparentZ({ x: 12, y: 10, z: 0 }, 0.5, 0.5, false), 0.833_299_994_468_689);
    assert.equal(q.squareApparentZ({ x: 12, y: 10, z: 0 }, 0.5, 0.5, true), 0.883_300_006_389_617_9);
    const state = q.squareFloorState(from);

    assert.throws(() => subject.importDoors([], { squares: [{ ...squares[0], floorFlags: 2 ** 32 }] }));
    assert.deepEqual(q.squareFloorState(from), state);
    subject.importDoors([], { squares: doorSquares() });
    assert.throws(() => q.squareFloorState(from), /squareFloorState/u, 'missing source facts are not invented empty flags');
});

test('native bag policy resolves real keyring/attachment tags and refuses unsupported source weight facilities', async () => {
    const subject = await engine();
    const keyring = shoe('Fixture.Keyring', {
        type: 'Container', bodyLocation: null, capacity: 10, weight: 2, tags: ['base:keyring'],
        fakeEquipped: undefined,
    });
    const attached = shoe('Fixture.Attached', {
        bodyLocation: null, weight: 10, tags: ['base:lightwhenattached'], lightWhenAttached: undefined,
    });

    subject.registerItemDefinition(keyring, { owner: 'fixture' });
    subject.registerItemDefinition(attached, { owner: 'fixture' });
    const ringId = subject.command({ type: 'spawnItem', fullType: keyring.fullType, x: 5, y: 5 }).id;
    const attachedId = subject.command({ type: 'spawnItem', fullType: attached.fullType, x: 5, y: 5 }).id;

    assert.equal(subject.itemDefinitions()[0].fakeEquipped, true);
    assert.equal(subject.itemWeights(attachedId).hotbarEquippedWeight, 3);
    subject.command({ type: 'pickup', id: ringId });
    completeActions(subject);
    assert.ok(near(subject.inventoryState().capacityWeight, 0.6), 'direct actor keyring uses original fake-equipped authority');

    for (const [type, raw] of [
        ['Container', 'component FluidContainer { Capacity = 1, }'],
        ['base:clothing', 'AmmoType = Base.Bullets,'],
        ['Custom.Clothing', ''],
    ]) {
        const [definition] = parseItemDefinitions(`module Fixture { item Unsupported${subject.itemDefinitions().length} {
            Type = ${type}, ${raw}
        } }`, 'authored-unsupported');

        const registered = subject.registerItemDefinition(shoe(definition.fullType, { bodyLocation: null, ...definition }), { owner: 'fixture' });
        const before = subject.exportInventoryGraph();
        const actor = subject.saveState();

        assert.equal(registered.unsupportedSubtype, true);
        assert.throws(() => subject.command({ type: 'spawnItem', fullType: definition.fullType, x: 5, y: 5 }),
            /unsupported original facility/u);
        assert.deepEqual(subject.exportInventoryGraph(), before);
        assert.deepEqual(subject.saveState(), actor, 'unavailable weight facilities refuse before allocating an item');
        const target = type === 'Container' ? ringId : attachedId;
        const previous = subject.itemDefinitions().find(({ fullType }) => fullType === subject.getItem(target).fullType);
        const override = { ...previous, ...definition, fullType: previous.fullType };

        delete override.unsupportedSubtype;
        subject.beginItemDefinitionRegistration('fixture');
        try {
            assert.throws(() => subject.registerItemDefinition(override, { owner: 'fixture', override: true }),
                /outside the accepted range/u, 'native authority also refuses introducing unavailable weights into a live instance');
        } finally {
            subject.rollbackItemDefinitionRegistration('fixture');
        }

        assert.deepEqual(subject.itemDefinitions().find(({ fullType }) => fullType === previous.fullType), previous);
        assert.equal(subject.itemWeights(target).actualWeight, previous.weight);
        assert.deepEqual(subject.exportInventoryGraph(), before);
    }
});

test('signed stored bag capacity stays distinct from source wrapper limits without colliding with native errors', async () => {
    const subject = await engine();

    subject.registerItemDefinition(shoe('Fixture.SignedBag', {
        type: 'Container', bodyLocation: null, capacity: -1, weight: 2,
    }), { owner: 'fixture' });
    const id = subject.command({ type: 'spawnItem', fullType: 'Fixture.SignedBag', x: 5, y: 5 }).id;
    const container = subject.getItem(id).internalContainerId;

    assert.equal(subject.getContainer(container).capacity, -1);
    assert.equal(subject.sourceActions.itemContainerCapacity(id, 1, false), -1);
    assert.equal(subject.containerState(container, 1).capacity, -1);
    const before = subject.itemDefinitions();

    for (const invalid of [-(2 ** 31) - 1, 2 ** 31, 0.5, Infinity]) {
        assert.throws(() => subject.registerItemDefinition(shoe('Fixture.BadBag', {
            type: 'Container', bodyLocation: null, capacity: invalid,
        }), { owner: 'fixture' }));
        assert.deepEqual(subject.itemDefinitions(), before);
    }

    subject.importInventoryGraph(subject.exportInventoryGraph());
    assert.equal(subject.sourceActions.itemContainerCapacity(id, 0, false), -1);
    assert.throws(() => subject.sourceActions.itemContainerCapacity(0xFF_FF_FF_FF, 1, false), /outside the accepted range/u);
});

test('original bag inventory-weight getter discounts ordered children only when the shell is source equipped', async () => {
    const subject = await engine();

    subject.registerItemDefinition(shoe('Fixture.InventoryWeightBag', {
        type: 'Container', bodyLocation: null, capacity: 20, weight: 2, weightReduction: 50,
        tags: ['base:keyring'], fakeEquipped: undefined,
    }), { owner: 'fixture' });
    subject.registerItemDefinition(shoe('Fixture.InventoryWeightLoad', { bodyLocation: null, weight: 4 }), { owner: 'fixture' });
    const bag = subject.command({ type: 'spawnItem', fullType: 'Fixture.InventoryWeightBag', x: 5, y: 5 }).id;
    const load = subject.command({ type: 'spawnItem', fullType: 'Fixture.InventoryWeightLoad', x: 5, y: 5 }).id;
    const graph = subject.exportInventoryGraph();

    graph.items[1].ownerContainerId = subject.getItem(bag).internalContainerId;
    graph.items[1].worldPosition = null;
    subject.importInventoryGraph(graph);
    assert.equal(subject.sourceActions.itemInventoryWeight(bag), 4);
    assert.equal(subject.itemWeights(bag).contentsWeight, 4);
    subject.command({ type: 'pickup', id: bag });
    completeActions(subject);
    assert.ok(near(subject.sourceActions.itemInventoryWeight(bag), 1.2));
    assert.equal(subject.itemWeights(bag).contentsWeight, 4, 'contents weight is not an alias of equipped-child inventory weight');
    assert.deepEqual(subject.containerItems(subject.getItem(bag).internalContainerId).map(({ id }) => id), [load]);
});

test('native SDK kind5 residency and step/frame completion publish held-item deltas exactly once', async () => {
    const [stepSubject, frameSubject] = await Promise.all([engine(), engine()]);

    for (const [frame, subject] of [[false, stepSubject], [true, frameSubject]]) {
        subject.registerItemDefinition(shoe('Fixture.ObserverBag', { type: 'Container', bodyLocation: null, capacity: 20 }), { owner: 'fixture' });
        subject.registerItemDefinition(shoe('Fixture.ObserverItem', { bodyLocation: null }), { owner: 'fixture' });
        const bag = subject.command({ type: 'spawnItem', fullType: 'Fixture.ObserverBag', x: 5, y: 5 }).id;
        const item = subject.command({ type: 'spawnItem', fullType: 'Fixture.ObserverItem', x: 5, y: 5 }).id;
        const graph = subject.exportInventoryGraph();

        graph.items[1].ownerContainerId = 1;
        graph.items[1].worldPosition = null;
        subject.importInventoryGraph(graph);
        subject.setHandItem('primary', item);
        subject.setHandItem('secondary', item);
        const events = [];

        subject.observeHandItems((event) => events.push(event), (cause) => {
            throw cause;
        });
        const destination = subject.getItem(bag).internalContainerId;
        const accepted = subject.actions.requestTransfer(item, 1, destination);

        assert.equal(subject.sourceActions.actionExists(accepted.actionId), true, 'actual native kind5 slot must remain readable');
        assert.deepEqual(events, [], 'admission is not a held-state commit');

        for (let index = 0; index < 10_000 && subject.sourceActions.actionExists(accepted.actionId); index += 1) {
            if (frame) {
                subject.frameStep(STEP);
            } else {
                subject.step(STEP);
            }
        }

        assert.equal(subject.sourceActions.actionExists(accepted.actionId), false);
        assert.equal(subject.getItem(item).ownerContainerId, destination);
        assert.deepEqual(events, [
            { slot: 'primary', playerIndex: 0, itemId: null },
            { slot: 'secondary', playerIndex: 0, itemId: null },
        ]);
    }
});

test('native source helper emits held transitions only after successful finish and never after rollback', async () => {
    const [rollbackSubject, committedSubject] = await Promise.all([engine(), engine()]);

    for (const [success, subject] of [[false, rollbackSubject], [true, committedSubject]]) {
        subject.registerItemDefinition(shoe('Fixture.SourceObserverBag', { type: 'Container', bodyLocation: null, capacity: 20 }), { owner: 'fixture' });
        subject.registerItemDefinition(shoe('Fixture.SourceObserverItem', { bodyLocation: null }), { owner: 'fixture' });
        const bag = subject.command({ type: 'spawnItem', fullType: 'Fixture.SourceObserverBag', x: 5, y: 5 }).id;
        const item = subject.command({ type: 'spawnItem', fullType: 'Fixture.SourceObserverItem', x: 5, y: 5 }).id;
        const graph = subject.exportInventoryGraph();

        graph.items[1].ownerContainerId = 1;
        graph.items[1].worldPosition = null;
        subject.importInventoryGraph(graph);
        subject.setHandItem('primary', item);
        subject.setHandItem('secondary', item);
        const events = [];

        subject.observeHandItems((event) => events.push(event), (cause) => {
            throw cause;
        });
        const q = subject.sourceActions;
        const destination = subject.getItem(bag).internalContainerId;
        const action = q.newAction(5, 1, item, 5, 5, 0, 0);

        q.actionBindTransfer(action, 1, destination);
        const group = q.groupNew(action, 0);

        q.groupItemInsert(group, 0, item);
        q.groupInsert(action, 0, group);
        q.insert(0, action);
        q.start(action, 0, 1);
        let performed = false;

        for (let index = 0; index < 100 && !performed; index += 1) {
            subject.step(STEP);
            q.dispatch((event) => {
                assert.equal(q.actionExists(action), true);

                if (event.event === 1) {
                    return 1;
                }

                if (event.event !== 5) {
                    return 0;
                }

                q.transferBegin(action, group, item, event.token, 1);
                q.transferOperation(action, item, event.token, 1, 1, 0, 0, 0);
                q.transferOperation(action, item, event.token, 2, destination, 0, 0, 0);
                q.transferOperation(action, item, event.token, 5, 1, 0, 0, 0);
                assert.deepEqual(subject.getHandItems(), { primary: null, secondary: null });
                assert.deepEqual(events, [], 'intermediate helper operations are not committed notifications');
                q.transferFinish(action, item, event.token, success);
                performed = true;

                return success ? 0 : -4;
            });
        }

        assert.equal(performed, true, 'real native event5 must authorize the helper transaction');
        assert.equal(subject.getItem(item).ownerContainerId, success ? destination : 1);
        assert.deepEqual(subject.getHandItems(), success ? { primary: null, secondary: null } : { primary: item, secondary: item });
        assert.deepEqual(events, success
            ? [
                    { slot: 'primary', playerIndex: 0, itemId: null },
                    { slot: 'secondary', playerIndex: 0, itemId: null },
                ]
            : []);
    }
});

test('item and container roots retain the original ground-bag distinction', async () => {
    const subject = await engine();

    subject.registerItemDefinition(shoe('Fixture.RootBag', { type: 'Container', bodyLocation: null, capacity: 20 }), { owner: 'fixture' });
    subject.registerItemDefinition(shoe('Fixture.RootLoad', { bodyLocation: null }), { owner: 'fixture' });
    const bag = subject.command({ type: 'spawnItem', fullType: 'Fixture.RootBag', x: 5, y: 5 }).id;
    const item = subject.command({ type: 'spawnItem', fullType: 'Fixture.RootLoad', x: 5, y: 5 }).id;
    const floor = subject.getItem(bag).ownerContainerId;
    const interior = subject.getItem(bag).internalContainerId;
    const graph = subject.exportInventoryGraph();

    graph.items[1].ownerContainerId = interior;
    graph.items[1].worldPosition = null;
    subject.importInventoryGraph(graph);
    assert.equal(subject.sourceActions.itemOutermostContainer(bag), null);
    assert.equal(subject.sourceActions.itemOutermostContainer(item), interior);
    assert.equal(subject.sourceActions.containerOutermost(interior), floor);
    assert.equal(subject.sourceActions.containerActorOwner(interior), 0);
    subject.command({ type: 'pickup', id: bag });
    completeActions(subject);
    assert.equal(subject.sourceActions.itemOutermostContainer(bag), 1);
    assert.equal(subject.sourceActions.itemOutermostContainer(item), 1);
    assert.equal(subject.sourceActions.containerOutermost(interior), 1);
    assert.equal(subject.sourceActions.containerActorOwner(interior), 1);
});

test('native inventory presentation distinguishes typed tags and owns mutable category lifetime', async () => {
    const subject = await engine();
    const source = subject.sourceActions;
    const beforeEmpty = subject.exportInventoryGraph();

    assert.equal(source.containerDrawDirty(1), true);
    source.containerSetDrawDirty(1, false);
    assert.equal(source.containerDrawDirty(1), false);
    assert.deepEqual(subject.exportInventoryGraph(), beforeEmpty, 'empty UI queries do not allocate containers');
    subject.registerItemDefinition(shoe('Fixture.Tagged', {
        type: 'Container', bodyLocation: null, tags: ['base:keyring'], fakeEquipped: false,
        hidden: true, displayCategory: 'Supplies',
    }), { owner: 'fixture' });
    const id = subject.command({ type: 'spawnItem', fullType: 'Fixture.Tagged', x: 5, y: 5 }).id;
    const second = subject.command({ type: 'spawnItem', fullType: 'Fixture.Tagged', x: 5, y: 5 }).id;

    assert.equal(source.itemIsHidden(id), true);
    assert.equal(source.itemIsFood(id), false);
    assert.equal(source.itemIsKeyRingType(id), false);
    assert.equal(source.itemHasKeyRingTag(id), true, 'tag is independent of fake-equipped weight policy');
    assert.equal(source.itemDisplayCategory(id), 'Supplies');
    source.itemSetDisplayCategory(id, 'Custom');
    assert.equal(source.itemDisplayCategory(id), 'Custom');
    assert.equal(source.itemDisplayCategory(second), 'Supplies', 'instance mutation cannot rewrite its definition or sibling');
    subject.beginItemDefinitionRegistration('override');
    subject.registerItemDefinition(shoe('Fixture.Tagged', {
        type: 'Container', bodyLocation: null, hidden: false, displayCategory: 'Replacement',
    }), { owner: 'override', override: true });
    assert.equal(source.itemIsHidden(id), false);
    assert.equal(source.itemDisplayCategory(id), 'Custom');
    subject.rollbackItemDefinitionRegistration('override');
    assert.equal(source.itemIsHidden(id), true);
    assert.equal(source.itemHasKeyRingTag(id), true);
    assert.equal(source.itemDisplayCategory(id), 'Custom');
    source.itemSetDisplayCategory(id, null);
    assert.equal(source.itemDisplayCategory(id), null);
    subject.importInventoryGraph(subject.exportInventoryGraph());
    assert.equal(source.itemDisplayCategory(id), 'Supplies', 'original nonserialized category is reinitialized by item factory');
    assert.equal(source.containerDrawDirty(1), true, 'original container construction starts dirty');
    const floor = subject.getItem(id).ownerContainerId;

    source.containerSetDrawDirty(floor, false);
    source.containerSetDrawDirty(1, false);
    subject.command({ type: 'pickup', id });
    completeActions(subject);
    assert.equal(source.containerDrawDirty(floor), true);
    assert.equal(source.containerDrawDirty(1), true);
    source.containerSetDrawDirty(floor, false);
    source.containerSetDrawDirty(1, false);
    subject.command({ type: 'drop', id, x: 5, y: 5 });
    assert.equal(source.containerDrawDirty(floor), true);
    assert.equal(source.containerDrawDirty(1), true);

    for (const name of ['itemIsHidden', 'itemIsFood', 'itemIsKeyRingType', 'itemHasKeyRingTag', 'itemDisplayCategory', 'itemUnwantedKey']) {
        assert.throws(() => source[name](0xFF_FF_FF_FF), /outside the accepted range/u);
    }

    assert.throws(() => source.containerDrawDirty(0xFF_FF_FF_FF), /outside the accepted range/u);
    assert.throws(() => source.containerSetDrawDirty(1, 1), /boolean/u);
    assert.throws(() => source.itemSetDisplayCategory(id, 3), /string|name/u);
});

test('native player direction follows original f32 eight-way conversion without mutating actor state', async () => {
    const subject = await engine();
    const source = subject.sourceActions;

    for (const [x, y, expected] of [[0, -1, 'N'], [-1, -1, 'NW'], [-1, 0, 'W'], [-1, 1, 'SW'],
        [0, 1, 'S'], [1, 1, 'SE'], [1, 0, 'E'], [1, -1, 'NE']]) {
        const actor = subject.snapshot();

        source.face(actor.x + x, actor.y + y);
        const before = subject.saveState();

        assert.equal(source.playerDirection(), expected);
        assert.deepEqual(subject.saveState(), before);
    }
});

test('unwanted key derivation preserves exact player modData identity and refuses unavailable facilities', async () => {
    const subject = await engine();
    const source = subject.sourceActions;

    subject.registerItemDefinition(shoe('Fixture.MixedCase', { bodyLocation: null }), { owner: 'fixture' });
    const id = subject.command({ type: 'spawnItem', fullType: 'Fixture.MixedCase', x: 5, y: 5 }).id;

    assert.equal(source.itemUnwantedKey(id), 'itemUnwanted:Fixture.MixedCase');
    source.itemSetDisplayCategory(id, '');
    assert.equal(source.itemDisplayCategory(id), '');
    source.itemSetDisplayCategory(id, undefined);
    assert.equal(source.itemDisplayCategory(id), null);
    subject.registerItemDefinition(shoe('Fixture.Media', {
        bodyLocation: null, rawFields: [{ name: 'MediaCategory', value: 'VHS' }],
    }), { owner: 'fixture' });
    const media = subject.command({ type: 'spawnItem', fullType: 'Fixture.Media', x: 5, y: 5 }).id;

    assert.throws(() => source.itemUnwantedKey(media), /unsupported original facility/u);
});

test('original item leaf state keeps broken independent of condition and restores source load defaults', async () => {
    const subject = await engine();
    const source = subject.sourceActions;

    subject.registerItemDefinition(shoe('Fixture.Leaf', { type: 'Normal', bodyLocation: null }), { owner: 'fixture' });
    const id = subject.command({ type: 'spawnItem', fullType: 'Fixture.Leaf', x: 5, y: 5 }).id;

    assert.equal(source.itemIsBroken(id), false);
    assert.equal(source.itemHeat(id), 1);
    source.itemSetBroken(id, true);
    assert.equal(subject.getItem(id).condition, 30);
    assert.equal(source.itemIsBroken(id), true);
    source.itemSetHeat(id, 5);
    assert.equal(source.itemHeat(id), 3);
    source.itemSetHeat(id, -1);
    assert.equal(source.itemHeat(id), 0);
    source.itemSetHeat(id, 1.234);
    assert.equal(source.itemHeat(id), Math.fround(1.234));
    assert.throws(() => source.itemSetHeat(id, Number.NaN));
    assert.throws(() => source.itemSetBroken(id, 1));
    source.itemUpdateAge(id);
    subject.importInventoryGraph(subject.exportInventoryGraph());
    assert.equal(source.itemHeat(id), 1, 'original InventoryItem does not serialize itemHeat');
    assert.equal(source.itemIsBroken(id), false, 'load reconstructs broken from saved condition');
    subject.command({ type: 'setCondition', id, condition: 0 });
    assert.equal(source.itemIsBroken(id), true);
    source.itemSetBroken(id, false);
    assert.equal(source.itemIsBroken(id), false, 'isBroken never infers condition==0');
    subject.importInventoryGraph(subject.exportInventoryGraph());
    assert.equal(source.itemIsBroken(id), true);
});

test('clothing wetness owns native state, exact early returns, and versioned atomic persistence', async () => {
    const subject = await engine();
    const source = subject.sourceActions;

    subject.registerItemDefinition(shoe('Fixture.Dry', { type: 'Clothing' }), { owner: 'fixture' });
    subject.registerItemDefinition(shoe('Fixture.Blood', {
        type: 'Clothing', rawFields: [{ name: 'BloodLocation', value: 'Shoes' }],
    }), { owner: 'fixture' });
    subject.registerItemDefinition(shoe('Fixture.Normal', { type: 'Normal', bodyLocation: null }), { owner: 'fixture' });
    const id = subject.command({ type: 'spawnItem', fullType: 'Fixture.Dry', x: 5, y: 5 }).id;
    const blood = subject.command({ type: 'spawnItem', fullType: 'Fixture.Blood', x: 5, y: 5 }).id;
    const normal = subject.command({ type: 'spawnItem', fullType: 'Fixture.Normal', x: 5, y: 5 }).id;

    source.itemSetWetness(id, 120);
    assert.equal(source.itemWetness(id), 100);
    source.itemUpdateWetness(id);
    assert.equal(source.itemWetness(id), 0, 'factory null bloodClothingType clears unequipped wetness');
    source.itemSetWetness(id, -5);
    assert.equal(source.itemWetness(id), 0);
    const graph = subject.exportInventoryGraph();

    graph.items[0] = { ...graph.items[0], ownerContainerId: 1, worldPosition: null, bodyLocation: 'base:shoes', wetness: 42 };
    graph.wornOrder = [id];
    subject.importInventoryGraph(graph);
    source.itemUpdateWetness(id);
    assert.equal(source.itemWetness(id), 42, 'default update returns for equipped clothing before clearing null coverage');
    source.itemUpdateWetness(id, true);
    assert.equal(source.itemWetness(id), 0, 'forced update bypasses equipped early return');
    source.itemSetWetness(id, 12.5);
    const saved = subject.exportInventoryGraph();

    assert.equal(saved.version, 2);
    assert.equal(saved.items[0].wetness, 12.5);
    subject.importInventoryGraph(saved);
    assert.equal(source.itemWetness(id), 12.5);

    for (const mutate of [
        (copy) => {
            copy.version = 3;
        },
        (copy) => {
            copy.items[0].wetness = 100.000_000_1;
        },
        (copy) => {
            copy.items[0].wetness = '42';
        },
        (copy) => {
            delete copy.items[0].wetness;
        },
        (copy) => {
            delete copy.items[0].wetness;
            Object.setPrototypeOf(copy.items[0], { wetness: 42 });
        },
        (copy) => {
            copy.items[2].wetness = 1;
        },
    ]) {
        const invalid = structuredClone(saved);

        mutate(invalid);
        assert.throws(() => subject.importInventoryGraph(invalid));
        assert.deepEqual(subject.exportInventoryGraph(), saved);
    }

    const legacy = structuredClone(saved);

    legacy.version = 1;

    for (const row of legacy.items) {
        delete row.wetness;
    }

    subject.importInventoryGraph(legacy);
    assert.equal(source.itemWetness(id), 0, 'v1 migration uses real Clothing constructor wetness0');
    assert.throws(() => source.itemWetness(normal), /unsupported/u);
    source.itemUpdateWetness(blood);
    assert.equal(source.itemWetness(blood), 0, 'constructor timestamp makes the first call subminute');
});

test('clothing source timestamps accumulate, flush rebase and load resets without offline drying', async () => {
    const subject = await engine();
    const source = subject.sourceActions;
    const f = Math.fround;

    subject.importDoors([], {
        squares: [{
            x: 5, y: 5, z: 0, roomId: 7, outside: false, solid: false,
            solidTrans: false, tree: false, independentWalls: 0,
            reachWalls: { north: false, west: false }, vehicleObstructed: false, solidFloor: true,
            floorFlags: 1, stairTypes: 0, slopeDirection: 0, slopeMin: 0, slopeMax: 0,
        }],
    });
    subject.registerItemDefinition(shoe('Fixture.WetClock', {
        type: 'Clothing', rawFields: [{ name: 'BloodLocation', value: 'Shoes' }],
        tags: ['base:breakwhenwet'],
    }), { owner: 'fixture' });
    const id = subject.command({ type: 'spawnItem', fullType: 'Fixture.WetClock', x: 5, y: 5 }).id;

    source.itemSetWetness(id, 50);
    source.worldClockSet('timeOfDay', 9.01);
    source.itemUpdateWetness(id);
    assert.equal(source.itemWetness(id), 50, 'subminute queries accumulate from construction, not each call');
    source.worldClockSet('timeOfDay', 9.02);
    const firstAge = source.worldClockGet('worldAgeHours');

    source.itemUpdateWetness(id);
    const firstWetness = f(50 - f(f(firstAge - 2) * 20));

    assert.equal(source.itemWetness(id), firstWetness);
    source.worldClockSet('timeOfDay', 9.03);
    source.itemFlushWetness(id);
    assert.equal(source.itemWetness(id), firstWetness, 'flush retains the minutely gate');
    source.worldClockSet('timeOfDay', 9.1);
    source.itemUpdateWetness(id);
    assert.equal(source.itemWetness(id), firstWetness, 'negative flush stamp rebases to now');
    source.worldClockSet('timeOfDay', 9.131_25);
    source.itemUpdateWetness(id);
    assert.ok(source.itemWetness(id) < firstWetness);
    const saved = subject.exportInventoryGraph();
    const savedWetness = source.itemWetness(id);

    source.worldClockSet('nightsSurvived', 100);
    subject.importInventoryGraph(saved);
    source.itemUpdateWetness(id);
    assert.equal(source.itemWetness(id), savedWetness, 'load resets stamp at restored/current age');
    source.itemSetWetness(id, 100);
    source.itemUpdateWetness(id);
    assert.equal(subject.getItem(id).condition, 30, 'breaking waits until next eligible update');
    const wetOwner = subject.getItem(id).ownerContainerId;

    source.containerSetDrawDirty(wetOwner, false);
    source.worldClockSet('timeOfDay', 9.2);
    source.itemUpdateWetness(id);
    assert.equal(subject.getItem(id).condition, 0);
    assert.equal(source.itemIsBroken(id), true);
    assert.equal(source.containerDrawDirty(wetOwner), true, 'retained clothing break must invalidate its real container');
    assert.ok(source.itemWetness(id) < 100, 'breaking does not return before drying');
    const equipped = subject.exportInventoryGraph();

    equipped.items[0] = {
        ...equipped.items[0], condition: 30, ownerContainerId: 1,
        worldPosition: null, bodyLocation: 'base:shoes', wetness: 50,
    };
    equipped.wornOrder = [id];
    subject.importInventoryGraph(equipped);
    const lastAge = source.worldClockGet('worldAgeHours');

    source.worldClockSet('timeOfDay', 9.231_25);
    source.itemUpdateWetness(id);
    assert.equal(source.itemWetness(id), 50);
    const now = source.worldClockGet('worldAgeHours');

    source.itemUpdateWetness(id, true);
    assert.equal(source.itemWetness(id), f(50 - f(f(f(now - lastAge) * 20) * 2)));
    const beforeRebase = source.itemWetness(id);

    source.worldClockSet('timeOfDay', 8);
    source.itemUpdateWetness(id, true);
    assert.equal(source.itemWetness(id), beforeRebase, 'future timestamp corrects down without negative drying');
    subject.registerItemDefinition(shoe('Fixture.WetRemove', {
        type: 'Clothing', removeOnBroken: true,
        rawFields: [{ name: 'BloodLocation', value: 'Shoes' }], tags: ['base:breakwhenwet'],
    }), { owner: 'fixture' });
    const removed = subject.command({ type: 'spawnItem', fullType: 'Fixture.WetRemove', x: 5, y: 5 }).id;

    source.itemSetWetness(removed, 100);
    source.worldClockSet('timeOfDay', 8.031_25);
    source.itemUpdateWetness(removed);
    assert.equal(subject.getItem(removed), null, 'wet break keeps the authoritative removeOnBroken path');
    subject.registerItemDefinition(shoe('Fixture.WetCallback', {
        type: 'Clothing', onBreak: 'Fixture.OnBreak',
        rawFields: [{ name: 'BloodLocation', value: 'Shoes' }], tags: ['BreakWhenWet'],
    }), { owner: 'fixture' });
    const callback = subject.command({ type: 'spawnItem', fullType: 'Fixture.WetCallback', x: 5, y: 5 }).id;
    const callbackOwner = subject.getItem(callback).ownerContainerId;

    source.containerSetDrawDirty(callbackOwner, false);
    source.itemSetWetness(callback, 100);
    source.worldClockSet('timeOfDay', 8.062_5);
    assert.throws(() => source.itemUpdateWetness(callback), /unsupported/u);
    assert.equal(subject.getItem(callback).condition, 30);
    assert.equal(source.itemIsBroken(callback), false);
    assert.equal(source.itemWetness(callback), 100);
    assert.equal(source.containerDrawDirty(callbackOwner), false, 'callback refusal must precede break effects');
    subject.registerItemDefinition({ ...subject.getItemDefinition('Fixture.WetCallback'), onBreak: null },
        { owner: 'fixture', override: true });
    source.itemUpdateWetness(callback);
    assert.equal(subject.getItem(callback).condition, 30, 'refused break still advances its original wetness timestamp');
    source.worldClockSet('timeOfDay', 8.1);
    source.itemUpdateWetness(callback);
    assert.equal(subject.getItem(callback).condition, 0);
    assert.equal(source.containerDrawDirty(callbackOwner), true);
});

test('eligible outdoor and unknown-square clothing explicitly refuse actual missing climate authority', async () => {
    const subject = await engine();
    const source = subject.sourceActions;

    subject.registerItemDefinition(shoe('Fixture.WetOutside', {
        type: 'Clothing', rawFields: [{ name: 'BloodLocation', value: 'Shoes' }],
    }), { owner: 'fixture' });
    const id = subject.command({ type: 'spawnItem', fullType: 'Fixture.WetOutside', x: 5, y: 5 }).id;

    source.itemSetWetness(id, 50);
    source.worldClockSet('timeOfDay', 9.031_25);
    assert.throws(() => source.itemUpdateWetness(id), /roof and climate authority/u);
    assert.equal(source.itemWetness(id), 50);
    importPickupSquares(subject);
    source.worldClockSet('timeOfDay', 9.062_5);
    assert.throws(() => source.itemUpdateWetness(id), /roof and climate authority/u);
    assert.equal(source.itemWetness(id), 50, 'outside does not imply zero rain');
    const before = subject.worldClockState();

    subject.sourceTiming.setGameMode('LastStand');
    subject.step(0);
    const f = Math.fround;
    const delta = f(f(f(f(1 / 90) / 60) * f(0.8)) / 2);

    assert.equal(subject.worldClockState().timeOfDay, f(before.timeOfDay + delta),
        'GameMode LastStand is not the independent Core.lastStand flag');
});

test('native roof wire distinguishes unknown blocker authority from known source flags and preserves failed imports', async () => {
    const subject = await engine();
    const square = {
        x: 5, y: 5, z: 0, roomId: -1, outside: true, solid: false,
        solidTrans: false, tree: false, independentWalls: 0, vehicleObstructed: false, solidFloor: true,
    };

    subject.importDoors([], { squares: [square, { ...square, z: 1 }] });
    assert.equal(subject.getSquare(5, 5, 0).haveRoof, null, 'unknown upper flags are never decoded as no roof');
    assert.equal(subject.getSquare(5, 5, 1).haveRoof, false, 'a blocker does not roof itself');
    subject.importDoors([], { squares: [{ ...square, rainBlockers: 0 }, { ...square, z: 1, rainBlockers: 2 }] });
    assert.equal(subject.getSquare(5, 5, 0).haveRoof, true);
    assert.equal(subject.getSquare(5, 5, 1).haveRoof, false);

    for (const rainBlockers of [-1, 4, 0.5, null]) {
        assert.throws(() => subject.importDoors([], { squares: [{ ...square, rainBlockers }] }));
        assert.equal(subject.getSquare(5, 5, 0).haveRoof, true, 'boundary rejection preserves native metadata');
    }

    const partialBlockers = [0, 0, 0, 0];

    delete partialBlockers[1];

    for (const rainBlockers of [Array.from({ length: 4 }), partialBlockers]) {
        assert.throws(() => subject.importDoors([nativeDoor({
            id: 'door:5:5:1:0', x: 5, y: 5, z: 1, rainBlockers,
        })], {
            squares: [{ ...square, rainBlockers: 0 }, { ...square, z: 1, rainBlockers: 0 }],
        }), TypeError);
        assert.equal(subject.getSquare(5, 5, 0).haveRoof, true, 'missing door states cannot erase existing roof authority');
    }
});

test('pre-roof ABI1 geometry imports retain unknown authority and refuse explicit blocker fields', async () => {
    const subject = await createEngine(legacyModule(moduleBytes,
        ['door_import_rain_blockers_version', 'door_import_rain_blockers']));
    const square = {
        x: 5, y: 5, z: 0, roomId: -1, outside: true, solid: false,
        solidTrans: false, tree: false, independentWalls: 0, vehicleObstructed: false, solidFloor: true,
    };

    subject.importDoors([], { squares: [square, { ...square, z: 1 }] });
    assert.equal(subject.getSquare(5, 5, 0).haveRoof, null, 'legacy reserved zero cannot invent no upper blocker');
    assert.throws(() => subject.importDoors([], { squares: [{ ...square, rainBlockers: 0 }] }), /unsupported/iu);
    assert.throws(() => subject.importDoors([nativeDoor({ rainBlockers: [0, 0, 0, 0] })], {
        squares: [square],
    }), /unsupported/iu);
    assert.equal(subject.getSquare(5, 5, 0).haveRoof, null, 'capability refusal precedes replacement');
});
