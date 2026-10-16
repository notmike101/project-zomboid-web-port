package port.host;

import java.io.FileInputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Arrays;
import java.util.ArrayList;
import java.util.List;
import java.util.HashSet;
import java.util.Set;
import java.util.TreeSet;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import zombie.GameWindow;
import zombie.Lua.LuaManager;
import zombie.core.physics.Bullet;
import zombie.core.physics.WorldSimulation;
import zombie.debug.DebugOptions;
import zombie.erosion.ErosionGlobals;
import zombie.erosion.ErosionMain;
import zombie.iso.IsoCell;
import zombie.iso.IsoChunk;
import zombie.iso.IsoChunkMap;
import zombie.iso.IsoGridSquare;
import zombie.iso.IsoLot;
import zombie.iso.IsoWorld;
import zombie.iso.SpriteDetails.IsoFlagType;
import zombie.iso.WorldStreamer;
import zombie.iso.sprite.IsoSpriteManager;
import zombie.iso.worldgen.WorldGenParams;
import zombie.pathfind.PolygonalMap2;
import zombie.pathfind.nativeCode.PathfindNative;
import zombie.util.BufferedRandomAccessFile;

/** Owns the original bounded Challenge1 chunk neighborhood lifecycle in the browser JVM. */
public final class BrowserGeometry {
    private static final String MEDIA = "/files/work/media/";
    private static final String[] TILE_FILES = {
        "newtiledefinitions.tiles", "tiledefinitions_erosion.tiles", "tiledefinitions_overlays.tiles",
        "tiledefinitions_b42chunkcaching.tiles", "tiledefinitions_noiseworks.patch.tiles",
        "jumbo_trees_big.tiles", "jumbo_trees.tiles"
    };
    private static final int[] TILE_IDS = {1, 2, 4, 5, -1, 6, 8};

    private BrowserGeometry() { }

    /** Mount before BrowserWorldBootstrap.openAt so original ZFS scans actual assets. */
    public static void mountAssets() throws IOException {
        Path work = Path.of("/files/work");
        try (ZipInputStream zip = new ZipInputStream(new FileInputStream("/app/geometry-assets.jar"))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                if (entry.isDirectory() || entry.getName().startsWith("META-INF/")) continue;
                Path target = work.resolve(entry.getName()).normalize();
                if (!target.startsWith(work)) throw new IOException("Asset escapes work directory");
                Files.createDirectories(target.getParent());
                Files.copy(zip, target, StandardCopyOption.REPLACE_EXISTING);
            }
        }
    }

    /** Loads installed geometry into the caller's sole original cell before player construction. */
    public static Session loadChallenge1(IsoCell cell) throws Exception {
        IsoWorld world = IsoWorld.instance;
        if (cell == null || world.currentCell != cell) {
            throw new IllegalArgumentException("Expected current original cell");
        }
        Session session = new Session(cell);
        try {
            loadTextures();
            IsoSpriteManager sprites = IsoSpriteManager.instance;
            loadTileDefinitions(world, sprites);
            ErosionGlobals.Boot(sprites);
            if (ErosionMain.getInstance().getSeasons() == null) {
                throw new AssertionError("Original erosion season missing");
            }
            loadWorldGenerationLua();
            WorldGenParams params = WorldGenParams.INSTANCE;
            params.setMinXCell(0);
            params.setMinYCell(0);
            params.setMaxXCell(1);
            params.setMaxYCell(1);
            params.setSeedString("geometry-147");
            world.setMap("challengemaps/Challenge1");
            world.getMetaGrid().Create();
            stage("metadata-complete");
            if (!world.isValidSquare(4, 4, 0) || world.getMetaGrid().getMinX() != 0
                    || world.getMetaGrid().getMaxX() != 1) {
                throw new AssertionError("Original bounded map metadata differs");
            }
            zombie.iso.areas.isoregion.IsoRegions.init();
            prewarmStreams();
            // Original IsoWorld boot supports selecting its real Java pathfinding backend.
            DebugOptions.instance.pathfindUseNativeCode.setValue(false);
            PathfindNative.useNativeCode = DebugOptions.instance.pathfindUseNativeCode.getValue();
            PolygonalMap2.instance.init(world.getMetaGrid());
            session.pathfinding = true;
            zombie.globalObjects.GlobalObjectLookup.init(world.getMetaGrid());

            IsoChunkMap map = cell.getChunkMap(0);
            map.setInitialPos(19, 19);
            int middle = IsoChunkMap.chunkGridWidth / 2;
            if (middle < 1 || middle + 1 >= IsoChunkMap.chunkGridWidth)
                throw new IllegalStateException("Original chunk map cannot contain the requested neighborhood");
            // Exact original Bullet.init transport allocation; no desktop library-load success stub.
            Bullet.cmdBuf = ByteBuffer.allocateDirect(4096).order(ByteOrder.LITTLE_ENDIAN);
            WorldSimulation.instance.create();
            session.physics = true;
            WorldStreamer.instance.create();
            session.streamer = true;
            requestChunk(session, map, 19, 19, middle, middle);
            for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
                if (dx != 0 || dy != 0) requestChunk(session, map, 19 + dx, 19 + dy, middle + dx, middle + dy);
            }
            long end = System.currentTimeMillis() + 60000;
            while ((WorldStreamer.instance.isBusy() || !allQueued(session.chunks))
                    && System.currentTimeMillis() < end) {
                Thread.sleep(10);
            }
            if (WorldStreamer.instance.isBusy() || !allQueued(session.chunks))
                throw new AssertionError("Original raw chunk neighborhood never completed");
            List<IsoChunk> ready = new ArrayList<>();
            IsoChunk.loadGridSquare.copyTo(ready);
            for (IsoChunk requested : session.chunks) {
                if (!ready.contains(requested) || !map.setChunkDirect(requested, false))
                    throw new AssertionError("Original queued chunk registration failed");
            }
            map.calculateZExtentsForChunkMap();
            IsoGridSquare square = cell.getGridSquare(153, 158, 0);
            if (square == null || square.getFloor() == null || !square.TreatAsSolidFloor())
                throw new AssertionError("Original raw map spawn floor absent");
            session.chunk = session.chunks.get(0);
            session.spawnSquare = square;
            stage("raw-neighborhood-registered-before-player");
            return session;
        } catch (Exception | Error failure) {
            try {
                session.close();
            } catch (Throwable cleanup) {
                failure.addSuppressed(cleanup);
            }
            throw failure;
        }
    }

    private static void requestChunk(Session session, IsoChunkMap map, int worldX, int worldY, int mapX, int mapY) {
        IsoChunk chunk = map.LoadChunkForLater(worldX, worldY, mapX, mapY);
        if (chunk == null) throw new AssertionError("Original chunk request rejected: " + worldX + "," + worldY);
        session.chunks.add(chunk);
    }

    private static boolean allQueued(List<IsoChunk> chunks) {
        for (IsoChunk chunk : chunks) if (!IsoChunk.loadGridSquare.contains(chunk)) return false;
        return true;
    }
    private static boolean allLoaded(List<IsoChunk> chunks) {
        for (IsoChunk chunk : chunks) if (!chunk.loaded) return false;
        return true;
    }

    private static void loadTextures() throws Exception {
        BrowserTileTextures.mountChallenge1Packs();
        Set<String> tileNames = new TreeSet<>();
        for (String name : new String[] {"0_0", "0_1", "1_0", "1_1"}) {
            try (BufferedRandomAccessFile header = new BufferedRandomAccessFile(
                    MEDIA + "maps/challengemaps/Challenge1/" + name + ".lotheader", "r", 4096)) {
                header.skipBytes(4);
                if (IsoLot.readInt(header) != 1) throw new AssertionError("Header version");
                int count = IsoLot.readInt(header);
                for (int i = 0; i < count; i++) tileNames.add(IsoLot.readString(header).trim());
            }
        }
        int loaded = 0;
        for (String name : tileNames) {
            if (GameWindow.texturePackTextures.containsKey(name)) {
                BrowserTileTextures.load(name);
                loaded++;
            }
        }
        if (loaded != 227) throw new AssertionError("Original map texture preload incomplete: " + loaded);
    }

    private static void loadTileDefinitions(IsoWorld world, IsoSpriteManager sprites) throws Exception {
        for (int i = 0; i < TILE_FILES.length; i++) {
            world.LoadTileDefinitionsPropertyStrings(sprites, MEDIA + TILE_FILES[i], TILE_IDS[i]);
        }
        for (String name : new String[] {"SetCustomPropertyValues", "GenerateTilePropertyLookupTables"}) {
            var method = IsoWorld.class.getDeclaredMethod(name);
            method.setAccessible(true);
            method.invoke(world);
        }
        for (int i = 0; i < TILE_FILES.length; i++) {
            world.LoadTileDefinitions(sprites, MEDIA + TILE_FILES[i], TILE_IDS[i]);
        }
        var floor = sprites.getSprite("floors_interior_tilesandwood_01_0");
        if (floor == null || !floor.getProperties().has(IsoFlagType.solidfloor)) {
            throw new AssertionError("Original floor tile/property missing");
        }
    }

    private static void loadWorldGenerationLua() throws Exception {
        LuaManager.LoadDirBase("server", true);
        for (String name : new String[] {"WorldGen/WorldGen.lua", "metazones/BiomeMapConfig.lua",
                "metazones/AnimalsPathConfig.lua", "Zombies/VoronoiNoise.lua"}) {
            LuaManager.RunLua(MEDIA + "lua/server/" + name);
        }
        if (LuaManager.env.rawget("worldgen") == null) throw new AssertionError("Original worldgen Lua absent");
    }

    private static void prewarmStreams() {
        // Runtime SDK dispatch warmup: real pipelines, no game bytecode alteration.
        for (int i = 0; i < 100; i++) {
            if (Arrays.stream(new int[] {3, 1, 3, 2, 1}).distinct().boxed()
                    .collect(HashSet::new, Set::add, Set::addAll).size() != 3) {
                throw new AssertionError("SDK pipeline changed");
            }
        }
    }

    private static void stage(String name) {
        System.out.println("BrowserGeometry: " + name);
    }

    /** Original worker/world lifetime; no player or asset-executor ownership. */
    public static final class Session implements AutoCloseable {
        private boolean streamer;
        private boolean pathfinding;
        private boolean physics;
        private boolean closed;
        private boolean activated;
        private final IsoCell cell;
        private IsoChunk chunk;
        private final List<IsoChunk> chunks = new ArrayList<>();
        private int groundFloorCount;
        private IsoGridSquare spawnSquare;

        private Session(IsoCell cell) {
            this.cell = cell;
        }

        public IsoChunk getChunk() { return chunk; }
        public List<IsoChunk> getChunks() { return List.copyOf(chunks); }
        public int getGroundFloorCount() { return groundFloorCount; }
        public IsoGridSquare getSpawnSquare() { return spawnSquare; }

        /** Completes original chunk activation only after the real player has been registered. */
        public void activate() {
            if (closed) throw new IllegalStateException("Geometry session closed");
            if (activated) return;
            var player = zombie.characters.IsoPlayer.getInstance();
            if (IsoWorld.instance.currentCell != cell || player == null || player.getCell() != cell
                    || player.getSquare() != spawnSquare) {
                throw new IllegalStateException("Original player must own the loaded spawn square before activation");
            }
            if (!allQueued(chunks)) throw new AssertionError("Original activation queue lost a requested chunk");
            IsoChunkMap map = cell.getChunkMap(0);
            // loaded already became true in original setChunkDirect; it cannot indicate activation.
            map.processAllLoadGridSquare();
            for (IsoChunk loaded : chunks) {
                if (IsoChunk.loadGridSquare.contains(loaded))
                    throw new AssertionError("Original chunk activation did not consume its queue entry");
            }
            if (!allLoaded(chunks)) throw new AssertionError("Original activated neighborhood is incomplete");
            stage("nine-chunks-activated-after-player");
            stage("physics-upload-before");
            int totalFloors = 0;
            int middle = IsoChunkMap.chunkGridWidth / 2;
            for (IsoChunk loaded : chunks) {
                int mapX = middle + loaded.wx - 19, mapY = middle + loaded.wy - 19;
                if (map.getChunk(mapX, mapY) != loaded)
                    throw new AssertionError("Original loaded chunk is not bound to its chunk map");
                loaded.updatePhysicsForLevel(0);
                int floors = 0;
                for (int y = 0; y < IsoChunkMap.CHUNK_SIZE_IN_SQUARES; y++)
                    for (int x = 0; x < IsoChunkMap.CHUNK_SIZE_IN_SQUARES; x++) {
                        IsoGridSquare ground = cell.getGridSquare(loaded.wx * IsoChunkMap.CHUNK_SIZE_IN_SQUARES + x,
                                loaded.wy * IsoChunkMap.CHUNK_SIZE_IN_SQUARES + y, 0);
                        if (ground == null || ground.getChunk() != loaded)
                            throw new AssertionError("Original ground square is absent or bound to another chunk");
                        if (ground.getFloor() != null && ground.TreatAsSolidFloor()) floors++;
                    }
                totalFloors += floors;
                stage("chunk-" + loaded.wx + "-" + loaded.wy + "-ground-floors-" + floors);
            }
            stage("physics-upload-after");
            if (totalFloors != 576) throw new AssertionError("Original neighborhood ground floors incomplete");
            if (cell.getGridSquare(153, 158, 0) != spawnSquare || spawnSquare.getFloor() == null)
                throw new AssertionError("Original spawn square changed during activation");
            stage("floor-recalc-before");
            spawnSquare.RecalcAllWithNeighbours(true);
            stage("floor-recalc-after");
            if (!spawnSquare.TreatAsSolidFloor()) throw new AssertionError("Original floor absent");
            groundFloorCount = totalFloors;
            activated = true;
            stage("session-ready");
        }

        private static void awaitStreamerExit() {
            try {
                var field = WorldStreamer.class.getDeclaredField("worldStreamer");
                field.setAccessible(true);
                Thread worker = (Thread) field.get(WorldStreamer.instance);
                if (worker == null) throw new IllegalStateException("Original streamer thread missing");
                // Same public stop request as original stop(). Yield before its non-yielding spin,
                // allowing the real browser-JVM worker to exit without starving its scheduler.
                WorldStreamer.instance.finished = true;
                worker.join(10000);
                if (worker.isAlive()) throw new IllegalStateException("Original streamer did not exit");
                stage("actual-streamer-exited");
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("Interrupted waiting for original streamer", interrupted);
            } catch (ReflectiveOperationException failure) {
                throw new IllegalStateException("Cannot inspect original streamer thread", failure);
            }
        }

        @Override
        public void close() {
            if (closed) return;
            stage("close-streamer-before");
            if (streamer) {
                awaitStreamerExit();
                WorldStreamer.instance.stop();
                streamer = false;
            }
            stage("close-pathfinding-before");
            if (pathfinding) {
                PolygonalMap2.instance.stop();
                pathfinding = false;
            }
            stage("close-physics-before");
            if (physics) {
                WorldSimulation.instance.destroy();
                physics = false;
            }
            closed = true;
            stage("closed");
        }
    }
}
