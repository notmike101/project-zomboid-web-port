import java.lang.foreign.Arena;
import java.lang.foreign.FunctionDescriptor;
import java.lang.foreign.Linker;
import java.lang.foreign.MemorySegment;
import java.lang.foreign.SymbolLookup;
import java.lang.foreign.ValueLayout;
import java.util.ArrayList;
import java.util.Arrays;

/** Read-only queries of the pinned original DLL after the same original Java calls. */
public final class BulletNativeReference {
    private static long base;

    private static MemorySegment view(long address, long bytes) {
        return MemorySegment.ofAddress(address).reinterpret(bytes);
    }

    private static long pointer(long address) {
        return view(address, 8).get(ValueLayout.ADDRESS, 0).address();
    }

    private static int integer(long address) {
        return view(address, 4).get(ValueLayout.JAVA_INT, 0);
    }

    private static double scalar(long address) {
        return view(address, 8).get(ValueLayout.JAVA_DOUBLE, 0);
    }

    private static double[] aabb(long shape) throws Throwable {
        try (Arena arena = Arena.ofConfined()) {
            MemorySegment transform = arena.allocate(128, 16);
            MemorySegment min = arena.allocate(32, 16);
            MemorySegment max = arena.allocate(32, 16);
            for (int axis = 0; axis < 3; axis++) {
                transform.set(ValueLayout.JAVA_DOUBLE, (axis * 4L + axis) * 8, 1);
            }
            // Observed original compound-add 0x180075990 invokes this exact virtual ABI.
            long function = pointer(pointer(shape) + 8);
            var call = Linker.nativeLinker().downcallHandle(MemorySegment.ofAddress(function),
                FunctionDescriptor.ofVoid(ValueLayout.ADDRESS, ValueLayout.ADDRESS,
                    ValueLayout.ADDRESS, ValueLayout.ADDRESS));
            call.invokeExact(MemorySegment.ofAddress(shape), transform, min, max);
            double[] result = new double[6];
            for (int axis = 0; axis < 3; axis++) {
                result[axis] = min.get(ValueLayout.JAVA_DOUBLE, axis * 8L);
                result[axis + 3] = max.get(ValueLayout.JAVA_DOUBLE, axis * 8L);
            }
            return result;
        }
    }

    public static void record(String stage) throws Throwable {
        if (base == 0) {
            base = SymbolLookup.loaderLookup()
                .find("Java_zombie_core_physics_Bullet_initWorld").orElseThrow().address() - 0xc040;
        }
        if (stage.equals("map0") || stage.equals("overlap") || stage.equals("retained1")
                || stage.equals("empty") || stage.equals("reused")) {
            recordChunks(stage);
        }
        long world = pointer(base + 0x1d5728);
        ArrayList<String> shapes = new ArrayList<>();
        String dynamics = "null";
        if (world != 0) {
            long engine = pointer(world + 8);
            dynamics = Arrays.toString(new double[] {
                scalar(engine + 0x1c0), scalar(engine + 0x1c8), scalar(engine + 0x1d0),
                integer(engine + 0xc)
            });
            long start = pointer(world + 0x868);
            int count = (int)((pointer(world + 0x870) - start) / 8);
            for (int index = 0; index < count; index++) {
                long shape = pointer(start + index * 8L);
                if (shape == 0) continue;
                boolean compound = integer(shape + 8) == 31;
                int children = compound ? integer(shape + 0x1c) : 1;
                ArrayList<String> hulls = new ArrayList<>();
                for (int child = 0; child < children; child++) {
                    long hull = compound ? pointer(pointer(shape + 0x28) + child * 0xa0L + 0x80) : shape;
                    int points = integer(hull + 0xd4);
                    long data = pointer(hull + 0xe0);
                    double[] coordinates = new double[points * 3];
                    for (int point = 0; point < points; point++) {
                        for (int axis = 0; axis < 3; axis++) {
                            coordinates[point * 3 + axis] = scalar(data + point * 32L + axis * 8L);
                        }
                    }
                    hulls.add(Arrays.toString(coordinates));
                }
                shapes.add("{\"index\":" + index + ",\"children\":" + children
                    + ",\"aabb\":" + Arrays.toString(aabb(shape)) + ",\"points\":["
                    + String.join(",", hulls) + "]}");
            }
        }
        System.out.println("BULLET_REFERENCE {\"stage\":\"" + stage + "\",\"dynamics\":"
            + dynamics + ",\"meshes\":[" + String.join(",", shapes) + "]}");
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    /** Reads actual native map pointers/record bytes; no fabricated map counters. */
    private static void recordChunks(String stage) {
        long world = pointer(base + 0x1d5728);
        int[] expectedHeader = {-250, -250, 250, 250, -64000, -64000};
        for (int index = 0; index < expectedHeader.length; index++) {
            check(integer(world + 0x30 + index * 4L) == expectedHeader[index], "Native world header");
        }
        java.util.Map<String, Long> pointers = new java.util.TreeMap<>();
        java.util.List<String> maps = new ArrayList<>();
        int references = 0;
        for (int player = 0; player < 4; player++) {
            long map = pointer(world + 0x48 + player * 8L);
            if (map == 0) continue;
            int minX = integer(map + 4);
            int minY = integer(map + 8);
            int width = integer(map + 12);
            check(integer(map) == player, "Actual player map ID");
            check(integer(map + 16) == Math.max(width / 2 - 1, 0)
                && integer(map + 20) == Math.min(width / 2 + 1, width), "Actual map clipping range");
            maps.add("[" + player + "," + minX + "," + minY + "," + width + "]");
            long rows = pointer(map + 24);
            for (int x = 0; x < width; x++) {
                for (int y = 0; y < width; y++) {
                    long chunk = pointer(pointer(rows + x * 8L) + y * 8L);
                    check(chunk != 0, "Actual nonempty slot");
                    int wx = integer(chunk);
                    int wy = integer(chunk + 4);
                    check(wx == minX + x && wy == minY + y, "Native slot coordinates");
                    check(view(chunk + 24 + player, 1).get(ValueLayout.JAVA_BYTE, 0) == 1, "Actual player ownership");
                    check(integer(chunk + 8) == 0 && integer(chunk + 12) == 0, "Initial original chunk level range");
                    long record = pointer(pointer(chunk + 16));
                    check(pointer(record) == chunk, "Actual geometry record parent");
                    for (int offset = 8; offset < 0x1810; offset++) {
                        check(view(record + offset, 1).get(ValueLayout.JAVA_BYTE, 0) == 0, "Actual initialized geometry storage");
                    }
                    String key = wx + "," + wy;
                    Long previous = pointers.putIfAbsent(key, chunk);
                    check(previous == null || previous.longValue() == chunk, "Actual overlap shares chunk identity");
                    references++;
                }
            }
        }
        int shared = references - pointers.size();
        java.util.List<String> chunks = new ArrayList<>();
        for (var entry : pointers.entrySet()) {
            long chunk = entry.getValue();
            int mask = 0;
            for (int player = 0; player < 4; player++) {
                int flag = view(chunk + 24 + player, 1).get(ValueLayout.JAVA_BYTE, 0);
                check(flag == 0 || flag == 1, "Native ownership byte");
                if (flag != 0) mask |= 1 << player;
            }
            chunks.add("[" + entry.getKey() + "," + mask + "]");
        }
        check(integer(pointer(world + 8) + 12) == 0, "No collision objects before original geometry upload");
        System.out.println("CHUNK_REFERENCE {\"stage\":\"" + stage + "\",\"maps\":["
            + String.join(",", maps) + "],\"chunks\":[" + String.join(",", chunks)
            + "],\"distinct\":" + pointers.size() + ",\"shared\":" + shared + "}");
    }

    public static void main(String[] args) throws Exception {
        BulletQualification.main(new String[] {"native"});
    }
}
