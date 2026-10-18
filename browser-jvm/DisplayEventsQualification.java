import org.lwjglx.opengl.Display;
import org.lwjglx.opengl.DisplayMode;
import org.lwjglx.input.Keyboard;
import port.host.BrowserClipboard;
import port.host.BrowserDisplayEvents;
import zombie.core.Core;

/** Original render-owner initialization and vendor event pump; no game loop or world startup. */
public final class DisplayEventsQualification {
    private static int checks, gained, lost;
    private static native void phase(int phase);
    private static native boolean cursor(String expected);
    private static native void report(String json);
    private static void check(boolean value, String why) {
        if (!value) throw new AssertionError(why);
        checks++;
    }
    private static Object field(String name) throws Exception {
        var field = Display.class.getDeclaredField(name);
        field.setAccessible(true);
        return field.get(null);
    }
    private static void unsupported(Runnable work, String why) {
        boolean caught = false, finalized = false;
        try { work.run(); } catch (UnsupportedOperationException expected) { caught = true; }
        finally { finalized = true; }
        check(caught && finalized, why);
    }
    public static void main(String[] args) throws Exception {
        zombie.core.random.RandStandard.INSTANCE.init();
        zombie.core.random.RandLua.INSTANCE.init();
        var filesystem = zombie.ZomboidFileSystem.instance;
        String previousCache = filesystem.getCacheDir();
        var root = java.nio.file.Path.of(args[0]).toAbsolutePath().normalize();
        java.nio.file.Files.createDirectories(root.resolve("cache"));
        filesystem.setCacheDir(root.resolve("cache").toString());
        var onGained = (Display.FocusGainedListener) () -> gained++;
        var onLost = (Display.FocusLostListener) () -> lost++;
        Core core = Core.getInstance();
        boolean lock = core.getOptionLockCursorToWindow();
        boolean renderOwner = false;
        try {
            check(!lock, "Original default cursor policy is unlocked; no option bypass");
            Display.init();
            java.nio.file.Files.createDirectories(root.resolve("media"));
            java.nio.file.Files.copy(java.nio.file.Path.of("/app/media/gamecontrollerdb.txt"), root.resolve("media/gamecontrollerdb.txt"));
            core.saveOptions();
            zombie.core.opengl.RenderThread.init();
            renderOwner = true;
            check(zombie.core.opengl.RenderThread.renderThread == Thread.currentThread() && zombie.core.opengl.RenderThread.isRunning(), "Actual original render owner");
            check(org.lwjglx.input.Controllers.isCreated() && port.host.BrowserControllers.ownsCallback() && port.host.BrowserControllers.queries() == 16, "Actual original controller initialization");
            Display.addFocusGainedListener(onGained);
            Display.addFocusLostListener(onLost);
            int reads = BrowserClipboard.reads();
            phase(1); Display.processMessages();
            check(Display.isActive() && gained == 1 && lost == 0, "Original focus gain and listeners");
            check(BrowserClipboard.reads() == reads + 1, "Original focus gain calls original Clipboard.rememberCurrentValue");
            check(cursor("default"), "Original initial cursor mode reaches actual normal DOM cursor");
            phase(2); Display.processMessages();
            check(Display.isActive() && gained == 1 && lost == 0, "Owned textarea remains the same focused Display");
            int characters = 0, entries = 0;
            var queue = zombie.input.GameKeyboard.getEventQueuePolling();
            while (queue.next()) {
                entries++;
                if (queue.getEventCharacter() == 'Q') characters++;
            }
            check(characters == 1 && entries >= 1, "Original polling queue receives real beforeinput once; game-thread swap is outside this platform component");
            phase(3); Display.processMessages();
            check(!Display.isActive() && gained == 1 && lost == 1, "Actual outside focus triggers one original focus-lost callback");
            phase(4); Display.processMessages();
            check(!Display.isActive() && !Display.isVisible() && lost == 1, "Real hidden tab pump returns and does not duplicate focus callback");
            phase(5); Display.processMessages();
            check(Display.isActive() && Display.isVisible() && gained == 2 && lost == 1, "Real canvas focus regains original Display once");
            int pressed = 0, released = 0;
            while (org.lwjglx.input.Mouse.next()) {
                if (org.lwjglx.input.Mouse.getEventButton() == 0) {
                    if (org.lwjglx.input.Mouse.getEventButtonState()) pressed++;
                    else released++;
                }
            }
            check(pressed == 2 && released == 2, "Two actual canvas clicks delivered once by one original mouse queue");
            DisplayMode before = Display.getDisplayMode();
            phase(6); Display.processMessages();
            check(Display.getWidth() == 96 && Display.getHeight() == 80, "Original callback latest dimensions reflect actual resized canvas");
            check(Display.getFramebufferWidth() == 96 && Display.getFramebufferHeight() == 80, "Original framebuffer callback fields reflect WebGL drawing buffer");
            check(Display.wasResized() && Display.wasResized(), "Repeated original resize getter reads retain this pump state");
            check(Display.getDisplayMode() != before && Display.getDisplayMode().getWidth() == 96
                && Display.getDisplayMode().getHeight() == 80, "Original processMessages reconstructs mode descriptor");
            check(Boolean.FALSE.equals(field("latestResized")), "Original processMessages consumes callback resize marker");
            phase(7); Display.processMessages();
            check(!Display.wasResized(), "Next unchanged original pump clears wasResized");
            int previous = (Integer) field("mouseCursorState");
            core.setOptionLockCursorToWindow(true);
            try {
                unsupported(Display::processMessages, "Actual disabled option rejected through genuine Java UOE/finally");
                check((Integer) field("mouseCursorState") == previous && core.getOptionLockCursorToWindow()
                    && cursor("default"), "Rejected disabled request preserves original cursor cache/actual DOM and requested option");
            } finally { core.setOptionLockCursorToWindow(lock); }
            BrowserDisplayEvents.setInputMode(0, 208897, 212994);
            check(cursor("none"), "Actual hidden platform cursor");
            unsupported(() -> BrowserDisplayEvents.setInputMode(0, 208897, 212995), "Disabled platform mode explicitly rejected");
            check(cursor("none"), "Rejected platform mode preserves actual CSS cursor");
            BrowserDisplayEvents.setInputMode(0, 208897, 212993);
            check(cursor("default"), "Actual normal platform cursor restored");
            unsupported(() -> BrowserDisplayEvents.windowAttrib(0, 131074), "Unqualified window attribute rejected honestly");
            check(org.lwjgl.opengl.GL11.glGetError() == 0, "No graphics errors from actual platform lifecycle");
            Display.removeFocusGainedListener(onGained);
            Display.removeFocusLostListener(onLost);
            CustomCursorQualification.run(root);
            Display.destroy();
            boolean closed = false, finalized = false;
            try { Display.processMessages(); } catch (IllegalStateException expected) { closed = true; }
            finally { finalized = true; }
            check(closed && finalized, "Closed surface original pump propagates genuine Java lifecycle exception/finally");
            report("{\"pass\":true,\"checks\":" + checks + ",\"gained\":" + gained + ",\"lost\":" + lost
                + ",\"clipboardReads\":" + BrowserClipboard.reads() + ",\"originalProcessBodyRestored\":true}");
        } catch (Exception | Error failure) {
            report("{\"pass\":false,\"checks\":" + checks + "}");
            throw failure;
        } finally {
            try {
                if (renderOwner) zombie.GameWindow.GameInput.quit();
            } finally {
                try {
                    if (port.host.BrowserControllers.ownsCallback()) port.host.BrowserControllers.dispose();
                } finally {
                    try {
                        core.setOptionLockCursorToWindow(lock);
                        Display.removeFocusGainedListener(onGained);
                        Display.removeFocusLostListener(onLost);
                        if (Display.isCreated()) Display.destroy();
                    } finally { filesystem.setCacheDir(previousCache); }
                }
            }
        }
    }
}
