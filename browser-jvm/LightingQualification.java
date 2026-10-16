import java.io.DataInputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import zombie.iso.IsoDirections;
import zombie.iso.LightingJNI;

/** Data-only original JNI qualification; never starts the game or server. */
public final class LightingQualification {
    public static native void report(String json);

    private static void begin(int width, int height, float playerX, float playerY, boolean cleared) {
        LightingJNI.stateBeginUpdate(0, 0, 0, width / 8, height / 8);
        LightingJNI.playerSet(playerX, playerY, 32, 1, 0, false, false, false, false, 0, 20, -0.2f);
        LightingJNI.stateEndFrame(1, 1, 1, 0.1f, 1, 20, 20, cleared, 100, 0);
    }

    private static void chunk(int chunkX, int chunkY, int width, int[] masks, int[] vision) {
        LightingJNI.chunkBeginUpdate(chunkX, chunkY, 32, 32);
        LightingJNI.chunkLevelBeginUpdate(32);
        for (int y = 0; y < 8; y++) {
            for (int x = 0; x < 8; x++) {
                int index = (chunkY * 8 + y) * width + chunkX * 8 + x;
                LightingJNI.squareBeginUpdate(x, y, 32);
                LightingJNI.squareSet(masks[index], false, false, false, vision[index], -1, -1, 0, false);
                LightingJNI.squareSetLightTransmission(
                    1, 1, 1, 0, 0, 1, 1, 1, 0, 0,
                    1, 1, 1, 0, 0, 1, 1, 1, 0, 0);
                LightingJNI.squareEndUpdate();
            }
        }
        LightingJNI.chunkLevelEndUpdate();
        LightingJNI.chunkEndUpdate();
    }

    private static void work(int frame) {
        int spins = 0;
        while (!LightingJNI.WaitingForMain() && spins++ < 100) {
            LightingJNI.DoLightingUpdateNew(1_000_000_000L + frame * 100_000_000L, false);
        }
        if (spins >= 100) {
            throw new AssertionError("bounded lighting worker did not complete");
        }
    }

    private static int[] readSquare(int x, int y) {
        if (LightingJNI.stateUpdateCounter(0) < 1) {
            throw new AssertionError("square storage has not been published by the worker");
        }
        int[] packed = new int[49];
        if (!LightingJNI.getSquareLighting(0, x, y, 32, packed)) {
            throw new AssertionError("native result missing");
        }
        if (LightingJNI.getSquareDirty(0, x, y, 32)) {
            throw new AssertionError("square dirty bit not consumed");
        }
        return packed;
    }

    private static String publishedSquare(int x, int y) {
        // Native allocated storage is uninitialized until the first worker publication.
        return LightingJNI.stateUpdateCounter(0) < 1 ? "unpublished" : Arrays.toString(readSquare(x, y));
    }

    private static void general(String path) throws Exception {
        try (DataInputStream input = new DataInputStream(Files.newInputStream(Path.of(path)))) {
            int count = input.readInt();
            for (int scene = 0; scene < count; scene++) {
                String name = input.readUTF();
                int width = input.readInt();
                int height = input.readInt();
                float playerX = input.readFloat();
                float playerY = input.readFloat();
                int lightCount = input.readInt();
                int[][] lights = new int[lightCount][4];
                float[][] colors = new float[lightCount][3];
                for (int light = 0; light < lightCount; light++) {
                    for (int field = 0; field < 4; field++) {
                        lights[light][field] = input.readInt();
                    }
                    for (int channel = 0; channel < 3; channel++) {
                        colors[light][channel] = input.readFloat();
                    }
                }
                int[] masks = new int[width * height];
                int[] vision = new int[width * height];
                for (int square = 0; square < masks.length; square++) {
                    masks[square] = input.readInt();
                    vision[square] = input.readInt();
                }
                LightingJNI.configure(0.005f);
                try {
                    for (int frame = 0; frame < 10; frame++) {
                        begin(width, height, playerX, playerY, true);
                        for (int chunkY = 0; chunkY < height / 8; chunkY++) {
                            for (int chunkX = 0; chunkX < width / 8; chunkX++) {
                                chunk(chunkX, chunkY, width, masks, vision);
                            }
                        }
                        if (frame == 0) {
                            for (int light = 0; light < lightCount; light++) {
                                int[] point = lights[light];
                                float[] color = colors[light];
                                LightingJNI.addLight(point[0], point[1], point[2], 32, point[3],
                                    color[0], color[1], color[2], -1, true);
                            }
                        }
                        boolean done = LightingJNI.chunkLightingDone(0, 0);
                        LightingJNI.stateEndUpdate();
                        work(frame);
                        System.out.println("FRAME " + name + " " + frame
                            + " counter=" + LightingJNI.stateUpdateCounter(0)
                            + " done=" + done + " dirty=" + LightingJNI.getChunkDirty(0, 0, 0, 32));
                    }
                    for (int y = 0; y < height; y++) {
                        for (int x = 0; x < width; x++) {
                            System.out.println("GRID " + name + " " + x + " " + y
                                + " " + Arrays.toString(readSquare(x, y)));
                        }
                    }
                } finally {
                    LightingJNI.destroy();
                }
            }
            if (input.read() != -1) {
                throw new AssertionError("unexpected fixture input suffix");
            }
        }
    }

    private static int[][] geometry(int width, boolean wall) {
        int[][] result = new int[2][width * 8];
        for (int y = 0; y < 8; y++) {
            for (int x = 0; x < width; x++) {
                int index = y * width + x;
                for (IsoDirections direction : IsoDirections.values()) {
                    if (direction.ordinal() >= 8) {
                        continue;
                    }
                    int adjacentX = x + direction.dx();
                    int adjacentY = y + direction.dy();
                    boolean inside = adjacentX >= 0 && adjacentX < width && adjacentY >= 0 && adjacentY < 8;
                    boolean blocked = wall && (x < 4) != (adjacentX < 4);
                    if (inside && !blocked) {
                        result[0][index] |= 1 << direction.ordinal();
                    } else {
                        result[1][index] |= 1 << direction.dx() + 1 + (direction.dy() + 1) * 3 + 9;
                    }
                }
            }
        }
        return result;
    }

    private static void incremental() {
        LightingJNI.configure(0.005f);
        try {
            for (int frame = 0; frame < 8; frame++) {
                begin(16, 8, 2.5f, 3.5f, frame == 0 || frame == 3);
                if (frame == 0) {
                    int[][] initial = geometry(16, false);
                    chunk(0, 0, 16, initial[0], initial[1]);
                    chunk(1, 0, 16, initial[0], initial[1]);
                    LightingJNI.addLight(1, 6, 4, 32, 10, 0.2f, 1, 0.5f, -1, true);
                }
                if (frame == 3) {
                    int[][] changed = geometry(16, true);
                    chunk(0, 0, 16, changed[0], changed[1]);
                }
                System.out.println("DONE " + frame + " " + LightingJNI.chunkLightingDone(0, 0)
                    + " " + LightingJNI.chunkLightingDone(1, 0));
                LightingJNI.stateEndUpdate();
                work(frame);
                System.out.println("FRAME " + frame + " " + LightingJNI.stateUpdateCounter(0)
                    + " " + LightingJNI.getChunkDirty(0, 0, 0, 32)
                    + " " + LightingJNI.getChunkDirty(0, 1, 0, 32)
                    + " " + LightingJNI.getChunkDirty(0, 0, 0, 32));
                for (int y = 0; y < 8; y++) {
                    for (int x = 0; x < 16; x++) {
                        boolean dirty = LightingJNI.getSquareDirty(0, x, y, 32);
                        String packed = publishedSquare(x, y);
                        System.out.println("CELL " + frame + " " + x + " " + y
                            + " " + dirty + " " + packed);
                    }
                }
            }
        } finally {
            LightingJNI.destroy();
        }
    }

    private static void pendingSnapshot(String stage) {
        if (!stage.equals("activeworker")) {
            LightingJNI.getChunkDirty(0, 0, 0, 32);
            LightingJNI.getChunkDirty(0, 1, 0, 32);
        }
        for (int x : new int[]{2, 6}) {
            boolean dirty = LightingJNI.getSquareDirty(0, x, 3, 32);
            String packed = publishedSquare(x, 3);
            System.out.println("PENDING " + stage + " x=" + x
                    + " counter=" + LightingJNI.stateUpdateCounter(0)
                    + " waiting=" + LightingJNI.WaitingForMain()
                    + " dirty=" + dirty + " " + packed);
        }
    }

    private static void pending(boolean overlap) {
        LightingJNI.configure(0.005f);
        try {
            begin(16, 8, 2.5f, 3.5f, true);
            int[][] initial = geometry(16, false);
            chunk(0, 0, 16, initial[0], initial[1]);
            chunk(1, 0, 16, initial[0], initial[1]);
            LightingJNI.addLight(1, 6, 4, 32, 10, 0.2f, 1, 0.5f, -1, true);
            LightingJNI.stateEndUpdate();
            pendingSnapshot("first");

            begin(16, 8, 2.5f, 3.5f, true);
            int[][] changed = geometry(16, true);
            chunk(0, 0, 16, changed[0], changed[1]);
            if (overlap) {
                LightingJNI.DoLightingUpdateNew(1_000_000_000L, false);
                pendingSnapshot("activeworker");
            }
            LightingJNI.stateEndUpdate();
            pendingSnapshot("second");
            LightingJNI.DoLightingUpdateNew(1_100_000_000L, false);
            pendingSnapshot("worker");

            for (int frame = 2; frame < 5; frame++) {
                begin(16, 8, 2.5f, 3.5f, true);
                LightingJNI.stateEndUpdate();
                pendingSnapshot("end" + frame);
                LightingJNI.DoLightingUpdateNew(1_000_000_000L + frame * 100_000_000L, false);
                pendingSnapshot("worker" + frame);
            }
        } finally {
            LightingJNI.destroy();
        }
    }

    private static void snapshot(int frame, String stage) {
        boolean dirty = LightingJNI.getSquareDirty(0, 2, 3, 32);
        String packed = publishedSquare(2, 3);
        boolean chunkDirty = LightingJNI.getChunkDirty(0, 0, 0, 32);
        boolean again = LightingJNI.getChunkDirty(0, 0, 0, 32);
        System.out.println("PUB " + frame + " " + stage
            + " counter=" + LightingJNI.stateUpdateCounter(0) + " waiting=" + LightingJNI.WaitingForMain()
            + " dirty=" + dirty + " chunk=" + chunkDirty + " again=" + again
            + " " + packed);
    }

    private static void publication() {
        LightingJNI.configure(0.005f);
        int[][] plane = geometry(8, false);
        try {
            for (int frame = 0; frame < 6; frame++) {
                begin(8, 8, 2.5f, 3.5f, true);
                chunk(0, 0, 8, plane[0], plane[1]);
                if (frame == 0) {
                    LightingJNI.addLight(1, 2, 3, 32, 6, 1, 0, 0, -1, true);
                }
                if (frame == 3) {
                    LightingJNI.setLightColor(1, 0, 1, 0);
                }
                System.out.println("DONE " + frame + " " + LightingJNI.chunkLightingDone(0, 0));
                LightingJNI.stateEndUpdate();
                snapshot(frame, "end");
                LightingJNI.DoLightingUpdateNew(1_000_000_000L + frame * 100_000_000L, false);
                snapshot(frame, "worker");
            }
        } finally {
            LightingJNI.destroy();
        }
    }

    private static void verifyJavaFailures() {
        boolean unsupportedCaught = false, lifecycleCaught = false;
        int cleanup = 0;
        try {
            LightingJNI.scrollLeft(0);
        } catch (UnsupportedOperationException expected) {
            unsupportedCaught = expected.getMessage().equals("Unsupported lighting boundary: scrollLeft");
        } finally {
            cleanup++;
        }
        try {
            LightingJNI.stateEndUpdate();
        } catch (IllegalStateException expected) {
            lifecycleCaught = expected.getMessage().equals("LightingJNI: missing stateBeginUpdate");
        } finally {
            cleanup++;
        }
        if (!unsupportedCaught || !lifecycleCaught || cleanup != 2) {
            throw new AssertionError("native failure did not preserve Java catch/finally");
        }
    }

    public static void main(String[] args) throws Exception {
        boolean browser = args[0].equals("browser");
        if (!browser) {
            System.load(args[0]);
        } else {
            boolean missingRejected = false;
            try {
                System.loadLibrary("PortMissingLightingService");
            } catch (UnsatisfiedLinkError expected) {
                missingRejected = true;
            }
            if (!missingRejected) {
                throw new AssertionError("missing native module was accepted");
            }
            if (LightingJNI.init) {
                throw new AssertionError("unexpected prior lighting initialization");
            }
            LightingJNI.init();
            var field = LightingJNI.class.getDeclaredField("updateCounter");
            field.setAccessible(true);
            if (!LightingJNI.init || !Arrays.equals((int[]) field.get(null), new int[]{-1, -1, -1, -1})) {
                throw new AssertionError("original lighting initialization did not complete");
            }
            verifyJavaFailures();
        }
        if (args[1].equals("general")) {
            general(args[2]);
        } else if (args[1].equals("incremental")) {
            incremental();
        } else if (args[1].equals("publication")) {
            publication();
        } else if (args[1].equals("pending") || args[1].equals("overlap")) {
            pending(args[1].equals("overlap"));
        } else {
            throw new IllegalArgumentException("unknown qualification mode");
        }
        if (browser) {
            report("{\"pass\":true,\"originalInitialization\":true,\"javaFailureCleanup\":true}");
        } else {
            System.out.println("PASS lighting qualification " + args[1]);
        }
    }
}
