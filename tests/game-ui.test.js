import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGameUI, parseBitmapFont } from '../src/game-ui.js';
import { createLuaSession } from '../src/lua-runtime.js';
import { menuDocument } from './queue-test-helpers.js';

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
 * @param {()=>number} [now] - Actual UI-frame wall clock, injected for transition boundaries.
 * @returns {ReturnType<typeof createGameUI>} Initialized fixture UI.
 */
function uiFixture(destroy = noop, now = Date.now) {
    const ui = createGameUI({ now });

    ui.setViewport(100, 80);
    ui.initialize({ textures: [{ path: 'atlas', width: 32, height: 16, destroy }, { path: 'icon', width: 9, height: 5 }], font: { descriptor, atlasPath: 'atlas' }, translations: { title: 'AV' }, settings });

    return ui;
}

/**
 * Attach one input target to the selected native traversal.
 *
 * @param {ReturnType<typeof createGameUI>['bindings']} bindings - Fixture native UI bindings.
 * @param {number|null} parent - Parent handle, or null for a root target.
 * @param {number} id - Native UI element handle.
 */
function attachInputTarget(bindings, parent, id) {
    if (parent === null) {
        bindings.call('add', 'lifetime', id);
    } else {
        bindings.call('element', 'lifetime', parent, 'AddChild', id);
    }
}

test('native UI lifetime release frees unreachable handles without destroying temporarily detached widgets', () => {
    const ui = uiFixture();
    const b = ui.bindings;
    let updates = 0;
    const attached = [];
    const parent = b.call('new', 'lifetime', {
        /**
         * Count updates while this widget is attached.
         */
        update: () => {
            updates += 1;
        },
        /**
         * Record native root attachment changes.
         *
         * @param {boolean} value - Whether the widget is attached.
         */
        attached: (value) => {
            attached.push(value);
        },
    });
    const child = b.call('new', 'lifetime', {});
    const retainedChild = b.call('new', 'lifetime', {});
    const transition = b.call('transitionNew', 'lifetime');

    try {
        b.call('element', 'lifetime', parent, 'AddChild', child);
        b.call('element', 'lifetime', parent, 'AddChild', retainedChild);
        b.call('add', 'lifetime', parent);
        ui.update();
        b.call('remove', 'lifetime', parent);
        ui.update();
        assert.equal(updates, 1);
        b.call('add', 'lifetime', parent);
        ui.update();
        assert.equal(updates, 2, 'a retained detached widget keeps its original callbacks when reattached');
        assert.deepEqual(attached, [true, false, true]);

        b.call('release', 'lifetime', child);
        assert.throws(() => b.call('element', 'lifetime', child, 'getX'), /UI element/u);
        ui.update();
        assert.equal(updates, 3, 'releasing a child removes its parent traversal entry');
        b.call('release', 'lifetime', parent);
        b.call('release', 'lifetime', parent);
        assert.deepEqual(b.call('getUI', 'lifetime'), []);
        assert.throws(() => b.call('element', 'lifetime', parent, 'getX'), /UI element/u);
        ui.update();
        assert.equal(updates, 3);
        assert.deepEqual(attached, [true, false, true], 'finalizers never call back into dying Lua objects');
        assert.equal(b.call('element', 'lifetime', retainedChild, 'isReallyVisible'), false);
        b.call('add', 'lifetime', retainedChild);
        assert.equal(b.call('element', 'lifetime', retainedChild, 'isReallyVisible'), true,
            'a separately retained child may become a root after its native parent is released');
        b.call('transitionRelease', 'lifetime', transition);
        assert.throws(() => b.call('transition', 'lifetime', transition, 'fraction'), /UI transition/u);
        b.cleanup('lifetime');
        b.call('release', 'lifetime', retainedChild);
        b.call('transitionRelease', 'lifetime', transition);
        assert.throws(() => b.call('transition', 'lifetime', transition, 'fraction'), /UI transition/u);
    } finally {
        ui.dispose();
    }
});

test('native UI finalization during input skips handles retained only in traversal snapshots', () => {
    for (const placement of ['root', 'child']) {
        for (const phase of ['onMouseDown', 'onMouseMove', 'onMouseMoveOutside', 'onKeyPress']) {
            const ui = uiFixture();
            const b = ui.bindings;
            let staleCalls = 0;
            const parent = placement === 'child' ? b.call('new', 'lifetime', {}) : null;
            const victim = b.call('new', 'lifetime', {
                /**
                 * Count any stale dispatch into the released widget.
                 */
                input: () => {
                    staleCalls += 1;
                },
            });
            const killer = b.call('new', 'lifetime', {
                /**
                 * Release the next snapshot target during the selected input phase.
                 *
                 * @param {string} name - Native input callback name.
                 * @returns {boolean} Whether this input phase consumes mouse movement.
                 */
                input: (name) => {
                    if (name === phase) {
                        b.call('release', 'lifetime', victim);
                    }

                    return name === phase && phase === 'onMouseMove';
                },
            });

            try {
                for (const id of [victim, killer]) {
                    b.call('element', 'lifetime', id, 'setWidth', 10);
                    b.call('element', 'lifetime', id, 'setHeight', 10);
                    b.call('element', 'lifetime', id, 'setWantKeyEvents', true);

                    attachInputTarget(b, parent, id);
                }

                if (parent !== null) {
                    b.call('element', 'lifetime', parent, 'setWidth', 10);
                    b.call('element', 'lifetime', parent, 'setHeight', 10);
                    b.call('add', 'lifetime', parent);
                }

                if (phase === 'onKeyPress') {
                    assert.equal(ui.keyInput(phase, 65), false);
                } else {
                    const outside = phase === 'onMouseMoveOutside';

                    assert.equal(ui.input(outside ? 'onMouseMove' : phase, outside ? 50 : 5, 5, 0, 0),
                        phase === 'onMouseMove', `${placement}:${phase}`);
                }

                assert.equal(staleCalls, 0, `${placement}:${phase} cannot call the released target`);
            } finally {
                ui.dispose();
            }
        }
    }
});

test('native UI owner cleanup preserves surviving foreign children when finalizers invalidate its snapshot', () => {
    for (const released of ['child', 'parent']) {
        const ui = uiFixture();
        const b = ui.bindings;
        const parent = b.call('new', 'removed-owner', {});
        let armed = false;
        const child = b.call('new', 'removed-owner', {
            /**
             * Invalidate the cleanup snapshot when its owned child detaches.
             *
             * @param {boolean} value - Whether the widget is attached.
             */
            attached: (value) => {
                if (armed && !value) {
                    armed = false;
                    b.call('release', 'removed-owner', released === 'parent' ? parent : foreign);
                }
            },
        });

        const foreign = b.call('new', 'surviving-owner', {});

        try {
            b.call('element', 'removed-owner', parent, 'setX', 20);
            b.call('element', 'removed-owner', parent, 'setY', 10);
            b.call('element', 'surviving-owner', foreign, 'setX', 3);
            b.call('element', 'surviving-owner', foreign, 'setY', 4);
            b.call('element', 'removed-owner', parent, 'AddChild', child);
            b.call('element', 'removed-owner', parent, 'AddChild', foreign);
            b.call('add', 'removed-owner', parent);
            armed = true;
            b.cleanup('removed-owner');
            assert.deepEqual(b.call('getUI', 'surviving-owner'), released === 'parent' ? [foreign] : []);

            if (released === 'parent') {
                assert.equal(b.call('element', 'surviving-owner', foreign, 'getX'), 23);
                assert.equal(b.call('element', 'surviving-owner', foreign, 'getY'), 14);
            }
        } finally {
            ui.dispose();
        }
    }
});

test('Core outline options remain mutable until explicit save and reload through origin storage', () => {
    const stored = new Map();
    const storage = {
        /**
         * Read the actual persisted options document.
         *
         * @param {string} key - Origin-local storage key.
         * @returns {string|null} Stored serialized options, if present.
         */
        getItem: (key) => stored.get(key) ?? null,
        /**
         * Commit the serialized options document.
         *
         * @param {string} key - Origin-local storage key.
         * @param {string} value - Serialized options document.
         * @returns {void} Commits the value.
         */
        setItem: (key, value) => {
            stored.set(key, value);
        },
    };
    const resources = { textures: [{ path: 'atlas', width: 32, height: 16 }], font: { descriptor, atlasPath: 'atlas' }, translations: {}, settings };
    const ui = createGameUI({ storage });
    const restored = createGameUI({ storage });

    try {
        ui.initialize(resources);
        const b = ui.bindings;

        assert.equal(b.call('settings', 'core').doContainerOutline, true);
        assert.deepEqual(b.call('settings', 'core').objectHighlight, { r: 0.98, g: 0.56, b: 0.11, a: 1 });
        assert.deepEqual(b.call('settings', 'core').worldItemHighlight, { r: 0.5, g: 1, b: 1, a: 1 });
        b.call('setCoreOption', 'core', 'doContainerOutline', false);
        b.call('setCoreOption', 'core', 'objectHighlight', { r: 0.25, g: 0.5, b: 0.75, a: 1 });
        assert.equal(stored.size, 0, 'setters must not implicitly save client options');
        assert.equal(b.call('settings', 'core').doContainerOutline, false);
        assert.throws(() => b.call('setCoreOption', 'core', 'doContainerOutline', 0), /invalid Core option/u);
        assert.throws(() => b.call('setCoreOption', 'core', 'objectHighlight', { r: 2, g: 0, b: 0, a: 1 }), /RGBA/u);
        b.call('saveOptions', 'core');
        restored.initialize(resources);
        assert.equal(restored.bindings.call('settings', 'core').doContainerOutline, false);
        assert.deepEqual(restored.bindings.call('settings', 'core').objectHighlight, { r: 0.25, g: 0.5, b: 0.75, a: 1 });
        assert.deepEqual(restored.bindings.call('settings', 'core').worldItemHighlight, { r: 0.5, g: 1, b: 1, a: 1 });
        stored.set('pz-web-core-options', '{"worldItemHighlight":{"r":0.25,"g":0.75,"b":1,"a":1}}');
        restored.initialize(resources);
        assert.deepEqual(restored.bindings.call('settings', 'core').worldItemHighlight, { r: 0.25, g: 0.75, b: 1, a: 1 });
        restored.bindings.call('saveOptions', 'core');
        assert.deepEqual(JSON.parse(stored.get('pz-web-core-options')).worldItemHighlight, { r: 0.25, g: 0.75, b: 1, a: 1 });
        stored.set('pz-web-core-options', '{"doContainerOutline":null}');
        assert.throws(() => restored.initialize(resources), /must be boolean/u);
        stored.set('pz-web-core-options', '{"objectHighlight":null}');
        assert.throws(() => restored.initialize(resources), /RGBA/u);
    } finally {
        ui.dispose();
        restored.dispose();
    }
});

test('source world highlight records retain independent namespaces, colors and immutable frame snapshots', () => {
    const ui = uiFixture();

    try {
        const color = { r: 0.25, g: 0.5, b: 0.75, a: 1 };

        ui.setWorldHighlight('item', 1, { enabled: true, blink: false, outline: true, outlineAttached: true, color, outlineColor: color });
        ui.setWorldHighlight('door', '1', { enabled: true, blink: true });
        const before = ui.worldHighlights();

        color.r = 1;
        assert.equal(before[0].color.r, 0.25, 'Lua caller input must not alias renderer records');
        assert.equal(before.length, 2);
        assert.ok(Object.isFrozen(before) && Object.isFrozen(before[0]) && Object.isFrozen(before[0].color));
        ui.setWorldHighlight('item', 1, { enabled: false, blink: false, outline: false });
        assert.equal(before[0].enabled, true, 'submitted frames must not mutate behind the renderer');
        assert.equal(ui.worldHighlights()[0].enabled, false);
        assert.equal(ui.worldHighlights()[1].enabled, true, 'item clearing must not clear a door with the same numeric label');
        assert.throws(() => ui.setWorldHighlight('item', 0, { enabled: true, blink: false }), /Invalid source world highlight/u);
    } finally {
        ui.dispose();
    }
});

test('native nullable text measures preserve the original zero result without coercing invalid drawing or numeric text', () => {
    const ui = uiFixture();
    const b = ui.bindings;

    try {
        assert.equal(b.call('measureX', 'measure', null, null), 0);
        assert.equal(b.call('measureX', 'measure', 'UnloadedFont', undefined), 0, 'native null text returns before font lookup');
        assert.equal(b.call('measureX', 'measure', null, 'AV'), 12, 'native width uses the default font when its enum is nil');
        assert.equal(b.call('measureY', 'measure', null, 'AV'), 0, 'native height explicitly rejects a nil enum before lookup');
        assert.equal(b.call('measureY', 'measure', 'Small', null), 0, 'nil text is not an empty string with line height');
        assert.equal(b.call('measureY', 'measure', 'Small', 'AV'), 12);
        assert.throws(() => b.call('measureX', 'measure', 'Small', 12), /bounded string/u);
        assert.throws(() => b.call('measureY', 'measure', 'Small', {}), /bounded string/u);
        const root = b.call('new', 'measure', {});

        b.call('add', 'measure', root);
        assert.throws(() => b.call('element', 'measure', root, 'DrawText', 'Small', {}, 0, 0, 1, 1, 1, 1), /bounded string/u);
    } finally {
        ui.dispose();
    }
});

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

test('three authored fonts measure and draw their own metrics and atlas without changing Small', () => {
    const ui = createGameUI();
    const medium = descriptor.replace('size=10', 'size=17').replace('lineHeight=12', 'lineHeight=19').replace('scaleW=32 scaleH=16', 'scaleW=64 scaleH=32').replace('id=65 x=0 y=0 width=6 height=8', 'id=65 x=16 y=4 width=8 height=10').replace('xadvance=7', 'xadvance=11');
    const large = descriptor.replace('size=10', 'size=24').replace('lineHeight=12', 'lineHeight=28').replace('scaleW=32 scaleH=16', 'scaleW=128 scaleH=64').replace('id=65 x=0 y=0 width=6 height=8', 'id=65 x=64 y=32 width=12 height=16').replace('xadvance=7', 'xadvance=15');

    ui.setViewport(100, 100);
    ui.initialize({
        textures: [{ path: 'small', width: 32, height: 16 }, { path: 'medium', width: 64, height: 32 }, { path: 'large', width: 128, height: 64 }],
        fonts: {
            Small: { descriptor, atlasPath: 'small' },
            Medium: { descriptor: medium, atlasPath: 'medium' },
            Large: { descriptor: large, atlasPath: 'large' },
        },
        translations: {}, settings,
        fontAliases: { NewSmall: 'Small' },
    });
    const b = ui.bindings;
    const id = b.call('new', 'fonts', {});

    b.call('add', 'fonts', id);
    ui.setCallbacks(id, {
        /** Draw one actual glyph from each independently authored font. */
        render: () => {
            b.call('element', 'fonts', id, 'DrawTextRight', 'Small', 'A', 40, 0, 1, 1, 1, 1);
            b.call('element', 'fonts', id, 'DrawTextRight', 'Medium', 'A', 40, 20, 1, 1, 1, 1);
            b.call('element', 'fonts', id, 'DrawTextCentre', 'Large', 'A', 40, 40, 1, 1, 1, 1);
        },
    });
    try {
        assert.equal(b.call('measureX', 'fonts', 'Small', 'AV'), 12);
        assert.equal(b.call('measureX', 'fonts', 'Medium', 'AV'), 16);
        assert.equal(b.call('measureX', 'fonts', 'Large', 'AV'), 20);
        assert.equal(b.call('measureX', 'fonts', 'NewSmall', 'AV'), 12);
        assert.equal(b.call('measureY', 'fonts', 'Medium', 'A\nV'), 38);
        assert.equal(b.call('fontHeight', 'fonts', 'Large'), 28);
        assert.equal(b.call('fontSize', 'fonts', 'Medium'), 17);
        assert.deepEqual(ui.render().map((command) => [command.texture.path, command.x, command.y, command.width, command.height, command.uv]), [
            ['small', 34, 2, 6, 8, { x: 0, y: 0, width: 0.187_5, height: 0.5 }],
            ['medium', 30, 22, 8, 10, { x: 0.25, y: 0.125, width: 0.125, height: 0.312_5 }],
            ['large', 33.5, 42, 12, 16, { x: 0.5, y: 0.5, width: 0.093_75, height: 0.25 }],
        ]);
        assert.throws(() => b.call('fontHeight', 'fonts', 'Missing'), /Unsupported font/);
    } finally {
        ui.dispose();
    }
});

test('native transitions share one UI frame clock and preserve float32 fade lag and reversals in rendered opacity', () => {
    let now = 1_000;
    const ui = uiFixture(noop, () => now);
    const b = ui.bindings;

    try {
        ui.render();
        const fades = [b.call('transitionNew', 'buttons'), b.call('transitionNew', 'buttons')];
        const root = b.call('new', 'buttons', {
            /** Render two controls using their actual transition opacity. */
            render: () => {
                for (const [index, id] of fades.entries()) {
                    b.call('transition', 'buttons', id, 'update');
                    b.call('element', 'buttons', root, 'DrawTextureScaledColor', null, index * 10, 0, 5, 5, 1, 1, 1,
                        b.call('transition', 'buttons', id, 'fraction'));
                }
            },
        });

        b.call('add', 'buttons', root);
        now = 1_010;
        ui.update();
        now = 1_020;
        assert.deepEqual(ui.render(), [], 'zero transition opacity must not emit a visible quad');
        assert.deepEqual(fades.map((id) => b.call('transition', 'buttons', id, 'getElapsed')), [20, 20]);
        now = 1_040;
        assert.deepEqual(ui.render().map(({ color }) => color.a), [Math.fround(0.2), Math.fround(0.2)]);
        b.call('transition', 'buttons', fades[0], 'setFadeIn', false);
        assert.equal(b.call('transition', 'buttons', fades[0], 'fraction'), Math.fround(1 - Math.fround(0.2)));
        now = 1_060;
        const reversed = ui.render().map(({ color }) => color.a);

        assert.equal(reversed[0], Math.fround(1 - Math.fround(0.8)));
        assert.equal(reversed[1], Math.fround(0.4));
        b.call('transition', 'buttons', fades[1], 'init', 0, false);
        now = 1_061;
        ui.render();
        assert.equal(b.call('transition', 'buttons', fades[1], 'getElapsed'), 1, 'native durations clamp to one millisecond');
        now = 1_062;
        assert.equal(ui.render()[1].color.a, 1);
    } finally {
        ui.dispose();
    }
});

test('native transition idle expiry, ignore flag and reset preserve cached fractions and owner lifetime', () => {
    let now = 1_000;
    const ui = uiFixture(noop, () => now);
    const b = ui.bindings;

    try {
        ui.render();
        const ordinary = b.call('transitionNew', 'ordinary');
        const ignored = b.call('transitionNew', 'ignored');
        const root = b.call('new', 'ordinary', {
            /** Advance both source consumers against the same completed frame clock. */
            render: () => {
                b.call('transition', 'ordinary', ordinary, 'update');
                b.call('transition', 'ignored', ignored, 'update');
            },
        });

        b.call('transition', 'ignored', ignored, 'setIgnoreUpdateTime', true);
        b.call('add', 'ordinary', root);
        now = 1_020;
        ui.render();
        now = 1_040;
        ui.render();
        b.call('element', 'ordinary', root, 'setVisible', false);
        now = 2_000;
        ui.render();
        b.call('element', 'ordinary', root, 'setVisible', true);
        now = 2_020;
        ui.render();
        assert.equal(b.call('transition', 'ordinary', ordinary, 'fraction'), 1);
        assert.equal(b.call('transition', 'ignored', ignored, 'fraction'), Math.fround(0.4));
        b.call('transition', 'ignored', ignored, 'reset');
        assert.equal(b.call('transition', 'ignored', ignored, 'fraction'), Math.fround(0.4));
        assert.equal(b.call('transition', 'ignored', ignored, 'getElapsed'), 0);
        b.call('transition', 'ignored', ignored, 'setElapsed', 12.345_678);
        assert.equal(b.call('transition', 'ignored', ignored, 'getElapsed'), Math.fround(12.345_678));
        now = 2_050;
        b.call('transitionUpdateAll', 'ignored');
        b.call('transition', 'ignored', ignored, 'update');
        assert.equal(b.call('transition', 'ignored', ignored, 'getElapsed'), Math.fround(Math.fround(12.345_678) + 30));
        b.cleanup('ordinary');
        assert.throws(() => b.call('transition', 'ordinary', ordinary, 'fraction'), /session/);
        assert.equal(b.call('transition', 'ignored', ignored, 'fraction'), Math.fround(Math.fround(12.345_678) / 100));
    } finally {
        ui.dispose();
    }
});

test('ordered root snapshots retain owner cleanup and native stencil drawing without masking input', () => {
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
            b.call('element', 'a', first, 'clearStencilRect');
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
    const commands = ui.render();

    assert.equal(b.call('element', 'a', first, 'isPointOver', 16, 21), true, 'native GL stencils do not mask input');
    const draw = commands.find((command) => command.type !== 'stencil');

    assert.deepEqual([draw.x, draw.y, draw.width, draw.height, draw.color],
        [10, 20, 20, 10, { r: 1, g: 0, b: 0, a: 0.5 }]);
    b.call('add', 'b', second);
    b.cleanup('a');
    assert.equal(commands.some((command) => command.type !== 'stencil'), false, 'cleanup removes owned quads without rewriting global stencil history');
    ui.update();
    assert.deepEqual(updates, ['a', 'b']);
    assert.equal(b.call('texture', 'b', 'missing'), null);
    assert.equal(b.call('texture', 'b', 'icon').width, 9);
    ui.dispose();
    ui.dispose();
    assert.equal(destroyed, 1);
});

test('stencil rectangles use native integer absolute origins independently of draw scrolling', () => {
    const ui = uiFixture();
    const b = ui.bindings;
    const page = b.call('new', 'page', {});
    const pane = b.call('new', 'pane', {});
    const icon = b.call('texture', 'pane', 'icon');

    try {
        b.call('element', 'page', page, 'setX', 10.75);
        b.call('element', 'page', page, 'setY', 8.5);
        b.call('element', 'pane', pane, 'setX', 3.75);
        b.call('element', 'pane', pane, 'setY', 4.5);
        b.call('element', 'pane', pane, 'setXScroll', 5.75);
        b.call('element', 'pane', pane, 'setYScroll', -3.25);
        b.call('element', 'page', page, 'AddChild', pane);
        b.call('add', 'page', page);
        ui.setCallbacks(page, {
            /**
             * Transform the parent's local mask into native integer canvas coordinates.
             *
             * @returns {undefined} The native stencil mutation has no query result.
             */
            prerender: () => b.call('element', 'page', page, 'setStencilRect', 0.75, 0.75, 30.9, 25.9),
            /**
             * Balance the parent's stencil after the child has rendered.
             *
             * @returns {undefined} The native stencil mutation has no query result.
             */
            render: () => b.call('element', 'page', page, 'clearStencilRect'),
        });
        ui.setCallbacks(pane, {
            /** Contrast mask coordinates with a natural texture's scrolled draw coordinates. */
            render: () => {
                b.call('element', 'pane', pane, 'setStencilRect', 2.75, 2.5, 4.9, 3.9);
                b.call('element', 'pane', pane, 'DrawTextureColor', icon, 1.5, 0.75, 1, 0, 0, 1);
                b.call('element', 'pane', pane, 'clearStencilRect');
                b.call('element', 'pane', pane, 'repaintStencilRect', 2.75, 2.5, 4.9, 3.9);
            },
        });
        const commands = ui.render();
        const rectangles = commands.filter((command) => command.type === 'stencil'
            && (command.operation === 'set' || command.operation === 'repaint'));

        assert.deepEqual(rectangles.map(({ x, y, width, height }) => [x, y, width, height]), [
            [10, 8, 30, 25], [15, 14, 4, 3], [15, 14, 4, 3],
        ]);
        assert.deepEqual(commands.filter((command) => command.type !== 'stencil')
            .map(({ x, y, width, height, color }) => [x, y, width, height, color]), [
            [20, 9, 9, 5, { r: 1, g: 0, b: 0, a: 1 }],
        ]);
    } finally {
        ui.dispose();
    }
});

test('original page mouse capture keeps a dragged child receiving move and release outside its root', () => {
    const ui = uiFixture();
    const b = ui.bindings;
    const seen = [];
    const root = b.call('new', 'page', {});
    const child = b.call('new', 'page', {});

    try {
        for (const id of [root, child]) {
            b.call('element', 'page', id, 'setWidth', 10);
            b.call('element', 'page', id, 'setHeight', 10);
        }

        ui.setCallbacks(child, {
            /**
             * Retain mouse capture until the dragged control is released.
             *
             * @param {string} name - Native input callback.
             * @returns {boolean} The dragged control consumes input.
             */
            input: (name) => {
                seen.push(name);
                b.call('element', 'page', child, 'setCapture', name !== 'onMouseUp');

                return true;
            },
        });
        b.call('element', 'page', root, 'AddChild', child);
        b.call('add', 'page', root);
        assert.equal(ui.input('onMouseDown', 5, 5), true);
        assert.equal(ui.input('onMouseMove', 50, 50, 45, 45), true);
        assert.equal(ui.input('onMouseUp', 50, 50), true);
        assert.deepEqual(seen, ['onFocus', 'onMouseDown', 'onMouseMove', 'onMouseUp']);
        assert.equal(b.call('element', 'page', child, 'isCapture'), false);
        b.call('remove', 'page', root);
        assert.equal(ui.input('onMouseDown', 5, 5), false);
    } finally {
        ui.dispose();
    }
});

test('native focus raises captured roots while consumed children and siblings still release captured controls once', () => {
    for (const placement of ['root', 'child', 'sibling']) {
        const ui = uiFixture();
        const b = ui.bindings;
        const root = b.call('new', 'page', {});
        const drag = placement === 'sibling' ? b.call('new', 'page', {}) : root;
        const consumer = b.call('new', 'page', {});
        const seen = [];
        let moving = false;

        try {
            for (const id of new Set([root, drag, consumer])) {
                b.call('element', 'page', id, 'setWidth', id === root && placement !== 'root' ? 50 : 10);
                b.call('element', 'page', id, 'setHeight', 10);
            }

            b.call('element', 'page', consumer, 'setX', 30);
            ui.setCallbacks(drag, {
                /**
                 * Mirror a titlebar's captured movement and either release callback.
                 *
                 * @param {string} name - Native pointer callback.
                 * @param {number} dx - Move delta, or local release coordinate.
                 * @returns {boolean} Whether this control consumes normal input.
                 */
                input: (name, dx) => {
                    if (name === 'onFocus') {
                        seen.push('drag:onFocus');

                        if (placement === 'root') {
                            b.call('element', 'page', root, 'bringToTop');
                        }
                    } else if (name === 'onMouseDown') {
                        moving = true;
                        b.call('element', 'page', drag, 'setCapture', true);
                    } else if (name === 'onMouseMove' && moving) {
                        b.call('element', 'page', drag, 'setX', b.call('element', 'page', drag, 'getX') + dx);
                    } else if (name === 'onMouseUp' || name === 'onMouseUpOutside') {
                        seen.push(`drag:${name}`);
                        moving = false;
                        b.call('element', 'page', drag, 'setCapture', false);
                    }

                    return true;
                },
            });
            ui.setCallbacks(consumer, {
                /**
                 * Consume the release before the captured recipient is visited.
                 *
                 * @param {string} name - Native pointer callback.
                 * @returns {boolean} Whether this is the targeted release.
                 */
                input: (name) => {
                    if (name === 'onMouseUp') {
                        seen.push(`consumer:${name}`);

                        return true;
                    }

                    return false;
                },
            });

            if (drag !== root) {
                b.call('element', 'page', root, 'AddChild', drag);
            }

            b.call('add', 'page', root);

            if (placement === 'root') {
                b.call('add', 'page', consumer);
                const titlebar = b.call('new', 'page', {});

                b.call('element', 'page', titlebar, 'setWidth', 10);
                b.call('element', 'page', titlebar, 'setHeight', 10);
                b.call('element', 'page', root, 'AddChild', titlebar);
                ui.setCallbacks(titlebar, {
                    /**
                     * Observe root focus before a non-consuming titlebar's press.
                     *
                     * @param {string} name - Native pointer callback.
                     * @returns {boolean} Titlebar defers capture to its page.
                     */
                    input: (name) => {
                        if (name === 'onMouseDown') {
                            assert.deepEqual(seen, ['drag:onFocus']);
                            seen.push('titlebar:onMouseDown');
                        }

                        return false;
                    },
                });
            } else {
                b.call('element', 'page', root, 'AddChild', consumer);
            }

            assert.equal(ui.input('onMouseDown', 5, 5), true, placement);
            assert.equal(ui.input('onMouseMove', 6, 5, 1, 0), true, placement);
            assert.equal(b.call('element', 'page', drag, 'getX'), 1, placement);
            assert.equal(ui.input('onMouseUp', 36, 5), true, placement);
            assert.deepEqual(seen, placement === 'root'
                ? ['drag:onFocus', 'titlebar:onMouseDown', 'drag:onMouseUp']
                : ['drag:onFocus', 'consumer:onMouseUp', 'drag:onMouseUpOutside'], placement);
            assert.equal(b.call('element', 'page', drag, 'isCapture'), false, placement);
            assert.equal(moving, false, placement);
            ui.input('onMouseMove', 80, 70, 10, 65);
            assert.equal(b.call('element', 'page', drag, 'getX'), 1, 'movement after release cannot keep dragging');
        } finally {
            ui.dispose();
        }
    }
});

test('native page traversal nests child rendering and skips collapsed children without stopping hidden updates', () => {
    const ui = uiFixture();
    const b = ui.bindings;
    const seen = [];
    const root = b.call('new', 'page', {});
    const child = b.call('new', 'page', {});

    try {
        for (const [id, label] of [[root, 'page'], [child, 'pane']]) {
            ui.setCallbacks(id, {
                /**
                 * Record original update delivery.
                 *
                 * @returns {void} Records the update callback.
                 */
                update: () => {
                    seen.push(`${label}:update`);
                },
                /**
                 * Record original prerender delivery.
                 *
                 * @returns {void} Records the prerender callback.
                 */
                prerender: () => {
                    seen.push(`${label}:pre`);
                },
                /**
                 * Record original render delivery.
                 *
                 * @returns {void} Records the render callback.
                 */
                render: () => {
                    seen.push(`${label}:render`);
                },
            });
        }

        assert.equal(b.call('element', 'page', root, 'isVisible'), true);
        assert.equal(b.call('element', 'page', root, 'isReallyVisible'), false, 'a newly created root is not in UIManager');
        assert.equal(b.call('element', 'page', child, 'isReallyVisible'), false);
        b.call('element', 'page', root, 'AddChild', child);
        b.call('element', 'page', child, 'setY', 17);
        assert.equal(b.call('element', 'page', child, 'isReallyVisible'), false, 'parent membership alone does not attach the root');
        b.call('add', 'page', root);
        assert.equal(b.call('element', 'page', root, 'isReallyVisible'), true);
        assert.equal(b.call('element', 'page', child, 'isReallyVisible'), true);
        ui.render();
        assert.deepEqual(seen.splice(0), ['page:pre', 'pane:pre', 'pane:render', 'page:render']);
        b.call('element', 'page', root, 'setMaxDrawHeight', 15);
        assert.equal(b.call('element', 'page', child, 'isReallyVisible'), true, 'collapsed draw limits do not change native visibility');
        ui.render();
        assert.deepEqual(seen.splice(0), ['page:pre', 'page:render']);
        b.call('element', 'page', root, 'setVisible', false);
        assert.equal(b.call('element', 'page', root, 'isVisible'), false);
        assert.equal(b.call('element', 'page', child, 'isVisible'), true, 'own visibility is distinct from ancestor visibility');
        assert.equal(b.call('element', 'page', child, 'getIsVisible'), true);
        assert.equal(b.call('element', 'page', child, 'isReallyVisible'), false);
        ui.update();
        assert.deepEqual(seen, ['page:update', 'pane:update']);
        b.call('element', 'page', root, 'setVisible', true);
        b.call('element', 'page', root, 'setEnabled', false);
        assert.equal(b.call('element', 'page', child, 'isReallyVisible'), true, 'enabled state does not change native visibility');
        b.call('element', 'page', child, 'setVisible', false);
        assert.equal(b.call('element', 'page', child, 'isReallyVisible'), false);
        b.call('element', 'page', child, 'setVisible', true);
        b.call('remove', 'page', root);
        assert.equal(b.call('element', 'page', root, 'isVisible'), true);
        assert.equal(b.call('element', 'page', root, 'isReallyVisible'), false);
        assert.equal(b.call('element', 'page', child, 'isReallyVisible'), false);
        b.call('add', 'page', root);
        assert.equal(b.call('element', 'page', child, 'isReallyVisible'), true);
        b.call('element', 'page', root, 'RemoveChild', child);
        assert.equal(b.call('element', 'page', child, 'isVisible'), true);
        assert.equal(b.call('element', 'page', child, 'isReallyVisible'), false);
        b.call('element', 'page', root, 'AddChild', child);
        assert.equal(b.call('element', 'page', child, 'isReallyVisible'), true);
        b.cleanup('page');
        assert.throws(() => b.call('element', 'page', child, 'isReallyVisible'), /session/);
    } finally {
        ui.dispose();
    }
});

test('original collapsed-page input limits preserve titlebar stencil drawing and keep non-scrolling scrollbars fixed', () => {
    const ui = uiFixture();
    const b = ui.bindings;
    const root = b.call('new', 'page', {});
    const row = b.call('new', 'page', {});
    const scrollbar = b.call('new', 'page', {});

    try {
        for (const id of [root, row, scrollbar]) {
            b.call('element', 'page', id, 'setWidth', 40);
            b.call('element', 'page', id, 'setHeight', 40);
        }

        b.call('element', 'page', root, 'AddChild', row);
        b.call('element', 'page', root, 'AddChild', scrollbar);
        b.call('element', 'page', root, 'setScrollChildren', true);
        b.call('element', 'page', root, 'setYScroll', -10);
        b.call('element', 'page', scrollbar, 'setScrollWithParent', false);
        b.call('element', 'page', root, 'setMaxDrawHeight', 15);
        b.call('add', 'page', root);
        assert.equal(b.call('element', 'page', row, 'getAbsoluteY'), -10);
        assert.equal(b.call('element', 'page', scrollbar, 'getAbsoluteY'), 0);
        assert.equal(b.call('element', 'page', row, 'isPointOver', 5, 16), false);
        assert.equal(b.call('element', 'page', row, 'isPointOver', 5, 14), true);
        ui.setCallbacks(root, {
            /** Draw the titlebar's last pixel inside its authored 17-pixel stencil, beyond maxDrawHeight=15. */
            render: () => {
                b.call('element', 'page', root, 'setStencilRect', 0, 0, 40, 17);
                b.call('element', 'page', root, 'DrawTextureScaledColor', null, 0, 26, 40, 1, 1, 1, 1, 1);
                b.call('element', 'page', root, 'clearStencilRect');
            },
        });
        const draw = ui.render().find((command) => command.type !== 'stencil');

        assert.deepEqual([draw.y, draw.height], [16, 1], 'maximum input height must not cull the titlebar border quad');
        b.call('element', 'page', root, 'clearMaxDrawHeight');
        assert.equal(b.call('element', 'page', row, 'isPointOver', 5, 16), true);
    } finally {
        ui.dispose();
    }
});

test('native UI names survive detach and reattach but expire with their owning session elements', () => {
    const ui = uiFixture();
    const b = ui.bindings;
    const id = b.call('new', 'inventory-owner', {});

    try {
        assert.equal(b.call('element', 'inventory-owner', id, 'getUIName'), `UI: ${id}`);
        b.call('element', 'inventory-owner', id, 'setUIName', 'inventory0');
        b.call('add', 'inventory-owner', id);
        b.call('playerInventory', 'inventory-owner', 0, id, null);
        b.call('remove', 'inventory-owner', id);
        assert.equal(b.call('element', 'inventory-owner', id, 'getUIName'), 'inventory0');
        b.call('add', 'inventory-owner', id);
        assert.equal(b.call('element', 'inventory-owner', id, 'getUIName'), 'inventory0');
        assert.throws(() => b.call('element', 'inventory-owner', id, 'setUIName', 0), /UI name/);
        b.cleanup('inventory-owner');
        assert.throws(() => b.call('element', 'inventory-owner', id, 'getUIName'), /session/);
        const replacement = b.call('new', 'inventory-owner', {});

        assert.notEqual(replacement, id);
        assert.equal(b.call('element', 'inventory-owner', replacement, 'getUIName'), `UI: ${replacement}`);
    } finally {
        ui.dispose();
    }
});

test('player UI pairs authenticate registry elements and release references on removal and owner cleanup', () => {
    const ui = uiFixture();
    const otherUI = uiFixture();
    const b = ui.bindings;
    const inventory = b.call('new', 'source', {});
    const loot = b.call('new', 'source', {});
    const tooltip = b.call('new', 'source', {});
    const lootTooltip = b.call('new', 'source', {});
    const foreign = b.call('new', 'other', {});
    const otherRealm = otherUI.bindings.call('new', 'source', {});

    try {
        for (const operation of ['playerInventory', 'playerInventoryTooltip']) {
            assert.throws(() => b.call(operation, 'source', 1, inventory, loot), /player.*zero/i);
            assert.throws(() => b.call(operation, 'source', '0', inventory, loot), /player.*zero/i);
            assert.throws(() => b.call(operation, 'source', 0, inventory), /three arguments/);
            assert.throws(() => b.call(operation, 'source', 0, {}, loot), /UI element/);
            assert.throws(() => b.call(operation, 'source', 0, inventory, 'bad'), /UI element/);
            assert.throws(() => b.call(operation, 'source', 0, inventory, Number.MAX_SAFE_INTEGER), /session/);
            assert.throws(() => b.call(operation, 'source', 0, inventory, foreign), /owner/);
            assert.throws(() => b.call(operation, 'source', 0, inventory, otherRealm), /session/);
            b.call(operation, 'other', 0, null, null);
        }

        b.call('playerInventory', 'source', 0, inventory, loot);
        b.call('playerInventoryTooltip', 'source', 0, tooltip, lootTooltip);
        assert.throws(() => b.call('playerInventory', 'other', 0, null, null), /owner/);
        assert.throws(() => b.call('playerInventoryTooltip', 'other', 0, null, null), /owner/);
        b.call('playerInventory', 'source', 0, null, null);
        b.call('playerInventoryTooltip', 'source', 0, null, null);
        assert.equal(b.call('element', 'source', inventory, 'getX'), 0);
        b.call('playerInventory', 'other', 0, foreign, null);
        b.call('playerInventory', 'other', 0, null, null);

        b.call('element', 'source', inventory, 'AddChild', tooltip);
        b.call('playerInventory', 'source', 0, inventory, null);
        b.call('playerInventoryTooltip', 'source', 0, tooltip, null);
        b.call('remove', 'source', inventory);
        b.call('playerInventory', 'other', 0, null, null);
        b.call('playerInventoryTooltip', 'other', 0, null, null);
        assert.throws(() => b.call('playerInventory', 'source', 0, inventory, null), /removed/);
        b.call('add', 'source', inventory);
        b.call('playerInventoryTooltip', 'other', 0, null, null);
        b.call('playerInventory', 'source', 0, inventory, loot);
        b.call('playerInventoryTooltip', 'source', 0, tooltip, lootTooltip);
        b.call('element', 'source', inventory, 'RemoveChild', tooltip);
        b.call('remove', 'source', lootTooltip);
        b.call('playerInventoryTooltip', 'other', 0, null, null);

        b.cleanup('source');
        b.call('playerInventory', 'other', 0, foreign, null);
        b.call('playerInventoryTooltip', 'other', 0, foreign, null);
        assert.throws(() => b.call('playerInventory', 'source', 0, inventory, null), /session/);
        assert.throws(() => b.call('playerInventoryTooltip', 'source', 0, lootTooltip, null), /session/);
    } finally {
        otherUI.dispose();
        ui.dispose();
    }
});

test('native inventory hover considers registered expanded page pairs and tooltips before unrelated UI', () => {
    const ui = uiFixture();
    const b = ui.bindings;
    const inventory = b.call('new', 'source', {});
    const loot = b.call('new', 'source', {});
    const holder = b.call('new', 'source', {});
    const tooltip = b.call('new', 'source', {});
    const lootTooltip = b.call('new', 'source', {});
    const unrelated = b.call('new', 'other', {});

    try {
        for (const [id, x] of [[inventory, 0], [loot, 20], [holder, 40], [lootTooltip, 60], [unrelated, 80]]) {
            const owner = id === unrelated ? 'other' : 'source';

            b.call('element', owner, id, 'setX', x);
            b.call('element', owner, id, 'setWidth', 10);
            b.call('element', owner, id, 'setHeight', 10);
            b.call('add', owner, id);
        }

        b.call('element', 'source', tooltip, 'setWidth', 10);
        b.call('element', 'source', tooltip, 'setHeight', 10);
        b.call('element', 'source', holder, 'AddChild', tooltip);
        ui.setMouse(5, 2);
        assert.equal(b.call('isMouseOverInventory', 'source'), false);
        assert.throws(() => b.call('isMouseOverInventory', 'source', null), /zero arguments/);
        b.call('playerInventory', 'source', 0, inventory, null);
        assert.equal(b.call('isMouseOverInventory', 'source'), false, 'a missing loot page excludes page hover');
        b.call('playerInventory', 'source', 0, inventory, loot);
        assert.equal(b.call('isMouseOverInventory', 'source'), true);
        b.call('element', 'source', inventory, 'setMaxDrawHeight', 5);
        assert.equal(b.call('element', 'source', inventory, 'isMouseOver'), true);
        assert.equal(b.call('isMouseOverInventory', 'source'), false, 'a collapsed page titlebar does not suppress aiming');
        ui.setMouse(25, 2);
        assert.equal(b.call('isMouseOverInventory', 'source'), true, 'expanded loot is checked separately');
        b.call('element', 'source', loot, 'setMaxDrawHeight', 5);
        assert.equal(b.call('isMouseOverInventory', 'source'), false);
        ui.setMouse(85, 2);
        assert.equal(b.call('element', 'other', unrelated, 'isMouseOver'), true);
        assert.equal(b.call('isMouseOverInventory', 'source'), false, 'unrelated UI is never a generic hover fallback');

        b.call('playerInventory', 'source', 0, null, null);
        b.call('element', 'source', tooltip, 'setMaxDrawHeight', 5);
        b.call('playerInventoryTooltip', 'source', 0, tooltip, lootTooltip);
        ui.setMouse(45, 2);
        assert.equal(b.call('isMouseOverInventory', 'source'), true, 'tooltip hover precedes the missing-page check');
        b.call('element', 'source', holder, 'setVisible', false);
        assert.equal(b.call('isMouseOverInventory', 'source'), false);
        b.call('element', 'source', holder, 'setVisible', true);
        assert.equal(b.call('isMouseOverInventory', 'source'), true);
        b.call('remove', 'source', holder);
        assert.equal(b.call('isMouseOverInventory', 'source'), false, 'ancestor removal clears registered tooltip references');
        ui.setMouse(65, 2);
        assert.equal(b.call('isMouseOverInventory', 'source'), true, 'the other registered tooltip is independent');
        b.call('remove', 'source', lootTooltip);
        assert.equal(b.call('isMouseOverInventory', 'source'), false);
        b.call('element', 'source', inventory, 'clearMaxDrawHeight');
        b.call('element', 'source', loot, 'clearMaxDrawHeight');
        b.call('playerInventory', 'source', 0, inventory, loot);
        ui.setMouse(5, 2);
        b.cleanup('other');
        assert.equal(b.call('isMouseOverInventory', 'source'), true);
        b.cleanup('source');
        assert.equal(b.call('isMouseOverInventory', 'source'), false, 'owner cleanup cannot leave stale hover references');
    } finally {
        ui.dispose();
    }
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

test('inventory tooltip registration preserves retained Lua widgets across remove hide and reattach without phantom hover', async () => {
    const ui = uiFixture();
    const session = await createLuaSession({ ui });

    ui.setMouse(5, 2);
    try {
        const cleanup = session.activatePackage({
            id: 'reusable-tooltip', api: apiFixture(), sources: [{
                path: 'media/lua/client/ReusableTooltip.lua',
                source: `
                    local page={}
                    do
                        local tooltip={clicks=0}
                        function tooltip:render()
                            self.javaObject:DrawTextureScaled(getTexture('icon'),0,0,9,5,1)
                        end
                        function tooltip:onMouseDown()
                            self.clicks=self.clicks+1
                            return true
                        end
                        tooltip.javaObject=UIElement.new(tooltip)
                        tooltip.javaObject:setWidth(10)
                        tooltip.javaObject:setHeight(10)
                        page.toolRender=tooltip
                    end
                    local weak=setmetatable({page.toolRender},{__mode='v'})
                    UIManager.setPlayerInventoryTooltip(0,page.toolRender.javaObject,nil)
                    assert(not UIManager.isMouseOverInventory(),'registration does not attach a new tooltip')
                    UIManager.AddUI(page.toolRender.javaObject)
                    assert(UIManager.isMouseOverInventory())
                    Events.OnPostSave.Add(function()
                        -- Original ISInventoryPane.updateTooltip removes, hides, then registers the same pointer.
                        UIManager.RemoveElement(page.toolRender.javaObject)
                        page.toolRender.javaObject:setVisible(false)
                        UIManager.setPlayerInventoryTooltip(0,page.toolRender.javaObject,nil)
                        collectgarbage('collect')
                        assert(weak[1]==page.toolRender and weak[1].javaObject:getTable()==page.toolRender,
                            'the inventory page must retain its detached native wrapper and callback target')
                        assert(not UIManager.isMouseOverInventory())
                    end)
                    Events.OnLoad.Add(function()
                        assert(page.toolRender.clicks==1,'hidden removed tooltips must not receive input')
                        page.toolRender.javaObject:setVisible(true)
                        UIManager.setPlayerInventoryTooltip(0,page.toolRender.javaObject,nil)
                        assert(not UIManager.isMouseOverInventory(),'visibility alone does not reattach a removed tooltip')
                        UIManager.AddUI(page.toolRender.javaObject)
                        UIManager.setPlayerInventoryTooltip(0,page.toolRender.javaObject,nil)
                        assert(UIManager.isMouseOverInventory())
                    end)
                `,
            }],
        });

        assert.equal(ui.render().length, 1);
        assert.equal(ui.input('onMouseDown', 5, 2), true);
        session.dispatch('OnPostSave');
        assert.deepEqual(ui.render(), []);
        assert.equal(ui.input('onMouseDown', 5, 2), false);
        assert.equal(ui.bindings.call('isMouseOverInventory', 'reusable-tooltip'), false);
        assert.deepEqual(ui.bindings.call('getUI', 'reusable-tooltip'), []);
        session.dispatch('OnLoad');
        assert.equal(ui.render().length, 1, 'the same retained Lua render callback is reusable');
        assert.equal(ui.input('onMouseDown', 5, 2), true);
        cleanup();
        assert.deepEqual(ui.render(), []);
        assert.equal(ui.bindings.call('isMouseOverInventory', 'reusable-tooltip'), false);
        assert.deepEqual(session.diagnostics().errors, []);
    } finally {
        session.close({ discardSaveData: true });
        ui.dispose();
    }
});

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

test('Lua transition consumers fade actual UI quads and stale transition handles expire with package cleanup', async () => {
    let now = 1_000;
    const ui = uiFixture(noop, () => now);
    const session = await createLuaSession({ ui });
    const api = apiFixture();

    try {
        ui.render();
        const cleanup = session.activatePackage({
            id: 'fade-owner', api, sources: [{
                path: 'media/lua/client/fade-owner/main.lua', source: `
                    UITransition.UpdateAll()
                    RetainedFade=UITransition.new()
                    RetainedFade:init(50,false)
                    local widget={render=function(self)
                        RetainedFade:update()
                        self.javaObject:DrawTextureScaledColor(nil,0,0,5,5,1,1,1,RetainedFade:fraction())
                    end}
                    widget.javaObject=UIElement.new(widget)
                    UIManager.AddUI(widget.javaObject)
                `,
            }],
        });

        now = 1_010;
        assert.deepEqual(ui.render(), []);
        now = 1_020;
        assert.equal(ui.render()[0].color.a, Math.fround(0.2));
        cleanup();
        assert.deepEqual(ui.render(), []);
        assert.throws(() => session.activatePackage({
            id: 'fade-stale-consumer', api, sources: [{
                path: 'media/lua/client/fade-stale-consumer/main.lua',
                source: 'RetainedFade:fraction()',
            }],
        }), (cause) => cause.name === 'NativeLuaError' && cause.modId === 'fade-stale-consumer'
            && /transition is not owned by this session/u.test(cause.message));
    } finally {
        session.close({ discardSaveData: true });
        ui.dispose();
    }
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
    const sibling = b.call('new', 'child', {});

    b.call('element', 'parent', parent, 'setX', 10);
    b.call('element', 'child', child, 'setX', 5);
    b.call('element', 'parent', bridge, 'setX', 2);
    b.call('element', 'parent', bridge, 'AddChild', child);
    b.call('element', 'parent', parent, 'AddChild', bridge);
    b.call('element', 'parent', parent, 'AddChild', sibling);
    b.call('add', 'parent', parent);
    const attachments = [];
    const retained = [];

    ui.setCallbacks(child, {
        /**
         * Transfer native ownership without an intervening collectable detached state.
         *
         * @param {boolean} value - Whether the foreign child is attached.
         */
        attached: (value) => {
            attachments.push(value);
        },
        /**
         * Retain the whole foreign boundary before the first ownership edge is severed.
         *
         * @param {number[]} ids - Foreign boundary handles to retain atomically.
         */
        retainRoots: (ids) => {
            assert.deepEqual(attachments, []);
            retained.push(...ids);
        },
        /**
         * Draw the foreign child at its current absolute position.
         *
         * @returns {undefined} Drawing has no query result.
         */
        render: () => b.call('element', 'child', child, 'DrawTextureScaledColor', null, 0, 0, 2, 2, 1, 1, 1, 1),
    });
    ui.setCallbacks(bridge, {
        /**
         * Owned intermediates remain rooted until foreign descendants have transferred ownership.
         *
         * @param {boolean} value - Whether the owned intermediate is attached.
         */
        attached: (value) => {
            if (!value) {
                assert.deepEqual(attachments, [true], 'foreign descendants transfer before their owned ancestor detaches');
            }
        },
    });
    assert.equal(ui.render()[0].x, 17);
    b.cleanup('parent');
    assert.deepEqual(attachments, [true], 'foreign ownership transfers directly from parent to root in one callback');
    assert.deepEqual(retained, [child, sibling], 'the entire foreign boundary is pinned in one entry before cleanup');
    assert.equal(ui.render()[0].x, 17);
    b.cleanup('child');
    assert.deepEqual(ui.render(), []);
    ui.dispose();
});

test('proven registry constants still require the matching authoritative native member', async () => {
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

test('native UI routes outside motion and respects explicit false without losing nil consumption', async () => {
    const ui = uiFixture();
    const session = await createLuaSession({ ui });

    try {
        session.activatePackage({
            id: 'native-pointer', api: apiFixture(), sources: [{
                path: 'media/lua/client/native-pointer.lua',
                source: `
                    local target = { outside = 0 }
                    function target:onMouseMoveOutside(dx, dy)
                        assert(dx == 4 and dy == 2)
                        self.outside = self.outside + 1
                    end
                    function target:onMouseDown() return false end
                    function target:onMouseUp()
                        assert(self.outside == 1)
                    end
                    target.javaObject = UIElement.new(target)
                    target.javaObject:setX(20)
                    target.javaObject:setY(20)
                    target.javaObject:setWidth(30)
                    target.javaObject:setHeight(20)
                    target.javaObject:setConsumeMouseEvents(true)
                    UIManager.AddUI(target.javaObject)
                `,
            }],
        });
        assert.equal(ui.input('onMouseMove', 10, 10, 4, 2), false);
        assert.equal(ui.input('onMouseDown', 25, 25), false);
        assert.equal(ui.input('onMouseUp', 25, 25), true);
    } finally {
        session.close({ discardSaveData: true });
        ui.dispose();
    }
});

test('native source menu down consumes its nil return before lower roots can hide the submenu', async () => {
    const ui = uiFixture();
    const session = await createLuaSession({ ui });

    try {
        session.activatePackage({
            id: 'native-menu-pointer', api: apiFixture(), sources: [{
                path: 'media/lua/client/native-menu-pointer.lua',
                source: `
                    local parent,submenu={}, {selected=0}
                    function parent:onMouseDownOutside()
                        submenu.javaObject:setVisible(false)
                    end
                    parent.javaObject=UIElement.new(parent)
                    parent.javaObject:setWidth(10)
                    parent.javaObject:setHeight(10)
                    UIManager.AddUI(parent.javaObject)
                    function submenu:onMouseDown() end
                    function submenu:onRightMouseDown() return false end
                    function submenu:onMouseUp()
                        assert(self.javaObject:isVisible())
                        self.selected=self.selected+1
                    end
                    submenu.javaObject=UIElement.new(submenu)
                    submenu.javaObject:setX(20)
                    submenu.javaObject:setY(20)
                    submenu.javaObject:setWidth(30)
                    submenu.javaObject:setHeight(20)
                    UIManager.AddUI(submenu.javaObject)
                    Events.OnLoad.Add(function()
                        assert(submenu.selected==1 and submenu.javaObject:isVisible())
                        submenu.javaObject:setConsumeMouseEvents(false)
                    end)
                `,
            }],
        });
        assert.equal(ui.input('onMouseMove', 25, 25, 0, 0), false, 'absent callbacks remain unhandled');
        assert.equal(ui.input('onRightMouseDown', 25, 25), false, 'explicit false still permits fallthrough');
        assert.equal(ui.input('onMouseDown', 25, 25), true, 'native empty down cannot leak into lower menus or world movement');
        assert.equal(ui.input('onMouseUp', 25, 25), true);
        session.dispatch('OnLoad');
        assert.equal(ui.input('onMouseDown', 25, 25), false, 'an explicit consume flag override still permits fallthrough');
        assert.equal(ui.input('onMouseUp', 25, 25), false, 'the lower outside callback really hides the separate submenu root');
    } finally {
        session.close({ discardSaveData: true });
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

        for (const name of ['onMouseDown', 'onMouseUp', 'onMouseDoubleClick', 'onRightMouseDown', 'onRightMouseUp']) {
            assert.equal(ui.input(name, 25, 34), true);
        }

        assert.equal(ui.input('onMouseMove', 5, 4, 25, 34), false);
        assert.equal(ui.input('onMouseWheel', 5, 4, 1), false);
        assert.deepEqual(received, [
            ['onMouseMove', -3, 2],
            ['onMouseWheel', -1],
            ['onFocus', 5, 4],
            ['onMouseDown', 5, 4],
            ['onMouseUp', 5, 4],
            ['onMouseDoubleClick', 5, 4],
            ['onRightMouseDown', 5, 4],
            ['onRightMouseUp', 5, 4],
            ['onMouseMoveOutside', 25, 34],
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

test('source UI stack stays live and preserves native identity, occlusion and owner removal', async () => {
    const ui = uiFixture();
    const session = await createLuaSession({ ui });

    try {
        const cleanup = session.activatePackage({
            id: 'source-stack', api: apiFixture(), sources: [{
                path: 'media/lua/client/SourceStack.lua',
                source: `
                    local stack=UIManager.getUI()
                    assert(type(stack)=='userdata' and stack==UIManager.getUI() and stack:isEmpty())
                    local first,second,child={},{},{}
                    first.javaObject=UIElement.new(first)
                    second.javaObject=UIElement.new(second)
                    child.javaObject=UIElement.new(child)
                    for _,target in ipairs({first,second,child}) do
                        target.javaObject:setWidth(20)
                        target.javaObject:setHeight(20)
                    end
                    local a,b,c=first.javaObject,second.javaObject,child.javaObject
                    a:setUIName('first')
                    b:setUIName('second')
                    UIManager.AddUI(a)
                    UIManager.AddUI(b)
                    UIManager.AddUI(b)
                    assert(stack:size()==2 and stack:get(0)==a and stack:get(1)==b)
                    assert(type(stack:get(0))=='userdata' and instanceof(stack:get(0),'UIElement'))
                    assert(stack:get(0):getTable()==first and stack:get(0):getUIName()=='first')
                    assert(not a:isPointOver(5,5) and b:isPointOver(5,5),'only the front root accepts a point')
                    b:setVisible(false)
                    assert(stack:size()==2 and stack:get(1)==b and not b:isVisible())
                    assert(a:isPointOver(5,5) and not b:isPointOver(5,5))
                    b:setVisible(true)
                    a:bringToTop()
                    assert(stack:get(0)==b and stack:get(1)==a and a:isPointOver(5,5))
                    b:setAlwaysOnTop(true)
                    assert(stack:get(0)==a and stack:get(1)==b and not a:isPointOver(5,5))
                    b:setAlwaysOnTop(false)
                    a:backMost()
                    assert(stack:get(0)==a and stack:get(1)==b)
                    b:AddChild(c)
                    assert(stack:size()==2 and c:isReallyVisible())
                    assert(c:isPointOver(5,5) and not a:isPointOver(5,5))
                    local sibling=UIElement.new({})
                    sibling:setWidth(20);sibling:setHeight(20)
                    b:AddChild(sibling)
                    assert(not c:isPointOver(5,5),'a front consuming sibling blocks the child')
                    sibling:setConsumeMouseEvents(false)
                    assert(c:isPointOver(5,5),'non-consuming siblings do not block source hit queries')
                    b:RemoveChild(sibling)
                    b:setMaxDrawHeight(4)
                    assert(not c:isPointOver(5,5))
                    b:clearMaxDrawHeight()
                    UIManager.RemoveElement(b)
                    assert(stack:size()==1 and stack:get(0)==a and not c:isReallyVisible())
                    assert(a:isPointOver(5,5))
                    UIManager.AddUI(b)
                    assert(stack:size()==2 and stack:get(1)==b and c:isReallyVisible())
                    b:RemoveChild(c)
                    UIManager.AddUI(c)
                    assert(stack:size()==3 and stack:get(2)==c)
                    assert(c:getTable()==child and c:isPointOver(5,5))
                    assert(not pcall(function() stack:get(-1) end))
                    assert(not pcall(function() stack:get(stack:size()) end))
                `,
            }],
        });

        cleanup();
        session.activatePackage({
            id: 'source-stack-observer', api: apiFixture(), sources: [{
                path: 'media/lua/client/SourceStackObserver.lua',
                source: `assert(UIManager.getUI():isEmpty(),'owner teardown must remove its roots from the retained live stack')`,
            }],
        });
        assert.deepEqual(session.diagnostics().errors, []);
    } finally {
        session.close({ discardSaveData: true });
        ui.dispose();
    }
});

test('native UI registration retains anonymous wrappers through Lua GC and releases removed roots', async () => {
    const ui = uiFixture();
    const session = await createLuaSession({ ui });

    try {
        const cleanup = session.activatePackage({
            id: 'anonymous-root', api: apiFixture(), sources: [{
                path: 'media/lua/client/AnonymousRoot.lua',
                source: `
                    AnonymousRootWeak=setmetatable({}, {__mode='v'})
                    UIManager.AddUI(UIElement.new({}))
                    collectgarbage('collect')
                    local stack=UIManager.getUI()
                    assert(stack:size()==1 and type(stack:get(0))=='userdata')
                    AnonymousRootWeak[1]=stack:get(0)
                    UIManager.RemoveElement(stack:get(0))
                    collectgarbage('collect')
                    assert(stack:isEmpty() and AnonymousRootWeak[1]==nil,
                        'detached native identity cache must remain weak')
                    UIManager.AddUI(UIElement.new({}))
                    AnonymousRootWeak[2]=stack:get(0)
                    collectgarbage('collect')
                    assert(AnonymousRootWeak[2]==stack:get(0))
                `,
            }],
        });

        cleanup();
        session.activatePackage({
            id: 'anonymous-root-observer', api: apiFixture(), sources: [{
                path: 'media/lua/client/AnonymousRootObserver.lua',
                source: `
                    collectgarbage('collect')
                    assert(UIManager.getUI():isEmpty() and AnonymousRootWeak[2]==nil,
                        'owner cleanup must release native registration retention')
                `,
            }],
        });
        assert.deepEqual(session.diagnostics().errors, []);
    } finally {
        session.close({ discardSaveData: true });
        ui.dispose();
    }
});

test('Core object color consumes the original mutable float32 ColorInfo without changing world-item tint', async () => {
    const ui = uiFixture();
    const session = await createLuaSession({ ui });

    try {
        session.activatePackage({
            id: 'core-color-info', api: apiFixture(), sources: [{
                path: 'media/lua/client/CoreColorInfo.lua',
                source: `
                    local white=ColorInfo.new()
                    assert(white.r==1 and white.g==1 and white.b==1 and white.a==1)
                    local selected=ColorInfo.new(0.1,0.5,0.75,1)
                    assert(type(selected)=='userdata' and selected.r==string.unpack('f',string.pack('f',0.1)))
                    assert(selected:getR()==selected.r and selected:getG()==selected.g
                        and selected:getB()==selected.b and selected:getA()==selected.a)
                    local core=getCore()
                    core:setObjectHighlitedColor(selected)
                    selected.r=0.9
                    assert(core:getObjectHighlitedColor():getR()==string.unpack('f',string.pack('f',0.1)),
                        'the Core setter copies ColorInfo components instead of retaining caller state')
                    local world=core:getWorldItemHighlightColor()
                    assert(world:getR()==0.5 and world:getG()==1 and world:getB()==1 and world:getA()==1)
                `,
            }],
        });
        assert.deepEqual(session.diagnostics().errors, []);
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

/**
 * Deliver a native key event to one host DOM node.
 *
 * @param {EventTarget} node - Target host node.
 * @param {string} key - Native keyboard key.
 */
function menuKey(node, key) {
    const event = new Event('keydown', { cancelable: true });

    Object.defineProperty(event, 'key', { value: key });
    node.dispatchEvent(event);
}

test('source semantic menus select resident paths, preserve disabled labels, navigate submenus and release owners', async () => {
    const { document, canvas } = menuDocument();
    const ui = createGameUI({ document, focusTarget: canvas });
    const selected = [];
    const errors = [];
    let closed = 0;
    const tree = [
        { name: 'Locked', disabled: true, children: [] },
        { name: 'Trade', disabled: false, children: [{ name: 'Exchange', disabled: false, children: [] }] },
        { name: 'Open', disabled: false, children: [] },
    ];
    const callbacks = {
        owner: 'original',
        /**
         * Close the resident original source menu.
         *
         * @returns {number} Number of native closes observed.
         */
        onClose: () => closed++,
        /**
         * Preserve authoritative callback failures for the host.
         *
         * @param {Error} error - Source callback failure.
         * @returns {number} Number of failures observed.
         */
        onError: (error) => errors.push(error.message),
    };
    const root = ui.sourceMenuMirror(tree, (path) => selected.push(path), callbacks);
    const locked = root.children[0].children[0];
    const trade = root.children[1].children[0];
    const submenu = root.children[1].children[1];
    const exchange = submenu.children[0].children[0];

    assert.equal(root.className, 'sr-only');
    assert.equal(root.getAttribute('role'), 'menu');
    assert.equal(locked.getAttribute('aria-disabled'), 'true');
    assert.equal(trade.getAttribute('aria-label'), 'Trade');
    assert.equal(document.activeElement, trade);
    menuKey(trade, 'End');
    assert.equal(document.activeElement, root.children[2].children[0]);
    assert.equal(trade.tabIndex, -1);
    menuKey(root.children[2].children[0], 'Home');
    assert.equal(document.activeElement, locked);
    menuKey(locked, 'ArrowDown');
    assert.equal(document.activeElement, trade);
    menuKey(locked, 'Enter');
    assert.deepEqual(selected, []);
    menuKey(trade, 'ArrowRight');
    assert.equal(submenu.hidden, false);
    assert.equal(document.activeElement, exchange);
    menuKey(exchange, 'ArrowLeft');
    assert.equal(submenu.hidden, true);
    assert.equal(document.activeElement, trade);
    menuKey(trade, 'ArrowRight');
    menuKey(exchange, 'Enter');
    await Promise.resolve();
    assert.deepEqual(selected, [[1, 0]]);
    tree[1].children[0].name = 'Mutated outside the resident snapshot';
    assert.equal(exchange.getAttribute('aria-label'), 'Exchange');

    // Detached old nodes cannot keep or invoke a replaced resident closure.
    ui.sourceMenuMirror([{ name: 'Failure', disabled: false, children: [] }], () => Promise.resolve().then(() => {
        throw new Error('authoritative source failure');
    }), callbacks);
    menuKey(exchange, 'Enter');
    assert.deepEqual(selected, [[1, 0]]);
    const replacement = document.body.children[1];

    menuKey(replacement.children[0].children[0], 'Enter');
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(errors, ['authoritative source failure']);
    menuKey(replacement.children[0].children[0], 'Escape');
    assert.equal(closed, 1);
    assert.equal(document.body.children.length, 1);
    assert.equal(document.activeElement, canvas);

    ui.sourceMenuMirror(tree, (path) => selected.push(path), callbacks);
    ui.bindings.cleanup('original');
    assert.equal(document.body.children.length, 1);
    ui.sourceMenuMirror(tree, (path) => selected.push(path), callbacks);
    ui.dispose();
    assert.equal(document.body.children.length, 1);
    assert.equal(document.activeElement, canvas);
});

test('source submenu semantics follow native visibility without rebuilding or selecting a callback', () => {
    const { document, canvas } = menuDocument();
    const ui = createGameUI({ document, focusTarget: canvas });
    let selected = 0;
    const root = ui.sourceMenuMirror([
        { name: 'Door', disabled: false, expanded: true, children: [{ name: 'Open Door', disabled: false }] },
    ], () => selected++, { owner: 'source', onClose: noop, onError: noop });
    const door = root.children[0].children[0];
    const submenu = root.children[0].children[1];

    try {
        assert.equal(door.getAttribute('aria-expanded'), 'true');
        assert.equal(submenu.hidden, false);
        ui.sourceMenuVisibility([0], false);
        assert.equal(door.getAttribute('aria-expanded'), 'false');
        assert.equal(submenu.hidden, true);
        ui.sourceMenuVisibility([0], true);
        assert.equal(door.getAttribute('aria-expanded'), 'true');
        assert.equal(submenu.hidden, false);
        assert.equal(selected, 0);
    } finally {
        ui.dispose();
    }
});

test('native null closure restores only menu-owned focus and Escape closes an in-flight selection', async () => {
    const { document, canvas } = menuDocument();
    const ui = createGameUI({ document, focusTarget: canvas });
    const errors = [];
    let closed = 0;
    let finish;
    const pending = new Promise((resolve) => {
        finish = resolve;
    });
    const callbacks = {
        owner: 'resident',
        /**
         * Record native close independently of a pending resident selection.
         *
         * @returns {number} Number of observed closes.
         */
        onClose: () => closed++,
        /**
         * Preserve authoritative failure feedback.
         *
         * @param {Error} error - Source callback failure.
         * @returns {number} Number of recorded failures.
         */
        onError: (error) => errors.push(error.message),
    };
    const root = ui.sourceMenuMirror([{ name: 'Pending', disabled: false }], () => pending, callbacks);

    menuKey(root.children[0].children[0], 'Enter');
    menuKey(root.children[0].children[0], 'Escape');
    assert.equal(closed, 1);
    assert.equal(document.activeElement, canvas);
    finish();
    await pending;
    ui.sourceMenuMirror([{ name: 'Throw', disabled: false }], () => {
        throw new Error('synchronous source failure');
    }, callbacks);
    menuKey(document.body.children[1].children[0].children[0], 'Enter');
    assert.deepEqual(errors, ['synchronous source failure']);
    canvas.focus();
    ui.sourceMenuMirror(null);
    assert.equal(document.activeElement, canvas);
    assert.equal(closed, 1);
    assert.equal(document.body.children.length, 1);
    ui.dispose();
});

test('real trimmed aliases share ownership and preserve native aspect, uniform and natural draw placement', () => {
    let destroyed = 0;
    const ui = uiFixture();
    const b = ui.bindings;

    ui.addTextures([{
        path: 'Item_Authored', aliases: ['media/textures/Item_Authored.png'], width: 3, height: 4,
        widthOrig: 5, heightOrig: 7, offsetX: 1, offsetY: 2,
        /**
         * Release one physical cropped image despite its two source aliases.
         *
         * @returns {number} Previous physical release count.
         */
        destroy: () => destroyed++,
    }]);
    const icon = b.call('texture', 'original', 'Item_Authored');

    assert.equal(b.call('texture', 'original', 'media/textures/Item_Authored.png'), icon);
    assert.deepEqual([icon.widthOrig, icon.heightOrig, icon.offsetX, icon.offsetY], [5, 7, 1, 2]);
    const id = b.call('new', 'original', {});

    b.call('add', 'original', id);
    ui.setCallbacks(id, {
        /** Draw native box-centered trim and native uniform trim-offset placement. */
        render: () => {
            b.call('element', 'original', id, 'DrawTextureScaledAspect', icon, 10, 20, 10, 14, 1, 1, 1, 0.5);
            b.call('element', 'original', id, 'DrawTextureScaledUniform', icon, 30, 20, 2, 1, 1, 1, 1);
        },
    });
    assert.deepEqual(ui.render().map(({ x, y, width, height }) => [x, y, width, height]), [
        [12, 23, 6, 8], [32, 24, 6, 8],
    ]);

    const parent = b.call('new', 'original', {});

    b.call('element', 'original', parent, 'setX', -4.75);
    b.call('element', 'original', parent, 'setY', -3.25);
    b.call('element', 'original', parent, 'setXScroll', 1.5);
    b.call('element', 'original', parent, 'setYScroll', 0.75);
    b.call('element', 'original', id, 'setX', 1.25);
    b.call('element', 'original', id, 'setY', 1.5);
    b.call('element', 'original', id, 'setXScroll', -2.25);
    b.call('element', 'original', id, 'setYScroll', -1.25);
    b.call('element', 'original', parent, 'AddChild', id);
    b.call('add', 'original', parent);
    ui.setCallbacks(id, {
        /** Draw the actual crop at unscaled offsets, then truncate absolute-plus-scroll placement. */
        render: () => {
            b.call('element', 'original', id, 'DrawTexture', icon, 1.5, 0.75, 0.5);
            b.call('element', 'original', id, 'DrawTextureColor', icon, 2.75, 1.25, 0.2, 0.4, 0.6, 0.75);
        },
    });
    /* Original getAbsoluteX/Y truncate each local coordinate and inherited scroll separately.
       Parent scroll is disabled by default: origin=(-4+1,-3+1)=(-3,-2). */
    assert.equal(b.call('element', 'original', parent, 'getScrollChildren'), false);
    assert.equal(b.call('element', 'original', id, 'getScrollWithParent'), true);
    assert.equal(b.call('element', 'original', parent, 'getAbsoluteX'), -4);
    assert.equal(b.call('element', 'original', parent, 'getAbsoluteY'), -3);
    assert.equal(b.call('element', 'original', id, 'getAbsoluteX'), -3);
    assert.equal(b.call('element', 'original', id, 'getAbsoluteY'), -2);
    assert.deepEqual(ui.render().map(({ x, y, width, height, color }) => [x, y, width, height, color]), [
        [-2, 0, 3, 4, { r: 1, g: 1, b: 1, a: 0.5 }],
        [-1, 0, 3, 4, { r: 0.2, g: 0.4, b: 0.6, a: 0.75 }],
    ]);
    b.call('element', 'original', parent, 'setScrollChildren', true);
    // Inherited scroll=(1,0), but own draw scroll remains fractional until renderi truncation.
    assert.equal(b.call('element', 'original', id, 'getAbsoluteX'), -2);
    assert.equal(b.call('element', 'original', id, 'getAbsoluteY'), -2);
    assert.deepEqual(ui.render().map(({ x, y, width, height, color }) => [x, y, width, height, color]), [
        [-1, 0, 3, 4, { r: 1, g: 1, b: 1, a: 0.5 }],
        [0, 0, 3, 4, { r: 0.2, g: 0.4, b: 0.6, a: 0.75 }],
    ]);
    b.call('element', 'original', id, 'setScrollWithParent', false);
    assert.equal(b.call('element', 'original', id, 'getAbsoluteX'), -3);
    assert.equal(b.call('element', 'original', id, 'getAbsoluteY'), -2);
    assert.deepEqual(ui.render().map(({ x, y, width, height, color }) => [x, y, width, height, color]), [
        [-2, 0, 3, 4, { r: 1, g: 1, b: 1, a: 0.5 }],
        [-1, 0, 3, 4, { r: 0.2, g: 0.4, b: 0.6, a: 0.75 }],
    ]);
    b.call('element', 'original', parent, 'setX', 3_000_000_000);
    b.call('element', 'original', parent, 'setY', -3_000_000_000);
    assert.equal(b.call('element', 'original', parent, 'getAbsoluteX'), 2_147_483_647);
    assert.equal(b.call('element', 'original', parent, 'getAbsoluteY'), -2_147_483_648);
    b.call('element', 'original', parent, 'setX', -0.75);
    assert.equal(b.call('element', 'original', parent, 'getAbsoluteX'), 0);
    assert.throws(() => ui.addTextures([{ path: 'Item_Invalid', width: 3, height: 4, widthOrig: 2, heightOrig: 7, offsetX: 1, offsetY: 0 }]), /trim/);
    assert.equal(b.call('texture', 'original', 'Item_Invalid'), null);
    ui.dispose();
    assert.equal(destroyed, 1);
});

test('dynamic icon preparation refuses missing resolver and disposed resource owners', async () => {
    const ui = uiFixture();

    await assert.rejects(ui.ensureItemTextures([]), /resolver unavailable/);
    ui.dispose();
    await assert.rejects(ui.ensureItemTextures([]), /disposed/);
});

test('source translation substitutions retain exact catalog values and context scroll height and stacking are resident', () => {
    const ui = uiFixture();
    const b = ui.bindings;
    const root = b.call('new', 'source', {});
    const other = b.call('new', 'other', {});

    b.call('add', 'source', root);
    b.call('add', 'other', other);
    b.call('element', 'source', root, 'setScrollHeight', 125);
    assert.equal(b.call('element', 'source', root, 'getScrollHeight'), 125);
    assert.equal(b.call('element', 'source', root, 'getIsVisible'), true);
    assert.throws(() => b.call('element', 'source', root, 'setScrollHeight', -1), /negative/);
    const order = [];

    ui.setCallbacks(root, {
        /** Observe original root ordering. */
        render: () => {
            order.push('source');
        },
    });
    ui.setCallbacks(other, {
        /** Observe original sibling ordering. */
        render: () => {
            order.push('other');
        },
    });
    b.call('element', 'source', root, 'bringToTop');
    ui.render();
    assert.deepEqual(order, ['other', 'source']);
    ui.dispose();

    const textUI = createGameUI();

    textUI.initialize({
        textures: [{ path: 'atlas', width: 32, height: 16 }],
        font: { descriptor, atlasPath: 'atlas' },
        translations: {
            instruction: 'Press %1; repeat %1.', 'Authored.Item': 'Authored source name',
            clothing: '%1 %2', ordered: '%2/%1/%2/%%/%9', missing: '%1 %2', nullValue: '[%1]',
            breaks: 'A<br><BR>V<Br><br/> %1', missingBreak: 'A<br>%1 %2',
        },
        settings,
    });
    assert.equal(textUI.bindings.call('text', 'source', 'instruction', 'K'), 'Press K; repeat K.');
    assert.equal(textUI.bindings.call('text', 'source', 'clothing', 'Wet', 'Gloves'), 'Wet Gloves');
    assert.equal(textUI.bindings.call('text', 'source', 'ordered', '%2', 'second', 3, 4, 5, 6, 7, 8, 9), 'second/%2/second/%/9');
    assert.equal(textUI.bindings.call('text', 'source', 'missing', 'first'), '%1 %2', 'native missing arguments retain the whole original format');
    assert.equal(textUI.bindings.call('text', 'source', 'nullValue', null), '[]');
    assert.equal(textUI.bindings.call('textOrNull', 'source', 'clothing', 'Wet', 'Gloves'), 'Wet Gloves');
    assert.equal(textUI.bindings.call('textOrNull', 'source', 'absent', 'ignored'), null);
    assert.equal(textUI.bindings.call('itemName', 'source', 'Authored.Item'), 'Authored source name');
    assert.throws(() => textUI.bindings.call('itemName', 'source', 'Absent.Item'), /translation/);
    assert.equal(textUI.bindings.call('text', 'source', 'breaks', '<br><BR>'), 'A\n\nV<Br><br/> <br><BR>',
        'native translation converts only exact source markers before inserting arguments');
    assert.equal(textUI.bindings.call('textOrNull', 'source', 'breaks', '<br>'), 'A\n\nV<Br><br/> <br>');
    assert.equal(textUI.bindings.call('text', 'source', 'missingBreak', 'first'), 'A\n%1 %2',
        'native missing arguments retain the already-normalized format');
    assert.equal(textUI.bindings.call('itemName', 'source', 'breaks', '<br>'), 'A<br><BR>V<Br><br/> <br>',
        'item names do not pass through Translator.getTextInternal');
    textUI.dispose();
});
