package port.host;

import java.io.IOException;
import java.nio.BufferUnderflowException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;

/**
 * Java transport for original population buffers and the browser-owned save world.
 * The qualified closure owns one world per browser JVM. Native stop releases the
 * worker queues, but changing worlds requires a fresh JVM until rebinding is qualified.
 */
public final class PopulationBuffers {
    // shortcut: Rebinding awaits a genuine original stop/new-session lifecycle qualification.
    private static Path ownedRoot;

    private PopulationBuffers() { }

    /** Binds one world below the actual original ZFS browser cache for this JVM. */
    public static void openOwnedRoot(String path) throws IOException {
        Path candidate = Path.of(path).toAbsolutePath().normalize();
        Path cache = Path.of(zombie.ZomboidFileSystem.instance.getCacheDir())
                .toAbsolutePath().normalize();
        if (!cache.startsWith(Path.of("/files")) || !candidate.startsWith(cache)
                || candidate.equals(cache)) {
            throw new UnsupportedOperationException("Population save must be a world inside the browser cache");
        }
        if (ownedRoot != null && !ownedRoot.equals(candidate)) {
            throw new UnsupportedOperationException("Changing population worlds requires a fresh browser JVM");
        }
        Files.createDirectories(candidate);
        ownedRoot = candidate;
    }

    /** Resolves only the original qualified population/collision filenames. */
    private static Path owned(String relative) {
        if (ownedRoot == null || relative.indexOf('\\') >= 0) {
            throw new UnsupportedOperationException("Population save owner missing");
        }
        if (!relative.matches("(?:zpop/(?:zpop_(?:-?[0-9]+_-?[0-9]+|ids|virtual)\\.bin)"
                + "|chunkdata/chunkdata_-?[0-9]+_-?[0-9]+\\.bin)")) {
            throw new UnsupportedOperationException("Unqualified population filename");
        }
        Path result = ownedRoot.resolve(relative).normalize();
        if (!result.startsWith(ownedRoot)) {
            throw new UnsupportedOperationException("Population save escapes owner");
        }
        return result;
    }

    /** Returns actual owned bytes, with the original new-world absent-file case. */
    public static String readOwned(String relative) throws IOException {
        Path path = owned(relative);
        return Files.exists(path) ? hex(Files.readAllBytes(path)) : "";
    }

    /** Writes original codec bytes; allocator replacement uses its temp-file protocol. */
    public static void writeOwned(String relative, String value, boolean replace) throws IOException {
        Path path = owned(relative);
        Files.createDirectories(path.getParent());
        byte[] bytes = decodeHex(value);
        if (replace) {
            Path temporary = path.resolveSibling(path.getFileName() + ".tmp");
            Files.write(temporary, bytes);
            Files.move(temporary, path, StandardCopyOption.REPLACE_EXISTING);
        } else {
            Files.write(path, bytes);
        }
    }

    /** Reads an actual source or owned file without altering it. */
    public static String fileHex(String path) throws IOException {
        return hex(Files.readAllBytes(Path.of(path)));
    }

    /** Copies original Java byte-array contents across the JNI host boundary. */
    public static String byteHex(byte[] data) {
        return hex(data);
    }

    /** Reads the root buffer range without changing the caller's position or limit. */
    public static String bufferHex(ByteBuffer data, int count) {
        if (data == null) {
            throw new NullPointerException("buffer");
        }
        if (!data.isDirect()) {
            throw new UnsupportedOperationException("Direct native square input required");
        }
        if (count < 0 || count > data.capacity()) {
            throw new BufferUnderflowException();
        }
        byte[] bytes = new byte[count];
        data.duplicate().clear().get(bytes);
        return hex(bytes);
    }

    /** Copies original integer values in their existing order. */
    public static String integers(int[] data) {
        StringBuilder result = new StringBuilder();
        for (int i = 0; i < data.length; i++) {
            if (i > 0) {
                result.append(',');
            }
            result.append(data[i]);
        }
        return result.toString();
    }

    /** Copies original float values in their existing order. */
    public static String floats(float[] data) {
        StringBuilder result = new StringBuilder();
        for (int i = 0; i < data.length; i++) {
            if (i > 0) {
                result.append(',');
            }
            result.append(data[i]);
        }
        return result.toString();
    }

    /** Copies the actual original persistent-outfit name dictionary. */
    public static String names(String[] data) {
        return String.join("\n", data);
    }

    private static String hex(byte[] data) {
        StringBuilder result = new StringBuilder(data.length * 2);
        for (byte value : data) {
            result.append(Character.forDigit((value >>> 4) & 15, 16));
            result.append(Character.forDigit(value & 15, 16));
        }
        return result.toString();
    }

    private static byte[] decodeHex(String value) {
        if (value.length() % 2 != 0) {
            throw new IllegalArgumentException("Odd hex length");
        }
        byte[] bytes = new byte[value.length() / 2];
        for (int i = 0; i < bytes.length; i++) {
            bytes[i] = (byte) Integer.parseInt(value.substring(i * 2, i * 2 + 2), 16);
        }
        return bytes;
    }

    /** Copies whole original 33-byte records into the caller-owned direct buffer. */
    public static int writeRecords(ByteBuffer target, String encoded) {
        if (target == null) {
            throw new NullPointerException("buffer");
        }
        if (!target.isDirect() || target.isReadOnly()) {
            throw new UnsupportedOperationException("Writable direct publication buffer required");
        }
        byte[] bytes = decodeHex(encoded);
        if (bytes.length % 33 != 0) {
            throw new IllegalArgumentException("Publication bytes must contain whole 33-byte records");
        }
        if (bytes.length != 0 && target.capacity() < 33) {
            // The native DLL writes an overflow prefix here. This unsafe edge is not admitted.
            throw new UnsupportedOperationException("Publication capacity below one record is unqualified");
        }
        ByteBuffer source = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN);
        ByteBuffer output = target.duplicate().clear().order(ByteOrder.BIG_ENDIAN);
        int count = Math.min(bytes.length / 33, output.capacity() / 33);
        for (int record = 0; record < count; record++) {
            output.putFloat(source.getFloat());
            output.putFloat(source.getFloat());
            output.putFloat(source.getFloat());
            output.put(source.get());
            for (int field = 0; field < 5; field++) {
                output.putInt(source.getInt());
            }
        }
        return count;
    }
}
