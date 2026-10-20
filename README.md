# Project Zomboid browser port

An in-development browser port built around the installed game's original Java code and data. The goal is whole-game compatibility. **The full game is not ported yet:** the current verified milestone is an original-code walking scene in a genuine nine-chunk neighborhood.

This repository contains authored platform adapters, preparation tools and verification code. It does not distribute the game's JAR, assets, native libraries, downloaded toolchains or generated runtime files. Supply your own local installation.

Whole-game integration diagnostics now complete original `GameWindow.enter()` and report boot ready, with three original states, fifteen registered texture packs and 75 distinct prepared snapshots requested by the original asset consumer. The ninth run exposes the caught exception: original animated PNG loading reaches an unadapted LWJGL ByteBuffer-copy operation. The new host copy passes JVM/browser memory checks, and all 81 frames of the three affected APNGs match the original native JVM decoder exactly. A two-class compatibility overlay now carries that exact copy into the tenth startup while preserving all other existing adapter methods. The tenth original state-machine run reaches TermsOfServiceState without an observed decoding exception, then times out waiting for UI markers and fails its shutdown asset-work guard. Its authored UI observer was invalid: original Event.Add silently ignores JavaFunction callbacks and requires a LuaClosure. A retained Lua wrapper now passes exact registration/removal assertions in both native Java and the browser; missing observer markers do not establish a rendering failure. Strict transport failures remain. This is startup progress, not a menu or whole-game playability pass. See [current compatibility evidence](COMPATIBILITY.md#latest-genuine-startup-attempt).

## How it works

The connected route runs original Java bytecode in **CheerpJ 4.3's Java 17 browser JVM**. Original player/world updates, action states, animation blending and movement remain original game code. Browser adapters provide keyboard input, WebGL calls, local asset access and session ownership. The current camera and floor/body composition are authored presentation code.

This is distinct from the repository's **TeaVM 0.16.0 Java-to-WASM experiments**, which compile selected original-code dependency closures ahead of time. The connected walking session is not a whole-game standalone WASM build. See [TEAVM.md](TEAVM.md) for those comparisons and their compiler boundaries.

A separate [real Bullet WASM component](browser-jvm/BULLET.md) now runs original Java Bullet initialization and mesh calls against the upstream C++ engine. Its original JVM/browser comparison passes. It remains separate from the walking profile while original world/chunk activation and dynamic simulation are integrated.

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
| Earcut C++ | Pinned 2.2.4 header and ISC license under .tools/earcut-4811a2b6; see [Earcut setup](browser-jvm/EARCUT.md) |
| Emscripten / Python | Play and menu build Earcut with the pinned local Emscripten 3.1.74 SDK and `py -3`; see [SDK setup](browser-jvm/BULLET.md#prepare-the-optional-tools) |
| Network | Access to https://cjrtnc.leaningtech.com/4.3/ for the CheerpJ runtime |

The local importer uses the matching installed Jassimp DLL to prepare genuine model/animation data. It does not launch the installed game or server.

An experimental original front-end profile is also available; see [`--profile menu`](browser-jvm/README.md). It is an incomplete qualification tool: spawn-map rendering and world loading remain unresolved, and the final loading transition is guarded. Its current complete runtime composition has not received a fresh browser pass.

The Clipper2 dependency uses the Boost Software License 1.0. Its pinned release SHA-256 is `f143c550014a15a45884b4506a5ed984c7467bd080880aa9cb80bb9aaabdf2ff`; the runner rejects a different archive. Dependency provenance and license are kept under browser-jvm/third-party/clipper2/.

Apache Maven 3.9.16, a WasmGC-capable browser and the installed bundled Java runtime are additionally needed for the separate [TeaVM/reference comparisons](TEAVM.md). Maven is not required by the connected browser-JVM command below.

## Run the walking session

Run these commands in PowerShell from the repository root. Replace the example paths with your actual installation, JDK and browser paths.

First prepare the pinned Emscripten SDK and two Earcut source files using [Earcut setup](browser-jvm/EARCUT.md). The launcher compiles the native triangulation kernel locally; it does not install these tools or download sources for you.

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

This bounded run sends actual browser keyboard events, observes original input, verifies displacement across ten held-input frames, then requires four consecutive original zero-input frames after release. It also checks the genuine nine-chunk neighborhood, complete shared Lua and script/loot definitions, floor visibility and a separate body-pixel contribution, source-file hashes and owned cleanup. The original queued walk action must finish with both its Java and Lua queues empty. Chunk-activation exceptions, missing Lua callback lookups and swallowed Lua error logs fail qualification. Failures return a nonzero exit status.

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

The complete survival game, zombie population simulation, full Bullet dynamics, clothing composition, audio, menus, native saves and broad streaming are not qualified. The connected bootstrap loads all 1,004 vanilla script files, genuine clothing XML, all 374 shared, 727 client and 294 server Lua files, English translations and UI images. Original checksum/post-Lua resolution and five server/client global-object system pairs now run, including actual offline state transport. Original loading, caching and handlers remain in control. Broader startup/tick events, additional model/texture readiness and complete original world rendering remain separate work. Unsupported host operations fail explicitly.

A separate original-renderer qualification now loads all 219 genuine depth images, creates all eight original scene shader programs and renders 35 genuine non-floor map objects with an observed 33,932-pixel contribution. Immediate release of owned direct buffers resolves the former depth-loading JNI exhaustion; native buffer usage returns to its starting value. The public walking session continues to present floors and the body while continuous original scene presentation is integrated.

The original renderer's occlusion lookup also matches its native reference across 738 integers using real Clipper2 polygon intersections in the browser. The public session initializes that original lookup before rendering. Qualified closed-path, zero-offset intersection and difference contracts are enabled; other native polygon operations, complete lighting and complete cell rendering remain separate work.

The public verification command also queues the installed original Lua walk action after releasing keyboard input. Original pathfinding, movement and animation carry the player to the loaded target, then the original action clears its Java and Lua queues/path and returns idle. A historical integrated check with shared/client Lua and original fonts completed 131 session frames with no Lua errors and 8,905 unchanged monitored asset hashes. The latest prepared-build regression also passes 131 frames, movement/navigation and cleanup after allowing 360 seconds for startup; all 91 frozen route-input hashes remain unchanged and initialization/Lua errors are empty. The earlier 180-second startup timeout remains recorded as a failure; stage capture demonstrates legitimate initialization progress beyond that bound. Interactive sessions keep the existing WASD controls; this automatic navigation check runs only in verification mode.

The connected bootstrap also loads the original English fonts through `TextManager.Init()` and the genuine `UI.pack`, preserving original font choices and asynchronous texture loading. All 34 font lookups have ready glyph pages and positive original measurements; four retain the game's Small-font fallback. The original SDF shader compiles. A separate original bitmap `DrawString` GPU check produces 573 glyph pixels; complete menus, alternate languages/scales and SDF pixel rendering remain unqualified. The local font archive contains 348 unchanged original inputs and is prepared automatically by the play command.

A separate SQLite host-service qualification now passes through the original Xerial JDBC driver and original `AccountDBHelper`, using the pinned real `@sqlite.org/sqlite-wasm` 3.48.0-build4 engine. Its five fresh-VM phases cover JDBC values/transactions, account CRUD, rejected operations and publication failure, a persistent writer, and a reader after complete Chromium closure. Both final database images also pass independent original native-JVM reads. This package is available for integration; public play does not install it yet. See [the SQLite verification command and limits](browser-jvm/README.md#sqlite-host-service).

Original `OnGameBoot` now runs after model initialization and before world/player creation. Its actual callbacks populate 20 hair colors, 11 trouser colors and the original name lists; the connected actor no longer relies on the earlier direct hair-only initialization. The connected bootstrap also executes all 294 original server Lua files and the qualified post-Lua resolution phase; the complete original game-loading lifecycle remains unfinished.

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
node browser-jvm/verify-viewport.mjs
node browser-jvm/verify-glsl-compat.mjs
node browser-jvm/verify-native-memory.mjs
node browser-jvm/verify-clipper-callbacks.mjs
node browser-jvm/verify-clipper.mjs
node browser-jvm/verify-lighting.mjs
node browser-jvm/verify-lighting-vertical.mjs
node browser-jvm/verify-lighting-world.mjs
node browser-jvm/verify-lighting-moving.mjs
node browser-jvm/verify-native-long.mjs
node browser-jvm/verify-clock.mjs
node browser-jvm/verify-mouse.mjs
node browser-jvm/verify-sqlite.mjs
node browser-jvm/verify-file-watch.mjs
~~~

The shader qualification uses the `PZ_BROWSER` executable set above. Nine cases check actual WebGL2 compilation and exact pixels with Chromium's SwiftShader backend, including overload selection, integer arithmetic, legacy color varyings, uniform-dependent globals across composed units and legacy texture sampling with an original sampler named `texture`. A separate source check now compiles and links twelve original scene shader pairs, including both cutaway shaders. These checks do not establish physical-GPU or complete GLSL conformance.

The alpha qualification checks 113 actual GPU outcomes, including all eight comparisons, reference clamping, early returns, original discard behavior, program changes, uniform collisions and rejected fragments leaving depth/stencil untouched. The host routes the original `GL11.glAlphaFunc` entry point to this real shader implementation. Enabled alpha testing currently requires a supported fragment program and normalized color attachments; floating-point attachments and fixed-function program zero fail explicitly. The public walking build passes with this implementation, while the complete original cell-rendering lifecycle remains separate work.

The viewport/frame qualification checks the actual 16-entry viewport/depth-range stack, original vendor display updates and original frame-clear masks. An absent accumulation-buffer clear is harmless while real color/depth/stencil operations still execute; undefined mask bits retain their GL error. Its expanded gate passes 18 Java assertions and 29 browser observations, including exact pixels and both requested presentation modes. General accumulation operations and the complete menu lifecycle remain separate work.

The native-memory qualification also uses `PZ_JDK` and requires the prepared play profile's `sprite-view.jar`. It checks immediate native storage release for owned byte/float/integer buffers, rejects foreign and repeated frees, and verifies the prepared archive is unchanged. The graphics host explicitly relies on the qualified Java 17 runtime's `sun.misc.Unsafe.invokeCleaner` support; unavailable support fails initialization.

The Clipper qualification uses `PZ_JDK`, `PZ_BROWSER`, `PZ_GAME_JAR`, the prepared play archive and the pinned local Clipper2 JAR. It runs bounded polygon calculations through the matching installation-root `PZClipper64.dll`, then compares the same 134 cases in a fresh browser using the production adapter: 46 each for intersection and difference, plus 42 primitive cases covering native AABB/polygon insertion, accumulated clip rectangles and the original Java bevel method. It also checks 32 admitted highway-offset cases, 11 triangulation comparisons and both original Clipper.init calls through the real browser library descriptor. It checks source hashes and releases owned resources without starting the installed game or server. Open paths and offsets/operations beyond the documented admitted cases remain unsupported.

The file-watch qualification uses the same Java/browser/game-JAR environment and prepared play archives. Its default mode checks original JDK and game watcher behavior, including callbacks, debounce and normal closure. Setting `PZ_WATCH_VM_EXIT=1` selects a separate authored System.exit case that verifies real descriptor cleanup after observed VM exit. That terminal mode explicitly leaves an abandoned native promise unsettled and requires page destruction; it does not establish graceful original shutdown or reusable-VM cleanup. Unset the variable to return to the normal regression.

Lint runs ESLint with **--max-warnings 0**, using the actual @notmike101/eslint-config-js and @notmike101/eslint-config-jsdoc configurations. Authored Node, browser and inline HTML scripts are included. Package provenance is recorded in [vendor/eslint-configs/README.md](vendor/eslint-configs/README.md).

The lighting qualification additionally requires `PZ_GAME_DIR` pointing to the installation and a prepared play profile. It compares the actual installed lighting DLL with the browser service: 896 indoor cells and 43,904 packed integers, plus incremental geometry and publication/dirty-state checks. The vertical gate also requires `PZ_LIGHTING_SDK` pointing to a frozen copy of the prepared SDK archives. It compares 6,143 initialized squares and all 301,007 packed words across three floors, stairs, shafts, opaque 3D geometry, seven registered lamps and a 3×3-chunk region. The nonzero-origin regression preserves world-coordinate float32 ray accumulation; translating rays into local coordinates caused 83 packed-word mismatches in the reference case. Asymmetric cardinal edges use either endpoint’s bit for point propagation and vertex neighbors; diagonal edges and darkness averaging retain directed masks. The service preserves native float32 propagation, line of sight, corner calculations and five result-light slots per square. Unpublished and absent-square payloads reject because the native DLL can return uninitialized storage. The unchanged original initializer loads the actual browser module through a narrow CheerpJ4.3 Java17 loader adapter; missing modules still fail. Room lights, scrolling, player-level transitions and other unqualified inputs fail explicitly. Original world lighting updates and complete cell rendering are still being integrated. See [lighting provenance and limits](browser-jvm/lighting-provenance.md).

The additional world-lighting gate uses the same frozen SDK and environment. It compares 15,563 initialized payloads and 762,587 packed words across 11 publications against two native JVMs, including sky, static door/window/curtain objects, transmission, visible rooms and queued frame headers. It explicitly rejects order-dependent colored ambient transmission. A further moving-lighting gate matches 1,792 payloads and 87,808 words across 14 publications, including horizontal movement, chunk seams, retained visibility and pending/deferred source-update headers. A private actual original-caller replay matches 5,557,139 words across 128 keyboard-driven frames and integer square transitions. Movement stays on a fixed native floor within the admitted region; a zero source-update header requires genuine global invalidation. The original single-thread render-loop lighting branch has component evidence, while the default worker stop and complete world rendering remain unqualified. This is host-service evidence; ongoing original world lighting and rendering remain integration work. [Exact lighting scope and provenance](browser-jvm/lighting-provenance.md) describe the remaining limits.

The earlier main was merged with milestone/m1 and preserved as an orphan snapshot at [backup/main-before-original-bytecode-port-20261016](https://github.com/notmike101/project-zomboid-web-port/tree/backup/main-before-original-bytecode-port-20261016). Main now contains the original-bytecode port; the older milestone and port-branch histories remain reachable.

