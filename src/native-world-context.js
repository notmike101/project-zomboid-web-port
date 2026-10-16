/** @file Native-backed original world context and inventory-page entry points; original widgets stay resident. */

/**
 * Original IsoPlayer.updateUseKey state, advanced once per accepted native update.
 * The source arms below .5 seconds and attempts only on release or at/above .5.
 *
 * @returns {object} Session-local input lifetime.
 */
function createContextKeyInput() {
    let pressed = false;
    let seconds = 0;
    /**
     * Clear the armed context press and its elapsed time.
     *
     * @returns {void} Clears the armed context press.
     */
    const cancel = () => {
        pressed = false;
        seconds = 0;
    };

    return {
        cancel,
        /**
         * Advance the armed context press using an accepted native frame.
         *
         * @param {number} elapsed - Accepted native frame duration.
         * @param {boolean} down - Whether Interact is held.
         * @param {boolean} allowed - Whether gameplay owns this sample.
         * @param {function(number,number): boolean} attempt - Source context attempt.
         * @returns {boolean} Whether the source attempt succeeded.
         */
        update(elapsed, down, allowed, attempt) {
            if (!Number.isFinite(elapsed) || elapsed < 0) {
                throw new RangeError('Context input requires an accepted nonnegative native frame');
            }

            seconds = Math.fround(seconds + Math.fround(elapsed));

            if (down && seconds < 0.5) {
                pressed = true;

                return false;
            }

            if (!allowed) {
                pressed = false;
            }

            if (pressed && attempt(Math.floor(Math.fround(seconds * 1_000)), seconds)) {
                cancel();

                return true;
            }

            if (!down) {
                cancel();
            }

            return false;
        },
    };
}

/**
 * IsoPlayer.doContext's float quadrant ordering, including reverse cardinal scan.
 *
 * @param {string} facing - Source getForwardIsoDirection.
 * @param {number} px - Actor position.
 * @param {number} py - Actor position.
 * @returns {object} Ordered front, corner and behind directions.
 */
function sourceContextDirections(facing, px, py) {
    const opposite = { N: 'S', W: 'E', S: 'N', E: 'W' };

    if (opposite[facing]) {
        return { front: [facing], behind: [opposite[facing]], corner: null };
    }

    if (!['NW', 'NE', 'SE', 'SW'].includes(facing)) {
        throw new TypeError('Unsupported source context direction');
    }

    let x = Math.fround(Math.fround(px) - Math.floor(Math.fround(px)));
    let y = Math.fround(Math.fround(py) - Math.floor(Math.fround(py)));

    if (facing === 'NE' || facing === 'SE') {
        x = Math.fround(1 - x);
    }

    if (facing === 'SE' || facing === 'SW') {
        y = Math.fround(1 - y);
    }

    const vertical = facing === 'NW' || facing === 'NE' ? 'N' : 'S';
    const horizontal = facing === 'NW' || facing === 'SW' ? 'W' : 'E';
    const front = y < x ? [vertical, horizontal] : [horizontal, vertical];

    return { front, behind: front.map((direction) => opposite[direction]), corner: facing };
}

/**
 * Strict original priority comparison: first per side and front wins equal ties.
 *
 * @param {object[]} candidates - Source insertion order.
 * @returns {object|null} Selected action or genuinely empty list.
 */
function pickSourceContextAction(candidates) {
    let front = null;
    let behind = null;

    for (const candidate of candidates) {
        if (!Number.isInteger(candidate.priority) || candidate.priority < 0) {
            throw new TypeError('Source contextual action priority is unavailable');
        }

        if (candidate.behind) {
            if (!behind || candidate.priority > behind.priority) {
                behind = candidate;
            }
        } else if (!front || candidate.priority > front.priority) {
            front = candidate;
        }
    }

    return !front || (behind && behind.priority > front.priority) ? behind : front;
}

/**
 * Encode source square coordinates as a scene lookup key.
 *
 * @param {number} x - Square coordinate.
 * @param {number} y - Square coordinate.
 * @param {number} z - Square level.
 * @returns {string} Source square identity.
 */
const key = (x, y, z) => `${x},${y},${z}`;

/**
 * Read surviving objects from a source square, if present.
 *
 * @param {object|undefined} square - Source square, if present.
 * @returns {object[]} Surviving source objects.
 */
const objects = (square) => square ? square.contextObjects : [];

/**
 * Check surviving square objects for a source property.
 *
 * @param {object|undefined} square - Source square, if present.
 * @param {string} flag - Source property name.
 * @returns {boolean} Whether any object has the property.
 */
const has = (square, flag) => objects(square).some((object) => object.properties.has(flag));

/**
 * Select against complete surviving source placements and live native doors.
 * Unrepresented state is an explicit unresolved candidate, never an empty tile.
 *
 * @param {object} engine - Owning native scene.
 * @param {object[]} squares - Full source map projection (including blank squares).
 * @returns {function(number,boolean,boolean): object} Source contextual selection.
 */
function createSourceContextSelector(engine, squares) {
    const scene = new Map(squares.map((square) => [key(square.x, square.y, square.z), square]));

    for (const square of squares) {
        if (!Array.isArray(square.contextObjects)) {
            throw new TypeError('Source context requires a complete post-constructor object census');
        }
    }

    const hutchBases = new Set();

    for (const square of squares) {
        if (square.contextObjects.some((object) => /^location_farm_accesories_01_(?:42|45|47|58|61|63)$/u.test(object.sprite))) {
            // MOHutch moves the object to this base rather than retaining the triggering tile.
            hutchBases.add(key(square.x - 1, square.y, square.z));
        }
    }

    const offsets = { N: [0, -1], NW: [-1, -1], W: [-1, 0], SW: [-1, 1], S: [0, 1], SE: [1, 1], E: [1, 0], NE: [1, -1] };
    const opposite = { N: 'S', W: 'E', S: 'N', E: 'W' };

    return (seconds, shift, grappling) => {
        const actor = engine.snapshot();
        const x = Math.floor(actor.x);
        const y = Math.floor(actor.y);
        const z = 0;
        const current = scene.get(key(x, y, z));
        const facing = engine.sourceActions.playerDirection();
        /**
         * Look up a neighboring source square relative to the actor.
         *
         * @param {string} direction - Source direction.
         * @returns {object|undefined} Adjacent source square.
         */
        const adjacent = (direction) => {
            const [dx, dy] = offsets[direction];

            return scene.get(key(x + dx, y + dy, z));
        };

        if (!current || !adjacent(facing)) {
            return { blocked: true };
        }

        for (const square of [current, ...Object.keys(offsets).map(adjacent)].filter(Boolean)) {
            const live = engine.getSquare(square.x, square.y, square.z);

            if (!live || live.vehicleObstructed !== false) {
                throw new Error('Source context vehicle/square population is not represented');
            }
        }

        const directions = sourceContextDirections(facing, actor.x, actor.y);
        const liveDoors = new Map(engine.doors().map((door) => [door.id, door]));
        const candidates = [];

        /**
         * Append a contextual candidate with its original enum priority.
         *
         * @param {string} action - Source contextual action.
         * @param {string} direction - Selected direction.
         * @param {object|null} object - Surviving source object.
         * @param {boolean} [behind=false] - Whether the candidate is behind.
         * @param {string|null} [unresolved=null] - Unrepresented native state.
         * @returns {void} Appends the source-priority candidate.
         */
        const add = (action, direction, object, behind = false, unresolved = null) => {
            // ContextualAction.Action priorities from the original enum constructor.
            const priority = ['OpenHutch', 'OpenButcherHook', 'AnimalInteraction', 'RestOnFurniture'].includes(action) ? 90 : 100;

            candidates.push({ action, direction, doorId: object?.doorId, sprite: object?.sprite, priority, behind, unresolved });
        };

        /**
         * Resolve a source door to its supported live native state.
         *
         * @param {object} object - Source door object.
         * @returns {object} Live native door state.
         */
        const doorState = (object) => {
            const door = liveDoors.get(object.doorId);

            if (!door) {
                throw new Error('Source context door identity disappeared');
            }

            /*
                Double-door movement changes object membership/order; the existing native scene
                exposes coordinates but not its full relocated object-list ordering.
            */
            if (door.doubleDoor) {
                throw new Error('Source context requires relocated double-door object membership');
            }

            return door;
        };

        /**
         * Resolve the boundary edge occupied by a live door.
         *
         * @param {object} object - Source door object.
         * @param {boolean} closed - Whether to use the closed edge.
         * @returns {string} Source edge direction.
         */
        const edge = (object, closed) => {
            const door = doorState(object);

            if (!door.open || closed || door.garageDoor) {
                return door.north ? 'N' : 'W';
            }

            if (door.attachedE) {
                return 'E';
            }

            if (door.attachedS) {
                return 'S';
            }

            return door.north ? 'W' : 'N';
        };

        /**
         * Find the first open special door on a requested edge.
         *
         * @param {object|undefined} square - Source square.
         * @param {string} direction - Source edge direction.
         * @returns {object|undefined} First matching open door.
         */
        const openDoor = (square, direction) => objects(square).find((object) =>
            object.kind === 'door' && object.special && doorState(object).open && edge(object, false) === direction);
        /**
         * Find the first special door with the requested orientation.
         *
         * @param {object|undefined} square - Source square.
         * @param {boolean} north - Source door orientation.
         * @returns {object|undefined} First matching special door.
         */
        const edgeDoor = (square, north) => objects(square).find((object) =>
            object.kind === 'door' && object.special && doorState(object).north === north);
        /**
         * Find the last door, window or frame on a requested boundary.
         *
         * @param {object|undefined} square - Source square.
         * @param {string} direction - Source edge direction.
         * @param {boolean} closed - Whether to use the closed door edge.
         * @returns {object|undefined} Last matching boundary object.
         */
        const getter = (square, direction, closed) => objects(square).findLast((object) =>
            object.kind === 'door'
                ? edge(object, closed) === direction
                : ['window', 'frame'].includes(object.kind) && (object.north ? 'N' : 'W') === direction);
        /**
         * Select the boundary object using the original directional lookup order.
         *
         * @param {string} direction - Source direction.
         * @returns {object|null|undefined} Selected source boundary object.
         */
        const lookup = (direction) => {
            const next = adjacent(direction);
            const first = openDoor(current, direction);

            if (first) {
                return first;
            }

            if (direction === 'N' || direction === 'W') {
                const found = getter(current, direction, true) ?? edgeDoor(current, direction === 'N');

                if (found) {
                    return found;
                }

                return next && !engine.isBlockedTo(current, next) ? openDoor(next, opposite[direction]) : null;
            }

            if (!next) {
                return null;
            }

            const closed = engine.isBlockedTo(current, next);

            return getter(next, opposite[direction], closed) ?? edgeDoor(next, direction === 'S');
        };

        /**
         * Classify a boundary object into its contextual action.
         *
         * @param {string} direction - Source direction.
         * @param {object} object - Selected source boundary object.
         * @param {boolean} behind - Whether selection is behind the actor.
         * @returns {void} Adds the represented action or explicit unresolved candidate.
         */
        const handleObject = (direction, object, behind) => {
            if (object.kind !== 'door') {
                const square = objects(current).includes(object) ? current : adjacent(direction);

                if (object.kind === 'window' && has(square, 'makeWindowInvincible')) {
                    return;
                }

                add(object.kind === 'window' ? 'ToggleWindow' : 'ClimbThroughWindow', direction, object, behind,
                    `native ${object.kind} state/curtain/climb eligibility and resident source identity are not represented`);

                return;
            }

            const door = doorState(object);

            if (shift && engine.sourceActions.doorCurtainState(door.id).has) {
                add('ToggleCurtain', direction, object, behind, 'door sheet-facing/movement-tick context state is unavailable');
            } else if (seconds >= 0.5 && door.hoppable) {
                add(grappling ? 'ThrowGrappledOverFence' : 'ClimbOverFence', direction, object, behind,
                    'native contextual vault/grapple state is unavailable');
            } else {
                add('ToggleDoor', direction, object, behind);
            }
        };

        /**
         * Select furniture or map-object candidates outside boundary lookup.
         *
         * @param {string} direction - Source direction.
         * @returns {boolean} Whether ordinary selection found a candidate.
         */
        const ordinary = (direction) => {
            const next = adjacent(direction);

            if (!next) {
                return false;
            }

            /*
                Map-object/entity callbacks can replace these actual placements; their typed
                membership is not supplied by the native scene. Preserve that uncertainty.
            */
            const unknown = [...objects(next), ...objects(current)].find((object) => object.componentCandidate
                || object.sprite === 'crafted_04_120' || /^location_farm_accesories_01_(?:4[1-9]|50|5[7-9]|6[0-6])$/u.test(object.sprite));

            if (unknown || hutchBases.has(key(next.x, next.y, next.z)) || hutchBases.has(key(current.x, current.y, current.z))) {
                let action = 'OpenHutch';

                if (unknown?.componentCandidate) {
                    action = 'UnclassifiedMapObject';
                } else if (unknown?.sprite === 'crafted_04_120') {
                    action = 'OpenButcherHook';
                }

                add(action, direction, unknown, false, 'source map-object/entity replacement membership is unavailable');

                return true;
            }

            if (!shift && !grappling) {
                const bed = objects(next).find((object) => object.properties.has('bed'))
                    ?? objects(current).find((object) => object.properties.has('bed'));

                if (bed) {
                    add('RestOnFurniture', direction, bed, false, 'native furniture object identity and SleepInBed contextual action are unavailable');

                    return true;
                }
            }

            return false;
        };

        for (const direction of directions.front) {
            if (!adjacent(direction)) {
                continue;
            }

            if (!grappling && has(current, `climbSheet${direction}`)) {
                add('ClimbSheetRope', direction, null, false, 'native vertical sheet-rope eligibility is unavailable');

                continue;
            }

            const object = lookup(direction);

            if (object) {
                handleObject(direction, object, false);

                continue;
            }

            if (ordinary(direction)) {
                continue;
            }

            const next = adjacent(direction);

            if (shift && !grappling) {
                const curtainDoor = [...objects(current), ...objects(next)].find((entry) =>
                    entry.kind === 'door' && engine.sourceActions.doorCurtainState(entry.doorId).has);

                if (curtainDoor) {
                    add('ToggleCurtain', direction, curtainDoor, false, 'door sheet-facing/movement-tick context state is unavailable');

                    continue;
                }
            }

            const boundary = direction === 'N' || direction === 'W' ? current : next;
            const suffix = direction === 'N' || direction === 'S' ? 'N' : 'W';

            if (has(boundary, `Hoppable${suffix}`)) {
                add(grappling ? 'ThrowGrappledOverFence' : 'ClimbOverFence', direction, null, false,
                    'native contextual fence safety/object identity is unavailable');
            } else if (!grappling && !has(boundary, 'CantClimb') && has(boundary, `collide${suffix}`)
                && objects(boundary).some((entry) => entry.tileType === 'wall')) {
                add('ClimbOverWall', direction, null, false, 'native roof/eave and wall-climb eligibility are unavailable');
            }
        }

        if (!candidates.length && directions.corner) {
            ordinary(directions.corner);
        }

        for (const direction of directions.behind) {
            const object = lookup(direction);

            if (object) {
                handleObject(direction, object, true);
            }
        }

        return pickSourceContextAction(candidates) ?? { empty: true };
    };
}

const WORLD_CONTEXT_PRELUDE = String.raw`
local contextOptions={contextMenuFont='Medium',singleContextMenu=false,timedActionGameSpeedReset=true,displayCursor=true,inventoryContainerSize=1}
local debugState={enabled=false,showContextMenuReportOptions=true}
local corpseObjects={}
local dragObjects={}
local dragOwners={}
local function worldContext(name, ...) return hostCall('sourceContext',name,...) end
do
    local function highlightPlayer(index)
        assert(index==player:getPlayerNum(),'unsupported native highlight player')
        hostCall('state')
    end
    local function highlightObject(value)
        -- Resident identity outlives native removal; clearing its presentation must still work.
        local label=nativeTypes[value]
        if label=='IsoDoor' and doorObjects[value.__doorId]==value then
            return value.__doorId
        end
        local id=itemIds[value]
        assert(label=='IsoWorldInventoryObject' and id and worldItems[id]==value,'expected native highlighted world object')
        return id
    end
    -- Door and world-item highlights share the existing presentation authority, never native lock/key state.
    local originalDoor=door
    door=function(id)
        local value=originalDoor(id)
        if rawget(value,'setHighlighted')==nil then
            function value:setHighlighted(index,enabled,blink)
                highlightPlayer(index)
                assert(self==value,'expected native highlighted door')
                local identity=highlightObject(self)
                assert(rawType(enabled)=='boolean' and (blink==nil or rawType(blink)=='boolean'),'invalid original world highlight')
                actorState.worldHighlights=actorState.worldHighlights or {}
                actorState.worldHighlights[identity]={enabled=enabled,blink=blink==true}
                hostCall('sourceHighlight','door',value.__doorId,actorState.worldHighlights[identity])
            end
            function value:isHighlighted(index)
                highlightPlayer(index)
                assert(self==value,'expected native highlighted door')
                local identity=highlightObject(self)
                local state=actorState.worldHighlights and actorState.worldHighlights[identity]
                return state and state.enabled or false
            end
        end
        return value
    end
    local tracked={}
    local doors=collection(function() return tracked end)
    function doors:add(value)
        assert(self==doors,'expected native key-highlight list')
        highlightObject(value)
        tracked[#tracked+1]=value
        return true
    end
    function doors:clear()
        assert(self==doors,'expected native key-highlight list')
        tracked={}
    end
    local selection={key=nil,doors=doors}
    actorState.keyHighlightDoor={[0]=selection}
    Key={highlightDoor=actorState.keyHighlightDoor}
    function Key.setHighlightDoors(index,entry)
        highlightPlayer(index)
        -- Key.setHighlightDoors routes every proven non-Key through the same tracked-clear branch as nil.
        if entry~=nil then
            local id=itemIds[entry]
            assert(id and rawEqual(itemCache[id],entry),'expected native inventory item for key highlight')
            local row=assert(hostCall('item',id),'native highlight selection disappeared')
            local definition=assert(hostCall('itemDefinition',row.fullType),'native highlight definition unavailable')
            local kind=(definition.type or 'normal'):lower():gsub('^base:','')
            if kind~='normal' and kind~='item' and kind~='clothing' and kind~='container' then
                rawError(fault('unsupported native key-door highlighting for non-nil inventory selection'),2)
            end
        end
        for _,value in ipairs(tracked) do
            highlightObject(value)
            value:setHighlighted(index,false,false)
        end
        doors:clear()
        selection.key=nil
    end
end
function core:getZoom(index) assert(index==player:getPlayerNum());return worldContext('getZoom',index) end
function core:getOptionInventoryFont()
    local font=ui('settings').inventoryFont
    assert(font=='Small' or font=='Medium' or font=='Large','explicit inventory font setting required')
    return font
end
function core:getOptionCycleContainerKey()
    local key=ui('settings').cycleContainerKey
    assert(key=='control' or key=='shift' or key=='control+shift' or key=='command' or key=='command+shift','explicit inventory cycle key setting required')
    return key
end
function player:getJoypadBind() return worldContext('joypadBind') end
function getJoypadData(index)
    assert(index==player:getPlayerNum(),'unsupported native joypad player')
    -- Original keyboard mode removes its player entry; assigned controllers need their real registry lifecycle.
    assert(player:getJoypadBind()==-1,'unsupported native assigned joypad data')
    return nil
end
IsoDirections={}
for _,name in ipairs({'N','NW','W','SW','S','SE','E','NE'}) do
    local value=nativeObject('IsoDirections')
    function value:name() return name end
    IsoDirections[name]=value
end
function player:getDir()
    return assert(IsoDirections[qa('playerDirection')],'unsupported native player direction')
end
function core:getOptionContextMenuFont() return contextOptions.contextMenuFont end
function core:getOptionSingleContextMenu(index) assert(index==0);return contextOptions.singleContextMenu end
function core:getOptionInventoryContainerSize() return contextOptions.inventoryContainerSize end
function core:getOptionTooltipFont() return 'Small' end
function core:getOptionTimedActionGameSpeedReset() return contextOptions.timedActionGameSpeedReset end
function core:isDisplayCursor() return contextOptions.displayCursor end
function core:setDisplayCursor(value) assert(rawType(value)=='boolean');contextOptions.displayCursor=value end
function getGameSpeed() if worldContext('paused') then return 0 end;return timing('getState').multiplier end
function isGamePaused() return worldContext('paused') end
local speeds=nativeObject('SpeedControls')
function speeds:getCurrentGameSpeed() return getGameSpeed() end
function speeds:SetCurrentGameSpeed(speed) assert(speed>0);timing('set','multiplier',speed) end
function UIManager.getSpeedControls() return speeds end
function UIManager.getMillisSinceLastRender() return timing('getState').elapsedSeconds*1000 end
local sourceKeys={}
KeybindId={}
for name,id in pairs({TOGGLE_INVENTORY='Toggle Inventory',TOGGLE_MODE='Toggle mode',RUN='Run',INTERACT='Interact',GRAB_CORPSE='GrabCorpse',ROTATE_BUILDING='Rotate building',PAN_CAMERA='PanCamera',MELEE='Melee'}) do
    local value=nativeObject('KeybindId')
    function value:getId() return id end
    KeybindId[name]=value
    sourceKeys[value]=id
end
local function sourceKeyBinding(name)
    local value=worldContext('keyBinding',name)
    if value==nil then return nil end
    assert(rawType(value)=='table','expected source key binding record')
    for _,field in ipairs({'keyValue','altKey'}) do
        local code=value[field]
        assert(rawType(code)=='number' and code%1==0 and code>=0 and code<10000,'unsupported non-keyboard source binding')
    end
    for _,field in ipairs({'shift','ctrl','alt'}) do assert(rawType(value[field])=='boolean','expected source key modifier') end
    return value
end
local function validSourceBinding(name,value)
    if value==nil or (value.keyValue==0 and value.altKey==0) then return false end
    local shift=worldContext('isSourceKeyDown',42) or worldContext('isSourceKeyDown',54)
    local ctrl=worldContext('isSourceKeyDown',29) or worldContext('isSourceKeyDown',157)
    local alt=worldContext('isSourceKeyDown',56) or worldContext('isSourceKeyDown',184)
    local primary=value.keyValue
    if primary==42 or primary==54 then return shift end
    if primary==29 or primary==157 then return ctrl end
    if primary==56 or primary==184 then return alt end
    if (value.shift and not shift) or (value.ctrl and not ctrl) or (value.alt and not alt) then return false end
    for otherName,other in pairs(worldContext('keyBindings')) do
        if otherName~=name and other and other.keyValue==primary
            and (other.shift~=value.shift or other.ctrl~=value.ctrl or other.alt~=value.alt)
            and not (value.shift==shift and value.ctrl==ctrl and value.alt==alt)
            and other.shift==shift and other.ctrl==ctrl and other.alt==alt then return false end
    end
    return true
end
local function sourceBindingKeyDown(name)
    local value=sourceKeyBinding(name)
    if not validSourceBinding(name,value) then return 0 end
    if value.keyValue~=0 and worldContext('isSourceKeyDown',value.keyValue) then return value.keyValue end
    if value.altKey~=0 and worldContext('isSourceKeyDown',value.altKey) then return value.altKey end
    return 0
end
function core:isKey(binding,key)
    local name=sourceKeys[binding] or (rawType(binding)=='string' and binding)
    assert(name,'unsupported source key identity')
    assert(rawType(key)=='number' and key%1==0 and key>=0 and key<10000,'expected native keyboard code')
    local value=sourceKeyBinding(name)
    return validSourceBinding(name,value) and (key==value.keyValue or key==value.altKey)
end
Keyboard=setmetatable({}, {__index=function(_,name)
    if name=='getKeyName' then return function(code) return worldContext('keyName',code) end end
    local code=worldContext('keyboardKey',name)
    assert(code~=nil,'unsupported native Keyboard.'..tostring(name))
    return code
end})
function isKeyDown(binding)
    local name=sourceKeys[binding] or (rawType(binding)=='string' and binding)
    if name then
        return sourceBindingKeyDown(name)~=0
    end
    assert(rawType(binding)=='number' and binding%1==0 and binding>=0 and binding<10000,'expected native keyboard code')
    return binding~=0 and worldContext('isSourceKeyDown',binding)
end
function isShiftKeyDown() return worldContext('isSourceKeyDown',42) or worldContext('isSourceKeyDown',54) end
function isCtrlKeyDown() return worldContext('isSourceKeyDown',29) or worldContext('isSourceKeyDown',157) end
function isAltKeyDown() return worldContext('isSourceKeyDown',56) or worldContext('isSourceKeyDown',184) end
function isMetaKeyDown() return worldContext('isSourceKeyDown',219) or worldContext('isSourceKeyDown',220) end
function isMouseButtonDown(index)
    assert(rawType(index)=='number' and index%1==0 and index>=0 and index<8,'expected native mouse button index 0..7')
    local down=worldContext('isMouseButtonDown',index)
    assert(rawType(down)=='boolean','expected native physical mouse button state')
    return down
end
function UIManager.isMouseOverInventory()
    local over=ui('isMouseOverInventory')
    assert(rawType(over)=='boolean','expected actual inventory mouse-over state')
    return over
end
function __pz_actor_input_update()
    assert(player:getJoypadBind()==-1,'unsupported native actor input controller')
    assert(player:getVehicle()==nil,'unsupported native actor input vehicle')
    local aimKey=sourceBindingKeyDown('Aim')
    local aim=aimKey~=0
    if aim and (aimKey==29 or aimKey==157) then aim=not UIManager.isMouseOverInventory() end
    qa('refreshActorInput',player:getPlayerNum(),aim,isKeyDown('Run'),isKeyDown('Sprint'))
end
function __pz_context_key_state()
    assert(player:getJoypadBind()==-1,'unsupported native context controller')
    return {down=sourceBindingKeyDown('Interact')~=0,cancelled=player:isAsleep(),
        grappleThrowOutWindow=actorState.variables.GrappleThrowOutWindow==true}
end
function __pz_context_key_attempt(milliseconds,seconds)
    -- These actor producers are not admitted by the native world; never clear
    -- an actual current timed action while preserving the source retrigger.
    local actions=player:getCharacterActions()
    if not actions:isEmpty() then player:setTimedActionToRetrigger(actions:get(0)) end
    if player:isSitting() then
        __pz_dispatch('OnContextKey',player,milliseconds)
        return true
    end
    assert(player:getVehicle()==nil,'unsupported native context vehicle')
    local selected=worldContext('contextSelection',seconds,isShiftKeyDown(),player:isGrappling())
    assert(rawType(selected)=='table','source context classification unavailable')
    if selected.blocked then return false end
    if selected.empty then
        __pz_dispatch('OnContextKey',player,milliseconds)
        return false
    end
    assert(not selected.unresolved,'unsupported native context '..tostring(selected.action)..': '..tostring(selected.unresolved))
    assert(selected.action=='ToggleDoor' and rawType(selected.doorId)=='string','unsupported native contextual action')
    -- Contextual ToggleDoor is direct, unlike the menu's Lua timed action.
    -- Native BLOCKED is still a performed contextual attempt, not an empty fallback.
    qa('contextToggleDoor',selected.doorId)
    return true
end
function textManager:getFontFromEnum(font)
    local value=nativeObject('AngelCodeFont')
    function value:getLineHeight() return ui('fontHeight',font) end
    ui('fontHeight',font)
    return value
end
JoypadState={players={}}
function getDebug() hostCall('state');return debugState.enabled end
function isDebugEnabled() hostCall('state');return debugState.enabled end
do
    -- Native DebugType.Grapple is ordinal 46, has no orWith category, and starts Off.
    -- GlobalObject.log uses debugln: Core.debug AND the Debug severity threshold.
    local severityIndices={}
    local function enumValue(class,name,index)
        local value=nativeObject(class)
        function value:name() assert(self==value,'expected native '..class);return name end
        function value:ordinal() assert(self==value,'expected native '..class);return index end
        function value:toString() assert(self==value,'expected native '..class);return name end
        getmetatable(value).__tostring=function() return name end
        return value
    end
    LogSeverity={}
    for index,name in ipairs({'Trace','Noise','Debug','General','Warning','Error','Off'}) do
        local value=enumValue('LogSeverity',name,index-1)
        severityIndices[value]=index-1
        LogSeverity[name]=value
        function value:isLogEnabled(severity)
            local threshold,level=severityIndices[self],severityIndices[severity]
            assert(threshold~=nil and level~=nil,'expected native LogSeverity')
            return self~=LogSeverity.Off and level>=threshold
        end
    end
    LogSeverity.All=LogSeverity.Trace
    local grapple=enumValue('DebugType','Grapple',46)
    local severity=debugState.enabled and LogSeverity.General or LogSeverity.Off
    DebugType=setmetatable({Grapple=grapple},{__index=function(_,name)
        rawError(fault('unsupported native facility: DebugType.'..tostring(name)),2)
    end})
    function grapple:getLogSeverity() assert(self==grapple,'expected native DebugType');return severity end
    function grapple:setLogSeverity(value)
        assert(self==grapple,'expected native DebugType')
        assert(severityIndices[value]~=nil,'expected native LogSeverity')
        severity=value
    end
    function grapple:isEnabled(value)
        assert(self==grapple,'expected native DebugType')
        if value==nil then return severity~=LogSeverity.Off end
        return severity:isLogEnabled(value)
    end
    function grapple:debugln(message,...)
        assert(self==grapple,'expected native DebugType')
        assert(select('#',...)==0 and (rawType(message)=='string' or message==nil),'unsupported DebugType.debugln overload')
        hostCall('state')
        if not debugState.enabled or not severity:isLogEnabled(LogSeverity.Debug) then return end
        local owner=context()
        local record=assert(records[owner.id..'/'..owner.path],'native logging source unavailable')
        rawPrint('[native '..record.nativeId..'/'..owner.path..'] DEBUG: Grapple> '..(message or 'null'))
    end
    DebugLog={
        isEnabled=function(value) assert(value==grapple,'expected native DebugType');return grapple:isEnabled() end,
        isLogEnabled=function(value,level)
            assert(value==grapple,'expected native DebugType')
            assert(severityIndices[level]~=nil,'expected native LogSeverity')
            return grapple:isEnabled(level)
        end,
    }
    function log(value,message,...)
        assert(value==grapple,'expected native DebugType')
        return grapple:debugln(message,...)
    end
end
function player:getIndex() return self:getPlayerNum() end
function player:isLocal() return self:isLocalPlayer() end
function player:isSitting() return qa('isSitting') end
function player:getCurrentState() return hostCall('state').action==2 and actorState.walkState or actorState.idleState end
for _,name in ipairs({'ClimbThroughWindowState','ClimbOverFenceState','ClimbOverWallState','ClimbSheetRopeState',
    'ClimbDownSheetRopeState','CloseWindowState','OpenWindowState'}) do
    local value=nativeObject(name)
    root[name]={instance=function() return value end}
end
actorState.idleState=nativeObject('IdleState');actorState.walkState=nativeObject('WalkTowardState')
function player:setVariable(key,value) actorState.variables[key]=value end
function player:isGrappling() return actorState.grappleTarget~=nil end
function player:isSitOnGround() return self:isSitting() end
function cell:setDrag(value,index)
    assert(value==nil or (rawType(value)=='table' and not nativeTypes[value]),'expected original Lua drag table')
    assert(rawType(index)=='number' and index%1==0,'expected native drag player index')
    local owner=context()
    hostCall('state')
    __pz_dispatch('SetDragItem',value,index)
    if index<0 or index>=4 then return end
    assert(index==player:getPlayerNum(),'unsupported native drag player')
    local previous=dragObjects[index]
    if previous==value then return end
    if previous then
        local deactivate=rawget(previous,'deactivate')
        if rawType(deactivate)=='function' then
            -- Native pcallvoid records the original callback failure without cancelling this replacement.
            pcall(guarded,dragOwners[index],deactivate,previous)
        end
    end
    dragObjects[index]=value
    dragOwners[index]=value and owner or nil
    if value then rawset(value,'player',index) end
end
function cell:getDrag(index) assert(index==0);hostCall('state');return dragObjects[index] end
function cell:isValidSquare(x,y,z) return worldContext('isValidSquare',x,y,z) end
local pickedTile,pickedTileLocal
function UIManager.getPickedTile() hostCall('state');return pickedTile end
function UIManager.getPickedTileLocal() hostCall('state');return pickedTileLocal end
function __pz_world_pointer(x,y)
    hostCall('state')
    if pickedTile==nil then pickedTile=nativeObject('Vector2');pickedTileLocal=nativeObject('Vector2') end
    pickedTile.x,pickedTile.y=math.floor(x),math.floor(y)
    pickedTileLocal.x,pickedTileLocal.y=x-pickedTile.x,y-pickedTile.y
end
function __pz_world_phase(phase,z)
    hostCall('state')
    if pickedTile==nil then return false end
    local x,y=pickedTile.x,pickedTile.y
    if not cell:isValidSquare(x,y,z) then return false end
    if phase=='opaque' then
        __pz_dispatch('RenderOpaqueObjectsInWorld',0,x,y,z,cell:getGridSquare(x,y,z))
        return true
    end
    local drag=cell:getDrag(0)
    if drag==nil then return false end
    -- This actor has no native joypad binding; mutable JoypadState is not controller authority.
    __pz_dispatch('OnDoTileBuilding2',drag,true,x,y,z,cell:getGridSquare(x,y,z))
    return true
end
function __pz_world_build_input()
    if cell:getDrag(0)==nil then return false end
    rawError(fault('unsupported native facility: IsoObjectPicker.ContextPick for active building input'),0)
end
IsoObjectPicker={Instance={PickCorpse=function(_,x,y)
    assert(rawType(x)=='number' and rawType(y)=='number')
    for _,value in ipairs(corpseObjects) do if value:containsScreenPoint(x,y) then return value end end
    return nil
end}}
function triggerEvent(name,...) assert(handlers[name],'unsupported event '..name);return __pz_dispatch(name,...) end
local roomObjects,buildingObjects={},{}
local function room(id)
    if id<0 then return nil end
    local row=worldContext('room',id)
    assert(row and row.id==id,'source room metadata unavailable')
    if roomObjects[id] then return roomObjects[id] end
    local value=nativeObject('IsoRoom')
    function value:getName() return worldContext('room',id).name end
    function value:getRoomDef() return value end
    function value:getBuilding()
        local current=worldContext('room',id)
        if current.buildingId==nil then return nil end
        local bid=current.buildingId
        local record=assert(worldContext('building',bid),'source building metadata unavailable')
        if not buildingObjects[bid] then
            local building=nativeObject('IsoBuilding')
            function building:getID() return bid end
            function building:getRooms() return collection(function()
                local values={}
                for _,rid in ipairs(worldContext('building',bid).roomIds) do values[#values+1]=room(rid) end
                return values
            end) end
            buildingObjects[bid]=building
        end
        assert(record.id==bid,'source building identity mismatch')
        return buildingObjects[bid]
    end
    roomObjects[id]=value
    return value
end
local originalSquare=cell.getGridSquare
IsoFlagType={collideN='collideN',collideW='collideW'}
function cell:getGridSquare(x,y,z)
    local square=originalSquare(self,x,y,z)
    if square==nil or rawget(square,'__sourceCollections') then return square end
    square.__sourceCollections=true
    local coords=squareRecords[square]
    function square:getRoom() return room(hostCall('square',coords.x,coords.y,coords.z).roomId) end
    function square:getBuilding() local value=self:getRoom();return value and value:getBuilding() end
    function square:has(flag)
        assert(flag=='collideN' or flag=='collideW','unsupported source square flag '..tostring(flag))
        return qa('squareHas',coords.x,coords.y,coords.z,flag=='collideN' and 0 or 1)
    end
    function square:isWallTo(other) return hostCall('wallTo',coords,other and assert(squareRecords[other],'expected source square')) end
    function square:canReachTo(other) return hostCall('canReachTo',coords,other and assert(squareRecords[other],'expected source square')) end
    local function floorState() return qa('squareFloorState',coords) end
    function square:TreatAsSolidFloor() return floorState().solidFloor end
    function square:isSolid() return floorState().solid end
    function square:isSolidTrans() return floorState().solidTrans end
    function square:HasStairs() return floorState().stairs end
    function square:isWindowTo(other)
        return qa('squareWindowTo',coords,(assert(squareRecords[other],'expected source square')))
    end
    function square:isSameStaircase(x,y,z)
        return qa('squareSameStaircase',coords,{x=x,y=y,z=z})
    end
    function square:getApparentZ(x,y) return hostCall('sourceApparentZ',coords,x,y) end
    function square:getTotalWeightOfItemsOnFloor()
        return hostCall('containerState',qa('floorContainer',coords.x,coords.y,coords.z),0).contentsWeight
    end
    function square:AddWorldInventoryItem(entry,x,y,z)
        assert(z==0,'unsupported source world item elevation')
        transferOperation(entry,4,qa('floorContainer',coords.x,coords.y,coords.z),coords.x+x,coords.y+y,coords.z)
        return entry
    end
    function square:removeWorldObject(value) transferOperation(value:getItem(),3) end
    -- These are live native list views, not copied item/door stores or a frozen floor selection.
    local ground=indexedCollection(
        function() return qa('worldItemCount',coords.x,coords.y,coords.z) end,
        function(index) return worldItem(qa('worldItemGet',coords.x,coords.y,coords.z,index)) end)
    local objects=indexedCollection(
        function() return qa('squareDoorCount',coords.x,coords.y,coords.z)+ground:size() end,
        function(index)
            local count=qa('squareDoorCount',coords.x,coords.y,coords.z)
            if index<count then return door(qa('doorId',qa('squareDoorGet',coords.x,coords.y,coords.z,index))) end
            return ground:get(index-count)
        end)
    -- This native query proves the CURRENT admitted world, not absence from original maps or dynamic saves.
    local staticMoving=indexedCollection(function()
        local count=qa('squareStaticMovingObjectCount',coords.x,coords.y,coords.z)
        assert(count==0,'unsupported native static-moving object representation')
        return count
    end)
    function square:getWorldObjects() return ground end
    function square:getObjects() return objects end
    function square:getStaticMovingObjects() return staticMoving end
    function square:getVehicleContainer()
        local row=assert(hostCall('square',coords.x,coords.y,coords.z),'native source square unavailable')
        -- Original searches nearby chunks for an intersecting BaseVehicle, not a synthesized item container.
        -- The admitted world has no vehicle producer/store; contrary or unknown metadata must not become nil.
        assert(row.vehicleObstructed==false,'unsupported native intersecting vehicle representation')
        return nil
    end
    function square:transmitRemoveItemFromSquare(value)
        assert(eventScope and eventScope.event==5 and itemIds[value],'world removal requires a source item perform')
        -- The original transmit precedes real local removal; it does not mutate ownership.
    end
    return square
end
local function corpseContainersInObjects(objects)
    hostCall('state')
    assert(objects==nil or rawType(objects)=='table','expected source world object array')
    local function visit(value)
        if value==nil then return end
        local label=nativeTypes[value]
        if value==player then
            -- Native self-selection searches surrounding world containers, not the player's inventory.
            -- The current typed world has only containerless doors/flat world items, including adjacent squares.
            visit((assert(player:getCurrentSquare(),'source corpse-context player square unavailable')))
        elseif label=='IsoGridSquare' and squareRecords[value] then
            -- An empty-tile context uses the port's genuine square as its context anchor.
            local list=value:getObjects()
            for i=0,list:size()-1 do visit(list:get(i)) end
        elseif label=='IsoDoor' and doorObjects[value.__doorId]==value then
            hostCall('door',value.__doorId)
        elseif label=='IsoWorldInventoryObject' and worldItems[itemIds[value]]==value then
            hostCall('item',itemIds[value])
        else
            rawError(fault('unsupported corpse-context world object '..tostring(label)),2)
        end
    end
    for index=1,objects and #objects or 0 do visit(objects[index]) end
    -- IsoObject.getContainers reads the object's own container, not an item/floor/player inventory.
    -- Neither supported world-object constructor owns one; other world/container types fail above.
    local values={}
    return collection(function() return values end)
end
local function corpseContainersInSquare(square,allowNil)
    if square==nil and allowNil then return corpseContainersInObjects(nil) end
    assert(squareRecords[square],'expected native corpse-context square')
    return corpseContainersInObjects({square})
end
function player:getContextWorldContainersWithHumanCorpse(objects)
    assert(self==player,'expected native corpse-context player')
    return corpseContainersInObjects(objects)
end
function player:getSuitableContainersWithHumanCorpseInSquare(square)
    assert(self==player,'expected native corpse-context player')
    return corpseContainersInSquare(square,false)
end
function player:getContextWorldSuitableContainersToDropCorpseInObjects(objects)
    assert(self==player,'expected native corpse-context player')
    return corpseContainersInObjects(objects)
end
function player:getSuitableContainersToDropCorpseInSquare(square)
    assert(self==player,'expected native corpse-context player')
    return corpseContainersInSquare(square,true)
end
AdjacentFreeTileFinder={}
function AdjacentFreeTileFinder.Find(square,character,excluded)
    assert(character==player and excluded==nil,'unsupported source adjacency exclusions')
    local coords=assert(squareRecords[square],'expected native square')
    local result=qa('findAdjacent',coords)
    return result and cell:getGridSquare(result.x,result.y,result.z) or nil
end
function AdjacentFreeTileFinder.FindWindowOrDoor(square,value,character)
    assert(character==player and value.__doorId,'expected native source door')
    local coords=assert(squareRecords[square],'expected native square')
    local result=qa('findAdjacent',coords,value.__doorId)
    return result and cell:getGridSquare(result.x,result.y,result.z) or nil
end
function AdjacentFreeTileFinder.isTileOrAdjacent(first,second)
    return first:getZ()==second:getZ() and math.abs(first:getX()-second:getX())<=1 and math.abs(first:getY()-second:getY())<=1
end
function screenToIsoX(index,x,y,z) assert(index==0);return worldContext('screenToIso',x,y,z).x end
function screenToIsoY(index,x,y,z) assert(index==0);return worldContext('screenToIso',x,y,z).y end
-- The Java wrapper is an adapter over the genuine Lua widget, never another menu.
ISContextMenuWrapper={new=function(_,value)
    assert(rawType(value)=='table' and value.addOption,'expected original ISContextMenu')
    return value
end}
local function highlight(option,values,multiple)
    local source=assert(ISWorldObjectContextMenu,'original source menu unavailable')
    option.onHighlight=multiple and source.handleGrabWorldItem_onHighlightMultiple or source.handleGrabWorldItem_onHighlight
    option.onHighlightParams={multiple and values or values[1]}
end
ItemContainer={
    new=function(name,parent,containingItem)
        assert(name=='floor' and parent==nil and containingItem==nil,'unsupported original container constructor')
        return newFloorView()
    end,
    floatingPointCorrection=function(weight) return qa('floatingPointCorrection',weight) end,
}
ISWorldObjectContextMenuLogic={}
function ISWorldObjectContextMenuLogic.fetch(fetch,value,index,doSquare)
    assert(index==0 and doSquare==true,'unsupported source context fetch mode')
    local square=value:getSquare()
    assert(square,'source context object has no native square')
    local label=nativeTypes[value]
    assert(label=='IsoDoor' or label=='IsoWorldInventoryObject' or label=='IsoGridSquare','unsupported source context object '..tostring(label))
    fetch.c=(fetch.c or 0)+1
    fetch.item=value
    fetch.clickedSquare=square
    fetch.building=square:getBuilding()
    local objects=square:getWorldObjects()
    if not objects:isEmpty() then fetch.worldItem=objects:get(0) end
    if label=='IsoDoor' then
        local row=hostCall('door',value.__doorId)
        fetch.door=value
        fetch.doorKeyId=row.keyId~=-1 and row.keyId or nil
    end
    ISWorldObjectContextMenu.fetchSquares[square]=true
end
local function grabEntries(fetch,context,index,worldobjects,x,y,test)
    if player:getVehicle() or core:getGameMode()=='LastStand' then return false end
    if test then return true end
    local squareSet,squareList={},{}
    for _,value in ipairs(worldobjects) do local square=value:getSquare();if square and not squareSet[square] then squareSet[square]=true;squareList[#squareList+1]=square end end
    local placement={}
    local candidates,seen={},{}
    if JoypadState.players[index+1] then
        for _,square in ipairs(squareList) do
            local list=square:getWorldObjects()
            for i=0,list:size()-1 do
                local value=list:get(i)
                if not seen[value] then seen[value]=true;candidates[#candidates+1]=value end
            end
        end
    else
        local clicked={}
        for _,square in ipairs(squareList) do clicked[#clicked+1]=square end
        for _,square in ipairs(clicked) do
            local position=worldContext('screenToIso',x,y,square:getZ())
            for sy=math.floor(position.y-1),math.ceil(position.y+1) do
                for sx=math.floor(position.x-1),math.ceil(position.x+1) do
                    local value=cell:getGridSquare(sx,sy,square:getZ())
                    if value and not squareSet[value] then squareSet[value]=true;squareList[#squareList+1]=value end
                end
            end
        end
        local zoom=core:getZoom(index)
        assert(rawType(zoom)=='number' and zoom>0 and zoom<math.huge,'source context zoom unavailable')
        local radius=48/zoom
        for _,square in ipairs(squareList) do
            local list=square:getWorldObjects()
            for i=0,list:size()-1 do
                local value=list:get(i)
                local sx,sy=value:getScreenPosX(index),value:getScreenPosY(index)
                if (sx-x)^2+(sy-y)^2<=radius^2 and not seen[value] then
                    seen[value]=true;candidates[#candidates+1]=value
                end
            end
        end
    end
    if #candidates==0 then return false end
    local groups,names={},{}
    for _,value in ipairs(candidates) do
        local name=value:getItem():getName()
        if not groups[name] then groups[name]={};names[#names+1]=name end
        table.insert(groups[name],value)
    end
    local option=context:addOption(getText('ContextMenu_Grab'),worldobjects,nil)
    local submenu=ISContextMenu:getNew(context)
    context:addSubMenu(option,submenu)
    for _,name in ipairs(names) do
        local values=groups[name]
        local first=values[1]
        if first:getSquare():isWallTo(player:getSquare()) then context:removeLastOption();return false end
        local display=#values>1 and string.format('%s (%d)',name,#values) or name
        if #values>2 or (#values==2 and first:getItem():getActualWeight()>=3) then
            local parent=submenu:addOption(display,worldobjects,nil)
            highlight(parent,values,true)
            local nested=ISContextMenu:getNew(submenu);submenu:addSubMenu(parent,nested)
            nested:addOption(getText('ContextMenu_Grab_one'),worldobjects,ISWorldObjectContextMenu.onGrabWItem,first,index)
            if #values>2 then nested:addOption(getText('ContextMenu_Grab_half'),worldobjects,ISWorldObjectContextMenu.onGrabHalfWItems,values,index) end
            nested:addOption(getText('ContextMenu_Grab_all'),worldobjects,ISWorldObjectContextMenu.onGrabAllWItems,values,index)
        else
            local entry=submenu:addOption(display,worldobjects,ISWorldObjectContextMenu.onGrabAllWItems,values,index)
            highlight(entry,values,false)
            entry.itemForTexture=first:getItem()
        end
        local definition=hostCall('itemDefinition',first:getItem():getFullType())
        if definition.worldStaticModel or definition.clothingItem or definition.type=='Weapon' then
            placement[name]=values
        end
    end
    if next(placement) and not JoypadState.players[index+1] then
        local rootOption=context:addOption(getText('ContextMenu_ExtendedPlacement'),nil,nil)
        local submenu=ISContextMenu:getNew(context);context:addSubMenu(rootOption,submenu)
        local names={}
        for name in pairs(placement) do names[#names+1]=name end
        table.sort(names)
        for _,name in ipairs(names) do
            local values=placement[name]
            local receiver=submenu
            if #values>2 and #names>1 then
                local entry=submenu:addOption(name,worldobjects,nil)
                entry.itemForTexture=values[1]:getItem();highlight(entry,values,true)
                receiver=ISContextMenu:getNew(submenu);submenu:addSubMenu(entry,receiver)
            end
            for _,value in ipairs(values) do
                local entry=receiver:addOption(name,value,ISWorldObjectContextMenu.onExtendedPlacement,player)
                entry.itemForTexture=value:getItem();highlight(entry,{value},false)
            end
        end
    end
    return false
end
function ISWorldObjectContextMenuLogic.createMenuEntries(fetch,widget,index,worldobjects,x,y,test)
    local context=ISContextMenuWrapper:new(widget)
    player:getInventory();player:getBodyDamage()
    assert(index==0,'only current standalone source viewport is supported')
    fetch.safehouseAllowInteract=not isClient()
    if debugState.enabled then rawError(fault('unsupported original world debug-menu callbacks'),2) end
    if grabEntries(fetch,context,index,worldobjects,x,y,test) then return true end
    if fetch.door then
        if test then return true end
        local rootOption=context:addOption(getText('ContextMenu_Door_option'),nil,nil)
        local submenu=ISContextMenu:getNew(context);context:addSubMenu(rootOption,submenu)
        local doorValue=fetch.door
        local row=hostCall('door',doorValue.__doorId)
        assert(row.keyId==-1 and not row.lockedByKey,'unsupported original keyed-door context')
        assert(not row.hoppable,'unsupported original climbable-door context')
        local curtain=doorValue:HasCurtains()
        if curtain then
            submenu:addGetUpOption(getText(curtain:isCurtainOpen() and 'ContextMenu_Close_curtains' or 'ContextMenu_Open_curtains'),
                worldobjects,ISWorldObjectContextMenu.onOpenCloseCurtain,doorValue,index)
            ISWorldObjectContextMenu.addRemoveCurtainOption(submenu,worldobjects,doorValue,index)
        elseif doorValue:canAddCurtain() and inventory:containsTypeRecurse('Sheet') then
            local option=submenu:addGetUpOption(getText('ContextMenu_Add_sheet'),worldobjects,ISWorldObjectContextMenu.onAddSheet,doorValue,index)
            option.iconTexture=getTexture('Item_Sheet')
        end
        local label=getText(row.open and 'ContextMenu_Close_door' or 'ContextMenu_Open_door')
        local entry=submenu:addGetUpOption(label,worldobjects,ISWorldObjectContextMenu.onOpenCloseDoor,doorValue,index)
        if not JoypadState.players[index+1] then
            local tooltip=ISWorldObjectContextMenu.addToolTip()
            tooltip:setName(getText('ContextMenu_Info'))
            tooltip.description=getText('Tooltip_OpenClose',worldContext('interactKeyName'))
            entry.toolTip=tooltip
        end
        entry.notAvailable=not doorValue:couldBeOpen(player)
        if entry.notAvailable then
            local tooltip=ISWorldObjectContextMenu.addToolTip()
            tooltip:setName(getText('Tooltip_DoorIsLocked'));entry.toolTip=tooltip
        end
    end
    return false
end
function __pz_context_call(target,name,...)
    local args=table.pack(...)
    local selecting=target.Type=='ISContextMenu' and target:getIsVisible() and
        (name=='onMouseUp' or (name=='onJoypadDown' and Joypad and args[1]==Joypad.AButton))
    if selecting and name=='onMouseUp' and target:getScrollHeight()>target:getScrollAreaHeight() then
        local top=target.padTopBottom+target.scrollIndicatorHgt-target:getYScroll()
        if args[2]<top or args[2]>=top+target:getScrollAreaHeight() then selecting=false end
    end
    local option=selecting and target.mouseOver and target.options[target.mouseOver] or nil
    if not option or not option.onSelect or option.notAvailable or option.isDisabled then
        if target[name] then return target[name](target,table.unpack(args,1,args.n)) end
        return
    end
    local source=assert(ISWorldObjectContextMenu,'original source menu unavailable')
    local owner=context()
    local changes={}
    local permits
    if option.onSelect==ISContextMenu.onGetUpAndThen and option.param1==source.onOpenCloseDoor then
        local result=qa('resolveContextAction',{type='toggleDoor',id=assert(option.param3.__doorId)},owner.apiId or owner.id)
        if not result then return end
        assert(result.type=='toggleDoor','unsupported original door hook replacement action '..tostring(result.type))
        assert(hostCall('door',result.id),'source door hook replacement is unavailable')
        qa('doorOrdinal',result.id)
        changes[1]={target=option,key='param3',value=option.param3,replacement=door(result.id)}
    elseif option.onSelect==source.onGrabWItem or option.onSelect==source.onGrabAllWItems or option.onSelect==source.onGrabHalfWItems then
        local single=option.onSelect==source.onGrabWItem
        local values=single and {option.param1} or option.param1
        local count=option.onSelect==source.onGrabHalfWItems and math.ceil(#values/2) or #values
        permits={cursor=0}
        local accepted=0
        for index=1,count do
            local original=values[index]
            local originalId=assert(itemIds[original],'source selected item has no native identity')
            local result=qa('resolveContextAction',{type='pickup',id=originalId},owner.apiId or owner.id)
            if result then assert(result.type=='pickup','unsupported original grab hook replacement action '..tostring(result.type)) end
            if result then
                local record=assert(hostCall('item',result.id),'source grab hook replacement is unavailable')
                assert(record.worldPosition~=nil,'source grab hook replacement is not a ground world item')
            end
            local targetId=result and result.id or originalId
            permits[#permits+1]={targetId=targetId,cancelled=result==nil}
            if result then
                accepted=accepted+1
                if targetId~=originalId then
                    local receiver,key=single and option or values,single and 'param1' or index
                    changes[#changes+1]={target=receiver,key=key,value=receiver[key],replacement=worldItem(targetId)}
                end
            end
        end
        if accepted==0 then return end
    elseif option.onSelect==source.onExtendedPlacement then
        rawError(fault('unsupported original extended-placement action'),2)
    elseif option.onSelect==ISContextMenu.onGetUpAndThen and
        (option.param1==source.onOpenCloseCurtain or option.param1==source.onAddSheet or option.param1==source.onRemoveCurtain) then
        rawError(fault('unsupported original curtain action'),2)
    end
    assert(selectionPermits==nil,'recursive original context selection')
    for _,change in ipairs(changes) do change.target[change.key]=change.replacement end
    selectionPermits=permits
    local result=table.pack(pcall(function()
        return target[name](target,table.unpack(args,1,args.n))
    end))
    selectionPermits=nil
    sourceAdmissionPermit=nil
    for _,change in ipairs(changes) do change.target[change.key]=change.value end
    if not result[1] then rawError(result[2],0) end
    return table.unpack(result,2,result.n)
end
local sourceMenuRoot
local sourceMenuPaths={}
function __pz_source_visibility(target, visible)
    if target==sourceMenuRoot and not visible then
        sourceMenuRoot=nil
        sourceMenuPaths={}
        hostCall('sourceMenuMirror',nil)
    elseif sourceMenuPaths[target] then
        hostCall('sourceMenuVisibility',sourceMenuPaths[target],visible)
    end
end
local function mirror(menu)
    local owner=context()
    sourceMenuPaths={}
    local function tree(value,path)
        local result={}
        for index,option in ipairs(value.options) do
            local childPath={table.unpack(path)}
            childPath[#childPath+1]=index-1
            local submenu=option.subOption and value:getSubMenu(option.subOption) or nil
            local children
            if submenu then
                sourceMenuPaths[submenu]=childPath
                children=tree(submenu,childPath)
            end
            result[#result+1]={name=option.name,disabled=option.notAvailable==true or option.isDisabled==true,
                expanded=submenu and submenu:isVisible() or false,children=children}
        end
        if #result>0 then return result end
    end
    local function select(indices)
        return guarded(owner,function()
            assert(sourceMenuRoot==menu and menu:isVisible(),'source context menu is hidden or replaced')
            local currentMenu=menu
            local option
            for position,index in ipairs(indices) do
                assert(rawType(index)=='number' and index%1==0 and index>=0,'invalid source menu index')
                option=assert(currentMenu.options[index+1],'source menu option disappeared')
                assert(not option.notAvailable and not option.isDisabled,'source menu option unavailable')
                if position<#indices then
                    currentMenu=assert(option.subOption and currentMenu:getSubMenu(option.subOption),'source option has no submenu')
                end
            end
            assert(option and option.onSelect,'source menu option is not actionable')
            currentMenu:setVisible(true)
            currentMenu.mouseOver=option.id
            currentMenu:ensureVisible()
            local y=currentMenu.padTopBottom+1
            if currentMenu:getScrollHeight()>currentMenu:getScrollAreaHeight() then y=y+currentMenu.scrollIndicatorHgt-currentMenu:getYScroll() end
            __pz_context_call(currentMenu,'onMouseUp',1,y)
        end)
    end
    local function close() return guarded(owner,function()
        if sourceMenuRoot==menu then menu:closeAll() end
    end) end
    sourceMenuRoot=menu
    hostCall('sourceMenuMirror',tree(menu,{}),select,close)
end
do
    -- Fresh client registration metadata only. No global-object import, producer, spatial lookup or persistence is modeled.
    local systems,byName={},{}
    CGlobalObjects=nativeObject('CGlobalObjects')
    function CGlobalObjects.getSystemCount()
        hostCall('sourceOwnerAlive')
        return #systems
    end
    function CGlobalObjects.getSystemByIndex(index)
        hostCall('sourceOwnerAlive')
        assert(rawType(index)=='number' and index%1==0,'expected native global-system index')
        return systems[index+1]
    end
    function CGlobalObjects.getSystemByName(name)
        hostCall('sourceOwnerAlive')
        return byName[name]
    end
    function CGlobalObjects.registerSystem(name)
        hostCall('sourceOwnerAlive')
        if name~='campfire' then
            rawError(fault('unsupported native client global-object system: '..tostring(name)),2)
        end
        if byName[name] then return byName[name] end
        local system=nativeObject('CGlobalObjectSystem')
        local data,objects={},{}
        local function owned(self)
            assert(rawEqual(self,system),'expected resident client global-object system')
            hostCall('sourceOwnerAlive')
        end
        function system:getName() owned(self);return name end
        function system:getModData() owned(self);return data end
        function system:getObjectCount() owned(self);return #objects end
        systems[#systems+1],byName[name]=system,system
        return system
    end
end
local initializedClientSystems=false
function __pz_client_systems()
    if initializedClientSystems then return end
    local campfire=modules['camping/ccampfiresystem']
    if campfire then
        assert(campfire.engineSource,'client-system bootstrap requires original engine source')
        require 'Camping/CCampfireSystem'
        __pz_dispatch('OnCGlobalObjectSystemInit')
    end
    local entityUI=modules['entity/isentityui']
    if entityUI then
        assert(entityUI.engineSource,'entity UI bootstrap requires original engine source')
        require 'luautils'
        string.trim=luautils.trim
        string.split=luautils.split
        require 'Entity/ISEntityUI'
        -- Read original window preferences while failure still discards the uncommitted candidate.
        ISEntityUI.EnsurePlayers()
    end
    initializedClientSystems=true
end

local function inventoryPageObjects()
    require 'ISUI/ISInventoryPage'
    require 'ISUI/PlayerData/ISPlayerDataObject'
    -- The genuine post-save callback accesses these classes even when no world menu was opened.
    require 'BuildingObjects/ISMoveableCursor'
    require 'RadioCom/ISRadioWindow'
    require 'ISUI/PlayerData/ISPlayerData'
    if ISLayoutManager.layouts==nil then ISLayoutManager.ReadIni() end
    local data=getPlayerData(0)
    if not data then
        data=ISPlayerDataObject:new(0)
        ISPlayerData[1]=data
    end
    if not data.playerInventory then
        data.playerInventory=ISInventoryPage:new(0,0,320,250,inventory,true,1.34)
        data.lootInventory=ISInventoryPage:new(0,0,320,250,ISInventoryPage.GetFloorContainer(0),false,1.34)
        data.playerInventory.player=0
        data.lootInventory.player=0
    end
    if not data.contextMenu then
        require 'ISUI/ISContextMenu'
        local menu=ISContextMenu:new(0,0,1,1,1.5)
        menu:initialise();menu:instantiate();menu:addToUIManager();menu:setVisible(false)
        data.contextMenu=menu
    end
    return data
end
local initializedInventoryPage
function __pz_inventory_pages()
    if initializedInventoryPage and getPlayerInventory(0)==initializedInventoryPage then return end
    -- This visual phase follows genuine startup; do not register its OnGameStart hook in the headless factory.
    require 'ISUI/ISUIHandler'
    require 'ISUI/ISToolTipInv'
    local data=inventoryPageObjects()
    require 'ISUI/ISResizeableButton'
    require 'ISUI/ISScrollBar'
    require 'Entity/ISEntityUI'
    require 'Entity/ISUI/BuildRecipe/ISBuildPanel'
    require 'Entity/ISUI/CraftRecipe/ISHandCraftPanel'
    local bind=player:getJoypadBind()
    assert(bind==-1,'unsupported inventory joypad controller')
    local pages={data.playerInventory,data.lootInventory}
    -- Original construction publishes player only after its children, and loot immediately before its children.
    -- Keep the headless identities, but never expose the other uninstantiated page to original controls.
    data.playerInventory,data.lootInventory=nil,nil
    data:placeInventoryScreens(0,getNumActivePlayers(),true)
    for index,page in ipairs(pages) do
        if index==2 then data.lootInventory=page end
        local suffix=tostring(index)
        page:setX(data['x'..suffix]);page:setY(data['y'..suffix])
        page:setWidth(data['w'..suffix]);page:setHeight(data['h'..suffix])
        page:initialise()
        page:setUIName(index==1 and 'inventory0' or 'loot0')
        page:addToUIManager()
        page:setController(bind)
        page:setInfo(getText(index==1 and 'UI_InventoryInfo' or 'UI_LootInfo'))
        page.isCollapsed=true
        page:setMaxDrawHeight(15)
        if index==1 then data.playerInventory=page end
    end
    UIManager.setPlayerInventory(0,data.playerInventory.javaObject,data.lootInventory.javaObject)
    ISLayoutManager.RegisterWindow('inventory0',ISInventoryPage,data.playerInventory)
    ISLayoutManager.RegisterWindow('loot0',ISInventoryPage,data.lootInventory)
    initializedInventoryPage=data.playerInventory
end
function __pz_world_context(request)
    assert(request.playerIndex==0 and request.z==0,'unsupported source context viewport/elevation')
    sourceMenuRoot=nil
    hostCall('sourceMenuMirror',nil)
    require 'TimedActions/ISWaitWhileGettingUp'
    require 'TimedActions/ISTimedActionQueue'
    require 'TimedActions/ISGrabItemAction'
    require 'TimedActions/ISInventoryTransferAction'
    require 'TimedActions/ISTransferAction'
    require 'TimedActions/ISOpenCloseDoor'
    require 'TimedActions/WalkToTimedAction'
    require 'luautils'
    require 'ISUI/ISContextMenu'
    require 'ISUI/ISPanelJoypad'
    require 'ISUI/ISRichTextPanel'
    require 'ISUI/ISToolTip'
    require 'ISUI/ISToolTipInv'
    require 'ISUI/ISInventoryItem'
    inventoryPageObjects()
    require 'ISUI/ISScrollingListBox'
    require 'ISUI/ISTradingUI'
    require 'ISUI/ISWorldObjectContextMenu'
    local square=assert(cell:getGridSquare(request.worldX,request.worldY,request.z),'source context square unavailable')
    local objects={}
    local list=square:getObjects()
    for index=0,list:size()-1 do objects[#objects+1]=list:get(index) end
    if #objects==0 then
        function square:getSquare() return self end
        objects[1]=square
    end
    local menu=ISWorldObjectContextMenu.createMenu(request.playerIndex,objects,request.screenX,request.screenY,false)
    if menu then mirror(menu) end
    return menu~=nil
end
`;

export { createContextKeyInput, createSourceContextSelector, pickSourceContextAction, sourceContextDirections, WORLD_CONTEXT_PRELUDE };
