# Incremental original-bytecode compatibility

## Current answer

Useful isolated Java gameplay logic can run unchanged in browser WASM.
We have verified eight gameplay classes and two supporting nested types across seven JVM/browser probes.
The current total is **72 cases and 440 exact output comparisons**, with zero mismatches or browser errors.
Two larger compile-only diagnostics fail. They are not included in the passing totals.

This is not a percentage of the game. Class counts do not measure playable coverage or integration cost.
The JAR contains 23,829 class files, including 5,095 under `zombie/`. Most remain unexamined.
No world or character simulation has run in the browser. The two installed Lua helpers described below now execute unchanged through the shipped compiler/interpreter.

## Evidence levels

- **Browser pass:** unchanged original methods ran in WasmGC and matched the installed JVM.
- **Static boundary:** inspected bytecode reaches additional engine initialization or a native method. No execution claim follows.
- **Unverified:** no matching browser result exists.

## Browser-tested map

| Area | Original implementation | Cases | Exact comparisons | Result |
|---|---|---:|---:|---|
| Character angles | `PZMath.getClosestAngle`, `lerpAngle`, and their arithmetic closure | 8 | 16 | PASS |
| Stateful weather values | `SteppedUpdateFloat` constructor, `setTarget`, `update`, `value`, `getTarget`, and private clamp | 8 sequential updates | 16 | PASS |
| Weather noise | `SimplexNoise.noise` in 2D, 3D, and 4D, gradient helpers, and static tables | 8 points | 24 | PASS |
| Climate front state | `ClimateManager.AirFront` constructor, reset, type changes, samples, getters, save, and load | 8 sequential samples | 112 | PASS |
| Seeded erosion distributions | `Noise2D.addLayer`, `layeredNoise`, `reset`, and original layer objects | 16 samples across 4 configurations | 16 | PASS |
| Connected climate colors | Original color objects, interpolation, output aliasing, copy isolation, scaling, and 32-byte serialization | 8 | 128 | PASS |
| Browser storage bridge | Original climate-front records saved to OPFS and continued after fresh page/module loads | 8 | 112 | PASS |
| Original memoization | LazyValue constructor/get, identity/null caching, retry, and reentrant exchange witness | 8 | 16 | PASS |
| **Total** | Seven standalone probe modules | **72** | **440** | **PASS** |

The weather suite combines state transitions and noise. The other suites remain separate.
These modules contain newly authored adapters and compiler runtime support. They contain no replacement gameplay algorithms.

### Weather probe

The state object starts at zero, with step 0.2 and range zero through one.
Its sequence tests rising, a zero delta, overshoot, target clamping, falling, and stable endpoints.

Noise points include origin, positive and negative coordinates, mixed signs, and weather-scale coordinates.
Three points straddle `(1,-1,0,0)` using adjacent binary64 values for the first coordinate.
The exact point has zero coordinate sum and integer skewed coordinates, which exercises lattice selection boundaries.

All results retain raw binary32 or binary64 bits as hexadecimal strings.
Exact equality was the rule before execution. There was no tolerance adjustment.
The selected noise closure uses arithmetic and `Math.sqrt`, with no native or transcendental trigonometric calls.

Static callers include `WeatherParticle.update` and `ClimateManager.updateWindTick`.
`WeatherPeriod` also calls the original 2D noise method. These callers were inspected, not executed.

### Air-front probe

The original object receives warm-front samples `0.2, 0.8, 0.1, 0.1, 0.1`.
It then resets to a cold front and receives `-0.3, -0.9, 0`.
This tests accumulation, the short noise cache, peak retention, cache expiry, reset, and the zero-sample boundary.

After every sample, original `save` writes a 36-byte record into an in-memory stream.
A new original `AirFront` loads that record. Its saved bytes must match the original record exactly.
The next sample runs on that restored object. The probe never opens a save file.

Each case compares four float fields, one integer field, and nine serialized 32-bit words against the JVM.
The adapter also checks record length and exact in-memory round-trip equality on both runtimes.
This verifies this record format only. It does not establish native save-game compatibility.

`ClimateManager.CalculateWeatherFrontStrength` calls `AirFront.addDaySample` in the original game.
The nested static class runs without initializing the enclosing `ClimateManager`.
The source map names `ClimateManager.java` because the nested class shares that source-file metadata.
The JVM class log and WASM symbols establish that only `ClimateManager$AirFront` entered this game closure.

### Erosion probe

Original `Noise2D` starts with one seeded layer, then receives two more layers.
The probe samples four coordinates in each configuration, including negative and map-scale coordinates.
It then resets and reconstructs the three original layers with identical seeds, frequencies, and amplitudes.
An adapter assertion requires exactly identical reconstructed results on both runtimes.
The fourth configuration resets again and uses different seeds.

There are no empty-layer samples. Every observed output must be finite.
Each sample compares its raw binary32 result with the JVM. All 16 comparisons matched.
The original erosion system uses this class for distributions such as moisture, minerals, and vegetation.
The experiment did not initialize `ErosionMain`, seasonal simulation, world tiles, or vegetation state.

### Connected color objects

`ClimateColorInfo` calls the original `Color` implementation, which uses original `PZMath` clamping during named-color initialization.
Cases cover default state, interpolation endpoints, fractions, scaling, aliasing either input, independent copies, and continuation after restoration.
Each result compares eight original float fields and eight serialized 32-bit words with the JVM.
JavaScript calls the exported `colorCase` adapter directly. The browser does not use Java main for this probe.

The default constructor retains its original alpha of `1/255`. The adapter does not replace that value with an idealized default.
Original callers include `ClimateManager.ClimateColor.calculate`, its admin serialization methods, and `WeatherPeriod` cloud-color persistence.
Those callers were inspected but not executed.

### Real browser storage

The `browser-save` probe uses a JavaScript host layer and the browser's actual origin-private filesystem, OPFS.
It stores original 36-byte records, checks exact byte readback, and reloads the page between samples.
Each new WASM instance restores its input from the stored file. It does not continue from a retained Java object.
The runner independently observes eight main-frame loads and checks eight writes and readbacks.

The JVM baseline follows the existing original in-memory sequence. All 112 browser state and record checks match it exactly.
JavaScript transports and stores the original bytes. The original Java classes perform accumulation, save, and load.
This demonstrates a real host service, not a replacement gameplay algorithm or a fake filesystem response.

`verify-host.mjs` also verifies a mismatch, corrupt reads, a truncated file, and an injected quota failure.
It rejects six malformed snapshot, invalid-index, and invalid-write inputs, and checks that a rejected write preserves stored data.
The test browser owns a temporary profile. Persistence across page reloads is verified, but browser-restart durability is not.
This is one record integration, not an implementation of all Java file APIs or full game saves.

The [TeaVM loader documentation](https://teavm.org/docs/wasm-gc-backend/loader.html) describes calling exported Java methods from JavaScript.
The host uses the standard [OPFS API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system).

## Static boundaries

| Area | Observed path | Current conclusion |
|---|---|---|
| Shipped Lua execution | `KahluaThread.luaMainloop` bytecode offset 47 reads `Core.debug`. `Core.<clinit>` constructs `Core` at offsets 120–124. | The shipped VM reaches engine initialization before dispatch. It is not an isolated Lua runtime. |
| Shipped Lua tables | `KahluaTableImpl.rawget/rawset` read `Core.debug` and contain debugger paths through `LuaManager.thread`. | Creating a small environment does not remove the coupling. |
| Default Lua environment | `J2SEPlatform.setupEnvironment` registers libraries, creates a worker thread, and loads `stdlib.lua` through a file path. | Default setup also needs resource and runtime integration. |
| Lua-to-Java exposure | `MethodCaller` uses reflective method metadata and `Method.invoke`. Error handling reaches `UIManager.defaultthread` and exception logging. | Reflection compatibility and error paths remain untested. |
| Seasonal simulation | `ErosionSeason` construction calls `Translator.getText`. The normal text path reads `Core.debug`. Compiler reachability also retains localization/filesystem paths. | Compile-only attempt failed on missing backend library APIs. No original seasonal baseline executed. |
| Physics | `Bullet` calls `System.loadLibrary` and declares native operations. | The original native implementation cannot be supplied by Java bytecode compilation alone. |
| Rendering | `org.lwjgl.opengl.GL11` declares native OpenGL calls. | A browser graphics integration remains required for this boundary. |
| Audio | `javafmod` delegates to native `javafmodJNI` entry points. | Original FMOD Java wrappers do not supply a browser audio implementation. |
| Networking | `RakNetPeerInterface` declares native initialization, startup, and shutdown. | Original transport compatibility is unverified and needs a separate integration. |

The Lua loop itself remains unexecuted and uncompiled. Its shared `Core.debug` boundary now has an isolated compile-only diagnostic.
The `core` diagnostic failed. Its compiler graph includes original configuration callbacks, Lua event error handling, and native graphics loading paths.
These are compiler reachability findings. They do not establish that a successful desktop initializer executes every retained branch.
We did not replace `Core`, disable original checks, modify classes, supply gameplay stubs, or substitute another Lua runtime.

The first missing class in the `core` compiler output is `java.util.concurrent.ConcurrentLinkedQueue`.
Other missing symbols include `java.nio.channels.FileChannel`, class-loader resource APIs, and method handles.
The `season` output also identifies `System.exit`, `File.toPath`, newer `Path.resolve` signatures, and filesystem watch types.
Exact diagnostics remain private in `target/core/compile-wasm.log` and `target/season/compile-wasm.log`.
Before the runtime extension, both entries reported 160 missing references covering the same 31 declarations. The current Core and seasonal diagnostics are recorded below.
Missing classes can hide additional method and native implementation gaps, so this is not a complete porting work estimate.

Static refinement: Translator initializes its final text maps during class initialization.
The null-map branch does not prove automatic filesystem execution during the first translation call.
The unconditional `Core.debug` read at bytecode offset 658 establishes the shared initialization dependency instead.
No unavoidable native startup was established by the bounded static initializer inspection alone.

Other pure methods near these boundaries may still be reusable. A class containing a native method does not invalidate every method.
No claim here says that an entire subsystem is impossible to port.

## Versions, identities, and measurements

All seven original-game behavioral comparison commands returned exit code zero using TeaVM 0.16.0 and its `WEBASSEMBLY_GC` backend.
The two compile-only boundary commands returned nonzero without starting a baseline or browser.
They used the bundled Zulu 25.0.1+8 baseline and the local Temurin JDK 25.0.1+8 compiler.
Actual headless Chromium 153.0.8010.12 executed each module with WasmGC support.
Maven remains 3.9.16. The locked browser driver remains `playwright-core` 1.61.1.

The original JAR SHA-256 matched before and after each run:

`e1a69eb743ede60b213a0fe7f8b83d4fcab773036d256cc4543a336f3b058a33`

All original class bytes remained in place. Only the adapters compiled from authored source.
No original classes were downgraded, edited, decompiled into source, or recompiled.

| Probe | WASM bytes | Initialization | Adapter and output |
|---|---:|---:|---:|
| angles | 55,042 | 12.6 ms | 1.6 ms |
| weather | 87,044 | 9.1 ms | 3.0 ms |
| airfront | 67,208 | 8.0 ms | 2.5 ms |
| erosion | 64,196 | 9.3 ms | 2.4 ms |
| colors | 70,908 | 8.8 ms | 1.7 ms |
| browser-save | 74,427 | 91.6 ms across eight loads | 36.6 ms including OPFS writes/readbacks |

Sizes include each adapter, runtime support, names, and debug references. Do not add them to estimate a combined module.
Initialization includes module fetch, compilation, instantiation, and runtime initialization.
It excludes loader JavaScript and baseline fetch. Measurements describe single runs, not game-scale benchmarks.
The browser-save measurements sum eight module loads and operations. They exclude page navigation overhead.

Each runner closed its owned browser and loopback server.
An additional browser check confirmed that bit mismatches, missing output keys, and invalid WASM produce visible failure.
The matching control produced a visible pass. This check used local diagnostic code, without another test framework.
The repeatable host checks are published as `verify-host.mjs`.
An injected browser-close rejection also confirmed that the verifier closes its server on that cleanup failure.

## Rebuild all completed increments

Use the existing local prerequisites. No new dependency or global configuration change is required.
Set the explicit local prerequisite variables described in [README.md](README.md), then run from the repository root:

```powershell
& {
    $probeArgs = @(
        '--game-jar', $env:PZ_GAME_JAR,
        '--java', $env:PZ_JAVA,
        '--jdk', $env:PZ_JDK,
        '--maven-home', $env:PZ_MAVEN_HOME,
        '--browser', $env:PZ_BROWSER
    )
    foreach ($probe in 'angles', 'weather', 'airfront', 'erosion', 'colors', 'browser-save') {
        node compare.mjs --probe $probe @probeArgs
        if ($LASTEXITCODE -ne 0) { throw "Probe failed: $probe" }
    }
}
```

Omit `--probe` to run angles, as before. Select another passing probe by its table name for individual increments.
Each run replaces only its own generated directory, leaving other probe results intact.
The runner also checks loaded game classes against the statically inspected closure.

Private, ignored evidence:

- `target/angles/comparison.json`, `baseline.json`, `browser.json`, and build/class-load logs
- `target/weather/comparison.json`, `baseline.json`, `browser.json`, and build/class-load logs
- `target/airfront/comparison.json`, `baseline.json`, `browser.json`, and build/class-load logs
- `target/erosion/comparison.json`, `baseline.json`, `browser.json`, and build/class-load logs
- `target/colors/comparison.json` and corresponding browser, baseline, and build evidence
- `target/browser-save/comparison.json` and corresponding browser, baseline, and build evidence
- `target/core/` and `target/season/` for expected compile-only failures
- `target/host-check.json` for repeatable browser host checks
- `target/harness-check.json` for the additional browser failure checks
- `.local/` for static inspection output and diagnostic code

Each comparison record includes the module hash, original symbols, source-map inventory, class-load inventory, browser results, and cleanup flags.
The older `target/comparison.json` predates per-probe output directories and is historical evidence only.
Generated WASM derives from proprietary game code. Keep all generated evidence private.

## Next increments

1. Classify the shared Core compiler failures into missing Java-library APIs, retained error paths, and required native services.
2. Implement and verify one real host/API compatibility boundary at a time. Do not use no-op replacements to claim progress.
3. Reattempt the shared Core initializer before attempting the original Lua loop or seasonal simulation.
4. Evaluate rendering, input, physics, audio, and asset loading as separate original-code integration boundaries toward a playable slice.

`Noise2D` now passes, but that does not establish portability of its `ErosionSeason` caller.
That caller also needs sandbox settings, calendar/timezone parity, logging, and trigonometric operations.

Keep the existing engine and content installation unchanged. Do not start the original game or server.
Stop each branch when it requires original-byte changes, gameplay stubs, a large engine graph, or substantial runtime reconstruction.

The evidence supports original calculations, connected stateful objects, direct JavaScript calls, and real browser record storage.
The amount of reusable gameplay remains unknown until larger connected closures pass.
See [PORTING.md](PORTING.md) for the current runtime strategy and remaining playability gates.

## Standard-library runtime extension

The supported TeaVM plugin adds missing standard Java methods without changing game classes.
The class-library substitution mechanism supplies missing error and queue types.
Twelve independent JVM/Chromium runtime probes currently pass 243 cases and 358 output checks:

| Probe | Cases | Checks | Exercised contract |
|---|---:|---:|---|
| `reader` | 8 | 16 | Character transfer, null precedence, buffer boundary, I/O propagation, stream ownership |
| `paths` | 19 | 38 | File-to-path conversion, varargs resolution, lexical normalization, empty/root joins, null arguments |
| `linkage` | 8 | 16 | Initializer/linkage error constructors and cause initialization |
| `legacy-string` | 16 | 32 | Deprecated byte/high-byte constructor, UTF-16 mapping, overflow-safe range validation |
| `queue` | 8 | 16 | FIFO, null rejection, collection operations, weak iteration, exact-node removal, spliterator contracts |
| `file-stream` | 8 | 16 | Real virtual-file creation/truncation, default charset, healthy/repeated/recursive close, nested errors, invalid targets |

These are runtime compatibility checks, not additional game behavior or playability evidence.
The path tests normalize platform separators before comparing logical path text. They do not claim Windows drive semantics in the browser or alternate-provider compatibility.
The queue runs synchronously within TeaVM's cooperative single-agent runtime; it does not support shared objects across workers.
Serialization and automatic VM generation of the new error types remain unverified.

The browser tests exposed existing TeaVM defects in relative path normalization and null cause reassignment.
The extension corrects those exercised contracts instead of removing the failing cases. It also repairs TeaVM PrintStream lifecycle handling: healthy streams now close, and inspecting a closed healthy stream no longer creates an error. Browser Java file writes in this probe use the isolated in-memory virtual filesystem, not native disk or durable OPFS.
A prior Core/season checkpoint reported 133 missing references across 24 declarations. The current opt-in frontier is recorded below.
This is a build frontier, not a completion estimate. Native memory, rendering, image decoding, and runtime services remain unresolved.


## Real graphics host integration

The opt-in `graphics` probe passes four cases and 50 browser assertions:
16 raw float clear-state checks and 16 uniform-state checks against original Color fields, 16 framebuffer byte checks at unambiguous values, and two real WebGL error-state checks.
The browser runner then changes RGB and brightness sliders and verifies the resulting pixel `[95,48,191,191]`.
The rendered values come from original Color construction/clamping/scaling, original ShaderParameter construction/name normalization/PushUniform dispatch, and actual compiled shader drawing through the LWJGL host backend.
A supported TeaVM plugin connects selected third-party GL/GL11C entry points to an actual WebGL2 context.
The plugin activates only when the compiler JVM receives `port.webgl=true`.

This probe has no desktop JVM graphics baseline and contributes no additional original-game comparison cases.
GPU conversion to eight-bit normalized channels has different midpoint behavior from Java Math.round on this browser.
Fixed pixel cases avoid ambiguous midpoints; arbitrary interactive values enforce a one-byte quantization bound while checking the exact original float clear state.
This distinction does not change any original-game JVM raw-bit comparison rule.
Context loss marks the interaction failed and disables the controls.

The preceding `core-webgl` checkpoint failed with 38 missing references across 12 declarations. Implementing those boundaries exposed package implementation metadata and class-relative resource lookup, which now have browser comparisons. The browser-only `core-boot` entry now passes one case and four assertions inside an owned worker: original singleton identity and initial width, height, sound volume, zoom, fullscreen and debug state. It has no desktop JVM baseline. A missing standard MissingFormatArgumentException initially produced invalid Wasm catch types; supplying its correct IllegalFormatException inheritance fixes validation. Its separate JVM/browser probe passes 8 cases and 16 outputs. The preceding native frontier contained 215 entries, which remain unsupported operations unless a real browser backend exists.
Fixing the first graphics-loader path does not eliminate other image, memory, UI, concurrency, and native dependencies.
No original world, player, collision, animation, or gameplay loop is running.

Additional runtime comparison probes:

| Probe | Cases | Checks | Exercised contract |
|---|---:|---:|---|
| `deque` | 8 | 16 | Both ends, occurrence removal, nulls, retained iterators, bulk validation, spliterator |
| `fma` | 128 | 128 | Exact fused binary32 rounding, overflow/underflow/cancellation/signed zero; only NaNs use declared canonical bits |
| `field-handles` | 8 | 16 | Caller-owned private lookup, volatile reference reads, identity exchange witnesses, nulls, lookup errors |
| `resources` | 18 | 36 | Actual archive bytes, enumeration, package manifest metadata, absolute/relative/array-class resource lookup, missing/null names |
| `future` | 16 | 32 | Real task results/failures, cancellation/interruption, timed waits, completion hooks, Java 25 state queries |
| `executors` | 8 | 16 | Real cooperative workers, pool width, submission, draining/rejected/immediate shutdown, bulk timeouts, interrupted close |
| `time-units` | 16 | 112 | All seven time units, saturated overflow, negative division and conversion |
| `digest` | 16 | 96 | Incremental SHA-1, byte/array/buffer updates, padding boundaries, reset and output bounds |
| `locks` | 16 | 32 | Reentrant ownership, fairness, interruption/timeouts, conditions and hold restoration |
| `regex` | 16 | 32 | Functional replacement, callback mutation detection, groups and escaping |
| `rectangles` | 16 | 80 | Observed integer geometry API, exclusive edges, empty/negative rectangles and overflow |
| `channels` | 16 | 32 | Actual virtual-file reads/writes, position/truncation/options, overlap locks and close |
| `libraries` | 8 | 16 | Native-load validation and honest unavailable-library errors |

Field-handle metadata is explicitly limited to original LazyValue.value and the two probe targets.
The compiler captures the actual lookup caller; reference exchanges execute without yielding within one agent.
Unsupported primitive, package/protected/nest/module modes fail explicitly. No shared-worker memory model is claimed.
Original LazyValue's reentrant test publishes an inner value, rejects the outer replacement, and returns the original exchange witness exactly like the JVM.

FMA uses an exact BigInteger implementation before a single ties-to-even rounding. Its per-frame cost has not been benchmarked.
The resource host reads the configured archive with the JDK ZIP API and serves only indexed entries; no archive entry is extracted or executed.
Futures/executors use TeaVM's actual cooperative threads, with real waiting, interruption, timeouts, cancellation, and shutdown.
Review caught and corrected extreme-negative-timeout overflow and retained exited-worker objects before the passing executor rerun.
Shared time-unit conversions now saturate rather than wrapping a long positive timeout negative. SHA-1 is the supported digest; other algorithms fail explicitly. Rectangle support covers the observed integer API, without an AWT Shape hierarchy.
File channels use the actual ephemeral VFS and locks within one browser agent. Opening a second writable channel preserves existing bytes despite a stock RandomAccessFile truncation bug. Positions beyond the VFS integer limit fail explicitly; memory mapping, durable force, and cross-process locks are unsupported.
Manifest fixtures currently contain no non-null implementation version, so a populated implementation-version fallback is not yet exercised. Class-resource visibility is limited to the indexed application archive.

The same graphics probe also passes in an actual dedicated worker using OffscreenCanvas. This changes its host, not its original-game coverage count. A separate browser-only `exit` probe passes two assertions: an owned runtime reports exit code 7 and reaches a real Wasm trap, with no subsequent Java catch/finally/task output during the observation window. JVM shutdown hooks are outside this boundary.

The separate `joml` vendor probe passes 8 cases and 128 raw float checks, selecting the library's shipped NIO provider instead of unavailable Unsafe.
The browser-only `memory` probe passes 8 cases and 50 assertions, including actual Wasm address reads/writes and zero retained owners after release.
The bounded MemoryUtil backend supports owned float/int allocations, addresses, and typed release. Other operations throw UnsupportedOperationException; unsupported desktop allocator fields are not initialized and must not be used.
This explicit native capability boundary reduces build reachability without claiming those native operations were ported.
Shader matrix uploads honor position/limit and implement actual three/four-dimensional transposition. The vector-four original parameter path and direct matrix-four tests ran; the other dispatch branches only compile.

The standard runtime table also includes the watch probe: 8 cases and 16 exact JVM/browser outputs for actual file changes, filtering, key lifecycle, interruption and close wakeup. It polls the ephemeral default VFS every 25 ms using the verified locks/conditions. Short-lived files or same-size changes within timestamp resolution can be missed. Alternate providers and cross-worker sharing are unsupported.

## Connected engine milestones

These browser-only probes use assertions against inspected original behavior, without a desktop JVM baseline. They do not add to the 72/440 JVM comparison count.

| Probe | Cases | Outputs | Verified behavior |
|---|---:|---:|---|
| `core-boot` | 1 | 4 | Original Core constructor, singleton and initial configuration |
| `lua-runtime` | 2 | 4 | Shipped compiler/interpreter, closures, tables, standard libraries, coroutines and retained state |
| `asset-lua` | 4 | 8 | Mounted original Lua bytes, original object/event and table helper behavior |
| `filesystem-runtime` | 2 | 6 | Original filesystem initialization, canonical folders, case-insensitive selected index and reads |

The media host exposes only ISBaseObject.lua and LuaTableUtil.lua beneath the explicitly configured media root. It resolves real paths, rejects escapes, snapshots bounded files, and verifies SHA-256 before Java starts. Java file reads independently match the host bytes. Three unknown paths and a write request are rejected, and post-run checks confirm installed inputs remain unchanged.
The immutable `/media` mount delegates other paths to ephemeral memory storage. It does not expose native saves or implement a complete media tree. File indexing is deliberately a two-file selection. The Lua environment binds `pairs` to the shipped table iterator as the installed standard library does; full game Lua environment initialization is still separate.
The `season-runtime` entry currently fails at original SandboxOptions initialization because its media and Lua environment prerequisites are not yet mounted and initialized. It is a diagnostic, not a passing seasonal simulation.

The real DOM keyboard fixture now passes eight initial-state cases and sixteen outputs, plus live press/release checks for eight physical keys, a simultaneous-key chord, and actual canvas focus loss. Original Keyboard.isKeyDown, KeyCodes.toGlfwKey and Display.getWindow remain on the query path. The bounded GLFW backend registers the actual transferred canvas and reads forwarded DOM state. Other window operations and ambiguous WORLD key mappings remain unsupported.
Twenty-one standard runtime probes currently pass 373 cases and 810 exact JVM/browser outputs. These counts remain separate from original game and browser-only engine evidence.

`game-keyboard` now runs the original GameKeyboard.poll/update and KeyboardStateCache lifecycle over real DOM input. Eight initial cases and sixteen outputs pass, with separate live press/held/release/idle, chord and focus-loss checks. The fixture advances actual original input frames to account for its one-sample cache delay. The original UI callbacks and Lua-event guard remain active; the empty initial UI and null initial game Lua environment are original initialization state.
The browser canvas lifecycle backs Display.isCreated. International WORLD keys are reported released only while no ambiguous international physical code is held; such a press fails explicitly. No portable international-key equivalence is claimed.

## Standard environment and Java-to-Lua reflection

The original `newEnvironment()` now loads and executes the unchanged root `stdlib.lua`. Its browser probe passes two cases and four outputs, including real assert, iteration, sorting, protected calls, and coroutine wrapping. The read-only root-file mount has the same byte-integrity and mutation checks as the selected media mount.

The `reflection-exposure` browser probe passes three cases and six outputs. It calls the original game Exposer for original GameVersion, checks all eleven declared methods and its public constructor are retained, and invokes construction, getters, parsing, comparison and equality from Lua through actual Java reflection. It does not call exposeAll or claim a complete game Lua API.

Actual class-file Signature and Exceptions attributes supply the two missing generic reflection APIs. A parse-only Java 25 tool extracts selected metadata without loading classes. Browser generic tests pass eight cases and sixteen exact JVM comparisons, including parameterized parents, wildcards, generic arrays and generic exception variables. Missing signature metadata or unretained referenced classes fail explicitly. The current metadata selection is bounded to the tested classes; it is not unrestricted reflection.

Twenty-six standard runtime probes currently pass 402 cases and 868 exact JVM/browser outputs. Desktop and Module declarations provide only the class identities required by the exposer's security blacklist. No desktop operations or Java module system are implemented. The subprocess and deserialization browser probes separately verify explicit unavailable-capability errors and validation; they do not count as successful process or serialization support. A rejected deserialization attempt consumes and closes no input.

The LuaManager.init compile-only entry now compiles after the thread-group and runtime-management boundaries. It has not executed, and its current retention does not supply the full exposure set. A parse-only manifest records all 1,002 registration sites and 999 unique seeds, with metadata for 1,145 classes. Full exposure still requires larger faithful retention and initialization qualification; empty metadata is not a valid success.

The thread-group probe passes four cases/eight exact JVM/browser outputs: real parent/name relationships, creation-time group assignment, child inheritance and termination cleanup. The runtime-management browser probe reports the actual empty Wasm runtime JVM-argument list and its immutability, without exposing compiler arguments or claiming general JMX support. FMOD recording entry points currently fail with explicit native-capability errors; the browser proof verifies both failures, not audio functionality.

## Manifest retention and actual sandbox scripts

The independent `reflection-manifest` browser qualification passes three cases/six outputs with the older GameVersion supplier disabled. Its two-class manifest retains 22 methods and four fields, with no missing standard-library APIs. Two compiler visibility differences are recorded; no helper-only methods are added to the Lua API.

The broad compile-only profile validates 1,145 requested classes, with no missing original members, and records 257 unavailable standard-library public API entries. The first precise compile exhausted its 8 GB heap before producing a full missing-reference frontier. A separate conservative-analysis diagnostic keeps this failure distinct; no full LuaManager initialization has executed.

`season-bootstrap` passes five cases/26 outputs. It uses original ZomboidFileSystem, original Lua runtime components, unchanged defines.lua and Apocalypse.lua, original SandboxOptions and original ErosionSeason. The adapter establishes only the audited environment/thread prerequisites for these data scripts; full exposeAll is separate. It verifies representative actual preset values, loaded-script records, returned Lua tables, original seasonal changes and mounted file bytes. No world, player or native game save is involved.

The opt-in `inflater` repair passes eight cases/16 exact JVM/browser outputs, bringing the standard runtime total to 27 probes, 410 cases and 884 outputs. It preserves the real jzlib implementation: construction/reset supplies a legitimate empty input buffer, and no-progress Z_BUF_ERROR uses the existing accounting path. Malformed data remains an error. Checks include small output buffers and single-byte input, so pending decompressed output is not discarded by a broad needsInput guard. The original PNG decoder is unchanged.

The `menu-png` browser check now passes three cases/eight outputs over the actual character-menu asset `ui/avatarBackgroundWhite.png`. Original PNGDecoder supplies all 96-by-96 RGBA pixels; an independent browser PNG decoder produces the same dimensions and hash. Actual WebGL texture storage/FBO readback matches every decoded byte, with preserved buffer position and no GL error. This is an original asset decoding/upload path, not original TextureID or a rendered menu. RGBA/RGBA8 unsigned-byte transfers are currently the supported format subset; other transfer formats fail explicitly.

`image-texture` passes two cases/eight outputs through original ImageData, TextureID and RenderThread queue completion. The real uploaded 128-by-128 padded texture matches independent browser decoding of the 96-by-96 installed menu PNG. Original image disposal completes. The direct-memory probe now passes nine cases/59 assertions including byte allocations, byte-fill range preservation and actual Wasm byte addresses.

The new output-channel probe passes eight cases/16 exact JVM/browser comparisons. It uses the original stream accessor for shared cursor/append/truncation behavior and bidirectional close ownership. This brings the standard-runtime total to 28 probes, 418 cases and 900 exact outputs. A separate read-only channel open no longer requests append access from the immutable asset mount; mounted asset write protections remain intact.

The `reflection-vectors` browser probe passes five cases/ten outputs. It retains all original declared methods, constructors and fields for GameVersion, Vector2 and IsoDirections plus their hierarchy, while only the tested classes are exposed through the original Lua bridge. Its eleven requested metadata classes yield ten available classes, 102 retained methods and 21 fields. Two raw-JDK API gaps—Constable and Enum.describeConstable—are recorded explicitly. Actual Lua operations create and mutate real Java vectors, preserve copy identity, and call original enum rotation/direction operations. No whole-game exposure claim is made.

Original default shader: browser PASS 3 cases / 10 outputs. Original SceneShaderStore/DefaultShader/ShaderProgram/ShaderUnit load the installed shader files and compile/link/validate a real WebGL2 program. Desktop OpenGL capability flags remain false; the original GLSL120 fallback is translated to GLSL ES300. Actual uniform defaults and attribute locations are checked. This does not yet draw an original sprite or initialize a world.


CheerpJ Lua profile: full original LuaManager.init PASS, with original Core metadata 548 methods / 281 fields, 24 generated-field checks, 8 owned gamepad-memory checks, original filesystem and random initialization, shipped standard library and post-init exposed vector/enum calls. All game method bodies unchanged. Controller polling/native pointers remain unsupported. Evidence is separate from TeaVM compilation and does not establish playable world behavior.


Bounded ARB VBO backend PASS 2 cases / 8 outputs using actual GPU storage/readback, owned CPU mappings, full/range uploads and error/cleanup checks. Explicit port.webglVbo gate selects original ARB renderer factory only after qualification; desktop GL version flags remain false. Unsupported typed/array/native-address overloads and persistent/explicit-flush mappings are not claimed. Original SpriteRenderer PASS 5 cases / 14 outputs, including state handoff and all 128x128 framebuffer pixels. Fixture deletes its owned GL texture directly; original TextureID.destroy and static ring lifetime are not qualified. Engine stdout accepts exactly one result JSON plus bounded original log lines.


Combined CheerpJ full-Lua + original SpriteRenderer PASS in one JVM: original full exposure and post-init Lua calls precede the original sprite frame; 5 render cases / 14 outputs, all 128x128 RGBA bytes, hash -1846735105 matching TeaVM. Selected vendor graphics adaptation leaves all 5095 zombie classes identical to its input runtime view. Installed shader/JAR/PNG/bootstrap asset hashes remain unchanged. Original static ring resources are browser-context lifetime; no full renderer destruction claim.


CheerpJ world profile PASS: real IsoCell/IsoPlayer, 953 installed files / 806347 bytes, 92 action states / idle, original position (.5,.5,0), DOM W through original GameKeyboard and player ECS input vector (0,-1.95), release (0,0), actual worker stop before result. One precisely recorded Pool.alloc Java21 SDK call is retargeted in the private copy; game method bytes are explicitly marked changed, algorithms preserved. All selected installed input hashes verified after run. No walking or playable world claim.


Original character shader browser PASS: actual basicEffect composed stages compile/link/validate, UVScale(1,1), two matrix-palette GPU elements including non-diagonal transpose and NIO state. Real color/depth FBO completeness gates the bounded ARB capability. Separate library-unit compile failures are preserved; same-stage source composition is an explicit desktop-to-WebGL linker adaptation. Original shader operations are preserved; no actual character drawing claim. Full Lua + sprite regression remains5/14 and identical framebuffer hash.


## Character and map integration checkpoint

The CheerpJ path has now completed original client `ModelManager.create()` in an owned browser, including a real 1024-by-1024 color/depth framebuffer, the installed animation-mesh script definitions, asynchronous model loading and original animation directory discovery. The real male model reports READY with 35 bones, the female model reports READY, and original idle/walk/run assets are discovered. A separate original AnimationPlayer qualification advances idle with zero deferred movement and walk with nonzero deferred movement. This is not yet a connected player update or visible character frame.

The bounded Challenge1 geometry experiment loads all seven installed tile-definition files (61,227 sprites), parses four genuine lot headers and completes original IsoMetaGrid creation for cell bounds 0..1. Original WorldStreamer creation and chunk-request submission return. Chunk activation, usable squares, collision and player walking remain unqualified.

These private experiments use explicitly documented compatibility copies: class-version header lowering and existing Pool/LazyValue/ZomboidFileSystem SDK call adaptations. Installed game inputs remain unchanged; the loaded private copies are not byte-for-byte identical. The user explicitly allowed these existing adaptations on 2026-10-16. Do not describe these experiments as unchanged-class execution. No new gameplay algorithm is substituted.

Public browser profiles now write into `target/browser-jvm/<profile>/`, preventing one profile rebuild from changing another profile's active archive range responses. The graphics profile passed after this isolation change. The OPFS host gate also passed all five scenarios, including intentional mismatch, corruption, truncation and quota failure detection. Animation/client runner integration is still in progress; private inspection results do not establish a public one-command playable build.
