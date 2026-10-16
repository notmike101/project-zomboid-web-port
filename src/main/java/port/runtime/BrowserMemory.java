package port.runtime;

import java.nio.Buffer;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.nio.IntBuffer;
import java.util.IdentityHashMap;
import java.util.Objects;
import org.teavm.classlib.impl.nio.Buffers;
import org.teavm.interop.Address;

/** Real WasmGC direct allocations, owned by one cooperative browser agent. */
public final class BrowserMemory {
    private static final IdentityHashMap<Buffer, ByteBuffer> OWNERS = new IdentityHashMap<>();

    public static ByteBuffer memAlloc(int bytes) {
        if (bytes < 0) throw new IllegalArgumentException("Negative direct-buffer capacity");
        ByteBuffer owner = ByteBuffer.allocateDirect(bytes).order(ByteOrder.nativeOrder());
        OWNERS.put(owner, owner);
        return owner;
    }

    /** LWJGL's buffer overload fills remaining bytes and preserves buffer state. */
    public static void memSet(ByteBuffer buffer, int value) {
        Objects.requireNonNull(buffer);
        if (!buffer.isDirect()) throw new IllegalArgumentException("Expected a direct buffer");
        if (buffer.isReadOnly()) throw new java.nio.ReadOnlyBufferException();
        for (int i = buffer.position(); i < buffer.limit(); i++) buffer.put(i, (byte) value);
    }

    public static FloatBuffer memAllocFloat(int count) {
        ByteBuffer owner = allocate(count);
        FloatBuffer view = owner.asFloatBuffer();
        OWNERS.put(view, owner);
        return view;
    }

    public static IntBuffer memAllocInt(int count) {
        ByteBuffer owner = allocate(count);
        IntBuffer view = owner.asIntBuffer();
        OWNERS.put(view, owner);
        return view;
    }

    private static ByteBuffer allocate(int count) {
        if (count < 0 || count > Integer.MAX_VALUE / 4) {
            throw new IllegalArgumentException("Element count exceeds direct-buffer capacity");
        }
        return ByteBuffer.allocateDirect(count * 4).order(ByteOrder.nativeOrder());
    }

    public static void memFree(FloatBuffer buffer) { free(buffer); }
    public static void memFree(IntBuffer buffer) { free(buffer); }
    public static void memFree(ByteBuffer buffer) { free(buffer); }

    private static void free(Buffer buffer) {
        if (buffer == null) return;
        ByteBuffer owner = owner(buffer);
        Buffers.free(owner);
        OWNERS.remove(buffer);
    }

    public static long memAddress(Buffer buffer) {
        owner(Objects.requireNonNull(buffer));
        int elementSize = buffer instanceof ByteBuffer ? 1 : 4;
        return Integer.toUnsignedLong(baseAddress(buffer).add(buffer.position() * elementSize).toInt());
    }

    private static native Address baseAddress(Buffer buffer);

    private static ByteBuffer owner(Buffer buffer) {
        ByteBuffer owner = OWNERS.get(buffer);
        if (owner == null) throw new IllegalArgumentException("Buffer is foreign or already freed");
        return owner;
    }

    public static int liveAllocations() { return OWNERS.size(); }
}
