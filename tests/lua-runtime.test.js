/** @file Native Lua checks against both real WASM VMs. Run npm run build first. */
import assert from 'node:assert/strict';
import { openAsBlob } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createEngine } from '../src/engine.js';
import { createGameUI } from '../src/game-ui.js';
import { parseItemDefinitions } from '../src/item-definitions.js';
import { createLuaSession } from '../src/lua-runtime.js';
import { createModHost } from '../src/mods.js';
import { loadNativeGameResources } from '../src/native-game-resources.js';
import { canvasContentBox, parsePngHeader } from '../src/renderer.js';
import { createSourceFiles } from '../src/source-files.js';
import { tileScreenPosition } from '../src/tile-renderer.js';
import { completeActions, importPickupSquares, menuDocument } from './queue-test-helpers.js';

/**
 * Create a fixture backed by the real engine and Lua WASM VMs.
 *
 * @param {object} [options] - Actual Lua UI/context facilities for a consumer fixture.
 * @returns {Promise<{engine:object, host:object, session:object, saved:Map<string, unknown>}>} Real VM fixture.
 */
async function fixture(options = {}) {
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
    const session = await createLuaSession({
        sourceActions: engine.sourceActions, sourceTiming: engine.sourceTiming, ...options,
    });

    return { engine, host, session, saved };
}

/**
 * Read the genuine private resource fixture without copying original bytes into the repository.
 *
 * @param {object} t - Native test context for absent private content.
 * @returns {Promise<object|undefined>} Original content host, or an explicit private-content skip.
 */
async function privateOriginalContent(t) {
    let manifest;

    try {
        manifest = JSON.parse(await readFile(new URL('../content/manifest.json', import.meta.url), 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }

        t.skip('Requires privately provisioned original Lua; no original bytes are committed.');

        return;
    }

    return {
        manifest,
        /**
         * Read untouched original text from the private content directory.
         *
         * @param {string} path - Manifest-owned original resource.
         * @returns {object} Manifest-sized private file with genuine text and binary slices.
         */
        getFile: (path) => {
            const entry = manifest.files.find((item) => item.path === path);
            const url = new URL(`../content/${path}`, import.meta.url);

            return {
                size: entry.size,
                /**
                 * Read the selected private original file.
                 *
                 * @returns {Promise<string>} Unchanged source text.
                 */
                text: () => readFile(url, 'utf8'),
                /**
                 * Expose bounded file-backed bytes without retaining an entire original pack.
                 *
                 * @param {number} start - First byte.
                 * @param {number} end - Exclusive end byte.
                 * @returns {{arrayBuffer:()=>Promise<ArrayBuffer>}} Genuine original slice.
                 */
                slice: (start, end) => ({
                    /**
                     * Read only the selected original byte range.
                     *
                     * @returns {Promise<ArrayBuffer>} Original bytes.
                     */
                    arrayBuffer: async () => (await openAsBlob(url)).slice(start, end).arrayBuffer(),
                }),
                /**
                 * Retain the actual selected original image for the resource loader.
                 *
                 * @returns {Promise<File>} File-backed original bytes.
                 */
                toFile: async () => new File([await openAsBlob(url)], path.slice(path.lastIndexOf('/') + 1)),
            };
        },
    };
}

/**
 * Count actual native UI lifetime operations without substituting their implementation.
 *
 * @param {object} ui - Initialized real UI host.
 * @returns {{ui:object, counts:object}} Delegating UI host and observed allocation/release counts.
 */
function observeUiLifetime(ui) {
    const counts = { new: 0, release: 0, transitionNew: 0, transitionRelease: 0 };

    return {
        counts,
        ui: {
            ...ui,
            bindings: {
                ...ui.bindings,
                /**
                 * Delegate every operation before recording successful lifetime calls.
                 *
                 * @param {string} operation - Native UI operation.
                 * @param {string} owner - Actual source owner.
                 * @param {...unknown} args - Native operation arguments.
                 * @returns {unknown} The unchanged native result.
                 */
                call(operation, owner, ...args) {
                    const result = ui.bindings.call(operation, owner, ...args);

                    if (Object.hasOwn(counts, operation)) {
                        counts[operation] += 1;
                    }

                    return result;
                },
            },
        },
    };
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

/**
 * Load authored source with its real package-bound API and independent save namespace.
 *
 * @param {object} session - Resident Lua VM.
 * @param {object} host - Real SDK host.
 * @param {string} source - Authored source.
 * @param {string} id - Exact native and SDK owner.
 * @returns {Promise<void>} Completed activation.
 */
function loadSource(session, host, source, id) {
    return loadPackage(session, host, {
        id, nativeId: id, sources: [{ path: `media/lua/client/${id}/main.lua`, source }],
    });
}

test('original timSort preserves resident values and the native boolean comparator contract', async () => {
    const { host, session } = await fixture();

    try {
        await loadSource(session, host, `
            assert(type(timSort)=='function','LuaManager exposes timSort before original consumers run')
            local calls=0
            local function counted() calls=calls+1; return true end
            assert(timSort({},counted)==nil)
            local single={{}}
            assert(timSort(single,counted)==nil and calls==0)
            local untouched={2,1}
            timSort(untouched,nil)
            assert(untouched[1]==2 and untouched[2]==1)
            local snapshot={3,1,2}
            timSort(snapshot,function(a,b)
                assert(snapshot[1]==3 and snapshot[2]==1 and snapshot[3]==2,
                    'native sorting must not mutate the caller table during comparisons')
                return a<b
            end)
            assert(snapshot[1]==1 and snapshot[2]==2 and snapshot[3]==3)
            local named={3,1,label=2}
            timSort(named,function(a,b) return a<b end)
            assert(named[1]==1 and named[2]==2 and named[3]==3 and named.label==2,
                'native delegate values include named entries without clearing their original keys')
            local values={}
            for i=1,96 do
                local value={key=(97-i)%7,ordinal=i}
                value.self=value
                values[i]=value
            end
            local originalSort=table.sort
            table.sort=function() error('timSort must not use unstable Lua table.sort') end
            timSort(values,function(a,b)
                assert(a.self==a and b.self==b,'comparator operands must retain Lua identity')
                return a.key<b.key
            end)
            table.sort=originalSort
            for i=2,#values do
                assert(values[i-1].key<=values[i].key)
                if values[i-1].key==values[i].key then
                    assert(values[i-1].ordinal<values[i].ordinal,'equivalent items must keep their original order')
                end
            end
            local same={}
            timSort({same,same},function() calls=calls+1; error('Objects.equals bypasses the Lua comparator') end)
            assert(calls==0,'identical resident objects must bypass the Lua comparator')
            local falseOrder={3,2,1}
            timSort(falseOrder,function() return 1 end)
            assert(falseOrder[1]==3 and falseOrder[2]==2 and falseOrder[3]==1,
                'pcallBoolean accepts only Boolean.TRUE, not truthy Lua numbers')
            local failed={3,2,1}
            local failedCalls=0
            timSort(failed,function() failedCalls=failedCalls+1; error('original pcallBoolean failure') end)
            assert(failedCalls>0,'failed comparisons must exercise the original protected-call path')
            assert(failed[1]==3 and failed[2]==2 and failed[3]==1,
                'original pcallBoolean turns a failed comparison into non-TRUE')
        `, 'native-timsort-contract');
        assert.deepEqual(session.diagnostics().errors, []);
    } finally {
        session.close();
        host.dispose();
    }
});

test('original string sort drives case-sensitive Java UTF-16 inventory-name ordering', async () => {
    const { host, session, saved } = await fixture();

    try {
        await loadSource(session, host, `
            local names={'alpha','Zed','\u{10000}','\u{E000}','Äther'}
            table.sort(names,function(a,b) return string.sort(a,b) end)
            getModData().SortedNames=names
            assert(not string.sort('same','same'))
            assert(string.sort('alpha','Zed') and not string.sort('Zed','alpha'))
            assert(not string.sort('\u{10000}','\u{E000}'),'Java compares UTF-16 units, not Lua UTF-8 bytes')
            assert(not pcall(function() string.sort(nil,'name') end))
            assert(not pcall(function() string.sort('name') end))
            assert(not pcall(function() string.sort({},'name') end))
            assert(not pcall(function() string.sort(1,'name') end),'unimplemented Java numeric formatting must remain unsupported')
        `, 'inventory-name-sort');
        session.flushSaveData();
        assert.deepEqual(saved.get('inventory-name-sort').data.nativePlayerData.SortedNames, ['\u{E000}', '\u{10000}', 'Äther', 'alpha', 'Zed']);
    } finally {
        session.close({ discardSaveData: true });
        host.dispose();
    }
});

test('native actor aim clearing preserves held input and reasserts through the live binding resolver', async () => {
    const pressed = new Set();
    const bindings = Object.fromEntries([['Aim', 30], ['Run', 19], ['Sprint', 31]].map(([name, keyValue]) => [
        name, { keyValue, altKey: 0, shift: false, ctrl: false, alt: false },
    ]));
    const { engine, host, session } = await fixture({
        sourceWorldContext: {
            /**
             * Report the fixture's actual controller assignment.
             *
             * @returns {number} Unassigned controller identity.
             */
            joypadBind: () => -1,
            /**
             * Read a configured native keyboard binding.
             *
             * @param {string} name - Original binding identity.
             * @returns {object|null} Current configured record.
             */
            keyBinding: (name) => bindings[name] ?? null,
            /**
             * Read the configured primary-key collision records.
             *
             * @returns {object} Current binding records.
             */
            keyBindings: () => bindings,
            /**
             * Read the current physical native keyboard state.
             *
             * @param {number} code - Original native key code.
             * @returns {boolean} Whether the key is currently held.
             */
            isSourceKeyDown: (code) => pressed.has(code),
        },
    });

    try {
        session.activatePackage({ id: 'pz-base-game', nativeId: 'ProjectZomboid', api: host.coreApi, sources: [] });
        pressed.add(30);
        session.updateActorInput();
        activate(session, host, `
            assert(getPlayer():isAiming())
            getPlayer():setForceAim(true)
            assert(getPlayer():isForceAim())
            assert(select('#',getPlayer():nullifyAiming())==0,'the genuine mutation is void')
            assert(not getPlayer():isAiming() and not getPlayer():isForceAim())
            assert(not pcall(function() getPlayer():setIsAiming(1) end))
            assert(not pcall(function() getPlayer():setForceAim('true') end))
        `, 'native-actor-clear');
        assert.deepEqual(engine.sourceActions.actorInputState(0), {
            forceAim: false, charging: false, rawAiming: false, aiming: false,
            cachedAiming: true, cachedCharging: true, aimDown: true,
        }, 'clearing current actor fields must not erase cached or physical input');
        session.updateActorInput();
        activate(session, host, `
            assert(getPlayer():isAiming(),'held physical aim must reassert on the next real ingress')
            getPlayer():setForceAim(true)
        `, 'native-actor-reassert');
        pressed.clear();
        session.updateActorInput();
        activate(session, host, `
            assert(getPlayer():isAiming() and getPlayer():isForceAim(),'force aim is a genuine independent input producer')
            assert(getPlayer():toggleForceAim()==false)
            assert(getPlayer():isAiming(),'toggling force alone does not rewrite the current actor field')
        `, 'native-actor-force');
        session.updateActorInput();
        activate(session, host, `
            assert(not getPlayer():isAiming())
            getPlayer():setIsAiming(true)
            assert(getPlayer():isAiming(),'the public raw setter must reach the native owner')
            getPlayer():nullifyAiming()
            assert(not getPlayer():isAiming())
        `, 'native-actor-raw');

        for (const code of [19, 31]) {
            pressed.add(code);
            activate(session, host, 'getPlayer():setForceAim(true)', `native-actor-run-${code}`);
            session.updateActorInput();
            assert.equal(engine.sourceActions.actorInputState(0).forceAim, false);
            assert.equal(engine.sourceActions.actorIsAiming(0), true, 'original input caches aim before run/sprint clears force');
            session.updateActorInput();
            assert.equal(engine.sourceActions.actorIsAiming(0), false);
            pressed.delete(code);
        }

        assert.deepEqual(session.diagnostics().errors, []);
    } finally {
        session.close({ discardSaveData: true });
        host.dispose();
    }
});

test('Lua known poison honors source tags on non-Food and rejects forged player, item and world identities', async () => {
    const { engine, host, session } = await fixture();
    const definitions = parseItemDefinitions(`module PoisonFixture {
        item Ordinary { ItemType = base:clothing, }
        item Visible { ItemType = Normal, Tags = ShowPoison, }
        item Hidden { ItemType = Normal, Tags = ShowPoison;NoDetect, }
    }`, { path: 'poison-consumer.txt' });

    importPickupSquares(engine);

    for (const definition of definitions) {
        engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, ...definition }, { owner: 'fixture' });
        host.api.items.spawn({ fullType: definition.fullType, x: 5, y: 5 });
    }

    try {
        activate(session, host, `
            local player=getPlayer()
            local world=getCell():getGridSquare(5,5,0):getWorldObjects()
            PoisonOrdinary=world:get(0):getItem()
            local visible=world:get(1):getItem()
            local hidden=world:get(2):getItem()
            assert(not player:isKnownPoison(PoisonOrdinary))
            assert(player:isKnownPoison(visible), 'tag must precede actual non-Food class rejection')
            assert(not player:isKnownPoison(hidden), 'NoDetect wins even with ShowPoison')
            assert(not pcall(function() player:isKnownPoison(nil) end))
            assert(not pcall(function() player:isKnownPoison({getID=function() return visible:getID() end}) end))
            assert(not pcall(function() player:isKnownPoison(world:get(1)) end))
            assert(not pcall(function() player.isKnownPoison({},visible) end))
            local forgedPlayer=setmetatable({}, {__eq=function() return true end})
            assert(not pcall(function() player.isKnownPoison(forgedPlayer,visible) end))
            setmetatable(world:get(1), {__eq=function() return true end})
            assert(not pcall(function() player:isKnownPoison(world:get(1)) end), 'equality metamethod cannot forge an InventoryItem')
            PoisonOrdinary.IsFood=function() return true end
            assert(not player:isKnownPoison(PoisonOrdinary), 'mutable Lua method cannot forge concrete native class')
        `, 'known-poison-consumer');
        engine.registerItemDefinition({ ...engine.getItemDefinition(definitions[0].fullType), tags: ['ShowPoison'] },
            { owner: 'fixture', override: true });
        activate(session, host, `
            assert(getPlayer():isKnownPoison(PoisonOrdinary), 'all callers observe live definition tag authority')
        `, 'known-poison-live-tags');
        assert.deepEqual(session.diagnostics().errors, []);
        assert.deepEqual(host.diagnostics().errors, []);
    } finally {
        session.close();
        host.dispose();
    }
});

test('Lua literature predicate uses native class and rejects forged inventory receivers', async () => {
    const { engine, host, session } = await fixture();
    const definition = parseItemDefinitions(`module LiteratureFixture {
        item Literature { ItemType = Normal, DisplayCategory = Literature, Tags = Literature, }
    }`, { path: 'literature-consumer.txt' })[0];

    importPickupSquares(engine);
    engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, ...definition, sourceCategory: 'Literature' }, { owner: 'fixture' });
    host.api.items.spawn({ fullType: definition.fullType, x: 5, y: 5 });
    try {
        activate(session, host, `
            local world=getCell():getGridSquare(5,5,0):getWorldObjects():get(0)
            LiteratureOrdinary=world:getItem()
            local predicate=LiteratureOrdinary.IsLiterature
            assert(not predicate(LiteratureOrdinary), 'name, tag and category cannot forge Literature class')
            assert(not pcall(function() predicate(nil) end))
            assert(not pcall(function() predicate({getID=function() return LiteratureOrdinary:getID() end}) end))
            assert(not pcall(function() predicate(world) end), 'world item identity is not an InventoryItem receiver')
            setmetatable(world, {__eq=function() return true end})
            assert(not pcall(function() predicate(world) end), 'equality metamethod cannot forge native identity')
            LiteratureOrdinary:setDisplayCategory('Books')
            assert(not predicate(LiteratureOrdinary))
        `, 'literature-class-consumer');
        const before = engine.getItemDefinition(definition.fullType);

        assert.throws(() => engine.registerItemDefinition({ ...before, type: 'base:literature', weight: 9 },
            { owner: 'fixture', override: true }), /unsupported/i);
        activate(session, host, `
            assert(not LiteratureOrdinary:IsLiterature(), 'refused override preserves the resident native class')
        `, 'literature-class-refused-override');
        assert.deepEqual(session.diagnostics().errors, []);
        assert.deepEqual(host.diagnostics().errors, []);
    } finally {
        session.close();
        host.dispose();
    }
});

test('Lua media progress validates genuine player and item identities and refuses unresolved recorded media', async () => {
    const { engine, host, session } = await fixture();
    const definitions = parseItemDefinitions(`module MediaFixture {
        item Ordinary { ItemType = base:normal, }
        item VHS { ItemType = base:normal, MediaCategory = Retail-VHS, }
    }`, { path: 'media-progress-consumer.txt' });

    importPickupSquares(engine);

    for (const definition of definitions) {
        engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, ...definition }, { owner: 'fixture' });
        host.api.items.spawn({ fullType: definition.fullType, x: 5, y: 5 });
    }

    try {
        activate(session, host, `
            local player=getPlayer()
            local world=getCell():getGridSquare(5,5,0):getWorldObjects()
            local ordinary=world:get(0):getItem()
            local media=world:get(1):getItem()
            local forged=setmetatable({}, {__eq=function() return true end})
            setmetatable(world:get(0), {__eq=function() return true end})
            for _,method in ipairs({'hasBeenSeen','hasBeenHeard'}) do
                local predicate=ordinary[method]
                assert(not predicate(ordinary,player), 'non-recorded source instances have no media progress')
                assert(not pcall(function() predicate(ordinary,nil) end))
                assert(not pcall(function() predicate(ordinary,forged) end))
                assert(not pcall(function() predicate(nil,player) end))
                assert(not pcall(function() predicate({getID=function() return ordinary:getID() end},player) end))
                assert(not pcall(function() predicate(world:get(0),player) end), 'world object cannot forge InventoryItem identity')
                assert(not pcall(function() predicate(media,player) end), 'unresolved recorded media must not become a false unseen flag')
            end
        `, 'media-progress-consumer');
        assert.deepEqual(session.diagnostics().errors, []);
        assert.deepEqual(host.diagnostics().errors, []);
    } finally {
        session.close();
        host.dispose();
    }
});

test('Lua map-read predicate preserves source null behavior and validates native player and item identity', async () => {
    const { engine, host, session } = await fixture();

    importPickupSquares(engine);
    engine.registerItemDefinition({
        ...SOURCE_ITEM_FIELDS, fullType: 'MapFixture.Map', type: 'Normal',
        sourceCategory: 'Map', rawFields: [{ name: 'Map', value: 'LouisvilleMap1' }],
    }, { owner: 'fixture' });
    host.api.items.spawn({ fullType: 'MapFixture.Map', x: 5, y: 5 });
    try {
        activate(session, host, `
            local player=getPlayer()
            local world=getCell():getGridSquare(5,5,0):getWorldObjects():get(0)
            local item=world:getItem()
            assert(not player:hasReadMap(nil), 'Java instanceof null is false')
            assert(not player:hasReadMap(item), 'Map fields/category/name do not make a MapItem')
            item.IsMap=function() return true end
            assert(not player:hasReadMap(item), 'Lua methods cannot forge concrete class')
            assert(not pcall(function() player.hasReadMap({},item) end))
            local forged=setmetatable({}, {__eq=function() return true end})
            assert(not pcall(function() player.hasReadMap(forged,nil) end))
            assert(not pcall(function() player:hasReadMap({getID=function() return item:getID() end}) end))
            setmetatable(world, {__eq=function() return true end})
            assert(not pcall(function() player:hasReadMap(world) end))
        `, 'map-read-consumer');
        assert.deepEqual(session.diagnostics().errors, []);
        assert.deepEqual(host.diagnostics().errors, []);
    } finally {
        session.close();
        host.dispose();
    }
});

test('Lua no-recipes admits only absent item modData, keeps null-player semantics and refuses unsupported writers', async () => {
    const { engine, host, session } = await fixture();
    const definitions = parseItemDefinitions(`module NoRecipesFixture {
        item Ordinary { ItemType = base:normal, }
        item Marker { ItemType = base:normal, itemNoRecipes = Original Name, }
    }`, { path: 'no-recipes-consumer.txt' });

    importPickupSquares(engine);

    for (const definition of definitions) {
        engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, ...definition }, { owner: 'fixture' });
        host.api.items.spawn({ fullType: definition.fullType, x: 5, y: 5 });
    }

    try {
        activate(session, host, `
            local player=getPlayer()
            local world=getCell():getGridSquare(5,5,0):getWorldObjects()
            local ordinary=world:get(0):getItem()
            local unresolved=world:get(1):getItem()
            player:getModData().itemNoRecipes='Player table is not item state'
            assert(not ordinary:isNoRecipes(player))
            assert(not ordinary:isNoRecipes(nil) and not unresolved:isNoRecipes(nil))
            assert(not pcall(function() unresolved:isNoRecipes(player) end))
            local predicate=ordinary.isNoRecipes
            local forged=setmetatable({}, {__eq=function() return true end})
            assert(not pcall(function() predicate(ordinary,forged) end))
            assert(not pcall(function() predicate(forged,player) end))
            assert(not pcall(function() predicate(world:get(0),nil) end))
            assert(not pcall(function() ordinary:setNoRecipes(player,true) end))
            assert(not pcall(function() ordinary:getModData().itemNoRecipes='Forged' end))
            assert(not ordinary:isNoRecipes(player), 'unsupported writers cannot create hidden state')
        `, 'no-recipes-absent-consumer');
        const errors = session.diagnostics().errors;

        assert.equal(errors.length, 2, 'unsupported writers remain explicitly diagnosed even when Lua catches their errors');
        assert.match(errors[0].message, /unsupported native facility: InventoryItem:setNoRecipes$/u);
        assert.match(errors[1].message, /unsupported native facility: InventoryItem:getModData$/u);
        assert.ok(errors.every(({ modId }) => modId === 'no-recipes-absent-consumer'));
        assert.deepEqual(host.diagnostics().errors, []);
    } finally {
        session.close();
        host.dispose();
    }
});

test('Lua favourite recipe input proves only inactive live preferences and preserves active restored preference refusal', async () => {
    const original = await fixture();
    const restored = await fixture();
    const owner = 'recipe-input-preferences';
    const definition = { ...SOURCE_ITEM_FIELDS, fullType: 'RecipeFixture.Input', type: 'Normal' };

    for (const value of [original, restored]) {
        importPickupSquares(value.engine);
        value.engine.registerItemDefinition(definition, { owner: 'fixture' });
    }

    original.host.api.items.spawn({ fullType: definition.fullType, x: 5, y: 5 });
    try {
        await loadSource(original.session, original.host, `
            local player=getPlayer()
            local world=getCell():getGridSquare(5,5,0):getWorldObjects():get(0)
            local item=world:getItem()
            local data=player:getModData()
            assert(not item:isFavouriteRecipeInput(player))
            item:setFavorite(true)
            assert(not item:isFavouriteRecipeInput(player), 'item favorite is independent of recipe preference')
            data['RecipeFavourite:WrongCase']=true
            data['recipeFavourite:Fixture.Craft']=false
            assert(not item:isFavouriteRecipeInput(player), 'source key prefix is exact and Boolean false is inactive')
            data['recipeFavourite:Fixture.Craft']=true
            assert(not pcall(function() item:isFavouriteRecipeInput(player) end), 'active preference needs actual membership/knowledge')
            local previousPairs,previousSub=pairs,string.sub
            pairs=function() return function() return nil end end
            string.sub=function() return '' end
            assert(not pcall(function() item:isFavouriteRecipeInput(player) end), 'public globals cannot forge the private proof')
            pairs,string.sub=previousPairs,previousSub
            data['recipeFavourite:Fixture.Craft']='not a Java Boolean'
            assert(not pcall(function() item:isFavouriteRecipeInput(player) end), 'malformed preference cannot count as false')
            data['recipeFavourite:Fixture.Craft']=nil
            assert(not item:isFavouriteRecipeInput(player), 'live preference removal is observed without a cache')
            local predicate=item.isFavouriteRecipeInput
            local forged=setmetatable({}, {__eq=function() return true end})
            assert(not pcall(function() predicate(item,nil) end), 'null actor is unresolved, not an assumed empty recipe list')
            assert(not pcall(function() predicate(item,forged) end))
            assert(not pcall(function() predicate(forged,player) end))
            assert(not pcall(function() predicate(world,player) end))
            data['recipeFavourite:Fixture.Craft']=true
        `, owner);
        original.session.flushSaveData();
        const record = original.saved.get(owner);

        assert.equal(record.data.nativePlayerData['recipeFavourite:Fixture.Craft'], true);
        restored.saved.set(owner, structuredClone(record));
        restored.engine.importInventoryGraph(original.engine.exportInventoryGraph());
        await loadSource(restored.session, restored.host, `
            local player=getPlayer()
            local item=getCell():getGridSquare(5,5,0):getWorldObjects():get(0):getItem()
            local data=player:getModData()
            assert(data['recipeFavourite:Fixture.Craft']==true, 'actual saved player preference must be restored')
            assert(not pcall(function() item:isFavouriteRecipeInput(player) end), 'restored preference cannot become false')
            data['recipeFavourite:Fixture.Craft']=false
            assert(not item:isFavouriteRecipeInput(player))
        `, owner);

        for (const [value, count] of [[original, 3], [restored, 1]]) {
            const errors = value.session.diagnostics().errors;

            assert.equal(errors.length, count);
            assert.ok(errors.every(({ modId, message }) => modId === owner
                && /unsupported native facility: original recipe membership and player recipe knowledge$/u.test(message)));
            assert.deepEqual(value.host.diagnostics().errors, []);
        }
    } finally {
        for (const value of [original, restored]) {
            value.session.close();
            value.host.dispose();
        }
    }
});

test('Lua DrainableComboItem instanceof uses native class and rejects forged or mutable item metadata', async () => {
    const { engine, host, session } = await fixture();
    const definitions = parseItemDefinitions(`module DrainableFixture {
        item DrainableComboItem { ItemType = Normal, DisplayCategory = DrainableComboItem, UseDelta = 0.1, }
        item Clothing { ItemType = base:clothing, }
        item Bag { ItemType = base:container, }
    }`, { path: 'drainable-class-consumer.txt' });

    importPickupSquares(engine);

    for (const definition of definitions) {
        engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, ...definition }, { owner: 'fixture' });
        host.api.items.spawn({ fullType: definition.fullType, x: 5, y: 5 });
    }

    try {
        activate(session, host, `
            local world=getCell():getGridSquare(5,5,0):getWorldObjects()
            for i=0,2 do assert(not instanceof(world:get(i):getItem(),'DrainableComboItem')) end
            local item=world:get(0):getItem()
            local original=item.getFullType
            item.getFullType=function() error('mutable getter must not determine concrete class') end
            item.IsDrainable=function() return true end
            assert(not instanceof(item,'DrainableComboItem'))
            item.getFullType=original
            assert(not instanceof(nil,'DrainableComboItem'))
            assert(not instanceof({getFullType=function() return item:getFullType() end},'DrainableComboItem'))
            setmetatable(world:get(0), {__eq=function() return true end})
            assert(not instanceof(world:get(0),'DrainableComboItem'), 'world object identity is not the underlying item')
        `, 'drainable-class-consumer');
        assert.deepEqual(session.diagnostics().errors, []);
        assert.deepEqual(host.diagnostics().errors, []);
    } finally {
        session.close();
        host.dispose();
    }
});

test('native graph Lua wrappers preserve recursive ownership, bag identity and all three room overloads', async () => {
    const { engine, host, session } = await fixture();

    engine.registerItemDefinition({
        ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.GraphBag', type: 'Container', weight: 1,
        isBag: true, capacity: 20, weightReduction: 50, maxItemSize: 10,
    }, { owner: 'fixture' });
    engine.registerItemDefinition({
        ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.GraphLeaf', type: 'Normal', weight: 2,
    }, { owner: 'fixture' });
    importPickupSquares(engine);
    const bags = Array.from({ length: 3 }, () => engine.getItem(host.api.items.spawn({ fullType: 'Fixture.GraphBag', x: 5, y: 5 }).snapshot.id));
    const bag = bags[0];
    const leaf = engine.getItem(host.api.items.spawn({ fullType: 'Fixture.GraphLeaf', x: 5, y: 5 }).snapshot.id);

    for (const value of bags) {
        host.api.items.pickup(value.id);
        completeActions(engine);
    }

    for (let index = 1; index < bags.length; index += 1) {
        host.api.items.transferItem({
            id: bags[index].id, sourceContainerId: engine.playerInventoryId(), destinationContainerId: bags[index - 1].internalContainerId,
        });
        completeActions(engine);
    }

    host.api.items.transferItem({
        id: leaf.id, sourceContainerId: leaf.ownerContainerId, destinationContainerId: bags[2].internalContainerId,
    });
    completeActions(engine);
    try {
        activate(session, host, `
            local root=getPlayer():getInventory()
            local bag=root:getItems():get(0)
            assert(instanceof(bag,"InventoryContainer") and instanceof(bag,"InventoryItem"))
            local inside=bag:getInventory()
            assert(inside==bag:getInventory() and inside:getContainingItem()==bag)
            local middle=inside:getItems():get(0)
            local inner=middle:getInventory():getItems():get(0)
            local leaf=inner:getInventory():getItems():get(0)
            GraphOuterBag,GraphLeaf=bag,leaf
            assert(not leaf:isFavorite() and not leaf:getIsCraftingConsumed())
            leaf:setFavorite(true)
            assert(leaf:isFavorite())
            assert(leaf:getContainer()==inner:getInventory() and bag:getContainer()==root)
            assert(leaf:getOwner()==nil and leaf:getPlayer()==getPlayer())
            assert(root:contains(bag) and not root:contains(leaf) and root:contains(leaf,true))
            GraphCategorySnapshot=root:getItemsFromCategory('Container')
            assert(GraphCategorySnapshot:size()==1 and GraphCategorySnapshot:get(0)==bag,'category lookup must not recurse into bags')
            assert(root:getItemsFromCategory('container'):isEmpty(),'category matching is case-sensitive')
            assert(not pcall(function() root:getItemsFromCategory(nil) end))
            assert(root:containsTypeRecurse("GraphLeaf"))
            assert(inside:getOutermostContainer()==root and inside:isInCharacterInventory(getPlayer()))
            assert(root:getVehiclePart()==nil and inside:getVehiclePart()==nil,'admitted actor and bag containers have no VehiclePart')
            assert(inside:isInside(bag) and not root:isInside(bag))
            assert(bag:getContentsWeight()==4 and bag:getUnequippedWeight()==5)
            assert(bag:getInventoryWeight()==4)
            assert(middle:getContentsWeight()==3 and inner:getContentsWeight()==2)
            assert(inside:hasRoomFor(getPlayer(),leaf))
            assert(inside:hasRoomFor(getPlayer(),1))
            assert(inside:hasRoomFor(getPlayer(),1,0))
            assert(not pcall(function() inside:hasRoomFor(leaf) end))
            assert(not pcall(function() inside:getItems():add(leaf) end))
        `);
        host.coreApi.character.setHandItem('primary', bag.id);
        const childEquippedWeight = engine.itemWeights(bags[1].id).equippedWeight;

        activate(session, host, `
            assert(GraphOuterBag:getInventoryWeight()==${childEquippedWeight})
            assert(GraphOuterBag:getContentsWeight()==4)
        `, 'graph-equipped-inventory-weight');
        host.api.items.drop(bag.id, 5, 5);
        activate(session, host, `
            local square=getPlayer():getCurrentSquare()
            assert(GraphOuterBag:getOutermostContainer()==nil)
            assert(GraphLeaf:getOutermostContainer()==GraphOuterBag:getInventory())
            assert(GraphCategorySnapshot:size()==1 and GraphCategorySnapshot:get(0)==GraphOuterBag,'category results retain original item identities')
            assert(getPlayer():getInventory():getItemsFromCategory('Container'):isEmpty(),'a fresh category result reflects native movement')
            assert(GraphLeaf:isInsideBagOnSquare(square) and GraphLeaf:getWorldItem()==nil)
            assert(GraphOuterBag:getInventory():getOutermostContainer()~=GraphLeaf:getOutermostContainer())
            assert(GraphLeaf:getPlayer()==nil)
            assert(GraphLeaf:isFavorite(), "moving a bag shell must retain descendant policy state")
        `, 'graph-floor-root-check');
        assert.equal(engine.getItem(leaf.id).ownerContainerId, bags[2].internalContainerId);
    } finally {
        session.close();
        host.dispose();
    }
});

test('source grouped grabs retain distinct true floor roots across native queue replay', async () => {
    const { engine, host, session } = await fixture();

    importPickupSquares(engine);
    engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.CrossFloor', type: 'Normal', weight: 0.01 }, { owner: 'fixture' });
    const first = engine.getItem(host.api.items.spawn({ fullType: 'Fixture.CrossFloor', x: 5, y: 5 }).snapshot.id);
    const adjacent = engine.getItem(host.api.items.spawn({ fullType: 'Fixture.CrossFloor', x: 6, y: 5 }).snapshot.id);

    try {
        activate(session, host, `${SOURCE_GROUP_FIXTURE}
            local a=getCell():getGridSquare(5,5,0):getWorldObjects():get(0)
            local b=getCell():getGridSquare(6,5,0):getWorldObjects():get(0)
            ISTimedActionQueue.add(ISGrabItemAction:new(getPlayer(),a,1))
            ISTimedActionQueue.add(ISGrabItemAction:new(getPlayer(),b,1))
        `, 'cross-floor-source');
        const before = engine.actions.getState();

        assert.equal(before.pending.length, 0, 'the original same-type source grouping must remain intact');
        assert.deepEqual(before.current.groups[0].itemIds, [first.id, adjacent.id]);
        assert.deepEqual(before.current.groups[0].sourceContainerIds, [first.ownerContainerId, adjacent.ownerContainerId]);
        assert.notEqual(first.ownerContainerId, adjacent.ownerContainerId);
        const bytes = engine.saveQueueState();

        engine.loadQueueState(bytes);
        assert.deepEqual(engine.actions.getState(), before);
        completeLuaActions(engine, host, session);
        assert.deepEqual(engine.containerItems(engine.playerInventoryId()).map(({ id }) => id), [first.id, adjacent.id]);
        assert.equal(engine.getItem(first.id).worldPosition, null);
        assert.equal(engine.getItem(adjacent.id).worldPosition, null);
    } finally {
        session.close();
        host.dispose();
    }
});

test('original floor presentation keeps adjacent world roots and filters native moves without owning items', async () => {
    const { engine, host, session } = await fixture();

    engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.FloorView', type: 'Normal', weight: 1 }, { owner: 'fixture' });
    importPickupSquares(engine);
    const first = engine.getItem(host.api.items.spawn({ fullType: 'Fixture.FloorView', x: 5, y: 5 }).snapshot.id);
    const adjacent = engine.getItem(host.api.items.spawn({ fullType: 'Fixture.FloorView', x: 6, y: 5 }).snapshot.id);
    let placementQueries = 0;

    session.attachSourceActions({
        ...engine.sourceActions,
        /**
         * Count placement reads while retaining the real native ownership check.
         *
         * @param {...number} args - Item identity and exact native placement.
         * @returns {boolean} Actual current native placement match.
         */
        itemMatchesFloorPlacement(...args) {
            placementQueries += 1;

            return engine.sourceActions.itemMatchesFloorPlacement(...args);
        },
    }, engine.sourceTiming);

    try {
        activate(session, host, `
            local a=getCell():getGridSquare(5,5,0):getWorldObjects():get(0):getItem()
            local b=getCell():getGridSquare(6,5,0):getWorldObjects():get(0):getItem()
            FloorViewCheck=ItemContainer.new("floor",nil,nil)
            FloorViewCheck:setExplored(true)
            FloorViewCheck:AddItem(a)
            FloorViewCheck:AddItem(b)
            FloorViewCheck:AddItem(a)
            FloorCategorySnapshot=FloorViewCheck:getItemsFromCategory('Item')
            assert(FloorCategorySnapshot:size()==2 and FloorCategorySnapshot:get(0)==a and FloorCategorySnapshot:get(1)==b)
            assert(FloorViewCheck:getItemsFromCategory('item'):isEmpty())
            assert(FloorViewCheck:getItems():size()==2 and FloorViewCheck:getItems():get(0)==a)
            FloorItems=FloorViewCheck:getItems()
            FloorFirst,FloorAdjacent=a,b
            assert(FloorItems:indexOf(a)==0 and FloorItems:indexOf(b)==1)
            assert(FloorItems:indexOf(nil)==-1 and FloorItems:indexOf({})==-1)
            local impostor=setmetatable({},{__eq=function() return true end})
            assert(FloorItems:indexOf(impostor)==-1,'floor lookup requires raw resident identity')
            assert(not pcall(function() FloorViewCheck:getItems():get(-1) end))
            assert(not pcall(function() FloorViewCheck:getItems():get(0.5) end))
            assert(not pcall(function() FloorViewCheck:getItems():get(2) end))
            assert(FloorViewCheck:getMaxWeight()==50 and FloorViewCheck:getCapacityWeight()==2)
            assert(FloorViewCheck:getVehiclePart()==nil,'the original floor projection has no vehicle-part owner')
            assert(a:getContainer()~=b:getContainer() and a:getContainer()~=FloorViewCheck)
            assert(a:getOutermostContainer()==nil and a:getOwner()==nil)
            assert(not pcall(function() FloorViewCheck:DoRemoveItem(a) end))
            FloorViewCheck:clear()
            assert(FloorViewCheck:getItems():isEmpty() and a:getWorldItem()~=nil)
            FloorViewCheck:AddItem(b)
            FloorViewCheck:AddItem(a)
            assert(FloorViewCheck:getItems()==FloorItems and FloorItems:indexOf(b)==0 and FloorItems:indexOf(a)==1)
        `, 'floor-view-check');
        assert.equal(host.api.items.get(first.id).ownerContainerId, first.ownerContainerId);
        assert.equal(host.api.items.get(adjacent.id).ownerContainerId, adjacent.ownerContainerId);
        placementQueries = 0;
        activate(session, host, `
            assert(FloorItems:indexOf(FloorFirst)==1 and FloorItems:contains(FloorFirst))
        `, 'floor-view-linear-lookup');
        assert.equal(placementQueries, 3,
            'index lookup must scan each live placement at most once; contains queries only its target');
        host.api.items.pickup(adjacent.id);
        completeActions(engine);
        activate(session, host, `
            assert(FloorViewCheck:getItems():size()==1)
            assert(FloorViewCheck:getItems():get(0):getID()==${first.id})
            assert(FloorItems:indexOf(FloorFirst)==0 and FloorItems:indexOf(FloorAdjacent)==-1,
                'retained lookup must compact zero-based indices after native queue removal')
            assert(not pcall(function() FloorViewCheck:getItems():get(1) end),'live ordinal bounds must exclude the moved item')
            assert(FloorViewCheck:getCapacityWeight()==1)
            assert(FloorCategorySnapshot:size()==2,'the original ArrayList category result is a snapshot, not a live filter')
            assert(FloorViewCheck:getItemsFromCategory('Item'):size()==1,'a fresh projection category result filters moved items')
        `, 'floor-view-after-move');
        host.api.items.drop(adjacent.id, 6.25, 5.5);
        assert.equal(host.api.items.get(adjacent.id).ownerContainerId, adjacent.ownerContainerId,
            're-dropping within the same floor square retains its actual root');
        activate(session, host, `
            local moved=getCell():getGridSquare(6,5,0):getWorldObjects():get(0):getItem()
            assert(moved:getID()==${adjacent.id})
            assert(not FloorViewCheck:contains(moved),'same floor owner with a different exact placement must invalidate the old stamp')
            assert(FloorItems:indexOf(moved)==-1,'same-square native re-drop must not revive the old placement stamp')
            assert(FloorViewCheck:getItems():size()==1 and FloorViewCheck:getItems():get(0):getID()==${first.id})
            FloorViewCheck:clear()
            FloorViewCheck:AddItem(moved)
            assert(FloorViewCheck:contains(moved) and FloorViewCheck:getItems():get(0)==moved,'a fresh projection admits the actual new placement')
            assert(FloorItems:indexOf(moved)==0 and FloorItems:indexOf(FloorFirst)==-1,
                'clearing and repopulating must update the retained collection rather than cache its prior indices')
        `, 'floor-view-after-same-square-redrop');
    } finally {
        session.close();
        host.dispose();
    }
});

test('source facing consumes native world placement and refuses inventory-only items', async () => {
    const { engine, host, session } = await fixture();

    importPickupSquares(engine);
    engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.FaceWorld', type: 'Normal', weight: 1 }, { owner: 'fixture' });
    const world = engine.getItem(host.api.items.spawn({ fullType: 'Fixture.FaceWorld', x: 6.125, y: 5.25 }).snapshot.id);
    const calls = [];

    session.attachSourceActions({
        ...engine.sourceActions,
        /**
         * Observe the boundary while executing the actual native facing operation.
         *
         * @param {number} x - Actual world-space facing target x.
         * @param {number} y - Actual world-space facing target y.
         * @returns {void} Updates the real native actor facing target.
         */
        face: (x, y) => {
            calls.push([x, y]);

            return engine.sourceActions.face(x, y);
        },
    }, engine.sourceTiming);
    try {
        activate(session, host, `
            local object=getCell():getGridSquare(6,5,0):getWorldObjects():get(0)
            getPlayer():faceThisObject(object)
        `, 'face-world-check');
        assert.deepEqual(calls, [[world.worldPosition.x + 0.5, world.worldPosition.y + 0.5]]);
        host.api.items.pickup(world.id);
        completeActions(engine);
        assert.throws(() => activate(session, host, `
            getPlayer():faceThisObject(getPlayer():getInventory():getItems():get(0))
        `, 'face-nonworld-check'), /requires true world placement/u);
        assert.equal(calls.length, 1, 'a non-world item must not reach the native facing mutation');
    } finally {
        session.close({ discardSaveData: true });
        host.dispose();
    }
});

test('private original shared transfer helper preserves native bag order and rolls back a supported helper failure', async (t) => {
    let originals;

    try {
        originals = await Promise.all(['media/lua/shared/ISBaseObject.lua', 'media/lua/shared/TimedActions/ISTransferAction.lua']
            .map(async (path) => ({ path, source: await readFile(new URL(`../content/${path}`, import.meta.url), 'utf8'), execute: false })));
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }

        t.skip('Requires privately provisioned original Lua; no original bytes are committed.');

        return;
    }

    const { engine, host, session, saved } = await fixture();

    importPickupSquares(engine);
    engine.registerItemDefinition({
        ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.TransferBag', type: 'Container', weight: 1,
        capacity: 20, weightReduction: 50, maxItemSize: 10,
    }, { owner: 'fixture' });
    engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.TransferLeaf', type: 'Normal', weight: 2 }, { owner: 'fixture' });
    const bag = engine.getItem(host.api.items.spawn({ fullType: 'Fixture.TransferBag', x: 5, y: 5 }).snapshot.id);
    const secondBag = engine.getItem(host.api.items.spawn({ fullType: 'Fixture.TransferBag', x: 5, y: 5 }).snapshot.id);
    const leaf = engine.getItem(host.api.items.spawn({ fullType: 'Fixture.TransferLeaf', x: 5, y: 5 }).snapshot.id);

    for (const id of [bag.id, secondBag.id, leaf.id]) {
        host.api.items.pickup(id);
        completeActions(engine);
    }

    host.coreApi.character.setHandItem('primary', leaf.id);
    try {
        session.preload({ id: 'private-transfer-helper', sources: originals });
        // Authored scheduling fixture; the shared original helper text is loaded and executed unchanged.
        activate(session, host, `${SOURCE_GROUP_FIXTURE}
            getModData().TransferObservers={clothing=0,handRemoved=0}
            Events.OnClothingUpdated.Add(function(character)
                assert(character==getPlayer() and character:getPrimaryHandItem()==nil)
                getModData().TransferObservers.clothing=getModData().TransferObservers.clothing+1
            end)
            Events.OnEquipPrimary.Add(function(character,entry)
                assert(character==getPlayer())
                if entry==nil then
                    getModData().TransferObservers.handRemoved=getModData().TransferObservers.handRemoved+1
                end
            end)
            require "TimedActions/ISTransferAction"
            ISInventoryTransferAction=setmetatable({Type="ISInventoryTransferAction"},{__index=ISBaseTimedAction})
            ISInventoryTransferAction.__index=ISInventoryTransferAction
            function ISInventoryTransferAction:new(character,entry,source,destination,time)
                return setmetatable({character=character,item=entry,srcContainer=source,destContainer=destination,
                    maxTime=time,queueList={{time=time,items={entry}}}},self)
            end
            function ISInventoryTransferAction:isValid()
                return self.srcContainer:contains(self.item) and self.destContainer:hasRoomFor(self.character,self.item)
            end
            function ISInventoryTransferAction:getNotFullFloorSquare(entry)
                return ISTransferAction:getNotFullFloorSquare(self.character,entry,self.destContainer)
            end
            function ISInventoryTransferAction:isAlreadyTransferred(entry) return self.destContainer:contains(entry) end
            function ISInventoryTransferAction:transferItem(entry)
                return ISTransferAction:transferItem(self.character,entry,self.srcContainer,self.destContainer,self:getNotFullFloorSquare(entry))
            end
            function ISInventoryTransferAction:perform()
                local batch=table.remove(self.queueList,1)
                for _,entry in ipairs(batch.items) do
                    self.item=entry
                    if self:isValid() then self:transferItem(entry) end
                end
                ISBaseTimedAction.perform(self)
            end
            __pz_source_loaded()
            local root=getPlayer():getInventory()
            local bag=root:getItems():get(0)
            local entry=root:getItems():get(2)
            SharedTransferBag,SharedTransferBag2,SharedTransferLeaf=bag,root:getItems():get(1),entry
            SharedTransferAction=ISInventoryTransferAction:new(getPlayer(),entry,root,bag:getInventory(),1)
            ISTimedActionQueue.add(SharedTransferAction)
            -- Authored control events keep every stage under this one source owner and save namespace.
            Events.OnKeyPressed.Add(function(key)
                if key==1 then
                    SharedTransferAction.getNotFullFloorSquare=function() return nil end
                elseif key==2 then
                    SharedTransferAction.getNotFullFloorSquare=nil
                elseif key==3 then
                    SharedTransferAction.isAlreadyTransferred=function() return nil end
                elseif key==4 then
                    SharedTransferAction.isAlreadyTransferred=nil
                elseif key==5 then
                    ISTimedActionQueue.add(ISInventoryTransferAction:new(getPlayer(),SharedTransferLeaf,SharedTransferBag:getInventory(),SharedTransferBag2:getInventory(),1))
                elseif key==6 then
                    local floor=ItemContainer.new("floor",nil,nil)
                    ISTimedActionQueue.add(ISInventoryTransferAction:new(getPlayer(),SharedTransferLeaf,SharedTransferBag2:getInventory(),floor,1))
                elseif key==7 then
                    ISTimedActionQueue.add(ISInventoryTransferAction:new(getPlayer(),SharedTransferLeaf,SharedTransferLeaf:getContainer(),SharedTransferBag:getInventory(),1))
                elseif key==8 then
                    local character=getPlayer()
                    local original=character.removeWornItem
                    character.removeWornItem=function(self,entry,reset)
                        original(self,entry,reset)
                        error("supported helper failure after native equipment removal")
                    end
                    ISTimedActionQueue.add(ISInventoryTransferAction:new(character,SharedTransferLeaf,character:getInventory(),SharedTransferBag:getInventory(),1))
                end
            end)
        `, 'shared-transfer-check');
        const accepted = engine.actions.getState().current;

        assert.equal(accepted.kind, 'transfer');
        const refs = engine.sourceActions.transferRead(accepted.id);

        assert.equal(refs.sourceContainerId, engine.playerInventoryId());
        assert.equal(refs.destinationContainerId, bag.internalContainerId);

        for (const [delegate, key] of [['getNotFullFloorSquare', 1], ['isAlreadyTransferred', 3]]) {
            session.dispatch('OnKeyPressed', key);
            assert.throws(() => engine.saveQueueState(), `opaque ${delegate} must refuse portable capture`);
            session.dispatch('OnKeyPressed', key + 1);
            assert.ok(engine.saveQueueState().length > 0);
        }

        completeLuaActions(engine, host, session);
        assert.deepEqual(engine.containerItems(bag.internalContainerId).map(({ id }) => id), [leaf.id]);
        assert.equal(engine.getHandItems().primary, null);
        session.flushSaveData();
        assert.deepEqual(saved.get('host').data.nativePlayerData.TransferObservers, { clothing: 1, handRemoved: 1 });
        session.dispatch('OnKeyPressed', 5);
        completeLuaActions(engine, host, session);
        assert.equal(engine.getItem(leaf.id).ownerContainerId, secondBag.internalContainerId);
        session.dispatch('OnKeyPressed', 6);
        completeLuaActions(engine, host, session);
        assert.notEqual(engine.getItem(leaf.id).worldPosition, null);
        assert.equal(engine.getContainer(engine.getItem(leaf.id).ownerContainerId).kind, 'floor');
        session.dispatch('OnKeyPressed', 7);
        completeLuaActions(engine, host, session);
        assert.equal(engine.getItem(leaf.id).worldPosition, null);
        assert.equal(engine.getItem(leaf.id).ownerContainerId, bag.internalContainerId);
        host.api.items.transferItem({
            id: leaf.id, sourceContainerId: bag.internalContainerId, destinationContainerId: engine.playerInventoryId(),
        });
        completeActions(engine);
        host.coreApi.character.setHandItem('primary', leaf.id);
        const before = engine.exportInventoryGraph();

        session.dispatch('OnKeyPressed', 8);
        assert.throws(() => completeLuaActions(engine, host, session), /supported helper failure after native equipment removal/u);
        assert.deepEqual(engine.exportInventoryGraph(), before, 'PORT SAFETY rollback must preserve native membership/order after helper failure');
        assert.equal(engine.getHandItems().primary, leaf.id, 'rollback must restore the actual held item');
        session.flushSaveData();
        assert.deepEqual(saved.get('host').data.nativePlayerData.TransferObservers, { clothing: 1, handRemoved: 1 },
            'rolled-back equipment mutation must not publish committed hand removal');
    } finally {
        session.close({ discardSaveData: true });
        host.dispose();
    }
});

test('equipment wrappers preserve native identities, ordered worn traversal and headless mutation', async () => {
    const { engine, host, session } = await fixture();

    engine.registerItemDefinition({
        fullType: 'Authored.Layer', stackLimit: 1, conditionMax: 10, conditionLowerChanceOneIn: 1,
        removeOnBroken: false, bodyLocation: 'Shoes', canBeEquipped: 'Hat',
    }, { owner: 'fixture' });
    importPickupSquares(engine);
    const ids = Array.from({ length: 2 }, () => {
        const id = host.api.items.spawn({ fullType: 'Authored.Layer', x: 5, y: 5 }).snapshot.id;

        host.api.items.pickup(id);
        completeActions(engine);

        return id;
    });

    try {
        activate(session, host, `
            local shoes = ItemBodyLocation.SHOES
            assert(type(shoes) == "userdata")
            assert(shoes == ItemBodyLocation.get(ResourceLocation.of("BASE:Shoes")))
            assert(ResourceLocation.of("Authored:NotRegistered"):toString()=="authored:notregistered")
            assert(ItemBodyLocation.get(ResourceLocation.of("Authored:NotRegistered"))==nil)
            assert(shoes:toString() == "base:shoes" and tostring(shoes) == "base:shoes")
            assert(shoes:getTranslationName() == "Shoes")
            assert(ItemBodyLocation.BELT_EXTRA == ItemBodyLocation.get(ResourceLocation.of("BeltExtra")))
            assert(ItemBodyLocation.FORE_ARM_LEFT == ItemBodyLocation.get(ResourceLocation.of("ForeArm_Left")))
            assert(ItemBodyLocation.MAKE_UP_EYES_SHADOW == ItemBodyLocation.get(ResourceLocation.of("MakeUp_EyesShadow")))
            local custom = ItemBodyLocation.register("Authored:Layer")
            assert(custom == ItemBodyLocation.get(ResourceLocation.of("authored:layer")))
            assert(not pcall(ItemBodyLocation.register, "Shoes"))
            assert(not pcall(ItemBodyLocation.register, "Authored:Layer"))
            local group = BodyLocations.getGroup("Human")
            assert(group == BodyLocations.getGroup("Human"))
            local member = group:getOrCreateLocation(shoes)
            assert(member == group:getLocation(shoes) and member:getId() == shoes)
            assert(member == group:getLocationByIndex(0))
            assert(group:getLocation(ItemBodyLocation.HAT) == nil)
            assert(group:indexOf(ItemBodyLocation.HAT) == -1)
            assert(group:getLocationByIndex(-1) == nil)
            group:getOrCreateLocation(ItemBodyLocation.HAT)
            member:setMultiItem(true)
            member:setExclusive(ItemBodyLocation.HAT)
            assert(group:isExclusive(shoes, ItemBodyLocation.HAT))
            assert(not group:isExclusive(ItemBodyLocation.HAT, shoes))
            group:setExclusive(shoes, ItemBodyLocation.HAT)
            assert(group:isExclusive(ItemBodyLocation.HAT, shoes))
            group:setHideModel(shoes, ItemBodyLocation.HAT)
            assert(group:isHideModel(shoes, ItemBodyLocation.HAT))
            assert(not group:isHideModel(ItemBodyLocation.HAT, shoes))
            local worn = getPlayer():getWornItems()
            assert(worn == getPlayer():getWornItems() and worn:getBodyLocationGroup() == group)
            local a = getPlayer():getInventory():getItems():get(0)
            local b = getPlayer():getInventory():getItems():get(1)
            assert(a:getBodyLocation() == shoes and a:canBeEquipped() == ItemBodyLocation.HAT)
            getPlayer():setWornItem(shoes, a)
            worn:setItem(shoes, b)
            worn:setItem(shoes, a)
            assert(worn:size() == 2 and not worn:isEmpty())
            assert(worn:get(0):getItem() == b and worn:get(1):getItem() == a)
            assert(worn:get(0):getLocation() == shoes)
            assert(worn:getItem(shoes) == b and getPlayer():getWornItem(shoes) == b)
            assert(worn:getItemById(${ids[0]}) == a and worn:getItemByIndex(0) == b)
            assert(worn:getLocation(a) == shoes and worn:contains(a))
            local count = 0
            worn:forEach(function(entry) count=count+1; assert(entry:getLocation()==shoes) end)
            assert(count == 2)
            assert(not pcall(function() getPlayer():getWornItem({id=shoes}) end))
            assert(not pcall(function() getPlayer():getWornItem("Shoes") end))
            worn:setItem(shoes, nil)
            assert(worn:size() == 2)
            worn:remove(b)
            assert(worn:size()==1 and not worn:contains(b))
            worn:clear()
            assert(worn:isEmpty() and worn:getItemByIndex(0)==nil)
            local groups=BodyLocations.getAllGroups()
            BodyLocations.reset()
            assert(groups:size()==0 and group:size()==2)
            assert(BodyLocations.getGroup("Human") ~= group)
        `);
    } finally {
        session.close();
        host.dispose();
    }
});

test('void equipment bridge discards host object graphs after the real native mutation', async () => {
    const { engine, host, session } = await fixture();
    const graph = {};

    Object.defineProperty(graph, 'ownerDocument', {
        enumerable: true,
        /**
         * Reject any accidental serialization of this void host result.
         */
        get() {
            throw new Error('void equipment return graph was traversed');
        },
    });
    const api = {
        ...host.api,
        equipment: {
            /**
             * Preserve the real operation while poisoning only its void return.
             *
             * @param {string} op - Native equipment operation.
             * @param {...unknown} args - Original bridge arguments.
             * @returns {unknown} Real scalar query result or the poisoned mutation graph.
             */
            operation(op, ...args) {
                const result = host.api.equipment.operation(op, ...args);

                return op === 'multiSet' ? graph : result;
            },
        },
    };

    try {
        session.activatePackage({
            id: 'void-equipment', nativeId: 'void-equipment', api,
            sources: [{
                path: 'media/lua/client/VoidEquipment.lua',
                source: 'local group=BodyLocations.getGroup("Human"); local value=group:getOrCreateLocation(ItemBodyLocation.SHOES); assert(value:setMultiItem(true)==value); assert(value:isMultiItem())',
            }],
        });
        const group = engine.equipmentOperation('groupGet', 'Human');

        assert.equal(engine.equipmentOperation('multiGet', group, engine.equipmentOperation('lookup', 'Shoes')), true);
    } finally {
        session.close();
        host.dispose();
    }
});

test('scalar item metadata stays native-live without serializing unused item or script graphs', async () => {
    const { engine, host, session } = await fixture();
    const api = {
        ...host.api,
        items: {
            ...host.api.items,
            /**
             * Keep actual native records while detecting unused graph serialization.
             *
             * @param {number} id - Native item identity.
             * @returns {object|null} Current native record or absence.
             */
            get(id) {
                const row = host.api.items.get(id);

                if (row) {
                    Object.defineProperty(row, 'worldPosition', {
                        enumerable: true,
                        /** Reject graph reads from an unrelated scalar getter. */
                        get() {
                            throw new Error('unused native item graph was traversed');
                        },
                    });
                }

                return row;
            },
            definitions: {
                ...host.api.items.definitions,
                /**
                 * Preserve the real definition while making unused script state opaque.
                 *
                 * @param {string} fullType - Current native full type.
                 * @returns {object|null} Current detached native definition or absence.
                 */
                get(fullType) {
                    const definition = host.api.items.definitions.get(fullType);

                    if (definition) {
                        Object.defineProperty(definition, 'rawFields', {
                            enumerable: true,
                            /** Reject unused script traversal by a scalar consumer. */
                            get() {
                                throw new Error('unused native definition graph was traversed');
                            },
                        });
                    }

                    return definition;
                },
            },
        },
    };

    engine.registerItemDefinition({
        ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.ScalarMetadata', type: 'Clothing',
        sourceCategory: 'Clothing', bodyLocation: 'Shoes', canBeEquipped: 'Hat',
    }, { owner: 'fixture' });
    importPickupSquares(engine);
    const id = host.api.items.spawn({ fullType: 'Fixture.ScalarMetadata', x: 5, y: 5 }).snapshot.id;
    const graph = engine.exportInventoryGraph();
    const floorOwner = graph.items[0].ownerContainerId;

    graph.items[0] = { ...graph.items[0], ownerContainerId: host.api.items.playerInventoryId(), worldPosition: null };
    engine.importInventoryGraph(graph);

    try {
        activate(session, { api }, `
            ScalarMetadataItem=getPlayer():getInventory():getItems():get(0)
            assert(ScalarMetadataItem:getID()==${id})
        `, 'scalar-metadata-wrapper');
        activate(session, { api }, `
            local item=ScalarMetadataItem
            assert(select('#',item:getFullType())==1 and item:getFullType()=='Fixture.ScalarMetadata')
            assert(item:getCategory()=='Clothing' and item:getConditionMax()==10 and item:getWeightReduction()==0)
            assert(item:getCondition()==10 and item:getContainer()==getPlayer():getInventory() and item:getInventory()==nil)
            assert(item:getBodyLocation()==ItemBodyLocation.SHOES and item:canBeEquipped()==ItemBodyLocation.HAT)
            assert(instanceof(item,'Clothing') and not instanceof(item,'Food') and not instanceof(item,'Radio'))
            for _,class in ipairs({'Moveable','HandWeapon','Key','AnimalInventoryItem','AlarmClock','AlarmClockClothing','Literature','MapItem','WeaponPart'}) do
                assert(not instanceof(item,class),'the inventory class fallback must preserve ordinary item negatives: '..class)
            end
            local originalFullType=item.getFullType
            item.getFullType=function() error('class identity must not use a mutable Lua getter') end
            assert(not instanceof(item,'Moveable') and instanceof(item,'Clothing'))
            item.getFullType=originalFullType
            local player=getPlayer()
            assert(not player:isHandItem(item) and not player:isPrimaryHandItem(item) and not player:isSecondaryHandItem(item))
            assert(player:isHandItem(nil) and player:isPrimaryHandItem(nil) and player:isSecondaryHandItem(nil))
            assert(not pcall(function() player:isHandItem({getID=function() return item:getID() end}) end))
        `, 'scalar-metadata-original');

        for (const [slot, value, primary, secondary] of [
            ['primary', id, true, false], ['secondary', id, true, true],
            ['primary', null, false, true], ['secondary', null, false, false],
        ]) {
            host.coreApi.character.setHandItem(slot, value);
            activate(session, { api }, `
                local player,item=getPlayer(),ScalarMetadataItem
                assert(player:isPrimaryHandItem(item)==${primary} and player:isSecondaryHandItem(item)==${secondary})
                assert(player:isHandItem(item)==${primary || secondary})
                assert(player:isPrimaryHandItem(nil)==${!primary} and player:isSecondaryHandItem(nil)==${!secondary})
                assert(player:isHandItem(nil)==${!primary || !secondary})
            `, `scalar-metadata-hand-${slot}-${value ?? 'empty'}`);
        }

        engine.beginItemDefinitionRegistration('fixture');
        try {
            engine.registerItemDefinition({
                ...engine.getItemDefinition('Fixture.ScalarMetadata'), type: 'Normal',
                sourceCategory: 'Updated', conditionMax: 20, bodyLocation: null, canBeEquipped: null,
            }, { owner: 'fixture', override: true });
            activate(session, { api }, `
                local item=ScalarMetadataItem
                assert(item:getFullType()=='Fixture.ScalarMetadata' and item:getCategory()=='Updated')
                assert(item:getConditionMax()==20 and item:getBodyLocation()==nil and item:canBeEquipped()==nil)
                assert(not instanceof(item,'Clothing') and not instanceof(item,'Food') and not instanceof(item,'Radio'))
            `, 'scalar-metadata-override');
        } finally {
            engine.rollbackItemDefinitionRegistration('fixture');
        }

        activate(session, { api }, `
            local item=ScalarMetadataItem
            assert(item:getCategory()=='Clothing' and item:getConditionMax()==10)
            assert(item:getBodyLocation()==ItemBodyLocation.SHOES and item:canBeEquipped()==ItemBodyLocation.HAT)
            assert(instanceof(item,'Clothing'))
        `, 'scalar-metadata-rollback');
        const restoredGraph = engine.exportInventoryGraph();

        restoredGraph.items[0] = {
            ...restoredGraph.items[0], ownerContainerId: floorOwner, worldPosition: { x: 5, y: 5, z: 0 }, condition: 3,
        };
        engine.importInventoryGraph(restoredGraph);
        activate(session, { api }, `
            local item=ScalarMetadataItem
            assert(item:getFullType()=='Fixture.ScalarMetadata' and item:getCategory()=='Clothing')
            assert(item:getCondition()==3 and item:getContainer():getID()==${floorOwner} and item:getInventory()==nil,
                'retained native identities must observe ownership and condition loaded from the current graph')
        `, 'scalar-metadata-load');
    } finally {
        session.close();
        host.dispose();
    }
});

test('original MoodleType constants resolve the authoritative registry without legacy aliases or neutral fallbacks', async () => {
    const { engine, host, session } = await fixture();

    try {
        engine.command({ type: 'setCharacterStat', name: 'unhappiness', value: 80 });
        engine.command({ type: 'setCharacterStat', name: 'intoxication', value: 80 });
        activate(session, host, `
            local values=Registries.MOODLE_TYPE:values()
            assert(values:get(6)==MoodleType.UNHAPPY)
            assert(values:get(16)==MoodleType.DRUNK)
            assert(getPlayer():getMoodles():getMoodleLevel(MoodleType.UNHAPPY)==3)
            assert(getPlayer():getMoodles():getMoodleLevel(MoodleType.DRUNK)==4)
        `, 'moodle-registry');

        for (const name of ['Unhappy', 'HASACOLD', 'WIND_CHILL', '__proto__', 'UNKNOWN']) {
            assert.throws(() => activate(session, host, `local value=MoodleType[${JSON.stringify(name)}]`, `moodle-unknown-${name}`),
                /unsupported.*MoodleType/u);
        }

        assert.throws(() => activate(session, host, 'getPlayer():getMoodles():getMoodleLevel("base:unknown")', 'moodle-unknown-level'),
            /unsupported moodle type/u);
        assert.throws(() => session.activatePackage({
            id: 'moodle-missing-capability', api: { ...host.api, character: { ...host.api.character, moodles: undefined } },
            sources: [{ path: 'media/lua/client/moodle-missing.lua', source: 'local value=MoodleType.UNHAPPY' }],
        }), /unsupported.*character\.moodles/u);
        assert.throws(() => session.activatePackage({
            id: 'moodle-missing-member',
            api: {
                ...host.api, character: {
                    ...host.api.character,
                    /**
                     * Exclude a required member from the actual native domain.
                     *
                     * @returns {object[]} Authoritative levels without UNHAPPY.
                     */
                    moodles: () => engine.moodles().filter(({ id }) => id !== 'base:unhappy'),
                },
            },
            sources: [{ path: 'media/lua/client/moodle-missing-member.lua', source: 'local value=MoodleType.UNHAPPY' }],
        }), /MoodleType\.UNHAPPY.*base:unhappy/u);
        assert.throws(() => session.activatePackage({
            id: 'moodle-invalid-level',
            api: {
                ...host.api, character: {
                    ...host.api.character,
                    /**
                     * Supply invalid authoritative data through the constant lookup.
                     *
                     * @returns {object[]} A level outside the supported native range.
                     */
                    moodles: () => [{ id: 'base:unhappy', level: 5 }],
                },
            },
            sources: [{ path: 'media/lua/client/moodle-invalid.lua', source: 'local value=MoodleType.UNHAPPY' }],
        }), /unsupported authoritative moodles registry\/levels/u);
    } finally {
        session.close();
        host.dispose();
    }
});

test('private original ISBaseTimedAction adjusts duration using real UNHAPPY and DRUNK levels', async (t) => {
    const paths = ['media/lua/shared/ISBaseObject.lua', 'media/lua/shared/TimedActions/ISBaseTimedAction.lua'];
    let sources;

    try {
        sources = await Promise.all(paths.map(async (path) => ({
            path, source: await readFile(new URL(`../content/${path}`, import.meta.url), 'utf8'),
        })));
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }

        t.skip('Requires privately provisioned original Lua; no original bytes are committed.');

        return;
    }

    const { engine, host, session } = await fixture();

    try {
        engine.command({ type: 'setCharacterStat', name: 'unhappiness', value: 80 });
        engine.command({ type: 'setCharacterStat', name: 'intoxication', value: 80 });
        session.activatePackage({
            id: 'original-moodle-adjustment', api: host.api, sources: [...sources, {
                path: 'media/lua/client/moodle-adjustment-check.lua',
                source: `
                    local action=ISBaseTimedAction:new(getPlayer())
                    assert(action:adjustMaxTime(20)==70)
                    assert(action:adjustMaxTime(1)==1)
                    assert(action:adjustMaxTime(-1)==-1)
                `,
            }],
        });
        assert.deepEqual(session.diagnostics().errors, []);
    } finally {
        session.close();
        host.dispose();
    }
});

test('native Grapple logging uses authenticated enums, severity policy and the non-debug Core gate', async () => {
    const { host, session } = await fixture();

    try {
        session.activatePackage({
            id: 'corpse-debug', nativeId: 'OriginalDebugConsumer', api: host.api,
            sources: [{
                path: 'media/lua/shared/BodyDragging/debug-consumer.lua',
                source: `
                    local category=DebugType.Grapple
                    assert(type(category)=='userdata' and category==DebugType.Grapple)
                    assert(category:name()=='Grapple' and category:ordinal()==46)
                    assert(category:toString()=='Grapple' and tostring(category)=='Grapple')
                    assert(LogSeverity.Debug:ordinal()==2 and LogSeverity.Off:ordinal()==6)
                    assert(LogSeverity.All==LogSeverity.Trace)
                    assert(category:getLogSeverity()==LogSeverity.Off)
                    assert(not getDebug() and not isDebugEnabled())
                    assert(not DebugLog.isEnabled(category))
                    log(category,'disabled corpse context')
                    category:setLogSeverity(LogSeverity.Warning)
                    assert(DebugLog.isEnabled(category))
                    assert(not DebugLog.isLogEnabled(category,LogSeverity.General))
                    assert(DebugLog.isLogEnabled(category,LogSeverity.Error))
                    category:setLogSeverity(LogSeverity.All)
                    assert(DebugLog.isLogEnabled(category,LogSeverity.Debug))
                    -- Native global log still requires Core.debug, independently of severity.
                    log(category,'debug remains disabled')
                    category:setLogSeverity(LogSeverity.Off)
                    assert(not DebugLog.isLogEnabled(category,LogSeverity.Off))
                    assert(not pcall(function() log({name='Grapple'},'forged category') end))
                    assert(not pcall(function() category:setLogSeverity({ordinal=0}) end))
                `,
            }],
        });
        assert.throws(() => activate(session, host, 'log({}, "forged category")', 'forged-debug'),
            /\[native forged-debug\/media\/lua\/client\/forged-debug\/main\.lua].*expected native DebugType/);
    } finally {
        session.close();
        host.dispose();
    }
});

test('fresh client global-system registration owns resident metadata without inventing global-world data', async () => {
    const { host, session } = await fixture();

    try {
        activate(session, host, `
            assert(CGlobalObjects.getSystemCount()==0)
            local system=CGlobalObjects.registerSystem('campfire')
            assert(CGlobalObjects.getSystemCount()==1 and CGlobalObjects.getSystemByIndex(0)==system)
            assert(CGlobalObjects.getSystemByIndex(-1)==nil and CGlobalObjects.getSystemByIndex(1)==nil)
            assert(CGlobalObjects.getSystemByName('campfire')==system and CGlobalObjects.registerSystem('campfire')==system)
            local data=system:getModData()
            local nested={marker=27}
            data.consumer=nested
            assert(system:getModData()==data and system:getModData().consumer==nested)
            assert(system:getName()=='campfire' and system:getObjectCount()==0,
                'only this fresh client registration list is empty, not a claim about the original world')
            assert(not pcall(function() system:getObjectAt(5,5,0) end),'unknown world-global data must not become nil')
            assert(not pcall(function() system:newObject(5,5,0) end),'unsupported global producers must not create fake campfires')
            assert(not pcall(function() CGlobalObjects.registerSystem('unknown-system') end))
        `, 'client-global-registration');
    } finally {
        session.close();
        host.dispose();
    }
});

test('corpse context consumers exclude flat world items and player inventory and reject invented containers', async () => {
    const { engine, host, session } = await fixture();

    try {
        engine.importDoors([sourceMenuDoor({ locked: false })], { squares: sourceDoorSquares(true) });
        engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.CorpseMale', weight: 0.1 }, { owner: 'fixture' });
        const carried = host.api.items.spawn({ fullType: 'Fixture.CorpseMale', x: 5, y: 5 }).snapshot.id;

        host.api.items.pickup(carried);
        completeActions(engine);
        const ground = host.api.items.spawn({ fullType: 'Fixture.CorpseMale', x: 6, y: 5 }).snapshot.id;

        await loadSource(session, host, `
            local player=getPlayer()
            local square=getCell():getGridSquare(6,5,0)
            local corpse=square:getWorldObjects():get(0):getItem()
            assert(corpse:isHumanCorpse(),'the original predicate recognizes the native CorpseMale type name')
            local originalType,originalFullType=corpse.getType,corpse.getFullType
            corpse.getType=function() return 'BoxingGloves' end
            corpse.getFullType=function() return 'Base.BoxingGloves' end
            assert(corpse:isHumanCorpse(),'Lua getter overrides must not change the native type-name predicate')
            assert(not pcall(function() corpse.isHumanCorpse({getType=function() return 'CorpseMale' end}) end))
            corpse.getType,corpse.getFullType=originalType,originalFullType
            local native=square:getObjects()
            assert(native==square:getObjects())
            RetainedNativeObjects=native
            local clicked={}
            for i=0,native:size()-1 do clicked[#clicked+1]=native:get(i) end
            assert(#clicked==2)
            for _,object in ipairs(clicked) do
                assert(object:getChunk()==square:getChunk(),
                    'native doors and world items must share inherited IsoObject chunk ownership')
            end
            RetainedStaticMovingObjects=square:getStaticMovingObjects()
            assert(type(RetainedStaticMovingObjects)=='userdata' and RetainedStaticMovingObjects==square:getStaticMovingObjects())
            assert(RetainedStaticMovingObjects:isEmpty() and RetainedStaticMovingObjects:size()==0,
                'admitted doors and flat world items are not original static-moving actors')
            assert(not RetainedStaticMovingObjects:contains(player))
            assert(not pcall(function() RetainedStaticMovingObjects:get(0) end))
            assert(square:getVehicleContainer()==nil,'the admitted vehicle-free world has no intersecting BaseVehicle')
            local function corpseOptions(objects,clickedSquare)
                local options={}
                local lists={player:getContextWorldContainersWithHumanCorpse(objects),
                    player:getSuitableContainersWithHumanCorpseInSquare(clickedSquare)}
                for _,list in ipairs(lists) do
                    assert(type(list)=='userdata')
                    for i=0,list:size()-1 do options[#options+1]=list:get(i) end
                end
                return options
            end
            assert(#corpseOptions(clicked,square)==0)
            assert(#corpseOptions({player},player:getSquare())==0)
            assert(player:getContextWorldContainersWithHumanCorpse(nil):isEmpty())
            assert(player:getContextWorldSuitableContainersToDropCorpseInObjects(clicked):isEmpty())
            assert(player:getSuitableContainersToDropCorpseInSquare(square):isEmpty())
            assert(player:getSuitableContainersToDropCorpseInSquare(nil):isEmpty())
            assert(not pcall(function() player:getSuitableContainersWithHumanCorpseInSquare(nil) end))
            assert(getSpecificPlayer(1)==nil)
            local fake={getContainer=function() return player:getInventory() end}
            assert(not pcall(function() corpseOptions({fake},square) end))
            assert(not pcall(function() player:getContextWorldContainersWithHumanCorpse({player:getInventory()}) end))
            assert(not pcall(function() ItemContainer.new('crate',clicked[1],nil) end))
            RetainedCorpseContext=clicked
            RetainedCorpseSquare=square
        `, 'corpse-context');
        host.api.items.pickup(ground);
        completeActions(engine);
        engine.importDoors([], { squares: sourceDoorSquares(true) });
        await loadSource(session, host, `
            assert(getPlayer():getContextWorldContainersWithHumanCorpse(RetainedCorpseContext):isEmpty())
            assert(getPlayer():getSuitableContainersWithHumanCorpseInSquare(RetainedCorpseSquare):isEmpty())
            assert(RetainedNativeObjects:isEmpty())
            assert(not pcall(function() RetainedNativeObjects:get(0) end))
            assert(RetainedStaticMovingObjects:isEmpty(),'retained static-moving view must re-read the admitted current square')
            assert(RetainedCorpseSquare:getVehicleContainer()==nil)
        `, 'corpse-context-after-removal');
        assert.deepEqual(engine.actions.getState(), { current: null, pending: [] });
        assert.equal(host.api.items.containerItems(host.api.items.playerInventoryId()).length, 2);
        engine.importDoors([], {
            squares: sourceDoorSquares(true).map((square) => ({ ...square, vehicleObstructed: square.x === 6 && square.y === 5 })),
        });
        await loadSource(session, host, `
            assert(not pcall(function() RetainedCorpseSquare:getVehicleContainer() end),
                'vehicle obstruction metadata needs an actual supported vehicle representation, not a fabricated nil')
        `, 'vehicle-container-unsupported');
        engine.importDoors([], { squares: [] });
        await loadSource(session, host, `
            assert(not pcall(function() RetainedStaticMovingObjects:size() end),
                'missing source-square admission must not become a fabricated empty actor collection')
            assert(not pcall(function() RetainedCorpseSquare:getVehicleContainer() end),
                'an absent source square must not become a fabricated no-vehicle result')
        `, 'static-moving-square-unloaded');
    } finally {
        session.close();
        host.dispose();
    }
});

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

test('cross-package require preserves source names, native recursive nil, and event removal uses Lua identity', async () => {
    const { host, session, saved } = await fixture();

    try {
        session.preload({
            id: 'library', nativeId: 'NativeLibrary', sources: [
                { path: 'media/lua/shared/Math/Numbers.lua', source: 'return {value = 21}', execute: false },
                { path: 'media/lua/shared/CycleA.lua', source: 'assert(require "CycleB" == 8); return 7', execute: false },
                { path: 'media/lua/shared/CycleB.lua', source: 'assert(require "CycleA" == nil); return 8', execute: false },
                { path: 'media/lua/shared/Broken.lua', source: 'error("module evaluation failure")', execute: false },
            ],
        });
        await loadPackage(session, host, { id: 'library', nativeId: 'NativeLibrary', sources: [] });
        await loadSource(session, host, `
            local numbers = require 'mAtH/nUmBeRs.lua'
            assert(numbers == require 'Math/Numbers')
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
        `, 'calculation');

        session.dispatch('OnGameStart');
        session.flushSaveData();
        assert.deepEqual(saved.get('calculation').data.nativePlayerData.events, { value: 42, order: 'AB' });
        host.unload('calculation');
        await loadSource(session, host, 'assert(require "CycleA" == 7); assert(require "CycleB" == 8)', 'cycle');
        await loadSource(session, host, `
            local optional = require 'Absent/Module'
            assert(optional == nil and require 'Absent/Module' == nil)
            getModData().optionalModule = {unavailable = optional == nil, continued = true}
        `, 'missing');
        session.flushSaveData();
        assert.deepEqual(saved.get('missing').data.nativePlayerData.optionalModule, { unavailable: true, continued: true });
        await assert.rejects(loadSource(session, host, 'require "bRoKeN.lua"', 'broken-consumer'), (error) => error.cause?.nativeModId === 'NativeLibrary' && error.cause.path === 'media/lua/shared/Broken.lua' && /module evaluation failure/.test(error.cause.message));
    } finally {
        session.close();
        host.dispose();
    }
});

test('source cursor key identities resolve the actual empty binding without aborting key dispatch', async () => {
    const { host, session, saved } = await fixture({
        sourceWorldContext: {
            /**
             * Resolve the fixture's empty native binding.
             *
             * @returns {null} An actual empty native binding.
             */
            keyBinding: () => null,
        },
    });

    try {
        activate(session, host, `
            local bindings={KeybindId.TOGGLE_INVENTORY,KeybindId.TOGGLE_MODE,KeybindId.RUN,KeybindId.INTERACT,KeybindId.ROTATE_BUILDING}
            local seen={}
            for _,binding in ipairs(bindings) do
                assert(type(binding)=='userdata' and not seen[binding])
                seen[binding]=true
            end
            getModData().CursorKeys={calls=0}
            Events.OnKeyPressed.Add(function(key)
                for _,binding in ipairs(bindings) do assert(not getCore():isKey(binding,key)) end
                assert(not getCore():isKey('Interact',key))
                getModData().CursorKeys.calls=getModData().CursorKeys.calls+1
            end)
        `, 'cursor-keys');
        session.dispatch('OnKeyPressed', 17);
        session.dispatch('OnKeyPressed', 1);
        session.dispatch('OnKeyPressed', 0);
        session.flushSaveData();
        assert.equal(saved.get('host').data.nativePlayerData.CursorKeys.calls, 3);
    } finally {
        session.close();
        host.dispose();
    }
});

test('Lua GameTime setters mutate the native source clock without calendar normalization', async () => {
    const { engine, host, session } = await fixture();

    try {
        activate(session, host, `
            local clock=getGameTime()
            assert(type(clock)=='userdata' and clock==getGameTime())
            assert(clock:getYear()==1993 and clock:getMonth()==6 and clock:getDay()==22)
            assert(clock:getTimeOfDay()==9 and clock:getLastTimeOfDay()==9)
            assert(clock:getNightsSurvived()==0 and clock:getMinutesPerDay()==90)
            assert(clock:getWorldAgeHours()==2 and clock:getHour()==9 and clock:getMinutes()==0)
            assert(clock:setYear(-44)==nil)
            assert(clock:setMonth(13)==nil)
            assert(clock:setDay(40)==nil)
            assert(clock:setNightsSurvived(2)==nil)
            assert(clock:setTimeOfDay(9.1)==nil)
            assert(clock:setLastTimeOfDay(-1.1)==nil)
            assert(clock:setMinutesPerDay(-30.1)==nil)
            assert(clock:getYear()==-44 and clock:getMonth()==13 and clock:getDay()==40)
            assert(clock:getNightsSurvived()==2)
            assert(clock:getTimeOfDay()==9.100000381469727)
            assert(clock:getLastTimeOfDay()==-1.100000023841858)
            assert(clock:getMinutesPerDay()==-30.100000381469727)
            assert(clock:getWorldAgeHours()==50.099998474121094)
            assert(clock:getHour()==9 and clock:getMinutes()==6)
            assert(not pcall(function() clock:setYear(1.5) end))
            assert(not pcall(function() clock:setMonth(2147483648) end))
            assert(not pcall(function() clock:setDay(nil) end))
            assert(not pcall(function() clock:setTimeOfDay(math.huge) end))
            assert(not pcall(function() clock:setLastTimeOfDay(0/0) end))
            assert(not pcall(function() clock:setMinutesPerDay('90') end))
            assert(clock:getYear()==-44 and clock:getMonth()==13 and clock:getDay()==40)
            assert(clock:getTimeOfDay()==9.100000381469727)
            assert(clock:getLastTimeOfDay()==-1.100000023841858)
            assert(clock:getMinutesPerDay()==-30.100000381469727)
            clock:setTimeOfDay(-1.25)
            assert(clock:getHour()==-2 and clock:getMinutes()==-15)
            assert(clock:getWorldAgeHours()==63.75)
        `, 'source-clock-setters');
        assert.deepEqual(engine.worldClockState(), {
            version: 1, year: -44, month: 13, day: 40, timeOfDay: -1.25,
            lastTimeOfDay: -1.100_000_023_841_858, nightsSurvived: 2, minutesPerDay: -30.100_000_381_469_727,
        });
    } finally {
        session.close({ discardSaveData: true });
        host.dispose();
    }
});

test('retained Lua GameTime observes native clock import and simulation advances with existing timing', async () => {
    const { engine, host, session, saved } = await fixture();

    try {
        activate(session, host, `
            local clock=getGameTime()
            getModData().Clock={initialAge=clock:getWorldAgeHours()}
            clock:setMultiplier(2)
            assert(clock:getTrueMultiplier()==2)
            Events.OnTick.Add(function()
                assert(clock==getGameTime())
                getModData().Clock={
                    initialAge=getModData().Clock.initialAge,
                    year=clock:getYear(),month=clock:getMonth(),day=clock:getDay(),
                    timeOfDay=clock:getTimeOfDay(),lastTimeOfDay=clock:getLastTimeOfDay(),
                    nightsSurvived=clock:getNightsSurvived(),minutesPerDay=clock:getMinutesPerDay(),
                    worldAgeHours=clock:getWorldAgeHours(),hour=clock:getHour(),minutes=clock:getMinutes(),
                    elapsed=clock:getRealworldSecondsSinceLastUpdate(),multiplier=clock:getTrueMultiplier()
                }
            end)
        `, 'source-clock-live');
        engine.importWorldClockState({
            version: 1, year: 2_000, month: 1, day: 28, timeOfDay: 23.5,
            lastTimeOfDay: 23, nightsSurvived: 3, minutesPerDay: 90,
        });
        host.step(1 / 60);
        session.flushSaveData();
        const observed = saved.get('host').data.nativePlayerData.Clock;
        const native = engine.worldClockState();

        assert.equal(observed.initialAge, 2);
        assert.equal(observed.year, 2_000);
        assert.equal(observed.month, 1);
        assert.equal(observed.day, 28);
        assert.ok(observed.timeOfDay > 23.5 && observed.timeOfDay < 24);
        // ModData JSON uses Lua tostring; compare the underlying source f32, not its shortened decimal spelling.
        assert.equal(Math.fround(observed.timeOfDay), native.timeOfDay);
        assert.equal(Math.fround(observed.lastTimeOfDay), native.lastTimeOfDay);
        assert.equal(observed.nightsSurvived, 3);
        assert.equal(observed.minutesPerDay, 90);
        assert.ok(observed.worldAgeHours > 88.5 && observed.worldAgeHours < 89);
        assert.equal(observed.hour, 23);
        assert.equal(observed.minutes, 30);
        assert.equal(Math.fround(observed.elapsed), Math.fround(1 / 60));
        assert.equal(observed.multiplier, 2);
        assert.deepEqual(session.diagnostics().errors, []);
    } finally {
        session.close({ discardSaveData: true });
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
        assert.deepEqual(session.diagnostics().errors, []);
        assert.deepEqual(host.diagnostics().errors, []);
        cleanup();
        engine.setSpeed(2);
        host.step(1 / 60);
        assert.equal(engine.snapshot().speed, 2);
    } finally {
        session.close();
        host.dispose();
    }
});

test('Lua cell and square userdata retain identity while native replacement changes standability', async () => {
    const { engine, host, session, saved } = await fixture();
    const square = {
        x: 5, y: 5, z: 0, roomId: 7, outside: false, solid: false,
        solidTrans: false, tree: false, vehicleObstructed: false, solidFloor: true,
        independentWalls: 0,
    };

    try {
        engine.importDoors([], { squares: [square, { ...square, x: -1, y: -2 }, { ...square, x: 0, y: 0 }] });
        const cleanup = activate(session, host, `
            local cell, player = getCell(), getPlayer()
            local square = cell:getGridSquare(5.9, 5.1, 0.9)
            assert(type(cell) == 'userdata' and type(square) == 'userdata')
            assert(cell == getCell() and square == player:getCurrentSquare())
            assert(square:getX() == 5 and square:getY() == 5 and square:getZ() == 0)
            assert(square:canStand() == true)
            local negative = cell:getGridSquare(-0.25, -1.25, 0)
            assert(negative:getX() == -1 and negative:getY() == -2)
            local chunk = square:getChunk()
            assert(type(chunk)=='userdata' and chunk==square:getChunk())
            assert(chunk==cell:getGridSquare(0,0,0):getChunk(),'loaded squares in the same native 8x8 chunk share identity')
            assert(chunk~=negative:getChunk(),'negative chunk coordinates must not alias the origin chunk')
            getModData().squareState = {}
            assert(cell:getGridSquare(5, 5, 1) == nil)
            assert(cell:getGridSquare(5, 5, 32) == nil)
            assert(cell:getGridSquare(100, 100, 0) == nil)
            assert(cell:getGridSquare(0/0, 0/0, 0/0) == cell:getGridSquare(0, 0, 0))
            assert(cell:getGridSquare(math.huge, -math.huge, 0) == nil)
            assert(cell:getGridSquare(-2147483648.5, 0, 0) == nil)
            assert(not pcall(function() return cell:getGridSquare('5', 5, 0) end))
            assert(not pcall(function() return square:getRoom() end))
            assert(not pcall(function() return square:getBuilding() end))
            assert(not pcall(function() return square:getRoomID() end))
            local initialChunk=chunk
            Events.OnTick.Add(function()
                assert(cell == getCell())
                local current = cell:getGridSquare(5, 5, 0)
                local result = getModData().squareState
                if current ~= nil then
                    assert(current == square and current == player:getCurrentSquare())
                    assert(type(current:getChunk())=='userdata' and current:getChunk()~=initialChunk,
                        'atomic native square replacement must retire the old chunk identity')
                    result.canStand = square:canStand()
                else
                    assert(player:getCurrentSquare() == nil)
                    assert(square:getChunk()==nil,'an unloaded square must not manufacture a chunk')
                    local ok, message = pcall(function() return square:canStand() end)
                    assert(not ok and tostring(message):find('square disappeared', 1, true))
                    assert(not pcall(function() return square:getX() end))
                    result.disappeared = true
                end
            end)
        `, 'square-state');

        engine.importDoors([], { squares: [{ ...square, solid: true }] });
        host.step(1 / 60);
        session.flushSaveData();
        assert.equal(saved.get('host').data.nativePlayerData.squareState.canStand, false);
        engine.importDoors([], { squares: [{ ...square, solidTrans: true, windows: 2, solidFloor: false }] });
        host.step(1 / 60);
        session.flushSaveData();
        assert.equal(saved.get('host').data.nativePlayerData.squareState.canStand, true);
        engine.importDoors([], { squares: [] });
        host.step(1 / 60);
        session.flushSaveData();
        assert.equal(saved.get('host').data.nativePlayerData.squareState.disappeared, true);
        cleanup();
    } finally {
        session.close();
        host.dispose();
    }
});

test('Lua stable square blocked-to delegates directional and nil relations to actual native current state', async () => {
    const { engine, host, session, saved } = await fixture();
    const from = { x: 5, y: 5, z: 0 };
    const north = { x: 5, y: 4, z: 0 };
    const base = { roomId: -1, outside: true, solid: false, solidTrans: false, tree: false, independentWalls: 0, vehicleObstructed: false };

    /**
     * Replace real source facts, optionally removing the other square.
     *
     * @param {object} interactionProperties - Explicit source properties.
     * @param {boolean} [includeNorth=true] - Whether the other square remains imported.
     * @returns {void} Commits native square metadata.
     */
    const replace = (interactionProperties, includeNorth = true) => engine.importDoors([], {
        squares: [{ ...base, ...from, interactionProperties }, ...(includeNorth ? [{ ...base, ...north }] : [])],
    });

    try {
        replace({ stairsTN: true });
        const cleanup = activate(session, host, `
            local square = getCell():getGridSquare(5,5,0)
            local north = getCell():getGridSquare(5,4,0)
            assert(type(square) == 'userdata' and square == getPlayer():getCurrentSquare())
            assert(square:isBlockedTo(north) == true)
            assert(north:isBlockedTo(square) == false)
            assert(square:isBlockedTo(nil) == false and square:isBlockedTo(square) == false)
            assert(not pcall(function() return square:isBlockedTo(getPlayer()) end))
            assert(not pcall(function() return square:isBlockedTo(getCell()) end))
            assert(not pcall(function() return square:isBlockedTo({getX=function() return 5 end}) end))
            assert(not pcall(function() return square.isBlockedTo(getPlayer(), nil) end))
            assert(not pcall(function() return square:isBlockedTo(nil, north) end))
            getModData().blockedState = {}
            Events.OnTick.Add(function()
                assert(square == getCell():getGridSquare(5,5,0))
                getModData().blockedState.forward = square:isBlockedTo(north)
                getModData().blockedState.nilOther = square:isBlockedTo(nil)
            end)
        `, 'blocked-state');

        replace({ collideN: true, windowN: true });
        host.step(1 / 60);
        session.flushSaveData();
        assert.deepEqual(saved.get('host').data.nativePlayerData.blockedState, { forward: false, nilOther: false });
        replace({ blockedWindowN: true });
        host.step(1 / 60);
        session.flushSaveData();
        assert.equal(saved.get('host').data.nativePlayerData.blockedState.forward, true);
        replace({ blockedWindowN: true }, false);
        host.step(1 / 60);
        session.flushSaveData();
        assert.equal(saved.get('host').data.nativePlayerData.blockedState.forward, false, 'previously real other userdata now refers to an absent native square');
        cleanup();
    } finally {
        session.close();
        host.dispose();
    }
});

test('Lua square nil relation refuses an engine lacking the genuine native query', async () => {
    const engine = await createEngine(await readFile(new URL('../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url)));
    const host = createModHost({ snapshot: engine.snapshot, command: engine.command, setSpeed: engine.setSpeed, getSquare: engine.getSquare });
    const session = await createLuaSession();

    try {
        engine.importDoors([], { squares: [{ x: 5, y: 5, z: 0, roomId: -1, outside: true, solid: false, solidTrans: false, tree: false, vehicleObstructed: false, independentWalls: 0 }] });
        activate(session, host, `
            local square = getCell():getGridSquare(5,5,0)
            local ok, message = pcall(function() return square:isBlockedTo(nil) end)
            assert(not ok and tostring(message):find('unsupported', 1, true))
        `, 'unsupported-blocked-state');
    } finally {
        session.close();
        host.dispose();
    }
});

test('Lua body userdata retain identity while real ticks observe native pain and cold-hand timing', async () => {
    const { engine, host, session, saved } = await fixture();

    try {
        const cleanup = activate(session, host, `
            local player = getPlayer()
            local body = player:getBodyDamage()
            local parts = body:getBodyParts()
            local hand = body:getBodyPart(BodyPartType.Hand_L)
            local thermal = body:getThermoregulator()
            local node = hand:getThermalNode()
            assert(type(body) == 'userdata' and type(parts) == 'userdata')
            assert(type(hand) == 'userdata' and type(BodyPartType.Hand_L) == 'userdata')
            assert(parts:size() == 17 and parts:get(0) == hand)
            assert(BodyPartType.ToIndex(BodyPartType.MAX) == 17)
            assert(BodyPartType.FromIndex(0) == BodyPartType.Hand_L)
            assert(thermal:getNodeSize() == 17 and thermal:getNode(0) == node)
            assert(thermal:getNodeForType(BodyPartType.Hand_L) == node)
            assert(thermal:getNodeForType(BodyPartType.MAX) == nil)
            assert(hand:getSkinTemperature() == 33 and node:getSkinCelcius() == 33)
            hand:setScratchTime(10)
            assert(hand:getPain() == 17)
            getModData().bodyTiming = {ticks = 0}
            Events.OnTick.Add(function()
                assert(body == player:getBodyDamage() and parts == body:getBodyParts())
                assert(hand == body:getBodyPart(BodyPartType.Hand_L))
                assert(node == hand:getThermalNode() and thermal == body:getThermoregulator())
                local result = getModData().bodyTiming
                result.ticks = result.ticks + 1
                result.pain = hand:getPain()
                result.bandaged = hand:bandaged()
                result.skin = hand:getSkinTemperature()
                result.nodeSkin = node:getSkinCelcius()
                result.factor = player:getTimedActionTimeModifier()
                assert(result.factor == thermal:getTimedActionTimeModifier())
            end)
        `, 'body-timing');

        host.api.character.setBodyPart('Hand_L', { bandaged: true, skinTemperature: 20 });
        host.step(1 / 60);
        session.flushSaveData();
        const first = saved.get('host').data.nativePlayerData.bodyTiming;

        assert.equal(first.ticks, 1);
        assert.equal(first.bandaged, true);
        assert.equal(first.skin, 20);
        assert.equal(first.nodeSkin, 20);
        assert.ok(Math.abs(first.pain - 17 / 1.5) < 0.000_001);
        assert.ok(Math.abs(first.factor - 1.000_75) < 0.000_001);
        host.api.character.setBodyPart('Hand_L', { scratchTime: 0, additionalPain: -4, skinTemperature: 33 });
        host.step(1 / 60);
        session.flushSaveData();
        assert.deepEqual(saved.get('host').data.nativePlayerData.bodyTiming, {
            ticks: 2, pain: -4, bandaged: true, skin: 33, nodeSkin: 33, factor: 1,
        });
        assert.equal(engine.bodyParts()[0].pain, -4);
        assert.deepEqual(session.diagnostics().errors, []);
        assert.deepEqual(host.diagnostics().errors, []);
        cleanup();
        host.step(1 / 60);
        session.flushSaveData();
        assert.equal(saved.get('host').data.nativePlayerData.bodyTiming.ticks, 2);
    } finally {
        session.close();
        host.dispose();
    }
});

test('Lua awkward-glove query observes real native handwear replacement and unequip', async () => {
    const { engine, host, session, saved } = await fixture();
    const gloves = {
        fullType: 'Fixture.Gloves', bodyLocation: 'base:hands', conditionMax: 10, stackLimit: 1,
        removeOnBroken: false, conditionLowerChanceOneIn: 1, tags: ['base:awkwardgloves'],
    };

    engine.registerItemDefinition(gloves, { owner: 'fixture' });
    engine.equipmentOperation('locationAdd', engine.equipmentOperation('groupGet', 'Human', true), engine.equipmentOperation('lookup', 'Hands'));
    importPickupSquares(engine);
    engine.registerItemDefinition({
        ...gloves, fullType: 'Fixture.LightGloves', tags: [],
    }, { owner: 'fixture' });
    const ids = ['Fixture.Gloves', 'Fixture.LightGloves'].map((fullType) => {
        const id = host.api.items.spawn({ fullType, x: 5, y: 5 }).snapshot.id;

        host.api.items.pickup(id);
        completeActions(engine);

        return id;
    });

    try {
        activate(session, host, `
            local player = getPlayer()
            assert(player:isWearingAwkwardGloves() == false)
            getModData().gloves = {states = {}}
            Events.OnTick.Add(function()
                table.insert(getModData().gloves.states, player:isWearingAwkwardGloves())
            end)
        `, 'gloves');

        for (const id of [ids[0], ids[1], ids[0]]) {
            host.api.items.wear(id);
            host.step(1 / 60);
        }

        host.api.items.unequip(ids[0]);
        host.step(1 / 60);
        session.flushSaveData();
        assert.deepEqual(saved.get('host').data.nativePlayerData.gloves.states, [true, false, true, false]);
        assert.deepEqual(session.diagnostics().errors, []);
        assert.deepEqual(host.diagnostics().errors, []);
    } finally {
        session.close();
        host.dispose();
    }
});

test('Lua item weights stay live and independent while inventory carry uses native worn load', async () => {
    const { engine, host, session, saved } = await fixture();

    const [definition] = parseItemDefinitions(`module Fixture { item WeightedShoes {
        ItemType = base:clothing, BodyLocation = base:shoes, ConditionMax = 10, Weight = 0.2,
    } }`, 'fixture-weighted-shoes');

    engine.registerItemDefinition({
        ...definition, stackLimit: 1, removeOnBroken: false, conditionLowerChanceOneIn: 1,
    }, { owner: 'original-fixture' });
    engine.equipmentOperation('locationAdd', engine.equipmentOperation('groupGet', 'Human', true), engine.equipmentOperation('lookup', 'Shoes'));
    const id = host.api.items.spawn({ fullType: 'Fixture.WeightedShoes', x: 5, y: 5 }).snapshot.id;

    importPickupSquares(engine);

    host.api.items.pickup(id);
    completeActions(engine);
    host.api.items.wear(id);
    try {
        activate(session, host, `
            local player = getPlayer()
            local shoes = player:getClothingItem_Feet()
            local inventory = player:getInventory()
            assert(inventory == player:getInventory())
            assert(inventory:getMaxWeight() == 8)
            assert(shoes == player:getWornItem(ItemBodyLocation.SHOES))
            assert(shoes:getUnequippedWeight() == 0.20000000298023224)
            assert(inventory:getCapacityWeight() == 0.06000000238418579)
            shoes:setWeight(9)
            assert(shoes:getWeight() == 9 and shoes:getActualWeight() == 0.20000000298023224)
            shoes:setActualWeight(12)
            assert(shoes:getWeight() == 9 and shoes:getActualWeight() == 12)
            assert(shoes:getUnequippedWeight() == 12 and shoes:getContentsWeight() == 0)
            assert(math.abs(inventory:getCapacityWeight() - 3.6) < 0.000001)
            Events.OnTick.Add(function()
                getModData().weights = {
                    base = shoes:getWeight(), actual = shoes:getActualWeight(),
                    unequipped = shoes:getUnequippedWeight(), carry = inventory:getCapacityWeight()
                }
            end)
        `, 'weights');
        assert.deepEqual([engine.items()[0].weight, engine.items()[0].actualWeight], [9, 12]);
        host.api.items.setActualWeight(id, 0.375);
        host.api.items.unequip(id);
        host.step(1 / 60);
        session.flushSaveData();
        assert.deepEqual(saved.get('host').data.nativePlayerData.weights, {
            base: 9, actual: 0.375, unequipped: 0.375, carry: 0.375,
        });

        for (const [itemType, contents] of [
            ['base:clothing', 'AmmoType = Base.Bullets,'],
            ['base:clothing', 'component FluidContainer { Capacity = 1, }'],
            ['Custom.Clothing', ''],
        ]) {
            const [unsupported] = parseItemDefinitions(`module Fixture { item WeightedShoes {
                ItemType = ${itemType}, BodyLocation = base:shoes, ConditionMax = 10, Weight = 0.2,
                ${contents}
            } }`, 'fixture-unsupported-contents');

            const before = engine.exportInventoryGraph();
            const previous = engine.itemDefinitions().find(({ fullType }) => fullType === unsupported.fullType);
            const previousErrors = session.diagnostics().errors.length;

            engine.beginItemDefinitionRegistration('original-fixture');
            try {
                assert.throws(() => engine.registerItemDefinition({
                    ...unsupported, stackLimit: 1, removeOnBroken: false, conditionLowerChanceOneIn: 1,
                }, { owner: 'original-fixture', override: true }), /outside the accepted range/u,
                'unsupported source weight facilities must refuse before changing a live native definition');
            } finally {
                engine.rollbackItemDefinitionRegistration('original-fixture');
            }

            assert.deepEqual(engine.itemDefinitions().find(({ fullType }) => fullType === unsupported.fullType), previous);
            assert.deepEqual(engine.exportInventoryGraph(), before);
            host.step(1 / 60);
            assert.equal(session.diagnostics().errors.length, previousErrors);
            assert.deepEqual([engine.items()[0].weight, engine.items()[0].actualWeight], [9, 0.375]);
            assert.equal(engine.itemWeights(id).unequippedWeight, 0.375);
        }
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
        assert.throws(() => activate(session, host, '\x1BLua', 'bytecode'), /bytecode/);
        assert.throws(() => activate(session, host, 'while true do end', 'timeout'), /timeout/);
        assert.throws(() => session.preload({
            id: 'untrusted-stdlib', sources: [{ path: 'stdlib.lua', source: 'getModData().RootHijack=true' }],
        }), /unsupported native Lua source path/u);
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
            Events.OnKeyStartPressed.Add(function(key) if key == 65 then getPlayer():walk(-1, 0) end end)
            Events.OnKeyPressed.Add(function(key) if key == 65 then getPlayer():cancelAction() end end)
        `);
        session.dispatch('OnKeyStartPressed', 65);
        assert.equal(engine.snapshot().action, 2);
        host.step(1 / 60);
        assert.ok(engine.snapshot().x < 5);
        session.dispatch('OnKeyPressed', 65);
        assert.equal(engine.snapshot().action, 0);
        assert.throws(() => session.dispatch('OnEnterVehicle'), /unsupported/);
        assert.throws(() => session.dispatch('OnKeyReleased', 65), /unsupported externally dispatched event/u);
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

test('resident source action identity follows the native FIFO and rejects unsupported classes', async () => {
    const { engine, host, session, saved } = await fixture();

    try {
        importPickupSquares(engine);
        session.attachSourceActions(engine.sourceActions, engine.sourceTiming);
        activate(session, host, `
            ISTimedActionQueue = {queues={}}
            function ISTimedActionQueue:new(character)
                local value={character=character,queue={}}
                self.queues[character]=value
                return value
            end
            local queue
            ISWalkToTimedAction={Type='ISWalkToTimedAction'}
            ISWalkToTimedAction.__index=ISWalkToTimedAction
            function ISWalkToTimedAction:new()
                return setmetatable({character=getPlayer(),location=getCell():getGridSquare(4,4,0),
                    maxTime=-1,stopOnWalk=false,stopOnRun=false},self)
            end
            function ISWalkToTimedAction:isValid() return true end
            function ISWalkToTimedAction:waitToStart() return false end
            function ISWalkToTimedAction:start() getModData().SourceIdentity.starts=getModData().SourceIdentity.starts+1 end
            function ISWalkToTimedAction:update() assert(self.action:getTable()==self) end
            function ISWalkToTimedAction:stop() getModData().SourceIdentity.stopped=true end
            function ISWalkToTimedAction:perform() table.remove(queue.queue,1) end
            __pz_source_loaded()
            queue=ISTimedActionQueue:new(getPlayer())
            assert(queue.queue[#queue.queue]==nil and queue.queue[0]==nil)
            for _,key in ipairs({-1,0.5,'length'}) do
                assert(not pcall(function() return queue.queue[key] end))
            end
            getModData().SourceIdentity={starts=0,ordinary=false}
            local first,second=ISWalkToTimedAction:new(),ISWalkToTimedAction:new()
            assert(not pcall(function() queue.queue[0]=first end))
            table.insert(queue.queue,first)
            table.insert(queue.queue,second)
            assert(#queue.queue==2 and queue.queue[1]==first and queue.queue[2]==second)
            assert(queue.queue[0]==nil and queue.queue[#queue.queue+1]==nil)
            assert(next(queue.queue)==nil, 'view must not retain a second Lua FIFO')
            local count=0
            for _,value in pairs(queue.queue) do assert(value==first or value==second);count=count+1 end
            assert(count==2)
            local ordinary={1,2};table.insert(ordinary,2,3)
            assert(table.remove(ordinary,2)==3 and #ordinary==2)
            getModData().SourceIdentity.ordinary=true
            first.action=LuaTimedActionNew.new(first,getPlayer())
            getPlayer():StartAction(first.action)
            assert(getPlayer():getCharacterActions():contains(first.action))
            assert(not getPlayer():getCharacterActions():contains(second.action))
            local ok,err=pcall(function() table.insert(queue.queue,{Type='Unsupported',character=getPlayer()}) end)
            assert(not ok and tostring(err):find('unsupported source action'))
        `, 'source-identity');
        engine.sourceActions.dispatch(session.dispatchSourceAction);
        session.flushSaveData();
        assert.deepEqual(saved.get('host').data.nativePlayerData.SourceIdentity, { starts: 1, ordinary: true });
        assert.equal(engine.actions.getState().pending.length, 1);
    } finally {
        session.close();
        host.dispose();
    }
});

const SOURCE_ITEM_FIELDS = {
    conditionMax: 10, stackLimit: 1, bodyLocation: null, removeOnBroken: false, conditionLowerChanceOneIn: 1,
};

test('source prequeue drop primitives use real tags and do not emit clothing events for unattached items', async () => {
    const { engine, host, session } = await fixture();

    try {
        importPickupSquares(engine);
        engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.Tagged', tags: ['base:litlantern'] }, { owner: 'fixture' });
        engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.Untagged' }, { owner: 'fixture' });

        for (const fullType of ['Fixture.Tagged', 'Fixture.Untagged']) {
            const id = host.api.items.spawn({ fullType, x: 5, y: 5 }).snapshot.id;

            host.api.items.pickup(id);
            completeActions(engine);
        }

        const before = engine.exportInventoryGraph();

        activate(session, host, `
            local values=getPlayer():getInventory():getItems()
            assert(values:size()==2)
            local tagged,ordinary=values:get(0),values:get(1)
            assert(type(ItemTag.LIT_LANTERN)=='userdata')
            assert(tagged:hasTag(ItemTag.LIT_LANTERN) and not ordinary:hasTag(ItemTag.LIT_LANTERN))
            assert(not tagged:hasTag(ItemTag.KEY_RING) and not ordinary:hasTag(ItemTag.KEY_RING))
            assert(not pcall(function() ordinary:hasTag('base:litlantern') end))
            Events.OnClothingUpdated.Add(function() error('unattached item removal emitted a clothing event') end)
            getPlayer():removeAttachedItem(tagged)
            getPlayer():removeAttachedItem(ordinary)
            getPlayer():removeAttachedItem(ordinary)
            local square=getPlayer():getCurrentSquare()
            local diagonal=getCell():getGridSquare(6,6,0)
            assert(square:DistToProper(square)==0)
            assert(square:DistToProper(diagonal)==(string.unpack('f',string.pack('f',math.sqrt(2)))))
            assert(not pcall(function() square:DistToProper({getX=function() return 6 end,getY=function() return 6 end}) end))
        `, 'source-prequeue-drop-primitives');
        assert.deepEqual(engine.exportInventoryGraph(), before, 'unattached source calls must preserve actual item and equipment state');
        assert.deepEqual(session.diagnostics().errors, []);
    } finally {
        session.close({ discardSaveData: true });
        host.dispose();
    }
});

// Own-authored lifecycle model: real Lua tables and real native queue/commit operations, no game source.
const SOURCE_GROUP_FIXTURE = `
    getModData().QueueModel={starts=0,performs=0,stops=0,resets=0,jobStops=0,cancelled=0,adjustments=0,duplicateDenied=false}
    ISTimedActionQueue={queues={}}
    function ISTimedActionQueue:new(character)
        local value={character=character,queue={}}
        self.queues[character]=value
        return setmetatable(value,{__index=self})
    end
    function ISTimedActionQueue.getTimedActionQueue(character)
        return ISTimedActionQueue.queues[character] or ISTimedActionQueue:new(character)
    end
    function ISTimedActionQueue.add(value)
        if value.ignoreAction then return end
        local queue=ISTimedActionQueue.getTimedActionQueue(value.character)
        table.insert(queue.queue,value)
        if not queue.current then queue.current=queue.queue[1];queue.current:begin() end
    end
    function ISTimedActionQueue:resetQueue()
        getModData().QueueModel.resets=getModData().QueueModel.resets+1
        table.wipe(self.queue)
        self.current=nil
    end
    ISBaseTimedAction={}
    function ISBaseTimedAction:adjustMaxTime(value)
        getModData().QueueModel.adjustments=getModData().QueueModel.adjustments+1
        if value>1 then return value*(1+self.character:getMoodles():getMoodleLevel('base:unhappy')/4) end
        return value
    end
    function ISBaseTimedAction:create()
        self.maxTime=self:adjustMaxTime(self.maxTime)
        self.action=LuaTimedActionNew.new(self,self.character)
    end
    function ISBaseTimedAction:begin()
        self:create()
        self.character:StartAction(self.action)
    end
    function ISBaseTimedAction:waitToStart() return false end
    function ISBaseTimedAction:start()
        getModData().QueueModel.starts=getModData().QueueModel.starts+1
        self.started=true
    end
    function ISBaseTimedAction:update()
        assert(self.action:getTable()==self)
        if self.Type=='ISGrabItemAction' and not self.started then self:start() end
    end
    function ISBaseTimedAction:stop()
        getModData().QueueModel.stops=getModData().QueueModel.stops+1
        ISTimedActionQueue.getTimedActionQueue(self.character):resetQueue()
        self.character:setIsFarming(false)
    end
    function ISBaseTimedAction:forceCancel() getModData().QueueModel.cancelled=getModData().QueueModel.cancelled+1 end
    function ISBaseTimedAction:perform()
        local queue=ISTimedActionQueue.getTimedActionQueue(self.character)
        table.remove(queue.queue,1)
        queue.current=queue.queue[1]
        if queue.current then queue.current:begin() end
    end
    ISWalkToTimedAction=setmetatable({Type='ISWalkToTimedAction'},{__index=ISBaseTimedAction})
    ISWalkToTimedAction.__index=ISWalkToTimedAction
    function ISWalkToTimedAction:new(character,location)
        return setmetatable({character=character,location=location,maxTime=-1},self)
    end
    function ISWalkToTimedAction:isValid() return self.location~=nil end
    function ISWalkToTimedAction:update()
        local result=self.character:getPathFindBehavior2():update()
        if result==BehaviorResult.Succeeded then self.action:forceComplete()
        elseif result==BehaviorResult.Failed then self.action:forceStop() end
    end
    ISGrabItemAction=setmetatable({Type='ISGrabItemAction'},{__index=ISBaseTimedAction})
    ISGrabItemAction.__index=ISGrabItemAction
    function ISGrabItemAction:new(character,value,time)
        local action=setmetatable({character=character,item=value,maxTime=time,started=false,
            stopOnWalk=true,stopOnRun=true,queueList={}},self)
        local queue=ISTimedActionQueue.getTimedActionQueue(character)
        local tail=queue.queue[#queue.queue]
        if tail and tail.Type=='ISGrabItemAction' then
            local group=tail.queueList[#tail.queueList]
            if group and group.type==value:getItem():getFullType() and #group.items<20 then
                table.insert(group.items,value)
            else
                table.insert(tail.queueList,{time=time,type=value:getItem():getFullType(),items={value}})
            end
            action.ignoreAction=true
        else
            action.queueList[1]={time=time,type=value:getItem():getFullType(),items={value}}
        end
        return action
    end
    function ISGrabItemAction:isValid()
        return self.item:getSquare()~=nil and self.character:getInventory():hasRoomFor(self.character,self.item:getItem())
    end
    function ISGrabItemAction:stop()
        ISBaseTimedAction.stop(self)
        self.item:getItem():setJobDelta(0)
        self.started=false
        getModData().QueueModel.jobStops=getModData().QueueModel.jobStops+1
    end
    function ISGrabItemAction:transferItem(value)
        value:setSquare(nil)
        self.character:getInventory():AddItem(value:getItem())
        getModData().QueueModel.duplicateDenied=not pcall(function()
            self.character:getInventory():AddItem(value:getItem())
        end)
    end
    function ISGrabItemAction:perform()
        getModData().QueueModel.performs=getModData().QueueModel.performs+1
        local batch=table.remove(self.queueList,1)
        for _,value in ipairs(batch.items) do
            self.item=value
            if not self:isValid() then table.wipe(self.queueList);break end
            self:transferItem(value)
        end
        self.started=false
        if #self.queueList>0 then
            self.item=self.queueList[1].items[1]
            self.maxTime=self.queueList[1].time
            self.action:setTime(self.maxTime)
            self.action:resetJobDelta()
        else
            local queue=ISTimedActionQueue.getTimedActionQueue(self.character)
            table.remove(queue.queue,1)
            queue.current=queue.queue[1]
            if queue.current then queue.current:begin() end
        end
    end
    local QueueModelWorldCache={}
    function QueueModelWorld(id)
        local square=getPlayer():getSquare()
        local cached=QueueModelWorldCache[id]
        if cached and cached:getSquare()==square then return cached end
        local values=square:getWorldObjects()
        for index=0,values:size()-1 do
            local value=values:get(index)
            QueueModelWorldCache[value:getItem():getID()]=value
        end
        local value=QueueModelWorldCache[id]
        if value and value:getSquare()==square then return value end
        error('fixture ground identity missing')
    end
    function QueueModelGrab(id,time)
        local value=ISGrabItemAction:new(getPlayer(),QueueModelWorld(id),time)
        ISTimedActionQueue.add(value)
        return value
    end
    __pz_source_loaded()
`;

/**
 * Drive genuine Lua callbacks around each real native logical frame.
 *
 * @param {object} engine - Native WASM engine.
 * @param {object} host - Public host frame driver.
 * @param {object} session - Resident Lua VM.
 */
function completeLuaActions(engine, host, session) {
    for (let frame = 0; frame < 5_000; frame += 1) {
        if (!engine.actions.getState().current && !engine.actions.getState().pending.length) {
            return;
        }

        host.frameStep(1 / 60);
        engine.sourceActions.dispatch(session.dispatchSourceAction);
    }

    assert.fail('Resident Lua actions did not finish');
}

for (const sdkFirst of [false, true]) {
    test(`source/native last-group merge shares identity and commits once, SDK first=${sdkFirst}`, async () => {
        const { engine, host, session, saved } = await fixture();

        try {
            importPickupSquares(engine);
            engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.Merge', weight: 0.1 }, { owner: 'fixture' });
            const ids = Array.from({ length: 2 }, () => host.api.items.spawn({ fullType: 'Fixture.Merge', x: 5, y: 5 }).snapshot.id);

            session.attachSourceActions(engine.sourceActions, engine.sourceTiming);
            await loadSource(session, host, SOURCE_GROUP_FIXTURE, 'queue-model');

            if (sdkFirst) {
                host.api.items.pickup(ids[0]);
            } else {
                await loadSource(session, host, `QueueModelGrab(${ids[0]},2)`, 'queue-admit');
            }

            const before = engine.actions.getState().current;

            assert.deepEqual(before.target, { id: ids[0], x: 5, y: 5, z: 0 });

            await loadSource(session, host, `
                QueueModelGroup=ISTimedActionQueue.getTimedActionQueue(getPlayer()).queue[1].queueList[1]
                assert(#QueueModelGroup.items==1)
            `, 'queue-observe-before');

            if (sdkFirst) {
                await loadSource(session, host, `QueueModelGrab(${ids[1]},99)`, 'queue-admit');
            } else {
                host.api.items.pickup(ids[1]);
            }

            await loadSource(session, host, `
                local queue=ISTimedActionQueue.getTimedActionQueue(getPlayer()).queue
                assert(next(queue)==nil and #queue==1)
                assert(queue[1].queueList[1]==QueueModelGroup and #QueueModelGroup.items==2)
                assert(QueueModelGroup.items[1]:getItem():getID()==${ids[0]})
                assert(QueueModelGroup.items[2]:getItem():getID()==${ids[1]})
            `, 'queue-observe-after');
            const merged = engine.actions.getState().current;

            assert.equal(merged.id, before.id);
            assert.equal(merged.groups[0].id, before.groups[0].id);
            assert.equal(merged.rawTime, before.rawTime);
            assert.deepEqual(merged.groups[0].itemIds, ids);
            assert.deepEqual(session.exportSourceOwners(), sdkFirst ? [] : [{ actionId: before.id, ownerId: 'queue-admit' }]);
            assert.ok(ids.every((id) => host.api.items.get(id).worldPosition !== null));
            completeLuaActions(engine, host, session);
            assert.ok(ids.every((id) => host.api.items.get(id).ownerContainerId === host.api.items.playerInventoryId()));
            session.flushSaveData();
            const stats = saved.get('queue-model').data.nativePlayerData.QueueModel;

            assert.equal(stats.performs, sdkFirst ? 0 : 1);
            assert.equal(stats.duplicateDenied, !sdkFirst);
            assert.deepEqual(engine.actions.getState(), { current: null, pending: [] });
        } finally {
            session.close();
            host.dispose();
        }
    });
}

test('source transfer preserves a valid capacity prefix and opaque callbacks refuse portable capture', async () => {
    const { engine, host, session, saved } = await fixture();

    try {
        importPickupSquares(engine);
        engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.Prefix', weight: 20 }, { owner: 'fixture' });
        const ids = Array.from({ length: 3 }, () => host.api.items.spawn({ fullType: 'Fixture.Prefix', x: 5, y: 5 }).snapshot.id);

        session.attachSourceActions(engine.sourceActions, engine.sourceTiming);
        await loadSource(session, host, `${SOURCE_GROUP_FIXTURE}
            QueueModelHead=QueueModelGrab(${ids[0]},2)
            QueueModelGrab(${ids[1]},40)
            QueueModelGrab(${ids[2]},60)
            QueueModelHead.additionalTest=function() return true end
        `, 'queue-prefix');
        assert.throws(() => engine.saveQueueState());
        await loadSource(session, host, `QueueModelHead.additionalTest=nil`, 'queue-clear-opaque');
        assert.ok(engine.saveQueueState().length > 0);
        completeLuaActions(engine, host, session);
        assert.equal(host.api.items.get(ids[0]).ownerContainerId, host.api.items.playerInventoryId());
        assert.equal(host.api.items.get(ids[1]).ownerContainerId, host.api.items.playerInventoryId());
        assert.notEqual(host.api.items.get(ids[2]).worldPosition, null);
        session.flushSaveData();
        assert.equal(saved.get('queue-prefix').data.nativePlayerData.QueueModel.duplicateDenied, true);
    } finally {
        session.close();
        host.dispose();
    }
});

test('source clear stops the active action and force-cancels each pending table exactly once', async () => {
    const { engine, host, session, saved } = await fixture();

    try {
        importPickupSquares(engine);
        engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.Cancel', weight: 0.1 }, { owner: 'fixture' });
        const ids = Array.from({ length: 2 }, () => host.api.items.spawn({ fullType: 'Fixture.Cancel', x: 5, y: 5 }).snapshot.id);

        session.attachSourceActions(engine.sourceActions, engine.sourceTiming);
        activate(session, host, `${SOURCE_GROUP_FIXTURE}
            QueueModelGrab(${ids[0]},200)
            ISTimedActionQueue.add(ISWalkToTimedAction:new(getPlayer(),getCell():getGridSquare(4,4,0)))
            QueueModelGrab(${ids[1]},200)
            local queue=ISTimedActionQueue.getTimedActionQueue(getPlayer())
            assert(#queue.queue==3)
            table.wipe(queue.queue)
            assert(#queue.queue==0)
            table.wipe(queue.queue)
        `, 'queue-cancel');
        host.frameStep(1 / 60);
        session.flushSaveData();
        const stats = saved.get('host').data.nativePlayerData.QueueModel;

        assert.equal(stats.stops, 1);
        assert.equal(stats.cancelled, 2);
        assert.ok(ids.every((id) => host.api.items.get(id).worldPosition !== null));
        assert.deepEqual(engine.actions.getState(), { current: null, pending: [] });
    } finally {
        session.close();
        host.dispose();
    }
});

test('source hydration uses declared owners before activation and preserves later top-level group admission', async () => {
    const original = await fixture();
    const candidate = await fixture();
    const definition = { ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.Restore', weight: 0.01 };
    const source = `${SOURCE_GROUP_FIXTURE}
        for id=1,25 do QueueModelGrab(id,id<=20 and 2 or 9) end
    `;

    try {
        for (const value of [original, candidate]) {
            importPickupSquares(value.engine);
            value.engine.registerItemDefinition(definition, { owner: 'fixture' });

            for (let index = 0; index < 26; index += 1) {
                assert.equal(value.host.api.items.spawn({ fullType: definition.fullType, x: 5, y: 5 }).snapshot.id, index + 1);
            }

            value.session.attachSourceActions(value.engine.sourceActions, value.engine.sourceTiming);
        }

        await loadSource(original.session, original.host, source, 'queue-save-owner');
        await loadSource(original.session, original.host, `
            local value=QueueModelWorld(26)
            local action=setmetatable({character=getPlayer(),item=value,maxTime=3,started=false,
                stopOnWalk=true,stopOnRun=true,queueList={{time=3,type=value:getItem():getFullType(),items={value}}}},
                ISGrabItemAction)
            ISTimedActionQueue.add(action)
        `, 'queue-second-owner');
        const owners = original.session.exportSourceOwners();
        const bytes = original.engine.saveQueueState();
        const before = original.engine.actions.getState();

        assert.equal(before.current.groups.length, 2);
        assert.deepEqual(before.current.groups.map((group) => group.itemIds.length), [20, 5]);
        assert.equal(before.pending.length, 1);
        assert.deepEqual(owners.map((owner) => owner.ownerId), ['queue-save-owner', 'queue-second-owner']);
        candidate.engine.loadQueueState(bytes);
        const extra = candidate.host.api.items.spawn({ fullType: definition.fullType, x: 5, y: 5 }).snapshot.id;
        const descriptor = {
            id: 'queue-save-owner', nativeId: 'queue-save-owner',
            sources: [{ path: 'media/lua/client/queue-save-owner/resume.lua', source: `QueueModelGrab(${extra},99)` }],
        };
        const secondDescriptor = { id: 'queue-second-owner', nativeId: 'queue-second-owner', sources: [] };

        candidate.session.preload(descriptor);
        candidate.session.preload(secondDescriptor);
        candidate.session.preload({
            id: 'engine-fixture', nativeId: 'FixtureEngine', engineSource: true,
            sources: [
                { path: 'media/lua/client/QueueModelClasses.lua', source: SOURCE_GROUP_FIXTURE },
                ...['ISTimedActionQueue', 'ISGrabItemAction', 'ISOpenCloseDoor', 'WalkToTimedAction', 'ISWaitWhileGettingUp']
                    .map((name) => ({ path: `media/lua/client/TimedActions/${name}.lua`, source: `return ${name === 'WalkToTimedAction' ? 'ISWalkToTimedAction' : name}` })),
                { path: 'media/lua/client/ISUI/ISWorldObjectContextMenu.lua', source: 'return ISWorldObjectContextMenu' },
            ],
        });
        candidate.session.activatePackage({
            id: 'pz-base-game', nativeId: 'ProjectZomboid', api: candidate.host.coreApi,
            sources: [{ path: 'media/lua/client/pz-base-game/main.lua', source: 'require "QueueModelClasses"' }],
        });
        candidate.session.restoreSourceActions(before, owners, [
            { id: 'pz-base-game', nativeId: 'ProjectZomboid' },
            { id: descriptor.id, nativeId: descriptor.nativeId },
            { id: secondDescriptor.id, nativeId: secondDescriptor.nativeId },
        ]);
        assert.deepEqual(candidate.engine.actions.getState(), before);
        candidate.engine.frameStep(1 / 60);
        const event = candidate.engine.sourceActions.eventRead();

        assert.ok(event, 'real native callback authorization must be pending');
        assert.throws(() => candidate.session.dispatchSourceAction(event), /not active|missing|disabled/u);
        await loadPackage(candidate.session, candidate.host, descriptor);
        assert.throws(() => candidate.session.flushSaveData(), /not active|missing|disabled/u,
            'external capture must still reject the second inactive hydrated owner');
        await loadPackage(candidate.session, candidate.host, secondDescriptor);
        const admitted = candidate.engine.actions.getState();

        assert.equal(admitted.current.id, before.current.id);
        assert.equal(admitted.current.maxTime, before.current.maxTime);
        assert.deepEqual(admitted.current.groups[1].itemIds, before.current.groups[1].itemIds);
        assert.deepEqual(admitted.pending[0].groups[0].itemIds, [26, extra]);
        candidate.session.restoreSourceActions(before, owners);
        assert.deepEqual(candidate.engine.actions.getState(), admitted);
        candidate.engine.sourceActions.dispatch(candidate.session.dispatchSourceAction);
        completeLuaActions(candidate.engine, candidate.host, candidate.session);
        assert.equal(candidate.host.api.items.containerItems(candidate.host.api.items.playerInventoryId()).length, 27);
        assert.deepEqual(candidate.engine.actions.getState(), { current: null, pending: [] });
    } finally {
        original.session.close();
        original.host.dispose();
        candidate.session.close();
        candidate.host.dispose();
    }
});

test('private original inventory UI survives SDK walks and one hundred genuine post-save rebuilds with bounded native lifetime', async (t) => {
    const content = await privateOriginalContent(t);

    if (!content) {
        return;
    }

    const definition = {
        ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.UiLifetime', type: 'Normal', weight: 0.01,
        rawFields: [{ name: 'Icon', value: 'Paperclip' }],
    };
    const resources = await loadNativeGameResources(content, [], 60, { requireUI: true, itemDefinitions: [definition] });
    const textures = await Promise.all(resources.textures.map(async ({ file, ...texture }) => ({
        ...texture,
        ...(texture.crop
            ? { width: texture.crop.width, height: texture.crop.height }
            : parsePngHeader(new Uint8Array(await file.slice(0, 33).arrayBuffer()))),
    })));
    const records = new Map();
    const sourceFiles = createSourceFiles({
        sourceBuild: content.manifest.sourceBuild.version, ownerId: 'pz-base-game',
        storage: {
            /**
             * Read this fixture's isolated original-file namespace.
             *
             * @param {string} key - Namespaced source-file key.
             * @returns {string|null} Genuine saved text or absence.
             */
            getItem: (key) => records.get(key) ?? null,
            /**
             * Commit actual original writer output to isolated storage.
             *
             * @param {string} key - Namespaced source-file key.
             * @param {string} value - Original writer text.
             */
            setItem: (key, value) => {
                records.set(key, value);
            },
        },
    });
    const dom = menuDocument();
    const ui = createGameUI({ document: dom.document, focusTarget: dom.canvas });

    resources.translations[definition.fullType] = 'UI lifetime fixture item';
    ui.setViewport(640, 640);
    ui.initialize({ ...resources, textures });
    const observed = observeUiLifetime(ui);
    const feedback = [];
    const bindings = {
        'Toggle Inventory': { keyValue: 23, altKey: 0, shift: false, ctrl: false, alt: false },
        Aim: { keyValue: 30, altKey: 29, shift: false, ctrl: false, alt: false },
    };
    const { engine, host, session } = await fixture({
        ui: observed.ui, sourceFiles,
        engineStartup: resources.engineSources.filter(({ execute }) => execute).map(({ path }) => ({ id: 'engine-lua', path })),
        sourceWorldContext: {
            rooms: [], buildings: [],
            /**
             * Retain original callback failures rather than replacing failed behavior.
             *
             * @param {unknown} cause - Original callback failure.
             * @returns {number} Updated feedback count.
             */
            onError: (cause) => feedback.push(cause),
            /**
             * The fixture actively steps the real simulation.
             *
             * @returns {boolean} Whether simulation stepping is paused.
             */
            paused: () => false,
            /**
             * The fixture uses an unscaled logical viewport.
             *
             * @returns {number} Logical viewport zoom.
             */
            getZoom: () => 1,
            /**
             * Project the actual fixture square into the logical viewport.
             *
             * @returns {{x:number,y:number}} Logical screen coordinates.
             */
            objectScreenPosition: () => ({ x: 320, y: 320 }),
            /**
             * Select the fixture's real native square for original pointer consumers.
             *
             * @returns {{x:number,y:number}} Native square coordinates.
             */
            screenToIso: () => ({ x: 5, y: 5 }),
            /**
             * Read actual native imported world bounds.
             *
             * @param {number} x - Native world x coordinate.
             * @param {number} y - Native world y coordinate.
             * @param {number} z - Native world floor.
             * @returns {boolean} Whether the real engine owns the square's chunk.
             */
            isValidSquare: (x, y, z) => {
                const bounds = engine.worldBounds();
                const cx = Math.floor(x / 256);
                const cy = Math.floor(y / 256);

                return z === 0 && bounds.active && cx >= bounds.minCx && cx <= bounds.maxCx && cy >= bounds.minCy && cy <= bounds.maxCy;
            },
            /**
             * No joypad is bound in this keyboard/mouse fixture.
             *
             * @returns {number} Unbound joypad identifier.
             */
            joypadBind: () => -1,
            /**
             * Read the fixture's real configured key binding.
             *
             * @param {string} name - Original binding name.
             * @returns {object|null} Configured binding or absence.
             */
            keyBinding: (name) => bindings[name] ?? null,
            /**
             * Expose the same configured binding records to original collision queries.
             *
             * @returns {object} Configured key bindings.
             */
            keyBindings: () => bindings,
            /**
             * No physical key is held during idle save/rebuild cycles.
             *
             * @returns {boolean} Whether a physical key is held.
             */
            isSourceKeyDown: () => false,
            /**
             * No physical mouse button is held during idle save/rebuild cycles.
             *
             * @returns {boolean} Whether a physical mouse button is held.
             */
            isMouseButtonDown: () => false,
        },
    });

    try {
        importPickupSquares(engine);
        engine.registerItemDefinition(definition, { owner: 'fixture' });
        host.api.items.spawn({ fullType: definition.fullType, x: 5, y: 5 });
        session.preload({ id: 'engine-lua', nativeId: 'ProjectZomboid', engineSource: true, sources: resources.engineSources });
        session.activatePackage({
            id: 'pz-base-game', nativeId: 'ProjectZomboid', api: host.coreApi,
            sources: [{
                path: 'media/lua/client/pz-base-game/bootstrap.lua',
                source: 'require "TimedActions/ISTimedActionQueue"; require "TimedActions/ISGrabItemAction"',
            }],
        });
        session.dispatch('OnCreatePlayer', 0);
        session.dispatch('OnGameStart');
        await loadSource(session, host, `
            assert(rawget(_G,'ISWalkToTimedAction')==nil,
                'a native SDK walk must work before the original world-context constructor is required')
            assert(getPlayer():getCharacterActions():isEmpty())
        `, 'sdk-walk-before-context');
        const walk = host.api.actions.requestWalk({ x: 6, y: 5, z: 0 });

        assert.equal(walk.accepted, true);
        host.frameStep(1 / 60);
        assert.equal(engine.actions.getState().current.id, walk.actionId);
        assert.equal(engine.actions.getState().current.origin, 'sdk');
        await loadSource(session, host, `
            local actions=getPlayer():getCharacterActions()
            assert(not actions:isEmpty())
            SDKWalkHandle=actions:get(0)
            local value=SDKWalkHandle:getTable()
            assert(value.Type=='ISWalkToTimedAction' and value.character==getPlayer())
            assert(value.location:getX()==6 and value.location:getY()==5 and value.location:getZ()==0)
            assert(value.additionalTest==nil and value.additionalContext==nil,
                'the location assertion must not expand an error string into optional constructor arguments')
            assert(actions:get(0)==SDKWalkHandle and SDKWalkHandle:getTable()==value,
                'native SDK walk reads must retain one original action and handle identity')
        `, 'sdk-walk-resident-identity');
        assert.equal(engine.actions.getState().current.id, walk.actionId);
        host.api.actions.cancel();
        host.frameStep(1 / 60);
        assert.deepEqual(engine.actions.getState(), { current: null, pending: [] });
        const stopped = engine.snapshot();

        for (let tick = 0; tick < 4; tick += 1) {
            host.frameStep(1 / 60);
        }

        assert.equal(engine.snapshot().x, stopped.x);
        assert.equal(engine.snapshot().y, stopped.y);
        await loadSource(session, host, `
            assert(getPlayer():getCharacterActions():isEmpty())
            SDKWalkHandle=nil
        `, 'sdk-walk-stopped');
        session.initializeInventoryPages();
        let peakMemory = session.diagnostics().memoryBytes;

        /**
         * Finish each genuine save flush before beginning the next hundred-frame cycle.
         *
         * @param {number} remaining - Sequential rebuild cycles still required.
         * @returns {Promise<void>} Completion of all remaining genuine rebuilds.
         */
        async function rebuildInventoryPages(remaining) {
            for (let frame = 0; frame < 100; frame += 1) {
                session.updateActorInput();
                host.frameStep(1 / 60);
                ui.render();
                session.updateWorldPointer(5, 5);
                session.renderWorldPhase('opaque', 0);
                session.renderWorldPhase('building', 0);
            }

            const oldRoots = ui.bindings.call('getUI', 'pz-base-game');

            session.prepareSourceSave();
            session.flushSaveData();
            session.dispatch('OnPostSave');
            await session.flushSourceFiles();
            session.initializeInventoryPages();
            const newRoots = ui.bindings.call('getUI', 'pz-base-game');

            assert.equal(newRoots.length, 3);
            assert.notDeepEqual(newRoots, oldRoots, 'genuine post-save teardown must recreate the original inventory UI');
            peakMemory = Math.max(peakMemory, session.diagnostics().memoryBytes);

            if (remaining > 1) {
                await rebuildInventoryPages(remaining - 1);
            }
        }

        await rebuildInventoryPages(100);

        assert.ok(observed.counts.new > 4_000, 'the original callbacks must actually rebuild their native elements');
        assert.ok(observed.counts.release > observed.counts.new / 2, 'abandoned original page wrappers must release native elements');
        assert.ok(observed.counts.transitionRelease > observed.counts.transitionNew / 2,
            'original page transitions must not accumulate across genuine saves');
        assert.ok(peakMemory < 16 * 1_024 * 1_024, `original UI heap must remain bounded, observed ${peakMemory} bytes`);
        assert.equal(session.diagnostics().memoryLimitBytes, 32 * 1_024 * 1_024);
        assert.equal(session.diagnostics().timeouts, 0);
        assert.deepEqual(session.diagnostics().errors, []);
        assert.deepEqual(host.diagnostics().errors, []);
        assert.deepEqual(feedback, []);
    } finally {
        session.close({ discardSaveData: true });
        host.dispose();
        ui.dispose();
        sourceFiles.dispose();
    }
});

test('private original queued grabs restore headlessly before explicit resident inventory-page activation', async (t) => {
    const content = await privateOriginalContent(t);

    if (!content) {
        return;
    }

    const { manifest } = content;
    const definition = {
        ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.OriginalRestore', weight: 0.01,
        rawFields: [{ name: 'Icon', value: 'Paperclip' }],
    };
    const resources = await loadNativeGameResources(content, [], 60, { requireUI: true, itemDefinitions: [definition] });
    const sources = resources.engineSources;
    const textures = await Promise.all(resources.textures.map(async ({ file, ...texture }) => ({
        ...texture,
        ...(texture.crop
            ? { width: texture.crop.width, height: texture.crop.height }
            : parsePngHeader(new Uint8Array(await file.slice(0, 33).arrayBuffer()))),
    })));
    const floorImagePath = 'media/ui/inventoryPanes/TakeSameTypeOneContainer.png';
    const floorImage = parsePngHeader(new Uint8Array(await content.getFile(floorImagePath).slice(0, 33).arrayBuffer()));

    resources.translations['Fixture.OriginalRestore'] = 'Restored fixture item';
    resources.translations['Fixture.OutlineBag'] = 'Outline fixture bag';
    const coreOptions = new Map();
    const coreStorage = {
        /**
         * Read persisted original Core presentation options.
         *
         * @param {string} key - Origin-owned options key.
         * @returns {string|null} The saved document, if present.
         */
        getItem: (key) => coreOptions.get(key) ?? null,
        /**
         * Store the actual Core options document for a fresh UI session.
         *
         * @param {string} key - Origin-owned options key.
         * @param {string} value - Serialized Core options.
         */
        setItem: (key, value) => {
            coreOptions.set(key, value);
        },
    };
    const originalDOM = menuDocument();
    const candidateDOM = menuDocument();

    Object.defineProperty(candidateDOM.document.body, 'ownerDocument', {
        enumerable: true,
        /** Keep the host DOM opaque to the native interpreter. */
        get() {
            throw new Error('Native Lua must not enumerate the host DOM graph');
        },
    });
    const originalUI = createGameUI({ document: originalDOM.document, focusTarget: originalDOM.canvas, storage: coreStorage });
    const candidateUI = createGameUI({ document: candidateDOM.document, focusTarget: candidateDOM.canvas });

    for (const ui of [originalUI, candidateUI]) {
        ui.setViewport(640, 640);
        ui.initialize({
            ...resources, textures,
        });
    }

    const sourceFeedback = [];
    const physicalKeys = new Set();
    const inputBindings = {
        'Toggle Inventory': { keyValue: 23, altKey: 0, shift: false, ctrl: false, alt: false },
        Aim: { keyValue: 30, altKey: 29, shift: false, ctrl: false, alt: false },
    };
    let physicalMouseButtons = 0;
    let joypadBinding = -1;
    const options = {
        engineStartup: sources.filter(({ execute }) => execute).map(({ path }) => ({ id: 'engine-lua', path })),
        sourceWorldContext: {
            rooms: [], buildings: [],
            /**
             * Retain attributed original UI feedback for the fixture's assertion.
             *
             * @param {Error} cause - Actual original callback failure.
             */
            onError: (cause) => {
                sourceFeedback.push(cause);
            },
            /**
             * Report this actively stepped fixture's current pause state.
             *
             * @returns {boolean} The fixture is running, not paused.
             */
            paused: () => false,
            /**
             * Read the fixture's supported logical-content zoom.
             *
             * @returns {number} Fixture zoom in logical content units.
             */
            getZoom: () => 1,
            /**
             * Project the fixture's native ground item.
             *
             * @returns {{x:number,y:number}} Supported fixture ground projection.
             */
            objectScreenPosition: () => ({ x: 320, y: 320 }),
            /**
             * Resolve the fixture's pointer onto native ground.
             *
             * @returns {{x:number,y:number}} Fixture pointer's native ground location.
             */
            screenToIso: () => ({ x: 5, y: 5 }),
            /**
             * Report the fixture's keyboard-only controller binding.
             *
             * @returns {number} Keyboard-only native controller binding.
             */
            joypadBind: () => joypadBinding,
            /**
             * Resolve an original source binding.
             *
             * @param {string} name - Original source binding.
             * @returns {object|null} Configured native key record.
             */
            keyBinding: (name) => inputBindings[name] ?? null,
            /**
             * Read the fixture's primary-key collisions.
             *
             * @returns {object} Actual configured primary-key collision records.
             */
            keyBindings: () => inputBindings,
            /**
             * Read the fixture's current physical native keyboard state.
             *
             * @param {number} code - Original native key code.
             * @returns {boolean} Whether the key is physically down.
             */
            isSourceKeyDown: (code) => physicalKeys.has(code),
            /**
             * Read the same fixture-owned physical controls for original timed actions.
             *
             * @param {'movement'|'cancel'} kind - Original input query.
             * @returns {boolean} Current physical movement or cancellation request.
             */
            input: (kind) => {
                if (kind === 'movement') {
                    return physicalKeys.has(17) || physicalKeys.has(31) || physicalKeys.has(30) || physicalKeys.has(32);
                }

                if (kind === 'cancel') {
                    return physicalKeys.has(1);
                }

                throw new Error(`Unsupported source input: ${kind}.`);
            },
            /**
             * Read the fixture's current native-indexed physical mouse state.
             *
             * @param {number} index - Original left/right/middle indices 0/1/2, through native button 7.
             * @returns {boolean} Actual current fixture input state.
             */
            isMouseButtonDown: (index) => (physicalMouseButtons & (1 << index)) !== 0,
        },
    };

    /**
     * Keep original layout IO within an isolated real source-file host.
     *
     * @returns {object} Session-owned original file bindings.
     */
    function privateFiles() {
        const records = new Map();

        return createSourceFiles({
            sourceBuild: manifest.sourceBuild.version, ownerId: 'pz-base-game',
            storage: {
                /**
                 * Read the fixture's isolated source namespace.
                 *
                 * @param {string} key - Source-file storage key.
                 * @returns {string|null} Retained text or absence.
                 */
                getItem: (key) => records.get(key) ?? null,
                /**
                 * Persist source-owned fixture text without original disk writes.
                 *
                 * @param {string} key - Source-file storage key.
                 * @param {string} value - Source-authored text.
                 */
                setItem: (key, value) => {
                    records.set(key, value);
                },
            },
        });
    }

    const headlessDOM = menuDocument();
    const headlessUI = createGameUI({ document: headlessDOM.document, focusTarget: headlessDOM.canvas });
    const headlessFiles = privateFiles();

    headlessUI.setViewport(640, 640);
    headlessUI.initialize({ ...resources, textures });
    const bootstrapRecords = new Map();
    const bootstrapPreferences = 'player:0\r\nwindowKey:BuildWindow\r\nx=12\r\ny=34\r\nwidth=320\r\nheight=200\r\nlocked=false\r\n';
    let rejectEntityRead = false;
    const bootstrapFileOptions = {
        sourceBuild: manifest.sourceBuild.version, ownerId: 'pz-base-game',
        storage: {
            /**
             * Preserve real durable preferences while injecting one candidate's initial read failure.
             *
             * @param {string} key - Exact namespaced Core file key.
             * @returns {string|null} Durable text or absence.
             */
            getItem(key) {
                if (rejectEntityRead && key.includes('"entityLayout.ini"')) {
                    throw new DOMException('entity layout bootstrap read denied', 'SecurityError');
                }

                return bootstrapRecords.get(key) ?? null;
            },
            /**
             * Commit the actual original file writer's text.
             *
             * @param {string} key - Exact namespaced Core file key.
             * @param {string} value - Complete source-authored text.
             * @returns {void} Nothing.
             */
            setItem(key, value) {
                bootstrapRecords.set(key, value);
            },
        },
    };
    const seededBootstrapFiles = createSourceFiles(bootstrapFileOptions);

    seededBootstrapFiles.write('entityLayout.ini', bootstrapPreferences);
    await seededBootstrapFiles.flush();
    seededBootstrapFiles.dispose();
    rejectEntityRead = true;
    const failedBootstrap = await fixture({ ...options, ui: headlessUI, sourceFiles: createSourceFiles(bootstrapFileOptions) });

    try {
        failedBootstrap.session.preload({ id: 'engine-lua', nativeId: 'ProjectZomboid', engineSource: true, sources });
        assert.throws(() => failedBootstrap.session.activatePackage({
            id: 'pz-base-game', nativeId: 'ProjectZomboid', api: failedBootstrap.host.coreApi, sources: [],
        }), /entity layout bootstrap read denied/u);
        assert.throws(() => failedBootstrap.session.dispatch('OnGameStart'), /closed/u,
            'a partially initialized original entity registry must not remain publishable');
        assert.deepEqual([...bootstrapRecords.values()], [bootstrapPreferences]);
    } finally {
        failedBootstrap.session.close({ discardSaveData: true });
        failedBootstrap.host.dispose();
        rejectEntityRead = false;
    }

    const retriedBootstrapFiles = createSourceFiles(bootstrapFileOptions);
    const retriedBootstrap = await fixture({ ...options, ui: headlessUI, sourceFiles: retriedBootstrapFiles });

    try {
        retriedBootstrap.session.preload({ id: 'engine-lua', nativeId: 'ProjectZomboid', engineSource: true, sources });
        retriedBootstrap.session.activatePackage({ id: 'pz-base-game', nativeId: 'ProjectZomboid', api: retriedBootstrap.host.coreApi, sources: [] });
        await loadSource(retriedBootstrap.session, retriedBootstrap.host, `
            assert(not ISEntityUI.IsWindowOpen(0,'BuildWindow'))
            local preferences=ISEntityUI.players[0].windows.BuildWindow
            assert(preferences.x==12 and preferences.y==34 and preferences.width==320 and preferences.height==200,
                'a fresh candidate must retry the genuine read rather than inherit a poisoned empty registry')
        `, 'original-entity-bootstrap-retry');
        retriedBootstrap.session.dispatch('OnPostSave');
        await retriedBootstrap.session.flushSourceFiles();
        assert.match(retriedBootstrapFiles.read('entityLayout.ini'), /^windowKey:BuildWindow\r?$/mu,
            'a genuine post-save callback after retry must not erase durable window preferences');
        assert.match(retriedBootstrapFiles.read('entityLayout.ini'), /^x=12\r?$/mu);
    } finally {
        retriedBootstrap.session.close({ discardSaveData: true });
        retriedBootstrap.host.dispose();
    }

    const headless = await fixture({ ...options, ui: headlessUI, sourceFiles: headlessFiles });

    try {
        importPickupSquares(headless.engine);
        headless.session.preload({ id: 'engine-lua', nativeId: 'ProjectZomboid', engineSource: true, sources });
        headless.session.activatePackage({ id: 'pz-base-game', nativeId: 'ProjectZomboid', api: headless.host.coreApi, sources: [] });
        activate(headless.session, headless.host, `
            local instance=assert(CCampfireSystem.instance,'original client init must precede player and game startup')
            local system=CGlobalObjects.getSystemByName('campfire')
            assert(instance.system==system and system:getModData()==instance and system:getModData()==system:getModData(),
                'the unchanged CGlobalObjectSystem constructor must own its actual resident metadata table')
            assert(instance.systemName=='campfire' and CGlobalObjects.getSystemCount()==1)
        `, 'original-client-global-bootstrap');
        headless.session.dispatch('OnCreatePlayer', 0);
        assert.equal(headless.session.openWorldContextMenu({ screenX: 320, screenY: 320, worldX: 5, worldY: 5 }), true);
        activate(headless.session, headless.host, `
            assert(getPlayerInventory(0).inventoryPane==nil and getPlayerLoot(0).inventoryPane==nil)
        `, 'original-early-headless-pages');
        headless.session.dispatch('OnGameStart');
        const startupTypes = ['Base.Gloves_BoxingRed', 'Base.Shoes_ArmyBoots', 'Base.Shoes_WorkBoots'];
        const startupDefinitions = parseItemDefinitions(
            await content.getFile('media/scripts/generated/items/clothing.txt').text(),
            { path: 'media/scripts/generated/items/clothing.txt' },
        ).filter(({ fullType }) => startupTypes.includes(fullType));

        assert.equal(startupDefinitions.length, startupTypes.length);

        for (const entry of startupDefinitions) {
            headless.engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, ...entry }, { owner: 'fixture' });

            for (let index = 0; index < (entry.fullType === startupTypes[0] ? 55 : 2); index += 1) {
                headless.host.api.items.spawn({ fullType: entry.fullType, x: 5, y: 5 });
            }
        }

        headless.session.initializeInventoryPages();
        headless.session.dispatch('OnKeyPressed', 23);
        activate(headless.session, headless.host, `
            assert(not getPlayerInventory(0):getIsVisible() and not getPlayerLoot(0):getIsVisible(),
                'headless startup must not prematurely install unrelated global UI key handlers')
            assert(getPlayerLoot(0).inventoryPane.inventory:getItems():size()==59,
                'resident activation must populate the retained all-clothing workload under the unchanged VM timeout')
            local pane=getPlayerLoot(0).inventoryPane
            local nativeItems=pane.inventory:getItems()
            ISMouseDrag.dragging={}
            for i=nativeItems:size()-1,0,-1 do
                table.insert(ISMouseDrag.dragging,nativeItems:get(i))
            end
            pane.draggedItems:reset()
            pane.draggedItems:update()
            local sorted=pane.draggedItems.items
            assert(#sorted==59,'unchanged drag update must sort every actual native item')
            for i=2,#sorted do
                local previous,current=sorted[i-1],sorted[i]
                assert(previous:getUnequippedWeight()<=current:getUnequippedWeight(),
                    'unchanged inventory drag must order name groups by weight')
                if previous:getDisplayName()==current:getDisplayName() then
                    assert(nativeItems:indexOf(previous)<nativeItems:indexOf(current),
                        'unchanged inventory comparator must restore native container order')
                end
            end
            ISMouseDrag.dragging=nil
            pane.draggedItems:reset()
        `, 'original-early-headless-hidden');
        headless.session.dispatch('OnKeyPressed', 23);
        activate(headless.session, headless.host, `
            assert(getPlayerInventory(0):getIsVisible() and getPlayerLoot(0):getIsVisible())
        `, 'original-early-headless-shown');
        assert.deepEqual(headless.session.diagnostics().errors, []);
    } finally {
        headless.session.close({ discardSaveData: true });
        headless.host.dispose();
        headlessUI.dispose();
        headlessFiles.dispose();
    }

    const originalFiles = privateFiles();
    const candidateFiles = privateFiles();

    originalFiles.write('entityLayout.ini', 'player:0\r\nwindowKey:BuildWindow\r\nx=12\r\ny=34\r\nwidth=320\r\nheight=200\r\nlocked=false\r\n');
    const original = await fixture({ ...options, ui: originalUI, sourceFiles: originalFiles });
    const candidate = await fixture({ ...options, ui: candidateUI, sourceFiles: candidateFiles });

    try {
        for (const value of [original, candidate]) {
            importPickupSquares(value.engine);
            value.engine.registerItemDefinition(definition, { owner: 'fixture' });
            value.host.api.items.spawn({ fullType: definition.fullType, x: 5, y: 5 });
            value.session.preload({ id: 'engine-lua', nativeId: 'ProjectZomboid', engineSource: true, sources });
            value.session.activatePackage({
                id: 'pz-base-game', nativeId: 'ProjectZomboid', api: value.host.coreApi,
                sources: [{
                    path: 'media/lua/client/pz-base-game/bootstrap.lua',
                    source: 'require "TimedActions/ISTimedActionQueue"; require "TimedActions/ISGrabItemAction"',
                }],
            });
        }

        original.session.dispatch('OnCreatePlayer', 0);
        original.session.dispatch('OnGameStart');
        original.session.initializeInventoryPages();
        await loadSource(original.session, original.host, `
            assert(ISToolTipInv and ISToolTipInv.Type=='ISToolTipInv',
                'inventory activation must load the original hover tooltip before any world context menu')
            local tip=ISToolTipInv:new(nil)
            assert(type(tip.tooltip)=='userdata')
            assert(tip.tooltip:getX()==0 and tip.tooltip:getY()==0)
            assert(tip.tooltip:getWidth()==130 and tip.tooltip:getHeight()==130)
            assert(tip.tooltip.padLeft==5 and tip.tooltip.padRight==5 and tip.tooltip.padTop==5 and tip.tooltip.padBottom==5)
            assert(tip.tooltip:getFont()=='Small' and tip.tooltip:getLineSpacing()==getTextManager():getFontHeight(UIFont.Small))
            assert(tip.tooltip:getCharacter()==nil and not tip.tooltip:isMeasureOnly())
            assert(tip.tooltip:getWeightOfStack()==0)
            tip:setCharacter(getPlayer())
            tip.tooltip:setMeasureOnly(true)
            tip.tooltip:setWeightOfStack(0.1)
            assert(tip.tooltip:getCharacter()==getPlayer() and tip.tooltip:isMeasureOnly())
            assert(tip.tooltip:getWeightOfStack()==(string.unpack('f',string.pack('f',0.1))))
            local pane=getPlayerLoot(0).inventoryPane
            local entry=assert(pane.inventory:getItems():get(0))
            local dragItems={entry}
            pane:sortItemsByTypeAndWeight(dragItems)
            assert(#dragItems==1 and dragItems[1]==entry,
                'unchanged drag sorting must group native items by their stored display name')
            local world=assert(entry:getWorldItem())
            assert(world:getChunk()==world:getSquare():getChunk())
            assert(pane:doWorldObjectHighlight(entry) and world:isHighlighted(0),
                'the unchanged drag highlight consumer must use the native loaded chunk')
            local tint=world:getHighlightColor(0)
            assert(tint:getR()==0.5 and tint:getG()==1 and tint:getB()==1 and tint:getA()==1
                and world:isOutlineHighlight(0) and world:getOutlineHighlightCol(0)==-129,
                'the original world-item override applies its cyan tint and outline before publication')
            pane:clearWorldObjectHighlights()
            assert(not world:isHighlighted(0))
            tip:initialise()
            tip:instantiate()
            tip:setItem(entry)
            tip:render()
            assert(tip:getWidth()>=150 and tip:getHeight()>tip.tooltip:getLineSpacing(),
                'unchanged ISToolTipInv must finish both native measure-only and draw passes')
            assert(not tip.tooltip:isMeasureOnly())
        `, 'original-inventory-hover-construction-and-drag-highlight');
        original.engine.registerItemDefinition({
            ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.OutlineBag', type: 'Container', weight: 1,
            isBag: true, capacity: 20, weightReduction: 50, maxItemSize: 10,
            rawFields: [{ name: 'Icon', value: 'Paperclip' }],
        }, { owner: 'fixture' });
        const outlineBag = original.host.api.items.spawn({ fullType: 'Fixture.OutlineBag', x: 5, y: 5 }).snapshot.id;

        await loadSource(original.session, original.host, `
            local core=getCore()
            assert(core:getOptionDoContainerOutline()==true,'the original Core outline default is enabled')
            local color=core:getObjectHighlitedColor()
            assert(math.abs(color:getR()-0.98)<0.000001 and math.abs(color:getG()-0.56)<0.000001
                and math.abs(color:getB()-0.11)<0.000001,'Core must expose the genuine object highlight default')
            core:setObjectHighlitedColor(ColorInfo.new(0.25,0.5,0.75,1))
            local worldColor=core:getWorldItemHighlightColor()
            assert(worldColor:getR()==0.5 and worldColor:getG()==1 and worldColor:getB()==1,
                'world-item hover tint is independent of the selected object option')
            local page=getPlayerLoot(0)
            page:refreshBackpacks()
            for _,button in ipairs(page.backpacks) do
                local item=button.inventory:getContainingItem()
                if item and item:getID()==${outlineBag} then OutlineBagButton=button end
                if button.inventory:getType()=='floor' then OutlineFloorButton=button end
            end
            assert(OutlineBagButton and OutlineFloorButton,'the unchanged page must discover the actual ground bag')
            local bag=OutlineBagButton.inventory:getContainingItem()
            OutlineBagWorld=assert(bag:getWorldItem())
            local inventoryName=bag.getName
            bag.getName=function() return 'Campfire' end
            assert(OutlineBagWorld:getName()==nil and not CCampfireSystem.instance:isValidIsoObject(OutlineBagWorld),
                'an item display name must not become the independent native IsoObject name used by the original campfire predicate')
            bag.getName=inventoryName
            assert(bag:getClothingItem()==nil and bag:getVisual()==nil,
                'the original no-ClothingItem asset branch must stay nil rather than invent an ItemVisual')
            assert(not OutlineBagWorld:isPropaneBBQ() and not OutlineBagWorld:isFireInteractionObject(),
                'a real world bag is neither an IsoBarbecue nor an IsoFireplace')
            assert(page:getContainerParent(OutlineBagButton.inventory)==OutlineBagWorld)
            OutlineBagButton.inventory:setExplored(true)
            page:selectContainer(OutlineBagButton)
            page:setPinned()
            assert(page.isCollapsed,'the original pin operation must not bypass the next update expansion phase')
            ISMouseDrag.dragging={bag}
        `, 'original-container-outline-selected');
        originalUI.update();
        await loadSource(original.session, original.host, `
            local page=getPlayerLoot(0)
            assert(page.pin and not page.isCollapsed,
                'the first unchanged update expands the pinned page after its highlight phase')
            assert(not OutlineBagWorld:isHighlighted(0) and not OutlineBagWorld:isOutlineHighlight(0),
                'a page that was collapsed at update entry must not acquire the selected-container highlight early')
        `, 'original-container-outline-expands');
        assert.ok(originalUI.render().length > 0);
        originalUI.update();
        originalUI.render();
        await loadSource(original.session, original.host, `
            assert(ISMouseDrag.dragging~=nil,'the real page frame must tolerate resident drag state')
            assert(OutlineBagWorld:isHighlighted(0) and OutlineBagWorld:isOutlineHighlight(0),
                'the unchanged selected-container update must highlight and outline its actual world bag')
            local color=OutlineBagWorld:getHighlightColor(0)
            assert(color:getR()==0.25 and color:getG()==0.5 and color:getB()==0.75)
            assert(OutlineBagWorld:getOutlineHighlightCol(0)==-4227265,
                'original outline colors truncate f32 components into signed packed ABGR 0xFFBF7F3F')
            getPlayerLoot(0):selectContainer(OutlineFloorButton)
        `, 'original-container-outline-enabled');
        originalUI.update();
        originalUI.render();
        await loadSource(original.session, original.host, `
            assert(not OutlineBagWorld:isHighlighted(0) and not OutlineBagWorld:isOutlineHighlight(0),
                'selecting the real floor container must clear the previous bag outline')
            local page=getPlayerLoot(0)
            page:onMouseOverButton(OutlineBagButton,0,0)
            assert(OutlineBagWorld:isOutlineHighlight(0) and OutlineBagWorld:getOutlineHighlightCol(0)==-129,
                'unchanged unselected-button hover must apply the separate world-item color')
            page:onMouseOutButton(OutlineBagButton,0,0)
            assert(not OutlineBagWorld:isOutlineHighlight(0))
            getCore():setOptionDoContainerOutline(false)
            getCore():saveOptions()
            assert(not getCore():getOptionDoContainerOutline())
            getPlayerLoot(0):selectContainer(OutlineBagButton)
        `, 'original-container-outline-disabled');
        originalUI.update();
        originalUI.render();
        await loadSource(original.session, original.host, `
            assert(OutlineBagWorld:isHighlighted(0) and OutlineBagWorld:isOutlineHighlight(0),
                'the world-item subclass still enables its outline when the generic container option is disabled')
            assert(OutlineBagWorld:getOutlineHighlightCol(0)==-129,
                'without the generic outline override the world-item outline keeps its own color')
            ISMouseDrag.dragging=nil
            local page=getPlayerLoot(0)
            page:collapse()
            page:collapseNow()
        `, 'original-container-outline-collapse');
        originalUI.update();
        originalUI.render();
        await loadSource(original.session, original.host, `
            assert(not OutlineBagWorld:isHighlighted(0) and not OutlineBagWorld:isOutlineHighlight(0),
                'a genuine collapsed page must clear the selected world container')
            getPlayerLoot(0):selectContainer(OutlineFloorButton)
            getPlayerLoot(0):setPinned()
        `, 'original-container-outline-cleared');
        const reloadedUI = createGameUI({ storage: coreStorage });

        reloadedUI.setViewport(640, 640);
        reloadedUI.initialize({ ...resources, textures });
        const reloadedCore = await fixture({ ui: reloadedUI });

        try {
            activate(reloadedCore.session, reloadedCore.host, `
                local core=getCore()
                assert(not core:getOptionDoContainerOutline(),'saveOptions must survive a fresh UI and native session')
                local color=core:getObjectHighlitedColor()
                assert(color:getR()==0.25 and color:getG()==0.5 and color:getB()==0.75)
            `, 'original-core-options-reloaded');
            assert.deepEqual(reloadedCore.session.diagnostics().errors, []);
        } finally {
            reloadedCore.session.close({ discardSaveData: true });
            reloadedCore.host.dispose();
            reloadedUI.dispose();
        }

        await loadSource(original.session, original.host, `
            InventoryPagesBeforeFirstSave={getPlayerInventory(0),getPlayerLoot(0)}
            assert(InventoryPagesBeforeFirstSave[1].inventoryPane and InventoryPagesBeforeFirstSave[2].inventoryPane)
            InventoryPagesBeforeFirstSave[1]:setX(17)
            InventoryPagesBeforeFirstSave[1]:setY(19)
            InventoryPagesBeforeFirstSave[2]:setVisible(false)
        `, 'original-inventory-before-first-save');
        original.session.dispatch('OnPostSave');
        await loadSource(original.session, original.host, `
            assert(getPlayerInventory(0)==nil and getPlayerLoot(0)==nil,'genuine post-save teardown must complete before any world menu was opened')
            assert(ISEntityUI and not ISEntityUI.IsWindowOpen(0,'BuildWindow'),
                'the genuine entity registry must distinguish saved window preferences from an open instance')
            local entityPlayers=ISEntityUI.players
            local preferences=entityPlayers[0].windows.BuildWindow
            assert(preferences.x==12 and preferences.y==34 and preferences.width==320 and preferences.height==200)
            assert(ISEntityUI.GetWindowInstance(0,'BuildWindow')==nil and ISEntityUI.players==entityPlayers,
                'the original no-open-window query must preserve its resident Lua registry')
        `, 'original-inventory-first-save-teardown');
        await original.session.flushSourceFiles();
        assert.match(originalFiles.read('layout.ini'), /\[640x640\]/u);
        assert.match(originalFiles.read('layout.ini'), /^inventory0 [^\r\n]*\bvisible=true\b/mu);
        assert.match(originalFiles.read('layout.ini'), /^loot0 [^\r\n]*\bvisible=false\b/mu);
        assert.match(originalFiles.read('entityLayout.ini'), /^windowKey:BuildWindow\r?$/mu);
        assert.match(originalFiles.read('entityLayout.ini'), /^x=12\r?$/mu);
        original.session.initializeInventoryPages();
        await loadSource(original.session, original.host, `
            assert(getPlayerInventory(0)~=InventoryPagesBeforeFirstSave[1] and getPlayerLoot(0)~=InventoryPagesBeforeFirstSave[2])
            assert(getPlayerInventory(0):getUIName()=='inventory0' and getPlayerLoot(0):getUIName()=='loot0')
            assert(getPlayerInventory(0):getX()==17 and getPlayerInventory(0):getY()==19,
                'keyboard-only inventory must save and restore its genuine window layout')
            assert(getPlayerInventory(0):getIsVisible() and not getPlayerLoot(0):getIsVisible(),
                'genuine layout saving must preserve actual per-window visibility rather than global defaults')
        `, 'original-inventory-first-save-recreate');
        originalUI.update();
        assert.ok(originalUI.render().length > 0, 'genuine post-save replacement pages must execute their original frame callbacks');
        assert.deepEqual(original.session.diagnostics().errors, []);
        assert.equal(original.session.openWorldContextMenu({ screenX: 320, screenY: 320, worldX: 5, worldY: 5 }), true);

        await loadSource(original.session, original.host, `
            local item=getPlayer():getSquare():getWorldObjects():get(0)
            ISTimedActionQueue.add(ISGrabItemAction:new(getPlayer(),item,40))
        `, 'original-grab-owner');
        original.host.frameStep(1 / 60);
        original.engine.sourceActions.dispatch(original.session.dispatchSourceAction);
        const before = original.engine.actions.getState();
        const bytes = original.engine.saveQueueState();
        const owners = original.session.exportSourceOwners();

        candidate.engine.loadQueueState(bytes);
        const restored = candidate.engine.actions.getState();

        assert.equal(restored.current.currentTime, before.current.currentTime);
        assert.equal(restored.current.id, before.current.id);
        assert.deepEqual(restored.current.groups, before.current.groups);
        candidate.session.preload({ id: 'original-grab-owner', nativeId: 'original-grab-owner', sources: [] });
        candidate.session.restoreSourceActions(restored, owners, [
            { id: 'pz-base-game', nativeId: 'ProjectZomboid' },
            { id: 'original-grab-owner', nativeId: 'original-grab-owner' },
        ]);
        assert.deepEqual(candidate.engine.actions.getState(), restored);
        await loadPackage(candidate.session, candidate.host, { id: 'original-grab-owner', nativeId: 'original-grab-owner', sources: [] });
        candidate.session.dispatch('OnLoad');
        candidate.session.dispatch('OnCreatePlayer', 0);
        candidate.session.dispatch('OnGameStart');
        candidate.session.completeSourceRestore();
        assert.deepEqual(candidate.engine.actions.getState(), restored, 'bootstrap must not tick, clear or rebuild saved native rows');
        activate(candidate.session, candidate.host, `
            RetainedPickupWorld=assert(ISTimedActionQueue.getTimedActionQueue(getPlayer()).queue[1].item)
            assert(RetainedPickupWorld:getChunk()==RetainedPickupWorld:getSquare():getChunk())
        `, 'original-resident-chunk-before-pickup');
        completeLuaActions(candidate.engine, candidate.host, candidate.session);
        assert.equal(candidate.host.api.items.get(1).ownerContainerId, candidate.host.api.items.playerInventoryId(), 'restored original perform must complete before any first context-menu bootstrap');
        activate(candidate.session, candidate.host, `
            assert(RetainedPickupWorld:getSquare()==nil and RetainedPickupWorld:getChunk()==nil,
                'completed original pickup must detach its retained world object from the native chunk')
        `, 'original-detached-chunk-after-pickup');
        await loadSource(candidate.session, candidate.host, `
            local rows={}
            for index=1,64 do rows[index]={name='Same original inventory name',id=index} end
            assert(table.sort(rows,function(a,b) return not string.sort(a.name,b.name) end)==rows)
            for index=1,63 do assert(rows[index].id==index+1,'original duplicate partition order must retain item identities') end
            assert(rows[64].id==1)
            local numbers={3,1,2,1}
            assert(table.sort(numbers,false)==numbers and table.concat(numbers,',')=='1,1,2,3')
            local empty,one={},{1}
            assert(table.sort(empty,42)==empty and table.sort(one,42)==one,'unused comparators are not invoked')
            local broken={3,1,2}
            local ok,err=pcall(table.sort,broken,function() error('original sort consumer fault') end)
            assert(not ok and tostring(err):find('original sort consumer fault',1,true))
            assert(broken[1]==2 and broken[2]==1 and broken[3]==3,'source sort errors retain prior in-place pivot mutation')
            local queue=ISTimedActionQueue.getTimedActionQueue(getPlayer()).queue
            for _ in ipairs(queue) do error('completed original queue must be empty') end
            for _ in pairs(queue) do error('completed original queue must be empty') end
        `, 'original-stdlib-sort-consumer');
        candidate.host.api.items.spawn({ fullType: definition.fullType, x: 5, y: 5 });
        assert.equal(candidate.session.openWorldContextMenu({ screenX: 320, screenY: 320, worldX: 5, worldY: 5 }), true);
        await loadSource(candidate.session, candidate.host, `
            local data=getPlayerData(0)
            assert(data and data.id==0 and getmetatable(data)==ISPlayerDataObject)
            assert(getmetatable(data.playerInventory)==ISInventoryPage)
            assert(getmetatable(data.lootInventory)==ISInventoryPage)
            assert(getPlayerContextMenu(0)==data.contextMenu and getmetatable(data.contextMenu)==ISContextMenu)
            InventoryHeadlessPages={data.playerInventory,data.lootInventory}
            assert(InventoryHeadlessPages[1].inventoryPane==nil and InventoryHeadlessPages[2].inventoryPane==nil)
        `, 'original-restored-ui-consumer');
        candidate.session.initializeInventoryPages();
        candidate.session.initializeInventoryPages();
        await loadSource(candidate.session, candidate.host, `
            local data=getPlayerData(0)
            assert(getPlayerInventory(0)==data.playerInventory and getPlayerLoot(0)==data.lootInventory)
            assert(data.playerInventory==InventoryHeadlessPages[1] and data.lootInventory==InventoryHeadlessPages[2],
                'resident activation must preserve the same genuine headless page objects')
            assert(data.playerInventory:getUIName()=='inventory0' and data.lootInventory:getUIName()=='loot0')
            assert(getmetatable(data.playerInventory.inventoryPane)==ISInventoryPane)
            local controls=data.lootInventory.controlsUI
            local floorHandler=assert(controls.handlers[ISLootWindowFloorControlHandler_TakeSameType])
            assert(floorHandler:shouldBeVisible(),'real inventory and ground items must exercise the original floor control')
            local button=assert(floorHandler.control,'the original page must construct its visible handler button')
            assert(getmetatable(button)==ISButton and button.image==getTexture('${floorImagePath}'))
            assert(button.image:getWidth()==${floorImage.width} and button.image:getHeight()==${floorImage.height},
                'the genuine helper image must retain the privately provisioned PNG dimensions')
            assert(button:getWidth()==${floorImage.width / floorImage.height * resources.fontLineHeight.Small + 4}
                and button:getHeight()==${resources.fontLineHeight.Small + 4},'the original control must size itself from the real image and font')
            assert(getmetatable(data.lootInventory.inventoryPane)==ISInventoryPane)
            assert(ISResizableButton.minimumWidth==4,'original class-side nil title measurement must remain zero')
            assert(data.playerInventory.inventoryPane.nameHeader.title==getText('IGUI_invpanel_Type'))
            assert(data.playerInventory.controller==-1 and data.lootInventory.controller==-1)
            assert(data.playerInventory:getIsVisible() and data.lootInventory:getIsVisible())
            InventoryPagesBeforeToggle={data.playerInventory,data.lootInventory}
            local pane=data.playerInventory.inventoryPane
            local item=assert(pane.inventory:getItems():get(0))
            assert(not item:IsLiterature())
            assert(not item:hasBeenSeen(getPlayer()) and not item:hasBeenHeard(getPlayer()))
            assert(not getPlayer():hasReadMap(item))
            assert(not item:isNoRecipes(getPlayer()))
            assert(not item:isFavouriteRecipeInput(getPlayer()))
            assert(not instanceof(item,'DrainableComboItem'))
            assert(not pane:isLiteratureRead(getPlayer(),item),
                'the unchanged original pane must reject non-Literature before reading unavailable Literature state')
            local category=item:getDisplayCategory()
            item:setDisplayCategory('Native category changed')
            pane:refreshContainer()
            local found=false
            for _,row in ipairs(pane.itemslist) do
                if row.items[1]==item then assert(row.cat=='Native category changed');found=true end
            end
            assert(found,'original pane must consume the current native display category')
            item:setDisplayCategory(category)
            pane:refreshContainer()
            assert(not getCore():isSelectingAll() and not getPlayer():isInvPageDirty())
            getPlayer():getInventory():setDrawDirty(false)
            getPlayer():setInvPageDirty(true)
            assert(getPlayer():isInvPageDirty() and not getPlayer():getInventory():isDrawDirty(),
                'player page invalidation is independent from container draw dirtiness')
            getCore():setIsSelectingAll(true)
            assert(getCore():isSelectingAll())
        `, 'original-inventory-pages');
        candidateUI.update();
        assert.ok(candidateUI.render().length > 0, 'the actual original registered pages must execute update and draw callbacks');
        await loadSource(candidate.session, candidate.host, `
            assert(not getCore():isSelectingAll(),'the original pane update must clear select-all when Ctrl is not held')
            assert(not getPlayer():isInvPageDirty(),'the original page prerender must consume the player dirty flag')
        `, 'original-inventory-frame');
        await loadSource(candidate.session, candidate.host, `
            assert(getPlayerInventory(0):getAbsoluteX()<200 and getPlayerInventory(0):getAbsoluteX()+getPlayerInventory(0):getWidth()>200)
            assert(getPlayerInventory(0):getAbsoluteY()==0)
            assert(not pcall(function() isMouseButtonDown(-1) end))
            assert(not pcall(function() isMouseButtonDown(8) end))
            assert(not pcall(function() isMouseButtonDown(0.5) end))
            assert(not pcall(function() isMouseButtonDown('0') end))
        `, 'original-inventory-hover-input');

        for (const index of [0, 1, 2]) {
            physicalMouseButtons = 1 << index;
            candidateUI.input('onMouseMove', 200, 2, 0, 0);
            activate(candidate.session, candidate.host, `
                assert(getPlayerInventory(0).isCollapsed,'a held original mouse button must prevent title-bar hover expansion')
            `, `original-inventory-hover-held-${index}`);
        }

        physicalMouseButtons = 1 << 7;
        candidateUI.input('onMouseMove', 200, 2, 0, 0);
        await loadSource(candidate.session, candidate.host, `
            assert(isMouseButtonDown(7),'the native highest button reads its own physical bit')
            assert(not getPlayerInventory(0).isCollapsed,'the original hover guard checks only its three primary mouse buttons')
        `, 'original-inventory-hover-other-button');
        candidateUI.update();
        assert.ok(candidateUI.render().length > 0, 'the genuinely hover-expanded inventory must paint its real original item rows');
        await loadSource(candidate.session, candidate.host, `
            getPlayerInventory(0).isCollapsed=true
            getPlayerInventory(0):setMaxDrawHeight(15)
        `, 'original-inventory-hover-other-button-collapse');
        physicalMouseButtons = 0;
        candidateUI.input('onMouseMove', 200, 2, 0, 0);
        await loadSource(candidate.session, candidate.host, `
            assert(not getPlayerInventory(0).isCollapsed,'releasing the held buttons must permit genuine title-bar expansion')
        `, 'original-inventory-hover-released');
        candidateUI.update();
        assert.ok(candidateUI.render().length > 0, 'the released-pointer expansion must paint before the fixture collapses it');
        await loadSource(candidate.session, candidate.host, `
            assert(UIManager.isMouseOverInventory(),'the genuine expanded page must own the inventory hover region')
        `, 'original-inventory-world-input-region');
        physicalKeys.add(29);
        candidate.session.updateActorInput();
        assert.equal(candidate.engine.sourceActions.actorIsAiming(0), false, 'alternate Ctrl aim is suppressed over the genuine expanded inventory');
        physicalKeys.add(30);
        candidate.session.updateActorInput();
        assert.equal(candidate.engine.sourceActions.actorIsAiming(0), true, 'a held ordinary primary wins over the Ctrl alternate and is not inventory-suppressed');
        physicalKeys.clear();
        candidate.session.updateActorInput();
        await loadSource(candidate.session, candidate.host, `
            getPlayerInventory(0).isCollapsed=true
            getPlayerInventory(0):setMaxDrawHeight(15)
        `, 'original-inventory-hover-released-collapse');
        physicalKeys.add(30);
        candidate.session.updateActorInput();
        await loadSource(candidate.session, candidate.host, `
            InventoryHeaderDragOrigin={getPlayerInventory(0):getX(),getPlayerInventory(0):getY()}
            getPlayer():setForceAim(true)
            assert(getPlayer():isAiming() and getPlayer():isForceAim())
        `, 'original-inventory-header-before-drag');
        physicalMouseButtons = 1;
        candidateUI.input('onMouseDown', 200, 2);
        const clearedAim = candidate.engine.sourceActions.actorInputState(0);

        assert.equal(clearedAim.forceAim, false);
        assert.equal(clearedAim.rawAiming, false);
        assert.equal(clearedAim.charging, false);
        assert.equal(clearedAim.cachedAiming, true, 'original header nullification must preserve cached held input');
        assert.equal(clearedAim.aimDown, true);
        candidateUI.input('onMouseMove', 212, 11, 12, 9);
        physicalMouseButtons = 0;
        candidateUI.input('onMouseUp', 212, 11);
        await loadSource(candidate.session, candidate.host, `
            local page=getPlayerInventory(0)
            assert(page:getX()==InventoryHeaderDragOrigin[1]+12 and page:getY()==InventoryHeaderDragOrigin[2]+9,
                'the genuine captured header must move by the actual pointer deltas')
            assert(not page.moving and not page:isCapture(),'genuine mouse-up must release the header capture')
        `, 'original-inventory-header-after-drag');
        candidate.session.updateActorInput();
        assert.equal(candidate.engine.sourceActions.actorIsAiming(0), true, 'the still-held real key must reassert after the genuine header clears current aim');
        physicalKeys.clear();
        candidate.session.updateActorInput();
        joypadBinding = 0;
        await loadSource(candidate.session, candidate.host, `
            assert(not pcall(function() getJoypadData(0) end),'an assigned controller needs a real supported registry, not fabricated absence')
        `, 'original-inventory-assigned-controller');
        joypadBinding = -1;
        await loadSource(candidate.session, candidate.host, `
            getPlayerContextMenu(0):hideAndChildren()
            local inventory,loot=getPlayerInventory(0),getPlayerLoot(0)
            inventory:setX(0);inventory:setY(0);inventory:setPinned()
            loot:setX(0);loot:setY(300);loot:setPinned()
        `, 'original-drag-window-layout');
        candidateUI.setMouse(630, 630);
        candidateUI.update();
        assert.ok(candidateUI.render().length > 0);
        physicalMouseButtons = 1;
        await loadSource(candidate.session, candidate.host, `
            local pane=getPlayerInventory(0).inventoryPane
            pane.mouseOverOption=1
            pane:onMouseDown(pane.column2+8,pane.headerHgt+pane.itemHgt/2)
            pane:onMouseMoveOutside(10,10)
            assert(ISMouseDrag.draggingFocus==pane and pane.dragStarted and #ISMouseDrag.dragging==1,
                'the unchanged mouse handlers must create genuine native-item drag state')
            pane.draggedItems:update()
            local container,what=pane.draggedItems:getDropContainer()
            assert(container==ISInventoryPage.GetFloorContainer(0) and what=='floor')
            assert(not pane.draggedItems:cannotDropAnyItem())
            DragStackBlocker=ISPanel:new(600,600,40,40)
            DragStackBlocker:initialise()
            DragStackBlocker:addToUIManager()
            DragStackBlocker:setUIName('actual drag blocker')
            local stack=UIManager.getUI()
            assert(stack:contains(DragStackBlocker.javaObject))
            assert(DragStackBlocker.javaObject:getTable()==DragStackBlocker)
            pane.draggedItems:update()
            assert(pane.draggedItems:getDropContainer()==nil,
                'a genuinely registered source root must block dropping through the UI')
            DragStackBlocker:setVisible(false)
            assert(stack:contains(DragStackBlocker.javaObject),'hidden roots remain in the native stack')
            pane.draggedItems:update()
            container,what=pane.draggedItems:getDropContainer()
            assert(container==ISInventoryPage.GetFloorContainer(0) and what=='floor',
                'invisible source roots must not block floor drops')
            DragStackBlocker:removeFromUIManager()
            assert(not stack:contains(DragStackBlocker.javaObject))
            DragStackBlocker=nil
            pane:update()
        `, 'original-drag-live-stack-and-drop-container');
        assert.ok(candidateUI.render().some((command) => command.type === 'stencil' && command.operation === 'suspend'),
            'the original renderdetails(true) must draw selected dragged rows outside their stencil');
        physicalMouseButtons = 0;
        candidateUI.update();
        await loadSource(candidate.session, candidate.host, `
            assert(ISMouseDrag.dragging==nil and ISMouseDrag.draggingFocus==nil,
                'the original released-outside update must consume the drag')
            assert(#ISTimedActionQueue.getTimedActionQueue(getPlayer()).queue>0,
                'the unchanged drop path must admit a real original transfer action')
        `, 'original-drag-floor-drop-admitted');
        completeLuaActions(candidate.engine, candidate.host, candidate.session);
        assert.notEqual(candidate.host.api.items.get(1).ownerContainerId, candidate.host.api.items.playerInventoryId(),
            'the original floor drop must commit native item ownership, not just clear the UI drag');
        assert.ok(candidate.host.api.items.get(1).worldPosition, 'the completed drop must create the actual native ground placement');
        await loadSource(candidate.session, candidate.host, `
            local pane=getPlayerLoot(0).inventoryPane
            pane:prerender()
            pane.mouseOverOption=1
            pane:onMouseDown(pane.column2+8,pane.headerHgt+pane.itemHgt/2)
            pane:onMouseMoveOutside(10,10)
            assert(ISMouseDrag.draggingFocus==pane and pane.dragStarted)
        `, 'original-drag-ground-pickup-start');
        physicalMouseButtons = 1;
        candidateUI.setMouse(80, 80);
        await loadSource(candidate.session, candidate.host, `
            local pane=getPlayerLoot(0).inventoryPane
            pane.draggedItems:update()
            local container,what=pane.draggedItems:getDropContainer()
            assert(container==getPlayer():getInventory() and what=='inventory',
                'the unchanged destination hit test must resolve the actual player inventory pane')
            assert(not pane.draggedItems:cannotDropAnyItem())
            pane:update()
            pane:render()
        `, 'original-drag-ground-to-native-inventory');
        physicalMouseButtons = 0;
        assert.equal(candidateUI.input('onMouseUp', 80, 80), true,
            'the genuine registered inventory pane must receive the release');
        candidateUI.update();
        completeLuaActions(candidate.engine, candidate.host, candidate.session);
        assert.equal(candidate.host.api.items.get(1).ownerContainerId, candidate.host.api.items.playerInventoryId(),
            'the original inventory release must restore real native ownership');
        await loadSource(candidate.session, candidate.host, `
            assert(ISMouseDrag.dragging==nil and ISMouseDrag.draggingFocus==nil)
            assert(getPlayerInventory(0).inventoryPane.dragging==nil and getPlayerLoot(0).inventoryPane.dragging==nil)
        `, 'original-drag-complete');
        candidate.session.dispatch('OnKeyPressed', 23);
        await loadSource(candidate.session, candidate.host, `
            assert(not getPlayerInventory(0):getIsVisible() and not getPlayerLoot(0):getIsVisible())
            assert(getPlayerInventory(0)==InventoryPagesBeforeToggle[1] and getPlayerLoot(0)==InventoryPagesBeforeToggle[2])
        `, 'original-inventory-hidden');
        candidate.session.dispatch('OnKeyPressed', 23);
        await loadSource(candidate.session, candidate.host, `
            SourceMenuShape=0
            Events.OnFillWorldObjectContextMenu.Add(function(playerIndex,context,objects,test)
                assert(playerIndex==0 and not test)
                context:clear()
                if SourceMenuShape==0 then return end
                local empty=context:addOption("Empty branch",nil,nil)
                context:addSubMenu(empty,ISContextMenu:getNew(context))
                local nested=context:addOption("Ordered branch",nil,nil)
                local children=ISContextMenu:getNew(context)
                context:addSubMenu(nested,children)
                local function selected(_,value) getModData().MirrorPicked=value end
                children:addOption("First",nil,selected,1)
                children:addOption("Second",nil,selected,2)
            end)
        `, 'source-menu-shapes');
        assert.equal(candidate.session.openWorldContextMenu({ screenX: 320, screenY: 320, worldX: 5, worldY: 5 }), true);
        assert.equal(candidateDOM.document.body.children.some((node) => Object.hasOwn(node.dataset, 'sourceContextMenu')), false,
            'an original menu cleared by a real source fill consumer must clear its semantic mirror');
        await loadSource(candidate.session, candidate.host, 'SourceMenuShape=1', 'source-menu-populate');
        assert.equal(candidate.session.openWorldContextMenu({ screenX: 320, screenY: 320, worldX: 5, worldY: 5 }), true);
        const mirrored = candidateDOM.document.body.children.find((node) => Object.hasOwn(node.dataset, 'sourceContextMenu'));

        assert.ok(mirrored);
        assert.deepEqual(mirrored.children.map((row) => row.children[0].getAttribute('aria-label')), ['Empty branch', 'Ordered branch']);
        assert.equal(mirrored.children[0].children.length, 1, 'an empty original submenu must not export a Lua object as a child array');
        const ordered = mirrored.children[1].children[1];

        assert.deepEqual(ordered.children.map((row) => row.children[0].getAttribute('aria-label')), ['First', 'Second']);
        ordered.children[1].children[0].dispatchEvent(new Event('click', { cancelable: true }));
        await loadSource(candidate.session, candidate.host, 'assert(getModData().MirrorPicked==2)', 'source-menu-selected-index');
        await loadSource(candidate.session, candidate.host, `
            InventoryStackBeforeRemoval=UIManager.getUI()
            assert(InventoryStackBeforeRemoval:contains(InventoryPagesBeforeToggle[1].javaObject))
            assert(InventoryStackBeforeRemoval:contains(InventoryPagesBeforeToggle[2].javaObject))
            removeInventoryUI(0)
            assert(getPlayerInventory(0)==nil and getPlayerLoot(0)==nil)
            assert(not InventoryStackBeforeRemoval:contains(InventoryPagesBeforeToggle[1].javaObject))
            assert(not InventoryStackBeforeRemoval:contains(InventoryPagesBeforeToggle[2].javaObject))
            assert(InventoryPagesBeforeToggle[1]:getUIName()=='inventory0')
        `, 'original-inventory-remove');
        candidate.session.initializeInventoryPages();
        await loadSource(candidate.session, candidate.host, `
            assert(getPlayerInventory(0)~=InventoryPagesBeforeToggle[1])
            assert(getPlayerLoot(0)~=InventoryPagesBeforeToggle[2])
            assert(getPlayerInventory(0):getUIName()=='inventory0')
            assert(getPlayerLoot(0):getUIName()=='loot0')
            assert(UIManager.getUI()==InventoryStackBeforeRemoval)
            assert(InventoryStackBeforeRemoval:contains(getPlayerInventory(0).javaObject))
            assert(InventoryStackBeforeRemoval:contains(getPlayerLoot(0).javaObject))
        `, 'original-inventory-recreate');
        assert.deepEqual(candidate.session.diagnostics().errors, []);
        assert.deepEqual(sourceFeedback, []);

        const timeouts = candidate.session.diagnostics().timeouts;

        assert.throws(() => activate(candidate.session, candidate.host, 'table.sort({2,1},function() while true do end end)', 'original-sort-budget'), /timeout/u);
        assert.equal(candidate.session.diagnostics().timeouts, timeouts + 1, 'genuine source sorting must retain the existing hostile-mod deadline');
    } finally {
        original.session.close({ discardSaveData: true });
        original.host.dispose();
        candidate.session.close({ discardSaveData: true });
        candidate.host.dispose();
        originalUI.dispose();
        candidateUI.dispose();
        originalFiles.dispose();
        candidateFiles.dispose();
    }
});

test('Lua square consumers use private source wall/reach predicates, nil endpoints and unknown refusal', async () => {
    const { engine, host, session, saved } = await fixture();
    const squares = [];

    for (let y = 3; y <= 7; y += 1) {
        for (let x = 3; x <= 7; x += 1) {
            squares.push({
                x, y, z: 0, roomId: -1, outside: true, solid: false, solidTrans: false,
                tree: false, independentWalls: 0, vehicleObstructed: false, solidFloor: true,
                interactionProperties: { collideN: false, collideW: x === 6 && y === 5 },
                reachWalls: { north: false, west: false },
            });
        }
    }

    try {
        engine.importDoors([], { squares });
        session.attachSourceActions(engine.sourceActions, engine.sourceTiming);
        await loadSource(session, host, `${SOURCE_GROUP_FIXTURE}
            local actor=getPlayer():getSquare()
            local east=getCell():getGridSquare(6,5,0)
            getModData().SourceRelations={wall=east:isWallTo(actor),reach=actor:canReachTo(east),
                nilWall=actor:isWallTo(nil),nilReach=actor:canReachTo(nil)}
            function QueueModelWalkAdjacent(square)
                if getPlayer():getSquare():canReachTo(square) then return true end
                local destination=AdjacentFreeTileFinder.Find(square,getPlayer(),nil)
                if not destination then return false end
                ISTimedActionQueue.add(ISWalkToTimedAction:new(getPlayer(),destination))
                return true
            end
            assert(QueueModelWalkAdjacent(east))
        `, 'source-relations');
        session.flushSaveData();
        const result = saved.get('source-relations').data.nativePlayerData.SourceRelations;

        assert.equal(result.wall, true);
        assert.equal(result.reach, false, 'source canReachTo ends with !isWallTo after its separate wall-object checks');
        assert.equal(result.nilWall, engine.sourceActions.isWallTo({ x: 5, y: 5, z: 0 }, null));
        assert.equal(result.nilReach, engine.sourceActions.canReachTo({ x: 5, y: 5, z: 0 }, null));
        assert.equal(engine.actions.getState().current.kind, 'walk');
        await loadSource(session, host, `table.wipe(ISTimedActionQueue.getTimedActionQueue(getPlayer()).queue)`, 'source-relation-clear');
        assert.deepEqual(engine.actions.getState(), { current: null, pending: [] });
        const east = squares.find((square) => square.x === 6 && square.y === 5);

        east.interactionProperties.windowW = true;
        engine.importDoors([], { squares });
        await loadSource(session, host, `
            local east=getCell():getGridSquare(6,5,0)
            assert(not east:isWallTo(getPlayer():getSquare()))
            assert(getPlayer():getSquare():canReachTo(east))
            assert(QueueModelWalkAdjacent(east))
        `, 'source-relation-window-exemption');
        assert.deepEqual(engine.actions.getState(), { current: null, pending: [] });
        east.interactionProperties.windowW = false;

        east.interactionProperties.collideW = false;
        east.reachWalls.west = true;
        engine.importDoors([], { squares });
        await loadSource(session, host, `
            local east=getCell():getGridSquare(6,5,0)
            assert(not east:isWallTo(getPlayer():getSquare()))
            assert(not getPlayer():getSquare():canReachTo(east))
            assert(QueueModelWalkAdjacent(east))
        `, 'source-relation-admission');
        assert.equal(engine.actions.getState().current.kind, 'walk');
        await loadSource(session, host, `table.wipe(ISTimedActionQueue.getTimedActionQueue(getPlayer()).queue)`, 'source-relation-wall-clear');
        assert.deepEqual(engine.actions.getState(), { current: null, pending: [] });

        for (const square of squares) {
            delete square.reachWalls;
        }

        engine.importDoors([], { squares });
        await assert.rejects(loadSource(session, host, `
            QueueModelWalkAdjacent(getCell():getGridSquare(6,5,0))
        `, 'source-relation-unknown'), /can_reach/u);
        assert.deepEqual(engine.actions.getState(), { current: null, pending: [] });
    } finally {
        session.close();
        host.dispose();
    }
});

test('highlight consumer recognizes the real player as not an IsoDeadBody without hiding unsupported classes', async () => {
    const { engine, host, session, saved } = await fixture();

    try {
        importPickupSquares(engine);
        engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.Highlight', weight: 0.1 }, { owner: 'fixture' });
        const id = host.api.items.spawn({ fullType: 'Fixture.Highlight', x: 5, y: 5 }).snapshot.id;

        engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.HighlightKey', type: 'Key', weight: 0.1 }, { owner: 'fixture' });
        assert.throws(() => host.api.items.spawn({ fullType: 'Fixture.HighlightKey', x: 5, y: 5 }),
            /unsupported original facility/u, 'unsupported Key instances must not enter the native graph');

        engine.importDoors([{
            id: 'door:5:5:0:0', x: 5, y: 5, z: 0, north: true,
            open: false, locked: false, lockedByKey: false, forceLocked: false,
            keyId: -1, roomId: -1, oppositeRoomId: -1, attachedE: false,
            attachedS: false, barricaded: false, independentWalls: 0,
            doubleDoor: 0, garageDoor: 0, interiorSide: false,
        }], {
            squares: [4, 5].map((y) => ({
                x: 5, y, z: 0, roomId: -1, outside: true, solid: false,
                solidTrans: false, tree: false, independentWalls: 0,
                vehicleObstructed: false, solidFloor: true,
                reachWalls: { north: false, west: false },
            })),
        });

        session.attachSourceActions(engine.sourceActions, engine.sourceTiming);
        activate(session, host, `${SOURCE_GROUP_FIXTURE}
            local nativeWorldColor=getCore():getWorldItemHighlightColor()
            assert(nativeWorldColor:getR()==0.5 and nativeWorldColor:getG()==1 and nativeWorldColor:getB()==1,
                'headless Core still owns the genuine constructor default')
            getModData().HighlightModel={calls=0,playerChecks=0}
            ISInventoryPage={}
            ISInventoryPage.__index=ISInventoryPage
            function ISInventoryPage:new(container,parent)
                return setmetatable({inventory=container,parent=parent,isCollapsed=false},self)
            end
            function ISInventoryPage:updateContainerHighlight()
                if self.parent and instanceof(self.parent,'IsoPlayer') then
                    assert(not instanceof(self.parent,'IsoDeadBody'))
                    getModData().HighlightModel.playerChecks=getModData().HighlightModel.playerChecks+1
                end
            end
            local playerPage=ISInventoryPage:new(getPlayer():getInventory(),getPlayer())
            local floor=ItemContainer.new('floor',nil,nil)
            local floorPage=ISInventoryPage:new(floor,floor:getParent())
            function ISInventoryPage.OnObjectHighlighted(index,value,enabled)
                assert(index==getPlayer():getPlayerNum())
                value:setHighlighted(index,enabled,false)
                playerPage:updateContainerHighlight()
                floorPage:updateContainerHighlight()
                getModData().HighlightModel.calls=getModData().HighlightModel.calls+1
            end
            local value=QueueModelWorld(${id})
            assert(instanceof(value,'IsoObject') and not value:isPropaneBBQ() and not value:isFireInteractionObject())
            for _,class in ipairs({'IsoStove','IsoClothingWasher','IsoClothingDryer','IsoCombinationWasherDryer'}) do
                assert(not instanceof(value,class),'a resident world inventory object cannot be a loot appliance')
            end
            assert(not pcall(function() instanceof({},'IsoStove') end),'unknown objects must not become classified appliance negatives')
            assert(not instanceof(nil,'IsoThumpable') and not instanceof(value,'IsoThumpable'),
                'nil and actual world inventory objects are not the separate IsoThumpable concrete class')
            assert(not pcall(function() instanceof({},'IsoThumpable') end),
                'supporting a known class must not classify unknown Lua tables as native negatives')
            ISInventoryPage.OnObjectHighlighted(0,value,true)
            assert(value:isHighlighted(0))
            ISInventoryPage.OnObjectHighlighted(0,value,false)
            assert(not value:isHighlighted(0))
            local tracked=Key.highlightDoor[0]
            local doors=tracked.doors
            local door=getPlayer():getSquare():getObjects():get(0)
            assert(instanceof(door,'IsoDoor'))
            assert(not instanceof(door,'IsoThumpable'),
                'IsoDoor implements the Thumpable interface but does not extend the IsoThumpable class')
            assert(door:getName()==nil,'the represented door constructor retains its independent unnamed IsoObject field')
            value:setHighlighted(0,true,true)
            door:setHighlighted(0,true,true)
            value:setHighlighted(0,false,false)
            assert(door:isHighlighted(0),'an item highlight must not overwrite a door highlight')
            door:setHighlighted(0,false,false)
            value:setHighlighted(0,true,true)
            assert(not door:isHighlighted(0),'numeric item identity must remain separate from stable door identity')
            door:setHighlighted(0,true,true)
            assert(doors:add(value) and doors:add(door))
            tracked.key=value:getItem()
            assert(doors:size()==2 and doors:contains(value) and doors:contains(door))
            assert(not pcall(function() doors:add({__doorId='door:5:5:0:0'}) end))
            assert(not pcall(function() Key.setHighlightDoors(1,nil) end))
            assert(not pcall(function() door.setHighlighted(value,0,false,false) end))
            assert(value:isHighlighted(0) and door:isHighlighted(0) and doors:size()==2)
            Key.setHighlightDoors(0,value:getItem())
            assert(not value:isHighlighted(0) and not door:isHighlighted(0),
                'a native non-Key selection follows the original tracked-clear branch')
            assert(tracked.key==nil and doors:isEmpty() and tracked.doors==doors)
            value:setHighlighted(0,true,true)
            door:setHighlighted(0,true,true)
            assert(doors:add(value) and doors:add(door))
            tracked.key=value:getItem()
            local accepted=pcall(function()
                Key.setHighlightDoors(0,{getFullType=function() return 'Fixture.Highlight' end})
            end)
            assert(not accepted,'an ID-shaped or getter-shaped table must not become a proven non-Key selection')
            assert(value:isHighlighted(0) and door:isHighlighted(0) and doors:size()==2 and tracked.key==value:getItem())
            Key.setHighlightDoors(0,nil)
            assert(not value:isHighlighted(0) and not door:isHighlighted(0))
            assert(tracked.key==nil and doors:isEmpty() and tracked.doors==doors)
            value:setHighlighted(0,true,false)
            Key.setHighlightDoors(0,nil)
            assert(value:isHighlighted(0),'nil clear must not clear unrelated untracked highlights')
            value:setHighlighted(0,false,false)
            local ok,err=pcall(function() instanceof({},'IsoDeadBody') end)
            assert(not ok and tostring(err):find('unsupported native class'))
        `, 'source-highlight');
        session.flushSaveData();
        assert.deepEqual(saved.get('host').data.nativePlayerData.HighlightModel, { calls: 2, playerChecks: 2 });
    } finally {
        session.close();
        host.dispose();
    }
});

test('closing a Lua session withdraws only its own world highlights from retained UI resources', async () => {
    const ui = sourceMenuUI(640);
    const { engine, host, session } = await fixture({ ui });
    let replacement;

    try {
        importPickupSquares(engine);
        engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.HighlightLifetime', weight: 0.1 }, { owner: 'fixture' });
        const first = host.api.items.spawn({ fullType: 'Fixture.HighlightLifetime', x: 5, y: 5 }).snapshot.id;
        const second = host.api.items.spawn({ fullType: 'Fixture.HighlightLifetime', x: 5, y: 5 }).snapshot.id;

        activate(session, host, `
            local objects=getPlayer():getSquare():getWorldObjects()
            for i=0,objects:size()-1 do objects:get(i):setHighlighted(0,true,false) end
        `, 'source-highlight-lifetime');
        assert.deepEqual(ui.worldHighlights().map(({ id }) => id), [first, second]);
        assert.deepEqual(ui.worldHighlights()[0].color, { r: 0.5, g: 1, b: 1, a: 1 });
        assert.equal(ui.worldHighlights()[0].outline, true);
        ui.setWorldHighlight('door', 'retained-external', { enabled: true, blink: false });
        ui.setWorldHighlight('item', second, { enabled: false, blink: false });
        const submitted = ui.worldHighlights();

        session.close({ discardSaveData: true });
        assert.deepEqual(ui.worldHighlights().map(({ kind, id }) => [kind, id]), [['item', second], ['door', 'retained-external']]);
        assert.equal(submitted[0].enabled, true, 'withdrawal must not mutate already submitted frame records');
        assert.deepEqual(ui.render(), [], 'closing the VM must preserve usable UI resources');
        replacement = await fixture({ ui });
        activate(replacement.session, replacement.host, `
            UIManager.AddUI(UIElement.new({}))
            assert(UIManager.getUI():size()==1)
        `, 'replacement-highlight-lifetime');
        assert.equal(ui.worldHighlights().some(({ id }) => id === first), false, 'replacement session must not inherit the old world tint');
        assert.deepEqual(replacement.session.diagnostics().errors, []);
    } finally {
        replacement?.session.close({ discardSaveData: true });
        replacement?.host.dispose();
        session.close({ discardSaveData: true });
        host.dispose();
        ui.dispose();
    }
});

test('portable queue capture rejects delegated transfer and pending create/adjustment closures', async () => {
    const { engine, host, session } = await fixture();

    try {
        importPickupSquares(engine);
        engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.Delegates', weight: 0.1 }, { owner: 'fixture' });
        const id = host.api.items.spawn({ fullType: 'Fixture.Delegates', x: 5, y: 5 }).snapshot.id;

        session.attachSourceActions(engine.sourceActions, engine.sourceTiming);
        await loadSource(session, host, `${SOURCE_GROUP_FIXTURE}
            QueueDelegateHead=QueueModelGrab(${id},20)
            QueueDelegateOriginalTransfer=ISGrabItemAction.transferItem
            QueueDelegateOriginalCreate=ISBaseTimedAction.create
            QueueDelegateOriginalAdjust=ISBaseTimedAction.adjustMaxTime
            local hidden=31
            QueueDelegateHead.transferItem=function(self,value)
                assert(hidden==31)
                return QueueDelegateOriginalTransfer(self,value)
            end
        `, 'queue-delegates');
        assert.throws(() => engine.saveQueueState());
        await loadSource(session, host, `
            QueueDelegateHead.transferItem=nil
            local hidden=41
            ISGrabItemAction.transferItem=function(self,value)
                assert(hidden==41)
                return QueueDelegateOriginalTransfer(self,value)
            end
        `, 'queue-prototype-delegate');
        assert.throws(() => engine.saveQueueState());
        await loadSource(session, host, `
            ISGrabItemAction.transferItem=QueueDelegateOriginalTransfer
            QueueDelegatePending=ISWalkToTimedAction:new(getPlayer(),getCell():getGridSquare(4,4,0))
            ISTimedActionQueue.add(QueueDelegatePending)
            local hidden=51
            QueueDelegatePending.create=function(self)
                assert(hidden==51)
                return QueueDelegateOriginalCreate(self)
            end
        `, 'queue-pending-create');
        assert.throws(() => engine.saveQueueState());
        await loadSource(session, host, `
            QueueDelegatePending.create=nil
            local hidden=61
            ISBaseTimedAction.adjustMaxTime=function(self,time)
                assert(hidden==61)
                return QueueDelegateOriginalAdjust(self,time)
            end
        `, 'queue-pending-adjustment');
        assert.throws(() => engine.saveQueueState());
        await loadSource(session, host, `ISBaseTimedAction.adjustMaxTime=QueueDelegateOriginalAdjust`, 'queue-delegates-restored');
        assert.ok(engine.saveQueueState().length > 0);
    } finally {
        session.close();
        host.dispose();
    }
});

const SOURCE_MENU_FIXTURE = `
    ISContextMenu={Type='ISContextMenu'}
    ISContextMenu.__index=ISContextMenu
    function ISContextMenu:new()
        return setmetatable({options={},submenus={},visible=true,mouseOver=-1},self)
    end
    function ISContextMenu:addOption(name,target,fn,...)
        local option={id=#self.options+1,name=name,target=target,onSelect=fn}
        for index,value in ipairs({...}) do option['param'..index]=value end
        self.options[#self.options+1]=option
        return option
    end
    function ISContextMenu:getNew() return ISContextMenu:new() end
    function ISContextMenu:addSubMenu(option,submenu)
        self.submenus[#self.submenus+1]=submenu
        option.subOption=#self.submenus
    end
    function ISContextMenu:getSubMenu(index) return self.submenus[index] end
    function ISContextMenu:getIsVisible() return self.visible end
    function ISContextMenu:getScrollHeight() return #self.options end
    function ISContextMenu:getScrollAreaHeight() return #self.options+1 end
    function ISContextMenu:closeAll() self.visible=false end
    function ISContextMenu:onMouseUp()
        local option=assert(self.options[self.mouseOver])
        if option.notAvailable or option.isDisabled then return end
        self:closeAll()
        return option.onSelect(option.target,option.param1,option.param2,option.param3,option.param4,option.param5,
            option.param6,option.param7,option.param8,option.param9,option.param10)
    end
    function ISContextMenu:addGetUpOption(name,target,fn,...)
        return self:addOption(name,self,self.onGetUpAndThen,fn,target,...)
    end
    function ISContextMenu:onGetUpAndThen(fn,objects,value,index)
        local action=ISWaitWhileGettingUp:new(getPlayer())
        action:setOnComplete(fn,objects,value,index)
        ISTimedActionQueue.add(action)
    end
    ISWorldObjectContextMenu={}
    function ISWorldObjectContextMenu.onGrabAllWItems(objects,values,index)
        assert(index==0)
        for _,value in ipairs(values) do QueueModelGrab(value:getItem():getID(),2) end
    end
    function ISWorldObjectContextMenu.onGrabHalfWItems(objects,values,index)
        assert(index==0)
        for position=1,math.ceil(#values/2) do QueueModelGrab(values[position]:getItem():getID(),2) end
    end
    function ISWorldObjectContextMenu.onGrabWItem(objects,value,index)
        assert(index==0)
        QueueModelGrab(value:getItem():getID(),2)
    end
    function ISWorldObjectContextMenu.handleGrabWorldItem_onHighlight(option,menu,enabled,value)
        value:setHighlighted(menu.player,enabled,false)
    end
    function ISWorldObjectContextMenu.handleGrabWorldItem_onHighlightMultiple(option,menu,enabled,values)
        for _,value in ipairs(values) do value:setHighlighted(menu.player,enabled,false) end
    end
    function ISWorldObjectContextMenu.addToolTip()
        local value={}
        function value:setName(name) self.name=name end
        return value
    end
    __pz_source_loaded()
`;

/**
 * Own font/text data with real GameUI bindings; no original assets or UI acceptance claim.
 *
 * @param {number} size - Logical content side length.
 * @param {object} [options={}] - Actual optional semantic DOM host and focus target.
 * @returns {object} Initialized actual UI service.
 */
function sourceMenuUI(size, options = {}) {
    const ui = createGameUI(options);
    const descriptor = `info face="SourceConsumer" size=4
common lineHeight=4 base=3 scaleW=4 scaleH=4 pages=1 packed=0
page id=0 file="authored.png"
chars count=95
${Array.from({ length: 95 }, (_, index) => `char id=${index + 32} x=0 y=0 width=2 height=3 xoffset=0 yoffset=0 xadvance=2 page=0 chnl=15`).join('\n')}`;

    ui.setViewport(size, size);
    ui.initialize({
        textures: [{ path: 'source-atlas', width: 4, height: 4 }], font: { descriptor, atlasPath: 'source-atlas' },
        translations: {
            ContextMenu_Grab: 'Grab', ContextMenu_Grab_one: 'One', ContextMenu_Grab_half: 'Half',
            ContextMenu_Grab_all: 'All', 'Fixture.Screen': 'Screen item', ContextMenu_Door_option: 'Door',
            ContextMenu_Open_door: 'Open', ContextMenu_Close_door: 'Close', ContextMenu_Info: 'Info',
            Tooltip_OpenClose: 'Press %1', Tooltip_DoorIsLocked: 'Locked',
            Tooltip_item_Weight: 'Weight', Tooltip_item_Equipped: 'Equipped', Tooltip_item_Unequipped: 'Unequipped',
            Tooltip_weapon_Condition: 'Condition', Tooltip_item_Insulation: 'Insulation', Tooltip_item_Windresist: 'Wind',
            Tooltip_ScratchDefense: 'Scratch defense', Tooltip_clothing_wet: 'Wet',
            Tooltip_item_AwkwardGloves: 'Awkward gloves',
            Tooltip_SourceBreaks: 'aa<br>b<BR>c',
            IGUI_ClothingName_Dirty: 'Dirty', IGUI_ClothingName_Bloody: 'Bloody',
            IGUI_ClothingName_Wet: 'Wet', IGUI_ClothingName_Soaked: 'Soaked',
            IGUI_ClothingName_Worn: 'Worn', Tooltip_Clothing_broken: 'Broken', IGUI_ClothingNaming: '%2 (%1)',
        },
        settings: {
            moodleSize: 1, fontSizeReal: 1, tooltipFont: 'Small', lockFPS: 60, gray: { r: 0.5, g: 0.5, b: 0.5, a: 1 },
            goodHighlight: { r: 0, g: 1, b: 0, a: 1 }, badHighlight: { r: 1, g: 0, b: 0, a: 1 },
        },
    });

    return ui;
}

test('source key consumers reject empty bindings and apply native alternate and modifier collision rules', async () => {
    const pressed = new Set();
    const bindings = {
        Interact: null,
        'Toggle Inventory': { keyValue: 23, altKey: 24, shift: false, ctrl: false, alt: false },
        Run: { keyValue: 23, altKey: 0, shift: true, ctrl: false, alt: false },
    };
    const { host, session } = await fixture({
        sourceWorldContext: {
            /**
             * Resolve a configured source binding.
             *
             * @param {string} name - Source binding identity.
             * @returns {object|null} Actual fixture binding.
             */
            keyBinding: (name) => bindings[name] ?? null,
            /**
             * Read the fixture's configured binding records.
             *
             * @returns {object} Current configured binding records.
             */
            keyBindings: () => bindings,
            /**
             * Read a physical source key state.
             *
             * @param {number} code - Native key identity.
             * @returns {boolean} Physical source state.
             */
            isSourceKeyDown: (code) => pressed.has(code),
        },
    });

    try {
        activate(session, host, `
            assert(not getCore():isKey(KeybindId.INTERACT,0))
            assert(getCore():isKey(KeybindId.TOGGLE_INVENTORY,23))
            assert(getCore():isKey(KeybindId.TOGGLE_INVENTORY,24))
            assert(not getCore():isKey(KeybindId.RUN,23))
            Events.OnKeyPressed.Add(function(key)
                assert(not getCore():isKey(KeybindId.TOGGLE_INVENTORY,key))
                assert(getCore():isKey(KeybindId.RUN,key))
            end)
        `);
        pressed.add(54);
        session.dispatch('OnKeyPressed', 23);
        bindings.Run = { keyValue: 54, altKey: 23, shift: false, ctrl: true, alt: true };
        await loadSource(session, host, `
            assert(getCore():isKey(KeybindId.RUN,23),'primary modifier key uses its physical state')
            assert(not getCore():isKey(KeybindId.INTERACT,0))
        `, 'source-modifier-key');
        assert.deepEqual(session.diagnostics().errors, []);
    } finally {
        session.close({ discardSaveData: true });
        host.dispose();
    }
});

test('ObjectTooltip layout measures multiline rows without drawing and draws source progress boundaries', async () => {
    const ui = sourceMenuUI(640);
    const { host, session } = await fixture({ ui });

    try {
        activate(session, host, `
            local tip=ObjectTooltip.new()
            local widget={render=function()
                tip:setWidth(0)
                local layout=tip:beginLayout()
                layout:setMinLabelWidth(10)
                layout:setMinValueWidth(80)
                local row=layout:addItem()
                row:setLabel(getText('Tooltip_SourceBreaks'),1,1,0.8,1)
                row:setValue('123',1,1,1,1)
                local progress=layout:addItem()
                progress:setLabel('c',1,1,0.8,1)
                progress:setProgress(0.25,0,1,0,1)
                assert(layout:render(5,7,tip)==23)
                assert(tip:getWidth()==105)
                assert(row.label=='aa\\nb\\nc' and row.labelWidth==4 and row.height==12 and progress.progressWidth==80,
                    'native translation breaks must reach sizing as newlines with font line spacing')
                tip:endLayout(layout)
                tip:DrawProgressBar(5,25,80,5,-1,0,1,0,1)
                tip:DrawProgressBar(5,35,80,5,2,0,1,0,1)
            end}
            widget.javaObject=UIElement.new(widget)
            UIManager.AddUI(widget.javaObject)
            tip:setMeasureOnly(true)
            TooltipLayoutMeasure=tip
        `, 'tooltip-layout-consumer');
        assert.deepEqual(ui.render(), [], 'measure-only must execute sizing but enqueue no quads');
        await loadSource(session, host, 'TooltipLayoutMeasure:setMeasureOnly(false)', 'tooltip-layout-draw');
        const draw = ui.render();
        const rectangles = draw.filter(({ texture }) => !texture);

        assert.deepEqual(draw.filter(({ texture, x }) => texture && x === 5).map(({ y }) => y), [7, 11, 15, 19],
            'translated label lines and the next row must draw at their measured native baselines');

        assert.ok(rectangles.some(({ width, height }) => width === 20 && height === 3), 'quarter progress uses floor(width*fraction)');
        assert.ok(rectangles.some(({ width, height }) => width === 80 && height === 3), 'fractions above one clamp at full width');
        assert.equal(rectangles.filter(({ width }) => width === 82).length, 3, 'all progress bars retain their native border');
        assert.deepEqual(session.diagnostics().errors, []);
    } finally {
        session.close({ discardSaveData: true });
        host.dispose();
        ui.dispose();
    }
});

test('ObjectTooltip signed values follow the original positive-is-good flag in every sign branch', async () => {
    const ui = sourceMenuUI(640);
    const { host, session } = await fixture({ ui });

    try {
        activate(session, host, `
            local tip=ObjectTooltip.new()
            local layout=tip:beginLayout()
            for _,case in ipairs({
                {5,true,'+5',true},{-5,true,'-5',false},
                {5,false,'+5',false},{-5,false,'-5',true},
                {0,true,'0',true},{0,false,'0',true},
            }) do
                local row=layout:addItem()
                row:setValueRight(case[1],case[2])
                local tint=case[4] and getCore():getGoodHighlitedColor() or getCore():getBadHighlitedColor()
                assert(row.value==case[3] and row.r1==tint:getR() and row.g1==tint:getG()
                    and row.b1==tint:getB() and row.a1==1 and row.hasValue and row.rightJustify,
                    'signed tooltip value must use the native flag polarity')
            end
            tip:endLayout(layout)
        `, 'tooltip-signed-value-consumer');
        assert.deepEqual(session.diagnostics().errors, []);
    } finally {
        session.close({ discardSaveData: true });
        host.dispose();
        ui.dispose();
    }
});

test('native live UI lists index resident identities from zero and observe root removal', async () => {
    const ui = sourceMenuUI(640);
    const { host, session } = await fixture({ ui });

    try {
        activate(session, host, `
            local first,second=UIElement.new({}),UIElement.new({})
            local stack=UIManager.getUI()
            assert(stack:size()==0 and stack:indexOf(first)==-1 and stack:indexOf(nil)==-1)
            UIManager.AddUI(first)
            UIManager.AddUI(second)
            assert(UIManager.getUI()==stack and stack:indexOf(first)==0 and stack:indexOf(second)==1)
            assert(stack:get(0)==first and stack:get(1)==second)
            local impostor=setmetatable({__ui=first.__ui},{__eq=function() return true end})
            assert(stack:indexOf(impostor)==-1,'native list lookup requires identity, not an ID-shaped table or Lua equality')
            first:setVisible(false)
            assert(stack:indexOf(first)==0,'hidden roots retain their native stack position')
            UIManager.RemoveElement(first)
            assert(stack:indexOf(first)==-1 and stack:indexOf(second)==0,'retained lists must observe current root order')
            UIManager.RemoveElement(second)
            assert(stack:isEmpty() and stack:indexOf(second)==-1)
        `, 'live-ui-list-index');
        assert.deepEqual(session.diagnostics().errors, []);
    } finally {
        session.close({ discardSaveData: true });
        host.dispose();
        ui.dispose();
    }
});

test('native clothing names read live naming fields without requiring tooltip component support', async () => {
    const ui = sourceMenuUI(640);
    const { engine, host, session } = await fixture({ ui });
    const [definition] = parseItemDefinitions(`module Fixture { item Screen {
        ItemType = base:clothing, Weight = 0.1, ConditionMax = 10, BodyLocation = base:hands,
    } }`, 'clothing-name-consumer');

    try {
        engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, ...definition, extraItems: [] }, { owner: 'fixture' });
        importPickupSquares(engine);
        const spawned = host.api.items.spawn({ fullType: definition.fullType, x: 5, y: 5 });

        assert.throws(() => engine.sourceActions.itemTooltipState(spawned.snapshot.id), /unresolved component/u);
        activate(session, host, `
            local entry=getPlayer():getSquare():getWorldObjects():get(0):getItem()
            assert(entry:getCondition()==10 and entry:getConditionMax()==10)
            assert(entry:getName()=='Screen item','ordinary names do not inspect tooltip components')
            entry:setWetness(50)
            assert(entry:getName()=='Screen item (Wet)','names must still observe current native wetness')
            assert(entry:getDisplayName()=='Screen item','stored display name must not acquire dynamic wet clothing descriptors')
            entry:setWetness(0)
            assert(entry:getName()=='Screen item','names must not retain a stale presentation snapshot')
            entry:setCondition(2)
            assert(entry:getName()=='Screen item (Worn)','worn naming must use native condition, not a defense slot')
            entry:setWetness(100)
            assert(entry:getName()=='Screen item (Soaked, Worn)','source descriptors retain their original order')
            entry:setBroken(true)
            assert(entry:getName()=='Screen item (Soaked, Broken)','broken clothing replaces the worn descriptor')
            entry:setBroken(false)
            entry:setCondition(10)
            entry:setWetness(0)
            assert(entry:getName()=='Screen item','restored native fields remove all dynamic descriptors')
        `, 'clothing-name-consumer');
        assert.deepEqual(session.diagnostics().errors, []);
    } finally {
        session.close({ discardSaveData: true });
        host.dispose();
        ui.dispose();
    }
});

test('native clothing tooltip uses live condition and wetness in both real measure and draw passes', async () => {
    const ui = sourceMenuUI(640);
    const { engine, host, session } = await fixture({ ui });
    const [definition] = parseItemDefinitions(`module Fixture { item Screen {
        ItemType = base:clothing, Weight = 0.1, ConditionMax = 10, BodyLocation = base:hands,
        ScratchDefense = 30, Insulation = 0.25, WindResistance = 0.3, Tooltip = Tooltip_item_AwkwardGloves,
    } }`, 'tooltip-clothing-consumer');

    try {
        engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, ...definition }, { owner: 'fixture' });
        importPickupSquares(engine);
        host.api.items.spawn({ fullType: definition.fullType, x: 5, y: 5 });
        activate(session, host, `
            local entry=getPlayer():getSquare():getWorldObjects():get(0):getItem()
            local tip=ObjectTooltip.new()
            tip:setCharacter(getPlayer())
            local rows=tip:beginLayout()
            entry:DoTooltip(tip,rows)
            assert(rows.items:size()==4,'condition, insulation, wind and scratch comparison rows are source-owned')
            assert(rows.items:get(0).progressFraction==1 and rows.items:get(1).progressFraction==0.25)
            assert(rows.items:get(3).value=='30 (+30)')
            tip:endLayout(rows)
            local widget={render=function()
                tip:setWidth(50)
                entry:DoTooltip(tip)
                assert(tip:getWidth()>=150 and tip:getHeight()>20)
            end}
            widget.javaObject=UIElement.new(widget)
            UIManager.AddUI(widget.javaObject)
            TooltipClothingEntry,TooltipClothingMeasure=entry,tip
            tip:setMeasureOnly(true)
        `, 'tooltip-clothing-consumer');
        assert.deepEqual(ui.render(), []);
        await loadSource(session, host, `
            TooltipClothingMeasure:setMeasureOnly(false)
            TooltipClothingEntry:setCondition(5)
            TooltipClothingEntry:setWetness(50)
            local rows=TooltipClothingMeasure:beginLayout()
            TooltipClothingEntry:DoTooltip(TooltipClothingMeasure,rows)
            assert(rows.items:get(0).progressFraction==0.5)
            assert(rows.items:get(3).progressFraction==0.5,'wet row precedes defenses')
            assert(rows.items:get(4).value=='30 (+30)','positive condition does not scale clothing defenses')
            TooltipClothingMeasure:endLayout(rows)
        `, 'tooltip-clothing-live-state');
        assert.ok(ui.render().length > 0, 'drawing pass must emit real UI quads');
        assert.deepEqual(session.diagnostics().errors, []);
    } finally {
        session.close({ discardSaveData: true });
        host.dispose();
        ui.dispose();
    }
});

test('native Lua item icons render script normal textures from Icon or IconsForTexture through the real UI bindings', async () => {
    const ui = sourceMenuUI(64);
    const { engine, host, session } = await fixture({ ui });

    try {
        importPickupSquares(engine);
        ui.addTextures([
            { path: 'media/textures/Item_First.png', width: 3, height: 4 },
            { path: 'media/textures/Item_Chosen.png', width: 5, height: 6 },
        ]);

        for (const definition of [
            { fullType: 'Fixture.IndexedIcon', rawFields: [{ name: 'IconsForTexture', value: 'First;UnavailableChoice' }] },
            { fullType: 'Fixture.ExplicitIcon', rawFields: [{ name: 'IconsForTexture', value: 'UnavailableChoice;First' }, { name: 'Icon', value: 'Chosen' }] },
        ]) {
            engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, ...definition, weight: 0.1 }, { owner: 'fixture' });
            host.api.items.spawn({ fullType: definition.fullType, x: 5, y: 5 });
        }

        activate(session, host, `
            local ground=getPlayer():getSquare():getWorldObjects()
            local values={ground:get(0):getItem(),ground:get(1):getItem()}
            local widget={render=function(self)
                for index,value in ipairs(values) do
                    local texture=value:getTex()
                    assert(texture:getWidth()==(index==1 and 3 or 5))
                    self.javaObject:DrawTextureScaledAspect(texture,(index-1)*16,0,12,12,
                        value:getR(),value:getG(),value:getB(),1)
                end
            end}
            widget.javaObject=UIElement.new(widget)
            UIManager.AddUI(widget.javaObject)
        `, 'source-normal-icons');
        assert.deepEqual(ui.render().map(({ x, y, width, height }) => [x, y, width, height]), [
            [1, 0, 9, 12], [17, 0, 10, 12],
        ]);
        assert.deepEqual(session.diagnostics().errors, []);
    } finally {
        session.close({ discardSaveData: true });
        host.dispose();
        ui.dispose();
    }
});

test('native Lua UI lifetime retains detached trees and releases abandoned targets without forced collection', async () => {
    const ui = sourceMenuUI(640);
    const observed = observeUiLifetime(ui);
    const { host, session } = await fixture({ ui: observed.ui });

    try {
        await loadSource(session, host, `
            LifetimeWeak=setmetatable({}, {__mode='v'})
            LifetimePressureTicks=0
            local function node(label,x,y)
                local target={}
                function target:render()
                    self.javaObject:DrawText(UIFont.Small,label,0,0,1,1,1,1)
                end
                local value=UIElement.new(target)
                target.javaObject=value
                value:setX(x);value:setY(y);value:setWidth(100);value:setHeight(100)
                return value
            end
            LifetimeRoot=node('parent',5,0)
            local child=node('child',3,16)
            LifetimeWeak[1]=child
            LifetimeRoot:AddChild(child)
            LifetimeRoot.getTable=function() error('callbacks must not follow a mutable public getter') end
            UIManager.AddUI(LifetimeRoot)

            local ancestor=node('ancestor',11,0)
            LifetimeRetainedChild=node('retained',3,0)
            LifetimeWeak[2]=ancestor
            ancestor:AddChild(LifetimeRetainedChild)

            LifetimePreviousParent=node('previous',11,0)
            local nextParent=node('next',23,0)
            local moved=node('moved',3,0)
            LifetimePreviousParent:AddChild(moved)
            nextParent:AddChild(moved)
            assert(moved:getAbsoluteX()==26)
            nextParent:RemoveChild(moved)
            LifetimeWeak[3]=moved
            LifetimeWeak[4]=nextParent

            Events.OnTick.Add(function()
                for index=1,50 do
                    local target={}
                    target.javaObject=UIElement.new(target)
                    target.transition=UITransition.new()
                end
                LifetimePressureTicks=LifetimePressureTicks+1
            end)
        `, 'ui-lifetime-tree');
        assert.equal(ui.render().length, 'parentchild'.length);
        await loadSource(session, host, `
            UIManager.RemoveElement(LifetimeRoot)
            LifetimeExpiredParent=UIElement.new({})
            LifetimeExpiredParent:setX(19)
            LifetimeExpiredParent:setWidth(100);LifetimeExpiredParent:setHeight(100)
            LifetimeRetainedOwnedBridge=UIElement.new({})
            LifetimeRetainedOwnedBridge:setX(7)
            LifetimeRetainedOwnedBridge:setWidth(100);LifetimeRetainedOwnedBridge:setHeight(100)
            LifetimeExpiredParent:AddChild(LifetimeRetainedOwnedBridge)
            LifetimeWeak[5]=LifetimeExpiredParent
        `, 'ui-lifetime-expiring');
        await loadSource(session, host, `
            local target={}
            function target:render()
                self.javaObject:DrawText(UIFont.Small,'foreign',0,0,1,1,1,1)
            end
            LifetimeForeignChild=UIElement.new(target)
            target.javaObject=LifetimeForeignChild
            LifetimeForeignChild:setX(2)
            LifetimeForeignChild:setWidth(100);LifetimeForeignChild:setHeight(100)
            LifetimeRetainedOwnedBridge:AddChild(LifetimeForeignChild)
            local siblingTarget={}
            function siblingTarget:render()
                self.javaObject:DrawText(UIFont.Small,'sibling',0,0,1,1,1,1)
            end
            local sibling=UIElement.new(siblingTarget)
            siblingTarget.javaObject=sibling
            sibling:setX(3);sibling:setWidth(100);sibling:setHeight(100)
            LifetimeExpiredParent:AddChild(sibling)
            LifetimeWeak[8]=sibling
            LifetimeWeak[6]=LifetimeForeignChild
            LifetimeForeignChild=nil
            LifetimeExpiredParent=nil
        `, 'ui-lifetime-foreign');

        for (let tick = 0; tick < 50; tick += 1) {
            host.frameStep(1 / 60);
        }

        ui.bindings.cleanup('ui-lifetime-expiring');
        assert.equal(ui.render().length, 'foreignsibling'.length);

        for (let tick = 0; tick < 50; tick += 1) {
            host.frameStep(1 / 60);
        }

        await loadSource(session, host, `
            assert(LifetimePressureTicks==100)
            assert(LifetimeWeak[1]~=nil,'a retained detached native parent must retain its child')
            assert(LifetimeWeak[2]~=nil and LifetimeRetainedChild:getAbsoluteX()==14,
                'a retained native child must retain its detached parent')
            assert(LifetimeWeak[3]==nil and LifetimeWeak[4]==nil,
                'reparenting and removal must clear both old and new native ownership edges')
            assert(LifetimeWeak[5]==nil,
                'native owner cleanup must not retain a deleted parent through a promoted foreign child')
            assert(LifetimeWeak[6]~=nil and LifetimeWeak[6]:getAbsoluteX()==28,
                'foreign promotion must atomically transfer the only native ownership into a root pin')
            assert(LifetimeWeak[8]~=nil and LifetimeWeak[8]:getAbsoluteX()==22,
                'all foreign siblings must be pinned before detaching their only retained owned bridge')
            UIManager.AddUI(LifetimeRoot)
        `, 'ui-lifetime-verify');
        assert.equal(ui.render().length, 'foreignsiblingparentchild'.length);
        assert.ok(observed.counts.new >= 5_000);
        assert.ok(observed.counts.release > observed.counts.new / 2, 'actual native elements must be released during normal allocation');
        assert.ok(observed.counts.transitionRelease > observed.counts.transitionNew / 2,
            'actual transitions must be released with their abandoned Lua owners');
        assert.deepEqual(session.diagnostics().errors, []);
        assert.deepEqual(host.diagnostics().errors, []);
        assert.equal(session.diagnostics().timeouts, 0);
    } finally {
        session.close({ discardSaveData: true });
        host.dispose();
        ui.dispose();
    }
});

test('post-save source teardown removes real UI roots without load replay and keeps native callback faults attributable', async () => {
    const ui = sourceMenuUI(640);
    const { host, session } = await fixture({ ui });
    const path = 'media/lua/client/post-save-consumer/main.lua';

    try {
        session.activatePackage({
            id: 'post-save-consumer', nativeId: 'SaveConsumer', api: host.api,
            sources: [{
                path, source: `
                    assert(not getCore():isDedicated())
                    local players=IsoPlayer.getPlayers()
                    assert(players==IsoPlayer.getPlayers() and players:size()==getNumActivePlayers() and players:size()==1)
                    assert(players:get(0)==getSpecificPlayer(0))
                    local widget={render=function(self)
                        self.javaObject:DrawText(UIFont.Small,'?',0,0,1,1,1,1)
                    end}
                    widget.javaObject=UIElement.new(widget)
                    UIManager.AddUI(widget.javaObject)
                    UIManager.setPlayerInventory(0,widget.javaObject,nil)
                    UIManager.setPlayerInventoryTooltip(0,nil,widget.javaObject)
                    local function teardown(...)
                        assert(select('#',...)==0,'post-save must have no arguments')
                        UIManager.RemoveElement(widget.javaObject)
                        UIManager.setPlayerInventory(0,nil,nil)
                        UIManager.setPlayerInventoryTooltip(0,nil,nil)
                        Events.OnPostSave.Remove(teardown)
                    end
                    Events.OnPostSave.Add(teardown)
                `,
            }],
        });
        assert.equal(ui.render().length, 1);
        session.dispatch('OnLoad');
        session.dispatch('OnCreatePlayer', 0);
        session.dispatch('OnGameStart');
        session.flushSaveData();
        assert.equal(ui.render().length, 1, 'load and capture must not tear down source UI');
        assert.throws(() => session.dispatch('OnPostSave', 0), /takes no arguments/u);
        assert.equal(ui.render().length, 1, 'invalid event input must not execute source teardown');
        session.dispatch('OnPostSave');
        assert.deepEqual(ui.render(), []);
        session.dispatch('OnPostSave');
        session.activatePackage({
            id: 'post-save-fault', nativeId: 'SaveFault', api: host.api,
            sources: [{
                path: 'media/lua/client/post-save-fault/main.lua',
                source: 'Events.OnPostSave.Add(function() getCore():getVersion() end)',
            }],
        });
        assert.throws(() => session.dispatch('OnPostSave'), (cause) => {
            assert.equal(cause.name, 'NativeLuaError');
            assert.equal(cause.modId, 'post-save-fault');
            assert.equal(cause.nativeModId, 'SaveFault');
            assert.equal(cause.path, 'media/lua/client/post-save-fault/main.lua');
            assert.match(cause.message, /unsupported native facility: Core:getVersion/u);

            return true;
        });
        assert.deepEqual(ui.render(), [], 'a later callback failure cannot undo completed teardown');
        assert.throws(() => activate(session, host, 'Events.OnPreSave.Add(function() end)', 'unsupported-save-neighbor'),
            /unsupported event: Events.OnPreSave/u);
    } finally {
        session.close({ discardSaveData: true });
        host.dispose();
        ui.dispose();
    }
});

test('resolution source callback reads the new real viewport and reflows its existing native UI element', async () => {
    const ui = sourceMenuUI(640);
    const { host, session } = await fixture({ ui });

    try {
        activate(session, host, `
            local widget={render=function(self)
                self.javaObject:DrawTextureScaled(getTexture('source-atlas'),0,0,self.javaObject:getWidth(),4,1)
            end}
            widget.javaObject=UIElement.new(widget)
            widget.javaObject:setWidth(64)
            UIManager.AddUI(widget.javaObject)
            Events.OnResolutionChange.Add(function(oldw,oldh,neww,newh)
                assert(oldw==640 and oldh==640 and neww==320 and newh==240)
                assert(getCore():getScreenWidth()==neww and getCore():getScreenHeight()==newh)
                local players=IsoPlayer.getPlayers()
                assert(players:size()==1 and players:get(0)==getPlayer())
                widget.javaObject:setWidth(neww/10)
            end)
            Events.OnRightMouseDown.Add(function(x,y)
                assert(x==25 and y==30)
                UIManager.RemoveElement(widget.javaObject)
            end)
        `, 'resolution-consumer');
        assert.equal(ui.render()[0].width, 64);
        assert.throws(() => session.dispatch('OnResolutionChange', 640, 640, 320), /four positive/iu);
        assert.throws(() => session.dispatch('OnResolutionChange', 640, 640, 0, 240), /four positive/iu);
        ui.setViewport(320, 240);
        session.dispatch('OnResolutionChange', 640, 640, 320, 240);
        assert.equal(ui.render()[0].width, 32);
        assert.throws(() => session.dispatch('OnRightMouseDown', 25), /two nonnegative finite/u);
        assert.equal(ui.render()[0].width, 32, 'invalid mouse input must not remove the real root');
        session.dispatch('OnRightMouseDown', 25, 30);
        assert.deepEqual(ui.render(), []);
    } finally {
        session.close({ discardSaveData: true });
        host.dispose();
        ui.dispose();
    }
});

test('source layout writer persists real UI geometry and reads its lines while durable faults keep source ownership', async () => {
    const records = new Map();
    let denied = false;
    const storage = {
        /**
         * Read the external fixture's retained file bytes.
         *
         * @param {string} key - Actual namespace.
         * @returns {string|null} Retained bytes.
         */
        getItem: (key) => records.get(key) ?? null,
        /**
         * Atomically replace the external fixture's file bytes.
         *
         * @param {string} key - Actual namespace.
         * @param {string} text - Atomic replacement.
         * @returns {void} Completes the fixture's storage commit.
         */
        setItem: (key, text) => {
            if (denied) {
                throw new Error('client layout storage denied');
            }

            records.set(key, text);
        },
    };
    const fileOptions = { storage, sourceBuild: '42.21.0', ownerId: 'pz-base-game' };
    const files = createSourceFiles(fileOptions);
    const ui = sourceMenuUI(640);
    const { host, session, saved } = await fixture({ ui, sourceFiles: files });
    const path = 'media/lua/client/layout-consumer/main.lua';

    try {
        session.activatePackage({
            id: 'pz-base-game', nativeId: 'LayoutConsumer', api: host.coreApi,
            sources: [{
                path, source: `
                    local widget={render=function(self) self.javaObject:DrawText(UIFont.Small,'?',0,0,1,1,1,1) end}
                    widget.javaObject=UIElement.new(widget)
                    widget.javaObject:setWidth(64)
                    UIManager.AddUI(widget.javaObject)
                    Events.OnPostSave.Add(function()
                        local writer=getFileWriter('layout.ini',true,false)
                        writer:write(string.format('[%dx%d]',getCore():getScreenWidth(),getCore():getScreenHeight())..string.char(13,10))
                        writer:write(string.format('window width=%d',widget.javaObject:getWidth())..string.char(13))
                        writer:write('trail'..string.char(10))
                        writer:close()
                        UIManager.RemoveElement(widget.javaObject)
                    end)
                    Events.OnLoad.Add(function()
                        local reader=getFileReader('layout.ini',true)
                        getModData().LayoutLines={reader:readLine(),reader:readLine(),reader:readLine()}
                        assert(reader:readLine()==nil)
                        reader:close()
                    end)
                `,
            }],
        });
        assert.equal(ui.render().length, 1);
        session.dispatch('OnPostSave');
        assert.deepEqual(ui.render(), []);
        const beforeFlush = createSourceFiles(fileOptions);

        assert.equal(beforeFlush.read('layout.ini'), null, 'closing source writer only stages until durable completion');
        beforeFlush.dispose();
        await session.flushSourceFiles();
        const retained = createSourceFiles(fileOptions);

        assert.equal(retained.read('layout.ini'), '[640x640]\r\nwindow width=64\rtrail\n');
        retained.dispose();
        session.dispatch('OnLoad');
        session.flushSaveData();
        assert.deepEqual(saved.get('pz-base-game').data.nativePlayerData.LayoutLines, ['[640x640]', 'window width=64', 'trail']);
        denied = true;
        session.dispatch('OnPostSave');
        await assert.rejects(session.flushSourceFiles(), (cause) => cause.name === 'NativeLuaError'
            && cause.modId === 'pz-base-game' && cause.nativeModId === 'LayoutConsumer' && cause.path === path
            && /client layout storage denied/u.test(cause.message));
        denied = false;
        await session.flushSourceFiles();
    } finally {
        session.close({ discardSaveData: true });
        host.dispose();
        ui.dispose();
    }
});

test('real held transitions invoke source consumers after commit without same-value, veto or hydration replay', async () => {
    const { engine, host, session } = await fixture({
        sourceWorldContext: {
            /**
             * Forward source mutations through the real shared owner/item hooks.
             *
             * @param {'primary'|'secondary'} slot - Native hand slot.
             * @param {number|null} itemId - Actual inventory identity.
             * @param {string} ownerId - Bound live source owner.
             * @returns {object} Actual shared command result.
             */
            setHandItem: (slot, itemId, ownerId) => liveHost.sourceSetHandItem(slot, itemId, ownerId),
        },
    });

    const liveHost = host;

    try {
        importPickupSquares(engine);
        engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.Held', weight: 1 }, { owner: 'fixture' });
        const first = host.api.items.spawn({ fullType: 'Fixture.Held', x: 5, y: 5 }).snapshot.id;
        const second = host.api.items.spawn({ fullType: 'Fixture.Held', x: 5, y: 5 }).snapshot.id;

        assert.equal(host.api.items.pickup(first).accepted, true);
        assert.equal(host.api.items.pickup(second).accepted, true);
        session.activatePackage({
            id: 'pz-base-game', nativeId: 'HandConsumer', api: host.coreApi,
            sources: [{
                path: 'media/lua/client/hand-consumer/main.lua', source: `
                    local function primary(...)
                        assert(select('#',...)==2)
                        local character,value=...
                        assert(character==getPlayer())
                        assert(character:getPrimaryHandItem()==value)
                        if value then value:setActualWeight(value:getActualWeight()+.125) end
                    end
                    local function secondary(...)
                        assert(select('#',...)==2)
                        local character,value=...
                        assert(character==getPlayer())
                        assert(character:getSecondaryHandItem()==value)
                        if value then
                            value:setActualWeight(value:getActualWeight()+.125)
                        else
                            local held=character:getPrimaryHandItem()
                            if held then held:setActualWeight(held:getActualWeight()+.25) end
                        end
                    end
                    Events.OnEquipPrimary.Add(primary)
                    Events.OnEquipSecondary.Add(secondary)
                    local sent=false
                    Events.OnTick.Add(function()
                        if sent then return end
                        sent=true
                        getPlayer():setSecondaryHandItem(getPlayer():getPrimaryHandItem())
                    end)
                `,
            }],
        });
        assert.notEqual(host.api.items.get(first).worldPosition, null, 'pickup admission is not inventory transfer');
        assert.throws(() => host.coreApi.character.setHandItem('primary', first),
            (cause) => cause.name === 'ModError' && cause.modId === 'pz-base-game'
                && cause.stage === 'action' && cause.cause instanceof RangeError);
        assert.deepEqual(engine.getHandItems(), { primary: null, secondary: null });
        assert.equal(host.api.items.get(first).actualWeight, 1, 'rejected ground equipment cannot emit a source callback');
        completeActions(engine);
        assert.equal(host.api.items.get(first).ownerContainerId, host.api.items.playerInventoryId());
        assert.equal(host.api.items.get(second).ownerContainerId, host.api.items.playerInventoryId());
        host.coreApi.character.setHandItem('primary', first);
        assert.equal(host.api.items.get(first).actualWeight, 1.125,
            JSON.stringify({ hostErrors: host.diagnostics().errors, luaErrors: session.diagnostics().errors }));
        host.coreApi.character.setHandItem('primary', first);
        assert.equal(host.api.items.get(first).actualWeight, 1.125);
        const unveto = host.api.hooks.beforeAction((action) => action.type === 'setHandItem' ? false : undefined);

        assert.equal(host.coreApi.character.setHandItem('secondary', second).cancelled, true);
        assert.equal(host.api.items.get(second).actualWeight, 1);
        unveto();
        host.step(1 / 60);
        assert.deepEqual(engine.getHandItems(), { primary: first, secondary: first });
        assert.equal(host.api.items.get(first).actualWeight, 1.25, 'a source setter must defer its real callback until the VM unwinds');
        host.coreApi.character.setHandItem('secondary', null);
        assert.equal(host.api.items.get(first).actualWeight, 1.5, 'actual nil hand delivery remains two arguments');
        engine.loadHandState({ version: 1, primary: second, secondary: null });
        assert.equal(host.api.items.get(second).actualWeight, 1, 'native hydration must not replay Lua equip callbacks');
        assert.throws(() => session.dispatch('OnDestroyIsoThumpable', first), /no authenticated IsoThumpable/u);
        assert.deepEqual(session.diagnostics().errors.filter((cause) => /HandConsumer/u.test(cause.message)), []);
    } finally {
        session.close({ discardSaveData: true });
        host.dispose();
    }
});

test('source drag events observe prior state and same identity before owned deactivation and player binding', async () => {
    const { host, session, saved } = await fixture();

    try {
        await loadSource(session, host, `
            DragFirst={player=88}
            function DragFirst:deactivate()
                assert(self==DragFirst and getCell():getDrag(0)==self)
                local previous=getModData().DragDeactivated
                getModData().DragDeactivated={player=self.player,calls=previous and previous.calls+1 or 1}
            end
            getCell():setDrag(DragFirst,0)
            assert(DragFirst.player==0)
        `, 'drag-first');
        await loadSource(session, host, `
            getModData().DragObserved={}
            Events.SetDragItem.Add(function(...)
                assert(select('#',...)==2)
                local nextDrag,index=...
                local rows=getModData().DragObserved
                rows[#rows+1]={index=index,oldIsFirst=getCell():getDrag(0)==DragFirst,
                    nextIsFirst=nextDrag==DragFirst,nextPlayer=nextDrag and rawget(nextDrag,'player') or -1}
            end)
            Events.OnKeyPressed.Add(function() getCell():setDrag(DragFirst,0) end)
        `, 'drag-observer');
        assert.throws(() => session.dispatch('SetDragItem'), /unsupported externally dispatched/u);
        const externalFaults = session.diagnostics().errors;

        assert.equal(externalFaults.length, 1);
        assert.match(externalFaults[0].message, /unsupported externally dispatched event: SetDragItem/u);
        session.dispatch('OnKeyPressed', 1);
        await loadSource(session, host, `
            DragSecond=setmetatable({},{__newindex=function() error('player binding must use rawset') end})
            getCell():setDrag(DragSecond,0)
            assert(getCell():getDrag(0)==DragSecond and rawget(DragSecond,'player')==0)
            getCell():setDrag(DragFirst,4)
            assert(getCell():getDrag(0)==DragSecond,'out-of-range player must not replace the active drag')
        `, 'drag-second');
        session.flushSaveData();
        assert.deepEqual(saved.get('drag-observer').data.nativePlayerData.DragObserved, [
            { index: 0, oldIsFirst: true, nextIsFirst: true, nextPlayer: 0 },
            { index: 0, oldIsFirst: true, nextIsFirst: false, nextPlayer: -1 },
            { index: 4, oldIsFirst: false, nextIsFirst: true, nextPlayer: 0 },
        ]);
        assert.deepEqual(saved.get('drag-first').data.nativePlayerData.DragDeactivated, { player: 0, calls: 1 });
        assert.equal(saved.get('drag-second')?.data.nativePlayerData?.DragDeactivated, undefined);
        assert.deepEqual(session.diagnostics().errors, externalFaults, 'authorized drag changes must not add errors after the explicit boundary rejection');
    } finally {
        session.close({ discardSaveData: true });
        host.dispose();
    }
});

test('protected original drag deactivation records its actual owner fault but still commits replacement and nil', async () => {
    const { host, session, saved } = await fixture();
    const path = 'media/lua/client/drag-fault/main.lua';

    try {
        await loadPackage(session, host, {
            id: 'drag-fault', nativeId: 'DragFault', sources: [{
                path, source: `
                    DragFault={player=-1}
                    function DragFault:deactivate()
                        assert(getCell():getDrag(0)==self)
                        getModData().DragFaultReached=true
                        error('actual protected drag deactivation fault')
                    end
                    getCell():setDrag(DragFault,0)
                `,
            }],
        });
        await loadSource(session, host, `
            local replacement=setmetatable({},{__index={deactivate=function() error('inherited deactivation must not run') end}})
            getCell():setDrag(replacement,0)
            assert(getCell():getDrag(0)==replacement and rawget(replacement,'player')==0)
            getCell():setDrag(nil,0)
            assert(getCell():getDrag(0)==nil)
            getModData().DragReplacementCommitted=true
        `, 'drag-replacement');
        session.flushSaveData();
        const faults = session.diagnostics().errors;

        assert.equal(faults.length, 1);
        assert.equal(faults[0].modId, 'drag-fault');
        assert.equal(faults[0].nativeModId, 'DragFault');
        assert.equal(faults[0].apiModId, 'drag-fault');
        assert.equal(faults[0].path, path);
        assert.match(faults[0].message, /actual protected drag deactivation fault/u);
        assert.equal(saved.get('drag-fault').data.nativePlayerData.DragFaultReached, true);
        assert.equal(saved.get('drag-replacement').data.nativePlayerData.DragReplacementCommitted, true);
    } finally {
        session.close({ discardSaveData: true });
        host.dispose();
    }
});

test('actual world phases retain picked vectors and blueprint identity, deliver absent-square nil, and refuse unsupported building clicks', async () => {
    const { engine, host, session } = await fixture({
        sourceWorldContext: {
            /**
             * Read the actual imported cell footprint without requiring a materialized square.
             *
             * @param {number} x - Native integer world x.
             * @param {number} y - Native integer world y.
             * @param {number} z - Native ground elevation.
             * @returns {boolean} Whether the imported fixture cell covers the point.
             */
            isValidSquare: (x, y, z) => {
                const bounds = liveEngine.worldBounds();
                const cx = Math.floor(x / 256);
                const cy = Math.floor(y / 256);

                return z === 0 && bounds.active && cx >= bounds.minCx && cx <= bounds.maxCx
                    && cy >= bounds.minCy && cy <= bounds.maxCy;
            },
        },
    });

    const liveEngine = engine;

    try {
        const navigation = new Uint8Array(1_026);

        navigation[1] = 1;
        engine.worldImportCell(0, 0, navigation);
        importPickupSquares(engine);
        engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.WorldPhase', weight: 1 }, { owner: 'fixture' });
        const id = host.api.items.spawn({ fullType: 'Fixture.WorldPhase', x: 5, y: 5 }).snapshot.id;

        session.activatePackage({
            id: 'pz-base-game', nativeId: 'WorldPhaseConsumer', api: host.coreApi,
            sources: [{
                path: 'media/lua/client/world-phase-consumer/main.lua', source: `
                    local item=getCell():getGridSquare(5,5,0):getWorldObjects():get(0):getItem()
                    local blueprint={player=0}
                    local picked,localPicked
                    function blueprint:render(x,y,z,square)
                        assert(self==getCell():getDrag(0))
                        assert(z==0 and square==getCell():getGridSquare(x,y,z))
                        item:setActualWeight(item:getActualWeight()+.25)
                    end
                    Events.RenderOpaqueObjectsInWorld.Add(function(...)
                        assert(select('#',...)==5)
                        local index,x,y,z,square=...
                        assert(index==0 and z==0 and (x==5 or x==8) and y==x)
                        assert(square==getCell():getGridSquare(x,y,z))
                        if x==5 then assert(square~=nil) else assert(square==nil) end
                        local tile,fraction=UIManager.getPickedTile(),UIManager.getPickedTileLocal()
                        if picked then assert(tile==picked and fraction==localPicked) end
                        picked,localPicked=tile,fraction
                        assert(tile.x==x and tile.y==y and fraction.x==.25 and fraction.y==.5)
                        item:setActualWeight(item:getActualWeight()+.125)
                    end)
                    Events.OnDoTileBuilding2.Add(function(...)
                        assert(select('#',...)==6)
                        local drag,isRender,x,y,z,square=...
                        assert(drag==blueprint and isRender==true)
                        drag:render(x,y,z,square)
                    end)
                    Events.OnDoTileBuilding3.Add(function() error('no native joypad may be fabricated') end)
                    JoypadState.players[1]={}
                    Events.OnTick.Add(function() getCell():setDrag(blueprint,0) end)
                `,
            }],
        });
        assert.equal(session.renderWorldPhase('opaque', 0), false, 'no guessed initial pointer');
        assert.equal(session.buildingInput(), false, 'no active drag requires no object picker');
        assert.throws(() => session.updateWorldPointer(Infinity, 5), /finite native/u);
        assert.throws(() => session.renderWorldPhase('opaque', 1), /ground-level/u);

        for (const name of ['RenderOpaqueObjectsInWorld', 'OnDoTileBuilding2', 'OnDoTileBuilding3']) {
            assert.throws(() => session.dispatch(name), /unsupported externally dispatched/u);
        }

        session.updateWorldPointer(5.25, 5.5);
        assert.equal(session.renderWorldPhase('opaque', 0), true);
        assert.equal(host.api.items.get(id).actualWeight, 1.125);
        assert.equal(session.renderWorldPhase('building', 0), false);
        host.step(1 / 60);
        assert.equal(session.renderWorldPhase('building', 0), true);
        assert.equal(host.api.items.get(id).actualWeight, 1.375, 'the real source blueprint consumer mutated native state');
        const beforeClick = engine.saveState();

        assert.throws(() => session.buildingInput(), (cause) => cause.name === 'NativeLuaError'
            && cause.modId === 'pz-base-game' && cause.nativeModId === 'WorldPhaseConsumer'
            && cause.path === '<world-build-input>' && /IsoObjectPicker.ContextPick/u.test(cause.message));
        assert.equal(host.api.items.get(id).actualWeight, 1.375, 'unsupported click must never emit a false building phase');
        assert.deepEqual(engine.saveState(), beforeClick);
        session.updateWorldPointer(8.25, 8.5);
        assert.equal(session.renderWorldPhase('opaque', 0), true, 'valid imported footprint permits a nil source square');
        assert.equal(session.renderWorldPhase('building', 0), true);
        assert.equal(host.api.items.get(id).actualWeight, 1.75);
        session.updateWorldPointer(-1.25, 5.5);
        assert.equal(session.renderWorldPhase('opaque', 0), false);
        assert.equal(session.renderWorldPhase('building', 0), false);
        assert.equal(host.api.items.get(id).actualWeight, 1.75);
        session.updateWorldPointer(5.25, 5.5);
        session.activatePackage({
            id: 'world-phase-fault', nativeId: 'WorldPhaseFault', api: host.api,
            sources: [{
                path: 'media/lua/client/world-phase-fault/main.lua',
                source: 'Events.RenderOpaqueObjectsInWorld.Add(function() error(\'actual world-phase callback fault\') end)',
            }],
        });
        assert.throws(() => session.renderWorldPhase('opaque', 0), (cause) => cause.name === 'NativeLuaError'
            && cause.modId === 'world-phase-fault' && cause.nativeModId === 'WorldPhaseFault'
            && cause.path === 'media/lua/client/world-phase-fault/main.lua' && /actual world-phase callback fault/u.test(cause.message));
        assert.equal(host.api.items.get(id).actualWeight, 1.875, 'a later callback fault does not pretend to undo an earlier native commit');
    } finally {
        session.close({ discardSaveData: true });
        host.dispose();
    }
});

test('source world menu collects all 25 live native items without serializing whole stores per lookup', async () => {
    const ui = sourceMenuUI(640);
    const { engine, host, session, saved } = await fixture({
        ui, sourceWorldContext: {
            rooms: [], buildings: [],
            /**
             * Supply the consumer's fixed supported zoom.
             *
             * @returns {number} Fixture zoom.
             */
            getZoom: () => 1,
            /**
             * Project the consumer items onto its context point.
             *
             * @returns {{x: number, y: number}} Fixture screen point.
             */
            objectScreenPosition: () => ({ x: 320, y: 320 }),
            /**
             * Resolve the consumer's clicked native square.
             *
             * @returns {{x: number, y: number}} Fixture world point.
             */
            screenToIso: () => ({ x: 5.5, y: 5.5 }),
        },
    });

    try {
        importPickupSquares(engine);
        engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.Screen', weight: 0.1 }, { owner: 'fixture' });
        const prior = host.api.items.spawn({ fullType: 'Fixture.Screen', x: 5.5, y: 5.5 }).snapshot.id;

        host.api.items.pickup(prior);
        completeActions(engine);
        const ids = Array.from({ length: 25 }, () => host.api.items.spawn({ fullType: 'Fixture.Screen', x: 5.5, y: 5.5 }).snapshot.id);
        const api = {
            ...host.coreApi, items: {
                ...host.coreApi.items,
                /**
                 * Refuse accidental complete-store serialization.
                 *
                 * @returns {never} Always rejects this forbidden query.
                 */
                list: () => {
                    throw new Error('source world lists must read live native indexes, not whole item stores');
                },
            },
            world: {
                ...host.coreApi.world,
                /**
                 * Refuse accidental complete-door-store serialization.
                 *
                 * @returns {never} Always rejects this forbidden query.
                 */
                getDoors: () => {
                    throw new Error('source square lists must read live native indexes, not whole door stores');
                },
            },
        };

        engine.sourceActions.setContextResolver(host.sourcePreflight);
        session.activatePackage({
            id: 'pz-base-game', nativeId: 'ProjectZomboid', api,
            sources: [{
                path: 'media/lua/client/source-live-items/main.lua', source: `${SOURCE_GROUP_FIXTURE + SOURCE_MENU_FIXTURE}
                    local square=getPlayer():getSquare()
                    LiveWorldItems=square:getWorldObjects()
                    LiveSquareObjects=square:getObjects()
                    assert(type(LiveWorldItems)=='userdata' and LiveWorldItems:size()==25)
                    assert(LiveSquareObjects:size()==25)
                    assert(LiveWorldItems==square:getWorldObjects() and LiveSquareObjects==square:getObjects())
                    local objects={}
                    for index=0,LiveSquareObjects:size()-1 do objects[#objects+1]=LiveSquareObjects:get(index) end
                    assert(#objects==25 and objects[1]==LiveWorldItems:get(0))
                    assert(not pcall(function() LiveWorldItems:get(25) end))
                    assert(not pcall(function() LiveWorldItems:get(-1) end))
                    local widget=ISContextMenu:new()
                    ISWorldObjectContextMenu.fetchSquares={}
                    for _,value in ipairs(objects) do ISWorldObjectContextMenuLogic.fetch({},value,0,true) end
                    ISWorldObjectContextMenuLogic.createMenuEntries({},widget,0,objects,320,320,false)
                    local group=widget:getSubMenu(widget.options[1].subOption)
                    assert(group.options[1].name=='Screen item (25)')
                    local choices=group:getSubMenu(group.options[1].subOption)
                    assert(choices.options[1].name=='One' and choices.options[2].name=='Half' and choices.options[3].name=='All')
                    getModData().LiveGroundIds={}
                    for _,value in ipairs(choices.options[3].param1) do
                        table.insert(getModData().LiveGroundIds,value:getItem():getID())
                    end
                    choices.mouseOver=choices.options[3].id
                    __pz_context_call(choices,'onMouseUp',1,1)
                `,
            }],
        });
        session.flushSaveData();
        assert.deepEqual(saved.get('pz-base-game').data.nativePlayerData.LiveGroundIds, ids);
        const queue = engine.actions.getState();

        assert.deepEqual([queue.current, ...queue.pending].flatMap((action) => action.groups.flatMap((group) => group.itemIds)), ids);
        completeLuaActions(engine, host, session);
        await loadSource(session, host, `
            assert(LiveWorldItems:isEmpty() and LiveSquareObjects:isEmpty())
            assert(not pcall(function() LiveWorldItems:get(0) end))
        `, 'source-live-items-empty');
        assert.equal(host.api.items.get(prior).ownerContainerId, host.api.items.playerInventoryId());
        assert.ok(ids.every((id) => host.api.items.get(id).ownerContainerId === host.api.items.playerInventoryId()));
    } finally {
        session.close();
        host.dispose();
        ui.dispose();
    }
});

for (const size of [1_280, 640]) {
    test(`source menu selects native object screen distance, boundary and Half prefix at content size ${size}`, async () => {
        const ui = sourceMenuUI(size);
        const canvas = {
            width: size * 2, height: size * 2, clientWidth: size, clientHeight: size,
            clientLeft: 3, clientTop: 5, offsetWidth: size + 8, offsetHeight: size + 12,
            /**
             * Return the scaled canvas border box used by the content-coordinate conversion.
             *
             * @returns {{left:number,top:number,width:number,height:number}} Canvas client bounds.
             */
            getBoundingClientRect: () => ({ left: 19, top: 29, width: (size + 8) * 1.5, height: (size + 12) * 2 }),
        };
        const content = canvasContentBox(canvas);
        const camera = { x: 5, y: 5 };
        const pixels = Math.min(canvas.width, canvas.height) / 10;
        const zoom = 128 / (pixels / 2);
        /**
         * Project a world point into the canvas content coordinates consumed by Lua.
         *
         * @param {{x:number,y:number}} point - World position to project.
         * @returns {{x:number,y:number}} Canvas content position.
         */
        const projection = (point) => {
            const position = tileScreenPosition(point, camera, pixels);

            return {
                x: (canvas.width / 2 + position.x) * content.width / canvas.width,
                y: (canvas.height / 2 + position.y) * content.height / canvas.height,
            };
        };

        const { engine, host, session, saved } = await fixture({
            ui, sourceWorldContext: {
                rooms: [], buildings: [],
                /**
                 * Return the scenario zoom for the single supported player.
                 *
                 * @param {number} index - Native player index, required to be zero.
                 * @returns {number} Scenario camera zoom.
                 */
                getZoom: (index) => {
                    assert.equal(index, 0);

                    return zoom;
                },
                objectScreenPosition: projection,
                /**
                 * Convert canvas content coordinates back into world coordinates.
                 *
                 * @param {number} x - Canvas content horizontal position.
                 * @param {number} y - Canvas content vertical position.
                 * @param {number} z - World floor to retain.
                 * @returns {{x:number,y:number,z:number}} World position.
                 */
                screenToIso: (x, y, z) => ({
                    x: camera.x + (x - size / 2) / (pixels / 2) + 2 * (y - size / 2) / (pixels / 2),
                    y: camera.y - (x - size / 2) / (pixels / 2) + 2 * (y - size / 2) / (pixels / 2), z,
                }),
            },
        });

        try {
            importPickupSquares(engine);
            engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.Screen', weight: 0.1 }, { owner: 'fixture' });
            const positions = [{ x: 5.7, y: 5.7 }, { x: 5.75, y: 5.75 }, { x: 5.4, y: 4.6 }, { x: 5.35, y: 4.65 }];
            const ids = positions.map((point) => host.api.items.spawn({ fullType: 'Fixture.Screen', ...point }).snapshot.id);

            engine.sourceActions.setContextResolver(host.sourcePreflight);
            session.attachSourceActions(engine.sourceActions, engine.sourceTiming);
            session.activatePackage({
                id: 'pz-base-game', nativeId: 'ProjectZomboid', api: host.coreApi,
                sources: [{
                    path: 'media/lua/client/source-screen/main.lua', source: `${SOURCE_GROUP_FIXTURE + SOURCE_MENU_FIXTURE}
                    local widget=ISContextMenu:new()
                    local objects=getPlayer():getSquare():getWorldObjects()
                    ISWorldObjectContextMenuLogic.createMenuEntries({},widget,0,{objects:get(0)},${size / 2},${size / 2},false)
                    assert(widget.options[1].name=='Grab')
                    local group=widget:getSubMenu(widget.options[1].subOption)
                    assert(group.options[1].name=='Screen item (3)')
                    local choices=group:getSubMenu(group.options[1].subOption)
                    local selected=choices.options[2]
                    assert(selected.name=='Half')
                    getModData().ScreenConsumer={ids={}}
                    for _,value in ipairs(selected.param1) do
                        table.insert(getModData().ScreenConsumer.ids,value:getItem():getID())
                    end
                    choices.mouseOver=selected.id
                    __pz_context_call(choices,'onMouseUp',1,1)
                `,
                }],
            });
            session.flushSaveData();
            assert.deepEqual(saved.get('pz-base-game').data.nativePlayerData.ScreenConsumer.ids, [ids[0], ids[1], ids[3]]);
            assert.deepEqual(engine.actions.getState().current.groups[0].itemIds, [ids[0], ids[1]]);
            assert.notEqual(host.api.items.get(ids[2]).worldPosition, null);
        } finally {
            session.close();
            host.dispose();
            ui.dispose();
        }
    });
}

const SOURCE_DOOR_FIXTURE = `
    function QueueModelComplete(action)
        local queue=ISTimedActionQueue.getTimedActionQueue(action.character)
        table.remove(queue.queue,1)
        queue.current=queue.queue[1]
        if queue.current then queue.current:begin() end
    end
    ISOpenCloseDoor=setmetatable({Type='ISOpenCloseDoor'},{__index=ISBaseTimedAction})
    ISOpenCloseDoor.__index=ISOpenCloseDoor
    function ISOpenCloseDoor:new(character,value)
        return setmetatable({character=character,item=value,maxTime=0,
            stopOnWalk=false,stopOnRun=false,stopOnAim=false},self)
    end
    function ISOpenCloseDoor:isValid() return self.item:getSquare()~=nil end
    function ISOpenCloseDoor:complete() self.item:ToggleDoor(self.character);return true end
    function ISOpenCloseDoor:perform() QueueModelComplete(self) end
    ISWaitWhileGettingUp=setmetatable({Type='ISWaitWhileGettingUp'},{__index=ISBaseTimedAction})
    ISWaitWhileGettingUp.__index=ISWaitWhileGettingUp
    function ISWaitWhileGettingUp:new(character)
        return setmetatable({character=character,maxTime=-1,stopOnWalk=false,stopOnRun=false,stopOnAim=false},self)
    end
    function ISWaitWhileGettingUp:isValid() return self.character==getPlayer() end
    function ISWaitWhileGettingUp:start() assert(not self.character:isSitting());self.action:forceComplete() end
    function ISWaitWhileGettingUp:perform()
        QueueModelComplete(self)
        local args=self.onCompleteArgs
        self.onCompleteFunc(args.p1,args.p2,args.p3)
    end
    function ISWaitWhileGettingUp:setOnComplete(fn,objects,value,index)
        self.onCompleteFunc=fn
        self.onCompleteArgs={p1=objects,p2=value,p3=index}
    end
    function ISWorldObjectContextMenu.onOpenCloseDoor(objects,value,index)
        assert(index==0)
        -- Match genuine CancelAction: StopAllActionQueue precedes clearing the source view.
        getPlayer():StopAllActionQueue()
        ISTimedActionQueue.getTimedActionQueue(getPlayer()):resetQueue()
        ISTimedActionQueue.add(ISOpenCloseDoor:new(getPlayer(),value))
    end
    __pz_source_loaded()
`;

/**
 * Source-backed synthetic geometry around the real test actor, not inferred room facts.
 *
 * @param {boolean} outside - Actual actor-square outside field for this scenario.
 * @returns {object[]} Explicit native square import.
 */
function sourceDoorSquares(outside) {
    const squares = [];

    const actorRoomId = outside ? -1 : 2;

    for (let y = 3; y <= 7; y += 1) {
        for (let x = 3; x <= 7; x += 1) {
            squares.push({
                x, y, z: 0, roomId: x === 5 && y === 5 ? actorRoomId : 1,
                outside: x === 5 && y === 5 ? outside : false, solid: false, solidTrans: false,
                solidFloor: true, tree: false, independentWalls: 0, reachWalls: { north: false, west: false },
                vehicleObstructed: false,
            });
        }
    }

    return squares;
}

/**
 * Ordinary source door with explicit unsupported branches absent.
 *
 * @param {object} [extra] - Real native scenario overrides.
 * @returns {object} Native import record.
 */
function sourceMenuDoor(extra = {}) {
    return {
        id: 'door:6:5:0:1', x: 6, y: 5, z: 0, north: false, open: false,
        locked: true, lockedByKey: false, forceLocked: false, keyId: -1, roomId: 1, oppositeRoomId: 2,
        attachedE: false, attachedS: false, barricaded: false, independentWalls: 0,
        reachWalls: Array.from({ length: 4 }, () => ({ north: false, west: false })),
        doubleDoor: 0, garageDoor: 0, interiorSide: false, curtainCapabilities: [false, false, false, false], ...extra,
    };
}

test('saved get-up door continuations load their menu only after lifecycle and bind the exact active owner without ticking', async () => {
    const original = await fixture();
    const candidate = await fixture();

    try {
        for (const value of [original, candidate]) {
            value.engine.importDoors([sourceMenuDoor({ locked: false })], { squares: sourceDoorSquares(false) });
        }

        await loadSource(original.session, original.host, `${SOURCE_GROUP_FIXTURE + SOURCE_MENU_FIXTURE + SOURCE_DOOR_FIXTURE}
            local value=getCell():getGridSquare(6,5,0):getObjects():get(0)
            local action=ISWaitWhileGettingUp:new(getPlayer())
            action:setOnComplete(ISWorldObjectContextMenu.onOpenCloseDoor,{value},value,0)
            ISTimedActionQueue.add(action)
        `, 'saved-door-owner');
        const bytes = original.engine.saveQueueState();
        const owners = original.session.exportSourceOwners();

        candidate.engine.loadQueueState(bytes);
        const before = candidate.engine.actions.getState();

        candidate.session.preload({
            id: 'engine-fixture', nativeId: 'FixtureEngine', engineSource: true,
            sources: [
                { path: 'media/lua/client/QueueModelClasses.lua', source: SOURCE_GROUP_FIXTURE + SOURCE_MENU_FIXTURE + SOURCE_DOOR_FIXTURE },
                ...['ISTimedActionQueue', 'ISGrabItemAction', 'ISOpenCloseDoor', 'WalkToTimedAction', 'ISWaitWhileGettingUp']
                    .map((name) => ({ path: `media/lua/client/TimedActions/${name}.lua`, source: `return ${name === 'WalkToTimedAction' ? 'ISWalkToTimedAction' : name}` })),
                {
                    path: 'media/lua/client/ISUI/ISWorldObjectContextMenu.lua', source: `
                        getModData().DeferredMenuLoads=(getModData().DeferredMenuLoads or 0)+1
                        Events.OnCreatePlayer.Add(function() error('full inventory UI was registered before lifecycle') end)
                        return ISWorldObjectContextMenu
                    `,
                },
            ],
        });
        candidate.session.preload({ id: 'saved-door-owner', nativeId: 'saved-door-owner', sources: [] });
        candidate.session.activatePackage({
            id: 'pz-base-game', nativeId: 'ProjectZomboid', api: candidate.host.coreApi,
            sources: [{ path: 'media/lua/client/pz-base-game/main.lua', source: 'require "QueueModelClasses"' }],
        });
        candidate.session.restoreSourceActions(before, owners, [
            { id: 'pz-base-game', nativeId: 'ProjectZomboid' },
            { id: 'saved-door-owner', nativeId: 'saved-door-owner' },
        ]);
        candidate.session.dispatch('OnLoad');
        candidate.session.dispatch('OnCreatePlayer', 0);
        candidate.session.dispatch('OnGameStart');
        assert.deepEqual(candidate.engine.actions.getState(), before);
        assert.throws(() => candidate.engine.saveQueueState(), /continuation is not bound/u);
        assert.throws(() => candidate.session.completeSourceRestore(), /not active|missing|disabled/u);
        assert.deepEqual(candidate.engine.actions.getState(), before, 'failed candidate finalization must not clear the retained native queue');
        assert.deepEqual(original.engine.saveQueueState(), bytes, 'the prior live queue and saved bytes remain untouched');
        await loadPackage(candidate.session, candidate.host, { id: 'saved-door-owner', nativeId: 'saved-door-owner', sources: [] });
        candidate.session.completeSourceRestore();
        candidate.session.completeSourceRestore();
        assert.deepEqual(candidate.engine.actions.getState(), before, 'successful finalization binds closures without ticking or resetting resident tables');
        assert.deepEqual(candidate.session.exportSourceOwners(), owners);
        candidate.session.flushSaveData();
        assert.equal(candidate.saved.get('pz-base-game').data.nativePlayerData.DeferredMenuLoads, 1);
        completeLuaActions(candidate.engine, candidate.host, candidate.session);
        assert.equal(candidate.engine.doors()[0].open, true);
        assert.deepEqual(candidate.engine.actions.getState(), { current: null, pending: [] });
    } finally {
        original.session.close({ discardSaveData: true });
        original.host.dispose();
        candidate.session.close({ discardSaveData: true });
        candidate.host.dispose();
    }
});

test('source get-up completion retains its detached native STOP until the door continuation begins', async () => {
    const { engine, host, session, saved } = await fixture();
    const door = sourceMenuDoor({ locked: false });

    try {
        engine.importDoors([door], { squares: sourceDoorSquares(false) });
        session.attachSourceActions(engine.sourceActions, engine.sourceTiming);
        activate(session, host, `${SOURCE_GROUP_FIXTURE + SOURCE_MENU_FIXTURE + SOURCE_DOOR_FIXTURE}
            local values=getCell():getGridSquare(6,5,0):getObjects()
            local value=values:get(0)
            local action=ISWaitWhileGettingUp:new(getPlayer())
            action:setOnComplete(ISWorldObjectContextMenu.onOpenCloseDoor,{value},value,0)
            ISTimedActionQueue.add(action)
        `, 'detached-source-stop');
        const getUp = engine.actions.getState().current;

        assert.equal(getUp.kind, 'getUp');
        assert.equal(engine.sourceActions.actionExists(getUp.id), true);
        host.frameStep(1 / 60);
        engine.sourceActions.dispatch(session.dispatchSourceAction);
        const continuation = engine.actions.getState().current;

        assert.equal(continuation.kind, 'door');
        assert.equal(continuation.origin, 'lua');
        assert.equal(continuation.currentTime, 0);
        assert.equal(engine.sourceActions.actionExists(getUp.id), false);
        completeLuaActions(engine, host, session);
        session.flushSaveData();
        assert.equal(saved.get('host').data.nativePlayerData.QueueModel.stops, 1);
        assert.equal(host.api.world.getDoors()[0].open, true);
        assert.deepEqual(engine.actions.getState(), { current: null, pending: [] });
        assert.deepEqual(session.diagnostics().errors, []);
    } finally {
        session.close();
        host.dispose();
    }
});

for (const scenario of [
    { name: 'inside ordinary lock', outside: false, changes: {}, available: true, completes: true },
    { name: 'outside ordinary lock', outside: true, changes: {}, available: true, completes: false },
    { name: 'inside force lock', outside: false, changes: { forceLocked: true }, available: true, completes: false },
    { name: 'barricade', outside: false, changes: { barricaded: true }, available: false, completes: false },
    { name: 'outside obstruction', outside: true, changes: {}, obstructed: true, available: false, completes: false },
    { name: 'inside obstruction precedes stricter commit', outside: false, changes: {}, obstructed: true, available: true, completes: false },
]) {
    test(`source door menu uses native couldBeOpen, distinct from completion: ${scenario.name}`, async () => {
        const ui = sourceMenuUI(640);
        const { engine, host, session, saved } = await fixture({
            ui, sourceWorldContext: {
                rooms: [{ id: 1, name: 'One', buildingId: null }, { id: 2, name: 'Two', buildingId: null }],
                buildings: [],
                /**
                 * Return the door scenario's fixed camera zoom.
                 *
                 * @returns {number} Scenario camera zoom.
                 */
                getZoom: () => 2,
                /**
                 * Project a world point relative to the scenario actor.
                 *
                 * @param {{x:number,y:number}} point - World position to project.
                 * @returns {{x:number,y:number}} Actor-relative screen position.
                 */
                objectScreenPosition: (point) => tileScreenPosition(point, { x: 5, y: 5 }, 64),
                /**
                 * Resolve menu screen input to the scenario actor's square.
                 *
                 * @returns {{x:number,y:number}} Actor world position.
                 */
                screenToIso: () => ({ x: 5, y: 5 }),
                /**
                 * Supply the explicit unbound interaction key name for this scenario.
                 *
                 * @returns {string} Unbound key label.
                 */
                interactKeyName: () => 'NONE',
            },
        });

        try {
            const door = sourceMenuDoor(scenario.changes);

            const squares = sourceDoorSquares(scenario.outside);

            if (scenario.obstructed) {
                squares.find((square) => square.x === 6 && square.y === 5).vehicleObstructed = true;
            }

            engine.importDoors([door], { squares });
            engine.sourceActions.setContextResolver(host.sourcePreflight);
            session.attachSourceActions(engine.sourceActions, engine.sourceTiming);
            session.activatePackage({
                id: 'pz-base-game', nativeId: 'ProjectZomboid', api: host.coreApi,
                sources: [{
                    path: 'media/lua/client/source-door/main.lua', source: `${SOURCE_GROUP_FIXTURE + SOURCE_MENU_FIXTURE + SOURCE_DOOR_FIXTURE}
                    local values=getCell():getGridSquare(6,5,0):getObjects()
                    local door=values:get(0)
                    local widget=ISContextMenu:new()
                    ISWorldObjectContextMenuLogic.createMenuEntries({door=door},widget,0,{door},320,320,false)
                    local submenu=widget:getSubMenu(widget.options[1].subOption)
                    local option=submenu.options[1]
                    getModData().DoorConsumer={available=not option.notAvailable,name=option.name}
                    assert(option.param1==ISWorldObjectContextMenu.onOpenCloseDoor)
                    submenu.mouseOver=option.id
                    __pz_context_call(submenu,'onMouseUp',1,1)
                `,
                }],
            });
            session.flushSaveData();
            assert.deepEqual(saved.get('pz-base-game').data.nativePlayerData.DoorConsumer,
                { available: scenario.available, name: 'Open' });

            if (scenario.available) {
                const queued = engine.actions.getState();

                assert.equal(queued.current.kind, 'getUp');
                assert.equal(queued.current.origin, 'lua');
                assert.equal(queued.current.target.id, door.id);
                assert.deepEqual(queued.pending, []);
                assert.ok(engine.saveQueueState().length > 0, 'named source door continuation must be portable');
                host.frameStep(1 / 60);
                engine.sourceActions.dispatch(session.dispatchSourceAction);
                const continuation = engine.actions.getState();

                assert.equal(continuation.current.kind, 'door');
                assert.equal(continuation.current.origin, 'lua');
                assert.deepEqual(continuation.current.target, { id: door.id, x: door.x, y: door.y, z: door.z });
                assert.equal(continuation.current.currentTime, 0, 'door successor must not tick in its get-up completion frame');
            }

            if (scenario.available && scenario.completes) {
                completeLuaActions(engine, host, session);
            } else if (scenario.available) {
                assert.throws(() => completeLuaActions(engine, host, session), /commitDoor/u);
            }

            assert.equal(engine.doors()[0].open, scenario.completes);

            if (!scenario.available) {
                assert.deepEqual(engine.actions.getState(), { current: null, pending: [] });
            }
        } finally {
            session.close();
            host.dispose();
            ui.dispose();
        }
    });
}

for (const kind of ['walk', 'door']) {
    for (const sdkFirst of [true, false]) {
        test(`distinct ${kind}/source Grab preserves genuine BEGIN once and successor frame boundary, SDK first=${sdkFirst}`, async () => {
            const { engine, host, session, saved } = await fixture();

            try {
                engine.importDoors([sourceMenuDoor({ locked: false })], { squares: sourceDoorSquares(false) });
                engine.command({ type: 'setCharacterStat', name: 'unhappiness', value: 80 });
                assert.equal(engine.moodles().find((row) => row.id === 'base:unhappy').level, 3);
                engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.Begin', weight: 0.1 }, { owner: 'fixture' });
                const id = host.api.items.spawn({ fullType: 'Fixture.Begin', x: 5.25, y: 5.25 }).snapshot.id;

                session.attachSourceActions(engine.sourceActions, engine.sourceTiming);
                await loadSource(session, host, SOURCE_GROUP_FIXTURE + SOURCE_MENU_FIXTURE + SOURCE_DOOR_FIXTURE, 'source-begin-model');
                /**
                 * Request the scenario's distinct SDK action before or after the source action.
                 *
                 * @returns {import('../types/mod-api').ModQueueAcceptance} Native queue acceptance.
                 */
                const request = () => kind === 'walk'
                    ? host.api.actions.requestWalk({ x: 4, y: 5, z: 0 })
                    : host.api.actions.requestDoor('door:6:5:0:1');

                if (sdkFirst) {
                    request();
                }

                await loadSource(session, host, `QueueModelGrab(${id},20)`, 'source-begin-owner');

                if (!sdkFirst) {
                    request();
                }

                const initial = engine.actions.getState();
                const source = [initial.current, ...initial.pending].find((row) => row.origin === 'lua');

                assert.ok(source && initial.pending.length > 0, 'distinct non-Grab must separate commit owners');

                if (sdkFirst) {
                    let promoted;

                    for (let frame = 0; frame < 1_000; frame += 1) {
                        host.frameStep(1 / 60);
                        engine.sourceActions.dispatch(session.dispatchSourceAction);
                        const current = engine.actions.getState().current;

                        if (current?.id === source.id) {
                            promoted = current;
                            break;
                        }
                    }

                    assert.ok(promoted, 'native SDK completion must hand off the genuine source head');
                    assert.equal(promoted.maxTime, 35);
                    assert.equal(engine.sourceActions.sourceTime(source.id), 35);
                    assert.equal(promoted.currentTime, 0, 'successor has no update in its predecessor completion frame');
                    assert.equal(promoted.delta, 0);
                } else {
                    assert.equal(source.maxTime, 35);
                    assert.equal(engine.sourceActions.sourceTime(source.id), 35);
                }

                session.flushSaveData();
                assert.equal(saved.get('source-begin-model').data.nativePlayerData.QueueModel.adjustments, 1);
                completeLuaActions(engine, host, session);
                session.flushSaveData();
                assert.equal(saved.get('source-begin-model').data.nativePlayerData.QueueModel.adjustments, 1);
                assert.equal(host.api.items.get(id).ownerContainerId, host.api.items.playerInventoryId());
                assert.deepEqual(engine.actions.getState(), { current: null, pending: [] });
            } finally {
                session.close();
                host.dispose();
            }
        });
    }
}

test('source door menu refuses unsupported keyed authority before any get-up or action helper', async () => {
    const ui = sourceMenuUI(640);
    const { engine, host, session } = await fixture({
        ui, sourceWorldContext: {
            rooms: [{ id: 1, name: 'One', buildingId: null }, { id: 2, name: 'Two', buildingId: null }], buildings: [],
            /**
             * Return the keyed-door scenario's fixed camera zoom.
             *
             * @returns {number} Scenario camera zoom.
             */
            getZoom: () => 2,
            /**
             * Resolve menu screen input to the scenario actor's square.
             *
             * @returns {{x:number,y:number}} Actor world position.
             */
            screenToIso: () => ({ x: 5, y: 5 }),
            /**
             * Project a world point relative to the scenario actor.
             *
             * @param {{x:number,y:number}} point - World position to project.
             * @returns {{x:number,y:number}} Actor-relative screen position.
             */
            objectScreenPosition: (point) => tileScreenPosition(point, { x: 5, y: 5 }, 64),
        },
    });

    try {
        engine.importDoors([sourceMenuDoor({ keyId: 77, lockedByKey: true })], { squares: sourceDoorSquares(true) });
        session.attachSourceActions(engine.sourceActions, engine.sourceTiming);
        assert.throws(() => session.activatePackage({
            id: 'pz-base-game', nativeId: 'ProjectZomboid', api: host.coreApi,
            sources: [{
                path: 'media/lua/client/source-keyed/main.lua', source: `${SOURCE_GROUP_FIXTURE + SOURCE_MENU_FIXTURE + SOURCE_DOOR_FIXTURE}
                local door=getCell():getGridSquare(6,5,0):getObjects():get(0)
                ISWorldObjectContextMenuLogic.createMenuEntries({door=door},ISContextMenu:new(),0,{door},320,320,false)
            `,
            }],
        }), /unsupported original keyed-door/u);
        assert.equal(engine.doors()[0].open, false);
        assert.deepEqual(engine.actions.getState(), { current: null, pending: [] });
    } finally {
        session.close();
        host.dispose();
        ui.dispose();
    }
});

for (const throughMenu of [false, true]) {
    test(`initial source Grab rejection performs genuine stop/reset/job cleanup once, menu=${throughMenu}`, async () => {
        const ui = sourceMenuUI(640);
        const { engine, host, session, saved } = await fixture({
            ui, sourceWorldContext: {
                rooms: [], buildings: [],
                /**
                 * Return the initial-rejection scenario's fixed camera zoom.
                 *
                 * @returns {number} Scenario camera zoom.
                 */
                getZoom: () => 2,
                /**
                 * Resolve menu screen input to the scenario actor's square.
                 *
                 * @returns {{x:number,y:number}} Actor world position.
                 */
                screenToIso: () => ({ x: 5, y: 5 }),
                /**
                 * Project a world point into the scenario's centered screen coordinates.
                 *
                 * @param {{x:number,y:number}} point - World position to project.
                 * @returns {{x:number,y:number}} Centered screen position.
                 */
                objectScreenPosition: (point) => {
                    const position = tileScreenPosition(point, { x: 5, y: 5 }, 64);

                    return { x: 320 + position.x, y: 320 + position.y };
                },
            },
        });

        try {
            importPickupSquares(engine);
            engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.Filled', weight: 49 }, { owner: 'fixture' });
            engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.Screen', weight: 2 }, { owner: 'fixture' });
            const filler = host.api.items.spawn({ fullType: 'Fixture.Filled', x: 5, y: 5 }).snapshot.id;

            host.api.items.pickup(filler);
            completeActions(engine);
            const target = host.api.items.spawn({ fullType: 'Fixture.Screen', x: 5, y: 5 }).snapshot.id;

            engine.sourceActions.setContextResolver(host.sourcePreflight);
            session.attachSourceActions(engine.sourceActions, engine.sourceTiming);
            session.activatePackage({
                id: 'pz-base-game', nativeId: 'ProjectZomboid', api: host.coreApi,
                sources: [{
                    path: 'media/lua/client/source-initial-invalid/main.lua', source: `${SOURCE_GROUP_FIXTURE + SOURCE_MENU_FIXTURE}
                    local item=QueueModelWorld(${target})
                    item:getItem():setJobDelta(0.5)
                    getPlayer():setIsFarming(true)
                    ${throughMenu
                        ? `
                        local widget=ISContextMenu:new()
                        ISWorldObjectContextMenuLogic.createMenuEntries({},widget,0,{item},320,320,false)
                        local choices=widget:getSubMenu(widget.options[1].subOption)
                        choices.mouseOver=choices.options[1].id
                        __pz_context_call(choices,'onMouseUp',1,1)
                    `
                        : `QueueModelGrab(${target},20)`}
                    assert(item:getItem():getJobDelta()==0)
                    assert(not getPlayer():isFarming())
                    assert(#ISTimedActionQueue.getTimedActionQueue(getPlayer()).queue==0)
                `,
                }],
            });
            session.flushSaveData();
            const stats = saved.get('pz-base-game').data.nativePlayerData.QueueModel;

            assert.equal(stats.starts, 0);
            assert.equal(stats.performs, 0);
            assert.equal(stats.stops, 1);
            assert.equal(stats.resets, 1);
            assert.equal(stats.jobStops, 1);
            assert.notEqual(host.api.items.get(target).worldPosition, null);
            assert.equal(host.api.items.get(filler).ownerContainerId, host.api.items.playerInventoryId());
            assert.equal(engine.sourceActions.eventRead(), null);
            assert.deepEqual(engine.actions.getState(), { current: null, pending: [] });
        } finally {
            session.close();
            host.dispose();
            ui.dispose();
        }
    });
}

test('synchronous source clear completes old stop and pending cancellations before fresh owned startup', async () => {
    const { engine, host, session, saved } = await fixture();

    try {
        importPickupSquares(engine);
        engine.command({ type: 'setCharacterStat', name: 'unhappiness', value: 80 });
        engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.Restart', weight: 0.1 }, { owner: 'fixture' });
        const ids = Array.from({ length: 3 }, () => host.api.items.spawn({ fullType: 'Fixture.Restart', x: 5, y: 5 }).snapshot.id);

        session.attachSourceActions(engine.sourceActions, engine.sourceTiming);
        activate(session, host, `${SOURCE_GROUP_FIXTURE}
            getModData().RestartConsumer={oldStops=0}
            RestartOld=QueueModelGrab(${ids[0]},200)
            ISTimedActionQueue.add(ISWalkToTimedAction:new(getPlayer(),getCell():getGridSquare(4,4,0)))
            QueueModelGrab(${ids[1]},200)
            function RestartOld:stop()
                getModData().RestartConsumer.oldStops=getModData().RestartConsumer.oldStops+1
                ISGrabItemAction.stop(self)
                RestartFresh=QueueModelGrab(${ids[2]},20)
            end
            table.wipe(ISTimedActionQueue.getTimedActionQueue(getPlayer()).queue)
            local queue=ISTimedActionQueue.getTimedActionQueue(getPlayer())
            assert(#queue.queue==1 and queue.queue[1]==RestartFresh and queue.current==RestartFresh)
            assert(RestartFresh.action:isStarted())
            assert(RestartFresh.action:getJobDelta()==0)
        `, 'source-restart-owner');
        const current = engine.actions.getState().current;

        assert.equal(current.origin, 'lua');
        assert.equal(current.target.id, ids[2]);
        assert.equal(current.maxTime, 35);
        assert.equal(engine.sourceActions.sourceTime(current.id), 35);
        assert.equal(current.currentTime, 0);
        assert.equal(current.delta, 0);
        assert.deepEqual(session.exportSourceOwners(), [{ actionId: current.id, ownerId: 'source-restart-owner' }]);
        assert.equal(engine.sourceActions.eventRead(), null);
        session.flushSaveData();
        const stats = saved.get('host').data.nativePlayerData.QueueModel;

        assert.equal(stats.starts, 2);
        assert.equal(stats.adjustments, 2);
        assert.equal(stats.stops, 1);
        assert.equal(stats.resets, 1);
        assert.equal(stats.jobStops, 1);
        assert.equal(stats.cancelled, 2);
        assert.equal(saved.get('host').data.nativePlayerData.RestartConsumer.oldStops, 1);
        completeLuaActions(engine, host, session);
        assert.notEqual(host.api.items.get(ids[0]).worldPosition, null);
        assert.notEqual(host.api.items.get(ids[1]).worldPosition, null);
        assert.equal(host.api.items.get(ids[2]).ownerContainerId, host.api.items.playerInventoryId());
    } finally {
        session.close();
        host.dispose();
    }
});

for (const failedActivation of [false, true]) {
    test(`owner withdrawal refuses stop-time fresh source admission and retires native ownership, activationFailed=${failedActivation}`, async () => {
        const { engine, host, session, saved } = await fixture();
        const ownerId = `source-withdraw-${failedActivation}`;

        try {
            importPickupSquares(engine);
            engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.Withdraw', weight: 0.1 }, { owner: 'fixture' });
            const ids = Array.from({ length: 3 }, () => host.api.items.spawn({ fullType: 'Fixture.Withdraw', x: 5, y: 5 }).snapshot.id);

            session.attachSourceActions(engine.sourceActions, engine.sourceTiming);
            session.activatePackage({
                id: 'pz-base-game', nativeId: 'ProjectZomboid', api: host.coreApi,
                sources: [{
                    path: 'media/lua/client/source-withdraw-core/main.lua', source: `${SOURCE_GROUP_FIXTURE}
                    getModData().WithdrawalStats={oldStops=0,oldHooks=0,coreTicks=0,constructorDenials=0}
                    Events.OnTick.Add(function()
                        local data=getModData()
                        assert(data.WithdrawalStopJSON==nil and data.WithdrawalStopCycle==nil)
                        assert(data.WithdrawalCancelJSON==nil and data.WithdrawalCancelFunction==nil)
                        assert(data.WithdrawalReclaim==nil and data.WithdrawalSaveBad==nil)
                        data.WithdrawalStats.coreTicks=data.WithdrawalStats.coreTicks+1
                    end)
                `,
                }],
            });
            const descriptor = {
                id: ownerId, nativeId: 'WithdrawalNative', sources: [{
                    path: 'media/lua/client/source-withdraw-user/main.lua',
                    source: `
                    WithdrawalOld=QueueModelGrab(${ids[0]},200)
                    ISTimedActionQueue.add(ISWalkToTimedAction:new(getPlayer(),getCell():getGridSquare(4,4,0)))
                    WithdrawalPending=QueueModelGrab(${ids[1]},200)
                    function WithdrawalPending:forceCancel()
                        ISBaseTimedAction.forceCancel(self)
                        getModData().WithdrawalCancelJSON={created='forceCancel'}
                        getModData().WithdrawalCancelFunction=function() return 'cleanup-only' end
                        local group=self.queueList[1]
                        local count=#group.items
                        local admitted,denial=pcall(QueueModelGrab,${ids[2]},20)
                        assert(not admitted and tostring(denial):find('source admission denied during owner withdrawal',1,true))
                        assert(#self.queueList==1 and #group.items==count)
                        getModData().WithdrawalStats.constructorDenials=getModData().WithdrawalStats.constructorDenials+1
                    end
                    function WithdrawalOld:stop()
                        getModData().WithdrawalStats.oldStops=getModData().WithdrawalStats.oldStops+1
                        ISGrabItemAction.stop(self)
                        getModData().WithdrawalStopJSON={created='stop'}
                        local cycle={}
                        cycle.self=cycle
                        getModData().WithdrawalStopCycle=cycle
                        getModData().WithdrawalReclaim={created='stop'}
                        WithdrawalFresh=QueueModelGrab(${ids[2]},20)
                    end
                    Events.OnTick.Add(function() getModData().WithdrawalStats.oldHooks=getModData().WithdrawalStats.oldHooks+1 end)
                    getModData().WithdrawalSaveBad=function() return 'save failure before withdrawal' end
                    ${failedActivation ? 'error(\'withdrawal activation rejected\')' : ''}
                `,
                }],
            };

            if (failedActivation) {
                await assert.rejects(loadPackage(session, host, descriptor), (error) => {
                    assert.match(error.message, /withdrawal activation rejected/u);
                    assert.match(error.message, /source admission denied during owner withdrawal/u);
                    assert.equal(error.cause.cause.modId, ownerId);
                    assert.equal(error.cause.errors[1].modId, ownerId);

                    return true;
                });
            } else {
                await loadPackage(session, host, descriptor);
                host.unload(ownerId);
                assert.ok(host.diagnostics().errors.some((error) => error.modId === ownerId && error.stage === 'cleanup'
                    && /source admission denied during owner withdrawal/u.test(error.message)));
                assert.ok(session.diagnostics().errors.some((error) => error.modId === ownerId && /native modData must be acyclic JSON/u.test(error.message)));
            }

            assert.ok(session.diagnostics().errors.some((error) => error.modId === ownerId && error.nativeModId === 'WithdrawalNative'
                && error.path === 'media/lua/client/source-withdraw-user/main.lua'
                && /source admission denied during owner withdrawal/u.test(error.message)));
            assert.deepEqual(engine.actions.getState(), { current: null, pending: [] });
            assert.equal(engine.sourceActions.eventRead(), null);
            assert.deepEqual(session.exportSourceOwners(), []);
            assert.equal(host.diagnostics().core.active, true);
            assert.doesNotThrow(() => host.coreApi.movement.getState());
            assert.ok(engine.saveQueueState().length > 0);
            session.flushSaveData();
            const beforeFrame = saved.get('pz-base-game').data.nativePlayerData;

            assert.equal(beforeFrame.WithdrawalStats.oldStops, 1);
            assert.equal(beforeFrame.WithdrawalStats.oldHooks, 0);
            assert.equal(beforeFrame.WithdrawalStats.constructorDenials, 1);
            assert.equal(beforeFrame.QueueModel.starts, 1);
            assert.equal(beforeFrame.QueueModel.stops, 1);
            assert.equal(beforeFrame.QueueModel.resets, 1);
            assert.equal(beforeFrame.QueueModel.jobStops, 1);
            assert.equal(beforeFrame.QueueModel.cancelled, 2);
            const tickErrors = session.diagnostics().errors.length;
            const hostTickErrors = host.diagnostics().errors.length;

            host.step(1 / 60);
            assert.deepEqual(session.diagnostics().errors.slice(tickErrors), []);
            assert.deepEqual(host.diagnostics().errors.slice(hostTickErrors), []);
            session.flushSaveData();
            assert.equal(saved.get('pz-base-game').data.nativePlayerData.WithdrawalStats.coreTicks, 1);
            assert.equal(saved.get('pz-base-game').data.nativePlayerData.WithdrawalStats.oldHooks, 0);
            assert.deepEqual(session.exportSourceOwners(), []);

            for (const id of ids) {
                assert.notEqual(host.api.items.get(id).worldPosition, null);
            }

            await loadPackage(session, host, {
                id: ownerId, nativeId: 'WithdrawalNative',
                sources: [{
                    path: 'media/lua/client/source-withdraw-user/main.lua', source: `
                    local data=getModData()
                    assert(data.WithdrawalStopJSON==nil and data.WithdrawalStopCycle==nil)
                    assert(data.WithdrawalCancelJSON==nil and data.WithdrawalCancelFunction==nil)
                    assert(data.WithdrawalReclaim==nil and data.WithdrawalSaveBad==nil)
                    data.WithdrawalReload={active=true}
                `,
                }],
            });
            session.flushSaveData();
            assert.equal(saved.get(ownerId).data.nativePlayerData.WithdrawalReload.active, true);
            await loadPackage(session, host, {
                id: 'withdraw-key-survivor', sources: [{
                    path: 'media/lua/client/source-withdraw-survivor/main.lua',
                    source: 'getModData().WithdrawalReclaim={claimed=true}',
                }],
            });
            session.flushSaveData();
            assert.equal(saved.get('withdraw-key-survivor').data.nativePlayerData.WithdrawalReclaim.claimed, true);
            assert.equal(saved.get(ownerId).data.nativePlayerData.WithdrawalReclaim, undefined);
        } finally {
            session.close();
            host.dispose();
        }
    });
}

for (const force of ['forceComplete', 'forceStop']) {
    test(`synchronous source startup preserves ${force} for the first eligible logical frame`, async () => {
        const { engine, host, session, saved } = await fixture();

        try {
            importPickupSquares(engine);
            engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.StartForce', weight: 0.1 }, { owner: 'fixture' });
            const id = host.api.items.spawn({ fullType: 'Fixture.StartForce', x: 5, y: 5 }).snapshot.id;

            session.attachSourceActions(engine.sourceActions, engine.sourceTiming);
            activate(session, host, `${SOURCE_GROUP_FIXTURE}
                local action=ISGrabItemAction:new(getPlayer(),QueueModelWorld(${id}),20)
                function action:start()
                    getModData().QueueModel.starts=getModData().QueueModel.starts+1
                    self.started=true
                    self.action:${force}()
                end
                ISTimedActionQueue.add(action)
                assert(action.action:getJobDelta()==0)
            `, `source-start-${force.toLowerCase()}`);
            assert.equal(engine.sourceActions.eventRead(), null);
            assert.equal(engine.actions.getState().current.currentTime, 0);
            assert.notEqual(host.api.items.get(id).worldPosition, null);
            host.frameStep(1 / 60);
            engine.sourceActions.dispatch(session.dispatchSourceAction);
            session.flushSaveData();
            const stats = saved.get('host').data.nativePlayerData.QueueModel;

            assert.equal(stats.starts, 1);
            assert.equal(stats.performs, force === 'forceComplete' ? 1 : 0);
            assert.equal(stats.stops, force === 'forceStop' ? 1 : 0);
            assert.equal(host.api.items.get(id).ownerContainerId === host.api.items.playerInventoryId(), force === 'forceComplete');
            assert.deepEqual(engine.actions.getState(), { current: null, pending: [] });
        } finally {
            session.close();
            host.dispose();
        }
    });
}

test('source inventory rows use native mutable broken heat and clothing wetness methods', async () => {
    const { engine, host, session } = await fixture();

    engine.registerItemDefinition({ ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.RowClothing', type: 'Clothing' }, { owner: 'fixture' });
    const id = engine.command({ type: 'spawnItem', fullType: 'Fixture.RowClothing', x: 5, y: 5 }).id;
    const graph = engine.exportInventoryGraph();

    graph.items[0] = { ...graph.items[0], ownerContainerId: 1, worldPosition: null };
    engine.importInventoryGraph(graph);
    try {
        activate(session, host, `
            local row=getPlayer():getInventory():getItems():get(0)
            RetainedRowLeaf=row
            assert(not row:isHumanCorpse(),'ordinary Clothing is not a human corpse')
            local originalType=row.getType
            row.getType=function() return 'CorpseMale' end
            assert(not row:isHumanCorpse(),'a Lua type-name override must not turn Clothing into a corpse')
            row.getType=originalType
            assert(row:getID()==${id})
            assert(row:updateAge()==nil)
            row:setBroken(true)
            assert(row:isBroken() and row:getCondition()==10)
            row:setBroken(false)
            row:setItemHeat(2.5)
            assert(row:getItemHeat()==2.5)
            row:setWetness(47.5)
            assert(row:getWetness()==47.5)
            assert(row:updateWetness()==nil)
            assert(row:getWetness()==0)
            row:setWetness(22.5)
            local again=getPlayer():getInventory():getItems():get(0)
            assert(again==row and again:getWetness()==22.5 and again:getItemHeat()==2.5,
                'reusing a native wrapper must still observe live mutable leaf state')
        `, 'RowLeafConsumer');
        assert.equal(engine.sourceActions.itemHeat(id), 2.5);
        assert.equal(engine.sourceActions.itemWetness(id), 22.5);
        assert.equal(engine.sourceActions.itemIsBroken(id), false);
        engine.beginItemDefinitionRegistration('fixture');
        try {
            engine.registerItemDefinition({ ...engine.getItemDefinition('Fixture.RowClothing'), type: 'Normal' },
                { owner: 'fixture', override: true });
            activate(session, host, `
                local row=getPlayer():getInventory():getItems():get(0)
                assert(row==RetainedRowLeaf and rawget(row,'getWetness')==nil and rawget(row,'setWetness')==nil and rawget(row,'updateWetness')==nil,
                    'a changed native Clothing subtype must update the reused wrapper')
                assert(row:getItemHeat()==2.5 and not row:isBroken())
            `, 'RowLeafOverride');
        } finally {
            engine.rollbackItemDefinitionRegistration('fixture');
        }

        activate(session, host, `
            local row=getPlayer():getInventory():getItems():get(0)
            assert(row==RetainedRowLeaf and row:getWetness()==22.5 and row:getItemHeat()==2.5,
                'definition rollback must restore native subtype methods without freezing mutable item state')
        `, 'RowLeafRollback');
    } finally {
        session.close();
        host.dispose();
    }
});
