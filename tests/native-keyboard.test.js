import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createEngine } from '../src/engine.js';
import { createLuaSession } from '../src/lua-runtime.js';
import { createModHost } from '../src/mods.js';
import { keyboardKey, keyName, normalizeInputBindings, sourceKeyCode } from '../src/native-keyboard.js';

test('retained keyboard settings migrate only the old empty binding and retain configured alternatives', () => {
    const legacy = { Interact: null };
    const migrated = normalizeInputBindings(legacy);

    assert.deepEqual(JSON.parse(JSON.stringify(migrated)), {
        Interact: null,
        'Toggle Inventory': { keyValue: 23, altKey: 0, shift: false, ctrl: false, alt: false },
    });
    assert.deepEqual(legacy, { Interact: null });
    const stored = {
        Interact: null,
        'Toggle Inventory': { keyValue: 23, altKey: 15, shift: true, ctrl: false, alt: true },
        'Custom action': { keyValue: 0, altKey: 157, shift: false, ctrl: true, alt: false },
    };
    const restored = normalizeInputBindings(JSON.parse(JSON.stringify(stored)));

    assert.deepEqual(JSON.parse(JSON.stringify(restored)), stored);
    assert.ok(Object.isFrozen(restored));
    assert.ok(Object.isFrozen(restored['Toggle Inventory']));
    assert.throws(() => {
        restored['Toggle Inventory'].keyValue = 73;
    }, TypeError);
});

test('malformed retained keyboard settings refuse activation without replacing the retained document', () => {
    for (const value of [null, [], { Interact: 23 }, { Interact: {} },
        { Interact: { keyValue: 23, altKey: 0, shift: false, ctrl: false, alt: 0 } },
        { Interact: { keyValue: 10_000, altKey: 0, shift: false, ctrl: false, alt: false } },
        { Interact: { keyValue: 84, altKey: 0, shift: false, ctrl: false, alt: false } },
        { Interact: { keyValue: 23, altKey: 0, shift: false, ctrl: false, alt: false, ignored: true } }]) {
        const retained = JSON.stringify(value);

        assert.throws(() => normalizeInputBindings(value), /keyboard binding/i);
        assert.equal(JSON.stringify(value), retained);
    }
});

test('physical inventory input reaches real Lua with native codes and live modifier/release state', async () => {
    const engine = await createEngine(await readFile(new URL('../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url)));
    const saved = new Map();
    const host = createModHost(engine, {
        /**
         * Restore the detached Lua consumer document.
         *
         * @param {string} id - Source namespace.
         * @returns {object|undefined} Previously persisted document.
         */
        readModState: (id) => structuredClone(saved.get(id)),
        /**
         * Persist real Lua consumer state.
         *
         * @param {string} id - Source namespace.
         * @param {object} value - Persisted state document.
         * @returns {void} Retains the detached document.
         */
        writeModState: (id, value) => {
            saved.set(id, structuredClone(value));
        },
    });
    const bindings = normalizeInputBindings({
        Interact: null,
        'Toggle Inventory': { keyValue: 23, altKey: 15, shift: false, ctrl: false, alt: false },
        'Modified Inventory': { keyValue: 23, altKey: 0, shift: false, ctrl: true, alt: false },
    });
    const pressed = new Set();
    const session = await createLuaSession({
        sourceActions: engine.sourceActions,
        sourceTiming: engine.sourceTiming,
        sourceWorldContext: {
            /**
             * Read the retained binding.
             *
             * @param {string} name - Binding ID.
             * @returns {object|null} Native record.
             */
            keyBinding: (name) => bindings[name] ?? null,
            /**
             * Read configured binding collisions.
             *
             * @returns {object} Configured collisions.
             */
            keyBindings: () => bindings,
            /**
             * Query the physical key state.
             *
             * @param {number} code - Native key.
             * @returns {boolean} Current input state.
             */
            isSourceKeyDown: (code) => pressed.has(code),
            keyboardKey,
            keyName,
        },
    });

    try {
        session.activatePackage({
            id: 'input-consumer', nativeId: 'InputConsumer', api: host.api,
            sources: [{
                path: 'media/lua/client/InputConsumer.lua',
                source: `
                    local count=0
                    local data=getModData()
                    data.Input={presses=0,releases=0}
                    Events.OnKeyStartPressed.Add(function(key)
                        count=count+1
                        data.Input.presses=count
                        if count==1 then
                            assert(key==23 and Keyboard.KEY_I==23)
                            assert(getCore():isKey(KeybindId.TOGGLE_INVENTORY,key))
                            assert(isKeyDown(Keyboard.KEY_I))
                        elseif count==2 then
                            assert(not getCore():isKey(KeybindId.TOGGLE_INVENTORY,key))
                            assert(getCore():isKey('Modified Inventory',key))
                            assert(isKeyDown(Keyboard.KEY_LCONTROL))
                        else
                            assert(key==15 and getCore():isKey(KeybindId.TOGGLE_INVENTORY,key))
                        end
                    end)
                    Events.OnKeyPressed.Add(function(key)
                        assert(key==23 and not isKeyDown(Keyboard.KEY_I))
                        assert(not isKeyDown(KeybindId.TOGGLE_INVENTORY))
                        data.Input.releases=data.Input.releases+1
                    end)
                `,
            }],
        });
        const inventoryKey = sourceKeyCode('KeyI');

        pressed.add(inventoryKey);
        session.dispatch('OnKeyStartPressed', inventoryKey);
        pressed.add(sourceKeyCode('ControlLeft'));
        session.dispatch('OnKeyStartPressed', inventoryKey);
        pressed.clear();
        session.dispatch('OnKeyPressed', inventoryKey);
        session.dispatch('OnKeyStartPressed', sourceKeyCode('Tab'));
        assert.equal(sourceKeyCode('Unidentified'), null);
        assert.equal(sourceKeyCode(''), null);
        assert.deepEqual(session.diagnostics().errors, []);
        session.flushSaveData();
        assert.deepEqual(saved.get('host').data.nativePlayerData.Input, { presses: 3, releases: 1 });
    } finally {
        session.close();
        host.dispose();
    }
});
