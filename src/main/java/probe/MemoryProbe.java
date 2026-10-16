package probe;

import java.nio.ByteOrder;
import java.nio.ByteBuffer;
import java.nio.FloatBuffer;
import java.nio.IntBuffer;
import org.teavm.interop.Address;
import org.lwjgl.system.MemoryUtil;
import org.teavm.jso.JSExport;
import port.runtime.BrowserMemory;

/** Browser-only direct-memory assertions. Never run this entry point on a desktop JVM. */
public final class MemoryProbe {
    private static int checks;

    public static void main(String[] args) {
        System.out.println(runMemoryChecks());
    }

    @JSExport
    public static String runMemoryChecks() {
        if (BrowserMemory.liveAllocations() != 0) throw new AssertionError("Expected no pre-existing allocations");
        checks = 0;
        String[] names = {"float-allocation", "int-allocation", "real-address", "identity-ownership",
                "invalid-free", "invalid-size", "zero-capacity", "position-limit", "byte-fill-address"};
        StringBuilder json = new StringBuilder("{\"category\":\"browser-memory\",\"cases\":[");
        for (int i = 0; i < names.length; i++) {
            int before = checks;
            FloatBuffer floats = null;
            FloatBuffer second = null;
            IntBuffer ints = null;
            ByteBuffer bytes = null;
            try {
                switch (i) {
                    case 0:
                        floats = MemoryUtil.memAllocFloat(4);
                        check(floats.isDirect() && floats.order() == ByteOrder.nativeOrder());
                        check(floats.position() == 0 && floats.limit() == 4 && floats.capacity() == 4);
                        float[] values = {-0.0f, 1.5f, -2.25f, Float.MAX_VALUE};
                        floats.put(values).flip();
                        for (float value : values) check(Float.floatToRawIntBits(floats.get()) == Float.floatToRawIntBits(value));
                        break;
                    case 1:
                        ints = MemoryUtil.memAllocInt(4);
                        check(ints.isDirect() && ints.order() == ByteOrder.nativeOrder());
                        check(ints.position() == 0 && ints.limit() == 4 && ints.capacity() == 4);
                        int[] integers = {0, -1, Integer.MIN_VALUE, Integer.MAX_VALUE};
                        ints.put(integers).flip();
                        for (int value : integers) check(ints.get() == value);
                        break;
                    case 2:
                        check(Address.sizeOf() == 4);
                        floats = MemoryUtil.memAllocFloat(2);
                        floats.put(0, 1.5f);
                        long base = MemoryUtil.memAddress(floats);
                        check(base != 0 && Float.floatToRawIntBits(Address.fromInt((int) base).getFloat()) == Float.floatToRawIntBits(1.5f));
                        floats.position(1);
                        check(MemoryUtil.memAddress(floats) == base + 4);
                        Address.fromInt((int) MemoryUtil.memAddress(floats)).putFloat(-2.25f);
                        check(floats.get(1) == -2.25f && floats.position() == 1);
                        ints = MemoryUtil.memAllocInt(1);
                        ints.put(0, 0x12345678);
                        check(Address.fromInt((int) MemoryUtil.memAddress(ints)).getInt() == 0x12345678);
                        break;
                    case 3:
                        floats = MemoryUtil.memAllocFloat(2);
                        second = MemoryUtil.memAllocFloat(2);
                        floats.put(0, 7).put(1, 8);
                        second.put(0, 7).put(1, 8);
                        check(floats.equals(second) && BrowserMemory.liveAllocations() == 2);
                        floats.position(1);
                        MemoryUtil.memFree(floats);
                        floats = null;
                        check(BrowserMemory.liveAllocations() == 1 && second.get(0) == 7);
                        check(MemoryUtil.memAddress(second) != 0);
                        break;
                    case 4:
                        MemoryUtil.memFree((FloatBuffer) null);
                        MemoryUtil.memFree((IntBuffer) null);
                        check(BrowserMemory.liveAllocations() == 0);
                        reject(() -> MemoryUtil.memFree(FloatBuffer.allocate(1)));
                        reject(() -> MemoryUtil.memFree(IntBuffer.allocate(1)));
                        floats = MemoryUtil.memAllocFloat(1);
                        FloatBuffer freed = floats;
                        MemoryUtil.memFree(floats);
                        floats = null;
                        reject(() -> MemoryUtil.memFree(freed));
                        reject(() -> MemoryUtil.memAddress(freed));
                        check(BrowserMemory.liveAllocations() == 0);
                        break;
                    case 5:
                        for (int count : new int[]{-1, Integer.MIN_VALUE, Integer.MAX_VALUE / 4 + 1, Integer.MAX_VALUE}) {
                            reject(() -> MemoryUtil.memAllocFloat(count));
                            reject(() -> MemoryUtil.memAllocInt(count));
                        }
                        check(BrowserMemory.liveAllocations() == 0);
                        break;
                    case 6:
                        floats = MemoryUtil.memAllocFloat(0);
                        ints = MemoryUtil.memAllocInt(0);
                        check(floats.isDirect() && ints.isDirect());
                        check(floats.capacity() == 0 && floats.limit() == 0 && floats.position() == 0);
                        check(ints.capacity() == 0 && ints.limit() == 0 && ints.position() == 0);
                        break;
                    case 7:
                        floats = MemoryUtil.memAllocFloat(4);
                        floats.put(new float[]{1, 2, 3, 4});
                        floats.position(0);
                        long start = MemoryUtil.memAddress(floats);
                        floats.limit(3).position(1);
                        check(MemoryUtil.memAddress(floats) == start + 4);
                        check(floats.remaining() == 2 && floats.position() == 1 && floats.limit() == 3);
                        check(floats.get(1) == 2 && floats.get(2) == 3);
                        floats.position(3);
                        check(MemoryUtil.memAddress(floats) == start + 12);
                        break;
                    default:
                        bytes = MemoryUtil.memAlloc(6);
                        check(bytes.isDirect() && bytes.order() == ByteOrder.nativeOrder());
                        long byteBase = MemoryUtil.memAddress(bytes);
                        bytes.put(0, (byte) 7).put(5, (byte) 8).position(1).limit(5);
                        MemoryUtil.memSet(bytes, 0x1ab);
                        check(bytes.position() == 1 && bytes.limit() == 5);
                        for (int index = 1; index < 5; index++) check((bytes.get(index) & 255) == 0xab);
                        ByteBuffer whole = bytes.duplicate().clear();
                        check(whole.get(0) == 7 && whole.get(5) == 8);
                        check(MemoryUtil.memAddress(bytes) == byteBase + 1
                                && (Address.fromInt((int) byteBase + 1).getByte() & 255) == 0xab);
                }
            } finally {
                MemoryUtil.memFree(floats);
                MemoryUtil.memFree(second);
                MemoryUtil.memFree(ints);
                MemoryUtil.memFree(bytes);
            }
            check(BrowserMemory.liveAllocations() == 0);
            if (i != 0) json.append(',');
            json.append("{\"id\":\"").append(names[i]).append("\",\"checks\":").append(checks - before).append(",\"pass\":true}");
        }
        return json.append("],\"checks\":").append(checks).append(",\"allocationsRemaining\":")
                .append(BrowserMemory.liveAllocations()).append(",\"pass\":true}").toString();
    }

    private static void check(boolean condition) {
        if (!condition) throw new AssertionError("Browser memory contract differs");
        checks++;
    }

    private static void reject(Runnable action) {
        try { action.run(); }
        catch (IllegalArgumentException expected) { checks++; return; }
        throw new AssertionError("Invalid memory operation accepted");
    }
}
