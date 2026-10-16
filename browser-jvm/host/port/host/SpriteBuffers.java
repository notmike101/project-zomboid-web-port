package port.host;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.IntBuffer;
import java.util.HashMap;
import java.util.LinkedHashSet;






/** Real WebGL buffer storage with owned CPU mappings, uploaded when unmapped.
 * Native pointers are never published. Buffer positions/limits do not control
 * the mapped range, and accessing a mapping after unmap is outside its lifetime.
 * The adapter covers selected scalar/ByteBuffer ARB/core entry points; typed
 * buffer/array overloads, native-address APIs, explicit-flush/persistent mappings,
 * and targets outside array, element-array, and copy buffers are unsupported.
 * This is not a full desktop ARB extension or desktop GL version implementation.
 */
public final class SpriteBuffers {
    private static final HashMap<Integer, Entry> objects = new HashMap<>();
    private static final HashMap<Integer, Entry> bindings = new HashMap<>();
    private static final LinkedHashSet<Integer> errors = new LinkedHashSet<>();
    private static int nextId = 1;

    private SpriteBuffers() { }

    public static int error() {
        var iterator = errors.iterator();
        if (!iterator.hasNext()) return 0;
        int value = iterator.next(); iterator.remove(); return value;
    }

    private static void error(int value) { errors.add(value); }

    public static int generate() {
        int object = SpriteGraphics.bufferCreate();
        if (object == 0) return 0;
        int id = nextId++;
        objects.put(id, new Entry(id, object));
        return id;
    }

    public static void bind(int target, int id) {
        if (!target(target)) return;
        Entry entry = id == 0 ? null : objects.get(id);
        if (id != 0 && entry == null) { error(0x0502); return; }
        SpriteGraphics.bufferBind(target, entry == null ? 0 : entry.object);
        bindings.put(target, entry);
    }

    public static void delete(int id) {
        Entry entry = objects.remove(id);
        if (entry == null) return;
        SpriteGraphics.bufferDelete(entry.object);
        for (var binding : bindings.entrySet()) if (binding.getValue() == entry) binding.setValue(null);
        release(entry);
    }

    public static boolean isBuffer(int id) {
        Entry entry = objects.get(id);
        return entry != null && SpriteGraphics.bufferIs(entry.object);
    }

    public static int binding(int target) {
        Entry entry = bindings.get(target);
        return entry == null ? 0 : entry.id;
    }

    public static void data(int target, long size, int usage) {
        Entry entry = bound(target);
        if (entry == null || !writable(entry)) return;
        if (!size(size)) return;
        SpriteGraphics.bufferDataSize(target, (int) size, usage);
        resize(target, entry);
    }

    public static void data(int target, ByteBuffer source, int usage) {
        Entry entry = bound(target);
        if (entry == null || !writable(entry)) return;
        SpriteGraphics.bufferDataBytes(target, bytes(source, source.position(), source.remaining()), usage);
        resize(target, entry);
    }

    private static void resize(int target, Entry entry) {
        int size = parameter(target, 0x8764);
        if (entry.capacity != size) { release(entry); entry.capacity = size; }
    }

    public static void subData(int target, long offset, ByteBuffer source) {
        Entry entry = bound(target);
        if (entry == null || !writable(entry) || !range(entry, offset, source.remaining())) return;
        SpriteGraphics.bufferUpload(target, (int) offset, bytes(source, source.position(), source.remaining()));
    }

    public static void getData(int target, long offset, ByteBuffer destination) {
        Entry entry = bound(target);
        if (entry == null || !writable(entry) || !range(entry, offset, destination.remaining())) return;
        if (destination.isReadOnly()) throw new java.nio.ReadOnlyBufferException();
        byte[] bytes = new byte[destination.remaining()];
        SpriteGraphics.bufferRead(target, (int) offset, bytes);
        for (int i = 0; i < bytes.length; i++) destination.put(destination.position() + i, (byte) bytes[i]);
    }

    public static ByteBuffer map(int target, int access, long length, ByteBuffer previous) {
        int flags = switch (access) { case 0x88B8 -> 1; case 0x88B9 -> 2; case 0x88BA -> 3; default -> 0; };
        if (flags == 0) { error(0x0500); return null; }
        Entry entry = bound(target);
        if (entry == null) return null;
        if (entry.capacity == 0) { error(0x0502); return null; }
        if (length < 0 || length > entry.capacity) { error(0x0501); return null; }
        // LWJGL's length controls the exposed Java view, not GL's whole-buffer mapping.
        ByteBuffer mapped = mapRange(target, 0, entry.capacity, flags, previous);
        if (mapped == null) return null;
        entry.access = access;
        mapped.limit((int) length);
        return mapped;
    }

    public static ByteBuffer mapRange(int target, long offset, long length,
            int flags, ByteBuffer previous) {
        Entry entry = bound(target);
        if (entry == null) return null;
        if (entry.mapped) { error(0x0502); return null; }
        if ((flags & ~0x3F) != 0 || (flags & 3) == 0) { error(0x0501); return null; }
        if ((flags & 0x10) != 0) throw new UnsupportedOperationException("Explicit-flush buffer mappings are unsupported");
        if ((flags & 1) != 0 && (flags & 0x2C) != 0) { error(0x0502); return null; }
        if (length == 0 || !range(entry, offset, length)) { error(0x0501); return null; }
        if (entry.staging == null || entry.staging.capacity() != length) {
            release(entry);
            entry.staging = ByteBuffer.allocateDirect((int) length).order(ByteOrder.nativeOrder());
        }
        entry.staging.clear();
        if ((flags & 1) != 0) {
            byte[] data = new byte[(int) length];
            SpriteGraphics.bufferRead(target, (int) offset, data);
            for (int i = 0; i < data.length; i++) entry.staging.put(i, (byte) data[i]);
        }
        entry.mapped = true; entry.offset = (int) offset; entry.length = (int) length; entry.flags = flags;
        entry.access = (flags & 3) == 1 ? 0x88B8 : (flags & 3) == 2 ? 0x88B9 : 0x88BA;
        return (flags & 2) == 0 ? entry.staging.asReadOnlyBuffer().order(ByteOrder.nativeOrder()) : entry.staging;
    }

    public static boolean unmap(int target) {
        Entry entry = bound(target);
        if (entry == null) return false;
        if (!entry.mapped) { error(0x0502); return false; }
        if ((entry.flags & 2) != 0) {
            ByteBuffer entireMapping = entry.staging.duplicate();
            entireMapping.clear();
            SpriteGraphics.bufferUpload(target, entry.offset, bytes(entireMapping, 0, entry.length));
        }
        entry.mapped = false; entry.offset = entry.length = entry.flags = 0;
        return SpriteGraphics.contextCreated();
    }

    public static int getParameter(int target, int name) {
        Entry entry = bound(target);
        if (entry == null) return 0;
        return switch (name) {
            case 0x88BB -> entry.access;
            case 0x88BC -> entry.mapped ? 1 : 0;
            case 0x9121 -> entry.offset;
            case 0x9120 -> entry.length;
            case 0x911F -> entry.flags;
            default -> parameter(target, name);
        };
    }

    public static void getParameter(int target, int name, IntBuffer destination) {
        if (!destination.hasRemaining()) throw new IllegalArgumentException("Buffer query destination is empty");
        destination.put(destination.position(), getParameter(target, name));
    }

    private static boolean writable(Entry entry) {
        if (entry.mapped) { error(0x0502); return false; }
        return true;
    }

    private static boolean range(Entry entry, long offset, long length) {
        if (offset < 0 || length < 0 || offset > entry.capacity || length > entry.capacity - offset) {
            error(0x0501); return false;
        }
        return true;
    }

    private static boolean size(long size) {
        if (size < 0) { error(0x0501); return false; }
        if (size > Integer.MAX_VALUE) throw new UnsupportedOperationException("Buffer exceeds browser adapter capacity");
        return true;
    }

    private static boolean target(int target) {
        if (target != 0x8892 && target != 0x8893 && target != 0x8F36 && target != 0x8F37) {
            throw new UnsupportedOperationException("Unsupported buffer target: " + target);
        }
        return true;
    }

    private static Entry bound(int target) {
        if (!target(target)) return null;
        Entry entry = bindings.get(target);
        if (entry == null) error(0x0502);
        return entry;
    }

    private static byte[] bytes(ByteBuffer source, int start, int length) {
        byte[] data = new byte[length];
        for (int i = 0; i < length; i++) data[i] = source.get(start + i);
        return data;
    }

    private static void release(Entry entry) {
        // Dropping the owned view releases direct storage to the browser JVM garbage collector.
        entry.staging = null; entry.mapped = false; entry.offset = entry.length = entry.flags = 0;
    }

    private static int parameter(int target, int name) { return SpriteGraphics.bufferParameter(target, name); }

    private static final class Entry {
        final int id;
        final int object;
        int capacity, offset, length, flags, access = 0x88BA;
        boolean mapped;
        ByteBuffer staging;
        Entry(int id, int object) { this.id = id; this.object = object; }
    }
}
