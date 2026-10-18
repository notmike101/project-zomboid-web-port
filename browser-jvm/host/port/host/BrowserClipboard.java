package port.host;

import java.awt.datatransfer.Clipboard;
import java.awt.datatransfer.DataFlavor;
import java.awt.datatransfer.StringSelection;
import java.awt.datatransfer.Transferable;
import java.awt.datatransfer.UnsupportedFlavorException;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.Objects;
import org.lwjgl.glfw.GLFWErrorCallback;
import org.lwjgl.glfw.GLFWErrorCallbackI;
import org.lwjgl.system.SharedLibrary;

/** Owns a genuine JDK application-local clipboard; no Toolkit, AWT display, or OS clipboard. */
public final class BrowserClipboard {
    private static final Clipboard clipboard = new Clipboard("Project Zomboid browser");
    private static final SharedLibrary library = new ClipboardLibrary();
    private static boolean closed;
    private static int reads, writes, errorCallbackCalls;
    private BrowserClipboard() {}
    public static SharedLibrary library() { live(); return library; }
    private static void live() { if (closed) throw new IllegalStateException("Browser clipboard adapter closed"); }
    public static Clipboard owner() { return clipboard; }
    public static int reads() { return reads; }
    public static int writes() { return writes; }
    public static int errorCallbackCalls() { return errorCallbackCalls; }
    /** The selected original consumer installs/restores null; native/FFI callback registration is unsupported. */
    public static GLFWErrorCallback errorCallback(GLFWErrorCallbackI callback) {
        live();
        if (callback != null) throw new UnsupportedOperationException("Native GLFW error callback registration is unsupported");
        errorCallbackCalls++;
        return null;
    }
    private static String cString(String value) {
        int end = value.indexOf('\0');
        return end < 0 ? value : value.substring(0, end);
    }
    public static String read(long window) throws IOException, UnsupportedFlavorException {
        live();
        if (window != 0) throw new UnsupportedOperationException("No native GLFW window handle exists");
        reads++;
        Transferable value = clipboard.getContents(null);
        if (value == null || !value.isDataFlavorSupported(DataFlavor.stringFlavor)) return null;
        return cString((String)value.getTransferData(DataFlavor.stringFlavor));
    }
    public static void write(long window, CharSequence value) {
        live();
        if (window != 0) throw new UnsupportedOperationException("No native GLFW window handle exists");
        String text = cString(Objects.requireNonNull(value, "clipboard string").toString());
        clipboard.setContents(new StringSelection(text), null);
        writes++;
    }
    /** A real browser service descriptor; it never supplies fictional native function addresses. */
    private static final class ClipboardLibrary implements SharedLibrary {
        public String getName() { return "jdk-app-local-clipboard"; }
        public String getPath() { return null; }
        public long address() { throw new UnsupportedOperationException("Browser clipboard has no native library address"); }
        public long getFunctionAddress(CharSequence name) { throw new UnsupportedOperationException("Unqualified native GLFW function: " + name); }
        public long getFunctionAddress(ByteBuffer name) { throw new UnsupportedOperationException("Browser clipboard has no native function table"); }
        public void free() { live(); closed = true; }
    }
}
