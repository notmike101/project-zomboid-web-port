/**
 * Owns physical key state and optional original-vendor keyboard events.
 *
 * @param {HTMLCanvasElement} canvas - Connected game canvas.
 * @returns {object} Native callbacks, optional text events and owned cleanup.
 */
export function keyboardNatives(canvas) {
    if (!(canvas instanceof HTMLCanvasElement) || !canvas.isConnected) {
        throw new Error('Keyboard requires a connected canvas');
    }

    const pressed = new Set();
    const records = [];
    const observed = [];
    let sink = null;
    let disposed = false;
    let unsupported = null;

    canvas.tabIndex = 0;
    const special = { 32: 'Space', 39: 'Quote', 44: 'Comma', 45: 'Minus', 46: 'Period', 47: 'Slash', 59: 'Semicolon', 61: 'Equal', 91: 'BracketLeft', 92: 'Backslash', 93: 'BracketRight', 96: 'Backquote', 256: 'Escape', 257: 'Enter', 258: 'Tab', 259: 'Backspace', 260: 'Insert', 261: 'Delete', 262: 'ArrowRight', 263: 'ArrowLeft', 264: 'ArrowDown', 265: 'ArrowUp', 266: 'PageUp', 267: 'PageDown', 268: 'Home', 269: 'End', 280: 'CapsLock', 281: 'ScrollLock', 282: 'NumLock', 283: 'PrintScreen', 284: 'Pause', 330: 'NumpadDecimal', 331: 'NumpadDivide', 332: 'NumpadMultiply', 333: 'NumpadSubtract', 334: 'NumpadAdd', 335: 'NumpadEnter', 336: 'NumpadEqual', 340: 'ShiftLeft', 341: 'ControlLeft', 342: 'AltLeft', 343: 'MetaLeft', 344: 'ShiftRight', 345: 'ControlRight', 346: 'AltRight', 347: 'MetaRight', 348: 'ContextMenu' };
    const byCode = new Map(Object.entries(special).map(([key, code]) => [code, Number(key)]));

    for (let key = 65; key <= 90; key++) {
        byCode.set(`Key${String.fromCharCode(key)}`, key);
    }

    for (let key = 48; key <= 57; key++) {
        byCode.set(`Digit${String.fromCharCode(key)}`, key);
    }

    for (let key = 290; key <= 314; key++) {
        byCode.set(`F${key - 289}`, key);
    }

    for (let key = 320; key <= 329; key++) {
        byCode.set(`Numpad${key - 320}`, key);
    }

    /**
     * Retains a bounded diagnostic event history.
     *
     * @param {Event} event - Owned DOM event.
     */
    const observe = (event) => {
        if (observed.length === 256) {
            observed.shift();
        }

        observed.push(event);
    };

    /**
     * Checks whether this owner receives keyboard input.
     *
     * @returns {boolean} Whether the owner has focus.
     */
    const ownsFocus = () => document.activeElement === canvas || (sink !== null && document.activeElement === sink);
    /**
     * Records a physical press and leaves printable text to beforeinput.
     *
     * @param {Event} event - Owned DOM event.
     */
    const down = (event) => {
        if (!ownsFocus()) {
            return;
        }

        pressed.add(event.code);

        if (!sink) {
            event.preventDefault();

            return;
        }

        const key = byCode.get(event.code);

        if (key === undefined) {
            unsupported = `Unqualified physical key: ${event.code}`;

            return;
        }

        records.push(`K,${key},${event.repeat ? 2 : 1}`);
        observe({ type: event.type, code: event.code, key: event.key, repeat: event.repeat, trusted: event.isTrusted });

        if (event.ctrlKey || event.metaKey || ['Backspace', 'Delete', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
            event.preventDefault();
        }
    };

    /**
     * Records release of a key held by this owner.
     *
     * @param {Event} event - Owned DOM event.
     */
    const up = (event) => {
        if (pressed.delete(event.code) && sink && byCode.has(event.code)) {
            records.push(`K,${byCode.get(event.code)},0`);
        }
    };

    /**
     * Releases all held keys when focus leaves the owner.
     *
     * @param {Event} event - Owned DOM event.
     */
    const clear = (event) => {
        if (sink) {
            if (event) {
                observe({ type: event.type, trusted: event.isTrusted });
            }

            for (const code of pressed) {
                if (byCode.has(code)) {
                    records.push(`K,${byCode.get(code)},0`);
                }
            }
        }

        pressed.clear();
    };

    /**
     * Queues cancelable text input without retaining browser text.
     *
     * @param {Event} event - Owned DOM event.
     */
    const before = (event) => {
        observe({ type: event.type, inputType: event.inputType, data: event.data, composing: event.isComposing, cancelable: event.cancelable, trusted: event.isTrusted });

        if (event.isComposing || !event.cancelable) {
            unsupported = 'Unqualified composition/noncancelable text input';

            return;
        }

        if (event.inputType === 'insertText' && event.data !== null) {
            for (const character of event.data) {
                records.push(`C,${character.codePointAt(0)},0`);
            }
        } else if (!event.inputType.startsWith('delete')) {
            unsupported = `Unqualified text input: ${event.inputType}`;
        }

        event.preventDefault();
    };

    /**
     * Rejects text input that bypassed the qualified beforeinput path.
     *
     * @param {Event} event - Owned DOM event.
     */
    const input = (event) => {
        unsupported = `Unqualified input without canceled beforeinput: ${event.inputType}`;
        sink.value = '';
    };

    /**
     * Releases state when the document loses visibility.
     */
    const visible = () => {
        if (!sink || document.hidden) {
            clear();
        }
    };

    globalThis.addEventListener('keydown', down);
    globalThis.addEventListener('keyup', up);
    globalThis.addEventListener('blur', clear);
    canvas.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', visible);

    /**
     * Checks native callback lifetime and admitted input state.
     *
     * @param {object} lib - Java callback library.
     */
    async function owner(lib) {
        if (disposed || !canvas.isConnected) {
            throw await new (await lib.java.lang.IllegalStateException)('Disposed keyboard owner');
        }

        if (unsupported) {
            throw await new (await lib.java.lang.UnsupportedOperationException)(unsupported);
        }
    }

    /**
     * Checks whether this owner receives keyboard input.
     *
     * @returns {boolean} Whether the owner has focus.
     */
    const snapshot = () => ({ held: [...pressed], pending: records.length, observed: [...observed], disposed, sinkValue: sink?.value || '', focused: ownsFocus() });
    /**
     * Removes the owned listeners, sink and queued input.
     */
    const dispose = () => {
        if (disposed) {
            return;
        }

        clear();
        records.length = 0;
        disposed = true;
        globalThis.removeEventListener('keydown', down);
        globalThis.removeEventListener('keyup', up);
        globalThis.removeEventListener('blur', clear);
        canvas.removeEventListener('blur', clear);
        document.removeEventListener('visibilitychange', visible);

        if (sink) {
            sink.removeEventListener('blur', clear);
            sink.removeEventListener('beforeinput', before);
            sink.removeEventListener('input', input);
            sink.remove();
        }
    };

    return {
        natives: {
            /**
             * Reports the lifetime of the original keyboard adapter.
             *
             * @returns {boolean} Whether the canvas owner is live.
             */
            Java_port_host_BrowserKeyboard_created() {
                return !disposed && canvas.isConnected;
            },
            /**
             * Queries the same physical held state used by event input.
             *
             * @param {object} lib - Java callback library.
             * @param {number} key - Original GLFW physical key code.
             * @returns {Promise<number>} One for a held physical key, otherwise zero.
             */
            async Java_port_host_BrowserKeyboard_key(lib, key) {
                await owner(lib);

                if ((key === 161 || key === 162) && [...pressed].some((code) => !code || code === 'Unidentified' || code.startsWith('Intl'))) {
                    throw await new (await lib.java.lang.UnsupportedOperationException)('International WORLD key mapping unavailable');
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

                return code && pressed.has(code) ? 1 : 0;
            },
            /**
             * Transfers queued events to the Java original-vendor producer.
             *
             * @param {object} lib - Java callback library.
             * @returns {Promise<string>} Queued event records.
             */
            async Java_port_host_BrowserKeyboardEvents_drain(lib) {
                await owner(lib);

                if (!sink) {
                    throw await new (await lib.java.lang.IllegalStateException)('Keyboard text events are not enabled');
                }

                return records.splice(0).join('\n');
            },
        },
        /**
         * Enables one input sink and event queue on this held-key owner.
         *
         * @returns {object} Event focus, snapshot and cleanup methods.
         */
        enableTextEvents() {
            if (disposed || !canvas.isConnected) {
                throw new Error('Disposed keyboard owner');
            }

            if (!sink) {
                if (pressed.size) {
                    throw new Error('Enable keyboard text events before pressing keys');
                }

                sink = document.createElement('textarea');
                sink.setAttribute('aria-label', 'Owned keyboard input');
                sink.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0';
                document.body.append(sink);
                sink.addEventListener('blur', clear);
                sink.addEventListener('beforeinput', before);
                sink.addEventListener('input', input);
            }

            return { /**
                      * Focuses this owner’s text input sink.
                      */
                focusText() {
                    sink.focus();
                }, snapshot, dispose,
            };
        },
        dispose,
    };
}
