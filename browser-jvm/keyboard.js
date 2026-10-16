// Real DOM state for the owned game canvas; native hooks query physical key codes.
/**
 * Connects physical DOM keyboard state to the owned canvas.
 *
 * @param {HTMLCanvasElement} canvas - Connected canvas owned by this browser qualification.
 * @returns {object} Owned native callbacks and lifecycle inspection functions.
 */
export function keyboardNatives(canvas) {
    if (!(canvas instanceof HTMLCanvasElement) || !canvas.isConnected) {
        throw new Error('Keyboard requires a connected canvas');
    }

    const pressed = new Set();

    canvas.tabIndex = 0;
    /**
     * Performs the down operation for the owned browser runtime.
     *
     * @param {number} event - Numeric event argument for the declared operation.
     */
    const down = (event) => {
        if (document.activeElement === canvas) {
            pressed.add(event.code);
            event.preventDefault();
        }
    };

    /**
     * Performs the up operation for the owned browser runtime.
     *
     * @param {number} event - Numeric event argument for the declared operation.
     * @returns {unknown} Result of the declared browser or runtime operation.
     */
    const up = (event) => pressed.delete(event.code);
    /**
     * Performs the clear operation for the owned browser runtime.
     *
     * @returns {unknown} Result of the declared browser or runtime operation.
     */
    const clear = () => pressed.clear();

    globalThis.addEventListener('keydown', down);
    globalThis.addEventListener('keyup', up);
    window.addEventListener('blur', clear);
    canvas.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', clear);
    const special = { 32: 'Space', 39: 'Quote', 44: 'Comma', 45: 'Minus', 46: 'Period', 47: 'Slash', 59: 'Semicolon', 61: 'Equal', 91: 'BracketLeft', 92: 'Backslash', 93: 'BracketRight', 96: 'Backquote', 256: 'Escape', 257: 'Enter', 258: 'Tab', 259: 'Backspace', 260: 'Insert', 261: 'Delete', 262: 'ArrowRight', 263: 'ArrowLeft', 264: 'ArrowDown', 265: 'ArrowUp', 266: 'PageUp', 267: 'PageDown', 268: 'Home', 269: 'End', 280: 'CapsLock', 281: 'ScrollLock', 282: 'NumLock', 283: 'PrintScreen', 284: 'Pause', 330: 'NumpadDecimal', 331: 'NumpadDivide', 332: 'NumpadMultiply', 333: 'NumpadSubtract', 334: 'NumpadAdd', 335: 'NumpadEnter', 336: 'NumpadEqual', 340: 'ShiftLeft', 341: 'ControlLeft', 342: 'AltLeft', 343: 'MetaLeft', 344: 'ShiftRight', 345: 'ControlRight', 346: 'AltRight', 347: 'MetaRight', 348: 'ContextMenu' };

    return {
        natives: {
            /**
             * Performs the  java_port_host_ browser keyboard_created operation for the owned browser runtime.
             *
             * @returns {unknown} Result of the declared browser or runtime operation.
             */
            Java_port_host_BrowserKeyboard_created() {
                return canvas.isConnected;
            },
            /**
             * Performs the  java_port_host_ browser keyboard_key operation for the owned browser runtime.
             *
             * @param {unknown} lib - Reserved library context supplied by CheerpJ.
             * @param {number} key - Numeric key argument for the declared operation.
             * @returns {unknown} Result of the declared browser or runtime operation.
             */
            Java_port_host_BrowserKeyboard_key(lib, key) {
                if (!canvas.isConnected) {
                    throw new Error('Keyboard canvas was removed');
                }

                let code = special[key];

                if (key >= 65 && key <= 90) {
                    code = `Key${String.fromCharCode(key)}`;
                } else if (key >= 48 && key <= 57) {
                    code = `Digit${String.fromCharCode(key)}`;
                } else if (key >= 290 && key <= 314) {
                    code = `F${key - 289}`;
                } else if (key >= 320 && key <= 329) {
                    code = `Numpad${key - 320}`;
                }

                // shortcut: WORLD keys have no portable physical DOM code; reject ambiguous international input.
                if ((key === 161 || key === 162) && [...pressed].some((value) => !value || value === 'Unidentified' || value.startsWith('Intl'))) {
                    throw new Error('International WORLD key mapping unavailable');
                }

                return code && pressed.has(code) ? 1 : 0;
            },
        },
        /**
         * Releases owned event listeners and pressed-key state.
         */
        dispose() {
            clear();
            globalThis.removeEventListener('keydown', down);
            globalThis.removeEventListener('keyup', up);
            window.removeEventListener('blur', clear);
            canvas.removeEventListener('blur', clear);
            document.removeEventListener('visibilitychange', clear);
        },
    };
}
