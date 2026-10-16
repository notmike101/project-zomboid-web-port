// Original-game canvas widgets, with accessibility-only DOM semantics for source menus.
const SMALL = 'Small';
// Identifiers never alias elements in a replacement UI session.
let nextUIElementID = 1;
let nextUITransitionID = 1;

/**
 * Normalized, straight-alpha UI tint.
 *
 * @typedef {{r:number,g:number,b:number,a:number}} UIColor
 */
/**
 * Canvas-space bounds or normalized texture coordinates.
 *
 * @typedef {{x:number,y:number,width:number,height:number}} UIRect
 */
/**
 * Imported UI image owned by one initialized session.
 *
 * @typedef {{path:string,aliases?:string[],width:number,height:number,widthOrig?:number,heightOrig?:number,offsetX?:number,offsetY?:number,texture?:GPUTexture,destroy?:()=>void}} UITexture
 */
/**
 * Bitmap glyph placement and advance from the original descriptor.
 *
 * @typedef {{id:number,x:number,y:number,width:number,height:number,xoffset:number,yoffset:number,xadvance:number,page:number,chnl:number}} UIGlyph
 */
/**
 * Validated single-page bitmap font.
 *
 * @typedef {{face:string,size:number,lineHeight:number,base:number,width:number,height:number,page:string,glyphs:Map<number,UIGlyph>,kernings:Map<string,number>}} UIFont
 */
/**
 * Explicit port rendering and scheduler settings.
 *
 * @typedef {{moodleSize:number,fontSizeReal:number,inventoryFont?:'Small'|'Medium'|'Large',cycleContainerKey?:'control'|'shift'|'control+shift'|'command'|'command+shift',doContainerOutline?:boolean,objectHighlight?:UIColor,worldItemHighlight?:UIColor,lockFPS:number,gray:UIColor,goodHighlight:UIColor,badHighlight:UIColor}} UISettings
 */
/**
 * Lua lifecycle and input hooks; nil input uses the element flag and explicit false declines.
 *
 * @typedef {{attached?:(enabled:boolean)=>void,retainRoots?:(ids:number[])=>void,update?:()=>void,prerender?:()=>void,render?:()=>void,input?:(name:string,...args:number[])=>unknown}} UICallbacks
 */
/**
 * Session-local semantic element and its layout/input state.
 *
 * @typedef {{id:number,owner:string,uiName:string,x:number,y:number,width:number,height:number,scrollHeight:number,scrollX:number,scrollY:number,scrollChildren?:boolean,scrollWithParent?:boolean,maxDrawHeight?:number,capture?:boolean,visible:boolean,enabled:boolean,removed:boolean,parent:number|null,children:number[],callbacks:UICallbacks,anchorLeft:boolean,anchorRight:boolean,anchorTop:boolean,anchorBottom:boolean,wantKeyEvents:boolean,consumeMouseEvents:boolean,wantExtraMouseEvents:boolean,forceCursorVisible:boolean,alwaysOnTop:boolean}} UIElement
 */
/**
 * Original UITransition's owner-scoped float32 presentation state.
 *
 * @typedef {{owner:string,duration:number,elapsed:number,frac:number,fadeOut:boolean,ignoreUpdateTime:boolean,updateTimeMs:number}} UITransitionState
 */
/**
 * One clipped, tinted textured or solid quad for immediate GPU submission.
 *
 * @typedef {{type?:undefined,element:number,owner:string,texture:UITexture|null|undefined,x:number,y:number,width:number,height:number,uv:UIRect,color:UIColor,clip:UIRect}} UIQuad
 */
/**
 * Ordered global native stencil operations; rectangles are integer absolute logical pixels.
 *
 * @typedef {{type:'stencil',operation:'set'|'repaint',x:number,y:number,width:number,height:number}|{type:'stencil',operation:'clear'|'suspend'|'resume'}} UIStencil
 */
/**
 * Quads retain their geometry while native GPU stencil operations mask the ordered draws.
 *
 * @typedef {UIQuad|UIStencil} UICommand
 */

/**
 * Validate a finite coordinate or dimension.
 *
 * @param {number} value - Candidate numeric value.
 * @param {string} name - Field name for validation errors.
 * @returns {number} The validated value.
 */
function finite(value, name) {
    if (!Number.isFinite(value)) {
        throw new TypeError(`${name} must be finite`);
    }

    return value;
}

/**
 * Match Java Double.intValue/renderi conversion for an already finite coordinate.
 *
 * @param {number} value - Finite source coordinate or dimension.
 * @returns {number} Saturated int32, without JavaScript's negative zero.
 */
function nativeInteger(value) {
    return Math.max(-2_147_483_648, Math.min(2_147_483_647, Math.trunc(value))) + 0;
}

/**
 * Validate a positive, bounded integer texture or font extent.
 *
 * @param {number} value - Candidate extent in pixels.
 * @param {string} name - Field name for validation errors.
 * @returns {number} The validated extent.
 */
function extent(value, name) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 4_096) {
        throw new RangeError(`${name} must be 1..4096`);
    }

    return value;
}

/**
 * Validate actual image aliases and optional native packed-sprite trim.
 *
 * @param {UITexture[]} entries - Newly uploaded images.
 * @param {Map<string,UITexture>} previous - Existing owned alias map.
 * @returns {Map<string,UITexture>} Independent map; ownership transfers only when committed.
 */
function textureMap(entries, previous) {
    const loaded = new Map(previous);

    for (const t of entries) {
        if (!t || typeof t.path !== 'string' || (t.aliases !== undefined && !Array.isArray(t.aliases))) {
            throw new Error('Invalid UI texture aliases');
        }

        extent(t.width, 'texture width');
        extent(t.height, 'texture height');
        const widthOrig = extent(t.widthOrig ?? t.width, 'original texture width');
        const heightOrig = extent(t.heightOrig ?? t.height, 'original texture height');
        const offsetX = finite(t.offsetX ?? 0, 'texture offset X');
        const offsetY = finite(t.offsetY ?? 0, 'texture offset Y');

        if (offsetX < 0 || offsetY < 0 || offsetX + t.width > widthOrig || offsetY + t.height > heightOrig) {
            throw new Error('Invalid original texture trim geometry');
        }

        const aliases = new Set([t.path, ...(t.aliases ?? [])]);

        const prepared = Object.freeze({ ...t, aliases: Object.freeze([...aliases]), widthOrig, heightOrig, offsetX, offsetY });

        for (const path of aliases) {
            if (typeof path !== 'string' || !path || loaded.has(path)) {
                throw new Error('Duplicate/invalid UI texture path');
            }

            loaded.set(path, prepared);
        }
    }

    return loaded;
}

/**
 * Validate and copy normalized RGBA components.
 *
 * @param {UIColor} value - Candidate color.
 * @returns {UIColor} Independent validated color.
 */
function rgba(value) {
    if (!value || ['r', 'g', 'b', 'a'].some((k) => !Number.isFinite(value[k]) || value[k] < 0 || value[k] > 1)) {
        throw new TypeError('RGBA components must be in 0..1');
    }

    return { r: value.r, g: value.g, b: value.b, a: value.a };
}

/**
 * Intersect two axis-aligned rectangles, retaining zero-area results.
 *
 * @param {UIRect} a - First rectangle.
 * @param {UIRect} b - Second rectangle.
 * @returns {UIRect} Overlapping bounds.
 */
function intersection(a, b) {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);

    return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
}

/**
 * Measure text and optionally visit glyphs using advances and pair kerning.
 *
 * @param {UIFont} font - Chosen source font.
 * @param {string} text - Bounded text containing supported font glyphs.
 * @param {(glyph:UIGlyph,x:number,y:number)=>void} [draw] - Receives each glyph at its pen position.
 * @returns {{width:number,height:number}} Text extent in font pixels.
 */
function layout(font, text, draw) {
    if (typeof text !== 'string' || text.length > 65_536) {
        throw new TypeError('UI text must be a bounded string');
    }

    let x = 0;
    let y = 0;
    let max = 0;
    let previous;

    for (const char of text.replaceAll('\r\n', '\n')) {
        if (char === '\n') {
            max = Math.max(max, x);
            x = 0;
            y += font.lineHeight;
            previous = undefined;
            continue;
        }

        const id = char.codePointAt(0);
        const glyph = font.glyphs.get(id);

        if (!glyph) {
            throw new Error(`Unsupported font glyph U+${id.toString(16)}`);
        }

        if (previous !== undefined) {
            x += font.kernings.get(`${previous}:${id}`) ?? 0;
        }

        draw?.(glyph, x, y);
        x += glyph.xadvance;
        previous = id;
    }

    return { width: Math.max(max, x), height: y + font.lineHeight };
}

/**
 * Parse a single-page, unpacked BMFont text descriptor without substituting fonts.
 * The port uses code-point advances, pair kerning, and lineHeight for newlines;
 * native shaping, alternate locale/scale selection and missing-glyph fallback remain unsupported.
 *
 * @param {string} text - Original descriptor text.
 * @returns {UIFont} Validated glyphs, kerning pairs and source metrics.
 */
function parseBitmapFont(text) {
    if (typeof text !== 'string' || text.length > 4 * 1_024 * 1_024) {
        throw new TypeError('BMFont text descriptor required (maximum 4 MiB)');
    }

    const glyphs = new Map();
    const kernings = new Map();
    let common;
    let info;
    let page;
    let charCount;
    let kerningCount = 0;

    for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) {
            continue;
        }

        const kind = line.trim().split(/\s/, 1)[0];
        const record = {};

        for (const match of line.matchAll(/(\w+)=("[^"]*"|\S+)/g)) {
            record[match[1]] = match[2].startsWith('"') ? match[2].slice(1, -1) : Number(match[2]);
        }

        switch (kind) {
            case 'info': {
                info = record;
                break;
            }
            case 'common': {
                common = record;
                break;
            }
            case 'page': {
                if (page || record.id !== 0) {
                    throw new Error('Unsupported BMFont page (only single page supported)');
                }

                page = record;

                break;
            }
            case 'chars': {
                charCount = record.count;
                break;
            }
            case 'kernings': {
                kerningCount = record.count;
                break;
            }
            case 'char': {
                for (const key of ['id', 'x', 'y', 'width', 'height', 'xoffset', 'yoffset', 'xadvance', 'page', 'chnl']) {
                    if (!Number.isSafeInteger(record[key])) {
                        throw new TypeError(`Malformed BMFont glyph ${key}`);
                    }
                }

                if (record.id < 0 || record.id > 0x10_FF_FF || record.page !== 0) {
                    throw new Error('Unsupported BMFont glyph page/id');
                }

                if (record.chnl !== 15 || glyphs.has(record.id)) {
                    throw new Error('Unsupported BMFont glyph channel or duplicate');
                }

                glyphs.set(record.id, record);

                break;
            }
            case 'kerning': {
                if (!['first', 'second', 'amount'].every((k) => Number.isSafeInteger(record[k]))) {
                    throw new Error('Malformed BMFont kerning');
                }

                const key = `${record.first}:${record.second}`;

                if (kernings.has(key)) {
                    throw new Error('Duplicate BMFont kerning');
                }

                kernings.set(key, record.amount);

                break;
            }

            default: throw new Error(`Unsupported BMFont record ${kind}`);
        }
    }

    if (!common || !info || !page || common.pages !== 1 || common.packed !== 0) {
        throw new Error('Unsupported BMFont page/packed descriptor');
    }

    extent(common.scaleW, 'atlas width');
    extent(common.scaleH, 'atlas height');
    extent(common.lineHeight, 'line height');

    if (!Number.isSafeInteger(common.base) || !Number.isSafeInteger(info.size) || info.size <= 0 || typeof info.face !== 'string' || typeof page.file !== 'string') {
        throw new Error('Malformed BMFont font metrics');
    }

    if (glyphs.size !== charCount || kernings.size !== kerningCount || glyphs.size > 65_536) {
        throw new Error('Malformed BMFont record counts');
    }

    for (const glyph of glyphs.values()) {
        if (glyph.x < 0 || glyph.y < 0 || glyph.width < 0 || glyph.height < 0 || glyph.xadvance < 0 || glyph.x + glyph.width > common.scaleW || glyph.y + glyph.height > common.scaleH) {
            throw new Error('BMFont glyph outside atlas/invalid advance');
        }
    }

    for (const key of kernings.keys()) {
        if (!key.split(':').every((id) => glyphs.has(Number(id)))) {
            throw new Error('BMFont kerning references missing glyph');
        }
    }

    return { face: info.face, size: info.size, lineHeight: common.lineHeight, base: common.base, width: common.scaleW, height: common.scaleH, page: page.file, glyphs, kernings };
}

/**
 * Initialize a native fade, retaining its cached fraction until the next update.
 *
 * @param {UITransitionState} value - Owned source transition.
 * @param {number} duration - Requested float32 duration in milliseconds.
 * @param {boolean} fadeOut - Original direction flag.
 */
function initTransition(value, duration, fadeOut) {
    if (typeof fadeOut !== 'boolean') {
        throw new TypeError('UI transition direction must be boolean');
    }

    value.duration = Math.max(Math.fround(finite(duration, 'UI transition duration')), 1);
    value.elapsed = value.frac >= 1
        ? 0
        : Math.fround(
                (value.fadeOut !== fadeOut ? Math.fround(1 - value.frac) : value.frac) * value.duration,
            );
    value.fadeOut = fadeOut;
}

/**
 * Own one isolated Lua UI session. Resource ownership transfers only after initialize succeeds.
 * Commands are reused each render; consumers must submit them before the next render.
 *
 * @param {{viewport?:()=>{width:number,height:number},mouse?:()=>{x:number,y:number},now?:()=>number,document?:Document,focusTarget?:HTMLElement,storage?:Storage,onDispose?:()=>void}} [options] - Canvas bounds/input, UI-frame wall clock, semantic DOM host, origin-local Core options and ownership release.
 * @returns {object} Semantic tree, native bindings, input, draw collection and disposal.
 */
function createGameUI(options = {}) {
    const elements = new Map();
    /** @type {Map<number,UITransitionState>} */
    const transitions = new Map();
    let transitionTimeMs = 0;
    let transitionElapsedMs = 0;
    const roots = [];
    const commands = [];
    const playerUI = { playerInventory: [null, null], playerInventoryTooltip: [null, null] };
    const worldHighlights = new Map();
    const worldHighlightOwners = new WeakMap();
    let textures = new Map();
    let indexedTextures = new Set();
    let fonts = new Map();
    let translations;
    let settings;
    let disposed = false;
    let viewport = null;
    let mouse = { x: -1, y: -1 };
    let sourceMenu = null;
    let loadItemTextures = null;
    let itemPreparation = Promise.resolve();

    /**
     * Reject operations after this session has released its resources.
     */
    function live() {
        if (disposed) {
            throw new Error('Game UI is disposed');
        }
    }

    /**
     * Require a live session with initialized font and texture resources.
     */
    function ready() {
        live();

        if (!fonts.size) {
            throw new Error('Unsupported UI capability: resources are not initialized');
        }
    }

    /**
     * Resolve and validate current logical canvas dimensions.
     *
     * @returns {{width:number,height:number}} Positive canvas dimensions.
     */
    function view() {
        const value = options.viewport?.() ?? viewport;

        if (!value || !Number.isFinite(value.width) || !Number.isFinite(value.height) || value.width <= 0 || value.height <= 0) {
            throw new Error('Unsupported UI capability: actual canvas viewport required');
        }

        return value;
    }

    /**
     * Advance the shared transition clock once per actual UI render or explicit original UpdateAll call.
     */
    function updateTransitions() {
        const now = Math.trunc(finite((options.now ?? Date.now)(), 'UI transition clock'));

        transitionElapsedMs = now - transitionTimeMs;
        transitionTimeMs = now;
    }

    /**
     * Dispatch the original transition methods against session-owned state.
     *
     * @param {number} id - Native transition identity.
     * @param {string} name - Original method name.
     * @param {...(number|boolean)} args - Method-specific duration, direction or elapsed value.
     * @returns {number|undefined} Native query result or void mutation.
     */
    function transition(id, name, ...args) {
        const value = transitions.get(id);

        if (!value) {
            throw new Error('UI transition is not owned by this session');
        }

        switch (name) {
            case 'init': initTransition(value, args[0], args[1]);

                return;
            case 'update':
                if (!value.ignoreUpdateTime && value.updateTimeMs !== 0
                    && value.updateTimeMs + Math.trunc(value.duration) < transitionTimeMs) {
                    value.elapsed = value.duration;
                }

                value.updateTimeMs = transitionTimeMs;
                value.frac = Math.fround(value.elapsed / value.duration);
                value.elapsed = Math.min(Math.fround(value.elapsed + Math.fround(transitionElapsedMs)), value.duration);

                return;
            case 'fraction': return value.fadeOut ? Math.fround(1 - value.frac) : value.frac;
            case 'setFadeIn':
                if (typeof args[0] !== 'boolean') {
                    throw new TypeError('UI transition fade-in flag must be boolean');
                }

                if (args[0] && value.fadeOut) {
                    initTransition(value, 100, false);
                } else if (!args[0] && !value.fadeOut) {
                    initTransition(value, 200, true);
                }

                return;
            case 'reset': value.elapsed = 0;

                return;
            case 'getElapsed': return value.elapsed;
            case 'setElapsed': value.elapsed = Math.fround(finite(args[0], 'UI transition elapsed'));

                return;
            case 'setIgnoreUpdateTime':
                if (typeof args[0] !== 'boolean') {
                    throw new TypeError('UI transition ignore-update-time flag must be boolean');
                }

                value.ignoreUpdateTime = args[0];

                return;
            default: throw new Error(`Unsupported UITransition:${name}`);
        }
    }

    /**
     * Resolve native integer absolute coordinates through the gated parent scroll chain.
     *
     * @param {UIElement} e - Element whose origin is needed.
     * @returns {{x:number,y:number}} Absolute origin in logical canvas pixels.
     */
    function position(e) {
        const x = nativeInteger(e.x);
        const y = nativeInteger(e.y);

        if (!e.parent) {
            return { x, y };
        }

        const parent = elements.get(e.parent);
        const p = position(parent);

        const scroll = parent.scrollChildren === true && e.scrollWithParent !== false;

        return { x: p.x + (scroll ? nativeInteger(parent.scrollX) : 0) + x, y: p.y + (scroll ? nativeInteger(parent.scrollY) : 0) + y };
    }

    /**
     * Check visibility and removal state through every ancestor.
     *
     * @param {UIElement|undefined} e - Element, or a missing lookup result.
     * @returns {boolean|undefined} Visible active state, or undefined for a missing element.
     */
    function active(e) {
        return e && e.visible && !e.removed && (!e.parent || active(elements.get(e.parent)));
    }

    /**
     * Match native isReallyVisible: visible ancestors and actual child/root membership.
     *
     * @param {UIElement|undefined} e - Element whose attachment chain is queried.
     * @returns {boolean} Whether the visible chain reaches a UIManager root.
     */
    function reallyVisible(e) {
        if (!e || !e.visible) {
            return false;
        }

        if (!e.parent) {
            return roots.includes(e.id);
        }

        const parent = elements.get(e.parent);

        return !!parent && parent.children.includes(e.id) && reallyVisible(parent);
    }

    /**
     * Resolve canvas bounds, optionally intersecting native ancestor input-height limits.
     *
     * @param {UIElement} e - Element whose clipping bounds are needed.
     * @param {boolean} [forInput=false] - Apply native maximum-height input bounds, not draw scissoring.
     * @returns {UIRect} Absolute clipping rectangle.
     */
    function clip(e, forInput = false) {
        const v = view();
        let result = { x: 0, y: 0, width: v.width, height: v.height };

        if (forInput && e.parent) {
            result = clip(elements.get(e.parent), forInput);
        }

        if (forInput && e.maxDrawHeight !== undefined && e.maxDrawHeight >= 0) {
            const p = position(e);

            result = intersection(result, { x: p.x, y: p.y, width: e.width, height: Math.min(e.height, e.maxDrawHeight) });
        }

        return result;
    }

    /**
     * Snapshot roots in normal then always-on-top drawing order.
     *
     * @returns {number[]} Ordered root identifiers.
     */
    function ordered() {
        return roots.filter((id) => !elements.get(id)?.alwaysOnTop).concat(roots.filter((id) => elements.get(id)?.alwaysOnTop));
    }

    /**
     * Test visible native bounds before stack occlusion.
     *
     * @param {UIElement} e - Registry element.
     * @param {number} x - Absolute pointer X.
     * @param {number} y - Absolute pointer Y.
     * @returns {boolean} Whether the point lies in the visible bounds.
     */
    function containsPoint(e, x, y) {
        const p = position(e);
        const c = clip(e, true);
        const height = e.maxDrawHeight === undefined || e.maxDrawHeight === -1 ? nativeInteger(e.height) : Math.min(nativeInteger(e.height), e.maxDrawHeight);

        return !!(active(e) && x >= p.x && y >= p.y && x < p.x + e.width && y < p.y + height && x >= c.x && y >= c.y && x < c.x + c.width && y < c.y + c.height);
    }

    /**
     * Match UIElement.isPointOver: front roots, consuming siblings, then parent.
     *
     * @param {UIElement} e - Registry element.
     * @param {number} x - Absolute pointer X.
     * @param {number} y - Absolute pointer Y.
     * @returns {boolean} Whether this element owns the point in the live stack.
     */
    function pointOver(e, x, y) {
        if (!containsPoint(e, x, y)) {
            return false;
        }

        const parent = e.parent ? element(e.parent) : null;
        const siblings = parent ? parent.children : ordered();
        const index = siblings.indexOf(e.id);

        for (let i = siblings.length - 1; i > index; i -= 1) {
            const sibling = element(siblings[i]);

            if ((!parent || sibling.consumeMouseEvents) && containsPoint(sibling, x, y)) {
                return false;
            }
        }

        return !parent || pointOver(parent, x, y);
    }

    /**
     * Invoke updates or the original nested prerender/children/render sequence.
     *
     * @param {number} id - Session-local element identifier.
     * @param {'update'|'draw'} phase - Lifecycle phase to invoke.
     */
    function visit(id, phase) {
        const e = elements.get(id);

        if (!e || e.removed || !e.enabled || (phase === 'draw' && !active(e))) {
            return;
        }

        const parent = e.parent ? elements.get(e.parent) : null;

        if (phase === 'draw' && parent?.maxDrawHeight !== undefined && parent.maxDrawHeight !== -1 && parent.maxDrawHeight <= e.y) {
            return;
        }

        e.callbacks[phase === 'draw' ? 'prerender' : 'update']?.();

        if (e.removed || !e.enabled || (phase === 'draw' && !active(e))) {
            return;
        }

        for (const child of [...e.children]) {
            if (elements.get(child)?.parent === id) {
                visit(child, phase);
            }
        }

        if (phase === 'draw' && active(e)) {
            e.callbacks.render?.();
        }
    }

    /**
     * Resolve an explicitly loaded original font, defaulting to Small.
     *
     * @param {string|null|undefined} token - Original font enum name.
     * @returns {UIFont & {atlas:UITexture}} Initialized bitmap font and atlas.
     */
    function getFont(token) {
        ready();
        const font = fonts.get(token ?? SMALL);

        if (!font) {
            throw new Error(`Unsupported font ${token}`);
        }

        return font;
    }

    /**
     * Queue a visible clipped quad with validated bounds and tint.
     *
     * @param {UIElement} e - Drawing element.
     * @param {UITexture|null|undefined} texture - Imported image, or no image for a solid fill.
     * @param {number} x - Element-relative horizontal origin before scrolling.
     * @param {number} y - Element-relative vertical origin before scrolling.
     * @param {number} width - Quad width in logical pixels.
     * @param {number} height - Quad height in logical pixels.
     * @param {number} [r=1] - Normalized red tint.
     * @param {number} [g=1] - Normalized green tint.
     * @param {number} [b=1] - Normalized blue tint.
     * @param {number} [a=1] - Normalized opacity.
     * @param {UIRect} [uv] - Normalized texture sampling rectangle, defaulting to the full image.
     */
    function quad(e, texture, x, y, width, height, r = 1, g = 1, b = 1, a = 1, uv = { x: 0, y: 0, width: 1, height: 1 }) {
        if (!active(e)) {
            return;
        }

        for (const v of [x, y, width, height]) {
            finite(v, 'draw bounds');
        }

        x += e.scrollX;
        y += e.scrollY;
        const color = rgba({ r, g, b, a });

        if (width <= 0 || height <= 0 || a === 0) {
            return;
        }

        if (texture && textures.get(texture.path) !== texture) {
            throw new Error('UI texture is not a preloaded resource');
        }

        const p = position(e);
        const c = clip(e);

        if (intersection(c, { x: p.x + x, y: p.y + y, width, height }).width === 0 || intersection(c, { x: p.x + x, y: p.y + y, width, height }).height === 0) {
            return;
        }

        commands.push({ element: e.id, owner: e.owner, texture, x: p.x + x, y: p.y + y, width, height, uv, color, clip: c });
    }

    /**
     * Native renderi converts absolute positions and trim dimensions toward zero.
     *
     * @param {UIElement} e - Drawing element.
     * @param {UITexture} texture - Actual source texture.
     * @param {number} x - Relative origin X.
     * @param {number} y - Relative origin Y.
     * @param {number} width - Trimmed draw width.
     * @param {number} height - Trimmed draw height.
     * @param {...number} color - Native normalized RGBA.
     */
    function integerQuad(e, texture, x, y, width, height, ...color) {
        const p = position(e);

        quad(e, texture,
            nativeInteger(p.x + e.scrollX + finite(x, 'draw X')) - p.x - e.scrollX,
            nativeInteger(p.y + e.scrollY + finite(y, 'draw Y')) - p.y - e.scrollY,
            nativeInteger(finite(width, 'draw width')), nativeInteger(finite(height, 'draw height')), ...color);
    }

    /**
     * Look up an element owned by this live session.
     *
     * @param {number} id - Session-local identifier.
     * @returns {UIElement} Existing semantic element.
     */
    function element(id) {
        live();
        const e = elements.get(id);

        if (!e) {
            throw new Error('UI element is not owned by this session');
        }

        return e;
    }

    /**
     * Resolve a live owned UIElement, allowing reusable detached tooltip references.
     *
     * @param {number|null|undefined} id - Actual native identifier, or Lua nil.
     * @param {string} owner - Calling package identifier.
     * @param {boolean} [allowDetached=false] - Tooltip registration does not imply UIManager attachment.
     * @returns {UIElement|null} Authenticated registry reference without copying.
     */
    function playerElement(id, owner, allowDetached = false) {
        if (id === null || id === undefined) {
            return null;
        }

        if (!Number.isSafeInteger(id) || id <= 0) {
            throw new TypeError('Player UI requires an actual UI element identifier');
        }

        const e = element(id);

        if (e.owner !== owner) {
            throw new Error('Player UI element belongs to another owner');
        }

        for (let parent = e; parent; parent = parent.parent ? element(parent.parent) : null) {
            if (parent.removed && !allowDetached) {
                throw new Error('Player UI element is removed');
            }
        }

        return e;
    }

    /**
     * Release player references before detaching an element or its descendants.
     *
     * @param {UIElement} e - Registry element being removed.
     */
    function clearPlayerElement(e) {
        for (const pair of [playerUI.playerInventory, playerUI.playerInventoryTooltip]) {
            if (pair[0] === e) {
                pair[0] = null;
            }

            if (pair[1] === e) {
                pair[1] = null;
            }
        }

        for (const id of e.children) {
            const child = elements.get(id);

            if (child) {
                clearPlayerElement(child);
            }
        }
    }

    /**
     * Propagate parent size changes using each child's anchor flags.
     *
     * @param {UIElement} e - Resized parent.
     * @param {number} dx - Parent width change in pixels.
     * @param {number} dy - Parent height change in pixels.
     */
    function resizeChildren(e, dx, dy) {
        for (const id of [...e.children]) {
            const child = element(id);
            const previousWidth = child.width;
            const previousHeight = child.height;

            if (child.anchorRight) {
                if (child.anchorLeft) {
                    child.width = Math.max(0, child.width + dx);
                } else {
                    child.x += dx;
                }
            }

            if (child.anchorBottom) {
                if (child.anchorTop) {
                    child.height = Math.max(0, child.height + dy);
                } else {
                    child.y += dy;
                }
            }

            resizeChildren(child, child.width - previousWidth, child.height - previousHeight);
        }
    }

    /**
     * Dispatch a supported native UIElement method.
     *
     * @param {number} id - Session-local target identifier.
     * @param {string} name - Native method name.
     * @param {...(number|string|boolean|UITexture|null|undefined)} args - Method-specific coordinates, flags, text, font selector or texture.
     * @returns {number|string|null|boolean|undefined} Getter result; mutating and drawing methods return undefined.
     */
    function method(id, name, ...args) {
        const e = element(id);
        const property = { X: 'x', Y: 'y', Width: 'width', Height: 'height', ScrollHeight: 'scrollHeight', XScroll: 'scrollX', YScroll: 'scrollY', AnchorLeft: 'anchorLeft', AnchorRight: 'anchorRight', AnchorTop: 'anchorTop', AnchorBottom: 'anchorBottom', Visible: 'visible', Enabled: 'enabled', WantKeyEvents: 'wantKeyEvents', ConsumeMouseEvents: 'consumeMouseEvents', WantExtraMouseEvents: 'wantExtraMouseEvents', ForceCursorVisible: 'forceCursorVisible', AlwaysOnTop: 'alwaysOnTop' };
        const suffix = name.slice(3);
        const key = property[suffix];

        if (key && name.startsWith('get')) {
            return e[key];
        }

        if (key && name.startsWith('set')) {
            const value = ['x', 'y', 'width', 'height', 'scrollHeight', 'scrollX', 'scrollY'].includes(key) ? finite(args[0], name) : Boolean(args[0]);

            if ((key === 'width' || key === 'height' || key === 'scrollHeight') && value < 0) {
                throw new RangeError('UI size cannot be negative');
            }

            const previous = e[key];

            e[key] = value;

            if (key === 'width' || key === 'height') {
                resizeChildren(e, key === 'width' ? value - previous : 0, key === 'height' ? value - previous : 0);
            }

            return;
        }

        switch (name) {
            case 'getUIName': return e.uiName || (typeof args[0] === 'string' ? args[0] : `UI: ${e.id}`);
            case 'setUIName': {
                if (args[0] !== null && args[0] !== undefined && typeof args[0] !== 'string') {
                    throw new TypeError('UI name must be a string or null');
                }

                e.uiName = args[0] ?? '';

                return;
            }
            case 'setCapture': e.capture = Boolean(args[0]);

                return;
            case 'isCapture': return e.capture === true;
            case 'getScrollChildren': return e.scrollChildren === true;
            case 'getScrollWithParent': return e.scrollWithParent !== false;
            case 'setScrollChildren': e.scrollChildren = Boolean(args[0]);

                return;
            case 'setScrollWithParent': e.scrollWithParent = Boolean(args[0]);

                return;
            case 'getMaxDrawHeight': return e.maxDrawHeight ?? -1;
            case 'setMaxDrawHeight': e.maxDrawHeight = Math.trunc(finite(args[0], 'maximum draw height'));

                return;
            case 'clearMaxDrawHeight': e.maxDrawHeight = -1;

                return;
            case 'getAbsoluteX': return position(e).x;
            case 'getAbsoluteY': return position(e).y;
            case 'getIsVisible': case 'isVisible': return e.visible;
            case 'isReallyVisible': return reallyVisible(e);
            case 'isEnabled': return e.enabled;
            case 'isMouseOver': {
                const m = options.mouse?.() ?? mouse;

                return method(id, 'isPointOver', m.x, m.y);
            }
            case 'isPointOver': return pointOver(e, args[0], args[1]);
            case 'setStencilRect': case 'repaintStencilRect': {
                const p = position(e);

                commands.push({
                    type: 'stencil', operation: name === 'setStencilRect' ? 'set' : 'repaint',
                    x: nativeInteger(p.x + finite(args[0], 'clip x')),
                    y: nativeInteger(p.y + finite(args[1], 'clip y')),
                    width: nativeInteger(finite(args[2], 'clip width')),
                    height: nativeInteger(finite(args[3], 'clip height')),
                });

                return;
            }
            case 'clearStencilRect': commands.push({ type: 'stencil', operation: 'clear' });

                return;
            case 'suspendStencil': commands.push({ type: 'stencil', operation: 'suspend' });

                return;
            case 'resumeStencil': commands.push({ type: 'stencil', operation: 'resume' });

                return;
            case 'AddChild': {
                const child = element(args[0]);

                if (child === e) {
                    throw new Error('UI child cycle');
                }

                for (let p = e; p; p = p.parent ? element(p.parent) : null) {
                    if (p === child) {
                        throw new Error('UI child cycle');
                    }
                }

                if (child.parent) {
                    method(child.parent, 'RemoveChild', child.id);
                }

                const index = roots.indexOf(child.id);

                if (index !== -1) {
                    roots.splice(index, 1);
                }

                child.parent = id;
                child.removed = false;
                e.children.push(child.id);
                // Only UI roots pin wrappers; their private Lua ownership graph retains children.
                child.callbacks.attached?.(false);

                return;
            }
            case 'RemoveChild': {
                const child = element(args[0]);

                if (child.parent === id) {
                    clearPlayerElement(child);
                    e.children.splice(e.children.indexOf(child.id), 1);
                    child.parent = null;
                    child.removed = true;
                    child.callbacks.attached?.(false);
                }

                return;
            }
            case 'bringToTop': {
                const siblings = e.parent ? element(e.parent).children : roots;
                const index = siblings.indexOf(id);

                if (index !== -1) {
                    siblings.splice(index, 1);
                    siblings.push(id);
                }

                return;
            }
            case 'backMost': {
                const index = roots.indexOf(id);

                if (index !== -1) {
                    roots.splice(index, 1);
                    roots.unshift(id);
                }

                return;
            }
            case 'DrawTextureScaled': return quad(e, args[0], args[1], args[2], args[3], args[4], 1, 1, 1, args[5] ?? 1);
            case 'DrawTextureScaledColor': return quad(e, ...args);
            case 'DrawTextureScaledUniform': {
                const [t, x, y, scale, r, g, b, a] = args;

                if (!t) {
                    throw new Error('Uniform draw requires a texture');
                }

                return integerQuad(e, t, x + t.offsetX * scale, y + t.offsetY * scale, t.width * scale, t.height * scale, r, g, b, a);
            }
            case 'DrawTextureScaledAspect': {
                const [t, x, y, width, height, r, g, b, a] = args;

                if (!t) {
                    throw new Error('Aspect draw requires an original texture');
                }

                finite(width, 'aspect width');
                finite(height, 'aspect height');
                const scale = Math.min(width / t.widthOrig, height / t.heightOrig);
                const drawWidth = t.width * scale;
                const drawHeight = t.height * scale;

                return integerQuad(e, t, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight, r, g, b, a);
            }
            case 'DrawTexture': {
                const [t, x, y, a] = args;

                if (!t) {
                    throw new Error('Unscaled draw requires a texture');
                }

                return integerQuad(e, t, x + t.offsetX, y + t.offsetY, t.width, t.height, 1, 1, 1, a);
            }
            case 'DrawTextureColor': {
                const [t, x, y, r, g, b, a] = args;

                if (!t) {
                    throw new Error('Unscaled draw requires a texture');
                }

                return integerQuad(e, t, x + t.offsetX, y + t.offsetY, t.width, t.height, r, g, b, a);
            }
            case 'DrawTextRight': case 'DrawTextCentre': case 'DrawText': {
                const [token, text, x, y, r, g, b, a] = args;

                const font = getFont(token);
                const metrics = layout(font, text);
                let alignment = 0;

                if (name === 'DrawTextRight') {
                    alignment = metrics.width;
                } else if (name === 'DrawTextCentre') {
                    alignment = metrics.width / 2;
                }

                const start = x - alignment;

                layout(font, text, (glyph, gx, gy) => {
                    if (glyph.width && glyph.height) {
                        quad(e, font.atlas, start + gx + glyph.xoffset, y + gy + glyph.yoffset, glyph.width, glyph.height, r, g, b, a, { x: glyph.x / font.width, y: glyph.y / font.height, width: glyph.width / font.width, height: glyph.height / font.height });
                    }
                });

                return;
            }

            default: throw new Error(`Unsupported UIElement:${name}`);
        }
    }

    /**
     * Withdraw the semantic menu and its resident callbacks, restoring only owned focus.
     */
    function clearSourceMenu() {
        const previous = sourceMenu;

        if (!previous) {
            return;
        }

        sourceMenu = null;
        const restore = previous.root.contains(previous.document.activeElement);

        previous.root.remove();
        previous.select = null;
        previous.onClose = null;
        previous.onError = null;

        if (restore) {
            const target = previous.focus?.isConnected ? previous.focus : options.focusTarget;

            if (target?.isConnected) {
                target.focus();
            }
        }
    }

    /**
     * Mirror only actual original source options; the resident callback owns all actions.
     *
     * @param {Array<{name:string,disabled:boolean,children?:Array}>|null} tree - Current visible source option tree, or null to close.
     * @param {(path:number[])=>unknown} [select] - Guarded original Lua selection by zero-based path.
     * @param {{owner?:string,onClose?:()=>unknown,onError?:(error:unknown)=>void}} [callbacks] - Resident owner, native close and synchronous authoritative error feedback.
     * @returns {HTMLElement|undefined} Accessibility-only menu root, if open.
     */
    function sourceMenuMirror(tree, select, callbacks = {}) {
        if (tree === null) {
            clearSourceMenu();

            return;
        }

        live();
        const document = options.document ?? globalThis.document;

        if (!document?.body || typeof select !== 'function' || typeof callbacks.onError !== 'function' || typeof callbacks.onClose !== 'function') {
            throw new Error('Source menu requires a DOM host and resident selection, close and error callbacks');
        }

        let count = 0;

        /**
         * Pin a bounded independent snapshot while preserving exact labels and option indices.
         *
         * @param {Array} nodes - Source options at this level.
         * @param {number} depth - Current submenu depth.
         * @returns {Array} Validated, detached nodes.
         */
        function snapshot(nodes, depth) {
            if (!Array.isArray(nodes) || depth > 16) {
                throw new Error('Invalid source menu tree/depth');
            }

            return nodes.map((node) => {
                if (++count > 4_096 || !node || typeof node.name !== 'string' || node.name.length > 4_096 || typeof node.disabled !== 'boolean') {
                    throw new Error('Invalid source menu option');
                }

                return { name: node.name, disabled: node.disabled, expanded: node.expanded === true, children: snapshot(node.children ?? [], depth + 1) };
            });
        }

        const pinned = snapshot(tree, 0);

        clearSourceMenu();
        const root = document.createElement('div');
        const state = { root, document, owner: callbacks.owner, focus: document.activeElement, select, onClose: callbacks.onClose, onError: callbacks.onError, pending: false, submenus: new Map() };

        root.className = 'sr-only';
        root.dataset.sourceContextMenu = '';
        sourceMenu = state;

        /**
         * Route synchronous and asynchronous resident failures to authoritative host feedback.
         *
         * @param {((path:number[])=>unknown)|(()=>unknown)} callback - Current guarded source selection or close callback.
         * @param {...number[]} args - Original zero-based selection path, if selecting.
         */
        function invoke(callback, ...args) {
            if (sourceMenu !== state || (callback === state.select && state.pending)) {
                return;
            }

            const report = state.onError;

            state.pending = true;

            try {
                const result = callback(...args);

                void Promise.resolve(result).then(
                    () => {
                        state.pending = false;
                    },
                    (error) => {
                        state.pending = false;
                        report(error);
                    },
                );
            } catch (error) {
                state.pending = false;
                report(error);
            }
        }

        /**
         * Build nested menu roles and native keyboard behavior without visible replacement UI.
         *
         * @param {HTMLElement} menu - Host menu container.
         * @param {Array} nodes - Snapshot options at this level.
         * @param {number[]} path - Source index prefix.
         * @param {string} label - Accessible source menu label.
         * @param {HTMLElement|null} parent - Parent menuitem for submenu navigation.
         * @returns {HTMLElement[]} Focusable items at this level.
         */
        function build(menu, nodes, path, label, parent) {
            menu.setAttribute('role', 'menu');
            menu.setAttribute('aria-label', label);
            const items = [];

            for (const [index, node] of nodes.entries()) {
                const row = document.createElement('div');
                const item = document.createElement('div');
                const itemPath = [...path, index];

                row.setAttribute('role', 'none');
                item.setAttribute('role', 'menuitem');
                item.setAttribute('aria-label', node.name);
                item.setAttribute('aria-disabled', String(node.disabled));
                item.textContent = node.name;
                item.tabIndex = -1;
                row.append(item);
                menu.append(row);
                items.push(item);
                item.addEventListener('focus', () => {
                    for (const peer of items) {
                        peer.tabIndex = peer === item ? 0 : -1;

                        if (peer !== item && peer.parentNode.children[1]) {
                            peer.parentNode.children[1].hidden = true;
                            peer.setAttribute('aria-expanded', 'false');
                        }
                    }
                });
                let submenu = null;
                let childItems = [];

                if (node.children.length) {
                    submenu = document.createElement('div');
                    submenu.hidden = !node.expanded;
                    item.setAttribute('aria-haspopup', 'menu');
                    item.setAttribute('aria-expanded', String(node.expanded));
                    state.submenus.set(itemPath.join('/'), { item, submenu });
                    row.append(submenu);
                    childItems = build(submenu, node.children, itemPath, node.name, item);
                }

                /** Reveal the real option submenu and move semantic focus into it. */
                function expand() {
                    if (node.disabled || !submenu) {
                        return;
                    }

                    submenu.hidden = false;
                    item.setAttribute('aria-expanded', 'true');
                    (childItems.find((child) => child.getAttribute('aria-disabled') !== 'true') ?? childItems[0])?.focus();
                }

                /** Select only the original option at this pinned path. */
                function activate() {
                    if (sourceMenu !== state || node.disabled) {
                        return;
                    }

                    if (submenu) {
                        expand();
                    } else {
                        invoke(state.select, itemPath);
                    }
                }

                item.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    item.focus();
                    activate();
                });
                item.addEventListener('keydown', (event) => {
                    if (sourceMenu !== state) {
                        return;
                    }

                    switch (event.key) {
                        case 'ArrowDown':
                            items[(index + 1) % items.length].focus();
                            break;
                        case 'ArrowUp':
                            items[(index + items.length - 1) % items.length].focus();
                            break;
                        case 'Home':
                            items[0].focus();
                            break;
                        case 'End':
                            items.at(-1).focus();
                            break;
                        case 'ArrowRight':
                            expand();
                            break;
                        case 'Enter': case ' ':
                            activate();
                            break;
                        case 'ArrowLeft': if (parent) {
                            menu.hidden = true;
                            parent.setAttribute('aria-expanded', 'false');
                            parent.focus();
                        }

                            break;
                        case 'Escape': case 'Tab': {
                            invoke(state.onClose);

                            if (sourceMenu === state) {
                                clearSourceMenu();
                            }

                            event.stopPropagation();

                            if (event.key === 'Escape') {
                                event.preventDefault();
                            }

                            return;
                        }

                        default: return;
                    }

                    event.preventDefault();
                    event.stopPropagation();
                });
            }

            return items;
        }

        const items = build(root, pinned, [], 'World context menu', null);

        document.body.append(root);
        const first = items.find((item) => item.getAttribute('aria-disabled') !== 'true') ?? items[0];

        if (first) {
            first.tabIndex = 0;
            first.focus();
        }

        return root;
    }

    /**
     * Remove one owner's elements and draw commands while preserving foreign children.
     *
     * @param {string} owner - Package identifier to detach.
     */
    function cleanup(owner) {
        if (sourceMenu?.owner === owner) {
            clearSourceMenu();
        }

        for (const [id, value] of transitions) {
            if (value.owner === owner) {
                transitions.delete(id);
            }
        }

        const staged = [];

        /**
         * Preserve foreign descendants before detaching any owned ancestor's Lua graph.
         *
         * @param {UIElement} e - Next element in an owned native subtree.
         */
        function stage(e) {
            const children = e.children.map((childID) => {
                const child = element(childID);

                if (child.owner === owner) {
                    stage(child);
                }

                return { child, absolute: position(child) };
            });

            staged.push({ e, children });
        }

        for (const e of elements.values()) {
            if (e.owner === owner && elements.get(e.parent)?.owner !== owner) {
                stage(e);
            }
        }

        /* A detached forest may be retained from any descendant. Pin all foreign survivors
           in one Lua entry before cutting any edge that may be their last strong reference. */
        const foreignIDs = [];
        let retainRoots;

        for (const { children } of staged) {
            for (const { child } of children) {
                if (child.owner !== owner) {
                    foreignIDs.push(child.id);
                    retainRoots ??= child.callbacks.retainRoots;
                }
            }
        }

        retainRoots?.(foreignIDs);

        for (const { e, children } of staged) {
            const id = e.id;

            if (e.owner !== owner) {
                continue;
            }

            clearPlayerElement(e);

            for (const { child, absolute } of children) {
                if (!elements.has(child.id)) {
                    continue;
                }

                if (elements.has(id) && child.parent === id) {
                    if (child.owner === owner) {
                        method(id, 'RemoveChild', child.id);
                    } else {
                        // One callback transfers the Lua parent edge directly into a root pin.
                        e.children.splice(e.children.indexOf(child.id), 1);
                        child.parent = null;
                    }
                }

                if (!elements.has(child.id) || child.parent !== null) {
                    continue;
                }

                child.x = absolute.x;
                child.y = absolute.y;

                if (child.owner !== owner) {
                    child.removed = false;

                    if (!roots.includes(child.id)) {
                        roots.push(child.id);
                    }

                    child.callbacks.attached?.(true);
                }
            }

            if (elements.has(id) && e.parent && elements.has(e.parent)) {
                method(e.parent, 'RemoveChild', id);
            }

            const index = roots.indexOf(id);

            if (index !== -1) {
                roots.splice(index, 1);
            }

            e.callbacks.attached?.(false);
            elements.delete(id);
        }

        for (let i = commands.length - 1; i >= 0; i--) {
            if (commands[i].type !== 'stencil' && commands[i].owner === owner) {
                commands.splice(i, 1);
            }
        }
    }

    const bindings = Object.freeze({
        cleanup,
        /**
         * Dispatch a native Lua UI operation against this initialized session.
         *
         * @param {string} operation - Supported binding operation.
         * @param {string} owner - Calling package identifier.
         * @param {...(number|string|boolean|UITexture|UIColor|UICallbacks|null|undefined)} args - Operation-specific input validated by the selected binding.
         * @returns {number|number[]|boolean|string|UITexture|UIColor|UISettings|{width:number,height:number}|{x:number,y:number}|null|undefined} Binding query result, or undefined for mutations.
         */
        call(operation, owner, ...args) {
            ready();
            switch (operation) {
                case 'transitionNew': {
                    const id = nextUITransitionID++;

                    transitions.set(id, { owner, duration: 100, elapsed: 0, frac: 0, fadeOut: false, ignoreUpdateTime: false, updateTimeMs: 0 });

                    return id;
                }
                case 'transitionRelease':
                    transitions.delete(args[0]);

                    return;
                case 'transitionUpdateAll': return updateTransitions();
                case 'transition': return transition(...args);
                case 'getUI': return ordered();
                case 'new': {
                    const id = nextUIElementID++;

                    elements.set(id, { id, owner, uiName: '', x: 0, y: 0, width: 0, height: 0, scrollHeight: 0, scrollX: 0, scrollY: 0, visible: true, enabled: true, removed: false, parent: null, children: [], callbacks: args[0] ?? {}, anchorLeft: true, anchorTop: true, anchorRight: false, anchorBottom: false, alwaysOnTop: false, wantKeyEvents: false, consumeMouseEvents: false, wantExtraMouseEvents: false, forceCursorVisible: false });

                    return id;
                }
                case 'release': {
                    // Lua wrapper finalization, not RemoveUI: detached widgets may still be reused.
                    const id = args[0];
                    const e = elements.get(id);

                    if (!e) {
                        return;
                    }

                    clearPlayerElement(e);
                    e.removed = true;
                    const siblings = e.parent ? elements.get(e.parent)?.children : roots;
                    const index = siblings?.indexOf(id) ?? -1;

                    if (index !== -1) {
                        siblings.splice(index, 1);
                    }

                    for (const childID of e.children) {
                        const child = elements.get(childID);

                        if (child) {
                            child.parent = null;
                            child.removed = true;
                        }
                    }

                    elements.delete(id);

                    for (let i = commands.length - 1; i >= 0; i--) {
                        if (commands[i].type !== 'stencil' && commands[i].element === id) {
                            commands.splice(i, 1);
                        }
                    }

                    return;
                }
                case 'isMouseOverInventory': {
                    if (args.length !== 0) {
                        throw new TypeError('Inventory mouse-over query requires zero arguments');
                    }

                    const [tooltip, lootTooltip] = playerUI.playerInventoryTooltip;

                    if ((tooltip && reallyVisible(tooltip) && method(tooltip.id, 'isMouseOver')) || (lootTooltip && reallyVisible(lootTooltip) && method(lootTooltip.id, 'isMouseOver'))) {
                        return true;
                    }

                    const [inventory, loot] = playerUI.playerInventory;

                    if (!inventory || !loot) {
                        return false;
                    }

                    return (method(inventory.id, 'getMaxDrawHeight') === -1 && method(inventory.id, 'isMouseOver'))
                        || (method(loot.id, 'getMaxDrawHeight') === -1 && method(loot.id, 'isMouseOver'));
                }
                case 'playerInventory':
                case 'playerInventoryTooltip': {
                    if (args.length !== 3) {
                        throw new TypeError('Player UI setter requires three arguments');
                    }

                    if (args[0] !== 0) {
                        throw new RangeError('Only player viewport zero is supported');
                    }

                    // Original updateTooltip registers its retained pointer after RemoveElement and setVisible(false).
                    const allowDetached = operation === 'playerInventoryTooltip';
                    const first = playerElement(args[1], owner, allowDetached);
                    const second = playerElement(args[2], owner, allowDetached);
                    const pair = playerUI[operation];

                    if (pair.some((e) => e && e.owner !== owner)) {
                        throw new Error('Player UI pair belongs to another owner');
                    }

                    pair[0] = first;
                    pair[1] = second;

                    return;
                }
                case 'element': return method(...args);
                case 'add': {
                    const e = element(args[0]);

                    if (e.parent) {
                        throw new Error('Child cannot also be UI root');
                    }

                    if (!roots.includes(e.id)) {
                        roots.push(e.id);
                    }

                    e.removed = false;
                    e.callbacks.attached?.(true);

                    return;
                }
                case 'remove': {
                    const e = element(args[0]);

                    clearPlayerElement(e);
                    const index = roots.indexOf(e.id);

                    if (index !== -1) {
                        roots.splice(index, 1);
                    }

                    e.removed = true;
                    e.callbacks.attached?.(false);

                    return;
                }
                case 'texture': {
                    const texture = textures.get(args[0]);

                    if (!texture && indexedTextures.has(args[0])) {
                        throw new Error(`Unsupported UI capability: indexed texture was not preloaded: ${args[0]}`);
                    }

                    return texture ?? null;
                }
                case 'measureX':
                    // Original TextManager returns zero for null text before resolving even a null font.
                    if (args[1] === null || args[1] === undefined) {
                        return 0;
                    }

                    return layout(getFont(args[0]), args[1]).width;
                case 'measureY':
                    // Unlike width, original height returns zero when either the enum or text is null.
                    if (args[0] === null || args[0] === undefined || args[1] === null || args[1] === undefined) {
                        return 0;
                    }

                    return layout(getFont(args[0]), args[1]).height;
                case 'fontHeight': return getFont(args[0]).lineHeight;
                case 'fontSize': return getFont(args[0]).size;
                case 'text': case 'itemName': case 'textOrNull': {
                    if (!Object.hasOwn(translations, args[0])) {
                        if (operation === 'textOrNull') {
                            return null;
                        }

                        throw new Error(`Unsupported translation key: ${args[0]}`);
                    }

                    // Translator.getTextInternal converts breaks before formatting; item-name lookup does not.
                    const format = operation === 'itemName'
                        ? translations[args[0]]
                        : translations[args[0]].replaceAll('<br>', '\n').replaceAll('<BR>', '\n');
                    let missing = false;
                    // Translator.formatFixer maps %% and %1..%9 to Java's single-pass formatter.
                    const text = format.replaceAll(/%%|%([1-9])/gu, (token, index) => {
                        if (token === '%%') {
                            return '%';
                        }

                        if (Number(index) >= args.length) {
                            missing = true;

                            return token;
                        }

                        return args[Number(index)] === null || args[Number(index)] === undefined ? '' : String(args[Number(index)]);
                    });

                    return missing ? format : text;
                }
                case 'viewport': return { ...view() };
                case 'mouse': return { ...(options.mouse?.() ?? mouse) };
                case 'settings': return structuredClone(settings);
                case 'setCoreOption': {
                    const [name, value] = args;

                    if (name === 'doContainerOutline' && typeof value === 'boolean') {
                        settings.doContainerOutline = value;
                    } else if (name === 'objectHighlight') {
                        settings.objectHighlight = rgba(value);
                    } else {
                        throw new TypeError(`Unsupported or invalid Core option ${name}`);
                    }

                    return undefined;
                }
                case 'saveOptions':
                    if (!options.storage || typeof options.storage.setItem !== 'function') {
                        throw new Error('Core options require origin-local storage');
                    }

                    options.storage.setItem('pz-web-core-options', JSON.stringify({
                        doContainerOutline: settings.doContainerOutline, objectHighlight: settings.objectHighlight,
                        worldItemHighlight: settings.worldItemHighlight,
                    }));

                    return undefined;
                case 'gray': if (args.length) {
                    settings.gray = rgba(args[0]);
                }

                    return { ...settings.gray };
                default: throw new Error(`Unsupported UI binding ${operation}`);
            }
        },
    });

    return Object.freeze({
        bindings,
        sourceMenuMirror,
        /**
         * Publish source-owned world presentation without changing native item ownership.
         *
         * @param {'item'|'door'} kind - Stable native object namespace.
         * @param {number|string} id - Exact identity within that namespace.
         * @param {object} state - Current source highlight, outline and tint state.
         * @param {symbol} [owner] - Lua session identity for teardown without clearing foreign presentation.
         */
        setWorldHighlight(kind, id, state, owner) {
            live();

            if (!['item', 'door'].includes(kind) || (kind === 'item' ? !Number.isSafeInteger(id) || id <= 0 : typeof id !== 'string' || !id)
                || !state || ['enabled', 'blink'].some((key) => typeof state[key] !== 'boolean')
                || ['outline', 'outlineAttached'].some((key) => state[key] !== undefined && typeof state[key] !== 'boolean')) {
                throw new TypeError('Invalid source world highlight');
            }

            const record = Object.freeze({
                kind, id, enabled: state.enabled, blink: state.blink,
                outline: state.outline ?? false, outlineAttached: state.outlineAttached ?? false,
                color: Object.freeze(rgba(state.color ?? { r: 1, g: 1, b: 1, a: 1 })),
                outlineColor: Object.freeze(rgba(state.outlineColor ?? { r: 1, g: 1, b: 1, a: 1 })),
            });

            worldHighlights.set(`${kind}:${id}`, record);
            worldHighlightOwners.set(record, owner);
        },
        /**
         * Withdraw only the current records published by one Lua session.
         *
         * @param {symbol} owner - Exact publishing session identity.
         */
        clearWorldHighlights(owner) {
            live();

            if (typeof owner !== 'symbol') {
                throw new TypeError('World highlight session identity required');
            }

            for (const [key, record] of worldHighlights) {
                if (worldHighlightOwners.get(record) === owner) {
                    worldHighlights.delete(key);
                }
            }
        },
        /**
         * Read immutable source world highlight records for the current renderer.
         *
         * @returns {object[]} Frozen current stable-identity presentation state.
         */
        worldHighlights() {
            live();

            return Object.freeze([...worldHighlights.values()]);
        },
        /**
         * Mirror a genuine Lua submenu's native visibility without selecting or showing it.
         *
         * @param {number[]} path - Zero-based parent option path.
         * @param {boolean} visible - Current native visibility.
         */
        sourceMenuVisibility(path, visible) {
            if (!Array.isArray(path) || !path.length || path.length > 16
                || path.some((index) => !Number.isSafeInteger(index) || index < 0) || typeof visible !== 'boolean') {
                throw new TypeError('Invalid source submenu visibility');
            }

            const entry = sourceMenu?.submenus.get(path.join('/'));

            if (entry) {
                entry.submenu.hidden = !visible;
                entry.item.setAttribute('aria-expanded', String(visible));
            }
        },
        /**
         * Test residency without treating an indexed but unuploaded image as genuinely absent.
         *
         * @param {string} path - Original alias.
         * @returns {boolean} Whether an owned image is already uploaded.
         */
        hasTexture(path) {
            live();

            return textures.has(path);
        },
        /**
         * Commit newly uploaded images atomically without replacing resident source widgets.
         *
         * @param {UITexture[]} entries - Actual uploaded source resources.
         */
        addTextures(entries) {
            ready();
            textures = textureMap(entries, textures);

            for (const entry of entries) {
                for (const path of [entry.path, ...(entry.aliases ?? [])]) {
                    indexedTextures.add(path);
                }
            }
        },
        /**
         * Prepare genuine icons for definitions registered after original startup.
         *
         * @param {object[]} definitions - Current actual source-backed item definitions.
         * @returns {Promise<void>} Completed owned upload or attributable resource failure.
         */
        ensureItemTextures(definitions) {
            const pending = itemPreparation.then(async () => {
                ready();

                if (typeof loadItemTextures !== 'function') {
                    throw new TypeError('Unsupported UI capability: original item texture resolver unavailable');
                }

                await loadItemTextures(definitions);
                live();
            });

            // Keep later requests usable after a reported failure; the returned request still rejects.
            itemPreparation = pending.catch(() => undefined);

            return pending;
        },
        /**
         * Validate resources before transferring texture ownership to this session.
         *
         * @param {{textures:UITexture[],indexedTextures?:string[]|Set<string>,fonts?:Record<string,{descriptor:string,atlasPath:string}>,fontAliases?:Record<string,string>,font?:{descriptor:string,atlasPath:string},translations:Record<string,string>,settings:UISettings,loadItemTextures?:(definitions:object[])=>Promise<void>}} resources - Original fonts/images, verified enum aliases, icon resolver, exact translations and port settings.
         */
        initialize(resources) {
            // Ordinary Lua UI may supply Small alone; original source menus supply all three.
            live();

            if (elements.size) {
                throw new Error('Cannot replace resources of a live UI session');
            }

            const descriptors = resources.fonts ?? { Small: resources.font };
            const parsedFonts = new Map();
            const loaded = textureMap(resources.textures, new Map());

            for (const [name, entry] of Object.entries(descriptors)) {
                if (!['Small', 'Medium', 'Large'].includes(name) || !entry) {
                    throw new Error(`Unsupported font resource ${name}`);
                }

                const parsed = parseBitmapFont(entry.descriptor);
                const page = loaded.get(entry.atlasPath);

                if (!page || page.width !== parsed.width || page.height !== parsed.height) {
                    throw new Error(`BMFont ${name} atlas missing or dimensions disagree`);
                }

                parsedFonts.set(name, Object.freeze({ ...parsed, atlas: page }));
            }

            if (!parsedFonts.has(SMALL)) {
                throw new Error('Original Small font resource required');
            }

            for (const [alias, target] of Object.entries(resources.fontAliases ?? {})) {
                if (alias !== 'NewSmall' || target !== SMALL) {
                    throw new Error(`Unsupported original font alias ${alias}`);
                }

                parsedFonts.set(alias, parsedFonts.get(target));
            }

            if (!resources.translations || Object.values(resources.translations).some((v) => typeof v !== 'string')) {
                throw new TypeError('Exact-key translation table required');
            }

            const config = resources.settings;

            if (!config || !['moodleSize', 'fontSizeReal', 'lockFPS'].every((k) => Number.isFinite(config[k]) && config[k] > 0)) {
                throw new Error('Explicit port moodle/font size and scheduler FPS required');
            }

            const storedOptions = options.storage?.getItem('pz-web-core-options');
            const coreOptions = storedOptions === null || storedOptions === undefined ? {} : JSON.parse(storedOptions);

            if (!coreOptions || typeof coreOptions !== 'object' || Array.isArray(coreOptions)) {
                throw new TypeError('Invalid stored Core options');
            }

            const doContainerOutline = Object.hasOwn(coreOptions, 'doContainerOutline')
                ? coreOptions.doContainerOutline
                : config.doContainerOutline ?? true;

            if (typeof doContainerOutline !== 'boolean') {
                throw new TypeError('Container outline option must be boolean');
            }

            // Core constructor defaults; these are client options, not actor-save state.
            const objectHighlight = rgba(Object.hasOwn(coreOptions, 'objectHighlight')
                ? coreOptions.objectHighlight
                : config.objectHighlight ?? { r: 0.98, g: 0.56, b: 0.11, a: 1 });
            const worldItemHighlight = rgba(Object.hasOwn(coreOptions, 'worldItemHighlight')
                ? coreOptions.worldItemHighlight
                : config.worldItemHighlight ?? { r: 0.5, g: 1, b: 1, a: 1 });
            const validated = { ...config, doContainerOutline, objectHighlight, worldItemHighlight, gray: rgba(config.gray), goodHighlight: rgba(config.goodHighlight), badHighlight: rgba(config.badHighlight) };
            const indexed = new Set(resources.indexedTextures ?? []);

            for (const t of new Set(textures.values())) {
                t.destroy?.();
            }

            textures = loaded;
            indexedTextures = indexed;
            fonts = parsedFonts;
            translations = { ...resources.translations };
            settings = validated;
            loadItemTextures = resources.loadItemTextures ?? null;
        },
        /**
         * Replace an element's lifecycle and input hooks.
         *
         * @param {number} id - Session-local identifier.
         * @param {UICallbacks} callbacks - Hooks for the current Lua instance.
         */
        setCallbacks(id, callbacks) {
            element(id).callbacks = callbacks;
        },
        /**
         * Set logical canvas dimensions and propagate anchored layout changes.
         *
         * @param {number} width - Positive canvas width in logical pixels.
         * @param {number} height - Positive canvas height in logical pixels.
         */
        setViewport(width, height) {
            live();
            finite(width, 'viewport width');
            finite(height, 'viewport height');

            if (width <= 0 || height <= 0) {
                throw new RangeError('Viewport must be positive');
            }

            const dx = viewport ? width - viewport.width : 0;
            const dy = viewport ? height - viewport.height : 0;

            viewport = { width, height };

            for (const id of roots) {
                const e = element(id);
                const previousWidth = e.width;
                const previousHeight = e.height;

                if (e.anchorRight) {
                    if (e.anchorLeft) {
                        e.width = Math.max(0, e.width + dx);
                    } else {
                        e.x += dx;
                    }
                }

                if (e.anchorBottom) {
                    if (e.anchorTop) {
                        e.height = Math.max(0, e.height + dy);
                    } else {
                        e.y += dy;
                    }
                }

                resizeChildren(e, e.width - previousWidth, e.height - previousHeight);
            }
        },
        /**
         * Store the latest logical canvas pointer position.
         *
         * @param {number} x - Horizontal pointer coordinate.
         * @param {number} y - Vertical pointer coordinate.
         */
        setMouse(x, y) {
            live();
            mouse = { x: finite(x, 'mouse x'), y: finite(y, 'mouse y') };
        },
        /**
         * Route a mouse event front-to-back through active clipped elements.
         *
         * @param {string} name - Supported native mouse callback name.
         * @param {number} x - Absolute logical pointer coordinate.
         * @param {number} y - Absolute logical pointer coordinate.
         * @param {...number} args - Native move deltas, wheel delta or other numeric event arguments.
         * @returns {boolean} Whether a callback or element flag consumed the event.
         */
        input(name, x, y, ...args) {
            live();
            mouse = { x: finite(x, 'mouse x'), y: finite(y, 'mouse y') };

            if (!['onMouseDown', 'onMouseUp', 'onMouseMove', 'onMouseWheel', 'onMouseDoubleClick', 'onRightMouseDown', 'onRightMouseUp'].includes(name)) {
                throw new Error(`Unsupported UI input ${name}`);
            }

            const outsideName = name === 'onMouseWheel' || name === 'onMouseDoubleClick' ? null : `${name}Outside`;
            let capturedPaths;

            for (const e of elements.values()) {
                if (e.capture && active(e) && e.enabled) {
                    capturedPaths ??= new Set();

                    for (let parent = e; parent; parent = parent.parent ? elements.get(parent.parent) : undefined) {
                        capturedPaths.add(parent.id);
                    }
                }
            }

            /**
             * Notify visible descendants even though an outside callback cannot consume input.
             *
             * @param {number} id - Subtree outside the pointer.
             * @param {boolean} [descendants=true] - Also notify the outside subtree.
             */
            function outside(id, descendants = true) {
                const e = elements.get(id);

                if (!active(e) || !outsideName) {
                    return;
                }

                const p = position(e);
                const values = name === 'onMouseMove' ? args : [x - p.x - e.scrollX, y - p.y - e.scrollY, ...args];

                e.callbacks.input?.(outsideName, ...values);

                if (descendants) {
                    for (const child of [...e.children].reverse()) {
                        outside(child);
                    }
                }
            }

            /**
             * Try the frontmost eligible descendant before its parent.
             *
             * @param {number} id - Subtree root identifier.
             * @returns {boolean} Whether this subtree consumed the mouse event.
             */
            function hit(id) {
                const e = elements.get(id);

                if (!active(e) || !e.enabled) {
                    return false;
                }

                const over = containsPoint(e, x, y);

                if (!over && !capturedPaths?.has(id)) {
                    outside(id);

                    return false;
                }

                if (name === 'onMouseDown' && (over || e.capture)) {
                    const p = position(e);

                    e.callbacks.input?.('onFocus', x - p.x - e.scrollX, y - p.y - e.scrollY);
                }

                if (!active(e) || !e.enabled) {
                    return false;
                }

                const release = name === 'onMouseUp' || name === 'onRightMouseUp';
                let childConsumed = false;

                for (const child of [...e.children].reverse()) {
                    if (childConsumed) {
                        outside(child);
                    } else if (hit(child)) {
                        if (!release) {
                            return true;
                        }

                        childConsumed = true;
                    }
                }

                if (childConsumed) {
                    outside(id, false);

                    return true;
                }

                if (!active(e) || !e.enabled || (!over && !e.capture)) {
                    return false;
                }

                if ((name === 'onMouseWheel' || name === 'onMouseDoubleClick') && !e.wantExtraMouseEvents) {
                    return false;
                }

                const p = position(e);
                const values = name === 'onMouseMove' || name === 'onMouseWheel' ? args : [x - p.x - e.scrollX, y - p.y - e.scrollY, ...args];
                const result = e.callbacks.input?.(name, ...values);

                return result === null || result === undefined ? e.consumeMouseEvents : Boolean(result);
            }

            let consumed = false;

            for (const id of ordered().reverse()) {
                if (consumed) {
                    if (name !== 'onMouseMove') {
                        break;
                    }

                    const e = elements.get(id);

                    if (active(e) && !containsPoint(e, x, y)) {
                        outside(id);
                    }
                } else {
                    consumed = hit(id);
                }
            }

            return consumed;
        },
        /**
         * Route a key event to active enabled elements requesting key input.
         *
         * @param {string} name - Native press, release or repeat callback name.
         * @param {number} key - Nonnegative integer key code.
         * @returns {boolean} Whether an eligible callback consumed the key event.
         */
        keyInput(name, key) {
            live();

            if (!['onKeyPress', 'onKeyRelease', 'onKeyRepeat'].includes(name) || !Number.isSafeInteger(key) || key < 0) {
                throw new TypeError('Supported UI key event and nonnegative integer code required');
            }

            /**
             * Try key-input descendants before the current element.
             *
             * @param {number} id - Subtree root identifier.
             * @returns {boolean} Whether this subtree consumed the key event.
             */
            function send(id) {
                const e = elements.get(id);

                if (!active(e) || !e.enabled) {
                    return false;
                }

                for (const child of [...e.children].reverse()) {
                    if (send(child)) {
                        return true;
                    }
                }

                return Boolean(active(e) && e.enabled && e.wantKeyEvents && e.callbacks.input?.(name, key));
            }

            return ordered().reverse().some(send);
        },
        /**
         * Check whether any attached active element forces cursor visibility.
         *
         * @returns {boolean} Whether the host should display the cursor.
         */
        cursorVisible() {
            live();

            return [...elements.values()].some((e) => active(e) && e.forceCursorVisible && (e.parent || roots.includes(e.id)));
        },
        /**
         * Update active roots and descendants using an ordered root snapshot.
         */
        update() {
            live();

            for (const id of ordered()) {
                if (roots.includes(id)) {
                    visit(id, 'update');
                }
            }
        },
        /**
         * Collect ordered native stencil operations and quads, dropping subsequently inactive quads.
         *
         * @returns {UICommand[]} Reused command array, valid until the next render.
         */
        render() {
            live();
            updateTransitions();
            commands.length = 0;

            for (const id of ordered()) {
                if (roots.includes(id)) {
                    visit(id, 'draw');
                }
            }

            for (let i = commands.length - 1; i >= 0; i--) {
                if (commands[i].type !== 'stencil' && !active(elements.get(commands[i].element))) {
                    commands.splice(i, 1);
                }
            }

            return commands;
        },
        /**
         * Release callbacks and owned textures once, then notify the host.
         */
        dispose() {
            if (disposed) {
                return;
            }

            clearSourceMenu();
            playerUI.playerInventory.fill(null);
            playerUI.playerInventoryTooltip.fill(null);
            disposed = true;
            elements.clear();
            worldHighlights.clear();
            transitions.clear();
            roots.length = 0;
            commands.length = 0;

            for (const t of new Set(textures.values())) {
                t.destroy?.();
            }

            textures.clear();
            indexedTextures.clear();
            fonts.clear();
            loadItemTextures = null;
            options.onDispose?.();
        },
    });
}

const UI_SHADER = `
struct VertexOut { @builtin(position) position:vec4f, @location(0) uv:vec2f, @location(1) color:vec4f };
@group(0) @binding(0) var image:texture_2d<f32>;
@group(0) @binding(1) var imageSampler:sampler;
@vertex fn vertex(@location(0) position:vec2f,@location(1) uv:vec2f,@location(2) color:vec4f)->VertexOut {
 var out:VertexOut;out.position=vec4f(position,0,1);out.uv=uv;out.color=color;return out;
}
@fragment fn fragment(in:VertexOut)->@location(0) vec4f {
 let pixel=textureSample(image,imageSampler,in.uv);return vec4f(pixel.rgb*in.color.rgb*in.color.a,pixel.a*in.color.a);
}`;

// GPU storage and pipeline are shared across UI sessions; each session owns its imported textures.
/**
 * Create reusable UI submission storage on the world's existing WebGPU device.
 *
 * @param {GPUDevice} device - World renderer's device.
 * @param {string} format - Existing swap-chain format.
 * @param {GPUSampler} sampler - Existing linear sampler.
 * @returns {Promise<object>} Render-pass submission and owned GPU cleanup.
 */
async function createUIRenderer(device, format, sampler) {
    const module = device.createShaderModule({ label: 'original-game-ui', code: UI_SHADER });
    const compilation = await module.getCompilationInfo();
    const errors = compilation.messages.filter((m) => m.type === 'error');

    if (errors.length) {
        throw new Error(errors.map((m) => m.message).join('\n'));
    }

    const layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} }, { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} }] });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const vertex = { module, entryPoint: 'vertex', buffers: [{ arrayStride: 32, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }, { shaderLocation: 1, offset: 8, format: 'float32x2' }, { shaderLocation: 2, offset: 16, format: 'float32x4' }] }] };
    const blend = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } };

    /**
     * Share geometry and bindings between color draws and colorless stencil writes.
     *
     * @param {'always'|'equal'} compare - Stencil comparison.
     * @param {'keep'|'increment-clamp'|'replace'|'zero'} passOp - Operation on passing fragments.
     * @param {boolean} color - Whether this pipeline writes color.
     * @returns {GPURenderPipeline} UI pipeline variant.
     */
    function pipeline(compare, passOp, color) {
        const stencil = { compare, passOp, failOp: 'keep', depthFailOp: 'keep' };

        return device.createRenderPipeline({
            label: `original-game-ui-${compare}-${passOp}-${color ? 'color' : 'mask'}`,
            layout: pipelineLayout,
            vertex,
            fragment: { module, entryPoint: 'fragment', targets: [{ format, blend, writeMask: color ? globalThis.GPUColorWrite.ALL : 0 }] },
            primitive: { topology: 'triangle-list' },
            depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare: 'always', stencilFront: stencil, stencilBack: stencil, stencilReadMask: 0xFF, stencilWriteMask: color ? 0 : 0xFF },
        });
    }

    const unmasked = pipeline('always', 'keep', true);
    const masked = pipeline('equal', 'keep', true);
    const increment = pipeline('equal', 'increment-clamp', false);
    const replace = pipeline('always', 'replace', false);
    const zero = pipeline('always', 'zero', false);
    const white = device.createTexture({ label: 'ui-solid', size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });

    device.queue.writeTexture({ texture: white }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
    const groups = new WeakMap();
    let capacity = 0;
    let buffer = null;
    let data = null;
    let stencilTexture = null;
    let stencilWidth = 0;
    let stencilHeight = 0;
    let attachment = null;

    /**
     * Write one interleaved vertex without allocating per-quad arrays.
     *
     * @param {number} offset - Float offset in reusable storage.
     * @param {number} x - Clip-space x.
     * @param {number} y - Clip-space y.
     * @param {number} u - Texture u.
     * @param {number} v - Texture v.
     * @param {number} r - Red multiplier.
     * @param {number} g - Green multiplier.
     * @param {number} b - Blue multiplier.
     * @param {number} a - Alpha multiplier.
     */
    function writeVertex(offset, x, y, u, v, r, g, b, a) {
        data[offset] = x;
        data[offset + 1] = y;
        data[offset + 2] = u;
        data[offset + 3] = v;
        data[offset + 4] = r;
        data[offset + 5] = g;
        data[offset + 6] = b;
        data[offset + 7] = a;
    }

    /**
     * Reuse a texture's sampler bind group across UI submissions.
     *
     * @param {GPUTexture} texture - Image uploaded to this renderer's device.
     * @returns {GPUBindGroup} Texture and sampler bindings.
     */
    function group(texture) {
        let value = groups.get(texture);

        if (!value) {
            value = device.createBindGroup({ layout, entries: [{ binding: 0, resource: texture.createView() }, { binding: 1, resource: sampler }] });
            groups.set(texture, value);
        }

        return value;
    }

    return Object.freeze({
        /**
         * Reuse a UI-only stencil target at the framebuffer's physical dimensions.
         * Depth is unused/read-only, so depth load/store operations must be omitted.
         *
         * @param {number} width - Framebuffer width in physical pixels.
         * @param {number} height - Framebuffer height in physical pixels.
         * @returns {{view:GPUTextureView,depthReadOnly:true,stencilReadOnly:false,stencilLoadOp:'clear',stencilClearValue:number,stencilStoreOp:'discard'}} Attachment clearing stencil each UI frame.
         */
        stencilAttachment(width, height) {
            if (!stencilTexture || width !== stencilWidth || height !== stencilHeight) {
                const next = device.createTexture({ label: 'original-game-ui-stencil', size: [width, height], format: 'depth24plus-stencil8', usage: GPUTextureUsage.RENDER_ATTACHMENT });
                let view;

                try {
                    view = next.createView();
                } catch (error) {
                    next.destroy();
                    throw error;
                }

                stencilTexture?.destroy();
                stencilTexture = next;
                stencilWidth = width;
                stencilHeight = height;
                attachment = { view, depthReadOnly: true, stencilReadOnly: false, stencilLoadOp: 'clear', stencilClearValue: 0, stencilStoreOp: 'discard' };
            }

            return attachment;
        },
        /**
         * Submit ordered quads and global stencil operations into the UI render pass.
         *
         * @param {GPURenderPassEncoder} pass - Pass using stencilAttachment(width, height).
         * @param {UICommand[]} commands - Ordered commands collected from the current UI frame.
         * @param {number} width - Render target width in physical pixels.
         * @param {number} height - Render target height in physical pixels.
         * @param {number} scale - Physical pixels per logical UI pixel.
         */
        render(pass, commands, width, height, scale) {
            if (!commands.length) {
                return;
            }

            if (commands.length > capacity) {
                const nextCapacity = Math.max(commands.length, capacity * 2, 64);
                const nextData = new Float32Array(nextCapacity * 6 * 8);
                const nextBuffer = device.createBuffer({ label: 'ui-dynamic-vertices', size: nextCapacity * 6 * 32, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });

                buffer?.destroy();
                buffer = nextBuffer;
                data = nextData;
                capacity = nextCapacity;
            }

            // UIElement.stencilLevel is global, not an element-owned clipping stack.
            let level = 0;
            let enabled = false;
            let equal = false;
            let offset = 0;

            pass.setVertexBuffer(0, buffer);

            for (const c of commands) {
                const isStencil = c.type === 'stencil';
                let drawPipeline;
                const reference = Math.min(level, 255);
                let fullscreen = false;
                let texture = white;
                let rectX = 0;
                let rectY = 0;
                let rectWidth = 0;
                let rectHeight = 0;

                if (isStencil) {
                    switch (c.operation) {
                        case 'set':
                            enabled = true;
                            equal = true;
                            drawPipeline = increment;
                            level++;
                            break;
                        case 'clear':
                            level = Math.max(0, level - 1);
                            equal = level > 0;

                            if (level > 0) {
                                continue;
                            }

                            enabled = false;
                            drawPipeline = zero;
                            fullscreen = true;
                            break;
                        case 'repaint':
                            if (level === 0) {
                                continue;
                            }

                            equal = true;

                            // glStencilFunc changes while suspended, but disabled tests do not write.
                            if (!enabled) {
                                continue;
                            }

                            drawPipeline = replace;
                            break;
                        case 'suspend':
                            enabled = false;
                            continue;
                        case 'resume':
                            enabled = true;
                            continue;
                        default:
                            throw new Error('Unknown UI stencil operation');
                    }

                    if (c.operation === 'set' || c.operation === 'repaint') {
                        rectX = c.x;
                        rectY = c.y;
                        rectWidth = c.width;
                        rectHeight = c.height;
                    }

                    // Neither native mask painting nor glClear inherits the last quad's scissor.
                    pass.setScissorRect(0, 0, width, height);
                } else {
                    const x = Math.max(0, Math.floor(c.clip.x * scale));
                    const y = Math.max(0, Math.floor(c.clip.y * scale));
                    const right = Math.min(width, Math.ceil((c.clip.x + c.clip.width) * scale));
                    const bottom = Math.min(height, Math.ceil((c.clip.y + c.clip.height) * scale));

                    if (right <= x || bottom <= y) {
                        continue;
                    }

                    if (c.texture && !c.texture.texture) {
                        throw new Error('UI texture has not been uploaded to this GPU device');
                    }

                    texture = c.texture?.texture ?? white;
                    drawPipeline = enabled && equal ? masked : unmasked;
                    rectX = c.x;
                    rectY = c.y;
                    rectWidth = c.width;
                    rectHeight = c.height;
                    pass.setScissorRect(x, y, right - x, bottom - y);
                }

                const x0 = fullscreen ? -1 : rectX * scale / width * 2 - 1;
                const x1 = fullscreen ? 1 : (rectX + rectWidth) * scale / width * 2 - 1;
                const y0 = fullscreen ? 1 : 1 - rectY * scale / height * 2;
                const y1 = fullscreen ? -1 : 1 - (rectY + rectHeight) * scale / height * 2;
                const u0 = isStencil ? 0 : c.uv.x;
                const u1 = isStencil ? 1 : u0 + c.uv.width;
                const v0 = isStencil ? 0 : c.uv.y;
                const v1 = isStencil ? 1 : v0 + c.uv.height;
                const r = isStencil ? 1 : c.color.r;
                const g = isStencil ? 1 : c.color.g;
                const b = isStencil ? 1 : c.color.b;
                const a = isStencil ? 1 : c.color.a;

                writeVertex(offset, x0, y0, u0, v0, r, g, b, a);
                writeVertex(offset + 8, x1, y0, u1, v0, r, g, b, a);
                writeVertex(offset + 16, x0, y1, u0, v1, r, g, b, a);
                writeVertex(offset + 24, x0, y1, u0, v1, r, g, b, a);
                writeVertex(offset + 32, x1, y0, u1, v0, r, g, b, a);
                writeVertex(offset + 40, x1, y1, u1, v1, r, g, b, a);
                pass.setPipeline(drawPipeline);
                pass.setStencilReference(reference);
                pass.setBindGroup(0, group(texture));
                pass.draw(6, 1, offset / 8);
                offset += 48;
            }

            // Encoding draws does not execute them: this upload precedes the owner's queue.submit.
            if (offset) {
                device.queue.writeBuffer(buffer, 0, data, 0, offset);
            }

            pass.setScissorRect(0, 0, width, height);
        },
        /**
         * Destroy shared vertex storage, the solid-fill texture, and the UI-only stencil target.
         */
        destroy() {
            buffer?.destroy();
            buffer = null;
            data = null;
            stencilTexture?.destroy();
            stencilTexture = null;
            attachment = null;
            white.destroy();
        },
    });
}

export { parseBitmapFont, createGameUI, createUIRenderer };
