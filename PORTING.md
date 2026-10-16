# Toward a playable original-bytecode port

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
