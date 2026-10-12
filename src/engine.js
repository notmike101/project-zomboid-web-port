/**
 * Host wrapper for the authoritative Rust movement engine.
 *
 * The compiled module owns every piece of simulation state: position,
 * destination or heading, speed, world bounds, tick counter and cancellation.
 * This module instantiates it, checks the ABI, refuses unusable input at the
 * trust boundary and hands back detached snapshots. It never mirrors
 * coordinates, so the host cannot drift away from the rules. Numbers submitted
 * to the module are validated at full JavaScript precision; values read back
 * are 32-bit floats.
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
 * @property {number} x World x coordinate inside [0, 10], stored as 32-bit.
 * @property {number} y World y coordinate inside [0, 10], stored as 32-bit.
 * @property {number} speed Movement speed in world units per second, 32-bit.
 * @property {number} action 0 idle, 1 moving to a destination, 2 walking.
 */

/**
 * Destination assignment. Out-of-bounds destinations are refused, never
 * clamped.
 *
 * @typedef {object} MoveToCommand
 * @property {'moveTo'} type Command selector.
 * @property {number} x Destination x inside [0, 10].
 * @property {number} y Destination y inside [0, 10].
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
 * Host-facing engine handle. State lives inside the WASM instance.
 *
 * @typedef {object} Engine
 * @property {function(): Snapshot} snapshot Reads detached state.
 * @property {function(EngineCommand): Snapshot} command Submits one command.
 * @property {function(number): void} setSpeed Changes speed inside [0.1, 10].
 * @property {function(number): void} step Advances one frame inside (0, 0.1].
 * @property {function(): void} reset Restores the initial state.
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

    return Object.freeze({ snapshot, command, setSpeed, step, reset });
}

export { ENGINE_API_VERSION, createEngine };
