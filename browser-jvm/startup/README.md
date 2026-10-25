# Original startup recovery

This runner preserves the original main-thread, menu and loading lifecycle from the surviving private startup generation. It requires a supplied frozen generation JSON and its recorded original JAR, model snapshots, media namespace and browser runtime files. It is not yet a fresh-install build recipe. Proprietary files and generated archives stay under ignored `target`, `.tools` or the supplied private snapshot directories.

Recover the recorded route bytes into a **new** directory under this checkout's `target`:

```powershell
node browser-jvm/startup/recover.mjs PATH/TO/generation-admitted.json D:/zomboid-web/target/browser-jvm/startup-generation
```

Recovery checks each copied file's recorded size and SHA-256, restores the original `stdlib.lua` from the recorded installed input, copies the importer inventory, and binds the current host sources. Existing output directories are rejected. The 6,034 prepared model snapshots remain referenced at their supplied private location. Recovery does not start Java, a browser, the original installed game or a server.

Run the existing bounded browser path against the recovered generation:

```powershell
node browser-jvm/startup/run.mjs D:/zomboid-web/target/browser-jvm/startup-generation/generation.json C:/Users/me/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe
```

The runner checks all admitted hashes before creating the HTTP/browser owners, uses real browser input through the original menu and character controls, and observes `GameLoadingState` until the original `IngameState` or a real failure/deadline. It records strict network failures independently of original lifecycle progress and attempts original shutdown before closing its owned browser/server. An `IngameState` observation is a loading boundary, not full gameplay parity. Results, checkpoints and screenshots are written to an owned temporary directory printed by the runner.

Author-written Java startup sources are under `java`; original game classes must remain unchanged. Any replacement authored entry JAR must retain the qualified original Reader/SDK overlays in the supplied generation and receive new frozen route hashes before execution.

Focused source checks:

```powershell
npx eslint browser-jvm/startup --max-warnings 0
node browser-jvm/check-unsafe-float-volatile.mjs
node browser-jvm/verify-media-files.mjs
```
