# Native lighting service qualification

The service in `lighting-kernel.js` and `lighting-natives.js` implements a bounded, genuine part of the installed lighting solver. It is not a complete lighting-engine replacement and is not connected to the public game runner yet. Neither module changes original Java classes, `LightingJNI.init`, game settings, or saves.

## Protected reference inputs

The native reference inspected and tested on 2026-10-16 is the installed x86-64 `Lighting64.dll`, SHA256 `1866188d8e253de521ba208f06f1db9b9019f333162ff3c31dd83506fafee773`. Its original `projectzomboid.jar` has SHA256 `e1a69eb743ede60b213a0fe7f8b83d4fcab773036d256cc4543a336f3b058a33`.

Portable Ghidra12.1.4 through REA supplied static native control-flow evidence. Proprietary binaries, decompiler output, snapshots, and raw inspection logs remain in ignored local storage. No proprietary source or native result tables are included in these modules.

`LightingQualification.java` is authored test transport. On the reference JVM it loads only the actual lighting DLL and calls the original Java native declarations. It does not start a game, server, Lua runtime, world simulation, or engine worker thread. In the browser it calls those same original native declarations through registered host implementations. The existing prepared Java17 SDK view supplies the original game classes with its separately documented compatibility adaptations.

## Algorithm provenance

Addresses are virtual addresses in the qualified native DLL:

| Native function | Implemented behavior |
| --- | --- |
| `0x180008650` | Native chunk traversal, source-cell seeding, and one FIFO drained per source cell. |
| `0x180004d50` | Ordered directional propagation through actual square adjacency. |
| `0x180004800` | Shortest-path relaxation for duplicate light identifiers and ordered light records. |
| `0x180001f90`, `0x180004800` | Five result slots per square. Overflow replaces the first greatest distance/radius ratio only when the candidate ratio is strictly smaller; it preserves the replaced slot rather than sorting results. |
| `0x180009be0` | Float32 Euclidean neighbor cost with native vertical scale3; cardinal1, diagonal sqrt2 and vertical3. Paths follow supplied geometry. |
| `0x18000de50` | Cached float32 DDA line of sight. Native top-half ascending/bottom-half descending row order is retained because cached intermediate rays make the order observable. |
| `0x1800060e0`, `0x1800046b0` | Cardinal vision-matrix checks, plus both cardinal edges and the diagonal bit from both endpoints for a diagonal step. |
| `0x1800041a0`, `0x180003970` | Near-detection visibility, retained seen history, cardinal-neighbor darkness averaging, integer light attenuation, per-channel RGB maximum, and float32 darkness multiplication. |
| `0x1800090d0`, `0x180009370`, `0x180009950` | Three shared-corner maximum passes, including native mutation/traversal order. |
| `0x180008440`, `0x1800082d0`, `0x1800080d0` | Center-to-corner, shared working-corner, and final output-corner maxima. |
| `0x180004010` | Separate lower/upper center seeds: admitted down/up edges take the maximum with the corresponding adjacent floor before the eight corner passes. |
| `0x18000d440` | Three-dimensional square lookup. Ghidra's initial three-parameter signature omits the native Z argument retained in `in_R9D`; the algorithm preserves that fourth argument. |
| `LightingJNI.stateEndUpdate`, `DoLightingUpdateNew`, native readback methods | Retained geometry, separate queued/worker/published buffers, initial light-registration delay, counters, chunk readiness, and consuming dirty bits. |

The payload is the original49-int format: visibility bits; packed center RGB; darkness and target darkness scaled100000; ambient level; eight packed vertex colors; result-light count; then up to five6-int records. Unused words in a caller's Java array remain unchanged. Result-light Z retains the original native32 offset.

The main write queue and worker buffer remain separate when a second update arrives before the worker finishes. Deferred geometry accumulates, and the worker can complete while another main-thread draft is open. Native ready chunks inherit readback square-dirty bytes at worker time before marking changed payloads or submitted geometry. The native0xea50 swap also recycles unread chunk-dirty maps from the old readback buffer into the next worker buffer. Consequently, consuming dirty bits before versus after the worker can change the next publication's dirty state even when lighting values match. The service preserves both buffer rules. Diagnostics retain only the last completed update and clear it on destroy.

At the JNI boundary, unsupported inputs reject with a real Java `UnsupportedOperationException`; invalid protocol state rejects with `IllegalStateException`. Successful native calls retain their synchronous fast path. A raw JavaScript exception would stop the CheerpJ Java thread before its catch/finally blocks, so the adapter constructs and throws the actual Java exception through the calling library. The browser qualification requires both Java catch clauses and finally cleanup to run before the normal native comparisons.

## Qualified scope and explicit rejection

The native service accepts one player, a fixed rectangular region of8x8 chunks, indoor squares, opaque directional geometry, no rooms/buildings, and at most seven globally registered static point lights inside the region. Its level-major representation covers native levels0..63; the direct native/browser vertical fixtures qualify levels32..34. Each chunk supplies its own minimum/maximum level. Explicit null squares remain absent, while up/down adjacency, stairs and all27 vision-matrix bits participate in the original algorithms. It retains unchanged chunks when original Java stops submitting geometry and accepts selective changed-chunk updates. Previously seen squares remain seen after an opaque geometry change.

Seven registered lights and five per-square result slots are different limits: seven is the current host qualification guard, while five is the recovered native result format and replacement algorithm. More than five coincident source lights still reject until native source-cell overflow is separately qualified. The service does not discard upper-floor lamps or select a sorted nearest-five list.

Changed vision geometry requires the original LOS-cache invalidation signal. Native cached LOS for changed geometry without that signal is not ported; such an update rejects before publication rather than recomputing a different visibility result.

The bounded region is at most24x24 squares, with nonnegative chunk coordinates through65535. All region corners must be within the qualified horizontal near-detection radius20 of the fixed player. Inputs are checked for finite values, integer bounds, geometry, duplicate lights, and valid transmission tuples before a staged region update can replace retained or published state. Changing an established chunk's level extent remains explicit unsupported.

Frame settings currently admitted are exactly the reference closure: RGB modifiers1, ambient0.1, night1, view and maximum view20, lightSourceUpdate100, skylight0, fatigue0, vision-cone threshold-0.2, and four false player flags. The original LOS cache-cleared input may be true or false. These guards describe tested inputs; the service does not rewrite game values to fit them.

Explicit unsupported handlers throw for scrolling/resizing, room/building identifiers, outdoors, other ambient/sunlight settings, colored/translucent edges, curtains/doors/windows/thumpables, temporary/room/torch lights, light removal/active toggles, moving-player history, fractional player levels, and far-field vision cones. The seven legacy scalar readback getters also reject until independently qualified; the packed readback used by the tested path is implemented. All50 original native method names have either an implemented handler or an explicit unsupported handler. There is no white-light or empty-success fallback.

Packed readback before a worker buffer has actually been published rejects explicitly. The native DLL can expose uninitialized storage in that phase, so deterministic zero payloads are not a native contract. Reading an explicitly absent square inside a registered chunk level likewise rejects: native null-square readback was observed to return uninitialized words. Null geometry is qualified by its effect on present neighboring squares, which are the squares consumed by the original Java caller.

## Reproducible qualification

Prepare the play SDK profile first, then run on Windows:

```powershell
$env:PZ_JDK = 'D:/path/to/jdk-25'
$env:PZ_BROWSER = 'C:/path/to/chrome.exe'
$env:PZ_GAME_DIR = 'C:/path/to/ProjectZomboid'
node browser-jvm/verify-lighting.mjs
$env:PZ_LIGHTING_SDK = 'D:/path/to/frozen-prepared-play-sdk'
node browser-jvm/verify-lighting-vertical.mjs
npx eslint browser-jvm/lighting-kernel.js browser-jvm/lighting-natives.js browser-jvm/verify-lighting.mjs browser-jvm/verify-lighting-vertical.mjs --max-warnings 0
```

The verifier builds only the authored fixture under `target/browser-jvm/lighting-qualification`, runs two independent native JVM processes per protocol, and starts a fresh Java17 CheerpJ browser context per protocol. Its server exposes only the fixture, the two production modules, and the existing SDK archives. External browser requests are restricted to CheerpJ4.3. It hashes source inputs, original DLL/JAR, generated fixture archive, and SDK archives before/after, and closes browser/server/native processes. Evidence and raw native reference output remain ignored under that target directory.

The regression gates compare:

-896 general-scene cells, all43,904 packed words, across open/gap/maze layouts, multiple lights, a chunk seam, and three independently seeded arbitrary opaque-edge scenes across1/3/4chunks.
-976 general JNI payload/counter/readiness/dirty lines.
-1040 incremental lines:896 initialized full cell payloads and128 explicitly unpublished coordinates over8frames, with two initial chunks, no geometry resubmission on stable frames, and only one changed chunk later. Unpublished coordinates retain protocol markers without querying native payload storage.
-18 publication lines covering unpublished state, worker/readback separation, a changed light color, and consuming chunk/square dirty state.
-38 pending/interleaving lines covering a second main update before worker completion, worker completion inside an active draft, deferred geometry and readback dirty-bit timing.
-Malformed and unsupported input rejection before publication.

The separate vertical gate compares 6,143 initialized real-square payloads, all 301,007 packed words and 96 per-level publication/counter/waiting/consuming-dirty lines. Its 16 scenes include three floors, sealed floors, open shafts, one-way vertical links, stair-level adjustment, openings, opaque 3D edges, seven global lights with five-slot overflow, explicit null geometry, a 3×3-chunk region with a cross-seam upper-floor light, nonzero world origins and two complementary asymmetric cardinal edges. Every native scenario runs in two independent data-only JVM processes. The browser executes the unchanged original initializer and declarations, verifies Java catch/finally for unsupported torch input, and calls original LightingJNI.stop for cleanup. Only frozen SDK archives and allowlisted qualification files are served; installed media and native saves are not mounted.

Native0xde50 accumulates its float32 LOS ray fractions in world coordinates. Localizing those accumulators changes rounding at nonzero chunk origins. The kernel preserves world-coordinate accumulation through explicit origin metadata, then converts each stepped square back to its local array index. The nonzero-origin regression uses chunk origin18,18, three chunks per axis and three indoor levels within the existing near20 closure; it exposed83 packed-word mismatches with the previous local-coordinate calculation. All1728 payloads/84672 words match the original DLL after the correction. Region, frame, geometry and perception qualification limits remain unchanged.

The browser gates also run unchanged original `LightingJNI.init()`: its actual `System.loadLibrary("Lighting64")` imports `Lighting64.js`, registers the real service, calls its configure method and sets the original initializer's counters to four minus-one values. A deliberately missing native module must still throw `UnsatisfiedLinkError`. These gates establish original initialization, the qualified algorithm and JNI transport. They do not establish original `LightingJNI.update`, `FBORenderCell`, or whole-game rendering.

## Java17 native module loading

The [official CheerpJ native-library guide](https://cheerpj.com/docs/guides/implementing-native-libraries) documents loading a JavaScript module with original `System.loadLibrary` and `java.library.path`. An isolated standard-Java probe succeeds under CheerpJ4.3 Java8 with a real module-provided native result. The same probe under Java17, and unchanged original `LightingJNI.init`, fail with `Missing import: JVM_LoadLibrary` before the service module imports.

A diagnostic override of `jdk.internal.loader.NativeLibraries.load` also intercepted built-in `jimage` loading during JDK bootstrap and was rejected. The qualified fix leaves that original native method intact: `native-library-loader.js` supplies the missing `JVM_LoadLibrary` C import in CheerpJ4.3's existing runtime export/import map. It delegates the actual native path and continuation to the existing `cj3LoadLibrary`, using its NUL-terminated length sentinel. That runtime loader performs the actual read, module import, native registration, suspension and handle return. Existing built-in loading, symbol lookup and original Java bookkeeping remain in control. An existing implementation is preserved.

`Lighting64.js` exports a fresh real backend's JNI map. CheerpJ imports service modules through blob URLs, so its dependency uses an absolute same-origin URL. A private relative-import failure is preserved separately; no successful load is reported when that module fails. The public verifier exercises actual initialization and all three native comparisons through this module. This adapter is qualified against CheerpJ4.3 Java17 runtime exports, which are not a documented stable public API; requalify it on runtime updates. No Java initialization flag, game method body or installed library is patched.

Native functions 0x5d80/0x5d60 build the union of both endpoint cardinal bits. Point propagation (0x4d50) and cardinal vertex neighbors (0x90d0/0x9370/0x9950) consume that combined field. Diagonal vertex neighbors and darkness averaging retain the directed field; vertical behavior is unchanged. The west-target-bit fixture exposes 12 pre-fix packed-word differences, and a complementary east-source-bit/radius1 fixture exposes four vertex differences. Both now match. An explicit null endpoint also matches all 63 present payloads and prevents propagation across absent geometry. The five earlier publication/dirty-state protocols pass after the correction.
