# Roadmap and M1 implementation plan

> For agentic workers: use subagent-driven-development; preserve the complete product brief as the destination. This file is the authoritative plan; avoid duplicate plans/status files.

**Goal:** prove real imported content → WebGPU canvas, WASM-owned actions, browser input/cancellation and executable JavaScript gameplay modification with native game closed.
**Architecture:** dependency-free Rust C ABI, direct browser WebGPU, accessible HTML host, trusted JavaScript ES-module mods.
**Tech stack:** Rust 1.96.0; Node 26.10.0/npm 11.19.1; vendored JavaScript/JSDoc ESLint configs.
**Spec:** DECISIONS.md integration contract and user's engineering brief.

## Global constraints

No original binaries/assets, converted caches, content packs or saves tracked or released. No native runtime companion. Real browser WebGPU only; hardware vs software evidence distinguished. One authoritative WASM simulation. JS mod authors require no compilation. Preserve original installation and saves. Public APIs documented at delivered scope only. Failed remote authentication never falls back to personal identity.

## Ordered milestones

| Milestone | Acceptance | Dependencies | Status |
|---|---|---|---|
| M0 Grounded setup | Verified environment, exact build evidence, assets classified, lint configs, bot attribution, reproducible commands | Local installation/toolchains, GitHub access | Verified; private remote and bot pushes established |
| M1 Architecture proof | Real-content WebGPU rendering, WASM movement/cancel, browser input, mod changes actual WASM rule, standalone evidence | M0 local discovery; WebGPU browser | Verified prototype; final source/release checkpoint in progress |
| M2 First accessibility slice | Real tile environment, collision, character, door/pickup, accessible UI, browser save/export/import/reload, basic local mod management | M1 | Pending |
| M3 Gameplay expansion | Coherent increments: items/equipment, zombies/perception/AI, combat, health/needs, crafting/building, world loading, animation, audio, lighting/effects; public extension points per system | M2 and build-specific behavior evidence | Pending |
| M4 Portability/resilience | Portable content/save transfer, physical mobile and second-device proof, quotas/recovery, mod migrations, GPU loss and measured performance budgets | M2/M3, physical devices | Pending |
| M5 Release/handoff | Pinned Windows CI, asset-free versioned release, static hosting/update/rollback docs, exact capability matrix; incomplete releases labelled previews | M4 and remaining fidelity inventory | Pending |

Full-port completion remains all required systems and fidelity gaps in COMPATIBILITY.md, not completion of M1 or a generic zombie demo.

## M1 execution slices

### 1. WASM authoritative movement
Files: engine/Cargo.toml, engine/src/lib.rs, src/engine.js, tests/engine.test.js, rust-toolchain.toml. Implement exports and wrapper exactly as DECISIONS.md. Assertions: destination reaches exactly; cancel prevents subsequent movement; diagonal direction normalized; edge stops; NaN/range invalid does not mutate; speed changes distance after same ticks. Command: `cargo test --manifest-path engine/Cargo.toml`; `npm run build`; `node --test tests/engine.test.js`. Native tests alone do not establish browser execution.
- [x] Implement and exercise state transitions and validation.

### 2. Imported-content WebGPU path
Files: src/renderer.js only. Import File PNG bounded by size and dimensions; upload texture, draw real art at WASM coordinates with alpha blending; resize and device-loss notification/cleanup. Record adapter/frame/asset metadata. Exercise through browser file selection using actual game image, screenshot and runtime diagnostics. No proprietary pixels in tracked evidence.
- [x] Implement and observe real texture/pipeline submission.

### 3. Public mod contracts
Files: src/mods.js, mods/accessible-walking/main.js, mods/accessible-walking/settings.js, tests/mods.test.js, docs/modding/*.md, types/mod-api.d.ts. Tests: speed change really alters WASM displacement; priority/cancel prevents movement commit; cleanup removes effects; invalid async hooks are attributed; duplicate manifest ID rejected. Document every delivered API, timing/errors/trust/cleanup and intentionally absent package-manager features.
- [x] Implement and execute example through public API.

### 4. Browser integration and asset-free delivery
Files: index.html, src/main.js, src/style.css, scripts/*.mjs, scripts/*.ps1, package.json/package-lock.json, eslint.config.js, .gitignore, README.md, docs/{STATUS,COMPATIBILITY,DECISIONS,ROADMAP}.ms. Host fixed ticks with capped backlog; pause/background cancel; imported image selection; destination/toggle/manual movement and Stop; mod checkbox/reload-safe activation; readable position/action/backend diagnostics. Build copies only allowlisted source and WASM, serves correct MIME locally, packages release with revision. Browser checks real movement, cancel, mod displacement, pause, keyboard/touch emulation, loss/resize; physical mobile explicitly unverified if unavailable. Run lint, tests, Rust formatting, Windows build script, packaging content audit. Review source then bot-attributed coherent commit.
- [x] Integrate and verify full M1 prototype acceptance; physical-mobile and native-fidelity gaps remain M2–M5.

## Shared-interface preflight

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
