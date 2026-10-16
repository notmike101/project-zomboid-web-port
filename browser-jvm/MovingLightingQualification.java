import java.util.Arrays;
import zombie.iso.IsoDirections;
import zombie.iso.LightingJNI;

/** Independently authored moving-player and queued-header lighting scenes. */
public final class MovingLightingQualification {
    private static final int ORIGIN_X = 7;
    private static final int ORIGIN_Y = 9;
    private static final long ROOM_TAIL = 12345678901234567L;
    private static final float[][] POSITIONS = {
        {2.5f, 3.5f, 1, 0}, {3.25f, 3.5f, 1, 0}, {7.75f, 3.5f, 1, 0},
        {8.25f, 3.5f, 1, 0}, {11.5f, 3.5f, 0, -1}, {11.5f, 4.25f, -1, 0},
        {8.25f, 4.25f, -1, 0}, {7.75f, 4.25f, -1, 0}, {3.5f, 5.25f, -.6f, .8f}
    };
    private static boolean[] seen;
    private static int[] visibility;
    private static boolean visibilityChanged;
    private static boolean zeroHeaderRejected;

    public static native void report(String json);

    private static boolean linked(int x, int y, int nx, int ny) {
        if (nx < 0 || nx >= 16 || ny < 0 || ny >= 8) return false;
        boolean crosses = x < 8 && nx >= 8 || nx < 8 && x >= 8;
        return !crosses || y == ny && (y == 3 || y == 4);
    }

    private static void geometry() {
        for (int chunk = 0; chunk < 2; chunk++) {
            LightingJNI.chunkBeginUpdate(ORIGIN_X + chunk, ORIGIN_Y, 32, 32);
            LightingJNI.chunkLevelBeginUpdate(32);
            for (int y = 0; y < 8; y++) for (int x = chunk * 8; x < chunk * 8 + 8; x++) {
                int mask = 0, vision = 0;
                for (IsoDirections direction : IsoDirections.values())
                    if (direction.ordinal() < 8 && linked(x, y, x + direction.dx(), y + direction.dy()))
                        mask |= 1 << direction.ordinal();
                for (int dz = -1; dz <= 1; dz++) for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++)
                    if (dz != 0 || !linked(x, y, x + dx, y + dy))
                        vision |= 1 << (dx + 1 + (dy + 1) * 3 + (dz + 1) * 9);
                LightingJNI.squareBeginUpdate(x % 8, y, 32);
                LightingJNI.squareSet(mask, false, false, false, vision, 41, x < 8 ? 101 : 202, 0, false);
                LightingJNI.squareSetLightTransmission(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
                LightingJNI.squareEndUpdate();
            }
            LightingJNI.chunkLevelEndUpdate();
            LightingJNI.chunkEndUpdate();
        }
    }

    private static void headers(int position, int sourceUpdate) {
        float[] point = POSITIONS[position];
        LightingJNI.stateBeginUpdate(0, ORIGIN_X, ORIGIN_Y, 2, 1);
        LightingJNI.playerSet(ORIGIN_X * 8 + point[0], ORIGIN_Y * 8 + point[1], 32, point[2], point[3],
                false, false, false, false, 0, 3.5f, -.8f);
        LightingJNI.stateEndFrame(1, 1, 1, .9f, 0, 32, 40, sourceUpdate == 100, sourceUpdate, 0);
    }

    private static void begin() {
        LightingJNI.configure(.005f);
        seen = new boolean[128];
        visibility = new int[128];
        visibilityChanged = false;
        LightingJNI.addLight(51, ORIGIN_X * 8 + 2, ORIGIN_Y * 8 + 2, 32, 12, 1, .6f, .4f, -1, true);
        LightingJNI.addLight(52, ORIGIN_X * 8 + 13, ORIGIN_Y * 8 + 5, 32, 9, .4f, .7f, 1, -1, true);
        headers(0, 100);
        geometry();
        LightingJNI.stateEndUpdate();
    }

    private static void emptyPublication() {
        LightingJNI.stateBeginUpdate(0, ORIGIN_X, ORIGIN_Y, 2, 1);
        LightingJNI.stateEndUpdate();
    }

    private static void readback(int scenario, int frame) {
        int counter = LightingJNI.stateUpdateCounter(0);
        System.out.println("MOVING FRAME " + scenario + " " + frame + " " + counter + " " + LightingJNI.WaitingForMain());
        if (counter == 0) return;
        for (int chunk = 0; chunk < 2; chunk++)
            System.out.println("MOVING CHUNK " + scenario + " " + frame + " " + chunk + " "
                    + LightingJNI.getChunkDirty(0, ORIGIN_X + chunk, ORIGIN_Y, 32) + " "
                    + LightingJNI.getChunkDirty(0, ORIGIN_X + chunk, ORIGIN_Y, 32));
        for (int y = 0; y < 8; y++) for (int x = 0; x < 16; x++) {
            int[] words = new int[49];
            Arrays.fill(words, 123);
            boolean dirty = LightingJNI.getSquareDirty(0, ORIGIN_X * 8 + x, ORIGIN_Y * 8 + y, 32);
            boolean ok = LightingJNI.getSquareLighting(0, ORIGIN_X * 8 + x, ORIGIN_Y * 8 + y, 32, words);
            boolean after = LightingJNI.getSquareDirty(0, ORIGIN_X * 8 + x, ORIGIN_Y * 8 + y, 32);
            if (!ok || after) throw new AssertionError("Published readback contract");
            int index = y * 16 + x;
            if (seen[index] && (words[0] & 1) == 0) throw new AssertionError("Seen history was lost");
            if (counter > 1 && visibility[index] != (words[0] & 6)) visibilityChanged = true;
            seen[index] = (words[0] & 1) != 0;
            visibility[index] = words[0] & 6;
            System.out.println("MOVING CELL " + scenario + " " + frame + " " + x + " " + y + " "
                    + dirty + " " + ok + " " + after + " " + Arrays.toString(words));
        }
        int count = LightingJNI.getVisibleRoomCount(0);
        long[] rooms = new long[count + 2];
        Arrays.fill(rooms, ROOM_TAIL);
        if (LightingJNI.getVisibleRooms(0, rooms) != count || rooms[count] != ROOM_TAIL || rooms[count + 1] != ROOM_TAIL)
            throw new AssertionError("Visible room count or array tail changed");
        System.out.println("MOVING ROOMS " + scenario + " " + frame + " " + count + " " + Arrays.toString(rooms));
    }

    private static void moving() {
        begin();
        try {
            readback(0, 0);
            for (int position = 0; position < POSITIONS.length; position++) {
                LightingJNI.DoLightingUpdateNew(1_000_000_000L + position * 100_000_000L, true);
                if (position + 1 < POSITIONS.length) {
                    headers(position + 1, 0);
                    LightingJNI.stateEndUpdate();
                } else emptyPublication();
                readback(0, position + 1);
            }
            if (!visibilityChanged) throw new AssertionError("Moving fixture did not change current visibility");
        } finally { LightingJNI.destroy(); }
    }

    private static void rejectZeroHeaderWithoutInvalidation(boolean browser, int counter) {
        if (!browser) return;
        try {
            LightingJNI.DoLightingUpdateNew(3_000_000_000L, false);
            throw new AssertionError("Zero source header accepted without global invalidation");
        } catch (UnsupportedOperationException expected) {
            if (!expected.getMessage().contains("source update without global invalidation")) throw expected;
        }
        if (LightingJNI.stateUpdateCounter(0) != counter || LightingJNI.WaitingForMain())
            throw new AssertionError("Rejected worker changed publication or readiness");
        zeroHeaderRejected = true;
    }

    private static void pending(boolean browser) {
        begin();
        try {
            headers(3, 0);
            LightingJNI.stateEndUpdate();
            LightingJNI.DoLightingUpdateNew(2_000_000_000L, true);
            emptyPublication();
            readback(1, 1);
            rejectZeroHeaderWithoutInvalidation(browser, 1);
            headers(6, 100);
            rejectZeroHeaderWithoutInvalidation(browser, 1);
            LightingJNI.DoLightingUpdateNew(2_100_000_000L, true);
            LightingJNI.stateEndUpdate();
            readback(1, 2);
            LightingJNI.DoLightingUpdateNew(2_200_000_000L, false);
            emptyPublication();
            readback(1, 3);
            headers(8, 0);
            LightingJNI.stateEndUpdate();
            // A deferred zero header must not replace the current worker's positive source header.
            LightingJNI.DoLightingUpdateNew(2_300_000_000L, false);
            emptyPublication();
            readback(1, 4);
            rejectZeroHeaderWithoutInvalidation(browser, 4);
            LightingJNI.DoLightingUpdateNew(2_400_000_000L, true);
            emptyPublication();
            readback(1, 5);
            if (browser) {
                headers(0, 100);
                try {
                    LightingJNI.playerSet(ORIGIN_X * 8 + 2.5f, ORIGIN_Y * 8 + 3.5f, 33, 1, 0,
                            false, false, false, false, 0, 3.5f, -.8f);
                    throw new AssertionError("Unqualified player level transition accepted");
                } catch (UnsupportedOperationException expected) {
                    if (!expected.getMessage().contains("moving-player level transition")) throw expected;
                }
                LightingJNI.playerSet(ORIGIN_X * 8 + .5f, ORIGIN_Y * 8 + .5f, 32, 1, 0,
                        false, false, false, false, 0, 3.5f, -.8f);
                LightingJNI.chunkBeginUpdate(ORIGIN_X, ORIGIN_Y, 32, 32);
                LightingJNI.chunkLevelBeginUpdate(32);
                LightingJNI.squareSetNull(0, 0, 32);
                LightingJNI.chunkLevelEndUpdate();
                LightingJNI.chunkEndUpdate();
                try {
                    LightingJNI.stateEndUpdate();
                    throw new AssertionError("Player on absent square accepted");
                } catch (UnsupportedOperationException expected) {
                    if (!expected.getMessage().contains("player on absent square")) throw expected;
                }
                if (LightingJNI.stateUpdateCounter(0) != 5 || LightingJNI.WaitingForMain())
                    throw new AssertionError("Absent-player failure changed publication or readiness");
            }
        } finally { LightingJNI.destroy(); }
    }

    public static void main(String[] args) {
        boolean browser = args[0].equals("browser");
        if (browser) {
            try {
                System.loadLibrary("PortMissingMovingLightingService");
                throw new AssertionError("Unknown native library accepted");
            } catch (UnsatisfiedLinkError expected) { }
            LightingJNI.init();
            if (!LightingJNI.init) throw new AssertionError("Original initialization failed");
        } else System.load(args[0]);
        try {
            moving();
            pending(browser);
        } finally { LightingJNI.stop(); }
        if (LightingJNI.stateUpdateCounter(0) != -1 || LightingJNI.getVisibleRoomCount(0) != 0)
            throw new AssertionError("Original stop retained state");
        if (browser) report("{\"pass\":true,\"originalInitialization\":true,\"javaFailureCleanup\":"
                + zeroHeaderRejected + ",\"originalStop\":true}");
    }
}
