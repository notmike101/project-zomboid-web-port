/** @file Native-backed original world-context logic; original Lua widgets and callbacks stay resident. */
export const WORLD_CONTEXT_PRELUDE = String.raw`
local contextOptions={contextMenuFont='Medium',singleContextMenu=false,timedActionGameSpeedReset=true,displayCursor=true,inventoryContainerSize=1}
local debugState={enabled=false,showContextMenuReportOptions=true}
local corpseObjects={}
local dragObjects={}
local function worldContext(name, ...) return hostCall('sourceContext',name,...) end
function core:getZoom(index) assert(index==player:getPlayerNum());return worldContext('getZoom',index) end
function core:getOptionContextMenuFont() return contextOptions.contextMenuFont end
function core:getOptionSingleContextMenu(index) assert(index==0);return contextOptions.singleContextMenu end
function core:getOptionInventoryContainerSize() return contextOptions.inventoryContainerSize end
function core:getOptionTooltipFont() return 'Small' end
function core:getOptionTimedActionGameSpeedReset() return contextOptions.timedActionGameSpeedReset end
function core:isDisplayCursor() return contextOptions.displayCursor end
function core:setDisplayCursor(value) assert(rawType(value)=='boolean');contextOptions.displayCursor=value end
function getGameSpeed() if worldContext('paused') then return 0 end;return timing('getState').multiplier end
local speeds=nativeObject('SpeedControls')
function speeds:getCurrentGameSpeed() return getGameSpeed() end
function speeds:SetCurrentGameSpeed(speed) assert(speed>0);timing('set','multiplier',speed) end
function UIManager.getSpeedControls() return speeds end
function UIManager.getMillisSinceLastRender() return timing('getState').elapsedSeconds*1000 end
local sourceKeys={}
KeybindId={}
for name,id in pairs({TOGGLE_INVENTORY='Toggle Inventory',TOGGLE_MODE='Toggle mode',RUN='Run',INTERACT='Interact',ROTATE_BUILDING='Rotate building'}) do
    local value=nativeObject('KeybindId')
    KeybindId[name]=value
    sourceKeys[value]=id
end
function core:isKey(binding,key)
    local name=sourceKeys[binding] or (binding=='Interact' and binding)
    assert(name,'unsupported source key identity')
    assert(rawType(key)=='number' and key%1==0,'expected native key code')
    local value=worldContext('keyBinding',name)
    -- An unregistered source binding is KEYBINDING_EMPTY: primary and alternate are both zero.
    if value==nil then return key==0 end
    rawError(fault('unsupported registered original key-binding modifiers'),2)
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
function cell:setDrag(value,index) assert(index==0);dragObjects[index]=value end
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
    function square:getWorldObjects() return ground end
    function square:getObjects() return objects end
    function square:transmitRemoveItemFromSquare(value)
        assert(eventScope and eventScope.event==5 and itemIds[value],'world removal requires a source item perform')
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
function inventory:containsTypeRecurse(name)
    for _,record in ipairs(hostCall('items')) do
        if record.location=='inventory' and record.fullType:match('%.([^%.]+)$')==name then return true end
    end
    return false
end
ItemContainer={new=function(name,parent,containingItem)
    assert(name=='floor' and parent==nil and containingItem==nil,'unsupported original container constructor')
    local value=nativeObject('ItemContainer')
    local explored=false
    local contents={}
    function value:getParent() return parent end
    function value:getContainingItem() return containingItem end
    function value:setExplored(input) assert(rawType(input)=='boolean');explored=input end
    function value:isExplored() return explored end
    function value:getItems() return collection(function() return contents end) end
    return value
end}
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
                assert(record.location=='ground','source grab hook replacement is not a ground item')
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
        return result
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
function __pz_world_context(request)
    assert(request.playerIndex==0 and request.z==0,'unsupported source context viewport/elevation')
    sourceMenuRoot=nil
    hostCall('sourceMenuMirror',nil)
    require 'TimedActions/ISWaitWhileGettingUp'
    require 'TimedActions/ISTimedActionQueue'
    require 'TimedActions/ISGrabItemAction'
    require 'TimedActions/ISOpenCloseDoor'
    require 'TimedActions/WalkToTimedAction'
    require 'luautils'
    require 'ISUI/ISContextMenu'
    require 'ISUI/ISPanelJoypad'
    require 'ISUI/ISRichTextPanel'
    require 'ISUI/ISToolTip'
    require 'ISUI/ISToolTipInv'
    require 'ISUI/ISInventoryItem'
    require 'ISUI/ISInventoryPage'
    require 'ISUI/PlayerData/ISPlayerDataObject'
    require 'ISUI/PlayerData/ISPlayerData'
    require 'BuildingObjects/ISMoveableCursor'
    require 'RadioCom/ISRadioWindow'
    string.trim=luautils.trim
    string.split=luautils.split
    if ISLayoutManager.layouts==nil then ISLayoutManager.ReadIni() end
    local data=getPlayerData(0)
    if not data then
        data=ISPlayerDataObject:new(0)
        ISPlayerData[1]=data
    end
    if not data.playerInventory then
        function inventory:getParent() return player end
        function inventory:getContainingItem() return nil end
        local floor=ISInventoryPage.GetFloorContainer(0)
        data.playerInventory=ISInventoryPage:new(0,0,320,250,inventory,true,1.5)
        data.lootInventory=ISInventoryPage:new(0,0,320,250,floor,false,1.5)
        data.playerInventory.player=player:getPlayerNum()
        data.lootInventory.player=player:getPlayerNum()
    end
    if not data.contextMenu then
        local menu=ISContextMenu:new(0,0,1,1,1.5)
        menu:initialise();menu:instantiate();menu:addToUIManager()
        data.contextMenu=menu
    end
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
