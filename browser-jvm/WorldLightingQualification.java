import zombie.iso.LightingJNI;
import zombie.iso.IsoDirections;
import java.util.Arrays;

/** Authored synthetic topology; contains no installed map geometry or captured JNI data. */
public final class WorldLightingQualification {
    private static final int REGION_X = 5;
    private static final int REGION_Y = 6;
    private static final int OFFSET = 4;
    private static final int WIDTH = 24;
    private static final long ROOM_TAIL = 12345678901234567L;
    private static final int[][] LIGHTS = {{2, 3, 32}, {18, 7, 32}, {19, 18, 33}, {5, 20, 34}, {11, 9, 32}, {13, 13, 33}};

    public static native void report(String json);

    private static boolean present(int x, int y, int z) {
        return x >= 0 && x < WIDTH && y >= 0 && y < WIDTH && z >= 32 && z <= 34
                && (x * 13 + y * 7 + z) % 127 != 0;
    }

    private static boolean crossesWall(int x, int nx) {
        return x < 12 && nx >= 12 || nx < 12 && x >= 12;
    }

    private static boolean linked(int x, int y, int z, int nx, int ny, int nz) {
        if (!present(nx, ny, nz)) return false;
        if (nz != z) return (x + y) % 7 != 0;
        return !crossesWall(x, nx);
    }

    private static void square(int profile, int x, int y, int z) {
        if (!present(x, y, z)) {
            LightingJNI.squareSetNull(x % 8, y % 8, z);
            return;
        }
        int mask = 0;
        int vision = 0;
        for (IsoDirections direction : IsoDirections.values()) {
            if (direction.ordinal() < 8 && linked(x, y, z, x + direction.dx(), y + direction.dy(), z)) {
                mask |= 1 << direction.ordinal();
            }
        }
        for (int dz = -1; dz <= 1; dz++) for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
            boolean blocked = !linked(x, y, z, x + dx, y + dy, z + dz);
            // Door/window openings leave their LOS classification to the real native object contract.
            if (dz == 0 && (y == 9 || y == 14) && dy == 0 && crossesWall(x, x + dx)
                    && present(x + dx, y, z)) blocked = false;
            if (blocked) vision |= 1 << (dx + 1 + (dy + 1) * 3 + (dz + 1) * 9);
        }
        boolean openAir = x < 12 || z == 34;
        long room = openAir ? -1 : z == 32 ? 111 : 9007199254740995L;
        boolean up = linked(x, y, z, x, y, z + 1);
        boolean down = linked(x, y, z, x, y, z - 1);
        LightingJNI.squareBeginUpdate(x % 8, y % 8, z);
        LightingJNI.squareSet(mask, up, down, false, vision, room == -1 ? -1 : 77, room, openAir ? 0xffffff : 0, openAir);
        float[] transmission = new float[20];
        if (x == 12 && y == 9 && profile != 1) transmission[3] = .15f;
        if (x == 12 && y == 14 && profile == 0) transmission[3] = .65f;
        if (x == 12 && y == 14 && profile == 2) {
            transmission[3] = .55f;
            transmission[0] = .2f;
            transmission[1] = .65f;
            transmission[2] = .8f;
            transmission[4] = .15f;
        }
        if (x == 11 && y == 14 && profile == 2) {
            transmission[10] = .9f;
            transmission[11] = .15f;
            transmission[12] = .4f;
            transmission[13] = .7f;
            transmission[14] = .2f;
        }
        LightingJNI.squareSetLightTransmission(
                transmission[0], transmission[1], transmission[2], transmission[3], transmission[4],
                transmission[5], transmission[6], transmission[7], transmission[8], transmission[9],
                transmission[10], transmission[11], transmission[12], transmission[13], transmission[14],
                transmission[15], transmission[16], transmission[17], transmission[18], transmission[19]);
        if (x == 12 && y == 9) LightingJNI.squareAddDoor(false, false, false);
        if (x == 12 && y == 14) {
            LightingJNI.squareAddWindow(false, false, false);
            LightingJNI.squareAddCurtain(4, true);
        }
        LightingJNI.squareEndUpdate();
    }

    private static void geometry(int profile) {
        for (int cy = 0; cy < 3; cy++) for (int cx = 0; cx < 3; cx++) {
            LightingJNI.chunkBeginUpdate(REGION_X + OFFSET + cx, REGION_Y + OFFSET + cy, 32, 34);
            for (int z = 32; z <= 34; z++) {
                LightingJNI.chunkLevelBeginUpdate(z);
                for (int y = cy * 8; y < cy * 8 + 8; y++) for (int x = cx * 8; x < cx * 8 + 8; x++) {
                    square(profile, x, y, z);
                }
                LightingJNI.chunkLevelEndUpdate();
            }
            LightingJNI.chunkEndUpdate();
        }
    }

    private static void headers(int profile) {
        LightingJNI.stateBeginUpdate(0, REGION_X, REGION_Y, 13, 13);
        LightingJNI.playerSet((REGION_X + OFFSET) * 8 + 9.5f, (REGION_Y + OFFSET) * 8 + 11.5f, 32,
                profile == 0 ? -1 : .6f, profile == 0 ? 0 : .8f, false, false, false, false, 0,
                profile == 0 ? 3.5f : 5.75f, profile == 0 ? -.8f : .25f);
        LightingJNI.stateEndFrame(profile == 0 ? 1 : .35f, profile == 0 ? 1 : .67f, profile == 0 ? 1 : .13f,
                profile == 0 ? .9f : .25f, profile == 0 ? 0 : .5f, 66, 80, true, 100,
                profile == 0 ? 0xffffff : profile == 1 ? 0xaccfe1 : 0);
    }

    private static void readback(int profile, int frame, boolean browser) {
        System.out.println("WORLD FRAME " + profile + " " + frame + " " + LightingJNI.stateUpdateCounter(0)
                + " " + LightingJNI.WaitingForMain());
        for (int cy = 0; cy < 3; cy++) for (int cx = 0; cx < 3; cx++) for (int z = 32; z <= 34; z++) {
            int worldX = REGION_X + OFFSET + cx, worldY = REGION_Y + OFFSET + cy;
            System.out.println("WORLD CHUNK " + profile + " " + frame + " " + cx + " " + cy + " " + z + " "
                    + LightingJNI.getChunkDirty(0, worldX, worldY, z) + " " + LightingJNI.getChunkDirty(0, worldX, worldY, z));
        }
        for (int z = 32; z <= 34; z++) for (int y = 0; y < WIDTH; y++) for (int x = 0; x < WIDTH; x++) {
            if (!present(x, y, z)) continue;
            int worldX = (REGION_X + OFFSET) * 8 + x, worldY = (REGION_Y + OFFSET) * 8 + y;
            int[] words = new int[49];
            Arrays.fill(words, 123);
            boolean dirty = LightingJNI.getSquareDirty(0, worldX, worldY, z);
            boolean ok = LightingJNI.getSquareLighting(0, worldX, worldY, z, words);
            boolean after = LightingJNI.getSquareDirty(0, worldX, worldY, z);
            if (!ok || after) throw new AssertionError("published square readback");
            System.out.println("WORLD CELL " + profile + " " + frame + " " + x + " " + y + " " + z
                    + " " + dirty + " " + ok + " " + after + " " + Arrays.toString(words));
        }
        int count = LightingJNI.getVisibleRoomCount(0);
        long[] rooms = new long[count + 2];
        Arrays.fill(rooms, ROOM_TAIL);
        int written = LightingJNI.getVisibleRooms(0, rooms);
        if (count != written || rooms[count] != ROOM_TAIL || rooms[count + 1] != ROOM_TAIL) {
            throw new AssertionError("room output tail");
        }
        System.out.println("WORLD ROOMS " + profile + " " + frame + " " + count + " " + Arrays.toString(rooms));
        if (browser && count > 0) {
            try {
                LightingJNI.getVisibleRooms(0, new long[0]);
                throw new AssertionError("small room array accepted");
            } catch (IllegalArgumentException expected) {
                if (!expected.getMessage().contains("too small")) throw expected;
            }
        }
    }

    private static void scenario(int profile, boolean browser) {
        LightingJNI.configure(.005f);
        try {
            for (int i = 0; i < LIGHTS.length; i++) {
                int[] p = LIGHTS[i];
                if (!present(p[0], p[1], p[2])) throw new AssertionError("authored lamp on absent square");
                LightingJNI.addLight(i + 11, (REGION_X + OFFSET) * 8 + p[0], (REGION_Y + OFFSET) * 8 + p[1],
                        p[2], 8 + i, .25f + i * .1f, .7f, 1, -1, true);
            }
            headers(profile);
            geometry(profile);
            LightingJNI.stateEndUpdate();
            for (int frame = 1; frame <= 3; frame++) {
                LightingJNI.DoLightingUpdateNew(900000000L + frame * 100000000L, false);
                headers(profile);
                LightingJNI.stateEndUpdate();
                readback(profile, frame, browser);
            }
        } finally {
            LightingJNI.destroy();
        }
    }

    private static void pendingHeaders(boolean browser) {
        LightingJNI.configure(.005f);
        try {
            LightingJNI.stateBeginUpdate(0, 0, 0, 1, 1);
            LightingJNI.playerSet(3.5f, 3.5f, 32, 1, 0, false, false, false, false, 0, 20, -.2f);
            LightingJNI.stateEndFrame(1, 1, 1, .9f, 0, 20, 20, true, 100, 0xffffff);
            LightingJNI.chunkBeginUpdate(0, 0, 32, 32);
            LightingJNI.chunkLevelBeginUpdate(32);
            for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++) {
                LightingJNI.squareBeginUpdate(x, y, 32);
                LightingJNI.squareSet(255, false, false, false, 0, -1, -1, 0xffffff, true);
                LightingJNI.squareSetLightTransmission(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
                LightingJNI.squareEndUpdate();
            }
            LightingJNI.chunkLevelEndUpdate();
            LightingJNI.chunkEndUpdate();
            LightingJNI.stateEndUpdate();
            // This genuine second main write must survive while the first worker buffer is pending.
            LightingJNI.stateBeginUpdate(0, 0, 0, 1, 1);
            LightingJNI.playerSet(3.5f, 3.5f, 32, -1, 0, false, false, false, false, 0, 3.5f, -.8f);
            LightingJNI.stateEndFrame(1, 1, 1, .7f, 0, 20, 20, true, 100, 0x707070);
            LightingJNI.stateEndUpdate();
            for (int frame = 1; frame <= 2; frame++) {
                LightingJNI.DoLightingUpdateNew(900000000L + frame * 100000000L, false);
                LightingJNI.stateBeginUpdate(0, 0, 0, 1, 1);
                LightingJNI.stateEndUpdate();
                System.out.println("WORLD FRAME 3 " + frame + " " + LightingJNI.stateUpdateCounter(0)
                        + " " + LightingJNI.WaitingForMain());
                System.out.println("WORLD CHUNK 3 " + frame + " 0 0 32 " + LightingJNI.getChunkDirty(0, 0, 0, 32)
                        + " " + LightingJNI.getChunkDirty(0, 0, 0, 32));
                for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++) {
                    int[] words = new int[49];
                    Arrays.fill(words, 123);
                    boolean dirty = LightingJNI.getSquareDirty(0, x, y, 32);
                    boolean ok = LightingJNI.getSquareLighting(0, x, y, 32, words);
                    boolean after = LightingJNI.getSquareDirty(0, x, y, 32);
                    if (!ok || after) throw new AssertionError("pending header readback");
                    System.out.println("WORLD CELL 3 " + frame + " " + x + " " + y + " 32 " + dirty + " "
                            + ok + " " + after + " " + Arrays.toString(words));
                }
                long[] rooms = {ROOM_TAIL, ROOM_TAIL};
                int count = LightingJNI.getVisibleRoomCount(0);
                if (LightingJNI.getVisibleRooms(0, rooms) != count) throw new AssertionError("pending room count");
                System.out.println("WORLD ROOMS 3 " + frame + " " + count + " " + Arrays.toString(rooms));
            }
            if (browser) {
                LightingJNI.stateBeginUpdate(0, 0, 0, 1, 1);
                LightingJNI.playerSet(3.5f, 3.5f, 32, -1, 0, false, false, false, false, 0, 3.5f, -.8f);
                LightingJNI.stateEndFrame(1, 1, 1, .7f, 0, 20, 20, false, 100, 0x707070);
                LightingJNI.chunkBeginUpdate(0, 0, 32, 32);
                LightingJNI.chunkLevelBeginUpdate(32);
                LightingJNI.squareBeginUpdate(3, 3, 32);
                LightingJNI.squareSet(255, false, false, true, 0, -1, -1, 0xffffff, true);
                LightingJNI.squareSetLightTransmission(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
                LightingJNI.squareEndUpdate();
                LightingJNI.chunkLevelEndUpdate();
                LightingJNI.chunkEndUpdate();
                try {
                    LightingJNI.stateEndUpdate();
                    throw new AssertionError("changed ray geometry accepted without invalidation");
                } catch (UnsupportedOperationException expected) {
                    if (!expected.getMessage().contains("LOS invalidation")) throw expected;
                }
                if (LightingJNI.stateUpdateCounter(0) != 2) throw new AssertionError("failure changed publication");
            }
        } finally {
            LightingJNI.destroy();
        }
    }

    public static void main(String[] args) throws Exception {
        boolean browser = args[0].equals("browser");
        if (browser) {
            try {
                System.loadLibrary("PortMissingWorldLightingService");
                throw new AssertionError("missing library accepted");
            } catch (UnsatisfiedLinkError expected) {}
            LightingJNI.init();
            if (!LightingJNI.init) throw new AssertionError("original initialization failed");
        } else System.load(args[0]);
        try {
            scenario(0, browser);
            scenario(1, browser);
            scenario(2, browser);
            pendingHeaders(browser);
            if (browser) {
                try {
                    LightingJNI.updateTorch(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, false, 0, 0);
                    throw new AssertionError("unsupported torch accepted");
                } catch (UnsupportedOperationException expected) {
                    if (!expected.getMessage().contains("updateTorch")) throw expected;
                }
            }
        } finally {
            LightingJNI.stop();
        }
        if (LightingJNI.stateUpdateCounter(0) != -1 || LightingJNI.getVisibleRoomCount(0) != 0) {
            throw new AssertionError("stop retained native state");
        }
        if (browser) report("{\"pass\":true,\"originalInitialization\":true,\"javaFailureCleanup\":true,\"originalStop\":true}");
    }
}
