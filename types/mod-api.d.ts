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
  | ({ type: 'requestWalk' } & ModWorldCoordinates)
  | { type: 'cancel' }
  | { type: 'toggleDoor'; id: string }
  | ({ type: 'spawnItem' } & ModItemSpawn)
  | { type: 'pickup' | 'wear' | 'unequip'; id: number }
  | { type: 'drop'; id: number; x: number; y: number }
  | { type: 'setCondition'; id: number; condition: number }
  | { type: 'setWeight'; id: number; weight: number }
  | { type: 'setActualWeight'; id: number; actualWeight: number }
  | { type: 'setHandItem'; slot: 'primary' | 'secondary'; itemId: number | null }
  | { type: 'setHealth'; health: number }
  | { type: 'setCharacterStat'; name: string; value: number }
  | { type: 'setMoodleInputs'; inputs: Record<string, number | boolean> }
  | { type: 'setBodyPart'; part: ModBodyPartId; values: Partial<ModBodyPartValues> }
  | { type: 'setInjurySeverity'; severity: ModInjurySeverity };

export interface ModQueuedAction {
  readonly id: number;
  readonly kind: 'walk' | 'door' | 'grab' | 'getUp';
  readonly origin: 'sdk' | 'lua';
  readonly target: Readonly<{ id: number | string; x: number; y: number; z: number }>;
  readonly rawTime: number;
  readonly maxTime: number;
  readonly currentTime: number;
  readonly lastTime: number;
  readonly prevLastTime: number;
  readonly delta: number;
  readonly started: boolean;
  readonly groups: readonly Readonly<{ id: number; rawTime: number; fullType: string | null; itemIds: readonly number[] }>[];
}
export interface ModQueueState {
  readonly current: ModQueuedAction | null;
  readonly pending: readonly ModQueuedAction[];
}
export interface ModQueueAcceptance {
  readonly accepted: boolean;
  readonly actionId: number | null;
  readonly state: ModQueueState;
}
export interface ModQueuedActions {
  getState(): ModQueueState;
  requestPickup(itemId: number): ModQueueAcceptance;
  requestDoor(doorId: string): ModQueueAcceptance;
  requestWalk(target: ModWorldCoordinates): ModQueueAcceptance;
  cancel(): ModQueueState;
}
export type ModTimingField = 'multiplier' | 'bias' | 'perObject' | 'slowHalf' | 'slowQuarter' | 'slowEighth' | 'instant';
export interface ModSourceTimingState {
  readonly multiplier: number;
  readonly bias: number;
  readonly perObject: number;
  readonly fpsMultiplier: number;
  readonly elapsedSeconds: number;
  readonly slowMultiplier: number;
  readonly gameMultiplier: number;
  readonly slowHalf: boolean;
  readonly slowQuarter: boolean;
  readonly slowEighth: boolean;
  readonly instant: boolean;
  readonly gameMode: string;
  readonly traits: Readonly<{ 'base:dextrous': boolean; 'base:allthumbs': boolean }>;
}
export interface ModSourceTiming {
  getState(): ModSourceTimingState;
  set(field: ModTimingField, value: number | boolean): void;
  hasTrait(id: string): boolean;
  setTrait(id: string, enabled: boolean): void;
  getGameMode(): string;
  setGameMode(mode: string): void;
}

/** Stable inventory refs; wearing gloves is independent of held items. */
export interface ModHandItems {
  primary: number | null;
  secondary: number | null;
}
export interface ModHandItemChanged {
  slot: 'primary' | 'secondary';
  playerIndex: 0;
  itemId: number | null;
}
export type ModHandItemChangedListener = (event: ModHandItemChanged) => void;
export interface ModHandState extends ModHandItems {
  version: 1;
}

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
  /** Omitted weight uses native ScriptItem's constructor default 1; resolved values are f32. */
  weight?: number;
  /** Detached canonical ResourceLocation identities; omitted tags register as an empty list. */
  tags?: readonly string[];
  [metadata: string]: unknown;
}

/** Resolved numeric fields and actual owner, read back from the authoritative engine. */
export interface ModItemDefinition extends ModItemDefinitionInput {
  owner: string;
  weight: number;
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
  /** Live base field copied from the definition at creation; independent of actualWeight. */
  weight: number;
  /** Live effective actual field used by native inventory carry accounting. */
  actualWeight: number;
}

/** Current flat player inventory; pickup capacity is separate from stored encumbrance maxWeight. */
export interface ModInventoryState {
  /** Native f32 accumulation; valid individual weights can overflow the aggregate to +Infinity. */
  capacityWeight: number;
  capacity: number;
  maxWeight: number;
}

/** Detached coordinate record: every axis is a signed int32, including query elevations. */
export interface ModWorldCoordinates {
  x: number;
  y: number;
  z: number;
}

/** Detached authoritative source-square facts; absent metadata returns null, not a guessed tile. */
export interface ModWorldSquare {
  x: number;
  y: number;
  z: number;
  /** Dense canonical source room identity, or -1 outside rooms; not original packed RoomID. */
  roomId: number;
  outside: boolean;
  solid: boolean;
  solidTrans: boolean;
  tree: boolean;
  vehicleObstructed: boolean;
  /** Source cached TreatAsSolidFloor result: raw solidfloor, stairs, or a nonnull slope direction. */
  solidFloor: boolean;
  /** Native source predicate using current square flags and actual adjacent window/hoppable edges. */
  canStand: boolean;
}

/** Private immutable import facts for source getWallExcludingList; absent means unknown. */
export interface ModSourceReachWalls {
  readonly north: boolean;
  readonly west: boolean;
}
export interface ModSquareSourceMetadata extends ModWorldCoordinates {
  roomId: number;
  outside: boolean;
  solid: boolean;
  solidTrans: boolean;
  tree: boolean;
  vehicleObstructed: boolean;
  solidFloor?: boolean;
  independentWalls: number;
  windows?: number;
  doorWalls?: number;
  hoppableEdges?: number;
  windowEdges?: number;
  interactionProperties?: Readonly<Record<string, boolean>>;
  reachWalls?: ModSourceReachWalls;
}
/** Host-only source door import, never a mutable queue/save field. */
export type ModDoorSourceMetadata = Omit<ModDoor, 'revision' | 'toggled' | 'hoppable' | 'customLock'> & {
  hoppable?: boolean;
  customLock?: boolean;
  standEdges?: readonly number[];
  squareFlags?: readonly number[];
  interactionProperties?: readonly Readonly<Record<string, boolean>>[];
  reachWalls?: readonly ModSourceReachWalls[];
  curtainCapabilities?: readonly boolean[];
};

/** Opaque original source IDs in real engine order; no guessed neutral registry. */
export interface ModMoodle {
  id: string;
  level: 0 | 1 | 2 | 3 | 4;
}

/** Canonical source anatomy order contains these 17 parts; MAX is not a part. */
export type ModBodyPartId = 'Hand_L' | 'Hand_R' | 'ForeArm_L' | 'ForeArm_R'
  | 'UpperArm_L' | 'UpperArm_R' | 'Torso_Upper' | 'Torso_Lower' | 'Head' | 'Neck'
  | 'Groin' | 'UpperLeg_L' | 'UpperLeg_R' | 'LowerLeg_L' | 'LowerLeg_R' | 'Foot_L' | 'Foot_R';
export type ModInjurySeverity = 'low' | 'normal' | 'high';

/** Mutable native fields; every numeric input is finite and must fit its native limits. */
export interface ModBodyPartValues {
  health: number;
  scratchTime: number;
  cutTime: number;
  biteTime: number;
  deepWoundTime: number;
  stitchTime: number;
  fractureTime: number;
  splintFactor: number;
  burnTime: number;
  woundInfectionLevel: number;
  /** Signed, uncapped within finite native f32 range. */
  additionalPain: number;
  stiffness: number;
  bandaged: boolean;
  haveBullet: boolean;
  haveGlass: boolean;
  /** Real thermal-node state; source construction starts at 33, not climate simulation. */
  skinTemperature: number;
}

export interface ModBodyPart extends ModBodyPartValues {
  readonly id: ModBodyPartId;
  /** Source f32 arithmetic, uncapped: may be negative or overflow to positive Infinity. */
  readonly pain: number;
  readonly skinSurface: number;
  readonly distToCore: number;
}

export type ModBodyPartInputLimits = {
  [K in keyof ModBodyPartValues]: ModBodyPartValues[K] extends boolean
    ? { type: 'boolean'; default: boolean }
    : { min: number; max: number; default: number; integer: boolean };
};

/** Derived pain and immutable anatomy are never persisted. */
export interface ModBodyState {
  version: 1;
  injurySeverity: ModInjurySeverity;
  parts: (ModBodyPartValues & { id: ModBodyPartId })[];
}

/** Spawn commands additionally expose the stable item id, not an SDK-generated id. */
export type ModCommandSnapshot = ModSnapshot & { id?: number };

/** Mod identity exported by every mod module. */
export interface ModManifest {
  /** Unique id: `[a-z0-9][a-z0-9._-]{0,63}`. Duplicate ids are rejected, and the
   * ids `host` and `base` are reserved for page input and source-owned cues. */
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

/** Detached native door row. ID refers to CLOSED source placement; no public ordinal. */
export interface ModDoor {
  id: string;
  /** Current world tile coordinates, including moved double-door panels. One unit = one tile. */
  x: number;
  y: number;
  z: number;
  open: boolean;
  /** False on source import; true after any successful native toggle, including coupled panels. */
  toggled: boolean;
  locked: boolean;
  lockedByKey: boolean;
  keyId: number;
  roomId: number;
  oppositeRoomId: number;
  independentWalls: number;
  doubleDoor: number;
  garageDoor: number;
  north: boolean;
  forceLocked: boolean;
  attachedE: boolean;
  attachedS: boolean;
  barricaded: boolean;
  interiorSide: boolean;
  hoppable: boolean;
  customLock: boolean;
  /** Global authoritative uint32 door revision, shared by all rows in this query. */
  revision: number;
}

/** Native decoded registration metadata, never PCM or source bytes. */
export interface ModAudioAsset {
  id: string;
  owner: string;
  encodedBytes: number;
  decodedBytes: number;
  /** Duration in seconds. */
  duration: number;
  channels: number;
  frames: number;
  /** Frames per second. */
  sampleRate: number;
}

/** Finite world coordinates; world (x,y,z) maps to audio (x,z,y), one tile = one metre. */
export interface ModAudioPosition {
  x?: number;
  y?: number;
  z?: number;
  /** Linear gain in [0,1], default 1. */
  volume?: number;
  /** Default false; cleanup stops even looping voices. */
  loop?: boolean;
}

export interface ModAudioVoice {
  readonly id: number;
  /** Idempotently stops and disconnects this voice, including after owner cleanup. */
  stop(): void;
}

/** Host-injected real createAudio adapter; context creation/unlock/pause/dispose stay host-owned. */
export interface ModAudioAdapter {
  load(id: string, bytes: ArrayBuffer, options: { owner: string; override?: boolean }): Promise<ModAudioAsset>;
  play(id: string, options: ModAudioPosition & { owner: string }): ModAudioVoice;
  unload(id: string, options: { owner: string }): boolean;
  /** Synchronously cancels pending admission, releases owned buffers and stops owned voices. */
  unloadOwner(owner: string): void;
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

/** Optional synchronous backing and actual audio adapter. Omitted backing is per-host memory only. */
export interface ModHostOptions {
  readModState?(id: string): ModSaveRecord | undefined;
  writeModState?(id: string, record: ModSaveRecord): void;
  /** No fake audio or automatic context: absence throws attributed unsupported errors. */
  audio?: ModAudioAdapter;
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
    getState(): ModQueueState;
    requestPickup(itemId: number): ModQueueAcceptance;
    requestDoor(doorId: string): ModQueueAcceptance;
    requestWalk(target: ModWorldCoordinates): ModQueueAcceptance;
    cancel(): ModQueueState;
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
    /** Detached authoritative current-player carry state; unavailable engines throw. */
    inventoryState(): ModInventoryState;
    /** All mutations use actions.submit's shared synchronous hook path. */
    spawn(input: ModItemSpawn): ModCommandResult;
    pickup(id: number): ModQueueAcceptance;
    wear(id: number): ModCommandResult;
    unequip(id: number): ModCommandResult;
    drop(id: number, x: number, y: number): ModCommandResult;
    setCondition(id: number, condition: number): ModCommandResult;
    /** Changes only the base weight; finite nonnegative values must fit native f32. */
    setWeight(id: number, weight: number): ModCommandResult;
    /** Changes only actual weight used for carry load, through shared precommit hooks. */
    setActualWeight(id: number, actualWeight: number): ModCommandResult;
  };
  /** Actual engine health; no authoritative SDK shadow or invented moodle rules. */
  character: {
    getHandItems(): ModHandItems;
    /** Shared item hooks, actual native mutation; no notification on same assignment/veto. */
    setHandItem(slot: 'primary' | 'secondary', itemId: number | null): ModCommandResult;
    hasTrait(id: string): boolean;
    setTrait(id: string, enabled: boolean): void;
    getHealth(): number;
    isDead(): boolean;
    /** Derives from the actual item worn on base:hands and its native definition tag. */
    isWearingAwkwardGloves(): boolean;
    setHealth(health: number): ModCommandResult;
    /** Requires real optional engine capability; throws unsupported otherwise. */
    moodles(): ModMoodle[];
    /** Source-backed stats and explicitly modeled environmental inputs, detached. */
    moodleInputs(): Record<string, number | boolean>;
    inputLimits(): Record<string, { min: number; max: number; default: number; integer: boolean } | { type: 'boolean'; default: boolean }>;
    /** Both mutations pass through synchronous beforeAction hooks before WASM commit. */
    setStat(name: string, value: number): ModCommandResult;
    setMoodleInputs(inputs: Record<string, number | boolean>): ModCommandResult;
    /** Real native queries; unsupported optional engines throw ModError, never healthy defaults. */
    bodyParts(): ModBodyPart[];
    bodyPartInputLimits(): ModBodyPartInputLimits;
    /** Native cold-node action factor; may overflow to positive Infinity. */
    thermalActionModifier(): number;
    setBodyPart(part: ModBodyPartId, values: Partial<ModBodyPartValues>): ModCommandResult;
    setInjurySeverity(severity: ModInjurySeverity): ModCommandResult;
  };
  time: Omit<ModSourceTiming, 'hasTrait' | 'setTrait'>;
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
    /** Read-only during activation too. Unsupported engine throws ModError/world. */
    getDoors(): ModDoor[];
    /** Signed int32 coordinates. Returns null only for absent source metadata; unsupported engines throw. */
    getSquare(x: number, y: number, z: number): ModWorldSquare | null;
    /** Directional native wall/window/door/stair relation. Null/absent other is false;
     * absent calling square, invalid records and unsupported engines throw ModError/world. */
    isBlockedTo(from: ModWorldCoordinates, to: ModWorldCoordinates | null): boolean;
    /** Exact nonempty stable id, at most 256 characters; no namespace normalization.
     * Uses actions.submit hooks before WASM mutation and returns cancelled on veto.
     * Forbidden during synchronous activate; malformed/unsupported/reentrant calls throw ModError/action. */
    toggleDoor(id: string): ModQueueAcceptance;
    /** Absolute int32 tiles; unsigned bits 1 solid, 2 south wall, 4 east wall,
     * 8 floor, 16 water, 32 room. 0xFFFFFFFF means unloaded. */
    getNavFlags(tileX: number, tileY: number): number;
    /** Cells in [-100,100]^2, complete validated 00 01 navigation bytes.
     * Commits once, cancels movement without relocating; no automatic undo. */
    importNavigationCell(cx: number, cy: number, bytes: Uint8Array | DataView): ModWorldImportResult;
  };
  /** Presentation only, not engine authority. Errors are ModError/audio (inert handles: ModError/api). */
  audio: {
    /** Unqualified ids become `${manifest.id}:${id}`; qualified load/unload ids must be owned.
     * `base` and `host` are reserved owners. Registration is forbidden inside synchronous activate.
     * Native decode consumes/detaches bytes: retain a copy yourself only if needed.
     * Pending loads reject after unload/disposal, never re-admitting buffers. */
    load(id: string, bytes: ArrayBuffer, options?: { override?: boolean }): Promise<ModAudioAsset>;
    /** Unqualified ids are local; qualified cues, including `base:cue`, may be played.
     * Forbidden during synchronous activate. Context must already be running/unlocked by the host; voice owner is this mod.
     * Omitted coordinates default to origin. Volume defaults to 1, loop to false. */
    play(id: string, options?: ModAudioPosition): ModAudioVoice;
    /** Only this owner's namespace; returns whether a loaded/pending registration was removed. */
    unload(id: string): boolean;
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
    onHandItemChanged(callback: ModHandItemChangedListener, options?: { priority?: number }): () => boolean;
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
  /** Queue admission is not a completed mutation. Only queued commands carry these fields. */
  accepted?: boolean;
  actionId?: number | null;
  state?: ModQueueState;
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

/** Error object thrown/rejected by the SDK; original adapter/engine error is retained as cause. */
export interface ModError extends Error {
  name: 'ModError';
  modId: string;
  stage: string;
  cause?: unknown;
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
  core: { id: 'pz-base-game'; active: boolean; hooks: number };
  mods: ModReport[];
  hookCount: number;
  counts: ModCounts;
  /** Most recent attributed failures, oldest first, capped at 20. */
  errors: ModFailure[];
}

/** The engine surface the host needs; `src/engine.js` supplies it. */
export interface ModEngine {
  snapshot(): ModSnapshot;
  command(action: ModAction): ModCommandSnapshot | ModQueueAcceptance;
  setSpeed(speed: number): void;
  /** Optional: older engine handles still support original movement calls. */
  step?(seconds: number): void;
  frameStep?(seconds: number): void;
  actions?: ModQueuedActions;
  sourceTiming?: ModSourceTiming;
  worldBounds?(): ModWorldBounds;
  navFlags?(x: number, y: number): number;
  getSquare?(x: number, y: number, z: number): ModWorldSquare | null;
  isBlockedTo?(from: ModWorldCoordinates, to: ModWorldCoordinates | null): boolean;
  worldImportCell?(cx: number, cy: number, bytes: Uint8Array | DataView): void;
  /** Optional actual native-door wrapper. Validation checks availability without toggling. */
  doors?(): ModDoor[];
  toggleDoor?(id: string): ModQueueAcceptance;
  /** Optional authoritative item/character extensions; never required for movement activation. */
  itemDefinitions?(): ModItemDefinition[];
  registerItemDefinition?(input: ModItemDefinitionInput, options: { owner: string; override?: boolean }): ModItemDefinition;
  beginItemDefinitionRegistration?(owner: string): void;
  commitItemDefinitionRegistration?(owner: string): void;
  rollbackItemDefinitionRegistration?(owner: string): void;
  /** Host-only registration seal, intentionally absent from ModApi. */
  freezeItemDefinitions?(): void;
  items?(): ModItem[];
  /** Detached live stable-ID read; unknown valid uint32 identities return null. */
  getItem?(id: number): ModItem | null;
  importItems?(records: ModItem[]): void;
  wornItem?(bodyLocation: string): ModItem | null;
  inventoryState?(): ModInventoryState;
  isWearingAwkwardGloves?(): boolean;
  getHandItems?(): ModHandItems;
  setHandItem?(slot: 'primary' | 'secondary', itemId: number | null): void;
  observeHandItems?(callback: ModHandItemChangedListener, onError: (cause: unknown) => void): () => boolean;
  canSaveHandState?(): boolean;
  saveHandState?(): ModHandState;
  loadHandState?(state: ModHandState): void;
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
  bodyParts?(): ModBodyPart[];
  bodyPartInputLimits?(): ModBodyPartInputLimits;
  thermalActionModifier?(): number;
  saveBodyState?(): ModBodyState;
  loadBodyState?(value: ModBodyState): void;
}

/** Host surface returned by `createModHost`. */
export interface ModHost {
  /** Protected original-game handle; never a user-installable or disableable package. */
  coreApi: ModApi;
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
  /** Unloads one user package without disposing the protected original-game owner. */
  unload(id: string): void;
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
  /** One raw-elapsed RAF logic frame; only movement is capped to .1 seconds. */
  frameStep(seconds: number): void;
  /** Detached host evidence. */
  diagnostics(): ModDiagnostics;
  /** Host-only original context admission; validates hooks but never enqueues SDK work. */
  sourcePreflight(action: ModAction, ownerId: string): ModAction | null;
  /** Host-only original equipment mutation with live owner guards and shared item hooks. */
  sourceSetHandItem(slot: 'primary' | 'secondary', itemId: number | null, ownerId: string): ModCommandResult;
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
