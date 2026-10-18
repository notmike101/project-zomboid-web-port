import java.nio.file.*;
import org.lwjglx.opengl.*;
import port.host.SpriteGraphics;
import zombie.core.Core;
import zombie.ZomboidFileSystem;

/** Original options producer -> GameWindow.InitDisplay -> Core.init, no original main/game thread. */
public final class DisplayInitQualification {
    private static int checks;
    private static native void report(String value);
    private static native boolean queuePassed();
    private static native boolean observe(int width, int height);
    private static void check(boolean value, String why) { if (!value) throw new AssertionError(why); checks++; }
    private static Object field(String name) throws Exception {
        var field = Display.class.getDeclaredField(name); field.setAccessible(true); return field.get(null);
    }
    private static void unsupported(Runnable action, String why) {
        boolean caught = false, finalized = false;
        try { action.run(); } catch (UnsupportedOperationException expected) { caught = true; }
        finally { finalized = true; }
        check(caught && finalized, why);
    }
    public static void main(String[] args) throws Exception {
        zombie.core.random.RandStandard.INSTANCE.init(); zombie.core.random.RandLua.INSTANCE.init();
        Path root = Path.of(args[0]).toAbsolutePath().normalize();
        Files.createDirectories(root.resolve("cache"));
        var fs = ZomboidFileSystem.instance; String cache = fs.getCacheDir();
        fs.setCacheDir(root.resolve("cache").toString());
        try {
            zombie.debug.DebugLog.getInstance().setStdOut(System.out);
            zombie.debug.DebugLog.getInstance().setStdErr(System.err);
            check(zombie.core.opengl.RenderThread.renderThread == null, "Original pre-render-thread input creation phase");
            Display.init();
            check(Boolean.TRUE.equals(field("isInitialized")), "Actual Display.init original lifecycle guard/cache");
            check(((Long)field("monitor")) == 0 && Display.getWindow() == 0, "No manufactured monitor or window handle");
            check(Display.getDesktopDisplayMode().getWidth() == 64 && !Display.getDesktopDisplayMode().isFullscreenCapable(), "Real owned initial windowed descriptor");
            check(org.lwjglx.input.Keyboard.getKeyName(org.lwjglx.input.Keyboard.KEY_A).equals("A")
                && port.host.BrowserKeyboardEvents.scancodeQueries() >= 50, "Original Keyboard.create executed via Display.init and preserved portable names");
            boolean duplicate = false, duplicateFinally = false;
            try { Display.init(); } catch (IllegalStateException expected) { duplicate = true; }
            finally { duplicateFinally = true; }
            check(duplicate && duplicateFinally, "Original duplicate initialization exception/finally");
            Core core = Core.getInstance();
            check(!core.isNoSave() && !zombie.network.GameClient.client && !zombie.network.GameServer.server, "Original offline/save policy");
            check(!core.isFullScreen() && !core.getOptionBorderlessWindow(), "Original windowed constructor policy, no setters");
            core.saveOptions();
            Path options = Path.of(fs.getCacheDirSub("options.ini")).toAbsolutePath().normalize();
            check(options.startsWith(root) && Files.size(options) > 1000, "Original complete options producer in owned cache");
            int width = core.getScreenWidth(), height = core.getScreenHeight();
            zombie.GameWindow.InitDisplay();
            check(Display.isCreated() && !Display.isFullscreen() && !core.isFullScreen(), "Actual original startup completed windowed");
            check(!core.isDefaultOptions() && core.getOptionCount() > 100, "Original loadOptions existing-file branch");
            check(Display.getWindow() == 0, "No fabricated GLFW handle");
            check(observe(width, height), "Actual DOM canvas/drawing buffer/title/fullscreen/GL state");
            check(Display.getWidth() == width && Display.getHeight() == height, "Actual surface dimensions");
            check(Display.getFramebufferWidth() == width && Display.getFramebufferHeight() == height, "Actual framebuffer dimensions");
            check(Display.getDisplayMode().getWidth() == width && Display.getDisplayMode().getHeight() == height, "Original vendor mode cache");
            check(Boolean.TRUE.equals(field("displayCreated")), "Vendor lifecycle cache published after successful adoption");
            check(field("windowTitle").equals("Project Zomboid"), "Original vendor title cache");
            check(!Display.getDesktopDisplayMode().isFullscreenCapable(), "Browser surface descriptor advertises no monitor mode");
            check(zombie.core.VBO.GLVertexBufferObject.funcs != null, "Original VBO capability selection");
            check(org.lwjgl.opengl.GL11.glGetString(7938).contains("WebGL"), "Original Core queries actual WebGL version");
            check(org.lwjgl.opengl.GL11.glGetString(3379) == null && org.lwjgl.opengl.GL11.glGetError() == 1280, "GL string invalid enum preserves GL error");
            DisplayMode previous = Display.getDisplayMode();
            unsupported(() -> Display.setFullscreen(true), "Fullscreen request Java exception/finally");
            unsupported(() -> Display.setBorderlessWindow(true), "Borderless request Java exception/finally");
            unsupported(() -> SpriteGraphics.create(new PixelFormat(32,0,24,8,0)), "Recreation rejection preserves owned resources");
            check(Display.getDisplayMode() == previous && !Display.isBorderlessWindow() && !core.isFullScreen(), "Rejected requests do not publish false vendor state");
            Display.setDisplayMode(new DisplayMode(320,240));
            check(Display.getWidth() == 320 && Display.getHeight() == 240 && observe(320,240), "Original mode branch resizes real canvas");
            check(((Integer)field("displayWidth")) == 320 && ((Integer)field("displayFramebufferHeight")) == 240, "Original vendor dimension caches follow real surface");
            boolean invalid = false;
            try { Display.setDisplayMode(new DisplayMode(0,240)); } catch (IllegalArgumentException expected) { invalid = true; }
            check(invalid && Display.getDisplayMode().getWidth() == 320 && observe(320,240), "Invalid dimensions preserve current mode and surface");
            Display.setDisplayMode(new DisplayMode(width,height));
            check(observe(width,height) && org.lwjgl.opengl.GL11.glGetError() == 0, "Real resize restored and GL clean");
            KeyboardEventsQualification.main(new String[0]);
            check(queuePassed(), "Existing original GameKeyboard queue qualification after real Display/Keyboard startup");
            Display.destroy();
            check(!Display.isCreated() && Boolean.FALSE.equals(field("displayCreated")), "Actual owned context destroyed and vendor cache cleared");
            boolean closed = false;
            try { SpriteGraphics.makeCurrent(); } catch (Throwable expected) { closed = true; }
            check(closed, "Lost context cannot become current");
            report("{\"pass\":true,\"checks\":"+checks+",\"width\":"+width+",\"height\":"+height+",\"actualGameWindowInitDisplay\":true,\"noOptionSetters\":true}");
        } finally {
            if (Display.isCreated()) Display.destroy();
            fs.setCacheDir(cache);
        }
    }
}
