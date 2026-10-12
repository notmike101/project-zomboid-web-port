# Project Zomboid Web Port

Personal-use standalone browser reimplementation project. **0.1.0-preview.1 / M1 architecture proof — not a completed port, not yet a playable recreation.** No streaming or native simulation service. The complete destination and acceptance gaps remain in [ROADMAP](docs/ROADMAP.md) and [COMPATIBILITY](docs/COMPATIBILITY.md).

## Windows prerequisites

Install [Node 26.10.0](https://nodejs.org/download/release/v26.10.0/) (npm 11.19.1), [Git for Windows](https://git-scm.com/download/win), and [rustup](https://rustup.rs/) with the MSVC toolchain prerequisites (Visual Studio Build Tools C++ workload/Windows SDK). These are development-only tools; receiving devices do not need them. `scripts/Windows.ps1 Setup` installs pinned Rust 1.96.0, rustfmt, clippy, wasm32-unknown-unknown and locked npm packages. The Windows resolver accepts `npm.cmd` or `npm.exe`. Local ESLint packages are installed from `vendor/`, not a guessed registry name.

```powershell
# From a clean checkout:
.\scripts\Windows.ps1 Setup
.\scripts\Windows.ps1 Build
.\scripts\Windows.ps1 Check
.\scripts\Windows.ps1 Run
# Open http://127.0.0.1:4173 in a WebGPU-capable Chromium browser.
```

Equivalent commands: `npm ci --ignore-scripts`; `rustup target add wasm32-unknown-unknown`; `npm run build`; `npm run check`; `npm start`. Tests instantiate built WASM, so build first. Node server only serves static `dist/`; all simulation runs in the browser. Use a WebGPU-capable secure-context browser. No WebGL fallback.

## Real local asset import

Close the native game for standalone checks. Click **Import gameplay PNG** and choose an original gameplay image from your own installation. The default discovery input is `C:\Games\steam\steamapps\common\ProjectZomboid`; it is not baked into the application/build. Exact inspected image/build and local validation are recorded in STATUS/COMPATIBILITY. PNG only in M1: maximum 16 MiB file, 4096×4096 and 64 MiB estimated RGBA8 GPU texture, subject to adapter limits; this is not a browser-decoder peak-memory guarantee. All decoding/upload occurs in the browser. Reimport after reload; no asset persistence yet. No automatic filesystem scanning, upload, extraction or native converter.

Imported art is a moving marker over a synthetic bounded plane, **not the original world or an animated character**. The pipeline proves imported pixels, WASM movement and mod integration; it does not prove gameplay fidelity.

Inspected sample: `media\textures\WorldItems\AppleRotten.png` under that installation (64×64 real item texture). It is suitable texture-pipeline evidence, not a faithful character sprite. Runtime version record reports Build 42.21.0/revision 4a0e9546ec; installed Steam build ID 25485521. Exact confidence/limits are recorded in COMPATIBILITY.

## Input and mods

Click/tap a destination or enter X/Y coordinates to move without holding a key. Direction buttons toggle walking; Stop/Escape cancels. Focus the canvas for WASD/arrows (manual takeover). Pause/hidden tab/blur cancels movement; resume never catches up elapsed offline time. Normal gameplay bindings/remapping will be added with M2.

Enable the bundled **Accessible walking** multifile JavaScript mod to change WASM speed from 1.5 to 2.25 world units/second. Disable restores speed and removes hooks. [Mod author guide and full delivered API](docs/modding/README.md). Executable mods are trusted page-context code, not a sandbox. Arbitrary local mod package import/manager, dependencies, saved mod data and future-system APIs are not implemented in this M1 preview.

## Release and hosting

After committing verified source: `./scripts/Windows.ps1 Release`. Creates an allowlisted asset-free application directory with version, source revision and SHA-256 file manifest under `release/`. No original assets, native binaries or saves are part of source/application releases. Converted packs/caches and personal files must remain outside source and releases. Application CI uses synthetic tests only and does not claim GPU proof.

Release requires a clean tracked and untracked source tree and creates a new version/revision directory; an existing destination is rejected, never merged or overwritten. Keep private inputs outside the checkout. `Check` runs `eslint . --max-warnings 0`, Rust formatting, clippy with warnings denied, native/WASM integration contracts and documentation links. Vendored lint rules are not disabled.

Deploy release application files to an HTTPS static host. WASM MIME: `application/wasm`; JavaScript: `text/javascript`. Localhost is a secure-context development exception; plain remote HTTP will not enable WebGPU. No COOP/COEP headers are required (no shared memory). Keep versioned releases together; do not mix old JavaScript with new WASM. Rollback means redeploying a complete prior directory. M1 has no persistent state to migrate. Production offline caching/content provisioning and manual content/save transfer are M4 requirements, not current features. Hosting application files alone supplies neither game assets nor saves.

## Troubleshooting

- `WebGPU unavailable`/adapter failure: use HTTPS or localhost and an eligible GPU/browser; backend never silently falls back. Browser implementation support does not certify a device; see matrix.
- Device loss: simulation stops and an accessible error appears; reload and reimport. Recovery does not restore an unsaved session.
- `cargo`/linker missing: install rustup and MSVC prerequisites, then run Setup. The Rust target/toolchain is pinned in `rust-toolchain.toml`.
- `npm ci` errors: use exact Node/npm versions and vendored archives. ESLint 9.39.4 is pinned to vendor peer baseline; npm reports it deprecated. Upgrade as a coherent lint/toolchain change, not an unrecorded install.
- Remote repository operation blocked: app-scoped credentials must have access to the private target repository. Local commits retain verified bot attribution; no personal fallback.

## Project record

- [STATUS: verified capabilities, evidence, blockers and next command](docs/STATUS.md)
- [ROADMAP: destination and ordered acceptance criteria](docs/ROADMAP.md)
- [DECISIONS: responsibilities, versioned ABI and architecture rationale](docs/DECISIONS.md)
- [COMPATIBILITY: build-specific fidelity, asset and platform gaps](docs/COMPATIBILITY.md)
- [Modding guide/API](docs/modding/README.md)

Reproducibility: dependency/toolchain versions and lockfiles pinned; native toolchain, Windows runner image and GPU/browser implementation vary. No claim of byte-identical builds or mobile support without measured device evidence.
