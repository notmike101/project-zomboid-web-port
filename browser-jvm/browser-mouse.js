/* eslint-disable unicorn/consistent-function-scoping -- Event handlers belong to the canvas lifecycle. */
/**
 * Real mouse events; wheel, pointer lock, cursors and touch are outside this component.
 *
 * @param {HTMLCanvasElement} canvas - Connected owner canvas.
 * @returns {object} Native callbacks, diagnostics and disposal.
 */
export function createBrowserMouse(canvas) {
    if (!(canvas instanceof HTMLCanvasElement) || !canvas.isConnected) {
        throw new TypeError('Connected canvas required');
    }

    const held = new Set();
    const events = [];
    let delivered = 0;
    let disposed = false;
    const map = [0, 2, 1, 3, 4, 5, 6, 7];
    /**
     * Rejects mouse events synthesized from touch.
     *
     * @param {MouseEvent} e - Browser mouse event.
     * @returns {boolean} Whether this is a mouse input.
     */
    const isMouse = (e) => !e.sourceCapabilities?.firesTouchEvents;
    /**
     * Queues unbounded canvas-relative coordinates for original vendor clipping.
     *
     * @param {MouseEvent} e - Browser movement.
     */
    const move = (e) => {
        if (!isMouse(e) || (!held.size && e.target !== canvas)) {
            return;
        }

        const r = canvas.getBoundingClientRect();

        events.push(
            `M,${((e.clientX - r.left) * canvas.width) / r.width},${((e.clientY - r.top) * canvas.height) / r.height}`,
        );
    };

    /**
     * Queues a press and retains independently held chord buttons.
     *
     * @param {MouseEvent} e - Browser press.
     */
    const down = (e) => {
        if (
            !isMouse(e)
            || map[e.button] === undefined
            || (e.target !== canvas && !held.size)
        ) {
            return;
        }

        canvas.focus({ preventScroll: true });
        move(e);
        held.add(map[e.button]);
        events.push(`B,${map[e.button]},1`);
        e.preventDefault();
    };

    /**
     * Queues the release position before releasing this chord button.
     *
     * @param {MouseEvent} e - Browser release.
     */
    const up = (e) => {
        if (
            !isMouse(e)
            || map[e.button] === undefined
            || !held.has(map[e.button])
        ) {
            return;
        }

        move(e);
        held.delete(map[e.button]);
        events.push(`B,${map[e.button]},0`);
    };

    /**
     * Queues releases when the owning surface loses focus.
     */
    const clear = () => {
        for (const b of held) {
            events.push(`B,${b},0`);
        }

        held.clear();
    };

    /**
     * Releases held buttons when the document becomes hidden.
     */
    const hidden = () => {
        if (document.hidden) {
            clear();
        }
    };

    /**
     * Suppresses the native context menu over the owned canvas.
     *
     * @param {MouseEvent} e - Context menu event.
     * @returns {void} No return value.
     */
    const context = (e) => e.preventDefault();

    globalThis.addEventListener('mousemove', move);
    globalThis.addEventListener('mousedown', down);
    globalThis.addEventListener('mouseup', up);
    canvas.addEventListener('blur', clear);
    globalThis.addEventListener('blur', clear);
    document.addEventListener('visibilitychange', hidden);
    canvas.addEventListener('contextmenu', context);

    /**
     * Throws a genuine Java lifecycle exception after owner removal or disposal.
     *
     * @param {object} lib - Current Java class proxy namespace.
     */
    async function requireOwner(lib) {
        if (disposed || !canvas.isConnected) {
            throw await new (await lib.java.lang.IllegalStateException)(
                'Mouse canvas is disposed or removed',
            );
        }
    }

    return {
        natives: {
            /**
             * Transfers the ordered DOM event batch to the Java polling helper.
             *
             * @param {object} lib - Current Java class proxy namespace.
             * @returns {Promise<string>} Ordered event records.
             */
            async Java_port_host_BrowserMouse_drain(lib) {
                await requireOwner(lib);
                const batch = events.splice(0);

                delivered += batch.length;

                return batch.join('\n');
            },
            /**
             * Reads the held vendor button state for the qualified query.
             *
             * @param {object} lib - Current Java class proxy namespace.
             * @param {number} _window - Preserved vendor window argument.
             * @param {number} index - Vendor button index.
             * @returns {Promise<number>} GLFW-compatible pressed state.
             */
            async Java_port_host_BrowserMouse_button(lib, _window, index) {
                await requireOwner(lib);

                return Number(held.has(index));
            },
        },
        /**
         * Reports owned input state for qualification.
         *
         * @returns {object} Held buttons, queued and delivered events, disposal state.
         */
        snapshot() {
            return {
                held: [...held],
                pending: events.length,
                delivered,
                disposed,
            };
        },
        /**
         * Removes owned listeners and releases held buttons idempotently.
         */
        dispose() {
            if (disposed) {
                return;
            }

            clear();
            disposed = true;
            globalThis.removeEventListener('mousemove', move);
            globalThis.removeEventListener('mousedown', down);
            globalThis.removeEventListener('mouseup', up);
            canvas.removeEventListener('blur', clear);
            globalThis.removeEventListener('blur', clear);
            document.removeEventListener('visibilitychange', hidden);
            canvas.removeEventListener('contextmenu', context);
        },
    };
}
