# Compatibility and fidelity record

This record keeps the full recreation target intact. **M1 prototype has no claim of native gameplay parity.** Observed installed content is evidence of shipped formats/definitions, not independently runnable engine source. Details and latest execution proof belong in STATUS.md.

## Build identity and evidence

Development input: user-owned installation at configurable `C:\Games\steam\steamapps\common\ProjectZomboid`. Read-only inspection; no installation/saves modified. Runtime-written `C:\Users\me\Zomboid\version.txt` reports **42.21.0**, revision **4a0e9546ec**, pzbullet **1.0.0.28**. Steam `appmanifest_108600.acf` reports app 108600, installed build **25485521**, depot 108604 manifest **7544133343391543313**, 10335862594 installed bytes. These are observed records, not newly executed version reporting; a stale user version record remains possible until JAR metadata/bytecode corroboration. Do not assume all Build 42 revisions share formats.

REA `inspect_pe_resources` observed the x64 PE launcher (990720 bytes), SHA-256 `32cca5b5e9e4ac5dcfda34e8aa95bed1f721fa72b13fb8793c5e22eff6197b24`, Evidence `ev_d538ab97ccfe8fc6dd72c9d9ab36d1a1612a86514f78055536996612d39d0bdc`. Complete static resource tree, no version resource. This identifies the installed launcher but **does not establish game patch version or gameplay execution**. Java game logic is shipped in `projectzomboid.jar`; native DLLs include pathfinding/population/physics/lighting/FMOD/JNI bridges. Browser port does not load these.

## Capability/fidelity destination

| System | M1 coverage | Native fidelity / outstanding acceptance |
|---|---|---|
| World/regions/tile maps | Synthetic bounded [0,10] plane | Original map loading, chunks, tile rules, objects, multilevel space absent |
| Movement/actions/navigation | WASM coordinates, direction/destination, cancel, speed, bounds | Original pathfinding, collisions, timed-action queues and rules absent; speed is approximation, not native measurement |
| Accessibility | HTML toggle directions, destination coordinates, Stop/Escape, keyboard canvas and touch pointer path | Remappable bindings, menu/AT checks and sustained/repeated-action alternatives across systems pending |
| Character/traits/skills/professions | Position/action marker only | Original meshes, animations, appearance and character rules absent |
| Items/equipment/loot/containers | Can display imported PNG art | Item definitions/behavior, containers, loot and interaction absent |
| Zombies/perception/AI | None | Native perception, decisions/population/pathing behavior pending |
| Combat/health/needs/effects | None | Damage, injury, treatment, nutrition, sleep, effects pending |
| Crafting/building/dismantling | None | Recipes, requirements, tools and processing pending |
| Time/weather/lighting/effects | Fixed simulation ticks only | Native time/weather/environment/lighting and effects pending |
| Audio | None | Decoding/event mapping/positional audio and gesture startup pending |
| Vehicles/utilities/additional systems | None | Inventory original systems from build-specific scripts/classes before claims; no omission lowers destination |
| Saves/storage | None | Versioned browser schema, migration, atomic/recoverable writes, quotas/eviction, autosave, export/restore and mod data pending |
| Mods | Experimental movement/actions API and trusted multifile bundled module | Local import/manager, deterministic dependencies, registries, settings/data/migrations, all corresponding gameplay-system APIs pending |
| Remote/offline use | Static app + selected local PNG, independent browser simulation | Portable content/save provision and offline cache pending; application hosting does not provide content |

## Asset-format coverage

| Content | Browser path | Status/limitation |
|---|---|---|
| Standalone PNG gameplay art | File → bounded header validation → createImageBitmap → GPUTexture | M1; local memory only, one marker resource |
| Texture/sprite `.pack` | Requires bounded browser parser/atlas metadata | Not implemented; target next format experiment |
| Item/script definitions | Text parsers and engine-equivalent rules | Definitions are reference evidence, not runnable standalone Java/Lua engine |
| Meshes/models/animations | Browser-compatible decoding and skeleton/animation integration | Not implemented; inspect exact source formats before loader selection |
| Sounds/banks | Browser decoding where compatible, bank/event reference mapping | Not implemented; native FMOD is not browser runtime |
| Map/world/tile definitions | Bounded browser chunk/tile parsers | Not implemented; no map parity |
| Native saves | Separate compatibility project | Not supported; first browser saves remain distinct/versioned |

All proprietary inputs/caches/packs remain outside tracked source and application release artifacts. Portable private packs and user-chosen transfer remain required, not a mandatory native converter.

### Narrow installed-content inventory (static observations)

- M1 PNG: `media/textures/WorldItems/AppleRotten.png`, observed 64×64 texture image (not an animated sprite). Other loose PNG examples: `media/inventory/RifleClip.png` (361 bytes), `BerettaClip.png` (420 bytes). Inspect actual semantics before using textures as character art.
- Atlas packs: `media/texturepacks/Tiles2x.pack` (~306.2 MB), `JumboTreesBigs2x.pack` (~78.8 MB), `UI2.pack` (~52.1 MB). Custom binary containers, not simply standard PNG files. Next experiment: bounded header/page/subtexture inspection and browser atlas decode; do not read the whole bank into memory.
- Tiles: `media/newtiledefinitions.tiles` (~2.8 MB), `.tiles.txt` (~6.5 MB), `tileGeometry.txt` (~6.1 MB); text sidecars are references, not proof of collision equivalence.
- Models/animation: `media/models_X` FBX/.X and `media/models/*.txt`; `anims_X`, `animsold/*.txt`, `AnimSets/*.xml`, `actiongroups/player`, `animscript/combat.xml`. Native jassimp presence does not prove every FBX import shape.
- Audio: loose `media/sound/zombiehit5.wav` (~45.8 KB), `windowopen.ogg` (~35 KB), FMOD banks under `sound/banks`, music OGG. Loose browser decode plausible but unexecuted; FMOD bank handling remains unknown.
- World: sampled `media/maps` town folders contain `map.info`, `thumb.png`, `spawnpoints.lua`; `.pzby` lot templates under `binmap`/`basement_access`. Main map chunk layout not established by this narrow search.
- Presentation references: GLSL `media/shaders/*.vert/*.frag` (~169 files). WGSL translation must be behavior-verified rather than assuming shader equivalence.

File sizes rounded where inventory reported rounded values; these are format discovery facts, not memory-performance measurements. Original Java movement/animation engine behavior remains unobserved.

## Browser/device matrix

[Chrome platform overview](https://developer.chrome.com/docs/web-platform/webgpu/overview) documents Windows D3D12-capable Chrome 113+, Android 12+ Chrome 121+ on eligible Qualcomm/ARM GPUs, Firefox 141 Windows, Safari 26. [W3C WebGPU specification](https://gpuweb.github.io/gpuweb/) defines resources/lifecycle. These are implementation baselines, **not this application's verified support matrix**.

| Target | Eligibility | Project validation |
|---|---|---|
| Windows Chromium 154 | HTTPS/localhost + adapter | Browser execution pending recorded M1 evidence |
| Other Windows Chrome/Edge, Firefox | GPU/driver/browser capability dependent | Unverified |
| macOS Safari 26 / Chrome | WebGPU-capable device | Unverified |
| Android Chrome, physical device | Android 12+, eligible GPU + secure context | No physical target supplied; unverified release requirement |
| iOS/iPadOS Safari 26, physical device | Eligible WebGPU device + secure context | No physical target supplied; unverified release requirement |
| Software/headless/emulated browser | Actual adapter must be recorded | Contract/render proof only; never mobile/hardware-performance claim |

M1 controls target ≥48 px, responsive layout, canvas DPR capped, pointer input unified. Orientation/pixel-density emulation does not prove physical touch, mobile memory/thermals, background suspension or assistive technology. Device loss stops simulation with visible error; reload/reimport needed. No silent WebGL fallback. UI scale uses rem/browser zoom; further accessibility checks remain acceptance work.

## Resource and timing limits

Input PNG ≤16 MiB, dimensions ≤4096 each, decoded RGBA ≤64 MiB, also bounded by adapter limits. Fixed 60 Hz simulation, at most 100 ms frame catch-up; hidden/pause cancels movement and drops backlog. No shared-memory threads/COOP/COEP requirement. File import/copy decoding is asynchronous; one image only.

These are guardrails, not measured device performance budgets. Record actual frame times, source/decoded memory, import duration and latency before establishing budgets. Audio and storage budgets cannot be claimed for absent systems.
