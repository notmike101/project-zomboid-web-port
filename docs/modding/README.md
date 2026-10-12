# Mod API 0.1.0 (experimental)

A mod is an ES module of plain JavaScript — no compilation, no build step, no
packaging tool. The host is `src/mods.js`; the same contracts are declared in
[`../../types/mod-api.d.ts`](../../types/mod-api.d.ts) for editors. The shipped
sample is [`mods/accessible-walking/main.js`](../../mods/accessible-walking/main.js),
which imports [`mods/accessible-walking/settings.js`](../../mods/accessible-walking/settings.js)
and changes the real WASM movement speed.

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

`manifest` and `activate` are the only required exports. Extra exports are
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

`ModSnapshot.action` is numeric: `0` idle, `1` travelling to a destination, `2`
walking a heading. World coordinates are within `[0, 10]`; position starts at
`(5, 5)`.

### Commands

```js
{ type: 'moveTo', x, y } // destination inside [0,10]^2; destinations are refused, never clamped
{ type: 'walk', x, y }   // any finite signed heading, normalised by WASM; only (0,0) cancels
{ type: 'cancel' }       // stops movement, position unchanged
```

Movement actions from browser clicks, keyboard, destination forms, accessible buttons
and `api.actions.submit` use one shared precommit hook path. Explicit safety cancellation
deliberately bypasses veto; it cannot be blocked by mods. The host validates known types,
finite components, and `[0,10]` bounds for destinations only. Direction components may
be negative or arbitrarily large/tiny finite numbers. WASM validates original F64 input
before conversion to F32 state, avoiding boundary-rounding escapes. The host does not step
or reset the engine: the host page owns the fixed 60 Hz step and the delta cap.

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
| `dispose()` → `void` | Unloads every mod: cleanup runs in reverse load order **while the handle is still live**, then the handle goes inert and its hooks are withdrawn. Synchronous; the host stays usable for further `load()` calls. |
| `diagnostics()` → `ModDiagnostics` | Detached evidence: loaded mods, `hookCount`, counters and the last 20 attributed failures. |

`ModCommandResult` is `{ committed, cancelled, submittedBy, modifiedBy,
cancelledBy?, snapshot }`: whether the engine received a command, who submitted
it (`'host'` for page input, otherwise the mod id), which mods replaced it
(dispatch order), the first canceller, and the resulting engine state.

`ModDiagnostics.errors` entries are `{ modId, stage, message }`. `modId` is the
mod id, the module URL when the failure happened before a manifest was read, or
`'host'`. Stages: `load`, `manifest`, `activate`, `cleanup`, `beforeAction`,
`api`, `action`, `movement`, `hooks`, plus `beforeAction.late`, `activate.late`
and `cleanup.late`: a `.late` entry is the rejection of a promise a mod returned
where the contract is synchronous, observed so it never becomes an unhandled
rejection, recorded after the fact, and never able to change the outcome.

## Lifecycle and ownership

1. `load(url)` — import → validate manifest → require unique id → require
   `activate`.
2. `activate(api)` runs synchronously. The host records the speed in effect
   first.
3. If `activate` throws, or returns something that is neither a function nor
   nothing, activation is rolled back: the mod is not listed, **its hooks are
   withdrawn**, and the **speed is restored** to the recorded value. The
   rejection carries `stage: 'activate'`. An `async activate` lands here because
   its promise is not a cleanup; that rejection is recorded as `activate.late`
   instead of being left to the page unhandled.
4. While loaded, the mod owns its own effects. `dispose()` runs each cleanup
   last-loaded-first, attributing (but never hiding) a throwing cleanup, and
   always unloads the mod afterwards. A cleanup that returns a value — including
   a promise — is reported and not awaited; a rejected promise from one is
   recorded as `cleanup.late` rather than left unhandled.
5. A mod that fails to clean up after itself is a bug in that mod; the host only
   guarantees rollback for activations that failed before it could hand back a
   cleanup.

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

## What M1 deliberately does not have

Loading is `import(url)` of an already-importable module. The delivered app only
ever loads its own bundled same-origin sample; that is the shipped UI, not an
origin policy — the trusted loader performs no origin or sandbox check of its
own, and mods are still trusted code. There is **no local multifile package
import, no mod
manager, no enable/disable persistence, no dependency resolution, no mod
storage, no content/asset/animation/audio APIs, and no UI registration**. Those
are the M2 "basic local mod management" gap, tracked in
[`../ROADMAP.md`](../ROADMAP.md); no placeholder APIs exist for them now. The
only packaging mechanism today is ordinary ES module imports between files a mod
author ships, as the sample demonstrates.

Also unchanged from [`../DECISIONS.md`](../DECISIONS.md): the API is delivered at
this scope only, and the engine ABI stays internal to `src/engine.js`.
