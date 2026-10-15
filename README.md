# Project Zomboid Web Port

Personal-use standalone browser reimplementation project. **0.1.0-preview.1 / M1 architecture proof — not a completed port, not yet a playable recreation.** No streaming or native simulation service. The complete destination and acceptance gaps remain in [ROADMAP](docs/ROADMAP.md) and [COMPATIBILITY](docs/COMPATIBILITY.md).

## Windows prerequisites

Install [Node 26.10.0](https://nodejs.org/download/release/v26.10.0/) (npm 11.19.1), [Git for Windows](https://git-scm.com/download/win), and [rustup](https://rustup.rs/) with the MSVC toolchain prerequisites (Visual Studio Build Tools C++ workload/Windows SDK). These are development-only tools; receiving devices do not need them. `scripts/Windows.ps1 Setup` installs pinned Rust 1.96.0, rustfmt, clippy, wasm32-unknown-unknown and locked npm packages. The Windows resolver accepts `npm.cmd` or `npm.exe`. Local ESLint packages are installed from `vendor/`, not a guessed registry name.

```powershell
# From a clean checkout:
.\scripts\Windows.ps1 Setup
.\scripts\Windows.ps1 Build
.\scripts\Windows.ps1 ProvisionContent -Source 'C:\Games\steam\steamapps\common\ProjectZomboid'
.\scripts\Windows.ps1 Check
.\scripts\Windows.ps1 Run
# Open http://127.0.0.1:4173 in a WebGPU-capable Chromium browser.
```

Equivalent commands: `npm ci --ignore-scripts`; `rustup target add wasm32-unknown-unknown`; `npm run build`; `node scripts/provision-content.mjs --source "C:/Games/steam/steamapps/common/ProjectZomboid"`; `npm run check`; `npm start`. Tests instantiate built WASM, so build first. The preview serves static application files from `dist/` and approved content from a separate directory at `/content/`; all simulation runs in the browser. Use a WebGPU-capable secure-context browser. No WebGL fallback.

## Private content directory — automatic startup

There is **no asset picker or gameplay-file import in the web UI**. Before opening the application, provision your own installation's media into a separate directory once:

```powershell
.\scripts\Windows.ps1 ProvisionContent -Source 'C:\Games\steam\steamapps\common\ProjectZomboid'
# Optional small startup copy instead of all approved media:
.\scripts\Windows.ps1 ProvisionContent -Source 'C:\Games\steam\steamapps\common\ProjectZomboid' -StartupOnly
# An already copied content/media tree, optionally content/mods:
.\scripts\Windows.ps1 ProvisionContent -IndexOnly -Output 'D:\PrivatePZContent'
.\scripts\Windows.ps1 Run -ContentRoot 'D:\PrivatePZContent'
```

CLI equivalents: `node scripts/provision-content.mjs --source INSTALL --output content`; use `--startup-only`, `--index-only`, `--mods-source USER_MODS`, `--hash` and `--source-build OBSERVED_VERSION` as needed. The default source is `C:/Games/steam/steamapps/common/ProjectZomboid`; source/output are configurable. `--index-only` cannot be combined with copying options. Default output is the ignored `content/` directory, never `dist/` or a release. `CONTENT_ROOT` selects the preview's approved content root (default `content/`). This is static provisioning, not a required native converter, companion process or game execution.

Copying includes only recognized data/source formats under `media/`, optionally a plain-text root `stdlib.lua`, plus explicitly selected user mods under `mods/`. Executables, JARs, DLLs, Lua bytecode, original saves and arbitrary installation-root files are excluded. Links/junctions and overlapping source/output trees are rejected. The original installation and saves remain read-only. Provisioning never overwrites existing asset bytes or deletes unrelated files; restarting the same command copies missing files and rewrites only this tool's `manifest.json`. Existing unrelated manifests are refused. An interrupted run can leave partial copies but no newly published manifest; rerun to complete. To update changed assets, provision into a **new empty directory** and switch the host/root once complete; rerunning is not an in-place asset update.

`manifest.json` uses `pz-web-content-directory` version 1 with relative file paths, sizes, modification times, optional streamed SHA-256 hashes, explicit startup assets and discovered mods. Stat-only indexing is the default: texture banks are never loaded wholesale to generate metadata. Source build is `unknown` unless you supply an observed version label; the helper does not invent or execute build discovery. Original spaces, commas and filename case remain intact.

Startup roles are matched case-insensitively against the inventory, but the manifest and copied files retain the actual original spelling (for example `Bob_Idle.X`). This makes the directory portable to case-sensitive static hosts. Multiple files that differ only by case for one startup role are rejected as ambiguous, never silently selected or renamed.

Automatic startup is bounded to the four Tutorial cells (0_0, 0_1, 1_0, 1_1), five floor/overlay/tree texture packs, tile definitions, MaleBody mesh, Bob idle/walk animations, MaleBody02a texture and three loose sound cues. `--startup-only` also includes the original `media/scripts/generated/items/clothing.txt` and `container.txt` definitions needed to seed footwear, hands and bags, plus optional `stdlib.lua`; the default may retain all approved media for future gameplay. Restart provisioning to add missing required files without overwriting existing assets. Startup position (190.5,190.5) is a browser approximation, not an original spawn-parity claim. Missing required startup files fail with their names. This startup subset does **not** establish complete gameplay, world, animation, FMOD event playback or native engine parity.

## Input and mods

The game fills the browser viewport; there is no header, sidebar, footer or visible debug panel. The ready canvas receives keyboard focus automatically. WASD/arrows provide manual movement; click/tap a destination to travel without holding a key. Space stops movement. Escape cancels movement and opens the hidden in-game pause menu; Resume returns focus to the world. Movement assistance in that menu provides direction toggles and fractional X/Y destinations, automatically resuming play when selected. Save/load, backup transfer and mod controls stay in the menu. Hidden tabs/blur cancel movement; resume never catches up elapsed offline time. Control remapping remains pending.

The bundled **Accessible walking** JavaScript mod uses the browser mod API. Separately copied trusted mods can be provisioned with `--mods-source USER_MODS` (PowerShell: `-ModsSource PATH`), or placed under `content/mods/` before `--index-only`. The manifest discovers `mod.json` browser JavaScript packages and `mod.info` native Lua packages, grouping Build 42 `common/` and numeric version roots. Discovery does not prove that a native mod's full engine APIs are implemented. Reload after changing provisioned content; the web UI does not select/import asset or mod folders. **Safe mode** (`?safe-mods=1`) is the recovery route for incompatible mods. [Mod author guide and delivered API](docs/modding/README.md). Executable mods are trusted code, not a security sandbox.

Provisioned JavaScript package activation state survives menu Save/Load, reboot and New session initialization. Mod namespace schema migration from 1 to 2 is browser-proven only with the same exact package version (`1.0.0`); a package-version mismatch intentionally blocks automatic restoration. This is not general cross-version mod compatibility or unmodified Workshop gameplay acceptance.

Native Lua packages now use that same manager: discovered disabled, enabled only with explicit consent, executed without JavaScript rewrites, and skipped in safe mode. Supply an **observed numeric game version** with `-SourceBuild` / `--source-build` before enabling native code; for the recorded installation this is `42.21.0`, not a version label with a Steam suffix. Unknown builds block native execution without preventing ordinary directory startup. The interpreter provides bounded source `require`, mapped movement/state/events and persistent namespaces—not the complete original engine.

Owned Lua browser checks exercise real WASM movement, save/reboot, failed-load rollback preserving committed closure state, and exclusion of consent changes during activation. They do **not** establish that an existing Workshop mod's gameplay or UI works; original inventory, health and UI APIs remain prerequisites.

## Release and hosting

After committing verified source: `./scripts/Windows.ps1 Release`. Creates an allowlisted asset-free application directory with version, source revision and SHA-256 file manifest under `release/`. No original assets, native binaries or saves are part of source/application releases. Keep private content in ignored `content/` or outside the checkout; never copy it into `dist/`, application release artifacts or Git. Application CI uses synthetic tests only and does not claim GPU proof.

Release requires a clean tracked and untracked source tree and creates a new version/revision directory; an existing destination is rejected, never merged or overwritten. Keep private inputs outside the checkout. `Check` runs `eslint . --max-warnings 0`, Rust formatting, clippy with warnings denied, native/WASM integration contracts and documentation links. Vendored lint rules are not disabled.

The release audit accepts only the exact `applicationFiles` targets from `scripts/build.mjs` plus `build.json`, including `licenses/wasmoon.txt` and `licenses/lua.txt`. An otherwise familiar extension does not authorize an extra file: unknown `.txt`, `.json`, `.js` or `.wasm` content is rejected. Keep both dependency license texts with the application.

Deploy release application files to an HTTPS static host, then separately copy/transfer your privately provisioned directory into a `content/` folder beside the hosted application (`/content/manifest.json`, `/content/media/...`, `/content/mods/...`). The receiving device needs only the browser, not Node, Rust, a running native game or a companion service. Application files alone supply neither game content nor saves. Keep game files on authorized private hosting; do not publish them in public Git, application releases or public asset servers.

The static host must support single HTTP byte ranges: `206` with `Content-Range`/`Content-Length`, `416` with `Content-Range: bytes */SIZE`, and `HEAD`. Large banks are fetched in bounded slices, not whole-bank buffers. The local preview streams these responses and restricts content to the separate approved root; it does not expose original installation executables or arbitrary disk paths. Content MIME examples: PNG `image/png`, packs/maps `application/octet-stream`, manifest `application/json`. WASM MIME: `application/wasm`; JavaScript: `text/javascript`. Use HTTPS (localhost is a secure-context exception); plain remote HTTP will not enable WebGPU. No COOP/COEP headers are required (no shared memory). Keep complete versioned applications together; do not mix old JavaScript with new WASM. Content transfer is independent of browser save export/import; original native saves are not migrated.

## Troubleshooting

- `WebGPU unavailable`/adapter failure: use HTTPS or localhost and an eligible GPU/browser; backend never silently falls back. Browser implementation support does not certify a device; see matrix.
- Device loss: simulation stops and an accessible reload instruction appears. This fatal message takes precedence over delayed save/load or content-request failures; reload to fetch provisioned startup content again. Recovery does not restore an unsaved session.
- `cargo`/linker missing: install rustup and MSVC prerequisites, then run Setup. The Rust target/toolchain is pinned in `rust-toolchain.toml`.
- `npm ci` errors: use exact Node/npm versions and vendored archives. ESLint 9.39.4 is pinned to vendor peer baseline; npm reports it deprecated. Upgrade as a coherent lint/toolchain change, not an unrecorded install.
- Remote repository operation blocked: app-scoped credentials must have access to the private target repository. Local commits retain verified bot attribution; no personal fallback.
- Content missing/404: provision before opening the app; check `content/manifest.json` or `CONTENT_ROOT`, and verify the host maps `/content/` to that separate directory. A range request returning `200` rather than `206` means the host must be configured for byte ranges. Do not resolve missing content by pointing a public server at your installation.
- Saved-world geometry missing: every saved navigation cell requires its original lotheader and lotpack, including cells away from the player. Startup stops with the missing paths and preserves retained saves; provision those files or explicitly choose New session.
- Required streamed tile content unavailable: movement pauses with a visible functional error naming the failing content and instructing you to provision it and reload. This uses the game's error surface, not a separate debug overlay; known unresolved vegetation names remain a fidelity gap.

## Project record

- [STATUS: verified capabilities, evidence, blockers and next command](docs/STATUS.md)
- [ROADMAP: destination and ordered acceptance criteria](docs/ROADMAP.md)
- [DECISIONS: responsibilities, versioned ABI and architecture rationale](docs/DECISIONS.md)
- [COMPATIBILITY: build-specific fidelity, asset and platform gaps](docs/COMPATIBILITY.md)
- [Modding guide/API](docs/modding/README.md)

Reproducibility: dependency/toolchain versions and lockfiles pinned; native toolchain, Windows runner image and GPU/browser implementation vary. No claim of byte-identical builds or mobile support without measured device evidence.
