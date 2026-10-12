/**
 * Type declarations for the experimental M1 mod API (0.1.0), mirroring
 * `src/mods.js`. JavaScript authors do not need TypeScript or any build step to
 * use the API; these declarations exist so editors can show the same contracts
 * that docs/modding/README.md documents. Anything not declared here does not
 * exist in 0.1.0.
 */

/** Engine action state: 0 idle, 1 travelling to a destination, 2 walking a heading. */
export type ModActionState = 0 | 1 | 2;

/** Detached F32-backed engine state. Values are copies; writing to them changes nothing. */
export interface ModSnapshot {
  /** Engine ABI version; the host requires 1. */
  apiVersion: number;
  /** Unsigned accepted-step counter since reset, wrapping at 2^32. */
  tick: number;
  /** World x within [0, 10]. */
  x: number;
  /** World y within [0, 10]. */
  y: number;
  /** Movement speed in world units per second, within [0.1, 10]. */
  speed: number;
  /** Current action state. */
  action: ModActionState;
}

/** Movement command: destinations are within [0,10]; directions are any finite signed vector,
 * normalised in WASM (only an exactly zero vector cancels). Inputs validated as F64 before
 * F32 state conversion. `cancel` carries no coordinates and bypasses veto. */
export type ModAction =
  | { type: 'moveTo'; x: number; y: number }
  | { type: 'walk'; x: number; y: number }
  | { type: 'cancel' };

/** Mod identity exported by every mod module. */
export interface ModManifest {
  /** Unique id: `[a-z0-9][a-z0-9._-]{0,63}`. Duplicate ids are rejected, and the
   * id `host` is reserved for page-input attribution. */
  id: string;
  /** Dotted `major.minor.patch` mod version (informational; not compared). */
  version: string;
  /** Must equal `MOD_API_VERSION` exactly, or the mod is refused. */
  apiVersion: string;
  /** Human-readable name for the host UI and diagnostics. */
  name: string;
}

/** What a `beforeAction` hook may return. */
export type BeforeActionResult = ModAction | false | null | undefined | Promise<unknown>;

/**
 * Synchronous pre-commit hook. It receives a detached copy of the pending
 * command. Return `undefined`/`null` to leave it alone, a replacement command
 * (validated before commit), or `false` to cancel the commit. Returning a
 * promise is an error: hooks cannot decide after the command has committed.
 */
export type BeforeActionHook = (action: ModAction) => BeforeActionResult;

/** Per-mod handle passed to `activate`. Frozen; becomes inert once the mod is
 * unloaded, so a captured handle cannot mutate the engine afterwards. */
export interface ModApi {
  /** Mod API version, always `'0.1.0'` in this build. */
  version: string;
  /** Movement state and speed. */
  movement: {
    /** Detached current engine state. */
    getState(): ModSnapshot;
    /** Sets movement speed in world units per second; must be within [0.1, 10]. */
    setSpeed(speed: number): void;
  };
  /** Commands submitted by the mod itself. */
  actions: {
    /**
     * Enters the same shared action path as page input: every live
     * `beforeAction` hook resolves before the engine state changes, and the
     * outcome carries `submittedBy` as this mod's id. `cancel` still bypasses
     * hooks. Calling this synchronously while hooks are resolving throws an
     * attributed `ModError` — a hook must return a replacement command or
     * `false` instead of submitting.
     */
    submit(action: ModAction): ModCommandResult;
  };
  /** Hook registration. */
  hooks: {
    /**
     * Registers a `beforeAction` hook. Hooks run in ascending `priority`
     * (default 0), then registration order.
     * @returns An unsubscribe function; `false` if already withdrawn by unload.
     */
    beforeAction(callback: BeforeActionHook, options?: { priority?: number }): () => boolean;
  };
}

/** Outcome of one committed, modified or cancelled command. */
export interface ModCommandResult {
  /** True when the engine received a command. */
  committed: boolean;
  /** True when a hook vetoed the command; then nothing was committed. */
  cancelled: boolean;
  /** `'host'` for page input, or the submitting mod's id. */
  submittedBy: string;
  /** Ids of mods whose replacement was accepted, in dispatch order. */
  modifiedBy: string[];
  /** Id of the first hook that cancelled, when `cancelled` is true. */
  cancelledBy?: string;
  /** Engine state after the commit, or unchanged state after a veto. */
  snapshot: ModSnapshot;
}

/** Mod identity returned by `load`. */
export interface ModIdentity {
  id: string;
  version: string;
  name: string;
}

/** One loaded mod as reported by `diagnostics()`. */
export interface ModReport {
  id: string;
  name: string;
  version: string;
  apiVersion: string;
  /** Module URL the host imported. */
  url: string;
  /** Live hook registrations owned by this mod. */
  hooks: number;
}

/** A failure attributed to one module. */
export interface ModFailure {
  /** Mod id, or the module URL when the failure happened before the manifest was read. */
  modId: string;
  /** Lifecycle stage: `load`, `manifest`, `activate`, `activate.late`, `cleanup`, `cleanup.late`, `beforeAction`, `beforeAction.late`, `api`, `action`, `movement`, `hooks`. */
  stage: string;
  message: string;
}

/** Counters reported by `diagnostics()`. */
export interface ModCounts {
  /** Actions that entered the shared path, page input and mod submissions alike. */
  commands: number;
  /** Commands committed to the engine. */
  committed: number;
  /** Commands vetoed by a hook. */
  cancelled: number;
  /** Committed commands that at least one hook replaced. */
  modified: number;
  /** Commands mods submitted through `api.actions.submit`. */
  modSubmitted: number;
}

/** Detached host evidence. */
export interface ModDiagnostics {
  modApi: string;
  mods: ModReport[];
  hookCount: number;
  counts: ModCounts;
  /** Most recent attributed failures, oldest first, capped at 20. */
  errors: ModFailure[];
}

/** The engine surface the host needs; `src/engine.js` supplies it. */
export interface ModEngine {
  snapshot(): ModSnapshot;
  command(action: ModAction): ModSnapshot;
  setSpeed(speed: number): void;
}

/** Host surface returned by `createModHost`. */
export interface ModHost {
  /** Host-owned handle with the same surface mods receive, for parity checks. */
  api: ModApi;
  /**
   * Imports, validates and activates one ES module. M1 has no local package
   * picker, mod manager, dependency resolution or package format: the URL must
   * already be importable by the browser. The shipped app loads its own
   * same-origin bundled sample; the loader is a trust decision, not an origin
   * policy or a sandbox.
   */
  load(url: string | URL): Promise<ModIdentity>;
  /** Unloads every mod: cleanup runs in reverse load order, handles go inert. */
  dispose(): void;
  /**
   * Page-input entry into the shared action path: every live hook resolves,
   * then the command commits once. `{ type: 'cancel' }` bypasses hooks
   * entirely — cancellation cannot be blocked — and is reported as
   * `submittedBy: 'host'`.
   */
  command(action: ModAction): ModCommandResult;
  /** Detached host evidence. */
  diagnostics(): ModDiagnostics;
}

/** Public mod API version; a manifest must name exactly this value. */
export const MOD_API_VERSION: '0.1.0';

/**
 * Creates the mod host for one engine instance. Mods are trusted same-origin
 * code, not sandboxed. Every failure is an `Error` with `name === 'ModError'`
 * plus `modId` and `stage` properties.
 * @throws {TypeError} When the engine lacks `snapshot`, `command` or `setSpeed`.
 */
export function createModHost(engine: ModEngine): ModHost;
