package probe;

import org.lwjglx.input.Keyboard;
import org.lwjglx.opengl.Display;
import org.teavm.jso.JSExport;

/** Browser-only original key conversion and query path, with live DOM input tested by the fixture. */
public final class KeyboardProbe {
    @JSExport public static int queryKey(int lwjglKey) { return Keyboard.isKeyDown(lwjglKey) ? 1 : 0; }
    @JSExport public static int windowHandle() {
        long handle = Display.getWindow();
        if (handle <= 0 || handle > Integer.MAX_VALUE) throw new AssertionError("Canvas window handle invalid");
        return (int) handle;
    }
    public static void main(String[] args) {
        int handle = windowHandle();
        if (Display.getWindow() != handle) throw new AssertionError("Canvas window identity changed");
        int[] keys = {17,30,31,32,200,203,42,57};
        String[] names = {"W","A","S","D","ArrowUp","ArrowLeft","ShiftLeft","Space"};
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"category\":\"browser-keyboard\",\"cases\":[");
        for (int i = 0; i < keys.length; i++) {
            int released = queryKey(keys[i]);
            if (released != 0) throw new AssertionError("Initial key pressed: " + names[i]);
            if (i > 0) json.append(',');
            json.append("{\"id\":\"").append(names[i]).append("\",\"inputs\":[],\"outputs\":{\"measure\":{\"value\":0,\"bits\":\"00000000\"},\"contentHash\":{\"value\":1,\"bits\":\"00000001\"}}}");
        }
        // Invalid original LWJGL codes are rejected by unchanged KeyCodes before GLFW is queried.
        if (queryKey(-1) != 0) throw new AssertionError("Original invalid-key conversion differs");
        System.out.println(json.append("],\"pass\":true}"));
    }
}
