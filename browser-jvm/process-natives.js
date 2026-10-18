/**
 * Reports unavailable external OS processes through the original JDK exception path.
 * The browser has no native executable launcher; no command or environment is retained.
 *
 * @returns {object} Native callbacks and owner-local rejection observations.
 */
export function createProcessNatives() {
    let rejected = 0;

    return {
        natives: {
            /**
             * Rejects native process creation before the runtime reaches missing pipe imports.
             * Original ProcessBuilder and callers retain their normal Java catch/finally paths.
             *
             * @param {object} lib - Current native invocation's Java class namespace.
             * @returns {Promise<never>} Actual Java IOException; no process was created.
             */
            async Java_java_lang_ProcessImpl_forkAndExec(lib) {
                rejected++;
                const IOException = await lib.java.io.IOException;

                throw await new IOException('External native processes are unavailable in this browser');
            },
        },
        /**
         * Copies the count without exposing commands or environment data.
         *
         * @returns {object} Rejected native process launches.
         */
        diagnostics() {
            return { rejected };
        },
    };
}
