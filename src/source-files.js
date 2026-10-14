const MAX_FILE_BYTES = 64 * 1_024;
const ENCODER = new TextEncoder();

/**
 * Refuse malformed text and UTF8 overflow without changing staged content.
 *
 * @param {unknown} text - Candidate file text.
 * @returns {void} Throws on invalid or oversized text.
 */
function validateText(text) {
    if (typeof text !== 'string' || !text.isWellFormed()) {
        throw new TypeError('Source file text must be a well-formed string.');
    }

    if (text.length > MAX_FILE_BYTES || ENCODER.encode(text).byteLength > MAX_FILE_BYTES) {
        throw new RangeError('Source layout.ini exceeds the 64 KiB UTF8 limit.');
    }
}

/**
 * Stage the original source owner's single client layout file, outside actor saves.
 * Storage is origin-local; the unchanged source version and owner identify its key.
 *
 * @param {object} options - Actual synchronous client storage and source identity.
 * @param {Storage} options.storage - Origin's native Web Storage dependency.
 * @param {string} options.sourceBuild - Actual source build version.
 * @param {string} options.ownerId - Bound source owner identity.
 * @returns {object} Candidate-local read/write/flush/dispose handle.
 */
export function createSourceFiles({ storage, sourceBuild, ownerId }) {
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
        throw new TypeError('Source files require storage with getItem() and setItem().');
    }

    if (typeof sourceBuild !== 'string' || !sourceBuild || typeof ownerId !== 'string' || !ownerId) {
        throw new TypeError('Source build and owner must be nonempty strings.');
    }

    const key = `pz-web-source-files:${JSON.stringify([sourceBuild, ownerId, 'layout.ini'])}`;
    let loaded = false;
    let text = null;
    let dirty = false;
    let disposed = false;

    /**
     * Reject operations on a released candidate.
     *
     * @returns {void} Throws after disposal.
     */
    function requireActive() {
        if (disposed) {
            throw new Error('Source file handle is disposed.');
        }
    }

    /**
     * Admit only the source layout file, without path normalization.
     *
     * @param {unknown} path - Requested client file path.
     * @returns {void} Throws on any other path or a disposed handle.
     */
    function requirePath(path) {
        requireActive();

        if (path !== 'layout.ini') {
            throw new RangeError('Only the source client file layout.ini is supported.');
        }
    }

    /**
     * Load once per candidate, retaining no cached value after a failed read.
     *
     * @returns {void} Throws rather than resetting invalid durable content.
     */
    function load() {
        if (!loaded) {
            const stored = storage.getItem(key);

            if (stored !== null) {
                validateText(stored);
            }

            text = stored;
            loaded = true;
        }
    }

    return {
        /**
         * Read candidate content, optionally staging an actual empty file.
         *
         * @param {string} path - Exactly layout.ini.
         * @param {boolean} [create=false] - Create a missing staged file.
         * @returns {string|null} Text or null for a missing file.
         */
        read(path, create = false) {
            requirePath(path);

            if (typeof create !== 'boolean') {
                throw new TypeError('Source file create must be a boolean.');
            }

            load();

            if (text === null && create) {
                text = '';
                dirty = true;
            }

            return text;
        },
        /**
         * Validate a complete replacement or append before staging it.
         *
         * @param {string} path - Exactly layout.ini.
         * @param {string} value - Unchanged caller text.
         * @param {boolean} [append=false] - Append to existing or empty content.
         * @returns {void} No durable write until flush.
         */
        write(path, value, append = false) {
            requirePath(path);

            if (typeof append !== 'boolean') {
                throw new TypeError('Source file append must be a boolean.');
            }

            validateText(value);
            load();
            const next = append ? (text ?? '') + value : value;

            if (append) {
                validateText(next);
            }

            text = next;
            dirty = true;
        },
        /**
         * Commit once via synchronous atomic setItem; failures remain retryable.
         * The Promise converts synchronous failures into rejections for callers.
         *
         * @returns {Promise<void>} Resolves after durable storage accepts the file.
         */
        flush() {
            return new Promise((resolve) => {
                requireActive();

                if (dirty) {
                    storage.setItem(key, text);
                    dirty = false;
                }

                resolve();
            });
        },
        /**
         * Invalidate this handle and drop staging without deleting durable data.
         *
         * @returns {void} Repeated disposal is harmless.
         */
        dispose() {
            disposed = true;
            text = null;
            dirty = false;
        },
    };
}
