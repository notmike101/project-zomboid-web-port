import { createEngine } from './engine.js';

const SAVE_FORMAT = 'pz-web-save';
const SAVE_VERSION = 2;
const MAX_SAVE_BYTES = 16 * 1_024 * 1_024;
const DATABASE = 'pz-web-saves';

/**
 * Canonical JSON for integrity checking; object property order is irrelevant.
 *
 * @param {unknown} value - JSON-compatible save value.
 * @returns {string} Stable encoding.
 */
function canonical(value) {
    return JSON.stringify(value, (_, item) => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
            return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
        }

        return item;
    });
}

/**
 * Compute a save payload digest, excluding its own integrity field.
 *
 * @param {object} payload - Save payload.
 * @returns {Promise<string>} Hex SHA-256.
 */
async function digest(payload) {
    const bytes = new TextEncoder().encode(canonical(payload));

    if (bytes.length > MAX_SAVE_BYTES) {
        throw new RangeError('Save exceeds the 16 MiB limit.');
    }

    const hash = await crypto.subtle.digest('SHA-256', bytes);

    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Encode a cell without argument-spreading a large typed array.
 *
 * @param {Uint8Array} bytes - Imported cell bytes.
 * @returns {string} Base64 bytes.
 */
function encodeCell(bytes) {
    let text = '';

    for (const byte of bytes) {
        text += String.fromCharCode(byte);
    }

    return btoa(text);
}

/**
 * Decode a saved cell with explicit format refusal.
 *
 * @param {string} encoded - Base64 cell.
 * @returns {Uint8Array} Detached bytes.
 */
function decodeCell(encoded) {
    if (typeof encoded !== 'string' || encoded.length > 90_000) {
        throw new TypeError('Invalid saved cell encoding.');
    }

    const text = atob(encoded);

    return Uint8Array.from(text, (character) => character.charCodeAt(0));
}

/**
 * Extend an authenticated legacy payload without mutating its world or mod data.
 *
 * @param {object} payload - Detached, integrity-verified version-one payload.
 * @returns {object} Unsigned current-format payload.
 */
function migrateLegacySave(payload) {
    return {
        ...payload,
        formatVersion: SAVE_VERSION,
        engine: {
            ...payload.engine,
            state: { ...payload.engine.state, version: 2, values: [...payload.engine.state.values, 100, 1] },
        },
        itemDefs: [],
        items: [],
        migratedFrom: 1,
    };
}

/**
 * Validate inventory identities and references before creating a restore engine.
 *
 * @param {object} record - Authenticated current-format save.
 * @returns {void} Throws for invalid definitions or item records.
 */
function validateInventory(record) {
    if (!Array.isArray(record.itemDefs) || record.itemDefs.length > 4_096
        || !Array.isArray(record.items) || record.items.length > 4_096) {
        throw new TypeError('Invalid saved inventory.');
    }

    const definitions = new Map();

    for (const definition of record.itemDefs) {
        if (!definition || typeof definition.fullType !== 'string' || !definition.fullType
            || definitions.has(definition.fullType)
            || typeof definition.owner !== 'string' || !definition.owner
            || !Number.isInteger(definition.conditionMax) || definition.conditionMax < 1
            || definition.conditionMax > 2_147_483_647
            || !Number.isInteger(definition.stackLimit) || definition.stackLimit < 1
            || definition.stackLimit > 4_294_967_295
            || typeof definition.removeOnBroken !== 'boolean'
            || !Number.isInteger(definition.conditionLowerChanceOneIn)
            || definition.conditionLowerChanceOneIn < 0 || definition.conditionLowerChanceOneIn > 4_294_967_295
            || (definition.bodyLocation !== null && typeof definition.bodyLocation !== 'string')) {
            throw new TypeError('Invalid or duplicate saved item definition.');
        }

        definitions.set(definition.fullType, definition);
    }

    const ids = new Set();
    const wornSlots = new Set();

    for (const item of record.items) {
        const definition = definitions.get(item?.fullType);

        if (!item || !definition || !Number.isInteger(item.id) || item.id < 1 || item.id > 4_294_967_295
            || ids.has(item.id) || !['ground', 'inventory'].includes(item.location)
            || !Number.isFinite(item.x) || !Number.isFinite(item.y)
            || !Number.isInteger(item.condition) || item.condition < 0 || item.condition > definition.conditionMax
            || !Number.isInteger(item.count) || item.count < 1 || item.count > definition.stackLimit
            || (item.bodyLocation !== null && (item.location !== 'inventory'
                || item.bodyLocation !== definition.bodyLocation || wornSlots.has(item.bodyLocation)))) {
            throw new TypeError('Invalid or duplicate saved item.');
        }

        ids.add(item.id);

        if (item.bodyLocation !== null) {
            wornSlots.add(item.bodyLocation);
        }
    }
}

/**
 * Validate integrity and versions before executing any restore commands.
 *
 * @param {object} record - Candidate save envelope.
 * @returns {Promise<object>} Detached validated record.
 */
async function validateSave(record) {
    const copy = structuredClone(record);

    if (copy?.format !== SAVE_FORMAT || ![1, SAVE_VERSION].includes(copy.formatVersion)) {
        throw new TypeError('Unsupported browser save format/version; native saves are not supported.');
    }

    if (typeof copy.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/u.test(copy.id)
        || !Number.isSafeInteger(copy.revision) || copy.revision < 1
        || !Array.isArray(copy.world?.cells) || copy.world.cells.length > 64
        || copy.engine?.abiVersion !== 1 || copy.engine.state?.version !== copy.formatVersion
        || !Array.isArray(copy.contentPacks) || !Array.isArray(copy.mods)
        || typeof copy.modState !== 'object' || copy.modState === null
        || typeof copy.integrity !== 'string') {
        throw new TypeError('Malformed browser save envelope.');
    }

    const { integrity, ...payload } = copy;

    if (await digest(payload) !== integrity) {
        throw new TypeError('Browser save integrity check failed; current game remains unchanged.');
    }

    const values = copy.engine.state.values;

    if (!Array.isArray(values) || values.length !== (copy.formatVersion === 1 ? 10 : 12)
        || values.some((value) => !Number.isFinite(value))) {
        throw new TypeError('Malformed saved actor state.');
    }

    const coordinates = new Set();

    for (const cell of copy.world.cells) {
        if (!Number.isInteger(cell.x) || !Number.isInteger(cell.y)
            || Math.abs(cell.x) > 100 || Math.abs(cell.y) > 100) {
            throw new TypeError('Invalid saved cell coordinates.');
        }

        const key = `${cell.x},${cell.y}`;

        if (coordinates.has(key)) {
            throw new TypeError('Duplicate saved map cell.');
        }

        coordinates.add(key);
        decodeCell(cell.bytes);
    }

    if (copy.formatVersion === 1) {
        const migrated = migrateLegacySave(payload);

        return { ...migrated, integrity: await digest(migrated) };
    }

    validateInventory(copy);

    return copy;
}

/**
 * Browser persistence for detached saves, retaining the prior committed revision.
 * Engine/world restore is staged in a fresh WASM instance; caller publishes it
 * only after load succeeds. No mod code executes while parsing save data.
 *
 * @param {object} options - Host configuration.
 * @param {string|URL|Uint8Array} options.engineSource - WASM source for staged restores.
 * @param {string} options.appVersion - Diagnostic application version.
 * @returns {object} Save, load, export/import and storage diagnostics.
 */
function createSaveStore({ engineSource, appVersion }) {
    let database;
    let storageError;
    let writes = Promise.resolve();

    /**
     * Open the browser database; denied storage is visible, not a fake fallback.
     *
     * @returns {Promise<IDBDatabase>} Connection.
     */
    async function open() {
        if (database) {
            return database;
        }

        try {
            database = await new Promise((resolve, reject) => {
                const request = indexedDB.open(DATABASE, 1);

                request.addEventListener('upgradeneeded', () => {
                    request.result.createObjectStore('saves', { keyPath: 'id' });
                });
                request.addEventListener('success', () => resolve(request.result));
                request.addEventListener('error', () => reject(request.error));
                request.addEventListener('blocked', () => reject(new Error('Save database upgrade blocked by another tab.')));
            });
            database.addEventListener('versionchange', () => {
                database.close();
                database = undefined;
            });

            storageError = undefined;

            return database;
        } catch (cause) {
            storageError = cause.message;
            throw new Error(`Browser save storage unavailable: ${cause.message}. Export a backup before closing.`, { cause });
        }
    }

    /**
     * Execute one IndexedDB operation and wait for transaction commit.
     *
     * @param {string} mode - readonly or readwrite.
     * @param {function(IDBObjectStore): IDBRequest} operation - Database request.
     * @returns {Promise<unknown>} Request result, only after transaction completion.
     */
    async function transact(mode, operation) {
        const db = await open();

        return new Promise((resolve, reject) => {
            const transaction = db.transaction('saves', mode);
            const request = operation(transaction.objectStore('saves'));
            let result;

            request.addEventListener('success', () => {
                result = request.result;
            });
            transaction.addEventListener('complete', () => resolve(result));
            transaction.addEventListener('abort', () => {
                const cause = transaction.error ?? request.error ?? new Error('Save transaction aborted.');

                storageError = cause.message;
                reject(new Error(`Save write/read failed (${cause.name}): ${cause.message}; previous committed save is retained.`, { cause }));
            });
        });
    }

    /**
     * Restore in a fresh engine; invalid bytes cannot mutate the current session.
     *
     * @param {object} record - Validated candidate.
     * @returns {Promise<object>} Staged engine plus detached saved context.
     */
    async function restore(record) {
        const validated = await validateSave(record);
        const engine = await createEngine(engineSource);

        for (const cell of validated.world.cells) {
            engine.worldImportCell(cell.x, cell.y, decodeCell(cell.bytes));
        }

        for (const definition of validated.itemDefs) {
            engine.registerItemDefinition(definition, { owner: definition.owner });
        }

        engine.importItems(validated.items);

        engine.loadState(validated.engine.state);

        if (Object.hasOwn(validated, 'moodleState')) {
            engine.loadMoodleState(validated.moodleState);
        }

        return { engine, record: validated };
    }

    /**
     * Capture portable state without depending on browser persistence.
     *
     * @param {object} engine - Live engine.
     * @param {object} context - World/content/mod context.
     * @returns {object} Detached unsigned envelope.
     */
    function capture(engine, context) {
        const captured = structuredClone(context);

        return {
            format: SAVE_FORMAT, formatVersion: SAVE_VERSION, id: captured.id ?? 'autosave', revision: 1,
            updatedAt: new Date().toISOString(), application: { version: appVersion },
            engine: { abiVersion: 1, state: engine.saveState() },
            itemDefs: engine.itemDefinitions(),
            items: engine.items().sort((left, right) => left.id - right.id),
            moodleState: engine.saveMoodleState(),
            world: {
                cells: (captured.cells ?? []).map((cell) => ({
                    x: cell.x, y: cell.y, bytes: encodeCell(cell.bytes),
                })),
            },
            contentPacks: captured.contentPacks ?? [], mods: captured.mods ?? [],
            modState: captured.modState ?? {}, settings: captured.settings ?? {},
        };
    }

    /**
     * Capture engine/world and metadata synchronously, then serialize writes.
     *
     * @param {object} engine - Live WASM handle.
     * @param {object} context - Detached world/content/mod context.
     * @returns {Promise<object>} Committed envelope.
     */
    function save(engine, context = {}) {
        const payload = capture(engine, context);
        const { id } = payload;
        const pending = writes.catch(() => undefined).then(async () => {
            const existing = await transact('readonly', (store) => store.get(id));

            payload.revision = (existing?.current.revision ?? 0) + 1;
            const record = { ...payload, integrity: await digest(payload) };

            await restore(record);
            await transact('readwrite', (store) => store.put({ id, current: record, previous: existing?.current }));

            return record;
        });

        writes = pending;

        return pending;
    }

    /**
     * Load a committed save, reporting recovery from a damaged latest revision.
     *
     * @param {string} [id] - Slot, default autosave.
     * @returns {Promise<object>} Staged restored engine, record and recovery flag.
     */
    async function load(id = 'autosave') {
        await writes.catch(() => undefined);
        const stored = await transact('readonly', (store) => store.get(id));

        if (!stored) {
            throw new Error('No retained browser save. After eviction/deletion, recovery requires an exported backup.');
        }

        try {
            return { ...await restore(stored.current), recovered: false };
        } catch (cause) {
            if (!stored.previous) {
                throw cause;
            }

            return { ...await restore(stored.previous), recovered: true, recoveryReason: cause.message };
        }
    }

    /**
     * Import an exported backup only after a complete staged restore succeeds.
     *
     * @param {Blob} file - User-selected UTF-8 JSON backup.
     * @returns {Promise<object>} Detached imported envelope, new slot identity.
     */
    async function importSave(file) {
        if (!(file instanceof Blob) || file.size > MAX_SAVE_BYTES) {
            throw new RangeError('Save import requires a JSON file no larger than 16 MiB.');
        }

        const { record } = await restore(JSON.parse(await file.text()));
        const payload = structuredClone(record);

        delete payload.integrity;

        payload.id = crypto.randomUUID();
        const imported = { ...payload, integrity: await digest(payload) };

        await transact('readwrite', (store) => store.add({ id: imported.id, current: imported }));

        return imported;
    }

    /**
     * Export a selected committed revision for user-controlled transfer.
     *
     * @param {string} [id] - Slot identity.
     * @returns {Promise<Blob>} Portable JSON backup, including navigation cell bytes.
     */
    async function exportSave(id = 'autosave') {
        const { record } = await load(id);

        return new Blob([JSON.stringify(record)], { type: 'application/json' });
    }

    /**
     * Export live state even when IndexedDB is denied or full.
     *
     * @param {object} engine - Current simulation.
     * @param {object} [context] - Imported cells and metadata.
     * @returns {Promise<Blob>} Validated portable backup.
     */
    async function exportLive(engine, context = {}) {
        const payload = capture(engine, context);
        const record = { ...payload, integrity: await digest(payload) };

        await restore(record);

        return new Blob([JSON.stringify(record)], { type: 'application/json' });
    }

    return Object.freeze({
        save, load, importSave, exportSave, exportLive, restore,
        /**
         * List committed browser save slots.
         *
         * @returns {Promise<object[]>} Detached slot metadata.
         */
        list: async () => (await transact('readonly', (store) => store.getAll())).map((slot) => ({
            id: slot.id, revision: slot.current.revision, updatedAt: slot.current.updatedAt,
        })),
        /**
         * Report storage availability without claiming guaranteed durability.
         *
         * @returns {object} Storage diagnostics.
         */
        diagnostics: () => ({ database: DATABASE, error: storageError, durable: false }),
        /**
         * Release the current database connection.
         *
         * @returns {void} Closes storage.
         */
        close: () => {
            database?.close();
            database = undefined;
        },
    });
}

export { createSaveStore, validateSave, SAVE_FORMAT, SAVE_VERSION, MAX_SAVE_BYTES };
