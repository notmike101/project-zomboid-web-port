# Roadmap and implementation plan

> For agentic workers: use subagent-driven-development; preserve the complete product brief as the destination. This file is the authoritative plan; avoid duplicate plans/status files.

**Goal:** complete the standalone browser recreation against the full engineering brief: recognizable gameplay and presentation, substantial WASM simulation, genuine WebGPU, functional animation/effects/audio, persistent saves, accessible desktop/mobile use, comprehensive documented JavaScript mods, portable content/save transfer and asset-free reproducible delivery. Milestones are verification and backup checkpoints, not stopping conditions.
**Architecture:** dependency-free Rust C ABI, direct browser WebGPU, accessible HTML host, externally provisioned content directory autoloaded from `/content/manifest.json`, trusted JavaScript ES-module mods and unchanged native Lua through the existing package manager/real browser Lua WASM.
**Tech stack:** Rust 1.96.0; Node 26.10.0/npm 11.19.1; vendored JavaScript/JSDoc ESLint configs.
**Spec:** DECISIONS.md integration contract and user's engineering brief.

## Global constraints

No original binaries/assets, converted caches, content packs or saves tracked or released. Content is copied/provisioned externally and privately served at `/content/` with bounded HTTP Range support; no web asset picker or import, no mandatory native runtime companion. Portable content transfer means transferring this directory or private hosting; browser save-backup JSON retains import/export. Real browser WebGPU only; hardware vs software evidence distinguished. One authoritative WASM simulation. JS mod authors require no compilation. Preserve original installation and saves. Public APIs documented at delivered scope only. Failed remote authentication never falls back to personal identity.

## Ordered milestones

| Milestone | Acceptance | Dependencies | Status |
|---|---|---|---|
| M0 Grounded setup | Verified environment, exact build evidence, assets classified, lint configs, bot attribution, reproducible commands | Local installation/toolchains, GitHub access | Verified; private remote and bot pushes established |
| M1 Architecture proof | Real-content WebGPU rendering, WASM movement/cancel, browser input, mod changes actual WASM rule, standalone evidence | M0 local discovery; WebGPU browser | Verified prototype; source pushed, asset-free release audited, Windows CI passed |
| M2 First accessibility slice | Directory-manifest autoload, real tile environment, collision, character, door/pickup, accessible UI, browser save/export/import/reload, provisioned local mod management | M1 | Directory/game-only boot, original tiles/skinning, navigation, retained-save lifecycle and local packages verified; door/pickup and complete backup-transfer acceptance remain |
| M3 Gameplay expansion | Coherent increments: items/equipment, zombies/perception/AI, combat, health/needs, crafting/building, world loading, animation, audio, lighting/effects; public extension points per system | M2 and build-specific behavior evidence | Pending |
| M4 Portability/resilience | Portable content-directory/private-host and save-backup transfer, physical mobile and second-device proof, quotas/recovery, mod migrations, GPU loss and measured performance budgets | M2/M3, physical devices | Pending |
| M5 Release/handoff | Pinned Windows CI, asset-free versioned release, static hosting/update/rollback docs, exact capability matrix; incomplete releases labelled previews | M4 and remaining fidelity inventory | Pending |

Full-port completion remains all required systems and fidelity gaps in COMPATIBILITY.md, not completion of M1 or a generic zombie demo.

Completion remains blocked until every required system, delivered mod extension, fidelity obligation and supported-device acceptance gate is implemented and exercised. Missing physical devices do not excuse leaving independent implementation unfinished; their evidence gap remains explicit.

### Existing native-game mod compatibility

Existing Project Zomboid Lua mod compatibility is an additional completion requirement, not replaced by the browser JavaScript SDK. Implement native package discovery from externally provisioned directories, a real Lua runtime, supported original engine objects/events and data registrations, namespaced saves, lifecycle cleanup and attributed incompatibility diagnostics. Verify representative existing mods without rewriting their Lua source. Lua language compatibility and native Java/engine API coverage are separate gates; unsupported native dependencies must fail explicitly, never become silent no-ops. A Lua 5.4 Wasmoon runtime and Lua 5.1 compatibility preamble are work in progress, not Kahlua equivalence or completed original-mod support. Compatibility coverage grows with the corresponding WASM gameplay systems.

### Current integrated checkpoint

- [x] Original PZPK/legacy sprite-bank indexing, lazy PNG ranges and bounded WebGPU trimmed-sprite residency, observed with Tutorial geometry; nine unresolved vegetation names remain fidelity gaps, not guessed replacements.
- [x] Original ASCII X model/bone/idle/walk loading and WebGPU skinning route; native character scale/facing and worn-appearance composition remain uncalibrated.
- [x] Existing local package manager integration, revisioned multifile modules and JavaScript namespace initialization/migration through Save/Load/reboot/New.
- [x] Disabled-by-default native Lua loader/lifecycle integration with owned real-VM/browser regressions, retained committed-VM rollback and serialized consent; not representative Workshop gameplay acceptance.
- [x] Bot-authored source checkpoint `ae37f0b17641e7eafc7983d84a000fb53c737bb0`, [pinned Windows CI](https://github.com/notmike101/project-zomboid-web-port/actions/runs/38333092993) and actual asset-free release with both interpreter licenses and byte hashes.
- [ ] Next: WASM-authoritative original item definitions and inventory/equipment/condition, public registration/action APIs and deterministic v1 save migration; original Lua UI/texture rendering for the representative footwear moodle.
- [ ] Complete remaining M2 door/pickup and backup-transfer acceptance, then every M3–M5 system and device gate without lowering the destination.




## Historical M1 execution slices

These completed slices record the original picker-based prototype proof, not current user instructions. M2 replaces asset selection with external directory provisioning and automatic manifest/resource loading; that path needs its own browser evidence.

### 1. WASM authoritative movement
Files: engine/Cargo.toml, engine/src/lib.rs, src/engine.js, tests/engine.test.js, rust-toolchain.toml. Implement exports and wrapper exactly as DECISIONS.md. Assertions: destination reaches exactly; cancel prevents subsequent movement; diagonal direction normalized; edge stops; NaN/range invalid does not mutate; speed changes distance after same ticks. Command: `cargo test --manifest-path engine/Cargo.toml`; `npm run build`; `node --test tests/engine.test.js`. Native tests alone do not establish browser execution.
- [x] Implement and exercise state transitions and validation.

### 2. Historical imported-content WebGPU path
Files: src/renderer.js only. M1 used a File PNG bounded by size and dimensions; uploaded the texture and drew real art at WASM coordinates with alpha blending, resize and device-loss notification/cleanup. Browser file selection with an actual game image, screenshot and runtime diagnostics established the historical proof. No proprietary pixels in tracked evidence. Current acceptance uses directory autoload, not file selection.
- [x] Implement and observe real texture/pipeline submission.

### 3. Public mod contracts
Files: src/mods.js, mods/accessible-walking/main.js, mods/accessible-walking/settings.js, tests/mods.test.js, docs/modding/*.md, types/mod-api.d.ts. Tests: speed change really alters WASM displacement; priority/cancel prevents movement commit; cleanup removes effects; invalid async hooks are attributed; duplicate manifest ID rejected. Document every delivered API, timing/errors/trust/cleanup and intentionally absent package-manager features.
- [x] Implement and execute example through public API.

### 4. Browser integration and asset-free delivery
Files: index.html, src/main.js, src/style.css, scripts/*.mjs, scripts/*.ps1, package.json/package-lock.json, eslint.config.js, .gitignore, README.md, docs/{STATUS,COMPATIBILITY,DECISIONS,ROADMAP}.ms. Historical M1 scope: fixed ticks with capped backlog; pause/background cancel; imported image selection; destination/toggle/manual movement and Stop; mod checkbox/reload-safe activation; readable position/action/backend diagnostics. Build copied only allowlisted source and WASM, served correct MIME locally and packaged release with revision. Browser checks covered real movement, cancel, mod displacement, pause, keyboard/touch emulation, loss/resize; physical mobile remained explicitly unverified. Integration checks were lint, tests, Rust formatting, Windows build script and packaging content audit, followed by source review and bot-attributed coherent commit. These are historical M1 requirements/results, not fresh directory-boot proof.
- [x] Integrate and verify full M1 prototype acceptance; physical-mobile and native-fidelity gaps remain M2–M5.

## Historical M1 shared-interface preflight

| Pair/task | Produced/consumed interface | Finding |
|---|---|---|
| 1 ↔ 2 | snapshot x/y/action feeds render(snapshot) | Both use [0,10], no pointer exposure |
| 1 ↔ 3 | engine commands and setSpeed | WASM validates final mutation; mod host validates callbacks |
| 2 ↔ 4 | renderer metadata/diagnostics and worldFromCanvas | Error callback stops simulation; no fallback |
| 3 ↔ 4 | load/dispose/command and diagnostics | Host routes all input through mod actions |
| 1 | tests vs exports | Same initial state, dt and speed constraints |
| 2 | real imagery vs presentation | Icon art disclosed as proof, not faithful character |
| 3 | hooks vs lifecycle | Synchronous precommit; no claimed sandbox |
| 4 | packaging vs assets | Source allowlist only; imported File bytes never copied |

Ruling: work in the supplied fresh checkout on a milestone branch rather than create a second empty worktree — no existing tracked work to isolate. Ruling: user explicitly authorized routine engineering decisions and immediate implementation, so no additional design approval gate. Cost if wrong: local reversible architecture rework. Review/checks consolidated after independent edit slices per tool policy.
