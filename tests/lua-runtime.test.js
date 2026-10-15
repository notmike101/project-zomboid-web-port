/** @file Native Lua checks against both real WASM VMs. Run npm run build first. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createEngine } from '../src/engine.js';
import { createGameUI, parseBitmapFont } from '../src/game-ui.js';
import { parseItemDefinitions } from '../src/item-definitions.js';
import { createLuaSession } from '../src/lua-runtime.js';
import { createModHost } from '../src/mods.js';
import { engineSources } from '../src/native-mod-loader.js';
import { canvasContentBox } from '../src/renderer.js';
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
            assert(root:containsTypeRecurse("GraphLeaf"))
            assert(inside:getOutermostContainer()==root and inside:isInCharacterInventory(getPlayer()))
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

    try {
        activate(session, host, `
            local a=getCell():getGridSquare(5,5,0):getWorldObjects():get(0):getItem()
            local b=getCell():getGridSquare(6,5,0):getWorldObjects():get(0):getItem()
            FloorViewCheck=ItemContainer.new("floor",nil,nil)
            FloorViewCheck:setExplored(true)
            FloorViewCheck:AddItem(a)
            FloorViewCheck:AddItem(b)
            FloorViewCheck:AddItem(a)
            assert(FloorViewCheck:getItems():size()==2 and FloorViewCheck:getItems():get(0)==a)
            assert(FloorViewCheck:getMaxWeight()==50 and FloorViewCheck:getCapacityWeight()==2)
            assert(a:getContainer()~=b:getContainer() and a:getContainer()~=FloorViewCheck)
            assert(a:getOutermostContainer()==nil and a:getOwner()==nil)
            assert(not pcall(function() FloorViewCheck:DoRemoveItem(a) end))
            FloorViewCheck:clear()
            assert(FloorViewCheck:getItems():isEmpty() and a:getWorldItem()~=nil)
            FloorViewCheck:AddItem(a)
            FloorViewCheck:AddItem(b)
        `, 'floor-view-check');
        assert.equal(host.api.items.get(first.id).ownerContainerId, first.ownerContainerId);
        assert.equal(host.api.items.get(adjacent.id).ownerContainerId, adjacent.ownerContainerId);
        host.api.items.pickup(adjacent.id);
        completeActions(engine);
        activate(session, host, `
            assert(FloorViewCheck:getItems():size()==1)
            assert(FloorViewCheck:getItems():get(0):getID()==${first.id})
            assert(FloorViewCheck:getCapacityWeight()==1)
        `, 'floor-view-after-move');
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
            local native=square:getObjects()
            assert(native==square:getObjects())
            RetainedNativeObjects=native
            local clicked={}
            for i=0,native:size()-1 do clicked[#clicked+1]=native:get(i) end
            assert(#clicked==2)
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
        `, 'corpse-context-after-removal');
        assert.deepEqual(engine.actions.getState(), { current: null, pending: [] });
        assert.equal(host.api.items.containerItems(host.api.items.playerInventoryId()).length, 2);
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
    const { host, session, saved } = await fixture({ sourceWorldContext: { inputBindings: { Interact: null } } });

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
                for _,binding in ipairs(bindings) do assert(getCore():isKey(binding,key)==(key==0)) end
                assert(getCore():isKey('Interact',key)==(key==0))
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
            getModData().squareState = {}
            Events.OnTick.Add(function()
                assert(cell == getCell())
                local current = cell:getGridSquare(5, 5, 0)
                local result = getModData().squareState
                if current ~= nil then
                    assert(current == square and current == player:getCurrentSquare())
                    result.canStand = square:canStand()
                else
                    assert(player:getCurrentSquare() == nil)
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

test('private original queued grabs restore before lifecycle without eagerly registering the full inventory HUD', async (t) => {
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

    const content = {
        manifest,
        /**
         * Read untouched original text from the private content directory.
         *
         * @param {string} path - Manifest-owned original resource.
         * @returns {{text:()=>Promise<string>}} Private text reader.
         */
        getFile: (path) => ({
            /**
             * Read the selected private original file.
             *
             * @returns {Promise<string>} Unchanged source text.
             */
            text: () => readFile(new URL(`../content/${path}`, import.meta.url), 'utf8'),
        }),
    };
    const eager = ['env', 'ISBaseObject', 'ISUI/ISUIElement', 'ISUI/Layout/ISDock', 'ISUI/Style/UIHorizontalAlignment', 'ISUI/ISUITextureGetter'];
    const seeds = [
        ...eager, 'TimedActions/ISTimedActionQueue', 'TimedActions/ISGrabItemAction',
        'TimedActions/ISInventoryTransferAction', 'TimedActions/ISTransferAction',
        'TimedActions/ISOpenCloseDoor', 'TimedActions/WalkToTimedAction', 'TimedActions/ISWaitWhileGettingUp',
        'luautils', 'ISUI/ISContextMenu', 'ISUI/ISPanelJoypad', 'ISUI/ISRichTextPanel',
        'ISUI/ISToolTip', 'ISUI/ISToolTipInv', 'ISUI/ISInventoryItem', 'ISUI/ISInventoryPage',
        'ISUI/PlayerData/ISPlayerDataObject', 'ISUI/PlayerData/ISPlayerData',
        'BuildingObjects/ISMoveableCursor', 'RadioCom/ISRadioWindow', 'ISUI/ISScrollingListBox',
        'ISUI/ISTradingUI', 'ISUI/ISWorldObjectContextMenu',
    ];
    const startup = await Promise.all(seeds.map(async (name) => {
        const { path } = manifest.files.find((item) => item.path.replace(/^media\/lua\/(shared|client|server)\//u, '').replace(/\.lua$/u, '') === name);

        return { path, source: await content.getFile(path).text(), execute: eager.includes(name) };
    }));
    const sources = await engineSources([], content, startup);
    const fontDescriptors = await Promise.all(['Small', 'Medium', 'Large'].map(async (name) => {
        const descriptor = await content.getFile(`media/fonts/zomboid${name}.fnt`).text();
        const { width, height } = parseBitmapFont(descriptor);

        return { name, descriptor, width, height };
    }));
    const translationFiles = manifest.files.filter(({ path }) => /^media\/lua\/shared\/Translate\/EN\/[^/]+\.json$/u.test(path));
    const translations = Object.assign(Object.create(null), ...await Promise.all(translationFiles
        .map(async ({ path }) => JSON.parse(await content.getFile(path).text()))));

    translations['Fixture.OriginalRestore'] = 'Restored fixture item';
    const originalDOM = menuDocument();
    const candidateDOM = menuDocument();

    Object.defineProperty(candidateDOM.document.body, 'ownerDocument', {
        enumerable: true,
        /** Keep the host DOM opaque to the native interpreter. */
        get() {
            throw new Error('Native Lua must not enumerate the host DOM graph');
        },
    });
    const originalUI = sourceMenuUI(640, { document: originalDOM.document, focusTarget: originalDOM.canvas });
    const candidateUI = sourceMenuUI(640, { document: candidateDOM.document, focusTarget: candidateDOM.canvas });

    for (const ui of [originalUI, candidateUI]) {
        ui.initialize({
            textures: fontDescriptors.map(({ name, width, height }) => ({ path: name, width, height })),
            fonts: Object.fromEntries(fontDescriptors.map(({ name, descriptor }) => [name, { descriptor, atlasPath: name }])),
            fontAliases: { NewSmall: 'Small' },
            translations, settings: ui.bindings.call('settings'),
        });
    }

    const sourceFeedback = [];
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

    const originalFiles = privateFiles();
    const candidateFiles = privateFiles();
    const original = await fixture({ ...options, ui: originalUI, sourceFiles: originalFiles });
    const candidate = await fixture({ ...options, ui: candidateUI, sourceFiles: candidateFiles });
    const definition = { ...SOURCE_ITEM_FIELDS, fullType: 'Fixture.OriginalRestore', weight: 0.01 };

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
        completeLuaActions(candidate.engine, candidate.host, candidate.session);
        assert.equal(candidate.host.api.items.get(1).ownerContainerId, candidate.host.api.items.playerInventoryId(), 'restored original perform must complete before any first context-menu bootstrap');
        candidate.host.api.items.spawn({ fullType: definition.fullType, x: 5, y: 5 });
        assert.equal(candidate.session.openWorldContextMenu({ screenX: 320, screenY: 320, worldX: 5, worldY: 5 }), true);
        await loadSource(candidate.session, candidate.host, `
            local data=getPlayerData(0)
            assert(data and data.id==0 and getmetatable(data)==ISPlayerDataObject)
            assert(getmetatable(data.playerInventory)==ISInventoryPage)
            assert(getmetatable(data.lootInventory)==ISInventoryPage)
            assert(getPlayerContextMenu(0)==data.contextMenu and getmetatable(data.contextMenu)==ISContextMenu)
        `, 'original-restored-ui-consumer');
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
        assert.deepEqual(candidate.session.diagnostics().errors, []);
        assert.deepEqual(sourceFeedback, []);
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

        session.attachSourceActions(engine.sourceActions, engine.sourceTiming);
        activate(session, host, `${SOURCE_GROUP_FIXTURE}
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
            ISInventoryPage.OnObjectHighlighted(0,value,true)
            assert(value:isHighlighted(0))
            ISInventoryPage.OnObjectHighlighted(0,value,false)
            assert(not value:isHighlighted(0))
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
chars count=1
char id=63 x=0 y=0 width=2 height=3 xoffset=0 yoffset=0 xadvance=2 page=0 chnl=15`;

    ui.setViewport(size, size);
    ui.initialize({
        textures: [{ path: 'source-atlas', width: 4, height: 4 }], font: { descriptor, atlasPath: 'source-atlas' },
        translations: {
            ContextMenu_Grab: 'Grab', ContextMenu_Grab_one: 'One', ContextMenu_Grab_half: 'Half',
            ContextMenu_Grab_all: 'All', 'Fixture.Screen': 'Screen item', ContextMenu_Door_option: 'Door',
            ContextMenu_Open_door: 'Open', ContextMenu_Close_door: 'Close', ContextMenu_Info: 'Info',
            Tooltip_OpenClose: 'Press %1', Tooltip_DoorIsLocked: 'Locked',
        },
        settings: {
            moodleSize: 1, fontSizeReal: 1, lockFPS: 60, gray: { r: 0.5, g: 0.5, b: 0.5, a: 1 },
            goodHighlight: { r: 0, g: 1, b: 0, a: 1 }, badHighlight: { r: 1, g: 0, b: 0, a: 1 },
        },
    });

    return ui;
}

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
