import zombie.iso.LightingJNI;
import zombie.iso.IsoDirections;
import java.util.Arrays;

/** Authored data-only transport through the unchanged original lighting declarations. */
public final class LightingVerticalQualification {
    public static native void report(String json);
    private static int width;
    private static int height;
    private static int origin;

    private static boolean edge(int x, int y, int z, int nx, int ny, int nz) {
        if (nx < 0 || nx >= width || ny < 0 || ny >= height || nz < 32 || nz > 34) return false;
        int a = (z - 32) * width * height + y * width + x;
        int b = (nz - 32) * width * height + ny * width + nx;
        return (Math.min(a, b) * 31 + Math.max(a, b) * 17 + 19) % 7 != 0;
    }

    private static boolean varied(String kind) {
        return kind.equals("geometry") || kind.equals("world");
    }

    private static void square(String kind, int x, int y, int z) {
        if (kind.equals("null") && x == 3 && y == 3 && z == 33) {
            LightingJNI.squareSetNull(x % 8, y % 8, z);
            return;
        }
        int mask = 0, vision = 0;
        for (IsoDirections direction : IsoDirections.values()) {
            if (direction.ordinal() >= 8) continue;
            int nx = x + direction.dx(), ny = y + direction.dy();
            if (nx >= 0 && nx < width && ny >= 0 && ny < height
                    && (!varied(kind) || edge(x, y, z, nx, ny, z))) mask |= 1 << direction.ordinal();
        }
        boolean hole = !kind.equals("closed") && !kind.equals("stairs-blocked")
                && (!(kind.equals("hole") || kind.equals("stairs-hole")) || x == 4 && y == 4);
        boolean up = hole && z < 34 && !kind.equals("down");
        boolean down = hole && z > 32 && !kind.equals("up");
        if (varied(kind)) {
            up = edge(x, y, z, x, y, z + 1);
            down = edge(x, y, z, x, y, z - 1);
        }
        if (kind.equals("origin")) {
            up = z < 34 && (x + y + 288) % 7 != 0;
            down = z > 32 && (x + y + 288) % 7 != 0;
        }
        boolean stairs = kind.startsWith("stairs") && x == 4 && y == 4;
        for (int dz = -1; dz <= 1; dz++) for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
            boolean blocked = x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height
                    || z + dz < 32 || z + dz > 34 || dz > 0 && !up || dz < 0 && !down;
            if (varied(kind)) blocked = !edge(x, y, z, x + dx, y + dy, z + dz);
            if (blocked) vision |= 1 << (dx + 1 + (dy + 1) * 3 + (dz + 1) * 9);
        }
        LightingJNI.squareBeginUpdate(x % 8, y % 8, z);
        LightingJNI.squareSet(mask, up, down, stairs, vision, -1, -1, 0, false);
        LightingJNI.squareSetLightTransmission(
                1, 1, 1, 0, 0, 1, 1, 1, 0, 0,
                1, 1, 1, 0, 0, 1, 1, 1, 0, 0);
        LightingJNI.squareEndUpdate();
    }

    private static void geometry(String kind) {
        for (int cy = 0; cy < height / 8; cy++) for (int cx = 0; cx < width / 8; cx++) {
            LightingJNI.chunkBeginUpdate(cx + origin, cy + origin, 32, 34);
            for (int z = 32; z <= 34; z++) {
                LightingJNI.chunkLevelBeginUpdate(z);
                for (int y = cy * 8; y < cy * 8 + 8; y++) for (int x = cx * 8; x < cx * 8 + 8; x++) {
                    square(kind, x, y, z);
                }
                LightingJNI.chunkLevelEndUpdate();
            }
            LightingJNI.chunkEndUpdate();
        }
    }

    private static void scenario(String kind, int lightZ, int playerZ) {
        width = kind.equals("world") || kind.equals("origin") ? 24 : 8;
        height = width;
        origin = kind.equals("origin") ? 18 : 0;
        LightingJNI.configure(.005f);
        try {
            for (int frame = 0; frame < 3; frame++) {
                LightingJNI.stateBeginUpdate(0, origin, origin, width / 8, height / 8);
                LightingJNI.playerSet(origin * 8 + (origin != 0 ? 9.5f : width == 24 ? 12.5f : 2.5f),
                        origin * 8 + (origin != 0 ? 14.5f : width == 24 ? 11.5f : 3.5f),
                        playerZ, 1, 0, false, false, false, false, 0, 20, -.2f);
                LightingJNI.stateEndFrame(1, 1, 1, .1f, 1, 20, 20, true, 100, 0);
                if (frame == 0) {
                    geometry(kind);
                    if (origin != 0) {
                        LightingJNI.addLight(1, 152, 162, lightZ, 9, 1, .7843137383460999f, .6274510025978088f, -1, true);
                    } else {
                        LightingJNI.addLight(1, width == 24 ? 19 : 4, width == 24 ? 12 : 4,
                                lightZ, width == 24 ? 14 : 10, .2f, 1, .5f, -1, true);
                    }
                    if (kind.equals("many")) {
                        int[][] positions = {{0, 0, 32}, {7, 7, 34}, {0, 7, 33}, {7, 0, 32}, {3, 3, 34}, {2, 5, 33}};
                        for (int i = 0; i < positions.length; i++) {
                            int[] position = positions[i];
                            LightingJNI.addLight(i + 2, position[0], position[1], position[2], 8 + i,
                                    .3f + i * .05f, .4f, .8f, -1, true);
                        }
                    }
                }
                LightingJNI.stateEndUpdate();
                LightingJNI.DoLightingUpdateNew(1_000_000_000L + frame * 100_000_000L, false);
            }
            for (int cy = 0; cy < height / 8; cy++) for (int cx = 0; cx < width / 8; cx++) for (int z = 32; z <= 34; z++) {
                boolean dirty = LightingJNI.getChunkDirty(0, cx + origin, cy + origin, z);
                boolean repeated = LightingJNI.getChunkDirty(0, cx + origin, cy + origin, z);
                System.out.println("VRANGE " + kind + " " + lightZ + " " + playerZ + " " + cx + " " + cy + " " + z
                        + " " + LightingJNI.stateUpdateCounter(0) + " " + LightingJNI.WaitingForMain() + " " + dirty + " " + repeated);
            }
            for (int z = 32; z <= 34; z++) for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) {
                // Native absent-square readback storage is unspecified; only real grid squares are consumed by Java.
                if (kind.equals("null") && x == 3 && y == 3 && z == 33) continue;
                int[] words = new int[49];
                boolean dirty = LightingJNI.getSquareDirty(0, x + origin * 8, y + origin * 8, z);
                boolean ok = LightingJNI.getSquareLighting(0, x + origin * 8, y + origin * 8, z, words);
                System.out.println("VERTICAL " + kind + " " + lightZ + " " + playerZ + " " + x + " " + y + " " + z
                        + " " + dirty + " " + ok + " " + Arrays.toString(words));
            }
        } finally {
            LightingJNI.destroy();
        }
    }

    private static void verifyInitialization() throws Exception {
        boolean missingRejected = false;
        try {
            System.loadLibrary("PortMissingLightingService");
        } catch (UnsatisfiedLinkError expected) {
            missingRejected = true;
        }
        if (!missingRejected || LightingJNI.init) throw new AssertionError("invalid initial library state");
        LightingJNI.init();
        var counters = LightingJNI.class.getDeclaredField("updateCounter");
        counters.setAccessible(true);
        if (!LightingJNI.init || !Arrays.equals((int[]) counters.get(null), new int[]{-1, -1, -1, -1})) {
            throw new AssertionError("original initialization failed");
        }
        int cleanup = 0;
        try {
            LightingJNI.updateTorch(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, false, 0, 0);
            throw new AssertionError("unsupported torch accepted");
        } catch (UnsupportedOperationException expected) {
            if (!expected.getMessage().contains("updateTorch")) throw expected;
        } finally {
            cleanup++;
        }
        if (cleanup != 1) throw new AssertionError("Java failure skipped cleanup");
    }

    public static void main(String[] args) throws Exception {
        boolean browser = args[0].equals("browser");
        if (browser) verifyInitialization(); else System.load(args[0]);
        try {
            for (String kind : new String[]{"closed", "open", "hole", "down", "stairs", "many", "geometry", "world", "null"}) {
                scenario(kind, 33, 32);
            }
            scenario("up", 32, 32);
            scenario("open", 32, 34);
            scenario("stairs-hole", 33, 34);
            scenario("stairs-blocked", 33, 34);
            scenario("origin", 32, 32);
        } finally {
            LightingJNI.stop();
        }
        if (browser) report("{\"pass\":true,\"originalInitialization\":true,\"javaFailureCleanup\":true,\"originalStop\":true}");
    }
}
