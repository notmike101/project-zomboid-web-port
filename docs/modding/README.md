# Mod API 0.1.0 (experimental)

A mod is an ES module of plain JavaScript — no compilation, no build step, no
packaging tool. The host is `src/mods.js`; the same contracts are declared in
[`../../types/mod-api.d.ts`](../../types/mod-api.d.ts) for editors. The shipped
sample is [`mods/accessible-walking/main.js`](../../mods/accessible-walking/main.js),
which imports [`mods/accessible-walking/settings.js`](../../mods/accessible-walking/settings.js)
and changes the real WASM movement speed.

The host UI integrates externally provisioned multifile packages through `src/mod-manager.js`
and the root `mod-worker.js` service worker, documented under “Local mod packages” below.

This API is experimental: 0.1.0 may change between previews. Anything not
documented here does not exist.

## Trust model

Mods are **trusted same-origin code, not sandboxed**. A mod can do anything a
page script can do. The host's guarantees are about ordering, validation and
attribution, never containment:

- every mutation still passes WASM validation, and WASM refuses invalid values
  without changing state;
- hooks must decide synchronously, so nothing can commit after a command;
- every failure names the module and stage that caused it;
- unloading a mod makes its API handle inert, so a captured handle cannot mutate
  the engine afterwards.

## Module shape

```js
export const manifest = {
  id: 'accessible-walking',   // [a-z0-9][a-z0-9._-]{0,63}, unique per host; `host` is reserved
  version: '0.1.0',           // dotted major.minor.patch, informational
  apiVersion: '0.1.0',        // must equal the host's MOD_API_VERSION exactly
  name: 'Accessible walking', // non-empty label for the host UI
};

export function activate(api) {
  const previous = api.movement.getState().speed;
  api.movement.setSpeed(2.25);
  return () => api.movement.setSpeed(previous); // optional, synchronous
}
```

`manifest` and `activate` are the only required exports. Optional
`manifest.saveSchemaVersion` (default `1`) and module export `migrateSaveData`
version a mod's saved document, as described below. Other extra exports are
ignored. A duplicate `id` is rejected while that mod is loaded, and the id
`host` is refused because the host uses it for page-input attribution in
`diagnostics().errors` and `submittedBy`.

## Mod API (`api` handed to `activate`)

Each activated mod gets its own frozen handle. After the mod is unloaded every
method on that handle throws (`stage: 'api'`).

| Member | Result | Notes |
|---|---|---|
| `api.version` | `'0.1.0'` | Mod API version, not the mod version. |
| `api.movement.getState()` | detached `ModSnapshot` | Copy of `{ apiVersion, tick, x, y, speed, action }`. Writing to it changes nothing. |
| `api.movement.setSpeed(speed)` | `undefined` | World units/second, must be finite and within `[0.1, 10]`. Takes effect on the next engine step. |
| `api.actions.submit(action)` | `ModCommandResult` | Enters the **same action path as page input**: every live hook resolves before the state changes and the outcome records `submittedBy` as this mod's id. Throws if called while hooks are resolving. |
| `api.hooks.beforeAction(callback, { priority = 0 })` | `() => boolean` | Registers a hook; returns unsubscribe (`false` if already withdrawn by unload). |
| `api.world.getBounds()` | detached `ModWorldBounds` | Reads committed navigation cell extents, not a proposed import. Optional engine capability. |
| `api.world.getNavFlags(tileX, tileY)` | unsigned number | Reads committed navigation bits at an absolute integer tile. Optional engine capability. |
| `api.world.importNavigationCell(cx, cy, bytes)` | `ModWorldImportResult` | Validates complete navigation bytes, resolves precommit hooks, then imports once. Cancels movement on success; no automatic undo. |
| `api.hooks.beforeWorldImport(callback, { priority = 0 })` | `() => boolean` | Synchronous precommit veto with detached coordinates and bytes; unsubscribe/ordering match `beforeAction`. |
| `api.saveData.read()` | detached JSON value or `undefined` | This manifest id's document; `undefined` means absent, not JSON null. |
| `api.saveData.write(value)` | `undefined` | Replaces only this manifest id's finite JSON document; whole namespace limited to 256 KiB UTF-8. |
| `api.events.onTick(callback, { priority = 0 })` | `() => boolean` | Runs synchronously after an executed engine step, with detached `{ seconds, snapshot }`. |

`ModSnapshot.action` is numeric: `0` idle, `1` travelling to a destination, `2`
walking a heading. Before navigation import world coordinates are within `[0, 10]`;
position starts at `(5, 5)`. With navigation active, destinations use the loaded cell
extents; WASM additionally refuses unloaded tiles, solid destinations and blocked routes.

### Commands

```js
{ type: 'moveTo', x, y } // destination within authoritative world bounds; refused, never clamped
{ type: 'walk', x, y }   // any finite signed heading, normalised by WASM; only (0,0) cancels
{ type: 'cancel' }       // stops movement, position unchanged
```

Movement actions from browser clicks, keyboard, destination forms, accessible buttons
and `api.actions.submit` use one shared precommit hook path. Explicit safety cancellation
deliberately bypasses veto; it cannot be blocked by mods. The host validates known types,
finite components, and authoritative world bounds for destinations only. Direction components
may be negative or arbitrarily large/tiny finite numbers. WASM validates original F64 input
before conversion to F32 state, avoiding boundary-rounding escapes. The page owns the fixed
60 Hz clock and delta cap, calling `mods.step(1 / 60)` rather than stepping the engine directly.

### `beforeAction` hook

Called synchronously before a host command commits, once per live hook, in
**ascending `priority` order (lower numbers first), ties broken by registration
order**. Every live hook sees the command; a hook unsubscribed before its turn
(by another hook, or because some hook called `dispose()`) never runs. The hook
receives a **detached copy**; mutating it has no effect.

The hook returns exactly one of:

- `undefined` / `null` — leave the command as it currently stands;
- a replacement command — validated before commit; an invalid replacement is
  rejected, attributed to the mod, and the previous value is kept;
- `false` — cancel the commit.
- anything else (including a promise) — an error attributed to the mod; the hook
  contributes nothing. A result whose `then` getter throws is that same error,
  and the action standing before that hook is what commits.

A hook must not submit while dispatch is in progress: `api.actions.submit`
during hook resolution throws an attributed `ModError` (`stage: 'action'`) and
changes nothing. A hook that wants a different action returns a replacement
command or `false`; a rejected submission is never counted as a command.

**Cancellation wins.** A `false` from any hook cancels the commit even if other
hooks returned replacements, and a later hook cannot overturn that veto. The
outcome is therefore independent of priority order; only which replacement wins
depends on order.

**Cancellation cannot be blocked.** An explicit `{ type: 'cancel' }` — Stop,
Escape, window blur, pause, tab hidden, mod reload — bypasses hooks entirely and
goes straight to the engine. Mod hooks only observe and alter assisted movement.


### Navigation queries and import

`getBounds()` returns `{ active, minCx, minCy, maxCx, maxCy, cells }`: inclusive
cell-index extents of committed navigation. Each cell is **256 × 256 tiles**;
these are not actor-position limits and holes inside the extents can be unloaded.
With no imports `active` is false and `cells` is zero. `getNavFlags(tileX, tileY)`
requires signed int32 integers and returns bits: `1` solid, `2` south wall,
`4` east wall, `8` floor, `16` water, `32` room. `0xFFFFFFFF` means unloaded,
not a traversable tile. Both queries are detached/authoritative, callable during
activation, hooks, ticks and cleanup; no memory addresses or WASM views are exposed.

`importNavigationCell(cx, cy, bytes)` requires integer cell indices in
`[-100, 100]` and a `Uint8Array` or `DataView` of the complete navigation format:
header `00 01`, exactly 1024 row-major 8 × 8 records, tag `0..5`; only tag `2`
carries 64 tile bytes, each using bits `0..0x3F`. Truncation, trailing bytes,
unknown tags/bits and invalid coordinates are refused **before hooks run**.
Input bytes and each callback payload `{ cx, cy, bytes }` are detached.
`beforeWorldImport` callbacks run in ascending finite priority, ties by registration
order, and return `false` to veto or `undefined`/`null` to leave the import alone.
No replacement payload is accepted. All still-live callbacks run; cancellation wins,
and unsubscribing/disposal before a callback's turn prevents it from running.
Throwing, invalid-return and promise-returning callbacks contribute no veto and are
attributed rather than breaking other callbacks. Promises are not awaited.

The result is `{ committed, cancelled, submittedBy, cancelledBy?, snapshot }`.
On veto, neither navigation nor movement is committed; otherwise WASM validates
and imports the cell, atomically replacing the same coordinate and **cancelling
movement without relocating the actor**. Engine refusal leaves its existing world
unchanged and throws `ModError` with stage `world`. Nested imports, action submissions
(including cancellation) and steps during precommit resolution are refused.
Imports can otherwise be made from activation, tick callbacks or cleanup. There
is **no automatic import undo**, including when activation later fails: mods own
their persistent navigation effects. In the app committed imports are retained in
the world's save provenance. Unsupported engine extensions throw an attributed
`world` error; they never return fake flags/bounds or disable original movement.

### Namespaced saved documents and schema migration

`saveData` selects the mod's `manifest.id` automatically; no caller-supplied key
can select another namespace. `read()` returns detached data (`undefined` only if
absent); `write(value)` validates and detaches before replacing the backing record
`{ schemaVersion, data }`. Reads clone before exposure; writes clone before storage.
Finite numbers, strings, booleans, null, dense arrays and plain data objects are
accepted. Cycles, undefined (including nested values), functions, BigInt, symbols,
accessors, sparse arrays, custom objects such as Date/typed arrays, non-enumerable
object properties and lossy `toJSON` tricks are refused. The **complete record**
must fit 256 KiB of UTF-8 JSON. Invalid/oversized input never reaches backing writes.
No namespace is allocated just by reading or loading; absent/disabled mods' opaque
records remain untouched. There is no automatic write undo on unload/activation failure.

`manifest.saveSchemaVersion` defaults to `1` and must be a positive safe integer.
When a stored record differs, the host requires the module's pure synchronous export:

```js
export function migrateSaveData(oldVersion, data) {
  if (oldVersion !== 1) throw new Error('Unsupported saved schema');
  return { points: data.score }; // example migration to manifest.saveSchemaVersion = 2
}
```

Migration runs **before `activate`**, receives detached old data, and must return
valid JSON within the same cap. The old record is retained on missing/throwing/async/
invalid migration; activation is refused (`stage: 'saveData'`) rather than wiping it.
Successful migration writes the new schema before activation and remains even if
activation subsequently fails. Both upgrades and downgrades require migration when
versions differ. A schema changed externally while a mod is loaded makes `read()` and
`write()` fail, not silently migrate or overwrite. Save API misuse/backing failures throw attributed
`saveData` errors. Storage callbacks must be synchronous and atomic; a backing that
mutates then throws cannot be rolled back by this host.

`createModHost(engine)` alone uses **per-host, non-durable memory**. Durable app
integration passes `{ readModState(id), writeModState(id, record) }`; both callbacks
are required together, the read returns a record or undefined, and write returns
nothing. The page owns saving/restoring the envelope and preserving unknown ids;
the SDK never enumerates or rewrites other namespaces.

### Committed tick events

`mods.step(seconds)` calls the real engine step, then dispatches `onTick` listeners
with `{ seconds, snapshot }` from that completed step. The page supplies the fixed
clock; the engine accepts finite seconds in `(0, 0.1]`. Refused steps emit nothing.
Callbacks have finite priority/registration ordering and per-listener detached snapshots,
so a callback's movement command affects subsequent simulation, not the captured event.
Listeners added during dispatch start on the next step; withdrawal/disposal before a
listener's turn skips it. Recursive steps and steps inside precommit hooks throw
`ModError`/`tick`. Missing engine stepping support also throws, never fabricates an event.
Listeners return `undefined`/`null` synchronously. Exceptions, other returns and
promises are attributed (`onTick`, rejected promise `onTick.late`); subsequent listeners
still run and the completed step is never undone. Unsubscribe returns true once,
then false; all listeners are withdrawn on failed activation or unload.

### Callback trust limits

These contracts are **not a sandbox or a general transaction**. A veto prevents the
pending import/action, not arbitrary effects from trusted callback code: callbacks
can call other permitted API methods, change page globals or directly access page
services. A synchronous-only result check observes returned promise rejection; it
cannot halt an async function's body, a scheduled timer or effects before a throw.
Precommit callbacks and migrations must keep themselves pure; tick callbacks own
their effects. Inert handles/withdrawn registrations prevent later SDK use after unload,
not direct browser/global access. Existing `beforeAction` failure/veto semantics are unchanged.

## Host surface

```js
import { createModHost } from './mods.js';
const mods = createModHost(engine);
```

| Member | Behaviour |
|---|---|
| `api` | A host-owned handle with the same surface mods get, for parity checks and tests. Errors are attributed to `modId: 'host'`. |
| `load(url)` → `Promise<{ id, version, name }>` | Imports, validates and activates one module. Throws an attributed error on import, manifest, duplicate-id, API-version or activation failure. |
| `command(action)` → `ModCommandResult` | Runs host input through hooks, then commits once. Throws for a malformed action (`modId: 'host'`). |
| `step(seconds)` → `void` | Executes one engine step, then emits ordered `onTick` callbacks. The page retains fixed-step scheduling and pause ownership. |
| `dispose()` → `void` | Unloads every mod: cleanup runs in reverse load order **while the handle is still live**, then the handle goes inert and its hooks are withdrawn. Synchronous; the host stays usable for further `load()` calls. |
| `diagnostics()` → `ModDiagnostics` | Detached evidence: loaded mods, `hookCount` (action/import/tick registrations), action counters and the last 20 attributed failures. |

`ModCommandResult` is `{ committed, cancelled, submittedBy, modifiedBy,
cancelledBy?, snapshot }`: whether the engine received a command, who submitted
it (`'host'` for page input, otherwise the mod id), which mods replaced it
(dispatch order), the first canceller, and the resulting engine state.

`ModDiagnostics.errors` entries are `{ modId, stage, message }`. `modId` is the
mod id, the module URL when the failure happened before a manifest was read, or
`'host'`. Stages include `load`, `manifest`, `activate`, `cleanup`, `beforeAction`,
`api`, `action`, `movement`, `hooks`, `world`, `saveData`, `tick`, `beforeWorldImport`
and `onTick`. `.late` stages record rejected returned promises at synchronous boundaries
(`beforeAction`, `beforeWorldImport`, `onTick`, `saveData`, `activate`, `cleanup`):
they are observed to avoid unhandled rejection, recorded after the fact, and never
used as deferred command/import/migration/tick decisions.

## Lifecycle and ownership

1. `load(url)` — import → validate manifest → require unique id → require
   `activate` → validate own saved namespace and migrate incompatible schema.
2. `activate(api)` runs synchronously. The host records the speed in effect
   first.
3. If `activate` throws, or returns something that is neither a function nor
   nothing, activation is rolled back: the mod is not listed, **its hooks are
   withdrawn** (including import hooks/tick listeners), and the **speed is restored** to the recorded value. The
   rejection carries `stage: 'activate'`. An `async activate` lands here because
   its promise is not a cleanup; that rejection is recorded as `activate.late`
   instead of being left to the page unhandled.
4. While loaded, the mod owns its own effects. `dispose()` runs each cleanup
   last-loaded-first, attributing (but never hiding) a throwing cleanup, and
   always unloads the mod afterwards. A cleanup that returns a value — including
   a promise — is reported and not awaited; a rejected promise from one is
   recorded as `cleanup.late` rather than left unhandled.
5. A mod that fails to clean up after itself is a bug in that mod; the host only
   guarantees failed-activation registration withdrawal and speed restoration,
   not a transaction over navigation imports, saved documents or page state.

Ownership summary: the page owns the loop, input and UI; the host owns hook
ordering and unload order; each mod owns its effects and their undo; the WASM
engine owns the rules and the final say on every value.

## Errors

Every host failure is an `Error` with `name === 'ModError'` and `modId` /
`stage` properties, e.g. `activate failed for 'fx-boom': activation exploded`.
Hook exceptions, invalid replacements, promise-returning hooks and throwing
cleanups are recorded in `diagnostics().errors` instead of breaking the player's
input: a broken mod must not stop the game. Malformed host input and misuse of a
mod handle are thrown to the caller.

## Local mod packages (`src/mod-manager.js`)

The directory workflow: copy a package into `content/mods/<folder>`, index that
content directory, and privately serve it beside the app. `/content/manifest.json`
lists JavaScript packages as `{root,kind:'javascript',files}`; startup fetches and
installs those bytes through the existing manager, without a web folder picker.
New installs are disabled until explicitly enabled; updates preserve the existing
enabled flag. Enabled packages load in dependency order on startup. The manager
never rewrites or inlines JavaScript; provisioning does not modify the original game.

After copying a package, rebuild the manifest externally:

```sh
node scripts/provision-content.mjs --index-only --output content
```

Use the same directory for `/content/` on a private static host, or the local server's
`CONTENT_ROOT` mount. Content and proprietary mod assets remain outside Git and app
releases. Transferring this directory is asset portability; save-backup JSON
import/export is a separate workflow.

```js
import { createModManager } from './mod-manager.js';

const packages = createModManager(mods);
```

| Member | Behaviour |
|---|---|
| `install(files)` → `Promise<metadata & { requiresReload }>` | Validates manifest-fetched file-like package records, then stores every file in one transaction. Any validation or storage failure leaves the previously installed package intact. A first install starts `enabled: false`; an update keeps the current flag. |
| `list()` → `Promise<metadata[]>` | Every installed package, detached, by id. |
| `setEnabled(id, enabled)` → `Promise<metadata & { requiresReload }>` | Persists whether that package loads next time. Nothing already running is undone. |
| `remove(id)` → `Promise<void>` | Deletes the record and every stored file; code already loaded stays loaded until the host disposes it. |
| `activateEnabled({ safeMode = false } = {})` → `Promise<report>` | Loads each enabled package through `mods.load()` in resolved order. `safeMode: true` performs no module import at all. |
| `diagnostics()` → `ModManagerDiagnostics` | Detached evidence: database, worker, packages, last activation, the last 20 manager failures and `requiresReload`. |

Every manager failure is an `Error` with `name === 'ModManagerError'` plus `modId`,
`stage` and `ids` (the packages involved). `resolveModOrder(packages, apiVersion)`
is exported on its own, so the rule set below is testable without a browser.

### Package format

A package is an externally copied/provisioned folder. The content loader supplies
file-like records (`name`, `size`, `webkitRelativePath`, `arrayBuffer()`) to the manager:

```text
content/mods/my-mod/
  mod.json          manifest, required, at the package root
  main.js           entry module: `manifest` + `activate`
  lib/util.js       imported as './lib/util.js' from main.js
  art/tile.png      fetched as './art/tile.png'
```

`mod.json`:

```json
{
  "id": "my-mod",
  "name": "My mod",
  "version": "1.0.0",
  "apiVersion": "0.1.0",
  "description": "optional",
  "entry": "main.js",
  "dependencies": { "util-lib": "1.0.0" },
  "optionalDependencies": { "fx-pack": "2.0.0" },
  "conflicts": ["other-walking"],
  "loadBefore": [],
  "loadAfter": [],
  "assets": ["art/tile.png"],
  "settings": {}
}
```

- `id` uses the same pattern the host accepts and `host` is refused; `version` and
  `apiVersion` are dotted `major.minor.patch`; `entry` is a package-relative `.js`
  or `.mjs` path that must be one of the provisioned files; `assets` entries must name
  provisioned files. `description` and `settings` are optional.
- Dependency versions are **exact dotted versions** — no ranges, no `^`, no
  wildcards. Anything else is refused at install rather than reinterpreted at load.
- `dependencies` must be installed **and enabled** at exactly that version;
  `optionalDependencies` only constrain the version when that package is installed
  and enabled; `conflicts` refuse the pair outright.
- `loadBefore` / `loadAfter` are ordering hints and may name packages that are not
  installed. A required dependency orders too: it loads before what needs it. Among
  packages ready at the same moment the lowest id goes first, so the order is stable
  and independent of install order. A cycle — including a mutually dependent pair —
  is rejected with the ids that form it.
- `apiVersion` is compared with the host's actual version (`mods.api.version`), never
  a version baked into the manager, so a package written for another API version is
  named in the report instead of half-loaded.
- `settings` is stored for the host UI. API 0.1.0 gives mods no settings channel, so
  the sample mod still ships its own settings module.
- Bounds: at most **512 files**, **16 MiB per file**, **64 MiB per package** and
  **64 KiB for `mod.json`**. Paths are ASCII `[A-Za-z0-9._-]` segments; absolute
  paths, `..`, backslash escapes, NUL and duplicate targets are refused. Served
  types: JavaScript, JSON, CSS, WASM, PNG/JPEG/GIF/WebP/ICO and OGG/MP3/WAV/M4A —
  anything else is refused at install rather than served.
- There is **no zip parser** in this milestone: packages use the directory workflow;
  archive packaging/transfer support remains an outstanding capability.

### Storage and serving

Packages live in the dedicated IndexedDB database `pz-mod-packages` (schema 1):
`packages` keyed by id, and `files` keyed by `[id, revision, path]` with a
`packageId` index. Install and remove each run in a single transaction.

`mod-worker.js` is a module service worker the manager registers at the application
root. It intercepts `/__mods__/<id>/<revision>/<path>` and nothing else: the app
shell, the WASM engine and everything you import stay untouched on the network, and
no `caches` API is involved. Responses carry the recorded MIME type plus `no-store`
and `X-Content-Type-Options: nosniff`; a malformed or traversing path, an unknown
id, a wrong revision or an absent file is a plain 404. The revision is a SHA-256
digest over every path and file digest, so an update changes every URL the package
owns and a stale module entry cannot be reused. Native ESM resolution does the rest:
relative imports and asset URLs inside a package work exactly as written.

The manager registers that worker and waits for real control (`clients.claim()` on
activation) before loading a stored package. If some other service worker owns the
origin it says so, because package files would never be served.

### Activation, enable/disable and reload honesty

```js
const report = await packages.activateEnabled();
```

`report` is `{ safeMode, apiVersion, order, activated, errors, skipped, disposed }`.
`errors` entries carry `{ id, modId, stage, message }`, using the host's own
attribution where one exists. A load or identity failure stops the sequence, and if
this call had already loaded something the host `dispose()`s it — which also unloads
any other mod on that host, because API 0.1.0 has no per-mod unload. The loaded
module's `id` and `version` must match the installed package, or the mismatch is
reported and the activation unwound. No general state rollback is claimed: a mod
that failed to undo its own effects is a bug in that mod.

`install`, `setEnabled` and `remove` change the configuration for the **next**
activation, and their `requiresReload` says whether the running set still matches
it — the UI shows that rather than pretending an arbitrary live undo.
`activateEnabled({ safeMode: true })` imports nothing at all, which is how a broken
package is gotten past at startup.

In the app's **Local mod packages** section, provisioned JavaScript packages and
native Lua adapters are installed from the content manifest. New packages are
disabled. Explicitly enable each package's **Enable … after reload** checkbox,
then use **Reload to apply saved configuration**. Disable or remove stored
packages through the same manager; configuration changes do not run or unload code
live. The UI reports actual running identities, activation order, skipped packages
and attributed errors. Storage and package failures remain separate from GPU errors.

### Native Lua directory packages

`kind:'native-lua'` now uses original `.lua` text through the local Wasmoon VM,
not JavaScript rewrites. `mod.info` supplies exact, case-sensitive native identity,
name, `modversion`/`version`, `require`, `loadAfter`, `loadBefore` and `versionMin`.
The loader selects `common/` plus the highest numeric tree no newer than
`sourceBuild.version`, replacing common files at matching relative paths. Metadata
may come from an older compatible tree when the selected code tree has no
`mod.info`. Packages without version/common trees use their root. Unknown builds
remain discoverable and disabled; enabling them fails explicitly. Provision the
**observed installed version** with `--source-build`, never an assumed version.
An incompatible minimum/tree also refuses activation.

SDK ids are `native-` plus the native id lowercased with unsupported characters
replaced by `-`; duplicate exact identities and canonical-id collisions are
refused, including collisions with JavaScript/stored package owners. Native ids
remain unchanged in VM attribution and metadata. Ordinary three-component numeric
native versions stay unchanged. Versions outside that SDK grammar use a
**lossless identity encoding**, not invented semantic compatibility:
`00.0.<decimal integer of hex 1 followed by the original version's UTF-8 bytes>`.
The `00.0.*` namespace is reserved, so original versions in that namespace are
also encoded and cannot alias a different original string. An absent version is
`00.0.0` and displayed as unspecified. The UI displays the original string; saves
retain its exact identity. There is no upgrade/version shim.
Required native ids map to the installed target's exact SDK version and use the
existing dependency resolver; missing/disabled dependencies and cycles fail before
any package code runs. Optional ordering edges do not implicitly enable code.

Private IndexedDB packages contain a small SDK adapter and `native.json` with
selected original Lua text and metadata. Nothing is added to the tracked asset-free
delivery. Original package file-count/byte limits apply; the serialized descriptor
also obeys the SDK's 16 MiB single-file limit. Selected enabled sources are all
preloaded before activation so cross-package require ownership is established.
Engine `media/lua/{shared,client,server}` files are fetched only for the transitive
**literal require** graph reachable from those selected sources and registered
`execute:false`; the engine Lua tree is never eagerly executed or fetched in full.
The lexical scan skips comments and string bodies; it does not infer aliases,
shadowing or dynamic control-flow reachability. Engine-source API calls inherit
the actual initiating native package's public API while retaining engine source
attribution. Engine callbacks capture that initiator for cleanup and namespace
ownership; require-only engine roots are not extra active/save owners.
Dynamic engine require names currently fail honestly rather than synthesizing
engine APIs. Provision the actual required engine files alongside the startup
assets; `--startup-only` alone does not include those engine Lua classes.

Each game session owns a fresh VM. New/load transitions restore each package's
public save namespace before its Lua executes. `OnCreatePlayer` and `OnGameStart`
dispatch once per transition; `OnLoad` dispatches only for a load (including
recovery/import). Tick/player movement and focused gameplay keyboard events use
the existing host. Save and live export flush mutable Lua tables before capture.
Each transition stages a separate host bound directly to its target engine and
namespace backing while the committed host/VM stays alive. Only after target
activation, exact-version checks and bootstrap succeed is the prior VM flushed,
closed and its host disposed. Failure discards only the uncommitted target and
retains the prior engine, namespaces, callbacks and initialized Lua closure locals.
No previous mod is re-executed or bootstrapped on rollback. Package consent writes
and session operations are mutually excluded during staging and initial boot.
Saved-mod exact-version checks remain in force: disabling a mod does not make its
old save silently compatible. Stored native identities participate in dependency
and ordering resolution even when their source root is no longer in the current
directory index. All enabled descriptors are checked against the current observed
build; unknown or changed builds refuse cached-source activation until matching
original sources are rediscovered.

This proves a native execution/save boundary, **not full Workshop feature support
or Kahlua equivalence**. Barefoot Moodle still needs genuine footwear/item
condition state and MoodleFramework texture/UI/Java option facilities. Hide in Car
needs actual vehicles, ghost-mode state and sandbox options. P4HasBeenRead needs
inventory/read-state/context menus, textures, translations and options. These
facilities still raise attributed unsupported-capability errors; no fake
item/UI/Java results are supplied to make packages appear compatible.

#### Runnable native proof

After the parent build, `node --test tests/native-mod-loader.test.js` exercises
independently authored common/numeric overlays (including a code tree with no
`mod.info`), root-only packages, transitive require-only engine sources, actual
WASM speed/action changes, dependency/cycle refusal, exact identity collisions,
unknown/minimum/current-build refusal, stored dependency ownership, inert pseudo-
requires, engine getter/callback API attribution, namespace restore, callback
cleanup and retained initialized closures after a failed staged load.

For the actual application path, use an **owned disposable browser profile/origin**
with working provisioned original startup content and a known observed
`sourceBuild.version`. On an already-open Puppeteer page:

```js
const { checkNativePackageReload } = await import('./scripts/check-browser-native.mjs');
const evidence = await checkNativePackageReload({ page, assert });
```

The helper appends only independently authored Lua/metadata through request
interception using the real directory range protocol. It checks default-disabled
discovery, the existing enable checkbox, reload activation, a native tick changing
the real WASM walk action, actual app Save, namespace reload and once-only
bootstrap, failed-load rollback preserving initialized closure state without
bootstrap replay, racing consent rejection during a delayed engine-source read,
safe-mode zero execution, and disabling/cleanup with truthful saved-mod mismatch
refusal. It returns synthetic namespace/provenance metadata only, never
original cells, source, assets or screenshots. It intentionally leaves the owned
fixture disabled with its backup retained; use a disposable profile, not a user's
valuable play session.

**Reload in safe mode** adds `?safe-mods=1` and imports no local packages. Installed
bytes and configuration remain available, so a broken package can be disabled or
removed before **Reload normally** removes that parameter. The bundled walking
example keeps its live toggle when no local packages are active. While local
packages are active, that toggle is disabled with an explanation: the existing
host can only dispose all mods, and must not silently unload package hooks.

## What is still deliberately absent

Enabled installed packages load automatically at startup, unless `?safe-mods`
is present. This is not an origin policy — the trusted loader performs no origin
or sandbox check of its own, and packages are trusted code. Beyond the package
manager there is **no zip import, no
per-mod live unload, no content/asset/animation or
audio APIs, no UI registration and no settings channel into `activate`**. Those are
later M2–M5 work in [`../ROADMAP.md`](../ROADMAP.md); no placeholder APIs exist for
them now.

Also unchanged from [`../DECISIONS.md`](../DECISIONS.md): the API is delivered at
this scope only, and the engine ABI stays internal to `src/engine.js`.
