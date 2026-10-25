# Original startup recovery

This runner preserves the original main-thread, menu and loading lifecycle from the surviving private startup generation. It requires a supplied frozen generation JSON and its recorded original JAR, model snapshots, media namespace and browser runtime files. It is not yet a fresh-install build recipe. Proprietary files and generated archives stay under ignored `target`, `.tools` or the supplied private snapshot directories.

Recover the recorded route bytes into a **new** directory under this checkout's `target`:

```powershell
node browser-jvm/startup/recover.mjs PATH/TO/generation-admitted.json D:/zomboid-web/target/browser-jvm/startup-generation PATH/TO/eager-specification.json
```

Recovery checks each copied file's recorded size and SHA-256, restores the original `stdlib.lua` from the recorded installed input, copies the importer inventory, and binds the current host sources and metadata adapter. The recorded eager specification must identify the exact namespace, original runtime inode helper, positive subset hash and excluded paths. Its argument can be omitted only when the source generation already contains that specification. Existing output directories are rejected. The 6,034 prepared model snapshots remain referenced at their supplied private location. Recovery does not start Java, a browser, the original installed game or a server.

Run the existing bounded browser path against the recovered generation:

```powershell
node browser-jvm/startup/run.mjs D:/zomboid-web/target/browser-jvm/startup-generation/generation.json C:/Users/me/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe
```

The runner checks all admitted hashes, then publishes all 47,416 nonempty media files (10,044,025,029 bytes) through one retained verified snapshot owner. Positive metadata is certified from that owner's actual bytes before Java starts; original payload reads still use those snapshots. This preparation needs at least that much free temporary disk space. The runner uses real browser input through the original menu and character controls and observes `GameLoadingState` until the original `IngameState` or a real failure/deadline. It records strict network failures independently of original lifecycle progress and attempts original shutdown before closing its owned browser/server. An `IngameState` observation is a loading boundary, not full gameplay parity. Results, checkpoints and screenshots are written to an owned temporary directory printed by the runner.

Append `--interactive` to retain that same genuine world after the first `IngameState` screenshot. Use the original game controls in the browser canvas; click **Stop through the original owner** to request the original exit/save path. The existing total owner deadline still applies, including preparation. Without this option the bounded loading gate requests Stop after its first original world screenshot. Periodic checkpoints retain actual metadata interception counters in both modes.

Windows runs require at least **5 GiB available system RAM before browser launch**. One persistent observer samples the complete owned browser process tree every five seconds, including renderers and GPU processes. It requests original Stop at **5.4 GiB owned private memory** or **5 GiB system memory remaining**, then allows five seconds before closing the owned browser. The hard boundaries are **6 GiB owned private memory** or **4 GiB available system RAM**. These are protective ceilings, not predicted gameplay memory requirements. The observer verifies the browser's private Playwright profile and process creation identity before terminating its tree; other browser profiles are outside its scope.

`memory-samples.jsonl` records actual owned process roles/command lines, private/working memory and available system RAM. Checkpoints retain bounded latest/peak/first-pressure summaries, actual graphics resource counts, owned direct-buffer count/capacity and optional Chromium JS heap counters. These counters measure different resources and must not be added together. A budget abort remains a failed run, preserves its reason and cleanup evidence, and skips the expensive final full-media hash audit; it does not establish original VM exit, owner join or successful world loading.

Author-written Java startup sources are under `java`; original game classes must remain unchanged. Any replacement authored entry JAR must retain the qualified original Reader/SDK overlays in the supplied generation and receive new frozen route hashes before execution.

Rebuild the authored Java entry against the supplied generation's ordered JAR overlays:

```powershell
node browser-jvm/startup/build-entry.mjs PATH/TO/generation-admitted.json D:/zomboid-web/.tools/jdk-25.0.1+8 D:/zomboid-web/target/browser-jvm/startup-built-entry.jar
```

The build verifies the recorded classpath hashes, compiles the three startup sources and avatar diagnostic targeting Java 17, and updates a copy of the generation's entry JAR. It verifies every original archive entry remains byte-identical, including the corrected prepared-scene Reader, and rejects an existing output file. Bind the resulting JAR and its printed size/hash into a newly frozen generation before running it. The build never runs original game initializers.

Focused source checks:

```powershell
npx eslint browser-jvm/startup --max-warnings 0
node browser-jvm/check-unsafe-float-volatile.mjs
node browser-jvm/verify-media-files.mjs
```
