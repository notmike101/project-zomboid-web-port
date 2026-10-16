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
| npm packages | Install the committed lockfile with npm ci; includes playwright-core and the lint configuration |
| Project Zomboid installation | Matching projectzomboid.jar, media directory and installation-root jassimp64.dll |
| JDK | Full JDK 25 with java, javac and jar; preparation uses its Class-File API |
| Browser | A Chromium executable with WebGL2 support; Playwright Core does not install a browser automatically |
| Network | Access to https://cjrtnc.leaningtech.com/4.3/ for the CheerpJ runtime |

The local importer uses the matching installed Jassimp DLL to prepare genuine model/animation data. It does not launch the installed game or server.

Apache Maven 3.9.16, a WasmGC-capable browser and the installed bundled Java runtime are additionally needed for the separate [TeaVM/reference comparisons](TEAVM.md). Maven is not required by the connected browser-JVM command below.

## Run the walking session

Run these commands in PowerShell from the repository root. Replace the example paths with your actual installation, JDK and browser paths.

~~~powershell
npm ci --ignore-scripts --no-audit --no-fund

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

This bounded run sends actual browser keyboard events, observes original input, verifies displacement across ten held-input frames, then requires four consecutive original zero-input frames after release. It also checks genuine floor visibility and a separate body-pixel contribution, source-file hashes and owned cleanup. Failures return a nonzero exit status.

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

The complete survival game, zombie population simulation, full Bullet dynamics, clothing composition, audio, menus, native saves and broad streaming are not qualified. The bounded bootstrap still logs missing loot/container and vehicle-definition initialization errors. Unsupported host operations fail explicitly.

The original region worker belongs to the dedicated browser-JVM context lifetime because its original reset busy-waits without yielding. Closing the owned browser releases that runtime; same-JVM engine reset/reuse is not supported. Installed native saves are never mounted.

Prepared assets and generated archives are private local outputs. Keep snapshots and manifests from the same preparation generation together, and do not rebuild a profile's output while another browser is serving that same directory.

## Development

Work continues on **main**. Use conventional commits, verify logical increments and push them regularly. Follow [AGENTS.md](AGENTS.md) for contribution identity, source preservation and verification rules.

~~~powershell
npm run lint
~~~

Lint runs ESLint with **--max-warnings 0**, using the actual @notmike101/eslint-config-js and @notmike101/eslint-config-jsdoc configurations. Authored Node, browser and inline HTML scripts are included. Package provenance is recorded in [vendor/eslint-configs/README.md](vendor/eslint-configs/README.md).

The earlier main was merged with milestone/m1 and preserved as an orphan snapshot at [backup/main-before-original-bytecode-port-20261016](https://github.com/notmike101/project-zomboid-web-port/tree/backup/main-before-original-bytecode-port-20261016). Main now contains the original-bytecode port; the older milestone and port-branch histories remain reachable.

