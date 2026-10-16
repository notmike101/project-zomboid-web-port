# Incremental original-bytecode compatibility

## Current answer

Useful isolated Java gameplay logic can run unchanged in browser WASM.
We have verified seven gameplay classes and two supporting nested types across six probes.
The current total is **64 cases and 424 exact output comparisons**, with zero mismatches or browser errors.
Two larger compile-only diagnostics fail. They are not included in the passing totals.

This is not a percentage of the game. Class counts do not measure playable coverage or integration cost.
The JAR contains 23,829 class files, including 5,095 under `zombie/`. Most remain unexamined.
No world, character simulation, game script, or native subsystem has run in the browser.

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
| **Total** | Six standalone probe modules | **64** | **424** | **PASS** |

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
Each entry reports 160 missing references covering the same 31 distinct declarations.
Missing classes can hide additional method and native implementation gaps, so this is not a complete porting work estimate.

Static refinement: Translator initializes its final text maps during class initialization.
The null-map branch does not prove automatic filesystem execution during the first translation call.
The unconditional `Core.debug` read at bytecode offset 658 establishes the shared initialization dependency instead.
No unavoidable native startup was established by the bounded static initializer inspection alone.

Other pure methods near these boundaries may still be reusable. A class containing a native method does not invalidate every method.
No claim here says that an entire subsystem is impossible to port.

## Versions, identities, and measurements

All six behavioral comparison commands returned exit code zero using TeaVM 0.16.0 and its `WEBASSEMBLY_GC` backend.
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
