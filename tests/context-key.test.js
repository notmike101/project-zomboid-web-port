/** @file Source accepted-update Interact timing and contextual selection regressions. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createEngine } from '../src/engine.js';
import { createLuaSession } from '../src/lua-runtime.js';
import { createModHost } from '../src/mods.js';
import { createContextKeyInput, createSourceContextSelector, pickSourceContextAction, sourceContextDirections } from '../src/native-world-context.js';

test('Interact uses accepted float frames, release gates, and cancellation without a stale release', () => {
    const input = createContextKeyInput();
    const attempts = [];
    let succeeds = false;
    /**
     * Record each accepted context attempt and return the configured outcome.
     *
     * @param {number} milliseconds - Accepted source context duration.
     * @param {number} seconds - Accepted float context duration.
     * @returns {boolean} Configured attempt result.
     */
    const attempt = (milliseconds, seconds) => {
        attempts.push([milliseconds, seconds]);

        return succeeds;
    };

    input.update(0.2, true, true, attempt);
    input.update(0.2, true, true, attempt);
    assert.deepEqual(attempts, []);
    input.update(0.1, true, true, attempt);
    assert.equal(attempts[0][0], 500);
    input.update(0.1, false, false, attempt);
    assert.equal(attempts.length, 1, 'UI-consumed release clears the armed press');
    input.update(0.1, false, true, attempt);
    assert.equal(attempts.length, 1);
    input.update(0.1, true, true, attempt);
    input.cancel();
    input.update(0.1, false, true, attempt);
    assert.equal(attempts.length, 1, 'blur/pause/session cancellation cannot replay release');
    input.update(0.1, true, true, attempt);
    succeeds = true;
    input.update(0.1, false, true, attempt);
    assert.equal(attempts.at(-1)[0], 200, 'short press attempts only at the accepted release update');
    input.update(0.1, false, true, attempt);
    assert.equal(attempts.length, 2, 'successful selection resets source use-key state');
});

test('source diagonal fractions and front/behind priority retain insertion-order transitions', () => {
    assert.deepEqual(sourceContextDirections('NW', 5.8, 5.2), { front: ['N', 'W'], behind: ['S', 'E'], corner: 'NW' });
    assert.deepEqual(sourceContextDirections('NW', 5.2, 5.8), { front: ['W', 'N'], behind: ['E', 'S'], corner: 'NW' });
    assert.deepEqual(sourceContextDirections('NE', 5.5, 5.5).front, ['E', 'N']);
    const first = { action: 'ToggleWindow', priority: 5 };
    const second = { action: 'ToggleDoor', priority: 5 };
    const behind = { action: 'RestOnFurniture', priority: 5, behind: true };

    assert.equal(pickSourceContextAction([first, second, behind]), first);
    behind.priority = 6;
    assert.equal(pickSourceContextAction([first, second, behind]), behind);
    assert.equal(pickSourceContextAction([]), null);
});

test('accepted native Interact produces resident Lua events, direct doors, and explicit non-door classification', async () => {
    const engine = await createEngine(await readFile(new URL('../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url)));
    const squares = [];

    for (let x = 4; x <= 6; x += 1) {
        for (let y = 4; y <= 6; y += 1) {
            squares.push({
                x, y, z: 0, roomId: -1, outside: true, solid: false, solidTrans: false,
                tree: false, vehicleObstructed: false, independentWalls: 0, solidFloor: true,
                reachWalls: { north: false, west: false }, contextObjects: [],
            });
        }
    }

    const row = {
        id: 'door:5:5:0:0', x: 5, y: 5, z: 0, north: true, open: false, locked: false,
        lockedByKey: false, forceLocked: false, keyId: -1, roomId: -1, oppositeRoomId: -1,
        attachedE: false, attachedS: false, barricaded: false, independentWalls: 0,
        doubleDoor: 0, garageDoor: 0, interiorSide: false, hoppable: false,
    };

    engine.importDoors([], { squares });
    engine.sourceActions.face(5, 4);
    const current = squares.find((square) => square.x === 5 && square.y === 5);
    const door = { kind: 'door', special: true, north: true, doorId: row.id, sprite: 'fixture-door', properties: new Map() };
    const selector = createSourceContextSelector(engine, squares);
    const pressed = new Set();
    const binding = { keyValue: 18, altKey: 0, shift: false, ctrl: false, alt: false };
    const saved = new Map();
    const host = createModHost(engine, {
        /**
         * Read the fixture's persisted mod state.
         *
         * @param {string} id - Mod identifier.
         * @returns {object|undefined} Persisted mod state.
         */
        readModState: (id) => saved.get(id),
        /**
         * Persist an isolated clone of the fixture's mod state.
         *
         * @param {string} id - Mod identifier.
         * @param {object} value - Mod state to persist.
         * @returns {void}
         */
        writeModState: (id, value) => {
            saved.set(id, structuredClone(value));
        },
    });
    const session = await createLuaSession({
        sourceActions: engine.sourceActions, sourceTiming: engine.sourceTiming,
        sourceWorldContext: {
            /**
             * Identify the fixture as a keyboard-only player.
             *
             * @returns {number} Keyboard-only player binding.
             */
            joypadBind: () => -1,
            /**
             * Resolve the fixture's Interact binding by its source name.
             *
             * @param {string} name - Source binding name.
             * @returns {object|null} Interact binding, if requested.
             */
            keyBinding: (name) => name === 'Interact' ? binding : null,
            /**
             * Expose the fixture's named source key bindings.
             *
             * @returns {object} Source key bindings.
             */
            keyBindings: () => ({ Interact: binding }),
            /**
             * Check whether the fixture currently holds a source key.
             *
             * @param {number} code - Source key code.
             * @returns {boolean} Whether the fixture holds the key.
             */
            isSourceKeyDown: (code) => pressed.has(code),
            contextSelection: selector,
        },
    });
    /**
     * Advance the native frame before sampling source context input.
     *
     * @param {number} seconds - Native frame duration.
     * @param {boolean} [allowed=true] - Whether gameplay owns the sample.
     * @returns {boolean} Source context update result.
     */
    const update = (seconds, allowed = true) => {
        engine.step(seconds);

        return session.updateContextKey(allowed);
    };

    try {
        session.activatePackage({
            id: 'pz-base-game', nativeId: 'ContextConsumer', api: host.coreApi,
            sources: [{
                path: 'media/lua/client/ContextConsumer.lua', source: `
                getModData().ContextTimes={}
                Events.OnContextKey.Add(function(actor,milliseconds)
                    assert(actor==getPlayer() and type(actor)=='userdata')
                    table.insert(getModData().ContextTimes,milliseconds)
                end)
            `,
            }],
        });
        pressed.add(18);
        update(0.1);
        pressed.clear();
        update(0.1);
        session.flushSaveData();
        assert.deepEqual(saved.get('pz-base-game').data.nativePlayerData.ContextTimes, [200]);
        engine.importDoors([row], { squares });
        current.contextObjects.push(door);
        pressed.add(18);
        update(0.1);
        pressed.clear();
        assert.equal(update(0.1), true);
        assert.equal(engine.doors()[0].open, true, 'context action mutates directly without creating a timed menu action');
        assert.equal(engine.sourceActions.length(), 0);
        session.flushSaveData();
        assert.deepEqual(saved.get('pz-base-game').data.nativePlayerData.ContextTimes, [200], 'a real door must not emit empty fallback');
        pressed.add(18);
        update(0.1);
        session.cancelContextKey();
        pressed.clear();
        update(0.1);
        assert.equal(engine.doors()[0].open, true, 'cancelled release must not toggle');
        current.contextObjects.length = 0;
        engine.importDoors([], { squares });
        current.contextObjects.push({ kind: 'other', special: false, sprite: 'fixture-bed', properties: new Map([['bed', '']]) });
        assert.equal(selector(0.2, false, false).action, 'RestOnFurniture');
        assert.match(selector(0.2, false, false).unresolved, /furniture object identity/u);
        current.contextObjects.push({ kind: 'window', special: true, north: true, sprite: 'fixture-window', properties: new Map() });
        assert.equal(selector(0.2, false, false).action, 'ToggleWindow', 'source edge lookup precedes rest furniture');
        assert.match(selector(0.2, false, false).unresolved, /window state/u);
        current.contextObjects.at(-1).properties.set('makeWindowInvincible', '');
        assert.deepEqual(selector(0.2, false, false), { empty: true },
            'source invincible window dispatch adds no action and still preempts the furniture branch');
        assert.deepEqual(session.diagnostics().errors, []);
        assert.throws(() => session.dispatch('OnContextKey', 0, 200), /externally dispatched/u);
        assert.deepEqual(session.diagnostics().errors, [{
            modId: 'runtime', nativeModId: 'runtime', apiModId: 'runtime', path: '<host>',
            message: '[native runtime/<host>] unsupported externally dispatched event: OnContextKey',
        }]);
    } finally {
        session.close({ discardSaveData: true });
        host.dispose();
    }
});
