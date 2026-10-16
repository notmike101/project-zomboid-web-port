package port.host;

import java.nio.ByteBuffer;
import java.sql.SQLException;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.IdentityHashMap;
import java.util.Map;

/** Bulk JNI transport. Scalar long arguments use decimal strings across LiveConnect. */
public final class SqliteSupport {

    private static final IdentityHashMap<Object, String> identities =
        new IdentityHashMap<>();
    private static final Map<String, SQLException> failures = new HashMap<>();
    private static long nextIdentity;
    private static int failureId;

    private SqliteSupport() {}

    public static synchronized String openIdentity(Object receiver) {
        return identities.computeIfAbsent(receiver, key ->
            Long.toString(++nextIdentity)
        );
    }

    public static synchronized String identity(Object receiver) {
        return identities.get(receiver);
    }

    public static synchronized void forget(Object receiver) {
        identities.remove(receiver);
    }

    public static synchronized int identities() {
        return identities.size();
    }

    private static synchronized String failed(Exception cause) {
        String key = Integer.toString(++failureId);
        failures.put(
            key,
            new SQLException(
                "SQLite file operation failed: " + cause.getMessage(),
                cause
            )
        );
        return "error:" + key;
    }

    public static synchronized SQLException takeFailure(String key) {
        return failures.remove(key);
    }

    public static synchronized int pendingFailures() {
        return failures.size();
    }

    public static String acquireLease(String filename) {
        try {
            return "ok:" + SqliteFiles.acquire(filename);
        } catch (Exception exception) {
            return failed(exception);
        }
    }

    public static String readHexLease(String lease) {
        try {
            String image = hex(SqliteFiles.read(Long.parseLong(lease)));
            return "ok:" + (image == null ? "missing" : image);
        } catch (Exception exception) {
            return failed(exception);
        }
    }

    public static String publishHexLease(String lease, String image) {
        try {
            SqliteFiles.publish(Long.parseLong(lease), bytes(image));
            return "ok:";
        } catch (Exception exception) {
            return failed(exception);
        }
    }

    public static String releaseLease(String lease) {
        try {
            SqliteFiles.release(Long.parseLong(lease));
            return "ok:";
        } catch (Exception exception) {
            return failed(exception);
        }
    }

    public static String hex(byte[] bytes) {
        return bytes == null ? null : HexFormat.of().formatHex(bytes);
    }

    public static byte[] bytes(String hex) {
        return hex == null ? null : HexFormat.of().parseHex(hex);
    }

    public static ByteBuffer buffer(String hex) {
        if (hex == null) return null;
        byte[] bytes = bytes(hex);
        ByteBuffer buffer = ByteBuffer.allocateDirect(bytes.length);
        buffer.put(bytes).flip();
        return buffer;
    }
}
