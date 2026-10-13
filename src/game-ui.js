// Semantic original-game UI on the existing canvas. No DOM or alternate renderer.
const SMALL = 'Small';

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
 * @typedef {{path:string,width:number,height:number,texture?:GPUTexture,destroy?:()=>void}} UITexture
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
 * @typedef {{moodleSize:number,fontSizeReal:number,lockFPS:number,gray:UIColor,goodHighlight:UIColor,badHighlight:UIColor}} UISettings
 */
/**
 * Lua lifecycle and input hooks; truthy input results consume the event.
 *
 * @typedef {{update?:()=>void,prerender?:()=>void,render?:()=>void,input?:(name:string,...args:number[])=>unknown}} UICallbacks
 */
/**
 * Session-local semantic element and its layout/input state.
 *
 * @typedef {{id:number,owner:string,x:number,y:number,width:number,height:number,scrollX:number,scrollY:number,visible:boolean,enabled:boolean,removed:boolean,parent:number|null,children:number[],callbacks:UICallbacks,anchorLeft:boolean,anchorRight:boolean,anchorTop:boolean,anchorBottom:boolean,wantKeyEvents:boolean,consumeMouseEvents:boolean,wantExtraMouseEvents:boolean,forceCursorVisible:boolean,alwaysOnTop:boolean,stencil:UIRect|null,stencilSuspended?:boolean}} UIElement
 */
/**
 * One clipped, tinted textured or solid quad for immediate GPU submission.
 *
 * @typedef {{element:number,owner:string,texture:UITexture|null|undefined,x:number,y:number,width:number,height:number,uv:UIRect,color:UIColor,clip:UIRect}} UICommand
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
 * Own one isolated Lua UI session. Resource ownership transfers only after initialize succeeds.
 * Commands are reused each render; consumers must submit them before the next render.
 *
 * @param {{viewport?:()=>{width:number,height:number},mouse?:()=>{x:number,y:number},onDispose?:()=>void}} [options] - Host canvas bounds/input and ownership release.
 * @returns {object} Semantic tree, native bindings, input, draw collection and disposal.
 */
function createGameUI(options = {}) {
    const elements = new Map();
    const roots = [];
    const commands = [];
    let nextID = 1;
    let textures = new Map();
    let indexedTextures = new Set();
    let font;
    let atlas;
    let translations;
    let settings;
    let disposed = false;
    let viewport = null;
    let mouse = { x: -1, y: -1 };

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

        if (!font) {
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
     * Resolve absolute coordinates through the parent and scroll chain.
     *
     * @param {UIElement} e - Element whose origin is needed.
     * @returns {{x:number,y:number}} Absolute origin in logical canvas pixels.
     */
    function position(e) {
        if (!e.parent) {
            return { x: e.x, y: e.y };
        }

        const parent = elements.get(e.parent);
        const p = position(parent);

        return { x: p.x + parent.scrollX + e.x, y: p.y + parent.scrollY + e.y };
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
     * Intersect the canvas bounds with every active ancestor stencil.
     *
     * @param {UIElement} e - Element whose clipping bounds are needed.
     * @returns {UIRect} Absolute clipping rectangle.
     */
    function clip(e) {
        const v = view();
        let result = { x: 0, y: 0, width: v.width, height: v.height };

        if (e.parent) {
            result = clip(elements.get(e.parent));
        }

        if (e.stencil && !e.stencilSuspended) {
            const p = position(e);

            result = intersection(result, { x: p.x + e.stencil.x, y: p.y + e.stencil.y, width: e.stencil.width, height: e.stencil.height });
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
     * Invoke a lifecycle phase on the currently active tree.
     *
     * @param {number} id - Session-local element identifier.
     * @param {'update'|'prerender'|'render'} phase - Lifecycle callback to invoke.
     */
    function visit(id, phase) {
        const e = elements.get(id);

        if (!active(e)) {
            return;
        }

        e.callbacks[phase]?.();

        if (!active(e)) {
            return;
        }

        for (const child of [...e.children]) {
            if (elements.get(child)?.parent === id) {
                visit(child, phase);
            }
        }
    }

    /**
     * Measure text and optionally visit glyphs using advances and pair kerning.
     *
     * @param {string} text - Bounded text containing supported font glyphs.
     * @param {(glyph:UIGlyph,x:number,y:number)=>void} [draw] - Receives each glyph at its pen position.
     * @returns {{width:number,height:number}} Text extent in font pixels.
     */
    function layout(text, draw) {
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
     * Resolve the supported Small font after resource initialization.
     *
     * @param {string|null|undefined} token - Small, or an omitted/default font selector.
     * @returns {UIFont} Initialized bitmap font.
     */
    function getFont(token) {
        ready();

        if (token !== SMALL && token !== null && token !== undefined) {
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
     * @returns {number|boolean|undefined} Getter result; mutating and drawing methods return undefined.
     */
    function method(id, name, ...args) {
        const e = element(id);
        const property = { X: 'x', Y: 'y', Width: 'width', Height: 'height', XScroll: 'scrollX', YScroll: 'scrollY', AnchorLeft: 'anchorLeft', AnchorRight: 'anchorRight', AnchorTop: 'anchorTop', AnchorBottom: 'anchorBottom', Visible: 'visible', Enabled: 'enabled', WantKeyEvents: 'wantKeyEvents', ConsumeMouseEvents: 'consumeMouseEvents', WantExtraMouseEvents: 'wantExtraMouseEvents', ForceCursorVisible: 'forceCursorVisible', AlwaysOnTop: 'alwaysOnTop' };
        const suffix = name.slice(3);
        const key = property[suffix];

        if (key && name.startsWith('get')) {
            return e[key];
        }

        if (key && name.startsWith('set')) {
            const value = ['x', 'y', 'width', 'height', 'scrollX', 'scrollY'].includes(key) ? finite(args[0], name) : Boolean(args[0]);

            if ((key === 'width' || key === 'height') && value < 0) {
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
            case 'getAbsoluteX': return position(e).x;
            case 'getAbsoluteY': return position(e).y;
            case 'isVisible': return active(e);
            case 'isEnabled': return e.enabled;
            case 'isMouseOver': {
                const m = options.mouse?.() ?? mouse;

                return method(id, 'isPointOver', m.x, m.y);
            }
            case 'isPointOver': {
                const p = position(e);
                const c = clip(e);

                return !!(active(e) && e.enabled && args[0] >= p.x && args[1] >= p.y && args[0] < p.x + e.width && args[1] < p.y + e.height && args[0] >= c.x && args[1] >= c.y && args[0] < c.x + c.width && args[1] < c.y + c.height);
            }
            case 'setStencilRect': e.stencil = { x: finite(args[0], 'clip x'), y: finite(args[1], 'clip y'), width: finite(args[2], 'clip width'), height: finite(args[3], 'clip height') };

                return;
            case 'clearStencilRect': e.stencil = null;

                return;
            case 'suspendStencil': e.stencilSuspended = true;

                return;
            case 'resumeStencil': e.stencilSuspended = false;

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

                return;
            }
            case 'RemoveChild': {
                const child = element(args[0]);

                if (child.parent === id) {
                    e.children.splice(e.children.indexOf(child.id), 1);
                    child.parent = null;
                    child.removed = true;
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

                return quad(e, t, x, y, t.width * scale, t.height * scale, r, g, b, a);
            }
            case 'DrawTexture': {
                const [t, x, y, a] = args;

                if (!t) {
                    throw new Error('Unscaled draw requires a texture');
                }

                return quad(e, t, x, y, t.width, t.height, 1, 1, 1, a);
            }
            case 'DrawTextureColor': {
                const [t, x, y, r, g, b, a] = args;

                if (!t) {
                    throw new Error('Unscaled draw requires a texture');
                }

                return quad(e, t, x, y, t.width, t.height, r, g, b, a);
            }
            case 'DrawTextRight': case 'DrawTextCentre': case 'DrawText': {
                const [token, text, x, y, r, g, b, a] = args;

                getFont(token);
                const metrics = layout(text);
                let alignment = 0;

                if (name === 'DrawTextRight') {
                    alignment = metrics.width;
                } else if (name === 'DrawTextCentre') {
                    alignment = metrics.width / 2;
                }

                const start = x - alignment;

                layout(text, (glyph, gx, gy) => {
                    if (glyph.width && glyph.height) {
                        quad(e, atlas, start + gx + glyph.xoffset, y + gy + glyph.yoffset, glyph.width, glyph.height, r, g, b, a, { x: glyph.x / font.width, y: glyph.y / font.height, width: glyph.width / font.width, height: glyph.height / font.height });
                    }
                });

                return;
            }

            default: throw new Error(`Unsupported UIElement:${name}`);
        }
    }

    /**
     * Remove one owner's elements and draw commands while preserving foreign children.
     *
     * @param {string} owner - Package identifier to detach.
     */
    function cleanup(owner) {
        for (const [id, e] of elements) {
            if (e.owner === owner) {
                if (e.parent && elements.has(e.parent)) {
                    method(e.parent, 'RemoveChild', id);
                }

                for (const childID of [...e.children]) {
                    const child = element(childID);
                    const absolute = position(child);

                    method(id, 'RemoveChild', childID);
                    child.x = absolute.x;
                    child.y = absolute.y;

                    if (child.owner !== owner) {
                        child.removed = false;
                        roots.push(childID);
                    }
                }

                const index = roots.indexOf(id);

                if (index !== -1) {
                    roots.splice(index, 1);
                }

                elements.delete(id);
            }
        }

        for (let i = commands.length - 1; i >= 0; i--) {
            if (commands[i].owner === owner) {
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
         * @returns {number|boolean|string|UITexture|UIColor|UISettings|{width:number,height:number}|{x:number,y:number}|null|undefined} Binding query result, or undefined for mutations.
         */
        call(operation, owner, ...args) {
            ready();
            switch (operation) {
                case 'new': {
                    const id = nextID++;

                    elements.set(id, { id, owner, x: 0, y: 0, width: 0, height: 0, scrollX: 0, scrollY: 0, visible: true, enabled: true, removed: false, parent: null, children: [], callbacks: args[0] ?? {}, anchorLeft: true, anchorTop: true, anchorRight: false, anchorBottom: false, wantKeyEvents: false, consumeMouseEvents: false, wantExtraMouseEvents: false, forceCursorVisible: false, alwaysOnTop: false, stencil: null });

                    return id;
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

                    return;
                }
                case 'remove': {
                    const e = element(args[0]);
                    const index = roots.indexOf(e.id);

                    if (index !== -1) {
                        roots.splice(index, 1);
                    }

                    e.removed = true;

                    return;
                }
                case 'texture': {
                    const texture = textures.get(args[0]);

                    if (!texture && indexedTextures.has(args[0])) {
                        throw new Error(`Unsupported UI capability: indexed texture was not preloaded: ${args[0]}`);
                    }

                    return texture ?? null;
                }
                case 'measureX': getFont(args[0]);

                    return layout(args[1]).width;
                case 'measureY': getFont(args[0]);

                    return layout(args[1]).height;
                case 'fontHeight': return getFont(args[0]).lineHeight;
                case 'text': if (!Object.hasOwn(translations, args[0])) {
                    throw new Error(`Unsupported translation key: ${args[0]}`);
                }

                    return translations[args[0]];
                case 'textOrNull': return translations[args[0]] ?? null;
                case 'viewport': return { ...view() };
                case 'mouse': return { ...(options.mouse?.() ?? mouse) };
                case 'settings': return structuredClone(settings);
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
        /**
         * Validate resources before transferring texture ownership to this session.
         *
         * @param {{textures:UITexture[],indexedTextures?:string[]|Set<string>,font:{descriptor:string,atlasPath:string},translations:Record<string,string>,settings:UISettings}} resources - Original font/images, validated indexed aliases (including unpreloaded paths), exact translation keys and explicit port settings.
         */
        initialize(resources) {
            /* textures: [{path,width,height,texture?,destroy?}], font: {descriptor,atlasPath}.
               Settings are explicit port choices, not claims of original engine defaults. */
            live();

            if (elements.size) {
                throw new Error('Cannot replace resources of a live UI session');
            }

            const parsed = parseBitmapFont(resources.font.descriptor);
            const loaded = new Map();

            for (const t of resources.textures) {
                if (typeof t.path !== 'string' || loaded.has(t.path)) {
                    throw new Error('Duplicate/invalid UI texture path');
                }

                extent(t.width, 'texture width');
                extent(t.height, 'texture height');
                loaded.set(t.path, Object.freeze({ ...t }));
            }

            const page = loaded.get(resources.font.atlasPath);

            if (!page || page.width !== parsed.width || page.height !== parsed.height) {
                throw new Error('BMFont atlas missing or dimensions disagree');
            }

            if (!resources.translations || Object.values(resources.translations).some((v) => typeof v !== 'string')) {
                throw new TypeError('Exact-key translation table required');
            }

            const config = resources.settings;

            if (!config || !['moodleSize', 'fontSizeReal', 'lockFPS'].every((k) => Number.isFinite(config[k]) && config[k] > 0)) {
                throw new Error('Explicit port moodle/font size and scheduler FPS required');
            }

            const validated = { ...config, gray: rgba(config.gray), goodHighlight: rgba(config.goodHighlight), badHighlight: rgba(config.badHighlight) };
            const indexed = new Set(resources.indexedTextures ?? []);

            for (const t of textures.values()) {
                t.destroy?.();
            }

            textures = loaded;
            indexedTextures = indexed;
            font = parsed;
            atlas = page;
            translations = { ...resources.translations };
            settings = validated;
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

            if (!['onMouseDown', 'onMouseUp', 'onMouseMove', 'onMouseWheel', 'onMouseDoubleClick'].includes(name)) {
                throw new Error(`Unsupported UI input ${name}`);
            }

            /**
             * Try the frontmost eligible descendant before its parent.
             *
             * @param {number} id - Subtree root identifier.
             * @returns {boolean} Whether this subtree consumed the mouse event.
             */
            function hit(id) {
                const e = element(id);

                if (!active(e)) {
                    return false;
                }

                for (const child of [...e.children].reverse()) {
                    if (hit(child)) {
                        return true;
                    }
                }

                if (!method(id, 'isPointOver', x, y)) {
                    return false;
                }

                if ((name === 'onMouseWheel' || name === 'onMouseDoubleClick') && !e.wantExtraMouseEvents) {
                    return false;
                }

                const p = position(e);
                const values = name === 'onMouseMove' || name === 'onMouseWheel' ? args : [x - p.x - e.scrollX, y - p.y - e.scrollY, ...args];
                const result = e.callbacks.input?.(name, ...values);

                return Boolean(result || e.consumeMouseEvents);
            }

            return ordered().reverse().some(hit);
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
                const e = element(id);

                if (!active(e) || !e.enabled) {
                    return false;
                }

                for (const child of [...e.children].reverse()) {
                    if (send(child)) {
                        return true;
                    }
                }

                return Boolean(e.wantKeyEvents && e.callbacks.input?.(name, key));
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
         * Collect prerender and render quads, dropping subsequently inactive elements.
         *
         * @returns {UICommand[]} Reused command array, valid until the next render.
         */
        render() {
            live();
            commands.length = 0;

            for (const id of ordered()) {
                if (roots.includes(id)) {
                    visit(id, 'prerender');

                    if (roots.includes(id)) {
                        visit(id, 'render');
                    }
                }
            }

            for (let i = commands.length - 1; i >= 0; i--) {
                if (!active(elements.get(commands[i].element))) {
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

            disposed = true;
            elements.clear();
            roots.length = 0;
            commands.length = 0;

            for (const t of textures.values()) {
                t.destroy?.();
            }

            textures.clear();
            indexedTextures.clear();
            font = null;
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
    const pipeline = device.createRenderPipeline({ label: 'original-game-ui', layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }), vertex: { module, entryPoint: 'vertex', buffers: [{ arrayStride: 32, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }, { shaderLocation: 1, offset: 8, format: 'float32x2' }, { shaderLocation: 2, offset: 16, format: 'float32x4' }] }] }, fragment: { module, entryPoint: 'fragment', targets: [{ format, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } } }] }, primitive: { topology: 'triangle-list' } });
    const white = device.createTexture({ label: 'ui-solid', size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING });

    device.queue.writeTexture({ texture: white }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
    const groups = new WeakMap();
    let capacity = 0;
    let buffer = null;
    let data = null;

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
         * Submit collected quads into the existing render pass.
         *
         * @param {GPURenderPassEncoder} pass - World render pass to append to.
         * @param {UICommand[]} commands - Quads collected from the current UI frame.
         * @param {number} width - Render target width in physical pixels.
         * @param {number} height - Render target height in physical pixels.
         * @param {number} scale - Physical pixels per logical UI pixel.
         */
        render(pass, commands, width, height, scale) {
            if (!commands.length) {
                return;
            }

            if (commands.length > capacity) {
                capacity = Math.max(commands.length, capacity * 2, 64);
                buffer?.destroy();
                buffer = device.createBuffer({ label: 'ui-dynamic-vertices', size: capacity * 6 * 32, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
                data = new Float32Array(capacity * 6 * 8);
            }

            let offset = 0;

            for (const c of commands) {
                const x0 = c.x * scale / width * 2 - 1;
                const x1 = (c.x + c.width) * scale / width * 2 - 1;
                const y0 = 1 - c.y * scale / height * 2;
                const y1 = 1 - (c.y + c.height) * scale / height * 2;
                const u0 = c.uv.x;
                const u1 = u0 + c.uv.width;
                const v0 = c.uv.y;
                const v1 = v0 + c.uv.height;

                for (const v of [[x0, y0, u0, v0], [x1, y0, u1, v0], [x0, y1, u0, v1], [x0, y1, u0, v1], [x1, y0, u1, v0], [x1, y1, u1, v1]]) {
                    data.set(v, offset);
                    data.set([c.color.r, c.color.g, c.color.b, c.color.a], offset + 4);
                    offset += 8;
                }
            }

            device.queue.writeBuffer(buffer, 0, data, 0, offset);
            pass.setPipeline(pipeline);
            pass.setVertexBuffer(0, buffer);

            for (const [i, c] of commands.entries()) {
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

                pass.setScissorRect(x, y, right - x, bottom - y);
                pass.setBindGroup(0, group(c.texture?.texture ?? white));
                pass.draw(6, 1, i * 6);
            }

            pass.setScissorRect(0, 0, width, height);
        },
        /**
         * Destroy shared vertex storage and the solid-fill texture.
         */
        destroy() {
            buffer?.destroy();
            buffer = null;
            white.destroy();
        },
    });
}

export { parseBitmapFont, createGameUI, createUIRenderer };
