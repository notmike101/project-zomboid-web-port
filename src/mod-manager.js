/**
 * @file Local multifile mod packages: install, storage, enable/disable, removal,
 * dependency resolution and reload-safe activation.
 *
 * A package is a folder the user picked with `<input type="file" webkitdirectory>`
 * (or any source of the same shape): a root `mod.json` manifest plus every file it
 * needs. Bytes are stored verbatim in IndexedDB and served back at
 * `/__mods__/<id>/<revision>/<path>` by `mod-worker.js`, so a package's own
 * `import './lib/util.js'` and asset fetches keep working through native ESM and
 * URL resolution. Nothing here parses, rewrites or inlines JavaScript.
 *
 * The revision in that URL is a SHA-256 digest of the whole package, so updating a
 * package changes every one of its URLs and no stale module entry can be reused.
 *
 * Trust model: packages are trusted same-origin code, exactly like the mods
 * `src/mods.js` loads. Nothing here is a sandbox. API 0.1.0 also has no live
 * per-mod unload, so `install`, `setEnabled` and `remove` persist configuration for
 * the next `activateEnabled()` (or a reload) and report `requiresReload` honestly:
 * they never claim to undo code that is already running.
 */

/* `mods.js` keeps these patterns private, so the package format mirrors them: a
   manifest accepted by the package manager must also be accepted by the host. */
const MOD_ID_PATTERN = /^[\da-z][\d._a-z-]{0,63}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const REVISION_PATTERN = /^[\da-f]{16}$/;
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/u;
const ENTRY_PATTERN = /\.(?:js|mjs)$/u;

/** Reserved internal attribution id, refused as a package id by the host. */
const RESERVED_ID = 'host';
const MANIFEST_NAME = 'mod.json';
const MAX_FILE_BYTES = 16 * 1_024 * 1_024;
const MAX_PACKAGE_BYTES = 64 * 1_024 * 1_024;
const MAX_MANIFEST_BYTES = 64 * 1_024;
const MAX_PATH_LENGTH = 512;
const MAX_FILES = 512;
const MAX_RECORDED_ERRORS = 20;
const REVISION_LENGTH = 16;

const PACKAGE_DB_NAME = 'pz-mod-packages';
const PACKAGE_SCHEMA_VERSION = 1;
const PACKAGES_STORE = 'packages';
const FILES_STORE = 'files';
const PACKAGE_ID_INDEX = 'packageId';

/** The only path prefix this application's service worker ever intercepts. */
const MOD_URL_PREFIX = '/__mods__/';

/** served types; anything else is refused at install time rather than served. */
const MEDIA_TYPES = new Map([
    ['.js', 'text/javascript; charset=utf-8'],
    ['.mjs', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json'],
    ['.css', 'text/css; charset=utf-8'],
    ['.wasm', 'application/wasm'],
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.gif', 'image/gif'],
    ['.webp', 'image/webp'],
    ['.ico', 'image/x-icon'],
    ['.ogg', 'audio/ogg'],
    ['.mp3', 'audio/mpeg'],
    ['.wav', 'audio/wav'],
    ['.m4a', 'audio/mp4'],
]);

/**
 * One picked file, as a browser `File` supplies it. `webkitRelativePath` is the
 * folder-relative path a directory selection provides; a lone `name` is used when
 * the source has none.
 *
 * @typedef {{ name: string, size: number, webkitRelativePath?: string, arrayBuffer: () => Promise<ArrayBuffer> }} PackageSourceFile
 */
/**
 * A validated manifest with every optional field resolved to its default.
 *
 * @typedef {{ id: string, name: string, version: string, apiVersion: string, description: string, entry: string, dependencies: Record<string, string>, optionalDependencies: Record<string, string>, conflicts: string[], loadBefore: string[], loadAfter: string[], assets: string[], settings: object }} ModPackageManifest
 */
/**
 * One stored package file.
 *
 * @typedef {{ id: string, revision: string, path: string, mime: string, size: number, bytes: ArrayBuffer }} ModStoredFile
 */
/**
 * One stored package record: the manifest plus what the manager recorded about it.
 *
 * @typedef {{ id: string, name: string, version: string, apiVersion: string, description: string, entry: string, dependencies: Record<string, string>, optionalDependencies: Record<string, string>, conflicts: string[], loadBefore: string[], loadAfter: string[], assets: string[], settings: object, revision: string, enabled: boolean, installedAt: string, fileCount: number, totalBytes: number }} ModPackageRecord
 */
/**
 * A stored record detached for the page, with its served URLs.
 *
 * @typedef {{ id: string, name: string, version: string, apiVersion: string, description: string, entry: string, dependencies: Record<string, string>, optionalDependencies: Record<string, string>, conflicts: string[], loadBefore: string[], loadAfter: string[], assets: string[], settings: object, revision: string, enabled: boolean, installedAt: string, fileCount: number, totalBytes: number, urls: { base: string, entry: string } }} ModPackageMetadata
 */
/**
 * The fields `resolveModOrder` reads; both records and metadata satisfy it.
 *
 * @typedef {{ id: string, version: string, apiVersion: string, enabled: boolean, dependencies: Record<string, string>, optionalDependencies: Record<string, string>, conflicts: string[], loadBefore: string[], loadAfter: string[] }} ModPackageResolution
 */
/**
 * One validated package file ready to store.
 *
 * @typedef {{ path: string, bytes: ArrayBuffer, size: number, mime: string }} ModPackageFileEntry
 */
/**
 * A validated package that has not been stored yet.
 *
 * @typedef {{ manifest: ModPackageManifest, revision: string, entries: ModPackageFileEntry[], totalBytes: number }} ModParsedPackage
 */
/**
 * One package the activation actually loaded.
 *
 * @typedef {{ id: string, version: string, name: string, revision: string, url: string }} ModActivation
 */
/**
 * One activation failure, attributed to the package that caused it.
 *
 * @typedef {{ id: string, modId: string, stage: string, message: string }} ModActivationError
 */
/**
 * What `activateEnabled` reports. `skipped` names enabled packages that were never
 * loaded, `disposed` is true when a failure unwound the packages this call loaded
 * (the host has no per-mod unload, so it unloads every mod on that host).
 *
 * @typedef {{ safeMode: boolean, apiVersion: string, order: string[], activated: ModActivation[], errors: ModActivationError[], skipped: string[], disposed: boolean }} ModActivationReport
 */
/**
 * Detached manager evidence from `diagnostics()`.
 *
 * @typedef {{ packageDb: { name: string, schemaVersion: number }, worker: { url: string, scope: string, controlling: boolean }|undefined, apiVersion: string, packages: ModPackageMetadata[], requiresReload: boolean, lastActivation: ModActivationReport|undefined, errors: { id: string, stage: string, message: string }[] }} ModManagerDiagnostics
 */
/**
 * The manager surface returned by `createModManager`.
 *
 * @typedef {{ install: (files: PackageSourceFile[] | FileList) => Promise<ModPackageMetadata & { requiresReload: boolean }>, list: () => Promise<ModPackageMetadata[]>, setEnabled: (id: string, enabled: boolean) => Promise<ModPackageMetadata & { requiresReload: boolean }>, remove: (id: string) => Promise<void>, activateEnabled: (options?: { safeMode?: boolean }) => Promise<ModActivationReport>, diagnostics: () => ModManagerDiagnostics }} ModPackageManager
 */

/**
 * Builds an attributed manager failure.
 *
 * @param {string} id - Package id, manifest name or path the failure is about.
 * @param {string} stage - Lifecycle stage that failed.
 * @param {string} message - Human-readable reason.
 * @param {string[]} [ids] - Every id involved, for dependency and cycle failures.
 * @param {unknown} [cause] - Original failure.
 * @returns {Error} Error named `ModManagerError` carrying `modId`, `stage` and `ids`.
 */
function managerError(id, stage, message, ids, cause) {
    const failure = new Error(`${stage} failed for '${id}': ${message}`);

    failure.name = 'ModManagerError';
    /** @type {string} */
    failure.modId = id;
    /** @type {string} */
    failure.stage = stage;
    failure.ids = ids ?? [];

    if (cause !== undefined) {
        failure.cause = cause;
    }

    return failure;
}

/**
 * Tests one package-relative path: plain ASCII names only, so a stored path can be
 * placed in a URL without escaping and cannot traverse or re-encode into anything.
 *
 * @param {string} path - Candidate package-relative path.
 * @returns {boolean} True when the path may be stored and served.
 */
function isPackagePath(path) {
    if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH || path.startsWith('/')) {
        return false;
    }

    return path.split('/').every((segment) => segment !== '.' && segment !== '..' && segment.length <= MAX_PATH_LENGTH && PATH_SEGMENT_PATTERN.test(segment));
}

/**
 * Lowercase extension of a package path.
 *
 * @param {string} path - Package-relative path.
 * @returns {string} Extension including the dot, or the empty string.
 */
function extensionOf(path) {
    const dot = path.lastIndexOf('.');

    return dot === -1 ? '' : path.slice(dot).toLowerCase();
}

/**
 * Normalises the picked files onto package-relative paths and rejects unsafe ones.
 *
 * A shared first segment (what `webkitRelativePath` always carries for a directory
 * selection) is stripped, so paths are relative to the package root. Traversal,
 * absolute paths, backslash escapes, NUL, control characters and duplicate targets
 * are all refused.
 *
 * @param {PackageSourceFile[]} sources - Picked files.
 * @returns {string[]} One validated path per picked file, same order.
 * @throws {Error} Named `ModManagerError` (`stage: 'package'`) for an unsafe path.
 */
function packagePaths(sources) {
    const raw = sources.map((source) => String(typeof source.webkitRelativePath === 'string' && source.webkitRelativePath !== '' ? source.webkitRelativePath : source.name).replaceAll('\\', '/'));
    const root = raw[0].split('/')[0];
    const sharedRoot = raw.every((path) => path.includes('/') && path.split('/')[0] === root);
    const paths = sharedRoot ? raw.map((path) => path.slice(root.length + 1)) : raw;
    const seen = new Map();

    for (const path of paths) {
        if (!isPackagePath(path)) {
            throw managerError(path, 'package', `'${path}' is not a safe package-relative path (ASCII [A-Za-z0-9._-] segments, no '..', no absolute paths)`);
        }

        const key = path.toLowerCase();

        if (seen.has(key)) {
            throw managerError(path, 'package', `'${path}' and '${seen.get(key)}' name the same package file`);
        }

        seen.set(key, path);
    }

    return paths;
}

/**
 * Validates one dependency map: every key is a package id and every value is an
 * exact dotted version. Ranges and wildcards are refused, not interpreted.
 *
 * @param {unknown} value - Candidate map.
 * @param {string} label - Manifest field name for the message.
 * @param {string} id - Owning package id, for attribution.
 * @returns {Record<string, string>} Validated map.
 */
function dependencyMap(value, label, id) {
    if (value === undefined) {
        return {};
    }

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw managerError(id, 'manifest', `${label} must be a JSON object of id to exact version`);
    }

    const map = {};

    for (const [dependencyId, version] of Object.entries(value)) {
        if (!MOD_ID_PATTERN.test(dependencyId)) {
            throw managerError(id, 'manifest', `${label} key '${dependencyId}' must match ${MOD_ID_PATTERN}`);
        }

        if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
            throw managerError(id, 'manifest', `${label}.'${dependencyId}' must be an exact dotted major.minor.patch version, not '${String(version)}'`);
        }

        map[dependencyId] = version;
    }

    return map;
}

/**
 * Validates one id list field, refusing self-reference.
 *
 * @param {unknown} value - Candidate list.
 * @param {string} label - Manifest field name for the message.
 * @param {string} id - Owning package id, for attribution.
 * @returns {string[]} Validated ids, deduplicated in manifest order.
 */
function idList(value, label, id) {
    if (value === undefined) {
        return [];
    }

    if (!Array.isArray(value)) {
        throw managerError(id, 'manifest', `${label} must be an array of package ids`);
    }

    const ids = [];

    for (const candidate of value) {
        if (typeof candidate !== 'string' || !MOD_ID_PATTERN.test(candidate)) {
            throw managerError(id, 'manifest', `${label} entry '${String(candidate)}' must match ${MOD_ID_PATTERN}`);
        }

        if (candidate === id) {
            throw managerError(id, 'manifest', `${label} may not name the package itself`);
        }

        if (!ids.includes(candidate)) {
            ids.push(candidate);
        }
    }

    return ids;
}

/**
 * Parses and validates a `mod.json` body.
 *
 * @param {string} text - Manifest text.
 * @param {Set<string>} paths - Every package path the manifest may name.
 * @returns {ModPackageManifest} Manifest with defaults applied.
 * @throws {Error} Named `ModManagerError` (`stage: 'manifest'`) for any malformed field.
 */
function parseManifest(text, paths) {
    /** @type {unknown} */
    let raw;

    try {
        raw = JSON.parse(text);
    } catch (cause) {
        throw managerError(MANIFEST_NAME, 'manifest', `mod.json is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`, undefined, cause);
    }

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw managerError(MANIFEST_NAME, 'manifest', 'mod.json must be a JSON object');
    }

    const candidate = /** @type {Record<string, unknown>} */ (raw);
    const id = typeof candidate.id === 'string' ? candidate.id : '';

    if (!MOD_ID_PATTERN.test(id)) {
        throw managerError(id || MANIFEST_NAME, 'manifest', `mod.json id must match ${MOD_ID_PATTERN}`);
    }

    if (id === RESERVED_ID) {
        throw managerError(id, 'manifest', `'${RESERVED_ID}' is the host's internal attribution id and cannot be a package id`);
    }

    if (typeof candidate.version !== 'string' || !VERSION_PATTERN.test(candidate.version)) {
        throw managerError(id, 'manifest', 'mod.json version must be dotted major.minor.patch');
    }

    if (typeof candidate.apiVersion !== 'string' || !VERSION_PATTERN.test(candidate.apiVersion)) {
        throw managerError(id, 'manifest', 'mod.json apiVersion must be dotted major.minor.patch');
    }

    if (typeof candidate.name !== 'string' || candidate.name.trim() === '') {
        throw managerError(id, 'manifest', 'mod.json name must be a non-empty string');
    }

    if (candidate.description !== undefined && typeof candidate.description !== 'string') {
        throw managerError(id, 'manifest', 'mod.json description must be a string when present');
    }

    if (typeof candidate.entry !== 'string' || !isPackagePath(candidate.entry) || !ENTRY_PATTERN.test(candidate.entry)) {
        throw managerError(id, 'manifest', `mod.json entry must be a package-relative .js or .mjs path, got '${String(candidate.entry)}'`);
    }

    if (candidate.settings !== undefined && (!candidate.settings || typeof candidate.settings !== 'object' || Array.isArray(candidate.settings))) {
        throw managerError(id, 'manifest', 'mod.json settings must be a JSON object when present');
    }

    const assets = Array.isArray(candidate.assets)
        ? candidate.assets.map((asset) => {
                if (typeof asset !== 'string' || !isPackagePath(asset)) {
                    throw managerError(id, 'manifest', `assets entry '${String(asset)}' must be a package-relative path`);
                }

                if (!paths.has(asset)) {
                    throw managerError(id, 'manifest', `assets entry '${asset}' is not one of the selected files`);
                }

                return asset;
            })
        : [];

    return {
        id,
        name: candidate.name,
        version: candidate.version,
        apiVersion: candidate.apiVersion,
        description: typeof candidate.description === 'string' ? candidate.description : '',
        entry: candidate.entry,
        dependencies: dependencyMap(candidate.dependencies, 'dependencies', id),
        optionalDependencies: dependencyMap(candidate.optionalDependencies, 'optionalDependencies', id),
        conflicts: idList(candidate.conflicts, 'conflicts', id),
        loadBefore: idList(candidate.loadBefore, 'loadBefore', id),
        loadAfter: idList(candidate.loadAfter, 'loadAfter', id),
        assets,
        settings: candidate.settings === undefined ? {} : /** @type {object} */ (candidate.settings),
    };
}

/**
 * Hashes bytes with SHA-256 and renders the digest as lowercase hex.
 *
 * @param {ArrayBuffer} bytes - Content to hash.
 * @returns {Promise<string>} Full hex digest.
 */
async function digestHex(bytes) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);

    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Derives the package revision: a digest over every path and every file digest.
 *
 * Any content change, including a manifest change, produces a different revision and
 * therefore different served URLs, which is what keeps a stale module entry from
 * being reused after an update.
 *
 * @param {ModPackageFileEntry[]} entries - Validated package files.
 * @returns {Promise<string>} Lowercase hex revision of `REVISION_LENGTH` characters.
 */
async function revisionOf(entries) {
    const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : 1));
    const digests = await Promise.all(sorted.map((entry) => digestHex(entry.bytes)));
    const joined = sorted.map((entry, index) => `${entry.path}\u0000${digests[index]}\n`).join('');
    const whole = await digestHex(new TextEncoder().encode(joined).buffer);

    return whole.slice(0, REVISION_LENGTH);
}

/**
 * Reads one picked file's bytes, attributing a read failure to that path.
 *
 * @param {{ path: string, source: PackageSourceFile }} entry - Chosen file.
 * @returns {Promise<ArrayBuffer>} The file's bytes.
 */
function readBytes(entry) {
    return entry.source.arrayBuffer().catch((cause) => {
        throw managerError(entry.path, 'package', `cannot read '${entry.path}': ${cause instanceof Error ? cause.message : String(cause)}`, undefined, cause);
    });
}

/**
 * Validates one user-selected package folder without touching storage.
 *
 * Every rule runs before anything is written: folder shape, path safety, duplicates,
 * supported types, size limits (`MAX_FILE_BYTES` per file, `MAX_PACKAGE_BYTES` in
 * total, `MAX_MANIFEST_BYTES` for `mod.json`, at most `MAX_FILES` files) and the
 * full manifest. A zip parser is deliberately not part of this M2 folder workflow.
 *
 * @param {PackageSourceFile[] | FileList} files - Every file in the selected folder.
 * @returns {Promise<ModParsedPackage>} Manifest, content revision and file entries.
 * @throws {Error} Named `ModManagerError` for a malformed folder, path, manifest or
 * limit; nothing is stored when this throws.
 */
async function parseModPackage(files) {
    const sources = Array.from(files ?? []);

    if (sources.length === 0) {
        throw managerError(RESERVED_ID, 'package', 'select a mod folder containing mod.json, its entry module and every file they use');
    }

    if (sources.length > MAX_FILES) {
        throw managerError(RESERVED_ID, 'package', `a package may hold at most ${MAX_FILES} files, got ${sources.length}`);
    }

    const paths = packagePaths(sources);
    const chosen = sources.map((source, index) => ({ path: paths[index], source }));

    if (!paths.includes(MANIFEST_NAME)) {
        throw managerError(MANIFEST_NAME, 'package', `${MANIFEST_NAME} must sit at the root of the selected folder`);
    }

    let declaredBytes = 0;

    for (const entry of chosen) {
        const size = Number(entry.source.size);

        if (!Number.isFinite(size) || size < 0) {
            throw managerError(entry.path, 'package', `'${entry.path}' has no readable size`);
        }

        if (size > MAX_FILE_BYTES) {
            throw managerError(entry.path, 'package', `'${entry.path}' is ${size} bytes, over the ${MAX_FILE_BYTES}-byte per-file limit`);
        }

        declaredBytes += size;
    }

    if (declaredBytes > MAX_PACKAGE_BYTES) {
        throw managerError(RESERVED_ID, 'package', `the package is ${declaredBytes} bytes, over the ${MAX_PACKAGE_BYTES}-byte package limit`);
    }

    const buffers = await Promise.all(chosen.map(readBytes));
    /** @type {ModPackageFileEntry[]} */
    const entries = [];
    let totalBytes = 0;

    for (const [index, element] of chosen.entries()) {
        const bytes = buffers[index];
        const mime = MEDIA_TYPES.get(extensionOf(element.path));

        if (!mime) {
            throw managerError(element.path, 'package', `'${element.path}' has an unsupported type; packages may hold JavaScript, JSON, CSS, WASM, images and audio`);
        }

        if (bytes.byteLength > MAX_FILE_BYTES) {
            throw managerError(element.path, 'package', `'${element.path}' read as ${bytes.byteLength} bytes, over the ${MAX_FILE_BYTES}-byte per-file limit`);
        }

        totalBytes += bytes.byteLength;

        if (totalBytes > MAX_PACKAGE_BYTES) {
            throw managerError(RESERVED_ID, 'package', `the package reads as more than ${MAX_PACKAGE_BYTES} bytes, over the package limit`);
        }

        entries.push({ path: element.path, bytes, size: bytes.byteLength, mime });
    }

    const manifestEntry = /** @type {ModPackageFileEntry} */ (entries.find((entry) => entry.path === MANIFEST_NAME));

    if (manifestEntry.size > MAX_MANIFEST_BYTES) {
        throw managerError(MANIFEST_NAME, 'package', `${MANIFEST_NAME} is ${manifestEntry.size} bytes, over the ${MAX_MANIFEST_BYTES}-byte manifest limit`);
    }

    const manifest = parseManifest(new TextDecoder().decode(manifestEntry.bytes), new Set(paths));

    if (!paths.includes(manifest.entry)) {
        throw managerError(manifest.id, 'package', `entry '${manifest.entry}' is not one of the selected files`);
    }

    return { manifest, revision: await revisionOf(entries), entries, totalBytes };
}

/**
 * Decode one URL part, treating invalid percent escapes as a malformed path.
 *
 * @param {string} encoded - Percent-encoded part.
 * @returns {string|undefined} Decoded part.
 */
function decodePackagePart(encoded) {
    try {
        return decodeURIComponent(encoded);
    } catch {
        return undefined;
    }
}

/**
 * Splits one `/__mods__/` request path into its parts, refusing anything malformed.
 *
 * Percent-decoding happens after the prefix split, so an encoded `..` or `/` cannot
 * smuggle traversal into a stored key lookup.
 *
 * @param {string} pathname - Encoded request pathname.
 * @returns {{ id: string, revision: string, path: string }|undefined} Parts, or
 * undefined when the path is not a valid package file request.
 */
function splitModPath(pathname) {
    if (typeof pathname !== 'string' || !pathname.startsWith(MOD_URL_PREFIX)) {
        return undefined;
    }

    const remainder = pathname.slice(MOD_URL_PREFIX.length);
    const idEnd = remainder.indexOf('/');
    const revisionEnd = remainder.indexOf('/', idEnd + 1);

    if (idEnd <= 0 || revisionEnd <= 0) {
        return undefined;
    }

    const id = decodePackagePart(remainder.slice(0, idEnd));
    const revision = decodePackagePart(remainder.slice(idEnd + 1, revisionEnd));
    const path = decodePackagePart(remainder.slice(revisionEnd + 1));

    if (!id || !revision || !path || !MOD_ID_PATTERN.test(id) || !REVISION_PATTERN.test(revision) || !isPackagePath(path)) {
        return undefined;
    }

    return { id, revision, path };
}

/**
 * Resolves one IndexedDB request.
 *
 * @param {IDBRequest} request - Issued request.
 * @returns {Promise<unknown>} The request result.
 */
function completed(request) {
    return new Promise((resolve, reject) => {
        request.addEventListener('success', () => {
            resolve(request.result);
        }, { once: true });
        request.addEventListener('error', () => {
            reject(request.error ?? new Error('IndexedDB request failed'));
        }, { once: true });
        request.addEventListener('abort', () => {
            reject(request.error ?? new Error('IndexedDB request aborted'));
        }, { once: true });
    });
}

/**
 * Resolves one IndexedDB transaction only once it has fully committed.
 *
 * @param {IDBTransaction} transaction - Write transaction to wait for.
 * @param {Error[]} failures - First request failure recorded inside the transaction.
 * @returns {Promise<void>} Resolves after commit.
 * @throws {Error} The request or transaction reason when the transaction aborts.
 */
function transactionCompleted(transaction, failures) {
    return new Promise((resolve, reject) => {
        transaction.addEventListener('complete', () => {
            resolve();
        }, { once: true });
        transaction.addEventListener('error', () => {
            reject(failures[0] ?? transaction.error ?? new Error('package transaction failed'));
        }, { once: true });
        transaction.addEventListener('abort', () => {
            reject(failures[0] ?? transaction.error ?? new Error('package transaction aborted'));
        }, { once: true });
    });
}

/**
 * Watches one write so a quota or constraint failure has a reportable reason.
 *
 * @param {IDBRequest} request - Issued write request.
 * @param {Error[]} failures - Shared collector for this transaction.
 * @returns {void}
 */
function watch(request, failures) {
    request.addEventListener('error', () => {
        if (failures.length === 0) {
            failures.push(request.error ?? new Error('IndexedDB write failed'));
        }
    }, { once: true });
}

/** @type {Promise<IDBDatabase>|undefined} */
let databasePromise;

/**
 * Opens the dedicated package database, creating the stores and index once.
 *
 * The service worker imports this same function, so the schema exists in exactly one
 * place. A connection another tab replaces (a version change) is dropped so the next
 * call reopens it instead of reusing a closed handle.
 *
 * @returns {Promise<IDBDatabase>} Shared connection to `pz-mod-packages`.
 */
function openPackageDb() {
    if (!databasePromise) {
        databasePromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(PACKAGE_DB_NAME, PACKAGE_SCHEMA_VERSION);

            request.addEventListener('upgradeneeded', () => {
                const database = request.result;

                if (!database.objectStoreNames.contains(PACKAGES_STORE)) {
                    database.createObjectStore(PACKAGES_STORE, { keyPath: 'id' });
                }

                if (!database.objectStoreNames.contains(FILES_STORE)) {
                    const files = database.createObjectStore(FILES_STORE, { keyPath: ['id', 'revision', 'path'] });

                    files.createIndex(PACKAGE_ID_INDEX, 'id');
                }
            });
            request.addEventListener('success', () => {
                const database = request.result;

                database.addEventListener('close', () => {
                    databasePromise = undefined;
                });
                database.addEventListener('versionchange', () => {
                    database.close();
                });
                resolve(database);
            }, { once: true });
            request.addEventListener('error', () => {
                databasePromise = undefined;
                reject(request.error ?? new Error(`cannot open ${PACKAGE_DB_NAME}`));
            }, { once: true });
            request.addEventListener('blocked', () => {
                databasePromise = undefined;
                reject(managerError(PACKAGE_DB_NAME, 'storage', 'another tab is holding the package database open'));
            }, { once: true });
        });
    }

    return databasePromise;
}

/**
 * Reads one stored package record.
 *
 * @param {string} id - Package id.
 * @returns {Promise<ModPackageRecord|undefined>} Stored record, when installed.
 */
async function readPackage(id) {
    const database = await openPackageDb();
    const request = database.transaction([PACKAGES_STORE], 'readonly').objectStore(PACKAGES_STORE).get(id);
    const record = /** @type {ModPackageRecord|undefined} */ (await completed(request));

    return record ?? undefined;
}

/**
 * Reads every stored package record, by id.
 *
 * @returns {Promise<ModPackageRecord[]>} Stored records.
 */
async function listRecords() {
    const database = await openPackageDb();
    const request = database.transaction([PACKAGES_STORE], 'readonly').objectStore(PACKAGES_STORE).getAll();
    const records = /** @type {ModPackageRecord[]} */ (await completed(request));

    return records.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * Reads the stored-file keys of one package, for atomic replacement and removal.
 *
 * @param {string} id - Package id.
 * @returns {Promise<(string | number)[]>} One key per stored file of this package.
 */
async function readFileKeys(id) {
    const database = await openPackageDb();
    const request = database.transaction([FILES_STORE], 'readonly').objectStore(FILES_STORE).index(PACKAGE_ID_INDEX).getAll(IDBKeyRange.only(id));
    const files = /** @type {ModStoredFile[]} */ (await completed(request));

    return files.map((file) => [file.id, file.revision, file.path]);
}

/**
 * Reads one stored package file.
 *
 * Both the manager and the service worker look files up through here, and an
 * unrepresentable id, revision or path never reaches a key lookup.
 *
 * @param {string} id - Package id.
 * @param {string} revision - Package revision.
 * @param {string} path - Package-relative path.
 * @returns {Promise<ModStoredFile|undefined>} Stored file, when it exists.
 */
async function readPackageFile(id, revision, path) {
    if (!MOD_ID_PATTERN.test(id) || id === RESERVED_ID || !REVISION_PATTERN.test(revision) || !isPackagePath(path)) {
        return undefined;
    }

    const database = await openPackageDb();
    const request = database.transaction([FILES_STORE], 'readonly').objectStore(FILES_STORE).get([id, revision, path]);
    const file = /** @type {ModStoredFile|undefined} */ (await completed(request));

    return file ?? undefined;
}

/**
 * Detaches one record for the page and adds its served URLs.
 *
 * @param {ModPackageRecord} record - Stored record.
 * @returns {ModPackageMetadata} Detached metadata.
 */
function toMetadata(record) {
    const base = `${MOD_URL_PREFIX}${record.id}/${record.revision}/`;

    return {
        id: record.id,
        name: record.name,
        version: record.version,
        apiVersion: record.apiVersion,
        description: record.description,
        entry: record.entry,
        dependencies: structuredClone(record.dependencies),
        optionalDependencies: structuredClone(record.optionalDependencies),
        conflicts: [...record.conflicts],
        loadBefore: [...record.loadBefore],
        loadAfter: [...record.loadAfter],
        assets: [...record.assets],
        settings: structuredClone(record.settings),
        revision: record.revision,
        enabled: record.enabled,
        installedAt: record.installedAt,
        fileCount: record.fileCount,
        totalBytes: record.totalBytes,
        urls: { base, entry: `${base}${record.entry}` },
    };
}

/**
 * The persisted configuration signature: enabled packages with their revisions.
 *
 * @param {ModPackageResolution[]} records - Records or metadata.
 * @returns {string} Signature that changes exactly when the load set changes.
 */
function configKeyOf(records) {
    return records.filter((record) => record.enabled).map((record) => `${record.id}\u0000${record.revision}`).sort().join('\n');
}

/**
 * Finds one load-order cycle among the packages that never became ready.
 *
 * @param {Map<string, Set<string>>} outgoing - Ordering edges, earlier to later.
 * @param {Set<string>} nodes - Packages still waiting on an unmet edge.
 * @returns {string[]} Cycle ids with the repeat at the end; empty when none is found.
 */
function findCycle(outgoing, nodes) {
    /** @type {string[]} */
    const path = [];
    /** @type {Map<string, number>} */
    const positions = new Map();

    /**
     * Depth-first walk over the edges of the stalled subgraph.
     *
     * @param {string} id - Package being entered.
     * @returns {string[]|undefined} The cycle that closed here, when one did.
     */
    const walk = (id) => {
        positions.set(id, path.length);
        path.push(id);

        for (const target of outgoing.get(id) ?? []) {
            if (!nodes.has(target)) {
                continue;
            }

            if (positions.has(target)) {
                return [...path.slice(/** @type {number} */ (positions.get(target))), target];
            }

            const closed = walk(target);

            if (closed) {
                return closed;
            }
        }

        path.pop();
        positions.delete(id);

        return undefined;
    };

    for (const id of nodes) {
        const closed = walk(id);

        if (closed) {
            return closed;
        }
    }

    return [];
}

/**
 * Orders the enabled packages by dependency, conflict and load-hint rules.
 *
 * `dependencies` must be installed, enabled and at exactly the named version;
 * `optionalDependencies` constrain the version only when that package is installed
 * and enabled; `conflicts` refuse the pair outright; `loadBefore` and `loadAfter`
 * add ordering edges and may name packages that are absent. A required dependency
 * orders too: it loads before the package that needs it. Among packages that are
 * ready at the same moment the lowest id goes first, so the order is stable between
 * runs and independent of install order. API compatibility is compared against the
 * host's actual version, never a version baked in here.
 *
 * @param {ModPackageResolution[]} packages - Every installed package, enabled or not.
 * @param {string} apiVersion - The host's actual mod API version.
 * @returns {string[]} Enabled package ids in load order.
 * @throws {Error} Named `ModManagerError` (`stage: 'resolve'`, `ids` listing the
 * packages involved) for an API mismatch, a missing/disabled/version-wrong
 * dependency, a conflict, a duplicate id or a load-order cycle.
 */
function resolveModOrder(packages, apiVersion) {
    /** @type {Map<string, ModPackageResolution>} */
    const installed = new Map();

    for (const record of packages) {
        if (installed.has(record.id)) {
            throw managerError(record.id, 'resolve', 'two installed packages claim the same id', [record.id]);
        }

        installed.set(record.id, record);
    }

    /** @type {Map<string, ModPackageResolution>} */
    const selected = new Map();

    for (const record of installed.values()) {
        if (record.enabled) {
            selected.set(record.id, record);
        }
    }

    for (const record of selected.values()) {
        if (record.apiVersion !== apiVersion) {
            throw managerError(record.id, 'resolve', `needs mod API '${record.apiVersion}', this host is '${apiVersion}'`, [record.id]);
        }

        for (const [dependencyId, version] of Object.entries(record.dependencies)) {
            const dependency = selected.get(dependencyId);

            if (!dependency) {
                throw managerError(record.id, 'resolve', `required dependency '${dependencyId}' is ${installed.has(dependencyId) ? 'installed but disabled' : 'not installed'}`, [record.id, dependencyId]);
            }

            if (dependency.version !== version) {
                throw managerError(record.id, 'resolve', `required dependency '${dependencyId}' must be exactly ${version}, found ${dependency.version}`, [record.id, dependencyId]);
            }
        }

        for (const [dependencyId, version] of Object.entries(record.optionalDependencies)) {
            const dependency = selected.get(dependencyId);

            if (dependency && dependency.version !== version) {
                throw managerError(record.id, 'resolve', `optional dependency '${dependencyId}' must be exactly ${version}, found ${dependency.version}`, [record.id, dependencyId]);
            }
        }

        for (const conflictId of record.conflicts) {
            if (selected.has(conflictId)) {
                throw managerError(record.id, 'resolve', `conflicts with enabled package '${conflictId}'`, [record.id, conflictId]);
            }
        }
    }

    /* Edges run from a package that has to load first to one that has to load later. */
    const outgoing = new Map();

    for (const id of selected.keys()) {
        outgoing.set(id, new Set());
    }

    for (const record of selected.values()) {
        /* A required dependency also orders: it loads before what needs it. */
        for (const dependencyId of Object.keys(record.dependencies)) {
            /** @type {Set<string>} */ (outgoing.get(dependencyId)).add(record.id);
        }

        for (const earlier of record.loadAfter) {
            if (selected.has(earlier)) {
                /** @type {Set<string>} */ (outgoing.get(earlier)).add(record.id);
            }
        }

        for (const later of record.loadBefore) {
            if (selected.has(later)) {
                /** @type {Set<string>} */ (outgoing.get(record.id)).add(later);
            }
        }
    }

    const waiting = new Map();

    for (const targets of outgoing.values()) {
        for (const target of targets) {
            waiting.set(target, (waiting.get(target) ?? 0) + 1);
        }
    }

    const order = [];
    const remaining = new Set(selected.keys());

    while (remaining.size > 0) {
        let next;

        for (const id of remaining) {
            if ((waiting.get(id) ?? 0) === 0 && (next === undefined || id < next)) {
                next = id;
            }
        }

        if (next === undefined) {
            const cycle = findCycle(outgoing, remaining);

            throw managerError(cycle[0] ?? [...remaining][0], 'resolve', `load order forms a cycle: ${cycle.join(' -> ') || [...remaining].join(', ')}`, [...new Set(cycle)].sort());
        }

        order.push(next);
        remaining.delete(next);

        for (const target of outgoing.get(next) ?? []) {
            waiting.set(target, (waiting.get(target) ?? 1) - 1);
        }
    }

    return order;
}

/**
 * Resolves once the page is controlled by a service worker.
 *
 * @param {ServiceWorkerContainer} container - The origin's service-worker surface.
 * @returns {Promise<void>} Resolves when a controller exists.
 */
function waitUntilControlled(container) {
    if (container.controller) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        container.addEventListener('controllerchange', () => {
            resolve();
        }, { once: true });
    });
}

/**
 * Creates the local package manager for one mod host.
 *
 * Packages run through the host's own `load(url)`; the manager adds storage, the
 * enable/disable configuration that survives restarts, dependency ordering and
 * activation reporting. It never invents hook surfaces of its own.
 *
 * @param {{ api: { version: string }, load: (url: string) => Promise<{ id: string, version: string, name: string }>, dispose: () => void }} host - The `createModHost` surface.
 * @returns {ModPackageManager} Package management surface.
 * @throws {TypeError} When the host does not expose `api.version`, `load` and `dispose`.
 */
function createModManager(host) {
    if (!host || typeof host.load !== 'function' || typeof host.dispose !== 'function' || !host.api || typeof host.api.version !== 'string') {
        throw new TypeError('createModManager requires a mod host with api.version, load() and dispose().');
    }

    const apiVersion = host.api.version;
    /** @type {ServiceWorkerRegistration|undefined} */
    let registration;
    /** @type {string|undefined} */
    let appliedKey;
    /** @type {string} */
    let persistedKey = '';
    /** @type {ModPackageRecord[]} */
    let cachedRecords = [];
    /** @type {ModActivationReport|undefined} */
    let lastActivation;
    /** @type {{ id: string, stage: string, message: string }[]} */
    const failures = [];

    /**
     * Records a failure for `diagnostics()` and returns it for the caller.
     *
     * @param {string} id - Package id or database name.
     * @param {string} stage - Lifecycle stage.
     * @param {string} message - Human-readable reason.
     * @param {string[]} [ids] - Ids involved.
     * @param {unknown} [cause] - Original failure.
     * @returns {Error} Attributed failure.
     */
    function fail(id, stage, message, ids, cause) {
        const failure = managerError(id, stage, message, ids, cause);

        failures.push({ id, stage, message: failure.message });

        if (failures.length > MAX_RECORDED_ERRORS) {
            failures.shift();
        }

        return failure;
    }

    /**
     * Registers the package service worker and waits for real control.
     *
     * The worker is a module worker at the application root, so its scope covers the
     * whole origin and `/__mods__/...` imports resolve natively. Waiting for the
     * controller (granted by `clients.claim()` on activation) is what makes it safe
     * to load a stored package afterwards.
     *
     * @returns {Promise<{ url: string, scope: string }>} Where the worker lives.
     * @throws {Error} Named `ModManagerError` (`stage: 'worker'`) when another service
     * worker owns this origin, because package files would never be served.
     */
    async function requireWorker() {
        const container = globalThis.navigator?.serviceWorker;

        if (!container) {
            throw fail(PACKAGE_DB_NAME, 'worker', 'this context has no service worker support, so stored package files cannot be served');
        }

        if (!registration) {
            const url = new URL('../mod-worker.js', import.meta.url);

            registration = await container.register(url.href, { type: 'module' });
            await container.ready;
            await waitUntilControlled(container);
        }

        const controller = container.controller;

        if (!controller || controller.scriptURL !== registration.active?.scriptURL) {
            throw fail(PACKAGE_DB_NAME, 'worker', `this origin is controlled by ${controller ? controller.scriptURL : 'no service worker'}, but package files need ${registration.active?.scriptURL}`);
        }

        return { url: registration.active.scriptURL, scope: registration.scope };
    }

    /**
     * Caches the current configuration after any read or write.
     *
     * @param {ModPackageRecord[]} records - Records as they now stand in storage.
     * @returns {string} The refreshed enabled-package signature.
     */
    function notePersisted(records) {
        cachedRecords = records;
        persistedKey = configKeyOf(records);

        return persistedKey;
    }

    /**
     * Reports whether the running mods no longer match the persisted configuration.
     *
     * @returns {boolean} True when `activateEnabled()` or a reload is needed.
     */
    function requiresReload() {
        return appliedKey !== undefined && appliedKey !== persistedKey;
    }

    /**
     * Installs or updates one package from provisioned files.
     *
     * The whole package is validated before any storage exists, then written in a
     * single transaction that replaces every previous file of that id: if the
     * transaction aborts, the previously installed package is still intact.
     * An update keeps the package's enabled state; a first install starts disabled
     * until the user explicitly enables it.
     *
     * @param {PackageSourceFile[] | FileList} files - Every file of the provisioned package.
     * @returns {Promise<ModPackageMetadata & { requiresReload: boolean }>} Installed metadata.
     * @throws {Error} Named `ModManagerError` for a rejected package, an aborted
     * transaction or a storage failure.
     */
    async function install(files) {
        const parsed = await parseModPackage(files);
        const previous = await readPackage(parsed.manifest.id);
        const oldKeys = await readFileKeys(parsed.manifest.id);
        const record = {
            ...parsed.manifest,
            revision: parsed.revision,
            enabled: previous ? previous.enabled : false,
            installedAt: new Date().toISOString(),
            fileCount: parsed.entries.length,
            totalBytes: parsed.totalBytes,
        };
        const database = await openPackageDb();
        const transaction = database.transaction([PACKAGES_STORE, FILES_STORE], 'readwrite');
        const errors = [];

        for (const key of oldKeys) {
            watch(transaction.objectStore(FILES_STORE).delete(key), errors);
        }

        for (const entry of parsed.entries) {
            watch(transaction.objectStore(FILES_STORE).put({
                id: record.id,
                revision: record.revision,
                path: entry.path,
                mime: entry.mime,
                size: entry.size,
                bytes: entry.bytes,
            }), errors);
        }

        watch(transaction.objectStore(PACKAGES_STORE).put(record), errors);
        await transactionCompleted(transaction, errors);
        notePersisted(await listRecords());

        return { ...toMetadata(record), requiresReload: requiresReload() };
    }

    /**
     * Lists every installed package, detached and by id.
     *
     * @returns {Promise<ModPackageMetadata[]>} Package metadata with served URLs.
     */
    async function list() {
        const records = await listRecords();

        notePersisted(records);

        return records.map(toMetadata);
    }

    /**
     * Turns one package on or off for the next activation.
     *
     * Only the stored configuration changes: nothing that is already running is
     * undone, because API 0.1.0 has no live per-mod unload. `requiresReload` says so.
     *
     * @param {string} id - Package id.
     * @param {boolean} enabled - Whether the package should load next time.
     * @returns {Promise<ModPackageMetadata & { requiresReload: boolean }>} Updated metadata.
     * @throws {Error} Named `ModManagerError` for an unknown id, a bad flag or an
     * aborted transaction.
     */
    async function setEnabled(id, enabled) {
        if (enabled !== true && enabled !== false) {
            throw new TypeError(`setEnabled('${id}', enabled) requires a boolean`);
        }

        const previous = await readPackage(id);

        if (!previous) {
            throw fail(id, 'enable', 'no installed package has that id');
        }

        const record = { ...previous, enabled };
        const database = await openPackageDb();
        const transaction = database.transaction([PACKAGES_STORE], 'readwrite');
        const errors = [];

        watch(transaction.objectStore(PACKAGES_STORE).put(record), errors);
        await transactionCompleted(transaction, errors);
        notePersisted(await listRecords());

        return { ...toMetadata(record), requiresReload: requiresReload() };
    }

    /**
     * Removes one package and every stored file of it.
     *
     * Code already loaded stays loaded until the host disposes it; the removal is of
     * stored bytes and configuration, and `diagnostics().requiresReload` reports the
     * difference.
     *
     * @param {string} id - Package id.
     * @returns {Promise<void>} Resolves once the package is gone.
     * @throws {Error} Named `ModManagerError` for an unknown id or an aborted transaction.
     */
    async function remove(id) {
        const previous = await readPackage(id);

        if (!previous) {
            throw fail(id, 'remove', 'no installed package has that id');
        }

        const keys = await readFileKeys(id);
        const database = await openPackageDb();
        const transaction = database.transaction([PACKAGES_STORE, FILES_STORE], 'readwrite');
        const errors = [];

        for (const key of keys) {
            watch(transaction.objectStore(FILES_STORE).delete(key), errors);
        }

        watch(transaction.objectStore(PACKAGES_STORE).delete(id), errors);
        await transactionCompleted(transaction, errors);
        notePersisted(await listRecords());
    }

    /**
     * Loads every enabled package in resolved order through the host.
     *
     * `safeMode` skips all module imports before any package code can run, which is
     * the escape hatch for a package that breaks startup. A load or identity failure
     * stops the sequence, disposes what this call activated (the host has no per-mod
     * unload, so that also unloads any other mod on this host) and keeps every error
     * in the report. Mod and configuration failures are reported, not thrown; only
     * storage or service-worker failures throw.
     *
     * @param {{ safeMode?: boolean }} [options] - `safeMode: true` imports nothing.
     * @returns {Promise<ModActivationReport>} Ordered, attributed activation outcome.
     */
    async function activateEnabled(options = {}) {
        const safeMode = options.safeMode === true;
        const records = await listRecords();
        const byId = new Map(records.map((record) => [record.id, record]));

        notePersisted(records);

        /** @type {ModActivationReport} */
        const report = {
            safeMode,
            apiVersion,
            order: [],
            activated: [],
            errors: [],
            skipped: records.filter((record) => record.enabled).map((record) => record.id),
            disposed: false,
        };

        lastActivation = report;

        if (safeMode) {
            appliedKey = '';

            return report;
        }

        await requireWorker();

        try {
            report.order = resolveModOrder(records, apiVersion);
        } catch (cause) {
            const failure = cause instanceof Error ? cause : new Error(String(cause));

            report.errors.push({ id: String(failure.modId ?? RESERVED_ID), modId: String(failure.modId ?? RESERVED_ID), stage: String(failure.stage ?? 'resolve'), message: failure.message });
            failures.push({ id: String(failure.modId ?? RESERVED_ID), stage: String(failure.stage ?? 'resolve'), message: failure.message });

            return report;
        }

        /**
         * Loads one package and continues, stopping on the first failure.
         *
         * @param {number} index - Position in `report.order`.
         * @returns {Promise<void>} Resolves when the sequence stops or finishes.
         */
        const loadNext = async (index) => {
            if (index >= report.order.length) {
                return;
            }

            const record = byId.get(report.order[index]);

            if (!record) {
                return;
            }

            const urls = toMetadata(record).urls;
            let identity;

            try {
                identity = await host.load(urls.entry);
            } catch (cause) {
                const failure = cause instanceof Error ? cause : new Error(String(cause));

                report.errors.push({ id: record.id, modId: String(failure.modId ?? record.id), stage: String(failure.stage ?? 'load'), message: failure.message });

                return;
            }

            if (identity.id !== record.id || identity.version !== record.version) {
                report.errors.push({ id: record.id, modId: identity.id, stage: 'manifest', message: `the loaded module reports '${identity.id}' ${identity.version}, but the installed package is '${record.id}' ${record.version}` });

                return;
            }

            report.activated.push({ id: identity.id, version: identity.version, name: identity.name, revision: record.revision, url: urls.entry });

            await loadNext(index + 1);
        };

        await loadNext(0);

        if (report.errors.length > 0) {
            for (const error of report.errors) {
                failures.push({ id: error.id, stage: error.stage, message: error.message });
            }

            if (report.activated.length > 0) {
                host.dispose();
                report.disposed = true;
                appliedKey = '';
            }
        } else {
            appliedKey = report.activated.map((activated) => `${activated.id}\u0000${activated.revision}`).sort().join('\n');
        }

        report.skipped = report.order.filter((id) => !report.activated.some((activated) => activated.id === id));

        return report;
    }

    /**
     * Detached manager evidence for the HUD and for tests.
     *
     * @returns {ModManagerDiagnostics} Database, worker, packages, activation outcome
     * and the last attributed manager failures.
     */
    function diagnostics() {
        const controller = globalThis.navigator?.serviceWorker?.controller;

        return {
            packageDb: { name: PACKAGE_DB_NAME, schemaVersion: PACKAGE_SCHEMA_VERSION },
            worker: registration ? { url: registration.active?.scriptURL, scope: registration.scope, controlling: controller?.scriptURL === registration.active?.scriptURL } : undefined,
            apiVersion,
            packages: cachedRecords.map(toMetadata),
            requiresReload: requiresReload(),
            lastActivation: lastActivation ? structuredClone(lastActivation) : undefined,
            errors: failures.map((failure) => ({ ...failure })),
        };
    }

    return { install, list, setEnabled, remove, activateEnabled, diagnostics };
}

export { createModManager, resolveModOrder, parseModPackage, splitModPath, readPackageFile, openPackageDb, MOD_URL_PREFIX, PACKAGE_DB_NAME, PACKAGE_SCHEMA_VERSION, MANIFEST_NAME, MAX_FILE_BYTES, MAX_PACKAGE_BYTES, MAX_MANIFEST_BYTES, MAX_FILES };
