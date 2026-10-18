# Real Bullet WASM component

This component runs original `Bullet.init()` and original Java native declarations against a real double-precision Bullet engine compiled to WASM. It is a prerequisite for the whole-game port. The walking and menu profiles still select their existing static geometry service; this component does not yet replace it.

The original JVM and browser comparison covers the original direct command buffer, all 35 original bone-name callbacks, Java float-array transport, convex hulls, compound shapes, native bounding boxes, empty Dynamics-world gravity and cleanup. It does not qualify `WorldSimulation.create`, chunk activation, asset physics loading, simulation steps, vehicles or ragdolls. The accepted world header remains exactly `[0,0,0,0,1,1,false]`; other headers reject before creating a world.

## Dependencies

The reference runner is qualified on Windows x64. It requires the repository's npm dependencies, Python available through `py -3`, JDK 25, a Chromium executable, the matching original game installation, and an SDK prepared by the existing animation or play profile. It rejects a different game JAR or Bullet DLL before executing native address-based queries.

Additional build inputs stay under the ignored `.tools` directory:

| Input | Pinned source and location |
|---|---|
| Bullet | Candidate 3.25, commit `2c204c49e56ed15ec5fcfa71d199ab6d6570b3f5`, extracted into `.tools/bullet3-2c204c49` |
| Emsdk | Commit `3d6d8ee910466516a53e665b86458faa81dae9ba`, extracted into `.tools/emsdk-3.1.74-source/emsdk-3d6d8ee910466516a53e665b86458faa81dae9ba`, with SDK 3.1.74 installed and locally activated |

The installed game's embedded Bullet core version is unknown. Matching the tested geometry does not establish that candidate 3.25 is the same revision. The tracked `bullet-sources.json` verifies 397 upstream files before and after compilation; 153 C++ sources are compiled. The helper separately verifies the `emcc.py` entry script, rather than claiming a hash audit of the entire installed SDK.

## Prepare the optional tools

For a fresh setup, download the exact source archives into `.tools` and verify their hashes before extracting them. Existing matching local inputs can be reused.

```powershell
New-Item -ItemType Directory -Force .tools/bullet3-2c204c49 | Out-Null
Invoke-WebRequest 'https://codeload.github.com/bulletphysics/bullet3/tar.gz/2c204c49e56ed15ec5fcfa71d199ab6d6570b3f5' -OutFile '.tools/bullet3-source.tar.gz'
if ((Get-FileHash '.tools/bullet3-source.tar.gz' -Algorithm SHA256).Hash -ne 'f7c486f10b9f645d0577249d02855e076e8368babaa3d31ced6095e7162baee9') { throw 'Bullet archive hash mismatch' }
tar -xzf .tools/bullet3-source.tar.gz --strip-components=1 -C .tools/bullet3-2c204c49

Invoke-WebRequest 'https://codeload.github.com/emscripten-core/emsdk/zip/3d6d8ee910466516a53e665b86458faa81dae9ba' -OutFile '.tools/emsdk-3.1.74-source.zip'
if ((Get-FileHash '.tools/emsdk-3.1.74-source.zip' -Algorithm SHA256).Hash -ne '2c6b06b0341da3ff5d4d75cfa47e5e9caba8ac0277c06e132f32022ee8a075a5') { throw 'Emsdk archive hash mismatch' }
Expand-Archive '.tools/emsdk-3.1.74-source.zip' '.tools/emsdk-3.1.74-source'
$bulletEmsdk = '.tools/emsdk-3.1.74-source/emsdk-3d6d8ee910466516a53e665b86458faa81dae9ba'
py -3 "$bulletEmsdk/emsdk.py" install 3.1.74
py -3 "$bulletEmsdk/emsdk.py" activate 3.1.74
```

SDK installation downloads its compiler/runtime dependencies. Activation here uses the SDK's local configuration; the build helper selects that configuration for its own compiler process. No permanent environment activation is required. The Bullet build/verification command itself downloads no tools or source.

## Run the original JVM/browser comparison

First prepare an SDK through the existing [browser runner](README.md). For example, the animation profile produces the eight archives consumed by this component under `target/browser-jvm/animation`. Then set your actual paths:

```powershell
$env:PZ_GAME_DIR = 'C:/Games/steam/steamapps/common/ProjectZomboid'
$env:PZ_BULLET_SDK = 'D:/zomboid-web-2/target/browser-jvm/animation'
$env:PZ_JDK = 'D:/zomboid-web-2/.tools/jdk-25.0.1+8'
$env:PZ_BROWSER = 'C:/Users/me/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe'
# Prepare this SDK only if you are not reusing one already produced by the runner.
node browser-jvm/run.mjs --profile animation --game-jar (Join-Path $env:PZ_GAME_DIR 'projectzomboid.jar') --media-root (Join-Path $env:PZ_GAME_DIR 'media') --jdk $env:PZ_JDK --browser $env:PZ_BROWSER
node browser-jvm/verify-bullet.mjs
```

The runner compiles the real engine and authored fixtures, executes a bounded data-only original JVM reference in an owned directory, and runs the original Java calls in Chromium. It does not start the installed game or server. It checks the loaded original `Bullet` class body, compares actual engine results, rejects logged exceptions, audits captured inputs and bounds browser cleanup. A verifier-only observer captures the module's existing exported backend; its served hash is recorded separately from the production source hash.

Generated modules, WASM, manifests, the upstream license, immutable served generations and `result.json` remain under ignored `target/browser-jvm/bullet-qualification`. A failed comparison exits nonzero. The initial public runner failed before browser execution because an archive listing exceeded its output buffer; that fixture failure did not establish an engine incompatibility. The corrected runner passed a fresh original JVM/browser comparison with 27 unchanged inputs and normal cleanup.
