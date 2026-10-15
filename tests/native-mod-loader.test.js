/** Independently authored native fixtures; no installation/Workshop bytes. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createEngine } from '../src/engine.js';
import { createGameUI } from '../src/game-ui.js';
import { parseModPackage, resolveModOrder } from '../src/mod-manager.js';
import { createModHost } from '../src/mods.js';
import { activateNativePackage, bindNativeSession, closeNativeSession, discoverNativePackages, engineSources, initializeOriginalEquipment, nativePackageFiles, prepareNativeSession } from '../src/native-mod-loader.js';

/**
 * Build a private synthetic directory.
 *
 * @param {object} entries - Independently authored text by path.
 * @param {string} [version] - Observed fixture build.
 * @returns {object} Private content-like source.
 */
function directory(entries, version = '42.21.0') {
    entries = { 'media/lua/shared/NPCs/BodyLocations.lua': '', ...entries };
    const files = Object.entries(entries).map(([path, source]) => ({ path, size: new TextEncoder().encode(source).length }));
    const roots = [...new Set(files.filter(({ path }) => path.endsWith('/mod.info')).map(({ path }) => path.replace(/\/(?:common|\d+(?:\.\d+)*)\/mod.info$/, '').replace(/\/mod.info$/, '')))];

    return {
        manifest: { sourceBuild: { version }, files, mods: roots.map((root) => ({ root, kind: 'native-lua', files: files.filter(({ path }) => path.startsWith(`${root}/`)).map(({ path }) => path) })) },
        /**
         * Read an independently authored file without installation access.
         *
         * @param {string} path - Exact fixture file path.
         * @returns {object} Size and asynchronous text source.
         */
        getFile: (path) => ({
            size: files.find((file) => file.path === path).size,
            /**
             * Read fixture text with the content directory's Promise contract.
             *
             * @returns {Promise<string>} Independently authored source.
             */
            text: () => Promise.resolve(entries[path]),
        }),
    };
}

test('common plus newest compatible code tree without mod.info and root-only packages execute selected Lua', async () => {
    const content = directory({
        'mods/Overlay/common/mod.info': 'id=Overlay\nname=Overlay\nmodversion=2.0.0\nversionMin=42.0',
        'mods/Overlay/common/media/lua/client/main.lua': 'error("common must be overridden")',
        'mods/Overlay/42.13/mod.info': 'id=Overlay\nname=Overlay\nmodversion=2.0.0',
        'mods/Overlay/42.20/media/lua/client/main.lua': 'getPlayer():setSpeed(require("EngineHelper"))',
        'mods/Overlay/43/media/lua/client/main.lua': 'error("future tree")',
        'mods/Root/mod.info': 'id=Root\nname=Root\nmodversion=1.0.0\nrequire=Overlay',
        'mods/Root/media/lua/client/root.lua': 'assert(getPlayer():getCurrentSpeed() == 4); getPlayer():setSpeed(5)',
        'media/lua/shared/EngineHelper.lua': 'return require("EngineLeaf")',
        'media/lua/shared/EngineLeaf.lua': 'return 4',
        'media/lua/client/Unused.lua': 'error("engine sources must never execute eagerly")',
    });
    const descriptors = await discoverNativePackages(content);
    const records = descriptors.map((descriptor) => ({ ...descriptor.manifest, enabled: true }));

    assert.deepEqual(resolveModOrder(records, '0.1.0'), ['native-overlay', 'native-root']);
    const engine = await createEngine(await readFile(new URL('../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url)));
    const host = createModHost(engine);

    try {
        await prepareNativeSession(descriptors, content);

        const entryUrls = await Promise.all(resolveModOrder(records, '0.1.0').map(async (id) => {
            const descriptor = descriptors.find((entry) => entry.id === id);
            const parsed = await parseModPackage(nativePackageFiles(descriptor));
            const entry = parsed.entries.find((file) => file.path === 'entry.js');

            return `data:text/javascript,${encodeURIComponent(new TextDecoder().decode(entry.bytes))}`;
        }));

        await host.load(entryUrls[0]);
        await host.load(entryUrls[1]);

        assert.equal(engine.snapshot().speed, 5);
    } finally {
        closeNativeSession();
        host.dispose();
    }
});

test('missing, disabled and cyclic native requirements fail before activation', async () => {
    const content = directory({
        'mods/A/mod.info': 'id=A\nrequire=B\nloadBefore=B',
        'mods/A/media/lua/client/a.lua': 'error("must not execute")',
        'mods/B/mod.info': 'id=B',
    });
    const descriptors = await discoverNativePackages(content);
    const records = descriptors.map((entry) => ({ ...entry.manifest, enabled: true }));

    assert.throws(() => resolveModOrder(records.slice(0, 1), '0.1.0'), /not installed/);
    assert.throws(() => resolveModOrder(records.map((entry) => ({ ...entry, enabled: entry.id === 'native-a' })), '0.1.0'), /disabled/);
    assert.throws(() => resolveModOrder(records, '0.1.0'), /cycle/);
});

test('optional native ordering uses exact identities and never enables absent packages', async () => {
    for (const [field, expected] of [
        ['loadAfter=B', ['native-b', 'native-a']],
        ['loadAfter=b', ['native-a', 'native-b']],
        ['loadBefore=B', ['native-a', 'native-b']],
    ]) {
        // eslint-disable-next-line no-await-in-loop
        const descriptors = await discoverNativePackages(directory({ 'mods/A/mod.info': `id=A\n${field}`, 'mods/B/mod.info': 'id=B' }));
        const records = descriptors.map((entry) => ({ ...entry.manifest, enabled: true }));

        assert.deepEqual(resolveModOrder(records, '0.1.0'), expected);
        assert.deepEqual(resolveModOrder(records.map((entry) => ({ ...entry, enabled: entry.id === 'native-a' })), '0.1.0'), ['native-a']);
    }
});

test('unknown build discovers metadata but enabled activation is refused; identities cannot collide', async () => {
    const content = directory({ 'mods/A/42/mod.info': 'id=ExactNativeID\nmodversion=release-a', 'mods/A/42/media/lua/client/a.lua': 'error("never execute")' }, 'unknown');
    const [descriptor] = await discoverNativePackages(content);

    assert.equal(descriptor.nativeId, 'ExactNativeID');
    assert.equal(descriptor.nativeVersion, 'release-a');
    assert.match(descriptor.blocked, /sourceBuild/);
    await assert.rejects(() => prepareNativeSession([descriptor], content), /sourceBuild/);
    assert.equal(await prepareNativeSession([], content), undefined);
    const duplicate = directory({ 'mods/A/mod.info': 'id=Same', 'mods/B/mod.info': 'id=Same' });

    await assert.rejects(() => discoverNativePackages(duplicate), /identity collision/);
    const canonical = directory({ 'mods/A/mod.info': 'id=Case', 'mods/B/mod.info': 'id=case' });

    await assert.rejects(() => discoverNativePackages(canonical), /SDK id collision/);
    await assert.rejects(() => discoverNativePackages(content, ['native-exactnativeid']), /SDK id collision/);
});

test('game minimum, numeric build floors and exact native requirement case cannot be bypassed', async () => {
    const minimum = directory({ 'mods/A/mod.info': 'id=A\nversionMin=42.22', 'mods/A/media/lua/client/a.lua': 'error("must not execute")' });
    const [blocked] = await discoverNativePackages(minimum);

    await assert.rejects(() => prepareNativeSession([blocked], minimum), /versionMin 42.22/);
    const floor = directory({
        'mods/A/common/mod.info': 'id=A',
        'mods/A/42.9/media/lua/client/main.lua': 'getPlayer():setSpeed(3)',
        'mods/A/42.10/media/lua/client/main.lua': 'error("future")',
    }, '42.9.5');
    const [selected] = await discoverNativePackages(floor);

    assert.equal(selected.tree, '42.9');
    const exact = directory({ 'mods/A/mod.info': 'id=A\nrequire=b', 'mods/B/mod.info': 'id=B' });
    const descriptors = await discoverNativePackages(exact);

    assert.throws(() => resolveModOrder(descriptors.map((entry) => ({ ...entry.manifest, enabled: true })), '0.1.0'), /required dependency/);
});

test('native saved version identity is exact without encoding aliases or invented semantic upgrades', async () => {
    const descriptors = await discoverNativePackages(directory({
        'mods/A/mod.info': 'id=A\nmodversion=a',
        'mods/B/mod.info': 'id=B\nmodversion=00.0.353',
        'mods/C/mod.info': 'id=C\nmodversion=1.2.3',
        'mods/D/mod.info': 'id=D',
    }));

    assert.equal(descriptors[0].manifest.version, '00.0.353');
    assert.notEqual(descriptors[1].manifest.version, '00.0.353');
    assert.equal(descriptors[2].manifest.version, '1.2.3');
    assert.equal(descriptors[3].manifest.version, '00.0.0');
});

test('native tick changes actual WASM action, namespaces restore and closing removes prior callbacks', async () => {
    const content = directory({
        'mods/Counter/mod.info': 'id=Counter\nmodversion=1.0.0',
        'mods/Counter/media/lua/client/counter.lua': `
            local player = getPlayer()
            local data = player:getModData()
            data.Counter = data.Counter or {ticks=0, creates=0, loads=0}
            Events.OnCreatePlayer.Add(function() data.Counter.creates=data.Counter.creates+1 end)
            Events.OnLoad.Add(function() data.Counter.loads=data.Counter.loads+1 end)
            Events.OnTick.Add(function() data.Counter.ticks=data.Counter.ticks+1; player:walk(1,0) end)
        `,
    });
    const descriptors = await discoverNativePackages(content);
    const engine = await createEngine(await readFile(new URL('../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url)));
    const saved = new Map();
    const host = createModHost(engine, {
        /**
         * Read this fixture's actual host-bound persisted namespace.
         *
         * @param {string} id - SDK package identity.
         * @returns {object|undefined} Persisted schema document.
         */
        readModState: (id) => saved.get(id),
        /**
         * Retain a detached namespace so mutable VM tables cannot alias saves.
         *
         * @param {string} id - SDK package identity.
         * @param {object} value - Validated schema document.
         * @returns {void} Retains the detached schema document.
         */
        writeModState: (id, value) => {
            saved.set(id, structuredClone(value));
        },
    });

    try {
        const session = await prepareNativeSession(descriptors, content);
        // The real host binds this fixture to its own namespace through the adapter.
        const descriptor = descriptors[0];
        const parsed = await parseModPackage(nativePackageFiles(descriptor));
        const source = new TextDecoder().decode(parsed.entries.find((entry) => entry.path === 'entry.js').bytes);

        await host.load(`data:text/javascript,${encodeURIComponent(source)}`);
        session.dispatch('OnCreatePlayer', 0);
        session.dispatch('OnGameStart');
        host.step(1 / 60);
        session.flushSaveData();
        assert.equal(engine.snapshot().action, 2);
        assert.equal(saved.get('native-counter').data.nativePlayerData.Counter.ticks, 1);
        closeNativeSession();
        host.dispose();
        engine.command({ type: 'cancel' });
        host.step(1 / 60);
        assert.equal(engine.snapshot().action, 0);
        const restored = await prepareNativeSession(descriptors, content);

        await host.load(`data:text/javascript,${encodeURIComponent(source)}`);
        restored.dispatch('OnLoad');
        restored.dispatch('OnCreatePlayer', 0);
        host.step(1 / 60);
        restored.flushSaveData();
        assert.deepEqual(saved.get('native-counter').data.nativePlayerData.Counter, { ticks: 2, creates: 2, loads: 1 });
        assert.throws(() => activateNativePackage('absent', host.api), /not prepared/);
    } finally {
        closeNativeSession();
        host.dispose();
    }
});

test('cached native sources cannot activate against unknown or changed current builds', async () => {
    const original = directory({
        'mods/A/42/mod.info': 'id=A\nversionMin=42',
        'mods/A/42/media/lua/client/main.lua': 'error("cached source must not execute")',
    });
    const descriptors = await discoverNativePackages(original);
    const unknown = directory({}, 'unknown');
    const changed = directory({}, '42.22.0');

    await assert.rejects(() => prepareNativeSession(descriptors, unknown), /known current.*sourceBuild/u);
    await assert.rejects(() => prepareNativeSession(descriptors, changed), /cached sources selected.*current sourceBuild/u);
});

test('stored native dependency identities remain usable after the dependency leaves the directory index', async () => {
    const content = directory({ 'mods/A/mod.info': 'id=A\nrequire=B\nloadAfter=B' });
    const stored = [{ id: 'native-b', nativeId: 'B', manifest: { version: '1.0.0' } }];
    const [descriptor] = await discoverNativePackages(content, [], stored);
    const records = [
        { ...descriptor.manifest, enabled: true },
        { id: 'native-b', version: '1.0.0', apiVersion: '0.1.0', enabled: true, dependencies: {}, optionalDependencies: {}, conflicts: [], loadAfter: [], loadBefore: [] },
    ];

    assert.deepEqual(resolveModOrder(records, '0.1.0'), ['native-b', 'native-a']);
    assert.deepEqual(descriptor.manifest.dependencies, { 'native-b': '1.0.0' });
    assert.deepEqual(descriptor.manifest.loadAfter, ['native-b']);
    await assert.rejects(() => discoverNativePackages(content, [], [{ id: 'native-a', nativeId: 'a', manifest: { version: '1.0.0' } }]), /SDK id collision/u);
});

test('inert Lua comments and string bodies never fetch ambiguous engine pseudo-requires', async () => {
    const content = directory({
        'mods/A/mod.info': 'id=A',
        'mods/A/media/lua/client/main.lua': `
            -- require "Unused"
            --[=[ require "Unused" ]=]
            local text = 'require "Unused"'
            local long = [==[ require "Unused" ]==]
            assert(#text > 0 and #long > 0)
            getPlayer():setSpeed(require("Actual"))
        `,
        'media/lua/shared/Unused.lua': 'error("must not be fetched or executed")',
        'media/lua/client/Unused.lua': 'error("must not be fetched or executed")',
        'media/lua/shared/Actual.lua': 'return 4',
    });
    const descriptors = await discoverNativePackages(content);
    const getFile = content.getFile;
    const requests = [];
    const bounded = {
        manifest: content.manifest,
        /**
         * Record actual engine dependency reads at the content boundary.
         *
         * @param {string} path - Requested private fixture path.
         * @returns {object} Independently authored content source.
         */
        getFile: (path) => {
            requests.push(path);

            return getFile(path);
        },
    };
    const engine = await createEngine(await readFile(new URL('../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url)));
    const host = createModHost(engine);

    try {
        await prepareNativeSession(descriptors, bounded);
        const parsed = await parseModPackage(nativePackageFiles(descriptors[0]));
        const source = new TextDecoder().decode(parsed.entries.find((entry) => entry.path === 'entry.js').bytes);

        await host.load(`data:text/javascript,${encodeURIComponent(source)}`);
        assert.equal(engine.snapshot().speed, 4);
        assert.equal(requests.some((path) => path.endsWith('/Unused.lua')), false);
    } finally {
        closeNativeSession();
        host.dispose();
    }
});

test('engine getter and callbacks use their real initiator API without duplicate namespace flushes', async () => {
    const content = directory({
        'mods/A/mod.info': 'id=A',
        'mods/A/media/lua/client/a.lua': `
            local helper = require "EngineHelper"
            assert(helper.speed() == 4)
            helper.touch("A")
            Events.OnTick.Add(function() helper.touch("A") end)
        `,
        'mods/B/mod.info': 'id=B\nrequire=A',
        'mods/B/media/lua/client/b.lua': `
            local helper = require "EngineHelper"
            assert(helper.speed() == 4)
            helper.touch("B")
            Events.OnTick.Add(function() helper.touch("B") end)
        `,
        'media/lua/shared/EngineHelper.lua': `
            getPlayer():setSpeed(4)
            getModData().EngineStartup = {speed=getPlayer():getCurrentSpeed()}
            Events.OnTick.Add(function()
                getModData().EngineTicks = (getModData().EngineTicks or 0) + 1
                getPlayer():walk(1,0)
            end)
            return {
                speed=function() return getPlayer():getCurrentSpeed() end,
                touch=function(key)
                    local data=getModData()
                    data[key]=data[key] or {touches=0}
                    data[key].touches=data[key].touches+1
                end
            }
        `,
    });
    const descriptors = await discoverNativePackages(content);
    const engine = await createEngine(await readFile(new URL('../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url)));
    const saved = new Map();
    const host = createModHost(engine, {
        /**
         * Read the real SDK namespace backing.
         *
         * @param {string} id - SDK identity.
         * @returns {object|undefined} Detached schema record.
         */
        readModState: (id) => saved.get(id),
        /**
         * Capture actual namespace writes without returning a value to the SDK.
         *
         * @param {string} id - SDK identity.
         * @param {object} value - Validated detached schema record.
         * @returns {void}
         */
        writeModState: (id, value) => {
            saved.set(id, structuredClone(value));
        },
    });

    try {
        const session = await prepareNativeSession(descriptors, content);
        const entryUrls = await Promise.all(descriptors.map(async (descriptor) => {
            const parsed = await parseModPackage(nativePackageFiles(descriptor));
            const entry = parsed.entries.find((file) => file.path === 'entry.js');

            return `data:text/javascript,${encodeURIComponent(new TextDecoder().decode(entry.bytes))}`;
        }));

        await host.load(entryUrls[0]);
        await host.load(entryUrls[1]);
        host.step(1 / 60);
        session.flushSaveData();
        assert.equal(engine.snapshot().action, 2);
        assert.deepEqual(saved.get('native-a').data.nativePlayerData, { EngineStartup: { speed: 4 }, EngineTicks: 1, A: { touches: 2 } });
        assert.deepEqual(saved.get('native-b').data.nativePlayerData, { B: { touches: 2 } });
        assert.equal(session.diagnostics().errors.length, 0);
    } finally {
        closeNativeSession();
        host.dispose();
    }
});

test('failed staged load retains committed Lua closure initialization and callbacks without bootstrap replay', async () => {
    const content = directory({
        'mods/Ready/mod.info': 'id=Ready',
        'mods/Ready/media/lua/client/ready.lua': `
            local ready=false
            local data=getModData()
            data.Ready=data.Ready or {ticks=0, starts=0}
            Events.OnGameStart.Add(function() ready=true; data.Ready.starts=data.Ready.starts+1 end)
            Events.OnLoad.Add(function() error("owned load failure") end)
            Events.OnTick.Add(function()
                assert(ready, "committed closure initialization was lost")
                data.Ready.ticks=data.Ready.ticks+1
                getPlayer():walk(1,0)
            end)
        `,
    });
    const descriptors = await discoverNativePackages(content);
    const bytes = await readFile(new URL('../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url));
    const engine = await createEngine(bytes);
    const targetEngine = await createEngine(bytes);
    const saved = new Map();
    const host = createModHost(engine, {
        /**
         * Read the committed session's actual namespace backing.
         *
         * @param {string} id - SDK identity.
         * @returns {object|undefined} Stored schema document.
         */
        readModState: (id) => saved.get(id),
        /**
         * Retain the committed namespace separately from the candidate.
         *
         * @param {string} id - SDK identity.
         * @param {object} value - Detached schema document.
         * @returns {void}
         */
        writeModState: (id, value) => {
            saved.set(id, structuredClone(value));
        },
    });
    const targetHost = createModHost(targetEngine);
    let committed;
    let target;

    try {
        committed = await prepareNativeSession(descriptors, content);
        const parsed = await parseModPackage(nativePackageFiles(descriptors[0]));
        const entry = parsed.entries.find((file) => file.path === 'entry.js');
        const url = `data:text/javascript,${encodeURIComponent(new TextDecoder().decode(entry.bytes))}`;

        await host.load(url);
        committed.dispatch('OnGameStart');
        host.step(1 / 60);
        target = await prepareNativeSession(descriptors, content, { staged: true });
        await targetHost.load(url);
        assert.throws(() => target.dispatch('OnLoad'), /owned load failure/u);
        target.close({ discardSaveData: true });
        targetHost.dispose();
        bindNativeSession(committed, descriptors);
        host.step(1 / 60);
        committed.flushSaveData();
        assert.equal(engine.snapshot().action, 2);
        assert.equal(committed.diagnostics().errors.length, 0);
        assert.equal(host.diagnostics().errors.length, 0);
        assert.deepEqual(saved.get('native-ready').data.nativePlayerData.Ready, { ticks: 2, starts: 1 });
    } finally {
        target?.close({ discardSaveData: true });
        bindNativeSession(committed, descriptors);
        closeNativeSession();
        host.dispose();
        targetHost.dispose();
    }
});

test('bootstrap require closure merges identical records without fetching or installing modules twice', async () => {
    const content = directory({
        'mods/A/mod.info': 'id=A',
        'mods/A/media/lua/client/a.lua': 'require "Startup"',
        'media/lua/shared/Startup.lua': 'error("supplied startup must not be refetched")',
        'media/lua/shared/Leaf.lua': 'return require "Tail"',
        'media/lua/shared/Tail.lua': 'return 7',
        'media/lua/client/Unused.lua': 'error("unreachable")',
    });
    const descriptors = await discoverNativePackages(content);
    const startup = { path: 'media/lua/shared/Startup.lua', source: 'require "Leaf"', execute: true };
    const sources = await engineSources(descriptors, content, [startup, { ...startup }]);

    assert.deepEqual(sources.map(({ path, execute }) => ({ path, execute })), [
        { path: startup.path, execute: true },
        { path: 'media/lua/shared/Leaf.lua', execute: false },
        { path: 'media/lua/shared/Tail.lua', execute: false },
    ]);
    assert.deepEqual(await engineSources(descriptors, content, sources), sources);
    await assert.rejects(() => engineSources(descriptors, content, [startup, { ...startup, source: 'return 8' }]), /changed|conflict/u);
    await assert.rejects(() => engineSources(descriptors, content, [startup, { ...startup, path: 'media/lua/client/Startup.lua' }]), /ambiguous/ui);
});

test('literal closure follows native case-insensitive exact paths without inventing suffix aliases', async () => {
    const content = directory({
        'mods/A/mod.info': 'id=A',
        'mods/A/media/lua/client/a.lua': 'require "body/entry"; require "BODY/ENTRY.lua"',
        'media/lua/shared/Body/Entry.lua': `
            -- require "Unused"
            local text = "require 'Unused'"
            require --[[ original-style trivia ]] ("ISUI/MissingSibling")
            require 'Vehicles/ISUI/Vehicle'
        `,
        'media/lua/client/Vehicles/ISUI/MissingSibling.lua': 'error("not an exact required path")',
        'media/lua/client/Vehicles/ISUI/Vehicle.lua': 'return require [[timedactions\\leaf.lua]]',
        'media/lua/shared/TimedActions/Leaf.lua': 'require "BODY/ENTRY"; return 7',
        'media/lua/client/Unused.lua': 'error("unreachable")',
    });
    const descriptors = await discoverNativePackages(content);
    const sources = await engineSources(descriptors, content);

    assert.deepEqual(sources.map(({ path, execute }) => ({ path, execute })), [
        { path: 'media/lua/shared/Body/Entry.lua', execute: false },
        { path: 'media/lua/client/Vehicles/ISUI/Vehicle.lua', execute: false },
        { path: 'media/lua/shared/TimedActions/Leaf.lua', execute: false },
    ]);
    assert.deepEqual(await engineSources(descriptors, content, sources), sources);
});

test('case-only engine path collisions are refused rather than selecting a manifest entry', async () => {
    const content = directory({
        'mods/A/mod.info': 'id=A',
        'mods/A/media/lua/client/a.lua': 'require "helper"',
        'media/lua/shared/Helper.lua': 'return 1',
        'media/lua/shared/helper.lua': 'return 2',
    });
    const descriptors = await discoverNativePackages(content);

    await assert.rejects(engineSources(descriptors, content), /Ambiguous engine Lua require name/u);
});

test('ordered engine startup runs once through the initiating real package API before native globals are consumed', async () => {
    const content = directory({
        'mods/A/mod.info': 'id=A',
        'mods/A/media/lua/client/a.lua': 'assert(StartupValue == 7); assert(require("Startup") == true); getPlayer():setSpeed(4)',
        'mods/B/mod.info': 'id=B\nrequire=A',
        'mods/B/media/lua/client/b.lua': 'assert(StartupValue == 7); assert(getModData().Boot.starts == 1); getPlayer():setSpeed(5)',
        'media/lua/shared/Leaf.lua': 'return 7',
    });
    const descriptors = await discoverNativePackages(content);
    const engine = await createEngine(await readFile(new URL('../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url)));
    const initialSpeed = engine.snapshot().speed;
    const saved = new Map();
    const host = createModHost(engine, {
        /**
         * Read a package's last detached save document.
         *
         * @param {string} id - Host package identity.
         * @returns {object|undefined} Previously persisted document, if any.
         */
        readModState: (id) => saved.get(id),
        /**
         * Persist a detached save document for the owning package.
         *
         * @param {string} id - Host package identity.
         * @param {object} value - Package save document, including native player data.
         */
        writeModState: (id, value) => {
            saved.set(id, structuredClone(value));
        },
    });
    const ui = createGameUI();

    ui.setViewport(100, 80);
    ui.initialize({
        textures: [{ path: 'authored-atlas', width: 16, height: 16 }],
        font: { atlasPath: 'authored-atlas', descriptor: 'info face="Authored" size=10\ncommon lineHeight=12 base=9 scaleW=16 scaleH=16 pages=1 packed=0\npage id=0 file="authored.png"\nchars count=1\nchar id=65 x=0 y=0 width=6 height=8 xoffset=0 yoffset=0 xadvance=7 page=0 chnl=15' },
        translations: {},
        settings: { moodleSize: 1, fontSizeReal: 1, lockFPS: 60, gray: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, goodHighlight: { r: 0, g: 1, b: 0, a: 1 }, badHighlight: { r: 1, g: 0, b: 0, a: 1 } },
    });
    try {
        const session = await prepareNativeSession(descriptors, content, {
            ui,
            engineSources: [
                {
                    path: 'media/lua/shared/Startup.lua', source: `
                    StartupValue = require "Leaf"
                    getModData().Boot = {starts=1, ticks=0, speed=getPlayer():getCurrentSpeed()}
                    Events.OnTick.Add(function() getModData().Boot.ticks=getModData().Boot.ticks+1 end)
                `,
                },
                {
                    path: 'media/lua/client/StartupUI.lua', source: `
                    assert(StartupValue == 7)
                    local target={render=function(self) self.javaObject:DrawTextureScaledColor(nil,0,0,7,3,1,1,1,1) end}
                    target.javaObject=UIElement.new(target)
                    UIManager.AddUI(target.javaObject)
                `,
                },
            ],
        });

        assert.equal(engine.snapshot().speed, initialSpeed);

        for (const descriptor of descriptors) {
            // eslint-disable-next-line no-await-in-loop -- Parse and activate each dependency before preparing its dependent package.
            const parsed = await parseModPackage(nativePackageFiles(descriptor));
            const source = new TextDecoder().decode(parsed.entries.find((entry) => entry.path === 'entry.js').bytes);

            // eslint-disable-next-line no-await-in-loop -- Package B requires A's completed activation and genuine startup API.
            await host.load(`data:text/javascript,${encodeURIComponent(source)}`);
        }

        host.step(1 / 60);
        session.flushSaveData();
        assert.equal(engine.snapshot().speed, 5);
        assert.deepEqual(saved.get('native-a').data.nativePlayerData.Boot, { starts: 1, ticks: 1, speed: initialSpeed });
        assert.deepEqual(saved.get('native-b').data.nativePlayerData, {});
        assert.equal(ui.render()[0].width, 7);
        host.dispose();
        assert.deepEqual(ui.render(), []);
    } finally {
        closeNativeSession({ discardSaveData: true });
        host.dispose();
        ui.dispose();
    }
});

test('failed engine startup discards only staged VM and retains initiating API/source attribution', async () => {
    const content = directory({
        'mods/A/mod.info': 'id=A',
        'mods/A/media/lua/client/a.lua': 'Events.OnTick.Add(function() getPlayer():walk(1,0) end)',
    });
    const descriptors = await discoverNativePackages(content);
    const bytes = await readFile(new URL('../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url));
    const engine = await createEngine(bytes);
    const targetEngine = await createEngine(bytes);
    const host = createModHost(engine);
    const targetHost = createModHost(targetEngine);
    let committed;
    let candidate;

    try {
        committed = await prepareNativeSession(descriptors, content);
        activateNativePackage(descriptors[0].id, host.api);
        candidate = await prepareNativeSession(descriptors, content, {
            staged: true,
            engineSources: [{ path: 'media/lua/shared/Startup.lua', source: 'getModData().CandidateOnly = {}; error("startup failed")' }],
        });
        assert.throws(() => activateNativePackage(descriptors[0].id, targetHost.api), (error) => {
            assert.equal(error.modId, 'engine-lua');
            assert.equal(error.apiModId, descriptors[0].id);
            assert.equal(error.path, 'media/lua/shared/Startup.lua');

            return /startup failed/u.test(error.message);
        });
        assert.throws(() => candidate.activatePackage({ ...descriptors[0], api: targetHost.api }), /closed/u);
        bindNativeSession(committed, descriptors);
        host.step(1 / 60);
        assert.equal(engine.snapshot().action, 2);
        assert.equal(committed.diagnostics().errors.length, 0);
    } finally {
        candidate?.close({ discardSaveData: true });
        bindNativeSession(committed, descriptors);
        closeNativeSession({ discardSaveData: true });
        host.dispose();
        targetHost.dispose();
    }
});

test('native session shares original MoodleType constants with the actual character domain', async () => {
    const content = directory({
        'mods/A/mod.info': 'id=A',
        'mods/A/media/lua/client/a.lua': 'assert(MoodleType.FOOD_EATEN == "base:foodeaten"); assert(getPlayer():getMoodles():getMoodleLevel(MoodleType.UNHAPPY) == 3)',
    });
    const descriptors = await discoverNativePackages(content);
    const engine = await createEngine(await readFile(new URL('../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url)));
    const host = createModHost(engine);

    try {
        engine.command({ type: 'setCharacterStat', name: 'unhappiness', value: 80 });
        await prepareNativeSession(descriptors, content);
        activateNativePackage(descriptors[0].id, host.api);
    } finally {
        closeNativeSession({ discardSaveData: true });
        host.dispose();
    }
});

test('manifest equipment startup runs headlessly with no mods and skips authoritative reinitialization', async () => {
    const content = directory({
        'media/lua/shared/NPCs/BodyLocations.lua': `
            local group = BodyLocations.getGroup("Human")
            assert(group:size() == 0)
            group:getOrCreateLocation(ItemBodyLocation.HAT)
            group:getOrCreateLocation(ItemBodyLocation.SHOES)
        `,
    });
    const engine = await createEngine(await readFile(new URL('../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url)));
    const host = createModHost(engine);

    try {
        const session = await prepareNativeSession([], content, { coreApi: host.coreApi });
        const group = engine.equipmentOperation('groupGet', 'Human');
        const shoes = engine.equipmentOperation('lookup', 'Shoes');

        assert.ok(session);
        assert.equal(engine.equipmentOperation('initialized'), true);
        assert.equal(engine.equipmentOperation('locationCount', group), 2);
        engine.equipmentOperation('move', group, shoes, 0);
        const legacyEngine = await createEngine(await readFile(new URL('../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url)));

        await initializeOriginalEquipment(legacyEngine, content);
        assert.equal(legacyEngine.equipmentOperation('initialized'), true);
        assert.equal(legacyEngine.equipmentOperation('locationCount', legacyEngine.equipmentOperation('groupGet', 'Human')), 2);
        closeNativeSession({ discardSaveData: true });
        await initializeOriginalEquipment(engine, content);
        const rebuilt = await prepareNativeSession([], content, { coreApi: host.coreApi });

        assert.equal(engine.equipmentOperation('locationAt', group, 0), shoes);
        assert.equal(engine.equipmentOperation('locationCount', group), 2);
        rebuilt.activatePackage({
            id: 'consumer', nativeId: 'consumer', api: host.api,
            sources: [{ path: 'media/lua/client/Consumer.lua', source: 'require "NPCs/BodyLocations"; assert(BodyLocations.getGroup("Human"):getLocationByIndex(0):getId()==ItemBodyLocation.SHOES)' }],
        });
    } finally {
        closeNativeSession({ discardSaveData: true });
        host.dispose();
    }
});

test('native equipment startup refuses a missing original manifest source before activating any package', async () => {
    const content = directory({ 'mods/A/mod.info': 'id=A', 'mods/A/media/lua/client/A.lua': 'getPlayer():setSpeed(3)' });
    const descriptors = await discoverNativePackages(content);

    content.manifest.files = content.manifest.files.filter(({ path }) => path !== 'media/lua/shared/NPCs/BodyLocations.lua');
    await assert.rejects(prepareNativeSession(descriptors, content, { staged: true }), /BodyLocations.*found 0/u);
});
