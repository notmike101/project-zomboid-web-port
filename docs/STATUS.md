# Project status

## Current increment

Full-game continuation is active. M1 architecture proof remains verified and backed up, but is not the completion goal. The next playable slice adds real imported tiles/character content, WASM collision/navigation/interaction, save restoration and local mod management; full gameplay, portability and fidelity requirements remain open. No native streaming/client-control implementation.

## Grounded observations

- Windows x64; Node v26.10.0, npm 11.19.1, Rust/cargo 1.96.0, Git 2.54.0.windows.1.
- wasm32-unknown-unknown target installed successfully.
- Installation path readable; original launcher/JAR, JRE and native libraries present. REA PE inventory and SHA-256 recorded in COMPATIBILITY.md.
- PowerShell process inspection returned no ProjectZomboid*/java* processes immediately before the integrated browser acceptance. The original game was not launched.
- Both intended vendor packages verified from actual package.json/exports: @notmike101/eslint-config-js 4.0.5 and @notmike101/eslint-config-jsdoc 1.0.1, ES-module flat configs. npm installed 256 pinned dependency packages successfully; deprecated ESLint 9.39.4 warning recorded.
- GitHub public bot metadata ID 337478082 matches installed helper and noreply attribution. Local repository initialized on milestone/m1 with bot name/email. Initial scoped app-token request returned 422 because the target did not exist. After explicit user authorization, personal credentials created the private repository; agent-app authentication (including workflow permission) then succeeded. Source commits/pushes use the agent identity.
- Chromium 154.0.0.0 executed the built application with real WASM and a nonfallback NVIDIA/ampere WebGPU adapter, bgra8unorm canvas. Host inventory separately reports RTX 3080/driver 32.0.16.1714; masked browser metadata does not identify the exact card.
- Read-only source records report Build 42.21.0/revision 4a0e9546ec and Steam build ID 25485521; inspected actual 64×64 AppleRotten.png gameplay texture. Confidence limits/inventory in COMPATIBILITY.md.
- Original bundled Java runtime metadata: Azul Zulu25.30+17-CA, Java25.0.1+8-LTS, Windows x86_64. Development dependency evidence only; browser application does not use it.
- Android SDK client discovered outside server PATH: adb1.0.41/platform-tools37.0.0. `adb devices -l` returned an empty attached-device list; the newly started discovery daemon was stopped afterward. Physical Android testing is unavailable in this session; no iOS target supplied.

## Checkpoints and observed experiments

- Pushed `6f3690984a3033527346090b1c51e64be2312a0e` — `docs: record grounded M1 architecture and discovery`; GitHub commit metadata links both author and committer to agent-notmike101[bot].
- Pushed `8a5157e` — `build: pin vendored lint tooling and enforce zero warnings`. Installed config import smoke returned six JS flat configs and three JSDoc configs. Completed lint-config slice passed zero-warning ESLint.
- Pushed `72e238bc2b961b78bf34ee83565198c4c8751941` — `feat(port): deliver verified standalone WASM and mod proof`; GitHub API confirms both author and committer are agent-notmike101[bot], repository remains private.
- Final `scripts/Windows.ps1 Check` passed after review corrections: asset-free browser build; `eslint . --max-warnings 0` with zero errors/warnings; Rust formatting; clippy with warnings denied; 15 native Rust tests; 52 Node tests instantiating compiled WASM and exercising delivery/mod contracts; relative links in six maintained documents.
- Initial Windows Setup failed because this Node manager provides npm.exe, not npm.cmd. Get-Command inspection established the root cause. Resolver now accepts either installed Windows executable; rerun Setup passed, installed pinned Rust components and 256 locked packages. No machine-specific executable path baked into the script.
- Privacy regression reproduced with independently authored text only: a junction out of dist let the old server disclose `SYNTHETIC_PRIVACY_PROBE_ONLY`. After realpath containment, the same request returned 404. Source staging uses an explicit application-file allowlist and rejects selected links/ancestor escapes; isolated delivery regressions pass. Probe files were removed; original assets were never used.
- Live NVIDIA WebGPU probe reproduced image-copy validation failure for TEXTURE_BINDING|COPY_DST without RENDER_ATTACHMENT: `Destination texture needs to have CopyDst and RenderAttachment usage.` Fixed required usage and destination-owned premultipliedAlpha. GPU readback of a synthetic half-transparent red pixel confirmed the old source option produced [255,0,0,128] versus the correct destination option [128,0,0,128].
- Mod-submitted actions initially bypassed beforeAction hooks. A fresh Node process exercising the compiled WASM demonstrated the fixed shared path: a host veto cancelled a mod submission, leaving x=5/action=0. Node regressions cover signed directions, vetoes, reentrancy, unload and cleanup.
- Numeric intake now validates F64 before F32 state conversion; scaled normalization accepts extreme finite headings. A compiled failing-before/passing-after probe confirmed tiny nonzero headings no longer acquire an accidental deadzone.
- Pushed `fae72c7` — `feat(render)` real-content renderer proof. [Isolated renderer evidence](evidence/render-smoke.json) uses a static position, not simulation. Subsequent integrated proof is recorded below.

## Integrated browser acceptance

- Imported original AppleRotten.png through the actual application file input: 64×64, 5931 source bytes, 16384 estimated RGBA8 GPU texture bytes. Real imported pixels rendered; screenshots remain temporary, never tracked.
- Native-game process count was zero. Base toggle movement measured 1.500005722 units/s over 49 simulation ticks; bundled multifile ES module measured 2.249994278 units/s over 58 ticks. Stop prevented later displacement; disabling the mod restored speed 1.5 and removed its registrations.
- Coordinate travel, exact arrival at (6,5), Escape cancellation, keyboard takeover and key release executed through the built UI. Pause held tick/position fixed while GPU frames continued; no catch-up simulation.
- Touchscreen emulation at 390×844 started a destination action and resized the GPU canvas from 1248×551 to 427×470; emulation is not physical-mobile acceptance.
- Real device.destroy() exposed a stale fatal HUD; fixed report now cancels, refreshes diagnostics and displays stopped. Browser confirmation: action=0, failed=true, renderer stopped=true, visible device-loss/reload instruction.
- Invalid PNG followed by the real valid PNG exposed obsolete recoverable feedback; browser confirmation after the fix: alert hidden, text empty, real asset metadata visible.
- Final static delivery review found no actionable high/medium defects. Core findings fixed: withdrawn hooks are skipped, rejected async lifecycle values are observed/attributed, throwing then getters stay inside the hook boundary, vetoed directions preserve the active toggle, and pending mod-import failure cannot replace a fatal backend message. Five new compiled-WASM regressions pass; built-browser veto and loss/import-race checks pass.
- Further built-browser checks: resize from 390×844 to 900×700 changed the GPU canvas from 326×376 to 453×381; after-startup offline movement/Stop continued locally. This is not cold-start offline provisioning. A null adapter produced an explicit stopped error, not fallback; semantic controls/status/alert and keyboard-visible focus were observed, not a screen-reader session. [Integrated metadata evidence](evidence/m1-acceptance.json).
- Release guards exercised: independently authored unexpected `.txt` content and dirty source were rejected; probe removed. Clean `Windows.ps1 Release` prepared 10 application files plus manifest at `release/0.1.0-preview.1-72e238bc2b96`; each byte count and SHA-256 verified against packaged bytes. Repeated release rejected EEXIST without overwrite. No original content is packaged.
- Actual [Windows CI run 38256463874](https://github.com/notmike101/project-zomboid-web-port/actions/runs/38256463874) completed successfully: pinned setup, build/check, identified release and artifact upload. CI supplies synthetic contract/delivery proof, not GPU or physical-device proof.
- Scoped final re-review found no remaining actionable defects in the five corrected callback/UI boundaries; no execution was delegated to reviewers.
- Continuing correctness check reproduced a held-W → vetoed pointer destination → release-W defect: WASM remained walking because input ownership had been cleared before commit. Shared non-keyboard takeover now clears held keys/assistance only after commitment. Actual compiled-WASM browser checks pass for pointer, coordinate form and direction-button vetoes; release stops in all three. [Failing-before/passing-after metadata](evidence/input-veto-release.json).
- Runnable browser regression: import `checkHeldVeto` from `scripts/check-browser-input.mjs` in the development browser runner and call `tab.run(checkHeldVeto, { args: [mode] })` for `pointer`, `form`, and `toggle`. It operates the built UI with an independently authored public-API veto mod; no private state exposure or proprietary bytes.

## Blockers and outstanding acceptance

- Remote access resolved: private repository and app-authenticated source push verified. Latest source release provenance is `72e238bc2b961b78bf34ee83565198c4c8751941`; subsequent handoff-documentation checkpoints do not change the implementation.
- Physical mobile/second device: no named connected target; actual mobile performance/touch/memory/background proof unverified. Emulation will not count as physical acceptance.
- Deployment: destination unspecified; prepare asset-free release rather than publish to a guessed destination.
- Full gameplay/assets/saves/mod management/portability remain pending M2–M5, visible in COMPATIBILITY/ROADMAP.
- Backup policy: Conventional Commits 1.0.0; push coherent checkpoints frequently. Commit attribution remains agent-notmike101[bot] for both author and committer, independent of repository-creation credentials.

## Next runnable step

Run `.\scripts\Windows.ps1 Run`, open localhost in a WebGPU-capable browser, and import a PNG from your own installation to exercise the delivered proof. Next implementation experiment: bounded inspection of `media/texturepacks/Tiles2x.pack` headers/page/subtexture metadata, followed by an in-browser atlas decode. Preserve original inputs; no whole-bank read or native converter. M2 also requires real tile collision/character/interaction, browser save transfer and local mod management before gameplay claims.
