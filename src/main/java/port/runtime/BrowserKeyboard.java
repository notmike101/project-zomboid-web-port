package port.runtime;

import org.teavm.jso.JSBody;

/** Real physical keyboard state supplied by DOM events for an owned browser canvas. */
public final class BrowserKeyboard {
    private static int handle;
    public static void initialize() { if (handle == 0) handle = registerCanvas(); }
    public static long windowHandle() { initialize(); return handle; }
    public static boolean isCreated() { initialize(); return canvasRegistered(handle); }
    public static int getKey(long window, int key) {
        initialize();
        if (window != handle) throw new IllegalArgumentException("Unknown browser canvas window: " + window);
        if (key < 32 || key > 348) throw new IllegalArgumentException("Invalid GLFW key: " + key);
        int state = query(handle, key);
        if (state < 0) throw new UnsupportedOperationException("No browser physical-key mapping for GLFW key " + key);
        return state;
    }
    @JSBody(script = """
            const canvas = globalThis.portGraphicsCanvas;
            const valid = canvas && ((typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas)
                || (typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement));
            if (!valid) throw new Error('Browser keyboard requires an owned actual canvas in portGraphicsCanvas');
            if (!(globalThis.portKeyboardCodes instanceof Set))
                throw new Error('Browser keyboard requires the DOM-event portKeyboardCodes Set');
            let registry = globalThis.__portKeyboardWindows;
            if (!registry) registry = globalThis.__portKeyboardWindows = {next: 1, byCanvas: new WeakMap(), byId: new Map()};
            let handle = registry.byCanvas.get(canvas);
            if (handle === undefined) {
                handle = registry.next++;
                registry.byCanvas.set(canvas, handle);
                registry.byId.set(handle, canvas);
            }
            return handle;
            """)
    private static native int registerCanvas();

    @JSBody(params = {"handle"}, script = """
            const registry = globalThis.__portKeyboardWindows;
            const canvas = globalThis.portGraphicsCanvas;
            return !!(registry && registry.byId.get(handle) === canvas
                && globalThis.portKeyboardCodes instanceof Set
                && (typeof HTMLCanvasElement === 'undefined' || !(canvas instanceof HTMLCanvasElement) || canvas.isConnected));
            """)
    private static native boolean canvasRegistered(int handle);

    @JSBody(params = {"handle", "key"}, script = """
            const registry = globalThis.__portKeyboardWindows;
            if (!registry || registry.byId.get(handle) !== globalThis.portGraphicsCanvas)
                throw new Error('Browser keyboard canvas registration no longer matches');
            const codes = globalThis.portKeyboardCodes;
            if (!(codes instanceof Set)) throw new Error('Browser keyboard event state unavailable');
            let code;
            if (key >= 65 && key <= 90) code = 'Key' + String.fromCharCode(key);
            else if (key >= 48 && key <= 57) code = 'Digit' + String.fromCharCode(key);
            else if (key >= 290 && key <= 314) code = 'F' + (key - 289);
            else if (key >= 320 && key <= 329) code = 'Numpad' + (key - 320);
            else code = ({32:'Space',39:'Quote',44:'Comma',45:'Minus',46:'Period',47:'Slash',
                59:'Semicolon',61:'Equal',91:'BracketLeft',92:'Backslash',93:'BracketRight',96:'Backquote',
                256:'Escape',257:'Enter',258:'Tab',259:'Backspace',260:'Insert',261:'Delete',
                262:'ArrowRight',263:'ArrowLeft',264:'ArrowDown',265:'ArrowUp',266:'PageUp',267:'PageDown',
                268:'Home',269:'End',280:'CapsLock',281:'ScrollLock',282:'NumLock',283:'PrintScreen',284:'Pause',
                330:'NumpadDecimal',331:'NumpadDivide',332:'NumpadMultiply',333:'NumpadSubtract',334:'NumpadAdd',
                335:'NumpadEnter',336:'NumpadEqual',340:'ShiftLeft',341:'ControlLeft',342:'AltLeft',343:'MetaLeft',
                344:'ShiftRight',345:'ControlRight',346:'AltRight',347:'MetaRight',348:'ContextMenu'})[key];
            if (code === undefined) {
                // shortcut: WORLD keys have no portable DOM mapping. A complete
                // US-keyboard scan can report them released only while no ambiguous
                // physical key is held; international input fails explicitly.
                if (key === 161 || key === 162) {
                    var ambiguous = false;
                    codes.forEach(function(pressed) {
                        if (!pressed || pressed === 'Unidentified' || pressed.startsWith('Intl')) ambiguous = true;
                    });
                    return ambiguous ? -1 : 0;
                }
                return 0; // Undefined entries in GLFW's key interval have no physical key.
            }
            return codes.has(code) ? 1 : 0;
            """)
    private static native int query(int handle, int key);
}
