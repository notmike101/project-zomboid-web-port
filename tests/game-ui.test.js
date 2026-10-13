import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGameUI, parseBitmapFont } from '../src/game-ui.js';
import { createLuaSession } from '../src/lua-runtime.js';

// Authored metrics/atlas dimensions only; never original game bytes.
const descriptor = `info face="Authored" size=10
common lineHeight=12 base=9 scaleW=32 scaleH=16 pages=1 packed=0
page id=0 file="authored.png"
chars count=3
char id=32 x=0 y=0 width=0 height=0 xoffset=0 yoffset=0 xadvance=3 page=0 chnl=15
char id=65 x=0 y=0 width=6 height=8 xoffset=1 yoffset=2 xadvance=7 page=0 chnl=15
char id=86 x=6 y=0 width=6 height=8 xoffset=0 yoffset=2 xadvance=7 page=0 chnl=15
kernings count=1
kerning first=65 second=86 amount=-2`;
const settings = { moodleSize: 1, fontSizeReal: 1, lockFPS: 60, gray: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, goodHighlight: { r: 0, g: 1, b: 0, a: 1 }, badHighlight: { r: 1, g: 0, b: 0, a: 1 } };

/**
 * Stand in for host actions that have no side effects in these fixtures.
 */
function noop() {
    // The fixture intentionally performs no host action.
}

/**
 * Initialize an isolated UI with authored metrics and texture dimensions.
 *
 * @param {()=>void} [destroy] - Atlas release callback observed by ownership tests.
 * @returns {ReturnType<typeof createGameUI>} Initialized fixture UI.
 */
function uiFixture(destroy = noop) {
    const ui = createGameUI();

    ui.setViewport(100, 80);
    ui.initialize({ textures: [{ path: 'atlas', width: 32, height: 16, destroy }, { path: 'icon', width: 9, height: 5 }], font: { descriptor, atlasPath: 'atlas' }, translations: { title: 'AV' }, settings });

    return ui;
}

test('BMFont advance, pair kerning, line height and right alignment use descriptor metrics', () => {
    const ui = uiFixture();
    const b = ui.bindings;

    assert.equal(b.call('measureX', 'mod', 'Small', 'AV'), 12);
    assert.equal(b.call('measureY', 'mod', 'Small', 'AV\nA'), 24);
    const id = b.call('new', 'mod', {});

    b.call('element', 'mod', id, 'setX', 40);
    b.call('add', 'mod', id);
    ui.setCallbacks(id, {
        /**
         * Draw the right-aligned text used by the metrics assertions.
         *
         * @returns {undefined} Drawing has no query result.
         */
        render: () => b.call('element', 'mod', id, 'DrawTextRight', 'Small', 'AV', 0, 0, 1, 1, 1, 1),
    });
    const draw = ui.render();

    // 40 - 12 + glyph offset 1
    assert.equal(draw[0].x, 29);
    // 40 - 12 + 7 - 2
    assert.equal(draw[1].x, 33);
    assert.equal(draw[0].y, 2);
    assert.throws(() => b.call('measureX', 'mod', 'Small', 'Z'), /glyph/);
    assert.throws(() => parseBitmapFont(descriptor.replace('page=0 chnl=15', 'page=1 chnl=15')), /page/);
    ui.dispose();
});

test('ordered root snapshots skip removed elements, retain other owners and clip real input/draw bounds', () => {
    let destroyed = 0;
    const ui = uiFixture(() => destroyed++);
    const b = ui.bindings;
    const first = b.call('new', 'a', {});
    const second = b.call('new', 'b', {});

    b.call('element', 'a', first, 'setX', 10);
    b.call('element', 'a', first, 'setY', 20);
    b.call('element', 'a', first, 'setWidth', 20);
    b.call('element', 'a', first, 'setHeight', 10);
    b.call('add', 'a', first);
    b.call('add', 'b', second);
    const updates = [];

    ui.setCallbacks(first, {
        /**
         * Remove the other owner's root during the update snapshot.
         */
        update: () => {
            updates.push('a');
            b.call('remove', 'a', second);
        },
        /**
         * Draw a tinted quad larger than its stencil.
         */
        render: () => {
            b.call('element', 'a', first, 'setStencilRect', 0, 0, 5, 5);
            b.call('element', 'a', first, 'DrawTextureScaledColor', null, 0, 0, 20, 10, 1, 0, 0, 0.5);
        },
    });
    ui.setCallbacks(second, {
        /**
         * Record whether the second root remains eligible for updates.
         *
         * @returns {number} New number of recorded updates.
         */
        update: () => updates.push('b'),
    });
    ui.update();
    assert.deepEqual(updates, ['a']);
    ui.setMouse(11, 21);
    assert.equal(b.call('element', 'a', first, 'isMouseOver'), true);
    ui.setMouse(30, 21);
    assert.equal(b.call('element', 'a', first, 'isMouseOver'), false);
    assert.deepEqual(ui.render()[0].clip, { x: 10, y: 20, width: 5, height: 5 });
    b.call('add', 'b', second);
    b.cleanup('a');
    ui.update();
    assert.deepEqual(updates, ['a', 'b']);
    assert.equal(b.call('texture', 'b', 'missing'), null);
    assert.equal(b.call('texture', 'b', 'icon').width, 9);
    ui.dispose();
    ui.dispose();
    assert.equal(destroyed, 1);
});

/**
 * Create mutable host API doubles with in-memory save and option storage.
 *
 * @returns {object} Host API stubs and the option map used by assertions.
 */
function apiFixture() {
    let saved = {};
    const options = new Map();

    return {
        movement: {
            /**
             * Return a stationary authored movement state.
             *
             * @returns {{x:number,y:number,speed:number}} Fixture player movement.
             */
            getState: () => ({ x: 0, y: 0, speed: 1 }),
        },
        actions: { submit: noop },
        events: {
            /**
             * Provide a no-op unsubscriber for the fixture's tick hook.
             *
             * @returns {()=>void} Inert unsubscribe callback.
             */
            onTick: () => noop,
        },
        saveData: {
            /**
             * Read the last stored save payload.
             *
             * @returns {Record<string,unknown>} Current fixture save data.
             */
            read: () => saved,
            /**
             * Replace the stored save payload.
             *
             * @param {Record<string,unknown>} v - New fixture save data.
             */
            write: (v) => {
                saved = v;
            },
        },
        ui: {
            /**
             * Read one mod's persisted options.
             *
             * @param {string} id - Mod-options identifier.
             * @returns {Record<string,unknown>|undefined} Stored values, if present.
             */
            readOptions: (id) => options.get(id),
            /**
             * Persist a detached copy of one mod's options.
             *
             * @param {string} id - Mod-options identifier.
             * @param {Record<string,unknown>} v - Values to clone and persist.
             * @returns {Map<string,Record<string,unknown>>} Updated fixture storage.
             */
            writeOptions: (id, v) => options.set(id, structuredClone(v)),
        },
        character: {
            /**
             * Keep the fixture player alive.
             *
             * @returns {boolean} False for the authored fixture.
             */
            isDead: () => false,
            /**
             * Return the authored authoritative moodle state.
             *
             * @returns {{id:string,level:number}[]} Fixture moodles.
             */
            moodles: () => [{ id: 'FOOD_EATEN', level: 3 }],
        }, options,
    };
}

test('Lua wrappers draw actual dimensions, mutate persisted mod options and clean roots on failed saves', async () => {
    const ui = uiFixture();
    const api = apiFixture();
    const session = await createLuaSession({ ui });

    try {
        const cleanup = session.activatePackage({
            id: 'test-ui', api, sources: [{
                path: 'media/lua/client/test.lua', source: `
            local o=PZAPI.ModOptions:create('fixture','title')
            local tick=o:addTickBox('tick','tick',true,'help')
            tick:setValue(false)
            local color=o:addColorPicker('color','color',1,1,1,1,'help')
            color.color.r=.25
            o:apply()
            assert(tick:getValue()==false and color:getValue().r==.25)
            assert(getTexture('icon'):getWidth()==9 and getTexture('absent')==nil)
            assert(getTextManager():MeasureStringX(UIFont.Small,'AV')==12)
            local t={update=function() end,render=function(self) self.javaObject:DrawTextureScaled(getTexture('icon'),0,0,9,5,1) end}
            t.javaObject=UIElement.new(t)
            UIManager.AddUI(t.javaObject)
            assert(getPlayer():getMoodles():getMoodleLevel('FOOD_EATEN')==3)
        `,
            }],
        });

        assert.deepEqual(api.options.get('fixture'), { tick: false, color: { r: 0.25, g: 1, b: 1, a: 1 } });
        assert.equal(ui.render()[0].width, 9);
        /**
         * Fail persistence to exercise UI cleanup during a failed save.
         */
        api.saveData.write = () => {
            throw new Error('save blocked');
        };

        assert.throws(cleanup, /save blocked/);
        assert.deepEqual(ui.render(), []);
    } finally {
        session.close({ discardSaveData: true });
        ui.dispose();
    }
});

test('headless UI access and absent authoritative moodles are attributable unsupported capabilities', async () => {
    const session = await createLuaSession();
    const api = apiFixture();

    delete api.character.moodles;
    try {
        assert.throws(() => session.activatePackage({ id: 'headless', api, sources: [{ path: 'media/lua/client/headless.lua', source: 'UIElement.new({})' }] }), /native headless\/.*unsupported.*UI/);
        assert.throws(() => session.activatePackage({ id: 'no-moodles', api, sources: [{ path: 'media/lua/client/moodles.lua', source: 'getPlayer():getMoodles():getMoodleLevel("PAIN")' }] }), /native no-moodles\/.*unsupported.*moodles/);
    } finally {
        session.close({ discardSaveData: true });
    }
});

test('resize anchors propagate to children, key flags route input and forced cursor state is live', () => {
    const ui = uiFixture();
    const b = ui.bindings;
    const root = b.call('new', 'owner', {});
    const child = b.call('new', 'owner', {});

    b.call('element', 'owner', root, 'setWidth', 30);
    b.call('element', 'owner', child, 'setX', 20);
    b.call('element', 'owner', child, 'setAnchorLeft', false);
    b.call('element', 'owner', child, 'setAnchorRight', true);
    b.call('element', 'owner', root, 'AddChild', child);
    b.call('element', 'owner', root, 'setWidth', 50);
    assert.equal(b.call('element', 'owner', child, 'getX'), 40);
    b.call('add', 'owner', root);
    b.call('element', 'owner', root, 'setAnchorLeft', false);
    b.call('element', 'owner', root, 'setAnchorRight', true);
    ui.setViewport(120, 80);
    assert.equal(b.call('element', 'owner', root, 'getX'), 20);
    const keys = [];

    ui.setCallbacks(child, {
        /**
         * Record and consume a key event delivered to the child.
         *
         * @param {string} name - Native key callback name.
         * @param {number} key - Key code delivered by the UI.
         * @returns {boolean} True to consume the event.
         */
        input: (name, key) => {
            keys.push([name, key]);

            return true;
        },
    });
    assert.equal(ui.keyInput('onKeyPress', 65), false);
    b.call('element', 'owner', child, 'setWantKeyEvents', true);
    assert.equal(ui.keyInput('onKeyPress', 65), true);
    assert.deepEqual(keys, [['onKeyPress', 65]]);
    b.call('element', 'owner', child, 'setForceCursorVisible', true);
    assert.equal(ui.cursorVisible(), true);
    b.cleanup('owner');
    assert.equal(ui.cursorVisible(), false);
    ui.dispose();
});

test('closing a VM releases its own UI callbacks before resources are disposed', async () => {
    const ui = uiFixture();
    const session = await createLuaSession({ ui });
    const api = apiFixture();

    session.activatePackage({
        id: 'closing', api, sources: [{
            path: 'media/lua/client/closing.lua', source: `
        local t={render=function(self) self.javaObject:DrawTextureScaledColor(nil,0,0,3,4,1,1,1,1) end}
        t.javaObject=UIElement.new(t); UIManager.AddUI(t.javaObject)
    `,
        }],
    });
    assert.equal(ui.render().length, 1);
    session.close({ discardSaveData: true });
    assert.deepEqual(ui.render(), []);
    ui.dispose();
});

test('failed candidate resource preload cannot mutate retained UI metrics or destroy retained atlas', () => {
    let retainedDestroyed = 0;
    let rejectedDestroyed = 0;
    const retained = uiFixture(() => retainedDestroyed++);
    const candidate = createGameUI();

    assert.throws(() => candidate.initialize({
        textures: [{
            path: 'atlas', width: 31, height: 16,
            /**
             * Record release of the rejected candidate texture.
             *
             * @returns {number} Previous release count.
             */
            destroy: () => rejectedDestroyed++,
        }],
        font: { descriptor, atlasPath: 'atlas' }, translations: { title: 'A' }, settings,
    }), /atlas/);
    candidate.dispose();
    assert.equal(retained.bindings.call('measureX', 'retained', 'Small', 'AV'), 12);
    assert.equal(retainedDestroyed, 0);
    // Failed initialize never takes ownership; uploader must release rejected textures.
    assert.equal(rejectedDestroyed, 0);
    retained.dispose();
    assert.equal(retainedDestroyed, 1);
});

test('owner cleanup preserves foreign child UI at its absolute bounds', () => {
    const ui = uiFixture();
    const b = ui.bindings;
    const parent = b.call('new', 'parent', {});
    const bridge = b.call('new', 'parent', {});
    const child = b.call('new', 'child', {});

    b.call('element', 'parent', parent, 'setX', 10);
    b.call('element', 'child', child, 'setX', 5);
    b.call('element', 'parent', bridge, 'setX', 2);
    b.call('element', 'parent', bridge, 'AddChild', child);
    b.call('element', 'parent', parent, 'AddChild', bridge);
    b.call('add', 'parent', parent);
    ui.setCallbacks(child, {
        /**
         * Draw the foreign child at its current absolute position.
         *
         * @returns {undefined} Drawing has no query result.
         */
        render: () => b.call('element', 'child', child, 'DrawTextureScaledColor', null, 0, 0, 2, 2, 1, 1, 1, 1),
    });
    assert.equal(ui.render()[0].x, 17);
    b.cleanup('parent');
    assert.equal(ui.render()[0].x, 17);
    b.cleanup('child');
    assert.deepEqual(ui.render(), []);
    ui.dispose();
});

test('registry constants require an independently proven mapping, not guessed ID spelling', async () => {
    const api = apiFixture();
    const session = await createLuaSession();

    try {
        assert.throws(() => session.activatePackage({
            id: 'unmapped-constant', api, sources: [{
                path: 'media/lua/client/constant.lua', source: 'local food = MoodleType.FOOD_EATEN',
            }],
        }), /unsupported.*MoodleType/);
    } finally {
        session.close({ discardSaveData: true });
    }
});

test('scrolled two-row Lua UI selects the hovered content row without moving viewport hit bounds', async () => {
    const ui = uiFixture();
    const session = await createLuaSession({ ui });
    const api = apiFixture();

    try {
        session.activatePackage({
            id: 'scrolled-rows', api, sources: [{
                path: 'media/lua/client/scrolled-rows.lua',
                source: `
                    local list = {rows = {'first', 'second'}, hovered = nil}
                    function list:getMouseY()
                        return getMouseY() - self.javaObject:getAbsoluteY() - self.javaObject:getYScroll()
                    end
                    function list:rowAt(x, y)
                        return math.floor(y / 20) + 1
                    end
                    function list:update()
                        self.hovered = self.javaObject:isMouseOver() and self:rowAt(0, self:getMouseY()) or nil
                        assert(self.hovered == 2)
                    end
                    function list:onMouseDown(x, y)
                        assert(x == 25 and y == 25)
                        assert(self.rows[self:rowAt(x, y)] == 'second')
                        assert(self:rowAt(x, y) == self.hovered)
                        return true
                    end
                    list.onMouseUp = list.onMouseDown
                    list.onMouseDoubleClick = list.onMouseDown
                    function list:onMouseMove(dx, dy)
                        assert(dx == -3 and dy == 2)
                        return true
                    end
                    function list:onMouseWheel(delta)
                        assert(delta == -1)
                        return true
                    end
                    list.javaObject = UIElement.new(list)
                    list.javaObject:setX(20)
                    list.javaObject:setY(20)
                    list.javaObject:setWidth(40)
                    list.javaObject:setHeight(20)
                    list.javaObject:setXScroll(-20)
                    list.javaObject:setYScroll(-20)
                    list.javaObject:setWantExtraMouseEvents(true)
                    UIManager.AddUI(list.javaObject)
                `,
            }],
        });
        ui.setMouse(25, 25);
        ui.update();

        for (const name of ['onMouseDown', 'onMouseUp', 'onMouseDoubleClick']) {
            assert.equal(ui.input(name, 25, 25), true);
            assert.equal(ui.input(name, 25, 5), false);
            assert.equal(ui.input(name, 25, 45), false);
        }

        assert.equal(ui.input('onMouseMove', 25, 25, -3, 2), true);
        assert.equal(ui.input('onMouseWheel', 25, 25, -1), true);
    } finally {
        session.close({ discardSaveData: true });
        ui.dispose();
    }
});

test('indexed UI textures require preload while genuinely missing textures remain absent', () => {
    const ui = createGameUI();
    const indexedTextures = ['atlas', 'icon', 'media/ui/unloaded.png'];

    try {
        ui.initialize({
            textures: [{ path: 'atlas', width: 32, height: 16 }, { path: 'icon', width: 9, height: 5 }],
            indexedTextures,
            font: { descriptor, atlasPath: 'atlas' },
            translations: { title: 'AV' },
            settings,
        });
        assert.equal(ui.bindings.call('texture', 'indexed-owner', 'icon').width, 9);
        assert.throws(() => ui.bindings.call('texture', 'indexed-owner', 'media/ui/unloaded.png'), /unsupported.*indexed texture.*not preloaded.*media\/ui\/unloaded\.png/i);
        assert.equal(ui.bindings.call('texture', 'indexed-owner', 'media/ui/missing.png'), null);
        indexedTextures.push('media/ui/later.png');
        assert.equal(ui.bindings.call('texture', 'indexed-owner', 'media/ui/later.png'), null);

        assert.throws(() => ui.initialize({
            textures: [{ path: 'atlas', width: 31, height: 16 }],
            indexedTextures: ['media/ui/failed-candidate.png'],
            font: { descriptor, atlasPath: 'atlas' },
            translations: { title: 'AV' },
            settings,
        }), /atlas/);
        assert.throws(() => ui.bindings.call('texture', 'indexed-owner', 'media/ui/unloaded.png'), /not preloaded/);
        assert.equal(ui.bindings.call('texture', 'indexed-owner', 'media/ui/failed-candidate.png'), null);
    } finally {
        ui.dispose();
    }
});

test('mouse hit testing retains pointer coordinates while move and wheel callbacks receive their native arguments', () => {
    const ui = uiFixture();
    const b = ui.bindings;
    const id = b.call('new', 'input-owner', {});

    b.call('element', 'input-owner', id, 'setX', 20);
    b.call('element', 'input-owner', id, 'setY', 30);
    b.call('element', 'input-owner', id, 'setWidth', 20);
    b.call('element', 'input-owner', id, 'setHeight', 15);
    b.call('element', 'input-owner', id, 'setWantExtraMouseEvents', true);
    b.call('add', 'input-owner', id);
    const received = [];

    ui.setCallbacks(id, {
        /**
         * Record native mouse arguments and consume each routed event.
         *
         * @param {string} name - Native mouse callback name.
         * @param {...number} args - Move deltas, wheel delta or local pointer coordinates.
         * @returns {boolean} True to consume the event.
         */
        input: (name, ...args) => {
            received.push([name, ...args]);

            return true;
        },
    });
    try {
        assert.equal(ui.input('onMouseMove', 25, 34, -3, 2), true);
        assert.equal(ui.input('onMouseWheel', 25, 34, -1), true);

        for (const name of ['onMouseDown', 'onMouseUp', 'onMouseDoubleClick']) {
            assert.equal(ui.input(name, 25, 34), true);
        }

        assert.equal(ui.input('onMouseMove', 5, 4, 25, 34), false);
        assert.equal(ui.input('onMouseWheel', 5, 4, 1), false);
        assert.deepEqual(received, [
            ['onMouseMove', -3, 2],
            ['onMouseWheel', -1],
            ['onMouseDown', 5, 4],
            ['onMouseUp', 5, 4],
            ['onMouseDoubleClick', 5, 4],
        ]);
    } finally {
        ui.dispose();
    }
});

test('native wrappers retain userdata identity for authored environment table dispatch and texture rendering', async () => {
    const ui = uiFixture();
    const session = await createLuaSession({
        ui,
        engineStartup: [{ id: 'authored-engine', path: 'media/lua/shared/AuthoredEnv.lua' }],
    });

    session.preload({
        id: 'authored-engine', engineSource: true, sources: [{
            path: 'media/lua/shared/AuthoredEnv.lua',
            source: `
                function isAuthoredTable(value) return type(value) == 'table' end
                function authoredTexture(value)
                    if isAuthoredTable(value) then return value:getTexture() end
                    return value
                end
            `,
        }],
    });
    try {
        const cleanup = session.activatePackage({
            id: 'native-identity', api: apiFixture(), sources: [{
                path: 'media/lua/client/NativeIdentity.lua',
                source: `
                    local icon = getTexture('icon')
                    assert(type(icon) == 'userdata' and not isAuthoredTable(icon))
                    assert(instanceof(icon, 'Texture') and not instanceof(icon, 'UIElement'))
                    assert(icon:getWidth() == 9 and authoredTexture(icon) == icon)
                    local getter = {getTexture = function() return icon end}
                    assert(type(getter) == 'table' and authoredTexture(getter) == icon)
                    assert(type({__texture='icon'}) == 'table')
                    assert(not instanceof({__texture='icon'}, 'Texture'))
                    assert(not instanceof({__ui=1}, 'UIElement'))
                    assert(not instanceof(nil, 'Texture') and not instanceof(7, 'Texture'))
                    assert(type(nil)=='nil' and type(true)=='boolean' and type(7)=='number')
                    assert(type('icon')=='string' and type(function() end)=='function')
                    assert(type(coroutine.create(function() end))=='thread')
                    assert(type(getCore())=='userdata' and type(getTextManager())=='userdata')
                    assert(type(getPlayer())=='userdata' and type(getGameTime())=='userdata')
                    assert(type(getModData())=='table' and type(getPlayer():getModData())=='table')
                    local authoredBase={Type='AuthoredUI'}
                    local target = setmetatable({render=function(self)
                        self.javaObject:DrawTextureScaled(authoredTexture(icon),0,0,9,5,1)
                    end}, {__index=authoredBase})
                    target.javaObject = UIElement.new(target)
                    assert(type(target)=='table' and type(target.javaObject)=='userdata')
                    assert(target.Type=='AuthoredUI' and isAuthoredTable(target))
                    assert(instanceof(target.javaObject,'UIElement') and not instanceof(target.javaObject,'Texture'))
                    UIManager.AddUI(target.javaObject)
                `,
            }],
        });

        assert.equal(ui.render()[0].width, 9);
        cleanup();
        assert.deepEqual(ui.render(), []);
    } finally {
        session.close({ discardSaveData: true });
        ui.dispose();
    }
});

test('configuration restore applies actual registered callbacks without menu replay and preserves unrelated saved state', async () => {
    const ui = uiFixture();
    const api = apiFixture();

    api.options.set('authored-config', { gray: { r: 0.2, g: 0.3, b: 0.4, a: 0.7 } });
    api.saveData.write({ unrelated: { retained: 17 } });
    const session = await createLuaSession({ ui });

    try {
        const cleanup = session.activatePackage({
            id: 'configuration', api, sources: [{
                path: 'media/lua/client/Configuration.lua',
                source: `
                    local config=PZAPI.ModOptions:create('authored-config','Authored')
                    local color=config:addColorPicker('gray','Gray',1,1,1,1,'Authored')
                    getModData().Config={applies=0,menus=0}
                    Events.OnMainMenuEnter.Add(function() getModData().Config.menus=getModData().Config.menus+1 end)
                    local base=config.apply
                    config.apply=function(self)
                        base(self)
                        local value=color:getValue()
                        Color.gray:set(value.r,value.g,value.b,value.a)
                        getModData().Config.applies=getModData().Config.applies+1
                    end
                `,
            }],
        });

        assert.deepEqual(ui.bindings.call('gray', 'configuration'), { r: 0.5, g: 0.5, b: 0.5, a: 1 });
        session.applyOptions();
        assert.deepEqual(ui.bindings.call('gray', 'configuration'), { r: 0.2, g: 0.3, b: 0.4, a: 0.7 });
        session.flushSaveData();
        assert.deepEqual(api.saveData.read().unrelated, { retained: 17 });
        assert.deepEqual(api.saveData.read().nativePlayerData.Config, { applies: 1, menus: 0 });
        cleanup();
        // Owner cleanup withdraws its options application callback.
        session.applyOptions();
        assert.deepEqual(session.diagnostics().errors, []);
    } finally {
        session.close({ discardSaveData: true });
        ui.dispose();
    }
});
