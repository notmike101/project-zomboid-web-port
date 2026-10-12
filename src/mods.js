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
 * Deliberately absent in 0.1.0: mod packages with arbitrary local files, a
 * mod manager, dependency resolution, enable/disable persistence, save data,
 * UI registration and any content or asset APIs. Those are M2+ work; no
 * placeholder surfaces exist here.
 */

/** Public mod API version. A manifest must name exactly this value. */
const MOD_API_VERSION = '0.1.0';

const MAX_RECORDED_ERRORS = 20;
const MOD_ID_PATTERN = /^[\da-z][\d._a-z-]{0,63}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const WORLD_MIN = 0;
const WORLD_MAX = 10;
const MIN_SPEED = 0.1;
const MAX_SPEED = 10;
const ACTION_TYPES = new Set(['moveTo', 'walk', 'cancel']);
/** Reserved internal attribution id for page input; a mod cannot claim it. */
const RESERVED_ID = 'host';

/**
 * Detached engine state handed to mods. `action`: 0 idle, 1 destination, 2 walking.
 *
 * @typedef {0|1|2} ModActionState
 */
/**
 * @typedef {{ apiVersion: number, tick: number, x: number, y: number, speed: number, action: ModActionState }} ModSnapshot
 */
/**
 * One movement command. `moveTo`/`walk` carry a world coordinate pair; `cancel` carries nothing.
 *
 * @typedef {{ type: 'moveTo', x: number, y: number }|{ type: 'walk', x: number, y: number }|{ type: 'cancel' }} ModAction
 */
/**
 * @typedef {{ id: string, version: string, apiVersion: string, name: string }} ModManifest
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
 * @typedef {{ snapshot: () => ModSnapshot, command: (action: ModAction) => ModSnapshot, setSpeed: (speed: number) => void }} ModEngine
 */
/**
 * The per-mod object passed to `activate`.
 *
 * @typedef {{
 *   version: string,
 *   movement: { getState: () => ModSnapshot, setSpeed: (speed: number) => void },
 *   actions: { submit: (action: ModAction) => ModCommandResult },
 *   hooks: { beforeAction: (callback: BeforeActionHook, options?: { priority?: number }) => () => boolean }
 * }} ModApi
 */
/**
 * @typedef {{ committed: boolean, cancelled: boolean, submittedBy: string, modifiedBy: string[], cancelledBy?: string, snapshot: ModSnapshot }} ModCommandResult
 */
/**
 * One internal hook registration.
 *
 * @typedef {{ modId: string, entry: ModEntry, callback: BeforeActionHook, priority: number, order: number }} HookRegistration
 */
/**
 * One loaded mod.
 *
 * @typedef {{ id: string, manifest: ModManifest, url: string, cleanup: (() => void)|undefined, active: boolean }} ModEntry
 */
/**
 * The host surface returned by `createModHost`.
 *
 * @typedef {{
 *   api: ModApi,
 *   load: (url: string|URL) => Promise<{ id: string, version: string, name: string }>,
 *   dispose: () => void,
 *   command: (action: ModAction) => ModCommandResult,
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
 * Copies an action so hooks cannot mutate the host's pending command.
 *
 * @param {ModAction} action - Validated action.
 * @returns {ModAction} Detached copy.
 */
function detach(action) {
    return action.type === 'cancel' ? { type: 'cancel' } : { type: action.type, x: action.x, y: action.y };
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
 * @returns {ModHost} `api` is a host-owned handle (same surface mods get) for parity checks; `load` activates one module; `dispose` unloads every mod in reverse load order; `command` runs host input through hooks then commits once; `diagnostics` returns detached evidence.
 * @throws {TypeError} When the engine lacks `snapshot`, `command` or `setSpeed`.
 */
export function createModHost(engine) {
    if (!engine || typeof engine.snapshot !== 'function' || typeof engine.command !== 'function' || typeof engine.setSpeed !== 'function') {
        throw new TypeError('createModHost requires an engine with snapshot(), command() and setSpeed().');
    }

    /** @type {Map<string, ModEntry>} */
    const mods = new Map();
    /** @type {HookRegistration[]} */
    const hooks = [];
    /** @type {{ modId: string, stage: string, message: string }[]} */
    const failures = [];
    const counts = { commands: 0, committed: 0, cancelled: 0, modified: 0, modSubmitted: 0 };
    let registrations = 0;
    let dispatching = false;
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

        if (bounded && (value < WORLD_MIN || value > WORLD_MAX)) {
            throw modError(modId, 'action', `${label} must be within [${WORLD_MIN}, ${WORLD_MAX}]`);
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

        const typed = /** @type {{ type: 'moveTo'|'walk', x: unknown, y: unknown }} */ (candidate);

        const bounded = typed.type === 'moveTo';

        return { type: typed.type, x: coordinate(typed.x, 'x', modId, bounded), y: coordinate(typed.y, 'y', modId, bounded) };
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

                    if (typeof callback !== 'function') {
                        throw modError(entry.id, 'hooks', 'beforeAction requires a callback function');
                    }

                    const priority = options?.priority ?? 0;

                    if (typeof priority !== 'number' || !Number.isFinite(priority)) {
                        throw modError(entry.id, 'hooks', 'priority must be a finite number');
                    }

                    /** @type {HookRegistration} */
                    const hook = { modId: entry.id, entry, callback, priority, order: registrations };

                    registrations += 1;
                    hooks.push(hook);

                    return () => withdraw(hook);
                },
            },
        };

        Object.freeze(api.movement);
        Object.freeze(api.actions);
        Object.freeze(api.hooks);

        return Object.freeze(api);
    }

    /**
     * Hook dispatch order: ascending priority, then registration order. The order
     * never changes whether a command is cancelled, only which replacement wins.
     *
     * @returns {HookRegistration[]} Hooks in dispatch order.
     */
    function orderedHooks() {
        return hooks.slice().sort((a, b) => a.priority - b.priority || a.order - b.order);
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

        /** @type {ModEntry} */
        const entry = { id, manifest: { id, version, apiVersion, name }, url: specifier, cleanup: undefined, active: true };
        const speedBefore = engine.snapshot().speed;

        mods.set(id, entry);
        const api = createHandle(entry);

        let cleanup;

        try {
            cleanup = module.activate(api);
        } catch (cause) {
            rollback(entry, speedBefore, cause);
        }

        if (cleanup !== undefined && cleanup !== null && typeof cleanup !== 'function') {
            observeRejection(entry.id, 'activate.late', cleanup);
            rollback(entry, speedBefore, new Error('activate must return a synchronous cleanup function or nothing'));
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
        const submitted = validateAction(action, submitterId);

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
            for (const hook of orderedHooks()) {
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

        const snapshot = engine.command(current);

        counts.committed += 1;

        if (modifiedBy.length > 0) {
            counts.modified += 1;
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

    return { api, load, dispose, command, diagnostics };
}

export { MOD_API_VERSION };
