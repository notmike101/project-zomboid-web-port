import java.lang.management.BufferPoolMXBean;
import java.lang.management.ManagementFactory;
import java.lang.ref.Reference;
import java.nio.Buffer;
import java.nio.ByteBuffer;
import java.nio.FloatBuffer;
import java.nio.IntBuffer;
import java.nio.ShortBuffer;
import java.nio.ByteOrder;
import java.nio.InvalidMarkException;
import java.util.Map;
import port.host.SpriteGraphics;

/** Authored direct-memory ownership checks; does not load installed game data. */
public final class NativeMemoryQualification {
    private NativeMemoryQualification() { }

    public static native void report(String json);

    public static void main(String[] args) {
        try {
            qualify();
            String result = "{\"pass\":true,\"allocationBytes\":65536,\"rounds\":4,\"typedReallocation\":true,\"originalWorldMapCell\":true}";
            if (args.length == 1 && args[0].equals("jvm")) System.out.println(result);
            else report(result);
        } catch (Throwable failure) {
            failure.printStackTrace();
            if (args.length == 1 && args[0].equals("jvm")) throw new AssertionError(failure);
            String error = failure.toString().replace("\\", "\\\\").replace("\"", "\\\"")
                    .replace("\n", "\\n").replace("\r", "\\r");
            report("{\"pass\":false,\"error\":\"" + error + "\"}");
        }
    }

    private static void qualify() throws Exception {
        ByteBuffer warm = SpriteGraphics.memAlloc(16);
        SpriteGraphics.memFree(warm);
        new zombie.worldMap.WorldMapCell().dispose();
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
        typedReallocation();
        failedReallocation(allocations);
        originalCell();
        exact(pool, used, capacity, count);
    }

    private static void failedReallocation(Map<Buffer, ByteBuffer> allocations) {
        FloatBuffer retained = SpriteGraphics.memAllocFloat(4);
        retained.put(0, -7.5f);
        ByteBuffer actualOwner = allocations.get(retained);
        ByteBuffer invalidOwner = ByteBuffer.allocate(16);
        try {
            synchronized (allocations) { allocations.put(retained, invalidOwner); }
            rejected(() -> SpriteGraphics.memRealloc(retained, 8));
            if (allocations.get(retained) != invalidOwner || retained.get(0) != -7.5f)
                throw new AssertionError("Failed replacement discarded the original allocation");
        } finally {
            synchronized (allocations) { allocations.put(retained, actualOwner); }
            SpriteGraphics.memFree(retained);
        }
    }

    private static void typedReallocation() {
        ShortBuffer old = org.lwjgl.system.MemoryUtil.memRealloc((ShortBuffer) null, 4);
        short[] expected = {-32768, -1, 1234, 32767};
        old.put(expected).position(2).limit(3).mark();
        ShortBuffer grown = org.lwjgl.system.MemoryUtil.memRealloc(old, 7);
        state(grown, 7, 2);
        if (grown.order() != ByteOrder.nativeOrder()) throw new AssertionError("Short order changed");
        for (int index = 0; index < expected.length; index++)
            if (grown.get(index) != expected[index]) throw new AssertionError("Short capacity prefix changed");
        try { grown.reset(); throw new AssertionError("Reallocation retained old mark"); }
        catch (InvalidMarkException expectedFailure) { }
        rejected(() -> org.lwjgl.system.MemoryUtil.memFree(old));
        rejected(() -> org.lwjgl.system.MemoryUtil.memRealloc(grown.duplicate(), 8));
        rejected(() -> org.lwjgl.system.MemoryUtil.memRealloc(grown.slice(), 8));
        rejected(() -> org.lwjgl.system.MemoryUtil.memRealloc(grown.asReadOnlyBuffer(), 8));
        rejected(() -> org.lwjgl.system.MemoryUtil.memRealloc(grown, -1));
        unsupported(() -> org.lwjgl.system.MemoryUtil.memAllocShort(Integer.MAX_VALUE));
        unsupported(() -> org.lwjgl.system.MemoryUtil.memRealloc(grown, Integer.MAX_VALUE));
        state(grown, 7, 2);
        ShortBuffer shrunk = org.lwjgl.system.MemoryUtil.memRealloc(grown, 1);
        state(shrunk, 1, 1);
        if (shrunk.get(0) != expected[0]) throw new AssertionError("Shrink discarded prefix");
        ShortBuffer empty = org.lwjgl.system.MemoryUtil.memRealloc(shrunk, 0);
        state(empty, 0, 0);
        org.lwjgl.system.MemoryUtil.memFree(empty);
        org.lwjgl.system.MemoryUtil.memFree((ShortBuffer) null);

        FloatBuffer floats = org.lwjgl.system.MemoryUtil.memRealloc((FloatBuffer) null, 3);
        int[] bits = {0x80000000, 0xbf9e0652, 0x3fc00000};
        for (int index = 0; index < bits.length; index++) floats.put(index, Float.intBitsToFloat(bits[index]));
        floats.position(2).limit(2);
        FloatBuffer replacement = org.lwjgl.system.MemoryUtil.memRealloc(floats, 5);
        state(replacement, 5, 2);
        if (replacement.order() != ByteOrder.nativeOrder()) throw new AssertionError("Float order changed");
        for (int index = 0; index < bits.length; index++)
            if (Float.floatToRawIntBits(replacement.get(index)) != bits[index]) throw new AssertionError("Float bytes changed");
        rejected(() -> org.lwjgl.system.MemoryUtil.memFree(floats));
        rejected(() -> org.lwjgl.system.MemoryUtil.memRealloc(replacement, -1));
        unsupported(() -> org.lwjgl.system.MemoryUtil.memRealloc(replacement, Integer.MAX_VALUE));
        FloatBuffer zero = org.lwjgl.system.MemoryUtil.memRealloc(replacement, 0);
        state(zero, 0, 0);
        org.lwjgl.system.MemoryUtil.memFree(zero);
    }

    private static void state(Buffer buffer, int capacity, int position) {
        if (!buffer.isDirect() || buffer.capacity() != capacity || buffer.limit() != capacity || buffer.position() != position)
            throw new AssertionError("Reallocation buffer state changed");
    }

    private static void unsupported(Runnable action) {
        try {
            action.run();
            throw new AssertionError("Unrepresentable byte-buffer capacity was accepted");
        } catch (UnsupportedOperationException expected) { }
    }

    private static void originalCell() {
        zombie.worldMap.WorldMapCell cell = new zombie.worldMap.WorldMapCell();
        ShortBuffer points = cell.getPointBuffer(2);
        points.put(new short[] {-300, 299, -1, 0}).position(3);
        ShortBuffer grown = cell.getPointBuffer(4);
        state(grown, 11, 3);
        if (grown.get(0) != -300 || grown.get(3) != 0) throw new AssertionError("Original point pool lost data");
        rejected(() -> SpriteGraphics.memFree(points));
        ShortBuffer indices = cell.getIndexBuffer(3);
        indices.put(new short[] {0, 1, 2}).position(2);
        ShortBuffer nextIndices = cell.getIndexBuffer(4);
        state(nextIndices, 6, 2);
        FloatBuffer triangles = cell.getTriangleBuffer(3);
        triangles.put(new float[] {-1.5f, 0.0f, 7.25f}).position(2);
        FloatBuffer nextTriangles = cell.getTriangleBuffer(4);
        state(nextTriangles, 6, 2);
        if (nextTriangles.get(2) != 7.25f) throw new AssertionError("Original triangle pool lost data");
        cell.clearTriangles();
        rejected(() -> SpriteGraphics.memFree(nextIndices));
        rejected(() -> SpriteGraphics.memFree(nextTriangles));
        cell.dispose();
        rejected(() -> SpriteGraphics.memFree(grown));
        cell.dispose();
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
