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
 * No Java/UI objects, JS eval, native filesystem or dummy native globals exposed.
 */

/** @typedef {{path:string, source:string, execute?:boolean}} LuaSource */
/** @typedef {{id:string, nativeId?:string, engineSource?:boolean, api?:object, sources:LuaSource[], registerCleanup?:(cleanup:()=>void)=>void}} LuaPackage */
/** @typedef {string|number|boolean|null|JSONValue[]|{[key: string]: JSONValue}} JSONValue */

const EVENTS = new Set(['OnTick', 'OnPlayerUpdate', 'OnPlayerMove', 'OnGameStart', 'OnLoad', 'OnCreatePlayer', 'OnKeyPressed', 'OnKeyReleased', 'OnKeyKeepPressed']);
const EXTERNAL_EVENTS = new Set(['OnGameStart', 'OnLoad', 'OnCreatePlayer', 'OnKeyPressed', 'OnKeyReleased', 'OnKeyKeepPressed']);

/* All wrappers are Lua functions: colon arguments and event function identity
   never depend on JS object proxies or roundtripped Lua function wrappers. */
const PRELUDE = `
local hostCall, enter, leave, context, fault, own = __pz_call, __pz_enter, __pz_leave, __pz_context, __pz_fault, __pz_own
local rawLoad, info, upvalue, join = load, debug.getinfo, debug.getupvalue, debug.upvaluejoin
local rawError, traceback, rawNext = error, debug.traceback, next
local root, threadEnv = _G, _G
local envs = setmetatable({}, {__mode = 'k'})
local records, modules, loaded, loading, handlers, executed = {}, {}, {}, {}, {}, {}
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
    local value = guarded(record, function()
        local fn, err = sourceFunction(record)
        if not fn then rawError(err, 0) end
        return fn(name)
    end)
    if value == nil then value = true end
    executed[key] = value
    return value
end
function require(name)
    assert(type(name) == 'string', 'require expects a module path')
    name = name:gsub('\\\\', '/'):gsub('%.lua$', '')
    if loaded[name] ~= nil then return loaded[name] end
    if loading[name] then rawError('require cycle at ' .. name, 2) end
    local record = modules[name]
    if not record then rawError('missing native Lua module: ' .. name, 2) end
    loading[name] = true
    local ok, value = pcall(evaluate, record, name)
    loading[name] = nil
    if not ok then rawError(value, 0) end
    if value == nil then value = true end
    loaded[name] = value
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
local player = setmetatable({}, {__index = function(_, name) return unsupported('IsoPlayer:' .. tostring(name)) end})
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
function getPlayer() hostCall('state'); return player end
function getSpecificPlayer(index)
    assert(type(index) == 'number' and index >= 0 and index % 1 == 0, 'invalid player index')
    if index == 0 then return getPlayer() end
    return nil
end
function getModData() return playerData end
function transmitModData() hostCall('flush') end
local gameTime = setmetatable({}, {__index = function(_, name) return unsupported('GameTime:' .. tostring(name)) end})
function gameTime:getRealworldSecondsSinceLastUpdate() return delta end
function getGameTime() return gameTime end
function getTimestamp() return math.floor(hostCall('now') / 1000) end
function getTimestampMs() return hostCall('now') end

for _, name in ipairs(__pz_unsupported) do root[name] = unsupported(name) end
local function unsupportedObject(name)
    return setmetatable({}, {__index = function(_, key) rawError(fault('unsupported native facility: ' .. name .. '.' .. tostring(key)), 2) end,
        __call = unsupported(name)})
end
for _, name in ipairs({'PZAPI', 'Calendar', 'java', 'UIFont', 'ItemBodyLocation', 'SandboxVars'}) do root[name] = unsupportedObject(name) end
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
    if name == 'OnPlayerUpdate' or name == 'OnPlayerMove' then args = table.pack(player) end
    if name == 'OnCreatePlayer' then args = table.pack(0, player) end
    local snapshot = {}
    for _, item in ipairs(handlers[name]) do snapshot[#snapshot + 1] = item end
    for _, item in ipairs(snapshot) do
        local present = false
        for _, live in ipairs(handlers[name]) do if live == item then present = true; break end end
        if present then guarded(item, item.fn, table.unpack(args, 1, args.n)) end
    end
end
function __pz_tick(seconds, number)
    delta = seconds
    __pz_dispatch('OnTick', number)
    __pz_dispatch('OnPlayerUpdate')
end
function __pz_cleanup(id)
    for _, list in pairs(handlers) do for i = #list, 1, -1 do if list[i].id == id or list[i].apiId == id then table.remove(list, i) end end end
    for name, record in pairs(modules) do if record.id == id then modules[name], loaded[name], package.preload[name] = nil, nil, nil end end
    for key, record in pairs(records) do if record.id == id then records[key], executed[key] = nil, nil end end
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
 * Create one Lua VM; activation and callbacks after this await are synchronous.
 *
 * @param {{wasmUrl?:string|URL, timeoutMs?:number, memoryLimitBytes?:number, now?:()=>number}} [options] - VM resource limits; not sandbox guarantees.
 * @returns {Promise<object>} Shared native runtime.
 */
export async function createLuaSession(options = {}) {
    const timeoutMs = options.timeoutMs ?? 100;
    const memoryLimitBytes = options.memoryLimitBytes ?? 32 * 1_024 * 1_024;

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
    const owners = new Map();
    const contexts = [];
    const errors = [];
    let closed = false;
    let unsubscribe;
    let tickOwner;
    let lastPosition;
    let lastFault;
    let executions = 0;
    let timeouts = 0;
    let durationMs = 0;
    let busy = false;

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

        lastFault = undefined;
        executions += 1;
        try {
            return operation();
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);

            throw lastFault && message.includes(lastFault.message) ? lastFault : failure(cause);
        } finally {
            durationMs += performance.now() - start;
        }
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
            case 'state': return api().movement.getState();
            case 'speed': return api().movement.setSpeed(args[0]);
            case 'action': return api().actions.submit(args[0] === 'cancel' ? { type: 'cancel' } : { type: args[0], x: args[1], y: args[2] });
            case 'flush': return flushSaveData();
            case 'now': return (options.now ?? Date.now)();
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
    lua.global.set('__pz_unsupported', ['getCore', 'getTexture', 'getText', 'getTextOrNull', 'getModInfo', 'getActivatedMods', 'instanceof', 'getCell', 'getWorld', 'getZomboidRadio', 'getCurrentCoroutine', 'getCoroutineCallframeStack', 'getFilenameOfCallframe', 'getLuaDebuggerErrors', 'DoLuaChecksum', 'getSoundManager', 'getScriptManager', 'getAllItems', 'sendClientCommand', 'sendServerCommand']);
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
                    if (typeof item.path !== 'string' || !/^media\/lua\/(shared|client|server)\/.+\.lua$/.test(item.path) || item.path.includes('\\') || item.path.split('/').some((part) => part === '.' || part === '..')) {
                        throw new TypeError('unsupported native Lua source path; expected media/lua/{shared,client,server}/*.lua text');
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

                    const name = item.path.replace(/^media\/lua\/(shared|client|server)\//, '').replace(/\.lua$/, '');

                    install({ id, nativeId: entry.nativeId, path: item.path, source: item.source }, [name]);
                    entry.sources.set(item.path, { ...item });
                });
            } finally {
                contexts.pop();
            }
        }
    }

    /**
     * Flush all live mutable tables, merging into detached namespaced records.
     *
     * @returns {void}
     */
    function flushSaveData() {
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
     * Transfer the one real host tick registration when its owner unloads.
     *
     * @returns {void}
     */
    function bindTicks() {
        if (unsubscribe) {
            unsubscribe();
            unsubscribe = undefined;
        }

        tickOwner = [...packages.values()].find((entry) => entry.active);
        lastPosition = tickOwner?.api.movement.getState();

        if (!tickOwner) {
            return;
        }

        unsubscribe = tickOwner.api.events.onTick(({ seconds, snapshot }) => {
            if (busy) {
                throw failure('recursive Lua dispatch');
            }

            busy = true;
            try {
                run(() => tick(seconds, snapshot.tick));

                if (lastPosition && (snapshot.x !== lastPosition.x || snapshot.y !== lastPosition.y)) {
                    run(() => emit('OnPlayerMove'));
                }

                lastPosition = snapshot;
            } finally {
                busy = false;
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
        const keys = [...owners].filter(([, owner]) => owner === entry.id).map(([key]) => key);

        run(() => remove(entry.id));
        run(() => drop(keys));
        entry.active = false;
        packages.delete(entry.id);

        for (const key of keys) {
            owners.delete(key);
        }

        bindTicks();
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
        flushSaveData();
        entry.api = descriptor.api;
        entry.active = true;
        try {
            restoreSaveData(entry.id);
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

            bindTicks();
        } catch (cause) {
            unregister(entry);
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

            try {
                flushSaveData();
            } finally {
                unregister(entry);
                cleaned = true;
            }
        }

        descriptor.registerCleanup?.(cleanup);

        return cleanup;
    }

    /**
     * Only dispatch after the corresponding real host lifecycle/input transition.
     * OnLoad/OnGameStart take no args; keys are integer host key codes. One player.
     *
     * @param {string} name - Event name.
     * @param {...number} args - Real host key codes or player index.
     * @returns {void}
     */
    function dispatch(name, ...args) {
        if (!EXTERNAL_EVENTS.has(name)) {
            throw failure(`unsupported externally dispatched event: ${name}`);
        }

        if (name.startsWith('OnKey') && (args.length !== 1 || !Number.isSafeInteger(args[0]) || args[0] < 0)) {
            throw new TypeError('key event requires one nonnegative integer key code');
        }

        if ((name === 'OnLoad' || name === 'OnGameStart') && args.length) {
            throw new TypeError(`${name} takes no arguments`);
        }

        if (name === 'OnCreatePlayer' && (args.length > 1 || (args.length === 1 && args[0] !== 0))) {
            throw new TypeError('only real player index zero is supported');
        }

        if (busy) {
            throw failure('recursive Lua dispatch');
        }

        busy = true;
        try {
            run(() => emit(name, ...args));
        } finally {
            busy = false;
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
            gaps: ['Lua 5.4 is not full Lua 5.1/Kahlua equivalence', 'Kahlua/Lua bytecode', 'Java classes and shipped Java mods', 'UI/inventory/radio/vehicle/texture/translation systems', 'Kahlua debugger/coroutine call frames', 'Sandbox options and multiplayer', 'Native engine Lua classes must be supplied as real sources'],
        };
    }

    /**
     * Flush before freeing the VM; failure leaves it open unless discarding an uncommitted failed activation.
     *
     * @param {{discardSaveData?:boolean}} [options] - Explicit rollback/unload discard only.
     * @returns {void}
     */
    function close(options = {}) {
        if (closed) {
            return;
        }

        if (!options.discardSaveData) {
            flushSaveData();
        }

        unsubscribe?.();
        unsubscribe = undefined;
        lua.global.close();
        closed = true;
        packages.clear();
        contexts.length = 0;
    }

    return Object.freeze({ preload, activatePackage, dispatch, flushSaveData, restoreSaveData, diagnostics, close });
}
