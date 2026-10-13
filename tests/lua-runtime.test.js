/** @file Native Lua checks against both real WASM VMs. Run npm run build first. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createEngine } from '../src/engine.js';
import { createLuaSession } from '../src/lua-runtime.js';
import { createModHost } from '../src/mods.js';

/**
 * Create a fixture backed by the real engine and Lua WASM VMs.
 *
 * @returns {Promise<{engine:object, host:object, session:object, saved:Map<string, unknown>}>} Real VM fixture.
 */
async function fixture() {
    const engine = await createEngine(await readFile(new URL('../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url)));
    const saved = new Map();
    const host = createModHost(engine, {
        /**
         * Read the persisted record for a package.
         *
         * @param {string} id - Package identity.
         * @returns {unknown} Persisted package record.
         */
        readModState: (id) => saved.get(id),
        /**
         * Persist a detached package record.
         *
         * @param {string} id - Package identity.
         * @param {unknown} value - Package record.
         */
        writeModState: (id, value) => {
            saved.set(id, structuredClone(value));
        },
    });
    const session = await createLuaSession();

    return { engine, host, session, saved };
}

/**
 * Activate unmodified Lua source using the host's bound API.
 *
 * @param {object} session - Lua session.
 * @param {object} host - Public mod host.
 * @param {string} source - Lua source.
 * @param {string} [id] - Native identity.
 * @returns {()=>void} Package cleanup.
 */
function activate(session, host, source, id = 'calculation') {
    return session.activatePackage({ id, nativeId: id, api: host.api, sources: [{ path: `media/lua/client/${id}/main.lua`, source }] });
}

/**
 * Load a native adapter through the real host to obtain its bound save namespace.
 *
 * @param {object} session - Real Lua session.
 * @param {object} host - Real SDK host.
 * @param {object} descriptor - Native package sources and identity.
 * @returns {Promise<void>} Completed host activation.
 */
async function loadPackage(session, host, descriptor) {
    const key = `lua-${descriptor.id}-${Date.now()}`;
    const manifest = { id: descriptor.id, version: '1.0.0', apiVersion: '0.1.0', name: descriptor.id };

    globalThis[key] = session;
    try {
        await host.load(`data:text/javascript,${encodeURIComponent(`
            export const manifest = ${JSON.stringify(manifest)};
            export function activate(api) {
                return globalThis[${JSON.stringify(key)}].activatePackage({...${JSON.stringify(descriptor)}, api});
            }
        `)}`);
    } finally {
        delete globalThis[key];
    }
}

test('unmodified Lua computes results and isolates getfenv/setfenv closures and stack levels', async () => {
    const { host, session, saved } = await fixture();

    try {
        activate(session, host, `
            local function left() return environmentValue end
            local function right() return environmentValue end
            environmentValue = 11
            setfenv(left, {environmentValue = 7})
            assert(left() == 7 and right() == 11)
            assert(getfenv(left).environmentValue == 7)
            local function scoped()
                local env = setmetatable({environmentValue = 13}, {__index = _G})
                setfenv(1, env)
                assert(getfenv(1) == env)
                return environmentValue
            end
            assert(scoped() == 13 and right() == 11)
            assert(getfenv(0) == _G)
            assert(getfenv(1) == _G)
            assert(type(TetrisEvents) == 'nil')
            local sum = 0
            for _, value in table.ipairs({2, 3, 5}) do sum = sum + value end
            local a, b = unpack({sum, 9})
            getModData().calculation = {answer = a * b, dynamic = assert(loadstring('return 6 * 7'))()}
            local oldEnv = getfenv(0)
            local otherEnv = setmetatable({value = 19}, {__index = _G})
            setfenv(0, otherEnv)
            assert(getfenv(0) == otherEnv)
            assert(loadstring('return value')() == 19)
            setfenv(0, oldEnv)
        `);
        session.flushSaveData();
        assert.equal(saved.get('host').data.nativePlayerData.calculation.answer, 90);
        assert.equal(saved.get('host').data.nativePlayerData.calculation.dynamic, 42);
        assert.equal(session.diagnostics().luaVersion, 'Lua 5.4');
    } finally {
        session.close();
        host.dispose();
    }
});

test('cross-package require preserves source names, cycles fail, and event removal uses Lua identity', async () => {
    const { host, session, saved } = await fixture();

    try {
        session.preload({
            id: 'library', nativeId: 'NativeLibrary', sources: [
                { path: 'media/lua/shared/Math/Numbers.lua', source: 'return {value = 21}', execute: false },
                { path: 'media/lua/shared/CycleA.lua', source: 'require "CycleB"', execute: false },
                { path: 'media/lua/shared/CycleB.lua', source: 'require "CycleA"', execute: false },
            ],
        });
        globalThis.luaTestLibrary = session;
        await host.load(`data:text/javascript,${encodeURIComponent(`
            export const manifest = {id: 'library', version: '1.0.0', apiVersion: '0.1.0', name: 'Library'};
            export function activate(api) {
                return globalThis.luaTestLibrary.activatePackage({id: 'library', nativeId: 'NativeLibrary', api, sources: []});
            }
        `)}`);
        delete globalThis.luaTestLibrary;
        const cleanup = activate(session, host, `
            local numbers = require 'Math/Numbers'
            local data = getModData()
            data.events = {value = numbers.value * 2, order = ''}
            local function removed() data.events.order = data.events.order .. 'X' end
            local function first() data.events.order = data.events.order .. 'A' end
            local function second() data.events.order = data.events.order .. 'B' end
            Events.OnGameStart.Add(first)
            Events.OnGameStart.Add(removed)
            Events.OnGameStart.Add(second)
            Events.OnGameStart.Remove(removed)
            Events.OnGameStart.Add(first)
        `);

        session.dispatch('OnGameStart');
        session.flushSaveData();
        assert.deepEqual(saved.get('host').data.nativePlayerData.events, { value: 42, order: 'AB' });
        cleanup();
        assert.throws(() => activate(session, host, 'require "CycleA"', 'cycle'), (error) => /NativeLibrary/.test(error.message) && /CycleA/.test(error.message) && /cycle/.test(error.message));
        assert.throws(() => activate(session, host, 'require "Absent/Module"', 'missing'), (error) => error.nativeModId === 'missing' && error.path.endsWith('main.lua') && /Absent\/Module/.test(error.message));
    } finally {
        delete globalThis.luaTestLibrary;
        session.close();
        host.dispose();
    }
});

test('synchronous Lua ticks move the compiled actor and cleanup stops callbacks', async () => {
    const { engine, host, session } = await fixture();

    try {
        const cleanup = activate(session, host, `
            local player = getSpecificPlayer(0)
            assert(player == getPlayer() and getSpecificPlayer(1) == nil)
            assert(player:getX() == 5 and player:getY() == 5)
            Events.OnTick.Add(function(tick)
                assert(tick >= 1)
                assert(getGameTime():getRealworldSecondsSinceLastUpdate() > 0)
                player:setSpeed(4)
                player:walk(1, 0)
            end)
        `);

        host.step(1 / 60);
        host.step(1 / 60);
        assert.ok(engine.snapshot().x > 5);
        assert.equal(engine.snapshot().speed, 4);
        cleanup();
        engine.setSpeed(2);
        host.step(1 / 60);
        assert.equal(engine.snapshot().speed, 2);
    } finally {
        session.close();
        host.dispose();
    }
});

test('mutable Lua player state roundtrips without wiping unrelated saved fields', async () => {
    const { host, session, saved } = await fixture();

    try {
        saved.set('host', { schemaVersion: 1, data: { unrelated: { keep: 9 }, nativePlayerData: { counter: { count: 3 } } } });
        activate(session, host, `
            local data = getPlayer():getModData()
            assert(data.counter.count == 3)
            Events.OnGameStart.Add(function() data.counter.count = data.counter.count + 1 end)
        `);
        session.dispatch('OnGameStart');
        session.flushSaveData();
        assert.equal(saved.get('host').data.nativePlayerData.counter.count, 4);
        assert.deepEqual(saved.get('host').data.unrelated, { keep: 9 });
        saved.set('host', { schemaVersion: 1, data: { unrelated: { keep: 10 }, nativePlayerData: { counter: { count: 20 } } } });
        session.restoreSaveData();
        session.dispatch('OnGameStart');
        session.close();
        assert.equal(saved.get('host').data.nativePlayerData.counter.count, 21);
        assert.deepEqual(saved.get('host').data.unrelated, { keep: 10 });
    } finally {
        session.close();
        host.dispose();
    }
});

test('unsupported native facilities, bytecode and infinite loops report native capability gaps', async () => {
    const { host, session } = await fixture();

    try {
        assert.throws(() => activate(session, host, 'getCore():getVersion()', 'ui'), (error) => error.nativeModId === 'ui' && /unsupported/.test(error.message));
        assert.throws(() => activate(session, host, 'Events.OnFillWorldObjectContextMenu.Add(function() end)', 'event'), /unsupported event/);
        assert.throws(() => activate(session, host, '\x1BLua', 'bytecode'), /bytecode/);
        assert.throws(() => activate(session, host, 'while true do end', 'timeout'), /timeout/);
        assert.ok(session.diagnostics().errors.some((error) => error.nativeModId === 'ui' && error.path.endsWith('main.lua')));
        assert.ok(session.diagnostics().timeouts >= 1);
    } finally {
        session.close();
        host.dispose();
    }
});

test('two bound native packages share player data without replacing each other save namespaces', async () => {
    const { host, session, saved } = await fixture();
    const key = `lua-${Date.now()}`;

    globalThis[key] = session;

    /**
     * Load a real JS adapter to obtain a package-bound API from the public host.
     *
     * @param {string} id - SDK namespace.
     * @param {string} source - Unmodified Lua text.
     * @returns {Promise<void>} Activation.
     */
    async function load(id, source) {
        const descriptor = JSON.stringify({ id, nativeId: id, sources: [{ path: `media/lua/client/${id}.lua`, source }] });

        await host.load(`data:text/javascript,${encodeURIComponent(`
            export const manifest = {id: '${id}', version: '1.0.0', apiVersion: '0.1.0', name: '${id}'};
            export function activate(api) {
                return globalThis[${JSON.stringify(key)}].activatePackage({...${descriptor}, api});
            }
        `)}`);
    }

    try {
        saved.set('native-a', { schemaVersion: 1, data: { retained: 7, retainedNullable: null, nativePlayerData: { a: { count: 2, array: [], nullable: null, nested: [null, { nullable: null }], escaped: 'line\n"\\' }, optional: null } } });
        await load('native-a', 'local data = getModData(); assert(data.a.count == 2); Events.OnGameStart.Add(function() data.a.count = data.a.count + 1 end)');
        await load('native-b', 'local data = getPlayer():getModData(); data.b = {count = 8}; data.a.count = data.a.count + 3; getPlayer():transmitModData()');
        session.dispatch('OnGameStart');
        session.flushSaveData();
        assert.equal(saved.get('native-a').data.retained, 7);
        assert.equal(saved.get('native-a').data.retainedNullable, null);
        assert.deepEqual(saved.get('native-a').data.nativePlayerData, { a: { count: 6, array: [], nullable: null, nested: [null, { nullable: null }], escaped: 'line\n"\\' }, optional: null });
        assert.deepEqual(saved.get('native-b').data.nativePlayerData, { b: { count: 8 } });
        host.dispose();
        session.dispatch('OnGameStart');
        assert.equal(saved.get('native-a').data.nativePlayerData.a.count, 6);
    } finally {
        delete globalThis[key];
        session.close();
        host.dispose();
    }
});

for (const restored of [false, true]) {
    test(`required preloaded state survives binding activation${restored ? ' with saved values taking precedence' : ''}`, async () => {
        const { host, session, saved } = await fixture();

        try {
            if (restored) {
                saved.set('pending-b', { schemaVersion: 1, data: { retained: null, nativePlayerData: { b: { count: 40 } } } });
            }

            session.preload({
                id: 'pending-b',
                sources: [{
                    path: 'media/lua/shared/Pending.lua', execute: false,
                    source: `
                        local data = getModData()
                        local state = {count = 7}
                        data.b = state
                        data.pendingOnly = {count = 19}
                        Events.OnGameStart.Add(function()
                            assert(data == getModData() and state == data.b)
                            state.count = state.count + 1
                            data.pendingOnly.count = data.pendingOnly.count + 1
                        end)
                        return state
                    `,
                }],
            });
            await loadPackage(session, host, {
                id: 'pending-a', sources: [{ path: 'media/lua/client/A.lua', source: 'local state = require "Pending"; state.count = 8; getModData().a = {count = 3}' }],
            });
            // Another activation must not discard state owned by still-inactive B.
            await loadPackage(session, host, {
                id: 'pending-c', sources: [{ path: 'media/lua/client/C.lua', source: 'getModData().c = {count = 5}' }],
            });
            await loadPackage(session, host, { id: 'pending-b', sources: [] });
            session.dispatch('OnGameStart');
            session.flushSaveData();
            assert.deepEqual(saved.get('pending-b').data.nativePlayerData, { b: { count: restored ? 41 : 9 }, pendingOnly: { count: 20 } });
            assert.deepEqual(saved.get('pending-a').data.nativePlayerData, { a: { count: 3 } });
            assert.deepEqual(saved.get('pending-c').data.nativePlayerData, { c: { count: 5 } });

            if (restored) {
                assert.equal(saved.get('pending-b').data.retained, null);
            }
        } finally {
            session.close();
            host.dispose();
        }
    });
}

test('deleted key ownership survives activation and restoration without mutating on saved collisions', async () => {
    const { host, session, saved } = await fixture();

    try {
        await loadPackage(session, host, {
            id: 'reserved-a', sources: [{
                path: 'media/lua/client/A.lua',
                source: `
                    local data = getModData()
                    local state = {count = 1}
                    data.a = state
                    data.reserved = {}
                    data.reserved = nil
                    Events.OnGameStart.Add(function()
                        assert(data == getModData() and state == data.a)
                        state.count = state.count + 1
                    end)
                `,
            }],
        });
        await loadPackage(session, host, {
            id: 'reserved-b', sources: [{
                path: 'media/lua/client/B.lua',
                source: 'local data = getModData(); data.b = {count = 9}; data.reserved = {count = 5}; Events.OnKeyPressed.Add(function(key) data.reserved = {count = key} end)',
            }],
        });
        session.flushSaveData();
        assert.deepEqual(saved.get('reserved-a').data.nativePlayerData, { a: { count: 1 }, reserved: { count: 5 } });
        assert.deepEqual(saved.get('reserved-b').data.nativePlayerData, { b: { count: 9 } });

        saved.set('reserved-a', { schemaVersion: 1, data: { retained: null, nativePlayerData: { a: { count: 20 } } } });
        session.restoreSaveData();
        saved.set('reserved-b', { schemaVersion: 1, data: { retained: { nullable: null }, nativePlayerData: { b: { count: 90 }, reserved: { count: 99 } } } });
        assert.throws(() => session.restoreSaveData(), (error) => error.modId === 'reserved-b' && /ownership collision/.test(error.message));
        session.dispatch('OnGameStart');
        session.dispatch('OnKeyPressed', 6);
        session.flushSaveData();
        assert.deepEqual(saved.get('reserved-a').data.nativePlayerData, { a: { count: 21 }, reserved: { count: 6 } });
        assert.equal(saved.get('reserved-a').data.retained, null);
        assert.deepEqual(saved.get('reserved-b').data.nativePlayerData, { b: { count: 9 } });
        assert.deepEqual(saved.get('reserved-b').data.retained, { nullable: null });
    } finally {
        session.close();
        host.dispose();
    }
});

for (const problem of ['oversize', 'backing write']) {
    test(`failed ${problem} cleanup unregisters native callbacks while other packages continue`, async () => {
        const { engine, host, session, saved } = await fixture();
        let rejectWrites = false;
        const brokenHost = createModHost(engine, {
            /**
             * Read the persisted namespace document.
             *
             * @param {string} id - Namespace identity.
             * @returns {object|undefined} Persisted namespace document.
             */
            readModState: (id) => saved.get(id),
            /**
             * Persist a namespace document; throws when the backing write fails.
             *
             * @param {string} id - Namespace identity.
             * @param {object} value - Namespace document.
             * @returns {void}
             */
            writeModState: (id, value) => {
                if (rejectWrites) {
                    throw new Error('storage unavailable');
                }

                saved.set(id, structuredClone(value));
            },
        });

        try {
            saved.set('healthy', { schemaVersion: 1, data: { retained: { nullable: null }, nativePlayerData: {} } });
            await loadPackage(session, host, {
                id: 'healthy', sources: [{
                    path: 'media/lua/client/Healthy.lua',
                    source: 'local data = getModData(); local state = {count = 1}; data.good = state; Events.OnGameStart.Add(function() assert(state == data.good); state.count = state.count + 1 end)',
                }],
            });
            await loadPackage(session, brokenHost, {
                id: 'broken', nativeId: 'BrokenNative', sources: [{
                    path: 'media/lua/client/Broken.lua',
                    source: `
                        local data = getModData()
                        data.bad = {count = 1}
                        Events.OnGameStart.Add(function() getPlayer():walk(0, 1) end)
                        Events.OnKeyPressed.Add(function() data.bad.payload = string.rep('x', 262145) end)
                    `,
                }],
            });
            session.flushSaveData();

            if (problem === 'oversize') {
                session.dispatch('OnKeyPressed', 1);
            } else {
                rejectWrites = true;
            }

            brokenHost.dispose();
            assert.ok(brokenHost.diagnostics().errors.some((error) => error.modId === 'broken' && error.stage === 'cleanup'));
            assert.ok(session.diagnostics().errors.some((error) => error.modId === 'broken' && error.nativeModId === 'BrokenNative' && error.path === '<save>'));
            assert.doesNotThrow(() => session.dispatch('OnGameStart'));
            session.flushSaveData();
            session.restoreSaveData();
            assert.deepEqual(saved.get('healthy').data.nativePlayerData, { good: { count: 2 } });
            assert.deepEqual(saved.get('healthy').data.retained, { nullable: null });
            assert.deepEqual(saved.get('broken').data.nativePlayerData, { bad: { count: 1 } });
            await loadPackage(session, host, {
                id: 'after-failure', sources: [{ path: 'media/lua/client/After.lua', source: 'getModData().after = {count = 7}' }],
            });
            session.dispatch('OnGameStart');
            session.close();
            assert.deepEqual(saved.get('healthy').data.nativePlayerData, { good: { count: 3 } });
            assert.deepEqual(saved.get('after-failure').data.nativePlayerData, { after: { count: 7 } });
        } finally {
            brokenHost.dispose();
            host.dispose();
            session.close();
        }
    });
}

test('nullable host callback results cross into Lua without discarding real movement operations', async () => {
    const { engine, host, session } = await fixture();
    const api = {
        ...host.api,
        movement: {
            ...host.api.movement,
            /**
             * Keep real state while exercising nullable nested callback fields.
             *
             * @returns {object} Actual movement state with nullable metadata.
             */
            getState() {
                return { ...host.api.movement.getState(), metadata: { nullable: null, values: [null] } };
            },
        },
        actions: {
            /**
             * Execute the real action with a nullable host acknowledgement.
             *
             * @param {object} action - Submitted movement.
             * @returns {null} No acknowledgement payload.
             */
            submit(action) {
                host.api.actions.submit(action);

                return null;
            },
        },
    };

    try {
        session.activatePackage({
            id: 'nullable-callbacks',
            api,
            sources: [{ path: 'media/lua/client/nullable-callbacks.lua', source: 'local player = getPlayer(); assert(player:getCurrentSpeed() > 0); player:walk(1, 0)' }],
        });
        assert.equal(engine.snapshot().action, 2);
    } finally {
        session.close();
        host.dispose();
    }
});

test('Lua movement keeps absolute imported world coordinates rather than the synthetic plane', async () => {
    const { engine, host, session } = await fixture();

    try {
        const cells = new Uint8Array(1_026);

        cells[1] = 1;
        engine.worldImportCell(2, 1, cells);
        engine.loadState({ version: 2, values: [530.5, 278.5, 3, 530.5, 278.5, 0, 0, 0, 0, 1, ...engine.saveState().values.slice(10)] });
        activate(session, host, `
            local player = getPlayer()
            assert(player:getX() == 530.5 and player:getY() == 278.5)
            player:moveTo(534.5, 278.5)
        `);

        for (let index = 0; index < 120; index += 1) {
            host.step(1 / 60);
        }

        assert.equal(engine.snapshot().x, 534.5);
        assert.equal(engine.snapshot().y, 278.5);
        assert.equal(engine.snapshot().action, 0);
    } finally {
        session.close();
        host.dispose();
    }
});

test('real input event dispatch changes engine actions and rejects unimplemented events', async () => {
    const { engine, host, session } = await fixture();

    try {
        activate(session, host, `
            Events.OnKeyPressed.Add(function(key) if key == 65 then getPlayer():walk(-1, 0) end end)
            Events.OnKeyReleased.Add(function(key) if key == 65 then getPlayer():cancelAction() end end)
        `);
        session.dispatch('OnKeyPressed', 65);
        assert.equal(engine.snapshot().action, 2);
        host.step(1 / 60);
        assert.ok(engine.snapshot().x < 5);
        session.dispatch('OnKeyReleased', 65);
        assert.equal(engine.snapshot().action, 0);
        assert.throws(() => session.dispatch('OnEnterVehicle'), /unsupported/);
        assert.throws(() => session.dispatch('OnKeyPressed', -1), /key code/);
    } finally {
        session.close();
        host.dispose();
    }
});

test('genuine death caused by a busy native movement command is delivered once after its outer tick', async () => {
    const { engine, host, session, saved } = await fixture();
    const removeHook = host.api.hooks.beforeAction((action) => action.type === 'walk' ? { type: 'setHealth', health: 0 } : undefined);

    try {
        await loadPackage(session, host, {
            id: 'nested-death', sources: [{
                path: 'media/lua/client/NestedDeath.lua',
                source: `
                    local data=getModData()
                    data.Death={ticks=0,deaths=0,finished=false}
                    Events.OnTick.Add(function()
                        data.Death.finished=false
                        getPlayer():walk(1,0)
                        data.Death.finished=true
                        data.Death.ticks=data.Death.ticks+1
                    end)
                    Events.OnPlayerDeath.Add(function(player)
                        assert(player==getPlayer() and player:isDead())
                        assert(data.Death.finished, 'death must wait until outer tick finishes')
                        data.Death.deaths=data.Death.deaths+1
                    end)
                `,
            }],
        });
        host.step(1 / 60);
        host.step(1 / 60);
        session.flushSaveData();
        assert.equal(engine.snapshot().dead, true);
        assert.deepEqual(saved.get('nested-death').data.nativePlayerData.Death, { ticks: 2, deaths: 1, finished: true });
        assert.deepEqual(session.diagnostics().errors, []);
        assert.deepEqual(host.diagnostics().errors, []);
    } finally {
        removeHook();
        session.close();
        host.dispose();
    }
});
