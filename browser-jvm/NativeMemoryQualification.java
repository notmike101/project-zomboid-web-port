import java.lang.management.BufferPoolMXBean;
import java.lang.management.ManagementFactory;
import java.lang.ref.Reference;
import java.nio.Buffer;
import java.nio.ByteBuffer;
import java.nio.FloatBuffer;
import java.nio.IntBuffer;
import java.util.Map;
import port.host.SpriteGraphics;

/** Authored direct-memory ownership checks; does not load installed game data. */
public final class NativeMemoryQualification {
    private NativeMemoryQualification() { }

    public static native void report(String json);

    public static void main(String[] args) {
        try {
            qualify();
            report("{\"pass\":true,\"allocationBytes\":65536,\"rounds\":4}");
        } catch (Throwable failure) {
            failure.printStackTrace();
            String error = failure.toString().replace("\\", "\\\\").replace("\"", "\\\"")
                    .replace("\n", "\\n").replace("\r", "\\r");
            report("{\"pass\":false,\"error\":\"" + error + "\"}");
        }
    }

    private static void qualify() throws Exception {
        ByteBuffer warm = SpriteGraphics.memAlloc(16);
        SpriteGraphics.memFree(warm);
        BufferPoolMXBean pool = ManagementFactory.getPlatformMXBeans(BufferPoolMXBean.class).stream()
                .filter(candidate -> candidate.getName().equals("direct")).findFirst().orElseThrow();
        long used = pool.getMemoryUsed(), capacity = pool.getTotalCapacity(), count = pool.getCount();
        for (int round = 0; round < 4; round++) {
            ByteBuffer bytes = SpriteGraphics.memAlloc(65536);
            bytes.putInt(0, 123456);
            ByteBuffer alias = bytes.duplicate();
            exact(pool, used + 65536, capacity + 65536, count + 1);
            rejected(() -> SpriteGraphics.memFree(alias));
            exact(pool, used + 65536, capacity + 65536, count + 1);
            SpriteGraphics.memFree(bytes);
            exact(pool, used, capacity, count);
            rejected(() -> SpriteGraphics.memFree(bytes));
            Reference.reachabilityFence(bytes);
            Reference.reachabilityFence(alias);

            FloatBuffer floats = SpriteGraphics.memAllocFloat(16384);
            floats.put(0, 1.25f);
            exact(pool, used + 65536, capacity + 65536, count + 1);
            SpriteGraphics.memFree(floats);
            exact(pool, used, capacity, count);
            rejected(() -> SpriteGraphics.memFree(floats));

            IntBuffer ints = SpriteGraphics.memAllocInt(16384);
            ints.put(0, 123456);
            exact(pool, used + 65536, capacity + 65536, count + 1);
            SpriteGraphics.memFree(ints);
            exact(pool, used, capacity, count);
            rejected(() -> SpriteGraphics.memFree(ints));
        }

        var field = SpriteGraphics.class.getDeclaredField("allocations");
        field.setAccessible(true);
        @SuppressWarnings("unchecked")
        Map<Buffer, ByteBuffer> allocations = (Map<Buffer, ByteBuffer>) field.get(null);
        ByteBuffer retained = SpriteGraphics.memAlloc(64);
        ByteBuffer invalidOwner = ByteBuffer.allocate(64);
        try {
            synchronized (allocations) {
                allocations.put(retained, invalidOwner);
            }
            rejected(() -> SpriteGraphics.memFree(retained));
            synchronized (allocations) {
                if (allocations.get(retained) != invalidOwner) {
                    throw new AssertionError("Failed cleaner discarded allocation ownership");
                }
            }
        } finally {
            synchronized (allocations) {
                allocations.put(retained, retained);
            }
            SpriteGraphics.memFree(retained);
        }
        rejected(() -> SpriteGraphics.memFree(ByteBuffer.allocate(8)));
        SpriteGraphics.memFree((ByteBuffer) null);
        SpriteGraphics.memFree((FloatBuffer) null);
        SpriteGraphics.memFree((IntBuffer) null);
        exact(pool, used, capacity, count);
    }

    private static void exact(BufferPoolMXBean pool, long used, long capacity, long count) {
        if (pool.getMemoryUsed() != used || pool.getTotalCapacity() != capacity || pool.getCount() != count) {
            throw new AssertionError("Direct storage was not allocated or released immediately");
        }
    }

    private static void rejected(Runnable action) {
        try {
            action.run();
            throw new AssertionError("Foreign or released allocation was accepted");
        } catch (IllegalArgumentException expected) {
            // Ownership failures must not invoke the native cleaner.
        }
    }
}
