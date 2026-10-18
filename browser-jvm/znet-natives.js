/**
 * Implements only the two source-qualified ZNet logger natives, without peer/network readiness.
 *
 * @returns {object} Real logger handlers and copied bounded diagnostics.
 */
export function createZNetNatives() {
    let threshold = 4;
    let initialized = false;
    let callCount = 0;
    const calls = [];

    /**
     * Records one actual invocation without retaining an unbounded log.
     *
     * @param {string} operation - Original native operation.
     * @returns {void} Nothing.
     */
    function record(operation) {
        callCount++;
        calls.push({ operation, threshold });

        if (calls.length > 64) {
            calls.shift();
        }
    }

    /**
     * Delivers the original prefixed line through the unchanged original Java callback.
     *
     * @param {object} lib - Current CheerpJ invocation's Java class library.
     * @param {string} text - Native logger text with its original newline.
     * @returns {Promise<void>} Callback completion or the real Java failure.
     */
    async function emit(lib, text) {
        if (initialized && threshold <= 2) {
            const bridge = await lib.port.host.BrowserZNet;

            await bridge.deliver(`ZNet: ${text}`);
        }
    }

    return {
        natives: {
            /**
             * Initializes logging and emits the original informational line when enabled.
             *
             * @param {object} lib - Actual invocation library.
             * @returns {Promise<void>} Original callback completion.
             */
            async Java_zombie_core_znet_ZNet_init(lib) {
                record('init');
                initialized = true;
                await emit(lib, 'ZNet loaded\n');
            },
            /**
             * Stores the original integer threshold and emits its informational transition.
             *
             * @param {object} lib - Actual invocation library.
             * @param {number} value - Original Java severity integer.
             * @returns {Promise<void>} Original callback completion.
             */
            async Java_zombie_core_znet_ZNet_setLogLevel(lib, value) {
                threshold = value;
                record('level');
                await emit(lib, `SetLogLevel ${value}\n`);
            },
        },
        /**
         * Copies logger state for ownership diagnostics.
         *
         * @returns {object} Count and most recent actual invocations.
         */
        diagnostics() {
            return { initialized, threshold, callCount, calls: calls.map((call) => ({ ...call })) };
        },
    };
}
