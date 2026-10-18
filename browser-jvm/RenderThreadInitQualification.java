import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import org.lwjgl.glfw.GLFW;
import org.lwjgl.glfw.GLFWJoystickCallbackI;
import org.lwjglx.input.Controllers;
import org.lwjglx.input.GamepadState;
import org.lwjglx.opengl.Display;
import port.host.BrowserClipboard;
import port.host.BrowserControllers;

/** Original render-owner initialization with owned inputs; full render loop/shutdown remain outside scope. */
public final class RenderThreadInitQualification {
    private static int checks;
    private static native void report(String text);
    private static native void triggerUntrustedEvent();

    private static void check(boolean value, String why) {
        if (!value) throw new AssertionError(why);
        checks++;
    }

    private static Object field(Object target, String name) throws Exception {
        Field field = target.getClass().getDeclaredField(name);
        field.setAccessible(true);
        return field.get(target);
    }

    private static List<GamepadState> states(zombie.core.input.Input input) throws Exception {
        Object cache = field(input, "controllerStateCache");
        var result = new ArrayList<GamepadState>();
        for (Object state : (Object[]) field(cache, "states")) {
            result.addAll(List.of((GamepadState[]) field(state, "gamepadState")));
        }
        return result;
    }

    private static void unsupported(Runnable action, String why) {
        boolean rejected = false;
        try { action.run(); } catch (UnsupportedOperationException expected) { rejected = true; }
        check(rejected, why);
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 1) throw new IllegalArgumentException("Owned browser root required");
        Path root = Path.of(args[0]).toAbsolutePath().normalize();
        if (!root.getParent().equals(Path.of("/files/render-thread-init")) || !root.toString().equals(System.getProperty("user.dir"))) {
            throw new IllegalArgumentException("Owned root/cwd mismatch");
        }
        zombie.core.random.RandStandard.INSTANCE.init();
        zombie.core.random.RandLua.INSTANCE.init();
        Files.createDirectories(root.resolve("media"));
        Files.createDirectories(root.resolve("cache"));
        Files.copy(Path.of("/app/media/gamecontrollerdb.txt"), root.resolve("media/gamecontrollerdb.txt"), StandardCopyOption.REPLACE_EXISTING);
        var fs = zombie.ZomboidFileSystem.instance;
        String previous = fs.getCacheDir();
        fs.setCacheDir(root.resolve("cache").toString());
        zombie.core.input.Input input = null;
        List<GamepadState> states = List.of();
        boolean controllerDisposed = false;
        boolean inputQuit = false;
        boolean displayClosed = false;
        try {
            zombie.debug.DebugLog.getInstance().setStdOut(System.out);
            zombie.debug.DebugLog.getInstance().setStdErr(System.err);
            check(zombie.core.opengl.RenderThread.renderThread == null && !zombie.core.opengl.RenderThread.isRunning(), "Original render owner initially absent");
            Display.init();
            var core = zombie.core.Core.getInstance();
            check(!core.isNoSave() && !core.isFullScreen() && !zombie.network.GameServer.server && !zombie.network.GameClient.client, "Untouched normal offline/windowed/save policy");
            core.saveOptions();
            check(Files.size(root.resolve("cache/options.ini")) > 1000, "Original owned options producer");
            input = zombie.GameWindow.GameInput;
            states = states(input);
            check(states.size() == 32, "Original two controller-state arrays own 32 values");
            zombie.core.opengl.RenderThread.init();
            check(zombie.core.opengl.RenderThread.renderThread == Thread.currentThread() && zombie.core.opengl.RenderThread.isRunning(), "Original init publishes actual owner/readiness itself");
            check(Display.isCreated() && core.getOptionCount() > 100 && !core.isDefaultOptions(), "Original GameWindow.InitDisplay through RenderThread.init");
            check(Controllers.isCreated() && BrowserControllers.ownsCallback() && BrowserControllers.mappingCalls() == 1 && BrowserControllers.queries() == 16, "Original controller registry initialization");
            for (int index = 0; index < 16; index++) check(Controllers.getController(index) == null, "Actual absent controller");
            check(BrowserClipboard.reads() == 1 && BrowserClipboard.errorCallbackCalls() == 2, "Original Clipboard.initMainThread read/finally");
            check(zombie.core.Clipboard.getClipboard().isEmpty(), "Actual empty owned clipboard");
            Controllers.poll(new GamepadState[16]);
            Display.processMessages();
            zombie.core.opengl.RenderThread.init();
            check(BrowserControllers.mappingCalls() == 1, "Original duplicate init guard preserves services");
            var callbackField = BrowserControllers.class.getDeclaredField("callback");
            callbackField.setAccessible(true);
            var callback = (GLFWJoystickCallbackI) callbackField.get(null);
            unsupported(callback::getDescriptor, "Unavailable native descriptor throws Java exception");
            unsupported(callback::address, "Unavailable callback address throws Java exception");
            unsupported(() -> callback.callback(0, 0), "Unavailable native-buffer callback throws before reading pointers");
            unsupported(() -> GLFW.glfwSetJoystickCallback(null), "Unrepresentable prior callback rejected before mutation");
            check(BrowserControllers.ownsCallback(), "Rejected replacement retains original strong owner");
            boolean[] foreignRejected = { false };
            Thread foreign = new Thread(() -> {
                try { Display.processMessages(); } catch (IllegalStateException expected) { foreignRejected[0] = true; }
            }, "controller-foreign-owner");
            foreign.start();
            foreign.join(2000);
            check(!foreign.isAlive() && foreignRejected[0], "Foreign Java thread cannot pump owner events");
            triggerUntrustedEvent();
            unsupported(Display::processMessages, "Authored untrusted event rejects before another frame");
        } finally {
            try {
                if (input != null) { input.quit(); inputQuit = true; }
            } finally {
                try {
                    if (BrowserControllers.ownsCallback()) { BrowserControllers.dispose(); controllerDisposed = true; }
                } finally {
                    try {
                        if (Display.isCreated()) Display.destroy();
                        displayClosed = !Display.isCreated();
                    } finally {
                        try { BrowserClipboard.library().free(); }
                        finally { fs.setCacheDir(previous); }
                    }
                }
            }
        }
        check(inputQuit && controllerDisposed && displayClosed, "Original Input.quit and owned service cleanup");
        for (GamepadState state : states) {
            boolean rejected = false;
            try { state.axesButtons.buttons(0); } catch (IllegalStateException expected) { rejected = true; }
            check(rejected, "Original Input.quit released the Java-owned gamepad value");
        }
        report("{\"pass\":true,\"checks\":" + checks + ",\"actualRenderThreadInit\":true,\"originalInputQuit\":" + inputQuit
            + ",\"releasedGamepadValues\":" + states.size() + ",\"controllerDisposed\":" + controllerDisposed
            + ",\"displayClosed\":" + displayClosed + ",\"fullShutdownQualified\":false}");
    }
}
