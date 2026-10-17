# Qualified currentThread scheduling boundary

This adapter provides a cooperative scheduling opportunity at the actual Java
`Thread.currentThread()` host-service boundary. It does not implement general
preemption. In particular, an original `LightingThread.stop()` loop containing
only `Thread.isAlive()` remains outside this repair.

Preparation downloads the official CheerpJ 4.3 runtime and loader from
<https://cjrtnc.leaningtech.com/4.3/>. Those proprietary sources and their derived
outputs must stay in ignored build directories. Copyright notices and the
original runtime are retained; no runtime source is committed here.

The original runtime SHA-256 is
`5bcf00711009cbb12b858dcbea865cfe0e9d652cfc95f55ad20a600724462644`;
the original loader SHA-256 is
`5b0ec873d1ae97d184928041b5f97ecf36eb990dac3baec5836a90bd87fa7a9f`.
Preparation requires the full hashes and exactly one qualified `an1` body.
Only that runtime body changes. No diagnostic sleep wrapper is included.

Original `an1` allocates a local-reference slot for the real current Java thread
object (`Q.a7`), increments the real slot cursor, and returns the real slot index.
The adapter preserves those operations. When the runtime's existing scheduler
clock has exceeded 16 milliseconds, it uses the same continuation form found in
the adjacent shipped native interrupt-status service: `a1`, continuation `f:7`
at `pc:73`, the actual result index in `Q.a8`, then `CheerpJContinue`.
Original native-return conversion resolves the reference before `oN` clears
the local-reference frame. No thread status, identity, or completion flag is
invented or assigned by this adapter.

The separately derived loader function preserves its original initialization,
ten public export assignments, actual `cj3Init` call, and pending applet handling.
Its sole source substitution imports `/scheduler-runtime/cj3.js`. Original
`cj3LoaderPath` stays on the official CDN, so actual WASM and JRE resources retain
their original loading path. The starter calls this derived function directly:
assigning a global loader alias would not replace the original captured binding.
This is a source-pinned internal loader adaptation, not a documented CheerpJ API.

To use this isolated component, call `prepareSchedulerRuntime(outputDirectory)`
on the Node side and serve its three immutable files at `/scheduler-runtime/`.
Serve `scheduler-runtime.js` as a normal module, load the original official
loader script, and call `startSchedulerRuntime(options)` instead of `cheerpjInit`.
The same-origin server must serve the exact immutable prepared snapshots during
validation and subsequent module imports. The starter checks fixed derived
hashes before evaluation; arbitrary mutable routing is not qualified. It shares
one promise for the same options object and rejects a conflicting second start.
After it resolves, `installUnsafeShortRepair(cj3Module)` and
`installNativeLibraryLoader(cj3Module)` can install on the actual initialized
runtime exports. Existing profiles are not
migrated by this increment.

The pinned original `cheerpjInit` wrapper does not assign `cj3InitOptions` from
the supplied options. It checks the module, calls
`cj3AttachBodyObserver(false, cj3InitOptions)`, then calls `cj3LoadImpl(options)`.
The global options initially remain `{version:8}`; only applet-runner mode merges
them. The starter preserves that distinction. The public gate asserts the
global object's identity/content remain unchanged, while Java observes the
supplied `user.home` and `user.dir`, and the supplied native report callbacks run.

Run `node browser-jvm/verify-scheduler.mjs` with `PZ_JDK`, `PZ_GAME_JAR`,
`PZ_BROWSER`, and optionally `PZ_SDK` pointing at an immutable prepared SDK.
The verifier checks missing and changed runtime rejection before VM startup,
then standard Java main/two-worker identity under allocation, GC and exception
pressure, and original idle `WorldStreamer.create()` / `stop()`. The latter
uses unchanged offline defaults, original random initialization, empty work
queues, actual thread liveness and a bounded Java sleep before original stop.
It does not initialize a world, load chunks, start a native game/server, or mount
installed user data. Its private browser filesystem owns the user home.
Node deadlines and exact owned-process cleanup bound a starving renderer.

The earlier private baseline demonstrates that the same original WorldStreamer
stop can starve a cooperative worker without this boundary. The public gate
qualifies termination through original stop, not a general worker-shutdown fix.

The fresh public gate passed five cases on 2026-10-17 using an immutable prepared
SDK: forced owned-renderer termination, missing runtime, changed runtime, standard Java stress, and original
WorldStreamer stop. The standard stress recorded 3,293,947 loop iterations and
101 explicit GC requests across main and two workers; both workers progressed
before join and terminated with identity/finally checks intact. All 18 input
hashes were unchanged, no disallowed request occurred, and all five browser
processes closed. Raw local evidence is generated at
`target/browser-jvm/scheduler/result.json`; it is not committed.

Cleanup uses Playwright BrowserServer.close() with a bounded BrowserServer.kill()
owner-handle fallback. The public forced-termination case enters an actual busy
renderer loop and confirms actual ChildProcess exit before closed=true is recorded.
There is no numeric-PID fallback in the verifier. The API contract is documented in
<https://github.com/microsoft/playwright/blob/main/docs/src/api/class-browserserver.md>.
