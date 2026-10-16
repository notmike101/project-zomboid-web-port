# Original-bytecode browser port investigation

An incremental Project Zomboid browser-port investigation using the installed game's original Java class files.
TeaVM 0.16.0 compiles selected dependency closures to WebAssembly GC.
The same original implementation runs on the bundled JVM and in actual Chromium for comparison.

This is a compatibility and host-integration workbench. It is not a playable game yet.
The repository contains authored adapters, build configuration, browser host code, and comparison tooling.
It contains no original game classes, assets, downloaded toolchains, or generated WASM.

## Verified components

| Probe | Behavior |
|---|---|
| `angles` | Original angle wrapping and interpolation |
| `weather` | Stateful weather-value transitions and 2D/3D/4D simplex noise |
| `airfront` | Original climate-front state and in-memory save/load |
| `erosion` | Seeded layer construction, sampling, reset, and reconstruction |
| `colors` | Connected original climate-color interpolation, aliasing, copying, scaling, and serialization |
| `browser-save` | Original climate state restored from browser OPFS across eight page/module loads |
| `lazy-value` | Original field-handle memoization, null results, retry, identity, and reentrant witness |

The seven original-game probes compare 72 cases and 440 raw output bit patterns with the JVM.
These counts are behavioral checks, not a percentage of game coverage.
The browser-save probe adds real browser filesystem persistence without replacing gameplay calculations or the original record format.

The runtime compatibility extension uses TeaVM's supported plugin interface and class-library substitutions.
Runtime probes compare standard Java API behavior against Java 25, including paths, streams, queues, fused arithmetic, field handles, classpath resources and manifest metadata, futures, executors, locks, time conversions, SHA-1, regular expressions, and integer rectangles.
These checks are separate from original-game coverage. Path operations use the browser's virtual path provider; they do not provide OPFS-backed Java files.
The queue supports TeaVM's cooperative single-agent execution, without cross-worker object sharing.
The `graphics-worker` entry runs the same original shader integration inside a dedicated worker with a transferred OffscreenCanvas. The separate `exit` entry verifies terminating an owned worker runtime, including a real Wasm trap and absence of subsequent Java execution.
The browser-only `core-boot` entry executes the original Core initializer. `lua-runtime` runs the shipped Lua compiler/interpreter, including closures and coroutines. `asset-lua` executes two unchanged installed Lua files through a verified read-only media mount, and `filesystem-runtime` builds the original selected-file index over that mount. These are connected engine milestones; no player/world loop runs yet.

See [COMPATIBILITY.md](COMPATIBILITY.md) for measured results and [PORTING.md](PORTING.md) for the route toward a playable slice.

## Prerequisites

- Windows and Node.js 22 or newer.
- An installed Project Zomboid JAR and its bundled Java 25 runtime.
- A local JDK 25, Apache Maven 3.9.16, and a Chromium executable with WasmGC support.
- Locked Node dependencies installed with `npm ci --ignore-scripts --no-audit --no-fund`.

Set these environment variables to your own absolute paths:

| Variable | Path |
|---|---|
| `PZ_GAME_JAR` | Installed `projectzomboid.jar` |
| `PZ_JAVA` | Installed bundled `jre64/bin/java.exe` |
| `PZ_JDK` | JDK directory containing `bin/java.exe` and `bin/javac.exe` |
| `PZ_MAVEN_HOME` | Maven directory containing `boot/` and `bin/m2.conf` |
| `PZ_BROWSER` | Chromium `chrome.exe` |

Run all verified components from the repository root:

```powershell
& {
    $probeArgs = @(
        '--game-jar', $env:PZ_GAME_JAR,
        '--java', $env:PZ_JAVA,
        '--jdk', $env:PZ_JDK,
        '--maven-home', $env:PZ_MAVEN_HOME,
        '--browser', $env:PZ_BROWSER
    )
    foreach ($probe in 'angles', 'weather', 'airfront', 'erosion', 'colors', 'browser-save', 'reader', 'paths', 'linkage', 'legacy-string', 'queue', 'file-stream', 'deque', 'fma', 'field-handles', 'resources', 'future', 'executors', 'time-units', 'digest', 'locks', 'regex', 'rectangles', 'channels', 'libraries', 'watch', 'format-exception', 'package-name', 'module-token', 'anonymous-class', 'generics', 'thread-groups', 'inflater', 'output-channel', 'lazy-value', 'joml') {
        node compare.mjs --probe $probe @probeArgs
        if ($LASTEXITCODE -ne 0) { throw "Probe failed: $probe" }
    }
}
```

Each command rebuilds its module, runs the isolated JVM baseline, serves loopback, launches its own browser, and compares original output bits.
It returns nonzero for mismatches, initialization errors, browser errors, changed input hashes, or unexpected game-class loading.
Owned browser and server resources close before the command returns.
Evidence and generated code remain ignored under `target/<probe>/`.

After building `browser-save`, verify storage failures and input validation:

```powershell
node verify-host.mjs --browser $env:PZ_BROWSER
```

This runs the real OPFS bridge across reloads, then injects a result mismatch, corrupted reads, a truncated file, and a quota failure.
It also checks malformed snapshots, invalid step indexes, and preservation of data after a rejected write.

## Current larger boundaries

`season` and `core` are compile-only diagnostics. Their initialization closures are not qualified for execution.
They currently fail TeaVM compilation on missing library APIs and reachable native integration paths.
They require `--compile-only`, which prevents the runner from starting a JVM baseline or browser for them.

```powershell
node compare.mjs --probe core --compile-only --game-jar $env:PZ_GAME_JAR --jdk $env:PZ_JDK --maven-home $env:PZ_MAVEN_HOME
```

Use `--probe season` to diagnose the seasonal constructor instead.
A compile-only result is never reported as a browser pass.

JavaScript host services are part of the investigation. The current OPFS adapter is one working example.
It does not yet implement Java filesystem APIs, full game saves, graphics, audio, physics, or networking.
Those integrations need their own behavior and runtime checks.
The `libraries` probe verifies honest failure for unavailable desktop native libraries. Mapping a library name to a `.wasm` filename does not load a library or port its native functionality.

All work on this checkout belongs to the isolated orphan branch `work/original-bytecode-browser-port`.


## Browser graphics integration

The opt-in `graphics` probe runs original `Color` bytecode through real WebGL2 calls behind selected LWJGL APIs.
It verifies four shader-rendered cases driven by original ShaderParameter objects, exact clear/uniform float bits, framebuffer readback, and consumed error state.
The runner also changes real browser sliders and verifies their rendered output.
This is an interactive graphics integration, not a playable Project Zomboid world.

```powershell
node compare.mjs --probe graphics --game-jar $env:PZ_GAME_JAR --jdk $env:PZ_JDK --maven-home $env:PZ_MAVEN_HOME --browser $env:PZ_BROWSER
```

This entry never starts a desktop JVM baseline. Original arithmetic already has separate JVM comparisons.
The compiler activates the third-party graphics plugin only for this probe and `core-webgl`.
`core-webgl --compile-only` diagnoses the larger engine with that backend enabled. The separate `core-boot` entry now executes its audited initializer in an owned browser worker.
Unsupported graphics APIs retain their original implementations; they have not been supplied with successful stubs.

The `memory` entry uses the same browser-only command with `--probe memory` to verify real direct allocations, raw Wasm addresses, and release ownership.
`joml` separately compares the shipped NIO matrix provider with the JVM, without adding to game coverage.
The `resources` host exposes only entries in the configured local archive through loopback HTTP. It never extracts or executes an archived class or DLL.
All executor workers cooperate within one browser agent; they do not supply parallel Java threads.

## Original engine and installed assets

Use the browser-only invocation shown for `graphics`, substituting `core-boot`, `lua-runtime`, or `keyboard` as the probe name. The keyboard fixture tests real DOM press/release, simultaneous keys and canvas focus loss through the shipped Keyboard/KeyCodes path. It does not implement desktop window creation.

The two asset entries additionally require the explicit installed media directory:

```powershell
node compare.mjs --probe asset-lua --game-jar $env:PZ_GAME_JAR --media-root $env:PZ_MEDIA_ROOT --jdk $env:PZ_JDK --maven-home $env:PZ_MAVEN_HOME --browser $env:PZ_BROWSER
```

Use `--probe filesystem-runtime` for the original selected-file index. The allowlist currently contains only `lua/shared/ISBaseObject.lua` and `lua/shared/Util/LuaTableUtil.lua`; the host does not serve the installation as a directory tree. Original bytes stay local and untracked. Both entries use a read-only mount while ordinary runtime files remain ephemeral.

`season-runtime` remains a diagnostic without bootstrap. The `season-bootstrap` entry mounts unchanged `stdlib.lua`, `defines.lua` and the Apocalypse preset, initializes the original filesystem and a deliberately partial Lua environment, then runs original SandboxOptions and ErosionSeason. Its five cases and 26 outputs pass in the browser, including independent file-byte checks. It does not qualify full LuaManager.init or a running world.

The `game-keyboard` entry uses the same browser-only invocation as `keyboard` and verifies the original game input cache and transition lifecycle. It remains an input integration rather than a running player simulation.

The `standard-environment` entry additionally mounts the exact installation-root `stdlib.lua` and lets original J2SEPlatform.newEnvironment load it. Use the same `--media-root` argument; its parent directory supplies only that explicitly allowlisted file. `reflection-exposure` uses the same invocation to expose original GameVersion through the original Java-to-Lua bridge, with actual reflective constructor/method calls and numeric conversion. `lua-manager-init --compile-only` remains a diagnostic for the much larger full game Lua environment.

The `reflection-manifest` entry independently passes the same original GameVersion exposure using a generated, parse-only retention manifest instead of the old class-specific whitelist. Missing original members fail compilation; missing standard-library public APIs are listed explicitly. `game-lua-exposure --compile-only` expands that inventory to the full exposure hierarchy. Its first full compile exhausted the compiler's 8 GB heap after validating 29,027 methods and 23,892 fields; it has not executed. `game-lua-exposure-fast --compile-only` separately investigates TeaVM's supported conservative analysis mode. Neither diagnostic is a full Lua initialization success.

`menu-png` now passes three cases/eight outputs for an actual installed character-menu PNG. It preserves original PNGDecoder, independently matches browser-decoded RGBA pixels, and checks a real texture upload/FBO readback byte for byte. A standard-library Inflater repair resolves the initial decoding failure. It is not a rendered game menu. Existing interactive graphics checks still pass. `game-boot --compile-only` separately inspects the original launcher entry without executing it or supplying full reflection retention.

The separate fast-analysis full-exposure compile also exhausted the same 8 GB heap. Compiler-side separation of reflection discovery metadata from callable bodies is under investigation; removing private metadata would alter the original exposer's discovery and is not an acceptable workaround.


`image-texture` now executes original ImageData and TextureID loading/upload with the same menu PNG profile. It verifies the original render-context callback and image disposal, and independently matches every 128-by-128 padded GPU pixel against browser decoding. This remains a texture integration, not a rendered game menu. The direct-memory check now includes owned byte allocation, range filling and real byte addresses (nine cases/59 assertions).

`reflection-vectors` expands actual Lua reflection to original GameVersion, Vector2 and IsoDirections. Five browser cases/ten outputs pass, including vector normalization/scaling, copies, enum identity, rotation and direction conversion. All original declared members are retained; missing JDK Constable metadata is explicitly reported. This remains bounded exposure rather than full LuaManager.init.

The original default shader now passes real browser compilation, linking, uniform and attribute checks (default-shader). The alternative [browser JVM workflow](browser-jvm/README.md) qualifies original PNG decoding and real GPU output using CheerpJ with an explicitly documented private class-file copy view. Neither route is playable yet.

