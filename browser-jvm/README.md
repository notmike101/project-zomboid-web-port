# CheerpJ browser JVM graphics qualification

The runner also has an opt-in `--profile lua` qualification. It executes the complete original `LuaManager.init()` and its original full exposure list in the browser JVM, followed by Lua calls that construct, normalize and scale an original `Vector2` and compare/rotate original `IsoDirections` enum values. This avoids the full-graph AOT compiler memory barrier; it does not establish complete game compatibility or a playable world.

Run unchanged original game algorithms with a small, explicit browser implementation of selected third-party graphics entry points. This workflow qualifies actual PNG decoding, shaders, texture upload and GPU readback. It does not start the game or provide a complete LWJGL/GLFW backend.

From the repository root, with the existing `playwright-core` dependency available:

```powershell
node browser-jvm/run.mjs --game-jar 'C:/Games/steam/steamapps/common/ProjectZomboid/projectzomboid.jar' --media-root 'C:/Games/steam/steamapps/common/ProjectZomboid/media' --jdk 'D:/zomboid-web-2/.tools/jdk-25.0.1+8' --browser 'C:/Users/me/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe'
```

Supply your own installed paths. The JDK must support Java25's Class-File API; the authored application entry is compiled for Java17. The browser must support WebGL2. No installation runs. CheerpJ4.3 runtime resources are fetched from `https://cjrtnc.leaningtech.com/4.3/`, so the test requires network access to that origin.

Append `--profile lua` to that command to run the original Lua bootstrap. The default remains `graphics`. The Lua route builds a reusable `runtime-view.jar`, `float-bridge.jar` and `memory-bridge.jar`; these are private generated runtime support artifacts, separate from the authored `full-entry.jar`. All live original game classes come from the supplied installed archive. `result-lua.json` and `result-graphics.json` preserve each profile's latest evidence alongside `result.json`.

The Lua route mounts the actual installed root `stdlib.lua`, `media/lua/shared/defines.lua` and `media/lua/shared/Sandbox/Apocalypse.lua` by copying their HTTP read-only bytes into genuine browser JVM `/files/work` directories. Both original random generators initialize, original `ZomboidFileSystem.init()` scans those directories, then the complete original `LuaManager.init()` executes. This is a bounded three-file asset mount, not the entire installed media tree. The writable filesystem belongs to the owned incognito browser context; installed save files are never mounted. All three source assets and the installed archive are hashed before and after the run.

Two additional third-party host boundaries are adapted for this route:

- The one `Field.get` call in Kahlua's `LuaJavaClassExposer.exposeStatics` routes public static float, char, boolean, short and byte reads through generated Java17 methods. Each method contains a literal `getstatic` and the appropriate wrapper `valueOf`, preserving real JVM field storage, class initialization and volatile reads. Members are discovered from class-file metadata, including exported public JDK fields; no field values are substituted. Other reflection operations delegate to the real JVM. This addresses CheerpJ's currently failing primitive reflective accessors. The fixture checks 24 mutable/final reads, including signed zero. These generated methods do not claim support for private reflection or additional SDK types.
- `GLFWGamepadState` uses real owned direct-buffer storage: 15 button bytes at offset0, six float axes at offset16, size40 and alignment4. The original vendor `GamepadState` constructor, copy and cleanup methods still execute; only its two `MemoryUtil.memAlloc/memFree` calls select owned browser buffers. The fixture checks copied values, separate allocation identity, release accounting and freed-state rejection. This value-storage facade does not implement native `Struct` inheritance, native pointers or GLFW gamepad polling. Unsupported native consumers remain unsupported; no native library load is reported successful.

`PrepareRuntime.java` preserves original game class bytes from the header-only load view. Its only new vendor changes are the Kahlua call boundary, the two vendor buffer allocation calls and the explicit gamepad value facade. The existing graphics adaptations remain available in the same runtime view. The build briefly uses an authored native declaration solely to compile the entry's reference to the getter helper; the generated real getter implementation replaces it before any browser execution. No installed class initializes during preparation.

All generated classes, private archive copies and logs are written under `target/browser-jvm/`. `result.json` contains the pass/fail outcome, original archive/PNG hashes before and after, generated archive hash, browser requests and cleanup status. `class-manifest.json` records every original class's original/view SHA256, class-file versions and exact selected vendor method adaptations. `build.json` records compiler/preparation results. A failed run exits with a nonzero status.

Before writing, the runner rejects prerequisites inside generated output, resolves existing path aliases and checks that output destinations stay within the workspace target directory. The preparation tool independently rejects an input/output archive alias, including `Files.isSameFile` aliases. Shader/program integer queries are qualified only for compile/link status; other enums explicitly fail rather than returning a misleading zero.

The actual browser checks cover:

- Real GL clear/readback, four exact RGBA pixels and direct-buffer offset/sentinel/position/limit preservation.
- Actual shader compilation, program linking, vec4 uniform upload using original `Color` and vendor `Vector4f`, patterned texture upload, triangle drawing and exact output bytes.
- Original `PNGDecoder` reading installed `media/ui/avatarBackgroundWhite.png` through the full Java runtime. Every decoded RGBA byte must match an independent browser PNG decode, then every GPU readback byte must match those original decoder bytes.
- Real invalid-shader and invalid-program failures with nonempty diagnostics; rejection of an undersized output buffer; `UnsatisfiedLinkError` for the deliberately unimplemented `glFinish` native.
- Java `finally` deletion of shaders/programs/textures and removal of their uniform handles. Final resource counts must be zero. Owned browser/server close on successful or failed runs.

`PrepareBrowserJvm.java` copies the supplied archive into a private load-view. It lowers class-file major versions greater than61 to61 and verifies all non-adapted class bytes remain identical outside those two header bytes. This is a compatibility experiment, not a claim that arbitrary Java25 bytecode features work on Java17.

Six vendor classes (`GL11C`, `GL12C`, `GL13C`, `GL14C`, `GL15C`, `GL20C`) have their desktop `GL.initialize()` class initializer replaced by browser backend selection; the JavaScript host creates and validates a real WebGL2 context before Java executes. Selected GL11C texture/readback wrappers and GL20C shader/status/log/location wrappers route to actual browser implementations. Existing native clear/draw/shader/uniform declarations use CheerpJ's native hooks. Original game method bodies, including `Color` and `PNGDecoder`, remain unchanged. The manifest identifies all adapted methods.

Primitive arrays perform real bulk byte transfer; Java absolute buffer access preserves caller state. No fake native addresses, successful OS library loads, native-memory compatibility or zero-copy behavior are claimed. No `MemoryUtil`, GLFW window/input implementation, or full OpenGL compatibility is provided. Other native methods remain unresolved; other unqualified wrappers can fail when they reach desktop dependencies. `ShaderParameter` is not part of this qualification because its original static initializer requires a separately implemented `MemoryUtil.memAllocFloat` backend.

The server binds only `127.0.0.1` and serves fixed allowlisted routes: the authored page, generated private archives and exact installed profile assets. It supports byte ranges. It never maps request paths to arbitrary filesystem paths. Browser requests are limited to GET/HEAD for those routes and pinned CheerpJ4.3 runtime resources. The original archive and assets stay on the local machine; none are uploaded or published. Do not publish generated archives or assets.

Official API references: [native libraries](https://cheerpj.com/docs/guides/implementing-native-libraries), [native hooks](https://cheerpj.com/docs/reference/cheerpjInit), [primitive arrays and raw JNI memory](https://cheerpj.com/docs/reference/CJ3Library).
