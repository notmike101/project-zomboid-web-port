package port.host;

import java.nio.ByteBuffer;
import java.util.IdentityHashMap;
import java.util.Map;
import java.util.Objects;
import org.lwjglx.input.Cursor;

/** Owns real browser images by vendor Cursor identity, without native pointers. */
public final class BrowserCustomCursor {
    private static final Map<Cursor, String> images = new IdentityHashMap<>();
    private static Thread owner;

    private BrowserCustomCursor() { }

    private static void requireOwner() {
        if (owner != Thread.currentThread()) {
            throw new IllegalStateException("Foreign browser cursor owner thread");
        }
    }

    public static synchronized void create(Cursor cursor, int width, int height,
            int x, int y, ByteBuffer rgba) {
        Objects.requireNonNull(cursor);
        Objects.requireNonNull(rgba);
        if (width < 1 || height < 1 || width > 32 || height > 32) {
            throw new UnsupportedOperationException("Browser cursors admit images up to 32 pixels");
        }
        if (x < 0 || y < 0 || x >= width || y >= height) {
            throw new IllegalArgumentException("Cursor hotspot outside image");
        }
        int length = Math.multiplyExact(Math.multiplyExact(width, height), 4);
        if (rgba.remaining() != length) {
            throw new IllegalArgumentException("Cursor RGBA range differs from dimensions");
        }
        if (owner != null) requireOwner();
        if (images.containsKey(cursor)) throw new IllegalStateException("Duplicate cursor owner");
        byte[] pixels = new byte[length];
        rgba.duplicate().get(pixels);
        String url = createImage(width, height, x, y, pixels);
        if (url == null || !url.startsWith("blob:")) {
            throw new IllegalStateException("No actual cursor image URL");
        }
        if (owner == null) owner = Thread.currentThread();
        images.put(cursor, url);
    }

    public static synchronized Cursor select(Cursor cursor) {
        // Original vendor selection dereferences null rather than resetting the cursor.
        Objects.requireNonNull(cursor);
        requireOwner();
        String url = images.get(cursor);
        if (url == null) throw new IllegalStateException("Foreign or released cursor");
        selectImage(url);
        return null; // Original vendor previous-return behavior.
    }

    public static synchronized void destroy(Cursor cursor) {
        Objects.requireNonNull(cursor);
        requireOwner();
        String url = images.get(cursor);
        if (url != null) {
            releaseImage(url);
            images.remove(cursor);
        }
    }

    public static long handle(Cursor cursor) {
        throw new UnsupportedOperationException("Browser image cursors have no native GLFW pointer");
    }

    public static synchronized int ownedImages() {
        return images.size();
    }

    public static synchronized void dispose() {
        requireOwner();
        for (String url : images.values()) releaseImage(url);
        images.clear();
        owner = null;
    }

    private static native String createImage(int width, int height, int x, int y, byte[] rgba);
    private static native void selectImage(String url);
    private static native void releaseImage(String url);
}
