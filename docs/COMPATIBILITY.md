# Compatibility and fidelity record

This record keeps the full recreation target intact. **M1 prototype has no claim of native gameplay parity.** Observed installed content is evidence of shipped formats/definitions, not independently runnable engine source. Current assets come from an externally provisioned directory: the app autoloads `/content/manifest.json` and declared resources, with no web asset picker/import. Historical M1 file-selection proof is not fresh directory-boot evidence. Details and latest execution proof belong in STATUS.md.

## Build identity and evidence

Development input: user-owned installation at configurable `C:\Games\steam\steamapps\common\ProjectZomboid`. Read-only inspection; no installation/saves modified. Runtime-written `C:\Users\me\Zomboid\version.txt` reports **42.21.0**, revision **4a0e9546ec**, pzbullet **1.0.0.28**. Steam `appmanifest_108600.acf` reports app 108600, installed build **25485521**, depot 108604 manifest **7544133343391543313**, 10335862594 installed bytes. These are observed records, not newly executed version reporting; a stale user version record remains possible until JAR metadata/bytecode corroboration. Do not assume all Build 42 revisions share formats.

REA `inspect_pe_resources` observed the x64 PE launcher (990720 bytes), SHA-256 `32cca5b5e9e4ac5dcfda34e8aa95bed1f721fa72b13fb8793c5e22eff6197b24`, Evidence `ev_d538ab97ccfe8fc6dd72c9d9ab36d1a1612a86514f78055536996612d39d0bdc`. Complete static resource tree, no version resource. This identifies the installed launcher but **does not establish game patch version or gameplay execution**. Java game logic is shipped in `projectzomboid.jar`; native DLLs include pathfinding/population/physics/lighting/FMOD/JNI bridges. Browser port does not load these.

## Capability/fidelity destination

| System | Implemented coverage | Native fidelity / outstanding acceptance |
|---|---|---|
| World/regions/tile maps | WASM imported ground-floor navigation; native LOTH/LOTP catalogue/chunk parser; actual Tutorial geometry and original sprites rendered through browser WebGPU | Nine authored vegetation sprite names unresolved in startup banks; multilevel simulation, object rules and regions remain incomplete |
| Movement/actions/navigation | WASM direction/destination, edge collision/A*, native timed walk/door/grab/get-up queue with stable IDs/clocks/groups and original resident Lua callbacks; original grab/current+future-group restore/completion, veto/FIFO, genuine door approach/open/close/get-up, 20+ group timing, Escape STOP and closed-edge heading refusal exercised | Format-derived collision is not native behavioral parity; broader interaction fidelity, full original HUD and multilevel systems remain open |
| Accessibility | Edge-to-edge focused game canvas; keyboard/pointer movement, Space stop, hidden Escape pause menu and menu-only assisted walking/fractional destinations exercised | Remappable bindings, assistive-technology sessions and sustained/repeated-action alternatives across systems pending; no decorative debug UI |
| Character/traits/skills/professions | Actual ASCII X parsing and four-weight WebGPU skinning; original 617-vertex/916-triangle/28-bone MaleBody with Bob idle/walk and original body texture rendered from directory assets | Character scale uncalibrated; equipped clothing is not connected to skinned apparel rendering (avatar remains in underwear); appearance composition, traits, skills/professions and other character rules pending |
| Items/equipment/loot/containers | WASM-owned numeric definitions, owner-scoped activation rollback/freeze, stable never-reused u32 IDs, atomic import and ground/inventory/drop/wear/unequip/condition operations; acceptance-only queued pickup with genuine original completion and mixed-origin grouping; footwear/glove equip/save/reload and native awkward-glove query exercised | Bounded source footwear/hands subset only, not full inventory, containers or loot; ground/equipped models, instance visual/RNG variants, run-speed/tear dynamics and broader item behavior pending |
| Zombies/perception/AI | None | Native perception, decisions/population/pathing behavior pending |
| Combat/health/needs/effects | WASM scalar health and ordered original moodle rules over explicit inputs; hidden pain/CantSprint timers; 17 native mutable injury/skin-node records with source-ordered wound/treatment pain and six-arm cold action factor, shared SDK/live Lua access and integrity-covered portable body persistence | Scalar health/death remains port policy, not body-derived aggregate health; avatar remains standing. Body inputs/derived getters are not automatic combat, injury/healing/treatment/climate progression. Nutrition, sleep, effects and native survival acceptance remain open |
| Crafting/building/dismantling | None | Recipes, requirements, tools and processing pending |
| Time/weather/lighting/effects | Fixed simulation ticks only | Native time/weather/environment/lighting and effects pending |
| Audio | Native WebAudio decoding/owned positional voices; trusted gesture and unique real door-open/door-close voices during genuine original queued completion exercised | Broader authored event/material mapping and Build 42 FMOD parity remain open |
| Vehicles/utilities/additional systems | None | Inventory original systems from build-specific scripts/classes before claims; no omission lowers destination |
| Saves/storage | Integrity-checked browser format 2, staged cells/definitions/items/actor restore, optional moodle/body/door/queue state and exact Lua queue owners, integrity-first v1 migration, IDB current+previous transactions, import/export and denied-storage live backup; actual current/future-group positive-progress autosave/reload/resume completed all six original items; missing saved-cell geometry blocks startup without replacing retained saves | Manual pause/Escape Save cancels actions; automatic 30-second Save freezes without STOP. Complete backup-transfer/quota/eviction recovery and later migrations pending; no native-save compatibility |
| Mods | Experimental movement/world/item/health/moodle-input actions with detached queries and atomic validated updates, acceptance-only pickup/door/walk requests, native queue/timing queries, owner-bound activation-only definitions and namespaced UI options; local package manager and JavaScript namespace lifecycle/schema migration proven at unchanged exact version | Exact package-version mismatch blocks automatic restoration; broader migration, zip packaging, per-mod live unload, complete registries/settings/gameplay APIs pending; SDK append does not change original menu queue-clearing behavior |
| Existing native Lua mods | Disabled-by-default common/version loader, real browser Lua 5.4/partial Lua 5.1, owned lifecycle/rollback; unchanged BarefootMoodle/MoodleFramework UI; genuine original context menus and grab callbacks with supported queue restoration, shared 26-member moodle registry and original Small/Medium/Large bitmap-font resources | Narrow original-source proof, not full Workshop/Kahlua/Java/UI equivalence; EN/1x, single-player viewport and 32px moodles are port choices; full HUD, shaping/scale tiers, thermal chevrons/voices/wiggles and broader facilities pending; unknown builds block execution |
| Remote/offline use | Asset-free static app + separately provisioned `/content/` on a private range-capable host; fresh automatic browser startup, independent simulation, no native companion | Personal content-directory/save-backup transfer, second-device and offline-cache acceptance pending; hosting the app alone does not provide content |

## Asset-format coverage

| Content | Browser path | Status/limitation |
|---|---|---|
| Standalone PNG gameplay art | HTTP directory resource → bounded header validation → createImageBitmap → GPUTexture | Historical M1 file-picker WebGPU/WASM/mod smoke verified original 64×64 AppleRotten.png; not directory-load proof. Valid PNG color/depth pairs and Adam7 accepted, 16-bit downconverted to RGBA8, animated PNG first frame only |
| Texture/sprite `.pack` | Bounded HTTP Range source, PZPK v1/legacy metadata parser, lazy PNG page ranges and trimmed GPU sprite crops | Actual five-bank Tutorial directory decode/presentation exercised: 548/557 authored catalogue names resolve; nine vegetation names remain gaps. Current Tiles2x metadata has 321028239 bytes, 369 pages and 35746 entries; no DDS |
| Item/script/clothing definitions | Ordered text/XML parsers retaining unknown fields/provenance and canonical source tags; source footwear/hands seeded into WASM definitions with loader-only constructor defaults; independent native f32 live base/actual weights, flat carry and tagged-hands query | Original RagWrap/ArmyBoots numeric SDK/portable restore and FlipFlop condition/equipment exercised; boxing-glove SDK wear/unequip/rewear and Save/reload retain tags/native query. Worn ×0.3, pickup-order f32 sums and carry50 versus maxWeight8 are covered; failing-before/passing-after save regression protects order. Nested contents, hotbar, Moveable, native inheritance/dynamics, broad loot/use and worn/ground visuals remain incomplete; one wearable per stack is port policy |
| Meshes/models/animations | Directory resources, bounded ASCII DirectX X skinning and binary static FBX geometry/material decoding | Original MaleBody/Bob directory rendering exercised; static FBX 7300 ground meshes decoded locally, not yet presented in gameplay. Binary/compressed X, FBX skinning and native character scale/facing remain unsupported or uncalibrated |
| Sounds/banks | Native WebAudio decoding, owner-bound voices and equal-power positional mono cues | Trusted-gesture AudioContext decoded three genuine private WAV cues; SDK owner disposal/pause/resume retained shared registrations. Ten OfflineAudioContext checks cover routing/attenuation. Integrated original door-menu roundtrip produced unique real open/close voices without audio errors. Build 42 FMOD bank/event and material parity remain unimplemented |
| Map/world/tile definitions | Native tagged navigation, LOTHv1/LOTPv1 lazy geometry loader, ordered TDEFv1 registry, source-bound WASM doors and revision-cached original art | Seven-file/four-cell ingestion resolves 61226 sprites, 18 doors, 393216 squares and 25 rooms, including rotated partners. Native collision/locks/coupled panels/history/source-matched restore pass compiled tests; actual original context-menu approach/open/close/get-up completion is proven. Roof cutaways, visible GPU door-art fidelity and multilevel parity remain open. Every saved cell requires geometry; streamed lotpack HTTP 503 visibly stops movement |
| Native saves | Separate compatibility project | Not supported; first browser saves remain distinct/versioned |

All proprietary inputs/caches/packs remain in a separate externally provisioned content directory, outside tracked source and application release artifacts. Transfer that directory to another device or serve it beside the asset-free app on a private static host with byte-range support. No web asset import or mandatory native converter/runtime companion. Provisioning preserves the original installation and native saves; browser save-backup JSON import/export remains separate and requires matching visual content on the receiving device.

Original footwear/hands discovery uses `media/scripts/generated/items/clothing.txt`, `media/scripts/generated/models_clothes.txt`, clothing-item XML and the corresponding ground FBX files. ArmyBoots explicitly has empty worn-model fields; the port does not substitute another mesh. FlipFlop names actual male/female worn X resources. Static FBX parsing retains source UV orientation, axis/unit metadata and material texture connections, and bakes supported local/geometric transforms once. Unsupported animation/skinning, malformed geometry and compressed-array limits fail explicitly. Texture-exporter absolute paths are metadata, not permission to fetch arbitrary files.

Original Lua UI resources are loaded privately from the selected engine/module closure and actual native common/version overlays. Original engine startup classes run before the unchanged mods under their initiating API owner. Single-page unpacked BMFont advances/kerning/line height and original EN translations drive measurement/drawing; ordered texture/text/rectangle commands use the game canvas with clipping and frontmost pointer/key routing. Options use the owning mod's `nativeUIOptions` save namespace and original registered apply callbacks, not a new options panel. Actual import of a privately modified/re-signed exported backup restored a nonwhite MoodleFramework configuration: the original callback visibly made the torn-icon background green, retained through real Save/Load revision 37 and reboot without observed Lua errors or item-state loss. This proves restored configuration/persistence, not native option-menu editing. Missing resources and unsupported methods fail attributably rather than substituting fonts, neutral moodles or dummy Java objects. Actual death-event UI cleanup is proved under port health-zero policy only. A page-local GPU command-creation fault visibly failed/paused the app through the outer frame handler; it is not a Lua UI callback-exception or device-loss proof.

The resident Lua `Core` identity requires an active package API, not UI resources. Source key-binding queries use the supplied input context; viewport, font and other UI operations still require their actual resources. The supported original `KeybindId` identities use captured native names; absent registered bindings retain native `KEYBINDING_EMPTY` zero-key matching rather than invented default keys.

Lua module lookup case-folds realm-relative paths as the native file map does, while retaining original source paths for execution and diagnostics. It does not invent suffix aliases for files beneath additional directories. A genuinely missing Lua module uses the VM's existing warning facility and returns native `nil`, allowing optional-dependency consumers to continue; a found module's evaluation errors still propagate with original source attribution. JavaScript package dependency validation is unchanged.

Queued source restoration loads the unchanged action classes before package activation without eagerly loading the world-context-menu graph. That graph imports `ISInventoryTransferUtil`, which imports `ISPlayerData` and registers the original full-inventory `OnCreatePlayer` callback without requiring `ISPlayerDataObject`; loading it during hydration changed the fresh-session lifecycle order. After genuine startup events, the finalizer loads original `ISPlayerData` for resident source grabs: `ISGrabItemAction.transferItem` uses its global getter without declaring a require, so restored completion must not depend on opening a first menu. An isolated actual retained positive-progress queue completed all twelve original items through its unchanged callback with no Lua errors. Saved get-up actions with a door continuation retain their native row and exact saved owner, then bind the genuine original callback after player startup events and before publication or the first tick. An explicit owner-liveness query is required even when binding only Lua fields. Unbound continuations refuse gameplay callback dispatch and save capture while retaining genuine STOP cleanup. Ordinary grab/walk/door rows remain hydrated early, including their clocks and live group projections, and later package admissions are not rebuilt. The existing lazy original `ISPlayerDataObject:new(0)`, inventory-page and context-menu bootstrap remains the sole supported scoped source UI route; no lifecycle callback is replaced or replayed. Full `createInventoryInterface` HUD support remains open. Regression coverage exercises queued grab completion before the first restored menu, genuine widget identities and deferred continuation ownership/failure isolation; browser acceptance must be exercised separately.

The asynchronous world-context opener preserves focus taken by the original accessibility menu. It focuses the canvas only when no menu opened and the same request, session and UI remain current and ready. Existing blur/visibility safety cancellation is unchanged.

Original `ISWorldObjectContextMenu.createMenu` refuses new menus at speed 0. Repeated original grab selections call `luautils.walkAdj` without keeping actions and replace earlier work; SDK pickup requests support append to Lua-origin current/future groups. Actual autosave/reload/resume, source/SDK veto, grab → door → walk FIFO, original door approach/open/close/get-up/audio and 26-item GrabAll groups 20+6 are proven. The boundary retained the same started action/history, reset current progress and changed maximum 14 → 12; all 26 completed. Escape STOP of original GrabAll 25/groups20+5 left every item ground, and closed-edge heading admission refused without moving the actor. The Lua/DOM return fault is resolved by discarding HTMLElement returns from void source calls. Broader fidelity and all 13 full-game gates remain open; details are in STATUS.md.

Flat item-icon loading and the Lua getter share the original script normal-texture rule: retain an explicit `Icon`, otherwise initialize from the first semicolon-delimited `IconsForTexture` entry as original `Item.onLoad` does. Raw fields and provenance are unchanged; missing metadata, invalid names and unavailable genuine textures still refuse rather than inventing an icon. This is initialization for the existing flat state, not per-item clothing-visual selection. Original instance creation also seeds OutfitRNG and synchronizes an initialized ItemVisual's base-texture/texture-choice index; that visual state, randomization, variant-icon persistence and full equipped-clothing presentation remain open.

Original corpse-context logging accepts the authenticated native `DebugType.Grapple` identity and severity policy. `isDebugEnabled` follows the native category/severity gate independently of Core debug mode; global `log` additionally requires Core debug mode before emitting attributed Lua output. The current non-debug session policy is unchanged. Integrated checks pass, and the unchanged original browser callback proceeds through this boundary.

The four inherited corpse-context container queries authenticate supplied native objects and use fresh native collections, not a fabricated player-context cache. The current world domain contains containerless doors and flat ground items, so these queries truthfully return no containers; player and floor inventories are not world containers. Forged or unsupported representations fail explicitly, and native nil-square boundaries remain distinct. World/vehicle containers, nested ownership, corpse placement and body dragging are not implemented. Genuine original door-context presentation and queued approach/open/close completion now have browser proof, distinct from SDK-only door proof.

Vanilla moodle levels use static original Build 42.21.0 rule evidence over WASM-owned named inputs. Engine and Lua share the canonical 26-member `MOODLE_TYPES` mapping, including `UNHAPPY`/`DRUNK`; required missing IDs/capabilities or invalid levels fail explicitly, never neutralize. Queries do not advance hidden timers; accepted engine updates do. Explicit inputs do not supply native weight, weather, illness or survival dynamics. Thermal chevrons, voices and wiggles remain unimplemented. Source discovery and static FBX parsing alone do not prove ground-item models or equipped-clothing rendering.

Browser envelope format 2 preserves ABI 1 and a twelve-word actor state. Legacy v1 is authenticated against its original integrity before detached migration; first ten actor words, world bytes, namespace schemas/data and revision metadata survive, with default health/next-ID and empty item tables appended. Storage is not rewritten merely by reading. Restore orders cells, definitions, items, actor and then optional version-1 `moodleState` (named inputs, pain timer/level and CantSprint timer). Its absence on earlier saves is backward-compatible and uses fresh-engine defaults; malformed present state refuses staged restore.

Native body state persists mutable injury/skin fields and source severity only.
Readonly anatomy/pain and thermal action factors are recomputed from real native
records after staged restore; they are not copied from script metadata or cached
as neutral values. Actual public SDK veto/atomic-refusal and genuine Lua tick
scenarios passed. A fresh Node SDK export/restore retained hand pain
23.833330154418945 and thermal factor 1.002062439918518 in a 6079-byte backup,
without changing the twelve-word actor state. This is a numeric timing prerequisite,
not a complete physiological simulation or a queued-pickup completion claim.

### Source glove-tag prerequisite

Source semicolon-delimited `Tags` retain raw fields/provenance and become
lowercase `namespace:path` identities, defaulting the namespace to `base`.
The parser supplies no gameplay defaults. Only original wearable seeding applies
verified constructor values before authored fields: condition maximum/chance 10,
weight/run-speed modifier 1 and remove-on-broken true. `stackLimit:1` is port policy;
seeding does not replace saved definitions or owners.

SDK `character.isWearingAwkwardGloves()` and live Lua
`player:isWearingAwkwardGloves()` derive from the actual native `base:hands` item
and its definition's `base:awkwardgloves` tag. Detached optional definition tags
persist through existing definition/item saves and rederive the native flag on
restore; no actor flag or new save field is added, and unsupported native
capabilities throw rather than returning a fabricated false.

Six focused native/parser/SDK/Lua/portable checks and the build passed; the
integrated check is pending. Actual original-scene public SDK wear/unequip/rewear
and Save revision 6/reload retained worn ID 1/condition 10 and the native true
query. This is not visible glove-art, source pickup-duration or timed-queue proof.
All 13 full-game gates remain open, including traits/survival, equipped-clothing
rendering, original accessible context actions and roof visibility.

### Source-square interaction prerequisite

SDK `world.getSquare(x, y, z)` reads detached native source-square facts and
current standability; absent squares return `null`, unsupported capability
throws. Stable Lua cell/square userdata expose genuine coordinate lookup,
current-player square at port elevation 0 and `canStand()`. Room identities are
the existing dense canonical projection, not original packed `RoomID` values.

Initial metadata replay accounts for actual constructor priority, attached
overlays, shared window-property mutations, insertion order, floor/tree
replacement and current door sprite history. Actual stand edges remain separate
from legacy raw window collision, preserving existing movement and door reach.
Unresolved component-bearing conditional floor replacement refuses import;
entity-component execution, texture failures and full object lifecycle are not
implemented by this subset.

Native `world.isBlockedTo(from, to)` and genuine Lua
`square:isBlockedTo(otherSquareOrNil)` now evaluate the source wall,
blocked-window, blocked-door and directional stair-top relation. Lowercase
window flags, actual window destroyed/open state and uppercase frames remain
distinct; final shared properties/cached types and current door partner history
are projected separately from unchanged legacy movement collision. Same or
null/absent other squares return false; an absent caller, foreign Lua userdata
or unsupported capability errors. These are imported-constructor/current-door
facts, not window-action or player-built-thumpable runtime parity.

A fresh owned Chromium reload exercised the public SDK across four genuine
closed-door pairs in both directions, retained 18 doors and returned false for
same/null/absent-other relations. Actor 191.5/199.5, tick 864, idle, health 100
was identical before and after these read-only queries; no nonempty alerts were
present. Full local verification passed 37 Rust tests, 375 Node tests with one
Linux-only skip, zero-warning lint, formatting/clippy, document links and build.

Neither square query proves roof cutaways, visible interactions, the timed-action
queue or full interaction-gate completion.

### Original source lifecycle and render-event boundary

The original context path uses resident PlayerData, inventory-page and context-menu
sources rather than replacement widgets. A successful browser save commits first,
then delivers `OnPostSave`; a source/layout-storage callback failure is reported
without undoing or replacing that retained save. Load and export do not replay this
event. Closed original `layout.ini` writers flush to build/owner-scoped client
storage; unsupported files and genuine storage failures remain explicit errors.

Actual browser Save/export followed by file-input import of a correctly signed
malformed native queue preserved exact current/previous saved JSON and live state;
Core's build/owner-scoped layout header remained `[1000x800]` plus CRLF.
An independently authored native Lua package asserted zero-argument `OnPostSave`;
the next save captured the prior callback increment, proving commit-before-event
order. Its intentional error after genuine original STOP left the queue empty,
item ground, actor idle, pause dialog visible, audio suspended/no active voices
and the retained save unchanged, with no save after the error.
These are Core-only layout and owned failure-boundary proofs, not full HUD,
general source-file compatibility or arbitrary original callback-failure fidelity.

Committed viewport changes publish the new dimensions before
`OnResolutionChange(oldWidth, oldHeight, newWidth, newHeight)`. Newly pressed right
mouse input reaches `OnRightMouseDown(x, y)` only after original UI refusal.
Held-item events follow actual native commits, including nil unequip, not save
hydration, same-value assignments or vetoed commands.

Canvas pointer input keeps the shared border-excluding logical content coordinates;
device pixels and CSS transforms do not create a second UI coordinate space.
Visible source widgets receive input before world travel, including genuine outside
callbacks. The offscreen accessibility menu mirrors native submenu visibility, not
an independent painted or hidden child menu. Source action callbacks remain resident
until their native action slot retires, including detached completion-to-stop replies.
Native source `UIElement` construction retains Java's default mouse-consumption
flag: an implemented callback returning nil consumes the hit, while explicit
false, a disabled consumption flag and absent callbacks remain unhandled.
An empty original context-menu mouse-down therefore cannot fall through to lower
menus' outside callbacks before its mouse-up selects the resident option. The
public JavaScript UI construction default remains unchanged.

Source square object lists use live native count/index queries with stable Lua
door/item identities; enumeration does not copy the complete world stores for
each lookup. SDK `items.get(id)` shares a direct native stable-ID read and still
returns a detached record or null for an unknown valid uint32 ID. No item-row or
save-format change is introduced. This context binding is not a rendered
inventory/loot HUD or full inventory bootstrap.

The renderer delivers `RenderOpaqueObjectsInWorld` after resident opaque source
geometry and before moving objects, and mouse-backed `OnDoTileBuilding2` with
`isRender=true` after the world pass and before source UI. Tile picking retains
integer/fractional vectors from an observed unconsumed pointer and the live renderer
projection; it is not object or sprite-alpha picking. Validity uses the actual
loaded 256-tile ground-cell footprint; callbacks may receive a nil source square.
An active drag plus new unconsumed primary click explicitly refuses unsupported
`IsoObjectPicker.ContextPick`, before either a false building callback or default
travel. There is no fabricated object pick or controller-backed `OnDoTileBuilding3`
producer. The current native world has no IsoThumpable creation/destruction domain;
retaining a genuine destruction listener does not prove destruction delivery.

Full original HUD bootstrap, native build-button queries, blueprint sprite
rendering, placement and object/controller input remain open. These lifecycle and
render producers do not close any full-game inventory, world or building gate.
The genuine original grouped-grab/menu and autosave/reload/resume proof is recorded
in STATUS.md; other source lifecycle/render producers still need their own gameplay acceptance.





### Browser texture-pack format and index API

`src/content.js` opens the manifest with `await openContentDirectory(manifestUrl, {signal,onProgress})`; `getFile(path)` returns an HTTP-backed handle with manifest `size`, `name`, `lastModified`, `relativePath` and bounded `slice(start,end).arrayBuffer()` reads. Each read is limited to 16 MiB and requires an exact HTTP 206 range, matching `Content-Range` total and byte length; an ignored-range 200 response is cancelled unread. `src/packs.js` exports `await openPack(source)` for these handles and `File`/`Blob` parser inputs. It indexes metadata without decoding images, with at most 16 KiB per metadata window including read-ahead, never a whole-bank buffer. PZPK image payloads are skipped by declared lengths; legacy payloads by PNG chunk lengths. Legacy scanning can nevertheless cumulatively read almost an entire bank because small PNG chunks and read-ahead revisit image regions: bounded windows limit peak buffers, not total legacy bandwidth. PNG inspection records dimensions and half-open source ranges. `createImageBitmap(await index.pageBlob(pageIndex))` fetches/decodes the requested PNG page. Parser `File`/`Blob` support is not a web picker workflow.
Fully parsed follow-up `Tiles1x.pack` and `JumboTrees2x.pack` also contain none of the nine unresolved vegetation names. The names are authored in original Tutorial catalogues and tile definitions. Their native presentation is unverified; no guessed substitutes are installed. [Bounded read counts and exact coverage](evidence/m2-directory-acceptance.json).

Supported layouts, based on installed build 25485521 observations and corroborating public readers/writers:

- **PZPK v1:** ASCII `PZPK`, little-endian version `1`, page count; each page has a length-prefixed UTF-8 name, entry count, opaque signed `hasAlpha` field, sprite entries, then a little-endian PNG byte length and that PNG. Other PZPK versions are refused.
- **Legacy v0:** no magic/version; starts with the little-endian page count. Page metadata and sprite fields match v1, but the PNG is self-terminating. The parser walks big-endian PNG chunk lengths through zero-length `IEND`, excluding the optional `EF BE AD DE` (`DEADBEEF`) marker from the returned image slice. An optional marker is also tolerated at page boundaries; its presence in vanilla PZPK was not established.
- **Sprite entry:** length-prefixed name then eight little-endian unsigned fields: `x,y,w,h,xoff,yoff,totalW,totalH`. The trimmed rectangle `(x,y,w,h)` belongs to one atlas page; its reconstructed canvas is `totalW × totalH`, with the trimmed pixels placed at `(xoff,yoff)`. Atlas pages mix tilesets; page names are not tileset IDs.

The returned index and every exposed object/array are frozen. `pages` contains `{index,name,hasAlpha,width,height,pngStart,pngEnd,sprites}`; each sprite is `{name,pageIndex,entryIndex,x,y,w,h,xoff,yoff,totalW,totalH}`. `sprites` preserves all entries in on-disk page/entry order. `lookup(name)` returns the **first on-disk occurrence**, or `undefined`; duplicate names are never silently discarded: `lookupAll(name)` returns every occurrence, and `findByPrefix(prefix)` returns every matching occurrence in disk order. `pageBlob(pageIndex)` returns a `Promise<Blob>` for that `image/png` page, refusing invalid indices; a native Blob source is sliced, an HTTP source materializes only the exact page range. `source` preserves the provided name, byte size, last-modified timestamp (or `null`) and relative path; these identify the input, not a content hash or authenticity guarantee. Types are declared in `types/packs.d.ts`.

Parser guardrails are application policy, not universal native-format limits: 1–512 pages; ≤100,000 entries/page and ≤250,000 total; names 1–4096 UTF-8 bytes without controls; ≤64 MiB aggregate metadata; PNG dimensions and reconstructed canvases 1–4096 per axis; ≤65,536 chunks per legacy image. Trim rectangles must fit their canvas and atlas. Transparent zero-area trimmed rectangles are allowed when the canvas is valid. Unsupported versions, malformed UTF-8, truncation, out-of-file image/chunk lengths, invalid PNG signature/IHDR/IEND, excessive counts/metadata, and unexpected trailing bytes produce explicit refusals. `hasAlpha` and legacy `W…` sprite-name semantics are preserved, not interpreted.

Indexing is **not** PNG CRC/IDAT validation, full image decode, map loading, tile-property loading, or proof of native rendering/collision fidelity. PNG decompression and CRC acceptance remain with the browser decoder. No DDS decoder is implemented: the inspected installed samples contained PNG, not DDS. Earlier format discovery reported `Tiles2x.pack` with 113 pages (~306.2 MB); the later current-install map/tile probe reports 369 pages and 35,746 sprite names. These observations must not be treated as one immutable pack identity. `Tiles1x.floor.pack`, `UI2.pack`, and `DepthMaps2x.pack` were observed as PZPK v1, while `UI.pack` and `IconsMoveables.pack` were legacy streams. The later Tutorial catalogue probe found 429 of 557 names in Tiles2x alone, so a single pack is not a complete environment asset set; companion floor/tree/overlay packs may be required. Synthetic tests cover both layouts, duplicate lookup, trim geometry, corruption, and bounded 113-page indexing; they contain no proprietary bytes. Execution evidence must be recorded separately rather than inferred from test existence.

Public corroboration: [pz-tilesheet writer](https://github.com/robotsmeller/pz-tilesheet), the Vaileasys `pack_parser.py` reader cited in the format evidence, and [PZ mapping tools documentation](https://github.com/Unjammer/PZ_Mapping_Tools).

### Narrow installed-content inventory (static observations)

- M1 PNG: `media/textures/WorldItems/AppleRotten.png`, observed 64×64 texture image (not an animated sprite). Other loose PNG examples: `media/inventory/RifleClip.png` (361 bytes), `BerettaClip.png` (420 bytes). Inspect actual semantics before using textures as character art.
- Atlas packs: current `media/texturepacks/Tiles2x.pack`321028239 bytes,369 pages,35746 entries, indexed with bounded file-backed slices. Companion floor/overlay/tree packs are required for additional Tutorial sprites. Actual five-bank Tutorial directory decode/presentation is browser-proven; nine vegetation names remain unresolved. Never read the whole bank into memory.
- Tiles: `media/newtiledefinitions.tiles` (~2.8 MB), `.tiles.txt` (~6.5 MB), `tileGeometry.txt` (~6.1 MB); text sidecars are references, not proof of collision equivalence.
- Models/animation: `media/models_X` FBX/.X and `media/models/*.txt`; `anims_X`, `animsold/*.txt`, `AnimSets/*.xml`, `actiongroups/player`, `animscript/combat.xml`. Native jassimp presence does not prove every FBX import shape.
- Audio: loose `media/sound/zombiehit5.wav` (~45.8 KB), `windowopen.ogg` (~35 KB), FMOD banks under `sound/banks`, music OGG. Loose browser decode plausible but unexecuted; FMOD bank handling remains unknown.
- World: Knox cells share `media/maps/Muldraugh, KY/`; towns reference that lot directory. Per-cell `X_Y.lotheader`, `world_X_Y.lotpack`, `chunkdata_X_Y.bin`. Tutorial is the bounded four-cell directory startup target. Cell256×256; navigation32×32 records of8×8 tiles. Geometry has original z levels, but simulation navigation currently only ground floor.
- Presentation references: GLSL `media/shaders/*.vert/*.frag` (~169 files). WGSL translation must be behavior-verified rather than assuming shader equivalence.

File sizes rounded where inventory reported rounded values; these are format discovery facts, not memory-performance measurements. Original Java movement/animation engine behavior remains unobserved.

## Browser/device matrix

[Chrome platform overview](https://developer.chrome.com/docs/web-platform/webgpu/overview) documents Windows D3D12-capable Chrome 113+, Android 12+ Chrome 121+ on eligible Qualcomm/ARM GPUs, Firefox 141 Windows, Safari 26. [W3C WebGPU specification](https://gpuweb.github.io/gpuweb/) defines resources/lifecycle. These are implementation baselines, **not this application's verified support matrix**.

| Target | Eligibility | Project validation |
|---|---|---|
| Windows Chromium 154 | HTTPS/localhost + adapter | Real nonfallback NVIDIA/ampere WebGPU, bgra8unorm: Tutorial directory autoload, original tiles/skinned character, full-viewport game-only UI, movement/cancel, retained-save/two-autosave continuity and JavaScript namespace lifecycle exercised. Actual device loss retains fatal reload feedback over a delayed Load HTTP 503; streamed lotpack HTTP 503 visibly pauses movement. Metadata-only proof in STATUS; not native visual/gameplay parity |
| Other Windows Chrome/Edge, Firefox | GPU/driver/browser capability dependent | Unverified |
| macOS Safari 26 / Chrome | WebGPU-capable device | Unverified |
| Android Chrome, physical device | Android 12+, eligible GPU + secure context | Existing SDK adb devices-list empty; no attached target, unverified release requirement |
| iOS/iPadOS Safari 26, physical device | Eligible WebGPU device + secure context | No physical target supplied; unverified release requirement |
| Software/headless/emulated browser | Actual adapter must be recorded | Contract/render proof only; never mobile/hardware-performance claim |

M1 controls target ≥48 px, responsive layout, canvas DPR capped, pointer input unified. Orientation/pixel-density emulation does not prove physical touch, mobile memory/thermals, background suspension or assistive technology. Device loss stops simulation with visible error; reload recovers through directory autoload, subject to fresh browser proof. No silent WebGL fallback. UI scale uses rem/browser zoom; further accessibility checks remain acceptance work.

## Resource and timing limits

PNG ≤16 MiB, dimensions ≤4096 each, estimated RGBA8 GPU texture ≤64 MiB, also bounded by adapter limits. Browser decoder peak allocation is not measured or guaranteed to equal four bytes/pixel, especially for 16-bit sources. One native logical frame per RAF uses raw elapsed time, including initial elapsed 0; explicit `step` accepts `[0,0.1]`. Manual pause/hidden/blur cancels queued work and movement; automatic saving only freezes the session. No shared-memory threads/COOP/COEP requirement. Directory resource fetching/decoding is asynchronous; large packs use bounded ranges, not whole-bank downloads. Historical M1 rendered one marker image only.

These are guardrails, not measured device performance budgets. Record actual frame times, source/decoded memory, resource-load duration and latency before establishing budgets. Audio and storage budgets cannot be claimed for absent systems.
