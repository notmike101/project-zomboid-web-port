package port.host;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Objects;
import org.lwjgl.glfw.GLFWJoystickCallback;
import org.lwjgl.glfw.GLFWJoystickCallbackI;

/** Owns the qualified keyboard-only browser boundary while preserving the original game registry. */
public final class BrowserControllers {
    private static GLFWJoystickCallbackI callback;
    private static Thread owner;
    private static boolean closed;
    private static int mappingCalls;
    private static int mappingBytes;
    private static int queries;

    private static native boolean present(int index);
    private static native void mapping(byte[] bytes);
    private static native void openEvents();
    private static native void closeEvents();
    private static native void checkEvents();

    private BrowserControllers() {}

    private static void live() {
        if (closed) throw new IllegalStateException("Controller service closed");
    }

    /** Encodes the genuine mapping text into an owned, NUL-terminated direct buffer. */
    public static ByteBuffer utf8(CharSequence value) {
        byte[] bytes = Objects.requireNonNull(value).toString().getBytes(StandardCharsets.UTF_8);
        ByteBuffer buffer = SpriteGraphics.memAlloc(Math.addExact(bytes.length, 1));
        buffer.put(bytes).put((byte) 0).flip();
        return buffer;
    }

    /** Reports unsupported desktop mapping registration; the original caller accepts false. */
    public static boolean mappings(ByteBuffer source) {
        live();
        ByteBuffer view = source.duplicate();
        byte[] bytes = new byte[view.remaining()];
        view.get(bytes);
        if (bytes.length == 0 || bytes[bytes.length - 1] != 0) {
            throw new IllegalArgumentException("Expected original NUL-terminated mapping payload");
        }
        mapping(bytes);
        mappingCalls++;
        mappingBytes += bytes.length;
        return false;
    }

    /** Owns the real Java callback; a native previous-callback wrapper is unavailable. */
    public static GLFWJoystickCallback joystickCallback(GLFWJoystickCallbackI value) {
        live();
        if (callback != null) {
            throw new UnsupportedOperationException("Previous callback has no native GLFW callback wrapper");
        }
        if (value != null) {
            openEvents();
            callback = value;
            owner = Thread.currentThread();
        }
        return null;
    }

    public static boolean joystickPresent(int index) {
        live();
        if (index < 0 || index > 15) throw new IllegalArgumentException("GLFW joystick index");
        boolean result = present(index);
        queries++;
        return result;
    }

    /** Checks changes around the real DOM yield, before another Java frame can complete. */
    public static void processMessages() {
        live();
        if (owner != Thread.currentThread()) {
            throw new IllegalStateException("Controller events require the original Java owner thread");
        }
        checkEvents();
        SpriteGraphics.processMessages();
        checkEvents();
    }

    public static boolean ownsCallback() { return callback != null; }
    public static int mappingCalls() { return mappingCalls; }
    public static int mappingBytes() { return mappingBytes; }
    public static int queries() { return queries; }

    /** Ends this fresh-VM owner; same-VM controller session reuse is not qualified. */
    public static void dispose() {
        live();
        closeEvents();
        callback = null;
        owner = null;
        closed = true;
    }
}
