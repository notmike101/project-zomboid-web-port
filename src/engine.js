/**
 * Host wrapper for the authoritative Rust movement engine.
 *
 * The compiled module owns every piece of simulation state: position,
 * destination or heading, speed, world bounds, tick counter and cancellation.
 * This module instantiates it, checks the ABI, refuses unusable input at the
 * trust boundary and hands back detached snapshots. It never mirrors
 * coordinates, so the host cannot drift away from the rules. Numbers submitted
 * to the module are validated at full JavaScript precision. Snapshot scalars
 * originate as 32-bit floats; actor saves transfer ten 64-bit float words.
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
 * @typedef {MoveToCommand | WalkCommand | CancelCommand} EngineCommand
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
 * @property {1} version Save envelope version.
 * @property {number[]} values Ten finite f64 words: x, y, speed, targetX,
 *   targetY, headingX, headingY, action, tick, worldActive (0 or 1).
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
 */

/** Engine ABI version this host supports; anything else is refused. */
const ENGINE_API_VERSION = 1;

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

        if (size !== 80 || ptr % 8 !== 0 || ptr + size > buffer.byteLength) {
            throw new Error(`${method}: invalid engine scratch buffer.`);
        }

        return new DataView(buffer, ptr, size);
    }

    /**
     * Checks an optional state operation and its ten-word ABI.
     *
     * @param {string} method - Host method requesting state access.
     * @param {string} name - Required state operation export.
     */
    function requireState(method, name) {
        requireOptional(method, [name, 'state_size']);

        if (api.state_size() !== 10) {
            throw new Error(`${method}: engine state must contain ten values.`);
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
            default:
                throw new TypeError(`Unknown engine command: ${String(action?.type)}.`);
        }

        return snapshot();
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
            version: 1, values: Array.from({ length: 10 },
                (_, index) => view.getFloat64(index * 8, true)),
        };
    }

    /**
     * Restores actor state atomically; Rust validates semantics and reconstructs
     * any destination path against cells already imported into this instance.
     * To spawn in a nonzero cell use idle state with position=target, zero
     * heading and worldActive=1.
     *
     * @param {SavedState} state - Version 1 envelope containing ten finite numbers.
     * @throws {TypeError} On an invalid save envelope.
     * @throws {RangeError} When Rust refuses the state without changing it.
     */
    function loadState(state) {
        requireState('loadState', 'state_load');

        if (state === null || typeof state !== 'object' || state.version !== 1
            || !Array.isArray(state.values) || state.values.length !== 10) {
            throw new TypeError('loadState requires version 1 and exactly ten finite values.');
        }

        // Validate all words before writing even the private scratch buffer.
        const values = Array.from(state.values, (value, index) =>
            requireCoordinate(value, `state value ${index}`));
        const view = scratch('loadState');

        for (let index = 0; index < 10; index += 1) {
            view.setFloat64(index * 8, values[index], true);
        }

        requireAccepted(api.state_load(view.byteOffset), 'loadState');
    }

    /** Drops cells/routes and cancels movement, preserving position/speed/tick. */
    function worldReset() {
        requireOptional('worldReset', ['world_reset']);
        api.world_reset();
    }

    return Object.freeze({
        snapshot, command, setSpeed, step, reset,
        worldImportCell, navFlags, worldBounds, saveState, loadState, worldReset,
    });
}

export { ENGINE_API_VERSION, createEngine, validateNavigationCell };
