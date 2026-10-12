# Project status

## Current increment

M1 integrated architecture proof in progress. New repository checkout previously contained only vendor lint archives and local .omp configuration; no existing source/status or Git history. Full port remains incomplete. No native streaming/client-control implementation.

## Grounded observations

- Windows x64; Node v26.10.0, npm 11.19.1, Rust/cargo 1.96.0, Git 2.54.0.windows.1.
- wasm32-unknown-unknown target installed successfully.
- Installation path readable; original launcher/JAR, JRE and native libraries present. REA PE inventory and SHA-256 recorded in COMPATIBILITY.md.
- PowerShell process inspection returned no ProjectZomboid*/java* processes before prototype verification. Repeat at actual standalone acceptance; this initial result is not final acceptance evidence.
- Both intended vendor packages verified from actual package.json/exports: @notmike101/eslint-config-js 4.0.5 and @notmike101/eslint-config-jsdoc 1.0.1, ES-module flat configs. npm installed 256 pinned dependency packages successfully; deprecated ESLint 9.39.4 warning recorded.
- GitHub public bot metadata ID 337478082 matches installed helper and noreply attribution. Local repository initialized on milestone/m1 with bot name/email. Initial scoped app-token request returned 422 because the target did not exist. After explicit user authorization, personal credentials created the private repository; agent-app authentication (including workflow permission) then succeeded. Source commits/pushes use the agent identity.
- Browser automation opened Chromium 154.0.0.0. Secure-context preflight on the WebGPU specification page returned navigator.gpu and a nonfallback NVIDIA/ampere adapter. Host inventory reports RTX 3080/driver 32.0.16.1714. This proves adapter availability, **not yet prototype rendering**.
- Read-only source records report Build 42.21.0/revision 4a0e9546ec and Steam build ID 25485521; inspected actual 64×64 AppleRotten.png gameplay texture. Confidence limits/inventory in COMPATIBILITY.md.
- Original bundled Java runtime metadata: Azul Zulu25.30+17-CA, Java25.0.1+8-LTS, Windows x86_64. Development dependency evidence only; browser application does not use it.
- Android SDK client discovered outside server PATH: adb1.0.41/platform-tools37.0.0. `adb devices -l` returned an empty attached-device list; the newly started discovery daemon was stopped afterward. Physical Android testing is unavailable in this session; no iOS target supplied.

## Checkpoints and observed experiments

- Pushed `6f3690984a3033527346090b1c51e64be2312a0e` — `docs: record grounded M1 architecture and discovery`; GitHub commit metadata links both author and committer to agent-notmike101[bot].
- Pushed `8a5157e` — `build: pin vendored lint tooling and enforce zero warnings`. Installed config import smoke returned six JS flat configs and three JSDoc configs. Completed lint-config slice passed zero-warning ESLint.
- Completed main/renderer/delivery-script slices passed targeted zero-warning ESLint before review fixes; **not yet a full-tree pass or browser acceptance**.
- Initial Windows Setup failed because this Node manager provides npm.exe, not npm.cmd. Get-Command inspection established the root cause. Resolver now accepts either installed Windows executable; rerun Setup passed, installed pinned Rust components and 256 locked packages. No machine-specific executable path baked into the script.
- Privacy regression reproduced with independently authored text only: Windows junction `dist/privacy-probe` → `.local/privacy-probe` let the old static server return `SYNTHETIC_PRIVACY_PROBE_ONLY` from outside dist. Original installation/assets were not used. Realpath containment and explicit source-file packaging fixes are underway; verify denial before claiming fixed.
- Live NVIDIA WebGPU probe reproduced image-copy validation failure for TEXTURE_BINDING|COPY_DST without RENDER_ATTACHMENT: `Destination texture needs to have CopyDst and RenderAttachment usage.` Correct usage and destination-owned premultipliedAlpha are being applied; no real-content rendering success yet.
- Source review found mod-submitted actions bypassed beforeAction hooks. Shared action routing/reentrancy guard requested; old factory retained in the evaluation runtime for compiled-WASM failing-before proof.
- Numeric-boundary investigation demonstrated F32 rounding: 10.0000001 →10 and dt0.1000000001 →0.10000000149. Rust F64 intake validation and scaled direction normalization requested before first integrated build.

## Implemented work awaiting integration verification

Architecture/ABI responsibilities and scoped execution plan in DECISIONS/ROADMAP. Source work underway for Rust simulation, renderer and mod contracts. Main host, accessible UI, pinned package lock, static server, Windows setup/build/check commands, CI/release allowlist are being integrated. No pass claims until built browser execution and checks.

## Blockers and outstanding acceptance

- Remote access resolved: `https://github.com/notmike101/project-zomboid-web-port` exists and `isPrivate:true` verified; agent-app access confirmed. First checkpoint push and final implementation push tracked below as they occur.
- Physical mobile/second device: no named connected target; actual mobile performance/touch/memory/background proof unverified. Emulation will not count as physical acceptance.
- Deployment: destination unspecified; prepare asset-free release rather than publish to a guessed destination.
- Full gameplay/assets/saves/mod management/portability remain pending M2–M5, visible in COMPATIBILITY/ROADMAP.
- Backup policy: Conventional Commits 1.0.0; push coherent checkpoints frequently. Commit attribution remains agent-notmike101[bot] for both author and committer, independent of repository-creation credentials.

## Next runnable step

Once owned source slices return: `cargo generate-lockfile --manifest-path engine/Cargo.toml`; `npm run build`; `npm run check`; `npm start`. Open localhost in WebGPU browser, import inspected real gameplay PNG, exercise destination/toggle/manual cancellation and mod speed, record detached diagnostics and actual GPU adapter. Keep native game closed. Then update this record with measured results and commit attribution/revision.
