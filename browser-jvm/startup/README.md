# Original startup recovery

This runner preserves the original main-thread, menu and loading lifecycle from the surviving private startup generation. It requires a supplied frozen generation JSON and its recorded original JAR, model snapshots, media namespace and browser runtime files. It is not yet a fresh-install build recipe. Proprietary files and generated archives stay under ignored `target`, `.tools` or the supplied private snapshot directories.

Recover the recorded route bytes into a **new** directory under this checkout's `target`:

```powershell
node browser-jvm/startup/recover.mjs PATH/TO/generation-admitted.json D:/zomboid-web/target/browser-jvm/startup-generation PATH/TO/eager-specification.json
```

Recovery checks each copied file's recorded size and SHA-256, restores the original `stdlib.lua` from the recorded installed input, copies the importer inventory, and binds the current host sources and metadata adapter. The recorded eager specification must identify the exact namespace, original runtime inode helper, positive subset hash and excluded paths. Its argument can be omitted only when the source generation already contains that specification. Existing output directories are rejected. The 6,034 prepared model snapshots remain referenced at their supplied private location. Recovery does not start Java, a browser, the original installed game or a server.

Recovery binds the current population native service, kernel and save codec together under one private `population` directory while retaining their browser route URLs. It records their new hashes and imports the copied native-service module in Node before certification or browser startup, so missing exports or unresolved copied dependencies fail during recovery. Other frozen modules and original binary routes retain their recorded bytes.

Run the existing bounded browser path against the recovered generation:

```powershell
node browser-jvm/startup/run.mjs D:/zomboid-web/target/browser-jvm/startup-generation/generation.json C:/Users/me/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe
```

The runner checks all admitted hashes, then publishes all 47,416 nonempty media files (10,044,025,029 bytes) through one retained verified snapshot owner. Positive metadata is certified from that owner's actual bytes before Java starts; original payload reads still use those snapshots. This preparation needs at least that much free temporary disk space. The runner uses real browser input through the original menu and character controls and observes `GameLoadingState` until the original `IngameState` or a real failure/deadline. It records strict network failures independently of original lifecycle progress and attempts original shutdown before closing its owned browser/server. An `IngameState` observation is a loading boundary, not full gameplay parity. Results, checkpoints and screenshots are written to an owned temporary directory printed by the runner.

Append `--interactive` to retain that same genuine world after the first `IngameState` screenshot. Use the original game controls in the browser canvas; click **Stop through the original owner** to request the original exit/save path. The existing total owner deadline still applies, including preparation. Without this option the bounded loading gate requests Stop after its first original world screenshot. Periodic checkpoints retain actual metadata interception counters in both modes.

Windows runs require at least **10 GiB available system RAM before browser launch**. One persistent observer samples the complete owned browser process tree every two seconds, including renderers and GPU processes. The observer uses native process snapshots, owned-process memory counters and native system memory availability; it holds the root process handle and reads its command line directly. Stage/timing records identify slow samples, while only completed memory samples refresh the 15-second watchdog. It requests original Stop at **9 GiB owned private memory** or **6 GiB system memory remaining**, then allows five seconds before closing the owned browser. The hard boundaries are **10 GiB owned private memory** or **4 GiB available system RAM**. These are protective ceilings, not predicted gameplay memory requirements. The observer verifies the browser's private Playwright profile and process creation identity before terminating its tree; other browser profiles are outside its scope.

`memory-samples.jsonl` records actual owned process roles/command lines, private/working memory and available system RAM. Checkpoints retain bounded latest/peak/first-pressure summaries, actual graphics resource counts and scalar live texture-level/buffer upload extents, owned direct-buffer count/capacity and optional Chromium JS heap counters. These counters measure different resources and must not be added together. A budget abort remains a failed run, preserves its reason and cleanup evidence, and skips the expensive final full-media hash audit; it does not establish original VM exit, owner join or successful world loading.

Author-written Java startup sources are under `java`; original game classes must remain unchanged. Any replacement authored entry JAR must retain the qualified original Reader/SDK overlays in the supplied generation and receive new frozen route hashes before execution.

Rebuild the authored Java entry against the supplied generation's ordered JAR overlays:

```powershell
node browser-jvm/startup/build-entry.mjs PATH/TO/generation-admitted.json D:/zomboid-web/.tools/jdk-25.0.1+8 D:/zomboid-web/target/browser-jvm/startup-built-entry.jar
```

The build verifies the recorded classpath hashes, compiles the three startup sources, avatar diagnostic, mapped-buffer adapter (`SpriteBuffers`), current population transport, `FmodArrays` primitive-array transport and authored PNG/STB adapter targeting Java 17, and updates a copy of the generation's entry JAR. It requires the PNG/STB adapter to resolve from the entry archive, including its exact RGBA/no-flip allocation fast path. It retains the already qualified graphics facade from its earlier archive and removes any raw duplicate from the entry JAR. Direct-buffer observations read that facade's existing allocation map without adding a new runtime API. Every original game/vendor archive entry remains byte-identical, including the corrected prepared-scene Reader, and an existing output file is rejected. Bind the resulting JAR and its printed size/hash into a newly frozen generation before running it. The build never runs original game initializers.

Focused source checks:

```powershell
npx eslint browser-jvm/startup --max-warnings 0
node browser-jvm/check-unsafe-float-volatile.mjs
node browser-jvm/verify-media-files.mjs
```

Positive snapshot certification uses four bounded workers while retaining publication order. Each record keeps the original hash and file-identity checks and closes its own handle; workers stop scheduling after a failure and drain before rejection. Recovery binds `map-four.mjs` alongside the certifier (11 ordinary host inputs, 13 with real Bullet). Directory enumeration and payload publication remain serial.

Persistent play is selected with `--play` in place of `--interactive`. It uses the dedicated ignored `.local/persistent-play/playwright_chromiumdev_profile-pz-port` Chromium profile, fixed origin `http://127.0.0.1:38479`, and the UUID in `.local/persistent-play/identity.json` as the same owned Java home on later runs. Keep both files/directories to retain browser saves; an occupied port fails rather than selecting a different storage origin. No personal browser profile or installed game's native saves are used.

In this mode the runner leaves Terms, New Game, Load and Continue to the original game UI and player. Use the original menu Quit/save flow, then **Stop through the original owner**, before browser closure. The authored Stop exit path calls original player saving and `GameWindow.save(true)` when `okToSaveOnExit` is set; actual successful world saving remains unverified. The existing memory limits and total owner deadline still apply. This supplies stable browser storage and reopening coordinates; actual original-world save/reopen has not yet been verified. Browser crashes, forced memory closure and disk durability remain separate qualification limits. The default diagnostic path still creates an isolated home and automates the bounded new-world flow.


An optional original FMOD generation can be assembled from a base generation without Bullet/audio using the supplied HTML5 SDK:

```powershell
node browser-jvm/startup/prepare-original-audio.mjs BASE_GENERATION_JSON D:/zomboid-web/.tools/fmodstudioapi20400html5 D:/zomboid-web/target/browser-jvm/original-audio D:/zomboid-web/.tools/jdk-25.0.1+8 [QUALIFIED_BULLET_ENGINE_DIRECTORY]
```

The optional last argument composes an already qualified real Bullet engine without rebuilding it. The command freezes nine SDK/host routes, rebuilds authored Java helpers while preserving the qualified graphics facade, binds matching served/generation audio admission, and prints the derivative runner. SDK binaries and original banks remain untracked. Only explicit audio admission enables the original sound branch; existing generations remain unchanged.

Current evidence covers genuine 2.04.00 Node engine loading of the original strings bank and 3,215-event main sound bank through range callbacks, plus event creation/start/update/volume/stop/release under `OUTPUTTYPE_NOSOUND`. It does not establish audible browser playback. The original initialization preloads most nonambient events; those requests remain intact. The ordinary Core loose-sound/channel/reverb and SoundManager callback entry points are now implemented; static caller inventory covers FMODManager, FMODSoundEmitter and SoundManager. Actual browser resume/state, original Java array/callback transport, eager preload memory and audible output still require a connected runtime pass. Other FMOD capabilities such as recording and raw PCM remain outside this qualified closure.

The reverb matrix is generated from the supplied SDK header into an ignored, hash-pinned runtime JSON file. All 24 float32 presets match the installed integration library, including its out-of-range preset fallback to HALLWAY. No SDK constants file is committed.

The maintained archive stage can now build the seventeen ordered JARs directly from source:

    node browser-jvm/startup/prepare-base-jars.mjs INSTALLED_GAME_JAR JDK25_DIRECTORY CLIPPER2_JAR NEW_OUTPUT_DIRECTORY

Use the pinned Clipper2 2.0.1b archive. The output must be a new directory beneath the existing workspace target directory. This command runs classfile preparers and compilers only; it does not initialize the game, import native scenes, copy media or launch a browser. Its base-jars.json records source/input/output identities and explicitly leaves executionAdmitted false. The complete scene/media/runtime generation assembly is still a separate prerequisite.
