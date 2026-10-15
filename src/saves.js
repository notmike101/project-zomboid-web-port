import { createEngine, validateNavigationCell } from './engine.js';

const SAVE_FORMAT = 'pz-web-save';
const SAVE_VERSION = 3;
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
 * Decode portable queue bytes without JSON-coercing native float bits.
 *
 * @param {object} queue - Versioned queue payload.
 * @returns {Uint8Array} Detached, canonical portable bytes.
 */
function decodeQueue(queue) {
    if (!queue || ![1, 2].includes(queue.version) || Object.keys(queue).length !== 3
        || !Array.isArray(queue.sourceOwners) || queue.sourceOwners.length > 128
        || typeof queue.bytes !== 'string' || queue.bytes.length > 1_398_104) {
        throw new TypeError('Invalid saved source queue encoding.');
    }

    const ids = new Set();

    for (const owner of queue.sourceOwners) {
        if (!owner || Object.keys(owner).length !== 2 || !integer(owner.actionId, 1, 2_147_483_647)
            || ids.has(owner.actionId) || typeof owner.ownerId !== 'string' || !owner.ownerId) {
            throw new TypeError('Invalid saved source action owner mapping.');
        }

        ids.add(owner.actionId);
    }

    const text = atob(queue.bytes);

    if (!text.length || text.length > 1_048_576 || btoa(text) !== queue.bytes) {
        throw new TypeError('Invalid saved source queue bytes.');
    }

    return Uint8Array.from(text, (character) => character.charCodeAt(0));
}

/**
 * Extend an authenticated legacy payload without mutating its world or mod data.
 *
 * @param {object} payload - Detached, integrity-verified version-one or flat version-two payload.
 * @returns {object} Unsigned current-format payload.
 */
function migrateLegacySave(payload) {
    const legacy = payload.formatVersion === 1;

    if (legacy && (Object.hasOwn(payload, 'items') || Object.hasOwn(payload, 'itemDefs')
        || Object.hasOwn(payload, 'inventoryGraph'))) {
        throw new TypeError('Version-one saves cannot contain inventory records.');
    }

    const itemDefs = legacy ? [] : payload.itemDefs;
    const rows = legacy ? [] : payload.items;
    const containers = [{
        id: 1, kind: 'actor', parentKind: 'actor', parentId: 1, containingItemId: null,
        capacity: 50, weightReduction: 0, worldPosition: null, explored: false, looted: false,
        definitionOrdinal: 0, type: 'inventory', onlyAcceptCategory: null, acceptItemFunction: null,
    }];
    const floors = new Map();
    const items = rows.map(({ location, x, y, ...item }) => {
        const definitionOrdinal = itemDefs.findIndex(({ fullType }) => fullType === item.fullType);
        let ownerContainerId = 1;

        if (location === 'ground') {
            const square = { x: Math.floor(x), y: Math.floor(y), z: 0 };
            const key = `${square.x},${square.y}`;

            if (!floors.has(key)) {
                const id = containers.length + 1;

                floors.set(key, id);
                containers.push({
                    ...containers[0], id, kind: 'floor', parentKind: 'square', parentId: 0,
                    worldPosition: square, type: 'floor',
                });
            }

            ownerContainerId = floors.get(key);
        }

        const weight = itemDefs[definitionOrdinal].weight ?? 1;

        return {
            ...item, definitionOrdinal, ownerContainerId, internalContainerId: null,
            worldPosition: location === 'ground' ? { x, y, z: 0 } : null,
            weight: item.weight ?? weight, actualWeight: item.actualWeight ?? weight,
            favorite: false, consumed: false,
        };
    });
    const rest = { ...payload };

    delete rest.items;

    return {
        ...rest, formatVersion: SAVE_VERSION,
        engine: {
            ...payload.engine,
            state: legacy
                ? { ...payload.engine.state, version: 2, values: [...payload.engine.state.values, 100, 1] }
                : payload.engine.state,
        },
        itemDefs,
        inventoryGraph: {
            version: 1, containers, items, nextContainerId: containers.length + 1,
            organized: false, disorganized: false, equippedMultiplier: 0.3,
            dropItemsOnSquareCenter: false,
            ...(payload.equipmentState ? { wornOrder: payload.equipmentState.wornOrder } : {}),
        },
        migratedFrom: payload.formatVersion,
    };
}

/**
 * Validate inventory identities and references before creating a restore engine.
 *
 * @param {object} record - Authenticated flat or graph save.
 * @returns {void} Throws for invalid definitions or item records.
 */
function validateInventory(record) {
    const items = record.formatVersion === SAVE_VERSION ? record.inventoryGraph?.items : record.items;

    if (!Array.isArray(record.itemDefs) || record.itemDefs.length > 4_096
        || !Array.isArray(items) || items.length > 4_096) {
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
            || (definition.bodyLocation !== null && (typeof definition.bodyLocation !== 'string' || !definition.bodyLocation))
            || (definition.canBeEquipped !== undefined && definition.canBeEquipped !== null
                && (typeof definition.canBeEquipped !== 'string' || !definition.canBeEquipped))
            || (definition.weight !== undefined && !itemWeight(definition.weight))
            || (definition.isBag !== undefined && typeof definition.isBag !== 'boolean')
            || (definition.capacity !== undefined && !integer(definition.capacity, -0x80_00_00_00, 0x7F_FF_FF_FF))
            || (definition.weightReduction !== undefined
                && !integer(definition.weightReduction, -0x80_00_00_00, 0x7F_FF_FF_FF))
            || (definition.maxItemSize !== undefined && (!Number.isFinite(definition.maxItemSize)
                || Math.abs(definition.maxItemSize) > 3.402_823_466_385_288_6e38))) {
            throw new TypeError('Invalid or duplicate saved item definition.');
        }

        definitions.set(definition.fullType, definition);
    }

    const ids = new Set();

    for (const item of items) {
        const definition = definitions.get(item?.fullType);
        const flat = record.formatVersion !== SAVE_VERSION;

        if (!item || !definition || !integer(item.id, 1, 0xFF_FF_FF_FF)
            || ids.has(item.id)
            || (flat && (!['ground', 'inventory'].includes(item.location)
                || !Number.isFinite(item.x) || !Number.isFinite(item.y)))
            || !integer(item.condition, 0, definition.conditionMax)
            || !integer(item.count, 1, definition.stackLimit)
            || (item.weight !== undefined && !itemWeight(item.weight))
            || (item.actualWeight !== undefined && !itemWeight(item.actualWeight))
            || (item.bodyLocation !== null && ((flat && item.location !== 'inventory')
                || typeof item.bodyLocation !== 'string' || !item.bodyLocation))
            || (flat && (definition.isBag === true || definition.type === 'Container'))) {
            throw new TypeError('Invalid or duplicate saved inventory item.');
        }

        if (!flat && (!integer(item.definitionOrdinal, 0, record.itemDefs.length - 1)
            || record.itemDefs[item.definitionOrdinal].fullType !== item.fullType
            || !itemWeight(item.weight) || !itemWeight(item.actualWeight)
            || typeof item.favorite !== 'boolean' || typeof item.consumed !== 'boolean'
            || ['location', 'x', 'y', 'slot'].some((key) => Object.hasOwn(item, key)))) {
            throw new TypeError('Invalid saved inventory definition reference or weight.');
        }

        ids.add(item.id);
    }
}

/**
 * Test an integer against inclusive saved-state bounds without coercion.
 *
 * @param {unknown} value - Candidate saved scalar.
 * @param {number} min - Inclusive minimum.
 * @param {number} max - Inclusive maximum.
 * @returns {boolean} Whether the scalar is an integer within the bounds.
 */
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

/**
 * Test a saved scalar against the finite nonnegative native f32 weight boundary.
 *
 * @param {unknown} value - Candidate item weight or equipped multiplier.
 * @returns {boolean} Whether the value is a supported native weight.
 */
const itemWeight = (value) => Number.isFinite(value) && value >= 0 && value <= 3.402_823_466_385_288_6e38;

/**
 * Validate a bounded nonempty persisted equipment name.
 *
 * @param {unknown} value - Candidate registry name.
 * @returns {boolean} Whether the name fits the persisted registry boundary.
 */
const savedName = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;

/**
 * Validate graph topology without executing any candidate-engine mutation.
 *
 * @param {object} record - Authenticated graph save.
 */
function validateGraph(record) {
    const graph = record.inventoryGraph;

    if (!graph || graph.version !== 1 || !Array.isArray(graph.containers) || !graph.containers.length
        || graph.containers.length > 8_193 || !integer(graph.nextContainerId, 2, 0x1_00_00_00_00)
        || typeof graph.organized !== 'boolean' || typeof graph.disorganized !== 'boolean'
        || typeof graph.dropItemsOnSquareCenter !== 'boolean'
        || !itemWeight(graph.equippedMultiplier)) {
        throw new TypeError('Invalid saved inventory graph authority.');
    }

    const nextItemId = record.engine.state.values[11];

    if (!integer(nextItemId, 1, 0x1_00_00_00_00) || graph.items.some((item) => item.id >= nextItemId)) {
        throw new TypeError('Invalid saved inventory item allocator.');
    }

    const items = new Map(graph.items.map((item) => [item.id, item]));
    const containers = new Map();
    const squares = new Set();
    let actor;
    const worldCells = new Set(record.world.cells.map((cell) => `${cell.x},${cell.y}`));
    /**
     * Check native tile membership in the authenticated navigation cells.
     *
     * @param {number} x - World tile x coordinate.
     * @param {number} y - World tile y coordinate.
     * @returns {boolean} Whether the tile belongs to the saved world.
     */
    const worldContains = (x, y) => worldCells.size
        ? worldCells.has(`${Math.floor(x / 256)},${Math.floor(y / 256)}`)
        : x >= 0 && x <= 10 && y >= 0 && y <= 10;

    for (const container of graph.containers) {
        if (!container || !integer(container.id, 1, 0xFF_FF_FF_FF) || containers.has(container.id)
            || container.id >= graph.nextContainerId || !['actor', 'floor', 'bag'].includes(container.kind)
            || !integer(container.capacity, -0x80_00_00_00, 0x7F_FF_FF_FF)
            || !integer(container.weightReduction, 0, 100)
            || typeof container.explored !== 'boolean' || typeof container.looted !== 'boolean'
            || typeof container.type !== 'string' || !container.type
            || ['onlyAcceptCategory', 'acceptItemFunction'].some((key) =>
                container[key] !== null && (typeof container[key] !== 'string' || !container[key]))) {
            throw new TypeError('Invalid or duplicate saved container.');
        }

        if (container.kind === 'actor') {
            if (actor || container.id !== 1 || container.parentKind !== 'actor' || container.parentId !== 1
                || container.containingItemId !== null || container.worldPosition !== null
                || container.definitionOrdinal !== 0 || container.capacity !== 50) {
                throw new TypeError('Invalid saved actor container.');
            }

            actor = container;
        } else if (container.kind === 'floor') {
            const position = container.worldPosition;

            if (container.parentKind !== 'square' || container.parentId !== 0 || container.containingItemId !== null
                || container.definitionOrdinal !== 0 || !position
                || !integer(position.x, -25_600, 25_855) || !integer(position.y, -25_600, 25_855) || position.z !== 0
                || !worldContains(position.x + 0.5, position.y + 0.5) || container.capacity !== 50) {
                throw new TypeError('Invalid saved floor container.');
            }

            const key = `${position.x},${position.y},${position.z}`;

            if (squares.has(key)) {
                throw new TypeError('Duplicate saved floor container square.');
            }

            squares.add(key);
        } else {
            const shell = items.get(container.containingItemId);
            const definition = record.itemDefs[shell?.definitionOrdinal];

            if (container.parentKind !== null || container.parentId !== null || container.worldPosition !== null
                || !shell || shell.internalContainerId !== container.id
                || container.definitionOrdinal !== shell.definitionOrdinal
                || !(definition?.isBag === true || definition?.type === 'Container')) {
                throw new TypeError('Invalid saved bag container pairing.');
            }
        }

        containers.set(container.id, container);
    }

    if (!actor) {
        throw new TypeError('Saved inventory graph omits actor container.');
    }

    for (const item of graph.items) {
        const owner = containers.get(item.ownerContainerId);
        const definition = record.itemDefs[item.definitionOrdinal];
        const internal = containers.get(item.internalContainerId);

        if (!owner || !integer(item.ownerContainerId, 1, 0xFF_FF_FF_FF)
            || ((definition.isBag === true || definition.type === 'Container')
                ? !internal || internal.kind !== 'bag' || internal.containingItemId !== item.id
                : item.internalContainerId !== null)
            || (item.bodyLocation !== null && owner.kind !== 'actor')) {
            throw new TypeError('Invalid saved inventory owner or equipment reference.');
        }

        if (owner.kind === 'floor') {
            const position = item.worldPosition;

            if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y) || position.z !== 0
                || !worldContains(position.x, position.y)
                || Math.floor(position.x) !== owner.worldPosition.x || Math.floor(position.y) !== owner.worldPosition.y) {
                throw new TypeError('Invalid saved inventory world placement.');
            }
        } else if (item.worldPosition !== null) {
            throw new TypeError('Invalid saved inventory world object owner.');
        }
    }

    for (const container of graph.containers) {
        const visited = new Set();
        let current = container;

        while (current.kind === 'bag') {
            if (visited.has(current.id)) {
                throw new TypeError('Cycle in saved inventory container graph.');
            }

            visited.add(current.id);
            current = containers.get(items.get(current.containingItemId).ownerContainerId);
        }
    }

    if (graph.wornOrder !== undefined) {
        const worn = graph.items.filter((item) => item.bodyLocation !== null);

        if (!Array.isArray(graph.wornOrder) || graph.wornOrder.length !== worn.length
            || new Set(graph.wornOrder).size !== graph.wornOrder.length
            || graph.wornOrder.some((id) => !worn.some((item) => item.id === id))) {
            throw new TypeError('Invalid saved graph equipment order.');
        }
    }

    if (Object.hasOwn(record, 'equipmentState')) {
        validateEquipmentState(record.equipmentState, graph);
    }
}

/**
 * Validate persisted registry bindings and worn identities before native staging.
 *
 * @param {object} state - Saved equipment registry.
 * @param {object} graph - Structurally validated inventory graph.
 */
function validateEquipmentState(state, graph) {
    if (!state || state.version !== 1 || typeof state.initialized !== 'boolean'
        || !Array.isArray(state.locations) || state.locations.length > 4_096
        || !Array.isArray(state.groups) || !state.groups.length || state.groups.length > 4_096
        || !integer(state.wornGroup, 0, state.groups.length - 1) || state.groups[0]?.name !== 'Human'
        || !Array.isArray(state.wornOrder) || !Array.isArray(graph.wornOrder)
        || canonical(state.wornOrder) !== canonical(graph.wornOrder)) {
        throw new TypeError('Invalid saved inventory equipment binding.');
    }

    const names = new Set();
    const ids = new Set();

    for (const location of state.locations) {
        if (!location || !savedName(location.id) || !savedName(location.translationName) || ids.has(location.id)) {
            throw new TypeError('Invalid or duplicate saved equipment identity.');
        }

        ids.add(location.id);
    }

    for (const group of state.groups) {
        if (!group || !savedName(group.name) || typeof group.active !== 'boolean'
            || !Array.isArray(group.locations) || group.locations.length > 4_096
            || (group.active && names.has(group.name))) {
            throw new TypeError('Invalid saved equipment group.');
        }

        if (group.active) {
            names.add(group.name);
        }

        const members = new Set();

        for (const member of group.locations) {
            if (!member || !ids.has(member.id) || members.has(member.id) || typeof member.multiItem !== 'boolean'
                || ['exclusive', 'hide', 'alternate'].some((key) => !Array.isArray(member[key])
                    || member[key].length > 4_096 || new Set(member[key]).size !== member[key].length
                    || member[key].some((id) => !ids.has(id)))) {
                throw new TypeError('Invalid saved equipment group member.');
            }

            members.add(member.id);
        }
    }

    const group = state.groups[state.wornGroup];
    const equipped = graph.items.filter((item) => item.bodyLocation !== null);

    for (const item of equipped) {
        const member = group.locations.find(({ id }) => id === item.bodyLocation);

        if (!member) {
            throw new TypeError('Invalid saved inventory equipment reference.');
        }
    }
}

/**
 * Validates an authenticated held pair against saved inventory identities.
 *
 * @param {object} state - Authenticated optional held pair.
 * @param {object[]} items - Fully validated stable inventory rows.
 */
function validateHandState(state, items) {
    if (!state || typeof state !== 'object' || Array.isArray(state) || state.version !== 1
        || Object.keys(state).length !== 3 || !['version', 'primary', 'secondary'].every((key) => Object.hasOwn(state, key))) {
        throw new TypeError('Invalid saved hand state.');
    }

    for (const id of [state.primary, state.secondary]) {
        if (id !== null && (!integer(id, 1, 0xFF_FF_FF_FF)
            || !items.some((item) => item.id === id && item.ownerContainerId === 1))) {
            throw new TypeError('Invalid saved hand inventory reference.');
        }
    }
}

/**
 * Validate portable door metadata without pretending a source-free engine can restore it.
 *
 * @param {object} state - Authenticated optional version-one door state.
 * @returns {void} Rejects malformed state before a candidate engine is created.
 */
function validateDoorState(state) {
    const keys = ['version', 'revision', 'seed', 'rngState', 'lockedHouses', 'doors'];

    if (!state || typeof state !== 'object' || Array.isArray(state)
        || Object.keys(state).length !== keys.length || keys.some((key) => !Object.hasOwn(state, key))
        || state.version !== 1 || !integer(state.revision, 0, 0xFF_FF_FF_FF)
        || !integer(state.seed, 1, 0xFF_FF_FF_FF) || !integer(state.lockedHouses, 1, 6)
        || !Array.isArray(state.rngState) || state.rngState.length !== 2
        || !integer(state.rngState[0], 0, 0xFF_FF_FF_FF) || !integer(state.rngState[1], 0, 0xFF_FF_FF_FF)
        || !Array.isArray(state.doors) || state.doors.length > 65_536) {
        throw new TypeError('Malformed saved door state.');
    }

    const ids = new Set();
    const rowKeys = ['id', 'open', 'locked', 'lockedByKey', 'keyId', 'x', 'y', 'z', 'toggled'];

    for (const row of state.doors) {
        const match = typeof row?.id === 'string' && /^door:(-?\d+):(-?\d+):(-?\d+):(\d+)$/u.exec(row.id);

        if (!row || typeof row !== 'object' || Array.isArray(row)
            || Object.keys(row).length !== rowKeys.length || rowKeys.some((key) => !Object.hasOwn(row, key))
            || !match || row.id !== `door:${Number(match[1])}:${Number(match[2])}:${Number(match[3])}:${Number(match[4])}`
            || !integer(Number(match[1]), -25_600, 25_855) || !integer(Number(match[2]), -25_600, 25_855)
            || !integer(Number(match[3]), -32, 31) || !integer(Number(match[4]), 0, Number.MAX_SAFE_INTEGER)
            || ids.has(row.id) || !integer(row.x, -25_600, 25_855) || !integer(row.y, -25_600, 25_855)
            || !integer(row.z, -32, 31) || !integer(row.keyId, -1, 0x7F_FF_FF_FF)
            || ['open', 'locked', 'lockedByKey', 'toggled'].some((key) => typeof row[key] !== 'boolean')) {
            throw new TypeError('Malformed or duplicate saved door identity/state.');
        }

        ids.add(row.id);
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

    if (copy?.format !== SAVE_FORMAT || ![1, 2, SAVE_VERSION].includes(copy.formatVersion)) {
        throw new TypeError('Unsupported browser save format/version; native saves are not supported.');
    }

    if (typeof copy.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/u.test(copy.id)
        || !Number.isSafeInteger(copy.revision) || copy.revision < 1
        || !Array.isArray(copy.world?.cells) || copy.world.cells.length > 64
        || copy.engine?.abiVersion !== 1 || copy.engine.state?.version !== (copy.formatVersion === 1 ? 1 : 2)
        || !Array.isArray(copy.contentPacks) || !Array.isArray(copy.mods)
        || typeof copy.modState !== 'object' || copy.modState === null
        || typeof copy.integrity !== 'string') {
        throw new TypeError('Malformed browser save envelope.');
    }

    const { integrity, ...payload } = copy;

    if (await digest(payload) !== integrity) {
        throw new TypeError('Browser save integrity check failed; current game remains unchanged.');
    }

    if ((copy.formatVersion === SAVE_VERSION && Object.hasOwn(copy, 'items'))
        || (copy.formatVersion === 2 && Object.hasOwn(copy, 'inventoryGraph'))) {
        throw new TypeError('Browser save contains conflicting flat/graph inventory formats.');
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
        validateNavigationCell(decodeCell(cell.bytes));
    }

    if (Object.hasOwn(copy, 'doorState')) {
        validateDoorState(copy.doorState);
    }

    if (copy.bodyState && Object.hasOwn(copy.bodyState, 'metabolicTarget')
        && (!Number.isFinite(copy.bodyState.metabolicTarget)
            || copy.bodyState.metabolicTarget < -1 || copy.bodyState.metabolicTarget > Math.fround(10.3))) {
        throw new TypeError('Invalid saved metabolic target.');
    }

    if (Object.hasOwn(copy, 'queue')) {
        decodeQueue(copy.queue);
    }

    let validated = copy;

    if (copy.formatVersion !== SAVE_VERSION) {
        if (copy.formatVersion === 2) {
            validateInventory(copy);
        }

        const migrated = migrateLegacySave(payload);

        validated = { ...migrated, integrity: await digest(migrated) };
    }

    validateInventory(validated);
    validateGraph(validated);

    if (Object.hasOwn(validated, 'handState')) {
        validateHandState(validated.handState, validated.inventoryGraph.items);
    }

    return validated;
}

/**
 * Browser persistence for detached saves, retaining the prior committed revision.
 * Engine/world restore is staged in a fresh WASM instance; caller publishes it
 * only after load succeeds. No mod code executes while parsing save data.
 *
 * @param {object} options - Host configuration.
 * @param {string|URL|Uint8Array} options.engineSource - WASM source for staged restores.
 * @param {string} options.appVersion - Diagnostic application version.
 * @param {function(object):Promise<void>} [options.initializeEquipment] - Actual original startup for legacy saves without registry state.
 * @returns {object} Save, load, export/import and storage diagnostics.
 */
function createSaveStore({ engineSource, appVersion, initializeEquipment }) {
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

        if (Object.hasOwn(validated, 'equipmentState')) {
            engine.loadEquipmentState(validated.equipmentState);
        } else if (initializeEquipment) {
            await initializeEquipment(engine);
        }

        for (const definition of validated.itemDefs) {
            engine.registerItemDefinition(definition, { owner: definition.owner });
        }

        engine.importInventoryGraph(validated.inventoryGraph);

        if (Object.hasOwn(validated, 'handState')) {
            engine.loadHandState(validated.handState);
        }

        engine.loadState(validated.engine.state);

        if (Object.hasOwn(validated, 'moodleState')) {
            engine.loadMoodleState(validated.moodleState);
        }

        if (Object.hasOwn(validated, 'bodyState')) {
            engine.loadBodyState(validated.bodyState);
        }

        // Source geometry/door identities are restored by the session before queue publication.
        const queueState = Object.hasOwn(validated, 'queue') ? decodeQueue(validated.queue) : undefined;

        if (queueState && !engine.canSaveQueueState()) {
            throw new Error('Saved source queue is unsupported by this engine module.');
        }

        if (queueState && !Object.hasOwn(validated, 'doorState')) {
            engine.loadQueueState(queueState);
            engine.sourceActions.validateSourceOwners(validated.queue.sourceOwners);
        }

        return {
            engine, record: validated,
            ...(Object.hasOwn(validated, 'doorState') ? { doorState: structuredClone(validated.doorState) } : {}),
            ...(queueState ? { queueState, sourceOwners: structuredClone(validated.queue.sourceOwners) } : {}),
        };
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
            inventoryGraph: engine.exportInventoryGraph(),
            ...(typeof engine.canSaveEquipmentState === 'function' && engine.canSaveEquipmentState()
                ? { equipmentState: engine.saveEquipmentState() }
                : {}),
            moodleState: engine.saveMoodleState(),
            ...(typeof engine.saveDoorState === 'function' ? { doorState: engine.saveDoorState() } : {}),
            ...(typeof engine.saveBodyState === 'function'
                && (typeof engine.canSaveBodyState !== 'function' || engine.canSaveBodyState())
                ? { bodyState: engine.saveBodyState() }
                : {}),
            ...(typeof engine.canSaveHandState === 'function' && engine.canSaveHandState()
                ? { handState: engine.saveHandState() }
                : {}),
            ...(typeof engine.canSaveQueueState === 'function' && engine.canSaveQueueState()
                ? {
                        queue: {
                            version: 2, bytes: encodeCell(engine.saveQueueState()),
                            sourceOwners: engine.sourceActions.exportSourceOwners(),
                        },
                    }
                : {}),
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
