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
