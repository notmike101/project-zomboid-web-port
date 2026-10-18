/**
 * Throws a genuine Java exception across the current native-call boundary.
 *
 * @param {object} lib - Current Java native class namespace.
 * @param {string} message - Unsupported operation with actual observed context.
 * @returns {Promise<never>} Rejection with the real Java exception object.
 */
async function unsupported(lib, message) {
    const Exception = await lib.java.lang.UnsupportedOperationException;

    throw await new Exception(message);
}

/**
 * Owns the real browser Gamepad API boundary for the qualified keyboard-only path.
 * Connected devices remain explicit errors until their complete state contract is qualified.
 *
 * @returns {object} Native handlers, copied diagnostics and owned listener cleanup.
 */
export function createControllerNatives() {
    let handlers;
    let pendingEvent;
    let samples = 0;
    let guardRejections = 0;
    let mapping;
    const recentSamples = [];
    const queries = [];
    const events = [];

    /**
     * Samples the actual sparse browser array and refuses to hide connected devices.
     *
     * @param {object} lib - Current Java native class namespace.
     * @returns {Promise<void>} Completion only when the genuine observation has no device.
     */
    async function sample(lib) {
        if (typeof navigator.getGamepads !== 'function') {
            return unsupported(lib, 'Actual Gamepad API unavailable');
        }

        const actual = Array.from(navigator.getGamepads(), (pad, slot) => pad
            ? {
                    index: pad.index, slot, id: pad.id, mapping: pad.mapping, connected: pad.connected,
                }
            : null);

        samples++;
        recentSamples.push(actual);

        if (recentSamples.length > 64) {
            recentSamples.shift();
        }

        const devices = actual.filter(Boolean);

        if (devices.length) {
            await unsupported(lib, `Connected controller unsupported: ${JSON.stringify(devices)}`);
        }
    }

    /**
     * Records the first actual lifecycle event until the Java owner rejects it.
     *
     * @param {GamepadEvent} event - Browser event; untrusted events are also explicit errors.
     */
    function receive(event) {
        const observed = { type: event.type, trusted: event.isTrusted };

        if (event.gamepad) {
            Object.assign(observed, { index: event.gamepad.index, id: event.gamepad.id, mapping: event.gamepad.mapping });
        }

        pendingEvent ||= observed;

        if (events.length < 64) {
            events.push(observed);
        }
    }

    /** Releases only listeners installed by this service. */
    function dispose() {
        if (handlers) {
            for (const [type, handler] of Object.entries(handlers)) {
                removeEventListener(type, handler);
            }

            handlers = undefined;
        }
    }

    return {
        dispose,
        /**
         * Copies bounded observations without exposing the mutable listener owner.
         *
         * @returns {object} Actual sample, mapping and lifecycle observations.
         */
        diagnostics: () => ({
            samples, recentSamples: recentSamples.map((slots) => slots.map((pad) => pad ? { ...pad } : null)),
            queries: [...queries], events: events.map((event) => ({ ...event })),
            guardRejections, mapping: mapping ? { ...mapping } : undefined, listeners: handlers ? 2 : 0,
        }),
        natives: {
            /**
             * Samples real device presence before answering the original GLFW index query.
             *
             * @param {object} lib - Current Java native class namespace.
             * @param {number} index - Original index already validated by the Java owner.
             * @returns {Promise<boolean>} False only after an actual no-device observation.
             */
            async Java_port_host_BrowserControllers_present(lib, index) {
                await sample(lib);

                if (queries.length < 64) {
                    queries.push(index);
                }

                return false;
            },
            /**
             * Hashes the actual original mapping payload while reporting unsupported registration.
             *
             * @param {object} lib - Current Java native class namespace.
             * @param {Int8Array} bytes - Original UTF-8 buffer copied by the Java transport owner.
             * @returns {Promise<void>} Completion of payload observation, or a real Java platform exception.
             */
            async Java_port_host_BrowserControllers_mapping(lib, bytes) {
                const payload = new Uint8Array(bytes);
                let digest;

                try {
                    digest = await crypto.subtle.digest('SHA-256', payload);
                } catch (error) {
                    return unsupported(lib, `Mapping payload digest unavailable: ${error.name}`);
                }

                mapping = { supported: false, bytes: payload.length, sha256: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('') };
            },
            /**
             * Installs real lifecycle listeners after verifying the initial browser sample.
             *
             * @param {object} lib - Current Java native class namespace.
             */
            async Java_port_host_BrowserControllers_openEvents(lib) {
                await sample(lib);

                if (handlers) {
                    throw new Error('Duplicate controller event owner');
                }

                handlers = { gamepadconnected: receive, gamepaddisconnected: receive };

                for (const [type, handler] of Object.entries(handlers)) {
                    addEventListener(type, handler);
                }
            },
            /**
             * Rejects unsupported changes on the Java owner before another frame can complete.
             *
             * @param {object} lib - Current Java native class namespace.
             */
            async Java_port_host_BrowserControllers_checkEvents(lib) {
                await sample(lib);

                if (pendingEvent) {
                    guardRejections++;
                    await unsupported(lib, `Unsupported controller event: ${JSON.stringify(pendingEvent)}`);
                }
            },
            /** Releases the genuine controller listener owner. */
            Java_port_host_BrowserControllers_closeEvents: dispose,
        },
    };
}
