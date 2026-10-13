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

/**
 * Real cell format: open records except one solid tile in the first 8x8 chunk.
 *
 * @returns {Uint8Array} Independently authored navigation cell.
 */
function navigationCell() {
    const bytes = new Uint8Array(1_090);

    bytes[1] = 1;
    bytes[2] = 2;
    bytes[3 + 5 * 8 + 6] = 1;

    return bytes;
}

test('public navigation imports cancel movement and change authoritative collision', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    host.command({ type: 'walk', x: 1, y: 0 });
    const bytes = navigationCell();
    const result = host.api.world.importNavigationCell(0, 0, bytes);

    assert.equal(result.committed, true);
    assert.equal(engine.snapshot().action, 0);
    assert.equal(host.api.world.getNavFlags(6, 5), 1);
    assert.equal(host.api.world.getNavFlags(256, 0), 0xFF_FF_FF_FF);
    bytes.fill(0);
    assert.equal(host.api.world.getNavFlags(6, 5), 1);
    const bounds = host.api.world.getBounds();

    assert.deepEqual(bounds, { active: true, minCx: 0, minCy: 0, maxCx: 0, maxCy: 0, cells: 1 });
    bounds.cells = 50;
    assert.equal(host.api.world.getBounds().cells, 1);
    assert.throws(() => host.api.actions.submit({ type: 'moveTo', x: 6.5, y: 5.5 }));
    const beforeBlockedHeading = engine.saveState();

    assert.throws(() => host.api.actions.submit({ type: 'walk', x: 1, y: 0 }));
    assert.deepEqual(engine.saveState(), beforeBlockedHeading, 'the one-unit heading probe refuses without mutation');
    host.api.actions.submit({ type: 'walk', x: -1, y: 0 });

    for (let tick = 0; tick < 60; tick += 1) {
        host.step(STEP);
    }

    const approachStart = engine.snapshot().x;

    host.api.actions.submit({ type: 'walk', x: 1, y: 0 });

    for (let tick = 0; tick < 120; tick += 1) {
        host.step(STEP);
    }

    assert.ok(engine.snapshot().x < 6, 'solid tile must stop the actor');
    assert.ok(engine.snapshot().x > approachStart, 'the accepted approach must advance before hitting the solid tile');
    assert.equal(engine.snapshot().action, 0, 'collision ends the accepted heading');
    host.api.actions.submit({ type: 'moveTo', x: 12, y: 5 });
    assert.equal(engine.snapshot().action, 1, 'active world destinations are not limited to the original room');
    assert.throws(() => host.api.world.getNavFlags(0.25, 0), { stage: 'world' });
    assert.throws(() => host.api.world.getNavFlags(2_147_483_648, 0), { stage: 'world' });
});

test('world import veto and malformed bytes preserve world and in-flight movement', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    host.api.world.importNavigationCell(0, 0, navigationCell());
    host.command({ type: 'walk', x: -1, y: 0 });
    const before = engine.saveState();
    let calls = 0;

    host.api.hooks.beforeWorldImport((payload) => {
        calls += 1;
        assert.deepEqual([payload.cx, payload.cy], [1, -1]);
        payload.bytes.fill(0);
        assert.throws(() => host.api.world.importNavigationCell(0, 0, navigationCell()), { stage: 'world' });
        assert.throws(() => host.command({ type: 'cancel' }), { stage: 'action' });
        assert.throws(() => host.step(STEP), { stage: 'tick' });

        return false;
    }, { priority: -1 });
    host.api.hooks.beforeWorldImport((payload) => {
        assert.equal(payload.bytes[1], 1, 'each hook receives its own bytes');
    });
    const veto = host.api.world.importNavigationCell(1, -1, navigationCell());

    assert.deepEqual([veto.committed, veto.cancelled, veto.cancelledBy], [false, true, 'host']);
    assert.deepEqual(engine.saveState(), before);
    assert.equal(host.api.world.getBounds().cells, 1);
    assert.throws(() => host.api.world.importNavigationCell(1, -1, new Uint8Array([0, 1])), { stage: 'world' });
    assert.throws(() => host.api.world.importNavigationCell(101, 0, navigationCell()), { stage: 'world' });
    assert.equal(calls, 1, 'invalid input never dispatches hooks');
    assert.deepEqual(engine.saveState(), before);
    host.dispose();
    assert.equal(host.api.world.importNavigationCell(1, -1, navigationCell()).committed, true);
    assert.equal(host.api.world.getNavFlags(262, -251), 1);
});

test('world import callback failures are attributed and cannot defer or corrupt a commit', async () => {
    const host = createModHost(await newEngine());

    await host.load(moduleUrl(`${manifestSource('fx-world-async')}
export function activate(api) {
  api.hooks.beforeWorldImport(async () => { throw new Error('late import failure'); });
  api.hooks.beforeWorldImport(() => { throw new Error('import failure'); });
}`));
    assert.equal(host.api.world.importNavigationCell(0, 0, navigationCell()).committed, true);
    assert.equal(host.api.world.getNavFlags(6, 5), 1);
    await new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
    assert.deepEqual(host.diagnostics().errors.map(({ modId, stage }) => [modId, stage]), [
        ['fx-world-async', 'beforeWorldImport'], ['fx-world-async', 'beforeWorldImport'],
        ['fx-world-async', 'beforeWorldImport.late'],
    ]);
    assert.deepEqual(fx.unhandled, []);
});

test('save documents stay detached and id-namespaced across host reload and synchronous migration', async () => {
    const records = new Map([['missing-mod', { opaque: ['retain', 7] }]]);
    const backing = {
        /**
         * Read one saved namespace from the shared test backing.
         *
         * @param {string} id - Namespace owner.
         * @returns {object|undefined} Stored record, or absence.
         */
        readModState: (id) => records.get(id),
        /**
         * Replace one namespace in the shared test backing.
         *
         * @param {string} id - Namespace owner.
         * @param {import('../types/mod-api').ModSaveRecord} record - Detached namespace record.
         */
        writeModState: (id, record) => {
            records.set(id, record);
        },
    };
    const host = createModHost(await newEngine(), backing);

    fx.result = [];
    const oldUrl = moduleUrl(`${manifestSource('fx-save-a')}
export function activate(api) { fx.result.push(api); }`);

    await host.load(oldUrl);
    await host.load(moduleUrl(`${manifestSource('fx-save-b')}
export function activate(api) { fx.result.push(api); }`));
    const [a, b] = fx.result;

    assert.equal(a.saveData.read(), undefined);
    const document = { score: 4, nested: [1, { label: 'a' }] };

    a.saveData.write(document);
    b.saveData.write({ score: 90 });
    document.nested[1].label = 'changed';
    const read = a.saveData.read();

    read.nested[1].label = 'also changed';
    assert.equal(a.saveData.read().nested[1].label, 'a');
    assert.equal(b.saveData.read().score, 90);
    host.dispose();
    assert.throws(() => a.saveData.read(), { stage: 'api' });
    const reloaded = createModHost(await newEngine(), backing);
    const migratedUrl = moduleUrl(`${manifestSource('fx-save-a')}
manifest.saveSchemaVersion = 2;
export function migrateSaveData(oldVersion, data) {
  assert.equal(oldVersion, 1);
  data.score += 6;
  return { points: data.score };
}
export function activate(api) { fx.api = api; }`);

    await reloaded.load(migratedUrl);
    assert.deepEqual(fx.api.saveData.read(), { points: 10 });
    assert.deepEqual(records.get('fx-save-a'), { schemaVersion: 2, data: { points: 10 } });
    assert.deepEqual(records.get('missing-mod'), { opaque: ['retain', 7] });
    const migrated = records.get('fx-save-a');

    records.set('fx-save-a', { schemaVersion: 99, data: { opaque: 'external save' } });
    assert.throws(() => fx.api.saveData.read(), { stage: 'saveData' });
    assert.throws(() => fx.api.saveData.write({ overwritten: true }), { stage: 'saveData' });
    assert.deepEqual(records.get('fx-save-a'), { schemaVersion: 99, data: { opaque: 'external save' } });
    records.set('fx-save-a', migrated);
    reloaded.dispose();
    const unchanged = structuredClone(records.get('fx-save-a'));

    await assert.rejects(() => reloaded.load(oldUrl), { modId: 'fx-save-a', stage: 'saveData' });
    assert.deepEqual(records.get('fx-save-a'), unchanged, 'missing migration never wipes data');
    await assert.rejects(() => reloaded.load(moduleUrl(`${manifestSource('fx-save-a')}
manifest.saveSchemaVersion = 3;
export async function migrateSaveData() { throw new Error('migration refused'); }
export function activate() { throw new Error('must not activate'); }`)), { stage: 'saveData' });
    await new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
    assert.deepEqual(records.get('fx-save-a'), unchanged);
    assert.deepEqual(reloaded.diagnostics().mods, []);
    assert.ok(reloaded.diagnostics().errors.some(({ stage }) => stage === 'saveData.late'));
    assert.deepEqual(fx.unhandled, []);
});

test('save validation rejects lossy JSON and oversized writes without replacing previous data', async () => {
    const host = createModHost(await newEngine());

    host.api.saveData.write({ safe: true });
    const cycle = {};

    cycle.self = cycle;
    const sparse = [];

    sparse.length = 2;

    for (const value of [
        undefined, Number.NaN, Infinity, 1n, () => undefined, cycle,
        { nested: undefined },
        {
            /**
             * Supply a function that strict JSON must reject.
             *
             * @returns {void} No result.
             */
            nested: () => undefined,
        },
        [Number.NaN], new Date(), new Uint8Array(2),
        {
            /**
             * Supply a custom serializer that strict JSON must reject.
             *
             * @returns {number} Serializer result.
             */
            toJSON: () => 4,
        },
        {
            /**
             * Supply an accessor that strict JSON must reject without invoking.
             *
             * @returns {number} Accessor result.
             */
            get score() {
                return 4;
            },
        },
        [Symbol('data')], { [Symbol('key')]: 1 }, sparse,
        'x'.repeat(256 * 1_024), 'é'.repeat(128 * 1_024),
    ]) {
        assert.throws(() => host.api.saveData.write(value), { stage: 'saveData' });
        assert.deepEqual(host.api.saveData.read(), { safe: true });
    }

    host.api.saveData.write(null);
    assert.equal(host.api.saveData.read(), null);
    const otherHost = createModHost(await newEngine());

    assert.equal(otherHost.api.saveData.read(), undefined, 'default backing is not durable or shared');
});

test('post-step ticks use committed detached snapshots and skip withdrawn listeners', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);
    const calls = [];
    const withdraw = host.api.events.onTick(() => {
        calls.push('withdrawn');
    }, { priority: 10 });

    host.api.events.onTick((event) => {
        withdraw();
        calls.push(`first:${event.snapshot.tick}`);
        event.snapshot.x = -100;
        assert.equal(event.seconds, STEP);
        assert.throws(() => host.step(STEP), { stage: 'tick' });
    }, { priority: -1 });
    host.api.events.onTick((event) => {
        calls.push(`second:${event.snapshot.tick}:${event.snapshot.x}`);
    });
    host.command({ type: 'walk', x: 1, y: 0 });
    host.step(STEP);
    assert.deepEqual(calls, ['first:1', `second:1:${engine.snapshot().x}`]);
    assert.ok(engine.snapshot().x > 5);
    assert.equal(withdraw(), false);
    assert.throws(() => host.step(0), { stage: 'tick' });
    assert.equal(calls.length, 2, 'refused steps do not emit ticks');
    host.dispose();
    host.step(STEP);
    assert.equal(calls.length, 2);
});

test('tick errors and async rejection do not prevent later listeners or undo the step', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    fx.seen = [];
    await host.load(moduleUrl(`${manifestSource('fx-tick')}
export function activate(api) {
  fx.api = api;
  api.events.onTick(() => { throw new Error('tick exploded'); });
  api.events.onTick(async () => { throw new Error('tick late'); });
  api.events.onTick((event) => { fx.seen.push(event.snapshot.tick); });
}`));
    host.step(STEP);
    await new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
    assert.equal(engine.snapshot().tick, 1);
    assert.deepEqual(fx.seen, [1]);
    assert.deepEqual(host.diagnostics().errors.map(({ modId, stage }) => [modId, stage]), [
        ['fx-tick', 'onTick'], ['fx-tick', 'onTick'], ['fx-tick', 'onTick.late'],
    ]);
    host.dispose();
    assert.throws(() => fx.api.events.onTick(() => undefined), { stage: 'api' });
    assert.throws(() => fx.api.world.getBounds(), { stage: 'api' });
    assert.throws(() => fx.api.world.importNavigationCell(0, 0, navigationCell()), { stage: 'api' });
    assert.throws(() => fx.api.hooks.beforeWorldImport(() => undefined), { stage: 'api' });
    assert.throws(() => fx.api.saveData.write({ leaked: true }), { stage: 'api' });
    host.step(STEP);
    assert.deepEqual(fx.seen, [1]);
    assert.deepEqual(fx.unhandled, []);
});

test('missing optional engine capabilities refuse explicitly without disabling movement', async () => {
    const engine = await newEngine();
    const host = createModHost({
        snapshot: engine.snapshot, command: engine.command, setSpeed: engine.setSpeed,
    });

    for (const attempt of [
        () => host.api.world.getBounds(), () => host.api.world.getNavFlags(0, 0),
        () => host.api.world.importNavigationCell(0, 0, navigationCell()),
    ]) {
        assert.throws(attempt, { modId: 'host', stage: 'world' });
    }

    assert.throws(() => host.step(STEP), { stage: 'tick' });
    assert.equal(host.command({ type: 'walk', x: -1, y: 0 }).committed, true);
});

test('failed activation withdraws import hooks and tick listeners without undoing persisted effects', async () => {
    const host = createModHost(await newEngine());

    fx.seen = [];
    await assert.rejects(() => host.load(moduleUrl(`${manifestSource('fx-new-rollback')}
export function activate(api) {
  fx.api = api;
  api.world.importNavigationCell(0, 0, new Uint8Array([0, 1, ...new Array(1024).fill(0)]));
  api.saveData.write({ retained: true });
  api.hooks.beforeWorldImport(() => false);
  api.events.onTick(() => { fx.seen.push('should be withdrawn'); });
  throw new Error('activation failed after committed effects');
}`)), { stage: 'activate' });
    assert.equal(host.diagnostics().hookCount, 0);
    assert.equal(host.api.world.getBounds().cells, 1);
    assert.equal(host.api.world.importNavigationCell(0, 0, navigationCell()).committed, true);
    host.step(STEP);
    assert.deepEqual(fx.seen, []);
    assert.throws(() => fx.api.saveData.read(), { stage: 'api' });
    await host.load(moduleUrl(`${manifestSource('fx-new-rollback')}
export function activate(api) { assert.deepEqual(api.saveData.read(), { retained: true }); }`));
});

/** Independent footwear definition; numeric gameplay fields come back from WASM. */
const footwear = {
    fullType: 'Fixture.Shoes', bodyLocation: 'Shoes', conditionMax: 12, stackLimit: 1,
    removeOnBroken: false, conditionLowerChanceOneIn: 3, texture: 'fixture-shoe',
};

test('public footwear actions preserve ids and authoritative condition through hooks', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    await host.load(moduleUrl(`${manifestSource('fx-items')}
export function activate(api) {
  fx.api = api;
  api.items.definitions.register(${JSON.stringify(footwear)});
}`));
    const api = fx.api;

    assert.equal(api.items.definitions.get('Fixture.Shoes').owner, 'fx-items');
    assert.equal(api.items.definitions.get('unknown'), null);
    const definition = api.items.definitions.list()[0];

    definition.conditionMax = 99;
    assert.equal(api.items.definitions.get('Fixture.Shoes').conditionMax, 12);
    engine.freezeItemDefinitions();
    const spawn = api.items.spawn({ fullType: 'Fixture.Shoes', x: 5, y: 5 });
    const id = spawn.snapshot.id;

    assert.equal(spawn.submittedBy, 'fx-items');
    assert.equal(api.items.get(id).condition, 12, 'omitted condition uses the real definition maximum');
    assert.equal(api.items.get(id).count, 1);
    const before = engine.items();
    const unveto = host.api.hooks.beforeAction((action) => action.type === 'pickup' ? false : undefined);

    assert.equal(api.items.pickup(id).cancelled, true);
    assert.deepEqual(engine.items(), before);
    unveto();
    api.items.pickup(id);
    api.items.wear(id);
    assert.equal(api.items.worn('Shoes').id, id);
    api.items.setCondition(id, 0);
    assert.equal(api.items.worn('Shoes').condition, 0);
    api.items.unequip(id);
    assert.equal(api.items.worn('Shoes'), null);
    api.items.drop(id, 6, 5);
    assert.deepEqual(api.items.get(id), {
        id, fullType: 'Fixture.Shoes', location: 'ground', x: 6, y: 5,
        condition: 0, count: 1, bodyLocation: null,
        weight: 1, actualWeight: 1,
    });
    assert.equal(api.items.get(4_294_967_295), null);
    const record = api.items.list()[0];

    record.condition = 11;
    assert.equal(engine.items()[0].condition, 0);
    assert.ok(Object.isFrozen(api.items) && Object.isFrozen(api.items.definitions));
    assert.throws(() => api.items.definitions.register(footwear), { modId: 'fx-items', stage: 'items' });
});

test('item weight veto preserves native carry load and independent live fields', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    await host.load(moduleUrl(`${manifestSource('fx-weights')}
export function activate(api) {
  fx.api = api;
  api.items.definitions.register({...${JSON.stringify(footwear)}, weight: 2.5});
}`));
    const api = fx.api;
    const id = api.items.spawn({ fullType: 'Fixture.Shoes', x: 5, y: 5 }).snapshot.id;

    api.items.pickup(id);
    const unveto = host.api.hooks.beforeAction((action) => action.type === 'setWeight' || action.type === 'setActualWeight' ? false : undefined);

    assert.equal(api.items.setWeight(id, 9).cancelled, true);
    const veto = api.items.setActualWeight(id, 12);

    assert.equal(veto.submittedBy, 'fx-weights');
    assert.equal(veto.cancelledBy, 'host');
    assert.deepEqual([engine.items()[0].weight, engine.items()[0].actualWeight], [2.5, 2.5]);
    assert.equal(api.items.inventoryState().capacityWeight, 2.5);
    unveto();
    api.items.setWeight(id, 9);
    assert.deepEqual([engine.items()[0].weight, engine.items()[0].actualWeight], [9, 2.5]);
    assert.equal(api.items.inventoryState().capacityWeight, 2.5);
    api.items.setActualWeight(id, 12);
    api.items.wear(id);
    assert.deepEqual([engine.items()[0].weight, engine.items()[0].actualWeight], [9, 12]);
    assert.ok(Math.abs(api.items.inventoryState().capacityWeight - 3.6) < 0.000_001);
    api.items.drop(id, 5, 5);
    assert.equal(api.items.inventoryState().capacityWeight, 0);
    const second = api.items.spawn({ fullType: 'Fixture.Shoes', x: 5, y: 5 }).snapshot.id;

    api.items.pickup(id);
    api.items.pickup(second);
    api.items.setActualWeight(id, 3.402_823_466_385_288_6e38);
    api.items.setActualWeight(second, 3.402_823_466_385_288_6e38);
    assert.equal(api.items.inventoryState().capacityWeight, Infinity, 'native aggregate overflow is observable, not an invented per-inventory ceiling');
    host.dispose();
});

test('item weight boundaries reject full precision invalid values and captured owners become inert', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    await host.load(moduleUrl(`${manifestSource('fx-weight-boundaries')}
export function activate(api) {
  fx.api = api;
  api.items.definitions.register(${JSON.stringify(footwear)});
}`));
    const api = fx.api;
    const id = api.items.spawn({ fullType: 'Fixture.Shoes', x: 5, y: 5 }).snapshot.id;

    api.items.pickup(id);
    let calls = 0;

    host.api.hooks.beforeAction(() => {
        calls += 1;
    });

    for (const value of [-Number.MIN_VALUE, -1, Number.NaN, Infinity, Number.MAX_VALUE, 3.402_823_466_385_289e38]) {
        assert.throws(() => api.items.setWeight(id, value), { modId: 'fx-weight-boundaries', stage: 'action' });
        assert.throws(() => api.items.setActualWeight(id, value), { modId: 'fx-weight-boundaries', stage: 'action' });
    }

    assert.equal(calls, 0, 'invalid weights cannot reach hooks or native mutation');
    assert.deepEqual([engine.items()[0].weight, engine.items()[0].actualWeight], [1, 1]);
    assert.equal(api.items.inventoryState().capacityWeight, 1);
    api.items.setWeight(id, 0.125);
    api.items.setActualWeight(id, 0.375);
    assert.deepEqual([engine.items()[0].weight, engine.items()[0].actualWeight], [0.125, 0.375]);
    assert.equal(api.items.inventoryState().capacityWeight, 0.375);
    const setWeight = api.items.setWeight;
    const setActualWeight = api.items.setActualWeight;
    const inventoryState = api.items.inventoryState;

    host.dispose();
    assert.throws(() => setWeight(id, 4), { modId: 'fx-weight-boundaries', stage: 'api' });
    assert.throws(() => setActualWeight(id, 5), { modId: 'fx-weight-boundaries', stage: 'api' });
    assert.throws(inventoryState, { modId: 'fx-weight-boundaries', stage: 'api' });
    assert.deepEqual([engine.items()[0].weight, engine.items()[0].actualWeight], [0.125, 0.375]);
    assert.equal(engine.inventoryState().capacityWeight, 0.375);
});

test('item command validation and detached replacements prevent invalid hook mutations', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    engine.registerItemDefinition(footwear, { owner: 'host-fixture' });
    let calls = 0;

    host.api.hooks.beforeAction((action) => {
        calls += 1;
        action.fullType = 'unknown';
        action.condition = 0;

        return { type: 'spawnItem', fullType: 'Fixture.Shoes', x: Infinity, y: 5 };
    });
    const result = host.api.items.spawn({ fullType: 'Fixture.Shoes', x: 5, y: 5 });

    assert.equal(engine.items()[0].condition, 12);
    assert.deepEqual(result.modifiedBy, []);
    assert.equal(host.diagnostics().errors.at(-1).stage, 'beforeAction');
    assert.equal(host.diagnostics().errors.at(-1).modId, 'host');

    for (const action of [
        { type: 'spawnItem', fullType: '', x: 5, y: 5 },
        { type: 'spawnItem', fullType: 'Fixture.Shoes', x: Number.NaN, y: 5 },
        { type: 'spawnItem', fullType: 'Fixture.Shoes', x: 5, y: 5, count: 0 },
        { type: 'spawnItem', fullType: 'Fixture.Shoes', x: 5, y: 5, condition: -1 },
        { type: 'pickup', id: 0 }, { type: 'wear', id: 4_294_967_296 },
        { type: 'unequip', id: 1.5 }, { type: 'drop', id: 1, x: 5, y: Infinity },
        { type: 'setCondition', id: 1, condition: 2_147_483_648 },
        { type: 'setHealth', health: 101 },
    ]) {
        assert.throws(() => host.command(action), { stage: 'action' });
    }

    assert.equal(calls, 1, 'malformed commands never reach hooks');
    assert.equal(engine.items().length, 1);
    assert.throws(() => host.api.items.get(0), { stage: 'items' });
    assert.throws(() => host.api.items.worn(''), { stage: 'items' });
});

test('activation definition transactions restore numeric rows owners and appended metadata', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);

    engine.registerItemDefinition(footwear, { owner: 'original' });
    const original = engine.itemDefinitions();

    await assert.rejects(() => host.load(moduleUrl(`${manifestSource('fx-collision')}
export function activate(api) { api.items.definitions.register(${JSON.stringify(footwear)}); }`)),
    { modId: 'fx-collision', stage: 'activate' });
    assert.deepEqual(engine.itemDefinitions(), original);

    for (const [id, ending] of [
        ['fx-rollback-items', 'throw new Error(\'abort\');'],
        ['fx-invalid-items', 'return 7;'],
        ['fx-async-items', 'return Promise.reject(new Error(\'async abort\'));'],
    ]) {
        // These failures share one host and engine; each rollback must finish before the next activation.
        // eslint-disable-next-line no-await-in-loop
        await assert.rejects(() => host.load(moduleUrl(`${manifestSource(id)}
export function activate(api) {
  fx.api = api;
  api.movement.setSpeed(8);
  api.items.definitions.register({...${JSON.stringify(footwear)}, conditionMax: 27, texture: 'override'}, {override: true});
  api.items.definitions.register({...${JSON.stringify(footwear)}, fullType: 'Fixture.Appended'});
  api.hooks.beforeAction(() => false);
  ${ending}
}`)), { modId: id, stage: 'activate' });
        assert.deepEqual(engine.itemDefinitions(), original);
        assert.equal(engine.snapshot().speed, 1.5);
        assert.equal(host.diagnostics().hookCount, 0);
        assert.throws(() => fx.api.items.list(), { stage: 'api' });
    }

    await new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
    assert.ok(host.diagnostics().errors.some(({ modId, stage }) => modId === 'fx-async-items' && stage === 'activate.late'));
    assert.deepEqual(fx.unhandled, []);
    await host.load(moduleUrl(`${manifestSource('fx-success-items')}
export function activate(api) {
  fx.api = api;
  api.items.definitions.register({...${JSON.stringify(footwear)}, conditionMax: 17, owner: 'spoof'}, {override: true});
}`));
    assert.equal(engine.itemDefinitions()[0].owner, 'fx-success-items');
    assert.equal(engine.itemDefinitions()[0].conditionMax, 17);
    assert.throws(() => fx.api.items.definitions.register(footwear), { stage: 'items' });
    engine.freezeItemDefinitions();
    host.dispose();
    await host.load(moduleUrl(`${manifestSource('fx-movement-frozen')}
export function activate(api) { api.movement.setSpeed(2); }`));
    assert.equal(host.command({ type: 'walk', x: 1, y: 0 }).committed, true);
    await assert.rejects(() => host.load(moduleUrl(`${manifestSource('fx-register-frozen')}
export function activate(api) { api.items.definitions.register({...${JSON.stringify(footwear)}, fullType: 'Fixture.Late'}); }`)),
    { modId: 'fx-register-frozen', stage: 'activate' });
    assert.equal(engine.itemDefinitions().length, 1);
});

test('health vetoes and death listeners observe only committed alive to dead transitions', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);
    const deaths = [];

    assert.equal(host.api.character.getHealth(), 100);
    assert.equal(host.api.character.isDead(), false);
    host.api.events.onCharacterDeath((event) => {
        assert.equal(engine.isDead(), true, 'listener runs after real mutation');
        deaths.push(event);
        event.snapshot.health = 100;
    });
    const unveto = host.api.hooks.beforeAction((action) => action.type === 'setHealth' ? false : undefined);

    assert.equal(host.api.character.setHealth(0).cancelled, true);
    assert.equal(engine.getHealth(), 100);
    assert.equal(deaths.length, 0);
    unveto();
    host.api.character.setHealth(0);
    host.api.character.setHealth(0);
    host.command({ type: 'walk', x: 1, y: 0 });
    assert.equal(deaths.length, 1);
    assert.equal(deaths[0].type, 'CharacterDeath');
    assert.equal(deaths[0].submittedBy, 'host');
    assert.deepEqual(deaths[0].action, { type: 'setHealth', health: 0 });
    assert.equal(engine.getHealth(), 0, 'detached death evidence cannot alter state');
    host.api.character.setHealth(40);
    host.api.character.setHealth(0);
    assert.equal(deaths.length, 2);
});

test('original UI options persist within their owning namespace without erasing native player data', async () => {
    const records = new Map();
    const backing = {
        /**
         * Read only the requested fixture namespace.
         *
         * @param {string} id - Exact mod namespace.
         * @returns {import('../types/mod-api').ModSaveRecord|undefined} Saved record or absence.
         */
        readModState: (id) => records.get(id),
        /**
         * Retain a validated record without replacing other fixture namespaces.
         *
         * @param {string} id - Exact mod namespace.
         * @param {import('../types/mod-api').ModSaveRecord} record - Detached schema version and document.
         * @returns {void} Replaces this namespace.
         */
        writeModState: (id, record) => {
            records.set(id, record);
        },
    };
    const host = createModHost(await newEngine(), backing);
    const url = moduleUrl(`${manifestSource('fx-ui-options')}
export function activate(api) { fx.api = api; }`);

    await host.load(url);
    const api = fx.api;

    api.saveData.write({ nativePlayerData: { score: 8 }, untouched: [1] });
    const values = { enabled: true, slider: 3, nested: { label: 'original' } };

    assert.equal(api.ui.readOptions('Exact.Options'), undefined);
    api.ui.writeOptions('Exact.Options', values);
    api.ui.writeOptions('__proto__', { safe: true });
    values.nested.label = 'external';
    const read = api.ui.readOptions('Exact.Options');

    read.nested.label = 'read mutation';
    assert.equal(api.ui.readOptions('Exact.Options').nested.label, 'original');
    assert.equal(api.ui.readOptions('exact.options'), undefined);
    assert.deepEqual(api.ui.readOptions('__proto__'), { safe: true });
    assert.deepEqual(api.saveData.read().nativePlayerData, { score: 8 });
    assert.deepEqual(api.saveData.read().untouched, [1]);
    assert.equal({}.safe, undefined);
    assert.ok(Object.isFrozen(api.ui));
    host.dispose();
    const next = createModHost(await newEngine(), backing);

    await next.load(url);
    assert.equal(fx.api.ui.readOptions('Exact.Options').slider, 3);
    await next.load(moduleUrl(`${manifestSource('fx-ui-foreign')}
export function activate(api) { fx.result = api; }`));
    fx.result.ui.writeOptions('Exact.Options', { slider: 9 });
    assert.equal(fx.api.ui.readOptions('Exact.Options').slider, 3);
    const before = structuredClone(records.get('fx-ui-options'));

    for (const id of ['', 'x'.repeat(129), 2]) {
        assert.throws(() => fx.api.ui.writeOptions(id, {}), { stage: 'ui' });
        assert.throws(() => fx.api.ui.readOptions(id), { stage: 'ui' });
    }

    assert.throws(() => fx.api.ui.writeOptions('too-large', 'x'.repeat(256 * 1_024)), { stage: 'ui' });
    assert.throws(() => fx.api.ui.writeOptions('invalid', { nested: undefined }), { stage: 'ui' });
    assert.deepEqual(records.get('fx-ui-options'), before);
    fx.api.ui.writeOptions('x'.repeat(128), JSON.parse('{"__proto__":{"polluted":true}}'));
    assert.equal(fx.api.ui.readOptions('constructor'), undefined);
    assert.equal({}.polluted, undefined);
    records.set('fx-ui-options', { ...before, schemaVersion: 99 });
    assert.throws(() => fx.api.ui.writeOptions('Exact.Options', {}), { stage: 'ui' });
    assert.equal(records.get('fx-ui-options').schemaVersion, 99);
    assert.throws(() => api.ui.writeOptions('Exact.Options', {}), { stage: 'api' });
    records.set('fx-ui-options', { schemaVersion: 1, data: null });
    assert.throws(() => fx.api.ui.writeOptions('Exact.Options', {}), { stage: 'ui' });
    assert.equal(records.get('fx-ui-options').data, null, 'nonobject save data is never silently discarded');
});

test('core-only engines refuse item and health capabilities while movement mods still activate', async () => {
    const engine = await newEngine();
    const host = createModHost({ snapshot: engine.snapshot, command: engine.command, setSpeed: engine.setSpeed });

    for (const attempt of [
        () => host.api.items.list(), () => host.api.items.get(1),
        () => host.api.items.definitions.list(), () => host.api.items.worn('Shoes'),
        () => host.api.items.spawn({ fullType: 'Fixture.Shoes', x: 5, y: 5 }),
        () => host.api.items.pickup(1), () => host.api.character.getHealth(),
        () => host.api.items.wear(1), () => host.api.items.unequip(1),
        () => host.api.items.drop(1, 5, 5), () => host.api.items.setCondition(1, 0),
        () => host.api.items.inventoryState(), () => host.api.items.setWeight(1, 1),
        () => host.api.items.setActualWeight(1, 1),
        () => host.api.character.isDead(), () => host.api.character.setHealth(0),
        () => host.api.character.moodles(),
    ]) {
        assert.throws(attempt, /unsupported/);
    }

    assert.equal(engine.items().length, 0);
    assert.equal(engine.getHealth(), 100);
    await host.load(moduleUrl(`${manifestSource('fx-core-movement')}
export function activate(api) { api.movement.setSpeed(2); }`));
    assert.equal(host.command({ type: 'walk', x: 1, y: 0 }).committed, true);
});

test('character input actions preserve vetoes and reject invalid atomic updates', async () => {
    const engine = await newEngine();
    const host = createModHost(engine);
    const unveto = host.api.hooks.beforeAction((action) => action.type === 'setCharacterStat' ? false : undefined);

    assert.equal(host.api.character.setStat('hunger', 0.8).cancelled, true);
    assert.equal(host.api.character.moodles().find(({ id }) => id === 'base:hungry').level, 0);
    unveto();
    host.api.character.setStat('hunger', 0.8);
    assert.equal(host.api.character.moodles().find(({ id }) => id === 'base:hungry').level, 4);
    const before = host.api.character.moodleInputs();

    assert.throws(() => host.api.character.setMoodleInputs({ hunger: 0.2, temperature: Number.NaN }));
    assert.deepEqual(host.api.character.moodleInputs(), before);
    const detached = host.api.character.moodleInputs();

    detached.hunger = 0;
    assert.equal(host.api.character.moodleInputs().hunger, 0.8);
});

for (const ending of ['return', 'throw']) {
    test(`moodle input hook mutations stay detached when the hook ${ending}s`, async () => {
        const engine = await newEngine();

        engine.command({ type: 'setMoodleInputs', inputs: { pain: 17, hunger: 0.1 } });
        const host = createModHost(engine);
        const seen = [];

        host.api.hooks.beforeAction((action) => {
            action.inputs.pain = 80;

            if (ending === 'throw') {
                throw new Error('fixture nested input mutation');
            }
        }, { priority: -1 });
        host.api.hooks.beforeAction((action) => {
            seen.push({ ...action.inputs });
        });
        const inputs = { hunger: 0.8 };
        const result = host.command({ type: 'setMoodleInputs', inputs });

        assert.equal(result.committed, true);
        assert.deepEqual(result.modifiedBy, []);
        assert.deepEqual(seen, [{ hunger: 0.8 }]);
        assert.deepEqual(inputs, { hunger: 0.8 });
        assert.equal(engine.saveMoodleState().inputs.hunger, 0.8);
        assert.equal(engine.saveMoodleState().inputs.pain, 17);

        if (ending === 'throw') {
            assert.ok(host.diagnostics().errors.some(({ modId, stage, message }) => modId === 'host'
                && stage === 'beforeAction' && message === 'fixture nested input mutation'));
        } else {
            assert.deepEqual(host.diagnostics().errors, []);
        }

        host.dispose();
    });
}

test('door capabilities refuse core-only engines with caller attribution and preserve movement', async () => {
    const engine = await newEngine();
    const host = createModHost({ snapshot: engine.snapshot, command: engine.command, setSpeed: engine.setSpeed });

    await host.load(moduleUrl(`${manifestSource('fx-door-unsupported')}
export function activate(api) { fx.api = api; }`));
    assert.throws(() => fx.api.world.getDoors(), { name: 'ModError', modId: 'fx-door-unsupported', stage: 'world' });
    assert.throws(() => fx.api.world.toggleDoor('door:5:5:0:0'), {
        name: 'ModError', modId: 'fx-door-unsupported', stage: 'action',
    });
    assert.equal(host.command({ type: 'walk', x: 1, y: 0 }).committed, true);
    host.dispose();
});

test('missing audio adapter fails honestly with owner attribution and inert captured handles', async () => {
    const host = createModHost(await newEngine());

    await host.load(moduleUrl(`${manifestSource('fx-audio-unsupported')}
export function activate(api) { fx.api = api; }`));
    const api = fx.api;

    await assert.rejects(() => api.audio.load('cue', new ArrayBuffer(4)), {
        name: 'ModError', modId: 'fx-audio-unsupported', stage: 'audio', message: /unsupported/,
    });
    assert.throws(() => api.audio.play('base:cue', { x: 5, y: 5, z: 0 }), {
        name: 'ModError', modId: 'fx-audio-unsupported', stage: 'audio', message: /unsupported/,
    });
    assert.throws(() => api.audio.unload('cue'), {
        name: 'ModError', modId: 'fx-audio-unsupported', stage: 'audio', message: /unsupported/,
    });
    assert.equal(Object.isFrozen(api.audio), true);
    host.dispose();
    await assert.rejects(() => api.audio.load('cue', new ArrayBuffer(4)), { stage: 'api' });
    assert.throws(() => api.audio.play('cue', { x: 5, y: 5, z: 0 }), { stage: 'api' });
    assert.throws(() => api.audio.unload('cue'), { stage: 'api' });
    assert.deepEqual(fx.unhandled, []);
});

/**
 * Imports an independently authored closed portal into the real WASM world.
 *
 * @param {object} engine - Compiled authoritative wrapper.
 * @returns {string} Stable source placement identity.
 */
function importClosedDoor(engine) {
    const id = 'door:10:10:0:0';
    const squares = [];

    for (let y = 9; y <= 11; y += 1) {
        for (let x = 9; x <= 11; x += 1) {
            squares.push({
                x, y, z: 0, roomId: -1, outside: true, solid: false,
                solidTrans: false, tree: false, independentWalls: 0, vehicleObstructed: false,
            });
        }
    }

    engine.worldImportCell(0, 0, navigationCell());
    engine.importDoors([{
        id, x: 10, y: 10, z: 0, north: true, open: false, locked: false,
        lockedByKey: false, forceLocked: false, keyId: -1, roomId: -1,
        oppositeRoomId: -1, attachedE: false, attachedS: false, barricaded: false,
        independentWalls: 0, doubleDoor: 0, garageDoor: 0, interiorSide: false,
    }], { squares });
    engine.loadState({ version: 2, values: [10.5, 10.5, 1.5, 10.5, 10.5, 0, 0, 0, 0, 1, 100, 1] });

    return id;
}

test('public door veto preserves actual closed collision, then opens through shared attributed hooks', async () => {
    const engine = await newEngine();
    const id = importClosedDoor(engine);
    const host = createModHost(engine);

    await host.load(moduleUrl(`${manifestSource('fx-door-owner')}
export function activate(api) { fx.api = api; assert.equal(api.world.getDoors()[0].open, false); }`));
    const api = fx.api;
    const detached = api.world.getDoors();

    detached[0].open = true;
    detached[0].x = 0;
    detached.length = 0;
    assert.equal(api.world.getDoors()[0].open, false);
    assert.equal(api.world.getDoors()[0].x, 10);
    const before = engine.saveDoorState();
    const unveto = host.api.hooks.beforeAction((action) => {
        if (action.type === 'toggleDoor') {
            assert.equal(engine.doors()[0].open, false, 'hooks run before any door mutation');
            assert.throws(() => api.world.toggleDoor(id), { modId: 'fx-door-owner', stage: 'action' });

            return false;
        }
    });
    const veto = api.world.toggleDoor(id);

    assert.deepEqual([veto.committed, veto.cancelled, veto.submittedBy, veto.cancelledBy],
        [false, true, 'fx-door-owner', 'host']);
    assert.deepEqual(engine.saveDoorState(), before);
    assert.throws(() => engine.command({ type: 'walk', x: 0, y: -1 }), /blocked/u);
    unveto();
    const opening = api.world.toggleDoor(id);

    assert.deepEqual([opening.committed, opening.cancelled, opening.submittedBy], [true, false, 'fx-door-owner']);
    assert.equal(api.world.getDoors()[0].open, true);
    assert.equal(engine.saveDoorState().revision, before.revision + 1);
    host.command({ type: 'walk', x: 0, y: -1 });
    host.step(0.1);
    assert.ok(engine.snapshot().y < 10.5, 'opening changes actual CPU/WASM traversal');
    host.command({ type: 'cancel' });
    await host.load(moduleUrl(`${manifestSource('fx-door-other')}
export function activate(api) { fx.api = api; }`));
    assert.equal(fx.api.world.toggleDoor(id).submittedBy, 'fx-door-other');
    assert.equal(engine.doors()[0].open, false);
    const replace = host.api.hooks.beforeAction((action) => action.type === 'toggleDoor'
        ? { type: 'walk', x: 1, y: 0 }
        : undefined);
    const changed = fx.api.world.toggleDoor(id);

    assert.deepEqual(changed.modifiedBy, ['host']);
    assert.equal(engine.doors()[0].open, false, 'hook replacement commits movement, not the original door action');
    assert.equal(engine.snapshot().action, 2);
    replace();
    host.dispose();
    assert.throws(() => api.world.getDoors(), { stage: 'api' });
    assert.throws(() => api.world.toggleDoor(id), { stage: 'api' });
});

test('door activation mutation and malformed stable identities cannot leak into WASM', async () => {
    const engine = await newEngine();
    const id = importClosedDoor(engine);
    const host = createModHost(engine);
    const before = engine.saveDoorState();

    await assert.rejects(() => host.load(moduleUrl(`${manifestSource('fx-door-activation')}
export function activate(api) { api.world.toggleDoor('${id}'); }`)), { stage: 'activate' });
    assert.deepEqual(engine.saveDoorState(), before);
    await assert.rejects(() => host.load(moduleUrl(`${manifestSource('fx-door-action-activation')}
export function activate(api) { api.actions.submit({type: 'toggleDoor', id: '${id}'}); }`)), { stage: 'activate' });
    assert.deepEqual(engine.saveDoorState(), before);
    const redirect = host.api.hooks.beforeAction(() => ({ type: 'toggleDoor', id }));

    await assert.rejects(() => host.load(moduleUrl(`${manifestSource('fx-door-rewritten-activation')}
export function activate(api) { api.actions.submit({type: 'walk', x: 1, y: 0}); }`)), { stage: 'activate' });
    assert.deepEqual(engine.saveDoorState(), before, 'a hook cannot disguise a door mutation as activation movement');
    redirect();

    for (const invalid of ['', null, 1, 'x'.repeat(257)]) {
        assert.throws(() => host.api.world.toggleDoor(invalid), { name: 'ModError', modId: 'host', stage: 'action' });
    }

    assert.deepEqual(engine.saveDoorState(), before);
    host.dispose();
});

test('audio namespace and activation guards reject before any decoder can consume bytes', async () => {
    const host = createModHost(await newEngine());
    const bytes = new ArrayBuffer(8);

    await assert.rejects(() => host.load(moduleUrl(`${manifestSource('fx-audio-activation')}
export function activate(api) { fx.result = api.audio.load('cue', new ArrayBuffer(8)); return fx.result; }`)),
    { stage: 'activate' });
    await assert.rejects(fx.result, { stage: 'audio', message: /synchronous activate/ });
    await host.load(moduleUrl(`${manifestSource('fx-audio-namespace')}
export function activate(api) { fx.api = api; }`));

    await Promise.all(['base:cue', 'host:cue', 'other:cue'].map(async (id) => {
        await assert.rejects(() => fx.api.audio.load(id, bytes), { stage: 'audio', message: /namespace/ });
        assert.throws(() => fx.api.audio.unload(id), { stage: 'audio', message: /namespace/ });
    }));

    assert.equal(bytes.byteLength, 8, 'rejected namespace checks never detach the caller buffer');
    await assert.rejects(() => host.load(moduleUrl(`${manifestSource('base')}
export function activate() { throw new Error('reserved base owner reached activation'); }`)), { stage: 'manifest' });
    host.dispose();
});
