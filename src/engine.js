/**
 * Host wrapper for the authoritative Rust movement engine.
 *
 * The compiled module owns every piece of simulation state: position,
 * destination or heading, speed, world bounds, tick counter and cancellation.
 * This module instantiates it, checks the ABI, refuses unusable input at the
 * trust boundary and hands back detached snapshots. It never mirrors
 * coordinates, so the host cannot drift away from the rules. Numbers submitted
 * to the module are validated at full JavaScript precision. Snapshot scalars
 * originate as 32-bit floats; actor saves transfer twelve 64-bit float words.
 */

/**
 * Detached engine state. Values are copies, so mutating a snapshot cannot
 * change the simulation.
 *
 * @typedef {object} Snapshot
 * @property {number} apiVersion Engine ABI version implemented by the module.
 * @property {number} tick Accepted simulation steps since the last reset. The
 *   module counts unsigned 32-bit, so this wraps at 2^32, about 2.3 years at
 *   60 Hz.
 * @property {number} x World x coordinate, stored as 32-bit. The synthetic
 *   plane spans [0, 10]; imported cells use absolute tile coordinates.
 * @property {number} y World y coordinate, stored as 32-bit.
 * @property {number} speed Movement speed in world units per second, 32-bit.
 * @property {number} action 0 idle, 1 moving to a destination, 2 walking.
 * @property {number} [health] Project health scalar [0,100], if supported.
 * @property {boolean} [dead] Whether the project health scalar is zero.
 */

/**
 * Destination assignment. Out-of-bounds destinations are refused, never
 * clamped.
 *
 * @typedef {object} MoveToCommand
 * @property {'moveTo'} type Command selector.
 * @property {number} x Destination x in the current world.
 * @property {number} y Destination y in the current world.
 */

/**
 * Persistent heading. The vector is normalised, so a longer vector does not
 * move further, and a zero vector cancels instead of inventing a direction.
 *
 * @typedef {object} WalkCommand
 * @property {'walk'} type Command selector.
 * @property {number} x Heading x component.
 * @property {number} y Heading y component.
 */

/**
 * Stops any destination or heading without changing the position.
 *
 * @typedef {object} CancelCommand
 * @property {'cancel'} type Command selector.
 */

/**
 * Any command the engine accepts.
 *
 * @typedef {MoveToCommand | WalkCommand | CancelCommand | object} EngineCommand
 */

/**
 * Detached loaded-cell extents. Coordinates are cell indices, not tile units.
 *
 * @typedef {object} WorldBounds
 * @property {boolean} active Whether imported navigation is active.
 * @property {number} minCx Minimum loaded cell x.
 * @property {number} minCy Minimum loaded cell y.
 * @property {number} maxCx Maximum loaded cell x (inclusive).
 * @property {number} maxCy Maximum loaded cell y (inclusive).
 * @property {number} cells Number of committed cells.
 */

/**
 * Detached actor save; restore cell bytes before loading an active-world save.
 *
 * @typedef {object} SavedState
 * @property {2} version Save envelope version.
 * @property {number[]} values Twelve finite f64 words: x, y, speed, targetX,
 *   targetY, headingX, headingY, action, tick, worldActive, health, nextItemId.
 */

/**
 * Detached authoritative source-square metadata, not navigation heuristics.
 *
 * @typedef {object} EngineSquare
 * @property {number} x Signed int32 tile coordinate.
 * @property {number} y Signed int32 tile coordinate.
 * @property {number} z Signed int32 query elevation.
 * @property {number} roomId Canonical dense room identity, or -1.
 * @property {boolean} outside Source exterior flag.
 * @property {boolean} solid Source solid flag.
 * @property {boolean} solidTrans Source solidtrans flag.
 * @property {boolean} tree Source tree flag.
 * @property {boolean} vehicleObstructed Source vehicle-obstruction flag.
 * @property {boolean} solidFloor Source solidfloor flag.
 * @property {boolean} canStand Native source floor/adjacent-edge predicate.
 */

/**
 * Host-facing engine handle. State lives inside the WASM instance.
 * All world/state methods are optional ABI1 extensions: calling a method whose
 * exports are absent throws a clear unsupported error, without disabling the
 * original movement API. Raw WASM memory and scratch addresses stay private.
 *
 * @typedef {object} Engine
 * @property {function(): Snapshot} snapshot Reads detached state.
 * @property {function(EngineCommand): (Snapshot|import('../types/mod-api').ModQueueAcceptance)} command Submits one command or timed admission.
 * @property {function(number): void} setSpeed Changes speed inside [0.1, 10].
 * @property {function(number): void} step Advances one logical frame inside [0, 0.1].
 * @property {function(number): void} frameStep Advances one frame using uncapped source elapsed time.
 * @property {import('../types/mod-api').ModQueuedActions} actions Native timed FIFO.
 * @property {import('../types/mod-api').ModSourceTiming} sourceTiming Native clock and supported traits.
 * @property {object} sourceActions Private source callback adapter; never exposed to mods.
 * @property {function(): boolean} canSaveQueueState Actual native portable queue capability.
 * @property {function(): Uint8Array} saveQueueState Portable native queue bytes.
 * @property {function(Uint8Array): void} loadQueueState Atomic native queue restore.
 * @property {function(): void} reset Restores the initial state.
 * @property {function(number, number, Uint8Array | DataView): void} worldImportCell
 *   Validates a complete cell before importing it; available on extended ABI1.
 * @property {function(number, number): number} navFlags Navigation bits for an
 *   absolute int32 tile; 0xFFFFFFFF means unloaded.
 * @property {function(): WorldBounds} worldBounds Reads detached cell extents.
 * @property {function(): SavedState} saveState Reads a detached actor save.
 * @property {function(SavedState): void} loadState Restores an actor atomically.
 * @property {function(): void} worldReset Drops imported navigation and cancels
 *   movement, preserving actor position, speed and tick.
 * @property {function(object, object): object} registerItemDefinition Registers a numeric WASM row with source metadata.
 * @property {function(): object[]} itemDefinitions Reads ordered detached definitions.
 * @property {function(string): void} beginItemDefinitionRegistration Begins one owner's activation.
 * @property {function(string): void} commitItemDefinitionRegistration Publishes that activation.
 * @property {function(string): void} rollbackItemDefinitionRegistration Restores first-touch rows and metadata.
 * @property {function(): void} freezeItemDefinitions Internally seals definition registration.
 * @property {function(): object[]} items Reads detached stable-ID item records.
 * @property {function(number): object|null} getItem Reads one detached live stable-ID item record.
 * @property {function(object): void} importInventoryGraph Atomically replaces the ordered item/container graph.
 * @property {function(): object} exportInventoryGraph Captures native graph, allocator and carry configuration.
 * @property {function(): object[]} containers Reads detached native containers.
 * @property {function(number): object|null} getContainer Reads one detached native container.
 * @property {function(number): object[]} containerItems Reads direct membership in native order.
 * @property {function(): number} playerInventoryId Reads the native actor root identity.
 * @property {function(number, number|null): object} containerState Reads native admission and weight state.
 * @property {function(number): object} itemWeights Reads source-authoritative item weight variants.
 * @property {function(): {capacityWeight: number, capacity: number, maxWeight: number}} inventoryState Reads detached native flat-player carry state.
 * @property {function(string): object|null} wornItem Reads the item worn at an exact body location.
 * @property {import('../types/mod-api').ModEquipmentOperation} equipmentOperation Private native registry and worn bridge.
 * @property {function(): import('../types/mod-api').ModWornItem[]} wornItems Native worn/render order.
 * @property {function(string,number|null): void} setWornItem Commits explicit original worn location.
 * @property {function(): boolean} canSaveEquipmentState Actual native equipment snapshot support.
 * @property {function(): import('../types/mod-api').ModEquipmentState} saveEquipmentState Portable canonical registry and worn order.
 * @property {function(import('../types/mod-api').ModEquipmentState): void} loadEquipmentState Restores registry on a staged fresh engine.
 * @property {function(): boolean} isWearingAwkwardGloves Reads native tagged hands equipment.
 * @property {function(): import('../types/mod-api').ModHandItems} getHandItems Actual stable held refs.
 * @property {function('primary'|'secondary', number|null): void} setHandItem Commit one real held slot.
 * @property {function(import('../types/mod-api').ModHandItemChangedListener, function(unknown):void): function():boolean} observeHandItems Private committed-transition observer and owner error sink.
 * @property {function(): boolean} canSaveHandState Actual optional native held support.
 * @property {function(): import('../types/mod-api').ModHandState} saveHandState Detached portable held pair.
 * @property {function(import('../types/mod-api').ModHandState): void} loadHandState Silent atomic held pair restore.
 * @property {function(): number} getHealth Reads the project scalar, not native survival state.
 * @property {function(): boolean} isDead Reports whether that scalar is zero.
 * @property {function(): {id:string,level:number}[]} moodles Original ordered level queries.
 * @property {function(): object} moodleInputLimits Detached owned-input validation metadata.
 * @property {function(): object} saveMoodleState Private-host detached version1 state.
 * @property {function(object): void} loadMoodleState Atomic private-host full restore.
 * @property {function(): void} resetMoodleState Source defaults plus explicit bounded-world policies.
 * @property {function(): object[]} bodyParts Detached source body/thermal records.
 * @property {function(): object} bodyPartInputLimits Native mutable-field validation metadata.
 * @property {function(): number} thermalActionModifier Source six-arm weighted thermal factor.
 * @property {function(): boolean} canSaveBodyState Reports actual optional native body capture support.
 * @property {function(): object} saveBodyState Mutable-only portable version1 body state.
 * @property {function(object): void} loadBodyState Atomic complete native body restore.
 * @property {function(object[], object): void} importDoors Atomically imports native placements and source squares.
 * @property {function(number, number, number): EngineSquare|null} getSquare Reads detached source metadata; null only when absent.
 * @property {function(object, object|null): boolean} isBlockedTo Reads the native directional source-square relation.
 * @property {function(): object[]} doors Reads detached stable-ID native door state.
 * @property {function(): number} doorRevision Reads the native door revision without allocating door records.
 * @property {function(string): object} toggleDoor Executes a native door interaction.
 * @property {function(): object} saveDoorState Saves optional native door state, separate from actor format2.
 * @property {function(object): void} loadDoorState Restores every native door identity atomically.
 */

/** Engine ABI version this host supports; anything else is refused. */
const ENGINE_API_VERSION = 1;

/**
 * Build 42.21.0 MoodleType fields in Registry.values() registration order.
 * Static original JAR SHA-256 e1a69eb743ede60b213a0fe7f8b83d4fcab773036d256cc4543a336f3b058a33:
 * MoodleType.registerBase -> RegistryReset.createLocation -> ResourceLocation.of
 * supplies base and English-lowercases the registered path, without adding underscores.
 */
const MOODLE_TYPES = Object.freeze({
    ENDURANCE: 'base:endurance',
    TIRED: 'base:tired',
    HUNGRY: 'base:hungry',
    PANIC: 'base:panic',
    SICK: 'base:sick',
    BORED: 'base:bored',
    UNHAPPY: 'base:unhappy',
    BLEEDING: 'base:bleeding',
    WET: 'base:wet',
    HAS_A_COLD: 'base:hasacold',
    ANGRY: 'base:angry',
    STRESS: 'base:stress',
    THIRST: 'base:thirst',
    INJURED: 'base:injured',
    PAIN: 'base:pain',
    HEAVY_LOAD: 'base:heavyload',
    DRUNK: 'base:drunk',
    DEAD: 'base:dead',
    ZOMBIE: 'base:zombie',
    HYPERTHERMIA: 'base:hyperthermia',
    HYPOTHERMIA: 'base:hypothermia',
    WINDCHILL: 'base:windchill',
    CANT_SPRINT: 'base:cantsprint',
    UNCOMFORTABLE: 'base:uncomfortable',
    NOXIOUS_SMELL: 'base:noxioussmell',
    FOOD_EATEN: 'base:foodeaten',
});
const MOODLE_IDS = Object.freeze(Object.values(MOODLE_TYPES));
const MOODLE_INPUT_NAMES = Object.freeze([
    'endurance', 'fatigue', 'hunger', 'panic', 'sickness', 'boredom', 'unhappiness',
    'wetness', 'anger', 'stress', 'nicotineWithdrawal', 'thirst', 'pain', 'intoxication',
    'temperature', 'zombieInfection', 'zombieFever', 'foodSickness', 'discomfort',
    'coldStrength', 'hasCold', 'fakeInfected', 'bleedingParts', 'neckBleeding',
    'capacityWeight', 'maxWeight', 'windChill', 'corpseSicknessRate', 'toxicBuilding',
    'protectedFromToxic', 'corpseImpactEnabled', 'cantSprint', 'healthFromFoodTimer',
    'standardHealthFromFoodTime',
]);

const BODY_PART_IDS = Object.freeze([
    'Hand_L', 'Hand_R', 'ForeArm_L', 'ForeArm_R', 'UpperArm_L', 'UpperArm_R',
    'Torso_Upper', 'Torso_Lower', 'Head', 'Neck', 'Groin', 'UpperLeg_L', 'UpperLeg_R',
    'LowerLeg_L', 'LowerLeg_R', 'Foot_L', 'Foot_R',
]);
const BODY_FIELDS = Object.freeze([
    'health', 'scratchTime', 'cutTime', 'biteTime', 'deepWoundTime', 'stitchTime',
    'fractureTime', 'splintFactor', 'burnTime', 'woundInfectionLevel', 'additionalPain',
    'stiffness', 'bandaged', 'haveBullet', 'haveGlass', 'skinTemperature',
]);
const INJURY_SEVERITIES = Object.freeze(['low', 'normal', 'high']);

/** C ABI functions the compiled module must export. */
const ABI = [
    'api_version',
    'reset',
    'set_speed',
    'move_to',
    'walk',
    'cancel',
    'step',
    'position_x',
    'position_y',
    'speed',
    'action',
    'tick',
];

/** Engine refusal codes, defined by engine/src/lib.rs. */
const REASONS = new Map([
    [-1, 'non-finite input'],
    [-2, 'value outside the accepted range'],
    [-3, 'blocked'],
    [-4, 'malformed input'],
    [-5, 'unsupported original facility'],
]);

/**
 * Obtains module bytes from a URL or from memory.
 *
 * Relative strings resolve against this module, which is what an http(s) page
 * needs. Byte sources skip fetching entirely, which is what Node tests and any
 * consumer that already holds the artifact wants.
 *
 * @param {string | URL | Uint8Array | DataView} source - Module location or bytes.
 * @returns {Promise<Uint8Array | DataView>} Raw module bytes.
 * @throws {TypeError} When the source is neither a URL nor a byte array.
 */
async function readBytes(source) {
    if (ArrayBuffer.isView(source)) {
        return source;
    }

    if (typeof source === 'string' || source instanceof URL) {
        const url = typeof source === 'string' ? new URL(source, import.meta.url) : source;

        if (url.protocol === 'file:') {
            throw new TypeError(`Read ${url} and pass the bytes to createEngine; fetch cannot use file: URLs.`);
        }

        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`Engine module fetch failed: HTTP ${response.status} for ${url}`);
        }

        return new Uint8Array(await response.arrayBuffer());
    }

    throw new TypeError('createEngine requires a module URL or a byte array.');
}

/**
 * Rejects values that cannot be handed to the engine at all. Numeric ranges
 * stay with the engine so the movement rules have exactly one owner.
 *
 * @param {unknown} value - Candidate value.
 * @param {string} name - Field name used in the failure message.
 * @returns {number} The validated finite number.
 * @throws {TypeError} When the value is not a finite number.
 */
function requireCoordinate(value, name) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(`${name} must be a finite number, received ${String(value)}.`);
    }

    return value;
}

/**
 * Turns an engine refusal into an exception, so a rejected command can never be
 * mistaken for one that changed the simulation.
 *
 * @param {number} code - Status code returned by the engine.
 * @param {string} label - Command description used in the failure message.
 */
function requireAccepted(code, label) {
    if (code !== 0) {
        throw new RangeError(`${label}: engine refused the command (${REASONS.get(code) ?? `status ${code}`}).`);
    }
}

/**
 * Validate a value-returning native export independently of zero-only mutation statuses.
 *
 * @param {number} value - Native integer data or a negative refusal.
 * @param {string} label - Operation context.
 * @param {number} min - Inclusive data minimum.
 * @param {number} max - Inclusive data maximum.
 * @returns {number} Validated data.
 */
function requireResult(value, label, min, max) {
    if (value < 0) {
        requireAccepted(value, label);
    }

    return requireInteger(value, label, min, max);
}

/**
 * Validates integers before WASM's implicit int32 conversion can wrap them.
 *
 * @param {unknown} value - Candidate integer.
 * @param {string} name - Field name used in refusal messages.
 * @param {number} min - Inclusive minimum.
 * @param {number} max - Inclusive maximum.
 * @returns {number} Validated integer.
 */
function requireInteger(value, name, min, max) {
    requireCoordinate(value, name);

    if (!Number.isInteger(value)) {
        throw new TypeError(`${name} must be an integer.`);
    }

    if (value < min || value > max) {
        throw new RangeError(`${name} must be inside [${min}, ${max}].`);
    }

    return value;
}

/**
 * Validate and return a stable native container identity.
 *
 * @param {number} value - Candidate container ID.
 * @returns {number} Positive uint32 container ID.
 */
const containerId = (value) => requireInteger(value, 'container ID', 1, 0xFF_FF_FF_FF);

/**
 * Validate and return a stable native item identity.
 *
 * @param {number} value - Candidate item ID.
 * @returns {number} Positive uint32 item ID.
 */
const itemId = (value) => requireInteger(value, 'item ID', 1, 0xFF_FF_FF_FF);

/**
 * Convert an optional actor identity to its native encoding.
 *
 * @param {number|null} value - Actor ID, zero, or null for no actor.
 * @returns {number} Native actor token in [0, 1].
 */
const actorId = (value) => value === null ? 0 : requireInteger(value, 'actor ID', 0, 1);

/**
 * Validate a native container policy result.
 *
 * @param {number} value - Native result.
 * @returns {number} Policy result in [-1, 1].
 */
const policyResult = (value) => requireInteger(value, 'container policy result', -1, 1);

/**
 * Rejects invalid Java-float weights at full host precision before staging.
 *
 * @param {unknown} value - Candidate weight.
 * @param {string} name - Field label.
 * @returns {number} Validated value, converted to f32 only by the native boundary.
 */
function requireItemWeight(value, name) {
    requireCoordinate(value, name);

    if (value < 0 || value > 3.402_823_466_385_288_6e38) {
        throw new RangeError(`${name} must be a nonnegative finite f32 weight.`);
    }

    return value;
}

/**
 * Packs strict source booleans without truthiness conversion.
 *
 * @param {object} row - Source record.
 * @param {string[]} names - Ordered flag names.
 * @returns {number} Numeric native flags.
 */
function doorFlags(row, names) {
    let flags = 0;

    for (const [index, name] of names.entries()) {
        let value = (name === 'hoppable' || name === 'customLock') ? row[name] ?? false : row[name];

        if (name === 'solidFloor' && value === undefined) {
            value = false;
        }

        if (typeof value !== 'boolean') {
            throw new TypeError(`${name} must be a boolean.`);
        }

        flags |= Number(value) << index;
    }

    return flags;
}

/**
 * Validates original cardinal source masks, not sprite-name heuristics.
 *
 * @param {unknown} value - N2/W4 mask.
 * @param {string} name - Refusal label.
 * @returns {number} Native edge mask.
 */
function doorMask(value, name) {
    const mask = requireInteger(value, name, 0, 6);

    if ((mask & ~6) !== 0) {
        throw new RangeError(`${name} must contain only north2/west4.`);
    }

    return mask;
}

/**
 * Validates exact identity strings without normalization.
 *
 * @param {unknown} value - Candidate identity.
 * @param {string} label - Error context.
 * @returns {string} Exact nonempty identity.
 */
function requireName(value, label) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${label} must be a nonempty string.`);
    }

    return value;
}

/**
 * Canonicalizes source ResourceLocation identities, splitting the first colon.
 *
 * @param {unknown} value - Source tag identity.
 * @returns {string} Lowercase full resource ID, with base as the absent namespace.
 */
function itemTagResourceLocation(value) {
    const name = requireName(value, 'item tag').trim();
    const colon = name.indexOf(':');
    const namespace = colon === -1 ? 'base' : name.slice(0, colon);
    const path = colon === -1 ? name : name.slice(colon + 1);

    requireName(namespace, 'item tag namespace');
    requireName(path, 'item tag path');

    return `${namespace.toLowerCase()}:${path.toLowerCase()}`;
}

/**
 * Interns host identities for opaque numeric WASM references.
 *
 * @param {string} value - Exact identity.
 * @param {Map<string, number>} ids - Identity lookup.
 * @param {Array<string|null>} names - Reverse identity lookup.
 * @returns {number} Stable internal token.
 */
function intern(value, ids, names) {
    if (!ids.has(value)) {
        ids.set(value, names.length);
        names.push(value);
    }

    return ids.get(value);
}

/**
 * Refuses null, arrays and nonobjects before moodle state validation.
 *
 * @param {unknown} value - Candidate object.
 * @param {string} label - Error context.
 */
function requireMoodleObject(value, label) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object.`);
    }
}

/**
 * Copy validated coordinates before native int32 conversion.
 *
 * @param {object} value - Coordinate record.
 * @param {string} label - Boundary diagnostic.
 * @returns {number[]} Exact signed int32 coordinates.
 */
function squareCoordinates(value, label) {
    requireMoodleObject(value, label);

    return ['x', 'y', 'z'].map((name) =>
        requireInteger(value[name], `${label} ${name}`, -0x80_00_00_00, 0x7F_FF_FF_FF));
}

/**
 * Maps public normalized severity without conflating damage multipliers.
 *
 * @param {unknown} severity - low, normal or high.
 * @returns {number} Native severity index.
 */
function injurySeverity(severity) {
    const index = typeof severity === 'string' ? INJURY_SEVERITIES.indexOf(severity) : -1;

    if (index === -1) {
        throw new RangeError('Injury severity must be low, normal or high.');
    }

    return index;
}

/**
 * Parses every record before any import call can change the world.
 *
 * @param {Uint8Array | DataView} bytes - Cell byte view (header 00 01).
 * @returns {{view: DataView, tags: Uint8Array, offsets: Int32Array}} Valid records.
 */
function parseCell(bytes) {
    if (!(bytes instanceof Uint8Array) && !(bytes instanceof DataView)) {
        throw new TypeError('cell bytes must be a Uint8Array or DataView.');
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    if (view.byteLength < 2) {
        throw new TypeError('truncated cell header.');
    }

    if (view.getUint8(0) !== 0 || view.getUint8(1) !== 1) {
        throw new TypeError('cell header must be 00 01.');
    }

    const tags = new Uint8Array(1_024);
    const offsets = new Int32Array(1_024);
    let offset = 2;

    for (let index = 0; index < 1_024; index += 1) {
        if (offset >= view.byteLength) {
            throw new TypeError(`truncated cell record ${index}.`);
        }

        const tag = view.getUint8(offset++);

        if (tag > 5) {
            throw new TypeError(`cell record ${index} has invalid tag ${tag}.`);
        }

        tags[index] = tag;

        if (tag === 2) {
            if (offset + 64 > view.byteLength) {
                throw new TypeError(`truncated cell tile data at record ${index}.`);
            }

            offsets[index] = offset;

            for (let tile = 0; tile < 64; tile += 1) {
                if (view.getUint8(offset + tile) > 0x3F) {
                    throw new TypeError(`cell record ${index} has invalid navigation bits.`);
                }
            }

            offset += 64;
        }
    }

    if (offset !== view.byteLength) {
        throw new TypeError('cell has trailing bytes after its 1024 records.');
    }

    return { view, tags, offsets };
}

/**
 * Validate a full native navigation cell without changing simulation state.
 * Used by precommit mod hooks so malformed content never reaches callbacks.
 *
 * @param {Uint8Array|DataView} bytes - Complete version1 navigation cell.
 * @returns {void} Throws on invalid format, records, flags or EOF.
 */
function validateNavigationCell(bytes) {
    parseCell(bytes);
}

/**
 * Instantiates the engine module and returns the host-facing handle.
 *
 * @param {string | URL | Uint8Array | DataView} source - Module URL, URL-ish
 *   string or bytes. Browser hosts pass `'./engine/pz_engine.wasm'`.
 * @returns {Promise<Engine>} A ready handle with private state.
 * @throws {TypeError} On an unusable source or malformed command input.
 * @throws {RangeError} On a value the engine rules refuse.
 * @throws {Error} On an instantiation or ABI failure.
 */
async function createEngine(source) {
    const bytes = await readBytes(source);
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const api = instance.exports;
    const missing = ABI.filter((name) => typeof api[name] !== 'function');

    if (missing.length > 0) {
        throw new Error(`Engine module is missing exports: ${missing.join(', ')}.`);
    }

    const apiVersion = api.api_version();

    if (apiVersion !== ENGINE_API_VERSION) {
        throw new Error(`Engine module reports ABI ${apiVersion}; this host requires ${ENGINE_API_VERSION}.`);
    }

    /**
     * Old ABI1 modules retain movement without requiring optional exports.
     *
     * @param {string} method - Host method requesting this capability.
     * @param {string[]} names - Required optional WASM export names.
     */
    function requireOptional(method, names) {
        if (names.some((name) => typeof api[name] !== 'function')) {
            throw new Error(`${method} is unsupported by this engine module.`);
        }
    }

    /**
     * Never retain a WASM memory view across a call that could grow memory.
     *
     * @param {string} method - Host method requesting scratch space.
     * @returns {DataView} Fresh view of the private aligned scratch buffer.
     */
    function scratch(method) {
        requireOptional(method, ['scratch_ptr', 'scratch_size']);

        if (!(api.memory instanceof WebAssembly.Memory)) {
            throw new TypeError(`${method} is unsupported: engine memory is unavailable.`);
        }

        const ptr = api.scratch_ptr() >>> 0;
        const size = api.scratch_size() >>> 0;
        const buffer = api.memory.buffer;

        if (size !== 96 || ptr % 8 !== 0 || ptr + size > buffer.byteLength) {
            throw new Error(`${method}: invalid engine scratch buffer.`);
        }

        return new DataView(buffer, ptr, size);
    }

    /**
     * Checks an optional state operation and its twelve-word ABI.
     *
     * @param {string} method - Host method requesting state access.
     * @param {string} name - Required state operation export.
     */
    function requireState(method, name) {
        requireOptional(method, [name, 'state_size']);

        if (api.state_size() !== 12) {
            throw new Error(`${method}: engine state must contain twelve values.`);
        }
    }

    /**
     * Reads every observable value from the module.
     *
     * @returns {Snapshot} Detached copies of the current state.
     */
    function snapshot() {
        return {
            apiVersion,
            tick: api.tick() >>> 0,
            x: api.position_x(),
            y: api.position_y(),
            speed: api.speed(),
            action: api.action(),
            ...(typeof api.health === 'function' && typeof api.is_dead === 'function'
                ? { health: api.health(), dead: api.is_dead() !== 0 }
                : {}),
        };
    }

    /**
     * Submits one command. The engine decides the outcome, so a destination at
     * the current position ends idle rather than pretending to travel.
     *
     * @param {EngineCommand} action - Command to submit.
     * @returns {Snapshot|import('../types/mod-api').ModQueueAcceptance} Immediate state or queued admission, never completed pickup/door state.
     */
    function command(action) {
        let spawnedId;

        const heldBefore = handObservers.size > 0 && (action?.type === 'drop' || action?.type === 'setCondition')
            ? getHandItems()
            : null;

        switch (action?.type) {
            case 'moveTo': {
                const x = requireCoordinate(action.x, 'moveTo x');
                const y = requireCoordinate(action.y, 'moveTo y');

                requireAccepted(api.move_to(x, y), `moveTo(${x}, ${y})`);
                break;
            }
            case 'walk': {
                const x = requireCoordinate(action.x, 'walk x');
                const y = requireCoordinate(action.y, 'walk y');

                requireAccepted(api.walk(x, y), `walk(${x}, ${y})`);
                break;
            }
            case 'cancel':
                // ABI1 cancel is void: surface queue failure, but always stop primitive movement.
                try {
                    if (typeof api.queue_capability === 'function') {
                        queueCall('cancel', 'queue_clear');
                    }
                } finally {
                    api.cancel();
                }

                break;
            case 'toggleDoor':
                return toggleDoor(action.id);
            case 'requestWalk':
                return actions.requestWalk(action);
            case 'spawnItem': {
                requireOptional('spawnItem', ['item_spawn', 'item_last_id']);
                const ordinal = definitionOrdinal(action.fullType);
                const definition = resolvedDefinition(ordinal);
                const x = requireCoordinate(action.x, 'spawnItem x');
                const y = requireCoordinate(action.y, 'spawnItem y');
                const count = requireInteger(action.count ?? 1, 'count', 1, 0xFF_FF_FF_FF);
                const condition = requireInteger(action.condition ?? definition.conditionMax,
                    'condition', 0, 0x7F_FF_FF_FF);

                requireAccepted(api.item_spawn(ordinal, x, y, count, condition), 'spawnItem');
                spawnedId = api.item_last_id() >>> 0;
                break;
            }
            case 'setHandItem':
                setHandItem(action.slot, action.itemId);
                break;
            case 'pickup':
                return actions.requestPickup(action.id);
            case 'transferItem':
                return actions.requestTransfer(action.id, action.sourceContainerId, action.destinationContainerId);
            case 'wear':
            case 'unequip': {
                const name = `item_${action.type}`;

                requireOptional(action.type, [name]);
                requireAccepted(api[name](requireInteger(action.id, 'item id', 1, 0xFF_FF_FF_FF)), action.type);
                break;
            }
            case 'wornSet':
                equipmentOperation('wornSet', action.locationToken, action.id);
                break;
            case 'wornRemove':
                equipmentOperation('wornRemove', action.id);
                break;
            case 'wornClear':
                equipmentOperation('wornClear');
                break;
            case 'wornGroupSet':
                equipmentOperation('wornGroupSet', action.groupToken);
                break;
            case 'drop':
                requireOptional('drop', ['item_drop']);
                requireAccepted(api.item_drop(requireInteger(action.id, 'item id', 1, 0xFF_FF_FF_FF),
                    requireCoordinate(action.x, 'drop x'), requireCoordinate(action.y, 'drop y')), 'drop');
                break;
            case 'setCondition':
                requireOptional('setCondition', ['item_set_condition']);
                requireAccepted(api.item_set_condition(requireInteger(action.id, 'item id', 1, 0xFF_FF_FF_FF),
                    requireInteger(action.condition, 'condition', 0, 0x7F_FF_FF_FF)), 'setCondition');
                break;
            case 'setWeight':
            case 'setActualWeight': {
                const actual = action.type === 'setActualWeight';
                const name = actual ? 'item_set_actual_weight' : 'item_set_weight';
                const field = actual ? 'actualWeight' : 'weight';

                requireOptional(action.type, [name]);
                requireAccepted(api[name](requireInteger(action.id, 'item id', 1, 0xFF_FF_FF_FF),
                    requireItemWeight(action[field], field)), action.type);
                break;
            }
            case 'setHealth':
                requireOptional('setHealth', ['set_health']);
                requireAccepted(api.set_health(requireCoordinate(action.health, 'health')), 'setHealth');
                break;
            case 'setCharacterStat': {
                requireOptional('setCharacterStat', ['set_character_stat', 'moodle_input_limit']);
                const index = MOODLE_INPUT_NAMES.indexOf(action.name);

                if (index === -1 || index >= 19) {
                    throw new RangeError(`Unknown character stat: ${String(action.name)}.`);
                }

                const value = validateMoodleInput(action.name, action.value);

                requireAccepted(api.set_character_stat(index, value), 'setCharacterStat');
                break;
            }
            case 'setMoodleInputs': {
                requireMoodleObject(action.inputs, 'Moodle inputs');
                const state = saveMoodleState();

                for (const name of Object.keys(action.inputs)) {
                    validateMoodleInput(name, action.inputs[name]);
                    state.inputs[name] = action.inputs[name];
                }

                loadMoodleState(state);
                break;
            }
            case 'setBodyPart':
                setBodyPart(action.part, action.values);
                break;
            case 'setInjurySeverity':
                requireOptional('setInjurySeverity', ['set_injury_severity']);
                requireAccepted(api.set_injury_severity(injurySeverity(action.severity)), 'setInjurySeverity');
                break;

            default:
                throw new TypeError(`Unknown engine command: ${String(action?.type)}.`);
        }

        if (heldBefore) {
            notifyHandItems(heldBefore);
        }

        return spawnedId === undefined ? snapshot() : { ...snapshot(), id: spawnedId };
    }

    /**
     * Changes movement speed. Distance covered per accepted step scales with
     * this value, so a mod that changes it changes the simulation.
     *
     * @param {number} speed - World units per second, accepted range [0.1, 10].
     */
    function setSpeed(speed) {
        requireCoordinate(speed, 'speed');
        requireAccepted(api.set_speed(speed), `setSpeed(${speed})`);
    }

    /**
     * Advances one explicit logical frame, including the zero-time boundary.
     *
     * @param {number} seconds - Elapsed frame time in [0, 0.1].
     */
    function step(seconds) {
        requireCoordinate(seconds, 'step seconds');
        const heldBefore = handObservers.size > 0 ? getHandItems() : null;

        requireAccepted(api.step(seconds), `step(${seconds})`);

        if (heldBefore) {
            notifyHandItems(heldBefore);
        }
    }

    /**
     * Advance one RAF logic frame; native movement alone caps elapsed to .1.
     *
     * @param {number} seconds - Finite nonnegative raw elapsed seconds.
     */
    function frameStep(seconds) {
        requireCoordinate(seconds, 'frameStep seconds');

        if (seconds < 0) {
            throw new RangeError('frameStep seconds must be nonnegative.');
        }

        requireOptional('frameStep', ['frame_step']);
        const heldBefore = handObservers.size > 0 ? getHandItems() : null;

        requireAccepted(api.frame_step(seconds), 'frameStep');

        if (heldBefore) {
            notifyHandItems(heldBefore);
        }
    }

    /**
     * Restores position (5, 5), speed 1.5, the idle action and a zero tick.
     */
    function reset() {
        const heldBefore = handObservers.size > 0 ? getHandItems() : null;

        api.reset();
        transferHandState = null;
        doorIds = [null];
        doorOrdinals.clear();
        definitionMetadata.length = 0;
        definitionOrdinals.clear();
        ownerIds.clear();
        ownerNames.length = 1;
        definitionTransaction = null;
        policyIds.clear();
        policyNames.length = 1;

        for (const name of ['inventory', 'floor', 'container']) {
            intern(name, policyIds, policyNames);
        }

        if (heldBefore) {
            notifyHandItems(heldBefore);
        }
    }

    /**
     * Imports one 256x256-tile cell, atomically replacing the same coordinate.
     * The format is 00 01 then exactly 1024 row-major 8x8 records: tag 0..5;
     * tag 2 alone carries 64 bytes, each with known navigation bits <= 0x3F.
     * A successful import cancels movement; it never relocates the actor.
     *
     * @param {number} cx - Integer cell x inside [-100, 100].
     * @param {number} cy - Integer cell y inside [-100, 100].
     * @param {Uint8Array | DataView} bytes - Complete cell bytes.
     * @throws {Error} When the module lacks this optional ABI1 capability.
     * @throws {TypeError} On malformed or truncated cell bytes.
     * @throws {RangeError} On coordinates outside the accepted range.
     */
    function worldImportCell(cx, cy, bytes) {
        requireOptional('worldImportCell', ['world_import_chunk']);
        requireInteger(cx, 'cell x', -100, 100);
        requireInteger(cy, 'cell y', -100, 100);
        const { view, tags, offsets } = parseCell(bytes);

        for (let index = 0; index < 1_024; index += 1) {
            const tag = tags[index];
            const offset = offsets[index];

            // Eight packed little-endian i64 words, never a call per tile.
            requireAccepted(api.world_import_chunk(cx, cy, index, tag,
                tag === 2 ? view.getBigInt64(offset, true) : 0n,
                tag === 2 ? view.getBigInt64(offset + 8, true) : 0n,
                tag === 2 ? view.getBigInt64(offset + 16, true) : 0n,
                tag === 2 ? view.getBigInt64(offset + 24, true) : 0n,
                tag === 2 ? view.getBigInt64(offset + 32, true) : 0n,
                tag === 2 ? view.getBigInt64(offset + 40, true) : 0n,
                tag === 2 ? view.getBigInt64(offset + 48, true) : 0n,
                tag === 2 ? view.getBigInt64(offset + 56, true) : 0n),
            `cell(${cx}, ${cy}) record ${index}`);
        }
    }

    /**
     * Reads SOLID1, WALL_NORTH2, WALL_WEST4, WATER8, ROOM16, VOID32 bits.
     *
     * @param {number} x - Absolute int32 tile x.
     * @param {number} y - Absolute int32 tile y.
     * @returns {number} Unsigned flags, or 0xFFFFFFFF for unloaded tiles.
     */
    function navFlags(x, y) {
        requireOptional('navFlags', ['nav_flags']);
        requireInteger(x, 'tile x', -2_147_483_648, 2_147_483_647);
        requireInteger(y, 'tile y', -2_147_483_648, 2_147_483_647);

        return api.nav_flags(x, y) >>> 0;
    }

    /**
     * Reads committed-cell bounds without exposing WASM memory.
     *
     * @returns {WorldBounds} Detached committed-cell extents.
     */
    function worldBounds() {
        requireOptional('worldBounds', ['world_bounds']);
        const ptr = scratch('worldBounds').byteOffset;

        api.world_bounds(ptr);
        const view = scratch('worldBounds');

        return {
            active: view.getInt32(0, true) !== 0,
            minCx: view.getInt32(4, true),
            minCy: view.getInt32(8, true),
            maxCx: view.getInt32(12, true),
            maxCy: view.getInt32(16, true),
            cells: view.getInt32(20, true),
        };
    }

    /**
     * Reads a detached actor save; callers persist imported cells separately.
     *
     * @returns {SavedState} Detached actor state, excluding imported cells.
     */
    function saveState() {
        requireState('saveState', 'state_save');
        const ptr = scratch('saveState').byteOffset;

        api.state_save(ptr);
        const view = scratch('saveState');

        return {
            version: 2, values: Array.from({ length: 12 },
                (_, index) => view.getFloat64(index * 8, true)),
        };
    }

    /**
     * Restores actor state atomically; Rust validates semantics and reconstructs
     * any destination path against cells already imported into this instance.
     * To spawn in a nonzero cell use idle state with position=target, zero
     * heading and worldActive=1.
     *
     * @param {SavedState} state - Version 2 envelope containing twelve finite numbers.
     * @throws {TypeError} On an invalid save envelope.
     * @throws {RangeError} When Rust refuses the state without changing it.
     */
    function loadState(state) {
        requireState('loadState', 'state_load');

        if (state === null || typeof state !== 'object' || state.version !== 2
            || !Array.isArray(state.values) || state.values.length !== 12) {
            throw new TypeError('loadState requires version 2 and exactly twelve finite values.');
        }

        // Validate all words before writing even the private scratch buffer.
        const values = Array.from(state.values, (value, index) =>
            requireCoordinate(value, `state value ${index}`));
        const view = scratch('loadState');

        for (let index = 0; index < 12; index += 1) {
            view.setFloat64(index * 8, values[index], true);
        }

        requireAccepted(api.state_load(view.byteOffset), 'loadState');
    }

    /** Drops cells/routes and cancels movement, preserving position/speed/tick. */
    function worldReset() {
        requireOptional('worldReset', ['world_reset']);
        api.world_reset();
        doorIds = [null];
        doorOrdinals.clear();
    }

    // Stable public identities only; all door policy and numeric state live in WASM.
    let doorIds = [null];
    let doorOrdinals = new Map();
    const doorBooleanNames = ['north', 'open', 'locked', 'lockedByKey', 'forceLocked',
        'attachedE', 'attachedS', 'barricaded', 'interiorSide', 'hoppable', 'customLock'];
    const squareBooleanNames = ['outside', 'solid', 'solidTrans', 'tree', 'vehicleObstructed', 'solidFloor'];
    const interactionBits = new Map([
        ['collideN', 2], ['collideW', 4], ['windowN', 8], ['windowW', 16],
        ['blockedWindowN', 32], ['blockedWindowW', 64], ['stairsTN', 128], ['stairsTW', 256],
    ]);
    // Source square flags: exterior1, solid2, solidtrans4, tree8, vehicle16, solidfloor32.

    /**
     * Validates complete source relation snapshots before any scratch/native staging.
     *
     * @param {object} value - Explicit boolean property snapshot.
     * @param {string} label - Boundary diagnostic.
     * @param {boolean} [door] - Actual doors cannot supply blocked-window state.
     * @returns {number} Native source property mask.
     */
    function interactionMask(value, label, door = false) {
        requireMoodleObject(value, label);
        const prototype = Object.getPrototypeOf(value);

        if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError(`${label} must be a plain object.`);
        }

        let mask = 0;

        for (const key of Reflect.ownKeys(value)) {
            const bit = interactionBits.get(key);
            const enabled = value[key];

            if (bit === undefined || typeof enabled !== 'boolean') {
                throw new TypeError(`${label} requires only known boolean source properties.`);
            }

            if (door && enabled && (bit === 32 || bit === 64)) {
                throw new TypeError(`${label} cannot mark an IsoDoor as a blocked IsoWindow.`);
            }

            if (enabled) {
                mask |= bit;
            }
        }

        return mask;
    }

    /**
     * Transfers one validated numeric record into bounded private scratch.
     *
     * @param {number[]} values - At most twelve native words.
     * @param {string} method - Operation label.
     */
    function doorWords(values, method) {
        const view = scratch(method);

        for (let index = 0; index < 12; index += 1) {
            view.setFloat64(index * 8, values[index] ?? 0, true);
        }
    }

    /**
     * Encode exact immutable source getWallExcludingList facts, not collision masks.
     *
     * @param {object} walls - Known source north/west facts.
     * @param {string} label - Validation context.
     * @returns {number} Source reach north2/west4 mask.
     */
    function reachMask(walls, label) {
        requireMoodleObject(walls, label);

        if (Object.keys(walls).length !== 2 || !Object.hasOwn(walls, 'north') || !Object.hasOwn(walls, 'west')
            || typeof walls.north !== 'boolean' || typeof walls.west !== 'boolean') {
            throw new TypeError(`${label} requires exactly boolean north and west fields.`);
        }

        return Number(walls.north) * 2 + Number(walls.west) * 4;
    }

    /**
     * Imports source geometry and explicit state atomically. Native constructors
     * may initialize new-world locks with a saved port-owned seed; restores never
     * generate locks. Vehicle flags are valid only for the explicit zero-vehicle
     * world until an authoritative native vehicle geometry producer exists.
     * Optional standEdges contains initialClosed/initialOpen/toggledClosed/
     * toggledOpen north2/west4 masks. Optional squareFlags contains four masks of
     * source solid2/solidtrans4/tree8/solidfloor32 in the same state order. Both
     * default to all zero and remain immutable source metadata, not saved state.
     * Base squares may supply solidFloor (default false) and hoppableEdges (default zero).
     * Square windows retains raw collision bits; windowEdges supplies actual
     * created-window/frame stand edges, defaulting to windows when omitted.
     * Optional square interactionProperties supplies strictly boolean source flags,
     * actual blocked-window state and cached stair tops, independently of old masks.
     * Door interactionProperties supplies four current-sprite snapshots in the same
     * state order as standEdges; absent snapshots mean empty source properties.
     * Optional reachWalls is a strictly known north/west pair for squares, and four
     * pairs in the same sprite order for doors. Missing facts remain unknown natively.
     * These extra immutable stagers do not reuse the twelve-row reserved word.
     *
     * @param {object[]} rows - Stable CLOSED-placement identities and source flags.
     * @param {object} options - Native geometry and generation configuration.
     * @param {object[]} options.squares - Unique source square metadata.
     * @param {number} [options.seed=1] - Positive port-owned u32 world seed.
     * @param {number} [options.lockedHouses=4] - Source sandbox choice 1..6.
     * @param {boolean} [options.initializeLocks=false] - New world only.
     */
    function importDoors(rows, { squares, seed = 1, lockedHouses = 4, initializeLocks = false } = {}) {
        requireOptional('importDoors', ['door_import_begin', 'door_import_stage', 'door_square_stage',
            'door_import_commit', 'door_import_abort', 'door_read', 'door_count', 'door_import_interaction_properties']);

        if (!Array.isArray(rows) || rows.length > 65_536
            || !Array.isArray(squares) || squares.length > 1_048_576) {
            throw new TypeError('importDoors requires bounded door and unique square arrays.');
        }

        requireInteger(seed, 'door seed', 1, 0xFF_FF_FF_FF);
        requireInteger(lockedHouses, 'lockedHouses', 1, 6);

        if (typeof initializeLocks !== 'boolean') {
            throw new TypeError('initializeLocks must be a boolean.');
        }

        const ids = [null];
        const ordinals = new Map();
        const interactionRows = [];
        const reachRows = [];
        const curtainRows = [];
        const numeric = rows.map((row, index) => {
            requireMoodleObject(row, 'Door row');
            const x = requireInteger(row.x, 'door x', -25_600, 25_855);
            const y = requireInteger(row.y, 'door y', -25_600, 25_855);
            const z = requireInteger(row.z, 'door z', -32, 31);
            const id = requireName(row.id, 'door id');
            const match = /^door:(-?\d+):(-?\d+):(-?\d+):(\d+)$/u.exec(id);

            if (!match || id !== `door:${x}:${y}:${z}:${Number(match[4])}`
                || !Number.isSafeInteger(Number(match[4])) || ordinals.has(id)) {
                throw new TypeError('Door identity must match its exact original placement and unique order.');
            }

            ids.push(id);
            ordinals.set(id, index + 1);
            const doubleDoor = requireInteger(row.doubleDoor ?? 0, 'doubleDoor', 0, 4);
            const garageDoor = requireInteger(row.garageDoor ?? 0, 'garageDoor', 0, 3);

            if (doubleDoor !== 0 && garageDoor !== 0) {
                throw new TypeError('Door cannot be both double and garage.');
            }

            if (row.interactionProperties !== undefined
                && (!Array.isArray(row.interactionProperties) || row.interactionProperties.length !== 4)) {
                throw new TypeError('door interactionProperties requires four source property objects.');
            }

            interactionRows.push(Array.from({ length: 4 }, (_, state) => row.interactionProperties === undefined
                ? 0
                : interactionMask(row.interactionProperties[state], `door interactionProperties[${state}]`, true)));

            if (row.reachWalls !== undefined && (!Array.isArray(row.reachWalls) || row.reachWalls.length !== 4)) {
                throw new TypeError('door reachWalls requires four source north/west objects.');
            }

            reachRows.push(row.reachWalls === undefined
                ? null
                : Array.from({ length: 4 }, (_, state) => reachMask(row.reachWalls[state], `door reachWalls[${state}]`)));

            if (row.curtainCapabilities !== undefined && (!Array.isArray(row.curtainCapabilities) || row.curtainCapabilities.length !== 4)) {
                throw new TypeError('door curtainCapabilities requires four source booleans.');
            }

            let curtainMask = null;

            if (row.curtainCapabilities !== undefined) {
                curtainMask = 0;

                for (let state = 0; state < 4; state += 1) {
                    const eligible = row.curtainCapabilities[state];

                    if (typeof eligible !== 'boolean') {
                        throw new TypeError('door curtainCapabilities requires strict booleans.');
                    }

                    curtainMask |= Number(eligible) << state;
                }
            }

            curtainRows.push(curtainMask);

            if (row.standEdges !== undefined
                && (!Array.isArray(row.standEdges) || row.standEdges.length !== 4)) {
                throw new TypeError('standEdges requires four source north2/west4 masks.');
            }

            if (row.squareFlags !== undefined
                && (!Array.isArray(row.squareFlags) || row.squareFlags.length !== 4)) {
                throw new TypeError('squareFlags requires four source solid2/solidtrans4/tree8/solidfloor32 masks.');
            }

            let spriteFacts = 0;

            for (let state = 0; state < 4; state += 1) {
                const edges = row.standEdges === undefined
                    ? 0
                    : doorMask(row.standEdges[state], `standEdges[${state}]`);
                const flags = row.squareFlags === undefined
                    ? 0
                    : requireInteger(row.squareFlags[state], `squareFlags[${state}]`, 0, 46);

                if ((flags & ~46) !== 0) {
                    throw new RangeError(`squareFlags[${state}] must contain only solid2/solidtrans4/tree8/solidfloor32.`);
                }

                const group = edges | ((flags & 6) << 2) | ((flags & 8) << 3) | (flags & 32);

                spriteFacts |= group << (state * 7);
            }

            return [index + 1, x, y, z, doorFlags(row, doorBooleanNames),
                requireInteger(row.keyId ?? -1, 'keyId', -1, 0x7F_FF_FF_FF),
                requireInteger(row.roomId, 'roomId', -1, Number.MAX_SAFE_INTEGER),
                requireInteger(row.oppositeRoomId, 'oppositeRoomId', -1, Number.MAX_SAFE_INTEGER),
                doorMask(row.independentWalls, 'independentWalls'), doubleDoor, garageDoor, spriteFacts];
        });
        const squareIds = new Set();
        const squareReachRows = [];
        const squareFloorRows = [];
        const squareRows = squares.map((row) => {
            requireMoodleObject(row, 'Door square');
            const x = requireInteger(row.x, 'square x', -25_600, 25_855);
            const y = requireInteger(row.y, 'square y', -25_600, 25_855);
            const z = requireInteger(row.z, 'square z', -32, 31);
            const id = `${x}:${y}:${z}`;

            if (squareIds.has(id)) {
                throw new TypeError(`Duplicate source square ${id}.`);
            }

            squareIds.add(id);
            squareReachRows.push(row.reachWalls === undefined ? null : reachMask(row.reachWalls, 'square reachWalls'));
            const floorKeys = ['floorFlags', 'stairTypes', 'slopeDirection', 'slopeMin', 'slopeMax'];

            if (floorKeys.some((key) => Object.hasOwn(row, key))) {
                const min = requireCoordinate(row.slopeMin, 'slope minimum');
                const max = requireCoordinate(row.slopeMax, 'slope maximum');

                if (min < 0 || min > 1 || max < 0 || max > 1) {
                    throw new RangeError('Slope heights must be within [0,1].');
                }

                squareFloorRows.push([x, y, z, requireInteger(row.floorFlags, 'floor flags', 0, 31),
                    requireInteger(row.stairTypes, 'stair types', 0, 63), requireInteger(row.slopeDirection, 'slope direction', 0, 9),
                    min, max]);
            } else {
                squareFloorRows.push(null);
            }

            return [x, y, z, requireInteger(row.roomId, 'square roomId', -1, Number.MAX_SAFE_INTEGER),
                doorFlags(row, squareBooleanNames), doorMask(row.independentWalls, 'square independentWalls'),
                doorMask(row.windows ?? 0, 'square windows'), doorMask(row.doorWalls ?? 0, 'square doorWalls'),
                doorMask(row.hoppableEdges === undefined ? 0 : row.hoppableEdges, 'square hoppableEdges'),
                doorMask(row.windowEdges === undefined ? row.windows ?? 0 : row.windowEdges, 'square windowEdges'),
                row.interactionProperties === undefined ? 0 : interactionMask(row.interactionProperties, 'square interactionProperties')];
        });

        if (reachRows.some((row) => row !== null) || squareReachRows.some((row) => row !== null)) {
            requireOptional('importDoors reachWalls', ['door_import_reach_properties', 'door_square_reach_stage']);
        }

        if (curtainRows.some((mask) => mask !== null)) {
            requireOptional('importDoors curtainCapabilities', ['door_import_curtain_eligibility']);
        }

        if (squareFloorRows.some((row) => row !== null)) {
            requireOptional('importDoors floor metadata', ['door_square_floor_stage']);
        }

        scratch('importDoors');
        requireAccepted(api.door_import_begin(seed, lockedHouses, Number(initializeLocks)), 'importDoors');
        try {
            for (const [index, row] of numeric.entries()) {
                doorWords(row, 'importDoors');
                requireAccepted(api.door_import_stage(), 'importDoors row');
                requireAccepted(api.door_import_interaction_properties(row[0], ...interactionRows[index]),
                    'importDoors interactionProperties');

                if (reachRows[index] !== null) {
                    requireAccepted(api.door_import_reach_properties(row[0], ...reachRows[index]), 'importDoors door reachWalls');
                }

                if (curtainRows[index] !== null) {
                    requireAccepted(api.door_import_curtain_eligibility(row[0], curtainRows[index]), 'importDoors curtainCapabilities');
                }
            }

            for (const [index, row] of squareRows.entries()) {
                doorWords(row, 'importDoors');
                requireAccepted(api.door_square_stage(), 'importDoors square');

                if (squareReachRows[index] !== null) {
                    requireAccepted(api.door_square_reach_stage(row[0], row[1], row[2], squareReachRows[index]), 'importDoors square reachWalls');
                }

                if (squareFloorRows[index] !== null) {
                    requireAccepted(api.door_square_floor_stage(...squareFloorRows[index]), 'importDoors floor metadata');
                }
            }

            requireAccepted(api.door_import_commit(), 'importDoors commit');
            doorIds = ids;
            doorOrdinals = ordinals;
        } finally {
            api.door_import_abort();
        }
    }

    /**
     * Reads source square fields and the native current-object stand predicate.
     *
     * @param {number} x - Signed int32 tile x.
     * @param {number} y - Signed int32 tile y.
     * @param {number} z - Signed int32 query elevation.
     * @returns {EngineSquare|null} Detached record, or null for genuinely absent metadata.
     */
    function getSquare(x, y, z) {
        requireOptional('getSquare', ['square_read']);
        requireInteger(x, 'square x', -0x80_00_00_00, 0x7F_FF_FF_FF);
        requireInteger(y, 'square y', -0x80_00_00_00, 0x7F_FF_FF_FF);
        requireInteger(z, 'square z', -0x80_00_00_00, 0x7F_FF_FF_FF);
        scratch('getSquare');
        const code = api.square_read(x, y, z);

        if (code === -2) {
            return null;
        }

        requireAccepted(code, 'getSquare');
        const view = scratch('getSquare');
        const flags = view.getFloat64(32, true);
        const row = {
            x: view.getFloat64(0, true), y: view.getFloat64(8, true), z: view.getFloat64(16, true),
            roomId: view.getFloat64(24, true), canStand: view.getFloat64(40, true) !== 0,
        };

        for (const [bit, name] of squareBooleanNames.entries()) {
            row[name] = (flags & (1 << bit)) !== 0;
        }

        return row;
    }

    /**
     * Reads source isBlockedTo without deriving geometry from basic snapshots.
     *
     * @param {import('../types/mod-api').ModWorldCoordinates} from - Calling source square.
     * @param {import('../types/mod-api').ModWorldCoordinates|null} to - Other square or source null.
     * @returns {boolean} Native directional wall/window/door/stair relation.
     */
    function isBlockedTo(from, to) {
        requireOptional('isBlockedTo', ['square_blocked_to']);

        const source = squareCoordinates(from, 'isBlockedTo from');
        const target = to === null ? [0, 0, 0] : squareCoordinates(to, 'isBlockedTo to');
        const code = api.square_blocked_to(...source, ...target, Number(to !== null));

        if (code !== 0 && code !== 1) {
            requireAccepted(code, 'isBlockedTo');
        }

        return code === 1;
    }

    /**
     * Reads native invalidation state without allocating detached door rows.
     *
     * @returns {number} Global native door revision.
     */
    function doorRevision() {
        requireOptional('doorRevision', ['door_header_read']);
        api.door_header_read();

        return scratch('doorRevision').getFloat64(0, true);
    }

    /**
     * Reads detached native positions, locks, successful-toggle art history and source policy flags.
     *
     * @returns {object[]} Doors with stable public string identities.
     */
    function doors() {
        requireOptional('doors', ['door_count', 'door_read', 'door_header_read']);
        const revision = doorRevision();
        const rows = [];

        for (let index = 0; index < api.door_count(); index += 1) {
            requireAccepted(api.door_read(index), 'doors');
            const view = scratch('doors');
            const ordinal = view.getFloat64(0, true);
            const id = doorIds[ordinal];

            if (!id) {
                throw new Error('Native door identity has no registered source placement.');
            }

            const flags = view.getFloat64(32, true);
            const row = {
                id, revision, x: view.getFloat64(8, true), y: view.getFloat64(16, true),
                z: view.getFloat64(24, true), keyId: view.getFloat64(40, true),
                roomId: view.getFloat64(48, true), oppositeRoomId: view.getFloat64(56, true),
                independentWalls: view.getFloat64(64, true), doubleDoor: view.getFloat64(72, true),
                garageDoor: view.getFloat64(80, true),
            };

            for (const [bit, name] of doorBooleanNames.entries()) {
                row[name] = (flags & (1 << bit)) !== 0;
            }

            row.toggled = (flags & 4_096) !== 0;

            rows.push(row);
        }

        return rows;
    }

    /**
     * Requests an authoritative source-adjacent queued door interaction.
     *
     * @param {string} id - Exact stable public placement.
     * @returns {import('../types/mod-api').ModQueueAcceptance} Queued admission; refusal changes nothing.
     */
    function toggleDoor(id) {
        requireOptional('toggleDoor', ['queue_request_door', 'queue_capability']);
        requireName(id, 'door id');
        const ordinal = doorOrdinals.get(id);

        if (ordinal === undefined) {
            throw new RangeError(`Unknown door identity: ${id}.`);
        }

        return acceptance(queueCall('requestDoor', 'queue_request_door', ordinal));
    }

    /**
     * Saves numeric door state without changing actor12/format2/ABI1.
     *
     * @returns {object} Detached version1 locks, positions, required toggled history and port RNG state.
     */
    function saveDoorState() {
        requireOptional('saveDoorState', ['door_header_read']);
        api.door_header_read();
        const view = scratch('saveDoorState');
        const state = {
            version: 1, revision: view.getFloat64(0, true),
            seed: view.getFloat64(8, true),
            rngState: [view.getFloat64(16, true), view.getFloat64(24, true)],
            lockedHouses: view.getFloat64(32, true),
        };

        return {
            ...state, doors: doors().map(({ id, open, locked, lockedByKey, keyId, x, y, z, toggled }) =>
                ({ id, open, locked, lockedByKey, keyId, x, y, z, toggled })),
        };
    }

    /**
     * Restores every identity atomically after source geometry has been ingested.
     * No constructor/RNG runs and missing identities are never substituted.
     *
     * @param {object} state - Exact detached native door save.
     */
    function loadDoorState(state) {
        requireOptional('loadDoorState', ['door_restore_begin', 'door_restore_stage',
            'door_restore_commit', 'door_restore_abort']);
        requireMoodleObject(state, 'Door state');
        const keys = ['version', 'revision', 'seed', 'rngState', 'lockedHouses', 'doors'];

        if (state.version !== 1 || Object.keys(state).length !== keys.length
            || keys.some((key) => !Object.hasOwn(state, key))
            || !Array.isArray(state.rngState) || state.rngState.length !== 2
            || !Array.isArray(state.doors) || state.doors.length !== doorOrdinals.size) {
            throw new TypeError('Door state requires exact version1 shape and every registered identity.');
        }

        const revision = requireInteger(state.revision, 'door revision', 0, 0xFF_FF_FF_FF);
        const seed = requireInteger(state.seed, 'door seed', 1, 0xFF_FF_FF_FF);
        const lo = requireInteger(state.rngState[0], 'door RNG low', 0, 0xFF_FF_FF_FF);
        const hi = requireInteger(state.rngState[1], 'door RNG high', 0, 0xFF_FF_FF_FF);
        const houses = requireInteger(state.lockedHouses, 'lockedHouses', 1, 6);
        const seen = new Set();
        const rows = state.doors.map((row) => {
            requireMoodleObject(row, 'Saved door');
            const id = requireName(row.id, 'saved door id');
            const ordinal = doorOrdinals.get(id);

            if (ordinal === undefined || seen.has(id)) {
                throw new TypeError('Saved door identities must match the entire imported set exactly.');
            }

            seen.add(id);
            const flags = doorFlags(row, ['open', 'locked', 'lockedByKey', 'toggled']);

            return [ordinal, flags & 1, (flags >> 1) & 1, (flags >> 2) & 1,
                requireInteger(row.keyId, 'saved keyId', -1, 0x7F_FF_FF_FF),
                requireInteger(row.x, 'saved door x', -25_600, 25_855),
                requireInteger(row.y, 'saved door y', -25_600, 25_855),
                requireInteger(row.z, 'saved door z', -32, 31), (flags >> 3) & 1];
        });

        scratch('loadDoorState');
        requireAccepted(api.door_restore_begin(revision, seed, lo, hi, houses), 'loadDoorState');
        try {
            for (const row of rows) {
                doorWords(row, 'loadDoorState');
                requireAccepted(api.door_restore_stage(), 'loadDoorState row');
            }

            requireAccepted(api.door_restore_commit(), 'loadDoorState commit');
        } finally {
            api.door_restore_abort();
        }
    }

    // Identity/source metadata only. Numeric behavior is always read from WASM.
    const definitionMetadata = [];
    const definitionOrdinals = new Map();
    const ownerIds = new Map();
    const ownerNames = [null];
    const policyIds = new Map();
    const policyNames = [null];

    for (const name of ['inventory', 'floor', 'container']) {
        intern(name, policyIds, policyNames);
    }

    /**
     * Resolve a portable source policy name to a runtime-only native token.
     *
     * @param {string|null|undefined} value - Source policy spelling, or no policy.
     * @param {string} label - Validation context for the policy name.
     * @param {boolean} [fold=false] - Lowercase the spelling before interning.
     * @returns {number} Native token; zero represents no policy.
     */
    function policyToken(value, label, fold = false) {
        if (value === null || value === undefined) {
            return 0;
        }

        requireName(value, label);

        return intern(fold ? value.toLowerCase() : value, policyIds, policyNames);
    }

    /**
     * Resolve a runtime token to its source policy name without defaulting missing metadata.
     *
     * @param {number} token - Native policy token, with zero representing absence.
     * @returns {string|null} Policy spelling or null for token zero.
     */
    function policyName(token) {
        if (token === 0) {
            return null;
        }

        if (!policyNames[token]) {
            throw new Error('Native container policy metadata is unavailable.');
        }

        return policyNames[token];
    }

    let definitionTransaction = null;

    const equipmentExports = Object.freeze({
        count: 'body_location_count', read: 'body_location_read',
        groupCount: 'body_group_count', groupAt: 'body_group_at', groupName: 'body_group_name',
        groupTotalCount: 'body_group_total_count', groupActive: 'body_group_active', groupDetach: 'body_group_detach',
        locationCount: 'body_group_location_count', locationAt: 'body_group_location_at',
        locationIndex: 'body_group_location_index', locationAdd: 'body_group_location_add',
        multiSet: 'body_group_multi_set', multiGet: 'body_group_multi_get',
        relationSet: 'body_group_relation_set', relationGet: 'body_group_relation_get',
        relationCount: 'body_group_relation_count', relationAt: 'body_group_relation_at',
        move: 'body_group_move', reset: 'body_locations_reset',
        wornGroupGet: 'worn_group_get', wornGroupSet: 'worn_group_set',
        wornCount: 'worn_count', wornRead: 'worn_read', wornGet: 'worn_item_get',
        wornSet: 'worn_item_set', wornRemove: 'worn_remove', wornClear: 'worn_clear',
    });
    const equipmentStatusOperations = new Set([
        'groupDetach', 'locationAdd', 'multiSet', 'relationSet', 'move', 'reset',
        'wornGroupSet', 'wornRead', 'wornSet', 'wornRemove', 'wornClear',
    ]);
    const equipmentEncoder = new TextEncoder();
    const equipmentDecoder = new TextDecoder('utf-8', { fatal: true });

    /**
     * Native identity/rule bridge; tokens never leave portable persistence.
     *
     * @param {string} op - Exact native operation name.
     * @param {...(string|number|boolean|null)} args - Operation-specific scalar arguments.
     * @returns {string|number|boolean|object|null} Detached native result.
     */
    function equipmentOperation(op, ...args) {
        if (op === 'at') {
            if (args.length !== 1) {
                throw new TypeError('at requires one argument.');
            }

            return requireInteger(args[0], 'body location index', 0, equipmentOperation('count') - 1) + 1;
        }

        let name = equipmentExports[op];

        if (['lookup', 'register', 'canonical', 'groupGet'].includes(op)) {
            if (args.length < 1 || args.length > (op === 'groupGet' ? 2 : 1)) {
                throw new TypeError(`${op} requires ${op === 'groupGet' ? 'one or two' : 'one'} arguments.`);
            }

            name = op === 'groupGet' ? 'body_group_get' : `body_location_${op}`;
            requireOptional(op, [name]);
            const bytes = equipmentEncoder.encode(requireName(args[0], op));
            const view = scratch(op);

            if (bytes.length > view.byteLength) {
                throw new RangeError(`${op} exceeds the native 96-byte text capacity.`);
            }

            new Uint8Array(view.buffer, view.byteOffset, view.byteLength).set(bytes);

            if (op === 'groupGet' && args[1] !== undefined && typeof args[1] !== 'boolean') {
                throw new TypeError('groupGet create must be boolean.');
            }

            const result = api[name](bytes.length, Number(args[1] ?? false));

            requireResult(result, op, 0, op === 'canonical' ? 96 : 0xFF_FF_FF_FF);

            if (op === 'canonical') {
                const output = scratch(op);

                requireInteger(result, 'canonical byte count', 0, output.byteLength);

                return equipmentDecoder.decode(new Uint8Array(output.buffer, output.byteOffset, result));
            }

            return result || null;
        }

        if (op === 'initialized') {
            name = args.length ? 'body_registry_set_initialized' : 'body_registry_initialized';
        }

        if (!name) {
            throw new TypeError(`Unknown equipment operation: ${op}.`);
        }

        requireOptional(op, [name]);

        if (args.length !== api[name].length) {
            throw new TypeError(`${op} requires ${api[name].length} arguments.`);
        }

        const numeric = args.map((arg, index) => {
            if (['multiSet', 'initialized'].includes(op) && index === args.length - 1) {
                if (typeof arg !== 'boolean') {
                    throw new TypeError(`${op} enabled must be boolean.`);
                }

                return Number(arg);
            }

            if (op === 'wornSet' && index === 1 && arg === null) {
                return 0;
            }

            return requireInteger(arg, `${op} argument ${index}`,
                op === 'move' && index === 2 ? -2_147_483_648 : 0, 0xFF_FF_FF_FF);
        });
        const result = api[name](...numeric);

        if (op === 'locationIndex' && result === -1) {
            return -1;
        }

        if (equipmentStatusOperations.has(op) || (op === 'initialized' && args.length)) {
            requireAccepted(result, op);
        } else {
            requireResult(result, op, 0, 0xFF_FF_FF_FF);
        }

        if (op === 'read' || op === 'groupName') {
            const view = scratch(op);

            requireInteger(result, `${op} byte count`, 0, view.byteLength);

            return equipmentDecoder.decode(new Uint8Array(view.buffer, view.byteOffset, result));
        }

        if (op === 'wornRead') {
            const view = scratch(op);

            return { id: view.getFloat64(0, true), location: view.getFloat64(8, true) };
        }

        if (['multiGet', 'relationGet', 'groupActive', 'initialized'].includes(op)) {
            return args.length && op === 'initialized' ? args[0] : result !== 0;
        }

        if (['groupAt', 'locationAt', 'relationAt', 'wornGet'].includes(op)) {
            return result || null;
        }

        return result;
    }

    /**
     * Resolve an existing canonical identity without creating it.
     *
     * @param {string} name - Original or canonical location spelling.
     * @returns {number} Authoritative native token.
     */
    function requireBodyLocation(name) {
        const token = equipmentOperation('lookup', name);

        if (token === null) {
            throw new RangeError(`Unknown bodyLocation: ${name}.`);
        }

        return token;
    }

    /**
     * Decode a native identity into its portable canonical spelling.
     *
     * @param {number} token - Native identity or zero for no location.
     * @returns {string|null} Canonical location or absence.
     */
    function bodyLocationName(token) {
        return token === 0 ? null : equipmentOperation('read', token, 0);
    }

    /**
     * Ordered equipment traversal independent of inventory insertion order.
     *
     * @returns {import('../types/mod-api').ModWornItem[]} Detached ordered records.
     */
    function wornItems() {
        return Array.from({ length: equipmentOperation('wornCount') }, (_, index) => {
            const { id, location } = equipmentOperation('wornRead', index);

            return { id, bodyLocation: bodyLocationName(location) };
        });
    }

    /**
     * Set an explicit original worn location.
     *
     * @param {string} bodyLocation - Original or canonical location spelling.
     * @param {number|null} id - Stable inventory identity, or clear.
     */
    function setWornItem(bodyLocation, id) {
        equipmentOperation('wornSet', requireBodyLocation(bodyLocation), id);
    }

    /**
     * Probe actual native portable registry and worn support.
     *
     * @returns {boolean} Whether the complete native equipment ABI is present.
     */
    function canSaveEquipmentState() {
        if (typeof api.body_location_lookup !== 'function') {
            return false;
        }

        requireOptional('equipment save', [...Object.values(equipmentExports),
            'body_registry_initialized', 'body_location_register', 'body_group_get']);

        return true;
    }

    /**
     * Canonical names plus snapshot-local group indices, never native tokens.
     *
     * @returns {import('../types/mod-api').ModEquipmentState} Detached portable state.
     */
    function saveEquipmentState() {
        if (!canSaveEquipmentState()) {
            throw new Error('saveEquipmentState is unsupported by this engine module.');
        }

        const locations = Array.from({ length: equipmentOperation('count') }, (_, index) => ({
            id: bodyLocationName(index + 1), translationName: equipmentOperation('read', index + 1, 1),
        }));
        const groups = Array.from({ length: equipmentOperation('groupTotalCount') }, (_, index) => {
            const group = index + 1;

            return {
                name: equipmentOperation('groupName', group),
                active: equipmentOperation('groupActive', group),
                locations: Array.from({ length: equipmentOperation('locationCount', group) }, (_, ordinal) => {
                    const token = equipmentOperation('locationAt', group, ordinal);
                    /**
                     * Capture one ordered native relation list.
                     *
                     * @param {number} kind - Exclusive, hide or alternate relation kind.
                     * @returns {string[]} Portable canonical target identities.
                     */
                    const relations = (kind) => Array.from({
                        length: equipmentOperation('relationCount', group, token, kind),
                    }, (_, at) => bodyLocationName(equipmentOperation('relationAt', group, token, kind, at)));

                    return {
                        id: bodyLocationName(token), multiItem: equipmentOperation('multiGet', group, token),
                        exclusive: relations(0), hide: relations(1), alternate: relations(2),
                    };
                }),
            };
        });

        return {
            version: 1, initialized: equipmentOperation('initialized'), locations, groups,
            wornGroup: equipmentOperation('wornGroupGet') - 1, wornOrder: wornItems().map(({ id }) => id),
        };
    }

    /**
     * Restore on the fresh staged engine before definitions and atomic item import.
     *
     * @param {import('../types/mod-api').ModEquipmentState} state - Complete portable state.
     */
    function loadEquipmentState(state) {
        requireMoodleObject(state, 'Equipment state');

        if (state.version !== 1 || typeof state.initialized !== 'boolean'
            || !Array.isArray(state.locations) || state.locations.length > 4_096
            || !Array.isArray(state.groups) || !state.groups.length || state.groups.length > 4_096
            || !Array.isArray(state.wornOrder) || state.wornOrder.length > 4_096
            || state.groups[0]?.name !== 'Human') {
            throw new TypeError('Invalid equipment state.');
        }

        requireInteger(state.wornGroup, 'saved worn group', 0, state.groups.length - 1);
        const ids = new Set();

        for (const location of state.locations) {
            requireMoodleObject(location, 'Equipment location');
            requireName(location.id, 'equipment canonical ID');
            requireName(location.translationName, 'equipment translation name');

            if (ids.has(location.id)) {
                throw new TypeError('Duplicate equipment identity.');
            }

            ids.add(location.id);
        }

        const activeNames = new Set();

        for (const group of state.groups) {
            requireMoodleObject(group, 'Equipment group');
            requireName(group.name, 'equipment group name');

            if (typeof group.active !== 'boolean' || !Array.isArray(group.locations)
                || group.locations.length > 4_096 || (group.active && activeNames.has(group.name))) {
                throw new TypeError('Invalid equipment group.');
            }

            if (group.active) {
                activeNames.add(group.name);
            }

            const members = new Set();

            for (const member of group.locations) {
                if (!member || !ids.has(member.id) || members.has(member.id) || typeof member.multiItem !== 'boolean'
                    || ['exclusive', 'hide', 'alternate'].some((key) => !Array.isArray(member[key])
                        || member[key].length > 4_096 || new Set(member[key]).size !== member[key].length
                        || member[key].some((id) => !ids.has(id)))) {
                    throw new TypeError('Invalid equipment group member.');
                }

                members.add(member.id);
            }
        }

        const worn = new Set();

        for (const id of state.wornOrder) {
            requireInteger(id, 'saved worn ID', 1, 0xFF_FF_FF_FF);

            if (worn.has(id)) {
                throw new TypeError('Duplicate saved worn ID.');
            }

            worn.add(id);
        }

        if (definitionMetadata.length || equipmentOperation('wornCount') || items().length
            || equipmentOperation('groupTotalCount') !== 1 || equipmentOperation('locationCount', 1)) {
            throw new Error('Equipment restore requires a fresh staged engine.');
        }

        for (const location of state.locations) {
            const token = equipmentOperation('lookup', location.id)
                ?? equipmentOperation('register', location.translationName);

            if (bodyLocationName(token) !== location.id
                || equipmentOperation('read', token, 1) !== location.translationName) {
                throw new TypeError('Equipment identity does not match its canonical translation.');
            }
        }

        if (equipmentOperation('count') !== state.locations.length) {
            throw new TypeError('Equipment snapshot omits native identities.');
        }

        const groups = state.groups.map((group, index) => {
            const token = index === 0 ? 1 : equipmentOperation('groupGet', group.name, true);

            if (token !== index + 1) {
                throw new TypeError('Equipment snapshot group order conflicts with active group identity.');
            }

            for (const member of group.locations) {
                equipmentOperation('locationAdd', token, requireBodyLocation(member.id));
            }

            for (const member of group.locations) {
                const from = requireBodyLocation(member.id);

                equipmentOperation('multiSet', token, from, member.multiItem);

                for (const [kind, key] of [[3, 'exclusive'], [1, 'hide'], [2, 'alternate']]) {
                    for (const id of member[key]) {
                        equipmentOperation('relationSet', token, from, requireBodyLocation(id), kind);
                    }
                }
            }

            if (!group.active) {
                equipmentOperation('groupDetach', token);
            }

            return token;
        });

        equipmentOperation('wornGroupSet', groups[state.wornGroup]);
        equipmentOperation('initialized', state.initialized);
    }

    /**
     * Resolves a public definition identity to its private dense ordinal.
     *
     * @param {string} fullType - Exact qualified identity.
     * @returns {number} Definition ordinal.
     */
    function definitionOrdinal(fullType) {
        requireName(fullType, 'fullType');
        const ordinal = definitionOrdinals.get(fullType);

        if (ordinal === undefined) {
            throw new RangeError(`Unknown item definition: ${fullType}.`);
        }

        return ordinal;
    }

    /**
     * Combines detached source metadata with authoritative numeric fields.
     *
     * @param {number} ordinal - Private definition ordinal.
     * @returns {object} Detached resolved definition.
     */
    function resolvedDefinition(ordinal) {
        requireOptional('itemDefinitions', ['item_definition_read']);
        requireAccepted(api.item_definition_read(ordinal), 'itemDefinitions');
        const view = scratch('itemDefinitions');
        const values = Array.from({ length: 9 }, (_, index) => view.getFloat64(index * 8, true));
        const metadata = definitionMetadata[ordinal];

        if (!metadata) {
            throw new Error('Item definition metadata is unavailable.');
        }

        requireOptional('itemDefinitions', ['item_definition_container_read']);
        requireAccepted(api.item_definition_container_read(ordinal), 'itemDefinitions container');
        const bagView = scratch('itemDefinitions container');
        const bag = Array.from({ length: 9 }, (_, index) => bagView.getFloat64(index * 8, true));

        return {
            ...structuredClone(metadata),
            owner: ownerNames[values[0]],
            conditionMax: values[1],
            bodyLocation: bodyLocationName(values[2]),
            stackLimit: values[3],
            removeOnBroken: values[4] !== 0,
            conditionLowerChanceOneIn: values[5],
            weight: values[6],
            canBeEquipped: bodyLocationName(values[8]),
            isBag: bag[0] !== 0, capacity: bag[1], weightReduction: bag[2], maxItemSize: bag[3],
            containerType: policyName(bag[4]), category: policyName(bag[5]),
            onlyAcceptCategory: policyName(bag[6]), acceptItemFunction: policyName(bag[7]),
            lightWhenAttached: (bag[8] & 1) !== 0, fakeEquipped: (bag[8] & 2) !== 0,
            unsupportedSubtype: (bag[8] & 4) !== 0,
        };
    }

    /**
     * Registers or explicitly overrides a validated numeric definition.
     *
     * @param {object} definition - Numeric fields and original appearance/source metadata.
     * @param {object} options - Owning package and collision policy.
     * @param {string} options.owner - Exact package identity.
     * @param {boolean} [options.override=false] - Explicit permission to replace an existing identity.
     * @returns {object} Detached resolved definition read back from WASM.
     */
    function registerItemDefinition(definition, { owner, override = false } = {}) {
        requireOptional('registerItemDefinition', ['item_definition_register', 'item_definition_read', 'inventory_state_read',
            'item_definition_equip_set', 'item_definition_container_set', 'item_definition_container_read']);
        scratch('registerItemDefinition');

        if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
            throw new TypeError('Item definition must be an object.');
        }

        requireName(owner, 'definition owner');
        requireName(definition.fullType, 'fullType');

        if (typeof override !== 'boolean' || typeof definition.removeOnBroken !== 'boolean') {
            throw new TypeError('override and removeOnBroken must be booleans.');
        }

        const bodyLocation = definition.bodyLocation;

        if (bodyLocation !== null) {
            requireName(bodyLocation, 'bodyLocation');
        }

        const canBeEquipped = definition.canBeEquipped ?? null;
        const slot = bodyLocation === null ? 0 : requireBodyLocation(bodyLocation);
        const equipSlot = canBeEquipped === null ? 0 : requireBodyLocation(canBeEquipped);

        const conditionMax = requireInteger(definition.conditionMax, 'conditionMax', 1, 0x7F_FF_FF_FF);
        const stackLimit = requireInteger(definition.stackLimit, 'stackLimit', 1, 0xFF_FF_FF_FF);
        const chance = requireInteger(definition.conditionLowerChanceOneIn,
            'conditionLowerChanceOneIn', 0, 0xFF_FF_FF_FF);
        const weight = requireItemWeight(Object.hasOwn(definition, 'weight') ? definition.weight : 1, 'weight');
        const previous = definitionOrdinals.get(definition.fullType);
        const ordinal = previous ?? definitionMetadata.length;
        // Clone before dispatch: an uncloneable source field cannot strand a numeric row.
        const metadata = structuredClone(definition);
        const tags = Object.hasOwn(metadata, 'tags') ? metadata.tags : [];

        if (!Array.isArray(tags)) {
            throw new TypeError('Item definition tags must be an array of strings.');
        }

        metadata.tags = Array.from(tags, itemTagResourceLocation);
        const itemType = definition.type?.toLowerCase().replace(/^base:/u, '') ?? 'normal';
        const isBag = definition.isBag ?? itemType === 'container';

        if (typeof isBag !== 'boolean') {
            throw new TypeError('isBag must be a boolean.');
        }

        const capacity = requireInteger(definition.capacity ?? 0, 'capacity', -0x80_00_00_00, 0x7F_FF_FF_FF);
        const reduction = requireInteger(definition.weightReduction ?? 0, 'weightReduction', -0x80_00_00_00, 0x7F_FF_FF_FF);
        const maxItemSize = requireCoordinate(definition.maxItemSize ?? 0, 'maxItemSize');

        if (Math.abs(maxItemSize) > 3.402_823_466_385_288_6e38) {
            throw new RangeError('maxItemSize must fit finite f32.');
        }

        const typeToken = policyToken(definition.containerType ?? (isBag ? definition.fullType.slice(definition.fullType.lastIndexOf('.') + 1) : null), 'containerType');
        let sourceCategory = definition.sourceCategory ?? definition.category;

        if (sourceCategory === null || sourceCategory === undefined) {
            if (isBag) {
                sourceCategory = 'Container';
            } else if (itemType === 'clothing') {
                sourceCategory = 'Clothing';
            } else {
                sourceCategory = 'Item';
            }
        }

        requireName(sourceCategory, 'sourceCategory');
        metadata.sourceCategory = sourceCategory;
        const categoryToken = policyToken(sourceCategory, 'category', true);
        const onlyCategory = policyToken(definition.onlyAcceptCategory, 'onlyAcceptCategory', true);
        const acceptFunction = policyToken(definition.acceptItemFunction, 'acceptItemFunction');
        const declaredUnsupported = definition.unsupportedSubtype ?? false;

        if (typeof declaredUnsupported !== 'boolean') {
            throw new TypeError('unsupportedSubtype must be boolean.');
        }

        /**
         * Detect unsupported ammo, fluid, or component fields recursively.
         *
         * @param {object[]|undefined} fields - Parsed source fields and nested children.
         * @returns {boolean} Whether any field requires an unsupported subtype facility.
         */
        const unsupportedFields = (fields) => Array.isArray(fields) && fields.some((field) => field && (
            /^(?:ammo|fluid|component)/iu.test(field.name ?? '')
            || (/^(?:ammo|fluid)/iu.test(field.value ?? '') && Array.isArray(field.children))
            || unsupportedFields(field.children)));
        const flags = doorFlags({
            lightWhenAttached: definition.lightWhenAttached ?? metadata.tags.includes('base:lightwhenattached'),
            fakeEquipped: definition.fakeEquipped ?? (isBag && metadata.tags.includes('base:keyring')),
            unsupportedSubtype: declaredUnsupported || !['normal', 'item', 'clothing', 'container'].includes(itemType)
                || Boolean(definition.ammoType) || unsupportedFields(metadata.rawFields)
                || ['CandleLit', 'Lantern_HurricaneLit'].includes(definition.fullType.slice(definition.fullType.lastIndexOf('.') + 1)),
        }, ['lightWhenAttached', 'fakeEquipped', 'unsupportedSubtype']);

        for (const key of ['owner', 'conditionMax', 'stackLimit', 'removeOnBroken', 'conditionLowerChanceOneIn', 'weight']) {
            delete metadata[key];
        }

        const ownerId = intern(owner, ownerIds, ownerNames);

        requireAccepted(api.item_definition_register(ordinal, ownerId, conditionMax, slot,
            stackLimit, Number(definition.removeOnBroken), chance, Number(override), weight,
            Number(metadata.tags.includes('base:awkwardgloves'))), 'registerItemDefinition');
        requireOptional('registerItemDefinition CanBeEquipped', ['item_definition_equip_set']);
        requireAccepted(api.item_definition_equip_set(ordinal, ownerId, equipSlot), 'registerItemDefinition CanBeEquipped');
        requireAccepted(api.item_definition_container_set(ordinal, ownerId, Number(isBag), capacity, reduction,
            maxItemSize, typeToken, categoryToken, onlyCategory, acceptFunction, flags), 'registerItemDefinition container');

        if (definitionTransaction && ordinal < definitionTransaction.start
            && !definitionTransaction.journal.has(ordinal)) {
            definitionTransaction.journal.set(ordinal, definitionMetadata[ordinal]);
        }

        definitionMetadata[ordinal] = metadata;
        definitionOrdinals.set(metadata.fullType, ordinal);

        return resolvedDefinition(ordinal);
    }

    /**
     * Reads definitions in registration order for ordinal-safe save restore.
     *
     * @returns {object[]} Detached metadata and authoritative numeric rows.
     */
    function itemDefinitions() {
        requireOptional('itemDefinitions', ['item_definition_count', 'item_definition_read']);

        return Array.from({ length: api.item_definition_count() >>> 0 },
            (_, ordinal) => resolvedDefinition(ordinal));
    }

    /**
     * Begins one activation with first-touch journals, not table clones.
     *
     * @param {string} owner - Exact package identity.
     */
    function beginItemDefinitionRegistration(owner) {
        requireOptional('beginItemDefinitionRegistration', ['item_definition_begin']);
        requireName(owner, 'definition owner');
        requireAccepted(api.item_definition_begin(intern(owner, ownerIds, ownerNames)),
            'beginItemDefinitionRegistration transaction');
        definitionTransaction = { owner, start: definitionMetadata.length, journal: new Map() };
    }

    /**
     * Commits the matching activation without changing ordinal order.
     *
     * @param {string} owner - Exact package identity.
     */
    function commitItemDefinitionRegistration(owner) {
        requireOptional('commitItemDefinitionRegistration', ['item_definition_commit']);
        requireName(owner, 'definition owner');
        requireAccepted(api.item_definition_commit(ownerIds.get(owner) ?? 0), 'commitItemDefinitionRegistration');
        definitionTransaction = null;
    }

    /**
     * Restores overridden numeric rows/owners and truncates appended metadata.
     *
     * @param {string} owner - Exact package identity.
     */
    function rollbackItemDefinitionRegistration(owner) {
        requireOptional('rollbackItemDefinitionRegistration', ['item_definition_rollback']);
        requireName(owner, 'definition owner');
        requireAccepted(api.item_definition_rollback(ownerIds.get(owner) ?? 0), 'rollbackItemDefinitionRegistration');

        for (let ordinal = definitionTransaction.start; ordinal < definitionMetadata.length; ordinal += 1) {
            definitionOrdinals.delete(definitionMetadata[ordinal].fullType);
        }

        definitionMetadata.length = definitionTransaction.start;

        for (const [ordinal, metadata] of definitionTransaction.journal) {
            definitionMetadata[ordinal] = metadata;
        }

        definitionTransaction = null;
    }

    /** Seals registration after activation; intentionally internal-host only. */
    function freezeItemDefinitions() {
        requireOptional('freezeItemDefinitions', ['item_definition_freeze']);
        requireAccepted(api.item_definition_freeze(), 'freezeItemDefinitions');
    }

    /**
     * Reads authoritative records without retaining WASM memory views.
     *
     * @returns {object[]} Detached ground/inventory/equipment records.
     */
    function items() {
        requireOptional('items', ['item_count', 'item_read', 'inventory_state_read']);

        return Array.from({ length: api.item_count() >>> 0 }, (_, index) => {
            requireAccepted(api.item_read(index), 'items');

            return readItemRecord();
        });
    }

    /**
     * Decode the shared native item scratch immediately; never retain its memory view.
     *
     * @returns {object} Detached current item fields.
     */
    function readItemRecord() {
        const view = scratch('items');
        const values = Array.from({ length: 12 }, (_, index) => view.getFloat64(index * 8, true));
        const ordinal = values[1];

        if (!definitionMetadata[ordinal]) {
            throw new Error('Item definition metadata is unavailable.');
        }

        requireOptional('items source state', ['item_source_state_read']);
        requireAccepted(api.item_source_state_read(values[0]), 'items source state');
        const stateView = scratch('items source state');
        const favorite = stateView.getFloat64(0, true) !== 0;
        const consumed = stateView.getFloat64(8, true) !== 0;

        return {
            id: values[0], fullType: definitionMetadata[ordinal].fullType, definitionOrdinal: ordinal,
            ownerContainerId: values[2], internalContainerId: values[10] || null,
            worldPosition: values[11] ? { x: values[3], y: values[4], z: 0 } : null,
            condition: values[5], count: values[6],
            bodyLocation: bodyLocationName(values[7]), weight: values[8], actualWeight: values[9],
            favorite, consumed,
        };
    }

    /**
     * Read one stable identity without copying every native item.
     *
     * @param {number} id - Positive uint32 identity.
     * @returns {object|null} Detached live record, or absence.
     */
    function getItem(id) {
        requireInteger(id, 'item id', 1, 0xFF_FF_FF_FF);
        requireOptional('getItem', ['item_read_id']);
        const status = api.item_read_id(id);

        if (status === -2) {
            return null;
        }

        requireAccepted(status, 'getItem');

        return readItemRecord();
    }

    /**
     * Reads native inventory insertion-order f32 mass, not synthetic moodle input.
     *
     * @returns {{capacityWeight: number, capacity: number, maxWeight: number}} Detached flat-player carry state.
     */
    function inventoryState() {
        requireOptional('inventoryState', ['inventory_state_read']);
        api.inventory_state_read();
        const view = scratch('inventoryState');

        return {
            capacityWeight: view.getFloat64(0, true),
            capacity: view.getFloat64(8, true),
            maxWeight: view.getFloat64(16, true),
        };
    }

    /** @type {Set<{callback:import('../types/mod-api').ModHandItemChangedListener,onError:function(unknown):void}>} */
    const handObservers = new Set();
    /** @type {import('../types/mod-api').ModHandItemChanged[]} */
    const pendingHandEvents = [];
    let notifyingHands = false;
    // Observation snapshot only; native retains transaction/ownership and rollback authority.
    let transferHandState = null;

    /**
     * Checks actual optional held-state native support.
     *
     * @returns {boolean} Whether native held state can be saved and restored.
     */
    function canSaveHandState() {
        return ['hand_item_get', 'hand_item_set', 'hand_items_restore'].every((name) => typeof api[name] === 'function');
    }

    /**
     * Reads detached stable live inventory references.
     *
     * @returns {{primary:number|null,secondary:number|null}} Current held pair.
     */
    function getHandItems() {
        requireOptional('getHandItems', ['hand_item_get']);
        const primary = requireInteger(api.hand_item_get(0), 'native primary item ID', 0, 0xFF_FF_FF_FF);
        const secondary = requireInteger(api.hand_item_get(1), 'native secondary item ID', 0, 0xFF_FF_FF_FF);

        return { primary: primary || null, secondary: secondary || null };
    }

    /**
     * Delivers committed held transitions in order, including reentrant commits.
     *
     * @param {{primary:number|null,secondary:number|null}} before - Actual precommit refs.
     */
    function notifyHandItems(before) {
        const after = getHandItems();

        /** @type {('primary'|'secondary')[]} */
        const slots = ['primary', 'secondary'];

        for (const slot of slots) {
            if (before[slot] !== after[slot]) {
                pendingHandEvents.push({ slot, playerIndex: 0, itemId: after[slot] });
            }
        }

        if (notifyingHands) {
            return;
        }

        notifyingHands = true;
        try {
            // Append reentrant commits behind the complete already-committed pair.
            for (const event of pendingHandEvents) {
                for (const observer of [...handObservers]) {
                    if (!handObservers.has(observer)) {
                        continue;
                    }

                    try {
                        observer.callback({ ...event });
                    } catch (cause) {
                        observer.onError(cause);
                    }
                }
            }
        } finally {
            pendingHandEvents.length = 0;
            notifyingHands = false;
        }
    }

    /**
     * Registers a private synchronous committed-transition observer.
     *
     * @param {import('../types/mod-api').ModHandItemChangedListener} callback - Committed-transition observer.
     * @param {function(unknown):void} onError - Owner attribution sink; must not throw.
     * @returns {function():boolean} Withdraw the observer.
     */
    function observeHandItems(callback, onError) {
        requireOptional('observeHandItems', ['hand_item_get', 'hand_item_set']);

        if (typeof callback !== 'function' || typeof onError !== 'function') {
            throw new TypeError('observeHandItems requires a callback and owner error sink.');
        }

        const observer = { callback, onError };

        handObservers.add(observer);

        return () => handObservers.delete(observer);
    }

    /**
     * Commits one real held slot and notifies registered observers.
     *
     * @param {'primary'|'secondary'} slot - Exact held slot.
     * @param {number|null} itemId - Full uint32 stable inventory identity, or clear.
     */
    function setHandItem(slot, itemId) {
        requireOptional('setHandItem', ['hand_item_set', 'hand_item_get']);

        if (slot !== 'primary' && slot !== 'secondary') {
            throw new TypeError('Hand slot must be primary or secondary.');
        }

        const id = itemId === null ? 0 : requireInteger(itemId, 'hand item ID', 1, 0xFF_FF_FF_FF);
        const before = handObservers.size > 0 ? getHandItems() : null;

        requireAccepted(api.hand_item_set(slot === 'primary' ? 0 : 1, id), 'setHandItem');

        if (before) {
            notifyHandItems(before);
        }
    }

    /**
     * Captures mutable-only portable held state.
     *
     * @returns {{version:1,primary:number|null,secondary:number|null}} Portable held pair.
     */
    function saveHandState() {
        requireOptional('saveHandState', ['hand_item_get', 'hand_items_restore']);

        return { version: 1, ...getHandItems() };
    }

    /**
     * Restores a strict complete held pair silently and atomically.
     *
     * @param {object} state - Strict complete pair.
     */
    function loadHandState(state) {
        requireOptional('loadHandState', ['hand_items_restore']);
        requireMoodleObject(state, 'Hand state');

        if (state.version !== 1 || Object.keys(state).length !== 3
            || !['version', 'primary', 'secondary'].every((key) => Object.hasOwn(state, key))) {
            throw new TypeError('Invalid hand state shape.');
        }

        const primary = state.primary === null ? 0 : requireInteger(state.primary, 'primary hand item ID', 1, 0xFF_FF_FF_FF);
        const secondary = state.secondary === null ? 0 : requireInteger(state.secondary, 'secondary hand item ID', 1, 0xFF_FF_FF_FF);

        requireAccepted(api.hand_items_restore(primary, secondary), 'loadHandState');
    }

    /**
     * Decode the current native container row and its detached source policy names.
     *
     * @returns {import('../types/mod-api').ModContainer} Detached container record.
     */
    function readContainerRecord() {
        const view = scratch('containers');
        const row = Array.from({ length: 12 }, (_, index) => view.getFloat64(index * 8, true));

        requireAccepted(api.container_policy_read(row[0]), 'container policy');
        const policy = scratch('container policy');
        const tokens = [0, 1, 2].map((index) => policy.getFloat64(index * 8, true));

        return {
            id: row[0], kind: [null, 'actor', 'floor', 'bag'][row[1]],
            parentKind: [null, 'actor', 'square'][row[2]], parentId: row[2] ? row[3] : null,
            containingItemId: row[4] || null, capacity: row[5], weightReduction: row[6],
            worldPosition: row[1] === 2 ? { x: row[7], y: row[8], z: row[9] } : null,
            explored: (row[10] & 1) !== 0, looted: (row[10] & 2) !== 0, definitionOrdinal: row[11],
            type: policyName(tokens[0]), onlyAcceptCategory: policyName(tokens[1]),
            acceptItemFunction: policyName(tokens[2]),
        };
    }

    /**
     * Read detached containers in native allocation order.
     *
     * @returns {import('../types/mod-api').ModContainer[]} Native-ordered detached container records.
     */
    function containers() {
        requireOptional('containers', ['container_count', 'container_read', 'container_policy_read']);

        return Array.from({ length: requireResult(api.container_count(), 'container count', 1, 8_193) }, (_, index) => {
            requireAccepted(api.container_read(index), 'containers');

            return readContainerRecord();
        });
    }

    /**
     * Read a native container by stable identity.
     *
     * @param {number} id - Positive uint32 container identity.
     * @returns {import('../types/mod-api').ModContainer|null} Detached record or null when absent.
     */
    function getContainer(id) {
        requireOptional('getContainer', ['container_read_id', 'container_policy_read']);
        const status = api.container_read_id(requireInteger(id, 'container ID', 1, 0xFF_FF_FF_FF));

        if (status === -2) {
            return null;
        }

        requireAccepted(status, 'getContainer');

        return readContainerRecord();
    }

    /**
     * Read direct item membership in native remove-and-append order.
     *
     * @param {number} id - Positive uint32 container identity.
     * @returns {import('../types/mod-api').ModItem[]} Detached direct member records.
     */
    function containerItems(id) {
        requireOptional('containerItems', ['container_item_count', 'container_item_get']);
        requireInteger(id, 'container ID', 1, 0xFF_FF_FF_FF);
        const count = requireResult(api.container_item_count(id), 'containerItems', 0, 4_096);

        return Array.from({ length: count }, (_, index) => getItem(requireResult(
            api.container_item_get(id, index), 'container item ID', 1, 0xFF_FF_FF_FF)));
    }

    /**
     * Read the actual native actor-root inventory identity.
     *
     * @returns {number} Positive uint32 player inventory container ID.
     */
    function playerInventoryId() {
        requireOptional('playerInventoryId', ['player_inventory_id']);

        return requireResult(api.player_inventory_id(), 'player inventory ID', 1, 0xFF_FF_FF_FF);
    }

    /**
     * Actor-relative admission state is separate from internal stored capacity.
     *
     * @param {number} id - Positive uint32 container identity.
     * @param {number|null} [actorId=null] - Actor identity 1, or null for no actor.
     * @returns {{capacity: number, effectiveCapacity: number, contentsWeight: number, capacityWeight: number, maxWeight: number}} Detached native capacity and weight scalars.
     */
    function containerState(id, actorId = null) {
        requireOptional('containerState', ['container_state_read']);
        requireAccepted(api.container_state_read(requireInteger(id, 'container ID', 1, 0xFF_FF_FF_FF),
            actorId === null ? 0 : requireInteger(actorId, 'actor ID', 1, 1)), 'containerState');
        const view = scratch('containerState');

        return Object.fromEntries(['capacity', 'effectiveCapacity', 'contentsWeight', 'capacityWeight', 'maxWeight']
            .map((name, index) => [name, view.getFloat64(index * 8, true)]));
    }

    /**
     * Source-authoritative bag shell and contents weight variants.
     *
     * @param {number} id - Positive uint32 item identity.
     * @returns {{actualWeight: number, contentsWeight: number, unequippedWeight: number, equippedWeight: number, hotbarEquippedWeight: number, wrapperEffectiveCapacity: number}} Detached native item weight and wrapper capacity scalars.
     */
    function itemWeights(id) {
        requireOptional('itemWeights', ['item_weights_read']);
        requireAccepted(api.item_weights_read(requireInteger(id, 'item ID', 1, 0xFF_FF_FF_FF)), 'itemWeights');
        const view = scratch('itemWeights');

        return Object.fromEntries(['actualWeight', 'contentsWeight', 'unequippedWeight', 'equippedWeight',
            'hotbarEquippedWeight', 'wrapperEffectiveCapacity'].map((name, index) => [name, view.getFloat64(index * 8, true)]));
    }

    /**
     * Capture portable policy names, membership order and exact native allocator/configuration.
     *
     * @returns {object} Detached versioned inventory graph with ordered items, containers, and carry configuration.
     */
    function exportInventoryGraph() {
        requireOptional('exportInventoryGraph', ['container_next_id', 'container_config_read']);
        const containerRows = containers();
        const itemRows = items();

        api.container_config_read();
        const view = scratch('container configuration');

        return {
            version: 1, containers: containerRows, items: itemRows,
            nextContainerId: requireResult(api.container_next_id(), 'next container ID', 2, 0x1_00_00_00_00),
            organized: view.getFloat64(0, true) !== 0, disorganized: view.getFloat64(8, true) !== 0,
            equippedMultiplier: view.getFloat64(16, true), dropItemsOnSquareCenter: view.getFloat64(24, true) !== 0,
            wornOrder: wornItems().map(({ id }) => id),
        };
    }

    /**
     * Full-precision host validation precedes the single native graph staging transaction.
     *
     * @param {object} graph - Versioned inventory graph previously captured by exportInventoryGraph.
     * @returns {void} Atomically replaces the native inventory graph after validation.
     */
    function importInventoryGraph(graph) {
        requireOptional('importInventoryGraph', ['item_import_begin', 'item_import_stage', 'item_import_commit',
            'item_import_abort', 'container_import_stage', 'container_import_policy_stage', 'container_import_allocator',
            'item_import_source_state']);
        requireMoodleObject(graph, 'Inventory graph');

        if (graph.version !== 1 || !Array.isArray(graph.containers) || graph.containers.length < 1
            || graph.containers.length > 8_193 || !Array.isArray(graph.items) || graph.items.length > 4_096
            || typeof graph.organized !== 'boolean' || typeof graph.disorganized !== 'boolean'
            || typeof graph.dropItemsOnSquareCenter !== 'boolean') {
            throw new TypeError('Invalid inventory graph shape.');
        }

        const next = requireInteger(graph.nextContainerId, 'next container ID', 2, 0x1_00_00_00_00);
        const multiplier = requireItemWeight(graph.equippedMultiplier, 'equipped multiplier');
        const containerRows = graph.containers.map((record) => {
            requireMoodleObject(record, 'Imported container');
            const kind = ['actor', 'floor', 'bag'].indexOf(record.kind) + 1;
            const parent = [null, 'actor', 'square'].indexOf(record.parentKind);

            if (!kind || parent === -1 || typeof record.explored !== 'boolean' || typeof record.looted !== 'boolean') {
                throw new TypeError('Invalid container kind, parent or flags.');
            }

            const world = record.worldPosition;

            if ((kind === 2) !== (world !== null)) {
                throw new TypeError('Only floor containers have a world square.');
            }

            if (world !== null) {
                requireMoodleObject(world, 'Container world position');
            }

            const row = [
                requireInteger(record.id, 'container ID', 1, 0xFF_FF_FF_FF), kind, parent,
                parent === 0 ? 0 : requireInteger(record.parentId, 'container parent ID', 0, 0xFF_FF_FF_FF),
                record.containingItemId === null ? 0 : requireInteger(record.containingItemId, 'containing item ID', 1, 0xFF_FF_FF_FF),
                requireInteger(record.capacity, 'container capacity', -0x80_00_00_00, 0x7F_FF_FF_FF),
                requireInteger(record.weightReduction, 'container reduction', 0, 100),
                world === null ? 0 : requireInteger(world.x, 'floor x', -0x80_00_00_00, 0x7F_FF_FF_FF),
                world === null ? 0 : requireInteger(world.y, 'floor y', -0x80_00_00_00, 0x7F_FF_FF_FF),
                world === null ? 0 : requireInteger(world.z, 'floor z', 0, 0),
                Number(record.explored) | (Number(record.looted) << 1),
                requireInteger(record.definitionOrdinal, 'container definition', 0, Math.max(0, definitionMetadata.length - 1)),
            ];

            return {
                row, policy: [row[0], policyToken(record.type, 'container type'),
                    policyToken(record.onlyAcceptCategory, 'onlyAcceptCategory', true), policyToken(record.acceptItemFunction, 'acceptItemFunction')],
            };
        });
        const numeric = graph.items.map((record) => {
            requireMoodleObject(record, 'Imported item');
            const ordinal = definitionOrdinal(record.fullType);

            if (record.definitionOrdinal !== undefined && record.definitionOrdinal !== ordinal) {
                throw new TypeError('Item definition ordinal conflicts with fullType.');
            }

            if (typeof record.favorite !== 'boolean' || typeof record.consumed !== 'boolean') {
                throw new TypeError('Item favorite and consumed flags must be booleans.');
            }

            const world = record.worldPosition;

            if (world !== null) {
                requireMoodleObject(world, 'Item world position');
                requireInteger(world.z, 'item world z', 0, 0);

                for (const axis of ['x', 'y']) {
                    requireCoordinate(world[axis], `item world ${axis}`);

                    if (world[axis] < -0x80_00_00_00 || world[axis] >= 0x80_00_00_00) {
                        throw new RangeError('Item world coordinate outside square range.');
                    }
                }
            }

            const defaultWeight = !Object.hasOwn(record, 'weight') || !Object.hasOwn(record, 'actualWeight')
                ? resolvedDefinition(ordinal).weight
                : undefined;

            return [
                requireInteger(record.id, 'item ID', 1, 0xFF_FF_FF_FF), ordinal,
                requireInteger(record.ownerContainerId, 'item owner container', 1, 0xFF_FF_FF_FF),
                world === null ? 0 : world.x, world === null ? 0 : world.y,
                requireInteger(record.condition, 'condition', 0, 0x7F_FF_FF_FF),
                requireInteger(record.count, 'count', 1, 0xFF_FF_FF_FF),
                record.bodyLocation === null ? 0 : requireBodyLocation(record.bodyLocation),
                requireItemWeight(Object.hasOwn(record, 'weight') ? record.weight : defaultWeight, 'weight'),
                requireItemWeight(Object.hasOwn(record, 'actualWeight') ? record.actualWeight : defaultWeight, 'actualWeight'),
                record.internalContainerId === null ? 0 : requireInteger(record.internalContainerId, 'internal container ID', 1, 0xFF_FF_FF_FF),
                Number(world !== null),
            ];
        });

        if (graph.wornOrder !== undefined && (!Array.isArray(graph.wornOrder) || graph.wornOrder.length > 4_096)) {
            throw new TypeError('Worn order must be a bounded array.');
        }

        const order = graph.wornOrder?.map((id) => requireInteger(id, 'worn item ID', 1, 0xFF_FF_FF_FF));

        if (order !== undefined) {
            requireOptional('importInventoryGraph worn order', ['item_import_worn_begin', 'item_import_worn_stage']);
        }

        scratch('importInventoryGraph');
        requireAccepted(api.item_import_begin(), 'importInventoryGraph');
        try {
            requireAccepted(api.container_import_allocator(next, Number(graph.organized), Number(graph.disorganized), multiplier,
                Number(graph.dropItemsOnSquareCenter)),
            'importInventoryGraph allocator');

            for (const { row, policy } of containerRows) {
                const view = scratch('importInventoryGraph container');

                for (const [index, value] of row.entries()) {
                    view.setFloat64(index * 8, value, true);
                }

                requireAccepted(api.container_import_stage(), 'importInventoryGraph container');
                requireAccepted(api.container_import_policy_stage(...policy), 'importInventoryGraph policy');
            }

            for (const [index, row] of numeric.entries()) {
                requireAccepted(api.item_import_stage(...row), 'importInventoryGraph item');
                requireAccepted(api.item_import_source_state(row[0], Number(graph.items[index].favorite)
                | (Number(graph.items[index].consumed) << 1)), 'importInventoryGraph item source state');
            }

            if (order !== undefined) {
                requireAccepted(api.item_import_worn_begin(), 'importInventoryGraph worn order');

                for (const id of order) {
                    requireAccepted(api.item_import_worn_stage(id), 'importInventoryGraph worn record');
                }
            }

            requireAccepted(api.item_import_commit(), 'importInventoryGraph commit');
        } finally {
            api.item_import_abort();
        }
    }

    /**
     * Reads equipment at an exact body location.
     *
     * @param {string} bodyLocation - Exact original body-location identity.
     * @returns {object|null} Detached worn record, or no equipment.
     */
    function wornItem(bodyLocation) {
        const token = requireBodyLocation(bodyLocation);
        const id = equipmentOperation('wornGet', token);

        return id === null ? null : getItem(id);
    }

    /**
     * Queries the live native item at the canonical hands slot, without host classification.
     *
     * @returns {boolean} Whether tagged awkward gloves are currently worn.
     */
    function isWearingAwkwardGloves() {
        if (typeof api.item_wearing_awkward_gloves !== 'function') {
            throw new TypeError('isWearingAwkwardGloves is unsupported by this engine module.');
        }

        return api.item_wearing_awkward_gloves(requireBodyLocation('base:hands')) !== 0;
    }

    /**
     * Reads the project health scalar; no original survival behavior is inferred.
     *
     * @returns {number} Health inside [0,100].
     */
    function getHealth() {
        requireOptional('getHealth', ['health']);

        return api.health();
    }

    /**
     * Reads scalar death without adding native moodle thresholds or movement rules.
     *
     * @returns {boolean} Whether health is zero.
     */
    function isDead() {
        requireOptional('isDead', ['is_dead']);

        return api.is_dead() !== 0;
    }

    /**
     * Queries original IDs without retaining pointers or changing counters.
     * Rules own levels; survival, mass, weather/corpse dynamics and UI effects
     * remain explicitly unmodeled, not silently supplied by neutral arrays.
     *
     * @returns {{id:string,level:number}[]} Detached ordered levels.
     */
    function moodles() {
        requireOptional('moodles', ['moodle_level']);

        return MOODLE_IDS.map((id, index) => ({ id, level: api.moodle_level(index) }));
    }

    /**
     * Reads validation metadata from WASM, never a host numeric shadow.
     *
     * @returns {object} Numeric {min,max,default,integer} or boolean metadata.
     */
    function moodleInputLimits() {
        requireOptional('moodleInputLimits', ['moodle_input_limit']);

        return Object.fromEntries(MOODLE_INPUT_NAMES.map((name, index) => {
            const kind = api.moodle_input_limit(index, 3);
            const defaultValue = api.moodle_input_limit(index, 2);

            return [name, kind === 2
                ? { type: 'boolean', default: defaultValue !== 0 }
                : {
                        min: api.moodle_input_limit(index, 0), max: api.moodle_input_limit(index, 1),
                        default: defaultValue, integer: kind === 1,
                    }];
        }));
    }

    /**
     * Validates an owned moodle input against authoritative WASM limits.
     *
     * @param {string} name - Exact owned input name.
     * @param {unknown} value - Input at original JavaScript precision.
     * @returns {number} Numeric ABI value.
     */
    function validateMoodleInput(name, value) {
        requireOptional('moodle input', ['moodle_input_limit']);
        const index = MOODLE_INPUT_NAMES.indexOf(name);

        if (index === -1) {
            throw new RangeError(`Unknown moodle input: ${String(name)}.`);
        }

        const kind = api.moodle_input_limit(index, 3);

        if (kind === 2) {
            if (typeof value !== 'boolean') {
                throw new TypeError(`${name} must be boolean.`);
            }

            return Number(value);
        }

        requireCoordinate(value, name);
        const min = api.moodle_input_limit(index, 0);
        const max = api.moodle_input_limit(index, 1);

        if (kind === 1) {
            return requireInteger(value, name, min, max);
        }

        if (value < min || value > max) {
            throw new RangeError(`${name} must be inside [${min}, ${max}].`);
        }

        return value;
    }

    /**
     * Private-host persistence; does not change the twelve-word actor format.
     * Defaults: source stats1/37, source food duration1600; explicit port load
     * 0/max8, no environmental exposure, corpse impact disabled. These policies
     * are not claims of original weight, weather or survival dynamics.
     *
     * @returns {object} Detached exact version1 inputs and timed state.
     */
    function saveMoodleState() {
        requireOptional('saveMoodleState', ['moodle_state_value', 'moodle_input_limit']);

        return {
            version: 1,
            inputs: Object.fromEntries(MOODLE_INPUT_NAMES.map((name, index) => [
                name, api.moodle_input_limit(index, 3) === 2
                    ? api.moodle_state_value(index) !== 0
                    : api.moodle_state_value(index),
            ])),
            painTimer: api.moodle_state_value(34),
            painLevel: api.moodle_state_value(35),
            cantSprintTimer: api.moodle_state_value(36),
        };
    }

    /**
     * Validates every key and full-precision value before staging any mutation.
     * Counters count accepted updates, not seconds, matching original rules.
     *
     * @param {object} state - Exact saveMoodleState version1 shape.
     */
    function loadMoodleState(state) {
        requireOptional('loadMoodleState', ['moodle_import_begin', 'moodle_import_stage',
            'moodle_import_commit', 'moodle_import_abort', 'moodle_input_limit']);
        requireMoodleObject(state, 'Moodle state');
        const keys = ['version', 'inputs', 'painTimer', 'painLevel', 'cantSprintTimer'];

        if (state.version !== 1 || Object.keys(state).length !== keys.length
            || keys.some((key) => !Object.hasOwn(state, key))) {
            throw new TypeError('Moodle state requires the exact version1 shape.');
        }

        requireMoodleObject(state.inputs, 'Moodle inputs');

        if (Object.keys(state.inputs).length !== MOODLE_INPUT_NAMES.length
            || MOODLE_INPUT_NAMES.some((name) => !Object.hasOwn(state.inputs, name))) {
            throw new TypeError('Moodle state requires every named input and no extra keys.');
        }

        const values = MOODLE_INPUT_NAMES.map((name) => validateMoodleInput(name, state.inputs[name]));

        values.push(requireInteger(state.painTimer, 'painTimer', 0, 119),
            requireInteger(state.painLevel, 'painLevel', 0, 4),
            requireInteger(state.cantSprintTimer, 'cantSprintTimer', 1, 300));
        api.moodle_import_begin();
        try {
            for (const [index, value] of values.entries()) {
                requireAccepted(api.moodle_import_stage(index, value), 'loadMoodleState');
            }

            requireAccepted(api.moodle_import_commit(), 'loadMoodleState commit');
        } finally {
            api.moodle_import_abort();
        }
    }

    /** Restores only moodle inputs/counters, for pre-moodle save migration. */
    function resetMoodleState() {
        requireOptional('resetMoodleState', ['moodle_reset']);
        api.moodle_reset();
    }

    /**
     * Reads source injury/thermal fields and uncapped native derived pain.
     *
     * @returns {object[]} Detached canonical body records.
     */
    function bodyParts() {
        requireOptional('bodyParts', ['body_part_value']);

        return BODY_PART_IDS.map((id, part) => ({
            id,
            ...Object.fromEntries(BODY_FIELDS.map((name, field) => [
                name, field >= 12 && field <= 14
                    ? api.body_part_value(part, field) !== 0
                    : api.body_part_value(part, field),
            ])),
            pain: api.body_part_value(part, 16),
            skinSurface: api.body_part_value(part, 17),
            distToCore: api.body_part_value(part, 18),
        }));
    }

    /**
     * Reads validation metadata from native mutable-field rules.
     *
     * @returns {object} Detached field-scoped limits.
     */
    function bodyPartInputLimits() {
        requireOptional('bodyPartInputLimits', ['body_part_input_limit']);

        return Object.fromEntries(BODY_FIELDS.map((name, field) => [
            name, api.body_part_input_limit(field, 3) === 2
                ? { type: 'boolean', default: api.body_part_input_limit(field, 2) !== 0 }
                : {
                        min: api.body_part_input_limit(field, 0), max: api.body_part_input_limit(field, 1),
                        default: api.body_part_input_limit(field, 2), integer: false,
                    },
        ]));
    }

    /**
     * Validates original host precision before native f32 conversion.
     *
     * @param {string} name - Mutable field identity.
     * @param {unknown} value - Original input.
     * @returns {number} Numeric native field word.
     */
    function validateBodyField(name, value) {
        requireOptional('body input', ['body_part_input_limit']);
        const field = BODY_FIELDS.indexOf(name);

        if (field === -1) {
            throw new RangeError(`Unknown mutable body field: ${String(name)}.`);
        }

        if (api.body_part_input_limit(field, 3) === 2) {
            if (typeof value !== 'boolean') {
                throw new TypeError(`${name} must be boolean.`);
            }

            return Number(value);
        }

        const numeric = requireCoordinate(value, name);
        const min = api.body_part_input_limit(field, 0);
        const max = api.body_part_input_limit(field, 1);

        if (numeric < min || numeric > max) {
            throw new RangeError(`${name} must be inside [${min}, ${max}].`);
        }

        return numeric;
    }

    /**
     * Stages a validated partial record; no valid prefix changes live state.
     *
     * @param {string} part - Canonical body identity.
     * @param {object} values - Mutable field patch.
     */
    function setBodyPart(part, values) {
        requireOptional('setBodyPart', ['body_update_begin', 'body_update_stage',
            'body_update_commit', 'body_import_abort', 'body_part_input_limit']);
        const index = BODY_PART_IDS.indexOf(part);

        if (index === -1) {
            throw new RangeError(`Unknown body part: ${String(part)}.`);
        }

        requireMoodleObject(values, 'Body part values');
        const fields = Object.keys(values).map((name) => [
            BODY_FIELDS.indexOf(name), validateBodyField(name, values[name]),
        ]);

        if (fields.length === 0) {
            throw new TypeError('Body part values require at least one mutable field.');
        }

        requireAccepted(api.body_update_begin(index), 'setBodyPart');
        try {
            for (const [field, value] of fields) {
                requireAccepted(api.body_update_stage(field, value), 'setBodyPart');
            }

            requireAccepted(api.body_update_commit(), 'setBodyPart commit');
        } finally {
            api.body_import_abort();
        }
    }

    /**
     * Reads the actual six-arm weighted native thermal factor.
     *
     * @returns {number} Native f32 result, including derived overflow.
     */
    function thermalActionModifier() {
        requireOptional('thermalActionModifier', ['thermal_action_modifier']);

        return api.thermal_action_modifier();
    }

    /**
     * Checks native exports without reading or substituting body state.
     *
     * @returns {boolean} Whether native body capture is supported.
     */
    function canSaveBodyState() {
        return typeof api.body_injury_severity === 'function' && typeof api.body_part_value === 'function';
    }

    /**
     * Persists only native mutable fields, never derived/anatomy values.
     *
     * @returns {object} Exact portable version1 body payload.
     */
    function saveBodyState() {
        requireOptional('saveBodyState', ['body_injury_severity', 'body_part_value']);

        return {
            version: 1,
            injurySeverity: INJURY_SEVERITIES[api.body_injury_severity()],
            ...(typeof api.body_metabolic_target_get === 'function' ? { metabolicTarget: getMetabolicTarget() } : {}),
            parts: bodyParts().map((part) => ({
                id: part.id, ...Object.fromEntries(BODY_FIELDS.map((name) => [name, part[name]])),
            })),
        };
    }

    /**
     * Validates complete canonical identity coverage before atomic native load.
     *
     * @param {object} state - Exact version1 body payload.
     */
    function loadBodyState(state) {
        requireOptional('loadBodyState', ['body_import_begin', 'body_import_stage',
            'body_import_commit', 'body_import_abort', 'body_part_input_limit']);
        requireMoodleObject(state, 'Body state');
        const keys = ['version', 'injurySeverity', 'parts'];
        const hasMetabolic = Object.hasOwn(state, 'metabolicTarget');

        if (hasMetabolic) {
            keys.push('metabolicTarget');
        }

        if (state.version !== 1 || Object.keys(state).length !== keys.length
            || keys.some((key) => !Object.hasOwn(state, key))
            || !Array.isArray(state.parts) || state.parts.length !== BODY_PART_IDS.length) {
            throw new TypeError('Body state requires exact version1 shape and every body part.');
        }

        const severity = injurySeverity(state.injurySeverity);
        const metabolic = hasMetabolic ? requireCoordinate(state.metabolicTarget, 'saved metabolic target') : undefined;

        if (hasMetabolic) {
            requireOptional('loadBodyState metabolic target', ['body_import_metabolic_stage']);

            if (metabolic < -1 || metabolic > 10.300_000_190_734_863) {
                throw new RangeError('Saved metabolic target outside native range.');
            }
        }

        const rows = new Map();

        for (const row of state.parts) {
            requireMoodleObject(row, 'Body state part');

            if (!Object.hasOwn(row, 'id') || !BODY_PART_IDS.includes(row.id) || rows.has(row.id)
                || Object.keys(row).length !== BODY_FIELDS.length + 1
                || BODY_FIELDS.some((name) => !Object.hasOwn(row, name))) {
                throw new TypeError('Body state requires unique canonical parts and exactly their mutable fields.');
            }

            rows.set(row.id, BODY_FIELDS.map((name) => validateBodyField(name, row[name])));
        }

        const words = BODY_PART_IDS.flatMap((id) => rows.get(id));

        requireAccepted(api.body_import_begin(severity), 'loadBodyState');
        try {
            for (const [index, value] of words.entries()) {
                requireAccepted(api.body_import_stage(index, value), 'loadBodyState');
            }

            if (hasMetabolic) {
                requireAccepted(api.body_import_metabolic_stage(metabolic), 'loadBodyState metabolic target');
            }

            requireAccepted(api.body_import_commit(), 'loadBodyState commit');
        } finally {
            api.body_import_abort();
        }
    }

    /**
     * Read dedicated extension scratch, never the actor's twelve words.
     *
     * @param {string} prefix - Native scratch namespace.
     * @param {number} size - Exact ABI byte count.
     * @returns {DataView} Fresh bounded view.
     */
    function extensionScratch(prefix, size) {
        requireOptional(prefix, [`${prefix}_scratch_ptr`, `${prefix}_scratch_size`]);
        const ptr = api[`${prefix}_scratch_ptr`]() >>> 0;
        const length = api[`${prefix}_scratch_size`]() >>> 0;
        const buffer = api.memory?.buffer;

        if (!buffer || length !== size || ptr % 8 || ptr + length > buffer.byteLength) {
            throw new Error(`${prefix}: invalid dedicated scratch buffer.`);
        }

        return new DataView(buffer, ptr, length);
    }

    const queueResultLimits = new Map([
        ['queue_action_new', [1, 2_147_483_647]],
        ['queue_length', [0, 128]], ['queue_get', [1, 2_147_483_647]], ['queue_current', [0, 2_147_483_647]],
        ['queue_request_pickup', [1, 2_147_483_647]], ['queue_request_door', [1, 2_147_483_647]],
        ['queue_request_transfer', [1, 2_147_483_647]],
        ['queue_request_walk', [1, 2_147_483_647]], ['queue_remove', [1, 2_147_483_647]], ['queue_lookup', [0, 128]],
        ['queue_group_new', [1, 2_147_483_647]], ['queue_group_length', [0, 512]],
        ['queue_group_get', [1, 2_147_483_647]], ['queue_group_remove', [1, 2_147_483_647]],
        ['queue_group_item_length', [0, 20]], ['queue_group_item_get', [1, 4_294_967_295]],
        ['queue_group_item_source_get', [1, 4_294_967_295]],
        ['queue_group_item_remove', [1, 4_294_967_295]], ['queue_event_read', [0, 1]],
        ['queue_save_size', [1, 1_048_576]], ['queue_save_read', [0, 4_096]],
        ['source_retrigger_get', [0, 2_147_483_647]], ['source_path_result', [0, 2]],
        ['source_door_could_be_open', [0, 1]],
        ['source_world_item_count', [0, 4_096]], ['source_world_item_get', [1, 4_294_967_295]],
        ['source_square_door_count', [0, 65_536]], ['source_square_door_get', [1, 4_294_967_295]],
    ]);

    /**
     * Invoke a queue operation without hiding refusal.
     *
     * @param {string} method - Diagnostic label.
     * @param {string} name - Native export.
     * @param {...number} args - Exact ABI arguments.
     * @returns {number} Native result.
     */
    function queueCall(method, name, ...args) {
        requireOptional(method, ['queue_capability', name]);

        if (api.queue_capability() !== 1) {
            throw new Error(`${method}: unsupported queue version.`);
        }

        const result = api[name](...args);
        const limits = queueResultLimits.get(name);

        if (limits) {
            requireResult(result, method, limits[0], limits[1]);
        } else {
            requireAccepted(result, method);
        }

        return result;
    }

    /**
     * Read a detached native action row, including private lifecycle metadata.
     *
     * @param {number} id - Stable action ID.
     * @returns {Omit<import('../types/mod-api').ModQueuedAction, 'groups'> & {targetId: number, flags: number, portable: boolean, groupCount: number}} Detached native row.
     */
    function actionRead(id) {
        queueCall('actionRead', 'queue_action_read', requireInteger(id, 'action id', 1, 0x7F_FF_FF_FF));
        const view = extensionScratch('queue', 4_096);
        const row = Array.from({ length: 16 }, (_, index) => view.getFloat64(index * 8, true));
        const flags = row[13];
        const transfer = row[1] === 3 || row[1] === 5 ? transferRead(id) : {};

        return {
            id: row[0], kind: ['walk', 'door', 'grab', 'getUp', 'transfer'][row[1] - 1], origin: ['sdk', 'lua'][row[2]],
            target: Object.freeze({
                id: row[1] === 2 || (row[1] === 4 && row[3] !== 0xFF_FF_FF_FF)
                    ? doorIds[row[3]]
                    : row[3], x: row[4], y: row[5], z: row[6],
            }),
            targetId: row[3],
            rawTime: row[7], maxTime: row[8], currentTime: row[9], lastTime: row[10],
            prevLastTime: row[11], delta: row[12], started: (flags & 1) !== 0,
            flags, portable: row[15] !== 0, groupCount: row[14],
            allowMissingItems: (flags & 1_024) !== 0,
            ...transfer,
        };
    }

    /**
     * Read a detached native group and its ordered item identities.
     *
     * @param {number} id - Stable group ID.
     * @returns {{id: number, actionId: number, rawTime: number, itemCount: number, fullType: string|null, itemIds: number[], sourceContainerIds: number[]}} Detached frozen native group and frozen accepted per-item source references.
     */
    function groupRead(id) {
        queueCall('groupRead', 'queue_group_read', requireInteger(id, 'group ID', 1, 0x7F_FF_FF_FF));
        const view = extensionScratch('queue', 4_096);
        const row = Array.from({ length: 4 }, (_, index) => view.getFloat64(index * 8, true));

        requireInteger(row[3], 'group item count', 0, 20);
        const itemIds = Array.from({ length: row[3] }, (_, index) => queueCall('groupItemGet', 'queue_group_item_get', id, index));
        const sourceContainerIds = Array.from({ length: row[3] }, (_, index) =>
            queueCall('groupItemSourceGet', 'queue_group_item_source_get', id, index));
        const first = itemIds.length ? getItem(itemIds[0]) : null;

        return Object.freeze({
            id: row[0], actionId: row[1], rawTime: row[2], itemCount: row[3],
            fullType: first?.fullType ?? null, itemIds: Object.freeze(itemIds),
            sourceContainerIds: Object.freeze(sourceContainerIds),
        });
    }

    /**
     * Read the current action and pending FIFO as detached immutable records.
     *
     * @returns {import('../types/mod-api').ModQueueState} Immutable canonical FIFO.
     */
    function queueState() {
        const currentId = queueCall('current', 'queue_current');
        const count = requireInteger(queueCall('length', 'queue_length'), 'queue length', 0, 128);
        const ids = Array.from({ length: count }, (_, index) => queueCall('get', 'queue_get', index));

        if (currentId && !ids.includes(currentId)) {
            ids.unshift(currentId);
        }

        const records = ids.map((id) => {
            const row = actionRead(id);
            const groups = Array.from({ length: row.groupCount }, (_, groupIndex) => {
                const group = groupRead(queueCall('groupGet', 'queue_group_get', row.id, groupIndex));

                return Object.freeze({
                    id: group.id, rawTime: group.rawTime, fullType: group.fullType,
                    itemIds: group.itemIds, sourceContainerIds: group.sourceContainerIds,
                });
            });
            const record = {
                id: row.id, kind: row.kind, origin: row.origin, target: row.target,
                ...(row.sourceContainerId === undefined
                    ? {}
                    : {
                            sourceContainerId: row.sourceContainerId, destinationContainerId: row.destinationContainerId,
                            floorPosition: row.floorPosition,
                        }),
                rawTime: row.rawTime, maxTime: row.maxTime, currentTime: row.currentTime,
                lastTime: row.lastTime, prevLastTime: row.prevLastTime, delta: row.delta, started: row.started,
            };

            return Object.freeze({ ...record, groups: Object.freeze(groups) });
        });

        return Object.freeze({
            current: records.find((row) => row.id === currentId) ?? null,
            pending: Object.freeze(records.filter((row) => row.id !== currentId)),
        });
    }

    /**
     * Describe accepted queue admission without claiming completion.
     *
     * @param {number} actionId - Accepted stable ID.
     * @returns {import('../types/mod-api').ModQueueAcceptance} Admission and current queue state.
     */
    function acceptance(actionId) {
        if (actionId <= 0) {
            throw new Error('Native queue did not return an accepted action identity.');
        }

        return Object.freeze({ accepted: true, actionId, state: queueState() });
    }

    const actions = Object.freeze({
        getState: queueState,
        /**
         * Admit a pickup for a stable native item identity.
         *
         * @param {number} id - Positive uint32 item ID.
         * @returns {import('../types/mod-api').ModQueueAcceptance} Accepted admission and queue state.
         */
        requestPickup: (id) => acceptance(queueCall('requestPickup', 'queue_request_pickup',
            requireInteger(id, 'item id', 1, 0xFF_FF_FF_FF))),
        /**
         * Admit immutable source/destination intent, not transfer completion.
         *
         * @param {number} id - Positive uint32 item identity.
         * @param {number} sourceContainerId - Positive uint32 source container identity.
         * @param {number} destinationContainerId - Positive uint32 destination container identity.
         * @returns {import('../types/mod-api').ModQueueAcceptance} Accepted admission and current queue state.
         */
        requestTransfer: (id, sourceContainerId, destinationContainerId) => acceptance(queueCall(
            'requestTransfer', 'queue_request_transfer', requireInteger(id, 'item ID', 1, 0xFF_FF_FF_FF),
            requireInteger(sourceContainerId, 'source container ID', 1, 0xFF_FF_FF_FF),
            requireInteger(destinationContainerId, 'destination container ID', 1, 0xFF_FF_FF_FF))),
        requestDoor: toggleDoor,
        /**
         * Admit a walk to an exact source-square coordinate.
         *
         * @param {import('../types/mod-api').ModWorldCoordinates} root0 - Destination square.
         * @param {number} root0.x - Signed int32 destination x.
         * @param {number} root0.y - Signed int32 destination y.
         * @param {number} root0.z - Signed int32 destination elevation.
         * @returns {import('../types/mod-api').ModQueueAcceptance} Accepted admission and queue state.
         */
        requestWalk: ({ x, y, z }) => acceptance(queueCall('requestWalk', 'queue_request_walk',
            requireInteger(x, 'walk x', -0x80_00_00_00, 0x7F_FF_FF_FF),
            requireInteger(y, 'walk y', -0x80_00_00_00, 0x7F_FF_FF_FF),
            requireInteger(z, 'walk z', -0x80_00_00_00, 0x7F_FF_FF_FF))),
        /**
         * Cancel queued work and primitive movement immediately.
         *
         * @returns {import('../types/mod-api').ModQueueState} Queue state after cancellation.
         */
        cancel: () => {
            queueState();
            command({ type: 'cancel' });

            return queueState();
        },
    });

    const timingFields = ['multiplier', 'bias', 'perObject', 'slowHalf', 'slowQuarter', 'slowEighth', 'instant'];
    const traitIds = ['base:dextrous', 'base:allthumbs', 'base:hemophobic', 'base:organized', 'base:disorganized'];

    /**
     * Resolve a supported canonical trait to its native ordinal.
     *
     * @param {string} id - Canonical supported trait.
     * @returns {number} Native ordinal.
     */
    function traitIndex(id) {
        const index = traitIds.indexOf(id);

        if (index === -1) {
            throw new RangeError(`Unsupported source trait: ${String(id)}.`);
        }

        return index;
    }

    /**
     * Decode the exact native UTF8 game mode.
     *
     * @returns {string} Exact native game mode.
     */
    function getGameMode() {
        requireOptional('getGameMode', ['source_timing_read', 'source_mode_get_byte']);
        requireAccepted(api.source_timing_read(), 'getGameMode');
        const count = extensionScratch('source_timing', 128).getFloat64(96, true);

        requireInteger(count, 'mode byte count', 0, 128);

        return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from({ length: count }, (_, index) => {
            const byte = api.source_mode_get_byte(index);

            return requireResult(byte, 'getGameMode', 0, 255);
        }));
    }

    const sourceTiming = Object.freeze({
        /**
         * Read detached native clock fields, mode and supported traits.
         *
         * @returns {import('../types/mod-api').ModSourceTimingState} Immutable source timing state.
         */
        getState: () => {
            requireOptional('sourceTiming', ['source_timing_read']);
            requireAccepted(api.source_timing_read(), 'sourceTiming');
            const view = extensionScratch('source_timing', 128);
            const row = Array.from({ length: 16 }, (_, index) => view.getFloat64(index * 8, true));

            return Object.freeze({
                multiplier: row[0], bias: row[1], perObject: row[2],
                fpsMultiplier: row[3], elapsedSeconds: row[4], slowMultiplier: row[5],
                slowHalf: row[6] !== 0, slowQuarter: row[7] !== 0, slowEighth: row[8] !== 0,
                instant: row[9] !== 0, gameMode: getGameMode(), gameMultiplier: row[13],
                traits: Object.freeze({
                    'base:dextrous': row[10] !== 0, 'base:allthumbs': row[11] !== 0,
                    'base:hemophobic': row[14] !== 0,
                    'base:organized': sourceTiming.hasTrait('base:organized'), 'base:disorganized': sourceTiming.hasTrait('base:disorganized'),
                }),
            });
        },
        /**
         * Set one supported native clock field without coercing flag types.
         *
         * @param {import('../types/mod-api').ModTimingField} field - Supported timing selector.
         * @param {number|boolean} value - Numeric clock scalar or strict boolean flag.
         */
        set: (field, value) => {
            const index = timingFields.indexOf(field);

            if (index === -1) {
                throw new RangeError(`Unsupported source timing field: ${String(field)}.`);
            }

            if (index >= 3 && typeof value !== 'boolean') {
                throw new TypeError(`${field} must be boolean.`);
            }

            if (index < 3) {
                requireCoordinate(value, field);
            }

            requireOptional('sourceTiming.set', ['source_timing_set']);
            requireAccepted(api.source_timing_set(index, index >= 3 ? Number(value) : value), 'sourceTiming.set');
        },
        /**
         * Read one supported native source trait.
         *
         * @param {string} id - Canonical supported trait identity.
         * @returns {boolean} Whether the actor has the trait.
         */
        hasTrait: (id) => {
            const index = traitIndex(id);
            const name = index < 3 ? 'source_trait_get' : 'container_trait_get';

            requireOptional('hasTrait', [name]);
            const value = api[name](index < 3 ? index : index - 3);

            requireResult(value, 'hasTrait', 0, 1);

            return value !== 0;
        },
        /**
         * Set one supported native source trait.
         *
         * @param {string} id - Canonical supported trait identity.
         * @param {boolean} enabled - Strict native trait flag.
         */
        setTrait: (id, enabled) => {
            if (typeof enabled !== 'boolean') {
                throw new TypeError('trait enabled must be boolean.');
            }

            const index = traitIndex(id);
            const name = index < 3 ? 'source_trait_set' : 'container_trait_set';

            requireOptional('setTrait', [name]);
            requireAccepted(api[name](index < 3 ? index : index - 3, Number(enabled)), 'setTrait');
        },
        getGameMode,
        /**
         * Store an exact well-formed game mode within the native UTF8 limit.
         *
         * @param {string} mode - Game mode of at most 128 UTF8 bytes.
         */
        setGameMode: (mode) => {
            if (typeof mode !== 'string') {
                throw new TypeError('game mode must be a string.');
            }

            if (!mode.isWellFormed()) {
                throw new TypeError('game mode must have an exact UTF8 representation.');
            }

            const bytes = new TextEncoder().encode(mode);

            if (bytes.length > 128) {
                throw new RangeError('game mode exceeds 128 UTF8 bytes.');
            }

            requireOptional('setGameMode', ['source_mode_begin', 'source_mode_byte', 'source_mode_commit']);
            requireAccepted(api.source_mode_begin(bytes.length), 'setGameMode begin');

            for (const [index, byte] of bytes.entries()) {
                requireAccepted(api.source_mode_byte(index, byte), 'setGameMode byte');
            }

            requireAccepted(api.source_mode_commit(), 'setGameMode commit');
        },
    });

    let dispatchingSource = false;
    let sourceSaveHook;
    let savingQueue = false;
    let sourceOwnerExport;
    let sourceContextResolver;

    /**
     * Query a native directional source-square relation.
     *
     * @param {string} name - Native relation export.
     * @param {import('../types/mod-api').ModWorldCoordinates} from - Calling square.
     * @param {import('../types/mod-api').ModWorldCoordinates|null} to - Target square or null.
     * @returns {boolean} Real native source relation.
     */
    function sourceRelation(name, from, to) {
        requireOptional(name, [name]);
        const source = squareCoordinates(from, name);
        const target = to === null ? [0, 0, 0] : squareCoordinates(to, name);
        const result = api[name](...source, ...target, Number(to !== null));

        requireResult(result, name, 0, 1);

        return result === 1;
    }

    /**
     * Validate detached owner identity against every retained native Lua FIFO entry.
     *
     * @param {{actionId: number, ownerId: string}[]} owners - Stable source package mapping.
     * @returns {{actionId: number, ownerId: string}[]} Validated detached mapping.
     */
    function validateSourceOwners(owners) {
        const state = queueState();
        const ids = new Set([state.current, ...state.pending].filter((row) => row?.origin === 'lua').map((row) => row.id));

        if (!Array.isArray(owners) || owners.length !== ids.size || owners.length > 128) {
            throw new Error('Source owner export must describe every native Lua action exactly.');
        }

        return owners.map((row) => {
            if (!row || !ids.delete(row.actionId) || typeof row.ownerId !== 'string' || !row.ownerId
                || Object.keys(row).length !== 2) {
                throw new Error('Invalid source action owner identity.');
            }

            return { actionId: row.actionId, ownerId: row.ownerId };
        });
    }

    /**
     * Read immutable source and destination container references for a queued transfer.
     *
     * @param {number} actionId - Positive native queued action identity.
     * @returns {object} Detached transfer references and optional destination floor position.
     */
    function transferRead(actionId) {
        queueCall('transferRead', 'queue_transfer_read', requireInteger(actionId, 'action ID', 1, 0x7F_FF_FF_FF));
        const view = extensionScratch('queue', 4_096);
        const sourceContainerId = view.getFloat64(0, true);
        const destinationContainerId = view.getFloat64(8, true);
        const floorPosition = { x: view.getFloat64(16, true), y: view.getFloat64(24, true), z: view.getFloat64(32, true) };

        return {
            sourceContainerId, destinationContainerId,
            floorPosition: getContainer(destinationContainerId)?.kind === 'floor' ? Object.freeze(floorPosition) : null,
        };
    }

    /**
     * Read a validated numeric native container query result.
     *
     * @param {string} label - Host-facing operation label.
     * @param {string} name - Native export name.
     * @param {number[]} args - Native scalar arguments.
     * @param {number} [max=1] - Maximum accepted native result.
     * @returns {number} Validated native query value.
     */
    function containerQuery(label, name, args, max = 1) {
        requireOptional(label, [name]);

        return requireResult(api[name](...args), label, 0, max);
    }

    /**
     * Raise the native metabolic target only when the requested value exceeds it.
     *
     * @param {number} value - Finite target representable as a native f32.
     * @returns {void} Applies the source setter's raise-only behavior.
     */
    function setMetabolicTarget(value) {
        requireCoordinate(value, 'metabolic target');

        if (Math.abs(value) > 3.402_823_466_385_288_6e38) {
            throw new RangeError('Metabolic target must fit finite f32.');
        }

        requireOptional('setMetabolicTarget', ['body_metabolic_target_set']);
        requireAccepted(api.body_metabolic_target_set(value), 'setMetabolicTarget');
    }

    /**
     * Read the current native metabolic target.
     *
     * @returns {number} Finite native metabolic target.
     */
    function getMetabolicTarget() {
        requireOptional('getMetabolicTarget', ['body_metabolic_target_get']);

        return requireCoordinate(api.body_metabolic_target_get(), 'native metabolic target');
    }

    /**
     * Read authenticated native floor, stair, and slope facts for one square.
     *
     * @param {import('../types/mod-api').ModWorldCoordinates} coords - Signed-int32 square coordinates.
     * @returns {object} Detached floor flags, stair types, slope direction, and heights.
     */
    function squareFloorState(coords) {
        requireMoodleObject(coords, 'Source square coordinates');
        requireOptional('squareFloorState', ['source_square_floor_read']);
        requireAccepted(api.source_square_floor_read(
            requireInteger(coords.x, 'square x', -0x80_00_00_00, 0x7F_FF_FF_FF),
            requireInteger(coords.y, 'square y', -0x80_00_00_00, 0x7F_FF_FF_FF),
            requireInteger(coords.z, 'square z', -0x80_00_00_00, 0x7F_FF_FF_FF)), 'squareFloorState');
        const view = extensionScratch('queue', 4_096);
        const flags = view.getFloat64(0, true);
        const stairs = view.getFloat64(8, true);
        const direction = view.getFloat64(16, true);

        if (direction === 9 && !(flags & 1) && !stairs) {
            throw new Error('squareFloorState: unsupported original facility (malformed slope direction).');
        }

        return {
            flags, stairTypes: stairs, slopeDirection: direction,
            slopeMin: view.getFloat64(24, true), slopeMax: view.getFloat64(32, true),
            solidFloor: (flags & 1) !== 0 || stairs !== 0 || direction !== 0,
            solid: (flags & 2) !== 0, solidTrans: (flags & 4) !== 0, stairs: stairs !== 0,
        };
    }

    /**
     * Original edge dispatch checks N/W locally and S/E on the adjacent native square.
     *
     * @param {import('../types/mod-api').ModWorldCoordinates} from - Loaded source square.
     * @param {import('../types/mod-api').ModWorldCoordinates|null} to - Target square, or null for no target.
     * @returns {boolean} Whether the original directional edge dispatch finds a window.
     */
    function squareWindowTo(from, to) {
        const fromState = squareFloorState(from);

        if (to === null) {
            return false;
        }

        squareFloorState(to);

        if (from.x === to.x && from.y === to.y && from.z === to.z) {
            return false;
        }

        /**
         * Read a window edge flag from the source square or a loaded offset square.
         *
         * @param {import('../types/mod-api').ModWorldCoordinates} coords - Base square coordinates.
         * @param {number} mask - Native window edge flag mask.
         * @param {number} [dx=0] - Tile offset along x.
         * @param {number} [dy=0] - Tile offset along y.
         * @returns {boolean} Whether the loaded square has the requested edge flag.
         */
        const edge = (coords, mask, dx = 0, dy = 0) => {
            if (dx === 0 && dy === 0 && coords === from) {
                return (fromState.flags & mask) !== 0;
            }

            const target = { x: coords.x + dx, y: coords.y + dy, z: coords.z };

            if (!getSquare(target.x, target.y, target.z)) {
                return false;
            }

            return (squareFloorState(target).flags & mask) !== 0;
        };

        return (from.x > to.x && (edge(from, 16) || edge(to, 16, 1)))
            || (from.x < to.x && (edge(to, 16) || edge(from, 16, 1)))
            || (from.y > to.y && (edge(from, 8) || edge(to, 8, 0, 1)))
            || (from.y < to.y && (edge(to, 8) || edge(from, 8, 0, 1)));
    }

    /**
     * Original staircase bounding spans and destination HasStairs, not adjacency guesses.
     *
     * @param {import('../types/mod-api').ModWorldCoordinates} from - Loaded source staircase square.
     * @param {import('../types/mod-api').ModWorldCoordinates|null} to - Candidate square, or null for no target.
     * @returns {boolean} Whether the target lies in the original stair span and has stairs.
     */
    function squareSameStaircase(from, to) {
        const { stairTypes } = squareFloorState(from);

        if (!to || from.z !== to.z) {
            return false;
        }

        let x1 = from.x;
        let x2 = from.x;
        let y1 = from.y;
        let y2 = from.y;

        if (stairTypes & 1) {
            y2 += 2;
        } else if (stairTypes & 2) {
            y1 -= 1;
            y2 += 1;
        } else if (stairTypes & 4) {
            y1 -= 2;
        } else if (stairTypes & 8) {
            x2 += 2;
        } else if (stairTypes & 16) {
            x1 -= 1;
            x2 += 1;
        } else if (stairTypes & 32) {
            x1 -= 2;
        } else {
            return false;
        }

        if (to.x < x1 || to.x > x2 || to.y < y1 || to.y > y2 || !getSquare(to.x, to.y, to.z)) {
            return false;
        }

        return squareFloorState(to).stairs;
    }

    /**
     * Original f32 lerp/division sites; stairs need actual render-chunk configuration.
     *
     * @param {import('../types/mod-api').ModWorldCoordinates} coords - Loaded source square.
     * @param {number} dx - Finite fractional x position, clamped to [0, 1] after f32 conversion.
     * @param {number} dy - Finite fractional y position, clamped to [0, 1] after f32 conversion.
     * @param {boolean|undefined} fboRenderChunk - Actual render-chunk setting, required for stairs.
     * @returns {number} Apparent elevation using the original f32 arithmetic.
     */
    function squareApparentZ(coords, dx, dy, fboRenderChunk) {
        const state = squareFloorState(coords);

        if (state.slopeDirection === 9) {
            throw new Error('squareApparentZ: unsupported original facility (malformed slope direction).');
        }

        const f = Math.fround;
        const x = Math.min(1, Math.max(0, f(requireCoordinate(dx, 'square fractional x'))));
        const y = Math.min(1, Math.max(0, f(requireCoordinate(dy, 'square fractional y'))));
        /**
         * Interpolate with the original Java-float rounding at each arithmetic site.
         *
         * @param {number} a - Starting height.
         * @param {number} b - Ending height.
         * @param {number} t - Interpolation fraction.
         * @returns {number} Interpolated f32 height.
         */
        const lerp = (a, b, t) => f(f(a) + f(f(f(b) - f(a)) * t));

        if (state.stairs) {
            if (typeof fboRenderChunk !== 'boolean') {
                throw new TypeError('squareApparentZ: unsupported original facility (render-chunk configuration).');
            }

            const shift = fboRenderChunk ? f(0.1) : 0;
            let low;
            let high;
            let t;

            if (state.stairTypes & 1) {
                low = f(f(0.666_6) + shift);
                high = 1;
                t = f(1 - y);
            } else if (state.stairTypes & 8) {
                low = f(f(0.666_6) + shift);
                high = 1;
                t = f(1 - x);
            } else if (state.stairTypes & 2) {
                low = f(f(0.333_3) + shift);
                high = f(f(0.666_6) + shift);
                t = f(1 - y);
            } else if (state.stairTypes & 16) {
                low = f(f(0.333_3) + shift);
                high = f(f(0.666_6) + shift);
                t = f(1 - x);
            } else if (state.stairTypes & 4) {
                low = f(0.01);
                high = f(f(0.333_3) + shift);
                t = f(1 - y);
            } else {
                low = f(0.01);
                high = f(f(0.333_3) + shift);
                t = f(1 - x);
            }

            return f(f(coords.z) + lerp(low, high, t));
        }

        const direction = state.slopeDirection;

        if (direction === 0 || direction > 4) {
            return f(coords.z);
        }

        const t = [null, f(1 - y), y, f(1 - x), x][direction];
        const height = f(lerp(Math.round(state.slopeMin * 100), Math.round(state.slopeMax * 100), t) / 100);

        return f(f(coords.z) + Math.max(0, height));
    }

    const sourceActions = {
        actionRead, groupRead,
        getMetabolicTarget, setMetabolicTarget,
        /**
         * Read native actor transfer posture and drop-position options.
         *
         * @returns {{shouldBeTurning: boolean, sittingOnFurniture: boolean, seatedInVehicle: boolean, dropItemsOnSquareCenter: boolean}} Detached native transfer flags.
         */
        actorTransferState: () => {
            requireOptional('actorTransferState', ['source_actor_transfer_state_read']);
            requireAccepted(api.source_actor_transfer_state_read(), 'actorTransferState');
            const view = scratch('actorTransferState');

            return Object.fromEntries(['shouldBeTurning', 'sittingOnFurniture', 'seatedInVehicle', 'dropItemsOnSquareCenter']
                .map((name, index) => [name, view.getFloat64(index * 8, true) !== 0]));
        },
        /**
         * Read whether the actor should turn before the original transfer helper runs.
         *
         * @returns {boolean} Native turning flag.
         */
        actorShouldBeTurning: () => sourceActions.actorTransferState().shouldBeTurning,
        /**
         * Read whether the actor is sitting on furniture.
         *
         * @returns {boolean} Native furniture-seating flag.
         */
        actorSittingOnFurniture: () => sourceActions.actorTransferState().sittingOnFurniture,
        /**
         * Read whether the actor is seated in a vehicle.
         *
         * @returns {boolean} Native vehicle-seating flag.
         */
        actorSeatedInVehicle: () => sourceActions.actorTransferState().seatedInVehicle,
        /**
         * Read whether floor drops use the square center.
         *
         * @returns {boolean} Native drop-position option.
         */
        dropItemsOnSquareCenter: () => sourceActions.actorTransferState().dropItemsOnSquareCenter,
        /**
         * Set the native floor-drop centering option.
         *
         * @param {boolean} value - Whether floor drops use the square center.
         * @returns {void} Updates the native drop-position option.
         */
        setDropItemsOnSquareCenter: (value) => {
            if (typeof value !== 'boolean') {
                throw new TypeError('Drop-items-center option must be boolean.');
            }

            requireOptional('setDropItemsOnSquareCenter', ['source_drop_items_center_set']);
            requireAccepted(api.source_drop_items_center_set(Number(value)), 'setDropItemsOnSquareCenter');
        },
        /**
         * Resolve the native animal-zone identity for a source square.
         *
         * @param {import('../types/mod-api').ModWorldCoordinates} coords - Signed-int32 square coordinates.
         * @returns {number|null} Positive uint32 zone identity, or null when absent.
         */
        animalZoneForSquare: (coords) => {
            requireOptional('animalZoneForSquare', ['source_animal_zone_for_square']);
            const id = api.source_animal_zone_for_square(
                requireInteger(coords.x, 'animal-zone x', -0x80_00_00_00, 0x7F_FF_FF_FF),
                requireInteger(coords.y, 'animal-zone y', -0x80_00_00_00, 0x7F_FF_FF_FF),
                requireInteger(coords.z, 'animal-zone z', -0x80_00_00_00, 0x7F_FF_FF_FF));

            return requireResult(id, 'animalZoneForSquare', 0, 0xFF_FF_FF_FF) || null;
        },
        /**
         * Draw a native random value for the currently authorized transfer event.
         *
         * @param {number} action - Positive signed-int32 source action identity.
         * @param {number} item - Positive uint32 item identity authorized by the event.
         * @param {number} token - Positive uint32 current event token.
         * @param {number} min - Nonnegative finite f32 lower bound.
         * @param {number} max - Finite f32 upper bound, no smaller than min.
         * @param {boolean} integer - Whether to use native integer random mode.
         * @returns {number} Finite native random result.
         */
        transferRandom: (action, item, token, min, max, integer) => {
            if (typeof integer !== 'boolean') {
                throw new TypeError('Transfer random integer mode must be boolean.');
            }

            requireCoordinate(min, 'random minimum');
            requireCoordinate(max, 'random maximum');

            if (min < 0 || max > 3.402_823_466_385_288_6e38 || max < min) {
                throw new RangeError('Transfer random bounds must fit ordered nonnegative finite f32.');
            }

            requireOptional('transferRandom', ['queue_transfer_random']);
            const value = api.queue_transfer_random(requireInteger(action, 'action ID', 1, 0x7F_FF_FF_FF),
                itemId(item), requireInteger(token, 'event token', 1, 0xFF_FF_FF_FF), min, max, Number(integer));

            if (value < 0) {
                requireAccepted(value, 'transferRandom');
            }

            return requireCoordinate(value, 'transfer random result');
        },
        squareFloorState, squareWindowTo, squareSameStaircase, squareApparentZ,
        /**
         * Read the actor's original overlay sprite name.
         *
         * @returns {string|null} Resolved native overlay name, or null for no overlay.
         */
        actorOverlaySprite: () => {
            requireOptional('actorOverlaySprite', ['source_actor_overlay_get']);

            return policyName(requireResult(api.source_actor_overlay_get(), 'actor overlay token', 0, 0xFF_FF_FF_FF));
        },
        /**
         * Read native equipment membership for a live item.
         *
         * @param {number} id - Positive uint32 item identity.
         * @returns {{worn: boolean, held: boolean, attached: boolean}} Detached equipment flags.
         */
        itemEquipmentState: (id) => {
            requireOptional('itemEquipmentState', ['item_equipment_state_read']);
            requireAccepted(api.item_equipment_state_read(itemId(id)), 'itemEquipmentState');
            const view = scratch('itemEquipmentState');

            return {
                worn: view.getFloat64(0, true) !== 0, held: view.getFloat64(8, true) !== 0,
                attached: view.getFloat64(16, true) !== 0,
            };
        },
        /**
         * Read an item's original source flag, optionally setting it first.
         *
         * @param {number} id - Positive uint32 item identity.
         * @param {'favorite'|'consumed'} field - Source state flag to access.
         * @param {boolean} [enabled] - New flag value; omission leaves the flag unchanged.
         * @returns {boolean} Native flag value after any requested mutation.
         */
        itemSourceState: (id, field, enabled) => {
            const index = ['favorite', 'consumed'].indexOf(field);

            if (index === -1) {
                throw new RangeError('Unsupported item source state.');
            }

            if (enabled !== undefined) {
                if (typeof enabled !== 'boolean') {
                    throw new TypeError('Item source state must be boolean.');
                }

                requireOptional('itemSourceState', ['item_source_state_set']);
                requireAccepted(api.item_source_state_set(itemId(id), index, Number(enabled)), 'itemSourceState');
            }

            requireOptional('itemSourceState', ['item_source_state_read']);
            requireAccepted(api.item_source_state_read(itemId(id)), 'itemSourceState');

            return scratch('itemSourceState').getFloat64(index * 8, true) !== 0;
        },
        containerRead: getContainer, containerState, itemWeights, transferRead,
        /**
         * Read original ordered child inventory weight, distinct from raw/reduced contents.
         *
         * @param {number} id - Positive uint32 bag item identity.
         * @returns {number} Native f32 accumulation using the shell's source equipment state.
         */
        itemInventoryWeight: (id) => {
            requireOptional('itemInventoryWeight', ['item_inventory_weight_read']);
            requireAccepted(api.item_inventory_weight_read(itemId(id)), 'itemInventoryWeight');

            return scratch('itemInventoryWeight').getFloat64(0, true);
        },
        /**
         * Read a bag item's native internal or actor-relative effective capacity.
         *
         * @param {number} id - Positive uint32 bag item identity.
         * @param {number|null} actor - Actor token 0 or 1, or null for no actor.
         * @param {boolean} effective - Whether to read effective rather than stored capacity.
         * @returns {number} Native capacity scalar.
         */
        itemContainerCapacity: (id, actor, effective) => {
            if (typeof effective !== 'boolean') {
                throw new TypeError('Effective capacity selector must be boolean.');
            }

            requireOptional('itemContainerCapacity', ['item_container_capacity']);
            requireAccepted(api.item_container_capacity(itemId(id), actorId(actor), Number(effective)), 'itemContainerCapacity');

            return scratch('itemContainerCapacity').getFloat64(0, true);
        },
        /**
         * Count a native container's direct ordered item members.
         *
         * @param {number} id - Positive uint32 container identity.
         * @returns {number} Direct member count in [0, 4096].
         */
        containerItemCount: (id) => containerQuery('containerItemCount', 'container_item_count', [containerId(id)], 4_096),
        /**
         * Read an item identity by its native direct-membership index.
         *
         * @param {number} id - Positive uint32 container identity.
         * @param {number} index - Zero-based member index in [0, 4095].
         * @returns {number} Native item identity.
         */
        containerItemGet: (id, index) => containerQuery('containerItemGet', 'container_item_get',
            [containerId(id), requireInteger(index, 'container item index', 0, 4_095)], 0xFF_FF_FF_FF),
        /**
         * Query native direct or recursive item membership.
         *
         * @param {number} id - Positive uint32 container identity.
         * @param {number} item - Positive uint32 item identity.
         * @param {boolean} recurse - Whether to search nested bag inventories.
         * @returns {boolean} Whether the item belongs to the requested inventory scope.
         */
        containerContains: (id, item, recurse) => {
            if (typeof recurse !== 'boolean') {
                throw new TypeError('recursive contains must be boolean.');
            }

            return containerQuery('containerContains', 'container_contains', [containerId(id), itemId(item), Number(recurse)]) === 1;
        },
        /**
         * Query the native containment relation between a container and a bag item.
         *
         * @param {number} id - Positive uint32 container identity.
         * @param {number} item - Positive uint32 candidate containing item identity.
         * @returns {boolean} Whether the container is inside the item.
         */
        containerIsInside: (id, item) => containerQuery('containerIsInside', 'container_is_inside', [containerId(id), itemId(item)]) === 1,
        /**
         * Resolve a container's native outermost inventory identity.
         *
         * @param {number} id - Positive uint32 container identity.
         * @returns {number} Native outermost container identity.
         */
        containerOutermost: (id) => containerQuery('containerOutermost', 'container_outermost', [containerId(id)], 0xFF_FF_FF_FF),
        /**
         * Read the original item root, which excludes a direct floor owner.
         *
         * @param {number} id - Positive uint32 live item identity.
         * @returns {number|null} Actor root or outer bag interior, or null for a direct world item.
         */
        itemOutermostContainer: (id) => containerQuery('itemOutermostContainer', 'item_outermost_container',
            [itemId(id)], 0xFF_FF_FF_FF) || null,
        /**
         * Resolve the actor owning a native container.
         *
         * @param {number} id - Positive uint32 container identity.
         * @returns {number} Native actor token, zero when there is no actor owner.
         */
        containerActorOwner: (id) => containerQuery('containerActorOwner', 'container_actor_owner', [containerId(id)]),
        /**
         * Resolve the native floor inventory for a supported ground-level square.
         *
         * @param {number} x - Signed-int32 tile x coordinate.
         * @param {number} y - Signed-int32 tile y coordinate.
         * @param {number} z - Supported elevation, exactly zero.
         * @returns {number} Native floor container identity.
         */
        floorContainer: (x, y, z) => containerQuery('floorContainer', 'source_floor_container', [
            requireInteger(x, 'floor x', -0x80_00_00_00, 0x7F_FF_FF_FF),
            requireInteger(y, 'floor y', -0x80_00_00_00, 0x7F_FF_FF_FF), requireInteger(z, 'floor z', 0, 0),
        ], 0xFF_FF_FF_FF),
        /**
         * Query original item admission with a resolved source policy result.
         *
         * @param {number} id - Positive uint32 destination container identity.
         * @param {number} item - Positive uint32 incoming item identity.
         * @param {number} [policy=-1] - Native policy result in [-1, 1].
         * @returns {boolean} Whether the native container allows the item.
         */
        containerItemAllowed: (id, item, policy = -1) => containerQuery('containerItemAllowed', 'container_item_allowed',
            [containerId(id), itemId(item), policyResult(policy)]) === 1,
        /**
         * Query actor-relative room for an item using original admission policy.
         *
         * @param {number} id - Positive uint32 destination container identity.
         * @param {number|null} actor - Actor token 0 or 1, or null for no actor.
         * @param {number} item - Positive uint32 incoming item identity.
         * @param {number} [policy=-1] - Native policy result in [-1, 1].
         * @returns {boolean} Whether the native container has room for the item.
         */
        containerHasRoomItem: (id, actor, item, policy = -1) => containerQuery('containerHasRoomItem', 'container_has_room_item',
            [containerId(id), actorId(actor), itemId(item), policyResult(policy)]) === 1,
        /**
         * Query actor-relative room for incoming weight and a floor-weight adjustment.
         *
         * @param {number} id - Positive uint32 destination container identity.
         * @param {number|null} actor - Actor token 0 or 1, or null for no actor.
         * @param {number} weight - Nonnegative finite f32 incoming weight.
         * @param {number} [floorDelta=0] - Nonnegative finite f32 floor-weight adjustment.
         * @returns {boolean} Whether the native capacity predicate accepts the weight.
         */
        containerHasRoomWeight: (id, actor, weight, floorDelta = 0) => containerQuery('containerHasRoomWeight', 'container_has_room_weight',
            [containerId(id), actorId(actor), requireItemWeight(weight, 'incoming weight'), requireItemWeight(floorDelta, 'floor weight delta')]) === 1,
        /**
         * Query whether original native policy permits removing an item.
         *
         * @param {number} id - Positive uint32 source container identity.
         * @param {number} item - Positive uint32 item identity.
         * @returns {boolean} Whether removal is allowed.
         */
        containerRemoveAllowed: (id, item) => containerQuery('containerRemoveAllowed', 'container_remove_allowed',
            [containerId(id), itemId(item)]) === 1,
        /**
         * Set a supported native container state flag.
         *
         * @param {number} id - Positive uint32 container identity.
         * @param {number} field - Native flag selector, 0 or 1.
         * @param {boolean} value - New flag value.
         * @returns {number} Zero after the native mutation is accepted.
         */
        containerSetFlags: (id, field, value) => {
            if (typeof value !== 'boolean') {
                throw new TypeError('container flag must be boolean.');
            }

            requireOptional('containerSetFlags', ['container_flags_set']);
            requireAccepted(api.container_flags_set(containerId(id), requireInteger(field, 'container flag field', 0, 1),
                Number(value)), 'containerSetFlags');

            return 0;
        },
        /**
         * Apply the original native floating-point weight correction.
         *
         * @param {number} weight - Nonnegative finite f32 weight.
         * @returns {number} Native corrected weight.
         */
        floatingPointCorrection: (weight) => {
            requireOptional('floatingPointCorrection', ['source_floating_point_correction']);

            return api.source_floating_point_correction(requireItemWeight(weight, 'weight'));
        },
        /**
         * Bind immutable source and destination references to a native source action.
         *
         * @param {number} action - Positive signed-int32 source action identity.
         * @param {number} source - Positive uint32 source container identity.
         * @param {number} destination - Positive uint32 destination container identity.
         * @returns {number} Accepted native status.
         */
        actionBindTransfer: (action, source, destination) => queueCall('actionBindTransfer', 'queue_action_bind_transfer',
            requireInteger(action, 'action ID', 1, 0x7F_FF_FF_FF), containerId(source), containerId(destination)),
        /**
         * Capture held refs before an authorized helper can remove equipment.
         *
         * @param {number} action - Native source action ID.
         * @param {number} group - Native source group ID.
         * @param {number} item - Stable item identity authorized by the event.
         * @param {number} token - Current native event token.
         * @param {number} [policy=-1] - Resolved original admission result.
         * @returns {number} Accepted native status.
         */
        transferBegin: (action, group, item, token, policy = -1) => {
            const before = handObservers.size > 0 ? getHandItems() : null;
            const result = queueCall('transferBegin', 'queue_transfer_begin',
                requireInteger(action, 'action ID', 1, 0x7F_FF_FF_FF), requireInteger(group, 'group ID', 1, 0x7F_FF_FF_FF),
                itemId(item), requireInteger(token, 'event token', 1, 0xFF_FF_FF_FF), policyResult(policy));

            transferHandState = { action, item, token, before };

            return result;
        },
        /**
         * Dispatch one helper operation within the native transfer authorization.
         *
         * @param {number} action - Positive signed-int32 source action identity.
         * @param {number} item - Positive uint32 authorized item identity.
         * @param {number} token - Positive uint32 current event token.
         * @param {number} operation - Native transfer operation selector in [1, 8].
         * @param {number} container - Uint32 container identity, or zero when unused.
         * @param {number} x - Finite transfer x coordinate.
         * @param {number} y - Finite transfer y coordinate.
         * @param {number} z - Supported elevation, exactly zero.
         * @returns {number} Accepted native status.
         */
        transferOperation: (action, item, token, operation, container, x, y, z) => queueCall('transferOperation', 'queue_transfer_operation',
            requireInteger(action, 'action ID', 1, 0x7F_FF_FF_FF), itemId(item),
            requireInteger(token, 'event token', 1, 0xFF_FF_FF_FF), requireInteger(operation, 'transfer operation', 1, 8),
            requireInteger(container, 'transfer container ID', 0, 0xFF_FF_FF_FF),
            requireCoordinate(x, 'transfer x'), requireCoordinate(y, 'transfer y'), requireInteger(z, 'transfer z', 0, 0)),
        /**
         * Publish held deltas only after native commits the supported helper.
         *
         * @param {number} action - Native source action ID.
         * @param {number} item - Authorized item identity.
         * @param {number} token - Native event token.
         * @param {boolean|number} success - Strict boolean or native zero/one completion.
         * @returns {number} Accepted native finish status; rollback emits no held event.
         */
        transferFinish: (action, item, token, success) => {
            if (typeof success !== 'boolean' && success !== 0 && success !== 1) {
                throw new TypeError('transfer success must be boolean.');
            }

            const previous = transferHandState;
            const result = queueCall('transferFinish', 'queue_transfer_finish', requireInteger(action, 'action ID', 1, 0x7F_FF_FF_FF),
                itemId(item), requireInteger(token, 'event token', 1, 0xFF_FF_FF_FF), Number(success));

            if (previous?.action === action && previous.item === item && previous.token === token) {
                transferHandState = null;

                if (success && previous.before) {
                    notifyHandItems(previous.before);
                }
            }

            return result;
        },
        /**
         * Query the native slot, including detached source actions awaiting a final event reply.
         *
         * @param {number} id - Positive signed int32 action ID.
         * @returns {boolean} Whether the genuine action record is still resident.
         */
        actionExists: (id) => {
            requireInteger(id, 'action id', 1, 2_147_483_647);
            requireOptional('actionExists', ['queue_capability', 'queue_action_read']);

            if (api.queue_capability() !== 1) {
                throw new Error('actionExists: unsupported native queue capability.');
            }

            const status = api.queue_action_read(id);

            // queue_action_read returns OUT_OF_RANGE only when this validated ID has no slot.
            if (status === -2) {
                return false;
            }

            requireResult(status, 'actionExists', 0, 0);
            const view = extensionScratch('queue', 4_096);
            const kind = view.getFloat64(8, true);
            const origin = view.getFloat64(16, true);

            if (view.getFloat64(0, true) !== id || !Number.isInteger(origin) || origin < 0 || origin > 1
                || !Number.isInteger(kind) || kind < 1 || kind > 5) {
                throw new Error('actionExists: invalid native action record.');
            }

            return true;
        },
        /**
         * Read the native source duration for a stable action.
         *
         * @param {number} id - Positive signed int32 action ID.
         * @returns {number} Native source duration.
         */
        sourceTime: (id) => {
            queueCall('sourceTime', 'queue_source_time_read', requireInteger(id, 'action id', 1, 2_147_483_647));

            return extensionScratch('queue', 4_096).getFloat64(0, true);
        },
        /**
         * Install or clear synchronous source preparation for queue capture.
         *
         * @param {(function(): void)|null} callback - Save preparation hook, or null to clear it.
         */
        setSaveHook: (callback) => {
            if (callback !== null && typeof callback !== 'function') {
                throw new TypeError('Source save hook must be a function or null.');
            }

            sourceSaveHook = callback;
        },
        /**
         * Install or clear the detached source action owner exporter.
         *
         * @param {(function(): {actionId: number, ownerId: string}[])|null} callback - Complete owner exporter, or null to clear it.
         */
        setOwnerExport: (callback) => {
            if (callback !== null && typeof callback !== 'function') {
                throw new TypeError('Source owner export must be a function or null.');
            }

            sourceOwnerExport = callback;
        },
        /**
         * Export and validate every retained native Lua action owner.
         *
         * @returns {{actionId: number, ownerId: string}[]} Detached validated owner mapping.
         */
        exportSourceOwners: () => validateSourceOwners(sourceOwnerExport ? sourceOwnerExport() : []),
        validateSourceOwners,
        /**
         * Install or clear synchronous source context preflight resolution.
         *
         * @param {(function(import('../types/mod-api').ModAction, string): (import('../types/mod-api').ModAction|null))|null} callback - Action resolver, or null to clear it.
         */
        setContextResolver: (callback) => {
            if (callback !== null && typeof callback !== 'function') {
                throw new TypeError('Source context resolver must be a function or null.');
            }

            sourceContextResolver = callback;
        },
        /**
         * Resolve an owned source context action through its preflight hooks.
         *
         * @param {import('../types/mod-api').ModAction} action - Requested context action.
         * @param {string} ownerId - Active source package API identity.
         * @returns {import('../types/mod-api').ModAction|null} Approved action, or null on veto.
         */
        resolveContextAction: (action, ownerId) => {
            if (!sourceContextResolver) {
                throw new Error('Source context action resolution is unavailable.');
            }

            return sourceContextResolver(action, ownerId);
        },
        /**
         * Resolve a known stable door identity to its native ordinal.
         *
         * @param {string} id - Stable door identity.
         * @returns {number} Native door ordinal.
         */
        doorOrdinal: (id) => {
            const value = doorOrdinals.get(id);

            if (value === undefined) {
                throw new RangeError(`Unknown door identity: ${id}.`);
            }

            return value;
        },
        /**
         * Resolve a known native door ordinal to its stable identity.
         *
         * @param {number} ordinal - Native door ordinal.
         * @returns {string} Stable door identity.
         */
        doorId: (ordinal) => {
            const id = doorIds[ordinal];

            if (!id) {
                throw new RangeError(`Unknown native door: ${ordinal}.`);
            }

            return id;
        },
        /**
         * Read native curtain state without inventing unavailable eligibility.
         *
         * @param {string} id - Stable door identity.
         * @returns {{has: boolean, open: boolean, inside: boolean, canAdd: boolean|null}} Immutable native curtain state.
         */
        doorCurtainState: (id) => {
            queueCall('doorCurtainState', 'source_door_curtain_read', sourceActions.doorOrdinal(requireName(id, 'door id')));
            const view = extensionScratch('queue', 4_096);
            const row = Array.from({ length: 4 }, (_, index) => view.getFloat64(index * 8, true));

            for (const flag of row.slice(0, 3)) {
                requireInteger(flag, 'native curtain state flag', 0, 1);
            }

            if (row[3] !== -2) {
                requireInteger(row[3], 'native curtain eligibility', 0, 1);
            }

            return Object.freeze({
                has: row[0] !== 0, open: row[1] !== 0, inside: row[2] !== 0,
                canAdd: row[3] === -2 ? null : row[3] !== 0,
            });
        },
        /**
         * Query the actual native menu policy for a known door.
         *
         * @param {string} id - Stable door identity.
         * @returns {boolean} Whether source policy allows the door menu entry.
         */
        doorCouldBeOpen: (id) => {
            const result = queueCall('doorCouldBeOpen', 'source_door_could_be_open',
                sourceActions.doorOrdinal(requireName(id, 'door id')));

            return requireResult(result, 'doorCouldBeOpen', 0, 1) === 1;
        },
        /**
         * Cancel native source path work.
         */
        cancelPath: () => {
            requireOptional('cancelPath', ['source_path_cancel']);
            requireAccepted(api.source_path_cancel(), 'cancelPath');
        },
        /**
         * Read the bounded native path result for a walk action.
         *
         * @param {number} id - Positive signed int32 walk action ID.
         * @returns {number} Native path result in [0, 2].
         */
        pathResult: (id) => {
            const result = queueCall('pathResult', 'source_path_result',
                requireInteger(id, 'walk action id', 1, 2_147_483_647));

            return requireInteger(result, 'native path result', 0, 2);
        },
        /**
         * Face a finite world position through the native source actor.
         *
         * @param {number} x - Finite target x.
         * @param {number} y - Finite target y.
         */
        face: (x, y) => {
            requireOptional('face', ['source_face']);
            requireAccepted(api.source_face(requireCoordinate(x, 'face x'), requireCoordinate(y, 'face y')), 'face');
        },
        /**
         * Query the native source wall relation between squares.
         *
         * @param {import('../types/mod-api').ModWorldCoordinates} from - Calling square.
         * @param {import('../types/mod-api').ModWorldCoordinates|null} to - Target square or null.
         * @returns {boolean} Native directional wall relation.
         */
        isWallTo: (from, to) => sourceRelation('square_wall_to', from, to),
        /**
         * Query native source reachability using immutable wall facts.
         *
         * @param {import('../types/mod-api').ModWorldCoordinates} from - Calling square.
         * @param {import('../types/mod-api').ModWorldCoordinates|null} to - Target square or null.
         * @returns {boolean} Native directional reachability relation.
         */
        canReachTo: (from, to) => sourceRelation('square_can_reach_to', from, to),
        /**
         * Read the native source actor sitting flag.
         *
         * @returns {boolean} Whether the actor is sitting.
         */
        isSitting: () => {
            requireOptional('isSitting', ['source_is_sitting']);

            return requireResult(api.source_is_sitting(), 'isSitting', 0, 1) !== 0;
        },
        /**
         * Read the action identity retained for source retriggering.
         *
         * @returns {number} Stable action ID, or zero when absent.
         */
        retriggerGet: () => queueCall('retriggerGet', 'source_retrigger_get'),
        /**
         * Set or clear the native source retrigger action identity.
         *
         * @param {number} id - Nonnegative signed int32 action ID; zero clears it.
         * @returns {number} Accepted native operation result.
         */
        retriggerSet: (id) => queueCall('retriggerSet', 'source_retrigger_set',
            requireInteger(id, 'retrigger action id', 0, 2_147_483_647)),
        /**
         * Find a native adjacent square for a coordinate or known door.
         *
         * @param {import('../types/mod-api').ModWorldCoordinates} root0 - Source target square.
         * @param {number} root0.x - Signed int32 target x.
         * @param {number} root0.y - Signed int32 target y.
         * @param {number} root0.z - Signed int32 target elevation.
         * @param {string|null} [doorId=null] - Stable door identity, or null for square adjacency.
         * @returns {Readonly<import('../types/mod-api').ModWorldCoordinates>|null} Adjacent square, or null when none exists.
         */
        findAdjacent: ({ x, y, z }, doorId = null) => {
            requireOptional('findAdjacent', ['source_adjacent_read']);
            const target = doorId === null ? 0 : sourceActions.doorOrdinal(doorId);
            const found = api.source_adjacent_read(doorId === null ? 1 : 2, target,
                requireInteger(x, 'adjacent x', -2_147_483_648, 2_147_483_647),
                requireInteger(y, 'adjacent y', -2_147_483_648, 2_147_483_647),
                requireInteger(z, 'adjacent z', -2_147_483_648, 2_147_483_647));

            requireResult(found, 'findAdjacent', 0, 1);

            if (!found) {
                return null;
            }

            const view = extensionScratch('queue', 4_096);

            return Object.freeze({ x: view.getFloat64(0, true), y: view.getFloat64(8, true), z: view.getFloat64(16, true) });
        },
        /**
         * Query native carry capacity for a stable item.
         *
         * @param {number} id - Positive uint32 item ID.
         * @returns {boolean} Whether the native inventory has room for the item.
         */
        itemHasRoom: (id) => {
            requireOptional('itemHasRoom', ['source_item_has_room']);
            const result = api.source_item_has_room(requireInteger(id, 'item id', 1, 4_294_967_295));

            requireResult(result, 'itemHasRoom', 0, 1);

            return result === 1;
        },
        /**
         * Read one supported native source-square property.
         *
         * @param {number} x - Signed int32 square x.
         * @param {number} y - Signed int32 square y.
         * @param {number} z - Signed int32 square elevation.
         * @param {number} index - Supported source property ordinal in [0, 1].
         * @returns {boolean} Native property flag.
         */
        squareHas: (x, y, z, index) => {
            requireOptional('squareHas', ['source_square_has']);
            const result = api.source_square_has(
                requireInteger(x, 'square x', -2_147_483_648, 2_147_483_647),
                requireInteger(y, 'square y', -2_147_483_648, 2_147_483_647),
                requireInteger(z, 'square z', -2_147_483_648, 2_147_483_647),
                requireInteger(index, 'source property index', 0, 1));

            requireResult(result, 'squareHas', 0, 1);

            return result === 1;
        },
        /**
         * Read one pending native source lifecycle event.
         *
         * @returns {{actionId: number, event: number, generation: number, token: number}|null} Immutable event with kind in [1, 7], or null when absent.
         */
        eventRead: () => {
            const present = queueCall('eventRead', 'queue_event_read');

            if (!present) {
                return null;
            }

            const view = extensionScratch('queue', 4_096);

            return Object.freeze({
                actionId: view.getFloat64(0, true),
                event: requireInteger(view.getFloat64(8, true), 'native source event kind', 1, 7),
                generation: view.getFloat64(16, true), token: view.getFloat64(24, true),
            });
        },
        /**
         * Dispatch bounded native lifecycle transitions to a synchronous owner.
         *
         * @param {function({actionId: number, event: number, generation: number, token: number}): (number|boolean|null|undefined)} callback - Synchronous lifecycle handler and native reply result.
         */
        dispatch: (callback) => {
            if (dispatchingSource) {
                throw new Error('Source action dispatch is reentrant.');
            }

            dispatchingSource = true;
            try {
                // ponytail: 128 records × seven lifecycle transitions; refuse a broken callback loop.
                for (let count = 0; count < 896; count += 1) {
                    const event = sourceActions.eventRead();

                    if (!event) {
                        return;
                    }

                    let result;

                    try {
                        result = callback(event);

                        if (result?.then) {
                            throw new TypeError('Source action callbacks must be synchronous.');
                        }
                    } catch (cause) {
                        sourceActions.eventReply(event.actionId, event.event, event.token, -4);
                        throw cause;
                    }

                    sourceActions.eventReply(event.actionId, event.event, event.token,
                        typeof result === 'boolean' ? Number(result) : result ?? 0);
                }

                throw new Error('Source action event transition limit exceeded.');
            } finally {
                dispatchingSource = false;
            }
        },
    };

    for (const [method, name] of Object.entries({
        newAction: 'queue_action_new', actionSet: 'queue_action_set', length: 'queue_length',
        discard: 'queue_action_discard',
        get: 'queue_get', current: 'queue_current', insert: 'queue_insert', remove: 'queue_remove',
        clear: 'queue_clear', lookup: 'queue_lookup', groupNew: 'queue_group_new',
        groupLength: 'queue_group_length', groupGet: 'queue_group_get', groupInsert: 'queue_group_insert',
        groupRemove: 'queue_group_remove', groupItemLength: 'queue_group_item_length',
        groupItemGet: 'queue_group_item_get', groupItemInsert: 'queue_group_item_insert',
        groupItemSourceGet: 'queue_group_item_source_get',
        groupItemRemove: 'queue_group_item_remove', start: 'queue_start', eventReply: 'queue_event_reply',
        commitItem: 'queue_commit_item', commitDoor: 'queue_commit_door',
        worldItemCount: 'source_world_item_count', worldItemGet: 'source_world_item_get',
        squareDoorCount: 'source_square_door_count', squareDoorGet: 'source_square_door_get',
    })) {
        const squareQuery = name.startsWith('source_world_item_') || name.startsWith('source_square_door_');

        /**
         * Validate exact numeric ABI arguments before invoking a private queue operation.
         *
         * @param {...number} args - Exact native arguments, preserving raw floating-point time/value fields.
         * @returns {number} Accepted native operation result.
         */
        sourceActions[method] = (...args) => {
            requireOptional(method, [name]);

            if (args.length !== api[name].length) {
                throw new TypeError(`${method} requires ${api[name].length} arguments.`);
            }

            let rawIndex = -1;

            switch (method) {
                case 'newAction':
                    rawIndex = 6;
                    break;
                case 'actionSet':
                    rawIndex = 2;
                    break;
                case 'groupNew':
                case 'start':
                    rawIndex = 1;
                    break;
                default:
                    break;
            }

            for (const [index, value] of args.entries()) {
                if (index === rawIndex) {
                    if (typeof value !== 'number') {
                        throw new TypeError(`${method} time/value must be numeric.`);
                    }
                } else {
                    const signed = (method === 'newAction' && index >= 3 && index <= 5)
                        || (squareQuery && index < 3)
                        || (method === 'eventReply' && index === 3);

                    requireInteger(value, `${method} argument ${index}`, signed ? -2_147_483_648 : 0,
                        signed ? 2_147_483_647 : 4_294_967_295);
                }
            }

            const result = queueCall(method, name, ...args);

            if (method === 'eventReply' && transferHandState?.action === args[0] && transferHandState.token === args[2]) {
                // Native reply rolls back an unfinished helper; retire its observation snapshot silently.
                transferHandState = null;
            }

            return result;
        };
    }

    Object.freeze(sourceActions);

    /**
     * Probe actual native portable queue capability rather than wrapper presence.
     *
     * @returns {boolean} Whether the native portable queue exports are supported.
     */
    function canSaveQueueState() {
        if (typeof api.queue_capability !== 'function') {
            return false;
        }

        if (api.queue_capability() !== 1) {
            throw new Error('Unsupported native queue save version.');
        }

        requireOptional('queue save', ['queue_save_size', 'queue_save_read', 'queue_restore_begin',
            'queue_restore_write', 'queue_restore_commit', 'queue_restore_abort']);

        return true;
    }

    /**
     * Capture a portable native queue after synchronous source preparation.
     *
     * @returns {Uint8Array} Detached portable native bytes preserving float bit patterns.
     */
    function saveQueueState() {
        if (!canSaveQueueState()) {
            throw new Error('saveQueueState is unsupported by this engine module.');
        }

        if (savingQueue || dispatchingSource) {
            throw new Error('Cannot save a queue during callback dispatch or another capture.');
        }

        savingQueue = true;
        try {
            const prepared = sourceSaveHook?.();

            if (prepared?.then) {
                throw new TypeError('Source queue save preparation must be synchronous.');
            }

            const size = queueCall('saveQueueState', 'queue_save_size');

            requireInteger(size, 'queue byte count', 1, 1_048_576);
            const bytes = new Uint8Array(size);

            for (let offset = 0; offset < size; offset += 4_096) {
                const count = queueCall('saveQueueState read', 'queue_save_read', offset);

                if (count !== Math.min(4_096, size - offset)) {
                    throw new Error('Invalid native queue save chunk.');
                }

                const view = extensionScratch('queue', 4_096);

                bytes.set(new Uint8Array(view.buffer, view.byteOffset, count), offset);
            }

            return bytes;
        } finally {
            savingQueue = false;
        }
    }

    /**
     * Restore complete portable native queue bytes atomically.
     *
     * @param {Uint8Array} bytes - Complete portable native queue.
     */
    function loadQueueState(bytes) {
        if (!canSaveQueueState()) {
            throw new Error('loadQueueState is unsupported by this engine module.');
        }

        if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 1_048_576) {
            throw new TypeError('Queue restore requires 1..1048576 bytes.');
        }

        queueCall('loadQueueState begin', 'queue_restore_begin', bytes.length);
        try {
            for (let offset = 0; offset < bytes.length; offset += 4_096) {
                const count = Math.min(4_096, bytes.length - offset);
                const view = extensionScratch('queue', 4_096);

                new Uint8Array(view.buffer, view.byteOffset, count).set(bytes.subarray(offset, offset + count));
                queueCall('loadQueueState write', 'queue_restore_write', offset, count);
            }

            queueCall('loadQueueState commit', 'queue_restore_commit');
        } finally {
            queueCall('loadQueueState abort', 'queue_restore_abort');
        }
    }

    return Object.freeze({
        snapshot, command, setSpeed, step, frameStep, reset, actions, sourceActions, sourceTiming,
        canSaveQueueState, saveQueueState, loadQueueState,
        equipmentOperation, wornItems, setWornItem, canSaveEquipmentState, saveEquipmentState, loadEquipmentState,
        worldImportCell, navFlags, worldBounds, saveState, loadState, worldReset,
        registerItemDefinition, itemDefinitions, beginItemDefinitionRegistration,
        commitItemDefinitionRegistration, rollbackItemDefinitionRegistration, freezeItemDefinitions,
        items, getItem, inventoryState, exportInventoryGraph, importInventoryGraph,
        containers, getContainer, containerItems, playerInventoryId, containerState, itemWeights,
        wornItem, isWearingAwkwardGloves, getHealth, isDead,
        getHandItems, setHandItem, observeHandItems, canSaveHandState, saveHandState, loadHandState,
        moodles, moodleInputLimits, saveMoodleState, loadMoodleState, resetMoodleState,
        importDoors, getSquare, isBlockedTo, doors, doorRevision, toggleDoor, saveDoorState, loadDoorState,
        bodyParts, bodyPartInputLimits, thermalActionModifier, canSaveBodyState, saveBodyState, loadBodyState,
    });
}

export { ENGINE_API_VERSION, MOODLE_TYPES, createEngine, validateNavigationCell };
