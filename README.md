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
Twelve runtime probes compare standard Java API behavior against Java 25, including paths, streams, queues, fused arithmetic, field handles, classpath resource reads, futures, and fixed executors.
These checks are separate from original-game coverage. Path operations use the browser's virtual path provider; they do not provide OPFS-backed Java files.
The queue supports TeaVM's cooperative single-agent execution, without cross-worker object sharing.

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
    foreach ($probe in 'angles', 'weather', 'airfront', 'erosion', 'colors', 'browser-save', 'reader', 'paths', 'linkage', 'legacy-string', 'queue', 'file-stream', 'deque', 'fma', 'field-handles', 'resources', 'future', 'executors', 'lazy-value', 'joml') {
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
`core-webgl --compile-only` diagnoses the larger engine with that backend enabled and currently still fails.
Unsupported graphics APIs retain their original implementations; they have not been supplied with successful stubs.

The `memory` entry uses the same browser-only command with `--probe memory` to verify real direct allocations, raw Wasm addresses, and release ownership.
`joml` separately compares the shipped NIO matrix provider with the JVM, without adding to game coverage.
The `resources` host exposes only entries in the configured local archive through loopback HTTP. It never extracts or executes an archived class or DLL.
All executor workers cooperate within one browser agent; they do not supply parallel Java threads.
