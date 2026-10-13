/**
 * Type declarations for the experimental mod API (0.1.0), mirroring `src/mods.js`
 * and the M2 local package manager in `src/mod-manager.js`. JavaScript authors need
 * no TypeScript and no build step to use the API; these declarations exist so
 * editors can show the same contracts that docs/modding/README.md documents.
 * Anything not declared here does not exist in 0.1.0.
 */

/** Engine action state: 0 idle, 1 travelling to a destination, 2 walking a heading. */
export type ModActionState = 0 | 1 | 2;

/** Detached engine state. Values are copies; writing to them changes nothing. */
export interface ModSnapshot {
  /** Engine ABI version; the host requires 1. */
  apiVersion: number;
  /** Unsigned accepted-step counter since reset, wrapping at 2^32. */
  tick: number;
  /** World x; within [0, 10] until navigation is imported. */
  x: number;
  /** World y; within [0, 10] until navigation is imported. */
  y: number;
  /** Movement speed in world units per second, within [0.1, 10]. */
  speed: number;
  /** Current action state. */
  action: ModActionState;
  /** Optional real extended-engine scalar; absent on movement-only engines. */
  health?: number;
  /** Optional authoritative death state, never synthesized by the SDK. */
  dead?: boolean;
}

/** Destinations use authoritative world bounds; walking uses any finite vector.
 * Item positions are finite and WASM validates membership. IDs/counts are positive
 * uint32, condition is nonnegative int32, health is finite [0,100].
 * `cancel` carries no coordinates and bypasses veto. */
export type ModAction =
  | { type: 'moveTo'; x: number; y: number }
  | { type: 'walk'; x: number; y: number }
  | { type: 'cancel' }
  | ({ type: 'spawnItem' } & ModItemSpawn)
  | { type: 'pickup' | 'wear' | 'unequip'; id: number }
  | { type: 'drop'; id: number; x: number; y: number }
  | { type: 'setCondition'; id: number; condition: number }
  | { type: 'setHealth'; health: number }
  | { type: 'setCharacterStat'; name: string; value: number }
  | { type: 'setMoodleInputs'; inputs: Record<string, number | boolean> };

/** Omitted count/condition are resolved by WASM's real definition, not the SDK. */
export interface ModItemSpawn {
  fullType: string;
  x: number;
  y: number;
  count?: number;
  condition?: number;
}

/** Numeric definition fields live in WASM; additional fields are detached source/appearance metadata. */
export interface ModItemDefinitionInput {
  fullType: string;
  bodyLocation: string | null;
  conditionMax: number;
  stackLimit: number;
  removeOnBroken: boolean;
  conditionLowerChanceOneIn: number;
  [metadata: string]: unknown;
}

/** Resolved numeric fields and actual owner, read back from the authoritative engine. */
export interface ModItemDefinition extends ModItemDefinitionInput {
  owner: string;
}

/** Stable positive uint32 identity; null bodyLocation means not currently worn. */
export interface ModItem {
  id: number;
  fullType: string;
  location: 'ground' | 'inventory';
  x: number;
  y: number;
  condition: number;
  count: number;
  bodyLocation: string | null;
}

/** Opaque original source IDs in real engine order; no guessed neutral registry. */
export interface ModMoodle {
  id: string;
  level: 0 | 1 | 2 | 3 | 4;
}

/** Spawn commands additionally expose the stable item id, not an SDK-generated id. */
export type ModCommandSnapshot = ModSnapshot & { id?: number };

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
  /** Positive safe integer for this namespace's saved document; defaults to 1. */
  saveSchemaVersion?: number;
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

/** Finite JSON only: no cycles, undefined, accessors, functions, symbols or BigInt. */
export type ModJsonValue = null | boolean | number | string | ModJsonValue[] | { [key: string]: ModJsonValue };

/** Detached authoritative loaded-cell extents; each cell is 256 x 256 tiles. */
export interface ModWorldBounds {
  active: boolean;
  minCx: number;
  minCy: number;
  maxCx: number;
  maxCy: number;
  cells: number;
}

/** Detached proposed import; editing it never edits the pending import. */
export interface ModWorldImport {
  cx: number;
  cy: number;
  bytes: Uint8Array;
}

/** Return false to veto; other live hooks still run. Promises are rejected. */
export type BeforeWorldImportHook = (cell: ModWorldImport) => false | null | undefined | Promise<unknown>;

/** Outcome of a navigation import, after veto or authoritative engine commit. */
export interface ModWorldImportResult {
  committed: boolean;
  cancelled: boolean;
  submittedBy: string;
  cancelledBy?: string;
  snapshot: ModSnapshot;
}

/** One committed step's detached evidence, not a wall-clock/frame event. */
export interface ModTickEvent {
  seconds: number;
  snapshot: ModSnapshot;
}

/** Must return nothing synchronously; callback failures never undo a step. */
export type ModTickListener = (event: ModTickEvent) => void | null | Promise<unknown>;

/** One true alive-to-dead transition, emitted only after a successful command commit. */
export interface ModCharacterDeathEvent {
  type: 'CharacterDeath';
  submittedBy: string;
  action: ModAction;
  snapshot: ModCommandSnapshot;
}

/** Explicit callback payload mapping; arbitrary event names are not accepted. */
export interface ModEventMap {
  Tick: ModTickEvent;
  CharacterDeath: ModCharacterDeathEvent;
}

/** Synchronous postcommit callback; failures never undo the death transition. */
export type ModCharacterDeathListener = (event: ModEventMap['CharacterDeath']) => void | null | Promise<unknown>;

/** Automatically namespaced backing record; data is never exposed by reference. */
export interface ModSaveRecord {
  schemaVersion: number;
  data: ModJsonValue;
}

/** Optional synchronous backing. Omission means private per-host memory, not durability. */
export interface ModHostOptions {
  readModState(id: string): ModSaveRecord | undefined;
  writeModState(id: string, record: ModSaveRecord): void;
}

/** Optional module export, called before activate when saved schemas differ.
 * Pure, synchronous, detached input/output; invalid output preserves old data. */
export type ModSaveMigration = (oldVersion: number, data: ModJsonValue) => ModJsonValue;

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
  /** Real optional engine capabilities; unsupported queries throw ModError/items. */
  items: {
    definitions: {
      list(): ModItemDefinition[];
      /** Valid unknown identities return null. */
      get(fullType: string): ModItemDefinition | null;
      /** Owner is bound to this mod id. Only legal inside synchronous activate.
       * Duplicate identities require explicit override; failed activation rolls
       * back numeric rows, owners and appended metadata. No SDK freeze method. */
      register(input: ModItemDefinitionInput, options?: { override?: boolean }): ModItemDefinition;
    };
    list(): ModItem[];
    /** Valid unknown ids return null. */
    get(id: number): ModItem | null;
    worn(bodyLocation: string): ModItem | null;
    /** All mutations use actions.submit's shared synchronous hook path. */
    spawn(input: ModItemSpawn): ModCommandResult;
    pickup(id: number): ModCommandResult;
    wear(id: number): ModCommandResult;
    unequip(id: number): ModCommandResult;
    drop(id: number, x: number, y: number): ModCommandResult;
    setCondition(id: number, condition: number): ModCommandResult;
  };
  /** Actual engine health; no authoritative SDK shadow or invented moodle rules. */
  character: {
    getHealth(): number;
    isDead(): boolean;
    setHealth(health: number): ModCommandResult;
    /** Requires real optional engine capability; throws unsupported otherwise. */
    moodles(): ModMoodle[];
    /** Source-backed stats and explicitly modeled environmental inputs, detached. */
    moodleInputs(): Record<string, number | boolean>;
    inputLimits(): Record<string, { min: number; max: number; default: number; integer: boolean } | { type: 'boolean'; default: boolean }>;
    /** Both mutations pass through synchronous beforeAction hooks before WASM commit. */
    setStat(name: string, value: number): ModCommandResult;
    setMoodleInputs(inputs: Record<string, number | boolean>): ModCommandResult;
  };
  /** Persist original UI options inside this mod's saveData.nativeUIOptions map.
   * Exact nonempty IDs of at most 128 characters; strict cloned JSON under the
   * existing complete-namespace 256 KiB cap and schema guard. Other fields,
   * including nativePlayerData, are preserved; no UI panels are created. */
  ui: {
    readOptions(modOptionsID: string): ModJsonValue | undefined;
    writeOptions(modOptionsID: string, values: ModJsonValue): void;
  };
  /** Optional extended-engine navigation capabilities; unsupported calls throw ModError/world. */
  world: {
    getBounds(): ModWorldBounds;
    /** Absolute int32 tiles; unsigned bits 1 solid, 2 south wall, 4 east wall,
     * 8 floor, 16 water, 32 room. 0xFFFFFFFF means unloaded. */
    getNavFlags(tileX: number, tileY: number): number;
    /** Cells in [-100,100]^2, complete validated 00 01 navigation bytes.
     * Commits once, cancels movement without relocating; no automatic undo. */
    importNavigationCell(cx: number, cy: number, bytes: Uint8Array | DataView): ModWorldImportResult;
  };
  /** This manifest id's finite JSON document; complete record capped at 256 KiB UTF-8. */
  saveData: {
    /** Undefined only when absent; throws if the backing schema became incompatible. */
    read(): ModJsonValue | undefined;
    /** Replaces this namespace atomically in a synchronous backing; no automatic undo. */
    write(value: ModJsonValue): void;
  };
  /** Post-commit callbacks in priority/registration order, withdrawn on unload. */
  events: {
    onTick(callback: ModTickListener, options?: { priority?: number }): () => boolean;
    onCharacterDeath(callback: ModCharacterDeathListener, options?: { priority?: number }): () => boolean;
  };
  /** Hook registration. */
  hooks: {
    /**
     * Registers a `beforeAction` hook. Hooks run in ascending `priority`
     * (default 0), then registration order.
     * @returns An unsubscribe function; `false` if already withdrawn by unload.
     */
    beforeAction(callback: BeforeActionHook, options?: { priority?: number }): () => boolean;
    /** Precommit, detached cell payload; cancellation wins. No nested import,
     * action submission or step while precommit hooks resolve. */
    beforeWorldImport(callback: BeforeWorldImportHook, options?: { priority?: number }): () => boolean;
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
  snapshot: ModCommandSnapshot;
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
  /** Live action/import/tick registrations owned by this mod. */
  hooks: number;
}

/** A failure attributed to one module. */
export interface ModFailure {
  /** Mod id, or the module URL when the failure happened before the manifest was read. */
  modId: string;
  /** Lifecycle/API stage, including world, saveData, tick, beforeWorldImport,
   * onTick and their .late asynchronous rejection attribution. */
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
  command(action: ModAction): ModCommandSnapshot;
  setSpeed(speed: number): void;
  /** Optional: older engine handles still support original movement calls. */
  step?(seconds: number): void;
  worldBounds?(): ModWorldBounds;
  navFlags?(x: number, y: number): number;
  worldImportCell?(cx: number, cy: number, bytes: Uint8Array | DataView): void;
  /** Optional authoritative item/character extensions; never required for movement activation. */
  itemDefinitions?(): ModItemDefinition[];
  registerItemDefinition?(input: ModItemDefinitionInput, options: { owner: string; override?: boolean }): ModItemDefinition;
  beginItemDefinitionRegistration?(owner: string): void;
  commitItemDefinitionRegistration?(owner: string): void;
  rollbackItemDefinitionRegistration?(owner: string): void;
  /** Host-only registration seal, intentionally absent from ModApi. */
  freezeItemDefinitions?(): void;
  items?(): ModItem[];
  importItems?(records: ModItem[]): void;
  wornItem?(bodyLocation: string): ModItem | null;
  getHealth?(): number;
  isDead?(): boolean;
  moodles?(): ModMoodle[];
  saveMoodleState?(): {
    version: 1;
    inputs: Record<string, number | boolean>;
    painTimer: number;
    painLevel: 0 | 1 | 2 | 3 | 4;
    cantSprintTimer: number;
  };
  moodleInputLimits?(): Record<string, { min: number; max: number; default: number; integer: boolean } | { type: 'boolean'; default: boolean }>;
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
  /** Advances one real engine step, then dispatches detached onTick evidence.
   * Refused or recursive steps emit no event; absent capability throws ModError/tick. */
  step(seconds: number): void;
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
export function createModHost(engine: ModEngine, options?: ModHostOptions): ModHost;

/** One picked package file, as a directory selection provides it. */
export interface ModPackageSourceFile {
  name: string;
  size: number;
  webkitRelativePath?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** A `mod.json` manifest with every optional field resolved to its default. */
export interface ModPackageManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: string;
  description: string;
  /** Package-relative `.js` or `.mjs` entry, present among the stored files. */
  entry: string;
  /** Exact dotted versions only; ranges are refused at install. */
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  conflicts: string[];
  loadBefore: string[];
  loadAfter: string[];
  assets: string[];
  /** Stored for the host UI; API 0.1.0 gives mods no settings channel. */
  settings: object;
}

/** One validated package file, before it is stored. */
export interface ModPackageFileEntry {
  path: string;
  bytes: ArrayBuffer;
  size: number;
  mime: string;
}

/** A validated package that has not been stored yet. */
export interface ModParsedPackage {
  manifest: ModPackageManifest;
  revision: string;
  entries: ModPackageFileEntry[];
  totalBytes: number;
}

/** One stored package file, as the service worker reads it. */
export interface ModStoredFile {
  id: string;
  revision: string;
  path: string;
  mime: string;
  size: number;
  bytes: ArrayBuffer;
}

/** Detached package metadata: the manifest plus what the manager recorded. */
export interface ModPackageMetadata extends ModPackageManifest {
  /** Content digest, part of every served URL, so an update changes them all. */
  revision: string;
  enabled: boolean;
  installedAt: string;
  fileCount: number;
  totalBytes: number;
  /** Origin-relative served URLs. */
  urls: { base: string; entry: string };
}

/** Metadata plus whether the running mods still match stored configuration. */
export type ModPackageChange = ModPackageMetadata & { requiresReload: boolean };

/** The fields `resolveModOrder` reads. */
export type ModPackageResolution = Pick<
  ModPackageMetadata,
  'id' | 'version' | 'apiVersion' | 'enabled' | 'dependencies' | 'optionalDependencies' | 'conflicts' | 'loadBefore' | 'loadAfter'
>;

/** One package that activation loaded through the host. */
export interface ModActivation {
  id: string;
  version: string;
  name: string;
  revision: string;
  url: string;
}

/** One activation failure, attributed to the package that caused it. */
export interface ModActivationError {
  id: string;
  modId: string;
  stage: string;
  message: string;
}

/** Activation outcome; `disposed` is true when a failure unwound what loaded. */
export interface ModActivationReport {
  safeMode: boolean;
  apiVersion: string;
  order: string[];
  activated: ModActivation[];
  errors: ModActivationError[];
  skipped: string[];
  disposed: boolean;
}

/** Detached manager evidence from `diagnostics()`. */
export interface ModManagerDiagnostics {
  packageDb: { name: string; schemaVersion: number };
  worker: { url: string; scope: string; controlling: boolean } | undefined;
  apiVersion: string;
  /** The configuration as of the last install/list/enable/remove/activation. */
  packages: ModPackageMetadata[];
  requiresReload: boolean;
  lastActivation: ModActivationReport | undefined;
  errors: { id: string; stage: string; message: string }[];
}

/** Package management surface returned by `createModManager`. */
export interface ModPackageManager {
  /** Atomically stores provisioned files; first installs are disabled, updates preserve the flag. Failure preserves the old package. */
  install(files: ModPackageSourceFile[] | FileList): Promise<ModPackageChange>;
  list(): Promise<ModPackageMetadata[]>;
  /** Persists the flag for the next activation; nothing already running is undone. */
  setEnabled(id: string, enabled: boolean): Promise<ModPackageChange>;
  /** Deletes stored bytes and configuration; loaded code stays loaded until the host disposes it. */
  remove(id: string): Promise<void>;
  /** `safeMode: true` performs no module import at all. */
  activateEnabled(options?: { safeMode?: boolean }): Promise<ModActivationReport>;
  diagnostics(): ModManagerDiagnostics;
}

/** Package size and count bounds the manager enforces before writing anything. */
export const MAX_FILE_BYTES: number;
export const MAX_PACKAGE_BYTES: number;
export const MAX_MANIFEST_BYTES: number;
export const MAX_FILES: number;

/** Dedicated package database identity. */
export const PACKAGE_DB_NAME: string;
export const PACKAGE_SCHEMA_VERSION: number;
export const MANIFEST_NAME: 'mod.json';
export const MOD_URL_PREFIX: '/__mods__/';

/**
 * Creates the local package manager for one mod host. Packages are trusted
 * same-origin code, not sandboxed. Manager failures are `Error`s with
 * `name === 'ModManagerError'` plus `modId`, `stage` and `ids` properties.
 * @throws {TypeError} When the host lacks `api.version`, `load` or `dispose`.
 */
export function createModManager(host: Pick<ModHost, 'api' | 'load' | 'dispose'>): ModPackageManager;

/** Validates one picked folder without touching storage. */
export function parseModPackage(files: ModPackageSourceFile[] | FileList): Promise<ModParsedPackage>;

/** Orders enabled packages by dependency, conflict and load-hint rules. */
export function resolveModOrder(packages: ModPackageResolution[], apiVersion: string): string[];

/** Splits a `/__mods__/` request path, refusing traversal and malformed parts. */
export function splitModPath(pathname: string): { id: string; revision: string; path: string } | undefined;

/** Reads one stored package file; malformed or reserved lookups never reach storage. */
export function readPackageFile(id: string, revision: string, path: string): Promise<ModStoredFile | undefined>;

/** Opens the shared package database; `mod-worker.js` reuses this one schema. */
export function openPackageDb(): Promise<IDBDatabase>;
