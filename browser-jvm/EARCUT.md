# Original indexed triangulation through upstream Earcut WASM

The original `zombie.vehicles.Clipper.triangulate2` Java declaration and callers remain unchanged. The existing Clipper2 owner supplies the generated outer ring and holes; a small adapter passes their exact integer coordinates to upstream Mapbox Earcut C++ compiled to WASM. Java preserves the original vertex table and big-endian short/float/index buffer ABI, caller position/limit and output bounds.

REA inspection of the installed DLL identifies the Earcut family's distinctive vertex threshold, linked-ring/hole processing and optional spatial hash. The exact installed upstream revision is unknown. The candidate is pinned to upstream **2.2.4**, commit `4811a2b69b91f6127a75e780de6e2113609ddabb`; geometry comparisons do not establish identical versions or universal index ordering.

## Local build inputs

Use Python through `py -3` and the existing Emscripten 3.1.74 SDK at `.tools/emsdk-3.1.74-source/emsdk-3d6d8ee910466516a53e665b86458faa81dae9ba`. For a fresh SDK, follow the Emsdk download/hash/install/activate commands in [BULLET.md](BULLET.md#prepare-the-optional-tools); Bullet source itself is not required by Earcut.

Download the two pinned upstream inputs:

```powershell
New-Item -ItemType Directory -Force .tools/earcut-4811a2b6 | Out-Null
Invoke-WebRequest 'https://raw.githubusercontent.com/mapbox/earcut.hpp/4811a2b69b91f6127a75e780de6e2113609ddabb/include/mapbox/earcut.hpp' -OutFile '.tools/earcut-4811a2b6/earcut.hpp'
Invoke-WebRequest 'https://raw.githubusercontent.com/mapbox/earcut.hpp/4811a2b69b91f6127a75e780de6e2113609ddabb/LICENSE' -OutFile '.tools/earcut-4811a2b6/LICENSE'
```

`earcut-sources.json` records both required SHA-256 values. `prepare-earcut-runtime.mjs` verifies those files and the pinned compiler entry script before building, checks them again afterward, and rejects output escapes, symlinks and hardlinked output files. It downloads nothing. Generated modules, WASM, manifests and the copied ISC license stay under ignored `target` directories; downloaded sources and tools stay ignored under `.tools`.

Play/menu preparation and the Clipper verifier build their own artifacts and serve only explicit generated routes. The browser initializes the kernel lazily on the first actual triangulation call, copies coordinates and ring ends into real WASM allocations, returns a detached index array, and frees transport storage in `finally`. Unrelated physics calls do not initialize Earcut.

## Original JVM/browser comparison

Prepare play, set `PZ_JDK`, `PZ_BROWSER` and `PZ_GAME_JAR`, then run:

```powershell
node browser-jvm/verify-clipper.mjs
```

The public gate retains 134 native/browser clipping comparisons and adds eleven indexed mesh comparisons through the original Java JNI declaration. All eleven match vertex tables, index counts, exact integer areas and 10,571 exact rational coverage samples. Nine index lists match exactly; hole and two-hole triangulations have equivalent tested geometry with different index order. The genuine twelve-point map polygon that failed under both GLU sweep axes now matches all thirty native indices and area 480.

Original buffer position, limit, byte-order independence, untouched tails and Java catch/finally behavior are checked. Twelve kernel calls return to zero owned transport allocations/bytes. The accepted run has sixteen unchanged monitored inputs, zero denied requests/errors and closed browser/server owners. Build containment also has separate outside-target, hardlink and junction rejection checks.

This replaces the earlier GLU boundary, which failed on real original map data. It does not qualify the separate native `triangulate`/`generateTriangulatePolygons` operations, native pointer compatibility, complete map presentation, world loading or gameplay. A full menu integration result is required separately.

The fresh full menu run with upstream Earcut remains FAIL, with 9,139 unchanged inputs, zero denied requests, disposed keyboard/mouse, lost GPU context and closed browser/server/watch owners. The earlier GLU degeneracy is absent; the original map renderer now reaches the explicit unqualified clipping-operation guard in `ClipperSupport.generate`. The original Lua style path also raises `WorldMapVisited.setBounds` against missing global metadata initialization; missing owned white/paper texture paths remain visible diagnostics. These are separate next boundaries. No map bounds, triangles, initialization flags or original exceptions are fabricated or suppressed. The passing indexed-mesh component does not establish a complete map screen or gameplay.
