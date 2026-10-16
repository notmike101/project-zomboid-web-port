/**
 * Shared, trusted native-mod Lua session over pinned wasmoon 1.16.0 (Lua 5.4).
 * This is not a sandbox or a complete Kahlua VM. Source is compiled unchanged;
 * bytecode is refused. Lua 5.1 numeric, coroutine and parser differences remain.
 * Browser builds must ship runtime/wasmoon.js and runtime/glue.wasm locally.
 *
 * Player modData is ONE shared Lua table, as in PZ, not a per-caller copy. Each
 * top-level key belongs to the native package that first creates/restores it.
 * Nested writes by other packages persist through that owner's saveData handle.
 * Flush merges nativePlayerData into each detached document, preserving every
 * unrelated field and every other package namespace. Ownership survives deletes
 * until package cleanup; restored key collisions fail rather than overwrite.
 * Flush before save export, restore after save import, close before API disposal.
 * Optional game UI uses supplied original BMFont/texture/translation resources;
 * unsupported native facilities fail attributably, never through dummy globals.
 */
import { MOODLE_TYPES } from './engine.js';
import { normalItemIcon } from './item-definitions.js';
import { createContextKeyInput, WORLD_CONTEXT_PRELUDE } from './native-world-context.js';

/** @typedef {{path:string, source:string, execute?:boolean}} LuaSource */
/** @typedef {{id:string, nativeId?:string, engineSource?:boolean, api?:object, sources:LuaSource[], registerCleanup?:(cleanup:()=>void)=>void}} LuaPackage */
/** @typedef {string|number|boolean|null|JSONValue[]|{[key: string]: JSONValue}} JSONValue */

const EVENTS = new Set(['OnTick', 'OnPlayerUpdate', 'OnPlayerMove', 'OnGameStart', 'OnLoad', 'OnPostSave', 'OnResolutionChange', 'OnRightMouseDown', 'OnEquipPrimary', 'OnEquipSecondary', 'OnDestroyIsoThumpable', 'OnDoTileBuilding2', 'OnDoTileBuilding3', 'RenderOpaqueObjectsInWorld', 'OnCreatePlayer', 'OnPlayerDeath', 'OnMainMenuEnter', 'OnKeyStartPressed', 'OnKeyPressed', 'OnKeyKeepPressed', 'OnPreFillWorldObjectContextMenu', 'OnFillWorldObjectContextMenu', 'OnPressWalkTo', 'OnContainerUpdate', 'RequestTrade', 'AcceptedTrade', 'TradingUIAddItem', 'TradingUIRemoveItem', 'TradingUIUpdateState']);
const EXTERNAL_EVENTS = new Set(['OnGameStart', 'OnLoad', 'OnPostSave', 'OnResolutionChange', 'OnRightMouseDown', 'OnEquipPrimary', 'OnEquipSecondary', 'OnCreatePlayer', 'OnPlayerDeath', 'OnMainMenuEnter', 'OnKeyStartPressed', 'OnKeyPressed', 'OnKeyKeepPressed']);

EVENTS.add('OnClothingUpdated');
EVENTS.add('OnRefreshInventoryWindowContainers');
EVENTS.add('SetDragItem');
EVENTS.add('OnContextKey');
EVENTS.add('OnCGlobalObjectSystemInit');

const UI_PRELUDE = String.raw`
local function ui(operation, ...) return hostCall('ui', operation, ...) end
local collection
UITransition={
    new=function()
        local id=ui('transitionNew')
        local value=nativeObject('UITransition')
        local meta=getmetatable(value)
        meta.__gc=function() ui('transitionRelease',id) end
        setmetatable(value,meta)
        for _,name in ipairs({'init','update','fraction','setFadeIn','reset','setIgnoreUpdateTime','getElapsed','setElapsed'}) do
            value[name]=function(_,...) return ui('transition',id,name,...) end
        end
        return value
    end,
    UpdateAll=function() return ui('transitionUpdateAll') end,
}
function getISUIStackTrace(level)
    assert(type(level)=='number' and level>=0 and level%1==0, 'invalid UI stack depth')
    return traceback('', 2)
end
local textureCache = {}
function getTexture(path)
    local value = ui('texture', path)
    if not value then return nil end
    if not textureCache[path] then
        local texture = nativeObject('Texture')
        texture.__texture = path
        function texture:getWidth() return ui('texture', path).width end
        function texture:getHeight() return ui('texture', path).height end
        function texture:getWidthOrig() return ui('texture',path).widthOrig end
        function texture:getHeightOrig() return ui('texture',path).heightOrig end
        function texture:getOffsetX() return ui('texture',path).offsetX end
        function texture:getOffsetY() return ui('texture',path).offsetY end
        textureCache[path] = texture
    end
    return textureCache[path]
end
function instanceof(value, class)
    if class == 'Texture' or class == 'UIElement' then return rawType(value) == 'table' and nativeTypes[value] == class end
    rawError(fault('unsupported native class: ' .. tostring(class)), 2)
end
-- Keep native UI identity helpers private without occupying shared-chunk local slots.
do
local sourceUIObjects=setmetatable({}, {__mode='v'})
-- Host callbacks borrow targets; only live Lua ownership may retain their native-wrapper cycles.
local sourceUITargets=setmetatable({}, {__mode='v'})
-- Ephemeron edges retain a detached tree from either end without globally rooting abandoned trees.
local sourceUIParents=setmetatable({}, {__mode='k'})
local sourceUIChildren=setmetatable({}, {__mode='k'})
local sourceUIAttached={}
local sourceUIList
local function retainSourceUIRoots(ids)
    -- Borrow every boundary before native cleanup cuts any ownership edge in the forest.
    for _,id in ipairs(ids) do
        local object=sourceUIObjects[id]
        if object then sourceUIAttached[id]=object end
    end
end
UIElement = {new = function(target)
    local owner = context()
    local id
    local function callback(name, ...)
        local target=sourceUITargets[id]
        if not target then return end
        local args = table.pack(...)
        return guarded(owner, function()
            if __pz_context_call then return __pz_context_call(target,name,table.unpack(args,1,args.n)) end
            if target[name] then return target[name](target, table.unpack(args, 1, args.n)) end
        end)
    end
    id = ui('new', {retainRoots=retainSourceUIRoots,attached=function(enabled)
        local object=sourceUIObjects[id]
        local previous=object and sourceUIParents[object]
        if previous then
            sourceUIChildren[previous][object]=nil
            sourceUIParents[object]=nil
        end
        sourceUIAttached[id]=enabled and object or nil
    end,
        update = function() return callback('update') end,
        prerender = function() return callback('prerender') end,
        render = function() return callback('render') end,
        input = function(name, ...)
            local target=sourceUITargets[id]
            if not target or not target[name] then return false end
            return callback(name, ...)
        end})
    ui('element', id, 'setConsumeMouseEvents', true)
    local object = nativeObject('UIElement')
    object.__ui = id
    local meta=getmetatable(object)
    meta.__gc=function() ui('release',id) end
    setmetatable(object,meta)
    for _, name in ipairs({'getX','getY','getWidth','getHeight','getAbsoluteX','getAbsoluteY',
        'setX','setY','setWidth','setHeight','setAnchorLeft','setAnchorRight','setAnchorTop','setAnchorBottom',
        'setWantKeyEvents','setConsumeMouseEvents','setWantExtraMouseEvents','setForceCursorVisible',
        'setUIName',
        'isVisible','getIsVisible','isReallyVisible','setEnabled','isEnabled','setAlwaysOnTop','backMost','bringToTop','isMouseOver','isPointOver',
        'setScrollChildren','getScrollChildren','setScrollWithParent','getScrollWithParent','getMaxDrawHeight','setMaxDrawHeight','clearMaxDrawHeight','setCapture','isCapture',
        'getXScroll','getYScroll','setXScroll','setYScroll','getScrollHeight','setScrollHeight',
        'setStencilRect','clearStencilRect','repaintStencilRect','suspendStencil','resumeStencil',
        'DrawTextureScaled','DrawTextureScaledColor','DrawTextureScaledUniform','DrawTextureScaledAspect','DrawTexture','DrawTextureColor',
        'DrawTextRight','DrawTextCentre','DrawText'}) do
        object[name] = function(_, ...)
            local args = table.pack(...)
            if name:sub(1,11) == 'DrawTexture' and args[1] ~= nil then args[1] = args[1].__texture end
            return ui('element', id, name, table.unpack(args, 1, args.n))
        end
    end
    function object:getTable() return target end
    function object:getUIName()
        local name,class=rawget(target,'name'),rawget(target,'Type')
        local fallback=class and (name~=nil and tostring(class)..': '..tostring(name) or tostring(class)) or nil
        return ui('element',id,'getUIName',fallback)
    end
    function object:setVisible(value)
        local result = ui('element', id, 'setVisible', value)
        if __pz_source_visibility then __pz_source_visibility(target, value) end
        return result
    end
    function object:AddChild(child)
        assert(child and rawEqual(sourceUIObjects[child.__ui],child),'expected resident native UIElement')
        local result=ui('element',id,'AddChild',child.__ui)
        local previous=sourceUIParents[child]
        if previous then sourceUIChildren[previous][child]=nil end
        local children=sourceUIChildren[object]
        if not children then children={};sourceUIChildren[object]=children end
        children[child]=true
        sourceUIParents[child]=object
        return result
    end
    function object:RemoveChild(child)
        assert(child and rawEqual(sourceUIObjects[child.__ui],child),'expected resident native UIElement')
        local result=ui('element',id,'RemoveChild',child.__ui)
        if sourceUIParents[child]==object then
            sourceUIChildren[object][child]=nil
            sourceUIParents[child]=nil
        end
        return result
    end
    function object:DrawItemIcon(value,x,y,alpha,width,height)
        assert(value and (nativeTypes[value]=='InventoryItem' or nativeTypes[value]=='InventoryContainer'),'expected native inventory icon')
        assert(value:getFluidContainer()==nil and value:getTextureColorMask()==nil and value:getTextureFluidMask()==nil,'unsupported fluid or masked item icon')
        local texture=assert(value:getTex(),'original inventory icon unavailable')
        return self:DrawTextureScaledAspect(texture,x,y,width,height,value:getR(),value:getG(),value:getB(),alpha)
    end
    sourceUIObjects[id]=object
    sourceUITargets[id]=target
    return object
end}
local function playerUIReferences(operation, index, first, second)
    assert(index == getPlayer():getPlayerNum(), 'only active player zero is supported')
    assert(first == nil or nativeTypes[first] == 'UIElement', 'expected native inventory UIElement')
    assert(second == nil or nativeTypes[second] == 'UIElement', 'expected native inventory UIElement')
    return ui(operation, index, first and first.__ui or nil, second and second.__ui or nil)
end
UIManager = {
    AddUI = function(object) ui('add',object.__ui) end,
    RemoveElement = function(object) ui('remove',object.__ui) end,
    getUI = function()
        if not sourceUIList then
            sourceUIList=collection(function()
                local values=ui('getUI')
                for index,id in ipairs(values) do
                    values[index]=assert(sourceUIObjects[id],'live UI element has no resident native wrapper')
                end
                return values
            end)
        end
        return sourceUIList
    end,
    setPlayerInventory = function(index, first, second) return playerUIReferences('playerInventory', index, first, second) end,
    setPlayerInventoryTooltip = function(index, first, second) return playerUIReferences('playerInventoryTooltip', index, first, second) end,
}
end
UIFont = {Small='Small',Medium='Medium',Large='Large',NewSmall='NewSmall'}
local textManager = nativeObject('TextManager')
function textManager:MeasureStringX(font, text) return ui('measureX',font,text) end
function textManager:MeasureStringY(font, text) return ui('measureY',font,text) end
function textManager:getFontHeight(font) return ui('fontHeight',font) end
function getTextManager() ui('fontHeight','Small'); return textManager end
-- Native ObjectTooltip layout uses real font metrics and the same UI drawing primitives as source Lua.
ObjectTooltip={new=function()
    local value=UIElement.new({})
    nativeTypes[value]='ObjectTooltip'
    value.padLeft,value.padTop,value.padRight,value.padBottom=5,5,5,5
    value:setWidth(130)
    value:setHeight(130)
    local font=ui('settings').tooltipFont
    assert(font=='Small' or font=='Medium' or font=='Large','original tooltip font configuration unavailable')
    local lineSpacing=getTextManager():getFontHeight(font)
    local character,measureOnly,weightOfStack=nil,false,0
    function value:getFont() return font end
    function value:getLineSpacing() return lineSpacing end
    function value:getCharacter() return character end
    function value:setCharacter(other)
        assert(other==nil or nativeTypes[other]=='IsoPlayer','expected native tooltip character')
        character=other
    end
    function value:isMeasureOnly() return measureOnly end
    function value:setMeasureOnly(enabled)
        assert(rawType(enabled)=='boolean','expected tooltip measurement flag')
        measureOnly=enabled
    end
    function value:getWeightOfStack() return weightOfStack end
    function value:setWeightOfStack(weight)
        assert(rawType(weight)=='number','expected tooltip stack weight')
        weightOfStack=(string.unpack('f',string.pack('f',weight)))
    end
    for _,name in ipairs({'DrawText','DrawTextCentre','DrawTextRight','DrawTextureScaled','DrawTextureScaledAspect'}) do
        local draw=value[name]
        value[name]=function(self,...)
            if not measureOnly then return draw(self,...) end
        end
    end
    function value:adjustWidth(x,text)
        self:setWidth(math.max(self:getWidth(),x+textManager:MeasureStringX(font,text)+self.padRight))
    end
    function value:DrawProgressBar(x,y,width,height,fraction,r,g,b,a)
        if measureOnly then return end
        fraction=math.max(0,math.min(1,fraction))
        local filled=math.floor(width*fraction)
        self:DrawTextureScaledColor(nil,x-1,y-1,width+2,height,0.25,0.25,0.25,1)
        if fraction~=0 and fraction~=1 then
            self:DrawTextureScaledColor(nil,x+filled,y,width-filled,height-2,0.5,0.5,0.5,1)
        end
        self:DrawTextureScaledColor(nil,x,y,filled,height-2,r,g,b,a)
    end
    function value:beginLayout()
        local pad=textManager:MeasureStringX(font,'0')
        self.padLeft,self.padTop,self.padRight,self.padBottom=pad,math.floor(pad/2),pad,math.floor(pad/2)
        local layout=nativeObject('ObjectTooltip.Layout')
        local layoutIndex=getmetatable(layout).__index
        getmetatable(layout).__index=function(self,key)
            if key=='next' then return nil end
            return layoutIndex(self,key)
        end
        local rows={}
        layout.items,layout.minLabelWidth,layout.minValueWidth=collection(function() return rows end),0,0
        layout.nextPadY,layout.offsetY=0,0
        function layout:setMinLabelWidth(width) self.minLabelWidth=width end
        function layout:setMinValueWidth(width) self.minValueWidth=width end
        function layout:addItem()
            local row=nativeObject('ObjectTooltip.LayoutItem')
            local rowIndex=getmetatable(row).__index
            getmetatable(row).__index=function(self,key)
                if key=='label' or key=='value' then return nil end
                return rowIndex(self,key)
            end
            row.r0,row.g0,row.b0,row.a0,row.r1,row.g1,row.b1,row.a1=0,0,0,0,0,0,0,0
            row.labelWidth,row.valueWidth,row.valueWidthRight,row.progressWidth,row.height=0,0,0,0,0
            row.hasValue,row.couldHaveValue,row.rightJustify,row.progressFraction=false,false,false,-1
            function row:setLabel(text,r,g,b,a) self.label,self.r0,self.g0,self.b0,self.a0=text,r,g,b,a end
            function row:setValue(text,r,g,b,a)
                self.value,self.r1,self.g1,self.b1,self.a1=text,r,g,b,a
                self.hasValue,self.rightJustify=true,true
            end
            function row:setValueRight(number,positiveIsGood)
                number=math.modf(number)
                local settings=ui('settings')
                local bad=(number<0 and positiveIsGood) or (number>0 and not positiveIsGood)
                local tint=bad and settings.badHighlight or settings.goodHighlight
                self:setValue((number>0 and '+' or '')..tostring(number),tint.r,tint.g,tint.b,1)
            end
            function row:setValueRightNoPlus(number)
                local rounded=math.modf((number+0.005)*100)/100
                self:setValue(math.type(number)=='integer' and tostring(number) or tostring(rounded),1,1,1,1)
            end
            function row:setProgress(fraction,r,g,b,a)
                self.progressFraction,self.r1,self.g1,self.b1,self.a1=fraction,r,g,b,a
                self.hasValue=true
            end
            function row:reset()
                self.label,self.value=nil,nil
                self.hasValue,self.couldHaveValue,self.rightJustify,self.progressFraction=false,false,false,-1
            end
            function row:calcSizes()
                self.labelWidth,self.valueWidth,self.valueWidthRight,self.progressWidth=0,0,0,0
                if self.label then self.labelWidth=textManager:MeasureStringX(font,self.label) end
                if self.hasValue then
                    if self.value then
                        local width=textManager:MeasureStringX(font,self.value)
                        if self.rightJustify then self.valueWidthRight=width else self.valueWidth=width end
                    elseif self.progressFraction~=-1 then self.progressWidth=80 end
                end
                local function lines(text) local _,count=(text or ''):gsub('\n','');return count+1 end
                self.height=math.max(lines(self.label),self.hasValue and lines(self.value) or 1)*lineSpacing
            end
            function row:render(x,y,valueX,rightWidth,tooltip)
                if self.label then tooltip:DrawText(font,self.label,x,y,self.r0,self.g0,self.b0,self.a0) end
                if self.value then
                    if self.rightJustify then
                        tooltip:DrawTextRight(font,self.value,x+valueX+rightWidth,y,self.r1,self.g1,self.b1,self.a1)
                    else tooltip:DrawText(font,self.value,x+valueX,y,self.r1,self.g1,self.b1,self.a1) end
                end
                if self.progressFraction~=-1 then
                    tooltip:DrawProgressBar(x+valueX,y+math.floor(lineSpacing/2)-1,rightWidth,
                        font=='Large' and 7 or font=='Medium' and 6 or 5,
                        self.progressFraction,self.r1,self.g1,self.b1,self.a1)
                end
            end
            rows[#rows+1]=row
            return row
        end
        function layout:render(x,y,tooltip)
            local label,left,right,progress,width,valueX=self.minLabelWidth,self.minValueWidth,self.minValueWidth,0,0,0
            local gap=math.max(8,textManager:MeasureStringX(font,'W'))
            for _,row in ipairs(rows) do
                row:calcSizes()
                if row.hasValue then
                    label,left,right,progress=math.max(label,row.labelWidth),math.max(left,row.valueWidth),
                        math.max(right,row.valueWidthRight),math.max(progress,row.progressWidth)
                    valueX=math.max(valueX,math.max(row.labelWidth,self.minLabelWidth)+gap)
                    width=math.max(width,label+gap+math.max(left,right,progress))
                else
                    if row.couldHaveValue then label=math.max(label,row.labelWidth) end
                    width=math.max(width,row.labelWidth)
                end
            end
            tooltip:setWidth(math.max(tooltip:getWidth(),x+width+tooltip.padRight))
            for _,row in ipairs(rows) do row:render(x,y,valueX,right,tooltip);y=y+row.height end
            if self.next then return self.next:render(x,y+self.next.nextPadY,tooltip) end
            return y
        end
        function layout:free()
            rows={}
            self.next=nil
            self.minLabelWidth,self.minValueWidth,self.nextPadY,self.offsetY=0,0,0,0
        end
        return layout
    end
    function value:endLayout(layout)
        while layout do
            local nextLayout=layout.next
            layout:free()
            layout=nextLayout
        end
    end
    return value
end}
function getText(key,...) return ui('text',key,...) end
function getTextOrNull(key,...) return ui('textOrNull',key,...) end
function getMouseX() return ui('mouse').x end
function getMouseY() return ui('mouse').y end
local function singlePlayer(index)
    assert(index == 0, 'only player viewport zero is supported')
    return ui('viewport')
end
function getPlayerScreenLeft(index) singlePlayer(index); return 0 end
function getPlayerScreenTop(index) singlePlayer(index); return 0 end
function getPlayerScreenWidth(index) return singlePlayer(index).width end
function getPlayerScreenHeight(index) return singlePlayer(index).height end
local function color(read, write, class)
    local value = nativeObject(class or 'Color')
    for _, pair in ipairs({{'getR','r'},{'getG','g'},{'getB','b'},{'getA','a'}}) do
        value[pair[1]] = function() return read()[pair[2]] end
    end
    if class~='ColorInfo' then
        for _,pair in ipairs({{'getRedFloat','r'},{'getGreenFloat','g'},{'getBlueFloat','b'},{'getAlphaFloat','a'}}) do
            value[pair[1]]=function() return read()[pair[2]] end
        end
    end
    if write then function value:set(r,g,b,a) write({r=r,g=g,b=b,a=a}) end end
    return value
end
Color = {gray = color(function() return ui('gray') end, function(value) ui('gray',value) end)}
ColorInfo={new=function(...)
    local args=table.pack(...)
    assert(args.n==0 or args.n==4,'ColorInfo requires zero or four float components')
    local value
    value=color(function() return value end,nil,'ColorInfo')
    for index,component in ipairs({'r','g','b','a'}) do
        local input=args.n==0 and 1 or args[index]
        assert(rawType(input)=='number','ColorInfo requires numeric components')
        value[component]=string.unpack('f',string.pack('f',input))
    end
    return value
end}
local core = nativeObject('Core')
local selectingAll=false
function core:isSelectingAll() hostCall('state');return selectingAll end
function core:setIsSelectingAll(enabled)
    assert(rawType(enabled)=='boolean','select-all state must be boolean')
    hostCall('state');selectingAll=enabled
end
function core:isDedicated() hostCall('state');return false end
function core:getScreenWidth() return ui('viewport').width end
function core:getScreenHeight() return ui('viewport').height end
function core:getOptionMoodleSize() return ui('settings').moodleSize end
function core:getOptionFontSizeReal() return ui('settings').fontSizeReal end
function core:getOptionDoContainerOutline() return ui('settings').doContainerOutline end
function core:setOptionDoContainerOutline(enabled) ui('setCoreOption','doContainerOutline',enabled) end
function core:getObjectHighlitedColor() return color(function() return ui('settings').objectHighlight end,nil,'ColorInfo') end
function core:setObjectHighlitedColor(value)
    assert(nativeTypes[value]=='ColorInfo','expected native ColorInfo')
    ui('setCoreOption','objectHighlight',{r=value:getR(),g=value:getG(),b=value:getB(),a=value:getA()})
end
function core:getWorldItemHighlightColor() return color(function() return hostCall('worldItemHighlightColor') end,nil,'ColorInfo') end
function core:saveOptions() ui('saveOptions') end
function core:getGoodHighlitedColor() return color(function() return ui('settings').goodHighlight end,nil,'ColorInfo') end
function core:getBadHighlitedColor() return color(function() return ui('settings').badHighlight end,nil,'ColorInfo') end
function getCore() hostCall('state'); return core end
PerformanceSettings = {getLockFPS = function() return ui('settings').lockFPS end}
function getFileReader(path, create)
    assert(rawType(create)=='boolean','file create flag must be boolean')
    local text=hostCall('sourceFile','read',path,create)
    if text==nil then return nil end
    local reader=nativeObject('BufferedReader')
    local position,closed=1,false
    function reader:readLine()
        assert(not closed,'file reader is closed')
        if position>#text then return nil end
        local first,last=text:find('['..string.char(13,10)..']',position)
        if not first then
            local line=text:sub(position)
            position=#text+1
            return line
        end
        local line=text:sub(position,first-1)
        position=last+1
        if text:byte(first)==13 and text:byte(position)==10 then position=position+1 end
        return line
    end
    function reader:close() closed=true end
    return reader
end
function getFileWriter(path, create, append)
    assert(rawType(create)=='boolean' and rawType(append)=='boolean','file writer flags must be boolean')
    if hostCall('sourceFile','read',path,create)==nil then return nil end
    local writer=nativeObject('BufferedWriter')
    local chunks,closed={},false
    function writer:write(text)
        assert(not closed,'file writer is closed')
        assert(rawType(text)=='string','file writer expects text')
        chunks[#chunks+1]=text
    end
    function writer:close()
        if closed then return end
        hostCall('sourceFile','write',path,table.concat(chunks),append)
        closed=true
        chunks={}
    end
    return writer
end
PZAPI = {ModOptions = {create = function(_, id, title)
    local saved = hostCall('readOptions',id) or {}
    local options = {modOptionsID=id,title=title,settings={}}
    local function add(key,label,kind,default,tooltip)
        assert(type(key)=='string' and options.settings[key]==nil, 'duplicate/invalid mod option ID')
        local setting = {id=key,label=label,kind=kind,tooltip=tooltip,default=default,value=saved[key]}
        if setting.value == nil then setting.value=default end
        function setting:getValue() return self.kind=='color' and self.color or self.value end
        function setting:setValue(value)
            if self.kind=='tickbox' then assert(type(value)=='boolean','tickbox value must be boolean');self.value=value
            else assert(type(value)=='table','color value required');self.color=value end
        end
        if kind=='color' then setting.color=setting.value end
        options.settings[key]=setting
        return setting
    end
    function options:addTickBox(key,label,value,tooltip) return add(key,label,'tickbox',value,tooltip) end
    function options:addColorPicker(key,label,r,g,b,a,tooltip) return add(key,label,'color',{r=r,g=g,b=b,a=a},tooltip) end
    function options:apply()
        local values={}
        for key,setting in pairs(self.settings) do
            local value=setting:getValue()
            if setting.kind=='color' then
                for _,component in ipairs({'r','g','b','a'}) do assert(type(value[component])=='number' and value[component]>=0 and value[component]<=1,'color components must be 0..1') end
            else assert(type(value)=='boolean','tickbox value must be boolean') end
            values[key]=value
        end
        hostCall('writeOptions',self.modOptionsID,values)
    end
    optionRegistry[#optionRegistry + 1] = {owner = context(), options = options}
    return options
end}}
local itemCache = {}
local itemIds = setmetatable({}, {__mode='k'})
local container,sourceItem
local function item(id)
    if id == nil then return nil end
    if itemCache[id] then return itemCache[id] end
    local inner=hostCall('item',id,'internalContainerId')
    local value=nativeObject(inner and 'InventoryContainer' or 'InventoryItem')
    local function field(name) return hostCall('item',id,name) end
    function value:getFullType() return field('fullType') end
    function value:getCondition() return field('condition') end
    function value:getConditionMax() return hostCall('itemDefinition',field('fullType'),'conditionMax') end
    function value:getWeight() return hostCall('itemWeight',id,'weight') end
    function value:getActualWeight() return hostCall('itemWeight',id,'actualWeight') end
    function value:getContentsWeight() return hostCall('itemWeights',id).contentsWeight end
    function value:getBodyLocation()
        local name=hostCall('itemDefinition',field('fullType'),'bodyLocation')
        return name~=nil and locationObject(hostCall('equipment','lookup',name)) or nil
    end
    function value:canBeEquipped()
        local name=hostCall('itemDefinition',field('fullType'),'canBeEquipped')
        return name~=nil and locationObject(hostCall('equipment','lookup',name)) or nil
    end
    function value:getUnequippedWeight() return hostCall('itemWeights',id).unequippedWeight end
    function value:getEquippedWeight() return hostCall('itemWeights',id).equippedWeight end
    function value:getHotbarEquippedWeight() return hostCall('itemWeights',id).hotbarEquippedWeight end
    function value:getContainer()
        local owner=field('ownerContainerId')
        return owner~=0 and container(owner) or nil
    end
    function value:getOutermostContainer()
        return container(hostCall('sourceActions','itemOutermostContainer',id))
    end
    function value:getOwner()
        local current=self:getContainer()
        return current and current:getParent()==player and player or nil
    end
    function value:getPlayer()
        local outer=self:getOutermostContainer()
        return outer and outer:getParent()==player and player or self:getOwner()
    end
    function value:getInventory() return container(field('internalContainerId')) end
    if inner then
        function value:getInventoryWeight() return hostCall('sourceActions','itemInventoryWeight',id) end
    end
    function value:getEffectiveCapacity(character)
        assert(character==nil or character==player,'unsupported bag capacity actor')
        return hostCall('sourceActions','itemContainerCapacity',id,character==player and 1 or 0,true)
    end
    function value:getCapacity() return hostCall('sourceActions','itemContainerCapacity',id,0,false) end
    function value:getWeightReduction() return hostCall('itemDefinition',field('fullType'),'weightReduction') end
    function value:getCurrentCondition()
        local maximum=self:getConditionMax()
        assert(type(maximum)=='number' and maximum>0, 'unsupported item condition percentage without positive original ConditionMax')
        return self:getCondition()/maximum*100
    end
    function value:setCondition(condition) hostCall('setCondition',id,condition) end
    function value:setWeight(weight) hostCall('setWeight',id,weight) end
    function value:setActualWeight(actualWeight) hostCall('setActualWeight',id,actualWeight) end
    itemCache[id] = value
    itemIds[value] = id
    return value
end
function player:getClothingItem_Feet() return item(hostCall('worn','base:shoes')) end
function player:getWornItem(location) return item(hostCall('equipment','wornGet',locationToken(location))) end
function player:isWearingAwkwardGloves() return hostCall('isWearingAwkwardGloves') end
local inventory
function player:getInventory()
    local value=container(hostCall('playerInventoryId'))
    inventory=value
    return value
end
function player:getMaxWeight() return hostCall('inventoryState').maxWeight end
function player:getHealth() return hostCall('health') end
function player:isDead() return hostCall('isDead') end
local moodles = nativeObject('Moodles')
function moodles:getMoodleLevel(id)
    for _, value in ipairs(hostCall('moodles')) do if value.id == id then return value.level end end
    rawError(fault('unsupported moodle type: '..tostring(id)),2)
end
function player:getMoodles() hostCall('moodles'); return moodles end
MoodleType = setmetatable({}, {__index=function(_,name) return hostCall('moodleType',name) end})
Registries = {MOODLE_TYPE = {values=function()
    local values=hostCall('moodles')
    return {size=function() return #values end,get=function(_,index)
        assert(type(index)=='number' and index%1==0 and index>=0 and index<#values,'registry index out of range')
        return values[index+1].id
    end}
end}}
`;

const BODY_PRELUDE = String.raw`
local bodyNames = {'Hand_L','Hand_R','ForeArm_L','ForeArm_R','UpperArm_L','UpperArm_R',
    'Torso_Upper','Torso_Lower','Head','Neck','Groin','UpperLeg_L','UpperLeg_R',
    'LowerLeg_L','LowerLeg_R','Foot_L','Foot_R','MAX'}
local bodyTypes, bodyIndices = {}, {}
for index, name in ipairs(bodyNames) do
    local value = nativeObject('BodyPartType')
    bodyTypes[name], bodyIndices[value] = value, index - 1
end
BodyPartType = setmetatable({}, {__index = function(_, name)
    if bodyTypes[name] then return bodyTypes[name] end
    return unsupported('BodyPartType.' .. tostring(name))
end})
function BodyPartType.ToIndex(value)
    local index = bodyIndices[value]
    assert(index ~= nil, 'invalid BodyPartType')
    return index
end
function BodyPartType.FromIndex(index)
    assert(type(index) == 'number' and index % 1 == 0 and index >= 0 and index <= 17, 'body part index out of range')
    return bodyTypes[bodyNames[index + 1]]
end
local bodyParts, thermalNodes = {}, {}
local function bodyIndex(value)
    local index = BodyPartType.ToIndex(value)
    assert(index < 17, 'BodyPartType.MAX is not a body part')
    return index
end
for index = 0, 16 do
    local id = bodyNames[index + 1]
    local part, node = nativeObject('BodyPart'), nativeObject('ThermalNode')
    local function record() return hostCall('bodyPart', id) end
    for _, pair in ipairs({{'getHealth','health'}, {'getScratchTime','scratchTime'},
        {'getCutTime','cutTime'}, {'getBiteTime','biteTime'}, {'getDeepWoundTime','deepWoundTime'},
        {'getStitchTime','stitchTime'}, {'getFractureTime','fractureTime'}, {'getSplintFactor','splintFactor'},
        {'getBurnTime','burnTime'}, {'getWoundInfectionLevel','woundInfectionLevel'},
        {'getAdditionalPain','additionalPain'}, {'getStiffness','stiffness'}, {'bandaged','bandaged'},
        {'haveBullet','haveBullet'}, {'haveGlass','haveGlass'}, {'getPain','pain'},
        {'getSkinTemperature','skinTemperature'}, {'getSkinSurface','skinSurface'}, {'getDistToCore','distToCore'}}) do
        local field = pair[2]
        part[pair[1]] = function(self, ...)
            assert(select('#', ...) == 0, 'unsupported BodyPart getter overload')
            return record()[field]
        end
    end
    for _, pair in ipairs({{'SetHealth','health'}, {'setScratchTime','scratchTime'},
        {'setCutTime','cutTime'}, {'setBiteTime','biteTime'}, {'setDeepWoundTime','deepWoundTime'},
        {'setStitchTime','stitchTime'}, {'setFractureTime','fractureTime'}, {'setSplintFactor','splintFactor'},
        {'setBurnTime','burnTime'}, {'setWoundInfectionLevel','woundInfectionLevel'},
        {'setAdditionalPain','additionalPain'}, {'setStiffness','stiffness'}, {'setHaveGlass','haveGlass'}}) do
        local field = pair[2]
        part[pair[1]] = function(self, value, ...)
            assert(select('#', ...) == 0, 'unsupported BodyPart setter overload')
            hostCall('setBodyPart', id, field, value)
        end
    end
    function part:getType() record(); return bodyTypes[id] end
    function part:getIndex() record(); return index end
    function part:getThermalNode() record(); return node end
    function node:getSkinCelcius() return record().skinTemperature end
    function node:getSkinSurface() return record().skinSurface end
    function node:getDistToCore() return record().distToCore end
    bodyParts[index + 1], thermalNodes[index + 1] = part, node
end
local bodyList = nativeObject('ArrayList')
function bodyList:size() return #hostCall('bodyParts') end
function bodyList:get(index)
    assert(type(index) == 'number' and index % 1 == 0 and index >= 0 and index < 17, 'body part index out of range')
    hostCall('bodyParts')
    return bodyParts[index + 1]
end
local thermoregulator = nativeObject('Thermoregulator')
function thermoregulator:getNodeSize() return #hostCall('bodyParts') end
function thermoregulator:getNode(index)
    bodyList:get(index)
    return thermalNodes[index + 1]
end
function thermoregulator:getNodeForType(value)
    local index = BodyPartType.ToIndex(value)
    hostCall('bodyParts')
    if index == 17 then return nil end
    return thermalNodes[index + 1]
end
function thermoregulator:getTimedActionTimeModifier() return hostCall('thermalActionModifier') end
local bodyDamage = nativeObject('BodyDamage')
function bodyDamage:getBodyPart(value)
    local index = bodyIndex(value)
    hostCall('bodyParts')
    return bodyParts[index + 1]
end
function bodyDamage:getBodyParts() hostCall('bodyParts'); return bodyList end
function bodyDamage:getThermoregulator() hostCall('bodyParts'); return thermoregulator end
function player:getBodyDamage() hostCall('bodyParts'); return bodyDamage end
function player:getTimedActionTimeModifier() return hostCall('thermalActionModifier') end
`;

const ACTION_PRELUDE = String.raw`
local function qa(name, ...) return hostCall('sourceActions', name, ...) end
local function timing(name, ...) return hostCall('sourceTiming', name, ...) end
local actionIds = setmetatable({}, {__mode='k'})
local actionObjects, actionOwners, actionHandles, groupObjects = {}, {}, {}, setmetatable({}, {__mode='v'})
local sourceConstructors,sourceClasses,sourceBegun={},{},{}
local sourceMethods={}
local sourceMethodNames={'new','begin','create','adjustMaxTime','isValidStart','isValid','waitToStart',
    'start','update','perform','stop','complete','forceCancel','forceComplete','forceStop','isStarted',
    'getDuration','getJobDelta','setJobDelta','resetJobDelta','setActionAnim','setAnimVariable',
    'setOverrideHandModels','beginAddingActions','endAddingActions','transferItem','checkQueueList','setOnComplete',
    'getNotFullFloorSquare','floorHasRoomFor','canDropOnFloor','isAlreadyTransferred','canMergeAction','GetDropItemOffset','removeItemOnCharacter',
    'startActionAnim','doActionAnim','playSourceContainerOpenSound','playSourceContainerCloseSound',
    'playDestContainerOpenSound','playDestContainerCloseSound','getTransferStartSoundName',
    'getTransferCompleteSoundName','playTransferCompleteSound','stopLoopingSound','getTimeDelta'}
local sourceDoorCompletion
local restoredDoorContinuations={}
local methodOwners=setmetatable({}, {__mode='k'})
local views = setmetatable({}, {__mode='k'})
local eventScope
local selectionPermits,sourceAdmissionPermit
local forceCancelled=setmetatable({}, {__mode='k'})
local withdrawingOwners={}
local function allowSourceAdmission()
    local owner=context()
    assert(not withdrawingOwners[owner.id] and not withdrawingOwners[owner.apiId or owner.id],
        'source admission denied during owner withdrawal')
end
local worldItems, doorObjects = {}, {}
local worldItem
local actorState = {farming=false,asleep=false,dragging=false,animation=nil,variables={},events={}}
local jobs, transactions, nextTransaction = {}, {}, 1
local restoring = false
local itemVisuals={}
local sourceItemClasses={}
local function indexedCollection(size,at)
    local value=nativeObject('ArrayList')
    function value:size() return size() end
    function value:isEmpty() return size()==0 end
    function value:get(index)
        assert(rawType(index)=='number' and index%1==0 and index>=0 and index<size(),'collection index out of range')
        return at(index)
    end
    function value:contains(target)
        for index=0,size()-1 do if at(index)==target then return true end end
        return false
    end
    function value:indexOf(target)
        for index=0,size()-1 do if rawEqual(at(index),target) then return index end end
        return -1
    end
    return value
end
collection=function(read)
    local value=nativeObject('ArrayList')
    function value:size() return #read() end
    function value:isEmpty() return #read()==0 end
    function value:get(index)
        local values=read()
        assert(rawType(index)=='number' and index%1==0 and index>=0 and index<#values,'collection index out of range')
        return values[index+1]
    end
    function value:contains(target) for _,entry in ipairs(read()) do if entry==target then return true end end;return false end
    function value:indexOf(target)
        for index,entry in ipairs(read()) do if rawEqual(entry,target) then return index-1 end end
        return -1
    end
    return value
end
local function categoryItems(items,category)
    assert(rawType(category)=='string','expected nonnull item category')
    local matches={}
    for index=0,items:size()-1 do
        local entry=items:get(index)
        if entry:getCategory()==category then matches[#matches+1]=entry end
    end
    return collection(function() return matches end)
end
local containerCache,containerIds={},setmetatable({}, {__mode='k'})
local function containerPolicy(value,entry)
    local row=hostCall('container',assert(containerIds[value],'expected native container'))
    local function result(allowed)
        if eventScope then
            eventScope.containerPolicies=eventScope.containerPolicies or {}
            eventScope.containerPolicies[tostring(containerIds[value])..':'..tostring(itemIds[entry])]=allowed
        end
        return allowed
    end
    if row.onlyAcceptCategory and row.onlyAcceptCategory:lower()~=entry:getCategory():lower() then return result(0) end
    if not row.acceptItemFunction then return result(1) end
    local fn=root
    for key in row.acceptItemFunction:gmatch('[^.]+') do
        if rawType(fn)~='table' then fn=nil;break end
        fn=rawget(fn,key)
    end
    if fn==nil then return result(1) end
    local ok,allowed=pcall(fn,value,entry)
    return result(ok and allowed==true and 1 or 0)
end
local function transferOperation(entry,operation,owner,x,y,z)
    assert(eventScope and eventScope.event==5 and eventScope.transferItemId==itemIds[entry],
        'item mutation requires its authorized source helper transaction')
    if operation==3 and eventScope.worldRemoved then return end
    if operation==3 then owner=eventScope.transferSourceContainerId end
    local result=qa('transferOperation',eventScope.actionId,itemIds[entry],eventScope.token,operation,owner or 0,x or 0,y or 0,z or 0)
    if operation==3 then eventScope.worldRemoved=true end
    return result
end
container=function(id)
    if id==nil then return nil end
    if containerCache[id] then return containerCache[id] end
    local value=nativeObject('ItemContainer')
    local function record() return assert(hostCall('container',id),'native container unavailable') end
    local function state(actor) return hostCall('containerState',id,actor==player and 1 or 0) end
    function value:getID() record();return id end
    function value:getType() return record().type end
    function value:getParent() return record().parentKind=='actor' and player or nil end
    function value:getContainingItem() return sourceItem(record().containingItemId) end
    function value:getCapacity() return state().capacity end
    function value:getEffectiveCapacity(character)
        assert(character==nil or character==player,'unsupported container actor')
        return state(character).effectiveCapacity
    end
    function value:getCapacityWeight() return state().capacityWeight end
    function value:getContentsWeight() return state().contentsWeight end
    function value:getMaxWeight() return state().maxWeight end
    function value:getWeightReduction() return record().weightReduction end
    function value:getSourceGrid()
        local position=record().worldPosition
        return position and cell:getGridSquare(position.x,position.y,position.z) or nil
    end
    function value:setSourceGrid(square)
        local position=assert(squareRecords[square],'expected native floor square')
        assert(id==qa('floorContainer',position.x,position.y,position.z),'floor adapter cannot change native square identity')
    end
    function value:getOutermostContainer() return container(qa('containerOutermost',id)) end
    function value:getSquare()
        local outer=self:getOutermostContainer()
        return outer:getSourceGrid() or (outer:getParent()==player and player:getCurrentSquare() or nil)
    end
    function value:getWorldItem()
        local shell=self:getContainingItem()
        return shell and shell:getWorldItem() or nil
    end
    function value:hasWorldItem() return self:getWorldItem()~=nil end
    function value:isInCharacterInventory(character)
        assert(character==player,'unsupported container actor');return qa('containerActorOwner',id)==1
    end
    function value:contains(entry,recurse)
        local itemId=itemIds[entry]
        return itemId~=nil and qa('containerContains',id,itemId,recurse==true)
    end
    function value:containsTypeRecurse(name)
        for _,row in ipairs(hostCall('items')) do
            if row.fullType:match('%.([^%.]+)$')==name and qa('containerContains',id,row.id,true) then return true end
        end
        return false
    end
    function value:isInside(entry) return qa('containerIsInside',id,(assert(itemIds[entry],'expected native item'))) end
    function value:isExistYet() return hostCall('container',id)~=nil end
    function value:isVehicleSeat()
        local kind=record().kind
        assert(kind=='actor' or kind=='floor' or kind=='bag','unsupported native vehicle container')
        return false
    end
    function value:isOccupiedVehicleSeat()
        assert(not self:isVehicleSeat(),'unsupported native vehicle-seat occupancy')
        return false
    end
    function value:getVehiclePart()
        assert(not self:isVehicleSeat(),'unsupported native vehicle part')
        return nil
    end
    function value:isRemoveItemAllowed(entry) return qa('containerRemoveAllowed',id,(assert(itemIds[entry],'expected native item'))) end
    function value:isItemAllowed(entry) return qa('containerItemAllowed',id,(assert(itemIds[entry],'expected native item')),containerPolicy(value,entry)) end
    function value:hasRoomFor(...)
        local count=select('#',...)
        local character,entry,delta=...
        assert((count==2 or count==3) and (character==nil or character==player),'expected original character/item or character/weight[/floorDelta] overload')
        if rawType(entry)=='number' then
            assert(count==2 or rawType(delta)=='number','floor delta must be numeric')
            return qa('containerHasRoomWeight',id,character==player and 1 or 0,entry,delta or 0)
        end
        assert(count==2,'item overload has no floor delta')
        return qa('containerHasRoomItem',id,character==player and 1 or 0,(assert(itemIds[entry],'expected native item')),containerPolicy(value,entry))
    end
    function value:DoRemoveItem(entry) transferOperation(entry,1,id);return entry end
    function value:AddItem(entry) transferOperation(entry,2,id);return entry end
    value.DoAddItemBlind=value.AddItem
    function value:setDrawDirty(enabled) assert(rawType(enabled)=='boolean');return qa('containerSetDrawDirty',id,enabled) end
    function value:isDrawDirty() return qa('containerDrawDirty',id) end
    function value:setExplored(enabled) assert(rawType(enabled)=='boolean');qa('containerSetFlags',id,0,enabled) end
    function value:isExplored() return record().explored end
    function value:setHasBeenLooted(enabled) assert(rawType(enabled)=='boolean');qa('containerSetFlags',id,1,enabled) end
    function value:isHasBeenLooted() return record().looted end
    local items=indexedCollection(function() return qa('containerItemCount',id) end,
        function(index) return sourceItem(qa('containerItemGet',id,index)) end)
    function value:getItems() return items end
    function value:getItemsFromCategory(category) return categoryItems(items,category) end
    function value:isEmpty() return items:isEmpty() end
    function value:isEmptyOrUnwanted(character)
        assert(character==player,'unsupported unwanted inventory actor')
        for index=0,items:size()-1 do if not items:get(index):isUnwanted(character) then return false end end
        return true
    end
    function value:isLockedToCharacter(character)
        assert(character==player,'unsupported inventory lock actor')
        local row=record()
        assert(row.kind=='actor' or row.kind=='floor' or row.kind=='bag','unsupported object-owned container lock')
        -- Original ItemContainer delegates only an IsoThumpable parent; these native kinds cannot own one.
        return false
    end
    for _,method in ipairs({'getContainerPosition','getFreezerPosition','getTakeSound','getPutSound','getOpenSound','getCloseSound'}) do
        value[method]=function()
            local row=record()
            if row.kind~='bag' then return nil end
            local definition=hostCall('itemDefinition',value:getContainingItem():getFullType())
            local field=method:sub(4)
            for _,entry in ipairs(definition.rawFields or {}) do if entry.name:lower()==field:lower() then return entry.value end end
            return nil
        end
    end
    containerCache[id],containerIds[value]=value,id
    return value
end
inventory=container(1)
local floorViews=setmetatable({}, {__mode='k'})
local function floorViewRoot(value)
    assert(floorViews[value],'expected transient source floor presentation')
    local square=assert(player:getCurrentSquare(),'floor destination needs actual current square')
    return container(qa('floorContainer',square:getX(),square:getY(),square:getZ()))
end
local function newFloorView()
    local value=nativeObject('ItemContainer')
    local handle=hostCall('sourceFloorView','new')
    local meta=getmetatable(value)
    meta.__gc=function() hostCall('sourceFloorView','release',handle) end
    setmetatable(value,meta)
    local explored=false
    local drawDirty=true
    floorViews[value]=true
    local function at(index) return sourceItem(hostCall('sourceFloorView','at',handle,index)) end
    local function size() return hostCall('sourceFloorView','size',handle) end
    function value:getType() return 'floor' end
    function value:isEmpty() return size()==0 end
    function value:isEmptyOrUnwanted(character)
        assert(character==player,'unsupported unwanted presentation actor')
        for _,id in ipairs(hostCall('sourceFloorView','ids',handle)) do
            if not sourceItem(id):isUnwanted(character) then return false end
        end
        return true
    end
    function value:isLockedToCharacter(character) assert(character==player);return false end
    for _,method in ipairs({'getContainerPosition','getFreezerPosition','getTakeSound','getPutSound','getOpenSound','getCloseSound'}) do
        value[method]=function() local root=floorViewRoot(value);return root[method](root) end
    end
    function value:getParent() return nil end
    function value:getContainingItem() return nil end
    function value:getCapacity() return 50 end
    function value:getEffectiveCapacity(character)
        assert(character==nil or character==player,'unsupported presentation actor');return 50
    end
    function value:getMaxWeight() return 50 end
    function value:getCapacityWeight()
        local weight=0
        for _,id in ipairs(hostCall('sourceFloorView','ids',handle)) do
            weight=hostCall('sourceFloatAdd',weight,hostCall('itemWeights',id).unequippedWeight)
        end
        return weight
    end
    function value:getContentsWeight() return self:getCapacityWeight() end
    function value:getSourceGrid() return player:getCurrentSquare() end
    function value:getSquare() return self:getSourceGrid() end
    function value:getOutermostContainer() return self end
    function value:isInCharacterInventory(character) assert(character==player);return false end
    function value:isVehicleSeat() return false end
    function value:isOccupiedVehicleSeat() return false end
    function value:getVehiclePart() return nil end
    function value:isExistYet() return player:getCurrentSquare()~=nil end
    function value:isInside(entry) assert(itemIds[entry]);return false end
    function value:contains(entry)
        local id=itemIds[entry]
        return id~=nil and rawEqual(itemCache[id],entry) and hostCall('sourceFloorView','contains',handle,id) or false
    end
    function value:setExplored(enabled) assert(rawType(enabled)=='boolean');explored=enabled end
    function value:isExplored() return explored end
    function value:setDrawDirty(enabled) assert(rawType(enabled)=='boolean');drawDirty=enabled end
    function value:isDrawDirty() return drawDirty end
    function value:clear() hostCall('sourceFloorView','clear',handle);drawDirty=true end
    function value:removeItemsFromProcessItems()
        -- This transient presentation never registers native processing or owns an item.
        for _,id in ipairs(hostCall('sourceFloorView','ids',handle)) do hostCall('item',id) end
    end
    function value:AddItem(entry)
        local id=assert(itemIds[entry],'floor presentation requires a native item')
        assert(rawEqual(itemCache[id],entry),'floor presentation requires a native item')
        if hostCall('sourceFloorView','add',handle,id) then drawDirty=true end
        return entry
    end
    function value:hasRoomFor(...) return floorViewRoot(value):hasRoomFor(...) end
    function value:isItemAllowed(entry) return floorViewRoot(value):isItemAllowed(entry) end
    function value:isRemoveItemAllowed(entry)
        assert(self:contains(entry),'item is not in the live floor presentation')
        return entry:getContainer():isRemoveItemAllowed(entry)
    end
    local entries=indexedCollection(size,at)
    -- The native-filtered ordinal query also supplies the upper-bound check.
    function entries:get(index)
        assert(rawType(index)=='number' and index%1==0 and index>=0,'collection index out of range')
        return (assert(at(index),'collection index out of range'))
    end
    function entries:contains(target) return value:contains(target) end
    function entries:indexOf(target)
        local targetId=itemIds[target]
        if targetId==nil or not rawEqual(itemCache[targetId],target) then return -1 end
        return hostCall('sourceFloorView','indexOf',handle,targetId)
    end
    function entries:clear() value:clear() end
    function value:getItems() return entries end
    function value:getItemsFromCategory(category) return categoryItems(entries,category) end
    return value
end
local activePlayerValues={player}
local activePlayers=collection(function() hostCall('state');return activePlayerValues end)
IsoPlayer={getPlayers=function() hostCall('state');return activePlayers end}
local keyRingType=nativeObject('ItemType')
local keyRingTag=nativeObject('ItemTag')
local litLanternTag=nativeObject('ItemTag')
ItemType=setmetatable({KEY_RING=keyRingType},{__index=function(_,name)
    rawError(fault('unsupported native ItemType.'..tostring(name)),2)
end})
ItemTag=setmetatable({KEY_RING=keyRingTag,LIT_LANTERN=litLanternTag},{__index=function(_,name)
    rawError(fault('unsupported native ItemTag.'..tostring(name)),2)
end})
local function tooltipLabel(layout,key)
    local row=layout:addItem()
    row:setLabel(getText(key)..':',1,1,0.8,1)
    return row
end
local function tooltipProgress(layout,key,fraction,inverted)
    local settings=ui('settings')
    local first=inverted and settings.goodHighlight or settings.badHighlight
    local last=inverted and settings.badHighlight or settings.goodHighlight
    local row=tooltipLabel(layout,key)
    row:setProgress(fraction,first.r+(last.r-first.r)*fraction,
        first.g+(last.g-first.g)*fraction,first.b+(last.b-first.b)*fraction,1)
    return row
end
local function clothingTooltip(entry,tooltip,layout,state)
    local clothing=assert(state.clothing,'native Clothing tooltip state unavailable')
    if not clothing.cosmetic then
        tooltipProgress(layout,'Tooltip_weapon_Condition',entry:getCondition()/entry:getConditionMax())
        tooltipProgress(layout,'Tooltip_item_Insulation',clothing.insulation)
        if clothing.windResistance>0 then tooltipProgress(layout,'Tooltip_item_Windresist',clothing.windResistance) end
        if clothing.waterResistance>0 then tooltipProgress(layout,'Tooltip_item_Waterresist',clothing.waterResistance) end
    end
    if clothing.bloodLevel~=0 then tooltipProgress(layout,'Tooltip_clothing_bloody',clothing.bloodLevel/100,true) end
    if clothing.dirtyness>=1 then tooltipProgress(layout,'Tooltip_clothing_dirty',clothing.dirtyness/100,true) end
    if clothing.wetness~=0 then tooltipProgress(layout,'Tooltip_clothing_wet',clothing.wetness/100,true) end
    if clothing.holeCount>0 then tooltipLabel(layout,'Tooltip_clothing_holes'):setValueRightNoPlus(clothing.holeCount) end
    local equipped=qa('itemEquipmentState',(assert(itemIds[entry],'expected native clothing')))
    local character=tooltip:getCharacter()
    local compare=not (equipped.worn or equipped.held) and character~=nil
    local previous={biteDefense=0,scratchDefense=0,bulletDefense=0}
    if compare then
        local worn=character:getWornItems()
        local location=entry:getBodyLocation()
        for index=0,worn:size()-1 do
            local current=worn:get(index)
            local candidate=current:getItem()
            if qa('itemIsClothing',(assert(itemIds[candidate],'expected worn item'))) and current:getLocation()~=nil
                and (location==current:getLocation() or worn:getBodyLocationGroup():isExclusive(location,current:getLocation())) then
                local other=qa('itemTooltipState',itemIds[candidate]).clothing
                for key in pairs(previous) do previous[key]=previous[key]+other[key] end
            end
        end
    end
    local settings=ui('settings')
    for _,pair in ipairs({{'biteDefense','Tooltip_BiteDefense'},{'scratchDefense','Tooltip_ScratchDefense'},{'bulletDefense','Tooltip_BulletDefense'}}) do
        local key,label=pair[1],pair[2]
        local defense=clothing[key]
        if compare and defense~=previous[key] then
            local row=layout:addItem()
            if defense>0 or previous[key]>0 then
                row:setLabel(getText(label)..':',1,1,0.8,1)
                local better=defense>previous[key]
                local tint=better and settings.goodHighlight or settings.badHighlight
                row:setValue(tostring(math.floor(defense))..(better and ' (+' or ' (-')..
                    tostring(math.floor(math.abs(defense-previous[key])))..')',tint.r,tint.g,tint.b,1)
            end
        elseif defense~=0 then tooltipLabel(layout,label):setValueRightNoPlus(math.floor(defense)) end
    end
    -- Respiratory rows require original per-item filter/tank mod-data; native state refuses unresolved tagged items.
    if clothing.runSpeedModifier~=1 then
        local fraction=clothing.runSpeedModifier-1
        local tint=fraction>0 and settings.goodHighlight or settings.badHighlight
        tooltipLabel(layout,'Tooltip_RunSpeedModifier'):setProgress(math.abs(fraction),tint.r,tint.g,tint.b,1)
    end
    if clothing.combatSpeedModifier~=1 then
        -- The original color/direction branch tests run speed, not combat speed.
        local better=clothing.runSpeedModifier>1
        local tint=better and settings.goodHighlight or settings.badHighlight
        tooltipLabel(layout,'Tooltip_CombatSpeedModifier'):setProgress(
            better and clothing.combatSpeedModifier-1 or 1-clothing.combatSpeedModifier,tint.r,tint.g,tint.b,1)
    end
end
local function inventoryTooltip(entry,tooltip,embedded,offset)
    assert(nativeTypes[tooltip]=='ObjectTooltip','expected native ObjectTooltip')
    local id=assert(itemIds[entry],'expected native inventory item')
    local state=qa('itemTooltipState',id)
    local definition=hostCall('itemDefinition',entry:getFullType())
    local font,line=tooltip:getFont(),tooltip:getLineSpacing()
    local y=tooltip.padTop+offset
    local name=entry:getName(tooltip:getCharacter())
    -- ObjectTooltip owns no default draw or special object in the inventory constructor.
    tooltip:DrawText(font,name,tooltip.padLeft,y,1,1,0.8,1)
    tooltip:adjustWidth(tooltip.padLeft,name)
    y=y+line+5
    local layout=embedded or tooltip:beginLayout()
    if embedded then layout.offsetY=y else layout:setMinLabelWidth(80);layout:setMinValueWidth(80) end
    local settings=ui('settings')
    local function label(key,tint)
        local row=layout:addItem()
        tint=tint or {r=1,g=1,b=0.8}
        row:setLabel(getText(key),tint.r,tint.g,tint.b,1)
        return row
    end
    if tooltip:getCharacter() then
        if #state.researchableRecipes>0 then
            label(#state.researchableRecipes==1 and 'Tooltip_item_CanResearch' or 'Tooltip_item_CanResearchPlural',settings.goodHighlight)
        end
        if entry:isFavouriteRecipeInput(tooltip:getCharacter()) then label('Tooltip_item_IsFavouriteInput',settings.goodHighlight) end
        if entry:isNoRecipes(tooltip:getCharacter()) then label('Tooltip_NoRecipes_More',settings.badHighlight) end
        if entry:isUnwanted(tooltip:getCharacter()) then label('Tooltip_Unwanted_More',settings.badHighlight) end
    end
    local weight=tooltipLabel(layout,'Tooltip_item_Weight')
    local equipment=qa('itemEquipmentState',id)
    local special=state.clothing~=nil or qa('itemIsDrainableComboItem',id) or entry:getFullType():find('Walkie',1,true)~=nil or qa('itemIsKeyRingType',id)
    local function clean(number)
        local rounded=math.modf((number+0.005)*100)/100
        return tostring(rounded)
    end
    local function comparedWeight(first,second,key)
        weight:setValue(clean(first)..'    ('..clean(second)..' '..getText(key)..')',1,1,1,1)
    end
    if special and (equipment.worn or equipment.held or state.fakeEquipped) then
        comparedWeight(entry:getEquippedWeight(),entry:getUnequippedWeight(),'Tooltip_item_Unequipped')
    elseif state.attachedSlot>-1 then
        comparedWeight(entry:getHotbarEquippedWeight(),entry:getUnequippedWeight(),'Tooltip_item_Unattached')
    elseif special then comparedWeight(entry:getUnequippedWeight(),entry:getEquippedWeight(),'Tooltip_item_Equipped')
    else
        local number=entry:getUnequippedWeight()
        weight:setValueRightNoPlus(number>0 and math.max(0.01,number) or number)
    end
    if tooltip:getWeightOfStack()>0 then tooltipLabel(layout,'Tooltip_item_StackWeight'):setValueRightNoPlus(math.max(0.01,tooltip:getWeightOfStack())) end
    if state.maxAmmo>0 then
        tooltipLabel(layout,'Tooltip_weapon_AmmoCount'):setValue(tostring(state.currentAmmoCount)..' / '..tostring(state.maxAmmo),1,1,1,1)
    end
    if state.ammoType then tooltipLabel(layout,'ContextMenu_AmmoType'):setValue(ui('itemName',state.ammoType),1,1,1,1) end
    if state.gunType then tooltipLabel(layout,'ContextMenu_GunType'):setValue(state.gunType,1,1,1,1) end
    for _,category in ipairs(state.forageFocusCategories) do
        tooltipLabel(layout,'UI_search_mode_item_focus'):setValue(getText('IGUI_SearchMode_Categories_'..category),1,1,1,1)
    end
    if state.fatigueChange~=0 then
        local tint=state.fatigueChange<0 and settings.goodHighlight or settings.badHighlight
        tooltipLabel(layout,'Tooltip_item_Fatigue'):setProgress(math.abs(state.fatigueChange),tint.r,tint.g,tint.b,1)
    end
    if state.clothing then clothingTooltip(entry,tooltip,layout,state)
    elseif definition.sourceCategory~='Item' then
        rawError(fault('unsupported native tooltip subtype: '..tostring(definition.sourceCategory)),2)
    end
    if state.remoteControlId~=-1 then tooltipLabel(layout,'Tooltip_TrapControllerID'):setValue(tostring(state.remoteControlId),1,1,0.8,1) end
    if state.haveBeenRepaired>0 then tooltipLabel(layout,'Tooltip_weapon_Repaired'):setValue(tostring(state.haveBeenRepaired)..'x',1,1,1,1) end
    if state.equippedNoSprint then label('Tooltip_CantSprintEquipped',{r=1,g=0.1,b=0.1}) end
    if state.wet then tooltipProgress(layout,'Tooltip_Wetness',state.wetCooldown/10000,true) end
    if state.maxCapacity>0 then
        local capacity=state.maxCapacity
        if state.conditionAffectsCapacity then
            rawError(fault('unsupported native facility: VehiclePart.getNumberByCondition capacity'),2)
        end
        tooltipLabel(layout,'Tooltip_container_Capacity'):setValue(
            state.itemCapacity>-1 and tostring(state.itemCapacity)..' / '..tostring(capacity) or '0 / '..tostring(capacity),1,1,0.8,1)
    end
    if state.hasSharpness then tooltipProgress(layout,'Tooltip_weapon_Sharpness',state.sharpness) end
    if not state.clothing and entry:getConditionMax()>0 and
        (state.mechanicType>0 or state.showCondition or entry:getCondition()<entry:getConditionMax()) then
        tooltipProgress(layout,'Tooltip_weapon_Condition',entry:getCondition()/entry:getConditionMax())
    end
    if tooltip:getCharacter() and tooltip:getCharacter():hasReadMap(entry) then label('Tooltip_literature_HasBeenRead') end
    if state.fishingLure then label('Tooltip_IsFishingLure') end
    for _,component in ipairs({'attributes','fluidContainer','worldFluidContainer','durability'}) do
        assert(state[component]==nil,'unsupported native tooltip component: '..component)
    end
    for _,pair in ipairs({{'visionModifier','Tooltip_item_VisionImpariment'},{'hearingModifier','Tooltip_item_HearingImpariment'}}) do
        local modifier=state[pair[1]]
        if modifier~=1 then
            local tint=modifier>1 and settings.goodHighlight or settings.badHighlight
            tooltipLabel(layout,pair[2]):setProgress(math.abs(modifier-1),tint.r,tint.g,tint.b,1)
        end
    end
    if state.discomfortModifier~=0 then
        local tint=state.discomfortModifier<0 and settings.goodHighlight or settings.badHighlight
        tooltipLabel(layout,'Tooltip_item_Discomfort'):setProgress(math.abs(state.discomfortModifier),tint.r,tint.g,tint.b,1)
    end
    if state.tooltip then label(state.tooltip) end
    if not embedded then
        y=layout:render(tooltip.padLeft,y,tooltip)
        tooltip:endLayout(layout)
        tooltip:setHeight(y+tooltip.padBottom)
        tooltip:setWidth(math.max(150,tooltip:getWidth()))
    end
end
sourceItem=function(id)
    if id==nil then return nil end
    local value=item(id)
    local clothing=qa('itemIsClothing',id)
    -- Cache method construction only; subtype changes and all mutable getters remain native-owned.
    if sourceItemClasses[id]==clothing then return value end
    itemIds[value]=id
    function value:getID() return id end
    function value:getType() return self:getFullType():match('%.([^%.]+)$') end
    function value:isHumanCorpse()
        local receiver=itemIds[self]
        assert(receiver~=nil and rawEqual(itemCache[receiver],self),'expected native inventory item')
        local fullType=hostCall('item',receiver,'fullType')
        local kind=fullType:match('%.([^%.]+)$'):lower()
        return kind=='corpsefemale' or kind=='corpsemale'
    end
    function value:getCategory()
        return hostCall('itemDefinition',self:getFullType(),'sourceCategory')
    end
    function value:isHidden() return qa('itemIsHidden',id) end
    function value:IsFood() return qa('itemIsFood',id) end
    function value:IsLiterature()
        local receiver=itemIds[self]
        assert(receiver~=nil and rawEqual(itemCache[receiver],self),'expected native inventory item')
        return qa('itemIsLiterature',receiver)
    end
    function value:hasBeenSeen(character)
        assert(rawEqual(character,player),'expected native player')
        local receiver=itemIds[self]
        assert(receiver~=nil and rawEqual(itemCache[receiver],self),'expected native inventory item')
        return qa('itemHasBeenSeen',receiver,0)
    end
    function value:hasBeenHeard(character)
        assert(rawEqual(character,player),'expected native player')
        local receiver=itemIds[self]
        assert(receiver~=nil and rawEqual(itemCache[receiver],self),'expected native inventory item')
        return qa('itemHasBeenHeard',receiver,0)
    end
    function value:isNoRecipes(character)
        local receiver=itemIds[self]
        assert(receiver~=nil and rawEqual(itemCache[receiver],self),'expected native inventory item')
        if character==nil then return qa('itemIsNoRecipes',receiver,nil) end
        assert(rawEqual(character,player),'expected native player')
        return qa('itemIsNoRecipes',receiver,0)
    end
    function value:isFavouriteRecipeInput(character)
        local receiver=itemIds[self]
        assert(receiver~=nil and rawEqual(itemCache[receiver],self),'expected native inventory item')
        assert(rawEqual(character,player),'expected native player for original recipe membership')
        qa('itemFavouriteRecipeInputIdentity',receiver,0)
        -- IsoPlayer.isFavouriteRecipe reads Boolean recipeFavourite:<name> in this
        -- actual shared/persisted player table, independent of the item's favorite flag.
        -- No active preferences proves false without guessing an empty recipe index.
        for key,preference in rawNext,playerData do
            if rawType(key)=='string' and rawStringSub(key,1,16)=='recipeFavourite:' and preference~=false then
                rawError(fault('unsupported native facility: original recipe membership and player recipe knowledge'),2)
            end
        end
        return false
    end
    function value:isItemType(kind)
        assert(kind==keyRingType,'unsupported native ItemType predicate')
        return qa('itemIsKeyRingType',id)
    end
    function value:hasTag(tag)
        if tag==keyRingTag then return qa('itemHasKeyRingTag',id) end
        assert(tag==litLanternTag,'unsupported native ItemTag predicate')
        local definition=assert(hostCall('itemDefinition',self:getFullType()),'native item definition unavailable')
        for _,identifier in ipairs(definition.tags) do
            if identifier=='base:litlantern' then return true end
        end
        return false
    end
    function value:getDisplayCategory() return qa('itemDisplayCategory',id) end
    function value:setDisplayCategory(category)
        assert(category==nil or rawType(category)=='string','expected native display category')
        return qa('itemSetDisplayCategory',id,category)
    end
    function value:isUnwanted(character)
        assert(character==player,'unsupported unwanted item actor')
        local key=qa('itemUnwantedKey',id)
        local unwanted=character:getModData()[key]
        assert(unwanted==nil or rawType(unwanted)=='boolean','expected original unwanted-item boolean')
        return unwanted==true
    end
    function value:updateAge() qa('itemUpdateAge',id) end
    function value:isBroken() return qa('itemIsBroken',id) end
    function value:setBroken(enabled) qa('itemSetBroken',id,enabled) end
    function value:getItemHeat() return qa('itemHeat',id) end
    function value:setItemHeat(heat) qa('itemSetHeat',id,heat) end
    if clothing then
        function value:updateWetness(force)
            if force==nil then force=false end
            qa('itemUpdateWetness',id,force)
        end
        function value:getWetness() return qa('itemWetness',id) end
        function value:setWetness(wetness) qa('itemSetWetness',id,wetness) end
    else
        value.updateWetness,value.getWetness,value.setWetness=nil,nil,nil
    end
    function value:getIsCraftingConsumed() return hostCall('sourceItemState',id,'consumed') end
    function value:isFavorite() return hostCall('sourceItemState',id,'favorite') end
    function value:setFavorite(enabled) hostCall('sourceItemState',id,'favorite',enabled) end
    function value:hasWorldItem() return self:getWorldItem()~=nil end
    function value:isOnGroundOnSquare(square)
        local world=self:getWorldItem()
        return square~=nil and world~=nil and world:getSquare()==square
    end
    function value:isInsideBagOnSquare(square)
        local outer=self:getOutermostContainer()
        local world=outer and outer:getWorldItem()
        return square~=nil and world~=nil and world:getSquare()==square
    end
    function value:isOnGroundOrInsideBagOnSquare(square)
        return self:isOnGroundOnSquare(square) or self:isInsideBagOnSquare(square)
    end
    function value:getDisplayName() return ui('itemName',self:getFullType()) end
    function value:getName()
        local name=self:getDisplayName()
        if not qa('itemIsClothing',id) then return name end
        local clothing=qa('itemNameState',id)
        local descriptors={}
        if clothing.dirtyness>15 then descriptors[#descriptors+1]=getText('IGUI_ClothingName_Dirty') end
        if clothing.bloodLevel>25 then descriptors[#descriptors+1]=getText('IGUI_ClothingName_Bloody') end
        if clothing.wetness>=100 then descriptors[#descriptors+1]=getText('IGUI_ClothingName_Soaked')
        elseif clothing.wetness>25 then descriptors[#descriptors+1]=getText('IGUI_ClothingName_Wet') end
        if clothing.broken then descriptors[#descriptors+1]=getText('Tooltip_Clothing_broken')
        elseif clothing.condition<clothing.conditionMax/3 then descriptors[#descriptors+1]=getText('IGUI_ClothingName_Worn') end
        return #descriptors==0 and name or getText('IGUI_ClothingNaming',table.concat(descriptors,', '),name)
    end
    function value:DoTooltip(tooltip,layout)
        assert(itemIds[self]==id and rawEqual(itemCache[id],self),'expected native inventory item receiver')
        assert(nativeTypes[tooltip]=='ObjectTooltip','expected native ObjectTooltip')
        if layout~=nil then
            assert(nativeTypes[layout]=='ObjectTooltip.Layout','expected native ObjectTooltip.Layout')
            local state=qa('itemTooltipState',id)
            if state.clothing then clothingTooltip(self,tooltip,layout,state) end
        else inventoryTooltip(self,tooltip,nil,0) end
    end
    function value:DoTooltipEmbedded(tooltip,layout,y)
        assert(itemIds[self]==id and rawEqual(itemCache[id],self),'expected native inventory item receiver')
        assert(layout==nil or nativeTypes[layout]=='ObjectTooltip.Layout','expected native ObjectTooltip.Layout')
        assert(rawType(y)=='number' and y%1==0,'expected native embedded tooltip offset')
        inventoryTooltip(self,tooltip,layout,y)
    end
    local function appearance()
        local definition=hostCall('itemDefinition',value:getFullType())
        local fields={}
        for _,field in ipairs(definition.rawFields or {}) do fields[field.name]=field.value end
        assert(not fields.FluidContainer and not fields.TextureColorMask and not fields.TextureFluidMask,'unsupported original fluid or masked item visuals')
        assert(not fields.ColorRed and not fields.ColorGreen and not fields.ColorBlue and not fields.RandomHue,'unsupported original configured item tint')
        return fields,definition.normalIcon
    end
    function value:getTex()
        local _,icon=appearance()
        icon=assert(icon,'original item Icon metadata unavailable')
        return assert(getTexture('media/textures/Item_'..icon..'.png'),'original item icon texture unavailable')
    end
    local function clothingAsset()
        local fullType=hostCall('item',id,'fullType')
        local definition=assert(hostCall('itemDefinition',fullType),'native item definition unavailable')
        assert(not definition.clothingItem and not definition.replacePrimaryHand and not definition.replaceSecondHand,
            'unsupported native clothing asset selection')
        for _,field in ipairs(definition.rawFields or {}) do
            local name=field.name:lower()
            assert(name~='clothingitem' and name~='replaceprimaryhand' and name~='replacesecondhand' and name~='alternatemodelname',
                'unsupported native clothing asset selection')
        end
        -- Original getVisual returns nil when getClothingItem has no asset, before allocating ItemVisual.
        return nil
    end
    function value:getClothingItem() return clothingAsset() end
    function value:getVisual() return clothingAsset() end
    function value:getFluidContainer() appearance();return nil end
    function value:getTextureColorMask() appearance();return nil end
    function value:getTextureFluidMask() appearance();return nil end
    -- Source flat InventoryItem construction owns Color.white; scripted tint/masks refuse above.
    itemVisuals[id]=itemVisuals[id] or {r=1,g=1,b=1,a=1}
    for _,pair in ipairs({{'getR','r'},{'getG','g'},{'getB','b'}}) do
        value[pair[1]]=function() appearance();return itemVisuals[id][pair[2]] end
    end
    function value:getColor() appearance();return color(function() return itemVisuals[id] end) end
    function value:getWorldItem()
        local record=hostCall('item',id)
        return record and record.worldPosition and worldItem(id) or nil
    end
    function value:setWorldItem(other)
        assert(other==nil,'unsupported replacement world object')
        transferOperation(value,3)
    end
    function value:setJobType(name) assert(rawType(name)=='string');jobs[id]=jobs[id] or {};jobs[id].type=name end
    function value:setJobDelta(deltaValue) assert(rawType(deltaValue)=='number');jobs[id]=jobs[id] or {};jobs[id].delta=deltaValue end
    function value:getJobDelta() return jobs[id] and jobs[id].delta or 0 end
    function value:getJobType() return jobs[id] and jobs[id].type or '' end
    sourceItemClasses[id]=clothing
    return value
end
function player:isKnownPoison(entry)
    assert(rawEqual(self,player),'expected native player')
    local id=itemIds[entry]
    assert(id~=nil and rawEqual(itemCache[id],entry),'expected native inventory item')
    return qa('playerIsKnownPoison',id)
end
function player:hasReadMap(entry)
    assert(rawEqual(self,player),'expected native player')
    if entry==nil then return qa('playerHasReadMap',nil,0) end
    local id=itemIds[entry]
    assert(id~=nil and rawEqual(itemCache[id],entry),'expected native inventory item')
    return qa('playerHasReadMap',id,0)
end
function player:getPrimaryHandItem() return sourceItem(hostCall('handItems').primary) end
function player:getSecondaryHandItem() return sourceItem(hostCall('handItems').secondary) end
do
local function handItemState(character,entry)
    assert(rawEqual(character,player),'expected native player')
    local id
    if entry~=nil then
        id=itemIds[entry]
        assert(id~=nil and rawEqual(itemCache[id],entry),'expected native inventory item')
    end
    return hostCall('handItems'),id
end
function player:isHandItem(entry)
    local hands,id=handItemState(self,entry)
    return hands.primary==id or hands.secondary==id
end
function player:isPrimaryHandItem(entry)
    local hands,id=handItemState(self,entry)
    return hands.primary==id
end
function player:isSecondaryHandItem(entry)
    local hands,id=handItemState(self,entry)
    return hands.secondary==id
end
end
local function setHandItem(slot,value)
    assert(value==nil or itemIds[value]~=nil,'expected native held inventory item')
    local id=value and assert(itemIds[value],'expected stable native held item identity') or nil
    local result=hostCall('sourceSetHandItem',slot,id)
    assert(result and result.committed,'source held item change denied: '..tostring(result and result.cancelledBy))
end
function player:setPrimaryHandItem(value) setHandItem('primary',value) end
function player:setSecondaryHandItem(value) setHandItem('secondary',value) end
worldItem=function(id)
    if worldItems[id] then return worldItems[id] end
    local value=nativeObject('IsoWorldInventoryObject')
    function value:getItem() return sourceItem(id) end
    -- Only typed native world-item objects are constructed here; their inherited IsoObject container slots are empty.
    function value:getContainerCount()
        local row=assert(hostCall('item',id),'native world item no longer exists')
        assert(row.worldPosition,'native world item is detached')
        return 0
    end
    function value:getContainerByIndex(index)
        assert(rawType(index)=='number' and index%1==0,'expected native container index')
        self:getContainerCount()
        return nil
    end
    local highlight={enabled=false,blink=false,outline=false,outlineAttached=false,
        color={r=1,g=1,b=1,a=1},outlineColor={r=1,g=1,b=1,a=1}}
    local function publish()
        actorState.worldHighlights=actorState.worldHighlights or {}
        actorState.worldHighlights[id]=highlight
        hostCall('sourceHighlight','item',id,highlight)
    end
    local function highlightPlayer(index) assert(index==0,'unsupported original highlight viewport') end
    local function highlightColor(r,g,b,a)
        local result={}
        for component,input in pairs({r=r,g=g,b=b,a=a}) do
            assert(rawType(input)=='number' and input==input and math.abs(input)~=math.huge,'invalid highlight color')
            result[component]=string.unpack('f',string.pack('f',math.max(0,math.min(1,input))))
        end
        assert(result.r and result.g and result.b and result.a,'missing highlight color component')
        return result
    end
    function value:setHighlighted(index,enabled,blink)
        highlightPlayer(index)
        assert(rawType(enabled)=='boolean' and (blink==nil or rawType(blink)=='boolean'),'invalid original world highlight')
        highlight.enabled,highlight.blink=enabled,blink==true
        local tint=core:getWorldItemHighlightColor()
        highlight.color=highlightColor(tint:getR(),tint:getG(),tint:getB(),1)
        highlight.outline=enabled
        highlight.outlineColor=highlightColor(tint:getR(),tint:getG(),tint:getB(),tint:getA())
        publish()
    end
    function value:isHighlighted(index) highlightPlayer(index);return highlight.enabled end
    function value:setOutlineHighlight(index,enabled)
        highlightPlayer(index);assert(rawType(enabled)=='boolean')
        highlight.outline=enabled;publish()
    end
    function value:isOutlineHighlight(index) highlightPlayer(index);return highlight.outline end
    function value:setOutlineHlAttached(index,enabled)
        highlightPlayer(index);assert(rawType(enabled)=='boolean')
        highlight.outlineAttached=enabled;publish()
    end
    function value:isOutlineHlAttached(index) highlightPlayer(index);return highlight.outlineAttached end
    function value:setHighlightColor(index,r,g,b,a)
        highlightPlayer(index)
        if nativeTypes[r]=='ColorInfo' then r,g,b,a=r:getR(),r:getG(),r:getB(),r:getA() end
        highlight.color=highlightColor(r,g,b,a);publish()
    end
    function value:getHighlightColor(index) highlightPlayer(index);return color(function() return highlight.color end,nil,'ColorInfo') end
    function value:setOutlineHighlightCol(index,r,g,b,a)
        highlightPlayer(index)
        if nativeTypes[r]=='ColorInfo' then r,g,b,a=r:getR(),r:getG(),r:getB(),r:getA() end
        highlight.outlineColor=highlightColor(r,g,b,a);publish()
    end
    function value:getOutlineHighlightCol(index)
        highlightPlayer(index)
        local function byte(input) return math.floor(string.unpack('f',string.pack('f',input*255))) end
        local tint=highlight.outlineColor
        local packed=(byte(tint.a)<<24)|(byte(tint.b)<<16)|(byte(tint.g)<<8)|byte(tint.r)
        return packed>=0x80000000 and packed-0x100000000 or packed
    end
    function value:getFluidContainer() return self:getItem():getFluidContainer() end
    function value:getSquare()
        local record=hostCall('item',id)
        local position=record and record.worldPosition
        if not position then return nil end
        return cell:getGridSquare(position.x,position.y,position.z)
    end
    function value:getX() return assert(hostCall('item',id).worldPosition,'not a world item').x end
    function value:getY() return assert(hostCall('item',id).worldPosition,'not a world item').y end
    function value:getZ() return assert(hostCall('item',id).worldPosition,'not a world item').z end
    local function screenPosition(index)
        assert(index==player:getPlayerNum(),'unsupported source viewport')
        local record=assert(hostCall('item',id),'source screen projection lost its native item')
        local position=assert(record.worldPosition,'source screen position requires a world item')
        return hostCall('sourceContext','objectScreenPosition',position)
    end
    function value:getScreenPosX(index) return screenPosition(index).x end
    function value:getScreenPosY(index) return screenPosition(index).y end
    function value:removeFromWorld() transferOperation(self:getItem(),3) end
    function value:removeFromSquare() transferOperation(self:getItem(),3) end
    function value:setSquare(square)
        assert(square==nil,'unsupported replacement square')
        transferOperation(self:getItem(),3)
    end
    worldItems[id]=value
    itemIds[value]=id
    return value
end
local function door(id)
    if doorObjects[id] then return doorObjects[id] end
    local value=nativeObject('IsoDoor')
    local function record() return assert(hostCall('door',id),'source door disappeared') end
    -- This native door constructor has no primary or secondary IsoObject containers.
    function value:getContainerCount() record();return 0 end
    function value:getContainerByIndex(index)
        assert(rawType(index)=='number' and index%1==0,'expected native container index')
        record()
        return nil
    end
    function value:getSquare() local row=record();return cell:getGridSquare(row.x,row.y,row.z) end
    function value:IsOpen() return record().open end
    function value:getNorth() return record().north end
    function value:HasCurtains() return qa('doorCurtainState',id).has and self or nil end
    function value:isCurtainOpen() return qa('doorCurtainState',id).open end
    function value:canAddCurtain()
        local allowed=qa('doorCurtainState',id).canAdd
        assert(rawType(allowed)=='boolean','unsupported original curtain eligibility without source sprite properties')
        return allowed
    end
    function value:isBarricaded() return record().barricaded end
    function value:couldBeOpen(character)
        assert(character==player,'unsupported source door actor')
        return qa('doorCouldBeOpen',id)
    end
    function value:ToggleDoor(character)
        assert(character==player and eventScope and eventScope.event==5,'door commit requires source perform')
        return qa('commitDoor',eventScope.actionId,qa('doorOrdinal',id),eventScope.token)
    end
    value.__doorId=id
    doorObjects[id]=value
    return value
end
local function viewLength(meta)
    if meta.kind=='queue' then return qa('length') end
    if meta.kind=='groups' then return qa('groupLength',meta.id) end
    return qa('groupItemLength',meta.id)
end
local makeView,promote,group,residentAction
local function viewGet(meta,index)
    if index<1 or index>viewLength(meta) then return nil end
    if meta.kind=='queue' then return residentAction(qa('get',index-1)) end
    if meta.kind=='groups' then return group(qa('groupGet',meta.id,index-1)) end
    local id=qa('groupItemGet',meta.id,index-1)
    return qa('actionRead',qa('groupRead',meta.id).actionId).kind=='transfer' and sourceItem(id) or worldItem(id)
end
local function viewInsert(meta,index,value)
    assert(rawType(index)=='number' and index%1==0 and index>=1 and index<=viewLength(meta)+1,'native view insertion index out of range')
    if meta.kind~='queue' and sourceAdmissionPermit and sourceAdmissionPermit.cancelled then return end
    if meta.kind=='queue' then
        allowSourceAdmission()
        return qa('insert',index-1,promote(value))
    end
    if meta.kind=='items' then return qa('groupItemInsert',meta.id,index-1,(assert(itemIds[value],'expected stable world item'))) end
    assert(rawType(value)=='table' and rawType(value.items)=='table','source group needs items')
    local id=qa('groupNew',meta.id,value.time)
    for _,entry in ipairs(value.items) do qa('groupItemInsert',id,qa('groupItemLength',id),(assert(itemIds[entry],'expected stable world item'))) end
    qa('groupInsert',meta.id,index-1,id)
end
local function viewRemove(meta,index)
    assert(rawType(index)=='number' and index%1==0 and index>=1 and index<=viewLength(meta),'native view removal index out of range')
    local value=viewGet(meta,index)
    if meta.kind=='queue' then qa('remove',index-1)
    elseif meta.kind=='groups' then qa('groupRemove',meta.id,index-1)
    else qa('groupItemRemove',meta.id,index-1) end
    return value
end
makeView=function(kind,id)
    local value={}
    local meta={kind=kind,id=id}
    views[value]=meta
    return setmetatable(value,{
        __len=function() return viewLength(meta) end,
        -- Original Grab.checkQueueList reads queue[#queue], including zero for an empty queue.
        __index=function(_,index) assert(rawType(index)=='number' and index%1==0 and index>=0,'invalid native view key');return viewGet(meta,index) end,
        __newindex=function(_,index,entry)
            if entry==nil then return viewRemove(meta,index) end
            assert(index==viewLength(meta)+1,'native view replacement/holes unsupported')
            return viewInsert(meta,index,entry)
        end,
        __pairs=function() return function(_,index) index=index+1;local entry=viewGet(meta,index);if entry~=nil then return index,entry end end,value,0 end})
end
group=function(id)
    if groupObjects[id] then return groupObjects[id] end
    local value=setmetatable({items=makeView('items',id)}, {__index=function(_,key)
        local row=qa('groupRead',id)
        if key=='time' then return row.rawTime end
        if key=='type' then return row.fullType end
    end})
    groupObjects[id]=value
    return value
end
local synchronousSourceEvents={[1]=true,[2]=true,[3]=true,[5]=true,[6]=true,[7]=true}
local function drainSourceLifecycle()
    local count=0
    while true do
        local event=qa('eventRead')
        if not event then return end
        -- Consume existing native authorization only; update4 belongs to the logical-frame driver.
        assert(synchronousSourceEvents[event.event],'unexpected frame update during synchronous source lifecycle')
        assert(count<896,'synchronous source lifecycle exceeded native action/event bounds')
        count=count+1
        local ok,result=pcall(__pz_source_event,event)
        qa('eventReply',event.actionId,event.event,event.token,ok and result or -4)
        if not ok then rawError(result,0) end
    end
end
local ordinaryInsert,ordinaryRemove,ordinaryWipe,ordinaryIpairs,ordinaryPairs=table.insert,table.remove,table.wipe,table.ipairs,table.pairs
local nativeViewIpairs,nativeViewPairs=ipairs,pairs
function table.insert(value,...)
    local meta=views[value]
    if not meta then return ordinaryInsert(value,...) end
    local count=select('#',...)
    assert(count==1 or count==2,'native insert requires value or position/value')
    local index,entry
    if count==1 then index,entry=viewLength(meta)+1,... else index,entry=... end
    assert(entry~=nil,'native view cannot contain holes')
    return viewInsert(meta,index,entry)
end
function table.remove(value,index)
    local meta=views[value]
    if not meta then return ordinaryRemove(value,index) end
    if viewLength(meta)==0 then return nil end
    return viewRemove(meta,index or viewLength(meta))
end
function table.wipe(value)
    local meta=views[value]
    if meta then
        if meta.kind=='queue' then
            qa('clear')
            if eventScope==nil then
                drainSourceLifecycle()
                for id,action in pairs(actionObjects) do
                    if actionOwners[id] and qa('lookup',id)==0 and not sourceBegun[id] and not forceCancelled[action] and action.forceCancel then
                        guarded(actionOwners[id],function() action:forceCancel() end)
                    end
                end
            end
            return
        end
        while viewLength(meta)>0 do viewRemove(meta,viewLength(meta)) end
        return
    end
    if ordinaryWipe then return ordinaryWipe(value) end
    for key in rawNext,value do value[key]=nil end
end
table.ipairs=function(value) if views[value] then return nativeViewIpairs(value) end;return ordinaryIpairs(value) end
table.pairs=function(value) if views[value] then return nativeViewPairs(value) end;return ordinaryPairs(value) end
local function builtInDoorCompletion(action)
    if action.Type~='ISWaitWhileGettingUp' or not ISWorldObjectContextMenu
        or not sourceDoorCompletion or ISWorldObjectContextMenu.onOpenCloseDoor~=sourceDoorCompletion
        or action.onCompleteFunc~=sourceDoorCompletion then return nil end
    local args=action.onCompleteArgs
    if not args or rawType(args.p1)~='table' or not args.p2 or not args.p2.__doorId or args.p3~=0 then return nil end
    for i=4,10 do if args['p'..i]~=nil then return nil end end
    return args.p2.__doorId
end
local function portable(action)
    local methods=sourceMethods[action.Type]
    if not methods then return false end
    for _,name in ipairs(sourceMethodNames) do
        if rawget(action,name)~=nil or action[name]~=methods[name] then return false end
    end
    local helperMethods=sourceMethods.ISTransferAction
    if action.Type=='ISInventoryTransferAction' and helperMethods then
        if not ISTransferAction then return false end
        for _,name in ipairs(sourceMethodNames) do
            if ISTransferAction[name]~=helperMethods[name] then return false end
        end
    end
    local baseMethods=sourceMethods.ISBaseTimedAction
    if baseMethods then
        if not ISBaseTimedAction then return false end
        for _,name in ipairs(sourceMethodNames) do
            if ISBaseTimedAction[name]~=baseMethods[name] then return false end
        end
    end
    if builtInDoorCompletion(action) then return true end
    return action.additionalTest==nil and action.additionalContext==nil and action.onCompleteFunc==nil
        and action.onCompleteArgs==nil and action.onComplete==nil
end
local function bindGroups(action,id,staged)
    local projection=makeView('groups',id)
    if staged then for _,entry in ipairs(staged) do table.insert(projection,entry) end end
    rawset(action,'queueList',nil)
    local previous=getmetatable(action)
    local index=previous and previous.__index
    setmetatable(action,{__index=function(targetValue,key)
        if key=='queueList' then return projection end
        if rawType(index)=='function' then return index(targetValue,key) end
        return index and index[key]
    end,__newindex=function(targetValue,key,value)
        if key=='queueList' then
            assert(rawType(value)=='table','group replacement requires table')
            table.wipe(projection)
            for _,entry in ipairs(value) do table.insert(projection,entry) end
        else rawset(targetValue,key,value) end
    end})
end
promote=function(action)
    allowSourceAdmission()
    if actionIds[action] then return actionIds[action] end
    assert(action.character==player,'unsupported source action character')
    local kind,target,x,y,z,location
    assert(sourceClasses[action.Type] and getmetatable(action)==sourceClasses[action.Type],'unsupported source action class identity '..tostring(action.Type))
    if action.Type=='ISGrabItemAction' then
        kind,target=3,assert(itemIds[action.item],'grab needs stable world item')
        location=assert(action.item:getSquare(),'grab needs live source square')
    elseif action.Type=='ISInventoryTransferAction' then
        kind,target=5,assert(itemIds[action.item],'transfer needs stable inventory item')
        assert(containerIds[action.srcContainer] and containerIds[action.destContainer],'transfer needs native container identities')
        if action.destContainer:getType()=='floor' then
            local square=assert(action:getNotFullFloorSquare(action.item),'no source-selected floor square')
            action.destContainer=container(qa('floorContainer',square:getX(),square:getY(),square:getZ()))
        end
        location=action.destContainer:getSourceGrid() or player:getCurrentSquare()
    elseif action.Type=='ISOpenCloseDoor' then
        kind,target=2,qa('doorOrdinal',(assert(action.item.__doorId,'door needs stable native identity')))
        location=assert(action.item:getSquare(),'door needs live source square')
    elseif action.Type=='ISWalkToTimedAction' then kind,target,location=1,0,assert(action.location,'walk needs source square')
    elseif action.Type=='ISWaitWhileGettingUp' then
        kind=4
        local doorId=builtInDoorCompletion(action)
        assert(doorId or action.onCompleteFunc==nil,'unsupported opaque get-up completion callback')
        target=doorId and qa('doorOrdinal',doorId) or 4294967295
        x,y,z=0,0,0
    else rawError(fault('unsupported source action: '..tostring(action.Type)),2) end
    if location then x,y,z=location:getX(),location:getY(),location:getZ() end
    local id=qa('newAction',kind,1,target,x,y,z,action.maxTime)
    actionIds[action],actionObjects[id],actionOwners[id]=id,action,context()
    local ok,err=pcall(function()
        for _,pair in ipairs({{'loopedAction',5},{'stopOnWalk',6},{'stopOnRun',7},{'stopOnAim',8}}) do
            if action[pair[1]]~=nil then qa('actionSet',id,pair[2],action[pair[1]] and 1 or 0) end
            if pair[1]=='stopOnAim' and action.stopOnAim==nil then qa('actionSet',id,8,0) end
        end
        qa('actionSet',id,10,portable(action) and 1 or 0)
        if kind==3 or kind==5 then
            if kind==5 then
                qa('actionBindTransfer',id,action.srcContainer:getID(),action.destContainer:getID())
            end
            bindGroups(action,id,assert(action.queueList,'source transfer constructor did not create groups'))
        end
    end)
    if not ok then
        qa('discard',id)
        actionIds[action],actionObjects[id],actionOwners[id]=nil,nil,nil
        rawError(err,0)
    end
    return id
end
local function handle(action,id)
    if actionHandles[id] then return actionHandles[id] end
    local value=nativeObject('LuaTimedActionNew')
    local function read() return qa('actionRead',id) end
    function value:getTable() return action end
    function value:getJobDelta() return read().delta end
    function value:isStarted() return read().started end
    function value:hasStalled() local row=read();return row.started and ((row.lastTime==row.currentTime and row.lastTime==row.prevLastTime and row.lastTime<0) or row.currentTime<0) end
    for _,pair in ipairs({{'setTime',0},{'setJobDelta',1},{'setLoopedAction',5},{'setStopOnWalk',6},{'setStopOnRun',7},{'setStopOnAim',8}}) do
        value[pair[1]]=function(_,input) return qa('actionSet',id,pair[2],rawType(input)=='boolean' and (input and 1 or 0) or input) end
    end
    function value:resetJobDelta() return qa('actionSet',id,2,1) end
    function value:forceComplete() return qa('actionSet',id,3,1) end
    function value:forceStop() return qa('actionSet',id,4,1) end
    function value:setActionAnim(name) actorState.animation=name end
    function value:stopTimedActionAnim() actorState.animation=nil end
    function value:setAnimVariable(key,input) actorState.variables[key]=input end
    function value:setOverrideHandModelsObject(primary,secondary,reset) actorState.handModels={primary,secondary,reset} end
    function value:setPathfinding(enabled) assert(action.Type=='ISWalkToTimedAction' and enabled==true,'unsupported pathfinding setter') end
    function value:setAllowedWhileDraggingCorpses(enabled) action.allowedWhileDraggingCorpses=enabled end
    actionHandles[id]=value
    return value
end
LuaTimedActionNew={new=function(action,character)
    assert(character==player)
    local id=promote(action)
    sourceBegun[id]=true
    return handle(action,id)
end}
function player:StartAction(value)
    local action=value:getTable()
    assert(actionHandles[actionIds[action]]==value,'expected resident native action')
    local id=actionIds[action]
    qa('start',id,action.maxTime,1)
    if eventScope==nil then
        drainSourceLifecycle()
    end
end
function player:StopAllActionQueue()
    local id=qa('current')
    if id~=0 then qa('actionSet',id,4,1) end
end
function player:getCharacterActions()
    return collection(function()
        local id=qa('current')
        if id==0 then return {} end
        residentAction(id)
        return actionHandles[id] and {actionHandles[id]} or {}
    end)
end
function player:getTimedActionToRetrigger()
    local id=qa('retriggerGet')
    if id~=0 and not actionHandles[id] then residentAction(id) end
    return id~=0 and assert(actionHandles[id],'native retrigger has no resident source action') or nil
end
function player:setTimedActionToRetrigger(value)
    local id=value and actionIds[value:getTable()] or 0
    assert(id~=nil,'unsupported opaque source action retrigger')
    return qa('retriggerSet',id)
end
function player:getSquare() return self:getCurrentSquare() end
function player:getZ() return self:getCurrentSquare():getZ() end
function player:isFarming() return actorState.farming end
function player:setIsFarming(value) assert(rawType(value)=='boolean');actorState.farming=value end
function player:isAsleep() return actorState.asleep end
function player:isAiming() return qa('actorIsAiming',self:getPlayerNum()) end
function player:isForceAim() return qa('actorInputState',self:getPlayerNum()).forceAim end
function player:setIsAiming(enabled)
    assert(rawType(enabled)=='boolean','expected native aiming boolean')
    qa('setIsAiming',self:getPlayerNum(),enabled)
end
function player:setForceAim(enabled)
    assert(rawType(enabled)=='boolean','expected native force-aim boolean')
    qa('setForceAim',self:getPlayerNum(),enabled)
end
function player:toggleForceAim() return qa('toggleForceAim',self:getPlayerNum()) end
function player:nullifyAiming() qa('nullifyAiming',self:getPlayerNum()) end
function player:isDraggingCorpse() return actorState.dragging end
function player:getVehicle() return actorState.vehicle end
function player:pressedMovement() return hostCall('sourceInput','movement') end
function player:pressedCancelAction() return hostCall('sourceInput','cancel') end
function player:reportEvent(name) actorState.events[#actorState.events+1]=name end
function player:faceThisObject(value)
    local id=rawget(value,'__doorId') or itemIds[value]
    assert(id~=nil,'source facing requires a stable native world target')
    return hostCall('sourceFace',id)
end
function player:setPath2(path) assert(path==nil,'unsupported external path replacement') end
local path=nativeObject('PathFindBehavior2')
BehaviorResult={Failed='Failed',Succeeded='Succeeded',Working='Working'}
function path:pathToLocation(x,y,z)
    local row=qa('actionRead',qa('current'))
    assert(row.kind=='walk' and row.target.x==x and row.target.y==y and row.target.z==z,'path target differs from native source action')
end
function path:update()
    local result=qa('pathResult',qa('current'))
    assert(result==0 or result==1 or result==2,'unsupported native source path result')
    return ({[0]=BehaviorResult.Working,[1]=BehaviorResult.Succeeded,[2]=BehaviorResult.Failed})[result]
end
function path:cancel() return hostCall('sourcePathCancel') end
function player:getPathFindBehavior2() return path end
CharacterTrait={DEXTROUS='base:dextrous',ALL_THUMBS='base:allthumbs'}
function player:hasTrait(id) return timing('hasTrait',id) end
function player:isTimedActionInstant() return timing('getState').instant end
function gameTime:getRealworldSecondsSinceLastUpdate() return timing('getState').elapsedSeconds end
for _,pair in ipairs({{'getMultiplier','gameMultiplier'},{'getTrueMultiplier','multiplier'},{'getMultiplierBias','bias'},
    {'getPerObjectMultiplier','perObject'},{'getFPSMultiplier','fpsMultiplier'},{'getSlomoMultiplier','slowMultiplier'}}) do
    gameTime[pair[1]]=function() return timing('getState')[pair[2]] end
end
function gameTime:setMultiplier(value) return timing('set','multiplier',value) end
for _,pair in ipairs({{'Year','year'},{'Month','month'},{'Day','day'},
    {'TimeOfDay','timeOfDay'},{'LastTimeOfDay','lastTimeOfDay'},
    {'NightsSurvived','nightsSurvived'},{'MinutesPerDay','minutesPerDay'}}) do
    gameTime['get'..pair[1]]=function() return qa('worldClockGet',pair[2]) end
    gameTime['set'..pair[1]]=function(_,value) qa('worldClockSet',pair[2],value) end
end
for _,pair in ipairs({{'WorldAgeHours','worldAgeHours'},{'Hour','hour'},{'Minutes','minutes'}}) do
    gameTime['get'..pair[1]]=function() return qa('worldClockGet',pair[2]) end
end
function core:getGameMode() return timing('getGameMode') end
function core:getOptionTimedActionGameSpeedReset() return hostCall('sourceContext','timedActionGameSpeedReset') end
function getGameSpeed() return hostCall('sourceContext','gameSpeed') end
function getNumActivePlayers() return activePlayers:size() end
function isClient() hostCall('state');return false end
function player:isPlayerMoving() return hostCall('sourceInput','movement') end
function player:clearVariable(name) actorState.variables[name]=nil end
function player:shouldBeTurning() return qa('actorShouldBeTurning') end
function player:isSittingOnFurniture() return qa('actorSittingOnFurniture') end
function player:isSeatedInVehicle() return qa('actorSeatedInVehicle') end
function core:getOptionDropItemsOnSquareCenter() return qa('dropItemsOnSquareCenter') end
function core:setOptionDropItemsOnSquareCenter(enabled) return qa('setDropItemsOnSquareCenter',enabled) end
function player:getOverlaySprite() return qa('actorOverlaySprite') end
local characterEmitter=nativeObject('BaseCharacterSoundEmitter')
for _,operation in ipairs({'playSound','isPlaying','stopSound','stopOrTriggerSound'}) do
    characterEmitter[operation]=function(_,value)
        return hostCall('sourceContext','characterEmitter',operation,value)
    end
end
function player:getEmitter() return characterEmitter end
function player:isEquipped(entry)
    local state=qa('itemEquipmentState',(assert(itemIds[entry],'expected native item')))
    return state.worn or state.held
end
function player:removeAttachedItem(entry)
    local id=assert(itemIds[entry],'expected native attached item')
    if eventScope then
        transferOperation(entry,8,qa('transferRead',eventScope.actionId).sourceContainerId)
    elseif qa('removeAttachedItem',id) then
        __pz_dispatch('OnClothingUpdated',player)
    end
end
function player:removeFromHands(entry)
    transferOperation(entry,5,qa('transferRead',eventScope.actionId).sourceContainerId)
    return true
end
function player:removeWornItem(entry,reset)
    assert(reset==false,'unsupported worn removal reset branch')
    transferOperation(entry,7,qa('transferRead',eventScope.actionId).sourceContainerId)
end
Metabolics={LightWork='LightWork'}
function player:setMetabolicTarget(target) return hostCall('sourceContext','actorMetabolicTarget',target) end
CharacterTrait.HEMOPHOBIC='base:hemophobic'
CharacterTrait.DESENSITIZED='base:desensitized'
CharacterTrait.COWARDLY='base:cowardly'
CharacterTrait.BRAVE='base:brave'
ItemPickerJava={updateOverlaySprite=function(parent)
    assert(parent==player,'unsupported original overlay parent')
    assert(eventScope and eventScope.transferItemId,'overlay requires authorized source helper')
    transferOperation(sourceItem(eventScope.transferItemId),6,inventory:getID())
end}
ItemPicker=ItemPickerJava
DesignationZoneAnimal={removeItemFromGround=function(value)
    local square=assert(value:getSquare(),'animal-zone lookup needs source world square')
    assert(qa('animalZoneForSquare',squareRecords[square])==nil,
        'unsupported original animal-zone ground item removal')
end}
function isServer() hostCall('state');return false end
function CancelAction(index) assert(index==0);return ISTimedActionQueue.clear(player) end
function createItemTransaction(character,source,destination,inventoryValue)
    assert(character==player and source==nil and destination==nil and inventoryValue==inventory,'unsupported item transaction')
    local id=nextTransaction;nextTransaction=id+1;transactions[id]={character=character,destination=inventoryValue};return id
end
function removeItemTransaction(id,cancelled) assert(rawType(cancelled)=='boolean');transactions[id]=nil end
ISLogSystem={logAction=function(action)
    actorState.actionLog=actorState.actionLog or {}
    actorState.actionLog[#actorState.actionLog+1]={actionId=actionIds[action],type=action.Type}
    hostCall('sourceActionLog',actionIds[action],action.Type)
end}
local originalInstanceof=instanceof
function instanceof(value,class)
    local label=nativeTypes[value]
    if class=='IsoPlayer' or class=='IsoGameCharacter' then return label=='IsoPlayer' end
    if class=='IsoWorldInventoryObject' or class=='IItemProvider' then return label=='IsoWorldInventoryObject' end
    if class=='IsoDoor' then return label=='IsoDoor' end
    if class=='IsoObject' then
        if value==nil then return false end
        if label==nil then return originalInstanceof(value,class) end
        return label=='IsoPlayer' or label=='IsoDoor' or label=='IsoWorldInventoryObject'
    end
    if class=='BaseVehicle' or class=='IsoDeadBody' or class=='IsoMannequin' or class=='IsoThumpable'
        or class=='IsoClothingWasher' or class=='IsoClothingDryer' or class=='IsoCombinationWasherDryer' or class=='IsoStove' then
        if value==nil then return false end
        if label==nil then return originalInstanceof(value,class) end
        return label==class
    end
    if class=='DrainableComboItem' then
        local id=itemIds[value]
        if id==nil or not rawEqual(itemCache[id],value) then return false end
        return qa('itemIsDrainableComboItem',id)
    end
    if class=='Food' or class=='Clothing' then
        if value==nil or not itemIds[value] or label=='IsoWorldInventoryObject' then return false end
        return qa(class=='Food' and 'itemIsFood' or 'itemIsClothing',itemIds[value])
    end
    if class=='Radio' then
        if label~='InventoryItem' then return false end
        local kind=hostCall('itemDefinition',value:getFullType(),'type')
        return kind=='Radio' or kind=='base:radio'
    end
    local id=itemIds[value]
    if id~=nil and rawEqual(itemCache[id],value) then
        local fullType=hostCall('item',id,'fullType')
        local kind=hostCall('itemDefinition',fullType,'type') or 'Normal'
        return kind:lower():gsub('^base:','')==class:lower()
    end
    return originalInstanceof(value,class)
end
local function wrapQueue()
    if not ISTimedActionQueue or ISTimedActionQueue.__nativeQueue then return end
    ISTimedActionQueue.__nativeQueue=true
    local original=ISTimedActionQueue.new
    ISTimedActionQueue.new=function(self,character)
        assert(character==player,'unsupported source queue character')
        local value=original(self,character)
        if not restoring then value.queue=makeView('queue',0) end
        return value
    end
end
local function prepareSourceTransfer(entry,source,destination,square)
    assert(eventScope and eventScope.event==5 and eventScope.helperItemId==itemIds[entry],
        'shared transfer requires its original source action event')
    assert(eventScope.transferItemId==nil,'recursive native transfer helper')
    local definition=hostCall('itemDefinition',entry:getFullType())
    local kind=(definition.type or 'Normal'):lower():gsub('^base:','')
    assert(not definition.unsupportedSubtype and (kind=='normal' or kind=='item' or kind=='container' or kind=='clothing'),
        'unsupported original transfer subtype or side effects')
    assert(entry:getType()~='CandleLit' and entry:getType()~='Lantern_HurricaneLit','unsupported original replacement transfer')
    local function supportedFields(fields)
        for _,field in ipairs(fields) do
            assert(not field.name:lower():match('ammo') and not field.name:lower():match('fluid') and not field.name:lower():match('component'),
                'unsupported original ammo/fluid/entity transfer')
            if field.children then supportedFields(field.children) end
        end
    end
    supportedFields(definition.rawFields or {})
    local refs=qa('transferRead',eventScope.actionId)
    assert((qa('actionRead',eventScope.actionId).kind=='grab' or source:getID()==refs.sourceContainerId)
        and destination:getID()==refs.destinationContainerId,
        'original helper containers differ from immutable native intent')
    for _,value in ipairs({source,destination}) do
        local record=hostCall('container',value:getID())
        assert(record.kind=='actor' or record.kind=='floor' or record.kind=='bag','unsupported original container backend')
        assert(value:getType()~='TradeUI','unsupported original trading transfer')
    end
    if source:getType()=='floor' then
        local world=assert(entry:getWorldItem(),'floor source needs a true ground world item')
        local worldSquare=assert(world:getSquare(),'floor source lost world square')
        assert(qa('animalZoneForSquare',squareRecords[worldSquare])==nil,
            'unsupported original animal-zone transfer side effects')
    end
    if destination:getType()=='floor' then
        assert(square and square==destination:getSourceGrid(),'source-selected drop square differs from accepted native intent')
        assert(square:getApparentZ(0,0)==square:getZ() and square:getApparentZ(1,1)==square:getZ(),
            'unsupported original elevated floor item placement')
        player:isSeatedInVehicle()
        core:getOptionDropItemsOnSquareCenter()
    end
    local key=tostring(destination:getID())..':'..tostring(itemIds[entry])
    local policy=eventScope.containerPolicies and eventScope.containerPolicies[key]
    if policy==nil then
        policy=hostCall('container',destination:getID()).acceptItemFunction and -1 or 1
    end
    qa('transferBegin',eventScope.actionId,(assert(eventScope.groupId,'helper requires detached authorized group')),
        itemIds[entry],eventScope.token,policy)
    eventScope.transferItemId=itemIds[entry]
    eventScope.transferSourceContainerId=source:getID()
    eventScope.worldRemoved=false
end
local function sourceHelper(action,entry,original,...)
    assert(eventScope and eventScope.event==5 and eventScope.actionId==actionIds[action],
        'source transfer helper requires its authorized perform')
    assert(eventScope.helperItemId==nil,'recursive source transfer')
    local value=action.Type=='ISGrabItemAction' and entry:getItem() or entry
    eventScope.helperItemId=assert(itemIds[value],'helper needs stable inventory identity')
    local arguments=table.pack(...)
    local ok,result=pcall(function()
        if action.Type=='ISGrabItemAction' then
            local refs=qa('transferRead',eventScope.actionId)
            local owner=assert(hostCall('item',itemIds[value]),'grab helper lost native item').ownerContainerId
            prepareSourceTransfer(value,container(owner),container(refs.destinationContainerId),nil)
            transferOperation(value,1,owner)
        end
        return original(action,entry,table.unpack(arguments,1,arguments.n))
    end)
    if eventScope.transferItemId then
        -- PORT SAFETY: original helpers remove first; a failed supported helper restores native ownership/world/equipment.
        local finished,finishError=pcall(qa,'transferFinish',eventScope.actionId,eventScope.transferItemId,eventScope.token,ok)
        eventScope.transferItemId=nil
        if not finished then ok,result=false,finishError end
    end
    eventScope.helperItemId,eventScope.worldRemoved,eventScope.transferSourceContainerId=nil,nil,nil
    if not ok then rawError(result,0) end
    return result
end
function ZombRandFloat(minimum,maximum)
    assert(eventScope and eventScope.transferItemId,'random floor placement requires native helper authorization')
    return qa('transferRandom',eventScope.actionId,eventScope.transferItemId,eventScope.token,minimum,maximum,false)
end
function ZombRand(minimum,maximum)
    assert(maximum~=nil,'unsupported source random overload')
    assert(eventScope and eventScope.transferItemId,'random floor placement requires native helper authorization')
    return qa('transferRandom',eventScope.actionId,eventScope.transferItemId,eventScope.token,minimum,maximum,true)
end
function __pz_source_loaded()
    wrapQueue()
    if not sourceDoorCompletion and ISWorldObjectContextMenu and rawType(ISWorldObjectContextMenu.onOpenCloseDoor)=='function' then
        sourceDoorCompletion=ISWorldObjectContextMenu.onOpenCloseDoor
    end
    for _,name in ipairs({'ISGrabItemAction','ISInventoryTransferAction','ISOpenCloseDoor','ISWalkToTimedAction','ISWaitWhileGettingUp'}) do
        local prototype=rawget(root,name)
        if rawType(prototype)=='table' and not sourceClasses[name] then
            sourceClasses[name],sourceConstructors[name]=prototype,prototype.new
        end
    end
    if ISTimedActionQueue and not rawget(ISTimedActionQueue,'__nativeReset') then
        ISTimedActionQueue.__nativeReset=true
        local original=ISTimedActionQueue.resetQueue
        if original then ISTimedActionQueue.resetQueue=function(self,...)
            if eventScope and eventScope.event==6 and qa('lookup',eventScope.actionId)==0 and qa('length')>0 then
                self.current=self.queue[1]
                return
            end
            return original(self,...)
        end end
    end
    if ISInventoryTransferAction and not rawget(ISInventoryTransferAction,'__nativeAdmission') then
        ISInventoryTransferAction.__nativeAdmission=true
        local original=ISInventoryTransferAction.new
        ISInventoryTransferAction.new=function(self,character,entry,source,destination,time)
            allowSourceAdmission()
            if floorViews[source] then
                assert(source:contains(entry),'source item is not in the live floor presentation')
                source=entry:getContainer()
            end
            if floorViews[destination] then destination=floorViewRoot(destination) end
            return original(self,character,entry,source,destination,time)
        end
    end
    if ISGrabItemAction and not rawget(ISGrabItemAction,'__nativeAdmission') then
        ISGrabItemAction.__nativeAdmission=true
        local original=ISGrabItemAction.new
        ISGrabItemAction.new=function(self,character,value,time)
            allowSourceAdmission()
            local permit
            if selectionPermits then
                selectionPermits.cursor=selectionPermits.cursor+1
                permit=assert(selectionPermits[selectionPermits.cursor],'source selected more items than preflight admitted')
                assert(itemIds[value]==permit.targetId,'source item differs from preflight replacement')
            end
            assert(sourceAdmissionPermit==nil,'recursive source item constructor')
            sourceAdmissionPermit=permit
            local ok,action=pcall(original,self,character,value,time)
            sourceAdmissionPermit=nil
            if not ok then rawError(action,0) end
            if permit and permit.cancelled then action.ignoreAction=true end
            return action
        end
    end
    for _,name in ipairs({'ISGrabItemAction','ISInventoryTransferAction'}) do
        local prototype=rawget(root,name)
        if prototype and not rawget(prototype,'__nativeTransferHelper') then
            prototype.__nativeTransferHelper=true
            local original=prototype.transferItem
            prototype.transferItem=function(action,entry,...) return sourceHelper(action,entry,original,...) end
        end
    end
    if ISTransferAction and not rawget(ISTransferAction,'__nativeTransferHelper') then
        ISTransferAction.__nativeTransferHelper=true
        local original=ISTransferAction.transferItem
        ISTransferAction.transferItem=function(self,character,entry,source,destination,square)
            assert(character==player,'unsupported original transfer actor')
            prepareSourceTransfer(entry,source,destination,square)
            return original(self,character,entry,source,destination,square)
        end
    end
    if ISBaseTimedAction and not rawget(ISBaseTimedAction,'__nativeForceCancel') then
        ISBaseTimedAction.__nativeForceCancel=true
        local original=ISBaseTimedAction.forceCancel
        ISBaseTimedAction.forceCancel=function(action,...)
            if forceCancelled[action] then return end
            forceCancelled[action]=true
            return original(action,...)
        end
    end
    for _,name in ipairs({'ISBaseTimedAction','ISTimedActionQueue','ISGrabItemAction','ISInventoryTransferAction','ISTransferAction','ISOpenCloseDoor','ISWalkToTimedAction','ISWaitWhileGettingUp','ISWorldObjectContextMenu','ISContextMenu'}) do
        local prototype=rawget(root,name)
        if rawType(prototype)=='table' then
            if (sourceClasses[name] or name=='ISBaseTimedAction' or name=='ISTransferAction') and not sourceMethods[name] then
                local methods={}
                for _,method in ipairs(sourceMethodNames) do methods[method]=prototype[method] end
                sourceMethods[name]=methods
            end
            for _,fn in pairs(prototype) do if rawType(fn)=='function' and not methodOwners[fn] then methodOwners[fn]=context() end end
        end
    end
end
function __pz_source_event(event)
    local action=assert(actionObjects[event.actionId],'source event has no resident original action')
    assert(restoredDoorContinuations[event.actionId]==nil or event.event==6,'source restore continuation must be bound after player lifecycle before ticking')
    local owner=assert(actionOwners[event.actionId],'source action lost callback owner')
    assert(eventScope==nil,'recursive source action event')
    local method=({'isValid','waitToStart','start','update','perform','stop','begin'})[event.event]
    assert(method and rawType(action[method])=='function','unsupported source action callback '..tostring(method))
    if event.event==7 then assert(not sourceBegun[event.actionId],'duplicate source BEGIN authorization') end
    eventScope=event
    local methodOwner=methodOwners[action[method]] or owner
    local callbackOwner={id=methodOwner.id,path=methodOwner.path,apiId=owner.apiId}
    local ok,result=xpcall(function()
        guarded(owner,function() hostCall('sourceOwnerAlive') end)
        if event.event==6 then
            for id,queued in pairs(actionObjects) do
                if id~=event.actionId and actionOwners[id] and qa('lookup',id)==0 and not forceCancelled[queued] and not sourceBegun[id] then
                    if queued.forceCancel then guarded(actionOwners[id],function() queued:forceCancel() end) end
                end
            end
        end
        return guarded(callbackOwner,function()
            hostCall('sourceOwnerAlive')
            if event.event==5 then
                if (action.Type=='ISGrabItemAction' or action.Type=='ISInventoryTransferAction') and #action.queueList>0 then
                    event.groupId=qa('groupGet',event.actionId,0)
                end
                if action.Type=='ISOpenCloseDoor' and action.complete then action:complete() end
            end
            local value=action[method](action)
            if event.event==1 or event.event==2 then return value and 1 or 0 end
            return 0
        end)
    end,function(err) return err end)
    eventScope=nil
    -- Native eventReply may authorize a detached same-action STOP; retirement follows slot lifetime, not FIFO membership.
    if not ok then rawError(result,0) end
    return result
end
function __pz_source_cleanup(ownerId)
    local failures={}
    withdrawingOwners[ownerId]=true
    local ok,err=pcall(function()
        local owned=false
        for id,owner in pairs(actionOwners) do
            if (owner.id==ownerId or owner.apiId==ownerId) and qa('actionExists',id) then owned=true;break end
        end
        if owned then
            for actionId,action in pairs(actionObjects) do
                if actionOwners[actionId] and not sourceBegun[actionId] and not forceCancelled[action] and action.forceCancel then
                    local cancelled,cancelError=pcall(guarded,actionOwners[actionId],function() action:forceCancel() end)
                    if not cancelled then failures[#failures+1]=cancelError end
                end
            end
            local cleared,clearError=pcall(function() qa('clear');drainSourceLifecycle() end)
            if not cleared then failures[#failures+1]=clearError end
        end
        for id,action in pairs(actionObjects) do
            if not qa('actionExists',id) then
                actionIds[action]=nil
                actionObjects[id],actionOwners[id],actionHandles[id],sourceBegun[id]=nil,nil,nil,nil
            end
        end
        local queue=ISTimedActionQueue and ISTimedActionQueue.queues[player]
        if queue then
            local current=qa('current')
            queue.current=current~=0 and residentAction(current) or nil
        end
    end)
    if not ok then failures[#failures+1]=err end
    withdrawingOwners[ownerId]=nil
    return failures
end
function __pz_source_prepare_save()
    for id,owner in pairs(actionOwners) do
        if qa('lookup',id)~=0 then
            assert(restoredDoorContinuations[id]==nil,'source restore continuation is not bound for save capture')
            local action=assert(actionObjects[id],'source save lost resident table')
            guarded(owner,function()
                qa('actionSet',id,10,portable(action) and 1 or 0)
                if action.Type=='ISGrabItemAction' or action.Type=='ISInventoryTransferAction' then qa('actionSet',id,11,action.started and 1 or 0) end
                if action.Type=='ISInventoryTransferAction' then qa('actionSet',id,12,action.allowMissingItems and 1 or 0) end
            end)
        end
    end
end
function __pz_source_owners()
    local result={}
    for id,owner in pairs(actionOwners) do
        if qa('lookup',id)~=0 then result[#result+1]={actionId=id,ownerId=owner.apiId or owner.id} end
    end
    return result
end
local constructSource
do
local sources={
    walk={name='ISWalkToTimedAction',path='TimedActions/WalkToTimedAction'},
    door={name='ISOpenCloseDoor',path='TimedActions/ISOpenCloseDoor'},
    grab={name='ISGrabItemAction',path='TimedActions/ISGrabItemAction'},
    transfer={name='ISInventoryTransferAction',path='TimedActions/ISInventoryTransferAction'},
    getUp={name='ISWaitWhileGettingUp',path='TimedActions/ISWaitWhileGettingUp'},
}
constructSource=function(row,deferDoorCompletion)
    local source=assert(sources[row.kind],'unsupported source constructor '..tostring(row.kind))
    local name=source.name
    if not sourceClasses[name] then require(source.path) end
    local prototype=assert(sourceClasses[name],'original source constructor is not loaded: '..name)
    local constructor=assert(sourceConstructors[name],'original source constructor identity missing')
    if row.kind=='walk' then return constructor(prototype,player,(assert(cell:getGridSquare(row.target.x,row.target.y,row.target.z),'source square unavailable'))) end
    if row.kind=='door' then return constructor(prototype,player,door(row.target.id)) end
    if row.kind=='grab' then
        local first=assert(row.groups[1] and row.groups[1].itemIds[1],'source grab has no stable group')
        return constructor(prototype,player,worldItem(first),row.rawTime)
    end
    if row.kind=='transfer' then
        local refs=qa('transferRead',row.id)
        local first=assert(row.groups[1] and row.groups[1].itemIds[1],'source transfer has no stable group')
        return constructor(prototype,player,sourceItem(first),container(refs.sourceContainerId),container(refs.destinationContainerId),row.rawTime)
    end
    local action=constructor(prototype,player)
    if not deferDoorCompletion and row.target.id and row.target.id~=4294967295 then
        local value=door(row.target.id)
        action:setOnComplete(assert(sourceDoorCompletion,'original door continuation unavailable'),{value},value,0)
    end
    return action
end
end
residentAction=function(id)
    if actionObjects[id] then return actionObjects[id] end
    local row=qa('actionRead',id)
    assert(row.origin=='sdk','native source action lost its original resident table')
    row.groups={}
    for index=0,row.groupCount-1 do row.groups[#row.groups+1]=qa('groupRead',qa('groupGet',id,index)) end
    local oldQueue=ISTimedActionQueue.queues[player]
    local oldRestoring,oldPermits,oldAdmission=restoring,selectionPermits,sourceAdmissionPermit
    restoring,selectionPermits,sourceAdmissionPermit=true,nil,nil
    ISTimedActionQueue.queues[player]=nil
    local ok,action=pcall(constructSource,row)
    ISTimedActionQueue.queues[player]=oldQueue
    restoring,selectionPermits,sourceAdmissionPermit=oldRestoring,oldPermits,oldAdmission
    if not ok then rawError(action,0) end
    actionIds[action],actionObjects[id]=id,action
    if row.kind=='grab' or row.kind=='transfer' then bindGroups(action,id,nil) end
    action.action=handle(action,id)
    local previous=getmetatable(action)
    local index=previous.__index
    rawset(action,'maxTime',nil)
    if row.kind=='grab' or row.kind=='transfer' or row.kind=='door' then rawset(action,'item',nil) end
    setmetatable(action,{__index=function(value,key)
        if key=='maxTime' then return qa('actionRead',id).maxTime end
        if key=='item' then
            local current=qa('actionRead',id)
            if current.kind=='door' then return door(current.target.id) end
            return current.kind=='transfer' and sourceItem(current.target.id) or worldItem(current.target.id)
        end
        if rawType(index)=='function' then return index(value,key) end
        return index[key]
    end,__newindex=function(value,key,input)
        if key=='maxTime' or key=='item' then rawError(fault('SDK-owned action state must mutate through native queue'),2) end
        if previous.__newindex then return previous.__newindex(value,key,input) end
        rawset(value,key,input)
    end})
    action.begin=function()
        local current=qa('actionRead',id)
        if qa('current')==id and current.started then return end
        qa('start',id,current.rawTime,0)
    end
    return action
end
function __pz_source_sync()
    if not ISTimedActionQueue or not ISTimedActionQueue.__nativeQueue then return end
    local borrowed=qa('retriggerGet')
    for id,action in pairs(actionObjects) do
        if not qa('actionExists',id) and id~=borrowed then
            if actionOwners[id] and not sourceBegun[id] and not forceCancelled[action] and action.forceCancel then
                guarded(actionOwners[id],function() action:forceCancel() end)
            end
            actionIds[action]=nil
            actionObjects[id],actionOwners[id],actionHandles[id],sourceBegun[id]=nil,nil,nil,nil
            restoredDoorContinuations[id]=nil
        end
    end
    local queue=ISTimedActionQueue.queues[player]
    if queue then
        local current=qa('current')
        queue.current=current~=0 and residentAction(current) or nil
    end
end
function __pz_source_restore(state,owners,constructorOwner)
    local rows={}
    if state.current then rows[#rows+1]=state.current end
    for _,row in ipairs(state.pending) do rows[#rows+1]=row end
    local hasSource=false
    for _,row in ipairs(rows) do if row.origin=='lua' then hasSource=true end end
    if not hasSource then return end
    local ownerById={}
    for _,owner in ipairs(owners) do ownerById[owner.actionId]=owner end
    require 'TimedActions/ISTimedActionQueue'
    require 'TimedActions/ISGrabItemAction'
    for _,row in ipairs(rows) do
        if row.kind=='transfer' then
            require 'TimedActions/ISInventoryTransferAction'
            require 'TimedActions/ISTransferAction'
            break
        end
    end
    require 'TimedActions/ISOpenCloseDoor'
    require 'TimedActions/WalkToTimedAction'
    require 'TimedActions/ISWaitWhileGettingUp'
    local previousQueue=ISTimedActionQueue.queues[player]
    local previousObjects,previousOwners,previousHandles,previousGroups,previousIds,previousBegun=actionObjects,actionOwners,actionHandles,groupObjects,actionIds,sourceBegun
    local previousContinuations=restoredDoorContinuations
    restoredDoorContinuations={}
    restoring=true
    ISTimedActionQueue.queues[player]=nil
    actionObjects,actionOwners,actionHandles,groupObjects,sourceBegun={},{},{},setmetatable({}, {__mode='v'}),{}
    actionIds=setmetatable({}, {__mode='k'})
    local ok,err=pcall(function()
        for _,row in ipairs(rows) do
            if row.origin=='lua' then
                local owner=assert(ownerById[row.id],'source restore owner missing')
                guarded(constructorOwner or owner,function()
                local deferCompletion=row.kind=='getUp' and row.target.id and row.target.id~=4294967295
                local action=constructSource(row,deferCompletion)
                if deferCompletion then restoredDoorContinuations[row.id]=row.target.id end
                assert(portable(action),'source restore needs nonportable callbacks')
                local current=state.current and state.current.id==row.id
                action.maxTime=current and qa('sourceTime',row.id) or row.rawTime
                actionIds[action],actionObjects[row.id],actionOwners[row.id]=row.id,action,owner
                if row.kind=='grab' or row.kind=='transfer' then
                    bindGroups(action,row.id,nil)
                    action.item=row.kind=='transfer' and sourceItem(row.groups[1].itemIds[1]) or worldItem(row.groups[1].itemIds[1])
                    action.started=(qa('actionRead',row.id).flags & 256)~=0
                    if row.kind=='transfer' then action.allowMissingItems=(qa('actionRead',row.id).flags & 1024)~=0 end
                end
                if current then action.action=handle(action,row.id);sourceBegun[row.id]=true end
                end)
            end
        end
        local queue=ISTimedActionQueue.getTimedActionQueue(player)
        queue.queue=makeView('queue',0)
        queue.current=state.current and residentAction(state.current.id) or nil
    end)
    restoring=false
    if not ok then
        ISTimedActionQueue.queues[player]=previousQueue
        actionObjects,actionOwners,actionHandles,groupObjects,actionIds,sourceBegun=previousObjects,previousOwners,previousHandles,previousGroups,previousIds,previousBegun
        restoredDoorContinuations=previousContinuations
        rawError(err,0)
    end
end
function __pz_source_complete_restore()
    -- Original Grab.transferItem uses this global without declaring a require.
    -- Bind it after creation events, just as the fresh lazy UI route does.
    for id,action in pairs(actionObjects) do
        if actionOwners[id] and action.Type=='ISGrabItemAction' and qa('actionExists',id) then
            require 'ISUI/PlayerData/ISPlayerData'
            break
        end
    end
    if next(restoredDoorContinuations)==nil then return end
    -- Only the original get-up door continuation needs this UI graph. Loading it
    -- during hydration registers the full-HUD OnCreatePlayer before its prerequisites.
    require 'ISUI/ISWorldObjectContextMenu'
    for id,doorId in pairs(restoredDoorContinuations) do
        if qa('actionExists',id) then
            local action=assert(actionObjects[id],'source restore lost its resident continuation')
            local owner=assert(actionOwners[id],'source restore lost its continuation owner')
            guarded(owner,function()
                hostCall('sourceOwnerAlive')
                local value=door(doorId)
                action:setOnComplete(assert(sourceDoorCompletion,'original door continuation unavailable'),{value},value,0)
                assert(portable(action),'source restore needs nonportable callbacks')
            end)
        end
        restoredDoorContinuations[id]=nil
    end
end
`;

const EQUIPMENT_PRELUDE = String.raw`
local function equipment(operation, ...) return hostCall('equipment', operation, ...) end
local locations, locationIds, groups, members = {}, setmetatable({}, {__mode='k'}), {}, {}
local resources, resourceNames = {}, setmetatable({}, {__mode='k'})
ResourceLocation = {}
function ResourceLocation.of(name)
    local canonical=equipment('canonical',name)
    if resources[canonical] then return resources[canonical] end
    local value=nativeObject('ResourceLocation')
    function value:toString() return canonical end
    getmetatable(value).__tostring=function() return canonical end
    resources[canonical],resourceNames[value]=value,canonical
    return value
end
locationToken=function(value)
    return (assert(locationIds[value], 'expected native ItemBodyLocation'))
end
locationObject=function(token)
    if token==nil or token==0 then return nil end
    if locations[token] then return locations[token] end
    local value=nativeObject('ItemBodyLocation')
    function value:toString() return equipment('read',token,0) end
    function value:getTranslationName() return equipment('read',token,1) end
    getmetatable(value).__tostring=function() return value:toString() end
    locations[token],locationIds[value]=value,token
    return value
end
ItemBodyLocation=setmetatable({}, {__index=function(_,name)
    for index=0,equipment('count')-1 do
        local token=equipment('at',index)
        local constant=equipment('read',token,2)
        if constant and constant~='' then rawset(ItemBodyLocation,constant,locationObject(token)) end
    end
    local value=rawget(ItemBodyLocation,name)
    assert(value~=nil,'unknown ItemBodyLocation constant: '..tostring(name))
    return value
end})
function ItemBodyLocation.get(resource)
    return locationObject(equipment('lookup',(assert(resourceNames[resource],'expected native ResourceLocation'))))
end
function ItemBodyLocation.register(name) return locationObject(equipment('register',name)) end
local groupObject
local function memberObject(group,token)
    if token==nil or token==0 then return nil end
    members[group]=members[group] or {}
    if members[group][token] then return members[group][token] end
    local value=nativeObject('BodyLocation')
    function value:getId() return locationObject(token) end
    function value:isId(other) return token==locationToken(other) end
    function value:isMultiItem() return equipment('multiGet',group,token) end
    function value:setMultiItem(enabled) equipment('multiSet',group,token,enabled);return self end
    for _,pair in ipairs({{'Exclusive',3},{'HideModel',1},{'AltModel',2}}) do
        local suffix,kind=pair[1],pair[2]
        value['set'..suffix]=function(self,other) equipment('relationSet',group,token,locationToken(other),kind);return self end
        value['is'..suffix]=function(self,other) return equipment('relationGet',group,token,locationToken(other),kind) end
    end
    members[group][token]=value
    return value
end
groupObject=function(token)
    if token==nil or token==0 then return nil end
    if groups[token] then return groups[token] end
    local value=nativeObject('BodyLocationGroup')
    function value:getId() return equipment('groupName',token) end
    function value:size() return equipment('locationCount',token) end
    function value:getLocation(location)
        local id=locationToken(location)
        return equipment('locationIndex',token,id)>=0 and memberObject(token,id) or nil
    end
    function value:getOrCreateLocation(location)
        local id=locationToken(location)
        equipment('locationAdd',token,id)
        return memberObject(token,id)
    end
    function value:getLocationByIndex(index)
        assert(rawType(index)=='number' and index%1==0,'location index must be an integer')
        if index<0 or index>=self:size() then return nil end
        return memberObject(token,equipment('locationAt',token,index))
    end
    function value:indexOf(location) return equipment('locationIndex',token,locationToken(location)) end
    function value:moveLocationToIndex(location,index) equipment('move',token,locationToken(location),index) end
    function value:setMultiItem(location,enabled) equipment('multiSet',token,locationToken(location),enabled) end
    function value:isMultiItem(location) return equipment('multiGet',token,locationToken(location)) end
    for _,pair in ipairs({{'Exclusive',0},{'HideModel',1},{'AltModel',2}}) do
        local suffix,kind=pair[1],pair[2]
        value['set'..suffix]=function(self,a,b) equipment('relationSet',token,locationToken(a),locationToken(b),kind) end
        value['is'..suffix]=function(self,a,b) return equipment('relationGet',token,locationToken(a),locationToken(b),kind) end
    end
    local all=indexedCollection(function() return value:size() end,function(index) return value:getLocationByIndex(index) end)
    function value:getAllLocations() return all end
    groups[token]=value
    return value
end
BodyLocations={}
function BodyLocations.getGroup(name) return groupObject(equipment('groupGet',name,true)) end
function BodyLocations.reset() equipment('reset') end
local allGroups=indexedCollection(function() return equipment('groupCount') end,function(index) return groupObject(equipment('groupAt',index)) end)
function BodyLocations.getAllGroups() return allGroups end
local worn=nativeObject('WornItems')
local wornRecords={}
local function wornRecord(index)
    local row=equipment('wornRead',index)
    assert(row,'worn item index out of range')
    local key=tostring(row.id)..':'..tostring(row.location)
    if not wornRecords[key] then
        local value=nativeObject('WornItem')
        function value:getItem() return sourceItem(row.id) end
        function value:getLocation() return locationObject(row.location) end
        wornRecords[key]=value
    end
    return wornRecords[key]
end
function worn:getBodyLocationGroup() return groupObject(equipment('wornGroupGet')) end
function worn:size() return equipment('wornCount') end
function worn:isEmpty() return self:size()==0 end
function worn:get(index) return wornRecord(index) end
function worn:getItem(location) return sourceItem(equipment('wornGet',locationToken(location))) end
function worn:getItemByIndex(index)
    if index<0 or index>=self:size() then return nil end
    return self:get(index):getItem()
end
function worn:getItemById(id)
    for index=0,self:size()-1 do local entry=self:get(index):getItem();if itemIds[entry]==id then return entry end end
    return nil
end
function worn:setItem(location,value)
    local id=value~=nil and (assert(itemIds[value],'expected native InventoryItem')) or nil
    equipment('wornSet',locationToken(location),id)
end
function worn:getLocation(value)
    local id=itemIds[value]
    if not id then return nil end
    for index=0,self:size()-1 do local row=equipment('wornRead',index);if row.id==id then return locationObject(row.location) end end
    return nil
end
function worn:contains(value) return self:getLocation(value)~=nil end
function worn:remove(value) equipment('wornRemove',(assert(itemIds[value],'expected native InventoryItem'))) end
function worn:clear() equipment('wornClear') end
function worn:forEach(consumer)
    local index=0
    while index<self:size() do consumer(self:get(index));index=index+1 end
end
local wornList=indexedCollection(function() return worn:size() end,wornRecord)
function worn:getItems() return wornList end
function player:getWornItems() return worn end
function player:setWornItem(location,value) worn:setItem(location,value) end
local previousInstanceof=instanceof
function instanceof(value,class)
    if class=='InventoryItem' then return itemIds[value]~=nil and nativeTypes[value]~='IsoWorldInventoryObject' end
    if class=='InventoryContainer' then return nativeTypes[value]=='InventoryContainer' end
    if class=='ItemContainer' then return nativeTypes[value]=='ItemContainer' end
    if class=='ItemBodyLocation' or class=='ResourceLocation' or class=='BodyLocationGroup' or class=='BodyLocation' or class=='WornItems' or class=='WornItem' then
        return nativeTypes[value]==class
    end
    return previousInstanceof(value,class)
end
`;

/* All wrappers are Lua functions: colon arguments and event function identity
   never depend on JS object proxies or roundtripped Lua function wrappers. */
const PRELUDE = `
local hostCall, enter, leave, context, fault, own = __pz_call, __pz_enter, __pz_leave, __pz_context, __pz_fault, __pz_own
local rawLoad, info, upvalue, join = load, debug.getinfo, debug.getupvalue, debug.upvaluejoin
local rawError, rawWarn, traceback, rawNext = error, warn, debug.traceback, next
local rawType = type
local rawEqual = rawequal
local rawStringSub = string.sub
local rawPrint = print
local nativeTypes = setmetatable({}, {__mode = 'k'})
function type(value)
    local kind = rawType(value)
    if kind == 'table' and nativeTypes[value] then return 'userdata' end
    return kind
end
local root, threadEnv = _G, _G
local envs = setmetatable({}, {__mode = 'k'})
local records, modules, loaded, loading, handlers, executed = {}, {}, {}, {}, {}, {}
local optionRegistry = {}
local playerData = setmetatable({}, {__newindex = function(t, k, v) own(k); rawset(t, k, v) end})
local delta = 0
unpack = table.unpack
table.ipairs = function(t)
    return function(values, i) i = i + 1; local v = rawget(values, i); if v ~= nil then return i, v end end, t, 0
end
table.pairs = function(t) return rawNext, t, nil end

local function envIndex(fn)
    for i = 1, math.huge do local name = upvalue(fn, i); if not name then return nil end; if name == '_ENV' then return i end end
end
local function targetFunction(target)
    if target == nil then target = 1 end
    if type(target) == 'function' then return target end
    assert(type(target) == 'number' and target >= 0 and target % 1 == 0, 'invalid environment stack level')
    if target == 0 then return nil end
    local frame = info(target + 2, 'f')
    assert(frame, 'invalid environment stack level')
    return frame.func
end
function getfenv(target)
    local fn = targetFunction(target)
    if not fn then return threadEnv end
    local index = envIndex(fn)
    if index then local _, env = upvalue(fn, index); return env end
    return envs[fn] or threadEnv
end
function setfenv(target, env)
    assert(type(env) == 'table', 'setfenv environment must be a table')
    local fn = targetFunction(target)
    if not fn then threadEnv = env; return end
    assert(info(fn, 'S').what ~= 'C', 'cannot change environment of a native function')
    local index = envIndex(fn)
    if index then
        -- Detach this closure's _ENV cell; siblings keep their original cell.
        local function holder() return env end
        join(fn, index, holder, 1)
    end
    envs[fn] = env
    return fn
end
function loadstring(source, name)
    assert(type(source) == 'string', 'loadstring expects source text')
    if source:byte(1) == 27 then rawError('unsupported Lua/Kahlua bytecode', 2) end
    return rawLoad(source, name, 't', threadEnv)
end
function load(source, name, mode, env)
    if mode and mode ~= 't' then rawError('unsupported bytecode load mode', 2) end
    if type(source) == 'string' and source:byte(1) == 27 then rawError('unsupported Lua/Kahlua bytecode', 2) end
    return rawLoad(source, name, 't', env or threadEnv)
end

local function guarded(owner, fn, ...)
    enter(owner.id, owner.path, owner.apiId)
    local args = table.pack(...)
    local result = table.pack(xpcall(function() return fn(table.unpack(args, 1, args.n)) end,
        function(err) return fault(traceback(tostring(err), 2)) end))
    leave()
    if not result[1] then rawError(result[2], 0) end
    return table.unpack(result, 2, result.n)
end
local function sourceFunction(record)
    local fn, err = rawLoad(record.source, '@' .. record.nativeId .. '/' .. record.path, 't', threadEnv)
    if not fn then return nil, err end
    return fn
end
local function evaluate(record, name)
    local key = record.id .. '/' .. record.path
    if executed[key] ~= nil then return executed[key] end
    -- LuaManager.RunLua tracks the source path for both startup execution and require.
    if loading[key] then return nil end
    if record.engineSource and record.path == 'media/lua/client/ISUI/ISInventoryPage.lua' then
        local action = modules['timedactions/isinventorytransferaction']
        if action and action.engineSource and not loading[action.id .. '/' .. action.path] then
            evaluate(action, 'TimedActions/ISInventoryTransferAction')
            if executed[key] ~= nil then return executed[key] end
        end
    end
    loading[key] = true
    local ok, value = pcall(guarded, record, function()
        local equipmentStartup=record.engineSource and record.path:lower()=='media/lua/shared/npcs/bodylocations.lua'
        if equipmentStartup and hostCall('equipment','initialized') then return true end
        -- This original action's top-level Page write is an implicit dependency.
        -- Enter the action first so Page -> Pane -> Util -> Action observes native recursive nil.
        if record.engineSource and record.path == 'media/lua/client/TimedActions/ISInventoryTransferAction.lua' then
            require 'ISUI/ISInventoryPage'
        end
        local fn, err = sourceFunction(record)
        if not fn then rawError(err, 0) end
        local result = fn(name)
        if equipmentStartup then hostCall('equipment','initialized',true) end
        if __pz_source_loaded then __pz_source_loaded() end
        return result
    end)
    loading[key] = nil
    if not ok then rawError(value, 0) end
    if value == nil then value = true end
    executed[key] = value
    return value
end
function require(name)
    assert(type(name) == 'string', 'require expects a module path')
    name = name:gsub('\\\\', '/'):gsub('%.lua$', '')
    local lookupName = name:lower()
    if loaded[lookupName] ~= nil then return loaded[lookupName] end
    local record = modules[lookupName]
    if not record then
        rawWarn('missing native Lua module: ' .. name)
        return nil
    end
    if loading[record.id .. '/' .. record.path] then return nil end
    local value = evaluate(record, name)
    if value == nil then value = true end
    loaded[lookupName] = value
    return value
end

Events = setmetatable({}, {__index = function(_, name) rawError(fault('unsupported event: Events.' .. tostring(name)), 2) end})
local function addEvent(name)
    local event = {}
    handlers[name] = {}
    function event.Add(a, b)
        local fn = a == event and b or a
        assert(type(fn) == 'function', 'Events.' .. name .. '.Add expects a Lua function')
        for _, item in ipairs(handlers[name]) do if item.fn == fn then return end end
        local owner = context()
        handlers[name][#handlers[name] + 1] = {fn = fn, id = owner.id, path = owner.path, apiId = owner.apiId}
    end
    function event.Remove(a, b)
        local fn = a == event and b or a
        for i = #handlers[name], 1, -1 do if handlers[name][i].fn == fn then table.remove(handlers[name], i) end end
    end
    Events[name] = event
end
for _, name in ipairs(__pz_events) do addEvent(name) end

local function unsupported(name)
    return function() rawError(fault('unsupported native facility: ' .. name), 2) end
end
local function nativeObject(name)
    local value = setmetatable({}, {__index = function(_, method) return unsupported(name .. ':' .. tostring(method)) end})
    nativeTypes[value] = name
    if name=='IsoWorldInventoryObject' or name=='IsoDoor' then
        -- Inherited IsoObject.getChunk delegates to the current square, including detached nil.
        function value:getChunk()
            local square=self:getSquare()
            return square and square:getChunk() or nil
        end
        -- These concrete classes cannot be IsoBarbecue or IsoFireplace, regardless of item name or sprite.
        function value:isPropaneBBQ()
            assert(rawEqual(self,value),'expected native world object')
            return false
        end
        function value:isFireInteractionObject()
            assert(rawEqual(self,value),'expected native world object')
            return false
        end
        -- The represented fresh constructors leave IsoObject.name null; item display names are a separate field.
        function value:getName()
            assert(rawEqual(self,value),'expected native world object')
            return nil
        end
    end
    return value
end
function string.sort(first,second)
    assert(rawType(first)=='string' and rawType(second)=='string',
        'unsupported native facility: string.sort requires strings; Java numeric coercion is unsupported')
    return hostCall('sourceStringSort',first,second)
end
function timSort(items,compare)
    -- LuaManager.GlobalObject snapshots delegate.values(), sorts, then rawsets indices i+1.
    if rawType(items)~='table' or nativeTypes[items] or rawlen(items)<2 or compare==nil then return end
    local values={}
    for _,value in table.ipairs(items) do values[#values+1]=value end
    local sequenceLength=#values
    for key,value in rawNext,items do
        if rawType(key)~='number' or key%1~=0 or key<1 or key>sequenceLength then
            values[#values+1]=value
        end
    end
    -- Only ordinals cross Wasmoon: native userdata and cyclic Lua tables stay resident.
    local order=hostCall('sourceTimSort',#values,function(a,b)
        local first,second=values[a],values[b]
        if rawEqual(first,second) then return 0 end
        -- TimSortComparator uses pcallBoolean == Boolean.TRUE, not Lua truthiness.
        local ok,result=pcall(compare,first,second)
        return ok and result==true and -1 or 1
    end)
    for index,ordinal in ipairs(order) do rawset(items,index,values[ordinal]) end
end
local locationObject, locationToken
local player = nativeObject('IsoPlayer')
-- Original IsoPlayer flag is independent from ItemContainer.drawDirty; animal eating is its native producer.
local inventoryPageDirty=false
function player:isInvPageDirty() hostCall('state');return inventoryPageDirty end
function player:setInvPageDirty(enabled)
    assert(rawType(enabled)=='boolean','inventory page dirty state must be boolean')
    hostCall('state');inventoryPageDirty=enabled
end
function player:getX() return hostCall('state').x end
function player:getY() return hostCall('state').y end
function player:getPlayerNum() return 0 end
function player:isLocalPlayer() hostCall('state'); return true end
function player:getCurrentSpeed() return hostCall('state').speed end
function player:setSpeed(speed) hostCall('speed', speed) end
function player:moveTo(x, y) hostCall('action', 'moveTo', x, y) end
function player:walk(x, y) hostCall('action', 'walk', x, y) end
function player:cancelAction() hostCall('action', 'cancel') end
function player:getModData() return playerData end
function player:transmitModData() hostCall('flush') end
local cell = nativeObject('IsoCell')
local squares = setmetatable({}, {__mode = 'v'})
local squareRecords = setmetatable({}, {__mode = 'k'})
local chunks = setmetatable({}, {__mode = 'v'})
function cell:getGridSquare(x, y, z)
    local record = hostCall('square', x, y, z)
    if record == nil then return nil end
    local key = record.x .. ':' .. record.y .. ':' .. record.z
    if squares[key] then return squares[key] end
    local square = nativeObject('IsoGridSquare')
    local function current()
        local value = hostCall('square', record.x, record.y, record.z)
        if value == nil then rawError(fault('source square disappeared: ' .. key), 2) end
        return value
    end
    function square:getX() return current().x end
    function square:getY() return current().y end
    function square:getZ() return current().z end
    function square:DistToProper(other,...)
        assert(select('#',...)==0,'unsupported IsoGridSquare DistToProper overload')
        local source,target=squareRecords[self],squareRecords[other]
        assert(source and target,'DistToProper requires genuine IsoGridSquare values')
        return hostCall('sourceActions','squareDistanceToProper',source.x,source.y,source.z,target.x,target.y,target.z)
    end
    function square:getChunk()
        local chunk=hostCall('sourceActions','squareChunk',record.x,record.y,record.z)
        if chunk==nil then return nil end
        local identity=chunk.generation..':'..chunk.x..':'..chunk.y
        if not chunks[identity] then chunks[identity]=nativeObject('IsoChunk') end
        return chunks[identity]
    end
    function square:canStand() return current().canStand end
    function square:isBlockedTo(other, ...)
        assert(select('#', ...) == 0, 'unsupported IsoGridSquare isBlockedTo overload')
        local source = squareRecords[self]
        local target = other ~= nil and squareRecords[other] or nil
        assert(source ~= nil, 'isBlockedTo requires a genuine IsoGridSquare receiver')
        assert(other == nil or target ~= nil, 'isBlockedTo requires a genuine IsoGridSquare or nil')
        return hostCall('blockedTo', source.x, source.y, source.z, target ~= nil,
            target and target.x or 0, target and target.y or 0, target and target.z or 0)
    end
    squareRecords[square] = {x = record.x, y = record.y, z = record.z}
    squares[key] = square
    return square
end
function getCell() return cell end
function player:getCurrentSquare()
    local state = hostCall('state')
    return cell:getGridSquare(state.x, state.y, 0)
end
function getPlayer() hostCall('state'); return player end
function getSpecificPlayer(index)
    assert(type(index) == 'number' and index >= 0 and index % 1 == 0, 'invalid player index')
    if index == 0 then return getPlayer() end
    return nil
end
function getModData() return playerData end
function transmitModData() hostCall('flush') end
local gameTime = nativeObject('GameTime')
function gameTime:getRealworldSecondsSinceLastUpdate() return delta end
function getGameTime() return gameTime end
function getTimestamp() return math.floor(hostCall('now') / 1000) end
function getTimestampMs() return hostCall('now') end

for _, name in ipairs(__pz_unsupported) do root[name] = unsupported(name) end
local function unsupportedObject(name)
    return setmetatable({}, {__index = function(_, key) rawError(fault('unsupported native facility: ' .. name .. '.' .. tostring(key)), 2) end,
        __call = unsupported(name)})
end
for _, name in ipairs({'PZAPI', 'Calendar', 'java', 'UIFont', 'SandboxVars'}) do root[name] = unsupportedObject(name) end
${UI_PRELUDE}
${BODY_PRELUDE}
${ACTION_PRELUDE}
${EQUIPMENT_PRELUDE}
${WORLD_CONTEXT_PRELUDE}
-- Lua's ordinary optional global lookups remain nil. No blanket _G trap.
io = nil
os.execute, os.exit, os.getenv, os.remove, os.rename, os.tmpname = nil, nil, nil, nil, nil, nil
loadfile, dofile = unsupported('loadfile/native filesystem'), unsupported('dofile/native filesystem')
package = {loaded = loaded, preload = {}, path = 'media/lua/{shared,client,server}/?.lua', cpath = '', searchers = {}}

function __pz_install(record, names)
    local key = record.id .. '/' .. record.path
    if records[key] then return end
    for _, name in ipairs(names) do
        if modules[name] and (modules[name].id ~= record.id or modules[name].path ~= record.path) then rawError('ambiguous native require path: ' .. name, 0) end
    end
    records[key] = record
    for _, name in ipairs(names) do
        modules[name] = record
        package.preload[name] = function() return require(name) end
    end
end
function __pz_execute(id, path)
    local record = assert(records[id .. '/' .. path], 'source not preloaded')
    return evaluate(record)
end
function __pz_dispatch(name, ...)
    local args = table.pack(...)
    if name == 'OnPlayerUpdate' or name == 'OnPlayerMove' or name == 'OnPlayerDeath' then args = table.pack(player) end
    if name == 'OnCreatePlayer' then args = table.pack(0, player) end
    local equip=name=='OnEquipPrimary' or name=='OnEquipSecondary'
    local snapshot = {}
    for _, item in ipairs(handlers[name]) do snapshot[#snapshot + 1] = item end
    for _, item in ipairs(snapshot) do
        local present = false
        for _, live in ipairs(handlers[name]) do if live == item then present = true; break end end
        if present then
            if equip then
                guarded(item,function() return item.fn(player,sourceItem(args[1])) end)
            else
                guarded(item,item.fn,table.unpack(args,1,args.n))
            end
        end
    end
end
function __pz_tick(seconds, number)
    delta = seconds
    __pz_source_sync()
    __pz_dispatch('OnTick', number)
    __pz_dispatch('OnPlayerUpdate')
end
function __pz_apply_options()
    local snapshot = {}
    for _, item in ipairs(optionRegistry) do snapshot[#snapshot + 1] = item end
    for _, item in ipairs(snapshot) do
        local present = false
        for _, live in ipairs(optionRegistry) do if live == item then present = true; break end end
        if present then guarded(item.owner, function() return item.options:apply() end) end
    end
end
function __pz_cleanup(id)
    local ok,failures=pcall(__pz_source_cleanup,id)
    for _, list in pairs(handlers) do for i = #list, 1, -1 do if list[i].id == id or list[i].apiId == id then table.remove(list, i) end end end
    for i = #optionRegistry, 1, -1 do if optionRegistry[i].owner.id == id or optionRegistry[i].owner.apiId == id then table.remove(optionRegistry, i) end end
    for name, record in pairs(modules) do if record.id == id then modules[name], loaded[name], package.preload[name] = nil, nil, nil end end
    for key, record in pairs(records) do if record.id == id then records[key], executed[key] = nil, nil end end
    if not ok then return {failures} end
    return failures
end
function __pz_drop(keys)
    for _, key in ipairs(keys) do rawset(playerData, key, nil) end
end
local jsonNull = {}
local function reconcile(target, source)
    for key in pairs(target) do if source[key] == nil then rawset(target, key, nil) end end
    for key, value in pairs(source) do
        if type(value) == 'table' and value ~= jsonNull and type(rawget(target, key)) == 'table' and target[key] ~= jsonNull then reconcile(target[key], value)
        else rawset(target, key, value) end
    end
end
local arrayKinds = setmetatable({}, {__mode = 'k'})
function __pz_restore(data, arrayPaths, nullPaths)
    for _, path in ipairs(nullPaths) do
        local value = data
        for i = 1, #path - 1 do value = value[path[i]] end
        value[path[#path]] = jsonNull
    end
    reconcile(playerData, data)
    arrayKinds = setmetatable({}, {__mode = 'k'})
    for _, path in ipairs(arrayPaths) do
        local value = playerData
        for _, key in ipairs(path) do value = value[key] end
        arrayKinds[value] = true
    end
end
local function quote(value)
    return '"' .. value:gsub('[%z\\1-\\31\\\\"]', function(char)
        if char == '"' then return '\\\\"' end
        if char == '\\\\' then return '\\\\\\\\' end
        return string.format('\\\\u%04x', string.byte(char))
    end) .. '"'
end
local function encode(value, seen)
    if value == jsonNull then return 'null' end
    local kind = type(value)
    if kind == 'string' then return quote(value) end
    if kind == 'boolean' then return tostring(value) end
    if kind == 'number' then
        assert(value == value and value ~= math.huge and value ~= -math.huge, 'native modData numbers must be finite')
        return tostring(value)
    end
    assert(kind == 'table' and not seen[value], 'native modData must be acyclic JSON')
    seen[value] = true
    local numeric, strings, maximum, count = false, false, 0, 0
    local keys, parts = {}, {}
    for key in pairs(value) do
        count = count + 1
        if type(key) == 'number' then
            assert(key >= 1 and key % 1 == 0, 'native modData array indices must be positive integers')
            numeric = true; maximum = math.max(maximum, key)
        else
            assert(type(key) == 'string' and key ~= '__proto__' and key ~= 'constructor' and key ~= 'prototype', 'unsafe native modData object key')
            strings = true; keys[#keys + 1] = key
        end
    end
    assert(not (numeric and strings), 'native modData cannot mix array and object keys')
    local result
    if numeric or (count == 0 and arrayKinds[value]) then
        assert(count == maximum, 'native modData arrays must be contiguous')
        for i = 1, maximum do parts[i] = encode(value[i], seen) end
        result = '[' .. table.concat(parts, ',') .. ']'
    else
        table.sort(keys)
        for _, key in ipairs(keys) do parts[#parts + 1] = quote(key) .. ':' .. encode(value[key], seen) end
        result = '{' .. table.concat(parts, ',') .. '}'
    end
    seen[value] = nil
    return result
end
function __pz_data(selected)
    local keys, parts = {}, {}
    for key in pairs(playerData) do
        assert(type(key) == 'string', 'native player modData keys must be strings')
        if selected == nil or selected[key] then keys[#keys + 1] = key end
    end
    table.sort(keys)
    for _, key in ipairs(keys) do
        local owner = hostCall('dataOwner', key)
        parts[#parts + 1] = quote(key) .. ':' .. guarded(owner, function() return encode(playerData[key], {}) end)
    end
    return '{' .. table.concat(parts, ',') .. '}'
end
__pz_call, __pz_enter, __pz_leave, __pz_context, __pz_fault, __pz_own, __pz_events, __pz_unsupported = nil, nil, nil, nil, nil, nil, nil, nil
`;

/**
 * Reject values that a JSON save would silently corrupt (cycles, functions,
 * nonfinite numbers). VM tables are detached by wasmoon before this boundary.
 *
 * @param {unknown} value - Value to detach.
 * @returns {JSONValue} Independent JSON value.
 */
function jsonCopy(value) {
    const seen = new Set();

    /**
     * Validate a node before JSON serialization.
     *
     * @param {unknown} item - Current JSON node.
     * @returns {void}
     */
    function visit(item) {
        if (item === null || typeof item === 'string' || typeof item === 'boolean') {
            return;
        }

        if (typeof item === 'number' && Number.isFinite(item)) {
            return;
        }

        if (!item || typeof item !== 'object' || seen.has(item)) {
            throw new TypeError('native modData must be finite, acyclic JSON');
        }

        seen.add(item);

        for (const child of Object.values(item)) {
            visit(child);
        }

        seen.delete(item);
    }

    visit(value);

    return JSON.parse(JSON.stringify(value));
}

/**
 * Match source PZMath.fastfloor(double): Java d2i, comparison, then int32 subtraction.
 *
 * @param {number} value - Lua numeric coordinate.
 * @returns {number} Source integer lookup coordinate, including saturation and wrap.
 */
function squareCoordinate(value) {
    const integer = Number.isNaN(value) ? 0 : Math.min(2_147_483_647, Math.max(-2_147_483_648, Math.trunc(value)));

    if (value < integer) {
        return integer === -2_147_483_648 ? 2_147_483_647 : integer - 1;
    }

    return integer;
}

/**
 * Create one Lua VM; activation and callbacks after this await are synchronous.
 *
 * @param {{wasmUrl?:string|URL, timeoutMs?:number, memoryLimitBytes?:number, now?:()=>number, ui?:object, sourceFiles?:object, engineStartup?:{id:string,path:string}[]}} [options] - VM limits, candidate UI/core files and ordered preloaded engineSource chunks run once under the first native package's real API.
 * @returns {Promise<object>} Shared native runtime.
 */
export async function createLuaSession(options = {}) {
    const timeoutMs = options.timeoutMs ?? 100;
    const memoryLimitBytes = options.memoryLimitBytes ?? 32 * 1_024 * 1_024;
    const engineStartup = options.engineStartup ?? [];

    if (!Array.isArray(engineStartup) || engineStartup.some((item) => !item || typeof item.id !== 'string' || !item.id || typeof item.path !== 'string' || !item.path)) {
        throw new TypeError('Engine startup requires ordered preloaded engine source references');
    }

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(memoryLimitBytes) || memoryLimitBytes <= 0) {
        throw new TypeError('Lua resource limits must be positive');
    }

    const node = !!globalThis.process?.versions?.node;
    let module;

    if (node) {
        module = await import('wasmoon');
    } else {
        await import(new URL('../runtime/wasmoon.js', import.meta.url).href);
        module = globalThis.wasmoon;
    }

    const LuaFactory = module.LuaFactory ?? module.default?.LuaFactory;

    if (!LuaFactory) {
        throw new Error('local wasmoon 1.16.0 runtime is missing LuaFactory');
    }

    let wasmUrl;

    if (options.wasmUrl) {
        wasmUrl = String(options.wasmUrl);
    } else if (!node) {
        wasmUrl = new URL('../runtime/glue.wasm', import.meta.url).href;
    }

    const lua = await new LuaFactory(wasmUrl).createEngine({ openStandardLibs: true, injectObjects: false, enableProxy: false, traceAllocations: true, functionTimeout: timeoutMs });

    /* Wasmoon 1.16.0 probes null.then before its nullable handling. A shared
       inbound extension covers globals, Lua calls and nested host callback data
       without copying/mutating JS payloads; save nullPaths restore JSON nulls. */
    lua.global.registerTypeExtension(2, {
        /**
         * Convert host null to nil before the priority-1 Promise extension.
         *
         * @param {object} thread - Receiving VM thread.
         * @param {{target:unknown}} decoration - Host value.
         * @returns {boolean} Whether this extension pushed the value.
         */
        pushValue(thread, decoration) {
            if (decoration.target !== null) {
                return false;
            }

            thread.lua.lua_pushnil(thread.address);

            return true;
        },
        /**
         * Leave Lua-to-host conversion to Wasmoon's built-in readers.
         *
         * @returns {boolean} This inbound-only extension never reads values.
         */
        isType() {
            return false;
        },
        /**
         * Release this allocation-free extension.
         *
         * @returns {void}
         */
        close() {
            // No native references or resources are acquired.
        },
    });

    lua.global.setMemoryMax(memoryLimitBytes);
    const packages = new Map();
    const sourceFloorViews = new Map();
    let nextSourceFloorView = 1;
    const owners = new Map();
    const contexts = [];
    const errors = [];
    const sourceHighlightOwner = Symbol('Lua session world highlights');
    let closed = false;
    let sourceActions = options.sourceActions;
    let sourceTiming = options.sourceTiming;
    let sourceContext = options.sourceWorldContext;
    let sourceFileOwner;
    let restoredSourceOwners;
    let unsubscribe;
    let unsubscribeDeath;
    let unsubscribeHands;
    let tickOwner;
    let lastPosition;
    let lastFault;
    let cleanupFaults;
    let executions = 0;
    let timeouts = 0;
    let durationMs = 0;
    let busy = false;
    /** @type {{name:string,itemId:number|null}[]} */
    const pendingNotifications = [];
    let vmDepth = 0;
    let drainingNotifications = false;
    let engineStarted = engineStartup.length === 0;

    /**
     * Get the currently running chunk owner.
     *
     * @returns {{id:string,path:string,apiId?:string}} Current source and public API owner.
     */
    function current() {
        return contexts.at(-1) ?? { id: 'runtime', path: '<host>' };
    }

    /**
     * Attribute a failure to the currently running native chunk.
     *
     * @param {unknown} cause - Original failure.
     * @returns {Error} Attributed error.
     */
    function failure(cause) {
        const owner = current();
        const entry = packages.get(owner.id);
        const nativeModId = entry?.nativeId ?? owner.id;
        const message = `[native ${nativeModId}/${owner.path}] ${cause instanceof Error ? cause.message : String(cause)}`;
        const apiModId = owner.apiId ?? owner.id;
        const error = Object.assign(new Error(message, { cause }), { name: 'NativeLuaError', modId: owner.id, nativeModId, apiModId, path: owner.path });

        errors.push({ modId: owner.id, nativeModId, apiModId, path: owner.path, message });

        if (/timeout/i.test(message)) {
            timeouts += 1;
        }

        return error;
    }

    /**
     * Run a synchronous VM operation with resource and failure accounting.
     *
     * @template T
     * @param {()=>T} operation - Synchronous VM operation.
     * @returns {T} Lua result.
     */
    function run(operation) {
        if (closed) {
            throw new Error('Lua session is closed');
        }

        const start = performance.now();
        let result;

        lastFault = undefined;
        executions += 1;
        vmDepth += 1;
        try {
            result = operation();
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);

            throw lastFault && message.includes(lastFault.message) ? lastFault : failure(cause);
        } finally {
            durationMs += performance.now() - start;
            vmDepth -= 1;
        }

        drainNotifications();

        return result;
    }

    /**
     * Get the bound owner's API, never arbitrary JS globals.
     *
     * @returns {object} Bound owner API.
     */
    function api() {
        const owner = current();
        const entry = packages.get(owner.apiId ?? owner.id);

        if (!entry?.active || !entry.api) {
            throw new Error('native package API is not active');
        }

        return entry.api;
    }

    /**
     * Call a supported facility on the currently attributed package's public API.
     *
     * @param {string} namespace - Dot-separated public API namespace.
     * @param {string} name - Required synchronous method in that namespace.
     * @param {...unknown} args - Method-specific arguments supplied by the Lua bridge.
     * @returns {unknown} The facility's synchronous result, unchanged.
     */
    function capability(namespace, name, ...args) {
        let value = api();

        for (const part of namespace.split('.')) {
            value = value?.[part];
        }

        if (typeof value?.[name] !== 'function') {
            throw new TypeError(`unsupported native facility: ${namespace}.${name}`);
        }

        return value[name](...args);
    }

    /**
     * Require the current character's real registry/levels for constants and level queries.
     *
     * @returns {{id:string,level:number}[]} Validated authoritative records.
     */
    function authoritativeMoodles() {
        const values = capability('character', 'moodles');

        if (!Array.isArray(values) || !values.length || values.some((value) => !value || typeof value.id !== 'string' || !value.id || !Number.isInteger(value.level) || value.level < 0 || value.level > 4) || new Set(values.map((value) => value.id)).size !== values.length) {
            throw new Error('unsupported authoritative moodles registry/levels');
        }

        return values;
    }

    lua.global.set('__pz_enter', (id, path, apiId) => {
        const caller = current();
        const publicOwner = packages.get(id)?.engineSource ? apiId ?? caller.apiId ?? caller.id : id;

        contexts.push({ id, path, apiId: publicOwner });
    });
    lua.global.set('__pz_leave', () => {
        contexts.pop();
    });
    lua.global.set('__pz_context', current);
    lua.global.set('__pz_fault', (message) => {
        if (!lastFault || !String(message).includes(lastFault.message)) {
            lastFault = failure(message);
            cleanupFaults?.push(lastFault);
        }

        return lastFault.message;
    });
    lua.global.set('__pz_own', (key) => {
        if (typeof key !== 'string' || !key || key === '__proto__' || key === 'constructor' || key === 'prototype') {
            throw new TypeError('native modData top-level keys must be safe nonempty strings');
        }

        if (!owners.has(key)) {
            const owner = current();

            owners.set(key, owner.apiId ?? owner.id);
        }
    });
    lua.global.set('__pz_call', (operation, ...args) => {
        switch (operation) {
            case 'sourceStringSort':
                api();

                if (args.length !== 2 || typeof args[0] !== 'string' || typeof args[1] !== 'string') {
                    throw new TypeError('string.sort requires two strings');
                }

                // Original Kahlua StringLib.sort is Java String.compareTo > 0: case-sensitive UTF-16 units.
                return args[0] > args[1];
            case 'sourceTimSort':
                api();

                if (args.length !== 2 || !Number.isSafeInteger(args[0]) || args[0] < 0 || typeof args[1] !== 'function') {
                    throw new TypeError('timSort requires a value count and resident comparator');
                }

                /*
                Arrays.sort(Object[], Comparator) and ECMAScript Array.sort are stable.
                Keep original one-based Lua ordinals; never serialize the resident values.
                */
                return Array.from({ length: args[0] }, (_, index) => index + 1).sort(args[1]);
            case 'state': return api().movement.getState();
            case 'handItems': return capability('character', 'getHandItems');
            case 'sourceSetHandItem': {
                api().movement.getState();

                if (args.length !== 2 || typeof sourceContext?.setHandItem !== 'function') {
                    throw new TypeError('unsupported native facility: source held-item mutation');
                }

                return sourceContext.setHandItem(args[0], args[1] ?? null, current().apiId ?? current().id);
            }
            case 'sourceFile': {
                const owner = current();

                api().movement.getState();

                if ((owner.apiId ?? owner.id) !== 'pz-base-game' || !options.sourceFiles) {
                    throw new Error('unsupported native facility: owned Core source files');
                }

                const [name, path, value, append] = args;

                if (path !== 'layout.ini' && path !== 'entityLayout.ini') {
                    throw new Error(`unsupported native Core file: ${path}`);
                }

                if (name === 'read') {
                    if (args.length !== 3 || typeof value !== 'boolean') {
                        throw new TypeError('native Core file read requires a path and boolean create flag');
                    }

                    const text = options.sourceFiles.read(path, false);

                    if (text === null && value) {
                        const created = options.sourceFiles.read(path, true);

                        sourceFileOwner = { ...owner };

                        return created;
                    }

                    return text;
                }

                if (name === 'write') {
                    if (args.length !== 4 || typeof append !== 'boolean') {
                        throw new TypeError('native Core file write requires a path, text and boolean append flag');
                    }

                    options.sourceFiles.write(path, value, append);
                    sourceFileOwner = { ...owner };

                    return;
                }

                throw new Error(`unsupported native Core file operation: ${name}`);
            }
            case 'sourceFloorView': {
                const [name, handle, target] = args;

                if (name === 'release') {
                    sourceFloorViews.delete(handle);

                    return;
                }

                api().items.playerInventoryId();

                if (name === 'new') {
                    const id = nextSourceFloorView++;

                    sourceFloorViews.set(id, []);

                    return id;
                }

                const placements = sourceFloorViews.get(handle);

                if (!placements || !['clear', 'add', 'at', 'size', 'indexOf', 'contains', 'ids'].includes(name)
                    || (['add', 'at', 'indexOf', 'contains'].includes(name) && (!Number.isInteger(target) || target < 0))) {
                    throw new TypeError('native floor view requires its resident handle and a valid operation');
                }

                if (name === 'clear') {
                    placements.length = 0;

                    return;
                }

                if (typeof sourceActions?.itemMatchesFloorPlacement !== 'function') {
                    throw new TypeError('unsupported native facility: sourceActions.itemMatchesFloorPlacement');
                }

                let index = 0;
                const ids = name === 'ids' ? [] : null;

                // Only transient presentation stamps live here; every query reads actual native ownership/placement.
                for (let offset = 0; offset < placements.length; offset += 5) {
                    const id = placements[offset];

                    if ((name === 'contains' || name === 'add') && id !== target) {
                        continue;
                    }

                    const live = sourceActions.itemMatchesFloorPlacement(id, placements[offset + 1], placements[offset + 2],
                        placements[offset + 3], placements[offset + 4]);

                    if (name === 'contains' || name === 'add') {
                        if (name === 'add' && !live) {
                            throw new TypeError('floor presentation requires live true world/floor ownership');
                        }

                        return name === 'contains' ? live : false;
                    }

                    if (!live) {
                        continue;
                    }

                    if (name === 'at' && index === target) {
                        return id;
                    }

                    if (name === 'indexOf' && id === target) {
                        return index;
                    }

                    ids?.push(id);
                    index += 1;
                }

                if (name === 'add') {
                    const row = capability('items', 'get', target);
                    const owner = row?.ownerContainerId && capability('items', 'getContainer', row.ownerContainerId);

                    if (!row?.worldPosition || owner?.kind !== 'floor') {
                        throw new TypeError('floor presentation requires live true world/floor ownership');
                    }

                    placements.push(target, row.ownerContainerId, row.worldPosition.x, row.worldPosition.y, row.worldPosition.z);

                    return true;
                }

                switch (name) {
                    case 'ids': return ids;
                    case 'size': return index;
                    case 'indexOf': return -1;
                    case 'contains': return false;
                    default: return null;
                }
            }
            case 'sourceActions': {
                // Preserve the SDK handle's alive() guard without allocating an unused movement snapshot.
                api().items.playerInventoryId();
                const [name, ...values] = args;

                if (typeof sourceActions?.[name] !== 'function') {
                    throw new TypeError(`unsupported native facility: sourceActions.${name}`);
                }

                return sourceActions[name](...values);
            }
            case 'sourceTiming': {
                api().movement.getState();
                const [name, ...values] = args;

                if (typeof sourceTiming?.[name] !== 'function') {
                    throw new TypeError(`unsupported native facility: sourceTiming.${name}`);
                }

                return sourceTiming[name](...values);
            }
            case 'sourceApparentZ': {
                api().movement.getState();

                if (typeof sourceContext?.squareApparentZ === 'function') {
                    return sourceContext.squareApparentZ(...args);
                }

                if (typeof sourceActions?.squareApparentZ !== 'function') {
                    throw new TypeError('unsupported native facility: authoritative source square elevation');
                }

                // Flat/sloped native facts need no renderer setting; the real backend refuses unconfigured stairs.
                return sourceActions.squareApparentZ(...args);
            }
            case 'sourceContext': {
                api().movement.getState();
                const [name, ...values] = args;

                if (name === 'room' || name === 'building') {
                    const records = sourceContext?.[name === 'room' ? 'rooms' : 'buildings'];

                    if (!Array.isArray(records)) {
                        throw new TypeError(`unsupported native facility: source ${name} metadata`);
                    }

                    return records.find((record) => record.id === values[0]) ?? null;
                }

                if (typeof sourceContext?.[name] !== 'function') {
                    throw new TypeError(`unsupported native facility: sourceContext.${name}`);
                }

                return sourceContext[name](...values);
            }
            case 'sourceInput': {
                api().movement.getState();

                if (typeof sourceContext?.input !== 'function') {
                    throw new TypeError('unsupported native facility: source input state');
                }

                return sourceContext.input(args[0]);
            }
            case 'sourceFace': {
                api().movement.getState();

                if (typeof sourceActions?.face !== 'function') {
                    throw new TypeError('unsupported native facility: source actor facing');
                }

                const target = typeof args[0] === 'string'
                    ? capability('world', 'getDoors').find((value) => value.id === args[0])
                    : capability('items', 'get', args[0]);

                if (!target) {
                    throw new TypeError('source facing target is unavailable');
                }

                const position = typeof args[0] === 'string' ? target : target.worldPosition;

                if (!position) {
                    throw new TypeError('source item facing requires true world placement');
                }

                return sourceActions.face(position.x + 0.5, position.y + 0.5);
            }
            case 'sourcePathCancel': {
                api().movement.getState();

                if (typeof sourceActions?.cancelPath !== 'function') {
                    throw new TypeError('unsupported native facility: source path cancellation');
                }

                return sourceActions.cancelPath();
            }
            case 'sourceOwnerAlive': api().movement.getState();

                return true;
            case 'sourceActionLog': return options.onSourceAction?.({ actionId: args[0], type: args[1], owner: current() });
            case 'sourceMenuVisibility': {
                api().movement.getState();

                if (typeof options.ui?.sourceMenuVisibility !== 'function') {
                    throw new TypeError('unsupported native facility: source submenu accessibility visibility');
                }

                return options.ui.sourceMenuVisibility(args[0], args[1]);
            }
            case 'sourceMenuMirror': {
                const owner = current().apiId ?? current().id;

                if (typeof options.ui?.sourceMenuMirror !== 'function') {
                    throw new TypeError('unsupported native facility: original context accessibility mirror');
                }

                if (args[0] === null || args[0] === undefined) {
                    options.ui.sourceMenuMirror(null);

                    return;
                }

                if (typeof sourceContext?.onError !== 'function') {
                    throw new TypeError('unsupported native facility: original context error feedback');
                }

                const callbackOwner = { ...current() };

                options.ui.sourceMenuMirror(args[0], args[1], {
                    owner,
                    onClose: args[2],
                    /**
                     * Report mirror failures under the captured native package owner.
                     *
                     * @param {unknown} cause - Original context accessibility mirror failure.
                     */
                    onError: (cause) => {
                        contexts.push(callbackOwner);
                        try {
                            const error = cause instanceof Error && cause.name === 'NativeLuaError' ? cause : failure(cause);

                            sourceContext.onError(error);
                        } finally {
                            contexts.pop();
                        }
                    },
                });

                return;
            }
            case 'door': return capability('world', 'getDoors').find((value) => value.id === args[0]) ?? null;
            case 'items': return capability('items', 'list');
            case 'doors': return capability('world', 'getDoors');
            case 'wallTo':
            case 'canReachTo': {
                api().movement.getState();
                const name = operation === 'wallTo' ? 'isWallTo' : 'canReachTo';

                if (typeof sourceActions?.[name] !== 'function') {
                    throw new TypeError(`unsupported native facility: sourceActions.${name}`);
                }

                return sourceActions[name](args[0], args[1] ?? null);
            }
            case 'square': {
                if (args.length !== 3 || args.some((value) => typeof value !== 'number')) {
                    throw new TypeError('getGridSquare requires three numeric coordinates');
                }

                return capability('world', 'getSquare', ...args.map(squareCoordinate));
            }
            case 'blockedTo': return capability('world', 'isBlockedTo',
                { x: args[0], y: args[1], z: args[2] },
                args[3] ? { x: args[4], y: args[5], z: args[6] } : null);
            case 'speed': return api().movement.setSpeed(args[0]);
            case 'action': return api().actions.submit(args[0] === 'cancel' ? { type: 'cancel' } : { type: args[0], x: args[1], y: args[2] });
            case 'flush': return flushSaveData();
            case 'now': return (options.now ?? Date.now)();
            case 'worldItemHighlightColor':
                // Core's constructor exists without a rendered UI; attached clients read their live option.
                return options.ui
                    ? options.ui.bindings.call('settings', current().apiId ?? current().id).worldItemHighlight
                    : { r: 0.5, g: 1, b: 1, a: 1 };
            case 'sourceHighlight': {
                // Headless sessions retain Lua presentation state; attached UIs forward it to the world renderer.
                options.ui?.setWorldHighlight(args[0], args[1], jsonCopy(args[2]), sourceHighlightOwner);

                return undefined;
            }
            case 'ui': {
                if (!options.ui?.bindings) {
                    throw new Error('unsupported native facility: UI resources');
                }

                const [name, ...values] = args;

                if (name === 'element' && values[1]?.startsWith('DrawTexture') && values[2] !== null && values[2] !== undefined) {
                    const path = values[2];

                    values[2] = options.ui.bindings.call('texture', current().apiId ?? current().id, path);

                    if (!values[2]) {
                        throw new Error(`UI texture disappeared: ${path}`);
                    }
                }

                const result = options.ui.bindings.call(name, current().apiId ?? current().id, ...values);

                return name === 'texture' && result
                    ? {
                            path: result.path, width: result.width, height: result.height,
                            widthOrig: result.widthOrig, heightOrig: result.heightOrig, offsetX: result.offsetX, offsetY: result.offsetY,
                        }
                    : result;
            }
            case 'readOptions': return capability('ui', 'readOptions', args[0]);
            case 'writeOptions': return capability('ui', 'writeOptions', args[0], jsonCopy(args[1]));
            case 'item': {
                const record = capability('items', 'get', args[0]);

                if (args.length === 1) {
                    return record;
                }

                if (args.length !== 2) {
                    throw new TypeError('Item field queries require one native identity and one scalar field.');
                }

                switch (args[1]) {
                    case 'fullType':
                    case 'condition':
                    case 'ownerContainerId':
                    case 'internalContainerId':
                        if (!record) {
                            throw new Error('native item is unavailable');
                        }

                        return record[args[1]] ?? null;
                    default:
                        throw new TypeError(`Unsupported scalar item field: ${args[1]}`);
                }
            }
            case 'container': return capability('items', 'getContainer', args[0]);
            case 'playerInventoryId': return capability('items', 'playerInventoryId');
            case 'containerState': return capability('items', 'containerState', args[0], args[1] === 1 ? 1 : null);
            case 'itemWeights': return capability('items', 'itemWeights', args[0]);
            case 'sourceFloatAdd': {
                if (args.length !== 2 || args.some((value) => typeof value !== 'number' || Number.isNaN(value) || value < 0)) {
                    throw new TypeError('Source floor weights require two nonnegative native numeric values.');
                }

                return Math.fround(Math.fround(args[0]) + Math.fround(args[1]));
            }
            case 'sourceItemState': {
                api().movement.getState();

                if (typeof sourceActions?.itemSourceState !== 'function') {
                    throw new TypeError('unsupported native facility: authoritative source item flags');
                }

                return sourceActions.itemSourceState(...args);
            }
            case 'equipment': {
                const [name, ...values] = args;

                if (name === 'wornSet') {
                    values[1] ??= null;
                }

                const result = capability('equipment', 'operation', name, ...values);

                return ['multiSet', 'relationSet', 'move', 'reset', 'wornGroupSet', 'wornSet', 'wornRemove', 'wornClear'].includes(name)
                    ? undefined
                    : result;
            }
            case 'itemDefinition': {
                const definition = capability('items.definitions', 'get', args[0]);

                if (args.length === 2) {
                    switch (args[1]) {
                        case 'sourceCategory':
                        case 'type':
                        case 'conditionMax':
                        case 'bodyLocation':
                        case 'canBeEquipped':
                        case 'weightReduction':
                            if (!definition) {
                                throw new Error('native item definition unavailable');
                            }

                            return definition[args[1]] ?? null;
                        default:
                            throw new TypeError(`Unsupported scalar item definition field: ${args[1]}`);
                    }
                }

                if (args.length !== 1) {
                    throw new TypeError('Item definition queries require a full type and at most one scalar field.');
                }

                if (definition) {
                    definition.normalIcon = normalItemIcon(definition);
                }

                return definition;
            }
            case 'setCondition': return capability('items', 'setCondition', ...args);
            case 'setWeight': return capability('items', 'setWeight', ...args);
            case 'setActualWeight': return capability('items', 'setActualWeight', ...args);
            case 'inventoryState': return capability('items', 'inventoryState');
            case 'itemWeight': {
                const record = capability('items', 'get', args[0]);
                const value = record?.[args[1]];

                if (!Number.isFinite(value) || value < 0) {
                    throw new Error(`unsupported authoritative item ${args[1]}`);
                }

                return value;
            }
            case 'worn': {
                const worn = capability('items', 'worn', args[0]);

                return typeof worn === 'object' && worn !== null ? worn.id : worn;
            }
            case 'isWearingAwkwardGloves': return capability('character', 'isWearingAwkwardGloves');
            case 'health': return capability('character', 'getHealth');
            case 'isDead': return capability('character', 'isDead');
            case 'bodyParts': return capability('character', 'bodyParts');
            case 'bodyPart': {
                const part = capability('character', 'bodyParts').find((value) => value.id === args[0]);

                if (!part) {
                    throw new Error(`unsupported authoritative body part '${args[0]}'`);
                }

                return part;
            }
            case 'setBodyPart': return capability('character', 'setBodyPart', args[0], { [args[1]]: args[2] });
            case 'thermalActionModifier': return capability('character', 'thermalActionModifier');
            case 'moodleType': {
                const name = args[0];

                if (!Object.hasOwn(MOODLE_TYPES, name)) {
                    throw new Error(`unsupported native facility: MoodleType.${name} has no original registry member`);
                }

                const id = MOODLE_TYPES[name];

                if (!authoritativeMoodles().some((value) => value.id === id)) {
                    throw new Error(`unsupported native facility: MoodleType.${name} requires authoritative moodle '${id}'`);
                }

                return id;
            }
            case 'moodles': return authoritativeMoodles().map((value) => ({ id: value.id, level: value.level }));
            case 'dataOwner': {
                const id = owners.get(args[0]);

                if (!id) {
                    throw new Error(`native modData key '${args[0]}' has no owner; use regular assignment rather than rawset`);
                }

                return { id, path: '<save>' };
            }

            default: throw new Error(`unsupported bridge operation: ${operation}`);
        }
    });
    lua.global.set('__pz_events', [...EVENTS]);
    lua.global.set('__pz_unsupported', ['getCore', 'getTexture', 'getText', 'getTextOrNull', 'getModInfo', 'getActivatedMods', 'instanceof', 'getWorld', 'getZomboidRadio', 'getCurrentCoroutine', 'getCoroutineCallframeStack', 'getFilenameOfCallframe', 'getLuaDebuggerErrors', 'DoLuaChecksum', 'getSoundManager', 'getScriptManager', 'getAllItems', 'sendClientCommand', 'sendServerCommand']);
    try {
        lua.doStringSync(PRELUDE);
    } catch (cause) {
        lua.global.close();
        throw cause;
    }

    // Fetch function handles once: no per-tick source compilation.
    const install = lua.global.get('__pz_install');
    const execute = lua.global.get('__pz_execute');
    const emit = lua.global.get('__pz_dispatch');
    const tick = lua.global.get('__pz_tick');
    const remove = lua.global.get('__pz_cleanup');
    const restore = lua.global.get('__pz_restore');
    const data = lua.global.get('__pz_data');
    const drop = lua.global.get('__pz_drop');
    const applyRegisteredOptions = lua.global.get('__pz_apply_options');
    const sourceEvent = lua.global.get('__pz_source_event');
    const sourceRestore = lua.global.get('__pz_source_restore');
    const sourceCompleteRestore = lua.global.get('__pz_source_complete_restore');
    const sourcePrepareSave = lua.global.get('__pz_source_prepare_save');
    const sourceOwners = lua.global.get('__pz_source_owners');
    const worldContextMenu = lua.global.get('__pz_world_context');
    const inventoryPages = lua.global.get('__pz_inventory_pages');
    const clientSystems = lua.global.get('__pz_client_systems');
    const actorInputUpdate = lua.global.get('__pz_actor_input_update');
    const contextKeyState = lua.global.get('__pz_context_key_state');
    const contextKeyAttempt = lua.global.get('__pz_context_key_attempt');
    const contextKeyInput = createContextKeyInput();
    const worldPointer = lua.global.get('__pz_world_pointer');
    const worldPhase = lua.global.get('__pz_world_phase');
    const worldBuildInput = lua.global.get('__pz_world_build_input');

    /**
     * Bind the actual private native queue before any original source runs.
     *
     * @param {object} actions - Native source action adapter.
     * @param {object} timing - Native source clock and traits.
     * @param {object} [worldContext] - Current original-scene input and metadata.
     * @returns {void}
     */
    function attachSourceActions(actions, timing, worldContext) {
        if (closed || typeof actions?.actionRead !== 'function' || typeof timing?.getState !== 'function') {
            throw new TypeError('Source actions require a live native queue and clock');
        }

        sourceActions = actions;
        sourceTiming = timing;
        sourceContext = worldContext ?? sourceContext;
        sourceActions.setSaveHook?.(prepareSourceSave);
        sourceActions.setOwnerExport?.(exportSourceOwners);
    }

    /**
     * Run a source entry under the real active API rather than a host placeholder.
     *
     * @template T
     * @param {()=>T} operation - Resident VM call.
     * @param {string} path - Diagnostic entry path.
     * @param {string} [ownerId] - Exact package owner; otherwise use the first active native package.
     * @returns {T} Original Lua result.
     */
    function sourceEntry(operation, path, ownerId) {
        const owner = ownerId === undefined
            ? [...packages.values()].find((entry) => entry.active && !entry.engineSource)
            : packages.get(ownerId);

        if (!owner?.active || owner.engineSource) {
            throw new Error('Original source entry requires an active native package API');
        }

        contexts.push({ id: owner.id, path, apiId: owner.id });
        try {
            return run(operation);
        } finally {
            contexts.pop();
        }
    }

    /**
     * Invoke the genuine resident callback; the native driver owns its reply.
     *
     * @param {{actionId:number,event:number,generation:number,token:number}} event - Native authorization.
     * @returns {number} Source callback result, never a second native reply.
     */
    function dispatchSourceAction(event) {
        return sourceEntry(() => sourceEvent(event), '<source-action>');
    }

    /**
     * Refresh portability from live Lua closures before any queue-byte capture.
     *
     * @returns {void}
     */
    function prepareSourceSave() {
        if (!sourceActions || ![...packages.values()].some((entry) => entry.active && !entry.engineSource)) {
            return;
        }

        sourceEntry(() => sourcePrepareSave(), '<source-save>');
    }

    /**
     * Export stable registered package identities, never native callback tokens.
     *
     * @returns {{actionId:number,ownerId:string}[]} Exact current Lua FIFO ownership.
     */
    function exportSourceOwners() {
        if (!sourceActions) {
            return [];
        }

        if (sourceActions.length() === 0) {
            return [];
        }

        // Lua's empty sequence is {}, so enumerate the internal producer before strict array validation.
        const result = Object.values(sourceEntry(() => sourceOwners(), '<source-owners>'));

        validateSourceOwners(result);

        return result.sort((left, right) => left.actionId - right.actionId);
    }

    /**
     * Resolve saved stable owner IDs against this candidate's registered APIs.
     *
     * @param {{actionId:number,ownerId:string}[]} ownersToResolve - Portable package map.
     * @param {{id:string,nativeId:string}[]} [declaredOwners] - Exact preloaded package identities for candidate bootstrap.
     * @returns {object[]} Live Lua owner contexts.
     */
    function validateSourceOwners(ownersToResolve, declaredOwners) {
        if (!Array.isArray(ownersToResolve) || ownersToResolve.length > 128) {
            throw new TypeError('Source ownership must contain at most 128 exact native action identities');
        }

        let declared;

        if (declaredOwners !== undefined) {
            if (!Array.isArray(declaredOwners)) {
                throw new TypeError('Source bootstrap requires declared native package identities');
            }

            declared = new Set();

            for (const owner of declaredOwners) {
                const entry = packages.get(owner?.id);

                if (!entry || entry.engineSource || entry.nativeId !== owner.nativeId || declared.has(owner.id)) {
                    throw new Error('Source bootstrap owner is not an exact preloaded native package');
                }

                declared.add(owner.id);
            }
        }

        const expected = new Set();

        for (let index = 0; index < sourceActions.length(); index += 1) {
            const row = sourceActions.actionRead(sourceActions.get(index));

            if (row.origin === 'lua') {
                expected.add(row.id);
            }
        }

        const resolved = [];

        for (const owner of ownersToResolve) {
            if (!owner || Object.keys(owner).some((key) => key !== 'actionId' && key !== 'ownerId')
                || !Number.isSafeInteger(owner.actionId) || !expected.delete(owner.actionId)
                || typeof owner.ownerId !== 'string' || !owner.ownerId) {
                throw new TypeError('Source ownership contains a duplicate, spurious or invalid identity');
            }

            const entry = packages.get(owner.ownerId);

            if (!entry || entry.engineSource || (declared ? !declared.has(owner.ownerId) : !entry.active || !entry.api)) {
                throw new Error(`Queued source owner '${owner.ownerId}' is missing or disabled`);
            }

            resolved.push({ actionId: owner.actionId, id: entry.id, path: '<source-restore>', apiId: entry.id });
        }

        if (expected.size) {
            throw new Error('Source ownership is missing a queued original action');
        }

        return resolved;
    }

    /**
     * Recreate supported source tables through their unchanged constructors.
     *
     * @param {{current:object|null,pending:object[]}} state - Validated native queue in an isolated replacement session.
     * @param {{actionId:number,ownerId:string}[]} savedOwners - Stable package ownership for each saved source action.
     * @param {{id:string,nativeId:string}[]} [declaredOwners] - Exact preloaded package identities for candidate bootstrap.
     * @returns {void}
     */
    function restoreSourceActions(state, savedOwners, declaredOwners) {
        if (!state || !Array.isArray(state.pending)) {
            throw new TypeError('Source queue restore requires native current/pending rows');
        }

        if (restoredSourceOwners) {
            if (!Array.isArray(savedOwners) || savedOwners.length !== restoredSourceOwners.size
                || new Set(savedOwners.map((owner) => owner?.actionId)).size !== savedOwners.length
                || savedOwners.some((owner) => restoredSourceOwners.get(owner?.actionId) !== owner?.ownerId)) {
                throw new Error('Source queue cannot be hydrated twice with different owners');
            }

            return;
        }

        const resolved = validateSourceOwners(savedOwners, declaredOwners);
        const bootstrap = declaredOwners !== undefined;
        const constructorOwner = bootstrap ? { id: 'pz-base-game', path: '<source-restore>', apiId: 'pz-base-game' } : undefined;

        if (resolved.length) {
            sourceEntry(() => sourceRestore(state, resolved, constructorOwner), '<source-restore>', bootstrap ? 'pz-base-game' : resolved[0].apiId);
        }

        restoredSourceOwners = new Map(savedOwners.map(({ actionId, ownerId }) => [actionId, ownerId]));
    }

    /**
     * Bind unchanged saved door continuations after genuine player startup events.
     *
     * @returns {void} No ticking or native queue mutation.
     */
    function completeSourceRestore() {
        sourceEntry(() => sourceCompleteRestore(), '<source-restore>', 'pz-base-game');
    }

    /**
     * Attach the resident original inventory pages after genuine player startup.
     *
     * @returns {void} Original widgets remain in this session and native UI registry.
     */
    function initializeInventoryPages() {
        sourceEntry(() => inventoryPages(), '<inventory-pages>', 'pz-base-game');
    }

    /**
     * Refresh the native player input owner from current configured physical bindings.
     *
     * @returns {void} No ticking, movement or synthetic key dispatch.
     */
    function updateActorInput() {
        sourceEntry(() => actorInputUpdate(), '<actor-input>', 'pz-base-game');
    }

    /**
     * Run Interact only after one accepted native update, using its actual float clock.
     *
     * @param {boolean} allowed - Actual host keyboard/UI admission for this update.
     * @returns {boolean} Whether original contextual selection consumed the press.
     */
    function updateContextKey(allowed) {
        return sourceEntry(() => {
            const state = contextKeyState();

            if (state.cancelled) {
                contextKeyInput.cancel();

                return false;
            }

            return contextKeyInput.update(sourceTiming.getState().elapsedSeconds, state.down,
                allowed && !state.grappleThrowOutWindow, (milliseconds, seconds) => contextKeyAttempt(milliseconds, seconds));
        }, '<context-key>', 'pz-base-game');
    }

    /** Cancel the owning input lifetime without synthesizing a physical release. */
    function cancelContextKey() {
        contextKeyInput.cancel();
    }

    /**
     * Open the unchanged original world-menu route and its WebGPU widgets.
     *
     * @param {{screenX:number,screenY:number,worldX:number,worldY:number,z?:number,playerIndex?:number}} request - Actual renderer hit and screen input.
     * @returns {boolean} Whether the original source produced a menu.
     */
    function openWorldContextMenu(request) {
        if (!request || !['screenX', 'screenY', 'worldX', 'worldY'].every((key) => Number.isFinite(request[key]))) {
            throw new TypeError('Original context menu requires finite screen and world coordinates');
        }

        const input = { ...request, worldX: squareCoordinate(request.worldX), worldY: squareCoordinate(request.worldY), z: request.z ?? 0, playerIndex: request.playerIndex ?? 0 };

        return sourceEntry(() => worldContextMenu(input), '<world-context-menu>', 'pz-base-game');
    }

    /**
     * Observe an actual unconsumed pointer through the current world projection.
     *
     * @param {number} x - Fractional world x coordinate.
     * @param {number} y - Fractional world y coordinate.
     * @returns {void}
     */
    function updateWorldPointer(x, y) {
        const worldX = Math.fround(x);
        const worldY = Math.fround(y);

        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(worldX) || !Number.isFinite(worldY)) {
            throw new TypeError('Source world pointer requires finite native world coordinates');
        }

        if (busy || vmDepth) {
            throw failure('recursive Lua world pointer');
        }

        sourceEntry(() => worldPointer(worldX, worldY), '<world-pointer>', 'pz-base-game');
    }

    /**
     * Deliver the real opaque/end-world render phase, never an external event alias.
     *
     * @param {'opaque'|'building'} phase - Completed renderer phase.
     * @param {number} characterZ - Actual ground-only character elevation.
     * @returns {boolean} Whether its real world predicate delivered callbacks.
     */
    function renderWorldPhase(phase, characterZ) {
        if ((phase !== 'opaque' && phase !== 'building') || characterZ !== 0) {
            throw new TypeError('Source world phase requires a supported render phase and actual ground-level character');
        }

        if (busy || vmDepth) {
            throw failure('recursive Lua world phase');
        }

        return sourceEntry(() => worldPhase(phase, characterZ), phase === 'opaque' ? '<world-opaque-render>' : '<world-building-render>', 'pz-base-game');
    }

    /**
     * Refuse unsupported object picking before a real building click can become travel.
     *
     * @returns {boolean} False when no active drag requires native ContextPick.
     */
    function buildingInput() {
        if (busy || vmDepth) {
            throw failure('recursive Lua building input');
        }

        return sourceEntry(() => worldBuildInput(), '<world-build-input>', 'pz-base-game');
    }

    /**
     * Register original native text and paths without activating them.
     *
     * @param {LuaPackage} descriptor - Original native text and paths.
     * @returns {void}
     */
    function preload(descriptor) {
        if (closed) {
            throw new Error('Lua session is closed');
        }

        const { id, sources, nativeId, engineSource } = descriptor;

        if (typeof id !== 'string' || !id || !Array.isArray(sources)) {
            throw new TypeError('native package requires id and sources');
        }

        let entry = packages.get(id);

        if (!entry) {
            entry = { id, nativeId: nativeId ?? id, engineSource: engineSource === true, sources: new Map(), active: false, api: undefined };
            packages.set(id, entry);
        }

        for (const item of sources) {
            contexts.push({ id, path: item.path });
            try {
                run(() => {
                    const originalStandardLibrary = entry.engineSource && item.path === 'stdlib.lua';

                    if (typeof item.path !== 'string' || (!originalStandardLibrary && !/^media\/lua\/(shared|client|server)\/.+\.lua$/.test(item.path)) || item.path.includes('\\') || item.path.split('/').some((part) => part === '.' || part === '..')) {
                        throw new TypeError('unsupported native Lua source path; expected media/lua/{shared,client,server}/*.lua text or owned engine stdlib.lua');
                    }

                    if (typeof item.source !== 'string' || item.source.charCodeAt(0) === 27 || item.source.includes('\0')) {
                        throw new TypeError('unsupported Lua/Kahlua bytecode or non-text source');
                    }

                    if (entry.sources.has(item.path)) {
                        if (entry.sources.get(item.path).source !== item.source) {
                            throw new Error('native source changed within a session');
                        }

                        return;
                    }

                    const name = item.path.replace(/^media\/lua\/(shared|client|server)\//, '').replace(/\.lua$/, '').toLowerCase();

                    install({ id, nativeId: entry.nativeId, engineSource: entry.engineSource, path: item.path, source: item.source }, [name]);
                    entry.sources.set(item.path, { ...item });
                });
            } finally {
                contexts.pop();
            }
        }
    }

    /**
     * Flush live modData tables without treating activation preparation as queue capture.
     *
     * @returns {void}
     */
    function flushModData() {
        const shared = run(() => JSON.parse(data()));

        for (const key of Object.keys(shared)) {
            if (!owners.has(key)) {
                throw failure(`native modData key '${key}' has no owner; use regular table assignment rather than rawset`);
            }
        }

        for (const entry of packages.values()) {
            if (!entry.active) {
                continue;
            }

            contexts.push({ id: entry.id, path: '<save>' });
            try {
                run(() => {
                    const existing = entry.api.saveData.read();

                    if (existing !== undefined && (!existing || Array.isArray(existing) || typeof existing !== 'object')) {
                        throw new TypeError('native saveData document must be an object');
                    }

                    const nativePlayerData = {};

                    for (const [key, owner] of owners) {
                        if (owner === entry.id && Object.hasOwn(shared, key)) {
                            Object.defineProperty(nativePlayerData, key, { value: shared[key], enumerable: true });
                        }
                    }

                    entry.api.saveData.write({ ...existing, nativePlayerData });
                });
            } finally {
                contexts.pop();
            }
        }
    }

    /**
     * Refresh live owner-guarded source portability before an external save flush.
     *
     * @returns {void}
     */
    function flushSaveData() {
        prepareSourceSave();
        flushModData();
    }

    /**
     * Restore saved state in-place, preserving references held by Lua closures.
     * Unbound required modules retain unsaved keys; saved values take precedence.
     *
     * @param {string} [activatingId] - Newly bound package whose pending keys survive.
     * @returns {void}
     */
    function restoreSaveData(activatingId) {
        const shared = {};
        const restoredOwners = new Map(owners);

        for (const entry of packages.values()) {
            if (!entry.active) {
                continue;
            }

            contexts.push({ id: entry.id, path: '<restore>' });
            try {
                run(() => {
                    const saved = entry.api.saveData.read()?.nativePlayerData ?? {};

                    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
                        throw new TypeError('nativePlayerData must be an object');
                    }

                    for (const [key, value] of Object.entries(jsonCopy(saved))) {
                        if (restoredOwners.has(key) && restoredOwners.get(key) !== entry.id) {
                            throw new Error(`shared native modData ownership collision: ${key}`);
                        }

                        if (['__proto__', 'constructor', 'prototype'].includes(key)) {
                            throw new Error('unsafe native modData key');
                        }

                        restoredOwners.set(key, entry.id);
                        shared[key] = value;
                    }
                });
            } finally {
                contexts.pop();
            }
        }

        const pendingKeys = {};

        for (const [key, owner] of owners) {
            if (owner === activatingId || !packages.get(owner)?.active) {
                pendingKeys[key] = true;
            }
        }

        if (Object.keys(pendingKeys).length) {
            const pending = run(() => JSON.parse(data(pendingKeys)));

            for (const [key, value] of Object.entries(pending)) {
                if (!Object.hasOwn(shared, key)) {
                    shared[key] = value;
                }
            }
        }

        const arrayPaths = [];
        const nullPaths = [];

        /**
         * Record array and null paths for the Lua table restoration bridge.
         *
         * @param {JSONValue} value - Saved JSON node.
         * @param {(string|number)[]} path - Lua key path.
         * @returns {void}
         */
        function collectArrays(value, path) {
            if (value === null) {
                nullPaths.push(path);

                return;
            }

            if (typeof value !== 'object') {
                return;
            }

            if (Array.isArray(value)) {
                arrayPaths.push(path);
            }

            for (const [key, child] of Object.entries(value)) {
                collectArrays(child, [...path, Array.isArray(value) ? Number(key) + 1 : key]);
            }
        }

        collectArrays(shared, []);
        run(() => restore(shared, arrayPaths, nullPaths));
        owners.clear();

        for (const [key, owner] of restoredOwners) {
            owners.set(key, owner);
        }
    }

    /**
     * Deliver genuine notifications after the current Lua dispatch has unwound.
     *
     * @returns {void} Each retained committed death/hand transition is dispatched once, in order.
     */
    function drainNotifications() {
        if (busy || vmDepth || closed || drainingNotifications) {
            return;
        }

        let next = 0;

        drainingNotifications = true;
        try {
            while (next < pendingNotifications.length && !closed) {
                const event = pendingNotifications[next++];

                dispatch(event.name, event.itemId);
            }
        } catch (cause) {
            sourceContext?.onError?.(cause);
            throw cause;
        } finally {
            pendingNotifications.splice(0, next);
            drainingNotifications = false;
        }
    }

    /**
     * Transfer the one real host tick registration when its owner unloads.
     *
     * @returns {void}
     */
    function bindTicks() {
        if (unsubscribe) {
            unsubscribe();
            unsubscribe = undefined;
        }

        unsubscribeDeath?.();
        unsubscribeDeath = undefined;
        unsubscribeHands?.();
        unsubscribeHands = undefined;

        const core = packages.get('pz-base-game');

        tickOwner = core?.active ? core : undefined;

        if (!core) {
            tickOwner = [...packages.values()].find((entry) => entry.active && !entry.engineSource);
        }

        lastPosition = tickOwner?.api.movement.getState();

        if (!tickOwner) {
            return;
        }

        if (typeof tickOwner.api.events.onCharacterDeath === 'function') {
            unsubscribeDeath = tickOwner.api.events.onCharacterDeath(() => {
                pendingNotifications.push({ name: 'OnPlayerDeath', itemId: 0 });
                drainNotifications();
            });
        }

        if (typeof tickOwner.api.events.onHandItemChanged === 'function') {
            unsubscribeHands = tickOwner.api.events.onHandItemChanged(({ slot, playerIndex, itemId }) => {
                if (!['primary', 'secondary'].includes(slot) || playerIndex !== 0
                    || (itemId !== null && (!Number.isSafeInteger(itemId) || itemId <= 0 || itemId > 0xFF_FF_FF_FF))) {
                    throw failure('invalid committed native hand transition');
                }

                pendingNotifications.push({ name: slot === 'primary' ? 'OnEquipPrimary' : 'OnEquipSecondary', itemId });
                drainNotifications();
            });
        }

        unsubscribe = tickOwner.api.events.onTick(({ seconds, snapshot }) => {
            if (busy || vmDepth) {
                throw failure('recursive Lua dispatch');
            }

            busy = true;
            try {
                sourceEntry(() => tick(seconds, snapshot.tick), '<tick>', tickOwner.id);

                if (lastPosition && (snapshot.x !== lastPosition.x || snapshot.y !== lastPosition.y)) {
                    sourceEntry(() => emit('OnPlayerMove'), '<tick>', tickOwner.id);
                }

                lastPosition = snapshot;

                if (options.ui) {
                    run(() => options.ui.update());
                }
            } finally {
                busy = false;
                drainNotifications();
            }
        }, { priority: 0 });
    }

    /**
     * Withdraw one package regardless of whether its final save succeeded.
     *
     * @param {{id:string, active:boolean}} entry - Package being removed.
     * @returns {void}
     */
    function unregister(entry) {
        const failures = [];

        cleanupFaults = [];
        try {
            const sourceFailures = sourceEntry(() => Object.values(remove(entry.id))
                .map((message) => cleanupFaults.find((cause) => cause.message === message) ?? failure(message)), '<cleanup>', entry.id);

            failures.push(...sourceFailures);
        } catch (cause) {
            failures.push(cause);
        } finally {
            cleanupFaults = undefined;
        }

        // Genuine cleanup callbacks can claim new keys while their API is still alive.
        const keys = [...owners].filter(([, owner]) => owner === entry.id).map(([key]) => key);

        try {
            run(() => drop(keys));
        } catch (cause) {
            failures.push(cause);
        } finally {
            entry.active = false;
            packages.delete(entry.id);

            for (const key of keys) {
                owners.delete(key);
            }

            try {
                options.ui?.bindings.cleanup(entry.id);
            } catch (cause) {
                failures.push(cause);
            }

            try {
                bindTicks();
            } catch (cause) {
                failures.push(cause);
            }
        }

        if (failures.length === 1) {
            throw failures[0];
        }

        if (failures.length > 1) {
            throw new AggregateError(failures, failures.map((cause) => cause.message).join('; '), { cause: failures[0] });
        }
    }

    /**
     * Execute original startup chunks under the initiating native package's API.
     *
     * @param {string} apiId - Active native package providing the genuine public API.
     * @returns {void} Throws with the source context retained by run on failure.
     */
    function runEngineStartup(apiId) {
        for (const item of engineStartup) {
            contexts.push({ id: item.id, path: item.path, apiId });
            try {
                run(() => {
                    const engine = packages.get(item.id);

                    if (!engine?.engineSource || !engine.sources.has(item.path)) {
                        throw new Error('Engine startup must reference a preloaded engineSource chunk');
                    }

                    execute(item.id, item.path);
                });
            } finally {
                contexts.pop();
            }
        }

        contexts.push({ id: apiId, path: '<client-systems>', apiId });
        try {
            run(() => clientSystems());
        } finally {
            contexts.pop();
        }
    }

    /**
     * Activate after preload/fetch; never returns a Promise to the JS host.
     *
     * @param {LuaPackage} descriptor - Package-bound public API and original sources.
     * @returns {()=>void} Idempotent cleanup; flushes state before unregistration.
     */
    function activatePackage(descriptor) {
        preload(descriptor);
        const entry = packages.get(descriptor.id);

        if (entry.active) {
            throw new Error('native package is already active');
        }

        if (!descriptor.api?.movement?.getState || !descriptor.api?.actions?.submit || !descriptor.api?.events?.onTick || !descriptor.api?.saveData?.read || !descriptor.api?.saveData?.write) {
            throw new TypeError('native activation requires the bound public movement/actions/events/saveData API');
        }

        // Persist existing tables before importing this package's saved namespace.
        flushModData();
        entry.api = descriptor.api;
        entry.active = true;
        let startupFailed = false;

        try {
            restoreSaveData(entry.id);
            bindTicks();

            if (!engineStarted) {
                try {
                    runEngineStartup(entry.id);

                    engineStarted = true;
                } catch (cause) {
                    startupFailed = true;
                    throw cause;
                }
            }

            const order = { shared: 0, client: 1, server: 2 };
            const sources = [...entry.sources.values()].sort((left, right) => {
                const difference = order[left.path.split('/')[2]] - order[right.path.split('/')[2]];

                if (difference) {
                    return difference;
                }

                if (left.path < right.path) {
                    return -1;
                }

                return left.path > right.path ? 1 : 0;
            });

            for (const item of sources) {
                if (item.execute !== false) {
                    run(() => execute(entry.id, item.path));
                }
            }
        } catch (cause) {
            try {
                if (startupFailed) {
                    close({ discardSaveData: true });
                } else {
                    unregister(entry);
                }
            } catch (cleanupCause) {
                throw new AggregateError([cause, cleanupCause], `${cause.message}; native withdrawal failed: ${cleanupCause.message}`, { cause });
            }

            throw cause;
        }

        let cleaned = false;

        /**
         * Remove callbacks and modules while the bound API is alive.
         *
         * @returns {void}
         */
        function cleanup() {
            if (cleaned || closed) {
                return;
            }

            let saveFailure;

            try {
                flushSaveData();
            } catch (cause) {
                saveFailure = cause;
            }

            try {
                unregister(entry);
            } catch (cleanupCause) {
                if (saveFailure) {
                    throw new AggregateError([saveFailure, cleanupCause], `${saveFailure.message}; native withdrawal failed: ${cleanupCause.message}`, { cause: saveFailure });
                }

                throw cleanupCause;
            } finally {
                cleaned = true;
            }

            if (saveFailure) {
                throw saveFailure;
            }
        }

        descriptor.registerCleanup?.(cleanup);

        return cleanup;
    }

    /**
     * Only dispatch after the corresponding real host lifecycle/input transition.
     * OnLoad/OnGameStart/OnPostSave take no args; keys are integer host key codes. One player.
     *
     * @param {string} name - Event name.
     * @param {...number} args - Real key codes, player index, viewport dimensions or canvas coordinates.
     * @returns {void}
     */
    function dispatch(name, ...args) {
        if (name === 'OnDestroyIsoThumpable') {
            throw failure('unsupported native facility: no authenticated IsoThumpable destruction exists in this world domain');
        }

        if (!EXTERNAL_EVENTS.has(name)) {
            throw failure(`unsupported externally dispatched event: ${name}`);
        }

        if (name.startsWith('OnKey') && (args.length !== 1 || !Number.isSafeInteger(args[0]) || args[0] < 0)) {
            throw new TypeError('key event requires one nonnegative integer key code');
        }

        if (['OnLoad', 'OnGameStart', 'OnPostSave', 'OnMainMenuEnter'].includes(name) && args.length) {
            throw new TypeError(`${name} takes no arguments`);
        }

        if (['OnCreatePlayer', 'OnPlayerDeath'].includes(name) && (args.length > 1 || (args.length === 1 && args[0] !== 0))) {
            throw new TypeError('only real player index zero is supported');
        }

        if (name === 'OnResolutionChange' && (args.length !== 4 || args.some((value) => !Number.isSafeInteger(value) || value <= 0))) {
            throw new TypeError('resolution event requires four positive integer viewport dimensions');
        }

        if (name === 'OnRightMouseDown' && (args.length !== 2 || args.some((value) => !Number.isFinite(value) || value < 0))) {
            throw new TypeError('right mouse event requires two nonnegative finite canvas coordinates');
        }

        if (['OnEquipPrimary', 'OnEquipSecondary'].includes(name)
            && (args.length !== 1 || (args[0] !== null && (!Number.isSafeInteger(args[0]) || args[0] <= 0 || args[0] > 0xFF_FF_FF_FF)))) {
            throw new TypeError('equip event requires one real inventory identity or nil');
        }

        if (busy || vmDepth) {
            throw failure('recursive Lua dispatch');
        }

        busy = true;
        try {
            run(() => emit(name, ...args));
        } finally {
            busy = false;
            drainNotifications();
        }
    }

    /**
     * Apply restored configuration through the original registered callbacks.
     *
     * @returns {void} Synchronous owner-attributed application; no lifecycle event.
     */
    function applyOptions() {
        if (busy || vmDepth) {
            throw failure('recursive Lua dispatch');
        }

        busy = true;
        try {
            run(() => applyRegisteredOptions());
        } finally {
            busy = false;
            drainNotifications();
        }
    }

    /**
     * Report detached runtime and native capability failures.
     *
     * @returns {object} Runtime diagnostics.
     */
    function diagnostics() {
        return {
            interpreter: 'wasmoon', interpreterVersion: '1.16.0', luaVersion: 'Lua 5.4', nativeDialect: 'Kahlua2/Lua 5.1 (partial compatibility)', sandboxed: false,
            executions, timeouts, durationMs, memoryBytes: closed ? null : lua.global.getMemoryUsed(), memoryLimitBytes,
            packages: [...packages.values()].map((entry) => ({ id: entry.id, nativeId: entry.nativeId, active: entry.active, paths: [...entry.sources.keys()] })),
            supportedEvents: [...EVENTS], errors: errors.map((error) => ({ ...error })),
            gaps: ['Lua 5.4 is not full Lua 5.1/Kahlua equivalence', 'Kahlua/Lua bytecode', 'Java classes and shipped Java mods', ...(options.ui ? ['UI support scoped to supplied single-page BMFont/texture primitives; native shaping and scale-tier semantics unresolved'] : ['UI resources not supplied']), 'Full original createInventoryInterface HUD not bootstrapped', 'World object ContextPick and building click/placement unsupported', 'Building sprite rendering and native build-button queries not fully ported', 'No native joypad-backed building input', 'No native IsoThumpable creation/destruction domain', 'Authoritative vanilla moodle registry/levels require character.moodles capability', 'Radio/vehicles', 'Kahlua debugger/coroutine call frames', 'Sandbox options and multiplayer', 'Native engine Lua classes must be supplied as real sources'],
        };
    }

    /**
     * Persist closed original file writers without weakening the Lua callback's attribution.
     *
     * @returns {Promise<void>} Durable commit, or the genuine source owner's storage failure.
     */
    async function flushSourceFiles() {
        if (closed) {
            throw new Error('Lua session is closed');
        }

        if (!options.sourceFiles) {
            return;
        }

        try {
            await options.sourceFiles.flush();
        } catch (cause) {
            contexts.push(sourceFileOwner ?? { id: 'pz-base-game', path: 'layout.ini', apiId: 'pz-base-game' });
            try {
                throw failure(cause);
            } finally {
                contexts.pop();
            }
        }
    }

    /**
     * Flush before freeing the VM; failure leaves it open unless discarding an uncommitted failed activation.
     *
     * @param {{discardSaveData?:boolean}} [shutdown] - Explicit rollback/unload discard only.
     * @returns {void}
     */
    function close(shutdown = {}) {
        if (closed) {
            return;
        }

        if (!shutdown.discardSaveData) {
            flushSaveData();
        }

        unsubscribe?.();
        unsubscribe = undefined;
        unsubscribeDeath?.();
        unsubscribeDeath = undefined;
        unsubscribeHands?.();
        unsubscribeHands = undefined;
        pendingNotifications.length = 0;

        sourceActions?.setSaveHook?.(null);
        sourceActions?.setOwnerExport?.(null);
        options.ui?.sourceMenuMirror?.(null);

        for (const entry of packages.values()) {
            options.ui?.bindings.cleanup(entry.id);
        }

        options.ui?.clearWorldHighlights(sourceHighlightOwner);

        lua.global.close();
        options.sourceFiles?.dispose();
        closed = true;
        packages.clear();
        sourceFloorViews.clear();
        contexts.length = 0;
    }

    if (sourceActions && sourceTiming) {
        attachSourceActions(sourceActions, sourceTiming, sourceContext);
    }

    return Object.freeze({
        preload, activatePackage, dispatch, applyOptions, flushSaveData, flushSourceFiles, restoreSaveData,
        attachSourceActions, dispatchSourceAction, prepareSourceSave, exportSourceOwners, restoreSourceActions, completeSourceRestore, initializeInventoryPages, updateActorInput, updateContextKey, cancelContextKey, openWorldContextMenu,
        updateWorldPointer, renderWorldPhase, buildingInput, diagnostics, close,
    });
}
