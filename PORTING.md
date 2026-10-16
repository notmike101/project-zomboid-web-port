# Toward a playable original-bytecode port

## Original native lighting service

The production indoor lighting backend now has a reproducible original-DLL/browser gate: 896 cells and 43,904 exact packed integer comparisons, with separate incremental retained-chunk and publication/dirty-bit protocols. Keep its native float32 propagation, LOS, traversal order and original packed ABI. Unsupported world features reject explicitly before publication; see `browser-jvm/lighting-provenance.md`. Original `LightingJNI.init()` now also passes through a real service module and narrow CheerpJ4.3 Java17 loader adapter, preserving original initialization and genuine missing-library failures. Continue with normal original world-update inputs, expanding the native oracle when those inputs exceed the admitted indoor closure. This is not yet a completed original `LightingJNI.update` or cell-rendering lifecycle.

## Full installed media discovery

The lazy media service removes the prepared-file whitelist as a filesystem discovery limit. In a separate fresh browser JVM with `user.dir=/app`, original `ZomboidFileSystem.init()` discovers 47,437 active paths through the real installed tree. Original script access returns matching bytes; 47,416 byte-served source files and the installed JAR retain their hashes after the run. Directory metadata is generated in server memory, and canonical-path containment prevents traversal or external-junction reads.

The connected runner now offers this read-only fallback alongside prepared routes, but its walking bootstrap still uses the existing bounded content setup. Full Lua loading, `ScriptManager.LoadedAfterLua()` and whole-game startup remain unqualified. Integrate those original lifecycles incrementally with explicit failure evidence; do not infer readiness from the complete filesystem scan. Continue original cell rendering through actual polygon, lighting and GPU state services rather than growing the authored scene painter.

## Working direction

Preserve the original game implementation where its behavior can be verified.
Supply real browser host services around it where the platform differs.
Do not treat a successful build, a silent stub, or a synthetic game as proof of original-game playability.

The current bridge demonstrates this boundary:

```text
JavaScript host -> original Java/WASM state -> original serialized bytes
              -> browser OPFS file -> page/module reload
              -> original Java/WASM load and next state transition
```

All eight restored transitions match the installed JVM. No original game class or record format changed.
This is a practical example of a JavaScript wrapper providing missing platform functionality.

## What wrappers can and cannot establish

A browser can provide storage, input, timing, rendering, audio, and networking APIs.
Whether those APIs preserve a particular original engine contract requires individual integration and tests.

There are two separate problems:

1. **Build-time compatibility.** TeaVM must resolve every retained Java class and method before browser code can run.
2. **Runtime host behavior.** The resolved calls must perform the required work using browser services.

The OPFS bridge addresses runtime storage at an explicit exported record boundary.
It does not automatically resolve missing `FileChannel`, class-loader, method-handle, or concurrency APIs during compilation.
Those need a compatible Java-library implementation, supported compiler integration, or a different suitable runtime.

The compiler also retains exception and callback paths that a particular normal desktop execution might not take.
An error in that graph is evidence about the build closure. It is not proof that the path runs every time.
The initial Core and seasonal diagnostics each reported 160 missing references across 31 declarations. Standard-library extensions have since reduced the Core diagnostic to 133 references across 24 declarations; the freshly rerun seasonal diagnostic reports the same frontier.
That count includes missing classes, which can conceal further method and native integration gaps.

## Current playability gates

| Gate | Evidence | State |
|---|---|---|
| Original pure and stateful calculations | Seven JVM/browser comparison probes | Selected closures pass |
| JavaScript calling original code | Direct exported climate-color and snapshot calls | Selected calls pass |
| Browser record storage | Real OPFS, exact readback, eight page/module loads | One record integration passes |
| Shared engine initialization | `Core.debug` compile-only entry | Fails on missing Java-library and native integration dependencies |
| Original Lua runtime | Static dependency on that shared initializer | Not run |
| Seasonal simulation | Compile-only original constructor | Fails on its larger retained dependency closure |
| Original input and render loop | Native bindings require implementation | Not integrated |
| Assets, world, physics, audio, multiplayer | No connected runtime proof | Not integrated |

The game is not playable yet. Passing object probes cannot be converted into a meaningful percentage of a full port.

## Next useful engineering step

Reduce and classify the shared Core initializer's compiler graph before writing broad platform emulation.
Select one missing API family, define its observable contract, and test a real implementation independently.
Then rerun Core compilation and preserve the next exact failure, rather than adding unrelated helpers indefinitely.

Use the existing original-game probes and storage failure checks as regression gates.
Require an original-code call path, actual browser execution, and explicit limitations for every new runtime claim.
The first playable milestone must include original state transitions driven by real browser input and rendered through a verified backend.
It must not substitute newly written gameplay rules to simulate progress.

## Alternative runtime check

A fuller browser JVM could reduce Java-library adaptation work if it supports the shipped bytecode and native boundaries.
The [current CheerpJ FAQ](https://cheerpj.com/docs/faq) lists Java 8, 11, and 17 support.
The inspected game class files use Java 25, major version 69.
CheerpJ is therefore not a verified drop-in runtime for this installation. No alternative runtime was installed or tested.
This documentation check does not prove that every alternative approach is unavailable.

The [TeaVM loader](https://teavm.org/docs/wasm-gc-backend/loader.html) supports exported Java calls and custom imports.
Its [Emscripten integration](https://teavm.org/docs/wasm-gc-backend/emscripten.html) also documents linking native code built for the browser.
That does not turn existing desktop DLLs into browser modules. Each native dependency still needs a usable implementation and integration.

## Repository boundary

This work lives on the orphan branch `work/original-bytecode-browser-port`.
Push only that exact branch. Do not update other branches or open pull requests.
Keep original game input, generated modules, machine-specific handoffs, and raw inspection logs outside tracked files.

## Supported runtime adaptation

Standard-library probes compare the adapted contracts in both Java 25 and Chromium.
Reader transfer, path conveniences, linkage errors, legacy String construction, a cooperative FIFO queue, and file-stream construction/lifecycle have real implementations.
They retain validation and error behavior. They add no gameplay replacements.

Functional regex replacement now includes mutation detection and exact group/escaping behavior, with passing JVM/browser comparisons.
LWJGL's `GL` initializer unconditionally loads the desktop OpenGL library before its explicit-init option can take effect.
Its retained callers also reach native texture, matrix-uniform, image-decoding, memory, and ImGui operations.
The next connected integration is an explicitly bounded WebGL backend for third-party graphics APIs, with real framebuffer readback and browser input.
That integration must stay separate from claims of a running original world or player simulation.


The first bounded WebGL backend now runs and responds to browser input. It verifies original Color values and actual framebuffer/error state.
The larger opt-in Core diagnostic previously exposed 38 references across 12 declarations. These are being reduced through real API implementations; graphics interaction is not a playable milestone.
The next native boundary is managed/direct buffer allocation, typed uniform uploads, image decoding, and other retained graphics calls.
TeaVM WasmGC has actual linear-memory direct buffers; their ownership and release behavior must be preserved before replacing native allocation APIs.

The graphics path now passes original ShaderParameter vector-four dispatch into a real compiled shader, in addition to original Color arithmetic.
Real Wasm direct allocations/addresses, original LazyValue field-handle behavior, archive resource reads, and cooperative asset-task execution primitives have browser evidence.
These pieces still do not form the original input/world/render loop. Integer geometry, file channels, locks, SHA-1, native-load failure handling, owned-worker exit, package metadata, and functional regex replacement now have individual runtime evidence. A real polling watch service now passes its JVM/browser checks. The expanded Core initializer now executes successfully in its owned browser worker. The invalid cast was caused by a missing standard exception subtype; its actual implementation fixes the generated type relationship.

Core initialization must run first inside an owned browser worker with an isolated virtual filesystem. Constructor inspection distinguishes retained callbacks from callbacks actually invoked: initial configuration values are set before change callbacks are installed. This permits a bounded initializer probe without starting the installed desktop game. Successful initialization will still require a connected original simulation, asset filesystem, input and renderer before playability can be claimed.

Original Core initialization, shipped Lua compiler/interpreter execution, two unchanged installed Lua helper files, and original selected-file indexing now run in the browser. Real DOM keyboard queries reach unchanged vendor key conversion and query code. The next connected input boundary is original GameKeyboard polling and state transitions; original player construction still requires a valid world, action groups, animation and audio initialization. Direct coordinate mutation would bypass those requirements and cannot establish a faithful playable slice.

Original GameKeyboard polling and state transitions now pass actual browser input tests. Continue through real game Lua environment and mounted assets before world/player setup. Do not bypass original initialization by assigning substitute world or player state.

Original standard-library bootstrapping and one complete original GameVersion Java-to-Lua exposure now execute in the browser. The adapter retains actual class-file generic signatures and the original Java public API; it excludes TeaVM's implementation-only public helpers. Expand retention from the actual exposeAll class list and recursive type-discovery rules before attempting full game Lua initialization. Keep unavailable desktop subprocesses, deserialization and module/desktop operations explicit rather than returning fabricated successes.

The first full LuaManager.init diagnostic now compiles, with explicit unavailable FMOD recording boundaries. It is not qualified as a complete game Lua initialization: broad reflection retention and static initialization effects still need validation. The parse-only ExposureManifestTool records 999 exact exposure seeds and their hierarchy/member/signature metadata without loading game classes. Its deterministic output and every registration-site bytecode offset were independently checked.

Original sandbox defaults and ErosionSeason now execute over unchanged mounted data scripts. Original PNGDecoder, ImageData and TextureID now reach real WebGL texture storage/readback, with independent browser pixel comparison and original disposal. Continue with original DefaultShader loading and sprite renderer buffers before claiming visible game rendering. Whole-exposure precise, conservative and experimental policy-separated compiles currently exhaust the compiler's 8 GB heap; the failed compiler-policy prototype is preserved privately rather than added to the shipping runtime.

## Current connected frontier

Original client model-manager creation, real framebuffer setup and original asynchronous human model/animation loading now complete in a browser experiment. The next character step is normal IsoPlayer model attachment, original animation update and real skinned-mesh GPU drawing. Preserve the original player movement and collision path; an input vector or direct coordinate update is not walking evidence.

The installed Challenge1 map is the bounded geometry source. Tile definitions, real textures, lot headers and original metadata initialization now produce a genuine loaded spawn chunk with 64 floors and 99 objects. BrowserGeometry accepts the caller's existing cell and returns its owned original worker/world lifetime; mount geometry assets before original ZFS initialization, and atlas textures before tile definitions and lot placement. Original food scripts additionally require their real evolved-recipe definitions; a selective loader must retain source provenance and execute the original dependency lifecycle rather than suppressing load errors.

The user authorized the existing explicitly documented private class-version and SDK call adaptations. Preserve their exact manifests and the installed input hashes. No claim of byte-identical loaded game classes is appropriate for that route. Public profile output is isolated under `target/browser-jvm/<profile>/`; do not serve mutable artifacts while rebuilding the same profile.

Selective food loading now succeeds with the actual food, general evolved-recipe and fishing evolved-recipe definitions. Retain all three sources: Item.OnScriptsLoaded rejects food references when either recipe dependency is absent. Original half-apple consumption now changes player hunger, thirst and calories in a browser, without reimplementing those formulas. The public food profile has now passed again with owned cleanup and unchanged installed JAR hash. Integrate this action into the real player/world interface after the original scheduler frame is qualified; the food check is not a playable slice.

Original player model attachment, AdvancedAnimator idle evaluation and skinned GPU drawing now run together with an installed body texture. Continue from this connected path rather than replacing the character's motion or pose. The viewing camera is authored host presentation; bone transforms, mesh, shader skinning and player animation are original. The one-command animation profile now passes and saves an actual character-frame screenshot; build inputs and generated snapshot identities remain verified.

World activation has moved beyond original chunk decoding to the native static-geometry boundary and original erosion initialization. The bounded backend owns world/chunk geometry state and rejects unimplemented commands; it does not provide rigid-body dynamics. Preserve original PolygonalMap2/CollideWithObstacles player collision and connect actual floor squares and the normal player update lifecycle before claiming walking.

Missing textures are a geometry prerequisite: original CellLoader drops ordinary objects when both their texture and the installed missing-tile fallback are unavailable. Mount real atlas data and that genuine fallback before tile definitions and lot placement. PrepareTilePack selects complete original pages for the actual header sprite list, preserving every selected metadata/PNG byte and recording unavailable legacy names. The original pack reader and texture asset managers remain the runtime consumers.


The combined browser session now reaches BrowserGeometry live return, original IsoPlayer construction at (153,158,0), genuine current-square/floor identity and original animation readiness. The first normal scheduler frame is the next separate boundary; no walking claim follows from session readiness. The older background-only timeout is superseded by direct public-helper cleanup evidence. Original WorldStreamer.stop spins without yielding while waiting for its worker; in the cooperative browser JVM the authored Session.close first issues the same public finished=true request and joins the actual worker for up to ten seconds. It verifies true thread exit before calling original stop, preserving queue cleanup. It never assigns a fake thread/null or reports a live worker as terminated.

The host geometry implementation is bounded: command-8 shape transport and per-chunk height bounds are real validated state, as are original MapCollision flags and population loaded-chunk notifications. Clipper allocation/clear preserves owned object identity. Unimplemented polygon operations, rigid-body dynamics and population simulation remain explicit failures. Keep the original Java collision algorithms and supported Java pathfinding selection; do not replace them with authored movement.

Run PrepareGeometryAssets with the installed game root and an existing output directory outside the installation. It prepares geometry-assets.jar, geometry-assets.tsv (relative path, byte count, SHA-256), and sprite-names.txt (sorted unique original header names, LF). Use that last file as PrepareTilePack input. The generator validates destination containment/aliases and original input hashes before writing; installation destinations and a real junction alias were rejected in qualification. Prepared JAR/TSV equality and all 243 independently parsed sprite names passed.

The original Challenge1 floor grid is now visible through the original atlas textures, IsoUtils projection and SpriteRenderer. Keep the player-centered presentation camera read-only. Compose the character over this floor frame only after the genuine entity update succeeds; the current concrete first-frame prerequisite is loading the actual Base.BareHands weapon definition before the original player constructor. Do not replace weapon readiness or movement with flags or coordinate writes.


The current public BrowserGeometry.Session.close has now passed the actual floor-only GPU qualification without the private shutdown workaround: real streamer exit, original stop/pathfinding/world/reuser cleanup, and original asset-executor termination all completed. The final host geometry registry was empty and the owned browser/server closed. The floor frame remained 47,755 visible pixels with hash -60816598 and unchanged original player coordinates. Keep this cooperative host lifecycle boundary; do not modify original gameplay or suppress cleanup failures.

The combined floor/body presentation is now visible and independently checked against a floor-only frame. Use FloorMapRenderer.draw followed by CharacterRenderer.drawInWorld for the connected session; keep original scheduling responsible for animation and movement. The authored presentation camera remains bounded and does not qualify the complete original world renderer, lighting, outfits or occlusion.

Continuous original entity updates require the enclosing original IsoWorld.update: it advances the private world frame identity used by ECS duplicate-update detection. The session now invokes that original world lifecycle instead of reproducing its scheduler calls or assigning frame counters. Static-only physics stepping is implemented for the owned empty dynamic registries; the next tested prerequisite is mounting the unchanged installed WeatherFx.pack and its two loose fog textures for original weather initialization.

Repeated original IsoWorld.update now runs with genuine weather/region initialization. The complete original Idle/defaultWalk clip fields restore real poses and held-key displacement; preserve all 13 scene inputs and their exact source/snapshot hashes. The public play profile passes actual floor visibility, separate body-pixel contribution, held-key displacement and four consecutive zero-input release frames together. A separate 94-frame browser qualification also passes A/S/D/diagonal movement and canvas-blur release after adding the exact SDK21 Stack.removeFirst history adapter. Continue incrementally from this single loaded 8-by-8 chunk: qualify real obstacle collision, then expand genuine chunk streaming, object presentation and original interactions. Do not manually advance or replace animation/gameplay state to make gates pass. The region daemon belongs to the isolated browser context lifetime; original reset cannot yet yield safely, so no same-JVM reset claim is warranted. Full dynamic physics, zombie population simulation, complete world rendering and a whole-game AOT WASM build remain outside the tested scope.
# Current content and renderer frontier

The connected play path now loads complete vanilla script definitions before original model creation, then runs the original distribution merge events and `ItemPickerJava` parser before activating chunks. Actual browser execution records 5,092 items, 241 vehicle definitions and 423 loot rooms. Original Lua is initialized once and retained across those phases. Genuine clothing XML and container acceptance callbacks are included; original region initialization must precede chunk activation. Vehicle/ragdoll definition storage is real metadata transport and does not simulate bodies.

The connected geometry loads a fixed 3-by-3 neighborhood with 576 genuine ground floors. A 100-frame real-browser run crosses the former chunk edge through original updates and verifies release and cleanup. Continue from these nine chunks; automatic loading beyond that neighborhood and original obstacle interactions remain separate work. Full Lua directory loading and `ScriptManager.LoadedAfterLua()` are not yet qualified.

The original `IsoObject.render` FBO sprite path now passes with genuine depth/shader managers. All 219 depth PNGs load after correcting immediate native-buffer release in the host. Reducing NIO calls alone did not fix the former JNI exhaustion: removing ownership-map entries left direct storage for later GC/cleaner processing. The qualified Java 17 `Unsafe.invokeCleaner` now releases the owned root buffer when original code requests memFree, including typed views. The cumulative decoded RGBA size remains about 3.05 GB; measured native storage returns to its starting value rather than retaining that total.

The former float/integer comparison, builtin-overload and global-initializer shader failures are now resolved for the tested original scene closure. The host uses the pinned ShaderFrog parser to preserve expression structure and scopes, promotes demonstrated integer-to-float operations explicitly, resolves custom min/max/clamp by argument types and retains other builtin overloads. Uniform-dependent globals initialize on each shader invocation. Separate-unit compile diagnostics remain real; the facade composes the retained raw stage sources and the actual GPU compiler/linker decides the final program result. Legacy front-color output is carried through a real varying rather than discarded.

With five genuine depth images ready, a fresh browser run calls original `SceneShaderStore` creation and verifies all eight shader objects have real nonzero program IDs and report compiled. Original `IsoObject.render`/subclass methods render all 35 nearby non-floor objects. Comparing GPU pixels before/after their submissions records 44,177 changed pixels; the actual capture shows original walls and furniture. Four original frames and Java cleanup complete, the browser closes and monitored installed hashes match. This is a bounded renderer qualification, not complete depth coverage or continuous original scene presentation in the public play route. Integrate it through the original cell-rendering lifecycle with the current full-content bootstrap; preserve the observed object contribution as a regression gate. Complete depth coverage is qualified below.

The full-content bootstrap additionally qualifies four SDK-overlay classes and nine exact call sites: the previous AnimLayer and ActionContext sites, TileOverlays.updateTileOverlaySprite BCI326 ArrayList.addFirst, and five FluidContainer ArrayList.getFirst sites (readFromScript BCI126 and both primary-fluid getters at BCI24/38). Exact ArrayList insertion passes nine JDK25/browser checks. Original Bleach and WaterBottle creation plus a genuine Water/CarbonatedWater mixture exercise the fluid paths; original primary-fluid selection returns CarbonatedWater and 0.75 for amounts 0.25/0.75. Every redirect is input-SHA/method/BCI qualified and recorded in the private manifest; untested calls remain unchanged.

The final fresh public source build passes with the four-class/nine-site overlay: 21 original frames, nine chunks, 576 ground floors, 5,092 items, 241 vehicle scripts, 423 loot rooms, 262,144 floor pixels and 578 body-changed pixels. Four consecutive release frames are zero-input; initializationErrors is empty, all monitored source hashes match, Java cleanup completes and the owned browser/server closes. The independent cached-input fresh-VM run also passes (22 frames). fullGamePlayable remains false.

Texture upload uses a duplicate-buffer bulk read with actual RED/RGBA byte comparisons across direct/heap and mutable/read-only sources. This preserves position, limit and exact unpack extent. The bulk-copy-only full 219-image diagnostic did not advance beyond the JNI exhaustion frontier: 165 tasks remained at the 60-second deadline. Sampled STB/native ownership and render queues did not accumulate; this motivated the explicit-release experiment below. Do not describe the cumulative decoded image size as measured concurrent heap use or this upload optimization as the memory fix.

That historical deadline failure is superseded by the explicit-release qualification: all 219 images complete within the same deadline, with native buffer count 3,399 and native bytes 13,692,865 both identical before/after loading. A combined fresh-VM run then creates all eight original scene shader programs, renders 35 genuine objects with a 33,932-pixel GPU contribution, completes four original frames and Java cleanup, and closes the browser with all 447 monitored installed hashes unchanged. The public full-content walking build separately passes 22 frames and cleanup. `verify-native-memory.mjs` provides a reproducible native ownership regression after public play preparation.

The next rendering entry is original `IsoCell.render()` and its default `FBORenderCell` path, which owns sorting, chunk caches, cutaways and translucent passes. Inspect and implement the actual Clipper2 polygon operations, LightingJNI results and stencil/alpha-test services it requires; do not replace that ordering with a larger authored painter. Original cell tile-shader initialization, camera/render-settings updates, Core frame/FBO setup and producer/render-thread pumps must retain their normal lifecycle. Full original cell/world presentation remains unqualified.

Stencil masks/comparisons/operations, color write masks, double-precision depth-clear input and scissor state now pass actual GPU checks and an original adapted `GL11C` Java/browser bridge check. The context requests real stencil storage, and invalid calls retain real WebGL errors. `verify-stencil.mjs` reproduces twenty pixel/state cases. These remove six platform boundaries; they do not qualify desktop alpha-test emulation, native lighting or the complete cell-rendering lifecycle.

The original occlusion lookup initializer now matches its native reference exactly: 487 real Clipper2 intersections produce the same 738 integers across all 64 cache slots. Forty-six native/browser transport and geometry cases additionally qualify the closed-path, zero-offset intersection ABI, including positive winding and float32 quantization. Keep unsupported operations explicit. The public play bootstrap initializes this original lookup before floor rendering; its full source build remains the integration gate for the new Java helper and pinned local library. LightingJNI computations and desktop alpha rejection remain separate required services before complete original cell rendering.

That public source-build integration gate passes: the original lookup completes before 21 gameplay frames with movement/release checks, 5,092 items, 241 vehicle scripts, 423 loot rooms, empty initialization errors, 5,870 matching monitored hashes and owned cleanup. Continue from this connected implementation; complete cell presentation still requires real lighting and alpha-test behavior.

The polygon adapter additionally qualifies native zero-offset Difference, required by original Java visibility-graph pathfinding. Its comparison now passes 134 cases: 92 operation cases and 42 native primitive cases, including 108 result polygons and 37 holes with unchanged transport metadata and source hashes. Real AABB/polygon insertion and accumulated clip rectangles preserve caller winding; the original Java bevel method uses the existing qualified path transport. The selected original Java backend separately routes around a real wall with eight nodes and seven collision-free segments. Vehicle visibility graphs and the native backend remain unqualified.

The connected session now delivers original selected-backend path results after its world/action update. Its public gate queues the installed original Lua walk action, reaches the actual loaded target through normal movement/animation, and verifies Succeeded plus original queue/path cleanup and idle state. It completes 132 session frames with the existing keyboard checks, 5,874 unchanged asset hashes and owned cleanup. Preserve this original callback delivery in future Core/IngameState integration; do not add authored path-following or coordinate changes.

Normalized-target alpha rejection now has real shader semantics and an exact original `GL11.glAlphaFunc` Java/browser ABI check. All eight comparisons, early returns, original discard, program changes, cross-stage identifier collisions and depth/stencil rejection pass 113 GPU checks. Floating-point targets and fixed-function program zero remain explicit unsupported boundaries. The legacy sampler-name collision is also resolved structurally: a typed helper precedes original globals, leaving original uniform lookup intact. Twelve original scene shader pairs compile/link, and the public full-content walking build separately passes. Continue with original lighting publication and Core/cell FBO lifecycle integration; these platform checks do not establish complete cell/world presentation.
