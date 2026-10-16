package port.host;

import java.io.FileInputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Arrays;
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

/** Owns the original bounded Challenge1 chunk lifecycle in the browser JVM. */
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
        Session session = new Session();
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
            prewarmStreams();
            // Original IsoWorld boot supports selecting its real Java pathfinding backend.
            DebugOptions.instance.pathfindUseNativeCode.setValue(false);
            PathfindNative.useNativeCode = DebugOptions.instance.pathfindUseNativeCode.getValue();
            PolygonalMap2.instance.init(world.getMetaGrid());
            session.pathfinding = true;

            IsoChunkMap map = cell.getChunkMap(0);
            map.setInitialPos(19, 19);
            int middle = IsoChunkMap.chunkGridWidth / 2;
            // Exact original Bullet.init transport allocation; no desktop library-load success stub.
            Bullet.cmdBuf = ByteBuffer.allocateDirect(4096).order(ByteOrder.LITTLE_ENDIAN);
            WorldSimulation.instance.create();
            session.physics = true;
            WorldStreamer.instance.create();
            session.streamer = true;
            IsoChunk chunk = map.LoadChunkForLater(19, 19, middle, middle);
            if (chunk == null) throw new AssertionError("Original chunk request rejected");
            long end = System.currentTimeMillis() + 20000;
            while (!chunk.loaded && System.currentTimeMillis() < end) {
                map.processAllLoadGridSquare();
                Thread.sleep(10);
            }
            if (!chunk.loaded) throw new AssertionError("Original chunk never completed");
            stage("chunk-loaded");
            stage("physics-upload-before");
            chunk.updatePhysicsForLevel(0);
            stage("physics-upload-after");
            IsoGridSquare square = cell.getGridSquare(153, 158, 0);
            if (square == null) throw new AssertionError("Original square not registered");
            if (square.getFloor() == null) throw new AssertionError("No installed map floor at spawn");
            stage("floor-recalc-before");
            square.RecalcAllWithNeighbours(true);
            stage("floor-recalc-after");
            if (!square.TreatAsSolidFloor()) throw new AssertionError("Original floor absent");
            session.chunk = chunk;
            session.spawnSquare = square;
            stage("session-ready");
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
        private IsoChunk chunk;
        private IsoGridSquare spawnSquare;

        public IsoChunk getChunk() { return chunk; }
        public IsoGridSquare getSpawnSquare() { return spawnSquare; }

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
