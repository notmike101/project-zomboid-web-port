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
 * Host-facing engine handle. State lives inside the WASM instance.
 * All world/state methods are optional ABI1 extensions: calling a method whose
 * exports are absent throws a clear unsupported error, without disabling the
 * original movement API. Raw WASM memory and scratch addresses stay private.
 *
 * @typedef {object} Engine
 * @property {function(): Snapshot} snapshot Reads detached state.
 * @property {function(EngineCommand): Snapshot} command Submits one command.
 * @property {function(number): void} setSpeed Changes speed inside [0.1, 10].
 * @property {function(number): void} step Advances one frame inside (0, 0.1].
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
 * @property {function(object[]): void} importItems Atomically replaces item records with explicit IDs.
 * @property {function(): {capacityWeight: number, capacity: number, maxWeight: number}} inventoryState Reads detached native flat-player carry state.
 * @property {function(string): object|null} wornItem Reads the item worn at an exact body location.
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
 * @property {function(): object[]} doors Reads detached stable-ID native door state.
 * @property {function(): number} doorRevision Reads the native door revision without allocating door records.
 * @property {function(string): object} toggleDoor Executes a native door interaction.
 * @property {function(): object} saveDoorState Saves optional native door state, separate from actor format2.
 * @property {function(object): void} loadDoorState Restores every native door identity atomically.
 */

/** Engine ABI version this host supports; anything else is refused. */
const ENGINE_API_VERSION = 1;

const MOODLE_IDS = Object.freeze([
    'endurance', 'tired', 'hungry', 'panic', 'sick', 'bored', 'unhappy', 'bleeding',
    'wet', 'hasacold', 'angry', 'stress', 'thirst', 'injured', 'pain', 'heavyload',
    'drunk', 'dead', 'zombie', 'hyperthermia', 'hypothermia', 'windchill', 'cantsprint',
    'uncomfortable', 'noxioussmell', 'foodeaten',
].map((name) => `base:${name}`));
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
        const value = (name === 'hoppable' || name === 'customLock') ? row[name] ?? false : row[name];

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
     * @returns {Snapshot} State after the command.
     */
    function command(action) {
        let spawnedId;

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
                api.cancel();
                break;
            case 'toggleDoor':
                toggleDoor(action.id);
                break;
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
            case 'pickup':
            case 'wear':
            case 'unequip': {
                const name = `item_${action.type}`;

                requireOptional(action.type, [name]);
                requireAccepted(api[name](requireInteger(action.id, 'item id', 1, 0xFF_FF_FF_FF)), action.type);
                break;
            }
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
     * Advances the simulation by one frame. The host owns the clock and must
     * cap elapsed time at 0.1 s; the engine refuses anything larger, which is
     * what keeps a hidden or paused tab from banking catch-up work.
     *
     * @param {number} seconds - Elapsed frame time in (0, 0.1].
     */
    function step(seconds) {
        requireCoordinate(seconds, 'step seconds');
        requireAccepted(api.step(seconds), `step(${seconds})`);
    }

    /**
     * Restores position (5, 5), speed 1.5, the idle action and a zero tick.
     */
    function reset() {
        api.reset();
        doorIds = [null];
        doorOrdinals.clear();
        definitionMetadata.length = 0;
        definitionOrdinals.clear();
        ownerIds.clear();
        ownerNames.length = 1;
        slotIds.clear();
        slotNames.length = 1;
        definitionTransaction = null;
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
    const squareBooleanNames = ['outside', 'solid', 'solidTrans', 'tree', 'vehicleObstructed'];

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
     * Imports source geometry and explicit state atomically. Native constructors
     * may initialize new-world locks with a saved port-owned seed; restores never
     * generate locks. Vehicle flags are valid only for the explicit zero-vehicle
     * world until an authoritative native vehicle geometry producer exists.
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
            'door_import_commit', 'door_import_abort', 'door_read', 'door_count']);

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

            return [index + 1, x, y, z, doorFlags(row, doorBooleanNames),
                requireInteger(row.keyId ?? -1, 'keyId', -1, 0x7F_FF_FF_FF),
                requireInteger(row.roomId, 'roomId', -1, Number.MAX_SAFE_INTEGER),
                requireInteger(row.oppositeRoomId, 'oppositeRoomId', -1, Number.MAX_SAFE_INTEGER),
                doorMask(row.independentWalls, 'independentWalls'), doubleDoor, garageDoor];
        });
        const squareIds = new Set();
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

            return [x, y, z, requireInteger(row.roomId, 'square roomId', -1, Number.MAX_SAFE_INTEGER),
                doorFlags(row, squareBooleanNames), doorMask(row.independentWalls, 'square independentWalls'),
                doorMask(row.windows ?? 0, 'square windows'), doorMask(row.doorWalls ?? 0, 'square doorWalls')];
        });

        scratch('importDoors');
        requireAccepted(api.door_import_begin(seed, lockedHouses, Number(initializeLocks)), 'importDoors');
        try {
            for (const row of numeric) {
                doorWords(row, 'importDoors');
                requireAccepted(api.door_import_stage(), 'importDoors row');
            }

            for (const row of squareRows) {
                doorWords(row, 'importDoors');
                requireAccepted(api.door_square_stage(), 'importDoors square');
            }

            requireAccepted(api.door_import_commit(), 'importDoors commit');
            doorIds = ids;
            doorOrdinals = ordinals;
        } finally {
            api.door_import_abort();
        }
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
     * Submits an authoritative same-level adjacent door interaction.
     *
     * @param {string} id - Exact stable public placement.
     * @returns {Snapshot} Detached actor snapshot; refusal changes nothing.
     */
    function toggleDoor(id) {
        requireOptional('toggleDoor', ['door_toggle']);
        requireName(id, 'door id');
        const ordinal = doorOrdinals.get(id);

        if (ordinal === undefined) {
            throw new RangeError(`Unknown door identity: ${id}.`);
        }

        requireAccepted(api.door_toggle(ordinal), 'toggleDoor');

        return snapshot();
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
    const slotIds = new Map();
    const slotNames = [null];
    let definitionTransaction = null;

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
        const metadata = definitionMetadata[ordinal];

        if (!metadata) {
            throw new Error('Item definition metadata is unavailable.');
        }

        return {
            ...structuredClone(metadata),
            owner: ownerNames[view.getFloat64(0, true)],
            conditionMax: view.getFloat64(8, true),
            bodyLocation: slotNames[view.getFloat64(16, true)],
            stackLimit: view.getFloat64(24, true),
            removeOnBroken: view.getFloat64(32, true) !== 0,
            conditionLowerChanceOneIn: view.getFloat64(40, true),
            weight: view.getFloat64(48, true),
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
        requireOptional('registerItemDefinition', ['item_definition_register', 'item_definition_read', 'inventory_state_read']);
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

        const conditionMax = requireInteger(definition.conditionMax, 'conditionMax', 1, 0x7F_FF_FF_FF);
        const stackLimit = requireInteger(definition.stackLimit, 'stackLimit', 1, 0xFF_FF_FF_FF);
        const chance = requireInteger(definition.conditionLowerChanceOneIn,
            'conditionLowerChanceOneIn', 0, 0xFF_FF_FF_FF);
        const weight = requireItemWeight(Object.hasOwn(definition, 'weight') ? definition.weight : 1, 'weight');
        const previous = definitionOrdinals.get(definition.fullType);
        const ordinal = previous ?? definitionMetadata.length;
        // Clone before dispatch: an uncloneable source field cannot strand a numeric row.
        const metadata = structuredClone(definition);

        for (const key of ['owner', 'conditionMax', 'stackLimit', 'removeOnBroken', 'conditionLowerChanceOneIn', 'weight']) {
            delete metadata[key];
        }

        const ownerId = intern(owner, ownerIds, ownerNames);
        const slot = bodyLocation === null ? 0 : intern(bodyLocation, slotIds, slotNames);

        requireAccepted(api.item_definition_register(ordinal, ownerId, conditionMax, slot,
            stackLimit, Number(definition.removeOnBroken), chance, Number(override), weight), 'registerItemDefinition');

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
            const view = scratch('items');
            const ordinal = view.getFloat64(8, true);

            if (!definitionMetadata[ordinal]) {
                throw new Error('Item definition metadata is unavailable.');
            }

            return {
                id: view.getFloat64(0, true),
                fullType: definitionMetadata[ordinal].fullType,
                location: view.getFloat64(16, true) === 0 ? 'ground' : 'inventory',
                x: view.getFloat64(24, true), y: view.getFloat64(32, true),
                condition: view.getFloat64(40, true), count: view.getFloat64(48, true),
                bodyLocation: slotNames[view.getFloat64(56, true)],
                weight: view.getFloat64(64, true), actualWeight: view.getFloat64(72, true),
            };
        });
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

    /**
     * Validates host values before staging an atomic explicit-ID replacement.
     *
     * @param {object[]} records - Detached records using public fullType identities.
     */
    function importItems(records) {
        requireOptional('importItems', ['item_import_begin', 'item_import_stage', 'item_import_commit', 'item_import_abort', 'inventory_state_read']);

        if (!Array.isArray(records)) {
            throw new TypeError('importItems requires an array.');
        }

        if (records.length > 4_096) {
            throw new RangeError('importItems exceeds the project item capacity of 4096.');
        }

        // Full host precision validation precedes even the first staging call.
        const numeric = Array.from(records, (record) => {
            if (record === null || typeof record !== 'object' || Array.isArray(record)) {
                throw new TypeError('Imported item must be an object.');
            }

            const ordinal = definitionOrdinal(record.fullType);

            if (record.location !== 'ground' && record.location !== 'inventory') {
                throw new TypeError('Item location must be ground or inventory.');
            }

            let slot = 0;

            if (record.bodyLocation !== null) {
                requireName(record.bodyLocation, 'bodyLocation');
                slot = slotIds.get(record.bodyLocation);

                if (slot === undefined) {
                    throw new RangeError(`Unknown bodyLocation: ${record.bodyLocation}.`);
                }
            }

            const defaultWeight = !Object.hasOwn(record, 'weight') || !Object.hasOwn(record, 'actualWeight')
                ? resolvedDefinition(ordinal).weight
                : undefined;

            return [
                requireInteger(record.id, 'item id', 1, 0xFF_FF_FF_FF), ordinal,
                record.location === 'ground' ? 0 : 1,
                requireCoordinate(record.x, 'item x'), requireCoordinate(record.y, 'item y'),
                requireInteger(record.condition, 'condition', 0, 0x7F_FF_FF_FF),
                requireInteger(record.count, 'count', 1, 0xFF_FF_FF_FF), slot,
                requireItemWeight(Object.hasOwn(record, 'weight') ? record.weight : defaultWeight, 'weight'),
                requireItemWeight(Object.hasOwn(record, 'actualWeight') ? record.actualWeight : defaultWeight, 'actualWeight'),
            ];
        });

        requireAccepted(api.item_import_begin(), 'importItems');
        try {
            for (const row of numeric) {
                requireAccepted(api.item_import_stage(...row), 'importItems record');
            }

            requireAccepted(api.item_import_commit(), 'importItems commit');
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
        requireOptional('wornItem', ['item_count', 'item_read']);
        requireName(bodyLocation, 'bodyLocation');

        return items().find((item) => item.bodyLocation === bodyLocation) ?? null;
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

        if (state.version !== 1 || Object.keys(state).length !== keys.length
            || keys.some((key) => !Object.hasOwn(state, key))
            || !Array.isArray(state.parts) || state.parts.length !== BODY_PART_IDS.length) {
            throw new TypeError('Body state requires exact version1 shape and every body part.');
        }

        const severity = injurySeverity(state.injurySeverity);
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

            requireAccepted(api.body_import_commit(), 'loadBodyState commit');
        } finally {
            api.body_import_abort();
        }
    }

    return Object.freeze({
        snapshot, command, setSpeed, step, reset,
        worldImportCell, navFlags, worldBounds, saveState, loadState, worldReset,
        registerItemDefinition, itemDefinitions, beginItemDefinitionRegistration,
        commitItemDefinitionRegistration, rollbackItemDefinitionRegistration, freezeItemDefinitions,
        items, inventoryState, importItems, wornItem, getHealth, isDead,
        moodles, moodleInputLimits, saveMoodleState, loadMoodleState, resetMoodleState,
        importDoors, doors, doorRevision, toggleDoor, saveDoorState, loadDoorState,
        bodyParts, bodyPartInputLimits, thermalActionModifier, canSaveBodyState, saveBodyState, loadBodyState,
    });
}

export { ENGINE_API_VERSION, createEngine, validateNavigationCell };
