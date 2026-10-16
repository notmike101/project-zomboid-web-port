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
        throw new RangeError('Source client layout exceeds the 64 KiB UTF8 limit.');
    }
}

/**
 * Stage the original source owner's two client layout files, outside actor saves.
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

    const files = new Map();
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
     * Admit only the two source layout files, without path normalization.
     *
     * @param {unknown} path - Requested client file path.
     * @returns {void} Throws on any other path or a disposed handle.
     */
    function requirePath(path) {
        requireActive();

        if (path !== 'layout.ini' && path !== 'entityLayout.ini') {
            throw new RangeError('Only the source client files layout.ini and entityLayout.ini are supported.');
        }
    }

    /**
     * Load once per candidate, retaining no cached value after a failed read.
     *
     * @param {string} path - Validated exact layout file.
     * @returns {{key:string,text:string|null,dirty:boolean}} Candidate-local file state.
     */
    function load(path) {
        let file = files.get(path);

        if (!file) {
            const key = `pz-web-source-files:${JSON.stringify([sourceBuild, ownerId, path])}`;
            const stored = storage.getItem(key);

            if (stored !== null) {
                validateText(stored);
            }

            file = { key, text: stored, dirty: false };
            files.set(path, file);
        }

        return file;
    }

    return {
        /**
         * Read candidate content, optionally staging an actual empty file.
         *
         * @param {string} path - Exactly layout.ini or entityLayout.ini.
         * @param {boolean} [create=false] - Create a missing staged file.
         * @returns {string|null} Text or null for a missing file.
         */
        read(path, create = false) {
            requirePath(path);

            if (typeof create !== 'boolean') {
                throw new TypeError('Source file create must be a boolean.');
            }

            const file = load(path);

            if (file.text === null && create) {
                file.text = '';
                file.dirty = true;
            }

            return file.text;
        },
        /**
         * Validate a complete replacement or append before staging it.
         *
         * @param {string} path - Exactly layout.ini or entityLayout.ini.
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
            const file = load(path);
            const next = append ? (file.text ?? '') + value : value;

            if (append) {
                validateText(next);
            }

            file.text = next;
            file.dirty = true;
        },
        /**
         * Commit each dirty file via synchronous atomic setItem; failed files remain retryable.
         * The Promise converts synchronous failures into rejections for callers.
         *
         * @returns {Promise<void>} Resolves after durable storage accepts the file.
         */
        flush() {
            return new Promise((resolve) => {
                requireActive();

                for (const file of files.values()) {
                    if (file.dirty) {
                        storage.setItem(file.key, file.text);
                        file.dirty = false;
                    }
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
            files.clear();
        },
    };
}
