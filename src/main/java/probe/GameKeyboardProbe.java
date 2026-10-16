package probe;

import org.lwjglx.input.Keyboard;
import org.lwjglx.opengl.Display;
import org.teavm.jso.JSExport;
import zombie.input.GameKeyboard;

/** Browser-only original game keyboard cache and transition lifecycle. */
public final class GameKeyboardProbe {
    /** One actual poll/update frame; original cache swapping exposes the preceding sample. */
    @JSExport public static void pollInput() { GameKeyboard.poll(); GameKeyboard.update(); }
    @JSExport public static int queryKey(int key) { return GameKeyboard.isKeyDown(key) ? 1 : 0; }
    @JSExport public static int isKeyPressed(int key) { return GameKeyboard.isKeyPressed(key) ? 1 : 0; }
    @JSExport public static int wasKeyDown(int key) { return GameKeyboard.wasKeyDown(key) ? 1 : 0; }
    /** The original API exposes current/previous states rather than a named release helper. */
    @JSExport public static int isKeyReleased(int key) {
        return GameKeyboard.wasKeyDown(key) && !GameKeyboard.isKeyDown(key) ? 1 : 0;
    }
    @JSExport public static int queryState(int key) {
        return queryKey(key) | (isKeyPressed(key) << 1) | (isKeyReleased(key) << 2);
    }
    @JSExport public static int windowHandle() {
        long handle = Display.getWindow();
        if (handle <= 0 || handle > Integer.MAX_VALUE) throw new AssertionError("Canvas window handle invalid");
        return (int) handle;
    }
    public static void main(String[] args) {
        windowHandle();
        if (!Keyboard.isCreated()) throw failure("Actual browser canvas is not reported as created");
        pollInput(); pollInput();
        int[] keys = {17,30,31,32,200,203,42,57};
        String[] names = {"W","A","S","D","ArrowUp","ArrowLeft","ShiftLeft","Space"};
        StringBuilder json = new StringBuilder("{\"rule\":\"exact-raw-bits\",\"category\":\"browser-game-keyboard\",\"cases\":[");
        for (int i = 0; i < keys.length; i++) {
            if (queryState(keys[i]) != 0 || wasKeyDown(keys[i]) != 0) throw failure("Initial original input state differs: " + names[i]);
            if (i > 0) json.append(',');
            json.append("{\"id\":\"").append(names[i]).append("\",\"inputs\":[],\"outputs\":{\"measure\":{\"value\":0,\"bits\":\"00000000\"},\"contentHash\":{\"value\":1,\"bits\":\"00000001\"}}}");
        }
        System.out.println(json.append("],\"pass\":true}"));
    }
    private static AssertionError failure(String message) { System.out.println(message); return new AssertionError(message); }
}
