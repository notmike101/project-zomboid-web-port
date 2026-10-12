/**
 * @file Mod host tests against the real compiled WASM engine.
 *
 * Fixtures are tiny ES modules imported from `data:` URLs so they are real
 * modules with real manifests; the multi-file fixture is the shipped
 * `mods/accessible-walking` sample, which imports `./settings.js`.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createEngine } from '../src/engine.js';
import { createModHost, MOD_API_VERSION } from '../src/mods.js';

const wasmUrl = new URL('../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url);
const sampleUrl = new URL('../mods/accessible-walking/main.js', import.meta.url).href;
const STEP = 1 / 60;

/**
 * Shared scratch state that `data:` fixtures can reach. `unhandled` collects
 * every rejection that reached the process unhandled; a mod must never leave
 * one, because it would take down the Node consumer running it.
 *
 * @type {{ order: string[], cleanup: string[], api: object|undefined, seen: string[], result: object[], errors: string[], unhandled: unknown[] }}
 */
const fx = { order: [], cleanup: [], api: undefined, seen: [], result: [], errors: [], unhandled: [] };

globalThis.fx = fx;
globalThis.assert = assert;

process.on('unhandledRejection', (reason) => {
    fx.unhandled.push(reason);
});

/**
 * Builds an importable module URL from source.
 *
 * @param {string} source - Module source.
 * @returns {string} `data:` module URL.
 */
function moduleUrl(source) {
    return `data:text/javascript,${encodeURIComponent(source)}`;
}

/**
 * Manifest prelude for a fixture.
 *
 * @param {string} id - Fixture mod id.
 * @returns {string} Module source prefix.
 */
function manifestSource(id) {
    return `export const manifest = { id: '${id}', version: '0.1.0', apiVersion: '0.1.0', name: 'Fixture ${id}' };\n`;
}

/**
 * Creates an engine from the real build artifact, failing loudly if it is absent.
 *
 * @returns {Promise<object>} Engine wrapper.
 */
async function newEngine() {
    try {
        return await createEngine(await readFile(wasmUrl));
    } catch (cause) {
        throw new Error(`tests need engine/target/wasm32-unknown-unknown/release/pz_engine.wasm; run npm run build first (${cause.message})`);
    }
}

/**
 * Advances the engine in fixed steps.
 *
 * @param {object} engine - Engine wrapper.
 * @param {number} steps - Step count.
 * @returns {void}
 */
function step(engine, steps) {
    for (let index = 0; index < steps; index += 1) {
        engine.step(STEP);
    }
}

test('built-in multifile sample changes real WASM displacement and cleans up', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    host.command({ type: 'moveTo', x: 9, y: 5 });
    step(engine, 20);
    const baseTravel = engine.snapshot().x - 5;

    assert.ok(Math.abs(baseTravel - 0.5) < 1e-4, `base travel ${baseTravel}`);

    const identity = await host.load(sampleUrl);

    assert.deepEqual(identity, { id: 'accessible-walking', version: '0.1.0', name: 'Accessible walking' });
    assert.equal(engine.snapshot().speed, 2.25);
    host.command({ type: 'moveTo', x: 9, y: 5 });
    step(engine, 20);
    const moddedTravel = engine.snapshot().x - (5 + baseTravel);

    assert.ok(Math.abs(moddedTravel - 0.75) < 1e-4, `modded travel ${moddedTravel}`);
    assert.ok(moddedTravel > baseTravel);

    host.dispose();
    assert.equal(engine.snapshot().speed, 1.5);
    host.command({ type: 'moveTo', x: 9, y: 5 });
    step(engine, 20);
    const restoredTravel = engine.snapshot().x - (5 + baseTravel + moddedTravel);

    assert.ok(Math.abs(restoredTravel - baseTravel) < 1e-4, `restored travel ${restoredTravel}`);
    assert.deepEqual(host.diagnostics().mods, []);
    assert.deepEqual(host.diagnostics().errors, []);
});

test('sample cleanup preserves the previous speed instead of assuming the base', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    engine.setSpeed(3.75);
    await host.load(sampleUrl);
    assert.equal(engine.snapshot().speed, 2.25);
    host.dispose();
    assert.equal(engine.snapshot().speed, 3.75);
});

test('snapshots report numeric action 0 idle, 1 destination, 2 walking', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    assert.deepEqual([host.api.movement.getState().action, engine.snapshot().action], [0, 0]);
    assert.equal(host.command({ type: 'moveTo', x: 8, y: 8 }).snapshot.action, 1);
    assert.equal(host.command({ type: 'walk', x: 1, y: 0 }).snapshot.action, 2);
    assert.equal(host.command({ type: 'cancel' }).snapshot.action, 0);
    const detached = host.api.movement.getState();

    detached.x = 0;
    detached.speed = 0;
    assert.equal(host.api.movement.getState().x, 5);
    assert.equal(host.api.movement.getState().speed, 1.5);
    assert.equal(host.api.version, MOD_API_VERSION);
});

test('hooks run in ascending priority then registration order', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    fx.order = [];
    await host.load(moduleUrl(`${manifestSource('fx-order')}
export function activate(api) {
  api.hooks.beforeAction(() => { fx.order.push('zero-first'); });
  api.hooks.beforeAction(() => { fx.order.push('high'); }, { priority: 5 });
  api.hooks.beforeAction(() => { fx.order.push('low'); }, { priority: -1 });
  api.hooks.beforeAction(() => { fx.order.push('zero-second'); });
}`));
    assert.equal(host.command({ type: 'moveTo', x: 6, y: 6 }).committed, true);
    assert.deepEqual(fx.order, ['low', 'zero-first', 'zero-second', 'high']);
    assert.equal(host.diagnostics().hookCount, 4);
});

test('a hook at any priority cancels; later replacements cannot overturn the veto', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    await host.load(moduleUrl(`${manifestSource('fx-a')}
export function activate(api) {
  api.hooks.beforeAction(() => ({ type: 'moveTo', x: 0, y: 0 }), { priority: -10 });
  api.hooks.beforeAction(() => false, { priority: 10 });
}`));
    await host.load(moduleUrl(`${manifestSource('fx-b')}
export function activate(api) {
  api.hooks.beforeAction(() => false, { priority: -10 });
  api.hooks.beforeAction(() => ({ type: 'moveTo', x: 1, y: 1 }), { priority: 10 });
}`));
    const result = host.command({ type: 'moveTo', x: 9, y: 9 });

    assert.deepEqual([result.committed, result.cancelled, result.cancelledBy], [false, true, 'fx-b']);
    assert.deepEqual(result.modifiedBy, ['fx-a', 'fx-b']);
    assert.deepEqual([engine.snapshot().x, engine.snapshot().y, engine.snapshot().action], [5, 5, 0]);
    step(engine, 60);
    assert.deepEqual([engine.snapshot().x, engine.snapshot().y], [5, 5]);
    assert.deepEqual(host.diagnostics().counts, { commands: 1, committed: 0, cancelled: 1, modified: 0, modSubmitted: 0 });
});

test('Stop/Escape cancellation bypasses hooks and cannot be vetoed', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    fx.seen = [];
    await host.load(moduleUrl(`${manifestSource('fx-block')}
export function activate(api) {
  api.hooks.beforeAction((action) => { fx.seen.push(action.type); return false; });
}`));
    assert.equal(host.command({ type: 'walk', x: 0, y: 1 }).committed, false);
    assert.equal(host.command({ type: 'walk', x: 1, y: 0 }).cancelled, true);
    engine.command({ type: 'walk', x: 1, y: 0 });
    assert.equal(engine.snapshot().action, 2);
    const stop = host.command({ type: 'cancel' });

    assert.deepEqual([stop.committed, stop.cancelled, stop.snapshot.action], [true, false, 0]);
    assert.deepEqual(fx.seen, ['walk', 'walk'], 'the veto hook never sees an explicit cancel');
});

test('a hook returning a promise is rejected before commit and attributed', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    await host.load(moduleUrl(`${manifestSource('fx-promise')}
export function activate(api) {
  api.hooks.beforeAction((action) => Promise.resolve({ type: 'moveTo', x: 0, y: 0 }));
  api.hooks.beforeAction(() => Promise.reject(new Error('decided too late')));
}`));
    const result = host.command({ type: 'moveTo', x: 9, y: 5 });

    assert.equal(result.committed, true);
    step(engine, 60);
    assert.ok(engine.snapshot().x > 6, `committed the original command, reached ${engine.snapshot().x}`);
    await new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
    const stages = host.diagnostics().errors.map((failure) => [failure.modId, failure.stage]);

    assert.deepEqual(stages, [['fx-promise', 'beforeAction'], ['fx-promise', 'beforeAction'], ['fx-promise', 'beforeAction.late']]);
});

test('invalid replacements and throwing hooks are attributed, the command still commits', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    await host.load(moduleUrl(`${manifestSource('fx-bad')}
export function activate(api) {
  api.hooks.beforeAction(() => ({ type: 'moveTo', x: 999, y: 0 }));
  api.hooks.beforeAction(() => ({ type: 'leap' }));
  api.hooks.beforeAction(() => { throw new Error('hook crashed'); });
  api.hooks.beforeAction(() => 'not a command');
}`));
    const result = host.command({ type: 'moveTo', x: 8, y: 5 });

    assert.deepEqual([result.committed, result.modifiedBy], [true, []]);
    step(engine, 30);
    assert.ok(Math.abs(engine.snapshot().x - 5.75) < 1e-3, `reached ${engine.snapshot().x}`);
    assert.deepEqual(host.diagnostics().errors.map((failure) => [failure.modId, failure.stage]), [
        ['fx-bad', 'beforeAction'],
        ['fx-bad', 'beforeAction'],
        ['fx-bad', 'beforeAction'],
        ['fx-bad', 'beforeAction'],
    ]);
});

test('hooks receive a detached command they cannot mutate', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    await host.load(moduleUrl(`${manifestSource('fx-tamper')}
export function activate(api) {
  api.hooks.beforeAction((action) => { action.x = 0; action.y = 0; });
}`));
    const pending = { type: 'moveTo', x: 9, y: 5 };

    host.command(pending);
    assert.deepEqual([pending.x, pending.y], [9, 5]);
    step(engine, 60);
    assert.ok(engine.snapshot().x > 6, `reached ${engine.snapshot().x}`);
});

test('duplicate ids and malformed manifests are rejected', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    assert.equal(MOD_API_VERSION, '0.1.0');
    await host.load(sampleUrl);
    await assert.rejects(() => host.load(sampleUrl), { name: 'ModError', modId: 'accessible-walking', stage: 'manifest' });
    await assert.rejects(() => host.load(moduleUrl(`export const manifest = { id: 'Bad ID', version: '0.1.0', apiVersion: '0.1.0', name: 'x' };\nexport function activate() {}`)), { name: 'ModError', stage: 'manifest' });
    await assert.rejects(() => host.load(moduleUrl(`export const manifest = { id: 'host', version: '0.1.0', apiVersion: '0.1.0', name: 'x' };\nexport function activate() {}`)), { name: 'ModError', modId: 'host', stage: 'manifest' });
    await assert.rejects(() => host.load(moduleUrl(`export const manifest = { id: 'fx-ver', version: '1', apiVersion: '0.1.0', name: 'x' };\nexport function activate() {}`)), { name: 'ModError', modId: 'fx-ver', stage: 'manifest' });
    await assert.rejects(() => host.load(moduleUrl(`export const manifest = { id: 'fx-api', version: '0.1.0', apiVersion: '9.9.9', name: 'x' };\nexport function activate() {}`)), { name: 'ModError', modId: 'fx-api', stage: 'manifest' });
    await assert.rejects(() => host.load(moduleUrl(`export const manifest = { id: 'fx-name', version: '0.1.0', apiVersion: '0.1.0', name: '  ' };\nexport function activate() {}`)), { name: 'ModError', modId: 'fx-name', stage: 'manifest' });
    await assert.rejects(() => host.load(moduleUrl('export function activate() {}')), { name: 'ModError', stage: 'manifest' });
    await assert.rejects(() => host.load(moduleUrl('export const manifest = { id: \'fx-noactivate\', version: \'0.1.0\', apiVersion: \'0.1.0\', name: \'x\' };')), { name: 'ModError', modId: 'fx-noactivate', stage: 'manifest' });
    const brokenUrl = moduleUrl('export const manifest = { id: \'fx-broken\';');

    await assert.rejects(() => host.load(brokenUrl), { name: 'ModError', stage: 'load' });
    assert.equal(host.diagnostics().errors.at(-1).stage, 'load');
    assert.equal(host.diagnostics().errors.at(-1).modId, brokenUrl);
    assert.ok(host.diagnostics().errors.some((failure) => failure.modId === 'accessible-walking' && failure.stage === 'manifest'));
    assert.deepEqual(host.diagnostics().mods.map((mod) => mod.id), ['accessible-walking']);
});

test('failed activation leaves no hooks and restores the speed', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    fx.order = [];
    await assert.rejects(
        () => host.load(moduleUrl(`${manifestSource('fx-boom')}
export function activate(api) {
  api.movement.setSpeed(6);
  api.hooks.beforeAction(() => { fx.order.push('boom'); });
  throw new Error('activation exploded');
}`)),
        { name: 'ModError', modId: 'fx-boom', stage: 'activate' },
    );
    assert.equal(engine.snapshot().speed, 1.5);
    assert.equal(host.diagnostics().hookCount, 0);
    assert.deepEqual(host.diagnostics().mods, []);
    host.command({ type: 'moveTo', x: 7, y: 5 });
    assert.deepEqual(fx.order, []);
    assert.equal(engine.snapshot().action, 1);
});

test('a cleanup that throws is attributed but other mods still clean up, last in first out', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    fx.cleanup = [];
    await host.load(moduleUrl(`${manifestSource('fx-first')}
export function activate(api) {
  api.movement.setSpeed(3);
  return () => { fx.cleanup.push('first'); api.movement.setSpeed(1.5); };
}`));
    await host.load(moduleUrl(`${manifestSource('fx-second')}
export function activate(api) {
  api.movement.setSpeed(8);
  api.hooks.beforeAction(() => false);
  return () => { fx.cleanup.push('second'); throw new Error('cleanup exploded'); };
}`));
    assert.equal(engine.snapshot().speed, 8);
    host.dispose();
    assert.deepEqual(fx.cleanup, ['second', 'first']);
    assert.equal(engine.snapshot().speed, 1.5);
    assert.deepEqual(host.diagnostics().errors.map((failure) => [failure.modId, failure.stage]), [['fx-second', 'cleanup']]);
    const result = host.command({ type: 'moveTo', x: 7, y: 5 });

    assert.equal(result.committed, true);
    host.dispose();
});

test('unloaded API handles cannot mutate the engine', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    fx.cleanup = [];
    await host.load(moduleUrl(`${manifestSource('fx-hold')}
export function activate(api) {
  globalThis.fx.api = api;
  api.movement.setSpeed(9);
  return () => { fx.cleanup.push('hold'); api.movement.setSpeed(1.5); };
}`));
    const captured = fx.api;

    assert.equal(engine.snapshot().speed, 9);
    host.dispose();
    assert.deepEqual(fx.cleanup, ['hold']);
    assert.equal(engine.snapshot().speed, 1.5);
    assert.throws(() => captured.movement.setSpeed(9), { name: 'ModError', modId: 'fx-hold', stage: 'api' });
    assert.throws(() => captured.movement.getState(), { name: 'ModError', modId: 'fx-hold', stage: 'api' });
    assert.throws(() => captured.actions.submit({ type: 'moveTo', x: 1, y: 1 }), { name: 'ModError', modId: 'fx-hold', stage: 'api' });
    assert.throws(() => captured.hooks.beforeAction(() => false), { name: 'ModError', modId: 'fx-hold', stage: 'api' });
    assert.throws(() => captured.hooks.beforeAction(() => false, { priority: Number.NaN }), { name: 'ModError', modId: 'fx-hold', stage: 'api' });
    assert.equal(engine.snapshot().speed, 1.5);
    assert.equal(engine.snapshot().action, 0);
    assert.deepEqual(host.diagnostics().mods, []);
    assert.equal(captured.version, MOD_API_VERSION);
});

test('a mod-submitted action runs the same hooks as host input and keeps its attribution', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    fx.result = [];
    await host.load(moduleUrl(`${manifestSource('fx-rewrite')}
export function activate(api) {
  api.hooks.beforeAction((action) => action.type === 'moveTo' ? { type: 'moveTo', x: 9, y: 5 } : action, { priority: -1 });
}`));
    await host.load(moduleUrl(`${manifestSource('fx-submit')}
export function activate(api) {
  fx.result.push(api.actions.submit({ type: 'moveTo', x: 0, y: 0 }));
}`));
    assert.deepEqual([fx.result[0].committed, fx.result[0].cancelled, fx.result[0].submittedBy, fx.result[0].modifiedBy], [true, false, 'fx-submit', ['fx-rewrite']]);
    assert.equal(engine.snapshot().action, 1);
    step(engine, 60);
    assert.ok(engine.snapshot().x > 5.5, `moved toward the replacement destination, reached ${engine.snapshot().x}`);
    assert.deepEqual(host.diagnostics().counts, { commands: 1, committed: 1, cancelled: 0, modified: 1, modSubmitted: 1 });
});

test('a mod-submitted action can be vetoed, while a submitted cancel still bypasses hooks', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    fx.result = [];
    await host.load(moduleUrl(`${manifestSource('fx-veto')}
export function activate(api) {
  api.hooks.beforeAction(() => false);
}`));
    await host.load(moduleUrl(`${manifestSource('fx-sub-vetoed')}
export function activate(api) {
  fx.result.push(api.actions.submit({ type: 'moveTo', x: 9, y: 5 }));
  fx.result.push(api.actions.submit({ type: 'cancel' }));
}`));
    assert.deepEqual([fx.result[0].committed, fx.result[0].cancelled, fx.result[0].cancelledBy, fx.result[0].submittedBy], [false, true, 'fx-veto', 'fx-sub-vetoed']);
    assert.deepEqual([fx.result[1].committed, fx.result[1].cancelled], [true, false]);
    assert.deepEqual([engine.snapshot().x, engine.snapshot().y, engine.snapshot().action], [5, 5, 0]);
    step(engine, 60);
    assert.deepEqual([engine.snapshot().x, engine.snapshot().y], [5, 5]);
});

test('a submission while hooks are resolving is rejected and cannot change state', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    fx.errors = [];
    await host.load(moduleUrl(`${manifestSource('fx-reenter')}
export function activate(api) {
  api.hooks.beforeAction((action) => {
    try {
      api.actions.submit({ type: 'moveTo', x: 9, y: 5 });
      fx.errors.push('did not throw');
    } catch (cause) {
      fx.errors.push([cause.name, cause.modId, cause.stage].join('|'));
    }
    return false;
  });
}`));
    const result = host.command({ type: 'walk', x: 1, y: 0 });

    assert.deepEqual([result.committed, result.cancelled, result.cancelledBy, result.submittedBy], [false, true, 'fx-reenter', 'host']);
    assert.deepEqual(fx.errors, ['ModError|fx-reenter|action']);
    assert.deepEqual([engine.snapshot().x, engine.snapshot().y, engine.snapshot().action], [5, 5, 0]);
    step(engine, 60);
    assert.deepEqual([engine.snapshot().x, engine.snapshot().y], [5, 5]);
    assert.deepEqual(host.diagnostics().counts, { commands: 1, committed: 0, cancelled: 1, modified: 0, modSubmitted: 0 });
});

test('the host-side handle reads and writes the engine with the same validation', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    host.api.movement.setSpeed(4);
    assert.equal(engine.snapshot().speed, 4);
    assert.throws(() => host.api.movement.setSpeed(0), { name: 'ModError', modId: 'host', stage: 'movement' });
    assert.throws(() => host.api.movement.setSpeed('fast'), { name: 'ModError', modId: 'host', stage: 'movement' });
    assert.equal(engine.snapshot().speed, 4);
});

test('host input is validated before any hook or commit', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    assert.throws(() => host.command({ type: 'moveTo', x: Number.NaN, y: 0 }), { name: 'ModError', modId: 'host', stage: 'action' });
    assert.throws(() => host.command({ type: 'moveTo', x: 1, y: 11 }), { name: 'ModError', modId: 'host', stage: 'action' });
    assert.throws(() => host.command({ type: 'leap' }), { name: 'ModError', modId: 'host', stage: 'action' });
    assert.throws(() => host.command(null), { name: 'ModError', modId: 'host', stage: 'action' });
    assert.deepEqual([engine.snapshot().x, engine.snapshot().action], [5, 0]);
    assert.equal(host.diagnostics().counts.commands, 0);
});

test('priority options and hook callbacks are validated', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    await host.load(moduleUrl(`${manifestSource('fx-hooks')}
export function activate(api) {
  assert.throws(() => api.hooks.beforeAction('nope'), { name: 'ModError', modId: 'fx-hooks', stage: 'hooks' });
  assert.throws(() => api.hooks.beforeAction(() => {}, { priority: 'first' }), { name: 'ModError', modId: 'fx-hooks', stage: 'hooks' });
  const unsubscribe = api.hooks.beforeAction(() => false);
  assert.equal(api.hooks.beforeAction(() => false).length, 0);
  assert.equal(unsubscribe(), true);
  assert.equal(unsubscribe(), false);
}`));
    assert.equal(host.diagnostics().hookCount, 1);
    assert.equal(host.command({ type: 'moveTo', x: 6, y: 6 }).cancelled, true);
});

test('host and mod actions accept signed directions without weakening destination bounds', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    host.command({ type: 'walk', x: -1, y: -1 });
    step(engine, 1);
    assert.ok(engine.snapshot().x < 5 && engine.snapshot().y < 5);
    host.command({ type: 'cancel' });
    const before = engine.snapshot();

    host.api.actions.submit({ type: 'walk', x: -1, y: 0 });
    step(engine, 1);
    assert.ok(engine.snapshot().x < before.x);
    assert.equal(engine.snapshot().y, before.y);
    assert.throws(() => host.api.actions.submit({ type: 'moveTo', x: -1, y: 0 }), { name: 'ModError', stage: 'action' });
});

test('a hook unsubscribed during the same dispatch never runs', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    await host.load(moduleUrl(`${manifestSource('fx-drop')}
export function activate(api) {
  const veto = api.hooks.beforeAction(() => false, { priority: 10 });
  api.hooks.beforeAction(() => { veto(); }, { priority: -10 });
}`));
    const result = host.command({ type: 'moveTo', x: 9, y: 5 });

    assert.deepEqual([result.committed, result.cancelled, result.cancelledBy], [true, false, undefined]);
    assert.equal(host.diagnostics().hookCount, 1);
    assert.deepEqual(host.diagnostics().errors, []);
    step(engine, 60);
    assert.ok(engine.snapshot().x > 6, `the withdrawn veto never ran, reached ${engine.snapshot().x}`);
});

test('dispose inside a host hook withdraws every remaining mod hook', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    fx.cleanup = [];
    await host.load(moduleUrl(`${manifestSource('fx-dispose')}
export function activate(api) {
  api.hooks.beforeAction(() => false);
  return () => { fx.cleanup.push('dispose'); };
}`));
    host.api.hooks.beforeAction(() => {
        host.dispose();
    }, { priority: -10 });
    const result = host.command({ type: 'moveTo', x: 9, y: 5 });

    assert.deepEqual([result.committed, result.cancelled], [true, false]);
    assert.deepEqual(fx.cleanup, ['dispose']);
    assert.deepEqual([host.diagnostics().hookCount, host.diagnostics().mods.length], [0, 0]);
    assert.deepEqual(host.diagnostics().errors, []);
    step(engine, 60);
    assert.ok(engine.snapshot().x > 6, `the unloaded veto never ran, reached ${engine.snapshot().x}`);
});

test('a hook result with a throwing then getter keeps the previous action and is attributed', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    await host.load(moduleUrl(`${manifestSource('fx-then')}
export function activate(api) {
  api.hooks.beforeAction(() => ({ type: 'walk', x: 1, y: 0 }), { priority: -10 });
  api.hooks.beforeAction(() => ({ get then() { throw new Error('getter exploded'); } }), { priority: 10 });
}`));
    const result = host.command({ type: 'moveTo', x: 9, y: 5 });

    assert.deepEqual([result.committed, result.cancelled, result.modifiedBy], [true, false, ['fx-then']]);
    assert.equal(result.snapshot.action, 2, 'the earlier replacement still commits');
    step(engine, 30);
    assert.ok(engine.snapshot().x > 5.5, `committed the walking replacement, reached ${engine.snapshot().x}`);
    assert.deepEqual(
        host.diagnostics().errors.map((failure) => [failure.modId, failure.stage, failure.message]),
        [['fx-then', 'beforeAction', 'getter exploded']],
    );
});

test('an async activate that rejects is rolled back, attributed and never unhandled', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    await assert.rejects(
        () => host.load(moduleUrl(`${manifestSource('fx-async')}
export async function activate(api) {
  api.movement.setSpeed(7);
  api.hooks.beforeAction(() => false);
  throw new Error('activation exploded asynchronously');
}`)),
        { name: 'ModError', modId: 'fx-async', stage: 'activate' },
    );
    await new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
    assert.equal(engine.snapshot().speed, 1.5, 'the speed the async activation set is restored');
    assert.equal(host.diagnostics().hookCount, 0);
    assert.deepEqual(host.diagnostics().mods, []);
    assert.equal(host.command({ type: 'moveTo', x: 7, y: 5 }).committed, true);
    assert.deepEqual(
        host.diagnostics().errors.map((failure) => [failure.modId, failure.stage]),
        [['fx-async', 'activate'], ['fx-async', 'activate.late']],
    );
    assert.equal(host.diagnostics().errors.at(-1).message, 'activation exploded asynchronously');
    assert.deepEqual(fx.unhandled, [], 'the rejected promise was observed by the host');
});

test('a cleanup returning a rejected promise is reported, observed and still unloads', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    fx.cleanup = [];
    await host.load(moduleUrl(`${manifestSource('fx-async-cleanup')}
export function activate(api) {
  api.hooks.beforeAction(() => false);
  return async () => { fx.cleanup.push('late'); throw new Error('cleanup exploded asynchronously'); };
}`));
    assert.equal(host.command({ type: 'moveTo', x: 7, y: 5 }).cancelled, true);
    host.dispose();
    await new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
    assert.deepEqual(fx.cleanup, ['late']);
    assert.deepEqual(host.diagnostics().mods, []);
    assert.equal(host.diagnostics().hookCount, 0);
    assert.equal(host.command({ type: 'moveTo', x: 7, y: 5 }).committed, true);
    assert.deepEqual(
        host.diagnostics().errors.map((failure) => [failure.modId, failure.stage]),
        [['fx-async-cleanup', 'cleanup'], ['fx-async-cleanup', 'cleanup.late']],
    );
    assert.deepEqual(fx.unhandled, [], 'the rejected cleanup promise was observed by the host');
});
