/**
 * @file Experimental public mod host for the M1 architecture proof.
 *
 * A mod is a same-origin ES module that exports `manifest` and `activate`.
 * The host hands each activated mod a per-mod API handle, routes host input
 * commands through that mod's `beforeAction` hooks, and then commits the
 * result to the single authoritative WASM engine. Hooks therefore always
 * resolve synchronously *before* a command is committed; the host never
 * awaits mod code.
 *
 * Trust model: mods are trusted same-origin JavaScript, not sandboxed and not
 * isolated. A mod can read and write anything a page script can. This API is
 * experimental (0.1.0) and may change between previews.
 *
 * World navigation, item/health actions and postcommit callbacks expose only
 * implemented engine behavior; original UI options share per-mod save namespaces.
 */

import { validateNavigationCell } from './engine.js';

/** Public mod API version. A manifest must name exactly this value. */
const MOD_API_VERSION = '0.1.0';

const MAX_RECORDED_ERRORS = 20;
const MOD_ID_PATTERN = /^[\da-z][\d._a-z-]{0,63}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const WORLD_MIN = 0;
const WORLD_MAX = 10;
const MIN_SPEED = 0.1;
const MAX_SPEED = 10;
const MAX_SAVE_BYTES = 256 * 1_024;
const ACTION_TYPES = new Set(['moveTo', 'walk', 'cancel', 'spawnItem', 'pickup', 'wear', 'unequip', 'drop', 'setCondition', 'setHealth', 'setCharacterStat', 'setMoodleInputs']);
/** Reserved internal attribution id for page input; a mod cannot claim it. */
const RESERVED_ID = 'host';

/**
 * Detached engine state handed to mods. `action`: 0 idle, 1 destination, 2 walking.
 *
 * @typedef {0|1|2} ModActionState
 */
/**
 * @typedef {import('../types/mod-api').ModSnapshot} ModSnapshot
 */
/**
 * One validated command, detached before each synchronous precommit hook.
 *
 * @typedef {import('../types/mod-api').ModAction} ModAction
 */
/**
 * @typedef {{ id: string, version: string, apiVersion: string, name: string, saveSchemaVersion?: number }} ModManifest
 */
/**
 * What a hook may return: nothing (keep), a replacement action, `false` to cancel, `null` to keep.
 *
 * @typedef {ModAction|false|null|undefined|Promise<unknown>} BeforeActionResult
 */
/**
 * @typedef {(action: ModAction) => BeforeActionResult} BeforeActionHook
 */
/**
 * The engine surface the host needs; `src/engine.js` supplies it.
 *
 * @typedef {import('../types/mod-api').ModEngine} ModEngine
 */
/**
 * The per-mod object passed to `activate`.
 *
 * @typedef {import('../types/mod-api').ModApi} ModApi
 */
/**
 * @typedef {import('../types/mod-api').ModCommandResult} ModCommandResult
 */
/**
 * One internal hook registration.
 *
 * @typedef {{ modId: string, entry: ModEntry, kind: string, callback: BeforeActionHook|import('../types/mod-api').BeforeWorldImportHook|import('../types/mod-api').ModTickListener|import('../types/mod-api').ModCharacterDeathListener, priority: number, order: number }} HookRegistration
 */
/**
 * One loaded mod.
 *
 * @typedef {{ id: string, manifest: ModManifest, url: string, cleanup: (() => void)|undefined, active: boolean, activating?: boolean, definitionTransaction?: boolean }} ModEntry
 */
/**
 * The host surface returned by `createModHost`.
 *
 * @typedef {{
 *   api: ModApi,
 *   load: (url: string|URL) => Promise<{ id: string, version: string, name: string }>,
 *   dispose: () => void,
 *   command: (action: ModAction) => ModCommandResult,
 *   step: (seconds: number) => void,
 *   diagnostics: () => ModDiagnostics
 * }} ModHost
 */
/**
 * Detached host evidence from `diagnostics()`.
 *
 * @typedef {{
 *   modApi: string,
 *   mods: { id: string, name: string, version: string, apiVersion: string, url: string, hooks: number }[],
 *   hookCount: number,
 *   counts: { commands: number, committed: number, cancelled: number, modified: number, modSubmitted: number },
 *   errors: { modId: string, stage: string, message: string }[]
 * }} ModDiagnostics
 */

/**
 * Copies an action and its scalar moodle input map so hooks cannot mutate the pending command.
 *
 * @param {ModAction} action - Validated action.
 * @returns {ModAction} Detached copy.
 */
function detach(action) {
    return action.type === 'setMoodleInputs'
        ? { ...action, inputs: { ...action.inputs } }
        : { ...action };
}

/**
 * Copies strict JSON, refusing values JSON.stringify would silently discard.
 *
 * @param {unknown} value - Candidate JSON document or saved record.
 * @returns {import('../types/mod-api').ModJsonValue} Detached, validated JSON.
 */
function cloneJson(value) {
    const ancestors = new Set();

    /**
     * Visits data properties while tracking only the current ancestry for cycles.
     *
     * @param {unknown} candidate - Value to validate and detach.
     * @returns {import('../types/mod-api').ModJsonValue} Detached finite JSON.
     */
    function copy(candidate) {
        if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') {
            return candidate;
        }

        if (typeof candidate === 'number' && Number.isFinite(candidate)) {
            return candidate;
        }

        if (typeof candidate !== 'object' || candidate === null) {
            throw new TypeError('save data must contain only finite JSON values');
        }

        const array = Array.isArray(candidate);
        const prototype = Object.getPrototypeOf(candidate);

        if (!array && prototype !== Object.prototype && prototype !== null) {
            throw new TypeError('save data must use plain JSON objects');
        }

        if (ancestors.has(candidate)) {
            throw new TypeError('save data must not contain cycles');
        }

        ancestors.add(candidate);
        const descriptors = Object.getOwnPropertyDescriptors(candidate);
        const keys = Reflect.ownKeys(descriptors);

        if (keys.some((key) => typeof key !== 'string')) {
            throw new TypeError('save data must not contain symbol keys');
        }

        let result;

        if (array) {
            if (keys.length !== candidate.length + 1) {
                throw new TypeError('save arrays must be dense with no extra properties');
            }

            result = [];

            for (let index = 0; index < candidate.length; index += 1) {
                const descriptor = descriptors[index];

                if (!descriptor || !('value' in descriptor)) {
                    throw new TypeError('save arrays must not contain holes or accessors');
                }

                result.push(copy(descriptor.value));
            }
        } else {
            result = Object.fromEntries(keys.map((key) => {
                const descriptor = descriptors[key];

                if (!descriptor.enumerable || !('value' in descriptor)) {
                    throw new TypeError('save objects must contain enumerable data properties only');
                }

                return [key, copy(descriptor.value)];
            }));
        }

        ancestors.delete(candidate);

        return result;
    }

    const detached = copy(value);

    if (new TextEncoder().encode(JSON.stringify(detached)).byteLength > MAX_SAVE_BYTES) {
        throw new RangeError('save namespace exceeds 256 KiB');
    }

    return detached;
}

/**
 * Validates exact identities, never trimming or normalizing source names.
 *
 * @param {unknown} value - Candidate source identity.
 * @param {string} label - Boundary name used in errors.
 * @param {number} [max=Infinity] - Maximum permitted string length.
 * @returns {string} Unchanged nonempty identity.
 */
function identity(value, label, max = Infinity) {
    if (typeof value !== 'string' || value.length === 0 || value.length > max) {
        throw new TypeError(`${label} must be a nonempty string${max === Infinity ? '' : ` of at most ${max} characters`}`);
    }

    return value;
}

/**
 * Creates the mod host for one engine instance.
 *
 * Ownership: the host owns hook bookkeeping and the ordering in which mods are
 * unloaded; each mod owns its own effects and must undo them in the cleanup
 * function returned from `activate`. The engine keeps final authority: every
 * mutation still passes WASM validation, and WASM refuses invalid values
 * without changing state.
 *
 * @param {ModEngine} engine - Authoritative engine wrapper.
 * @param {Partial<import('../types/mod-api').ModHostOptions>} [options] - Synchronous detached namespace backing; omitted means per-host in-memory only.
 * @returns {ModHost} `api` is a host-owned handle (same surface mods get) for parity checks; `load` activates one module; `dispose` unloads every mod in reverse load order; `command` runs host input through hooks then commits once; `diagnostics` returns detached evidence.
 * @throws {TypeError} When the engine lacks `snapshot`, `command` or `setSpeed`.
 */
export function createModHost(engine, options = {}) {
    if (!engine || typeof engine.snapshot !== 'function' || typeof engine.command !== 'function' || typeof engine.setSpeed !== 'function') {
        throw new TypeError('createModHost requires an engine with snapshot(), command() and setSpeed().');
    }

    if ((options.readModState !== undefined || options.writeModState !== undefined)
        && (typeof options.readModState !== 'function' || typeof options.writeModState !== 'function')) {
        throw new TypeError('readModState and writeModState must both be synchronous functions.');
    }

    const saved = new Map();
    const readModState = options.readModState ?? ((id) => saved.get(id));
    const writeModState = options.writeModState ?? ((id, value) => {
        saved.set(id, value);
    });

    /** @type {Map<string, ModEntry>} */
    const mods = new Map();
    /** @type {HookRegistration[]} */
    const hooks = [];
    /** @type {{ modId: string, stage: string, message: string }[]} */
    const failures = [];
    const counts = { commands: 0, committed: 0, cancelled: 0, modified: 0, modSubmitted: 0 };
    let registrations = 0;
    let dispatching = false;
    let ticking = false;
    /** @type {ModEntry} Owner of the host-side `api` handle; always live while the host exists. */
    const hostEntry = { id: RESERVED_ID, manifest: { id: RESERVED_ID, version: '0.0.0', apiVersion: MOD_API_VERSION, name: 'host' }, url: '', cleanup: undefined, active: true };

    /**
     * Builds an attributed error; the same fields appear on every host failure.
     *
     * @param {string} modId - Module id, or the module URL before a manifest is read.
     * @param {string} stage - Lifecycle stage that failed.
     * @param {string} message - Human-readable reason.
     * @param {unknown} [cause] - Original failure.
     * @returns {Error} Error named `ModError` carrying `modId` and `stage`.
     */
    function modError(modId, stage, message, cause) {
        const failure = new Error(`${stage} failed for '${modId}': ${message}`);

        failure.name = 'ModError';
        /** @type {string} */
        failure.modId = modId;
        /** @type {string} */
        failure.stage = stage;

        if (cause !== undefined) {
            failure.cause = cause;
        }

        return failure;
    }

    /**
     * Records a failure against the module that caused it.
     *
     * @param {string} modId - Attributed module id or URL.
     * @param {string} stage - Lifecycle stage.
     * @param {unknown} cause - Failure to describe.
     * @returns {void}
     */
    function record(modId, stage, cause) {
        const message = cause instanceof Error ? cause.message : String(cause);

        failures.push({ modId, stage, message });

        if (failures.length > MAX_RECORDED_ERRORS) {
            failures.shift();
        }
    }

    /**
     * Records a failure and returns it, for failures the caller also receives.
     *
     * @param {string} modId - Attributed module id or URL.
     * @param {string} stage - Lifecycle stage.
     * @param {string} message - Human-readable reason.
     * @param {unknown} [cause] - Original failure.
     * @returns {Error} Attributed failure.
     */
    function fail(modId, stage, message, cause) {
        const failure = modError(modId, stage, message, cause);

        record(modId, stage, failure);

        return failure;
    }

    /**
     * Watches a value a mod returned where the contract is synchronous, so a
     * rejected promise is attributed instead of reaching the page or Node as an
     * unhandled rejection.
     *
     * @param {string} modId - Attributed module id.
     * @param {string} lateStage - Stage the late failure is recorded under.
     * @param {unknown} value - Returned value to watch.
     * @returns {void}
     */
    function observeRejection(modId, lateStage, value) {
        try {
            Promise.resolve(value).catch((cause) => {
                record(modId, lateStage, cause);
            });
        } catch (cause) {
            // A hostile `then` getter can throw while the value is adopted.
            record(modId, lateStage, cause);
        }
    }

    /**
     * Applies common failure attribution to optional engine and save boundaries.
     *
     * @template Result
     * @param {ModEntry} entry - Caller owning this boundary.
     * @param {string} stage - Attribution stage.
     * @param {() => Result} operation - Synchronous operation to execute.
     * @returns {Result} The operation's result.
     */
    function attributed(entry, stage, operation) {
        try {
            return operation();
        } catch (cause) {
            throw fail(entry.id, stage, cause instanceof Error ? cause.message : String(cause), cause);
        }
    }

    /**
     * Optional capabilities fail honestly; old engines keep their movement API.
     *
     * @template {keyof ModEngine} Name
     * @param {Name} name - Engine method to require.
     * @returns {NonNullable<ModEngine[Name]>} Engine-bound method retaining its capability signature.
     */
    function capability(name) {
        if (typeof engine[name] !== 'function') {
            throw new TypeError(`${name} is unsupported by this engine`);
        }

        return engine[name].bind(engine);
    }

    /**
     * Reads only this namespace, never enumerating or rewriting absent mods' data.
     *
     * @param {ModEntry} entry - Namespace owner.
     * @returns {import('../types/mod-api').ModSaveRecord|undefined} Validated detached record, or absence.
     */
    function readRecord(entry) {
        const record = readModState(entry.id);

        if (record === undefined) {
            return undefined;
        }

        if (record && typeof record.then === 'function') {
            observeRejection(entry.id, 'saveData.late', record);
            throw new TypeError('readModState must return a record synchronously');
        }

        const detached = cloneJson(record);

        if (!detached || !Number.isSafeInteger(detached.schemaVersion) || detached.schemaVersion < 1
            || !Object.hasOwn(detached, 'data')) {
            throw new TypeError('saved namespace must contain schemaVersion and data');
        }

        return detached;
    }

    /**
     * Validates and detaches the complete record before handing it to storage.
     *
     * @param {ModEntry} entry - Namespace owner.
     * @param {unknown} data - Candidate document.
     * @returns {void}
     */
    function writeRecord(entry, data) {
        const result = writeModState(entry.id, cloneJson({ schemaVersion: entry.manifest.saveSchemaVersion ?? 1, data }));

        if (result !== undefined && result !== null) {
            observeRejection(entry.id, 'saveData.late', result);
            throw new TypeError('writeModState must return nothing synchronously');
        }
    }

    /**
     * One registration book owns action hooks, import hooks and tick listeners.
     *
     * @param {ModEntry} entry - Registration owner.
     * @param {string} kind - Callback phase.
     * @param {BeforeActionHook|import('../types/mod-api').BeforeWorldImportHook|import('../types/mod-api').ModTickListener|import('../types/mod-api').ModCharacterDeathListener} callback - Synchronous mod callback.
     * @param {{priority?: number}} [options] - Optional finite priority.
     * @returns {() => boolean} Registration withdrawal.
     */
    function register(entry, kind, callback, options) {
        if (typeof callback !== 'function') {
            throw modError(entry.id, 'hooks', `${kind} requires a callback function`);
        }

        const priority = options?.priority ?? 0;

        if (typeof priority !== 'number' || !Number.isFinite(priority)) {
            throw modError(entry.id, 'hooks', 'priority must be a finite number');
        }

        const hook = { modId: entry.id, entry, kind, callback, priority, order: registrations };

        registrations += 1;
        hooks.push(hook);

        return () => withdraw(hook);
    }

    /**
     * Invokes a callback without allowing a failure to break later callbacks.
     *
     * @param {HookRegistration} hook - Live callback registration.
     * @param {object} payload - Detached callback input.
     * @param {boolean} cancellable - Whether false is a valid veto.
     * @returns {false|undefined} Veto or no contribution.
     */
    function notify(hook, payload, cancellable) {
        try {
            const result = hook.callback(payload);

            if (cancellable && result === false) {
                return false;
            }

            if (result !== undefined && result !== null) {
                observeRejection(hook.modId, `${hook.kind}.late`, result);
                throw new TypeError(`${hook.kind} must return ${cancellable ? 'false or ' : ''}nothing synchronously`);
            }
        } catch (cause) {
            record(hook.modId, hook.kind, cause);
        }

        return undefined;
    }

    /**
     * Validates fully, resolves detached precommit hooks, then imports once.
     *
     * @param {ModEntry} entry - Import submitter.
     * @param {number} cx - Integer cell x in [-100,100].
     * @param {number} cy - Integer cell y in [-100,100].
     * @param {Uint8Array|DataView} bytes - Complete cell format.
     * @returns {import('../types/mod-api').ModWorldImportResult} Veto or committed evidence.
     */
    function importNavigationCell(entry, cx, cy, bytes) {
        return attributed(entry, 'world', () => {
            if (dispatching) {
                throw new Error('cannot import navigation while precommit hooks are resolving');
            }

            const commit = capability('worldImportCell');

            for (const coordinate of [cx, cy]) {
                if (!Number.isInteger(coordinate) || coordinate < -100 || coordinate > 100) {
                    throw new RangeError('cell coordinates must be integers inside [-100, 100]');
                }
            }

            validateNavigationCell(bytes);
            const detached = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice();
            let cancelledBy;

            dispatching = true;
            try {
                for (const hook of orderedHooks('beforeWorldImport')) {
                    if (!hook.entry.active || !hooks.includes(hook)) {
                        continue;
                    }

                    if (notify(hook, { cx, cy, bytes: detached.slice() }, true) === false && cancelledBy === undefined) {
                        cancelledBy = hook.modId;
                    }
                }
            } finally {
                dispatching = false;
            }

            if (cancelledBy !== undefined) {
                return { committed: false, cancelled: true, submittedBy: entry.id, cancelledBy, snapshot: { ...engine.snapshot() } };
            }

            commit(cx, cy, detached);

            return { committed: true, cancelled: false, submittedBy: entry.id, snapshot: { ...engine.snapshot() } };
        });
    }

    /**
     * Emits only after one engine step has really committed; recursive steps fail.
     *
     * @param {number} seconds - Finite engine delta in (0,0.1].
     * @returns {void}
     */
    function step(seconds) {
        return attributed(hostEntry, 'tick', () => {
            if (dispatching || ticking) {
                throw new Error('cannot step while callbacks are resolving');
            }

            ticking = true;
            try {
                capability('step')(seconds);
                const snapshot = { ...engine.snapshot() };

                for (const hook of orderedHooks('onTick')) {
                    if (!hook.entry.active || !hooks.includes(hook)) {
                        continue;
                    }

                    notify(hook, { seconds, snapshot: { ...snapshot } }, false);
                }
            } finally {
                ticking = false;
            }
        });
    }

    /**
     * Validates a finite component, applying world bounds only to destinations.
     *
     * @param {unknown} value - Candidate value.
     * @param {string} label - Coordinate name for the message.
     * @param {string} modId - Attributed module id.
     * @param {boolean} bounded - True for destination coordinates, false for direction components.
     * @returns {number} The finite value in its command's numeric domain.
     */
    function coordinate(value, label, modId, bounded) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw modError(modId, 'action', `${label} must be a finite number`);
        }

        if (bounded) {
            let bounds;

            if (typeof engine.worldBounds === 'function') {
                try {
                    bounds = engine.worldBounds();
                } catch (cause) {
                    if (!(cause instanceof Error) || !cause.message.includes('unsupported')) {
                        throw cause;
                    }
                }
            }

            const axis = label === 'x' ? 'Cx' : 'Cy';
            const min = bounds?.active ? bounds[`min${axis}`] * 256 : WORLD_MIN;
            const max = bounds?.active ? (bounds[`max${axis}`] + 1) * 256 : WORLD_MAX;

            if (value < min || (bounds?.active ? value >= max : value > max)) {
                throw modError(modId, 'action', `${label} must be within the authoritative world bounds`);
            }
        }

        return value;
    }

    /**
     * Validates and normalises a command before it can reach the engine.
     *
     * @param {unknown} candidate - Candidate action.
     * @param {string} modId - Attributed module id ('host' for host input).
     * @returns {ModAction} Detached, validated action.
     */
    function validateAction(candidate, modId) {
        if (!candidate || typeof candidate !== 'object') {
            throw modError(modId, 'action', 'action must be an object with a type');
        }

        if (typeof candidate.type !== 'string' || !ACTION_TYPES.has(candidate.type)) {
            throw modError(modId, 'action', `unknown action type '${String(candidate.type)}'`);
        }

        if (candidate.type === 'cancel') {
            return { type: 'cancel' };
        }

        const type = candidate.type;
        /**
         * Validate an action's integral field before engine submission.
         *
         * @param {unknown} value - Candidate numeric field.
         * @param {string} label - Field name for attributed errors.
         * @param {number} min - Inclusive lower bound.
         * @param {number} max - Inclusive upper bound.
         * @returns {number} Validated integer.
         */
        const integer = (value, label, min, max) => {
            if (!Number.isInteger(value) || value < min || value > max) {
                throw modError(modId, 'action', `${label} must be an integer within [${min}, ${max}]`);
            }

            return value;
        };

        if (type === 'setCharacterStat' || type === 'setMoodleInputs') {
            const limits = capability('moodleInputLimits')();
            const inputs = type === 'setCharacterStat' ? { [identity(candidate.name, 'stat name')]: candidate.value } : candidate.inputs;

            if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
                throw modError(modId, 'action', 'moodle inputs must be an object');
            }

            const detached = {};

            for (const [name, value] of Object.entries(inputs)) {
                const limit = Object.hasOwn(limits, name) ? limits[name] : undefined;

                if (!limit || (limit.type === 'boolean'
                    ? typeof value !== 'boolean'
                    : !Number.isFinite(value) || value < limit.min || value > limit.max || (limit.integer && !Number.isInteger(value)))) {
                    throw modError(modId, 'action', `invalid authoritative moodle input '${name}'`);
                }

                Object.defineProperty(detached, name, { value, enumerable: true });
            }

            return type === 'setCharacterStat' ? { type, name: candidate.name, value: candidate.value } : { type, inputs: detached };
        }

        if (type === 'setHealth') {
            capability('getHealth');
            capability('isDead');
            const health = coordinate(candidate.health, 'health', modId, false);

            if (health < 0 || health > 100) {
                throw modError(modId, 'action', 'health must be within [0, 100]');
            }

            return { type, health };
        }

        if (type === 'moveTo' || type === 'walk') {
            const bounded = type === 'moveTo';

            return { type, x: coordinate(candidate.x, 'x', modId, bounded), y: coordinate(candidate.y, 'y', modId, bounded) };
        }

        capability('items');

        if (type === 'spawnItem') {
            const command = {
                type, fullType: identity(candidate.fullType, 'fullType'),
                x: coordinate(candidate.x, 'x', modId, false), y: coordinate(candidate.y, 'y', modId, false),
            };

            if (candidate.count !== undefined) {
                command.count = integer(candidate.count, 'count', 1, 0xFF_FF_FF_FF);
            }

            if (candidate.condition !== undefined) {
                command.condition = integer(candidate.condition, 'condition', 0, 0x7F_FF_FF_FF);
            }

            return command;
        }

        const id = integer(candidate.id, 'item id', 1, 0xFF_FF_FF_FF);

        if (type === 'drop') {
            return { type, id, x: coordinate(candidate.x, 'x', modId, false), y: coordinate(candidate.y, 'y', modId, false) };
        }

        if (type === 'setCondition') {
            return { type, id, condition: integer(candidate.condition, 'condition', 0, 0x7F_FF_FF_FF) };
        }

        return { type, id };
    }

    /**
     * Validates a speed against the engine's accepted range.
     *
     * @param {unknown} speed - Candidate speed in world units per second.
     * @param {string} modId - Attributed module id.
     * @returns {number} The accepted speed.
     */
    function validateSpeed(speed, modId) {
        if (typeof speed !== 'number' || !Number.isFinite(speed)) {
            throw modError(modId, 'movement', 'speed must be a finite number');
        }

        if (speed < MIN_SPEED || speed > MAX_SPEED) {
            throw modError(modId, 'movement', `speed must be within [${MIN_SPEED}, ${MAX_SPEED}] world units per second`);
        }

        return speed;
    }

    /**
     * Removes every hook belonging to one mod.
     *
     * @param {ModEntry} entry - Mod whose hooks are being withdrawn.
     * @returns {void}
     */
    function dropHooks(entry) {
        for (let index = hooks.length - 1; index >= 0; index -= 1) {
            if (hooks[index].entry === entry) {
                hooks.splice(index, 1);
            }
        }
    }

    /**
     * Withdraws this hook registration.
     *
     * @param {HookRegistration} hook - Registration to remove.
     * @returns {boolean} False when it was already withdrawn by unload.
     */
    const withdraw = (hook) => {
        const index = hooks.indexOf(hook);

        if (index === -1) {
            return false;
        }

        hooks.splice(index, 1);

        return true;
    };

    /**
     * Builds the handle one mod receives. Every method checks that the mod is
     * still loaded, so a handle captured before unload cannot mutate the engine.
     *
     * @param {ModEntry} entry - Owning mod.
     * @returns {ModApi} Frozen per-mod API.
     */
    function createHandle(entry) {
    /**
     * Asserts the owning mod is still loaded.
     *
     * @returns {void}
     * @throws {Error} Named `ModError` when the mod has been unloaded.
     */
        const alive = () => {
            if (!entry.active) {
                throw modError(entry.id, 'api', 'mod is unloaded; its API handle is inert');
            }
        };

        /**
         * Runs one live, attributed item/character/options boundary.
         *
         * @template Result
         * @param {string} stage - Failure attribution stage.
         * @param {() => Result} operation - Synchronous capability or namespace operation.
         * @returns {Result} Operation result after liveness and attribution checks.
         */
        const access = (stage, operation) => {
            alive();

            return attributed(entry, stage, operation);
        };

        /**
         * Sends every public mutation through the shared precommit action path.
         *
         * @param {ModAction} action - Structured mutation to validate and submit.
         * @returns {ModCommandResult} Attributed precommit outcome and committed state.
         */
        const mutate = (action) => {
            alive();

            return submitAction(action, entry.id);
        };

        /**
         * Read a schema-compatible document without losing unrelated fields.
         *
         * @returns {{[key: string]: import('../types/mod-api').ModJsonValue}} Detached namespace object.
         */
        const optionDocument = () => {
            const record = readRecord(entry);

            if (record && record.schemaVersion !== (entry.manifest.saveSchemaVersion ?? 1)) {
                throw new Error('saved schema does not match the active mod');
            }

            const document = record ? record.data : {};

            if (typeof document !== 'object' || document === null || Array.isArray(document)) {
                throw new TypeError('UI options require a saved object document');
            }

            if (Object.hasOwn(document, 'nativeUIOptions')
                && (typeof document.nativeUIOptions !== 'object' || document.nativeUIOptions === null || Array.isArray(document.nativeUIOptions))) {
                throw new TypeError('nativeUIOptions must be an object map');
            }

            return document;
        };

        const api = {
            version: MOD_API_VERSION,
            movement: {
                /**
                 * Reads a detached copy of the current engine state.
                 *
                 * @returns {ModSnapshot} Snapshot copy; mutating it cannot affect the engine.
                 * @throws {Error} Named `ModError` when the mod has been unloaded.
                 */
                getState() {
                    alive();

                    return engine.snapshot();
                },
                /**
                 * Sets the walking speed in world units per second; the host validates the
                 * value before the engine sees it, and an invalid speed changes nothing.
                 *
                 * @param {number} speed - Finite speed within [0.1, 10] world units per second.
                 * @returns {void}
                 * @throws {Error} Named `ModError` when the mod has been unloaded or the speed is rejected.
                 */
                setSpeed(speed) {
                    alive();
                    engine.setSpeed(validateSpeed(speed, entry.id));
                },
            },
            items: {
                definitions: {
                    /**
                     * Read detached metadata with authoritative numeric WASM fields.
                     *
                     * @returns {import('../types/mod-api').ModItemDefinition[]} Registered definitions in engine order.
                     */
                    list: () => access('items', () => capability('itemDefinitions')()),
                    /**
                     * Unknown qualified identities return null, never fabricated defaults.
                     *
                     * @param {string} fullType - Exact qualified definition identity.
                     * @returns {import('../types/mod-api').ModItemDefinition|null} Registered definition or absence.
                     */
                    get: (fullType) => access('items', () => {
                        identity(fullType, 'fullType');

                        return capability('itemDefinitions')().find((definition) => definition.fullType === fullType) ?? null;
                    }),
                    /**
                     * Registration is owner-bound and only legal inside synchronous activate.
                     *
                     * @param {import('../types/mod-api').ModItemDefinitionInput} input - Complete source metadata and numeric definition.
                     * @param {{override?: boolean}} [options={}] - Explicit replacement policy.
                     * @returns {import('../types/mod-api').ModItemDefinition} Resolved owner-bound definition.
                     */
                    register: (input, options = {}) => access('items', () => {
                        if (!entry.activating) {
                            throw new Error('item definitions can only be registered during synchronous activate');
                        }

                        if (!options || typeof options !== 'object' || Array.isArray(options)
                            || (options.override !== undefined && typeof options.override !== 'boolean')) {
                            throw new TypeError('registration options must contain a boolean override');
                        }

                        const override = options.override ?? false;
                        const registerDefinition = capability('registerItemDefinition');

                        if (!entry.definitionTransaction) {
                            capability('commitItemDefinitionRegistration');
                            capability('rollbackItemDefinitionRegistration');
                            capability('beginItemDefinitionRegistration')(entry.id);
                            entry.definitionTransaction = true;
                        }

                        return registerDefinition(input, { owner: entry.id, override });
                    }),
                },
                /**
                 * Read detached stable item records from WASM.
                 *
                 * @returns {import('../types/mod-api').ModItem[]} Authoritative item records.
                 */
                list: () => access('items', () => capability('items')()),
                /**
                 * Unknown valid ids return null.
                 *
                 * @param {number} id - Positive uint32 item identity.
                 * @returns {import('../types/mod-api').ModItem|null} Matching record or absence.
                 */
                get: (id) => access('items', () => {
                    if (!Number.isInteger(id) || id < 1 || id > 0xFF_FF_FF_FF) {
                        throw new RangeError('item id must be a positive uint32');
                    }

                    return capability('items')().find((item) => item.id === id) ?? null;
                }),
                /**
                 * Reads authoritative equipment at an exact body-location identity.
                 *
                 * @param {string} bodyLocation - Exact nonempty equipment slot.
                 * @returns {import('../types/mod-api').ModItem|null} Worn item or an empty slot.
                 */
                worn: (bodyLocation) => access('items', () => capability('wornItem')(identity(bodyLocation, 'bodyLocation'))),
                /**
                 * Omitted count/condition remain omitted until the authoritative engine defaults them.
                 *
                 * @param {import('../types/mod-api').ModItemSpawn} input - Qualified definition and finite spawn position, with optional count and condition.
                 * @returns {ModCommandResult} Attributed spawn outcome.
                 */
                spawn: (input) => mutate({ ...input, type: 'spawnItem' }),
                /**
                 * Picks up through precommit hooks.
                 *
                 * @param {number} id - Positive uint32 item identity.
                 * @returns {ModCommandResult} Attributed pickup outcome.
                 */
                pickup: (id) => mutate({ type: 'pickup', id }),
                /**
                 * Equips through precommit hooks.
                 *
                 * @param {number} id - Positive uint32 item identity.
                 * @returns {ModCommandResult} Attributed equip outcome.
                 */
                wear: (id) => mutate({ type: 'wear', id }),
                /**
                 * Unequips without deleting the item.
                 *
                 * @param {number} id - Positive uint32 item identity.
                 * @returns {ModCommandResult} Attributed unequip outcome.
                 */
                unequip: (id) => mutate({ type: 'unequip', id }),
                /**
                 * Drops at a finite position validated by the engine.
                 *
                 * @param {number} id - Positive uint32 item identity.
                 * @param {number} x - Finite world x coordinate.
                 * @param {number} y - Finite world y coordinate.
                 * @returns {ModCommandResult} Attributed drop outcome.
                 */
                drop: (id, x, y) => mutate({ type: 'drop', id, x, y }),
                /**
                 * Updates authoritative condition through precommit hooks.
                 *
                 * @param {number} id - Positive uint32 item identity.
                 * @param {number} condition - Nonnegative int32 condition, additionally checked against the definition by WASM.
                 * @returns {ModCommandResult} Attributed condition-update outcome.
                 */
                setCondition: (id, condition) => mutate({ type: 'setCondition', id, condition }),
            },
            character: {
                /**
                 * Read the real project health scalar, never a host shadow.
                 *
                 * @returns {number} Authoritative health within [0, 100].
                 */
                getHealth: () => access('character', () => capability('getHealth')()),
                /**
                 * Read authoritative death state.
                 *
                 * @returns {boolean} Whether the actor is dead.
                 */
                isDead: () => access('character', () => capability('isDead')()),
                /**
                 * Sets health only through the shared action path.
                 *
                 * @param {number} health - Finite health within [0, 100].
                 * @returns {ModCommandResult} Attributed health-update outcome.
                 */
                setHealth: (health) => mutate({ type: 'setHealth', health }),
                /**
                 * Require real ordered engine moodles without a neutral fallback.
                 *
                 * @returns {import('../types/mod-api').ModMoodle[]} Detached authoritative levels.
                 */
                moodles: () => access('character', () => structuredClone(capability('moodles')())),
                /**
                 * Read authoritative input values, detached from WASM.
                 *
                 * @returns {Record<string, number|boolean>} Character and explicitly modeled environmental inputs.
                 */
                moodleInputs: () => access('character', () => structuredClone(capability('saveMoodleState')().inputs)),
                /**
                 * Read authoritative input validation metadata.
                 *
                 * @returns {ReturnType<ModApi['character']['inputLimits']>} Detached numeric and boolean limits.
                 */
                inputLimits: () => access('character', () => structuredClone(capability('moodleInputLimits')())),
                /**
                 * Changes one source-backed character stat through precommit hooks.
                 *
                 * @param {string} name - Exact source-backed stat identity.
                 * @param {number} value - Finite stat value within authoritative limits.
                 * @returns {ModCommandResult} Attributed stat-update outcome.
                 */
                setStat: (name, value) => mutate({ type: 'setCharacterStat', name, value }),
                /**
                 * Atomically changes explicit character/environment inputs through precommit hooks.
                 *
                 * @param {Record<string, number|boolean>} inputs - Explicit authoritative input identities and accepted values.
                 * @returns {ModCommandResult} Attributed atomic input-update outcome.
                 */
                setMoodleInputs: (inputs) => mutate({ type: 'setMoodleInputs', inputs }),
            },
            ui: {
                /**
                 * Reads this mod's exact native options id, detached from backing storage.
                 *
                 * @param {string} modOptionsID - Exact nonempty native options id, at most 128 characters.
                 * @returns {import('../types/mod-api').ModJsonValue|undefined} Detached options or absence.
                 */
                readOptions: (modOptionsID) => access('ui', () => {
                    identity(modOptionsID, 'modOptionsID', 128);
                    const map = optionDocument().nativeUIOptions;

                    return map && Object.hasOwn(map, modOptionsID) ? map[modOptionsID] : undefined;
                }),
                /**
                 * Preserves the complete namespace, including nativePlayerData.
                 *
                 * @param {string} modOptionsID - Exact nonempty native options id, at most 128 characters.
                 * @param {import('../types/mod-api').ModJsonValue} values - Strict finite JSON options document.
                 * @returns {void} Replaces only this options entry in the complete saved namespace.
                 */
                writeOptions: (modOptionsID, values) => access('ui', () => {
                    identity(modOptionsID, 'modOptionsID', 128);
                    const document = optionDocument();
                    const map = document.nativeUIOptions ?? {};

                    Object.defineProperty(map, modOptionsID, {
                        value: cloneJson(values), enumerable: true, configurable: true, writable: true,
                    });
                    document.nativeUIOptions = map;
                    writeRecord(entry, document);
                }),
            },
            actions: {
                /**
                 * Submits a command through the same synchronous pipeline as host input:
                 * every live beforeAction hook resolves, then the engine commits once.
                 * Submitting while hooks are resolving is rejected.
                 *
                 * @param {ModAction} action - Structured command to submit.
                 * @returns {ModCommandResult} Outcome attributed to this mod, with the resulting engine state.
                 * @throws {Error} Named `ModError` for an unloaded handle, a malformed action, or a submission while hooks are resolving.
                 */
                submit(action) {
                    alive();

                    return submitAction(action, entry.id);
                },
            },
            world: {
                /**
                 * Reads authoritative committed navigation extents.
                 *
                 * @returns {import('../types/mod-api').ModWorldBounds} Detached cell bounds.
                 */
                getBounds() {
                    alive();

                    return attributed(entry, 'world', () => ({ ...capability('worldBounds')() }));
                },
                /**
                 * Reads authoritative navigation at an absolute tile.
                 *
                 * @param {number} tileX - Signed int32 tile x.
                 * @param {number} tileY - Signed int32 tile y.
                 * @returns {number} Navigation bits or unsigned unloaded sentinel.
                 */
                getNavFlags(tileX, tileY) {
                    alive();

                    return attributed(entry, 'world', () => capability('navFlags')(tileX, tileY));
                },
                /**
                 * Imports validated navigation after synchronous precommit veto hooks.
                 *
                 * @param {number} cx - Integer cell x in [-100,100].
                 * @param {number} cy - Integer cell y in [-100,100].
                 * @param {Uint8Array|DataView} bytes - Complete cell bytes.
                 * @returns {import('../types/mod-api').ModWorldImportResult} Detached import outcome.
                 */
                importNavigationCell(cx, cy, bytes) {
                    alive();

                    return importNavigationCell(entry, cx, cy, bytes);
                },
            },
            saveData: {
                /**
                 * Reads this mod id's detached saved document.
                 *
                 * @returns {import('../types/mod-api').ModJsonValue|undefined} Document or namespace absence.
                 */
                read() {
                    alive();

                    return attributed(entry, 'saveData', () => {
                        const record = readRecord(entry);

                        if (record && record.schemaVersion !== (entry.manifest.saveSchemaVersion ?? 1)) {
                            throw new Error('saved schema does not match the active mod');
                        }

                        return record?.data;
                    });
                },
                /**
                 * Replaces only this mod id's validated detached saved document.
                 *
                 * @param {import('../types/mod-api').ModJsonValue} value - Finite JSON document.
                 * @returns {void}
                 */
                write(value) {
                    alive();

                    return attributed(entry, 'saveData', () => {
                        const record = readRecord(entry);

                        if (record && record.schemaVersion !== (entry.manifest.saveSchemaVersion ?? 1)) {
                            throw new Error('saved schema does not match the active mod');
                        }

                        writeRecord(entry, value);
                    });
                },
            },
            events: {
                /**
                 * Registers a synchronous post-commit tick listener.
                 *
                 * @param {import('../types/mod-api').ModTickListener} callback - Listener receiving detached tick evidence.
                 * @param {{priority?: number}} [options] - Optional finite priority.
                 * @returns {() => boolean} Registration withdrawal.
                 */
                onTick(callback, options) {
                    alive();

                    return register(entry, 'onTick', callback, options);
                },
                /**
                 * Registers one synchronous, detached postcommit alive-to-dead listener.
                 *
                 * @param {import('../types/mod-api').ModCharacterDeathListener} callback - Listener receiving detached committed death evidence.
                 * @param {{priority?: number}} [options] - Optional finite priority.
                 * @returns {() => boolean} Registration withdrawal.
                 */
                onCharacterDeath(callback, options) {
                    alive();

                    return register(entry, 'onCharacterDeath', callback, options);
                },
            },
            hooks: {
                /**
                 * Registers a synchronous beforeAction hook that decides every non-cancel
                 * command before the engine commits. Returns an unsubscribe function.
                 *
                 * @param {BeforeActionHook} callback - Decides synchronously: nothing to keep the action, a replacement action, or `false` to cancel.
                 * @param {{ priority?: number }} [options] - Optional finite `priority`; lower runs first, ties break by registration order.
                 * @returns {() => boolean} True on the first withdrawal of the hook, false if unload already removed it.
                 * @throws {Error} Named `ModError` for an unloaded handle, a non-function callback, or a non-finite priority.
                 */
                beforeAction(callback, options) {
                    alive();

                    return register(entry, 'beforeAction', callback, options);
                },
                /**
                 * Registers a synchronous detached precommit navigation veto hook.
                 *
                 * @param {import('../types/mod-api').BeforeWorldImportHook} callback - Nothing to keep, false to veto.
                 * @param {{priority?: number}} [options] - Optional finite priority.
                 * @returns {() => boolean} Registration withdrawal.
                 */
                beforeWorldImport(callback, options) {
                    alive();

                    return register(entry, 'beforeWorldImport', callback, options);
                },
            },
        };

        Object.freeze(api.movement);
        Object.freeze(api.actions);
        Object.freeze(api.hooks);
        Object.freeze(api.world);
        Object.freeze(api.saveData);
        Object.freeze(api.events);
        Object.freeze(api.items.definitions);
        Object.freeze(api.items);
        Object.freeze(api.character);
        Object.freeze(api.ui);

        return Object.freeze(api);
    }

    /**
     * Hook dispatch order: ascending priority, then registration order. The order
     * never changes whether a command is cancelled, only which replacement wins.
     *
     * @param {string} kind - Callback phase to select.
     * @returns {HookRegistration[]} Hooks in dispatch order.
     */
    function orderedHooks(kind) {
        return hooks.filter((hook) => hook.kind === kind).sort((a, b) => a.priority - b.priority || a.order - b.order);
    }

    /**
     * Reverses a failed activation: withdraw the mod and its hooks, restore the
     * speed that was in effect before `activate` ran.
     *
     * @param {ModEntry} entry - Mod being rolled back.
     * @param {number} speedBefore - Speed captured before activation.
     * @param {unknown} cause - Reason activation failed.
     * @returns {never} Always throws an attributed failure.
     */
    function rollback(entry, speedBefore, cause) {
        entry.active = false;
        entry.activating = false;

        if (entry.definitionTransaction) {
            try {
                capability('rollbackItemDefinitionRegistration')(entry.id);
            } catch (restoreCause) {
                record(entry.id, 'activate', restoreCause);
            }

            entry.definitionTransaction = false;
        }

        mods.delete(entry.id);
        dropHooks(entry);

        if (engine.snapshot().speed !== speedBefore) {
            try {
                engine.setSpeed(speedBefore);
            } catch (restoreCause) {
                record(entry.id, 'activate', restoreCause);
            }
        }

        throw fail(entry.id, 'activate', cause instanceof Error ? cause.message : String(cause), cause);
    }

    /**
     * Loads, validates and activates one mod module.
     *
     * @param {string|URL} url - Importable module URL. M1 ships no local package
     * picker, mod manager, dependency resolution or package format beyond ordinary
     * ES module imports; the delivered app loads its bundled same-origin sample, and
     * the trusted loader performs no origin or sandbox check of its own.
     * @returns {Promise<{ id: string, version: string, name: string }>} The activated identity.
     * @throws {Error} Named `ModError` with `modId`/`stage` for import, manifest,
     * duplicate-id, api-version, export-shape or activation failures. A failed
     * activation leaves no hooks registered and leaves the speed as it was. An
     * `async activate` is refused the same way, and its rejection is recorded as
     * `activate.late` instead of reaching the page unhandled.
     */
    async function load(url) {
        const specifier = typeof url === 'string' ? url : url?.href;

        if (!specifier) {
            throw fail(RESERVED_ID, 'load', 'load requires a module URL string or URL');
        }

        let module;

        try {
            module = await import(specifier);
        } catch (cause) {
            throw fail(specifier, 'load', cause instanceof Error ? cause.message : String(cause), cause);
        }

        const manifest = module.manifest;

        if (!manifest || typeof manifest !== 'object') {
            throw fail(specifier, 'manifest', 'module must export manifest = { id, version, apiVersion, name }');
        }

        const { id, version, apiVersion, name } = /** @type {ModManifest} */ (manifest);

        if (typeof id !== 'string' || !MOD_ID_PATTERN.test(id)) {
            throw fail(specifier, 'manifest', `manifest.id must match ${MOD_ID_PATTERN}`);
        }

        if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
            throw fail(id, 'manifest', 'manifest.version must be dotted major.minor.patch');
        }

        if (apiVersion !== MOD_API_VERSION) {
            throw fail(id, 'manifest', `manifest.apiVersion must be '${MOD_API_VERSION}', got '${String(apiVersion)}'`);
        }

        if (typeof name !== 'string' || name.trim() === '') {
            throw fail(id, 'manifest', 'manifest.name must be a non-empty string');
        }

        if (id === RESERVED_ID) {
            throw fail(id, 'manifest', `'${RESERVED_ID}' is the host's internal attribution id and cannot be used as a mod id`);
        }

        if (mods.has(id)) {
            throw fail(id, 'manifest', 'a mod with this id is already loaded; dispose it first');
        }

        if (typeof module.activate !== 'function') {
            throw fail(id, 'manifest', 'module must export activate(api)');
        }

        const saveSchemaVersion = manifest.saveSchemaVersion ?? 1;

        if (!Number.isSafeInteger(saveSchemaVersion) || saveSchemaVersion < 1) {
            throw fail(id, 'manifest', 'manifest.saveSchemaVersion must be a positive safe integer');
        }

        /** @type {ModEntry} */
        const entry = { id, manifest: { id, version, apiVersion, name, saveSchemaVersion }, url: specifier, cleanup: undefined, active: true };

        attributed(entry, 'saveData', () => {
            const record = readRecord(entry);

            if (!record || record.schemaVersion === saveSchemaVersion) {
                return;
            }

            if (typeof module.migrateSaveData !== 'function') {
                throw new TypeError('saved schema is incompatible; export synchronous migrateSaveData(oldVersion, data)');
            }

            const migrated = module.migrateSaveData(record.schemaVersion, record.data);

            if (migrated && typeof migrated.then === 'function') {
                observeRejection(id, 'saveData.late', migrated);
                throw new TypeError('migrateSaveData must return JSON synchronously');
            }

            writeRecord(entry, migrated);
        });
        const speedBefore = engine.snapshot().speed;

        mods.set(id, entry);
        const api = createHandle(entry);

        let cleanup;

        entry.activating = true;
        try {
            cleanup = module.activate(api);

            if (cleanup !== undefined && cleanup !== null && typeof cleanup !== 'function') {
                observeRejection(entry.id, 'activate.late', cleanup);
                throw new Error('activate must return a synchronous cleanup function or nothing');
            }

            if (entry.definitionTransaction) {
                capability('commitItemDefinitionRegistration')(entry.id);
                entry.definitionTransaction = false;
            }
        } catch (cause) {
            rollback(entry, speedBefore, cause);
        } finally {
            entry.activating = false;
        }

        entry.cleanup = typeof cleanup === 'function' ? cleanup : undefined;

        return { id, version, name };
    }

    /**
     * Unloads every mod: cleanup runs in reverse load order while the mod's API
     * handle is still live (that is how a mod undoes its own effects), then its
     * handle becomes inert and its hooks are withdrawn. Cleanup is synchronous;
     * a cleanup that returns a value is reported and not awaited. A throwing
     * cleanup is attributed but never leaves the mod loaded; a cleanup that
     * returns a rejected promise is recorded as `cleanup.late`. The host stays
     * usable for further `load()` calls, and host-registered hooks are withdrawn.
     *
     * @returns {void}
     */
    function dispose() {
        for (const entry of [...mods.values()].reverse()) {
            let result;

            try {
                if (entry.cleanup) {
                    result = entry.cleanup();
                }
            } catch (cause) {
                record(entry.id, 'cleanup', cause);
            } finally {
                entry.active = false;
                mods.delete(entry.id);
                dropHooks(entry);
            }

            if (result !== undefined && result !== null) {
                record(entry.id, 'cleanup', new Error('cleanup must be synchronous; the returned value was ignored'));
                observeRejection(entry.id, 'cleanup.late', result);
            }
        }

        hooks.length = 0;
        registrations = 0;
    }

    /**
     * The single action path. Every page, accessible-UI and mod submission enters
     * here, so hooks always resolve before the engine state changes; no caller
     * reaches the engine around them.
     *
     * Ordering is deterministic: ascending `priority`, then registration order.
     * Every live hook sees the command; a hook withdrawn before its turn (by
     * another hook unsubscribing it, or by a `dispose()` inside a hook) does not
     * run. Cancellation wins over modification: a
     * `false` from any hook cancels the commit even if other hooks returned
     * replacements, and later hooks cannot overturn that veto. Explicit
     * cancellation (`{ type: 'cancel' }`, i.e. Stop/Escape/blur/pause) bypasses
     * hooks entirely — mods can never block the user's stop.
     *
     * @param {ModAction} action - Structured command.
     * @param {string} submitterId - `'host'` for page input, or the submitting mod's id.
     * @returns {ModCommandResult} Detached outcome: submitter, whether it
     * committed, who modified it, who cancelled it, and the resulting engine state.
     * @throws {Error} Named `ModError` attributed to the submitter for a malformed
     * action, or for a submission attempted while hooks are resolving (a hook
     * must return a replacement action or `false` instead of submitting). Hook
     * exceptions, rejected promises and invalid replacements are recorded, not thrown.
     */
    function submitAction(action, submitterId) {
        let submitted;

        try {
            submitted = validateAction(action, submitterId);
        } catch (cause) {
            if (cause?.name === 'ModError') {
                throw cause;
            }

            throw modError(submitterId, 'action', cause instanceof Error ? cause.message : String(cause), cause);
        }

        if (dispatching) {
            throw modError(submitterId, 'action', 'cannot submit an action while beforeAction hooks are resolving; return a replacement action or false from the hook instead');
        }

        counts.commands += 1;

        if (submitterId !== RESERVED_ID) {
            counts.modSubmitted += 1;
        }

        if (submitted.type === 'cancel') {
            const snapshot = engine.command(submitted);

            counts.committed += 1;

            return { committed: true, cancelled: false, submittedBy: submitterId, modifiedBy: [], snapshot };
        }

        let current = submitted;
        const modifiedBy = [];
        let cancelledBy;

        dispatching = true;
        try {
            for (const hook of orderedHooks('beforeAction')) {
                /* Another hook can withdraw this registration, or a `dispose()`
                   can withdraw every one of them, after this snapshot was taken. */
                if (!hook.entry.active || !hooks.includes(hook)) {
                    continue;
                }

                let result;

                try {
                    result = hook.callback(detach(current));
                } catch (cause) {
                    record(hook.modId, 'beforeAction', cause);
                    continue;
                }

                if (result === false) {
                    if (cancelledBy === undefined) {
                        cancelledBy = hook.modId;
                    }

                    continue;
                }

                if (result === undefined || result === null) {
                    continue;
                }

                let thenable;

                try {
                    thenable = typeof (/** @type {{ then?: unknown }} */ (result).then) === 'function';
                } catch (cause) {
                    // The getter is mod code, so it fails inside this hook's boundary.
                    record(hook.modId, 'beforeAction', cause);
                    continue;
                }

                if (thenable) {
                    record(hook.modId, 'beforeAction', new Error('beforeAction must decide synchronously; promises are rejected and cannot commit after the command'));
                    observeRejection(hook.modId, 'beforeAction.late', result);
                    continue;
                }

                try {
                    current = validateAction(result, hook.modId);
                    modifiedBy.push(hook.modId);
                } catch (cause) {
                    record(hook.modId, 'beforeAction', cause);
                }
            }
        } finally {
            dispatching = false;
        }

        if (cancelledBy !== undefined) {
            counts.cancelled += 1;

            return { committed: false, cancelled: true, submittedBy: submitterId, modifiedBy, cancelledBy, snapshot: engine.snapshot() };
        }

        const wasDead = current.type === 'setHealth' ? capability('isDead')() : engine.snapshot().dead;
        let snapshot;

        try {
            snapshot = engine.command(current);
        } catch (cause) {
            throw fail(submitterId, 'action', cause instanceof Error ? cause.message : String(cause), cause);
        }

        counts.committed += 1;

        if (modifiedBy.length > 0) {
            counts.modified += 1;
        }

        const dead = current.type === 'setHealth' ? capability('isDead')() : snapshot.dead;

        if (wasDead === false && dead === true) {
            for (const hook of orderedHooks('onCharacterDeath')) {
                if (hook.entry.active && hooks.includes(hook)) {
                    notify(hook, {
                        type: 'CharacterDeath', submittedBy: submitterId,
                        action: detach(current), snapshot: { ...snapshot },
                    }, false);
                }
            }
        }

        return { committed: true, cancelled: false, submittedBy: submitterId, modifiedBy, snapshot };
    }

    /**
     * Page-input entry into the shared action path.
     *
     * @param {ModAction} action - Structured command from browser or accessible UI input.
     * @returns {ModCommandResult} Outcome with `submittedBy: 'host'`.
     * @throws {Error} As for the shared action path.
     */
    function command(action) {
        return submitAction(action, RESERVED_ID);
    }

    /**
     * Detached host evidence for the HUD and for tests.
     *
     * @returns {ModDiagnostics} Current mods, hook count, command counters and the last attributed failures.
     */
    function diagnostics() {
        return {
            modApi: MOD_API_VERSION,
            mods: [...mods.values()].map((entry) => ({
                id: entry.id,
                name: entry.manifest.name,
                version: entry.manifest.version,
                apiVersion: entry.manifest.apiVersion,
                url: entry.url,
                hooks: hooks.reduce((total, hook) => total + (hook.entry === entry ? 1 : 0), 0),
            })),
            hookCount: hooks.length,
            counts: { ...counts },
            errors: failures.map((failure) => ({ ...failure })),
        };
    }

    const api = createHandle(hostEntry);

    return { api, load, dispose, command, step, diagnostics };
}

export { MOD_API_VERSION };
