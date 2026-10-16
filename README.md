# Project Zomboid browser port

An in-development browser port built around the installed game's original Java code and data. The goal is whole-game compatibility. **The full game is not ported yet:** the current verified milestone is an original-code walking scene in a genuine nine-chunk neighborhood.

This repository contains authored platform adapters, preparation tools and verification code. It does not distribute the game's JAR, assets, native libraries, downloaded toolchains or generated runtime files. Supply your own local installation.

## How it works

The connected route runs original Java bytecode in **CheerpJ 4.3's Java 17 browser JVM**. Original player/world updates, action states, animation blending and movement remain original game code. Browser adapters provide keyboard input, WebGL calls, local asset access and session ownership. The current camera and floor/body composition are authored presentation code.

This is distinct from the repository's **TeaVM 0.16.0 Java-to-WASM experiments**, which compile selected original-code dependency closures ahead of time. The connected walking session is not a whole-game standalone WASM build. See [TEAVM.md](TEAVM.md) for those comparisons and their compiler boundaries.

The installed game files remain untouched. Preparation creates private copies with documented class-version and narrowly qualified Java SDK adaptations. Loaded compatibility copies are not byte-for-byte identical to the installed classes. Manifests record the changes and source hashes; no gameplay algorithms are replaced with successful stubs.

## Dependencies

The connected browser route is currently qualified on **Windows x64**.

| Dependency | Requirement |
|---|---|
| Node.js | 22.13 or newer in the 22.x line, or 24 or newer; see the exact engine range in package.json |
| npm packages | Install the committed lockfile with npm ci; includes playwright-core, ShaderFrog GLSL parser 7.0.1 and the lint configuration |
| Project Zomboid installation | Matching projectzomboid.jar, media directory and installation-root jassimp64.dll |
| JDK | Full JDK 25 with java, javac and jar; preparation uses its Class-File API |
| Browser | A Chromium executable with WebGL2 support; Playwright Core does not install a browser automatically |
| Clipper2 Java | Pinned 2.0.1b release JAR in .tools/clipper2-2.0.1b.jar; the play runner verifies its SHA-256 |
| Network | Access to https://cjrtnc.leaningtech.com/4.3/ for the CheerpJ runtime |

The local importer uses the matching installed Jassimp DLL to prepare genuine model/animation data. It does not launch the installed game or server.

The Clipper2 dependency uses the Boost Software License 1.0. Its pinned release SHA-256 is `f143c550014a15a45884b4506a5ed984c7467bd080880aa9cb80bb9aaabdf2ff`; the runner rejects a different archive. Dependency provenance and license are kept under browser-jvm/third-party/clipper2/.

Apache Maven 3.9.16, a WasmGC-capable browser and the installed bundled Java runtime are additionally needed for the separate [TeaVM/reference comparisons](TEAVM.md). Maven is not required by the connected browser-JVM command below.

## Run the walking session

Run these commands in PowerShell from the repository root. Replace the example paths with your actual installation, JDK and browser paths.

~~~powershell
npm ci --ignore-scripts --no-audit --no-fund

New-Item -ItemType Directory -Force .tools | Out-Null
Invoke-WebRequest 'https://github.com/micycle1/Clipper2-java/releases/download/2.0.1b/clipper2-2.0.1b.jar' -OutFile '.tools/clipper2-2.0.1b.jar'

$env:PZ_GAME_JAR = 'C:/Games/steam/steamapps/common/ProjectZomboid/projectzomboid.jar'
$env:PZ_MEDIA_ROOT = 'C:/Games/steam/steamapps/common/ProjectZomboid/media'
$env:PZ_JDK = 'D:/Tools/jdk-25'
$env:PZ_BROWSER = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

$portArgs = @(
    '--game-jar', $env:PZ_GAME_JAR,
    '--media-root', $env:PZ_MEDIA_ROOT,
    '--jdk', $env:PZ_JDK,
    '--browser', $env:PZ_BROWSER
)

node browser-jvm/run.mjs --profile play --interactive true @portArgs
~~~

The command prepares local inputs, starts a loopback asset server and opens an owned browser window. Allow time for preparation and browser-JVM startup. **Click the scene and use WASD to walk. Escape or Stop ends the session.** Keep the terminal running while playing.

The current scene contains a fixed 3-by-3 neighborhood of 8-by-8 chunks, with 576 genuine ground floors, and renders those floors plus the original animated body. Original player movement can cross the internal chunk boundaries. Continuous world streaming beyond this neighborhood, original object presentation and interactions are active development areas.

## Run the automated browser qualification

Use the same $portArgs but omit interactive mode:

~~~powershell
node browser-jvm/run.mjs --profile play @portArgs
~~~

This bounded run sends actual browser keyboard events, observes original input, verifies displacement across ten held-input frames, then requires four consecutive original zero-input frames after release. It also checks the genuine nine-chunk neighborhood, loaded script/loot definitions, floor visibility and a separate body-pixel contribution, source-file hashes and owned cleanup. Chunk-activation exceptions and missing Lua callback lookups fail qualification. Failures return a nonzero exit status.

The latest clean public run passed. A separate 100-frame browser run crossed the former single-chunk boundary inside the loaded neighborhood and verified key release and cleanup. Earlier longer runs passed 94 frames of directional/diagonal movement and blur release, and 95 idle frames. Interior loaded-wall and door collision remain unqualified.

Generated evidence stays local under target/browser-jvm/play/:

- result.json: outcome, requests, source hashes, adaptation manifests and cleanup.
- character-frame.png: actual browser canvas screenshot.
- build.json and preparation manifests: compiler/importer provenance.

walkingSliceQualified records the bounded automated result. fullGamePlayable remains false.

## Other connected profiles

Pass one of these values to --profile using the same prerequisite arguments:

| Profile | Qualified scope |
|---|---|
| graphics | Installed PNG decoding and actual GPU readback |
| lua | Original LuaManager initialization and Java exposure |
| input | Real DOM keyboard mapping and focus-loss release |
| sprite | Original sprite batching and indexed GPU rendering |
| world | Original world/player construction and input interpretation |
| character-shader | Original skinning shader and palette/FBO boundary |
| animation | Original body/animation loading and skinned GPU drawing |
| food | Original food definitions, inventory insertion and eating formulas |
| play | Connected original world/player updates and walking scene |

These are bounded qualifications, not independent claims that the complete game works. Details are in [browser-jvm/README.md](browser-jvm/README.md), [COMPATIBILITY.md](COMPATIBILITY.md) and [PORTING.md](PORTING.md).

## Current limits

The complete survival game, zombie population simulation, full Bullet dynamics, clothing composition, audio, menus, native saves and broad streaming are not qualified. The connected bootstrap loads all 1,004 vanilla script files, genuine clothing XML and the bounded loot/container Lua dependencies. This preserves original definition loading; complete game Lua, additional model/texture readiness and complete original world rendering remain separate work. Unsupported host operations fail explicitly.

A separate original-renderer qualification now loads all 219 genuine depth images, creates all eight original scene shader programs and renders 35 genuine non-floor map objects with an observed 33,932-pixel contribution. Immediate release of owned direct buffers resolves the former depth-loading JNI exhaustion; native buffer usage returns to its starting value. The public walking session continues to present floors and the body while continuous original scene presentation is integrated.

The original renderer's occlusion lookup also matches its native reference across 738 integers using real Clipper2 polygon intersections in the browser. The public session initializes that original lookup before rendering. Qualified closed-path, zero-offset intersection and difference contracts are enabled; other native polygon operations, complete lighting and complete cell rendering remain separate work.

The public verification command also queues the installed original Lua walk action after releasing keyboard input. Original pathfinding, movement and animation carry the player to the loaded target, then the original action clears its queue/path and returns idle. The fresh integrated check completes 132 session frames and preserves all 5,874 monitored asset hashes. Interactive sessions keep the existing WASD controls; this automatic navigation check runs only in verification mode.

The original region worker belongs to the dedicated browser-JVM context lifetime because its original reset busy-waits without yielding. Closing the owned browser releases that runtime; same-JVM engine reset/reuse is not supported. Installed native saves are never mounted.

Prepared assets and generated archives are private local outputs. Keep snapshots and manifests from the same preparation generation together, and do not rebuild a profile's output while another browser is serving that same directory.

The local server also provides a lazy, read-only view of the complete installed media directory. It streams requested file ranges and generates directory listings in memory; it never writes listing files into the installation. In a separate fresh-browser qualification, original `ZomboidFileSystem.init()` mapped 47,437 paths through this service, and an original script read matched its source hash. All 47,416 byte-served source files retained their hashes. The public walking bootstrap still uses its prepared asset closure; full-media discovery does not establish full Lua or world initialization.

## Development

Work continues on **main**. Use conventional commits, verify logical increments and push them regularly. Follow [AGENTS.md](AGENTS.md) for contribution identity, source preservation and verification rules.

~~~powershell
npm run lint
node browser-jvm/verify-media-files.mjs
node browser-jvm/verify-stencil.mjs
node browser-jvm/verify-alpha.mjs
node browser-jvm/verify-glsl-compat.mjs
node browser-jvm/verify-native-memory.mjs
node browser-jvm/verify-clipper-callbacks.mjs
node browser-jvm/verify-clipper.mjs
node browser-jvm/verify-lighting.mjs
~~~

The shader qualification uses the `PZ_BROWSER` executable set above. Nine cases check actual WebGL2 compilation and exact pixels with Chromium's SwiftShader backend, including overload selection, integer arithmetic, legacy color varyings, uniform-dependent globals across composed units and legacy texture sampling with an original sampler named `texture`. A separate source check now compiles and links twelve original scene shader pairs, including both cutaway shaders. These checks do not establish physical-GPU or complete GLSL conformance.

The alpha qualification checks 113 actual GPU outcomes, including all eight comparisons, reference clamping, early returns, original discard behavior, program changes, uniform collisions and rejected fragments leaving depth/stencil untouched. The host routes the original `GL11.glAlphaFunc` entry point to this real shader implementation. Enabled alpha testing currently requires a supported fragment program and normalized color attachments; floating-point attachments and fixed-function program zero fail explicitly. The public walking build passes with this implementation, while the complete original cell-rendering lifecycle remains separate work.

The native-memory qualification also uses `PZ_JDK` and requires the prepared play profile's `sprite-view.jar`. It checks immediate native storage release for owned byte/float/integer buffers, rejects foreign and repeated frees, and verifies the prepared archive is unchanged. The graphics host explicitly relies on the qualified Java 17 runtime's `sun.misc.Unsafe.invokeCleaner` support; unavailable support fails initialization.

The Clipper qualification uses `PZ_JDK`, `PZ_BROWSER`, `PZ_GAME_JAR`, the prepared play archive and the pinned local Clipper2 JAR. It runs bounded polygon calculations through the matching installation-root `PZClipper64.dll`, then compares the same 134 cases in a fresh browser using the production adapter: 46 each for intersection and difference, plus 42 primitive cases covering native AABB/polygon insertion, accumulated clip rectangles and the original Java bevel method. It checks source hashes and releases owned resources without starting the installed game or server. Open paths, offsets and other polygon operations remain unsupported.

Lint runs ESLint with **--max-warnings 0**, using the actual @notmike101/eslint-config-js and @notmike101/eslint-config-jsdoc configurations. Authored Node, browser and inline HTML scripts are included. Package provenance is recorded in [vendor/eslint-configs/README.md](vendor/eslint-configs/README.md).

The lighting qualification additionally requires `PZ_GAME_DIR` pointing to the installation and a prepared play profile. It compares the actual installed lighting DLL with a browser implementation of its native service: 896 indoor cells and 43,904 packed integers, plus incremental geometry and publication/dirty-state checks. The implementation preserves native float32 propagation, line of sight and corner-light calculations for that scope. Outdoors, vertical geometry, moving-player history, room lights and other unsupported inputs fail explicitly. This service is separately qualified; normal original lighting startup and complete cell rendering are still being integrated. See [lighting provenance and limits](browser-jvm/lighting-provenance.md).

The earlier main was merged with milestone/m1 and preserved as an orphan snapshot at [backup/main-before-original-bytecode-port-20261016](https://github.com/notmike101/project-zomboid-web-port/tree/backup/main-before-original-bytecode-port-20261016). Main now contains the original-bytecode port; the older milestone and port-branch histories remain reachable.

