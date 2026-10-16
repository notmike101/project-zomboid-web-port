/** @file Automatic, read-only access to separately provisioned static content. */
const MAX_READ_BYTES = 16 * 1_024 * 1_024;

/**
 * Validate a literal relative file path before it becomes a URL.
 *
 * @param {unknown} path - Manifest path.
 * @returns {string} Safe, unchanged path.
 */
function contentPath(path) {
    if (typeof path !== 'string' || !path || path.length > 4_096
        || /[\\:%?#]/u.test(path)
        || path.split('/').some((part) => !part || part === '.' || part === '..')) {
        throw new TypeError(`Invalid content path: ${String(path)}`);
    }

    for (let index = 0; index < path.length; index++) {
        const code = path.codePointAt(index);

        if (code <= 0x1F || code === 0x7F) {
            throw new TypeError(`Invalid content path: ${path}`);
        }
    }

    return path;
}

/**
 * Recognize a JSON object rather than an array/null.
 *
 * @param {unknown} value - JSON value.
 * @returns {boolean} Whether it is an object.
 */
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate the manifest and all startup/mod references before any asset request.
 *
 * @param {object} manifest - Parsed manifest.
 * @returns {Map<string, object>} File entries by literal path.
 */
function validateManifest(manifest) {
    if (!record(manifest) || manifest.format !== 'pz-web-content-directory') {
        throw new TypeError('Invalid content manifest format');
    }

    if (manifest.formatVersion !== 1) {
        throw new TypeError(`Unsupported content manifest version ${manifest.formatVersion}; expected 1`);
    }

    if (!record(manifest.sourceBuild) || !Array.isArray(manifest.files) || !Array.isArray(manifest.mods)) {
        throw new TypeError('Invalid content manifest sourceBuild/files/mods schema');
    }

    const files = new Map();

    for (const entry of manifest.files) {
        if (!record(entry)) {
            throw new TypeError('Invalid content file entry');
        }

        const path = contentPath(entry.path);

        if (files.has(path)) {
            throw new TypeError(`Duplicate content path: ${path}`);
        }

        if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
            throw new TypeError(`Invalid content size: ${path}`);
        }

        if (!Number.isSafeInteger(entry.lastModified) || entry.lastModified < 0
            || (entry.sha256 !== undefined && !/^[\dA-Fa-f]{64}$/u.test(entry.sha256))) {
            throw new TypeError(`Invalid content metadata: ${path}`);
        }

        files.set(path, Object.freeze({ ...entry }));
    }

    /**
     * Require a referenced file to belong to this manifest.
     *
     * @param {string} path - Startup or mod reference.
     * @returns {void}
     */
    function reference(path) {
        contentPath(path);

        if (!files.has(path)) {
            throw new TypeError(`Content missing from manifest: ${path}`);
        }
    }

    const startup = manifest.startup;

    if (!record(startup) || !Array.isArray(startup.packs) || !startup.packs.length
        || !Array.isArray(startup.cells) || !startup.cells.length
        || !record(startup.character) || !record(startup.spawn)
        || !Number.isFinite(startup.spawn.x) || !Number.isFinite(startup.spawn.y)) {
        throw new TypeError('Invalid content startup schema');
    }

    for (const path of startup.packs) {
        reference(path);
    }

    for (const cell of startup.cells) {
        if (!record(cell) || !Number.isSafeInteger(cell.x) || !Number.isSafeInteger(cell.y)) {
            throw new TypeError('Invalid content startup cell coordinates');
        }

        reference(cell.navigation);
        reference(cell.header);
        reference(cell.lotpack);
    }

    for (const key of ['model', 'idle', 'walk', 'texture']) {
        reference(startup.character[key]);
    }

    if (startup.tileDefinitions !== undefined) {
        if (!Array.isArray(startup.tileDefinitions) || startup.tileDefinitions.length === 0) {
            throw new TypeError('Invalid content tile definition sources');
        }

        for (const source of startup.tileDefinitions) {
            if (!record(source) || !Number.isSafeInteger(source.fileId)) {
                throw new TypeError('Invalid content tile definition fileId');
            }

            reference(source.path);
        }
    }

    if (startup.tileDepth !== undefined) {
        if (!record(startup.tileDepth) || !Array.isArray(startup.tileDepth.images) || startup.tileDepth.images.length === 0) {
            throw new TypeError('Invalid content tile depth sources');
        }

        reference(startup.tileDepth.assignments);

        for (const path of startup.tileDepth.images) {
            reference(path);
        }

        if (startup.tileDepth.seams !== undefined) {
            reference(startup.tileDepth.seams);
        }
    }

    if (startup.audio !== undefined) {
        if (!record(startup.audio)) {
            throw new TypeError('Invalid content startup audio');
        }

        for (const role of ['footstep', 'doorOpen', 'doorClose']) {
            reference(startup.audio[role]);
        }
    }

    for (const mod of manifest.mods) {
        if (!record(mod) || !['javascript', 'native-lua'].includes(mod.kind) || !Array.isArray(mod.files)) {
            throw new TypeError('Invalid content mod schema');
        }

        const root = contentPath(mod.root);

        for (const path of mod.files) {
            reference(path);

            if (!path.startsWith(`${root}/`)) {
                throw new TypeError(`Content mod path escapes its root: ${path}`);
            }
        }
    }

    return files;
}

/**
 * Cancel an unaccepted response before consuming its body.
 *
 * @param {Response} response - Unaccepted HTTP response.
 * @param {string} message - Actionable failure.
 * @returns {Promise<never>} Always rejects after cancellation.
 */
async function refuse(response, message) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(message);
}

/**
 * Consume a bounded stream, enforcing exact lengths without eager whole-bank reads.
 *
 * @param {Response} response - Accepted response.
 * @param {number|null} expected - Exact byte length, or null for a manifest.
 * @param {string} path - Progress/failure source path.
 * @param {object} options - Signal and progress callback.
 * @param {AbortSignal} [options.signal] - Signal canceling the active session and pending reads.
 * @param {(event:{path:string,loaded:number,total:number|null})=>void} [options.onProgress] - Receive bounded read progress.
 * @returns {Promise<ArrayBuffer>} Validated bytes.
 */
async function readBody(response, expected, path, { signal, onProgress }) {
    if (signal?.aborted) {
        await response.body?.cancel().catch(() => undefined);
        signal.throwIfAborted();
    }

    const limit = expected ?? MAX_READ_BYTES;
    const length = response.headers.get('Content-Length');

    if (length !== null && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length))
        || Number(length) > limit || (expected !== null && Number(length) !== expected))) {
        return refuse(response, `Content length mismatch or read limit exceeded: ${path}`);
    }

    if (!response.body) {
        if (expected === 0) {
            return new ArrayBuffer(0);
        }

        return refuse(response, `Truncated content source: ${path}`);
    }

    const reader = response.body.getReader();
    const output = expected === null ? null : new Uint8Array(expected);
    const chunks = [];
    let loaded = 0;

    /** Cancel pending reads when the content session is aborted. */
    const abort = () => {
        void reader.cancel().catch(() => undefined);
    };

    signal?.addEventListener('abort', abort, { once: true });
    try {
        signal?.throwIfAborted();

        /* eslint-disable no-await-in-loop -- Streaming prevents unbounded response allocations. */
        for (;;) {
            const { done, value } = await reader.read();

            signal?.throwIfAborted();

            if (done) {
                break;
            }

            if (loaded + value.byteLength > limit) {
                throw new Error(`Oversized content source/read limit exceeded: ${path}`);
            }

            if (output) {
                output.set(value, loaded);
            } else {
                chunks.push(value);
            }

            loaded += value.byteLength;
            onProgress?.({ path, loaded, total: expected ?? (length === null ? null : Number(length)) });
        }

        /* eslint-enable no-await-in-loop */
        if (expected !== null && loaded !== expected) {
            throw new Error(`Truncated content source: ${path}; expected ${expected}, received ${loaded} bytes`);
        }

        if (output) {
            return output.buffer;
        }

        const joined = new Uint8Array(loaded);
        let offset = 0;

        for (const chunk of chunks) {
            joined.set(chunk, offset);
            offset += chunk.byteLength;
        }

        return joined.buffer;
    } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
    } finally {
        signal?.removeEventListener('abort', abort);
        reader.releaseLock();
    }
}

/**
 * Open content automatically; assets remain outside the application/release.
 * All asset requests stay under the manifest's same-origin content directory.
 * Reads, including individual PNG pages, are limited to 16 MiB each.
 *
 * @param {string|URL} [manifestUrl] - Static manifest URL; defaults beside the app's source directory.
 * @param {{signal?:AbortSignal,onProgress?:(event:{path:string,loaded:number,total:number|null})=>void}} [options] - Session abort/progress.
 * @returns {Promise<{manifest:object,getFile:(path:string)=>object}>} Validated manifest and lazy HTTP sources.
 */
export async function openContentDirectory(manifestUrl = '../content/manifest.json', options = {}) {
    const { signal } = options;
    const url = new URL(manifestUrl, import.meta.url);

    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
        || (globalThis.location && url.origin !== globalThis.location.origin)) {
        throw new TypeError('Content manifest must use an approved same-origin HTTP URL');
    }

    const root = new URL('./', url);

    signal?.throwIfAborted();
    const response = await fetch(url, { signal, redirect: 'error', cache: 'no-store' });

    if (response.status !== 200) {
        return refuse(response, `Content missing: manifest ${url.pathname} (HTTP ${response.status}); provision the content directory`);
    }

    let manifest;

    try {
        manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBody(response, null, 'manifest.json', options)));
    } catch (error) {
        if (signal?.aborted) {
            signal.throwIfAborted();
        }

        throw new Error('Invalid or truncated content manifest', { cause: error });
    }

    const files = validateManifest(manifest);

    /**
     * Obtain a lazy source with the same slice/arrayBuffer contract as Blob cursors.
     *
     * @param {string} path - Exact manifest path.
     * @returns {object} Read-only HTTP source; decoder inputs use toFile().
     */
    function getFile(path) {
        contentPath(path);
        const entry = files.get(path);

        if (!entry) {
            throw new Error(`Content missing from manifest: ${path}`);
        }

        const assetUrl = new URL(path.split('/').map(encodeURIComponent).join('/'), root);

        if (assetUrl.origin !== root.origin || !assetUrl.pathname.startsWith(root.pathname)) {
            throw new TypeError(`Content path escapes manifest directory: ${path}`);
        }

        const name = path.split('/').at(-1);
        const type = /\.png$/iu.test(name) ? 'image/png' : 'application/octet-stream';

        /**
         * Fetch exactly one half-open range, rejecting ignored/stale/truncated ranges.
         *
         * @param {number} start - Inclusive byte offset.
         * @param {number} end - Exclusive byte offset.
         * @returns {Promise<ArrayBuffer>} Exact byte window.
         */
        async function read(start, end) {
            signal?.throwIfAborted();
            const count = end - start;

            if (count > MAX_READ_BYTES) {
                throw new RangeError(`Content read limit is 16 MiB: ${path}; use bounded slices`);
            }

            if (!count) {
                return new ArrayBuffer(0);
            }

            const result = await fetch(assetUrl, {
                signal, redirect: 'error', cache: 'no-store', headers: { Range: `bytes=${start}-${end - 1}` },
            });

            if (result.status !== 206) {
                return refuse(result, result.status === 404
                    ? `Content missing: ${path} (HTTP 404); provision the content directory`
                    : `Content range requires HTTP 206; server ignored or refused the range for ${path} (HTTP ${result.status})`);
            }

            const range = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(result.headers.get('Content-Range') ?? '');

            if (!range || Number(range[1]) !== start || Number(range[2]) !== end - 1) {
                return refuse(result, `Invalid Content-Range for ${path}; expected bytes ${start}-${end - 1}/${entry.size}`);
            }

            if (Number(range[3]) !== entry.size) {
                return refuse(result, `Stale manifest: ${path}; expected total ${entry.size}, received ${range[3]}`);
            }

            return readBody(result, count, path, options);
        }

        const source = {
            name, size: entry.size, lastModified: entry.lastModified, relativePath: path,
            /**
             * Return a lazy bounded slice; no bytes are fetched until arrayBuffer().
             *
             * @param {number} start - Inclusive offset.
             * @param {number} end - Exclusive offset.
             * @returns {{arrayBuffer:()=>Promise<ArrayBuffer>}} Lazy HTTP window.
             */
            slice(start, end) {
                if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > entry.size) {
                    throw new RangeError(`Invalid content byte range ${start}..${end}: ${path}`);
                }

                return Object.freeze({
                    /**
                     * Read this exact bounded byte window.
                     *
                     * @returns {Promise<ArrayBuffer>} Validated slice bytes.
                     */
                    arrayBuffer: () => read(start, end),
                });
            },
            /**
             * Read a small source; large sources require slices.
             *
             * @returns {Promise<ArrayBuffer>} Validated source bytes.
             */
            arrayBuffer() {
                return read(0, entry.size);
            },
            /**
             * Decode a small UTF-8 model or script.
             *
             * @returns {Promise<string>} Decoded source text.
             */
            async text() {
                return new TextDecoder('utf-8', { fatal: true }).decode(await read(0, entry.size));
            },
            /**
             * Materialize a small decoder input as a blob.
             *
             * @returns {Promise<Blob>} Source blob.
             */
            async blob() {
                return new Blob([await read(0, entry.size)], { type });
            },
            /**
             * Materialize a small renderer input automatically.
             *
             * @returns {Promise<File>} Source file preserving manifest metadata.
             */
            async toFile() {
                return new File([await read(0, entry.size)], name, { type, lastModified: entry.lastModified });
            },
        };

        return Object.freeze(source);
    }

    return Object.freeze({ manifest, getFile });
}
