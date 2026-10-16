/**
 * Creates a context-owned monotonic seconds clock; no GLFW initialization is implied.
 *
 * @returns {object} Native callback map and read diagnostics.
 */
export function createBrowserClock() {
    let previous = -Infinity;
    let reads = 0;

    return {
        natives: {
            /**
             * Reads actual elapsed browser time for the declared Java double result.
             *
             * @returns {number} Finite monotonic seconds.
             */
            Java_port_host_BrowserClock_seconds() {
                const seconds = performance.now() / 1_000;

                if (!Number.isFinite(seconds) || seconds < previous) {
                    throw new Error('Invalid browser monotonic clock');
                }

                previous = seconds;
                reads++;

                return seconds;
            },
        },
        /**
         * Reports actual reads for qualification.
         *
         * @returns {object} Read count and last sampled seconds.
         */
        snapshot() {
            return { reads, lastSeconds: previous };
        },
    };
}
