# Real Bullet WASM component

This component runs original `Bullet.init()` and original Java native declarations against a real double-precision Bullet engine compiled to WASM. It is a prerequisite for the whole-game port. The walking and menu profiles still select their existing static geometry service; this component does not yet replace it.

The original JVM and browser comparison covers the original direct command buffer, all 35 original bone-name callbacks, Java float-array transport, convex hulls, compound shapes, native bounding boxes, empty Dynamics-world gravity and cleanup. This default foundation gate does not qualify `WorldSimulation.create`, asset physics loading, simulation steps, vehicles or ragdolls. The separate opt-in vehicle qualification below covers its own bounded dynamic fixture. The legacy shape-only case uses `[0,0,0,0,1,1,false]`; the mapped-world cases use the original six-integer header described below.

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

The public comparison now also covers the original normal-world six-integer header and four chunk-map owners. Activating a genuine 13×13 area creates 169 chunk records; overlapping another player by one chunk produces 182 distinct chunks with 156 shared identities. Deactivating one owner retains the other's 169 chunks, deactivating both releases all chunks, and reactivation/destruction repeats correctly. Coordinates, level records, flags and ownership are compared against the installed DLL. These are actual shared C++ objects over the real Bullet world, not readiness flags.

The fresh combined browser run passed all twelve stages with 27 unchanged inputs and normal cleanup. A subsequent diagnostic-only check verifies that legacy shape-only worlds report no mapped-world header. Those foundation checks do not establish geometry upload, collider construction, the original WorldSimulation owner or dynamic world simulation. The opt-in vehicle fixture below covers its separate controlled publication/simulation scope.


## Opt-in vehicle component

`prepareBulletRuntime(outputDirectory, { profile: 'vehicle' })` builds the real vehicle adapter without changing the default foundation profile or the walking/menu backend selection. Use a fresh output directory: the two generated solver files use exclusive creation and reject preexisting files. The vehicle build replaces one of the 153 translation units with a hash-verified, single-function lateral-friction warm-start derivative. All 397 original upstream files remain unchanged and are checked before and after compilation. Vehicle bodies use the observed native physics flags zero; their separate collision flags are preserved.

The qualification runs the existing foundation checks and original Java three-step `Base.CarNormal` fixture through the real JNI bridge. It compares all 90 published Float32 values with an original native result, requires exactly 27 original publication callbacks, checks original worker termination and exception count, and verifies empty owners and normal browser cleanup. The prior private candidate additionally passed the retained 18-primitive, 13-body publication and negative-owner regressions. Positive wheel-ray hits, two-direction friction, nonunit factors, two dynamic contact bodies, driving with other vehicle definitions and whole-game integration remain unqualified. Raw double observations retain last-bit differences and a known ERP2 setting difference; exact publication agreement in this fixture does not establish universal engine equivalence.

This is a developer component gate, not a complete game launcher. It requires the same pinned tools and matching original installation described above, a prepared SDK containing the eight animation/path/bridge/world/atomic archives, and four locally collected original-derived inputs:

| Local file | Required evidence |
|---|---|
| `carnormal-original.bin` | The original 200-float, 800-byte vehicle definition |
| `chunk-packet.bin` | The original complete chunk command packet, including its terminator |
| `vehicle-native.json` | Successful original native result with `pass: true`, `exit: 0`, `closed: true` and three `VEHICLE_CONTACT` stdout rows |
| `foundation-native.json` | Original foundation result with empty stderr and actual foundation/chunk reference stdout rows |

The input directory also contains `fixtures-manifest.json`: `installedJarSHA256` and `installedDllSHA256` must match the pinned installed inputs, and `files` maps each of the four names above to its actual SHA-256. These caller-trusted reference files are not supplied by the repository and must come from original native execution, not browser-generated expected values. Proprietary inputs and generated artifacts stay untracked. The optional native mode in `VehicleContactQualification` is source/compile checked; it is not yet a separately qualified native-oracle launcher.

With the earlier environment variables set, select your real local fixture directory and create a fresh owned generation:

```powershell
$env:PZ_BULLET_VEHICLE_FIXTURES = 'D:/local-original-vehicle-references'
$env:PZ_BULLET_VEHICLE_GENERATION = Join-Path (Get-Location) ('target/browser-jvm/vehicle-' + [guid]::NewGuid())
New-Item -ItemType Directory $env:PZ_BULLET_VEHICLE_GENERATION | Out-Null
node --input-type=module -e '
import { prepareBulletVehicleQualification } from "./browser-jvm/prepare-bullet-vehicle-qualification.mjs";
await prepareBulletVehicleQualification({
  outputDirectory: process.env.PZ_BULLET_VEHICLE_GENERATION,
  gameDirectory: process.env.PZ_GAME_DIR,
  sdkDirectory: process.env.PZ_BULLET_SDK,
  fixtureDirectory: process.env.PZ_BULLET_VEHICLE_FIXTURES,
  jdkDirectory: process.env.PZ_JDK
});
'
node browser-jvm/verify-bullet-vehicle.mjs
```

Preparation builds the explicit vehicle profile, compiles only authored qualification sources, verifies original class bodies apart from the approved version header, and freezes source/served-file hashes. It does not execute the installed game or server. An optional `engineDirectory` can reuse only an artifact matching the current vehicle profile, source/compiler/patch and output manifest; arbitrary unbound WASM is rejected. The verifier retains exact inputs, results and owner cleanup under the selected ignored target generation. Full JavaScript lint remains `npm run lint` with `--max-warnings 0`.

The vehicle profile accepts finite nonzero initial quaternions and genuinely registered four-wheel definitions. The initial-pose qualification described here covered one live vehicle; the ordered-owner extension below adds its separately tested scope. A controlled original-DLL/browser comparison covers CarNormal and PickUpTruck at identity, yaw90 and nonunit poses. All six actual body bases, child records and wheel records match exactly; ten inverse-inertia/global-AABB differences (maximum 1.7763568394002505e-15) are within the existing 1e-12 geometry policy. The strict exact-double browser result remains failed, alongside its retained network aborts. This extends tested initial construction, not driving or contact parity for every accepted definition. Rebuild the vehicle profile to obtain the updated constructor and read-only `vehicle_basis` export; the foundation profile is unchanged.


The vehicle profile now retains owners in original integer-ID order, with each owner keeping its own definition. An original-DLL/original-Java browser comparison covers two separated CarNormal/PickUpTruck owners without stepping: five packed reads match all original float32 values and untouched tails exactly, including offset batching, end-offset return, argument exception classes, missing-ID removal, retained-owner selection and destroy/reopen. The count call captures the ordered readback snapshot; successful insertion/removal requires a fresh count before reading. Java creation/readback remains four-wheel-only; legacy per-owner diagnostic exports require exactly one owner. All observed dirty fields were zero, so dirty 1→0 consumption is source-backed but not exercised by this fixture. Existing single-owner/contact/mesh and six-pose component assertions remain satisfied. VM exit 0, original worker cleanup, empty owners, browser/server closure and all 477 input hashes pass. The raw strict result remains failed on the same ten pose double differences and two runtime request aborts plus one CDP abort. This does not qualify multi-vehicle driving, dynamic contacts or whole-world playability. Rebuild the opt-in profile for vehicle_count_snapshot/get_vehicle_physics_batch; default foundation behavior and public preparer paths remain unchanged.


## Controlled two-vehicle stepping and recovered force arithmetic

The opt-in vehicle profile now includes the recovered original vehicle-versus-vehicle contact branch: both actual owners receive collision flags, while contact friction/restitution continue to derive from the original A owner. Zero real map owners produce zero publication callbacks through the same original Java Bullet.stepSimulation bridge; one-map behavior and all other map/owner/interval guards remain unchanged. The original solver initializer uses scalar X=(inverseMass*forceX)*dt and paired Y/Z=(inverseMass*dt)*forceY/Z. A second exact source overlay preserves this ordering and positive-zero fourth lane after the existing warmstart overlay; original upstream files remain unchanged, with the same compiler settings and 61 exports. Rebuild the opt-in vehicle profile; old one-overlay artifacts are rejected by its preparation checks. Default foundation behavior is unchanged.

A fresh original-Java browser comparison matches all 732 float32 fields across twelve native-reference reads after six actual steps of separated and controlled-overlap CarNormal/PickUpTruck owners. Both collision flags change from 1 to 0 through actual packed serialization, and tails remain untouched. This corrects the four one-ULP separated freefall differences retained in the preceding failed run; no timestep, expected value or tolerance changed. Existing single-owner/contact/mesh, ordered-owner and six-pose component assertions also pass. Actual worker teardown, VM exit 0, empty world/mesh/definition/vehicle ownership and browser/server closure were observed; all 482 input hashes and sizes remain unchanged.

Component assertions pass; overall strict comparison remains FAIL on the same ten prior pose float64 differences (maximum 1.7763568394002505e-15, separately assessed under the pre-existing geometry-only policy), two runtime request aborts and one CDP abort. Browser packed trajectories and flag consumption are measured; native pair manifold/material snapshots are retained reference evidence, not additional browser manifold measurements. This is the fixed two-case, six-step component scope, not broad dynamics equivalence, driving or whole-world playability. The currently frozen whole-game startup does not acquire these changes automatically.
