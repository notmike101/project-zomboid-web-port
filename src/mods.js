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
 * World navigation, doors, item/health actions and postcommit callbacks expose
 * implemented engine behavior; optional audio is an owner-bound native presentation adapter.
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
const WORN_ACTION_TYPES = new Set(['wornSet', 'wornRemove', 'wornClear', 'wornGroupSet']);
const EQUIPMENT_ACTION_TYPES = new Set(['setHandItem', ...WORN_ACTION_TYPES]);
const ACTION_TYPES = new Set(['moveTo', 'walk', 'requestWalk', 'cancel', 'toggleDoor', 'spawnItem', 'pickup', 'transferItem', 'wear', 'unequip', 'drop', 'setCondition', 'setWeight', 'setActualWeight', ...EQUIPMENT_ACTION_TYPES, 'setHealth', 'setCharacterStat', 'setMoodleInputs', 'setBodyPart', 'setInjurySeverity']);
/** Reserved internal attribution id for page input; a mod cannot claim it. */
const RESERVED_ID = 'host';
const CORE_ID = 'pz-base-game';

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
 * @typedef {{ modId: string, entry: ModEntry, kind: string, callback: BeforeActionHook|import('../types/mod-api').BeforeWorldImportHook|import('../types/mod-api').ModTickListener|import('../types/mod-api').ModCharacterDeathListener|import('../types/mod-api').ModHandItemChangedListener, priority: number, order: number }} HookRegistration
 */
/**
 * One loaded mod.
 *
 * @typedef {{ id: string, manifest: ModManifest, url: string, cleanup: (() => void)|undefined, active: boolean, activating?: boolean, definitionTransaction?: boolean, audioGeneration?: number }} ModEntry
 */
/**
 * The host surface returned by `createModHost`.
 *
 * @typedef {{
 *   api: ModApi,
 *   coreApi: ModApi,
 *   load: (url: string|URL) => Promise<{ id: string, version: string, name: string }>,
 *   unload: (id: string) => void,
 *   dispose: () => void,
 *   command: (action: ModAction) => ModCommandResult,
 *   step: (seconds: number) => void,
 *   frameStep: (seconds: number) => void,
 *   sourcePreflight: (action: ModAction, ownerId: string) => ModAction|null,
 *   sourceSetHandItem: (slot: 'primary'|'secondary', itemId: number|null, ownerId: string) => ModCommandResult,
 *   diagnostics: () => ModDiagnostics
 * }} ModHost
 */
/**
 * Detached host evidence from `diagnostics()`.
 *
 * @typedef {{
 *   modApi: string,
 *   core: {id:string,active:boolean,hooks:number},
 *   mods: { id: string, name: string, version: string, apiVersion: string, url: string, hooks: number }[],
 *   hookCount: number,
 *   counts: { commands: number, committed: number, cancelled: number, modified: number, modSubmitted: number },
 *   errors: { modId: string, stage: string, message: string }[]
 * }} ModDiagnostics
 */

/**
 * Copies an action and its scalar input maps so hooks cannot mutate the pending command.
 *
 * @param {ModAction} action - Validated action.
 * @returns {ModAction} Detached copy.
 */
function detach(action) {
    if (action.type === 'setMoodleInputs') {
        return { ...action, inputs: { ...action.inputs } };
    }

    return action.type === 'setBodyPart' ? { ...action, values: { ...action.values } } : { ...action };
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
 * @param {Partial<import('../types/mod-api').ModHostOptions>} [options] - Detached namespace backing and an optional actual audio adapter; no context is created by this host.
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
    /** @type {ModEntry} Protected original-game owner, separate from installed user packages. */
    const coreEntry = {
        id: CORE_ID, manifest: {
            id: CORE_ID, version: '0.0.0', apiVersion: MOD_API_VERSION,
            name: 'Original game',
        }, url: '', cleanup: undefined, active: true,
    };

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
     * Requires the injected native presentation adapter, never a fake context.
     *
     * @template {keyof import('../types/mod-api').ModAudioAdapter} Name
     * @param {Name} name - Required adapter operation.
     * @returns {import('../types/mod-api').ModAudioAdapter[Name]} Bound adapter method.
     */
    function audioCapability(name) {
        if (typeof options.audio?.[name] !== 'function') {
            throw new TypeError(`audio.${name} is unsupported without an audio adapter`);
        }

        return options.audio[name].bind(options.audio);
    }

    /**
     * Cancels pending admission and releases only this owner's presentation resources.
     *
     * @param {ModEntry} entry - Owner being withdrawn.
     * @returns {void}
     */
    function releaseAudio(entry) {
        entry.audioGeneration = (entry.audioGeneration ?? 0) + 1;

        if (options.audio) {
            try {
                audioCapability('unloadOwner')(entry.id);
            } catch (cause) {
                record(entry.id, 'audio', cause);
            }
        }
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
     * @param {BeforeActionHook|import('../types/mod-api').BeforeWorldImportHook|import('../types/mod-api').ModTickListener|import('../types/mod-api').ModCharacterDeathListener|import('../types/mod-api').ModHandItemChangedListener} callback - Synchronous mod callback.
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

    const releaseHandObserver = engine.canSaveHandState?.()
        ? capability('observeHandItems')((event) => {
                for (const hook of orderedHooks('onHandItemChanged')) {
                    if (hook.entry.active && hooks.includes(hook)) {
                        notify(hook, { ...event }, false);
                    }
                }
            }, (cause) => record(CORE_ID, 'onHandItemChanged', cause))
        : undefined;

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
     * @param {number} seconds - Finite engine delta in [0,0.1], or raw RAF elapsed.
     * @param {'step'|'frameStep'} method - Explicit native clock entry point.
     * @returns {void}
     */
    function advance(seconds, method) {
        return attributed(hostEntry, 'tick', () => {
            if (dispatching || ticking) {
                throw new Error('cannot step while callbacks are resolving');
            }

            ticking = true;
            try {
                capability(method)(seconds);
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
     * Advance an explicit logical step through attributed tick hooks.
     *
     * @param {number} seconds - Explicit [0,.1] logical step.
     * @returns {void} Advances simulation and notifies live tick hooks.
     */
    function step(seconds) {
        return advance(seconds, 'step');
    }

    /**
     * Advance raw frame elapsed time through attributed tick hooks.
     *
     * @param {number} seconds - Raw nonnegative RAF elapsed.
     * @returns {void} Advances simulation and notifies live tick hooks.
     */
    function frameStep(seconds) {
        return advance(seconds, 'frameStep');
    }

    /**
     * Require the engine's real optional queued-action capability.
     *
     * @returns {import('../types/mod-api').ModQueuedActions} Real native queue.
     */
    function queueCapability() {
        if (!engine.actions) {
            throw new Error('actions are unsupported by this engine');
        }

        return engine.actions;
    }

    /**
     * Require the engine's real optional original-action timing capability.
     *
     * @returns {import('../types/mod-api').ModSourceTiming} Real native source timing.
     */
    function timingCapability() {
        if (!engine.sourceTiming) {
            throw new Error('source timing is unsupported by this engine');
        }

        return engine.sourceTiming;
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

        if (type === 'toggleDoor') {
            capability('doors');
            capability('toggleDoor');

            return { type, id: identity(candidate.id, 'door id', 256) };
        }

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

        if (type === 'requestWalk') {
            queueCapability();

            return {
                type, x: integer(candidate.x, 'x', -2_147_483_648, 2_147_483_647),
                y: integer(candidate.y, 'y', -2_147_483_648, 2_147_483_647),
                z: integer(candidate.z, 'z', -2_147_483_648, 2_147_483_647),
            };
        }

        if (type === 'setBodyPart' || type === 'setInjurySeverity') {
            const parts = capability('bodyParts')();
            const limits = capability('bodyPartInputLimits')();

            if (type === 'setInjurySeverity') {
                if (!['low', 'normal', 'high'].includes(candidate.severity)) {
                    throw modError(modId, 'action', 'injury severity must be low, normal or high');
                }

                return { type, severity: candidate.severity };
            }

            const part = identity(candidate.part, 'body part');

            if (!parts.some((value) => value.id === part)) {
                throw modError(modId, 'action', `unknown authoritative body part '${part}'`);
            }

            if (!candidate.values || typeof candidate.values !== 'object' || Array.isArray(candidate.values)) {
                throw modError(modId, 'action', 'body part values must be an object');
            }

            const values = {};

            for (const [name, value] of Object.entries(candidate.values)) {
                const limit = Object.hasOwn(limits, name) ? limits[name] : undefined;

                if (!limit || (limit.type === 'boolean'
                    ? typeof value !== 'boolean'
                    : typeof value !== 'number' || !Number.isFinite(value) || value < limit.min || value > limit.max || (limit.integer && !Number.isInteger(value)))) {
                    throw modError(modId, 'action', `invalid authoritative body part input '${name}'`);
                }

                Object.defineProperty(values, name, { value, enumerable: true });
            }

            if (Object.keys(values).length === 0) {
                throw modError(modId, 'action', 'body part values must contain at least one input');
            }

            return { type, part, values };
        }

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

        if (WORN_ACTION_TYPES.has(type)) {
            capability('equipmentOperation');

            if (type === 'wornSet') {
                return {
                    type, locationToken: integer(candidate.locationToken, 'body location token', 0, 0xFF_FF_FF_FF),
                    id: candidate.id === null ? null : integer(candidate.id, 'worn item ID', 0, 0xFF_FF_FF_FF),
                };
            }

            if (type === 'wornRemove') {
                return { type, id: integer(candidate.id, 'worn item ID', 0, 0xFF_FF_FF_FF) };
            }

            return type === 'wornGroupSet'
                ? { type, groupToken: integer(candidate.groupToken, 'body group token', 0, 0xFF_FF_FF_FF) }
                : { type: 'wornClear' };
        }

        capability('items');

        if (type === 'setHandItem') {
            capability('getHandItems');
            capability('setHandItem');

            if (candidate.slot !== 'primary' && candidate.slot !== 'secondary') {
                throw modError(modId, 'action', 'hand slot must be primary or secondary');
            }

            return {
                type, slot: candidate.slot,
                itemId: candidate.itemId === null ? null : integer(candidate.itemId, 'hand item ID', 1, 0xFF_FF_FF_FF),
            };
        }

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

        if (type === 'transferItem') {
            capability('getContainer');

            return {
                type, id,
                sourceContainerId: integer(candidate.sourceContainerId, 'source container ID', 1, 0xFF_FF_FF_FF),
                destinationContainerId: integer(candidate.destinationContainerId, 'destination container ID', 1, 0xFF_FF_FF_FF),
            };
        }

        if (type === 'drop') {
            return { type, id, x: coordinate(candidate.x, 'x', modId, false), y: coordinate(candidate.y, 'y', modId, false) };
        }

        if (type === 'setCondition') {
            return { type, id, condition: integer(candidate.condition, 'condition', 0, 0x7F_FF_FF_FF) };
        }

        if (type === 'setWeight' || type === 'setActualWeight') {
            capability('inventoryState');
            const field = type === 'setWeight' ? 'weight' : 'actualWeight';
            const value = candidate[field];

            if (!Number.isFinite(value) || value < 0 || value > 3.402_823_466_385_288_6e38) {
                throw modError(modId, 'action', `${field} must be a finite nonnegative native f32 weight`);
            }

            return type === 'setWeight' ? { type, id, weight: value } : { type, id, actualWeight: value };
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
         * Return immutable admission metadata from the shared action pipeline.
         *
         * @param {ModAction} action - Request routed through acceptance hooks.
         * @returns {import('../types/mod-api').ModQueueAcceptance} Accepted, never completed.
         */
        const queuedRequest = (action) => {
            const result = mutate(action);

            return Object.freeze({
                ...result,
                accepted: result.accepted ?? false, actionId: result.actionId ?? null,
                state: result.state ?? access('actions', () => queueCapability().getState()),
            });
        };

        /**
         * Binds local cues without permitting another registration namespace.
         *
         * @param {string} id - Exact bounded local or qualified identity.
         * @param {boolean} owned - Whether this operation registers/releases owned bytes.
         * @returns {string} Qualified identity.
         */
        const audioId = (id, owned) => {
            identity(id, 'audio id', 256);
            const qualified = id.includes(':') ? id : `${entry.id}:${id}`;

            if (owned && qualified.slice(0, qualified.indexOf(':')) !== entry.id) {
                throw new TypeError('audio registration must stay in the owning namespace');
            }

            return identity(qualified, 'qualified audio id', 256);
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
            equipment: {
                /**
                 * Keep native query returns while routing worn mutations through action hooks.
                 *
                 * @param {string} op - Native registry/query or worn mutation operation.
                 * @param {...unknown} args - Operation-specific native operands.
                 * @returns {number|string|boolean|{id: number, location: number}|null} Native query result, or zero even for vetoed worn writes.
                 */
                operation: (op, ...args) => {
                    alive();

                    if (typeof op !== 'string') {
                        return access('equipment', () => {
                            throw new TypeError('equipment operation must be a string');
                        });
                    }

                    if (!WORN_ACTION_TYPES.has(op)) {
                        return access('equipment', () => capability('equipmentOperation')(op, ...args));
                    }

                    let arity = 1;
                    let action;

                    switch (op) {
                        case 'wornSet': {
                            arity = 2;
                            action = { type: op, locationToken: args[0], id: args[1] };

                            break;
                        }
                        case 'wornRemove': {
                            action = { type: op, id: args[0] };

                            break;
                        }
                        case 'wornGroupSet': {
                            action = { type: op, groupToken: args[0] };

                            break;
                        }

                        default: {
                            arity = 0;
                            action = { type: op };
                        }
                    }

                    if (args.length !== arity) {
                        throw modError(entry.id, 'action', `${op} requires ${arity} arguments`);
                    }

                    mutate(action);

                    // Original Lua callers require native status semantics, including a vetoed no-op.
                    return 0;
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

                    return capability('getItem')(id);
                }),
                /**
                 * Read native container and item graph records through the attributed items capability.
                 *
                 * @returns {import('../types/mod-api').ModContainer[]} Detached native-ordered containers.
                 */
                containers: () => access('items', () => capability('containers')()),
                /**
                 * Read one native container by stable identity.
                 *
                 * @param {number} id - Positive uint32 container identity.
                 * @returns {import('../types/mod-api').ModContainer|null} Detached record or absence.
                 */
                getContainer: (id) => access('items', () => capability('getContainer')(id)),
                /**
                 * Read direct item membership in native order.
                 *
                 * @param {number} id - Positive uint32 container identity.
                 * @returns {import('../types/mod-api').ModItem[]} Detached direct member records.
                 */
                containerItems: (id) => access('items', () => capability('containerItems')(id)),
                /**
                 * Read the actual native actor-root inventory identity.
                 *
                 * @returns {number} Player inventory container ID.
                 */
                playerInventoryId: () => access('items', () => capability('playerInventoryId')()),
                /**
                 * Read actor-relative admission and capacity state.
                 *
                 * @param {number} id - Positive uint32 container identity.
                 * @param {number|null} [actorId=null] - Optional native actor identity.
                 * @returns {import('../types/mod-api').ModContainerState} Detached capacity and weight state.
                 */
                containerState: (id, actorId = null) => access('items', () => capability('containerState')(id, actorId)),
                /**
                 * Read source-authoritative weight variants for an item.
                 *
                 * @param {number} id - Positive uint32 item identity.
                 * @returns {import('../types/mod-api').ModItemWeights} Detached item weight values.
                 */
                itemWeights: (id) => access('items', () => capability('itemWeights')(id)),
                /**
                 * Reads authoritative equipment at an exact body-location identity.
                 *
                 * @param {string} bodyLocation - Exact nonempty equipment slot.
                 * @returns {import('../types/mod-api').ModItem|null} Worn item or an empty slot.
                 */
                worn: (bodyLocation) => access('items', () => capability('wornItem')(identity(bodyLocation, 'bodyLocation'))),
                /**
                 * Read authoritative ordered worn references.
                 *
                 * @returns {import('../types/mod-api').ModWornItem[]} Detached native worn order.
                 */
                wornItems: () => access('items', () => capability('wornItems')()),
                /**
                 * Set or clear an exact body-location slot through precommit hooks.
                 *
                 * @param {string} bodyLocation - Registered canonical name or alias.
                 * @param {number|null} id - Native item identity, or null to clear.
                 * @returns {void}
                 */
                setWornItem: (bodyLocation, id) => {
                    const locationToken = access('items', () => {
                        const token = capability('equipmentOperation')('lookup', identity(bodyLocation, 'bodyLocation'));

                        if (token === null) {
                            throw new RangeError(`Unknown bodyLocation: ${bodyLocation}`);
                        }

                        return token;
                    });

                    mutate({ type: 'wornSet', locationToken, id });
                },
                /**
                 * Read detached numeric current-player carry state from the engine.
                 *
                 * @returns {import('../types/mod-api').ModInventoryState} Native carry load, effective capacity and stored maxWeight.
                 */
                inventoryState: () => access('items', () => {
                    const state = capability('inventoryState')();

                    if (!state || typeof state.capacityWeight !== 'number' || Number.isNaN(state.capacityWeight) || state.capacityWeight < 0
                        || !Number.isFinite(state.capacity) || state.capacity < 0 || !Number.isFinite(state.maxWeight) || state.maxWeight < 0) {
                        throw new TypeError('authoritative numeric inventory state is unsupported by this engine');
                    }

                    return { ...state };
                }),
                /**
                 * Omitted count/condition remain omitted until the authoritative engine defaults them.
                 *
                 * @param {import('../types/mod-api').ModItemSpawn} input - Qualified definition and finite spawn position, with optional count and condition.
                 * @returns {ModCommandResult} Attributed spawn outcome.
                 */
                spawn: (input) => mutate({ ...input, type: 'spawnItem' }),
                /**
                 * Requests source-timed pickup through acceptance hooks.
                 *
                 * @param {number} id - Positive uint32 item identity.
                 * @returns {import('../types/mod-api').ModQueueAcceptance} Immutable acceptance, not transfer completion.
                 */
                pickup: (id) => queuedRequest({ type: 'pickup', id }),
                /**
                 * Request an attributed item transfer; native completion occurs asynchronously.
                 *
                 * @param {import('../types/mod-api').ModItemTransfer} input - Item and source/destination container identities.
                 * @returns {import('../types/mod-api').ModQueueAcceptance} Queued acceptance, not completion.
                 */
                transferItem: (input) => queuedRequest({ ...input, type: 'transferItem' }),
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
                /**
                 * Update only the live base weight through precommit hooks.
                 *
                 * @param {number} id - Positive uint32 item identity.
                 * @param {number} weight - Finite nonnegative weight representable by native f32.
                 * @returns {ModCommandResult} Attributed base-weight update.
                 */
                setWeight: (id, weight) => mutate({ type: 'setWeight', id, weight }),
                /**
                 * Update only the live actual weight used by native carry accounting.
                 *
                 * @param {number} id - Positive uint32 item identity.
                 * @param {number} actualWeight - Finite nonnegative weight representable by native f32.
                 * @returns {ModCommandResult} Attributed actual-weight update.
                 */
                setActualWeight: (id, actualWeight) => mutate({ type: 'setActualWeight', id, actualWeight }),
            },
            character: {
                /**
                 * Reads actual native stable held references.
                 *
                 * @returns {import('../types/mod-api').ModHandItems} Current held pair.
                 */
                getHandItems: () => access('character', () => capability('getHandItems')()),
                /**
                 * Commits one held slot through shared attributed precommit hooks.
                 *
                 * @param {'primary'|'secondary'} slot - Exact held slot.
                 * @param {number|null} itemId - Full uint32 live inventory identity, or clear.
                 * @returns {ModCommandResult} Shared attributed precommit outcome.
                 */
                setHandItem: (slot, itemId) => mutate({ type: 'setHandItem', slot, itemId }),
                /**
                 * Read an original action-timing trait from native state.
                 *
                 * @param {string} id - Supported original trait identity.
                 * @returns {boolean} Whether the native trait is enabled.
                 */
                hasTrait: (id) => access('character', () => timingCapability().hasTrait(id)),
                /**
                 * Set an original action-timing trait in native state.
                 *
                 * @param {string} id - Supported original trait identity.
                 * @param {boolean} enabled - Requested trait state.
                 * @returns {void} Updates the real native trait.
                 */
                setTrait: (id, enabled) => access('character', () => timingCapability().setTrait(id, enabled)),
                /**
                 * Query actual native handwear, never detached metadata or a player shadow flag.
                 *
                 * @returns {boolean} Whether the live hands item has the native awkward-gloves tag.
                 */
                isWearingAwkwardGloves: () => access('character', () => capability('isWearingAwkwardGloves')()),
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
                /**
                 * Read real native parts, including uncapped derived pain, detached from the engine.
                 *
                 * @returns {import('../types/mod-api').ModBodyPart[]} Canonical live body state.
                 */
                bodyParts: () => access('character', () => structuredClone(capability('bodyParts')())),
                /**
                 * Read native full-precision ingress limits; no host anatomy or default synthesis.
                 *
                 * @returns {import('../types/mod-api').ModBodyPartInputLimits} Detached validation metadata.
                 */
                bodyPartInputLimits: () => access('character', () => structuredClone(capability('bodyPartInputLimits')())),
                /**
                 * Read the real native cold-node factor; arithmetic may overflow to Infinity.
                 *
                 * @returns {number} Native thermal action multiplier.
                 */
                thermalActionModifier: () => access('character', () => capability('thermalActionModifier')()),
                /**
                 * Atomically update mutable injury or skin-temperature fields through shared hooks.
                 *
                 * @param {import('../types/mod-api').ModBodyPartId} part - Canonical body part identity.
                 * @param {Partial<import('../types/mod-api').ModBodyPartValues>} values - Explicit mutable values.
                 * @returns {ModCommandResult} Attributed update outcome.
                 */
                setBodyPart: (part, values) => mutate({ type: 'setBodyPart', part, values }),
                /**
                 * Update the native source pain severity through the shared action pipeline.
                 *
                 * @param {import('../types/mod-api').ModInjurySeverity} severity - Source severity name.
                 * @returns {ModCommandResult} Attributed update outcome.
                 */
                setInjurySeverity: (severity) => mutate({ type: 'setInjurySeverity', severity }),
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
            time: {
                /**
                 * Read the original action timing state from the engine.
                 *
                 * @returns {import('../types/mod-api').ModSourceTimingState} Detached native timing state.
                 */
                getState: () => access('time', () => timingCapability().getState()),
                /**
                 * Update a supported original action timing field.
                 *
                 * @param {import('../types/mod-api').ModTimingField} field - Native timing field to update.
                 * @param {number|boolean} value - Field-appropriate native timing value.
                 * @returns {void} Updates native timing.
                 */
                set: (field, value) => access('time', () => timingCapability().set(field, value)),
                /**
                 * Read the native original-action game mode.
                 *
                 * @returns {string} Current native mode identity.
                 */
                getGameMode: () => access('time', () => timingCapability().getGameMode()),
                /**
                 * Set the native original-action game mode.
                 *
                 * @param {string} mode - Supported native mode identity.
                 * @returns {void} Updates the native game mode.
                 */
                setGameMode: (mode) => access('time', () => timingCapability().setGameMode(mode)),
            },
            audio: {
                /**
                 * Async decode consumes the original buffer; no unnecessary source-byte clone.
                 * Forbidden during activation, which must remain synchronous and rollback-safe.
                 *
                 * @param {string} id - Owned local or qualified cue identity.
                 * @param {ArrayBuffer} bytes - Nonempty encoded bytes; native adapter enforces byte budgets.
                 * @param {{override?: boolean}} [loadOptions={}] - Explicit same-owner replacement policy.
                 * @returns {Promise<import('../types/mod-api').ModAudioAsset>} Actual decoded metadata.
                 */
                async load(id, bytes, loadOptions = {}) {
                    alive();
                    try {
                        if (entry.activating) {
                            throw new Error('audio loading is forbidden during synchronous activate');
                        }

                        if (!loadOptions || typeof loadOptions !== 'object' || Array.isArray(loadOptions)
                            || (loadOptions.override !== undefined && typeof loadOptions.override !== 'boolean')) {
                            throw new TypeError('audio load options must contain a boolean override');
                        }

                        const qualified = audioId(id, true);
                        const loadAudio = audioCapability('load');

                        audioCapability('unloadOwner');
                        const generation = entry.audioGeneration ?? 0;
                        const asset = await loadAudio(qualified, bytes, { owner: entry.id, override: loadOptions.override ?? false });

                        if (!entry.active || generation !== (entry.audioGeneration ?? 0)) {
                            throw new Error('audio load completed after owner cleanup');
                        }

                        return asset;
                    } catch (cause) {
                        throw fail(entry.id, 'audio', cause instanceof Error ? cause.message : String(cause), cause);
                    }
                },
                /**
                 * Plays a real registered cue with this mod owning the returned voice.
                 *
                 * @param {string} id - Local cue or a qualified shared cue, including base cues.
                 * @param {import('../types/mod-api').ModAudioPosition} [playOptions={}] - Finite world position and native gain/loop options.
                 * @returns {import('../types/mod-api').ModAudioVoice} Stoppable native voice.
                 */
                play: (id, playOptions = {}) => access('audio', () => {
                    if (entry.activating) {
                        throw new Error('audio playback is forbidden during synchronous activate');
                    }

                    if (!playOptions || typeof playOptions !== 'object' || Array.isArray(playOptions)) {
                        throw new TypeError('audio play options must be an object');
                    }

                    const qualified = audioId(id, false);

                    audioCapability('unloadOwner');

                    return audioCapability('play')(qualified, {
                        x: playOptions.x, y: playOptions.y, z: playOptions.z,
                        volume: playOptions.volume, loop: playOptions.loop, owner: entry.id,
                    });
                }),
                /**
                 * Releases only an owned registration; cannot claim base/foreign bytes.
                 *
                 * @param {string} id - Owned local or qualified identity.
                 * @returns {boolean} Whether a loaded/pending registration was removed.
                 */
                unload: (id) => access('audio', () => {
                    const qualified = audioId(id, true);

                    return audioCapability('unload')(qualified, { owner: entry.id });
                }),
            },
            actions: {
                /**
                 * Read the real native queued-action state.
                 *
                 * @returns {import('../types/mod-api').ModQueueState} Detached current and pending actions.
                 */
                getState: () => access('actions', () => queueCapability().getState()),
                /**
                 * Request a pickup through owner-attributed acceptance hooks.
                 *
                 * @param {number} id - Positive uint32 ground-item identity.
                 * @returns {import('../types/mod-api').ModQueueAcceptance} Admission metadata, not pickup completion.
                 */
                requestPickup: (id) => queuedRequest({ type: 'pickup', id }),
                /**
                 * Request an attributed transfer through permission and precommit hooks.
                 *
                 * @param {number} id - Positive uint32 item identity.
                 * @param {number} sourceContainerId - Positive uint32 current owner container.
                 * @param {number} destinationContainerId - Positive uint32 destination container.
                 * @returns {import('../types/mod-api').ModQueueAcceptance} Queued acceptance, not transfer completion.
                 */
                requestTransfer: (id, sourceContainerId, destinationContainerId) =>
                    queuedRequest({ type: 'transferItem', id, sourceContainerId, destinationContainerId }),
                /**
                 * Request a door toggle through owner-attributed acceptance hooks.
                 *
                 * @param {string} id - Stable native door identity.
                 * @returns {import('../types/mod-api').ModQueueAcceptance} Admission metadata, not toggle completion.
                 */
                requestDoor: (id) => queuedRequest({ type: 'toggleDoor', id }),
                /**
                 * Request a walk through owner-attributed acceptance hooks.
                 *
                 * @param {import('../types/mod-api').ModWorldCoordinates} target - Finite world destination.
                 * @returns {import('../types/mod-api').ModQueueAcceptance} Admission metadata, not movement completion.
                 */
                requestWalk: (target) => queuedRequest({ ...target, type: 'requestWalk' }),
                /**
                 * Cancel native queued work through the attributed action pipeline.
                 *
                 * @returns {import('../types/mod-api').ModQueueState} Native state after successful cancellation.
                 */
                cancel: () => {
                    access('actions', () => queueCapability().getState());
                    mutate({ type: 'cancel' });

                    return access('actions', () => queueCapability().getState());
                },
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
                 * Reads detached actual door rows, including during activation.
                 *
                 * @returns {import('../types/mod-api').ModDoor[]} Native current state, coordinates and revision.
                 */
                getDoors: () => access('world', () => capability('doors')().map((door) => ({ ...door }))),
                /**
                 * Reads current source-square metadata, not navigation approximations.
                 *
                 * @param {number} x - Signed int32 tile x.
                 * @param {number} y - Signed int32 tile y.
                 * @param {number} z - Signed int32 elevation.
                 * @returns {import('../types/mod-api').ModWorldSquare|null} Detached facts, or null for absent metadata.
                 */
                getSquare: (x, y, z) => access('world', () => {
                    const square = capability('getSquare')(x, y, z);

                    return square === null ? null : { ...square };
                }),
                /**
                 * Reads the native directional source relation, including genuine null semantics.
                 *
                 * @param {import('../types/mod-api').ModWorldCoordinates} from - Calling source square.
                 * @param {import('../types/mod-api').ModWorldCoordinates|null} to - Other square or null.
                 * @returns {boolean} Actual current wall/window/door/stair blockage.
                 */
                isBlockedTo: (from, to) => access('world', () => capability('isBlockedTo')(from, to)),
                /**
                 * Requests a source-timed door action through shared acceptance hooks.
                 *
                 * @param {string} id - Exact nonempty stable identity, at most 256 characters.
                 * @returns {import('../types/mod-api').ModQueueAcceptance} False acceptance on veto; successful request completes on a later frame.
                 * @throws {Error} ModError/action for unsupported, invalid, activation or reentrant mutation.
                 */
                toggleDoor: (id) => queuedRequest({ type: 'toggleDoor', id }),
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
                /**
                 * Registers an actual committed held-transition listener.
                 *
                 * @param {import('../types/mod-api').ModHandItemChangedListener} callback - Committed-transition listener.
                 * @param {{priority?:number}} [options] - Listener ordering.
                 * @returns {()=>boolean} Registration withdrawal.
                 */
                onHandItemChanged(callback, options) {
                    alive();

                    return register(entry, 'onHandItemChanged', callback, options);
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
        Object.freeze(api.equipment);
        Object.freeze(api.items.definitions);
        Object.freeze(api.items);
        Object.freeze(api.character);
        Object.freeze(api.ui);
        Object.freeze(api.audio);

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
        releaseAudio(entry);

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

        if (id === RESERVED_ID || id === 'base' || id === CORE_ID) {
            throw fail(id, 'manifest', `'${id}' is a reserved host/source owner and cannot be used as a mod id`);
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
     * Unloads one user package while its cleanup retains a live owned handle.
     * The protected original-game owner is disposed only with the session.
     *
     * @param {string} id - Loaded user package identity.
     * @returns {void}
     */
    function unload(id) {
        if (id === CORE_ID || id === RESERVED_ID) {
            throw modError(id, 'api', 'protected session owners cannot be unloaded as user mods');
        }

        const entry = mods.get(id);

        if (!entry) {
            throw modError(id, 'api', 'mod is not loaded');
        }

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
            releaseAudio(entry);
        }

        if (result !== undefined && result !== null) {
            record(entry.id, 'cleanup', new Error('cleanup must be synchronous; the returned value was ignored'));
            observeRejection(entry.id, 'cleanup.late', result);
        }
    }

    /** Dispose user packages and the protected original owner with this session. */
    function dispose() {
        for (const entry of [...mods.values()].reverse()) {
            if (mods.has(entry.id)) {
                unload(entry.id);
            }
        }

        hooks.length = 0;
        releaseHandObserver?.();
        registrations = 0;
        releaseAudio(hostEntry);
        coreEntry.active = false;
        releaseAudio(coreEntry);
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
     * @param {boolean} [commit=true] - False only for private original context admission.
     * @returns {ModCommandResult & {action?: ModAction}} Detached outcome: submitter, whether it
     * committed, who modified it, who cancelled it, and the resulting engine state.
     * @throws {Error} Named `ModError` attributed to the submitter for a malformed
     * action, or for a submission attempted while hooks are resolving (a hook
     * must return a replacement action or `false` instead of submitting). Hook
     * exceptions, rejected promises and invalid replacements are recorded, not thrown.
     */
    function submitAction(action, submitterId, commit = true) {
        let submitted;

        try {
            submitted = validateAction(action, submitterId);
        } catch (cause) {
            if (cause?.name === 'ModError') {
                throw cause;
            }

            throw modError(submitterId, 'action', cause instanceof Error ? cause.message : String(cause), cause);
        }

        if ((submitted.type === 'toggleDoor' || EQUIPMENT_ACTION_TYPES.has(submitted.type)) && mods.get(submitterId)?.activating) {
            throw modError(submitterId, 'action', 'equipment and door mutation is forbidden during synchronous activate');
        }

        if (dispatching) {
            throw modError(submitterId, 'action', 'cannot submit an action while beforeAction hooks are resolving; return a replacement action or false from the hook instead');
        }

        counts.commands += 1;

        if (submitterId !== RESERVED_ID && submitterId !== CORE_ID) {
            counts.modSubmitted += 1;
        }

        if (submitted.type === 'cancel') {
            let snapshot;

            try {
                snapshot = engine.command(submitted);
            } catch (cause) {
                throw fail(submitterId, 'action', cause instanceof Error ? cause.message : String(cause), cause);
            }

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

        if ((EQUIPMENT_ACTION_TYPES.has(submitted.type) || EQUIPMENT_ACTION_TYPES.has(current.type)) && submitterId !== RESERVED_ID
            && !(submitterId === CORE_ID ? coreEntry : mods.get(submitterId))?.active) {
            throw modError(submitterId, 'api', 'equipment owner became inactive during hooks');
        }

        if (cancelledBy !== undefined) {
            counts.cancelled += 1;

            return { committed: false, cancelled: true, submittedBy: submitterId, modifiedBy, cancelledBy, snapshot: engine.snapshot() };
        }

        if (!commit) {
            return {
                committed: false, cancelled: false, submittedBy: submitterId,
                modifiedBy, snapshot: engine.snapshot(), action: detach(current),
            };
        }

        if ((current.type === 'toggleDoor' || EQUIPMENT_ACTION_TYPES.has(current.type)) && mods.get(submitterId)?.activating) {
            throw modError(submitterId, 'action', 'equipment and door mutation is forbidden during synchronous activate');
        }

        const wasDead = current.type === 'setHealth' ? capability('isDead')() : engine.snapshot().dead;
        let snapshot;
        let admission;

        try {
            const result = engine.command(current);

            if ('accepted' in result) {
                admission = result;
                snapshot = engine.snapshot();
            } else {
                snapshot = result;
            }
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

        return {
            committed: admission === undefined, cancelled: false, submittedBy: submitterId,
            modifiedBy, snapshot, ...(admission ?? {}),
        };
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
            core: {
                id: CORE_ID, active: coreEntry.active,
                hooks: hooks.filter((hook) => hook.entry === coreEntry).length,
            },
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

    /**
     * Resolve one owner-bound original context request without enqueueing SDK work.
     *
     * @param {ModAction} action - Actual stable source context target.
     * @param {string} ownerId - Stable active SDK package identity.
     * @returns {ModAction|null} Hook-selected request or veto.
     */
    function sourcePreflight(action, ownerId) {
        const entry = ownerId === CORE_ID ? coreEntry : mods.get(ownerId);

        if (!entry?.active) {
            throw modError(ownerId, 'api', 'source context owner is not active');
        }

        if (action.type !== 'pickup' && action.type !== 'toggleDoor') {
            throw modError(ownerId, 'action', 'unsupported source context request');
        }

        const result = submitAction(action, ownerId, false);

        if (!entry.active) {
            throw modError(ownerId, 'api', 'source context owner became inactive during hooks');
        }

        return result.cancelled ? null : result.action;
    }

    /**
     * Commits a source-owned held mutation through the shared SDK hooks.
     *
     * @param {'primary'|'secondary'} slot - Actual held slot.
     * @param {number|null} itemId - Stable inventory ID or clear.
     * @param {string} ownerId - Live original-source owner.
     * @returns {ModCommandResult} Same SDK mutation/hooks and real committed notifications.
     */
    function sourceSetHandItem(slot, itemId, ownerId) {
        const entry = ownerId === CORE_ID ? coreEntry : mods.get(ownerId);

        if (!entry?.active) {
            throw modError(ownerId, 'api', 'source equipment owner is not active');
        }

        return submitAction({ type: 'setHandItem', slot, itemId }, ownerId);
    }

    const coreApi = createHandle(coreEntry);
    const api = createHandle(hostEntry);

    return { api, coreApi, load, unload, dispose, command, step, frameStep, diagnostics, sourcePreflight, sourceSetHandItem };
}

export { MOD_API_VERSION };
