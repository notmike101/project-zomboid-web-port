const readSha = '07dc21543c6c963af584769d756caaa50066745c139295c536117699d2b5e71e';
const windowChunks = 8;

/**
 * Releases consumed HTTP asset chunks while preserving original range reads.
 *
 * @param {object} mount - The original, read-only /app/ HTTP mount.
 * @returns {Promise<object>} Owned diagnostics and restoration.
 */
export async function installAssetStreaming(mount) {
    const original = mount.inodeOps;
    const source = new TextEncoder().encode(Function.prototype.toString.call(original.readAsync));
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', source)), (byte) => byte.toString(16).padStart(2, '0')).join('');

    if (mount.mountPoint !== '/app/' || mount.resTrace || mount.chunkSize !== 131_072
        || original.writeAsync !== null || digest !== readSha) {
        throw new Error('Unqualified HTTP asset read implementation');
    }

    const pending = new WeakMap();
    let active = true;
    let reads = 0;
    let evictedBytes = 0;
    let evictedChunks = 0;

    /**
     * Keeps a small seek window once all reads sharing an inode have completed.
     * Pending download callback arrays are never removed.
     *
     * @param {object} file - Original runtime inode.
     * @param {number} end - Last consumed byte position.
     */
    function trim(file, end) {
        const last = Math.max(0, Math.ceil(end / mount.chunkSize) - 1);
        const first = Math.max(0, last - windowChunks + 1);

        for (let index = 0; index < file.chunks.length; index++) {
            const chunk = file.chunks[index];

            if ((index < first || index > last + 1) && chunk instanceof Uint8Array) {
                evictedBytes += chunk.byteLength;
                evictedChunks++;
                file.chunks[index] = null;
            }
        }
    }

    const owned = {
        ...original,
        /**
         * Delegates exact reads and errors; releases only already copied bytes.
         *
         * @param {...unknown} args - Original inode read arguments.
         * @returns {unknown} Original callback-based return.
         */
        readAsync(...args) {
            const [file, offset, , , , , callback] = args;

            if (!active || file.parent !== mount || !/^\/(?:media|prepared)\//u.test(file.path)) {
                return Reflect.apply(original.readAsync, this, args);
            }

            const state = pending.get(file) ?? { count: 0, end: 0 };

            pending.set(file, state);
            state.count++;
            reads++;
            /**
             * Completes the original read before dropping consumed cache entries.
             *
             * @param {number} result - Original byte count or error.
             * @returns {unknown} Original callback result.
             */
            args[6] = (result) => {
                state.end = offset + Math.max(0, result);

                try {
                    return callback(result);
                } finally {
                    state.count--;

                    if (active && state.count === 0) {
                        trim(file, state.end);
                    }
                }
            };

            return Reflect.apply(original.readAsync, this, args);
        },
    };

    mount.inodeOps = owned;

    return {
        /**
         * Reports scalar read and eviction counters.
         *
         * @returns {object} Current owner counters.
         */
        snapshot() {
            return { active, reads, evictedBytes, evictedChunks, windowBytes: (windowChunks + 1) * mount.chunkSize };
        },
        /** Restores the mount; existing inode references delegate after disposal. */
        dispose() {
            if (mount.inodeOps !== owned) {
                throw new Error('HTTP asset streaming owner changed');
            }

            active = false;
            mount.inodeOps = original;
        },
    };
}
